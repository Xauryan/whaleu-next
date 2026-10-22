import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import request from 'supertest';
import { ConfigurationModule, loadConfig } from '../../src/config/config.js';
import {
  DatabaseService,
  poolOptions,
  supportedPostgresVersion,
} from '../../src/database/database.js';
import {
  MIGRATION_LOCK,
  runMigrations,
} from '../../src/database/migrations.js';
import { HealthModule } from '../../src/health/health.js';
import {
  APPLICATION_SCHEMA_FLOOR,
  readApplicationMigrations,
} from '../../src/health/readiness.js';
import { assertReadinessUnavailableResponse } from '../support/readiness-response.js';
import { configureHttp } from '../../src/http/http.js';
import { ObservabilityModule } from '../../src/observability/logger.js';
import { migrationSchemaNames } from '../support/migration-schemas.js';

/** Actual migration files, actual DatabaseService and actual HealthModule.
 * No AppModule, synthetic ready result, provider, scheduler or production target.
 * Invoke only through the existing controlled disposable PostgreSQL runner. */
test(
  'application readiness qualifies the complete deployed migration ledger on fresh PostgreSQL',
  { timeout: 240000 },
  async (t) => {
    assert.equal(
      process.env['WHALEU_TEST_MAINTENANCE'],
      'controlled',
      'Readiness integration requires the controlled disposable test runner',
    );
    const connection = process.env['TEST_DATABASE_URL'];
    assert.ok(connection, 'Set TEST_DATABASE_URL; this test never skips');
    const url = new URL(connection);
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
    assert.equal(url.pathname, '/whaleu_test');
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: connection,
      PG_SSL_MODE: 'disable',
      PG_POOL_MAX: '3',
      PG_CONNECTION_TIMEOUT_MS: '2000',
      PG_STATEMENT_TIMEOUT_MS: '3000',
      LOG_LEVEL: 'silent',
    });
    const pool = new Pool({
      ...poolOptions(config),
      // Full trusted migration installation has its own bounded setup budget.
      statement_timeout: 60000,
    });
    let suite: PoolClient | undefined;
    let module: TestingModule | undefined;
    let app: INestApplication | undefined;
    let suiteLocked = false;
    let ownsSchemas = false;

    const health = async (status: 200 | 503) => {
      assert.ok(app);
      const live = await request(app.getHttpServer())
        .get('/health/live')
        .expect(200);
      assert.deepEqual(live.body, { status: 'ok' });
      assert.equal(live.headers['cache-control'], 'no-store');
      const ready = await request(app.getHttpServer())
        .get('/health/ready')
        .expect(status);
      assert.equal(ready.headers['cache-control'], 'no-store');
      if (status === 200) assert.deepEqual(ready.body, { status: 'ok' });
      else {
        assertReadinessUnavailableResponse(
          ready.body,
          ready.headers['x-request-id'],
        );
      }
    };
    const assertMigrationGateReleased = async () => {
      assert.ok(suite);
      const rows = (
        await suite.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_lock($1, $2) AS locked',
          [...MIGRATION_LOCK],
        )
      ).rows;
      assert.equal(
        rows[0]?.locked,
        true,
        'Probe must release its transaction-shared migration gate',
      );
      try {
        assert.equal(rows.length, 1);
      } finally {
        if (rows[0]?.locked)
          await suite.query('SELECT pg_advisory_unlock($1, $2)', [
            ...MIGRATION_LOCK,
          ]);
      }
    };

    try {
      suite = await pool.connect();
      suiteLocked =
        (
          await suite.query<{ locked: boolean }>(
            'SELECT pg_try_advisory_lock($1, $2) AS locked',
            [MIGRATION_LOCK[0], 2],
          )
        ).rows[0]?.locked === true;
      assert.equal(
        suiteLocked,
        true,
        'Another integration suite owns this disposable database',
      );
      const version = (
        await suite.query<{ version: number }>(
          "SELECT current_setting('server_version_num')::integer AS version",
        )
      ).rows[0]?.version;
      assert.ok(supportedPostgresVersion(version ?? 0));
      const existing = (
        await suite.query<{ count: number }>(
          "SELECT count(*)::integer AS count FROM pg_namespace WHERE nspname LIKE 'whaleu\\_%' ESCAPE '\\'",
        )
      ).rows[0]?.count;
      assert.equal(
        existing,
        0,
        'Never touch a database with an existing application schema',
      );
      ownsSchemas = true;

      const migrations = await readApplicationMigrations();
      assert.ok(migrations.length >= 182);
      assert.equal(migrations[181]?.name, APPLICATION_SCHEMA_FLOOR);
      assert.equal(config.COMMUNITY_READING_FORMATTING_PROCESSING, 'disabled');
      assert.equal(config.COMMUNITY_TEXT_REVIEW, 'disabled');
      assert.equal(config.WECHAT_APP_ID, undefined);

      module = await Test.createTestingModule({
        imports: [
          ConfigurationModule.register(config),
          ObservabilityModule,
          HealthModule,
        ],
      }).compile();
      app = module.createNestApplication({ logger: false });
      configureHttp(app);
      await app.init();

      await t.test(
        'empty database is 503 without installing a ledger or killing liveness',
        async () => {
          await health(503);
          assert.equal(
            (
              await suite!.query<{ present: string | null }>(
                "SELECT to_regclass('whaleu_meta.schema_migrations')::text AS present",
              )
            ).rows[0]?.present,
            null,
          );
          await assertMigrationGateReleased();
        },
      );

      // No historical prefix or fixture checksum substitute: install every
      // migration shipped in this exact binary, currently the full 0001–0182.
      await runMigrations(pool, migrations, { mode: 'up' });
      const original = (
        await pool.query<{ name: string; checksum: string; appliedAt: string }>(
          'SELECT name, checksum, applied_at::text AS "appliedAt" FROM whaleu_meta.schema_migrations ORDER BY name',
        )
      ).rows;
      assert.equal(original.length, migrations.length);

      await t.test(
        'complete installed current chain is 200 with formatting/providers disabled',
        async () => {
          await health(200);
          await assertMigrationGateReleased();
        },
      );

      await t.test(
        'missing installed history entry is 503, then exact restoration recovers',
        async () => {
          const removed = original[Math.floor(original.length / 2)]!;
          await pool.query(
            'DELETE FROM whaleu_meta.schema_migrations WHERE name = $1',
            [removed.name],
          );
          try {
            await health(503);
            await assertMigrationGateReleased();
          } finally {
            await pool.query(
              'INSERT INTO whaleu_meta.schema_migrations (name, checksum, applied_at) VALUES ($1, $2, $3::timestamptz)',
              [removed.name, removed.checksum, removed.appliedAt],
            );
          }
          await health(200);
        },
      );

      await t.test(
        'drifted recorded checksum is 503, then exact restoration recovers',
        async () => {
          const record = original[0]!;
          const drifted =
            (record.checksum[0] === '0' ? '1' : '0') + record.checksum.slice(1);
          await pool.query(
            'UPDATE whaleu_meta.schema_migrations SET checksum = $1 WHERE name = $2',
            [drifted, record.name],
          );
          try {
            await health(503);
          } finally {
            await pool.query(
              'UPDATE whaleu_meta.schema_migrations SET checksum = $1 WHERE name = $2',
              [record.checksum, record.name],
            );
          }
          await health(200);
        },
      );

      await t.test(
        'unknown additional history is 503, then its removal recovers',
        async () => {
          const unknown = 'unexpected_application_readiness.sql';
          await pool.query(
            'INSERT INTO whaleu_meta.schema_migrations (name, checksum) VALUES ($1, $2)',
            [unknown, 'a'.repeat(64)],
          );
          try {
            await health(503);
          } finally {
            await pool.query(
              'DELETE FROM whaleu_meta.schema_migrations WHERE name = $1',
              [unknown],
            );
          }
          await health(200);
        },
      );

      await t.test(
        'missing ledger errors roll back and release the migration gate',
        async () => {
          await pool.query(
            'ALTER TABLE whaleu_meta.schema_migrations RENAME TO readiness_hidden_schema_migrations',
          );
          try {
            await health(503);
            await assertMigrationGateReleased();
          } finally {
            await pool.query(
              'ALTER TABLE whaleu_meta.readiness_hidden_schema_migrations RENAME TO schema_migrations',
            );
          }
          await health(200);
        },
      );

      await t.test(
        'exclusive approved migrator lock yields 503, retains liveness and recovers on release',
        async () => {
          const locked =
            (
              await suite!.query<{ locked: boolean }>(
                'SELECT pg_try_advisory_lock($1, $2) AS locked',
                [...MIGRATION_LOCK],
              )
            ).rows[0]?.locked === true;
          assert.equal(locked, true);
          try {
            await health(503);
          } finally {
            if (locked)
              await suite!.query('SELECT pg_advisory_unlock($1, $2)', [
                ...MIGRATION_LOCK,
              ]);
          }
          await health(200);
          await assertMigrationGateReleased();
        },
      );

      await t.test(
        'all probes preserve the exact migration installation records',
        async () => {
          const after = (
            await pool.query(
              'SELECT name, checksum, applied_at::text AS "appliedAt" FROM whaleu_meta.schema_migrations ORDER BY name',
            )
          ).rows;
          assert.deepEqual(after, original);
        },
      );

      await t.test(
        'shutdown closes readiness without changing liveness',
        async () => {
          module!.get(DatabaseService).beforeApplicationShutdown();
          await health(503);
        },
      );
    } finally {
      try {
        if (app) await app.close();
        else await module?.close();
      } finally {
        try {
          if (ownsSchemas && suite) {
            for (const schema of migrationSchemaNames)
              await suite.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
            const remaining = (
              await suite.query<{ count: number }>(
                "SELECT count(*)::integer AS count FROM pg_namespace WHERE nspname LIKE 'whaleu\\_%' ESCAPE '\\'",
              )
            ).rows[0]?.count;
            assert.equal(
              remaining,
              0,
              'Shared cleanup schema list must cover every shipped migration schema',
            );
          }
        } finally {
          try {
            if (suiteLocked && suite)
              await suite.query('SELECT pg_advisory_unlock($1, $2)', [
                MIGRATION_LOCK[0],
                2,
              ]);
          } finally {
            suite?.release();
            await pool.end();
          }
        }
      }
    }
  },
);
