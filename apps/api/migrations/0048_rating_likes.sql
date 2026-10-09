-- Ratings owns desired-state likes. Native publication is the only baseline.
-- This activation establishes this domain's writer cutover, not imported history.
LOCK TABLE whaleu_ratings.comments,whaleu_ratings.replies,whaleu_ratings.requests,whaleu_community.rating_approval_bindings IN SHARE ROW EXCLUSIVE MODE;
ALTER TABLE whaleu_ratings.requests DROP CONSTRAINT requests_operation_check;
ALTER TABLE whaleu_ratings.requests ADD CHECK(operation IN ('set_score','create_comment','delete_comment','create_reply','delete_reply','set_comment_like','set_reply_like'));
CREATE TABLE whaleu_ratings.like_activations (
 id uuid PRIMARY KEY,version integer NOT NULL UNIQUE CHECK(version=1),activated_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(activated_at)),activation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),provenance text NOT NULL CHECK(provenance='native-writer-cutover')
);
INSERT INTO whaleu_ratings.like_activations VALUES(gen_random_uuid(),1,clock_timestamp(),pg_current_xact_id(),'native-writer-cutover');
CREATE TABLE whaleu_ratings.like_subjects (
 id uuid PRIMARY KEY,kind text NOT NULL CHECK(kind IN ('comment','reply')),target_id uuid NOT NULL,root_id uuid NOT NULL,reply_id uuid,
 baseline_id uuid NOT NULL UNIQUE,baseline_at timestamptz NOT NULL CHECK(isfinite(baseline_at)),provenance text NOT NULL CHECK(provenance IN ('native-publication','native-activation')),activation_id uuid REFERENCES whaleu_ratings.like_activations(id),
 comment_transition_id uuid UNIQUE REFERENCES whaleu_ratings.comment_transitions(id),reply_transition_id uuid UNIQUE REFERENCES whaleu_ratings.reply_transitions(id),publication_transaction xid8 NOT NULL,creation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 FOREIGN KEY(root_id,target_id) REFERENCES whaleu_ratings.comments(id,target_id),FOREIGN KEY(reply_id,root_id,target_id) REFERENCES whaleu_ratings.replies(id,root_id,target_id),
 UNIQUE(id,target_id,root_id,reply_id),CHECK((kind='comment' AND reply_id IS NULL AND comment_transition_id IS NOT NULL AND reply_transition_id IS NULL AND id=root_id) OR (kind='reply' AND reply_id IS NOT NULL AND comment_transition_id IS NULL AND reply_transition_id IS NOT NULL AND id=reply_id)),CHECK((provenance='native-activation')=(activation_id IS NOT NULL))
);
CREATE UNIQUE INDEX rating_like_root_subject ON whaleu_ratings.like_subjects(root_id) WHERE kind='comment';
CREATE UNIQUE INDEX rating_like_reply_subject ON whaleu_ratings.like_subjects(reply_id) WHERE kind='reply';
CREATE FUNCTION whaleu_ratings.like_subject_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c whaleu_ratings.comments;r whaleu_ratings.replies;ct whaleu_ratings.comment_transitions;rt whaleu_ratings.reply_transitions;b whaleu_community.rating_approval_bindings;q whaleu_ratings.requests;a whaleu_ratings.like_activations;actor uuid;req uuid;created timestamptz;definition jsonb;revision uuid;
BEGIN
 IF NEW.creation_transaction<>pg_current_xact_id() THEN RAISE EXCEPTION 'Like baseline creation is not fresh' USING ERRCODE='23514';END IF;
 SELECT * INTO c FROM whaleu_ratings.comments WHERE id=NEW.root_id AND target_id=NEW.target_id;
 IF NEW.kind='comment' THEN SELECT * INTO ct FROM whaleu_ratings.comment_transitions WHERE id=NEW.comment_transition_id AND operation='create_comment';actor:=c.account_id;req:=c.request_id;created:=c.created_at;definition:=c.envelope;revision:=ct.revision;
 IF ct.id IS NULL OR (ct.comment_id,ct.target_id,ct.account_id,ct.request_id,ct.occurred_at,ct.mutation_transaction) IS DISTINCT FROM (c.id,c.target_id,c.account_id,c.request_id,c.created_at,c.publication_transaction) OR NEW.publication_transaction IS DISTINCT FROM c.publication_transaction THEN RAISE EXCEPTION 'Root like baseline publication mismatch' USING ERRCODE='23514';END IF;
 ELSE SELECT * INTO r FROM whaleu_ratings.replies WHERE id=NEW.reply_id AND root_id=NEW.root_id AND target_id=NEW.target_id;SELECT * INTO rt FROM whaleu_ratings.reply_transitions WHERE id=NEW.reply_transition_id AND operation='create_reply';actor:=r.account_id;req:=r.request_id;created:=r.created_at;definition:=r.envelope;revision:=rt.revision;
 IF rt.id IS NULL OR (rt.reply_id,rt.root_id,rt.target_id,rt.account_id,rt.request_id,rt.occurred_at,rt.mutation_transaction) IS DISTINCT FROM (r.id,r.root_id,r.target_id,r.account_id,r.request_id,r.created_at,r.publication_transaction) OR NEW.publication_transaction IS DISTINCT FROM r.publication_transaction THEN RAISE EXCEPTION 'Reply like baseline publication mismatch' USING ERRCODE='23514';END IF;END IF;
 SELECT * INTO b FROM whaleu_community.rating_approval_bindings WHERE kind=NEW.kind AND subject_id=NEW.id;
 IF b.subject_id IS NULL OR (b.envelope,b.publication_transaction,b.content_version) IS DISTINCT FROM (definition,NEW.publication_transaction,1) THEN RAISE EXCEPTION 'Like baseline review provenance missing' USING ERRCODE='23514';END IF;
 SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=actor AND request_id=req;
 IF q.operation IS DISTINCT FROM (CASE NEW.kind WHEN 'comment' THEN 'create_comment' ELSE 'create_reply' END) THEN RAISE EXCEPTION 'Like baseline request missing' USING ERRCODE='23514';END IF;
 IF NEW.provenance='native-publication' THEN
 IF NEW.publication_transaction<>pg_current_xact_id() OR NEW.baseline_at<>created OR q.receipt IS NOT NULL THEN RAISE EXCEPTION 'Old publication cannot claim fresh baseline' USING ERRCODE='23514';END IF;
 ELSE SELECT * INTO a FROM whaleu_ratings.like_activations WHERE id=NEW.activation_id;
 IF a.activation_transaction IS DISTINCT FROM pg_current_xact_id() OR NEW.baseline_at IS DISTINCT FROM a.activated_at OR created>a.activated_at OR q.receipt->>'outcome' IS DISTINCT FROM 'applied' OR q.receipt->>'revision' IS DISTINCT FROM revision::text OR (q.receipt->>'occurredAt')::timestamptz IS DISTINCT FROM created OR q.receipt->>'targetId' IS DISTINCT FROM NEW.target_id::text OR coalesce(q.receipt->>'subjectId',q.receipt->>'replyId') IS DISTINCT FROM NEW.id::text THEN RAISE EXCEPTION 'Like cutover publication receipt mismatch' USING ERRCODE='23514';END IF;END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER rating_like_subject_guard BEFORE INSERT ON whaleu_ratings.like_subjects FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.like_subject_guard();
