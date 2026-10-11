/** Disposable PostgreSQL + real native controllers/HTTP; only external media
 * storage/reviewer and canonical identity facts use explicit test fixtures. */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import sharp from 'sharp';
import { APP_CONFIG, loadConfig } from '../../src/config/config.js';
import { inTransaction } from '../../src/database/database.js';
import { TextReviewRuntime } from '../../src/community/text-review/runtime.js';
import { TextReviewOperator } from '../../src/community/text-review/operator.js';
import { syntheticMediaRuntimeFixture } from '../support/media/runtime-fixture.js';
import { readyBatch, responseOk } from '../support/media/batch-fixture.js';
import { sha256 } from '../../src/media/processing/protocol.js';
import { publicationHash } from '../../src/community/publication.repository.js';
import { postIntent } from '../../src/community/publication-intent.js';
import { publishPostSchema } from '../../src/community/contracts.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import type { SearchPage } from '../../src/community/search/contracts.js';
const checkpoint = (child: ChildProcess, expected: string) =>
  new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(Error(`Native feedback timeout: ${expected}`));
    }, 45000);
    const cleanup = () => {
      clearTimeout(timer);
      child.off('message', message);
      child.off('exit', exit);
    };
    const message = (v: unknown) => {
      if (typeof v !== 'object' || v === null) return;
      const result = v as Record<string, unknown>;
      if (result['event'] === 'failure') {
        cleanup();
        reject(Error(String(result['message'])));
      } else if (result['event'] === expected) {
        cleanup();
        resolve(result);
      }
    };
    const exit = (code: number | null) => {
      cleanup();
      reject(Error(`Native feedback exited ${code} before ${expected}`));
    };
    child.on('message', message);
    child.on('exit', exit);
  });
