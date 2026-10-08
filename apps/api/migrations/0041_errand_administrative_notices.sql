-- Durable local owner delivery. No provider calls or fabricated notices.
ALTER TABLE whaleu_notifications.errand_notices DROP CONSTRAINT errand_notices_kind_check;
ALTER TABLE whaleu_notifications.errand_notices ADD CHECK(kind IN ('accepted','completed','admin_deleted'));
ALTER TABLE whaleu_notifications.errand_notices ADD deletion_reason text;
ALTER TABLE whaleu_notifications.errand_notices ADD CHECK((kind='admin_deleted')=(deletion_reason IS NOT NULL));
ALTER TABLE whaleu_notifications.errand_notices ADD CHECK(deletion_reason IS NULL OR length(deletion_reason)<=500);
CREATE TABLE whaleu_notifications.errand_feature_notices (
 id uuid PRIMARY KEY,event_id uuid NOT NULL REFERENCES whaleu_safety.errand_restriction_events(id),
 restriction_id uuid NOT NULL REFERENCES whaleu_safety.errand_restriction_definitions(id),
 recipient_account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
 kind text NOT NULL CHECK(kind IN ('feature_restricted','feature_released')),
 action text NOT NULL CHECK(action IN ('publish','accept','all')),
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 255),
 starts_at timestamptz NOT NULL CHECK(isfinite(starts_at)),
 ends_at timestamptz CHECK(ends_at IS NULL OR (isfinite(ends_at) AND ends_at>starts_at)),
 released_at timestamptz,
 created_at timestamptz NOT NULL CHECK(isfinite(created_at)),read_at timestamptz,
 UNIQUE(event_id,recipient_account_id,kind),
 CHECK((kind='feature_released')=(released_at IS NOT NULL)),
 CHECK(released_at IS NULL OR (isfinite(released_at) AND released_at>=starts_at)),
 CHECK(read_at IS NULL OR (isfinite(read_at) AND read_at>=created_at))
);
CREATE INDEX errand_feature_notice_owner ON whaleu_notifications.errand_feature_notices(recipient_account_id,created_at DESC,id DESC);
CREATE INDEX errand_feature_notice_unread ON whaleu_notifications.errand_feature_notices(recipient_account_id) WHERE read_at IS NULL;
-- One UUID namespace across the union; source AFTER INSERT avoids orphan keys
-- when the existing transition/event dedupe ON CONFLICT skips a source insert.
CREATE TABLE whaleu_notifications.errand_notice_identities (
 id uuid PRIMARY KEY,source text NOT NULL CHECK(source IN ('order','restriction')),UNIQUE(id,source)
);
INSERT INTO whaleu_notifications.errand_notice_identities SELECT id,'order' FROM whaleu_notifications.errand_notices;
ALTER TABLE whaleu_notifications.errand_notices ADD notice_source text GENERATED ALWAYS AS ('order'::text) STORED;
ALTER TABLE whaleu_notifications.errand_feature_notices ADD notice_source text GENERATED ALWAYS AS ('restriction'::text) STORED;
ALTER TABLE whaleu_notifications.errand_notices ADD FOREIGN KEY(id,notice_source) REFERENCES whaleu_notifications.errand_notice_identities(id,source) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE whaleu_notifications.errand_feature_notices ADD FOREIGN KEY(id,notice_source) REFERENCES whaleu_notifications.errand_notice_identities(id,source) DEFERRABLE INITIALLY DEFERRED;
CREATE TRIGGER errand_notice_identity_immutable BEFORE UPDATE OR DELETE ON whaleu_notifications.errand_notice_identities FOR EACH ROW EXECUTE FUNCTION whaleu_errands.immutable_row();
CREATE FUNCTION whaleu_notifications.register_errand_notice_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN INSERT INTO whaleu_notifications.errand_notice_identities(id,source) VALUES(NEW.id,NEW.notice_source); RETURN NULL; END $$;
CREATE TRIGGER errand_order_notice_identity AFTER INSERT ON whaleu_notifications.errand_notices FOR EACH ROW EXECUTE FUNCTION whaleu_notifications.register_errand_notice_identity();
CREATE TRIGGER errand_feature_notice_identity AFTER INSERT ON whaleu_notifications.errand_feature_notices FOR EACH ROW EXECUTE FUNCTION whaleu_notifications.register_errand_notice_identity();
CREATE FUNCTION whaleu_notifications.require_errand_notice_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.source='order' AND NOT EXISTS(SELECT 1 FROM whaleu_notifications.errand_notices WHERE id=NEW.id)) OR
    (NEW.source='restriction' AND NOT EXISTS(SELECT 1 FROM whaleu_notifications.errand_feature_notices WHERE id=NEW.id)) THEN
 RAISE EXCEPTION 'Notice identity requires exact durable source' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER errand_notice_source_required AFTER INSERT ON whaleu_notifications.errand_notice_identities DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_notifications.require_errand_notice_source();