CREATE TABLE whaleu_ratings.like_states (
 subject_id uuid PRIMARY KEY REFERENCES whaleu_ratings.like_subjects(id),count integer NOT NULL CHECK(count>=0),head_id uuid,sequence bigint NOT NULL DEFAULT 0 CHECK(sequence>=0)
);
CREATE TABLE whaleu_ratings.like_memberships (
 subject_id uuid NOT NULL REFERENCES whaleu_ratings.like_subjects(id),account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),liked boolean NOT NULL,active_like_id uuid,revision uuid NOT NULL,last_transition_id uuid NOT NULL,request_id uuid NOT NULL,expected_revision uuid NOT NULL,updated_at timestamptz NOT NULL,mutation_transaction xid8 NOT NULL,
 PRIMARY KEY(subject_id,account_id),FOREIGN KEY(account_id,request_id) REFERENCES whaleu_ratings.requests(account_id,request_id),CHECK(liked=(active_like_id IS NOT NULL)),CHECK(isfinite(updated_at))
);
CREATE TABLE whaleu_ratings.like_transitions (
 id uuid PRIMARY KEY,subject_id uuid NOT NULL REFERENCES whaleu_ratings.like_subjects(id),target_id uuid NOT NULL,root_id uuid NOT NULL,reply_id uuid,account_id uuid NOT NULL,request_id uuid NOT NULL,operation text NOT NULL CHECK(operation IN ('set_comment_like','set_reply_like')),
 old_revision uuid NOT NULL,new_revision uuid NOT NULL UNIQUE,previous_actor_transition_id uuid REFERENCES whaleu_ratings.like_transitions(id),old_active_like_id uuid REFERENCES whaleu_ratings.like_transitions(id),new_active_like_id uuid,
 delta smallint NOT NULL CHECK(delta IN (-1,1)),previous_count integer NOT NULL CHECK(previous_count>=0),new_count integer NOT NULL CHECK(new_count>=0),previous_head_id uuid REFERENCES whaleu_ratings.like_transitions(id),
 occurred_at timestamptz NOT NULL CHECK(isfinite(occurred_at)),mutation_transaction xid8 NOT NULL,sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE CHECK(sequence>0),
 UNIQUE(account_id,request_id),UNIQUE(subject_id,account_id,new_revision),UNIQUE(id,subject_id,sequence),FOREIGN KEY(account_id,request_id) REFERENCES whaleu_ratings.requests(account_id,request_id),FOREIGN KEY(root_id,target_id) REFERENCES whaleu_ratings.comments(id,target_id),FOREIGN KEY(reply_id,root_id,target_id) REFERENCES whaleu_ratings.replies(id,root_id,target_id),CHECK(new_revision<>old_revision),CHECK(new_count=previous_count+delta),CHECK((delta=1 AND old_active_like_id IS NULL AND new_active_like_id=id) OR (delta=-1 AND old_active_like_id IS NOT NULL AND new_active_like_id IS NULL))
);
ALTER TABLE whaleu_ratings.like_transitions ADD FOREIGN KEY(new_active_like_id) REFERENCES whaleu_ratings.like_transitions(id);
ALTER TABLE whaleu_ratings.like_memberships ADD FOREIGN KEY(last_transition_id) REFERENCES whaleu_ratings.like_transitions(id) DEFERRABLE INITIALLY DEFERRED,ADD FOREIGN KEY(active_like_id) REFERENCES whaleu_ratings.like_transitions(id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE whaleu_ratings.like_states ADD FOREIGN KEY(head_id,subject_id,sequence) REFERENCES whaleu_ratings.like_transitions(id,subject_id,sequence);
CREATE UNIQUE INDEX rating_like_count_successor ON whaleu_ratings.like_transitions(previous_head_id) WHERE previous_head_id IS NOT NULL;
CREATE UNIQUE INDEX rating_like_count_initial ON whaleu_ratings.like_transitions(subject_id) WHERE previous_head_id IS NULL;
CREATE UNIQUE INDEX rating_like_actor_successor ON whaleu_ratings.like_transitions(previous_actor_transition_id) WHERE previous_actor_transition_id IS NOT NULL;
CREATE UNIQUE INDEX rating_like_actor_initial ON whaleu_ratings.like_transitions(subject_id,account_id) WHERE previous_actor_transition_id IS NULL;
CREATE INDEX rating_like_actor_history ON whaleu_ratings.like_transitions(subject_id,account_id,sequence DESC);
CREATE TABLE whaleu_ratings.like_noop_observations (
 account_id uuid NOT NULL,request_id uuid NOT NULL,subject_id uuid NOT NULL REFERENCES whaleu_ratings.like_subjects(id),baseline_id uuid NOT NULL REFERENCES whaleu_ratings.like_subjects(baseline_id),anchor_transition_id uuid REFERENCES whaleu_ratings.like_transitions(id),liked boolean NOT NULL,revision uuid NOT NULL,occurred_at timestamptz NOT NULL CHECK(isfinite(occurred_at)),observation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 PRIMARY KEY(account_id,request_id),FOREIGN KEY(account_id,request_id) REFERENCES whaleu_ratings.requests(account_id,request_id)
);
-- Parent-first NOWAIT also protects hostile raw child writes from lock inversion.
CREATE FUNCTION whaleu_ratings.lock_like_subject(subject uuid,actor uuid,request uuid) RETURNS whaleu_ratings.like_subjects LANGUAGE plpgsql AS $$
DECLARE s whaleu_ratings.like_subjects;q whaleu_ratings.requests;
BEGIN
 SELECT * INTO s FROM whaleu_ratings.like_subjects WHERE id=subject;
 IF s.id IS NULL THEN RAISE EXCEPTION 'Like coverage unavailable' USING ERRCODE='23514';END IF;
 PERFORM id FROM whaleu_ratings.targets WHERE id=s.target_id AND active FOR UPDATE NOWAIT;IF NOT FOUND THEN RAISE EXCEPTION 'Like target unavailable' USING ERRCODE='23514';END IF;
 PERFORM id FROM whaleu_ratings.comments WHERE id=s.root_id AND target_id=s.target_id AND deleted_at IS NULL FOR UPDATE NOWAIT;IF NOT FOUND THEN RAISE EXCEPTION 'Like root unavailable' USING ERRCODE='23514';END IF;
 IF s.reply_id IS NOT NULL THEN PERFORM id FROM whaleu_ratings.replies WHERE id=s.reply_id AND root_id=s.root_id AND target_id=s.target_id AND deleted_at IS NULL FOR UPDATE NOWAIT;IF NOT FOUND THEN RAISE EXCEPTION 'Like reply unavailable' USING ERRCODE='23514';END IF;END IF;
 PERFORM subject_id FROM whaleu_ratings.like_states WHERE subject_id=s.id FOR UPDATE NOWAIT;IF NOT FOUND THEN RAISE EXCEPTION 'Like state unavailable' USING ERRCODE='23514';END IF;
 SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=actor AND request_id=request FOR UPDATE NOWAIT;
 IF q.operation IS DISTINCT FROM (CASE s.kind WHEN 'comment' THEN 'set_comment_like' ELSE 'set_reply_like' END) OR q.receipt IS NOT NULL THEN RAISE EXCEPTION 'Like command unavailable' USING ERRCODE='23514';END IF;RETURN s;
END $$;
CREATE FUNCTION whaleu_ratings.like_membership_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s whaleu_ratings.like_subjects;p whaleu_ratings.like_transitions;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Like actor tombstone must remain' USING ERRCODE='23514';END IF;
 s:=whaleu_ratings.lock_like_subject(NEW.subject_id,NEW.account_id,NEW.request_id);
 IF TG_OP='UPDATE' THEN
 IF (NEW.subject_id,NEW.account_id) IS DISTINCT FROM (OLD.subject_id,OLD.account_id) OR NEW.liked=OLD.liked OR NEW.expected_revision<>OLD.revision THEN RAISE EXCEPTION 'Like requires fresh actor CAS and a real transition' USING ERRCODE='23514';END IF;
 SELECT * INTO p FROM whaleu_ratings.like_transitions WHERE id=OLD.last_transition_id;
 IF p.id IS NULL OR (p.subject_id,p.account_id,p.new_revision,p.new_active_like_id,p.occurred_at) IS DISTINCT FROM (OLD.subject_id,OLD.account_id,OLD.revision,OLD.active_like_id,OLD.updated_at) THEN RAISE EXCEPTION 'Like predecessor lost' USING ERRCODE='23514';END IF;
 ELSE
 IF NOT NEW.liked OR NEW.expected_revision<>s.baseline_id OR EXISTS(SELECT 1 FROM whaleu_ratings.like_transitions WHERE subject_id=s.id AND account_id=NEW.account_id LIMIT 1) THEN RAISE EXCEPTION 'Like initial actor provenance invalid' USING ERRCODE='23514';END IF;END IF;
 NEW.last_transition_id:=gen_random_uuid();NEW.revision:=gen_random_uuid();NEW.active_like_id:=CASE WHEN NEW.liked THEN NEW.last_transition_id END;NEW.updated_at:=clock_timestamp();NEW.mutation_transaction:=pg_current_xact_id();RETURN NEW;
END $$;
CREATE TRIGGER rating_like_member_change BEFORE INSERT OR UPDATE OR DELETE ON whaleu_ratings.like_memberships FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.like_membership_change();
CREATE FUNCTION whaleu_ratings.record_like_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s whaleu_ratings.like_subjects;state whaleu_ratings.like_states;
BEGIN
 SELECT * INTO s FROM whaleu_ratings.like_subjects WHERE id=NEW.subject_id;SELECT * INTO state FROM whaleu_ratings.like_states WHERE subject_id=NEW.subject_id;
 INSERT INTO whaleu_ratings.like_transitions(id,subject_id,target_id,root_id,reply_id,account_id,request_id,operation,old_revision,new_revision,previous_actor_transition_id,old_active_like_id,new_active_like_id,delta,previous_count,new_count,previous_head_id,occurred_at,mutation_transaction)
 VALUES(NEW.last_transition_id,s.id,s.target_id,s.root_id,s.reply_id,NEW.account_id,NEW.request_id,CASE s.kind WHEN 'comment' THEN 'set_comment_like' ELSE 'set_reply_like' END,NEW.expected_revision,NEW.revision,CASE WHEN TG_OP='UPDATE' THEN OLD.last_transition_id END,CASE WHEN TG_OP='UPDATE' THEN OLD.active_like_id END,NEW.active_like_id,CASE WHEN NEW.liked THEN 1 ELSE -1 END,state.count,state.count+CASE WHEN NEW.liked THEN 1 ELSE -1 END,state.head_id,NEW.updated_at,NEW.mutation_transaction);RETURN NULL;
END $$;
CREATE TRIGGER rating_like_record AFTER INSERT OR UPDATE ON whaleu_ratings.like_memberships FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.record_like_transition();
CREATE FUNCTION whaleu_ratings.like_transition_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s whaleu_ratings.like_subjects;m whaleu_ratings.like_memberships;p whaleu_ratings.like_transitions;state whaleu_ratings.like_states;
BEGIN
 s:=whaleu_ratings.lock_like_subject(NEW.subject_id,NEW.account_id,NEW.request_id);SELECT * INTO m FROM whaleu_ratings.like_memberships WHERE subject_id=s.id AND account_id=NEW.account_id;SELECT * INTO state FROM whaleu_ratings.like_states WHERE subject_id=s.id;
 IF pg_trigger_depth()<2 OR m.last_transition_id IS DISTINCT FROM NEW.id OR (NEW.target_id,NEW.root_id,NEW.reply_id) IS DISTINCT FROM (s.target_id,s.root_id,s.reply_id) OR (NEW.new_revision,NEW.new_active_like_id,NEW.request_id,NEW.occurred_at,NEW.mutation_transaction,NEW.old_revision) IS DISTINCT FROM (m.revision,m.active_like_id,m.request_id,m.updated_at,pg_current_xact_id(),m.expected_revision) OR (NEW.previous_count,NEW.previous_head_id) IS DISTINCT FROM (state.count,state.head_id) OR (NEW.delta=1)<>m.liked OR NEW.operation IS DISTINCT FROM (CASE s.kind WHEN 'comment' THEN 'set_comment_like' ELSE 'set_reply_like' END) THEN RAISE EXCEPTION 'Like transition exact source mismatch' USING ERRCODE='23514';END IF;
 IF NEW.previous_actor_transition_id IS NULL THEN
 IF NEW.old_revision<>s.baseline_id OR NEW.old_active_like_id IS NOT NULL OR EXISTS(SELECT 1 FROM whaleu_ratings.like_transitions WHERE subject_id=s.id AND account_id=NEW.account_id LIMIT 1) THEN RAISE EXCEPTION 'Like initial transition history mismatch' USING ERRCODE='23514';END IF;
 ELSE SELECT * INTO p FROM whaleu_ratings.like_transitions WHERE id=NEW.previous_actor_transition_id;
 IF p.id IS NULL OR (p.subject_id,p.account_id,p.new_revision,p.new_active_like_id) IS DISTINCT FROM (s.id,NEW.account_id,NEW.old_revision,NEW.old_active_like_id) OR p.occurred_at>NEW.occurred_at THEN RAISE EXCEPTION 'Like actor predecessor mismatch' USING ERRCODE='23514';END IF;END IF;RETURN NEW;
END $$;
CREATE TRIGGER rating_like_transition_guard BEFORE INSERT ON whaleu_ratings.like_transitions FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.like_transition_guard();
CREATE FUNCTION whaleu_ratings.like_state_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE t whaleu_ratings.like_transitions;s whaleu_ratings.like_subjects;
BEGIN
 IF TG_OP='DELETE' OR pg_trigger_depth()<2 THEN RAISE EXCEPTION 'Like count is source-owned' USING ERRCODE='23514';END IF;
 IF TG_OP='INSERT' THEN SELECT * INTO s FROM whaleu_ratings.like_subjects WHERE id=NEW.subject_id;
 IF s.creation_transaction IS DISTINCT FROM pg_current_xact_id() OR NEW.count<>0 OR NEW.head_id IS NOT NULL OR NEW.sequence<>0 THEN RAISE EXCEPTION 'Like initial count source mismatch' USING ERRCODE='23514';END IF;
 ELSE SELECT * INTO t FROM whaleu_ratings.like_transitions WHERE id=NEW.head_id;
 IF t.id IS NULL OR t.mutation_transaction<>pg_current_xact_id() OR NEW.subject_id<>OLD.subject_id OR (t.subject_id,t.previous_count,t.previous_head_id,t.new_count,t.sequence) IS DISTINCT FROM (OLD.subject_id,OLD.count,OLD.head_id,NEW.count,NEW.sequence) OR NEW.sequence<=OLD.sequence THEN RAISE EXCEPTION 'Like count predecessor mismatch' USING ERRCODE='23514';END IF;END IF;RETURN NEW;
END $$;
CREATE TRIGGER rating_like_state_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_ratings.like_states FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.like_state_guard();
CREATE FUNCTION whaleu_ratings.initialize_like_state() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO whaleu_ratings.like_states(subject_id,count) VALUES(NEW.id,0);RETURN NULL;END $$;
CREATE TRIGGER rating_like_initial_state AFTER INSERT ON whaleu_ratings.like_subjects FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.initialize_like_state();
CREATE FUNCTION whaleu_ratings.advance_like_state() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE whaleu_ratings.like_states SET count=NEW.new_count,head_id=NEW.id,sequence=NEW.sequence WHERE subject_id=NEW.subject_id;RETURN NULL;END $$;
CREATE TRIGGER a0_rating_like_state AFTER INSERT ON whaleu_ratings.like_transitions FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.advance_like_state();
CREATE FUNCTION whaleu_ratings.like_noop_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s whaleu_ratings.like_subjects;m whaleu_ratings.like_memberships;p whaleu_ratings.like_transitions;
BEGIN
 s:=whaleu_ratings.lock_like_subject(NEW.subject_id,NEW.account_id,NEW.request_id);SELECT * INTO m FROM whaleu_ratings.like_memberships WHERE subject_id=s.id AND account_id=NEW.account_id FOR SHARE NOWAIT;
 IF NEW.observation_transaction<>pg_current_xact_id() OR NEW.baseline_id<>s.baseline_id OR EXISTS(SELECT 1 FROM whaleu_ratings.like_transitions WHERE account_id=NEW.account_id AND request_id=NEW.request_id) THEN RAISE EXCEPTION 'Like noop is not independently observed' USING ERRCODE='23514';END IF;
 IF m.subject_id IS NULL THEN
 IF NEW.liked OR NEW.anchor_transition_id IS NOT NULL OR (NEW.revision,NEW.occurred_at) IS DISTINCT FROM (s.baseline_id,s.baseline_at) OR EXISTS(SELECT 1 FROM whaleu_ratings.like_transitions WHERE subject_id=s.id AND account_id=NEW.account_id LIMIT 1) THEN RAISE EXCEPTION 'Initial noop lacks actor negative proof' USING ERRCODE='23514';END IF;
 ELSE SELECT * INTO p FROM whaleu_ratings.like_transitions WHERE id=m.last_transition_id;
 IF p.id IS NULL OR (NEW.anchor_transition_id,NEW.liked,NEW.revision,NEW.occurred_at) IS DISTINCT FROM (m.last_transition_id,m.liked,m.revision,m.updated_at) OR (p.subject_id,p.account_id,p.new_revision,p.new_active_like_id,p.occurred_at) IS DISTINCT FROM (m.subject_id,m.account_id,m.revision,m.active_like_id,m.updated_at) THEN RAISE EXCEPTION 'Noop actor anchor mismatch' USING ERRCODE='23514';END IF;END IF;RETURN NEW;
END $$;
CREATE TRIGGER rating_like_noop_guard BEFORE INSERT ON whaleu_ratings.like_noop_observations FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.like_noop_guard();
-- Extend the typed source discriminant; community and old rating branches stay closed.
ALTER TABLE whaleu_ratings.effect_events ADD COLUMN like_transition_id uuid UNIQUE REFERENCES whaleu_ratings.like_transitions(id),ADD COLUMN subject_author_id uuid REFERENCES whaleu_identity.accounts(id),ADD COLUMN subject_author_mode text CHECK(subject_author_mode IN ('named','anonymous'));
DO $$ DECLARE c record;BEGIN
 FOR c IN SELECT conname,pg_get_constraintdef(oid) def FROM pg_constraint WHERE conrelid='whaleu_ratings.effect_events'::regclass AND contype='c' LOOP
 IF c.def LIKE '%source_version%' OR c.def LIKE '%rule_version%' OR c.def LIKE '%event_kind%' OR c.def LIKE '%comment_transition_id%' OR c.def LIKE '%reply_transition_id%' OR c.def LIKE '%reply_to_id%' THEN EXECUTE format('ALTER TABLE whaleu_ratings.effect_events DROP CONSTRAINT %I',c.conname);END IF;END LOOP;END $$;
ALTER TABLE whaleu_ratings.effect_events ADD CONSTRAINT rating_effect_typed_version CHECK(
 (source_version=1 AND rule_version='rating-effects-v1' AND event_kind IN ('root_created','reply_created','root_deleted','reply_deleted') AND like_transition_id IS NULL AND subject_author_id IS NULL AND subject_author_mode IS NULL AND (comment_transition_id IS NULL)<>(reply_transition_id IS NULL) AND (event_kind LIKE 'root_%')=(comment_transition_id IS NOT NULL) AND (reply_id IS NULL)=(comment_transition_id IS NOT NULL) AND (reply_to_id IS NULL)=(direct_reply_author_id IS NULL) AND (reply_id IS NOT NULL OR reply_to_id IS NULL))
 OR (source_version=2 AND rule_version='rating-likes-v1' AND event_kind IN ('content_liked','content_unliked') AND like_transition_id IS NOT NULL AND subject_author_id IS NOT NULL AND subject_author_mode IS NOT NULL AND comment_transition_id IS NULL AND reply_transition_id IS NULL AND reply_to_id IS NULL AND direct_reply_author_id IS NULL AND author_mode='named'));
DROP TRIGGER rating_effect_guard ON whaleu_ratings.effect_events;
CREATE TRIGGER rating_effect_guard BEFORE INSERT ON whaleu_ratings.effect_events FOR EACH ROW WHEN(NEW.source_version=1) EXECUTE FUNCTION whaleu_ratings.effect_guard();
CREATE FUNCTION whaleu_ratings.like_effect_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE t whaleu_ratings.like_transitions;s whaleu_ratings.like_subjects;c whaleu_ratings.comments;r whaleu_ratings.replies;target whaleu_ratings.targets;q whaleu_ratings.requests;author uuid;mode text;
BEGIN SELECT * INTO t FROM whaleu_ratings.like_transitions WHERE id=NEW.like_transition_id;SELECT * INTO s FROM whaleu_ratings.like_subjects WHERE id=t.subject_id;SELECT * INTO c FROM whaleu_ratings.comments WHERE id=t.root_id;SELECT * INTO r FROM whaleu_ratings.replies WHERE id=t.reply_id;SELECT * INTO target FROM whaleu_ratings.targets WHERE id=t.target_id;SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=t.account_id AND request_id=t.request_id;author:=CASE s.kind WHEN 'comment' THEN c.account_id ELSE r.account_id END;mode:=CASE s.kind WHEN 'comment' THEN c.author_mode ELSE r.author_mode END;
 IF pg_trigger_depth()<2 OR t.id IS NULL OR t.mutation_transaction<>pg_current_xact_id() OR q.receipt IS NOT NULL OR q.operation IS DISTINCT FROM t.operation OR ROW(NEW.event_kind,NEW.target_id,NEW.root_id,NEW.reply_id,NEW.actor_account_id,NEW.root_author_id,NEW.subject_author_id,NEW.subject_author_mode,NEW.region_id,NEW.request_id,NEW.occurred_at,NEW.mutation_transaction) IS DISTINCT FROM ROW(CASE WHEN t.delta=1 THEN 'content_liked' ELSE 'content_unliked' END,t.target_id,t.root_id,t.reply_id,t.account_id,c.account_id,author,mode,target.region_id,t.request_id,t.occurred_at,t.mutation_transaction) THEN RAISE EXCEPTION 'Like effect exact source mismatch' USING ERRCODE='23514';END IF;
 NEW.expected_experience_units:=CASE WHEN t.delta=-1 THEN 0 WHEN author=t.account_id THEN 1 ELSE 2 END;NEW.expected_direct_notice_obligations:=CASE WHEN t.delta=1 AND author<>t.account_id THEN 1 ELSE 0 END;RETURN NEW;
END $$;
CREATE TRIGGER rating_like_effect_guard BEFORE INSERT ON whaleu_ratings.effect_events FOR EACH ROW WHEN(NEW.source_version=2) EXECUTE FUNCTION whaleu_ratings.like_effect_guard();
CREATE OR REPLACE FUNCTION whaleu_ratings.expected_reward_units(event uuid) RETURNS TABLE(beneficiary_id uuid,action text) LANGUAGE sql STABLE AS $$
 SELECT actor_account_id,'comment'::text FROM whaleu_ratings.effect_events WHERE id=event AND source_version=1 AND event_kind IN ('root_created','reply_created')
 UNION ALL SELECT CASE WHEN reply_to_id IS NULL THEN root_author_id ELSE direct_reply_author_id END,'received_comment'::text FROM whaleu_ratings.effect_events WHERE id=event AND source_version=1 AND event_kind='reply_created' AND CASE WHEN reply_to_id IS NULL THEN root_author_id ELSE direct_reply_author_id END<>actor_account_id
 UNION ALL SELECT actor_account_id,'like_save'::text FROM whaleu_ratings.effect_events WHERE id=event AND source_version=2 AND event_kind='content_liked'
 UNION ALL SELECT subject_author_id,'received_like_save'::text FROM whaleu_ratings.effect_events WHERE id=event AND source_version=2 AND event_kind='content_liked' AND subject_author_id<>actor_account_id
$$;
CREATE OR REPLACE FUNCTION whaleu_ratings.expected_direct_notices(event uuid) RETURNS TABLE(recipient_account_id uuid,reason text) LANGUAGE sql STABLE AS $$
 SELECT root_author_id,'direct_root'::text FROM whaleu_ratings.effect_events WHERE id=event AND source_version=1 AND event_kind='reply_created' AND root_author_id<>actor_account_id AND root_author_id IS DISTINCT FROM direct_reply_author_id
 UNION ALL SELECT direct_reply_author_id,'direct_reply'::text FROM whaleu_ratings.effect_events WHERE id=event AND source_version=1 AND event_kind='reply_created' AND direct_reply_author_id IS NOT NULL AND direct_reply_author_id<>actor_account_id
 UNION ALL SELECT subject_author_id,'like'::text FROM whaleu_ratings.effect_events WHERE id=event AND source_version=2 AND event_kind='content_liked' AND subject_author_id<>actor_account_id
$$;
ALTER TABLE whaleu_ratings.notice_obligations DROP CONSTRAINT notice_obligations_reason_check;
ALTER TABLE whaleu_ratings.notice_obligations ALTER COLUMN reply_id DROP NOT NULL;
ALTER TABLE whaleu_ratings.notice_obligations ADD CHECK(reason IN ('direct_root','direct_reply','like')),ADD CHECK(reason='like' OR reply_id IS NOT NULL),ADD FOREIGN KEY(root_id,target_id) REFERENCES whaleu_ratings.comments(id,target_id);
CREATE FUNCTION whaleu_ratings.record_like_effect() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c whaleu_ratings.comments;r whaleu_ratings.replies;t whaleu_ratings.targets;event uuid:=gen_random_uuid();
BEGIN SELECT * INTO c FROM whaleu_ratings.comments WHERE id=NEW.root_id;SELECT * INTO r FROM whaleu_ratings.replies WHERE id=NEW.reply_id;SELECT * INTO t FROM whaleu_ratings.targets WHERE id=NEW.target_id;
 INSERT INTO whaleu_ratings.effect_events(id,source_version,rule_version,event_kind,target_id,root_id,reply_id,actor_account_id,author_mode,root_author_id,subject_author_id,subject_author_mode,region_id,like_transition_id,request_id,occurred_at,mutation_transaction,expected_experience_units,expected_direct_notice_obligations)
 VALUES(event,2,'rating-likes-v1',CASE WHEN NEW.delta=1 THEN 'content_liked' ELSE 'content_unliked' END,NEW.target_id,NEW.root_id,NEW.reply_id,NEW.account_id,'named',c.account_id,CASE WHEN NEW.reply_id IS NULL THEN c.account_id ELSE r.account_id END,CASE WHEN NEW.reply_id IS NULL THEN c.author_mode ELSE r.author_mode END,t.region_id,NEW.id,NEW.request_id,NEW.occurred_at,NEW.mutation_transaction,0,0);
 INSERT INTO whaleu_ratings.notice_obligations(event_id,recipient_account_id,reason,region_id,target_id,root_id,reply_id,source_transaction) SELECT event,n.recipient_account_id,n.reason,t.region_id,NEW.target_id,NEW.root_id,NEW.reply_id,NEW.mutation_transaction FROM whaleu_ratings.expected_direct_notices(event) n;RETURN NULL;
END $$;
CREATE TRIGGER rating_like_effect AFTER INSERT ON whaleu_ratings.like_transitions FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.record_like_effect();
ALTER TABLE whaleu_ratings.reward_groups ADD COLUMN like_transition_id uuid REFERENCES whaleu_ratings.like_transitions(id),ADD COLUMN subject_author_id uuid REFERENCES whaleu_identity.accounts(id),ADD COLUMN subject_author_mode text CHECK(subject_author_mode IN ('named','anonymous'));
ALTER TABLE whaleu_ratings.reward_groups DROP CONSTRAINT reward_groups_source_version_check,DROP CONSTRAINT reward_groups_event_kind_check;
ALTER TABLE whaleu_ratings.reward_groups ADD CHECK((source_version=1 AND event_kind IN ('root_created','reply_created') AND like_transition_id IS NULL AND subject_author_id IS NULL AND subject_author_mode IS NULL) OR (source_version=2 AND event_kind='content_liked' AND like_transition_id IS NOT NULL AND subject_author_id IS NOT NULL AND subject_author_mode IS NOT NULL AND reply_to_id IS NULL AND direct_reply_author_id IS NULL));
ALTER TABLE whaleu_ratings.reward_units DROP CONSTRAINT reward_units_action_check;
ALTER TABLE whaleu_ratings.reward_units ADD CHECK(action IN ('comment','received_comment','like_save','received_like_save'));
CREATE FUNCTION whaleu_ratings.like_reward_source_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e whaleu_ratings.effect_events;BEGIN SELECT * INTO e FROM whaleu_ratings.effect_events WHERE id=NEW.event_id;IF (NEW.like_transition_id,NEW.subject_author_id,NEW.subject_author_mode) IS DISTINCT FROM (e.like_transition_id,e.subject_author_id,e.subject_author_mode) THEN RAISE EXCEPTION 'Like reward source tuple mismatch' USING ERRCODE='23514';END IF;RETURN NEW;END $$;
CREATE TRIGGER rating_like_reward_source BEFORE INSERT ON whaleu_ratings.reward_groups FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.like_reward_source_guard();
ALTER TABLE whaleu_experience.source_groups DROP CONSTRAINT source_groups_source_version_check;
ALTER TABLE whaleu_experience.source_groups ADD CHECK((source_domain='community' AND source_version=1) OR (source_domain='ratings' AND source_version IN (1,2)));
-- Each request is validated by its own immutable transition or observation.
DROP TRIGGER rating_request_causal ON whaleu_ratings.requests;
CREATE CONSTRAINT TRIGGER rating_request_causal AFTER INSERT OR UPDATE ON whaleu_ratings.requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.operation NOT IN ('set_comment_like','set_reply_like')) EXECUTE FUNCTION whaleu_ratings.request_causal();
CREATE FUNCTION whaleu_ratings.like_request_causal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q whaleu_ratings.requests;t whaleu_ratings.like_transitions;n whaleu_ratings.like_noop_observations;s whaleu_ratings.like_subjects;keys text[];
BEGIN SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=NEW.account_id AND request_id=NEW.request_id;SELECT * INTO t FROM whaleu_ratings.like_transitions WHERE account_id=q.account_id AND request_id=q.request_id;SELECT * INTO n FROM whaleu_ratings.like_noop_observations WHERE account_id=q.account_id AND request_id=q.request_id;SELECT array_agg(k ORDER BY k) INTO keys FROM jsonb_object_keys(q.receipt) k;
 IF q.receipt IS NULL OR q.receipt->>'requestId' IS DISTINCT FROM q.request_id::text OR q.receipt->>'operation' IS DISTINCT FROM q.operation OR EXISTS(SELECT 1 FROM whaleu_ratings.score_transitions WHERE account_id=q.account_id AND request_id=q.request_id) OR EXISTS(SELECT 1 FROM whaleu_ratings.comment_transitions WHERE account_id=q.account_id AND request_id=q.request_id) OR EXISTS(SELECT 1 FROM whaleu_ratings.reply_transitions WHERE account_id=q.account_id AND request_id=q.request_id) THEN RAISE EXCEPTION 'Invalid like receipt source' USING ERRCODE='23514';END IF;
 IF q.receipt->>'outcome'='rejected' THEN
 IF keys IS DISTINCT FROM ARRAY['code','operation','outcome','requestId'] OR t.id IS NOT NULL OR n.subject_id IS NOT NULL OR NOT coalesce(q.receipt->>'code' IN ('RATING_NOT_FOUND','RATING_REVISION_CONFLICT','PHONE_VERIFICATION_REQUIRED','AFFILIATION_VERIFICATION_REQUIRED','IDENTITY_CAMPUS_REQUIRED','SAFETY_ACTION_RESTRICTED','CONTENT_REJECTED'),false) THEN RAISE EXCEPTION 'Invalid rejected like receipt' USING ERRCODE='23514';END IF;RETURN NULL;END IF;
 IF keys IS DISTINCT FROM ARRAY['liked','occurredAt','operation','outcome','replyId','requestId','revision','rootId','targetId'] OR jsonb_typeof(q.receipt->'liked') IS DISTINCT FROM 'boolean' OR NOT coalesce(q.receipt->>'occurredAt' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$',false) THEN RAISE EXCEPTION 'Invalid minimal like receipt' USING ERRCODE='23514';END IF;
 IF q.receipt->>'outcome'='applied' THEN
 IF t.id IS NULL OR n.subject_id IS NOT NULL OR (q.receipt->>'targetId',q.receipt->>'rootId',q.receipt->>'replyId',q.receipt->>'revision',(q.receipt->>'liked')::boolean,(q.receipt->>'occurredAt')::timestamptz) IS DISTINCT FROM (t.target_id::text,t.root_id::text,t.reply_id::text,t.new_revision::text,t.delta=1,t.occurred_at) THEN RAISE EXCEPTION 'Like receipt transition mismatch' USING ERRCODE='23514';END IF;
 ELSIF q.receipt->>'outcome'='noop' THEN SELECT * INTO s FROM whaleu_ratings.like_subjects WHERE id=n.subject_id;
 IF t.id IS NOT NULL OR n.subject_id IS NULL OR n.observation_transaction<>pg_current_xact_id() OR (q.receipt->>'targetId',q.receipt->>'rootId',q.receipt->>'replyId',q.receipt->>'revision',(q.receipt->>'liked')::boolean,(q.receipt->>'occurredAt')::timestamptz) IS DISTINCT FROM (s.target_id::text,s.root_id::text,s.reply_id::text,n.revision::text,n.liked,n.occurred_at) THEN RAISE EXCEPTION 'Like noop receipt observation mismatch' USING ERRCODE='23514';END IF;
 ELSE RAISE EXCEPTION 'Invalid like outcome' USING ERRCODE='23514';END IF;
 IF (q.operation='set_comment_like')<>(q.receipt->'replyId'='null'::jsonb) THEN RAISE EXCEPTION 'Like receipt typed subject mismatch' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER rating_like_request_causal AFTER INSERT OR UPDATE ON whaleu_ratings.requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.operation IN ('set_comment_like','set_reply_like')) EXECUTE FUNCTION whaleu_ratings.like_request_causal();