test(
  'public feedback exact Review, native same-key recovery, Media9 and local super-admin notices',
  { timeout: 240000 },
  async (t) => {
    const feedbackSpaceId = randomUUID();
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: process.env['TEST_DATABASE_URL'],
      PG_SSL_MODE: 'disable',
      LOG_LEVEL: 'silent',
      COMMUNITY_TEXT_REVIEW: 'local_manual',
      COMMUNITY_TEXT_REVIEW_SPACE_ID: randomUUID(),
      COMMUNITY_TEXT_REVIEW_REGION_ID: randomUUID(),
      COMMUNITY_TEXT_REVIEW_POLICY_ID: randomUUID(),
      COMMUNITY_TEXT_REVIEW_OPERATOR: 'local:test:feedback',
      COMMUNITY_FEEDBACK_SPACE_ID: feedbackSpaceId,
    });
    const bytes = await sharp({
      create: {
        width: 64,
        height: 64,
        channels: 3,
        background: { r: 25, g: 130, b: 170 },
      },
    })
      .png()
      .toBuffer();
    const f = await syntheticMediaRuntimeFixture(
      [{ sha256: sha256(bytes), verdict: 'allow' }],
      {
        configureTestModule: (builder) => {
          builder.overrideProvider(APP_CONFIG).useValue(config);
        },
      },
    );
    let child: ChildProcess | undefined;
    try {
      const actor = await f.actor(),
        admin = await f.actor(),
        developer = await f.actor(),
        school = await f.actor();
      const http = f.app.getHttpServer();
      const auth = `Bearer ${actor.accessToken}`,
        adminAuth = `Bearer ${admin.accessToken}`;
      await withCommunityScopeWriter(f.pool, async (tx) => {
        await tx.query(
          "INSERT INTO whaleu_community.spaces(id,kind,name,is_active) VALUES($1,'global','Synthetic public feedback',true)",
          [feedbackSpaceId],
        );
        for (const [account, role, region] of [
          [admin.accountId, 'super_admin', null],
          [developer.accountId, 'developer', null],
          [school.accountId, 'school_admin', f.scope.home.regionId],
        ] as const)
          await tx.query(
            "INSERT INTO whaleu_authorization.role_grants(id,account_id,role,operating_region_id,approved_by_account_id,approval_reference) VALUES($1,$2,$3,$4,$2,'synthetic-feedback-only')",
            [randomUUID(), account, role, region],
          );
      });
      const operator = new TextReviewOperator(
        f.app.get(TextReviewRuntime),
        config.COMMUNITY_TEXT_REVIEW_OPERATOR!,
      );
      for (const command of ['init-policy', 'init-feedback'] as const)
        await inTransaction(f.pool, (tx) =>
          operator.run(
            { command, basis: 'Disposable explicit feedback acceptance' },
            tx,
          ),
        );
      const decide = async (
        requestId: string,
        accountId = actor.accountId,
        decision: 'allow' | 'reject' = 'allow',
      ) => {
        const row = (
          await f.pool.query<{ digest: string; envelope: unknown }>(
            'SELECT digest,envelope FROM whaleu_community.text_review_requests WHERE account_id=$1 AND client_request_id=$2',
            [accountId, requestId],
          )
        ).rows[0];
        assert.ok(row);
        await inTransaction(f.pool, (tx) =>
          operator.run(
            {
              command: 'decide',
              accountId,
              requestId,
              digest: row.digest,
              decision,
              basis:
                'Explicit exact synthetic feedback text/contact/image digest review',
            },
            tx,
          ),
        );
        return row;
      };
      let nativePostId = '',
        nativeRequestId = '',
        nativeDigest = '',
        mediaPostId = '',
        nativeCommentId = '';
      await t.test(
        'real native anonymous compose -> pending -> reloaded same-key publication -> public feed/contact/detail and local notice navigation',
        async () => {
          child = fork(
            fileURLToPath(
              new URL(
                '../support/community-feedback-native-worker.mjs',
                import.meta.url,
              ),
            ),
            [],
            {
              execArgv: ['--import', 'tsx'],
              stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
            },
          );
          child.stderr?.resume();
          const exited = new Promise<number | null>((resolve) =>
            child!.once('exit', resolve),
          );
          const pending = checkpoint(child, 'pending');
          child.send({
            port: Number(new URL(await f.app.getUrl()).port),
            credentials: actor,
            adminCredentials: admin,
            spaceId: feedbackSpaceId,
          });
          const message = await pending;
          assert.equal(typeof message['requestId'], 'string');
          const reviewed = await decide(String(message['requestId']));
          assert.equal((reviewed.envelope as { version: number }).version, 3);
          nativeRequestId = String(message['requestId']);
          nativeDigest = reviewed.digest;
          const done = checkpoint(child, 'done');
          child.send({ event: 'approved' });
          const result = await done;
          nativePostId = String(result['resourceId']);
          assert.equal(result['requestId'], message['requestId']);
          assert.equal(result['issued'], 1);
          assert.equal(await exited, 0);
          child = undefined;
        },
      );
      await t.test(
        'raw inputs cannot impersonate feedback in another global/region, drop contacts or bypass Review',
        async () => {
          const body = publishPostSchema.parse({
            clientRequestId: randomUUID(),
            spaceId: feedbackSpaceId,
            category: 'feedback',
            text: 'Needs exact explicit review',
            authorMode: 'named',
            feedback: { contacts: { wechat: '', qq: '', phone: '' } },
          });
          responseOk(
            await request(http)
              .post('/v1/community/posts')
              .set('Authorization', auth)
              .send(body),
            503,
          );
          for (const spaceId of [
            f.scope.global.spaceId,
            f.scope.home.spaceId,
          ]) {
            for (const route of [
              '/v1/community/reviews/posts',
              '/v1/community/posts',
            ]) {
              const r = await request(http)
                .post(route)
                .set('Authorization', auth)
                .send({ ...body, clientRequestId: randomUUID(), spaceId });
              if (route === '/v1/community/reviews/posts') {
                responseOk(r, 409);
                assert.equal(r.body.error.code, 'COMMUNITY_SCOPE_UNAVAILABLE');
              } else {
                responseOk(r, 201);
                assert.equal(r.body.outcome, 'rejected');
                assert.equal(r.body.code, 'COMMUNITY_SCOPE_UNAVAILABLE');
              }
            }
          }
          responseOk(
            await request(http)
              .post('/v1/community/reviews/posts')
              .set('Authorization', auth)
              .send({ ...body, feedback: undefined }),
            400,
          );
          responseOk(
            await request(http).get(
              `/v1/community/feedback/posts/${nativePostId}/contacts`,
            ),
            401,
          );
          responseOk(
            await request(http)
              .get('/v1/me/feedback-notices')
              .set('Authorization', `Bearer ${developer.accessToken}`),
            403,
          );
          responseOk(
            await request(http)
              .get('/v1/me/feedback-notices')
              .set('Authorization', `Bearer ${school.accessToken}`),
            403,
          );
        },
      );
      await t.test(
        'nine real decoded/reviewed images use existing Media batch and exact queue, ordered assets survive receipt replay',
        async () => {
          const batchFixture = {
            ...f,
            scope: {
              ...f.scope,
              home: { ...f.scope.home, spaceId: feedbackSpaceId },
            },
          };
          const ready = await readyBatch(batchFixture, actor, 9, [
            { mime: 'image/png', bytes },
          ]);
          if (ready.status.status !== 'ready_unbound')
            throw new Error('Nine image batch is not ready');
          const body = publishPostSchema.parse({
            clientRequestId: randomUUID(),
            spaceId: feedbackSpaceId,
            category: 'feedback',
            text: 'Nine exact feedback pictures',
            authorMode: 'named',
            imageAssetIds: ready.status.orderedAssets.map((a) => a.assetId),
            feedback: {
              contacts: { wechat: 'exact-contact', qq: '123456', phone: '' },
            },
          });
          const publication = {
            clientRequestId: body.clientRequestId,
            operation: 'publish_post',
            intentHash: publicationHash('publish_post', postIntent(body)),
          };
          responseOk(
            await request(http)
              .post(`/v3/media/batches/${ready.status.batchId}/seal`)
              .set('Authorization', auth)
              .send({
                commandId: randomUUID(),
                expectedRevision: ready.status.revision,
                orderedMemberIds: ready.status.orderedMemberIds,
                publication,
              }),
          );
          const submitted = await request(http)
            .post('/v1/community/reviews/posts')
            .set('Authorization', auth)
            .send(body);
          responseOk(submitted);
          assert.equal(submitted.body.status, 'pending');
          const row = await decide(body.clientRequestId);
          assert.equal(
            (row.envelope as { images: unknown[] }).images.length,
            9,
          );
          const changed = await request(http)
            .post('/v1/community/posts')
            .set('Authorization', auth)
            .send({
              ...body,
              feedback: {
                contacts: { wechat: 'changed', qq: '123456', phone: '' },
              },
            });
          responseOk(changed, 409);
          const published = await request(http)
            .post('/v1/community/posts')
            .set('Authorization', auth)
            .send(body);
          responseOk(published, 201);
          assert.equal(published.body.outcome, 'created');
          mediaPostId = published.body.resourceId as string;
          const replay = await request(http)
            .post('/v1/community/posts')
            .set('Authorization', auth)
            .send(body);
          responseOk(replay, 201);
          assert.deepEqual(replay.body, published.body);
          const detail = await request(http)
            .get(`/v1/community/posts/${published.body.resourceId}`)
            .set('Authorization', auth);
          responseOk(detail);
          assert.deepEqual(
            detail.body.images.map((a: { assetId: string }) => a.assetId),
            body.imageAssetIds,
          );
          assert.equal(
            detail.body.feedback.authorSchool,
            'Synthetic community institution',
          );
          assert.equal(
            JSON.stringify(detail.body).includes('exact-contact'),
            false,
          );
          const counts = await f.pool.query<{ n: number }>(
            'SELECT count(*)::integer n FROM whaleu_notifications.feedback_notices WHERE post_id=$1',
            [published.body.resourceId],
          );
          assert.equal(counts.rows[0]!.n, 1);
        },
      );
      await t.test(
        'anonymous author comments retain persona, reject contact mutation, and cancelled original request remains fenced',
        async () => {
          const body = {
            clientRequestId: randomUUID(),
            text: 'Anonymous author follow-up',
            imageAssetIds: [],
            authorMode: 'named',
          };
          const route = `/v1/community/posts/${nativePostId}/comments`;
          const queued = await request(http)
            .post(`/v1/community/reviews/posts/${nativePostId}/comments`)
            .set('Authorization', auth)
            .send(body);
          responseOk(queued);
          const reviewed = await decide(body.clientRequestId);
          assert.equal(
            (reviewed.envelope as { authorMode: string }).authorMode,
            'anonymous',
          );
          const published = await request(http)
            .post(route)
            .set('Authorization', auth)
            .send(body);
          responseOk(published, 201);
          assert.equal(published.body.outcome, 'created');
          nativeCommentId = published.body.resourceId as string;
          const cancelBody = publishPostSchema.parse({
            clientRequestId: randomUUID(),
            spaceId: feedbackSpaceId,
            category: 'feedback',
            text: 'Cancelled exact feedback',
            authorMode: 'anonymous',
            feedback: {
              contacts: { wechat: 'do-not-drop', qq: '', phone: '' },
            },
          });
          responseOk(
            await request(http)
              .post('/v1/community/reviews/posts')
              .set('Authorization', auth)
              .send(cancelBody),
          );
          responseOk(
            await request(http)
              .post(
                `/v1/community/reviews/requests/${cancelBody.clientRequestId}/cancel`,
              )
              .set('Authorization', auth)
              .send({
                operation: 'publish_post',
                intentHash: publicationHash(
                  'publish_post',
                  postIntent(cancelBody),
                ),
              }),
          );
          responseOk(
            await request(http)
              .post('/v1/community/posts')
              .set('Authorization', auth)
              .send(cancelBody),
            409,
          );
          await assert.rejects(
            f.pool.query(
              "UPDATE whaleu_community.posts SET feedback=jsonb_set(feedback,'{contacts,wechat}','\"tampered\"') WHERE id=$1",
              [nativePostId],
            ),
          );
        },
      );
      await t.test(
        'explicit and federated search include exact v3 global feedback, exclude contacts and recheck parent Review',
        async () => {
          const bindings = await f.pool.query<{
            id: string;
            publication_envelope_version: number;
            envelope_version: number;
            matches: boolean;
          }>(
            `SELECT p.id,p.publication_envelope_version,b.envelope_version,
              b.envelope->'feedback'=p.feedback AS matches
             FROM whaleu_community.posts p
             JOIN whaleu_community.content_approval_bindings b
               ON b.content_kind='post' AND b.content_id=p.id
             JOIN whaleu_community.feedback_topic t
               ON t.space_id=p.space_id AND t.provenance='accepted'
             WHERE p.id=ANY($1::uuid[]) AND p.category='feedback'`,
            [[nativePostId, mediaPostId]],
          );
          assert.equal(bindings.rows.length, 2);
          for (const binding of bindings.rows) {
            assert.equal(binding.publication_envelope_version, 3);
            assert.equal(binding.envelope_version, 3);
            assert.equal(binding.matches, true);
          }
          const search = async (
            query: Record<string, unknown>,
            authenticated = true,
          ): Promise<SearchPage> => {
            const call = request(http)
              .get('/v1/community/search')
              .query({ q: 'feedback', type: 'post', ...query });
            const result = await (authenticated
              ? call.set('Authorization', adminAuth)
              : call);
            responseOk(result);
            for (const contact of ['native-contact', 'exact-contact'])
              assert.equal(
                JSON.stringify(result.body).includes(contact),
                false,
              );
            assert.equal(
              JSON.stringify(result.body).includes('"123456"'),
              false,
            );
            assert.equal(
              JSON.stringify(result.body).includes(actor.accountId),
              false,
            );
            return result.body as SearchPage;
          };
          const selectors = [
            { spaceId: feedbackSpaceId },
            { spaceId: feedbackSpaceId, category: 'feedback' },
            { scope: 'all' },
            { scope: 'global' },
          ];
          for (const selector of selectors) {
            for (const authenticated of [true, false]) {
              const page = await search(selector, authenticated);
              assert.deepEqual(
                new Set(page.items.map((item) => item.contentId)),
                new Set([nativePostId, mediaPostId]),
              );
              assert.deepEqual(page.effectiveTypes, ['post']);
              assert.equal(page.continuation, 'end');
              assert.equal(page.nextCursor, null);
              for (const item of page.items) {
                assert.equal(item.space.id, feedbackSpaceId);
                assert.equal(item.space.kind, 'global');
                assert.equal(item.category, 'feedback');
                assert.equal(
                  item.author.kind,
                  item.contentId === nativePostId ? 'anonymous' : 'named',
                );
              }
            }
            for (const q of ['native-contact', 'exact-contact', '123456'])
              assert.deepEqual((await search({ ...selector, q })).items, []);
          }
          for (const selector of [
            { scope: 'regional' },
            { spaceId: f.scope.home.spaceId },
            { spaceId: f.scope.global.spaceId, category: 'feedback' },
            { spaceId: feedbackSpaceId, category: 'discussion' },
          ])
            assert.deepEqual((await search(selector)).items, []);
          for (const selector of selectors) {
            const page = await search({
              ...selector,
              type: 'comment',
              postId: nativePostId,
              q: 'Anonymous author follow-up',
            });
            assert.deepEqual(
              page.items.map((item) => item.contentId),
              [nativeCommentId],
            );
            assert.equal(page.items[0]!.author.kind, 'anonymous');
          }
          await inTransaction(f.pool, (tx) =>
            operator.run(
              {
                command: 'withdraw',
                accountId: actor.accountId,
                requestId: nativeRequestId,
                digest: nativeDigest,
                state: 'revoked',
                basis: 'Search must recheck exact feedback parent Review',
              },
              tx,
            ),
          );
          for (const selector of selectors) {
            const page = await search(selector);
            assert.deepEqual(
              page.items.map((item) => item.contentId),
              [mediaPostId],
            );
            assert.deepEqual(
              (
                await search({
                  ...selector,
                  type: 'comment',
                  postId: nativePostId,
                  q: 'Anonymous author follow-up',
                })
              ).items,
              [],
              'A currently denied feedback parent hides its otherwise reviewed child',
            );
          }
        },
      );
      await t.test(
        'revoking actual super-admin grants closes notice access without changing immutable history',
        async () => {
          await withCommunityScopeWriter(f.pool, (tx) =>
            tx.query(
              "UPDATE whaleu_authorization.role_grants SET revoked_at=clock_timestamp(),revoked_by_account_id=account_id WHERE account_id=$1 AND role='super_admin'",
              [admin.accountId],
            ),
          );
          responseOk(
            await request(http)
              .get('/v1/me/feedback-notices')
              .set('Authorization', adminAuth),
            403,
          );
        },
      );
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>((resolve) =>
          child!.once('exit', () => resolve()),
        );
        child.kill('SIGKILL');
        await exited;
      }
      await f.close();
    }
  },
);
