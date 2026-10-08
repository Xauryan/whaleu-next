-- Independent internal post-like component: fresh native publications only.
-- Sources are actual post_likes INSERT/DELETE transitions, never request receipts.
-- No historical enrollment, import, public score, grants or automatic processing.
CREATE SEQUENCE whaleu_post_hotness.like_source_sequence AS bigint MINVALUE 1;
CREATE TABLE whaleu_post_hotness.like_baselines (
 post_id uuid PRIMARY KEY REFERENCES whaleu_community.posts(id),
 component_version smallint NOT NULL DEFAULT 1 CHECK(component_version=1),
 origin text NOT NULL DEFAULT 'native_post_creation' CHECK(origin='native_post_creation'),
 opening_count bigint NOT NULL DEFAULT 0 CHECK(opening_count=0),
 owner_id uuid NOT NULL, source_request_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 creation_xid xid8 NOT NULL DEFAULT pg_current_xact_id()
);
CREATE TABLE whaleu_post_hotness.like_states (
 post_id uuid PRIMARY KEY REFERENCES whaleu_post_hotness.like_baselines(post_id),
 count bigint NOT NULL DEFAULT 0 CHECK(count>=0),
 last_sequence bigint NOT NULL DEFAULT 0 CHECK(last_sequence>=0),
 last_receipt_id uuid,
 CHECK((last_sequence=0)=(last_receipt_id IS NULL))
);
CREATE TABLE whaleu_post_hotness.like_sources (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 post_id uuid NOT NULL REFERENCES whaleu_post_hotness.like_baselines(post_id),
 actor_id uuid NOT NULL, like_id uuid NOT NULL,
 transition text NOT NULL CHECK(transition IN ('liked','unliked')),
 delta smallint NOT NULL CHECK((transition='liked' AND delta=1) OR (transition='unliked' AND delta=-1)),
 source_sequence bigint NOT NULL UNIQUE CHECK(source_sequence>0),
 source_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 positive_source_id uuid REFERENCES whaleu_post_hotness.like_sources(id),
 UNIQUE(like_id,transition),
 CHECK((transition='liked' AND positive_source_id IS NULL) OR (transition='unliked' AND positive_source_id IS NOT NULL))
);
CREATE INDEX like_source_post_order ON whaleu_post_hotness.like_sources(post_id,source_sequence);
CREATE TABLE whaleu_post_hotness.like_memberships (
 post_id uuid NOT NULL REFERENCES whaleu_post_hotness.like_baselines(post_id),
 actor_id uuid NOT NULL, active_like_id uuid,
 last_sequence bigint NOT NULL CHECK(last_sequence>0), last_receipt_id uuid NOT NULL,
 PRIMARY KEY(post_id,actor_id)
);
CREATE TABLE whaleu_post_hotness.like_receipts (
 source_id uuid PRIMARY KEY REFERENCES whaleu_post_hotness.like_sources(id),
 post_id uuid NOT NULL REFERENCES whaleu_post_hotness.like_baselines(post_id),
 actor_id uuid NOT NULL, like_id uuid NOT NULL, transition text NOT NULL,
 source_sequence bigint NOT NULL CHECK(source_sequence>0),
 component_version smallint NOT NULL DEFAULT 1 CHECK(component_version=1),
 delta smallint NOT NULL CHECK(delta IN (-1,1)),
 before_count bigint NOT NULL CHECK(before_count>=0), after_count bigint NOT NULL CHECK(after_count>=0),
 previous_state_sequence bigint NOT NULL CHECK(previous_state_sequence>=0),
 previous_membership_sequence bigint NOT NULL CHECK(previous_membership_sequence>=0),
 previous_active_like_id uuid,
 application_xid xid8 NOT NULL DEFAULT pg_current_xact_id(), applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(post_id,application_xid),
 CHECK(after_count=before_count+delta),
 CHECK((transition='liked' AND delta=1) OR (transition='unliked' AND delta=-1)),
 CHECK(source_sequence>previous_state_sequence AND source_sequence>previous_membership_sequence)
);
ALTER TABLE whaleu_post_hotness.like_states ADD FOREIGN KEY(last_receipt_id) REFERENCES whaleu_post_hotness.like_receipts(source_id);
ALTER TABLE whaleu_post_hotness.like_memberships ADD FOREIGN KEY(last_receipt_id) REFERENCES whaleu_post_hotness.like_receipts(source_id);

