/** Text-only native projection. API identity/source-hash validation belongs to the
 * source contract decoder, before a SourcePresentation reaches this module.
 * Nothing here produces a reading plan, HTML, URLs, editor values or mutations.
 */
import type { SourcePresentation } from './text-source-read-contract';
import type { TextSourceDescriptor } from './text-source-contract';

export type SourceTextRunStyle = 'plain' | 'emphasis' | 'strong' | 'code';
export interface SourceTextRun {
  readonly key: number;
  readonly text: string;
  readonly style: SourceTextRunStyle;
}
export interface SourceTextBlock {
  readonly key: number;
  readonly kind: 'paragraph' | 'heading' | 'list' | 'quote' | 'code' | 'blank';
  readonly level: number;
  readonly marker: string;
  readonly runs: readonly SourceTextRun[];
}
export interface SourceTextRender {
  /** The exact supplied source, never a serialization of rendered blocks. */
  readonly rawSource: string;
  readonly mode: 'plain' | 'markdown' | 'formatted' | 'unavailable';
  readonly blocks: readonly SourceTextBlock[];
  readonly canToggleSource: boolean;
  readonly fallback: 'none' | 'limit' | 'invalid-plan' | 'invalid-input';
}
export interface SourceTextRenderInput {
  readonly source?: unknown;
  readonly descriptor?: unknown;
  /** Must have been decoded by the API source contract. Authoritative if set. */
  readonly presentation?: SourcePresentation | null;
}

/** Bounds parsing, not the original source: oversized input stays literal. */
export const SOURCE_TEXT_PREVIEW_LIMITS = Object.freeze({
  utf16Units: 10_000,
  blocks: 256,
  runs: 512,
});
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const keysAre = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));

function descriptor(value: unknown): TextSourceDescriptor | null {
  if (!record(value) || value.version !== 1) return null;
  if (value.format === 'markdown' && keysAre(value, ['version', 'format']))
    return { version: 1, format: 'markdown' };
  if (
    value.format === 'plain' &&
    (value.readingFormatting === 'auto' || value.readingFormatting === 'off') &&
    keysAre(value, ['version', 'format', 'readingFormatting'])
  )
    return {
      version: 1,
      format: 'plain',
      readingFormatting: value.readingFormatting,
    };
  return null;
}
function run(
  text: string,
  key = 0,
  style: SourceTextRunStyle = 'plain',
): SourceTextRun {
  return Object.freeze({ key, text, style });
}
function block(
  key: number,
  kind: SourceTextBlock['kind'],
  runs: readonly SourceTextRun[],
  level = 0,
  marker = '',
): SourceTextBlock {
  return Object.freeze({ key, kind, level, marker, runs: Object.freeze(runs) });
}
function result(
  rawSource: string,
  mode: SourceTextRender['mode'],
  blocks: readonly SourceTextBlock[],
  fallback: SourceTextRender['fallback'] = 'none',
): SourceTextRender {
  return Object.freeze({
    rawSource,
    mode,
    blocks: Object.freeze(blocks),
    canToggleSource: mode === 'markdown' || mode === 'formatted',
    fallback,
  });
}
function literal(
  text: string,
  fallback: SourceTextRender['fallback'] = 'none',
) {
  return result(
    text,
    'plain',
    text ? [block(0, 'paragraph', [run(text)])] : [],
    fallback,
  );
}
const unavailable = () => result('', 'unavailable', [], 'invalid-input');

