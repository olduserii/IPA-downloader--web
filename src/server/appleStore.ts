import crypto from 'node:crypto';
import type { AuthLoginResponse, DownloadDescriptorResult } from '../shared/types.ts';
import { fetchAnisetteWithFailover, mapAnisetteAuthHeaders } from './anisette.ts';
import { buildPlist, parsePlist, type PlistValue } from './plist.ts';
import {
  bridgeInspectDownload,
  bridgeLoginAppleId,
  bridgePurchaseFreeLicense,
  resolveBridgeConfig,
} from './companion.ts';
import {
  assertAppleCdnUrl,
  encryptSessionToken,
  isValidAppId,
  isValidVersionId,
  SESSION_TTL_SEC,
  signManifestToken,
  type StoredAppleSession,
} from './security.ts';

const CONFIGURATOR_UA =
  'Configurator/2.21 (Macintosh; OS X 27.0.1; 26A434) AppleWebKit/0625.2.5.11.6';

const LEGACY_CONFIGURATOR_UA =
  'Configurator/2.15 (Macintosh; OS X 11.0.0; 16G29) AppleWebKit/2603.3.8';

function generateDeviceGuid(): string {
  return crypto.randomBytes(6).toString('hex').toUpperCase();
}

function asDict(val: PlistValue | undefined): Record<string, PlistValue> {
  if (val && typeof val === 'object' && !Array.isArray(val) && !(val instanceof Date) && !Buffer.isBuffer(val)) {
    return val as Record<string, PlistValue>;
  }
  return {};
}

function asString(val: PlistValue | undefined): string {
  if (typeof val === 'string') return val;
  if (typeof val === 'number') return String(val);
  return '';
}

function extractIconFromMetadata(metadata: Record<string, PlistValue>): string | undefined {
  for (const key of ['softwareIcon57x57URL', 'softwareIconUrl', 'artworkURL', 'icon-url']) {
    const val = asString(metadata[key]);
    if (val.startsWith('https://')) {
      try {
        assertAppleCdnUrl(val);
        return val;
      } catch {
        // ignore untrusted icon URL
      }
    }
  }
  return undefined;
}

function extractMinOSFromMetadata(metadata: Record<string, PlistValue>): string | undefined {
  for (const key of ['minimumOsVersion', 'MinimumOSVersion', 'minOSVersion']) {
    const val = asString(metadata[key]).trim();
    if (val) return val;
  }
  return undefined;
}

function extractSetCookies(headers: Headers): string[] {
  const anyHeaders = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof anyHeaders.getSetCookie === 'function') {
    return anyHeaders.getSetCookie();
  }
  const combined = headers.get('set-cookie');
  return combined ? [combined] : [];
}

function mergeCookiesIntoJar(jar: Map<string, string>, headers: Headers): void {
  for (const rawCookie of extractSetCookies(headers)) {
    const firstSegment = rawCookie.split(';')[0]?.trim();
    if (!firstSegment) continue;
    const eq = firstSegment.indexOf('=');
    if (eq <= 0) continue;
    const name = firstSegment.slice(0, eq).trim();
    const val = firstSegment.slice(eq + 1).trim();
    if (name) {
      jar.set(name, val);
    }
  }
}

