import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { PoolClient } from 'pg';
import { ContentReferenceAllocation } from '../src/community/content-references/allocation.js';
import { ContentReferenceRepository } from '../src/community/content-references/repository.js';
import { ContentReferenceService } from '../src/community/content-references/service.js';
import type { ReferenceTarget } from '../src/community/content-references/contracts.js';
import { ApplicationError } from '../src/http/application-error.js';
import type { CommunityRepository } from '../src/community/community.repository.js';
import type { CommunityAccessService } from '../src/community/community-access.service.js';
import type { CommunityDistributionService } from '../src/community/related-sync/service.js';
import {
  startTransactionDeadlines,
  clearTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
const isCode = (code: string) => (error: unknown) =>
  error instanceof ApplicationError && error.code === code;

test('inactive publication remains usable, initialized unpublished policy requires allocation, faults are nonterminal', async () => {
  let state: 'inactive' | 'allocating' | 'ready' = 'inactive',
    calls = 0,
    fault = false;
  const references = {
    policy: async (_tx: PoolClient, lock: string) => {
      assert.ok(lock === undefined || lock === 'update' || lock === 'share');
      return { state, public_enabled: false };
    },
    allocate: async () => {
      calls++;
      if (fault) throw new Error('database fault');
      return '10000000';
    },
  } as unknown as ContentReferenceRepository;
  const owner = new ContentReferenceAllocation(references),
    tx = {} as PoolClient;
  const target = { kind: 'post' as const, targetId: randomUUID() };
  assert.deepEqual(await owner.allocateForPublication(target, tx), {
    state: 'inactive',
  });
  assert.equal(calls, 0);
  state = 'allocating';
  assert.deepEqual(await owner.allocateForPublication(target, tx), {
    state: 'allocated',
    code: '10000000',
  });
  state = 'ready';
  fault = true;
  await assert.rejects(
    owner.allocateForPublication(target, tx),
    isCode('COMMUNITY_UNAVAILABLE'),
  );
  await assert.rejects(
    owner.allocateForPublication({ ...target, targetId: '123' }, tx),
    isCode('COMMUNITY_UNAVAILABLE'),
  );
});

test('allocator replays before touching counters and roots/replies share the child sequence', async () => {
  const references = new ContentReferenceRepository();
  for (const kind of ['post', 'comment', 'reply'] as const) {
    const seen: Array<{ sql: string; values?: unknown[] }> = [];
    let replay = false;
    const tx = {
      query: async (sql: string, values?: unknown[]) => {
        seen.push({ sql, ...(values ? { values } : {}) });
        if (sql.startsWith('SELECT code FROM'))
          return { rows: replay ? [{ code: '100000001' }] : [] };
        if (sql.includes('FOR UPDATE'))
          return {
            rows: [
              {
                next_code: kind === 'post' ? '10000000' : '100000000',
                maximum: kind === 'post' ? '99999999' : '999999999',
              },
            ],
          };
        if (sql.includes('generate_series'))
          return {
            rows: [{ code: kind === 'post' ? '10000000' : '100000000' }],
          };
        return { rows: [], rowCount: 1 };
      },
    } as unknown as PoolClient;
    const target = { kind, targetId: randomUUID() };
    await references.allocate(target, tx);
    assert.equal(
      seen.find(({ sql }) => sql.includes('FOR UPDATE'))?.values?.[0],
      kind === 'post' ? 'post' : 'child',
    );
    assert.equal(seen.filter(({ sql }) => sql.startsWith('INSERT')).length, 2);
    const candidate = seen.find(({ sql }) => sql.includes('generate_series'));
    assert.match(candidate!.sql, /target_kind<>\$3 OR target_id<>\$4::uuid/);
    assert.deepEqual(candidate!.values?.slice(2), [kind, target.targetId]);
    assert.match(
      seen.find(({ sql }) =>
        sql.startsWith(
          'INSERT INTO whaleu_community.content_reference_reservations',
        ),
      )!.sql,
      /ON CONFLICT\(code\) DO NOTHING/,
    );
    seen.length = 0;
    replay = true;
    assert.equal(await references.allocate(target, tx), '100000001');
    assert.equal(seen.length, 1);
  }
});

function fixture() {
  const actor = randomUUID(),
    postId = randomUUID(),
    rootId = randomUUID(),
    replyId = randomUUID(),
    spaceId = randomUUID();
  const calls: string[] = [],
    targets: ReferenceTarget[] = [];
  let expireFinal = false;
  let ready = true,
    consumed = true,
    missing = false,
    denial: string | null = null,
    finalReady = true;
  const post = { id: postId },
    space = { id: spaceId };
  const tx = {} as PoolClient;
  const community = {
    database: {
      transaction: async (operation: (tx: PoolClient) => Promise<unknown>) => {
        startTransactionDeadlines(tx);
        calls.push('begin');
        try {
          const result = await operation(tx);
          calls.push('commit');
          return result;
        } catch (error) {
          calls.push('rollback');
          throw error;
        } finally {
          clearTransactionDeadlines(tx);
        }
      },
    },
  } as unknown as CommunityRepository;
  const access = {
    actor: async () => {
      calls.push('actor');
      if (expireFinal && calls.filter((call) => call === 'actor').length > 1)
        throw new ApplicationError('SESSION_REVOKED');
      return actor;
    },
    accessiblePost: async (id: string, viewer: string) => {
      calls.push('post');
      assert.equal(viewer, actor);
      assert.equal(id, postId);
      if (denial) throw new ApplicationError(denial as 'POST_NOT_FOUND');
      return { post, space };
    },
    accessibleComment: async (id: string, viewer: string) => {
      calls.push('comment');
      assert.equal(viewer, actor);
      assert.equal(id, rootId);
      if (denial) throw new ApplicationError(denial as 'POST_NOT_FOUND');
      return { post, space, comment: { id: rootId } };
    },
    accessibleReply: async (id: string, viewer: string) => {
      calls.push('reply');
      assert.equal(viewer, actor);
      assert.equal(id, replyId);
      if (denial) throw new ApplicationError(denial as 'POST_NOT_FOUND');
      return { post, space, comment: { id: rootId }, reply: { id: replyId } };
    },
  } as unknown as CommunityAccessService;
  let current: ReferenceTarget = { kind: 'post', targetId: postId };
  const references = {
    publicReady: async (_tx: PoolClient, lock: boolean) => {
      calls.push(lock ? 'ready-final' : 'ready');
      return lock ? finalReady : ready;
    },
    consume: async (id: string) => {
      assert.equal(id, actor);
      calls.push('consume');
      return consumed;
    },
    resolve: async () => {
      calls.push('resolve');
      return missing ? null : current;
    },
    canonical: async (target: ReferenceTarget) => {
      targets.push(target);
      return missing ? null : '10000000';
    },
  } as unknown as ContentReferenceRepository;
  return {
    calls,
    targets,
    postId,
    rootId,
    replyId,
    spaceId,
    service: new ContentReferenceService(
      community,
      access,
      {} as CommunityDistributionService,
      references,
    ),
    set(value: {
      expireFinal?: boolean;
      ready?: boolean;
      consumed?: boolean;
      missing?: boolean;
      denial?: string | null;
      current?: ReferenceTarget;
      finalReady?: boolean;
    }) {
      if (value.expireFinal !== undefined) expireFinal = value.expireFinal;
      if (value.ready !== undefined) ready = value.ready;
      if (value.consumed !== undefined) consumed = value.consumed;
      if (value.missing !== undefined) missing = value.missing;
      if (value.denial !== undefined) denial = value.denial;
      if (value.current) current = value.current;
      if (value.finalReady !== undefined) finalReady = value.finalReady;
    },
  };
}

test('resolve derives each navigation destination using the canonical typed authority and no numeric-width dispatch', async () => {
  const f = fixture();
  for (const [kind, targetId] of [
    ['post', f.postId],
    ['comment', f.rootId],
    ['reply', f.replyId],
  ] as const) {
    f.set({ current: { kind, targetId } });
    const result = await f.service.resolve('token', {
      code: '12345678',
      viewSpaceId: f.spaceId,
    });
    assert.deepEqual(result, {
      kind,
      postId: f.postId,
      ...(kind !== 'post' ? { rootCommentId: f.rootId } : {}),
      ...(kind === 'reply' ? { replyId: f.replyId } : {}),
      viewSpaceId: f.spaceId,
    });
    assert.equal(f.calls.at(-1), 'commit');
    assert.ok(f.calls.includes(kind));
    assert.ok(!JSON.stringify(result).includes('code'));
  }
});

test('unreadable and unknown references share one outcome after committing budget; outages never become absence', async () => {
  for (const denial of [
    'POST_NOT_FOUND',
    'COMMENT_NOT_FOUND',
    'REPLY_NOT_FOUND',
    'POST_BLOCKED_BY_YOU',
    'COMMUNITY_SCOPE_UNAVAILABLE',
  ]) {
    const f = fixture();
    f.set({ denial });
    await assert.rejects(
      f.service.resolve('token', { code: '1234567' }),
      isCode('REFERENCE_NOT_FOUND'),
    );
    assert.equal(f.calls.at(-1), 'commit');
  }
  const f = fixture();
  f.set({ missing: true });
  await assert.rejects(
    f.service.resolve('token', { code: '1234567' }),
    isCode('REFERENCE_NOT_FOUND'),
  );
  assert.ok(!f.calls.includes('post'));
  assert.equal(f.calls.at(-1), 'commit');
  for (const denial of [
    'COMMUNITY_UNAVAILABLE',
    'SAFETY_UNAVAILABLE',
    'SESSION_REVOKED',
  ]) {
    const x = fixture();
    x.set({ denial });
    await assert.rejects(
      x.service.resolve('token', { code: '1234567' }),
      isCode(denial),
    );
    assert.equal(x.calls.at(-1), 'rollback');
  }
});

test('readiness, final revocation and limiter fail closed before returning any destination', async () => {
  const f = fixture();
  f.set({ ready: false, finalReady: false });
  assert.deepEqual(await f.service.capability('token'), { available: false });
  await assert.rejects(
    f.service.resolve('token', { code: '1234567' }),
    isCode('COMMUNITY_UNAVAILABLE'),
  );
  assert.ok(!f.calls.includes('consume'));
  f.set({ ready: true, consumed: false });
  f.calls.length = 0;
  await assert.rejects(
    f.service.resolve('token', { code: '1234567' }),
    isCode('REFERENCE_RATE_LIMITED'),
  );
  assert.ok(!f.calls.includes('resolve'));
  assert.equal(f.calls.at(-1), 'commit');
  f.set({ consumed: true });
  await assert.rejects(
    f.service.resolve('token', { code: '1234567' }),
    isCode('COMMUNITY_UNAVAILABLE'),
  );
  assert.equal(f.calls.at(-1), 'rollback');
});

test('lookup deduplicates, sorts, omits missing or unreadable targets and cannot allocate', async () => {
  const f = fixture(),
    target = { kind: 'post' as const, targetId: f.postId };
  assert.deepEqual(
    await f.service.lookup('token', { targets: [target, target] }),
    { items: [{ ...target, code: '10000000' }] },
  );
  assert.equal(f.targets.length, 1);
  f.set({ denial: 'POST_NOT_FOUND' });
  assert.deepEqual(await f.service.lookup('token', { targets: [target] }), {
    items: [],
  });
  f.set({ denial: null, missing: true });
  f.calls.length = 0;
  assert.deepEqual(await f.service.lookup('token', { targets: [target] }), {
    items: [],
  });
  assert.ok(!f.calls.includes('post'));
  await assert.rejects(
    f.service.lookup('token', { targets: Array(31).fill(target) }),
  );
});

test('final session expiry blocks positive, negative, quota-denied and capability results', async () => {
  for (const scenario of [
    'resolved',
    'unknown',
    'limited',
    'lookup',
    'capability',
  ] as const) {
    const f = fixture();
    f.set({
      expireFinal: true,
      missing: scenario === 'unknown',
      consumed: scenario !== 'limited',
    });
    const work =
      scenario === 'capability'
        ? f.service.capability('token')
        : scenario === 'lookup'
          ? f.service.lookup('token', {
              targets: [{ kind: 'post', targetId: f.postId }],
            })
          : f.service.resolve('token', { code: '12345678' });
    await assert.rejects(work, isCode('SESSION_REVOKED'));
    assert.equal(f.calls.at(-1), 'rollback');
  }
});

test('inactive initialization race never upgrades a shared lock or silently omits required allocation', async () => {
  const locks: Array<string | undefined> = [];
  const owner = new ContentReferenceAllocation({
    policy: async (_tx: PoolClient, lock?: string) => {
      locks.push(lock);
      return {
        state: lock === 'share' ? 'allocating' : 'inactive',
        public_enabled: false,
      };
    },
    allocate: async () => {
      throw new Error('must retry publication first');
    },
  } as unknown as ContentReferenceRepository);
  await assert.rejects(
    owner.allocateForPublication(
      { kind: 'post', targetId: randomUUID() },
      {} as PoolClient,
    ),
    isCode('COMMUNITY_UNAVAILABLE'),
  );
  assert.deepEqual(locks, [undefined, 'share']);
});
