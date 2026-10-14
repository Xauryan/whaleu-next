import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { Pool, PoolClient } from 'pg';
import {
  inTransaction,
  registerFinalTransactionProofStamp,
  consumeCommittedFinalTransactionProofStamp,
  type FinalTransactionProofStamp,
} from '../src/database/database.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
  registerTransactionDeadline,
  checkpointTransactionDeadlines,
  restoreTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
import {
  issueRatingGroupPermit,
  prepareRatingGroupPermit,
  consumeRatingGroupPermit,
} from '../src/notifications/rating-group/permit.js';
import {
  digest,
  type EffectIdentity,
} from '../src/ratings/group-promotion/contracts.js';
import { randomUUID } from 'node:crypto';
function fixture() {
  const commands: string[] = [];
  const state = {
    commitDelay: 0,
    failCommit: false,
    commitAt: 0,
    proofEndedAt: 0,
  };
  const tx = {
    query: async (sql: string) => {
      commands.push(sql);
      if (sql === 'COMMIT') {
        state.commitAt = performance.now();
        await delay(state.commitDelay);
        if (state.failCommit) throw Error('commit failure');
      }
      return {
        rows:
          sql === 'SELECT clock_timestamp() AS now'
            ? [{ now: new Date() }]
            : [],
      };
    },
    release: () => {
      commands.push('release');
    },
  } as unknown as PoolClient;
  const pool = { connect: async () => tx } as unknown as Pick<Pool, 'connect'>;
  return { tx, pool, state, commands };
}
function required(tx: PoolClient, validate: () => Promise<void>) {
  const owner = {
    maximumFacts: 1,
    failureCode: 'PROMOTION_UNAVAILABLE' as const,
    validate,
  };
  enableRequiredTransactionProof(tx, owner);
  registerRequiredTransactionFact(tx, owner, 'one', Object.freeze({}));
}
const binding = 'a'.repeat(64);
test('stamp is created after every final proof and clock check, before COMMIT, and consumed once', async () => {
  const f = fixture();
  const token = await inTransaction(f.pool, async (tx) => {
    required(tx, async () => {
      await delay(120);
      f.state.proofEndedAt = performance.now();
    });
    registerTransactionDeadline(
      tx,
      Date.now() + 10000,
      'PROMOTION_UNAVAILABLE',
    );
    return registerFinalTransactionProofStamp(tx, binding);
  });
  const at = consumeCommittedFinalTransactionProofStamp(token, binding);
  assert.ok(
    at !== null && at >= f.state.proofEndedAt && at <= f.state.commitAt,
  );
  assert.equal(
    consumeCommittedFinalTransactionProofStamp(token, binding),
    null,
  );
  assert.deepEqual(f.commands, [
    'BEGIN',
    'SET CONSTRAINTS ALL IMMEDIATE',
    'SELECT clock_timestamp() AS now',
    'COMMIT',
    'release',
  ]);
});
test('slow COMMIT remains inside the 100ms permit window and cannot freshen it', async () => {
  const f = fixture();
  f.state.commitDelay = 140;
  const identity: EffectIdentity = {
    effectId: randomUUID(),
    attemptId: randomUUID(),
    key: 'b'.repeat(64),
    stage: 'delivery',
    profileId: 'synthetic:rating-group-v1',
    accountLineage: randomUUID(),
    destinationId: randomUUID(),
    inputHash: 'c'.repeat(64),
    payloadHash: 'c'.repeat(64),
    fence: '1',
  };
  const authority = digest('authority');
  const stamp = await inTransaction(f.pool, async (tx) =>
    prepareRatingGroupPermit(tx, identity, authority),
  );
  const permit = issueRatingGroupPermit(stamp);
  assert.ok(permit.expiresAt < performance.now());
  assert.equal(consumeRatingGroupPermit(permit, identity), false);
});
for (const mode of [
  'proof',
  'operation',
  'commit',
  'deadline',
  'savepoint',
] as const)
  test(`failed ${mode} gives no consumable final proof stamp`, async () => {
    const f = fixture();
    let stamp: FinalTransactionProofStamp | undefined;
    await assert.rejects(
      inTransaction(f.pool, async (tx) => {
        stamp = registerFinalTransactionProofStamp(tx, binding);
        if (mode === 'proof')
          required(tx, async () => {
            throw Error('proof failed');
          });
        if (mode === 'operation') throw Error('operation failed');
        if (mode === 'commit') f.state.failCommit = true;
        if (mode === 'deadline')
          registerTransactionDeadline(
            tx,
            Date.now() - 1000,
            'PROMOTION_UNAVAILABLE',
          );
        if (mode === 'savepoint')
          restoreTransactionDeadlines(tx, checkpointTransactionDeadlines(tx));
      }),
    );
    assert.ok(stamp);
    assert.equal(
      consumeCommittedFinalTransactionProofStamp(stamp, binding),
      null,
    );
    assert.ok(f.commands.includes('ROLLBACK'));
  });
test('forged, copied, wrong-binding, precommit and cross-transaction stale stamps fail closed', async () => {
  const f = fixture();
  assert.throws(() => registerFinalTransactionProofStamp(f.tx, binding));
  const token = await inTransaction(f.pool, async (tx) =>
    registerFinalTransactionProofStamp(tx, binding),
  );
  assert.equal(
    consumeCommittedFinalTransactionProofStamp({ ...token }, binding),
    null,
  );
  assert.equal(
    consumeCommittedFinalTransactionProofStamp(token, 'b'.repeat(64)),
    null,
  );
  assert.equal(
    consumeCommittedFinalTransactionProofStamp(token, binding),
    null,
  );
  const early = await inTransaction(f.pool, async (tx) => {
    const value = registerFinalTransactionProofStamp(tx, binding);
    assert.equal(
      consumeCommittedFinalTransactionProofStamp(value, binding),
      null,
    );
    return value;
  });
  assert.equal(
    consumeCommittedFinalTransactionProofStamp(early, binding),
    null,
  );
  const old = await inTransaction(f.pool, async (tx) =>
    registerFinalTransactionProofStamp(tx, binding),
  );
  await inTransaction(f.pool, async () => {});
  assert.equal(consumeCommittedFinalTransactionProofStamp(old, binding), null);
});
test('existing owners without opt-in keep the exact wrapper query ordering', async () => {
  const f = fixture();
  await inTransaction(f.pool, async (tx) => {
    await tx.query('existing work');
  });
  assert.deepEqual(f.commands, ['BEGIN', 'existing work', 'COMMIT', 'release']);
});

test('private permit capsules cannot be copied, reused or rebound after registration', async () => {
  const f = fixture();
  const identity: EffectIdentity = {
    effectId: randomUUID(),
    attemptId: randomUUID(),
    key: 'b'.repeat(64),
    stage: 'delivery',
    profileId: 'synthetic:rating-group-v1',
    accountLineage: randomUUID(),
    destinationId: randomUUID(),
    inputHash: 'c'.repeat(64),
    payloadHash: 'c'.repeat(64),
    fence: '1',
  };
  const exact = { ...identity };
  const capsule = await inTransaction(f.pool, async (tx) => {
    const value = prepareRatingGroupPermit(tx, identity, binding);
    identity.destinationId = randomUUID();
    return value;
  });
  assert.throws(() => issueRatingGroupPermit({ ...capsule }));
  const permit = issueRatingGroupPermit(capsule);
  assert.equal(permit.destinationId, exact.destinationId);
  assert.equal(consumeRatingGroupPermit(permit, exact), true);
  assert.throws(() => issueRatingGroupPermit(capsule));
});
