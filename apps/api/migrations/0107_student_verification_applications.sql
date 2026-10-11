-- Document review issues affiliation only. Private evidence is owned by Media.
CREATE TABLE whaleu_verification.student_applications (
 id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id), client_request_id uuid NOT NULL,
 campus_id uuid NOT NULL REFERENCES whaleu_campus.campuses(id), institution_id uuid NOT NULL REFERENCES whaleu_campus.institutions(id),
 region_id uuid NOT NULL REFERENCES whaleu_campus.operating_regions(id), campus_version text NOT NULL CHECK(campus_version ~ '^[0-9a-f]{64}$'),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0), state text NOT NULL CHECK(state IN ('draft','pending','approved','rejected','withdrawn','expired')),
 evidence_id uuid, evidence_revision integer, evidence_expires_at timestamptz, evidence_policy_ref text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), submitted_at timestamptz, decision_id uuid,
 UNIQUE(account_id,client_request_id), UNIQUE(id,account_id),
 CHECK((evidence_id IS NULL AND evidence_revision IS NULL AND evidence_expires_at IS NULL AND evidence_policy_ref IS NULL) OR
 (evidence_id IS NOT NULL AND evidence_revision>0 AND evidence_expires_at IS NOT NULL AND char_length(evidence_policy_ref) BETWEEN 1 AND 200)),
 CHECK(state NOT IN ('pending','approved','rejected','expired') OR (evidence_id IS NOT NULL AND submitted_at IS NOT NULL)),
 CHECK((state IN ('approved','rejected'))=(decision_id IS NOT NULL))
);
CREATE UNIQUE INDEX student_application_one_open ON whaleu_verification.student_applications(account_id) WHERE state IN ('draft','pending');
CREATE INDEX student_application_review_queue ON whaleu_verification.student_applications(region_id,created_at,id) WHERE state='pending';
CREATE TABLE whaleu_verification.student_decisions (
 id uuid PRIMARY KEY, application_id uuid NOT NULL UNIQUE REFERENCES whaleu_verification.student_applications(id),
 account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id), actor_account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
 grant_id uuid NOT NULL REFERENCES whaleu_authorization.role_grants(id), client_request_id uuid NOT NULL, expected_revision integer NOT NULL CHECK(expected_revision>0),
 decision text NOT NULL CHECK(decision IN ('approved','rejected')), reason text,
 institution_id uuid NOT NULL REFERENCES whaleu_campus.institutions(id), region_id uuid NOT NULL REFERENCES whaleu_campus.operating_regions(id),
 evidence_digest text NOT NULL CHECK(evidence_digest ~ '^[0-9a-f]{64}$'), evidence_policy_ref text NOT NULL, evidence_expires_at timestamptz NOT NULL,
 policy_reference text NOT NULL CHECK(policy_reference='student-document-review/v1'), assertion_id uuid, snapshot_id uuid NOT NULL, event_id uuid NOT NULL, ledger_revision integer NOT NULL,
 decided_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(actor_account_id,client_request_id), CHECK(actor_account_id<>account_id),
 CHECK((decision='approved' AND reason IS NULL AND assertion_id IS NOT NULL) OR (decision='rejected' AND char_length(btrim(reason)) BETWEEN 1 AND 200 AND assertion_id IS NULL)), CHECK(evidence_expires_at>decided_at)
);
ALTER TABLE whaleu_verification.student_applications ADD FOREIGN KEY(decision_id) REFERENCES whaleu_verification.student_decisions(id) DEFERRABLE INITIALLY DEFERRED;
CREATE TRIGGER immutable_student_decision BEFORE UPDATE OR DELETE ON whaleu_verification.student_decisions FOR EACH ROW EXECUTE FUNCTION whaleu_verification.immutable_record();
CREATE TABLE whaleu_verification.student_requests (
 actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id), client_request_id uuid NOT NULL, application_id uuid NOT NULL REFERENCES whaleu_verification.student_applications(id),
 command_hash text NOT NULL CHECK(command_hash ~ '^[0-9a-f]{64}$'), receipt jsonb NOT NULL CHECK(jsonb_typeof(receipt)='object'), created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(actor_id,client_request_id)
);
CREATE TRIGGER immutable_student_request BEFORE UPDATE OR DELETE ON whaleu_verification.student_requests FOR EACH ROW EXECUTE FUNCTION whaleu_verification.immutable_record();
ALTER TABLE whaleu_verification.events DROP CONSTRAINT verification_event_kind;
ALTER TABLE whaleu_verification.events DROP CONSTRAINT verification_event_fact;
ALTER TABLE whaleu_verification.events ADD CONSTRAINT verification_event_kind CHECK(kind IN ('reconciled_snapshot','revoke','native_enrollment','phone_binding','student_application','student_decision'));
ALTER TABLE whaleu_verification.events ADD CONSTRAINT verification_event_fact CHECK((kind IN ('revoke','phone_binding') AND fact_kind IS NOT NULL) OR (kind='student_decision' AND (fact_kind IS NULL OR fact_kind='affiliation')) OR (kind IN ('reconciled_snapshot','native_enrollment','student_application') AND fact_kind IS NULL));
CREATE FUNCTION whaleu_verification.protect_student_application() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Student application history is retained'; END IF;
 IF NEW.id<>OLD.id OR NEW.account_id<>OLD.account_id OR NEW.client_request_id<>OLD.client_request_id OR NEW.campus_id<>OLD.campus_id OR NEW.institution_id<>OLD.institution_id OR NEW.region_id<>OLD.region_id OR NEW.campus_version<>OLD.campus_version OR NEW.created_at<>OLD.created_at OR NEW.revision<>OLD.revision+1 OR OLD.state NOT IN ('draft','pending') OR (OLD.state='draft' AND NEW.state NOT IN ('pending','withdrawn')) OR (OLD.state='pending' AND NEW.state NOT IN ('approved','rejected','withdrawn','expired')) OR (OLD.state='pending' AND (NEW.evidence_id IS DISTINCT FROM OLD.evidence_id OR NEW.evidence_revision IS DISTINCT FROM OLD.evidence_revision OR NEW.evidence_expires_at IS DISTINCT FROM OLD.evidence_expires_at OR NEW.evidence_policy_ref IS DISTINCT FROM OLD.evidence_policy_ref OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at)) THEN RAISE EXCEPTION 'Student application transition conflict'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER protect_student_application BEFORE UPDATE OR DELETE ON whaleu_verification.student_applications FOR EACH ROW EXECUTE FUNCTION whaleu_verification.protect_student_application();
