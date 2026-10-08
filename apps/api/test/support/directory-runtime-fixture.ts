/** Disposable canonical owner facts and ordinary AppModule. No replacement ports. */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { AppModule } from '../../src/app.module.js';
import { loadConfig } from '../../src/config/config.js';
import {
  poolOptions,
  supportedPostgresVersion,
} from '../../src/database/database.js';
import {
  MIGRATION_LOCK,
  readMigrations,
  runMigrations,
} from '../../src/database/migrations.js';
import { configureHttp } from '../../src/http/http.js';
import {
  createRuntimeActor,
  setRuntimeVerification,
} from './community-runtime-fixtures.js';
import {
  appendIdentitySelection,
  seedCommunityScope,
} from './community-scope-fixtures.js';
import { migrationSchemaNames } from './migration-schemas.js';

export async function directoryRuntimeFixture() {
  const database = process.env['TEST_DATABASE_URL'];
  assert.ok(
    database,
    'Directory acceptance requires disposable loopback whaleu_test; no skips',
  );
  const url = new URL(database);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  assert.equal(url.pathname, '/whaleu_test');
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: database,
    PG_SSL_MODE: 'disable',
    LOG_LEVEL: 'silent',
    PG_POOL_MAX: '16',
    PG_STATEMENT_TIMEOUT_MS: '15000',
    COMMUNITY_UPDATES_PROCESSING: 'disabled',
  });
  const pool = new Pool(poolOptions(config));
  let suite: PoolClient | undefined, app: INestApplication | undefined;
  let owns = false,
    locked = false;
  const cleanup = async () => {
    try {
      await app?.close();
    } finally {
      try {
        if (owns) {
          for (const schema of migrationSchemaNames)
            await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
          assert.equal(
            (
              await pool.query(
                "SELECT 1 FROM pg_namespace WHERE nspname LIKE 'whaleu\\_%' ESCAPE '\\'",
              )
            ).rowCount,
            0,
            'Directory fixture must leave no application schemas',
          );
        }
      } finally {
        if (locked)
          await suite?.query('SELECT pg_advisory_unlock($1,$2)', [
            MIGRATION_LOCK[0],
            2,
          ]);
        suite?.release();
        await pool.end();
      }
    }
  };
  try {
    suite = await pool.connect();
    locked = (
      await suite.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock($1,$2) locked',
        [MIGRATION_LOCK[0], 2],
      )
    ).rows[0]!.locked;
    assert.ok(locked, 'Run disposable PostgreSQL suites serially');
    assert.ok(
      supportedPostgresVersion(
        (
          await pool.query<{ v: number }>(
            "SELECT current_setting('server_version_num')::integer v",
          )
        ).rows[0]!.v,
      ),
    );
    assert.equal(
      (
        await pool.query(
          "SELECT 1 FROM pg_namespace WHERE nspname LIKE 'whaleu\\_%' ESCAPE '\\'",
        )
      ).rowCount,
      0,
      'Refuse preexisting application schemas',
    );
    owns = true;
    await runMigrations(
      pool,
      await readMigrations(
        fileURLToPath(new URL('../../migrations', import.meta.url)),
      ),
      { mode: 'up' },
    );
    app = await NestFactory.create(AppModule.register(config), {
      logger: false,
    });
    configureHttp(app);
    await app.listen(0, '127.0.0.1');
    const runtime = app,
      scope = await seedCommunityScope(pool);
    const certify = async (
      accountId: string,
      options: {
        affiliation?: 'verified' | 'unverified' | 'unavailable';
        phone?: 'verified' | 'unverified' | 'unavailable';
        expiresAt?: Date;
        campusId?: string;
        identity?: boolean;
      } = {},
    ) => {
      const facts = await setRuntimeVerification(
        pool,
        accountId,
        scope.institutionId,
        scope.home.regionId,
        options.affiliation ?? 'verified',
        options.phone ?? 'verified',
        options.expiresAt ?? new Date(Date.now() + 3_600_000),
      );
      if (
        options.identity !== false &&
        (options.affiliation ?? 'verified') === 'verified'
      )
        await appendIdentitySelection(
          pool,
          accountId,
          facts,
          scope,
          options.campusId ?? scope.home.campusId,
        );
      return facts;
    };
    const actor = async (options: Parameters<typeof certify>[1] = {}) => {
      const result = await createRuntimeActor(runtime);
      const facts = await certify(result.accountId, options);
      return { ...result, facts };
    };
    const waitForLock = async (fragment: string) => {
      const until = Date.now() + 5000;
      while (Date.now() < until) {
        const row = (
          await pool.query<{ waiting: boolean }>(
            "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE $1) waiting",
            [`%${fragment}%`],
          )
        ).rows[0]!;
        if (row.waiting) return;
        await sleep(10);
      }
      assert.fail(`Expected observed PostgreSQL lock wait: ${fragment}`);
    };
    const snapshot = async () => {
      const tables = (
        await pool.query<{ table_schema: string; table_name: string }>(
          "SELECT table_schema,table_name FROM information_schema.tables WHERE table_schema LIKE 'whaleu\\_%' ESCAPE '\\' AND table_type='BASE TABLE' ORDER BY table_schema,table_name",
        )
      ).rows;
      const result: Record<string, unknown> = {};
      for (const { table_schema, table_name } of tables) {
        // Bounded operational request/cursor metadata is not domain state.
        if (
          [
            'whaleu_runtime.request_throttle_counters',
            'whaleu_community.discovery_cursors',
          ].includes(`${table_schema}.${table_name}`)
        )
          continue;
        assert.match(table_schema, /^[a-z_]+$/);
        assert.match(table_name, /^[a-z_]+$/);
        result[`${table_schema}.${table_name}`] = (
          await pool.query(
            `SELECT coalesce(jsonb_agg(row ORDER BY row::text),'[]'::jsonb) rows FROM (SELECT to_jsonb(t) row FROM ${table_schema}.${table_name} t) s`,
          )
        ).rows[0]!.rows;
      }
      const sequences = (
        await pool.query<{ schemaname: string; sequencename: string }>(
          "SELECT schemaname,sequencename FROM pg_sequences WHERE schemaname LIKE 'whaleu\\_%' ESCAPE '\\' ORDER BY schemaname,sequencename",
        )
      ).rows;
      for (const { schemaname, sequencename } of sequences) {
        assert.match(schemaname, /^[a-z_]+$/);
        assert.match(sequencename, /^[a-z_]+$/);
        result[`${schemaname}.${sequencename}`] = (
          await pool.query(
            `SELECT last_value,is_called FROM ${schemaname}.${sequencename}`,
          )
        ).rows;
      }
      return result;
    };
    return {
      app: runtime,
      pool,
      scope,
      actor,
      certify,
      snapshot,
      waitForLock,
      port: Number(new URL(await runtime.getUrl()).port),
      close: cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
export type DirectoryRuntimeFixture = Awaited<
  ReturnType<typeof directoryRuntimeFixture>
>;
