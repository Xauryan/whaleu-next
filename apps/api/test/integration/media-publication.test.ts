import { verifyMediaReaderConcurrency } from '../support/media/reader-concurrency.js';
import { setTimeout as sleep } from 'node:timers/promises';
import { inTransaction } from '../../src/database/database.js';
import { CurrentContentMediaProof } from '../../src/community/content-review/media-proof.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import request from 'supertest';
import { syntheticMediaRuntimeFixture } from '../support/media/runtime-fixture.js';
import { directoryRuntimeFixture } from '../support/directory-runtime-fixture.js';
import {
  approveEnvelope,
  seedReviewPolicy,
} from '../support/community-approval-fixtures.js';
import { postApprovalEnvelope } from '../support/community-runtime-fixtures.js';
import { sha256 } from '../../src/media/processing/protocol.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import { SyntheticMediaCleanup } from '../support/media/synthetic-cleanup.js';

interface FixtureSharp {
  png(): FixtureSharp;
  toBuffer(): Promise<Buffer>;
}
type FixtureFactory = (input: {
  create: {
    width: number;
    height: number;
    channels: 3;
    background: { r: number; g: number; b: number };
  };
}) => FixtureSharp;

test(
  'ordinary AppModule authenticates then keeps Media unavailable',
  { timeout: 120000 },
  async () => {
    const f = await directoryRuntimeFixture();
    try {
      const actor = await f.actor();
      const body = {
        clientRequestId: randomUUID(),
        purpose: 'community-post-image',
        draftId: randomUUID(),
        spaceId: f.scope.home.spaceId,
        slot: 'images',
        ordinal: 0,
        declaration: { mime: 'image/png', bytes: 100 },
      };
      const noAuth = await request(f.app.getHttpServer())
        .post('/v1/media/upload-intents')
        .send(body);
      assert.equal(noAuth.status, 401);
      assert.equal(noAuth.headers['cache-control'], 'private, no-store');
      assert.match(noAuth.headers['vary'] ?? '', /Authorization/);
      const unavailable = await request(f.app.getHttpServer())
        .post('/v1/media/upload-intents')
        .set('Authorization', `Bearer ${actor.accessToken}`)
        .send(body);
      assert.equal(unavailable.status, 503);
      assert.equal(unavailable.headers['cache-control'], 'private, no-store');
      assert.match(unavailable.headers['vary'] ?? '', /Authorization/);
      assert.equal(unavailable.body.error.code, 'MEDIA_UNAVAILABLE');
      assert.equal(
        (await f.pool.query('SELECT 1 FROM whaleu_media.upload_intents'))
          .rowCount,
        0,
      );
    } finally {
      await f.close();
    }
  },
);

