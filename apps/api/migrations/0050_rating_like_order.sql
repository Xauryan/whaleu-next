-- Bounded root ordering has its own total-coverage cutover and causal head.
-- The one activation scan is not part of any HTTP request or final proof.
LOCK TABLE whaleu_ratings.targets,whaleu_ratings.comments,whaleu_ratings.like_subjects,whaleu_ratings.like_states IN SHARE ROW EXCLUSIVE MODE;
CREATE TABLE whaleu_ratings.root_order_baselines (
 target_id uuid PRIMARY KEY REFERENCES whaleu_ratings.targets(id),id uuid NOT NULL UNIQUE,activation_id uuid NOT NULL REFERENCES whaleu_ratings.like_activations(id),missing integer NOT NULL CHECK(missing>=0),creation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id()
);
CREATE TABLE whaleu_ratings.root_order_heads (
 target_id uuid PRIMARY KEY REFERENCES whaleu_ratings.root_order_baselines(target_id),baseline_id uuid NOT NULL REFERENCES whaleu_ratings.root_order_baselines(id),head_id uuid,sequence bigint NOT NULL CHECK(sequence>=0),missing integer NOT NULL CHECK(missing>=0)
);
CREATE TABLE whaleu_ratings.root_order_events (
 id uuid PRIMARY KEY,target_id uuid NOT NULL,root_id uuid NOT NULL,kind text NOT NULL CHECK(kind IN ('content','like','enroll')),comment_transition_id uuid UNIQUE REFERENCES whaleu_ratings.comment_transitions(id),like_transition_id uuid UNIQUE REFERENCES whaleu_ratings.like_transitions(id),subject_baseline_id uuid UNIQUE REFERENCES whaleu_ratings.like_subjects(baseline_id),
 previous_head_id uuid REFERENCES whaleu_ratings.root_order_events(id),previous_missing integer NOT NULL CHECK(previous_missing>=0),new_missing integer NOT NULL CHECK(new_missing>=0),previous_entry_event_id uuid REFERENCES whaleu_ratings.root_order_events(id),live boolean NOT NULL,known boolean NOT NULL,count integer CHECK(count>=0),
 mutation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE CHECK(sequence>0),FOREIGN KEY(root_id,target_id) REFERENCES whaleu_ratings.comments(id,target_id),UNIQUE(id,target_id,sequence),
 CHECK(known=(count IS NOT NULL)),CHECK((kind='content' AND comment_transition_id IS NOT NULL AND like_transition_id IS NULL AND subject_baseline_id IS NULL) OR (kind='like' AND comment_transition_id IS NULL AND like_transition_id IS NOT NULL AND subject_baseline_id IS NULL) OR (kind='enroll' AND comment_transition_id IS NULL AND like_transition_id IS NULL AND subject_baseline_id IS NOT NULL))
);
CREATE UNIQUE INDEX rating_root_order_successor ON whaleu_ratings.root_order_events(previous_head_id) WHERE previous_head_id IS NOT NULL;
CREATE UNIQUE INDEX rating_root_order_initial ON whaleu_ratings.root_order_events(target_id) WHERE previous_head_id IS NULL;
CREATE UNIQUE INDEX rating_root_entry_successor ON whaleu_ratings.root_order_events(previous_entry_event_id) WHERE previous_entry_event_id IS NOT NULL;
CREATE TABLE whaleu_ratings.root_order_entries (
 root_id uuid PRIMARY KEY,target_id uuid NOT NULL,created_at timestamptz NOT NULL,created_micros bigint NOT NULL,ordinal bigint NOT NULL CHECK(ordinal>0),live boolean NOT NULL,known boolean NOT NULL,count integer CHECK(count>=0),event_id uuid REFERENCES whaleu_ratings.root_order_events(id),
 FOREIGN KEY(root_id,target_id) REFERENCES whaleu_ratings.comments(id,target_id),CHECK(known=(count IS NOT NULL)),CHECK(created_micros=(extract(epoch FROM created_at)*1000000)::bigint)
);
ALTER TABLE whaleu_ratings.root_order_heads ADD FOREIGN KEY(head_id,target_id,sequence) REFERENCES whaleu_ratings.root_order_events(id,target_id,sequence);
INSERT INTO whaleu_ratings.root_order_baselines(target_id,id,activation_id,missing)
 SELECT t.id,gen_random_uuid(),a.id,(SELECT count(*)::integer FROM whaleu_ratings.comments c LEFT JOIN whaleu_ratings.like_states s ON s.subject_id=c.id WHERE c.target_id=t.id AND c.deleted_at IS NULL AND s.subject_id IS NULL) FROM whaleu_ratings.targets t CROSS JOIN whaleu_ratings.like_activations a;
