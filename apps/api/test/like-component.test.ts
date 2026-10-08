import type { LikeComponentRepository } from '../src/community/like-component/repository.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PoolClient } from 'pg';
import { loadConfig } from '../src/config/config.js';
import type { DatabaseService } from '../src/database/database.js';
import {
  parseLikeCommand,
  likeWorkerSchema,
} from '../src/community/like-component/contracts.js';
import type { LikeSource } from '../src/community/like-component/contracts.js';
import {
  LikeComponentSettlement,
  likeAfterCount,
} from '../src/community/like-component/settlement.js';
import {
  LikeComponentWorker,
  assertLocalLikeWorker,
  assertLocalLikeConnection,
} from '../src/community/like-component/worker.js';
const id = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const config = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://localhost/whaleu_test',
});
const source: LikeSource = {
  source_id: id,
  like_id: id,
  transition: 'liked',
  post_id: id,
  actor_id: other,
  source_sequence: '9007199254740993',
  delta: 1,
  positive_source_id: null,
};
test('like selection is explicit, bounded, strict and duplicate-free', () => {
  assert.deepEqual(parseLikeCommand([]), {
    mode: 'dry-run',
    sourceIds: [],
  });
  assert.equal(parseLikeCommand([`--source-id=${id}`]).mode, 'dry-run');
  assert.equal(parseLikeCommand(['apply', `--source-id=${id}`]).mode, 'apply');
  for (const args of [
    ['apply'],
    ['--all'],
    ['apply', '--import=x'],
    [`--source-id=${id}`, `--source-id=${id}`],
    ['--source-id=no'],
  ])
    assert.throws(() => parseLikeCommand(args));
  assert.throws(() =>
    likeWorkerSchema.parse({ sourceIds: Array(51).fill(id) }),
  );
  assert.throws(() => likeWorkerSchema.parse({ all: true }));
});
test('like count arithmetic retains bigint precision and rejects invalid membership without clamping', () => {
  assert.equal(
    likeAfterCount(
      source,
      {
        count: '9007199254740993',
        last_sequence: '9007199254740992',
        last_receipt_id: null,
      },
      null,
    ),
    '9007199254740994',
  );
  assert.throws(() =>
    likeAfterCount(
      { ...source, transition: 'unliked', delta: -1 },
      { count: '0', last_sequence: '0', last_receipt_id: null },
      { active_like_id: id, last_sequence: '1', last_receipt_id: id },
    ),
  );
  assert.throws(() =>
    likeAfterCount(
      { ...source, transition: 'unliked', delta: -1 },
      { count: '1', last_sequence: '0', last_receipt_id: null },
      { active_like_id: other, last_sequence: '1', last_receipt_id: id },
    ),
  );
  assert.throws(() =>
    likeAfterCount(
      source,
      {
        count: '1',
        last_sequence: source.source_sequence!,
        last_receipt_id: null,
      },
      null,
    ),
  );
  assert.throws(() =>
    likeAfterCount(
      source,
      { count: '1', last_sequence: '0', last_receipt_id: null },
      { active_like_id: id, last_sequence: '1', last_receipt_id: id },
    ),
  );
});
test('like processing rejects production, remote URL and non-disposable database', () => {
  for (const changed of [
    { NODE_ENV: 'production' as const },
    { DATABASE_URL: 'postgres://remote/whaleu_test' },
    { DATABASE_URL: 'postgres://localhost/real_database' },
  ])
    assert.throws(() => assertLocalLikeWorker({ ...config, ...changed }));
});
test('like actual socket and database are checked', async () => {
  const tx = (peer: string, name: string) =>
    ({
      host: 'localhost',
      connection: { stream: { remoteAddress: peer } },
      query: async () => ({ rows: [{ name }] }),
    }) as unknown as PoolClient;
  await assertLocalLikeConnection(tx('::1', 'whaleu_test'));
  await assert.rejects(
    assertLocalLikeConnection(tx('10.0.0.1', 'whaleu_test')),
  );
  await assert.rejects(
    assertLocalLikeConnection(tx('127.0.0.1', 'not_disposable')),
  );
});
test('dry-run sets read-only before inspection; independent failures do not starve later explicit IDs', async () => {
  const queries: string[] = [];
  const tx = {
    host: 'localhost',
    connection: { stream: { remoteAddress: '127.0.0.1' } },
    query: async (sql: string) => {
      queries.push(sql);
      return { rows: [{ name: 'whaleu_test' }] };
    },
  } as unknown as PoolClient;
  const db = {
    transaction: async (fn: (tx: PoolClient) => Promise<unknown>) => fn(tx),
  } as DatabaseService;
  const settlement = {
    process: async (selected: string, _tx: PoolClient, apply: boolean) => {
      assert.equal(apply, false);
      if (selected === id) throw new Error('busy');
      return 'pending';
    },
  } as LikeComponentSettlement;
  const result = await new LikeComponentWorker(config, db, settlement).run({
    sourceIds: [id, other],
  });
  assert.equal(result.failed, 1);
  assert.equal(result.pending, 1);
  assert.equal(result.advisory, true);
  assert.deepEqual(queries, [
    'SET TRANSACTION READ ONLY',
    'SELECT current_database() AS name',
    'SET TRANSACTION READ ONLY',
    'SELECT current_database() AS name',
  ]);
});

