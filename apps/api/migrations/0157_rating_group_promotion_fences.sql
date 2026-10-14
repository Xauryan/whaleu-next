ALTER TABLE whaleu_notifications.rating_group_effects ADD COLUMN result_text text CHECK(octet_length(result_text)<=2048);
ALTER TABLE whaleu_notifications.rating_group_effects ADD COLUMN recovery_requested boolean NOT NULL DEFAULT false;
CREATE INDEX rating_group_effect_campaign ON whaleu_notifications.rating_group_effects(campaign_id,stage);
CREATE INDEX promotion_current_receiver ON whaleu_ratings.promotion_program_members_current(stable_destination_id,program_id);
CREATE FUNCTION whaleu_ratings.promotion_campaign_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(NEW.id,NEW.request_id,NEW.program_id,NEW.actor,NEW.request_hash,NEW.command,NEW.program_revision,NEW.source_hash,NEW.audience_epoch,NEW.grant_revision,NEW.grant_epoch,NEW.created_at,NEW.expires_at,NEW.compose_by,NEW.mode,NEW.recipient_count) IS DISTINCT FROM ROW(OLD.id,OLD.request_id,OLD.program_id,OLD.actor,OLD.request_hash,OLD.command,OLD.program_revision,OLD.source_hash,OLD.audience_epoch,OLD.grant_revision,OLD.grant_epoch,OLD.created_at,OLD.expires_at,OLD.compose_by,OLD.mode,OLD.recipient_count)
 OR (OLD.payload_hash IS NOT NULL AND ROW(NEW.payload_hash,NEW.qualification_hash,NEW.copy_provenance) IS DISTINCT FROM ROW(OLD.payload_hash,OLD.qualification_hash,OLD.copy_provenance))
 OR (OLD.payload IS NOT NULL AND NEW.payload IS DISTINCT FROM OLD.payload AND NOT(NEW.payload IS NULL AND NEW.payload_purged_at IS NOT NULL AND clock_timestamp()>OLD.expires_at+interval '24 hours'))
 OR (OLD.cancelled_at IS NOT NULL AND NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at)
 THEN RAISE EXCEPTION 'Campaign history is immutable' USING ERRCODE='23514',CONSTRAINT='promotion_campaign_immutable'; END IF;RETURN NEW;END $$;
CREATE TRIGGER promotion_campaign_immutable BEFORE UPDATE ON whaleu_ratings.promotion_campaigns FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.promotion_campaign_immutable();
CREATE FUNCTION whaleu_ratings.promotion_program_lineage() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(NEW.id,NEW.lineage,NEW.account_lineage) IS DISTINCT FROM ROW(OLD.id,OLD.lineage,OLD.account_lineage) OR NEW.grant_epoch<OLD.grant_epoch OR NEW.audience_epoch<OLD.audience_epoch
 THEN RAISE EXCEPTION 'Program lineage is immutable' USING ERRCODE='23514',CONSTRAINT='promotion_program_lineage'; END IF;
 IF ROW(NEW.enabled,NEW.revision,NEW.source_hash,NEW.source_binding,NEW.type,NEW.scope_ids,NEW.include_default,NEW.profile_id,NEW.coverage,NEW.provenance,NEW.effective_at,NEW.valid_until) IS DISTINCT FROM ROW(OLD.enabled,OLD.revision,OLD.source_hash,OLD.source_binding,OLD.type,OLD.scope_ids,OLD.include_default,OLD.profile_id,OLD.coverage,OLD.provenance,OLD.effective_at,OLD.valid_until) THEN NEW.grant_epoch=OLD.grant_epoch+1; END IF;RETURN NEW;END $$;
