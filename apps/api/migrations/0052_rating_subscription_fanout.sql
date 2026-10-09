-- Bounded, durable, local-only subscription fan-out. No history replay.
SET LOCAL lock_timeout='5s';
SELECT pg_advisory_xact_lock(hashtextextended('whaleu:named-block-policy:v1',0));
LOCK TABLE whaleu_ratings.targets,whaleu_ratings.comments,whaleu_ratings.replies,whaleu_ratings.requests,whaleu_ratings.effect_events IN SHARE ROW EXCLUSIVE MODE;
CREATE TABLE whaleu_ratings.subscription_fanout_activations (
 id uuid PRIMARY KEY,version integer NOT NULL UNIQUE CHECK(version=1),subscription_activation_id uuid NOT NULL REFERENCES whaleu_ratings.subscription_activations(id),activation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),activated_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(activated_at))
);
INSERT INTO whaleu_ratings.subscription_fanout_activations(id,version,subscription_activation_id) SELECT gen_random_uuid(),1,id FROM whaleu_ratings.subscription_activations WHERE version=1;
CREATE TABLE whaleu_ratings.subscription_fanout_sources (
 event_id uuid PRIMARY KEY REFERENCES whaleu_ratings.effect_events(id),activation_id uuid NOT NULL REFERENCES whaleu_ratings.subscription_fanout_activations(id),source_version integer NOT NULL DEFAULT 1 CHECK(source_version=1),target_id uuid NOT NULL REFERENCES whaleu_ratings.targets(id),root_id uuid NOT NULL,reply_id uuid,actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),target_order bigint NOT NULL CHECK(target_order>0),baseline_id uuid REFERENCES whaleu_ratings.subscription_baselines(id),captured_coverage text NOT NULL CHECK(captured_coverage IN ('complete','unknown')),source_transaction xid8 NOT NULL,
 UNIQUE(target_id,target_order),UNIQUE(event_id,target_id),FOREIGN KEY(root_id,target_id) REFERENCES whaleu_ratings.comments(id,target_id),FOREIGN KEY(reply_id,root_id,target_id) REFERENCES whaleu_ratings.replies(id,root_id,target_id),FOREIGN KEY(target_id,target_order) REFERENCES whaleu_ratings.subscription_stream_entries(target_id,target_order),CHECK((captured_coverage='complete')=(baseline_id IS NOT NULL))
);
CREATE TABLE whaleu_notifications.rating_subscription_fanout_jobs (
 event_id uuid PRIMARY KEY REFERENCES whaleu_ratings.subscription_fanout_sources(event_id),last_page integer NOT NULL DEFAULT 0 CHECK(last_page>=0),cursor_order bigint,cursor_epoch_id uuid,scan_finished boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(created_at)),CHECK((cursor_order IS NULL)=(cursor_epoch_id IS NULL)),CHECK(cursor_order IS NULL OR cursor_order>0)
);
CREATE TABLE whaleu_notifications.rating_subscription_fanout_pages (
 event_id uuid NOT NULL REFERENCES whaleu_notifications.rating_subscription_fanout_jobs(event_id),page_number integer NOT NULL CHECK(page_number>0),before_order bigint,before_epoch_id uuid,through_order bigint,through_epoch_id uuid,raw_epoch_ids uuid[] NOT NULL,raw_count integer NOT NULL CHECK(raw_count BETWEEN 0 AND 50),scan_finished boolean NOT NULL,creation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(created_at)),
 PRIMARY KEY(event_id,page_number),CHECK(cardinality(raw_epoch_ids)=raw_count),CHECK((before_order IS NULL)=(before_epoch_id IS NULL)),CHECK((through_order IS NULL)=(through_epoch_id IS NULL)),CHECK(raw_count>0 OR scan_finished),CHECK(raw_count=50 OR scan_finished)
);
CREATE TABLE whaleu_notifications.rating_subscription_recipient_work (
 event_id uuid NOT NULL,recipient_account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),epoch_id uuid NOT NULL REFERENCES whaleu_ratings.subscription_epochs(id),target_id uuid NOT NULL,page_number integer NOT NULL,status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','retry','materialized','suppressed')),attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),code text,next_attempt_at timestamptz,updated_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(updated_at)),
 PRIMARY KEY(event_id,recipient_account_id),UNIQUE(event_id,recipient_account_id,epoch_id),FOREIGN KEY(event_id,page_number) REFERENCES whaleu_notifications.rating_subscription_fanout_pages(event_id,page_number),FOREIGN KEY(event_id,target_id) REFERENCES whaleu_ratings.subscription_fanout_sources(event_id,target_id),CHECK(next_attempt_at IS NULL OR isfinite(next_attempt_at)),CHECK((status='retry')=(next_attempt_at IS NOT NULL)),CHECK((status IN ('retry','suppressed'))=(code IS NOT NULL))
);
ALTER TABLE whaleu_notifications.rating_subscription_recipient_work ADD FOREIGN KEY(epoch_id,target_id,recipient_account_id) REFERENCES whaleu_ratings.subscription_epochs(id,target_id,account_id);
CREATE INDEX rating_subscription_work_page ON whaleu_notifications.rating_subscription_recipient_work(event_id,page_number);
CREATE INDEX rating_subscription_work_pending ON whaleu_notifications.rating_subscription_recipient_work(event_id,next_attempt_at,recipient_account_id) WHERE status IN ('pending','retry');
CREATE TABLE whaleu_notifications.rating_subscription_notices (
 id uuid PRIMARY KEY,event_id uuid NOT NULL,recipient_account_id uuid NOT NULL REFERENCES whaleu_notifications.owners(account_id),epoch_id uuid NOT NULL,kind text NOT NULL DEFAULT 'subscription' CHECK(kind='subscription'),reason text NOT NULL DEFAULT 'target_subscription' CHECK(reason='target_subscription'),activity text NOT NULL CHECK(activity IN ('root','reply')),region_id uuid REFERENCES whaleu_campus.operating_regions(id),target_id uuid NOT NULL,root_id uuid NOT NULL,reply_id uuid,occurred_at timestamptz NOT NULL CHECK(isfinite(occurred_at)),event_sequence bigint NOT NULL CHECK(event_sequence>0),ordinal bigint GENERATED ALWAYS AS IDENTITY UNIQUE,created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(created_at)),read_at timestamptz CHECK(read_at IS NULL OR (isfinite(read_at) AND read_at>=created_at)),
 UNIQUE(event_id,recipient_account_id),UNIQUE(id,event_id,recipient_account_id,epoch_id),FOREIGN KEY(event_id,recipient_account_id,epoch_id) REFERENCES whaleu_notifications.rating_subscription_recipient_work(event_id,recipient_account_id,epoch_id),FOREIGN KEY(root_id,target_id) REFERENCES whaleu_ratings.comments(id,target_id),FOREIGN KEY(reply_id,root_id,target_id) REFERENCES whaleu_ratings.replies(id,root_id,target_id),CHECK((activity='root')=(reply_id IS NULL)),CHECK(ordinal>0)
);
CREATE INDEX rating_subscription_notices_owner ON whaleu_notifications.rating_subscription_notices(recipient_account_id,ordinal DESC);
CREATE INDEX rating_subscription_notices_unread ON whaleu_notifications.rating_subscription_notices(recipient_account_id) WHERE read_at IS NULL;
CREATE TABLE whaleu_notifications.rating_subscription_processing_receipts (
 event_id uuid NOT NULL,recipient_account_id uuid NOT NULL,epoch_id uuid NOT NULL,reason text NOT NULL DEFAULT 'target_subscription' CHECK(reason='target_subscription'),outcome text NOT NULL CHECK(outcome IN ('materialized','suppressed')),code text,notice_id uuid,created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(created_at)),
 PRIMARY KEY(event_id,recipient_account_id),FOREIGN KEY(event_id,recipient_account_id,epoch_id) REFERENCES whaleu_notifications.rating_subscription_recipient_work(event_id,recipient_account_id,epoch_id),FOREIGN KEY(notice_id,event_id,recipient_account_id,epoch_id) REFERENCES whaleu_notifications.rating_subscription_notices(id,event_id,recipient_account_id,epoch_id),CHECK((outcome='materialized' AND notice_id IS NOT NULL AND code IS NULL) OR (outcome='suppressed' AND notice_id IS NULL AND code IN ('epoch_ended','target_inaccessible')))
);
CREATE TABLE whaleu_notifications.rating_subscription_event_receipts (
 event_id uuid PRIMARY KEY REFERENCES whaleu_ratings.subscription_fanout_sources(event_id),outcome text NOT NULL DEFAULT 'processed' CHECK(outcome='processed'),created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(created_at))
);
CREATE FUNCTION whaleu_ratings.subscription_fanout_source_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e whaleu_ratings.effect_events;s whaleu_ratings.subscription_stream_entries;b whaleu_ratings.subscription_baselines;publication xid8;
BEGIN
 SELECT * INTO e FROM whaleu_ratings.effect_events WHERE id=NEW.event_id;
 PERFORM id FROM whaleu_ratings.targets WHERE id=NEW.target_id FOR UPDATE NOWAIT;
 SELECT * INTO s FROM whaleu_ratings.subscription_stream_entries WHERE target_id=NEW.target_id AND target_order=NEW.target_order;
 SELECT * INTO b FROM whaleu_ratings.subscription_baselines WHERE target_id=NEW.target_id;
 IF e.event_kind='root_created' THEN SELECT publication_transaction INTO publication FROM whaleu_ratings.comments WHERE id=e.root_id AND target_id=e.target_id;
 ELSE SELECT publication_transaction INTO publication FROM whaleu_ratings.replies WHERE id=e.reply_id AND root_id=e.root_id AND target_id=e.target_id;END IF;
 IF pg_trigger_depth()<2 OR e.id IS NULL OR e.source_version<>1 OR e.rule_version<>'rating-effects-v1' OR e.event_kind NOT IN ('root_created','reply_created') OR e.mutation_transaction<>pg_current_xact_id() OR publication IS DISTINCT FROM pg_current_xact_id() OR
 ROW(NEW.target_id,NEW.root_id,NEW.reply_id,NEW.actor_id,NEW.source_transaction) IS DISTINCT FROM ROW(e.target_id,e.root_id,e.reply_id,e.actor_account_id,e.mutation_transaction) OR
 ROW(s.kind,s.source_id,s.mutation_transaction) IS DISTINCT FROM ROW('publication'::text,e.id,e.mutation_transaction) OR NEW.baseline_id IS DISTINCT FROM b.id OR NEW.captured_coverage IS DISTINCT FROM (CASE WHEN b.id IS NULL THEN 'unknown' ELSE 'complete' END) OR NOT EXISTS(SELECT 1 FROM whaleu_ratings.subscription_fanout_activations WHERE id=NEW.activation_id AND version=1)
 THEN RAISE EXCEPTION 'Invalid subscription publication source' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER subscription_fanout_source_guard BEFORE INSERT ON whaleu_ratings.subscription_fanout_sources FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.subscription_fanout_source_guard();
