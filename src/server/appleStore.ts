import crypto from 'node:crypto';
import type { AuthLoginResponse, DownloadDescriptorResult } from '../shared/types.ts';
import { fetchAnisetteWithFailover, mapAnisetteAuthHeaders } from './anisette.ts';
import { buildPlist, parsePlist, type PlistValue } from './plist.ts';
import {
  assertAppleCdnUrl,
  encryptSessionToken,
  isValidAppId,
  isValidVersionId,
  signManifestToken,
  type StoredAppleSession,
} from './security.ts';

const CONFIGURATOR_UA =
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

async function postApplePlist(
  initialUrl: string,
  bodyObj: Record<string, PlistValue>,
  headers: Record<string, string>,
  maxRedirects = 4
): Promise<{
  status: number;
  root: Record<string, PlistValue>;
  headers: Headers;
  finalUrl: string;
}> {
  let currentUrl = initialUrl;
  const xmlBody = buildPlist(bodyObj);

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    assertAppleCdnUrl(currentUrl);
    const res = await fetch(currentUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-apple-plist',
        'User-Agent': CONFIGURATOR_UA,
        Accept: '*/*',
        ...headers,
      },
      body: xmlBody,
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
    });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) break;
      const nextUrl = new URL(location, currentUrl).toString();
      assertAppleCdnUrl(nextUrl);
      currentUrl = nextUrl;
      continue;
    }

    const text = await res.text();
    const parsed = text.trim().startsWith('<') ? asDict(parsePlist(text)) : {};
    return {
      status: res.status,
      root: parsed,
      headers: res.headers,
      finalUrl: currentUrl,
    };
  }

  throw new Error('Слишком много перенаправлений от сервера Apple');
}

export interface AuthenticateOptions {
  email: string;
  password: string;
  code?: string;
  useAnisette?: boolean;
  anisetteUrl?: string;
  existingGuid?: string;
  persistMode?: '24h' | 'keep' | 'memory';
}

export async function authenticateAppleId(
  opts: AuthenticateOptions
): Promise<AuthLoginResponse & { guid?: string; rawSession?: StoredAppleSession }> {
  const email = opts.email.trim();
  const password = opts.password;
  const code = (opts.code ?? '').replace(/\D/g, '').slice(0, 6);
  const persistMode = opts.persistMode ?? '24h';

  if (!email || !email.includes('@') || !password) {
    return {
      status: 'error',
      message: 'Введите корректный Apple ID (e-mail) и пароль.',
    };
  }

  const guid = opts.existingGuid && /^[0-9A-F]{12}$/i.test(opts.existingGuid)
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

  const attemptEndpoints = [
    `https://auth.itunes.apple.com/auth/v1/native/fast?guid=${guid}`,
    `https://p25-buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate?guid=${guid}`,
    `https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate?guid=${guid}`,
  ];

  const attemptNumber = code ? '2' : '4';
  const combinedPassword = code ? `${password}${code}` : password;

  const payload: Record<string, PlistValue> = {
    appleId: email,
    attempt: attemptNumber,
    createSession: 'true',
    guid,
    password: combinedPassword,
    rmp: '0',
    why: 'signIn',
  };

  let lastMessage = 'Не удалось выполнить вход в Apple ID.';

  for (const endpoint of attemptEndpoints) {
    for (const includeAnisette of Object.keys(anisetteHeaders).length > 0 ? [true, false] : [false]) {
      try {
        const res = await postApplePlist(
          endpoint,
          payload,
          includeAnisette ? anisetteHeaders : {}
        );

        const root = res.root;
        const failureType = asString(root.failureType);
        const customerMessage = asString(root.customerMessage);
        const passwordToken = asString(root.passwordToken);
        const dsid = asString(root.dsPersonId);
        const pod = res.headers.get('pod') || asString(root.pod) || '25';
        const storeFront = res.headers.get('x-set-apple-store-front') || '143469-16,32';

        // Success!
        if (passwordToken && dsid) {
          const accountInfo = asDict(root.accountInfo);
          const address = asDict(accountInfo.address);
          const firstName = asString(address.firstName);
          const lastName = asString(address.lastName);
          const accountName = [firstName, lastName].filter(Boolean).join(' ') || email;
          const ttlMs =
            persistMode === 'keep'
              ? 30 * 24 * 60 * 60 * 1000
              : 24 * 60 * 60 * 1000;

          const storedSession: StoredAppleSession = {
            email,
            accountName,
            dsid,
            passwordToken,
            pod: pod.replace(/[^\d]/g, '') || '25',
            storeFront,
            guid,
            expiresAt: Date.now() + ttlMs,
            persistMode,
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
            anisetteUsed: includeAnisette ? anisetteUsed : undefined,
          };
        }

        // Check if Apple requests 2FA verification code
        const lowerMsg = customerMessage.toLowerCase();
        const is2FA =
          customerMessage === 'MZFinance.BadLogin.Configurator_message' ||
          failureType === '2034' ||
          failureType === '5000' ||
          lowerMsg.includes('verification code') ||
          lowerMsg.includes('код проверки') ||
          lowerMsg.includes('two-factor') ||
          (failureType === '' && !passwordToken && !code && res.status === 200);

        if (is2FA && !code) {
          return {
            status: 'requires2fa',
            guid,
            anisetteUsed: includeAnisette ? anisetteUsed : undefined,
            message:
              'Apple запросил 6-значный код двухфакторной аутентификации (2FA) с вашего доверенного устройства.',
          };
        }

        if (customerMessage) {
          lastMessage = customerMessage;
          // If password is wrong, stop immediately
          if (
            lowerMsg.includes('password') ||
            lowerMsg.includes('apple id') ||
            lowerMsg.includes('incorrect') ||
            failureType === '-5000'
          ) {
            return { status: 'error', message: customerMessage };
          }
        }
      } catch (err) {
        lastMessage = err instanceof Error ? err.message : String(err);
      }
    }
  }

  return {
    status: 'error',
    message: lastMessage,
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
  externalVersionID = ''
): Promise<DownloadDescriptorResult> {
  if (!isValidAppId(appID)) {
    throw new AppleStoreError('invalidResponse', 'Некорректный App ID');
  }
  if (externalVersionID && !isValidVersionId(externalVersionID)) {
    throw new AppleStoreError('invalidResponse', 'Некорректный External Version ID');
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

      // 2042 recovery with hasBeenAuthedForBuy
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

      // Strict Apple CDN host validation
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

      // Inject user Apple ID into metadata plist (same as IPA Vault / ipatool)
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
  appID: string
): Promise<{ ok: boolean; message: string }> {
  if (!isValidAppId(appID)) {
    throw new AppleStoreError('invalidResponse', 'Некорректный App ID');
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

  // Status 0 or "already purchased" / jingleDocType purchaseSuccess
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