function serializeCookieJar(jar: Map<string, string>): string {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

function extractDsidFromCookies(jar: Map<string, string>): string {
  for (const key of jar.keys()) {
    const match = key.match(/^mz_at(?:0|_ssl)-(\d+)$/);
    if (match?.[1]) return match[1];
  }
  return '';
}

function normalizeAppleAuthRedirectUrl(rawUrl: string): string {
  const parsed = assertAppleCdnUrl(rawUrl);
  // Apple's legacy MZFinance authenticate route requires a trailing slash
  // to avoid 301/302 bounce loops on pod hosts.
  if (
    parsed.hostname.endsWith('buy.itunes.apple.com') &&
    parsed.pathname === '/WebObjects/MZFinance.woa/wa/authenticate'
  ) {
    parsed.pathname = '/WebObjects/MZFinance.woa/wa/authenticate/';
  }
  return parsed.toString();
}

interface ApplePlistResponse {
  status: number;
  root: Record<string, PlistValue>;
  hasPlistBody: boolean;
  headers: Headers;
  finalUrl: string;
  pod: string;
  storeFront: string;
  cookieDsid: string;
  redirectLoopDetected?: boolean;
}

async function postApplePlist(
  initialUrl: string,
  bodyObj: Record<string, PlistValue>,
  headers: Record<string, string>,
  options?: {
    maxRedirects?: number;
    userAgent?: string;
    cookieJar?: Map<string, string>;
  }
): Promise<ApplePlistResponse> {
  const maxRedirects = options?.maxRedirects ?? 8;
  const userAgent = options?.userAgent ?? CONFIGURATOR_UA;
  const cookieJar = options?.cookieJar ?? new Map<string, string>();

  let currentUrl = normalizeAppleAuthRedirectUrl(initialUrl);
  const xmlBody = buildPlist(bodyObj);
  const visitedSignatures = new Set<string>();

  let lastPod = '';
  let lastStoreFront = '';

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    assertAppleCdnUrl(currentUrl);

    const cookieHeader = serializeCookieJar(cookieJar);
    const hopSignature = `${currentUrl}|${cookieHeader}`;
    if (visitedSignatures.has(hopSignature)) {
      return {
        status: 302,
        root: {},
        hasPlistBody: false,
        headers: new Headers(),
        finalUrl: currentUrl,
        pod: lastPod,
        storeFront: lastStoreFront,
        cookieDsid: extractDsidFromCookies(cookieJar),
        redirectLoopDetected: true,
      };
    }
    visitedSignatures.add(hopSignature);

    const reqHeaders: Record<string, string> = {
      'Content-Type': 'application/x-apple-plist',
      'User-Agent': userAgent,
      Accept: '*/*',
      ...headers,
    };
    if (cookieHeader) {
      reqHeaders.Cookie = cookieHeader;
    }

    const res = await fetch(currentUrl, {
      method: 'POST',
      headers: reqHeaders,
      body: xmlBody,
      redirect: 'manual',
      signal: AbortSignal.timeout(12000),
    });

    mergeCookiesIntoJar(cookieJar, res.headers);

    const podHdr = res.headers.get('pod');
    if (podHdr) lastPod = podHdr;
    const sfHdr = res.headers.get('x-set-apple-store-front');
    if (sfHdr) lastStoreFront = sfHdr;

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) {
        return {
          status: res.status,
          root: {},
          hasPlistBody: false,
          headers: res.headers,
          finalUrl: currentUrl,
          pod: lastPod,
          storeFront: lastStoreFront,
          cookieDsid: extractDsidFromCookies(cookieJar),
        };
      }
      const resolvedNext = new URL(location.trim(), currentUrl).toString();
      currentUrl = normalizeAppleAuthRedirectUrl(resolvedNext);
      continue;
    }

    const text = await res.text();
    const trimmed = text.trim();
    const hasPlistBody = trimmed.startsWith('<?xml') || trimmed.startsWith('<!DOCTYPE plist') || trimmed.startsWith('<plist');
    const parsed = hasPlistBody ? asDict(parsePlist(trimmed)) : {};

    return {
      status: res.status,
      root: parsed,
      hasPlistBody,
      headers: res.headers,
      finalUrl: currentUrl,
      pod: lastPod || asString(parsed.pod),
      storeFront: lastStoreFront,
      cookieDsid: extractDsidFromCookies(cookieJar),
    };
  }

  return {
    status: 302,
    root: {},
    hasPlistBody: false,
    headers: new Headers(),
    finalUrl: currentUrl,
    pod: lastPod,
    storeFront: lastStoreFront,
    cookieDsid: extractDsidFromCookies(cookieJar),
    redirectLoopDetected: true,
  };
}

export interface AuthenticateOptions {
  email: string;
  password: string;
  code?: string;
  useAnisette?: boolean;
  anisetteUrl?: string;
  existingGuid?: string;
  preferredAuthEndpoint?: string;
  persistMode?: '24h' | 'keep' | 'memory';
  bridgeUrl?: string;
  bridgeSecret?: string;
}

export async function authenticateAppleId(
  opts: AuthenticateOptions
): Promise<
  AuthLoginResponse & {
    guid?: string;
    authEndpoint?: string;
    rawSession?: StoredAppleSession;
    requiresSapBridge?: boolean;
  }