CREATE FUNCTION whaleu_verification.student_document_assertion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.policy_reference='student-document-review/v1' AND NEW.assertion_state='verified' AND NOT EXISTS(SELECT 1 FROM whaleu_verification.student_decisions d WHERE NEW.source_reference='student_decision:'||d.id::text AND d.decision='approved' AND d.assertion_id=NEW.id AND d.account_id=NEW.account_id AND NEW.source_account_id=d.account_id AND NEW.fact_kind='affiliation' AND NEW.assertion_state='verified' AND NEW.coverage_state='complete' AND NEW.provenance_state='accepted' AND NEW.method='document_review' AND NEW.issuer_institution_id=d.institution_id AND NEW.source_issuer_institution_id=d.institution_id AND NEW.origin_region_id=d.region_id AND NEW.verified_at=d.decided_at AND NEW.expiry_kind='policy_exempt' AND NEW.expires_at IS NULL AND NEW.student_number IS NULL AND NEW.phone_binding_reference IS NULL) THEN RAISE EXCEPTION 'Document affiliation requires exact authorized decision'; END IF;
 IF NEW.policy_reference='student-document-review/v1' AND NEW.assertion_state<>'verified' AND (
 NEW.assertion_state NOT IN ('revoked','expired') OR NOT EXISTS(SELECT 1 FROM whaleu_verification.assertions a WHERE a.id=NEW.previous_assertion_id AND a.account_id=NEW.account_id AND a.fact_kind='affiliation' AND NEW.fact_kind='affiliation'
 AND a.method=NEW.method AND a.source_reference=NEW.source_reference AND a.policy_reference=NEW.policy_reference
 AND a.source_account_id=NEW.source_account_id AND a.issuer_institution_id=NEW.issuer_institution_id AND a.source_issuer_institution_id=NEW.source_issuer_institution_id AND a.origin_region_id=NEW.origin_region_id
 AND a.verified_at=NEW.verified_at AND a.expiry_kind=NEW.expiry_kind AND a.expires_at IS NOT DISTINCT FROM NEW.expires_at
 AND a.coverage_state=NEW.coverage_state AND a.provenance_state=NEW.provenance_state AND NEW.student_number IS NULL AND NEW.phone_binding_reference IS NULL)) THEN RAISE EXCEPTION 'Document revocation requires exact predecessor proof'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER student_document_assertion BEFORE INSERT ON whaleu_verification.assertions FOR EACH ROW EXECUTE FUNCTION whaleu_verification.student_document_assertion();
