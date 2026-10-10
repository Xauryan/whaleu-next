import { APP_CONFIG, type RuntimeConfig } from '../../src/config/config.js';
import { DatabaseService } from '../../src/database/database.js';
import { RatingsUpdatesSourceFacade } from '../../src/ratings/updates-source/facade.js';
import { RatingUpdatesProjectionFacade } from '../../src/ratings/updates-source/projection.js';
import { RatingUpdatesRepository } from '../../src/notifications/ratings/repository.js';
import { RatingUpdatesWorker } from '../../src/notifications/ratings/worker.js';
import { RatingsSubscriptionUpdatesSourceFacade } from '../../src/ratings/updates-source/subscription-facade.js';
import { RatingSubscriptionUpdatesProjectionFacade } from '../../src/ratings/updates-source/subscription-projection.js';
import { RatingSubscriptionUpdatesRepository } from '../../src/notifications/ratings/subscription-repository.js';
import { RatingSubscriptionUpdatesWorker } from '../../src/notifications/ratings/subscription-worker.js';
import { ratingDiscussionNoticeSchema } from '../../src/notifications/ratings/discussion-media-contracts.js';
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import request from 'supertest';
import {
  syntheticRatingDiscussionFixture,
  writeSyntheticDiscussionApproval,
  discussionHttpOk,
} from '../support/media/ratings-discussion-runtime-fixture.js';
import { sha256 } from '../../src/media/processing/protocol.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import {
  ratingDiscussionMediaRootSchema,
  ratingDiscussionMediaReplySchema,
} from '../../src/ratings/discussion-media-projection-contracts.js';
import {
  ratingDiscussionMediaCommandHash,
  ratingDiscussionMediaReceiptSchema,
} from '../../src/ratings/scoped/discussion-media-contracts.js';
import { RatingDiscussionMediaService } from '../../src/ratings/discussion-media.service.js';
/** Static acceptance source. Execute only under the exclusive heavy lease. */
test(
  'discussion9/reply3 use original commands, real processing, whole current content and durable owner cleanup',
  { timeout: 480000 },
  async (t) => {
    const sharp = (await import('sharp')).default;
    const bytes = await sharp({
      create: { width: 48, height: 36, channels: 3, background: '#4875a2' },
    })
      .png()
      .toBuffer();
    const f = await syntheticRatingDiscussionFixture([
      { sha256: sha256(bytes), verdict: 'allow' },
    ]);
    t.after(() => f.close());
    const author = f.creator,
      replyAuthor = await f.actor(),
      subscriber = await f.actor();
    const subscription = await f.scopedRead(
      subscriber,
      `/v2/ratings/targets/${f.target.id}/subscription`,
    );
    assert.equal(subscription.status, 'known');
    const subscribed = await f.executeCommand(
      subscriber,
      await f.commandIntent(subscriber, 'set_target_subscription_scoped', {
        targetId: f.target.id,
        expectedTargetRevision: f.target.revision,
        expectedSubscriptionRevision: subscription.revision,
        subscribed: true,
      }),
    );
    assert.equal(subscribed.receipt.outcome, 'applied');
    const readRoot = async (id: string) => {
      const context = await f.context(author, 'read');
      const response = await f
        .auth(
          request(f.http).get(`/v4/ratings/discussion/comments/${id}`),
          author,
        )
        .query({ contextId: context.id, contextToken: context.token });
      return response;
    };
    const imageQuery = (image: {
      protocol: string;
      targetId: string;
      rootId: string;
      replyId: string | null;
      subjectRevision: string;
      contextId: string;
      contextToken: string;
      bindingId: string;
      ordinal: number;
      attachmentSetDigest: string;
    }) => ({
      protocol: image.protocol,
      targetId: image.targetId,
      rootId: image.rootId,
      replyId: image.replyId ?? 'null',
      subjectRevision: image.subjectRevision,
      contextId: image.contextId,
      contextToken: image.contextToken,
      bindingId: image.bindingId,
      ordinal: image.ordinal,
      attachmentSetDigest: image.attachmentSetDigest,
      variant: 'display-v1',
    });
    const imageGet = (image: Parameters<typeof imageQuery>[0]) =>
      f
        .auth(
          request(f.http).get('/v3/media/ratings-discussion/images'),
          author,
        )
        .query(imageQuery(image));
    let rootId = '',
      rootRevision = '',
      replyId = '',
      replyRevision = '';
    let rootImages: ReturnType<
      typeof ratingDiscussionMediaRootSchema.parse
    >['images'] = [];
    await t.test(
      'ordinary module has no runtime; nine-image pure root commits one exact receipt',
      async () => {
        assert.equal(f.baseApp.get(RatingDiscussionMediaService).runtime, null);
        const upload = await f.ready(
          author,
          await f.draft(author),
          Array.from({ length: 9 }, () => bytes),
        );
        assert.equal(upload.intent.payload.body, '');
        assert.equal(upload.intent.payload.images.length, 9);
        const done = await f.execute(author, upload.intent);
        assert.equal(done.receipt.operation, 'create_comment_scoped');
        if (done.receipt.operation !== 'create_comment_scoped')
          assert.fail('root receipt');
        rootId = done.receipt.result.subjectId;
        rootRevision = done.receipt.result.revision;
        const replay = await f.commit(
          author,
          upload.intent,
          done.prepared.contextRevision,
        );
        discussionHttpOk(replay);
        assert.deepEqual(replay.body, done.receipt);
        const recovered = await f.auth(
          request(f.http).get(
            `/v4/ratings/discussion/receipts/${upload.intent.payload.clientRequestId}`,
          ),
          author,
        );
        discussionHttpOk(recovered);
        assert.deepEqual(recovered.body, done.receipt);
        const counts = (
          await f.pool.query<{
            subjects: number;
            transitions: number;
            reviews: number;
            bindings: number;
            events: number;
          }>(
            `SELECT
      (SELECT count(*)::int FROM whaleu_ratings.comments WHERE id=$1) subjects,
      (SELECT count(*)::int FROM whaleu_ratings.comment_transitions WHERE comment_id=$1 AND operation='create_comment') transitions,
      (SELECT count(*)::int FROM whaleu_community.rating_discussion_media_bindings WHERE subject_id=$1) reviews,
      (SELECT count(*)::int FROM whaleu_media.bindings WHERE owner_kind='ratings' AND resource_kind='rating_comment' AND resource_id=$1 AND detached_at IS NULL) bindings,
      (SELECT count(*)::int FROM whaleu_ratings.effect_events WHERE root_id=$1 AND event_kind='root_created') events`,
            [rootId],
          )
        ).rows[0]!;
        assert.deepEqual(counts, {
          subjects: 1,
          transitions: 1,
          reviews: 1,
          bindings: 9,
          events: 1,
        });
        const read = await readRoot(rootId);
        discussionHttpOk(read);
        const view = ratingDiscussionMediaRootSchema.parse(read.body);
        rootImages = view.images;
        assert.equal(view.body, '');
        assert.equal(view.images.length, 9);
        assert.deepEqual(
          view.images.map((x) => x.ordinal),
          [0, 1, 2, 3, 4, 5, 6, 7, 8],
        );
        assert.equal((await imageGet(rootImages[0]!)).status, 200);
        const legacy = await f.scopedContext(author, { kind: 'global' });
        const old = await f
          .auth(request(f.http).get(`/v2/ratings/comments/${rootId}`), author)
          .query({ contextId: legacy.id, contextToken: legacy.token });
        assert.notEqual(
          old.status,
          200,
          'legacy required content cannot become a blank success',
        );
      },
    );
    await t.test(
      'three-image pure reply accepts original root but never an image-only subset',
      async () => {
        const upload = await f.ready(
          replyAuthor,
          await f.draft(replyAuthor, { id: rootId, revision: rootRevision }),
          [bytes, bytes, bytes],
        );
        const done = await f.execute(replyAuthor, upload.intent);
        if (done.receipt.operation !== 'create_reply_scoped')
          assert.fail('reply receipt');
        replyId = done.receipt.result.replyId;
        replyRevision = done.receipt.result.revision;
        const c = await f.context(author, 'read');
        const response = await f
          .auth(
            request(f.http).get(`/v4/ratings/discussion/replies/${replyId}`),
            author,
          )
          .query({ contextId: c.id, contextToken: c.token });
        discussionHttpOk(response);
        const view = ratingDiscussionMediaReplySchema.parse(response.body);
        assert.equal(view.body, '');
        assert.equal(view.images.length, 3);
        assert.equal(view.rootId, rootId);
        const forged = await imageGet({
          ...view.images[0]!,
          ordinal: 2,
          bindingId: view.images[0]!.bindingId,
        });
        assert.notEqual(forged.status, 200);
        const count = (
          await f.pool.query<{ count: number }>(
            'SELECT count(*)::int count FROM whaleu_ratings.like_subjects WHERE id=ANY($1::uuid[])',
            [[rootId, replyId]],
          )
        ).rows[0]!.count;
        assert.equal(count, 2, 'same native like enrollment');
      },
    );
    await t.test(
      'original like/subscription and exact media notice materialization remain single-owner',
      async () => {
        const c = await f.context(replyAuthor, 'read');
        const current = await f
          .auth(
            request(f.http).get(
              `/v4/ratings/discussion/likes/comment/${rootId}`,
            ),
            replyAuthor,
          )
          .query({ contextId: c.id, contextToken: c.token });
        discussionHttpOk(current);
        assert.equal(current.body.status, 'known');
        const liked = await f.executeCommand(
          replyAuthor,
          await f.commandIntent(replyAuthor, 'set_comment_like_scoped', {
            targetId: f.target.id,
            expectedTargetRevision: f.target.revision,
            rootId,
            expectedRevision: rootRevision,
            expectedLikeRevision: current.body.revision,
            liked: true,
          }),
        );
        assert.equal(liked.receipt.outcome, 'applied');
        const config = {
          ...f.app.get<RuntimeConfig>(APP_CONFIG),
          RATINGS_UPDATES_PROCESSING: 'manual' as const,
        };
        const worker = new RatingUpdatesWorker(
          f.app.get(DatabaseService),
          config,
          f.app.get(RatingsUpdatesSourceFacade),
          f.app.get(RatingUpdatesProjectionFacade),
          f.app.get(RatingUpdatesRepository),
        );
        const subscriptionWorker = new RatingSubscriptionUpdatesWorker(
          f.app.get(DatabaseService),
          config,
          f.app.get(RatingsSubscriptionUpdatesSourceFacade),
          f.app.get(RatingSubscriptionUpdatesProjectionFacade),
          f.app.get(RatingSubscriptionUpdatesRepository),
        );
        const events = (
          await f.pool.query<{ id: string; event_kind: string }>(
            "SELECT id,event_kind FROM whaleu_ratings.effect_events WHERE root_id=$1 AND event_kind IN ('root_created','reply_created','content_liked') ORDER BY event_sequence",
            [rootId],
          )
        ).rows;
        const direct = await worker.run({
          mode: 'apply',
          eventIds: events
            .filter((e) => e.event_kind !== 'root_created')
            .map((e) => e.id),
        });
        assert.equal(direct.failed, 0);
        await subscriptionWorker.run({
          mode: 'apply',
          eventIds: events
            .filter((e) => e.event_kind !== 'content_liked')
            .map((e) => e.id),
          maxPages: 10,
          maxRecipients: 100,
        });
        const notices = (
          await f.pool.query<{
            id: string;
            recipient_account_id: string;
            kind: string;
          }>(
            'SELECT id,recipient_account_id,kind FROM whaleu_notifications.rating_notices WHERE root_id=$1 ORDER BY id',
            [rootId],
          )
        ).rows;
        assert.ok(notices.length >= 2);
        for (const notice of notices) {
          const recipient =
              notice.recipient_account_id === author.accountId
                ? author
                : replyAuthor,
            context = await f.context(recipient, 'read');
          const response = await f
            .auth(
              request(f.http).get(
                `/v4/ratings/discussion/notices/${notice.kind === 'like' ? 'like-updates' : 'updates'}/${notice.id}`,
              ),
              recipient,
            )
            .query({ contextId: context.id, contextToken: context.token });
          discussionHttpOk(response);
          const view = ratingDiscussionNoticeSchema.parse(response.body);
          assert.equal(view.status, 'available');
          if (view.status === 'available') {
            assert.equal(view.preview.body, '');
            assert.equal(
              view.preview.imageCount,
              notice.kind === 'like' ? 9 : 3,
            );
            assert.ok(view.preview.thumbnail);
          }
        }
        const subscriptionNotices = (
          await f.pool.query<{ count: number }>(
            'SELECT count(*)::int count FROM whaleu_notifications.rating_subscription_notices WHERE recipient_account_id=$1 AND root_id=$2',
            [subscriber.accountId, rootId],
          )
        ).rows[0]!.count;
        assert.equal(
          subscriptionNotices,
          2,
          'root and reply each produce one original subscription obligation',
        );
      },
    );
    await t.test(
      'failure after whole-set finish rolls back original content, Review, Media, effects and receipt together',
      async () => {
        const rollbackActor = await f.actor();
        const upload = await f.ready(
          rollbackActor,
          await f.draft(rollbackActor),
          [bytes],
        );
        const prepared = await f.prepare(rollbackActor, upload.intent);
        await writeSyntheticDiscussionApproval(f.pool, prepared.envelope);
        const original = f.media.assets.finish;
        f.media.assets.finish = async (
          ...args: Parameters<typeof original>
        ) => {
          await original.apply(f.media.assets, args);
          throw new Error('synthetic post-finish rollback');
        };
        try {
          assert.notEqual(
            (
              await f.commit(
                rollbackActor,
                upload.intent,
                prepared.prepared.contextRevision,
              )
            ).status,
            200,
          );
        } finally {
          f.media.assets.finish = original;
        }
        const id = upload.intent.payload.clientRequestId;
        const state = (
          await f.pool.query<{
            state: string;
            parents: number;
            reviews: number;
            effects: number;
            requests: number;
            bindings: number;
          }>(
            `SELECT b.state,
      (SELECT count(*)::int FROM whaleu_ratings.comments WHERE account_id=$1 AND request_id=$2) parents,
      (SELECT count(*)::int FROM whaleu_community.rating_discussion_media_bindings WHERE account_id=$1 AND envelope->>'clientRequestId'=$2::text) reviews,
      (SELECT count(*)::int FROM whaleu_ratings.effect_events WHERE actor_account_id=$1 AND request_id=$2) effects,
      (SELECT count(*)::int FROM whaleu_ratings.requests WHERE account_id=$1 AND request_id=$2) requests,
      (SELECT count(*)::int FROM whaleu_media.bindings WHERE resource_id=$4) bindings
      FROM whaleu_media.ratings_discussion_batches b WHERE b.id=$3`,
            [
              rollbackActor.accountId,
              id,
              upload.batch.batchId,
              prepared.envelope.subjectId,
            ],
          )
        ).rows[0]!;
        assert.deepEqual(state, {
          state: 'sealed',
          parents: 0,
          reviews: 0,
          effects: 0,
          requests: 0,
          bindings: 0,
        });
        discussionHttpOk(
          await f.commit(
            rollbackActor,
            upload.intent,
            prepared.prepared.contextRevision,
          ),
        );
      },
    );
    await t.test(
      'hash cancellation races the original commit and both observe one terminal receipt',
      async () => {
        const intent = await f.draft(author),
          prepared = await f.prepare(author, intent);
        await writeSyntheticDiscussionApproval(f.pool, prepared.envelope);
        const [commit, cancel] = await Promise.all([
          f.commit(author, intent, prepared.prepared.contextRevision),
          f
            .auth(
              request(f.http).post(
                `/v4/ratings/discussion/requests/${intent.payload.clientRequestId}/cancel`,
              ),
              author,
            )
            .send({
              protocolVersion: 4,
              operation: intent.operation,
              intentHash: ratingDiscussionMediaCommandHash(intent),
            }),
        ]);
        discussionHttpOk(commit);
        discussionHttpOk(cancel);
        assert.deepEqual(commit.body, cancel.body);
        const count = (
          await f.pool.query<{ count: number }>(
            'SELECT count(*)::int count FROM whaleu_ratings.comments WHERE account_id=$1 AND request_id=$2',
            [author.accountId, intent.payload.clientRequestId],
          )
        ).rows[0]!.count;
        assert.equal(count, commit.body.outcome === 'applied' ? 1 : 0);
      },
    );
    await t.test(
      'second non-preview asset Safety change denies every image and the whole root/reply chain',
      async () => {
        const pending: Array<{
          intent: Awaited<ReturnType<typeof f.draft>>;
          prepared: Awaited<ReturnType<typeof f.prepare>>;
        }> = [];
        for (let index = 0; index < 2; index++) {
          const intent = await f.draft(replyAuthor, {
              id: rootId,
              revision: rootRevision,
            }),
            prepared = await f.prepare(replyAuthor, intent);
          await writeSyntheticDiscussionApproval(f.pool, prepared.envelope);
          pending.push({ intent, prepared });
        }
        const assets = (
          await f.pool.query<{ asset_id: string }>(
            "SELECT asset_id FROM whaleu_media.bindings WHERE owner_kind='ratings' AND resource_kind='rating_comment' AND resource_id=$1 ORDER BY ordinal",
            [rootId],
          )
        ).rows;
        for (const state of ['held', 'unknown'] as const) {
          await withCommunityScopeWriter(f.pool, async (tx) => {
            const row = (
              await tx.query<{
                revision: string;
                manifest_digest: string;
                policy_revision: string;
              }>(
                'SELECT h.revision::text,a.manifest_digest,a.policy_revision FROM whaleu_media.assets a JOIN whaleu_media.asset_safety_heads h ON h.asset_id=a.id WHERE a.id=$1 FOR UPDATE OF a,h',
                [assets[7]!.asset_id],
              )
            ).rows[0]!;
            const event = randomUUID(),
              revision = String(BigInt(row.revision) + 1n);
            await tx.query(
              "INSERT INTO whaleu_media.asset_safety_events(id,asset_id,revision,state,manifest_digest,policy_revision,issuer,source_reference,provenance,effective_at,valid_until) VALUES($1::uuid,$2,$3,$4,$5,$6,'synthetic-discussion-safety',$1::text,'{}',clock_timestamp(),clock_timestamp()+interval '1 hour')",
              [
                event,
                assets[7]!.asset_id,
                revision,
                state,
                row.manifest_digest,
                row.policy_revision,
              ],
            );
            await tx.query(
              'UPDATE whaleu_media.asset_safety_heads SET revision=$2,event_id=$3 WHERE asset_id=$1',
              [assets[7]!.asset_id, revision, event],
            );
          });
          const delayed = pending[state === 'held' ? 0 : 1]!;
          const late = await f.commit(
            replyAuthor,
            delayed.intent,
            delayed.prepared.prepared.contextRevision,
          );
          if (state === 'held') {
            discussionHttpOk(late);
            assert.equal(late.body.outcome, 'closed');
          } else
            assert.notEqual(
              late.status,
              200,
              'unknown ancestor remains unknown rather than a publishable cached preparation',
            );
          assert.equal(
            (
              await f.pool.query<{ n: number }>(
                'SELECT count(*)::int n FROM whaleu_ratings.replies WHERE account_id=$1 AND request_id=$2',
                [replyAuthor.accountId, delayed.intent.payload.clientRequestId],
              )
            ).rows[0]!.n,
            0,
          );
          assert.notEqual(
            (await imageGet(rootImages[0]!)).status,
            200,
            'first thumbnail is not sufficient authority',
          );
          assert.notEqual((await readRoot(rootId)).status, 200);
          const c = await f.context(author, 'read');
          assert.notEqual(
            (
              await f
                .auth(
                  request(f.http).get(
                    `/v4/ratings/discussion/replies/${replyId}`,
                  ),
                  author,
                )
                .query({ contextId: c.id, contextToken: c.token })
            ).status,
            200,
          );
        }
      },
    );
    await t.test(
      'owner deletion is available without Media read and independently drains all descendant sets',
      async () => {
        const removed = await f
          .auth(
            request(f.http).delete(`/v1/ratings/comments/${rootId}`),
            author,
          )
          .send({
            clientRequestId: randomUUID(),
            regionId: null,
            targetId: f.target.id,
            expectedTargetRevision: f.target.revision,
            expectedRevision: rootRevision,
          });
        discussionHttpOk(removed);
        assert.equal(removed.body.outcome, 'applied');
        while (await f.media.cleanupOne()) {
          /* bounded persistent batches */
        }
        assert.equal(await f.media.cleanupOne(), false);
        const remaining = (
          await f.pool.query<{ count: number }>(
            "SELECT count(*)::int count FROM whaleu_media.bindings WHERE owner_kind='ratings' AND resource_id=ANY($1::uuid[]) AND detached_at IS NULL",
            [[rootId, replyId]],
          )
        ).rows[0]!.count;
        assert.equal(remaining, 0);
        const tombstones = (
          await f.pool.query<{ count: number }>(
            'SELECT count(*)::int count FROM whaleu_ratings.discussion_media_tombstones WHERE resource_id=ANY($1::uuid[])',
            [[rootId, replyId]],
          )
        ).rows[0]!.count;
        assert.equal(tombstones, 2);
        assert.notEqual((await imageGet(rootImages[0]!)).status, 200);
        assert.ok(replyRevision);
      },
    );
    await t.test(
      'cancelled exact command keeps an original actor receipt without publication',
      async () => {
        const intent = await f.draft(author);
        const response = await f
          .auth(request(f.http).post('/v4/ratings/discussion/cancel'), author)
          .send(intent);
        discussionHttpOk(response);
        const receipt = ratingDiscussionMediaReceiptSchema.parse(response.body);
        assert.equal(receipt.outcome, 'closed');
        const status = await f.auth(
          request(f.http).get(
            `/v4/ratings/discussion/receipts/${intent.payload.clientRequestId}`,
          ),
          author,
        );
        discussionHttpOk(status);
        assert.deepEqual(status.body, receipt);
        const foreign = await f.auth(
          request(f.http).get(
            `/v4/ratings/discussion/receipts/${intent.payload.clientRequestId}`,
          ),
          replyAuthor,
        );
        assert.notEqual(foreign.status, 200);
      },
    );
    await t.test(
      'scrubbed hash cancellation closes the original key before a delayed prepare or commit',
      async () => {
        const intent = await f.draft(author),
          id = intent.payload.clientRequestId;
        const body = {
          protocolVersion: 4,
          operation: intent.operation,
          intentHash: ratingDiscussionMediaCommandHash(intent),
        };
        const cancel = () =>
          f
            .auth(
              request(f.http).post(
                `/v4/ratings/discussion/requests/${id}/cancel`,
              ),
              author,
            )
            .send(body);
        const closed = await cancel();
        discussionHttpOk(closed);
        assert.equal(closed.body.code, 'RATING_CREATION_CANCELLED');
        discussionHttpOk(await cancel());
        const prepare = await f
          .auth(request(f.http).post('/v4/ratings/discussion/prepare'), author)
          .send(intent);
        discussionHttpOk(prepare);
        assert.deepEqual(prepare.body, closed.body);
        const commit = await f
          .auth(request(f.http).post('/v4/ratings/discussion/commit'), author)
          .send({ ...intent, preparationContextRevision: 'a'.repeat(43) });
        discussionHttpOk(commit);
        assert.deepEqual(commit.body, closed.body);
        const mismatch = await f
          .auth(
            request(f.http).post(
              `/v4/ratings/discussion/requests/${id}/cancel`,
            ),
            author,
          )
          .send({ ...body, intentHash: '0'.repeat(64) });
        assert.notEqual(mismatch.status, 200);
        const metadata = (
          await f.pool.query<{ fields: string[]; count: number }>(
            `SELECT array_agg(key ORDER BY key) fields,count(*)::int count FROM whaleu_ratings.discussion_command_recovery_fences f CROSS JOIN LATERAL jsonb_object_keys(to_jsonb(f)) key WHERE account_id=$1 AND request_id=$2`,
            [author.accountId, id],
          )
        ).rows[0]!;
        assert.deepEqual(metadata.fields, [
          'account_id',
          'created_at',
          'intent_hash',
          'mutation_transaction',
          'operation',
          'request_id',
          'session_id',
        ]);
        const publication = (
          await f.pool.query<{ count: number }>(
            'SELECT count(*)::int count FROM whaleu_ratings.comments WHERE account_id=$1 AND request_id=$2',
            [author.accountId, id],
          )
        ).rows[0]!.count;
        assert.equal(publication, 0);
      },
    );
  },
);

test(
  'normal AppModule and absent independent adoption never activate discussion images',
  { timeout: 120000 },
  async (t) => {
    const f = await syntheticRatingDiscussionFixture([], {
      registerCapabilities: false,
    });
    t.after(() => f.close());
    assert.equal(f.baseApp.get(RatingDiscussionMediaService).runtime, null);
    const response = await f
      .auth(request(f.http).post('/v4/ratings/discussion/contexts'), f.creator)
      .send({
        purpose: 'interact',
        selector: { kind: 'global' },
        mode: 'public',
      });
    assert.notEqual(response.status, 200);
    assert.equal(
      (
        await f.pool.query<{ count: number }>(
          'SELECT count(*)::int count FROM whaleu_ratings.discussion_media_capability_sources',
        )
      ).rows[0]!.count,
      0,
    );
    assert.equal(
      (
        await f.pool.query<{ count: number }>(
          'SELECT count(*)::int count FROM whaleu_community.rating_discussion_media_bindings',
        )
      ).rows[0]!.count,
      0,
    );
  },
);
