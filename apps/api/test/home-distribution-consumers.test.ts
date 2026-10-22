import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import {
  startTransactionDeadlines,
  clearTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
import { FeedService } from '../src/community/feed.service.js';
import { HotFeedService } from '../src/community/hot/service.js';
import { HotRepository } from '../src/community/hot/repository.js';
import type { HotVisible } from '../src/community/hot/cursor.js';
import { HotScoreStorage } from '../src/community/hot-score/storage.js';
import { DiscoveryCursorRepository } from '../src/community/discovery-cursors.js';
import { PostPinsService } from '../src/community/post-pins/service.js';
import { CommunityDistributionService } from '../src/community/related-sync/service.js';
import {
  CommunityOfficialSource,
  CommunityOfficialPublicProjection,
} from '../src/official-account-operations/source.js';
import { OfficialSourceSelector } from '../src/official-account-operations/selection.js';
import type {
  CommunityRepository,
  StoredPost,
} from '../src/community/community.repository.js';
import type { CommunityAccessService } from '../src/community/community-access.service.js';
import type { CommunitySerializer } from '../src/community/community-serialization.js';
import { hotCertificate, hotSnapshot } from './support/hot-certificate.js';

function fixture() {
  const actor = randomUUID(),
    other = randomUUID(),
    spaceId = randomUUID(),
    regionId = randomUUID();
  const space = {
    id: spaceId,
    name: 'Synthetic Home scope',
    kind: 'regional' as const,
    operatingRegionId: regionId,
    isActive: true,
  };
  const rows: StoredPost[] = [];
  const restrictions = new Map<
    string,
    {
      result: 'short_text' | 'reference_only' | null;
      following: 'excluded' | 'named_only_author_filter';
      hot: 'disabled' | 'exclude_water';
      valid: boolean;
    }
  >();
  const moved = new Map<string, 'discussion'>();
  const queries: { sql: string; values: unknown[] }[] = [];
  const serialized: string[] = [];
  let pinned: string | null = null;
  const pinId = randomUUID(),
    scopeId = randomUUID(),
    sessionId = randomUUID();
  const add = (
    options: Partial<StoredPost> = {},
    restriction?: Partial<{
      result: 'short_text' | 'reference_only' | null;
      following: 'excluded' | 'named_only_author_filter';
      hot: 'disabled' | 'exclude_water';
      valid: boolean;
    }>,
  ) => {
    const post: StoredPost = {
      id: randomUUID(),
      account_id: actor,
      author_mode: 'named',
      space_id: spaceId,
      category: 'discussion',
      text: 'Synthetic ordinary text',
      comments_policy: 'open',
      visibility: 'approved',
      deleted_at: null,
      publication_envelope_version: restriction ? 7 : 1,
      published_at: new Date(Date.UTC(2026, 9, 20, 0, 0, 30 - rows.length)),
      ...options,
    };
    rows.push(post);
    if (restriction)
      restrictions.set(post.id, {
        result: 'short_text',
        following: 'named_only_author_filter',
        hot: 'exclude_water',
        valid: true,
        ...restriction,
      });
    return post;
  };
  const stored = (id: unknown) => rows.find((p) => p.id === id)!;
  const at = (post: StoredPost) =>
    post.published_at.toISOString().replace('.000Z', '.000000Z');
  const candidate = (post: StoredPost) => ({
    id: post.id,
    spaceId,
    at: at(post),
    score: '0.0000',
  });
  const categoryFact = (post: StoredPost) => ({
    postId: post.id,
    originalCategory: post.category,
    originalSpaceId: spaceId,
    headPostId: moved.has(post.id) ? post.id : null,
    headCategory: moved.get(post.id) ?? null,
    revision: moved.has(post.id) ? 1 : null,
    eventId: moved.has(post.id) ? pinId : null,
    headXmin: moved.has(post.id) ? '1' : null,
    livePostId: null,
    liveCategory: null,
    liveRevision: null,
    liveEventId: null,
    policyId: null,
    reviewId: null,
    validUntil: null,
    batchValidUntil: null,
    batchValidUntilMs: null,
    batchValidUntilMicros: null,
  });
  const tx = {
    query: async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      if (sql.includes('home_post_disposition_valid(p.id)'))
        return {
          rows: (values[0] as string[]).map((id) => {
            const post = stored(id),
              restriction = restrictions.get(id);
            return {
              postId: id,
              accountId: post.account_id,
              authorMode: post.author_mode,
              version: post.publication_envelope_version,
              dispositionId: restriction ? id : null,
              decisionId: restriction ? pinId : null,
              digest: restriction ? 'a'.repeat(64) : null,
              result: restriction?.result ?? null,
              surfaces: restriction
                ? {
                    home: true,
                    hot: restriction.hot,
                    following: restriction.following,
                  }
                : null,
              valid: restriction?.valid ?? true,
            };
          }),
        };
      if (sql.startsWith('SELECT requested.post_id'))
        return {
          rows: (values[0] as string[]).map((id) => categoryFact(stored(id))),
        };
      if (sql.startsWith('WITH category_read_live'))
        return {
          rows: (values[0] as string[]).map((id) => ({
            postId: id,
            livePostId: id,
            liveCategory: moved.get(id),
            liveRevision: 1,
            liveEventId: pinId,
            policyId: pinId,
            reviewId: pinId,
            validUntil: '2030-01-01T00:00:00.000000Z',
            batchValidUntil: '2030-01-01T00:00:00.000000Z',
            batchValidUntilMs: 1893456000000,
            batchValidUntilMicros: '1893456000000000',
          })),
        };
      if (sql.startsWith('SELECT version::text'))
        return { rows: [{ version: '0' }] };
      if (sql.startsWith('SELECT revision::text'))
        return { rows: [{ revision: '0' }] };
      if (sql.includes('FROM whaleu_post_hotness.scores hs'))
        return {
          rows: rows.map(candidate).sort((a, b) => b.id.localeCompare(a.id)),
        };
      if (sql.startsWith('SELECT p.id,p.space_id'))
        return {
          rows: [
            { id: stored(values[0]).id, spaceId, at: at(stored(values[0])) },
          ],
        };
      if (sql.startsWith('SELECT p.id FROM whaleu_community.posts'))
        return { rows: [{ id: values[0] }] };
      if (sql.startsWith('SELECT p.* FROM whaleu_community.posts p JOIN'))
        return {
          rows: rows.filter(
            (p) =>
              !values[2] || p.published_at.toISOString() < String(values[2]),
          ),
        };
      if (sql.startsWith('SELECT to_char(clock_timestamp()'))
        return { rows: [{ now: '2026-10-22T00:00:00.000000Z' }] };
      if (sql.startsWith('SELECT current_setting'))
        return { rows: [{ isolation: 'read committed', capacity: 16 }] };
      if (sql.startsWith('SELECT slot,version,epoch::text'))
        return {
          rows: Array.from({ length: 128 }, (_, slot) => ({
            slot,
            version: 1,
            epoch: '0',
          })),
        };
      if (sql.startsWith('SELECT jsonb_build_object'))
        return { rows: [{ value: {} }] };
      if (sql.startsWith('SELECT t.expires_at::text'))
        return {
          rows: [
            {
              token_until: '2030-01-01T00:00:00Z',
              session_until: '2030-01-01T00:00:00Z',
            },
          ],
        };
      if (sql.startsWith('SELECT s.id,s.space_id'))
        return {
          rows: [
            {
              id: scopeId,
              space_id: spaceId,
              kind: 'regional',
              operating_region_id: regionId,
              until: '2030-01-01T00:00:00Z',
              history_until: '2030-01-01T00:00:00Z',
            },
          ],
        };
      if (sql.startsWith('SELECT p.*,p.pinned_until'))
        return {
          rows: pinned
            ? [
                {
                  id: pinId,
                  post_id: pinned,
                  scope_id: scopeId,
                  level: 1,
                  pinned_at: new Date(),
                  pinned_until: new Date('2030-01-01'),
                  until: '2030-01-01T00:00:00Z',
                },
              ]
            : [],
        };
      if (
        sql.startsWith('SELECT subtype,urgency') ||
        sql.startsWith('SELECT read_at')
      )
        return { rows: [] };
      if (
        sql.startsWith(
          'SELECT id,space_id,published_at,local_creation_transaction',
        )
      )
        return {
          rows: [{ ...stored(values[0]), local_creation_transaction: '42' }],
        };
      if (sql.includes('FROM whaleu_official.export_eligibility'))
        return { rows: [{ revision: '1', decision: 'allow', current: true }] };
      if (sql.includes('LEFT JOIN whaleu_community.post_owner_visibility'))
        return {
          rows: [
            {
              postId: values[0],
              ownerHidden: false,
              version: 0,
              requestId: null,
              xmin: null,
            },
          ],
        };
      if (sql.includes('FROM whaleu_media.bindings')) return { rows: [] };
      if (sql === 'SELECT clock_timestamp() now')
        return { rows: [{ now: new Date('2026-10-22') }] };
      if (sql.startsWith('SELECT pg_current_snapshot'))
        return { rows: [{ snapshot: '1:1:', domain: 'synthetic' }] };
      if (sql.includes('FROM whaleu_official.source_roots'))
        return {
          rows: [
            {
              space_id: spaceId,
              ready: true,
              baseline_exhausted: true,
              head: '0',
              settled_head: '0',
              dependency_head: '0',
              dependency_cursor: '0',
            },
          ],
        };
      if (
        sql.startsWith('SELECT p.id,to_char') ||
        sql.startsWith('SELECT r.post_id id,to_char')
      )
        return { rows: [] };
      if (
        sql.includes('whaleu_official.source_dirty') ||
        sql.includes("r.decision='unknown'") ||
        sql.includes('FROM whaleu_official.source_ranks')
      )
        return { rows: [] };
      if (/^(SELECT pg_advisory|SET LOCAL)/.test(sql)) return { rows: [] };
      throw new Error(sql);
    },
  } as unknown as PoolClient;
  const transaction = async <T>(
    work: (tx: PoolClient) => Promise<T>,
  ): Promise<T> => {
    startTransactionDeadlines(tx);
    try {
      return await work(tx);
    } finally {
      clearTransactionDeadlines(tx);
    }
  };
  const repository = {
    database: { transaction },
    space: async () => space,
    post: async (id: string) => stored(id),
    images: async () => [],
  } as unknown as CommunityRepository;
  const access = {
    actor: async (token: string) => (token === 'author' ? actor : other),
    advisory: async () => ({ phoneVerified: true, canManage: true }),
    authority: async () => ({
      phoneVerified: true,
      canManage: true,
      restrictedActions: [],
    }),
    visible: async () => true,
    projectionPost: async (id: string) => ({ post: stored(id), space }),
  } as unknown as CommunityAccessService;
  const serializer = {
    post: async (post: StoredPost) => {
      serialized.push(post.id);
      return {
        id: post.id,
        category: moved.get(post.id) ?? post.category,
        publishedAt: post.published_at.toISOString(),
        author: { kind: post.author_mode },
      };
    },
    publicExport: async () => ({
      text: 'public',
      likeCount: 0,
      discussionCount: 0,
      saveCount: 0,
    }),
  } as unknown as CommunitySerializer;
  const identity = {
    session: async (token: string) => ({
      accountId: token === 'author' ? actor : other,
      sessionId,
    }),
  };
  const scores = {
    lockStates: async () => {},
    snapshot: async (id: string) => hotSnapshot(id),
  };
  const storage = Object.assign(new HotScoreStorage(), {
    certificate: async (id: string) => hotCertificate(hotSnapshot(id)),
  });
  return {
    actor,
    other,
    space,
    tx,
    rows,
    queries,
    restrictions,
    serialized,
    add,
    moved,
    transaction,
    repository,
    access,
    serializer,
    identity,
    scores,
    storage,
    candidate,
    pin: (id: string) => {
      pinned = id;
    },
  };
}