test(
  'synthetic single-image Community exact Review, atomic publication, authenticated bytes and revocation',
  {
    timeout: 240000,
  },
  async (t) => {
    const name = 'sharp';
    const imported: unknown = await import(name);
    const sharp = (imported as { default: FixtureFactory }).default;
    const bytes = await sharp({
      create: {
        width: 800,
        height: 600,
        channels: 3,
        background: { r: 20, g: 100, b: 160 },
      },
    })
      .png()
      .toBuffer();
    const f = await syntheticMediaRuntimeFixture([
      { sha256: sha256(bytes), verdict: 'allow' },
    ]);
    try {
      const actor = await f.actor(),
        other = await f.actor(),
        http = f.app.getHttpServer();
      const auth = `Bearer ${actor.accessToken}`;
      const prepare = {
        clientRequestId: randomUUID(),
        purpose: 'community-post-image',
        draftId: randomUUID(),
        spaceId: f.scope.home.spaceId,
        slot: 'images',
        ordinal: 0,
        declaration: { mime: 'image/png', bytes: bytes.length },
      };
      const prepared = await request(http)
        .post('/v1/media/upload-intents')
        .set('Authorization', auth)
        .send(prepare);
      assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
      const intentId = prepared.body.intentId as string;
      const replay = await request(http)
        .post('/v1/media/upload-intents')
        .set('Authorization', auth)
        .send(prepare);
      assert.equal(replay.body.intentId, intentId);
      const cross = await request(http)
        .get(`/v1/media/upload-intents/${intentId}`)
        .set('Authorization', `Bearer ${other.accessToken}`);
      assert.equal(cross.status, 503);
      await f.worker.upload(actor.accountId, intentId, bytes);
      for (const stage of ['seal', 'process', 'review'] as const)
        assert.equal(await f.worker.runOne(stage), true);
      const status = await request(http)
        .get(`/v1/media/upload-intents/${intentId}`)
        .set('Authorization', auth);
      assert.equal(status.status, 200, JSON.stringify(status.body));
      assert.equal(status.body.status, 'ready');
      const assetId = status.body.assetId as string;
      const body = {
        clientRequestId: randomUUID(),
        spaceId: f.scope.home.spaceId,
        category: 'discussion' as const,
        text: 'Synthetic single image publication',
        imageAssetIds: [assetId],
        authorMode: 'named' as const,
        commentsPolicy: 'open' as const,
      };
      const unapproved = await request(http)
        .post('/v1/community/posts')
        .set('Authorization', auth)
        .send(body);
      assert.equal(unapproved.status, 503);
      assert.equal(unapproved.body.error.code, 'CONTENT_REVIEW_UNAVAILABLE');
      assert.equal(
        (await f.pool.query('SELECT 1 FROM whaleu_media.bindings')).rowCount,
        0,
      );
      const asset = (
        await f.pool.query<{ manifest_digest: string }>(
          'SELECT manifest_digest FROM whaleu_media.assets WHERE id=$1',
          [assetId],
        )
      ).rows[0]!;
      await seedReviewPolicy(f.pool);
      const envelope = await postApprovalEnvelope(
        f.app,
        f.pool,
        actor.accountId,
        body,
      );
      await approveEnvelope(f.pool, {
        ...envelope,
        images: [{ assetId, digest: asset.manifest_digest }],
      });
      const published = await request(http)
        .post('/v1/community/posts')
        .set('Authorization', auth)
        .send(body);
      assert.equal(published.status, 201, JSON.stringify(published.body));
      const again = await request(http)
        .post('/v1/community/posts')
        .set('Authorization', auth)
        .send(body);
      assert.deepEqual(again.body, published.body);
      const binding = (
        await f.pool.query<{ id: string; resource_id: string }>(
          'SELECT id,resource_id FROM whaleu_media.bindings WHERE asset_id=$1',
          [assetId],
        )
      ).rows[0]!;
      assert.equal(
        (await f.pool.query('SELECT 1 FROM whaleu_media.scope_consumptions'))
          .rowCount,
        1,
      );
      await verifyMediaReaderConcurrency(
        t,
        f.pool,
        {
          actorId: actor.accountId,
          intentId,
          assetId,
          digest: asset.manifest_digest,
          postId: binding.resource_id,
        },
        async () => {
          const responses = await Promise.all([
            request(http)
              .get(`/v1/community/posts/${binding.resource_id}`)
              .set('Authorization', auth),
            request(http)
              .get(`/v1/me/safety/report-progress/post/${binding.resource_id}`)
              .set('Authorization', auth),
          ]);
          for (const response of responses)
            assert.equal(response.status, 200, JSON.stringify(response.body));
        },
      );
      const detail = await request(http)
        .get(`/v1/community/posts/${binding.resource_id}`)
        .set('Authorization', auth);
      assert.equal(detail.status, 200, JSON.stringify(detail.body));
      assert.equal(JSON.stringify(detail.body).includes('displayUrl'), false);
      const list = await request(http)
        .get('/v1/community/posts')
        .query({ spaceId: f.scope.home.spaceId })
        .set('Authorization', auth);
      assert.equal(list.status, 200, JSON.stringify(list.body));
      assert.ok(
        list.body.items.some(
          (item: { id: string }) => item.id === binding.resource_id,
        ),
      );
      const download = await request(http)
        .get(`/v1/media/bindings/${binding.id}/display-v1`)
        .set('Authorization', auth);
      assert.equal(download.status, 200);
      assert.equal(download.headers['cache-control'], 'private, no-store');
      const variant = (
        await f.pool.query<{ sha256: string }>(
          "SELECT sha256 FROM whaleu_media.variants WHERE asset_id=$1 AND variant_name='display-v1'",
          [assetId],
        )
      ).rows[0]!;
      assert.equal(sha256(download.body as Buffer), variant.sha256);
      assert.equal(
        (await request(http).get(`/v1/media/bindings/${binding.id}/display-v1`))
          .status,
        401,
      );
      assert.equal(
        (
          await request(http)
            .get(`/v1/media/bindings/${binding.id}/display-v1`)
            .set('Authorization', auth)
            .set('Range', 'bytes=0-1')
        ).status,
        503,
      );
      const appendSafety = async (
        state: 'allow' | 'held' | 'revoked',
        lifetime = 3600,
      ) =>
        withCommunityScopeWriter(f.pool, async (tx) => {
          const revision =
            Number(
              (
                await tx.query<{ revision: string }>(
                  'SELECT revision FROM whaleu_media.asset_safety_heads WHERE asset_id=$1 FOR UPDATE',
                  [assetId],
                )
              ).rows[0]!.revision,
            ) + 1;
          const event = randomUUID();
          await tx.query(
            `INSERT INTO whaleu_media.asset_safety_events
            (id,asset_id,revision,state,manifest_digest,policy_revision,issuer,source_reference,provenance,effective_at,valid_until)
            VALUES($1,$2,$3,$4,$5,'media-static-v1','registered-synthetic-media',$6,'{}',
              clock_timestamp()-interval '2 hours',clock_timestamp()+$7::double precision*interval '1 second')`,
            [
              event,
              assetId,
              revision,
              state,
              asset.manifest_digest,
              `${state}:${event}`,
              lifetime,
            ],
          );
          await tx.query(
            'UPDATE whaleu_media.asset_safety_heads SET revision=$2,event_id=$3 WHERE asset_id=$1',
            [assetId, revision, event],
          );
        });
      await appendSafety('held');
      assert.ok(
        (
          await request(http)
            .get(`/v1/media/bindings/${binding.id}/display-v1`)
            .set('Authorization', auth)
        ).status >= 400,
      );
      const heldDetail = await request(http)
        .get(`/v1/community/posts/${binding.resource_id}`)
        .set('Authorization', auth);
      assert.equal(heldDetail.status, 404);
      const heldList = await request(http)
        .get('/v1/community/posts')
        .query({ spaceId: f.scope.home.spaceId })
        .set('Authorization', auth);
      assert.equal(heldList.status, 200);
      assert.equal(heldList.body.items.length, 0);
      assert.equal(JSON.stringify(heldList.body).includes(assetId), false);
      const heldReplay = await request(http)
        .post('/v1/community/posts')
        .set('Authorization', auth)
        .send(body);
      assert.deepEqual(
        heldReplay.body,
        published.body,
        'command receipt records historical success without reauthorizing content or bytes',
      );
      assert.ok(
        (
          await request(http)
            .post(`/v1/media/upload-intents/${intentId}/cancel`)
            .set('Authorization', auth)
            .send({})
        ).status >= 400,
        'bound cancellation must use owner deletion',
      );
      // A filtered denial is still a required fact. Rolling back its DB locks
      // does not erase that fact; a concurrent allow must invalidate finalization.
      const mediaProof = new CurrentContentMediaProof();
      await assert.rejects(
        inTransaction(
          f.pool,
          async (tx) => {
            await tx.query('SAVEPOINT denied_media');
            assert.deepEqual(
              await mediaProof.current(
                'post',
                binding.resource_id,
                [{ assetId, digest: asset.manifest_digest }],
                tx,
              ),
              { kind: 'deny', reason: 'POST_NOT_FOUND' },
            );
            await tx.query('ROLLBACK TO SAVEPOINT denied_media');
            await appendSafety('allow');
          },
          { isolationLevel: 'read committed' },
        ),
        /Media|media/,
      );
      assert.equal(
        (
          await request(http)
            .get(`/v1/community/posts/${binding.resource_id}`)
            .set('Authorization', auth)
        ).status,
        200,
      );
      await appendSafety('revoked');
      const revokedList = await request(http)
        .get('/v1/community/posts')
        .query({ spaceId: f.scope.home.spaceId })
        .set('Authorization', auth);
      assert.equal(revokedList.status, 200);
      assert.equal(revokedList.body.items.length, 0);
      await appendSafety('held', -1);
      const expiredList = await request(http)
        .get('/v1/community/posts')
        .query({ spaceId: f.scope.home.spaceId })
        .set('Authorization', auth);
      assert.equal(
        expiredList.status,
        503,
        'expired denial is unknown, not an empty page',
      );
      await appendSafety('held', 1);
      await assert.rejects(
        inTransaction(
          f.pool,
          async (tx) => {
            assert.equal(
              (
                await mediaProof.current(
                  'post',
                  binding.resource_id,
                  [{ assetId, digest: asset.manifest_digest }],
                  tx,
                )
              ).kind,
              'deny',
            );
            await sleep(1100);
          },
          { isolationLevel: 'read committed' },
        ),
        /Media|media/,
      );
      await appendSafety('held');
      // Providers can become unavailable after publication. The ordinary app
      // must still perform authorized, atomic DB-only owner deletion.
      const ordinary = await f.startOrdinaryRuntime();
      const ordinaryHttp = ordinary.getHttpServer();
      const disabled = await request(ordinaryHttp)
        .get(`/v1/media/upload-intents/${intentId}`)
        .set('Authorization', auth);
      assert.equal(disabled.status, 503);
      const deleteState = async () =>
        (
          await f.pool.query<{ state: unknown }>(
            `SELECT jsonb_build_object(
          'post',(SELECT to_jsonb(p) FROM whaleu_community.posts p WHERE id=$1),
          'binding',(SELECT to_jsonb(b) FROM whaleu_media.bindings b WHERE id=$2),
          'intent',(SELECT to_jsonb(i) FROM whaleu_media.upload_intents i WHERE id=$3),
          'cleanup',(SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.id),'[]'::jsonb) FROM whaleu_media.cleanup_obligations c),
          'events',(SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY e.id),'[]'::jsonb) FROM whaleu_community.outbox e WHERE resource_id=$1)
        ) AS state`,
            [binding.resource_id, binding.id, intentId],
          )
        ).rows[0]!.state;
      const beforeDelete = await deleteState();
      const foreignDelete = await request(ordinaryHttp)
        .delete(`/v1/community/posts/${binding.resource_id}`)
        .set('Authorization', `Bearer ${other.accessToken}`);
      assert.equal(foreignDelete.status, 404);
      assert.deepEqual(await deleteState(), beforeDelete);
      await f.pool.query(`CREATE FUNCTION whaleu_media.test_fail_delete_outbox()
        RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
          IF NEW.event_type='post_deleted' THEN RAISE EXCEPTION 'synthetic outbox failure'; END IF;
          RETURN NEW;
        END $$;
        CREATE TRIGGER test_fail_media_delete BEFORE INSERT ON whaleu_community.outbox
        FOR EACH ROW EXECUTE FUNCTION whaleu_media.test_fail_delete_outbox()`);
      try {
        const failedDelete = await request(ordinaryHttp)
          .delete(`/v1/community/posts/${binding.resource_id}`)
          .set('Authorization', auth);
        assert.equal(failedDelete.status, 500);
        assert.deepEqual(
          await deleteState(),
          beforeDelete,
          'failed outbox must roll back logical deletion, binding and cleanup together',
        );
      } finally {
        await f.pool
          .query(`DROP TRIGGER test_fail_media_delete ON whaleu_community.outbox;
          DROP FUNCTION whaleu_media.test_fail_delete_outbox()`);
      }
      const deleted = await request(ordinaryHttp)
        .delete(`/v1/community/posts/${binding.resource_id}`)
        .set('Authorization', auth);
      assert.equal(deleted.status, 204, JSON.stringify(deleted.body));
      const deletedState = await deleteState();
      assert.equal(
        (
          await request(ordinaryHttp)
            .delete(`/v1/community/posts/${binding.resource_id}`)
            .set('Authorization', auth)
        ).status,
        204,
      );
      assert.deepEqual(
        await deleteState(),
        deletedState,
        'delete replay is stable',
      );
      const detached = (
        await f.pool.query<{ detached: boolean; state: string }>(
          `
        SELECT b.detached_at IS NOT NULL AS detached,i.state
        FROM whaleu_media.bindings b JOIN whaleu_media.assets a ON a.id=b.asset_id
        JOIN whaleu_media.upload_intents i ON i.id=a.intent_id WHERE b.id=$1`,
          [binding.id],
        )
      ).rows[0]!;
      assert.equal(detached.detached, true);
      assert.equal(detached.state, 'cleanup_pending');
      const obligations = await f.pool.query<{ state: string }>(
        'SELECT state FROM whaleu_media.cleanup_obligations',
      );
      assert.ok(obligations.rows.length > 0);
      assert.ok(
        obligations.rows.every((row) => row.state === 'pending'),
        'provider-disabled logical deletion never claims physical deletion',
      );
      assert.ok(
        (
          await request(http)
            .get(`/v1/media/bindings/${binding.id}/display-v1`)
            .set('Authorization', auth)
        ).status >= 400,
      );
      // A distinct unbound upload can be cancelled and exactly collected. Time is
      // advanced via legal scheduling before retirement, never treated as quiescence.
      const pending = await request(http)
        .post('/v1/media/upload-intents')
        .set('Authorization', auth)
        .send({
          ...prepare,
          clientRequestId: randomUUID(),
          draftId: randomUUID(),
        });
      assert.equal(pending.status, 200);
      await f.worker.upload(
        actor.accountId,
        pending.body.intentId as string,
        bytes,
      );
      const cancelled = await request(http)
        .post(
          `/v1/media/upload-intents/${pending.body.intentId as string}/cancel`,
        )
        .set('Authorization', auth)
        .send({});
      assert.equal(cancelled.status, 204);
      // The two-minute durable retention remains in force here. Immediate cleanup
      // is correctly idle; later tests must wait/advance controlled DB time legally.
      assert.equal(
        await new SyntheticMediaCleanup(f.pool, f.storage).runOne(),
        'idle',
      );
      const delay = Number(
        (
          await f.pool.query<{ delay: number }>(
            "SELECT greatest(0,extract(epoch FROM(max(not_before)-clock_timestamp()))*1000)::integer AS delay FROM whaleu_media.cleanup_obligations WHERE state='pending'",
          )
        ).rows[0]!.delay,
      );
      assert.ok(delay >= 0 && delay <= 120000);
      await sleep(delay + 50);
      const cleanup = new SyntheticMediaCleanup(f.pool, f.storage);
      const exactObjects = (
        await f.pool.query<{
          provider: string;
          environment: string;
          bucket: string;
          key: string;
          version: string;
        }>(
          'SELECT provider,environment,bucket,object_key AS key,object_version AS version FROM whaleu_media.cleanup_obligations',
        )
      ).rows;
      let cleaned = 0;
      while (cleaned <= exactObjects.length) {
        const result = await cleanup.runOne();
        if (result === 'idle') break;
        assert.equal(result, 'deleted');
        cleaned++;
      }
      assert.equal(cleaned, exactObjects.length);
      for (const object of exactObjects)
        await assert.rejects(f.storage.measure(object));
      assert.equal(
        (
          await f.pool.query(
            "SELECT 1 FROM whaleu_media.cleanup_obligations WHERE state<>'deleted' OR confirmed_deleted_at IS NULL",
          )
        ).rowCount,
        0,
      );
    } finally {
      await f.close();
    }
  },
);