CREATE FUNCTION whaleu_ratings.capture_subscription_fanout() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE activation uuid;baseline uuid;event_order bigint;
BEGIN
 IF NEW.source_version<>1 OR NEW.event_kind NOT IN ('root_created','reply_created') THEN RETURN NULL;END IF;
 SELECT id INTO activation FROM whaleu_ratings.subscription_fanout_activations WHERE version=1;
 IF activation IS NULL THEN RAISE EXCEPTION 'Subscription fanout activation missing' USING ERRCODE='23514';END IF;
 event_order:=whaleu_ratings.next_subscription_order(NEW.target_id,'publication',NEW.id);
 SELECT id INTO baseline FROM whaleu_ratings.subscription_baselines WHERE target_id=NEW.target_id;
 INSERT INTO whaleu_ratings.subscription_fanout_sources(event_id,activation_id,target_id,root_id,reply_id,actor_id,target_order,baseline_id,captured_coverage,source_transaction) VALUES(NEW.id,activation,NEW.target_id,NEW.root_id,NEW.reply_id,NEW.actor_account_id,event_order,baseline,CASE WHEN baseline IS NULL THEN 'unknown' ELSE 'complete' END,NEW.mutation_transaction);
 INSERT INTO whaleu_notifications.rating_subscription_fanout_jobs(event_id) VALUES(NEW.id);
 RETURN NULL;