test('real FeedService rechecks stale SQL rows before paging and serialization, preserving anonymous owner identity privacy', async () => {
  const f = fixture();
  const hidden = f.add(
    { account_id: f.other, author_mode: 'anonymous', category: 'water' },
    {},
  );
  const own = f.add({ author_mode: 'anonymous', category: 'water' }, {});
  const ordinary = f.add();
  const feed = new FeedService(f.repository, f.access, f.serializer);
  const first = await feed.feed('author', { spaceId: f.space.id, limit: 1 });
  assert.deepEqual(
    first.items.map((p) => p.id),
    [own.id],
  );
  assert.ok(first.nextCursor);
  assert.equal(f.serialized.includes(hidden.id), false);
  const second = await feed.feed('author', {
    spaceId: f.space.id,
    limit: 1,
    cursor: first.nextCursor!,
  });
  assert.deepEqual(
    second.items.map((p) => p.id),
    [ordinary.id],
  );
  const guest = await feed.feed(null, { spaceId: f.space.id, limit: 10 });
  assert.deepEqual(
    guest.items.map((p) => p.id),
    [ordinary.id],
  );
  assert.equal(JSON.stringify(first).includes(f.actor), false);
  assert.equal(JSON.stringify(first).includes(f.other), false);
  const sql = f.queries.find((q) => q.sql.startsWith('SELECT p.* FROM'))!;
  assert.ok(
    sql.sql.indexOf('home_disposition.post_id=p.id') <
      sql.sql.indexOf('LIMIT 32'),
  );
  assert.equal(sql.values.at(-1), f.actor);
  assert.match(sql.sql, /classified.current_category=\$2/);
});