INSERT INTO whaleu_ratings.root_order_heads SELECT target_id,id,NULL,0,missing FROM whaleu_ratings.root_order_baselines;
INSERT INTO whaleu_ratings.root_order_entries SELECT c.id,c.target_id,c.created_at,(extract(epoch FROM c.created_at)*1000000)::bigint,c.ordinal,c.deleted_at IS NULL,s.subject_id IS NOT NULL,s.count,NULL FROM whaleu_ratings.comments c LEFT JOIN whaleu_ratings.like_states s ON s.subject_id=c.id;
-- Aligned seek keys support indexed tuple ranges without a post-scan OR filter.
-- Actual physical plans and metadata visits still depend on the planner and data.
CREATE INDEX rating_root_likes_asc ON whaleu_ratings.root_order_entries(target_id,count,(-created_micros),(-ordinal)) WHERE live AND known;
CREATE INDEX rating_root_likes_desc ON whaleu_ratings.root_order_entries(target_id,(-count),(-created_micros),(-ordinal)) WHERE live AND known;
CREATE INDEX rating_root_time ON whaleu_ratings.root_order_entries(target_id,created_micros,ordinal) WHERE live;
CREATE FUNCTION whaleu_ratings.root_order_baseline_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF pg_trigger_depth()<2 OR NEW.creation_transaction<>pg_current_xact_id() OR NEW.missing<>0 OR NOT EXISTS(SELECT 1 FROM whaleu_ratings.targets WHERE id=NEW.target_id AND creation_transaction=pg_current_xact_id()) OR EXISTS(SELECT 1 FROM whaleu_ratings.comments WHERE target_id=NEW.target_id LIMIT 1) THEN RAISE EXCEPTION 'Root order baseline is native-target-owned' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER rating_root_order_baseline_guard BEFORE INSERT ON whaleu_ratings.root_order_baselines FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.root_order_baseline_guard();
CREATE FUNCTION whaleu_ratings.initialize_root_order() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b uuid:=gen_random_uuid();a uuid;
BEGIN SELECT id INTO a FROM whaleu_ratings.like_activations WHERE version=1;INSERT INTO whaleu_ratings.root_order_baselines(target_id,id,activation_id,missing) VALUES(NEW.id,b,a,0);INSERT INTO whaleu_ratings.root_order_heads(target_id,baseline_id,head_id,sequence,missing) VALUES(NEW.id,b,NULL,0,0);RETURN NULL;
END $$;
CREATE TRIGGER rating_root_order_target AFTER INSERT ON whaleu_ratings.targets FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.initialize_root_order();
CREATE FUNCTION whaleu_ratings.root_order_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c whaleu_ratings.comments;st whaleu_ratings.like_states;h whaleu_ratings.root_order_heads;prior whaleu_ratings.root_order_entries;ct whaleu_ratings.comment_transitions;lt whaleu_ratings.like_transitions;s whaleu_ratings.like_subjects;new_live boolean;new_known boolean;expected_missing integer;
BEGIN
 PERFORM id FROM whaleu_ratings.targets WHERE id=NEW.target_id FOR UPDATE NOWAIT;
 SELECT * INTO c FROM whaleu_ratings.comments WHERE id=NEW.root_id AND target_id=NEW.target_id FOR UPDATE NOWAIT;SELECT * INTO st FROM whaleu_ratings.like_states WHERE subject_id=c.id;SELECT * INTO h FROM whaleu_ratings.root_order_heads WHERE target_id=c.target_id FOR UPDATE NOWAIT;SELECT * INTO prior FROM whaleu_ratings.root_order_entries WHERE root_id=c.id;
 IF pg_trigger_depth()<2 OR c.id IS NULL OR h.target_id IS NULL OR NEW.mutation_transaction<>pg_current_xact_id() THEN RAISE EXCEPTION 'Root order source is absent' USING ERRCODE='23514';END IF;
 IF NEW.kind='content' THEN SELECT * INTO ct FROM whaleu_ratings.comment_transitions WHERE id=NEW.comment_transition_id;
 IF ct.id IS NULL OR ct.mutation_transaction<>pg_current_xact_id() OR (ct.comment_id,ct.target_id,ct.revision) IS DISTINCT FROM (c.id,c.target_id,c.revision) OR (ct.operation='create_comment' AND (prior.root_id IS NOT NULL OR c.publication_transaction<>pg_current_xact_id())) OR (ct.operation='delete_comment' AND (prior.root_id IS NULL OR c.deleted_at IS NULL)) THEN RAISE EXCEPTION 'Root order content source mismatch' USING ERRCODE='23514';END IF;
 ELSIF NEW.kind='like' THEN SELECT * INTO lt FROM whaleu_ratings.like_transitions WHERE id=NEW.like_transition_id;
 IF lt.id IS NULL OR lt.mutation_transaction<>pg_current_xact_id() OR lt.reply_id IS NOT NULL OR lt.subject_id<>c.id OR (st.head_id,st.count) IS DISTINCT FROM (lt.id,lt.new_count) OR prior.root_id IS NULL THEN RAISE EXCEPTION 'Root order like source mismatch' USING ERRCODE='23514';END IF;
 ELSE SELECT * INTO s FROM whaleu_ratings.like_subjects WHERE baseline_id=NEW.subject_baseline_id;
 IF s.id IS DISTINCT FROM c.id OR s.kind<>'comment' OR s.creation_transaction<>pg_current_xact_id() OR st.subject_id IS NULL OR prior.root_id IS NULL OR prior.known THEN RAISE EXCEPTION 'Root order enrollment mismatch' USING ERRCODE='23514';END IF;END IF;
 new_live:=c.deleted_at IS NULL;new_known:=st.subject_id IS NOT NULL;expected_missing:=h.missing+CASE WHEN new_live AND NOT new_known THEN 1 ELSE 0 END-CASE WHEN prior.live AND NOT prior.known THEN 1 ELSE 0 END;
 IF (NEW.previous_head_id,NEW.previous_missing,NEW.new_missing,NEW.previous_entry_event_id,NEW.live,NEW.known,NEW.count) IS DISTINCT FROM (h.head_id,h.missing,expected_missing,prior.event_id,new_live,new_known,st.count) THEN RAISE EXCEPTION 'Root order projection source mismatch' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER rating_root_order_event_guard BEFORE INSERT ON whaleu_ratings.root_order_events FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.root_order_event_guard();
