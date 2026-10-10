import 'reflect-metadata';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import request from 'supertest';
import { DatabaseService } from '../../src/database/database.js';
import {
  MEDIA_ATTACHMENT,
  UnavailableMedia,
} from '../../src/community/community-policy.js';
import type { MediaAttachmentPort } from '../../src/community/community-policy.js';
import { CommunityMediaCleanupFacade } from '../../src/community/media/cleanup-facade.js';
import { CommunityMediaCleanupWorker } from '../../src/community/media/cleanup-worker.js';
import { CommunityReportTargetFacade } from '../../src/community/report-target.facade.js';
import { CommunityModerationRemovalFacade } from '../../src/community/moderation-removal.facade.js';
import { sha256 } from '../../src/media/processing/protocol.js';
import { syntheticMediaRuntimeFixture } from '../support/media/runtime-fixture.js';
import {
  publishDiscussionPost,
  readyDiscussionBatch,
  sealDiscussionBatch,
  responseOk,
} from '../support/media/discussion-batch-fixture.js';
import type {
  BatchFixture,
  BatchActor,
} from '../support/media/discussion-batch-fixture.js';
import { discussionApprovalEnvelope } from '../support/community-runtime-fixtures.js';
import {
  approveEnvelope,
  seedReviewPolicy,
} from '../support/community-approval-fixtures.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';

async function createFixture() {
  const sharp = (await import('sharp')).default;
  const bytes = await sharp({
    create: { width: 80, height: 60, channels: 3, background: '#123456' },
  })
    .png()
    .toBuffer();
  const fixture = await syntheticMediaRuntimeFixture([
    { sha256: sha256(bytes), verdict: 'allow' },
  ]);
  return { fixture, files: [{ mime: 'image/png', bytes }] };
}
async function imageContent(
  f: BatchFixture,
  actor: BatchActor,
  target: Parameters<typeof readyDiscussionBatch>[2],
  files: Parameters<typeof readyDiscussionBatch>[4],
) {
  const ready = await readyDiscussionBatch(f, actor, target, 3, files);
  const sealed = await sealDiscussionBatch(f, actor, ready.status, '');
  const published = await request(f.app.getHttpServer())
    .post(sealed.path)
    .set('Authorization', `Bearer ${actor.accessToken}`)
    .send(sealed.body);
  responseOk(published, 201);
  assert.equal(published.body.outcome, 'created');
  return {
    id: published.body.resourceId as string,
    ready,
    sealed,
    receipt: published.body,
  };
}
async function textReply(
  f: BatchFixture,
  actor: BatchActor,
  postId: string,
  rootId: string,
  index: number,
) {
  const body = {
    clientRequestId: randomUUID(),
    text: `Bounded cleanup text reply ${index}`,
    imageAssetIds: [],
    authorMode: 'named' as const,
    targetReplyId: null,
  };
  await approveEnvelope(
    f.pool,
    await discussionApprovalEnvelope(
      f.app,
      f.pool,
      actor.accountId,
      postId,
      body,
      rootId,
    ),
  );
  const result = await request(f.app.getHttpServer())
    .post(`/v1/community/comments/${rootId}/replies`)
    .set('Authorization', `Bearer ${actor.accessToken}`)
    .send(body);
  responseOk(result, 201);
  assert.equal(result.body.outcome, 'created');
  return result.body.resourceId as string;
}
async function jobFor(f: BatchFixture, kind: string, id: string) {
  const row = (
    await f.pool.query<{
      id: string;
      phase: string;
      cursor_id: string | null;
      detached_targets: string;
      enumeration_completed_at: Date | null;
    }>(
      'SELECT * FROM whaleu_community.media_cleanup_jobs WHERE resource_kind=$1 AND resource_id=$2',
      [kind, id],
    )
  ).rows;
  assert.equal(row.length, 1);
  return row[0]!;
}
async function snapshot(f: BatchFixture) {
  return (
    await f.pool.query(`SELECT jsonb_build_object(
    'jobs',(SELECT coalesce(jsonb_agg(to_jsonb(j) ORDER BY j.id),'[]') FROM whaleu_community.media_cleanup_jobs j),
    'bindings',(SELECT coalesce(jsonb_agg(to_jsonb(b) ORDER BY b.id),'[]') FROM whaleu_media.bindings b),
    'intents',(SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY i.id),'[]') FROM whaleu_media.upload_intents i),
    'obligations',(SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.id),'[]') FROM whaleu_media.cleanup_obligations c)
  ) AS snapshot`)
  ).rows[0]!['snapshot'];
}
function childEvent(child: ChildProcess, expected: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${expected}`));
    }, 20000);
    const message = (value: unknown) => {
      if (!value || typeof value !== 'object' || !('event' in value)) return;
      if (value.event === expected) {
        cleanup();
        resolve();
      } else if (value.event === 'failure') {
        cleanup();
        reject(new Error(JSON.stringify(value)));
      }
    };
    const exited = () => {
      cleanup();
      reject(new Error(`Cleanup process exited before ${expected}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.removeListener('message', message);
      child.removeListener('exit', exited);
    };
    child.on('message', message);
    child.once('exit', exited);
  });
}

