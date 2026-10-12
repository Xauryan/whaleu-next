import assert from 'node:assert/strict';
import test from 'node:test';
import {
  courseCommentBody,
  courseCommentBytes,
  decodeCourseComment,
  decodeCourseCommentIntent,
  decodeCourseCommentPage,
  decodeCourseCommentReceipt,
  matchCourseCommentReceipt,
} from '../src/course-comments/contract';
import {
  body,
  cancelled,
  comment,
  commentId,
  id,
  like,
  otherId,
  page,
  publish,
  receipt,
} from './course-comments-helpers';
test('comment text preserves exact spaces, CRLF, combining characters and emoji with UTF-8/JS bounds', () => {
  const value = decodeCourseCommentIntent(publish());
  assert.ok(value.operation === 'course.comment.publish.v1');
  assert.equal(value.payload.body, body);
  for (const text of [
    '',
    ' \n\t ',
    'x'.repeat(8001),
    '界'.repeat(2667),
    '😀'.repeat(2001),
    '\ud800',
    'text\u0000',
  ])
    assert.equal(courseCommentBody(text), false);
  for (const text of [
    'x'.repeat(8000),
    '界'.repeat(2666) + 'xx',
    '😀'.repeat(2000),
    body,
  ]) {
    assert.equal(courseCommentBody(text), true);
    assert.equal(courseCommentBytes(text), Buffer.byteLength(text));
  }
});
test('public comment projection rejects author, persona, avatar, viewer and isMine extras', () => {
  assert.deepEqual(Object.keys(decodeCourseComment(comment())).sort(), [
    'body',
    'createdAt',
    'id',
    'likes',
  ]);
  for (const field of [
    'author',
    'actorId',
    'avatar',
    'persona',
    'personaId',
    'isMine',
    'viewer',
    'isLiked',
    'canDelete',
  ])
    assert.throws(() => decodeCourseComment({ ...comment(), [field]: null }));
  for (const likes of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '0', null])
    assert.throws(() => decodeCourseComment({ ...comment(), likes }));
});
test('strict comments page validates bounded unique items, decimal revisions and continuation', () => {
  assert.deepEqual(decodeCourseCommentPage(page()), page());
  for (const patch of [
    { items: [comment(), comment()] },
    { items: Array.from({ length: 51 }, () => comment()) },
    { commentRevision: '0' },
    { commentRevision: 1 },
    { commentRevision: '01' },
    { nextCursor: 'x', continuation: 'end' },
    { nextCursor: null, continuation: 'more' },
    { items: [], nextCursor: 'x', continuation: 'more' },
    { catalogRevision: id.toUpperCase().replace('1', 'Z') },
  ])
    assert.throws(() => decodeCourseCommentPage({ ...page(), ...patch }));
});
test('publish and irreversible like payloads reject mixed fields, author switches and unrelated operations', () => {
  assert.deepEqual(decodeCourseCommentIntent(like()), like());
  const p = publish();
  for (const field of [
    'authorMode',
    'avatar',
    'isMine',
    'liked',
    'images',
    'replyTo',
  ])
    assert.throws(() =>
      decodeCourseCommentIntent({
        ...p,
        payload: { ...p.payload, [field]: false },
      }),
    );
  assert.throws(() =>
    decodeCourseCommentIntent({
      ...like(),
      payload: { ...like().payload, body },
    }),
  );
  assert.throws(() =>
    decodeCourseCommentIntent({ ...p, operation: 'course.first-score.v1' }),
  );
});
test('typed receipts carry no body or author, distinguish operations and match original targets', () => {
  for (const intent of [publish(), like()]) {
    for (const result of [receipt(intent), cancelled(intent)]) {
      assert.deepEqual(decodeCourseCommentReceipt(result), result);
      matchCourseCommentReceipt(intent, result);
      for (const field of ['body', 'author', 'avatar', 'isMine', 'likes'])
        assert.throws(() =>
          decodeCourseCommentReceipt({ ...result, [field]: null }),
        );
      assert.throws(() =>
        matchCourseCommentReceipt({ ...intent, courseId: otherId }, result),
      );
    }
  }
  assert.throws(() => matchCourseCommentReceipt(like(), receipt()));
  assert.throws(() =>
    matchCourseCommentReceipt(
      { ...like(), operation: 'course.comment.like.v1', commentId: otherId },
      receipt(like()),
    ),
  );
  assert.throws(() =>
    decodeCourseCommentReceipt({
      ...cancelled(),
      code: 'COURSE_COMMENT_ALREADY_LIKED',
    }),
  );
  assert.throws(() =>
    decodeCourseCommentReceipt({
      ...cancelled(like()),
      code: 'CONTENT_REJECTED',
    }),
  );
  assert.equal(commentId, comment().id);
});
