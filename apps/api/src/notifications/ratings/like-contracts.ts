import { z } from 'zod';
import {
  ratingPublicIdSchema,
  ratingTimeSchema,
  ratingCursorSchema,
  ratingAuthorSchema,
} from '../../ratings/contracts.js';
import { ratingNoticePreviewSchema } from './contracts.js';

export const ratingLikeNoticeActorSchema = ratingAuthorSchema.options[0];
export const ratingLikeNoticeLocatorSchema = z.strictObject({
  regionId: ratingPublicIdSchema.nullable(),
  targetId: ratingPublicIdSchema,
  rootId: ratingPublicIdSchema,
  replyId: ratingPublicIdSchema.nullable(),
});
export const ratingLikeNoticePreviewSchema = ratingNoticePreviewSchema.pick({
  text: true,
});
const base = {
  noticeId: ratingPublicIdSchema,
  createdAt: ratingTimeSchema,
  readAt: ratingTimeSchema.nullable(),
};
export const ratingLikeNoticeSchema = z.discriminatedUnion('status', [
  z.strictObject({ ...base, status: z.literal('unavailable') }),
  z.strictObject({
    ...base,
    status: z.literal('available'),
    domain: z.literal('ratings'),
    kind: z.literal('like'),
    reason: z.literal('like'),
    actor: ratingLikeNoticeActorSchema,
    target: ratingLikeNoticeLocatorSchema,
    preview: ratingLikeNoticePreviewSchema,
  }),
]);
export const ratingLikeUpdatesPageSchema = z
  .strictObject({
    items: z.array(ratingLikeNoticeSchema).max(20),
    nextCursor: ratingCursorSchema.nullable(),
    unreadCount: z.number().int().nonnegative().max(2147483647),
  })
  .refine(
    (page) =>
      new Set(page.items.map((item) => item.noticeId)).size ===
      page.items.length,
  );
export const ratingLikeNoticeTargetSchema = z.discriminatedUnion('status', [
  z.strictObject({
    noticeId: ratingPublicIdSchema,
    status: z.literal('unavailable'),
  }),
  z.strictObject({
    noticeId: ratingPublicIdSchema,
    status: z.literal('available'),
    target: ratingLikeNoticeLocatorSchema,
  }),
]);
export type RatingLikeNotice = z.infer<typeof ratingLikeNoticeSchema>;
export type RatingLikeUpdatesPage = z.infer<typeof ratingLikeUpdatesPageSchema>;
export type RatingLikeNoticeTarget = z.infer<
  typeof ratingLikeNoticeTargetSchema
>;
export type RatingLikeNoticeLocator = z.infer<
  typeof ratingLikeNoticeLocatorSchema
>;
export interface RatingLikeNoticeRecipient {
  accountId: string;
  reason: 'like';
}
export interface RatingLikeNoticeEvent {
  kind: 'like';
  id: string;
  sequence: string;
  occurredAt: string;
  actorAccountId: string;
  target: RatingLikeNoticeLocator;
  recipients: RatingLikeNoticeRecipient[];
}
