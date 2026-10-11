import assert from 'node:assert/strict';
import type { INestApplication } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { APP_CONFIG, type RuntimeConfig } from '../../src/config/config.js';
import {
  DatabaseService,
  type TransactionOptions,
} from '../../src/database/database.js';
import { lockSafetyPolicy } from '../../src/safety/locks.js';

const allowedRelations = [
  'whaleu_media.object_attempts',
  'whaleu_media.jobs',
  'whaleu_media.upload_intents',
  'whaleu_ratings.navigation_epoch',
  'whaleu_ratings.random_pool_epoch',
] as const;
export type FixtureOwnerRelation = (typeof allowedRelations)[number];
const activeWindows = new WeakSet<DatabaseService>();
export interface OwnerFixtureWindowResult<T> {
  result: T;
  transactions: number;
  skippedTransactions: number;
  prelocks: number;
  finalNowaitAttempts: number;
  commits: number;
  rollbacks: number;
}
/** Test-only scheduling of one named healthy setup/read window. This does not
 * replace a transaction, owner proof, clock, SQL result, commit, or NOWAIT fence.
 * The SAME real transaction takes Safety first and the requested SHARE lock at
 * admission, using its existing statement timeout. It may fail without retry.
 * Never use this around an operation whose purpose is concurrent-writer refusal.
 */
export async function withOwnerFixtureWindow<T>(
  app: INestApplication,
  relations: readonly FixtureOwnerRelation[],
  action: () => Promise<T>,
  skipFirst: 'rate_limit' | 'semantic_preflight' | undefined = undefined,
): Promise<OwnerFixtureWindowResult<T>> {
  const config = app.get<RuntimeConfig>(APP_CONFIG),
    url = new URL(config.DATABASE_URL);
  assert.equal(config.NODE_ENV, 'test');
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  assert.equal(url.pathname, '/whaleu_test');
  assert.ok(relations.length > 0 && relations.length <= 2);
  assert.equal(new Set(relations).size, relations.length);
  assert.ok(relations.every((r) => allowedRelations.includes(r)));
  const database = app.get(DatabaseService);
  assert.ok(
    !activeWindows.has(database),
    'Healthy fixture windows must not overlap',
  );
  activeWindows.add(database);
  const originalTransaction = database.transaction;
  const run = originalTransaction.bind(database);
  const stats = {
    transactions: 0,
    skippedTransactions: 0,
    prelocks: 0,
    finalNowaitAttempts: 0,
    commits: 0,
    rollbacks: 0,
  };
  let activeClients = 0;
  database.transaction = function <R>(
    operation: (tx: PoolClient) => Promise<R>,
    options: TransactionOptions = {},
  ): Promise<R> {
    if (skipFirst && stats.skippedTransactions === 0) {
      stats.skippedTransactions++;
      return run(async (tx) => {
        const originalQuery = tx.query,
          originalRelease = tx.release;
        activeClients++;
        tx.release = function (error?: Error | boolean) {
          tx.query = originalQuery;
          tx.release = originalRelease;
          activeClients--;
          return originalRelease.call(tx, error);
        };
        let matchedShape = 0;
        tx.query = function (...args: unknown[]) {
          const sql = typeof args[0] === 'string' ? args[0].trim() : '';
          // Inspect fixed SQL structure only; never retain text or parameters.
          if (skipFirst === 'rate_limit') {
            if (
              /^INSERT INTO whaleu_runtime\.request_throttle_counters\b/.test(
                sql,
              )
            )
              matchedShape++;
            assert.ok(
              !/whaleu_ratings\.(navigation_epoch|random_pool_epoch)/.test(sql),
            );
          } else {
            if (
              /^SELECT id,kind,"spaceId","postId","rootCommentId",at FROM/.test(
                sql,
              ) &&
              /ORDER BY sort_at DESC,sort_kind ASC,id DESC LIMIT/.test(sql)
            )
              matchedShape++;
            assert.ok(
              !/LOCK TABLE[^;]*whaleu_media\.upload_intents/i.test(sql),
            );
          }
          return Reflect.apply(originalQuery, tx, args);
        } as PoolClient['query'];
        const result = await operation(tx);
        assert.equal(
          matchedShape,
          1,
          `Skipped transaction must be the exact ${skipFirst} phase`,
        );
        return result;
      }, options);
    }
    stats.transactions++;
    return run<R>(async (tx) => {
      activeClients++;
      const originalQuery = tx.query,
        originalRelease = tx.release;
      let restored = false;
      const restore = () => {
        if (restored) return;
        restored = true;
        tx.query = originalQuery;
        tx.release = originalRelease;
        activeClients--;
      };
      tx.query = function (...args: unknown[]) {
        const sql = typeof args[0] === 'string' ? args[0].trim() : '';
        if (
          /^LOCK TABLE\b/i.test(sql) &&
          /\bIN SHARE MODE NOWAIT\s*$/i.test(sql) &&
          relations.every((r) => sql.includes(r))
        )
          stats.finalNowaitAttempts++;
        const result = Reflect.apply(originalQuery, tx, args);
        if (sql === 'COMMIT' || sql === 'ROLLBACK')
          return Promise.resolve(result).then((value) => {
            if (sql === 'COMMIT') stats.commits++;
            else stats.rollbacks++;
            return value;
          });
        return result;
      } as PoolClient['query'];
      tx.release = function (error?: Error | boolean) {
        // Original inTransaction calls release in finally, after all required
        // proofs and COMMIT/ROLLBACK. Restore BEFORE this client re-enters its pool.
        restore();
        return originalRelease.call(tx, error);
      };
      await lockSafetyPolicy(tx, true);
      await tx.query(`LOCK TABLE ${relations.join(',')} IN SHARE MODE`);
      stats.prelocks++;
      return operation(tx);
    }, options);
  };
  try {
    const result = await action();
    return { result, ...stats };
  } finally {
    database.transaction = originalTransaction;
    activeWindows.delete(database);
    assert.equal(
      activeClients,
      0,
      'All scoped real transactions must finish before window restoration',
    );
  }
}