test('real Following FeedService combines explicit Home mapping with existing named/profile/follow rules', async () => {
  const f = fixture();
  const excluded = f.add({}, { following: 'excluded' });
  const other = f.add({ account_id: f.other }, {});
  const anonymous = f.add({ author_mode: 'anonymous' }, {});
  const included = f.add({}, {});
  const ordinary = f.add(
    { account_id: f.other },
    { result: null, following: 'excluded' },
  );
  let eligible = true;
  const follows = {
    eligibleFeedAuthor: async () => eligible,
  } as unknown as ConstructorParameters<typeof FeedService>[5];
  const feed = new FeedService(
    f.repository,
    f.access,
    f.serializer,
    undefined,
    undefined,
    follows,
  );
  const page = await feed.feed(
    'author',
    { spaceId: f.space.id, limit: 10 },
    true,
  );
  assert.deepEqual(
    page.items.map((p) => p.id),
    [included.id, ordinary.id],
  );
  for (const post of [excluded, other, anonymous])
    assert.equal(f.serialized.includes(post.id), false);
  eligible = false;
  assert.equal(
    (await feed.feed('author', { spaceId: f.space.id, limit: 10 }, true)).items
      .length,
    0,
  );
  const sql = f.queries.find((q) => q.sql.startsWith('SELECT p.* FROM'))!.sql;
  assert.match(sql, /user_follows/);
  assert.match(sql, /hideProfilePosts/);
  assert.match(
    sql,
    /home_admission.definition->'surfaces'->>'following'='excluded'/,
  );
});