> {
  const email = opts.email.trim();
  const password = opts.password;
  const code = (opts.code ?? '').replace(/\D/g, '').slice(0, 6);
  const persistMode = 'keep' as const;

  if (!email || !email.includes('@') || !password) {
    return {
      status: 'error',
      message: 'Введите корректный Apple ID (e-mail) и пароль.',
    };
  }

  // If FairPlay SAP Bridge is configured (via SAP_BRIDGE_URL env or UI settings),
  // use it for full CoreFP / Unicorn ARM64 X-Apple-ActionSignature authentication.
  try {
    const bridge = resolveBridgeConfig({
      bridgeUrl: opts.bridgeUrl,
      bridgeSecret: opts.bridgeSecret,
    });
    if (bridge) {
      return await bridgeLoginAppleId(bridge, {
        email,
        password,
        code,
        persistMode,
      });
    }
  } catch (err) {
    return {
      status: 'error',
      message:
        err instanceof Error
          ? `Ошибка FairPlay SAP Bridge: ${err.message}`
          : 'Не удалось подключиться к FairPlay SAP Bridge.',
    };
  }

  const guid =
    opts.existingGuid && /^[0-9A-F]{12}$/i.test(opts.existingGuid)
      ? opts.existingGuid.toUpperCase()
      : generateDeviceGuid();

  let anisetteHeaders: Record<string, string> = {};
  let anisetteUsed: { serverName: string; latencyMs: number } | undefined;

  if (opts.useAnisette !== false) {
    try {
      const ani = await fetchAnisetteWithFailover(opts.anisetteUrl);
      anisetteHeaders = mapAnisetteAuthHeaders(ani.headers);
      anisetteUsed = { serverName: ani.serverName, latencyMs: ani.latencyMs };
    } catch {
      // Fallback cleanly without Anisette if community servers are temporarily unreachable
    }
  }

  const endpoints: string[] = [];

  // If Step 1 already resolved the user's Apple Store pod, validate strictly and hit it directly first
  if (opts.preferredAuthEndpoint) {
    try {
      const parsed = new URL(normalizeAppleAuthRedirectUrl(opts.preferredAuthEndpoint));
      const host = parsed.hostname.toLowerCase();
      const isAuthHost =
        host === 'auth.itunes.apple.com' ||
        host === 'buy.itunes.apple.com' ||
        /^p\d+-buy\.itunes\.apple\.com$/.test(host);
      const isAuthPath =
        parsed.pathname === '/WebObjects/MZFinance.woa/wa/authenticate/' ||
        parsed.pathname === '/auth/v1/native' ||
        parsed.pathname === '/auth/v1/native/';
      if (isAuthHost && isAuthPath) {
        endpoints.push(parsed.toString());
      }
    } catch {
      // ignore invalid endpoint hint
    }
  }

  const defaultEndpoints = [
    `https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate/?guid=${guid}`,
    `https://p25-buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate/?guid=${guid}`,
    `https://auth.itunes.apple.com/auth/v1/native?guid=${guid}`,
  ];
  for (const ep of defaultEndpoints) {
    if (!endpoints.includes(ep)) endpoints.push(ep);
  }

  const combinedPassword = code ? `${password}${code}` : password;
  const headerVariants: { headers: Record<string, string>; usedAnisette: boolean; ua: string }[] =
    Object.keys(anisetteHeaders).length > 0
      ? [
          { headers: anisetteHeaders, usedAnisette: true, ua: CONFIGURATOR_UA },
          { headers: {}, usedAnisette: false, ua: CONFIGURATOR_UA },
          { headers: anisetteHeaders, usedAnisette: true, ua: LEGACY_CONFIGURATOR_UA },
        ]
      : [
          { headers: {}, usedAnisette: false, ua: CONFIGURATOR_UA },
          { headers: {}, usedAnisette: false, ua: LEGACY_CONFIGURATOR_UA },
        ];

  let sawRedirectLoop = false;
  let sawEmptyOrForbidden = false;
  let lastMessage = '';

  for (const endpoint of endpoints) {
    for (const variant of headerVariants) {
      const cookieJar = new Map<string, string>();
      const attemptSequence = code ? ['1', '2', '4'] : ['1', '2'];

      let targetUrl = endpoint;

      for (const attemptNum of attemptSequence) {
        const payload: Record<string, PlistValue> = {
          appleId: email,
          attempt: attemptNum,
          createSession: 'true',
          guid,
          password: combinedPassword,
          rmp: '0',
          why: 'signIn',
        };

        try {
          const res = await postApplePlist(targetUrl, payload, variant.headers, {
            maxRedirects: 8,
            userAgent: variant.ua,
            cookieJar,
          });

          if (res.redirectLoopDetected) {
            sawRedirectLoop = true;
            break;
          }

          // Keep the pod URL discovered by redirect for retry attempt
          targetUrl = res.finalUrl;

          if (!res.hasPlistBody) {
            if (res.status === 403 || res.status === 204 || res.status === 200) {
              sawEmptyOrForbidden = true;
            }
            break;
          }

          const root = res.root;
          const failureType = asString(root.failureType);
          const customerMessage = asString(root.customerMessage);
          const dialog = asDict(root.dialog);
          const dialogMessage = asString(dialog.message);
          const dialogExplanation = asString(dialog.explanation);
          const passwordToken = asString(root.passwordToken);
          const dsid =
            asString(root.dsPersonId) ||
            res.headers.get('x-dsid') ||
            res.cookieDsid;

          const podFromHost = (() => {
            try {
              const host = new URL(res.finalUrl).hostname;
              const m = host.match(/^p(\d+)-buy\.itunes\.apple\.com$/i);
              return m?.[1] || '';
            } catch {
              return '';
            }
          })();

          const pod = (res.pod || podFromHost || '').replace(/[^\d]/g, '');
          const storeFront = res.storeFront || '143469-16,32';

          // Success!
          if (passwordToken && dsid) {
            const accountInfo = asDict(root.accountInfo);
            const address = asDict(accountInfo.address);
            const firstName = asString(address.firstName);
            const lastName = asString(address.lastName);
            const resolvedEmail = asString(accountInfo.appleId) || email;
            const accountName = [firstName, lastName].filter(Boolean).join(' ') || resolvedEmail;
            const ttlMs = SESSION_TTL_SEC * 1000;

            const storedSession: StoredAppleSession = {
              email: resolvedEmail,
              accountName,
              dsid,
              passwordToken,
              pod,
              storeFront,
              guid,
              expiresAt: Date.now() + ttlMs,
              persistMode: 'keep',
            };

            const token = encryptSessionToken(storedSession);
            return {
              status: 'authenticated',
              token,
              rawSession: storedSession,
              session: {
                email: storedSession.email,
                accountName: storedSession.accountName,
                dsid: storedSession.dsid,
                pod: storedSession.pod,
                storeFront: storedSession.storeFront,
                expiresAt: storedSession.expiresAt,
                persistMode: storedSession.persistMode,
              },
              anisetteUsed: variant.usedAnisette ? anisetteUsed : undefined,
            };
          }

          // Apple explicitly asks for retry with attempt=2 when attempt=1 gets -5000
          if (attemptNum === '1' && failureType === '-5000') {
            continue;
          }

          // Genuine 2FA challenge (ONLY when Apple returned a real plist response!)
          const lowerMsg = `${customerMessage} ${dialogMessage} ${dialogExplanation}`.toLowerCase();
          const is2FA =
            customerMessage === 'MZFinance.BadLogin.Configurator_message' ||
            failureType === '2034' ||
            lowerMsg.includes('verification code') ||
            lowerMsg.includes('код проверки') ||
            lowerMsg.includes('two-factor');

          if (is2FA) {
            if (!code) {
              return {
                status: 'requires2fa',
                guid,
                authEndpoint: res.finalUrl,
                anisetteUsed: variant.usedAnisette ? anisetteUsed : undefined,
                message:
                  'Apple запросил 6-значный код двухфакторной аутентификации (2FA) с вашего доверенного устройства.',
              };
            }
            return {
              status: 'error',
              message:
                'Apple не принял код 2FA (возможно, он истёк или введён неверно). Запросите свежий 6-значный код и попробуйте снова.',
            };
          }

          const readableMsg =
            [dialogMessage, dialogExplanation].filter(Boolean).join(': ') || customerMessage;
          if (readableMsg) {
            lastMessage = readableMsg;
            if (
              lowerMsg.includes('disabled') ||
              lowerMsg.includes('locked') ||
              lowerMsg.includes('password') ||
              lowerMsg.includes('incorrect') ||
              failureType === '-5000'
            ) {
              return { status: 'error', message: readableMsg };
            }
          }
          break;
        } catch (err) {
          lastMessage = err instanceof Error ? err.message : String(err);
          break;
        }
      }
    }
  }

  if (lastMessage) {
    return { status: 'error', message: lastMessage };
  }

  if (sawEmptyOrForbidden) {
    return {
      status: 'error',
      requiresSapBridge: true,
      message:
        'Apple заблокировал прямой вход без криптографической подписи FairPlay SAP (CoreFP / X-Apple-ActionSignature). Серверы SideStore Anisette её не выдают и Vercel Serverless не может запускать нативный эмулятор CoreFP. Подключите FairPlay SAP Bridge (блок справа) или войдите через вкладку «Вход по сессии».',
    };
  }

  if (sawRedirectLoop) {
    return {
      status: 'error',
      message:
        'Сервер Apple зациклил перенаправление между pod-узлами. Попробуйте сбросить 2FA, сменить сервер SideStore Anisette или войти через вкладку «Вход по сессии».',
    };
  }

  return {
    status: 'error',
    message: 'Не удалось выполнить вход в Apple ID. Попробуйте повторить позже.',
  };
}

