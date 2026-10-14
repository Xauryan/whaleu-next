-- Attempts are append-only. Final proof adds a separate immutable dispatch seal.
CREATE TABLE whaleu_notifications.rating_group_permits (
 attempt_id uuid PRIMARY KEY REFERENCES whaleu_notifications.rating_group_attempts(id),effect_id uuid NOT NULL,original_key text NOT NULL,
 prepared_hash text NOT NULL CHECK(prepared_hash ~ '^[a-f0-9]{64}$'),authority_digest text NOT NULL CHECK(authority_digest ~ '^[a-f0-9]{64}$'),
 possible_dispatch_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(effect_id,attempt_id) REFERENCES whaleu_notifications.rating_group_attempts(effect_id,id),
 FOREIGN KEY(effect_id,original_key) REFERENCES whaleu_notifications.rating_group_effects(id,original_key)
);
CREATE TRIGGER rating_group_attempt_immutable BEFORE UPDATE OR DELETE ON whaleu_notifications.rating_group_attempts FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.promotion_immutable();
CREATE TRIGGER rating_group_permit_immutable BEFORE UPDATE OR DELETE ON whaleu_notifications.rating_group_permits FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.promotion_immutable();
ALTER TABLE whaleu_notifications.rating_group_effects ADD CONSTRAINT rating_group_current_attempt_fk FOREIGN KEY(id,attempt_id) REFERENCES whaleu_notifications.rating_group_attempts(effect_id,id) DEFERRABLE INITIALLY DEFERRED;
CREATE FUNCTION whaleu_notifications.rating_group_attempt_exact() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e whaleu_notifications.rating_group_effects;original whaleu_notifications.rating_group_attempts;expected jsonb;
BEGIN
 SELECT * INTO e FROM whaleu_notifications.rating_group_effects WHERE id=NEW.effect_id;
 IF NEW.operation='dispatch' THEN
 expected=jsonb_build_object('effectId',e.id,'attemptId',NEW.id,'key',e.original_key,'stage',e.stage,'profileId',e.profile_id,'accountLineage',e.account_lineage,'destinationId',e.stable_destination_id,'inputHash',e.input_hash,'payloadHash',e.payload_hash,'fence',NEW.fence::text);
 ELSE
 SELECT * INTO original FROM whaleu_notifications.rating_group_attempts WHERE id=(NEW.identity->>'attemptId')::uuid AND effect_id=e.id AND operation='dispatch';expected=original.identity;
 END IF;
 IF expected IS NULL OR NEW.identity IS DISTINCT FROM expected OR NEW.original_key<>e.original_key OR NEW.fence<>e.fence OR NEW.lease_until<>e.lease_until OR NEW.prepared_hash IS NOT NULL OR NEW.authority_digest IS NOT NULL OR NEW.possible_dispatch_at IS NOT NULL THEN RAISE EXCEPTION 'Attempt tuple mismatch' USING ERRCODE='23514',CONSTRAINT='rating_group_attempt_exact';END IF;RETURN NEW;
