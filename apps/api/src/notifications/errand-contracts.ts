import { z } from 'zod';
const id = z.uuid().refine((v) => v === v.toLowerCase());
export const errandNoticeQuerySchema = z.strictObject({
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
  cursor: z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/)
    .optional(),
});
const base = {
  noticeId: id,
  createdAt: z.iso.datetime({ offset: true }),
  readAt: z.iso.datetime({ offset: true }).nullable(),
};
const freshReason = (maximum: number) =>
  z
    .string()
    .min(1)
    .max(maximum * 2)
    .refine((v) => [...v].length <= maximum);
export const errandNoticeSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...base,
    kind: z.enum(['accepted', 'completed']),
    orderId: id,
  }),
  z.strictObject({
    ...base,
    kind: z.literal('admin_deleted'),
    orderId: id,
    deletionReason: z.discriminatedUnion('status', [
      z.strictObject({ status: z.literal('not_provided') }),
      z.strictObject({
        status: z.literal('provided'),
        value: freshReason(500),
      }),
    ]),
  }),
  z.strictObject({
    ...base,
    kind: z.literal('feature_restricted'),
    restrictionId: id,
    eventId: id,
    action: z.enum(['publish', 'accept', 'all']),
    reason: freshReason(255),
    startsAt: z.iso.datetime({ offset: true }),
    endsAt: z.iso.datetime({ offset: true }).nullable(),
  }),
  z.strictObject({
    ...base,
    kind: z.literal('feature_released'),
    restrictionId: id,
    eventId: id,
    action: z.enum(['publish', 'accept', 'all']),
    reason: freshReason(255),
    releasedAt: z.iso.datetime({ offset: true }),
  }),
]);
export const errandNoticesPageSchema = z.strictObject({
  items: z.array(errandNoticeSchema).max(50),
  nextCursor: z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/)
    .nullable(),
  unreadCount: z.number().int().nonnegative(),
});
export const errandUnreadSchema = z.strictObject({
  unreadCount: z.number().int().nonnegative(),
});
export const errandNoticeReadSchema = z.strictObject({
  noticeId: id,
  readAt: z.iso.datetime({ offset: true }),
  unreadCount: z.number().int().nonnegative(),
});
export type ErrandNoticeQuery = z.infer<typeof errandNoticeQuerySchema>;
