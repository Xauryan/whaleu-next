import {
  inventory,
  relationSql,
} from '../../src/account-deletion/owners/preflight.js';
import {
  reviewedRelations,
  supportedTables,
} from '../../src/account-deletion/owner-registry.js';
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
import { lockSafetyPolicy } from '../../src/safety/locks.js';
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
} from '../support/community-scope-fixtures.js';
import { migrationSchemaNames } from '../support/migration-schemas.js';
import {
  setSyntheticSnapshot,
  syntheticAssertion,
} from '../support/verification-fixtures.js';

/** Capture all installed application rows, not only the source-owner count.
 * Catalog names and ownership/grants are retained, including protected schemas. */
async function sourceOwnerState(pool: Pool) {
  const schemas = (
    await pool.query<{ name: string; owner: number; acl: string | null }>(
      "SELECT nspname name,nspowner owner,nspacl::text acl FROM pg_namespace WHERE nspname LIKE 'whaleu\\_%' ESCAPE '\\' ORDER BY nspname COLLATE \"C\"",
    )
  ).rows;
  const relations = (
    await pool.query<{
      relation: string;
      kind: string;
      owner: number;
      acl: string | null;
    }>(
      "SELECT n.nspname||'.'||c.relname relation,c.relkind kind,c.relowner owner,c.relacl::text acl FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname LIKE 'whaleu\\_%' ESCAPE '\\' AND c.relkind IN('r','p','m','f') ORDER BY (n.nspname||'.'||c.relname) COLLATE \"C\"",
    )
  ).rows;
  const rows: Record<string, string[]> = {};
  for (const { relation, kind } of relations) {
    assert.ok(['r', 'p'].includes(kind));
    rows[relation] = (
      await pool.query<{ raw: string }>(
        `SELECT to_jsonb(t)::text raw FROM ${relationSql(relation)} t ORDER BY to_jsonb(t)::text COLLATE "C"`,
      )
    ).rows.map(({ raw }) => raw);
  }
  return { schemas, relations, rows };
}

/** Real runtime HTTP and real local issuer. Only identity/scope/phone facts are
 * synthetic disposable fixtures; this is not a real WeChat-device acceptance. */