END $$;
CREATE TRIGGER rating_group_attempt_exact BEFORE INSERT ON whaleu_notifications.rating_group_attempts FOR EACH ROW EXECUTE FUNCTION whaleu_notifications.rating_group_attempt_exact();
CREATE FUNCTION whaleu_notifications.rating_group_permit_exact() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM whaleu_notifications.rating_group_attempts a JOIN whaleu_notifications.rating_group_effects e ON e.id=a.effect_id WHERE a.id=NEW.attempt_id AND a.effect_id=NEW.effect_id AND a.original_key=NEW.original_key AND a.operation='dispatch' AND e.attempt_id=a.id AND e.fence=a.fence AND e.state='preparing' AND e.lease_until>clock_timestamp()+interval '1 second' AND ((e.stage='delivery' AND EXISTS(SELECT 1 FROM whaleu_notifications.rating_group_receiver_gates g WHERE g.effect_id=e.id AND g.original_attempt_id=a.id AND g.fence=a.fence AND g.stable_destination_id=e.stable_destination_id) AND EXISTS(SELECT 1 FROM whaleu_notifications.rating_group_counters c WHERE c.campaign_id=e.campaign_id AND c.stable_destination_id=e.stable_destination_id)) OR (e.stage IN('generation','shortlink') AND EXISTS(SELECT 1 FROM whaleu_ratings.promotion_cost_reservations r WHERE r.effect_id=e.id AND r.attempt_id=a.id AND NOT r.settled AND r.microcredits=CASE WHEN e.stage='generation' THEN 500000 ELSE 100000 END)))) THEN RAISE EXCEPTION 'Permit tuple mismatch' USING ERRCODE='23514',CONSTRAINT='rating_group_permit_exact';END IF;RETURN NEW;END $$;
CREATE TRIGGER rating_group_permit_exact BEFORE INSERT ON whaleu_notifications.rating_group_permits FOR EACH ROW EXECUTE FUNCTION whaleu_notifications.rating_group_permit_exact();
CREATE OR REPLACE FUNCTION whaleu_notifications.rating_group_evidence_exact() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a whaleu_notifications.rating_group_attempts;
BEGIN
 SELECT * INTO a FROM whaleu_notifications.rating_group_attempts WHERE id=NEW.original_attempt_id;
 IF a.operation<>'dispatch' OR NOT EXISTS(SELECT 1 FROM whaleu_notifications.rating_group_permits WHERE attempt_id=a.id)
 OR a.identity IS DISTINCT FROM (NEW.evidence - ARRAY['kind','receiptId','acceptedAt','observedAt','proofHash','output'])
 OR NEW.original_key<>a.original_key OR NEW.effect_id<>a.effect_id OR NEW.evidence->>'kind'<>NEW.kind
 OR NEW.evidence->>'receiptId'<>NEW.receipt_id OR NEW.profile_id<>a.identity->>'profileId' OR NEW.account_lineage::text<>a.identity->>'accountLineage'
 THEN RAISE EXCEPTION 'Evidence tuple mismatch' USING ERRCODE='23514',CONSTRAINT='rating_group_evidence_exact';END IF;RETURN NEW;
