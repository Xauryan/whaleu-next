import { discussionApprovalEnvelope } from '../support/community-runtime-fixtures.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import request from 'supertest';
import { syntheticMediaRuntimeFixture } from '../support/media/runtime-fixture.js';
import {
  readyBatch,
  sealBatchPost,
  responseOk,
} from '../support/media/batch-fixture.js';
import {
  approveEnvelope,
  seedReviewPolicy,
} from '../support/community-approval-fixtures.js';
import { sha256 } from '../../src/media/processing/protocol.js';
import {
  mediaBatchStatusSchema,
  mediaBatchRequestHash,
} from '../../src/media/contracts-v3.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';

async function imageFiles() {
  const sharp = (await import('sharp')).default;
  return Promise.all(
    (['png', 'jpeg'] as const).map(async (format) => ({
      mime: format === 'png' ? 'image/png' : 'image/jpeg',
      bytes: await sharp({
        create: {
          width: 80,
          height: 60,
          channels: 3,
          background: { r: 20, g: 100, b: 160 },
        },
      })
        .toFormat(format)
        .toBuffer(),
    })),
  );
}

test(
  'nine actual multipart images reorder immutable source slots and atomically publish all bindings receipt outbox and exact variants',
  { timeout: 480000 },
  async (t) => {
    const files = await imageFiles();
    const f = await syntheticMediaRuntimeFixture(
      files.map(({ bytes }) => ({
        sha256: sha256(bytes),
        verdict: 'allow' as const,
      })),
    );
    try {
      const actor = await f.actor(),
        other = await f.actor(),
        http = f.app.getHttpServer(),
        auth = `Bearer ${actor.accessToken}`;
      await seedReviewPolicy(f.pool);
      const ready = await readyBatch(f, actor, 9, files);
      const reversed = [...ready.status.orderedMemberIds].reverse();
      const layout = await request(http)
        .post(`/v3/media/batches/${ready.status.batchId}/layout`)
        .set('Authorization', auth)
        .send({
          commandId: randomUUID(),
          expectedRevision: ready.status.revision,
          orderedMemberIds: reversed,
          removeMemberIds: [],
        });
      responseOk(layout);
      const status = mediaBatchStatusSchema.parse(layout.body);
      assert.deepEqual(
        status.members.map((member) => member.sourceSlot),
        [8, 7, 6, 5, 4, 3, 2, 1, 0],
      );
      const sealed = await sealBatchPost(
        f,
        actor,
        status,
        'galleryneedle complete nine image publication',
      );
      const publish = () =>
        request(http)
          .post('/v1/community/posts')
          .set('Authorization', auth)
          .send(sealed.body);
      const counts = async () =>
        (
          await f.pool.query<{
            posts: number;
            bindings: number;
            consumptions: number;
            outbox: number;
            receipts: number;
          }>(
            `SELECT
      (SELECT count(*)::integer FROM whaleu_community.posts WHERE account_id=$1) posts,
      (SELECT count(*)::integer FROM whaleu_media.bindings b JOIN whaleu_media.assets a ON a.id=b.asset_id WHERE a.actor_id=$1) bindings,
      (SELECT count(*)::integer FROM whaleu_media.scope_consumptions WHERE actor_id=$1) consumptions,
      (SELECT count(*)::integer FROM whaleu_community.outbox o JOIN whaleu_community.posts p ON p.id=o.resource_id WHERE o.event_type='post_created' AND p.account_id=$1) outbox,
      (SELECT count(*)::integer FROM whaleu_community.publication_requests WHERE account_id=$1 AND receipt->>'outcome'='created') receipts`,
            [actor.accountId],
          )
        ).rows[0];
      for (let ordinal = 0; ordinal < 9; ordinal++)
        await t.test(
          `failure at binding ${ordinal + 1} rolls the entire operation back`,
          async () => {
            await f.pool
              .query(`CREATE FUNCTION whaleu_media.synthetic_fail_batch_binding() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.ordinal=${ordinal} THEN RAISE EXCEPTION 'synthetic ordered binding failure'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER z_synthetic_fail_batch_binding AFTER INSERT ON whaleu_media.bindings FOR EACH ROW EXECUTE FUNCTION whaleu_media.synthetic_fail_batch_binding()`);
            try {
              assert.ok((await publish()).status >= 400);
              assert.deepEqual(await counts(), {
                posts: 0,
                bindings: 0,
                consumptions: 0,
                outbox: 0,
                receipts: 0,
              });
            } finally {
              await f.pool.query(
                'DROP TRIGGER z_synthetic_fail_batch_binding ON whaleu_media.bindings; DROP FUNCTION whaleu_media.synthetic_fail_batch_binding()',
              );
            }
          },
        );
      for (const failure of [
        {
          table: 'whaleu_community.content_approval_bindings',
          event: 'INSERT',
          condition: "NEW.operation='publish_post'",
        },
        {
          table: 'whaleu_media.scope_consumptions',
          event: 'INSERT',
          condition: 'true',
        },
        {
          table: 'whaleu_media.publication_batches',
          event: 'UPDATE',
          condition: "NEW.state='consumed'",
        },
        {
          table: 'whaleu_community.publication_requests',
          event: 'UPDATE',
          condition: "NEW.receipt->>'outcome'='created'",
        },
        {
          table: 'whaleu_community.outbox',
          event: 'INSERT',
          condition: "NEW.event_type='post_created'",
        },
      ])
        await t.test(
          `failure at ${failure.table} rolls all nine bindings back`,
          async () => {
            await f.pool
              .query(`CREATE FUNCTION whaleu_media.synthetic_fail_batch_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${failure.condition} THEN RAISE EXCEPTION 'synthetic aggregate commit failure'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER z_synthetic_fail_batch_commit AFTER ${failure.event} ON ${failure.table} FOR EACH ROW EXECUTE FUNCTION whaleu_media.synthetic_fail_batch_commit()`);
            try {
              assert.ok((await publish()).status >= 400);
              assert.deepEqual(await counts(), {
                posts: 0,
                bindings: 0,
                consumptions: 0,
                outbox: 0,
                receipts: 0,
              });
            } finally {
              await f.pool.query(
                `DROP TRIGGER z_synthetic_fail_batch_commit ON ${failure.table}; DROP FUNCTION whaleu_media.synthetic_fail_batch_commit()`,
              );
            }
          },
        );
      const published = await publish();
      responseOk(published, 201);
      assert.equal(published.body.outcome, 'created');
      assert.deepEqual((await publish()).body, published.body);
      assert.deepEqual(await counts(), {
        posts: 1,
        bindings: 9,
        consumptions: 1,
        outbox: 1,
        receipts: 1,
      });
      const bindings = (
        await f.pool.query<{
          id: string;
          asset_id: string;
          ordinal: number;
          source_slot: number;
          attach_evidence: { version: number };
        }>(
          `SELECT b.id,b.asset_id,b.ordinal,b.attach_evidence,m.source_slot FROM whaleu_media.bindings b JOIN whaleu_media.publication_batch_members m ON m.asset_id=b.asset_id WHERE b.resource_id=$1 ORDER BY b.ordinal`,
          [published.body.resourceId],
        )
      ).rows;
      assert.equal(bindings.length, 9);
      assert.deepEqual(
        bindings.map((binding) => binding.source_slot),
        [8, 7, 6, 5, 4, 3, 2, 1, 0],
      );
      assert.deepEqual(
        bindings.map((binding) => binding.asset_id),
        sealed.body.imageAssetIds,
      );
      for (const binding of bindings) {
        assert.equal(binding.attach_evidence.version, 2);
        for (const variant of ['thumb-v1', 'display-v1']) {
          const response = await request(http)
            .get(`/v1/media/bindings/${binding.id}/${variant}`)
            .set('Authorization', auth);
          responseOk(response);
          const expected = (
            await f.pool.query<{ sha256: string }>(
              'SELECT sha256 FROM whaleu_media.variants WHERE asset_id=$1 AND variant_name=$2',
              [binding.asset_id, variant],
            )
          ).rows[0]!;
          assert.equal(sha256(response.body as Buffer), expected.sha256);
          assert.equal(response.headers['cache-control'], 'private, no-store');
        }
      }
      const history = await request(http)
        .get(`/v3/media/batches/requests/${ready.identity.batchRequestId}`)
        .set('Authorization', auth);
      responseOk(history);
      assert.equal(history.body.status.status, 'bound_history');
      assert.equal(history.body.status.bindings.length, 9);
      assert.deepEqual(history.body.status.publication, sealed.publication);
      const foreign = await request(http)
        .get(`/v3/media/batches/requests/${ready.identity.batchRequestId}`)
        .set('Authorization', `Bearer ${other.accessToken}`);
      responseOk(foreign);
      assert.equal(foreign.body.state, 'not_recorded');
      const cancelled = await request(http)
        .post(
          `/v3/media/batches/requests/${ready.identity.batchRequestId}/cancel`,
        )
        .set('Authorization', auth)
        .send({
          batchRequestHash: mediaBatchRequestHash(
            actor.accountId,
            ready.identity,
          ),
        });
      responseOk(cancelled);
      assert.equal(cancelled.body.status.status, 'bound_history');
      const commentBody = {
        clientRequestId: randomUUID(),
        text: 'galleryneedle plain comment on nine image parent',
        imageAssetIds: [],
        authorMode: 'named' as const,
      };
      await approveEnvelope(
        f.pool,
        await discussionApprovalEnvelope(
          f.app,
          f.pool,
          other.accountId,
          published.body.resourceId,
          commentBody,
        ),
      );
      const comment = await request(http)
        .post(`/v1/community/posts/${published.body.resourceId}/comments`)
        .set('Authorization', `Bearer ${other.accessToken}`)
        .send(commentBody);
      responseOk(comment, 201);
      const replyBody = {
        ...commentBody,
        clientRequestId: randomUUID(),
        text: 'galleryneedle plain reply on nine image ancestor',
        targetReplyId: null,
      };
      await approveEnvelope(
        f.pool,
        await discussionApprovalEnvelope(
          f.app,
          f.pool,
          actor.accountId,
          published.body.resourceId,
          replyBody,
          comment.body.resourceId,
        ),
      );
      const reply = await request(http)
        .post(`/v1/community/comments/${comment.body.resourceId}/replies`)
        .set('Authorization', auth)
        .send(replyBody);
      responseOk(reply, 201);
      const search = () =>
        request(http)
          .get('/v1/community/search')
          .set('Authorization', `Bearer ${other.accessToken}`)
          .query({
            spaceId: f.scope.home.spaceId,
            q: 'galleryneedle',
            type: 'all',
          });
      const found = await search();
      responseOk(found);
      assert.deepEqual(
        new Set(
          found.body.items.map((item: { contentId: string }) => item.contentId),
        ),
        new Set([
          published.body.resourceId,
          comment.body.resourceId,
          reply.body.resourceId,
        ]),
      );
      for (const assetId of sealed.body.imageAssetIds)
        assert.equal(
          JSON.stringify(found.body).includes(assetId),
          false,
          'Search remains text projection, never image metadata or bytes',
        );
      const profileRef = await request(http)
        .get('/v1/me/public-profile-ref')
        .set('Authorization', auth);
      responseOk(profileRef);
      const profile = () =>
        request(http)
          .get(`/v1/profiles/${profileRef.body.profileId}`)
          .set('Authorization', `Bearer ${other.accessToken}`);
      const beforeCount = await profile();
      responseOk(beforeCount);
      assert.equal(beforeCount.body.postCountStatus, 'known');
      assert.equal(
        beforeCount.body.postCount,
        1,
        'Nine bindings count as one post',
      );
      responseOk(
        await request(http)
          .put(`/v1/community/posts/${published.body.resourceId}/like`)
          .set('Authorization', `Bearer ${other.accessToken}`)
          .send({ requestId: randomUUID(), liked: true }),
      );
      const liked = () =>
        request(http)
          .get('/v1/me/community/liked')
          .set('Authorization', `Bearer ${other.accessToken}`);
      const likedBefore = await liked();
      responseOk(likedBefore);
      assert.equal(likedBefore.body.visibleLikedCountStatus, 'known');
      assert.equal(likedBefore.body.visibleLikedCount, 1);
      const ninth = bindings[8]!;
      await withCommunityScopeWriter(f.pool, async (tx) => {
        const asset = (
          await tx.query<{ manifest_digest: string; policy_revision: string }>(
            'SELECT manifest_digest,policy_revision FROM whaleu_media.assets WHERE id=$1',
            [ninth.asset_id],
          )
        ).rows[0]!;
        const revision =
          Number(
            (
              await tx.query<{ revision: string }>(
                'SELECT revision FROM whaleu_media.asset_safety_heads WHERE asset_id=$1 FOR UPDATE',
                [ninth.asset_id],
              )
            ).rows[0]!.revision,
          ) + 1;
        const event = randomUUID();
        await tx.query(
          `INSERT INTO whaleu_media.asset_safety_events(id,asset_id,revision,state,manifest_digest,policy_revision,issuer,source_reference,provenance,effective_at,valid_until) VALUES($1,$2,$3,'revoked',$4,$5,'registered-synthetic-media',$6,'{}',clock_timestamp()-interval '1 hour',clock_timestamp()+interval '1 hour')`,
          [
            event,
            ninth.asset_id,
            revision,
            asset.manifest_digest,
            asset.policy_revision,
            event,
          ],
        );
        await tx.query(
          'UPDATE whaleu_media.asset_safety_heads SET revision=$2,event_id=$3 WHERE asset_id=$1',
          [ninth.asset_id, revision, event],
        );
      });
      assert.ok(
        (
          await request(http)
            .get(`/v1/media/bindings/${bindings[0]!.id}/display-v1`)
            .set('Authorization', auth)
        ).status >= 400,
        'A non-target revoked attachment denies target bytes',
      );
      const hiddenSearch = await search();
      responseOk(hiddenSearch);
      assert.deepEqual(hiddenSearch.body.items, []);
      const hiddenCount = await profile();
      responseOk(hiddenCount);
      assert.equal(hiddenCount.body.postCountStatus, 'known');
      assert.equal(hiddenCount.body.postCount, 0);
      const hiddenLiked = await liked();
      responseOk(hiddenLiked);
      assert.equal(hiddenLiked.body.visibleLikedCountStatus, 'known');
      assert.equal(hiddenLiked.body.visibleLikedCount, 0);
      const replay = await publish();
      assert.deepEqual(
        replay.body,
        published.body,
        'Historical receipt does not become current image authority',
      );
    } finally {
      await f.close();
    }
  },
);