CREATE FUNCTION whaleu_post_hotness.like_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Like evidence is immutable; truncate bypass is forbidden' USING ERRCODE='23514'; END $$;
CREATE TRIGGER like_baseline_immutable BEFORE UPDATE OR DELETE ON whaleu_post_hotness.like_baselines FOR EACH ROW EXECUTE FUNCTION whaleu_post_hotness.like_immutable();
CREATE TRIGGER like_source_immutable BEFORE UPDATE OR DELETE ON whaleu_post_hotness.like_sources FOR EACH ROW EXECUTE FUNCTION whaleu_post_hotness.like_immutable();
CREATE TRIGGER like_receipt_immutable BEFORE UPDATE OR DELETE ON whaleu_post_hotness.like_receipts FOR EACH ROW EXECUTE FUNCTION whaleu_post_hotness.like_immutable();
-- Row triggers cannot observe TRUNCATE. Reject it even on an empty protected
-- table, including CASCADE, so it cannot remove live epochs or retained proof.
CREATE TRIGGER like_baseline_no_truncate BEFORE TRUNCATE ON whaleu_post_hotness.like_baselines FOR EACH STATEMENT EXECUTE FUNCTION whaleu_post_hotness.like_immutable();
CREATE TRIGGER like_source_no_truncate BEFORE TRUNCATE ON whaleu_post_hotness.like_sources FOR EACH STATEMENT EXECUTE FUNCTION whaleu_post_hotness.like_immutable();
CREATE TRIGGER like_receipt_no_truncate BEFORE TRUNCATE ON whaleu_post_hotness.like_receipts FOR EACH STATEMENT EXECUTE FUNCTION whaleu_post_hotness.like_immutable();
CREATE TRIGGER like_state_no_truncate BEFORE TRUNCATE ON whaleu_post_hotness.like_states FOR EACH STATEMENT EXECUTE FUNCTION whaleu_post_hotness.like_immutable();
CREATE TRIGGER like_membership_no_truncate BEFORE TRUNCATE ON whaleu_post_hotness.like_memberships FOR EACH STATEMENT EXECUTE FUNCTION whaleu_post_hotness.like_immutable();
CREATE TRIGGER post_like_no_truncate BEFORE TRUNCATE ON whaleu_community.post_likes FOR EACH STATEMENT EXECUTE FUNCTION whaleu_post_hotness.like_immutable();

CREATE FUNCTION whaleu_post_hotness.like_baseline_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM whaleu_community.posts p
   JOIN whaleu_community.report_origins o ON o.kind='post' AND o.target_id=p.id
   JOIN whaleu_community.publication_requests r ON r.account_id=o.owner_account_id AND r.client_request_id=o.source_request_id
   WHERE p.id=NEW.post_id AND p.account_id=NEW.owner_id AND p.local_creation_transaction=pg_current_xact_id()
    AND o.owner_account_id=NEW.owner_id AND o.source_request_id=NEW.source_request_id AND o.provenance='native_publication'
    AND r.operation='publish_post' AND r.receipt->>'outcome'='created'
    AND r.receipt->>'resourceId'=p.id::text AND r.receipt->>'requestId'=NEW.source_request_id::text
    AND r.receipt->>'operation'='publish_post')
   OR EXISTS(SELECT 1 FROM whaleu_community.post_likes WHERE post_id=NEW.post_id)
   OR EXISTS(SELECT 1 FROM whaleu_post_hotness.like_sources WHERE post_id=NEW.post_id) THEN
   RAISE EXCEPTION 'Like baseline requires fresh exact native publication with no live likes or captured history' USING ERRCODE='23514';
 END IF;
 NEW.creation_xid:=pg_current_xact_id(); NEW.created_at:=clock_timestamp(); RETURN NEW;
END $$;
CREATE TRIGGER like_baseline_guard BEFORE INSERT ON whaleu_post_hotness.like_baselines FOR EACH ROW EXECUTE FUNCTION whaleu_post_hotness.like_baseline_guard();
CREATE FUNCTION whaleu_post_hotness.like_publication_complete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.kind='post' AND NEW.provenance='native_publication'
  AND EXISTS(SELECT 1 FROM whaleu_community.posts WHERE id=NEW.target_id AND local_creation_transaction=pg_current_xact_id())
  AND NOT EXISTS(SELECT 1 FROM whaleu_post_hotness.like_baselines b JOIN whaleu_post_hotness.like_states s USING(post_id)
   WHERE b.post_id=NEW.target_id AND b.owner_id=NEW.owner_account_id AND b.source_request_id=NEW.source_request_id AND b.creation_xid=pg_current_xact_id()) THEN
  RAISE EXCEPTION 'Fresh native publication requires like enrollment' USING ERRCODE='23514';
 END IF; RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER like_publication_complete AFTER INSERT ON whaleu_community.report_origins DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_post_hotness.like_publication_complete();
