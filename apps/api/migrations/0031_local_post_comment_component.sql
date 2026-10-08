-- Independent internal comment/reply component. Fresh native posts only;
-- no historical enrollment, public counters, score, policy change or processing.
CREATE SEQUENCE whaleu_post_hotness.comment_source_sequence AS bigint MINVALUE 1;
CREATE TABLE whaleu_post_hotness.comment_baselines (
 post_id uuid PRIMARY KEY REFERENCES whaleu_community.posts(id),
 component_version smallint NOT NULL DEFAULT 1 CHECK(component_version=1),
 origin text NOT NULL DEFAULT 'native_post_creation' CHECK(origin='native_post_creation'),
 opening_root_count bigint NOT NULL DEFAULT 0 CHECK(opening_root_count=0),
 opening_reply_count bigint NOT NULL DEFAULT 0 CHECK(opening_reply_count=0),
 opening_eligible_count bigint NOT NULL DEFAULT 0 CHECK(opening_eligible_count=0),
 opening_unique_actor_count bigint NOT NULL DEFAULT 0 CHECK(opening_unique_actor_count=0),
 owner_id uuid NOT NULL, source_request_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 creation_xid xid8 NOT NULL DEFAULT pg_current_xact_id()
);
CREATE TABLE whaleu_post_hotness.comment_states (
 post_id uuid PRIMARY KEY REFERENCES whaleu_post_hotness.comment_baselines(post_id),
 root_count bigint NOT NULL DEFAULT 0 CHECK(root_count>=0),
 reply_count bigint NOT NULL DEFAULT 0 CHECK(reply_count>=0),
 eligible_count bigint NOT NULL DEFAULT 0 CHECK(eligible_count>=0),
 unique_actor_count bigint NOT NULL DEFAULT 0 CHECK(unique_actor_count>=0),
 last_sequence bigint NOT NULL DEFAULT 0 CHECK(last_sequence>=0), last_receipt_id uuid,
 CHECK(eligible_count<=root_count+reply_count AND unique_actor_count<=eligible_count),
 CHECK((last_sequence=0)=(last_receipt_id IS NULL))
);
CREATE TABLE whaleu_post_hotness.comment_sources (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 post_id uuid NOT NULL REFERENCES whaleu_post_hotness.comment_baselines(post_id),
 actor_id uuid NOT NULL, kind text NOT NULL CHECK(kind IN ('root','reply')),
 content_id uuid NOT NULL, root_id uuid,
 transition text NOT NULL CHECK(transition IN ('created','deleted')),
 delta smallint NOT NULL CHECK((transition='created' AND delta=1) OR (transition='deleted' AND delta=-1)),
 source_sequence bigint NOT NULL UNIQUE CHECK(source_sequence>0),
 source_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 positive_source_id uuid REFERENCES whaleu_post_hotness.comment_sources(id),
 UNIQUE(kind,content_id,transition),
 CHECK((kind='root')=(root_id IS NULL)),
 CHECK((transition='created' AND positive_source_id IS NULL) OR (transition='deleted' AND positive_source_id IS NOT NULL))
);
CREATE INDEX comment_source_post_order ON whaleu_post_hotness.comment_sources(post_id,source_sequence);
CREATE TABLE whaleu_post_hotness.comment_contributions (
 post_id uuid NOT NULL REFERENCES whaleu_post_hotness.comment_baselines(post_id),
 kind text NOT NULL CHECK(kind IN ('root','reply')), content_id uuid NOT NULL, root_id uuid,
 actor_id uuid NOT NULL, eligible boolean NOT NULL, active boolean NOT NULL,
 positive_source_id uuid NOT NULL REFERENCES whaleu_post_hotness.comment_sources(id),
 last_sequence bigint NOT NULL CHECK(last_sequence>0), last_receipt_id uuid NOT NULL,
 PRIMARY KEY(post_id,kind,content_id), CHECK((kind='root')=(root_id IS NULL))
);
CREATE TABLE whaleu_post_hotness.comment_memberships (
 post_id uuid NOT NULL REFERENCES whaleu_post_hotness.comment_baselines(post_id),
 actor_id uuid NOT NULL, active_count bigint NOT NULL CHECK(active_count>=0),
 last_sequence bigint NOT NULL CHECK(last_sequence>0), last_receipt_id uuid NOT NULL,
 PRIMARY KEY(post_id,actor_id)
);
CREATE TABLE whaleu_post_hotness.comment_receipts (
 source_id uuid PRIMARY KEY REFERENCES whaleu_post_hotness.comment_sources(id),
 post_id uuid NOT NULL REFERENCES whaleu_post_hotness.comment_baselines(post_id),
 actor_id uuid NOT NULL, kind text NOT NULL CHECK(kind IN ('root','reply')), content_id uuid NOT NULL, root_id uuid,
 transition text NOT NULL CHECK(transition IN ('created','deleted')),
 source_sequence bigint NOT NULL CHECK(source_sequence>0),
 positive_source_id uuid REFERENCES whaleu_post_hotness.comment_sources(id),
 component_version smallint NOT NULL DEFAULT 1 CHECK(component_version=1),
 eligible boolean NOT NULL, delta smallint NOT NULL CHECK(delta IN (-1,1)),
 before_root_count bigint NOT NULL CHECK(before_root_count>=0), after_root_count bigint NOT NULL CHECK(after_root_count>=0),
 before_reply_count bigint NOT NULL CHECK(before_reply_count>=0), after_reply_count bigint NOT NULL CHECK(after_reply_count>=0),
 before_eligible_count bigint NOT NULL CHECK(before_eligible_count>=0), after_eligible_count bigint NOT NULL CHECK(after_eligible_count>=0),
 before_unique_actor_count bigint NOT NULL CHECK(before_unique_actor_count>=0), after_unique_actor_count bigint NOT NULL CHECK(after_unique_actor_count>=0),
 before_actor_count bigint NOT NULL CHECK(before_actor_count>=0), after_actor_count bigint NOT NULL CHECK(after_actor_count>=0),
 previous_state_sequence bigint NOT NULL CHECK(previous_state_sequence>=0),
 previous_contribution_sequence bigint NOT NULL CHECK(previous_contribution_sequence>=0),
 previous_contribution_active boolean,
 previous_membership_sequence bigint NOT NULL CHECK(previous_membership_sequence>=0),
 application_xid xid8 NOT NULL DEFAULT pg_current_xact_id(), applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 -- Exactly one selected source per post/transaction permits exact deferred effects.
 UNIQUE(post_id,application_xid),
 CHECK((kind='root')=(root_id IS NULL)),
 CHECK((transition='created' AND delta=1 AND positive_source_id IS NULL) OR (transition='deleted' AND delta=-1 AND positive_source_id IS NOT NULL)),
 CHECK(after_root_count=before_root_count+CASE kind WHEN 'root' THEN delta ELSE 0 END),
 CHECK(after_reply_count=before_reply_count+CASE kind WHEN 'reply' THEN delta ELSE 0 END),
 CHECK(after_eligible_count=before_eligible_count+CASE WHEN eligible THEN delta ELSE 0 END),
 CHECK(after_actor_count=before_actor_count+delta),
 CHECK(after_unique_actor_count=before_unique_actor_count+CASE WHEN NOT eligible THEN 0 WHEN before_actor_count=0 THEN 1 WHEN after_actor_count=0 THEN -1 ELSE 0 END),
 CHECK(before_eligible_count<=before_root_count+before_reply_count AND before_unique_actor_count<=before_eligible_count),
 CHECK(after_eligible_count<=after_root_count+after_reply_count AND after_unique_actor_count<=after_eligible_count),
 CHECK(source_sequence>previous_state_sequence AND source_sequence>previous_contribution_sequence AND source_sequence>previous_membership_sequence)
);
ALTER TABLE whaleu_post_hotness.comment_states ADD FOREIGN KEY(last_receipt_id) REFERENCES whaleu_post_hotness.comment_receipts(source_id);
ALTER TABLE whaleu_post_hotness.comment_contributions ADD FOREIGN KEY(last_receipt_id) REFERENCES whaleu_post_hotness.comment_receipts(source_id);
ALTER TABLE whaleu_post_hotness.comment_memberships ADD FOREIGN KEY(last_receipt_id) REFERENCES whaleu_post_hotness.comment_receipts(source_id);

