import type { CuratedAppEntry } from './types.ts';

export const DEFAULT_CUSTOM_LIST_TEMPLATE = `# Формат IPA_Downloader (AppsListCustom.txt):
# Название: AppID
# Или с привязкой версий к iOS:
# Название: AppID | 15-16=ExternalVersionID | 17=ExternalVersionID
СберБанк Онлайн (Семейный Онлайн): 6769745089
СберБанк Онлайн (Финансы Онлайн): 6749261529
Т-Банк (8PRO): 6785551921
Альфа-Банк (Апгрейд): 6774584229
ВТБ (Алтай): 6755773033
Авито (Anero): 6786287240
Авито (Аукцион Au.ru): 1467701468
Макс (Max): 6739530834`;

export function extractNumericAppID(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (/^\d{5,15}$/.test(trimmed)) {
    return trimmed;
  }

  if (/^id\d{5,15}$/i.test(trimmed)) {
    return trimmed.slice(2);
  }

  const matches = [...trimmed.matchAll(/(?:^|\/|id)(\d{5,15})(?:$|[/?#&\s])/gi)];
  if (matches.length > 0) {
    const last = matches[matches.length - 1];
    if (last[1]) return last[1];
  }

  return null;
}

const ROW_REGEX = /^\s*(.+?)\s*:\s*(\d{5,15})(?:\s*\|\s*(.*))?\s*$/;
const IOS_FIELD_REGEX = /^\s*(\d{1,2})(?:\s*-\s*(\d{1,2}))?\s*=\s*(\d+|NO_SUPPORT)\s*$/i;

export function parseAppsList(content: string): CuratedAppEntry[] {
  const seen = new Set<string>();
  const result: CuratedAppEntry[] = [];

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) {
      continue;
    }

    const rowMatch = line.match(ROW_REGEX);
    if (rowMatch) {
      const name = rowMatch[1].trim();
      const appID = rowMatch[2].trim();
      if (seen.has(appID)) continue;
      seen.add(appID);

      const iosVersionMap: Record<number, string> = {};
      let purchaseKind: string | undefined;
      let purchaseDate: string | undefined;

      const tail = rowMatch[3];
      if (tail) {
        const fields = tail
          .split('|')
          .map((s) => s.trim())
          .filter(Boolean);

        const iosCandidates: Record<number, Set<string>> = {};
        const nonIOSFields: string[] = [];

        for (const field of fields) {
          const iosMatch = field.match(IOS_FIELD_REGEX);
          if (iosMatch) {
            const firstIOS = parseInt(iosMatch[1], 10);
            const lastIOS = iosMatch[2] ? parseInt(iosMatch[2], 10) : firstIOS;
            const value = iosMatch[3].toUpperCase();
            if (firstIOS >= 1 && lastIOS >= firstIOS && lastIOS <= 99) {
              for (let v = firstIOS; v <= lastIOS; v += 1) {
                if (!iosCandidates[v]) iosCandidates[v] = new Set();
                iosCandidates[v].add(value);
              }
            }
          } else {
            nonIOSFields.push(field);
          }
        }

        for (const [iosStr, values] of Object.entries(iosCandidates)) {
          if (values.size === 1) {
            const [only] = [...values];
            if (/^\d+$/.test(only)) {
              iosVersionMap[Number(iosStr)] = only;
            }
          }
        }

        if (nonIOSFields.length >= 1) purchaseKind = nonIOSFields[0];
        if (nonIOSFields.length >= 2) purchaseDate = nonIOSFields[1];
      }

      result.push({
        id: appID,
        name: name || `App ${appID}`,
        iosVersionMap,
        purchaseKind,
        purchaseDate,
      });
      continue;
    }

    const fallbackID = extractNumericAppID(line);
    if (fallbackID && !seen.has(fallbackID)) {
      seen.add(fallbackID);
      result.push({
        id: fallbackID,
        name: `App ${fallbackID}`,
        iosVersionMap: {},
      });
    }
  }

  return result;
}

export function formatBytes(bytes?: number | string): string {
  const num = typeof bytes === 'string' ? Number(bytes) : bytes;
  if (!num || !Number.isFinite(num) || num <= 0) return '—';
  const units = ['Б', 'КБ', 'МБ', 'ГБ'];
  let val = num;
  let idx = 0;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx += 1;
  }
  return `${val >= 100 || idx === 0 ? val.toFixed(0) : val.toFixed(1)} ${units[idx]}`;
}

export function getAppMonogram(name: string): string {
  const cleaned = name.replace(/[^a-zA-Zа-яА-ЯёЁ0-9\s]/g, ' ').trim();
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    return `${words[0][0]}${words[1][0]}`.toUpperCase();
  }
  return (cleaned.slice(0, 2) || 'AP').toUpperCase();
}

export function getDeterministicTint(seed: string): string {
  const palette = [
    '#1D4ED8',
    '#0F766E',
    '#4338CA',
    '#B45309',
    '#0369A1',
    '#6D28D9',
    '#BE123C',
    '#334155',
  ];
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  return palette[Math.abs(hash) % palette.length];
}
