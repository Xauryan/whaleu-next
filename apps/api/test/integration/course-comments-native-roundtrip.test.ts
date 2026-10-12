import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import request from 'supertest';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  courseCommentFixture,
  reviewCourseComment,
  revokeCourseCommentReview,
} from '../support/course-comment-fixture.js';
import type { CourseCommentPublish } from '../../src/ratings/courses/comments/contracts.js';
import type { SessionCredentials } from '../../src/identity/contracts.js';
const credentials = (a: SessionCredentials): SessionCredentials => ({
  accountId: a.accountId,
  sessionId: a.sessionId,
  accessToken: a.accessToken,
  refreshToken: a.refreshToken,
  expiresAt: a.expiresAt,
  refreshExpiresAt: a.refreshExpiresAt,
});
test(
  'emitted native course detail → exact comments → lost publish/like responses → source-withdrawn recovery → durable cancellation and lifecycle fences',
  { timeout: 180000 },
  async (t) => {
    const f = await courseCommentFixture();
    t.after(() => f.close());
    const actor = await f.actor(),
      other = await f.actor({ affiliation: 'unverified', identity: false });
    const course = f.add({ name: 'Synthetic Native Comments Course' }),
      unknown = f.add({ name: 'Synthetic Unknown Comment Population' }),
      pagination = f.add({ name: 'Synthetic Native Comment Pagination' });
    const catalog = await f.accept([course, unknown, pagination]);
    await f.acceptComments([course.id, pagination.id]);
    for (let i = 0; i < 21; i++) {
      const command = f.publish(
        catalog,
        pagination,
        `Synthetic pagination comment ${i}`,
      );
      await reviewCourseComment(
        f.pool,
        actor.accountId,
        pagination.id,
        command,
      );
      const result = await request(f.app.getHttpServer())
        .post(`/v1/ratings/courses/${pagination.id}/comments`)
        .set('Authorization', `Bearer ${actor.accessToken}`)
        .send(command);
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(result.body.outcome, 'applied');
    }
    const child = fork(
      fileURLToPath(
        new URL(
          '../support/course-comments-native-worker.mjs',
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
    child.stdout?.on('data', (v) => (logs += String(v)));
    child.stderr?.on('data', (v) => (logs += String(v)));
    t.after(() => {
      if (!child.killed) child.kill();
    });
    const reviews = new Map<string, string>();
    const checkpoints: string[] = [];
    let firstCommentId: string | undefined,
      publishRequestId: string | undefined,
      likeRequestId: string | undefined;
    const finished = new Promise<void>((resolve, reject) => {
      let done = false;
      child.on('message', (raw: unknown) => {
        void (async () => {
          const m = raw as Record<string, unknown>;
          if (m['event'] === 'failure')
            throw Error(String(m['message']) + '\n' + logs);
          if (m['event'] === 'checkpoint') {
            const name = String(m['name']);
            checkpoints.push(name);
            if (name === 'review-publish') {
              const command = m['command'] as CourseCommentPublish;
              const decision = await reviewCourseComment(
                f.pool,
                actor.accountId,
                course.id,
                command,
                m['verdict'] === 'reject' ? 'reject' : 'allow',
              );
              reviews.set(command.clientRequestId, decision);
            } else if (name === 'comment-committed') {
              publishRequestId = String(m['requestId']);
              const rows = (
                await f.pool.query(
                  'SELECT id,actor_id,request_id,body FROM whaleu_ratings.course_comments WHERE course_id=$1',
                  [course.id],
                )
              ).rows;
              assert.equal(rows.length, 1);
              assert.equal(rows[0].actor_id, actor.accountId);
              assert.equal(rows[0].request_id, publishRequestId);
              assert.equal(rows[0].body, m['body']);
              firstCommentId = String(rows[0].id);
              await f.pool.query(
                "UPDATE whaleu_ratings.course_catalog_head SET state='withdrawn'",
              );
            } else if (name === 'comment-recovered') {
              assert.equal(m['requestId'], publishRequestId);
              await f.pool.query(
                "UPDATE whaleu_ratings.course_catalog_head SET state='accepted'",
              );
            } else if (name === 'like-committed') {
              likeRequestId = String(m['requestId']);
              assert.equal(m['commentId'], firstCommentId);
              const rows = (
                await f.pool.query(
                  'SELECT actor_id,request_id FROM whaleu_ratings.course_comment_likes WHERE comment_id=$1',
                  [firstCommentId],
                )
              ).rows;
              assert.deepEqual(rows, [
                { actor_id: actor.accountId, request_id: likeRequestId },
              ]);
              await f.certify(actor.accountId, {
                affiliation: 'unverified',
                phone: 'unverified',
                identity: false,
              });
              await f.pool.query(
                "UPDATE whaleu_ratings.course_catalog_head SET state='withdrawn'",
              );
            } else if (name === 'like-recovered') {
              assert.equal(m['requestId'], likeRequestId);
              await f.certify(actor.accountId);
              await f.pool.query(
                "UPDATE whaleu_ratings.course_catalog_head SET state='accepted'",
              );
            } else if (name === 'revoke-pending-comment') {
              const decision = reviews.get(String(m['requestId']));
              assert.ok(decision);
              await revokeCourseCommentReview(f.pool, decision);
            } else if (name === 'phone-only-like') {
              assert.equal(m['commentId'], firstCommentId);
              assert.equal(
                (
                  await f.pool.query(
                    'SELECT count(*)::int n FROM whaleu_ratings.course_comment_likes WHERE comment_id=$1 AND actor_id=$2',
                    [firstCommentId, other.accountId],
                  )
                ).rows[0].n,
                1,
              );
            } else throw Error('Unknown native comments checkpoint ' + name);
            child.send({ event: 'continue', name });
          } else if (m['event'] === 'done') {
            assert.equal(m['firstCommentId'], firstCommentId);
            assert.equal(m['publishRequestId'], publishRequestId);
            assert.equal(m['likeRequestId'], likeRequestId);
            assert.equal(m['commands'], 8);
            assert.deepEqual(checkpoints, [
              'review-publish',
              'comment-committed',
              'comment-recovered',
              'like-committed',
              'like-recovered',
              'review-publish',
              'review-publish',
              'review-publish',
              'revoke-pending-comment',
              'phone-only-like',
            ]);
            assert.equal(
              (
                await f.pool.query(
                  'SELECT count(*)::int n FROM whaleu_ratings.course_comments WHERE course_id=$1',
                  [course.id],
                )
              ).rows[0].n,
              3,
            );
            assert.equal(
              (
                await f.pool.query(
                  'SELECT count(*)::int n FROM whaleu_ratings.course_comment_likes WHERE comment_id=$1',
                  [firstCommentId],
                )
              ).rows[0].n,
              2,
            );
            assert.equal(
              (
                await f.pool.query(
                  'SELECT count(*)::int n FROM whaleu_ratings.course_comment_commands WHERE actor_id=$1 AND course_id=$2',
                  [actor.accountId, course.id],
                )
              ).rows[0].n,
              7,
            );
            assert.equal(
              (
                await f.pool.query(
                  'SELECT receipt FROM whaleu_ratings.course_comment_commands WHERE actor_id=$1 AND request_id=$2',
                  [actor.accountId, m['cancelledRequestId']],
                )
              ).rows[0].receipt.code,
              'COURSE_COMMENT_CANCELLED',
            );
            assert.equal(
              (
                await f.pool.query(
                  'SELECT count(*)::int n FROM whaleu_ratings.course_scores WHERE course_id=$1',
                  [course.id],
                )
              ).rows[0].n,
              0,
            );
            done = true;
            resolve();
          }
        })().catch(reject);
      });
      child.on('error', reject);
      child.on('exit', (code) => {
        if (!done)
          reject(
            Error(`Native course-comments worker exited ${code}: ${logs}`),
          );
      });
    });
    child.send({
      port: f.port,
      actor: credentials(actor),
      other: credentials(other),
      courseId: course.id,
      unknownId: unknown.id,
      paginationId: pagination.id,
    });
    await finished;
  },
);
