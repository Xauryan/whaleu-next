import { z } from 'zod';
import { courseIdSchema, coursePublicIdSchema } from '../contracts.js';
// Explicit Next policy, not an invented legacy maximum. Preserve accepted bytes.
export const courseCommentBodySchema = z
  .string()
  .min(1)
  .max(8000)
  .refine(
    (v) =>
      v.trim().length > 0 &&
      !v.includes('\u0000') &&
      Buffer.byteLength(v, 'utf8') <= 8000 &&
      Buffer.from(v, 'utf8').toString('utf8') === v,
  );
export const courseCommentQuerySchema = z.strictObject({
  sort: z.enum(['likes', 'time']).default('likes'),
  limit: z
    .string()
    .regex(/^(?:[1-9]|[1-4][0-9]|50)$/)
    .transform(Number)
    .default(20),
  cursor: z.string().min(1).max(2000).optional(),
});
export type CourseCommentQuery = z.infer<typeof courseCommentQuerySchema>;
export const courseCommentSchema = z.strictObject({
  id: coursePublicIdSchema,
  body: courseCommentBodySchema,
  likes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  createdAt: z.iso.datetime(),
});
export const courseCommentPageSchema = z.strictObject({
  courseId: coursePublicIdSchema,
  catalogRevision: coursePublicIdSchema,
  courseRevision: coursePublicIdSchema,
  commentRevision: z.string().regex(/^[1-9][0-9]{0,18}$/),
  items: z.array(courseCommentSchema).max(50),
  nextCursor: z.string().min(1).max(2000).nullable(),
  continuation: z.enum(['more', 'end']),
});
export const courseCommentLikeSchema = z.strictObject({
  clientRequestId: courseIdSchema,
  expectedCatalogRevision: courseIdSchema,
  expectedCourseRevision: courseIdSchema,
});
export const courseCommentPublishSchema = courseCommentLikeSchema.extend({
  body: courseCommentBodySchema,
});
export type CourseCommentPublish = z.infer<typeof courseCommentPublishSchema>;
export type CourseCommentLike = z.infer<typeof courseCommentLikeSchema>;
export const courseCommentOperationSchema = z.enum([
  'course.comment.publish.v1',
  'course.comment.like.v1',
]);
export type CourseCommentOperation = z.infer<
  typeof courseCommentOperationSchema
>;
const base = {
  requestId: coursePublicIdSchema,
  courseId: coursePublicIdSchema,
};
export const courseCommentReceiptSchema = z.union([
  z.strictObject({
    ...base,
    operation: z.literal('course.comment.publish.v1'),
    outcome: z.literal('applied'),
    commentId: coursePublicIdSchema,
    createdAt: z.iso.datetime(),
  }),
  z.strictObject({
    ...base,
    operation: z.literal('course.comment.publish.v1'),
    outcome: z.literal('rejected'),
    code: z.enum([
      'COURSE_REVISION_CONFLICT',
      'CONTENT_REJECTED',
      'COURSE_COMMENT_CANCELLED',
    ]),
  }),
  z.strictObject({
    ...base,
    operation: z.literal('course.comment.like.v1'),
    commentId: coursePublicIdSchema,
    outcome: z.literal('applied'),
    recordedAt: z.iso.datetime(),
  }),
  z.strictObject({
    ...base,
    operation: z.literal('course.comment.like.v1'),
    commentId: coursePublicIdSchema,
    outcome: z.literal('rejected'),
    code: z.enum([
      'COURSE_REVISION_CONFLICT',
      'COURSE_COMMENT_ALREADY_LIKED',
      'COURSE_COMMENT_CANCELLED',
    ]),
  }),
]);
export type CourseCommentReceipt = z.infer<typeof courseCommentReceiptSchema>;
export const courseCommentCancelSchema = z.discriminatedUnion('operation', [
  z.strictObject({
    operation: z.literal('course.comment.publish.v1'),
    courseId: courseIdSchema,
    command: courseCommentPublishSchema,
  }),
  z.strictObject({
    operation: z.literal('course.comment.like.v1'),
    courseId: courseIdSchema,
    commentId: courseIdSchema,
    command: courseCommentLikeSchema,
  }),
]);
export type CourseCommentCancel = z.infer<typeof courseCommentCancelSchema>;
