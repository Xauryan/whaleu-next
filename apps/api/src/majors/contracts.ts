import { z } from 'zod';
// New bounded Next text policy; preserve the accepted text byte-for-byte.
export const majorTextBodySchema = z
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
export const majorIdSchema = z.uuid().transform((value) => value.toLowerCase());
export const majorPublicIdSchema = z
  .uuid()
  .refine((value) => value === value.toLowerCase());
const limit = z
  .string()
  .regex(/^(?:[1-9]|[1-4][0-9]|50)$/)
  .transform(Number)
  .default(20);
export const majorDepartmentIdSchema = z
  .number()
  .int()
  .min(-2147483648)
  .max(2147483647);
export const majorQuerySchema = z.strictObject({
  departmentId: z
    .string()
    .regex(/^(?:0|-?[1-9][0-9]{0,9})$/)
    .transform(Number)
    .pipe(majorDepartmentIdSchema)
    .optional(),
  keyword: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .refine(
      (value) =>
        !Array.from(value).some((character) => {
          const code = character.codePointAt(0)!;
          return code < 32 || code === 127;
        }),
    )
    .optional(),
  limit,
  cursor: z.string().min(1).max(2000).optional(),
});
export type MajorQuery = z.infer<typeof majorQuerySchema>;
export const majorRelatedQuerySchema = z.strictObject({
  limit: z
    .string()
    .regex(/^(?:[1-9]|[1-4][0-9]|50)$/)
    .transform(Number)
    .default(5),
});
export const majorSummarySchema = z.union([
  z
    .strictObject({
      kind: z.literal('known'),
      rootCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      hotComment: z
        .strictObject({
          id: majorPublicIdSchema,
          body: majorTextBodySchema,
          likes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        })
        .nullable(),
    })
    .refine((v) => (v.rootCount === 0) === (v.hotComment === null)),
  z.strictObject({ kind: z.literal('unavailable') }),
]);
export const majorSchema = z.strictObject({
  id: majorPublicIdSchema,
  majorRevision: majorPublicIdSchema,
  catalogRevision: majorPublicIdSchema,
  campusId: majorPublicIdSchema,
  departmentId: majorDepartmentIdSchema,
  collegeName: z.string().min(1).max(200),
  majorName: z.string().min(1).max(200),
  summary: majorSummarySchema,
});
export const majorPageSchema = z
  .strictObject({
    catalogRevision: majorPublicIdSchema,
    items: z.array(majorSchema).max(50),
    totalCount: z.number().int().nonnegative().max(1000),
    nextCursor: z.string().min(1).max(2000).nullable(),
    continuation: z.enum(['more', 'end']),
  })
  .refine(
    (value) =>
      (value.nextCursor === null) === (value.continuation === 'end') &&
      (value.continuation === 'end' || value.items.length > 0) &&
      value.totalCount >= value.items.length &&
      value.items.every(
        (item) => item.catalogRevision === value.catalogRevision,
      ) &&
      new Set(value.items.map((item) => item.id)).size === value.items.length,
  );
export const majorDetailSchema = z
  .strictObject({
    catalogRevision: majorPublicIdSchema,
    item: majorSchema,
  })
  .refine((value) => value.item.catalogRevision === value.catalogRevision);
export const majorDepartmentsSchema = z.strictObject({
  catalogRevision: majorPublicIdSchema,
  items: z
    .array(
      z.strictObject({
        departmentId: majorDepartmentIdSchema,
        name: z.string().min(1).max(20),
      }),
    )
    .max(1000),
});
export const majorEmptySchema = z.strictObject({});
