import type { PoolClient } from 'pg';

/** Final-only bounded fallback. All locks are acquired NOWAIT after every
 * mandatory source/deferred wait; following snapshot reads never row-lock. */
export async function fenceSmallCommunityCount(tx: PoolClient): Promise<void> {
  await tx.query(`LOCK TABLE
    whaleu_community.comment_images,
    whaleu_community.comment_likes,
    whaleu_community.content_approval_bindings,
    whaleu_community.content_approval_decisions,
    whaleu_community.content_approval_events,
    whaleu_community.content_approval_heads,
    whaleu_community.content_approval_policies,
    whaleu_community.formation_members,
    whaleu_community.formations,
    whaleu_community.poll_options,
    whaleu_community.polls,
    whaleu_community.post_images,
    whaleu_community.post_likes,
    whaleu_community.posts,
    whaleu_community.replies,
    whaleu_community.reply_images,
    whaleu_community.reply_likes,
    whaleu_community.root_comments,
    whaleu_community.spaces,
    whaleu_community.trading_listings
    IN SHARE MODE NOWAIT`);
}
