import type {
  AppAvailabilityStatus,
  AppVersionEntry,
  CachedAppMetadata,
  ITunesSearchItem,
} from '../shared/types.ts';
import { isValidAppId, normalizeCountry } from './security.ts';

const GITHUB_POPULAR_LIST_URL =
  'https://raw.githubusercontent.com/kda2495/IPA_Downloader/refs/heads/main/Files/AppsList.txt';

interface ITunesResponse {
  resultCount: number;
  results: ITunesSearchItem[];
}

export function getBestIconUrl(item?: ITunesSearchItem): string | undefined {
  if (!item) return undefined;
  return item.artworkUrl512 || item.artworkUrl100;
}

export async function searchITunesCatalog(
  term: string,
  countryRaw: string,
  limitRaw = 30
): Promise<ITunesSearchItem[]> {
  const cleanTerm = term.trim().slice(0, 120);
  if (!cleanTerm) return [];
  const country = normalizeCountry(countryRaw);
  const limit = Math.min(50, Math.max(1, Number(limitRaw) || 30));

  const url = new URL('https://itunes.apple.com/search');
  url.searchParams.set('term', cleanTerm);
  url.searchParams.set('country', country);
  url.searchParams.set('entity', 'software');
  url.searchParams.set('limit', String(limit));

  const res = await fetch(url.toString(), {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    throw new Error(`iTunes Search вернул HTTP ${res.status}`);
  }
  const data = (await res.json()) as ITunesResponse;
  return Array.isArray(data.results) ? data.results : [];
}

async function lookupBatchCountry(
  ids: string[],
  country: string
): Promise<Record<string, ITunesSearchItem>> {
  if (ids.length === 0) return {};
  const url = new URL('https://itunes.apple.com/lookup');
  url.searchParams.set('id', ids.join(','));
  url.searchParams.set('country', country);
  url.searchParams.set('entity', 'software');

  try {
    const res = await fetch(url.toString(), {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(9000),
    });
    if (!res.ok) return {};
    const data = (await res.json()) as ITunesResponse;
    const map: Record<string, ITunesSearchItem> = {};
    for (const item of data.results ?? []) {
      if (item && item.trackId) {
        map[String(item.trackId)] = item;
      }
    }
    return map;
  } catch {
    return {};
  }
}

export async function lookupStoreBatch(
  rawIds: string[]
): Promise<{
  metadata: Record<string, CachedAppMetadata>;
  items: Record<string, ITunesSearchItem>;
}> {
  const validIds = [...new Set(rawIds.map((id) => id.trim()).filter((id) => isValidAppId(id)))].slice(
    0,
    100
  );

  if (validIds.length === 0) {
    return { metadata: {}, items: {} };
  }

  const ruMap = await lookupBatchCountry(validIds, 'ru');
  const missingInRU = validIds.filter((id) => !ruMap[id]);
  const usMap = missingInRU.length > 0 ? await lookupBatchCountry(missingInRU, 'us') : {};

  const metadata: Record<string, CachedAppMetadata> = {};
  const items: Record<string, ITunesSearchItem> = {};
  const now = Date.now();

  for (const id of validIds) {
    if (ruMap[id]) {
      const item = ruMap[id];
      items[id] = item;
      metadata[id] = toCachedMetadata(id, 'availableRU', item, now);
    } else if (usMap[id]) {
      const item = usMap[id];
      items[id] = item;
      metadata[id] = toCachedMetadata(id, 'deletedInRUAvailableUS', item, now);
    } else {
      metadata[id] = toCachedMetadata(id, 'deletedGlobally', undefined, now);
    }
  }

  return { metadata, items };
}

function toCachedMetadata(
  appID: string,
  status: AppAvailabilityStatus,
  item: ITunesSearchItem | undefined,
  updatedAt: number
): CachedAppMetadata {
  return {
    appID,
    status,
    iconURL: getBestIconUrl(item),
    bundleID: item?.bundleId,
    artistName: item?.artistName,
    storeVersion: item?.version,
    priceFormatted: item?.formattedPrice,
    minOSVersion: item?.minimumOsVersion,
    fileSizeBytes: item?.fileSizeBytes ? Number(item.fileSizeBytes) : undefined,
    updatedAt,
  };
}

function parsePublicHistoryRows(raw: unknown): AppVersionEntry[] {
  let rows: Record<string, unknown>[] = [];
  if (raw && typeof raw === 'object' && 'data' in raw && Array.isArray((raw as { data: unknown }).data)) {
    rows = (raw as { data: Record<string, unknown>[] }).data;
  } else if (Array.isArray(raw)) {
    rows = raw as Record<string, unknown>[];
  } else {
    return [];
  }

  const byID = new Map<string, AppVersionEntry>();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const rawExt = row.external_identifier ?? row.externalVersionId ?? row.id;
    const cleanID = typeof rawExt === 'number' ? String(rawExt) : typeof rawExt === 'string' ? rawExt.trim() : '';
    if (!/^\d{1,15}$/.test(cleanID)) continue;

    if (!byID.has(cleanID)) {
      const bundleVer = typeof row.bundle_version === 'string' ? row.bundle_version.trim() : undefined;
      const sizeBytes = typeof row.size === 'number' ? row.size : undefined;
      const createdAt = typeof row.created_at === 'string' ? row.created_at.trim() : undefined;
      byID.set(cleanID, {
        externalVersionID: cleanID,
        bundleVersion: bundleVer || undefined,
        sizeBytes,
        createdAt: createdAt || undefined,
        source: 'public',
      });
    }
  }

  return [...byID.values()].sort((a, b) => Number(b.externalVersionID) - Number(a.externalVersionID));
}

export async function fetchPublicVersionHistory(appID: string): Promise<AppVersionEntry[]> {
  if (!isValidAppId(appID)) return [];
  const endpoints = [
    `https://apis.bilin.eu.org/history/${encodeURIComponent(appID)}`,
    `https://api.timbrd.com/apple/app-version/index.php?id=${encodeURIComponent(appID)}`,
  ];

  try {
    return await Promise.any(
      endpoints.map(async (endpoint) => {
        const res = await fetch(endpoint, {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(4500),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const parsed = parsePublicHistoryRows(data);
        if (parsed.length === 0) throw new Error('Empty history');
        return parsed;
      })
    );
  } catch {
    return [];
  }
}

export async function syncPopularAppsListFromGitHub(): Promise<string> {
  const res = await fetch(GITHUB_POPULAR_LIST_URL, {
    headers: {
      'User-Agent': 'IPAVaultWeb/1.0',
      Accept: 'text/plain',
    },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    throw new Error(`GitHub вернул HTTP ${res.status}`);
  }
  const text = await res.text();
  if (!text.trim() || text.length < 100) {
    throw new Error('Получен пустой список приложений с GitHub');
  }
  return text;
}
