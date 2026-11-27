import type { AnisetteServer } from '../shared/types.ts';
import { assertSafeExternalHttpsUrl } from './security.ts';

export const OFFICIAL_ANISETTE_LIST_URL =
  'https://raw.githubusercontent.com/SideStore/anisette-servers/main/servers.json';

export const BUILT_IN_ANISETTE_SERVERS: AnisetteServer[] = [
  { name: 'SideStore Official', address: 'https://ani.sidestore.io', kind: 0 },
  { name: 'iDH Server (SideStore)', address: 'https://ani.idevicehacked.com', kind: 0 },
  { name: 'neoarz', address: 'https://ani.neoarz.com', kind: 0 },
  { name: 'pythonplayer123', address: 'https://ani3server.fly.dev', kind: 0 },
  { name: "Jayden's Server", address: 'https://ani.jaydenha.uk', kind: 0 },
  { name: 'crystall1nedev', address: 'https://anisette.crystall1ne.dev', kind: 0 },
  { name: 'ethxn omnisette', address: 'https://omni.ethxn.xyz', kind: 0 },
  { name: 'uwucloud', address: 'https://ani.uwucloud.fun', kind: 0 },
  { name: 'koremi', address: 'https://ani.sjwon0368.dpdns.org', kind: 0 },
];

export interface AnisettePayload {
  serverAddress: string;
  serverName: string;
  headers: Record<string, string>;
  latencyMs: number;
}

export function mapAnisetteAuthHeaders(headers: Record<string, string>): Record<string, string> {
  const mapped: Record<string, string> = {};
  if (headers['X-Apple-I-MD']) {
    mapped['X-Apple-AMD'] = headers['X-Apple-I-MD'];
    mapped['X-Apple-I-MD'] = headers['X-Apple-I-MD'];
  }
  if (headers['X-Apple-I-MD-M']) {
    mapped['X-Apple-AMD-M'] = headers['X-Apple-I-MD-M'];
    mapped['X-Apple-I-MD-M'] = headers['X-Apple-I-MD-M'];
  }
  for (const key of ['X-Apple-I-MD-RINFO', 'X-MMe-Client-Info', 'X-Mme-Device-Id']) {
    if (headers[key]) {
      mapped[key] = headers[key];
    }
  }
  return mapped;
}

export async function fetchOfficialAnisetteServers(): Promise<AnisetteServer[]> {
  try {
    const res = await fetch(OFFICIAL_ANISETTE_LIST_URL, {
      headers: {
        'User-Agent': 'SideStore/1.0 IPAVaultWeb/1.0',
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(4500),
    });
    if (!res.ok) return BUILT_IN_ANISETTE_SERVERS;
    const raw = (await res.json()) as { servers?: AnisetteServer[] } | AnisetteServer[];
    const list = Array.isArray(raw) ? raw : Array.isArray(raw?.servers) ? raw.servers : [];
    const safe = list.filter((s) => {
      if (!s || typeof s.address !== 'string' || typeof s.name !== 'string') return false;
      try {
        assertSafeExternalHttpsUrl(s.address);
        return true;
      } catch {
        return false;
      }
    });
    return safe.length > 0 ? safe : BUILT_IN_ANISETTE_SERVERS;
  } catch {
    return BUILT_IN_ANISETTE_SERVERS;
  }
}

export async function fetchSingleAnisette(server: AnisetteServer): Promise<AnisettePayload> {
  const safeUrl = assertSafeExternalHttpsUrl(server.address);
  const started = Date.now();
  const res = await fetch(safeUrl.toString(), {
    method: 'GET',
    headers: {
      'User-Agent': 'SideStore/1.0 (iOS; IPAVaultWeb)',
      Accept: 'application/json',
    },
    redirect: 'manual',
    signal: AbortSignal.timeout(3800),
  });

  if (!res.ok) {
    throw new Error(`${server.name}: HTTP ${res.status}`);
  }

  const raw = (await res.json()) as Record<string, unknown>;
  const headers: Record<string, string> = {};
  for (const [key, val] of Object.entries(raw)) {
    if (typeof val === 'string' && val.trim()) {
      headers[key] = val.trim();
    } else if (typeof val === 'number') {
      headers[key] = String(val);
    }
  }

  if (!headers['X-Apple-I-MD'] || !headers['X-Apple-I-MD-M']) {
    throw new Error(`Сервер ${server.name} вернул неполный Anisette-ответ`);
  }

  return {
    serverAddress: safeUrl.toString(),
    serverName: server.name,
    headers,
    latencyMs: Math.max(1, Date.now() - started),
  };
}

export async function fetchAnisetteWithFailover(
  preferredAddress?: string
): Promise<AnisettePayload> {
  const ordered: AnisetteServer[] = [];
  const trimmed = preferredAddress?.trim() ?? '';

  if (trimmed) {
    assertSafeExternalHttpsUrl(trimmed);
    const existing = BUILT_IN_ANISETTE_SERVERS.find((s) => s.address === trimmed);
    ordered.push(existing ?? { name: 'Custom Anisette', address: trimmed, kind: 0 });
  }

  for (const s of BUILT_IN_ANISETTE_SERVERS) {
    if (!ordered.some((o) => o.address === s.address)) {
      ordered.push(s);
    }
  }

  const errors: string[] = [];
  const batchSize = 4;

  for (let i = 0; i < ordered.length; i += batchSize) {
    const batch = ordered.slice(i, i + batchSize);
    try {
      const winner = await Promise.any(batch.map((srv) => fetchSingleAnisette(srv)));
      return winner;
    } catch (agg) {
      if (agg instanceof AggregateError) {
        for (const err of agg.errors) {
          errors.push(err instanceof Error ? err.message : String(err));
        }
      }
    }
  }

  throw new Error(
    `Серверы SideStore Anisette не ответили: ${errors.slice(0, 3).join(' | ')}`
  );
}
