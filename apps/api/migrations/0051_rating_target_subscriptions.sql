-- Independent target subscription coverage and a target-serialized causal stream.
-- No global identity or clock is a cross-target commit watermark.
SET LOCAL lock_timeout='5s';
SELECT pg_advisory_xact_lock(hashtextextended('whaleu:named-block-policy:v1',0));
LOCK TABLE whaleu_ratings.targets,whaleu_ratings.comments,whaleu_ratings.replies,whaleu_ratings.requests,whaleu_ratings.effect_events IN SHARE ROW EXCLUSIVE MODE;
ALTER TABLE whaleu_ratings.requests DROP CONSTRAINT requests_operation_check;
ALTER TABLE whaleu_ratings.requests ADD CHECK(operation IN ('set_score','create_comment','delete_comment','create_reply','delete_reply','set_comment_like','set_reply_like','set_target_subscription'));
DROP TRIGGER rating_request_causal ON whaleu_ratings.requests;
CREATE CONSTRAINT TRIGGER rating_request_causal AFTER INSERT OR UPDATE ON whaleu_ratings.requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.operation NOT IN ('set_comment_like','set_reply_like','set_target_subscription')) EXECUTE FUNCTION whaleu_ratings.request_causal();
CREATE TABLE whaleu_ratings.subscription_activations (
 id uuid PRIMARY KEY,version integer NOT NULL UNIQUE CHECK(version=1),activated_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(activated_at)),activation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),provenance text NOT NULL CHECK(provenance='native-writer-cutover')
);
INSERT INTO whaleu_ratings.subscription_activations VALUES(gen_random_uuid(),1,clock_timestamp(),pg_current_xact_id(),'native-writer-cutover');
CREATE TABLE whaleu_ratings.subscription_streams (
 target_id uuid PRIMARY KEY REFERENCES whaleu_ratings.targets(id),last_order bigint NOT NULL DEFAULT 0 CHECK(last_order>=0),last_entry_id uuid,CHECK((last_order=0)=(last_entry_id IS NULL))
);
CREATE TABLE whaleu_ratings.subscription_stream_entries (
 id uuid PRIMARY KEY,target_id uuid NOT NULL REFERENCES whaleu_ratings.subscription_streams(target_id),target_order bigint NOT NULL CHECK(target_order>0),previous_entry_id uuid,
 kind text NOT NULL CHECK(kind IN ('subscription','publication')),source_id uuid NOT NULL,mutation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 UNIQUE(target_id,target_order),UNIQUE(id,target_id,target_order),UNIQUE(id,target_id),UNIQUE(kind,source_id),FOREIGN KEY(previous_entry_id,target_id) REFERENCES whaleu_ratings.subscription_stream_entries(id,target_id),CHECK((target_order=1)=(previous_entry_id IS NULL))
);
CREATE UNIQUE INDEX rating_subscription_stream_successor ON whaleu_ratings.subscription_stream_entries(previous_entry_id) WHERE previous_entry_id IS NOT NULL;
ALTER TABLE whaleu_ratings.subscription_streams ADD FOREIGN KEY(last_entry_id,target_id,last_order) REFERENCES whaleu_ratings.subscription_stream_entries(id,target_id,target_order);
INSERT INTO whaleu_ratings.subscription_streams(target_id) SELECT id FROM whaleu_ratings.targets;
CREATE TABLE whaleu_ratings.subscription_baselines (
 id uuid PRIMARY KEY,target_id uuid NOT NULL UNIQUE REFERENCES whaleu_ratings.targets(id),kind text NOT NULL CHECK(kind IN ('native-target-creation','native-activation')),activation_id uuid NOT NULL REFERENCES whaleu_ratings.subscription_activations(id),source_id uuid NOT NULL,
 target_creation_transaction xid8 NOT NULL,baseline_at timestamptz NOT NULL CHECK(isfinite(baseline_at)),creation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),coverage text NOT NULL CHECK(coverage='complete'),
 FOREIGN KEY(source_id,target_id) REFERENCES whaleu_ratings.target_sources(id,target_id),UNIQUE(id,target_id)
);
CREATE TABLE whaleu_ratings.subscription_states (
 target_id uuid PRIMARY KEY REFERENCES whaleu_ratings.subscription_baselines(target_id),baseline_id uuid NOT NULL,count integer NOT NULL CHECK(count>=0),head_transition_id uuid,target_order bigint NOT NULL DEFAULT 0 CHECK(target_order>=0),
 FOREIGN KEY(baseline_id,target_id) REFERENCES whaleu_ratings.subscription_baselines(id,target_id),CHECK((target_order=0)=(head_transition_id IS NULL))
);
CREATE TABLE whaleu_ratings.subscription_memberships (
 target_id uuid NOT NULL REFERENCES whaleu_ratings.subscription_baselines(target_id),account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),subscribed boolean NOT NULL,revision uuid NOT NULL DEFAULT gen_random_uuid(),last_transition_id uuid NOT NULL DEFAULT gen_random_uuid(),active_epoch_id uuid,
 request_id uuid NOT NULL,expected_revision uuid NOT NULL,updated_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(updated_at)),mutation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 PRIMARY KEY(target_id,account_id),FOREIGN KEY(account_id,request_id) REFERENCES whaleu_ratings.requests(account_id,request_id),CHECK(subscribed=(active_epoch_id IS NOT NULL))
);
CREATE TABLE whaleu_ratings.subscription_transitions (
 id uuid PRIMARY KEY,target_id uuid NOT NULL REFERENCES whaleu_ratings.targets(id),account_id uuid NOT NULL,request_id uuid NOT NULL,baseline_id uuid NOT NULL,
 old_revision uuid NOT NULL,new_revision uuid NOT NULL UNIQUE,old_epoch_id uuid,new_epoch_id uuid,delta smallint NOT NULL CHECK(delta IN (-1,1)),previous_actor_transition_id uuid,previous_target_transition_id uuid,
 previous_count integer NOT NULL CHECK(previous_count>=0),new_count integer NOT NULL CHECK(new_count>=0),target_order bigint NOT NULL CHECK(target_order>0),occurred_at timestamptz NOT NULL CHECK(isfinite(occurred_at)),mutation_transaction xid8 NOT NULL,
 UNIQUE(account_id,request_id),UNIQUE(id,target_id,account_id),UNIQUE(id,target_id,target_order),UNIQUE(id,target_id),FOREIGN KEY(account_id,request_id) REFERENCES whaleu_ratings.requests(account_id,request_id),FOREIGN KEY(baseline_id,target_id) REFERENCES whaleu_ratings.subscription_baselines(id,target_id),
 FOREIGN KEY(previous_actor_transition_id,target_id,account_id) REFERENCES whaleu_ratings.subscription_transitions(id,target_id,account_id),FOREIGN KEY(previous_target_transition_id,target_id) REFERENCES whaleu_ratings.subscription_transitions(id,target_id),
 CHECK(new_revision<>old_revision),CHECK(new_count=previous_count+delta),CHECK((delta=1 AND old_epoch_id IS NULL AND new_epoch_id=id) OR (delta=-1 AND old_epoch_id IS NOT NULL AND new_epoch_id IS NULL))
);
CREATE UNIQUE INDEX rating_subscription_target_successor ON whaleu_ratings.subscription_transitions(previous_target_transition_id) WHERE previous_target_transition_id IS NOT NULL;
CREATE UNIQUE INDEX rating_subscription_target_initial ON whaleu_ratings.subscription_transitions(target_id) WHERE previous_target_transition_id IS NULL;
CREATE UNIQUE INDEX rating_subscription_actor_successor ON whaleu_ratings.subscription_transitions(previous_actor_transition_id) WHERE previous_actor_transition_id IS NOT NULL;
CREATE UNIQUE INDEX rating_subscription_actor_initial ON whaleu_ratings.subscription_transitions(target_id,account_id) WHERE previous_actor_transition_id IS NULL;
CREATE INDEX rating_subscription_actor_history ON whaleu_ratings.subscription_transitions(target_id,account_id,target_order DESC);
CREATE TABLE whaleu_ratings.subscription_epochs (
 id uuid PRIMARY KEY,target_id uuid NOT NULL,account_id uuid NOT NULL,start_order bigint NOT NULL CHECK(start_order>0),FOREIGN KEY(id,target_id,account_id) REFERENCES whaleu_ratings.subscription_transitions(id,target_id,account_id),UNIQUE(id,target_id,account_id),UNIQUE(target_id,start_order,id)
);
CREATE INDEX rating_subscription_epoch_page ON whaleu_ratings.subscription_epochs(target_id,start_order,id);
CREATE TABLE whaleu_ratings.subscription_epoch_closures (
 epoch_id uuid PRIMARY KEY,target_id uuid NOT NULL,account_id uuid NOT NULL,end_order bigint NOT NULL CHECK(end_order>0),transition_id uuid NOT NULL UNIQUE,
 FOREIGN KEY(epoch_id,target_id,account_id) REFERENCES whaleu_ratings.subscription_epochs(id,target_id,account_id),FOREIGN KEY(transition_id,target_id,account_id) REFERENCES whaleu_ratings.subscription_transitions(id,target_id,account_id)
);
ALTER TABLE whaleu_ratings.subscription_transitions ADD FOREIGN KEY(old_epoch_id,target_id,account_id) REFERENCES whaleu_ratings.subscription_epochs(id,target_id,account_id),ADD FOREIGN KEY(new_epoch_id,target_id,account_id) REFERENCES whaleu_ratings.subscription_epochs(id,target_id,account_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE whaleu_ratings.subscription_memberships ADD FOREIGN KEY(last_transition_id,target_id,account_id) REFERENCES whaleu_ratings.subscription_transitions(id,target_id,account_id) DEFERRABLE INITIALLY DEFERRED,ADD FOREIGN KEY(active_epoch_id,target_id,account_id) REFERENCES whaleu_ratings.subscription_epochs(id,target_id,account_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE whaleu_ratings.subscription_states ADD FOREIGN KEY(head_transition_id,target_id,target_order) REFERENCES whaleu_ratings.subscription_transitions(id,target_id,target_order);
CREATE TABLE whaleu_ratings.subscription_noop_observations (
 account_id uuid NOT NULL,request_id uuid NOT NULL,target_id uuid NOT NULL,baseline_id uuid NOT NULL,anchor_transition_id uuid,subscribed boolean NOT NULL,revision uuid NOT NULL,occurred_at timestamptz NOT NULL CHECK(isfinite(occurred_at)),observation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 PRIMARY KEY(account_id,request_id),FOREIGN KEY(account_id,request_id) REFERENCES whaleu_ratings.requests(account_id,request_id),FOREIGN KEY(baseline_id,target_id) REFERENCES whaleu_ratings.subscription_baselines(id,target_id),FOREIGN KEY(anchor_transition_id,target_id,account_id) REFERENCES whaleu_ratings.subscription_transitions(id,target_id,account_id)
);
CREATE FUNCTION whaleu_ratings.subscription_baseline_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c whaleu_ratings.target_creations;s whaleu_ratings.target_sources;a whaleu_ratings.subscription_activations;
BEGIN
 SELECT * INTO c FROM whaleu_ratings.target_creations WHERE target_id=NEW.target_id;SELECT * INTO s FROM whaleu_ratings.target_sources WHERE id=NEW.source_id AND target_id=NEW.target_id;SELECT * INTO a FROM whaleu_ratings.subscription_activations WHERE id=NEW.activation_id;
 IF c.target_id IS NULL OR s.id IS NULL OR a.id IS NULL OR NEW.creation_transaction<>pg_current_xact_id() OR (c.source_id,c.creation_transaction) IS DISTINCT FROM (s.id,NEW.target_creation_transaction) OR (s.origin,s.coverage,s.provenance) IS DISTINCT FROM ('new_native','complete','accepted') OR (s.source_transaction<>c.creation_transaction OR s.effective_at>clock_timestamp()) THEN RAISE EXCEPTION 'Subscription baseline native provenance missing' USING ERRCODE='23514';END IF;
 IF NEW.kind='native-activation' THEN
 IF a.activation_transaction<>pg_current_xact_id() OR NEW.baseline_at<>a.activated_at THEN RAISE EXCEPTION 'Subscription cutover evidence expired' USING ERRCODE='23514';END IF;
 ELSE IF pg_trigger_depth()<2 OR c.creation_transaction<>pg_current_xact_id() OR NEW.baseline_at<>c.created_at THEN RAISE EXCEPTION 'Subscription fresh creation evidence missing' USING ERRCODE='23514';END IF;END IF;RETURN NEW;
END $$;
CREATE TRIGGER rating_subscription_baseline_guard BEFORE INSERT ON whaleu_ratings.subscription_baselines FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.subscription_baseline_guard();
CREATE FUNCTION whaleu_ratings.subscription_state_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b whaleu_ratings.subscription_baselines;e whaleu_ratings.subscription_transitions;
BEGIN
 IF TG_OP='DELETE' OR pg_trigger_depth()<2 THEN RAISE EXCEPTION 'Subscription state is source-owned' USING ERRCODE='23514';END IF;
 IF TG_OP='INSERT' THEN SELECT * INTO b FROM whaleu_ratings.subscription_baselines WHERE target_id=NEW.target_id;
 IF b.id IS NULL OR b.creation_transaction<>pg_current_xact_id() OR (NEW.baseline_id,NEW.count,NEW.head_transition_id,NEW.target_order) IS DISTINCT FROM (b.id,0,NULL::uuid,0::bigint) THEN RAISE EXCEPTION 'Subscription initial state mismatch' USING ERRCODE='23514';END IF;
 ELSE SELECT * INTO e FROM whaleu_ratings.subscription_transitions WHERE id=NEW.head_transition_id;
 IF e.id IS NULL OR e.mutation_transaction<>pg_current_xact_id() OR (NEW.target_id,NEW.baseline_id) IS DISTINCT FROM (OLD.target_id,OLD.baseline_id) OR (e.target_id,e.previous_count,e.previous_target_transition_id,e.new_count,e.target_order) IS DISTINCT FROM (OLD.target_id,OLD.count,OLD.head_transition_id,NEW.count,NEW.target_order) OR NEW.target_order<=OLD.target_order THEN RAISE EXCEPTION 'Subscription state predecessor mismatch' USING ERRCODE='23514';END IF;END IF;RETURN NEW;
END $$;
CREATE TRIGGER rating_subscription_state_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_ratings.subscription_states FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.subscription_state_guard();
CREATE FUNCTION whaleu_ratings.initialize_subscription_state() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO whaleu_ratings.subscription_states(target_id,baseline_id,count) VALUES(NEW.target_id,NEW.id,0);RETURN NULL;END $$;
CREATE TRIGGER rating_subscription_initial_state AFTER INSERT ON whaleu_ratings.subscription_baselines FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.initialize_subscription_state();
CREATE FUNCTION whaleu_ratings.subscription_baseline_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s whaleu_ratings.subscription_states;
BEGIN SELECT * INTO s FROM whaleu_ratings.subscription_states WHERE target_id=NEW.target_id;
 IF s.target_id IS NULL OR s.baseline_id IS DISTINCT FROM NEW.id OR (s.head_transition_id IS NULL AND (s.count<>0 OR s.target_order<>0)) OR (s.head_transition_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.subscription_transitions WHERE id=s.head_transition_id AND (target_id,baseline_id,new_count,target_order)=(s.target_id,s.baseline_id,s.count,s.target_order))) THEN RAISE EXCEPTION 'Subscription baseline state incomplete' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER rating_subscription_baseline_complete AFTER INSERT ON whaleu_ratings.subscription_baselines DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.subscription_baseline_complete();
INSERT INTO whaleu_ratings.subscription_baselines(id,target_id,kind,activation_id,source_id,target_creation_transaction,baseline_at,coverage)
 SELECT gen_random_uuid(),c.target_id,'native-activation',a.id,c.source_id,c.creation_transaction,a.activated_at,'complete' FROM whaleu_ratings.target_creations c JOIN whaleu_ratings.target_sources s ON (s.id,s.target_id,s.source_transaction)=(c.source_id,c.target_id,c.creation_transaction) AND (s.origin,s.coverage,s.provenance)=('new_native','complete','accepted') AND s.effective_at<=clock_timestamp() CROSS JOIN whaleu_ratings.subscription_activations a;
CREATE FUNCTION whaleu_ratings.initialize_target_subscription() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s whaleu_ratings.target_sources;a uuid;
BEGIN INSERT INTO whaleu_ratings.subscription_streams(target_id) VALUES(NEW.target_id);SELECT * INTO s FROM whaleu_ratings.target_sources WHERE id=NEW.source_id;SELECT id INTO a FROM whaleu_ratings.subscription_activations WHERE version=1;
 IF (s.origin,s.coverage,s.provenance)=('new_native','complete','accepted') AND s.source_transaction=NEW.creation_transaction AND s.effective_at<=clock_timestamp() THEN INSERT INTO whaleu_ratings.subscription_baselines(id,target_id,kind,activation_id,source_id,target_creation_transaction,baseline_at,coverage) VALUES(gen_random_uuid(),NEW.target_id,'native-target-creation',a,NEW.source_id,NEW.creation_transaction,NEW.created_at,'complete');END IF;RETURN NULL;
END $$;
CREATE TRIGGER rating_subscription_new_target AFTER INSERT ON whaleu_ratings.target_creations FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.initialize_target_subscription();
CREATE FUNCTION whaleu_ratings.subscription_stream_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e whaleu_ratings.subscription_stream_entries;
BEGIN
 IF TG_OP='DELETE' OR pg_trigger_depth()<2 THEN RAISE EXCEPTION 'Subscription stream is source-owned' USING ERRCODE='23514';END IF;
 IF TG_OP='INSERT' THEN IF NEW.last_order<>0 OR NEW.last_entry_id IS NOT NULL OR NOT EXISTS(SELECT 1 FROM whaleu_ratings.target_creations WHERE target_id=NEW.target_id AND creation_transaction=pg_current_xact_id()) THEN RAISE EXCEPTION 'Subscription stream native creation mismatch' USING ERRCODE='23514';END IF;
 ELSE SELECT * INTO e FROM whaleu_ratings.subscription_stream_entries WHERE id=NEW.last_entry_id;
 IF e.id IS NULL OR e.mutation_transaction<>pg_current_xact_id() OR NEW.target_id<>OLD.target_id OR NEW.last_order<>OLD.last_order+1 OR (e.target_id,e.target_order,e.previous_entry_id) IS DISTINCT FROM (OLD.target_id,NEW.last_order,OLD.last_entry_id) THEN RAISE EXCEPTION 'Subscription stream successor mismatch' USING ERRCODE='23514';END IF;END IF;RETURN NEW;
END $$;
CREATE TRIGGER rating_subscription_stream_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_ratings.subscription_streams FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.subscription_stream_guard();
CREATE FUNCTION whaleu_ratings.subscription_stream_entry_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s whaleu_ratings.subscription_streams;
BEGIN
 PERFORM id FROM whaleu_ratings.targets WHERE id=NEW.target_id FOR UPDATE NOWAIT;SELECT * INTO s FROM whaleu_ratings.subscription_streams WHERE target_id=NEW.target_id FOR UPDATE NOWAIT;
 IF pg_trigger_depth()<2 OR s.target_id IS NULL OR NEW.mutation_transaction<>pg_current_xact_id() OR (NEW.target_order,NEW.previous_entry_id) IS DISTINCT FROM (s.last_order+1,s.last_entry_id) THEN RAISE EXCEPTION 'Subscription order predecessor mismatch' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER rating_subscription_stream_entry_guard BEFORE INSERT ON whaleu_ratings.subscription_stream_entries FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.subscription_stream_entry_guard();
CREATE FUNCTION whaleu_ratings.advance_subscription_stream() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE whaleu_ratings.subscription_streams SET last_order=NEW.target_order,last_entry_id=NEW.id WHERE target_id=NEW.target_id;RETURN NULL;END $$;
CREATE TRIGGER rating_subscription_stream_advance AFTER INSERT ON whaleu_ratings.subscription_stream_entries FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.advance_subscription_stream();
CREATE FUNCTION whaleu_ratings.next_subscription_order(target uuid,entry_kind text,source uuid) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE s whaleu_ratings.subscription_streams;
BEGIN PERFORM id FROM whaleu_ratings.targets WHERE id=target FOR UPDATE NOWAIT;SELECT * INTO s FROM whaleu_ratings.subscription_streams WHERE target_id=target FOR UPDATE NOWAIT;
 IF s.target_id IS NULL THEN RAISE EXCEPTION 'Subscription order source unavailable' USING ERRCODE='23514';END IF;
 INSERT INTO whaleu_ratings.subscription_stream_entries(id,target_id,target_order,previous_entry_id,kind,source_id) VALUES(gen_random_uuid(),target,s.last_order+1,s.last_entry_id,entry_kind,source);RETURN s.last_order+1;
END $$;
CREATE FUNCTION whaleu_ratings.lock_subscription_target(target uuid,actor uuid,request uuid) RETURNS whaleu_ratings.subscription_baselines LANGUAGE plpgsql AS $$
DECLARE b whaleu_ratings.subscription_baselines;q whaleu_ratings.requests;
BEGIN
 PERFORM id FROM whaleu_ratings.targets WHERE id=target AND active FOR UPDATE NOWAIT;IF NOT FOUND THEN RAISE EXCEPTION 'Subscription target unavailable' USING ERRCODE='23514';END IF;
 SELECT * INTO b FROM whaleu_ratings.subscription_baselines WHERE target_id=target;
 PERFORM target_id FROM whaleu_ratings.subscription_states WHERE target_id=target FOR UPDATE NOWAIT;
 IF b.id IS NULL OR NOT FOUND THEN RAISE EXCEPTION 'Subscription coverage unavailable' USING ERRCODE='23514';END IF;
 SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=actor AND request_id=request FOR UPDATE NOWAIT;
 IF q.operation IS DISTINCT FROM 'set_target_subscription' OR q.receipt IS NOT NULL THEN RAISE EXCEPTION 'Subscription request unavailable' USING ERRCODE='23514';END IF;RETURN b;
END $$;
CREATE FUNCTION whaleu_ratings.subscription_membership_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b whaleu_ratings.subscription_baselines;p whaleu_ratings.subscription_transitions;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Subscription tombstone must remain' USING ERRCODE='23514';END IF;b:=whaleu_ratings.lock_subscription_target(NEW.target_id,NEW.account_id,NEW.request_id);
 IF TG_OP='UPDATE' THEN
 IF (NEW.target_id,NEW.account_id) IS DISTINCT FROM (OLD.target_id,OLD.account_id) OR NEW.subscribed=OLD.subscribed OR NEW.expected_revision<>OLD.revision THEN RAISE EXCEPTION 'Subscription requires real desired-state CAS transition' USING ERRCODE='23514';END IF;
 SELECT * INTO p FROM whaleu_ratings.subscription_transitions WHERE id=OLD.last_transition_id;
 IF p.id IS NULL OR (p.target_id,p.account_id,p.new_revision,p.new_epoch_id,p.occurred_at) IS DISTINCT FROM (OLD.target_id,OLD.account_id,OLD.revision,OLD.active_epoch_id,OLD.updated_at) THEN RAISE EXCEPTION 'Subscription actor predecessor missing' USING ERRCODE='23514';END IF;
 ELSE IF NOT NEW.subscribed OR NEW.expected_revision<>b.id OR EXISTS(SELECT 1 FROM whaleu_ratings.subscription_transitions WHERE target_id=NEW.target_id AND account_id=NEW.account_id LIMIT 1) THEN RAISE EXCEPTION 'Subscription actor baseline mismatch' USING ERRCODE='23514';END IF;END IF;
 NEW.last_transition_id:=gen_random_uuid();NEW.revision:=gen_random_uuid();NEW.active_epoch_id:=CASE WHEN NEW.subscribed THEN NEW.last_transition_id END;NEW.updated_at:=clock_timestamp();NEW.mutation_transaction:=pg_current_xact_id();RETURN NEW;
END $$;
CREATE TRIGGER rating_subscription_member_change BEFORE INSERT OR UPDATE OR DELETE ON whaleu_ratings.subscription_memberships FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.subscription_membership_change();
CREATE FUNCTION whaleu_ratings.record_subscription_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s whaleu_ratings.subscription_states;o bigint;
BEGIN SELECT * INTO s FROM whaleu_ratings.subscription_states WHERE target_id=NEW.target_id;o:=whaleu_ratings.next_subscription_order(NEW.target_id,'subscription',NEW.last_transition_id);
 INSERT INTO whaleu_ratings.subscription_transitions(id,target_id,account_id,request_id,baseline_id,old_revision,new_revision,old_epoch_id,new_epoch_id,delta,previous_actor_transition_id,previous_target_transition_id,previous_count,new_count,target_order,occurred_at,mutation_transaction)
 VALUES(NEW.last_transition_id,NEW.target_id,NEW.account_id,NEW.request_id,s.baseline_id,NEW.expected_revision,NEW.revision,CASE WHEN TG_OP='UPDATE' THEN OLD.active_epoch_id END,NEW.active_epoch_id,CASE WHEN NEW.subscribed THEN 1 ELSE -1 END,CASE WHEN TG_OP='UPDATE' THEN OLD.last_transition_id END,s.head_transition_id,s.count,s.count+CASE WHEN NEW.subscribed THEN 1 ELSE -1 END,o,NEW.updated_at,NEW.mutation_transaction);RETURN NULL;
END $$;
CREATE TRIGGER rating_subscription_record AFTER INSERT OR UPDATE ON whaleu_ratings.subscription_memberships FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.record_subscription_transition();
CREATE FUNCTION whaleu_ratings.subscription_transition_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b whaleu_ratings.subscription_baselines;m whaleu_ratings.subscription_memberships;s whaleu_ratings.subscription_states;p whaleu_ratings.subscription_transitions;
BEGIN
 b:=whaleu_ratings.lock_subscription_target(NEW.target_id,NEW.account_id,NEW.request_id);SELECT * INTO m FROM whaleu_ratings.subscription_memberships WHERE target_id=NEW.target_id AND account_id=NEW.account_id;SELECT * INTO s FROM whaleu_ratings.subscription_states WHERE target_id=NEW.target_id;
 IF pg_trigger_depth()<2 OR m.last_transition_id IS DISTINCT FROM NEW.id OR NEW.baseline_id<>b.id OR (NEW.new_revision,NEW.new_epoch_id,NEW.request_id,NEW.occurred_at,NEW.mutation_transaction,NEW.old_revision) IS DISTINCT FROM (m.revision,m.active_epoch_id,m.request_id,m.updated_at,pg_current_xact_id(),m.expected_revision) OR (NEW.previous_count,NEW.previous_target_transition_id) IS DISTINCT FROM (s.count,s.head_transition_id) OR (NEW.delta=1)<>m.subscribed OR NOT EXISTS(SELECT 1 FROM whaleu_ratings.subscription_stream_entries WHERE target_id=NEW.target_id AND target_order=NEW.target_order AND kind='subscription' AND source_id=NEW.id AND mutation_transaction=NEW.mutation_transaction) THEN RAISE EXCEPTION 'Subscription transition exact source mismatch' USING ERRCODE='23514';END IF;
 IF NEW.previous_actor_transition_id IS NULL THEN IF NEW.old_revision<>b.id OR NEW.old_epoch_id IS NOT NULL OR EXISTS(SELECT 1 FROM whaleu_ratings.subscription_transitions WHERE target_id=NEW.target_id AND account_id=NEW.account_id LIMIT 1) THEN RAISE EXCEPTION 'Subscription initial transition mismatch' USING ERRCODE='23514';END IF;
 ELSE SELECT * INTO p FROM whaleu_ratings.subscription_transitions WHERE id=NEW.previous_actor_transition_id;
 IF p.id IS NULL OR (p.target_id,p.account_id,p.new_revision,p.new_epoch_id) IS DISTINCT FROM (NEW.target_id,NEW.account_id,NEW.old_revision,NEW.old_epoch_id) OR p.target_order>=NEW.target_order THEN RAISE EXCEPTION 'Subscription actor successor mismatch' USING ERRCODE='23514';END IF;END IF;RETURN NEW;
END $$;
CREATE TRIGGER rating_subscription_transition_guard BEFORE INSERT ON whaleu_ratings.subscription_transitions FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.subscription_transition_guard();
CREATE FUNCTION whaleu_ratings.project_subscription_transition() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.delta=1 THEN INSERT INTO whaleu_ratings.subscription_epochs VALUES(NEW.id,NEW.target_id,NEW.account_id,NEW.target_order);
 ELSE INSERT INTO whaleu_ratings.subscription_epoch_closures VALUES(NEW.old_epoch_id,NEW.target_id,NEW.account_id,NEW.target_order,NEW.id);END IF;
 UPDATE whaleu_ratings.subscription_states SET count=NEW.new_count,head_transition_id=NEW.id,target_order=NEW.target_order WHERE target_id=NEW.target_id;RETURN NULL;
END $$;
CREATE TRIGGER a0_rating_subscription_projection AFTER INSERT ON whaleu_ratings.subscription_transitions FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.project_subscription_transition();
CREATE FUNCTION whaleu_ratings.subscription_epoch_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e whaleu_ratings.subscription_transitions;
BEGIN
 IF TG_TABLE_NAME='subscription_epochs' THEN SELECT * INTO e FROM whaleu_ratings.subscription_transitions WHERE id=NEW.id;
 IF pg_trigger_depth()<2 OR e.id IS NULL OR e.mutation_transaction<>pg_current_xact_id() OR e.delta<>1 OR (NEW.target_id,NEW.account_id,NEW.start_order) IS DISTINCT FROM (e.target_id,e.account_id,e.target_order) THEN RAISE EXCEPTION 'Subscription epoch source mismatch' USING ERRCODE='23514';END IF;
 ELSE SELECT * INTO e FROM whaleu_ratings.subscription_transitions WHERE id=NEW.transition_id;
 IF pg_trigger_depth()<2 OR e.id IS NULL OR e.mutation_transaction<>pg_current_xact_id() OR e.delta<>-1 OR (NEW.epoch_id,NEW.target_id,NEW.account_id,NEW.end_order) IS DISTINCT FROM (e.old_epoch_id,e.target_id,e.account_id,e.target_order) OR NOT EXISTS(SELECT 1 FROM whaleu_ratings.subscription_epochs WHERE id=NEW.epoch_id AND start_order<NEW.end_order) THEN RAISE EXCEPTION 'Subscription epoch closure mismatch' USING ERRCODE='23514';END IF;END IF;RETURN NEW;
END $$;
CREATE TRIGGER rating_subscription_epoch_guard BEFORE INSERT ON whaleu_ratings.subscription_epochs FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.subscription_epoch_guard();
CREATE TRIGGER rating_subscription_closure_guard BEFORE INSERT ON whaleu_ratings.subscription_epoch_closures FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.subscription_epoch_guard();
CREATE FUNCTION whaleu_ratings.subscription_noop_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b whaleu_ratings.subscription_baselines;m whaleu_ratings.subscription_memberships;p whaleu_ratings.subscription_transitions;
BEGIN
 b:=whaleu_ratings.lock_subscription_target(NEW.target_id,NEW.account_id,NEW.request_id);SELECT * INTO m FROM whaleu_ratings.subscription_memberships WHERE target_id=NEW.target_id AND account_id=NEW.account_id FOR SHARE NOWAIT;
 IF NEW.observation_transaction<>pg_current_xact_id() OR NEW.baseline_id<>b.id OR EXISTS(SELECT 1 FROM whaleu_ratings.subscription_transitions WHERE account_id=NEW.account_id AND request_id=NEW.request_id) THEN RAISE EXCEPTION 'Subscription noop observation mismatch' USING ERRCODE='23514';END IF;
 IF m.target_id IS NULL THEN IF NEW.subscribed OR NEW.anchor_transition_id IS NOT NULL OR (NEW.revision,NEW.occurred_at) IS DISTINCT FROM (b.id,b.baseline_at) OR EXISTS(SELECT 1 FROM whaleu_ratings.subscription_transitions WHERE target_id=NEW.target_id AND account_id=NEW.account_id LIMIT 1) THEN RAISE EXCEPTION 'Subscription noop absence proof missing' USING ERRCODE='23514';END IF;
 ELSE SELECT * INTO p FROM whaleu_ratings.subscription_transitions WHERE id=m.last_transition_id;
 IF p.id IS NULL OR (NEW.anchor_transition_id,NEW.subscribed,NEW.revision,NEW.occurred_at) IS DISTINCT FROM (m.last_transition_id,m.subscribed,m.revision,m.updated_at) OR (p.target_id,p.account_id,p.new_revision,p.new_epoch_id,p.occurred_at) IS DISTINCT FROM (m.target_id,m.account_id,m.revision,m.active_epoch_id,m.updated_at) THEN RAISE EXCEPTION 'Subscription noop actor anchor mismatch' USING ERRCODE='23514';END IF;END IF;RETURN NEW;
END $$;
CREATE TRIGGER rating_subscription_noop_guard BEFORE INSERT ON whaleu_ratings.subscription_noop_observations FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.subscription_noop_guard();
CREATE FUNCTION whaleu_ratings.subscription_request_causal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q whaleu_ratings.requests;e whaleu_ratings.subscription_transitions;n whaleu_ratings.subscription_noop_observations;keys text[];
BEGIN
 SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=NEW.account_id AND request_id=NEW.request_id;SELECT * INTO e FROM whaleu_ratings.subscription_transitions WHERE account_id=q.account_id AND request_id=q.request_id;SELECT * INTO n FROM whaleu_ratings.subscription_noop_observations WHERE account_id=q.account_id AND request_id=q.request_id;
 IF q.receipt IS NULL OR (q.receipt->>'requestId',q.receipt->>'operation') IS DISTINCT FROM (q.request_id::text,q.operation) THEN RAISE EXCEPTION 'Subscription canonical receipt missing' USING ERRCODE='23514';END IF;SELECT array_agg(k ORDER BY k) INTO keys FROM jsonb_object_keys(q.receipt) k;
 IF q.receipt->>'outcome'='rejected' THEN IF keys IS DISTINCT FROM ARRAY['code','operation','outcome','requestId'] OR e.id IS NOT NULL OR n.target_id IS NOT NULL OR NOT coalesce(q.receipt->>'code' IN ('RATING_NOT_FOUND','RATING_REVISION_CONFLICT','PHONE_VERIFICATION_REQUIRED','AFFILIATION_VERIFICATION_REQUIRED','IDENTITY_CAMPUS_REQUIRED','SAFETY_ACTION_RESTRICTED','CONTENT_REJECTED'),false) THEN RAISE EXCEPTION 'Invalid rejected subscription receipt' USING ERRCODE='23514';END IF;RETURN NULL;END IF;
 IF keys IS DISTINCT FROM ARRAY['occurredAt','operation','outcome','requestId','revision','subscribed','targetId'] OR jsonb_typeof(q.receipt->'subscribed') IS DISTINCT FROM 'boolean' OR NOT coalesce(q.receipt->>'occurredAt' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$',false) THEN RAISE EXCEPTION 'Invalid subscription minimal receipt' USING ERRCODE='23514';END IF;
 IF q.receipt->>'outcome'='applied' THEN IF e.id IS NULL OR n.target_id IS NOT NULL OR (q.receipt->>'targetId',q.receipt->>'revision',(q.receipt->>'subscribed')::boolean,(q.receipt->>'occurredAt')::timestamptz) IS DISTINCT FROM (e.target_id::text,e.new_revision::text,e.delta=1,e.occurred_at) THEN RAISE EXCEPTION 'Subscription receipt transition mismatch' USING ERRCODE='23514';END IF;
 ELSIF q.receipt->>'outcome'='noop' THEN IF e.id IS NOT NULL OR n.target_id IS NULL OR n.observation_transaction<>pg_current_xact_id() OR (q.receipt->>'targetId',q.receipt->>'revision',(q.receipt->>'subscribed')::boolean,(q.receipt->>'occurredAt')::timestamptz) IS DISTINCT FROM (n.target_id::text,n.revision::text,n.subscribed,n.occurred_at) THEN RAISE EXCEPTION 'Subscription receipt noop mismatch' USING ERRCODE='23514';END IF;
 ELSE RAISE EXCEPTION 'Invalid subscription outcome' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER rating_subscription_request_causal AFTER INSERT OR UPDATE ON whaleu_ratings.requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.operation='set_target_subscription') EXECUTE FUNCTION whaleu_ratings.subscription_request_causal();
CREATE FUNCTION whaleu_ratings.subscription_transition_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE m whaleu_ratings.subscription_memberships;s whaleu_ratings.subscription_states;h whaleu_ratings.subscription_transitions;a whaleu_ratings.subscription_transitions;q whaleu_ratings.requests;
BEGIN
 SELECT * INTO m FROM whaleu_ratings.subscription_memberships WHERE target_id=NEW.target_id AND account_id=NEW.account_id;SELECT * INTO s FROM whaleu_ratings.subscription_states WHERE target_id=NEW.target_id;SELECT * INTO h FROM whaleu_ratings.subscription_transitions WHERE id=s.head_transition_id;SELECT * INTO a FROM whaleu_ratings.subscription_transitions WHERE id=m.last_transition_id;SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=NEW.account_id AND request_id=NEW.request_id;
 IF q.receipt->>'outcome' IS DISTINCT FROM 'applied' OR q.receipt->>'revision' IS DISTINCT FROM NEW.new_revision::text OR a.id IS NULL OR a.target_order<NEW.target_order OR (a.target_id,a.account_id,a.new_revision,a.new_epoch_id,a.occurred_at) IS DISTINCT FROM (m.target_id,m.account_id,m.revision,m.active_epoch_id,m.updated_at) OR (m.last_transition_id<>NEW.id AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.subscription_transitions WHERE previous_actor_transition_id=NEW.id AND (target_id,account_id,old_revision,old_epoch_id) IS NOT DISTINCT FROM (NEW.target_id,NEW.account_id,NEW.new_revision,NEW.new_epoch_id))) OR h.id IS NULL OR h.target_order<NEW.target_order OR (h.target_id,h.new_count,h.target_order) IS DISTINCT FROM (s.target_id,s.count,s.target_order) OR (s.head_transition_id<>NEW.id AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.subscription_transitions WHERE previous_target_transition_id=NEW.id AND (target_id,previous_count)=(NEW.target_id,NEW.new_count))) THEN RAISE EXCEPTION 'Subscription history projection incomplete' USING ERRCODE='23514';END IF;
 IF (NEW.delta=1 AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.subscription_epochs WHERE id=NEW.id AND (target_id,account_id,start_order)=(NEW.target_id,NEW.account_id,NEW.target_order))) OR (NEW.delta=-1 AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.subscription_epoch_closures WHERE transition_id=NEW.id AND (epoch_id,target_id,account_id,end_order)=(NEW.old_epoch_id,NEW.target_id,NEW.account_id,NEW.target_order))) THEN RAISE EXCEPTION 'Subscription epoch projection incomplete' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER rating_subscription_transition_complete AFTER INSERT ON whaleu_ratings.subscription_transitions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.subscription_transition_complete();
