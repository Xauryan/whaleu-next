import { z } from 'zod';
export const ratingIdSchema = z.uuid().transform((s) => s.toLowerCase());
export const ratingPublicIdSchema = z
  .uuid()
  .refine((s) => s === s.toLowerCase());
export const ratingTimeSchema = z.iso
  .datetime({ offset: true })
  .refine((s) => s.endsWith('Z') && !/\.\d{7,}/.test(s));
export const ratingCursorSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const ratingEmptySchema = z.strictObject({});
export const ratingText = (maximum: number, required = true) =>
  z
    .string()
    .max(maximum * 2 + 100)
    .transform((s) => s.replaceAll('\r\n', '\n').trim())
    .refine(
      (s) =>
        (!required || s.length > 0) &&
        [...s].length <= maximum &&
        [...s].every((c) => {
          const n = c.codePointAt(0)!;
          return (
            n === 9 ||
            n === 10 ||
            (n >= 32 &&
              !(n >= 127 && n <= 159) &&
              !(n >= 0xd800 && n <= 0xdfff))
          );
        }),
    );
const outputText = (maximum: number, required = true) =>
  z.string().refine((s) => {
    const r = ratingText(maximum, required).safeParse(s);
    return r.success && r.data === s;
  });
/** Strict text for immutable scoped intents and output schemas. */
export const ratingCanonicalText = outputText;
const pageInput = {
  limit: z
    .union([
      z.number(),
      z
        .string()
        .regex(/^[1-9][0-9]?$/)
        .transform(Number),
    ])
    .pipe(z.number().int().min(1).max(50))
    .default(20),
  cursor: ratingCursorSchema.optional(),
};
export const ratingScopeQuerySchema = z.strictObject({
  regionId: ratingIdSchema.optional(),
});
export const ratingCategoryQuerySchema = ratingScopeQuerySchema.extend({
  parentId: ratingIdSchema.optional(),
  ...pageInput,
});
export const ratingTargetQuerySchema = ratingScopeQuerySchema.extend({
  categoryId: ratingIdSchema,
  ...pageInput,
});
export const ratingCommentQuerySchema = ratingScopeQuerySchema.extend({
  ...pageInput,
  sort: z.enum(['time', 'likes']).optional(),
  order: z.enum(['asc', 'desc']).optional(),
});
export const setRatingScoreSchema = z.strictObject({
  clientRequestId: ratingIdSchema,
  regionId: ratingPublicIdSchema.nullable(),
  expectedTargetRevision: ratingPublicIdSchema,
  expectedRevision: ratingPublicIdSchema.nullable(),
  score: z.number().int().min(1).max(5),
});
export const createRatingCommentSchema = z.strictObject({
  clientRequestId: ratingIdSchema,
  regionId: ratingPublicIdSchema.nullable(),
  expectedTargetRevision: ratingPublicIdSchema,
  authorMode: z.enum(['named', 'anonymous']),
  body: ratingText(500),
  assetIds: z.tuple([]),
});
export const deleteRatingCommentSchema = z.strictObject({
  clientRequestId: ratingIdSchema,
  regionId: ratingPublicIdSchema.nullable(),
  targetId: ratingPublicIdSchema,
  expectedTargetRevision: ratingPublicIdSchema,
  expectedRevision: ratingPublicIdSchema,
});
export const ratingRegionSchema = z.strictObject({
  id: ratingPublicIdSchema,
  label: outputText(200),
});
export const ratingContextSchema = z.strictObject({
  homeRegion: ratingRegionSchema.nullable(),
  regions: z
    .array(
      ratingRegionSchema.extend({
        relation: z.enum(['home', 'related', 'managed']),
      }),
    )
    .max(200),
});
export const ratingCategorySchema = z
  .strictObject({
    id: ratingPublicIdSchema,
    parentId: ratingPublicIdSchema.nullable(),
    level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    kind: z.string().regex(/^[a-z][a-z0-9_]{0,49}$/),
    systemKey: z
      .string()
      .regex(/^[a-z][a-z0-9_]{1,48}$/)
      .nullable(),
    name: outputText(100),
    description: outputText(500, false),
    revision: ratingPublicIdSchema,
  })
  .refine((c) => (c.level === 1) === (c.parentId === null));
