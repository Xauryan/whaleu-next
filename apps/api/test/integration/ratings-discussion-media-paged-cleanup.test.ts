import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { APP_CONFIG, type RuntimeConfig } from '../../src/config/config.js';
import { RatingDiscussionMediaService } from '../../src/ratings/discussion-media.service.js';
import {
  syntheticRatingDiscussionFixture,
  discussionHttpOk,
} from '../support/media/ratings-discussion-runtime-fixture.js';
import { setRatingReviewState } from '../support/rating-runtime-fixture.js';
import { sha256 } from '../../src/media/processing/protocol.js';

interface Appearance {
  resource_kind: 'rating_comment' | 'rating_reply';
  resource_id: string;
  target_id: string;
  root_id: string;
}
interface Cursor {
  after_kind: string | null;
  after_id: string | null;
  phase: 'pending' | 'complete';
  completed_at: Date | null;
}
/** New acceptance source only. Creates real published subjects; no hand-written
 * ready assets, owner tombstones, cleanup jobs, quota changes or trigger bypass. */
test(
  'real target-owner deletion drains twenty media subjects in durable sixteen-member pages, including hidden and detached history',
  { timeout: 900000 },
  async (t) => {
    const sharp = (await import('sharp')).default,
      bytes = await sharp({
        create: { width: 24, height: 24, channels: 3, background: '#56788e' },
      })
        .png()
        .toBuffer();
    const f = await syntheticRatingDiscussionFixture([
      { sha256: sha256(bytes), verdict: 'allow' },
    ]);
    const resources: { resumedApp?: INestApplication } = {};
    t.after(async () => {
      await resources.resumedApp?.close();
      await f.close();
    });
    type Actor = Awaited<ReturnType<typeof f.actor>>;
    const authors: Actor[] = [];
    for (let n = 0; n < 5; n++) authors.push(await f.actor());
    const anchorPublished = await f.execute(
      f.creator,
      await f.draft(f.creator),
    );
    if (anchorPublished.receipt.operation !== 'create_comment_scoped')
      assert.fail('expected a real text root');
    const anchor = {
      id: anchorPublished.receipt.result.subjectId,
      revision: anchorPublished.receipt.result.revision,
    };
    const subjects: Array<{
      kind: 'rating_comment' | 'rating_reply';
      id: string;
      revision: string;
      actor: Actor;
      decisionId: string;
      assetId: string;
      requestId: string;
    }> = [];
    // Four subjects per actor: four batch keys + four member keys = eight/minute,
    // below the unchanged shared ten/minute admission limit. No waiting or refill.
    for (let ordinal = 0; ordinal < 20; ordinal++) {
      const actor = authors[ordinal % authors.length]!,
        reply = ordinal >= 4;
      const quote =
        ordinal === 5
          ? {
              replyId: subjects[4]!.id,
              expectedRevision: subjects[4]!.revision,
            }
          : null;
      const upload = await f.ready(
        actor,
        await f.draft(actor, reply ? anchor : undefined, quote),
        [bytes],
      );
      const published = await f.execute(actor, upload.intent),
        receipt = published.receipt;
      subjects.push({
        kind:
          receipt.operation === 'create_comment_scoped'
            ? 'rating_comment'
            : 'rating_reply',
        id:
          receipt.operation === 'create_comment_scoped'
            ? receipt.result.subjectId
            : receipt.result.replyId,
        revision: receipt.result.revision,
        actor,
        decisionId: published.approved.decisionId,
        assetId: upload.intent.payload.images[0]!.assetId,
        requestId: upload.intent.payload.clientRequestId,
      });
    }
    const quota = (
      await f.pool.query<{ actor_id: string; keys: number }>(
        `SELECT actor_id,count(*)::int keys FROM (
    SELECT actor_id,client_request_id FROM whaleu_media.upload_request_fences WHERE actor_id=ANY($1::uuid[])
    UNION ALL SELECT actor_id,batch_request_id FROM whaleu_media.ratings_discussion_batch_request_fences WHERE actor_id=ANY($1::uuid[])
  ) reserved GROUP BY actor_id ORDER BY actor_id`,
        [authors.map((actor) => actor.accountId)],
      )
    ).rows;
    assert.equal(quota.length, 5);
    assert.ok(
      quota.every((row) => row.keys === 8),
      'real identities, not increased quotas, provide capacity',
    );
    const historical = subjects[4]!,
      quoter = subjects[5]!,
      hidden = subjects[6]!;
    const deleteReply = await f
      .auth(
        request(f.http).delete(`/v1/ratings/replies/${historical.id}`),
        historical.actor,
      )
      .send({
        clientRequestId: randomUUID(),
        regionId: null,
        targetId: f.target.id,
        rootId: anchor.id,
        expectedTargetRevision: f.target.revision,
        expectedRootRevision: anchor.revision,
        expectedRevision: historical.revision,
      });
    discussionHttpOk(deleteReply);
    assert.equal(deleteReply.body.outcome, 'applied');
    assert.equal(await f.media.cleanupOne(), true);
    assert.equal(await f.media.cleanupOne(), false);
    const beforeTarget = (
      await f.pool.query<{ resource_id: string; detached_at: Date | null }>(
        'SELECT resource_id,detached_at FROM whaleu_media.bindings WHERE asset_id=ANY($1::uuid[])',
        [subjects.map((subject) => subject.assetId)],
      )
    ).rows;
    assert.equal(
      beforeTarget.find((row) => row.resource_id === historical.id)
        ?.detached_at instanceof Date,
      true,
    );
    assert.equal(
      beforeTarget.find((row) => row.resource_id === quoter.id)?.detached_at,
      null,
      'replyTo is a quote, never a cleanup ancestor',
    );
    await setRatingReviewState(f.pool, hidden.decisionId, 'revoked');
    const readContext = await f.context(f.creator, 'read');
    const hiddenRead = await f
      .auth(
        request(f.http).get(`/v4/ratings/discussion/replies/${hidden.id}`),
        f.creator,
      )
      .query({ contextId: readContext.id, contextToken: readContext.token });
    assert.notEqual(
      hiddenRead.status,
      200,
      'the cleanup corpus really contains hidden content',
    );
    const hiddenRow = (
      await f.pool.query<{ deleted_at: Date | null }>(
        'SELECT deleted_at FROM whaleu_ratings.replies WHERE id=$1',
        [hidden.id],
      )
    ).rows[0]!;
    assert.equal(hiddenRow.deleted_at, null);
    const appearances = (
      await f.pool.query<Appearance>(
        'SELECT * FROM whaleu_ratings.discussion_media_cleanup_appearances WHERE target_id=$1 ORDER BY resource_kind,resource_id',
        [f.target.id],
      )
    ).rows;
    assert.equal(appearances.length, 20);
    assert.deepEqual(
      new Set(appearances.map((row) => row.resource_id)),
      new Set(subjects.map((subject) => subject.id)),
    );
    assert.ok(
      appearances.some((row) => row.resource_id === historical.id),
      'detached publication remains an immutable appearance',
    );
    assert.ok(
      !appearances.some((row) => row.resource_id === anchor.id),
      'text-only root adds no media cleanup obligation',
    );

    const ownerContext = await f.auth(
      request(f.http).get(
        `/v1/ratings/management/owner-deletion/targets/${f.target.id}/context`,
      ),
      f.creator,
    );
    discussionHttpOk(ownerContext);
    const requestId = randomUUID(),
      removed = await f
        .auth(
          request(f.http).post(
            `/v1/ratings/management/owner-deletion/targets/${f.target.id}`,
          ),
          f.creator,
        )
        .send({
          clientRequestId: requestId,
          expectedTargetRevision: ownerContext.body.revision,
        });
    discussionHttpOk(removed);
    assert.equal(removed.body.outcome, 'applied');
    assert.equal(removed.body.operation, 'delete_target');
    assert.equal(
      (
        await f.pool.query(
          'SELECT target_id FROM whaleu_ratings.target_owner_tombstones WHERE target_id=$1',
          [f.target.id],
        )
      ).rowCount,
      1,
    );
    const cursor = async () =>
      (
        await f.pool.query<Cursor>(
          "SELECT after_kind,after_id,phase,completed_at FROM whaleu_ratings.discussion_media_cleanup WHERE owner_kind='target' AND owner_id=$1",
          [f.target.id],
        )
      ).rows[0]!;
    const page = async (after: Cursor) =>
      (
        await f.pool.query<Appearance>(
          "SELECT * FROM whaleu_ratings.discussion_media_cleanup_page('target',$1,$2,$3,16)",
          [f.target.id, after.after_kind, after.after_id],
        )
      ).rows;
    assert.deepEqual(await cursor(), {
      after_kind: null,
      after_id: null,
      phase: 'pending',
      completed_at: null,
    });
    const first = await page(await cursor());
    assert.equal(first.length, 16);
    assert.deepEqual(first, appearances.slice(0, 16));
    assert.equal(await f.media.cleanupOne(), true);
    const checkpoint = await cursor();
    assert.equal(checkpoint.phase, 'pending');
    assert.equal(checkpoint.completed_at, null);
    assert.deepEqual(
      [checkpoint.after_kind, checkpoint.after_id],
      [first[15]!.resource_kind, first[15]!.resource_id],
    );
    const covered = new Set([
      historical.id,
      ...first.map((row) => row.resource_id),
    ]);
    const firstTombstones = (
      await f.pool.query<{ resource_id: string }>(
        'SELECT resource_id FROM whaleu_ratings.discussion_media_tombstones WHERE target_id=$1',
        [f.target.id],
      )
    ).rows;
    assert.deepEqual(
      new Set(firstTombstones.map((row) => row.resource_id)),
      covered,
      'each step only claims its exact bounded page plus earlier history',
    );
    const stillActive = (
      await f.pool.query<{ resource_id: string }>(
        'SELECT resource_id FROM whaleu_media.bindings WHERE asset_id=ANY($1::uuid[]) AND detached_at IS NULL',
        [subjects.map((subject) => subject.assetId)],
      )
    ).rows;
    assert.deepEqual(
      new Set(stillActive.map((row) => row.resource_id)),
      new Set(
        subjects
          .filter((subject) => !covered.has(subject.id))
          .map((subject) => subject.id),
      ),
    );

    // Recreate the original service through a new AppModule/DatabaseService. The
    // process-local worker state is discarded; only the persisted UUID cursor is
    // available. Cleanup works even with the ordinary null runtime/provider.
    const module = await Test.createTestingModule({
      imports: [AppModule.register(f.app.get<RuntimeConfig>(APP_CONFIG))],
    }).compile();
    const resumedApp = module.createNestApplication({ logger: false });
    resources.resumedApp = resumedApp;
    await resumedApp.init();
    const resumed = resumedApp.get(RatingDiscussionMediaService);
    assert.notEqual(resumed, f.media);
    assert.equal(resumed.runtime, null);
    assert.deepEqual(await cursor(), checkpoint);
    const tail = await page(await cursor());
    assert.equal(tail.length, 4);
    assert.deepEqual(tail, appearances.slice(16));
    assert.equal(await resumed.cleanupOne(), true);
    const final = await cursor();
    assert.equal(final.phase, 'complete');
    assert.ok(final.completed_at instanceof Date);
    assert.deepEqual(
      [final.after_kind, final.after_id],
      [tail[3]!.resource_kind, tail[3]!.resource_id],
    );
    assert.equal(await resumed.cleanupOne(), false);
    assert.deepEqual(
      await cursor(),
      final,
      'completed cursor cannot reset or revisit old history',
    );
    const visited = [...first, ...tail];
    assert.equal(visited.length, 20);
    assert.equal(
      new Set(visited.map((row) => `${row.resource_kind}:${row.resource_id}`))
        .size,
      20,
    );
    assert.equal(
      (
        await f.pool.query<{ n: number }>(
          'SELECT count(*)::int n FROM whaleu_ratings.discussion_media_tombstones WHERE target_id=$1',
          [f.target.id],
        )
      ).rows[0]!.n,
      20,
    );
    const retained = (
      await f.pool.query<{
        bindings: number;
        active: number;
        appearances: number;
        reviews: number;
        pending_objects: number;
      }>(
        `SELECT
    (SELECT count(*)::int FROM whaleu_media.bindings WHERE asset_id=ANY($1::uuid[])) bindings,
    (SELECT count(*)::int FROM whaleu_media.bindings WHERE asset_id=ANY($1::uuid[]) AND detached_at IS NULL) active,
    (SELECT count(*)::int FROM whaleu_ratings.discussion_media_cleanup_appearances WHERE target_id=$2) appearances,
    (SELECT count(*)::int FROM whaleu_community.rating_discussion_media_bindings WHERE subject_id=ANY($3::uuid[])) reviews,
    (SELECT count(*)::int FROM whaleu_media.variants v JOIN whaleu_media.cleanup_obligations c ON (c.provider,c.environment,c.bucket,c.object_key,c.object_version)=(v.provider,v.environment,v.bucket,v.object_key,v.object_version) WHERE v.asset_id=ANY($1::uuid[]) AND c.confirmed_deleted_at IS NULL) pending_objects`,
        [
          subjects.map((subject) => subject.assetId),
          f.target.id,
          subjects.map((subject) => subject.id),
        ],
      )
    ).rows[0]!;
    assert.deepEqual(
      {
        bindings: retained.bindings,
        active: retained.active,
        appearances: retained.appearances,
        reviews: retained.reviews,
      },
      { bindings: 20, active: 0, appearances: 20, reviews: 20 },
    );
    assert.ok(
      retained.pending_objects >= 40,
      'logical completion does not pretend the two derived objects per asset were physically deleted',
    );
    const recovered = await f.auth(
      request(f.http).get(
        `/v1/ratings/management/owner-deletion/requests/${requestId}`,
      ),
      f.creator,
    );
    discussionHttpOk(recovered);
    assert.deepEqual(recovered.body, removed.body);
  },
);
