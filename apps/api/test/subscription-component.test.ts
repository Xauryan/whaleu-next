import type { SubscriptionComponentRepository } from '../src/community/subscription-component/repository.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PoolClient } from 'pg';
import { loadConfig } from '../src/config/config.js';
import type { DatabaseService } from '../src/database/database.js';
import {
  parseSubscriptionCommand,
  subscriptionWorkerSchema,
} from '../src/community/subscription-component/contracts.js';
import type { SubscriptionSource } from '../src/community/subscription-component/contracts.js';
import {
  SubscriptionComponentSettlement,
  subscriptionAfterCount,
} from '../src/community/subscription-component/settlement.js';
import {
  SubscriptionComponentWorker,
  assertLocalSubscriptionWorker,
  assertLocalSubscriptionConnection,
} from '../src/community/subscription-component/worker.js';
const id = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const config = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://localhost/whaleu_test',
});
const source: SubscriptionSource = {
  obligation_id: id,
  epoch_id: id,
  transition: 'saved',
  post_id: id,
  actor_id: other,
  source_sequence: '9007199254740993',
  delta: 1,
  status: 'pending',
  source_valid: true,
};
test('subscription selection is explicit, bounded, strict and duplicate-free', () => {
  assert.deepEqual(parseSubscriptionCommand([]), {
    mode: 'dry-run',
    obligationIds: [],
  });
  assert.equal(
    parseSubscriptionCommand([`--obligation-id=${id}`]).mode,
    'dry-run',
  );
  assert.equal(
    parseSubscriptionCommand(['apply', `--obligation-id=${id}`]).mode,
    'apply',
  );
  for (const args of [
    ['apply'],
    ['--all'],
    ['apply', '--import=x'],
    [`--obligation-id=${id}`, `--obligation-id=${id}`],
    ['--obligation-id=no'],
  ])
    assert.throws(() => parseSubscriptionCommand(args));
  assert.throws(() =>
    subscriptionWorkerSchema.parse({ obligationIds: Array(51).fill(id) }),
  );
  assert.throws(() => subscriptionWorkerSchema.parse({ all: true }));
});
test('subscription count arithmetic retains bigint precision and rejects invalid membership without clamping', () => {
  assert.equal(
    subscriptionAfterCount(
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
    subscriptionAfterCount(
      { ...source, transition: 'unsaved', delta: -1 },
      { count: '0', last_sequence: '0', last_receipt_id: null },
      { active_epoch_id: id, last_sequence: '1', last_receipt_id: id },
    ),
  );
  assert.throws(() =>
    subscriptionAfterCount(
      { ...source, transition: 'unsaved', delta: -1 },
      { count: '1', last_sequence: '0', last_receipt_id: null },
      { active_epoch_id: other, last_sequence: '1', last_receipt_id: id },
    ),
  );
  assert.throws(() =>
    subscriptionAfterCount(
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
    subscriptionAfterCount(
      source,
      { count: '1', last_sequence: '0', last_receipt_id: null },
      { active_epoch_id: id, last_sequence: '1', last_receipt_id: id },
    ),
  );
});
test('subscription processing rejects production, remote URL and non-disposable database', () => {
  for (const changed of [
    { NODE_ENV: 'production' as const },
    { DATABASE_URL: 'postgres://remote/whaleu_test' },
    { DATABASE_URL: 'postgres://localhost/real_database' },
  ])
    assert.throws(() =>
      assertLocalSubscriptionWorker({ ...config, ...changed }),
    );
});
test('subscription actual socket and database are checked', async () => {
  const tx = (peer: string, name: string) =>
    ({
      host: 'localhost',
      connection: { stream: { remoteAddress: peer } },
      query: async () => ({ rows: [{ name }] }),
    }) as unknown as PoolClient;
  await assertLocalSubscriptionConnection(tx('::1', 'whaleu_test'));
  await assert.rejects(
    assertLocalSubscriptionConnection(tx('10.0.0.1', 'whaleu_test')),
  );
  await assert.rejects(
    assertLocalSubscriptionConnection(tx('127.0.0.1', 'not_disposable')),
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
  } as SubscriptionComponentSettlement;
  const result = await new SubscriptionComponentWorker(
    config,
    db,
    settlement,
  ).run({ obligationIds: [id, other] });
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

test('settlement acquires parent before state, membership and obligation, and only selected ranking effect', async () => {
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
    lockObligation: async () => {
      calls.push('obligation');
    },
    receipt: async () => false,
    first: async () => source.source_sequence,
  } as unknown as SubscriptionComponentRepository;
  const queries: string[] = [];
  const tx = {
    query: async (sql: string) => {
      queries.push(sql);
      return { rows: [] };
    },
  } as unknown as PoolClient;
  assert.equal(
    await new SubscriptionComponentSettlement(records).process(id, tx, true),
    'applied',
  );
  assert.deepEqual(calls, [
    'reference',
    'post',
    'reference',
    'state',
    'membership',
    'obligation',
  ]);
  assert.equal(queries.length, 4);
  assert.match(
    queries[0]!,
    /INSERT INTO whaleu_post_hotness.subscription_receipts/,
  );
  assert.match(queries[3]!, /action='save_ranking'/);
  assert.equal(
    queries.some((x) => /experience|author_interactions|reward/.test(x)),
    false,
  );
});
