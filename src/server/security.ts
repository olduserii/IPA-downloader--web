import crypto from 'node:crypto';
import net from 'node:net';
import type { Request, Response } from 'express';
import type { SessionPersistMode } from '../shared/types.ts';

// Ephemeral fallback for local dev if no env secret exists
const EPHEMERAL_FALLBACK = crypto.randomBytes(32);

export const SESSION_COOKIE_NAME = 'ipavault_session';
export const SESSION_KEY_COOKIE_NAME = 'ipavault_sk';

export const SESSION_TTL_24H_SEC = 24 * 60 * 60;
export const SESSION_TTL_KEEP_SEC = 30 * 24 * 60 * 60; // 30 days ("Не сбрасывать")

function getServerMasterKey(): Buffer | null {
  const envSecret = process.env.SESSION_SECRET?.trim();
  if (envSecret && envSecret.length >= 16) {
    return crypto.createHash('sha256').update(envSecret).digest();
  }
  return null;
}

// Manifest links are fetched by iOS itunesstored without browser cookies,
// so derive a deployment-stable HMAC key automatically on Vercel (VERCEL_PROJECT_ID)
// when SESSION_SECRET is not manually set.
function getManifestSigningKey(): Buffer {
  const master = getServerMasterKey();
  if (master) return master;
  const autoSeed =
    process.env.VERCEL_PROJECT_ID?.trim() ||
    process.env.APP_URL?.trim() ||
    '';
  if (autoSeed) {
    return crypto.createHash('sha256').update(`ipavault-manifest:${autoSeed}`).digest();
  }
  return EPHEMERAL_FALLBACK;
}

function deriveEffectiveSessionKey(browserKeyHex?: string): Buffer {
  const master = getServerMasterKey();
  if (browserKeyHex && /^[0-9a-f]{64}$/i.test(browserKeyHex)) {
    const rawBrowserKey = Buffer.from(browserKeyHex, 'hex');
    if (master) {
      return crypto.createHmac('sha256', master).update(rawBrowserKey).digest();
    }
    return rawBrowserKey;
  }
  return master ?? EPHEMERAL_FALLBACK;
}

export interface StoredAppleSession {
  email: string;
  accountName: string;
  dsid: string;
  passwordToken: string;
  pod: string;
  storeFront: string;
  guid: string;
  expiresAt: number;
  persistMode: SessionPersistMode;
}

export function encryptSessionWithKey(
  session: StoredAppleSession,
  keyBuf: Buffer
): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBuf, iv);
  const plaintext = Buffer.from(JSON.stringify(session), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64url');
}

export function decryptSessionWithKey(
  token: string,
  keyBuf: Buffer
): StoredAppleSession | null {
  try {
    const raw = Buffer.from(token, 'base64url');
    if (raw.length < 29 || raw.length > 8192) return null;
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const ciphertext = raw.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuf, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    const parsed = JSON.parse(decrypted) as StoredAppleSession;
    if (!parsed || typeof parsed.dsid !== 'string' || typeof parsed.passwordToken !== 'string') {
      return null;
    }
    if (Date.now() > parsed.expiresAt) {
      return null;
    }
    if (!parsed.persistMode) {
      parsed.persistMode = '24h';
    }
    return parsed;
  } catch {
    return null;
  }
}

export function encryptSessionToken(session: StoredAppleSession, browserKeyHex?: string): string {
  return encryptSessionWithKey(session, deriveEffectiveSessionKey(browserKeyHex));
}

export function decryptSessionToken(token: string, browserKeyHex?: string): StoredAppleSession | null {
  return decryptSessionWithKey(token, deriveEffectiveSessionKey(browserKeyHex));
}

