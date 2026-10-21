import { ReadingSourceOwner } from '../../src/community/reading-formatting/source-owner.js';
import {
  createReadingWorkerRole,
  withReadingWorkerRole,
} from '../support/reading-worker-role.js';
import { inspectReadingSchema } from '../../src/community/reading-formatting/readiness.js';
import { assertReadingWorkerRole } from '../../src/community/reading-formatting/worker-process.js';
import { ApplicationError } from '../../src/http/application-error.js';
import { textSourceReadSchema } from '../../src/community/text-source/protocol.js';
import { textSourceReadV2Schema } from '../../src/community/reading-formatting/reader.js';
import { verifyReadingAncestorMedia } from '../support/reading-media-fixture.js';
import {
  createReadingLifecycleSandbox,
  createReadingLifecycleActor,
  enterReadingLifecycleCooling,
} from '../support/reading-lifecycle-fixture.js';
import {
  ReadingFormattingRuntime,
  decodeCandidate,
} from '../../src/community/reading-formatting/runtime.js';
import { ReadingFormattingWorker } from '../../src/community/reading-formatting/worker.js';
import { formatSource } from '../../src/community/reading-formatting/formatter.js';
import { inventory } from '../../src/account-deletion/owners/preflight.js';
import { DeletionError } from '../../src/account-deletion/contracts.js';
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { loadConfig } from '../../src/config/config.js';
import {
  inTransaction,
  DatabaseService,
  poolOptions,
  supportedPostgresVersion,
} from '../../src/database/database.js';
import {
  MIGRATION_LOCK,
  readMigrations,
  runMigrations,
} from '../../src/database/migrations.js';
import { configureHttp } from '../../src/http/http.js';
import { TextReviewOperator } from '../../src/community/text-review/operator.js';
import { TextReviewRuntime } from '../../src/community/text-review/runtime.js';
import {
  createRuntimeActor,
  setRuntimeVerification,
} from '../support/community-runtime-fixtures.js';
import {
  seedCommunityScope,
  appendIdentitySelection,
  withCommunityScopeWriter,
} from '../support/community-scope-fixtures.js';
import { migrationSchemaNames } from '../support/migration-schemas.js';

/** Real runtime HTTP and real local issuer. Only identity/scope/phone facts are
 * synthetic disposable fixtures; this is not a real WeChat-device acceptance. */
