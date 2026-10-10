-- Community owns descendant enumeration. Media continues to own exact-object
-- cleanup and authoritative physical-absence evidence. This queue records only
-- successful enumeration/detachment, never physical deletion.
SET LOCAL lock_timeout='5s';
SELECT pg_advisory_xact_lock(hashtextextended('whaleu:named-block-policy:v1',0));

CREATE TABLE whaleu_community.media_cleanup_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 resource_kind text NOT NULL CHECK(resource_kind IN ('post','comment','reply')),
 resource_id uuid NOT NULL,
 post_id uuid NOT NULL REFERENCES whaleu_community.posts(id),
 root_comment_id uuid,
 source_deleted_at timestamptz NOT NULL,
 phase text NOT NULL DEFAULT 'self' CHECK(phase IN ('self','comments','replies','complete')),
 cursor_id uuid,
 detached_targets bigint NOT NULL DEFAULT 0 CHECK(detached_targets>=0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(created_at)),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(updated_at)),
 enumeration_completed_at timestamptz CHECK(isfinite(enumeration_completed_at)),
 FOREIGN KEY(root_comment_id,post_id) REFERENCES whaleu_community.root_comments(id,post_id),
 UNIQUE(resource_kind,resource_id,source_deleted_at),
 CHECK((resource_kind='post' AND resource_id=post_id AND root_comment_id IS NULL)
    OR (resource_kind='comment' AND root_comment_id IS NOT NULL AND resource_id=root_comment_id)
    OR (resource_kind='reply' AND root_comment_id IS NOT NULL)),
 CHECK(phase<>'comments' OR resource_kind='post'),
 CHECK(phase<>'replies' OR resource_kind IN ('post','comment')),
 CHECK(phase NOT IN ('self','complete') OR cursor_id IS NULL),
 CHECK((phase='complete')=(enumeration_completed_at IS NOT NULL))
);
CREATE INDEX community_media_cleanup_pending ON whaleu_community.media_cleanup_jobs(updated_at,id)
 WHERE enumeration_completed_at IS NULL;
-- UUID keysets also cover tombstones. No deleted/visible filter may omit a
-- descendant, and page cost must not grow with already-enumerated children.
CREATE INDEX community_media_cleanup_comments ON whaleu_community.root_comments(post_id,id);
CREATE INDEX community_media_cleanup_post_replies ON whaleu_community.replies(post_id,id);
CREATE INDEX community_media_cleanup_root_replies ON whaleu_community.replies(root_comment_id,id);

CREATE FUNCTION whaleu_community.media_cleanup_job_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR TG_OP='TRUNCATE' THEN
  RAISE EXCEPTION 'Community media cleanup history is retained' USING ERRCODE='23514';
 END IF;
 IF (NEW.id,NEW.resource_kind,NEW.resource_id,NEW.post_id,NEW.root_comment_id,NEW.source_deleted_at,NEW.created_at)
   IS DISTINCT FROM (OLD.id,OLD.resource_kind,OLD.resource_id,OLD.post_id,OLD.root_comment_id,OLD.source_deleted_at,OLD.created_at)
   OR OLD.phase='complete' OR NEW.detached_targets<OLD.detached_targets
   OR NEW.detached_targets>OLD.detached_targets+16 THEN
  RAISE EXCEPTION 'Invalid Community media cleanup transition' USING ERRCODE='23514';
 END IF;
 IF NEW.phase=OLD.phase THEN
  IF OLD.phase='self' OR NEW.cursor_id IS NULL
    OR (OLD.cursor_id IS NOT NULL AND NEW.cursor_id<=OLD.cursor_id) THEN
   RAISE EXCEPTION 'Community media cleanup cursor must advance' USING ERRCODE='23514';
  END IF;
 ELSIF NOT ((OLD.phase='self' AND NEW.phase=CASE OLD.resource_kind WHEN 'post' THEN 'comments' WHEN 'comment' THEN 'replies' ELSE 'complete' END)
   OR (OLD.phase='comments' AND NEW.phase='replies')
   OR (OLD.phase='replies' AND NEW.phase='complete')) OR NEW.cursor_id IS NOT NULL THEN
  RAISE EXCEPTION 'Community media cleanup phases cannot be skipped' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER community_media_cleanup_job_guard BEFORE UPDATE OR DELETE ON whaleu_community.media_cleanup_jobs
 FOR EACH ROW EXECUTE FUNCTION whaleu_community.media_cleanup_job_guard();
CREATE TRIGGER community_media_cleanup_job_retain BEFORE TRUNCATE ON whaleu_community.media_cleanup_jobs
 FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.media_cleanup_job_guard();

CREATE FUNCTION whaleu_community.capture_media_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE kind text; parent_post uuid; parent_root uuid;
BEGIN
 IF OLD.deleted_at IS NOT NULL OR NEW.deleted_at IS NULL THEN RETURN NULL; END IF;
 IF TG_TABLE_NAME='posts' THEN
  kind:='post'; parent_post:=NEW.id; parent_root:=NULL;
 ELSIF TG_TABLE_NAME='root_comments' THEN
  kind:='comment'; parent_post:=NEW.post_id; parent_root:=NEW.id;
 ELSE
  kind:='reply'; parent_post:=NEW.post_id; parent_root:=NEW.root_comment_id;
 END IF;
 -- Exactly one row, in the same transaction as the tombstone and its original
 -- outbox event. This hook covers owner deletion and moderation alike.
 INSERT INTO whaleu_community.media_cleanup_jobs(resource_kind,resource_id,post_id,root_comment_id,source_deleted_at)
 VALUES(kind,NEW.id,parent_post,parent_root,NEW.deleted_at)
 ON CONFLICT(resource_kind,resource_id,source_deleted_at) DO NOTHING;
 RETURN NULL;
END $$;
CREATE TRIGGER community_media_cleanup_capture AFTER UPDATE OF deleted_at ON whaleu_community.posts
 FOR EACH ROW EXECUTE FUNCTION whaleu_community.capture_media_cleanup();
CREATE TRIGGER community_media_cleanup_capture AFTER UPDATE OF deleted_at ON whaleu_community.root_comments
 FOR EACH ROW EXECUTE FUNCTION whaleu_community.capture_media_cleanup();
CREATE TRIGGER community_media_cleanup_capture AFTER UPDATE OF deleted_at ON whaleu_community.replies
 FOR EACH ROW EXECUTE FUNCTION whaleu_community.capture_media_cleanup();

-- Upgrade existing local tombstones into pending work too. This does not claim
-- historical cleanup succeeded, rewrite content, or activate any provider.
INSERT INTO whaleu_community.media_cleanup_jobs(resource_kind,resource_id,post_id,root_comment_id,source_deleted_at)
 SELECT 'post',id,id,NULL,deleted_at FROM whaleu_community.posts WHERE deleted_at IS NOT NULL;
INSERT INTO whaleu_community.media_cleanup_jobs(resource_kind,resource_id,post_id,root_comment_id,source_deleted_at)
 SELECT 'comment',id,post_id,id,deleted_at FROM whaleu_community.root_comments WHERE deleted_at IS NOT NULL;
INSERT INTO whaleu_community.media_cleanup_jobs(resource_kind,resource_id,post_id,root_comment_id,source_deleted_at)
 SELECT 'reply',id,post_id,root_comment_id,deleted_at FROM whaleu_community.replies WHERE deleted_at IS NOT NULL;
REVOKE ALL ON whaleu_community.media_cleanup_jobs FROM PUBLIC;
