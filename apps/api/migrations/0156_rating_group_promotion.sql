-- New purpose-specific owner. No legacy enrollment, provider, credential or schedule.
CREATE TABLE whaleu_ratings.promotion_programs (
 id uuid PRIMARY KEY,lineage uuid NOT NULL UNIQUE,revision uuid NOT NULL,type text NOT NULL CHECK(type IN('course','canteen')),
 source_binding jsonb NOT NULL,source_hash text NOT NULL CHECK(source_hash ~ '^[a-f0-9]{64}$'),
 audience_epoch bigint NOT NULL DEFAULT 0 CHECK(audience_epoch>=0),scope_ids uuid[] NOT NULL CHECK(cardinality(scope_ids)<=2000),include_default boolean NOT NULL DEFAULT false,
 account_lineage uuid NOT NULL,profile_id text NOT NULL CHECK(profile_id ~ '^synthetic:[a-z0-9:_-]{1,100}$'),grant_epoch bigint NOT NULL DEFAULT 0 CHECK(grant_epoch>=0),
 enabled boolean NOT NULL DEFAULT false,coverage text NOT NULL CHECK(coverage IN('complete','unknown')),provenance text NOT NULL CHECK(provenance='accepted'),
 evidence_ref text NOT NULL CHECK(length(evidence_ref) BETWEEN 1 AND 200),timezone text NOT NULL DEFAULT 'UTC',
 effective_at timestamptz NOT NULL DEFAULT clock_timestamp(),valid_until timestamptz NOT NULL CHECK(isfinite(valid_until)),
 UNIQUE(id,revision),CHECK(jsonb_typeof(source_binding)='object'),CHECK(valid_until>effective_at)
);
CREATE TABLE whaleu_ratings.promotion_policy_revisions (
 id uuid NOT NULL,revision uuid NOT NULL,program_id uuid NOT NULL REFERENCES whaleu_ratings.promotion_programs(id),
 purpose text NOT NULL CHECK(purpose='rating_group_promotion'),source_hash text NOT NULL,scope_ids uuid[] NOT NULL,
 include_default boolean NOT NULL,allow_test boolean NOT NULL,enabled boolean NOT NULL,evidence_ref text NOT NULL CHECK(length(evidence_ref)>0),
 effective_at timestamptz NOT NULL,valid_until timestamptz NOT NULL,PRIMARY KEY(id,revision),CHECK(valid_until>effective_at)
);
CREATE TABLE whaleu_ratings.promotion_source_bindings (
 id uuid PRIMARY KEY,program_id uuid NOT NULL REFERENCES whaleu_ratings.promotion_programs(id),binding_hash text NOT NULL,binding jsonb NOT NULL,
 policy_id uuid NOT NULL,policy_revision uuid NOT NULL,locator_mapping_revision uuid NOT NULL,
 public_label text NOT NULL CHECK(length(public_label) BETWEEN 1 AND 80),source_evidence jsonb NOT NULL,
 effective_at timestamptz NOT NULL,valid_until timestamptz NOT NULL,enabled boolean NOT NULL,
 FOREIGN KEY(policy_id,policy_revision) REFERENCES whaleu_ratings.promotion_policy_revisions(id,revision),UNIQUE(program_id,binding_hash)
);
CREATE TABLE whaleu_ratings.promotion_grants (
 id uuid PRIMARY KEY,program_id uuid NOT NULL REFERENCES whaleu_ratings.promotion_programs(id),principal_lineage uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN('operator','service')),revision uuid NOT NULL,epoch bigint NOT NULL DEFAULT 0,
 actions text[] NOT NULL,scope_ids uuid[] NOT NULL,allow_default boolean NOT NULL DEFAULT false,allow_test boolean NOT NULL DEFAULT false,
 evidence_ref text NOT NULL CHECK(length(evidence_ref)>0),active boolean NOT NULL,valid_until timestamptz NOT NULL,
 UNIQUE(program_id,principal_lineage,kind)
);
-- Permanent physical identity deduplication is distinct from current enrollment.
CREATE TABLE whaleu_ratings.promotion_receiver_lineages (
 id uuid PRIMARY KEY,account_lineage uuid NOT NULL,canonical_hash text NOT NULL CHECK(canonical_hash ~ '^[a-f0-9]{64}$'),
 retired boolean NOT NULL DEFAULT false,UNIQUE(account_lineage,canonical_hash)
);
CREATE TABLE whaleu_ratings.promotion_receivers (
 id uuid PRIMARY KEY REFERENCES whaleu_ratings.promotion_receiver_lineages(id),revision uuid NOT NULL,account_lineage uuid NOT NULL,
 canonical_hash text NOT NULL,opaque_ref text NOT NULL CHECK(opaque_ref ~ '^synthetic:[a-z0-9:_-]{1,100}$'),
 audience_kind text NOT NULL CHECK(audience_kind IN('school_treehole','default_treehole','test')),school_scope_id uuid,
 label text NOT NULL CHECK(length(label) BETWEEN 1 AND 100),owner_evidence_ref text NOT NULL CHECK(length(owner_evidence_ref)>0),
 purpose_grant_id uuid NOT NULL,consent_policy_revision uuid NOT NULL,active boolean NOT NULL,active_from timestamptz NOT NULL,valid_until timestamptz NOT NULL,
 FOREIGN KEY(account_lineage,canonical_hash) REFERENCES whaleu_ratings.promotion_receiver_lineages(account_lineage,canonical_hash),
 CHECK((audience_kind='school_treehole')=(school_scope_id IS NOT NULL)),CHECK(valid_until>active_from),UNIQUE(id,revision)
);
CREATE TABLE whaleu_ratings.promotion_enrollment_history (
 revision uuid PRIMARY KEY,program_id uuid NOT NULL REFERENCES whaleu_ratings.promotion_programs(id),stable_destination_id uuid NOT NULL REFERENCES whaleu_ratings.promotion_receiver_lineages(id),
 registry_revision uuid NOT NULL,action text NOT NULL CHECK(action IN('enroll','revoke')),evidence_ref text NOT NULL CHECK(length(evidence_ref)>0),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(program_id,stable_destination_id,revision)
);
CREATE TABLE whaleu_ratings.promotion_program_members_current (
 program_id uuid NOT NULL,stable_destination_id uuid NOT NULL,audience_kind text NOT NULL CHECK(audience_kind IN('school_treehole','default_treehole','test')),
 school_scope_id uuid,enrollment_revision uuid NOT NULL,registry_revision uuid NOT NULL,
 PRIMARY KEY(program_id,stable_destination_id),
 FOREIGN KEY(program_id,stable_destination_id,enrollment_revision) REFERENCES whaleu_ratings.promotion_enrollment_history(program_id,stable_destination_id,revision),
 FOREIGN KEY(stable_destination_id,registry_revision) REFERENCES whaleu_ratings.promotion_receivers(id,revision)
);
CREATE INDEX promotion_current_kind_cursor ON whaleu_ratings.promotion_program_members_current(program_id,audience_kind,stable_destination_id);
CREATE TABLE whaleu_ratings.promotion_previews (
 id uuid PRIMARY KEY,program_id uuid NOT NULL REFERENCES whaleu_ratings.promotion_programs(id),actor uuid NOT NULL,command jsonb NOT NULL,
 source_hash text NOT NULL,audience_epoch bigint NOT NULL,grant_revision uuid NOT NULL,grant_epoch bigint NOT NULL,
 expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '5 minutes'
);
CREATE TABLE whaleu_ratings.promotion_intents (
 request_id uuid PRIMARY KEY,program_id uuid NOT NULL REFERENCES whaleu_ratings.promotion_programs(id),actor uuid NOT NULL,
 preview_id uuid NOT NULL REFERENCES whaleu_ratings.promotion_previews(id),command jsonb NOT NULL,request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 ticket text NOT NULL,issued_at timestamptz NOT NULL,expires_at timestamptz NOT NULL,
 UNIQUE(program_id,actor,request_id),UNIQUE(request_id,request_hash),CHECK(expires_at>issued_at AND expires_at<=issued_at+interval '15 minutes')
);
CREATE TABLE whaleu_ratings.promotion_cancel_requests (
 request_id uuid PRIMARY KEY REFERENCES whaleu_ratings.promotion_intents(request_id),cancel_request_id uuid NOT NULL,actor uuid NOT NULL,request_hash text NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),FOREIGN KEY(request_id,request_hash) REFERENCES whaleu_ratings.promotion_intents(request_id,request_hash)
);
CREATE TABLE whaleu_ratings.promotion_campaigns (
 id uuid PRIMARY KEY,request_id uuid NOT NULL UNIQUE REFERENCES whaleu_ratings.promotion_intents(request_id),program_id uuid NOT NULL REFERENCES whaleu_ratings.promotion_programs(id),actor uuid NOT NULL,
 request_hash text NOT NULL,command jsonb NOT NULL,program_revision uuid NOT NULL,source_hash text NOT NULL,audience_epoch bigint NOT NULL,grant_revision uuid NOT NULL,grant_epoch bigint NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL,compose_by timestamptz NOT NULL,
 mode text NOT NULL CHECK(mode IN('normal','test')),recipient_count integer NOT NULL CHECK(recipient_count BETWEEN 0 AND 10000),
 snapshot_sealed boolean NOT NULL DEFAULT false,cursor uuid,payload jsonb,payload_hash text,qualification_hash text,copy_provenance text CHECK(copy_provenance IN('deterministic','generated','fallback')),
 cancelled_at timestamptz,payload_purged_at timestamptz,source_withdrawn boolean NOT NULL DEFAULT false,
 FOREIGN KEY(request_id,request_hash) REFERENCES whaleu_ratings.promotion_intents(request_id,request_hash),
 CHECK(expires_at>created_at),CHECK(compose_by<=created_at+interval '2 minutes'),CHECK((payload IS NULL) OR (payload_hash IS NOT NULL AND qualification_hash IS NOT NULL)),
 UNIQUE(id,program_id)
);
CREATE INDEX promotion_campaign_active ON whaleu_ratings.promotion_campaigns(program_id,expires_at);
CREATE INDEX promotion_campaign_purge ON whaleu_ratings.promotion_campaigns(expires_at,id);
CREATE TABLE whaleu_ratings.promotion_campaign_recipients (
 campaign_id uuid NOT NULL REFERENCES whaleu_ratings.promotion_campaigns(id),stable_destination_id uuid NOT NULL REFERENCES whaleu_ratings.promotion_receiver_lineages(id),
 enrollment_revision uuid NOT NULL REFERENCES whaleu_ratings.promotion_enrollment_history(revision),registry_revision uuid NOT NULL,
 audience_kind text NOT NULL CHECK(audience_kind IN('school_treehole','default_treehole','test')),school_scope_id uuid,
 PRIMARY KEY(campaign_id,stable_destination_id)
);
CREATE TABLE whaleu_ratings.promotion_admissions (
 campaign_id uuid PRIMARY KEY REFERENCES whaleu_ratings.promotion_campaigns(id),program_id uuid NOT NULL,actor uuid NOT NULL,
 utc_day date NOT NULL DEFAULT (clock_timestamp() AT TIME ZONE 'UTC')::date,is_test boolean NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX promotion_admission_program_day ON whaleu_ratings.promotion_admissions(program_id,utc_day);
CREATE INDEX promotion_admission_actor_day ON whaleu_ratings.promotion_admissions(actor,utc_day);
CREATE INDEX promotion_admission_day ON whaleu_ratings.promotion_admissions(utc_day);
CREATE TABLE whaleu_ratings.promotion_slots (
 program_lineage uuid NOT NULL,schedule_lineage uuid NOT NULL,ordinal bigint NOT NULL CHECK(ordinal>=0),
 due_at timestamptz NOT NULL,outcome text NOT NULL CHECK(outcome IN('admitted','skipped')),campaign_id uuid,
 PRIMARY KEY(program_lineage,schedule_lineage,ordinal)
);
CREATE TABLE whaleu_notifications.rating_group_effects (
 id uuid PRIMARY KEY,campaign_id uuid NOT NULL REFERENCES whaleu_ratings.promotion_campaigns(id),stage text NOT NULL CHECK(stage IN('generation','shortlink','delivery')),
 stable_destination_id uuid,original_key text NOT NULL UNIQUE CHECK(original_key ~ '^[a-f0-9]{64}$'),profile_id text NOT NULL,account_lineage uuid NOT NULL,
 input_hash text NOT NULL,payload_hash text,state text NOT NULL DEFAULT 'pending' CHECK(state IN('pending','preparing','dispatch_unknown','confirmed','retry_wait','suppressed_unsent','parked_unknown')),
 next_action_at timestamptz NOT NULL DEFAULT clock_timestamp(),fence bigint NOT NULL DEFAULT 0,attempt_id uuid,lease_until timestamptz,
 dispatches integer NOT NULL DEFAULT 0 CHECK(dispatches>=0),preparations integer NOT NULL DEFAULT 0 CHECK(preparations BETWEEN 0 AND 3),
 reconciliations integer NOT NULL DEFAULT 0 CHECK(reconciliations BETWEEN 0 AND 24),reason text,
 confirmed_at timestamptz,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT rating_group_stage_destination CHECK((stage='delivery')=(stable_destination_id IS NOT NULL)),
 CONSTRAINT rating_group_dispatch_cap CHECK(dispatches<=CASE WHEN stage='delivery' THEN 3 ELSE 2 END),
 FOREIGN KEY(campaign_id,stable_destination_id) REFERENCES whaleu_ratings.promotion_campaign_recipients(campaign_id,stable_destination_id),
 UNIQUE(id,original_key),UNIQUE(id,campaign_id)
);
CREATE UNIQUE INDEX rating_group_receiver_effect ON whaleu_notifications.rating_group_effects(campaign_id,stage,stable_destination_id) WHERE stable_destination_id IS NOT NULL;
CREATE UNIQUE INDEX rating_group_receiverless_effect ON whaleu_notifications.rating_group_effects(campaign_id,stage) WHERE stable_destination_id IS NULL;
CREATE INDEX rating_group_work ON whaleu_notifications.rating_group_effects(stage,next_action_at,id) WHERE state IN('pending','retry_wait','dispatch_unknown','preparing');
CREATE TABLE whaleu_notifications.rating_group_attempts (
 id uuid PRIMARY KEY,effect_id uuid NOT NULL,original_key text NOT NULL,ordinal integer NOT NULL,fence bigint NOT NULL,
 operation text NOT NULL CHECK(operation IN('dispatch','reconcile')),identity jsonb NOT NULL,prepared_hash text,authority_digest text,
 claimed_at timestamptz NOT NULL DEFAULT clock_timestamp(),lease_until timestamptz NOT NULL,possible_dispatch_at timestamptz,
 FOREIGN KEY(effect_id,original_key) REFERENCES whaleu_notifications.rating_group_effects(id,original_key),UNIQUE(effect_id,id),UNIQUE(effect_id,fence)
);
CREATE TABLE whaleu_notifications.rating_group_evidence (
 id uuid PRIMARY KEY,effect_id uuid NOT NULL,original_attempt_id uuid NOT NULL,original_key text NOT NULL,profile_id text NOT NULL,account_lineage uuid NOT NULL,
 receipt_id text NOT NULL,kind text NOT NULL CHECK(kind IN('accepted','not_accepted')),evidence jsonb NOT NULL,
 observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(effect_id,original_attempt_id) REFERENCES whaleu_notifications.rating_group_attempts(effect_id,id),
 FOREIGN KEY(effect_id,original_key) REFERENCES whaleu_notifications.rating_group_effects(id,original_key),
 UNIQUE(profile_id,account_lineage,receipt_id),UNIQUE(original_attempt_id,kind),CHECK(pg_column_size(evidence)<=2048)
);
CREATE TABLE whaleu_notifications.rating_group_evidence_inbox (
 original_attempt_id uuid PRIMARY KEY REFERENCES whaleu_notifications.rating_group_attempts(id),evidence jsonb NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN('pending','settled','quarantined')),received_at timestamptz NOT NULL DEFAULT clock_timestamp(),CHECK(pg_column_size(evidence)<=2048)
);
CREATE INDEX rating_group_inbox_pending ON whaleu_notifications.rating_group_evidence_inbox(received_at,original_attempt_id) WHERE state='pending';
CREATE TABLE whaleu_notifications.rating_group_receiver_gates (
 stable_destination_id uuid PRIMARY KEY REFERENCES whaleu_ratings.promotion_receiver_lineages(id),effect_id uuid NOT NULL REFERENCES whaleu_notifications.rating_group_effects(id),
 original_attempt_id uuid NOT NULL REFERENCES whaleu_notifications.rating_group_attempts(id),fence bigint NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE whaleu_notifications.rating_group_counters (
 stable_destination_id uuid NOT NULL REFERENCES whaleu_ratings.promotion_receiver_lineages(id),campaign_id uuid NOT NULL REFERENCES whaleu_ratings.promotion_campaigns(id),
 utc_day date NOT NULL DEFAULT (clock_timestamp() AT TIME ZONE 'UTC')::date,reserved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(stable_destination_id,campaign_id)
);
CREATE INDEX rating_group_receiver_daily ON whaleu_notifications.rating_group_counters(stable_destination_id,utc_day,reserved_at);
CREATE TABLE whaleu_ratings.promotion_cost_reservations (
 effect_id uuid NOT NULL REFERENCES whaleu_notifications.rating_group_effects(id),attempt_id uuid NOT NULL REFERENCES whaleu_notifications.rating_group_attempts(id),
 microcredits integer NOT NULL CHECK(microcredits BETWEEN 0 AND 1000000),settled boolean NOT NULL DEFAULT false,
 PRIMARY KEY(effect_id,attempt_id)
);
CREATE FUNCTION whaleu_ratings.promotion_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 RAISE EXCEPTION 'Immutable promotion evidence' USING ERRCODE='23514',CONSTRAINT='promotion_immutable'; END $$;
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['promotion_policy_revisions','promotion_enrollment_history','promotion_previews','promotion_intents','promotion_cancel_requests','promotion_admissions','promotion_campaign_recipients','promotion_slots'] LOOP
 EXECUTE format('CREATE TRIGGER promotion_immutable BEFORE UPDATE OR DELETE ON whaleu_ratings.%I FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.promotion_immutable()',t); END LOOP; END $$;
CREATE TRIGGER rating_group_evidence_immutable BEFORE UPDATE OR DELETE ON whaleu_notifications.rating_group_evidence FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.promotion_immutable();
CREATE FUNCTION whaleu_ratings.promotion_membership_causal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p whaleu_ratings.promotion_programs;r whaleu_ratings.promotion_receivers;h whaleu_ratings.promotion_enrollment_history;
BEGIN
 SELECT * INTO p FROM whaleu_ratings.promotion_programs WHERE id=coalesce(NEW.program_id,OLD.program_id) FOR UPDATE;
 IF TG_OP<>'DELETE' THEN
 SELECT * INTO r FROM whaleu_ratings.promotion_receivers WHERE id=NEW.stable_destination_id;
 SELECT * INTO h FROM whaleu_ratings.promotion_enrollment_history WHERE revision=NEW.enrollment_revision;
 IF h.action<>'enroll' OR NOT r.active OR r.revision<>NEW.registry_revision OR r.account_lineage<>p.account_lineage
 OR r.audience_kind<>NEW.audience_kind OR r.school_scope_id IS DISTINCT FROM NEW.school_scope_id
 OR (r.audience_kind='school_treehole' AND NOT r.school_scope_id=ANY(p.scope_ids))
 OR (r.audience_kind='default_treehole' AND NOT p.include_default) THEN
 RAISE EXCEPTION 'Invalid membership' USING ERRCODE='23514',CONSTRAINT='promotion_membership_causal'; END IF;
 END IF;
 UPDATE whaleu_ratings.promotion_programs SET audience_epoch=audience_epoch+1 WHERE id=p.id;
 RETURN coalesce(NEW,OLD);
END $$;
CREATE TRIGGER promotion_membership_causal BEFORE INSERT OR UPDATE OR DELETE ON whaleu_ratings.promotion_program_members_current FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.promotion_membership_causal();
CREATE FUNCTION whaleu_notifications.rating_group_effect_causal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c whaleu_ratings.promotion_campaigns;a whaleu_notifications.rating_group_attempts;
BEGIN
 SELECT * INTO c FROM whaleu_ratings.promotion_campaigns WHERE id=NEW.campaign_id;
 -- New deliveries need an adopted payload, while exact historical settlement
 -- remains possible after the existing legal expiry+24h purge transition.
 IF NEW.stage='delivery' AND (
 c.id IS NULL OR NOT c.snapshot_sealed OR c.payload_hash IS NULL OR c.qualification_hash IS NULL
 OR NEW.payload_hash IS NULL OR NEW.payload_hash IS DISTINCT FROM c.payload_hash OR NEW.input_hash IS DISTINCT FROM NEW.payload_hash
 OR (TG_OP='INSERT' AND c.payload IS NULL)
 OR (TG_OP='UPDATE' AND c.payload IS NULL AND c.payload_purged_at IS NULL)
 ) THEN RAISE EXCEPTION 'Payload not adopted' USING ERRCODE='23514',CONSTRAINT='rating_group_payload_adopted'; END IF;
 IF TG_OP='UPDATE' THEN
 IF ROW(NEW.id,NEW.campaign_id,NEW.stage,NEW.stable_destination_id,NEW.original_key,NEW.profile_id,NEW.account_lineage,NEW.input_hash,NEW.payload_hash) IS DISTINCT FROM ROW(OLD.id,OLD.campaign_id,OLD.stage,OLD.stable_destination_id,OLD.original_key,OLD.profile_id,OLD.account_lineage,OLD.input_hash,OLD.payload_hash)
 OR NEW.dispatches<OLD.dispatches OR NEW.reconciliations<OLD.reconciliations OR NEW.fence<OLD.fence OR (OLD.state='confirmed' AND NEW.state<>'confirmed') THEN
 RAISE EXCEPTION 'Effect identity or history changed' USING ERRCODE='23514',CONSTRAINT='rating_group_effect_immutable'; END IF;
 IF OLD.state IN('dispatch_unknown','parked_unknown') AND NEW.state IN('retry_wait','suppressed_unsent','confirmed') AND NOT EXISTS(
 SELECT 1 FROM whaleu_notifications.rating_group_evidence e WHERE e.effect_id=NEW.id AND e.original_attempt_id=OLD.attempt_id AND e.kind=CASE WHEN NEW.state='confirmed' THEN 'accepted' ELSE 'not_accepted' END) THEN
 RAISE EXCEPTION 'Missing exact terminal evidence' USING ERRCODE='23514',CONSTRAINT='rating_group_terminal_evidence'; END IF;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER rating_group_effect_causal BEFORE INSERT OR UPDATE ON whaleu_notifications.rating_group_effects FOR EACH ROW EXECUTE FUNCTION whaleu_notifications.rating_group_effect_causal();
CREATE FUNCTION whaleu_notifications.rating_group_evidence_exact() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a whaleu_notifications.rating_group_attempts;
BEGIN
 SELECT * INTO a FROM whaleu_notifications.rating_group_attempts WHERE id=NEW.original_attempt_id;
 IF a.operation<>'dispatch' OR a.possible_dispatch_at IS NULL OR a.identity IS DISTINCT FROM (NEW.evidence - ARRAY['kind','receiptId','acceptedAt','observedAt','proofHash','output'])
 OR NEW.original_key<>a.original_key OR NEW.effect_id<>a.effect_id OR NEW.evidence->>'kind'<>NEW.kind
 OR NEW.evidence->>'receiptId'<>NEW.receipt_id THEN RAISE EXCEPTION 'Evidence tuple mismatch' USING ERRCODE='23514',CONSTRAINT='rating_group_evidence_exact'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER rating_group_evidence_exact BEFORE INSERT ON whaleu_notifications.rating_group_evidence FOR EACH ROW EXECUTE FUNCTION whaleu_notifications.rating_group_evidence_exact();