END $$;
CREATE TRIGGER rating_subscription_fanout_capture AFTER INSERT ON whaleu_ratings.effect_events FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.capture_subscription_fanout();
CREATE FUNCTION whaleu_ratings.subscription_fanout_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE eid uuid;kind text;
BEGIN
 IF TG_TABLE_NAME='effect_events' THEN eid:=NEW.id;kind:=NEW.event_kind;ELSE eid:=NEW.event_id;SELECT event_kind INTO kind FROM whaleu_ratings.effect_events WHERE id=eid;END IF;
 IF kind IN ('root_created','reply_created') AND (NOT EXISTS(SELECT 1 FROM whaleu_ratings.subscription_fanout_sources WHERE event_id=eid) OR NOT EXISTS(SELECT 1 FROM whaleu_notifications.rating_subscription_fanout_jobs WHERE event_id=eid)) THEN RAISE EXCEPTION 'Subscription fanout capture incomplete' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER rating_subscription_capture_complete AFTER INSERT ON whaleu_ratings.effect_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.subscription_fanout_complete();
CREATE CONSTRAINT TRIGGER rating_subscription_source_complete AFTER INSERT ON whaleu_ratings.subscription_fanout_sources DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.subscription_fanout_complete();
-- This is the single bounded raw scan. Closed and actor epochs still consume a slot.
CREATE FUNCTION whaleu_ratings.subscription_fanout_raw_page(event uuid,after_order bigint,after_id uuid)
 RETURNS TABLE(epoch_id uuid,account_id uuid,start_order bigint,eligible boolean) LANGUAGE sql STABLE AS $$
 SELECT e.id,e.account_id,e.start_order,e.account_id<>s.actor_id AND (c.end_order IS NULL OR c.end_order>s.target_order)
 FROM whaleu_ratings.subscription_fanout_sources s JOIN whaleu_ratings.subscription_epochs e ON e.target_id=s.target_id
 LEFT JOIN whaleu_ratings.subscription_epoch_closures c ON c.epoch_id=e.id
 WHERE s.event_id=event AND s.captured_coverage='complete' AND e.start_order<s.target_order AND (after_order IS NULL OR (e.start_order,e.id)>(after_order,after_id))
 ORDER BY e.start_order,e.id LIMIT 51
