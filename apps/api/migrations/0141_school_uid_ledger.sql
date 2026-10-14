-- Permanent institution UID namespaces. Unknown inventory is never a zero floor.
-- This first slice admits explicitly synthetic packages only; no real importer.
CREATE SCHEMA whaleu_school_uid;
CREATE FUNCTION whaleu_school_uid.immutable_statement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'School UID evidence is append-only' USING ERRCODE='23514'; END $$;
CREATE FUNCTION whaleu_school_uid.stamp_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.creation_transaction:=pg_current_xact_id(); NEW.created_at:=clock_timestamp(); RETURN NEW; END $$;

CREATE TABLE whaleu_school_uid.inventory_batches(
 id uuid PRIMARY KEY, format_version text NOT NULL CHECK(format_version='school-uid-inventory/v1'),
 package_digest text NOT NULL UNIQUE CHECK(package_digest ~ '^[0-9a-f]{64}$'),
 source_instance text NOT NULL CHECK(length(source_instance) BETWEEN 1 AND 200),
 source_cutoff timestamptz NOT NULL, snapshot_digest text NOT NULL CHECK(snapshot_digest ~ '^[0-9a-f]{64}$'),
 mapping_digest text NOT NULL CHECK(mapping_digest ~ '^[0-9a-f]{64}$'),
 acceptance_digest text NOT NULL CHECK(acceptance_digest ~ '^[0-9a-f]{64}$'),
 writer_cutover_digest text NOT NULL CHECK(writer_cutover_digest ~ '^[0-9a-f]{64}$'),
 classification text NOT NULL CHECK(classification='synthetic'),
 manifest jsonb NOT NULL CHECK(jsonb_typeof(manifest)='object'),
 creation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE whaleu_school_uid.school_admissions(
 id uuid PRIMARY KEY,institution_id uuid NOT NULL REFERENCES whaleu_campus.institutions(id),
 revision integer NOT NULL CHECK(revision>0),batch_id uuid NOT NULL REFERENCES whaleu_school_uid.inventory_batches(id),
 classification text NOT NULL CHECK(classification IN('known_new','reconciled')),
 reserved_floor bigint NOT NULL CHECK(reserved_floor>=0),issuance_available boolean NOT NULL DEFAULT true,
 creation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(institution_id,revision),UNIQUE(batch_id,institution_id),UNIQUE(id,institution_id,revision)
);
CREATE TABLE whaleu_school_uid.admission_heads(
 institution_id uuid PRIMARY KEY REFERENCES whaleu_campus.institutions(id),admission_id uuid NOT NULL,
 revision integer NOT NULL CHECK(revision>0),high_water bigint NOT NULL CHECK(high_water>=0),
 FOREIGN KEY(admission_id,institution_id,revision) REFERENCES whaleu_school_uid.school_admissions(id,institution_id,revision)
);
CREATE TABLE whaleu_school_uid.native_absence_observations(
 id uuid PRIMARY KEY,account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
 native_proof jsonb,history_proof jsonb NOT NULL,existing_coverage_id uuid,initial_generation text NOT NULL DEFAULT '',
 creation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(creation_transaction,account_id)
);
CREATE TABLE whaleu_school_uid.producing_causes(
 id uuid PRIMARY KEY,kind text NOT NULL CHECK(kind IN('student_approval','correct_school','complete_uid','unchanged','imported')),
 account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),actor_account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
 source_id uuid NOT NULL,affiliation_assertion_id uuid NOT NULL,snapshot_id uuid NOT NULL,institution_id uuid NOT NULL REFERENCES whaleu_campus.institutions(id),
 verification_event_id uuid NOT NULL,old_snapshot_id uuid NOT NULL,old_revision integer NOT NULL CHECK(old_revision>0),
 coverage_observation_id uuid REFERENCES whaleu_school_uid.native_absence_observations(id),
 creation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(kind,source_id),UNIQUE(id,account_id,institution_id),UNIQUE(creation_transaction,account_id)
);
CREATE TABLE whaleu_school_uid.import_sources(
 id uuid PRIMARY KEY,cause_id uuid NOT NULL UNIQUE REFERENCES whaleu_school_uid.producing_causes(id) DEFERRABLE INITIALLY DEFERRED,
 batch_id uuid NOT NULL REFERENCES whaleu_school_uid.inventory_batches(id),account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
 institution_id uuid NOT NULL REFERENCES whaleu_campus.institutions(id),source_account_id text NOT NULL,
 mode text NOT NULL CHECK(mode IN('current','historical','covered_missing')),uid bigint CHECK(uid>0),
 observation_id uuid NOT NULL REFERENCES whaleu_school_uid.native_absence_observations(id),
 mapping_proof jsonb NOT NULL,old_head jsonb,initial_generation text NOT NULL,
 creation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(creation_transaction),UNIQUE(batch_id,account_id,institution_id,mode,uid),CHECK((mode='covered_missing')=(uid IS NULL))
);
CREATE TABLE whaleu_school_uid.account_coverage(
 id uuid PRIMARY KEY,account_id uuid NOT NULL UNIQUE REFERENCES whaleu_identity.accounts(id),kind text NOT NULL CHECK(kind IN('native_absence','accepted_import')),
 observation_id uuid UNIQUE REFERENCES whaleu_school_uid.native_absence_observations(id),
 cause_id uuid NOT NULL UNIQUE REFERENCES whaleu_school_uid.producing_causes(id),enrollment_operation_id uuid,
 batch_id uuid REFERENCES whaleu_school_uid.inventory_batches(id),source_account_id text,mapping_proof jsonb,
 CHECK((kind='native_absence' AND observation_id IS NOT NULL AND enrollment_operation_id IS NOT NULL AND batch_id IS NULL AND source_account_id IS NULL AND mapping_proof IS NULL) OR (kind='accepted_import' AND observation_id IS NULL AND enrollment_operation_id IS NULL AND batch_id IS NOT NULL AND source_account_id IS NOT NULL AND mapping_proof IS NOT NULL)),
 creation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE whaleu_school_uid.allocations(
 id uuid PRIMARY KEY,account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),institution_id uuid NOT NULL REFERENCES whaleu_campus.institutions(id),
 uid bigint NOT NULL CHECK(uid>0),admission_id uuid NOT NULL REFERENCES whaleu_school_uid.school_admissions(id),
 cause_id uuid NOT NULL UNIQUE,predecessor_allocation_id uuid REFERENCES whaleu_school_uid.allocations(id),
 creation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),allocated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(institution_id,uid),UNIQUE(id,account_id,institution_id),
 FOREIGN KEY(cause_id,account_id,institution_id) REFERENCES whaleu_school_uid.producing_causes(id,account_id,institution_id)
);
CREATE INDEX allocations_account_history ON whaleu_school_uid.allocations(account_id,id);
CREATE TABLE whaleu_school_uid.assignment_events(
 id uuid PRIMARY KEY,cause_id uuid NOT NULL UNIQUE,account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),institution_id uuid NOT NULL REFERENCES whaleu_campus.institutions(id),
 previous_allocation_id uuid REFERENCES whaleu_school_uid.allocations(id),resulting_allocation_id uuid,
 affiliation_assertion_id uuid NOT NULL,snapshot_id uuid NOT NULL,revision integer NOT NULL CHECK(revision>0),
 outcome text NOT NULL CHECK(outcome IN('issued','retained','deferred_unavailable','imported','covered_missing')),
 unavailable_reason text CHECK(unavailable_reason IN('inventory_unknown','account_history_unknown')),
 creation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(account_id,revision),UNIQUE(id,account_id,revision),
 FOREIGN KEY(cause_id,account_id,institution_id) REFERENCES whaleu_school_uid.producing_causes(id,account_id,institution_id),
 FOREIGN KEY(resulting_allocation_id,account_id,institution_id) REFERENCES whaleu_school_uid.allocations(id,account_id,institution_id),
 FOREIGN KEY(affiliation_assertion_id,account_id) REFERENCES whaleu_verification.assertions(id,account_id),
 CHECK((outcome='deferred_unavailable')=(unavailable_reason IS NOT NULL)),
 CHECK((outcome IN('deferred_unavailable','covered_missing'))=(resulting_allocation_id IS NULL)),
 CHECK(outcome<>'retained' OR resulting_allocation_id=previous_allocation_id)
);
CREATE TABLE whaleu_school_uid.account_heads(
 account_id uuid PRIMARY KEY REFERENCES whaleu_identity.accounts(id),revision integer NOT NULL CHECK(revision>0),
 event_id uuid NOT NULL,allocation_id uuid,institution_id uuid NOT NULL,cause_id uuid NOT NULL REFERENCES whaleu_school_uid.producing_causes(id),
 FOREIGN KEY(event_id,account_id,revision) REFERENCES whaleu_school_uid.assignment_events(id,account_id,revision),
 FOREIGN KEY(allocation_id,account_id,institution_id) REFERENCES whaleu_school_uid.allocations(id,account_id,institution_id)
);
CREATE TABLE whaleu_school_uid.issuance_decisions(
 student_decision_id uuid PRIMARY KEY REFERENCES whaleu_verification.student_decisions(id),
 cause_id uuid NOT NULL UNIQUE REFERENCES whaleu_school_uid.producing_causes(id),event_id uuid NOT NULL UNIQUE REFERENCES whaleu_school_uid.assignment_events(id),
 outcome text NOT NULL CHECK(outcome IN('issued','retained','deferred_unavailable')),
 unavailable_reason text CHECK(unavailable_reason IN('inventory_unknown','account_history_unknown')),
 creation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((outcome='deferred_unavailable')=(unavailable_reason IS NOT NULL))
);
-- Trigger-owned witnesses, not caller-provided old values, GUCs or guessed xids.
CREATE TABLE whaleu_school_uid.counter_transitions(
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,institution_id uuid NOT NULL,admission_id uuid NOT NULL,
 allocation_id uuid,old_value bigint,new_value bigint NOT NULL,kind text NOT NULL CHECK(kind IN('admission','allocation')),
 creation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((kind='allocation')=(allocation_id IS NOT NULL)),UNIQUE(allocation_id),UNIQUE(kind,admission_id,allocation_id)
);
CREATE TABLE whaleu_school_uid.head_transitions(
 cause_id uuid PRIMARY KEY REFERENCES whaleu_school_uid.producing_causes(id),account_id uuid NOT NULL,
 old_head jsonb,new_head jsonb NOT NULL,creation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE FUNCTION whaleu_school_uid.native_identity_proof(target uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object('account',a.id,'creation',a.local_creation_transaction::text,'enrollment',to_jsonb(n),
  'affiliation',to_jsonb(af),'number',to_jsonb(sn),'phone',to_jsonb(ph),'snapshot',to_jsonb(s),'event',to_jsonb(e))
 FROM whaleu_identity.accounts a JOIN whaleu_verification.native_enrollments n ON n.account_id=a.id
 JOIN whaleu_verification.assertions af ON af.id=n.affiliation_id AND af.account_id=a.id
 JOIN whaleu_verification.assertions sn ON sn.id=n.student_number_id AND sn.account_id=a.id
 JOIN whaleu_verification.assertions ph ON ph.id=n.phone_id AND ph.account_id=a.id
 JOIN whaleu_verification.snapshots s ON s.id=n.snapshot_id AND s.account_id=a.id
 JOIN whaleu_verification.events e ON e.id=n.event_id AND e.account_id=a.id
 WHERE a.id=target AND a.status='active' AND a.local_creation_transaction=n.creation_transaction
 AND (af.fact_kind,sn.fact_kind,ph.fact_kind)=('affiliation','student_number','phone')
 AND af.method='native_enrollment' AND sn.method=af.method AND ph.method=af.method
 AND af.assertion_state='unverified' AND sn.assertion_state=af.assertion_state AND ph.assertion_state=af.assertion_state
 AND af.coverage_state='complete' AND sn.coverage_state=af.coverage_state AND ph.coverage_state=af.coverage_state
 AND af.provenance_state='accepted' AND sn.provenance_state=af.provenance_state AND ph.provenance_state=af.provenance_state
 AND af.policy_reference='native-account-absence/v1' AND sn.policy_reference=af.policy_reference AND ph.policy_reference=af.policy_reference
 AND af.source_reference='native_enrollment:'||target::text AND sn.source_reference=af.source_reference AND ph.source_reference=af.source_reference
 AND af.source_account_id=target AND sn.source_account_id=target AND ph.source_account_id=target
 AND s.revision=1 AND (s.affiliation_assertion_id,s.student_number_assertion_id,s.phone_assertion_id)=(af.id,sn.id,ph.id)
 AND s.application_state='none' AND s.application_coverage='complete'
 AND e.kind='native_enrollment' AND e.operation_id=n.operation_id AND e.actor_account_id=target AND e.expected_revision=0 AND e.revision=1
 AND e.snapshot_id=s.id AND e.fact_kind IS NULL AND e.reason_code='native_account_created'
$$;
CREATE FUNCTION whaleu_school_uid.account_history_proof(target uuid,own_cause uuid DEFAULT NULL) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object(
 'mappings',(SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY to_jsonb(m)::text),'[]') FROM whaleu_identity.legacy_account_mappings m WHERE m.account_id=target),
 'coverage',(SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.id),'[]') FROM whaleu_school_uid.account_coverage c WHERE c.account_id=target AND c.cause_id IS DISTINCT FROM own_cause),
 'allocations',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.id),'[]') FROM whaleu_school_uid.allocations a WHERE a.account_id=target AND a.cause_id IS DISTINCT FROM own_cause),
 'events',(SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY e.id),'[]') FROM whaleu_school_uid.assignment_events e WHERE e.account_id=target AND e.cause_id IS DISTINCT FROM own_cause),
 'head',(SELECT to_jsonb(h) FROM whaleu_school_uid.account_heads h WHERE h.account_id=target AND h.cause_id IS DISTINCT FROM own_cause))