CREATE FUNCTION whaleu_ratings.subscription_stream_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s whaleu_ratings.subscription_streams;h whaleu_ratings.subscription_stream_entries;
BEGIN SELECT * INTO s FROM whaleu_ratings.subscription_streams WHERE target_id=NEW.target_id;SELECT * INTO h FROM whaleu_ratings.subscription_stream_entries WHERE id=s.last_entry_id;
 IF h.id IS NULL OR s.last_order<NEW.target_order OR (h.target_id,h.target_order) IS DISTINCT FROM (s.target_id,s.last_order) OR (s.last_entry_id<>NEW.id AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.subscription_stream_entries WHERE previous_entry_id=NEW.id AND target_id=NEW.target_id AND target_order=NEW.target_order+1)) THEN RAISE EXCEPTION 'Subscription stream chain incomplete' USING ERRCODE='23514';END IF;
 IF NEW.kind='subscription' THEN IF NOT EXISTS(SELECT 1 FROM whaleu_ratings.subscription_transitions WHERE id=NEW.source_id AND (target_id,target_order,mutation_transaction)=(NEW.target_id,NEW.target_order,NEW.mutation_transaction)) THEN RAISE EXCEPTION 'Subscription stream transition missing' USING ERRCODE='23514';END IF;
 ELSE IF NOT EXISTS(SELECT 1 FROM whaleu_ratings.effect_events WHERE id=NEW.source_id AND source_version=1 AND event_kind IN ('root_created','reply_created') AND (target_id,mutation_transaction)=(NEW.target_id,NEW.mutation_transaction)) THEN RAISE EXCEPTION 'Subscription publication stream missing' USING ERRCODE='23514';END IF;END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER rating_subscription_stream_complete AFTER INSERT ON whaleu_ratings.subscription_stream_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.subscription_stream_complete();