CREATE FUNCTION whaleu_post_hotness.like_baseline_complete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM whaleu_post_hotness.like_states WHERE post_id=NEW.post_id) THEN
  RAISE EXCEPTION 'Like baseline requires state' USING ERRCODE='23514';
 END IF; RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER like_baseline_complete AFTER INSERT ON whaleu_post_hotness.like_baselines DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_post_hotness.like_baseline_complete();

-- Trusted-schema boundary: only this installed post_likes row trigger can
-- enter the nested source insertion path. Depth is not a capability against a
-- DB owner who can create/disable triggers or replace these functions.
CREATE FUNCTION whaleu_post_hotness.like_source_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE positive whaleu_post_hotness.like_sources;
BEGIN
 IF pg_trigger_depth()<>2 THEN
  RAISE EXCEPTION 'Like source requires actual membership transition' USING ERRCODE='23514';
 END IF;
 -- The live-row mutation may already own a child lock. Never wait on parent
 -- while holding it: normal endpoints already own parent; direct writers must
 -- retry their whole transaction after explicitly prelocking parent.
 PERFORM 1 FROM whaleu_community.posts WHERE id=NEW.post_id FOR UPDATE NOWAIT;
 IF NEW.transition='liked' THEN
  IF NEW.positive_source_id IS NOT NULL OR NEW.delta<>1 OR NOT EXISTS(
   SELECT 1 FROM whaleu_community.post_likes l WHERE l.like_id=NEW.like_id
    AND l.post_id=NEW.post_id AND l.account_id=NEW.actor_id
    AND l.local_creation_transaction=pg_current_xact_id()) THEN
   RAISE EXCEPTION 'Positive like source requires actual fresh membership' USING ERRCODE='23514';
  END IF;
 ELSIF NEW.transition='unliked' THEN
  SELECT * INTO positive FROM whaleu_post_hotness.like_sources WHERE id=NEW.positive_source_id;
  IF positive.id IS NULL OR NEW.delta<>-1 OR
   (positive.post_id,positive.actor_id,positive.like_id,positive.transition)
    IS DISTINCT FROM (NEW.post_id,NEW.actor_id,NEW.like_id,'liked'::text) OR
   EXISTS(SELECT 1 FROM whaleu_community.post_likes WHERE like_id=NEW.like_id) THEN
   RAISE EXCEPTION 'Negative like source requires exact retained positive epoch and actual deletion' USING ERRCODE='23514';
  END IF;
 ELSE RAISE EXCEPTION 'Unknown like transition' USING ERRCODE='23514';
 END IF;
 -- No caller-supplied ordering or transaction proof is trusted. Sequence gaps
 -- after rollback are valid; this sequence has no cross-component meaning.
 NEW.source_sequence:=nextval('whaleu_post_hotness.like_source_sequence');
 IF positive.id IS NOT NULL AND NEW.source_sequence<=positive.source_sequence THEN
  RAISE EXCEPTION 'Negative like source must follow its positive' USING ERRCODE='23514';
 END IF;
 NEW.source_transaction:=pg_current_xact_id(); NEW.captured_at:=clock_timestamp(); RETURN NEW;
END $$;
CREATE TRIGGER like_source_guard BEFORE INSERT ON whaleu_post_hotness.like_sources FOR EACH ROW EXECUTE FUNCTION whaleu_post_hotness.like_source_guard();
-- Before an INSERT acquires its tuple/unique-key and FK locks, fail fast on
-- a parent held elsewhere. An AFTER trigger alone is too late: the immediate
-- FK trigger can wait for parent KEY SHARE before capture reaches NOWAIT.
CREATE FUNCTION whaleu_post_hotness.like_insert_parent_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 -- An uncommitted fresh publication has no visible parent/baseline yet. Do
 -- not enter FK/unique-key waits with that incomplete visibility: a publisher
 -- might next insert this same membership while it still owns the parent.
 -- A visible parent without baseline cannot later enroll (same-xid rule).
 IF NOT EXISTS(SELECT 1 FROM whaleu_community.posts WHERE id=NEW.post_id) THEN
  RAISE EXCEPTION 'Like parent must be visible; retry after publication commits' USING ERRCODE='23514';
 END IF;
 IF EXISTS(SELECT 1 FROM whaleu_post_hotness.like_baselines WHERE post_id=NEW.post_id) THEN
  PERFORM 1 FROM whaleu_community.posts WHERE id=NEW.post_id FOR UPDATE NOWAIT;
 END IF; RETURN NEW;
