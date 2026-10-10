-- Logical owner deletion is immediate. Media enumeration has independent durable
-- cursors, including descendants that are hidden, historical, or already deleted.
SET LOCAL lock_timeout='5s';
SELECT pg_advisory_xact_lock(hashtextextended('whaleu:named-block-policy:v1',0));
CREATE TABLE whaleu_ratings.discussion_media_cleanup(
 owner_kind text NOT NULL CHECK(owner_kind IN ('target','root','reply')),owner_id uuid NOT NULL,
 after_kind text,after_id uuid,phase text NOT NULL DEFAULT 'pending' CHECK(phase IN ('pending','complete')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),completed_at timestamptz,
 PRIMARY KEY(owner_kind,owner_id),CHECK((after_kind IS NULL)=(after_id IS NULL)),CHECK(after_kind IS NULL OR after_kind IN ('rating_comment','rating_reply')),
 CHECK((phase='complete')=(completed_at IS NOT NULL))
);
CREATE TABLE whaleu_ratings.discussion_media_tombstones(
 resource_kind text NOT NULL CHECK(resource_kind IN ('rating_comment','rating_reply')),resource_id uuid NOT NULL,
 target_id uuid NOT NULL,root_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(resource_kind,resource_id)
);
CREATE FUNCTION whaleu_ratings.discussion_media_cleanup_owner_current(kind text,id uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT CASE kind WHEN 'target' THEN EXISTS(SELECT 1 FROM whaleu_ratings.target_owner_tombstones WHERE target_id=id)
 WHEN 'root' THEN EXISTS(SELECT 1 FROM whaleu_ratings.comments WHERE comments.id=discussion_media_cleanup_owner_current.id AND deleted_at IS NOT NULL)
 WHEN 'reply' THEN EXISTS(SELECT 1 FROM whaleu_ratings.replies WHERE replies.id=discussion_media_cleanup_owner_current.id AND deleted_at IS NOT NULL)
 ELSE false END
$$;
-- Only an immutable, actually published Media7 appearance creates a cleanup
-- obligation. Text-only Review7 and all legacy text publications stay outside
-- this slice. Detached bindings remain historical evidence of an appearance.
CREATE VIEW whaleu_ratings.discussion_media_cleanup_appearances AS
 SELECT CASE b.kind WHEN 'comment' THEN 'rating_comment' ELSE 'rating_reply' END::text resource_kind,
 b.subject_id resource_id,(b.envelope->>'targetId')::uuid target_id,
 CASE b.kind WHEN 'comment' THEN b.subject_id ELSE (b.envelope->>'rootId')::uuid END root_id
 FROM whaleu_community.rating_discussion_media_bindings b
 WHERE jsonb_array_length(b.envelope->'images')>0 AND NOT EXISTS(
  SELECT 1 FROM jsonb_array_elements(b.envelope->'images') image WHERE NOT EXISTS(
   SELECT 1 FROM whaleu_media.bindings m WHERE m.owner_kind='ratings'
    AND m.resource_kind=CASE b.kind WHEN 'comment' THEN 'rating_comment' ELSE 'rating_reply' END
    AND m.resource_id=b.subject_id AND m.content_version=1 AND m.slot='images'
    AND m.ordinal=(image->>'ordinal')::integer AND m.asset_id=(image->>'assetId')::uuid
    AND m.manifest_digest=image->>'manifestDigest' AND m.attach_evidence->'version'='7'::jsonb
    AND m.attach_evidence->>'batchId'=b.envelope->>'batchId'
    AND m.attach_evidence->>'sealedPlanDigest'=b.envelope->>'sealedPlanDigest'
    AND m.attach_evidence->>'memberId'=image->>'memberId'));
CREATE INDEX discussion_media_appearance_target ON whaleu_community.rating_discussion_media_bindings(
 ((envelope->>'targetId')::uuid),(CASE kind WHEN 'comment' THEN 'rating_comment' ELSE 'rating_reply' END),subject_id)
 WHERE jsonb_array_length(envelope->'images')>0;
CREATE INDEX discussion_media_appearance_root ON whaleu_community.rating_discussion_media_bindings(
 (CASE kind WHEN 'comment' THEN subject_id ELSE (envelope->>'rootId')::uuid END),
 (CASE kind WHEN 'comment' THEN 'rating_comment' ELSE 'rating_reply' END),subject_id)
 WHERE jsonb_array_length(envelope->'images')>0;
CREATE INDEX discussion_media_appearance_subject ON whaleu_community.rating_discussion_media_bindings(
 (CASE kind WHEN 'comment' THEN 'rating_comment' ELSE 'rating_reply' END),subject_id)
 WHERE jsonb_array_length(envelope->'images')>0;
CREATE FUNCTION whaleu_ratings.discussion_media_cleanup_members(kind text,id uuid) RETURNS TABLE(resource_kind text,resource_id uuid,target_id uuid,root_id uuid) LANGUAGE sql STABLE AS $$
 SELECT p.resource_kind,p.resource_id,p.target_id,p.root_id FROM whaleu_ratings.discussion_media_cleanup_appearances p
 WHERE (kind='target' AND p.target_id=id) OR (kind='root' AND p.root_id=id) OR (kind='reply' AND p.resource_kind='rating_reply' AND p.resource_id=id)
$$;
CREATE FUNCTION whaleu_ratings.discussion_media_cleanup_page(kind text,id uuid,after_kind text,after_id uuid,maximum integer)
 RETURNS TABLE(resource_kind text,resource_id uuid,target_id uuid,root_id uuid) LANGUAGE plpgsql STABLE AS $$BEGIN
 IF maximum NOT BETWEEN 1 AND 17 OR (after_kind IS NULL)<>(after_id IS NULL) THEN RAISE EXCEPTION 'Invalid cleanup window' USING ERRCODE='23514';END IF;
 IF kind='target' THEN RETURN QUERY
 SELECT p.resource_kind,p.resource_id,p.target_id,p.root_id FROM whaleu_ratings.discussion_media_cleanup_appearances p
 WHERE p.target_id=discussion_media_cleanup_page.id AND (after_id IS NULL OR (p.resource_kind,p.resource_id)>(after_kind,after_id))
 ORDER BY p.resource_kind,p.resource_id LIMIT maximum;
 ELSIF kind='root' THEN RETURN QUERY
 SELECT p.resource_kind,p.resource_id,p.target_id,p.root_id FROM whaleu_ratings.discussion_media_cleanup_appearances p
 WHERE p.root_id=discussion_media_cleanup_page.id AND (after_id IS NULL OR (p.resource_kind,p.resource_id)>(after_kind,after_id))
 ORDER BY p.resource_kind,p.resource_id LIMIT maximum;
 ELSIF kind='reply' THEN RETURN QUERY
 SELECT p.resource_kind,p.resource_id,p.target_id,p.root_id FROM whaleu_ratings.discussion_media_cleanup_appearances p
 WHERE p.resource_kind='rating_reply' AND p.resource_id=discussion_media_cleanup_page.id
 AND (after_id IS NULL OR (p.resource_kind,p.resource_id)>(after_kind,after_id)) LIMIT 1;
 ELSE RAISE EXCEPTION 'Unknown cleanup owner' USING ERRCODE='23514';END IF;
END$$;
CREATE FUNCTION whaleu_ratings.discussion_media_cleanup_enqueue() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF TG_TABLE_NAME='target_owner_tombstones' THEN
 IF NOT EXISTS(SELECT 1 FROM whaleu_ratings.discussion_media_cleanup_page('target',NEW.target_id,NULL,NULL,1)) THEN RETURN NULL;END IF;
 INSERT INTO whaleu_ratings.discussion_media_cleanup(owner_kind,owner_id) VALUES('target',NEW.target_id) ON CONFLICT DO NOTHING;
 ELSIF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
 IF NOT EXISTS(SELECT 1 FROM whaleu_ratings.discussion_media_cleanup_page(CASE TG_TABLE_NAME WHEN 'comments' THEN 'root' ELSE 'reply' END,NEW.id,NULL,NULL,1)) THEN RETURN NULL;END IF;
 INSERT INTO whaleu_ratings.discussion_media_cleanup(owner_kind,owner_id) VALUES(CASE TG_TABLE_NAME WHEN 'comments' THEN 'root' ELSE 'reply' END,NEW.id) ON CONFLICT DO NOTHING;
 END IF;RETURN NULL;
END$$;
CREATE TRIGGER discussion_media_target_cleanup_enqueue AFTER INSERT ON whaleu_ratings.target_owner_tombstones FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.discussion_media_cleanup_enqueue();
CREATE TRIGGER discussion_media_root_cleanup_enqueue AFTER UPDATE OF deleted_at ON whaleu_ratings.comments FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.discussion_media_cleanup_enqueue();
CREATE TRIGGER discussion_media_reply_cleanup_enqueue AFTER UPDATE OF deleted_at ON whaleu_ratings.replies FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.discussion_media_cleanup_enqueue();
INSERT INTO whaleu_ratings.discussion_media_cleanup(owner_kind,owner_id)
 SELECT 'target',t.target_id FROM whaleu_ratings.target_owner_tombstones t WHERE EXISTS(SELECT 1 FROM whaleu_ratings.discussion_media_cleanup_page('target',t.target_id,NULL,NULL,1))
 UNION ALL SELECT 'root',c.id FROM whaleu_ratings.comments c WHERE c.deleted_at IS NOT NULL AND EXISTS(SELECT 1 FROM whaleu_ratings.discussion_media_cleanup_page('root',c.id,NULL,NULL,1))
 UNION ALL SELECT 'reply',r.id FROM whaleu_ratings.replies r WHERE r.deleted_at IS NOT NULL AND EXISTS(SELECT 1 FROM whaleu_ratings.discussion_media_cleanup_page('reply',r.id,NULL,NULL,1));
CREATE FUNCTION whaleu_ratings.discussion_media_cleanup_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE member record;steps integer:=0;last_kind text;last_id uuid;BEGIN
 IF TG_OP='DELETE' OR NOT whaleu_ratings.discussion_media_cleanup_owner_current(NEW.owner_kind,NEW.owner_id) THEN
 RAISE EXCEPTION 'Discussion cleanup requires original owner deletion' USING ERRCODE='23514';END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.after_id IS NOT NULL OR NEW.phase<>'pending' OR NOT EXISTS(SELECT 1 FROM whaleu_ratings.discussion_media_cleanup_page(NEW.owner_kind,NEW.owner_id,NULL,NULL,1)) THEN RAISE EXCEPTION 'Cleanup starts at its own origin' USING ERRCODE='23514';END IF;
  RETURN NEW;
 END IF;
 IF OLD.phase='complete' OR (NEW.owner_kind,NEW.owner_id,NEW.created_at) IS DISTINCT FROM (OLD.owner_kind,OLD.owner_id,OLD.created_at)
 OR (OLD.after_id IS NOT NULL AND (NEW.after_id IS NULL OR (NEW.after_kind,NEW.after_id)<(OLD.after_kind,OLD.after_id))) THEN
 RAISE EXCEPTION 'Discussion cleanup cannot regress or reuse a completed cursor' USING ERRCODE='23514';END IF;
 IF (NEW.after_kind,NEW.after_id) IS DISTINCT FROM (OLD.after_kind,OLD.after_id) THEN
  FOR member IN SELECT * FROM whaleu_ratings.discussion_media_cleanup_page(NEW.owner_kind,NEW.owner_id,OLD.after_kind,OLD.after_id,17) LOOP
   EXIT WHEN (member.resource_kind,member.resource_id)>(NEW.after_kind,NEW.after_id);
   steps:=steps+1;last_kind:=member.resource_kind;last_id:=member.resource_id;
   IF steps>16 OR NOT EXISTS(SELECT 1 FROM whaleu_ratings.discussion_media_tombstones t WHERE (t.resource_kind,t.resource_id,t.target_id,t.root_id)=(member.resource_kind,member.resource_id,member.target_id,member.root_id))
   OR EXISTS(SELECT 1 FROM whaleu_media.bindings b WHERE b.owner_kind='ratings' AND b.resource_kind=member.resource_kind AND b.resource_id=member.resource_id AND b.detached_at IS NULL)
   THEN RAISE EXCEPTION 'Cleanup window cannot skip a descendant or live binding' USING ERRCODE='23514';END IF;
  END LOOP;
  IF steps=0 OR (last_kind,last_id) IS DISTINCT FROM (NEW.after_kind,NEW.after_id) THEN RAISE EXCEPTION 'Cleanup cursor must be the last exact bounded member' USING ERRCODE='23514';END IF;
 END IF;
 IF NEW.phase='complete' AND EXISTS(SELECT 1 FROM whaleu_ratings.discussion_media_cleanup_page(NEW.owner_kind,NEW.owner_id,NEW.after_kind,NEW.after_id,1))
 THEN RAISE EXCEPTION 'Cleanup completion still has an unvisited tail' USING ERRCODE='23514';END IF;
 RETURN NEW;
END$$;
CREATE TRIGGER discussion_media_cleanup_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_ratings.discussion_media_cleanup FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.discussion_media_cleanup_guard();
CREATE FUNCTION whaleu_ratings.discussion_media_tombstone_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_target uuid;parent_root uuid;BEGIN
 IF NEW.resource_kind='rating_comment' THEN SELECT target_id,id INTO parent_target,parent_root FROM whaleu_ratings.comments WHERE id=NEW.resource_id;
 ELSE SELECT target_id,root_id INTO parent_target,parent_root FROM whaleu_ratings.replies WHERE id=NEW.resource_id;END IF;
 IF (parent_target,parent_root) IS DISTINCT FROM (NEW.target_id,NEW.root_id) OR parent_target IS NULL
 OR NOT EXISTS(SELECT 1 FROM whaleu_ratings.discussion_media_cleanup_appearances p WHERE (p.resource_kind,p.resource_id,p.target_id,p.root_id)=(NEW.resource_kind,NEW.resource_id,NEW.target_id,NEW.root_id))
 OR NOT EXISTS(SELECT 1 FROM whaleu_ratings.discussion_media_cleanup j WHERE j.phase='pending' AND
 ((j.owner_kind='target' AND j.owner_id=parent_target) OR (j.owner_kind='root' AND j.owner_id=parent_root)
 OR (j.owner_kind='reply' AND NEW.resource_kind='rating_reply' AND j.owner_id=NEW.resource_id))
 AND whaleu_ratings.discussion_media_cleanup_owner_current(j.owner_kind,j.owner_id))
 THEN RAISE EXCEPTION 'Discussion media tombstone has no original exact owner ancestry' USING ERRCODE='23514';END IF;
 RETURN NEW;
END$$;
CREATE TRIGGER discussion_media_tombstone_guard BEFORE INSERT ON whaleu_ratings.discussion_media_tombstones FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.discussion_media_tombstone_guard();
CREATE TRIGGER discussion_media_tombstone_immutable BEFORE UPDATE OR DELETE ON whaleu_ratings.discussion_media_tombstones FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.immutable();
CREATE TRIGGER discussion_media_tombstone_retain BEFORE TRUNCATE ON whaleu_ratings.discussion_media_tombstones FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.immutable();
CREATE TRIGGER discussion_media_cleanup_retain BEFORE TRUNCATE ON whaleu_ratings.discussion_media_cleanup FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.immutable();
CREATE TRIGGER a00_discussion_media_tombstone_writer BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_ratings.discussion_media_tombstones FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.target_edit_writer();
CREATE TRIGGER a01_discussion_media_tombstone_navigation BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_ratings.discussion_media_tombstones FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.advance_navigation_epoch();

CREATE TRIGGER a00_discussion_media_cleanup_writer BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_ratings.discussion_media_cleanup FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.target_edit_writer();
CREATE TRIGGER a01_discussion_media_cleanup_navigation BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_ratings.discussion_media_cleanup FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.advance_navigation_epoch();