test(
  'one two and three v3 images preserve exact set; cancel-before-prepare cannot be reopened by late prepare',
  { timeout: 480000 },
  async (t) => {
    const files = await imageFiles();
    const f = await syntheticMediaRuntimeFixture(
      files.map(({ bytes }) => ({
        sha256: sha256(bytes),
        verdict: 'allow' as const,
      })),
    );
    try {
      const actor = await f.actor(),
        http = f.app.getHttpServer(),
        auth = `Bearer ${actor.accessToken}`;
      await seedReviewPolicy(f.pool);
      for (const size of [1, 2, 3])
        await t.test(`${size} images`, async () => {
          const ready = await readyBatch(f, actor, size, files);
          const sealed = await sealBatchPost(
            f,
            actor,
            ready.status,
            `${size} image batch`,
          );
          const response = await request(http)
            .post('/v1/community/posts')
            .set('Authorization', auth)
            .send(sealed.body);
          responseOk(response, 201);
          assert.equal(response.body.outcome, 'created');
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_media.bindings WHERE resource_id=$1',
                [response.body.resourceId],
              )
            ).rowCount,
            size,
          );
        });
      const identity = {
        version: 1,
        batchRequestId: randomUUID(),
        draftId: randomUUID(),
        spaceId: f.scope.home.spaceId,
        purpose: 'community-post-images',
      };
      const cancel = await request(http)
        .post(`/v3/media/batches/requests/${identity.batchRequestId}/cancel`)
        .set('Authorization', auth)
        .send({
          batchRequestHash: mediaBatchRequestHash(actor.accountId, identity),
        });
      responseOk(cancel);
      assert.equal(cancel.body.status.status, 'terminal');
      const late = await request(http)
        .post('/v3/media/batches/prepare')
        .set('Authorization', auth)
        .send(identity);
      responseOk(late);
      assert.equal(late.body.status, 'terminal');
      assert.equal(
        (
          await f.pool.query(
            'SELECT 1 FROM whaleu_community.media_drafts WHERE client_draft_id=$1',
            [identity.draftId],
          )
        ).rowCount,
        0,
      );
    } finally {
      await f.close();
    }
  },
);

