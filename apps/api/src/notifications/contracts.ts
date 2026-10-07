import { z } from 'zod';
import type { AuthorView, MediaView } from '../community/contracts.js';
export const updatesQuerySchema = z.strictObject({
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
export const emptyUpdatesSchema = z.strictObject({});
export type UpdatesQuery = z.infer<typeof updatesQuerySchema>;
export interface UpdateTarget {
  postId: string;
  commentId: string;
  replyId: string | null;
}
export interface UpdatePreview {
  text: string;
  images: MediaView[];
  author: AuthorView;
}
export interface NoticeBase {
  noticeId: string;
  createdAt: string;
  readAt: string | null;
}
export type NoticeView = NoticeBase &
  (
    | { status: 'unavailable' }
    | {
        status: 'available';
        kind: 'root' | 'reply';
        reason: 'direct' | 'saved';
        target: UpdateTarget;
        preview: UpdatePreview;
      }
  );
export interface UpdatesPage {
  items: NoticeView[];
  nextCursor: string | null;
  unreadCount: number;
}
