/* eslint-disable no-control-regex -- Exact legacy protected-segment U+001A sentinel. */
import { legacyDigitClass, legacyLetterNumberClass } from './legacy-unicode.js';
import { legacyHomeLowercase } from './legacy-lowercase.js';
import { isUtf8 } from 'node:buffer';
import { decodeLegacyHtmlEntities, trimLegacyHomeText } from './php-text.js';

const emphasisPatterns = [
  '\\*\\*\\*',
  '___',
  '\\*\\*',
  '__',
  '~~',
  '\\*',
  '_',
].map((delimiter) => {
  const boundary = delimiter.includes('_');
  const pattern =
    (boundary ? '(?<!' + legacyLetterNumberClass + ')' : '') +
    delimiter +
    '(?=[^\\p{Z}\\t\\n\\v\\f\\r\\u0085\\u180e])([\\s\\S]+?)(?<=[^\\p{Z}\\t\\n\\v\\f\\r\\u0085\\u180e])' +
    delimiter +
    (boundary ? '(?!' + legacyLetterNumberClass + ')' : '');
  return new RegExp(pattern, 'gu');
});

/** Source-order port of ContentPlainTextService.php at fixed4494e36, blob
 * 5fd62bacc1507c690db078b4990616c1bc842f9f. This intentionally mirrors that
 * converter, not CommonMark, a native renderer, source admission or sanitizer.
 * Regex whitespace follows PHP /u PCRE Unicode semantics (including U+180E);
 * dot excludes LF only. The caller must pass already-authorized source text. */