// --- Portable Session Token Generator ("Сгенерировать сессию" -> "Вход по сессии") ---
// Self-contained encrypted format:
//   ipav1.open.<key_b64url>.<ciphertext_b64url>     (no PIN, works on any Vercel instance/browser)
//   ipav1.pin.<salt_b64url>.<ciphertext_b64url>     (PIN-protected via scrypt)
export function createPortableSessionToken(
  session: StoredAppleSession,
  opts: { durationMode: '24h' | 'keep'; pin?: string }
): { sessionString: string; expiresAt: number; pinProtected: boolean } {
  const ttlMs =
    opts.durationMode === 'keep'
      ? SESSION_TTL_KEEP_SEC * 1000
      : SESSION_TTL_24H_SEC * 1000;
  const expiresAt = Date.now() + ttlMs;
  const portablePayload: StoredAppleSession = {
    ...session,
    expiresAt,
    persistMode: opts.durationMode,
  };

  const cleanPin = opts.pin?.trim() ?? '';
  if (cleanPin.length > 0) {
    const salt = crypto.randomBytes(16);
    const derivedKey = crypto.scryptSync(cleanPin, salt, 32);
    const encrypted = encryptSessionWithKey(portablePayload, derivedKey);
    return {
      sessionString: `ipav1.pin.${salt.toString('base64url')}.${encrypted}`,
      expiresAt,
      pinProtected: true,
    };
  }

  const randomKey = crypto.randomBytes(32);
  const encrypted = encryptSessionWithKey(portablePayload, randomKey);
  return {
    sessionString: `ipav1.open.${randomKey.toString('base64url')}.${encrypted}`,
    expiresAt,
    pinProtected: false,
  };
}

export function parsePortableSessionToken(
  rawInput: string,
  pin?: string
): { session: StoredAppleSession | null; needsPin?: boolean; error?: string } {
  const trimmed = rawInput.trim();
  if (!trimmed || trimmed.length > 10000) {
    return { session: null, error: 'Некорректный формат токена сессии.' };
  }

  // Also support importing ipatool / IPA Vault JSON session objects directly
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      const passwordToken = String(obj.passwordToken ?? obj.password_token ?? '').trim();
      const dsid = String(
        obj.directoryServicesIdentifier ?? obj.dsid ?? obj.dsPersonId ?? ''
      ).trim();
      const email = String(obj.email ?? obj.appleId ?? 'apple-id@icloud.com').trim();
      const accountName = String(obj.name ?? obj.accountName ?? email).trim();
      const pod = String(obj.pod ?? '25').replace(/[^\d]/g, '') || '25';
      const storeFront = String(obj.storeFront ?? obj.storefront ?? '143469-16,32').trim();
      const guid = String(obj.guid ?? crypto.randomBytes(6).toString('hex')).toUpperCase().replace(/[^0-9A-F]/g, '').slice(0, 12) || crypto.randomBytes(6).toString('hex').toUpperCase();

      if (!passwordToken || !/^\d{5,20}$/.test(dsid)) {
        return {
          session: null,
          error: 'JSON должен содержать поля passwordToken и directoryServicesIdentifier (или dsid).',
        };
      }

      return {
        session: {
          email,
          accountName,
          dsid,
          passwordToken,
          pod,
          storeFront,
          guid,
          expiresAt: Date.now() + SESSION_TTL_KEEP_SEC * 1000,
          persistMode: '24h',
        },
      };
    } catch {
      return { session: null, error: 'Некорректный JSON сессии.' };
    }
  }

  const parts = trimmed.split('.');
  if (parts.length !== 4 || parts[0] !== 'ipav1') {
    return {
      session: null,
      error: 'Вставьте токен «ipav1…» (из IPA Vault) или JSON-сессию из ipatool.',
    };
  }

  const [, kind, keyOrSaltB64, encrypted] = parts;

  if (kind === 'open') {
    try {
      const keyBuf = Buffer.from(keyOrSaltB64, 'base64url');
      if (keyBuf.length !== 32) {
        return { session: null, error: 'Повреждённый ключ сессии.' };
      }
      const session = decryptSessionWithKey(encrypted, keyBuf);
      if (!session) {
        return { session: null, error: 'Сессия повреждена или срок её действия истёк.' };
      }
      return { session };
    } catch {
      return { session: null, error: 'Не удалось расшифровать сессию.' };
    }
  }

  if (kind === 'pin') {
    const cleanPin = pin?.trim() ?? '';
    if (!cleanPin) {
      return {
        session: null,
        needsPin: true,
        error: 'Эта сессия защищена PIN-кодом. Введите PIN для расшифровки.',
      };
    }
    try {
      const salt = Buffer.from(keyOrSaltB64, 'base64url');
      if (salt.length < 8 || salt.length > 64) {
        return { session: null, error: 'Повреждённый токен сессии.' };
      }
      const derivedKey = crypto.scryptSync(cleanPin, salt, 32);
      const session = decryptSessionWithKey(encrypted, derivedKey);
      if (!session) {
        return {
          session: null,
          needsPin: true,
          error: 'Неверный PIN-код или срок действия сессии истёк.',
        };
      }
      return { session };
    } catch {
      return { session: null, needsPin: true, error: 'Неверный PIN-код.' };
    }
  }

  return { session: null, error: 'Неподдерживаемый тип токена сессии.' };
}

