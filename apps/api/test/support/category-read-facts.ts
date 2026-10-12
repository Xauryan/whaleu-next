import type { StoredPost } from '../../src/community/community.repository.js';

/** Explicit untouched-category SQL evidence for isolated reader fixtures. This
 * mirrors absence of the overlay, never a production missing-evidence fallback. */
export function untouchedCategoryRows(
  ids: readonly string[],
  posts: ReadonlyMap<string, Pick<StoredPost, 'id' | 'category' | 'space_id'>>,
) {
  return ids.map((postId) => {
    const post = posts.get(postId);
    return {
      postId,
      originalCategory: post?.category ?? null,
      originalSpaceId: post?.space_id ?? null,
      headPostId: null,
      headCategory: null,
      revision: null,
      eventId: null,
      headXmin: null,
      livePostId: null,
      liveCategory: null,
      liveRevision: null,
      liveEventId: null,
      policyId: null,
      reviewId: null,
      validUntil: null,
      batchValidUntil: null,
      batchValidUntilMs: null,
      batchValidUntilMicros: null,
    };
  });
}

export function untouchedCategoryChildRows(
  encoded: string,
  postIds: ReadonlySet<string>,
) {
  const targets = JSON.parse(encoded) as {
    kind: 'comment' | 'reply';
    id: string;
    post_id: string;
  }[];
  return targets
    .filter((target) => postIds.has(target.post_id))
    .map((target) => ({
      kind: target.kind,
      id: target.id,
      postId: target.post_id,
      allowed: true,
      head: null,
      binding: null,
      review: null,
      validUntil: null,
    }));
}