CREATE FUNCTION whaleu_ratings.subscription_target_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s whaleu_ratings.target_sources;
BEGIN SELECT * INTO s FROM whaleu_ratings.target_sources WHERE id=NEW.source_id;
 IF NOT EXISTS(SELECT 1 FROM whaleu_ratings.subscription_streams WHERE target_id=NEW.target_id) OR ((s.origin,s.coverage,s.provenance)=('new_native','complete','accepted') AND s.source_transaction=NEW.creation_transaction AND s.effective_at<=clock_timestamp() AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.subscription_baselines b JOIN whaleu_ratings.subscription_states p ON (p.target_id,p.baseline_id)=(b.target_id,b.id) WHERE b.target_id=NEW.target_id AND b.target_creation_transaction=NEW.creation_transaction)) THEN RAISE EXCEPTION 'Subscription native target capture incomplete' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER rating_subscription_target_complete AFTER INSERT ON whaleu_ratings.target_creations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.subscription_target_complete();
DO $$ DECLARE tab text;BEGIN
 FOREACH tab IN ARRAY ARRAY['subscription_activations','subscription_baselines','subscription_stream_entries','subscription_transitions','subscription_epochs','subscription_epoch_closures','subscription_noop_observations'] LOOP EXECUTE format('CREATE TRIGGER rating_subscription_immutable BEFORE UPDATE OR DELETE ON whaleu_ratings.%I FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.immutable()',tab);END LOOP;
 FOREACH tab IN ARRAY ARRAY['subscription_activations','subscription_baselines','subscription_streams','subscription_stream_entries','subscription_states','subscription_memberships','subscription_transitions','subscription_epochs','subscription_epoch_closures','subscription_noop_observations'] LOOP EXECUTE format('CREATE TRIGGER rating_subscription_retain BEFORE TRUNCATE ON whaleu_ratings.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.immutable()',tab);END LOOP;