// --- HttpOnly Browser Cache Cookies (24h default / 30d "Не сбрасывать") ---
export function parseCookies(cookieHeader?: string): Record<string, string> {
  const map: Record<string, string> = {};
  if (!cookieHeader) return map;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const val = part.slice(eq + 1).trim();
    if (key) {
      try {
        map[key] = decodeURIComponent(val);
      } catch {
        map[key] = val;
      }
    }
  }
  return map;
}

function buildCookieString(name: string, value: string, maxAgeSec: number): string {
  const encoded = encodeURIComponent(value);
  return `${name}=${encoded}; Path=/; Max-Age=${maxAgeSec}; HttpOnly; Secure; SameSite=None; Partitioned`;
}

export function setBrowserSessionCookies(
  res: Response,
  session: StoredAppleSession,
  existingBrowserKeyHex?: string
): { bearerToken: string; browserKeyHex: string } {
  const browserKeyHex =
    existingBrowserKeyHex && /^[0-9a-f]{64}$/i.test(existingBrowserKeyHex)
      ? existingBrowserKeyHex
      : crypto.randomBytes(32).toString('hex');

  const token = encryptSessionToken(session, browserKeyHex);

  if (session.persistMode === 'memory') {
    clearBrowserSessionCookies(res);
    return { bearerToken: token, browserKeyHex };
  }

  const maxAgeSec =
    session.persistMode === 'keep' ? SESSION_TTL_KEEP_SEC : SESSION_TTL_24H_SEC;

  res.setHeader('Set-Cookie', [
    buildCookieString(SESSION_COOKIE_NAME, token, maxAgeSec),
    buildCookieString(SESSION_KEY_COOKIE_NAME, browserKeyHex, maxAgeSec),
  ]);

  return { bearerToken: token, browserKeyHex };
}

export function clearBrowserSessionCookies(res: Response): void {
  res.setHeader('Set-Cookie', [
    buildCookieString(SESSION_COOKIE_NAME, '', 0),
    buildCookieString(SESSION_KEY_COOKIE_NAME, '', 0),
  ]);
}

export function verifyCsrfOnMutation(req: Request): boolean {
  const customHeader = req.headers['x-requested-with'];
  if (customHeader === 'IPAVaultWeb') {
    return true;
  }
  const origin = req.headers.origin;
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').toString().split(',')[0].trim();
  if (origin && host) {
    try {
      const originHost = new URL(origin).host;
      return originHost === host;
    } catch {
      return false;
    }
  }
  return false;
}

// --- Signed OTA Manifest Tokens ---
export interface SignedManifestPayload {
  ipaUrl: string;
  bundleId: string;
  bundleVersion: string;
  title: string;
  iconUrl?: string;
  exp: number;
}

