import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import request from 'supertest';
import { sha256 } from '../../src/media/processing/protocol.js';
import { syntheticMediaRuntimeFixture } from '../support/media/runtime-fixture.js';
import {
  publishDiscussionPost,
  readyDiscussionBatch,
  responseOk,
  sealDiscussionBatch,
} from '../support/media/discussion-batch-fixture.js';
import type {
  BatchActor,
  BatchFixture,
} from '../support/media/discussion-batch-fixture.js';
import {
  approveEnvelope,
  seedReviewPolicy,
} from '../support/community-approval-fixtures.js';
import { discussionApprovalEnvelope } from '../support/community-runtime-fixtures.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';

type Kind = 'comment' | 'reply';
const authorization = (actor: BatchActor) => `Bearer ${actor.accessToken}`;
const pathFor = (kind: Kind, id: string) =>
  `/v1/community/${kind === 'comment' ? 'comments' : 'replies'}/${id}`;

async function textContent(
  f: BatchFixture,
  actor: BatchActor,
  postId: string,
  rootId: string | null = null,
) {
  const common = {
    clientRequestId: randomUUID(),
    text: 'Deletion qualification ancestor',
    imageAssetIds: [],
    authorMode: 'named' as const,
  };
  const body = rootId ? { ...common, targetReplyId: null } : common;
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
    .post(
      rootId
        ? `/v1/community/comments/${rootId}/replies`
        : `/v1/community/posts/${postId}/comments`,
    )
    .set('Authorization', authorization(actor))
    .send(body);
  responseOk(result, 201);
  assert.equal(result.body.outcome, 'created');
  return result.body.resourceId as string;
}

async function imageContent(
  f: BatchFixture,
  actor: BatchActor,
  target: Parameters<typeof readyDiscussionBatch>[2],
  bytes: Buffer,
) {
  const ready = await readyDiscussionBatch(f, actor, target, 3, [
    { mime: 'image/png', bytes },
  ]);
  const sealed = await sealDiscussionBatch(f, actor, ready.status, '');
  const result = await request(f.app.getHttpServer())
    .post(sealed.path)
    .set('Authorization', authorization(actor))
    .send(sealed.body);
  responseOk(result, 201);
  assert.equal(result.body.outcome, 'created');
  return {
    kind: target.kind,
    id: result.body.resourceId as string,
    assets: sealed.body.imageAssetIds,
    requestId: sealed.body.clientRequestId,
    receipt: result.body as unknown,
  };
}
type ImageContent = Awaited<ReturnType<typeof imageContent>>;

/** Snapshot durable owner effects, including original history and both cleanup
 * queues. Timestamps/provenance are compared as PostgreSQL JSON, without repair. */