$$;
CREATE FUNCTION whaleu_notifications.rating_subscription_job_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p whaleu_notifications.rating_subscription_fanout_pages;s whaleu_ratings.subscription_fanout_sources;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Subscription job is retained' USING ERRCODE='23514';END IF;
 IF TG_OP='INSERT' THEN
 SELECT * INTO s FROM whaleu_ratings.subscription_fanout_sources WHERE event_id=NEW.event_id;
 IF pg_trigger_depth()<2 OR s.source_transaction IS DISTINCT FROM pg_current_xact_id() OR NEW.last_page<>0 OR NEW.cursor_order IS NOT NULL OR NEW.scan_finished THEN RAISE EXCEPTION 'Invalid initial subscription job' USING ERRCODE='23514';END IF;
 ELSE
 SELECT * INTO p FROM whaleu_notifications.rating_subscription_fanout_pages WHERE event_id=NEW.event_id AND page_number=NEW.last_page;
 IF pg_trigger_depth()<2 OR OLD.scan_finished OR NEW.last_page<>OLD.last_page+1 OR (to_jsonb(NEW)-ARRAY['last_page','cursor_order','cursor_epoch_id','scan_finished']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['last_page','cursor_order','cursor_epoch_id','scan_finished']) OR p.creation_transaction IS DISTINCT FROM pg_current_xact_id() OR ROW(NEW.cursor_order,NEW.cursor_epoch_id,NEW.scan_finished) IS DISTINCT FROM ROW(p.through_order,p.through_epoch_id,p.scan_finished) THEN RAISE EXCEPTION 'Subscription cursor must follow exact page' USING ERRCODE='23514';END IF;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER rating_subscription_job_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_notifications.rating_subscription_fanout_jobs FOR EACH ROW EXECUTE FUNCTION whaleu_notifications.rating_subscription_job_guard();