test(
  'text-source v6 real HTTP publication, original receipts, independent reads and current denial',
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
      COMMUNITY_UPDATES_PROCESSING: 'disabled',
      EXPERIENCE_PROCESSING: 'disabled',
      VIEW_REPORTING_RETENTION_PROCESSING: 'disabled',
    };
    const pool = new Pool(poolOptions(loadConfig(base)));
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
      await runMigrations(pool, migrations, { mode: 'up' });
      // Require the complete ordered 0182 predecessor prefix, not a latest-version pin.
      // Later checked-in migrations remain part of the full ledger below.
      const requiredCurrentPrefix = migrations.slice(0, 182);
      assert.deepEqual(
        requiredCurrentPrefix.map(({ name }) => name.slice(0, 4)),
        Array.from({ length: 182 }, (_, index) =>
          String(index + 1).padStart(4, '0'),
        ),
      );
      assert.equal(
        requiredCurrentPrefix.at(-1)?.name,
        '0182_real_deletion_request_authority.sql',
      );
      assert.deepEqual(
        (
          await pool.query<{ name: string; checksum: string }>(
            'SELECT name,checksum FROM whaleu_meta.schema_migrations ORDER BY name',
          )
        ).rows,
        migrations.map(({ name, checksum }) => ({ name, checksum })),
      );
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
        actor = await createRuntimeActor(app),
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
        text: 'Source Whale\r\n' + '鲸'.repeat(300),
        imageAssetIds: [],
        authorMode: 'named',
        commentsPolicy: 'open',
        allowAnonymousDm: false,
        textSource: plain,
      };
      const sourcePost = await reviewed('/v1/community/posts', body);
      // The current real producer and readers retain their full migration chain.
      // The storage suite separately proves the exact historical 0175 owner bound.
      await t.test(
        'current chain namespace gate denies erasure without mutating the published source owner',
        async () => {
          const before = await sourceOwnerState(pool);
          const knownSchemas = new Set(
            [...reviewedRelations].map((name) => name.split('.')[0]),
          );
          assert.deepEqual(
            before.schemas
              .map(({ name }) => name)
              .filter(
                (name) =>
                  !knownSchemas.has(name) &&
                  !['whaleu_account_deletion', 'whaleu_meta'].includes(name),
              ),
            ['whaleu_real_deletion', 'whaleu_real_deletion_admission'],
          );
          assert.equal(
            reviewedRelations.has('whaleu_community.community_text_sources'),
            false,
          );
          assert.equal(
            supportedTables.has('whaleu_community.community_text_sources'),
            false,
          );
          const sources = before.rows[
            'whaleu_community.community_text_sources'
          ]!.map((row) => JSON.parse(row) as Record<string, unknown>);
          assert.equal(sources.length, 1);
          assert.equal(sources[0]!['content_kind'], 'post');
          assert.equal(sources[0]!['content_id'], sourcePost.id);
          assert.equal(sources[0]!['account_id'], actor.accountId);
          assert.equal(sources[0]!['client_request_id'], body.clientRequestId);
          // The protected 0181/0182 namespaces fail before the relation bound.
          // This is not evidence of the historical per-owner inventory stage.
          await assert.rejects(
            inTransaction(pool, (tx) => inventory(tx)),
            (error: unknown) =>
              error instanceof DeletionError &&
              error.code === 'UNREGISTERED_OWNER_SCHEMA',
          );
          assert.deepEqual(await sourceOwnerState(pool), before);
        },
      );
      const sourceRead = await read('post', sourcePost.id);
      assert.equal(sourceRead.status, 200, JSON.stringify(sourceRead.body));
      assert.equal(sourceRead.body.classification, 'reviewedSource');
      assert.equal(sourceRead.body.text, body.text.replace(/\r\n/g, '\n'));
      assert.equal(sourceRead.body.readingFormattingEligible, true);
      assert.equal(sourceRead.body.presentationStatus, 'not_configured');
      assert.equal(sourceRead.headers['cache-control'], 'no-store');
      assert.equal(sourceRead.headers['vary'], 'Authorization');
      assert.equal(Object.hasOwn(sourceRead.body, 'accountId'), false);
      await t.test(
        'same original request cannot change source format or reading policy',
        async () => {
          for (const textSource of [
            markdown,
            { ...plain, readingFormatting: 'off' },
          ]) {
            const conflict = await call('/v1/community/posts', {
              ...body,
              textSource,
            });
            assert.equal(conflict.body.error.code, 'REQUEST_CONFLICT');
          }
          const counts = (
            await pool.query<{
              sources: number;
              bindings: number;
              events: number;
              origins: number;
            }>(
              `SELECT
          (SELECT count(*)::integer FROM whaleu_community.community_text_sources WHERE content_kind='post' AND content_id=$1) sources,
          (SELECT count(*)::integer FROM whaleu_community.content_approval_bindings WHERE content_kind='post' AND content_id=$1) bindings,
          (SELECT count(*)::integer FROM whaleu_community.outbox WHERE event_key='post:'||$1::text||':created') events,
          (SELECT count(*)::integer FROM whaleu_community.report_origins WHERE kind='post' AND target_id=$1) origins`,
              [sourcePost.id],
            )
          ).rows[0];
          assert.deepEqual(counts, {
            sources: 1,
            bindings: 1,
            events: 1,
            origins: 1,
          });
        },
      );
      const legacyBody = {
        ...body,
        clientRequestId: randomUUID(),
        text: 'Legacy literal **not Markdown**',
      } as Record<string, unknown>;
      delete legacyBody['textSource'];
      delete legacyBody['allowAnonymousDm'];
      const legacyPost = await reviewed('/v1/community/posts', legacyBody);
      const legacyRead = await read('post', legacyPost.id);
      assert.equal(legacyRead.body.classification, 'legacyPlain');
      assert.deepEqual(
        Object.keys(legacyRead.body).sort(),
        [
          'version',
          'classification',
          'kind',
          'id',
          'postId',
          'rootCommentId',
          'text',
        ].sort(),
      );
      const rawSource = await request(http)
        .get(`/v1/community/posts/${sourcePost.id}`)
        .set('Authorization', auth);
      const rawLegacy = await request(http)
        .get(`/v1/community/posts/${legacyPost.id}`)
        .set('Authorization', auth);
      assert.equal(rawSource.status, 200, JSON.stringify(rawSource.body));
      assert.deepEqual(
        Object.keys(rawSource.body).sort(),
        Object.keys(rawLegacy.body).sort(),
      );
      assert.equal(rawSource.body.text, sourceRead.body.text);
      assert.equal(Object.hasOwn(rawSource.body, 'textSource'), false);

      const plainChild = await reviewed(
        `/v1/community/posts/${sourcePost.id}/comments`,
        {
          clientRequestId: randomUUID(),
          text: 'Legacy child remains plain under source parent',
          imageAssetIds: [],
          authorMode: 'named',
        },
      );
      assert.equal(
        (await read('comment', plainChild.id)).body.classification,
        'legacyPlain',
      );
      const sourceChild = await reviewed(
        `/v1/community/posts/${legacyPost.id}/comments`,
        {
          clientRequestId: randomUUID(),
          text: '# Source child of legacy parent',
          imageAssetIds: [],
          authorMode: 'named',
          textSource: markdown,
        },
      );
      assert.equal(
        (await read('comment', sourceChild.id)).body.classification,
        'reviewedSource',
      );
      const sourceReply = await reviewed(
        `/v1/community/comments/${plainChild.id}/replies`,
        {
          clientRequestId: randomUUID(),
          text: 'Reply source ' + '鲸'.repeat(200),
          imageAssetIds: [],
          authorMode: 'named',
          targetReplyId: null,
          textSource: { ...plain, readingFormatting: 'off' },
        },
      );
      const replyRead = await read('reply', sourceReply.id);
      assert.equal(replyRead.body.readingFormattingEligible, false);
      assert.equal(replyRead.body.presentationStatus, 'ineligible');
      const legacyReply = await reviewed(
        `/v1/community/comments/${sourceChild.id}/replies`,
        {
          clientRequestId: randomUUID(),
          text: 'Legacy reply does not inherit Markdown',
          imageAssetIds: [],
          authorMode: 'named',
          targetReplyId: null,
        },
      );
      assert.equal(
        (await read('reply', legacyReply.id)).body.classification,
        'legacyPlain',
      );

      // Future-only real SQL regression. The wrapper retains the actual managed
      // transaction, routes, authorization, effects and all database triggers. It
      // injects a legal dependency write after the real operation, not a mock proof.
      const databaseService = app.get(DatabaseService);
      const originalTransaction =
        databaseService.transaction.bind(databaseService);
      const withPostOperation = async <T>(
        cohort: 'submission' | 'publication',
        requestId: string,
        after: (tx: PoolClient) => Promise<void>,
        operation: () => Promise<T>,
      ): Promise<T> => {
        databaseService.transaction = (operation, options) =>
          originalTransaction(async (tx) => {
            await lockSafetyPolicy(tx, true);
            const result = await operation(tx);
            const active = (
              await tx.query<{ active: boolean }>(
                cohort === 'publication'
                  ? 'SELECT EXISTS(SELECT 1 FROM whaleu_community.community_text_sources WHERE account_id=$1 AND client_request_id=$2 AND publication_transaction=pg_current_xact_id()) active'
                  : 'SELECT EXISTS(SELECT 1 FROM whaleu_community.text_review_requests WHERE account_id=$1 AND client_request_id=$2 AND submission_transaction=pg_current_xact_id()) active',
                [actor.accountId, requestId],
              )
            ).rows[0]!.active;
            if (active) await after(tx);
            return result;
          }, options);
        try {
          return await operation();
        } finally {
          databaseService.transaction = originalTransaction;
        }
      };
      const causal = (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === '23514' &&
        'constraint' in error &&
        error.constraint === 'text_source_causal';
      const prepareSource = async () => {
        const input = {
          ...body,
          clientRequestId: randomUUID(),
          text: `Timing ${randomUUID()}`,
        };
        const queued = await call('/v1/community/reviews/posts', input);
        assert.equal(queued.status, 200, JSON.stringify(queued.body));
        assert.equal(queued.body.status, 'pending');
        return input;
      };
      const invalidations = [
        {
          name: 'space',
          sql: 'UPDATE whaleu_community.spaces SET is_active=false WHERE id=$1',
          value: scope.home.spaceId,
        },
        {
          name: 'Safety',
          sql: 'UPDATE whaleu_safety.account_heads SET actions_allowed=false WHERE account_id=$1',
          value: actor.accountId,
        },
        {
          name: 'topology region',
          sql: 'UPDATE whaleu_campus.operating_regions SET is_active=false WHERE id=$1',
          value: scope.home.regionId,
        },
        {
          name: 'identity head TRUNCATE',
          sql: 'TRUNCATE whaleu_campus.community_identity_heads',
          value: null,
        },
      ];
      const timings = [
        { name: 'deferred', sql: 'SET CONSTRAINTS ALL DEFERRED' },
        { name: 'all immediate', sql: 'SET CONSTRAINTS ALL IMMEDIATE' },
        {
          name: 'named immediate',
          sql: 'SET CONSTRAINTS whaleu_community.text_source_recheck, whaleu_community.text_source_review_complete, whaleu_community.text_source_decision_complete, whaleu_community.text_source_complete IMMEDIATE',
        },
      ];
      await t.test(
        'v2 all three real transaction cohorts reject post-flush changed authority',
        async () => {
          for (const cohort of [
            'submission',
            'publication',
            'decision',
          ] as const)
            for (const timing of timings)
              for (const mutation of invalidations) {
                const input =
                  cohort === 'submission'
                    ? {
                        ...body,
                        clientRequestId: randomUUID(),
                        text: `Fresh ${randomUUID()}`,
                      }
                    : await prepareSource();
                let reached = false,
                  rejectedBySource = false;
                const invalidate = async (tx: PoolClient) => {
                  await tx.query(timing.sql);
                  await tx.query(
                    'UPDATE whaleu_community.spaces SET is_active=false WHERE false',
                  );
                  await tx.query(
                    'DELETE FROM whaleu_community.spaces WHERE false',
                  );
                  reached = true;
                  try {
                    await tx.query(
                      mutation.sql,
                      mutation.value === null ? [] : [mutation.value],
                    );
                  } catch (error) {
                    rejectedBySource = causal(error);
                    throw error;
                  }
                  assert.fail(
                    'Post-write source authority callback must reject changed state',
                  );
                };
                if (cohort === 'decision') {
                  const queue = (
                    await pool.query<{ digest: string }>(
                      'SELECT digest FROM whaleu_community.text_review_requests WHERE account_id=$1 AND client_request_id=$2',
                      [actor.accountId, input.clientRequestId],
                    )
                  ).rows[0]!;
                  await assert.rejects(
                    inTransaction(pool, async (tx) => {
                      await lockSafetyPolicy(tx, true);
                      await operator.run(
                        {
                          command: 'decide',
                          accountId: actor.accountId,
                          requestId: input.clientRequestId,
                          digest: queue.digest,
                          decision: 'allow',
                          basis: 'Disposable third-cohort timing proof',
                        },
                        tx,
                      );
                      const markers = (
                        await tx.query<{
                          old_submission: boolean;
                          current_queue: boolean;
                          current_decision: boolean;
                        }>(
                          `SELECT q.submission_transaction<>pg_current_xact_id() old_submission,q.text_source_transition_transaction=pg_current_xact_id() current_queue,d.text_source_issuance_transaction=pg_current_xact_id() current_decision
                     FROM whaleu_community.text_review_requests q JOIN whaleu_community.content_approval_decisions d ON d.id=q.decision_id WHERE q.account_id=$1 AND q.client_request_id=$2`,
                          [actor.accountId, input.clientRequestId],
                        )
                      ).rows[0];
                      assert.deepEqual(markers, {
                        old_submission: true,
                        current_queue: true,
                        current_decision: true,
                      });
                      await invalidate(tx);
                    }),
                    causal,
                  );
                } else {
                  if (cohort === 'publication')
                    await decide(input.clientRequestId);
                  const response = await withPostOperation(
                    cohort,
                    input.clientRequestId,
                    invalidate,
                    async () =>
                      call(
                        cohort === 'submission'
                          ? '/v1/community/reviews/posts'
                          : '/v1/community/posts',
                        input,
                      ),
                  );
                  assert.notEqual(response.body.outcome, 'created');
                  assert.notEqual(response.body.status, 'pending');
                }
                assert.equal(
                  reached,
                  true,
                  `${cohort}/${timing.name}/${mutation.name}: valid construction must finish first`,
                );
                assert.equal(
                  rejectedBySource,
                  true,
                  `${cohort}/${timing.name}/${mutation.name}: unrelated owner rejection is not proof`,
                );
                assert.equal(
                  (
                    await pool.query(
                      'SELECT 1 FROM whaleu_community.community_text_sources WHERE account_id=$1 AND client_request_id=$2',
                      [actor.accountId, input.clientRequestId],
                    )
                  ).rowCount,
                  0,
                );
              }
        },
      );
      await t.test(
        'v2 normal source staging, zero-row writes and savepoint recovery remain valid',
        async () => {
          const input = await prepareSource();
          await decide(input.clientRequestId);
          let checked = false;
          const created = await withPostOperation(
            'publication',
            input.clientRequestId,
            async (tx) => {
              await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
              await tx.query('SAVEPOINT source_invalid_attempt');
              await assert.rejects(
                tx.query(invalidations[0]!.sql, [invalidations[0]!.value]),
                causal,
              );
              await tx.query('ROLLBACK TO SAVEPOINT source_invalid_attempt');
              // Zero rows change no authority. Unlike a captured v4 fingerprint,
              // current v6 authority permits these genuine no-op statements.
              await tx.query(
                'UPDATE whaleu_community.spaces SET is_active=false WHERE false',
              );
              await tx.query('DELETE FROM whaleu_community.spaces WHERE false');
              await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
              checked = true;
            },
            async () => call('/v1/community/posts', input),
          );
          assert.equal(checked, true);
          assert.equal(
            created.body.outcome,
            'created',
            JSON.stringify(created.body),
          );
          assert.equal(
            (await read('post', created.body.resourceId)).body.classification,
            'reviewedSource',
          );
        },
      );
      await t.test(
        'v2 current cohort markers cannot be supplied, rewritten or restamped by no-op queue updates',
        async () => {
          const q = (
            await pool.query<{ decision_id: string }>(
              'SELECT decision_id FROM whaleu_community.text_review_requests WHERE account_id=$1 AND client_request_id=$2',
              [actor.accountId, body.clientRequestId],
            )
          ).rows[0]!;
          await assert.rejects(
            inTransaction(pool, (tx) =>
              tx.query(
                'UPDATE whaleu_community.text_review_requests SET text_source_transition_transaction=pg_current_xact_id() WHERE account_id=$1 AND client_request_id=$2',
                [actor.accountId, body.clientRequestId],
              ),
            ),
            (error: unknown) =>
              error instanceof Error &&
              /queue transaction is immutable/.test(error.message),
          );
          await assert.rejects(
            inTransaction(pool, (tx) =>
              tx.query(
                'UPDATE whaleu_community.content_approval_decisions SET text_source_issuance_transaction=pg_current_xact_id() WHERE id=$1',
                [q.decision_id],
              ),
            ),
          );
          await inTransaction(pool, async (tx) => {
            await tx.query(
              'UPDATE whaleu_community.text_review_requests SET decision_id=decision_id WHERE account_id=$1 AND client_request_id=$2',
              [actor.accountId, body.clientRequestId],
            );
            assert.equal(
              (
                await tx.query<{ fresh: boolean }>(
                  'SELECT text_source_transition_transaction=pg_current_xact_id() fresh FROM whaleu_community.text_review_requests WHERE account_id=$1 AND client_request_id=$2',
                  [actor.accountId, body.clientRequestId],
                )
              ).rows[0]!.fresh,
              false,
            );
          });
          assert.equal(
            (
              await pool.query(
                `SELECT count(*)::integer n FROM whaleu_community.content_approval_decisions WHERE envelope_version<>6 AND text_source_issuance_transaction IS NOT NULL`,
              )
            ).rows[0]!.n,
            0,
          );
          assert.equal(
            (
              await pool.query(
                `SELECT count(*)::integer n FROM whaleu_community.text_review_requests WHERE envelope->>'version'<>'6' AND text_source_transition_transaction IS NOT NULL`,
              )
            ).rows[0]!.n,
            0,
          );
        },
      );
      await t.test(
        'v2 queue insertion cannot supply even the correct current transaction marker',
        async () => {
          await assert.rejects(
            inTransaction(pool, async (tx) => {
              await lockSafetyPolicy(tx, true);
              const forgedRequest = randomUUID();
              await tx.query(
                `INSERT INTO whaleu_community.publication_requests(account_id,client_request_id,operation,payload_hash,review_submission_transaction)
            SELECT account_id,$3,operation,intent_hash,pg_current_xact_id() FROM whaleu_community.text_review_requests WHERE account_id=$1 AND client_request_id=$2`,
                [actor.accountId, body.clientRequestId, forgedRequest],
              );
              await tx.query(
                `INSERT INTO whaleu_community.text_review_requests(account_id,client_request_id,operation,intent_hash,envelope,digest,text_source_transition_transaction)
            SELECT account_id,$3,operation,intent_hash,envelope,digest,pg_current_xact_id() FROM whaleu_community.text_review_requests WHERE account_id=$1 AND client_request_id=$2`,
                [actor.accountId, body.clientRequestId, forgedRequest],
              );
            }),
            (error: unknown) =>
              error instanceof Error &&
              /queue transaction is server owned/.test(error.message),
          );
        },
      );
      await t.test(
        'v2 older queue linking a previously issued unqueued decision is independently tracked',
        async () => {
          const input = await prepareSource();
          const decision = randomUUID();
          await inTransaction(pool, async (tx) => {
            await lockSafetyPolicy(tx, true);
            await tx.query(
              `INSERT INTO whaleu_community.content_approval_decisions(id,account_id,operation,envelope_version,digest,envelope,policy_revision_id,result,coverage,provenance,issuer,provenance_ref,evaluated_at,consume_until,visibility_model)
            SELECT $3,account_id,operation,6,digest,envelope,$4,'reject','complete','accepted','local:test:reviewer','Disposable separately issued queue transition proof',clock_timestamp(),clock_timestamp()+interval '1 hour','durable'
            FROM whaleu_community.text_review_requests WHERE account_id=$1 AND client_request_id=$2`,
              [
                actor.accountId,
                input.clientRequestId,
                decision,
                config.COMMUNITY_TEXT_SOURCE_REVIEW_POLICY_ID,
              ],
            );
          });
          let flushed = false;
          await assert.rejects(
            inTransaction(pool, async (tx) => {
              await lockSafetyPolicy(tx, true);
              await tx.query(
                'UPDATE whaleu_community.text_review_requests SET decision_id=$3 WHERE account_id=$1 AND client_request_id=$2',
                [actor.accountId, input.clientRequestId, decision],
              );
              assert.deepEqual(
                (
                  await tx.query<{
                    submission_fresh: boolean;
                    decision_fresh: boolean;
                    queue_fresh: boolean;
                  }>(
                    `SELECT q.submission_transaction=pg_current_xact_id() submission_fresh,d.text_source_issuance_transaction=pg_current_xact_id() decision_fresh,q.text_source_transition_transaction=pg_current_xact_id() queue_fresh FROM whaleu_community.text_review_requests q JOIN whaleu_community.content_approval_decisions d ON d.id=q.decision_id WHERE q.account_id=$1 AND q.client_request_id=$2`,
                    [actor.accountId, input.clientRequestId],
                  )
                ).rows[0],
                {
                  submission_fresh: false,
                  decision_fresh: false,
                  queue_fresh: true,
                },
              );
              await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
              flushed = true;
              await tx.query(
                'UPDATE whaleu_community.spaces SET is_active=false WHERE id=$1',
                [scope.home.spaceId],
              );
            }),
            causal,
          );
          assert.equal(flushed, true);
        },
      );
      const copyDecision = async (
        tx: PoolClient,
        previous: string,
        result: 'allow' | 'reject' | 'pending',
        options: { head?: boolean; tie?: boolean; spoof?: boolean } = {},
      ) => {
        const id = options.tie
          ? 'ffffffff-ffff-4fff-bfff-ffffffffffff'
          : randomUUID();
        await tx.query(
          `INSERT INTO whaleu_community.content_approval_decisions
          (id,account_id,operation,envelope_version,digest,envelope,policy_revision_id,result,coverage,provenance,issuer,provenance_ref,evaluated_at,consume_until,visibility_model${options.spoof ? ',text_source_issuance_transaction' : ''})
          SELECT $2,account_id,operation,envelope_version,digest,envelope,policy_revision_id,$3,'complete','accepted','local:test:reviewer','Disposable exact latest-decision regression',${options.tie ? 'evaluated_at' : 'clock_timestamp()'},clock_timestamp()+interval '1 hour','durable'${options.spoof ? ',pg_current_xact_id()' : ''}
          FROM whaleu_community.content_approval_decisions WHERE id=$1`,
          [previous, id, result],
        );
        if (options.head) {
          const event = randomUUID();
          await tx.query(
            `INSERT INTO whaleu_community.content_approval_events(id,decision_id,state,coverage,provenance,issuer,provenance_ref,occurred_at) VALUES($1,$2,'allow','complete','accepted','local:test:reviewer','Disposable current head',clock_timestamp())`,
            [event, id],
          );
          await tx.query(
            'INSERT INTO whaleu_community.content_approval_heads(decision_id,event_id) VALUES($1,$2)',
            [id, event],
          );
        }
        return id;
      };
      await t.test(
        'v2 unqueued issuance is tracked without demanding an allow or an already-created head',
        async () => {
          const previous = (
            await pool.query<{ decision_id: string }>(
              'SELECT decision_id FROM whaleu_community.community_text_sources WHERE content_kind=$1 AND content_id=$2',
              ['post', sourcePost.id],
            )
          ).rows[0]!.decision_id;
          for (const result of ['reject', 'pending', 'allow'] as const) {
            let issued = false,
              flushed = false;
            await assert.rejects(
              inTransaction(pool, async (tx) => {
                await lockSafetyPolicy(tx, true);
                const id = await copyDecision(tx, previous, result);
                issued = true;
                assert.equal(
                  (
                    await tx.query(
                      'SELECT 1 FROM whaleu_community.text_review_requests WHERE decision_id=$1',
                      [id],
                    )
                  ).rowCount,
                  0,
                );
                await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
                flushed = true;
                await tx.query(
                  'UPDATE whaleu_community.spaces SET is_active=false WHERE id=$1',
                  [scope.home.spaceId],
                );
              }),
              causal,
            );
            assert.equal(
              issued && flushed,
              true,
              'Decision issuance itself must work without a head, including reject/pending',
            );
          }
          await assert.rejects(
            inTransaction(pool, async (tx) => {
              await lockSafetyPolicy(tx, true);
              await copyDecision(tx, previous, 'allow', { spoof: true });
            }),
            (error: unknown) =>
              error instanceof Error &&
              /decision transaction is server owned/.test(error.message),
          );
        },
      );
      await t.test(
        'v2 SQL consumption rejects older exact allow, while durable bound visibility remains current',
        async () => {
          for (const variant of [
            { result: 'reject' as const, head: true, tie: false },
            { result: 'pending' as const, head: true, tie: false },
            { result: 'allow' as const, head: false, tie: false },
            { result: 'reject' as const, head: true, tie: true },
          ]) {
            const input = await prepareSource();
            await decide(input.clientRequestId);
            const q = (
              await pool.query<{ decision_id: string }>(
                'SELECT decision_id FROM whaleu_community.text_review_requests WHERE account_id=$1 AND client_request_id=$2',
                [actor.accountId, input.clientRequestId],
              )
            ).rows[0]!;
            let selected = false,
              insertedContent = false;
            await assert.rejects(
              inTransaction(pool, async (tx) => {
                await lockSafetyPolicy(tx, true);
                await copyDecision(tx, q.decision_id, variant.result, variant);
                assert.deepEqual(
                  (
                    await tx.query<{ consume: boolean; visible: boolean }>(
                      'SELECT whaleu_community.text_source_review_current($1,true) consume,whaleu_community.text_source_review_current($1,false) visible',
                      [q.decision_id],
                    )
                  ).rows[0],
                  { consume: false, visible: true },
                );
                selected = true;
                // Bypass the TS selector only, never database guards. The rejection
                // must originate in v6 source authority before deferred incomplete
                // reference/effect checks, not from an already-consumed decision.
                const postId = randomUUID();
                await tx.query(
                  `INSERT INTO whaleu_community.posts(id,space_id,account_id,category,text,author_mode,comments_policy,publication_envelope_version,allow_anonymous_dm)
              SELECT $2,(envelope->>'spaceId')::uuid,account_id,envelope->>'category',envelope->>'text',envelope->>'authorMode','open',6,(envelope->>'allowAnonymousDm')::boolean FROM whaleu_community.content_approval_decisions WHERE id=$1`,
                  [q.decision_id, postId],
                );
                insertedContent = true;
                await tx.query(
                  `INSERT INTO whaleu_community.community_text_sources(content_kind,content_id,source_format,reading_formatting,source_hash,account_id,client_request_id,requested_author_mode,original_intent_hash,decision_id,approval_digest)
              SELECT 'post',$3,envelope->'textSource'->>'format',envelope->'textSource'->>'readingFormatting',envelope->'textSource'->>'sourceHash',account_id,client_request_id,envelope->>'authorMode',intent_hash,decision_id,digest FROM whaleu_community.text_review_requests WHERE account_id=$1 AND client_request_id=$2`,
                  [actor.accountId, input.clientRequestId, postId],
                );
              }),
              causal,
            );
            assert.equal(
              selected && insertedContent,
              true,
              'Raw source insertion must be the rejected boundary',
            );
          }
          const previous = (
            await pool.query<{ decision_id: string }>(
              'SELECT decision_id FROM whaleu_community.community_text_sources WHERE content_kind=$1 AND content_id=$2',
              ['post', sourcePost.id],
            )
          ).rows[0]!.decision_id;
          const rollback = new Error('Discard disposable newest-allow control');
          await assert.rejects(
            inTransaction(pool, async (tx) => {
              await lockSafetyPolicy(tx, true);
              const newest = await copyDecision(tx, previous, 'allow', {
                head: true,
              });
              assert.equal(
                (
                  await tx.query<{ current: boolean }>(
                    'SELECT whaleu_community.text_source_review_current($1,true) current',
                    [newest],
                  )
                ).rows[0]!.current,
                true,
              );
              assert.equal(
                (
                  await tx.query<{ current: boolean }>(
                    'SELECT whaleu_community.text_source_review_current($1,false) current',
                    [previous],
                  )
                ).rows[0]!.current,
                true,
              );
              await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
              throw rollback;
            }),
            (error: unknown) => error === rollback,
          );
        },
      );
      await t.test(
        'ordinary feed/count/search/Saved read original text without source DTO keys',
        async () => {
          const feed = await request(http)
            .get(
              `/v1/community/posts?spaceId=${scope.home.spaceId}&category=discussion`,
            )
            .set('Authorization', auth);
          assert.equal(feed.status, 200, JSON.stringify(feed.body));
          assert.ok(JSON.stringify(feed.body).includes(sourcePost.id));
          const comments = await request(http)
            .get(`/v1/community/posts/${sourcePost.id}/comments`)
            .set('Authorization', auth);
          assert.equal(comments.status, 200, JSON.stringify(comments.body));
          assert.ok(JSON.stringify(comments.body).includes(plainChild.id));
          const search = await request(http)
            .get('/v1/community/search')
            .query({
              spaceId: scope.home.spaceId,
              q: 'Source Whale',
              type: 'all',
            })
            .set('Authorization', auth);
          assert.equal(search.status, 200, JSON.stringify(search.body));
          assert.ok(JSON.stringify(search.body).includes(sourcePost.id));
          const saved = await request(http)
            .put(`/v1/community/posts/${sourcePost.id}/save`)
            .set('Authorization', auth)
            .send({ clientRequestId: randomUUID() });
          assert.equal(saved.status, 200, JSON.stringify(saved.body));
          const savedRead = await request(http)
            .get('/v1/me/community/saved')
            .set('Authorization', auth);
          assert.equal(savedRead.status, 200, JSON.stringify(savedRead.body));
          assert.ok(JSON.stringify(savedRead.body).includes(sourcePost.id));
        },
      );
      await t.test(
        'text-only source admission never accepts image IDs, internal asset references or source hash claims',
        async () => {
          for (const delta of [
            { imageAssetIds: [randomUUID()] },
            {
              text: '![image](whaleu-asset:' + randomUUID() + ')',
              textSource: markdown,
            },
            { textSource: { ...plain, sourceHash: '0'.repeat(64) } },
            ...[
              '#1234567',
              '`#1234567`',
              '[label](https://example.test/#1234567)',
              '\\#1',
              '#1234567890',
            ].map((text) => ({ text, textSource: markdown })),
          ]) {
            const attempted = await call('/v1/community/reviews/posts', {
              ...body,
              ...delta,
              clientRequestId: randomUUID(),
            });
            assert.notEqual(attempted.body.status, 'pending');
            assert.notEqual(attempted.body.outcome, 'created');
          }
          const denied = await read(
            'post',
            sourcePost.id,
            'Bearer invalid-session',
          );
          assert.equal(denied.status, 401);
          assert.equal(Object.hasOwn(denied.body, 'text'), false);
        },
      );
      await t.test(
        'immutable source SQL rejects modifications, duplicate rows and detached metadata',
        async () => {
          for (const sql of [
            "UPDATE whaleu_community.community_text_sources SET source_hash=repeat('0',64) WHERE content_id=$1",
            "UPDATE whaleu_community.community_text_sources SET reading_formatting='off' WHERE content_id=$1",
            'DELETE FROM whaleu_community.community_text_sources WHERE content_id=$1',
            'INSERT INTO whaleu_community.community_text_sources SELECT * FROM whaleu_community.community_text_sources WHERE content_id=$1',
          ])
            await assert.rejects(
              inTransaction(pool, (tx) => tx.query(sql, [sourcePost.id])),
            );
          await assert.rejects(
            inTransaction(pool, (tx) =>
              tx.query('TRUNCATE whaleu_community.community_text_sources'),
            ),
          );
          const proof = (
            await pool.query<{
              exact: boolean;
              hash: boolean;
              original: boolean;
            }>(
              `SELECT
          whaleu_community.text_source_definition(s.content_kind,s.content_id,b.scope)=b.envelope exact,
          s.source_hash=whaleu_community.text_source_hash(s.source_format,p.text) hash,
          s.original_intent_hash=whaleu_community.text_source_intent_hash(b.envelope,s.requested_author_mode) original
          FROM whaleu_community.community_text_sources s JOIN whaleu_community.posts p ON p.id=s.content_id JOIN whaleu_community.content_approval_bindings b ON b.content_kind=s.content_kind AND b.content_id=s.content_id WHERE s.content_id=$1`,
              [sourcePost.id],
            )
          ).rows[0];
          assert.deepEqual(proof, { exact: true, hash: true, original: true });
        },
      );
      await t.test(
        'bilateral block current proof denies source without legacy fallback',
        async () => {
          const viewerAuth = `Bearer ${other.accessToken}`;
          assert.equal(
            (await read('post', sourcePost.id, viewerAuth)).status,
            200,
          );
          // Reading does not require a phone; the subsequent Safety mutation does.
          // Admit only that existing test-only owner fact, not campus affiliation.
          await setSyntheticSnapshot(pool, other.accountId, [
            syntheticAssertion(other.accountId, scope.institutionId, 'phone'),
          ]);
          const block = await request(http)
            .put('/v1/me/safety/blocks')
            .set('Authorization', viewerAuth)
            .send({
              clientRequestId: randomUUID(),
              source: { kind: 'post', id: sourcePost.id },
              blocked: true,
            });
          assert.equal(block.status, 200, JSON.stringify(block.body));
          const denied = await read('post', sourcePost.id, viewerAuth);
          assert.notEqual(denied.status, 200);
          assert.equal(Object.hasOwn(denied.body, 'text'), false);
          assert.equal(Object.hasOwn(denied.body, 'classification'), false);
        },
      );
      await t.test(
        'parent deletion and Review withdrawal revoke source while frozen receipt remains exact',
        async () => {
          const deleted = await request(http)
            .delete(`/v1/community/posts/${legacyPost.id}`)
            .set('Authorization', auth);
          assert.equal(deleted.status, 204, JSON.stringify(deleted.body));
          for (const [kind, id] of [
            ['post', legacyPost.id],
            ['comment', sourceChild.id],
            ['reply', legacyReply.id],
          ]) {
            const denied = await read(kind!, id!);
            assert.notEqual(denied.status, 200);
            assert.equal(Object.hasOwn(denied.body, 'text'), false);
            assert.equal(Object.hasOwn(denied.body, 'classification'), false);
          }
          await inTransaction(pool, (tx) =>
            operator.run(
              {
                command: 'withdraw',
                accountId: actor.accountId,
                requestId: body.clientRequestId,
                digest: sourcePost.digest,
                state: 'revoked',
                basis: 'Current source-authority regression',
              },
              tx,
            ),
          );
          for (const [kind, id] of [
            ['post', sourcePost.id],
            ['comment', plainChild.id],
            ['reply', sourceReply.id],
          ]) {
            const denied = await read(kind!, id!);
            assert.notEqual(denied.status, 200);
            assert.equal(Object.hasOwn(denied.body, 'text'), false);
          }
          assert.deepEqual(
            (await call('/v1/community/posts', body)).body,
            sourcePost.receipt,
          );
        },
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