$$;
CREATE FUNCTION whaleu_school_uid.observe_native_absence() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 NEW.initial_generation:=whaleu_community.related_sync_generation_fingerprint('admission');
 NEW.native_proof:=whaleu_school_uid.native_identity_proof(NEW.account_id);
 NEW.history_proof:=whaleu_school_uid.account_history_proof(NEW.account_id);
 SELECT id INTO NEW.existing_coverage_id FROM whaleu_school_uid.account_coverage WHERE account_id=NEW.account_id;
 NEW.creation_transaction:=pg_current_xact_id();NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER observe_native_absence BEFORE INSERT ON whaleu_school_uid.native_absence_observations FOR EACH ROW EXECUTE FUNCTION whaleu_school_uid.observe_native_absence();

CREATE FUNCTION whaleu_school_uid.management_cause_authorized(cause whaleu_school_uid.producing_causes) RETURNS boolean LANGUAGE sql VOLATILE AS $$ SELECT false $$;
-- Replaced by the correction source owner in 0142, preserving V0 and exact own deltas.
CREATE FUNCTION whaleu_school_uid.source_generation_complete(cause_id uuid) RETURNS boolean LANGUAGE sql VOLATILE AS $$ SELECT false $$;
CREATE FUNCTION whaleu_school_uid.cause_source_valid(c whaleu_school_uid.producing_causes) RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
BEGIN
 IF c.creation_transaction<>pg_current_xact_id() THEN RETURN false; END IF;
 IF c.kind='imported' THEN RETURN whaleu_school_uid.import_source_valid(c); END IF;
 IF c.kind='complete_uid' AND whaleu_school_uid.completion_source_valid(c) IS DISTINCT FROM true THEN RETURN false; END IF;
 IF c.kind<>'student_approval' THEN RETURN whaleu_school_uid.management_cause_authorized(c); END IF;
 RETURN EXISTS(SELECT 1 FROM whaleu_verification.student_decisions d JOIN whaleu_authorization.role_grants g ON g.id=d.grant_id
 WHERE d.id=c.source_id AND d.decision='approved' AND d.creation_transaction=c.creation_transaction
 AND (d.account_id,d.actor_account_id,d.institution_id,d.assertion_id,d.snapshot_id,d.event_id)=(c.account_id,c.actor_account_id,c.institution_id,c.affiliation_assertion_id,c.snapshot_id,c.verification_event_id)
 AND d.ledger_revision=c.old_revision+1 AND g.account_id=c.actor_account_id AND g.revoked_at IS NULL AND g.valid_from<=clock_timestamp()
 AND (g.expires_at IS NULL OR g.expires_at>clock_timestamp()) AND d.evidence_expires_at>clock_timestamp()
 AND ((g.role='super_admin' AND g.operating_region_id IS NULL) OR (g.role='school_admin' AND g.operating_region_id=d.region_id)));
END $$;
CREATE FUNCTION whaleu_school_uid.cause_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('whaleu:school-uid-account:v1:'||NEW.account_id::text,0));
 NEW.creation_transaction:=pg_current_xact_id();NEW.created_at:=clock_timestamp();
 IF NOT EXISTS(SELECT 1 FROM whaleu_verification.account_heads h WHERE h.account_id=NEW.account_id AND h.snapshot_id=NEW.old_snapshot_id AND h.revision=NEW.old_revision)
 OR (NEW.coverage_observation_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM whaleu_school_uid.native_absence_observations o WHERE o.id=NEW.coverage_observation_id AND o.account_id=NEW.account_id AND o.creation_transaction=pg_current_xact_id()))
 OR (NEW.kind IN('student_approval','correct_school','complete_uid') AND EXISTS(SELECT 1 FROM whaleu_school_uid.account_heads h WHERE h.account_id=NEW.account_id AND h.allocation_id IS NOT NULL) AND whaleu_school_uid.runtime_history_known(NEW) IS DISTINCT FROM true)
 OR (NEW.kind='student_approval' AND whaleu_school_uid.cause_source_valid(NEW) IS DISTINCT FROM true)
 THEN RAISE EXCEPTION 'UID cause requires exact pre-write source' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cause_insert BEFORE INSERT ON whaleu_school_uid.producing_causes FOR EACH ROW EXECUTE FUNCTION whaleu_school_uid.cause_insert();
CREATE FUNCTION whaleu_school_uid.coverage_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c whaleu_school_uid.producing_causes;o whaleu_school_uid.native_absence_observations; empty_history jsonb;
BEGIN
 SELECT * INTO c FROM whaleu_school_uid.producing_causes WHERE id=NEW.cause_id;
 IF NEW.kind='accepted_import' THEN
  IF c.kind IS DISTINCT FROM 'imported' OR c.account_id<>NEW.account_id OR whaleu_school_uid.import_source_valid(c) IS DISTINCT FROM true
   OR NOT EXISTS(SELECT 1 FROM whaleu_school_uid.import_sources im WHERE im.id=c.source_id AND im.batch_id=NEW.batch_id AND im.source_account_id=NEW.source_account_id AND im.mapping_proof=NEW.mapping_proof)
   THEN RAISE EXCEPTION 'Imported coverage requires exact accepted source mapping' USING ERRCODE='23514';END IF;
  NEW.creation_transaction:=pg_current_xact_id();NEW.created_at:=clock_timestamp();RETURN NEW;
 END IF;
 SELECT * INTO o FROM whaleu_school_uid.native_absence_observations WHERE id=NEW.observation_id;
 empty_history:=jsonb_build_object('mappings','[]'::jsonb,'coverage','[]'::jsonb,'allocations','[]'::jsonb,'events','[]'::jsonb,'head',NULL);
 IF c.id IS NULL OR c.kind='unchanged' OR c.account_id<>NEW.account_id OR c.creation_transaction<>pg_current_xact_id()
 OR c.coverage_observation_id IS DISTINCT FROM o.id OR o.account_id<>NEW.account_id OR o.creation_transaction<>pg_current_xact_id()
 OR o.native_proof IS NULL OR o.existing_coverage_id IS NOT NULL OR o.history_proof<>empty_history
 OR o.native_proof IS DISTINCT FROM whaleu_school_uid.native_identity_proof(NEW.account_id)
 OR o.history_proof IS DISTINCT FROM whaleu_school_uid.account_history_proof(NEW.account_id)
 OR NEW.enrollment_operation_id::text IS DISTINCT FROM o.native_proof->'enrollment'->>'operation_id'
 THEN RAISE EXCEPTION 'Native UID absence requires exact retained pre-wait enrollment and empty history' USING ERRCODE='23514'; END IF;
 NEW.creation_transaction:=pg_current_xact_id();NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER coverage_insert BEFORE INSERT ON whaleu_school_uid.account_coverage FOR EACH ROW EXECUTE FUNCTION whaleu_school_uid.coverage_insert();

CREATE FUNCTION whaleu_school_uid.affiliation_current(c whaleu_school_uid.producing_causes) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT EXISTS(SELECT 1 FROM whaleu_verification.account_heads h JOIN whaleu_verification.snapshots s ON (s.id,s.account_id,s.revision)=(h.snapshot_id,h.account_id,h.revision)
 JOIN whaleu_verification.assertions a ON (a.id,a.account_id)=(s.affiliation_assertion_id,s.account_id)
 WHERE h.account_id=c.account_id AND s.id=c.snapshot_id AND a.id=c.affiliation_assertion_id AND a.fact_kind='affiliation' AND a.assertion_state='verified'
 AND a.coverage_state='complete' AND a.provenance_state='accepted' AND a.source_account_id=c.account_id
 AND a.issuer_institution_id=c.institution_id AND a.source_issuer_institution_id=c.institution_id AND a.origin_region_id IS NOT NULL
 AND a.method IN('document_review','institutional_email','institutional_sso','reconciled_import','administrator_correction')
 AND length(btrim(a.source_reference))>0 AND length(btrim(a.policy_reference))>0 AND isfinite(a.verified_at) AND a.verified_at<=clock_timestamp()
 AND ((a.expiry_kind='policy_exempt' AND a.expires_at IS NULL) OR (a.expiry_kind='at' AND isfinite(a.expires_at) AND a.expires_at>clock_timestamp() AND a.expires_at>a.verified_at)))
