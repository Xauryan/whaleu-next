-- Fresh native posts only. This internal component is not a public hot score.
-- No historical enrollment, import, grants, dispatcher or production cutover.
CREATE SCHEMA whaleu_post_hotness;

CREATE TABLE whaleu_post_hotness.subscription_baselines (
 post_id uuid PRIMARY KEY REFERENCES whaleu_community.posts(id),
 component_version smallint NOT NULL DEFAULT 1 CHECK(component_version=1),
 origin text NOT NULL DEFAULT 'native_post_creation' CHECK(origin='native_post_creation'),
 opening_count bigint NOT NULL DEFAULT 0 CHECK(opening_count=0),
 owner_id uuid NOT NULL, source_request_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 creation_xid xid8 NOT NULL DEFAULT pg_current_xact_id()
);
CREATE TABLE whaleu_post_hotness.subscription_states (
 post_id uuid PRIMARY KEY REFERENCES whaleu_post_hotness.subscription_baselines(post_id),
 count bigint NOT NULL DEFAULT 0 CHECK(count>=0),
 last_sequence bigint NOT NULL DEFAULT 0 CHECK(last_sequence>=0),
 last_receipt_id uuid,
 CHECK((last_sequence=0)=(last_receipt_id IS NULL))
);
CREATE TABLE whaleu_post_hotness.subscription_sources (
 epoch_id uuid NOT NULL REFERENCES whaleu_community.saved_epochs(id),
 transition text NOT NULL CHECK(transition IN ('saved','unsaved')),
 post_id uuid NOT NULL REFERENCES whaleu_post_hotness.subscription_baselines(post_id),
 actor_id uuid NOT NULL, source_sequence bigint NOT NULL UNIQUE CHECK(source_sequence>0),
 source_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 PRIMARY KEY(epoch_id,transition)
);
CREATE INDEX subscription_source_post_order ON whaleu_post_hotness.subscription_sources(post_id,source_sequence);
CREATE TABLE whaleu_post_hotness.subscription_memberships (
 post_id uuid NOT NULL REFERENCES whaleu_post_hotness.subscription_baselines(post_id),
 actor_id uuid NOT NULL, active_epoch_id uuid REFERENCES whaleu_community.saved_epochs(id),
 last_sequence bigint NOT NULL CHECK(last_sequence>0), last_receipt_id uuid NOT NULL,
 PRIMARY KEY(post_id,actor_id)
);
CREATE TABLE whaleu_post_hotness.subscription_receipts (
 obligation_id uuid PRIMARY KEY REFERENCES whaleu_community.saved_obligations(id),
 epoch_id uuid NOT NULL, transition text NOT NULL,
 post_id uuid NOT NULL REFERENCES whaleu_post_hotness.subscription_baselines(post_id),
 actor_id uuid NOT NULL, source_sequence bigint NOT NULL CHECK(source_sequence>0),
 component_version smallint NOT NULL DEFAULT 1 CHECK(component_version=1),
 delta smallint NOT NULL CHECK(delta IN (-1,1)),
 before_count bigint NOT NULL CHECK(before_count>=0), after_count bigint NOT NULL CHECK(after_count>=0),
 previous_state_sequence bigint NOT NULL CHECK(previous_state_sequence>=0),
 previous_membership_sequence bigint NOT NULL CHECK(previous_membership_sequence>=0),
 previous_membership_epoch uuid,
 application_xid xid8 NOT NULL DEFAULT pg_current_xact_id(), applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(epoch_id,transition), UNIQUE(post_id,application_xid),
 FOREIGN KEY(epoch_id,transition) REFERENCES whaleu_post_hotness.subscription_sources(epoch_id,transition),
 CHECK(after_count=before_count+delta),
 CHECK((transition='saved' AND delta=1) OR (transition='unsaved' AND delta=-1)),
 CHECK(source_sequence>previous_state_sequence AND source_sequence>previous_membership_sequence)
);
ALTER TABLE whaleu_post_hotness.subscription_states ADD FOREIGN KEY(last_receipt_id) REFERENCES whaleu_post_hotness.subscription_receipts(obligation_id);
ALTER TABLE whaleu_post_hotness.subscription_memberships ADD FOREIGN KEY(last_receipt_id) REFERENCES whaleu_post_hotness.subscription_receipts(obligation_id);

