-- One constant-size source generation invalidates all linked dependency proofs.
-- Target text successors invalidate certificates without changing post approval,
-- content, replies, component label, receipt, or original target binding.
CREATE TABLE whaleu_community.rating_target_link_generation (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),version integer NOT NULL CHECK(version=1),generation uuid NOT NULL
);
INSERT INTO whaleu_community.rating_target_link_generation(singleton,version,generation) VALUES(true,1,gen_random_uuid());
CREATE FUNCTION whaleu_community.rating_target_link_generation_guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF TG_OP<>'UPDATE' OR pg_trigger_depth()<2 OR NEW.singleton IS DISTINCT FROM OLD.singleton OR NEW.version IS DISTINCT FROM OLD.version OR NEW.generation=OLD.generation THEN RAISE EXCEPTION 'Rating link generation is source owned' USING ERRCODE='23514';END IF;RETURN NEW;END$$;
CREATE TRIGGER rating_target_link_generation_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_community.rating_target_link_generation FOR EACH ROW EXECUTE FUNCTION whaleu_community.rating_target_link_generation_guard();
CREATE TRIGGER rating_target_link_generation_retain BEFORE TRUNCATE ON whaleu_community.rating_target_link_generation FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.rating_target_link_retain();
CREATE FUNCTION whaleu_community.advance_rating_target_link_generation() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 UPDATE whaleu_community.rating_target_link_generation SET generation=gen_random_uuid() WHERE singleton;
 IF NOT FOUND THEN RAISE EXCEPTION 'Missing rating link generation' USING ERRCODE='23514';END IF;RETURN NULL;END$$;
-- Existing Ratings epochs cover catalog, placement, lifecycle, source, Review,
-- covers/icons, protocol and category ancestry changes without touching posts.
DO $$DECLARE source text;BEGIN
 FOREACH source IN ARRAY ARRAY['whaleu_ratings.navigation_epoch','whaleu_ratings.random_pool_epoch','whaleu_ratings.scoped_source_epoch','whaleu_ratings.scope_protocol_epoch','whaleu_ratings.target_cover_capability_epoch','whaleu_ratings.category_icon_epoch','whaleu_media.media_owner_states','whaleu_community.rating_review_epoch','whaleu_community.rating_review_binding_epoch','whaleu_community.post_rating_target_links'] LOOP
  EXECUTE format('CREATE TRIGGER rating_target_link_generation AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON %s FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.advance_rating_target_link_generation()',source);
 END LOOP;END$$;
CREATE TRIGGER a_discovery_count_epoch BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_community.rating_target_link_generation FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.advance_discovery_count_epoch();
CREATE TRIGGER a_discovery_count_epoch BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_community.post_rating_target_links FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.advance_discovery_count_epoch();


-- New count inputs join both existing administrative owners' live inventory.
-- Their unchanged statement guards preserve same-transaction isolation.
DO $$DECLARE relation text;BEGIN
 FOREACH relation IN ARRAY ARRAY['rating_target_link_generation','post_rating_target_links'] LOOP
  EXECUTE format('CREATE TRIGGER a00_admin_post_removal_source_statement BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_community.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.admin_post_removal_source_statement_guard()',relation);
  EXECUTE format('CREATE TRIGGER a00_admin_discussion_removal_source_statement BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_community.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.admin_discussion_removal_source_statement_guard()',relation);
 END LOOP;
 IF NOT whaleu_community.admin_post_removal_inventory_current() OR NOT whaleu_community.admin_discussion_removal_inventory_current() THEN RAISE EXCEPTION 'Incomplete rating-link administrative input inventory';END IF;
END$$;

-- Optional semantic storage remains optional. The helper returns the original
-- generation for old content; new linked roots compose an explicit dependency.
CREATE FUNCTION whaleu_community.rating_link_semantic_generation(kind text,id uuid,original uuid) RETURNS uuid LANGUAGE plpgsql STABLE AS $$
DECLARE postid uuid;v integer;generation uuid;hash text;BEGIN
 IF kind='post' THEN postid:=id;
 ELSIF kind='comment' THEN SELECT post_id INTO postid FROM whaleu_community.root_comments WHERE root_comments.id=rating_link_semantic_generation.id;
 ELSIF kind='reply' THEN SELECT post_id INTO postid FROM whaleu_community.replies WHERE replies.id=rating_link_semantic_generation.id;ELSE RETURN NULL;END IF;
 SELECT publication_envelope_version INTO v FROM whaleu_community.posts WHERE posts.id=postid;
 IF v<>5 THEN RETURN original;END IF;
 SELECT g.generation INTO generation FROM whaleu_community.rating_target_link_generation g WHERE singleton AND version=1;
 IF generation IS NULL OR original IS NULL OR NOT EXISTS(SELECT 1 FROM whaleu_community.post_rating_target_links WHERE post_id=postid) THEN RETURN NULL;END IF;
 hash:=md5('whaleu-rating-link-semantic:v1:'||original::text||':'||generation::text);
 RETURN (substr(hash,1,8)||'-'||substr(hash,9,4)||'-5'||substr(hash,14,3)||'-a'||substr(hash,18,3)||'-'||substr(hash,21,12))::uuid;
END$$;