$$;
CREATE FUNCTION whaleu_school_uid.allocation_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c whaleu_school_uid.producing_causes;h whaleu_school_uid.admission_heads;old whaleu_school_uid.account_heads; a whaleu_school_uid.school_admissions;
BEGIN
 SELECT * INTO c FROM whaleu_school_uid.producing_causes WHERE id=NEW.cause_id;
 SELECT * INTO old FROM whaleu_school_uid.account_heads WHERE account_id=NEW.account_id;
 SELECT * INTO h FROM whaleu_school_uid.admission_heads WHERE institution_id=NEW.institution_id FOR UPDATE;
 SELECT * INTO a FROM whaleu_school_uid.school_admissions WHERE id=h.admission_id;
 IF c.kind='imported' THEN
  IF whaleu_school_uid.import_source_valid(c) IS DISTINCT FROM true OR NOT EXISTS(SELECT 1 FROM whaleu_school_uid.import_sources im WHERE im.id=c.source_id AND im.mode IN('current','historical') AND im.uid=NEW.uid AND im.account_id=NEW.account_id AND im.institution_id=NEW.institution_id)
   OR a.id IS NULL OR NEW.admission_id<>a.id OR NEW.uid>a.reserved_floor OR NEW.predecessor_allocation_id IS DISTINCT FROM old.allocation_id
   OR whaleu_school_uid.coverage_valid(NEW.account_id) IS DISTINCT FROM true THEN RAISE EXCEPTION 'Imported allocation requires exact reserved historical ownership' USING ERRCODE='23514';END IF;
  NEW.creation_transaction:=pg_current_xact_id();NEW.allocated_at:=clock_timestamp();RETURN NEW;
 END IF;
 IF c.id IS NULL OR c.kind='unchanged' OR c.creation_transaction<>pg_current_xact_id() OR (c.account_id,c.institution_id)<>(NEW.account_id,NEW.institution_id)
 OR whaleu_school_uid.affiliation_current(c) IS DISTINCT FROM true OR h.institution_id IS NULL OR a.id IS NULL OR NOT a.issuance_available OR NEW.admission_id<>a.id
 OR h.high_water=9223372036854775807 OR NEW.uid<>h.high_water+1 OR NEW.uid<=a.reserved_floor
 OR NEW.predecessor_allocation_id IS DISTINCT FROM old.allocation_id
 OR (old.allocation_id IS NOT NULL AND old.institution_id=NEW.institution_id)
 OR whaleu_school_uid.runtime_history_known(c) IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'UID allocation requires exact covered cause and next admitted counter' USING ERRCODE='23514'; END IF;
 NEW.creation_transaction:=pg_current_xact_id();NEW.allocated_at:=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER allocation_insert BEFORE INSERT ON whaleu_school_uid.allocations FOR EACH ROW EXECUTE FUNCTION whaleu_school_uid.allocation_insert();
CREATE FUNCTION whaleu_school_uid.counter_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF pg_trigger_depth()<>2 OR TG_OP='DELETE' THEN RAISE EXCEPTION 'Only an admission or allocation advances a UID counter' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' AND (NEW.institution_id<>OLD.institution_id OR NEW.high_water<OLD.high_water OR NEW.revision<OLD.revision)
 THEN RAISE EXCEPTION 'UID counter cannot rewind' USING ERRCODE='23514'; END IF;RETURN NEW;
END $$;
CREATE TRIGGER counter_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_school_uid.admission_heads FOR EACH ROW EXECUTE FUNCTION whaleu_school_uid.counter_guard();
CREATE FUNCTION whaleu_school_uid.counter_statement_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF pg_trigger_depth()<>2 THEN RAISE EXCEPTION 'Direct UID counter statements are forbidden' USING ERRCODE='23514'; END IF;RETURN NULL;
END $$;
CREATE TRIGGER counter_statement_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_school_uid.admission_heads FOR EACH STATEMENT EXECUTE FUNCTION whaleu_school_uid.counter_statement_guard();
CREATE FUNCTION whaleu_school_uid.capture_only() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF pg_trigger_depth()<>2 THEN RAISE EXCEPTION 'UID transition evidence is trigger-owned' USING ERRCODE='23514'; END IF;
 NEW.creation_transaction:=pg_current_xact_id();NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER capture_counter BEFORE INSERT ON whaleu_school_uid.counter_transitions FOR EACH ROW EXECUTE FUNCTION whaleu_school_uid.capture_only();
CREATE TRIGGER capture_head BEFORE INSERT ON whaleu_school_uid.head_transitions FOR EACH ROW EXECUTE FUNCTION whaleu_school_uid.capture_only();
CREATE FUNCTION whaleu_school_uid.allocate_counter() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous bigint;
BEGIN
 IF EXISTS(SELECT 1 FROM whaleu_school_uid.producing_causes WHERE id=NEW.cause_id AND kind='imported') THEN RETURN NULL;END IF;
 SELECT high_water INTO previous FROM whaleu_school_uid.admission_heads WHERE institution_id=NEW.institution_id FOR UPDATE;
 UPDATE whaleu_school_uid.admission_heads SET high_water=NEW.uid WHERE institution_id=NEW.institution_id AND high_water=NEW.uid-1 AND admission_id=NEW.admission_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'UID counter transition changed' USING ERRCODE='23514'; END IF;
 INSERT INTO whaleu_school_uid.counter_transitions(institution_id,admission_id,allocation_id,old_value,new_value,kind) VALUES(NEW.institution_id,NEW.admission_id,NEW.id,previous,NEW.uid,'allocation');RETURN NULL;
