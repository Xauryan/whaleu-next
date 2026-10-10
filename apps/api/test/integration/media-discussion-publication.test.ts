import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import request from 'supertest';
import { syntheticMediaRuntimeFixture } from '../support/media/runtime-fixture.js';
import {
  readyDiscussionBatch,
  sealDiscussionBatch,
  publishDiscussionPost,
  responseOk,
} from '../support/media/discussion-batch-fixture.js';
import {
  seedReviewPolicy,
  setReviewState,
} from '../support/community-approval-fixtures.js';
import { sha256 } from '../../src/media/processing/protocol.js';
import {
  mediaBatchStatusSchema,
  mediaBatchRecoverySchema,
} from '../../src/media/contracts-v4.js';
import type { DiscussionPublicationTarget } from '../../src/community/discussion/publication-target.js';
import { UpdatesWorker } from '../../src/notifications/worker.js';
import { NotificationsRepository } from '../../src/notifications/repository.js';
import { CommunityUpdatesFacade } from '../../src/community/updates.facade.js';
import { DatabaseService } from '../../src/database/database.js';
import { APP_CONFIG } from '../../src/config/config.js';
import type { RuntimeConfig } from '../../src/config/config.js';

test(
  'v4 actual root/direct reply/reply-to-reply pure and three-image publication uses original atomic Review receipt notice and text search',
  { timeout: 480000 },
  async (t) => {
    const sharp = (await import('sharp')).default;
    const bytes = await sharp({
      create: { width: 80, height: 60, channels: 3, background: '#25496c' },
    })
      .png()
      .toBuffer();
    const f = await syntheticMediaRuntimeFixture([
      { sha256: sha256(bytes), verdict: 'allow' },
    ]);
    try {
      await seedReviewPolicy(f.pool);
      const author = await f.actor(),
        commenter = await f.actor(),
        replier = await f.actor();
      const http = f.app.getHttpServer();
      const auth = (actor: typeof author) => `Bearer ${actor.accessToken}`;
      const postId = await publishDiscussionPost(f, author);
      const published: {
        id: string;
        kind: 'comment' | 'reply';
        text: string;
        assets: string[];
        bindings: string[];
        requestId: string;
      }[] = [];
      const publish = async (
        actor: typeof author,
        target: DiscussionPublicationTarget,
        size: number,
        text: string,
        authorMode: 'named' | 'anonymous' = 'named',
      ) => {
        const ready = await readyDiscussionBatch(f, actor, target, size, [
          { bytes, mime: 'image/png' },
        ]);
        assert.equal(ready.status.resolvedPostId, postId);
        const sealed = await sealDiscussionBatch(
          f,
          actor,
          ready.status,
          text,
          authorMode,
        );
        const send = () =>
          request(http)
            .post(sealed.path)
            .set('Authorization', auth(actor))
            .send(sealed.body);
        if (target.kind === 'comment' && size === 3 && text.length > 0) {
          await f.pool
            .query(`CREATE FUNCTION whaleu_media.fail_discussion_last_binding() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.resource_kind='comment' AND NEW.ordinal=2 THEN RAISE EXCEPTION 'synthetic last member failure';END IF;RETURN NEW;END $$;
          CREATE TRIGGER z_fail_discussion_last_binding AFTER INSERT ON whaleu_media.bindings FOR EACH ROW EXECUTE FUNCTION whaleu_media.fail_discussion_last_binding()`);
          try {
            assert.ok((await send()).status >= 400);
            assert.equal(
              (
                await f.pool.query(
                  'SELECT 1 FROM whaleu_media.bindings WHERE asset_id=ANY($1::uuid[])',
                  [sealed.body.imageAssetIds],
                )
              ).rowCount,
              0,
            );
            assert.equal(
              (
                await f.pool.query(
                  'SELECT 1 FROM whaleu_community.publication_requests WHERE account_id=$1 AND client_request_id=$2',
                  [actor.accountId, sealed.body.clientRequestId],
                )
              ).rowCount,
              0,
            );
          } finally {
            await f.pool.query(
              'DROP TRIGGER z_fail_discussion_last_binding ON whaleu_media.bindings;DROP FUNCTION whaleu_media.fail_discussion_last_binding()',
            );
          }
        }
        const response = await send();
        responseOk(response, 201);
        assert.equal(response.body.outcome, 'created');
        assert.deepEqual((await send()).body, response.body);
        const id = response.body.resourceId as string;
        const read = await request(http)
          .get(
            `/v1/community/${target.kind === 'comment' ? 'comments' : 'replies'}/${id}`,
          )
          .set('Authorization', auth(author));
        responseOk(read);
        assert.equal(read.body.text, text);
        assert.equal(read.body.images.length, size);
        assert.ok(
          read.body.images.every(
            (image: { kind: string; bindingId: string }) =>
              image.kind === 'authenticated-media' && image.bindingId,
          ),
        );
        for (const image of read.body.images) {
          const download = await request(http)
            .get(`/v1/media/bindings/${image.bindingId}/thumb-v1`)
            .set('Authorization', auth(author));
          responseOk(download);
        }
        const recovery = await request(http)
          .get(`/v4/media/batches/requests/${ready.identity.batchRequestId}`)
          .set('Authorization', auth(actor));
        responseOk(recovery);
        const history = mediaBatchRecoverySchema.parse(recovery.body);
        assert.equal(history.state, 'recorded');
        if (
          history.state !== 'recorded' ||
          history.status.status !== 'bound_history'
        )
          throw new Error('Expected exact binding history');
        assert.equal(history.status.resolvedPostId, postId);
        assert.equal(history.status.parent.resourceKind, target.kind);
        assert.equal(history.status.parent.resourceId, id);
        assert.deepEqual(
          history.status.bindings.map((b) => b.ordinal),
          Array.from({ length: size }, (_, i) => i),
        );
        const exact = await request(http)
          .post('/v4/media/batches/recover-publication')
          .set('Authorization', auth(actor))
          .send({
            publication: sealed.publication,
            assetIds: sealed.body.imageAssetIds,
            target,
          });
        responseOk(exact);
        assert.equal(exact.body.state, 'recorded');
        const mismatch = await request(http)
          .post('/v4/media/batches/recover-publication')
          .set('Authorization', auth(actor))
          .send({
            publication: sealed.publication,
            assetIds: sealed.body.imageAssetIds,
            target:
              target.kind === 'comment'
                ? { ...target, postId: randomUUID() }
                : { ...target, targetReplyId: randomUUID() },
          });
        responseOk(mismatch);
        assert.equal(mismatch.body.state, 'unknown');
        const original = await f.pool.query<{ n: number }>(
          'SELECT count(*)::integer n FROM whaleu_community.publication_requests WHERE account_id=$1 AND client_request_id=$2 AND receipt IS NOT NULL',
          [actor.accountId, sealed.body.clientRequestId],
        );
        assert.equal(original.rows[0]!.n, 1);
        const data = {
          id,
          kind: target.kind,
          text,
          assets: sealed.body.imageAssetIds,
          bindings: history.status.bindings.map((b) => b.bindingId),
          requestId: sealed.body.clientRequestId,
        };
        published.push(data);
        return data;
      };
      const rootPure = await publish(
        commenter,
        { kind: 'comment', postId },
        3,
        '',
      );
      const rootThree = await publish(
        commenter,
        { kind: 'comment', postId },
        3,
        'rootneedle with three images',
      );
      const directPure = await publish(
        replier,
        { kind: 'reply', rootCommentId: rootPure.id, targetReplyId: null },
        3,
        '',
      );
      await publish(
        replier,
        { kind: 'reply', rootCommentId: rootThree.id, targetReplyId: null },
        3,
        'replyneedle direct root',
      );
      const targetedPure = await publish(
        author,
        {
          kind: 'reply',
          rootCommentId: rootPure.id,
          targetReplyId: directPure.id,
        },
        3,
        '',
      );
      await publish(
        author,
        { kind: 'reply', rootCommentId: rootThree.id, targetReplyId: null },
        1,
        'anonymousneedle image',
        'anonymous',
      );

      await t.test(
        'original recipient sets and replay materialization stay one effect per event',
        async () => {
          const events = (
            await f.pool.query<{ id: string }>(
              "SELECT id FROM whaleu_community.outbox WHERE resource_id=ANY($1::uuid[]) AND event_type IN ('comment_created','reply_created')",
              [published.map((row) => row.id)],
            )
          ).rows.map((row) => row.id);
          assert.equal(events.length, published.length);
          const worker = new UpdatesWorker(
            f.app.get(DatabaseService),
            {
              ...f.app.get<RuntimeConfig>(APP_CONFIG),
              COMMUNITY_UPDATES_PROCESSING: 'manual_only',
            },
            f.app.get(CommunityUpdatesFacade),
            f.app.get(NotificationsRepository),
          );
          assert.ok(
            (await worker.run({ mode: 'apply', eventIds: events }))
              .materialized > 0,
          );
          const before = await request(http)
            .get('/v1/me/community/updates')
            .set('Authorization', auth(commenter));
          responseOk(before);
          await worker.run({ mode: 'apply', eventIds: events });
          const after = await request(http)
            .get('/v1/me/community/updates')
            .set('Authorization', auth(commenter));
          responseOk(after);
          assert.equal(after.body.unreadCount, before.body.unreadCount);
          assert.ok(
            after.body.items.some(
              (row: { status: string }) => row.status === 'available',
            ),
          );
          assert.doesNotMatch(
            JSON.stringify(after.body),
            /https?:\/\/[^" ]+(?:cos|synthetic)/i,
          );
        },
      );
      await t.test(
        'literal discovery matches real text and never inserts a pure-image placeholder',
        async () => {
          for (const needle of [
            'rootneedle',
            'replyneedle',
            'anonymousneedle',
          ]) {
            const result = await request(http)
              .get('/v1/community/search')
              .set('Authorization', auth(author))
              .query({ spaceId: f.scope.home.spaceId, q: needle, type: 'all' });
            responseOk(result);
            assert.ok(JSON.stringify(result.body).includes(needle));
            assert.ok(!JSON.stringify(result.body).includes(rootPure.id));
          }
          const empty = await f.pool.query<{ text: string }>(
            'SELECT text FROM whaleu_community.root_comments WHERE id=$1 UNION ALL SELECT text FROM whaleu_community.replies WHERE id=ANY($2::uuid[])',
            [rootPure.id, [directPure.id, targetedPure.id]],
          );
          assert.deepEqual(
            empty.rows.map((r) => r.text),
            ['', '', ''],
          );
        },
      );
      await t.test(
        'real second authorization refuses ancestor own-content and sibling changes after exact object open',
        async () => {
          const decision = async (kind: string, id: string) =>
            (
              await f.pool.query<{ decision_id: string }>(
                'SELECT decision_id FROM whaleu_community.content_approval_bindings WHERE content_kind=$1 AND content_id=$2',
                [kind, id],
              )
            ).rows[0]!.decision_id;
          const safety = async (assetId: string, state: 'allow' | 'held') =>
            withCommunityScopeWriter(f.pool, async (tx) => {
              const asset = (
                await tx.query<{
                  manifest_digest: string;
                  policy_revision: string;
                }>(
                  'SELECT manifest_digest,policy_revision FROM whaleu_media.assets WHERE id=$1',
                  [assetId],
                )
              ).rows[0]!;
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
                `INSERT INTO whaleu_media.asset_safety_events(id,asset_id,revision,state,manifest_digest,policy_revision,issuer,source_reference,provenance,effective_at,valid_until) VALUES($1,$2,$3,$4,$5,$6,'registered-synthetic-media',$7,'{}',clock_timestamp()-interval '1 hour',clock_timestamp()+interval '1 hour')`,
                [
                  event,
                  assetId,
                  revision,
                  state,
                  asset.manifest_digest,
                  asset.policy_revision,
                  event,
                ],
              );
              await tx.query(
                'UPDATE whaleu_media.asset_safety_heads SET revision=$2,event_id=$3 WHERE asset_id=$1',
                [assetId, revision, event],
              );
            });
          const postDecision = await decision('post', postId),
            rootDecision = await decision('comment', rootPure.id),
            replyDecision = await decision('reply', targetedPure.id);
          const mutations = [
            {
              deny: () => setReviewState(f.pool, postDecision, 'held'),
              allow: () => setReviewState(f.pool, postDecision, 'allow'),
            },
            {
              deny: () => setReviewState(f.pool, rootDecision, 'held'),
              allow: () => setReviewState(f.pool, rootDecision, 'allow'),
            },
            {
              deny: () => setReviewState(f.pool, replyDecision, 'held'),
              allow: () => setReviewState(f.pool, replyDecision, 'allow'),
            },
            {
              deny: () => safety(targetedPure.assets[2]!, 'held'),
              allow: () => safety(targetedPure.assets[2]!, 'allow'),
            },
          ];
          for (const mutation of mutations) {
            const original = f.storage.openExact.bind(f.storage);
            let opened = 0;
            f.storage.openExact = async (object, maximum) => {
              const stream = await original(object, maximum);
              opened++;
              await mutation.deny();
              return stream;
            };
            try {
              const denied = await request(http)
                .get(`/v1/media/bindings/${targetedPure.bindings[0]}/thumb-v1`)
                .set('Authorization', auth(author));
              assert.equal(
                opened,
                1,
                'First authorization and exact object open actually succeeded',
              );
              assert.ok(denied.status >= 400);
              assert.match(denied.headers['content-type'] ?? '', /json/);
            } finally {
              f.storage.openExact = original;
              await mutation.allow();
            }
          }
        },
      );
      await t.test(
        'deleted target degrades only reference; deleting real root immediately denies descendants',
        async () => {
          responseOk(
            await request(http)
              .delete(`/v1/community/replies/${directPure.id}`)
              .set('Authorization', auth(replier)),
            204,
          );
          const stillVisible = await request(http)
            .get(`/v1/community/replies/${targetedPure.id}`)
            .set('Authorization', auth(author));
          responseOk(stillVisible);
          assert.equal(stillVisible.body.target.status, 'unavailable');
          assert.equal(stillVisible.body.images.length, 3);
          responseOk(
            await request(http)
              .delete(`/v1/community/comments/${rootPure.id}`)
              .set('Authorization', auth(commenter)),
            204,
          );
          assert.ok(
            (
              await request(http)
                .get(`/v1/community/replies/${targetedPure.id}`)
                .set('Authorization', auth(author))
            ).status >= 400,
          );
          assert.ok(
            (
              await request(http)
                .get(`/v1/media/bindings/${targetedPure.bindings[0]}/thumb-v1`)
                .set('Authorization', auth(author))
            ).status >= 400,
          );
          // Historical receipt remains proof of one publication, never renewed access.
          const receipt = await request(http)
            .get(`/v1/me/community/requests/${targetedPure.requestId}`)
            .set('Authorization', auth(author));
          responseOk(receipt);
          assert.equal(receipt.body.outcome, 'created');
          assert.equal(receipt.body.resourceId, targetedPure.id);
        },
      );
      const ordinary = await f.startOrdinaryRuntime();
      const denied = await request(ordinary.getHttpServer())
        .post('/v4/media/batches/prepare')
        .set('Authorization', auth(author))
        .send({
          version: 2,
          batchRequestId: randomUUID(),
          draftId: randomUUID(),
          spaceId: f.scope.home.spaceId,
          purpose: 'community-comment-images',
          target: { kind: 'comment', postId },
        });
      assert.equal(denied.body.error.code, 'MEDIA_UNAVAILABLE');
      assert.ok(!mediaBatchStatusSchema.safeParse(denied.body).success);
    } finally {
      await f.close();
    }
  },
);