test(
  'root cleanup is atomic, bounded, crash-recoverable, and preserves pending physical cleanup and bound history',
  { timeout: 480000 },
  async () => {
    const { fixture: f, files } = await createFixture();
    let child: ChildProcess | undefined;
    try {
      await seedReviewPolicy(f.pool);
      const actor = await f.actor(),
        auth = `Bearer ${actor.accessToken}`,
        http = f.app.getHttpServer();
      const postId = await publishDiscussionPost(f, actor);
      const root = await imageContent(
        f,
        actor,
        { kind: 'comment', postId },
        files,
      );
      const replies = [];
      for (let index = 0; index < 2; index++)
        replies.push(
          await imageContent(
            f,
            actor,
            { kind: 'reply', rootCommentId: root.id, targetReplyId: null },
            files,
          ),
        );
      for (let index = 0; index < 15; index++)
        await textReply(f, actor, postId, root.id, index);
      const binding = (
        await f.pool.query<{ id: string }>(
          "SELECT id FROM whaleu_media.bindings WHERE resource_kind='reply' AND resource_id=$1 ORDER BY ordinal",
          [replies[0]!.id],
        )
      ).rows[0]!;
      responseOk(
        await request(http)
          .get(`/v1/media/bindings/${binding.id}/display-v1`)
          .set('Authorization', auth),
      );
      const remove = () =>
        request(http)
          .delete(`/v1/community/comments/${root.id}`)
          .set('Authorization', auth);
      const beforeDelete = await snapshot(f);
      await f.pool
        .query(`CREATE FUNCTION whaleu_community.synthetic_cleanup_capture_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic queue capture failure'; END $$;
      CREATE TRIGGER z_synthetic_cleanup_capture_failure AFTER INSERT ON whaleu_community.media_cleanup_jobs FOR EACH ROW EXECUTE FUNCTION whaleu_community.synthetic_cleanup_capture_failure()`);
      try {
        assert.ok((await remove()).status >= 400);
        assert.deepEqual(await snapshot(f), beforeDelete);
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_community.root_comments WHERE id=$1 AND deleted_at IS NULL',
              [root.id],
            )
          ).rowCount,
          1,
        );
      } finally {
        await f.pool.query(
          'DROP TRIGGER z_synthetic_cleanup_capture_failure ON whaleu_community.media_cleanup_jobs; DROP FUNCTION whaleu_community.synthetic_cleanup_capture_failure()',
        );
      }
      responseOk(await remove(), 204);
      const job = await jobFor(f, 'comment', root.id);
      assert.equal(job.phase, 'self');
      assert.equal(
        (
          await f.pool.query(
            "SELECT 1 FROM whaleu_media.bindings WHERE resource_kind='comment' AND resource_id=$1 AND detached_at IS NULL",
            [root.id],
          )
        ).rowCount,
        0,
      );
      assert.equal(
        (
          await f.pool.query(
            "SELECT 1 FROM whaleu_media.bindings WHERE resource_kind='reply' AND detached_at IS NULL",
          )
        ).rowCount,
        6,
      );
      assert.ok(
        (
          await request(http)
            .get(`/v1/media/bindings/${binding.id}/display-v1`)
            .set('Authorization', auth)
        ).status >= 400,
        'Current ancestor authorization fails before descendant detach runs',
      );
      const database = f.app.get(DatabaseService),
        media = f.app.get<MediaAttachmentPort>(MEDIA_ATTACHMENT);
      const worker = () =>
        new CommunityMediaCleanupWorker(
          database,
          new CommunityMediaCleanupFacade(),
          media,
        );
      class FailFirstTarget extends UnavailableMedia {
        override async detachMany(
          targets: readonly {
            kind: 'post' | 'comment' | 'reply';
            id: string;
          }[],
          tx: PoolClient,
        ) {
          assert.equal(targets.length, 1);
          assert.ok(media.detachMany);
          await media.detachMany(targets, tx);
          throw new Error('SYNTHETIC_FIRST_TARGET_FAILURE');
        }
      }
      const beforeFirst = await snapshot(f);
      await assert.rejects(
        new CommunityMediaCleanupWorker(
          database,
          new CommunityMediaCleanupFacade(),
          new FailFirstTarget(),
        ).runOnePage(job.id),
        /SYNTHETIC_FIRST_TARGET_FAILURE/,
      );
      assert.deepEqual(
        await snapshot(f),
        beforeFirst,
        'First page failure leaves its self cursor pending',
      );
      assert.deepEqual(await worker().runOnePage(job.id), {
        status: 'progress',
        jobId: job.id,
        detachedTargets: 1,
      });
      const beforePage = await snapshot(f);
      class FailingPage extends UnavailableMedia {
        override async detachMany(
          targets: readonly {
            kind: 'post' | 'comment' | 'reply';
            id: string;
          }[],
          tx: PoolClient,
        ) {
          assert.equal(targets.length, 16);
          assert.deepEqual(
            targets.map((target) => target.id),
            targets.map((target) => target.id).sort(),
          );
          assert.ok(media.detachMany);
          await media.detachMany(targets, tx);
          // The entire page has tentative effects, but its cursor and final
          // completion marker must still roll back on a post-detach failure.
          throw new Error('SYNTHETIC_LAST_TARGET_FAILURE');
        }
      }
      await assert.rejects(
        new CommunityMediaCleanupWorker(
          database,
          new CommunityMediaCleanupFacade(),
          new FailingPage(),
        ).runOnePage(job.id),
        /SYNTHETIC_LAST_TARGET_FAILURE/,
      );
      assert.deepEqual(
        await snapshot(f),
        beforePage,
        'Last-target failure rolls back earlier exact-object obligations and the cursor',
      );
      child = fork(
        fileURLToPath(
          new URL(
            '../support/media/discussion-cleanup-process.mjs',
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
      const paused = childEvent(child, 'detached-before-cursor');
      child.send({
        command: 'run',
        jobId: job.id,
        pauseTarget: replies.map((reply) => reply.id).sort()[0],
      });
      await paused;
      assert.deepEqual(
        await snapshot(f),
        beforePage,
        'Uncommitted process effects remain invisible',
      );
      const exited = new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
      }>((resolve) =>
        child!.once('exit', (code, signal) => resolve({ code, signal })),
      );
      child.kill('SIGKILL');
      assert.deepEqual(await exited, { code: null, signal: 'SIGKILL' });
      child = undefined;
      assert.deepEqual(
        await snapshot(f),
        beforePage,
        'Crash releases transaction claim with the original durable cursor',
      );
      assert.deepEqual(await worker().runOnePage(job.id), {
        status: 'progress',
        jobId: job.id,
        detachedTargets: 16,
      });
      const continuation = await jobFor(f, 'comment', root.id);
      assert.equal(continuation.phase, 'replies');
      assert.ok(continuation.cursor_id);
      assert.equal(continuation.detached_targets, '17');
      const beforeTail = await snapshot(f);
      await assert.rejects(
        new CommunityMediaCleanupWorker(
          database,
          new CommunityMediaCleanupFacade(),
          new FailFirstTarget(),
        ).runOnePage(job.id),
        /SYNTHETIC_FIRST_TARGET_FAILURE/,
      );
      assert.deepEqual(
        await snapshot(f),
        beforeTail,
        'Last page failure cannot write the enumeration-completed marker',
      );
      assert.deepEqual(await worker().runOnePage(job.id), {
        status: 'enumeration-complete',
        jobId: job.id,
        detachedTargets: 1,
      });
      assert.equal(
        (await jobFor(f, 'comment', root.id)).detached_targets,
        '18',
      );
      assert.deepEqual(await worker().runOnePage(job.id), { status: 'idle' });
      await withCommunityScopeWriter(f.pool, (tx) =>
        tx.query(
          'UPDATE whaleu_community.root_comments SET deleted_at=deleted_at WHERE id=$1',
          [root.id],
        ),
      );
      assert.equal(
        (await jobFor(f, 'comment', root.id)).detached_targets,
        '18',
        'Repeated tombstone writes do not reset durable work',
      );
      const completed = await snapshot(f);
      await assert.rejects(
        withCommunityScopeWriter(f.pool, (tx) =>
          tx.query(
            "UPDATE whaleu_community.media_cleanup_jobs SET phase='self',cursor_id=NULL,enumeration_completed_at=NULL WHERE id=$1",
            [job.id],
          ),
        ),
      );
      await assert.rejects(
        withCommunityScopeWriter(f.pool, (tx) =>
          tx.query(
            `INSERT INTO whaleu_community.media_cleanup_jobs(resource_kind,resource_id,post_id,root_comment_id,source_deleted_at)
       SELECT resource_kind,resource_id,post_id,root_comment_id,source_deleted_at FROM whaleu_community.media_cleanup_jobs WHERE id=$1`,
            [job.id],
          ),
        ),
      );
      assert.deepEqual(
        await snapshot(f),
        completed,
        'Neither duplicate queue admission nor completion rewrites discard obligations',
      );
      assert.equal(
        (
          await f.pool.query(
            'SELECT 1 FROM whaleu_media.bindings WHERE detached_at IS NULL',
          )
        ).rowCount,
        0,
      );
      assert.equal(
        (await f.pool.query('SELECT 1 FROM whaleu_media.bindings')).rowCount,
        9,
      );
      assert.equal(
        (
          await f.pool.query(
            "SELECT 1 FROM whaleu_media.publication_batches WHERE state='consumed'",
          )
        ).rowCount,
        3,
      );
      const physical = (
        await f.pool.query<{
          state: string;
          confirmed_deleted_at: Date | null;
        }>(
          'SELECT state,confirmed_deleted_at FROM whaleu_media.cleanup_obligations',
        )
      ).rows;
      assert.ok(physical.length > 0);
      assert.ok(
        physical.every(
          (row) => row.state === 'pending' && row.confirmed_deleted_at === null,
        ),
      );
      const variants = (
        await f.pool.query<{
          provider: string;
          environment: string;
          bucket: string;
          key: string;
          version: string;
        }>(
          'SELECT provider,environment,bucket,object_key AS key,object_version AS version FROM whaleu_media.variants',
        )
      ).rows;
      for (const object of variants) await f.storage.measure(object);
      for (const content of [root, ...replies]) {
        const replay = await request(http)
          .post(content.sealed.path)
          .set('Authorization', auth)
          .send(content.sealed.body);
        responseOk(replay, 201);
        assert.deepEqual(
          replay.body,
          content.receipt,
          'Deletion does not erase exact original publication history',
        );
      }
    } finally {
      child?.kill('SIGKILL');
      await f.close();
    }
  },
);