END $$;
-- Target-only subscription effects join the existing immutable ratings bridge.
-- Install after subscription_transitions exists and within the R2C cutover lock.
ALTER TABLE whaleu_ratings.effect_events
 ADD COLUMN subscription_transition_id uuid UNIQUE REFERENCES whaleu_ratings.subscription_transitions(id),
 ALTER COLUMN root_id DROP NOT NULL,
 ALTER COLUMN root_author_id DROP NOT NULL,
 ALTER COLUMN author_mode DROP NOT NULL;
ALTER TABLE whaleu_ratings.effect_events DROP CONSTRAINT rating_effect_typed_version;
ALTER TABLE whaleu_ratings.effect_events ADD CONSTRAINT rating_effect_typed_version CHECK(
 (source_version=1 AND rule_version='rating-effects-v1' AND event_kind IN ('root_created','reply_created','root_deleted','reply_deleted')
  AND root_id IS NOT NULL AND root_author_id IS NOT NULL AND author_mode IS NOT NULL
  AND subscription_transition_id IS NULL AND like_transition_id IS NULL AND subject_author_id IS NULL AND subject_author_mode IS NULL
  AND (comment_transition_id IS NULL)<>(reply_transition_id IS NULL)
  AND (event_kind LIKE 'root_%')=(comment_transition_id IS NOT NULL)
  AND (reply_id IS NULL)=(comment_transition_id IS NOT NULL)
  AND (reply_to_id IS NULL)=(direct_reply_author_id IS NULL) AND (reply_id IS NOT NULL OR reply_to_id IS NULL))
 OR (source_version=2 AND rule_version='rating-likes-v1' AND event_kind IN ('content_liked','content_unliked')
  AND root_id IS NOT NULL AND root_author_id IS NOT NULL AND author_mode IS NOT NULL
  AND subscription_transition_id IS NULL AND like_transition_id IS NOT NULL AND subject_author_id IS NOT NULL AND subject_author_mode IS NOT NULL
  AND comment_transition_id IS NULL AND reply_transition_id IS NULL AND reply_to_id IS NULL AND direct_reply_author_id IS NULL AND author_mode='named')
 OR (source_version=3 AND rule_version='rating-subscriptions-v1' AND event_kind IN ('target_subscribed','target_unsubscribed')
  AND subscription_transition_id IS NOT NULL AND root_id IS NULL AND root_author_id IS NULL AND author_mode IS NULL
  AND reply_id IS NULL AND reply_to_id IS NULL AND direct_reply_author_id IS NULL
  AND comment_transition_id IS NULL AND reply_transition_id IS NULL
  AND like_transition_id IS NULL AND subject_author_id IS NULL AND subject_author_mode IS NULL
  AND expected_experience_units=CASE WHEN event_kind='target_subscribed' THEN 1 ELSE 0 END
  AND expected_direct_notice_obligations=0)
);
CREATE FUNCTION whaleu_ratings.subscription_effect_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE t whaleu_ratings.subscription_transitions;target whaleu_ratings.targets;q whaleu_ratings.requests;
BEGIN
 SELECT * INTO t FROM whaleu_ratings.subscription_transitions WHERE id=NEW.subscription_transition_id;
 SELECT * INTO target FROM whaleu_ratings.targets WHERE id=t.target_id;
 SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=t.account_id AND request_id=t.request_id;
 IF pg_trigger_depth()<2 OR t.id IS NULL OR target.id IS NULL OR q.account_id IS NULL
  OR t.mutation_transaction IS DISTINCT FROM pg_current_xact_id()
  OR q.receipt IS NOT NULL OR q.operation IS DISTINCT FROM 'set_target_subscription'
  OR ROW(NEW.event_kind,NEW.target_id,NEW.actor_account_id,NEW.region_id,NEW.request_id,NEW.occurred_at,NEW.mutation_transaction)
   IS DISTINCT FROM ROW(CASE WHEN t.delta=1 THEN 'target_subscribed' ELSE 'target_unsubscribed' END,t.target_id,t.account_id,target.region_id,t.request_id,t.occurred_at,t.mutation_transaction)
 THEN RAISE EXCEPTION 'Subscription effect exact source mismatch' USING ERRCODE='23514';END IF;
 NEW.expected_experience_units:=CASE WHEN t.delta=1 THEN 1 ELSE 0 END;
 NEW.expected_direct_notice_obligations:=0;
 RETURN NEW;
