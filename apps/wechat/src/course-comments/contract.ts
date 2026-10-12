import { isRecord } from '../api/errors';
import { exact, timestamp } from '../community/contract';
import {
  courseCursor,
  courseId,
  invalidCourse,
} from '../course-ratings/contract';

export type CourseCommentSort = 'likes' | 'time';
/** Public projection intentionally has no author identity or viewer relationship. */
export interface CourseComment {
  readonly id: string;
  readonly body: string;
  readonly likes: number;
  readonly createdAt: string;
}
export interface CourseCommentPage {
  readonly courseId: string;
  readonly catalogRevision: string;
  readonly courseRevision: string;
  readonly commentRevision: string;
  readonly items: readonly CourseComment[];
  readonly nextCursor: string | null;
  readonly continuation: 'more' | 'end';
}
export interface CourseCommentLike {
  readonly clientRequestId: string;
  readonly expectedCatalogRevision: string;
  readonly expectedCourseRevision: string;
}
export interface CourseCommentPublish extends CourseCommentLike {
  readonly body: string;
}
export type CourseCommentIntent =
  | {
      readonly operation: 'course.comment.publish.v1';
      readonly courseId: string;
      readonly payload: CourseCommentPublish;
    }
  | {
      readonly operation: 'course.comment.like.v1';
      readonly courseId: string;
      readonly commentId: string;
      readonly payload: CourseCommentLike;
    };
export type CourseCommentReceipt =
  | {
      readonly requestId: string;
      readonly operation: 'course.comment.publish.v1';
      readonly courseId: string;
      readonly outcome: 'applied';
      readonly commentId: string;
      readonly createdAt: string;
    }
  | {
      readonly requestId: string;
      readonly operation: 'course.comment.publish.v1';
      readonly courseId: string;
      readonly outcome: 'rejected';
      readonly code:
        | 'COURSE_REVISION_CONFLICT'
        | 'CONTENT_REJECTED'
        | 'COURSE_COMMENT_CANCELLED';
    }
  | {
      readonly requestId: string;
      readonly operation: 'course.comment.like.v1';
      readonly courseId: string;
      readonly commentId: string;
      readonly outcome: 'applied';
      readonly recordedAt: string;
    }
  | {
      readonly requestId: string;
      readonly operation: 'course.comment.like.v1';
      readonly courseId: string;
      readonly commentId: string;
      readonly outcome: 'rejected';
      readonly code:
        | 'COURSE_REVISION_CONFLICT'
        | 'COURSE_COMMENT_ALREADY_LIKED'
        | 'COURSE_COMMENT_CANCELLED';
    };