export class AppleStoreError extends Error {
  readonly code: 'sessionExpired' | 'licenseRequired' | 'unavailable' | 'invalidResponse';
  constructor(
    code: 'sessionExpired' | 'licenseRequired' | 'unavailable' | 'invalidResponse',
    message: string
  ) {
    super(message);
    this.code = code;
  }
}

function classifyAppleFailure(root: Record<string, PlistValue>): AppleStoreError | null {
  const failureType = asString(root.failureType);
  const customerMessage = asString(root.customerMessage);
  if (!failureType && !customerMessage) return null;

  if (failureType === '2034' || failureType === '2042') {
    return new AppleStoreError(
      'sessionExpired',
      'Сессия Apple ID истекла — выполните повторный вход на вкладке «Аккаунт».'
    );
  }
  if (
    failureType === '9610' ||
    customerMessage.toLowerCase().includes('license') ||
    customerMessage.toLowerCase().includes('not been purchased')
  ) {
    return new AppleStoreError(
      'licenseRequired',
      'Нет лицензии на этом Apple ID. Нажмите «Приобрести бесплатную лицензию» или используйте аккаунт, на котором приложение уже скачивалось ранее.'
    );
  }
  return new AppleStoreError(
    'unavailable',
    customerMessage || `Apple Store вернул код ошибки ${failureType}`
  );
}