CREATE FUNCTION whaleu_ratings.like_transition_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE m whaleu_ratings.like_memberships;state whaleu_ratings.like_states;head whaleu_ratings.like_transitions;actor_head whaleu_ratings.like_transitions;q whaleu_ratings.requests;
BEGIN SELECT * INTO m FROM whaleu_ratings.like_memberships WHERE subject_id=NEW.subject_id AND account_id=NEW.account_id;SELECT * INTO state FROM whaleu_ratings.like_states WHERE subject_id=NEW.subject_id;SELECT * INTO head FROM whaleu_ratings.like_transitions WHERE id=state.head_id;SELECT * INTO actor_head FROM whaleu_ratings.like_transitions WHERE id=m.last_transition_id;SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=NEW.account_id AND request_id=NEW.request_id;
 IF NOT EXISTS(SELECT 1 FROM whaleu_ratings.effect_events e WHERE e.like_transition_id=NEW.id AND e.source_version=2 AND (e.actor_account_id,e.request_id,e.target_id,e.root_id,e.reply_id,e.occurred_at,e.mutation_transaction) IS NOT DISTINCT FROM (NEW.account_id,NEW.request_id,NEW.target_id,NEW.root_id,NEW.reply_id,NEW.occurred_at,NEW.mutation_transaction)) OR q.receipt->>'outcome' IS DISTINCT FROM 'applied' OR q.receipt->>'revision' IS DISTINCT FROM NEW.new_revision::text OR actor_head.id IS NULL OR actor_head.sequence<NEW.sequence OR (actor_head.subject_id,actor_head.account_id,actor_head.new_revision,actor_head.new_active_like_id,actor_head.occurred_at) IS DISTINCT FROM (m.subject_id,m.account_id,m.revision,m.active_like_id,m.updated_at) OR (m.last_transition_id<>NEW.id AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.like_transitions next WHERE next.previous_actor_transition_id=NEW.id AND (next.subject_id,next.account_id,next.old_revision,next.old_active_like_id) IS NOT DISTINCT FROM (NEW.subject_id,NEW.account_id,NEW.new_revision,NEW.new_active_like_id))) OR (state.head_id<>NEW.id AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.like_transitions next WHERE next.previous_head_id=NEW.id AND (next.subject_id,next.previous_count)=(NEW.subject_id,NEW.new_count))) OR head.id IS NULL OR head.sequence<NEW.sequence OR (head.subject_id,head.new_count,head.sequence) IS DISTINCT FROM (state.subject_id,state.count,state.sequence) THEN RAISE EXCEPTION 'Like transition projection incomplete' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER rating_like_transition_complete AFTER INSERT ON whaleu_ratings.like_transitions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.like_transition_complete();