END $$;
CREATE TRIGGER allocate_counter AFTER INSERT ON whaleu_school_uid.allocations FOR EACH ROW EXECUTE FUNCTION whaleu_school_uid.allocate_counter();
CREATE FUNCTION whaleu_school_uid.inventory_manifest_shape_valid(p jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE s jsonb;payload_row jsonb;v jsonb;k text;
BEGIN
 IF jsonb_typeof(p) IS DISTINCT FROM 'object'
 OR NOT(p ?& ARRAY['format','classification','sourceInstance','sourceCutoff','snapshotDigest','schoolCrosswalkDigest','accountCrosswalkDigest','reviewerAcceptanceDigest','writerQuiescenceDigest','finalDeltaDigest','schools'])
 OR p-ARRAY['format','classification','sourceInstance','sourceCutoff','snapshotDigest','schoolCrosswalkDigest','accountCrosswalkDigest','reviewerAcceptanceDigest','writerQuiescenceDigest','finalDeltaDigest','schools']<>'{}'::jsonb
 OR jsonb_typeof(p->'schools') IS DISTINCT FROM 'array' THEN RETURN false;END IF;
 FOREACH k IN ARRAY ARRAY['format','classification','sourceInstance','sourceCutoff','snapshotDigest','schoolCrosswalkDigest','accountCrosswalkDigest','reviewerAcceptanceDigest','writerQuiescenceDigest','finalDeltaDigest'] LOOP
  IF jsonb_typeof(p->k) IS DISTINCT FROM 'string' OR length(p->>k) NOT BETWEEN 1 AND 200 THEN RETURN false;END IF;
 END LOOP;
 FOREACH k IN ARRAY ARRAY['snapshotDigest','schoolCrosswalkDigest','accountCrosswalkDigest','reviewerAcceptanceDigest','writerQuiescenceDigest','finalDeltaDigest'] LOOP
  IF (p->>k ~ '^[0-9a-f]{64}$') IS DISTINCT FROM true THEN RETURN false;END IF;
 END LOOP;
 IF jsonb_array_length(p->'schools') NOT BETWEEN 1 AND 100 THEN RETURN false;END IF;
 FOR s IN SELECT x FROM jsonb_array_elements(p->'schools') x LOOP
  IF jsonb_typeof(s) IS DISTINCT FROM 'object'
   OR NOT(s ?& ARRAY['sourceSchoolId','institutionId','schoolCode','classification','sourceEmptyVerified','trustedCeiling','ceilingJustificationDigest','priorAdmittedFloor','trustedCounters','counterReset','unknownHistoryBounded','reservations','unresolvedConflicts'])
   OR s-ARRAY['sourceSchoolId','institutionId','schoolCode','classification','sourceEmptyVerified','trustedCeiling','ceilingJustificationDigest','priorAdmittedFloor','trustedCounters','counterReset','unknownHistoryBounded','reservations','unresolvedConflicts','issuanceAvailable','accountCoverage']<>'{}'::jsonb
   THEN RETURN false;END IF;
  FOREACH k IN ARRAY ARRAY['sourceSchoolId','institutionId','schoolCode','classification','priorAdmittedFloor'] LOOP
   IF jsonb_typeof(s->k) IS DISTINCT FROM 'string' OR length(s->>k) NOT BETWEEN 1 AND 200 THEN RETURN false;END IF;
  END LOOP;
  IF jsonb_typeof(s->'trustedCeiling') NOT IN('string','null') OR jsonb_typeof(s->'ceilingJustificationDigest') NOT IN('string','null')
   OR s->>'classification' NOT IN('known_new','reconciled') THEN RETURN false;END IF;
  FOREACH k IN ARRAY ARRAY['sourceEmptyVerified','counterReset','unknownHistoryBounded'] LOOP
   IF jsonb_typeof(s->k) IS DISTINCT FROM 'boolean' THEN RETURN false;END IF;
  END LOOP;
  IF s ? 'issuanceAvailable' AND jsonb_typeof(s->'issuanceAvailable') IS DISTINCT FROM 'boolean' THEN RETURN false;END IF;
  FOREACH k IN ARRAY ARRAY['trustedCounters','reservations','unresolvedConflicts'] LOOP
   IF jsonb_typeof(s->k) IS DISTINCT FROM 'array' THEN RETURN false;END IF;
  END LOOP;
  IF s ? 'accountCoverage' AND jsonb_typeof(s->'accountCoverage') IS DISTINCT FROM 'array' THEN RETURN false;END IF;
  FOR payload_row IN SELECT x FROM jsonb_array_elements(s->'trustedCounters') x LOOP
   IF jsonb_typeof(payload_row) IS DISTINCT FROM 'object' OR NOT(payload_row ?& ARRAY['type','value']) OR payload_row-ARRAY['type','value']<>'{}'::jsonb
    OR jsonb_typeof(payload_row->'type') IS DISTINCT FROM 'string' OR jsonb_typeof(payload_row->'value') NOT IN('string','null')
    OR payload_row->>'type' NOT IN('string','integer','float','null') THEN RETURN false;END IF;
  END LOOP;
  FOR payload_row IN SELECT x FROM jsonb_array_elements(s->'reservations') x LOOP
   IF jsonb_typeof(payload_row) IS DISTINCT FROM 'object' OR NOT(payload_row ?& ARRAY['uid','sourceAccountId','accountId','sourceSchoolId','kind'])
    OR payload_row-ARRAY['uid','sourceAccountId','accountId','sourceSchoolId','kind']<>'{}'::jsonb
    OR jsonb_typeof(payload_row->'uid') IS DISTINCT FROM 'object' OR NOT((payload_row->'uid') ?& ARRAY['type','value']) OR (payload_row->'uid')-ARRAY['type','value']<>'{}'::jsonb
    OR jsonb_typeof(payload_row->'uid'->'type') IS DISTINCT FROM 'string' OR jsonb_typeof(payload_row->'uid'->'value') NOT IN('string','null')
    OR payload_row->'uid'->>'type' NOT IN('string','integer','float','null')
    OR jsonb_typeof(payload_row->'sourceAccountId') NOT IN('string','null') OR jsonb_typeof(payload_row->'accountId') NOT IN('string','null')
    OR jsonb_typeof(payload_row->'sourceSchoolId') IS DISTINCT FROM 'string' OR jsonb_typeof(payload_row->'kind') IS DISTINCT FROM 'string'
    OR payload_row->>'kind' NOT IN('current','historical','deleted','transferred','reserved') THEN RETURN false;END IF;
  END LOOP;
  FOR payload_row IN SELECT x FROM jsonb_array_elements(coalesce(s->'accountCoverage','[]')) x LOOP
   IF jsonb_typeof(payload_row) IS DISTINCT FROM 'object' OR NOT(payload_row ?& ARRAY['sourceAccountId','accountId','status']) OR payload_row-ARRAY['sourceAccountId','accountId','status']<>'{}'::jsonb
    OR jsonb_typeof(payload_row->'sourceAccountId') IS DISTINCT FROM 'string' OR jsonb_typeof(payload_row->'accountId') IS DISTINCT FROM 'string' OR jsonb_typeof(payload_row->'status') IS DISTINCT FROM 'string'
    OR payload_row->>'status' NOT IN('known_missing','known_assigned') THEN RETURN false;END IF;
  END LOOP;
  FOR v IN SELECT x FROM jsonb_array_elements(s->'unresolvedConflicts') x LOOP
   IF jsonb_typeof(v) IS DISTINCT FROM 'string' THEN RETURN false;END IF;
  END LOOP;
 END LOOP;
 RETURN true;
END $$;

-- Independently recheck the bounded synthetic acceptance, including raw types.
CREATE FUNCTION whaleu_school_uid.synthetic_school_valid(b whaleu_school_uid.inventory_batches,institution uuid,floor bigint,classification text) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE p jsonb:=b.manifest->'package';s jsonb;payload_row jsonb;n bigint;observed bigint:=0;counter_max bigint:=0;ceiling bigint;prior bigint;
BEGIN
 IF whaleu_school_uid.inventory_manifest_shape_valid(p) IS DISTINCT FROM true THEN RETURN false;END IF;
 IF p IS NULL OR p->>'format'<>'school-uid-inventory/v1' OR p->>'classification'<>'synthetic'
 OR p->>'sourceInstance' IS DISTINCT FROM b.source_instance OR (p->>'sourceCutoff')::timestamptz IS DISTINCT FROM b.source_cutoff
 OR p->>'snapshotDigest' IS DISTINCT FROM b.snapshot_digest OR p->>'reviewerAcceptanceDigest' IS DISTINCT FROM b.acceptance_digest
 OR p->>'reviewerAcceptanceDigest' !~ '^[0-9a-f]{64}$' OR p->>'writerQuiescenceDigest' !~ '^[0-9a-f]{64}$' OR p->>'finalDeltaDigest' !~ '^[0-9a-f]{64}$'
 OR p->>'writerQuiescenceDigest' IS NULL OR p->>'finalDeltaDigest' IS NULL
 OR b.package_digest<>encode(sha256(convert_to('whaleu:school-uid-inventory:v1'||chr(10)||whaleu_community.content_canonical_json(p),'UTF8')),'hex')
 OR b.mapping_digest<>encode(sha256(convert_to('whaleu:school-uid-inventory:v1'||chr(10)||whaleu_community.content_canonical_json(jsonb_build_array(p->>'schoolCrosswalkDigest',p->>'accountCrosswalkDigest')),'UTF8')),'hex')
 OR b.writer_cutover_digest<>encode(sha256(convert_to('whaleu:school-uid-inventory:v1'||chr(10)||whaleu_community.content_canonical_json(jsonb_build_array(p->>'writerQuiescenceDigest',p->>'finalDeltaDigest')),'UTF8')),'hex')
 OR jsonb_array_length(p->'schools') NOT BETWEEN 1 AND 100 THEN RETURN false; END IF;
 SELECT x INTO s FROM jsonb_array_elements(p->'schools') x WHERE x->>'institutionId'=institution::text;
 IF s IS NULL OR (SELECT count(*) FROM jsonb_array_elements(p->'schools') x WHERE x->>'institutionId'=institution::text OR x->>'schoolCode'=s->>'schoolCode' OR x->>'sourceSchoolId'=s->>'sourceSchoolId')<>1
 OR s->>'classification' IS DISTINCT FROM classification OR s->>'schoolCode' !~ '^[0-9]{5}$'
 OR NOT EXISTS(SELECT 1 FROM whaleu_campus.school_identifiers m WHERE m.institution_id=institution AND m.school_code=s->>'schoolCode')
 OR s->>'trustedCeiling' IS NULL OR s->>'trustedCeiling' !~ '^(0|[1-9][0-9]{0,18})$'
 OR s->>'priorAdmittedFloor' !~ '^(0|[1-9][0-9]{0,18})$' OR s->>'ceilingJustificationDigest' IS NULL OR s->>'ceilingJustificationDigest' !~ '^[0-9a-f]{64}$'
 OR s->>'unknownHistoryBounded' IS DISTINCT FROM 'true' OR s->>'counterReset' IS DISTINCT FROM 'false'
 OR jsonb_array_length(s->'unresolvedConflicts')<>0 OR jsonb_array_length(s->'reservations')>100000
 THEN RETURN false; END IF;
 ceiling:=(s->>'trustedCeiling')::bigint;prior:=(s->>'priorAdmittedFloor')::bigint;
 FOR payload_row IN SELECT x FROM jsonb_array_elements(s->'reservations') x LOOP
  IF payload_row->'uid'->>'type' NOT IN('string','integer') OR jsonb_typeof(payload_row->'uid'->'value')<>'string'
   OR payload_row->'uid'->>'value' !~ '^[0-9]{1,19}$' OR payload_row->>'sourceSchoolId' IS DISTINCT FROM s->>'sourceSchoolId'
   OR (payload_row->>'accountId' IS NULL)<>(payload_row->>'sourceAccountId' IS NULL) THEN RETURN false; END IF;
  n:=(payload_row->'uid'->>'value')::bigint;IF n<=0 THEN RETURN false;END IF;observed:=greatest(observed,n);
 END LOOP;
 IF EXISTS(SELECT (x->'uid'->>'value')::bigint FROM jsonb_array_elements(s->'reservations') x GROUP BY (x->'uid'->>'value')::bigint HAVING count(DISTINCT x->>'accountId')>1)
 OR EXISTS(SELECT x->>'sourceAccountId' FROM jsonb_array_elements(s->'reservations') x WHERE x->>'sourceAccountId' IS NOT NULL GROUP BY x->>'sourceAccountId' HAVING count(DISTINCT x->>'accountId')>1)
 OR EXISTS(SELECT x->>'accountId' FROM jsonb_array_elements(s->'reservations') x WHERE x->>'accountId' IS NOT NULL GROUP BY x->>'accountId' HAVING count(DISTINCT x->>'sourceAccountId')>1)
 THEN RETURN false;END IF;
 IF EXISTS(SELECT x->>'accountId' FROM jsonb_array_elements(s->'reservations') x WHERE x->>'kind'='current' AND x->>'accountId' IS NOT NULL GROUP BY x->>'accountId' HAVING count(DISTINCT (x->'uid'->>'value')::bigint)>1)
 OR EXISTS(SELECT x->>'sourceAccountId' FROM jsonb_array_elements(s->'reservations') x WHERE x->>'kind'='current' AND x->>'sourceAccountId' IS NOT NULL GROUP BY x->>'sourceAccountId' HAVING count(DISTINCT (x->'uid'->>'value')::bigint)>1)
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(s->'accountCoverage','[]')) ac WHERE
  (SELECT count(*) FROM jsonb_array_elements(coalesce(s->'accountCoverage','[]')) other WHERE other->>'accountId'=ac->>'accountId' OR other->>'sourceAccountId'=ac->>'sourceAccountId')<>1
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(s->'reservations') r WHERE (r->>'accountId'=ac->>'accountId' OR r->>'sourceAccountId'=ac->>'sourceAccountId') AND (r->>'accountId' IS DISTINCT FROM ac->>'accountId' OR r->>'sourceAccountId' IS DISTINCT FROM ac->>'sourceAccountId'))
  OR (ac->>'status'='known_missing' AND EXISTS(SELECT 1 FROM jsonb_array_elements(s->'reservations') r WHERE r->>'kind'='current' AND (r->>'accountId'=ac->>'accountId' OR r->>'sourceAccountId'=ac->>'sourceAccountId')))
  OR (ac->>'status'='known_assigned' AND (SELECT count(DISTINCT (r->'uid'->>'value')::bigint) FROM jsonb_array_elements(s->'reservations') r WHERE r->>'kind'='current' AND r->>'accountId'=ac->>'accountId' AND r->>'sourceAccountId'=ac->>'sourceAccountId')<>1))
 THEN RETURN false;END IF;
 IF EXISTS(WITH mappings AS (
  SELECT item->>'sourceAccountId' source,item->>'accountId' account FROM jsonb_array_elements(p->'schools') school
  CROSS JOIN LATERAL (SELECT r item FROM jsonb_array_elements(school->'reservations') r UNION ALL SELECT ac item FROM jsonb_array_elements(coalesce(school->'accountCoverage','[]')) ac) all_rows
  WHERE item->>'sourceAccountId' IS NOT NULL AND item->>'accountId' IS NOT NULL),
  selected AS (SELECT item->>'sourceAccountId' source,item->>'accountId' account FROM (SELECT r item FROM jsonb_array_elements(s->'reservations') r UNION ALL SELECT ac item FROM jsonb_array_elements(coalesce(s->'accountCoverage','[]')) ac) all_rows)
  SELECT 1 FROM mappings m WHERE (EXISTS(SELECT 1 FROM selected x WHERE x.source=m.source) AND (SELECT count(DISTINCT other.account) FROM mappings other WHERE other.source=m.source)>1)
   OR (EXISTS(SELECT 1 FROM selected x WHERE x.account=m.account) AND (SELECT count(DISTINCT other.source) FROM mappings other WHERE other.account=m.account)>1))
 THEN RETURN false;END IF;
 IF jsonb_array_length(s->'trustedCounters')>100 OR (classification<>'known_new' AND jsonb_array_length(s->'trustedCounters')=0) THEN RETURN false;END IF;
 FOR payload_row IN SELECT x FROM jsonb_array_elements(s->'trustedCounters') x LOOP
  IF payload_row->>'type' NOT IN('string','integer') OR jsonb_typeof(payload_row->'value')<>'string' OR payload_row->>'value' !~ '^[0-9]{1,19}$' THEN RETURN false;END IF;
  n:=(payload_row->>'value')::bigint;IF n<observed THEN RETURN false;END IF;counter_max:=greatest(counter_max,n);
 END LOOP;
 IF ceiling<greatest(observed,counter_max,prior) OR floor<>ceiling THEN RETURN false;END IF;
 IF classification='known_new' AND (s->>'sourceEmptyVerified' IS DISTINCT FROM 'true' OR floor<>0 OR observed<>0 OR counter_max<>0 OR prior<>0 OR jsonb_array_length(s->'reservations')<>0) THEN RETURN false;END IF;
 RETURN true;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR invalid_parameter_value THEN RETURN false;