async function headContentLength(url: string): Promise<number | undefined> {
  try {
    assertAppleCdnUrl(url);
    const res = await fetch(url, {
      method: 'HEAD',
      signal: AbortSignal.timeout(4000),
    });
    const len = Number(res.headers.get('content-length'));
    return Number.isFinite(len) && len > 0 ? len : undefined;
  } catch {
    return undefined;
  }
}

export async function fetchDownloadDescriptor(
  session: StoredAppleSession,
  appID: string,
  externalVersionID = '',
  bridgeOverride?: { bridgeUrl?: string; bridgeSecret?: string }
): Promise<DownloadDescriptorResult> {
  if (!isValidAppId(appID)) {
    throw new AppleStoreError('invalidResponse', 'Некорректный App ID');
  }
  if (externalVersionID && !isValidVersionId(externalVersionID)) {
    throw new AppleStoreError('invalidResponse', 'Некорректный External Version ID');
  }

  const bridge = resolveBridgeConfig(bridgeOverride);
  if (bridge) {
    try {
      return await bridgeInspectDownload(bridge, session, appID, externalVersionID);
    } catch (err) {
      const code = (err as Error & { bridgeCode?: string })?.bridgeCode;
      if (code === 'sessionExpired') {
        const detail = err instanceof Error && err.message ? ` (${err.message})` : '';
        throw new AppleStoreError(
          'sessionExpired',
          `Сессия Apple ID истекла — выполните повторный вход на вкладке «Аккаунт».${detail}`
        );
      }
      if (code === 'licenseRequired') {
        throw new AppleStoreError(
          'licenseRequired',
          'Нет лицензии на этом Apple ID. Нажмите «Приобрести бесплатную лицензию» или используйте аккаунт, на котором приложение уже скачивалось ранее.'
        );
      }
      throw new AppleStoreError(
        'unavailable',
        err instanceof Error ? err.message : 'Ошибка FairPlay SAP Bridge при получении IPA.'
      );
    }
  }

  const podPrefix = session.pod ? `p${session.pod}-` : '';
  const baseHeaders: Record<string, string> = {
    'X-Dsid': session.dsid,
    'iCloud-DSID': session.dsid,
    'X-Token': session.passwordToken,
    'X-Apple-Store-Front': session.storeFront || '143469-16,32',
  };

  interface Tier {
    label: string;
    url: string;
    versionKey: 'externalVersionId' | 'appExtVrsId';
  }

  const tiers: Tier[] = [
    {
      label: `${podPrefix}volumeStoreDownloadProduct`,
      url: `https://${podPrefix}buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/volumeStoreDownloadProduct?guid=${session.guid}`,
      versionKey: 'externalVersionId',
    },
    {
      label: 'volumeStoreDownloadProduct',
      url: `https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/volumeStoreDownloadProduct?guid=${session.guid}`,
      versionKey: 'externalVersionId',
    },
    {
      label: `${podPrefix}redownloadProduct`,
      url: `https://${podPrefix}buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/redownloadProduct?guid=${session.guid}`,
      versionKey: 'appExtVrsId',
    },
    {
      label: `${podPrefix}updateProduct`,
      url: `https://${podPrefix}buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/updateProduct?guid=${session.guid}`,
      versionKey: 'appExtVrsId',
    },
  ];

  let preferredError: AppleStoreError | null = null;

  for (const tier of tiers) {
    const body: Record<string, PlistValue> = {
      creditDisplay: '',
      guid: session.guid,
      salableAdamId: Number(appID),
      serialNumber: '0',
    };
    if (externalVersionID) {
      body[tier.versionKey] = externalVersionID;
    }

    try {
      let res = await postApplePlist(tier.url, body, baseHeaders);

      if (asString(res.root.failureType) === '2042') {
        res = await postApplePlist(
          tier.url,
          { ...body, hasBeenAuthedForBuy: 'true' },
          baseHeaders
        );
      }

      const items = Array.isArray(res.root.songList) ? res.root.songList : [];
      if (items.length === 0) {
        const failure = classifyAppleFailure(res.root);
        if (failure) {
          if (failure.code === 'licenseRequired') {
            preferredError = failure;
          } else if (!preferredError) {
            preferredError = failure;
          }
        }
        continue;
      }

      const item = asDict(items[0]);
      const rawUrl = asString(item.URL);
      if (!rawUrl) continue;

      const safeCdnUrl = assertAppleCdnUrl(rawUrl).toString();
      const metadata = asDict(item.metadata);

      const bundleID = asString(metadata.softwareVersionBundleId) || `app.${appID}`;
      const appName =
        asString(metadata.itemName) ||
        asString(metadata.bundleDisplayName) ||
        asString(metadata.playlistName) ||
        bundleID;
      const version =
        asString(metadata.bundleShortVersionString) ||
        asString(metadata.bundleVersion) ||
        '1.0';

      const rawVersions = Array.isArray(metadata.softwareVersionExternalIdentifiers)
        ? metadata.softwareVersionExternalIdentifiers.map((v) => asString(v)).filter((v) => /^\d+$/.test(v))
        : [];
      const actualVersionID =
        asString(metadata.softwareVersionExternalIdentifier) ||
        externalVersionID ||
        rawVersions[rawVersions.length - 1] ||
        '';

      const availableVersionIDs = [...new Set([...rawVersions, ...(actualVersionID ? [actualVersionID] : [])])].sort(
        (a, b) => Number(b) - Number(a)
      );

      const enrichedMetadata: Record<string, PlistValue> = {
        ...metadata,
        'apple-id': session.email,
        userName: session.email,
      };
      const metadataPlistXml = buildPlist(enrichedMetadata);

      const sinfList = Array.isArray(item.sinfs) ? item.sinfs : [];
      const iconURL = extractIconFromMetadata(metadata);
      const minOSVersion = extractMinOSFromMetadata(metadata);
      const md5 = asString(item.md5) || undefined;
      const fileSizeBytes = await headContentLength(safeCdnUrl);

      const manifestToken = signManifestToken({
        ipaUrl: safeCdnUrl,
        bundleId: bundleID,
        bundleVersion: version,
        title: appName,
        iconUrl: iconURL,
      });

      return {
        appID,
        appName,
        bundleID,
        version,
        externalVersionID: actualVersionID,
        availableVersionIDs,
        directCdnUrl: safeCdnUrl,
        manifestToken,
        manifestPath: `/api/manifest.plist?token=${encodeURIComponent(manifestToken)}`,
        md5,
        fileSizeBytes,
        iconURL,
        minOSVersion,
        sinfCount: sinfList.length,
        metadataPlistXml,
        endpointUsed: tier.label,
        isDeletedDirect: tier.label.includes('redownload') || tier.label.includes('update'),
      };
    } catch (err) {
      if (!preferredError) {
        preferredError =
          err instanceof AppleStoreError
            ? err
            : new AppleStoreError('unavailable', err instanceof Error ? err.message : String(err));
      }
    }
  }

  throw (
    preferredError ??
    new AppleStoreError(
      'unavailable',
      'Apple не вернул ссылку на скачивание для этого приложения. Убедитесь, что оно привязано к вашему Apple ID.'
    )
  );
}

