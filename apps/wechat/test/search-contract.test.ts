import {
  searchPost as post,
  searchTradingPost as tradingPost,
} from './search-helpers';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canonicalSearchQuery,
  decodeSearchIntent,
  decodeSearchPage,
  searchCursor,
} from '../src/community/search-contract';
import { decodeSearchRoute } from '../src/pages/community-search/controller';
import { spaceId, tradingView } from './community-helpers';
import { searchPage, searchRoute, searchToken } from './search-helpers';

test('query canonicalization preserves literal Unicode/text and checks raw controls before trim', () => {
  for (const q of [
    '0',
    '%',
    '_',
    '\\',
    '"<script>"',
    '校园日常',
    '👨‍👩‍👧',
    'İ Σ ß SS',
    'é é',
    'A\nB',
    'a\tb',
  ])
    assert.equal(canonicalSearchQuery(q), q);
  assert.equal(
    canonicalSearchQuery('\u2003Hello\r\n校园\u00a0'),
    'Hello\n校园',
  );
  assert.equal(canonicalSearchQuery('😀'.repeat(200)), '😀'.repeat(200));
  for (const q of [
    '',
    ' \n\t',
    'a'.repeat(201),
    '😀'.repeat(201),
    '\ud800',
    '\udfff',
    'a\rb',
    '\ra',
    '\va',
    '\fa',
    'a\x00',
    '\x7fa',
    '\x85a',
    null,
    0,
    ['a'],
  ])
    assert.throws(() => canonicalSearchQuery(q));
});
test('frozen intents and navigation scopes reject unknown, malformed, coerced and unsupported filters', () => {
  const intent = decodeSearchIntent({ spaceId, q: ' a\r\nb ' });
  assert.deepEqual(intent, { spaceId, q: 'a\nb' });
  assert.ok(Object.isFrozen(intent));
  for (const patch of [
    { spaceId: 1 },
    { q: ['x'] },
    { category: 'all' },
    { category: undefined },
    { tradingSubtype: 'shuma' },
    { category: 'trading', tradingSubtype: undefined },
    { category: 'trading', tradingSubtype: 'bad' },
    { limit: 5 },
    { accountId: spaceId },
  ])
    assert.throws(() => decodeSearchIntent({ spaceId, q: 'x', ...patch }));
  assert.deepEqual(decodeSearchRoute(searchRoute), searchRoute);
  for (const value of [
    {},
    { ...searchRoute, q: 'private query' },
    { ...searchRoute, token: 'secret' },
    { ...searchRoute, post: post() },
    { ...searchRoute, category: ['discussion'] },
    { ...searchRoute, tradingSubtype: 'shuma' },
  ])
    assert.throws(() => decodeSearchRoute(value));
});
test('opaque search refs require canonical 32-byte unpadded base64url', () => {
  for (let n = 0; n < 256; n++) assert.ok(searchCursor(searchToken(n)));
  for (const value of [
    null,
    '',
    'opaque_next',
    'x'.repeat(43),
    'A'.repeat(42) + 'B',
    searchToken() + '=',
    searchToken() + '\n',
    'A'.repeat(44),
    { after: spaceId },
  ])
    assert.equal(searchCursor(value), false);
});
test('strict lightweight search page union preserves approved author display and plain text', () => {
  for (const continuation of [
    'end',
    'login_required',
    'phone_verification_required',
  ] as const) {
    for (const items of [[], [post({ text: '"<script>_%\\😀İ' })]]) {
      const page = searchPage({ items, continuation });
      assert.deepEqual(decodeSearchPage(page), page);
      assert.throws(() =>
        decodeSearchPage({ ...page, nextCursor: searchToken() }),
      );
    }
  }
  for (const continuation of ['more', 'scan_pending'] as const) {
    const page = searchPage({ continuation, nextCursor: searchToken() });
    assert.deepEqual(decodeSearchPage(page), page);
    assert.throws(() => decodeSearchPage({ ...page, nextCursor: null }));
  }
  assert.deepEqual(
    decodeSearchPage(
      searchPage({
        items: [],
        continuation: 'scan_pending',
        nextCursor: searchToken(),
      }),
    ).items,
    [],
  );
  const resolvedUrgent = tradingPost({
    trading: tradingView({ urgency: 'urgent', resolution: 'resolved' }),
  });
  assert.deepEqual(
    decodeSearchPage(searchPage({ items: [resolvedUrgent] })).items,
    [resolvedUrgent],
  );
  for (const patch of [
    { total: 0 },
    { totalStatus: 'known' },
    { query: 'x' },
    { scanCount: 128 },
    { continuation: 'available' },
    { continuation: 'more', items: [], nextCursor: searchToken() },
    { items: [post(), post()] },
    { items: Array.from({ length: 11 }, () => post()) },
    { items: [post({ publishedAt: null as never })] },
    { items: [{ ...post(), privateAuthorId: spaceId }] },
  ])
    assert.throws(() => decodeSearchPage({ ...searchPage(), ...patch }));
});

