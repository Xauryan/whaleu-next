import type { Post } from '../../community/contract';

/**
 * Keep the server's order deterministic without guessing image dimensions or
 * synthesizing content. Pin de-duplication and exposure accounting happen before
 * this presentation-only split. Existing posts retain their object identity.
 */
export function splitFeedColumns(posts: readonly Post[]): [Post[], Post[]] {
  const columns: [Post[], Post[]] = [[], []];
  posts.forEach((post, index) => columns[index % 2]!.push(post));
  return columns;
}
