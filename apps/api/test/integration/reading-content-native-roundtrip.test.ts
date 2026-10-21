import { verifyReadingAncestorMedia } from '../support/reading-media-fixture.js';
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
  DatabaseService,
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
import {
  ReadingFormattingRuntime,
  decodeCandidate,
} from '../../src/community/reading-formatting/runtime.js';
import { formatSource } from '../../src/community/reading-formatting/formatter.js';
import {
  readingPostDetailSchema,
  readingCommentDetailSchema,
  readingReplyDetailSchema,
  readingCommentsPageSchema,
  readingRepliesPageSchema,
  readingContextSchema,
} from '../../src/community/reading-content/contracts.js';
import type { ReadingBody } from '../../src/community/reading-content/contracts.js';
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

/** Real Nest HTTP, real PostgreSQL/Review/current owner proofs and the actual
 * feature-only native gateway/decoders. Synthetic identity/scope fixtures only;
 * no production admission, WeChat provider or physical-device claim. */
test(
  'source-aware detail and threads: actual native roundtrip, mixed sources and final owner proof',
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
    let suite: PoolClient | undefined,
      app: INestApplication | undefined,
      owns = false,
      locked = false;
    try {
      suite = await pool.connect();
      locked = (
        await suite.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_lock($1,$2) locked',
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
      await runMigrations(
        pool,
        await readMigrations(
          fileURLToPath(new URL('../../migrations', import.meta.url)),
        ),
        { mode: 'up' },
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
        viewer = await createRuntimeActor(app);
      for (const account of [actor, viewer]) {
        const facts = await setRuntimeVerification(
          pool,
          account.accountId,
          scope.institutionId,
          scope.home.regionId,
        );
        await appendIdentitySelection(
          pool,
          account.accountId,
          facts,
          scope,
          scope.home.campusId,
        );
      }
      const auth = `Bearer ${actor.accessToken}`,
        viewerAuth = `Bearer ${viewer.accessToken}`;
      const operator = new TextReviewOperator(
        app.get(TextReviewRuntime),
        config.COMMUNITY_TEXT_REVIEW_OPERATOR!,
      );
      await inTransaction(pool, (tx) =>
        operator.run(
          {
            command: 'init-policy',
            basis: 'Disposable source-aware native acceptance only',
          },
          tx,
        ),
      );
      const policy = {
        postEnabled: true,
        commentEnabled: true,
        namedOnly: true as const,
        categories: ['discussion' as const],
        validForHours: 24,
        basis: 'Disposable single-region explicit review',
      };
      const preview = (await inTransaction(pool, (tx) =>
        operator.run({ command: 'preview-region', ...policy }, tx),
      )) as { currentRevision: number; previewDigest: string };
      await inTransaction(pool, (tx) =>
        operator.run(
          {
            command: 'apply-region',
            ...policy,
            expectedRevision: preview.currentRevision,
            previewDigest: preview.previewDigest,
          },
          tx,
        ),
      );
      await inTransaction(pool, (tx) =>
        operator.run(
          {
            command: 'init-source-policy',
            basis: 'Source proof fixture, not deployment authorization',
          },
          tx,
        ),
      );
      const call = (path: string, body: Record<string, unknown>) =>
        request(http).post(path).set('Authorization', auth).send(body);
      const read = (path: string, authorization = auth) =>
        request(http).get(path).set('Authorization', authorization);
      const decide = async (requestId: string) => {
        const digest = (
          await pool.query<{ digest: string }>(
            'SELECT digest FROM whaleu_community.text_review_requests WHERE account_id=$1 AND client_request_id=$2',
            [actor.accountId, requestId],
          )
        ).rows[0]!.digest;
        await inTransaction(pool, (tx) =>
          operator.run(
            {
              command: 'decide',
              accountId: actor.accountId,
              requestId,
              digest,
              decision: 'allow',
              basis:
                'Exact source and format manually approved in disposable fixture',
            },
            tx,
          ),
        );
        return digest;
      };
      const reviewed = async (path: string, body: Record<string, unknown>) => {
        const queued = await call(
          path.replace('/v1/community/', '/v1/community/reviews/'),
          body,
        );
        assert.equal(queued.status, 200, JSON.stringify(queued.body));
        assert.equal(queued.body.status, 'pending');
        const digest = await decide(body['clientRequestId'] as string);
        const made = await call(path, body);
        assert.equal(made.status, 201, JSON.stringify(made.body));
        assert.equal(made.body.outcome, 'created');
        return {
          id: made.body.resourceId as string,
          digest,
          receipt: made.body,
        };
      };
      const plain = {
        version: 1,
        format: 'plain',
        readingFormatting: 'auto',
      } as const;
      const markdown = { version: 1, format: 'markdown' } as const;
      const postInput = {
        clientRequestId: randomUUID(),
        spaceId: scope.home.spaceId,
        category: 'discussion',
        text: ('鲸'.repeat(119) + '。').repeat(3),
        imageAssetIds: [],
        authorMode: 'named',
        commentsPolicy: 'open',
        allowAnonymousDm: false,
        textSource: plain,
      };
      const sourcePost = await reviewed('/v1/community/posts', postInput);
      const { textSource: originalSource, ...legacyInput } = postInput;
      assert.equal(originalSource, plain);
      const legacyPost = await reviewed('/v1/community/posts', {
        ...legacyInput,
        clientRequestId: randomUUID(),
        text: '**literal legacy syntax, not Markdown**',
      });
      const childInput = {
        clientRequestId: randomUUID(),
        text: '## source root',
        imageAssetIds: [],
        authorMode: 'named',
        textSource: markdown,
      };
      const root = await reviewed(
        `/v1/community/posts/${sourcePost.id}/comments`,
        childInput,
      );
      const legacyRoot = await reviewed(
        `/v1/community/posts/${sourcePost.id}/comments`,
        {
          clientRequestId: randomUUID(),
          text: '**legacy root**',
          imageAssetIds: [],
          authorMode: 'named',
        },
      );
      const childOfLegacy = await reviewed(
        `/v1/community/posts/${legacyPost.id}/comments`,
        { ...childInput, clientRequestId: randomUUID() },
      );
      const sourceReply = await reviewed(
        `/v1/community/comments/${root.id}/replies`,
        {
          ...childInput,
          clientRequestId: randomUUID(),
          text: '**source reply**',
          targetReplyId: null,
        },
      );
      const legacyReply = await reviewed(
        `/v1/community/comments/${root.id}/replies`,
        {
          clientRequestId: randomUUID(),
          text: '**legacy reply**',
          imageAssetIds: [],
          authorMode: 'named',
          targetReplyId: sourceReply.id,
        },
      );
      const missingBody = (response: { status: number; body: object }) => {
        assert.notEqual(response.status, 200);
        for (const key of [
          'content',
          'body',
          'source',
          'presentation',
          'text',
          'items',
          'comment',
          'reply',
        ])
          assert.equal(Object.hasOwn(response.body, key), false, key);
      };
      await t.test(
        'actual child schema has no publication marker; exact immutable bindings carry each version',
        async () => {
          const columns = await pool.query<{ table_name: string }>(
            `SELECT table_name FROM information_schema.columns
             WHERE table_schema='whaleu_community'
             AND table_name IN ('posts','root_comments','replies')
             AND column_name='publication_envelope_version'`,
          );
          assert.deepEqual(columns.rows, [{ table_name: 'posts' }]);
          for (const [kind, id, version, postId, rootId] of [
            ['comment', root.id, 6, sourcePost.id, null],
            ['comment', legacyRoot.id, 1, sourcePost.id, null],
            ['comment', childOfLegacy.id, 6, legacyPost.id, null],
            ['reply', sourceReply.id, 6, sourcePost.id, root.id],
            ['reply', legacyReply.id, 1, sourcePost.id, root.id],
          ] as const) {
            const table = kind === 'comment' ? 'root_comments' : 'replies';
            const canonical = (
              await pool.query(
                `SELECT * FROM whaleu_community.${table} WHERE id=$1`,
                [id],
              )
            ).rows[0];
            assert.ok(canonical);
            assert.equal(
              Object.hasOwn(canonical, 'publication_envelope_version'),
              false,
            );
            const binding = (
              await pool.query(
                `SELECT * FROM whaleu_community.content_approval_bindings
               WHERE content_kind=$1 AND content_id=$2 AND content_version=1`,
                [kind, id],
              )
            ).rows[0];
            assert.ok(binding);
            assert.equal(binding.envelope_version, version);
            assert.equal(binding.envelope.version, version);
            assert.equal(binding.account_id, canonical.account_id);
            assert.equal(binding.envelope.accountId, canonical.account_id);
            assert.equal(binding.envelope.purpose, `publish_${kind}`);
            assert.equal(binding.envelope.text, canonical.text);
            assert.equal(binding.envelope.postId, postId);
            assert.equal(binding.envelope.rootCommentId, rootId);
            assert.equal(canonical.post_id, postId);
            if (kind === 'reply')
              assert.equal(canonical.root_comment_id, rootId);
          }
        },
      );
      await t.test(
        'all six routes preserve legacy DTOs and prove each mixed node independently',
        async () => {
          for (const [path, schema, classification] of [
            [
              `posts/${sourcePost.id}`,
              readingPostDetailSchema,
              'reviewedSource',
            ],
            [`posts/${legacyPost.id}`, readingPostDetailSchema, 'legacyPlain'],
            [
              `comments/${root.id}`,
              readingCommentDetailSchema,
              'reviewedSource',
            ],
            [
              `comments/${legacyRoot.id}`,
              readingCommentDetailSchema,
              'legacyPlain',
            ],
            [
              `comments/${childOfLegacy.id}`,
              readingCommentDetailSchema,
              'reviewedSource',
            ],
            [
              `replies/${sourceReply.id}`,
              readingReplyDetailSchema,
              'reviewedSource',
            ],
            [
              `replies/${legacyReply.id}`,
              readingReplyDetailSchema,
              'legacyPlain',
            ],
          ] as const) {
            const current = await read(`/v2/community/${path}`),
              old = await read(`/v1/community/${path}`);
            assert.equal(current.status, 200, JSON.stringify(current.body));
            assert.equal(old.status, 200, JSON.stringify(old.body));
            assert.equal(
              schema.safeParse(current.body).success,
              true,
              JSON.stringify(current.body),
            );
            assert.deepEqual(current.body.content, old.body);
            assert.equal(current.body.body.classification, classification);
            assert.equal(current.headers['cache-control'], 'no-store');
            assert.equal(current.headers['vary'], 'Authorization');
          }
          const rootRead = (await read(`/v2/community/comments/${root.id}`))
            .body;
          assert.deepEqual(
            rootRead.replyPreviewBodies.map((item: { id: string }) => item.id),
            rootRead.content.replyPreview.items.map(
              (item: { id: string }) => item.id,
            ),
          );
          assert.deepEqual(
            rootRead.replyPreviewBodies.map(
              (item: { body: ReadingBody }) => item.body.classification,
            ),
            ['reviewedSource', 'legacyPlain'],
          );
          for (const [path, schema] of [
            [
              `posts/${sourcePost.id}/comments?sort=time&order=asc&previewLimit=5`,
              readingCommentsPageSchema,
            ],
            [`comments/${root.id}/replies`, readingRepliesPageSchema],
            [
              `posts/${sourcePost.id}/discussion-context?replyId=${sourceReply.id}`,
              readingContextSchema,
            ],
          ] as const) {
            const response = await read(`/v2/community/${path}`);
            assert.equal(response.status, 200, JSON.stringify(response.body));
            assert.equal(
              schema.safeParse(response.body).success,
              true,
              JSON.stringify(response.body),
            );
          }
        },
      );
      await t.test(
        'explicit parent/root and continuation scopes cannot be substituted',
        async () => {
          for (const query of [
            `commentId=${root.id}`,
            `replyId=${sourceReply.id}`,
          ])
            missingBody(
              await read(
                `/v2/community/posts/${legacyPost.id}/discussion-context?${query}`,
              ),
            );
          const first = await read(
            `/v2/community/comments/${root.id}/replies?limit=1`,
          );
          assert.equal(first.status, 200, JSON.stringify(first.body));
          assert.ok(first.body.nextCursor);
          missingBody(
            await read(
              `/v2/community/comments/${legacyRoot.id}/replies?limit=1&cursor=${encodeURIComponent(first.body.nextCursor)}`,
            ),
          );
          const second = await read(
            `/v2/community/comments/${root.id}/replies?limit=1&cursor=${encodeURIComponent(first.body.nextCursor)}`,
          );
          assert.equal(second.status, 200, JSON.stringify(second.body));
          assert.equal(second.body.items[0].content.id, legacyReply.id);
          const roots = await read(
            `/v2/community/posts/${sourcePost.id}/comments?sort=time&order=asc&limit=1`,
          );
          assert.equal(roots.status, 200, JSON.stringify(roots.body));
          assert.ok(roots.body.nextCursor);
          missingBody(
            await read(
              `/v2/community/posts/${legacyPost.id}/comments?sort=time&order=asc&limit=1&cursor=${encodeURIComponent(roots.body.nextCursor)}`,
            ),
          );
        },
      );
      await t.test(
        'current viewSpace policy and guest behavior are exactly retained',
        async () => {
          for (const view of [
            scope.home.spaceId,
            scope.related.spaceId,
            scope.foreign.spaceId,
          ]) {
            const v1 = await read(
                `/v1/community/posts/${sourcePost.id}?viewSpaceId=${view}`,
              ),
              v2 = await read(
                `/v2/community/posts/${sourcePost.id}?viewSpaceId=${view}`,
              );
            assert.equal(
              v2.status,
              v1.status,
              JSON.stringify({ v1: v1.body, v2: v2.body }),
            );
            if (v1.status === 200) assert.deepEqual(v2.body.content, v1.body);
            else missingBody(v2);
          }
          const guest = await request(http).get(
            `/v2/community/posts/${legacyPost.id}`,
          );
          missingBody(guest);
          assert.equal(guest.status, 401);
          const guestFeed = await request(http).get(
            `/v1/community/posts?spaceId=${scope.home.spaceId}`,
          );
          assert.equal(guestFeed.status, 200, JSON.stringify(guestFeed.body));
        },
      );
      const runtime = app.get(ReadingFormattingRuntime);
      await t.test(
        'malformed formatter completion cannot corrupt source; optional final fence conflict falls back only to source',
        async () => {
          const candidate = (await runtime.candidates(null)).find((raw) => {
            const value = decodeCandidate(raw);
            return (
              value.job.success && value.job.data.content_id === sourcePost.id
            );
          });
          assert.ok(candidate);
          const claim = await runtime.claim(candidate);
          assert.ok(claim);
          const formatted = formatSource(claim.source);
          assert.equal(formatted.kind, 'plan');
          if (formatted.kind !== 'plan') throw new Error();
          await assert.rejects(
            runtime.complete(claim, {
              ...formatted.plan,
              spans: [{ start: 0, end: 1 }],
            }),
          );
          const unformatted = await read(
            `/v2/community/posts/${sourcePost.id}`,
          );
          assert.equal(
            unformatted.status,
            200,
            JSON.stringify(unformatted.body),
          );
          assert.equal(
            unformatted.body.body.value.presentation.status,
            'source',
          );
          assert.equal(await runtime.complete(claim, formatted.plan), true);
          assert.equal(
            (await read(`/v2/community/posts/${sourcePost.id}`)).body.body.value
              .presentation.status,
            'formatted',
          );
          const blocker = await pool.connect();
          try {
            await blocker.query('BEGIN');
            await blocker.query(
              'UPDATE whaleu_community.reading_format_results SET plan=plan WHERE false',
            );
            const fallback = await read(`/v2/community/posts/${sourcePost.id}`);
            assert.equal(fallback.status, 200, JSON.stringify(fallback.body));
            assert.equal(fallback.body.body.classification, 'reviewedSource');
            assert.equal(
              fallback.body.body.value.presentation.status,
              'source',
            );
            assert.equal(fallback.body.content.text, postInput.text);
          } finally {
            await blocker.query('ROLLBACK');
            blocker.release();
          }
          assert.equal(
            (await read(`/v2/community/posts/${sourcePost.id}`)).body.body.value
              .presentation.status,
            'formatted',
          );
        },
      );
      await t.test(
        'actual source binding/hash is immutable and cannot be forged into a legacy/source branch',
        async () => {
          await assert.rejects(
            inTransaction(pool, (tx) =>
              tx.query(
                "UPDATE whaleu_community.community_text_sources SET source_hash=repeat('0',64) WHERE content_kind='post' AND content_id=$1",
                [sourcePost.id],
              ),
            ),
          );
          await assert.rejects(
            inTransaction(pool, (tx) =>
              tx.query(
                'UPDATE whaleu_community.posts SET publication_envelope_version=1 WHERE id=$1',
                [sourcePost.id],
              ),
            ),
          );
          for (const [kind, id] of [
            ['comment', root.id],
            ['reply', sourceReply.id],
          ] as const) {
            const original = (
              await pool.query(
                `SELECT to_jsonb(b) value FROM whaleu_community.content_approval_bindings b
               WHERE content_kind=$1 AND content_id=$2 AND content_version=1`,
                [kind, id],
              )
            ).rows[0]!.value;
            for (const sql of [
              `DELETE FROM whaleu_community.content_approval_bindings WHERE content_kind=$1 AND content_id=$2`,
              `UPDATE whaleu_community.content_approval_bindings SET envelope_version=7 WHERE content_kind=$1 AND content_id=$2`,
              `UPDATE whaleu_community.content_approval_bindings SET envelope_version=1 WHERE content_kind=$1 AND content_id=$2`,
              `UPDATE whaleu_community.content_approval_bindings SET envelope=jsonb_set(envelope,'{postId}',to_jsonb($3::text)) WHERE content_kind=$1 AND content_id=$2`,
              ...(kind === 'reply'
                ? [
                    `UPDATE whaleu_community.content_approval_bindings SET envelope=jsonb_set(envelope,'{rootCommentId}',to_jsonb($3::text)) WHERE content_kind=$1 AND content_id=$2`,
                  ]
                : []),
            ]) {
              const values = sql.includes('$3')
                ? [kind, id, legacyPost.id]
                : [kind, id];
              await assert.rejects(
                inTransaction(pool, (tx) => tx.query(sql, values)),
              );
            }
            assert.deepEqual(
              (
                await pool.query(
                  `SELECT to_jsonb(b) value FROM whaleu_community.content_approval_bindings b
               WHERE content_kind=$1 AND content_id=$2 AND content_version=1`,
                  [kind, id],
                )
              ).rows[0]!.value,
              original,
            );
            const child = await read(
              `/v2/community/${kind === 'comment' ? 'comments' : 'replies'}/${id}`,
            );
            assert.equal(child.status, 200, JSON.stringify(child.body));
            assert.equal(child.body.body.classification, 'reviewedSource');
          }
          const response = await read(`/v2/community/posts/${sourcePost.id}`);
          assert.equal(response.status, 200, JSON.stringify(response.body));
          assert.equal(response.body.body.classification, 'reviewedSource');
        },
      );
      // Load the real feature-only native package at runtime, rather than importing
      // its bundler-specific module graph into the API TypeScript build.
      const native = new URL('../../../wechat/src/', import.meta.url);
      const { HttpReadingCommunityGateway } = await import(
        new URL('community/reading-gateway.ts', native).href
      );
      const { ReadingReadinessGateway } = await import(
        new URL('community/reading-readiness-gateway.ts', native).href
      );
      const readinessGateways = new Map<
        string,
        InstanceType<typeof ReadingReadinessGateway>
      >();
      const { ApiClient } = await import(new URL('api/client.ts', native).href);
      const { SessionStore } = await import(
        new URL('auth/session.ts', native).href
      );
      const { Cancellation } = await import(
        new URL('platform/contracts.ts', native).href
      );
      const sent: string[] = [];
      const nativeGateway = (account: typeof actor) => {
        const sessions = new SessionStore();
        sessions.completeLogin(sessions.beginLogin(), account);
        const transport = {
          send: async (input: {
            url: string;
            method: 'GET' | 'POST' | 'PUT' | 'DELETE';
            headers: Record<string, string>;
            body?: Record<string, unknown>;
          }) => {
            const target = new URL(input.url);
            sent.push(`${input.method} ${target.pathname}`);
            const client = request(http);
            const method = input.method.toLowerCase() as
              'get' | 'post' | 'put' | 'delete';
            let pending = client[method](target.pathname + target.search).set(
              input.headers,
            );
            if (input.body) pending = pending.send(input.body);
            const response = await pending;
            return {
              status: response.status,
              headers: response.headers,
              body: response.body,
            };
          },
        };
        const api = new ApiClient(
          'https://native-fixture.invalid',
          transport,
          sessions,
          {
            refresh: async () => {
              throw new Error('Fixture cannot refresh identity');
            },
          },
        );
        readinessGateways.set(
          account.accountId,
          new ReadingReadinessGateway(api),
        );
        return new HttpReadingCommunityGateway(api);
      };
      const gateway = nativeGateway(actor),
        viewerGateway = nativeGateway(viewer);
      await t.test(
        'actual native v2 capability observes installed schema without claiming a live worker or changing v1',
        async () => {
          for (const mode of ['named', 'anonymous'] as const) {
            const observed = await readinessGateways
              .get(actor.accountId)!
              .readingCapabilities(
                scope.home.spaceId,
                'discussion',
                mode,
                new Cancellation(),
              );
            const old = await gateway.textSourceCapabilities(
              scope.home.spaceId,
              'discussion',
              mode,
              new Cancellation(),
            );
            assert.equal(observed.version, 2);
            assert.equal(observed.authorMode, mode);
            assert.equal(observed.formatter.schema, 'installed');
            assert.equal(observed.formatter.worker.requestedMode, 'disabled');
            assert.equal(observed.formatter.worker.readiness, 'not_observed');
            assert.deepEqual(
              { ...observed, version: 1, formatter: 'not_configured' },
              old,
            );
          }
        },
      );
      await t.test(
        'actual native gateway publishes explicit source then decodes post/root/reply/context without endpoint guessing',
        async () => {
          const input = {
            ...postInput,
            clientRequestId: randomUUID(),
            text: '# Native source\nActual gateway',
            textSource: markdown,
          };
          const pending = {
            version: 1,
            accountId: actor.accountId,
            operation: 'publish_post',
            payload: input,
          };
          const submitted = await gateway.submitReview(
            pending,
            new Cancellation(),
          );
          assert.equal(submitted.status, 'pending');
          await decide(input.clientRequestId);
          const receipt = await gateway.publishPost(input, new Cancellation());
          assert.equal(receipt.outcome, 'created');
          const nativePost = await gateway.post(
            receipt.resourceId,
            new Cancellation(),
            scope.home.spaceId,
          );
          assert.equal(nativePost.readingBody.classification, 'reviewedSource');
          assert.equal(nativePost.text, input.text);
          const nativeLegacy = await gateway.post(
            legacyPost.id,
            new Cancellation(),
          );
          assert.equal(nativeLegacy.readingBody.classification, 'legacyPlain');
          const nativeRoot = await gateway.comment(root.id, new Cancellation());
          assert.equal(nativeRoot.readingBody.classification, 'reviewedSource');
          assert.equal(
            nativeRoot.replyPreview.items[0].readingBody.classification,
            'reviewedSource',
          );
          assert.equal(
            nativeRoot.replyPreview.items[1].readingBody.classification,
            'legacyPlain',
          );
          const nativeReply = await gateway.reply(
            sourceReply.id,
            new Cancellation(),
          );
          assert.equal(
            nativeReply.readingBody.value.source.rootCommentId,
            root.id,
          );
          const nativeComments = await gateway.comments(
            sourcePost.id,
            null,
            new Cancellation(),
            { sort: 'time', order: 'asc', previewLimit: 5 },
          );
          assert.ok(
            nativeComments.items.some(
              (item: { id: string }) => item.id === root.id,
            ),
          );
          const nativeReplies = await gateway.replies(
            root.id,
            null,
            new Cancellation(),
            1,
          );
          assert.equal(nativeReplies.items[0].id, sourceReply.id);
          assert.ok(nativeReplies.nextCursor);
          const next = await gateway.replies(
            root.id,
            nativeReplies.nextCursor,
            new Cancellation(),
            1,
          );
          assert.equal(next.items[0].id, legacyReply.id);
          const context = await gateway.discussionContext(
            sourcePost.id,
            { replyId: sourceReply.id },
            new Cancellation(),
          );
          assert.equal(context.comment.id, root.id);
          assert.equal(context.reply.id, sourceReply.id);
          await assert.rejects(
            gateway.discussionContext(
              legacyPost.id,
              { replyId: sourceReply.id },
              new Cancellation(),
            ),
          );
          assert.equal(
            sent.some((path) => path.includes('/text-sources/')),
            false,
          );
        },
      );
      await t.test(
        'mandatory Community/Campus proof survives optional formatting and rejects after lookup',
        async () => {
          const databaseService = app!.get(DatabaseService),
            original = databaseService.transaction.bind(databaseService);
          for (const mutation of [
            {
              sql: 'UPDATE whaleu_community.spaces SET is_active=false WHERE id=$1',
              id: scope.home.spaceId,
            },
            {
              sql: 'UPDATE whaleu_campus.operating_regions SET is_active=false WHERE id=$1',
              id: scope.home.regionId,
            },
          ]) {
            let injected = 0;
            databaseService.transaction = (operation, options) =>
              original(async (tx) => {
                const result = await operation(tx);
                if (
                  typeof result === 'object' &&
                  result !== null &&
                  'content' in result &&
                  (result as { content?: { id?: string } }).content?.id ===
                    sourcePost.id
                ) {
                  injected++;
                  await tx.query(mutation.sql, [mutation.id]);
                }
                return result;
              }, options);
            try {
              const denied = await read(`/v2/community/posts/${sourcePost.id}`);
              assert.equal(injected, 1);
              assert.equal(denied.status, 503, JSON.stringify(denied.body));
              missingBody(denied);
            } finally {
              databaseService.transaction = original;
            }
            const restored = await read(`/v2/community/posts/${sourcePost.id}`);
            assert.equal(restored.status, 200, JSON.stringify(restored.body));
          }
        },
      );
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
        'source-aware descendant envelopes retain real ancestor Media revocation, expiry and final proofs',
        async () => {
          await verifyReadingAncestorMedia({
            pool,
            config,
            actor,
            scope,
            decide,
            rawComplete,
            sourceAware: true,
          });
        },
      );
      await t.test(
        'current Safety and account/session denial clears native result, never retries v1',
        async () => {
          const block = await request(http)
            .put('/v1/me/safety/blocks')
            .set('Authorization', viewerAuth)
            .send({
              clientRequestId: randomUUID(),
              source: { kind: 'post', id: sourcePost.id },
              blocked: true,
            });
          assert.equal(block.status, 200, JSON.stringify(block.body));
          const before = sent.length;
          await assert.rejects(
            viewerGateway.post(sourcePost.id, new Cancellation()),
          );
          await assert.rejects(
            viewerGateway.comment(root.id, new Cancellation()),
          );
          await assert.rejects(
            viewerGateway.reply(sourceReply.id, new Cancellation()),
          );
          assert.ok(
            sent
              .slice(before)
              .every((path) => path.startsWith('GET /v2/community/')),
          );
          const unblock = await request(http)
            .put(`/v1/me/safety/blocks/${block.body.current.relationshipId}`)
            .set('Authorization', viewerAuth)
            .send({
              clientRequestId: randomUUID(),
              blocked: false,
              expectedRevision: block.body.current.revision,
            });
          assert.equal(unblock.status, 200, JSON.stringify(unblock.body));
          await withCommunityScopeWriter(pool, (tx) =>
            tx.query(
              "UPDATE whaleu_identity.accounts SET status='blocked' WHERE id=$1",
              [viewer.accountId],
            ),
          );
          try {
            await assert.rejects(
              viewerGateway.post(sourcePost.id, new Cancellation()),
            );
          } finally {
            await withCommunityScopeWriter(pool, (tx) =>
              tx.query(
                "UPDATE whaleu_identity.accounts SET status='active' WHERE id=$1",
                [viewer.accountId],
              ),
            );
          }
          await pool.query(
            "UPDATE whaleu_identity.sessions SET revoked_at=clock_timestamp(),revoke_reason='logout' WHERE id=$1",
            [viewer.sessionId],
          );
          missingBody(
            await read(`/v2/community/posts/${sourcePost.id}`, viewerAuth),
          );
          await assert.rejects(
            viewerGateway.post(sourcePost.id, new Cancellation()),
          );
        },
      );
      await t.test(
        'parent deletion and Review withdrawal deny entire source/thread projection with no legacy fallback',
        async () => {
          const deleted = await request(http)
            .delete(`/v1/community/posts/${legacyPost.id}`)
            .set('Authorization', auth);
          assert.equal(deleted.status, 204, JSON.stringify(deleted.body));
          missingBody(await read(`/v2/community/comments/${childOfLegacy.id}`));
          await assert.rejects(
            gateway.comment(childOfLegacy.id, new Cancellation()),
          );
          await inTransaction(pool, (tx) =>
            operator.run(
              {
                command: 'withdraw',
                accountId: actor.accountId,
                requestId: postInput.clientRequestId,
                digest: sourcePost.digest,
                state: 'revoked',
                basis: 'Explicit current canonical Review denial fixture',
              },
              tx,
            ),
          );
          for (const path of [
            `posts/${sourcePost.id}`,
            `comments/${root.id}`,
            `replies/${sourceReply.id}`,
            `comments/${root.id}/replies`,
            `posts/${sourcePost.id}/comments`,
          ])
            missingBody(await read(`/v2/community/${path}`));
          await assert.rejects(gateway.post(sourcePost.id, new Cancellation()));
          await assert.rejects(
            gateway.reply(sourceReply.id, new Cancellation()),
          );
          assert.deepEqual(
            (await call('/v1/community/posts', postInput)).body,
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
