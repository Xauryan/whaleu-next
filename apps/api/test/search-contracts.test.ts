import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { loadConfig } from '../src/config/config.js';
import { DatabaseService } from '../src/database/database.js';
import { configureHttp } from '../src/http/http.js';
import { searchQuerySchema } from '../src/community/search/contracts.js';
import type { SearchQuery } from '../src/community/search/contracts.js';
import {
  searchAnchorFollows,
  searchCursorScope,
  searchPositionSchema,
  SEARCH_ORDER_ID,
} from '../src/community/search/cursor.js';
import {
  SEARCH_MATCHER_ID,
  SEARCH_UNICODE_VERSION,
  searchMatches,
} from '../src/community/search/matching.js';
import { SearchService } from '../src/community/search/service.js';
import {
  SearchRepository,
  SEARCH_SCAN_BATCH,
} from '../src/community/search/repository.js';
import type { PoolClient } from 'pg';

const spaceId = randomUUID();
const valid = { spaceId, q: '海鲸' };

test('search validates canonical Unicode query without SQL-pattern restrictions or coercion', () => {
  assert.deepEqual(
    searchQuerySchema.parse({ ...valid, q: '\u3000\t0\r\n\u00a0' }),
    { spaceId, q: '0', type: 'all', limit: 10 },
  );
  for (const q of [
    '%',
    '_',
    '\\',
    "' OR 1=1",
    '<script>x</script>',
    '连续中文',
    '😀',
    'a\nb',
    'a\tb',
    'A\u0301',
  ])
    assert.equal(searchQuerySchema.parse({ ...valid, q }).q, q);
  assert.equal(
    searchQuerySchema.parse({ ...valid, q: ` ${'😀'.repeat(200)} ` }).q,
    '😀'.repeat(200),
  );
  assert.equal(searchQuerySchema.parse({ ...valid, q: 'a\r\nb' }).q, 'a\nb');
  for (const q of [
    '',
    ' \n\t\u3000',
    '😀'.repeat(201),
    'a'.repeat(201),
    '\ud800',
    '\udfff',
    'a\u0000',
    'a\u007f',
    'a\u0085',
    'a\u009f',
    '\ra',
    'a\r',
    '\va',
    'a\f',
    null,
    0,
    true,
    ['a'],
    {},
  ])
    assert.equal(
      searchQuerySchema.safeParse({ ...valid, q }).success,
      false,
      JSON.stringify(q),
    );
  for (const limit of ['0', '11', '01', '1.0', '1e1', ' 1', 1, ['1'], null])
    assert.equal(
      searchQuerySchema.safeParse({ ...valid, limit }).success,
      false,
    );
  for (let limit = 1; limit <= 10; limit++)
    assert.equal(
      searchQuerySchema.parse({ ...valid, limit: String(limit) }).limit,
      limit,
    );
  for (const patch of [
    { spaceId: [spaceId] },
    { q: ['one', 'two'] },
    { category: ['discussion'] },
    { tradingSubtype: 'shuma' },
    { category: 'unknown' },
    { accountId: randomUUID() },
    { choose: 'all' },
    { page: '1' },
    { q: undefined },
  ])
    assert.equal(
      searchQuerySchema.safeParse({ ...valid, ...patch }).success,
      false,
    );
  assert.equal(
    searchQuerySchema.parse({
      ...valid,
      category: 'trading',
      tradingSubtype: 'shuma',
    }).tradingSubtype,
    'shuma',
  );
  for (const cursor of [
    '',
    'A'.repeat(42),
    'A'.repeat(44),
    'A'.repeat(42) + 'B',
    'A'.repeat(42) + '=',
    ['A'.repeat(43)],
  ])
    assert.equal(
      searchQuerySchema.safeParse({ ...valid, cursor }).success,
      false,
    );
  assert.equal(
    searchQuerySchema.safeParse({
      ...valid,
      cursor: randomBytes(32).toString('base64url'),
    }).success,
    true,
  );
});

