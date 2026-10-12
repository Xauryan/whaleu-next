/** Synthetic provenance only. No runtime issuer, seed, import or provider. */
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { inTransaction } from '../../src/database/database.js';
import { courseRatingFixture } from './course-rating-fixture.js';
import type { CourseCommentPublish } from '../../src/ratings/courses/comments/contracts.js';
import { courseCommentReviewDigest } from '../../src/community/content-review/course-comment-review.facade.js';
export async function commentHistory(
  pool: Pool,
  courseId: string,
  kind: 'population' | 'likes',
  coverage: 'accepted_empty' | 'unknown' = 'accepted_empty',
  until = new Date(Date.now() + 3600000),
) {
  return inTransaction(pool, async (tx) => {
    const id = randomUUID();
    await tx.query(
      "INSERT INTO whaleu_ratings.course_comment_history_assertions(id,course_id,kind,coverage,source_reference,policy_reference,valid_until) VALUES($1,$2,$3,$4,'synthetic:independent-classcomment-reconciliation','synthetic:accepted-empty-only',$5)",
      [id, courseId, kind, coverage, until],
    );
    await tx.query(
      'INSERT INTO whaleu_ratings.course_comment_history_heads(course_id,kind,assertion_id) VALUES($1,$2,$3) ON CONFLICT(course_id,kind) DO UPDATE SET assertion_id=EXCLUDED.assertion_id',
      [courseId, kind, id],
    );
    return id;
  });
}
export async function reviewCourseComment(
  pool: Pool,
  actorId: string,
  courseId: string,
  command: CourseCommentPublish,
  verdict: 'allow' | 'reject' = 'allow',
  options: {
    consumeUntil?: Date;
    visibilityUntil?: Date;
    issuedAt?: Date;
  } = {},
) {
  return inTransaction(pool, async (tx) => {
    const id = randomUUID(),
      policy = randomUUID(),
      envelope = {
        version: 1 as const,
        purpose: 'course.comment.publish.v1' as const,
        actorId,
        requestId: command.clientRequestId,
        courseId,
        catalogRevision: command.expectedCatalogRevision,
        courseRevision: command.expectedCourseRevision,
        body: command.body,
      };
    await tx.query(
      "INSERT INTO whaleu_community.course_comment_review_policies(id,issuer,source_reference,coverage,valid_from,valid_until) VALUES($1,'synthetic:local-classcomment-review','synthetic:no-live-provider','complete',clock_timestamp()-interval '1 hour',clock_timestamp()+interval '2 hours')",
      [policy],
    );
    await tx.query(
      'INSERT INTO whaleu_community.course_comment_review_decisions(id,actor_id,request_id,course_id,catalog_id,course_revision,body,policy_id,verdict,digest,issued_at,consume_until,visibility_until) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,coalesce($11::timestamptz,clock_timestamp()),$12,$13)',
      [
        id,
        actorId,
        command.clientRequestId,
        courseId,
        command.expectedCatalogRevision,
        command.expectedCourseRevision,
        command.body,
        policy,
        verdict,
        courseCommentReviewDigest(envelope),
        options.issuedAt ?? null,
        options.consumeUntil ?? new Date(Date.now() + 3600000),
        options.visibilityUntil ?? new Date(Date.now() + 3600000),
      ],
    );
    await tx.query(
      "INSERT INTO whaleu_community.course_comment_review_heads(actor_id,request_id,decision_id,state) VALUES($1,$2,$3,'active') ON CONFLICT(actor_id,request_id) DO UPDATE SET decision_id=EXCLUDED.decision_id,state='active'",
      [actorId, command.clientRequestId, id],
    );
    return id;
  });
}
export async function revokeCourseCommentReview(
  pool: Pool,
  decisionId: string,
) {
  await pool.query(
    "UPDATE whaleu_community.course_comment_review_heads SET state='revoked' WHERE decision_id=$1",
    [decisionId],
  );
}
export async function courseCommentFixture() {
  const f = await courseRatingFixture();
  const acceptComments = async (courseIds: string[]) => {
    for (const id of courseIds) {
      await commentHistory(f.pool, id, 'population');
      await commentHistory(f.pool, id, 'likes');
    }
  };
  const publish = (
    catalog: string,
    course: { revision: string },
    body = 'Synthetic exact comment',
  ) => ({
    clientRequestId: randomUUID(),
    expectedCatalogRevision: catalog,
    expectedCourseRevision: course.revision,
    body,
  });
  const like = (catalog: string, course: { revision: string }) => ({
    clientRequestId: randomUUID(),
    expectedCatalogRevision: catalog,
    expectedCourseRevision: course.revision,
  });
  return { ...f, acceptComments, publish, like };
}
