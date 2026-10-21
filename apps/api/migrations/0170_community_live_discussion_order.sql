-- Live-only access path: retained canonical order and causal history stay intact.
-- Serialize the cutover with canonical writers; never invent historical events.
LOCK TABLE whaleu_community.discussion_root_order IN SHARE ROW EXCLUSIVE MODE;
CREATE TABLE whaleu_community.discussion_live_root_order (
 root_id uuid PRIMARY KEY REFERENCES whaleu_community.discussion_root_order(root_id) ON DELETE CASCADE,
 post_id uuid NOT NULL,created_at timestamptz NOT NULL,
 like_count integer NOT NULL CHECK(like_count>=0),head_id uuid
);
INSERT INTO whaleu_community.discussion_live_root_order(root_id,post_id,created_at,like_count,head_id)
 SELECT root_id,post_id,created_at,like_count,head_id
 FROM whaleu_community.discussion_root_order WHERE live;
CREATE INDEX discussion_live_roots_likes_desc ON whaleu_community.discussion_live_root_order(post_id,like_count,created_at,root_id);
CREATE INDEX discussion_live_roots_likes_asc ON whaleu_community.discussion_live_root_order(post_id,(-like_count),created_at,root_id);
CREATE INDEX discussion_live_roots_time ON whaleu_community.discussion_live_root_order(post_id,created_at,root_id);

CREATE FUNCTION whaleu_community.discussion_live_order_owned() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF pg_trigger_depth()<2 THEN RAISE EXCEPTION 'Live discussion ordering is source owned' USING ERRCODE='23514';END IF;
 RETURN NULL;
END$$;
CREATE TRIGGER discussion_live_order_owned BEFORE INSERT OR UPDATE OR DELETE ON whaleu_community.discussion_live_root_order FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.discussion_live_order_owned();
CREATE FUNCTION whaleu_community.discussion_live_order_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p whaleu_community.discussion_root_order;
BEGIN
 -- No reverse locks: writers already hold source root, then canonical order.
 -- Trigger depth alone is not authority: validate the exact current tuple.
 IF TG_OP='DELETE' THEN
  IF pg_trigger_depth()>1 AND NOT EXISTS(SELECT 1 FROM whaleu_community.discussion_root_order WHERE root_id=OLD.root_id AND live) THEN RETURN OLD;END IF;
  RAISE EXCEPTION 'Live discussion deletion requires absent or nonlive source' USING ERRCODE='23514';
 END IF;
 SELECT * INTO p FROM whaleu_community.discussion_root_order WHERE root_id=NEW.root_id;
 IF pg_trigger_depth()<2 OR p.root_id IS NULL OR NOT p.live
 OR (NEW.root_id,NEW.post_id,NEW.created_at,NEW.like_count,NEW.head_id) IS DISTINCT FROM (p.root_id,p.post_id,p.created_at,p.like_count,p.head_id)
 OR (TG_OP='UPDATE' AND OLD.root_id IS DISTINCT FROM NEW.root_id)
 THEN RAISE EXCEPTION 'Live discussion ordering requires exact canonical source' USING ERRCODE='23514';END IF;
 RETURN NEW;
END$$;
CREATE TRIGGER discussion_live_order_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_community.discussion_live_root_order FOR EACH ROW EXECUTE FUNCTION whaleu_community.discussion_live_order_guard();
CREATE TRIGGER discussion_live_order_no_truncate BEFORE TRUNCATE ON whaleu_community.discussion_live_root_order FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.discussion_order_immutable();
CREATE FUNCTION whaleu_community.discussion_live_order_apply() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  DELETE FROM whaleu_community.discussion_live_root_order WHERE root_id=OLD.root_id;
 ELSIF NEW.live THEN
  INSERT INTO whaleu_community.discussion_live_root_order(root_id,post_id,created_at,like_count,head_id)
   VALUES(NEW.root_id,NEW.post_id,NEW.created_at,NEW.like_count,NEW.head_id)
   ON CONFLICT(root_id) DO UPDATE SET post_id=EXCLUDED.post_id,created_at=EXCLUDED.created_at,like_count=EXCLUDED.like_count,head_id=EXCLUDED.head_id;
 ELSE
  DELETE FROM whaleu_community.discussion_live_root_order WHERE root_id=NEW.root_id;
 END IF;
 RETURN NULL;
END$$;
CREATE TRIGGER discussion_live_order_apply AFTER INSERT OR UPDATE OR DELETE ON whaleu_community.discussion_root_order FOR EACH ROW EXECUTE FUNCTION whaleu_community.discussion_live_order_apply();
