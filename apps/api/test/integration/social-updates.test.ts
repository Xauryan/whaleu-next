import { SocialUpdatesRepository } from '../../src/notifications/social/repository.js';
import { CommunitySocialSourceFacade } from '../../src/community/social-source/facade.js';
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { DatabaseService } from '../../src/database/database.js';
import { APP_CONFIG } from '../../src/config/config.js';
import { ApplicationError } from '../../src/http/application-error.js';
import { IdentityRepository } from '../../src/identity/identity.repository.js';
import { mintToken, hashToken } from '../../src/identity/tokens.js';
import { CommunitySocialSourceCapture } from '../../src/community/social-source/capture.js';
import { SOCIAL_UNREAD_CANDIDATE_LIMIT } from '../../src/notifications/social/read.service.js';
import type {
  SocialCategory,
  SocialNotice,
} from '../../src/notifications/social/contracts.js';
import { setReviewState } from '../support/community-approval-fixtures.js';
import {
  socialAuth,
  withSocialUpdatesFixture,
} from '../support/social-updates-fixture.js';
import type {
  SocialActor,
  SocialUpdatesFixture,
} from '../support/social-updates-fixture.js';

const unknownCount = { unreadCount: null, unreadCountStatus: 'unavailable' };
const exactCount = (unreadCount: number) => ({
  unreadCount,
  unreadCountStatus: 'available',
});
const sqlCode = (code: string) => (error: unknown) =>
  error !== null &&
  typeof error === 'object' &&
  'code' in error &&
  error.code === code;
type Kind = 'like' | 'save' | 'follow';
interface SourceRow {
  id: string;
  kind: Kind;
  source_epoch_id: string;
  resource_id: string;
  occurred_at: string;
  event_id: string | null;
  automatic_eligible: boolean;
  state: 'pending' | 'completed';
  outcome: 'materialized' | 'existing' | null;
  notice_id: string | null;
}
async function sources(f: SocialUpdatesFixture, owner: SocialActor) {
  return (
    await f.pool.query<SourceRow>(
      `SELECT s.id,s.kind,s.source_epoch_id,s.resource_id,
       to_char(s.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') occurred_at,
       g.event_id,w.automatic_eligible,w.state,r.outcome,r.notice_id
     FROM whaleu_community.social_sources s
     JOIN whaleu_notifications.social_work w ON w.source_id=s.id
     LEFT JOIN whaleu_community.reward_source_groups g ON g.id=s.reward_group_id
     LEFT JOIN whaleu_notifications.social_receipts r ON r.source_id=s.id
     WHERE s.recipient_account_id=$1 ORDER BY s.occurred_at,s.id`,
      [owner.accountId],
    )
  ).rows;
}
async function applied(
  response: PromiseLike<{ status: number; body: { outcome?: string } }>,
) {
  const result = await response;
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.outcome, 'applied', JSON.stringify(result.body));
  return result.body;
}
function like(
  f: SocialUpdatesFixture,
  actor: SocialActor,
  postId: string,
  liked = true,
  requestId = randomUUID(),
) {
  return request(f.http)
    .put(`/v1/community/posts/${postId}/like`)
    .set('Authorization', socialAuth(actor))
    .send({ requestId, liked });
}
function save(
  f: SocialUpdatesFixture,
  actor: SocialActor,
  postId: string,
  desired = true,
  clientRequestId = randomUUID(),
  cleanup = false,
) {
  const endpoint = cleanup
    ? `/v1/me/community/saved/${postId}`
    : `/v1/community/posts/${postId}/save`;
  return (
    desired ? request(f.http).put(endpoint) : request(f.http).delete(endpoint)
  )
    .set('Authorization', socialAuth(actor))
    .send({ clientRequestId });
}
function follow(
  f: SocialUpdatesFixture,
  actor: SocialActor,
  profileId: string,
  desired = true,
  requestId = randomUUID(),
) {
  const endpoint = `/v1/profiles/${profileId}/follow`;
  return (
    desired ? request(f.http).post(endpoint) : request(f.http).delete(endpoint)
  )
    .set('Authorization', socialAuth(actor))
    .send({ requestId });
}
function neutral(notice: SocialNotice) {
  assert.equal(notice.status, 'available');
  assert.deepEqual(Object.keys(notice).sort(), [
    'createdAt',
    'kind',
    'noticeId',
    'readAt',
    'status',
    'target',
  ]);
}
function unavailable(notice: SocialNotice) {
  assert.equal(notice.status, 'unavailable');
  assert.deepEqual(Object.keys(notice).sort(), [
    'createdAt',
    'noticeId',
    'readAt',
    'status',
  ]);
}