export const ratingTargetSchema = z.strictObject({
  id: ratingPublicIdSchema,
  categoryId: ratingPublicIdSchema,
  name: outputText(100),
  description: outputText(500, false),
  revision: ratingPublicIdSchema,
  allowedActions: z.strictObject({
    setScore: z.boolean(),
    createComment: z.boolean(),
    authorModes: z
      .array(z.enum(['named', 'anonymous']))
      .min(1)
      .max(2)
      .refine((m) => m[0] === 'named' && new Set(m).size === m.length),
  }),
});
export const ratingMyScoreSchema = z.strictObject({
  myScore: z
    .strictObject({
      score: z.number().int().min(1).max(5),
      revision: ratingPublicIdSchema,
    })
    .nullable(),
});
const count = z.number().int().nonnegative().max(2147483647);
export const ratingSummarySchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('unavailable') }),
  z
    .strictObject({
      status: z.literal('known'),
      count,
      sum: z.number().int().nonnegative().max(10737418235),
      average: z.number().min(1).max(5).nullable(),
      distribution: z.strictObject({
        '1': count,
        '2': count,
        '3': count,
        '4': count,
        '5': count,
      }),
      revision: ratingPublicIdSchema,
    })
    .refine(
      (s) =>
        s.count === Object.values(s.distribution).reduce((a, b) => a + b, 0) &&
        s.sum ===
          Object.entries(s.distribution).reduce(
            (sum, [score, n]) => sum + Number(score) * n,
            0,
          ) &&
        (s.count === 0
          ? s.average === null
          : s.average === Math.round((s.sum * 10) / s.count) / 10),
    ),
]);
export const ratingAuthorSchema = z.discriminatedUnion('mode', [
  z.strictObject({
    mode: z.literal('named'),
    profileId: ratingPublicIdSchema,
    displayName: outputText(100),
  }),
  z.strictObject({
    mode: z.literal('anonymous'),
    targetId: ratingPublicIdSchema,
    personaId: ratingPublicIdSchema,
    displayName: outputText(100),
  }),
]);
export const ratingCommentSchema = z
  .strictObject({
    id: ratingPublicIdSchema,
    targetId: ratingPublicIdSchema,
    body: outputText(500),
    revision: ratingPublicIdSchema,
    createdAt: ratingTimeSchema,
    author: ratingAuthorSchema,
    isMine: z.boolean(),
    allowedActions: z.strictObject({ delete: z.boolean() }),
  })
  .refine(
    (c) =>
      (!c.allowedActions.delete || c.isMine) &&
      (c.author.mode !== 'anonymous' || c.author.targetId === c.targetId),
  );
const page = <T extends z.ZodType, S extends z.ZodRawShape>(
  item: T,
  locator: S,
) =>
  z
    .strictObject({
      context: z.strictObject({
        regionId: ratingPublicIdSchema.nullable(),
        catalogRevision: ratingPublicIdSchema,
        ...locator,
      }),
      items: z.array(item).max(50),
      nextCursor: ratingCursorSchema.nullable(),
      continuation: z.enum(['more', 'scan', 'end']),
    })
    .refine((p) => (p.nextCursor === null) === (p.continuation === 'end'));
export const ratingCategoryPageSchema = page(ratingCategorySchema, {
  parentId: ratingPublicIdSchema.nullable(),
}).refine((p) => p.items.every((c) => c.parentId === p.context.parentId));
export const ratingTargetPageSchema = page(ratingTargetSchema, {
  categoryId: ratingPublicIdSchema,
}).refine((p) => p.items.every((t) => t.categoryId === p.context.categoryId));
export const ratingCommentPageSchema = page(ratingCommentSchema, {
  targetId: ratingPublicIdSchema,
}).refine((p) => p.items.every((c) => c.targetId === p.context.targetId));
export const ratingOperationSchema = z.enum([
  'set_score',
  'create_comment',
  'delete_comment',
]);
export const ratingRejectionSchema = z.enum([
  'RATING_NOT_FOUND',
  'RATING_REVISION_CONFLICT',
  'PHONE_VERIFICATION_REQUIRED',
  'AFFILIATION_VERIFICATION_REQUIRED',
  'IDENTITY_CAMPUS_REQUIRED',
  'SAFETY_ACTION_RESTRICTED',
  'CONTENT_REJECTED',
]);
export const ratingReceiptSchema = z.discriminatedUnion('outcome', [
  z
    .strictObject({
      requestId: ratingPublicIdSchema,
      operation: ratingOperationSchema,
      outcome: z.enum(['applied', 'noop']),
      targetId: ratingPublicIdSchema,
      subjectId: ratingPublicIdSchema,
      revision: ratingPublicIdSchema,
      occurredAt: ratingTimeSchema,
    })
    .refine(
      (r) =>
        (r.operation !== 'set_score' || r.subjectId === r.targetId) &&
        !(r.operation === 'create_comment' && r.outcome === 'noop'),
    ),
  z.strictObject({
    requestId: ratingPublicIdSchema,
    operation: ratingOperationSchema,
    outcome: z.literal('rejected'),
    code: ratingRejectionSchema,
  }),
]);
export type RatingReceipt = z.infer<typeof ratingReceiptSchema>;
export type RatingOperation = z.infer<typeof ratingOperationSchema>;
export type RatingCategoryQuery = z.infer<typeof ratingCategoryQuerySchema>;
export type RatingTargetQuery = z.infer<typeof ratingTargetQuerySchema>;
export type RatingCommentQuery = z.infer<typeof ratingCommentQuerySchema>;
export type SetRatingScore = z.infer<typeof setRatingScoreSchema>;
export type CreateRatingComment = z.infer<typeof createRatingCommentSchema>;
export type DeleteRatingComment = z.infer<typeof deleteRatingCommentSchema>;
export type RatingComment = z.infer<typeof ratingCommentSchema>;
export type RatingSummary = z.infer<typeof ratingSummarySchema>;
