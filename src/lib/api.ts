import type {
  AccountOwnershipStatus,
  AnisetteServer,
  AnisetteTestResult,
  AppleSessionSummary,
  AppVersionEntry,
  AuthLoginResponse,
  BridgeStatusResponse,
  BridgeTestResult,
  CachedAppMetadata,
  GeneratedSessionResponse,
  ITunesSearchItem,
  InspectAppResponse,
  SessionPersistMode,
} from '../shared/types.ts';

const CSRF_HEADERS: Record<string, string> = {
  'X-Requested-With': 'IPAVaultWeb',
};

const BRIDGE_URL_STORAGE_KEY = 'ipavault_sap_bridge_url';
const BRIDGE_SECRET_SESSION_KEY = 'ipavault_sap_bridge_secret';

export function getSavedBridgeConfig(): { bridgeUrl: string; bridgeSecret: string } {
  if (typeof window === 'undefined') return { bridgeUrl: '', bridgeSecret: '' };
  return {
    bridgeUrl: localStorage.getItem(BRIDGE_URL_STORAGE_KEY) || '',
    bridgeSecret: sessionStorage.getItem(BRIDGE_SECRET_SESSION_KEY) || '',
  };
}

export function saveBridgeConfig(bridgeUrl: string, bridgeSecret: string): void {
  if (typeof window === 'undefined') return;
  const cleanUrl = bridgeUrl.trim();
  const cleanSecret = bridgeSecret.trim();
  if (cleanUrl) {
    localStorage.setItem(BRIDGE_URL_STORAGE_KEY, cleanUrl);
  } else {
    localStorage.removeItem(BRIDGE_URL_STORAGE_KEY);
  }
  if (cleanSecret) {
    sessionStorage.setItem(BRIDGE_SECRET_SESSION_KEY, cleanSecret);
  } else {
    sessionStorage.removeItem(BRIDGE_SECRET_SESSION_KEY);
  }
}

function getBridgeHeaders(override?: {
  bridgeUrl?: string;
  bridgeSecret?: string;
}): Record<string, string> {
  const saved = getSavedBridgeConfig();
  const url = (override?.bridgeUrl ?? saved.bridgeUrl).trim();
  const secret = (override?.bridgeSecret ?? saved.bridgeSecret).trim();
  const headers: Record<string, string> = {};
  if (url) headers['X-SAP-Bridge-Url'] = url;
  if (secret) headers['X-SAP-Bridge-Secret'] = secret;
  return headers;
}