END $$;
CREATE FUNCTION whaleu_notifications.rating_group_state_causal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE possible boolean;terminal text;
BEGIN
 IF TG_OP='INSERT' THEN
 IF NEW.state<>'pending' OR NEW.dispatches<>0 OR NEW.preparations<>0 OR NEW.reconciliations<>0 OR NEW.fence<>0 OR NEW.attempt_id IS NOT NULL OR NEW.confirmed_at IS NOT NULL THEN RAISE EXCEPTION 'Uncaused initial state' USING ERRCODE='23514',CONSTRAINT='rating_group_state_causal';END IF;RETURN NEW;END IF;
 SELECT EXISTS(SELECT 1 FROM whaleu_notifications.rating_group_permits WHERE attempt_id=OLD.attempt_id) INTO possible;
 IF NOT ((OLD.state='pending' AND NEW.state IN('pending','preparing','suppressed_unsent'))
 OR (OLD.state='preparing' AND NEW.state IN('preparing','retry_wait','dispatch_unknown','suppressed_unsent'))
 OR (OLD.state='retry_wait' AND NEW.state IN('retry_wait','preparing','suppressed_unsent'))
 OR (OLD.state IN('dispatch_unknown','parked_unknown') AND NEW.state IN('dispatch_unknown','parked_unknown','confirmed','retry_wait','suppressed_unsent'))
 OR (OLD.state='confirmed' AND NEW.state='confirmed') OR (OLD.state='suppressed_unsent' AND NEW.state='suppressed_unsent')) THEN RAISE EXCEPTION 'Invalid effect transition' USING ERRCODE='23514',CONSTRAINT='rating_group_state_causal';END IF;
 IF NEW.state='dispatch_unknown' AND OLD.state='preparing' AND (NOT possible OR NEW.dispatches<>OLD.dispatches+1) THEN RAISE EXCEPTION 'Missing final dispatch seal' USING ERRCODE='23514',CONSTRAINT='rating_group_state_causal';END IF;
 IF NEW.dispatches<>OLD.dispatches AND NOT(OLD.state='preparing' AND NEW.state='dispatch_unknown' AND NEW.dispatches=OLD.dispatches+1) THEN RAISE EXCEPTION 'Dispatch counter changed without seal' USING ERRCODE='23514',CONSTRAINT='rating_group_state_causal';END IF;
 IF OLD.state='preparing' AND NEW.state IN('preparing','retry_wait','suppressed_unsent') AND possible THEN RAISE EXCEPTION 'Possible emission cannot become not-sent' USING ERRCODE='23514',CONSTRAINT='rating_group_state_causal';END IF;
 IF NEW.state='confirmed' AND (NEW.confirmed_at IS NULL OR NOT EXISTS(SELECT 1 FROM whaleu_notifications.rating_group_evidence WHERE effect_id=NEW.id AND original_attempt_id=NEW.attempt_id AND kind='accepted')) THEN RAISE EXCEPTION 'Missing acceptance evidence' USING ERRCODE='23514',CONSTRAINT='rating_group_state_causal';END IF;
 IF OLD.state IN('dispatch_unknown','parked_unknown') AND NEW.attempt_id IS DISTINCT FROM OLD.attempt_id THEN RAISE EXCEPTION 'Unknown changed original attempt' USING ERRCODE='23514',CONSTRAINT='rating_group_state_causal';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER rating_group_state_causal BEFORE INSERT OR UPDATE ON whaleu_notifications.rating_group_effects FOR EACH ROW EXECUTE FUNCTION whaleu_notifications.rating_group_state_causal();
ALTER TABLE whaleu_notifications.rating_group_emission_slots ADD COLUMN lease_until timestamptz NOT NULL DEFAULT clock_timestamp()+interval '30 seconds';
ALTER TABLE whaleu_ratings.promotion_previews ADD COLUMN originating_session_id uuid;
ALTER TABLE whaleu_ratings.promotion_campaigns ADD COLUMN originating_session_id uuid;
CREATE TABLE whaleu_notifications.rating_group_restore_binding (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),domain_id uuid NOT NULL,
 ledger_instance_id uuid NOT NULL DEFAULT gen_random_uuid(),restore_epoch uuid NOT NULL DEFAULT gen_random_uuid(),
 sender_store_id uuid NOT NULL,generation_store_id uuid,shortlink_store_id uuid
);
CREATE TRIGGER rating_group_restore_immutable BEFORE UPDATE OR DELETE ON whaleu_notifications.rating_group_restore_binding FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.promotion_immutable();
CREATE FUNCTION whaleu_ratings.promotion_principal_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='INSERT' AND ((NEW.principal_kind='operator')<>(NEW.originating_session_id IS NOT NULL)) THEN RAISE EXCEPTION 'Invalid originating principal' USING ERRCODE='23514',CONSTRAINT='promotion_principal_immutable';END IF;
 IF TG_OP='UPDATE' AND ROW(NEW.principal_kind,NEW.originating_session_id) IS DISTINCT FROM ROW(OLD.principal_kind,OLD.originating_session_id) THEN RAISE EXCEPTION 'Originating principal changed' USING ERRCODE='23514',CONSTRAINT='promotion_principal_immutable';END IF;RETURN NEW;END $$;