CREATE FUNCTION whaleu_post_hotness.comment_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Comment evidence is retained and immutable; truncate bypass is forbidden' USING ERRCODE='23514'; END $$;
CREATE TRIGGER comment_baseline_immutable BEFORE UPDATE OR DELETE ON whaleu_post_hotness.comment_baselines FOR EACH ROW EXECUTE FUNCTION whaleu_post_hotness.comment_immutable();
CREATE TRIGGER comment_source_immutable BEFORE UPDATE OR DELETE ON whaleu_post_hotness.comment_sources FOR EACH ROW EXECUTE FUNCTION whaleu_post_hotness.comment_immutable();
CREATE TRIGGER comment_receipt_immutable BEFORE UPDATE OR DELETE ON whaleu_post_hotness.comment_receipts FOR EACH ROW EXECUTE FUNCTION whaleu_post_hotness.comment_immutable();
CREATE TRIGGER comment_baseline_no_truncate BEFORE TRUNCATE ON whaleu_post_hotness.comment_baselines FOR EACH STATEMENT EXECUTE FUNCTION whaleu_post_hotness.comment_immutable();
CREATE TRIGGER comment_source_no_truncate BEFORE TRUNCATE ON whaleu_post_hotness.comment_sources FOR EACH STATEMENT EXECUTE FUNCTION whaleu_post_hotness.comment_immutable();
CREATE TRIGGER comment_receipt_no_truncate BEFORE TRUNCATE ON whaleu_post_hotness.comment_receipts FOR EACH STATEMENT EXECUTE FUNCTION whaleu_post_hotness.comment_immutable();
CREATE TRIGGER comment_state_no_truncate BEFORE TRUNCATE ON whaleu_post_hotness.comment_states FOR EACH STATEMENT EXECUTE FUNCTION whaleu_post_hotness.comment_immutable();
CREATE TRIGGER comment_contribution_no_truncate BEFORE TRUNCATE ON whaleu_post_hotness.comment_contributions FOR EACH STATEMENT EXECUTE FUNCTION whaleu_post_hotness.comment_immutable();
CREATE TRIGGER comment_membership_no_truncate BEFORE TRUNCATE ON whaleu_post_hotness.comment_memberships FOR EACH STATEMENT EXECUTE FUNCTION whaleu_post_hotness.comment_immutable();
CREATE TRIGGER comment_root_no_truncate BEFORE TRUNCATE ON whaleu_community.root_comments FOR EACH STATEMENT EXECUTE FUNCTION whaleu_post_hotness.comment_immutable();
CREATE TRIGGER comment_reply_no_truncate BEFORE TRUNCATE ON whaleu_community.replies FOR EACH STATEMENT EXECUTE FUNCTION whaleu_post_hotness.comment_immutable();

