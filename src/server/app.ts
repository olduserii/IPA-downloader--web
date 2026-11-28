import express, { type Request } from 'express';
import type {
  AccountOwnershipStatus,
  AppleSessionSummary,
  AppVersionEntry,
  InspectAppResponse,
  SessionPersistMode,
} from '../shared/types.ts';
import {
  fetchAnisetteWithFailover,
  fetchOfficialAnisetteServers,
} from './anisette.ts';
import {
  AppleStoreError,
  authenticateAppleId,
  fetchDownloadDescriptor,
  purchaseFreeLicense,
} from './appleStore.ts';
import {
  fetchPublicVersionHistory,
  lookupStoreBatch,
  searchITunesCatalog,
  syncPopularAppsListFromGitHub,
} from './catalog.ts';
import {
  getEnvBridgeStatus,
  resolveBridgeConfig,
  testBridgeConnection,
} from './companion.ts';
import { buildOtaManifestPlist } from './plist.ts';
import {
  clearBrowserSessionCookies,
  createPortableSessionToken,
  decryptSessionToken,
  extractBearerToken,
  isValidAppId,
  isValidVersionId,
  normalizeCountry,
  parseCookies,
  parsePortableSessionToken,
  readSessionCookieToken,
  SESSION_KEY_COOKIE_NAME,
  SESSION_TTL_24H_SEC,
  SESSION_TTL_KEEP_SEC,
  setBrowserSessionCookies,
  type StoredAppleSession,
  verifyCsrfOnMutation,
  verifyManifestToken,
} from './security.ts';

function toSummary(s: StoredAppleSession): AppleSessionSummary {
  return {
    email: s.email,
    accountName: s.accountName,
    dsid: s.dsid,
    pod: s.pod,
    storeFront: s.storeFront,
    expiresAt: s.expiresAt,
    persistMode: s.persistMode,
  };
}

function normalizePersistMode(_raw: unknown): SessionPersistMode {
  return 'keep';
}

function extractBridgeOverride(req: Request): { bridgeUrl?: string; bridgeSecret?: string } {
  const hdrUrl =
    typeof req.headers['x-sap-bridge-url'] === 'string'
      ? req.headers['x-sap-bridge-url'].trim()
      : undefined;
  const hdrSecret =
    typeof req.headers['x-sap-bridge-secret'] === 'string'
      ? req.headers['x-sap-bridge-secret'].trim()
      : undefined;
  const bodyUrl = typeof req.body?.bridgeUrl === 'string' ? req.body.bridgeUrl.trim() : undefined;
  const bodySecret =
    typeof req.body?.bridgeSecret === 'string' ? req.body.bridgeSecret.trim() : undefined;
  return {
    bridgeUrl: bodyUrl || hdrUrl || undefined,
    bridgeSecret: bodySecret || hdrSecret || undefined,
  };
}

interface ResolvedAuth {
  session: StoredAppleSession | null;
  usedCookie: boolean;
  browserKeyHex?: string;
  hadExpiredCredential: boolean;
}