CREATE OR REPLACE FUNCTION whaleu_notifications.freeze_errand_notice() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Errand notice is durable'; END IF;
 IF (to_jsonb(NEW)-ARRAY['read_at','notice_source']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['read_at','notice_source']) OR (OLD.read_at IS NOT NULL AND NEW.read_at IS DISTINCT FROM OLD.read_at) OR NEW.read_at IS NULL THEN RAISE EXCEPTION 'Errand notice identity is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER errand_feature_notice_immutable BEFORE UPDATE OR DELETE ON whaleu_notifications.errand_feature_notices FOR EACH ROW EXECUTE FUNCTION whaleu_notifications.freeze_errand_notice();
CREATE OR REPLACE FUNCTION whaleu_notifications.validate_errand_notice() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE transition whaleu_errands.transitions; target whaleu_errands.orders;
BEGIN
 SELECT * INTO transition FROM whaleu_errands.transitions WHERE id=NEW.transition_id;
 SELECT * INTO target FROM whaleu_errands.orders WHERE id=NEW.order_id;
 IF transition.id IS NULL OR transition.order_id<>NEW.order_id OR
    transition.operation IS DISTINCT FROM (CASE NEW.kind WHEN 'accepted' THEN 'accept' WHEN 'completed' THEN 'complete' ELSE 'admin_delete' END) OR
    NEW.recipient_account_id IS DISTINCT FROM (CASE NEW.kind WHEN 'completed' THEN target.accepter_id ELSE target.publisher_id END) THEN RAISE EXCEPTION 'Errand notice must match its transition and recipient'; END IF;
 IF NEW.kind='admin_deleted' AND (NEW.deletion_reason IS DISTINCT FROM target.deletion_reason OR NEW.created_at<>transition.occurred_at OR target.admin_delete_event_id IS NULL) THEN RAISE EXCEPTION 'Administrative deletion notice must retain exact reason and time'; END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION whaleu_notifications.validate_errand_feature_notice() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE event whaleu_safety.errand_restriction_events; definition whaleu_safety.errand_restriction_definitions;
BEGIN
 SELECT * INTO event FROM whaleu_safety.errand_restriction_events WHERE id=NEW.event_id;
 SELECT * INTO definition FROM whaleu_safety.errand_restriction_definitions WHERE id=NEW.restriction_id;
 IF event.id IS NULL OR definition.id IS NULL OR event.restriction_id<>definition.id OR
   event.kind IS DISTINCT FROM (CASE NEW.kind WHEN 'feature_restricted' THEN 'issued' ELSE 'manually_released' END) OR
   NEW.recipient_account_id<>definition.subject_id OR NEW.action<>definition.action OR
   NEW.starts_at<>definition.starts_at OR NEW.ends_at IS DISTINCT FROM definition.ends_at OR
   NEW.created_at<>event.recorded_at OR
   NEW.reason IS DISTINCT FROM (CASE NEW.kind WHEN 'feature_restricted' THEN definition.reason ELSE event.reason END) OR
   (NEW.kind='feature_released' AND NEW.released_at IS DISTINCT FROM event.effective_at) THEN
   RAISE EXCEPTION 'Feature notice must match exact Safety event and recipient' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER errand_feature_notice_causal BEFORE INSERT ON whaleu_notifications.errand_feature_notices FOR EACH ROW EXECUTE FUNCTION whaleu_notifications.validate_errand_feature_notice();
CREATE FUNCTION whaleu_notifications.require_errand_feature_notice() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.kind IN ('issued','manually_released') AND NOT EXISTS(
  SELECT 1 FROM whaleu_notifications.errand_feature_notices n WHERE n.event_id=NEW.id
   AND n.kind=CASE NEW.kind WHEN 'issued' THEN 'feature_restricted' ELSE 'feature_released' END
 ) THEN RAISE EXCEPTION 'Safety event requires durable local errand notice' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER errand_feature_notice_required AFTER INSERT ON whaleu_safety.errand_restriction_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_notifications.require_errand_feature_notice();
CREATE OR REPLACE FUNCTION whaleu_errands.require_transition_effects() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.operation IN ('accept','complete','admin_delete') AND NOT EXISTS(SELECT 1 FROM whaleu_notifications.errand_notices n WHERE n.transition_id=NEW.id AND n.kind=CASE NEW.operation WHEN 'accept' THEN 'accepted' WHEN 'complete' THEN 'completed' ELSE 'admin_deleted' END) THEN RAISE EXCEPTION 'Durable local errand notice required'; END IF;
 IF NEW.operation='accept' AND NOT EXISTS(SELECT 1 FROM whaleu_errands.contact_history h WHERE h.transition_id=NEW.id AND h.account_id=NEW.actor_id) THEN RAISE EXCEPTION 'Successful errand contact history required'; END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER errand_notice_identity_no_truncate BEFORE TRUNCATE ON whaleu_notifications.errand_notice_identities FOR EACH STATEMENT EXECUTE FUNCTION whaleu_errands.immutable_row();
CREATE TRIGGER errand_feature_notice_no_truncate BEFORE TRUNCATE ON whaleu_notifications.errand_feature_notices FOR EACH STATEMENT EXECUTE FUNCTION whaleu_errands.immutable_row();
CREATE TRIGGER errand_notice_no_truncate BEFORE TRUNCATE ON whaleu_notifications.errand_notices FOR EACH STATEMENT EXECUTE FUNCTION whaleu_errands.immutable_row();