test(
  'explicit typed publication cancellation closes reserved and sealed uncertainty without a fabricated receipt; late publish has one winner',
  { timeout: 480000 },
  async (t) => {
    const files = await imageFiles();
    const f = await syntheticMediaRuntimeFixture(
      files.map(({ bytes }) => ({
        sha256: sha256(bytes),
        verdict: 'allow' as const,
      })),
    );
    try {
      const actor = await f.actor(),
        http = f.app.getHttpServer(),
        auth = `Bearer ${actor.accessToken}`;
      await seedReviewPolicy(f.pool);
      await t.test(
        'reserved before body freeze uses durable fence, never REQUEST_NOT_FOUND as cancellation',
        async () => {
          const ready = await readyBatch(f, actor, 2, files);
          assert.equal(ready.status.status, 'ready_unbound');
          if (ready.status.status !== 'ready_unbound')
            throw new Error('Not ready');
          const publication = {
            clientRequestId: randomUUID(),
            operation: 'publish_post',
            intentHash: 'b'.repeat(64),
          };
          const assets = ready.status.orderedAssets.map(
            (image) => image.assetId,
          );
          const missing = await request(http)
            .get(`/v1/me/community/requests/${publication.clientRequestId}`)
            .set('Authorization', auth);
          assert.equal(missing.status, 404);
          const fence = await request(http)
            .post(`/v3/media/batches/${ready.status.batchId}/fence-publication`)
            .set('Authorization', auth)
            .send({ publication, assetIds: assets });
          responseOk(fence);
          assert.deepEqual(fence.body.cancellation, {
            requestId: publication.clientRequestId,
            operation: 'publish_post',
            outcome: 'cancelled',
            intentHash: publication.intentHash,
          });
          const again = await request(http)
            .post(`/v3/media/batches/${ready.status.batchId}/fence-publication`)
            .set('Authorization', auth)
            .send({ publication, assetIds: assets });
          responseOk(again);
          assert.deepEqual(again.body.cancellation, fence.body.cancellation);
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_community.publication_requests WHERE account_id=$1 AND client_request_id=$2 AND receipt IS NOT NULL',
                [actor.accountId, publication.clientRequestId],
              )
            ).rowCount,
            0,
            'No fake rejected Review receipt',
          );
          const conflict = await request(http)
            .post(`/v3/media/batches/${ready.status.batchId}/fence-publication`)
            .set('Authorization', auth)
            .send({
              publication: { ...publication, intentHash: 'c'.repeat(64) },
              assetIds: assets,
            });
          assert.ok(conflict.status >= 400);
          const cancelled = await request(http)
            .post(
              `/v3/media/batches/requests/${ready.identity.batchRequestId}/cancel`,
            )
            .set('Authorization', auth)
            .send({
              batchRequestHash: mediaBatchRequestHash(
                actor.accountId,
                ready.identity,
              ),
            });
          responseOk(cancelled);
          assert.equal(cancelled.body.status.status, 'terminal');
        },
      );
      for (const order of ['cancel-first', 'publish-first', 'race'] as const)
        await t.test(order, async () => {
          const ready = await readyBatch(f, actor, 2, files),
            sealed = await sealBatchPost(
              f,
              actor,
              ready.status,
              `Typed cancellation ${order}`,
            );
          const publish = () =>
            request(http)
              .post('/v1/community/posts')
              .set('Authorization', auth)
              .send(sealed.body);
          const fence = () =>
            request(http)
              .post(
                `/v3/media/batches/${ready.status.batchId}/fence-publication`,
              )
              .set('Authorization', auth)
              .send({
                publication: sealed.publication,
                assetIds: sealed.body.imageAssetIds,
              });
          let published: Awaited<ReturnType<typeof publish>>,
            cancellation: Awaited<ReturnType<typeof fence>>;
          if (order === 'cancel-first') {
            cancellation = await fence();
            published = await publish();
          } else if (order === 'publish-first') {
            published = await publish();
            cancellation = await fence();
          } else
            [published, cancellation] = await Promise.all([publish(), fence()]);
          responseOk(cancellation);
          if (cancellation.body.cancellation.outcome === 'created') {
            responseOk(published, 201);
            assert.equal(
              published.body.resourceId,
              cancellation.body.cancellation.resourceId,
            );
            assert.equal(cancellation.body.status.status, 'bound_history');
            assert.equal(
              (
                await f.pool.query(
                  'SELECT 1 FROM whaleu_community.publication_cancel_fences WHERE account_id=$1 AND client_request_id=$2',
                  [actor.accountId, sealed.body.clientRequestId],
                )
              ).rowCount,
              0,
            );
          } else {
            assert.equal(cancellation.body.cancellation.outcome, 'cancelled');
            assert.ok(published.status >= 400);
            assert.equal(published.body.error.code, 'MEDIA_REQUEST_CANCELLED');
            assert.equal(
              (
                await f.pool.query(
                  'SELECT 1 FROM whaleu_media.bindings WHERE asset_id=ANY($1::uuid[])',
                  [sealed.body.imageAssetIds],
                )
              ).rowCount,
              0,
            );
            const reopened = await request(http)
              .post(`/v3/media/batches/${ready.status.batchId}/reopen`)
              .set('Authorization', auth)
              .send({
                commandId: randomUUID(),
                expectedRevision: cancellation.body.status.revision,
                publication: sealed.publication,
              });
            responseOk(reopened);
            assert.equal(reopened.body.status, 'ready_unbound');
            assert.equal(
              (await publish()).body.error.code,
              'MEDIA_REQUEST_CANCELLED',
              'A reopened batch cannot revive the old command',
            );
            const cancelled = await request(http)
              .post(
                `/v3/media/batches/requests/${ready.identity.batchRequestId}/cancel`,
              )
              .set('Authorization', auth)
              .send({
                batchRequestHash: mediaBatchRequestHash(
                  actor.accountId,
                  ready.identity,
                ),
              });
            responseOk(cancelled);
            assert.equal(cancelled.body.status.status, 'terminal');
          }
        });
    } finally {
      await f.close();
    }
  },
);