test('real HotFeedService rechecks cached water and restricted rows, including the continuation guard', async () => {
  const f = fixture();
  const water = f.add({ category: 'water' }, {});
  const moved = f.add({ category: 'water' }, {});
  f.moved.set(moved.id, 'discussion');
  const disabled = f.add({ category: 'water' }, { hot: 'disabled' });
  f.moved.set(disabled.id, 'discussion');
  const ordinary = f.add();
  let guard: HotVisible | null = null;
  class GuardCursorFixture extends DiscoveryCursorRepository {
    override get(
      cursor: string,
      scope: string,
      tx: PoolClient,
    ): Promise<unknown>;
    override get<T>(
      cursor: string,
      scope: string,
      tx: PoolClient,
      validate: (position: unknown) => T,
    ): Promise<T>;
    override async get(
      _cursor: string,
      _scope: string,
      _tx: PoolClient,
      validate?: (position: unknown) => unknown,
    ): Promise<unknown> {
      const position = {
        v: 1,
        kind: 'hot',
        after: { score: '1.0000', id: water.id },
        visible: guard,
        emitted: 1,
      };
      return validate ? validate(position) : position;
    }
  }
  const cursors = new GuardCursorFixture();
  const hot = new HotFeedService(
    { HOT_FEED_PROCESSING: 'manual_only' } as ConstructorParameters<
      typeof HotFeedService
    >[0],
    f.repository,
    f.access,
    f.serializer,
    f.identity as ConstructorParameters<typeof HotFeedService>[4],
    cursors,
    { verified: async () => true } as unknown as ConstructorParameters<
      typeof HotFeedService
    >[6],
    new HotRepository(),
    f.scores as unknown as ConstructorParameters<typeof HotFeedService>[8],
    f.storage,
  );
  const query = { spaceId: f.space.id, range: 'day' as const, limit: 10 };
  const own = await hot.read('author', query);
  assert.deepEqual(
    new Set(own.items.map((p) => p.id)),
    new Set([moved.id, ordinary.id]),
  );
  const other = await hot.read('reader', query);
  assert.deepEqual(
    other.items.map((p) => p.id),
    [ordinary.id],
  );
  assert.equal(f.serialized.includes(water.id), false);
  assert.equal(f.serialized.includes(disabled.id), false);
  guard = { id: moved.id, spaceId: moved.space_id, at: f.candidate(moved).at };
  await assert.rejects(hot.read('reader', { ...query, cursor: 'synthetic' }), {
    code: 'DISCOVERY_RESTART_REQUIRED',
  });
  const sql = f.queries.find((q) =>
    q.sql.includes('FROM whaleu_post_hotness.scores hs'),
  )!;
  assert.ok(
    sql.sql.indexOf("p.category)<>'water'") < sql.sql.indexOf('LIMIT 129'),
  );
  assert.equal(sql.values.at(-1), f.actor);
});