function validBoundary(text: string, index: number): boolean {
  const before = text.charCodeAt(index - 1);
  const after = text.charCodeAt(index);
  return !(
    before >= 0xd800 &&
    before <= 0xdbff &&
    after >= 0xdc00 &&
    after <= 0xdfff
  );
}
/** Defense-in-depth geometry checks only; this does not authenticate a plan. */
function slices(
  text: string,
  plan: unknown,
): readonly SourceTextBlock[] | null {
  if (
    !record(plan) ||
    !keysAre(plan, [
      'version',
      'formatter',
      'offsetEncoding',
      'mode',
      'reason',
      'spans',
    ]) ||
    plan.version !== 1 ||
    plan.formatter !== 'plain-cjk-slices-v2' ||
    plan.offsetEncoding !== 'utf16' ||
    typeof plan.mode !== 'string' ||
    !['unchanged', 'grouped'].includes(plan.mode) ||
    typeof plan.reason !== 'string' ||
    ![
      'grouped',
      'no_safe_boundary',
      'structure_sensitive',
      'unsupported_unicode',
    ].includes(plan.reason) ||
    (plan.mode === 'grouped') !== (plan.reason === 'grouped') ||
    !Array.isArray(plan.spans) ||
    plan.spans.length < 1 ||
    plan.spans.length > 26 ||
    (plan.mode === 'unchanged' && plan.spans.length !== 1) ||
    (plan.mode === 'grouped' && plan.spans.length < 2)
  )
    return null;
  let cursor = 0;
  const blocks: SourceTextBlock[] = [];
  for (const span of plan.spans) {
    if (
      !record(span) ||
      !keysAre(span, ['start', 'end']) ||
      typeof span.start !== 'number' ||
      typeof span.end !== 'number' ||
      !Number.isSafeInteger(span.start) ||
      !Number.isSafeInteger(span.end) ||
      span.start !== cursor ||
      span.end <= span.start ||
      span.end > text.length ||
      !validBoundary(text, span.start) ||
      !validBoundary(text, span.end)
    )
      return null;
    blocks.push(
      block(span.start, 'paragraph', [run(text.slice(span.start, span.end))]),
    );
    cursor = span.end;
  }
  return cursor === text.length ? blocks : null;
}

/** Deliberately conservative first slice: unsupported HTML, links/images,
 * escaping and URL-bearing inline syntax remain entirely literal. No recursive
 * nesting, entity decoding, interpolation, linkification or image loading.
 */
function inline(text: string): readonly SourceTextRun[] {
  if (/[<>[\]\\]/.test(text) || /(?:[a-z][a-z0-9+.-]*:|www\.)/i.test(text))
    return [run(text)];
  const runs: SourceTextRun[] = [];
  let plainStart = 0;
  let cursor = 0;
  while (cursor < text.length) {
    const character = text[cursor]!;
    if (character !== '*' && character !== '_' && character !== '`') {
      cursor++;
      continue;
    }
    let width = 1;
    while (text[cursor + width] === character) width++;
    const start = cursor;
    cursor += width;
    if (width > (character === '`' ? 1 : 2)) continue;
    const token = character.repeat(width);
    const end = text.indexOf(token, cursor);
    if (
      end < 0 ||
      text[end + width] === character ||
      text[end - 1] === character
    )
      continue;
    const content = text.slice(cursor, end);
    if (
      !content ||
      (character !== '`' &&
        (/^\s|\s$/.test(content) || /[*_`]/.test(content))) ||
      (character === '_' &&
        (/[\p{L}\p{N}_]/u.test(text[start - 1] ?? '') ||
          /[\p{L}\p{N}_]/u.test(text[end + width] ?? '')))
    ) {
      // Nested/unsupported delimiter forms are literal as a whole.
      cursor = end + width;
      continue;
    }
    if (start > plainStart)
      runs.push(run(text.slice(plainStart, start), plainStart));
    runs.push(
      run(
        content,
        start,
        character === '`' ? 'code' : width === 2 ? 'strong' : 'emphasis',
      ),
    );
    cursor = end + width;
    plainStart = cursor;
  }
  if (plainStart < text.length || !runs.length)
    runs.push(run(text.slice(plainStart), plainStart));
  return runs;
}
interface Line {
  readonly text: string;
  readonly start: number;
}
function markdown(text: string): SourceTextRender {
  if (text.length > SOURCE_TEXT_PREVIEW_LIMITS.utf16Units)
    return literal(text, 'limit');
  const lines: Line[] = [];
  let start = 0;
  const endings = /\r\n|\r|\n/g;
  for (let match = endings.exec(text); match; match = endings.exec(text)) {
    lines.push({ text: text.slice(start, match.index), start });
    start = match.index + match[0].length;
    if (lines.length >= SOURCE_TEXT_PREVIEW_LIMITS.blocks)
      return literal(text, 'limit');
  }
  lines.push({ text: text.slice(start), start });
  const blocks: SourceTextBlock[] = [];
  let runCount = 0;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const fence = /^ {0,3}(`{3,}|~{3,})(?:[a-zA-Z0-9_-]{0,32})[ \t]*$/.exec(
      line.text,
    );
    if (fence) {
      let close = index + 1;
      while (close < lines.length) {
        const ending = /^ {0,3}(`+|~+)[ \t]*$/.exec(lines[close]!.text)?.[1];
        if (
          ending &&
          ending[0] === fence[1]![0] &&
          ending.length >= fence[1]!.length
        )
          break;
        close++;
      }
      if (close === lines.length) {
        // An incomplete fence is unknown syntax, not permission to drop text.
        blocks.push(
          block(line.start, 'paragraph', [run(text.slice(line.start))]),
        );
        runCount++;
        break;
      }
      blocks.push(
        block(line.start, 'code', [
          run(
            text.slice(lines[index + 1]!.start, lines[close]!.start),
            0,
            'code',
          ),
        ]),
      );
      runCount++;
      index = close;
      continue;
    }
    const heading = /^ {0,3}(#{1,6})[ \t]+(.*)$/.exec(line.text);
    const list = /^ {0,3}([-+*]|\d{1,9}[.)])[ \t]+(.+)$/.exec(line.text);
    const quote = /^ {0,3}> ?(.*)$/.exec(line.text);
    let rendered: SourceTextBlock;
    if (heading)
      rendered = block(
        line.start,
        'heading',
        inline(heading[2]!),
        heading[1]!.length,
      );
    else if (list)
      rendered = block(line.start, 'list', inline(list[2]!), 0, list[1]!);
    else if (quote && !quote[1]!.startsWith('>'))
      rendered = block(line.start, 'quote', inline(quote[1]!));
    else
      rendered = block(
        line.start,
        /^[ \t]*$/.test(line.text) ? 'blank' : 'paragraph',
        inline(line.text),
      );
    blocks.push(rendered);
    runCount += rendered.runs.length;
    if (runCount > SOURCE_TEXT_PREVIEW_LIMITS.runs)
      return literal(text, 'limit');
  }
  if (runCount > SOURCE_TEXT_PREVIEW_LIMITS.runs) return literal(text, 'limit');
  return result(text, 'markdown', blocks);
}

