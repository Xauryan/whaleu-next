import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { ratingDeletionFixture } from '../support/rating-deletion-fixture.js';
import { ratingSubscriptionUpdatesFixture } from '../support/rating-subscription-updates-fixture.js';
import { approveRating } from '../support/rating-runtime-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import { RatingDeletionService } from '../../src/ratings/deletion/service.js';
import { RatingDeletionRepository } from '../../src/ratings/deletion/repository.js';
import { RatingDiscussionService } from '../../src/ratings/discussion-service.js';
import { RatingDiscussionRepository } from '../../src/ratings/discussion-repository.js';
import { RatingEffectsCapture } from '../../src/ratings/effects/capture.js';
import { RatingLikesService } from '../../src/ratings/likes/service.js';
import type { AdminDeleteRatingComment } from '../../src/ratings/deletion/contracts.js';

function barrier() {
  let reach!: () => void, release!: () => void;
  const reached = new Promise<void>((resolve) => {
    reach = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { reach, release, reached, held };
}
async function waitForBarrier(reached: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      reached,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error('Expected deletion race barrier within five seconds'),
            ),
          5000,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
function tracked<T>(
  pending: Promise<unknown>[],
  operation: Promise<T>,
): Promise<T> {
  pending.push(operation);
  // The barrier may fail before the operation is awaited. Cleanup still drains it.
  void operation.catch(() => undefined);
  return operation;
}
async function deletionCommand(
  service: RatingDeletionService,
  token: string,
  id: string,
): Promise<AdminDeleteRatingComment> {
  const context = await service.adminContext(token, 'comment', id);
  return {
    clientRequestId: randomUUID(),
    targetId: context.targetId,
    expectedTargetRevision: context.targetRevision,
    expectedRevision: context.revision,
    expectedContextRevision: context.contextRevision,
  };
}
async function rewardCount(pool: Pool) {
  return (
    await pool.query<{ n: number }>(
      'SELECT count(*)::int n FROM whaleu_ratings.reward_groups',
    )
  ).rows[0]!.n;
}
async function noDeletionRewards(
  pool: Pool,
  actor: string,
  key: string,
  rootId: string,
) {
  const events = (
    await pool.query(
      `SELECT e.id,e.source_version,e.rule_version,e.root_id,e.admin_delete_audit_id,
    e.expected_experience_units,e.expected_direct_notice_obligations,
    (SELECT count(*)::int FROM whaleu_ratings.reward_groups g WHERE g.event_id=e.id) rewards,
    (SELECT count(*)::int FROM whaleu_ratings.notice_obligations n WHERE n.event_id=e.id) notices,
    (SELECT count(*)::int FROM whaleu_ratings.subscription_fanout_sources s WHERE s.event_id=e.id) fanout
    FROM whaleu_ratings.effect_events e WHERE e.actor_account_id=$1 AND e.request_id=$2`,
      [actor, key],
    )
  ).rows;
  assert.equal(events.length, 1);
  const event = events[0]!;
  assert.equal(event.source_version, 4);
  assert.equal(event.rule_version, 'rating-admin-delete-v1');
  assert.equal(event.root_id, rootId);
  assert.ok(event.admin_delete_audit_id);
  for (const field of [
    'expected_experience_units',
    'expected_direct_notice_obligations',
    'rewards',
    'notices',
    'fanout',
  ])
    assert.equal(event[field], 0, field);
}
async function absentInteraction(
  pool: Pool,
  key: string,
  transition: 'reply_transitions' | 'like_transitions',
) {
  for (const table of [transition, 'effect_events'])
    assert.equal(
      (
        await pool.query(
          `SELECT count(*)::int n FROM whaleu_ratings.${table} WHERE request_id=$1`,
          [key],
        )
      ).rows[0]!.n,
      0,
    );
}

test(
  'administrator root deletion serializes reply publication, owner cleanup and likes in both orders',
  { timeout: 180000 },
  async (t) => {
    const f = await ratingDeletionFixture();
    t.after(() => f.close());
    const owner = await f.actor(),
      writer = await f.actor(),
      admin = await f.actor();
    await f.grant(admin, 'super_admin');
    const catalog = await f.catalog(owner),
      target = catalog.targets[0]!;
    const deletion = f.app.get(RatingDeletionService);
    const discussion = f.app.get(RatingDiscussionService);
    const metadata = f.app.get(RatingDeletionRepository);
    const replies = f.app.get(RatingDiscussionRepository);
    const effects = f.app.get(RatingEffectsCapture);
    const likes = f.app.get(RatingLikesService);

    await t.test(
      'reply publication commits before waiting administrator deletion; its legitimate reward survives but deletion creates none',
      async () => {
        const root = await f.publish(owner, catalog, target);
        const create = f.replyBody(catalog, target, root);
        await approveRating(
          f.pool,
          f.replyEnvelope(writer, catalog, target, root, create),
        );
        const remove = await deletionCommand(
          deletion,
          admin.accessToken,
          root.id,
        );
        const beforeRewards = await rewardCount(f.pool),
          b = barrier();
        const original = effects.captureCreated.bind(effects);
        const hook = t.mock.method(
          effects,
          'captureCreated',
          async (...args: Parameters<typeof original>) => {
            if (args[1] === create.clientRequestId) {
              b.reach();
              await b.held;
            }
            return original(...args);
          },
        );
        const pending: Promise<unknown>[] = [];
        try {
          const creating = tracked(
            pending,
            discussion.createReply(writer.accessToken, root.id, create),
          );
          await waitForBarrier(b.reached);
          const deleting = tracked(
            pending,
            deletion.deleteComment(admin.accessToken, root.id, remove),
          );
          await f.waitForLock('whaleu_ratings.targets');
          b.release();
          const [created, deleted] = await Promise.all([creating, deleting]);
          assert.equal(created.outcome, 'applied');
          assert.equal(deleted.outcome, 'applied');
          assert.equal(
            (
              await f.pool.query(
                'SELECT deleted_at FROM whaleu_ratings.replies WHERE id=$1',
                [created.replyId],
              )
            ).rows[0]!.deleted_at,
            null,
          );
          await assert.rejects(
            discussion.reply(writer.accessToken, created.replyId, null),
          );
          assert.equal(await rewardCount(f.pool), beforeRewards + 1);
          await noDeletionRewards(
            f.pool,
            admin.accountId,
            remove.clientRequestId,
            root.id,
          );
        } finally {
          b.release();
          hook.mock.restore();
          await Promise.allSettled(pending);
        }
      },
    );

    await t.test(
      'administrator deletion wins target lock before reply publication; the late command cannot create content or rewards',
      async () => {
        const root = await f.publish(owner, catalog, target);
        const create = f.replyBody(catalog, target, root);
        await approveRating(
          f.pool,
          f.replyEnvelope(writer, catalog, target, root, create),
        );
        const remove = await deletionCommand(
          deletion,
          admin.accessToken,
          root.id,
        );
        const beforeRewards = await rewardCount(f.pool),
          b = barrier();
        const original = metadata.root.bind(metadata);
        let armed = true;
        const hook = t.mock.method(
          metadata,
          'root',
          async (...args: Parameters<typeof original>) => {
            const result = await original(...args);
            if (armed && args[0] === root.id) {
              armed = false;
              b.reach();
              await b.held;
            }
            return result;
          },
        );
        const pending: Promise<unknown>[] = [];
        try {
          const deleting = tracked(
            pending,
            deletion.deleteComment(admin.accessToken, root.id, remove),
          );
          await waitForBarrier(b.reached);
          const creating = tracked(
            pending,
            discussion.createReply(writer.accessToken, root.id, create),
          );
          await f.waitForLock('whaleu_ratings.targets');
          b.release();
          const [deleted, created] = await Promise.all([deleting, creating]);
          assert.equal(deleted.outcome, 'applied');
          assert.equal(created.outcome, 'rejected');
          await absentInteraction(
            f.pool,
            create.clientRequestId,
            'reply_transitions',
          );
          assert.equal(await rewardCount(f.pool), beforeRewards);
          await noDeletionRewards(
            f.pool,
            admin.accountId,
            remove.clientRequestId,
            root.id,
          );
        } finally {
          b.release();
          hook.mock.restore();
          await Promise.allSettled(pending);
        }
      },
    );

    await t.test(
      'owner reply deletion commits before administrator root deletion, retaining one transition for each and no rewards',
      async () => {
        const root = await f.publish(owner, catalog, target);
        const reply = await f.publishReply(writer, catalog, target, root);
        const remove = await deletionCommand(
          deletion,
          admin.accessToken,
          root.id,
        );
        const beforeRewards = await rewardCount(f.pool),
          b = barrier();
        const original = replies.delete.bind(replies);
        const hook = t.mock.method(
          replies,
          'delete',
          async (...args: Parameters<typeof original>) => {
            const result = await original(...args);
            if (args[0].id === reply.id) {
              b.reach();
              await b.held;
            }
            return result;
          },
        );
        const pending: Promise<unknown>[] = [];
        try {
          const child = tracked(
            pending,
            f.deleteReply(writer, catalog, target, root, reply),
          );
          await waitForBarrier(b.reached);
          const parent = tracked(
            pending,
            deletion.deleteComment(admin.accessToken, root.id, remove),
          );
          await f.waitForLock('whaleu_ratings.targets');
          b.release();
          const [childReceipt, parentReceipt] = await Promise.all([
            child,
            parent,
          ]);
          assert.equal(childReceipt.outcome, 'applied');
          assert.equal(parentReceipt.outcome, 'applied');
          assert.equal(
            (
              await f.pool.query(
                "SELECT count(*)::int n FROM whaleu_ratings.reply_transitions WHERE reply_id=$1 AND operation='delete_reply'",
                [reply.id],
              )
            ).rows[0]!.n,
            1,
          );
          assert.equal(await rewardCount(f.pool), beforeRewards);
          await noDeletionRewards(
            f.pool,
            admin.accountId,
            remove.clientRequestId,
            root.id,
          );
        } finally {
          b.release();
          hook.mock.restore();
          await Promise.allSettled(pending);
        }
      },
    );

    await t.test(
      'root deletion wins before owner reply cleanup; stale root CAS rejects, explicit fresh context then permits hidden-parent cleanup',
      async () => {
        const root = await f.publish(owner, catalog, target);
        const reply = await f.publishReply(writer, catalog, target, root);
        const remove = await deletionCommand(
          deletion,
          admin.accessToken,
          root.id,
        );
        const beforeRewards = await rewardCount(f.pool),
          b = barrier();
        const original = metadata.root.bind(metadata);
        let armed = true;
        const hook = t.mock.method(
          metadata,
          'root',
          async (...args: Parameters<typeof original>) => {
            const result = await original(...args);
            if (armed && args[0] === root.id) {
              armed = false;
              b.reach();
              await b.held;
            }
            return result;
          },
        );
        const pending: Promise<unknown>[] = [];
        try {
          const parent = tracked(
            pending,
            deletion.deleteComment(admin.accessToken, root.id, remove),
          );
          await waitForBarrier(b.reached);
          const child = tracked(
            pending,
            f.deleteReply(writer, catalog, target, root, reply),
          );
          await f.waitForLock('whaleu_ratings.targets');
          b.release();
          const [parentReceipt, childReceipt] = await Promise.all([
            parent,
            child,
          ]);
          assert.equal(parentReceipt.outcome, 'applied');
          assert.equal(childReceipt.outcome, 'rejected');
          assert.equal(childReceipt.code, 'RATING_REVISION_CONFLICT');
          assert.equal(
            (
              await f.pool.query(
                'SELECT deleted_at FROM whaleu_ratings.replies WHERE id=$1',
                [reply.id],
              )
            ).rows[0]!.deleted_at,
            null,
          );
          const context = await deletion.ownerContext(
            writer.accessToken,
            'reply',
            reply.id,
          );
          const clean = await discussion.deleteReply(
            writer.accessToken,
            reply.id,
            {
              clientRequestId: randomUUID(),
              regionId: context.regionId,
              targetId: context.targetId,
              rootId: context.rootId,
              expectedTargetRevision: context.targetRevision,
              expectedRootRevision: context.rootRevision,
              expectedRevision: context.revision,
            },
          );
          assert.equal(clean.outcome, 'applied');
          assert.equal(await rewardCount(f.pool), beforeRewards);
          await noDeletionRewards(
            f.pool,
            admin.accountId,
            remove.clientRequestId,
            root.id,
          );
        } finally {
          b.release();
          hook.mock.restore();
          await Promise.allSettled(pending);
        }
      },
    );

    for (const likeFirst of [true, false])
      await t.test(
        likeFirst
          ? 'like commits before administrator deletion and remains counted without deletion rewards'
          : 'administrator deletion commits before waiting like; no membership or reward is created',
        async () => {
          const root = await f.publish(owner, catalog, target);
          const state = await likes.state(
            writer.accessToken,
            'comment',
            root.id,
            catalog.regionId,
          );
          assert.ok(state.status === 'known');
          const input = {
            clientRequestId: randomUUID(),
            regionId: catalog.regionId,
            targetId: target.id,
            expectedTargetRevision: target.revision,
            expectedRevision: root.revision,
            expectedLikeRevision: state.revision,
            liked: true,
          };
          const remove = await deletionCommand(
            deletion,
            admin.accessToken,
            root.id,
          );
          const beforeRewards = await rewardCount(f.pool),
            b = barrier();
          const capture = effects.captureLiked.bind(effects),
            rootRead = metadata.root.bind(metadata);
          let armed = true;
          const hook = likeFirst
            ? t.mock.method(
                effects,
                'captureLiked',
                async (...args: Parameters<typeof capture>) => {
                  if (args[1] === input.clientRequestId) {
                    b.reach();
                    await b.held;
                  }
                  return capture(...args);
                },
              )
            : t.mock.method(
                metadata,
                'root',
                async (...args: Parameters<typeof rootRead>) => {
                  const result = await rootRead(...args);
                  if (armed && args[0] === root.id) {
                    armed = false;
                    b.reach();
                    await b.held;
                  }
                  return result;
                },
              );
          const pending: Promise<unknown>[] = [];
          try {
            if (likeFirst) {
              const liking = tracked(
                pending,
                likes.set(writer.accessToken, 'comment', root.id, input),
              );
              await waitForBarrier(b.reached);
              const deleting = tracked(
                pending,
                deletion.deleteComment(admin.accessToken, root.id, remove),
              );
              await f.waitForLock('whaleu_ratings.targets');
              b.release();
              const [liked, deleted] = await Promise.all([liking, deleting]);
              assert.equal(liked.outcome, 'applied');
              assert.equal(deleted.outcome, 'applied');
            } else {
              const deleting = tracked(
                pending,
                deletion.deleteComment(admin.accessToken, root.id, remove),
              );
              await waitForBarrier(b.reached);
              const liking = tracked(
                pending,
                likes.set(writer.accessToken, 'comment', root.id, input),
              );
              await f.waitForLock('whaleu_ratings.targets');
              b.release();
              const [deleted, liked] = await Promise.all([deleting, liking]);
              assert.equal(deleted.outcome, 'applied');
              assert.equal(liked.outcome, 'rejected');
              await absentInteraction(
                f.pool,
                input.clientRequestId,
                'like_transitions',
              );
            }
            assert.equal(
              (
                await f.pool.query(
                  'SELECT count FROM whaleu_ratings.like_states WHERE subject_id=$1',
                  [root.id],
                )
              ).rows[0]!.count,
              likeFirst ? 1 : 0,
            );
            assert.equal(
              await rewardCount(f.pool),
              beforeRewards + (likeFirst ? 1 : 0),
            );
            await assert.rejects(
              likes.state(
                writer.accessToken,
                'comment',
                root.id,
                catalog.regionId,
              ),
            );
            await noDeletionRewards(
              f.pool,
              admin.accountId,
              remove.clientRequestId,
              root.id,
            );
          } finally {
            b.release();
            hook.mock.restore();
            await Promise.allSettled(pending);
          }
        },
      );

    await t.test(
      'raw child-first deletion NOWAIT fails against target/root locks instead of reversing the parent lock order',
      async () => {
        const root = await f.publish(owner, catalog, target);
        const reply = await f.publishReply(writer, catalog, target, root);
        const held = await f.pool.connect(),
          raw = await f.pool.connect();
        try {
          for (const fence of ['target', 'root'] as const) {
            await held.query('BEGIN');
            await held.query(
              fence === 'target'
                ? 'SELECT id FROM whaleu_ratings.targets WHERE id=$1 FOR UPDATE'
                : 'SELECT id FROM whaleu_ratings.comments WHERE id=$1 FOR UPDATE',
              [fence === 'target' ? target.id : root.id],
            );
            const cases =
              fence === 'target'
                ? ([
                    ['comments', root.id, owner.accountId, 'delete_comment'],
                    ['replies', reply.id, writer.accountId, 'delete_reply'],
                  ] as const)
                : ([
                    ['replies', reply.id, writer.accountId, 'delete_reply'],
                  ] as const);
            for (const [table, id, actor, operation] of cases) {
              await raw.query('BEGIN');
              await raw.query("SET LOCAL statement_timeout='1500ms'");
              // Deliberately acquire the child first, before triggering parent fences.
              await raw.query(
                `SELECT id FROM whaleu_ratings.${table} WHERE id=$1 FOR UPDATE`,
                [id],
              );
              const key = randomUUID();
              await raw.query(
                'INSERT INTO whaleu_ratings.requests(account_id,request_id,operation,intent_hash) VALUES($1,$2,$3,$4)',
                [actor, key, operation, 'f'.repeat(64)],
              );
              const started = Date.now();
              await assert.rejects(
                raw.query(
                  `UPDATE whaleu_ratings.${table} SET deleted_at=clock_timestamp(),delete_request_id=$2,revision=gen_random_uuid() WHERE id=$1`,
                  [id, key],
                ),
                (error: unknown) =>
                  !!error &&
                  typeof error === 'object' &&
                  'code' in error &&
                  error.code === '55P03',
              );
              assert.ok(
                Date.now() - started < 1000,
                'NOWAIT must fail before the statement timeout',
              );
              await raw.query('ROLLBACK');
            }
            await held.query('ROLLBACK');
          }
        } finally {
          await Promise.allSettled([
            raw.query('ROLLBACK'),
            held.query('ROLLBACK'),
          ]);
          raw.release();
          held.release();
        }
        assert.equal(
          (
            await f.pool.query(
              'SELECT deleted_at FROM whaleu_ratings.comments WHERE id=$1',
              [root.id],
            )
          ).rows[0]!.deleted_at,
          null,
        );
        assert.equal(
          (
            await f.pool.query(
              'SELECT deleted_at FROM whaleu_ratings.replies WHERE id=$1',
              [reply.id],
            )
          ).rows[0]!.deleted_at,
          null,
        );
      },
    );
  },
);

test(
  'administrator deletion and subscription fanout materialization commit in legal target-lock order without deletion fanout or XP',
  { timeout: 120000 },
  async (t) => {
    const f = await ratingSubscriptionUpdatesFixture();
    t.after(() => f.close());
    const author = await f.actor(),
      recipient = await f.actor(),
      admin = await f.actor();
    await withCommunityScopeWriter(f.pool, (tx) =>
      tx.query(
        "INSERT INTO whaleu_authorization.role_grants(id,account_id,role,approved_by_account_id,approval_reference) VALUES($1,$2,'super_admin',$2,'synthetic-deletion-fanout-race')",
        [randomUUID(), admin.accountId],
      ),
    );
    const catalog = await f.catalog(author),
      target = catalog.targets[0]!;
    await f.subscribe(recipient, catalog, target);
    const deletion = f.app.get(RatingDeletionService),
      metadata = f.app.get(RatingDeletionRepository);
    for (const materializeFirst of [true, false])
      await t.test(
        materializeFirst
          ? 'materialization holds target SHARE, commits one notice, then administrator deletion makes its preview unavailable'
          : 'administrator deletion holds target UPDATE first, so pending publication fanout suppresses the hidden root',
        async () => {
          const root = await f.publish(author, catalog, target),
            event = await f.event(author, root.input.clientRequestId);
          const remove = await deletionCommand(
            deletion,
            admin.accessToken,
            root.id,
          );
          const beforeRewards = await rewardCount(f.pool),
            b = barrier();
          const owner = f.records.owner.bind(f.records),
            rootRead = metadata.root.bind(metadata);
          let armed = true;
          const hook = materializeFirst
            ? t.mock.method(
                f.records,
                'owner',
                async (...args: Parameters<typeof owner>) => {
                  if (armed && args[0] === recipient.accountId && args[2]) {
                    armed = false;
                    b.reach();
                    await b.held;
                  }
                  return owner(...args);
                },
              )
            : t.mock.method(
                metadata,
                'root',
                async (...args: Parameters<typeof rootRead>) => {
                  const result = await rootRead(...args);
                  if (armed && args[0] === root.id) {
                    armed = false;
                    b.reach();
                    await b.held;
                  }
                  return result;
                },
              );
          const pending: Promise<unknown>[] = [];
          try {
            if (materializeFirst) {
              const processing = tracked(
                pending,
                f.worker().run({ mode: 'apply', eventIds: [event] }),
              );
              await waitForBarrier(b.reached);
              const deleting = tracked(
                pending,
                deletion.deleteComment(admin.accessToken, root.id, remove),
              );
              await f.waitForLock('whaleu_ratings.targets');
              b.release();
              const [processed, deleted] = await Promise.all([
                processing,
                deleting,
              ]);
              assert.equal(processed.failed, 0);
              assert.equal(processed.processed, 1);
              assert.equal(processed.materialized, 1);
              assert.equal(processed.suppressed, 0);
              assert.equal(deleted.outcome, 'applied');
              const notices = await f.notices(event);
              assert.equal(notices.length, 1);
              const updates = await f.get(recipient);
              assert.equal(updates.status, 200);
              const hidden = updates.body.items.find(
                (item: { noticeId: string }) =>
                  item.noticeId === notices[0]!.id,
              );
              assert.equal(hidden?.status, 'unavailable');
              assert.deepEqual(Object.keys(hidden).sort(), [
                'createdAt',
                'noticeId',
                'readAt',
                'status',
              ]);
            } else {
              const deleting = tracked(
                pending,
                deletion.deleteComment(admin.accessToken, root.id, remove),
              );
              await waitForBarrier(b.reached);
              const processing = tracked(
                pending,
                f.worker().run({ mode: 'apply', eventIds: [event] }),
              );
              await f.waitForLock('whaleu_ratings.targets');
              b.release();
              const [deleted, processed] = await Promise.all([
                deleting,
                processing,
              ]);
              assert.equal(deleted.outcome, 'applied');
              assert.equal(processed.failed, 0);
              assert.equal(processed.processed, 1);
              assert.equal(processed.materialized, 0);
              assert.equal(processed.suppressed, 1);
              assert.deepEqual(await f.notices(event), []);
              assert.deepEqual(
                (await f.processing(event)).map((row) => row.code),
                ['target_inaccessible'],
              );
            }
            assert.equal(await rewardCount(f.pool), beforeRewards);
            await noDeletionRewards(
              f.pool,
              admin.accountId,
              remove.clientRequestId,
              root.id,
            );
          } finally {
            b.release();
            hook.mock.restore();
            await Promise.allSettled(pending);
          }
        },
      );
  },
);
