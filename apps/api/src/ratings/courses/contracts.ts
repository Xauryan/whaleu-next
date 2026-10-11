import { z } from 'zod';
export const courseIdSchema = z
  .uuid()
  .transform((value) => value.toLowerCase());
export const coursePublicIdSchema = z
  .uuid()
  .refine((value) => value === value.toLowerCase());
export const courseScoreSchema = z
  .number()
  .finite()
  .min(0.5)
  .max(5)
  .multipleOf(0.5);
export const courseScoresSchema = z.strictObject({
  gradeScore: courseScoreSchema,
  abilityScore: courseScoreSchema,
  overallScore: courseScoreSchema,
});
export const courseQuerySchema = z
  .strictObject({
    search: z.string().trim().max(80).optional(),
    department: z
      .string()
      .regex(/^(?:[1-9]|[1-4][0-9]|5[0-4]|99)$/)
      .transform(Number)
      .optional(),
    category: z.string().trim().min(1).max(80).optional(),
    sort: z.enum(['rating', 'time']).default('rating'),
    limit: z
      .string()
      .regex(/^(?:[1-9]|[1-4][0-9]|50)$/)
      .transform(Number)
      .default(20),
    cursor: z.string().min(1).max(2000).optional(),
  })
  .refine((v) => !(v.department !== undefined && v.category !== undefined));
export type CourseQuery = z.infer<typeof courseQuerySchema>;
export const courseSummarySchema = z.union([
  z
    .strictObject({
      kind: z.literal('known'),
      count: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
      gradeScore: z.number().min(0.5).max(5).nullable(),
      abilityScore: z.number().min(0.5).max(5).nullable(),
      overallScore: z.number().min(0.5).max(5).nullable(),
    })
    .refine((v) =>
      v.count === 0
        ? v.gradeScore === null &&
          v.abilityScore === null &&
          v.overallScore === null
        : v.gradeScore !== null &&
          v.abilityScore !== null &&
          v.overallScore !== null,
    ),
  z.strictObject({ kind: z.literal('unavailable') }),
]);
export type CourseSummary = z.infer<typeof courseSummarySchema>;
export const courseOwnSchema = z.union([
  z.strictObject({
    kind: z.literal('recorded'),
    ...courseScoresSchema.shape,
    recordedAt: z.iso.datetime(),
  }),
  z.strictObject({ kind: z.literal('not_submitted') }),
  z.strictObject({ kind: z.literal('unavailable') }),
]);
export const courseSchema = z.strictObject({
  id: coursePublicIdSchema,
  revision: coursePublicIdSchema,
  name: z.string().min(1).max(200),
  department: z
    .number()
    .int()
    .refine((v) => (v >= 1 && v <= 54) || (v >= 90 && v <= 99)),
  category: z.string().max(80).nullable(),
  nature: z.string().max(100).nullable(),
  code: z.string().max(100).nullable(),
  campusId: coursePublicIdSchema,
  campusLabel: z.string().min(1).max(200),
  sourceCampusKey: z.string().min(1).max(200),
  createdAt: z.iso.datetime(),
  summary: courseSummarySchema,
});
export const coursePageSchema = z.strictObject({
  catalogRevision: coursePublicIdSchema,
  scoreRevision: z.string().regex(/^[1-9][0-9]{0,18}$/),
  items: z.array(courseSchema).max(50),
  nextCursor: z.string().min(1).max(2000).nullable(),
  continuation: z.enum(['more', 'end']),
});
export const courseDetailSchema = z.strictObject({
  catalogRevision: coursePublicIdSchema,
  course: courseSchema,
  myScore: courseOwnSchema,
});
export const courseFirstScoreSchema = z.strictObject({
  clientRequestId: courseIdSchema,
  expectedCatalogRevision: courseIdSchema,
  expectedCourseRevision: courseIdSchema,
  ...courseScoresSchema.shape,
});
export type CourseFirstScore = z.infer<typeof courseFirstScoreSchema>;
const receiptBase = {
  requestId: coursePublicIdSchema,
  operation: z.literal('course.first-score.v1'),
  courseId: coursePublicIdSchema,
};
export const courseReceiptSchema = z.union([
  z.strictObject({
    ...receiptBase,
    outcome: z.literal('applied'),
    ...courseScoresSchema.shape,
    recordedAt: z.iso.datetime(),
  }),
  z.strictObject({
    ...receiptBase,
    outcome: z.literal('rejected'),
    code: z.enum(['COURSE_ALREADY_RATED', 'COURSE_REVISION_CONFLICT']),
  }),
]);
export type CourseReceipt = z.infer<typeof courseReceiptSchema>;
export const courseEmptySchema = z.strictObject({});
