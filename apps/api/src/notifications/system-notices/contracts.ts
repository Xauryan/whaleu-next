import { z } from 'zod';

export const systemNoticesQuerySchema = z.strictObject({
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
export const emptySystemNoticeSchema = z.strictObject({});
export const systemNoticeIdSchema = z.uuid();
export type SystemNoticesQuery = z.infer<typeof systemNoticesQuerySchema>;

const noticeFields = {
  noticeId: z.uuid(),
  createdAt: z.iso.datetime({ precision: 3 }),
  readAt: z.iso.datetime({ precision: 3 }).nullable(),
};
export const postJuryRemovalNoticeViewSchema = z
  .strictObject({
    ...noticeFields,
    kind: z.literal('post_jury_removed'),
    keepVotes: z.number().int().min(0).max(5),
    removeVotes: z.number().int().min(1).max(6),
  })
  .refine(
    (notice) =>
      notice.removeVotes > notice.keepVotes &&
      notice.keepVotes + notice.removeVotes <= 11,
  );
export const profileNicknameResetNoticeViewSchema = z.strictObject({
  ...noticeFields,
  kind: z.literal('profile_nickname_reset'),
  nickname: z.string().regex(/^违规昵称[A-Za-z0-9]{6}$/),
});
export const profileCustomAvatarClearedNoticeViewSchema = z.strictObject({
  ...noticeFields,
  kind: z.literal('profile_custom_avatar_cleared'),
});
export const adminPostRemovedNoticeViewSchema = z.strictObject({
  ...noticeFields,
  kind: z.literal('admin_post_removed'),
});
export const systemNoticeViewSchema = z.discriminatedUnion('kind', [
  postJuryRemovalNoticeViewSchema,
  profileNicknameResetNoticeViewSchema,
  profileCustomAvatarClearedNoticeViewSchema,
  adminPostRemovedNoticeViewSchema,
]);
export const systemNoticesUnreadSchema = z.strictObject({
  unreadCount: z.number().int().min(0).max(2147483647),
});
export const systemNoticesPageSchema = z.strictObject({
  items: z.array(systemNoticeViewSchema).max(50),
  nextCursor: z
    .string()
    .min(1)
    .max(1024)
    .regex(/^[A-Za-z0-9_-]+$/)
    .nullable(),
  unreadCount: systemNoticesUnreadSchema.shape.unreadCount,
});
export const systemNoticeReadSchema = z.strictObject({
  noticeId: noticeFields.noticeId,
  readAt: z.iso.datetime({ precision: 3 }),
  unreadCount: systemNoticesUnreadSchema.shape.unreadCount,
});
export type PostJuryRemovalNoticeView = z.infer<
  typeof postJuryRemovalNoticeViewSchema
>;
export type ProfileNicknameResetNoticeView = z.infer<
  typeof profileNicknameResetNoticeViewSchema
>;
export type ProfileCustomAvatarClearedNoticeView = z.infer<
  typeof profileCustomAvatarClearedNoticeViewSchema
>;
export type SystemNoticeView = z.infer<typeof systemNoticeViewSchema>;
export type SystemNoticeKind = SystemNoticeView['kind'];
export type SystemNoticesPage = z.infer<typeof systemNoticesPageSchema>;
export interface PostJuryRemovalNotice {
  decisionId: string;
  ownerAccountId: string;
  keepVotes: number;
  removeVotes: number;
  occurredAt: Date;
}
export const postJuryRemovalNoticeSchema = z
  .strictObject({
    decisionId: z.uuid(),
    ownerAccountId: z.uuid(),
    keepVotes: z.number().int().min(0).max(5),
    removeVotes: z.number().int().min(1).max(6),
    occurredAt: z.date(),
  })
  .refine(
    (notice) =>
      notice.removeVotes > notice.keepVotes &&
      notice.keepVotes + notice.removeVotes <= 11,
  );
