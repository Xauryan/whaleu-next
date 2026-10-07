-- Storage identity for known-owned community like memberships. Existing rows
-- receive opaque IDs, never invented historical event times. No source import.
ALTER TABLE whaleu_community.post_likes
  ADD COLUMN like_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  ADD COLUMN liked_at timestamptz;
ALTER TABLE whaleu_community.comment_likes
  ADD COLUMN like_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  ADD COLUMN liked_at timestamptz;
ALTER TABLE whaleu_community.reply_likes
  ADD COLUMN like_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  ADD COLUMN liked_at timestamptz;

-- Defaults are deliberately installed only after the undated columns exist.
ALTER TABLE whaleu_community.post_likes ALTER COLUMN liked_at SET DEFAULT date_trunc('milliseconds',clock_timestamp());
ALTER TABLE whaleu_community.comment_likes ALTER COLUMN liked_at SET DEFAULT date_trunc('milliseconds',clock_timestamp());
ALTER TABLE whaleu_community.reply_likes ALTER COLUMN liked_at SET DEFAULT date_trunc('milliseconds',clock_timestamp());
ALTER TABLE whaleu_community.post_likes ADD CONSTRAINT post_like_time CHECK(liked_at IS NULL OR (isfinite(liked_at) AND liked_at=date_trunc('milliseconds',liked_at)));
ALTER TABLE whaleu_community.comment_likes ADD CONSTRAINT comment_like_time CHECK(liked_at IS NULL OR (isfinite(liked_at) AND liked_at=date_trunc('milliseconds',liked_at)));
ALTER TABLE whaleu_community.reply_likes ADD CONSTRAINT reply_like_time CHECK(liked_at IS NULL OR (isfinite(liked_at) AND liked_at=date_trunc('milliseconds',liked_at)));

CREATE FUNCTION whaleu_community.protect_like_membership() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.liked_at IS NULL THEN RAISE EXCEPTION 'New like memberships require a known time' USING ERRCODE='23514'; END IF;
  ELSIF NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Like membership identity and time are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER protect_post_like BEFORE INSERT OR UPDATE ON whaleu_community.post_likes FOR EACH ROW EXECUTE FUNCTION whaleu_community.protect_like_membership();
CREATE TRIGGER protect_comment_like BEFORE INSERT OR UPDATE ON whaleu_community.comment_likes FOR EACH ROW EXECUTE FUNCTION whaleu_community.protect_like_membership();
CREATE TRIGGER protect_reply_like BEFORE INSERT OR UPDATE ON whaleu_community.reply_likes FOR EACH ROW EXECUTE FUNCTION whaleu_community.protect_like_membership();
CREATE INDEX post_likes_history ON whaleu_community.post_likes(account_id,liked_at DESC NULLS LAST,like_id DESC);
CREATE INDEX comment_likes_history ON whaleu_community.comment_likes(account_id,liked_at DESC NULLS LAST,like_id DESC);
CREATE INDEX reply_likes_history ON whaleu_community.reply_likes(account_id,liked_at DESC NULLS LAST,like_id DESC);