test(
  'missing member cannot silently shrink publication; legacy routes cannot mutate v3; original three-active and default-disabled boundaries remain',
  { timeout: 480000 },
  async () => {
    const files = await imageFiles();
    const f = await syntheticMediaRuntimeFixture(
      files.map(({ bytes }) => ({
        sha256: sha256(bytes),
        verdict: 'allow' as const,
      })),
    );
    try {
      const actor = await f.actor(),
        http = f.app.getHttpServer(),
        auth = `Bearer ${actor.accessToken}`;
      await seedReviewPolicy(f.pool);
      const ready = await readyBatch(f, actor, 2, files);
      const memberId = randomUUID(),
        prepare = {
          clientRequestId: randomUUID(),
          memberId,
          sourceSlot: 2,
          declaration: {
            mime: files[0]!.mime,
            bytes: files[0]!.bytes.length,
            sha256: sha256(files[0]!.bytes),
          },
        };
      const third = await request(http)
        .post(`/v3/media/batches/${ready.status.batchId}/members/prepare`)
        .set('Authorization', auth)
        .send(prepare);
      responseOk(third);
      for (const version of ['v1', 'v2']) {
        assert.ok(
          (
            await request(http)
              .get(`/${version}/media/upload-intents/${third.body.intentId}`)
              .set('Authorization', auth)
          ).status >= 400,
        );
        assert.ok(
          (
            await request(http)
              .post(
                `/${version}/media/upload-intents/${third.body.intentId}/cancel`,
              )
              .set('Authorization', auth)
              .send({})
          ).status >= 400,
        );
      }
      let recovery = await request(http)
        .get(`/v3/media/batches/requests/${ready.identity.batchRequestId}`)
        .set('Authorization', auth);
      responseOk(recovery);
      assert.equal(recovery.body.status.members.length, 3);
      assert.equal(
        recovery.body.status.members[2].observation.status,
        'prepared',
      );
      const attemptedSeal = await request(http)
        .post(`/v3/media/batches/${ready.status.batchId}/seal`)
        .set('Authorization', auth)
        .send({
          commandId: randomUUID(),
          expectedRevision: recovery.body.status.revision,
          orderedMemberIds: recovery.body.status.orderedMemberIds,
          publication: {
            clientRequestId: randomUUID(),
            operation: 'publish_post',
            intentHash: 'a'.repeat(64),
          },
        });
      assert.ok(attemptedSeal.status >= 400);
      const removed = await request(http)
        .post(`/v3/media/batches/${ready.status.batchId}/layout`)
        .set('Authorization', auth)
        .send({
          commandId: randomUUID(),
          expectedRevision: recovery.body.status.revision,
          orderedMemberIds: ready.status.orderedMemberIds,
          removeMemberIds: [memberId],
        });
      responseOk(removed);
      assert.equal(removed.body.status, 'ready_unbound');
      assert.equal(removed.body.members.length, 2);
      assert.equal(
        (
          await f.pool.query(
            'SELECT state FROM whaleu_media.upload_request_fences WHERE actor_id=$1 AND client_request_id=$2',
            [actor.accountId, prepare.clientRequestId],
          )
        ).rows[0]?.state,
        'terminal',
      );
      const sealed = await sealBatchPost(
        f,
        actor,
        mediaBatchStatusSchema.parse(removed.body),
      );
      for (const assetIds of [
        [sealed.body.imageAssetIds[0]!],
        [...sealed.body.imageAssetIds].reverse(),
        [...sealed.body.imageAssetIds, sealed.body.imageAssetIds[0]!],
      ]) {
        const wrong = await request(http)
          .post('/v1/community/posts')
          .set('Authorization', auth)
          .send({
            ...sealed.body,
            clientRequestId: randomUUID(),
            imageAssetIds: assetIds,
          });
        assert.ok(wrong.status >= 400 || wrong.body.outcome === 'rejected');
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_media.bindings WHERE asset_id=ANY($1::uuid[])',
              [sealed.body.imageAssetIds],
            )
          ).rowCount,
          0,
        );
      }
      responseOk(
        await request(http)
          .post('/v1/community/posts')
          .set('Authorization', auth)
          .send(sealed.body),
        201,
      );
      const emptyIdentity = {
        version: 1,
        batchRequestId: randomUUID(),
        draftId: randomUUID(),
        spaceId: f.scope.home.spaceId,
        purpose: 'community-post-images',
      };
      const active = await request(http)
        .post('/v3/media/batches/prepare')
        .set('Authorization', auth)
        .send(emptyIdentity);
      responseOk(active);
      for (let ordinal = 0; ordinal < 4; ordinal++) {
        const response = await request(http)
          .post(`/v3/media/batches/${active.body.batchId}/members/prepare`)
          .set('Authorization', auth)
          .send({
            ...prepare,
            clientRequestId: randomUUID(),
            memberId: randomUUID(),
            sourceSlot: ordinal,
          });
        if (ordinal < 3) responseOk(response);
        else assert.ok(response.status >= 400);
      }
      recovery = await request(http)
        .get(`/v3/media/batches/requests/${emptyIdentity.batchRequestId}`)
        .set('Authorization', auth);
      responseOk(recovery);
      assert.equal(recovery.body.status.members.length, 3);
      const ordinary = await f.startOrdinaryRuntime();
      for (const authorized of [false, true]) {
        let call = request(ordinary.getHttpServer()).post(
          '/v3/media/batches/prepare',
        );
        if (authorized) call = call.set('Authorization', auth);
        const response = await call.send({
          ...emptyIdentity,
          batchRequestId: randomUUID(),
          draftId: randomUUID(),
        });
        assert.equal(response.status, authorized ? 503 : 401);
      }
      assert.equal(
        (
          await f.pool.query(
            'SELECT 1 FROM whaleu_media.publication_batches WHERE actor_id=$1',
            [actor.accountId],
          )
        ).rowCount,
        2,
      );
    } finally {
      await f.close();
    }
  },
);