CREATE FUNCTION whaleu_post_hotness.immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Subscription evidence is immutable' USING ERRCODE='23514'; END $$;
CREATE TRIGGER subscription_baseline_immutable BEFORE UPDATE OR DELETE ON whaleu_post_hotness.subscription_baselines FOR EACH ROW EXECUTE FUNCTION whaleu_post_hotness.immutable();
CREATE TRIGGER subscription_source_immutable BEFORE UPDATE OR DELETE ON whaleu_post_hotness.subscription_sources FOR EACH ROW EXECUTE FUNCTION whaleu_post_hotness.immutable();
CREATE TRIGGER subscription_receipt_immutable BEFORE UPDATE OR DELETE ON whaleu_post_hotness.subscription_receipts FOR EACH ROW EXECUTE FUNCTION whaleu_post_hotness.immutable();

CREATE FUNCTION whaleu_post_hotness.baseline_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM whaleu_community.posts p
   JOIN whaleu_community.report_origins o ON o.kind='post' AND o.target_id=p.id
   JOIN whaleu_community.publication_requests r ON r.account_id=o.owner_account_id AND r.client_request_id=o.source_request_id
   WHERE p.id=NEW.post_id AND p.account_id=NEW.owner_id AND p.local_creation_transaction=pg_current_xact_id()
    AND o.owner_account_id=NEW.owner_id AND o.source_request_id=NEW.source_request_id AND o.provenance='native_publication'
    AND r.operation='publish_post' AND r.receipt->>'outcome'='created'
    AND r.receipt->>'resourceId'=p.id::text AND r.receipt->>'requestId'=NEW.source_request_id::text
    AND r.receipt->>'operation'='publish_post')
   OR EXISTS(SELECT 1 FROM whaleu_community.saved_epochs WHERE post_id=NEW.post_id) THEN
   RAISE EXCEPTION 'Subscription baseline requires fresh exact native publication with no save history' USING ERRCODE='23514';
 END IF;
 NEW.creation_xid:=pg_current_xact_id(); NEW.created_at:=clock_timestamp(); RETURN NEW;
END $$;
CREATE TRIGGER subscription_baseline_guard BEFORE INSERT ON whaleu_post_hotness.subscription_baselines FOR EACH ROW EXECUTE FUNCTION whaleu_post_hotness.baseline_guard();
CREATE FUNCTION whaleu_post_hotness.publication_complete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.kind='post' AND NEW.provenance='native_publication'
  AND EXISTS(SELECT 1 FROM whaleu_community.posts WHERE id=NEW.target_id AND local_creation_transaction=pg_current_xact_id())
  AND NOT EXISTS(SELECT 1 FROM whaleu_post_hotness.subscription_baselines b JOIN whaleu_post_hotness.subscription_states s USING(post_id)
   WHERE b.post_id=NEW.target_id AND b.owner_id=NEW.owner_account_id AND b.source_request_id=NEW.source_request_id AND b.creation_xid=pg_current_xact_id()) THEN
  RAISE EXCEPTION 'Fresh native publication requires subscription enrollment' USING ERRCODE='23514';
 END IF; RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER subscription_publication_complete AFTER INSERT ON whaleu_community.report_origins DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_post_hotness.publication_complete();
CREATE FUNCTION whaleu_post_hotness.baseline_complete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM whaleu_post_hotness.subscription_states WHERE post_id=NEW.post_id) THEN
  RAISE EXCEPTION 'Subscription baseline requires state' USING ERRCODE='23514';
 END IF; RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER subscription_baseline_complete AFTER INSERT ON whaleu_post_hotness.subscription_baselines DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_post_hotness.baseline_complete();

-- Only the actual epoch mutation trigger can insert transition provenance.
-- In particular, an epoch's creation xid is not evidence of its later ending.
CREATE FUNCTION whaleu_post_hotness.source_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF pg_trigger_depth()<>2 OR NOT EXISTS(SELECT 1 FROM whaleu_community.saved_epochs e
  WHERE e.id=NEW.epoch_id AND e.post_id=NEW.post_id AND e.account_id=NEW.actor_id
   AND ((NEW.transition='saved' AND e.started_sequence=NEW.source_sequence AND e.local_creation_transaction=pg_current_xact_id())
    OR (NEW.transition='unsaved' AND e.ended_sequence=NEW.source_sequence))) THEN
  RAISE EXCEPTION 'Subscription source requires actual saved epoch transition' USING ERRCODE='23514';
 END IF;
 NEW.source_transaction:=pg_current_xact_id(); RETURN NEW;