CREATE FUNCTION whaleu_notifications.rating_subscription_page_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE j whaleu_notifications.rating_subscription_fanout_jobs;s whaleu_ratings.subscription_fanout_sources;ids uuid[];orders bigint[];total integer;
BEGIN
 SELECT * INTO j FROM whaleu_notifications.rating_subscription_fanout_jobs WHERE event_id=NEW.event_id FOR UPDATE NOWAIT;
 SELECT * INTO s FROM whaleu_ratings.subscription_fanout_sources WHERE event_id=NEW.event_id;
 PERFORM id FROM whaleu_ratings.targets WHERE id=s.target_id FOR SHARE NOWAIT;
 SELECT array_agg(epoch_id ORDER BY start_order,epoch_id),array_agg(start_order ORDER BY start_order,epoch_id),count(*) INTO ids,orders,total FROM whaleu_ratings.subscription_fanout_raw_page(NEW.event_id,j.cursor_order,j.cursor_epoch_id);
 IF j.event_id IS NULL OR j.scan_finished OR s.captured_coverage<>'complete' OR NEW.creation_transaction<>pg_current_xact_id() OR NEW.page_number<>j.last_page+1 OR ROW(NEW.before_order,NEW.before_epoch_id) IS DISTINCT FROM ROW(j.cursor_order,j.cursor_epoch_id) OR NEW.raw_count<>least(total,50) OR NEW.raw_epoch_ids IS DISTINCT FROM coalesce(ids[1:50],ARRAY[]::uuid[]) OR NEW.scan_finished IS DISTINCT FROM (total<=50) OR ROW(NEW.through_order,NEW.through_epoch_id) IS DISTINCT FROM ROW(CASE WHEN total=0 THEN j.cursor_order ELSE orders[least(total,50)] END,CASE WHEN total=0 THEN j.cursor_epoch_id ELSE ids[least(total,50)] END) THEN RAISE EXCEPTION 'Subscription page is not the exact bounded continuation' USING ERRCODE='23514';END IF;
 NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER rating_subscription_page_guard BEFORE INSERT ON whaleu_notifications.rating_subscription_fanout_pages FOR EACH ROW EXECUTE FUNCTION whaleu_notifications.rating_subscription_page_guard();
CREATE FUNCTION whaleu_notifications.rating_subscription_page_apply() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO whaleu_notifications.rating_subscription_recipient_work(event_id,recipient_account_id,epoch_id,target_id,page_number)
 SELECT NEW.event_id,e.account_id,e.id,s.target_id,NEW.page_number FROM unnest(NEW.raw_epoch_ids) rid JOIN whaleu_ratings.subscription_epochs e ON e.id=rid JOIN whaleu_ratings.subscription_fanout_sources s ON s.event_id=NEW.event_id LEFT JOIN whaleu_ratings.subscription_epoch_closures c ON c.epoch_id=e.id WHERE e.account_id<>s.actor_id AND (c.end_order IS NULL OR c.end_order>s.target_order);
 UPDATE whaleu_notifications.rating_subscription_fanout_jobs SET last_page=NEW.page_number,cursor_order=NEW.through_order,cursor_epoch_id=NEW.through_epoch_id,scan_finished=NEW.scan_finished WHERE event_id=NEW.event_id;
 RETURN NULL;
