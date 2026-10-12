import type { ApiClient } from '../api/client';
import type { Cancellation, Json } from '../platform/contracts';
import {
  courseCursor,
  courseId,
  invalidCourse,
} from '../course-ratings/contract';
import {
  decodeCourseCommentIntent,
  decodeCourseCommentPage,
  decodeCourseCommentReceipt,
  matchCourseCommentReceipt,
  type CourseCommentIntent,
  type CourseCommentPage,
  type CourseCommentReceipt,
  type CourseCommentSort,
} from './contract';
export interface CourseCommentsGateway {
  list(
    courseId: string,
    sort: CourseCommentSort,
    cursor: string | null,
    cancel: Cancellation,
    limit?: number,
  ): Promise<CourseCommentPage>;
  submit(
    intent: CourseCommentIntent,
    cancel: Cancellation,
  ): Promise<CourseCommentReceipt>;
  cancel(
    intent: CourseCommentIntent,
    cancel: Cancellation,
  ): Promise<CourseCommentReceipt>;
  receipt(
    requestId: string,
    cancel: Cancellation,
  ): Promise<CourseCommentReceipt>;
}
export class HttpCourseCommentsGateway implements CourseCommentsGateway {
  constructor(private readonly api: ApiClient) {}
  async list(
    id: string,
    sort: CourseCommentSort,
    cursor: string | null,
    cancel: Cancellation,
    limit = 20,
  ): Promise<CourseCommentPage> {
    if (
      !courseId(id) ||
      (sort !== 'likes' && sort !== 'time') ||
      (cursor !== null && !courseCursor(cursor)) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 50
    )
      invalidCourse();
    const page = await this.api.request(
      {
        path: `/v1/ratings/courses/${id}/comments`,
        method: 'GET',
        authentication: 'required',
        authReplay: 'once',
        successStatus: 200,
        decode: decodeCourseCommentPage,
      },
      {
        cancellation: cancel,
        query: { sort, limit, ...(cursor ? { cursor } : {}) },
      },
    );
    if (
      page.courseId !== id ||
      page.items.length > limit ||
      (page.nextCursor !== null && page.nextCursor === cursor)
    )
      invalidCourse();
    return page;
  }
  async submit(
    raw: CourseCommentIntent,
    cancel: Cancellation,
  ): Promise<CourseCommentReceipt> {
    const intent = decodeCourseCommentIntent(raw);
    const result = await this.api.request(
      {
        path: `/v1/ratings/courses/${intent.courseId}/comments${intent.operation === 'course.comment.like.v1' ? `/${intent.commentId}/like` : ''}`,
        method: 'POST',
        authentication: 'required',
        authReplay: 'once',
        successStatus: 200,
        decode: decodeCourseCommentReceipt,
      },
      {
        cancellation: cancel,
        body: JSON.parse(JSON.stringify(intent.payload)) as Json,
      },
    );
    matchCourseCommentReceipt(intent, result);
    return result;
  }
  async cancel(
    raw: CourseCommentIntent,
    cancel: Cancellation,
  ): Promise<CourseCommentReceipt> {
    const intent = decodeCourseCommentIntent(raw);
    const result = await this.api.request(
      {
        path: `/v1/ratings/courses/comment-requests/${intent.payload.clientRequestId}/cancel`,
        method: 'POST',
        authentication: 'required',
        authReplay: 'once',
        successStatus: 200,
        decode: decodeCourseCommentReceipt,
      },
      {
        cancellation: cancel,
        body: JSON.parse(
          JSON.stringify({
            operation: intent.operation,
            courseId: intent.courseId,
            ...(intent.operation === 'course.comment.like.v1'
              ? { commentId: intent.commentId }
              : {}),
            command: intent.payload,
          }),
        ) as Json,
      },
    );
    matchCourseCommentReceipt(intent, result);
    return result;
  }
  async receipt(
    requestId: string,
    cancel: Cancellation,
  ): Promise<CourseCommentReceipt> {
    if (!courseId(requestId)) invalidCourse();
    const result = await this.api.request(
      {
        path: `/v1/ratings/courses/comment-requests/${requestId}`,
        method: 'GET',
        authentication: 'required',
        authReplay: 'once',
        successStatus: 200,
        decode: decodeCourseCommentReceipt,
      },
      { cancellation: cancel },
    );
    if (result.requestId !== requestId) invalidCourse();
    return result;
  }
}
