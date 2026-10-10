/** Read-only after-query barrier; real queries/results and owner services stay intact. */
import type { INestApplication } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../src/database/database.js';
import type { TransactionOptions } from '../../src/database/database.js';
export function observeDirectoryQueries(app: INestApplication) {
  const database = app.get(DatabaseService);
  const originalTransaction = database.transaction.bind(database);
  type QueryHook =
    ((event: { sql: string }, tx: PoolClient) => Promise<void>) | null;
  let hook: QueryHook = null;
  let beforeHook: QueryHook = null;
  database.transaction = async function <T>(
    operation: (tx: PoolClient) => Promise<T>,
    options: TransactionOptions = {},
  ): Promise<T> {
    let restore: (() => void) | undefined;
    try {
      return await originalTransaction(async (tx) => {
        const originalQuery = tx.query.bind(tx);
        restore = () => {
          tx.query = originalQuery;
        };
        tx.query = (async (sql: string, values?: unknown[]) => {
          if (beforeHook) await beforeHook({ sql }, tx);
          const result = await originalQuery(sql, values);
          // PostgreSQL multi-statement SET queries return arrays rather than one
          // QueryResult. Never interpret or replace their ordinary result shape.
          if (hook) await hook({ sql }, tx);
          return result;
        }) as typeof tx.query;
        return operation(tx);
      }, options);
    } finally {
      restore?.();
    }
  };
  return {
    setHook(value: QueryHook) {
      hook = value;
    },
    setBeforeHook(value: QueryHook) {
      beforeHook = value;
    },
    restore() {
      database.transaction = originalTransaction;
    },
  };
}
