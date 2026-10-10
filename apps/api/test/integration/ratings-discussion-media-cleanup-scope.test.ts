import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import request from 'supertest';
import { ratingDiscussionFixture } from '../support/rating-discussion-fixture.js';
import {
  syntheticRatingDiscussionFixture,
  discussionHttpOk,
} from '../support/media/ratings-discussion-runtime-fixture.js';
import { sha256 } from '../../src/media/processing/protocol.js';

/** Acceptance source only. Requires the exclusive disposable-PG heavy lease. */
test(
  'legacy text deletion never creates a discussion Media7 cleanup obligation',
  { timeout: 180000 },
  async (t) => {
    const f = await ratingDiscussionFixture();
    t.after(() => f.close());
    const author = await f.actor(),
      catalog = await f.catalog(author),
      target = catalog.targets[0]!;
    const root = await f.publish(author, catalog, target),
      reply = await f.publishReply(author, catalog, target, root);
    await f.deleteReply(author, catalog, target, root, reply);
    await f.deleteRoot(author, catalog, target, root);
    const row = (
      await f.pool.query<{
        jobs: number;
        tombstones: number;
        appearances: number;
      }>(`SELECT
   (SELECT count(*)::int FROM whaleu_ratings.discussion_media_cleanup) jobs,
   (SELECT count(*)::int FROM whaleu_ratings.discussion_media_tombstones) tombstones,
   (SELECT count(*)::int FROM whaleu_ratings.discussion_media_cleanup_appearances) appearances`)
    ).rows[0]!;
    assert.deepEqual(row, { jobs: 0, tombstones: 0, appearances: 0 });
  },
);
test(
  'cleanup enumerates immutable Media7 appearances, skips text, and never follows replyTo',
  { timeout: 480000 },
  async (t) => {
    const sharp = (await import('sharp')).default,
      bytes = await sharp({
        create: { width: 32, height: 24, channels: 3, background: '#486e9a' },
      })
        .png()
        .toBuffer();
    const f = await syntheticRatingDiscussionFixture([
      { sha256: sha256(bytes), verdict: 'allow' },
    ]);
    t.after(() => f.close());
    const author = f.creator;
    const rootOf = (done: Awaited<ReturnType<typeof f.execute>>) => {
      if (
        done.receipt.outcome !== 'applied' ||
        done.receipt.operation !== 'create_comment_scoped'
      )
        assert.fail('expected root');
      return {
        id: done.receipt.result.subjectId,
        revision: done.receipt.result.revision,
      };
    };
    const replyOf = (done: Awaited<ReturnType<typeof f.execute>>) => {
      if (
        done.receipt.outcome !== 'applied' ||
        done.receipt.operation !== 'create_reply_scoped'
      )
        assert.fail('expected reply');
      return {
        id: done.receipt.result.replyId,
        revision: done.receipt.result.revision,
      };
    };
    const deleteRoot = async (root: { id: string; revision: string }) => {
      const response = await f
        .auth(request(f.http).delete(`/v1/ratings/comments/${root.id}`), author)
        .send({
          clientRequestId: randomUUID(),
          regionId: null,
          targetId: f.target.id,
          expectedTargetRevision: f.target.revision,
          expectedRevision: root.revision,
        });
      discussionHttpOk(response);
    };
    const pureText = rootOf(await f.execute(author, await f.draft(author)));
    await deleteRoot(pureText);
    assert.equal(
      (
        await f.pool.query<{ n: number }>(
          'SELECT count(*)::int n FROM whaleu_ratings.discussion_media_cleanup',
        )
      ).rows[0]!.n,
      0,
      'Review7 text-only is not a media appearance',
    );
    const root = rootOf(await f.execute(author, await f.draft(author)));
    const first = replyOf(
      await f.execute(
        author,
        (await f.ready(author, await f.draft(author, root), [bytes])).intent,
      ),
    );
    const quoted = replyOf(
      await f.execute(
        author,
        (
          await f.ready(
            author,
            await f.draft(author, root, {
              replyId: first.id,
              expectedRevision: first.revision,
            }),
            [bytes],
          )
        ).intent,
      ),
    );
    const removed = await f
      .auth(request(f.http).delete(`/v1/ratings/replies/${first.id}`), author)
      .send({
        clientRequestId: randomUUID(),
        regionId: null,
        targetId: f.target.id,
        rootId: root.id,
        expectedTargetRevision: f.target.revision,
        expectedRootRevision: root.revision,
        expectedRevision: first.revision,
      });
    discussionHttpOk(removed);
    assert.equal(await f.media.cleanupOne(), true);
    assert.equal(await f.media.cleanupOne(), false);
    assert.equal(
      (
        await f.pool.query<{ n: number }>(
          "SELECT count(*)::int n FROM whaleu_media.bindings WHERE resource_kind='rating_reply' AND resource_id=$1 AND detached_at IS NULL",
          [quoted.id],
        )
      ).rows[0]!.n,
      1,
      'deleting referenced reply does not clean its quoter',
    );
    await deleteRoot(root);
    const page = (
      await f.pool.query<{ resource_id: string }>(
        "SELECT * FROM whaleu_ratings.discussion_media_cleanup_page('root',$1,NULL,NULL,16)",
        [root.id],
      )
    ).rows;
    assert.deepEqual(
      new Set(page.map((x) => x.resource_id)),
      new Set([first.id, quoted.id]),
      'text root omitted; detached history remains an appearance',
    );
    assert.equal(await f.media.cleanupOne(), true);
    assert.equal(await f.media.cleanupOne(), false);
    assert.equal(
      (
        await f.pool.query<{ n: number }>(
          'SELECT count(*)::int n FROM whaleu_ratings.discussion_media_tombstones WHERE resource_id=$1',
          [root.id],
        )
      ).rows[0]!.n,
      0,
    );
    assert.equal(
      (
        await f.pool.query<{ n: number }>(
          'SELECT count(*)::int n FROM whaleu_media.bindings WHERE resource_id=ANY($1::uuid[]) AND detached_at IS NULL',
          [[first.id, quoted.id]],
        )
      ).rows[0]!.n,
      0,
    );
    assert.equal(
      (
        await f.pool.query<{ n: number }>(
          "SELECT count(*)::int n FROM whaleu_ratings.discussion_media_cleanup_page('target',$1,NULL,NULL,16)",
          [f.target.id],
        )
      ).rows[0]!.n,
      2,
      'physical cleanup never erases immutable historical ownership',
    );
  },
);
