-- Exact synchronous Community root ordering. One locked cutover scan, never an
-- HTTP scan. Preserve every content payload, publication timestamp and like ID.
LOCK TABLE whaleu_community.root_comments,whaleu_community.comment_likes IN SHARE ROW EXCLUSIVE MODE;
CREATE TABLE whaleu_community.discussion_order_events (
 id uuid PRIMARY KEY, root_id uuid NOT NULL, previous_id uuid REFERENCES whaleu_community.discussion_order_events(id),
 kind text NOT NULL CHECK(kind IN ('enroll','content','like_add','like_remove')),
 previous_count integer CHECK(previous_count>=0),new_count integer NOT NULL CHECK(new_count>=0),live boolean NOT NULL,
 like_id uuid,account_id uuid,mutation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 CHECK((kind IN ('like_add','like_remove'))=(like_id IS NOT NULL AND account_id IS NOT NULL)),
 CHECK(kind IN ('like_add','like_remove') OR (like_id IS NULL AND account_id IS NULL))
);
CREATE UNIQUE INDEX discussion_order_successor ON whaleu_community.discussion_order_events(previous_id) WHERE previous_id IS NOT NULL;
CREATE UNIQUE INDEX discussion_order_initial ON whaleu_community.discussion_order_events(root_id) WHERE previous_id IS NULL;
CREATE UNIQUE INDEX discussion_order_like_once ON whaleu_community.discussion_order_events(like_id,kind) WHERE like_id IS NOT NULL;
CREATE TABLE whaleu_community.discussion_root_order (
 root_id uuid PRIMARY KEY REFERENCES whaleu_community.root_comments(id) ON DELETE CASCADE,
 post_id uuid NOT NULL REFERENCES whaleu_community.posts(id),created_at timestamptz NOT NULL,
 live boolean NOT NULL,like_count integer NOT NULL CHECK(like_count>=0),
 head_id uuid REFERENCES whaleu_community.discussion_order_events(id)
);
-- Membership enrollment records identity, not invented historical event times.
CREATE TABLE whaleu_community.discussion_order_memberships (
 like_id uuid PRIMARY KEY,root_id uuid NOT NULL,account_id uuid NOT NULL,active boolean NOT NULL,
 head_id uuid REFERENCES whaleu_community.discussion_order_events(id)
);
INSERT INTO whaleu_community.discussion_root_order(root_id,post_id,created_at,live,like_count)
 SELECT r.id,r.post_id,r.created_at,r.visibility='approved' AND r.deleted_at IS NULL,count(l.comment_id)::integer
 FROM whaleu_community.root_comments r LEFT JOIN whaleu_community.comment_likes l ON l.comment_id=r.id
 GROUP BY r.id,r.post_id,r.created_at,r.visibility,r.deleted_at;
INSERT INTO whaleu_community.discussion_order_memberships(like_id,root_id,account_id,active)
 SELECT like_id,comment_id,account_id,true FROM whaleu_community.comment_likes;
CREATE INDEX discussion_roots_likes_desc ON whaleu_community.discussion_root_order(post_id,like_count DESC,created_at DESC,root_id DESC) WHERE live;
CREATE INDEX discussion_roots_likes_asc ON whaleu_community.discussion_root_order(post_id,like_count ASC,created_at DESC,root_id DESC) WHERE live;
CREATE INDEX discussion_roots_live_time ON whaleu_community.root_comments(post_id,created_at DESC,id DESC) WHERE visibility='approved' AND deleted_at IS NULL;
CREATE INDEX discussion_replies_live_sequence ON whaleu_community.replies(post_id,root_comment_id,sequence) WHERE visibility='approved' AND deleted_at IS NULL;

