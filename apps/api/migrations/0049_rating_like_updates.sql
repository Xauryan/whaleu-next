-- Additive typed rating likes on the existing local notification owner.
ALTER TABLE whaleu_notifications.rating_notices DROP CONSTRAINT rating_notices_kind_check;
ALTER TABLE whaleu_notifications.rating_notices ALTER COLUMN reply_id DROP NOT NULL;
ALTER TABLE whaleu_notifications.rating_notices ADD COLUMN like_actor_account_id uuid REFERENCES whaleu_identity.accounts(id);
ALTER TABLE whaleu_notifications.rating_notices ADD CONSTRAINT rating_notice_kind_shape CHECK(
 (kind='reply' AND reason IN ('direct_root','direct_reply') AND reply_id IS NOT NULL AND like_actor_account_id IS NULL) OR
 (kind='like' AND reason='like' AND like_actor_account_id IS NOT NULL AND like_actor_account_id<>recipient_account_id)
);
ALTER TABLE whaleu_notifications.rating_notices ADD FOREIGN KEY(root_id,target_id) REFERENCES whaleu_ratings.comments(id,target_id);
CREATE UNIQUE INDEX rating_like_notice_root_once ON whaleu_notifications.rating_notices(recipient_account_id,like_actor_account_id,root_id) WHERE kind='like' AND reply_id IS NULL;
CREATE UNIQUE INDEX rating_like_notice_reply_once ON whaleu_notifications.rating_notices(recipient_account_id,like_actor_account_id,reply_id) WHERE kind='like' AND reply_id IS NOT NULL;
CREATE INDEX rating_notices_kind_owner ON whaleu_notifications.rating_notices(recipient_account_id,kind,ordinal DESC);
CREATE INDEX rating_notices_kind_unread ON whaleu_notifications.rating_notices(recipient_account_id,kind) WHERE read_at IS NULL;
ALTER TABLE whaleu_notifications.rating_processing_receipts DROP CONSTRAINT rating_processing_receipts_outcome_check;
ALTER TABLE whaleu_notifications.rating_processing_receipts DROP CONSTRAINT rating_processing_receipts_check;
ALTER TABLE whaleu_notifications.rating_processing_receipts ADD COLUMN notice_id uuid REFERENCES whaleu_notifications.rating_notices(id);
-- Bind already verified historical materializations without replaying their source.
DROP TRIGGER rating_updates_immutable ON whaleu_notifications.rating_processing_receipts;
UPDATE whaleu_notifications.rating_processing_receipts p SET notice_id=n.id FROM whaleu_notifications.rating_notices n WHERE p.outcome='materialized' AND (n.event_id,n.recipient_account_id,n.reason)=(p.event_id,p.recipient_account_id,p.reason);
CREATE TRIGGER rating_updates_immutable BEFORE UPDATE OR DELETE ON whaleu_notifications.rating_processing_receipts FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.immutable();
ALTER TABLE whaleu_notifications.rating_processing_receipts ADD CONSTRAINT rating_processing_outcome_shape CHECK(
 (outcome='materialized' AND code IS NULL AND notice_id IS NOT NULL) OR
 (outcome='existing' AND reason='like' AND code IS NULL AND notice_id IS NOT NULL) OR
 (outcome='suppressed' AND code IS NOT NULL AND length(code)>0 AND notice_id IS NULL)
);
CREATE OR REPLACE FUNCTION whaleu_notifications.rating_notice_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
 IF (NEW.kind='reply' AND (e.source_version<>1 OR e.rule_version<>'rating-effects-v1' OR e.event_kind<>'reply_created' OR NEW.like_actor_account_id IS NOT NULL)) OR
 (NEW.kind='like' AND (e.source_version<>2 OR e.rule_version<>'rating-likes-v1' OR e.event_kind<>'content_liked' OR NEW.like_actor_account_id IS DISTINCT FROM e.actor_account_id OR NEW.recipient_account_id IS DISTINCT FROM e.subject_author_id)) THEN RAISE EXCEPTION 'Rating notice kind source mismatch' USING ERRCODE='23514';END IF;
 NEW.ordinal:=nextval('whaleu_notifications.rating_notices_ordinal_seq');NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;