CREATE FUNCTION whaleu_ratings.like_subject_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q whaleu_ratings.requests;req uuid;actor uuid;created timestamptz;revision uuid;
BEGIN
 IF NEW.kind='comment' THEN SELECT account_id,request_id,occurred_at,t.revision INTO actor,req,created,revision FROM whaleu_ratings.comment_transitions t WHERE id=NEW.comment_transition_id;
 ELSE SELECT account_id,request_id,occurred_at,t.revision INTO actor,req,created,revision FROM whaleu_ratings.reply_transitions t WHERE id=NEW.reply_transition_id;END IF;
 SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=actor AND request_id=req;
 IF q.receipt->>'outcome' IS DISTINCT FROM 'applied' OR q.receipt->>'revision' IS DISTINCT FROM revision::text OR (q.receipt->>'occurredAt')::timestamptz IS DISTINCT FROM created OR coalesce(q.receipt->>'subjectId',q.receipt->>'replyId') IS DISTINCT FROM NEW.id::text OR NOT EXISTS(SELECT 1 FROM whaleu_ratings.like_states WHERE subject_id=NEW.id) THEN RAISE EXCEPTION 'Native like baseline receipt incomplete' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER rating_like_subject_complete AFTER INSERT ON whaleu_ratings.like_subjects DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.like_subject_complete();