CREATE FUNCTION whaleu_ratings.root_order_projection_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e whaleu_ratings.root_order_events;b whaleu_ratings.root_order_baselines;c whaleu_ratings.comments;
BEGIN
 IF TG_OP='DELETE' OR pg_trigger_depth()<2 THEN RAISE EXCEPTION 'Root order is SQL source-owned' USING ERRCODE='23514';END IF;
 IF TG_TABLE_NAME='root_order_heads' THEN
 IF TG_OP='INSERT' THEN SELECT * INTO b FROM whaleu_ratings.root_order_baselines WHERE target_id=NEW.target_id;
 IF b.creation_transaction<>pg_current_xact_id() OR (NEW.baseline_id,NEW.head_id,NEW.sequence,NEW.missing) IS DISTINCT FROM (b.id,NULL::uuid,0::bigint,b.missing) THEN RAISE EXCEPTION 'Root order head baseline mismatch' USING ERRCODE='23514';END IF;
 ELSE SELECT * INTO e FROM whaleu_ratings.root_order_events WHERE id=NEW.head_id;
 IF e.id IS NULL OR e.mutation_transaction<>pg_current_xact_id() OR (NEW.target_id,NEW.baseline_id) IS DISTINCT FROM (OLD.target_id,OLD.baseline_id) OR NEW.sequence<=OLD.sequence OR (e.target_id,e.previous_head_id,e.previous_missing,e.new_missing,e.sequence) IS DISTINCT FROM (OLD.target_id,OLD.head_id,OLD.missing,NEW.missing,NEW.sequence) THEN RAISE EXCEPTION 'Root order head predecessor mismatch' USING ERRCODE='23514';END IF;END IF;
 ELSE SELECT * INTO e FROM whaleu_ratings.root_order_events WHERE id=NEW.event_id;SELECT * INTO c FROM whaleu_ratings.comments WHERE id=NEW.root_id;
 IF e.id IS NULL OR e.mutation_transaction<>pg_current_xact_id() OR (NEW.root_id,NEW.target_id,NEW.created_at,NEW.created_micros,NEW.ordinal,NEW.live,NEW.known,NEW.count) IS DISTINCT FROM (e.root_id,e.target_id,c.created_at,(extract(epoch FROM c.created_at)*1000000)::bigint,c.ordinal,e.live,e.known,e.count) THEN RAISE EXCEPTION 'Root order entry source mismatch' USING ERRCODE='23514';END IF;
 IF TG_OP='UPDATE' AND (NEW.root_id<>OLD.root_id OR e.previous_entry_event_id IS DISTINCT FROM OLD.event_id) THEN RAISE EXCEPTION 'Root order entry predecessor mismatch' USING ERRCODE='23514';END IF;END IF;RETURN NEW;
