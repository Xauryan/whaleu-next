import {
  checkSource,
  eligible,
  FORMATTER,
  LIMITS,
  planSchema,
  decodeBoundedJson,
} from './contracts.js';
import type { ReadingPlan, SourceSnapshot } from './contracts.js';

export type FormattingOutcome =
  | { kind: 'invalid_source' }
  | { kind: 'ineligible' }
  | { kind: 'plan'; plan: ReadingPlan };

function unchanged(
  text: string,
  reason: 'no_safe_boundary' | 'structure_sensitive' | 'unsupported_unicode',
): ReadingPlan {
  return {
    version: 1,
    formatter: FORMATTER,
    offsetEncoding: 'utf16',
    mode: 'unchanged',
    reason,
    spans: [{ start: 0, end: text.length }],
  };
}
const opening = new Map([
  ['“', '”'],
  ['‘', '’'],
  ['「', '」'],
  ['『', '』'],
  ['（', '）'],
  ['(', ')'],
  ['[', ']'],
  ['【', '】'],
  ['《', '》'],
  ['〈', '〉'],
  ['{', '}'],
]);
const closing = new Set(opening.values());
const terminal = new Set(['。', '！', '？']);
/** A deliberate conservative fallback, not Markdown/HTML/URL parsing. */
function structureSensitive(text: string): boolean {
  return (
    /[`<>]|https?:\/\/|www\.|\b\w+:\/\//i.test(text) ||
    /(^|\n)[ \t]*(?:#{1,6}[ \t]|[-+*][ \t]|\d+[.)、][ \t]*|[|>])/.test(text) ||
    text.includes('$$') ||
    text.includes('~~~')
  );
}
/** Versioned finite admission profile, not a Unicode grapheme implementation.
 * Every admitted scalar is BMP, non-Extend/non-SpacingMark/non-Prepend and not
 * ZWJ, ZWNJ, CR or a surrogate. Only plain ASCII controls TAB/LF are admitted.
 * Fixed ranges never consult ICU, Intl, locale or Unicode property escapes.
 * Any character outside this profile makes the WHOLE source unchanged.
 */
export function fixedSafeCharacterProfile(text: string): boolean {
  const punctuation = new Set('。！？“”‘’「」『』（）【】《》〈〉，、；：…—　');
  for (const character of text) {
    const cp = character.codePointAt(0)!;
    if (
      cp === 0x09 ||
      cp === 0x0a ||
      (cp >= 0x20 && cp <= 0x7e) ||
      (cp >= 0x3400 && cp <= 0x4dbf) ||
      (cp >= 0x4e00 && cp <= 0x9fff) ||
      (cp >= 0xff10 && cp <= 0xff19) ||
      (cp >= 0xff21 && cp <= 0xff3a) ||
      (cp >= 0xff41 && cp <= 0xff5a) ||
      punctuation.has(character)
    )
      continue;
    return false;
  }
  return true;
}
/** UTF-16 offsets are derived only after whole Unicode scalars, never by adding
 * scalar counts to a UTF-16 index. No strings/HTML/DOM nodes are generated. */
export function formatSource(value: unknown): FormattingOutcome {
  const source = checkSource(value);
  if (!source) return { kind: 'invalid_source' };
  if (!eligible(source)) return { kind: 'ineligible' };
  const text = source.text;
  if (!fixedSafeCharacterProfile(text))
    return { kind: 'plan', plan: unchanged(text, 'unsupported_unicode') };
  if (structureSensitive(text))
    return { kind: 'plan', plan: unchanged(text, 'structure_sensitive') };
  const stack: string[] = [];
  const lines: {
    startScalar: number;
    endScalar: number;
    boundaries: { scalar: number; offset: number }[];
  }[] = [];
  let scalar = 0,
    offset = 0,
    startScalar = 0;
  let boundaries: { scalar: number; offset: number }[] = [];
  // Iteration and stack depth are bounded by the reviewed source scalar limit.
  for (const character of text) {
    scalar++;
    offset += character.length;
    if (character === '"') {
      if (stack.at(-1) === '"') stack.pop();
      else stack.push('"');
    } else if (opening.has(character)) {
      stack.push(opening.get(character)!);
    } else if (closing.has(character)) {
      if (stack.pop() !== character)
        return { kind: 'plan', plan: unchanged(text, 'structure_sensitive') };
    }
    const nextCodePoint = text.codePointAt(offset);
    const nextCharacter =
      nextCodePoint === undefined ? '' : String.fromCodePoint(nextCodePoint);
    if (
      terminal.has(character) &&
      stack.length === 0 &&
      !terminal.has(nextCharacter)
    )
      boundaries.push({ scalar, offset });
    if (character === '\n') {
      lines.push({ startScalar, endScalar: scalar - 1, boundaries });
      startScalar = scalar;
      boundaries = [];
    }
  }
  if (stack.length)
    return { kind: 'plan', plan: unchanged(text, 'structure_sensitive') };
  lines.push({ startScalar, endScalar: scalar, boundaries });
  const cuts: number[] = [];
  for (const line of lines) {
    let cursor = line.startScalar;
    while (true) {
      const candidates = line.boundaries.filter(
        ({ scalar: end }) =>
          end - cursor >= LIMITS.minimumScalars &&
          end - cursor <= LIMITS.maximumScalars &&
          line.endScalar - end >= LIMITS.minimumTailScalars,
      );
      if (!candidates.length) break;
      candidates.sort(
        (a, b) =>
          Math.abs(a.scalar - cursor - LIMITS.targetScalars) -
            Math.abs(b.scalar - cursor - LIMITS.targetScalars) ||
          a.scalar - b.scalar,
      );
      const selected = candidates[0]!;
      cuts.push(selected.offset);
      cursor = selected.scalar;
    }
  }
  if (!cuts.length)
    return { kind: 'plan', plan: unchanged(text, 'no_safe_boundary') };
  const starts = [0, ...cuts],
    ends = [...cuts, text.length];
  const plan: ReadingPlan = {
    version: 1,
    formatter: FORMATTER,
    offsetEncoding: 'utf16',
    mode: 'grouped',
    reason: 'grouped',
    spans: starts.map((start, index) => ({ start, end: ends[index]! })),
  };
  return { kind: 'plan', plan };
}
/** Storage input is capped serialized JSON, avoiding unbounded plan arrays and
 * accessor-bearing input. Exact recomputation rejects gaps, overlap, reordering,
 * surrogate cuts, invented semantic boundaries and unsupported properties. */
export function decodeExactPlan(
  source: SourceSnapshot,
  json: unknown,
): ReadingPlan | null {
  const parsed = planSchema.safeParse(
    decodeBoundedJson(json, LIMITS.maximumPlanBytes),
  );
  if (!parsed.success) return null;
  const expected = formatSource(source);
  if (expected.kind !== 'plan') return null;
  return JSON.stringify(parsed.data) === JSON.stringify(expected.plan)
    ? parsed.data
    : null;
}
export function sourceSlices(
  source: SourceSnapshot,
  planJson: unknown,
): string[] | null {
  const plan = decodeExactPlan(source, planJson);
  return (
    plan?.spans.map(({ start, end }) => source.text.slice(start, end)) ?? null
  );
}