CREATE TRIGGER promotion_principal_immutable BEFORE INSERT OR UPDATE ON whaleu_ratings.promotion_campaigns FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.promotion_principal_immutable();
CREATE FUNCTION whaleu_ratings.promotion_snapshot_seal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.snapshot_sealed AND NOT NEW.snapshot_sealed THEN RAISE EXCEPTION 'Snapshot cannot reopen' USING ERRCODE='23514',CONSTRAINT='promotion_snapshot_seal';END IF;RETURN NEW;END $$;
CREATE TRIGGER promotion_snapshot_seal BEFORE UPDATE ON whaleu_ratings.promotion_campaigns FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.promotion_snapshot_seal();
CREATE FUNCTION whaleu_ratings.promotion_snapshot_exact() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE i whaleu_ratings.promotion_intents;p whaleu_ratings.promotion_previews;actual integer;invalid integer;
BEGIN
 SELECT * INTO i FROM whaleu_ratings.promotion_intents WHERE request_id=NEW.request_id;
 SELECT * INTO p FROM whaleu_ratings.promotion_previews WHERE id=i.preview_id;
 IF NOT (SELECT snapshot_sealed FROM whaleu_ratings.promotion_campaigns WHERE id=NEW.id) OR i.request_id IS NULL OR p.id IS NULL OR ROW(NEW.program_id,NEW.actor,NEW.request_hash,NEW.command) IS DISTINCT FROM ROW(i.program_id,i.actor,i.request_hash,i.command)
 OR NEW.program_id<>p.program_id OR NEW.actor<>p.actor OR NEW.source_hash<>p.source_hash OR NEW.audience_epoch<>p.audience_epoch OR NEW.grant_revision<>p.grant_revision OR NEW.grant_epoch<>p.grant_epoch OR NEW.originating_session_id IS DISTINCT FROM p.originating_session_id
 OR NEW.command->>'requestId'<>NEW.request_id::text OR NEW.command->>'programId'<>NEW.program_id::text OR NEW.command->>'principalLineage'<>NEW.actor::text OR NEW.command->>'mode'<>NEW.mode
 THEN RAISE EXCEPTION 'Campaign intent mismatch' USING ERRCODE='23514',CONSTRAINT='promotion_snapshot_exact';END IF;
 SELECT count(*)::int,count(*) FILTER(WHERE h.revision IS NULL OR h.action<>'enroll' OR h.program_id<>NEW.program_id OR h.stable_destination_id<>r.stable_destination_id OR h.registry_revision<>r.registry_revision OR (NEW.mode='test')<>(r.audience_kind='test') OR (NEW.mode='test' AND r.stable_destination_id::text IS DISTINCT FROM NEW.command->>'testDestinationId'))::int INTO actual,invalid
 FROM whaleu_ratings.promotion_campaign_recipients r LEFT JOIN whaleu_ratings.promotion_enrollment_history h ON h.revision=r.enrollment_revision WHERE r.campaign_id=NEW.id;
 IF actual<>NEW.recipient_count OR invalid<>0 OR (NEW.mode='test' AND actual<>1) THEN RAISE EXCEPTION 'Snapshot tuple mismatch' USING ERRCODE='23514',CONSTRAINT='promotion_snapshot_exact';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER promotion_snapshot_exact AFTER INSERT ON whaleu_ratings.promotion_campaigns DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.promotion_snapshot_exact();
