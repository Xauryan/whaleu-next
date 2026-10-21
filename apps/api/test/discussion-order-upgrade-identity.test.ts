import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { PoolClient } from 'pg';
import { loadConfig } from '../src/config/config.js';
import type { DatabaseService } from '../src/database/database.js';
import { readMigrations } from '../src/database/migrations.js';
import {
  startTransactionDeadlines,
  clearTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
import { discussionOrderUpgradeIdentity } from './support/discussion-order-upgrade-identity.js';

const config = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://fixture@127.0.0.1/whaleu_test',
  PG_SSL_MODE: 'disable',
  LOG_LEVEL: 'silent',
});
const manifest = await readMigrations(
  fileURLToPath(new URL('../migrations', import.meta.url)),
);
const expected = (prefix: number) =>
  manifest
    .filter(({ name }) => Number(name.slice(0, 4)) <= prefix)
    .map(({ name, checksum }) => ({ name, checksum }));

function fixture() {
  const calls: string[] = [];
  let rows = expected(167),
    absent = true,
    historical = true;
  let inTransaction = false,
    businessCalls = 0;
  let afterBusiness: (() => void) | undefined;
  let lockFailure: Error | undefined;
  const tx = {
    query: async (sql: string, values?: unknown[]) => {
      assert.ok(
        inTransaction,
        'Guard and owner use the SAME managed transaction',
      );
      calls.push(sql);
      if (sql.startsWith('LOCK TABLE')) {
        if (lockFailure) throw lockFailure;
        return { rows: [], rowCount: 0 };
      }
      if (sql.startsWith('SELECT name,checksum')) {
        assert.deepEqual(values, [expected(167).length + 1]);
        return { rows };
      }
      if (sql.startsWith('SELECT NOT EXISTS')) {
        for (const part of [
          'pg_namespace',
          'pg_attribute',
          'lifecycle',
          'lifecycle_generation',
          'deletion_request_id',
        ])
          assert.ok(sql.includes(part));
        return { rows: [{ absent }] };
      }
      businessCalls++;
      afterBusiness?.();
      if (sql.startsWith('SELECT status'))
        return { rows: [{ status: 'active' }], rowCount: 1 };
      if (sql.startsWith('UPDATE whaleu_identity.sessions'))
        return { rows: [{ id: 'session' }], rowCount: 1 };
      if (sql.startsWith('SELECT s.*')) return { rows: [], rowCount: 0 };
      throw new Error(`Unexpected owner SQL ${sql}`);
    },
  } as unknown as PoolClient;
  const transaction = async <T>(
    operation: (client: PoolClient) => Promise<T>,
  ) => {
    assert.equal(inTransaction, false);
    inTransaction = true;
    calls.push('BEGIN');
    startTransactionDeadlines(tx);
    try {
      const result = await operation(tx);
      calls.push('COMMIT');
      return result;
    } catch (error) {
      calls.push('ROLLBACK');
      throw error;
    } finally {
      clearTransactionDeadlines(tx);
      inTransaction = false;
    }
  };
  const database = {
    transaction,
    query: async () => assert.fail('Unguarded pool query forbidden'),
  } as unknown as DatabaseService;
  return {
    database,
    tx,
    transaction,
    calls,
    historical: () => historical,
    businessCalls: () => businessCalls,
    setRows(value: typeof rows) {
      rows = value;
    },
    setAbsent(value: boolean) {
      absent = value;
    },
    retire() {
      historical = false;
    },
    afterBusiness(value: () => void) {
      afterBusiness = value;
    },
    failLock(value: Error) {
      lockFailure = value;
    },
  };
}

test('discussion predecessor snapshot remains the independently proven byte-identical owner', async () => {
  const snapshot = fileURLToPath(
    new URL('./support/historical-identity/repository.ts', import.meta.url),
  );
  const original = fileURLToPath(
    new URL('../src/identity/identity.repository.ts', import.meta.url),
  );
  const bytes = await readFile(snapshot, 'utf8');
  const restored = bytes.replace(
    /from '([^']+)'/g,
    (whole, specifier: string) => {
      if (!specifier.startsWith('.')) return whole;
      const target = path.resolve(path.dirname(snapshot), specifier);
      const relative = path
        .relative(path.dirname(original), target)
        .split(path.sep)
        .join('/');
      return `from '${relative.startsWith('.') ? relative : './' + relative}'`;
    },
  );
  assert.equal(
    createHash('sha256').update(restored).digest('hex'),
    'a6675362e570e39c1b308685a2e636c3584a815542d6162553caf1b5c7d68cc2',
  );
});

test('fixed discussion predecessor rejects non-test, non-loopback, SSL and retired configurations', async () => {
  const f = fixture();
  for (const invalid of [
    { ...config, NODE_ENV: 'production' as const },
    { ...config, DATABASE_URL: 'postgres://fixture@example.org/whaleu_test' },
    { ...config, DATABASE_URL: 'postgres://fixture@127.0.0.1/not_disposable' },
    { ...config, PG_SSL_MODE: 'verify-full' as const },
    { ...config, DATABASE_URL: config.DATABASE_URL + '?sslmode=require' },
  ])
    await assert.rejects(
      discussionOrderUpgradeIdentity(f.database, invalid, f.historical),
    );
  f.retire();
  await assert.rejects(
    discussionOrderUpgradeIdentity(f.database, config, f.historical),
    /phase is closed/,
  );
  assert.deepEqual(f.calls, []);
});