// Real PostgreSQL, unmodified policy providers, exact review owner facts and real
// authenticated producers. No direct notice/source inserts create a happy path.
test(
  'local social sources → atomic work → real worker/dispatcher → owned HTTP and emitted native readers',
  { timeout: 240000 },
  async (t) => {
    await withSocialUpdatesFixture(async (f) => {
      await t.test(
        'HTTP routes require authentication and a strict category',
        async () => {
          await request(f.http)
            .get('/v1/me/social-updates')
            .query({ category: 'likes' })
            .expect(401);
          const actor = await f.actor();
          for (const query of [
            {},
            { category: 'all' },
            { category: 'likes', limit: '21' },
            { category: 'likes', owner: randomUUID() },
          ])
            await request(f.http)
              .get('/v1/me/social-updates')
              .set('Authorization', socialAuth(actor))
              .query(query)
              .expect(400);
          assert.deepEqual(await f.count(actor, 'likes'), exactCount(0));
        },
      );

      for (const category of ['likes', 'saves', 'followers'] as const) {
        await t.test(
          `${category}: fresh capture, concurrent workers, original-request replay and lifetime read settlement`,
          async () => {
            const owner = await f.actor(),
              actor = await f.actor(),
              outsider = await f.actor();
            const post = await f.publish(
              owner,
              category === 'likes' ? 'anonymous' : 'named',
            );
            const ownerProfile = await f.profile(owner),
              actorProfile = await f.profile(actor);
            const mutate = (desired = true, requestId = randomUUID()) =>
              category === 'likes'
                ? like(f, actor, post.id, desired, requestId)
                : category === 'saves'
                  ? save(f, actor, post.id, desired, requestId)
                  : follow(f, actor, ownerProfile, desired, requestId);
            const firstRequest = randomUUID();
            const firstReceipt = await applied(mutate(true, firstRequest));
            let rows = await sources(f, owner);
            assert.equal(rows.length, 1);
            assert.equal(rows[0]!.automatic_eligible, true);
            assert.equal(rows[0]!.state, 'pending');
            assert.equal(rows[0]!.notice_id, null);
            assert.deepEqual(await f.count(owner, category), unknownCount);
            const pending = await f.list(owner, category);
            assert.deepEqual(pending.items, []);
            assert.equal(
              pending.unreadCount,
              null,
              'A source backlog is not an exact zero',
            );

            await assert.rejects(
              f.pool.query(
                "UPDATE whaleu_notifications.social_work SET state='completed' WHERE source_id=$1",
                [rows[0]!.id],
              ),
              sqlCode('23514'),
              'A pending source cannot claim completion without its receipt',
            );
            // The source fence is deliberately NOWAIT. Prove its exact
            // contention contract before testing concurrent materialization.
            const holder = await f.pool.connect();
            try {
              await holder.query('BEGIN');
              await holder.query(
                'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
                [`social-in-app:${rows[0]!.id}`],
              );
              assert.deepEqual(
                await f.worker.run({ mode: 'apply', sourceIds: [rows[0]!.id] }),
                {
                  mode: 'apply',
                  requested: 1,
                  materialized: 0,
                  existing: 0,
                  alreadyProcessed: 0,
                  missing: 0,
                  retryable: 1,
                },
              );
              assert.equal((await sources(f, owner))[0]!.notice_id, null);
              assert.equal((await sources(f, owner))[0]!.state, 'pending');
              assert.equal(
                (
                  await f.pool.query<{ n: number }>(
                    'SELECT count(*)::integer n FROM whaleu_notifications.social_notices WHERE source_id=$1',
                    [rows[0]!.id],
                  )
                ).rows[0]!.n,
                0,
              );

              assert.equal(
                (
                  await f.pool.query<{ n: number }>(
                    'SELECT count(*)::integer n FROM whaleu_notifications.social_receipts WHERE source_id=$1',
                    [rows[0]!.id],
                  )
                ).rows[0]!.n,
                0,
              );
            } finally {
              try {
                await holder.query('ROLLBACK');
              } finally {
                holder.release();
              }
            }
            const outcomes = await Promise.all([
              f.worker.run({ mode: 'apply', sourceIds: [rows[0]!.id] }),
              f.worker.run({ mode: 'apply', sourceIds: [rows[0]!.id] }),
            ]);
            assert.equal(
              outcomes.reduce((n, result) => n + result.materialized, 0),
              1,
            );
            assert.equal(
              outcomes.reduce(
                (n, result) => n + result.alreadyProcessed + result.retryable,
                0,
              ),
              1,
              'The other worker either sees the receipt or loses the NOWAIT fence',
            );
            assert.equal(
              outcomes.reduce(
                (n, result) => n + result.existing + result.missing,
                0,
              ),
              0,
            );
            // After both transactions have settled, an actual retry must prove
            // the sole receipt rather than tolerating an arbitrary worker error.
            assert.deepEqual(
              await f.worker.run({ mode: 'apply', sourceIds: [rows[0]!.id] }),
              {
                mode: 'apply',
                requested: 1,
                materialized: 0,
                existing: 0,
                alreadyProcessed: 1,
                missing: 0,
                retryable: 0,
              },
            );
            rows = await sources(f, owner);
            assert.equal(rows[0]!.state, 'completed');
            assert.equal(rows[0]!.outcome, 'materialized');
            const page = await f.list(owner, category);
            assert.equal(page.items.length, 1);
            assert.equal(page.unreadCount, 1);
            const notice = page.items[0]!;
            assert.equal(notice.noticeId, rows[0]!.notice_id);
            assert.equal(
              notice.createdAt,
              rows[0]!.occurred_at,
              'Public chronology is the exact immutable event time, not delayed worker time',
            );
            assert.equal(notice.readAt, null);
            if (category === 'followers') {
              assert.equal(notice.status, 'available');
              assert.ok(
                notice.status === 'available' && notice.kind === 'follow',
              );
              assert.deepEqual(notice.target, {
                type: 'profile',
                profileId: actorProfile,
              });
              assert.equal(notice.actor.profileId, actorProfile);
            } else neutral(notice);
            const serialized = JSON.stringify(page);
            for (const privateId of [
              owner.accountId,
              actor.accountId,
              actor.sessionId,
              rows[0]!.id,
              rows[0]!.source_epoch_id,
            ])
              assert.equal(
                serialized.includes(privateId),
                false,
                'Public rows must not expose account, session, source or epoch identity',
              );
            const opened = await f.target(owner, category, notice.noticeId);
            assert.equal(opened.status, 'available');
            assert.deepEqual(
              await f.count(owner, category),
              exactCount(1),
              'Opening is not acknowledgment',
            );
            const wrongCategory: SocialCategory =
              category === 'likes' ? 'saves' : 'likes';
            for (const [reader, scope] of [
              [outsider, category],
              [owner, wrongCategory],
            ] as const) {
              const response = await request(f.http)
                .get(`/v1/me/social-updates/${notice.noticeId}/target`)
                .set('Authorization', socialAuth(reader))
                .query({ category: scope });
              assert.equal(response.status, 404, JSON.stringify(response.body));
              assert.equal(response.body.error.code, 'NOTICE_NOT_FOUND');
              await request(f.http)
                .put(`/v1/me/social-updates/${notice.noticeId}/read`)
                .set('Authorization', socialAuth(reader))
                .query({ category: scope })
                .send({})
                .expect(404);
            }
            const marked = await f.read(owner, category, notice.noticeId);
            assert.match(marked.readAt, /^\d{4}-.*\.\d{6}Z$/);
            assert.equal(marked.unreadCount, 0);
            assert.deepEqual(
              await f.read(owner, category, notice.noticeId),
              marked,
            );
            for (const sql of [
              'UPDATE whaleu_notifications.social_notices SET read_at=NULL WHERE id=$1',
              "UPDATE whaleu_notifications.social_notices SET read_at=read_at+interval '1 microsecond' WHERE id=$1",
              'DELETE FROM whaleu_notifications.social_notices WHERE id=$1',
            ])
              await assert.rejects(
                f.pool.query(sql, [notice.noticeId]),
                sqlCode('23514'),
              );
            assert.deepEqual(
              await applied(mutate(true, firstRequest)),
              firstReceipt,
            );
            await applied(mutate(true));
            assert.equal(
              (await sources(f, owner)).length,
              1,
              'Replay and duplicate true never enroll another source',
            );
            await applied(mutate(false));
            await applied(mutate(false));
            assert.deepEqual(
              await applied(mutate(true, firstRequest)),
              firstReceipt,
            );
            assert.equal(
              (await sources(f, owner)).length,
              1,
              'Old positive receipt must not undo a later cleanup',
            );
            if (category === 'followers') {
              assert.deepEqual(
                await f.target(owner, category, notice.noticeId),
                { noticeId: notice.noticeId, status: 'unavailable' },
              );
              unavailable((await f.list(owner, category)).items[0]!);
            }
            await applied(mutate(true));
            assert.equal((await sources(f, owner)).length, 2);
            assert.deepEqual(await f.count(owner, category), unknownCount);
            await f.dispatcher.cycle();
            rows = await sources(f, owner);
            assert.deepEqual(
              rows.map((row) => row.outcome),
              ['materialized', 'existing'],
            );
            assert.equal(new Set(rows.map((row) => row.notice_id)).size, 1);
            const restored = await f.list(owner, category);
            assert.equal(restored.items.length, 1);
            assert.equal(restored.items[0]!.createdAt, notice.createdAt);
            assert.equal(restored.items[0]!.readAt, marked.readAt);
            assert.equal(restored.items[0]!.noticeId, notice.noticeId);
            assert.equal(restored.unreadCount, 0);
            assert.equal(
              (await f.read(owner, category, notice.noticeId)).readAt,
              marked.readAt,
            );
            if (category === 'saves') {
              const obligations = await f.pool.query<{ status: string }>(
                "SELECT status FROM whaleu_community.saved_obligations WHERE recipient_account_id=$1 AND action='author_interactions'",
                [owner.accountId],
              );
              assert.ok(obligations.rows.length > 0);
              assert.ok(
                obligations.rows.every((row) => row.status === 'pending'),
                'Social settlement must not steal saved-owner obligations',
              );
            }
          },
        );
      }

      await t.test(
        'work-enrollment failure rolls back each real positive source and its command',
        async () => {
          const owner = await f.actor(),
            actor = await f.actor(),
            post = await f.publish(owner);
          const profile = await f.profile(owner);
          await f.pool
            .query(`CREATE FUNCTION whaleu_notifications.social_test_fail_enqueue() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN RAISE EXCEPTION 'synthetic social enqueue failure' USING ERRCODE='P0001'; END $$;
          CREATE TRIGGER social_test_fail_enqueue BEFORE INSERT ON whaleu_notifications.social_work
          FOR EACH ROW EXECUTE FUNCTION whaleu_notifications.social_test_fail_enqueue()`);
          try {
            for (const operation of [
              () => like(f, actor, post.id),
              () => save(f, actor, post.id),
              () => follow(f, actor, profile),
            ]) {
              const response = await operation();
              assert.equal(response.status, 500, JSON.stringify(response.body));
            }
            for (const [table, predicate, id] of [
              ['post_likes', 'post_id', post.id],
              ['saved_posts', 'post_id', post.id],
              ['user_follows', 'followed_id', owner.accountId],
              ['social_sources', 'recipient_account_id', owner.accountId],
              ['post_like_requests', 'account_id', actor.accountId],
              ['saved_requests', 'account_id', actor.accountId],
              ['follow_requests', 'account_id', actor.accountId],
            ])
              assert.equal(
                (
                  await f.pool.query(
                    `SELECT 1 FROM whaleu_community.${table} WHERE ${predicate}=$1`,
                    [id],
                  )
                ).rowCount,
                0,
              );
            assert.equal(
              (
                await f.pool.query(
                  'SELECT 1 FROM whaleu_community.reward_source_groups WHERE actor_account_id=$1',
                  [actor.accountId],
                )
              ).rowCount,
              0,
            );
          } finally {
            await f.pool.query(
              'DROP TRIGGER social_test_fail_enqueue ON whaleu_notifications.social_work; DROP FUNCTION whaleu_notifications.social_test_fail_enqueue()',
            );
          }
          await applied(like(f, actor, post.id));
          await f.dispatcher.cycle();
          assert.equal(
            (await f.list(owner, 'likes')).items.length,
            1,
            'Real dispatch recovers once the failed transaction is gone',
          );
        },
      );

      await t.test(
        'receipt failure rolls back materialization and leaves independently retryable work',
        async () => {
          const owner = await f.actor(),
            actor = await f.actor(),
            post = await f.publish(owner);
          await applied(like(f, actor, post.id));
          const [source] = await sources(f, owner);
          assert.ok(source);
          await f.pool
            .query(`CREATE FUNCTION whaleu_notifications.social_test_fail_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN RAISE EXCEPTION 'synthetic receipt failure' USING ERRCODE='P0001'; END $$;
          CREATE TRIGGER social_test_fail_receipt BEFORE INSERT ON whaleu_notifications.social_receipts
          FOR EACH ROW EXECUTE FUNCTION whaleu_notifications.social_test_fail_receipt()`);
          try {
            const result = await f.worker.run({
              mode: 'apply',
              sourceIds: [source.id],
            });
            assert.equal(result.retryable, 1);
            assert.equal(result.materialized, 0);
            assert.equal(
              (
                await f.pool.query(
                  'SELECT 1 FROM whaleu_notifications.social_notices WHERE source_id=$1',
                  [source.id],
                )
              ).rowCount,
              0,
            );
            assert.equal((await sources(f, owner))[0]!.state, 'pending');
            assert.deepEqual(await f.count(owner, 'likes'), unknownCount);
          } finally {
            await f.pool.query(
              'DROP TRIGGER social_test_fail_receipt ON whaleu_notifications.social_receipts; DROP FUNCTION whaleu_notifications.social_test_fail_receipt()',
            );
          }
          const retry = await f.worker.run({
            mode: 'apply',
            sourceIds: [source.id],
          });
          assert.equal(retry.materialized, 1);
          assert.equal(retry.retryable, 0);
          const settled = (await sources(f, owner))[0]!;
          assert.equal(settled.state, 'completed');
          assert.equal(settled.outcome, 'materialized');
          assert.deepEqual(await f.count(owner, 'likes'), exactCount(1));
        },
      );

      await t.test(
        'committed history cannot be re-enrolled and a fresh follow requires its exact edge receipt',
        async () => {
          const owner = await f.actor(),
            actor = await f.actor(),
            post = await f.publish(owner);
          await applied(like(f, actor, post.id));
          const [source] = await sources(f, owner);
          assert.ok(source?.event_id);
          await assert.rejects(
            f.app
              .get(DatabaseService)
              .transaction((tx) =>
                f.app
                  .get(CommunitySocialSourceCapture)
                  .interaction(source.event_id!, tx),
              ),
            (error: unknown) =>
              error instanceof ApplicationError &&
              error.code === 'COMMUNITY_UNAVAILABLE',
          );
          await assert.rejects(
            f.pool.query(
              `INSERT INTO whaleu_community.social_sources(id,kind,actor_account_id,recipient_account_id,resource_kind,resource_id,post_id,root_comment_id,reply_id,target_reply_id,source_epoch_id,reward_group_id,occurred_at)
           SELECT $1,kind,actor_account_id,recipient_account_id,resource_kind,resource_id,post_id,root_comment_id,reply_id,target_reply_id,source_epoch_id,reward_group_id,occurred_at FROM whaleu_community.social_sources WHERE id=$2`,
              [randomUUID(), source.id],
            ),
            sqlCode('23514'),
          );
          assert.equal((await sources(f, owner)).length, 1);
          const profile = await f.profile(owner),
            original = randomUUID(),
            duplicate = randomUUID();
          const tx = await f.pool.connect();
          try {
            await tx.query('BEGIN');
            await tx.query(
              `INSERT INTO whaleu_community.user_follows(follower_id,followed_id,followed_profile_id,source_request_id) VALUES($1,$2,$3,$4)`,
              [actor.accountId, owner.accountId, profile, original],
            );
            await tx.query(
              `INSERT INTO whaleu_community.follow_requests(account_id,request_id,profile_id,following,outcome)
            VALUES($1,$2,$4,true,'applied'),($1,$3,$4,true,'applied')`,
              [actor.accountId, original, duplicate, profile],
            );
            await assert.rejects(
              tx.query(
                `INSERT INTO whaleu_community.social_sources(id,kind,actor_account_id,recipient_account_id,resource_kind,resource_id,source_epoch_id,occurred_at)
            SELECT $1,'follow',follower_id,followed_id,'profile',followed_profile_id,$2,created_at FROM whaleu_community.user_follows WHERE follower_id=$3 AND followed_id=$4`,
                [randomUUID(), duplicate, actor.accountId, owner.accountId],
              ),
              sqlCode('23514'),
            );
          } finally {
            await tx.query('ROLLBACK');
            tx.release();
          }
          assert.equal((await sources(f, owner)).length, 1);
          await f.dispatcher.cycle();
        },
      );

      await t.test(
        'automatic rollout never adopts a manual-only source, while explicit worker settlement remains available',
        async () => {
          const owner = await f.actor(),
            actor = await f.actor(),
            post = await f.publish(owner);
          const config = f.app.get<{
            COMMUNITY_UPDATES_PROCESSING:
              'disabled' | 'manual_only' | 'automatic';
          }>(APP_CONFIG);
          const originalMode = config.COMMUNITY_UPDATES_PROCESSING;
          try {
            config.COMMUNITY_UPDATES_PROCESSING = 'manual_only';
            await applied(like(f, actor, post.id));
          } finally {
            config.COMMUNITY_UPDATES_PROCESSING = originalMode;
          }
          assert.equal(config.COMMUNITY_UPDATES_PROCESSING, 'automatic');
          const [manual] = await sources(f, owner);
          assert.ok(manual);
          assert.equal(manual.automatic_eligible, false);
          await f.dispatcher.cycle();
          const untouched = (await sources(f, owner))[0]!;
          assert.equal(untouched.id, manual.id);
          assert.equal(untouched.automatic_eligible, false);
          assert.equal(untouched.state, 'pending');
          assert.equal(untouched.notice_id, null);
          const before = await f.list(owner, 'likes');
          assert.deepEqual(before.items, []);
          assert.equal(before.unreadCount, null);
          assert.deepEqual(await f.count(owner, 'likes'), unknownCount);
          const processed = await f.worker.run({
            mode: 'apply',
            sourceIds: [manual.id],
          });
          assert.equal(processed.materialized, 1);
          assert.equal(processed.retryable, 0);
          assert.equal((await sources(f, owner))[0]!.state, 'completed');
          assert.deepEqual(await f.count(owner, 'likes'), exactCount(1));
        },
      );

      await t.test(
        'self-like/save and rejected self-follow never create positive social sources',
        async () => {
          const owner = await f.actor(),
            post = await f.publish(owner),
            profile = await f.profile(owner);
          await applied(like(f, owner, post.id));
          await applied(save(f, owner, post.id));
          const rejected = await follow(f, owner, profile);
          assert.equal(rejected.status, 200);
          assert.equal(rejected.body.code, 'FOLLOW_SELF_NOT_ALLOWED');
          assert.deepEqual(await sources(f, owner), []);
          await f.dispatcher.cycle();
          for (const category of ['likes', 'saves', 'followers'] as const)
            assert.deepEqual(await f.count(owner, category), exactCount(0));
        },
      );

      await t.test(
        'hidden-at-processing records stay generic and full reply ancestry is reprojected every read',
        async () => {
          const owner = await f.actor(),
            actor = await f.actor(),
            ancestorOwner = await f.actor();
          const post = await f.publish(ancestorOwner),
            root = await f.comment(ancestorOwner, post.id);
          const parentReply = await f.reply(ancestorOwner, post.id, root.id);
          const reply = await f.reply(owner, post.id, root.id, parentReply.id);
          await applied(
            request(f.http)
              .put(`/v1/community/replies/${reply.id}/like`)
              .set('Authorization', socialAuth(actor))
              .send({ clientRequestId: randomUUID() }),
          );
          await setReviewState(f.pool, parentReply.approval.decisionId, 'held');
          await f.dispatcher.cycle();
          const hidden = await f.list(owner, 'likes');
          assert.equal(
            hidden.items.length,
            1,
            'Proven source preserves a metadata-only notice while hidden',
          );
          unavailable(hidden.items[0]!);
          assert.equal(hidden.unreadCount, 0);
          const id = hidden.items[0]!.noticeId;
          await setReviewState(
            f.pool,
            parentReply.approval.decisionId,
            'allow',
          );
          assert.deepEqual(await f.target(owner, 'likes', id), {
            noticeId: id,
            status: 'available',
            target: {
              type: 'community',
              postId: post.id,
              commentId: root.id,
              replyId: reply.id,
            },
          });
          for (const ancestor of [post, root, parentReply, reply]) {
            await setReviewState(f.pool, ancestor.approval.decisionId, 'held');
            assert.deepEqual(await f.target(owner, 'likes', id), {
              noticeId: id,
              status: 'unavailable',
            });
            unavailable((await f.list(owner, 'likes')).items[0]!);
            assert.deepEqual(await f.count(owner, 'likes'), exactCount(0));
            await setReviewState(f.pool, ancestor.approval.decisionId, 'allow');
            assert.deepEqual(await f.count(owner, 'likes'), exactCount(1));
          }
          await request(f.http)
            .delete(`/v1/community/replies/${parentReply.id}`)
            .set('Authorization', socialAuth(ancestorOwner))
            .expect(204);
          assert.deepEqual(await f.target(owner, 'likes', id), {
            noticeId: id,
            status: 'unavailable',
          });
          const read = await f.read(owner, 'likes', id);
          assert.equal(read.unreadCount, 0);
          assert.equal(
            (await f.read(owner, 'likes', id)).readAt,
            read.readAt,
            'Unavailable notices remain individually dismissible',
          );
        },
      );

      await t.test(
        'root-comment likes use exact targets, neutral actor fields and fresh hidden cleanup',
        async () => {
          const owner = await f.actor(),
            actor = await f.actor(),
            post = await f.publish(owner);
          const root = await f.comment(owner, post.id);
          await applied(
            request(f.http)
              .put(`/v1/community/comments/${root.id}/like`)
              .set('Authorization', socialAuth(actor))
              .send({ clientRequestId: randomUUID() }),
          );
          await applied(save(f, actor, post.id));
          await f.dispatcher.cycle();
          const notice = (await f.list(owner, 'likes')).items[0]!;
          neutral(notice);
          assert.ok(
            notice.status === 'available' && notice.target.type === 'community',
          );
          assert.deepEqual(notice.target, {
            type: 'community',
            postId: post.id,
            commentId: root.id,
            replyId: null,
          });
          await setReviewState(f.pool, post.approval.decisionId, 'held');
          await applied(save(f, actor, post.id, false, randomUUID(), true));
          assert.equal(
            (await sources(f, owner)).length,
            2,
            'Hidden cleanup has no positive enrollment',
          );
          unavailable((await f.list(owner, 'saves')).items[0]!);
          await setReviewState(f.pool, post.approval.decisionId, 'allow');
          assert.deepEqual(
            await f.count(owner, 'saves'),
            exactCount(1),
            'Historical save notice is independent of current membership',
          );
        },
      );

      await t.test(
        'like/save projections never expose or probe a private actor persona after a block',
        async () => {
          const owner = await f.actor(),
            actor = await f.actor(),
            actorProfile = await f.profile(actor);
          for (const mode of ['named', 'anonymous'] as const) {
            const post = await f.publish(owner, mode);
            await applied(like(f, actor, post.id));
            await applied(save(f, actor, post.id));
          }
          await f.dispatcher.cycle();
          await request(f.http)
            .put('/v1/me/safety/blocks')
            .set('Authorization', socialAuth(owner))
            .send({
              clientRequestId: randomUUID(),
              source: { kind: 'profile', id: actorProfile },
              blocked: true,
            })
            .expect(200);
          for (const category of ['likes', 'saves'] as const) {
            const page = await f.list(owner, category);
            assert.equal(page.items.length, 2);
            for (const notice of page.items) neutral(notice);
            assert.equal(JSON.stringify(page).includes(actorProfile), false);
            assert.equal(JSON.stringify(page).includes(actor.accountId), false);
            assert.deepEqual(await f.count(owner, category), exactCount(2));
          }
        },
      );

      await t.test(
        'follow safety changes hide retained identity and restoration does not revive read state',
        async () => {
          const owner = await f.actor(),
            actor = await f.actor();
          const ownerProfile = await f.profile(owner),
            actorProfile = await f.profile(actor);
          await applied(follow(f, actor, ownerProfile));
          await f.dispatcher.cycle();
          const notice = (await f.list(owner, 'followers')).items[0]!;
          const blocked = await request(f.http)
            .put('/v1/me/safety/blocks')
            .set('Authorization', socialAuth(owner))
            .send({
              clientRequestId: randomUUID(),
              source: { kind: 'profile', id: actorProfile },
              blocked: true,
            })
            .expect(200);
          assert.equal(blocked.body.receipt.outcome, 'applied');
          assert.equal(blocked.body.current.blocked, true);
          unavailable((await f.list(owner, 'followers')).items[0]!);
          assert.deepEqual(
            await f.target(owner, 'followers', notice.noticeId),
            { noticeId: notice.noticeId, status: 'unavailable' },
          );
          assert.deepEqual(await f.count(owner, 'followers'), exactCount(0));
          const marked = await f.read(owner, 'followers', notice.noticeId);
          const unblocked = await request(f.http)
            .put(`/v1/me/safety/blocks/${blocked.body.current.relationshipId}`)
            .set('Authorization', socialAuth(owner))
            .send({
              clientRequestId: randomUUID(),
              blocked: false,
              expectedRevision: blocked.body.current.revision,
            })
            .expect(200);
          assert.equal(unblocked.body.receipt.outcome, 'applied');
          assert.equal(unblocked.body.current.blocked, false);
          const fresh = (await f.list(owner, 'followers')).items[0]!;
          assert.equal(fresh.status, 'available');
          assert.equal(fresh.readAt, marked.readAt);
          assert.deepEqual(await f.count(owner, 'followers'), exactCount(0));
        },
      );

      await t.test(
        'different recipients acknowledge concurrently without global fence upgrade deadlocks',
        async () => {
          const actor = await f.actor(),
            firstOwner = await f.actor(),
            secondOwner = await f.actor();
          const firstPost = await f.publish(firstOwner),
            secondPost = await f.publish(secondOwner);
          await applied(like(f, actor, firstPost.id));
          await applied(like(f, actor, secondPost.id));
          await f.dispatcher.cycle();
          const first = (await f.list(firstOwner, 'likes')).items[0]!;
          const second = (await f.list(secondOwner, 'likes')).items[0]!;
          const acknowledgments = await Promise.all([
            f.read(firstOwner, 'likes', first.noticeId),
            f.read(secondOwner, 'likes', second.noticeId),
          ]);
          assert.equal(acknowledgments[0].noticeId, first.noticeId);
          assert.equal(acknowledgments[1].noticeId, second.noticeId);
          // A contended optional count may be unknown. Neither write may fail,
          // replace its acknowledgment timestamp, or acknowledge another owner.
          assert.equal(
            (await f.read(firstOwner, 'likes', first.noticeId)).readAt,
            acknowledgments[0].readAt,
          );
          assert.equal(
            (await f.read(secondOwner, 'likes', second.noticeId)).readAt,
            acknowledgments[1].readAt,
          );
          assert.deepEqual(await f.count(firstOwner, 'likes'), exactCount(0));
          assert.deepEqual(await f.count(secondOwner, 'likes'), exactCount(0));
        },
      );

      await t.test(
        'database notice insertion serializes owner ordinals through commit',
        async () => {
          const owner = await f.actor(),
            actor = await f.actor();
          const a = await f.publish(owner),
            b = await f.publish(owner);
          await applied(like(f, actor, a.id));
          await applied(like(f, actor, b.id));
          const [one, two] = await sources(f, owner);
          assert.ok(one && two);
          const first = await f.pool.connect(),
            second = await f.pool.connect();
          const records = f.app.get(SocialUpdatesRepository),
            source = f.app.get(CommunitySocialSourceFacade);
          let pending: Promise<unknown> | undefined;
          try {
            await first.query('BEGIN');
            await second.query('BEGIN');
            const pid = (
              await second.query<{ pid: number }>('SELECT pg_backend_pid() pid')
            ).rows[0]!.pid;
            // Deliberately omit application owner(): the SQL guard must own ordering too.
            await records.settle((await source.source(one.id, first))!, first);
            const firstOrdinal = (
              await first.query<{ ordinal: string }>(
                'SELECT ordinal::text FROM whaleu_notifications.social_notices WHERE source_id=$1',
                [one.id],
              )
            ).rows[0]!.ordinal;
            pending = records.settle(
              (await source.source(two.id, second))!,
              second,
            );
            const deadline = Date.now() + 10000;
            while (
              !(
                await f.pool.query<{ blocked: boolean }>(
                  'SELECT cardinality(pg_blocking_pids($1))>0 blocked',
                  [pid],
                )
              ).rows[0]!.blocked
            ) {
              assert.ok(
                Date.now() < deadline,
                'Second source waits for the first owner commit',
              );
              await new Promise((resolve) => setTimeout(resolve, 5));
            }
            assert.equal(
              await f.app
                .get(DatabaseService)
                .transaction((tx) =>
                  records.head(owner.accountId, 'likes', tx),
                ),
              '0',
            );
            await first.query('COMMIT');
            await pending;
            assert.equal(
              await f.app
                .get(DatabaseService)
                .transaction((tx) =>
                  records.head(owner.accountId, 'likes', tx),
                ),
              firstOrdinal,
            );
            const secondOrdinal = (
              await second.query<{ ordinal: string }>(
                'SELECT ordinal::text FROM whaleu_notifications.social_notices WHERE source_id=$1',
                [two.id],
              )
            ).rows[0]!.ordinal;
            assert.ok(BigInt(secondOrdinal) > BigInt(firstOrdinal));
            await second.query('COMMIT');
            assert.equal(
              await f.app
                .get(DatabaseService)
                .transaction((tx) =>
                  records.head(owner.accountId, 'likes', tx),
                ),
              secondOrdinal,
            );
            await assert.rejects(
              f.pool.query(
                `INSERT INTO whaleu_notifications.social_notices(id,source_id,recipient_account_id,kind,dedupe_key,created_at)
            SELECT $1,id,recipient_account_id,kind,repeat('a',64),occurred_at+interval '1 microsecond' FROM whaleu_community.social_sources WHERE id=$2`,
                [randomUUID(), one.id],
              ),
              sqlCode('23514'),
            );
          } finally {
            await first.query('ROLLBACK').catch(() => undefined);
            await pending?.catch(() => undefined);
            await second.query('ROLLBACK').catch(() => undefined);
            first.release();
            second.release();
          }
        },
      );

      await t.test(
        'opaque cursors isolate account/session/category/limit and keep ordinal pagination stable without payload snapshots',
        async () => {
          const owner = await f.actor(),
            actor = await f.actor(),
            outsider = await f.actor();
          const posts = [];
          for (let i = 0; i < 3; i++) {
            const post = await f.publish(owner);
            posts.push(post);
            await applied(like(f, actor, post.id));
          }
          await f.dispatcher.cycle();
          const first = await f.list(owner, 'likes', 1);
          assert.ok(first.nextCursor);
          assert.match(first.nextCursor, /^[A-Za-z0-9_-]+$/);
          for (const secret of [
            owner.accountId,
            owner.sessionId,
            posts[0]!.id,
            'social-updates',
            'before',
          ])
            assert.equal(
              Buffer.from(first.nextCursor, 'base64url')
                .toString('utf8')
                .includes(secret),
              false,
            );
          const provider = (
            await f.pool.query<{ app_id: string; subject: string }>(
              "SELECT app_id,subject FROM whaleu_identity.provider_identities WHERE account_id=$1 AND provider='wechat'",
              [owner.accountId],
            )
          ).rows[0]!;
          const accessToken = mintToken('access'),
            refreshToken = mintToken('refresh');
          const session = await f.app.get(IdentityRepository).createSession(
            {
              provider: 'wechat',
              appId: provider.app_id,
              subject: provider.subject,
            },
            {
              access: hashToken(accessToken),
              refresh: hashToken(refreshToken),
            },
          );
          const secondSession = { ...session, accessToken, refreshToken };
          for (const [reader, category, limit] of [
            [outsider, 'likes', 1],
            [secondSession, 'likes', 1],
            [owner, 'saves', 1],
            [owner, 'likes', 2],
          ] as const) {
            const rejected = await request(f.http)
              .get('/v1/me/social-updates')
              .set('Authorization', socialAuth(reader))
              .query({ category, limit, cursor: first.nextCursor });
            assert.equal(rejected.status, 409, JSON.stringify(rejected.body));
            assert.equal(
              rejected.body.error.code,
              'DISCOVERY_RESTART_REQUIRED',
            );
          }
          await setReviewState(f.pool, posts[1]!.approval.decisionId, 'held');
          const later = await f.publish(owner);
          await applied(like(f, actor, later.id));
          await f.dispatcher.cycle();
          const second = await f.list(owner, 'likes', 1, first.nextCursor);
          assert.equal(second.items.length, 1);
          unavailable(second.items[0]!);
          assert.notEqual(second.items[0]!.noticeId, first.items[0]!.noticeId);
          assert.ok(second.nextCursor);
          const last = await f.list(owner, 'likes', 1, second.nextCursor);
          assert.equal(last.nextCursor, null);
          assert.ok(
            last.items[0]!.status === 'available' &&
              last.items[0]!.target.type === 'community',
          );
          assert.equal(last.items[0]!.target.postId, posts[0]!.id);
          assert.equal(
            (await f.list(owner, 'likes', 1)).items[0]!.status,
            'available',
          );
        },
      );

      await t.test(
        'delayed materialization preserves event chronology and old cursor snapshots advance through empty raw windows',
        async () => {
          const owner = await f.actor(),
            actor = await f.actor();
          const posts = [];
          // Genuine source chronology: Z (oldest), A (pending), B, C (newest).
          for (let i = 0; i < 4; i++) {
            const post = await f.publish(owner);
            posts.push(post);
            await applied(like(f, actor, post.id));
          }
          const rows = await sources(f, owner);
          const byPost = new Map(rows.map((row) => [row.resource_id, row]));
          const [z, a, b, c] = posts.map((post) => byPost.get(post.id)!);
          assert.ok(z && a && b && c);
          const initial = await f.worker.run({
            mode: 'apply',
            sourceIds: [z.id, b.id, c.id],
          });
          assert.equal(initial.materialized, 3);
          assert.equal(initial.retryable, 0);
          const first = await f.list(owner, 'likes', 1);
          const postIds = (page: Awaited<ReturnType<typeof f.list>>) =>
            page.items.map((notice) => {
              assert.ok(
                notice.status === 'available' &&
                  notice.target.type === 'community',
              );
              return notice.target.postId;
            });
          assert.deepEqual(postIds(first), [posts[3]!.id]);
          assert.ok(first.nextCursor);
          const delivered = await f.worker.run({
            mode: 'apply',
            sourceIds: [a.id],
          });
          assert.equal(delivered.materialized, 1);
          assert.equal(delivered.retryable, 0);
          const second = await f.list(owner, 'likes', 1, first.nextCursor);
          assert.deepEqual(postIds(second), [posts[2]!.id]);
          assert.ok(second.nextCursor);
          const skipped = await f.list(owner, 'likes', 1, second.nextCursor);
          assert.deepEqual(
            skipped.items,
            [],
            'Late A is outside the original delivery snapshot',
          );
          assert.ok(
            skipped.nextCursor,
            'The cursor advances over the raw skipped A rather than ending or looping',
          );
          assert.notEqual(skipped.nextCursor, second.nextCursor);
          const last = await f.list(owner, 'likes', 1, skipped.nextCursor);
          assert.deepEqual(postIds(last), [posts[0]!.id]);
          assert.equal(last.nextCursor, null);
          const fresh = await f.list(owner, 'likes');
          assert.deepEqual(postIds(fresh), [
            posts[3]!.id,
            posts[2]!.id,
            posts[1]!.id,
            posts[0]!.id,
          ]);
          for (const notice of fresh.items) {
            assert.ok(
              notice.status === 'available' &&
                notice.target.type === 'community',
            );
            assert.equal(
              notice.createdAt,
              byPost.get(notice.target.postId)!.occurred_at,
            );
          }
        },
      );

      await t.test(
        'exact unread is current-readable, while a bounded overflow is explicitly unknown',
        async () => {
          const owner = await f.actor(),
            actor = await f.actor();
          for (let i = 0; i <= SOCIAL_UNREAD_CANDIDATE_LIMIT; i++) {
            const post = await f.publish(owner);
            await applied(like(f, actor, post.id));
          }
          assert.deepEqual(await f.count(owner, 'likes'), unknownCount);
          await f.dispatcher.cycle();
          assert.equal(
            (await sources(f, owner)).filter((row) => row.state === 'completed')
              .length,
            SOCIAL_UNREAD_CANDIDATE_LIMIT + 1,
          );
          assert.deepEqual(
            await f.count(owner, 'likes'),
            unknownCount,
            'Never label a prefix count as exact',
          );
          const page = await f.list(owner, 'likes');
          assert.equal(page.items.length, 20);
          assert.equal(page.unreadCount, null);
          assert.equal(page.unreadCountStatus, 'unavailable');
          assert.ok(page.nextCursor);
        },
      );

      await t.test(
        'emitted native Page controls load, open, acknowledge and lifecycle-fence real social HTTP',
        async () => {
          const owner = await f.actor(),
            actor = await f.actor(),
            post = await f.publish(owner);
          const ownerProfile = await f.profile(owner);
          await f.profile(actor);
          await applied(like(f, actor, post.id));
          await applied(save(f, actor, post.id));
          await applied(follow(f, actor, ownerProfile));
          await f.dispatcher.cycle();
          await f.app.listen(0, '127.0.0.1');
          const port = (f.http.address() as AddressInfo).port;
          const child = fork(
            fileURLToPath(
              new URL(
                '../support/social-updates-native-worker.mjs',
                import.meta.url,
              ),
            ),
            [],
            {
              stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
              execArgv: ['--import', 'tsx'],
              env: { ...process.env },
            },
          );
          let logs = '';
          child.stdout?.on('data', (value) => {
            logs += String(value);
          });
          child.stderr?.on('data', (value) => {
            logs += String(value);
          });
          try {
            const finished = new Promise<void>((resolve, reject) => {
              child.once('error', reject);
              child.once('exit', (code) =>
                code === 0
                  ? resolve()
                  : reject(
                      new Error(`Native social worker exited ${code}: ${logs}`),
                    ),
              );
              child.on('message', (raw: unknown) => {
                if (
                  raw &&
                  typeof raw === 'object' &&
                  'event' in raw &&
                  raw.event === 'failure'
                )
                  reject(new Error(JSON.stringify(raw)));
              });
            });
            child.send({ port, credentials: owner, postId: post.id });
            await finished;
            for (const category of ['likes', 'saves', 'followers'] as const)
              assert.deepEqual(await f.count(owner, category), exactCount(0));
          } finally {
            if (child.exitCode === null) child.kill();
          }
        },
      );
    });
  },
);
