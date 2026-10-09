import { z } from 'zod';
import {
  ratingAuthorSchema,
  ratingCursorSchema,
  ratingEmptySchema,
  ratingPublicIdSchema,
  ratingText,
  ratingTimeSchema,
} from '../../ratings/contracts.js';

export const ratingUpdatesQuerySchema = z.strictObject({
  limit: z
    .union([
      z.number(),
      z
        .string()
        .regex(/^(?:[1-9]|1[0-9]|20)$/)
        .transform(Number),
    ])
    .pipe(z.number().int().min(1).max(20))
    .default(20),
  cursor: ratingCursorSchema.optional(),
});
export const ratingUpdatesEmptySchema = ratingEmptySchema;
export const ratingNoticeReasonSchema = z.enum(['direct_root', 'direct_reply']);
export const ratingNoticeLocatorSchema = z.strictObject({
  regionId: ratingPublicIdSchema.nullable(),
  targetId: ratingPublicIdSchema,
  rootId: ratingPublicIdSchema,
  replyId: ratingPublicIdSchema,
});
export const ratingNoticePreviewSchema = z.strictObject({
  text: z.string().refine((value) => {
    const parsed = ratingText(500).safeParse(value);
    return parsed.success && parsed.data === value;
  }),
  author: ratingAuthorSchema,
});
const base = {
  noticeId: ratingPublicIdSchema,
  createdAt: ratingTimeSchema,
  readAt: ratingTimeSchema.nullable(),
};
export const ratingNoticeSchema = z.discriminatedUnion('status', [
  z.strictObject({ ...base, status: z.literal('unavailable') }),
  z
    .strictObject({
      ...base,
      status: z.literal('available'),
      domain: z.literal('ratings'),
      kind: z.literal('reply'),
      reason: ratingNoticeReasonSchema,
      target: ratingNoticeLocatorSchema,
      preview: ratingNoticePreviewSchema,
    })
    .refine(
      (notice) =>
        notice.preview.author.mode !== 'anonymous' ||
        notice.preview.author.targetId === notice.target.targetId,
    ),
]);
const unreadCount = z.number().int().nonnegative().max(2147483647);
export const ratingUpdatesPageSchema = z
  .strictObject({
    items: z.array(ratingNoticeSchema).max(20),
    nextCursor: ratingCursorSchema.nullable(),
    unreadCount,
  })
  .refine(
    (page) =>
      new Set(page.items.map((item) => item.noticeId)).size ===
      page.items.length,
  );
export const ratingUnreadCountSchema = z.strictObject({ unreadCount });
export const ratingNoticeTargetSchema = z.discriminatedUnion('status', [
  z.strictObject({
    noticeId: ratingPublicIdSchema,
    status: z.literal('unavailable'),
  }),
  z.strictObject({
    noticeId: ratingPublicIdSchema,
    status: z.literal('available'),
    target: ratingNoticeLocatorSchema,
  }),
]);
export const ratingNoticeReadSchema = z.strictObject({
  noticeId: ratingPublicIdSchema,
  readAt: ratingTimeSchema,
  unreadCount,
});
export type RatingUpdatesQuery = z.infer<typeof ratingUpdatesQuerySchema>;
export type RatingNotice = z.infer<typeof ratingNoticeSchema>;
export type RatingUpdatesPage = z.infer<typeof ratingUpdatesPageSchema>;
export type RatingNoticeTarget = z.infer<typeof ratingNoticeTargetSchema>;
export type RatingNoticeLocator = z.infer<typeof ratingNoticeLocatorSchema>;
export type RatingNoticePreview = z.infer<typeof ratingNoticePreviewSchema>;
export interface RatingNoticeRecipient {
  accountId: string;
  reason: z.infer<typeof ratingNoticeReasonSchema>;
}
export interface RatingNoticeEvent {
  id: string;
  sequence: string;
  occurredAt: string;
  target: RatingNoticeLocator;
  recipients: RatingNoticeRecipient[];
}
