/** Raw SQL adversaries use only exact genuine disposable publication evidence. */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool, type PoolClient } from 'pg';
import { APP_CONFIG } from '../../src/config/config.js';
import {
  DatabaseService,
  inTransaction,
  poolOptions,
} from '../../src/database/database.js';
import { hashToken } from '../../src/identity/tokens.js';
import { adminDiscussionRemovalIntentHash } from '../../src/community/admin-discussion-removal/evidence.js';
import type { AdminDiscussionRemovalCommand } from '../../src/community/admin-discussion-removal/contracts.js';
import { adminDiscussionRemovalFixture } from '../support/admin-discussion-removal-fixture.js';

const causal = (error: unknown) =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  ['23514', '23503', '23505', '23502', '22P02', '55P03'].includes(
    String(error.code),
  );
test(
  'strict discussion SQL commands require exact transition/component/cleanup/outbox and retain original minimal recovery',
  { timeout: 240000 },
  async (t) => {
    const f = await adminDiscussionRemovalFixture();
    t.after(() => f.close());
    const admin = await f.actor(),
      author = await f.actor(),
      other = await f.actor();
    const grant = await f.grant(admin),
      wrongGrant = await f.grant(other);
    const transaction = async <T>(
      work: (tx: PoolClient) => Promise<T>,
    ): Promise<T> => {
      const tx = await f.pool.connect();
      try {
        await tx.query(
          "BEGIN ISOLATION LEVEL READ COMMITTED;SET LOCAL lock_timeout='500ms';SET LOCAL statement_timeout='8s'",
        );
        const value = await work(tx);
        await tx.query('COMMIT');
        return value;
      } catch (error) {
        await tx.query('ROLLBACK');
        throw error;
      } finally {
        tx.release();
      }
    };
    for (const kind of ['comment', 'reply'] as const) {
      const post = await f.publish(author, { authorMode: 'anonymous' }),
        root = await f.discussion(author, post.id, { authorMode: 'anonymous' }),
        reply = await f.discussion(author, post.id, {
          rootId: root.id,
          authorMode: 'anonymous',
        }),
        otherRoot = await f.discussion(other, post.id);
      const target = kind === 'comment' ? root : reply,
        table = kind === 'comment' ? 'root_comments' : 'replies';
      const body = async (): Promise<AdminDiscussionRemovalCommand> =>
        f.removalCommand(
          target,
          (await f.removalManagement(target, admin)).targetVersion,
        );
      const receipt = (command: AdminDiscussionRemovalCommand) => ({
        requestId: command.clientRequestId,
        target: command.target,
        expectedTargetVersion: command.expectedTargetVersion,
        action: command.action,
        outcome: 'applied',
        eventId: randomUUID(),
        recordedAt: new Date().toISOString(),
      });
      const insert = (
        tx: Pick<PoolClient, 'query'>,
        command: AdminDiscussionRemovalCommand,
        result: object,
        selected: string | null = grant,
      ) =>
        tx.query(
          `INSERT INTO whaleu_community.admin_discussion_removal_commands(actor_id,request_id,session_id,token_hash,target_kind,target_id,grant_id,intent_hash,command,receipt) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            admin.accountId,
            command.clientRequestId,
            admin.sessionId,
            hashToken(admin.accessToken),
            command.target.kind,
            command.target.id,
            selected,
            adminDiscussionRemovalIntentHash(admin.accountId, command),
            command,
            result,
          ],
        );
      const change = async (tx: PoolClient, r: ReturnType<typeof receipt>) => {
        if (kind === 'comment')
          await tx.query(
            'DELETE FROM whaleu_community.comment_pins WHERE post_id=$1 AND comment_id=$2',
            [post.id, target.id],
          );
        await tx.query(
          `UPDATE whaleu_community.${table} SET deleted_at=$2 WHERE id=$1`,
          [target.id, r.recordedAt],
        );
      };
      const effects = async (
        tx: PoolClient,
        command: AdminDiscussionRemovalCommand,
        r: ReturnType<typeof receipt>,
        patch: object = {},
      ) => {
        await tx.query(
          `INSERT INTO whaleu_community.admin_discussion_removal_events(id,actor_id,request_id,subject_id,target_kind,target_id,post_id,root_id,original_region_id,grant_id,recorded_at) SELECT $3,actor_id,request_id,subject_id,target_kind,target_id,post_id,root_id,original_region_id,grant_id,$4 FROM whaleu_community.admin_discussion_removal_commands WHERE actor_id=$1 AND request_id=$2`,
          [admin.accountId, command.clientRequestId, r.eventId, r.recordedAt],
        );
        await tx.query(
          `INSERT INTO whaleu_community.outbox(event_key,event_type,resource_id,context) VALUES($1,'admin_discussion_removed',$2,$3)`,
          [
            `admin-discussion-removal:${r.eventId}`,
            target.id,
            {
              cause: 'admin_discussion_removal',
              eventId: r.eventId,
              kind,
              postId: post.id,
              rootCommentId: root.id,
              obligations: ['content_invalidation', 'media_cleanup'],
              ...patch,
            },
          ],
        );
      };
      const reject = async (
        work: (
          tx: PoolClient,
          c: AdminDiscussionRemovalCommand,
          r: ReturnType<typeof receipt>,
        ) => Promise<unknown>,
      ) => {
        const c = await body(),
          r = receipt(c);
        await assert.rejects(
          transaction((tx) => work(tx, c, r)),
          causal,
        );
        assert.equal(
          (
            await f.pool.query(
              `SELECT deleted_at FROM whaleu_community.${table} WHERE id=$1`,
              [target.id],
            )
          ).rows[0]!.deleted_at,
          null,
        );
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_community.admin_discussion_removal_commands WHERE actor_id=$1 AND request_id=$2',
              [admin.accountId, c.clientRequestId],
            )
          ).rowCount,
          0,
        );
      };
      await t.test(
        `${kind}: incomplete command and zero-row or same-value statement are never tombstones`,
        async () => {
          for (const sql of [
            null,
            `UPDATE whaleu_community.${table} SET deleted_at=deleted_at WHERE false`,
            `UPDATE whaleu_community.${table} SET deleted_at=deleted_at WHERE id='${target.id}'`,
          ])
            await reject(async (tx, c, r) => {
              await insert(tx, c, r);
              if (sql) await tx.query(sql);
            });
        },
      );
      await t.test(
        `${kind}: standalone fabricated event or component is rejected`,
        async () => {
          await reject((tx, c, r) => effects(tx, c, r));
          await reject(async (tx) => {
            await tx.query(
              `INSERT INTO whaleu_post_hotness.comment_sources(post_id,actor_id,kind,content_id,root_id,transition,delta,source_sequence,positive_source_id) SELECT post_id,actor_id,kind,content_id,root_id,'deleted',-1,nextval('whaleu_post_hotness.comment_source_sequence'),id FROM whaleu_post_hotness.comment_sources WHERE content_id=$1 AND transition='created'`,
              [target.id],
            );
          });
        },
      );
      await t.test(
        `${kind}: wrong grant, receipt kind, action, private author and additional fields fail closed`,
        async () => {
          await reject((tx, c, r) => insert(tx, c, r, wrongGrant));
          for (const patch of [
            {
              target: {
                kind: kind === 'comment' ? 'reply' : 'comment',
                id: target.id,
              },
            },
            { action: 'remove_post' },
            { subjectId: author.accountId },
            { extra: true },
            { eventId: otherRoot.id },
          ])
            await reject(async (tx, c, r) => {
              await insert(tx, c, { ...r, ...patch });
              if ('eventId' in patch) {
                await change(tx, r);
                await effects(tx, c, r);
              }
            });
        },
      );
      await t.test(
        `${kind}: missing or counterfeit closure, wrong kind/root and extra mutation cannot commit`,
        async () => {
          await reject(async (tx, c, r) => {
            await insert(tx, c, r);
            await change(tx, r);
          });
          for (const patch of [
            { kind: 'post' },
            { rootCommentId: otherRoot.id },
            { postId: otherRoot.id },
            { cause: 'discussion_report_threshold' },
            { obligations: ['own_delete_deduction'] },
          ])
            await reject(async (tx, c, r) => {
              await insert(tx, c, r);
              await change(tx, r);
              await effects(tx, c, r, patch);
            });
          await reject(async (tx, c, r) => {
            await insert(tx, c, r);
            await change(tx, r);
            await tx.query(
              'UPDATE whaleu_community.root_comments SET deleted_at=$2 WHERE id=$1',
              [otherRoot.id, r.recordedAt],
            );
            await effects(tx, c, r);
          });
          await reject(async (tx, c, r) => {
            await insert(tx, c, r);
            await change(tx, r);
            await tx.query(
              `UPDATE whaleu_community.${table} SET deleted_at=NULL WHERE id=$1`,
              [target.id],
            );
            await tx.query(
              `UPDATE whaleu_community.${table} SET deleted_at=$2 WHERE id=$1`,
              [target.id, r.recordedAt],
            );
            await effects(tx, c, r);
          });
        },
      );
      await t.test(
        `${kind}: cold cancellation and recovery never open exclusive source/policy relations`,
        async () => {
          const command = await body(),
            cancelled = {
              requestId: command.clientRequestId,
              target: command.target,
              expectedTargetVersion: command.expectedTargetVersion,
              action: command.action,
              outcome: 'rejected',
              code: 'ADMIN_DISCUSSION_REMOVAL_CANCELLED',
            };
          const writer = await f.pool.connect();
          await writer.query('BEGIN');
          await writer.query(
            'LOCK TABLE whaleu_community.posts,whaleu_community.root_comments,whaleu_community.replies,whaleu_community.content_approval_bindings,whaleu_community.content_approval_policies,whaleu_authorization.role_grants,whaleu_verification.account_heads,whaleu_media.bindings,whaleu_post_hotness.comment_baselines,whaleu_post_hotness.comment_sources IN ACCESS EXCLUSIVE MODE',
          );
          const config = f.moderationApp.get(APP_CONFIG),
            fresh = new Pool({ ...poolOptions(config), max: 1 });
          try {
            const tx = await fresh.connect();
            try {
              await tx.query(
                "BEGIN;SET LOCAL lock_timeout='100ms';SET LOCAL statement_timeout='2s'",
              );
              await insert(tx, command, cancelled, null);
              await tx.query('COMMIT');
            } finally {
              tx.release();
            }
            const database = f.moderationApp.get(DatabaseService),
              original = database.transaction;
            database.transaction = async (work, options) => {
              const cold = new Pool({ ...poolOptions(config), max: 1 });
              try {
                return await inTransaction(cold, work, options);
              } finally {
                await cold.end();
              }
            };
            try {
              const recovered = await f.removalRecovery(
                admin,
                command.clientRequestId,
              );
              assert.equal(
                recovered.status,
                200,
                JSON.stringify(recovered.body),
              );
              assert.deepEqual(recovered.body, {
                state: 'recorded',
                receipt: cancelled,
              });
              const replay = await f.removalSend(admin, command);
              assert.equal(replay.status, 200);
              assert.deepEqual(replay.body, cancelled);
            } finally {
              database.transaction = original;
            }
          } finally {
            await fresh.end();
            await writer.query('ROLLBACK');
            writer.release();
          }
        },
      );
    }
  },
);