CREATE FUNCTION whaleu_verification.student_decision_complete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM whaleu_verification.student_applications a WHERE a.id=NEW.application_id AND a.account_id=NEW.account_id AND a.state=NEW.decision AND a.revision=NEW.expected_revision+1 AND a.decision_id=NEW.id AND a.institution_id=NEW.institution_id AND a.region_id=NEW.region_id AND a.evidence_policy_ref=NEW.evidence_policy_ref AND a.evidence_expires_at=NEW.evidence_expires_at)
 OR NOT EXISTS(SELECT 1 FROM whaleu_verification.events e JOIN whaleu_verification.snapshots s ON s.id=e.snapshot_id JOIN whaleu_verification.account_heads h ON h.account_id=e.account_id WHERE e.id=NEW.event_id AND e.account_id=NEW.account_id AND e.kind='student_decision' AND e.actor_account_id=NEW.actor_account_id AND e.snapshot_id=NEW.snapshot_id AND e.revision=NEW.ledger_revision AND h.revision=e.revision AND h.snapshot_id=s.id AND ((NEW.decision='approved' AND e.fact_kind='affiliation' AND s.affiliation_assertion_id=NEW.assertion_id AND s.application_state='none') OR (NEW.decision='rejected' AND e.fact_kind IS NULL AND s.application_state='rejected'))) THEN RAISE EXCEPTION 'Student decision requires exact complete ledger transition'; END IF;
 RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER student_decision_complete AFTER INSERT ON whaleu_verification.student_decisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_verification.student_decision_complete();
