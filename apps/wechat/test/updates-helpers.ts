import type {
  CommunityUpdate,
  UpdatesList,
} from '../src/community/updates-contract';
import {
  anonymous,
  commentId,
  createdAt,
  postId,
  requestId,
  replyId,
} from './community-helpers';
export const update = (
  kind: 'root' | 'reply' = 'root',
  noticeId = requestId,
): Extract<CommunityUpdate, { status: 'available' }> => ({
  noticeId,
  createdAt,
  readAt: null,
  status: 'available',
  kind,
  reason: kind === 'root' ? 'saved' : 'direct',
  target: { postId, commentId, replyId: kind === 'reply' ? replyId : null },
  preview: { text: '合成当前更新', images: [], author: anonymous() },
});
export const unavailable = (noticeId = requestId): CommunityUpdate => ({
  noticeId,
  createdAt,
  readAt: null,
  status: 'unavailable',
});
export const updates = (
  items: readonly CommunityUpdate[] = [update()],
  nextCursor: string | null = null,
  unreadCount = items.filter((item) => item.readAt === null).length,
): UpdatesList => ({ items, nextCursor, unreadCount });
