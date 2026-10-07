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

export interface SystemNoticeView {
  noticeId: string;
  kind: 'post_jury_removed';
  createdAt: string;
  readAt: string | null;
  keepVotes: number;
  removeVotes: number;
}
export interface SystemNoticesPage {
  items: SystemNoticeView[];
  nextCursor: string | null;
  unreadCount: number;
}
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
