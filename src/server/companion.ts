import crypto from 'node:crypto';
import type { AuthLoginResponse, DownloadDescriptorResult } from '../shared/types.ts';
import { buildPlist, type PlistValue } from './plist.ts';
import {
  assertAppleCdnUrl,
  assertSafeExternalHttpsUrl,
  encryptSessionToken,
  isValidAppId,
  isValidVersionId,
  SESSION_TTL_SEC,
  signManifestToken,
  type StoredAppleSession,
} from './security.ts';

export interface BridgeConfig {
  baseUrl: string;
  secret?: string;
  source: 'env' | 'custom';
}

const MANAGED_PAAS_HTTPS_SUFFIXES = [
  '.up.railway.app',
  '.onrender.com',
  '.fly.dev',
  '.vercel.app',
  '.koyeb.app',
];

/**
 * Normalizes user-entered or env-configured bridge URLs:
 * - Auto-prepends https:// when user pastes bare hostname (e.g. "app.up.railway.app:8080")
 * - Upgrades http:// to https:// on managed HTTPS PaaS domains
 * - Strips accidental internal container ports (:8080, :3000) on managed HTTPS PaaS domains
 * - Strictly enforces HTTPS + SSRF protection via assertSafeExternalHttpsUrl
 */
export function normalizeBridgeUrl(raw: string): string {
  let candidate = raw.trim();
  if (!candidate) {
    throw new Error('Укажите адрес FairPlay SAP Bridge');
  }

  // Upgrade http:// only if user pasted it by mistake; bare hostnames get https://
  if (/^http:\/\//i.test(candidate)) {
    candidate = `https://${candidate.slice(7)}`;
  } else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
    candidate = `https://${candidate}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error('Некорректный URL FairPlay SAP Bridge');
  }

  const hostLower = parsed.hostname.toLowerCase();
  const isManagedPaas = MANAGED_PAAS_HTTPS_SUFFIXES.some((s) => hostLower.endsWith(s));
  if (isManagedPaas && parsed.port && parsed.port !== '443') {
    // Railway / Render / Fly terminate TLS on 443 and route internally to container PORT (e.g. 8080)
    parsed.port = '';
  }

  const safe = assertSafeExternalHttpsUrl(parsed.toString());
  return safe.toString().replace(/\/+$/, '');
}

export function getEnvBridgeStatus(): {
  config: BridgeConfig | null;
  host?: string;
  envError?: string;
} {
  const rawUrl = process.env.SAP_BRIDGE_URL?.trim();
  if (!rawUrl) return { config: null };
  try {
    const baseUrl = normalizeBridgeUrl(rawUrl);
    return {
      config: {
        baseUrl,
        secret: process.env.SAP_BRIDGE_SECRET?.trim() || undefined,
        source: 'env',
      },
      host: new URL(baseUrl).host,
    };
  } catch (err) {
    return {
      config: null,
      envError: err instanceof Error ? err.message : 'Некорректный SAP_BRIDGE_URL',
    };
  }
}

export function getEnvBridgeConfig(): BridgeConfig | null {
  return getEnvBridgeStatus().config;
}

export function resolveBridgeConfig(override?: {
  bridgeUrl?: string;
  bridgeSecret?: string;
}): BridgeConfig | null {
  const customUrl = override?.bridgeUrl?.trim();
  if (customUrl) {
    const baseUrl = normalizeBridgeUrl(customUrl);
    return {
      baseUrl,
      secret: override?.bridgeSecret?.trim() || undefined,
      source: 'custom',
    };
  }
  return getEnvBridgeConfig();
}

function buildBridgeHeaders(secret?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (secret) {
    headers.Authorization = `Bearer ${secret}`;
  }
  return headers;
}

export async function testBridgeConnection(
  config: BridgeConfig
): Promise<{ ok: boolean; engine?: string; latencyMs?: number; secretProtected?: boolean; error?: string }> {
  const started = Date.now();
  try {
    const res = await fetch(`${config.baseUrl}/health`, {
      method: 'GET',
      headers: buildBridgeHeaders(config.secret),
      redirect: 'manual',
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      return { ok: false, error: `Сервер моста вернул HTTP ${res.status}` };
    }
    const contentType = res.headers.get('content-type') || '';
    const text = await res.text();
    if (!contentType.includes('application/json') && text.trim().startsWith('<')) {
      return {
        ok: false,
        error:
          'По этому адресу сейчас отвечает веб-сайт (HTML), а не FairPlay SAP Bridge. Проверьте в Railway, что Root Directory установлен на /companion и деплой завершился успешно.',
      };
    }

    let data: {
      ok?: boolean;
      engine?: string;
      secretProtected?: boolean;
    };
    try {
      data = JSON.parse(text) as {
        ok?: boolean;
        engine?: string;
        secretProtected?: boolean;
      };
    } catch {
      return {
        ok: false,
        error: 'Сервер по указанному адресу вернул не JSON. Убедитесь, что запущен контейнер из папки /companion.',
      };
    }
    if (!data.ok || data.engine !== 'ipatool-sap-bridge') {
      return {
        ok: false,
        error: 'По этому адресу запущен другой сервис, а не FairPlay SAP Bridge (/companion).',
      };
    }
    return {
      ok: true,
      engine: data.engine,
      secretProtected: Boolean(data.secretProtected),
      latencyMs: Math.max(1, Date.now() - started),
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Не удалось подключиться к FairPlay SAP Bridge',
    };
  }
}

export async function bridgeLoginAppleId(
  config: BridgeConfig,
  opts: {
    email: string;
    password: string;
    code?: string;
    persistMode: '24h' | 'keep' | 'memory';
  }
): Promise<
  AuthLoginResponse & {
    guid?: string;
    rawSession?: StoredAppleSession;
  }
> {
  const res = await fetch(`${config.baseUrl}/v1/auth/login`, {
    method: 'POST',
    headers: buildBridgeHeaders(config.secret),
    body: JSON.stringify({
      email: opts.email.trim(),
      password: opts.password,
      code: (opts.code ?? '').replace(/\D/g, '').slice(0, 6),
    }),
    redirect: 'manual',
    signal: AbortSignal.timeout(55000),
  });

  const data = (await res.json().catch(() => ({}))) as {
    status?: string;
    message?: string;
    guid?: string;
    account?: {
      email?: string;
      name?: string;
      directoryServicesIdentifier?: string;
      passwordToken?: string;
      pod?: string;
      storeFront?: string;
    };
  };

  if (data.status === 'requires2fa') {
    return {
      status: 'requires2fa',
      guid: data.guid,
      message:
        data.message ||
        'Apple запросил 6-значный код двухфакторной аутентификации (2FA) с вашего устройства.',
    };
  }

  if (data.status === 'authenticated' && data.account?.passwordToken && data.account?.directoryServicesIdentifier) {
    const ttlMs = SESSION_TTL_SEC * 1000;
    const resolvedEmail = data.account.email || opts.email.trim();
    const guid =
      data.guid && /^[0-9A-F]{12}$/i.test(data.guid)
        ? data.guid.toUpperCase()
        : crypto.randomBytes(6).toString('hex').toUpperCase();

    const storedSession: StoredAppleSession = {
      email: resolvedEmail,
      accountName: data.account.name || resolvedEmail,
      dsid: data.account.directoryServicesIdentifier,
      passwordToken: data.account.passwordToken,
      // Preserve Apple's exact pod (empty string when native auth omits pod -> buy.itunes.apple.com).
      // Never invent "25", which routes non-p25 accounts to the wrong pod and triggers Apple 2034!
      pod: (data.account.pod || '').replace(/[^\d]/g, ''),
      storeFront: data.account.storeFront || '143469-16,32',
      guid,
      expiresAt: Date.now() + ttlMs,
      persistMode: 'keep',
    };

    return {
      status: 'authenticated',
      token: encryptSessionToken(storedSession),
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
    };
  }

  return {
    status: 'error',
    message: data.message || `FairPlay SAP Bridge вернул ошибку (HTTP ${res.status}).`,
  };
}

function toBridgeAccount(session: StoredAppleSession) {
  return {
    email: session.email,
    name: session.accountName,
    directoryServicesIdentifier: session.dsid,
    passwordToken: session.passwordToken,
    pod: session.pod,
    storeFront: session.storeFront,
  };
}

function asString(val: unknown): string {
  if (typeof val === 'string') return val;
  if (typeof val === 'number') return String(val);
  return '';
}

export async function bridgeInspectDownload(
  config: BridgeConfig,
  session: StoredAppleSession,
  appID: string,
  externalVersionID = ''
): Promise<DownloadDescriptorResult> {
  if (!isValidAppId(appID)) {
    throw new Error('Некорректный App ID');
  }
  if (externalVersionID && !isValidVersionId(externalVersionID)) {
    throw new Error('Некорректный External Version ID');
  }

  async function callInspect(targetSession: StoredAppleSession) {
    const res = await fetch(`${config.baseUrl}/v1/store/inspect`, {
      method: 'POST',
      headers: buildBridgeHeaders(config.secret),
      body: JSON.stringify({
        account: toBridgeAccount(targetSession),
        appID,
        externalVersionID,
      }),
      redirect: 'manual',
      signal: AbortSignal.timeout(40000),
    });

    const data = (await res.json().catch(() => ({}))) as {
      url?: string;
      md5?: string;
      artworkUrl?: string;
      sinfCount?: number;
      metadata?: Record<string, unknown>;
      availableVersions?: string[];
      externalVersionId?: string;
      code?: string;
      error?: string;
    };
    return { res, data };
  }

  let { res, data } = await callInspect(session);

  // Automatic recovery for tokens saved with a forced/stale pod (e.g. legacy "25"):
  // retry once with pod="" so ipatool hits buy.itunes.apple.com directly.
  if ((!res.ok || !data.url) && session.pod && data.code === 'sessionExpired') {
    const retry = await callInspect({ ...session, pod: '' });
    if (retry.res.ok && retry.data.url) {
      res = retry.res;
      data = retry.data;
    } else if (retry.data.code && retry.data.code !== 'sessionExpired') {
      res = retry.res;
      data = retry.data;
    }
  }

  if (!res.ok || !data.url) {
    const err = new Error(data.error || `FairPlay SAP Bridge вернул HTTP ${res.status}`) as Error & {
      bridgeCode?: string;
    };
    err.bridgeCode = data.code;
    throw err;
  }

  // Strictly enforce Apple official CDN allowlist even for bridge responses
  const safeCdnUrl = assertAppleCdnUrl(data.url).toString();
  const metadata = data.metadata ?? {};

  let iconURL: string | undefined;
  for (const candidate of [
    data.artworkUrl,
    asString(metadata.softwareIcon57x57URL),
    asString(metadata.softwareIconUrl),
    asString(metadata.artworkURL),
  ]) {
    if (candidate && candidate.startsWith('https://')) {
      try {
        iconURL = assertAppleCdnUrl(candidate).toString();
        break;
      } catch {
        // ignore non-Apple icon URL
      }
    }
  }

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
  const minOSVersion =
    asString(metadata.minimumOsVersion) ||
    asString(metadata.MinimumOSVersion) ||
    undefined;

  const rawVersions = Array.isArray(data.availableVersions)
    ? data.availableVersions.filter((v) => /^\d+$/.test(v))
    : [];
  const actualVersionID =
    (data.externalVersionId && /^\d+$/.test(data.externalVersionId) ? data.externalVersionId : '') ||
    externalVersionID ||
    rawVersions[rawVersions.length - 1] ||
    '';

  const availableVersionIDs = [...new Set([...rawVersions, ...(actualVersionID ? [actualVersionID] : [])])].sort(
    (a, b) => Number(b) - Number(a)
  );

  let fileSizeBytes: number | undefined;
  try {
    const head = await fetch(safeCdnUrl, {
      method: 'HEAD',
      signal: AbortSignal.timeout(4000),
    });
    const len = Number(head.headers.get('content-length'));
    if (Number.isFinite(len) && len > 0) fileSizeBytes = len;
  } catch {
    // optional
  }

  const metadataPlistXml = buildPlist({
    ...(metadata as Record<string, PlistValue>),
    'apple-id': session.email,
    userName: session.email,
  });

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
    md5: data.md5 || undefined,
    fileSizeBytes,
    iconURL,
    minOSVersion,
    sinfCount: typeof data.sinfCount === 'number' ? data.sinfCount : 0,
    metadataPlistXml,
    endpointUsed: 'fairplay-sap-bridge',
    isDeletedDirect: false,
  };
}

export async function bridgePurchaseFreeLicense(
  config: BridgeConfig,
  session: StoredAppleSession,
  appID: string
): Promise<{ ok: boolean; message: string }> {
  async function callPurchase(targetSession: StoredAppleSession) {
    const res = await fetch(`${config.baseUrl}/v1/store/purchase`, {
      method: 'POST',
      headers: buildBridgeHeaders(config.secret),
      body: JSON.stringify({
        account: toBridgeAccount(targetSession),
        appID,
      }),
      redirect: 'manual',
      signal: AbortSignal.timeout(30000),
    });

    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      message?: string;
      code?: string;
      error?: string;
    };
    return { res, data };
  }

  let { res, data } = await callPurchase(session);
  if ((!res.ok || !data.ok) && session.pod && data.code === 'sessionExpired') {
    const retry = await callPurchase({ ...session, pod: '' });
    if (retry.res.ok && retry.data.ok) {
      res = retry.res;
      data = retry.data;
    } else if (retry.data.code && retry.data.code !== 'sessionExpired') {
      res = retry.res;
      data = retry.data;
    }
  }

  if (!res.ok || !data.ok) {
    const err = new Error(data.error || `FairPlay SAP Bridge вернул HTTP ${res.status}`) as Error & {
      bridgeCode?: string;
    };
    err.bridgeCode = data.code;
    throw err;
  }

  return {
    ok: true,
    message: data.message || 'Бесплатная лицензия добавлена на ваш Apple ID.',
  };
}
