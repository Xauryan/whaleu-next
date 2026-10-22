import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { loadConfig } from '../../src/config/config.js';
import { configureHttp } from '../../src/http/http.js';
import {
  inTransaction,
  poolOptions,
  supportedPostgresVersion,
} from '../../src/database/database.js';
import {
  MIGRATION_LOCK,
  readMigrations,
  runMigrations,
} from '../../src/database/migrations.js';
import { TextReviewOperator } from '../../src/community/text-review/operator.js';
import { TextReviewRuntime } from '../../src/community/text-review/runtime.js';
import { planSchema } from '../../src/community/reading-formatting/contracts.js';
import { assertReadingWorkerRole } from '../../src/community/reading-formatting/worker-process.js';
import {
  createRuntimeActor,
  setRuntimeVerification,
} from '../support/community-runtime-fixtures.js';
import {
  seedCommunityScope,
  appendIdentitySelection,
} from '../support/community-scope-fixtures.js';
import { migrationSchemaNames } from '../support/migration-schemas.js';
import {
  createReadingWorkerLogin,
  readingLoginAuthMode,
} from '../support/reading-worker-login.js';
import { readingWorkerDockerTarget } from '../support/reading-worker-docker-target.js';
import {
  readingCliEnvironment,
  startReadingCli,
} from '../support/reading-worker-cli.js';

/** Standalone verified-TLS disposable lane. Explicit password mode must reject
 * a wrong synthetic password; explicit local trust makes no authentication claim.
 * Missing/unknown auth modes fail before connecting, with no HBA changes.
 * Runtime production guard currently checks current_user, not session_user. This
 * test proves a genuine direct session without changing that guard or SET ROLE.
 * Source publisher Identity fixtures are test-only; Review/publication are real.
 * Actual SIGTERM here proves clean idle shutdown after a completed tick. Pure
 * reading-process tests separately prove controlled in-flight draining; no
 * pg_stat_activity/signal timing race is presented as in-flight proof.
 * Default requires the ordinary API build's compiled entry. An explicit source
 * probe is not build-backed acceptance and must be rerun in the default mode. */