END $$;
CREATE TRIGGER subscription_source_guard BEFORE INSERT ON whaleu_post_hotness.subscription_sources FOR EACH ROW EXECUTE FUNCTION whaleu_post_hotness.source_guard();
CREATE FUNCTION whaleu_post_hotness.capture_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM whaleu_post_hotness.subscription_baselines WHERE post_id=NEW.post_id) THEN
  IF TG_OP='INSERT' THEN
   IF NEW.ended_sequence IS NOT NULL OR NEW.ended_at IS NOT NULL THEN
    RAISE EXCEPTION 'Known-post saved epoch must begin active' USING ERRCODE='23514';
   END IF;
   INSERT INTO whaleu_post_hotness.subscription_sources(epoch_id,transition,post_id,actor_id,source_sequence)
    VALUES(NEW.id,'saved',NEW.post_id,NEW.account_id,NEW.started_sequence);
  ELSIF OLD.ended_sequence IS NULL AND NEW.ended_sequence IS NOT NULL THEN
   INSERT INTO whaleu_post_hotness.subscription_sources(epoch_id,transition,post_id,actor_id,source_sequence)
    VALUES(NEW.id,'unsaved',NEW.post_id,NEW.account_id,NEW.ended_sequence);
  END IF;
 END IF; RETURN NULL;
END $$;
CREATE TRIGGER subscription_capture_epoch AFTER INSERT OR UPDATE ON whaleu_community.saved_epochs FOR EACH ROW EXECUTE FUNCTION whaleu_post_hotness.capture_epoch();
CREATE FUNCTION whaleu_post_hotness.source_pair_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE src whaleu_post_hotness.subscription_sources; owner uuid; target_epoch uuid; target_transition text; target_post uuid;
BEGIN
 IF TG_TABLE_NAME='saved_obligations' THEN
  IF NEW.action<>'save_ranking' THEN RETURN NULL; END IF;
  SELECT post_id INTO target_post FROM whaleu_community.saved_epochs WHERE id=NEW.epoch_id;
  IF NOT EXISTS(SELECT 1 FROM whaleu_post_hotness.subscription_baselines WHERE post_id=target_post) THEN RETURN NULL; END IF;
 END IF;
 target_epoch:=NEW.epoch_id; target_transition:=NEW.transition;
 SELECT * INTO src FROM whaleu_post_hotness.subscription_sources WHERE epoch_id=target_epoch AND transition=target_transition;
 SELECT owner_id INTO owner FROM whaleu_post_hotness.subscription_baselines WHERE post_id=src.post_id;
 IF src.epoch_id IS NULL OR
   (SELECT count(*) FROM whaleu_community.saved_obligations WHERE epoch_id=target_epoch AND transition=target_transition AND action='save_ranking')<>1 OR
   NOT EXISTS(SELECT 1 FROM whaleu_community.saved_obligations o WHERE o.epoch_id=target_epoch AND o.transition=target_transition
    AND o.action='save_ranking' AND o.recipient_account_id=owner
    AND o.delta=CASE target_transition WHEN 'saved' THEN 1 ELSE -1 END
    AND o.local_creation_transaction=src.source_transaction) THEN
  RAISE EXCEPTION 'Subscription transition requires exact same-transaction ranking obligation' USING ERRCODE='23514';
 END IF; RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER subscription_source_pair_complete AFTER INSERT ON whaleu_post_hotness.subscription_sources DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_post_hotness.source_pair_complete();
CREATE CONSTRAINT TRIGGER subscription_obligation_pair_complete AFTER INSERT ON whaleu_community.saved_obligations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_post_hotness.source_pair_complete();

CREATE FUNCTION whaleu_post_hotness.receipt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE src whaleu_post_hotness.subscription_sources; st whaleu_post_hotness.subscription_states;
 member whaleu_post_hotness.subscription_memberships; obligation whaleu_community.saved_obligations; owner uuid;