END $$;
CREATE TRIGGER rating_subscription_effect_guard BEFORE INSERT ON whaleu_ratings.effect_events
 FOR EACH ROW WHEN(NEW.source_version=3) EXECUTE FUNCTION whaleu_ratings.subscription_effect_guard();
CREATE FUNCTION whaleu_ratings.record_subscription_effect() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target whaleu_ratings.targets;
BEGIN
 SELECT * INTO target FROM whaleu_ratings.targets WHERE id=NEW.target_id;
 INSERT INTO whaleu_ratings.effect_events(id,source_version,rule_version,event_kind,target_id,actor_account_id,region_id,subscription_transition_id,request_id,occurred_at,mutation_transaction,expected_experience_units,expected_direct_notice_obligations)
 VALUES(gen_random_uuid(),3,'rating-subscriptions-v1',CASE WHEN NEW.delta=1 THEN 'target_subscribed' ELSE 'target_unsubscribed' END,NEW.target_id,NEW.account_id,target.region_id,NEW.id,NEW.request_id,NEW.occurred_at,NEW.mutation_transaction,0,0);
 RETURN NULL;
END $$;
CREATE TRIGGER rating_subscription_effect AFTER INSERT ON whaleu_ratings.subscription_transitions
 FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.record_subscription_effect();