CREATE FUNCTION whaleu_post_hotness.comment_baseline_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM whaleu_community.posts p
   JOIN whaleu_community.report_origins o ON o.kind='post' AND o.target_id=p.id
   JOIN whaleu_community.publication_requests r ON r.account_id=o.owner_account_id AND r.client_request_id=o.source_request_id
   WHERE p.id=NEW.post_id AND p.account_id=NEW.owner_id AND p.local_creation_transaction=pg_current_xact_id()
    AND o.owner_account_id=NEW.owner_id AND o.source_request_id=NEW.source_request_id AND o.provenance='native_publication'
    AND r.operation='publish_post' AND r.receipt->>'outcome'='created'
    AND r.receipt->>'resourceId'=p.id::text AND r.receipt->>'requestId'=NEW.source_request_id::text
    AND r.receipt->>'operation'='publish_post')
   OR EXISTS(SELECT 1 FROM whaleu_community.root_comments WHERE post_id=NEW.post_id)
   OR EXISTS(SELECT 1 FROM whaleu_community.replies WHERE post_id=NEW.post_id)
   OR EXISTS(SELECT 1 FROM whaleu_post_hotness.comment_sources WHERE post_id=NEW.post_id) THEN
   RAISE EXCEPTION 'Comment baseline requires fresh exact native publication with no discussion or captured history' USING ERRCODE='23514';
 END IF;
 NEW.creation_xid:=pg_current_xact_id(); NEW.created_at:=clock_timestamp(); RETURN NEW;
