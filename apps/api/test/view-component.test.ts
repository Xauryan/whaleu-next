import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../src/http/application-error.js';
import {
  startTransactionDeadlines,
  checkTransactionDeadlines,
  clearTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
import { ViewReportingService } from '../src/community/view-component/service.js';
import { ViewComponentRepository } from '../src/community/view-component/repository.js';
import type { StoredViewEpoch } from '../src/community/view-component/repository.js';
import type { ViewComponentCleanup } from '../src/community/view-component/cleanup.js';
import type {
  CommunityRepository,
  StoredPost,
} from '../src/community/community.repository.js';
import type { CommunityAccessService } from '../src/community/community-access.service.js';
import {
  viewEpochRequestSchema,
  viewReportSchema,
  viewPayloadFingerprint,
  viewPostMultiset,
  VIEW_LIMITS,
} from '../src/community/view-component/contracts.js';
import type {
  ViewReport,
  ViewReportReceipt,
} from '../src/community/view-component/contracts.js';
const actor = '11111111-1111-4111-8111-111111111111';
const post = '22222222-2222-4222-8222-222222222222';
const other = '33333333-3333-4333-8333-333333333333';
const epochId = '44444444-4444-4444-8444-444444444444';
const batchId = '55555555-5555-4555-8555-555555555555';
const intent: ViewReport = {
  version: 1,
  epochId,
  batchId,
  kind: 'list_exposure',
  postIds: [post, post],
};
test('view wire grammar is strict, UUID-normalized and bounded in events rather than distinct posts', () => {
  assert.deepEqual(viewEpochRequestSchema.parse({ version: 1 }), {
    version: 1,
  });
  assert.throws(() =>
    viewEpochRequestSchema.parse({ version: 1, accountId: actor }),
  );
  assert.equal(
    viewReportSchema.parse({ ...intent, postIds: Array(50).fill(post) }).postIds
      .length,
    50,
  );
  assert.equal(
    viewReportSchema.parse({ ...intent, epochId: epochId.toUpperCase() })
      .epochId,
    epochId,
  );
  for (const changed of [
    { postIds: [] },
    { postIds: Array(51).fill(post) },
    { postIds: [1] },
    { postIds: ['not-uuid'] },
    { kind: 'detail_visit' },
    { kind: 'mixed' },
    { version: 2 },
    { epochId: '44444444-4444-1444-8444-444444444444' },
    { actorId: actor },
    { at: 10 },
    { batchId: undefined },
  ])
    assert.throws(() => viewReportSchema.parse({ ...intent, ...changed }));
});
test('fingerprint fixture uses every normalized occurrence and distinguishes kind, not order', () => {
  assert.deepEqual(viewPostMultiset([post, actor.toUpperCase(), post]), [
    [actor, 1],
    [post, 2],
  ]);
  assert.equal(
    viewPayloadFingerprint('list_exposure', [actor, post, actor]),
    '67d9f41e18ae9de8bb391d5a656f0d9d299e93da7f99f6fc46cceedbb66fd414',
  );
  assert.equal(
    viewPayloadFingerprint('detail_visit', [actor]),
    'f7de73883b1736204cf4c0be07b3dd2b1ced9c73230207a35791c42637fe55d6',
  );
  assert.equal(
    viewPayloadFingerprint('list_exposure', [actor, post, actor]),
    viewPayloadFingerprint('list_exposure', [actor, actor, post]),
  );
  assert.notEqual(
    viewPayloadFingerprint('list_exposure', [actor, post]),
    viewPayloadFingerprint('list_exposure', [actor, actor, post]),
  );
});
function fixture() {
  const calls: string[] = [];
  let now = Date.parse('2026-10-01T00:00:00.000Z');
  let finalNow: number | null = null;
  let row: StoredViewEpoch | null = {
    id: epochId,
    account_id: actor,
    issued_at: new Date(now),
    collection_until: new Date(now + 3600000),
    expires_at: new Date(now + 86400000),
    batch_count: 0,
    event_count: 0,
  };
  let prior: ViewReportReceipt | null = null;
  let count = 0,
    batches = 0,
    events = 0,
    epochCount = 1;
  let unavailable = false,
    denied = false,
    lagging = false,
    known = true,
    authError = false;
  const tx = {
    query: async (sql: string) => {
      calls.push(sql);
      return {
        rows:
          sql === 'SELECT clock_timestamp() AS now'
            ? [{ now: new Date(finalNow ?? now) }]
            : [],
      };
    },
  } as unknown as PoolClient;
  const database = {
    transaction: async (
      fn: (tx: PoolClient) => Promise<unknown>,
      options: unknown,
    ) => {
      assert.deepEqual(options, { isolationLevel: 'read committed' });
      const snapshot = { count, batches, events, prior };
      startTransactionDeadlines(tx);
      try {
        const result = await fn(tx);
        await checkTransactionDeadlines(tx);
        calls.push('COMMIT');
        return result;
      } catch (error) {
        ({ count, batches, events, prior } = snapshot);
        calls.push('ROLLBACK');
        throw error;
      } finally {
        clearTransactionDeadlines(tx);
      }
    },
  };
  const community = {
    database,
    space: async () => {
      calls.push('space');
    },
  } as unknown as CommunityRepository;
  const access = {
    actor: async () => {
      calls.push('actor');
      if (authError) throw new ApplicationError('SESSION_REVOKED');
      return actor;
    },
    visibilityDecision: async (
      _actor: string,
      _post: unknown,
      _tx: unknown,
      purpose: string,
    ) => {
      calls.push(purpose);
      if (unavailable) throw new ApplicationError('COMMUNITY_UNAVAILABLE');
      return denied
        ? { kind: 'deny', reason: 'POST_NOT_FOUND' }
        : { kind: 'allow', value: undefined };
    },
  } as unknown as CommunityAccessService;
  const records = {
    budget: async () => {
      calls.push('budget');
    },
    lockOwner: async () => {
      calls.push('owner');
    },
    now: async () => new Date(now),
    epoch: async () => {
      calls.push('epoch');
      return row;
    },
    collecting: async () => {
      calls.push('collecting');
      return row;
    },
    capacity: async () => {
      calls.push('capacity');
      return { epochs: epochCount, batches, events };
    },
    createEpoch: async (_actor: string, at: Date) => {
      calls.push('create');
      row = {
        id: other,
        account_id: actor,
        issued_at: at,
        collection_until: new Date(+at + 3600000),
        expires_at: new Date(+at + 86400000),
        batch_count: 0,
        event_count: 0,
      };
      return row;
    },
    receipt: async () => {
      calls.push('receipt');
      return prior;
    },
    posts: async (ids: string[]) => {
      assert.deepEqual(ids, [...ids].sort());
      calls.push('posts');
      return [
        { id: post, space_id: other, visibility: 'approved', deleted_at: null },
      ] as StoredPost[];
    },
    known: async () => known,
    countDetail: async () => {
      calls.push('detail');
      return true;
    },
    increment: async (_id: string, delta: number) => {
      calls.push('increment');
      count += delta;
    },
    accept: async (receipt: ViewReportReceipt, submitted: number) => {
      calls.push('accept');
      prior = receipt;
      batches++;
      events += submitted;
    },
  } as unknown as ViewComponentRepository;
  const cleanup = {
    assertAdmission: async () => {
      calls.push('admission');
      if (lagging) throw new ApplicationError('VIEW_REPORTING_UNAVAILABLE');
    },
  } as unknown as ViewComponentCleanup;
  return {
    calls,
    service: new ViewReportingService(community, access, records, cleanup),
    state: () => ({ count, batches, events, prior }),
    setNow: (value: number) => {
      now = value;
    },
    now: () => now,
    finalAt: (value: number) => {
      finalNow = value;
    },
    epoch: () => row!,
    missing: () => {
      row = null;
    },
    quota: (b: number, e: number, epochs = 1) => {
      batches = b;
      events = e;
      epochCount = epochs;
    },
    deny: () => {
      denied = true;
    },
    unavailable: () => {
      unavailable = true;
    },
    unknown: () => {
      known = false;
    },
    lag: () => {
      lagging = true;
    },
    revoke: () => {
      authError = true;
    },
  };
}
const code = (expected: string) => (error: unknown) =>
  error instanceof ApplicationError && error.code === expected;
test('new list effects preserve multiplicity, omit missing posts and atomically bind the receipt', async () => {
  const f = fixture();
  const received = await f.service.report('token', {
    ...intent,
    postIds: [other, post, post],
  });
  assert.equal(received.acceptedCount, 2);
  assert.deepEqual(f.state(), {
    count: 2,
    batches: 1,
    events: 3,
    prior: received,
  });
  assert.ok(f.calls.indexOf('epoch') < f.calls.indexOf('receipt'));
  assert.ok(f.calls.indexOf('receipt') < f.calls.indexOf('posts'));
  assert.ok(f.calls.indexOf('posts') < f.calls.indexOf('list_projection'));
  assert.equal(f.calls.at(-1), 'COMMIT');
});
test('matching replay precedes capacity and eligibility, preserves original count, and still authenticates', async () => {
  const f = fixture();
  const result = await f.service.report('token', intent);
  f.calls.length = 0;
  f.deny();
  f.lag();
  f.quota(2048, 20000);
  assert.deepEqual(await f.service.report('token', intent), result);
  for (const call of ['capacity', 'posts', 'admission', 'accept'])
    assert.equal(f.calls.includes(call), false);
  assert.equal(f.state().count, 2);
  f.revoke();
  await assert.rejects(
    f.service.report('token', intent),
    code('SESSION_REVOKED'),
  );
});
test('changed multiset or kind conflicts without additional effects', async () => {
  const f = fixture();
  await f.service.report('token', intent);
  await assert.rejects(
    f.service.report('token', { ...intent, postIds: [post] }),
    code('VIEW_REPORT_CONFLICT'),
  );
  await assert.rejects(
    f.service.report('token', {
      ...intent,
      kind: 'detail_visit',
      postIds: [post],
    }),
    code('VIEW_REPORT_CONFLICT'),
  );
  assert.equal(f.state().count, 2);
  assert.equal(f.state().batches, 1);
});
test('denied and unknown fresh coverage omit; unknown safety aborts instead of successful zero', async () => {
  for (const disposition of ['deny', 'unknown'] as const) {
    const f = fixture();
    f[disposition]();
    assert.equal((await f.service.report('token', intent)).acceptedCount, 0);
    assert.equal(f.state().events, 2);
  }
  const f = fixture();
  f.unavailable();
  await assert.rejects(
    f.service.report('token', intent),
    code('VIEW_REPORTING_UNAVAILABLE'),
  );
  assert.deepEqual(f.state(), { count: 0, batches: 0, events: 0, prior: null });
});
test('detail uses direct semantics, independent of list exposure', async () => {
  const f = fixture();
  await f.service.report('token', {
    ...intent,
    kind: 'detail_visit',
    postIds: [post],
  });
  assert.equal(f.state().count, 1);
  assert.ok(f.calls.includes('direct_post'));
  assert.ok(f.calls.includes('detail'));
  assert.equal(f.calls.includes('list_projection'), false);
});
test('absent/expired epoch never opens; close-at-final-fence rolls back receipt and aggregate', async () => {
  const missing = fixture();
  missing.missing();
  await assert.rejects(
    missing.service.report('token', intent),
    code('VIEW_REPORTING_EPOCH_CLOSED'),
  );
  assert.equal(missing.calls.includes('create'), false);
  const expired = fixture();
  expired.setNow(+expired.epoch().expires_at);
  await assert.rejects(
    expired.service.report('token', intent),
    code('VIEW_REPORTING_EPOCH_CLOSED'),
  );
  const late = fixture();
  late.finalAt(+late.epoch().expires_at);
  await assert.rejects(
    late.service.report('token', intent),
    code('VIEW_REPORTING_EPOCH_CLOSED'),
  );
  assert.deepEqual(late.state(), {
    count: 0,
    batches: 0,
    events: 0,
    prior: null,
  });
  assert.ok(late.calls.includes('SET CONSTRAINTS ALL IMMEDIATE'));
});
test('last five seconds and cleanup failure block only new effects with retryable unavailability', async () => {
  const close = fixture();
  close.setNow(+close.epoch().expires_at - 4999);
  await assert.rejects(
    close.service.report('token', intent),
    code('VIEW_REPORTING_UNAVAILABLE'),
  );
  const f = fixture();
  f.lag();
  await assert.rejects(
    f.service.report('token', intent),
    code('VIEW_REPORTING_UNAVAILABLE'),
  );
  assert.equal(f.state().batches, 0);
});
test('live account capacity is enforced before post locks and rolls back new receipt', async () => {
  for (const [b, e] of [
    [2048, 2048],
    [100, 19999],
  ]) {
    const f = fixture();
    f.quota(b!, e!);
    await assert.rejects(
      f.service.report('token', intent),
      code('RATE_LIMITED'),
    );
    assert.equal(f.calls.includes('posts'), false);
    assert.equal(f.state().prior, null);
  }
});
test('epoch reuse never extends immutable times; one-hour boundary creates only future epoch', async () => {
  const f = fixture();
  const first = await f.service.issueEpoch('token');
  f.setNow(f.now() + 3599999);
  const reused = await f.service.issueEpoch('token');
  assert.equal(reused.epochId, first.epochId);
  assert.equal(reused.expiresAt, first.expiresAt);
  assert.equal(f.calls.includes('create'), false);
  f.setNow(f.now() + 1);
  const next = await f.service.issueEpoch('token');
  assert.notEqual(next.epochId, first.epochId);
  assert.equal(
    Date.parse(next.expiresAt) - Date.parse(next.issuedAt),
    VIEW_LIMITS.lifetimeMs,
  );
  const full = fixture();
  full.setNow(+full.epoch().collection_until);
  full.quota(0, 0, 25);
  await assert.rejects(full.service.issueEpoch('token'), code('RATE_LIMITED'));
});
test('detail cooldown uses clock after lock and never extends a live window; exact boundary counts', async () => {
  for (const remaining of [1, 0, -1]) {
    const now = new Date('2026-10-01T00:00:00.000Z');
    const queries: { sql: string; args: unknown[] | undefined }[] = [];
    const tx = {
      query: async (sql: string, args?: unknown[]) => {
        queries.push({ sql, args });
        return {
          rows: sql.startsWith('SELECT next_allowed_at')
            ? [{ next_allowed_at: new Date(+now + remaining) }]
            : sql.includes(' AS now')
              ? [{ now }]
              : [],
          rowCount: 1,
        };
      },
    } as unknown as PoolClient;
    const result = await new ViewComponentRepository().countDetail(
      actor,
      post,
      tx,
    );
    assert.equal(result, remaining <= 0);
    assert.match(queries[0]!.sql, /FOR UPDATE/);
    assert.match(queries[1]!.sql, /clock_timestamp/);
    const mutation = queries.find((q) => q.sql.startsWith('UPDATE'));
    if (remaining > 0) assert.equal(mutation, undefined);
    else assert.equal(+(mutation!.args![2] as Date) - +now, 300000);
  }
});

test('issuance final fence never returns an already-closed collection descriptor', async () => {
  const f = fixture();
  f.finalAt(+f.epoch().collection_until);
  await assert.rejects(
    f.service.issueEpoch('token'),
    code('VIEW_REPORTING_UNAVAILABLE'),
  );
  assert.equal(f.calls.at(-1), 'ROLLBACK');
});

test('invalid constructed epoch output fails before commit with sanitized owner unavailability', async () => {
  for (const corrupt of [
    (row: StoredViewEpoch) => {
      row.id = 'ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF';
    },
    (row: StoredViewEpoch) => {
      row.expires_at = new Date(+row.expires_at + 1);
    },
    (row: StoredViewEpoch) => {
      row.collection_until = new Date(+row.collection_until + 1);
    },
  ]) {
    const f = fixture();
    corrupt(f.epoch());
    await assert.rejects(
      f.service.issueEpoch('token'),
      code('VIEW_REPORTING_UNAVAILABLE'),
    );
    assert.equal(f.calls.at(-1), 'ROLLBACK');
    assert.equal(f.calls.includes('COMMIT'), false);
  }
});

test('invalid newly constructed receipt rolls back already-applied aggregate changes before commit', async () => {
  const f = fixture();
  // Bypass the HTTP decoder to exercise the service output boundary independently.
  await assert.rejects(
    f.service.report('token', { ...intent, postIds: Array(51).fill(post) }),
    code('VIEW_REPORTING_UNAVAILABLE'),
  );
  assert.deepEqual(f.state(), { count: 0, batches: 0, events: 0, prior: null });
  assert.equal(f.calls.at(-1), 'ROLLBACK');
  assert.equal(f.calls.includes('COMMIT'), false);
  assert.equal(f.calls.includes('accept'), false);
});

test('corrupt stored replay is rejected inside its transaction without acknowledging or rewriting it', async () => {
  const f = fixture();
  await f.service.report('token', intent);
  const stored = f.state().prior!;
  stored.acceptedCount = 51;
  f.calls.length = 0;
  await assert.rejects(
    f.service.report('token', intent),
    code('VIEW_REPORTING_UNAVAILABLE'),
  );
  assert.equal(f.calls.at(-1), 'ROLLBACK');
  assert.equal(f.calls.includes('COMMIT'), false);
  assert.equal(f.calls.includes('accept'), false);
  assert.equal(f.state().count, 2);
  assert.equal(f.state().prior, stored);
});