function resolveSessionFromRequest(req: Request): ResolvedAuth {
  const cookies = parseCookies(req.headers.cookie);
  const browserKeyHex = cookies[SESSION_KEY_COOKIE_NAME];
  const bearer = extractBearerToken(req.headers.authorization);

  if (bearer) {
    // 1. Self-contained ipav1.* token (works deterministically across all Vercel cold starts)
    if (bearer.startsWith('ipav1.open.')) {
      const parsed = parsePortableSessionToken(bearer);
      if (parsed.session) {
        return { session: parsed.session, usedCookie: false, browserKeyHex, hadExpiredCredential: false };
      }
    }
    // 2. Legacy per-browser or deployment-key encrypted token
    const fromBrowserKey = browserKeyHex ? decryptSessionToken(bearer, browserKeyHex) : null;
    if (fromBrowserKey) {
      return { session: fromBrowserKey, usedCookie: false, browserKeyHex, hadExpiredCredential: false };
    }
    const fromServerKey = decryptSessionToken(bearer);
    if (fromServerKey) {
      return { session: fromServerKey, usedCookie: false, browserKeyHex, hadExpiredCredential: false };
    }
  }

  const cookieToken = readSessionCookieToken(cookies);
  if (cookieToken) {
    if (cookieToken.startsWith('ipav1.open.')) {
      const parsed = parsePortableSessionToken(cookieToken);
      if (parsed.session) {
        return { session: parsed.session, usedCookie: true, browserKeyHex, hadExpiredCredential: false };
      }
    }
    const fromCookie =
      (browserKeyHex ? decryptSessionToken(cookieToken, browserKeyHex) : null) ??
      decryptSessionToken(cookieToken);
    if (fromCookie) {
      return { session: fromCookie, usedCookie: true, browserKeyHex, hadExpiredCredential: false };
    }
    return { session: null, usedCookie: true, browserKeyHex, hadExpiredCredential: true };
  }

  return {
    session: null,
    usedCookie: false,
    browserKeyHex,
    hadExpiredCredential: Boolean(bearer),
  };
}

