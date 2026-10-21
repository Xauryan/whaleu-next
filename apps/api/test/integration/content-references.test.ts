/** Disposable local synthetic AppModule acceptance only. No real legacy IDs,
 * provider, production initialization or production coverage is asserted. */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import request from 'supertest';
import sharp from 'sharp';
import { sha256 } from '../../src/media/processing/protocol.js';
import { CommunityRepository } from '../../src/community/community.repository.js';
import { inTransaction } from '../../src/database/database.js';
import { ApplicationError } from '../../src/http/application-error.js';
import { ContentReferenceAllocation } from '../../src/community/content-references/allocation.js';
import { ContentReferenceRepository } from '../../src/community/content-references/repository.js';
import { syntheticMediaRuntimeFixture } from '../support/media/runtime-fixture.js';
import {
  approveEnvelope,
  seedReviewPolicy,
} from '../support/community-approval-fixtures.js';
import {
  discussionApprovalEnvelope,
  postApprovalEnvelope,
} from '../support/community-runtime-fixtures.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import type { ReferenceTarget } from '../../src/community/content-references/contracts.js';

const ok = (response: { status: number; body: unknown }, expected = 200) =>
  assert.equal(response.status, expected, JSON.stringify(response.body));

test(
  'permanent references: real publication atomicity, namespaces, current privacy, rate limits and rollback',
  { timeout: 360000 },
  async (t) => {
    const bytes = await sharp({
      create: { width: 48, height: 48, channels: 3, background: '#385878' },
    })
      .png()
      .toBuffer();
    const f = await syntheticMediaRuntimeFixture([
      { sha256: sha256(bytes), verdict: 'allow' },
    ]);
    t.after(() => f.close());
    await seedReviewPolicy(f.pool);
    const owner = await f.actor(),
      reader = await f.actor(),
      admin = await f.actor();
    const http = f.app.getHttpServer(),
      allocation = f.app.get(ContentReferenceAllocation),
      references = f.app.get(ContentReferenceRepository);
    const auth = (actor = reader) => `Bearer ${actor.accessToken}`;
    const root = '/v1/community/content-references';
    const get = (path: string, actor = reader) =>
      request(http).get(path).set('Authorization', auth(actor));
    const resolve = (code: string, actor = reader, viewSpaceId?: string) =>
      request(http)
        .post(`${root}/resolve`)
        .set('Authorization', auth(actor))
        .send({ code, ...(viewSpaceId ? { viewSpaceId } : {}) });
    const lookup = (targets: ReferenceTarget[], actor = reader) =>
      request(http)
        .post(`${root}/lookup`)
        .set('Authorization', auth(actor))
        .send({ targets });
    const preparePost = async (
      text: string,
      authorMode: 'named' | 'anonymous' = 'named',
      images: { assetId: string; digest: string }[] = [],
    ) => {
      const body = {
        clientRequestId: randomUUID(),
        spaceId: f.scope.home.spaceId,
        category: 'discussion' as const,
        text,
        authorMode,
        imageAssetIds: images.map((image) => image.assetId),
        commentsPolicy: 'open' as const,
      };
      const envelope = await postApprovalEnvelope(
        f.app,
        f.pool,
        owner.accountId,
        body,
      );
      await approveEnvelope(
        f.pool,
        images.length ? { ...envelope, images } : envelope,
      );
      return body;
    };
    const sendPost = (body: Awaited<ReturnType<typeof preparePost>>) =>
      request(http)
        .post('/v1/community/posts')
        .set('Authorization', auth(owner))
        .send(body);
    const publish = async (
      text: string,
      mode: 'named' | 'anonymous' = 'named',
    ) => {
      const body = await preparePost(text, mode),
        response = await sendPost(body);
      ok(response, 201);
      assert.equal(response.body.outcome, 'created');
      return {
        body,
        receipt: response.body,
        id: response.body.resourceId as string,
      };
    };
    const codeFor = (kind: ReferenceTarget['kind'], targetId: string) =>
      inTransaction(f.pool, (tx) =>
        references.canonical({ kind, targetId }, tx),
      );
    const counters = async () =>
      (
        await f.pool.query(
          'SELECT name,next_code::text FROM whaleu_community.content_reference_sequences ORDER BY name',
        )
      ).rows;
    const counts = async () =>
      (
        await f.pool.query(`SELECT
    (SELECT count(*)::int FROM whaleu_community.posts) posts,
    (SELECT count(*)::int FROM whaleu_community.root_comments) comments,
    (SELECT count(*)::int FROM whaleu_community.replies) replies,
    (SELECT count(*)::int FROM whaleu_community.outbox) events,
    (SELECT count(*)::int FROM whaleu_community.post_images) post_images,
    (SELECT count(*)::int FROM whaleu_media.bindings) media_bindings,
    (SELECT count(*)::int FROM whaleu_community.content_approval_bindings) review_bindings,
    (SELECT count(*)::int FROM whaleu_community.content_reference_reservations) reservations,
    (SELECT count(*)::int FROM whaleu_community.content_reference_canonicals) canonicals`)
      ).rows[0];

    const baseline = await publish(
      'synthetic inactive permanent reference baseline',
    );
    await t.test(
      'inactive schema does not block publication and legacy receipts stay unchanged',
      async () => {
        const capability = await get(`${root}/capability`);
        ok(capability);
        assert.deepEqual(capability.body, { available: false });
        assert.equal(await codeFor('post', baseline.id), null);
        ok(await resolve('1234567'), 503);
        const retry = await sendPost(baseline.body);
        ok(retry, 201);
        assert.deepEqual(retry.body, baseline.receipt);
        assert.equal((await counts()).reservations, 0);
        ok(await request(http).get(`${root}/capability`), 401);
      },
    );

    // This is test-only SQL on a fixture which asserts disposable loopback DB.
    // The runtime contains no initialization/import route or operator command.
    const orphan = randomUUID();
    await inTransaction(f.pool, async (tx) => {
      await tx.query(
        "UPDATE whaleu_community.content_reference_policy SET state='allocating',initialization_id=$1,source_kind='synthetic',historical_cutoff=0 WHERE singleton",
        [randomUUID()],
      );
      await tx.query(
        "INSERT INTO whaleu_community.content_reference_reservations(code,target_kind,target_id) VALUES('10000000','comment',$1),('100000000','reply',$1),('1234567','post',$2)",
        [orphan, baseline.id],
      );
    });
    await t.test(
      'allocation readiness differs from public readiness and preexisting receipt replay never backfills',
      async () => {
        const retry = await sendPost(baseline.body);
        ok(retry, 201);
        assert.deepEqual(retry.body, baseline.receipt);
        assert.equal(await codeFor('post', baseline.id), null);
        assert.deepEqual((await get(`${root}/capability`)).body, {
          available: false,
        });
        const mapped = await inTransaction(f.pool, (tx) =>
          allocation.allocateForPublication(
            { kind: 'post', targetId: baseline.id },
            tx,
          ),
        );
        assert.deepEqual(mapped, { state: 'allocated', code: '10000001' });
        // Alias collision with a different kind is globally occupied, not inferred
        // from its width. Prior 7-digit alias remains bound to this baseline UUID.
        assert.equal(await codeFor('post', baseline.id), '10000001');
        ok(await resolve('1234567'), 503);
        await assert.rejects(
          f.pool.query(
            'UPDATE whaleu_community.content_reference_policy SET historical_cutoff=1 WHERE singleton',
          ),
          { code: '23514' },
        );
        await assert.rejects(
          f.pool.query(
            "UPDATE whaleu_community.content_reference_policy SET source_kind='production' WHERE singleton",
          ),
        );
      },
    );
    const post = await publish('synthetic allocated post');
    const commentBody = {
      clientRequestId: randomUUID(),
      text: 'synthetic root',
      imageAssetIds: [],
      authorMode: 'named' as const,
    };
    await approveEnvelope(
      f.pool,
      await discussionApprovalEnvelope(
        f.app,
        f.pool,
        owner.accountId,
        post.id,
        commentBody,
      ),
    );
    const commentPath = `/v1/community/posts/${post.id}/comments`;
    const commentResponse = await request(http)
      .post(commentPath)
      .set('Authorization', auth(owner))
      .send(commentBody);
    ok(commentResponse, 201);
    const commentId = commentResponse.body.resourceId as string;
    const replyBody = {
      ...commentBody,
      clientRequestId: randomUUID(),
      text: 'synthetic reply',
      targetReplyId: null,
    };
    await approveEnvelope(
      f.pool,
      await discussionApprovalEnvelope(
        f.app,
        f.pool,
        owner.accountId,
        post.id,
        replyBody,
        commentId,
      ),
    );
    const replyPath = `/v1/community/comments/${commentId}/replies`;
    const replyResponse = await request(http)
      .post(replyPath)
      .set('Authorization', auth(owner))
      .send(replyBody);
    ok(replyResponse, 201);
    const replyId = replyResponse.body.resourceId as string;
    const postCode = (await codeFor('post', post.id))!,
      commentCode = (await codeFor('comment', commentId))!,
      replyCode = (await codeFor('reply', replyId))!;
    const targets: ReferenceTarget[] = [
      { kind: 'post', targetId: post.id },
      { kind: 'comment', targetId: commentId },
      { kind: 'reply', targetId: replyId },
    ];
    await inTransaction(f.pool, async (tx) => {
      await references.policy(tx, 'update');
      await tx.query(
        "INSERT INTO whaleu_community.content_reference_reservations(code,target_kind,target_id) VALUES('22345678','reply',$1)",
        [replyId],
      );
      const missing = await tx.query(`SELECT 1 FROM (
      SELECT 'post' kind,id FROM whaleu_community.posts UNION ALL
      SELECT 'comment' kind,id FROM whaleu_community.root_comments UNION ALL
      SELECT 'reply' kind,id FROM whaleu_community.replies) retained
      WHERE NOT EXISTS(SELECT 1 FROM whaleu_community.content_reference_canonicals c WHERE c.target_kind=retained.kind AND c.target_id=retained.id) LIMIT 1`);
      assert.equal(
        missing.rowCount,
        0,
        'Synthetic retained fixture coverage includes deleted records',
      );
      await tx.query(
        "UPDATE whaleu_community.content_reference_policy SET state='ready',public_enabled=true WHERE singleton",
      );
    });
    await t.test(
      'native post, root and reply hooks share the atomic receipt path, aliases reveal navigation only',
      async () => {
        assert.equal(postCode, '10000002');
        assert.equal(commentCode, '100000001');
        assert.equal(replyCode, '100000002');
        assert.deepEqual((await get(`${root}/capability`)).body, {
          available: true,
        });
        const found = await lookup([...targets, targets[0]!]);
        ok(found);
        assert.equal(found.body.items.length, 3);
        const alias = await resolve('22345678');
        ok(alias);
        assert.deepEqual(alias.body, {
          kind: 'reply',
          postId: post.id,
          rootCommentId: commentId,
          replyId,
        });
        assert.equal(alias.headers['cache-control'], 'no-store');
        assert.deepEqual((await resolve('1234567')).body, {
          kind: 'post',
          postId: baseline.id,
        });
        const sameSpace = await resolve(
          postCode,
          reader,
          f.scope.home.spaceId.toUpperCase(),
        );
        ok(sameSpace);
        assert.equal(sameSpace.body.viewSpaceId, f.scope.home.spaceId);
        const unavailableScope = await resolve(
          postCode,
          reader,
          f.scope.foreign.spaceId,
        );
        ok(unavailableScope, 404);
        assert.equal(unavailableScope.body.error.code, 'REFERENCE_NOT_FOUND');
        const before = await counts(),
          beforeCounters = await counters();
        assert.deepEqual((await sendPost(post.body)).body, post.receipt);
        assert.deepEqual(
          (
            await request(http)
              .post(commentPath)
              .set('Authorization', auth(owner))
              .send(commentBody)
          ).body,
          commentResponse.body,
        );
        assert.deepEqual(
          (
            await request(http)
              .post(replyPath)
              .set('Authorization', auth(owner))
              .send(replyBody)
          ).body,
          replyResponse.body,
        );
        assert.deepEqual(await counts(), before);
        assert.deepEqual(await counters(), beforeCounters);
        ok(await sendPost({ ...post.body, text: 'changed payload' }), 409);
        ok(await resolve('10000000'), 404); // permanently reserved orphan
      },
    );

    await t.test(
      'allocation then injected infrastructure failure rolls back actual content, media/review bindings, events, counters and request receipt',
      async () => {
        const prepared = await request(http)
          .post('/v1/media/upload-intents')
          .set('Authorization', auth(owner))
          .send({
            clientRequestId: randomUUID(),
            purpose: 'community-post-image',
            draftId: randomUUID(),
            spaceId: f.scope.home.spaceId,
            slot: 'images',
            ordinal: 0,
            declaration: { mime: 'image/png', bytes: bytes.length },
          });
        ok(prepared);
        await f.worker.upload(owner.accountId, prepared.body.intentId, bytes);
        for (const stage of ['seal', 'process', 'review'] as const)
          assert.equal(await f.worker.runOne(stage), true);
        const ready = await get(
          `/v1/media/upload-intents/${prepared.body.intentId}`,
          owner,
        );
        ok(ready);
        assert.equal(ready.body.status, 'ready');
        const assetId = ready.body.assetId as string;
        const digest = (
          await f.pool.query<{ manifest_digest: string }>(
            'SELECT manifest_digest FROM whaleu_media.assets WHERE id=$1',
            [assetId],
          )
        ).rows[0]!.manifest_digest;
        const body = await preparePost(
            'synthetic rollback reference publication',
            'named',
            [{ assetId, digest }],
          ),
          before = await counts(),
          beforeCounters = await counters();
        const original = allocation.allocateForPublication;
        allocation.allocateForPublication = async function (target, tx) {
          await original.call(allocation, target, tx);
          throw new ApplicationError('COMMUNITY_UNAVAILABLE');
        };
        try {
          ok(await sendPost(body), 503);
        } finally {
          allocation.allocateForPublication = original;
        }
        assert.deepEqual(await counts(), before);
        assert.deepEqual(await counters(), beforeCounters);
        assert.equal(
          (
            await f.pool.query(
              'SELECT receipt FROM whaleu_community.publication_requests WHERE account_id=$1 AND client_request_id=$2',
              [owner.accountId, body.clientRequestId],
            )
          ).rowCount,
          0,
        );
        const retry = await sendPost(body);
        ok(retry, 201);
        assert.equal(retry.body.outcome, 'created');
        assert.ok(await codeFor('post', retry.body.resourceId));
      },
    );

    await t.test(
      'same-target concurrency is stable, distinct roots/replies share monotonic nonreusing codes, rollback releases unseen numbers',
      async () => {
        const repeated = await Promise.all(
          Array.from({ length: 8 }, () =>
            inTransaction(f.pool, (tx) =>
              allocation.allocateForPublication(
                { kind: 'reply', targetId: replyId },
                tx,
              ),
            ),
          ),
        );
        for (const result of repeated)
          assert.deepEqual(result, { state: 'allocated', code: replyCode });
        const synthetic = [
          { kind: 'comment' as const, targetId: randomUUID() },
          { kind: 'reply' as const, targetId: randomUUID() },
        ];
        const values = await Promise.all(
          synthetic.map((target) =>
            inTransaction(f.pool, (tx) =>
              allocation.allocateForPublication(target, tx),
            ),
          ),
        );
        const codes = values
          .map((result) => {
            assert.equal(result.state, 'allocated');
            return Number(result.state === 'allocated' && result.code);
          })
          .sort((a, b) => a - b);
        assert.equal(codes[1]! - codes[0]!, 1);
        const before = await counters(),
          rollbackTarget = { kind: 'reply' as const, targetId: randomUUID() };
        await assert.rejects(
          inTransaction(f.pool, async (tx) => {
            await allocation.allocateForPublication(rollbackTarget, tx);
            throw new Error('rollback');
          }),
        );
        assert.deepEqual(await counters(), before);
        assert.equal(await codeFor('reply', rollbackTarget.targetId), null);
        await assert.rejects(
          f.pool.query(
            'DELETE FROM whaleu_community.content_reference_reservations WHERE code=$1',
            [replyCode],
          ),
          { code: '23514' },
        );
        await assert.rejects(
          f.pool.query(
            'UPDATE whaleu_community.content_reference_reservations SET target_id=$2 WHERE code=$1',
            [replyCode, randomUUID()],
          ),
          { code: '23514' },
        );
        await assert.rejects(
          f.pool.query(
            'TRUNCATE whaleu_community.content_reference_canonicals',
          ),
          { code: '23514' },
        );
        await assert.rejects(
          f.pool.query(
            "UPDATE whaleu_community.content_reference_sequences SET next_code=100000000 WHERE name='child'",
          ),
          { code: '23514' },
        );
        await assert.rejects(
          f.pool.query(
            "INSERT INTO whaleu_community.content_reference_canonicals(target_kind,target_id,code) VALUES('post',$1,$2)",
            [randomUUID(), '10000000'],
          ),
          { code: '23503' },
        );
      },
    );

    await withCommunityScopeWriter(f.pool, async (tx) => {
      await tx.query(
        "INSERT INTO whaleu_authorization.role_grants(id,account_id,role,operating_region_id,approved_by_account_id,approval_reference) VALUES($1,$2,'school_admin',$3,$2,'synthetic:content-references')",
        [randomUUID(), admin.accountId, f.scope.home.regionId],
      );
    });
    const hidden = async (desired: boolean) => {
      const state = await get(
        `/v1/me/community/posts/${post.id}/owner-visibility`,
        owner,
      );
      ok(state);
      const result = await request(http)
        .post('/v1/me/community/owner-visibility-commands')
        .set('Authorization', auth(owner))
        .send({
          clientRequestId: randomUUID(),
          postId: post.id,
          ownerHidden: desired,
          expectedVersion: state.body.version,
        });
      ok(result);
      assert.equal(result.body.outcome, 'applied');
    };
    await t.test(
      'malformed ancestry cannot cross the canonical second-read boundary',
      async () => {
        const community = f.app.get(CommunityRepository),
          comment = community.comment,
          reply = community.reply;
        // The database itself disallows reparenting. Adapter fault injection below
        // additionally proves the real current authority rechecks the second read.
        await assert.rejects(
          f.pool.query(
            'UPDATE whaleu_community.replies SET post_id=$2 WHERE id=$1',
            [replyId, baseline.id],
          ),
          { code: '23514' },
        );
        try {
          community.comment = async function (id, tx, lock, read) {
            const row = await comment.call(community, id, tx, lock, read);
            return id === commentId && lock
              ? { ...row, post_id: baseline.id }
              : row;
          };
          ok(await resolve(commentCode), 404);
          ok(await resolve(replyCode), 404);
        } finally {
          community.comment = comment;
        }
        for (const field of ['post_id', 'root_comment_id'] as const) {
          try {
            community.reply = async function (id, tx, lock, read) {
              const row = await reply.call(community, id, tx, lock, read);
              return id === replyId && lock
                ? { ...row, [field]: randomUUID() }
                : row;
            };
            ok(await resolve(replyCode), 404);
            assert.deepEqual(
              (await lookup([{ kind: 'reply', targetId: replyId }])).body,
              { items: [] },
            );
          } finally {
            community.reply = reply;
          }
        }
        ok(await resolve(replyCode));
      },
    );

    await t.test(
      'uncommitted raw block transition fails final current proof; its commit revokes both resolve and destination read',
      async () => {
        const blockedReader = await f.actor(),
          blocker = await f.pool.connect(),
          relationshipId = randomUUID();
        ok(await resolve(postCode, blockedReader));
        try {
          await blocker.query('BEGIN');
          await blocker.query(
            "INSERT INTO whaleu_safety.blocks(id,blocker_id,blocked_id,active,source_kind,source_id) VALUES($1,$2,$3,true,'post',$4)",
            [relationshipId, blockedReader.accountId, owner.accountId, post.id],
          );
          await blocker.query(
            "INSERT INTO whaleu_safety.events(id,account_id,relationship_id,kind,revision) VALUES($1,$2,$3,'blocked',1)",
            [randomUUID(), blockedReader.accountId, relationshipId],
          );
          // No canonical writer gate: the mandatory final relationship proof must
          // reject this unseen raw writer, never return an obsolete allow.
          const during = await resolve(postCode, blockedReader);
          ok(during, 503);
          assert.ok(!JSON.stringify(during.body).includes(post.id));
          await blocker.query('COMMIT');
          ok(await resolve(postCode, blockedReader), 404);
          ok(await get(`/v1/community/posts/${post.id}`, blockedReader), 404);
        } finally {
          await blocker.query('ROLLBACK');
          blocker.release();
        }
      },
    );

    await t.test(
      'selected scope revocation during the exact policy gate wait returns no navigation IDs',
      async (scopeTest) => {
        const blocker = await f.pool.connect();
        let resolving: Promise<request.Response> | undefined;
        let resolvingSettled = false;
        try {
          await blocker.query('BEGIN');
          const blockerPid = (
            await blocker.query<{ pid: number }>('SELECT pg_backend_pid() pid')
          ).rows[0]!.pid;
          await blocker.query(
            'UPDATE whaleu_community.spaces SET is_active=false WHERE id=$1',
            [f.scope.home.spaceId],
          );
          resolving = resolve(postCode, reader, f.scope.home.spaceId).then(
            (value) => value,
          );
          void resolving.then(
            () => {
              resolvingSettled = true;
            },
            () => {
              resolvingSettled = true;
            },
          );
          // The spaces writer trigger owns the common policy gate before its
          // row lock. Observe that earlier gate, not an unreachable later
          // spaces SELECT or a wait caused by an unrelated transaction.
          const gateQuery =
            "SELECT pg_advisory_xact_lock_shared(hashtextextended('whaleu:named-block-policy:v1',0))";
          let observed:
            | {
                pid: number;
                query: string;
                blockingPids: number[];
              }
            | undefined;
          const until = Date.now() + 5000;
          while (Date.now() < until && !resolvingSettled) {
            observed = (
              await f.pool.query<{
                pid: number;
                query: string;
                blockingPids: number[];
              }>(
                `SELECT pid,query,pg_blocking_pids(pid) AS "blockingPids"
                 FROM pg_stat_activity
                 WHERE datname=current_database() AND pid<>pg_backend_pid()
                   AND state='active' AND wait_event_type='Lock'
                   AND wait_event='advisory' AND query=$1
                   AND $2::integer=ANY(pg_blocking_pids(pid))`,
                [gateQuery, blockerPid],
              )
            ).rows[0];
            if (observed) break;
            await delay(10);
          }
          assert.ok(
            observed,
            'Expected exact shared policy gate wait blocked by the scope writer',
          );
          assert.equal(
            resolvingSettled,
            false,
            'Reference resolution must remain pending until scope revocation commits',
          );
          scopeTest.diagnostic(
            JSON.stringify({
              referenceScopeGate: {
                blockerPid,
                waiterPid: observed.pid,
                blockingPids: observed.blockingPids,
                query: observed.query,
                requestSettled: resolvingSettled,
              },
            }),
          );
          await blocker.query('COMMIT');
          const response = await resolving;
          scopeTest.diagnostic(
            JSON.stringify({
              referenceScopeOutcome: {
                status: response.status,
                code: response.body.error?.code,
                containsPostId: JSON.stringify(response.body).includes(post.id),
              },
            }),
          );
          ok(response, 404);
          assert.equal(response.body.error.code, 'REFERENCE_NOT_FOUND');
          assert.ok(!JSON.stringify(response.body).includes(post.id));
          ok(await get(`/v1/community/posts/${post.id}`), 404);
        } finally {
          await blocker.query('ROLLBACK');
          blocker.release();
          await resolving;
          await withCommunityScopeWriter(f.pool, (tx) =>
            tx.query(
              'UPDATE whaleu_community.spaces SET is_active=true WHERE id=$1',
              [f.scope.home.spaceId],
            ),
          );
        }
        ok(await resolve(postCode, reader, f.scope.home.spaceId));
      },
    );

    await t.test(
      'hidden ancestors, manager status and named blocks use canonical authority; anonymous isolation remains',
      async () => {
        await hidden(true);
        for (const actor of [reader, admin]) {
          for (const code of [postCode, commentCode, replyCode, '22345678']) {
            const response = await resolve(code, actor);
            ok(response, 404);
            assert.equal(response.body.error.code, 'REFERENCE_NOT_FOUND');
            assert.ok(!JSON.stringify(response.body).includes(post.id));
          }
          assert.deepEqual((await lookup(targets, actor)).body, { items: [] });
        }
        ok(await resolve(replyCode, owner));
        await hidden(false);
        const anonymous = await publish(
            'synthetic anonymous reference target',
            'anonymous',
          ),
          anonymousCode = (await codeFor('post', anonymous.id))!;
        const block = await request(http)
          .put('/v1/me/safety/blocks')
          .set('Authorization', auth())
          .send({
            clientRequestId: randomUUID(),
            source: { kind: 'post', id: post.id },
            blocked: true,
          });
        ok(block);
        for (const code of [postCode, commentCode, replyCode])
          ok(await resolve(code), 404);
        ok(await resolve(anonymousCode));
        ok(
          await request(http)
            .put(`/v1/me/safety/blocks/${block.body.receipt.relationshipId}`)
            .set('Authorization', auth())
            .send({
              clientRequestId: randomUUID(),
              expectedRevision: block.body.current.revision,
              blocked: false,
            }),
        );
        ok(await resolve(replyCode));
      },
    );

    await t.test(
      'soft-deleted root suppresses reply and preserves every committed canonical and alias',
      async () => {
        const before = await counts();
        ok(
          await request(http)
            .delete(`/v1/community/comments/${commentId}`)
            .set('Authorization', auth(owner)),
          204,
        );
        for (const code of [commentCode, replyCode, '22345678'])
          ok(await resolve(code), 404);
        assert.equal(await codeFor('comment', commentId), commentCode);
        assert.equal(await codeFor('reply', replyId), replyCode);
        assert.equal((await counts()).reservations, before.reservations);
        assert.deepEqual((await lookup(targets)).body, {
          items: [{ kind: 'post', targetId: post.id, code: postCode }],
        });
      },
    );

    await t.test(
      'atomic bounded limiter counts not-found commits and rejects concurrent excess without resource disclosure',
      async () => {
        const quotaActor = await f.actor();
        // Pin the synthetic test bucket in the future so minute rollover cannot
        // invalidate this exact concurrency test; production uses DB statement time.
        await f.pool.query(
          "INSERT INTO whaleu_community.content_reference_budgets(viewer_id,operation,window_start,used) VALUES($1,'resolve',date_trunc('minute',clock_timestamp())+interval '1 hour',59)",
          [quotaActor.accountId],
        );
        const responses = await Promise.all([
          resolve('8765432', quotaActor),
          resolve('8765432', quotaActor),
        ]);
        assert.deepEqual(
          responses.map((value) => value.status).sort(),
          [404, 429],
        );
        assert.equal(
          (
            await f.pool.query(
              "SELECT used FROM whaleu_community.content_reference_budgets WHERE viewer_id=$1 AND operation='resolve'",
              [quotaActor.accountId],
            )
          ).rows[0].used,
          60,
        );
        await f.pool.query(
          "INSERT INTO whaleu_community.content_reference_budgets(viewer_id,operation,window_start,used) VALUES($1,'lookup',date_trunc('minute',clock_timestamp())+interval '1 hour',119)",
          [quotaActor.accountId],
        );
        const lookups = await Promise.all([
          lookup(targets, quotaActor),
          lookup(targets, quotaActor),
        ]);
        assert.deepEqual(
          lookups.map((value) => value.status).sort(),
          [200, 429],
        );
        assert.equal(
          (
            await f.pool.query(
              'SELECT count(*)::int count FROM whaleu_community.content_reference_budgets WHERE viewer_id=$1',
              [quotaActor.accountId],
            )
          ).rows[0].count,
          2,
        );
      },
    );

    await t.test(
      'same-target alias can become canonical while the same UUID with a different kind remains occupied',
      async () => {
        const targetId = randomUUID();
        const start = Number(
          (
            await f.pool.query(
              "SELECT next_code::text FROM whaleu_community.content_reference_sequences WHERE name='child'",
            )
          ).rows[0].next_code,
        );
        await inTransaction(f.pool, async (tx) => {
          await references.policy(tx, 'update');
          await tx.query(
            "INSERT INTO whaleu_community.content_reference_reservations(code,target_kind,target_id) VALUES($1,'comment',$3),($2,'reply',$3)",
            [String(start), String(start + 1), targetId],
          );
        });
        const before = (await counts()).reservations;
        const result = await inTransaction(f.pool, (tx) =>
          allocation.allocateForPublication({ kind: 'reply', targetId }, tx),
        );
        assert.deepEqual(result, {
          state: 'allocated',
          code: String(start + 1),
        });
        assert.equal(
          (await counts()).reservations,
          before,
          'Own alias promoted without changing or inserting reservation',
        );
      },
    );

    await t.test(
      'queued deletion is re-read after the canonical row wait and old destinations do not grant future access',
      async () => {
        const racePost = await publish('synthetic reference deletion wait');
        const code = (await codeFor('post', racePost.id))!;
        ok(await resolve(code));
        const community = f.app.get(CommunityRepository),
          original = community.event;
        let enter!: () => void, release!: () => void;
        const entered = new Promise<void>((done) => {
          enter = done;
        });
        const held = new Promise<void>((done) => {
          release = done;
        });
        community.event = async function (key, type, id, tx, context) {
          const result = await original.call(
            community,
            key,
            type,
            id,
            tx,
            context,
          );
          if (type === 'post_deleted' && id === racePost.id) {
            enter();
            await held;
          }
          return result;
        };
        const deleting = request(http)
          .delete(`/v1/community/posts/${racePost.id}`)
          .set('Authorization', auth(owner))
          .then((value) => value);
        let resolving: Promise<request.Response> | undefined;
        try {
          await Promise.race([
            entered,
            deleting.then(() => {
              throw new Error(
                'Deletion never reached canonical event boundary',
              );
            }),
          ]);
          resolving = resolve(code).then((value) => value);
          await f.waitForLock('SELECT * FROM whaleu_community.posts');
          release();
          ok(await deleting, 204);
          ok(await resolving, 404);
          ok(await get(`/v1/community/posts/${racePost.id}`), 404);
          assert.equal(await codeFor('post', racePost.id), code);
        } finally {
          release();
          community.event = original;
          await deleting;
          await resolving;
        }
      },
    );

    await t.test(
      'session expiry during a limiter wait cannot commit a stale reference destination',
      async () => {
        const expiring = await f.actor();
        await f.pool.query(
          "INSERT INTO whaleu_community.content_reference_budgets(viewer_id,operation,window_start,used) VALUES($1,'resolve',date_trunc('minute',clock_timestamp()),1)",
          [expiring.accountId],
        );
        const blocker = await f.pool.connect();
        let resolving: Promise<request.Response> | undefined;
        try {
          await blocker.query('BEGIN');
          await blocker.query(
            "UPDATE whaleu_community.content_reference_budgets SET used=used WHERE viewer_id=$1 AND operation='resolve'",
            [expiring.accountId],
          );
          await f.pool.query(
            "UPDATE whaleu_identity.sessions SET access_expires_at=clock_timestamp()+interval '5 seconds' WHERE id=$1",
            [expiring.sessionId],
          );
          await f.pool.query(
            "UPDATE whaleu_identity.access_tokens SET expires_at=clock_timestamp()+interval '5 seconds' WHERE session_id=$1",
            [expiring.sessionId],
          );
          resolving = resolve(postCode, expiring).then((value) => value);
          await f.waitForLock('content_reference_budgets');
          await f.pool.query(
            'SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM expires_at-clock_timestamp())::double precision)+0.05) FROM whaleu_identity.access_tokens WHERE session_id=$1',
            [expiring.sessionId],
          );
          await blocker.query('COMMIT');
          ok(await resolving, 401);
          assert.equal(
            (
              await f.pool.query(
                "SELECT used FROM whaleu_community.content_reference_budgets WHERE viewer_id=$1 AND operation='resolve'",
                [expiring.accountId],
              )
            ).rows[0].used,
            1,
          );
        } finally {
          await blocker.query('ROLLBACK');
          blocker.release();
          await resolving;
        }
      },
    );

    await t.test(
      'dense unreconciled collision run fails within bounded scan without advancing counters',
      async () => {
        const start = Number(
          (
            await f.pool.query(
              "SELECT next_code::text FROM whaleu_community.content_reference_sequences WHERE name='child'",
            )
          ).rows[0].next_code,
        );
        await inTransaction(f.pool, async (tx) => {
          await references.policy(tx, 'update');
          await tx.query(
            "INSERT INTO whaleu_community.content_reference_reservations(code,target_kind,target_id) SELECT value::text,'comment',$3::uuid FROM generate_series($1::bigint,$2::bigint) value",
            [start, start + 4095, randomUUID()],
          );
        });
        const before = await counters(),
          target = { kind: 'reply' as const, targetId: randomUUID() };
        await assert.rejects(
          inTransaction(f.pool, (tx) =>
            allocation.allocateForPublication(target, tx),
          ),
          (error: unknown) =>
            error instanceof ApplicationError &&
            error.code === 'COMMUNITY_UNAVAILABLE',
        );
        assert.deepEqual(await counters(), before);
        assert.equal(await codeFor('reply', target.targetId), null);
      },
    );

    await t.test(
      'range exhaustion is unavailable, rolls back new work, and cannot break historical successful replay',
      async () => {
        await f.pool.query(
          "UPDATE whaleu_community.content_reference_sequences SET next_code=maximum+1 WHERE name='post'",
        );
        const body = await preparePost(
            'synthetic exhausted reference namespace',
          ),
          before = await counts();
        ok(await sendPost(body), 503);
        assert.deepEqual(await counts(), before);
        const retry = await sendPost(post.body);
        ok(retry, 201);
        assert.deepEqual(retry.body, post.receipt);
        assert.equal(await codeFor('post', post.id), postCode);
      },
    );
  },
);