CREATE FUNCTION whaleu_ratings.promotion_recipient_exact() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM whaleu_ratings.promotion_campaigns c JOIN whaleu_ratings.promotion_program_members_current m ON m.program_id=c.program_id AND m.stable_destination_id=NEW.stable_destination_id WHERE c.id=NEW.campaign_id AND NOT c.snapshot_sealed AND ((c.mode='normal' AND NEW.audience_kind IN('school_treehole','default_treehole')) OR (c.mode='test' AND NEW.audience_kind='test' AND NEW.stable_destination_id::text=c.command->>'testDestinationId')) AND m.enrollment_revision=NEW.enrollment_revision AND m.registry_revision=NEW.registry_revision AND m.audience_kind=NEW.audience_kind AND m.school_scope_id IS NOT DISTINCT FROM NEW.school_scope_id AND c.audience_epoch=(SELECT audience_epoch FROM whaleu_ratings.promotion_programs WHERE id=c.program_id)) THEN RAISE EXCEPTION 'Recipient is not exact current snapshot' USING ERRCODE='23514',CONSTRAINT='promotion_recipient_exact';END IF;RETURN NEW;END $$;
CREATE TRIGGER promotion_recipient_exact BEFORE INSERT ON whaleu_ratings.promotion_campaign_recipients FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.promotion_recipient_exact();
ALTER TABLE whaleu_notifications.rating_group_receiver_gates ADD CONSTRAINT rating_group_gate_attempt_fk FOREIGN KEY(effect_id,original_attempt_id) REFERENCES whaleu_notifications.rating_group_attempts(effect_id,id);
ALTER TABLE whaleu_ratings.promotion_cost_reservations ADD CONSTRAINT rating_group_cost_attempt_fk FOREIGN KEY(effect_id,attempt_id) REFERENCES whaleu_notifications.rating_group_attempts(effect_id,id);
ALTER TABLE whaleu_notifications.rating_group_emission_slots ADD CONSTRAINT rating_group_slot_attempt_fk FOREIGN KEY(effect_id,attempt_id) REFERENCES whaleu_notifications.rating_group_attempts(effect_id,id);
CREATE FUNCTION whaleu_notifications.rating_group_gate_exact() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM whaleu_notifications.rating_group_effects e JOIN whaleu_notifications.rating_group_attempts a ON a.effect_id=e.id AND a.id=NEW.original_attempt_id WHERE e.id=NEW.effect_id AND e.stage='delivery' AND e.stable_destination_id=NEW.stable_destination_id AND a.operation='dispatch' AND a.fence=NEW.fence AND e.attempt_id=a.id AND e.fence=a.fence AND e.state='preparing') THEN RAISE EXCEPTION 'Receiver gate tuple mismatch' USING ERRCODE='23514',CONSTRAINT='rating_group_gate_exact';END IF;RETURN NEW;END $$;
CREATE TRIGGER rating_group_gate_exact BEFORE INSERT OR UPDATE ON whaleu_notifications.rating_group_receiver_gates FOR EACH ROW EXECUTE FUNCTION whaleu_notifications.rating_group_gate_exact();
CREATE FUNCTION whaleu_notifications.rating_group_slot_exact() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM whaleu_notifications.rating_group_effects e JOIN whaleu_notifications.rating_group_attempts a ON a.effect_id=e.id AND a.id=NEW.attempt_id WHERE e.id=NEW.effect_id AND a.operation='dispatch' AND e.attempt_id=a.id AND e.fence=a.fence AND e.state='preparing' AND e.account_lineage=NEW.account_lineage) THEN RAISE EXCEPTION 'Emission slot tuple mismatch' USING ERRCODE='23514',CONSTRAINT='rating_group_slot_exact';END IF;RETURN NEW;END $$;
CREATE TRIGGER rating_group_slot_exact BEFORE INSERT OR UPDATE ON whaleu_notifications.rating_group_emission_slots FOR EACH ROW EXECUTE FUNCTION whaleu_notifications.rating_group_slot_exact();
ALTER TABLE whaleu_notifications.rating_group_evidence ADD CONSTRAINT rating_group_one_terminal_per_attempt UNIQUE(original_attempt_id);
CREATE FUNCTION whaleu_ratings.promotion_receiver_epoch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(NEW.id,NEW.account_lineage,NEW.canonical_hash) IS DISTINCT FROM ROW(OLD.id,OLD.account_lineage,OLD.canonical_hash) THEN RAISE EXCEPTION 'Physical receiver lineage changed' USING ERRCODE='23514',CONSTRAINT='promotion_receiver_epoch';END IF;
 IF ROW(NEW.active,NEW.opaque_ref,NEW.audience_kind,NEW.school_scope_id,NEW.purpose_grant_id,NEW.consent_policy_revision,NEW.valid_until) IS DISTINCT FROM ROW(OLD.active,OLD.opaque_ref,OLD.audience_kind,OLD.school_scope_id,OLD.purpose_grant_id,OLD.consent_policy_revision,OLD.valid_until) THEN
 IF NEW.active AND NEW.revision=OLD.revision THEN RAISE EXCEPTION 'Receiver binding requires new revision' USING ERRCODE='23514',CONSTRAINT='promotion_receiver_epoch';END IF;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER promotion_receiver_epoch BEFORE UPDATE ON whaleu_ratings.promotion_receivers FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.promotion_receiver_epoch();