CREATE FUNCTION whaleu_community.discussion_order_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Discussion ordering history is source owned' USING ERRCODE='23514';END$$;
CREATE FUNCTION whaleu_community.discussion_order_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r whaleu_community.root_comments;p whaleu_community.discussion_root_order;m whaleu_community.discussion_order_memberships;
BEGIN
 -- Source/root before projection, including direct SQL membership writers.
 -- NO KEY UPDATE does not deadlock concurrent FK KEY SHARE membership inserts.
 SELECT * INTO r FROM whaleu_community.root_comments WHERE id=NEW.root_id FOR NO KEY UPDATE;
 SELECT * INTO p FROM whaleu_community.discussion_root_order WHERE root_id=NEW.root_id FOR UPDATE;
 IF pg_trigger_depth()<2 OR NEW.mutation_transaction<>pg_current_xact_id() OR r.id IS NULL
 OR NEW.live IS DISTINCT FROM (r.visibility='approved' AND r.deleted_at IS NULL)
 OR NEW.previous_id IS DISTINCT FROM p.head_id OR NEW.previous_count IS DISTINCT FROM p.like_count
 THEN RAISE EXCEPTION 'Discussion order source predecessor mismatch' USING ERRCODE='23514';END IF;
 IF NEW.kind='enroll' THEN
  IF p.root_id IS NOT NULL OR r.local_creation_transaction IS DISTINCT FROM pg_current_xact_id() OR NEW.new_count<>0
  OR EXISTS(SELECT 1 FROM whaleu_community.comment_likes WHERE comment_id=r.id LIMIT 1)
  THEN RAISE EXCEPTION 'Discussion order enrollment mismatch' USING ERRCODE='23514';END IF;
 ELSE
  IF p.root_id IS NULL THEN RAISE EXCEPTION 'Discussion order source missing' USING ERRCODE='23514';END IF;
  IF NEW.kind='content' THEN
   IF NEW.new_count<>p.like_count OR (NEW.live=p.live AND r.created_at=p.created_at) THEN RAISE EXCEPTION 'Discussion order content mismatch' USING ERRCODE='23514';END IF;
  ELSIF NEW.kind='like_add' THEN
   IF NEW.new_count::bigint<>p.like_count::bigint+1 OR EXISTS(SELECT 1 FROM whaleu_community.discussion_order_memberships WHERE like_id=NEW.like_id)
   OR NOT EXISTS(SELECT 1 FROM whaleu_community.comment_likes WHERE like_id=NEW.like_id AND comment_id=r.id AND account_id=NEW.account_id AND local_creation_transaction=pg_current_xact_id())
   THEN RAISE EXCEPTION 'Discussion order added membership mismatch' USING ERRCODE='23514';END IF;
  ELSE
   SELECT * INTO m FROM whaleu_community.discussion_order_memberships WHERE like_id=NEW.like_id;
   IF NEW.new_count::bigint<>p.like_count::bigint-1 OR m.like_id IS NULL OR NOT m.active OR (m.root_id,m.account_id) IS DISTINCT FROM (r.id,NEW.account_id)
   OR EXISTS(SELECT 1 FROM whaleu_community.comment_likes WHERE like_id=NEW.like_id)
   THEN RAISE EXCEPTION 'Discussion order removed membership mismatch' USING ERRCODE='23514';END IF;
  END IF;
 END IF;RETURN NEW;
END$$;
CREATE TRIGGER discussion_order_event_guard BEFORE INSERT ON whaleu_community.discussion_order_events FOR EACH ROW EXECUTE FUNCTION whaleu_community.discussion_order_event_guard();
CREATE TRIGGER discussion_order_event_immutable BEFORE UPDATE OR DELETE ON whaleu_community.discussion_order_events FOR EACH ROW EXECUTE FUNCTION whaleu_community.discussion_order_immutable();

CREATE FUNCTION whaleu_community.discussion_order_projection_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e whaleu_community.discussion_order_events;r whaleu_community.root_comments;
BEGIN
 IF TG_OP='DELETE' THEN
  IF TG_TABLE_NAME='discussion_root_order' THEN
   IF pg_trigger_depth()>1 AND OLD.like_count=0 AND NOT EXISTS(SELECT 1 FROM whaleu_community.root_comments WHERE id=OLD.root_id) THEN RETURN OLD;END IF;
  END IF;
  RAISE EXCEPTION 'Discussion order projection is retained' USING ERRCODE='23514';
 END IF;
 SELECT * INTO e FROM whaleu_community.discussion_order_events WHERE id=NEW.head_id;
 IF pg_trigger_depth()<2 OR e.id IS NULL OR e.mutation_transaction<>pg_current_xact_id() OR e.root_id<>NEW.root_id
 THEN RAISE EXCEPTION 'Discussion order requires exact source witness' USING ERRCODE='23514';END IF;
 IF TG_TABLE_NAME='discussion_root_order' THEN
  SELECT * INTO r FROM whaleu_community.root_comments WHERE id=NEW.root_id;
  IF (NEW.post_id,NEW.created_at,NEW.live,NEW.like_count) IS DISTINCT FROM (r.post_id,r.created_at,e.live,e.new_count)
  OR (TG_OP='INSERT' AND (e.kind<>'enroll' OR e.previous_count IS NOT NULL OR e.previous_id IS NOT NULL))
  OR (TG_OP='UPDATE' AND ((OLD.root_id,OLD.post_id,OLD.head_id,OLD.like_count) IS DISTINCT FROM (NEW.root_id,NEW.post_id,e.previous_id,e.previous_count)))
  THEN RAISE EXCEPTION 'Discussion order projection predecessor mismatch' USING ERRCODE='23514';END IF;
 ELSE
  IF (NEW.like_id,NEW.account_id,NEW.active) IS DISTINCT FROM (e.like_id,e.account_id,e.kind='like_add')
  OR (TG_OP='INSERT' AND e.kind<>'like_add')
  OR (TG_OP='UPDATE' AND (e.kind<>'like_remove' OR NOT OLD.active OR (OLD.like_id,OLD.root_id,OLD.account_id) IS DISTINCT FROM (NEW.like_id,NEW.root_id,NEW.account_id)))
  THEN RAISE EXCEPTION 'Discussion order membership witness mismatch' USING ERRCODE='23514';END IF;
 END IF;RETURN NEW;
