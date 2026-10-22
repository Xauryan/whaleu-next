import { untouchedCategoryRows } from './support/category-read-facts.js';
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import {
  distributionCursorScope,
  encodeCursor,
  decodeCursor,
} from '../src/community/cursor.js';
import type { CommunityDistributionScope } from '../src/community/related-sync/contracts.js';
import type { CommunityDistributionService } from '../src/community/related-sync/service.js';
import {
  SearchRepository,
  SEARCH_SCAN_BATCH,
} from '../src/community/search/repository.js';
import type { SearchStructuralScope } from '../src/community/search/repository.js';
import {
  HotRepository,
  HOT_SCAN_BATCH,
} from '../src/community/hot/repository.js';
import { FeedService } from '../src/community/feed.service.js';
import type { CommunityRepository } from '../src/community/community.repository.js';
import type { CommunityAccessService } from '../src/community/community-access.service.js';
import type { CommunitySerializer } from '../src/community/community-serialization.js';
import {
  startTransactionDeadlines,
  checkpointTransactionDeadlines,
  restoreTransactionDeadlines,
  transactionReadEpoch,
} from '../src/database/transaction-deadlines.js';
import {
  searchHitSchema,
  searchPageSchema,
} from '../src/community/search/response-schema.js';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const a = id(1),
  b = id(2),
  region = id(3),
  post = id(4);
const view: CommunityDistributionScope = Object.freeze({
  viewSpaceId: b,
  viewRegionId: region,
  relatedCampusDistribution: 'complete',
  fingerprint: 'a'.repeat(64),
  originalSpaceIds: Object.freeze([a, b]),
  remoteSpaceIds: Object.freeze([a]),
});
const query: SearchStructuralScope = {
  spaceId: b,
  distribution: view,
  category: 'discussion',
  tradingSubtype: null,
  excludeUrgentTrading: true,
  types: ['post', 'comment', 'reply'],
  from: null,
  to: null,
  postId: null,
};
const historicalHomeRows = (ids: string[]) =>
  ids.map((postId) => ({
    postId,
    accountId: id(99),
    authorMode: 'named',
    version: 4,
    dispositionId: null,
    decisionId: null,
    digest: null,
    result: null,
    surfaces: null,
    valid: true,
  }));

test('related view cursors bind current generation, completeness, view and session without exposing members', () => {
  const scope = distributionCursorScope('feed', view, 'session-a');
  assert.match(scope, /^[a-f0-9]{64}$/);
  const seek = { id: post, at: '2026-10-13T00:00:00.000Z' };
  const cursor = encodeCursor(seek, scope, 10);
  assert.deepEqual(decodeCursor(cursor, scope, 10), seek);
  for (const changed of [
    distributionCursorScope(
      'feed',
      { ...view, fingerprint: 'b'.repeat(64) },
      'session-a',
    ),
    distributionCursorScope(
      'feed',
      { ...view, relatedCampusDistribution: 'unavailable' },
      'session-a',
    ),
    distributionCursorScope('feed', { ...view, viewSpaceId: a }, 'session-a'),
    distributionCursorScope('feed', view, 'session-b'),
  ])
    assert.throws(() => decodeCursor(cursor, changed, 10));
  const payload = Buffer.from(cursor, 'base64url').toString('utf8');
  assert.ok(
    !payload.includes(a) &&
      !payload.includes(b) &&
      !payload.includes('session-a'),
  );
});

test('lexical candidates use one owner predicate and keep canonical source IDs and 128+1 windows', async () => {
  let calls = 0;
  const owner = {
    sqlPredicate(
      scope: CommunityDistributionScope,
      alias: string,
      category: string,
      parameters: unknown[],
    ) {
      assert.equal(scope, view);
      assert.equal(alias, 'distribution_post');
      assert.equal(category, 'category');
      calls++;
      parameters.push([a, b]);
      return `${alias}.space_id=ANY($${parameters.length}::uuid[])`;
    },
  } as unknown as CommunityDistributionService;
  let sql = '';
  let values: unknown[] = [];
  const tx = {
    query: async (text: string, params: unknown[]) => {
      sql = text;
      values = params;
      return { rows: [] };
    },
  } as unknown as PoolClient;
  const repository = new SearchRepository(owner);
  await repository.candidates(query, null, tx);
  assert.equal(calls, 1);
  assert.equal(SEARCH_SCAN_BATCH, 128);
  assert.equal(
    (sql.match(/distribution_post.space_id=ANY\(\$15::uuid\[\]\)/g) ?? [])
      .length,
    3,
  );
  assert.match(sql, /p.space_id AS "spaceId"/);
  assert.match(sql, /LIMIT 129/);
  assert.deepEqual(values[14], [a, b]);
  assert.equal(values[15], b);
  assert.match(sql, /local_classified.space_id=\$16::uuid/);
  assert.match(sql, /JOIN LATERAL/);
  assert.match(sql, /exact_category.id=distribution_post.id OFFSET 0/);
  const canonical: SearchStructuralScope = {
    spaceId: a,
    category: 'discussion',
    tradingSubtype: null,
    excludeUrgentTrading: true,
    types: ['post'],
    from: null,
    to: null,
    postId: null,
  };
  await repository.candidates(canonical, null, tx);
  assert.equal(calls, 1, 'canonical-only scopes do not acquire topology');
  assert.match(sql, /p.space_id=\$1/);
});

