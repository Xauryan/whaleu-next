import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool, PoolClient } from 'pg';
import {
  inTransaction,
  poolOptions,
  supportedPostgresVersion,
} from '../src/database/database.js';
import { loadConfig } from '../src/config/config.js';

function fixture(fail?: string) {
  const commands: string[] = [];
  const releases: boolean[] = [];
  const client = {
    async query(text: string) {
      commands.push(text);
      if (text === fail) throw new Error('simulated database failure');
      return { rows: [] };
    },
    release(destroy: boolean) {
      releases.push(destroy);
    },
  } as unknown as PoolClient;
  const pool = { connect: async () => client } as unknown as Pick<
    Pool,
    'connect'
  >;
  return { pool, client, commands, releases };
}

test('transaction commits once and returns its result using one leased connection', async () => {
  const { pool, client, commands, releases } = fixture();
  const result = await inTransaction(pool, async (connection) => {
    assert.equal(connection, client);
    await connection.query('SELECT 1');
    return 42;
  });
  assert.equal(result, 42);
  assert.deepEqual(commands, ['BEGIN', 'SELECT 1', 'COMMIT']);
  assert.deepEqual(releases, [false]);
});

test('operation failure rolls back, preserves original failure, and releases connection', async () => {
  const { pool, commands, releases } = fixture();
  const failure = new Error('original failure');
  await assert.rejects(
    inTransaction(pool, async () => {
      throw failure;
    }),
    (error) => error === failure,
  );
  assert.deepEqual(commands, ['BEGIN', 'ROLLBACK']);
  assert.deepEqual(releases, [false]);
});

test('failed rollback destroys the connection without masking original failure', async () => {
  const { pool, releases } = fixture('ROLLBACK');
  const failure = new Error('original failure');
  await assert.rejects(
    inTransaction(pool, async () => {
      throw failure;
    }),
    (error) => error === failure,
  );
  assert.deepEqual(releases, [true]);
});

test('commit failure is never automatically retried', async () => {
  const { pool, commands, releases } = fixture('COMMIT');
  let executions = 0;
  await assert.rejects(
    inTransaction(pool, async () => {
      executions++;
    }),
    /simulated/,
  );
  assert.equal(executions, 1);
  assert.deepEqual(commands, ['BEGIN', 'COMMIT', 'ROLLBACK']);
  assert.deepEqual(releases, [false]);
});

test('only supported PostgreSQL 18 patches pass readiness', () => {
  for (const version of [170012, 180000, 180005, 190000, NaN])
    assert.equal(supportedPostgresVersion(version), false);
  for (const version of [180006, 180007])
    assert.equal(supportedPostgresVersion(version), true);
});

test('pool config keeps TLS verification and bounded connection/statement timeouts', () => {
  const options = poolOptions(
    loadConfig({ DATABASE_URL: 'postgresql://db.example.test/whaleu' }),
  );
  assert.deepEqual(options.ssl, { rejectUnauthorized: true });
  assert.equal(options.connectionTimeoutMillis, 5000);
  assert.equal(options.statement_timeout, 10000);
  assert.equal(options.idle_in_transaction_session_timeout, 10000);
});