END $$;
CREATE TRIGGER rating_subscription_page_apply AFTER INSERT ON whaleu_notifications.rating_subscription_fanout_pages FOR EACH ROW EXECUTE FUNCTION whaleu_notifications.rating_subscription_page_apply();
CREATE FUNCTION whaleu_notifications.rating_subscription_work_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s whaleu_ratings.subscription_fanout_sources;e whaleu_ratings.subscription_epochs;p whaleu_notifications.rating_subscription_fanout_pages;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Subscription work is retained' USING ERRCODE='23514';END IF;
 IF TG_OP='INSERT' THEN
 SELECT * INTO s FROM whaleu_ratings.subscription_fanout_sources WHERE event_id=NEW.event_id;
 SELECT * INTO e FROM whaleu_ratings.subscription_epochs WHERE id=NEW.epoch_id;
 SELECT * INTO p FROM whaleu_notifications.rating_subscription_fanout_pages WHERE event_id=NEW.event_id AND page_number=NEW.page_number;
 IF pg_trigger_depth()<2 OR p.creation_transaction IS DISTINCT FROM pg_current_xact_id() OR NEW.status<>'pending' OR NEW.attempts<>0 OR NEW.code IS NOT NULL OR NEW.next_attempt_at IS NOT NULL OR ROW(e.target_id,e.account_id) IS DISTINCT FROM ROW(NEW.target_id,NEW.recipient_account_id) OR e.id=ANY(p.raw_epoch_ids) IS DISTINCT FROM true OR e.start_order>=s.target_order OR e.account_id=s.actor_id OR EXISTS(SELECT 1 FROM whaleu_ratings.subscription_epoch_closures WHERE epoch_id=e.id AND end_order<=s.target_order) THEN RAISE EXCEPTION 'Subscription candidate is not in exact page' USING ERRCODE='23514';END IF;
 ELSE
 IF (to_jsonb(NEW)-ARRAY['status','attempts','code','next_attempt_at','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','attempts','code','next_attempt_at','updated_at']) OR OLD.status IN ('materialized','suppressed') OR NEW.status='pending' OR NEW.attempts<>least(OLD.attempts::bigint+1,2147483647) THEN RAISE EXCEPTION 'Invalid subscription work transition' USING ERRCODE='23514';END IF;
 IF NEW.status='retry' THEN NEW.next_attempt_at:=clock_timestamp()+make_interval(secs=>least(60,5*power(2,least(4,OLD.attempts)))::integer);END IF;
 END IF;NEW.updated_at:=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER rating_subscription_work_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_notifications.rating_subscription_recipient_work FOR EACH ROW EXECUTE FUNCTION whaleu_notifications.rating_subscription_work_guard();
CREATE FUNCTION whaleu_notifications.rating_subscription_page_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p whaleu_notifications.rating_subscription_fanout_pages;expected integer;actual integer;
BEGIN
 IF TG_TABLE_NAME='rating_subscription_fanout_pages' THEN p:=NEW;ELSE SELECT * INTO p FROM whaleu_notifications.rating_subscription_fanout_pages WHERE event_id=NEW.event_id AND page_number=NEW.page_number;END IF;
 SELECT count(*) INTO expected FROM unnest(p.raw_epoch_ids) rid JOIN whaleu_ratings.subscription_epochs e ON e.id=rid JOIN whaleu_ratings.subscription_fanout_sources s ON s.event_id=p.event_id LEFT JOIN whaleu_ratings.subscription_epoch_closures c ON c.epoch_id=e.id WHERE e.account_id<>s.actor_id AND (c.end_order IS NULL OR c.end_order>s.target_order);
 SELECT count(*) INTO actual FROM whaleu_notifications.rating_subscription_recipient_work WHERE event_id=p.event_id AND page_number=p.page_number;
 IF expected<>actual OR NOT EXISTS(SELECT 1 FROM whaleu_notifications.rating_subscription_fanout_jobs WHERE event_id=p.event_id AND last_page>=p.page_number) THEN RAISE EXCEPTION 'Subscription page work incomplete' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER rating_subscription_page_complete AFTER INSERT ON whaleu_notifications.rating_subscription_fanout_pages DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_notifications.rating_subscription_page_complete();