END $$;
CREATE FUNCTION whaleu_school_uid.admission_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE h whaleu_school_uid.admission_heads;b whaleu_school_uid.inventory_batches;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('whaleu:school-uid-admission:v1:'||NEW.institution_id::text,0));
 SELECT * INTO h FROM whaleu_school_uid.admission_heads WHERE institution_id=NEW.institution_id FOR UPDATE;
 SELECT * INTO b FROM whaleu_school_uid.inventory_batches WHERE id=NEW.batch_id;
 IF whaleu_school_uid.synthetic_database() IS DISTINCT FROM true OR b.id IS NULL OR b.classification<>'synthetic' OR NOT isfinite(b.source_cutoff) OR b.source_cutoff>clock_timestamp()
 OR whaleu_school_uid.synthetic_school_valid(b,NEW.institution_id,NEW.reserved_floor,NEW.classification) IS DISTINCT FROM true
 OR NEW.issuance_available IS DISTINCT FROM coalesce((SELECT (x->>'issuanceAvailable')::boolean FROM jsonb_array_elements(b.manifest->'package'->'schools') x WHERE x->>'institutionId'=NEW.institution_id::text),true)
 OR NEW.revision<>coalesce(h.revision,0)+1 OR (h.admission_id IS NOT NULL AND NEW.reserved_floor<(SELECT reserved_floor FROM whaleu_school_uid.school_admissions WHERE id=h.admission_id))
 OR (NEW.classification='known_new' AND (NEW.reserved_floor<>0 OR h.institution_id IS NOT NULL))
 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(b.manifest->'acceptedSchools') x WHERE x->>'institutionId'=NEW.institution_id::text AND x->>'reservedFloor'=NEW.reserved_floor::text AND x->>'classification'=NEW.classification AND (x->>'issuanceAvailable')::boolean=NEW.issuance_available)
 THEN RAISE EXCEPTION 'UID admission requires accepted bounded synthetic inventory' USING ERRCODE='23514'; END IF;
 NEW.creation_transaction:=pg_current_xact_id();NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER admission_insert BEFORE INSERT ON whaleu_school_uid.school_admissions FOR EACH ROW EXECUTE FUNCTION whaleu_school_uid.admission_insert();
CREATE FUNCTION whaleu_school_uid.admit_counter() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous bigint;next_value bigint;
BEGIN
 SELECT high_water INTO previous FROM whaleu_school_uid.admission_heads WHERE institution_id=NEW.institution_id FOR UPDATE;
 next_value:=greatest(coalesce(previous,0),NEW.reserved_floor);
 INSERT INTO whaleu_school_uid.admission_heads(institution_id,admission_id,revision,high_water) VALUES(NEW.institution_id,NEW.id,NEW.revision,next_value)
 ON CONFLICT(institution_id) DO UPDATE SET admission_id=excluded.admission_id,revision=excluded.revision,high_water=excluded.high_water;
 INSERT INTO whaleu_school_uid.counter_transitions(institution_id,admission_id,old_value,new_value,kind) VALUES(NEW.institution_id,NEW.id,previous,next_value,'admission');RETURN NULL;
END $$;
CREATE TRIGGER admit_counter AFTER INSERT ON whaleu_school_uid.school_admissions FOR EACH ROW EXECUTE FUNCTION whaleu_school_uid.admit_counter();
CREATE FUNCTION whaleu_school_uid.event_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c whaleu_school_uid.producing_causes;h whaleu_school_uid.account_heads;
BEGIN
 SELECT * INTO c FROM whaleu_school_uid.producing_causes WHERE id=NEW.cause_id;
 SELECT * INTO h FROM whaleu_school_uid.account_heads WHERE account_id=NEW.account_id;
 IF c.kind='imported' THEN
  IF whaleu_school_uid.import_source_valid(c) IS DISTINCT FROM true OR whaleu_school_uid.affiliation_current(c) IS DISTINCT FROM true OR h.allocation_id IS NOT NULL
   OR NEW.revision<>coalesce(h.revision,0)+1 OR NEW.previous_allocation_id IS NOT NULL
   OR (c.account_id,c.institution_id,c.affiliation_assertion_id,c.snapshot_id)<>(NEW.account_id,NEW.institution_id,NEW.affiliation_assertion_id,NEW.snapshot_id)
   OR NOT EXISTS(SELECT 1 FROM whaleu_school_uid.import_sources im WHERE im.id=c.source_id AND ((im.mode='current' AND NEW.outcome='imported' AND EXISTS(SELECT 1 FROM whaleu_school_uid.allocations al WHERE al.id=NEW.resulting_allocation_id AND al.cause_id=c.id)) OR (im.mode='covered_missing' AND NEW.outcome='covered_missing' AND NEW.resulting_allocation_id IS NULL)))
   THEN RAISE EXCEPTION 'Imported current assignment requires exact admitted current affiliation and owner' USING ERRCODE='23514';END IF;
  NEW.creation_transaction:=pg_current_xact_id();NEW.created_at:=clock_timestamp();RETURN NEW;
 END IF;
 IF c.id IS NULL OR c.kind='unchanged' OR c.creation_transaction<>pg_current_xact_id() OR (c.account_id,c.institution_id,c.affiliation_assertion_id,c.snapshot_id)<>(NEW.account_id,NEW.institution_id,NEW.affiliation_assertion_id,NEW.snapshot_id)
 OR whaleu_school_uid.affiliation_current(c) IS DISTINCT FROM true OR NEW.revision<>coalesce(h.revision,0)+1 OR NEW.previous_allocation_id IS DISTINCT FROM h.allocation_id
 OR (NEW.outcome='issued' AND NOT EXISTS(SELECT 1 FROM whaleu_school_uid.allocations a WHERE a.id=NEW.resulting_allocation_id AND a.cause_id=c.id AND a.creation_transaction=pg_current_xact_id()))
 OR (NEW.outcome='retained' AND (h.allocation_id IS NULL OR h.institution_id<>NEW.institution_id OR NEW.resulting_allocation_id<>h.allocation_id))
 OR (NEW.outcome='deferred_unavailable' AND (c.kind<>'student_approval' OR h.allocation_id IS NOT NULL OR
  (NEW.unavailable_reason='inventory_unknown' AND (whaleu_school_uid.runtime_history_known(c) IS DISTINCT FROM true OR EXISTS(SELECT 1 FROM whaleu_school_uid.admission_heads ah JOIN whaleu_school_uid.school_admissions ad ON ad.id=ah.admission_id WHERE ah.institution_id=c.institution_id AND ad.issuance_available))) OR
  (NEW.unavailable_reason='account_history_unknown' AND whaleu_school_uid.runtime_history_known(c) IS TRUE)))
 THEN RAISE EXCEPTION 'UID event requires exact cause outcome and head predecessor' USING ERRCODE='23514'; END IF;
 NEW.creation_transaction:=pg_current_xact_id();NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER event_insert BEFORE INSERT ON whaleu_school_uid.assignment_events FOR EACH ROW EXECUTE FUNCTION whaleu_school_uid.event_insert();
CREATE FUNCTION whaleu_school_uid.head_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e whaleu_school_uid.assignment_events;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'UID heads cannot be deleted' USING ERRCODE='23514'; END IF;
 SELECT * INTO e FROM whaleu_school_uid.assignment_events WHERE id=NEW.event_id;
 IF e.id IS NULL OR e.creation_transaction<>pg_current_xact_id() OR (e.account_id,e.revision,e.institution_id,e.cause_id)<>(NEW.account_id,NEW.revision,NEW.institution_id,NEW.cause_id)
 OR e.resulting_allocation_id IS DISTINCT FROM NEW.allocation_id
 OR (TG_OP='INSERT' AND (NEW.revision<>1 OR e.previous_allocation_id IS NOT NULL))
 OR (TG_OP='UPDATE' AND (NEW.account_id<>OLD.account_id OR NEW.revision<>OLD.revision+1 OR e.previous_allocation_id IS DISTINCT FROM OLD.allocation_id))
 THEN RAISE EXCEPTION 'UID head requires exact new assignment event' USING ERRCODE='23514'; END IF;
 INSERT INTO whaleu_school_uid.head_transitions(cause_id,account_id,old_head,new_head) VALUES(NEW.cause_id,NEW.account_id,CASE WHEN TG_OP='UPDATE' THEN to_jsonb(OLD) ELSE NULL END,to_jsonb(NEW));RETURN NEW;
END $$;
CREATE TRIGGER head_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_school_uid.account_heads FOR EACH ROW EXECUTE FUNCTION whaleu_school_uid.head_guard();
-- Empty mutable-head writes cannot avoid row transition witnesses.
CREATE FUNCTION whaleu_school_uid.head_statement_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
 IF TG_OP='INSERT' THEN SELECT count(*) INTO n FROM inserted_heads; ELSE SELECT count(*) INTO n FROM updated_heads; END IF;
 IF n<>1 THEN RAISE EXCEPTION 'UID head statement must advance exactly one account' USING ERRCODE='23514'; END IF;RETURN NULL;
END $$;
CREATE TRIGGER head_insert_statement AFTER INSERT ON whaleu_school_uid.account_heads REFERENCING NEW TABLE AS inserted_heads FOR EACH STATEMENT EXECUTE FUNCTION whaleu_school_uid.head_statement_complete();
CREATE TRIGGER head_update_statement AFTER UPDATE ON whaleu_school_uid.account_heads REFERENCING NEW TABLE AS updated_heads FOR EACH STATEMENT EXECUTE FUNCTION whaleu_school_uid.head_statement_complete();
CREATE FUNCTION whaleu_school_uid.producing_cause_complete(cause_id uuid) RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
DECLARE c whaleu_school_uid.producing_causes;e whaleu_school_uid.assignment_events;h whaleu_school_uid.account_heads;
 a whaleu_school_uid.allocations;t whaleu_school_uid.head_transitions;cv whaleu_school_uid.account_coverage;o whaleu_school_uid.native_absence_observations;
