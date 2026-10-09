import { z } from 'zod';
import {
  ratingAuthorSchema,
  ratingCursorSchema,
  ratingEmptySchema,
  ratingPublicIdSchema,
  ratingText,
  ratingTimeSchema,
} from '../../ratings/contracts.js';

export const ratingSubscriptionUpdatesQuerySchema = z.strictObject({
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
export const ratingSubscriptionUpdatesEmptySchema = ratingEmptySchema;
export const ratingSubscriptionNoticeReasonSchema = z.literal(
  'target_subscription',
);
export const ratingSubscriptionNoticeLocatorSchema = z.strictObject({
  regionId: ratingPublicIdSchema.nullable(),
  targetId: ratingPublicIdSchema,
  rootId: ratingPublicIdSchema,
  replyId: ratingPublicIdSchema.nullable(),
});
export const ratingSubscriptionNoticePreviewSchema = z.strictObject({
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
export const ratingSubscriptionNoticeSchema = z.discriminatedUnion('status', [
  z.strictObject({ ...base, status: z.literal('unavailable') }),
  z
    .strictObject({
      ...base,
      status: z.literal('available'),
      domain: z.literal('ratings'),
      kind: z.literal('subscription'),
      activity: z.enum(['root', 'reply']),
      reason: ratingSubscriptionNoticeReasonSchema,
      target: ratingSubscriptionNoticeLocatorSchema,
      preview: ratingSubscriptionNoticePreviewSchema,
    })
    .refine(
      (notice) =>
        (notice.activity === 'root') === (notice.target.replyId === null) &&
        (notice.preview.author.mode !== 'anonymous' ||
          notice.preview.author.targetId === notice.target.targetId),
    ),
]);
const unreadCount = z.number().int().nonnegative().max(2147483647);
export const ratingSubscriptionUpdatesPageSchema = z
  .strictObject({
    items: z.array(ratingSubscriptionNoticeSchema).max(20),
    nextCursor: ratingCursorSchema.nullable(),
    unreadCount,
  })
  .refine(
    (page) =>
      new Set(page.items.map((item) => item.noticeId)).size ===
      page.items.length,
  );
export const ratingSubscriptionUnreadCountSchema = z.strictObject({
  unreadCount,
});
export const ratingSubscriptionNoticeTargetSchema = z.discriminatedUnion(
  'status',
  [
    z.strictObject({
      noticeId: ratingPublicIdSchema,
      status: z.literal('unavailable'),
    }),
    z.strictObject({
      noticeId: ratingPublicIdSchema,
      status: z.literal('available'),
      target: ratingSubscriptionNoticeLocatorSchema,
    }),
  ],
);
export const ratingSubscriptionNoticeReadSchema = z.strictObject({
  noticeId: ratingPublicIdSchema,
  readAt: ratingTimeSchema,
  unreadCount,
});
export type RatingSubscriptionUpdatesQuery = z.infer<
  typeof ratingSubscriptionUpdatesQuerySchema
>;
export type RatingSubscriptionNotice = z.infer<
  typeof ratingSubscriptionNoticeSchema
>;
export type RatingSubscriptionUpdatesPage = z.infer<
  typeof ratingSubscriptionUpdatesPageSchema
>;
export type RatingSubscriptionNoticeTarget = z.infer<
  typeof ratingSubscriptionNoticeTargetSchema
>;
export type RatingSubscriptionNoticeLocator = z.infer<
  typeof ratingSubscriptionNoticeLocatorSchema
>;
export type RatingSubscriptionNoticePreview = z.infer<
  typeof ratingSubscriptionNoticePreviewSchema
>;