END $$;
CREATE TRIGGER rating_root_order_head_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_ratings.root_order_heads FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.root_order_projection_guard();
CREATE TRIGGER rating_root_order_entry_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_ratings.root_order_entries FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.root_order_projection_guard();
CREATE FUNCTION whaleu_ratings.project_root_order_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO whaleu_ratings.root_order_entries(root_id,target_id,created_at,created_micros,ordinal,live,known,count,event_id) SELECT c.id,c.target_id,c.created_at,(extract(epoch FROM c.created_at)*1000000)::bigint,c.ordinal,NEW.live,NEW.known,NEW.count,NEW.id FROM whaleu_ratings.comments c WHERE c.id=NEW.root_id ON CONFLICT(root_id) DO UPDATE SET live=EXCLUDED.live,known=EXCLUDED.known,count=EXCLUDED.count,event_id=EXCLUDED.event_id;
 UPDATE whaleu_ratings.root_order_heads SET head_id=NEW.id,sequence=NEW.sequence,missing=NEW.new_missing WHERE target_id=NEW.target_id;RETURN NULL;
END $$;
CREATE TRIGGER rating_root_order_project AFTER INSERT ON whaleu_ratings.root_order_events FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.project_root_order_event();
CREATE FUNCTION whaleu_ratings.record_root_order_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c whaleu_ratings.comments;st whaleu_ratings.like_states;prior whaleu_ratings.root_order_entries;h whaleu_ratings.root_order_heads;source_kind text;ct uuid;lt uuid;baseline uuid;root uuid;
BEGIN
 IF TG_TABLE_NAME='comment_transitions' THEN root:=NEW.comment_id;source_kind:='content';ct:=NEW.id;
 ELSIF TG_TABLE_NAME='like_transitions' THEN IF NEW.reply_id IS NOT NULL THEN RETURN NULL;END IF;root:=NEW.root_id;source_kind:='like';lt:=NEW.id;
 ELSE IF NEW.kind<>'comment' THEN RETURN NULL;END IF;root:=NEW.root_id;source_kind:='enroll';baseline:=NEW.baseline_id;END IF;
 SELECT * INTO c FROM whaleu_ratings.comments WHERE id=root;SELECT * INTO st FROM whaleu_ratings.like_states WHERE subject_id=root;SELECT * INTO prior FROM whaleu_ratings.root_order_entries WHERE root_id=root;SELECT * INTO h FROM whaleu_ratings.root_order_heads WHERE target_id=c.target_id;
 INSERT INTO whaleu_ratings.root_order_events(id,target_id,root_id,kind,comment_transition_id,like_transition_id,subject_baseline_id,previous_head_id,previous_missing,new_missing,previous_entry_event_id,live,known,count)
 VALUES(gen_random_uuid(),c.target_id,c.id,source_kind,ct,lt,baseline,h.head_id,h.missing,h.missing+CASE WHEN c.deleted_at IS NULL AND st.subject_id IS NULL THEN 1 ELSE 0 END-CASE WHEN prior.live AND NOT prior.known THEN 1 ELSE 0 END,prior.event_id,c.deleted_at IS NULL,st.subject_id IS NOT NULL,st.count);RETURN NULL;
