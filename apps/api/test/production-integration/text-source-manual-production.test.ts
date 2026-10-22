import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { hostname, userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { runTextReviewCliPty } from '../support/text-review-cli-pty.js';
import { sourceDescriptor } from '../../src/community/text-source/protocol.js';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import request from 'supertest';
import { IdentityRepository } from '../../src/identity/identity.repository.js';
import { mintToken, hashToken } from '../../src/identity/tokens.js';
import type { EffectiveContentEnvelope } from '../../src/community/content-review/contracts.js';
import { AppModule } from '../../src/app.module.js';
import { loadConfig } from '../../src/config/config.js';
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
import { configureHttp } from '../../src/http/http.js';
import { TextReviewOperator } from '../../src/community/text-review/operator.js';
import { TextReviewRuntime } from '../../src/community/text-review/runtime.js';
import { ApprovalRepository } from '../../src/community/content-review/approval.repository.js';
import {
  canonicalEnvelope,
  canonicalJson,
  approvalDigest,
} from '../../src/community/content-review/contracts.js';
import { setRuntimeVerification } from '../support/community-runtime-fixtures.js';
import {
  seedCommunityScope,
  appendIdentitySelection,
} from '../support/community-scope-fixtures.js';
import { migrationSchemaNames } from '../support/migration-schemas.js';
import {
  readingPostDetailSchema,
  readingCommentDetailSchema,
  readingReplyDetailSchema,
  readingCommentsPageSchema,
  readingRepliesPageSchema,
  readingContextSchema,
} from '../../src/community/reading-content/contracts.js';

/** Explicit standalone acceptance lane, not the non-TLS default integration glob.
 * Requires a disposable loopback whaleu_test on PG18.6+ with verified TLS. Supply
 * its CA via NODE_EXTRA_CA_CERTS when starting Node. Never weaken TLS for this test.
 * Identity/campus fixtures are synthetic; all review decisions use the real
 * CLI subprocess in a real util-linux PTY with the actual OS identity. No direct
 * decision insertion or simulated TTY. This current-binary lane installs the complete
 * migration chain, with formatter processing disabled, not absent M2 storage.
 * Exact0175 compatibility is tested separately with historical producers.
 * Synthetic content stays inside captured output.
 * This is not real-provider or physical-device acceptance. */
test(
  'production source_manual: current-chain real manual issuance and source HTTP without formatter processing',
  { timeout: 600000 },
  async () => {
    const database = process.env['TEST_DATABASE_URL'];
    assert.ok(database, 'Explicit disposable TLS TEST_DATABASE_URL required');
    const url = new URL(database);
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
    assert.equal(url.pathname, '/whaleu_test');
    const base = {
      NODE_ENV: 'production',
      DATABASE_URL: database,
      PG_SSL_MODE: 'verify-full',
      LOG_LEVEL: 'silent',
      COMMUNITY_READING_FORMATTING_PROCESSING: 'disabled',
      COMMUNITY_UPDATES_PROCESSING: 'disabled',
      EXPERIENCE_PROCESSING: 'disabled',
      VIEW_REPORTING_RETENTION_PROCESSING: 'disabled',
    };
    const pool = new Pool(poolOptions(loadConfig(base)));
    let app: INestApplication | undefined,
      suite: PoolClient | undefined,
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
      assert.equal(
        migrations.at(-1)?.name,
        '0179_identity_registration_guard.sql',
      );
      assert.deepEqual(
        migrations
          .filter((m) => Number(m.name.slice(0, 4)) >= 175)
          .map((m) => m.name),
        [
          '0175_community_text_sources.sql',
          '0176_durable_reading_formatting.sql',
          '0177_home_policy_admission.sql',
          '0178_home_publication_protocol.sql',
          '0179_identity_registration_guard.sql',
        ],
      );
      await runMigrations(pool, migrations, { mode: 'up' });
      const assertCurrentChain = async () => {
        assert.deepEqual(
          (
            await pool.query(
              'SELECT name,checksum FROM whaleu_meta.schema_migrations ORDER BY name',
            )
          ).rows,
          migrations.map(({ name, checksum }) => ({ name, checksum })),
        );
        assert.deepEqual(
          (
            await pool.query(`SELECT
            whaleu_community.reading_format_protocol()->>'catalog'=whaleu_community.reading_format_catalog() reading,
            whaleu_community.home_reading_protocol()->>'catalog'=whaleu_community.home_reading_catalog() home_reading,
            whaleu_community.home_publication_protocol()->>'catalog'=whaleu_community.home_publication_catalog() publication,
            whaleu_identity.registration_guard_protocol()->>'catalog'=whaleu_identity.registration_guard_catalog() registration,
            whaleu_community.home_publication_current() activation`)
          ).rows[0],
          {
            reading: true,
            home_reading: true,
            publication: true,
            registration: true,
            activation: null,
          },
        );
      };
      await assertCurrentChain();
      const scope = await seedCommunityScope(pool);
      const osOperator = `manual:${hostname()}:${userInfo().username}`;
      const environment = {
        ...base,
        COMMUNITY_TEXT_REVIEW: 'source_manual',
        COMMUNITY_TEXT_REVIEW_SPACE_ID: scope.home.spaceId,
        COMMUNITY_TEXT_REVIEW_REGION_ID: scope.home.regionId,
        COMMUNITY_TEXT_SOURCE_REVIEW_POLICY_ID: randomUUID(),
        COMMUNITY_TEXT_REVIEW_OPERATOR: osOperator,
      };
      const config = loadConfig(environment);
      app = await NestFactory.create(AppModule.register(config), {
        logger: false,
      });
      configureHttp(app);
      await app.init();
      // Dedicated guarded fixture: the standard helper correctly refuses production.
      // This lane has already proved loopback, empty disposable DB, TLS and ownership.
      assert.ok(owns && locked);
      const accessToken = mintToken('access'),
        refreshToken = mintToken('refresh');
      const session = await app.get(IdentityRepository).createSession(
        {
          provider: 'wechat',
          appId: 'synthetic-production-contract-only',
          subject: randomUUID(),
        },
        { access: hashToken(accessToken), refresh: hashToken(refreshToken) },
      );
      const actor = { ...session, accessToken };
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
      const http = app.getHttpServer(),
        auth = `Bearer ${actor.accessToken}`,
        runtime = app.get(TextReviewRuntime),
        operator = new TextReviewOperator(runtime, osOperator);
      const run = (command: Parameters<TextReviewOperator['run']>[0]) =>
        inTransaction(pool, (tx) => operator.run(command, tx));
      const cliEntry = fileURLToPath(
        new URL('../../src/community/text-review/cli.ts', import.meta.url),
      );
      const cli = (command: Parameters<TextReviewOperator['run']>[0]) =>
        runTextReviewCliPty(cliEntry, command, {
          ...process.env,
          ...environment,
        });
      const get = (path: string) =>
        request(http).get(path).set('Authorization', auth);
      const post = (path: string, body: Record<string, unknown>) =>
        request(http).post(path).set('Authorization', auth).send(body);
      const capabilityPath = `/v1/community/text-source-capabilities?spaceId=${scope.home.spaceId}&category=discussion&authorMode=named`;
      assert.equal(
        (await get(capabilityPath)).body.availability,
        'unavailable',
      );
      await cli({
        command: 'init-source-policy',
        basis:
          'Disposable test: OS reviewer explicitly accepts source-only manual review policy',
      });
      assert.equal((await get(capabilityPath)).body.availability, 'available');
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::integer n FROM whaleu_community.content_approval_policies WHERE policy_key<>'local-text-source-v1'",
          )
        ).rows[0]!.n,
        0,
      );
      assert.equal(runtime.configured(), false);
      for (const command of [
        'init-policy',
        'init-related-policy',
        'init-feedback',
      ] as const)
        await assert.rejects(
          run({ command, basis: 'Must not activate unrelated policy' }),
        );
      await assert.rejects(
        inTransaction(pool, (tx) =>
          new TextReviewOperator(runtime, 'manual:wrong:reviewer').run(
            { command: 'list' },
            tx,
          ),
        ),
      );
      const show = async (requestId: string) => {
        const displayed = (await cli({
          command: 'show',
          accountId: actor.accountId,
          requestId,
        })) as { digest: string; envelope: EffectiveContentEnvelope };
        const envelope = canonicalEnvelope(displayed.envelope);
        assert.equal(envelope.version, 6);
        assert.equal(displayed.digest, approvalDigest(envelope));
        const stored = (
          await pool.query(
            'SELECT envelope,digest FROM whaleu_community.text_review_requests WHERE account_id=$1 AND client_request_id=$2',
            [actor.accountId, requestId],
          )
        ).rows[0]!;
        assert.ok(
          canonicalJson(displayed.envelope) === canonicalJson(stored.envelope),
          'CLI display differs from the exact stored envelope',
        );
        assert.equal(displayed.digest, stored.digest);
        return displayed;
      };
      const decide = async (
        requestId: string,
        decision: 'allow' | 'reject' = 'allow',
        expected?: Record<string, unknown>,
      ) => {
        const displayed = await show(requestId);
        if (expected) {
          assert.ok(
            displayed.envelope.text === expected['text'],
            'CLI display differs from original source text',
          );
          if (displayed.envelope.version !== 6)
            assert.fail('Expected source envelope');
          assert.deepEqual(
            sourceDescriptor(displayed.envelope.textSource),
            expected['textSource'],
          );
        }
        await cli({
          command: 'decide',
          accountId: actor.accountId,
          requestId,
          digest: displayed.digest,
          decision,
          basis:
            'Disposable reviewer explicitly inspected exact displayed v6 source and format',
        });
        return displayed.digest;
      };
      const submit = async (path: string, body: Record<string, unknown>) => {
        const res = await post(
          path.replace('/v1/community/', '/v1/community/reviews/'),
          body,
        );
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(res.body.status, 'pending');
      };
      const publish = async (path: string, body: Record<string, unknown>) => {
        await submit(path, body);
        const digest = await decide(
          String(body['clientRequestId']),
          'allow',
          body,
        );
        const first = await post(path, body);
        assert.equal(first.status, 201, JSON.stringify(first.body));
        assert.equal(first.body.outcome, 'created');
        assert.deepEqual((await post(path, body)).body, first.body);
        const conflict = await post(path, {
          ...body,
          text: String(body['text']) + ' changed',
        });
        assert.equal(conflict.status, 409);
        return {
          id: first.body.resourceId as string,
          receipt: first.body,
          digest,
          body,
          path,
        };
      };
      const assertSourceBodies = (value: unknown): number => {
        if (value === null || typeof value !== 'object') return 0;
        const obj = value as Record<string, unknown>;
        let count = 0;
        if (obj['classification'] === 'reviewedSource' && 'value' in obj) {
          const v = obj['value'] as {
            presentation: { status: string };
            source: { classification: string };
          };
          assert.equal(v.presentation.status, 'source');
          assert.equal(v.source.classification, 'reviewedSource');
          count++;
        }
        for (const nested of Object.values(obj))
          count += assertSourceBodies(nested);
        return count;
      };
      const published: Awaited<ReturnType<typeof publish>>[] = [];
      for (const textSource of [
        { version: 1, format: 'plain', readingFormatting: 'auto' },
        { version: 1, format: 'markdown' },
      ] as const) {
        const rootBody = {
          clientRequestId: randomUUID(),
          spaceId: scope.home.spaceId,
          category: 'discussion',
          text:
            (textSource.format === 'markdown'
              ? '# Authored Markdown\n'
              : 'Authored plain\n') + '鲸'.repeat(300),
          imageAssetIds: [],
          authorMode: 'named',
          commentsPolicy: 'open',
          allowAnonymousDm: false,
          textSource,
        };
        const root = await publish('/v1/community/posts', rootBody);
        published.push(root);
        const child = await publish(`/v1/community/posts/${root.id}/comments`, {
          clientRequestId: randomUUID(),
          text: 'Source comment ' + '鲸'.repeat(200),
          imageAssetIds: [],
          authorMode: 'named',
          textSource,
        });
        const reply = await publish(
          `/v1/community/comments/${child.id}/replies`,
          {
            clientRequestId: randomUUID(),
            text: 'Source reply ' + '鲸'.repeat(200),
            imageAssetIds: [],
            authorMode: 'named',
            targetReplyId: null,
            textSource,
          },
        );
        for (const [path, schema] of [
          [`posts/${root.id}`, readingPostDetailSchema],
          [
            `posts/${root.id}/comments?sort=time&order=asc&previewLimit=5`,
            readingCommentsPageSchema,
          ],
          [`comments/${child.id}`, readingCommentDetailSchema],
          [`comments/${child.id}/replies`, readingRepliesPageSchema],
          [`replies/${reply.id}`, readingReplyDetailSchema],
          [
            `posts/${root.id}/discussion-context?replyId=${reply.id}`,
            readingContextSchema,
          ],
        ] as const) {
          const res = await get(`/v2/community/${path}`);
          assert.equal(res.status, 200, JSON.stringify(res.body));
          schema.parse(res.body);
          assert.ok(assertSourceBodies(res.body) > 0);
          assert.equal(res.headers['cache-control'], 'no-store');
        }
        const rows = await pool.query(
          'SELECT issuer,provenance_ref,envelope FROM whaleu_community.content_approval_decisions WHERE account_id=$1',
          [actor.accountId],
        );
        assert.ok(rows.rows.length > 0);
        for (const row of rows.rows) {
          assert.equal(row.issuer, osOperator);
          assert.equal(row.envelope.version, 6);
          assert.ok(String(row.provenance_ref).includes(osOperator));
        }
      }
      const original = published[0]!;
      // No automatic downgrade or activation of unrelated review.
      const legacy = { ...original.body, clientRequestId: randomUUID() };
      delete (legacy as Record<string, unknown>)['textSource'];
      for (const body of [
        legacy,
        {
          ...original.body,
          clientRequestId: randomUUID(),
          syncToRelatedCampuses: true,
        },
        {
          ...original.body,
          clientRequestId: randomUUID(),
          category: 'feedback',
        },
      ]) {
        const res = await post('/v1/community/reviews/posts', body);
        assert.ok(res.status >= 400, JSON.stringify(res.body));
      }
      // Rejection creates a durable command receipt, not published content.
      // Fingerprints cover inserts and updates without exposing source text.
      // These are fixed test-owned identifiers, never user-supplied SQL names.
      const publicationSideFacts = async () => {
        const relations = [
          'whaleu_community.posts',
          'whaleu_community.root_comments',
          'whaleu_community.replies',
          'whaleu_community.community_text_sources',
          'whaleu_community.reading_format_heads',
          'whaleu_community.reading_format_jobs',
          'whaleu_community.reading_format_slots',
          'whaleu_community.reading_format_results',
          'whaleu_community.content_approval_bindings',
          'whaleu_community.outbox',
          'whaleu_community.report_origins',
          'whaleu_community.content_reference_reservations',
          'whaleu_community.content_reference_canonicals',
          'whaleu_community.post_distribution_bindings',
          'whaleu_community.post_rating_target_links',
          'whaleu_media.bindings',
          'whaleu_post_hotness.subscription_baselines',
          'whaleu_post_hotness.subscription_states',
          'whaleu_post_hotness.view_baselines',
          'whaleu_post_hotness.view_states',
          'whaleu_post_hotness.comment_baselines',
          'whaleu_post_hotness.comment_states',
          'whaleu_post_hotness.like_baselines',
          'whaleu_post_hotness.like_states',
          'whaleu_post_hotness.scores',
          'whaleu_post_hotness.processing',
        ];
        const snapshots = [];
        for (const relation of relations) {
          const row = (
            await pool.query<{ count: number; fingerprint: string }>(
              `SELECT count(*)::integer AS count, md5(COALESCE(string_agg(row_to_json(t)::text, E'\\n' ORDER BY row_to_json(t)::text),'')) AS fingerprint FROM ${relation} t`,
            )
          ).rows[0]!;
          snapshots.push({ relation, ...row });
        }
        return snapshots;
      };
      const noSourceForRequest = async (requestId: string) => {
        const row = (
          await pool.query<{ n: number }>(
            'SELECT count(*)::integer n FROM whaleu_community.community_text_sources WHERE account_id=$1 AND client_request_id=$2',
            [actor.accountId, requestId],
          )
        ).rows[0]!;
        assert.equal(row.n, 0);
      };
      const rejected = { ...original.body, clientRequestId: randomUUID() };
      await submit(original.path, rejected);
      await decide(rejected.clientRequestId, 'reject');
      const beforeRejection = await publicationSideFacts();
      const rejection = await post(original.path, rejected);
      // @Post returns 201 for the settled receipt, including terminal rejection.
      // The receipt outcome, not HTTP 201 alone, determines publication success.
      assert.equal(rejection.status, 201);
      const rejectedReceipt = {
        requestId: rejected.clientRequestId,
        operation: 'publish_post',
        outcome: 'rejected',
        code: 'CONTENT_REJECTED',
      };
      assert.deepEqual(rejection.body, rejectedReceipt);
      assert.deepEqual(await publicationSideFacts(), beforeRejection);
      await noSourceForRequest(rejected.clientRequestId);
      const rejectionReplay = await post(original.path, rejected);
      assert.equal(rejectionReplay.status, 201);
      assert.deepEqual(rejectionReplay.body, rejectedReceipt);
      assert.deepEqual(await publicationSideFacts(), beforeRejection);
      const storedRejection = (
        await pool.query(
          'SELECT receipt FROM whaleu_community.publication_requests WHERE account_id=$1 AND client_request_id=$2',
          [actor.accountId, rejected.clientRequestId],
        )
      ).rows[0]!;
      assert.deepEqual(storedRejection.receipt, rejectedReceipt);
      const cancelled = { ...original.body, clientRequestId: randomUUID() };
      await submit(original.path, cancelled);
      const pending = (
        await pool.query(
          'SELECT intent_hash FROM whaleu_community.text_review_requests WHERE account_id=$1 AND client_request_id=$2',
          [actor.accountId, cancelled.clientRequestId],
        )
      ).rows[0]!;
      const cancellation = await post(
        `/v1/community/reviews/requests/${cancelled.clientRequestId}/cancel`,
        { operation: 'publish_post', intentHash: pending.intent_hash },
      );
      assert.equal(cancellation.status, 200, JSON.stringify(cancellation.body));
      await assert.rejects(decide(cancelled.clientRequestId));
      const beforeCancelledAttempt = await publicationSideFacts();
      const cancelledAttempt = await post(original.path, cancelled);
      // Cancellation fences reject before the repository's receipt savepoint.
      assert.equal(cancelledAttempt.status, 409);
      assert.equal(cancelledAttempt.body.error.code, 'MEDIA_REQUEST_CANCELLED');
      assert.equal(Object.hasOwn(cancelledAttempt.body, 'resourceId'), false);
      assert.deepEqual(await publicationSideFacts(), beforeCancelledAttempt);
      await noSourceForRequest(cancelled.clientRequestId);
      const cancelledState = (
        await pool.query(
          `SELECT p.receipt,q.decision_id,f.operation,f.intent_hash
         FROM whaleu_community.publication_requests p
         JOIN whaleu_community.text_review_requests q USING(account_id,client_request_id)
         JOIN whaleu_community.publication_cancel_fences f USING(account_id,client_request_id)
         WHERE p.account_id=$1 AND p.client_request_id=$2`,
          [actor.accountId, cancelled.clientRequestId],
        )
      ).rows[0]!;
      assert.deepEqual(cancelledState, {
        receipt: null,
        decision_id: null,
        operation: 'publish_post',
        intent_hash: pending.intent_hash,
      });
      await cli({
        command: 'withdraw',
        accountId: actor.accountId,
        requestId: String(original.body['clientRequestId']),
        digest: original.digest,
        state: 'revoked',
        basis: 'Explicit current source-authority withdrawal test',
      });
      const denied = await get(`/v2/community/posts/${original.id}`);
      assert.notEqual(denied.status, 200);
      assert.equal(Object.hasOwn(denied.body, 'body'), false);
      assert.deepEqual(
        (await post(original.path, original.body)).body,
        original.receipt,
      );
      // Oldest LIMIT 100 must not be occupied by cancelled rows forever.
      // All 100 enter through real review preparation; no queue/decision fabrication.
      for (let i = 0; i < 100; i++) {
        const stale = { ...original.body, clientRequestId: randomUUID() };
        await submit(original.path, stale);
        const row = (
          await pool.query(
            'SELECT intent_hash FROM whaleu_community.text_review_requests WHERE account_id=$1 AND client_request_id=$2',
            [actor.accountId, stale.clientRequestId],
          )
        ).rows[0]!;
        const result = await post(
          `/v1/community/reviews/requests/${stale.clientRequestId}/cancel`,
          { operation: 'publish_post', intentHash: row.intent_hash },
        );
        assert.equal(result.status, 200, JSON.stringify(result.body));
      }
      const fresh = { ...original.body, clientRequestId: randomUUID() };
      await submit(original.path, fresh);
      const listed = (await cli({ command: 'list' })) as {
        client_request_id: string;
      }[];
      assert.deepEqual(
        listed.map((row) => row.client_request_id),
        [fresh.clientRequestId],
      );
      const wrongIssuer = new TextReviewRuntime(
        loadConfig({
          ...environment,
          COMMUNITY_TEXT_REVIEW_OPERATOR: 'manual:wrong:issuer',
        }),
        new ApprovalRepository(),
      );
      assert.equal(
        await inTransaction(pool, (tx) =>
          wrongIssuer.sourceAvailable(
            { id: scope.home.spaceId, operatingRegionId: scope.home.regionId },
            tx,
          ),
        ),
        false,
      );
      // Negative policy fixture only: it never issues/approves any decision.
      const expiredPolicy = randomUUID();
      await pool.query(
        "INSERT INTO whaleu_community.content_approval_policies(id,policy_key,version,coverage,provenance,issuer,provenance_ref,valid_from,valid_until) VALUES($1,'local-text-source-v1',1,'complete','accepted',$2,'Expired negative policy fixture',clock_timestamp()-interval '2 hours',clock_timestamp()-interval '1 hour')",
        [expiredPolicy, osOperator],
      );
      const expiredRuntime = new TextReviewRuntime(
        loadConfig({
          ...environment,
          COMMUNITY_TEXT_SOURCE_REVIEW_POLICY_ID: expiredPolicy,
        }),
        new ApprovalRepository(),
      );
      assert.equal(
        await inTransaction(pool, (tx) =>
          expiredRuntime.sourceAvailable(
            { id: scope.home.spaceId, operatingRegionId: scope.home.regionId },
            tx,
          ),
        ),
        false,
      );
      await assertCurrentChain();
      // The real eligible plain post/comment/reply enroll through the current
      // publication owner. Disabling processing does not remove M2 storage or
      // suppress legitimate jobs; no formatter process has claimed any work.
      assert.deepEqual(
        (
          await pool.query(`SELECT
          (SELECT count(*)::integer FROM whaleu_community.reading_format_heads) heads,
          (SELECT count(*)::integer FROM whaleu_community.reading_format_jobs) jobs,
          (SELECT count(*)::integer FROM whaleu_community.reading_format_jobs
            WHERE state<>'pending' OR claims<>0 OR lease_fence<>0 OR lease_token IS NOT NULL
              OR lease_until IS NOT NULL OR slot_id IS NOT NULL OR row_version<>1
              OR schedule_state<>'runnable' OR probe_count<>0 OR scheduling_reason IS NOT NULL) processed,
          (SELECT count(*)::integer FROM whaleu_community.reading_format_results) results,
          (SELECT count(*)::integer FROM whaleu_community.reading_format_slots
            WHERE job_key IS NOT NULL OR lease_token IS NOT NULL OR lease_fence IS NOT NULL OR lease_until IS NOT NULL) occupied_slots`)
        ).rows[0],
        { heads: 3, jobs: 3, processed: 0, results: 0, occupied_slots: 0 },
      );
    } finally {
      await app?.close();
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
