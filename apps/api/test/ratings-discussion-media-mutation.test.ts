import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import {
  startTransactionDeadlines,
  clearTransactionDeadlines,
  checkTransactionDeadlines,
  checkpointTransactionDeadlines,
  restoreTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
import { MediaRequiredProof } from '../src/media/required-proof.js';
import {
  beginRatingsMediaMutation,
  finishRatingsMediaMutation,
  abortRatingsMediaMutation,
  collectRatingsMediaMutationRead,
} from '../src/media/ratings-discussion-mutation-proof.js';
import { RatingsDiscussionMediaContentSnapshotFacade } from '../src/media/ratings-discussion-content-snapshot.facade.js';
import type {
  RatingsDiscussionMediaContentReference,
  MediaSnapshotReadBudget,
} from '../src/media/ratings-discussion-content-snapshot.facade.js';
function fixture() {
  let epoch = 0,
    unexpectedBinding = false,
    reads = 0;
  const parent = {
    ownerKind: 'ratings' as const,
    resourceKind: 'rating_comment' as const,
    targetId: randomUUID(),
    resourceId: randomUUID(),
    contentVersion: 1 as const,
  };
  const reference: RatingsDiscussionMediaContentReference = {
    parent,
    expected: [],
  };
  const tx = {
    async query(sql: string) {
      if (sql.includes("current_setting('transaction_isolation')"))
        return {
          rows: [
            {
              isolation: 'read committed',
              capacity: 32,
              statement_timeout: '0',
              lock_timeout: '0',
            },
          ],
        };
      if (sql.includes('SELECT slot,version,epoch::text'))
        return {
          rows: Array.from({ length: 128 }, (_, slot) => ({
            slot,
            version: 1,
            epoch: String(epoch),
          })),
        };
      if (sql.includes('FROM unnest(')) {
        reads++;
        return {
          rows: [
            {
              parent_id: parent.resourceId,
              parent_kind: parent.resourceKind,
              parent_target_id: parent.targetId,
              parent_root_id: null,
              binding_id: unexpectedBinding ? randomUUID() : null,
            },
          ],
        };
      }
      if (sql === 'SELECT clock_timestamp() AS now')
        return { rows: [{ now: new Date() }] };
      return { rows: [], rowCount: 0 };
    },
  } as unknown as PoolClient;
  const budget: MediaSnapshotReadBudget = {
    rows: async <T>(read: PoolClient, sql: string, values: unknown[]) =>
      (await read.query(sql, values)).rows as T[],
  };
  return {
    tx,
    reference,
    budget,
    advance: () => {
      epoch++;
    },
    change: () => {
      unexpectedBinding = true;
      epoch++;
    },
    reads: () => reads,
  };
}
test('Media7 mutation rereads exact own absence after writes and does not move earlier facts', async () => {
  for (const outer of [false, true]) {
    const f = fixture();
    startTransactionDeadlines(f.tx);
    try {
      if (outer) await new MediaRequiredProof().capture(f.tx);
      const cap = beginRatingsMediaMutation(f.tx),
        facts =
          await new RatingsDiscussionMediaContentSnapshotFacade().readBatch(
            [f.reference],
            f.tx,
            f.budget,
          );
      assert.equal(
        collectRatingsMediaMutationRead(f.tx, [f.reference], facts, f.budget),
        true,
      );
      f.advance();
      await finishRatingsMediaMutation(cap, f.tx);
      assert.equal(
        f.reads(),
        2,
        'one initial and one bounded final metadata query',
      );
      if (outer) await assert.rejects(checkTransactionDeadlines(f.tx));
      else await checkTransactionDeadlines(f.tx);
      await assert.rejects(finishRatingsMediaMutation(cap, f.tx));
    } finally {
      clearTransactionDeadlines(f.tx);
    }
  }
});
test('Media7 absence-to-present, missing finish and rolled-back capabilities fail closed', async () => {
  const f = fixture();
  startTransactionDeadlines(f.tx);
  try {
    const checkpoint = checkpointTransactionDeadlines(f.tx),
      cap = beginRatingsMediaMutation(f.tx);
    const facts =
      await new RatingsDiscussionMediaContentSnapshotFacade().readBatch(
        [f.reference],
        f.tx,
        f.budget,
      );
    collectRatingsMediaMutationRead(f.tx, [f.reference], facts, f.budget);
    f.change();
    await assert.rejects(finishRatingsMediaMutation(cap, f.tx));
    abortRatingsMediaMutation(cap, f.tx);
    await assert.rejects(checkTransactionDeadlines(f.tx));
    restoreTransactionDeadlines(f.tx, checkpoint);
    await assert.rejects(finishRatingsMediaMutation(cap, f.tx));
    const unfinished = beginRatingsMediaMutation(f.tx);
    await assert.rejects(checkTransactionDeadlines(f.tx));
    abortRatingsMediaMutation(unfinished, f.tx);
  } finally {
    clearTransactionDeadlines(f.tx);
  }
});
