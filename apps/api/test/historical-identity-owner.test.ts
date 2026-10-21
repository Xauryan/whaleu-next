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
import { startTransactionDeadlines, clearTransactionDeadlines } from '../src/database/transaction-deadlines.js';
import { historicalIdentityRepository } from './support/historical-identity/configure.js';
import { historicalPrefixes } from './support/historical-schema-prefixes.js';

const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'postgres://fixture@127.0.0.1/whaleu_test', PG_SSL_MODE: 'disable', LOG_LEVEL: 'silent' });
const manifest = await readMigrations(fileURLToPath(new URL('../migrations', import.meta.url)));
const expected = (prefix: number) => manifest.filter(({name}) => Number(name.slice(0, 4)) <= prefix).map(({name, checksum}) => ({name, checksum}));

test('historical Identity is the saved predecessor byte-for-byte except relocated imports', async () => {
  const snapshot = fileURLToPath(new URL('./support/historical-identity/repository.ts', import.meta.url));
  const original = fileURLToPath(new URL('../src/identity/identity.repository.ts', import.meta.url));
  const bytes = await readFile(snapshot, 'utf8');
  const restored = bytes.replace(/from '([^']+)'/g, (whole, specifier: string) => {
    if (!specifier.startsWith('.')) return whole;
    const target = path.resolve(path.dirname(snapshot), specifier);
    const relative = path.relative(path.dirname(original), target).split(path.sep).join('/');
    return `from '${relative.startsWith('.') ? relative : './' + relative}'`;
  });
  assert.equal(createHash('sha256').update(restored).digest('hex'), 'a6675362e570e39c1b308685a2e636c3584a815542d6162553caf1b5c7d68cc2');
});

function fixture(prefix = 65) {
  const calls: string[] = [];
  let rows = expected(prefix), absent = true;
  let inTransaction = false, businessCalls = 0;
  const tx = { query: async (sql: string, values?: unknown[]) => {
    assert.ok(inTransaction, 'every check and use is in the SAME transaction');
    calls.push(sql);
    if (sql.startsWith('LOCK TABLE')) return { rows: [], rowCount: 0 };
    if (sql.startsWith('SELECT name,checksum')) { assert.deepEqual(values, [expected(prefix).length + 1]); return {rows}; }
    if (sql.startsWith('SELECT NOT EXISTS')) {
      assert.match(sql, /pg_namespace/); assert.match(sql, /pg_attribute/);
      for (const column of ['lifecycle','lifecycle_generation','deletion_request_id']) assert.ok(sql.includes(column));
      return {rows: [{absent}]};
    }
    businessCalls++;
    if (sql.startsWith('SELECT status')) return {rows:[{status:'active'}],rowCount:1};
    if (sql.startsWith('UPDATE whaleu_identity.sessions')) return {rows:[{id:'session'}],rowCount:1};
    if (sql.startsWith('SELECT s.*')) return {rows:[],rowCount:0};
    throw new Error(`Unexpected business SQL ${sql}`);
  }} as unknown as PoolClient;
  const transaction = async <T>(operation: (client: PoolClient) => Promise<T>) => {
    assert.equal(inTransaction, false);
    inTransaction = true; calls.push('BEGIN'); startTransactionDeadlines(tx);
    try { const result = await operation(tx); calls.push('COMMIT'); return result; }
    catch(error) { calls.push('ROLLBACK'); throw error; }
    finally { clearTransactionDeadlines(tx); inTransaction = false; }
  };
  const database = {transaction, query: async () => assert.fail('unguarded pool query forbidden')} as unknown as DatabaseService;
  return {database, calls, transaction, tx, businessCalls:()=>businessCalls, setRows:(value:typeof rows)=>{rows=value;}, setAbsent:(value:boolean)=>{absent=value;}};
}