test(
  'durable reading: real publication, owner proofs, queue, leases, optional read and SQL adversarial closure',
  { timeout: 240000 },
  async (t) => {
    const database = process.env['TEST_DATABASE_URL'];
    assert.ok(database);
    const url = new URL(database);
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
    assert.equal(url.pathname, '/whaleu_test');
    const base = {
      NODE_ENV: 'test',
      DATABASE_URL: database,
      PG_SSL_MODE: 'disable',
      LOG_LEVEL: 'silent',
      PG_STATEMENT_TIMEOUT_MS: '60000',
      COMMUNITY_UPDATES_PROCESSING: 'disabled',
      EXPERIENCE_PROCESSING: 'disabled',
      VIEW_REPORTING_RETENTION_PROCESSING: 'disabled',
    };
    const pool = new Pool(poolOptions(loadConfig(base)));
    let role: Awaited<ReturnType<typeof createReadingWorkerRole>> | undefined;
    let suite: PoolClient | undefined,
      app: INestApplication | undefined,
      owns = false,
      locked = false;
    try {
      suite = await pool.connect();
      locked = (
        await suite.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_lock($1,$2) AS locked',
          [MIGRATION_LOCK[0], 2],
        )
      ).rows[0]!.locked;
      assert.ok(locked);
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
          await pool.query<{ n: number }>(
            "SELECT count(*)::integer n FROM pg_namespace WHERE nspname LIKE 'whaleu\\_%' ESCAPE '\\'",
          )
        ).rows[0]!.n,
        0,
      );
      owns = true;
      const migrations = await readMigrations(
        fileURLToPath(new URL('../../migrations', import.meta.url)),
      );
      // Seal the genuine published c27 registry before the unqualified M1 source
      // extension. Both stages retain normal checksum/ordered-prefix checks.
      const beforeSource = migrations.filter(
        (m) => Number(m.name.slice(0, 4)) <= 174,
      );
      assert.equal(
        beforeSource.at(-1)?.name,
        '0174_account_deletion_inventory_collation.sql',
      );
      await runMigrations(pool, beforeSource, { mode: 'up' });
      const lifecycleSandbox = await createReadingLifecycleSandbox(pool);
      await runMigrations(
        pool,
        migrations.filter((m) => Number(m.name.slice(0, 4)) <= 175),
        { mode: 'up' },
      );
      assert.deepEqual(await inspectReadingSchema(suite), {
        status: 'missing',
      });
      const scope = await seedCommunityScope(pool);
      const config = loadConfig({
        ...base,
        COMMUNITY_TEXT_REVIEW: 'local_manual',
        COMMUNITY_TEXT_REVIEW_SPACE_ID: scope.home.spaceId,
        COMMUNITY_TEXT_REVIEW_REGION_ID: scope.home.regionId,
        COMMUNITY_TEXT_REVIEW_POLICY_ID: randomUUID(),
        COMMUNITY_TEXT_REVIEW_OPERATOR: 'local:test:reviewer',
        COMMUNITY_TEXT_SOURCE_REVIEW_POLICY_ID: randomUUID(),
      });
      app = await NestFactory.create(AppModule.register(config), {
        logger: false,
      });
      configureHttp(app);
      await app.init();
      const http = app.getHttpServer(),
        actor = await createReadingLifecycleActor(app, pool, lifecycleSandbox),
        other = await createRuntimeActor(app);
      const facts = await setRuntimeVerification(
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
      const otherFacts = await setRuntimeVerification(
        pool,
        other.accountId,
        scope.institutionId,
        scope.home.regionId,
      );
      await appendIdentitySelection(
        pool,
        other.accountId,
        otherFacts,
        scope,
        scope.home.campusId,
      );
      const auth = `Bearer ${actor.accessToken}`;
      const operator = new TextReviewOperator(
        app.get(TextReviewRuntime),
        config.COMMUNITY_TEXT_REVIEW_OPERATOR!,
      );
      await inTransaction(pool, (tx) =>
        operator.run(
          {
            command: 'init-policy',
            basis: 'Disposable explicit local-review acceptance policy',
          },
          tx,
        ),
      );
      const policyInput = {
        postEnabled: true,
        commentEnabled: true,
        namedOnly: true as const,
        categories: ['discussion' as const],
        validForHours: 24,
        basis: 'Explicit single-region named text experiment',
      };
      const preview = (await inTransaction(pool, (tx) =>
        operator.run({ command: 'preview-region', ...policyInput }, tx),
      )) as { currentRevision: number; previewDigest: string };
      assert.equal(preview.currentRevision, 0);
      assert.equal(
        (
          await pool.query(
            'SELECT * FROM whaleu_community.region_policy_heads WHERE region_id=$1',
            [scope.home.regionId],
          )
        ).rowCount,
        0,
      );
      await assert.rejects(
        inTransaction(pool, (tx) =>
          operator.run(
            {
              command: 'apply-region',
              ...policyInput,
              expectedRevision: preview.currentRevision,
              previewDigest: '0'.repeat(64),
            },
            tx,
          ),
        ),
      );
      await inTransaction(pool, (tx) =>
        operator.run(
          {
            command: 'apply-region',
            ...policyInput,
            expectedRevision: preview.currentRevision,
            previewDigest: preview.previewDigest,
          },
          tx,
        ),
      );
      assert.equal(
        (
          await pool.query(
            'SELECT revision FROM whaleu_community.region_policy_heads WHERE region_id=$1',
            [scope.home.regionId],
          )
        ).rows[0]!.revision,
        1,
      );
      await assert.rejects(
        inTransaction(pool, (tx) =>
          operator.run(
            {
              command: 'apply-region',
              ...policyInput,
              expectedRevision: preview.currentRevision,
              previewDigest: preview.previewDigest,
            },
            tx,
          ),
        ),
      );

      const capabilityPath = `/v1/community/text-source-capabilities?spaceId=${scope.home.spaceId}&category=discussion&authorMode=named`;
      const capability = () =>
        request(http).get(capabilityPath).set('Authorization', auth);
      assert.equal((await capability()).body.availability, 'unavailable');
      await inTransaction(pool, (tx) =>
        operator.run(
          {
            command: 'init-source-policy',
            basis:
              'Disposable source v6 coverage fixture only; not real deployment admission',
          },
          tx,
        ),
      );
      const admitted = await capability();
      assert.equal(admitted.status, 200, JSON.stringify(admitted.body));
      assert.equal(admitted.body.availability, 'available');
      assert.equal(admitted.body.authorMode, 'named');
      const anonymousCapability = await request(http)
        .get(capabilityPath.replace('authorMode=named', 'authorMode=anonymous'))
        .set('Authorization', auth);
      assert.equal(
        anonymousCapability.status,
        200,
        JSON.stringify(anonymousCapability.body),
      );
      assert.equal(anonymousCapability.body.authorMode, 'anonymous');
      assert.equal(anonymousCapability.body.availability, 'available');
      assert.ok(anonymousCapability.body.operations.includes('publish_post'));
      const missingIdentity = await request(http)
        .get(capabilityPath.replace('&authorMode=named', ''))
        .set('Authorization', auth);
      assert.equal(missingIdentity.status, 400);
      assert.equal(admitted.body.media, 'unavailable');
      assert.equal(admitted.body.markdownReferences, 'unavailable');
      assert.equal(admitted.body.formatter, 'not_configured');
      const plain = {
        version: 1,
        format: 'plain',
        readingFormatting: 'auto',
      } as const;
      const markdown = { version: 1, format: 'markdown' } as const;
      const call = (path: string, body: Record<string, unknown>) =>
        request(http).post(path).set('Authorization', auth).send(body);
      const read = (kind: string, id: string, authorization = auth) =>
        request(http)
          .get(`/v1/community/text-sources/${kind}/${id}`)
          .set('Authorization', authorization);
      const decide = async (requestId: string) => {
        const row = (
          await pool.query<{ digest: string }>(
            'SELECT digest FROM whaleu_community.text_review_requests WHERE account_id=$1 AND client_request_id=$2',
            [actor.accountId, requestId],
          )
        ).rows[0]!;
        await inTransaction(pool, (tx) =>
          operator.run(
            {
              command: 'decide',
              accountId: actor.accountId,
              requestId,
              digest: row.digest,
              decision: 'allow',
              basis:
                'Test operator explicitly reviewed exact canonical source/format/policy',
            },
            tx,
          ),
        );
        return row.digest;
      };
      const reviewed = async (path: string, body: Record<string, unknown>) => {
        const submission = await call(
          path.replace('/v1/community/', '/v1/community/reviews/'),
          body,
        );
        assert.equal(submission.status, 200, JSON.stringify(submission.body));
        assert.equal(submission.body.status, 'pending');
        const digest = await decide(body['clientRequestId'] as string);
        const first = await call(path, body);
        assert.equal(first.status, 201, JSON.stringify(first.body));
        assert.equal(first.body.outcome, 'created');
        const repeat = await call(path, body);
        assert.deepEqual(repeat.body, first.body);
        return {
          id: first.body.resourceId as string,
          digest,
          receipt: first.body,
        };
      };
      const body = {
        clientRequestId: randomUUID(),
        spaceId: scope.home.spaceId,
        category: 'discussion',
        text: 'Source Whale\r\n' + ('鲸'.repeat(119) + '。').repeat(3),
        imageAssetIds: [],
        authorMode: 'named',
        commentsPolicy: 'open',
        allowAnonymousDm: false,
        textSource: plain,
      };
      await t.test(
        'M1 without M2 publishes and reads authorized source, without fabricated formatting',
        async () => {
          const legacyOwner = await reviewed('/v1/community/posts', {
            ...body,
            clientRequestId: randomUUID(),
            text: 'M1 without M2 ' + body.text,
          });
          const response = await request(http)
            .get(`/v2/community/text-sources/post/${legacyOwner.id}`)
            .set('Authorization', auth);
          assert.equal(response.status, 200, JSON.stringify(response.body));
          const decoded = textSourceReadV2Schema.parse(response.body);
          assert.equal(decoded.presentation.status, 'source');
          assert.equal(
            decoded.source.text,
            ('M1 without M2 ' + body.text).replace(/\r\n/g, '\n'),
          );
          assert.deepEqual(await inspectReadingSchema(suite!), {
            status: 'missing',
          });
        },
      );
      await runMigrations(pool, migrations, { mode: 'up' });
      assert.equal(
        migrations.at(-1)?.name,
        '0176_durable_reading_formatting.sql',
      );
      const initialSchema = await inspectReadingSchema(suite);
      assert.equal(initialSchema.status, 'ready');
      const readinessTimings: number[] = [];
      for (let sample = 0; sample < 10; sample++) {
        const start = performance.now();
        assert.deepEqual(await inspectReadingSchema(suite), initialSchema);
        readinessTimings.push(performance.now() - start);
      }
      readinessTimings.sort((a, b) => a - b);
      t.diagnostic(
        `M2 readiness two-query actual PG cost ms: median=${readinessTimings[5]!.toFixed(3)} max=${readinessTimings[9]!.toFixed(3)}`,
      );
      await t.test(
        'normal migration protocol rejects missing/extra/disabled/changed schema and missing fixed slot',
        async () => {
          const badProtocol = JSON.stringify({
            version: 999,
            formatter: 'plain-cjk-slices-v2',
            generation: 1,
            migration: '0176_durable_reading_formatting.sql',
            catalog: 'a'.repeat(64),
          });
          const cases = [
            'DROP TABLE whaleu_community.reading_format_results CASCADE',
            'CREATE TABLE whaleu_community.reading_format_unknown(id integer)',
            'ALTER TABLE whaleu_community.reading_format_jobs DISABLE TRIGGER reading_job_guard',
            'ALTER TABLE whaleu_identity.accounts DISABLE TRIGGER reading_late_guard',
            'CREATE TRIGGER reading_unexpected BEFORE UPDATE ON whaleu_community.reading_format_jobs FOR EACH ROW EXECUTE FUNCTION whaleu_community.content_approval_immutable()',
            'DROP FUNCTION whaleu_community.reading_format_protocol()',
            "CREATE OR REPLACE FUNCTION whaleu_community.reading_format_catalog() RETURNS text LANGUAGE sql STABLE SET search_path=pg_catalog AS $$SELECT repeat('a',64)$$",
            `CREATE OR REPLACE FUNCTION whaleu_community.reading_format_key(kind text,id uuid,hash text,request uuid) RETURNS text LANGUAGE sql IMMUTABLE AS $$SELECT repeat('0',64)$$`,
            `CREATE OR REPLACE FUNCTION whaleu_community.reading_format_protocol() RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$SELECT '${badProtocol}'::jsonb$$`,
            'ALTER TABLE whaleu_community.reading_format_slots DISABLE TRIGGER reading_slot_guard; DELETE FROM whaleu_community.reading_format_slots WHERE slot_id=2; ALTER TABLE whaleu_community.reading_format_slots ENABLE TRIGGER reading_slot_guard',
          ];
          for (const mutation of cases) {
            const tx = await pool.connect();
            try {
              await tx.query('BEGIN');
              await tx.query(mutation);
              await assert.rejects(
                inspectReadingSchema(tx),
                (e: unknown) =>
                  e instanceof ApplicationError &&
                  e.code === 'COMMUNITY_UNAVAILABLE',
                mutation,
              );
            } finally {
              await tx.query('ROLLBACK');
              tx.release();
            }
            assert.deepEqual(await inspectReadingSchema(suite!), initialSchema);
          }
        },
      );
      role = await createReadingWorkerRole(pool);
      await t.test(
        'production role floor rejects privileged fixture owner and extra source-write grants',
        async () => {
          await assert.rejects(assertReadingWorkerRole(suite!));
          const tx = await pool.connect();
          try {
            await tx.query('BEGIN');
            await tx.query(
              `GRANT UPDATE ON whaleu_community.posts TO "${role!.name}"`,
            );
            await tx.query(`SET LOCAL ROLE "${role!.name}"`);
            await assert.rejects(
              assertReadingWorkerRole(tx),
              /least-privilege/,
            );
          } finally {
            await tx.query('ROLLBACK');
            tx.release();
          }
        },
      );
      const sourcePost = await reviewed('/v1/community/posts', body);

      const runtime = app.get(ReadingFormattingRuntime),
        worker = app.get(ReadingFormattingWorker);
      const readV2 = (kind: string, id: string, authorization = auth) =>
        request(http)
          .get(`/v2/community/text-sources/${kind}/${id}`)
          .set('Authorization', authorization);
      const jobs = () =>
        pool.query(
          `SELECT j.*,j.row_version::text,j.lease_fence::text,j.lease_until::text,j.next_probe_at::text,j.next_attempt_at::text,j.write_transaction::text FROM whaleu_community.reading_format_jobs j ORDER BY j.next_probe_at,j.job_key`,
        );
      const findJob = async (id: string) => {
        let cursor:
          | import('../../src/community/reading-formatting/runtime.js').QueueCursor
          | null = null;
        for (let page = 0; page < 32; page++) {
          const rows = await runtime.candidates(cursor);
          if (!rows.length) return undefined;
          for (const raw of rows) {
            const { schedule, job } = decodeCandidate(raw);
            if (job.success && job.data.content_id === id) return raw;
            cursor = {
              nextProbeAt: schedule.next_probe_at,
              jobKey: schedule.job_key,
            };
          }
        }
        throw new Error('Test discovery exceeded 32 bounded pages');
      };
      const publish = async (text = body.text) =>
        reviewed('/v1/community/posts', {
          ...body,
          clientRequestId: randomUUID(),
          text,
        });
      const plan = (
        claim: NonNullable<Awaited<ReturnType<typeof runtime.claim>>>,
      ) => {
        const outcome = formatSource(claim.source);
        assert.equal(outcome.kind, 'plan');
        if (outcome.kind !== 'plan') throw new Error('Expected plan');
        return outcome.plan;
      };
      await t.test(
        'restricted worker role retains complete canonical source proofs without publication rights',
        async () => {
          const row = decodeCandidate(await findJob(sourcePost.id)).job;
          assert.equal(row.success, true);
          if (!row.success) throw new Error('Expected eligible source job');
          await withReadingWorkerRole(
            app!.get(DatabaseService),
            role!.name,
            () =>
              runtime.database.transaction(
                async (tx) => {
                  const source = await app!.get(ReadingSourceOwner).resolve(
                    {
                      kind: 'post',
                      id: sourcePost.id,
                      sourceRevision: 1,
                      sourceHash: row.data.source_hash,
                      publicationRequestId: body.clientRequestId,
                    },
                    tx,
                  );
                  assert.equal(source.text, body.text.replace(/\r\n/g, '\n'));
                },
                { isolationLevel: 'read committed' },
              ),
          );
        },
      );
      await t.test(
        'same created publication creates one graph; replay cannot re-enroll; v1 unchanged',
        async () => {
          assert.equal((await jobs()).rowCount, 1);
          const before = await readV2('post', sourcePost.id);
          assert.equal(before.status, 200, JSON.stringify(before.body));
          assert.equal(before.body.presentation.status, 'source');
          assert.equal(
            (await read('post', sourcePost.id)).body.presentationStatus,
            'not_configured',
          );
          const tick = await withReadingWorkerRole(
            app!.get(DatabaseService),
            role!.name,
            () => worker.tick(),
          );
          assert.deepEqual(
            await inspectReadingSchema(suite!),
            initialSchema,
            'normal job/result writes must not alter schema identity',
          );
          assert.equal(tick.completed, 1, JSON.stringify(tick));
          assert.deepEqual(
            (await call('/v1/community/posts', body)).body,
            sourcePost.receipt,
          );
          assert.equal((await jobs()).rowCount, 1);
          const v2 = await readV2('post', sourcePost.id);
          assert.equal(v2.status, 200, JSON.stringify(v2.body));
          assert.equal(v2.body.presentation.status, 'formatted');
          assert.equal(
            v2.body.presentation.plan.spans
              .map((s: { start: number; end: number }) =>
                v2.body.source.text.slice(s.start, s.end),
              )
              .join(''),
            body.text.replace(/\r\n/g, '\n'),
          );
          assert.equal(Object.hasOwn(v2.body.source, 'accountId'), false);
          assert.equal(Object.hasOwn(v2.body, 'job'), false);
          assert.equal(v2.headers['cache-control'], 'no-store');
        },
      );
      await t.test(
        'explicit Markdown, off, short and legacy create no work; posts/comments/replies use exact thresholds',
        async () => {
          for (const change of [
            { textSource: markdown },
            { textSource: { ...plain, readingFormatting: 'off' } },
            { text: '鲸'.repeat(299) },
          ])
            await reviewed('/v1/community/posts', {
              ...body,
              clientRequestId: randomUUID(),
              ...change,
            });
          const root = await reviewed(
            `/v1/community/posts/${sourcePost.id}/comments`,
            {
              clientRequestId: randomUUID(),
              text: '鲸'.repeat(199),
              imageAssetIds: [],
              authorMode: 'named',
              textSource: plain,
            },
          );
          assert.equal((await jobs()).rowCount, 1);
          const reply = await reviewed(
            `/v1/community/comments/${root.id}/replies`,
            {
              clientRequestId: randomUUID(),
              text: '鲸'.repeat(200),
              imageAssetIds: [],
              authorMode: 'named',
              targetReplyId: null,
              textSource: plain,
            },
          );
          assert.equal((await jobs()).rowCount, 2);
          assert.ok(await findJob(reply.id));
          assert.equal(
            (await new ReadingFormattingWorker(runtime).tick()).completed,
            1,
          );
        },
      );
      await t.test(
        'canonical CRLF and supplementary scalar thresholds match SQL char_length, not UTF-16 units',
        async () => {
          for (const [text, scalars, queued] of [
            ['鲸'.repeat(298) + '😀', 299, false],
            ['鲸'.repeat(299) + '😀', 300, true],
            ['鲸'.repeat(297) + '\r\n鲸', 299, false],
            ['鲸'.repeat(298) + '\r\n鲸', 300, true],
          ] as const) {
            const target = await publish(text),
              source = (await read('post', target.id)).body;
            assert.equal(Array.from(source.text).length, scalars);
            assert.equal(
              (
                await pool.query('SELECT char_length($1)::integer n', [
                  source.text,
                ])
              ).rows[0]!.n,
              scalars,
            );
            assert.equal(source.readingFormattingEligible, queued);
            assert.equal(
              (await jobs()).rows.some((r) => r.content_id === target.id),
              queued,
            );
            if (queued) {
              const claim = await runtime.claim(await findJob(target.id));
              assert.ok(claim);
              assert.equal(await runtime.complete(claim, plan(claim)), true);
            }
          }
        },
      );
      await t.test(
        'SQL plan matches the versioned formatter across CJK/ASCII/Unicode edge cases',
        async () => {
          const sample = await publish(),
            claim = await runtime.claim(await findJob(sample.id));
          assert.ok(claim);
          for (const text of [
            body.text.replace(/\r\n/g, '\n'),
            ('鲸'.repeat(119) + '。').repeat(3),
            '鲸'.repeat(310) + '👩‍💻',
            '鲸'.repeat(310) + 'a\u0301',
            '\t' + ('鲸'.repeat(99) + '。').repeat(4) + '\n',
            '“' + ('鲸'.repeat(119) + '。').repeat(3) + '”',
            ('鲸'.repeat(119) + '！').repeat(3) + 'https://example.test',
          ]) {
            const { prepareTextSource } =
              await import('../../src/community/text-source/source.js');
            const prepared = prepareTextSource(text, plain, 'post')!;
            const snapshot = {
              ...claim.source,
              text,
              sourceHash: prepared.sourceHash,
            };
            const expected = formatSource(snapshot);
            assert.equal(expected.kind, 'plan');
            const actual = (
              await pool.query<{ plan: unknown }>(
                'SELECT whaleu_community.reading_format_plan($1) plan',
                [text],
              )
            ).rows[0]!.plan;
            if (expected.kind === 'plan')
              assert.deepEqual(actual, expected.plan);
          }
          assert.equal(await runtime.complete(claim, plan(claim)), true);
        },
      );
      await t.test(
        'C and en_US SQL/TS scheme detection agree on ASCII boundaries and non-ASCII pseudo-schemes',
        async () => {
          const locales = (
            await pool.query<{ collname: string }>(
              "SELECT collname FROM pg_collation WHERE collname IN ('C','en_US.utf8','en_US.UTF-8') ORDER BY collname",
            )
          ).rows.map((r) => r.collname);
          assert.ok(locales.includes('C'));
          assert.ok(
            locales.some((x) => x.startsWith('en_US.')),
            'A non-C deployment locale is required for parity proof',
          );
          const { prepareTextSource } =
            await import('../../src/community/text-source/source.js');
          for (const suffix of [
            '鲸://',
            'ＡＢＣ://',
            '鲸abc://',
            'wordabc://',
            '_abc://',
            '-abc://',
            '9abc://',
            'HTTP://x',
            'www.X',
          ]) {
            const text = ('鲸'.repeat(119) + '。').repeat(3) + suffix,
              prepared = prepareTextSource(text, plain, 'post')!;
            const outcome = formatSource({
              kind: 'post',
              id: sourcePost.id,
              sourceRevision: 1,
              sourceHash: prepared.sourceHash,
              publicationRequestId: body.clientRequestId,
              text,
              descriptor: plain,
            });
            assert.equal(outcome.kind, 'plan');
            for (const locale of locales) {
              assert.match(locale, /^(C|en_US\.(utf8|UTF-8))$/);
              const actual = (
                await pool.query<{ plan: unknown }>(
                  `SELECT whaleu_community.reading_format_plan($1 COLLATE "${locale}") plan`,
                  [text],
                )
              ).rows[0]!.plan;
              if (outcome.kind === 'plan')
                assert.deepEqual(actual, outcome.plan, `${locale}: ${suffix}`);
            }
          }
        },
      );
      await t.test(
        'two durable slots are global; concurrent same-job claims have one winner; exact completion replay is read-only',
        async () => {
          const a = await publish(),
            b = await publish(),
            c = await publish();
          const ra = await findJob(a.id),
            rb = await findJob(b.id),
            rc = await findJob(c.id);
          assert.ok(ra && rb && rc);
          const attempts = await Promise.allSettled([
            runtime.claim(ra),
            runtime.claim(ra),
          ]);
          const won = attempts.flatMap((x) =>
            x.status === 'fulfilled' && x.value ? [x.value] : [],
          );
          assert.equal(won.length, 1);
          const second = await runtime.claim(rb);
          assert.ok(second);
          assert.equal(await runtime.claim(rc), null);
          const first = won[0]!;
          assert.equal(await runtime.complete(first, plan(first)), true);
          const snapshot = (await jobs()).rows.find(
            (r) => r['content_id'] === a.id,
          );
          assert.equal(await runtime.complete(first, plan(first)), true);
          assert.deepEqual(
            (await jobs()).rows.find((r) => r['content_id'] === a.id),
            snapshot,
          );
          assert.equal(await runtime.complete(second, plan(second)), true);
          const third = await runtime.claim(rc);
          assert.ok(third);
          assert.equal(await runtime.complete(third, plan(third)), true);
        },
      );
      await t.test(
        'slot expiry/reuse changes no old unavailable job fields; stale completion loses after reuse and same-job new lease',
        async () => {
          const a = await publish(),
            b = await publish();
          const first = await runtime.claim(await findJob(a.id));
          assert.ok(first);
          const old = (await jobs()).rows.find((r) => r['content_id'] === a.id);
          // Real DB clock expiry, never mutate stored lease or supply a worker clock.
          await pool.query(
            'SELECT pg_sleep(GREATEST(0,extract(epoch FROM $1::timestamptz-clock_timestamp()))+0.02)',
            [first.leaseUntil],
          );
          const second = await runtime.claim(await findJob(b.id));
          assert.ok(second);
          assert.equal(second.slotId, first.slotId);
          assert.deepEqual(
            (await jobs()).rows.find((r) => r['content_id'] === a.id),
            old,
          );
          assert.equal(await runtime.complete(first, plan(first)), false);
          assert.equal(await runtime.complete(second, plan(second)), true);
          const reassigned = await runtime.claim(await findJob(a.id));
          assert.ok(reassigned);
          assert.notEqual(reassigned.leaseToken, first.leaseToken);
          assert.equal(
            Number(reassigned.leaseFence),
            Number(first.leaseFence) + 1,
          );
          assert.equal(await runtime.complete(first, plan(first)), false);
          assert.equal(
            await runtime.complete(reassigned, plan(reassigned)),
            true,
          );
        },
      );
      await t.test(
        'expired old slot 2 to new slot 1 releases only its exact stale reservation',
        async () => {
          const a = await publish(),
            b = await publish();
          const first = await runtime.claim(await findJob(a.id)),
            second = await runtime.claim(await findJob(b.id));
          assert.ok(first && second);
          assert.equal(first.slotId, 1);
          assert.equal(second.slotId, 2);
          assert.equal(await runtime.complete(first, plan(first)), true);
          await pool.query(
            'SELECT pg_sleep(GREATEST(0,extract(epoch FROM $1::timestamptz-clock_timestamp()))+0.02)',
            [second.leaseUntil],
          );
          const raw = await findJob(b.id);
          const reclaims = await Promise.allSettled([
            runtime.claim(raw),
            runtime.claim(raw),
          ]);
          const winners = reclaims.flatMap((result) =>
            result.status === 'fulfilled' && result.value ? [result.value] : [],
          );
          assert.equal(
            winners.length,
            1,
            'Concurrent expired-job reclaim must have exactly one winner',
          );
          const fresh = winners[0]!;
          assert.equal(fresh.slotId, 1);
          assert.equal(
            (
              await pool.query(
                'SELECT * FROM whaleu_community.reading_format_slots WHERE slot_id=2',
              )
            ).rows[0]!.job_key,
            null,
          );
          assert.equal(await runtime.complete(second, plan(second)), false);
          assert.equal(await runtime.complete(fresh, plan(fresh)), true);
        },
      );
      await t.test(
        'reclaim cannot clear another job current lease occupying its former slot',
        async () => {
          const a = await publish(),
            b = await publish(),
            c = await publish(),
            temporary = await publish();
          const first = await runtime.claim(await findJob(a.id)),
            old = await runtime.claim(await findJob(b.id));
          assert.ok(first && old);
          assert.equal(await runtime.complete(first, plan(first)), true);
          await pool.query(
            'SELECT pg_sleep(GREATEST(0,extract(epoch FROM $1::timestamptz-clock_timestamp()))+0.02)',
            [old.leaseUntil],
          );
          const temporaryClaim = await runtime.claim(
            await findJob(temporary.id),
          );
          assert.ok(temporaryClaim);
          assert.equal(temporaryClaim.slotId, 1);
          const takeover = await runtime.claim(await findJob(c.id));
          assert.ok(takeover);
          assert.equal(takeover.slotId, 2);
          assert.equal(
            await runtime.complete(temporaryClaim, plan(temporaryClaim)),
            true,
          );
          const fresh = await runtime.claim(await findJob(b.id));
          assert.ok(fresh);
          assert.equal(fresh.slotId, 1);
          const unrelated = (
            await pool.query(
              'SELECT * FROM whaleu_community.reading_format_slots WHERE slot_id=2',
            )
          ).rows[0]!;
          assert.equal(unrelated.job_key, takeover.key);
          assert.equal(unrelated.lease_token, takeover.leaseToken);
          assert.equal(await runtime.complete(old, plan(old)), false);
          assert.equal(await runtime.complete(fresh, plan(fresh)), true);
          assert.deepEqual(
            (
              await pool.query(
                'SELECT * FROM whaleu_community.reading_format_slots WHERE slot_id=2',
              )
            ).rows[0],
            unrelated,
          );
          assert.equal(await runtime.complete(takeover, plan(takeover)), true);
        },
      );
      await t.test(
        'unavailable probes persist +5s/+30s/third quarantine and preserve lifecycle/claims/source/result',
        async () => {
          const target = await publish();
          let raw = await findJob(target.id);
          assert.ok(raw);
          const original = (await jobs()).rows.find(
            (r) => r['content_id'] === target.id,
          )!;
          for (let probe = 1; probe <= 3; probe++) {
            assert.equal(
              await runtime.defer(raw, 'authority_unavailable'),
              true,
            );
            const row = (await jobs()).rows.find(
              (r) => r['content_id'] === target.id,
            )!;
            assert.equal(row['probe_count'], probe);
            assert.equal(row['state'], original['state']);
            assert.equal(row['claims'], original['claims']);
            assert.equal(row['lease_fence'], original['lease_fence']);
            assert.equal(row['lease_token'], null);
            assert.equal(row['source_hash'], original['source_hash']);
            assert.equal(
              row['schedule_state'],
              probe === 3 ? 'quarantined' : 'deferred',
            );
            if (probe < 3) {
              const seconds = (
                await pool.query<{ seconds: number }>(
                  'SELECT extract(epoch FROM $1::timestamptz-clock_timestamp())::float8 seconds',
                  [row['next_probe_at']],
                )
              ).rows[0]!.seconds;
              assert.ok(
                seconds > (probe === 1 ? 4 : 29) &&
                  seconds <= (probe === 1 ? 5 : 30),
              );
              assert.equal(
                (await new ReadingFormattingWorker(runtime).tick()).claimed,
                0,
              );
              assert.equal(
                await runtime.defer(row, 'authority_unavailable'),
                false,
              );
              await pool.query(
                'SELECT pg_sleep(GREATEST(0,extract(epoch FROM $1::timestamptz-clock_timestamp()))+0.02)',
                [row['next_probe_at']],
              );
              raw = row;
            } else assert.equal(row['next_probe_at'], null);
          }
          assert.equal(
            (await readV2('post', target.id)).body.presentation.status,
            'source',
          );
          assert.equal(
            (await jobs()).rows.find((r) => r['content_id'] === target.id)![
              'probe_count'
            ],
            3,
          );
        },
      );
      await t.test(
        'NOWAIT conflict advances cursor and later healthy work proceeds without touching locked row',
        async () => {
          const a = await publish(),
            b = await publish();
          const held = await pool.connect();
          try {
            await held.query('BEGIN');
            await held.query(
              'SELECT * FROM whaleu_community.reading_format_heads WHERE content_id=$1 FOR UPDATE',
              [a.id],
            );
            const tick = await new ReadingFormattingWorker(runtime).tick();
            assert.ok(tick.completed >= 1, JSON.stringify(tick));
            assert.equal(
              (await jobs()).rows.find((r) => r['content_id'] === a.id)![
                'claims'
              ],
              0,
            );
            assert.equal(
              (await jobs()).rows.find((r) => r['content_id'] === b.id)![
                'state'
              ],
              'complete',
            );
          } finally {
            await held.query('ROLLBACK');
            held.release();
          }
        },
      );
      await t.test(
        'raw SQL cannot bypass quarantine, probe deferral or retry eligibility by rewriting clocks',
        async () => {
          const eligibleClock = await publish();
          const quarantineTarget = await publish();
          assert.equal(
            await runtime.defer(
              await findJob(quarantineTarget.id),
              'invalid_payload',
            ),
            true,
          );
          const quarantined = (await jobs()).rows.find(
            (r) => r.content_id === quarantineTarget.id,
          )!;
          assert.equal(
            quarantined.probe_count,
            0,
            'Quarantine rejection cannot be masked by the probe_count=3 CHECK',
          );
          const futureProbe = await publish(),
            retryTarget = await publish();
          const probe = await findJob(futureProbe.id);
          assert.ok(probe);
          assert.equal(
            await runtime.defer(probe, 'authority_unavailable'),
            true,
          );
          const lease = await runtime.claim(await findJob(retryTarget.id));
          assert.ok(lease);
          assert.equal(await runtime.retry(lease), true);
          const pending = (await jobs()).rows.find(
            (r) => r['content_id'] === retryTarget.id,
          )!;
          assert.equal(pending['next_probe_at'], pending['next_attempt_at']);
          assert.equal(pending['state'], 'pending');
          assert.equal(pending['claims'], 1);
          const eligibleRow = (await jobs()).rows.find(
            (r) => r.content_id === eligibleClock.id,
          )!;
          const cases = [
            {
              label: 'quarantine with immutable retry clock',
              key: quarantined['job_key'],
              rewriteAttempt: false,
            },
            {
              label: 'future probe with due immutable retry clock',
              key: (await jobs()).rows.find(
                (r) => r.content_id === futureProbe.id,
              )!['job_key'],
              rewriteAttempt: false,
            },
            {
              label: 'future computation retry without rewriting its clock',
              key: pending['job_key'],
              rewriteAttempt: false,
            },
            {
              label: 'future computation retry cannot rewrite its clock',
              key: pending['job_key'],
              rewriteAttempt: true,
            },
            {
              label:
                'otherwise eligible claim cannot rewrite immutable next_attempt_at',
              key: eligibleRow['job_key'],
              rewriteAttempt: true,
            },
          ];
          for (const item of cases) {
            const tx = await pool.connect();
            try {
              await tx.query('BEGIN');
              // Assert BEFORE claim rejection itself, not deferred missing-slot
              // graph closure. Every query still executes against actual PG.
              await assert.rejects(
                tx.query(
                  `WITH instant AS MATERIALIZED(SELECT clock_timestamp() now) UPDATE whaleu_community.reading_format_jobs SET state='running',claims=claims+1,lease_fence=lease_fence+1,lease_token=$2,lease_until=instant.now+interval '10 seconds',slot_id=1,schedule_state='runnable',next_probe_at=instant.now+interval '10 seconds',next_attempt_at=CASE WHEN $3::boolean THEN instant.now ELSE next_attempt_at END,scheduling_reason=NULL,row_version=row_version+1,write_transaction=pg_current_xact_id() FROM instant WHERE job_key=$1`,
                  [item.key, randomUUID(), item.rewriteAttempt],
                ),
                (error: unknown) => {
                  assert.ok(
                    error instanceof Error && 'code' in error,
                    item.label,
                  );
                  assert.equal(error.code, '23514', item.label);
                  assert.match(
                    error.message,
                    /^Invalid reading claim$/,
                    item.label,
                  );
                  return true;
                },
              );
            } finally {
              await tx.query('ROLLBACK');
              tx.release();
            }
          }
          // An exact eligible control is admitted by the independent SQL guards.
          const allowed = await publish();
          const row = (await jobs()).rows.find(
            (r) => r['content_id'] === allowed.id,
          )!;
          await inTransaction(
            pool,
            async (tx) => {
              await tx.query(
                'SELECT * FROM whaleu_community.reading_format_heads WHERE content_id=$1 FOR UPDATE NOWAIT',
                [allowed.id],
              );
              await tx.query(
                'SELECT * FROM whaleu_community.reading_format_slots ORDER BY slot_id FOR UPDATE NOWAIT',
              );
              await tx.query(
                'SELECT * FROM whaleu_community.reading_format_jobs WHERE job_key=$1 FOR UPDATE NOWAIT',
                [row['job_key']],
              );
              await tx.query(
                `WITH instant AS MATERIALIZED(SELECT clock_timestamp() now) UPDATE whaleu_community.reading_format_jobs SET state='running',claims=claims+1,lease_fence=lease_fence+1,lease_token=$2,lease_until=instant.now+interval '10 seconds',slot_id=1,schedule_state='runnable',next_probe_at=instant.now+interval '10 seconds',scheduling_reason=NULL,row_version=row_version+1,write_transaction=pg_current_xact_id() FROM instant WHERE job_key=$1`,
                [row['job_key'], randomUUID()],
              );
              await tx.query(
                `UPDATE whaleu_community.reading_format_slots SET job_key=j.job_key,lease_token=j.lease_token,lease_fence=j.lease_fence,lease_until=j.lease_until,row_version=reading_format_slots.row_version+1 FROM whaleu_community.reading_format_jobs j WHERE reading_format_slots.slot_id=1 AND j.job_key=$1`,
                [row['job_key']],
              );
              await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
              throw new Error('Discard exact eligible control');
            },
            { isolationLevel: 'read committed' },
          ).then(
            () => assert.fail('Control must roll back'),
            (e) => assert.match(String(e), /Discard exact eligible control/),
          );
        },
      );
      await t.test(
        'direct fabricated result/head and metadata-as-lifecycle updates fail',
        async () => {
          const target = await publish(),
            raw = await findJob(target.id);
          assert.ok(raw);
          const row = (await jobs()).rows.find(
            (r) => r['content_id'] === target.id,
          )!;
          await assert.rejects(
            pool.query(
              `INSERT INTO whaleu_community.reading_format_results(job_key,plan,lease_token,lease_fence) VALUES($1,'{}',$2,1)`,
              [row['job_key'], randomUUID()],
            ),
          );
          await assert.rejects(
            pool.query(
              `UPDATE whaleu_community.reading_format_jobs SET state='exhausted',schedule_state='quarantined',next_probe_at=NULL,row_version=row_version+1 WHERE job_key=$1`,
              [row['job_key']],
            ),
          );
          await assert.rejects(
            pool.query(
              `INSERT INTO whaleu_community.reading_format_heads SELECT content_kind,content_id,source_revision,source_hash,publication_request_id,formatter_version,generation,state,row_version,pg_current_xact_id(),transaction_timestamp() FROM whaleu_community.reading_format_heads WHERE content_id=$1`,
              [target.id],
            ),
          );
          await assert.rejects(
            pool.query(
              'TRUNCATE whaleu_community.reading_format_slots CASCADE',
            ),
          );
          const claim = await runtime.claim(raw);
          assert.ok(claim);
          const malformed = { ...plan(claim), spans: [{ start: 0, end: 1 }] };
          await assert.rejects(runtime.complete(claim, malformed));
          assert.equal(await runtime.complete(claim, plan(claim)), true);
        },
      );
      // Deliberately raw-role writer for adversarial SQL tests. It is NOT an
      // admitted runtime owner, and the early-drain counterexample below is a
      // production admission blocker rather than a supported operating mode.
      const rawComplete = async (
        tx: PoolClient,
        id: string,
        leaseSeconds = 1,
      ) => {
        await tx.query(
          'SELECT * FROM whaleu_community.reading_format_heads WHERE content_id=$1 FOR UPDATE NOWAIT',
          [id],
        );
        await tx.query(
          'SELECT * FROM whaleu_community.reading_format_slots ORDER BY slot_id FOR UPDATE NOWAIT',
        );
        const row = (
          await tx.query(
            'SELECT * FROM whaleu_community.reading_format_jobs WHERE content_id=$1 FOR UPDATE NOWAIT',
            [id],
          )
        ).rows[0]!;
        await tx.query(
          `WITH instant AS MATERIALIZED(SELECT clock_timestamp() now) UPDATE whaleu_community.reading_format_jobs SET state='running',claims=claims+1,lease_fence=lease_fence+1,lease_token=$2,lease_until=instant.now+$3::double precision*interval '1 second',slot_id=1,schedule_state='runnable',next_probe_at=instant.now+$3::double precision*interval '1 second',scheduling_reason=NULL,row_version=row_version+1,write_transaction=pg_current_xact_id() FROM instant WHERE job_key=$1`,
          [row.job_key, randomUUID(), leaseSeconds],
        );
        await tx.query(
          `UPDATE whaleu_community.reading_format_slots SET job_key=j.job_key,lease_token=j.lease_token,lease_fence=j.lease_fence,lease_until=j.lease_until,row_version=reading_format_slots.row_version+1 FROM whaleu_community.reading_format_jobs j WHERE reading_format_slots.slot_id=1 AND j.job_key=$1`,
          [row.job_key],
        );
        await tx.query(
          `INSERT INTO whaleu_community.reading_format_results(job_key,plan,lease_token,lease_fence) SELECT j.job_key,whaleu_community.reading_format_plan(b.envelope->>'text'),j.lease_token,j.lease_fence FROM whaleu_community.reading_format_jobs j JOIN whaleu_community.content_approval_bindings b ON b.content_kind=j.content_kind AND b.content_id=j.content_id WHERE j.job_key=$1`,
          [row.job_key],
        );
        await tx.query(
          `UPDATE whaleu_community.reading_format_jobs SET state='complete',lease_token=NULL,lease_until=NULL,slot_id=NULL,schedule_state='quarantined',next_probe_at=NULL,scheduling_reason='completed',row_version=row_version+1,write_transaction=pg_current_xact_id() WHERE job_key=$1`,
          [row.job_key],
        );
        await tx.query(
          `UPDATE whaleu_community.reading_format_slots SET job_key=NULL,lease_token=NULL,lease_fence=NULL,lease_until=NULL,row_version=row_version+1 WHERE slot_id=1 AND job_key=$1`,
          [row.job_key],
        );
        return row.job_key as string;
      };
      await t.test(
        'normal deferred SQL closure rejects completed result after its retained DB lease expires',
        async () => {
          const target = await publish(),
            tx = await pool.connect();
          try {
            await tx.query('BEGIN');
            const key = await rawComplete(tx, target.id);
            await tx.query(
              'SELECT pg_sleep(GREATEST(0,extract(epoch FROM lease_until-clock_timestamp()))+0.02) FROM whaleu_community.reading_format_results WHERE job_key=$1',
              [key],
            );
            await assert.rejects(
              tx.query('COMMIT'),
              /expired before deferred closure/,
            );
          } finally {
            await tx.query('ROLLBACK');
            tx.release();
          }
          assert.equal(
            (await jobs()).rows.find((r) => r.content_id === target.id)!.state,
            'pending',
          );
        },
      );
      await t.test(
        'UNSUPPORTED raw-role early-drain plus idle COMMIT counterexample is explicit',
        async () => {
          const target = await publish(),
            tx = await pool.connect();
          try {
            await tx.query('BEGIN');
            const key = await rawComplete(tx, target.id);
            await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
            await tx.query(
              'SELECT pg_sleep(GREATEST(0,extract(epoch FROM lease_until-clock_timestamp()))+0.02) FROM whaleu_community.reading_format_results WHERE job_key=$1',
              [key],
            );
            await tx.query('COMMIT');
            assert.equal(
              (
                await pool.query(
                  'SELECT lease_until<clock_timestamp() expired FROM whaleu_community.reading_format_results WHERE job_key=$1',
                  [key],
                )
              ).rows[0]!.expired,
              true,
            );
            assert.equal(
              (await jobs()).rows.find((r) => r.content_id === target.id)!
                .state,
              'complete',
            );
          } finally {
            await tx.query('ROLLBACK');
            tx.release();
          }
        },
      );
      await t.test(
        'managed runtime still rejects early constraint drain plus DB-clock lease expiry',
        async () => {
          const target = await publish(),
            claim = await runtime.claim(await findJob(target.id));
          assert.ok(claim);
          const databaseService = app!.get(DatabaseService),
            original = databaseService.transaction.bind(databaseService);
          let drained = false;
          databaseService.transaction = (operation, options) =>
            original(async (tx) => {
              const result = await operation(tx);
              await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
              drained = true;
              await tx.query("SET LOCAL statement_timeout='15000ms'");
              await tx.query(
                'SELECT pg_sleep(GREATEST(0,extract(epoch FROM $1::timestamptz-clock_timestamp()))+0.02)',
                [claim.leaseUntil],
              );
              return result;
            }, options);
          try {
            await assert.rejects(runtime.complete(claim, plan(claim)));
            assert.equal(drained, true);
          } finally {
            databaseService.transaction = original;
          }
          assert.equal(
            (
              await pool.query(
                'SELECT * FROM whaleu_community.reading_format_results WHERE job_key=$1',
                [claim.key],
              )
            ).rowCount,
            0,
          );
          const fresh = await runtime.claim(await findJob(target.id));
          assert.ok(fresh);
          assert.equal(await runtime.complete(fresh, plan(fresh)), true);
        },
      );
      await t.test(
        'early constraint drain followed by same-transaction dependency write rejects completion',
        async () => {
          const target = await publish(),
            claim = await runtime.claim(await findJob(target.id));
          assert.ok(claim);
          const databaseService = app!.get(DatabaseService),
            original = databaseService.transaction.bind(databaseService);
          let injected = false;
          databaseService.transaction = (operation, options) =>
            original(async (tx) => {
              const result = await operation(tx);
              await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
              injected = true;
              await tx.query(
                'UPDATE whaleu_community.spaces SET is_active=false WHERE id=$1',
                [scope.home.spaceId],
              );
              return result;
            }, options);
          try {
            await assert.rejects(runtime.complete(claim, plan(claim)));
            assert.equal(injected, true);
          } finally {
            databaseService.transaction = original;
          }
          assert.equal(
            (
              await pool.query(
                'SELECT * FROM whaleu_community.reading_format_results WHERE job_key=$1',
                [claim.key],
              )
            ).rowCount,
            0,
          );
          assert.equal(await runtime.complete(claim, plan(claim)), true);
        },
      );
      await t.test(
        'optional derived-table final fence conflict falls back without weakening canonical read',
        async () => {
          const blocker = await pool.connect();
          try {
            await blocker.query('BEGIN');
            await blocker.query(
              'UPDATE whaleu_community.reading_format_results SET plan=plan WHERE false',
            );
            const response = await readV2('post', sourcePost.id);
            assert.equal(response.status, 200, JSON.stringify(response.body));
            assert.equal(response.body.presentation.status, 'source');
            assert.equal(
              response.body.source.text,
              body.text.replace(/\r\n/g, '\n'),
            );
          } finally {
            await blocker.query('ROLLBACK');
            blocker.release();
          }
          assert.equal(
            (await readV2('post', sourcePost.id)).body.presentation.status,
            'formatted',
          );
        },
      );
      for (const version of [1, 2] as const)
        await t.test(
          `v${version} mandatory canonical fact changed after source lookup rejects entire read, not fallback`,
          async () => {
            const readCurrent = version === 1 ? read : readV2;
            const baseline = await readCurrent('post', sourcePost.id);
            assert.equal(baseline.status, 200, JSON.stringify(baseline.body));
            if (version === 2)
              assert.equal(baseline.body.presentation.status, 'formatted');
            const spaceState = async () =>
              (
                await pool.query<{ is_active: boolean }>(
                  'SELECT is_active FROM whaleu_community.spaces WHERE id=$1',
                  [scope.home.spaceId],
                )
              ).rows[0]!.is_active;
            const before = await spaceState();
            assert.equal(before, true);
            const databaseService = app!.get(DatabaseService),
              original = databaseService.transaction.bind(databaseService);
            let injected = 0;
            let primaryFailure: unknown;
            let cleanupFailure: unknown;
            databaseService.transaction = (operation, options) =>
              original(async (tx) => {
                const result = await operation(tx);
                const parsedV1 = textSourceReadSchema.safeParse(result);
                const parsedV2 = textSourceReadV2Schema.safeParse(result);
                const source =
                  version === 1 && parsedV1.success
                    ? parsedV1.data
                    : version === 2 && parsedV2.success
                      ? parsedV2.data.source
                      : null;
                // Exact canonical result, never an Auth or policy transaction.
                if (source?.kind === 'post' && source.id === sourcePost.id) {
                  if (version === 2) {
                    assert.ok(parsedV2.success);
                    assert.equal(
                      parsedV2.data.presentation.status,
                      'formatted',
                    );
                  }
                  assert.equal(injected, 0);
                  const mutation = await tx.query(
                    'UPDATE whaleu_community.spaces SET is_active=false WHERE id=$1 AND is_active',
                    [scope.home.spaceId],
                  );
                  assert.equal(mutation.rowCount, 1);
                  injected++;
                }
                return result;
              }, options);
            try {
              const response = await readCurrent('post', sourcePost.id);
              assert.equal(
                injected,
                1,
                'Exact canonical read operation must reach the mutation',
              );
              assert.equal(response.status, 503, JSON.stringify(response.body));
              assert.equal(Object.hasOwn(response.body, 'source'), false);
              assert.equal(Object.hasOwn(response.body, 'presentation'), false);
              assert.equal(Object.hasOwn(response.body, 'text'), false);
              assert.equal(response.body.error.code, 'COMMUNITY_UNAVAILABLE');
              assert.equal(
                await spaceState(),
                before,
                'Failed final proof must roll back the mutation',
              );
            } catch (error) {
              primaryFailure = error;
            } finally {
              databaseService.transaction = original;
              try {
                // Isolation repair cannot erase the preceding rollback failure.
                if ((await spaceState()) !== before)
                  await withCommunityScopeWriter(pool, (tx) =>
                    tx.query(
                      'UPDATE whaleu_community.spaces SET is_active=$2 WHERE id=$1',
                      [scope.home.spaceId, before],
                    ),
                  );
              } catch (cleanupError) {
                cleanupFailure = cleanupError;
              }
            }
            if (primaryFailure !== undefined && cleanupFailure !== undefined)
              throw new AggregateError(
                [primaryFailure, cleanupFailure],
                'Canonical race and isolation cleanup both failed',
                { cause: primaryFailure },
              );
            if (primaryFailure !== undefined) throw primaryFailure;
            if (cleanupFailure !== undefined) throw cleanupFailure;
            const restored = await readCurrent('post', sourcePost.id);
            assert.equal(restored.status, 200, JSON.stringify(restored.body));
            if (version === 2)
              assert.equal(restored.body.presentation.status, 'formatted');
          },
        );
      await t.test(
        'mandatory reader denial has no source/hash/status and never changes global graph',
        async (caseTest) => {
          const before = (
            await pool.query(
              'SELECT jsonb_agg(to_jsonb(j) ORDER BY job_key) snapshot FROM whaleu_community.reading_format_jobs j',
            )
          ).rows[0]!.snapshot;
          const viewerAuth = `Bearer ${other.accessToken}`;
          const unblocked = await readV2('post', sourcePost.id, viewerAuth);
          assert.equal(unblocked.status, 200, JSON.stringify(unblocked.body));
          assert.equal(unblocked.body.presentation.status, 'formatted');
          const blocked = await request(http)
            .put('/v1/me/safety/blocks')
            .set('Authorization', viewerAuth)
            .send({
              clientRequestId: randomUUID(),
              source: { kind: 'post', id: sourcePost.id },
              blocked: true,
            });
          assert.equal(blocked.status, 200, JSON.stringify(blocked.body));
          assert.equal(blocked.body.receipt.outcome, 'applied');
          assert.equal(blocked.body.current.blocked, true);
          assert.equal(typeof blocked.body.current.relationshipId, 'string');
          assert.match(blocked.body.current.revision, /^[1-9][0-9]*$/);
          const blockedState: { relationshipId: string; revision: string } =
            blocked.body.current;
          caseTest.after(async () => {
            const restored = await request(http)
              .put(`/v1/me/safety/blocks/${blockedState.relationshipId}`)
              .set('Authorization', viewerAuth)
              .send({
                clientRequestId: randomUUID(),
                blocked: false,
                expectedRevision: blockedState.revision,
              });
            assert.equal(restored.status, 200, JSON.stringify(restored.body));
            assert.equal(restored.body.receipt.outcome, 'applied');
            assert.equal(restored.body.current.blocked, false);
          });

          const denied = await readV2('post', sourcePost.id, viewerAuth);
          assert.notEqual(denied.status, 200);
          for (const key of [
            'source',
            'text',
            'sourceHash',
            'presentation',
            'job',
          ])
            assert.equal(Object.hasOwn(denied.body, key), false);
          assert.deepEqual(
            (
              await pool.query(
                'SELECT jsonb_agg(to_jsonb(j) ORDER BY job_key) snapshot FROM whaleu_community.reading_format_jobs j',
              )
            ).rows[0]!.snapshot,
            before,
          );
          assert.equal(
            (await readV2('post', sourcePost.id)).body.presentation.status,
            'formatted',
          );
        },
      );
      await t.test(
        'eight real owner-hidden oldest rows defer independently; healthy next-page work proceeds',
        async () => {
          await new ReadingFormattingWorker(runtime).run(32);
          const hidden: string[] = [];
          for (let n = 0; n < 8; n++) {
            const target = await publish();
            hidden.push(target.id);
            const response = await request(http)
              .post('/v1/me/community/owner-visibility-commands')
              .set('Authorization', auth)
              .send({
                clientRequestId: randomUUID(),
                postId: target.id,
                ownerHidden: true,
                expectedVersion: 0,
              });
            assert.equal(response.status, 200, JSON.stringify(response.body));
            assert.equal(response.body.outcome, 'applied');
          }
          const healthy = await publish();
          const scanning = new ReadingFormattingWorker(runtime);
          const first = await scanning.tick();
          assert.equal(first.examined, 8);
          assert.equal(first.claimed, 0);
          assert.equal(first.deferred, 8);
          const second = await scanning.tick();
          assert.equal(second.completed, 1);
          for (const row of (await jobs()).rows.filter((r) =>
            hidden.includes(r['content_id'] as string),
          )) {
            assert.equal(row['claims'], 0);
            assert.equal(row['state'], 'pending');
            assert.equal(row['probe_count'], 1);
          }
          assert.equal(
            (await jobs()).rows.find((r) => r['content_id'] === healthy.id)![
              'state'
            ],
            'complete',
          );
        },
      );
      await t.test(
        'soft owner hiding preserves complete result and restores it only after fresh current proof',
        async (caseTest) => {
          caseTest.after(async () => {
            const current = (
              await pool.query<{ owner_hidden: boolean; version: number }>(
                'SELECT owner_hidden,version FROM whaleu_community.post_owner_visibility WHERE post_id=$1',
                [sourcePost.id],
              )
            ).rows[0];
            if (current?.owner_hidden) {
              const restored = await request(http)
                .post('/v1/me/community/owner-visibility-commands')
                .set('Authorization', auth)
                .send({
                  clientRequestId: randomUUID(),
                  postId: sourcePost.id,
                  ownerHidden: false,
                  expectedVersion: current.version,
                });
              assert.equal(restored.status, 200, JSON.stringify(restored.body));
              assert.equal(restored.body.outcome, 'applied');
            }
          });
          const before = (
            await pool.query(
              'SELECT * FROM whaleu_community.reading_format_results WHERE job_key=(SELECT job_key FROM whaleu_community.reading_format_jobs WHERE content_id=$1)',
              [sourcePost.id],
            )
          ).rows;
          for (const [ownerHidden, expectedVersion] of [
            [true, 0],
            [false, 1],
          ] as const) {
            const response = await request(http)
              .post('/v1/me/community/owner-visibility-commands')
              .set('Authorization', auth)
              .send({
                clientRequestId: randomUUID(),
                postId: sourcePost.id,
                ownerHidden,
                expectedVersion,
              });
            assert.equal(
              response.body.outcome,
              'applied',
              JSON.stringify(response.body),
            );
            const readback = await readV2('post', sourcePost.id);
            assert.equal(readback.status, 200, JSON.stringify(readback.body));
            assert.equal(
              readback.body.presentation.status,
              ownerHidden ? 'source' : 'formatted',
            );
            assert.deepEqual(
              (
                await pool.query(
                  'SELECT * FROM whaleu_community.reading_format_results WHERE job_key=(SELECT job_key FROM whaleu_community.reading_format_jobs WHERE content_id=$1)',
                  [sourcePost.id],
                )
              ).rows,
              before,
            );
          }
        },
      );
      await t.test(
        'real ancestor Media lock, revocation, expiry and late-read races preserve canonical denial and work',
        async () => {
          await verifyReadingAncestorMedia({
            workerRole: role!.name,
            pool,
            config,
            actor,
            scope,
            decide,
            rawComplete,
          });
        },
      );
      await t.test(
        'real Identity lifecycle row lock wins before processing; failed claim changes no durable work',
        async () => {
          const target = await publish(),
            raw = await findJob(target.id);
          assert.ok(raw);
          const before = (await jobs()).rows,
            held = await pool.connect();
          try {
            await held.query('BEGIN');
            await enterReadingLifecycleCooling(
              held,
              actor.accountId,
              lifecycleSandbox,
            );
            // Successful guarded cooling transition is the deterministic barrier.
            await assert.rejects(runtime.claim(raw));
            assert.deepEqual((await jobs()).rows, before);
          } finally {
            await held.query('ROLLBACK');
            held.release();
          }
          const claim = await runtime.claim(raw);
          assert.ok(claim);
          assert.equal(await runtime.complete(claim, plan(claim)), true);
        },
      );
      await t.test(
        'same-transaction Identity lifecycle change after completion proof cannot commit',
        async () => {
          const target = await publish(),
            claim = await runtime.claim(await findJob(target.id));
          assert.ok(claim);
          const before = (await jobs()).rows,
            databaseService = app!.get(DatabaseService),
            original = databaseService.transaction.bind(databaseService);
          let attempted = false;
          databaseService.transaction = (operation, options) =>
            original(async (tx) => {
              const result = await operation(tx);
              await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
              attempted = true;
              await enterReadingLifecycleCooling(
                tx,
                actor.accountId,
                lifecycleSandbox,
              );
              return result;
            }, options);
          try {
            await assert.rejects(runtime.complete(claim, plan(claim)));
            assert.equal(attempted, true);
          } finally {
            databaseService.transaction = original;
          }
          assert.deepEqual((await jobs()).rows, before);
          assert.equal(
            (
              await pool.query(
                'SELECT lifecycle FROM whaleu_identity.accounts WHERE id=$1',
                [actor.accountId],
              )
            ).rows[0]!.lifecycle,
            'active',
          );
          assert.equal(await runtime.complete(claim, plan(claim)), true);
        },
      );
      await t.test(
        'committed cooling and erasing deny processing without mutating job/source/result; reader cannot reuse plan',
        async () => {
          // This is deliberately the final author-publication case. The guarded
          // fixture revokes its real sessions and never fabricates an active one.
          const pending = await publish(),
            raw = await findJob(pending.id);
          assert.ok(raw);
          const completed = await publish(),
            claim = await runtime.claim(await findJob(completed.id));
          assert.ok(claim);
          assert.equal(await runtime.complete(claim, plan(claim)), true);
          const before = (await jobs()).rows;
          const sourcesBefore = (
            await pool.query(
              'SELECT jsonb_agg(to_jsonb(s) ORDER BY content_kind,content_id) value FROM whaleu_community.community_text_sources s',
            )
          ).rows[0]!.value;
          const resultsBefore = (
            await pool.query(
              'SELECT jsonb_agg(to_jsonb(r) ORDER BY job_key) value FROM whaleu_community.reading_format_results r',
            )
          ).rows[0]!.value;
          const requestId = await inTransaction(pool, (tx) =>
            enterReadingLifecycleCooling(tx, actor.accountId, lifecycleSandbox),
          );
          for (const lifecycle of ['cooling', 'erasing'] as const) {
            if (lifecycle === 'erasing')
              await inTransaction(pool, async (tx) => {
                await tx.query(
                  "UPDATE whaleu_account_deletion.sandboxes SET now_at=now_at+interval '604800 seconds' WHERE id=$1",
                  [lifecycleSandbox],
                );
                await tx.query(
                  "UPDATE whaleu_account_deletion.requests SET phase='erasing',revision=revision+1,irreversible_at=(SELECT now_at FROM whaleu_account_deletion.sandboxes WHERE id=$2) WHERE id=$1",
                  [requestId, lifecycleSandbox],
                );
              });
            assert.equal(
              (
                await pool.query(
                  'SELECT lifecycle FROM whaleu_identity.accounts WHERE id=$1',
                  [actor.accountId],
                )
              ).rows[0]!.lifecycle,
              lifecycle,
            );
            await assert.rejects(runtime.claim(raw));
            await assert.rejects(runtime.complete(claim, plan(claim)));
            const self = await readV2('post', completed.id);
            assert.notEqual(self.status, 200);
            for (const key of ['source', 'text', 'presentation', 'sourceHash'])
              assert.equal(Object.hasOwn(self.body, key), false);
            const reader = await readV2(
              'post',
              completed.id,
              `Bearer ${other.accessToken}`,
            );
            if (reader.status === 200)
              assert.equal(
                reader.body.presentation.status,
                'source',
                'Existing canonical reader may retain original source; no stale formatter plan',
              );
            else
              for (const key of [
                'source',
                'text',
                'presentation',
                'sourceHash',
              ])
                assert.equal(Object.hasOwn(reader.body, key), false);
            assert.deepEqual((await jobs()).rows, before);
            assert.deepEqual(
              (
                await pool.query(
                  'SELECT jsonb_agg(to_jsonb(s) ORDER BY content_kind,content_id) value FROM whaleu_community.community_text_sources s',
                )
              ).rows[0]!.value,
              sourcesBefore,
            );
            assert.deepEqual(
              (
                await pool.query(
                  'SELECT jsonb_agg(to_jsonb(r) ORDER BY job_key) value FROM whaleu_community.reading_format_results r',
                )
              ).rows[0]!.value,
              resultsBefore,
            );
          }
        },
      );
      await t.test(
        'new derived owner remains unqualified for erasure, including empty/offset-only rows',
        async () => {
          await assert.rejects(
            inTransaction(pool, (tx) => inventory(tx)),
            (e: unknown) =>
              e instanceof DeletionError &&
              [
                'INVENTORY_BOUND_EXCEEDED',
                'UNREGISTERED_OWNER_RELATION',
              ].includes(e.code),
          );
          assert.ok(
            (
              await pool.query(
                'SELECT * FROM whaleu_community.reading_format_results',
              )
            ).rowCount! > 0,
          );
        },
      );
    } finally {
      await app?.close();
      await role?.close();
      if (owns)
        for (const schema of migrationSchemaNames)
          await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      if (locked)
        await suite?.query('SELECT pg_advisory_unlock($1,$2)', [
          MIGRATION_LOCK[0],
          2,
        ]);
      suite?.release();
      await pool.end();
    }
  },
);