REVOKE ALL ON ALL TABLES IN SCHEMA whaleu_verification FROM PUBLIC;
-- An independent affiliation/application append must not discard a phone proof.
-- The claimed phone pointer, rather than the entire old snapshot, is the CAS fact.
CREATE OR REPLACE FUNCTION whaleu_verification.phone_proof_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r whaleu_verification.phone_requests; h whaleu_verification.account_heads; prior_phone uuid; current_phone uuid;
BEGIN
 SELECT * INTO r FROM whaleu_verification.phone_requests WHERE account_id=NEW.account_id AND request_id=NEW.request_id FOR UPDATE;
 SELECT * INTO h FROM whaleu_verification.account_heads WHERE account_id=NEW.account_id FOR UPDATE;
 SELECT phone_assertion_id INTO prior_phone FROM whaleu_verification.snapshots WHERE account_id=NEW.account_id AND revision=r.base_revision;
 SELECT phone_assertion_id INTO current_phone FROM whaleu_verification.snapshots WHERE account_id=NEW.account_id AND id=h.snapshot_id;
 IF h.account_id IS NULL OR (h.revision=0 AND (h.snapshot_id IS NOT NULL OR r.base_revision<>0)) OR (h.revision>0 AND (h.snapshot_id IS NULL OR NOT EXISTS(SELECT 1 FROM whaleu_verification.snapshots WHERE id=h.snapshot_id AND account_id=NEW.account_id AND revision=h.revision))) OR r.state IS DISTINCT FROM 'claimed' OR r.app_id IS DISTINCT FROM NEW.app_id OR clock_timestamp()>=r.claim_deadline
 OR NEW.creation_transaction<>pg_current_xact_id() OR NEW.revision<>h.revision+1 OR prior_phone IS DISTINCT FROM current_phone
 OR (r.base_revision>0 AND NOT EXISTS(SELECT 1 FROM whaleu_verification.snapshots WHERE account_id=NEW.account_id AND revision=r.base_revision))
 OR NEW.authorized_at>clock_timestamp()+interval '30 seconds' OR NEW.authorized_at<clock_timestamp()-interval '5 minutes'
 OR NEW.valid_until>clock_timestamp()+interval '366 days' THEN RAISE EXCEPTION 'Phone proof requires its exact live claimed phone pointer' USING ERRCODE='23514'; END IF;
 NEW.verified_at:=clock_timestamp(); RETURN NEW;
END $$;
-- Same-transaction, local-only notices. No external subscription/message provider.
ALTER TABLE whaleu_verification.student_applications ADD COLUMN transition_transaction xid8 NOT NULL DEFAULT pg_current_xact_id();
CREATE FUNCTION whaleu_verification.student_application_transition_xid() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.transition_transaction:=pg_current_xact_id(); RETURN NEW; END $$;
CREATE TRIGGER student_application_transition_xid BEFORE UPDATE ON whaleu_verification.student_applications FOR EACH ROW EXECUTE FUNCTION whaleu_verification.student_application_transition_xid();
CREATE TABLE whaleu_notifications.student_notice_owners(account_id uuid PRIMARY KEY REFERENCES whaleu_identity.accounts(id));
CREATE TABLE whaleu_notifications.student_notices(
 id uuid PRIMARY KEY, application_id uuid NOT NULL REFERENCES whaleu_verification.student_applications(id), revision integer NOT NULL CHECK(revision>0),
 recipient_account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id), recipient_grant_id uuid REFERENCES whaleu_authorization.role_grants(id),
 kind text NOT NULL CHECK(kind IN ('student_auth','auth_result')), outcome text NOT NULL CHECK(outcome IN ('pending','approved','rejected')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),read_at timestamptz,
 UNIQUE(application_id,revision,kind,recipient_account_id),
 CHECK((kind='student_auth' AND outcome='pending' AND recipient_grant_id IS NOT NULL) OR (kind='auth_result' AND outcome IN ('approved','rejected') AND recipient_grant_id IS NULL))
);
CREATE INDEX student_notices_owner ON whaleu_notifications.student_notices(recipient_account_id,created_at DESC,id DESC);
CREATE FUNCTION whaleu_notifications.student_notice_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='INSERT' THEN
 IF NOT EXISTS(SELECT 1 FROM whaleu_verification.student_applications a WHERE a.id=NEW.application_id AND a.revision=NEW.revision AND a.state=NEW.outcome AND a.transition_transaction=pg_current_xact_id() AND ((NEW.kind='auth_result' AND a.account_id=NEW.recipient_account_id) OR (NEW.kind='student_auth' AND a.account_id<>NEW.recipient_account_id AND EXISTS(SELECT 1 FROM whaleu_authorization.role_grants g WHERE g.id=NEW.recipient_grant_id AND g.account_id=NEW.recipient_account_id AND g.revoked_at IS NULL AND g.valid_from<=clock_timestamp() AND (g.expires_at IS NULL OR g.expires_at>clock_timestamp()) AND ((g.role='super_admin' AND g.operating_region_id IS NULL) OR (g.role='school_admin' AND g.operating_region_id=a.region_id)))))) THEN RAISE EXCEPTION 'Student notice requires current source and recipient'; END IF;
 RETURN NEW;
 END IF;
 IF TG_OP='DELETE' OR (NEW.id,NEW.application_id,NEW.revision,NEW.recipient_account_id,NEW.recipient_grant_id,NEW.kind,NEW.outcome,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.application_id,OLD.revision,OLD.recipient_account_id,OLD.recipient_grant_id,OLD.kind,OLD.outcome,OLD.created_at) OR (OLD.read_at IS NOT NULL AND NEW.read_at IS DISTINCT FROM OLD.read_at) OR NEW.read_at IS NULL THEN RAISE EXCEPTION 'Student notice history is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER student_notice_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_notifications.student_notices FOR EACH ROW EXECUTE FUNCTION whaleu_notifications.student_notice_guard();