END $$;
CREATE TRIGGER like_insert_parent_guard BEFORE INSERT ON whaleu_community.post_likes FOR EACH ROW EXECUTE FUNCTION whaleu_post_hotness.like_insert_parent_guard();
CREATE FUNCTION whaleu_post_hotness.capture_like() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_post uuid; positive_id uuid;
BEGIN
 IF TG_OP='INSERT' THEN target_post:=NEW.post_id; ELSE target_post:=OLD.post_id; END IF;
 IF NOT EXISTS(SELECT 1 FROM whaleu_post_hotness.like_baselines WHERE post_id=target_post) THEN RETURN NULL; END IF;
 PERFORM 1 FROM whaleu_community.posts WHERE id=target_post FOR UPDATE NOWAIT;
 IF TG_OP='INSERT' THEN
  INSERT INTO whaleu_post_hotness.like_sources(post_id,actor_id,like_id,transition,delta)
   VALUES(NEW.post_id,NEW.account_id,NEW.like_id,'liked',1);
 ELSE
  SELECT id INTO positive_id FROM whaleu_post_hotness.like_sources
   WHERE post_id=OLD.post_id AND actor_id=OLD.account_id AND like_id=OLD.like_id AND transition='liked';
  IF positive_id IS NULL THEN
   RAISE EXCEPTION 'Deleted known-post membership has no retained positive source' USING ERRCODE='23514';
  END IF;
  -- OLD creation xid may be from any earlier transaction. This actual DELETE
  -- supplies the negative proof; the source guard stamps this transaction xid.
  INSERT INTO whaleu_post_hotness.like_sources(post_id,actor_id,like_id,transition,delta,positive_source_id)
   VALUES(OLD.post_id,OLD.account_id,OLD.like_id,'unliked',-1,positive_id);
 END IF; RETURN NULL;
END $$;
CREATE TRIGGER like_capture_membership AFTER INSERT OR DELETE ON whaleu_community.post_likes FOR EACH ROW EXECUTE FUNCTION whaleu_post_hotness.capture_like();

CREATE FUNCTION whaleu_post_hotness.like_receipt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE src whaleu_post_hotness.like_sources; st whaleu_post_hotness.like_states;
 member whaleu_post_hotness.like_memberships;
BEGIN
 -- Parent -> state -> applied membership. Never lock the live relation, request,
 -- session, actor, safety, reward or subscription records in settlement.
 PERFORM 1 FROM whaleu_community.posts WHERE id=NEW.post_id FOR UPDATE;
 SELECT * INTO st FROM whaleu_post_hotness.like_states WHERE post_id=NEW.post_id FOR UPDATE;
 SELECT * INTO member FROM whaleu_post_hotness.like_memberships WHERE post_id=NEW.post_id AND actor_id=NEW.actor_id FOR UPDATE;
 SELECT * INTO src FROM whaleu_post_hotness.like_sources WHERE id=NEW.source_id;
 IF st.post_id IS NULL OR src.id IS NULL OR
  (src.post_id,src.actor_id,src.like_id,src.transition,src.delta,src.source_sequence)
   IS DISTINCT FROM (NEW.post_id,NEW.actor_id,NEW.like_id,NEW.transition,NEW.delta,NEW.source_sequence) OR
  (st.count,st.last_sequence) IS DISTINCT FROM (NEW.before_count,NEW.previous_state_sequence) OR
  coalesce(member.last_sequence,0)<>NEW.previous_membership_sequence OR member.active_like_id IS DISTINCT FROM NEW.previous_active_like_id OR
  NEW.source_sequence<=st.last_sequence OR NEW.source_sequence<=coalesce(member.last_sequence,0) OR
  EXISTS(SELECT 1 FROM whaleu_post_hotness.like_sources earlier WHERE earlier.post_id=NEW.post_id
   AND earlier.source_sequence<NEW.source_sequence AND NOT EXISTS(
    SELECT 1 FROM whaleu_post_hotness.like_receipts r WHERE r.source_id=earlier.id)) OR
  (NEW.transition='liked' AND member.active_like_id IS NOT NULL) OR
  (NEW.transition='unliked' AND (member.active_like_id IS DISTINCT FROM NEW.like_id OR st.count<=0)) THEN
  RAISE EXCEPTION 'Like receipt lacks exact causal source and pre-state' USING ERRCODE='23514';
 END IF;
 NEW.application_xid:=pg_current_xact_id(); NEW.applied_at:=clock_timestamp(); RETURN NEW;