CREATE TABLE whaleu_ratings.promotion_effect_profiles (
 program_id uuid NOT NULL REFERENCES whaleu_ratings.promotion_programs(id),stage text NOT NULL CHECK(stage IN('generation','shortlink')),revision uuid NOT NULL,
 profile_id text NOT NULL,purpose text NOT NULL CHECK(purpose='rating_push'),input_fields text[] NOT NULL,
 template_ref text NOT NULL CHECK(template_ref ~ '^synthetic:'),tokenizer_ref text NOT NULL CHECK(tokenizer_ref ~ '^synthetic:'),
 max_input_tokens integer NOT NULL DEFAULT 512 CHECK(max_input_tokens BETWEEN 1 AND 512),max_output_tokens integer NOT NULL DEFAULT 128 CHECK(max_output_tokens BETWEEN 1 AND 128),
 monetary_limit integer NOT NULL DEFAULT 0 CHECK(monetary_limit=0),enabled boolean NOT NULL,valid_until timestamptz NOT NULL,evidence_ref text NOT NULL CHECK(length(evidence_ref)>0),
 PRIMARY KEY(program_id,stage),UNIQUE(program_id,stage,revision)
);
ALTER TABLE whaleu_notifications.rating_group_effects ADD COLUMN profile_policy_revision uuid;
CREATE FUNCTION whaleu_notifications.rating_group_profile_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.profile_policy_revision IS DISTINCT FROM OLD.profile_policy_revision THEN RAISE EXCEPTION 'Effect profile changed' USING ERRCODE='23514',CONSTRAINT='rating_group_profile_immutable';END IF;RETURN NEW;END $$;
CREATE TRIGGER rating_group_profile_immutable BEFORE UPDATE ON whaleu_notifications.rating_group_effects FOR EACH ROW EXECUTE FUNCTION whaleu_notifications.rating_group_profile_immutable();

CREATE FUNCTION whaleu_ratings.promotion_profile_epoch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.revision=OLD.revision AND NEW IS DISTINCT FROM OLD THEN NEW.revision=gen_random_uuid();END IF;RETURN NEW;END $$;
CREATE TRIGGER promotion_profile_epoch BEFORE UPDATE ON whaleu_ratings.promotion_effect_profiles FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.promotion_profile_epoch();

CREATE FUNCTION whaleu_ratings.promotion_program_capacity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('rating-group-program-capacity-v1',0));
 IF (SELECT count(*) FROM (SELECT id FROM whaleu_ratings.promotion_programs LIMIT 256) bounded)>=256 THEN RAISE EXCEPTION 'Accepted program capacity' USING ERRCODE='23514',CONSTRAINT='promotion_program_capacity';END IF;RETURN NEW;
END $$;
CREATE TRIGGER promotion_program_capacity BEFORE INSERT ON whaleu_ratings.promotion_programs FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.promotion_program_capacity();

