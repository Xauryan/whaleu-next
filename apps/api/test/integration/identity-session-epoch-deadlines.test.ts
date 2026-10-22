import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { PoolClient } from 'pg';
import { inTransaction } from '../../src/database/database.js';
import { ApplicationError } from '../../src/http/application-error.js';
import { inspectSessionEpochSchema } from '../../src/identity/session-epoch.js';
import {
  commentSource,
  retainComments,
} from '../../src/ratings/courses/comments/proof.js';
import {
  catalogSource,
  retainWindows,
} from '../../src/ratings/windows/proof.js';
import {
  discussionSource as windowSource,
  retainDiscussion as retainWindowDiscussion,
} from '../../src/ratings/windows/discussion/proof.js';
import {
  discussionSource as majorSource,
  retainDiscussion as retainMajorDiscussion,
} from '../../src/majors/discussion/proof.js';
import { courseCommentFixture } from '../support/course-comment-fixture.js';
import { windowDiscussionFixture } from '../support/window-discussion-fixture.js';
import { majorDiscussionFixture } from '../support/major-discussion-fixture.js';
import { staleEpoch } from '../support/epoch-authority-fixture.js';

// Deadline functions are NOT predicates. Verification/catalog/history arms stay
// valid when a session goes stale. Prove both arm exclusion and real retained
// caller denial, rather than treating a remaining non-null deadline as a bypass.
test(
  '0180 deadline arm exclusion and real course/window/major caller authority',
  { timeout: 240000 },
  async (t) => {
    const f = await courseCommentFixture();
    t.after(() => f.close());
    const actor = await f.actor();
    const course = f.add();
    await f.accept([course]);
    await f.acceptComments([course.id]);
    const windows = await windowDiscussionFixture(f);
    const window = windows.add();
    await windows.accept([window]);
    await windows.acceptDiscussion([window.id]);
    const majors = await majorDiscussionFixture(f);
    const major = majors.add();
    await majors.accept([major]);
    await majors.acceptDiscussion([major.id]);
    await inTransaction(f.pool, inspectSessionEpochSchema);
    const currentSession = (
      await f.pool.query<{ until: string }>(
        'SELECT least(access_expires_at,absolute_expires_at)::text until FROM whaleu_identity.sessions WHERE id=$1',
        [actor.sessionId],
      )
    ).rows[0]!.until;
    const args = [actor.accountId, actor.sessionId];
    const cases: {
      name: string;
      sql: string;
      args: string[];
      code: string;
      retain: (tx: PoolClient) => Promise<unknown>;
    }[] = [
      {
        name: 'ratings.course_comment_deadline',
        sql: 'SELECT whaleu_ratings.course_comment_deadline($1,$2,$3,false,clock_timestamp())::text until',
        args: [...args, course.id],
        code: 'COURSE_COMMENT_HISTORY_UNAVAILABLE',
        retain: async (tx) =>
          retainComments(
            actor.accountId,
            actor.sessionId,
            course.id,
            false,
            await commentSource(course.id, tx),
            tx,
          ),
      },
      {
        name: 'ratings.window_deadline',
        sql: 'SELECT whaleu_ratings.window_deadline($1,$2,clock_timestamp())::text until',
        args,
        code: 'WINDOW_HISTORY_UNAVAILABLE',
        retain: async (tx) =>
          retainWindows(
            actor.accountId,
            actor.sessionId,
            await catalogSource(tx),
            tx,
          ),
      },
      {
        name: 'ratings.window_discussion_access_deadline',
        sql: 'SELECT whaleu_ratings.window_discussion_access_deadline($1,$2,clock_timestamp())::text until',
        args,
        code: 'WINDOW_DISCUSSION_HISTORY_UNAVAILABLE',
        retain: async (tx) =>
          retainWindowDiscussion(
            actor.accountId,
            actor.sessionId,
            window.id,
            tx,
            { source: await windowSource(window.id, tx) },
          ),
      },
      {
        name: 'majors.major_discussion_access_deadline',
        sql: 'SELECT whaleu_majors.major_discussion_access_deadline($1,$2,clock_timestamp())::text until',
        args,
        code: 'MAJOR_DISCUSSION_HISTORY_UNAVAILABLE',
        retain: async (tx) =>
          retainMajorDiscussion(
            actor.accountId,
            actor.sessionId,
            major.id,
            tx,
            { source: await majorSource(major.id, tx) },
          ),
      },
    ];
    for (const c of cases)
      await t.test(
        c.name + ': remaining deadline does not authorize stale caller',
        async () => {
          assert.equal(
            (await f.pool.query<{ until: string }>(c.sql, c.args)).rows[0]!
              .until,
            currentSession,
            'Live session is the earliest boundary',
          );
          // Commit the actual production caller proof first with the exact same actor,
          // source, catalog and accepted history. No false predicate on absent facts.
          await inTransaction(f.pool, c.retain);
          let reachedFinalProof = false;
          await assert.rejects(
            inTransaction(f.pool, async (tx) => {
              await staleEpoch(tx, actor.accountId);
              const fallback = (
                await tx.query<{ until: string | null }>(c.sql, [
                  actor.accountId,
                  randomUUID(),
                  ...c.args.slice(2),
                ])
              ).rows[0]!.until;
              const stale = (
                await tx.query<{ until: string | null }>(c.sql, c.args)
              ).rows[0]!.until;
              assert.ok(
                fallback,
                'Independent verification/source deadline remains',
              );
              assert.equal(
                stale,
                fallback,
                'Only stale-session arm is removed',
              );
              assert.ok(Date.parse(stale!) > Date.parse(currentSession));
              await c.retain(tx);
              reachedFinalProof = true;
              // Finalization must reject the real caller despite its valid future deadline.
            }),
            (error) =>
              error instanceof ApplicationError && error.code === c.code,
          );
          assert.equal(reachedFinalProof, true);
          await inTransaction(f.pool, c.retain);
          assert.equal(
            (await f.pool.query<{ until: string }>(c.sql, c.args)).rows[0]!
              .until,
            currentSession,
          );
        },
      );
  },
);