BEGIN
 -- Parent first, then component state, member and exact obligation. No actor,
 -- account, profile, safety or experience locks are acquired by this component.
 PERFORM 1 FROM whaleu_community.posts WHERE id=NEW.post_id FOR UPDATE;
 SELECT * INTO st FROM whaleu_post_hotness.subscription_states WHERE post_id=NEW.post_id FOR UPDATE;
 SELECT * INTO member FROM whaleu_post_hotness.subscription_memberships WHERE post_id=NEW.post_id AND actor_id=NEW.actor_id FOR UPDATE;
 SELECT * INTO obligation FROM whaleu_community.saved_obligations WHERE id=NEW.obligation_id FOR UPDATE;
 SELECT * INTO src FROM whaleu_post_hotness.subscription_sources WHERE epoch_id=NEW.epoch_id AND transition=NEW.transition;
 SELECT owner_id INTO owner FROM whaleu_post_hotness.subscription_baselines WHERE post_id=NEW.post_id;
 IF st.post_id IS NULL OR src.epoch_id IS NULL OR obligation.id IS NULL OR owner IS NULL OR
  (src.post_id,src.actor_id,src.source_sequence) IS DISTINCT FROM (NEW.post_id,NEW.actor_id,NEW.source_sequence) OR
  (obligation.epoch_id,obligation.transition,obligation.action,obligation.recipient_account_id,obligation.delta,obligation.status)
   IS DISTINCT FROM (NEW.epoch_id,NEW.transition,'save_ranking'::text,owner,NEW.delta,'pending'::text) OR
  obligation.local_creation_transaction IS DISTINCT FROM src.source_transaction OR
  (st.count,st.last_sequence) IS DISTINCT FROM (NEW.before_count,NEW.previous_state_sequence) OR
  coalesce(member.last_sequence,0)<>NEW.previous_membership_sequence OR member.active_epoch_id IS DISTINCT FROM NEW.previous_membership_epoch OR
  NEW.source_sequence<=st.last_sequence OR
  EXISTS(SELECT 1 FROM whaleu_post_hotness.subscription_sources earlier WHERE earlier.post_id=NEW.post_id
   AND earlier.source_sequence<NEW.source_sequence AND NOT EXISTS(
    SELECT 1 FROM whaleu_post_hotness.subscription_receipts r JOIN whaleu_community.saved_obligations o ON o.id=r.obligation_id
     WHERE r.epoch_id=earlier.epoch_id AND r.transition=earlier.transition AND o.status='completed')) OR
  (NEW.transition='saved' AND member.active_epoch_id IS NOT NULL) OR
  (NEW.transition='unsaved' AND (member.active_epoch_id IS DISTINCT FROM NEW.epoch_id OR st.count<=0)) THEN
  RAISE EXCEPTION 'Subscription receipt lacks exact causal source and pre-state' USING ERRCODE='23514';
 END IF;
 NEW.application_xid:=pg_current_xact_id(); NEW.applied_at:=clock_timestamp(); RETURN NEW;
END $$;
CREATE TRIGGER subscription_receipt_guard BEFORE INSERT ON whaleu_post_hotness.subscription_receipts FOR EACH ROW EXECUTE FUNCTION whaleu_post_hotness.receipt_guard();

CREATE FUNCTION whaleu_post_hotness.state_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r whaleu_post_hotness.subscription_receipts;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Subscription state is retained' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.count<>0 OR NEW.last_sequence<>0 OR NEW.last_receipt_id IS NOT NULL OR NOT EXISTS(
   SELECT 1 FROM whaleu_post_hotness.subscription_baselines WHERE post_id=NEW.post_id AND creation_xid=pg_current_xact_id()) THEN
   RAISE EXCEPTION 'Subscription initial state requires fresh zero baseline' USING ERRCODE='23514';
  END IF;
 ELSE
  SELECT * INTO r FROM whaleu_post_hotness.subscription_receipts WHERE obligation_id=NEW.last_receipt_id AND application_xid=pg_current_xact_id();
  IF r.obligation_id IS NULL OR NEW.post_id<>OLD.post_id OR
   (r.post_id,r.before_count,r.previous_state_sequence,r.after_count,r.source_sequence)
    IS DISTINCT FROM (OLD.post_id,OLD.count,OLD.last_sequence,NEW.count,NEW.last_sequence) OR NEW.last_sequence<=OLD.last_sequence THEN
   RAISE EXCEPTION 'Subscription state requires exact receipt transition' USING ERRCODE='23514';
  END IF;
 END IF; RETURN NEW;