-- Enroll only rows with exact native create transition, publication xid, binding
-- and applied receipt. Missing evidence remains uncovered.
INSERT INTO whaleu_ratings.like_subjects(id,kind,target_id,root_id,reply_id,baseline_id,baseline_at,provenance,activation_id,comment_transition_id,publication_transaction)
 SELECT c.id,'comment',c.target_id,c.id,NULL,gen_random_uuid(),a.activated_at,'native-activation',a.id,t.id,c.publication_transaction FROM whaleu_ratings.comments c JOIN whaleu_ratings.comment_transitions t ON t.comment_id=c.id AND t.target_id=c.target_id AND t.operation='create_comment' AND (t.account_id,t.request_id,t.occurred_at,t.mutation_transaction)=(c.account_id,c.request_id,c.created_at,c.publication_transaction) JOIN whaleu_community.rating_approval_bindings b ON b.kind='comment' AND b.subject_id=c.id AND (b.envelope,b.publication_transaction,b.content_version)=(c.envelope,c.publication_transaction,1) JOIN whaleu_ratings.requests q ON q.account_id=c.account_id AND q.request_id=c.request_id AND q.operation='create_comment' AND q.receipt->>'outcome'='applied' AND q.receipt->>'revision'=t.revision::text AND q.receipt->>'subjectId'=c.id::text AND q.receipt->>'targetId'=c.target_id::text AND (q.receipt->>'occurredAt')::timestamptz=c.created_at CROSS JOIN whaleu_ratings.like_activations a;