test('real pin list suppresses restricted cached pins without changing manager slot occupancy', async () => {
  const f = fixture(),
    post = f.add({ category: 'water' }, {});
  f.pin(post.id);
  const distribution = {
    resolveView: async () => ({}),
  } as unknown as CommunityDistributionService;
  const pins = new PostPinsService(
    f.identity as ConstructorParameters<typeof PostPinsService>[0],
    f.repository,
    f.access,
    f.serializer,
    { require: async () => randomUUID() } as unknown as ConstructorParameters<
      typeof PostPinsService
    >[4],
    distribution,
  );
  const hidden = await pins.list('reader', { spaceId: f.space.id });
  assert.deepEqual(hidden.items, []);
  const own = await pins.list('author', { spaceId: f.space.id });
  assert.equal(own.items[0]?.post.id, post.id);
  const slot = await pins.slot('reader', f.space.id);
  assert.equal(slot.pin?.postId, post.id);
  const selects = f.queries.filter((q) =>
    q.sql.startsWith('SELECT p.*,p.pinned_until'),
  );
  assert.match(selects[0]!.sql, /home_disposition.post_id=post.id/);
  assert.doesNotMatch(selects.at(-1)!.sql, /home_disposition/);
  assert.equal(
    f.queries.some((q) => /^UPDATE|^DELETE|^INSERT/.test(q.sql)),
    false,
  );
});

test('actual Official inspection and both projection boundaries deny suppressed exports but preserve direct access', async () => {
  const f = fixture(),
    hidden = f.add({}, {}),
    ordinary = f.add();
  let exports = 0;
  const source = new CommunityOfficialSource(
    f.repository,
    f.access,
    f.scores as unknown as ConstructorParameters<
      typeof CommunityOfficialSource
    >[2],
    f.storage,
    {
      read: async () => {
        exports++;
        return {
          text: 'ok',
          publicCounts: { likes: '0', comments: '0', subscriptions: '0' },
          locator: 'native',
          mediaAppearanceRefs: [],
        };
      },
    },
  );
  const projection = new CommunityOfficialPublicProjection(
    f.repository,
    f.access,
    f.serializer,
  );
  await f.transaction(async (tx) => {
    assert.equal(
      (await source.inspect(hidden.id, false, tx))?.decision,
      'deny',
    );
    await assert.rejects(source.project(hidden.id, tx));
    await assert.rejects(projection.read(hidden.id, tx));
    assert.equal(exports, 0);
    assert.equal(
      (await source.inspect(ordinary.id, false, tx))?.decision,
      'allow',
    );
    await source.project(ordinary.id, tx);
    assert.equal(exports, 1);
    assert.equal(
      (await f.access.projectionPost(hidden.id, null, tx)).post.id,
      hidden.id,
      'Home gate never changes direct content visibility',
    );
  });
});