async function snapshot(
  f: BatchFixture,
  actor: BatchActor,
  content: ImageContent,
) {
  const { id, kind, assets, requestId } = content;
  const table = kind === 'comment' ? 'root_comments' : 'replies';
  const rows = async (sql: string, values: unknown[]) =>
    (await f.pool.query(sql, values)).rows;
  const intents =
    'SELECT intent_id FROM whaleu_media.assets WHERE id=ANY($1::uuid[])';
  return {
    content: await rows(
      `SELECT to_jsonb(c) value FROM whaleu_community.${table} c WHERE id=$1`,
      [id],
    ),
    images: await rows(
      `SELECT to_jsonb(i) value FROM whaleu_community.${kind}_images i WHERE ${kind}_id=$1 ORDER BY position`,
      [id],
    ),
    bindings: await rows(
      'SELECT to_jsonb(b) value FROM whaleu_media.bindings b WHERE asset_id=ANY($1::uuid[]) ORDER BY ordinal,id',
      [assets],
    ),
    intents: await rows(
      `SELECT to_jsonb(i) value FROM whaleu_media.upload_intents i WHERE id IN (${intents}) ORDER BY id`,
      [assets],
    ),
    quota: await rows(
      `SELECT to_jsonb(q) value FROM whaleu_media.quota_reservations q WHERE intent_id IN (${intents}) ORDER BY intent_id`,
      [assets],
    ),
    attempts: await rows(
      `SELECT to_jsonb(a) value FROM whaleu_media.object_attempts a WHERE intent_id IN (${intents}) ORDER BY id`,
      [assets],
    ),
    derivatives: await rows(
      `SELECT to_jsonb(d) value FROM whaleu_media.derived_object_attempts d WHERE intent_id IN (${intents}) ORDER BY id`,
      [assets],
    ),
    ingress: await rows(
      `SELECT to_jsonb(i) value FROM whaleu_media.upload_ingress i WHERE intent_id IN (${intents}) ORDER BY intent_id,generation,object_attempt_id`,
      [assets],
    ),
    mediaCleanup: await rows(
      `SELECT to_jsonb(c) value FROM whaleu_media.cleanup_obligations c
      WHERE asset_id=ANY($1::uuid[])
        OR object_attempt_id IN (SELECT id FROM whaleu_media.object_attempts WHERE intent_id IN (${intents}))
        OR derived_attempt_id IN (SELECT id FROM whaleu_media.derived_object_attempts WHERE intent_id IN (${intents}))
      ORDER BY id`,
      [assets],
    ),
    communityCleanup: await rows(
      'SELECT to_jsonb(j) value FROM whaleu_community.media_cleanup_jobs j WHERE resource_kind=$1 AND resource_id=$2 ORDER BY id',
      [kind, id],
    ),
    outbox: await rows(
      'SELECT to_jsonb(o) value FROM whaleu_community.outbox o WHERE resource_id=$1 ORDER BY id',
      [id],
    ),
    rewards: await rows(
      'SELECT to_jsonb(g) value FROM whaleu_community.reward_source_groups g WHERE event_id IN (SELECT id FROM whaleu_community.outbox WHERE resource_id=$1) ORDER BY id',
      [id],
    ),
    publication: await rows(
      'SELECT to_jsonb(p) value FROM whaleu_community.publication_requests p WHERE account_id=$1 AND client_request_id=$2',
      [actor.accountId, requestId],
    ),
    pins:
      kind === 'comment'
        ? await rows(
            'SELECT to_jsonb(p) value FROM whaleu_community.comment_pins p WHERE comment_id=$1',
            [id],
          )
        : [],
  };
}

async function assertPendingDeletion(f: BatchFixture, content: ImageContent) {
  const table = content.kind === 'comment' ? 'root_comments' : 'replies';
  const row = (
    await f.pool.query<{ deleted_at: Date | null }>(
      `SELECT deleted_at FROM whaleu_community.${table} WHERE id=$1`,
      [content.id],
    )
  ).rows[0]!;
  assert.ok(row.deleted_at);
  const bindings = (
    await f.pool.query<{
      asset_id: string;
      ordinal: number;
      detached_at: Date | null;
      detach_reason: string | null;
    }>(
      'SELECT asset_id,ordinal,detached_at,detach_reason FROM whaleu_media.bindings WHERE resource_kind=$1 AND resource_id=$2 ORDER BY ordinal',
      [content.kind, content.id],
    )
  ).rows;
  assert.deepEqual(
    bindings.map((binding) => binding.asset_id),
    content.assets,
  );
  assert.deepEqual(
    bindings.map((binding) => binding.ordinal),
    [0, 1, 2],
  );
  assert.ok(
    bindings.every(
      (binding) =>
        binding.detached_at && binding.detach_reason === 'owner-deleted',
    ),
  );
  const jobs = (
    await f.pool.query<{
      phase: string;
      cursor_id: string | null;
      detached_targets: string;
      enumeration_completed_at: Date | null;
      source_deleted_at: Date;
    }>(
      'SELECT * FROM whaleu_community.media_cleanup_jobs WHERE resource_kind=$1 AND resource_id=$2',
      [content.kind, content.id],
    )
  ).rows;
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]!.phase, 'self');
  assert.equal(jobs[0]!.cursor_id, null);
  assert.equal(jobs[0]!.detached_targets, '0');
  assert.equal(jobs[0]!.enumeration_completed_at, null);
  assert.deepEqual(jobs[0]!.source_deleted_at, row.deleted_at);
  assert.equal(
    (
      await f.pool.query(
        "SELECT 1 FROM whaleu_media.upload_intents WHERE id IN (SELECT intent_id FROM whaleu_media.assets WHERE id=ANY($1::uuid[])) AND state='cleanup_pending'",
        [content.assets],
      )
    ).rowCount,
    3,
  );
  assert.equal(
    (
      await f.pool.query(
        'SELECT 1 FROM whaleu_community.outbox WHERE resource_id=$1 AND event_type=$2',
        [content.id, `${content.kind}_deleted`],
      )
    ).rowCount,
    1,
  );
  assert.equal(
    (
      await f.pool.query(
        "SELECT 1 FROM whaleu_media.cleanup_obligations WHERE state='deleted' OR confirmed_deleted_at IS NOT NULL",
      )
    ).rowCount,
    0,
    'Logical owner deletion does not assert physical absence',
  );
}