END $$;
CREATE TRIGGER comment_baseline_guard BEFORE INSERT ON whaleu_post_hotness.comment_baselines FOR EACH ROW EXECUTE FUNCTION whaleu_post_hotness.comment_baseline_guard();
CREATE FUNCTION whaleu_post_hotness.comment_publication_complete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.kind='post' AND NEW.provenance='native_publication'
  AND EXISTS(SELECT 1 FROM whaleu_community.posts WHERE id=NEW.target_id AND local_creation_transaction=pg_current_xact_id())
  AND NOT EXISTS(SELECT 1 FROM whaleu_post_hotness.comment_baselines b JOIN whaleu_post_hotness.comment_states s USING(post_id)
   WHERE b.post_id=NEW.target_id AND b.owner_id=NEW.owner_account_id AND b.source_request_id=NEW.source_request_id AND b.creation_xid=pg_current_xact_id()) THEN
  RAISE EXCEPTION 'Fresh native publication requires comment enrollment' USING ERRCODE='23514';
 END IF; RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER comment_publication_complete AFTER INSERT ON whaleu_community.report_origins DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_post_hotness.comment_publication_complete();
CREATE FUNCTION whaleu_post_hotness.comment_baseline_complete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM whaleu_post_hotness.comment_states WHERE post_id=NEW.post_id) THEN
  RAISE EXCEPTION 'Comment baseline requires state' USING ERRCODE='23514';
 END IF; RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER comment_baseline_complete AFTER INSERT ON whaleu_post_hotness.comment_baselines DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_post_hotness.comment_baseline_complete();
CREATE FUNCTION whaleu_post_hotness.comment_post_owner_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.account_id IS DISTINCT FROM OLD.account_id AND EXISTS(SELECT 1 FROM whaleu_post_hotness.comment_baselines WHERE post_id=OLD.id) THEN
  RAISE EXCEPTION 'Enrolled comment post ownership is immutable' USING ERRCODE='23514';
 END IF; RETURN NEW;
END $$;
CREATE TRIGGER comment_post_owner_guard BEFORE UPDATE ON whaleu_community.posts FOR EACH ROW EXECUTE FUNCTION whaleu_post_hotness.comment_post_owner_guard();

-- This early admission must precede saved_discussion_order. AFTER-only NOWAIT
-- cannot prevent the earlier saved-order/FK/unique-key wait inversion.
CREATE FUNCTION whaleu_post_hotness.comment_content_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_post uuid;
BEGIN
 IF TG_OP='INSERT' THEN
  target_post:=NEW.post_id;
  IF NOT EXISTS(SELECT 1 FROM whaleu_community.posts WHERE id=target_post) THEN
   RAISE EXCEPTION 'Comment parent must be visible; retry after publication commits' USING ERRCODE='23514';
  END IF;
 ELSE target_post:=OLD.post_id;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM whaleu_post_hotness.comment_baselines WHERE post_id=target_post) THEN
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
 END IF;
 -- Normal owners already hold the parent. A raw child writer may hold its own
 -- tuple lock; fail fast rather than introducing child -> parent waiting.
 PERFORM 1 FROM whaleu_community.posts WHERE id=target_post FOR UPDATE NOWAIT;
 IF TG_OP='DELETE' THEN
  RAISE EXCEPTION 'Enrolled comment records are retained' USING ERRCODE='23514';
 ELSIF TG_OP='INSERT' THEN
  IF NEW.deleted_at IS NOT NULL THEN
   RAISE EXCEPTION 'Enrolled comment creation must be live' USING ERRCODE='23514';
  END IF;
 ELSE
  IF (NEW.id,NEW.post_id,NEW.account_id) IS DISTINCT FROM (OLD.id,OLD.post_id,OLD.account_id)
   OR (OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at) THEN
   RAISE EXCEPTION 'Enrolled comment identity and tombstones are retained' USING ERRCODE='23514';
  END IF;
  IF TG_TABLE_NAME='replies' THEN
   IF NEW.root_comment_id IS DISTINCT FROM OLD.root_comment_id THEN
    RAISE EXCEPTION 'Enrolled reply root is immutable' USING ERRCODE='23514';
   END IF;
  END IF;
 END IF; RETURN NEW;
END $$;
CREATE TRIGGER a_comment_content_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_community.root_comments FOR EACH ROW EXECUTE FUNCTION whaleu_post_hotness.comment_content_guard();
CREATE TRIGGER a_comment_content_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_community.replies FOR EACH ROW EXECUTE FUNCTION whaleu_post_hotness.comment_content_guard();

