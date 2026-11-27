export type PlistValue =
  | string
  | number
  | boolean
  | Date
  | Buffer
  | PlistValue[]
  | { [key: string]: PlistValue };

export function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function unescapeXml(str: string): string {
  return str
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number(dec)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function serializeValue(val: PlistValue, indent: string): string {
  if (typeof val === 'string') {
    return `${indent}<string>${escapeXml(val)}</string>`;
  }
  if (typeof val === 'boolean') {
    return `${indent}<${val ? 'true' : 'false'}/>`;
  }
  if (typeof val === 'number') {
    if (Number.isInteger(val)) {
      return `${indent}<integer>${val}</integer>`;
    }
    return `${indent}<real>${val}</real>`;
  }
  if (val instanceof Date) {
    return `${indent}<date>${val.toISOString()}</date>`;
  }
  if (Buffer.isBuffer(val)) {
    return `${indent}<data>${val.toString('base64')}</data>`;
  }
  if (Array.isArray(val)) {
    if (val.length === 0) return `${indent}<array/>`;
    const items = val.map((item) => serializeValue(item, `${indent}  `)).join('\n');
    return `${indent}<array>\n${items}\n${indent}</array>`;
  }
  if (val && typeof val === 'object') {
    const entries = Object.entries(val).filter(([, v]) => v !== undefined && v !== null);
    if (entries.length === 0) return `${indent}<dict/>`;
    const body = entries
      .map(([k, v]) => `${indent}  <key>${escapeXml(k)}</key>\n${serializeValue(v, `${indent}  `)}`)
      .join('\n');
    return `${indent}<dict>\n${body}\n${indent}</dict>`;
  }
  return `${indent}<string></string>`;
}

export function buildPlist(value: PlistValue): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    serializeValue(value, ''),
    '</plist>',
  ].join('\n');
}

interface Token {
  type: 'open' | 'close' | 'self' | 'text';
  name?: string;
  text?: string;
}

function tokenizeXml(xml: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const len = xml.length;

  while (i < len) {
    const lt = xml.indexOf('<', i);
    if (lt === -1) {
      const rest = xml.slice(i);
      if (rest) tokens.push({ type: 'text', text: rest });
      break;
    }
    if (lt > i) {
      tokens.push({ type: 'text', text: xml.slice(i, lt) });
    }

    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4);
      i = end === -1 ? len : end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9);
      const data = end === -1 ? xml.slice(lt + 9) : xml.slice(lt + 9, end);
      tokens.push({ type: 'text', text: data });
      i = end === -1 ? len : end + 3;
      continue;
    }
    if (xml.startsWith('<?', lt) || xml.startsWith('<!', lt)) {
      const end = xml.indexOf('>', lt + 2);
      i = end === -1 ? len : end + 1;
      continue;
    }

    const gt = xml.indexOf('>', lt + 1);
    if (gt === -1) break;

    const inner = xml.slice(lt + 1, gt).trim();
    if (inner.startsWith('/')) {
      const name = inner.slice(1).split(/\s+/)[0];
      tokens.push({ type: 'close', name });
    } else if (inner.endsWith('/')) {
      const name = inner.slice(0, -1).trim().split(/\s+/)[0];
      tokens.push({ type: 'self', name });
    } else {
      const name = inner.split(/\s+/)[0];
      tokens.push({ type: 'open', name });
    }

    i = gt + 1;
  }

  return tokens;
}

export function parsePlist(xml: string): PlistValue {
  const tokens = tokenizeXml(xml);
  let pos = 0;

  function skipNoise() {
    while (
      pos < tokens.length &&
      (tokens[pos].type === 'text' && !tokens[pos].text?.trim())
    ) {
      pos += 1;
    }
  }

  function readTextUntilClose(tagName: string): string {
    let text = '';
    while (pos < tokens.length) {
      const t = tokens[pos];
      if (t.type === 'close' && t.name === tagName) {
        pos += 1;
        return text;
      }
      if (t.type === 'text') {
        text += t.text ?? '';
      }
      pos += 1;
    }
    return text;
  }

  function parseNode(): PlistValue {
    skipNoise();
    if (pos >= tokens.length) return {};
    const tok = tokens[pos];
    pos += 1;

    if (tok.type === 'self') {
      switch (tok.name) {
        case 'true':
          return true;
        case 'false':
          return false;
        case 'dict':
          return {};
        case 'array':
          return [];
        case 'string':
          return '';
        case 'data':
          return Buffer.alloc(0);
        default:
          return '';
      }
    }

    if (tok.type !== 'open') {
      return '';
    }

    switch (tok.name) {
      case 'plist': {
        const inner = parseNode();
        skipNoise();
        if (pos < tokens.length && tokens[pos].type === 'close' && tokens[pos].name === 'plist') {
          pos += 1;
        }
        return inner;
      }
      case 'dict': {
        const obj: Record<string, PlistValue> = {};
        while (pos < tokens.length) {
          skipNoise();
          if (pos >= tokens.length) break;
          const next = tokens[pos];
          if (next.type === 'close' && next.name === 'dict') {
            pos += 1;
            break;
          }
          if (next.type === 'open' && next.name === 'key') {
            pos += 1;
            const key = unescapeXml(readTextUntilClose('key'));
            const val = parseNode();
            obj[key] = val;
          } else {
            pos += 1;
          }
        }
        return obj;
      }
      case 'array': {
        const arr: PlistValue[] = [];
        while (pos < tokens.length) {
          skipNoise();
          if (pos >= tokens.length) break;
          const next = tokens[pos];
          if (next.type === 'close' && next.name === 'array') {
            pos += 1;
            break;
          }
          arr.push(parseNode());
        }
        return arr;
      }
      case 'string':
        return unescapeXml(readTextUntilClose('string'));
      case 'integer': {
        const raw = readTextUntilClose('integer').trim();
        const num = Number(raw);
        return Number.isSafeInteger(num) ? num : raw;
      }
      case 'real':
        return parseFloat(readTextUntilClose('real').trim());
      case 'date':
        return new Date(readTextUntilClose('date').trim());
      case 'data': {
        const b64 = readTextUntilClose('data').replace(/\s+/g, '');
        return Buffer.from(b64, 'base64');
      }
      case 'true':
        readTextUntilClose('true');
        return true;
      case 'false':
        readTextUntilClose('false');
        return false;
      default:
        return unescapeXml(readTextUntilClose(tok.name ?? ''));
    }
  }

  // Advance to <plist> if present
  while (pos < tokens.length && !(tokens[pos].type === 'open' && tokens[pos].name === 'plist')) {
    pos += 1;
  }
  if (pos >= tokens.length) {
    pos = 0;
  }
  return parseNode();
}

export interface OtaManifestParams {
  ipaUrl: string;
  bundleId: string;
  bundleVersion: string;
  title: string;
  iconUrl?: string;
}

export function buildOtaManifestPlist(params: OtaManifestParams): string {
  const assets: PlistValue[] = [
    {
      kind: 'software-package',
      url: params.ipaUrl,
    },
  ];

  if (params.iconUrl && params.iconUrl.startsWith('https://')) {
    assets.push({
      kind: 'display-image',
      'needs-shine': false,
      url: params.iconUrl,
    });
    assets.push({
      kind: 'full-size-image',
      'needs-shine': false,
      url: params.iconUrl,
    });
  }

  return buildPlist({
    items: [
      {
        assets,
        metadata: {
          'bundle-identifier': params.bundleId,
          'bundle-version': params.bundleVersion || '1.0',
          kind: 'software',
          title: params.title,
        },
      },
    ],
  });
}