END $$;
CREATE TRIGGER subscription_state_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_post_hotness.subscription_states FOR EACH ROW EXECUTE FUNCTION whaleu_post_hotness.state_guard();
CREATE FUNCTION whaleu_post_hotness.membership_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r whaleu_post_hotness.subscription_receipts;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Subscription membership is retained' USING ERRCODE='23514'; END IF;
 SELECT * INTO r FROM whaleu_post_hotness.subscription_receipts WHERE obligation_id=NEW.last_receipt_id AND application_xid=pg_current_xact_id();
 IF r.obligation_id IS NULL OR (r.post_id,r.actor_id,r.source_sequence) IS DISTINCT FROM (NEW.post_id,NEW.actor_id,NEW.last_sequence)
  OR NEW.active_epoch_id IS DISTINCT FROM (CASE r.transition WHEN 'saved' THEN r.epoch_id ELSE NULL END) THEN
  RAISE EXCEPTION 'Subscription membership requires exact receipt' USING ERRCODE='23514';
 END IF;
 IF TG_OP='INSERT' THEN
  IF r.transition<>'saved' OR r.previous_membership_sequence<>0 OR r.previous_membership_epoch IS NOT NULL THEN
   RAISE EXCEPTION 'Subscription first membership requires first positive receipt' USING ERRCODE='23514';
  END IF;
 ELSIF (OLD.post_id,OLD.actor_id,OLD.last_sequence,OLD.active_epoch_id)
  IS DISTINCT FROM (NEW.post_id,NEW.actor_id,r.previous_membership_sequence,r.previous_membership_epoch) OR NEW.last_sequence<=OLD.last_sequence THEN
  RAISE EXCEPTION 'Subscription membership pre-state mismatch' USING ERRCODE='23514';
 END IF; RETURN NEW;
END $$;
CREATE TRIGGER subscription_membership_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_post_hotness.subscription_memberships FOR EACH ROW EXECUTE FUNCTION whaleu_post_hotness.membership_guard();

CREATE FUNCTION whaleu_post_hotness.obligation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.action<>'save_ranking' THEN RETURN NEW; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.status<>'pending' THEN RAISE EXCEPTION 'Ranking obligation must begin pending' USING ERRCODE='23514'; END IF;
 ELSIF OLD.status<>'pending' OR NEW.status<>'completed' OR NOT EXISTS(
  SELECT 1 FROM whaleu_post_hotness.subscription_receipts r WHERE r.obligation_id=NEW.id AND r.epoch_id=NEW.epoch_id
   AND r.transition=NEW.transition AND r.delta=NEW.delta AND r.application_xid=pg_current_xact_id()) THEN
  RAISE EXCEPTION 'Ranking completion requires exact subscription receipt' USING ERRCODE='23514';
 END IF; RETURN NEW;
END $$;
CREATE TRIGGER subscription_obligation_guard BEFORE INSERT OR UPDATE ON whaleu_community.saved_obligations FOR EACH ROW EXECUTE FUNCTION whaleu_post_hotness.obligation_guard();
CREATE FUNCTION whaleu_post_hotness.receipt_complete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM whaleu_community.saved_obligations o
  JOIN whaleu_post_hotness.subscription_states s ON s.post_id=NEW.post_id
  JOIN whaleu_post_hotness.subscription_memberships m ON m.post_id=NEW.post_id AND m.actor_id=NEW.actor_id
  WHERE o.id=NEW.obligation_id AND o.status='completed' AND o.action='save_ranking'
   AND s.last_receipt_id=NEW.obligation_id AND s.count=NEW.after_count AND s.last_sequence=NEW.source_sequence
   AND m.last_receipt_id=NEW.obligation_id AND m.last_sequence=NEW.source_sequence
   AND m.active_epoch_id IS NOT DISTINCT FROM CASE NEW.transition WHEN 'saved' THEN NEW.epoch_id ELSE NULL END) THEN
  RAISE EXCEPTION 'Subscription receipt, count, membership and acknowledgement must commit atomically' USING ERRCODE='23514';
 END IF; RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER subscription_receipt_complete AFTER INSERT ON whaleu_post_hotness.subscription_receipts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_post_hotness.receipt_complete();