CREATE CONSTRAINT TRIGGER rating_subscription_work_page_complete AFTER INSERT ON whaleu_notifications.rating_subscription_recipient_work DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_notifications.rating_subscription_page_complete();
CREATE FUNCTION whaleu_notifications.rating_subscription_notice_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s whaleu_ratings.subscription_fanout_sources;e whaleu_ratings.effect_events;w whaleu_notifications.rating_subscription_recipient_work;active uuid;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Subscription notice is retained' USING ERRCODE='23514';END IF;
 IF TG_OP='UPDATE' THEN
 PERFORM account_id FROM whaleu_notifications.owners WHERE account_id=NEW.recipient_account_id FOR UPDATE NOWAIT;
 IF (to_jsonb(NEW)-'read_at') IS DISTINCT FROM (to_jsonb(OLD)-'read_at') OR NEW.read_at IS NULL OR (OLD.read_at IS NOT NULL AND NEW.read_at IS DISTINCT FROM OLD.read_at) THEN RAISE EXCEPTION 'Subscription notice permits only monotonic read state' USING ERRCODE='23514';END IF;
 IF OLD.read_at IS NULL THEN NEW.read_at:=clock_timestamp();END IF;RETURN NEW;
 END IF;
 SELECT * INTO s FROM whaleu_ratings.subscription_fanout_sources WHERE event_id=NEW.event_id;
 SELECT * INTO e FROM whaleu_ratings.effect_events WHERE id=NEW.event_id;
 PERFORM id FROM whaleu_ratings.targets WHERE id=s.target_id FOR SHARE NOWAIT;
 SELECT active_epoch_id INTO active FROM whaleu_ratings.subscription_memberships WHERE target_id=s.target_id AND account_id=NEW.recipient_account_id FOR SHARE NOWAIT;
 SELECT * INTO w FROM whaleu_notifications.rating_subscription_recipient_work WHERE event_id=NEW.event_id AND recipient_account_id=NEW.recipient_account_id;
 PERFORM account_id FROM whaleu_notifications.owners WHERE account_id=NEW.recipient_account_id FOR UPDATE NOWAIT;
 IF NOT FOUND OR w.status NOT IN ('pending','retry') OR active IS DISTINCT FROM NEW.epoch_id OR w.epoch_id IS DISTINCT FROM NEW.epoch_id OR NEW.read_at IS NOT NULL OR ROW(NEW.activity,NEW.region_id,NEW.target_id,NEW.root_id,NEW.reply_id,NEW.occurred_at,NEW.event_sequence) IS DISTINCT FROM ROW(CASE WHEN s.reply_id IS NULL THEN 'root' ELSE 'reply' END,e.region_id,s.target_id,s.root_id,s.reply_id,e.occurred_at,e.event_sequence) THEN RAISE EXCEPTION 'Subscription notice source or current epoch mismatch' USING ERRCODE='23514';END IF;
 NEW.ordinal:=nextval('whaleu_notifications.rating_subscription_notices_ordinal_seq');NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER rating_subscription_notice_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_notifications.rating_subscription_notices FOR EACH ROW EXECUTE FUNCTION whaleu_notifications.rating_subscription_notice_guard();
CREATE FUNCTION whaleu_notifications.rating_subscription_receipt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE w whaleu_notifications.rating_subscription_recipient_work;active uuid;
BEGIN
 SELECT * INTO w FROM whaleu_notifications.rating_subscription_recipient_work WHERE event_id=NEW.event_id AND recipient_account_id=NEW.recipient_account_id;
 PERFORM id FROM whaleu_ratings.targets WHERE id=w.target_id FOR SHARE NOWAIT;
 SELECT active_epoch_id INTO active FROM whaleu_ratings.subscription_memberships WHERE target_id=w.target_id AND account_id=w.recipient_account_id FOR SHARE NOWAIT;
 IF w.epoch_id IS DISTINCT FROM NEW.epoch_id OR w.status NOT IN ('pending','retry') OR (NEW.outcome='materialized' AND active IS DISTINCT FROM NEW.epoch_id) OR (NEW.code='epoch_ended' AND active IS NOT DISTINCT FROM NEW.epoch_id) THEN RAISE EXCEPTION 'Subscription receipt source mismatch' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER rating_subscription_receipt_guard BEFORE INSERT ON whaleu_notifications.rating_subscription_processing_receipts FOR EACH ROW EXECUTE FUNCTION whaleu_notifications.rating_subscription_receipt_guard();
