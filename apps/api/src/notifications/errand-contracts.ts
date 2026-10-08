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
export const errandNoticeSchema = z.strictObject({
  noticeId: id,
  kind: z.enum(['accepted', 'completed']),
  orderId: id,
  createdAt: z.iso.datetime({ offset: true }),
  readAt: z.iso.datetime({ offset: true }).nullable(),
});
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
