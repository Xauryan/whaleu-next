import { ApplicationError } from '../../http/application-error.js';
import type { SearchSnippet } from './contracts.js';
import { requireSearchMatcherRuntime } from './matching.js';

export const SEARCH_SNIPPET_CODEPOINTS = 240;
export const SEARCH_SUMMARY_CODEPOINTS = 80;

/** Matches the exact whole-string lowercase matcher, including contextual Greek
 * sigma and expanding İ. Folded UTF-16 offsets map back to complete original
 * codepoints; never lower/normalize/HTML-encode returned source text. */
export function searchSnippet(body: string, query: string): SearchSnippet {
  requireSearchMatcherRuntime();
  const original = [...body];
  const folded = body.toLowerCase();
  const needle = query.toLowerCase();
  if (!needle) throw new ApplicationError('COMMUNITY_UNAVAILABLE');
  const offsets = [0];
  for (const character of original)
    offsets.push(offsets.at(-1)! + character.toLowerCase().length);
  // Default Unicode lowercasing has only length-preserving contextual changes.
  // A future Unicode change must not silently corrupt source mapping.
  if (offsets.at(-1) !== folded.length)
    throw new ApplicationError('COMMUNITY_UNAVAILABLE');
  const ranges: { start: number; end: number }[] = [];
  let sourceCursor = 0;
  let index = folded.indexOf(needle);
  while (index >= 0) {
    const endOffset = index + needle.length;
    while (offsets[sourceCursor + 1]! <= index) sourceCursor++;
    const start = sourceCursor;
    let end = start + 1;
    while (offsets[end]! < endOffset) end++;
    const last = ranges.at(-1);
    if (last && start < last.end) last.end = Math.max(last.end, end);
    else ranges.push({ start, end });
    index = folded.indexOf(needle, endOffset);
  }
  const first = ranges[0];
  if (!first) throw new ApplicationError('COMMUNITY_UNAVAILABLE');
  const start = Math.max(
    0,
    first.start -
      Math.max(
        0,
        Math.min(40, SEARCH_SNIPPET_CODEPOINTS - (first.end - first.start)),
      ),
  );
  const end = Math.min(original.length, start + SEARCH_SNIPPET_CODEPOINTS);
  const segments: SearchSnippet['segments'] = [];
  let cursor = start;
  for (const range of ranges) {
    if (range.start >= end) break;
    if (range.end <= start) continue;
    const left = Math.max(start, range.start),
      right = Math.min(end, range.end);
    if (left > cursor)
      segments.push({
        text: original.slice(cursor, left).join(''),
        matched: false,
      });
    segments.push({
      text: original.slice(left, right).join(''),
      matched: true,
    });
    cursor = right;
  }
  if (cursor < end)
    segments.push({
      text: original.slice(cursor, end).join(''),
      matched: false,
    });
  return {
    segments,
    truncatedBefore: start > 0,
    truncatedAfter: end < original.length,
  };
}
