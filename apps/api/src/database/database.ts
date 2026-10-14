import { AccountPunishmentPolicy } from '../safety/account-moderation/policy.js';
import { withAccountPunishmentPolicy } from '../safety/account-policy/punishment-context.js';
import {
  startTransactionDeadlines,
  checkTransactionDeadlines,
  clearTransactionDeadlines,
  transactionReadEpoch,
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

declare const finalProofStampBrand: unique symbol;
/** Internal transaction capability, never a caller-provided timestamp. */
export interface FinalTransactionProofStamp {
  readonly [finalProofStampBrand]: true;
}
interface ProofStampState {
  client: PoolClient;
  epoch: object;
  binding: string;
  phase: 'registered' | 'sealed' | 'committed' | 'invalid';
  at: number | null;
  consumed: boolean;
}
const proofStampLifetimes = new WeakMap<
  PoolClient,
  { epoch: object; stamp?: ProofStampState }
>();
const proofStamps = new WeakMap<object, ProofStampState>();
const latestProofStamp = new WeakMap<PoolClient, ProofStampState>();
export function registerFinalTransactionProofStamp(
  client: PoolClient,
  binding: string,
): FinalTransactionProofStamp {
  const lifetime = proofStampLifetimes.get(client);
  if (
    !lifetime ||
    lifetime.stamp ||
    transactionReadEpoch(client) !== lifetime.epoch ||
    !/^[a-f0-9]{64}$/.test(binding)
  )
    throw new Error('Final proof stamp requires one exact managed transaction');
  const stamp = Object.freeze({}) as FinalTransactionProofStamp;
  const state: ProofStampState = {
    client,
    epoch: lifetime.epoch,
    binding,
    phase: 'registered',
    at: null,
    consumed: false,
  };
  lifetime.stamp = state;
  proofStamps.set(stamp, state);
  latestProofStamp.set(client, state);
  return stamp;
}
export function consumeCommittedFinalTransactionProofStamp(
  stamp: FinalTransactionProofStamp,
  binding: string,
): number | null {
  const state = proofStamps.get(stamp);
  if (!state || state.consumed) return null;
  state.consumed = true;
  if (
    state.phase !== 'committed' ||
    state.binding !== binding ||
    proofStampLifetimes.has(state.client) ||
    latestProofStamp.get(state.client) !== state
  )
    return null;
  return state.at;
}
function sealFinalProofStamp(client: PoolClient): void {
  const state = proofStampLifetimes.get(client)?.stamp;
  if (!state) return;
  if (
    state.phase !== 'registered' ||
    state.epoch !== transactionReadEpoch(client)
  )
    throw new Error('Final proof stamp transaction lifetime changed');
  state.at = performance.now();
  state.phase = 'sealed';
}

export interface TransactionOptions {
  /** Exact snapshot proofs require this explicit mode regardless of server defaults. */
  isolationLevel?: 'read committed';
}

export async function inTransaction<T>(
  pool: Pick<Pool, 'connect'>,
  operation: (client: PoolClient) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  return runTransaction(pool, operation, options);
}

async function runTransaction<T>(
  pool: Pick<Pool, 'connect'>,
  operation: (client: PoolClient) => Promise<T>,
  options: TransactionOptions,
  policy?: AccountPunishmentPolicy,
): Promise<T> {
  const client = await pool.connect();
  let destroy = false;
  try {
    await client.query(
      options.isolationLevel === 'read committed'
        ? 'BEGIN ISOLATION LEVEL READ COMMITTED'
        : 'BEGIN',
    );
    startTransactionDeadlines(client);
    const previousStamp = latestProofStamp.get(client);
    if (previousStamp) previousStamp.phase = 'invalid';
    proofStampLifetimes.set(client, { epoch: transactionReadEpoch(client)! });
    const complete = async () => {
      const result = await operation(client);
      await checkTransactionDeadlines(client);
      sealFinalProofStamp(client);
      await client.query('COMMIT');
      const stamp = proofStampLifetimes.get(client)?.stamp;
      if (stamp) stamp.phase = 'committed';
      return result;
    };
    return policy
      ? await withAccountPunishmentPolicy(client, policy, complete)
      : await complete();
  } catch (error) {
    const stamp = proofStampLifetimes.get(client)?.stamp;
    if (stamp) stamp.phase = 'invalid';
    try {
      await client.query('ROLLBACK');
    } catch {
      destroy = true;
    }
    throw error;
  } finally {
    proofStampLifetimes.delete(client);
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
    @Inject(AccountPunishmentPolicy)
    private readonly punishmentPolicy: AccountPunishmentPolicy = new AccountPunishmentPolicy(),
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

  transaction<T>(
    operation: (client: PoolClient) => Promise<T>,
    options: TransactionOptions = {},
  ): Promise<T> {
    return runTransaction(this.pool, operation, options, this.punishmentPolicy);
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

@Module({
  providers: [DatabaseService, AccountPunishmentPolicy],
  exports: [DatabaseService, AccountPunishmentPolicy],
})
export class DatabaseModule {}