test('aggregate intents and public routes are a frozen strict union independent of a browse campus', () => {
  for (const scope of ['all', 'regional', 'global'] as const) {
    const intent = decodeSearchIntent({ scope, q: '  A\r\n校园  ' });
    assert.deepEqual(intent, { scope, q: 'A\n校园' });
    assert.ok(Object.isFrozen(intent));
    for (const route of [
      { scope },
      { scope, campusId: searchRoute.campusId },
    ]) {
      const decoded = decodeSearchRoute(route);
      assert.deepEqual(decoded, route);
      assert.ok(Object.isFrozen(decoded));
    }
  }
  const filter = {
    scope: 'regional',
    category: 'trading',
    tradingSubtype: 'shuma',
  };
  assert.deepEqual(decodeSearchIntent({ ...filter, q: 'x' }), {
    ...filter,
    q: 'x',
  });
  assert.deepEqual(decodeSearchRoute(filter), filter);
  for (const value of [
    { q: 'x' },
    { scope: undefined, q: 'x' },
    { scope: null, q: 'x' },
    { scope: ['all'], q: 'x' },
    { scope: 'related', q: 'x' },
    { scope: 'ALL', q: 'x' },
    { scope: 'all', spaceId, q: 'x' },
    { scope: 'regional', spaceId, q: 'x' },
    { scope: 'global', spaceId, q: 'x' },
    { scope: 'all', spaceId: undefined, q: 'x' },
    { scope: 'all', category: 'discussion', q: 'x' },
    { scope: 'all', category: undefined, q: 'x' },
    { scope: 'global', category: 'discussion', q: 'x' },
    { scope: 'global', tradingSubtype: undefined, q: 'x' },
    { scope: 'regional', category: 'all', q: 'x' },
    { scope: 'regional', category: ['trading'], q: 'x' },
    { scope: 'regional', tradingSubtype: 'shuma', q: 'x' },
    {
      scope: 'regional',
      category: 'trading',
      tradingSubtype: ['shuma'],
      q: 'x',
    },
    { scope: 'all', q: 'x', campusId: searchRoute.campusId },
    { scope: 'all', q: 'x', membershipFingerprint: 'private' },
    { scope: 'all', q: 'x', spaceIds: [spaceId] },
  ])
    assert.throws(() => decodeSearchIntent(value));
  for (const value of [
    { spaceId },
    { scope: 'all', campusId: undefined },
    { scope: 'all', campusId: 'invalid' },
    { scope: 'all', campusId: [searchRoute.campusId] },
    { scope: 'all', q: 'private' },
    { scope: 'all', cursor: searchToken() },
    { scope: 'all', intent: { q: 'private' } },
    { scope: 'all', spaceId },
    { scope: 'global', category: 'discussion' },
    { scope: ['regional'] },
  ])
    assert.throws(() => decodeSearchRoute(value));
});
