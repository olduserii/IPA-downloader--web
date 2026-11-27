import crypto from 'node:crypto';
import type { AuthLoginResponse, DownloadDescriptorResult } from '../shared/types.ts';
import { buildPlist, type PlistValue } from './plist.ts';
import {
  assertAppleCdnUrl,
  assertSafeExternalHttpsUrl,
  encryptSessionToken,
  isValidAppId,
  isValidVersionId,
  signManifestToken,
  type StoredAppleSession,
} from './security.ts';

export interface BridgeConfig {
  baseUrl: string;
  secret?: string;
  source: 'env' | 'custom';
}

export function getEnvBridgeConfig(): BridgeConfig | null {
  const rawUrl = process.env.SAP_BRIDGE_URL?.trim();
  if (!rawUrl) return null;
  try {
    const parsed = assertSafeExternalHttpsUrl(rawUrl);
    return {
      baseUrl: parsed.toString().replace(/\/+$/, ''),
      secret: process.env.SAP_BRIDGE_SECRET?.trim() || undefined,
      source: 'env',
    };
  } catch {
    return null;
  }
}

export function resolveBridgeConfig(override?: {
  bridgeUrl?: string;
  bridgeSecret?: string;
}): BridgeConfig | null {
  const customUrl = override?.bridgeUrl?.trim();
  if (customUrl) {
    const parsed = assertSafeExternalHttpsUrl(customUrl);
    return {
      baseUrl: parsed.toString().replace(/\/+$/, ''),
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
    const data = (await res.json()) as {
      ok?: boolean;
      engine?: string;
      secretProtected?: boolean;
    };
    if (!data.ok) {
      return { ok: false, error: 'Мост ответил некорректным статусом' };
    }
    return {
      ok: true,
      engine: data.engine || 'ipatool-sap-bridge',
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
    const ttlMs =
      opts.persistMode === 'keep'
        ? 30 * 24 * 60 * 60 * 1000
        : 24 * 60 * 60 * 1000;
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
      pod: (data.account.pod || '25').replace(/[^\d]/g, '') || '25',
      storeFront: data.account.storeFront || '143469-16,32',
      guid,
      expiresAt: Date.now() + ttlMs,
      persistMode: opts.persistMode,
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

  const res = await fetch(`${config.baseUrl}/v1/store/inspect`, {
    method: 'POST',
    headers: buildBridgeHeaders(config.secret),
    body: JSON.stringify({
      account: toBridgeAccount(session),
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
  const res = await fetch(`${config.baseUrl}/v1/store/purchase`, {
    method: 'POST',
    headers: buildBridgeHeaders(config.secret),
    body: JSON.stringify({
      account: toBridgeAccount(session),
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