/** Read input always wins, including its failure. It cannot accidentally expose
 * an unrelated editor source. Missing editor descriptors default to plain auto;
 * neither a legacy record nor Markdown-looking text changes that default.
 */
export function renderTextSource(
  input: SourceTextRenderInput,
): SourceTextRender {
  try {
    if (!record(input)) return unavailable();
    if (input.presentation !== undefined && input.presentation !== null) {
      const read = input.presentation;
      if (
        !record(read) ||
        read.version !== 2 ||
        !keysAre(read, ['version', 'source', 'presentation']) ||
        !record(read.source) ||
        !record(read.presentation)
      )
        return unavailable();
      if (read.presentation.status === 'source') {
        if (!keysAre(read.presentation, ['status'])) return unavailable();
      } else if (read.presentation.status === 'formatted') {
        if (!keysAre(read.presentation, ['status', 'plan']))
          return unavailable();
      } else return unavailable();
      const source = read.source;
      if (source.version !== 1 || typeof source.text !== 'string')
        return unavailable();
      if (source.classification === 'legacyPlain') return literal(source.text);
      if (
        source.classification !== 'reviewedSource' ||
        source.sourceRevision !== 1 ||
        !record(source.textSource)
      )
        return unavailable();
      const syntax: Record<string, unknown> = { ...source.textSource };
      delete syntax.sourceHash;
      const format = descriptor(syntax);
      if (!format) return unavailable();
      if (format.format === 'markdown') return markdown(source.text);
      if (read.presentation.status === 'source') return literal(source.text);
      if (read.presentation.status !== 'formatted') return unavailable();
      if (
        format.readingFormatting !== 'auto' ||
        source.readingFormattingEligible !== true
      )
        return literal(source.text, 'invalid-plan');
      const blocks = slices(source.text, read.presentation.plan);
      if (!blocks) return literal(source.text, 'invalid-plan');
      return result(source.text, 'formatted', blocks);
    }
    if (typeof input.source !== 'string') return unavailable();
    const format =
      input.descriptor == null
        ? ({ version: 1, format: 'plain', readingFormatting: 'auto' } as const)
        : descriptor(input.descriptor);
    if (!format) return unavailable();
    return format.format === 'markdown'
      ? markdown(input.source)
      : literal(input.source);
  } catch {
    // Non-JSON inputs (e.g. throwing accessors) also fail closed, without logs.
    return unavailable();
  }
}