-- Depth is a trusted-installed-schema assertion, not a capability against a
-- database owner capable of changing triggers. No request/outbox is evidence.
CREATE FUNCTION whaleu_post_hotness.comment_source_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE positive whaleu_post_hotness.comment_sources; stored record;
BEGIN
 IF pg_trigger_depth()<>2 THEN
  RAISE EXCEPTION 'Comment source requires an actual content transition' USING ERRCODE='23514';
 END IF;
 PERFORM 1 FROM whaleu_community.posts WHERE id=NEW.post_id FOR UPDATE NOWAIT;
 IF NEW.kind='root' THEN
  SELECT id,post_id,account_id,NULL::uuid AS root_id,deleted_at,local_creation_transaction,local_deletion_transaction INTO stored
   FROM whaleu_community.root_comments WHERE id=NEW.content_id;
 ELSIF NEW.kind='reply' THEN
  SELECT id,post_id,account_id,root_comment_id AS root_id,deleted_at,local_creation_transaction,local_deletion_transaction INTO stored
   FROM whaleu_community.replies WHERE id=NEW.content_id;
 ELSE RAISE EXCEPTION 'Unknown comment kind' USING ERRCODE='23514';
 END IF;
 IF stored.id IS NULL OR (stored.post_id,stored.account_id,stored.root_id) IS DISTINCT FROM (NEW.post_id,NEW.actor_id,NEW.root_id) THEN
  RAISE EXCEPTION 'Comment source identity mismatch' USING ERRCODE='23514';
 END IF;
 IF NEW.transition='created' THEN
  IF NEW.delta<>1 OR NEW.positive_source_id IS NOT NULL OR stored.deleted_at IS NOT NULL OR stored.local_creation_transaction IS DISTINCT FROM pg_current_xact_id() THEN
   RAISE EXCEPTION 'Positive comment source requires actual live fresh creation' USING ERRCODE='23514';
  END IF;
 ELSIF NEW.transition='deleted' THEN
  SELECT * INTO positive FROM whaleu_post_hotness.comment_sources WHERE id=NEW.positive_source_id;
  IF positive.id IS NULL OR NEW.delta<>-1 OR stored.deleted_at IS NULL OR stored.local_deletion_transaction IS DISTINCT FROM pg_current_xact_id()
   OR (positive.post_id,positive.actor_id,positive.kind,positive.content_id,positive.root_id,positive.transition)
    IS DISTINCT FROM (NEW.post_id,NEW.actor_id,NEW.kind,NEW.content_id,NEW.root_id,'created'::text) THEN
   RAISE EXCEPTION 'Negative comment source requires exact positive and actual deletion provenance' USING ERRCODE='23514';
  END IF;
 ELSE RAISE EXCEPTION 'Unknown comment transition' USING ERRCODE='23514';
 END IF;
 NEW.source_sequence:=nextval('whaleu_post_hotness.comment_source_sequence');
 IF positive.id IS NOT NULL AND NEW.source_sequence<=positive.source_sequence THEN
  RAISE EXCEPTION 'Comment deletion must follow creation' USING ERRCODE='23514';
 END IF;
 NEW.source_transaction:=pg_current_xact_id(); NEW.captured_at:=clock_timestamp(); RETURN NEW;
END $$;
CREATE TRIGGER comment_source_guard BEFORE INSERT ON whaleu_post_hotness.comment_sources FOR EACH ROW EXECUTE FUNCTION whaleu_post_hotness.comment_source_guard();
CREATE FUNCTION whaleu_post_hotness.capture_comment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE content_kind text; parent_root uuid; positive_id uuid;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM whaleu_post_hotness.comment_baselines WHERE post_id=NEW.post_id) THEN RETURN NULL; END IF;
 IF TG_OP='UPDATE' THEN
  IF OLD.deleted_at IS NOT NULL OR NEW.deleted_at IS NULL THEN RETURN NULL; END IF;
 END IF;
 PERFORM 1 FROM whaleu_community.posts WHERE id=NEW.post_id FOR UPDATE NOWAIT;
 IF TG_TABLE_NAME='root_comments' THEN content_kind:='root'; parent_root:=NULL;
 ELSE content_kind:='reply'; parent_root:=NEW.root_comment_id; END IF;
 IF TG_OP='INSERT' THEN
  INSERT INTO whaleu_post_hotness.comment_sources(post_id,actor_id,kind,content_id,root_id,transition,delta)
   VALUES(NEW.post_id,NEW.account_id,content_kind,NEW.id,parent_root,'created',1);
 ELSE
  SELECT id INTO positive_id FROM whaleu_post_hotness.comment_sources WHERE kind=content_kind AND content_id=NEW.id AND transition='created';
  IF positive_id IS NULL THEN
   RAISE EXCEPTION 'Deleted enrolled content requires retained positive evidence' USING ERRCODE='23514';
  END IF;
  INSERT INTO whaleu_post_hotness.comment_sources(post_id,actor_id,kind,content_id,root_id,transition,delta,positive_source_id)
   VALUES(NEW.post_id,NEW.account_id,content_kind,NEW.id,parent_root,'deleted',-1,positive_id);
 END IF; RETURN NULL;