export function legacyHomePlainText(
  content: string,
  format: 'plain' | 'markdown',
  includeLinkTargets = true,
): string {
  if (format !== 'markdown') return content;
  const references = new Map<string, string>();
  const body: { type: 'plain' | 'code' | 'inline'; line: string }[] = [];
  let fence: { character: string; length: number } | null = null;
  for (let line of content.replace(/\r\n|\r/gu, '\n').split('\n')) {
    const match = /^ {0,3}(`{3,}|~{3,})([^\n]*)$/u.exec(line);
    if (match) {
      const spelling = match[1]!;
      if (fence === null) {
        fence = { character: spelling[0]!, length: spelling.length };
        body.push({ type: 'plain', line: '' });
        continue;
      }
      if (
        spelling[0] === fence.character &&
        spelling.length >= fence.length &&
        trimLegacyHomeText(match[2]!) === ''
      ) {
        fence = null;
        body.push({ type: 'plain', line: '' });
        continue;
      }
    }
    if (fence !== null) {
      body.push({ type: 'code', line });
      continue;
    }
    const definition =
      /^ {0,3}\[([^\]]+)\]:[\p{Z}\t\n\v\f\r\u0085\u180e]*([^\p{Z}\t\n\v\f\r\u0085\u180e]+)(?:[\p{Z}\t\n\v\f\r\u0085\u180e]+["'][^\n]*)?$/u.exec(
        line,
      );
    if (definition) {
      references.set(
        legacyHomeLowercase(trimLegacyHomeText(definition[1]!)),
        definition[2]!.replace(/^[<>]+|[<>]+$/gu, ''),
      );
      continue;
    }
    if (
      /^(?: {0,3}(?:[-*_][\p{Z}\t\n\v\f\r\u0085\u180e]*){3,}|[\p{Z}\t\n\v\f\r\u0085\u180e]*[=-]{2,}|[\p{Z}\t\n\v\f\r\u0085\u180e]*\|?[\p{Z}\t\n\v\f\r\u0085\u180e]*:?-{3,}:?[\p{Z}\t\n\v\f\r\u0085\u180e]*(?:\|[\p{Z}\t\n\v\f\r\u0085\u180e]*:?-{3,}:?[\p{Z}\t\n\v\f\r\u0085\u180e]*)*\|?)$/u.test(
        line,
      )
    )
      continue;
    line = line.replace(/^ {0,3}(?:>[\p{Z}\t\n\v\f\r\u0085\u180e]*)+/u, '');
    line = line.replace(
      /^ {0,3}#{1,6}(?:[\p{Z}\t\n\v\f\r\u0085\u180e]+|$)([^\n]*?)(?:[\p{Z}\t\n\v\f\r\u0085\u180e]+#+[\p{Z}\t\n\v\f\r\u0085\u180e]*)?$/u,
      '$1',
    );
    line = line.replace(
      /^[\p{Z}\t\n\v\f\r\u0085\u180e]*[-+*][\p{Z}\t\n\v\f\r\u0085\u180e]+\[([ xX])\][\p{Z}\t\n\v\f\r\u0085\u180e]*/u,
      '• ',
    );
    line = line.replace(
      /^[\p{Z}\t\n\v\f\r\u0085\u180e]*[-+*][\p{Z}\t\n\v\f\r\u0085\u180e]+/u,
      '• ',
    );
    line = line.replace(
      new RegExp(
        String.raw`^[\p{Z}\t\n\v\f\r\u0085\u180e]*(${legacyDigitClass}+)[.)][\p{Z}\t\n\v\f\r\u0085\u180e]+`,
        'u',
      ),
      '$1. ',
    );
    if (
      /^[\p{Z}\t\n\v\f\r\u0085\u180e]*\|[^\n]*\|[\p{Z}\t\n\v\f\r\u0085\u180e]*$/u.test(
        line,
      )
    ) {
      // trim then byte-slice in PHP; for ordinary table edges the bytes are '|'.
      // Non-ASCII whitespace may remain after trim, so model that byte slicing
      // exactly rather than silently taking a Unicode scalar from either edge.
      const bytes = Buffer.from(trimLegacyHomeText(line), 'utf8');
      const sliced = bytes.subarray(1, -1);
      // Legacy preg_replace(/u) returns null for invalid UTF-8, which the
      // subsequent implode treats as an empty line. Do not insert U+FFFD.
      line = isUtf8(sliced) ? sliced.toString('utf8') : '';
      line = line.replace(
        /(?<!\\)[\p{Z}\t\n\v\f\r\u0085\u180e]*\|[\p{Z}\t\n\v\f\r\u0085\u180e]*/gu,
        ' / ',
      );
    }
    body.push({ type: 'inline', line });
  }
  const result: string[] = [];
  let inlineLines: string[] = [];
  const flush = () => {
    if (inlineLines.length)
      result.push(
        inline(inlineLines.join('\n'), references, includeLinkTargets),
      );
    inlineLines = [];
  };
  for (const { type, line } of body) {
    if (type === 'inline') inlineLines.push(line);
    else {
      flush();
      result.push(line);
    }
  }
  flush();
  return trimLegacyHomeText(result.join('\n').replace(/\n{3,}/gu, '\n\n'));
}

function inline(
  source: string,
  references: ReadonlyMap<string, string>,
  includeLinkTargets: boolean,
): string {
  const protectedText = new Map<string, string>();
  const save = (text: string): string => {
    const key = '\u001a' + protectedText.size + '\u001a';
    protectedText.set(key, text);
    return key;
  };
  let line = source.replace(
    /(`+)([^\n]+?)\1/gu,
    (_match, _ticks: string, text: string) => save(text),
  );
  line = line.replace(/\\([\\`*_{}[\]()#+.!|>~-])/gu, (_match, text: string) =>
    save(text),
  );
  line = line.replace(
    /(!?)\[([^\]]*)\]\(((?:[^()\p{Z}\t\n\v\f\r\u0085\u180e]|\([^()]*\))+)(?:[\p{Z}\t\n\v\f\r\u0085\u180e]+["'][^"']*["'])?\)/gu,
    (_match, image: string, label: string, target: string) => {
      const url = target.replace(/^[<>]+|[<>]+$/gu, '');
      if (image === '!' || !includeLinkTargets) return label;
      return label === url ? save(url) : label + '（' + save(url) + '）';
    },
  );
  line = line.replace(
    /(!?)\[([^\]]+)\](?:\[([^\]]*)\])?/gu,
    (match, image: string, label: string, ref: string | undefined) => {
      const key = legacyHomeLowercase(
        trimLegacyHomeText(ref !== undefined && ref !== '' ? ref : label),
      );
      const target = references.get(key);
      if (target === undefined) return match;
      return image === '!' || !includeLinkTargets
        ? label
        : label + '（' + save(target) + '）';
    },
  );
  line = line.replace(
    /<((?:https?:\/\/|mailto:)[^>]+)>/gu,
    (_match, url: string) => save(url),
  );
  // U+001A is the exact legacy protected-segment sentinel.
  line = line.replace(
    /https?:\/\/[^\p{Z}\t\n\v\f\r\u0085\u180e<>\u001a]+/gu,
    (url) => save(url),
  );
  for (const pattern of emphasisPatterns) line = line.replace(pattern, '$1');
  line = decodeLegacyHtmlEntities(line);
  // PHP strtr(array) performs one longest-key-first pass, never recursively
  // interpreting protected values or tokens introduced by an earlier value.
  let result = '';
  for (let offset = 0; offset < line.length;) {
    if (line.charCodeAt(offset) === 0x1a) {
      const end = line.indexOf('\u001a', offset + 1);
      if (end !== -1) {
        const key = line.slice(offset, end + 1);
        const value = protectedText.get(key);
        if (value !== undefined) {
          result += value;
          offset = end + 1;
          continue;
        }
      }
    }
    // An unknown token does not consume its closing sentinel: it may also
    // begin a real key. PHP strtr advances only one byte on an unknown match.
    result += line[offset]!;
    offset++;
  }
  return result;
}