test(
  'batch cleanup skips a locked batch before intent locks and advances another batch without a global reader latch',
  { timeout: 240000 },
  async () => {
    const files = await imageFiles();
    const f = await syntheticMediaRuntimeFixture(
      files.map(({ bytes }) => ({
        sha256: sha256(bytes),
        verdict: 'allow' as const,
      })),
    );
    let holder: import('pg').PoolClient | undefined;
    try {
      const actor = await f.actor();
      const batches = [
        await readyBatch(f, actor, 2, files),
        await readyBatch(f, actor, 2, files),
      ];
      for (const batch of batches) {
        const cancelled = await request(f.app.getHttpServer())
          .post(
            `/v3/media/batches/requests/${batch.identity.batchRequestId}/cancel`,
          )
          .set('Authorization', `Bearer ${actor.accessToken}`)
          .send({
            batchRequestHash: mediaBatchRequestHash(
              actor.accountId,
              batch.identity,
            ),
          });
        responseOk(cancelled);
        assert.equal(cancelled.body.status.status, 'terminal');
      }
      // Respect the original durable two-minute cleanup retention; readiness of
      // unrelated queue work is never manufactured by changing durable deadlines.
      const delay = Number(
        (
          await f.pool.query<{ delay: number }>(
            "SELECT greatest(0,extract(epoch FROM(max(not_before)-clock_timestamp()))*1000)::integer AS delay FROM whaleu_media.cleanup_obligations WHERE state='pending'",
          )
        ).rows[0]!.delay,
      );
      assert.ok(delay >= 0 && delay <= 120000);
      await new Promise((resolve) => setTimeout(resolve, delay + 50));
      holder = await f.pool.connect();
      await holder.query('BEGIN');
      await holder.query(
        'SELECT id FROM whaleu_media.publication_batches WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',
        [batches.map((b) => b.status.batchId)],
      );
      const { inTransaction } = await import('../../src/database/database.js');
      const claim = () =>
        inTransaction(f.pool, async (tx) => {
          await tx.query("SET LOCAL statement_timeout='1000ms'");
          return f.worker.lifecycle.claimCleanup(tx);
        });
      assert.equal(
        await claim(),
        null,
        'Both busy batches are skipped without acquiring their intent locks',
      );
      await holder.query('ROLLBACK');
      await holder.query('BEGIN');
      const blocked = batches[0]!,
        available = batches[1]!;
      await holder.query(
        'SELECT id FROM whaleu_media.publication_batches WHERE id=$1 FOR UPDATE',
        [blocked.status.batchId],
      );
      const leased = await claim();
      assert.ok(
        leased,
        'An unrelated batch remains collectable while another batch is locked',
      );
      const mapped = await f.pool.query(
        `SELECT m.batch_id FROM whaleu_media.cleanup_obligations c
      LEFT JOIN whaleu_media.object_attempts o ON o.id=c.object_attempt_id
      LEFT JOIN whaleu_media.assets a ON a.id=c.asset_id
      LEFT JOIN whaleu_media.derived_object_attempts d ON d.id=c.derived_attempt_id
      LEFT JOIN whaleu_media.upload_ingress_writers w ON w.writer_token=c.ingress_writer_id
      LEFT JOIN whaleu_media.object_attempts wa ON wa.id=w.object_attempt_id
      JOIN whaleu_media.publication_batch_members m ON m.intent_id=coalesce(o.intent_id,a.intent_id,d.intent_id,wa.intent_id)
      WHERE c.id=$1`,
        [leased.id],
      );
      assert.equal(mapped.rows[0]?.batch_id, available.status.batchId);
      await holder.query('ROLLBACK');
      const afterRelease = await claim();
      assert.ok(afterRelease);
      assert.notEqual(
        afterRelease.id,
        leased.id,
        'An active cleanup lease is never claimed twice',
      );
      assert.equal(
        (
          await f.pool.query(
            'SELECT count(*)::integer AS n FROM whaleu_media.bindings WHERE asset_id=ANY($1::uuid[])',
            [batches.flatMap((b) => b.members.map((m) => m.assetId))],
          )
        ).rows[0]?.n,
        0,
      );
    } finally {
      if (holder) {
        await holder.query('ROLLBACK');
        holder.release();
      }
      await f.close();
    }
  },
);
