import {
  CourseCommentsController,
  type CourseCommentsView,
} from '../src/course-comments/controller';
import type {
  CourseComment,
  CourseCommentIntent,
  CourseCommentPage,
  CourseCommentReceipt,
} from '../src/course-comments/contract';
import type { CourseCommentsGateway } from '../src/course-comments/gateway';
import { PendingCourseCommentStore } from '../src/course-comments/pending';
import type { CommunityRuntime } from '../src/community/runtime';
import { setup } from './community-helpers';
import {
  id,
  catalogRevision,
  revision,
  requestId,
  recordedAt,
  otherId,
  missing,
} from './course-ratings-helpers';
export {
  id,
  catalogRevision,
  revision,
  requestId,
  recordedAt,
  otherId,
  missing,
};
export const commentId = '77777777-7777-4777-8777-777777777777';
export const body = '  原文\r\n第二行 😀 e\u0301  ';
export const comment = (patch: Partial<CourseComment> = {}): CourseComment => ({
  id: commentId,
  body,
  likes: 0,
  createdAt: recordedAt,
  ...patch,
});
export const page = (
  patch: Partial<CourseCommentPage> = {},
): CourseCommentPage => ({
  courseId: id,
  catalogRevision,
  courseRevision: revision,
  commentRevision: '1',
  items: [comment()],
  nextCursor: null,
  continuation: 'end',
  ...patch,
});
export const publish = (
  patch: Record<string, unknown> = {},
): CourseCommentIntent => ({
  operation: 'course.comment.publish.v1',
  courseId: id,
  payload: {
    clientRequestId: requestId,
    expectedCatalogRevision: catalogRevision,
    expectedCourseRevision: revision,
    body,
  },
  ...patch,
});
export const like = (): CourseCommentIntent => ({
  operation: 'course.comment.like.v1',
  courseId: id,
  commentId,
  payload: {
    clientRequestId: requestId,
    expectedCatalogRevision: catalogRevision,
    expectedCourseRevision: revision,
  },
});
export function receipt(intent = publish()): CourseCommentReceipt {
  const base = {
    requestId: intent.payload.clientRequestId,
    operation: intent.operation,
    courseId: intent.courseId,
  };
  return intent.operation === 'course.comment.publish.v1'
    ? {
        ...base,
        operation: intent.operation,
        outcome: 'applied',
        commentId,
        createdAt: recordedAt,
      }
    : {
        ...base,
        operation: intent.operation,
        outcome: 'applied',
        commentId: intent.commentId,
        recordedAt,
      };
}
export function cancelled(intent = publish()): CourseCommentReceipt {
  return intent.operation === 'course.comment.publish.v1'
    ? {
        requestId: intent.payload.clientRequestId,
        operation: intent.operation,
        courseId: intent.courseId,
        outcome: 'rejected',
        code: 'COURSE_COMMENT_CANCELLED',
      }
    : {
        requestId: intent.payload.clientRequestId,
        operation: intent.operation,
        courseId: intent.courseId,
        commentId: intent.commentId,
        outcome: 'rejected',
        code: 'COURSE_COMMENT_CANCELLED',
      };
}
export function commentsHarness() {
  const s = setup(),
    pendingCourseComments = new PendingCourseCommentStore(
      s.storage,
      'synthetic-comment-origin',
    );
  const calls: Array<{ method: string; args: unknown[] }> = [],
    commands: CourseCommentIntent[] = [],
    ids = { count: 0, next: async () => requestId };
  const impl: CourseCommentsGateway = {
    list: async () => page(),
    submit: async (intent) => receipt(intent),
    receipt: async () => {
      throw missing();
    },
    cancel: async (intent) => cancelled(intent),
  };
  const gateway: CourseCommentsGateway = {
    list: (...args) => {
      calls.push({ method: 'list', args });
      return impl.list(...args);
    },
    submit: (...args) => {
      calls.push({ method: 'submit', args });
      commands.push(args[0]);
      return impl.submit(...args);
    },
    receipt: (...args) => {
      calls.push({ method: 'receipt', args });
      return impl.receipt(...args);
    },
    cancel: (...args) => {
      calls.push({ method: 'cancel', args });
      return impl.cancel(...args);
    },
  };
  const runtime: CommunityRuntime = {
    ...s.runtime,
    courseComments: gateway,
    pendingCourseComments,
    newRequestId: () => {
      ids.count++;
      return ids.next();
    },
  };
  const views: CourseCommentsView[] = [],
    controller = new CourseCommentsController(runtime, (view) =>
      views.push(view),
    );
  return {
    ...s,
    runtime,
    controller,
    views,
    impl,
    gateway,
    pendingCourseComments,
    calls,
    commands,
    ids,
    view: () => views[views.length - 1]!,
  };
}
export const choosePublish = (
  s: ReturnType<typeof commentsHarness>,
  text = body,
): void => {
  s.controller.setBody(text);
  s.controller.confirmPublish();
};
