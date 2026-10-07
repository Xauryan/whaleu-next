import {
  startTransactionDeadlines,
  checkTransactionDeadlines,
  clearTransactionDeadlines,
} from './transaction-deadlines.js';
import { Inject, Injectable, Module } from '@nestjs/common';
import type {
  BeforeApplicationShutdown,
  OnApplicationShutdown,
} from '@nestjs/common';
import { Pool } from 'pg';
import type { PoolClient, PoolConfig, QueryResult, QueryResultRow } from 'pg';
import { APP_CONFIG } from '../config/config.js';
import type { RuntimeConfig } from '../config/config.js';
import { AppLogger } from '../observability/logger.js';

export const MIN_POSTGRES_VERSION = 180006;

export function poolOptions(config: RuntimeConfig): PoolConfig {
  return {
    connectionString: config.DATABASE_URL,
    ssl:
      config.PG_SSL_MODE === 'verify-full'
        ? { rejectUnauthorized: true }
        : false,
    max: config.PG_POOL_MAX,
    connectionTimeoutMillis: config.PG_CONNECTION_TIMEOUT_MS,
    idleTimeoutMillis: 30000,
    statement_timeout: config.PG_STATEMENT_TIMEOUT_MS,
    idle_in_transaction_session_timeout: config.PG_STATEMENT_TIMEOUT_MS,
    application_name: 'whaleu-next',
  };
}

export function supportedPostgresVersion(version: number): boolean {
  return (
    Number.isInteger(version) &&
    version >= MIN_POSTGRES_VERSION &&
    version < 190000
  );
}

export async function inTransaction<T>(
  pool: Pick<Pool, 'connect'>,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let destroy = false;
  try {
    await client.query('BEGIN');
    startTransactionDeadlines(client);
    const result = await operation(client);
    await checkTransactionDeadlines(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      destroy = true;
    }
    throw error;
  } finally {
    clearTransactionDeadlines(client);
    client.release(destroy);
  }
}

@Injectable()
export class DatabaseService
  implements BeforeApplicationShutdown, OnApplicationShutdown
{
  private readonly pool: Pool;
  private shuttingDown = false;

  constructor(
    @Inject(APP_CONFIG) config: RuntimeConfig,
    @Inject(AppLogger) logger: AppLogger,
  ) {
    this.pool = new Pool(poolOptions(config));
    this.pool.on('error', () =>
      logger.structured.error({ event: 'database_pool_error' }),
    );
  }

  query<T extends QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<T>> {
    return this.pool.query<T>(text, values);
  }

  transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    return inTransaction(this.pool, operation);
  }

  async ready(): Promise<boolean> {
    if (this.shuttingDown) return false;
    try {
      const result = await this.query<{ version: number }>(
        "SELECT current_setting('server_version_num')::integer AS version",
      );
      return supportedPostgresVersion(result.rows[0]?.version ?? 0);
    } catch {
      return false;
    }
  }

  beforeApplicationShutdown(): void {
    this.shuttingDown = true;
  }
  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}

@Module({ providers: [DatabaseService], exports: [DatabaseService] })
export class DatabaseModule {}