CREATE FUNCTION whaleu_notifications.rating_subscription_recipient_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE w whaleu_notifications.rating_subscription_recipient_work;r whaleu_notifications.rating_subscription_processing_receipts;notice uuid;
BEGIN
 SELECT * INTO w FROM whaleu_notifications.rating_subscription_recipient_work WHERE event_id=NEW.event_id AND recipient_account_id=NEW.recipient_account_id;
 SELECT * INTO r FROM whaleu_notifications.rating_subscription_processing_receipts WHERE event_id=NEW.event_id AND recipient_account_id=NEW.recipient_account_id;
 SELECT id INTO notice FROM whaleu_notifications.rating_subscription_notices WHERE event_id=NEW.event_id AND recipient_account_id=NEW.recipient_account_id;
 IF (w.status IN ('materialized','suppressed')) IS DISTINCT FROM (r.event_id IS NOT NULL) OR (r.event_id IS NOT NULL AND ROW(w.status,w.code,w.epoch_id) IS DISTINCT FROM ROW(r.outcome,r.code,r.epoch_id)) OR (w.status='materialized') IS DISTINCT FROM (notice IS NOT NULL) OR r.notice_id IS DISTINCT FROM notice THEN RAISE EXCEPTION 'Subscription recipient settlement incomplete' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER rating_subscription_work_complete AFTER INSERT OR UPDATE ON whaleu_notifications.rating_subscription_recipient_work DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_notifications.rating_subscription_recipient_complete();
CREATE CONSTRAINT TRIGGER rating_subscription_notice_complete AFTER INSERT ON whaleu_notifications.rating_subscription_notices DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_notifications.rating_subscription_recipient_complete();
CREATE CONSTRAINT TRIGGER rating_subscription_receipt_complete AFTER INSERT ON whaleu_notifications.rating_subscription_processing_receipts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_notifications.rating_subscription_recipient_complete();
CREATE FUNCTION whaleu_notifications.rating_subscription_event_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE j whaleu_notifications.rating_subscription_fanout_jobs;
BEGIN
 SELECT * INTO j FROM whaleu_notifications.rating_subscription_fanout_jobs WHERE event_id=NEW.event_id FOR SHARE NOWAIT;
 IF NOT EXISTS(SELECT 1 FROM whaleu_ratings.subscription_fanout_sources WHERE event_id=NEW.event_id AND captured_coverage='complete') OR j.scan_finished IS DISTINCT FROM true OR j.last_page=0 OR NOT EXISTS(SELECT 1 FROM whaleu_notifications.rating_subscription_fanout_pages WHERE event_id=NEW.event_id AND page_number=j.last_page AND scan_finished) OR EXISTS(SELECT 1 FROM whaleu_notifications.rating_subscription_recipient_work WHERE event_id=NEW.event_id AND status IN ('pending','retry')) THEN RAISE EXCEPTION 'Subscription event is not fully settled' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER rating_subscription_event_complete BEFORE INSERT ON whaleu_notifications.rating_subscription_event_receipts FOR EACH ROW EXECUTE FUNCTION whaleu_notifications.rating_subscription_event_complete();
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['subscription_fanout_activations','subscription_fanout_sources'] LOOP
 EXECUTE format('CREATE TRIGGER subscription_fanout_immutable BEFORE UPDATE OR DELETE ON whaleu_ratings.%I FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.immutable()',t);
 EXECUTE format('CREATE TRIGGER subscription_fanout_retain BEFORE TRUNCATE ON whaleu_ratings.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.immutable()',t);END LOOP;
 FOREACH t IN ARRAY ARRAY['rating_subscription_fanout_pages','rating_subscription_processing_receipts','rating_subscription_event_receipts'] LOOP EXECUTE format('CREATE TRIGGER subscription_fanout_immutable BEFORE UPDATE OR DELETE ON whaleu_notifications.%I FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.immutable()',t);END LOOP;
 FOREACH t IN ARRAY ARRAY['rating_subscription_fanout_jobs','rating_subscription_fanout_pages','rating_subscription_recipient_work','rating_subscription_notices','rating_subscription_processing_receipts','rating_subscription_event_receipts'] LOOP EXECUTE format('CREATE TRIGGER subscription_fanout_retain BEFORE TRUNCATE ON whaleu_notifications.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.immutable()',t);END LOOP;
END $$;