CREATE FUNCTION whaleu_ratings.subscription_transition_effect_complete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM whaleu_ratings.effect_events e
  WHERE e.subscription_transition_id=NEW.id AND e.source_version=3 AND e.rule_version='rating-subscriptions-v1'
   AND ROW(e.target_id,e.actor_account_id,e.request_id,e.occurred_at,e.mutation_transaction,e.event_kind,e.expected_experience_units,e.expected_direct_notice_obligations)
    IS NOT DISTINCT FROM ROW(NEW.target_id,NEW.account_id,NEW.request_id,NEW.occurred_at,NEW.mutation_transaction,
      CASE WHEN NEW.delta=1 THEN 'target_subscribed' ELSE 'target_unsubscribed' END,CASE WHEN NEW.delta=1 THEN 1 ELSE 0 END,0))
 THEN RAISE EXCEPTION 'Subscription transition effect is incomplete' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER rating_subscription_transition_effect_complete AFTER INSERT ON whaleu_ratings.subscription_transitions
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.subscription_transition_effect_complete();

CREATE OR REPLACE FUNCTION whaleu_ratings.expected_reward_units(event uuid) RETURNS TABLE(beneficiary_id uuid,action text) LANGUAGE sql STABLE AS $$
 SELECT actor_account_id,'comment'::text FROM whaleu_ratings.effect_events WHERE id=event AND source_version=1 AND event_kind IN ('root_created','reply_created')
 UNION ALL SELECT CASE WHEN reply_to_id IS NULL THEN root_author_id ELSE direct_reply_author_id END,'received_comment'::text FROM whaleu_ratings.effect_events WHERE id=event AND source_version=1 AND event_kind='reply_created' AND CASE WHEN reply_to_id IS NULL THEN root_author_id ELSE direct_reply_author_id END<>actor_account_id
 UNION ALL SELECT actor_account_id,'like_save'::text FROM whaleu_ratings.effect_events WHERE id=event AND source_version=2 AND event_kind='content_liked'
 UNION ALL SELECT subject_author_id,'received_like_save'::text FROM whaleu_ratings.effect_events WHERE id=event AND source_version=2 AND event_kind='content_liked' AND subject_author_id<>actor_account_id
 UNION ALL SELECT actor_account_id,'like_save'::text FROM whaleu_ratings.effect_events WHERE id=event AND source_version=3 AND rule_version='rating-subscriptions-v1' AND event_kind='target_subscribed'