test(
  'production reading CLI: direct LOGIN, genuine queued source, source/compiled once, serve shutdown and privileged denial',
  { timeout: 180000 },
  async (t) => {
    const authMode = readingLoginAuthMode(
      process.env['TEST_READING_LOGIN_AUTH'],
    );
    t.diagnostic(
      authMode === 'password'
        ? 'Explicit password-authentication lane; wrong-password rejection is required.'
        : 'Explicit controlled loopback-trust lane; password authentication is NOT tested.',
    );
    const phase =
      process.env['TEST_READING_CLI_EXECUTION'] ?? 'source_and_compiled';
    assert.ok(phase === 'source_and_compiled' || phase === 'source');
    const apiRoot = fileURLToPath(new URL('../../', import.meta.url));
    if (phase === 'source_and_compiled')
      await access(
        join(apiRoot, 'dist/community/reading-formatting/process-reading.js'),
      );
    else
      t.diagnostic(
        'Explicit source-only probe; compiled entry acceptance is NOT RUN and remains required after ordinary build.',
      );
    const database = process.env['TEST_DATABASE_URL'];
    assert.ok(database);
    const docker = readingWorkerDockerTarget(
      process.env['TEST_READING_DOCKER_TARGET'],
      database,
      authMode,
    );
    const url = new URL(database);
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
    assert.equal(url.pathname, '/whaleu_test');
    const base = {
      DATABASE_URL: database,
      PG_SSL_MODE: 'verify-full',
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      COMMUNITY_UPDATES_PROCESSING: 'disabled',
      EXPERIENCE_PROCESSING: 'disabled',
      VIEW_REPORTING_RETENTION_PROCESSING: 'disabled',
    };
    const pool = new Pool(poolOptions(loadConfig(base)));
    let suite: PoolClient | undefined,
      app: INestApplication | undefined,
      login: Awaited<ReturnType<typeof createReadingWorkerLogin>> | undefined,
      rolePool: Pool | undefined;
    let owned = false,
      locked = false;
    const children: ReturnType<typeof startReadingCli>[] = [];
    let failure: unknown;
    try {
      suite = await pool.connect();
      locked = (
        await suite.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_lock($1,$2) locked',
          [MIGRATION_LOCK[0], 2],
        )
      ).rows[0]!.locked;
      assert.equal(locked, true);
      assert.equal(
        (
          await suite.query<{ ssl: boolean }>(
            'SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()',
          )
        ).rows[0]?.ssl,
        true,
      );
      assert.ok(
        supportedPostgresVersion(
          (
            await suite.query<{ v: number }>(
              "SELECT current_setting('server_version_num')::integer v",
            )
          ).rows[0]!.v,
        ),
      );
      assert.equal(
        (
          await suite.query<{ n: number }>(
            "SELECT count(*)::integer n FROM pg_namespace WHERE nspname LIKE 'whaleu\\_%' ESCAPE '\\'",
          )
        ).rows[0]!.n,
        0,
      );
      owned = true;
      const migrations = await readMigrations(join(apiRoot, 'migrations'));
      // The updated restricted worker runs the complete installed prefix,
      // including Home dependency proof. Preserve every original V6 claim,
      // fencing, failure and process-lifecycle assertion below.
      assert.equal(
        migrations.filter(
          (migration) =>
            migration.name === '0176_durable_reading_formatting.sql',
        ).length,
        1,
      );
      // readMigrations enforces unique, sorted four-digit IDs. Require this
      // exact consecutive predecessor sequence, not a permanent latest version.
      assert.deepEqual(
        migrations
          .filter((m) => {
            const version = Number(m.name.slice(0, 4));
            return version >= 178 && version <= 181;
          })
          .map((m) => m.name),
        [
          '0178_home_publication_protocol.sql',
          '0179_identity_registration_guard.sql',
          '0180_identity_session_revocation_epoch.sql',
          '0181_identity_real_deletion_preparations.sql',
        ],
      );
      await runMigrations(pool, migrations, { mode: 'up' });
      assert.deepEqual(
        (
          await pool.query<{ name: string; checksum: string }>(
            'SELECT name,checksum FROM whaleu_meta.schema_migrations ORDER BY name',
          )
        ).rows,
        migrations.map(({ name, checksum }) => ({ name, checksum })),
      );
      // Full-chain execution must retain the original Home/Reading seals.
      assert.deepEqual(
        (
          await pool.query(`SELECT
            whaleu_community.home_publication_protocol()->>'catalog'=whaleu_community.home_publication_catalog() publication,
            whaleu_community.home_reading_protocol()->>'catalog'=whaleu_community.home_reading_catalog() home_reading,
            whaleu_community.reading_format_protocol()->>'catalog'=whaleu_community.reading_format_catalog() reading`)
        ).rows[0],
        { publication: true, home_reading: true, reading: true },
      );
      const scope = await seedCommunityScope(pool);
      const config = loadConfig({
        ...base,
        COMMUNITY_TEXT_REVIEW: 'local_manual',
        COMMUNITY_TEXT_REVIEW_SPACE_ID: scope.home.spaceId,
        COMMUNITY_TEXT_REVIEW_REGION_ID: scope.home.regionId,
        COMMUNITY_TEXT_REVIEW_POLICY_ID: randomUUID(),
        COMMUNITY_TEXT_SOURCE_REVIEW_POLICY_ID: randomUUID(),
        COMMUNITY_TEXT_REVIEW_OPERATOR: 'local:test:reviewer',
      });
      app = await NestFactory.create(AppModule.register(config), {
        logger: false,
      });
      configureHttp(app);
      await app.init();
      const actor = await createRuntimeActor(app),
        facts = await setRuntimeVerification(
          pool,
          actor.accountId,
          scope.institutionId,
          scope.home.regionId,
        );
      await appendIdentitySelection(
        pool,
        actor.accountId,
        facts,
        scope,
        scope.home.campusId,
      );
      const operator = new TextReviewOperator(
        app.get(TextReviewRuntime),
        'local:test:reviewer',
      );
      const run = (command: Parameters<TextReviewOperator['run']>[0]) =>
        inTransaction(pool, (tx) => operator.run(command, tx));
      await run({
        command: 'init-policy',
        basis: 'Disposable genuine CLI worker source fixture',
      });
      const policy = {
        postEnabled: true,
        commentEnabled: true,
        namedOnly: true as const,
        categories: ['discussion' as const],
        validForHours: 24,
        basis: 'Disposable source scope fixture',
      };
      const preview = await run({ command: 'preview-region', ...policy });
      assert.ok(
        typeof preview === 'object' &&
          preview !== null &&
          'currentRevision' in preview &&
          typeof preview.currentRevision === 'number' &&
          'previewDigest' in preview &&
          typeof preview.previewDigest === 'string',
      );
      await run({
        command: 'apply-region',
        ...policy,
        expectedRevision: preview.currentRevision,
        previewDigest: preview.previewDigest,
      });
      await run({
        command: 'init-source-policy',
        basis: 'Disposable explicit original-source coverage',
      });
      const http = app.getHttpServer();
      const publish = async () => {
        const input = {
          clientRequestId: randomUUID(),
          spaceId: scope.home.spaceId,
          category: 'discussion',
          text: ('鲸'.repeat(119) + '。').repeat(3),
          imageAssetIds: [],
          authorMode: 'named',
          commentsPolicy: 'open',
          allowAnonymousDm: false,
          textSource: {
            version: 1,
            format: 'plain',
            readingFormatting: 'auto',
          },
        };
        const call = (path: string) =>
          request(http)
            .post(path)
            .set('Authorization', `Bearer ${actor.accessToken}`)
            .send(input);
        const submitted = await call('/v1/community/reviews/posts');
        assert.equal(submitted.status, 200);
        assert.equal(submitted.body.status, 'pending');
        const shown = await run({
          command: 'show',
          accountId: actor.accountId,
          requestId: input.clientRequestId,
        });
        assert.ok(
          typeof shown === 'object' &&
            shown !== null &&
            'digest' in shown &&
            typeof shown.digest === 'string',
        );
        await run({
          command: 'decide',
          accountId: actor.accountId,
          requestId: input.clientRequestId,
          digest: shown.digest,
          decision: 'allow',
          basis: 'Fixture reviewer inspected the exact authored source',
        });
        const result = await call('/v1/community/posts');
        assert.equal(result.status, 201);
        assert.equal(result.body.outcome, 'created');
        const id: string = result.body.resourceId;
        assert.match(id, /^[a-f0-9-]{36}$/);
        assert.equal(
          (
            await pool.query(
              'SELECT state FROM whaleu_community.reading_format_jobs WHERE content_id=$1',
              [id],
            )
          ).rows[0]?.state,
          'pending',
        );
        return { id, text: input.text };
      };
      login = await createReadingWorkerLogin(pool, database, docker);
      if (authMode === 'password')
        await t.test(
          'password lane rejects a distinct wrong synthetic password without downgrade',
          async () => {
            const wrong = new URL(login!.database);
            do {
              wrong.password = randomBytes(32).toString('hex');
            } while (wrong.password === new URL(login!.database).password);
            const denied = new Pool(
              poolOptions(
                loadConfig({
                  ...base,
                  NODE_ENV: 'production',
                  DATABASE_URL: wrong.href,
                  PG_POOL_MAX: '1',
                  PG_CONNECTION_TIMEOUT_MS: '5000',
                }),
              ),
            );
            let code: unknown;
            try {
              await denied.query('SELECT 1');
            } catch (error) {
              if (
                typeof error === 'object' &&
                error !== null &&
                'code' in error
              )
                code = error.code;
            } finally {
              await denied.end();
            }
            // Never attach a raw PG error, connection URL or password to TAP.
            assert.equal(
              code,
              '28P01',
              'Wrong-password attempt must fail with authentication SQLSTATE',
            );
          },
        );
      rolePool = new Pool(
        poolOptions(
          loadConfig({
            ...base,
            NODE_ENV: 'production',
            DATABASE_URL: login.database,
            PG_POOL_MAX: '1',
          }),
        ),
      );
      await t.test(
        'direct TLS LOGIN uses its own session principal and unchanged least privileges',
        async () => {
          const connection = await rolePool!.connect();
          try {
            const identity = (
              await connection.query<{
                current: string;
                session: string;
                ssl: boolean;
              }>(
                `SELECT current_user AS current,session_user AS session,(SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()) ssl`,
              )
            ).rows[0]!;
            assert.equal(identity.current, login!.name);
            assert.equal(identity.session, login!.name);
            assert.equal(identity.ssl, true);
            await assertReadingWorkerRole(connection);
          } finally {
            connection.release();
          }
          await rolePool!.end();
          rolePool = undefined;
        },
      );
      const launch = (
        entry: 'source' | 'compiled',
        mode: 'once' | 'serve',
        connection = login!.database,
      ) => {
        const child = startReadingCli(
          apiRoot,
          entry,
          mode,
          readingCliEnvironment(apiRoot, connection, mode, process.env),
        );
        children.push(child);
        return child;
      };
      const complete = async (source: Awaited<ReturnType<typeof publish>>) => {
        const result = (
          await pool.query(
            `SELECT j.state,r.plan,b.envelope->>'text' source_text,p.text canonical_text FROM whaleu_community.reading_format_jobs j JOIN whaleu_community.reading_format_results r USING(job_key) JOIN whaleu_community.community_text_sources s ON (s.content_kind,s.content_id)=(j.content_kind,j.content_id) JOIN whaleu_community.content_approval_bindings b ON (b.content_kind,b.content_id,b.decision_id)=(s.content_kind,s.content_id,s.decision_id) JOIN whaleu_community.posts p ON p.id=j.content_id WHERE j.content_id=$1`,
            [source.id],
          )
        ).rows[0];
        assert.ok(result);
        assert.equal(result.state, 'complete');
        assert.equal(result.canonical_text, source.text);
        assert.equal(result.source_text, source.text);
        const plan = planSchema.parse(result.plan);
        assert.equal(plan.formatter, 'plain-cjk-slices-v2');
        assert.equal(
          plan.spans
            .map((span) => source.text.slice(span.start, span.end))
            .join(''),
          source.text,
        );
        assert.equal(
          (
            await pool.query(
              'SELECT count(*)::integer n FROM whaleu_community.reading_format_slots WHERE job_key IS NOT NULL',
            )
          ).rows[0]!.n,
          0,
        );
      };
      const success = (
        result: Awaited<ReturnType<ReturnType<typeof startReadingCli>['stop']>>,
      ) => {
        assert.equal(result.problem, null);
        assert.equal(result.signal, null);
        assert.equal(result.code, 0);
        assert.equal(result.stderr, 'empty');
        assert.equal(result.health.at(-1)?.state, 'stopped');
        assert.ok(result.health.some((h) => h.ticks >= 1));
      };
      await t.test(
        'real source entry once completes the genuinely published job',
        async () => {
          const source = await publish();
          success(await launch('source', 'once').done);
          await complete(source);
        },
      );
      if (phase === 'source_and_compiled')
        await t.test(
          'ordinary built entry once is mandatory in build-backed acceptance',
          async () => {
            const source = await publish();
            success(await launch('compiled', 'once').done);
            await complete(source);
          },
        );
      await t.test(
        'automatic serve completes a tick, then SIGTERM exits cleanly without leftover role sessions',
        async () => {
          const source = await publish(),
            child = launch('source', 'serve');
          await child.waitFor((h) => h.state === 'sleeping' && h.ticks >= 1);
          await complete(source);
          const result = await child.stop();
          success(result);
          assert.equal(
            (
              await pool.query(
                'SELECT count(*)::integer n FROM pg_stat_activity WHERE usename=$1',
                [login!.name],
              )
            ).rows[0]!.n,
            0,
          );
        },
      );
      await t.test(
        'privileged direct login is rejected by the real production CLI before any worker tick',
        async () => {
          await assert.rejects(assertReadingWorkerRole(suite!));
          const source = await publish(),
            result = await launch('source', 'once', database).done;
          assert.equal(result.problem, null);
          assert.equal(result.signal, null);
          assert.equal(result.code, 1);
          assert.equal(result.stderr, 'expected_failure');
          assert.deepEqual(
            result.health.map((h) => h.state),
            ['starting', 'failed'],
          );
          assert.ok(result.health.every((h) => h.ticks === 0));
          const job = (
            await pool.query(
              'SELECT state,claims FROM whaleu_community.reading_format_jobs WHERE content_id=$1',
              [source.id],
            )
          ).rows[0]!;
          assert.equal(job.state, 'pending');
          assert.equal(job.claims, 0);
        },
      );
    } catch (error) {
      failure = error;
    }
    const cleanup: unknown[] = [];
    for (const child of children)
      try {
        await child.stop();
      } catch {
        cleanup.push(new Error('CLI child cleanup failed'));
      }
    try {
      await rolePool?.end();
    } catch {
      cleanup.push(new Error('Role pool cleanup failed'));
    }
    try {
      await app?.close();
    } catch {
      cleanup.push(new Error('Application cleanup failed'));
    }
    if (login)
      try {
        assert.equal(
          (
            await pool.query(
              'SELECT count(*)::integer n FROM pg_stat_activity WHERE usename=$1',
              [login.name],
            )
          ).rows[0]!.n,
          0,
        );
        await login.close();
        assert.equal(
          (
            await pool.query(
              'SELECT count(*)::integer n FROM pg_roles WHERE rolname=$1',
              [login.name],
            )
          ).rows[0]!.n,
          0,
        );
      } catch {
        cleanup.push(new Error('Disposable LOGIN role cleanup failed'));
      }
    if (owned)
      for (const schema of migrationSchemaNames)
        try {
          await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        } catch {
          cleanup.push(new Error('Disposable schema cleanup failed'));
        }
    if (locked)
      try {
        await suite?.query('SELECT pg_advisory_unlock($1,$2)', [
          MIGRATION_LOCK[0],
          2,
        ]);
      } catch {
        cleanup.push(new Error('Fixture lock cleanup failed'));
      }
    suite?.release();
    try {
      await pool.end();
    } catch {
      cleanup.push(new Error('Administrator pool cleanup failed'));
    }
    if (cleanup.length)
      throw new AggregateError(
        failure === undefined ? cleanup : [failure, ...cleanup],
        'Reading CLI fixture cleanup failed',
      );
    if (failure !== undefined) throw failure;
  },
);