test(
  'reply deletion preserves referencing replies; moderation and overlapping ancestor jobs enumerate all typed descendants once without physical-deletion claims',
  { timeout: 480000 },
  async () => {
    const { fixture: f, files } = await createFixture();
    try {
      await seedReviewPolicy(f.pool);
      const actor = await f.actor(),
        auth = `Bearer ${actor.accessToken}`,
        http = f.app.getHttpServer();
      const postId = await publishDiscussionPost(f, actor);
      const root = await imageContent(
        f,
        actor,
        { kind: 'comment', postId },
        files,
      );
      const target = await imageContent(
        f,
        actor,
        { kind: 'reply', rootCommentId: root.id, targetReplyId: null },
        files,
      );
      const reference = await imageContent(
        f,
        actor,
        { kind: 'reply', rootCommentId: root.id, targetReplyId: target.id },
        files,
      );
      const database = f.app.get(DatabaseService),
        media = f.app.get<MediaAttachmentPort>(MEDIA_ATTACHMENT);
      const worker = () =>
        new CommunityMediaCleanupWorker(
          database,
          new CommunityMediaCleanupFacade(),
          media,
        );
      responseOk(
        await request(http)
          .delete(`/v1/community/replies/${target.id}`)
          .set('Authorization', auth),
        204,
      );
      const replyJob = await jobFor(f, 'reply', target.id);
      assert.equal(
        (
          await f.pool.query(
            'SELECT 1 FROM whaleu_media.bindings WHERE resource_id=$1 AND detached_at IS NULL',
            [target.id],
          )
        ).rowCount,
        0,
      );
      assert.deepEqual(await worker().runOnePage(replyJob.id), {
        status: 'enumeration-complete',
        jobId: replyJob.id,
        detachedTargets: 1,
      });
      const referencing = await request(http)
        .get(`/v1/community/replies/${reference.id}`)
        .set('Authorization', auth);
      responseOk(referencing);
      assert.equal(referencing.body.images.length, 3);
      assert.equal(referencing.body.target.status, 'unavailable');
      const countBeforeHidden = (
        await f.pool.query('SELECT 1 FROM whaleu_community.media_cleanup_jobs')
      ).rowCount;
      await withCommunityScopeWriter(f.pool, (tx) =>
        tx.query(
          "UPDATE whaleu_community.root_comments SET visibility='hidden' WHERE id=$1",
          [root.id],
        ),
      );
      assert.equal(
        (
          await f.pool.query(
            'SELECT 1 FROM whaleu_community.media_cleanup_jobs',
          )
        ).rowCount,
        countBeforeHidden,
      );
      await withCommunityScopeWriter(f.pool, (tx) =>
        tx.query(
          "UPDATE whaleu_community.root_comments SET visibility='approved' WHERE id=$1",
          [root.id],
        ),
      );
      await withCommunityScopeWriter(f.pool, async (tx) => {
        const targetRef = { kind: 'comment' as const, id: root.id };
        const current = await f.app
          .get(CommunityReportTargetFacade)
          .resolveVisible(targetRef, actor.accountId, tx, true);
        assert.equal(
          await f.app.get(CommunityModerationRemovalFacade).remove(
            {
              target: targetRef,
              expectedVersion: current.version,
              cause: 'discussion_report_threshold',
              decisionId: randomUUID(),
            },
            tx,
          ),
          'removed',
        );
      });
      const rootJob = await jobFor(f, 'comment', root.id);
      assert.equal(
        (
          await f.pool.query(
            'SELECT 1 FROM whaleu_media.bindings WHERE resource_id=$1 AND detached_at IS NULL',
            [root.id],
          )
        ).rowCount,
        3,
        'Moderation enqueue itself performs no unbounded or hidden synchronous traversal',
      );
      const racingActor = await f.actor();
      const losingReady = await readyDiscussionBatch(
        f,
        racingActor,
        { kind: 'comment', postId },
        3,
        files,
      );
      const losing = await sealDiscussionBatch(
        f,
        racingActor,
        losingReady.status,
        'Ancestor deletion wins this pending publication',
      );
      let entered!: () => void, release!: () => void;
      const held = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const resume = new Promise<void>((resolve) => {
        release = resolve;
      });
      const deletion = withCommunityScopeWriter(f.pool, async (tx) => {
        const targetRef = { kind: 'post' as const, id: postId };
        const current = await f.app
          .get(CommunityReportTargetFacade)
          .resolveVisible(targetRef, actor.accountId, tx, true);
        assert.equal(
          await f.app.get(CommunityModerationRemovalFacade).remove(
            {
              target: targetRef,
              expectedVersion: current.version,
              cause: 'post_jury',
              decisionId: randomUUID(),
            },
            tx,
          ),
          'removed',
        );
        entered();
        await resume;
      });
      await Promise.race([
        held,
        deletion.then(() => {
          throw new Error('Deletion did not hold its transaction');
        }),
      ]);
      const publication = request(http)
        .post(losing.path)
        .set('Authorization', `Bearer ${racingActor.accessToken}`)
        .send(losing.body)
        .then((value) => value);
      try {
        await f.waitForLock('pg_advisory_xact_lock');
      } finally {
        release();
      }
      await deletion;
      const rejected = await publication;
      responseOk(rejected, 201);
      assert.equal(rejected.body.outcome, 'rejected');
      assert.equal(
        (
          await f.pool.query(
            'SELECT 1 FROM whaleu_media.bindings WHERE asset_id=ANY($1::uuid[])',
            [losing.body.imageAssetIds],
          )
        ).rowCount,
        0,
        'A publication waiting behind ancestor deletion cannot insert descendants behind the cleanup cursor',
      );
      responseOk(
        await request(http)
          .delete(`/v1/community/posts/${postId}`)
          .set('Authorization', auth),
        204,
      );
      const postJob = await jobFor(f, 'post', postId);
      const first = await Promise.all([
        worker().runOnePage(postJob.id),
        worker().runOnePage(rootJob.id),
      ]);
      assert.ok(first.every((result) => result.status === 'progress'));
      await Promise.all([
        worker().runOnePage(postJob.id),
        worker().runOnePage(rootJob.id),
      ]);
      assert.deepEqual(await worker().runOnePage(postJob.id), {
        status: 'enumeration-complete',
        jobId: postJob.id,
        detachedTargets: 2,
      });
      assert.equal(
        (
          await f.pool.query(
            'SELECT 1 FROM whaleu_community.media_cleanup_jobs WHERE enumeration_completed_at IS NULL',
          )
        ).rowCount,
        0,
      );
      assert.equal(
        (
          await f.pool.query(
            'SELECT 1 FROM whaleu_media.bindings WHERE detached_at IS NULL',
          )
        ).rowCount,
        0,
      );
      const obligationCount = (
        await f.pool.query('SELECT 1 FROM whaleu_media.cleanup_obligations')
      ).rowCount;
      assert.deepEqual(await worker().runOnePage(), { status: 'idle' });
      assert.equal(
        (await f.pool.query('SELECT 1 FROM whaleu_media.cleanup_obligations'))
          .rowCount,
        obligationCount,
      );
      assert.equal(
        (
          await f.pool.query(
            "SELECT 1 FROM whaleu_media.cleanup_obligations WHERE state='deleted' OR confirmed_deleted_at IS NOT NULL",
          )
        ).rowCount,
        0,
      );
      assert.equal(
        (
          await f.pool.query(
            "SELECT 1 FROM whaleu_community.outbox WHERE event_type='moderation_removed' AND resource_id=$1",
            [root.id],
          )
        ).rowCount,
        1,
      );
    } finally {
      await f.close();
    }
  },
);