export function signManifestToken(payload: Omit<SignedManifestPayload, 'exp'>): string {
  assertAppleCdnUrl(payload.ipaUrl);
  if (payload.iconUrl) {
    assertSafeIconUrl(payload.iconUrl);
  }
  const full: SignedManifestPayload = {
    ...payload,
    exp: Date.now() + 2 * 60 * 60 * 1000, // 2 hours
  };
  const encoded = Buffer.from(JSON.stringify(full), 'utf8').toString('base64url');
  const sig = crypto
    .createHmac('sha256', getManifestSigningKey())
    .update(encoded)
    .digest('base64url');
  return `${encoded}.${sig}`;
}

export function verifyManifestToken(token: string): SignedManifestPayload | null {
  try {
    if (!token || token.length > 8192) return null;
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const [encoded, sig] = parts;
    const expectedSig = crypto
      .createHmac('sha256', getManifestSigningKey())
      .update(encoded)
      .digest('base64url');

    const sigBuf = Buffer.from(sig);
    const expBuf = Buffer.from(expectedSig);
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      return null;
    }

    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as SignedManifestPayload;
    if (!parsed || Date.now() > parsed.exp) return null;
    assertAppleCdnUrl(parsed.ipaUrl);
    if (parsed.iconUrl) {
      assertSafeIconUrl(parsed.iconUrl);
    }
    return parsed;
  } catch {
    return null;
  }
}

function isBlockedHost(hostname: string): boolean {
  const lower = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    lower === 'localhost' ||
    lower.endsWith('.localhost') ||
    lower.endsWith('.local') ||
    lower.endsWith('.internal') ||
    lower === 'metadata.google.internal'
  ) {
    return true;
  }

  const ipVersion = net.isIP(lower);
  if (ipVersion === 4) {
    const [a, b] = lower.split('.').map(Number);
    if (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    ) {
      return true;
    }
    return true;
  }

  if (ipVersion === 6) {
    return true;
  }

  return false;
}

export function assertSafeExternalHttpsUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new Error('Некорректный URL');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('Разрешены только HTTPS-адреса');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Учётные данные в URL не поддерживаются');
  }
  if (parsed.port && parsed.port !== '443') {
    throw new Error('Разрешён только стандартный порт HTTPS (443)');
  }
  if (!parsed.hostname || !parsed.hostname.includes('.') || isBlockedHost(parsed.hostname)) {
    throw new Error('Указанный хост запрещён политикой безопасности');
  }
  return parsed;
}

const APPLE_CDN_SUFFIXES = [
  '.apple.com',
  '.mzstatic.com',
  '.icloud.com',
  '.cdn-apple.com',
  '.itunes.apple.com',
];

export function assertAppleCdnUrl(raw: string): URL {
  const parsed = assertSafeExternalHttpsUrl(raw);
  const host = parsed.hostname.toLowerCase();
  const allowed = APPLE_CDN_SUFFIXES.some((suffix) => host.endsWith(suffix));
  if (!allowed) {
    throw new Error(`Домен ${host} не принадлежит официальным серверам Apple`);
  }
  return parsed;
}

export function assertSafeIconUrl(raw: string): URL {
  return assertAppleCdnUrl(raw);
}

export function isValidAppId(val: unknown): val is string {
  return typeof val === 'string' && /^\d{4,15}$/.test(val.trim());
}

export function isValidVersionId(val: unknown): val is string {
  return typeof val === 'string' && /^\d{1,15}$/.test(val.trim());
}

export function normalizeCountry(val: unknown): string {
  if (typeof val === 'string' && /^[a-zA-Z]{2}$/.test(val.trim())) {
    return val.trim().toLowerCase();
  }
  return 'ru';
}

export function extractBearerToken(authHeader?: string): string | null {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7).trim();
  return token.length > 16 ? token : null;
}
