-- Additive structural navigation indexes only. No body index, model, source
-- rewriting, publication grant, content backfill or semantic-search claim.
CREATE INDEX root_comments_search_chronological
  ON whaleu_community.root_comments(created_at DESC,id DESC)
  INCLUDE (post_id) WHERE deleted_at IS NULL AND visibility='approved';
CREATE INDEX replies_search_chronological
  ON whaleu_community.replies(created_at DESC,id DESC)
  INCLUDE (post_id,root_comment_id) WHERE deleted_at IS NULL AND visibility='approved';
CREATE INDEX replies_search_post_chronological
  ON whaleu_community.replies(post_id,created_at DESC,id DESC)
  INCLUDE (root_comment_id) WHERE deleted_at IS NULL AND visibility='approved';
-- root_comments already has comments_post(post_id,created_at DESC,id DESC).
-- posts already has posts_search_chronological from 0028. Fixed source windows
-- bound authorization work, not physical index entries; measure actual plans.
