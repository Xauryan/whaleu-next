import { z } from 'zod';
import type { AuthorView, MediaView } from '../contracts.js';

export const likedPageQuerySchema = z.strictObject({
  limit: z
    .string()
    .regex(/^(?:[1-9]|[1-4][0-9]|50)$/)
    .optional()
    .transform((value) => (value === undefined ? 20 : Number(value))),
  cursor: z
    .string()
    .min(1)
    .max(1024)
    .regex(/^[A-Za-z0-9_-]+$/)
    .optional(),
});
export const emptyLikedBodySchema = z.strictObject({}).optional();
export type LikedPageQuery = z.infer<typeof likedPageQuerySchema>;
export type LikedKind = 'post' | 'comment' | 'reply';
export interface LikedItem {
  kind: LikedKind;
  targetId: string;
  postId: string;
  rootCommentId: string | null;
  /** Null means the date of this existing membership is not known. */
  likedAt: string | null;
  /** Opaque storage-record identity, not proof of a historical event date. */
  likeId: string;
  preview: {
    text: string;
    images: MediaView[];
    author: AuthorView;
    createdAt: string;
    isSelf: boolean;
  };
}
export interface LikedPage {
  items: LikedItem[];
  visibleLikedCount: number;
  nextCursor: string | null;
}