INSERT INTO whaleu_ratings.like_subjects(id,kind,target_id,root_id,reply_id,baseline_id,baseline_at,provenance,activation_id,reply_transition_id,publication_transaction)
 SELECT r.id,'reply',r.target_id,r.root_id,r.id,gen_random_uuid(),a.activated_at,'native-activation',a.id,t.id,r.publication_transaction FROM whaleu_ratings.replies r JOIN whaleu_ratings.reply_transitions t ON t.reply_id=r.id AND t.root_id=r.root_id AND t.target_id=r.target_id AND t.operation='create_reply' AND (t.account_id,t.request_id,t.occurred_at,t.mutation_transaction)=(r.account_id,r.request_id,r.created_at,r.publication_transaction) JOIN whaleu_community.rating_approval_bindings b ON b.kind='reply' AND b.subject_id=r.id AND (b.envelope,b.publication_transaction,b.content_version)=(r.envelope,r.publication_transaction,1) JOIN whaleu_ratings.requests q ON q.account_id=r.account_id AND q.request_id=r.request_id AND q.operation='create_reply' AND q.receipt->>'outcome'='applied' AND q.receipt->>'revision'=t.revision::text AND q.receipt->>'replyId'=r.id::text AND q.receipt->>'targetId'=r.target_id::text AND (q.receipt->>'occurredAt')::timestamptz=r.created_at CROSS JOIN whaleu_ratings.like_activations a;