END $$;
CREATE TRIGGER z_rating_root_order_content AFTER INSERT ON whaleu_ratings.comment_transitions FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.record_root_order_event();
CREATE TRIGGER z_rating_root_order_like AFTER INSERT ON whaleu_ratings.like_transitions FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.record_root_order_event();
CREATE TRIGGER z_rating_root_order_enroll AFTER INSERT ON whaleu_ratings.like_subjects FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.record_root_order_event();
CREATE FUNCTION whaleu_ratings.root_order_event_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE h whaleu_ratings.root_order_heads;p whaleu_ratings.root_order_entries;e whaleu_ratings.root_order_events;
BEGIN SELECT * INTO h FROM whaleu_ratings.root_order_heads WHERE target_id=NEW.target_id;SELECT * INTO p FROM whaleu_ratings.root_order_entries WHERE root_id=NEW.root_id;SELECT * INTO e FROM whaleu_ratings.root_order_events WHERE id=h.head_id;
 IF e.id IS NULL OR h.sequence<NEW.sequence OR (h.target_id,h.missing,h.sequence) IS DISTINCT FROM (e.target_id,e.new_missing,e.sequence) OR (h.head_id<>NEW.id AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.root_order_events next WHERE next.previous_head_id=NEW.id AND (next.target_id,next.previous_missing)=(NEW.target_id,NEW.new_missing))) OR p.event_id IS NULL OR (p.event_id<>NEW.id AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.root_order_events next WHERE next.previous_entry_event_id=NEW.id AND next.root_id=NEW.root_id)) OR NOT EXISTS(SELECT 1 FROM whaleu_ratings.root_order_events tail WHERE tail.id=p.event_id AND (tail.root_id,tail.target_id,tail.live,tail.known,tail.count) IS NOT DISTINCT FROM (p.root_id,p.target_id,p.live,p.known,p.count)) THEN RAISE EXCEPTION 'Root order chain incomplete' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER rating_root_order_event_complete AFTER INSERT ON whaleu_ratings.root_order_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.root_order_event_complete();
CREATE FUNCTION whaleu_ratings.root_order_source_complete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='comment_transitions' THEN IF NOT EXISTS(SELECT 1 FROM whaleu_ratings.root_order_events WHERE comment_transition_id=NEW.id) THEN RAISE EXCEPTION 'Root order content source missing' USING ERRCODE='23514';END IF;
 ELSIF TG_TABLE_NAME='like_transitions' THEN IF NEW.reply_id IS NULL AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.root_order_events WHERE like_transition_id=NEW.id) THEN RAISE EXCEPTION 'Root order like source missing' USING ERRCODE='23514';END IF;
 ELSE IF NEW.kind='comment' AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.root_order_events WHERE subject_baseline_id=NEW.baseline_id) THEN RAISE EXCEPTION 'Root order enrollment source missing' USING ERRCODE='23514';END IF;END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER rating_root_order_content_complete AFTER INSERT ON whaleu_ratings.comment_transitions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.root_order_source_complete();
CREATE CONSTRAINT TRIGGER rating_root_order_like_complete AFTER INSERT ON whaleu_ratings.like_transitions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.root_order_source_complete();
CREATE CONSTRAINT TRIGGER rating_root_order_enroll_complete AFTER INSERT ON whaleu_ratings.like_subjects DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.root_order_source_complete();
DO $$ DECLARE tab text;BEGIN
 FOREACH tab IN ARRAY ARRAY['root_order_baselines','root_order_events'] LOOP EXECUTE format('CREATE TRIGGER rating_root_order_immutable BEFORE UPDATE OR DELETE ON whaleu_ratings.%I FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.immutable()',tab);END LOOP;
 FOREACH tab IN ARRAY ARRAY['root_order_baselines','root_order_events','root_order_entries','root_order_heads'] LOOP EXECUTE format('CREATE TRIGGER rating_root_order_retain BEFORE TRUNCATE ON whaleu_ratings.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.immutable()',tab);END LOOP;END $$;
CREATE FUNCTION whaleu_ratings.root_order_target_complete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM whaleu_ratings.root_order_baselines b JOIN whaleu_ratings.root_order_heads h ON (h.target_id,h.baseline_id)=(b.target_id,b.id) WHERE b.target_id=NEW.id AND b.creation_transaction=NEW.creation_transaction) THEN RAISE EXCEPTION 'Native target root order baseline missing' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER rating_root_order_target_complete AFTER INSERT ON whaleu_ratings.targets DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.root_order_target_complete();
