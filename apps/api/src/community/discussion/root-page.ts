import { createHash } from 'node:crypto';
import type { CommentsQuery } from './contracts.js';

/** Root traversal depends on eligibility and ordering, never off-page replies. */
export interface RootOrderFacts {
  readonly id: string;
  readonly createdAt: string;
  readonly likeCount: number;
  readonly isPinned: boolean;
}

export function orderDiscussionRoots<T extends RootOrderFacts>(
  roots: readonly T[],
  query: Pick<CommentsQuery, 'sort' | 'order'>,
): T[] {
  return [...roots].sort((a, b) => {
    if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
    if (query.sort === 'likes' && a.likeCount !== b.likeCount)
      return (a.likeCount - b.likeCount) * (query.order === 'asc' ? 1 : -1);
    const direction = query.sort === 'likes' || query.order === 'desc' ? -1 : 1;
    return (
      (a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)) *
      direction
    );
  });
}

export function discussionRootSnapshot(
  ordered: readonly RootOrderFacts[],
  sort: CommentsQuery['sort'],
): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        ordered.map((root) => [
          root.id,
          root.createdAt,
          root.isPinned,
          ...(sort === 'likes' ? [root.likeCount] : []),
        ]),
      ),
    )
    .digest('hex');
}