test('literal matcher is pinned locale-independent Unicode lowercase, without body normalization or full folding', () => {
  assert.equal(process.versions['unicode'], SEARCH_UNICODE_VERSION);
  assert.equal(SEARCH_MATCHER_ID, 'unicode-lower-substring-v1:17.0');
  for (const [body, q, expected] of [
    ['ABCabc', 'BcA', true],
    ['鲸鱼校园', '鱼校', true],
    ['你好世界', '好界', false],
    ['100%_\\', '%_\\', true],
    ['100abc', '%', false],
    ["quoted ' <script>", "' <SCRIPT>", true],
    ['😀🐋', '😀', true],
    ['a\nb', '\nb', true],
    ['a\r\nb', 'a\nb', false],
    ['İ', 'i\u0307', true],
    ['I', 'ı', false],
    ['ΟΣ', 'ος', true],
    ['ΟΣ', 'οσ', false],
    ['Straße', 'STRASSE', false],
    ['É', 'é', true],
    ['é', 'e\u0301', false],
    ['繁體', '繁体', false],
  ] as const)
    assert.equal(searchMatches(body, q), expected, JSON.stringify([body, q]));
});

test('search scope binds canonical query, every filter, matcher version, explicit guest and session identity', () => {
  const query = searchQuerySchema.parse(valid);
  const session = {
    accountId: randomUUID(),
    sessionId: randomUUID(),
    expiresAt: 1,
    refreshExpiresAt: 2,
  };
  const scope = searchCursorScope(query, session);
  assert.equal(
    searchCursorScope(
      searchQuerySchema.parse({ ...valid, q: ' 海鲸\r\n' }),
      session,
    ),
    scope,
  );
  for (const altered of [
    { ...query, q: 'other' },
    { ...query, spaceId: randomUUID() },
    { ...query, category: 'discussion' as const },
    {
      ...query,
      category: 'trading' as const,
      tradingSubtype: 'shuma' as const,
    },
    { ...query, limit: 9 },
  ])
    assert.notEqual(searchCursorScope(altered, session), scope);
  assert.notEqual(searchCursorScope(query, null), scope);
  assert.notEqual(
    searchCursorScope(query, { ...session, sessionId: randomUUID() }),
    scope,
  );
  assert.notEqual(
    searchCursorScope(query, { ...session, accountId: randomUUID() }),
    scope,
  );
  assert.notEqual(
    searchCursorScope({ ...query, q: 'A' }, session),
    searchCursorScope({ ...query, q: 'a' }, session),
  );
});

test('strict private positions preserve exact microseconds and descending UUID ties', () => {
  const id = '00000000-0000-4000-8000-000000000001';
  const visible = {
    kind: 'post' as const,
    id,
    at: '2026-10-08T00:00:00.123457Z',
  };
  const after = {
    kind: 'post' as const,
    id,
    at: '2026-10-08T00:00:00.123456Z',
  };
  const position = {
    v: 3,
    kind: 'search',
    matcherId: SEARCH_MATCHER_ID,
    orderId: SEARCH_ORDER_ID,
    after,
    visible,
  };
  assert.deepEqual(searchPositionSchema.parse(position), position);
  assert.equal(searchAnchorFollows(after, visible), true);
  assert.equal(
    searchAnchorFollows(
      { ...after, id },
      { ...after, id: '00000000-0000-4000-8000-000000000002' },
    ),
    true,
  );
  assert.equal(
    searchPositionSchema.safeParse({ ...position, after: visible }).success,
    true,
  );
  assert.equal(
    searchPositionSchema.safeParse({ ...position, visible: null }).success,
    true,
  );
  for (const patch of [
    { v: 2 },
    { kind: 'profile' },
    { matcherId: 'unicode-lower-substring-v1:16.0' },
    { after: visible, visible: after },
    { after: { ...after, at: '2026-10-08T00:00:00.123Z' } },
    { after: { ...after, at: null } },
    { after: { ...after, at: '2026-02-30T00:00:00.123456Z' } },
    { after: { ...after, text: 'private' } },
    { q: 'private' },
    { visible: undefined },
  ])
    assert.equal(
      searchPositionSchema.safeParse({ ...position, ...patch }).success,
      false,
    );
});

