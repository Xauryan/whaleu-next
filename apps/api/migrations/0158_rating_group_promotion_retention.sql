CREATE TABLE whaleu_notifications.rating_group_retired_gates (
 stable_destination_id uuid PRIMARY KEY REFERENCES whaleu_ratings.promotion_receiver_lineages(id),original_key text NOT NULL,
 original_attempt_id uuid NOT NULL,fence bigint NOT NULL,retired_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE whaleu_ratings.promotion_retention_commands(campaign_id uuid PRIMARY KEY,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE OR REPLACE FUNCTION whaleu_ratings.promotion_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' AND pg_trigger_depth()>1 THEN RETURN OLD;END IF;
 RAISE EXCEPTION 'Immutable promotion evidence' USING ERRCODE='23514',CONSTRAINT='promotion_immutable'; END $$;
CREATE FUNCTION whaleu_ratings.promotion_retire_campaign() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c whaleu_ratings.promotion_campaigns;effects uuid[];
BEGIN
 SELECT * INTO c FROM whaleu_ratings.promotion_campaigns WHERE id=NEW.campaign_id FOR UPDATE;
 IF c.id IS NULL OR c.expires_at>=clock_timestamp()-interval '180 days' THEN RAISE EXCEPTION 'Retention not due' USING ERRCODE='23514',CONSTRAINT='promotion_retention_due';END IF;
 SELECT array_agg(id) INTO effects FROM (SELECT id FROM whaleu_notifications.rating_group_effects WHERE campaign_id=c.id ORDER BY id LIMIT 4 FOR UPDATE) limited;
 INSERT INTO whaleu_notifications.rating_group_retired_gates(stable_destination_id,original_key,original_attempt_id,fence)
 SELECT g.stable_destination_id,e.original_key,g.original_attempt_id,g.fence FROM whaleu_notifications.rating_group_receiver_gates g JOIN whaleu_notifications.rating_group_effects e ON e.id=g.effect_id WHERE e.id=ANY(effects) ON CONFLICT DO NOTHING;
 UPDATE whaleu_ratings.promotion_receiver_lineages SET retired=true WHERE id IN(SELECT g.stable_destination_id FROM whaleu_notifications.rating_group_receiver_gates g WHERE g.effect_id=ANY(effects));
 DELETE FROM whaleu_notifications.rating_group_emission_slots WHERE effect_id =ANY(effects);
 DELETE FROM whaleu_notifications.rating_group_receiver_gates WHERE effect_id =ANY(effects);
 DELETE FROM whaleu_ratings.promotion_cost_reservations WHERE effect_id =ANY(effects);
 DELETE FROM whaleu_notifications.rating_group_evidence_inbox WHERE original_attempt_id IN(SELECT a.id FROM whaleu_notifications.rating_group_attempts a JOIN whaleu_notifications.rating_group_effects e ON e.id=a.effect_id WHERE e.id=ANY(effects));
 DELETE FROM whaleu_notifications.rating_group_evidence WHERE effect_id =ANY(effects);
 DELETE FROM whaleu_notifications.rating_group_permits WHERE effect_id =ANY(effects);
 DELETE FROM whaleu_notifications.rating_group_attempts WHERE effect_id =ANY(effects);
 DELETE FROM whaleu_notifications.rating_group_effects WHERE id=ANY(effects);
 IF EXISTS(SELECT 1 FROM whaleu_notifications.rating_group_effects WHERE campaign_id=c.id) THEN DELETE FROM whaleu_ratings.promotion_retention_commands WHERE campaign_id=c.id;RETURN NULL;END IF;
 DELETE FROM whaleu_notifications.rating_group_counters WHERE (campaign_id,stable_destination_id) IN(SELECT campaign_id,stable_destination_id FROM whaleu_notifications.rating_group_counters WHERE campaign_id=c.id ORDER BY stable_destination_id LIMIT 64);
 IF EXISTS(SELECT 1 FROM whaleu_notifications.rating_group_counters WHERE campaign_id=c.id) THEN DELETE FROM whaleu_ratings.promotion_retention_commands WHERE campaign_id=c.id;RETURN NULL;END IF;
 DELETE FROM whaleu_ratings.promotion_campaign_recipients WHERE (campaign_id,stable_destination_id) IN(SELECT campaign_id,stable_destination_id FROM whaleu_ratings.promotion_campaign_recipients WHERE campaign_id=c.id ORDER BY stable_destination_id LIMIT 64);
 IF EXISTS(SELECT 1 FROM whaleu_ratings.promotion_campaign_recipients WHERE campaign_id=c.id) THEN DELETE FROM whaleu_ratings.promotion_retention_commands WHERE campaign_id=c.id;RETURN NULL;END IF;
 DELETE FROM whaleu_ratings.promotion_admissions WHERE campaign_id=c.id;
 DELETE FROM whaleu_ratings.promotion_cancel_requests WHERE request_id=c.request_id;
 DELETE FROM whaleu_ratings.promotion_campaigns WHERE id=c.id;
 DELETE FROM whaleu_ratings.promotion_intents WHERE request_id=c.request_id;
 DELETE FROM whaleu_ratings.promotion_previews WHERE id=(c.command->>'previewId')::uuid AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.promotion_intents WHERE preview_id=(c.command->>'previewId')::uuid);
 DELETE FROM whaleu_ratings.promotion_retention_commands WHERE campaign_id=c.id;
 RETURN NULL;
END $$;
CREATE TRIGGER promotion_retire_campaign AFTER INSERT ON whaleu_ratings.promotion_retention_commands FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.promotion_retire_campaign();

-- Never discover work by scanning full history. At most 16 old unrecorded intents
-- and 16 unreferenced previews per maintenance call, in addition to one campaign.
CREATE INDEX promotion_intent_retention ON whaleu_ratings.promotion_intents(issued_at,request_id);
CREATE INDEX promotion_preview_retention ON whaleu_ratings.promotion_previews(expires_at,id);
CREATE TABLE whaleu_ratings.promotion_orphan_retention_commands(id uuid PRIMARY KEY DEFAULT gen_random_uuid());
CREATE INDEX promotion_enrollment_retention ON whaleu_ratings.promotion_enrollment_history(recorded_at,revision);
CREATE TABLE whaleu_ratings.promotion_retention_cursor(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),recorded_at timestamptz,revision uuid,CHECK((recorded_at IS NULL)=(revision IS NULL)));
CREATE FUNCTION whaleu_ratings.promotion_retire_orphans() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE keys uuid[]; histories uuid[]; last_at timestamptz; last_revision uuid;
BEGIN
 SELECT array_agg(request_id) INTO keys FROM (SELECT i.request_id FROM whaleu_ratings.promotion_intents i WHERE i.issued_at<clock_timestamp()-interval '180 days' ORDER BY i.issued_at,i.request_id LIMIT 16 FOR UPDATE SKIP LOCKED) batch WHERE NOT EXISTS(SELECT 1 FROM whaleu_ratings.promotion_campaigns c WHERE c.request_id=batch.request_id);
 DELETE FROM whaleu_ratings.promotion_cancel_requests WHERE request_id=ANY(keys);
 DELETE FROM whaleu_ratings.promotion_intents WHERE request_id=ANY(keys);
 DELETE FROM whaleu_ratings.promotion_previews WHERE id IN(SELECT batch.id FROM (SELECT p.id FROM whaleu_ratings.promotion_previews p WHERE p.expires_at<clock_timestamp()-interval '180 days' ORDER BY p.expires_at,p.id LIMIT 16 FOR UPDATE SKIP LOCKED) batch WHERE NOT EXISTS(SELECT 1 FROM whaleu_ratings.promotion_intents i WHERE i.preview_id=batch.id));
 INSERT INTO whaleu_ratings.promotion_retention_cursor(singleton) VALUES(true) ON CONFLICT DO NOTHING;
 SELECT recorded_at,revision INTO last_at,last_revision FROM whaleu_ratings.promotion_retention_cursor WHERE singleton FOR UPDATE;
 SELECT array_agg(revision ORDER BY recorded_at,revision) INTO histories FROM (SELECT h.revision,h.recorded_at FROM whaleu_ratings.promotion_enrollment_history h WHERE h.recorded_at<clock_timestamp()-interval '180 days' AND (last_at IS NULL OR (h.recorded_at,h.revision)>(last_at,last_revision)) ORDER BY h.recorded_at,h.revision LIMIT 16 FOR UPDATE SKIP LOCKED) batch;
 IF histories IS NULL THEN UPDATE whaleu_ratings.promotion_retention_cursor SET recorded_at=NULL,revision=NULL WHERE singleton;
 ELSE
 SELECT recorded_at,revision INTO last_at,last_revision FROM whaleu_ratings.promotion_enrollment_history WHERE revision=histories[cardinality(histories)];
 UPDATE whaleu_ratings.promotion_retention_cursor SET recorded_at=last_at,revision=last_revision WHERE singleton;
 DELETE FROM whaleu_ratings.promotion_enrollment_history h WHERE h.revision=ANY(histories) AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.promotion_program_members_current m WHERE m.program_id=h.program_id AND m.stable_destination_id=h.stable_destination_id) AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.promotion_campaign_recipients r WHERE r.enrollment_revision=h.revision) AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.promotion_enrollment_history recent WHERE recent.program_id=h.program_id AND recent.stable_destination_id=h.stable_destination_id AND recent.recorded_at>=clock_timestamp()-interval '180 days');
 END IF;
 DELETE FROM whaleu_ratings.promotion_orphan_retention_commands WHERE id=NEW.id;RETURN NULL;
END $$;
CREATE TRIGGER promotion_retire_orphans AFTER INSERT ON whaleu_ratings.promotion_orphan_retention_commands FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.promotion_retire_orphans();
CREATE INDEX promotion_intent_preview ON whaleu_ratings.promotion_intents(preview_id);

CREATE INDEX promotion_current_enrollment ON whaleu_ratings.promotion_program_members_current(enrollment_revision);
CREATE INDEX promotion_snapshot_enrollment ON whaleu_ratings.promotion_campaign_recipients(enrollment_revision);
CREATE INDEX promotion_enrollment_latest ON whaleu_ratings.promotion_enrollment_history(program_id,stable_destination_id,recorded_at DESC);

CREATE TABLE whaleu_ratings.promotion_retention_effect_cursor(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),last_id uuid);
CREATE INDEX rating_group_retention_pending ON whaleu_notifications.rating_group_effects(id) WHERE state IN('pending','retry_wait');
CREATE INDEX rating_group_retention_unknown ON whaleu_notifications.rating_group_effects(created_at,id) WHERE state='dispatch_unknown';
CREATE INDEX promotion_payload_purge_pending ON whaleu_ratings.promotion_campaigns(expires_at,id) WHERE payload_purged_at IS NULL;