export async function purchaseFreeLicense(
  session: StoredAppleSession,
  appID: string,
  bridgeOverride?: { bridgeUrl?: string; bridgeSecret?: string }
): Promise<{ ok: boolean; message: string }> {
  if (!isValidAppId(appID)) {
    throw new AppleStoreError('invalidResponse', 'Некорректный App ID');
  }

  const bridge = resolveBridgeConfig(bridgeOverride);
  if (bridge) {
    try {
      return await bridgePurchaseFreeLicense(bridge, session, appID);
    } catch (err) {
      const code = (err as Error & { bridgeCode?: string })?.bridgeCode;
      if (code === 'sessionExpired') {
        throw new AppleStoreError(
          'sessionExpired',
          'Сессия Apple ID истекла — выполните повторный вход.'
        );
      }
      throw new AppleStoreError(
        'unavailable',
        err instanceof Error ? err.message : 'Ошибка добавления лицензии через FairPlay SAP Bridge.'
      );
    }
  }

  const podPrefix = session.pod ? `p${session.pod}-` : '';
  const url = `https://${podPrefix}buy.itunes.apple.com/WebObjects/MZBuy.woa/wa/buyProduct`;

  const body: Record<string, PlistValue> = {
    appExtVrsId: '0',
    hasAskedToFulfillPreorder: 'true',
    buyWithoutAuthorization: 'true',
    hasDoneAgeCheck: 'true',
    guid: session.guid,
    needDiv: '0',
    origPage: `Software-${appID}`,
    origPageLocation: 'Buy',
    price: '0',
    pricingParameters: 'STDQ',
    productType: 'C',
    salableAdamId: appID,
  };

  const res = await postApplePlist(url, body, {
    'X-Dsid': session.dsid,
    'iCloud-DSID': session.dsid,
    'X-Token': session.passwordToken,
    'X-Apple-Store-Front': session.storeFront || '143469-16,32',
  });

  const failureType = asString(res.root.failureType);
  const customerMessage = asString(res.root.customerMessage);

  if (failureType === '2034' || failureType === '2042') {
    throw new AppleStoreError(
      'sessionExpired',
      'Сессия Apple ID истекла — выполните повторный вход.'
    );
  }

  const statusVal = asString(res.root.status);
  const docType = asString(res.root.jingleDocType);
  if (
    statusVal === '0' ||
    docType === 'purchaseSuccess' ||
    failureType === '5002' ||
    customerMessage.toLowerCase().includes('already')
  ) {
    return {
      ok: true,
      message: 'Бесплатная лицензия добавлена на ваш Apple ID.',
    };
  }

  throw new AppleStoreError(
    'unavailable',
    customerMessage || `Не удалось добавить лицензию (код Apple: ${failureType || res.status}).`
  );
}
