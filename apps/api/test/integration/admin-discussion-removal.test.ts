import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import request from 'supertest';
import { adminDiscussionRemovalFixture } from '../support/admin-discussion-removal-fixture.js';
import { profileOk } from '../support/media/profile-runtime-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import { CommentComponentSettlement } from '../../src/community/comment-component/settlement.js';
import { DatabaseService } from '../../src/database/database.js';
import { MediaContentSnapshotFacade } from '../../src/media/content-snapshot.facade.js';

/** Actual canonical publications and independent HTTP owner; no fabricated grants
 * outside this explicitly disposable fixture and no fake jury/owner effects. */
test(
  'ordinary admin root and reply removal has exact child-only cause, no notices or XP, and canonical component settlement',
  { timeout: 240000 },
  async (t) => {
    const f = await adminDiscussionRemovalFixture(true);
    let restoreReadBatch: (() => void) | undefined = undefined;
    t.after(async () => {
      try {
        await f.close();
      } finally {
        restoreReadBatch?.();
      }
    });
    // This fixture's moderation app needs the genuine metadata-only reader,
    // alongside its existing Media proof. Keep the caller's client and budget.
    const snapshot = f.moderationApp.get(MediaContentSnapshotFacade);
    const previousReadBatch = Object.getOwnPropertyDescriptor(
      snapshot,
      'readBatch',
    );
    restoreReadBatch = () => {
      if (previousReadBatch)
        Object.defineProperty(snapshot, 'readBatch', previousReadBatch);
      else Reflect.deleteProperty(snapshot, 'readBatch');
    };
    const genuineSnapshot = f.app.get(MediaContentSnapshotFacade);
    snapshot.readBatch = genuineSnapshot.readBatch.bind(genuineSnapshot);
    const owner = await f.actor(),
      author = await f.actor(),
      admin = await f.actor(),
      viewer = await f.actor();
    await f.grant(admin);
    const get = (path: string, actor = viewer) =>
      request(f.http)
        .get(path)
        .set('Authorization', `Bearer ${actor.accessToken}`);
    const immutable = async () =>
      (
        await f.pool.query(`SELECT jsonb_build_object(
    'profiles',(SELECT jsonb_agg(to_jsonb(p) ORDER BY account_id) FROM whaleu_profile.profiles p),
    'grants',(SELECT jsonb_agg(to_jsonb(g) ORDER BY id) FROM whaleu_authorization.role_grants g),
    'accounts',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM whaleu_identity.accounts a),
    'sources',(SELECT jsonb_agg(to_jsonb(b) ORDER BY content_kind,content_id) FROM whaleu_community.content_approval_bindings b),
    'notices',(SELECT count(*) FROM whaleu_notifications.admin_post_removal_notices),
    'xp',(SELECT jsonb_agg(to_jsonb(o) ORDER BY event_key) FROM whaleu_community.outbox o WHERE event_type IN('post_deleted','comment_deleted','reply_deleted','moderation_removed'))) value`)
      ).rows[0]!.value;
    for (const kind of ['comment', 'reply'] as const)
      for (const mode of ['named', 'anonymous'] as const)
        for (const images of [false, true]) {
          const post = await f.publish(owner, { authorMode: mode });
          const root = await f.discussion(author, post.id, {
            authorMode: mode,
            images,
            text: images ? '' : 'Root target',
          });
          const siblingRoot = await f.discussion(viewer, post.id, {
            authorMode: mode,
          });
          const reply = await f.discussion(author, post.id, {
            rootId: root.id,
            authorMode: mode,
            images,
            text: images ? '' : 'Reply target',
          });
          const reference = await f.discussion(viewer, post.id, {
            rootId: root.id,
            targetReplyId: reply.id,
            authorMode: mode,
          });
          const target = kind === 'comment' ? root : reply;
          if (kind === 'comment')
            profileOk(
              await request(f.http)
                .put(`/v1/community/comments/${root.id}/pin`)
                .set('Authorization', `Bearer ${owner.accessToken}`)
                .send({ clientRequestId: randomUUID() }),
            );
          const table = kind === 'comment' ? 'root_comments' : 'replies';
          const before = (
            await f.pool.query(
              `SELECT to_jsonb(t) value FROM whaleu_community.${table} t WHERE id=$1`,
              [target.id],
            )
          ).rows[0]!.value;
          const rowsBefore = (
            await f.pool.query(
              `SELECT jsonb_build_object('post',(SELECT to_jsonb(p) FROM whaleu_community.posts p WHERE id=$1),'roots',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM whaleu_community.root_comments c WHERE post_id=$1 AND id<>$2),'replies',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM whaleu_community.replies r WHERE post_id=$1 AND id<>$2)) value`,
              [post.id, target.id],
            )
          ).rows[0]!.value;
          const stable = await immutable();
          const management = await f.removalManagement(target, admin);
          assert.deepEqual(Object.keys(management).sort(), [
            'canRemove',
            'target',
            'targetVersion',
          ]);
          assert.ok(!JSON.stringify(management).includes(author.accountId));
          const body = f.removalCommand(target, management.targetVersion);
          const result = await f.removalSend(admin, body);
          profileOk(result);
          assert.equal(result.body.outcome, 'applied');
          const after = (
            await f.pool.query(
              `SELECT to_jsonb(t) value FROM whaleu_community.${table} t WHERE id=$1`,
              [target.id],
            )
          ).rows[0]!.value;
          assert.ok(after.deleted_at);
          assert.deepEqual(
            {
              ...after,
              deleted_at: before.deleted_at,
              local_deletion_transaction: before.local_deletion_transaction,
            },
            before,
          );
          const rowsAfter = (
            await f.pool.query(
              `SELECT jsonb_build_object('post',(SELECT to_jsonb(p) FROM whaleu_community.posts p WHERE id=$1),'roots',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM whaleu_community.root_comments c WHERE post_id=$1 AND id<>$2),'replies',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM whaleu_community.replies r WHERE post_id=$1 AND id<>$2)) value`,
              [post.id, target.id],
            )
          ).rows[0]!.value;
          assert.deepEqual(rowsAfter, rowsBefore);
          assert.deepEqual(await immutable(), stable);
          const facts = (
            await f.pool.query(
              `SELECT
      (SELECT count(*)::int FROM whaleu_community.admin_discussion_removal_events WHERE target_kind=$1 AND target_id=$2) events,
      (SELECT count(*)::int FROM whaleu_community.admin_discussion_removal_transitions WHERE target_kind=$1 AND target_id=$2) transitions,
      (SELECT count(*)::int FROM whaleu_community.media_cleanup_jobs WHERE resource_kind=$1 AND resource_id=$2 AND phase='self' AND cursor_id IS NULL AND detached_targets=0 AND enumeration_completed_at IS NULL) jobs,
      (SELECT count(*)::int FROM whaleu_community.outbox WHERE resource_id=$2 AND event_type='admin_discussion_removed') administrative,
      (SELECT count(*)::int FROM whaleu_post_hotness.comment_sources WHERE content_id=$2 AND transition='deleted' AND actor_id=$3 AND delta=-1) negative,
      (SELECT count(*)::int FROM whaleu_post_hotness.comment_sources WHERE content_id=$4 AND transition='deleted') reference_negative`,
              [kind, target.id, author.accountId, reference.id],
            )
          ).rows[0]!;
          assert.deepEqual(facts, {
            events: 1,
            transitions: 1,
            jobs: 1,
            administrative: 1,
            negative: 1,
            reference_negative: 0,
          });
          const publicPost = await get(`/v1/community/posts/${post.id}`);
          profileOk(publicPost);
          assert.equal(
            publicPost.body.commentCount,
            kind === 'comment' ? 1 : 2,
          );
          assert.equal(publicPost.body.replyCount, kind === 'comment' ? 0 : 1);
          assert.equal(
            publicPost.body.discussionCount,
            kind === 'comment' ? 1 : 3,
          );
          profileOk(await get(`/v1/community/comments/${siblingRoot.id}`));
          assert.notEqual(
            (
              await get(
                `/v1/community/${kind === 'comment' ? 'comments' : 'replies'}/${target.id}`,
              )
            ).status,
            200,
          );
          if (kind === 'comment') {
            assert.notEqual(
              (await get(`/v1/community/replies/${reply.id}`)).status,
              200,
            );
            assert.notEqual(
              (await get(`/v1/community/replies/${reference.id}`)).status,
              200,
            );
            assert.equal(
              (
                await f.pool.query(
                  'SELECT 1 FROM whaleu_community.comment_pins WHERE comment_id=$1',
                  [root.id],
                )
              ).rowCount,
              0,
            );
          } else {
            profileOk(await get(`/v1/community/comments/${root.id}`));
            const still = await get(`/v1/community/replies/${reference.id}`);
            profileOk(still);
            assert.deepEqual(still.body.target, { status: 'unavailable' });
            assert.ok(!JSON.stringify(still.body).includes(author.accountId));
          }
          for (const operation of [
            () => f.removalSend(admin, body),
            () => f.removalSend(admin, body, true),
          ]) {
            const replay = await operation();
            profileOk(replay);
            assert.deepEqual(replay.body, result.body);
          }
          assert.equal(
            (
              await f.removalSend(admin, {
                ...body,
                target: {
                  kind: kind === 'comment' ? 'reply' : 'comment',
                  id: target.id,
                },
              })
            ).status,
            409,
          );
          const recovery = await f.removalRecovery(admin, body.clientRequestId);
          profileOk(recovery);
          assert.deepEqual(recovery.body, {
            state: 'recorded',
            receipt: result.body,
          });
          assert.deepEqual(
            (await f.removalRecovery(viewer, body.clientRequestId)).body,
            { state: 'not_recorded' },
          );
          const sources = await f.pool.query<{ id: string }>(
            'SELECT id FROM whaleu_post_hotness.comment_sources WHERE post_id=$1 ORDER BY source_sequence',
            [post.id],
          );
          const settlement = f.app.get(CommentComponentSettlement),
            database = f.app.get(DatabaseService);
          for (const source of sources.rows)
            assert.equal(
              await database.transaction(
                (tx) => settlement.process(source.id, tx, true),
                { isolationLevel: 'read committed' },
              ),
              'applied',
            );
          for (const source of sources.rows)
            assert.equal(
              await database.transaction(
                (tx) => settlement.process(source.id, tx, true),
                { isolationLevel: 'read committed' },
              ),
              'alreadyCompleted',
            );
          const counts = (
            await f.pool.query(
              'SELECT root_count,reply_count,eligible_count,unique_actor_count FROM whaleu_post_hotness.comment_states WHERE post_id=$1',
              [post.id],
            )
          ).rows[0]!;
          assert.deepEqual(counts, {
            root_count: kind === 'comment' ? '1' : '2',
            reply_count: kind === 'comment' ? '2' : '1',
            eligible_count: '3',
            unique_actor_count: '2',
          });
        }
  },
);

