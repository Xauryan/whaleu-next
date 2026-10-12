import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  courseCommentBodySchema,
  courseCommentSchema,
  courseCommentPublishSchema,
  courseCommentLikeSchema,
  courseCommentReceiptSchema,
  courseCommentQuerySchema,
  courseCommentCancelSchema,
} from '../src/ratings/courses/comments/contracts.js';
import { courseCommentIntentHash } from '../src/ratings/courses/comments/service.js';
import { courseCommentReviewDigest } from '../src/community/content-review/course-comment-review.facade.js';
const command = {
  clientRequestId: randomUUID(),
  expectedCatalogRevision: randomUUID(),
  expectedCourseRevision: randomUUID(),
  body: '  精确原文\n0  ',
};
test('course comment body preserves exact accepted bytes and has explicit UTF-8/HTTP bounded policy', () => {
  assert.deepEqual(courseCommentPublishSchema.parse(command), command);
  for (const body of [
    '',
    '   ',
    '\u00a0',
    '\ufeff',
    '\u00a0\u2000\ufeff',
    '\u0000',
    '\ud800',
    '界'.repeat(2667),
    'x'.repeat(8001),
    false,
    1,
    null,
  ])
    assert.equal(courseCommentBodySchema.safeParse(body).success, false);
  assert.equal(
    courseCommentBodySchema.safeParse('界'.repeat(2666)).success,
    true,
  );
  assert.equal(courseCommentBodySchema.safeParse('0').success, true);
});
test('strict course public projection has no identity, persona, author mode or own-like leakage', () => {
  const comment = {
    id: randomUUID(),
    body: 'exact',
    likes: 0,
    createdAt: new Date().toISOString(),
  };
  for (const key of [
    'actorId',
    'author',
    'avatar',
    'persona',
    'profile',
    'anonymous',
    'isMine',
    'isLiked',
  ])
    assert.equal(
      courseCommentSchema.safeParse({ ...comment, [key]: null }).success,
      false,
    );
  assert.equal(courseCommentSchema.safeParse(comment).success, true);
  for (const field of [
    'actorId',
    'user_id',
    'openid',
    'authorMode',
    'images',
    'score',
  ])
    assert.equal(
      courseCommentPublishSchema.safeParse({ ...command, [field]: 'untrusted' })
        .success,
      false,
    );
  assert.equal(courseCommentLikeSchema.safeParse(command).success, false);
});
test('distinct typed course comment intents bind account, key, operation, course, exact body and source revisions', () => {
  const actor = randomUUID(),
    course = randomUUID(),
    hash = courseCommentIntentHash(
      actor,
      course,
      null,
      'course.comment.publish.v1',
      command,
    );
  for (const patch of [
    { body: command.body.trim() },
    { clientRequestId: randomUUID() },
    { expectedCatalogRevision: randomUUID() },
    { expectedCourseRevision: randomUUID() },
  ])
    assert.notEqual(
      courseCommentIntentHash(
        actor,
        course,
        null,
        'course.comment.publish.v1',
        { ...command, ...patch },
      ),
      hash,
    );
  assert.notEqual(
    courseCommentIntentHash(
      randomUUID(),
      course,
      null,
      'course.comment.publish.v1',
      command,
    ),
    hash,
  );
  assert.notEqual(
    courseCommentIntentHash(
      actor,
      randomUUID(),
      null,
      'course.comment.publish.v1',
      command,
    ),
    hash,
  );
});
test('Review digest binds distinct course purpose without generic target, author persona or score', () => {
  const envelope = {
    version: 1 as const,
    purpose: 'course.comment.publish.v1' as const,
    actorId: randomUUID(),
    requestId: command.clientRequestId,
    courseId: randomUUID(),
    catalogRevision: command.expectedCatalogRevision,
    courseRevision: command.expectedCourseRevision,
    body: command.body,
  };
  const hash = courseCommentReviewDigest(envelope);
  for (const field of [
    'actorId',
    'requestId',
    'courseId',
    'catalogRevision',
    'courseRevision',
  ] as const)
    assert.notEqual(
      courseCommentReviewDigest({ ...envelope, [field]: randomUUID() }),
      hash,
    );
  assert.notEqual(
    courseCommentReviewDigest({ ...envelope, body: command.body.trim() }),
    hash,
  );
});
test('comment commands/cancellation never become generic scores, toggles or untyped receipts', () => {
  assert.equal(
    courseCommentQuerySchema.safeParse({ sort: 'rating' }).success,
    false,
  );
  assert.equal(
    courseCommentQuerySchema.safeParse({ limit: '51' }).success,
    false,
  );
  assert.equal(
    courseCommentCancelSchema.safeParse({
      operation: 'course.comment.publish.v1',
      courseId: randomUUID(),
      command,
    }).success,
    true,
  );
  assert.equal(
    courseCommentReceiptSchema.safeParse({
      requestId: command.clientRequestId,
      courseId: randomUUID(),
      operation: 'course.comment.publish.v1',
      outcome: 'rejected',
      code: 'COURSE_COMMENT_CANCELLED',
    }).success,
    true,
  );
  assert.equal(
    courseCommentReceiptSchema.safeParse({
      requestId: command.clientRequestId,
      courseId: randomUUID(),
      operation: 'course.first-score.v1',
      outcome: 'applied',
      body: 'x',
    }).success,
    false,
  );
});
