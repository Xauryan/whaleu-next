import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { RatingNativeTargetSourceFacade } from '../src/ratings/management/native-source.facade.js';
import { ApplicationError } from '../src/http/application-error.js';
import {
  startTransactionDeadlines,
  clearTransactionDeadlines,
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
  checkTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../src/database/transaction-deadlines.js';

test('M1 future optional origin observation expires even after the creation final proof', async () => {
  const now = Date.now(),
    activation = now + 1000;
  let finalNow = now;
  const tx = {
    query: async (sql: string) => {
      if (sql.includes('whaleu_ratings.native_create_policy_heads')) {
        assert.ok(sql.includes('raw.effective_at>instant.now'));
        assert.equal(sql.match(/clock_timestamp\(\)/g)?.length, 1);
        assert.ok(sql.includes('instant AS MATERIALIZED'));
        return {
          rows: [
            {
              policy_id: randomUUID(),
              policy_reference: 'synthetic-policy',
              origin_id: null,
              origin_state: 'unknown',
              origin_campus_id: null,
              origin_source_reference: null,
              origin_policy_reference: null,
              policy_until: new Date(now + 3600000),
              origin_until: null,
              origin_activation_at: new Date(activation),
            },
          ],
        };
      }
      if (sql === 'SET CONSTRAINTS ALL IMMEDIATE') return { rows: [] };
      if (sql === 'SELECT clock_timestamp() AS now')
        return { rows: [{ now: new Date(finalNow) }] };
      throw new Error('Unexpected proof query: ' + sql);
    },
  } as unknown as PoolClient;
  startTransactionDeadlines(tx);
  try {
    const source = await new RatingNativeTargetSourceFacade().resolve(
      randomUUID(),
      randomUUID(),
      '0'.repeat(64),
      null,
      'general',
      tx,
    );
    assert.equal(source.origin_id, null);
    assert.equal(source.origin_state, 'unknown');
    // This observation was still unknown at the owner's final proof. An unrelated
    // later validator consumes time before the wrapper's final clock checkpoint.
    const finalProof: RequiredTransactionProof<boolean> = {
      maximumFacts: 1,
      failureCode: 'RATING_UNAVAILABLE',
      validate: async () => {
        finalNow = activation;
      },
    };
    enableRequiredTransactionProof(tx, finalProof);
    registerRequiredTransactionFact(tx, finalProof, 'later', true);
    await assert.rejects(
      checkTransactionDeadlines(tx),
      (error) =>
        error instanceof ApplicationError &&
        error.code === 'RATING_UNAVAILABLE',
    );
  } finally {
    clearTransactionDeadlines(tx);
  }
});