END $$;
CREATE TRIGGER comment_capture_content AFTER INSERT OR UPDATE ON whaleu_community.root_comments FOR EACH ROW EXECUTE FUNCTION whaleu_post_hotness.capture_comment();
CREATE TRIGGER comment_capture_content AFTER INSERT OR UPDATE ON whaleu_community.replies FOR EACH ROW EXECUTE FUNCTION whaleu_post_hotness.capture_comment();

CREATE FUNCTION whaleu_post_hotness.comment_receipt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE src whaleu_post_hotness.comment_sources; st whaleu_post_hotness.comment_states;
 contribution whaleu_post_hotness.comment_contributions; member whaleu_post_hotness.comment_memberships; owner uuid;
BEGIN
 -- Parent -> aggregate -> contribution -> actor cardinality. Never lock live
 -- content, identity, policy, saved, experience or notification records here.
 PERFORM 1 FROM whaleu_community.posts WHERE id=NEW.post_id FOR UPDATE;
 SELECT owner_id INTO owner FROM whaleu_post_hotness.comment_baselines WHERE post_id=NEW.post_id;
 SELECT * INTO st FROM whaleu_post_hotness.comment_states WHERE post_id=NEW.post_id FOR UPDATE;
 SELECT * INTO contribution FROM whaleu_post_hotness.comment_contributions WHERE post_id=NEW.post_id AND kind=NEW.kind AND content_id=NEW.content_id FOR UPDATE;
 SELECT * INTO member FROM whaleu_post_hotness.comment_memberships WHERE post_id=NEW.post_id AND actor_id=NEW.actor_id FOR UPDATE;
 SELECT * INTO src FROM whaleu_post_hotness.comment_sources WHERE id=NEW.source_id;
 IF st.post_id IS NULL OR owner IS NULL OR src.id IS NULL OR
  (src.post_id,src.actor_id,src.kind,src.content_id,src.root_id,src.transition,src.delta,src.source_sequence,src.positive_source_id)
   IS DISTINCT FROM (NEW.post_id,NEW.actor_id,NEW.kind,NEW.content_id,NEW.root_id,NEW.transition,NEW.delta,NEW.source_sequence,NEW.positive_source_id) OR
  (st.root_count,st.reply_count,st.eligible_count,st.unique_actor_count,st.last_sequence)
   IS DISTINCT FROM (NEW.before_root_count,NEW.before_reply_count,NEW.before_eligible_count,NEW.before_unique_actor_count,NEW.previous_state_sequence) OR
  NEW.eligible IS DISTINCT FROM (NEW.actor_id<>owner) OR
  coalesce(contribution.last_sequence,0)<>NEW.previous_contribution_sequence OR contribution.active IS DISTINCT FROM NEW.previous_contribution_active OR
  coalesce(member.last_sequence,0)<>NEW.previous_membership_sequence OR coalesce(member.active_count,0)<>NEW.before_actor_count OR
  NEW.source_sequence<=st.last_sequence OR NEW.source_sequence<=coalesce(contribution.last_sequence,0) OR NEW.source_sequence<=coalesce(member.last_sequence,0) OR
  EXISTS(SELECT 1 FROM whaleu_post_hotness.comment_sources earlier WHERE earlier.post_id=NEW.post_id AND earlier.source_sequence<NEW.source_sequence
   AND NOT EXISTS(SELECT 1 FROM whaleu_post_hotness.comment_receipts r WHERE r.source_id=earlier.id)) OR
  (NEW.transition='created' AND contribution.post_id IS NOT NULL) OR
  (NEW.transition='deleted' AND (contribution.active IS DISTINCT FROM true OR
   (contribution.actor_id,contribution.root_id,contribution.eligible,contribution.positive_source_id)
    IS DISTINCT FROM (NEW.actor_id,NEW.root_id,NEW.eligible,NEW.positive_source_id) OR coalesce(member.active_count,0)<=0)) THEN
  RAISE EXCEPTION 'Comment receipt lacks exact source, cardinality and causal pre-state' USING ERRCODE='23514';
 END IF;
 NEW.application_xid:=pg_current_xact_id(); NEW.applied_at:=clock_timestamp(); RETURN NEW;
