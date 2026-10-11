import type { ApiClient } from '../api/client';
import type { Decoder } from '../api/envelopes';
import type { Cancellation, Json } from '../platform/contracts';
import {
  courseCursor,
  courseId,
  decodeCourseDetail,
  decodeCourseFirstScore,
  decodeCoursePage,
  decodeCourseQuery,
  decodeCourseReceipt,
  invalidCourse,
  matchCourseReceipt,
  type CourseDetail,
  type CourseFirstScore,
  type CoursePage,
  type CourseQuery,
  type CourseReceipt,
} from './contract';

export interface CourseRatingsGateway {
  list(
    query: CourseQuery,
    cursor: string | null,
    cancel: Cancellation,
    limit?: number,
  ): Promise<CoursePage>;
  detail(courseId: string, cancel: Cancellation): Promise<CourseDetail>;
  submit(
    courseId: string,
    payload: CourseFirstScore,
    cancel: Cancellation,
  ): Promise<CourseReceipt>;
  receipt(requestId: string, cancel: Cancellation): Promise<CourseReceipt>;
}
export class HttpCourseRatingsGateway implements CourseRatingsGateway {
  constructor(private readonly api: ApiClient) {}
  private read<T>(
    path: string,
    decode: Decoder<T>,
    cancel: Cancellation,
    query?: Record<string, string | number>,
  ): Promise<T> {
    return this.api.request(
      {
        path,
        method: 'GET',
        authentication: 'required',
        authReplay: 'once',
        successStatus: 200,
        decode,
      },
      { cancellation: cancel, ...(query ? { query } : {}) },
    );
  }
  async list(
    raw: CourseQuery,
    cursor: string | null,
    cancel: Cancellation,
    limit = 20,
  ): Promise<CoursePage> {
    const query = decodeCourseQuery(raw);
    if (
      (cursor !== null && !courseCursor(cursor)) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 50
    )
      invalidCourse();
    const page = await this.read(
      '/v1/ratings/courses',
      decodeCoursePage,
      cancel,
      { ...query, limit, ...(cursor ? { cursor } : {}) },
    );
    if (
      page.items.length > limit ||
      (page.nextCursor !== null && page.nextCursor === cursor) ||
      page.items.some(
        (course) =>
          (query.department !== undefined &&
            (query.department === 99
              ? course.department < 90 || course.department > 99
              : course.department !== query.department)) ||
          (query.category !== undefined && course.category !== query.category),
      )
    )
      invalidCourse();
    return page;
  }
  async detail(id: string, cancel: Cancellation): Promise<CourseDetail> {
    if (!courseId(id)) invalidCourse();
    const result = await this.read(
      `/v1/ratings/courses/${id}`,
      decodeCourseDetail,
      cancel,
    );
    if (result.course.id !== id) invalidCourse();
    return result;
  }
  async submit(
    id: string,
    raw: CourseFirstScore,
    cancel: Cancellation,
  ): Promise<CourseReceipt> {
    if (!courseId(id)) invalidCourse();
    const payload = decodeCourseFirstScore(raw);
    const result = await this.api.request(
      {
        path: `/v1/ratings/courses/${id}/first-score`,
        method: 'POST',
        authentication: 'required',
        authReplay: 'once',
        successStatus: 200,
        decode: decodeCourseReceipt,
      },
      {
        cancellation: cancel,
        body: JSON.parse(JSON.stringify(payload)) as Json,
      },
    );
    matchCourseReceipt(id, payload, result);
    return result;
  }
  async receipt(
    requestId: string,
    cancel: Cancellation,
  ): Promise<CourseReceipt> {
    if (!courseId(requestId)) invalidCourse();
    const result = await this.read(
      `/v1/ratings/courses/requests/${requestId}`,
      decodeCourseReceipt,
      cancel,
    );
    if (result.requestId !== requestId) invalidCourse();
    return result;
  }
}