test('fixed0167 predecessor checks exact ledger and both fences before and after passed-transaction owner SQL', async () => {
  const f = fixture(),
    owner = await discussionOrderUpgradeIdentity(
      f.database,
      config,
      f.historical,
    );
  await f.transaction(async (tx) =>
    assert.equal(await owner.activeAccount('account', tx), true),
  );
  assert.equal(f.calls[0], 'BEGIN');
  assert.equal(
    f.calls[1],
    'LOCK TABLE whaleu_identity.accounts IN ACCESS SHARE MODE NOWAIT',
  );
  assert.equal(
    f.calls[2],
    'LOCK TABLE whaleu_meta.schema_migrations IN SHARE MODE NOWAIT',
  );
  assert.equal(
    f.calls.filter((sql) => sql.startsWith('SELECT name,checksum')).length,
    2,
  );
  assert.equal(f.calls.at(-1), 'COMMIT');
  await assert.rejects(
    owner.activeAccount('account', f.tx),
    /managed transaction/,
  );
  assert.equal(f.businessCalls(), 1);
});

test('exact0167 excludes earlier, later, missing, reordered and checksum-mutated manifests without caching acceptance', async () => {
  const f = fixture(),
    owner = await discussionOrderUpgradeIdentity(
      f.database,
      config,
      f.historical,
    );
  const run = () => f.transaction((tx) => owner.activeAccount('account', tx));
  await run();
  for (const rows of [
    expected(166),
    expected(168),
    expected(172),
    expected(167).slice(1),
    expected(167).reverse(),
    expected(167).map((r, i) => (i ? r : { ...r, checksum: '0'.repeat(64) })),
  ]) {
    f.setRows(rows);
    await assert.rejects(run, /cannot cross an upgrade/);
    assert.equal(f.businessCalls(), 1);
  }
  f.setRows(expected(167));
  f.setAbsent(false);
  await assert.rejects(run, /Partial deletion schema/);
  assert.equal(f.businessCalls(), 1);
  f.setAbsent(true);
  await run();
  assert.equal(f.businessCalls(), 2);
});

test('partial schema or phase changes during an owner operation roll back instead of committing stale acceptance', async () => {
  for (const mutate of ['schema', 'phase', 'ledger'] as const) {
    const f = fixture(),
      owner = await discussionOrderUpgradeIdentity(
        f.database,
        config,
        f.historical,
      );
    f.afterBusiness(() => {
      if (mutate === 'schema') f.setAbsent(false);
      else if (mutate === 'phase') f.retire();
      else f.setRows(expected(168));
    });
    await assert.rejects(
      f.transaction((tx) => owner.activeAccount('account', tx)),
    );
    assert.equal(f.businessCalls(), 1);
    assert.equal(f.calls.at(-1), 'ROLLBACK');
  }
});

test('standalone owner operations retain guards through transaction completion and retired calls never touch the database', async () => {
  const f = fixture(),
    owner = await discussionOrderUpgradeIdentity(
      f.database,
      config,
      f.historical,
    );
  await owner.revoke('a'.repeat(64));
  await assert.rejects(owner.authenticate('a'.repeat(64)), {
    code: 'AUTHENTICATION_REQUIRED',
  });
  assert.equal(f.calls.filter((sql) => sql === 'COMMIT').length, 2);
  assert.equal(f.businessCalls(), 2);
  f.retire();
  const before = f.calls.length;
  await assert.rejects(owner.authenticate('a'.repeat(64)), /phase is closed/);
  await assert.rejects(owner.revoke('a'.repeat(64)), /phase is closed/);
  assert.equal(f.calls.length, before);
});

test('NOWAIT fence failure cannot reach business SQL and fabricated external identities cannot enroll', async () => {
  const f = fixture(),
    owner = await discussionOrderUpgradeIdentity(
      f.database,
      config,
      f.historical,
    );
  const locked = new Error('synthetic lock unavailable');
  f.failLock(locked);
  await assert.rejects(
    f.transaction((tx) => owner.activeAccount('account', tx)),
    (error) => error === locked,
  );
  assert.equal(f.businessCalls(), 0);
  const before = f.calls.length;
  for (const identity of [
    {
      provider: 'wechat' as const,
      appId: 'wx0000000000000000',
      subject: 'discussion-upgrade-00000000-0000-0000-0000-000000000000',
    },
    {
      provider: 'wechat' as const,
      appId: 'synthetic-discussion-order-upgrade-only',
      subject: 'unissued-real-subject',
    },
  ])
    await assert.rejects(
      owner.createSession(identity, {
        access: 'a'.repeat(64),
        refresh: 'b'.repeat(64),
      }),
    );
  assert.equal(f.calls.length, before);
});