/** Exact text is counted without normalization and without Node/browser globals. */
export function courseCommentBytes(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const code = character.codePointAt(0)!;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}
export function courseCommentBody(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 8000 &&
    value.trim().length > 0 &&
    !value.includes('\u0000') &&
    ![...value].some((character) => {
      const code = character.codePointAt(0)!;
      return code >= 0xd800 && code <= 0xdfff;
    }) &&
    courseCommentBytes(value) <= 8000
  );
}
export function decodeCourseComment(value: unknown): CourseComment {
  exact(value, ['id', 'body', 'likes', 'createdAt']);
  if (
    !courseId(value.id) ||
    !courseCommentBody(value.body) ||
    typeof value.likes !== 'number' ||
    !Number.isSafeInteger(value.likes) ||
    value.likes < 0 ||
    !timestamp(value.createdAt)
  )
    invalidCourse();
  return Object.freeze({
    id: value.id,
    body: value.body,
    likes: value.likes,
    createdAt: value.createdAt,
  });
}
export function decodeCourseCommentPage(value: unknown): CourseCommentPage {
  exact(value, [
    'courseId',
    'catalogRevision',
    'courseRevision',
    'commentRevision',
    'items',
    'nextCursor',
    'continuation',
  ]);
  if (
    !courseId(value.courseId) ||
    !courseId(value.catalogRevision) ||
    !courseId(value.courseRevision) ||
    typeof value.commentRevision !== 'string' ||
    !/^[1-9][0-9]{0,18}$/.test(value.commentRevision) ||
    !Array.isArray(value.items) ||
    value.items.length > 50 ||
    !(value.nextCursor === null || courseCursor(value.nextCursor)) ||
    (value.continuation !== 'more' && value.continuation !== 'end') ||
    (value.nextCursor === null) !== (value.continuation === 'end') ||
    (value.continuation === 'more' && value.items.length === 0)
  )
    invalidCourse();
  const items = value.items.map(decodeCourseComment);
  if (new Set(items.map((item) => item.id)).size !== items.length)
    invalidCourse();
  return Object.freeze({
    courseId: value.courseId,
    catalogRevision: value.catalogRevision,
    courseRevision: value.courseRevision,
    commentRevision: value.commentRevision,
    items: Object.freeze(items),
    nextCursor: value.nextCursor,
    continuation: value.continuation,
  });
}
export function decodeCourseCommentLike(value: unknown): CourseCommentLike {
  exact(value, [
    'clientRequestId',
    'expectedCatalogRevision',
    'expectedCourseRevision',
  ]);
  if (
    !courseId(value.clientRequestId) ||
    !courseId(value.expectedCatalogRevision) ||
    !courseId(value.expectedCourseRevision)
  )
    invalidCourse();
  return Object.freeze({
    clientRequestId: value.clientRequestId,
    expectedCatalogRevision: value.expectedCatalogRevision,
    expectedCourseRevision: value.expectedCourseRevision,
  });
}
export function decodeCourseCommentPublish(
  value: unknown,
): CourseCommentPublish {
  exact(value, [
    'clientRequestId',
    'expectedCatalogRevision',
    'expectedCourseRevision',
    'body',
  ]);
  if (!courseCommentBody(value.body)) invalidCourse();
  return Object.freeze({
    ...decodeCourseCommentLike({
      clientRequestId: value.clientRequestId,
      expectedCatalogRevision: value.expectedCatalogRevision,
      expectedCourseRevision: value.expectedCourseRevision,
    }),
    body: value.body,
  });
}
export function decodeCourseCommentIntent(value: unknown): CourseCommentIntent {
  if (!isRecord(value)) invalidCourse();
  if (value.operation === 'course.comment.publish.v1') {
    exact(value, ['operation', 'courseId', 'payload']);
    if (!courseId(value.courseId)) invalidCourse();
    return Object.freeze({
      operation: value.operation,
      courseId: value.courseId,
      payload: decodeCourseCommentPublish(value.payload),
    });
  }
  exact(value, ['operation', 'courseId', 'commentId', 'payload']);
  if (
    value.operation !== 'course.comment.like.v1' ||
    !courseId(value.courseId) ||
    !courseId(value.commentId)
  )
    invalidCourse();
  return Object.freeze({
    operation: value.operation,
    courseId: value.courseId,
    commentId: value.commentId,
    payload: decodeCourseCommentLike(value.payload),
  });
}
export function decodeCourseCommentReceipt(
  value: unknown,
): CourseCommentReceipt {
  if (
    !isRecord(value) ||
    !courseId(value.requestId) ||
    !courseId(value.courseId) ||
    (value.outcome !== 'applied' && value.outcome !== 'rejected')
  )
    invalidCourse();
  const base = { requestId: value.requestId, courseId: value.courseId };
  if (value.operation === 'course.comment.publish.v1') {
    if (value.outcome === 'applied') {
      exact(value, [
        'requestId',
        'operation',
        'courseId',
        'outcome',
        'commentId',
        'createdAt',
      ]);
      if (!courseId(value.commentId) || !timestamp(value.createdAt))
        invalidCourse();
      return Object.freeze({
        ...base,
        operation: value.operation,
        outcome: value.outcome,
        commentId: value.commentId,
        createdAt: value.createdAt,
      });
    }
    exact(value, ['requestId', 'operation', 'courseId', 'outcome', 'code']);
    if (
      value.code !== 'COURSE_REVISION_CONFLICT' &&
      value.code !== 'CONTENT_REJECTED' &&
      value.code !== 'COURSE_COMMENT_CANCELLED'
    )
      invalidCourse();
    return Object.freeze({
      ...base,
      operation: value.operation,
      outcome: value.outcome,
      code: value.code,
    });
  }
  if (
    value.operation !== 'course.comment.like.v1' ||
    !courseId(value.commentId)
  )
    invalidCourse();
  if (value.outcome === 'applied') {
    exact(value, [
      'requestId',
      'operation',
      'courseId',
      'commentId',
      'outcome',
      'recordedAt',
    ]);
    if (!timestamp(value.recordedAt)) invalidCourse();
    return Object.freeze({
      ...base,
      operation: value.operation,
      commentId: value.commentId,
      outcome: value.outcome,
      recordedAt: value.recordedAt,
    });
  }
  exact(value, [
    'requestId',
    'operation',
    'courseId',
    'commentId',
    'outcome',
    'code',
  ]);
  if (
    value.code !== 'COURSE_REVISION_CONFLICT' &&
    value.code !== 'COURSE_COMMENT_ALREADY_LIKED' &&
    value.code !== 'COURSE_COMMENT_CANCELLED'
  )
    invalidCourse();
  return Object.freeze({
    ...base,
    operation: value.operation,
    commentId: value.commentId,
    outcome: value.outcome,
    code: value.code,
  });
}
export function matchCourseCommentReceipt(
  intent: CourseCommentIntent,
  receipt: CourseCommentReceipt,
): void {
  if (
    intent.operation !== receipt.operation ||
    intent.courseId !== receipt.courseId ||
    intent.payload.clientRequestId !== receipt.requestId ||
    (intent.operation === 'course.comment.like.v1' &&
      (receipt.operation !== 'course.comment.like.v1' ||
        intent.commentId !== receipt.commentId))
  )
    invalidCourse();
}
