/** Exact managed-worker privilege contract. SQL role custody excludes arbitrary
 * clients. MAINTAIN authorizes existing SHARE table fences without UPDATE rights;
 * the named UPDATE columns are PostgreSQL's minimum for existing row-lock reads.
 * This module provisions nothing and does not claim a raw-DML temporal boundary. */
export const readingTablePrivileges = Object.freeze(
  [
    {
      relation: 'whaleu_campus.community_distribution_generation',
      privilege: 'SELECT',
    },
    {
      relation: 'whaleu_campus.discovery_count_epochs',
      privilege: 'SELECT',
    },
    {
      relation: 'whaleu_campus.operating_regions',
      privilege: 'SELECT',
    },
    {
      relation: 'whaleu_community.comment_images',
      privilege: 'SELECT',
    },
    {
      relation: 'whaleu_community.community_text_sources',
      privilege: 'SELECT',
    },
    {
      relation: 'whaleu_community.content_approval_bindings',
      privilege: 'SELECT',
    },
    {
      relation: 'whaleu_community.content_approval_decisions',
      privilege: 'SELECT',
    },
    {
      relation: 'whaleu_community.content_approval_events',
      privilege: 'SELECT',
    },
    {
      relation: 'whaleu_community.content_approval_heads',
      privilege: 'SELECT',
    },
    {
      relation: 'whaleu_community.content_approval_policies',
      privilege: 'SELECT',
    },
    {
      relation: 'whaleu_community.discovery_count_epochs',
      privilege: 'SELECT',
    },
    {
      relation: 'whaleu_community.formation_members',
      privilege: 'SELECT',
    },
    {
      relation: 'whaleu_community.formations',
      privilege: 'SELECT',
    },
    {
      relation: 'whaleu_community.outbox',
      privilege: 'SELECT',
    },
    {
      relation: 'whaleu_community.poll_options',
      privilege: 'SELECT',
    },
    {
      relation: 'whaleu_community.polls',
      privilege: 'SELECT',
    },
    {
      relation: 'whaleu_community.post_category_heads',
      privilege: 'SELECT',
    },
    {
      relation: 'whaleu_community.post_distribution_bindings',
      privilege: 'SELECT',
    },
    {
      relation: 'whaleu_community.post_images',
      privilege: 'SELECT',
    },
    {
      relation: 'whaleu_community.post_owner_visibility',
      privilege: 'SELECT',
    },
    {
      relation: 'whaleu_community.post_rating_target_links',
      privilege: 'SELECT',
    },
    {
      relation: 'whaleu_community.posts',
      privilege: 'SELECT',
    },
    {
      relation: 'whaleu_community.publication_cancel_fences',
      privilege: 'SELECT',
    },
    {
      relation: 'whaleu_community.publication_requests',
      privilege: 'SELECT',
    },
    {
      relation: 'whaleu_community.reading_format_heads',
      privilege: 'SELECT',
    },
    {
      relation: 'whaleu_community.reading_format_jobs',
      privilege: 'SELECT',
    },
    {
      relation: 'whaleu_community.reading_format_results',
      privilege: 'SELECT',
    },
    {
      relation: 'whaleu_community.reading_format_slots',
      privilege: 'SELECT',
    },
    {
      relation: 'whaleu_community.related_sync_actor_generation',
      privilege: 'SELECT',
    },
    {
      relation: 'whaleu_community.related_sync_admission_generation',
      privilege: 'SELECT',
    },
    {
      relation: 'whaleu_community.related_sync_view_generation',
      privilege: 'SELECT',
    },
    {
      relation: 'whaleu_community.replies',
      privilege: 'SELECT',
    },
    {
      relation: 'whaleu_community.reply_images',
      privilege: 'SELECT',
    },
    {
      relation: 'whaleu_community.report_origins',
      privilege: 'SELECT',
    },
    {
      relation: 'whaleu_community.root_comments',
      privilege: 'SELECT',
    },
    {
      relation: 'whaleu_community.spaces',
      privilege: 'SELECT',
    },
    {
      relation: 'whaleu_community.trading_listings',
      privilege: 'SELECT',
    },
    {
      relation: 'whaleu_identity.accounts',
      privilege: 'SELECT',
    },
    {
      relation: 'whaleu_media.asset_safety_events',
      privilege: 'SELECT',
    },
    {
      relation: 'whaleu_media.asset_safety_heads',
      privilege: 'SELECT',
    },
    {
      relation: 'whaleu_media.assets',
      privilege: 'SELECT',
    },
    {
      relation: 'whaleu_media.bindings',
      privilege: 'SELECT',
    },
    {
      relation: 'whaleu_media.cleanup_obligations',
      privilege: 'SELECT',
    },
    {
      relation: 'whaleu_media.derived_object_attempts',
      privilege: 'SELECT',
    },
    {
      relation: 'whaleu_media.jobs',
      privilege: 'SELECT',
    },
    {
      relation: 'whaleu_media.media_owner_states',
      privilege: 'SELECT',
    },
    {
      relation: 'whaleu_media.object_attempts',
      privilege: 'SELECT',
    },
    {
      relation: 'whaleu_media.profile_cover_request_markers',
      privilege: 'SELECT',
    },
    {
      relation: 'whaleu_media.profile_request_markers',
      privilege: 'SELECT',
    },
    {
      relation: 'whaleu_media.publication_batch_commands',
      privilege: 'SELECT',
    },
    {
      relation: 'whaleu_media.publication_batch_members',
      privilege: 'SELECT',
    },
    {
      relation: 'whaleu_media.publication_batches',
      privilege: 'SELECT',
    },
    {
      relation: 'whaleu_media.quota_reservations',
      privilege: 'SELECT',
    },
    {
      relation: 'whaleu_media.ratings_discussion_batch_request_fences',
      privilege: 'SELECT',
    },
    {
      relation: 'whaleu_media.ratings_discussion_batches',
      privilege: 'SELECT',
    },
    {
      relation: 'whaleu_media.ratings_discussion_members',
      privilege: 'SELECT',
    },
    {
      relation: 'whaleu_media.ratings_discussion_request_markers',
      privilege: 'SELECT',
    },
    {
      relation: 'whaleu_media.ratings_request_markers',
      privilege: 'SELECT',
    },
    {
      relation: 'whaleu_media.scope_consumptions',
      privilege: 'SELECT',
    },
    {
      relation: 'whaleu_media.upload_ingress',
      privilege: 'SELECT',
    },
    {
      relation: 'whaleu_media.upload_ingress_writers',
      privilege: 'SELECT',
    },
    {
      relation: 'whaleu_media.upload_intents',
      privilege: 'SELECT',
    },
    {
      relation: 'whaleu_media.upload_request_fences',
      privilege: 'SELECT',
    },
    {
      relation: 'whaleu_media.variants',
      privilege: 'SELECT',
    },
    {
      relation: 'whaleu_safety.account_punishment_heads',
      privilege: 'SELECT',
    },
    {
      relation: 'whaleu_safety.account_punishment_terminals',
      privilege: 'SELECT',
    },
    {
      relation: 'whaleu_safety.account_punishments',
      privilege: 'SELECT',
    },
    {
      relation: 'whaleu_campus.community_distribution_generation',
      privilege: 'MAINTAIN',
    },
    {
      relation: 'whaleu_campus.discovery_count_epochs',
      privilege: 'MAINTAIN',
    },
    {
      relation: 'whaleu_campus.operating_regions',
      privilege: 'MAINTAIN',
    },
    {
      relation: 'whaleu_community.comment_images',
      privilege: 'MAINTAIN',
    },
    {
      relation: 'whaleu_community.community_text_sources',
      privilege: 'MAINTAIN',
    },
    {
      relation: 'whaleu_community.content_approval_bindings',
      privilege: 'MAINTAIN',
    },
    {
      relation: 'whaleu_community.content_approval_decisions',
      privilege: 'MAINTAIN',
    },
    {
      relation: 'whaleu_community.content_approval_events',
      privilege: 'MAINTAIN',
    },
    {
      relation: 'whaleu_community.content_approval_heads',
      privilege: 'MAINTAIN',
    },
    {
      relation: 'whaleu_community.content_approval_policies',
      privilege: 'MAINTAIN',
    },
    {
      relation: 'whaleu_community.formation_members',
      privilege: 'MAINTAIN',
    },
    {
      relation: 'whaleu_community.formations',
      privilege: 'MAINTAIN',
    },
    {
      relation: 'whaleu_community.outbox',
      privilege: 'MAINTAIN',
    },
    {
      relation: 'whaleu_community.poll_options',
      privilege: 'MAINTAIN',
    },
    {
      relation: 'whaleu_community.polls',
      privilege: 'MAINTAIN',
    },
    {
      relation: 'whaleu_community.post_category_heads',
      privilege: 'MAINTAIN',
    },
    {
      relation: 'whaleu_community.post_distribution_bindings',
      privilege: 'MAINTAIN',
    },
    {
      relation: 'whaleu_community.post_images',
      privilege: 'MAINTAIN',
    },
    {
      relation: 'whaleu_community.post_owner_visibility',
      privilege: 'MAINTAIN',
    },
    {
      relation: 'whaleu_community.post_rating_target_links',
      privilege: 'MAINTAIN',
    },
    {
      relation: 'whaleu_community.posts',
      privilege: 'MAINTAIN',
    },
    {
      relation: 'whaleu_community.publication_cancel_fences',
      privilege: 'MAINTAIN',
    },
    {
      relation: 'whaleu_community.publication_requests',
      privilege: 'MAINTAIN',
    },
    {
      relation: 'whaleu_community.reading_format_heads',
      privilege: 'MAINTAIN',
    },
    {
      relation: 'whaleu_community.reading_format_jobs',
      privilege: 'MAINTAIN',
    },
    {
      relation: 'whaleu_community.reading_format_results',
      privilege: 'MAINTAIN',
    },
    {
      relation: 'whaleu_community.reading_format_slots',
      privilege: 'MAINTAIN',
    },
    {
      relation: 'whaleu_community.related_sync_actor_generation',
      privilege: 'MAINTAIN',
    },
    {
      relation: 'whaleu_community.related_sync_admission_generation',
      privilege: 'MAINTAIN',
    },
    {
      relation: 'whaleu_community.related_sync_view_generation',
      privilege: 'MAINTAIN',
    },
    {
      relation: 'whaleu_community.replies',
      privilege: 'MAINTAIN',
    },
    {
      relation: 'whaleu_community.reply_images',
      privilege: 'MAINTAIN',
    },
    {
      relation: 'whaleu_community.report_origins',
      privilege: 'MAINTAIN',
    },
    {
      relation: 'whaleu_community.root_comments',
      privilege: 'MAINTAIN',
    },
    {
      relation: 'whaleu_community.spaces',
      privilege: 'MAINTAIN',
    },
    {
      relation: 'whaleu_community.trading_listings',
      privilege: 'MAINTAIN',
    },
    {
      relation: 'whaleu_identity.accounts',
      privilege: 'MAINTAIN',
    },
    {
      relation: 'whaleu_media.asset_safety_events',
      privilege: 'MAINTAIN',
    },
    {
      relation: 'whaleu_media.asset_safety_heads',
      privilege: 'MAINTAIN',
    },
    {
      relation: 'whaleu_media.assets',
      privilege: 'MAINTAIN',
    },
    {
      relation: 'whaleu_media.bindings',
      privilege: 'MAINTAIN',
    },
    {
      relation: 'whaleu_media.cleanup_obligations',
      privilege: 'MAINTAIN',
    },
    {
      relation: 'whaleu_media.derived_object_attempts',
      privilege: 'MAINTAIN',
    },
    {
      relation: 'whaleu_media.jobs',
      privilege: 'MAINTAIN',
    },
    {
      relation: 'whaleu_media.media_owner_states',
      privilege: 'MAINTAIN',
    },
    {
      relation: 'whaleu_media.object_attempts',
      privilege: 'MAINTAIN',
    },
    {
      relation: 'whaleu_media.profile_cover_request_markers',
      privilege: 'MAINTAIN',
    },
    {
      relation: 'whaleu_media.profile_request_markers',
      privilege: 'MAINTAIN',
    },
    {
      relation: 'whaleu_media.publication_batch_commands',
      privilege: 'MAINTAIN',
    },
    {
      relation: 'whaleu_media.publication_batch_members',
      privilege: 'MAINTAIN',
    },
    {
      relation: 'whaleu_media.publication_batches',
      privilege: 'MAINTAIN',
    },
    {
      relation: 'whaleu_media.quota_reservations',
      privilege: 'MAINTAIN',
    },
    {
      relation: 'whaleu_media.ratings_discussion_batch_request_fences',
      privilege: 'MAINTAIN',
    },
    {
      relation: 'whaleu_media.ratings_discussion_batches',
      privilege: 'MAINTAIN',
    },
    {
      relation: 'whaleu_media.ratings_discussion_members',
      privilege: 'MAINTAIN',
    },
    {
      relation: 'whaleu_media.ratings_discussion_request_markers',
      privilege: 'MAINTAIN',
    },
    {
      relation: 'whaleu_media.ratings_request_markers',
      privilege: 'MAINTAIN',
    },
    {
      relation: 'whaleu_media.scope_consumptions',
      privilege: 'MAINTAIN',
    },
    {
      relation: 'whaleu_media.upload_ingress',
      privilege: 'MAINTAIN',
    },
    {
      relation: 'whaleu_media.upload_ingress_writers',
      privilege: 'MAINTAIN',
    },
    {
      relation: 'whaleu_media.upload_intents',
      privilege: 'MAINTAIN',
    },
    {
      relation: 'whaleu_media.upload_request_fences',
      privilege: 'MAINTAIN',
    },
    {
      relation: 'whaleu_media.variants',
      privilege: 'MAINTAIN',
    },
    {
      relation: 'whaleu_safety.account_punishment_heads',
      privilege: 'MAINTAIN',
    },
    {
      relation: 'whaleu_safety.account_punishment_terminals',
      privilege: 'MAINTAIN',
    },
    {
      relation: 'whaleu_safety.account_punishments',
      privilege: 'MAINTAIN',
    },
    {
      relation: 'whaleu_community.reading_format_jobs',
      privilege: 'UPDATE',
    },
    {
      relation: 'whaleu_community.reading_format_slots',
      privilege: 'UPDATE',
    },
    {
      relation: 'whaleu_community.reading_format_results',
      privilege: 'INSERT',
    },
  ].map((value) => Object.freeze(value)),
);
export const readingColumnPrivileges = Object.freeze(
  [
    {
      relation: 'whaleu_campus.operating_regions',
      column: 'id',
      privilege: 'UPDATE',
    },
    {
      relation: 'whaleu_community.comment_images',
      column: 'comment_id',
      privilege: 'UPDATE',
    },
    {
      relation: 'whaleu_community.community_text_sources',
      column: 'content_id',
      privilege: 'UPDATE',
    },
    {
      relation: 'whaleu_community.content_approval_bindings',
      column: 'content_id',
      privilege: 'UPDATE',
    },
    {
      relation: 'whaleu_community.content_approval_heads',
      column: 'decision_id',
      privilege: 'UPDATE',
    },
    {
      relation: 'whaleu_community.formation_members',
      column: 'id',
      privilege: 'UPDATE',
    },
    {
      relation: 'whaleu_community.formations',
      column: 'id',
      privilege: 'UPDATE',
    },
    {
      relation: 'whaleu_community.poll_options',
      column: 'poll_id',
      privilege: 'UPDATE',
    },
    {
      relation: 'whaleu_community.polls',
      column: 'id',
      privilege: 'UPDATE',
    },
    {
      relation: 'whaleu_community.post_images',
      column: 'post_id',
      privilege: 'UPDATE',
    },
    {
      relation: 'whaleu_community.posts',
      column: 'id',
      privilege: 'UPDATE',
    },
    {
      relation: 'whaleu_community.reading_format_heads',
      column: 'content_id',
      privilege: 'UPDATE',
    },
    {
      relation: 'whaleu_community.replies',
      column: 'id',
      privilege: 'UPDATE',
    },
    {
      relation: 'whaleu_community.reply_images',
      column: 'reply_id',
      privilege: 'UPDATE',
    },
    {
      relation: 'whaleu_community.root_comments',
      column: 'id',
      privilege: 'UPDATE',
    },
    {
      relation: 'whaleu_community.spaces',
      column: 'id',
      privilege: 'UPDATE',
    },
    {
      relation: 'whaleu_community.trading_listings',
      column: 'post_id',
      privilege: 'UPDATE',
    },
    {
      relation: 'whaleu_identity.accounts',
      column: 'id',
      privilege: 'UPDATE',
    },
    {
      relation: 'whaleu_media.asset_safety_heads',
      column: 'asset_id',
      privilege: 'UPDATE',
    },
    {
      relation: 'whaleu_media.assets',
      column: 'id',
      privilege: 'UPDATE',
    },
    {
      relation: 'whaleu_media.bindings',
      column: 'id',
      privilege: 'UPDATE',
    },
    {
      relation: 'whaleu_media.publication_batches',
      column: 'id',
      privilege: 'UPDATE',
    },
    {
      relation: 'whaleu_media.ratings_discussion_batches',
      column: 'id',
      privilege: 'UPDATE',
    },
    {
      relation: 'whaleu_media.upload_intents',
      column: 'id',
      privilege: 'UPDATE',
    },
  ].map((value) => Object.freeze(value)),
);
