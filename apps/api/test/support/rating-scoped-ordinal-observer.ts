/** Read-only observation of real SQL results in the disposable scoped fixture.
 * This delegates every transaction/query unchanged, including owner proofs,
 * statement deadlines, constraints and commit. It never manufactures rows. */
import assert from 'node:assert/strict';
import type { PoolClient } from 'pg';
import type { INestApplication } from '@nestjs/common';
import { APP_CONFIG, type RuntimeConfig } from '../../src/config/config.js';
import {
  DatabaseService,
  type TransactionOptions,
} from '../../src/database/database.js';

export interface ScopedOrdinalQueryTrace {
  kind: 'categories' | 'targets';
  after: string | null;
  ordinals: string[];
  ids: string[];
}

export function observeScopedOrdinalQueries(app: INestApplication) {
  assert.equal(app.get<RuntimeConfig>(APP_CONFIG).NODE_ENV, 'test');
  const database = app.get(DatabaseService);
  const original = database.transaction;
  const queries: ScopedOrdinalQueryTrace[] = [];
  database.transaction = async function <T>(
    operation: (tx: PoolClient) => Promise<T>,
    options: TransactionOptions = {},
  ): Promise<T> {
    return original.call(
      database,
      async (tx) => {
        const query = tx.query;
        const bound = tx.query.bind(tx);
        const release = tx.release;
        // Restoration happens before the real pooled client can be borrowed again.
        tx.release = (error) => {
          tx.query = query;
          tx.release = release;
          release.call(tx, error);
        };
        tx.query = (async (sql: string, values?: unknown[]) => {
          const result = await bound(sql, values);
          const kind = sql.includes(
            'SELECT category_id id,ordinal::text FROM whaleu_ratings.scoped_categories',
          )
            ? 'categories'
            : sql.includes(
                  'SELECT target_id id,ordinal::text FROM whaleu_ratings.scoped_target_memberships',
                )
              ? 'targets'
              : null;
          if (kind) {
            const after = values?.[2];
            assert.ok(after === null || typeof after === 'string');
            const rows = result.rows as { id: string; ordinal: string }[];
            assert.ok(rows.every((row) => typeof row.ordinal === 'string'));
            queries.push({
              kind,
              after,
              ordinals: rows.map((row) => row.ordinal),
              ids: rows.map((row) => row.id),
            });
          }
          return result;
        }) as typeof tx.query;
        return operation(tx);
      },
      options,
    ) as Promise<T>;
  };
  return {
    queries,
    restore() {
      database.transaction = original;
    },
  };
}