test('actual Official newest selection applies suppression in candidate SQL before its fixed page budget', async () => {
  const f = fixture();
  const selector = new OfficialSourceSelector({
    inspect: async () => {
      throw new Error('empty');
    },
    project: async () => {
      throw new Error('unused');
    },
  });
  await f.transaction((tx) =>
    selector.select(
      { schoolSpaceId: f.space.id, citySpaceId: null, kind: 'manual_newest' },
      tx,
    ),
  );
  const sql = f.queries.find((q) =>
    q.sql.startsWith('SELECT p.id,to_char'),
  )!.sql;
  assert.match(sql, /home_disposition.post_id=p.id/);
  assert.ok(sql.indexOf('home_disposition') < sql.indexOf('LIMIT $5'));
});

test('actual related-sync owner rejects restricted remote distribution using canonical versions, while local access remains separate', async () => {
  const f = fixture(),
    post = f.add({}, {});
  const local = {
    ...f.space,
    id: randomUUID(),
    operatingRegionId: randomUUID(),
  };
  const tx = new Proxy(f.tx, {
    get(target, property, receiver) {
      if (property !== 'query') return Reflect.get(target, property, receiver);
      return async (sql: string, values: unknown[] = []) => {
        if (sql.includes('related_sync_generation_fingerprint'))
          return { rows: [{ generation: 'a'.repeat(64) }] };
        if (sql.startsWith('SELECT s.id,s.kind,s.name'))
          return { rows: [{ ...f.space, regionName: 'Original region' }] };
        if (sql.startsWith('SELECT b.post_id')) return { rows: [] };
        if (sql.startsWith('SELECT id,publication_envelope_version'))
          return {
            rows: (values[0] as string[]).map((id) => ({
              id,
              publication_envelope_version: 7,
            })),
          };
        return target.query(sql, values);
      };
    },
  });
  const owner = new CommunityDistributionService(
    {
      distributionGroup: async () => ({
        status: 'known',
        memberRegionIds: [f.space.operatingRegionId, local.operatingRegionId],
        fingerprint: 'b'.repeat(64),
      }),
    } as unknown as ConstructorParameters<
      typeof CommunityDistributionService
    >[0],
    {} as ConstructorParameters<typeof CommunityDistributionService>[1],
  );
  startTransactionDeadlines(tx);
  try {
    const scope = await owner.resolveView(local, tx);
    const values: unknown[] = [];
    const sql = owner.sqlPredicate(scope, 'p', 'category', values);
    assert.match(sql, /^\(p.space_id=\$1::uuid OR/);
    assert.match(sql, /home_disposition.post_id=p.id/);
    const result = await owner.evaluatePosts(
      scope,
      [
        {
          id: post.id,
          space_id: f.space.id,
          category: 'discussion',
          publication_envelope_version: 4,
        },
      ],
      tx,
    );
    assert.deepEqual(result.get(post.id), {
      kind: 'deny',
      reason: 'POST_NOT_FOUND',
    });
    const original = await owner.resolveView(f.space, tx);
    assert.deepEqual(
      await owner.allows(original, post.id, f.space.id, 'discussion', tx),
      { kind: 'allow', value: { isRelatedCampusSync: false } },
    );
    const invalid = f.add({}, { valid: false });
    await assert.rejects(
      owner.allows(scope, invalid.id, f.space.id, 'discussion', tx),
    );
  } finally {
    clearTransactionDeadlines(tx);
  }
});
