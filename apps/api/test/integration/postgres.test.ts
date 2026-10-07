import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { loadConfig } from '../../src/config/config.js';
import {
  DatabaseService,
  inTransaction,
  poolOptions,
  supportedPostgresVersion,
} from '../../src/database/database.js';
import {
  MIGRATION_LOCK,
  runMigrations,
} from '../../src/database/migrations.js';
import type { Migration } from '../../src/database/migrations.js';
import { AppLogger } from '../../src/observability/logger.js';

function migration(name: string, sql: string): Migration {
  return {
    name,
    sql,
    checksum: createHash('sha256').update(sql).digest('hex'),
  };
}

test(
  'real PostgreSQL 18 migration, transaction, and readiness contract',
  { timeout: 30000 },
  async (t) => {
    const urlString = process.env['TEST_DATABASE_URL'];
    assert.ok(
      urlString,
      'Set TEST_DATABASE_URL to a new disposable local whaleu_test database; this suite never silently skips',
    );
    const url = new URL(urlString);
    assert.ok(
      ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname),
      'Integration tests require a loopback database',
    );
    assert.equal(
      url.pathname,
      '/whaleu_test',
      'Integration tests require the dedicated database name whaleu_test',
    );
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: urlString,
      PG_SSL_MODE: 'disable',
      LOG_LEVEL: 'silent',
      PG_POOL_MAX: '3',
      PG_CONNECTION_TIMEOUT_MS: '2000',
      PG_STATEMENT_TIMEOUT_MS: '3000',
    });
    const pool = new Pool(poolOptions(config));
    const fixtureSchema = `integration_${randomUUID().replaceAll('-', '')}`;
    let ownsMetadata = false;
    let ownsFixture = false;
    let suiteClient: PoolClient | undefined;
    let suiteLocked = false;
    try {
      suiteClient = await pool.connect();
      const lease = await suiteClient.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock($1, $2) AS locked',
        [MIGRATION_LOCK[0], 2],
      );
      suiteLocked = lease.rows[0]?.locked === true;
      assert.equal(
        suiteLocked,
        true,
        'Another integration suite is using this disposable database',
      );
      const version = await pool.query<{ version: number }>(
        "SELECT current_setting('server_version_num')::integer AS version",
      );
      assert.ok(
        supportedPostgresVersion(version.rows[0]?.version ?? 0),
        'PostgreSQL 18.6+ (18.x) is required',
      );
      const existing = await pool.query<{ present: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'whaleu_meta') AS present",
      );
      assert.equal(
        existing.rows[0]?.present,
        false,
        'Refusing to touch an existing migration schema; use a new disposable database',
      );

      const migrations = [
        migration(
          '0001_fixture.sql',
          `CREATE SCHEMA ${fixtureSchema}; CREATE TABLE ${fixtureSchema}.records (id integer PRIMARY KEY); INSERT INTO ${fixtureSchema}.records VALUES (1);`,
        ),
        migration(
          '0002_insert.sql',
          `INSERT INTO ${fixtureSchema}.records VALUES (2);`,
        ),
      ];

      await t.test(
        'status is read-only and reports pending files',
        async () => {
          const status = await runMigrations(pool, migrations, {
            mode: 'status',
          });
          assert.deepEqual(
            status.map(({ status }) => status),
            ['pending', 'pending'],
          );
          const table = await pool.query<{ present: string | null }>(
            "SELECT to_regclass('whaleu_meta.schema_migrations')::text AS present",
          );
          assert.equal(table.rows[0]?.present, null);
        },
      );

      await t.test(
        'up applies in order, records checksums, and is repeatable',
        async () => {
          ownsMetadata = true;
          ownsFixture = true;
          const status = await runMigrations(pool, migrations, { mode: 'up' });
          assert.deepEqual(
            status.map(({ status }) => status),
            ['applied', 'applied'],
          );
          await runMigrations(pool, migrations, { mode: 'up' });
          const records = await pool.query<{ id: number }>(
            `SELECT id FROM ${fixtureSchema}.records ORDER BY id`,
          );
          assert.deepEqual(records.rows, [{ id: 1 }, { id: 2 }]);
          const ledger = await pool.query<{ count: number }>(
            'SELECT count(*)::integer AS count FROM whaleu_meta.schema_migrations',
          );
          assert.equal(ledger.rows[0]?.count, 2);
        },
      );

      await t.test(
        'checksum changes and missing applied files fail closed',
        async () => {
          await assert.rejects(
            runMigrations(
              pool,
              [migration('0001_fixture.sql', 'SELECT 1;'), migrations[1]!],
              { mode: 'up' },
            ),
            /history mismatch/,
          );
          await assert.rejects(
            runMigrations(pool, [], { mode: 'status' }),
            /history mismatch/,
          );
        },
      );

      await t.test(
        'failed SQL and its bookkeeping are both rolled back',
        async () => {
          const broken = migration(
            '0003_broken.sql',
            `INSERT INTO ${fixtureSchema}.records VALUES (3); SELECT * FROM ${fixtureSchema}.missing_table;`,
          );
          await assert.rejects(
            runMigrations(pool, [...migrations, broken], { mode: 'up' }),
          );
          const records = await pool.query<{ count: number }>(
            `SELECT count(*)::integer AS count FROM ${fixtureSchema}.records`,
          );
          assert.equal(records.rows[0]?.count, 2);
          const ledger = await pool.query<{ count: number }>(
            'SELECT count(*)::integer AS count FROM whaleu_meta.schema_migrations',
          );
          assert.equal(ledger.rows[0]?.count, 2);
        },
      );

      await t.test(
        'migration lock contention times out and subsequent runs recover',
        async () => {
          const blocker = await pool.connect();
          try {
            await blocker.query('SELECT pg_advisory_lock($1, $2)', [
              ...MIGRATION_LOCK,
            ]);
            await assert.rejects(
              runMigrations(pool, migrations, {
                mode: 'up',
                lockTimeoutMs: 50,
              }),
              /migration lock/,
            );
          } finally {
            await blocker.query('SELECT pg_advisory_unlock($1, $2)', [
              ...MIGRATION_LOCK,
            ]);
            blocker.release();
          }
          await runMigrations(pool, migrations, { mode: 'up' });
        },
      );

      await t.test('transaction helper rolls back real writes', async () => {
        await assert.rejects(
          inTransaction(pool, async (client) => {
            await client.query(
              `INSERT INTO ${fixtureSchema}.records VALUES ($1)`,
              [3],
            );
            throw new Error('expected test rollback');
          }),
          /expected test rollback/,
        );
        const records = await pool.query<{ count: number }>(
          `SELECT count(*)::integer AS count FROM ${fixtureSchema}.records`,
        );
        assert.equal(records.rows[0]?.count, 2);
      });

      await t.test(
        'readiness probes PostgreSQL and becomes false during shutdown',
        async () => {
          const database = new DatabaseService(config, new AppLogger(config));
          try {
            assert.equal(await database.ready(), true);
            database.beforeApplicationShutdown();
            assert.equal(await database.ready(), false);
          } finally {
            await database.onApplicationShutdown();
          }
        },
      );
    } finally {
      try {
        if (ownsFixture)
          await pool.query(`DROP SCHEMA IF EXISTS ${fixtureSchema} CASCADE`);
        if (ownsMetadata)
          await pool.query('DROP SCHEMA IF EXISTS whaleu_meta CASCADE');
      } finally {
        try {
          if (suiteLocked)
            await suiteClient?.query('SELECT pg_advisory_unlock($1, $2)', [
              MIGRATION_LOCK[0],
              2,
            ]);
        } finally {
          suiteClient?.release();
          await pool.end();
        }
      }
    }
  },
);
