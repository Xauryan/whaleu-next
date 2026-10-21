import 'reflect-metadata';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { PoolClient } from 'pg';
import { loadConfig } from '../src/config/config.js';
import type { DatabaseService } from '../src/database/database.js';
import { readMigrations } from '../src/database/migrations.js';
import {
  clearTransactionDeadlines,
  startTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
import { historicalIdentityRepository } from './support/historical-identity/configure.js';
import { historicalPrefixes } from './support/historical-schema-prefixes.js';

test('subscription cutover uses separately guarded Identity owners at exactly 0050, 0051 and 0052', async () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://fixture@127.0.0.1/whaleu_test',
    PG_SSL_MODE: 'disable',
    LOG_LEVEL: 'silent',
  });
  const manifest = await readMigrations(
    fileURLToPath(new URL('../migrations', import.meta.url)),
  );
  let actualPrefix = 50;
  let businessCalls = 0;
  const tx = {
    query: async (sql: string) => {
      if (sql.startsWith('LOCK TABLE')) return { rows: [], rowCount: 0 };
      if (sql.startsWith('SELECT name,checksum'))
        return {
          rows: manifest
            .filter(({ name }) => Number(name.slice(0, 4)) <= actualPrefix)
            .map(({ name, checksum }) => ({ name, checksum })),
        };
      if (sql.startsWith('SELECT NOT EXISTS'))
        return { rows: [{ absent: true }] };
      assert.equal(
        sql,
        'SELECT status FROM whaleu_identity.accounts WHERE id=$1 FOR SHARE',
        'The predecessor does not query the future lifecycle column',
      );
      businessCalls++;
      return { rows: [{ status: 'active' }], rowCount: 1 };
    },
  } as unknown as PoolClient;
  const database = {} as DatabaseService;
  startTransactionDeadlines(tx);
  try {
    for (const prefix of [50, 51, 52]) {
      assert.ok(historicalPrefixes.get(prefix)?.includes('subscription'));
      actualPrefix = prefix;
      const owner = await historicalIdentityRepository(
        database,
        config,
        prefix,
      );
      assert.equal(await owner.activeAccount('account', tx), true);
      assert.equal(businessCalls, prefix - 49);
      actualPrefix++;
      await assert.rejects(
        owner.activeAccount('account', tx),
        /Historical Identity cannot cross an upgrade/,
      );
      assert.equal(businessCalls, prefix - 49, 'Stale owner never reaches SQL');
    }
  } finally {
    clearTransactionDeadlines(tx);
  }
});

test('subscription activation rebuilds the application without advancing or skipping its historical boundaries', async () => {
  const source = await readFile(
    new URL(
      './integration/ratings-subscription-activation.test.ts',
      import.meta.url,
    ),
    'utf8',
  );
  assert.match(source, /const restartApp = async \(prefix: 50 \| 51 \| 52\)/);
  assert.match(
    source,
    /const old = app;\s*app = undefined;\s*await old\?\.close\(\)/,
  );
  const configure = source.indexOf(
    'await configureHistoricalAccountPolicy(builder, config, prefix)',
  );
  assert.ok(configure >= 0 && configure < source.indexOf('builder.compile()'));
  assert.deepEqual(
    [...source.matchAll(/await restartApp\((\d+)\)/g)].map((match) =>
      Number(match[1]),
    ),
    [50, 51, 52],
  );
  assert.deepEqual(
    [
      ...source.matchAll(
        /await runMigrations\(pool, through\((\d+)\), \{ mode: 'up' \}\)/g,
      ),
    ].map((match) => Number(match[1])),
    [50, 51, 52, 52],
    'Retain the exact 0051-to-0052 gap and the 0052 idempotency rerun',
  );
  for (const prefix of [51, 52]) {
    const migration = source.indexOf(
      `await runMigrations(pool, through(${prefix})`,
    );
    const rebuilt = source.indexOf(`await restartApp(${prefix})`);
    assert.ok(migration >= 0 && migration < rebuilt);
  }
  assert.match(source, /const runtime = \(\) => \{\s*assert\.ok\(app,/);
  assert.doesNotMatch(
    source,
    /NestFactory|const runtime = app|runtime\.get\(|app: runtime,|createRuntimeActor\(runtime\)/,
  );
  assert.match(source, /runtime\(\)\s*\.get\(ExperienceWorker\)/);
  assert.match(source, /\{ app: runtime\(\), pool \}/);
});
