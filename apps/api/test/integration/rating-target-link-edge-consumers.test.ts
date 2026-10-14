import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import request from 'supertest';
import { ratingTargetLinkFixture } from '../support/rating-target-link-fixture.js';
import { setRatingReviewState } from '../support/rating-runtime-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import {
  readyDiscussionBatch,
  sealDiscussionBatch,
} from '../support/media/discussion-batch-fixture.js';
import { sha256 } from '../../src/media/processing/protocol.js';
import { seedReviewPolicy } from '../support/community-approval-fixtures.js';
import { HotScoreMaterializer } from '../../src/community/hot-score/materializer.js';
import { HotFeedProcessing } from '../../src/community/hot-score/processing.js';

/** Actual pin/hot/public Media and administrator HTTP paths. Only disposable
 * external Media bytes and safety ingress are synthetic, never owner proofs. */
test(
  'linked root hot/pin/Media/admin consumers retain allow, deny, unknown and original-key recovery',
  { timeout: 300000 },
  async (t) => {
    const sharp = (await import('sharp')).default;
    const bytes = await sharp({
      create: { width: 40, height: 32, channels: 3, background: '#258c93' },
    })
      .png()
      .toBuffer();
    const f = await ratingTargetLinkFixture(null, {
      hot: true,
      media: [{ sha256: sha256(bytes), verdict: 'allow' }],
    });
    t.after(() => f.close());
    assert.ok(f.worker);
    const category = await f.createLinkCategory('course'),
      target = await f.createLinkTarget(category),
      body = await f.card(target.id),
      post = await f.publishCard(body),
      reader = await f.actor(),
      admin = await f.actor();
    const get = (path: string, actor = reader) =>
      f.auth(request(f.http).get(path), actor);
    const send = (path: string, value: object, actor = admin) =>
      f.linkCall(actor, path, value);
    await withCommunityScopeWriter(f.pool, async (tx) => {
      const pinScope = randomUUID();
      await tx.query(
        "INSERT INTO whaleu_authorization.role_grants(id,account_id,role,operating_region_id,approved_by_account_id,approval_reference) VALUES($1,$2,'school_admin',$3,$2,'synthetic-rating-link-consumers')",
        [randomUUID(), admin.accountId, f.scope.home.regionId],
      );
      await tx.query(
        "INSERT INTO whaleu_community.post_pin_scopes(id,space_id,kind,operating_region_id,source_reference,provenance,accepted_at,valid_until) VALUES($1,$2,'regional',$3,'synthetic-rating-link-pin-scope','accepted',clock_timestamp()-interval '1 second',clock_timestamp()+interval '1 hour')",
        [pinScope, f.scope.home.spaceId, f.scope.home.regionId],
      );
      await tx.query(
        "INSERT INTO whaleu_community.post_pin_history(scope_id,coverage,source_reference,accepted_at,valid_until) VALUES($1,'accepted_empty','synthetic-independent-empty-history',clock_timestamp()-interval '1 second',clock_timestamp()+interval '1 hour')",
        [pinScope],
      );
    });
    const pinCommand = {
      operation: 'pin',
      postId: post.resourceId,
      clientRequestId: randomUUID(),
    };
    const pinned = await send('/v1/community/post-pin-commands', pinCommand);
    assert.equal(pinned.status, 200, JSON.stringify(pinned.body));
    assert.equal(pinned.body.outcome, 'applied');
    await seedReviewPolicy(f.pool);
    const media = { ...f, worker: f.worker },
      batch = await readyDiscussionBatch(
        media,
        reader,
        { kind: 'comment', postId: post.resourceId },
        1,
        [{ mime: 'image/png', bytes }],
      );
    const sealed = await sealDiscussionBatch(
      media,
      reader,
      batch.status,
      'Exact retained linked descendant image',
    );
    const published = await send(sealed.path, sealed.body, reader);
    assert.equal(published.status, 201, JSON.stringify(published.body));
    const commentId = String(published.body.resourceId);
    const child = await get(`/v1/community/comments/${commentId}`);
    assert.equal(child.status, 200, JSON.stringify(child.body));
    const bindingId = String(child.body.images[0].bindingId);
    const processed = await f.app
      .get(HotFeedProcessing)
      .processSelected([post.resourceId]);
    assert.equal(processed.current, 1, JSON.stringify(processed));
    const refresh = await f.app
      .get(HotScoreMaterializer)
      .refresh(post.resourceId);
    assert.ok(['current', 'refreshed'].includes(refresh), refresh);
    const hot = () =>
        get('/v1/community/hot').query({ spaceId: f.scope.home.spaceId }),
      pins = () =>
        get('/v1/community/post-pins').query({ spaceId: f.scope.home.spaceId }),
      management = () =>
        get('/v1/community/admin-post-removal/management', admin).query({
          kind: 'post',
          id: post.resourceId,
        });
    for (const response of [await hot(), await pins()]) {
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.match(JSON.stringify(response.body), new RegExp(post.resourceId));
      assert.match(JSON.stringify(response.body), /Original course/);
    }
    assert.equal(
      (await get(`/v1/media/bindings/${bindingId}/thumb-v1`)).status,
      200,
    );
    const view = await management();
    assert.equal(view.status, 200, JSON.stringify(view.body));
    assert.equal(view.body.canRemove, true);
    const cancelled = {
      clientRequestId: randomUUID(),
      target: { kind: 'post', id: post.resourceId },
      expectedTargetVersion: String(view.body.targetVersion),
      action: 'remove_post',
    };
    const cancelledResponse = await send(
      '/v1/community/admin-post-removal/commands/cancel',
      cancelled,
    );
    assert.equal(
      cancelledResponse.status,
      200,
      JSON.stringify(cancelledResponse.body),
    );
    assert.equal(cancelledResponse.body.code, 'ADMIN_POST_REMOVAL_CANCELLED');
    const removalDraft = await f.card(target.id);
    removalDraft.text = 'Independent administrative recovery sample';
    const removalPost = await f.publishCard(removalDraft);
    const removalView = await get(
      '/v1/community/admin-post-removal/management',
      admin,
    ).query({ kind: 'post', id: removalPost.resourceId });
    assert.equal(removalView.status, 200, JSON.stringify(removalView.body));
    const appliedCommand = {
      clientRequestId: randomUUID(),
      target: { kind: 'post', id: removalPost.resourceId },
      expectedTargetVersion: String(removalView.body.targetVersion),
      action: 'remove_post',
    };
    const applied = await send(
      '/v1/community/admin-post-removal/commands',
      appliedCommand,
    );
    assert.equal(applied.status, 200, JSON.stringify(applied.body));
    assert.equal(applied.body.outcome, 'applied');
    const recovery = async () => {
      const response = await get(
        '/v1/community/admin-post-removal/requests/' +
          cancelled.clientRequestId,
        admin,
      );
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.deepEqual(response.body.receipt, cancelledResponse.body);
      assert.doesNotMatch(
        JSON.stringify(response.body),
        /Original course|这门课程|retained linked descendant/,
      );
      const replay = await send(
        '/v1/community/admin-post-removal/commands',
        cancelled,
      );
      assert.deepEqual(replay.body, cancelledResponse.body);
      const wrongOwner = await get(
        '/v1/community/admin-post-removal/requests/' +
          cancelled.clientRequestId,
        reader,
      );
      assert.equal(wrongOwner.status, 200);
      assert.deepEqual(wrongOwner.body, { state: 'not_recorded' });
      const appliedRecovery = await get(
        '/v1/community/admin-post-removal/requests/' +
          appliedCommand.clientRequestId,
        admin,
      );
      assert.equal(
        appliedRecovery.status,
        200,
        JSON.stringify(appliedRecovery.body),
      );
      assert.deepEqual(appliedRecovery.body.receipt, applied.body);
      assert.doesNotMatch(
        JSON.stringify(appliedRecovery.body),
        /Original course|这门课程|administrative recovery sample/,
      );
      assert.deepEqual(
        (
          await send(
            '/v1/community/admin-post-removal/commands',
            appliedCommand,
          )
        ).body,
        applied.body,
      );
      const pin = await get(
        '/v1/me/community/post-pin-requests/' + pinCommand.clientRequestId,
        admin,
      );
      assert.deepEqual(pin.body, pinned.body);
    };
    await recovery();
    await setRatingReviewState(f.pool, target.approval.decisionId, 'revoked');
    for (const response of [await hot(), await pins()]) {
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.doesNotMatch(
        JSON.stringify(response.body),
        new RegExp(`${post.resourceId}|Original course|这门课程`),
      );
    }
    assert.equal(
      (await get(`/v1/media/bindings/${bindingId}/thumb-v1`)).status,
      404,
    );
    assert.equal((await management()).status, 404);
    await recovery();
    await withCommunityScopeWriter(f.pool, async (tx) => {
      const event = randomUUID();
      await tx.query(
        "INSERT INTO whaleu_community.rating_approval_events(id,decision_id,state,coverage,provenance,issuer,provenance_ref,occurred_at) VALUES($1,$2,'allow','missing','accepted','synthetic-rating-review','synthetic-card-unknown',clock_timestamp())",
        [event, target.approval.decisionId],
      );
      await tx.query(
        'UPDATE whaleu_community.rating_approval_heads SET event_id=$2 WHERE decision_id=$1',
        [target.approval.decisionId, event],
      );
    });
    for (const response of [
      await hot(),
      await pins(),
      await management(),
      await get(`/v1/media/bindings/${bindingId}/thumb-v1`),
    ]) {
      assert.equal(response.status, 503, JSON.stringify(response.body));
      assert.doesNotMatch(
        JSON.stringify(response.body),
        /Original course|这门课程|retained linked descendant/,
      );
    }
    await recovery();
    const forbiddenCardMedia = await f.linkCall(
      f.creator,
      '/v1/community/posts',
      {
        ...body,
        clientRequestId: randomUUID(),
        imageAssetIds: sealed.body.imageAssetIds,
      },
    );
    assert.equal(forbiddenCardMedia.status, 400);
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::int n FROM whaleu_community.post_images WHERE post_id=$1',
          [post.resourceId],
        )
      ).rows[0].n,
      0,
    );
  },
);