test(
  'discussion owner deletion proves its exact three-image transition and retains original qualification at commit',
  { timeout: 600000 },
  async (t) => {
    const sharp = (await import('sharp')).default;
    const bytes = await sharp({
      create: { width: 80, height: 60, channels: 3, background: '#315577' },
    })
      .png()
      .toBuffer();
    const f = await syntheticMediaRuntimeFixture([
      { sha256: sha256(bytes), verdict: 'allow' },
    ]);
    try {
      await seedReviewPolicy(f.pool);
      const http = f.app.getHttpServer();
      const remove = (actor: BatchActor, content: { kind: Kind; id: string }) =>
        request(http)
          .delete(pathFor(content.kind, content.id))
          .set('Authorization', authorization(actor));

      for (const kind of ['comment', 'reply'] as const)
        await t.test(
          `${kind}: failure on the third detached binding rolls back tombstone, every binding, queue and event; retry and repeated own delete are exact`,
          async () => {
            const actor = await f.actor();
            const postId = await publishDiscussionPost(f, actor);
            const rootId =
              kind === 'reply' ? await textContent(f, actor, postId) : null;
            const content = await imageContent(
              f,
              actor,
              kind === 'comment'
                ? { kind, postId }
                : { kind, rootCommentId: rootId!, targetReplyId: null },
              bytes,
            );
            if (kind === 'comment') {
              const pin = await request(http)
                .put(`/v1/community/comments/${content.id}/pin`)
                .set('Authorization', authorization(actor))
                .send({ clientRequestId: randomUUID() });
              responseOk(pin);
              assert.equal(pin.body.outcome, 'applied');
            }
            const before = await snapshot(f, actor, content);
            // AFTER ROW observes the completed three-row UPDATE. This deliberately
            // fails the original ordinal=2 member after observing all three effects.
            // The private sequence witnesses execution even though SQL rolls back.
            await f.pool
              .query(`CREATE SEQUENCE whaleu_media.synthetic_delete_detach_seen;
          CREATE FUNCTION whaleu_media.synthetic_delete_last_binding() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            IF NEW.resource_id=TG_ARGV[0]::uuid AND NEW.ordinal=2
              AND OLD.detached_at IS NULL AND NEW.detached_at IS NOT NULL THEN
              IF (SELECT count(*) FROM whaleu_media.bindings WHERE resource_id=NEW.resource_id AND resource_kind=NEW.resource_kind AND detached_at IS NOT NULL) <> 3 THEN
                RAISE EXCEPTION 'synthetic expected entire three-image detach statement';
              END IF;
              PERFORM nextval('whaleu_media.synthetic_delete_detach_seen');
              RAISE EXCEPTION 'synthetic ordinal two detach failure';
            END IF;
            RETURN NEW;
          END $$;
          CREATE TRIGGER z_synthetic_delete_last_binding AFTER UPDATE ON whaleu_media.bindings
          FOR EACH ROW EXECUTE FUNCTION whaleu_media.synthetic_delete_last_binding('${content.id}')`);
            try {
              assert.ok((await remove(actor, content)).status >= 400);
              assert.deepEqual(
                (
                  await f.pool.query(
                    'SELECT last_value::text,is_called FROM whaleu_media.synthetic_delete_detach_seen',
                  )
                ).rows,
                [{ last_value: '1', is_called: true }],
              );
              assert.deepEqual(await snapshot(f, actor, content), before);
            } finally {
              await f.pool.query(
                'DROP TRIGGER z_synthetic_delete_last_binding ON whaleu_media.bindings; DROP FUNCTION whaleu_media.synthetic_delete_last_binding(); DROP SEQUENCE whaleu_media.synthetic_delete_detach_seen',
              );
            }
            responseOk(await remove(actor, content), 204);
            await assertPendingDeletion(f, content);
            const deleted = await snapshot(f, actor, content);
            responseOk(await remove(actor, content), 204);
            assert.deepEqual(await snapshot(f, actor, content), deleted);
            const receipt = await request(http)
              .get(`/v1/me/community/requests/${content.requestId}`)
              .set('Authorization', authorization(actor));
            responseOk(receipt);
            assert.deepEqual(receipt.body, content.receipt);
          },
        );

      for (const targetState of ['hidden', 'deleted'] as const)
        await t.test(
          `a ${targetState} referenced target is not a new prerequisite for deleting one's own image reply`,
          async () => {
            const actor = await f.actor();
            const postId = await publishDiscussionPost(f, actor);
            const rootId = await textContent(f, actor, postId);
            const targetId = await textContent(f, actor, postId, rootId);
            const content = await imageContent(
              f,
              actor,
              { kind: 'reply', rootCommentId: rootId, targetReplyId: targetId },
              bytes,
            );
            if (targetState === 'hidden')
              await withCommunityScopeWriter(f.pool, (tx) =>
                tx.query(
                  "UPDATE whaleu_community.replies SET visibility='hidden' WHERE id=$1",
                  [targetId],
                ),
              );
            else
              responseOk(
                await remove(actor, { kind: 'reply', id: targetId }),
                204,
              );
            const visible = await request(http)
              .get(pathFor('reply', content.id))
              .set('Authorization', authorization(actor));
            responseOk(visible);
            assert.equal(visible.body.target.status, 'unavailable');
            assert.equal(visible.body.images.length, 3);
            responseOk(await remove(actor, content), 204);
            await assertPendingDeletion(f, content);
            const targets = await f.pool.query(
              'SELECT 1 FROM whaleu_community.media_cleanup_jobs WHERE resource_kind=$1 AND resource_id=$2',
              ['reply', targetId],
            );
            assert.equal(targets.rowCount, targetState === 'deleted' ? 1 : 0);
          },
        );

      for (const ancestor of ['root', 'post'] as const)
        for (const state of ['hidden', 'deleted'] as const)
          await t.test(
            `${ancestor} ${state}: original child delete qualification denies without detaching or falsely completing queues`,
            async () => {
              // Six new intents for this fresh actor remain below the unchanged
              // ten-per-minute budget; published batches do not stay active.
              const actor = await f.actor();
              const postId = await publishDiscussionPost(f, actor);
              const root = await imageContent(
                f,
                actor,
                { kind: 'comment', postId },
                bytes,
              );
              const reply = await imageContent(
                f,
                actor,
                { kind: 'reply', rootCommentId: root.id, targetReplyId: null },
                bytes,
              );
              const ancestorId = ancestor === 'post' ? postId : root.id;
              if (state === 'hidden') {
                const table = ancestor === 'post' ? 'posts' : 'root_comments';
                await withCommunityScopeWriter(f.pool, (tx) =>
                  tx.query(
                    `UPDATE whaleu_community.${table} SET visibility='hidden' WHERE id=$1`,
                    [ancestorId],
                  ),
                );
              } else if (ancestor === 'post') {
                responseOk(
                  await request(http)
                    .delete(`/v1/community/posts/${postId}`)
                    .set('Authorization', authorization(actor)),
                  204,
                );
              } else responseOk(await remove(actor, root), 204);
              const original = await snapshot(f, actor, reply);
              const denied = await remove(actor, reply);
              assert.equal(denied.status, 404, JSON.stringify(denied.body));
              assert.equal(
                denied.body.error.code,
                ancestor === 'post' ? 'POST_NOT_FOUND' : 'COMMENT_NOT_FOUND',
              );
              assert.deepEqual(await snapshot(f, actor, reply), original);
              if (ancestor === 'post' || state === 'hidden') {
                const originalRoot = await snapshot(f, actor, root);
                const deniedRoot = await remove(actor, root);
                assert.equal(
                  deniedRoot.status,
                  404,
                  JSON.stringify(deniedRoot.body),
                );
                assert.equal(
                  deniedRoot.body.error.code,
                  ancestor === 'post' ? 'POST_NOT_FOUND' : 'COMMENT_NOT_FOUND',
                );
                assert.deepEqual(await snapshot(f, actor, root), originalRoot);
              }
              assert.equal(
                (
                  await f.pool.query(
                    'SELECT 1 FROM whaleu_community.media_cleanup_jobs WHERE resource_kind=$1 AND resource_id=$2',
                    ['reply', reply.id],
                  )
                ).rowCount,
                0,
              );
              const jobs = (
                await f.pool.query(
                  'SELECT phase,cursor_id,detached_targets::text,enumeration_completed_at FROM whaleu_community.media_cleanup_jobs WHERE resource_kind=$1 AND resource_id=$2',
                  [ancestor === 'post' ? 'post' : 'comment', ancestorId],
                )
              ).rows;
              assert.deepEqual(
                jobs,
                state === 'deleted'
                  ? [
                      {
                        phase: 'self',
                        cursor_id: null,
                        detached_targets: '0',
                        enumeration_completed_at: null,
                      },
                    ]
                  : [],
              );
            },
          );

      await t.test(
        'a deferred Media writer after delete collector finalization refuses COMMIT and rolls back all logical effects',
        async () => {
          const actor = await f.actor();
          const postId = await publishDiscussionPost(f, actor);
          const rootId = await textContent(f, actor, postId);
          const content = await imageContent(
            f,
            actor,
            { kind: 'reply', rootCommentId: rootId, targetReplyId: null },
            bytes,
          );
          const before = await snapshot(f, actor, content);
          await f.pool
            .query(`CREATE SEQUENCE whaleu_media.synthetic_delete_deferred_seen;
        CREATE FUNCTION whaleu_media.synthetic_delete_deferred_writer() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.id=TG_ARGV[0]::uuid THEN
            IF (SELECT count(*) FROM whaleu_media.bindings WHERE resource_kind='reply' AND resource_id=NEW.id AND detached_at IS NOT NULL) <> 3
              OR NOT EXISTS (SELECT 1 FROM whaleu_community.media_cleanup_jobs WHERE resource_kind='reply' AND resource_id=NEW.id AND phase='self' AND enumeration_completed_at IS NULL) THEN
              RAISE EXCEPTION 'synthetic expected completed logical deletion before deferred writer';
            END IF;
            PERFORM nextval('whaleu_media.synthetic_delete_deferred_seen');
            -- Even zero-row writes use the real statement-level Media epoch.
            UPDATE whaleu_media.assets SET created_at=created_at WHERE false;
          END IF;
          RETURN NULL;
        END $$;
        CREATE CONSTRAINT TRIGGER z_synthetic_delete_deferred_writer AFTER UPDATE ON whaleu_community.replies
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
        WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL)
        EXECUTE FUNCTION whaleu_media.synthetic_delete_deferred_writer('${content.id}')`);
          try {
            const rejected = await remove(actor, content);
            assert.ok(rejected.status >= 400);
            assert.equal(rejected.body.error.code, 'MEDIA_UNAVAILABLE');
            assert.deepEqual(
              (
                await f.pool.query(
                  'SELECT last_value::text,is_called FROM whaleu_media.synthetic_delete_deferred_seen',
                )
              ).rows,
              [{ last_value: '1', is_called: true }],
            );
            assert.deepEqual(await snapshot(f, actor, content), before);
          } finally {
            await f.pool.query(
              'DROP TRIGGER z_synthetic_delete_deferred_writer ON whaleu_community.replies; DROP FUNCTION whaleu_media.synthetic_delete_deferred_writer(); DROP SEQUENCE whaleu_media.synthetic_delete_deferred_seen',
            );
          }
          responseOk(await remove(actor, content), 204);
          await assertPendingDeletion(f, content);
        },
      );
    } finally {
      await f.close();
    }
  },
);
