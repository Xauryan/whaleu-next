/**
 * Native plain-text recognition only. No HTML/Markdown interpretation, decoding,
 * trimming, normalization, network calls, capability probe or authority cache.
 * Offsets are half-open UTF-16 indices into the exact supplied source.
 *
 * Boundary/contact compatibility is based on WhaleU commit
 * 4494e36b9451e3a92874ccf85f574a36e28e3d48, utils/contentReferences.js and
 * utils/contentContacts.js. A future explicit Markdown renderer must decide
 * token eligibility separately; backticks here are ordinary source text.
 */
export interface ContentTextRange {
  readonly start: number;
  readonly end: number;
}

export interface ContentReferenceMatch extends ContentTextRange {
  readonly kind: 'reference';
  readonly text: string;
  readonly code: string;
}

export interface PlainContentTextSegment extends ContentTextRange {
  readonly kind: 'text';
  readonly text: string;
}

export type ContentReferenceTextSegment =
  PlainContentTextSegment | ContentReferenceMatch;

const COMMON_TLDS = new Set([
  'com',
  'cn',
  'net',
  'org',
  'edu',
  'gov',
  'io',
  'ai',
  'app',
  'dev',
  'co',
  'xyz',
  'info',
  'biz',
  'me',
  'tv',
  'top',
  'site',
  'store',
  'tech',
  'online',
  'club',
  'fun',
  'cc',
  'vip',
  'pro',
  'wiki',
  'school',
  'name',
  'mobi',
  'cloud',
  'link',
  'live',
  'space',
  'world',
  'work',
  'shop',
  'travel',
]);

const ASCII_LETTER = /^[A-Za-z]$/;
const ASCII_WORD = /^[A-Za-z0-9_]$/;
const HOST_CHAR = /^[A-Za-z0-9.-]$/;
const MAIL_LOCAL_CHAR = /^[A-Za-z0-9._%+-]$/;
const SCHEME_CHAR = /^[A-Za-z0-9+.-]$/;
const BAD_CONTACT_START = /^[A-Za-z0-9_@.%+\\\-/]$/;
const BAD_HOST_END = /^[A-Za-z0-9_@\\-]$/;
const URL_CHAR = /^[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]$/;
const URL_CHINESE_CHAR =
  /^[\u3007\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff10-\uff19\uff21-\uff3a\uff41-\uff5a]$/;