test('hot candidate and current guard share owner eligibility without changing canonical ranking', async () => {
  const calls: string[] = [];
  const owner = {
    sqlPredicate(
      scope: CommunityDistributionScope,
      alias: string,
      category: string,
      parameters: unknown[],
    ) {
      assert.equal(scope, view);
      calls.push(category);
      parameters.push([a, b]);
      return `${alias}.space_id=ANY($${parameters.length}::uuid[])`;
    },
  } as unknown as CommunityDistributionService;
  const statements: string[] = [];
  const tx = {
    query: async (sql: string) => {
      statements.push(sql);
      return { rows: [] };
    },
  } as unknown as PoolClient;
  const repository = new HotRepository(owner);
  const space = {
    id: b,
    kind: 'regional' as const,
    name: 'B',
    isActive: true,
    operatingRegionId: region,
  };
  const hot = { spaceId: b, range: 'day' as const, limit: 10 };
  await repository.candidates(
    space,
    hot,
    '2026-10-13T00:00:00.000000Z',
    null,
    tx,
    view,
  );
  await repository.structurallyAllowed(
    post,
    space,
    hot,
    '2026-10-13T00:00:00.000000Z',
    tx,
    view,
  );
  assert.deepEqual(calls, ['category', 'category']);
  assert.equal(HOT_SCAN_BATCH, 128);
  assert.match(statements[0]!, /ORDER BY hs.score DESC,p.id DESC LIMIT 129/);
  assert.match(statements[0]!, /p.space_id AS "spaceId"/);
  assert.match(statements[1]!, /space_id=ANY/);
});

test('empty regional feed with unknown topology reports only local exhaustion, never complete coverage', async () => {
  let resolves = 0;
  const local = {
    ...view,
    relatedCampusDistribution: 'unavailable' as const,
    originalSpaceIds: [b],
    remoteSpaceIds: [],
  };
  const tx = {
    query: async (sql: string) => ({
      rows: sql.startsWith('SELECT version::text') ? [{ version: '1' }] : [],
    }),
  } as unknown as PoolClient;
  const repository = {
    database: {
      transaction: async (work: (client: PoolClient) => Promise<unknown>) => {
        startTransactionDeadlines(tx);
        return work(tx);
      },
    },
    space: async () => ({
      id: b,
      kind: 'regional',
      name: 'B',
      isActive: true,
      operatingRegionId: region,
    }),
  } as unknown as CommunityRepository;
  const access = {
    advisory: async () => null,
  } as unknown as CommunityAccessService;
  const owner = {
    resolveView: async () => {
      resolves++;
      return local;
    },
    sqlPredicate: () => 'classified.space_id=$1',
  } as unknown as CommunityDistributionService;
  const service = new FeedService(
    repository,
    access,
    {} as CommunitySerializer,
    undefined,
    owner,
  );
  const result = await service.feed(null, { spaceId: b, limit: 10 });
  assert.equal(resolves, 1);
  assert.deepEqual(result, {
    items: [],
    relatedCampusDistribution: 'unavailable',
    nextCursor: null,
    continuation: 'end',
  });
  const missingOwner = new FeedService(
    repository,
    access,
    {} as CommunitySerializer,
  );
  assert.deepEqual(
    await missingOwner.feed(null, { spaceId: b, limit: 10 }),
    result,
    'optional missing injection must never turn regional zero into complete coverage',
  );
});

test('search DTO preserves original source and exposes only the safe related-region pair', () => {
  const hit = {
    kind: 'post',
    contentId: post,
    postId: post,
    rootCommentId: null,
    replyId: null,
    space: { id: a, kind: 'regional', name: 'A' },
    category: 'discussion',
    tradingSubtype: null,
    tradingUrgency: null,
    createdAt: '2026-10-13T00:00:00.000000Z',
    author: {
      kind: 'anonymous',
      personaId: id(9),
      displayName: '鲸鱼',
      avatar: null,
      isPostAuthor: true,
    },
    postSummary: 'hello',
    snippet: {
      segments: [{ text: 'hello', matched: true }],
      truncatedBefore: false,
      truncatedAfter: false,
    },
    target: { kind: 'post', postId: post },
    isRelatedCampusSync: true,
    sourceRegion: { id: region, name: 'A region' },
  };
  assert.equal(searchHitSchema.parse(hit).space.id, a);
  for (const privateField of [
    'identityCampusId',
    'topologySnapshotId',
    'accountId',
    'grantId',
    'publicationMembers',
  ])
    assert.equal(
      searchHitSchema.safeParse({ ...hit, [privateField]: a }).success,
      false,
    );
  assert.equal(
    searchPageSchema.safeParse({
      items: [hit],
      effectiveTypes: ['post'],
      nextCursor: null,
      continuation: 'end',
      relatedCampusDistribution: 'unavailable',
    }).success,
    true,
  );
});