BEGIN
 SELECT * INTO c FROM whaleu_school_uid.producing_causes WHERE id=cause_id;
 IF c.kind='imported' THEN RETURN whaleu_school_uid.imported_cause_complete(c.id);END IF;
 IF c.id IS NULL OR c.creation_transaction<>pg_current_xact_id() OR whaleu_school_uid.cause_source_valid(c) IS DISTINCT FROM true
 OR whaleu_school_uid.source_generation_complete(c.id) IS DISTINCT FROM true OR whaleu_school_uid.affiliation_current(c) IS DISTINCT FROM true
 OR NOT EXISTS(SELECT 1 FROM whaleu_identity.accounts WHERE id=c.account_id AND status='active')
 OR NOT EXISTS(SELECT 1 FROM whaleu_identity.accounts WHERE id=c.actor_account_id AND status='active') THEN RETURN false; END IF;
 SELECT * INTO e FROM whaleu_school_uid.assignment_events WHERE assignment_events.cause_id=c.id;
 IF c.kind='unchanged' THEN
  RETURN e.id IS NULL AND NOT EXISTS(SELECT 1 FROM whaleu_school_uid.allocations WHERE allocations.cause_id=c.id)
   AND NOT EXISTS(SELECT 1 FROM whaleu_school_uid.account_coverage WHERE account_coverage.cause_id=c.id)
   AND NOT EXISTS(SELECT 1 FROM whaleu_school_uid.head_transitions WHERE head_transitions.cause_id=c.id);
 END IF;
 SELECT * INTO h FROM whaleu_school_uid.account_heads WHERE account_id=c.account_id;
 SELECT * INTO t FROM whaleu_school_uid.head_transitions WHERE head_transitions.cause_id=c.id;
 IF e.id IS NULL OR e.creation_transaction<>c.creation_transaction OR h.event_id IS DISTINCT FROM e.id OR h.cause_id IS DISTINCT FROM c.id
 OR (e.account_id,e.institution_id,e.affiliation_assertion_id,e.snapshot_id)<>(c.account_id,c.institution_id,c.affiliation_assertion_id,c.snapshot_id)
 OR h.allocation_id IS DISTINCT FROM e.resulting_allocation_id OR h.revision<>e.revision OR h.institution_id<>c.institution_id
 OR t.cause_id IS NULL OR t.creation_transaction<>c.creation_transaction OR t.new_head IS DISTINCT FROM to_jsonb(h)
 OR coalesce((t.old_head->>'revision')::integer,0)+1<>h.revision
 OR (t.old_head->>'allocation_id')::uuid IS DISTINCT FROM e.previous_allocation_id THEN RETURN false; END IF;
 SELECT * INTO cv FROM whaleu_school_uid.account_coverage WHERE account_id=c.account_id;
 IF cv.id IS NOT NULL THEN
  IF whaleu_school_uid.coverage_valid(c.account_id) IS DISTINCT FROM true THEN RETURN false;END IF;
  IF cv.cause_id=c.id AND cv.kind='native_absence' THEN
   SELECT * INTO o FROM whaleu_school_uid.native_absence_observations WHERE id=cv.observation_id;
   IF o.id IS NULL OR o.creation_transaction<>c.creation_transaction OR o.native_proof IS DISTINCT FROM whaleu_school_uid.native_identity_proof(c.account_id)
    OR o.history_proof IS DISTINCT FROM whaleu_school_uid.account_history_proof(c.account_id,c.id) THEN RETURN false; END IF;
  END IF;
 END IF;
 IF e.outcome='issued' THEN
  SELECT * INTO a FROM whaleu_school_uid.allocations WHERE id=e.resulting_allocation_id AND allocations.cause_id=c.id;
  IF whaleu_school_uid.runtime_history_known(c) IS DISTINCT FROM true OR cv.id IS NULL OR a.id IS NULL OR a.creation_transaction<>c.creation_transaction OR a.predecessor_allocation_id IS DISTINCT FROM e.previous_allocation_id
   OR NOT EXISTS(SELECT 1 FROM whaleu_school_uid.counter_transitions ct JOIN whaleu_school_uid.admission_heads ah ON ah.institution_id=ct.institution_id
    JOIN whaleu_school_uid.school_admissions ad ON ad.id=a.admission_id
    WHERE ct.allocation_id=a.id AND ct.kind='allocation' AND ct.creation_transaction=c.creation_transaction
     AND ct.institution_id=c.institution_id AND ct.admission_id=a.admission_id AND ct.new_value=a.uid AND ct.old_value=a.uid-1
     AND ah.high_water=a.uid AND ah.admission_id=a.admission_id AND ad.issuance_available AND ad.institution_id=c.institution_id AND a.uid>ad.reserved_floor)
   THEN RETURN false; END IF;
 ELSIF e.outcome='retained' THEN
  IF whaleu_school_uid.runtime_history_known(c) IS DISTINCT FROM true OR cv.id IS NULL OR e.previous_allocation_id IS NULL OR e.resulting_allocation_id IS DISTINCT FROM e.previous_allocation_id
   OR NOT EXISTS(SELECT 1 FROM whaleu_school_uid.allocations al JOIN whaleu_school_uid.school_admissions ad ON ad.id=al.admission_id WHERE al.id=e.resulting_allocation_id AND al.account_id=c.account_id AND al.institution_id=c.institution_id AND ad.institution_id=c.institution_id AND ((al.uid>ad.reserved_floor AND EXISTS(SELECT 1 FROM whaleu_school_uid.producing_causes pc WHERE pc.id=al.cause_id AND pc.kind<>'imported')) OR (al.uid<=ad.reserved_floor AND EXISTS(SELECT 1 FROM whaleu_school_uid.producing_causes pc WHERE pc.id=al.cause_id AND pc.kind='imported'))))
   OR EXISTS(SELECT 1 FROM whaleu_school_uid.allocations WHERE allocations.cause_id=c.id) THEN RETURN false; END IF;
 ELSE
  IF c.kind<>'student_approval' OR e.resulting_allocation_id IS NOT NULL OR e.previous_allocation_id IS NOT NULL
   OR EXISTS(SELECT 1 FROM whaleu_school_uid.allocations WHERE allocations.cause_id=c.id)
   OR (e.unavailable_reason='inventory_unknown' AND (whaleu_school_uid.runtime_history_known(c) IS DISTINCT FROM true OR EXISTS(SELECT 1 FROM whaleu_school_uid.admission_heads ah JOIN whaleu_school_uid.school_admissions ad ON ad.id=ah.admission_id WHERE ah.institution_id=c.institution_id AND ad.issuance_available)))
   OR (e.unavailable_reason='account_history_unknown' AND whaleu_school_uid.runtime_history_known(c) IS TRUE) THEN RETURN false; END IF;
 END IF;
 IF c.kind='student_approval' THEN
  RETURN EXISTS(SELECT 1 FROM whaleu_school_uid.issuance_decisions d WHERE d.student_decision_id=c.source_id AND d.cause_id=c.id AND d.event_id=e.id AND d.outcome=e.outcome AND d.unavailable_reason IS NOT DISTINCT FROM e.unavailable_reason AND d.creation_transaction=c.creation_transaction);
 END IF;
 RETURN NOT EXISTS(SELECT 1 FROM whaleu_school_uid.issuance_decisions d WHERE d.cause_id=c.id);
END $$;
CREATE FUNCTION whaleu_school_uid.require_cause_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE selected uuid;
BEGIN
 IF TG_TABLE_NAME='producing_causes' THEN selected:=NEW.id; ELSE selected:=NEW.cause_id; END IF;
 -- Noncooperating mapping/history writers cannot race a final absence claim.
 LOCK TABLE whaleu_identity.legacy_account_mappings,whaleu_school_uid.account_coverage,
  whaleu_school_uid.allocations,whaleu_school_uid.assignment_events,whaleu_school_uid.account_heads,
  whaleu_school_uid.admission_heads,whaleu_school_uid.school_admissions,whaleu_verification.native_enrollments
  IN SHARE MODE NOWAIT;
 IF whaleu_school_uid.producing_cause_complete(selected) IS DISTINCT FROM true THEN RAISE EXCEPTION 'School UID cause graph is incomplete or no longer authorized' USING ERRCODE='23514'; END IF;RETURN NULL;
END $$;
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['producing_causes','account_coverage','allocations','assignment_events','account_heads','issuance_decisions','head_transitions'] LOOP
  EXECUTE format('CREATE CONSTRAINT TRIGGER uid_cause_complete AFTER INSERT OR UPDATE ON whaleu_school_uid.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_school_uid.require_cause_complete()',tab);
 END LOOP;
END $$;
CREATE FUNCTION whaleu_school_uid.student_decision_complete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.decision='approved' THEN
  IF (SELECT count(*) FROM whaleu_school_uid.issuance_decisions i JOIN whaleu_school_uid.producing_causes c ON c.id=i.cause_id
      WHERE i.student_decision_id=NEW.id AND c.kind='student_approval' AND c.source_id=NEW.id AND c.account_id=NEW.account_id
       AND c.actor_account_id=NEW.actor_account_id AND c.institution_id=NEW.institution_id AND c.affiliation_assertion_id=NEW.assertion_id
       AND c.snapshot_id=NEW.snapshot_id AND c.creation_transaction=NEW.creation_transaction AND whaleu_school_uid.producing_cause_complete(c.id))<>1
  THEN RAISE EXCEPTION 'Each new approved student decision requires exactly one valid UID outcome' USING ERRCODE='23514'; END IF;
 ELSE
  IF EXISTS(SELECT 1 FROM whaleu_school_uid.issuance_decisions WHERE student_decision_id=NEW.id)
   OR EXISTS(SELECT 1 FROM whaleu_school_uid.producing_causes WHERE kind='student_approval' AND source_id=NEW.id)
  THEN RAISE EXCEPTION 'Rejected student decisions cannot produce UIDs' USING ERRCODE='23514'; END IF;
 END IF;RETURN NULL;
END $$;
-- Prospective only. Old approved decision/receipt bytes remain untouched.
CREATE CONSTRAINT TRIGGER school_uid_student_decision_complete AFTER INSERT ON whaleu_verification.student_decisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_school_uid.student_decision_complete();
CREATE FUNCTION whaleu_school_uid.admission_complete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM whaleu_school_uid.admission_heads h JOIN whaleu_school_uid.counter_transitions t ON t.admission_id=NEW.id AND t.kind='admission'
  WHERE h.institution_id=NEW.institution_id AND h.admission_id=NEW.id AND h.revision=NEW.revision AND h.high_water>=NEW.reserved_floor
   AND t.creation_transaction=NEW.creation_transaction AND t.new_value=greatest(coalesce(t.old_value,0),NEW.reserved_floor))
 THEN RAISE EXCEPTION 'UID admission lacks its exact monotone counter transition' USING ERRCODE='23514'; END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER uid_admission_complete AFTER INSERT ON whaleu_school_uid.school_admissions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_school_uid.admission_complete();