END $$;
CREATE TRIGGER like_receipt_guard BEFORE INSERT ON whaleu_post_hotness.like_receipts FOR EACH ROW EXECUTE FUNCTION whaleu_post_hotness.like_receipt_guard();

CREATE FUNCTION whaleu_post_hotness.like_state_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r whaleu_post_hotness.like_receipts;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Like state is retained' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.count<>0 OR NEW.last_sequence<>0 OR NEW.last_receipt_id IS NOT NULL OR NOT EXISTS(
   SELECT 1 FROM whaleu_post_hotness.like_baselines WHERE post_id=NEW.post_id AND creation_xid=pg_current_xact_id()) THEN
   RAISE EXCEPTION 'Like initial state requires fresh zero baseline' USING ERRCODE='23514';
  END IF;
 ELSE
  SELECT * INTO r FROM whaleu_post_hotness.like_receipts WHERE source_id=NEW.last_receipt_id AND application_xid=pg_current_xact_id();
  IF r.source_id IS NULL OR NEW.post_id<>OLD.post_id OR
   (r.post_id,r.before_count,r.previous_state_sequence,r.after_count,r.source_sequence)
    IS DISTINCT FROM (OLD.post_id,OLD.count,OLD.last_sequence,NEW.count,NEW.last_sequence) OR NEW.last_sequence<=OLD.last_sequence THEN
   RAISE EXCEPTION 'Like state requires exact receipt transition' USING ERRCODE='23514';
  END IF;
 END IF; RETURN NEW;
END $$;
CREATE TRIGGER like_state_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_post_hotness.like_states FOR EACH ROW EXECUTE FUNCTION whaleu_post_hotness.like_state_guard();
CREATE FUNCTION whaleu_post_hotness.like_membership_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r whaleu_post_hotness.like_receipts;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Like membership is retained' USING ERRCODE='23514'; END IF;
 SELECT * INTO r FROM whaleu_post_hotness.like_receipts WHERE source_id=NEW.last_receipt_id AND application_xid=pg_current_xact_id();
 IF r.source_id IS NULL OR (r.post_id,r.actor_id,r.source_sequence) IS DISTINCT FROM (NEW.post_id,NEW.actor_id,NEW.last_sequence)
  OR NEW.active_like_id IS DISTINCT FROM (CASE r.transition WHEN 'liked' THEN r.like_id ELSE NULL END) THEN
  RAISE EXCEPTION 'Like membership requires exact receipt' USING ERRCODE='23514';
 END IF;
 IF TG_OP='INSERT' THEN
  IF r.transition<>'liked' OR r.previous_membership_sequence<>0 OR r.previous_active_like_id IS NOT NULL THEN
   RAISE EXCEPTION 'Like first membership requires first positive receipt' USING ERRCODE='23514';
  END IF;
 ELSIF (OLD.post_id,OLD.actor_id,OLD.last_sequence,OLD.active_like_id)
  IS DISTINCT FROM (NEW.post_id,NEW.actor_id,r.previous_membership_sequence,r.previous_active_like_id) OR NEW.last_sequence<=OLD.last_sequence THEN
  RAISE EXCEPTION 'Like membership pre-state mismatch' USING ERRCODE='23514';
 END IF; RETURN NEW;
END $$;
CREATE TRIGGER like_membership_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_post_hotness.like_memberships FOR EACH ROW EXECUTE FUNCTION whaleu_post_hotness.like_membership_guard();

CREATE FUNCTION whaleu_post_hotness.like_receipt_complete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM whaleu_post_hotness.like_states s
  JOIN whaleu_post_hotness.like_memberships m ON m.post_id=NEW.post_id AND m.actor_id=NEW.actor_id
  WHERE s.post_id=NEW.post_id AND s.last_receipt_id=NEW.source_id
   AND s.count=NEW.after_count AND s.last_sequence=NEW.source_sequence
   AND m.last_receipt_id=NEW.source_id AND m.last_sequence=NEW.source_sequence
   AND m.active_like_id IS NOT DISTINCT FROM CASE NEW.transition WHEN 'liked' THEN NEW.like_id ELSE NULL END) THEN
  RAISE EXCEPTION 'Like receipt, count and membership must commit atomically' USING ERRCODE='23514';
 END IF; RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER like_receipt_complete AFTER INSERT ON whaleu_post_hotness.like_receipts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_post_hotness.like_receipt_complete();