test('structural repository selects bounded exact coordinates with no query, body, relationship, contact or resolution predicate', async () => {
  const calls: { sql: string; values: unknown[] }[] = [];
  const tx = {
    query: async (sql: string, values: unknown[]) => {
      calls.push({ sql, values });
      return { rows: [] };
    },
  } as unknown as PoolClient;
  const scope = {
    spaceId,
    category: null,
    tradingSubtype: null,
    excludeUrgentTrading: true,
    types: ['post'] as const,
    from: null,
    to: null,
    postId: null,
  };
  await new SearchRepository().candidates(scope, null, tx);
  assert.equal(SEARCH_SCAN_BATCH, 128);
  assert.match(calls[0]!.sql, /LIMIT 129/);
  assert.match(calls[0]!.sql, /HH24:MI:SS.US/);
  assert.match(calls[0]!.sql, /ORDER BY p.published_at DESC,p.id DESC/);
  assert.doesNotMatch(
    calls[0]!.sql,
    /ILIKE|\bLIKE\b|p\.text|\bbody\b|contacts|resolution|whaleu_(?:safety|identity|profile)|account_id/i,
  );
  assert.deepEqual(calls[0]!.values.slice(0, 13), [
    spaceId,
    [],
    [],
    null,
    null,
    true,
    null,
    null,
    null,
    null,
    null,
    null,
    ['post'],
  ]);
});

test('normal AppModule registers search HTTP parsing and supplied bearer never downgrades to guest', async () => {
  const calls: { token: string | null; query: SearchQuery }[] = [];
  const module = await Test.createTestingModule({
    imports: [
      AppModule.register(
        loadConfig({
          NODE_ENV: 'test',
          DATABASE_URL: 'postgresql://test:test@127.0.0.1/whaleu_test',
          PG_SSL_MODE: 'disable',
          LOG_LEVEL: 'silent',
        }),
      ),
    ],
  })
    .overrideProvider(DatabaseService)
    .useValue({ ready: async () => true })
    .overrideProvider(SearchService)
    .useValue({
      search: async (token: string | null, query: SearchQuery) => {
        calls.push({ token, query });
        return { items: [], nextCursor: null, continuation: 'end' };
      },
    })
    .compile();
  const app = module.createNestApplication({ logger: false });
  configureHttp(app);
  await app.init();
  try {
    const response = await request(app.getHttpServer())
      .get('/v1/community/search')
      .query({ ...valid, q: ' 0\r\n' })
      .expect(200);
    assert.deepEqual(response.body, {
      items: [],
      nextCursor: null,
      continuation: 'end',
    });
    assert.deepEqual(calls[0], {
      token: null,
      query: { spaceId, q: '0', type: 'all', limit: 10 },
    });
    const token = `wu_a_${randomBytes(32).toString('base64url')}`;
    await request(app.getHttpServer())
      .get('/v1/community/search')
      .query(valid)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    assert.equal(calls[1]!.token, token);
    for (const auth of ['', 'Bearer invalid', 'Basic credential'])
      await request(app.getHttpServer())
        .get('/v1/community/search')
        .query(valid)
        .set('Authorization', auth)
        .expect(401);
    for (const suffix of [
      '&q=second',
      '&spaceId=' + spaceId,
      '&limit=1&limit=2',
      '&unknown=value',
      '&q[]=second',
      '&category=trading&category=discussion',
    ])
      await request(app.getHttpServer())
        .get(`/v1/community/search?spaceId=${spaceId}&q=literal${suffix}`)
        .expect(400);
    for (const scope of ['all', 'regional', 'global']) {
      await request(app.getHttpServer())
        .get('/v1/community/search')
        .query({ scope, q: 'literal' })
        .expect(200);
      assert.deepEqual(calls.at(-1), {
        token: null,
        query: { scope, q: 'literal', type: 'all', limit: 10 },
      });
    }
    for (const suffix of [
      '&scope=regional',
      '&scope[]=regional',
      '&spaceId=' + spaceId,
      '&category=discussion',
      '&tradingSubtype=shuma',
      '&campusId=' + spaceId,
      '&membershipFingerprint=' + 'a'.repeat(64),
    ])
      await request(app.getHttpServer())
        .get('/v1/community/search?scope=all&q=literal' + suffix)
        .expect(400);
    await request(app.getHttpServer())
      .get('/v1/community/search?scope=global&q=literal&category=discussion')
      .expect(400);
    assert.equal(calls.length, 5);
  } finally {
    await app.close();
  }
});
