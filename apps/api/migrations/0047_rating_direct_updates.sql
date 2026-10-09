-- Independent rating notices: no post aliases, external delivery or dispatcher.
CREATE TABLE whaleu_notifications.rating_event_receipts (
 event_id uuid PRIMARY KEY REFERENCES whaleu_ratings.effect_events(id),outcome text NOT NULL CHECK(outcome IN ('processed','ignored')),code text,created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(created_at)),CHECK((outcome='processed' AND code IS NULL) OR (outcome='ignored' AND code='no_direct_updates'))
);
CREATE TABLE whaleu_notifications.rating_processing_receipts (
 event_id uuid NOT NULL,recipient_account_id uuid NOT NULL,reason text NOT NULL,outcome text NOT NULL CHECK(outcome IN ('materialized','suppressed')),code text,created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(created_at)),
 PRIMARY KEY(event_id,recipient_account_id),FOREIGN KEY(event_id,recipient_account_id,reason) REFERENCES whaleu_ratings.notice_obligations(event_id,recipient_account_id,reason),CHECK((outcome='materialized' AND code IS NULL) OR (outcome='suppressed' AND code IS NOT NULL AND length(code)>0))
);
CREATE TABLE whaleu_notifications.rating_notices (
 id uuid PRIMARY KEY,event_id uuid NOT NULL,recipient_account_id uuid NOT NULL REFERENCES whaleu_notifications.owners(account_id),kind text NOT NULL DEFAULT 'reply' CHECK(kind='reply'),reason text NOT NULL,
 region_id uuid REFERENCES whaleu_campus.operating_regions(id),target_id uuid NOT NULL,root_id uuid NOT NULL,reply_id uuid NOT NULL,
 occurred_at timestamptz NOT NULL CHECK(isfinite(occurred_at)),event_sequence bigint NOT NULL,ordinal bigint GENERATED ALWAYS AS IDENTITY UNIQUE,created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(created_at)),read_at timestamptz CHECK(read_at IS NULL OR (isfinite(read_at) AND read_at>=created_at)),
 UNIQUE(event_id,recipient_account_id),FOREIGN KEY(event_id,recipient_account_id,reason) REFERENCES whaleu_ratings.notice_obligations(event_id,recipient_account_id,reason),FOREIGN KEY(reply_id,root_id,target_id) REFERENCES whaleu_ratings.replies(id,root_id,target_id)
);
CREATE INDEX rating_notices_owner ON whaleu_notifications.rating_notices(recipient_account_id,ordinal DESC);
CREATE INDEX rating_notices_unread ON whaleu_notifications.rating_notices(recipient_account_id) WHERE read_at IS NULL;
CREATE TABLE whaleu_notifications.rating_retry_attempts (
 event_id uuid PRIMARY KEY REFERENCES whaleu_ratings.effect_events(id),attempts integer NOT NULL CHECK(attempts>0),code text NOT NULL CHECK(length(code)>0),last_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(last_attempt_at)),next_attempt_at timestamptz NOT NULL CHECK(isfinite(next_attempt_at))
);
CREATE FUNCTION whaleu_notifications.rating_notice_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o whaleu_ratings.notice_obligations;e whaleu_ratings.effect_events;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Rating notice is retained' USING ERRCODE='23514';END IF;
 PERFORM account_id FROM whaleu_notifications.owners WHERE account_id=NEW.recipient_account_id FOR UPDATE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'Rating notice owner is absent' USING ERRCODE='23514';END IF;
 IF TG_OP='UPDATE' THEN
 IF (to_jsonb(NEW)-'read_at') IS DISTINCT FROM (to_jsonb(OLD)-'read_at') OR NEW.read_at IS NULL OR (OLD.read_at IS NOT NULL AND NEW.read_at IS DISTINCT FROM OLD.read_at) THEN RAISE EXCEPTION 'Rating notice permits only monotonic read state' USING ERRCODE='23514';END IF;
 IF OLD.read_at IS NULL THEN NEW.read_at:=clock_timestamp();END IF;RETURN NEW;
 END IF;
 SELECT * INTO o FROM whaleu_ratings.notice_obligations WHERE event_id=NEW.event_id AND recipient_account_id=NEW.recipient_account_id;
 SELECT * INTO e FROM whaleu_ratings.effect_events WHERE id=NEW.event_id;
 IF o.event_id IS NULL OR ROW(NEW.reason,NEW.region_id,NEW.target_id,NEW.root_id,NEW.reply_id,NEW.occurred_at,NEW.event_sequence) IS DISTINCT FROM ROW(o.reason,o.region_id,o.target_id,o.root_id,o.reply_id,e.occurred_at,e.event_sequence) OR NEW.read_at IS NOT NULL THEN RAISE EXCEPTION 'Rating notice source mismatch' USING ERRCODE='23514';END IF;
 NEW.ordinal:=nextval('whaleu_notifications.rating_notices_ordinal_seq');NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER rating_notice_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_notifications.rating_notices FOR EACH ROW EXECUTE FUNCTION whaleu_notifications.rating_notice_guard();