END$$;
CREATE TRIGGER discussion_order_projection_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_community.discussion_root_order FOR EACH ROW EXECUTE FUNCTION whaleu_community.discussion_order_projection_guard();
CREATE TRIGGER discussion_order_membership_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_community.discussion_order_memberships FOR EACH ROW EXECUTE FUNCTION whaleu_community.discussion_order_projection_guard();
CREATE FUNCTION whaleu_community.discussion_order_apply() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.kind='enroll' THEN
  INSERT INTO whaleu_community.discussion_root_order(root_id,post_id,created_at,live,like_count,head_id)
   SELECT id,post_id,created_at,NEW.live,NEW.new_count,NEW.id FROM whaleu_community.root_comments WHERE id=NEW.root_id;
 ELSE UPDATE whaleu_community.discussion_root_order SET live=NEW.live,like_count=NEW.new_count,head_id=NEW.id,
  created_at=(SELECT created_at FROM whaleu_community.root_comments WHERE id=NEW.root_id) WHERE root_id=NEW.root_id;END IF;
 IF NEW.kind='like_add' THEN INSERT INTO whaleu_community.discussion_order_memberships(like_id,root_id,account_id,active,head_id) VALUES(NEW.like_id,NEW.root_id,NEW.account_id,true,NEW.id);
 ELSIF NEW.kind='like_remove' THEN UPDATE whaleu_community.discussion_order_memberships SET active=false,head_id=NEW.id WHERE like_id=NEW.like_id;END IF;
 RETURN NULL;
END$$;
CREATE TRIGGER discussion_order_apply AFTER INSERT ON whaleu_community.discussion_order_events FOR EACH ROW EXECUTE FUNCTION whaleu_community.discussion_order_apply();
CREATE FUNCTION whaleu_community.discussion_order_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE root uuid;r whaleu_community.root_comments;p whaleu_community.discussion_root_order;k text;member uuid;actor uuid;amount integer;
BEGIN
 IF TG_TABLE_NAME='root_comments' THEN
  root:=NEW.id;k:=CASE WHEN TG_OP='INSERT' THEN 'enroll' ELSE 'content' END;
  IF TG_OP='UPDATE' AND (NEW.visibility='approved' AND NEW.deleted_at IS NULL)=(OLD.visibility='approved' AND OLD.deleted_at IS NULL) AND NEW.created_at=OLD.created_at THEN RETURN NULL;END IF;
 ELSE
  root:=CASE WHEN TG_OP='INSERT' THEN NEW.comment_id ELSE OLD.comment_id END;
  member:=CASE WHEN TG_OP='INSERT' THEN NEW.like_id ELSE OLD.like_id END;actor:=CASE WHEN TG_OP='INSERT' THEN NEW.account_id ELSE OLD.account_id END;
  k:=CASE WHEN TG_OP='INSERT' THEN 'like_add' ELSE 'like_remove' END;
 END IF;
 SELECT * INTO r FROM whaleu_community.root_comments WHERE id=root FOR NO KEY UPDATE;
 SELECT * INTO p FROM whaleu_community.discussion_root_order WHERE root_id=root FOR UPDATE;
 amount:=CASE k WHEN 'enroll' THEN 0 WHEN 'content' THEN p.like_count WHEN 'like_add' THEN p.like_count+1 ELSE p.like_count-1 END;
 INSERT INTO whaleu_community.discussion_order_events(id,root_id,previous_id,kind,previous_count,new_count,live,like_id,account_id)
 VALUES(gen_random_uuid(),root,p.head_id,k,p.like_count,amount,r.visibility='approved' AND r.deleted_at IS NULL,member,actor);
 RETURN NULL;
END$$;
CREATE TRIGGER discussion_order_root_source AFTER INSERT OR UPDATE OF visibility,deleted_at,created_at ON whaleu_community.root_comments FOR EACH ROW EXECUTE FUNCTION whaleu_community.discussion_order_source();
CREATE TRIGGER discussion_order_like_source AFTER INSERT OR DELETE ON whaleu_community.comment_likes FOR EACH ROW EXECUTE FUNCTION whaleu_community.discussion_order_source();
DO $$DECLARE name text;BEGIN
 FOREACH name IN ARRAY ARRAY['discussion_order_events','discussion_root_order','discussion_order_memberships','comment_likes'] LOOP
 EXECUTE format('CREATE TRIGGER discussion_order_no_truncate BEFORE TRUNCATE ON whaleu_community.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.discussion_order_immutable()',name);
 END LOOP;
END$$;
