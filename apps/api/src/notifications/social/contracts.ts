import { z } from 'zod';

export const socialCategorySchema = z.enum(['likes', 'saves', 'followers']);
export type SocialCategory = z.infer<typeof socialCategorySchema>;
export const socialIdSchema = z
  .uuid()
  .transform((value) => value.toLowerCase());
const publicId = z.uuid();
const time = z.iso.datetime({ precision: 6 });
const cursor = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^[A-Za-z0-9_-]+$/);
export const socialCategoryQuerySchema = z.strictObject({
  category: socialCategorySchema,
});
export const socialUpdatesQuerySchema = socialCategoryQuerySchema.extend({
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
  cursor: cursor.optional(),
});
export const socialEmptySchema = z.strictObject({});
const communityTarget = z
  .strictObject({
    type: z.literal('community'),
    postId: publicId,
    commentId: publicId.nullable(),
    replyId: publicId.nullable(),
  })
  .refine((value) => value.replyId === null || value.commentId !== null);
const profileTarget = z.strictObject({
  type: z.literal('profile'),
  profileId: publicId,
});
export const socialTargetSchema = z.union([communityTarget, profileTarget]);
const base = { noticeId: publicId, createdAt: time, readAt: time.nullable() };
export const socialNoticeSchema = z.union([
  z.strictObject({ ...base, status: z.literal('unavailable') }),
  z
    .strictObject({
      ...base,
      status: z.literal('available'),
      kind: z.enum(['like', 'save']),
      target: communityTarget,
    })
    .refine(
      (value) =>
        value.kind !== 'save' ||
        (value.target.commentId === null && value.target.replyId === null),
    ),
  z
    .strictObject({
      ...base,
      status: z.literal('available'),
      kind: z.literal('follow'),
      target: profileTarget,
      actor: z.strictObject({
        profileId: publicId,
        displayName: z.string().min(1).max(100),
      }),
    })
    .refine((value) => value.actor.profileId === value.target.profileId),
]);
export const socialUnreadSchema = z.union([
  z.strictObject({
    unreadCount: z.number().int().nonnegative().max(2147483647),
    unreadCountStatus: z.literal('available'),
  }),
  z.strictObject({
    unreadCount: z.null(),
    unreadCountStatus: z.literal('unavailable'),
  }),
]);
export const socialUpdatesPageSchema = z
  .strictObject({
    items: z.array(socialNoticeSchema).max(20),
    nextCursor: cursor.nullable(),
    unreadCount: z.number().int().nonnegative().max(2147483647).nullable(),
    unreadCountStatus: z.enum(['available', 'unavailable']),
  })
  .refine(
    (value) =>
      (value.unreadCountStatus === 'available') ===
        (value.unreadCount !== null) &&
      new Set(value.items.map((item) => item.noticeId)).size ===
        value.items.length,
  );
export const socialNoticeTargetSchema = z.union([
  z.strictObject({ noticeId: publicId, status: z.literal('unavailable') }),
  z.strictObject({
    noticeId: publicId,
    status: z.literal('available'),
    target: socialTargetSchema,
  }),
]);
export const socialNoticeReadSchema = z
  .strictObject({
    noticeId: publicId,
    readAt: time,
    unreadCount: z.number().int().nonnegative().max(2147483647).nullable(),
    unreadCountStatus: z.enum(['available', 'unavailable']),
  })
  .refine(
    (value) =>
      (value.unreadCountStatus === 'available') ===
      (value.unreadCount !== null),
  );
export type SocialUpdatesQuery = z.infer<typeof socialUpdatesQuerySchema>;
export type SocialNotice = z.infer<typeof socialNoticeSchema>;
export type SocialUnread = z.infer<typeof socialUnreadSchema>;
export type SocialUpdatesPage = z.infer<typeof socialUpdatesPageSchema>;
export const socialKind = (category: SocialCategory) =>
  (({ likes: 'like', saves: 'save', followers: 'follow' }) as const)[category];
export const socialCategory = (
  kind: 'like' | 'save' | 'follow',
): SocialCategory =>
  (({ like: 'likes', save: 'saves', follow: 'followers' }) as const)[kind];
