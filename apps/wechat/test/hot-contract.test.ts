import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeHotIntent,
  decodeHotPage,
  hotCursor,
  hotRanges,
} from '../src/community/hot-contract';
import { post, spaceId } from './community-helpers';
import { hotPage, hotToken } from './hot-helpers';

test('hot intent is a frozen explicit-space contract with six ranges and day default; no inherited filters', () => {
  assert.deepEqual(decodeHotIntent({ spaceId }), { spaceId, range: 'day' });
  assert.deepEqual(
    hotRanges.map((range) => range.key),
    ['day', 'week', 'month', 'half_year', 'year', 'history'],
  );
  for (const { key: range } of hotRanges) {
    const intent = decodeHotIntent({ spaceId, range });
    assert.deepEqual(intent, { spaceId, range });
    assert.ok(Object.isFrozen(intent));
  }
  for (const input of [
    null,
    {},
    [],
    { spaceId: [spaceId] },
    { spaceId: 1 },
    { spaceId: 'ABCDEF01-ABCD-4ABC-8ABC-ABCDEF012345' },
    { spaceId, range: undefined },
    { spaceId, range: 'all' },
    { spaceId, range: ['day'] },
    { spaceId, range: null },
    ...[
      'scope',
      'campusId',
      'category',
      'tradingSubtype',
      'q',
      'accountId',
      'cursor',
      'score',
      'limit',
      'choose',
      'formula',
    ].map((key) => ({ spaceId, [key]: 'x' })),
  ])
    assert.throws(() => decodeHotIntent(input));
});
test('opaque hot cursors reject noncanonical bytes, readable positions and padding', () => {
  for (let n = 0; n < 256; n++) assert.ok(hotCursor(hotToken(n)));
  for (const value of [
    null,
    '',
    'x'.repeat(43),
    'A'.repeat(42) + 'B',
    hotToken() + '=',
    hotToken() + '\n',
    'A'.repeat(44),
    { score: '1.0000', id: spaceId },
  ])
    assert.equal(hotCursor(value), false);
});
test('strict current response union permits sparse/gated states but never private extras or duplicate IDs', () => {
  for (const continuation of [
    'end',
    'login_required',
    'phone_verification_required',
  ] as const) {
    for (const items of [[], [post({ text: '"<script>_%\\😀İ' })]]) {
      const page = hotPage({ items, continuation });
      assert.deepEqual(decodeHotPage(page), page);
      assert.throws(() => decodeHotPage({ ...page, nextCursor: hotToken() }));
    }
  }
  for (const continuation of ['more', 'scan_pending'] as const) {
    const page = hotPage({ continuation, nextCursor: hotToken() });
    assert.deepEqual(decodeHotPage(page), page);
    assert.throws(() => decodeHotPage({ ...page, nextCursor: null }));
  }
  assert.deepEqual(
    decodeHotPage(
      hotPage({
        items: [],
        continuation: 'scan_pending',
        nextCursor: hotToken(),
      }),
    ).items,
    [],
  );
  for (const patch of [
    ...[
      'score',
      'rank',
      'total',
      'hiddenCount',
      'certificate',
      'computedAt',
      'componentVersion',
      'processedHead',
      'actorContributions',
      'population',
    ].map((key) => ({ [key]: 0 })),
    { continuation: 'available' },
    { continuation: 'more', items: [], nextCursor: hotToken() },
    { items: [post(), post()] },
    { items: Array.from({ length: 11 }, () => post()) },
    { items: [{ ...post(), score: '1.0000' }] },
    {
      items: [{ ...post(), author: { ...post().author, accountId: spaceId } }],
    },
    { items: [{ ...post(), viewer: { ...post().viewer, blockedCount: 1 } }] },
    { items: [post({ publishedAt: null as never })] },
  ])
    assert.throws(() => decodeHotPage({ ...hotPage(), ...patch }));
  // Independent responses may legitimately contain the same moved post.
  assert.deepEqual(
    decodeHotPage(hotPage()).items,
    decodeHotPage(hotPage()).items,
  );
});
