/** Optional exact counts never become a fabricated zero during local mutation. */
export interface DiscussionCounts {
  readonly commentCount: number | null;
  readonly replyCount: number | null;
  readonly discussionCount: number | null;
}
export function countsAfterRootDeletion(
  counts: DiscussionCounts,
  deletedReplies: number | null | undefined,
): DiscussionCounts {
  const unknown = {
    commentCount: null,
    replyCount: null,
    discussionCount: null,
  };
  if (
    counts.commentCount === null ||
    counts.replyCount === null ||
    counts.discussionCount === null ||
    deletedReplies === null ||
    deletedReplies === undefined ||
    !Number.isSafeInteger(deletedReplies) ||
    deletedReplies < 0 ||
    counts.commentCount < 1 ||
    counts.replyCount < deletedReplies ||
    counts.discussionCount !== counts.commentCount + counts.replyCount
  )
    return unknown;
  return {
    commentCount: counts.commentCount - 1,
    replyCount: counts.replyCount - deletedReplies,
    discussionCount: counts.discussionCount - 1 - deletedReplies,
  };
}