CREATE TRIGGER promotion_program_lineage BEFORE UPDATE ON whaleu_ratings.promotion_programs FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.promotion_program_lineage();
CREATE FUNCTION whaleu_ratings.promotion_grant_epoch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 UPDATE whaleu_ratings.promotion_programs SET grant_epoch=grant_epoch+1 WHERE id=coalesce(NEW.program_id,OLD.program_id);RETURN coalesce(NEW,OLD);END $$;
CREATE TRIGGER promotion_grant_epoch AFTER INSERT OR UPDATE OR DELETE ON whaleu_ratings.promotion_grants FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.promotion_grant_epoch();
CREATE FUNCTION whaleu_ratings.promotion_receiver_lineage_exact() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM whaleu_ratings.promotion_receiver_lineages l WHERE l.id=NEW.id AND l.account_lineage=NEW.account_lineage AND l.canonical_hash=NEW.canonical_hash) THEN RAISE EXCEPTION 'Receiver lineage mismatch' USING ERRCODE='23514',CONSTRAINT='promotion_receiver_lineage_exact';END IF;RETURN NEW;END $$;
CREATE TRIGGER promotion_receiver_lineage_exact BEFORE INSERT OR UPDATE ON whaleu_ratings.promotion_receivers FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.promotion_receiver_lineage_exact();
ALTER TABLE whaleu_ratings.promotion_campaigns ADD COLUMN next_maintenance_at timestamptz NOT NULL DEFAULT clock_timestamp();
CREATE INDEX promotion_campaign_maintenance ON whaleu_ratings.promotion_campaigns(next_maintenance_at,id) WHERE cancelled_at IS NULL;
CREATE TABLE whaleu_ratings.promotion_payload_qualifications (
 program_id uuid NOT NULL REFERENCES whaleu_ratings.promotion_programs(id),payload_hash text NOT NULL,policy_revision uuid NOT NULL,
 source_hash text NOT NULL,enabled boolean NOT NULL,evidence_ref text NOT NULL CHECK(length(evidence_ref)>0),valid_until timestamptz NOT NULL,
 PRIMARY KEY(program_id,payload_hash)
);
CREATE FUNCTION whaleu_ratings.promotion_cost_cap() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s text;reserved bigint;
BEGIN
 SELECT stage INTO s FROM whaleu_notifications.rating_group_effects WHERE id=NEW.effect_id FOR UPDATE;
 SELECT coalesce(sum(microcredits),0) INTO reserved FROM whaleu_ratings.promotion_cost_reservations WHERE effect_id=NEW.effect_id;
 IF s='delivery' OR reserved+NEW.microcredits>(CASE WHEN s='generation' THEN 1000000 ELSE 200000 END) THEN RAISE EXCEPTION 'Effect cost ceiling' USING ERRCODE='23514',CONSTRAINT='rating_group_cost_cap';END IF;RETURN NEW;
END $$;
CREATE TRIGGER rating_group_cost_cap BEFORE INSERT ON whaleu_ratings.promotion_cost_reservations FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.promotion_cost_cap();
CREATE TABLE whaleu_notifications.rating_group_emission_slots (
 effect_id uuid PRIMARY KEY REFERENCES whaleu_notifications.rating_group_effects(id),attempt_id uuid NOT NULL REFERENCES whaleu_notifications.rating_group_attempts(id),account_lineage uuid NOT NULL
);
CREATE TABLE whaleu_notifications.rating_group_worker_leases (
 slot integer PRIMARY KEY CHECK(slot BETWEEN 1 AND 4),token uuid NOT NULL,lease_until timestamptz NOT NULL
);
ALTER TABLE whaleu_ratings.promotion_campaigns ADD COLUMN principal_kind text NOT NULL DEFAULT 'operator' CHECK(principal_kind IN('operator','service'));
ALTER TABLE whaleu_ratings.promotion_slots RENAME COLUMN ordinal TO slot_ordinal;
CREATE TABLE whaleu_ratings.promotion_schedules (
 program_id uuid PRIMARY KEY REFERENCES whaleu_ratings.promotion_programs(id),lineage uuid NOT NULL UNIQUE,principal_lineage uuid NOT NULL,
 grant_revision uuid NOT NULL,program_revision uuid NOT NULL,anchor timestamptz NOT NULL CHECK(isfinite(anchor)),
 period_seconds integer NOT NULL CHECK(period_seconds BETWEEN 86400 AND 31536000),next_ordinal bigint NOT NULL DEFAULT 0 CHECK(next_ordinal>=0),
 next_due_at timestamptz NOT NULL,enabled boolean NOT NULL,evidence_ref text NOT NULL CHECK(length(evidence_ref)>0),
 CHECK(next_due_at=anchor+next_ordinal*period_seconds*interval '1 second')
);
CREATE INDEX promotion_schedule_due ON whaleu_ratings.promotion_schedules(next_due_at,program_id) WHERE enabled;
CREATE FUNCTION whaleu_ratings.promotion_schedule_lineage() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' OR ROW(NEW.program_id,NEW.lineage,NEW.principal_lineage,NEW.anchor,NEW.period_seconds) IS DISTINCT FROM ROW(OLD.program_id,OLD.lineage,OLD.principal_lineage,OLD.anchor,OLD.period_seconds) OR NEW.next_ordinal<OLD.next_ordinal THEN RAISE EXCEPTION 'Schedule lineage cannot replay' USING ERRCODE='23514',CONSTRAINT='promotion_schedule_lineage'; END IF;RETURN NEW;END $$;
CREATE TRIGGER promotion_schedule_lineage BEFORE UPDATE OR DELETE ON whaleu_ratings.promotion_schedules FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.promotion_schedule_lineage();
