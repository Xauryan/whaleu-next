import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { retainCategoryCommandProof } from '../src/community/category-reclassification/proof.js';
import {
  observeCategoryInputs,
  retainCategoryInputs,
} from '../src/community/category-reclassification/input-proof.js';
import {
  startTransactionDeadlines,
  clearTransactionDeadlines,
  checkTransactionDeadlines,
  checkpointTransactionDeadlines,
  restoreTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
import { ApplicationError } from '../src/http/application-error.js';
function fixture() {
  const queries: string[] = [];
  let expired: string[] = [];
  let value: unknown = { source: 'initial', xmin: '42' };
  const tx = {
    query: async (sql: string) => {
      queries.push(sql);
      if (sql.includes("current_setting('transaction_isolation')"))
        return {
          rows: [
            {
              isolation: 'read committed',
              statement_timeout: '0',
              lock_timeout: '0',
            },
          ],
        };
      if (sql.startsWith('SELECT r.effective_until'))
        return { rows: [{ until: '2099-01-01T00:00:00Z' }] };
      if (sql.startsWith('SELECT jsonb_build_object'))
        return { rows: [{ value }] };
      if (sql.startsWith('SELECT t.expires_at'))
        return {
          rows: [
            {
              token_until: '2099-01-01T00:00:00Z',
              session_until: '2099-01-01T00:00:00Z',
              grant_until: null,
            },
          ],
        };
      if (sql.includes('clock_timestamp'))
        return { rows: [{ now: new Date(), expired }] };
      return { rows: [] };
    },
  } as unknown as PoolClient;
  startTransactionDeadlines(tx);
  return {
    tx,
    queries,
    expire: () => {
      expired = ['1'];
    },
    change: (next: unknown) => {
      value = next;
    },
  };
}
test('original-key identity proof never reads or locks classification, grant, campus, safety or count sources', async () => {
  const f = fixture();
  try {
    await retainCategoryCommandProof(
      {
        actor: randomUUID(),
        sessionId: randomUUID(),
        tokenHash: 'hash',
        postId: null,
        grantId: null,
      },
      f.tx,
    );
    await checkTransactionDeadlines(f.tx);
    assert.ok(
      f.queries.some((q) => q.includes('whaleu_identity.access_tokens')),
    );
    assert.ok(
      f.queries.every(
        (q) => !/whaleu_(community|authorization|campus|safety)/.test(q),
      ),
    );
  } finally {
    clearTransactionDeadlines(f.tx);
  }
});
test('original-key identity proof rejects changed identity facts', async () => {
  const f = fixture();
  try {
    await retainCategoryCommandProof(
      {
        actor: randomUUID(),
        sessionId: randomUUID(),
        tokenHash: 'hash',
        postId: null,
        grantId: null,
      },
      f.tx,
    );
    f.change({ source: 'initial', xmin: '43' });
    await assert.rejects(
      checkTransactionDeadlines(f.tx),
      (e) =>
        e instanceof ApplicationError && e.code === 'POST_CATEGORY_UNAVAILABLE',
    );
  } finally {
    clearTransactionDeadlines(f.tx);
  }
});
for (const changed of [false, true])
  test(`command restores original input observations after own head write: source ABA ${changed}`, async () => {
    const f = fixture();
    try {
      const checkpoint = checkpointTransactionDeadlines(f.tx);
      const fact = await observeCategoryInputs(
        {
          postId: randomUUID(),
          grantId: randomUUID(),
          previousEventId: null,
          policyId: randomUUID(),
          reviewId: randomUUID(),
          fromCategory: 'pets',
          targetCategory: 'scenery',
        },
        f.tx,
      );
      restoreTransactionDeadlines(f.tx, checkpoint);
      if (changed) f.change({ source: 'initial', xmin: '43' });
      const before = f.queries.length;
      retainCategoryInputs(fact, f.tx);
      assert.equal(
        f.queries.length,
        before,
        'retention must not recapture post-write inputs',
      );
      if (changed)
        await assert.rejects(
          checkTransactionDeadlines(f.tx),
          (e) =>
            e instanceof ApplicationError &&
            e.code === 'POST_CATEGORY_UNAVAILABLE',
        );
      else await checkTransactionDeadlines(f.tx);
      assert.ok(
        f.queries.some(
          (q) =>
            q.includes('post_category_policy_heads') &&
            q.startsWith('LOCK TABLE'),
        ),
      );
    } finally {
      clearTransactionDeadlines(f.tx);
    }
  });

test('previous classification exact expiry survives own-write checkpoint restoration', async () => {
  const f = fixture();
  try {
    const checkpoint = checkpointTransactionDeadlines(f.tx);
    const fact = await observeCategoryInputs(
      {
        postId: randomUUID(),
        grantId: randomUUID(),
        previousEventId: randomUUID(),
        policyId: randomUUID(),
        reviewId: randomUUID(),
        fromCategory: 'scenery',
        targetCategory: 'pets',
      },
      f.tx,
    );
    assert.equal(fact.previousUntil, '2099-01-01T00:00:00Z');
    restoreTransactionDeadlines(f.tx, checkpoint);
    retainCategoryInputs(fact, f.tx);
    f.expire();
    await assert.rejects(
      checkTransactionDeadlines(f.tx),
      (e) =>
        e instanceof ApplicationError && e.code === 'POST_CATEGORY_UNAVAILABLE',
    );
  } finally {
    clearTransactionDeadlines(f.tx);
  }
});