test('unknown native proof in a related candidate fails the required feed before any projection', async () => {
  let projections = 0;
  const candidate = {
    id: post,
    space_id: a,
    category: 'discussion' as const,
    publication_envelope_version: 4,
    published_at: new Date('2026-10-13T00:00:00.000Z'),
  };
  const tx = {
    query: async (sql: string, values: unknown[] = []) => {
      if (sql.startsWith('SELECT version::text'))
        return { rows: [{ version: '1' }] };
      if (sql.startsWith('SELECT p.* FROM')) return { rows: [candidate] };
      if (sql.includes('home_post_disposition_valid(p.id)'))
        return { rows: historicalHomeRows(values[0] as string[]) };
      if (sql.startsWith('SELECT requested.post_id'))
        return {
          rows: untouchedCategoryRows(
            values[0] as string[],
            new Map([[post, candidate]]),
          ),
        };
      return { rows: [] };
    },
  } as unknown as PoolClient;
  const repository = {
    database: {
      transaction: async (work: (client: PoolClient) => Promise<unknown>) => {
        startTransactionDeadlines(tx);
        return work(tx);
      },
    },
    space: async () => ({
      id: b,
      kind: 'regional',
      name: 'B',
      isActive: true,
      operatingRegionId: region,
    }),
  } as unknown as CommunityRepository;
  const owner = {
    resolveView: async () => view,
    sqlPredicate: () => 'classified.space_id=ANY($6::uuid[])',
    allows: async () => ({ kind: 'unavailable' }),
  } as unknown as CommunityDistributionService;
  const access = {
    advisory: async () => null,
    visible: async () => true,
  } as unknown as CommunityAccessService;
  const serializer = {
    post: async () => {
      projections++;
      throw new Error('Must not project unknown distribution');
    },
  } as unknown as CommunitySerializer;
  const service = new FeedService(
    repository,
    access,
    serializer,
    undefined,
    owner,
  );
  await assert.rejects(service.feed(null, { spaceId: b, limit: 10 }), {
    code: 'COMMUNITY_UNAVAILABLE',
  });
  assert.equal(projections, 0);
});

test('feed resolves topology once and finishes branded reads before projection changes the read epoch', async () => {
  const candidates = [post, id(20)].map((value) => ({
    id: value,
    space_id: a,
    category: 'discussion' as const,
    publication_envelope_version: 4,
    published_at: new Date('2026-10-13T00:00:00.000Z'),
  }));
  let epoch: object | undefined,
    resolves = 0,
    allowed = 0,
    projected = 0;
  const tx = {
    query: async (sql: string, values: unknown[] = []) => {
      if (sql.startsWith('SELECT version::text'))
        return { rows: [{ version: '1' }] };
      if (sql.startsWith('SELECT p.* FROM')) return { rows: candidates };
      if (sql.includes('home_post_disposition_valid(p.id)'))
        return { rows: historicalHomeRows(values[0] as string[]) };
      if (sql.startsWith('SELECT requested.post_id'))
        return {
          rows: untouchedCategoryRows(
            values[0] as string[],
            new Map(candidates.map((row) => [row.id, row])),
          ),
        };
      return { rows: [] };
    },
  } as unknown as PoolClient;
  const repository = {
    database: {
      transaction: async (work: (client: PoolClient) => Promise<unknown>) => {
        startTransactionDeadlines(tx);
        return work(tx);
      },
    },
    space: async (spaceId: string) => ({
      id: spaceId,
      kind: 'regional',
      name: spaceId === a ? 'A' : 'B',
      isActive: true,
      operatingRegionId: region,
    }),
  } as unknown as CommunityRepository;
  const owner = {
    resolveView: async () => {
      resolves++;
      epoch = transactionReadEpoch(tx);
      return view;
    },
    sqlPredicate: () => 'classified.space_id=$1',
    allows: async () => {
      assert.equal(transactionReadEpoch(tx), epoch);
      allowed++;
      return {
        kind: 'allow',
        value: {
          isRelatedCampusSync: true,
          sourceRegion: { id: region, name: 'A' },
        },
      };
    },
  } as unknown as CommunityDistributionService;
  const access = {
    advisory: async () => null,
    visible: async () => true,
  } as unknown as CommunityAccessService;
  const serializer = {
    post: async (row: (typeof candidates)[number]) => {
      assert.equal(
        allowed,
        2,
        'all scope reads precede optional hint restoration',
      );
      projected++;
      restoreTransactionDeadlines(tx, checkpointTransactionDeadlines(tx));
      return { id: row.id, publishedAt: row.published_at.toISOString() };
    },
  } as unknown as CommunitySerializer;
  const service = new FeedService(
    repository,
    access,
    serializer,
    undefined,
    owner,
  );
  const result = await service.feed(null, { spaceId: b, limit: 10 });
  assert.equal(result.items.length, 2);
  assert.equal(resolves, 1);
  assert.equal(projected, 2);
});
