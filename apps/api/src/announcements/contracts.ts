import { z } from 'zod';
export const announcementIdSchema = z
  .uuid()
  .transform((value) => value.toLowerCase());
const publicId = z.uuid().refine((value) => value === value.toLowerCase());
export const announcementCursorSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
// Keep exact PostgreSQL precision. Never parse since through JavaScript Date.
export const announcementTimestampSchema = z.iso
  .datetime({ offset: true })
  .refine((value) => !/\.\d{7}/.test(value));
export const announcementTextSchema = z
  .string()
  .max(200000)
  .refine(
    (value) =>
      !Array.from(value).some((character) =>
        [0, 11, 12].includes(character.codePointAt(0)!),
      ) && !/[\uD800-\uDFFF]/u.test(value),
  );
export const announcementScopeQuerySchema = z.strictObject({
  campusId: announcementIdSchema.optional(),
});
export const announcementListQuerySchema = z.strictObject({
  campusId: announcementIdSchema.optional(),
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
  cursor: announcementCursorSchema.optional(),
});
export const announcementChangesQuerySchema = z.strictObject({
  campusId: announcementIdSchema.optional(),
  since: announcementTimestampSchema.optional(),
});
export const announcementEmptyBodySchema = z.union([
  z.undefined(),
  z.strictObject({}),
]);
export const announcementEmptyQuerySchema = z.strictObject({});
export const announcementAckCommandSchema = z.strictObject({
  campusId: announcementIdSchema.nullable(),
  expectedRevision: announcementIdSchema,
});
export const announcementContextSchema = z.strictObject({
  campusId: publicId.nullable(),
});
export const announcementMediaSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('known_empty'),
    items: z.array(z.never()).length(0),
  }),
  z.strictObject({ status: z.literal('unavailable'), items: z.null() }),
]);
const summary = {
  id: publicId,
  revision: publicId,
  versionLabel: announcementTextSchema,
  title: announcementTextSchema,
  announcementDate: z.iso.date().nullable(),
  createdAt: announcementTimestampSchema.nullable(),
  highlight: z.boolean(),
  isLatest: z.boolean(),
  popupEnabled: z.boolean(),
};
export const announcementSummarySchema = z.strictObject(summary);
export const announcementDetailSchema = z.strictObject({
  ...summary,
  bodyText: announcementTextSchema,
  updatedAt: announcementTimestampSchema.nullable(),
  media: announcementMediaSchema,
});
export const announcementPopupSchema = z.strictObject({
  id: publicId,
  revision: publicId,
  versionLabel: announcementTextSchema,
  title: announcementTextSchema,
  announcementDate: z.iso.date().nullable(),
  bodyText: announcementTextSchema,
  media: announcementMediaSchema,
});
export const announcementPageSchema = z
  .strictObject({
    context: announcementContextSchema,
    items: z.array(announcementSummarySchema).max(50),
    continuation: z.enum(['more', 'end']),
    nextCursor: announcementCursorSchema.nullable(),
  })
  .refine(
    (value) => (value.continuation === 'end') === (value.nextCursor === null),
  )
  .refine((value) => value.continuation === 'end' || value.items.length > 0)
  .refine(
    (value) =>
      new Set(value.items.map((item) => item.id)).size === value.items.length,
  );
export const announcementPublicPopupSchema = z.strictObject({
  context: announcementContextSchema,
  popup: announcementPopupSchema.nullable(),
});
export const announcementAcknowledgedSchema = z.strictObject({
  status: z.literal('acknowledged'),
  acknowledgedAt: announcementTimestampSchema.nullable(),
});
export const announcementAcknowledgementSchema = z.discriminatedUnion(
  'status',
  [
    announcementAcknowledgedSchema,
    z.strictObject({ status: z.literal('unseen'), acknowledgedAt: z.null() }),
    z.strictObject({
      status: z.literal('unavailable'),
      acknowledgedAt: z.null(),
    }),
  ],
);
export const announcementOwnerPopupSchema = z.union([
  z.strictObject({ context: announcementContextSchema, candidate: z.null() }),
  z.strictObject({
    context: announcementContextSchema,
    candidate: announcementPopupSchema,
    acknowledgement: announcementAcknowledgementSchema,
  }),
]);
export const announcementAckReceiptSchema = z.strictObject({
  announcementId: publicId,
  acknowledgement: announcementAcknowledgedSchema,
});
export const announcementNewnessSchema = z.discriminatedUnion('status', [
  z
    .strictObject({
      status: z.literal('available'),
      hasNew: z.boolean(),
      newCount: z.string().regex(/^(0|[1-9][0-9]*)$/),
    })
    .refine((value) => value.hasNew === (value.newCount !== '0')),
  z.strictObject({
    status: z.literal('unavailable'),
    hasNew: z.null(),
    newCount: z.null(),
  }),
]);
export const announcementChangesSchema = z.strictObject({
  context: announcementContextSchema,
  since: announcementTimestampSchema,
  checkedAt: announcementTimestampSchema,
  newness: announcementNewnessSchema,
});
export type AnnouncementScopeQuery = z.infer<
  typeof announcementScopeQuerySchema
>;
export type AnnouncementListQuery = z.infer<typeof announcementListQuerySchema>;
export type AnnouncementChangesQuery = z.infer<
  typeof announcementChangesQuerySchema
>;
export type AnnouncementAckCommand = z.infer<
  typeof announcementAckCommandSchema
>;
export type AnnouncementAcknowledgement = z.infer<
  typeof announcementAcknowledgementSchema
>;
export type AnnouncementNewness = z.infer<typeof announcementNewnessSchema>;