CREATE FUNCTION whaleu_notifications.rating_updates_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE event uuid:=NEW.event_id;e whaleu_ratings.effect_events;r whaleu_notifications.rating_event_receipts;
BEGIN
 SELECT * INTO e FROM whaleu_ratings.effect_events WHERE id=event;SELECT * INTO r FROM whaleu_notifications.rating_event_receipts WHERE event_id=event;
 IF r.event_id IS NULL OR (r.outcome='ignored' AND e.expected_direct_notice_obligations<>0) OR (r.outcome='processed' AND e.event_kind<>'reply_created') OR
 (SELECT count(*) FROM whaleu_notifications.rating_processing_receipts WHERE event_id=event)<>e.expected_direct_notice_obligations OR
 EXISTS(SELECT 1 FROM whaleu_ratings.notice_obligations o WHERE o.event_id=event AND NOT EXISTS(SELECT 1 FROM whaleu_notifications.rating_processing_receipts p WHERE (p.event_id,p.recipient_account_id,p.reason)=(o.event_id,o.recipient_account_id,o.reason))) OR
 EXISTS(SELECT 1 FROM whaleu_notifications.rating_processing_receipts p WHERE p.event_id=event AND (p.outcome='materialized') IS DISTINCT FROM EXISTS(SELECT 1 FROM whaleu_notifications.rating_notices n WHERE (n.event_id,n.recipient_account_id,n.reason)=(p.event_id,p.recipient_account_id,p.reason))) THEN RAISE EXCEPTION 'Rating direct updates processing incomplete' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER rating_event_complete AFTER INSERT ON whaleu_notifications.rating_event_receipts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_notifications.rating_updates_complete();
CREATE CONSTRAINT TRIGGER rating_recipient_complete AFTER INSERT ON whaleu_notifications.rating_processing_receipts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_notifications.rating_updates_complete();
CREATE CONSTRAINT TRIGGER rating_notice_complete AFTER INSERT ON whaleu_notifications.rating_notices DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_notifications.rating_updates_complete();
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['rating_event_receipts','rating_processing_receipts'] LOOP EXECUTE format('CREATE TRIGGER rating_updates_immutable BEFORE UPDATE OR DELETE ON whaleu_notifications.%I FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.immutable()',t);END LOOP;
 FOREACH t IN ARRAY ARRAY['rating_event_receipts','rating_processing_receipts','rating_notices','rating_retry_attempts'] LOOP EXECUTE format('CREATE TRIGGER rating_updates_retain BEFORE TRUNCATE ON whaleu_notifications.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.immutable()',t);END LOOP;END $$;
ALTER TABLE whaleu_notifications.rating_notices ADD CHECK(ordinal>0 AND event_sequence>0);
