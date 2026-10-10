import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { MediaLifecycleRepository } from '../src/media/lifecycle-repository.js';
import type { MediaJobLease } from '../src/media/lifecycle-repository.js';
import {
  startTransactionDeadlines,
  clearTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';

// Query-shape unit specifications only. They do not substitute for PostgreSQL
// trigger, real crash recovery, concurrent cancellation or storage-effect tests.
function fakeTx(
  replies: unknown[][],
  coordination: {
    batchId?: string;
    batchLockReplies?: unknown[][];
  } = {},
) {
  const calls: { sql: string; values: unknown[] }[] = [];
  const tx = {
    async query(sql: string, values: unknown[] = []) {
      // Retain every query, including the coordinator's lock/savepoint calls.
      // These legacy fixtures have no batch unless explicitly declared below;
      // coordination reads must not consume the lifecycle result queue.
      calls.push({ sql, values: structuredClone(values) });
      let rows: unknown[];
      if (sql.includes('SELECT b.id FROM whaleu_media.publication_batches')) {
        rows = coordination.batchId ? [{ id: coordination.batchId }] : [];
      } else if (
        sql ===
        'SELECT batch_id FROM whaleu_media.publication_batch_members WHERE intent_id=$1'
      ) {
        rows = coordination.batchId ? [{ batch_id: coordination.batchId }] : [];
      } else if (
        sql ===
        'SELECT id FROM whaleu_media.publication_batches WHERE id=$1 FOR UPDATE SKIP LOCKED'
      ) {
        assert.ok(
          coordination.batchId,
          'A batch lock requires a recorded mapping',
        );
        rows = coordination.batchLockReplies?.shift() ?? [
          { id: coordination.batchId },
        ];
      } else if (
        /^(SAVEPOINT|ROLLBACK TO SAVEPOINT|RELEASE SAVEPOINT) media_batch_candidate$/.test(
          sql,
        )
      ) {
        rows = [];
      } else {
        rows = replies.shift() ?? [];
      }
      return { rows, rowCount: rows.length };
    },
  } as unknown as PoolClient;
  return { tx, calls };
}
function assertBatchBeforeIntent(
  calls: { sql: string; values: unknown[] }[],
  batchIndex: number,
) {
  assert.match(calls[batchIndex]!.sql, /FROM whaleu_media.publication_batches/);
  assert.match(calls[batchIndex]!.sql, /m.intent_id=ANY\(\$1::uuid\[\]\)/);
  assert.match(calls[batchIndex]!.sql, /ORDER BY b.id FOR UPDATE OF b/);
  assert.deepEqual(calls[batchIndex]!.values, [['intent']]);
  assert.match(
    calls[batchIndex + 1]!.sql,
    /FROM whaleu_media.upload_intents WHERE id=\$1/,
  );
  assert.match(calls[batchIndex + 1]!.sql, /FOR UPDATE/);
}
const repository = new MediaLifecycleRepository();
const intent = {
  id: 'intent',
  state: 'prepared',
  generation: '1',
  expires_at: new Date('2030-01-01'),
  expired: false,
};
const lease: MediaJobLease = {
  id: 'job',
  intentId: 'intent',
  kind: 'seal',
  generation: '1',
  token: 'token',
  attempt: 1,
  objectAttemptId: 'attempt',
};

test('lifecycle rejects unmanaged transactions before any database access', async () => {
  const { tx, calls } = fakeTx([]);
  await assert.rejects(repository.status('actor', 'intent', tx));
  await assert.rejects(repository.cancel('actor', 'intent', tx));
  await assert.rejects(repository.claimJob('seal', tx));
  await assert.rejects(repository.claimCleanup(tx));
  assert.equal(calls.length, 0);
});

test('status and terminal finalize remain actor-scoped and never advertise readiness', async () => {
  for (const state of [
    'cancelled',
    'expired',
    'rejected',
    'ready',
    'deleted',
  ]) {
    const { tx, calls } = fakeTx([[{ ...intent, state }]]);
    startTransactionDeadlines(tx);
    try {
      const receipt = await repository.finalize('actor', 'intent', tx);
      assert.notEqual(receipt.status, 'ready');
      assert.equal(calls.length, 2);
      assertBatchBeforeIntent(calls, 0);
      assert.match(calls[1]!.sql, /id=\$1 AND actor_id=\$2/);
      assert.deepEqual(calls[1]!.values, ['intent', 'actor']);
    } finally {
      clearTransactionDeadlines(tx);
    }
  }
});

test('finalize requires an already observed exact source and planned exact destination', async () => {
  const { tx, calls } = fakeTx([[intent], []]);
  startTransactionDeadlines(tx);
  try {
    await assert.rejects(repository.finalize('actor', 'intent', tx));
    assert.match(
      calls[2]!.sql,
      /source_version IS NOT NULL AND sealed_version IS NOT NULL/,
    );
    assert.equal(calls.length, 3);
    assertBatchBeforeIntent(calls, 0);
  } finally {
    clearTransactionDeadlines(tx);
  }
});

test('cancel rejects any bound asset before staging cleanup or revoking jobs', async () => {
  const { tx, calls } = fakeTx([
    [intent],
    [{ id: 'asset' }],
    [{ id: 'binding' }],
  ]);
  startTransactionDeadlines(tx);
  try {
    await assert.rejects(repository.cancel('actor', 'intent', tx));
    assert.equal(calls.length, 4);
    assertBatchBeforeIntent(calls, 0);
    assert.match(calls[2]!.sql, /ORDER BY id FOR UPDATE/);
    assert.match(calls[3]!.sql, /FOR SHARE OF b/);
  } finally {
    clearTransactionDeadlines(tx);
  }
});

test('cancel stages exact obligations before generation revocation and clears all job leases', async () => {
  const { tx, calls } = fakeTx([
    [{ ...intent, state: 'processing' }],
    [],
    [],
    [],
    [],
    [],
    [],
  ]);
  startTransactionDeadlines(tx);
  try {
    assert.equal(
      (await repository.cancel('actor', 'intent', tx)).status,
      'cancelled',
    );
    assertBatchBeforeIntent(calls, 0);
    const inserts = calls.filter((c) =>
      c.sql.includes('INSERT INTO whaleu_media.cleanup_obligations'),
    );
    assert.equal(inserts.length, 3);
    assert.match(inserts[1]!.sql, /derived_attempt_id/);
    assert.match(inserts[0]!.sql, /o.version IS NOT NULL/);
    const revoke = calls.findIndex((c) =>
      c.sql.includes('generation=generation+1'),
    );
    assert.ok(revoke > calls.indexOf(inserts[2]!));
    assert.match(calls[revoke + 1]!.sql, /lease_token=NULL,lease_until=NULL/);
  } finally {
    clearTransactionDeadlines(tx);
  }
});

test('stale generation settlement cannot mutate any job', async () => {
  const { tx, calls } = fakeTx([
    [{ ...intent, state: 'sealing', generation: '2' }],
  ]);
  startTransactionDeadlines(tx);
  try {
    assert.equal(await repository.settleJob(lease, 'succeeded', tx), false);
    assert.equal(calls.length, 2);
    assertBatchBeforeIntent(calls, 0);
  } finally {
    clearTransactionDeadlines(tx);
  }
});

test('settlement includes generation, token, nonexpired lease CAS and bounded retry', async () => {
  const { tx, calls } = fakeTx([[{ ...intent, state: 'sealing' }], []]);
  startTransactionDeadlines(tx);
  try {
    assert.equal(await repository.settleJob(lease, 'retryable', tx), false);
    assertBatchBeforeIntent(calls, 0);
    assert.match(calls[2]!.sql, /expected_generation=\$3 AND lease_token=\$4/);
    assert.match(calls[2]!.sql, /lease_until>clock_timestamp\(\)/);
    assert.equal(calls[2]!.values[5], 5);
  } finally {
    clearTransactionDeadlines(tx);
  }
});

test('cleanup success requires explicit confirmed absence and expired fifth leases become unresolved', async () => {
  const { tx, calls } = fakeTx([
    [{ intent_id: 'intent' }],
    [{ state: 'cancelled' }],
    [],
    [],
    [],
    [],
  ]);
  startTransactionDeadlines(tx);
  try {
    await repository.settleCleanup(
      {
        id: 'cleanup',
        token: 'token',
        attempt: 5,
        object: {
          provider: 'local',
          environment: 'test',
          bucket: 'media',
          key: 'key',
          version: 'v1',
        },
      },
      'retryable',
      tx,
    );
    assertBatchBeforeIntent(calls, 1);
    assert.match(calls[4]!.sql, /attempt>=\$4 THEN 'retained'/);
    assert.match(calls[4]!.sql, /lease_until>clock_timestamp\(\)/);
    await repository.exhaustExpiredLeases(tx);
    assert.ok(
      calls
        .slice(5)
        .every((c) => c.values[0] === 5 && c.sql.includes('LIMIT 100')),
    );
  } finally {
    clearTransactionDeadlines(tx);
  }
});

test('confirmed absence without quiescence proof is retained, never marked deleted', async () => {
  const { tx, calls } = fakeTx([
    [{ intent_id: 'intent' }],
    [{ state: 'cancelled' }],
    [],
    [],
  ]);
  startTransactionDeadlines(tx);
  try {
    await repository.settleCleanup(
      {
        id: 'cleanup',
        token: 'token',
        attempt: 1,
        object: {
          provider: 'local',
          environment: 'test',
          bucket: 'media',
          key: 'key',
          version: 'v1',
        },
      },
      'confirmed-absent',
      tx,
    );
    assertBatchBeforeIntent(calls, 1);
    assert.equal(calls[4]!.values[2], 'unresolved');
    assert.match(calls[4]!.sql, /\$3='unresolved'/);
  } finally {
    clearTransactionDeadlines(tx);
  }
});

test('cleanup quiescence verifies the durable object rather than a forged lease locator', async () => {
  const exact = {
    provider: 'local',
    environment: 'test',
    bucket: 'media',
    key: 'durable',
    version: 'v1',
  };
  const { tx } = fakeTx([
    [{ intent_id: 'intent' }],
    [{ state: 'cancelled' }],
    [],
    [
      {
        provider: exact.provider,
        environment: exact.environment,
        bucket: exact.bucket,
        object_key: exact.key,
        object_version: exact.version,
        settled_state: 'deleted',
        lease_until: new Date('2030-01-01'),
      },
    ],
  ]);
  const proof = Object.freeze({});
  let checked = false;
  const guarded = new MediaLifecycleRepository({
    require(actualProof, object, actualTx) {
      assert.equal(actualProof, proof);
      assert.deepEqual(object, exact);
      assert.equal(actualTx, tx);
      checked = true;
    },
  });
  startTransactionDeadlines(tx);
  try {
    assert.equal(
      await guarded.settleCleanup(
        {
          id: 'cleanup',
          token: 'token',
          attempt: 1,
          object: { ...exact, key: 'forged' },
        },
        'confirmed-absent',
        tx,
        proof,
      ),
      'deleted',
    );
    assert.equal(checked, true);
  } finally {
    clearTransactionDeadlines(tx);
  }
});

test('cancelled intent retries do not increment generation or reallocate effects', async () => {
  const { tx, calls } = fakeTx([[{ ...intent, state: 'cancelled' }], [], []]);
  startTransactionDeadlines(tx);
  try {
    assert.equal(
      (await repository.cancel('actor', 'intent', tx)).status,
      'cancelled',
    );
    assert.equal(calls.length, 4);
    assertBatchBeforeIntent(calls, 0);
    assert.ok(calls.every((c) => !/UPDATE whaleu|INSERT INTO/.test(c.sql)));
  } finally {
    clearTransactionDeadlines(tx);
  }
});

test('expiry collects only never-bound ready assets after 24 hours and preserves cleanup causality', async () => {
  for (const state of ['ready', 'processing']) {
    const { tx, calls } = fakeTx([
      [{ id: 'intent', state }], // Unlocked routing hint.
      [{ id: 'intent', state }], // Exact predicate rechecked under the batch lock.
    ]);
    startTransactionDeadlines(tx);
    try {
      assert.equal(await repository.expireOne(tx), true);
      assert.match(calls[0]!.sql, /interval '24 hours'/);
      assert.match(
        calls[0]!.sql,
        /NOT EXISTS \(SELECT 1 FROM whaleu_media.bindings/,
      );
      assert.doesNotMatch(calls[0]!.sql, /FOR UPDATE/);
      assert.equal(calls[1]!.sql, 'SAVEPOINT media_batch_candidate');
      assert.match(
        calls[2]!.sql,
        /publication_batch_members WHERE intent_id=\$1/,
      );
      assert.deepEqual(calls[2]!.values, ['intent']);
      assert.match(calls[3]!.sql, /FOR UPDATE OF i SKIP LOCKED LIMIT 1/);
      assert.match(calls[3]!.sql, /AND i.id=\$1/);
      assert.deepEqual(calls[3]!.values, ['intent']);
      assert.match(calls[3]!.sql, /interval '24 hours'/);
      assert.match(
        calls[3]!.sql,
        /NOT EXISTS \(SELECT 1 FROM whaleu_media.bindings/,
      );
      assert.equal(calls[4]!.sql, 'RELEASE SAVEPOINT media_batch_candidate');
      const revoke = calls.findIndex((c) =>
        c.sql.includes('generation=generation+1'),
      );
      assert.deepEqual(calls[revoke]!.values, [
        'intent',
        state === 'ready' ? 'cleanup_pending' : 'expired',
      ]);
      assert.equal(
        calls
          .slice(0, revoke)
          .filter((c) =>
            c.sql.includes('INSERT INTO whaleu_media.cleanup_obligations'),
          ).length,
        3,
      );
      assert.match(calls.at(-1)!.sql, /released_at=clock_timestamp\(\)/);
    } finally {
      clearTransactionDeadlines(tx);
    }
  }
});

test('provider absence never overrides a durable unknown ingress writer', async () => {
  const { tx, calls } = fakeTx([
    [{ intent_id: 'intent' }],
    [{ state: 'cancelled' }],
    [{ writer_token: 'unknown' }],
    [],
  ]);
  let verified = false;
  const guarded = new MediaLifecycleRepository({
    require() {
      verified = true;
    },
  });
  startTransactionDeadlines(tx);
  try {
    await guarded.settleCleanup(
      {
        id: 'cleanup',
        token: 'token',
        attempt: 1,
        object: {
          provider: 'local',
          environment: 'test',
          bucket: 'media',
          key: 'key',
          version: 'v1',
        },
      },
      'confirmed-absent',
      tx,
      {},
    );
    assertBatchBeforeIntent(calls, 1);
    assert.equal(calls[4]!.values[2], 'unresolved');
    assert.equal(verified, false);
    assert.match(calls[2]!.sql, /FOR UPDATE/);
    assert.match(calls[3]!.sql, /w.state<>'retired'/);
  } finally {
    clearTransactionDeadlines(tx);
  }
});

test('queue admission skips a busy batch before any intent lock and releases its savepoint', async () => {
  const { tx, calls } = fakeTx(
    [
      [{ id: 'busy', state: 'ready' }],
      [{ id: 'intent', state: 'ready' }],
      [{ id: 'intent', state: 'ready' }],
    ],
    { batchId: 'batch', batchLockReplies: [[], [{ id: 'batch' }]] },
  );
  startTransactionDeadlines(tx);
  try {
    assert.equal(await repository.expireOne(tx), true);
    const hints = calls.filter((call) =>
      call.sql.includes('AND NOT(i.id=ANY('),
    );
    assert.deepEqual(
      hints.map((call) => call.values),
      [[[]], [['busy']]],
    );
    assert.equal(calls[1]!.sql, 'SAVEPOINT media_batch_candidate');
    assert.match(
      calls[3]!.sql,
      /publication_batches WHERE id=\$1 FOR UPDATE SKIP LOCKED/,
    );
    assert.equal(calls[4]!.sql, 'ROLLBACK TO SAVEPOINT media_batch_candidate');
    assert.equal(calls[5]!.sql, 'RELEASE SAVEPOINT media_batch_candidate');
    const locks = calls.filter((call) =>
      /FOR UPDATE OF i SKIP LOCKED/.test(call.sql),
    );
    assert.equal(locks.length, 1);
    assert.deepEqual(locks[0]!.values, ['intent']);
    assert.ok(calls.indexOf(locks[0]!) > calls.indexOf(hints[1]!));
    assert.equal(
      calls.filter((call) =>
        /INSERT INTO whaleu_media.cleanup_obligations/.test(call.sql),
      ).length,
      3,
    );
  } finally {
    clearTransactionDeadlines(tx);
  }
});

test('queue candidate recheck retains job parameters and refuses a changed hint without effects', async () => {
  const { tx, calls } = fakeTx(
    [[{ id: 'intent', expires_at: intent.expires_at }], [], []],
    { batchId: 'batch' },
  );
  startTransactionDeadlines(tx);
  try {
    assert.equal(await repository.claimJob('review', tx), null);
    const hint = calls[0]!;
    assert.deepEqual(hint.values, ['review', 5, []]);
    assert.doesNotMatch(hint.sql, /FOR UPDATE/);
    assert.match(
      calls[3]!.sql,
      /publication_batches WHERE id=\$1 FOR UPDATE SKIP LOCKED/,
    );
    const recheck = calls[4]!;
    assert.match(recheck.sql, /j.kind=\$1/);
    assert.match(recheck.sql, /j.attempt<\$2/);
    assert.match(recheck.sql, /AND i.id=\$3/);
    assert.match(recheck.sql, /FOR UPDATE OF i SKIP LOCKED LIMIT 1/);
    assert.deepEqual(recheck.values, ['review', 5, 'intent']);
    assert.equal(calls[5]!.sql, 'ROLLBACK TO SAVEPOINT media_batch_candidate');
    assert.equal(calls[6]!.sql, 'RELEASE SAVEPOINT media_batch_candidate');
    assert.deepEqual(calls[7]!.values, ['review', 5, ['intent']]);
    assert.ok(calls.every((call) => !/^\s*(UPDATE|INSERT)/.test(call.sql)));
  } finally {
    clearTransactionDeadlines(tx);
  }
});

test('cleanup candidate scan is capped at 128 busy batch hints and never claims an effect', async () => {
  const { tx, calls } = fakeTx(
    Array.from({ length: 128 }, (_, index) => [{ id: `intent-${index}` }]),
    {
      batchId: 'batch',
      batchLockReplies: Array.from({ length: 128 }, () => []),
    },
  );
  startTransactionDeadlines(tx);
  try {
    assert.equal(await repository.claimCleanup(tx), null);
    const hints = calls.filter((call) =>
      call.sql.includes('AND NOT(i.id=ANY('),
    );
    assert.equal(hints.length, 128);
    assert.deepEqual(hints[0]!.values, [5, []]);
    assert.deepEqual(
      hints.map((call) => (call.values[1] as string[]).length),
      Array.from({ length: 128 }, (_, index) => index),
    );
    assert.match(hints[127]!.sql, /c.attempt<\$1/);
    assert.match(hints[127]!.sql, /AND NOT\(i.id=ANY\(\$2::uuid\[\]\)\)/);
    assert.equal(
      calls.filter(
        (call) => call.sql === 'ROLLBACK TO SAVEPOINT media_batch_candidate',
      ).length,
      128,
    );
    assert.equal(
      calls.filter(
        (call) => call.sql === 'RELEASE SAVEPOINT media_batch_candidate',
      ).length,
      128,
    );
    assert.ok(calls.every((call) => !/FOR UPDATE OF i/.test(call.sql)));
    assert.ok(calls.every((call) => !/^\s*(UPDATE|INSERT)/.test(call.sql)));
  } finally {
    clearTransactionDeadlines(tx);
  }
});