END $$;
CREATE TRIGGER comment_receipt_guard BEFORE INSERT ON whaleu_post_hotness.comment_receipts FOR EACH ROW EXECUTE FUNCTION whaleu_post_hotness.comment_receipt_guard();

CREATE FUNCTION whaleu_post_hotness.comment_state_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r whaleu_post_hotness.comment_receipts;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Comment state is retained' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN
  IF (NEW.root_count,NEW.reply_count,NEW.eligible_count,NEW.unique_actor_count,NEW.last_sequence) IS DISTINCT FROM (0::bigint,0::bigint,0::bigint,0::bigint,0::bigint)
   OR NEW.last_receipt_id IS NOT NULL OR NOT EXISTS(SELECT 1 FROM whaleu_post_hotness.comment_baselines WHERE post_id=NEW.post_id AND creation_xid=pg_current_xact_id()) THEN
   RAISE EXCEPTION 'Comment initial state requires fresh zero baseline' USING ERRCODE='23514';
  END IF;
 ELSE
  SELECT * INTO r FROM whaleu_post_hotness.comment_receipts WHERE source_id=NEW.last_receipt_id AND application_xid=pg_current_xact_id();
  IF r.source_id IS NULL OR NEW.post_id<>OLD.post_id OR
   (r.post_id,r.before_root_count,r.before_reply_count,r.before_eligible_count,r.before_unique_actor_count,r.previous_state_sequence)
    IS DISTINCT FROM (OLD.post_id,OLD.root_count,OLD.reply_count,OLD.eligible_count,OLD.unique_actor_count,OLD.last_sequence) OR
   (r.after_root_count,r.after_reply_count,r.after_eligible_count,r.after_unique_actor_count,r.source_sequence)
    IS DISTINCT FROM (NEW.root_count,NEW.reply_count,NEW.eligible_count,NEW.unique_actor_count,NEW.last_sequence) OR NEW.last_sequence<=OLD.last_sequence THEN
   RAISE EXCEPTION 'Comment state requires exact receipt transition' USING ERRCODE='23514';
  END IF;
 END IF; RETURN NEW;
END $$;
CREATE TRIGGER comment_state_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_post_hotness.comment_states FOR EACH ROW EXECUTE FUNCTION whaleu_post_hotness.comment_state_guard();
CREATE FUNCTION whaleu_post_hotness.comment_contribution_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r whaleu_post_hotness.comment_receipts;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Comment contribution is retained' USING ERRCODE='23514'; END IF;
 SELECT * INTO r FROM whaleu_post_hotness.comment_receipts WHERE source_id=NEW.last_receipt_id AND application_xid=pg_current_xact_id();
 IF r.source_id IS NULL OR
  (r.post_id,r.kind,r.content_id,r.root_id,r.actor_id,r.eligible,r.source_sequence)
   IS DISTINCT FROM (NEW.post_id,NEW.kind,NEW.content_id,NEW.root_id,NEW.actor_id,NEW.eligible,NEW.last_sequence) OR
  NEW.active IS DISTINCT FROM (r.transition='created') OR
  NEW.positive_source_id IS DISTINCT FROM (CASE r.transition WHEN 'created' THEN r.source_id ELSE r.positive_source_id END) THEN
  RAISE EXCEPTION 'Comment contribution requires exact receipt identity' USING ERRCODE='23514';
 END IF;
 IF TG_OP='INSERT' THEN
  IF r.transition<>'created' OR r.previous_contribution_sequence<>0 OR r.previous_contribution_active IS NOT NULL THEN
   RAISE EXCEPTION 'Comment contribution requires first positive receipt' USING ERRCODE='23514';
  END IF;
 ELSIF r.transition<>'deleted' OR
  (OLD.post_id,OLD.kind,OLD.content_id,OLD.root_id,OLD.actor_id,OLD.eligible,OLD.positive_source_id,OLD.last_sequence,OLD.active)
   IS DISTINCT FROM (NEW.post_id,NEW.kind,NEW.content_id,NEW.root_id,NEW.actor_id,NEW.eligible,NEW.positive_source_id,r.previous_contribution_sequence,r.previous_contribution_active)
  OR NEW.last_sequence<=OLD.last_sequence THEN
  RAISE EXCEPTION 'Comment contribution pre-state mismatch' USING ERRCODE='23514';
 END IF; RETURN NEW;