test(
  'selected-child ownership, true grant scope, target references, and identity-only recovery are independent',
  { timeout: 180000 },
  async (t) => {
    const f = await adminDiscussionRemovalFixture();
    t.after(() => f.close());
    const author = await f.actor(),
      admin = await f.actor(),
      outsider = await f.actor(),
      developer = await f.actor(),
      superAdmin = await f.actor();
    const grant = await f.grant(admin);
    await f.grant(developer, 'developer', null);
    await f.grant(superAdmin, 'super_admin', null);
    for (const kind of ['comment', 'reply'] as const) {
      const post = await f.publish(admin),
        root = await f.discussion(author, post.id),
        reply = await f.discussion(author, post.id, { rootId: root.id });
      const target = kind === 'comment' ? root : reply;
      for (const actor of [outsider, developer]) {
        const denied = await request(f.http)
          .get('/v1/community/admin-discussion-removal/management')
          .set('Authorization', `Bearer ${actor.accessToken}`)
          .query({ kind: target.kind, id: target.id });
        assert.notEqual(denied.status, 200);
      }
      await f.removalApply(target, admin);
      const otherPost = await f.publish(outsider),
        otherRoot = await f.discussion(author, otherPost.id);
      const otherTarget =
        kind === 'comment'
          ? otherRoot
          : await f.discussion(author, otherPost.id, { rootId: otherRoot.id });
      const denial = await request(f.http)
        .get('/v1/community/admin-discussion-removal/management')
        .set('Authorization', `Bearer ${outsider.accessToken}`)
        .query({ kind: otherTarget.kind, id: otherTarget.id });
      assert.notEqual(
        denial.status,
        200,
        'Post ownership alone never authorizes deleting another child',
      );
      await f.removalApply(otherTarget, superAdmin);
      const ownPost = await f.publish(author),
        ownRoot = await f.discussion(admin, ownPost.id),
        ownTarget =
          kind === 'comment'
            ? ownRoot
            : await f.discussion(admin, ownPost.id, { rootId: ownRoot.id });
      const own = await request(f.http)
        .get('/v1/community/admin-discussion-removal/management')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .query({ kind: ownTarget.kind, id: ownTarget.id });
      assert.equal(own.body.error.code, 'ADMIN_DISCUSSION_REMOVAL_OWN_CONTENT');
      const ownerDelete = await request(f.http)
        .delete(
          `/v1/community/${kind === 'comment' ? 'comments' : 'replies'}/${ownTarget.id}`,
        )
        .set('Authorization', `Bearer ${admin.accessToken}`);
      assert.equal(ownerDelete.status, 204, JSON.stringify(ownerDelete.body));
      if (kind === 'reply') {
        const foreignChild = await f.discussion(author, ownPost.id, {
          rootId: ownRoot.id,
        });
        await f.removalApply(foreignChild, admin);
      }
    }
    const post = await f.publish(author),
      root = await f.discussion(author, post.id);
    const view = await f.removalManagement(root, admin),
      command = f.removalCommand(root, view.targetVersion);
    await withCommunityScopeWriter(f.pool, (tx) =>
      tx.query(
        'UPDATE whaleu_authorization.role_grants SET revoked_at=clock_timestamp(),revoked_by_account_id=account_id WHERE id=$1',
        [grant],
      ),
    );
    const cancel = await f.removalSend(admin, command, true);
    profileOk(cancel);
    assert.equal(cancel.body.code, 'ADMIN_DISCUSSION_REMOVAL_CANCELLED');
    assert.deepEqual((await f.removalSend(admin, command)).body, cancel.body);
    assert.deepEqual(
      (await f.removalRecovery(admin, command.clientRequestId)).body,
      { state: 'recorded', receipt: cancel.body },
    );
    assert.deepEqual((await f.removalRecovery(admin, randomUUID())).body, {
      state: 'not_recorded',
    });
    assert.equal(
      (
        await f.pool.query(
          'SELECT deleted_at FROM whaleu_community.root_comments WHERE id=$1',
          [root.id],
        )
      ).rows[0]!.deleted_at,
      null,
    );
  },
);