CREATE FUNCTION whaleu_ratings.enroll_native_like_subject() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c whaleu_ratings.comments;r whaleu_ratings.replies;t uuid;
BEGIN
 IF NEW.kind='comment' THEN SELECT * INTO c FROM whaleu_ratings.comments WHERE id=NEW.subject_id;SELECT id INTO t FROM whaleu_ratings.comment_transitions WHERE comment_id=c.id AND operation='create_comment';
 INSERT INTO whaleu_ratings.like_subjects(id,kind,target_id,root_id,baseline_id,baseline_at,provenance,comment_transition_id,publication_transaction) VALUES(c.id,'comment',c.target_id,c.id,gen_random_uuid(),c.created_at,'native-publication',t,c.publication_transaction);
 ELSIF NEW.kind='reply' THEN SELECT * INTO r FROM whaleu_ratings.replies WHERE id=NEW.subject_id;SELECT id INTO t FROM whaleu_ratings.reply_transitions WHERE reply_id=r.id AND operation='create_reply';
 INSERT INTO whaleu_ratings.like_subjects(id,kind,target_id,root_id,reply_id,baseline_id,baseline_at,provenance,reply_transition_id,publication_transaction) VALUES(r.id,'reply',r.target_id,r.root_id,r.id,gen_random_uuid(),r.created_at,'native-publication',t,r.publication_transaction);END IF;RETURN NULL;
END $$;
CREATE TRIGGER rating_like_native_publication AFTER INSERT ON whaleu_community.rating_approval_bindings FOR EACH ROW WHEN(NEW.kind IN ('comment','reply')) EXECUTE FUNCTION whaleu_ratings.enroll_native_like_subject();
DO $$ DECLARE tab text;BEGIN
 FOREACH tab IN ARRAY ARRAY['like_activations','like_subjects','like_transitions','like_noop_observations'] LOOP EXECUTE format('CREATE TRIGGER rating_like_immutable BEFORE UPDATE OR DELETE ON whaleu_ratings.%I FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.immutable()',tab);END LOOP;
 FOREACH tab IN ARRAY ARRAY['like_activations','like_subjects','like_transitions','like_noop_observations','like_memberships','like_states'] LOOP EXECUTE format('CREATE TRIGGER rating_like_retain BEFORE TRUNCATE ON whaleu_ratings.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.immutable()',tab);END LOOP;END $$;