test('predecessor accepts only explicit loopback test boundaries and SSL false', async () => {
  const f = fixture();
  for (const invalid of [
    {...config,NODE_ENV:'production' as const},
    {...config,DATABASE_URL:'postgres://fixture@example.org/whaleu_test'},
    {...config,DATABASE_URL:'postgres://fixture@127.0.0.1/not_disposable'},
    {...config,PG_SSL_MODE:'verify-full' as const},
    {...config,DATABASE_URL:config.DATABASE_URL+'?sslmode=require'},
  ]) await assert.rejects(historicalIdentityRepository(f.database, invalid, 65));
  for (const prefix of [0,64,146,171,172,999]) await assert.rejects(historicalIdentityRepository(f.database, config, prefix));
  for (const prefix of historicalPrefixes.keys()) await historicalIdentityRepository(f.database, config, prefix);
  assert.deepEqual(f.calls, [], 'configuration does not substitute a separate database precheck');
});

test('passed transaction is fenced before predecessor use and until its caller commits', async () => {
  const f = fixture(), owner = await historicalIdentityRepository(f.database, config, 65);
  await f.transaction(async tx => assert.equal(await owner.activeAccount('account', tx), true));
  assert.equal(f.calls[0], 'BEGIN');
  assert.equal(f.calls[1], 'LOCK TABLE whaleu_identity.accounts IN ACCESS SHARE MODE NOWAIT');
  assert.equal(f.calls[2], 'LOCK TABLE whaleu_meta.schema_migrations IN SHARE MODE NOWAIT');
  assert.ok(f.calls.findIndex(s=>s.startsWith('SELECT status')) > f.calls.findIndex(s=>s.startsWith('SELECT NOT EXISTS')));
  assert.equal(f.calls.at(-1), 'COMMIT');
  await assert.rejects(owner.activeAccount('account', f.tx), /managed transaction/);
  assert.equal(f.businessCalls(), 1);
});

test('standalone revoke and authenticate use an equivalent transaction fence, never a precheck connection', async () => {
  const f = fixture(), owner = await historicalIdentityRepository(f.database, config, 65);
  await owner.revoke('a'.repeat(64));
  assert.equal(f.calls[0], 'BEGIN'); assert.equal(f.calls.at(-1), 'COMMIT');
  await assert.rejects(owner.authenticate('a'.repeat(64)), {code:'AUTHENTICATION_REQUIRED'});
  assert.equal(f.calls.filter(s=>s==='BEGIN').length,2);
  assert.equal(f.calls.filter(s=>s==='COMMIT').length,2);
  assert.equal(f.businessCalls(),2);
});

test('every operation rejects partial schema, missing/new/changed migration rows, and never caches acceptance', async () => {
  const f = fixture(), owner = await historicalIdentityRepository(f.database, config, 65);
  const run = () => f.transaction(tx=>owner.activeAccount('account',tx));
  await run();
  for (const rows of [expected(64),expected(69),expected(65).slice(1),expected(65).map((r,i)=>i? r:{...r,checksum:'0'.repeat(64)})]) {
    f.setRows(rows); await assert.rejects(run); assert.equal(f.businessCalls(),1);
  }
  f.setRows(expected(65)); f.setAbsent(false); await assert.rejects(run, /Partial deletion schema/);
  assert.equal(f.businessCalls(),1);
  f.setAbsent(true); await run(); assert.equal(f.businessCalls(),2);
});

test('test adapter is wired only into explicit historical builders and async configure is awaited', async () => {
  const support = await readFile(new URL('./support/historical-account-punishment-policy.ts', import.meta.url),'utf8');
  assert.match(support,/if \(prefix === undefined\) return/);
  assert.match(support,/await configureHistoricalIdentity\(builder, config, prefix\)/);
  const directory = await readFile(new URL('./support/directory-runtime-fixture.ts', import.meta.url),'utf8');
  assert.match(directory,/const configurePolicy = \(builder: TestingModuleBuilder\) =>\s*configureHistoricalAccountPolicy\(builder, config, prefix\)/);
  assert.ok(directory.indexOf('await configurePolicy(builder)') < directory.indexOf('builder.compile()'));
  for (const file of ['../src/app.module.ts','../src/identity/identity.repository.ts','../src/identity/rating-promotion-session.ts'])
    assert.doesNotMatch(await readFile(new URL(file,import.meta.url),'utf8'), /historical-identity|PredecessorIdentity/);
});