test('settlement acquires parent before state and membership, and only selected like effect', async () => {
  const calls: string[] = [];
  const records = {
    reference: async () => {
      calls.push('reference');
      return source;
    },
    lockPost: async () => {
      calls.push('post');
    },
    known: async () => true,
    state: async () => {
      calls.push('state');
      return { count: '0', last_sequence: '0', last_receipt_id: null };
    },
    membership: async () => {
      calls.push('membership');
      return null;
    },
    receipt: async () => false,
    first: async () => source.source_sequence,
  } as unknown as LikeComponentRepository;
  const queries: string[] = [];
  const tx = {
    query: async (sql: string) => {
      queries.push(sql);
      return { rows: [] };
    },
  } as unknown as PoolClient;
  assert.equal(
    await new LikeComponentSettlement(records).process(id, tx, true),
    'applied',
  );
  assert.deepEqual(calls, [
    'reference',
    'post',
    'reference',
    'state',
    'membership',
  ]);
  assert.equal(queries.length, 3);
  assert.match(queries[0]!, /INSERT INTO whaleu_post_hotness.like_receipts/);
  assert.match(queries[2]!, /like_memberships/);
  assert.equal(
    queries.some((x) => /experience|author_interactions|reward/.test(x)),
    false,
  );
});

function settlementFixture(
  options: {
    receipt?: boolean;
    first?: string;
    known?: boolean;
    missing?: boolean;
  } = {},
) {
  const calls: string[] = [];
  const records = {
    reference: async () => (options.missing ? null : source),
    lockPost: async () => {
      calls.push('post-lock');
    },
    known: async () => options.known ?? true,
    state: async (_post: string, _tx: PoolClient, lock: boolean) => {
      calls.push(lock ? 'state-lock' : 'state-read');
      return {
        count: '7',
        last_sequence: options.receipt ? '9999999999999999' : '0',
        last_receipt_id: other,
      };
    },
    membership: async (
      _post: string,
      _actor: string,
      _tx: PoolClient,
      lock: boolean,
    ) => {
      calls.push(lock ? 'member-lock' : 'member-read');
      return null;
    },
    receipt: async () => options.receipt ?? false,
    first: async () => options.first ?? source.source_sequence,
  } as unknown as LikeComponentRepository;
  const tx = {
    query: async (sql: string) => {
      calls.push(sql);
      return { rows: [] };
    },
  } as unknown as PoolClient;
  return { calls, tx, settlement: new LikeComponentSettlement(records) };
}
test('old completed source replay does not validate against or mutate a newer head', async () => {
  const f = settlementFixture({ receipt: true });
  assert.equal(await f.settlement.process(id, f.tx, true), 'alreadyCompleted');
  assert.deepEqual(f.calls, ['post-lock', 'state-lock', 'member-lock']);
});
test('dry-run settlement uses no row locks or writes and missing/predecessor/baseline cases are explicit', async () => {
  const f = settlementFixture();
  assert.equal(await f.settlement.process(id, f.tx, false), 'pending');
  assert.deepEqual(f.calls, ['state-read', 'member-read']);
  for (const [options, expected] of [
    [{ missing: true }, 'missing'],
    [{ known: false }, 'blockedBaseline'],
    [{ first: '1' }, 'blockedPredecessor'],
  ] as const) {
    const g = settlementFixture(options);
    assert.equal(await g.settlement.process(id, g.tx, false), expected);
    assert.equal(
      g.calls.some((call) => /lock|INSERT|UPDATE/.test(call)),
      false,
    );
  }
});
test('like/unlike/re-like retains causal epochs without depending on current live rows', () => {
  const head = (count: string, sequence: string) => ({
    count,
    last_sequence: sequence,
    last_receipt_id: id,
  });
  const member = (active: string | null, sequence: string) => ({
    active_like_id: active,
    last_sequence: sequence,
    last_receipt_id: id,
  });
  assert.equal(
    likeAfterCount({ ...source, source_sequence: '1' }, head('0', '0'), null),
    '1',
  );
  const unlike: LikeSource = {
    ...source,
    source_sequence: '3',
    transition: 'unliked',
    delta: -1,
    positive_source_id: id,
  };
  assert.equal(likeAfterCount(unlike, head('1', '1'), member(id, '1')), '0');
  assert.equal(
    likeAfterCount(
      { ...source, like_id: other, source_sequence: '5' },
      head('0', '3'),
      member(null, '3'),
    ),
    '1',
  );
  assert.throws(() =>
    likeAfterCount(
      { ...unlike, source_sequence: '6' },
      head('1', '5'),
      member(other, '5'),
    ),
  );
});
test('disabled apply is rejected before obtaining a transaction', async () => {
  const db = {
    transaction: async () => {
      throw new Error('must not connect');
    },
  } as unknown as DatabaseService;
  await assert.rejects(
    new LikeComponentWorker(
      { ...config, LIKE_COMPONENT_PROCESSING: 'disabled' },
      db,
      {} as LikeComponentSettlement,
    ).run({
      mode: 'apply',
      sourceIds: [id],
    }),
    /Like processing is disabled/,
  );
});
