import type { PoolClient } from 'pg';
import { z } from 'zod';

export const feedbackNoticesQuerySchema = z.strictObject({
  cursor: z
    .string()
    .min(1)
    .max(1024)
    .regex(/^[A-Za-z0-9_-]+$/)
    .optional(),
  limit: z
    .string()
    .regex(/^(?:[1-9]|[1-4][0-9]|50)$/)
    .default('20')
    .transform(Number),
});
export const emptyFeedbackNoticeSchema = z.strictObject({});
export const feedbackNoticeIdSchema = z
  .uuid()
  .transform((value) => value.toLowerCase());
const timestamp = z.iso.datetime({ precision: 3 });
const unreadCount = z.number().int().min(0).max(2147483647);
export const feedbackNoticeSchema = z.strictObject({
  noticeId: z.uuid(),
  kind: z.literal('feedback_created'),
  createdAt: timestamp,
  readAt: timestamp.nullable(),
});
export const feedbackNoticesPageSchema = z.strictObject({
  items: z.array(feedbackNoticeSchema).max(50),
  nextCursor: z
    .string()
    .min(1)
    .max(1024)
    .regex(/^[A-Za-z0-9_-]+$/)
    .nullable(),
  unreadCount,
});
export const feedbackNoticesUnreadSchema = z.strictObject({ unreadCount });
export const feedbackNoticeReadSchema = z.strictObject({
  noticeId: z.uuid(),
  readAt: timestamp,
  unreadCount,
});
export const feedbackNoticeTargetSchema = z.discriminatedUnion('status', [
  z.strictObject({ noticeId: z.uuid(), status: z.literal('unavailable') }),
  z.strictObject({
    noticeId: z.uuid(),
    status: z.literal('available'),
    postId: z.uuid(),
  }),
]);
export const feedbackPublicationNoticeSchema = z.strictObject({
  postId: z.uuid(),
  occurredAt: z.date(),
});
export type FeedbackNoticesQuery = z.infer<typeof feedbackNoticesQuerySchema>;
export type FeedbackNoticeView = z.infer<typeof feedbackNoticeSchema>;
export type FeedbackNoticesPage = z.infer<typeof feedbackNoticesPageSchema>;
export type FeedbackNoticeRead = z.infer<typeof feedbackNoticeReadSchema>;
export type FeedbackNoticeTarget = z.infer<typeof feedbackNoticeTargetSchema>;
export type FeedbackPublicationNotice = z.infer<
  typeof feedbackPublicationNoticeSchema
>;

/** Community owns this boundary. It must check exact current post access,
 * Review and feedback category in the caller transaction. It never returns an
 * author, anonymous identity, preview, or a historical access decision. */
export abstract class FeedbackNoticeTargetSource {
  abstract accessible(
    accountId: string,
    postId: string,
    tx: PoolClient,
  ): Promise<boolean>;
}