CREATE FUNCTION whaleu_school_uid.current_uid_fact(target uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object('coverage',(SELECT to_jsonb(cv) FROM whaleu_school_uid.account_coverage cv WHERE cv.account_id=target),
  'legacyMapped',EXISTS(SELECT 1 FROM whaleu_identity.legacy_account_mappings WHERE account_id=target),
  'head',to_jsonb(h),'event',to_jsonb(e),'allocation',CASE WHEN a.id IS NULL THEN NULL ELSE to_jsonb(a)||jsonb_build_object('uid',a.uid::text) END,
  'admission',CASE WHEN ad.id IS NULL THEN NULL ELSE to_jsonb(ad)||jsonb_build_object('reserved_floor',ad.reserved_floor::text) END,
  'verificationHead',to_jsonb(vh),'snapshot',to_jsonb(s),'affiliation',to_jsonb(af),'expiresExact',af.expires_at::text)
 FROM whaleu_identity.accounts ac LEFT JOIN whaleu_school_uid.account_heads h ON h.account_id=ac.id
 LEFT JOIN whaleu_school_uid.assignment_events e ON (e.id,e.account_id,e.revision)=(h.event_id,h.account_id,h.revision)
 LEFT JOIN whaleu_school_uid.allocations a ON (a.id,a.account_id,a.institution_id)=(h.allocation_id,h.account_id,h.institution_id)
 LEFT JOIN whaleu_school_uid.school_admissions ad ON ad.id=a.admission_id AND ad.institution_id=a.institution_id
 LEFT JOIN whaleu_verification.account_heads vh ON vh.account_id=ac.id
 LEFT JOIN whaleu_verification.snapshots s ON (s.id,s.account_id,s.revision)=(vh.snapshot_id,vh.account_id,vh.revision)
 LEFT JOIN whaleu_verification.assertions af ON (af.id,af.account_id)=(s.affiliation_assertion_id,s.account_id)
 WHERE ac.id=target AND ac.status='active'
$$;
-- Synthetic admission is unavailable on production databases even to raw SQL.
CREATE FUNCTION whaleu_school_uid.synthetic_database() RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT current_database()='whaleu_test' AND (inet_server_addr() IS NULL OR inet_server_addr() <<= inet '127.0.0.0/8' OR inet_server_addr()=inet '::1')
$$;
CREATE FUNCTION whaleu_school_uid.mapping_proof(target uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.source_system,m.legacy_id),'[]') FROM whaleu_identity.legacy_account_mappings m WHERE m.account_id=target
$$;
CREATE FUNCTION whaleu_school_uid.coverage_valid(target uuid) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE cv whaleu_school_uid.account_coverage;b whaleu_school_uid.inventory_batches;o whaleu_school_uid.native_absence_observations;
BEGIN
 SELECT * INTO cv FROM whaleu_school_uid.account_coverage WHERE account_id=target;
 IF cv.id IS NULL THEN RETURN false;END IF;
 IF cv.kind='native_absence' THEN
  SELECT * INTO o FROM whaleu_school_uid.native_absence_observations WHERE id=cv.observation_id;
  RETURN o.id IS NOT NULL AND o.account_id=target AND o.native_proof IS NOT NULL
   AND whaleu_school_uid.native_identity_proof(target) IS NOT NULL AND o.native_proof IS NOT DISTINCT FROM whaleu_school_uid.native_identity_proof(target)
   AND NOT EXISTS(SELECT 1 FROM whaleu_identity.legacy_account_mappings WHERE account_id=target);
 END IF;
 SELECT * INTO b FROM whaleu_school_uid.inventory_batches WHERE id=cv.batch_id;
 RETURN b.id IS NOT NULL AND b.classification='synthetic' AND cv.mapping_proof=whaleu_school_uid.mapping_proof(target)
  AND EXISTS(SELECT 1 FROM whaleu_identity.legacy_account_mappings m WHERE m.account_id=target AND m.source_system=b.source_instance AND m.legacy_id=cv.source_account_id)
  AND NOT EXISTS(SELECT 1 FROM whaleu_verification.native_enrollments WHERE account_id=target)
  AND EXISTS(SELECT 1 FROM whaleu_school_uid.import_sources im JOIN whaleu_school_uid.producing_causes c ON c.id=im.cause_id WHERE c.id=cv.cause_id AND c.kind='imported' AND im.batch_id=cv.batch_id AND im.account_id=target AND im.mapping_proof=cv.mapping_proof);
END $$;
CREATE FUNCTION whaleu_school_uid.allocation_valid(allocation uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM whaleu_school_uid.allocations a JOIN whaleu_school_uid.school_admissions ad ON (ad.id,ad.institution_id)=(a.admission_id,a.institution_id)
 JOIN whaleu_school_uid.inventory_batches b ON b.id=ad.batch_id JOIN whaleu_school_uid.producing_causes c ON (c.id,c.account_id,c.institution_id)=(a.cause_id,a.account_id,a.institution_id)
 WHERE a.id=allocation AND b.classification='synthetic' AND c.creation_transaction=a.creation_transaction AND
 ((c.kind<>'imported' AND a.uid>ad.reserved_floor AND EXISTS(SELECT 1 FROM whaleu_school_uid.counter_transitions ct WHERE ct.allocation_id=a.id AND ct.kind='allocation' AND ct.old_value=a.uid-1 AND ct.new_value=a.uid AND ct.creation_transaction=a.creation_transaction))
 OR(c.kind='imported' AND a.uid<=ad.reserved_floor AND EXISTS(SELECT 1 FROM whaleu_school_uid.import_sources im WHERE im.id=c.source_id AND im.cause_id=c.id AND im.account_id=a.account_id AND im.institution_id=a.institution_id AND im.uid=a.uid AND im.creation_transaction=a.creation_transaction))))
$$;
CREATE FUNCTION whaleu_school_uid.assignment_matches_snapshot(target uuid,snapshot uuid,head jsonb) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT EXISTS(SELECT 1 FROM whaleu_school_uid.assignment_events e JOIN whaleu_school_uid.allocations a ON (a.id,a.account_id,a.institution_id)=(e.resulting_allocation_id,e.account_id,e.institution_id)
 JOIN whaleu_verification.snapshots sn ON sn.id=snapshot AND sn.account_id=target JOIN whaleu_verification.assertions af ON (af.id,af.account_id)=(sn.affiliation_assertion_id,sn.account_id)
 WHERE head->>'account_id'=target::text AND e.id::text=head->>'event_id' AND e.account_id=target AND e.revision=(head->>'revision')::integer
 AND a.id::text=head->>'allocation_id' AND a.institution_id::text=head->>'institution_id' AND e.cause_id::text=head->>'cause_id'
 AND e.affiliation_assertion_id=af.id AND a.institution_id=af.issuer_institution_id AND whaleu_school_uid.allocation_valid(a.id)
 AND af.fact_kind='affiliation' AND af.assertion_state='verified' AND af.coverage_state='complete' AND af.provenance_state='accepted'
 AND af.source_account_id=target AND af.source_issuer_institution_id=af.issuer_institution_id AND af.origin_region_id IS NOT NULL
 AND af.method IN('document_review','institutional_email','institutional_sso','reconciled_import','administrator_correction')
 AND length(btrim(af.source_reference))>0 AND length(btrim(af.policy_reference))>0 AND isfinite(af.verified_at) AND af.verified_at<=clock_timestamp()
 AND ((af.expiry_kind='policy_exempt' AND af.expires_at IS NULL) OR (af.expiry_kind='at' AND isfinite(af.expires_at) AND af.expires_at>clock_timestamp() AND af.expires_at>af.verified_at)))
$$;
CREATE FUNCTION whaleu_school_uid.runtime_history_known(c whaleu_school_uid.producing_causes) RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
DECLARE cv whaleu_school_uid.account_coverage;head jsonb;old_school uuid;
BEGIN
 IF whaleu_school_uid.coverage_valid(c.account_id) IS DISTINCT FROM true THEN RETURN false;END IF;
 SELECT * INTO cv FROM whaleu_school_uid.account_coverage WHERE account_id=c.account_id;
 SELECT ht.old_head INTO head FROM whaleu_school_uid.head_transitions ht WHERE ht.cause_id=c.id;
 IF NOT FOUND THEN SELECT to_jsonb(h) INTO head FROM whaleu_school_uid.account_heads h WHERE h.account_id=c.account_id;END IF;
 IF head->>'allocation_id' IS NOT NULL THEN RETURN whaleu_school_uid.assignment_matches_snapshot(c.account_id,c.old_snapshot_id,head);END IF;
 IF cv.kind='native_absence' THEN RETURN true;END IF;
 SELECT af.issuer_institution_id INTO old_school FROM whaleu_verification.snapshots sn JOIN whaleu_verification.assertions af ON (af.id,af.account_id)=(sn.affiliation_assertion_id,sn.account_id)
 WHERE sn.id=c.old_snapshot_id AND sn.account_id=c.account_id AND af.fact_kind='affiliation' AND af.assertion_state='verified' AND af.coverage_state='complete' AND af.provenance_state='accepted'
 AND af.source_account_id=c.account_id AND af.source_issuer_institution_id=af.issuer_institution_id;
 -- Historical ownership alone never claims that the current assignment is absent.
 RETURN EXISTS(SELECT 1 FROM whaleu_school_uid.inventory_batches b JOIN whaleu_school_uid.school_admissions ad ON ad.batch_id=b.id AND ad.institution_id=old_school
 CROSS JOIN LATERAL jsonb_array_elements(b.manifest->'package'->'schools') sc
 CROSS JOIN LATERAL jsonb_array_elements(coalesce(sc->'accountCoverage','[]')) ac
 WHERE b.id=cv.batch_id AND sc->>'institutionId'=old_school::text AND ac->>'accountId'=c.account_id::text AND ac->>'sourceAccountId'=cv.source_account_id AND ac->>'status'='known_missing');
END $$;

CREATE FUNCTION whaleu_school_uid.completion_source_valid(c whaleu_school_uid.producing_causes) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
BEGIN
 IF whaleu_school_uid.coverage_valid(c.account_id) IS DISTINCT FROM true THEN RETURN false;END IF;
 -- Current exact approved cause, including approvals predating UID rollout.
 IF EXISTS(SELECT 1 FROM whaleu_verification.student_decisions d JOIN whaleu_verification.student_applications app ON app.id=d.application_id
  JOIN whaleu_verification.events ev ON ev.id=d.event_id AND ev.account_id=d.account_id
  JOIN whaleu_verification.snapshots sn ON sn.id=d.snapshot_id AND sn.account_id=d.account_id
  WHERE d.decision='approved' AND d.account_id=c.account_id AND d.institution_id=c.institution_id AND d.assertion_id=c.affiliation_assertion_id
   AND app.account_id=c.account_id AND app.state='approved' AND app.decision_id=d.id AND app.institution_id=c.institution_id
   AND ev.kind='student_decision' AND ev.fact_kind='affiliation' AND ev.actor_account_id=d.actor_account_id AND ev.snapshot_id=sn.id
   AND sn.affiliation_assertion_id=d.assertion_id AND sn.application_state='none' AND sn.application_coverage='complete') THEN RETURN true;END IF;
 -- Covered imported absence requires an exact admitted account crosswalk entry.
 RETURN EXISTS(SELECT 1 FROM whaleu_school_uid.account_coverage cv JOIN whaleu_school_uid.inventory_batches b ON b.id=cv.batch_id
  JOIN whaleu_school_uid.school_admissions ad ON ad.batch_id=b.id AND ad.institution_id=c.institution_id
  CROSS JOIN LATERAL jsonb_array_elements(b.manifest->'package'->'schools') sc
  CROSS JOIN LATERAL jsonb_array_elements(coalesce(sc->'accountCoverage','[]')) ac
  WHERE cv.account_id=c.account_id AND cv.kind='accepted_import' AND sc->>'institutionId'=c.institution_id::text
   AND ac->>'accountId'=c.account_id::text AND ac->>'sourceAccountId'=cv.source_account_id AND ac->>'status'='known_missing');
