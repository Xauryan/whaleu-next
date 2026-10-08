import assert from 'node:assert/strict';
import { test } from 'node:test';
import { searchMatches } from '../src/community/search/matching.js';
import { searchSnippet } from '../src/community/search/snippet.js';
import { searchQuerySchema } from '../src/community/search/contracts.js';
import {
  searchCursorScope,
  searchAnchorFollows,
} from '../src/community/search/cursor.js';
const spaceId = '00000000-0000-4000-8000-000000000001';

test('snippet exact folded offsets preserve contextual sigma, expansion, astral and literal punctuation', () => {
  for (const [body, q, matched] of [
    ['prefix İ suffix', 'i\u0307', 'İ'],
    ['prefix İ suffix', '\u0307', 'İ'],
    ['ΟΣ', 'ος', 'ΟΣ'],
    ['a😀鲸鱼b', '😀鲸', '😀鲸'],
    ['100%_\\', '%_\\', '%_\\'],
    ['<script>WHALE</script>', 'whale', 'WHALE'],
    ['zero 0 text', '0', '0'],
  ]) {
    assert.equal(searchMatches(body!, q!), true);
    const result = searchSnippet(body!, q!);
    assert.equal(result.segments.map((s) => s.text).join(''), body);
    assert.equal(
      result.segments
        .filter((s) => s.matched)
        .map((s) => s.text)
        .join(''),
      matched,
    );
    assert.equal(result.truncatedBefore, false);
    assert.equal(result.truncatedAfter, false);
  }
  assert.equal(searchMatches('ΟΣ', 'οσ'), false);
  assert.throws(() => searchSnippet('ΟΣ', 'οσ'));
});

test('snippet is bounded original source around the first real match, including query expansion and many matches', () => {
  for (const [body, q] of [
    ['😀'.repeat(400) + '关键词' + '鲸'.repeat(400), '关键词'],
    ['a'.repeat(500), 'a'],
    ['i\u0307'.repeat(250), 'İ'.repeat(200)],
  ]) {
    const result = searchSnippet(body!, q!);
    const actual = result.segments.map((s) => s.text).join('');
    assert.equal([...actual].length, 240);
    assert.ok(body!.includes(actual));
    assert.ok(result.segments.some((s) => s.matched));
    assert.equal(result.truncatedAfter, true);
    for (const segment of result.segments) assert.ok(segment.text.length > 0);
  }
  assert.equal(
    searchSnippet('a'.repeat(300) + '鲸', '鲸').truncatedBefore,
    true,
  );
});

test('type, own-time interval and topic filters strictly parse and bind cursor scope', () => {
  const parsed = searchQuerySchema.parse({
    spaceId,
    q: '0',
    type: 'reply',
    postId: spaceId,
    from: '2026-10-08T00:00:00Z',
    to: '2026-10-08T00:00:00.000001Z',
  });
  assert.equal(parsed.from, '2026-10-08T00:00:00.000000Z');
  for (const patch of [
    { type: 'semantic' },
    { sort: 'relevance' },
    { type: ['reply'] },
    { from: '2026-10-08' },
    { from: '0000-01-01T00:00:00Z' },
    { from: '2026-10-08T00:00:00+00:00' },
    { from: '2026-10-08T00:00:00.0000001Z' },
    { to: '2026-10-08T00:00:00Z' },
    { to: '2026-10-07T00:00:00Z' },
    { postId: 'bad' },
    { postId: [spaceId] },
  ])
    assert.equal(
      searchQuerySchema.safeParse({
        spaceId,
        q: '0',
        from: '2026-10-08T00:00:00Z',
        ...patch,
      }).success,
      false,
      JSON.stringify(patch),
    );
  const original = searchQuerySchema.parse({ spaceId, q: '0' }),
    hash = searchCursorScope(original, null);
  for (const patch of [
    { type: 'post' as const },
    { postId: spaceId },
    { from: '2026-10-08T00:00:00.000000Z' },
    { to: '2026-10-09T00:00:00.000000Z' },
  ])
    assert.notEqual(searchCursorScope({ ...original, ...patch }, null), hash);
});

test('exact timestamp kind order disambiguates identical cross-table UUIDs', () => {
  const anchor = { at: '2026-10-08T00:00:00.123456Z', id: spaceId };
  assert.equal(
    searchAnchorFollows(
      { ...anchor, kind: 'comment' },
      { ...anchor, kind: 'post' },
    ),
    true,
  );
  assert.equal(
    searchAnchorFollows(
      { ...anchor, kind: 'reply' },
      { ...anchor, kind: 'comment' },
    ),
    true,
  );
  assert.equal(
    searchAnchorFollows(
      { ...anchor, kind: 'post' },
      { ...anchor, kind: 'reply' },
    ),
    false,
  );
});

test('snippet parser never emits lone surrogates when clipping at either source boundary', () => {
  const body = '😀'.repeat(300) + '鲸😀鲸' + '🐋'.repeat(300);
  const result = searchSnippet(body, '鲸😀鲸');
  const text = result.segments.map((s) => s.text).join('');
  assert.equal(/[\ud800-\udfff]/u.test(text), false);
  assert.equal([...text].length, 240);
  assert.deepEqual(
    result.segments.filter((s) => s.matched).map((s) => s.text),
    ['鲸😀鲸'],
  );
});