const URL_END_BOUNDARY =
  /^[\s"<>`},，。！？；：、…—“”‘’「」『』【】（）〈〉《》〔〕［］｛｝]$/;
const FULL_URL_END = /^[\s<>"，。！？；、（）【】]$/;
const ESCAPABLE_ADDRESS_CHAR = /^[_@.+\-:/?#&=()[\]*~!%]$/;

function isDigit(char: string | undefined): boolean {
  return char !== undefined && char >= '0' && char <= '9';
}

/** Width never determines the target kind. These may also be permanent aliases. */
export function isContentReferenceCode(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 7 || value.length > 9) {
    return false;
  }
  if (value[0] === '0') return false;
  for (let index = 0; index < value.length; index++) {
    if (!isDigit(value[index])) return false;
  }
  return true;
}

/** Scan each maximal possible scheme once, including failed/unknown schemes. */
function fullUrlRanges(source: string): ContentTextRange[] {
  const ranges: ContentTextRange[] = [];
  let index = 0;
  while (index < source.length) {
    if (!SCHEME_CHAR.test(source[index] ?? '')) {
      index++;
      continue;
    }
    let start = -1;
    while (index < source.length && SCHEME_CHAR.test(source[index] ?? '')) {
      if (start < 0 && ASCII_LETTER.test(source[index] ?? '')) start = index;
      index++;
    }
    if (start < 0 || source.slice(index, index + 3) !== '://') continue;
    const bodyStart = index + 3;
    let end = bodyStart;
    while (end < source.length && !FULL_URL_END.test(source[end] ?? '')) end++;
    if (end > bodyStart) ranges.push({ start, end });
    index = end;
  }
  return ranges;
}

interface AddressView {
  readonly text: string;
  readonly starts?: readonly number[];
  readonly ends?: readonly number[];
}

/** Contact recognition may see escaped addresses; display always uses source. */
function addressView(source: string): AddressView {
  if (!source.includes('\\')) return { text: source };
  const chars: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  for (let index = 0; index < source.length; index++) {
    const char = source[index] ?? '';
    if (char === '\\' && source[index + 1] === '\\') {
      chars.push('\\', '\\');
      starts.push(index, index + 1);
      ends.push(index + 1, index + 2);
      index++;
    } else if (
      char === '\\' &&
      ESCAPABLE_ADDRESS_CHAR.test(source[index + 1] ?? '')
    ) {
      chars.push(source[index + 1] ?? '');
      starts.push(index);
      ends.push(index + 2);
      index++;
    } else {
      chars.push(char);
      starts.push(index);
      ends.push(index + 1);
    }
  }
  return { text: chars.join(''), starts, ends };
}

function validDomain(host: string): boolean {
  if (host.length > 253) return false;
  const labels = host.split('.');
  return (
    labels.length >= 2 &&
    /^[A-Za-z]{2,24}$/.test(labels[labels.length - 1] ?? '') &&
    labels.every((label) =>
      /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label),
    )
  );
}

function validExplicitHost(host: string): boolean {
  if (host.toLowerCase() === 'localhost') return true;
  if (host.length <= 15 && /^[0-9]+(?:\.[0-9]+){3}$/.test(host)) {
    return host
      .split('.')
      .every((part) => part.length <= 3 && Number(part) <= 255);
  }
  return validDomain(host);
}

interface ScannedContact {
  readonly next: number;
  readonly end?: number;
}

function contactUrlAt(
  text: string,
  start: number,
  hostStart: number,
  explicit: boolean,
): ScannedContact {
  let next = hostStart;
  while (next < text.length && HOST_CHAR.test(text[next] ?? '')) next++;
  let hostEnd = next;
  while (hostEnd > hostStart && text[hostEnd - 1] === '.') hostEnd--;
  const host = text.slice(hostStart, hostEnd);
  if (BAD_CONTACT_START.test(text[start - 1] ?? '')) return { next };
  if (
    explicit
      ? !validExplicitHost(host)
      : !validDomain(host) ||
        !COMMON_TLDS.has(host.split('.').pop()?.toLowerCase() ?? '')
  ) {
    return { next };
  }
  if (BAD_HOST_END.test(text[hostEnd] ?? '')) return { next };
  let end = hostEnd;
  if (text[end] === ':' && isDigit(text[end + 1])) {
    const portStart = ++end;
    while (end < text.length && isDigit(text[end])) end++;
    next = Math.max(next, end);
    if (
      end - portStart > 5 ||
      Number(text.slice(portStart, end)) < 1 ||
      Number(text.slice(portStart, end)) > 65535 ||
      BAD_HOST_END.test(text[end] ?? '')
    ) {
      return { next };
    }
  }
  if (text[end] === '/' || text[end] === '?' || text[end] === '#') {
    while (
      end < text.length &&
      (URL_CHAR.test(text[end] ?? '') || URL_CHINESE_CHAR.test(text[end] ?? ''))
    )
      end++;
    next = Math.max(next, end);
    if (end < text.length && !URL_END_BOUNDARY.test(text[end] ?? ''))
      return { next };
  }
  // Legacy contact trimming only removes punctuation/brackets, never #digits.
  // The broader range is equivalent for reference exclusion, with no copy action.
  return { next: Math.max(next, end), end };
}

/**
 * Bare/www/escaped HTTP and email contacts have priority, as do caller-supplied
 * contact ranges. An email can begin inside a digit run (#1234567@example.com),
 * so even partial reference/contact overlap must exclude the entire reference.
 */
function contactUrlRanges(source: string): ContentTextRange[] {
  const view = addressView(source);
  const text = view.text;
  const ranges: ContentTextRange[] = [];
  for (let at = 0; at < text.length; at++) {
    if (text[at] !== '@') continue;
    let start = at;
    let end = at + 1;
    while (
      start > 0 &&
      at - start < 65 &&
      MAIL_LOCAL_CHAR.test(text[start - 1] ?? '')
    )
      start--;
    while (
      end < text.length &&
      end - at <= 254 &&
      HOST_CHAR.test(text[end] ?? '')
    )
      end++;
    while (end > at + 1 && text[end - 1] === '.') end--;
    const local = text.slice(start, at);
    if (
      !local ||
      local.length > 64 ||
      local.startsWith('.') ||
      local.endsWith('.') ||
      local.includes('..') ||
      BAD_CONTACT_START.test(text[start - 1] ?? '') ||
      !validDomain(text.slice(at + 1, end)) ||
      end - start > 254 ||
      BAD_HOST_END.test(text[end] ?? '')
    )
      continue;
    ranges.push({
      start: view.starts?.[start] ?? start,
      end: view.ends?.[end - 1] ?? end,
    });
  }
  let index = 0;
  while (index < text.length) {
    const protocol = text.slice(index, index + 8).toLowerCase();
    const protocolWidth = protocol.startsWith('https://')
      ? 8
      : protocol.startsWith('http://')
        ? 7
        : 0;
    if (protocolWidth === 0 && !ASCII_WORD.test(text[index] ?? '')) {
      index++;
      continue;
    }
    const start = index;
    const contact = contactUrlAt(
      text,
      start,
      start + protocolWidth,
      protocolWidth > 0 ||
        text.slice(start, start + 4).toLowerCase() === 'www.',
    );
    index = Math.max(index + 1, contact.next);
    if (contact.end === undefined || contact.end <= start) continue;
    ranges.push({
      start: view.starts?.[start] ?? start,
      end: view.ends?.[contact.end - 1] ?? contact.end,
    });
  }
  return ranges;
}

function exclusionRanges(
  source: string,
  contacts: readonly ContentTextRange[],
): ContentTextRange[] {
  const sorted = [
    ...fullUrlRanges(source),
    ...contactUrlRanges(source),
    ...contacts,
  ]
    .filter(
      (range) =>
        Number.isSafeInteger(range.start) &&
        Number.isSafeInteger(range.end) &&
        range.start >= 0 &&
        range.end > range.start &&
        range.end <= source.length,
    )
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: ContentTextRange[] = [];
  for (const range of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && range.start <= previous.end) {
      merged[merged.length - 1] = {
        start: previous.start,
        end: Math.max(previous.end, range.end),
      };
    } else {
      merged.push({ start: range.start, end: range.end });
    }
  }
  return merged;
}

