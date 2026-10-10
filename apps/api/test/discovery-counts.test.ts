import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import {
  bindDiscoveryCount,
  CommunityDiscoveryCounts,
  DISCOVERY_COUNT_BATCH,
} from '../src/community/discovery-counts.js';
import type { ContentReviewCountFacade } from '../src/community/content-review/count-snapshot.facade.js';
import { COUNT_EPOCH_SLOTS } from '../src/database/count-proof.js';
import type { LikedHistoryRepository } from '../src/community/liked/repository.js';
import {
  checkTransactionDeadlines,
  checkpointTransactionDeadlines,
  clearTransactionDeadlines,
  registerTransactionDeadline,
  startTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';

function fixture(size = 1025, poolMax = 10) {
  const owner = randomUUID();
  const source = Array.from({ length: size }, (_, index) => ({
    id: `${(size - index).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`,
    scan_at: '2001-01-01T00:00:00.123456Z',
  }));
  const commands: { sql: string; values: unknown[] | undefined }[] = [];
  const batches: number[] = [];
  const state = {
    epoch: '1',
    mediaEpoch: '1',
    mediaMissing: false,
    mediaFence: true,
    images: new Set<string>(),
    writerCapacity: 108,
    unknown: null as string | null,
    denied: new Set<string>(),
    failure: null as Error | null,
    failRollback: false,
    until: null as number | null,
    fence: true,
  };
  const tx = {
    query: async (sql: string, values?: unknown[]) => {
      commands.push({ sql, values });
      if (sql.startsWith('ROLLBACK TO') && state.failRollback)
        throw new Error('rollback failed');
      if (sql.includes("current_setting('statement_timeout')"))
        return {
          rows: [
            {
              timeout: '100ms',
              statement_timeout: '10s',
              lock_timeout: '0',
              work_mem: '4MB',
            },
          ],
        };
      if (sql.includes("current_setting('transaction_isolation')"))
        return {
          rows: [
            {
              isolation: 'read committed',
              writer_capacity: state.writerCapacity,
            },
          ],
        };
      if (sql.includes('whaleu_media.media_owner_states')) {
        if (state.mediaMissing)
          throw Object.assign(new Error('Media schema absent'), {
            code: '42P01',
          });
        if (sql.includes('LOCK TABLE') && !state.mediaFence)
          throw Object.assign(new Error('Media writer active'), {
            code: '55P03',
          });
        return {
          rows: Array.from({ length: COUNT_EPOCH_SLOTS }, (_, slot) => ({
            slot,
            version: 1,
            epoch: state.mediaEpoch,
          })),
        };
      }
      if (sql.includes('discovery_count_epochs'))
        return {
          rows: Array.from({ length: COUNT_EPOCH_SLOTS }, (_, slot) => ({
            slot,
            version: 1,
            epoch: state.epoch,
          })),
        };
      if (sql.includes('pg_try_advisory_xact_lock('))
        return { rows: [{ locked: state.fence }] };
      if (sql.includes('pg_try_advisory_xact_lock_shared'))
        return {
          rows: Array.from({ length: COUNT_EPOCH_SLOTS }, () => ({
            locked: state.fence,
          })),
        };
      if (sql === 'SELECT clock_timestamp() AS now')
        return { rows: [{ now: new Date(100) }] };
      if (sql.includes('FROM whaleu_community.posts')) {
        assert.ok(!sql.includes('FOR SHARE'));
        assert.ok(!sql.includes('FOR UPDATE'));
        assert.ok(sql.includes('SS.US'));
        if (state.failure) throw state.failure;
        assert.equal(values?.[0], owner);
        const after = values?.[3];
        const start = after
          ? source.findIndex((item) => item.id === after) + 1
          : 0;
        assert.ok(start >= 0);
        return { rows: source.slice(start, start + DISCOVERY_COUNT_BATCH + 1) };
      }
      return { rows: [] };
    },
  } as unknown as PoolClient;
  const facts = {
    evaluatePosts: async (ids: string[]) => {
      batches.push(ids.length);
      assert.ok(ids.length <= DISCOVERY_COUNT_BATCH);
      return {
        optionalUntil: state.until,
        mediaRequired: ids.some((id) => state.images.has(id)),
        facts: new Map(
          ids.map((id) => [
            id,
            {
              decision:
                state.unknown === id
                  ? 'unknown'
                  : state.denied.has(id)
                    ? 'deny'
                    : 'allow',
              optionalUntil: state.until,
              post: {
                account_id: owner,
                author_mode: 'named',
                category: 'discussion',
              },
              listing: null,
            },
          ]),
        ),
        dependencies: { contentIds: ids, spaceIds: [], namedAccountIds: [] },
      };
    },
  } as unknown as ContentReviewCountFacade;
  const likes = {} as LikedHistoryRepository;
  const service = new CommunityDiscoveryCounts(facts, likes, {
    PG_POOL_MAX: poolMax,
  });
  startTransactionDeadlines(tx);
  return { owner, source, commands, batches, state, tx, service, likes, facts };
}

test('default scan admits measured work beyond 1500 ms but still expires at 2000 ms', async (t) => {
  let elapsed = 0;
  t.mock.method(performance, 'now', () => elapsed);
  for (const [finishAt, budget, expected] of [
    [1750, undefined, 'known'],
    [2000, undefined, 'unavailable'],
    [1750, 1500, 'unavailable'],
  ] as const) {
    elapsed = 0;
    const f = fixture(1);
    const evaluatePosts = f.facts.evaluatePosts.bind(f.facts);
    f.facts.evaluatePosts = async (...args) => {
      const result = await evaluatePosts(...args);
      elapsed = finishAt;
      return result;
    };
    const count = await f.service.profile(
      f.owner,
      null,
      'posts',
      f.tx,
      undefined,
      budget,
    );
    assert.equal(count.status, expected);
    assert.equal(count.value, expected === 'known' ? 1 : null);
    if (expected === 'unavailable')
      assert.ok(
        f.commands.some(
          (item) =>
            item.sql === 'ROLLBACK TO SAVEPOINT discovery_optional_count',
        ),
      );
    clearTransactionDeadlines(f.tx);
  }
});

test('exact optional count streams above 1024 in bounded canonical batches and carries microseconds', async () => {
  const f = fixture(4097);
  const count = await f.service.profile(f.owner, null, 'posts', f.tx);
  assert.equal(count.status, 'known');
  assert.equal(count.value, 4097);
  assert.equal(f.batches.length, 17);
  assert.equal(f.batches.at(-1), 1);
  const candidates = f.commands.filter((item) =>
    item.sql.includes('FROM whaleu_community.posts'),
  );
  assert.equal(candidates.length, 17);
  assert.equal(candidates[1]!.values?.[2], '2001-01-01T00:00:00.123456Z');
  let invalidated = false;
  bindDiscoveryCount(f.tx, count, () => {
    invalidated = true;
  });
  await checkTransactionDeadlines(f.tx);
  assert.equal(invalidated, false);
  assert.ok(
    f.commands.some((item) =>
      item.sql.includes('pg_try_advisory_xact_lock_shared'),
    ),
  );
  assert.equal(f.commands.at(-1)!.sql, 'SELECT clock_timestamp() AS now');
  clearTransactionDeadlines(f.tx);
});

test('late unknown never publishes a positive prefix; optional rollback preserves mandatory deadlines', async () => {
  const f = fixture();
  f.state.unknown = f.source.at(-1)!.id;
  registerTransactionDeadline(f.tx, 500, 'SESSION_REVOKED');
  const count = await f.service.profile(f.owner, null, 'posts', f.tx);
  assert.deepEqual(count, {
    status: 'unavailable',
    value: null,
    optionalUntil: null,
  });
  assert.deepEqual(
    [...checkpointTransactionDeadlines(f.tx)],
    [['SESSION_REVOKED', 500]],
  );
  assert.ok(
    f.commands.some(
      (item) => item.sql === 'ROLLBACK TO SAVEPOINT discovery_optional_count',
    ),
  );
  clearTransactionDeadlines(f.tx);
});

test('durable positive counts still invalidate after a changed mutation epoch beyond the small bound', async () => {
  for (const size of [1025, 4097]) {
    const f = fixture(size);
    const count = await f.service.profile(f.owner, null, 'posts', f.tx);
    assert.equal(count.value, size);
    let invalidated = false;
    bindDiscoveryCount(f.tx, count, () => {
      invalidated = true;
    });
    f.state.epoch = '2';
    await checkTransactionDeadlines(f.tx);
    assert.equal(invalidated, true);
    assert.ok(
      f.commands.some(
        (item) =>
          item.sql === 'ROLLBACK TO SAVEPOINT optional_final_count_proof',
      ),
    );
    clearTransactionDeadlines(f.tx);
  }
});

test('known denial horizons remain optional proof dependencies and expire at the final clock', async () => {
  const f = fixture(1);
  f.state.denied.add(f.source[0]!.id);
  f.state.until = 100;
  const count = await f.service.profile(f.owner, null, 'posts', f.tx);
  assert.equal(count.value, 0);
  assert.equal(count.optionalUntil, 100);
  let invalidated = false;
  bindDiscoveryCount(f.tx, count, () => {
    invalidated = true;
  });
  await checkTransactionDeadlines(f.tx);
  assert.equal(invalidated, true);
  clearTransactionDeadlines(f.tx);
});

test('count-only SQL cancellation recovers but unexpected errors and rollback failure stay fatal', async () => {
  for (const code of ['57014', '55P03', '53400']) {
    const f = fixture(1);
    f.state.failure = Object.assign(
      new Error('synthetic count resource failure'),
      { code },
    );
    assert.equal(
      (await f.service.profile(f.owner, null, 'posts', f.tx)).status,
      'unavailable',
    );
    clearTransactionDeadlines(f.tx);
  }
  const f = fixture(1);
  f.state.failure = Object.assign(new Error('synthetic integrity failure'), {
    code: '23514',
  });
  await assert.rejects(
    f.service.profile(f.owner, null, 'posts', f.tx),
    /integrity failure/,
  );
  clearTransactionDeadlines(f.tx);
  const broken = fixture(1);
  broken.state.failure = Object.assign(new Error('cancelled'), {
    code: '57014',
  });
  broken.state.failRollback = true;
  await assert.rejects(
    broken.service.profile(broken.owner, null, 'posts', broken.tx),
    /rollback failed/,
  );
  clearTransactionDeadlines(broken.tx);
});

test('nonpositive budget never begins source work or returns a false empty count', async () => {
  const f = fixture(1);
  const count = await f.service.profile(
    f.owner,
    null,
    'posts',
    f.tx,
    undefined,
    0,
  );
  assert.equal(count.status, 'unavailable');
  assert.equal(f.commands.length, 0);
  clearTransactionDeadlines(f.tx);
});

test('small counts survive unrelated committed epoch churn with an independent final complete proof', async () => {
  for (const size of [0, 200, 1024]) {
    const f = fixture(size);
    const count = await f.service.profile(f.owner, null, 'posts', f.tx);
    assert.equal(count.value, size);
    let invalidated = false;
    bindDiscoveryCount(f.tx, count, () => {
      invalidated = true;
    });
    f.state.epoch = '2';
    await checkTransactionDeadlines(f.tx);
    assert.equal(invalidated, false);
    assert.ok(f.commands.some((item) => item.sql.includes('LOCK TABLE')));
    clearTransactionDeadlines(f.tx);
  }
});

test('small final recount does not reuse a stale zero and checks newly consulted expiry', async () => {
  const empty = fixture(0);
  const zero = await empty.service.profile(
    empty.owner,
    null,
    'posts',
    empty.tx,
  );
  let stale = false;
  bindDiscoveryCount(empty.tx, zero, () => {
    stale = true;
  });
  empty.state.epoch = '2';
  empty.source.push({
    id: randomUUID(),
    scan_at: '2001-01-01T00:00:00.123456Z',
  });
  await checkTransactionDeadlines(empty.tx);
  assert.equal(stale, true);
  clearTransactionDeadlines(empty.tx);

  const f = fixture(1);
  const count = await f.service.profile(f.owner, null, 'posts', f.tx);
  let expired = false;
  bindDiscoveryCount(f.tx, count, () => {
    expired = true;
  });
  f.state.epoch = '2';
  f.state.until = 100;
  await checkTransactionDeadlines(f.tx);
  assert.equal(expired, true);
  clearTransactionDeadlines(f.tx);
});

test('unsupported optimistic writer capacity retains an independent exact small-count proof', async () => {
  for (const size of [0, 200, 1024, 1025]) {
    const f = fixture(size);
    f.state.writerCapacity = 300;
    const count = await f.service.profile(f.owner, null, 'posts', f.tx);
    assert.equal(count.status, size <= 1024 ? 'known' : 'unavailable');
    assert.equal(count.value, size <= 1024 ? size : null);
    if (size <= 1024) {
      let invalidated = false;
      bindDiscoveryCount(f.tx, count, () => {
        invalidated = true;
      });
      await checkTransactionDeadlines(f.tx);
      assert.equal(invalidated, false);
      assert.ok(f.commands.some((item) => item.sql.includes('LOCK TABLE')));
    }
    clearTransactionDeadlines(f.tx);
  }
});

test('optional scans never consume the only configured database connection', async () => {
  const f = fixture(1, 1);
  const count = await f.service.profile(f.owner, null, 'posts', f.tx);
  assert.equal(count.status, 'unavailable');
  assert.equal(f.commands.length, 0);
  clearTransactionDeadlines(f.tx);
});

test('a missing or malformed timestamp coordinate cannot become premature exact exhaustion', async () => {
  for (const time of [
    null,
    'infinity',
    '2001-01-01T00:00:00.123Z',
    '10000-01-01T00:00:00.123456Z',
  ]) {
    const f = fixture(1025);
    Object.assign(f.source[255]!, { scan_at: time });
    const count = await f.service.profile(f.owner, null, 'posts', f.tx);
    assert.equal(count.status, 'unavailable');
    assert.equal(count.value, null);
    clearTransactionDeadlines(f.tx);
  }
});

test('unsupported liked Date coordinates are optional uncertainty, never RangeError or guessed zero', async () => {
  for (const liked_at of [
    new Date(NaN),
    new Date('-000001-01-01T00:00:00.000Z'),
    new Date('0000-01-01T00:00:00.000Z'),
    new Date('+010000-01-01T00:00:00.000Z'),
  ]) {
    const f = fixture(0);
    f.likes.candidates = async () => [
      {
        kind: 'post',
        target_id: randomUUID(),
        post_id: randomUUID(),
        root_comment_id: null,
        like_id: randomUUID(),
        liked_at,
      },
    ];
    const count = await f.service.liked(f.owner, f.tx);
    assert.equal(count.status, 'unavailable');
    assert.equal(count.value, null);
    clearTransactionDeadlines(f.tx);
  }
});

test('late image batch uses Media vector captured before the first candidate and invalidates on Media-only churn', async () => {
  const f = fixture(4097);
  f.state.images.add(f.source.at(-1)!.id);
  const count = await f.service.profile(f.owner, null, 'posts', f.tx);
  assert.equal(count.value, 4097);
  const early = f.commands.findIndex((entry) =>
    entry.sql.includes('FROM whaleu_media.media_owner_states'),
  );
  const candidates = f.commands.findIndex((entry) =>
    entry.sql.includes('FROM whaleu_community.posts'),
  );
  assert.ok(early >= 0 && early < candidates);
  let invalidated = false;
  bindDiscoveryCount(f.tx, count, () => {
    invalidated = true;
  });
  f.state.mediaEpoch = '2';
  await checkTransactionDeadlines(f.tx);
  assert.equal(invalidated, true);
  clearTransactionDeadlines(f.tx);
});

test('missing Media capture preserves only a fully scanned text-only total, never a first-batch guess', async () => {
  for (const image of [false, true]) {
    const f = fixture(4097);
    f.state.mediaMissing = true;
    if (image) f.state.images.add(f.source.at(-1)!.id);
    registerTransactionDeadline(f.tx, 500, 'SESSION_REVOKED');
    const count = await f.service.profile(f.owner, null, 'posts', f.tx);
    assert.equal(count.status, image ? 'unavailable' : 'known');
    assert.equal(count.value, image ? null : 4097);
    assert.equal(f.batches.length, 17);
    assert.deepEqual(
      [...checkpointTransactionDeadlines(f.tx)],
      [['SESSION_REVOKED', 500]],
    );
    if (!image) {
      let invalidated = false;
      bindDiscoveryCount(f.tx, count, () => {
        invalidated = true;
      });
      await checkTransactionDeadlines(f.tx);
      assert.equal(invalidated, false);
      assert.equal(
        f.commands.some((entry) =>
          entry.sql.includes('LOCK TABLE whaleu_media'),
        ),
        false,
      );
    }
    clearTransactionDeadlines(f.tx);
  }
});

test('unsupported writer capacity permits image counts only under complete Media source fences before fresh rescan', async () => {
  for (const fenced of [true, false]) {
    const f = fixture(200);
    f.state.writerCapacity = 300;
    f.state.images.add(f.source[0]!.id);
    f.state.mediaFence = fenced;
    const count = await f.service.profile(f.owner, null, 'posts', f.tx);
    assert.equal(count.value, 200);
    let invalidated = false;
    bindDiscoveryCount(f.tx, count, () => {
      invalidated = true;
    });
    const before = f.commands.length;
    await checkTransactionDeadlines(f.tx);
    assert.equal(invalidated, !fenced);
    const final = f.commands.slice(before);
    const fence = final.findIndex((entry) =>
      entry.sql.includes('LOCK TABLE whaleu_media'),
    );
    const scan = final.findIndex((entry) =>
      entry.sql.includes('FROM whaleu_community.posts'),
    );
    assert.ok(fence >= 0 && scan > fence);
    for (const source of [
      'media_owner_states',
      'bindings',
      'asset_safety_heads',
      'upload_ingress',
      'upload_ingress_writers',
    ])
      assert.ok(final[fence]!.sql.includes(`whaleu_media.${source}`));
    clearTransactionDeadlines(f.tx);
  }
});

test('small text-only fallback can survive a Media conflict, but cannot adopt newly introduced images without the fence', async () => {
  for (const image of [false, true]) {
    const f = fixture(1);
    const count = await f.service.profile(f.owner, null, 'posts', f.tx);
    f.state.epoch = '2';
    f.state.mediaFence = false;
    if (image) f.state.images.add(f.source[0]!.id);
    let invalidated = false;
    bindDiscoveryCount(f.tx, count, () => {
      invalidated = true;
    });
    await checkTransactionDeadlines(f.tx);
    assert.equal(invalidated, image);
    clearTransactionDeadlines(f.tx);
  }
});