test(
  'canonical comment settlement keeps post-owner contributions ineligible and removes a shared author only after their final child',
  { timeout: 120000 },
  async (t) => {
    const f = await adminDiscussionRemovalFixture();
    t.after(() => f.close());
    const owner = await f.actor(),
      author = await f.actor(),
      admin = await f.actor();
    await f.grant(admin);
    const post = await f.publish(owner),
      ownerRoot = await f.discussion(owner, post.id),
      root = await f.discussion(author, post.id),
      reply = await f.discussion(author, post.id, { rootId: root.id });
    const database = f.app.get(DatabaseService),
      settlement = f.app.get(CommentComponentSettlement);
    const settle = async () => {
      const sources = await f.pool.query<{ id: string }>(
        'SELECT id FROM whaleu_post_hotness.comment_sources WHERE post_id=$1 ORDER BY source_sequence',
        [post.id],
      );
      for (const source of sources.rows)
        await database.transaction(
          (tx) => settlement.process(source.id, tx, true),
          { isolationLevel: 'read committed' },
        );
      return (
        await f.pool.query(
          'SELECT root_count,reply_count,eligible_count,unique_actor_count FROM whaleu_post_hotness.comment_states WHERE post_id=$1',
          [post.id],
        )
      ).rows[0];
    };
    assert.deepEqual(await settle(), {
      root_count: '2',
      reply_count: '1',
      eligible_count: '2',
      unique_actor_count: '1',
    });
    await f.removalApply(reply, admin);
    assert.deepEqual(await settle(), {
      root_count: '2',
      reply_count: '0',
      eligible_count: '1',
      unique_actor_count: '1',
    });
    await f.removalApply(root, admin);
    assert.deepEqual(await settle(), {
      root_count: '1',
      reply_count: '0',
      eligible_count: '0',
      unique_actor_count: '0',
    });
    await f.removalApply(ownerRoot, admin);
    assert.deepEqual(await settle(), {
      root_count: '0',
      reply_count: '0',
      eligible_count: '0',
      unique_actor_count: '0',
    });
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::int n FROM whaleu_post_hotness.comment_receipts WHERE post_id=$1',
          [post.id],
        )
      ).rows[0]!.n,
      6,
    );
  },
);