CREATE FUNCTION whaleu_notifications.rating_processing_owner_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM account_id FROM whaleu_notifications.owners WHERE account_id=NEW.recipient_account_id FOR UPDATE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'Rating processing owner is absent' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER rating_processing_owner_guard BEFORE INSERT ON whaleu_notifications.rating_processing_receipts FOR EACH ROW EXECUTE FUNCTION whaleu_notifications.rating_processing_owner_guard();
CREATE OR REPLACE FUNCTION whaleu_notifications.rating_updates_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE event uuid:=NEW.event_id;e whaleu_ratings.effect_events;r whaleu_notifications.rating_event_receipts;
BEGIN
 SELECT * INTO e FROM whaleu_ratings.effect_events WHERE id=event;SELECT * INTO r FROM whaleu_notifications.rating_event_receipts WHERE event_id=event;
 IF r.event_id IS NULL OR (r.outcome='ignored' AND e.expected_direct_notice_obligations<>0) OR
 (r.outcome='processed' AND NOT ((e.source_version=1 AND e.event_kind='reply_created') OR (e.source_version=2 AND e.event_kind='content_liked'))) OR
 (SELECT count(*) FROM whaleu_notifications.rating_processing_receipts WHERE event_id=event)<>e.expected_direct_notice_obligations OR
 EXISTS(SELECT 1 FROM whaleu_ratings.notice_obligations o WHERE o.event_id=event AND NOT EXISTS(SELECT 1 FROM whaleu_notifications.rating_processing_receipts p WHERE (p.event_id,p.recipient_account_id,p.reason)=(o.event_id,o.recipient_account_id,o.reason))) OR
 EXISTS(SELECT 1 FROM whaleu_notifications.rating_processing_receipts p JOIN whaleu_ratings.notice_obligations o ON (o.event_id,o.recipient_account_id,o.reason)=(p.event_id,p.recipient_account_id,p.reason) LEFT JOIN whaleu_notifications.rating_notices n ON n.id=p.notice_id WHERE p.event_id=event AND (
   (p.outcome='suppressed' AND EXISTS(SELECT 1 FROM whaleu_notifications.rating_notices same WHERE (same.event_id,same.recipient_account_id)=(p.event_id,p.recipient_account_id))) OR
   (p.outcome='materialized' AND (n.id IS NULL OR ROW(n.event_id,n.recipient_account_id,n.reason,n.region_id,n.target_id,n.root_id,n.reply_id,n.occurred_at,n.event_sequence) IS DISTINCT FROM ROW(p.event_id,p.recipient_account_id,p.reason,o.region_id,o.target_id,o.root_id,o.reply_id,e.occurred_at,e.event_sequence))) OR
   (p.outcome='existing' AND (n.id IS NULL OR n.event_id=p.event_id OR e.source_version<>2 OR e.event_kind<>'content_liked' OR ROW(n.kind,n.reason,n.recipient_account_id,n.like_actor_account_id,n.region_id,n.target_id,n.root_id,n.reply_id) IS DISTINCT FROM ROW('like'::text,'like'::text,p.recipient_account_id,e.actor_account_id,o.region_id,o.target_id,o.root_id,o.reply_id)))
 )) OR EXISTS(SELECT 1 FROM whaleu_notifications.rating_notices n WHERE n.event_id=event AND NOT EXISTS(SELECT 1 FROM whaleu_notifications.rating_processing_receipts p WHERE p.event_id=event AND p.recipient_account_id=n.recipient_account_id AND p.outcome='materialized' AND p.notice_id=n.id)) THEN RAISE EXCEPTION 'Rating direct updates processing incomplete' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
