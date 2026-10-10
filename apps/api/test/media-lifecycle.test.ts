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
function fakeTx(replies: unknown[][]) {
  const calls: { sql: string; values: unknown[] }[] = [];
  const tx = {
    async query(sql: string, values: unknown[] = []) {
      calls.push({ sql, values });
      return { rows: replies.shift() ?? [] };
    },
  } as unknown as PoolClient;
  return { tx, calls };
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
      assert.equal(calls.length, 1);
      assert.match(calls[0]!.sql, /id=\$1 AND actor_id=\$2/);
      assert.deepEqual(calls[0]!.values, ['intent', 'actor']);
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
      calls[1]!.sql,
      /source_version IS NOT NULL AND sealed_version IS NOT NULL/,
    );
    assert.equal(calls.length, 2);
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
    assert.equal(calls.length, 3);
    assert.match(calls[1]!.sql, /ORDER BY id FOR UPDATE/);
    assert.match(calls[2]!.sql, /FOR SHARE OF b/);
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
    assert.equal(calls.length, 1);
  } finally {
    clearTransactionDeadlines(tx);
  }
});

test('settlement includes generation, token, nonexpired lease CAS and bounded retry', async () => {
  const { tx, calls } = fakeTx([[{ ...intent, state: 'sealing' }], []]);
  startTransactionDeadlines(tx);
  try {
    assert.equal(await repository.settleJob(lease, 'retryable', tx), false);
    assert.match(calls[1]!.sql, /expected_generation=\$3 AND lease_token=\$4/);
    assert.match(calls[1]!.sql, /lease_until>clock_timestamp\(\)/);
    assert.equal(calls[1]!.values[5], 5);
  } finally {
    clearTransactionDeadlines(tx);
  }
});

test('cleanup success requires explicit confirmed absence and expired fifth leases become unresolved', async () => {
  const { tx, calls } = fakeTx([[], [], []]);
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
    assert.match(calls[0]!.sql, /attempt>=\$4 THEN 'retained'/);
    assert.match(calls[0]!.sql, /lease_until>clock_timestamp\(\)/);
    await repository.exhaustExpiredLeases(tx);
    assert.ok(
      calls
        .slice(1)
        .every((c) => c.values[0] === 5 && c.sql.includes('LIMIT 100')),
    );
  } finally {
    clearTransactionDeadlines(tx);
  }
});

test('confirmed absence without quiescence proof is retained, never marked deleted', async () => {
  const { tx, calls } = fakeTx([[]]);
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
    assert.equal(calls[0]!.values[2], 'unresolved');
    assert.match(calls[0]!.sql, /\$3='unresolved'/);
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
    assert.equal(calls.length, 3);
    assert.ok(calls.every((c) => !/UPDATE whaleu|INSERT INTO/.test(c.sql)));
  } finally {
    clearTransactionDeadlines(tx);
  }
});

test('expiry collects only never-bound ready assets after 24 hours and preserves cleanup causality', async () => {
  for (const state of ['ready', 'processing']) {
    const { tx, calls } = fakeTx([[{ id: 'intent', state }]]);
    startTransactionDeadlines(tx);
    try {
      assert.equal(await repository.expireOne(tx), true);
      assert.match(calls[0]!.sql, /interval '24 hours'/);
      assert.match(
        calls[0]!.sql,
        /NOT EXISTS \(SELECT 1 FROM whaleu_media.bindings/,
      );
      assert.match(calls[0]!.sql, /FOR UPDATE OF i SKIP LOCKED LIMIT 1/);
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