REVOKE ALL ON whaleu_notifications.student_notice_owners,whaleu_notifications.student_notices FROM PUBLIC;
CREATE TABLE whaleu_verification.student_cancel_fences(actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),client_request_id uuid NOT NULL,command_hash text NOT NULL CHECK(command_hash ~ '^[0-9a-f]{64}$'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(actor_id,client_request_id));
CREATE TRIGGER immutable_student_cancel_fence BEFORE UPDATE OR DELETE ON whaleu_verification.student_cancel_fences FOR EACH ROW EXECUTE FUNCTION whaleu_verification.immutable_record();
REVOKE ALL ON whaleu_verification.student_cancel_fences FROM PUBLIC;
-- The approval issuer has a bounded native provenance source, not an arbitrary
-- document-review assertion constructor. Historical revocation uses predecessors.
ALTER TABLE whaleu_verification.student_decisions ADD COLUMN creation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id();
CREATE FUNCTION whaleu_verification.student_decision_origin_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a whaleu_verification.student_applications; g whaleu_authorization.role_grants;
BEGIN
 SELECT * INTO a FROM whaleu_verification.student_applications WHERE id=NEW.application_id FOR UPDATE;
 SELECT * INTO g FROM whaleu_authorization.role_grants WHERE id=NEW.grant_id FOR SHARE;
 IF a.id IS NULL OR a.state<>'pending' OR a.account_id<>NEW.account_id OR a.revision<>NEW.expected_revision OR a.institution_id<>NEW.institution_id OR a.region_id<>NEW.region_id
 OR a.evidence_policy_ref IS DISTINCT FROM NEW.evidence_policy_ref OR a.evidence_expires_at IS DISTINCT FROM NEW.evidence_expires_at OR a.evidence_expires_at<=clock_timestamp()
 OR NEW.creation_transaction<>pg_current_xact_id() OR NEW.actor_account_id=NEW.account_id
 OR g.id IS NULL OR g.account_id<>NEW.actor_account_id OR g.revoked_at IS NOT NULL OR g.valid_from>clock_timestamp() OR (g.expires_at IS NOT NULL AND g.expires_at<=clock_timestamp())
 OR NOT ((g.role='super_admin' AND g.operating_region_id IS NULL) OR (g.role='school_admin' AND g.operating_region_id=a.region_id AND (SELECT count(*) FROM whaleu_authorization.role_grants WHERE account_id=NEW.actor_account_id AND role='school_admin' AND operating_region_id IS NOT NULL AND revoked_at IS NULL AND valid_from<=clock_timestamp() AND (expires_at IS NULL OR expires_at>clock_timestamp()))=1))
 THEN RAISE EXCEPTION 'Student decision requires exact pending source and current review grant'; END IF;
 NEW.decided_at:=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER student_decision_origin_guard BEFORE INSERT ON whaleu_verification.student_decisions FOR EACH ROW EXECUTE FUNCTION whaleu_verification.student_decision_origin_guard();