END $$;
CREATE TRIGGER comment_contribution_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_post_hotness.comment_contributions FOR EACH ROW EXECUTE FUNCTION whaleu_post_hotness.comment_contribution_guard();
CREATE FUNCTION whaleu_post_hotness.comment_membership_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r whaleu_post_hotness.comment_receipts;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Comment actor cardinality is retained' USING ERRCODE='23514'; END IF;
 SELECT * INTO r FROM whaleu_post_hotness.comment_receipts WHERE source_id=NEW.last_receipt_id AND application_xid=pg_current_xact_id();
 IF r.source_id IS NULL OR (r.post_id,r.actor_id,r.after_actor_count,r.source_sequence)
  IS DISTINCT FROM (NEW.post_id,NEW.actor_id,NEW.active_count,NEW.last_sequence) THEN
  RAISE EXCEPTION 'Comment actor cardinality requires exact receipt' USING ERRCODE='23514';
 END IF;
 IF TG_OP='INSERT' THEN
  IF r.transition<>'created' OR r.previous_membership_sequence<>0 OR r.before_actor_count<>0 THEN
   RAISE EXCEPTION 'Comment actor requires first positive receipt' USING ERRCODE='23514';
  END IF;
 ELSIF (OLD.post_id,OLD.actor_id,OLD.last_sequence,OLD.active_count)
  IS DISTINCT FROM (NEW.post_id,NEW.actor_id,r.previous_membership_sequence,r.before_actor_count) OR NEW.last_sequence<=OLD.last_sequence THEN
  RAISE EXCEPTION 'Comment actor cardinality pre-state mismatch' USING ERRCODE='23514';
 END IF; RETURN NEW;
END $$;
CREATE TRIGGER comment_membership_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_post_hotness.comment_memberships FOR EACH ROW EXECUTE FUNCTION whaleu_post_hotness.comment_membership_guard();

CREATE FUNCTION whaleu_post_hotness.comment_receipt_complete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM whaleu_post_hotness.comment_states s
  JOIN whaleu_post_hotness.comment_contributions c ON c.post_id=NEW.post_id AND c.kind=NEW.kind AND c.content_id=NEW.content_id
  JOIN whaleu_post_hotness.comment_memberships m ON m.post_id=NEW.post_id AND m.actor_id=NEW.actor_id
  WHERE s.post_id=NEW.post_id AND s.last_receipt_id=NEW.source_id AND s.last_sequence=NEW.source_sequence
   AND (s.root_count,s.reply_count,s.eligible_count,s.unique_actor_count)=(NEW.after_root_count,NEW.after_reply_count,NEW.after_eligible_count,NEW.after_unique_actor_count)
   AND c.last_receipt_id=NEW.source_id AND c.last_sequence=NEW.source_sequence
   AND c.actor_id=NEW.actor_id AND c.root_id IS NOT DISTINCT FROM NEW.root_id AND c.eligible=NEW.eligible
   AND c.active=(NEW.transition='created') AND c.positive_source_id=CASE NEW.transition WHEN 'created' THEN NEW.source_id ELSE NEW.positive_source_id END
   AND m.last_receipt_id=NEW.source_id AND m.last_sequence=NEW.source_sequence AND m.active_count=NEW.after_actor_count) THEN
  RAISE EXCEPTION 'Comment receipt, state, contribution and actor cardinality must commit atomically' USING ERRCODE='23514';
 END IF; RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER comment_receipt_complete AFTER INSERT ON whaleu_post_hotness.comment_receipts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_post_hotness.comment_receipt_complete();