-- A successful transaction cannot leave possible emission without its durable
-- receiver exclusion/quota or cost reservation. Transient worker slots are not
-- part of this graph and may be released while outcome stays unknown.
CREATE FUNCTION whaleu_notifications.rating_group_reservation_reverse() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e whaleu_notifications.rating_group_effects;
BEGIN
 SELECT * INTO e FROM whaleu_notifications.rating_group_effects WHERE id=NEW.effect_id;
 IF e.id IS NULL THEN RETURN NULL;END IF;
 IF e.state NOT IN('dispatch_unknown','parked_unknown') OR e.attempt_id<>NEW.attempt_id THEN RAISE EXCEPTION 'Permit has no original possible effect' USING ERRCODE='23514',CONSTRAINT='rating_group_reservation_reverse';END IF;
 IF (e.stage='delivery' AND (NOT EXISTS(SELECT 1 FROM whaleu_notifications.rating_group_receiver_gates g WHERE g.effect_id=e.id AND g.original_attempt_id=NEW.attempt_id AND g.stable_destination_id=e.stable_destination_id) OR NOT EXISTS(SELECT 1 FROM whaleu_notifications.rating_group_counters c WHERE c.campaign_id=e.campaign_id AND c.stable_destination_id=e.stable_destination_id))) OR (e.stage<>'delivery' AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.promotion_cost_reservations r WHERE r.effect_id=e.id AND r.attempt_id=NEW.attempt_id AND NOT r.settled)) THEN RAISE EXCEPTION 'Missing original reservation' USING ERRCODE='23514',CONSTRAINT='rating_group_reservation_reverse';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER rating_group_reservation_reverse AFTER INSERT ON whaleu_notifications.rating_group_permits DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_notifications.rating_group_reservation_reverse();
CREATE FUNCTION whaleu_notifications.rating_group_reservation_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF pg_trigger_depth()>1 THEN RETURN OLD;END IF;
 IF EXISTS(SELECT 1 FROM whaleu_notifications.rating_group_effects WHERE id=OLD.effect_id AND state IN('dispatch_unknown','parked_unknown')) THEN RAISE EXCEPTION 'Unknown reservation remains occupied' USING ERRCODE='23514',CONSTRAINT='rating_group_reservation_delete';END IF;RETURN OLD;
END $$;
CREATE TRIGGER rating_group_gate_delete BEFORE DELETE ON whaleu_notifications.rating_group_receiver_gates FOR EACH ROW EXECUTE FUNCTION whaleu_notifications.rating_group_reservation_delete();
CREATE TRIGGER rating_group_cost_delete BEFORE DELETE ON whaleu_ratings.promotion_cost_reservations FOR EACH ROW EXECUTE FUNCTION whaleu_notifications.rating_group_reservation_delete();
CREATE TRIGGER rating_group_counter_immutable BEFORE UPDATE OR DELETE ON whaleu_notifications.rating_group_counters FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.promotion_immutable();
CREATE FUNCTION whaleu_ratings.promotion_cost_settlement() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(NEW.effect_id,NEW.attempt_id,NEW.microcredits) IS DISTINCT FROM ROW(OLD.effect_id,OLD.attempt_id,OLD.microcredits) OR (OLD.settled AND NOT NEW.settled) OR (NEW.settled AND NOT EXISTS(SELECT 1 FROM whaleu_notifications.rating_group_evidence WHERE effect_id=NEW.effect_id AND original_attempt_id=NEW.attempt_id)) THEN RAISE EXCEPTION 'Cost settlement requires original evidence' USING ERRCODE='23514',CONSTRAINT='promotion_cost_settlement';END IF;RETURN NEW;
END $$;
CREATE TRIGGER promotion_cost_settlement BEFORE UPDATE ON whaleu_ratings.promotion_cost_reservations FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.promotion_cost_settlement();
CREATE FUNCTION whaleu_ratings.promotion_physical_lineage_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(NEW.id,NEW.account_lineage,NEW.canonical_hash) IS DISTINCT FROM ROW(OLD.id,OLD.account_lineage,OLD.canonical_hash) OR (OLD.retired AND NOT NEW.retired) THEN RAISE EXCEPTION 'Physical lineage cannot reset' USING ERRCODE='23514',CONSTRAINT='promotion_physical_lineage_immutable';END IF;RETURN NEW;
END $$;
CREATE TRIGGER promotion_physical_lineage_immutable BEFORE UPDATE ON whaleu_ratings.promotion_receiver_lineages FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.promotion_physical_lineage_immutable();
CREATE TRIGGER rating_group_retired_gate_immutable BEFORE UPDATE OR DELETE ON whaleu_notifications.rating_group_retired_gates FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.promotion_immutable();