async function parseJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Сервер вернул некорректный ответ (HTTP ${res.status})`);
  }
}

export async function apiSearchCatalog(
  term: string,
  country: string,
  limit = 30
): Promise<ITunesSearchItem[]> {
  const qs = new URLSearchParams({
    term,
    country,
    limit: String(limit),
  });
  const res = await fetch(`/api/catalog/search?${qs.toString()}`, {
    credentials: 'include',
  });
  const data = await parseJson<{ results?: ITunesSearchItem[]; error?: string }>(res);
  if (!res.ok) throw new Error(data.error || 'Ошибка поиска');
  return data.results ?? [];
}

export async function apiLookupBatch(
  ids: string[]
): Promise<{
  metadata: Record<string, CachedAppMetadata>;
  items: Record<string, ITunesSearchItem>;
}> {
  const res = await fetch('/api/catalog/lookup', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...CSRF_HEADERS },
    body: JSON.stringify({ ids }),
  });
  const data = await parseJson<{
    metadata?: Record<string, CachedAppMetadata>;
    items?: Record<string, ITunesSearchItem>;
    error?: string;
  }>(res);
  if (!res.ok) throw new Error(data.error || 'Ошибка проверки App Store');
  return {
    metadata: data.metadata ?? {},
    items: data.items ?? {},
  };
}

export async function apiFetchPublicVersions(appId: string): Promise<AppVersionEntry[]> {
  const res = await fetch(`/api/catalog/versions/${encodeURIComponent(appId)}`, {
    credentials: 'include',
  });
  const data = await parseJson<{ versions?: AppVersionEntry[] }>(res);
  return data.versions ?? [];
}

export async function apiSyncPopularList(): Promise<string> {
  const res = await fetch('/api/catalog/sync-popular', {
    credentials: 'include',
  });
  const data = await parseJson<{ ok?: boolean; content?: string; error?: string }>(res);
  if (!res.ok || !data.content) {
    throw new Error(data.error || 'Не удалось обновить список с GitHub');
  }
  return data.content;
}

export async function apiFetchAnisetteServers(): Promise<AnisetteServer[]> {
  const res = await fetch('/api/anisette/servers', {
    credentials: 'include',
  });
  const data = await parseJson<{ servers?: AnisetteServer[] }>(res);
  return data.servers ?? [];
}

export async function apiTestAnisette(address?: string): Promise<AnisetteTestResult> {
  const res = await fetch('/api/anisette/test', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...CSRF_HEADERS },
    body: JSON.stringify({ address }),
  });
  return parseJson<AnisetteTestResult>(res);
}

export async function apiGetBridgeStatus(): Promise<BridgeStatusResponse> {
  const res = await fetch('/api/bridge/status', {
    credentials: 'include',
  });
  return parseJson<BridgeStatusResponse>(res);
}

export async function apiTestBridge(
  bridgeUrl?: string,
  bridgeSecret?: string
): Promise<BridgeTestResult> {
  const res = await fetch('/api/bridge/test', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...CSRF_HEADERS },
    body: JSON.stringify({
      bridgeUrl: bridgeUrl?.trim() || undefined,
      bridgeSecret: bridgeSecret?.trim() || undefined,
    }),
  });
  return parseJson<BridgeTestResult>(res);
}

export async function apiRestoreBrowserSession(): Promise<{
  authenticated: boolean;
  token?: string;
  session?: AppleSessionSummary;
  expired?: boolean;
}> {
  const res = await fetch('/api/auth/me', {
    credentials: 'include',
    headers: CSRF_HEADERS,
  });
  return parseJson(res);
}

export async function apiLoginAppleId(params: {
  email: string;
  password: string;
  code?: string;
  useAnisette: boolean;
  anisetteUrl?: string;
  guid?: string;
  authEndpoint?: string;
  persistMode: SessionPersistMode;
  bridgeUrl?: string;
  bridgeSecret?: string;
}): Promise<
  AuthLoginResponse & { guid?: string; authEndpoint?: string; requiresSapBridge?: boolean }
> {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...CSRF_HEADERS,
      ...getBridgeHeaders({
        bridgeUrl: params.bridgeUrl,
        bridgeSecret: params.bridgeSecret,
      }),
    },
    body: JSON.stringify(params),
  });
  return parseJson<
    AuthLoginResponse & { guid?: string; authEndpoint?: string; requiresSapBridge?: boolean }
  >(res);
}

export async function apiLoginWithSessionToken(params: {
  sessionString: string;
  pin?: string;
  persistMode: SessionPersistMode;
}): Promise<AuthLoginResponse & { needsPin?: boolean }> {
  const res = await fetch('/api/auth/login-session', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...CSRF_HEADERS },
    body: JSON.stringify(params),
  });
  return parseJson<AuthLoginResponse & { needsPin?: boolean }>(res);
}

export async function apiUpdateSessionPolicy(
  persistMode: SessionPersistMode,
  authToken?: string | null
): Promise<{ ok: boolean; token?: string; session?: AppleSessionSummary; error?: string }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...CSRF_HEADERS,
  };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  const res = await fetch('/api/auth/session-policy', {
    method: 'POST',
    credentials: 'include',
    headers,
    body: JSON.stringify({ persistMode }),
  });
  return parseJson(res);
}

export async function apiGenerateSessionToken(
  params: { durationMode: '24h' | 'keep'; pin?: string },
  authToken?: string | null
): Promise<GeneratedSessionResponse> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...CSRF_HEADERS,
  };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  const res = await fetch('/api/auth/generate-session', {
    method: 'POST',
    credentials: 'include',
    headers,
    body: JSON.stringify(params),
  });
  return parseJson<GeneratedSessionResponse>(res);
}

export async function apiLogout(): Promise<void> {
  await fetch('/api/auth/logout', {
    method: 'POST',
    credentials: 'include',
    headers: CSRF_HEADERS,
  });
}

export async function apiInspectApp(params: {
  appID: string;
  externalVersionID?: string;
  authToken?: string | null;
}): Promise<InspectAppResponse> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...CSRF_HEADERS,
    ...getBridgeHeaders(),
  };
  if (params.authToken) {
    headers.Authorization = `Bearer ${params.authToken}`;
  }
  const res = await fetch('/api/store/inspect', {
    method: 'POST',
    credentials: 'include',
    headers,
    body: JSON.stringify({
      appID: params.appID,
      externalVersionID: params.externalVersionID || '',
    }),
  });
  const data = await parseJson<InspectAppResponse & { error?: string }>(res);
  if (!res.ok) {
    throw new Error(data.error || 'Не удалось получить данные приложения');
  }
  return data;
}

export async function apiPurchaseFreeLicense(
  appID: string,
  authToken?: string | null
): Promise<{ ok: boolean; message?: string; error?: string; sessionExpired?: boolean }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...CSRF_HEADERS,
    ...getBridgeHeaders(),
  };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  const res = await fetch('/api/store/purchase', {
    method: 'POST',
    credentials: 'include',
    headers,
    body: JSON.stringify({ appID }),
  });
  return parseJson(res);
}

export async function apiCheckOwnershipBatch(
  ids: string[],
  authToken?: string | null
): Promise<{
  statuses: Record<string, AccountOwnershipStatus>;
  icons: Record<string, string>;
  sessionExpired?: boolean;
}> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...CSRF_HEADERS,
    ...getBridgeHeaders(),
  };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  const res = await fetch('/api/store/check-ownership', {
    method: 'POST',
    credentials: 'include',
    headers,
    body: JSON.stringify({ ids }),
  });
  const data = await parseJson<{
    statuses?: Record<string, AccountOwnershipStatus>;
    icons?: Record<string, string>;
    sessionExpired?: boolean;
    error?: string;
  }>(res);
  if (!res.ok) {
    throw new Error(data.error || 'Ошибка проверки лицензий');
  }
  return {
    statuses: data.statuses ?? {},
    icons: data.icons ?? {},
    sessionExpired: data.sessionExpired,
  };
}

export function buildAbsoluteManifestUrl(manifestPath: string): string {
  const origin = window.location.origin;
  return `${origin}${manifestPath.startsWith('/') ? manifestPath : `/${manifestPath}`}`;
}

export function buildItmsServicesUrl(manifestPath: string): string {
  const manifestUrl = buildAbsoluteManifestUrl(manifestPath);
  return `itms-services://?action=download-manifest&url=${encodeURIComponent(manifestUrl)}`;
}

export function buildQrHandoffUrl(manifestToken: string, appName: string): string {
  const url = new URL(window.location.origin);
  url.searchParams.set('ota', manifestToken);
  url.searchParams.set('title', appName);
  return url.toString();
}

export function isIosDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  return (
    /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

export function triggerDirectFileDownload(url: string, filename?: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener noreferrer';
  if (filename) a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

export function downloadTextFile(filename: string, content: string, mime = 'application/xml'): void {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const blobUrl = URL.createObjectURL(blob);
  triggerDirectFileDownload(blobUrl, filename);
  setTimeout(() => URL.revokeObjectURL(blobUrl), 2500);
}