END $$;
CREATE FUNCTION whaleu_school_uid.import_source_valid(c whaleu_school_uid.producing_causes) RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
DECLARE im whaleu_school_uid.import_sources;b whaleu_school_uid.inventory_batches;ad whaleu_school_uid.school_admissions;sc jsonb;o whaleu_school_uid.native_absence_observations;
BEGIN
 SELECT * INTO im FROM whaleu_school_uid.import_sources WHERE id=c.source_id;
 SELECT * INTO b FROM whaleu_school_uid.inventory_batches WHERE id=im.batch_id;
 SELECT * INTO o FROM whaleu_school_uid.native_absence_observations WHERE id=im.observation_id;
 SELECT * INTO ad FROM whaleu_school_uid.school_admissions WHERE batch_id=im.batch_id AND institution_id=im.institution_id;
 IF whaleu_school_uid.synthetic_database() IS DISTINCT FROM true OR c.kind<>'imported' OR im.id IS NULL OR b.id IS NULL OR ad.id IS NULL
 OR o.id IS NULL OR o.account_id<>c.account_id OR o.creation_transaction<>im.creation_transaction OR o.native_proof IS NOT NULL
 OR im.initial_generation IS DISTINCT FROM o.initial_generation OR im.mapping_proof IS DISTINCT FROM o.history_proof->'mappings'
 OR im.cause_id<>c.id OR (im.account_id,im.institution_id)<>(c.account_id,c.institution_id) OR c.actor_account_id<>c.account_id
 OR im.creation_transaction<>pg_current_xact_id() OR c.creation_transaction<>im.creation_transaction OR b.classification<>'synthetic'
 OR im.mapping_proof IS DISTINCT FROM whaleu_school_uid.mapping_proof(c.account_id)
 OR NOT EXISTS(SELECT 1 FROM whaleu_identity.legacy_account_mappings m WHERE m.account_id=c.account_id AND m.source_system=b.source_instance AND m.legacy_id=im.source_account_id)
 OR EXISTS(SELECT 1 FROM whaleu_verification.native_enrollments WHERE account_id=c.account_id)
 OR NOT EXISTS(SELECT 1 FROM whaleu_identity.accounts WHERE id=c.account_id AND status='active')
 OR im.initial_generation<>whaleu_community.related_sync_generation_fingerprint('admission') THEN RETURN false;END IF;
 SELECT x INTO sc FROM jsonb_array_elements(b.manifest->'package'->'schools') x WHERE x->>'institutionId'=im.institution_id::text;
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(sc->'accountCoverage','[]')) x WHERE x->>'accountId'=im.account_id::text AND x->>'sourceAccountId'=im.source_account_id AND ((im.mode='covered_missing' AND x->>'status'='known_missing') OR (im.mode='current' AND x->>'status'='known_assigned') OR (im.mode='historical' AND x->>'status' IN('known_missing','known_assigned')))) THEN RETURN false;END IF;
 IF im.mode='covered_missing' THEN
  RETURN NOT EXISTS(SELECT 1 FROM jsonb_array_elements(sc->'reservations') x WHERE x->>'accountId'=im.account_id::text AND x->>'kind'='current');
 END IF;
 RETURN im.uid<=ad.reserved_floor AND EXISTS(SELECT 1 FROM jsonb_array_elements(sc->'reservations') x WHERE x->>'accountId'=im.account_id::text AND x->>'sourceAccountId'=im.source_account_id AND (x->'uid'->>'value')::bigint=im.uid
  AND ((im.mode='current' AND x->>'kind'='current') OR (im.mode='historical' AND x->>'kind' IN('historical','deleted','transferred','reserved'))));
END $$;
CREATE FUNCTION whaleu_school_uid.import_source_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o whaleu_school_uid.native_absence_observations;
BEGIN
 SELECT * INTO o FROM whaleu_school_uid.native_absence_observations WHERE id=NEW.observation_id;
 IF whaleu_school_uid.synthetic_database() IS DISTINCT FROM true OR o.id IS NULL OR o.account_id<>NEW.account_id
 OR o.creation_transaction<>pg_current_xact_id() OR o.native_proof IS NOT NULL
 OR o.initial_generation IS DISTINCT FROM whaleu_community.related_sync_generation_fingerprint('admission')
 OR o.history_proof IS DISTINCT FROM whaleu_school_uid.account_history_proof(NEW.account_id)
 THEN RAISE EXCEPTION 'Synthetic import requires exact server-captured pre-wait source observation' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('whaleu:school-uid-account:v1:'||NEW.account_id::text,0));
 NEW.initial_generation:=o.initial_generation;
 NEW.mapping_proof:=o.history_proof->'mappings';
 NEW.old_head:=nullif(o.history_proof->'head','null'::jsonb);
 NEW.creation_transaction:=pg_current_xact_id();NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER import_source_insert BEFORE INSERT ON whaleu_school_uid.import_sources FOR EACH ROW EXECUTE FUNCTION whaleu_school_uid.import_source_insert();
CREATE FUNCTION whaleu_school_uid.imported_cause_complete(cause_id uuid) RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
DECLARE c whaleu_school_uid.producing_causes;im whaleu_school_uid.import_sources;a whaleu_school_uid.allocations;e whaleu_school_uid.assignment_events;h whaleu_school_uid.account_heads;
BEGIN
 SELECT * INTO c FROM whaleu_school_uid.producing_causes WHERE id=cause_id;
 IF whaleu_school_uid.import_source_valid(c) IS DISTINCT FROM true OR whaleu_school_uid.coverage_valid(c.account_id) IS DISTINCT FROM true THEN RETURN false;END IF;
 SELECT * INTO im FROM whaleu_school_uid.import_sources WHERE id=c.source_id;
 IF NOT EXISTS(SELECT 1 FROM whaleu_school_uid.native_absence_observations o WHERE o.id=im.observation_id AND o.history_proof=whaleu_school_uid.account_history_proof(c.account_id,c.id)||jsonb_build_object('head',im.old_head)) THEN RETURN false;END IF;
 SELECT * INTO a FROM whaleu_school_uid.allocations WHERE allocations.cause_id=c.id;
 SELECT * INTO e FROM whaleu_school_uid.assignment_events WHERE assignment_events.cause_id=c.id;
 SELECT * INTO h FROM whaleu_school_uid.account_heads WHERE account_id=c.account_id;
 IF EXISTS(SELECT 1 FROM whaleu_school_uid.issuance_decisions WHERE issuance_decisions.cause_id=c.id)
 OR EXISTS(SELECT 1 FROM whaleu_school_uid.counter_transitions WHERE allocation_id=a.id) THEN RETURN false;END IF;
 IF im.mode='covered_missing' THEN
  IF a.id IS NOT NULL OR e.outcome IS DISTINCT FROM 'covered_missing' OR e.resulting_allocation_id IS NOT NULL THEN RETURN false;END IF;
 ELSE
  IF a.id IS NULL OR a.uid<>im.uid OR (a.account_id,a.institution_id)<>(im.account_id,im.institution_id)
   OR a.creation_transaction<>c.creation_transaction OR NOT EXISTS(SELECT 1 FROM whaleu_school_uid.school_admissions ad WHERE ad.id=a.admission_id AND ad.institution_id=im.institution_id AND a.uid<=ad.reserved_floor)
   THEN RETURN false;END IF;
  IF im.mode='historical' THEN RETURN e.id IS NULL AND (CASE WHEN h.account_id IS NULL THEN NULL ELSE to_jsonb(h) END) IS NOT DISTINCT FROM im.old_head AND NOT EXISTS(SELECT 1 FROM whaleu_school_uid.head_transitions WHERE head_transitions.cause_id=c.id);END IF;
  IF e.outcome IS DISTINCT FROM 'imported' OR e.resulting_allocation_id IS DISTINCT FROM a.id THEN RETURN false;END IF;
 END IF;
 RETURN coalesce(whaleu_school_uid.affiliation_current(c) AND h.event_id=e.id AND h.cause_id=c.id AND h.allocation_id IS NOT DISTINCT FROM e.resulting_allocation_id
  AND (e.account_id,e.institution_id,e.affiliation_assertion_id,e.snapshot_id)=(c.account_id,c.institution_id,c.affiliation_assertion_id,c.snapshot_id)
  AND e.creation_transaction=c.creation_transaction AND EXISTS(SELECT 1 FROM whaleu_school_uid.head_transitions ht WHERE ht.cause_id=c.id AND ht.creation_transaction=c.creation_transaction AND ht.old_head IS NOT DISTINCT FROM im.old_head AND ht.new_head=to_jsonb(h)),false);
END $$;
CREATE FUNCTION whaleu_school_uid.import_source_complete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 LOCK TABLE whaleu_identity.legacy_account_mappings,whaleu_school_uid.account_coverage,whaleu_school_uid.allocations,whaleu_school_uid.assignment_events,whaleu_school_uid.account_heads,whaleu_verification.account_heads,whaleu_verification.snapshots,whaleu_verification.assertions,whaleu_community.related_sync_admission_generation IN SHARE MODE NOWAIT;
 IF whaleu_school_uid.imported_cause_complete(NEW.cause_id) IS DISTINCT FROM true THEN RAISE EXCEPTION 'Imported UID evidence lacks its complete admitted owner effect' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER import_source_complete AFTER INSERT ON whaleu_school_uid.import_sources DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_school_uid.import_source_complete();

DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['inventory_batches','school_admissions','import_sources','native_absence_observations','producing_causes','account_coverage','allocations','assignment_events','issuance_decisions','counter_transitions','head_transitions'] LOOP
  EXECUTE format('CREATE TRIGGER uid_immutable_statement BEFORE UPDATE OR DELETE OR TRUNCATE ON whaleu_school_uid.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_school_uid.immutable_statement()',tab);
 END LOOP;
 FOREACH tab IN ARRAY ARRAY['account_heads','admission_heads'] LOOP
  EXECUTE format('CREATE TRIGGER uid_retain_heads BEFORE DELETE OR TRUNCATE ON whaleu_school_uid.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_school_uid.immutable_statement()',tab);
 END LOOP;
 FOREACH tab IN ARRAY ARRAY['inventory_batches','issuance_decisions'] LOOP
  EXECUTE format('CREATE TRIGGER uid_stamp BEFORE INSERT ON whaleu_school_uid.%I FOR EACH ROW EXECUTE FUNCTION whaleu_school_uid.stamp_insert()',tab);
 END LOOP;
END $$;
REVOKE ALL ON SCHEMA whaleu_school_uid FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA whaleu_school_uid FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA whaleu_school_uid FROM PUBLIC;