$$;
-- expected_direct_notices remains unchanged: subscriptions have no direct or
-- received-like recipient, even when their target has a native creator.
ALTER TABLE whaleu_ratings.reward_groups
 ADD COLUMN subscription_transition_id uuid REFERENCES whaleu_ratings.subscription_transitions(id),
 ALTER COLUMN root_id DROP NOT NULL,
 ALTER COLUMN root_author_id DROP NOT NULL;
DO $$ DECLARE c record;BEGIN
 FOR c IN SELECT conname,pg_get_constraintdef(oid) def FROM pg_constraint
  WHERE conrelid='whaleu_ratings.reward_groups'::regclass AND contype='c'
 LOOP
  IF c.def LIKE '%source_version%' THEN EXECUTE format('ALTER TABLE whaleu_ratings.reward_groups DROP CONSTRAINT %I',c.conname);END IF;
 END LOOP;
END $$;
ALTER TABLE whaleu_ratings.reward_groups ADD CONSTRAINT rating_reward_group_typed_version CHECK(
 (source_version=1 AND event_kind IN ('root_created','reply_created') AND root_id IS NOT NULL AND root_author_id IS NOT NULL
  AND subscription_transition_id IS NULL AND like_transition_id IS NULL AND subject_author_id IS NULL AND subject_author_mode IS NULL)
 OR (source_version=2 AND event_kind='content_liked' AND root_id IS NOT NULL AND root_author_id IS NOT NULL
  AND subscription_transition_id IS NULL AND like_transition_id IS NOT NULL AND subject_author_id IS NOT NULL AND subject_author_mode IS NOT NULL
  AND reply_to_id IS NULL AND direct_reply_author_id IS NULL)
 OR (source_version=3 AND event_kind='target_subscribed' AND subscription_transition_id IS NOT NULL AND expected_unit_count=1
  AND root_id IS NULL AND root_author_id IS NULL AND reply_id IS NULL AND reply_to_id IS NULL AND direct_reply_author_id IS NULL
  AND like_transition_id IS NULL AND subject_author_id IS NULL AND subject_author_mode IS NULL)
);
CREATE FUNCTION whaleu_ratings.subscription_reward_source_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e whaleu_ratings.effect_events;
BEGIN
 SELECT * INTO e FROM whaleu_ratings.effect_events WHERE id=NEW.event_id;
 IF NEW.subscription_transition_id IS DISTINCT FROM e.subscription_transition_id
 THEN RAISE EXCEPTION 'Subscription reward source tuple mismatch' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER rating_subscription_reward_source BEFORE INSERT ON whaleu_ratings.reward_groups
 FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.subscription_reward_source_guard();
DO $$ DECLARE c record;BEGIN
 FOR c IN SELECT conname,pg_get_constraintdef(oid) def FROM pg_constraint
  WHERE conrelid='whaleu_experience.source_groups'::regclass AND contype='c'
 LOOP
  IF c.def LIKE '%source_version%' THEN EXECUTE format('ALTER TABLE whaleu_experience.source_groups DROP CONSTRAINT %I',c.conname);END IF;
 END LOOP;
END $$;
ALTER TABLE whaleu_experience.source_groups ADD CONSTRAINT experience_source_group_typed_version CHECK(
 (source_domain='community' AND source_version=1) OR (source_domain='ratings' AND source_version IN (1,2,3))
);
