import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { loadConfig } from '../src/config/config.js';
import { readMigrations, MIGRATION_LOCK } from '../src/database/migrations.js';
import {
  startTransactionDeadlines,
  clearTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
import { historicalContentReferences } from './support/historical-content-references.js';

const config = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://fixture@127.0.0.1/whaleu_test',
  PG_SSL_MODE: 'disable',
  LOG_LEVEL: 'silent',
});
const target = { kind: 'post' as const, targetId: randomUUID() };

test('historical reference adapter accepts only disposable registered pre0171 fixtures', async () => {
  for (const invalid of [
    { ...config, NODE_ENV: 'production' as const },
    { ...config, DATABASE_URL: 'postgres://fixture@example.org/whaleu_test' },
    { ...config, DATABASE_URL: 'postgres://fixture@127.0.0.1/other' },
    { ...config, PG_SSL_MODE: 'verify-full' as const },
    {
      ...config,
      DATABASE_URL: 'postgres://fixture@127.0.0.1/whaleu_test?sslmode=disable',
    },
    {
      ...config,
      DATABASE_URL: 'postgres://fixture@127.0.0.1/whaleu_test?SSLMode=disable',
    },
  ])
    await assert.rejects(historicalContentReferences(invalid, 144));
  for (const prefix of [0, 143, 170, 171, 172])
    await assert.rejects(historicalContentReferences(config, prefix));
});

test('historical reference owner rechecks exact schema and partial deployment each call', async () => {
  const owner = await historicalContentReferences(config, 144);
  const expected = (
    await readMigrations(
      fileURLToPath(new URL('../migrations', import.meta.url)),
    )
  )
    .filter(({ name }) => Number(name.slice(0, 4)) <= 144)
    .map(({ name, checksum }) => ({ name, checksum }));
  let applied = expected;
  let locked = true;
  let absent = true;
  let unavailable = false;
  const calls: string[] = [];
  const tx = {
    query: async (sql: string, values?: unknown[]) => {
      calls.push(sql);
      if (unavailable) throw new Error('unavailable');
      if (sql.includes('pg_try_advisory_xact_lock_shared')) {
        assert.deepEqual(values, [...MIGRATION_LOCK]);
        return { rows: [{ locked }] };
      }
      if (sql.includes('schema_migrations')) {
        assert.deepEqual(values, [expected.length + 1]);
        return { rows: applied };
      }
      assert.ok(sql.includes('pg_class'));
      assert.ok(sql.includes('pg_proc'));
      assert.ok(sql.includes('pg_trigger'));
      return { rows: [{ absent }] };
    },
  } as unknown as PoolClient;
  const reject = () =>
    assert.rejects(owner.allocateForPublication(target, tx), {
      code: 'COMMUNITY_UNAVAILABLE',
    });
  await reject();
  assert.equal(calls.length, 0, 'unmanaged transactions never reach SQL');
  startTransactionDeadlines(tx);
  try {
    assert.deepEqual(await owner.allocateForPublication(target, tx), {
      state: 'inactive',
    });
    assert.equal(calls.length, 3);
    applied = [...expected, { name: '0171_added.sql', checksum: 'changed' }];
    await reject();
    applied = expected.slice(0, -1);
    await reject();
    applied = expected.map((entry, index) =>
      index === 0 ? { ...entry, checksum: 'changed' } : entry,
    );
    await reject();
    applied = expected;
    absent = false;
    await reject();
    absent = true;
    locked = false;
    await reject();
    locked = true;
    unavailable = true;
    await reject();
    unavailable = false;
    assert.deepEqual(await owner.allocateForPublication(target, tx), {
      state: 'inactive',
    });
    await assert.rejects(
      owner.allocateForPublication({ ...target, targetId: 'invalid' }, tx),
      { code: 'COMMUNITY_UNAVAILABLE' },
    );
  } finally {
    clearTransactionDeadlines(tx);
  }
  await reject();
});