export function createApiRouter(): express.Router {
  const router = express.Router();

  router.use(express.json({ limit: '512kb' }));

  router.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });

  router.get('/health', (_req, res) => {
    res.json({ ok: true, runtime: 'node', timestamp: Date.now() });
  });

  // --- App Store Catalog Search ---
  router.get('/catalog/search', async (req, res) => {
    try {
      const term = typeof req.query.term === 'string' ? req.query.term : '';
      const country = normalizeCountry(req.query.country);
      const limit = Number(req.query.limit) || 30;
      const results = await searchITunesCatalog(term, country, limit);
      res.json({ results });
    } catch (err) {
      res.status(502).json({
        error: err instanceof Error ? err.message : 'Ошибка поиска в App Store',
      });
    }
  });

  // --- Batch RU -> US Availability Lookup ---
  router.post('/catalog/lookup', async (req, res) => {
    try {
      const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
      if (ids.length === 0) {
        res.json({ metadata: {}, items: {} });
        return;
      }
      const data = await lookupStoreBatch(ids);
      res.json(data);
    } catch (err) {
      res.status(502).json({
        error: err instanceof Error ? err.message : 'Ошибка проверки доступности App Store',
      });
    }
  });

  // --- Public Historical External Version IDs ---
  router.get('/catalog/versions/:appId', async (req, res) => {
    const appId = req.params.appId?.trim() ?? '';
    if (!isValidAppId(appId)) {
      res.status(400).json({ error: 'Некорректный App ID' });
      return;
    }
    try {
      const versions = await fetchPublicVersionHistory(appId);
      res.json({ appId, versions });
    } catch {
      res.json({ appId, versions: [] });
    }
  });

  // --- Sync Popular AppsList.txt from GitHub ---
  router.get('/catalog/sync-popular', async (_req, res) => {
    try {
      const text = await syncPopularAppsListFromGitHub();
      res.json({ ok: true, content: text });
    } catch (err) {
      res.status(502).json({
        ok: false,
        error: err instanceof Error ? err.message : 'Не удалось обновить список с GitHub',
      });
    }
  });

  // --- SideStore Anisette Servers ---
  router.get('/anisette/servers', async (_req, res) => {
    const servers = await fetchOfficialAnisetteServers();
    res.json({ servers });
  });

  router.post('/anisette/test', async (req, res) => {
    try {
      const preferredAddress =
        typeof req.body?.address === 'string' ? req.body.address.trim() : undefined;
      const result = await fetchAnisetteWithFailover(preferredAddress);
      const mdm = result.headers['X-Apple-I-MD-M'] ?? '';
      res.json({
        ok: true,
        serverName: result.serverName,
        serverAddress: result.serverAddress,
        latencyMs: result.latencyMs,
        machineIdPreview: mdm ? `${mdm.slice(0, 12)}…` : undefined,
      });
    } catch (err) {
      res.status(400).json({
        ok: false,
        error: err instanceof Error ? err.message : 'Ошибка проверки Anisette',
      });
    }
  });

  // --- FairPlay SAP Bridge Status & Test ---
  router.get('/bridge/status', (_req, res) => {
    const status = getEnvBridgeStatus();
    res.json({
      configured: Boolean(status.config),
      source: status.config ? 'env' : 'none',
      host: status.host,
      envError: status.envError,
    });
  });

  router.post('/bridge/test', async (req, res) => {
    if (!verifyCsrfOnMutation(req)) {
      res.status(403).json({ ok: false, error: 'Запрос отклонён проверкой источника' });
      return;
    }
    try {
      const override = extractBridgeOverride(req);
      const config = resolveBridgeConfig(override);
      if (!config) {
        res.status(400).json({
          ok: false,
          error: 'Укажите HTTPS-адрес FairPlay SAP Bridge или задайте SAP_BRIDGE_URL в Vercel.',
        });
        return;
      }
      const result = await testBridgeConnection(config);
      res.status(result.ok ? 200 : 400).json(result);
    } catch (err) {
      res.status(400).json({
        ok: false,
        error: err instanceof Error ? err.message : 'Некорректный адрес FairPlay SAP Bridge',
      });
    }
  });

  // --- Apple ID Authentication (Automatic 24h Browser Cookie Cache + Stateless Bearer) ---
  router.post('/auth/login', async (req, res) => {
    try {
      const email = typeof req.body?.email === 'string' ? req.body.email : '';
      const password = typeof req.body?.password === 'string' ? req.body.password : '';
      const code = typeof req.body?.code === 'string' ? req.body.code : undefined;
      const useAnisette = req.body?.useAnisette !== false;
      const anisetteUrl =
        typeof req.body?.anisetteUrl === 'string' ? req.body.anisetteUrl.trim() : undefined;
      const existingGuid =
        typeof req.body?.guid === 'string' ? req.body.guid.trim() : undefined;
      const preferredAuthEndpoint =
        typeof req.body?.authEndpoint === 'string'
          ? req.body.authEndpoint.trim()
          : undefined;
      const persistMode = normalizePersistMode(req.body?.persistMode);
      const bridgeOverride = extractBridgeOverride(req);

      const result = await authenticateAppleId({
        email,
        password,
        code,
        useAnisette,
        anisetteUrl,
        existingGuid,
        preferredAuthEndpoint,
        persistMode,
        bridgeUrl: bridgeOverride.bridgeUrl,
        bridgeSecret: bridgeOverride.bridgeSecret,
      });

      if (result.status === 'authenticated' && result.rawSession) {
        const cookies = parseCookies(req.headers.cookie);
        const { bearerToken, portableToken } = setBrowserSessionCookies(
          res,
          result.rawSession,
          cookies[SESSION_KEY_COOKIE_NAME],
          req
        );
        res.json({
          status: 'authenticated',
          token: bearerToken,
          portableToken,
          session: toSummary(result.rawSession),
          anisetteUsed: result.anisetteUsed,
        });
        return;
      }

      res.status(result.status === 'error' ? 401 : 200).json({
        status: result.status,
        guid: result.guid,
        authEndpoint: result.authEndpoint,
        anisetteUsed: result.anisetteUsed,
        requiresSapBridge: result.requiresSapBridge,
        message: result.message,
      });
    } catch (err) {
      res.status(500).json({
        status: 'error',
        message: err instanceof Error ? err.message : 'Внутренняя ошибка аутентификации',
      });
    }
  });

  // --- Restore Session Automatically from Browser Cookie ---
  router.get('/auth/me', (req, res) => {
    const resolved = resolveSessionFromRequest(req);
    if (!resolved.session) {
      if (resolved.hadExpiredCredential && resolved.usedCookie) {
        clearBrowserSessionCookies(res, req);
      }
      res.json({ authenticated: false, expired: resolved.hadExpiredCredential });
      return;
    }

    const { bearerToken, portableToken } = setBrowserSessionCookies(
      res,
      resolved.session,
      resolved.browserKeyHex,
      req
    );

    res.json({
      authenticated: true,
      token: bearerToken,
      portableToken,
      session: toSummary(resolved.session),
    });
  });

  // --- Update Browser Session Persistence Policy (24h / Keep / Memory) ---
  router.post('/auth/session-policy', (req, res) => {
    const resolved = resolveSessionFromRequest(req);
    if (!resolved.session) {
      res.status(401).json({ ok: false, error: 'Требуется активная сессия Apple ID' });
      return;
    }
    if (resolved.usedCookie && !verifyCsrfOnMutation(req)) {
      res.status(403).json({ ok: false, error: 'Запрос отклонён проверкой источника' });
      return;
    }

    const persistMode = normalizePersistMode(req.body?.persistMode);
    const ttlMs =
      persistMode === 'keep'
        ? SESSION_TTL_KEEP_SEC * 1000
        : SESSION_TTL_24H_SEC * 1000;

    const updated: StoredAppleSession = {
      ...resolved.session,
      persistMode,
      expiresAt: Date.now() + ttlMs,
    };

    const { bearerToken } = setBrowserSessionCookies(res, updated, resolved.browserKeyHex, req);
    res.json({
      ok: true,
      token: bearerToken,
      session: toSummary(updated),
    });
  });

  // --- Generate Portable Session Token for Future Reuse ("Генерация сессии") ---
  router.post('/auth/generate-session', (req, res) => {
    const resolved = resolveSessionFromRequest(req);
    if (!resolved.session) {
      res.status(401).json({ ok: false, error: 'Сначала выполните вход в Apple ID' });
      return;
    }
    if (resolved.usedCookie && !verifyCsrfOnMutation(req)) {
      res.status(403).json({ ok: false, error: 'Запрос отклонён проверкой источника' });
      return;
    }

    const durationMode = req.body?.durationMode === 'keep' ? 'keep' : '24h';
    const pin = typeof req.body?.pin === 'string' ? req.body.pin.slice(0, 32) : undefined;

    const generated = createPortableSessionToken(resolved.session, {
      durationMode,
      pin,
    });

    res.json({
      ok: true,
      sessionString: generated.sessionString,
      expiresAt: generated.expiresAt,
      pinProtected: generated.pinProtected,
    });
  });

  // --- Login Using a Previously Generated Session Token ("Вход по сессии") ---
  router.post('/auth/login-session', (req, res) => {
    if (!verifyCsrfOnMutation(req)) {
      res.status(403).json({ status: 'error', message: 'Запрос отклонён проверкой источника' });
      return;
    }

    const sessionString =
      typeof req.body?.sessionString === 'string' ? req.body.sessionString : '';
    const pin = typeof req.body?.pin === 'string' ? req.body.pin : undefined;

    const parsed = parsePortableSessionToken(sessionString, pin);
    if (!parsed.session) {
      res.status(400).json({
        status: 'error',
        needsPin: parsed.needsPin,
        message: parsed.error || 'Некорректный токен сессии',
      });
      return;
    }

    const restoredSession: StoredAppleSession = {
      ...parsed.session,
      persistMode: 'keep',
      expiresAt: Math.max(parsed.session.expiresAt, Date.now() + SESSION_TTL_KEEP_SEC * 1000),
    };

    const cookies = parseCookies(req.headers.cookie);
    const { bearerToken, portableToken } = setBrowserSessionCookies(
      res,
      restoredSession,
      cookies[SESSION_KEY_COOKIE_NAME],
      req
    );

    res.json({
      status: 'authenticated',
      token: bearerToken,
      portableToken,
      session: toSummary(restoredSession),
    });
  });

  // --- Sign Out & Clear Browser Cache Cookies ---
  router.post('/auth/logout', (req, res) => {
    if (!verifyCsrfOnMutation(req)) {
      res.status(403).json({ ok: false, error: 'Запрос отклонён проверкой источника' });
      return;
    }
    clearBrowserSessionCookies(res, req);
    res.json({ ok: true });
  });

  // --- Inspect App & Fetch Direct Apple CDN IPA Descriptor + Signed OTA Manifest Token ---
  router.post('/store/inspect', async (req, res) => {
    const appID = typeof req.body?.appID === 'string' ? req.body.appID.trim() : '';
    const externalVersionID =
      typeof req.body?.externalVersionID === 'string'
        ? req.body.externalVersionID.trim()
        : '';

    if (!isValidAppId(appID)) {
      res.status(400).json({ error: 'Укажите корректный числовой App ID (например, 481627348)' });
      return;
    }
    if (externalVersionID && !isValidVersionId(externalVersionID)) {
      res.status(400).json({ error: 'Некорректный External Version ID' });
      return;
    }

    const resolved = resolveSessionFromRequest(req);
    if (resolved.usedCookie && resolved.session && !verifyCsrfOnMutation(req)) {
      res.status(403).json({ error: 'Запрос отклонён проверкой источника' });
      return;
    }
    const session = resolved.session;

    const [lookupRes, publicHistory] = await Promise.all([
      lookupStoreBatch([appID]),
      fetchPublicVersionHistory(appID),
    ]);

    const meta = lookupRes.metadata[appID];
    const storeItem = lookupRes.items[appID];
    const availability = meta?.status ?? 'deletedGlobally';

    if (!session) {
      const response: InspectAppResponse = {
        appID,
        availability,
        storeItem,
        versions: publicHistory,
        ownership: 'unauthenticated',
        warning: resolved.hadExpiredCredential
          ? 'Сессия Apple ID истекла — выполните вход повторно или используйте сохранённый токен сессии.'
          : 'Войдите в Apple ID (или по токену сессии) на вкладке «Аккаунт», чтобы получить прямую ссылку на скачивание IPA и установку на iPhone.',
      };
      res.json(response);
      return;
    }

    try {
      const bridgeOverride = extractBridgeOverride(req);
      const descriptor = await fetchDownloadDescriptor(
        session,
        appID,
        externalVersionID,
        bridgeOverride
      );

      const publicById = new Map(publicHistory.map((v) => [v.externalVersionID, v]));
      const mergedMap = new Map<string, AppVersionEntry>();

      for (const verId of descriptor.availableVersionIDs) {
        const pub = publicById.get(verId);
        mergedMap.set(verId, {
          externalVersionID: verId,
          bundleVersion:
            pub?.bundleVersion ??
            (verId === descriptor.externalVersionID ? descriptor.version : undefined),
          sizeBytes:
            pub?.sizeBytes ??
            (verId === descriptor.externalVersionID ? descriptor.fileSizeBytes : undefined),
          createdAt: pub?.createdAt,
          source: 'apple',
        });
      }

      for (const pub of publicHistory) {
        if (!mergedMap.has(pub.externalVersionID)) {
          mergedMap.set(pub.externalVersionID, pub);
        }
      }

      const versions = [...mergedMap.values()].sort(
        (a, b) => Number(b.externalVersionID) - Number(a.externalVersionID)
      );

      const response: InspectAppResponse = {
        appID,
        availability,
        storeItem,
        versions,
        descriptor,
        ownership: 'owned',
      };
      res.json(response);
    } catch (err) {
      const storeErr = err instanceof AppleStoreError ? err : null;
      const response: InspectAppResponse = {
        appID,
        availability,
        storeItem,
        versions: publicHistory,
        ownership: 'notOwned',
        licenseRequired: storeErr?.code === 'licenseRequired',
        sessionExpired: storeErr?.code === 'sessionExpired',
        warning:
          err instanceof Error
            ? err.message
            : 'Не удалось получить ссылку на скачивание от серверов Apple.',
      };
      res.json(response);
    }
  });

  // --- Acquire Free App Store License on Apple ID ---
  router.post('/store/purchase', async (req, res) => {
    const resolved = resolveSessionFromRequest(req);
    if (!resolved.session) {
      res.status(401).json({ ok: false, error: 'Требуется вход в Apple ID' });
      return;
    }
    if (resolved.usedCookie && !verifyCsrfOnMutation(req)) {
      res.status(403).json({ ok: false, error: 'Запрос отклонён проверкой источника' });
      return;
    }

    const appID = typeof req.body?.appID === 'string' ? req.body.appID.trim() : '';
    if (!isValidAppId(appID)) {
      res.status(400).json({ ok: false, error: 'Некорректный App ID' });
      return;
    }

    try {
      const bridgeOverride = extractBridgeOverride(req);
      const result = await purchaseFreeLicense(resolved.session, appID, bridgeOverride);
      res.json(result);
    } catch (err) {
      const storeErr = err instanceof AppleStoreError ? err : null;
      res.status(storeErr?.code === 'sessionExpired' ? 401 : 400).json({
        ok: false,
        sessionExpired: storeErr?.code === 'sessionExpired',
        error: err instanceof Error ? err.message : 'Ошибка добавления лицензии',
      });
    }
  });

  // --- Batch Ownership Check on Signed-In Apple ID ---
  router.post('/store/check-ownership', async (req, res) => {
    const resolved = resolveSessionFromRequest(req);
    if (!resolved.session) {
      res.status(401).json({ error: 'Требуется вход в Apple ID' });
      return;
    }
    if (resolved.usedCookie && !verifyCsrfOnMutation(req)) {
      res.status(403).json({ error: 'Запрос отклонён проверкой источника' });
      return;
    }

    const session = resolved.session;
    const ids: string[] = Array.isArray(req.body?.ids)
      ? req.body.ids.map(String).filter((id: string) => isValidAppId(id)).slice(0, 12)
      : [];

    const statuses: Record<string, AccountOwnershipStatus> = {};
    const icons: Record<string, string> = {};
    let sessionExpired = false;

    const bridgeOverride = extractBridgeOverride(req);
    const concurrency = 4;
    for (let i = 0; i < ids.length; i += concurrency) {
      if (sessionExpired) break;
      const chunk = ids.slice(i, i + concurrency);
      await Promise.all(
        chunk.map(async (id) => {
          try {
            const desc = await fetchDownloadDescriptor(session, id, '', bridgeOverride, true);
            statuses[id] = 'owned';
            if (desc.iconURL) icons[id] = desc.iconURL;
          } catch (err) {
            if (err instanceof AppleStoreError) {
              if (err.code === 'sessionExpired') {
                sessionExpired = true;
                statuses[id] = 'error';
              } else {
                statuses[id] = 'notOwned';
              }
            } else {
              statuses[id] = 'error';
            }
          }
        })
      );
    }

    res.json({ statuses, icons, sessionExpired });
  });

  // --- Dynamic Apple OTA Manifest (itms-services://?action=download-manifest&url=...) ---
  router.get('/manifest.plist', (req, res) => {
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    const verified = verifyManifestToken(token);
    if (!verified) {
      res
        .status(400)
        .type('text/plain; charset=utf-8')
        .send('Invalid or expired OTA manifest token.');
      return;
    }

    const xml = buildOtaManifestPlist({
      ipaUrl: verified.ipaUrl,
      bundleId: verified.bundleId,
      bundleVersion: verified.bundleVersion,
      title: verified.title,
      iconUrl: verified.iconUrl,
    });

    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.send(xml);
  });

  return router;
}

export function createVercelApp(): express.Express {
  const app = express();
  app.set('trust proxy', 1);
  const apiRouter = createApiRouter();
  app.use('/api', apiRouter);
  app.use('/', apiRouter);
  return app;
}
