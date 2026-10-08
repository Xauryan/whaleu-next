import { z } from 'zod';
export const activityIdSchema = z
  .uuid()
  .transform((value) => value.toLowerCase());
const publicId = z.uuid().refine((value) => value === value.toLowerCase());
export const activityCursorSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const activityTimestampSchema = z.iso
  .datetime({ offset: true })
  .refine((value) => !/\.\d{7}/.test(value));
export const activityTextSchema = z
  .string()
  .max(200000)
  .refine(
    (value) =>
      !Array.from(value).some((character) =>
        [0, 11, 12].includes(character.codePointAt(0)!),
      ) && !/[\uD800-\uDFFF]/u.test(value),
  );
export const activityEmptyQuerySchema = z.strictObject({});
export const activityEmptyBodySchema = z.union([
  z.undefined(),
  z.strictObject({}),
]);
export const activityListQuerySchema = z.strictObject({
  window: z.enum(['entry', 'all']).default('entry'),
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
  cursor: activityCursorSchema.optional(),
});
export const activityVisitCommandSchema = z.strictObject({
  regionId: activityIdSchema,
  expectedCatalogRevision: activityIdSchema,
});
export const activityContextSchema = z.strictObject({
  regionId: publicId,
  visitHistory: z.enum(['never_visited', 'visited', 'unavailable']),
});
export const activityMediaSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('absent') }),
  z.strictObject({ status: z.literal('unavailable') }),
]);
export const activityGallerySchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('known_empty'),
    items: z.array(z.never()).length(0),
  }),
  z.strictObject({ status: z.literal('unavailable'), items: z.null() }),
]);
export const activityCreatedAtSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('known'),
    value: activityTimestampSchema,
  }),
  z.strictObject({ status: z.literal('unavailable'), value: z.null() }),
]);
export const activityRewardSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('known'), value: z.boolean() }),
  z.strictObject({ status: z.literal('unavailable'), value: z.null() }),
]);
export const activityOnlineSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('known'),
    value: z.enum(['online', 'offline']),
  }),
  z.strictObject({ status: z.literal('unavailable'), value: z.null() }),
]);
const summary = {
  id: publicId,
  revision: publicId,
  title: activityTextSchema,
  organizerLabel: activityTextSchema,
  reward: activityRewardSchema,
  online: activityOnlineSchema,
  createdAt: activityCreatedAtSchema,
  cover: activityMediaSchema,
  organizerAvatar: activityMediaSchema,
};
export const activitySummarySchema = z.strictObject(summary);
export const activityDetailSchema = z.strictObject({
  ...summary,
  regionId: publicId,
  bodyText: activityTextSchema,
  activityTime: activityTextSchema.nullable(),
  activityLocation: activityTextSchema.nullable(),
  gallery: activityGallerySchema,
  organizerQr: activityMediaSchema,
});
export const activitySelectionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('all') }),
  z.strictObject({ kind: z.literal('recent'), since: activityTimestampSchema }),
  z.strictObject({ kind: z.literal('historical'), maximum: z.literal(10) }),
]);
export const activityPageSchema = z
  .strictObject({
    context: z.strictObject({ regionId: publicId, catalogRevision: publicId }),
    selection: activitySelectionSchema,
    items: z.array(activitySummarySchema).max(50),
    continuation: z.enum(['more', 'end']),
    nextCursor: activityCursorSchema.nullable(),
    pageCursor: activityCursorSchema,
  })
  .refine(
    (value) => (value.continuation === 'end') === (value.nextCursor === null),
  )
  .refine((value) => value.continuation === 'end' || value.items.length > 0)
  .refine(
    (value) =>
      new Set(value.items.map((item) => item.id)).size === value.items.length,
  )
  .refine(
    (value) =>
      value.selection.kind !== 'historical' || value.items.length <= 10,
  );
export const activityVisitReceiptSchema = z.strictObject({
  requestId: publicId,
  regionId: publicId,
  catalogRevision: publicId,
  visitedAt: activityTimestampSchema,
});
export type ActivityListQuery = z.infer<typeof activityListQuerySchema>;
export type ActivityVisitCommand = z.infer<typeof activityVisitCommandSchema>;
export type ActivitySelection = z.infer<typeof activitySelectionSchema>;
export type ActivityVisitReceipt = z.infer<typeof activityVisitReceiptSchema>;