/** Recognize syntax, not capability, existence, visibility or authorization. */
export function findContentReferences(
  source: string,
  contacts: readonly ContentTextRange[] = [],
): ContentReferenceMatch[] {
  if (!source.includes('#')) return [];
  const excluded = exclusionRanges(source, contacts);
  const result: ContentReferenceMatch[] = [];
  let rangeIndex = 0;
  let index = 0;
  while (index < source.length) {
    if (source[index] !== '#' || !isDigit(source[index + 1])) {
      index++;
      continue;
    }
    const start = index++;
    while (index < source.length && isDigit(source[index])) index++;
    const end = index;
    while (
      rangeIndex < excluded.length &&
      (excluded[rangeIndex]?.end ?? 0) <= start
    )
      rangeIndex++;
    const range = excluded[rangeIndex];
    const previous = source[start - 1] ?? '';
    if (
      end - start < 8 ||
      end - start > 10 ||
      source[start + 1] === '0' ||
      ASCII_WORD.test(previous) ||
      previous === '/' ||
      previous === '#' ||
      previous === '\\' ||
      ASCII_WORD.test(source[end] ?? '') ||
      (range && start < range.end && end > range.start)
    )
      continue;
    result.push({
      kind: 'reference',
      start,
      end,
      text: source.slice(start, end),
      code: source.slice(start + 1, end),
    });
  }
  return result;
}

/** Capability must be strictly true. Empty input still has one plain segment. */
export function splitContentReferenceText(
  source: string,
  capability: unknown,
  contacts: readonly ContentTextRange[] = [],
): ContentReferenceTextSegment[] {
  const plain = (start: number, end: number): PlainContentTextSegment => ({
    kind: 'text',
    start,
    end,
    text: source.slice(start, end),
  });
  if (capability !== true) return [plain(0, source.length)];
  const references = findContentReferences(source, contacts);
  if (references.length === 0) return [plain(0, source.length)];
  const result: ContentReferenceTextSegment[] = [];
  let cursor = 0;
  for (const reference of references) {
    if (cursor < reference.start) result.push(plain(cursor, reference.start));
    result.push(reference);
    cursor = reference.end;
  }
  if (cursor < source.length) result.push(plain(cursor, source.length));
  return result;
}

function codePointBoundary(source: string, end: number): number {
  const before = source.charCodeAt(end - 1);
  const after = source.charCodeAt(end);
  return before >= 0xd800 &&
    before <= 0xdbff &&
    after >= 0xdc00 &&
    after <= 0xdfff
    ? end - 1
    : end;
}

/**
 * UTF-16 budget; never splits a surrogate pair or fabricates a shorter code.
 * Deliberate legacy divergence: extend short digit runs (at most nine digits),
 * but omit an intersecting overlong run instead of copying unbounded digits.
 * Also retain one following ASCII word character to preserve exclusion.
 * Output is at most limit + 10 + 3 UTF-16 units (the suffix is literal '...').
 * This is a preview only: the complete source and its segments stay untouched.
 */
export function truncateReferencePreview(
  source: string,
  limit: number,
): string {
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new RangeError('Preview limit must be a nonnegative safe integer');
  }
  if (source.length <= limit) return source;
  let end = codePointBoundary(source, limit);
  let digitStart = end;
  while (digitStart > 0 && isDigit(source[digitStart - 1])) digitStart--;
  const hash =
    source[digitStart - 1] === '#'
      ? digitStart - 1
      : source[end - 1] === '#'
        ? end - 1
        : -1;
  if (hash >= 0 && isDigit(source[end])) {
    let runEnd = end;
    while (runEnd <= hash + 9 && isDigit(source[runEnd])) runEnd++;
    end = runEnd <= hash + 10 && !isDigit(source[runEnd]) ? runEnd : hash;
  }
  if (
    hash >= 0 &&
    end > hash &&
    ASCII_WORD.test(source[end] ?? '') &&
    !isDigit(source[end])
  )
    end++;
  end = codePointBoundary(source, end);
  let preview = source.slice(0, end) + (end < source.length ? '...' : '');
  // A preview must not gain a reference through any contact/boundary change.
  // Compare source positions, not just code values (which may occur repeatedly).
  const original = new Map(
    findContentReferences(source).map((reference) => [
      reference.start,
      reference.end,
    ]),
  );
  const gained = findContentReferences(preview).find(
    (reference) => original.get(reference.start) !== reference.end,
  );
  if (gained) preview = source.slice(0, gained.start) + '...';
  return preview;
}
