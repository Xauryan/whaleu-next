-- Covered absence only for a provably new native WeChat account. No backfill.
-- Existing/legacy accounts, even those lacking a head, retain unknown coverage.
ALTER TABLE whaleu_verification.assertions DROP CONSTRAINT assertions_method_check;
ALTER TABLE whaleu_verification.assertions ADD CONSTRAINT assertions_method_check
 CHECK(method IN ('document_review','institutional_email','institutional_sso','phone_provider','reconciled_import','native_enrollment','unknown'));
-- Replace only the two original event-kind checks; preserve revision/FK checks.
DO $$ DECLARE c record; BEGIN
 FOR c IN SELECT conname FROM pg_constraint
 WHERE conrelid='whaleu_verification.events'::regclass AND contype='c'
 AND pg_get_constraintdef(oid) LIKE '%reconciled_snapshot%'
 LOOP EXECUTE format('ALTER TABLE whaleu_verification.events DROP CONSTRAINT %I',c.conname); END LOOP;
END $$;
ALTER TABLE whaleu_verification.events ADD CONSTRAINT verification_event_kind
 CHECK(kind IN ('reconciled_snapshot','revoke','native_enrollment'));
ALTER TABLE whaleu_verification.events ADD CONSTRAINT verification_event_fact
 CHECK((kind='revoke' AND fact_kind IS NOT NULL) OR (kind IN ('reconciled_snapshot','native_enrollment') AND fact_kind IS NULL));

CREATE TABLE whaleu_verification.native_enrollments(
 account_id uuid PRIMARY KEY REFERENCES whaleu_identity.accounts(id),
 app_id text NOT NULL,
 operation_id uuid NOT NULL UNIQUE,
 affiliation_id uuid NOT NULL UNIQUE,
 student_number_id uuid NOT NULL UNIQUE,
 phone_id uuid NOT NULL UNIQUE,
 snapshot_id uuid NOT NULL UNIQUE,
 event_id uuid NOT NULL UNIQUE,
 creation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER immutable_native_enrollment BEFORE UPDATE OR DELETE ON whaleu_verification.native_enrollments
 FOR EACH ROW EXECUTE FUNCTION whaleu_verification.immutable_record();
CREATE FUNCTION whaleu_verification.native_enrollment_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 -- The identity owner stamps this xid on INSERT and forbids later changes (0022).
 PERFORM id FROM whaleu_identity.accounts WHERE id=NEW.account_id
  AND local_creation_transaction=pg_current_xact_id() AND status='active' FOR UPDATE;
 IF NOT FOUND OR NEW.creation_transaction<>pg_current_xact_id()
 OR NOT EXISTS(SELECT 1 FROM whaleu_identity.provider_identities WHERE account_id=NEW.account_id AND provider='wechat' AND app_id=NEW.app_id)
 OR EXISTS(SELECT 1 FROM whaleu_identity.legacy_account_mappings WHERE account_id=NEW.account_id)
 OR EXISTS(SELECT 1 FROM whaleu_verification.account_heads WHERE account_id=NEW.account_id)
 OR EXISTS(SELECT 1 FROM whaleu_verification.assertions WHERE account_id=NEW.account_id)
 OR EXISTS(SELECT 1 FROM whaleu_verification.snapshots WHERE account_id=NEW.account_id)
 OR EXISTS(SELECT 1 FROM whaleu_verification.events WHERE account_id=NEW.account_id)
 THEN RAISE EXCEPTION 'Native verification requires fresh identity creation without verification history' USING ERRCODE='23514'; END IF;
 NEW.created_at:=clock_timestamp(); RETURN NEW;
END $$;
CREATE TRIGGER native_enrollment_guard BEFORE INSERT ON whaleu_verification.native_enrollments
 FOR EACH ROW EXECUTE FUNCTION whaleu_verification.native_enrollment_guard();
CREATE FUNCTION whaleu_verification.native_assertion_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.method='native_enrollment' AND (
 NEW.assertion_state<>'unverified' OR NEW.coverage_state<>'complete' OR NEW.provenance_state<>'accepted'
 OR NEW.source_account_id IS DISTINCT FROM NEW.account_id
 OR NEW.source_reference IS DISTINCT FROM 'native_enrollment:'||NEW.account_id::text
 OR NEW.policy_reference IS DISTINCT FROM 'native-account-absence/v1'
 OR NEW.issuer_institution_id IS NOT NULL OR NEW.source_issuer_institution_id IS NOT NULL
 OR NEW.origin_region_id IS NOT NULL OR NEW.student_number IS NOT NULL
 OR NEW.phone_binding_reference IS NOT NULL OR NEW.verified_at IS NOT NULL
 OR NEW.expiry_kind<>'policy_exempt' OR NEW.expires_at IS NOT NULL OR NEW.previous_assertion_id IS NOT NULL
 OR NOT EXISTS(SELECT 1 FROM whaleu_verification.native_enrollments n WHERE n.account_id=NEW.account_id
  AND n.creation_transaction=pg_current_xact_id() AND NEW.id=CASE NEW.fact_kind
   WHEN 'affiliation' THEN n.affiliation_id WHEN 'student_number' THEN n.student_number_id WHEN 'phone' THEN n.phone_id END))
 THEN RAISE EXCEPTION 'Native enrollment asserts only exact covered absence' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER native_assertion_guard BEFORE INSERT ON whaleu_verification.assertions
 FOR EACH ROW EXECUTE FUNCTION whaleu_verification.native_assertion_guard();
CREATE FUNCTION whaleu_verification.native_enrollment_complete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM whaleu_identity.legacy_account_mappings WHERE account_id=NEW.account_id)
 OR NOT EXISTS(SELECT 1 FROM whaleu_identity.provider_identities WHERE account_id=NEW.account_id AND provider='wechat' AND app_id=NEW.app_id)
 OR (SELECT count(*) FROM whaleu_verification.assertions WHERE account_id=NEW.account_id)<>3
 OR (SELECT count(*) FROM whaleu_verification.snapshots WHERE account_id=NEW.account_id)<>1
 OR (SELECT count(*) FROM whaleu_verification.events WHERE account_id=NEW.account_id)<>1
 OR NOT EXISTS(SELECT 1 FROM whaleu_verification.snapshots s JOIN whaleu_verification.account_heads h
 ON (h.account_id,h.snapshot_id,h.revision)=(s.account_id,s.id,s.revision)
 WHERE s.account_id=NEW.account_id AND s.id=NEW.snapshot_id AND s.revision=1
 AND (s.affiliation_assertion_id,s.student_number_assertion_id,s.phone_assertion_id)=(NEW.affiliation_id,NEW.student_number_id,NEW.phone_id)
 AND s.application_state='none' AND s.application_coverage='complete')
 OR NOT EXISTS(SELECT 1 FROM whaleu_verification.events e WHERE e.id=NEW.event_id AND e.account_id=NEW.account_id
 AND e.operation_id=NEW.operation_id AND e.kind='native_enrollment' AND e.fact_kind IS NULL
 AND e.actor_account_id=NEW.account_id AND e.expected_revision=0 AND e.revision=1
 AND e.snapshot_id=NEW.snapshot_id AND e.reason_code='native_account_created')
 OR EXISTS(SELECT 1 FROM whaleu_verification.assertions WHERE account_id=NEW.account_id AND method<>'native_enrollment')
 THEN RAISE EXCEPTION 'Native verification enrollment is incomplete or has conflicting history' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER native_enrollment_complete AFTER INSERT ON whaleu_verification.native_enrollments
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_verification.native_enrollment_complete();
CREATE FUNCTION whaleu_verification.native_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.kind='native_enrollment' AND NOT EXISTS(SELECT 1 FROM whaleu_verification.native_enrollments n
 WHERE n.account_id=NEW.account_id AND n.event_id=NEW.id AND n.operation_id=NEW.operation_id
 AND n.snapshot_id=NEW.snapshot_id AND n.creation_transaction=pg_current_xact_id()
 AND NEW.actor_account_id=NEW.account_id AND NEW.expected_revision=0 AND NEW.revision=1
 AND NEW.reason_code='native_account_created')
 THEN RAISE EXCEPTION 'Native verification event requires identity creation cause' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER native_event_guard BEFORE INSERT ON whaleu_verification.events
 FOR EACH ROW EXECUTE FUNCTION whaleu_verification.native_event_guard();
REVOKE ALL ON whaleu_verification.native_enrollments FROM PUBLIC;

-- Single-use WeChat phone authorization: no code, token, number or number hash.
ALTER TABLE whaleu_verification.events DROP CONSTRAINT verification_event_kind;
ALTER TABLE whaleu_verification.events DROP CONSTRAINT verification_event_fact;
ALTER TABLE whaleu_verification.events ADD CONSTRAINT verification_event_kind CHECK(kind IN ('reconciled_snapshot','revoke','native_enrollment','phone_binding'));
ALTER TABLE whaleu_verification.events ADD CONSTRAINT verification_event_fact CHECK(
 (kind IN ('revoke','phone_binding') AND fact_kind IS NOT NULL) OR
 (kind IN ('reconciled_snapshot','native_enrollment') AND fact_kind IS NULL));
-- claimed_session_id is an audit UUID, not a retention FK: identity may purge old sessions.
CREATE TABLE whaleu_verification.phone_requests(
 account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),request_id uuid NOT NULL,
 app_id text NOT NULL,consent text NOT NULL CHECK(consent='wechat-phone-verification-v1'),
 replaces_request_id uuid,
 state text NOT NULL DEFAULT 'reserved' CHECK(state IN ('reserved','claimed','unknown','verified','closed')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 claimed_at timestamptz,claim_deadline timestamptz,claimed_session_id uuid,
 base_revision integer CHECK(base_revision>=0),
 PRIMARY KEY(account_id,request_id),
 FOREIGN KEY(account_id,replaces_request_id) REFERENCES whaleu_verification.phone_requests(account_id,request_id),
 CHECK(replaces_request_id IS NULL OR replaces_request_id<>request_id),
 CHECK((claimed_at IS NULL)=(claim_deadline IS NULL)),
 CHECK((claimed_at IS NULL)=(base_revision IS NULL)),
 CHECK((claimed_at IS NULL)=(claimed_session_id IS NULL))
);
CREATE UNIQUE INDEX phone_requests_one_active ON whaleu_verification.phone_requests(account_id) WHERE state IN ('reserved','claimed','unknown');
CREATE TABLE whaleu_verification.phone_proofs(
 id uuid PRIMARY KEY,account_id uuid NOT NULL,request_id uuid NOT NULL,app_id text NOT NULL,
 authorized_at timestamptz NOT NULL,verified_at timestamptz NOT NULL DEFAULT clock_timestamp(),valid_until timestamptz NOT NULL,
 assertion_id uuid NOT NULL UNIQUE,snapshot_id uuid NOT NULL UNIQUE,event_id uuid NOT NULL UNIQUE,
 revision integer NOT NULL CHECK(revision>0),creation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 UNIQUE(account_id,request_id),UNIQUE(id,account_id),
 FOREIGN KEY(account_id,request_id) REFERENCES whaleu_verification.phone_requests(account_id,request_id),
 CHECK(isfinite(authorized_at) AND isfinite(verified_at) AND isfinite(valid_until) AND valid_until>verified_at)
);
CREATE TRIGGER immutable_phone_proof BEFORE UPDATE OR DELETE ON whaleu_verification.phone_proofs FOR EACH ROW EXECUTE FUNCTION whaleu_verification.immutable_record();
CREATE FUNCTION whaleu_verification.phone_request_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Phone requests cannot be deleted' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'reserved' OR NEW.claimed_at IS NOT NULL OR
   NOT EXISTS(SELECT 1 FROM whaleu_identity.provider_identities WHERE account_id=NEW.account_id AND provider='wechat' AND app_id=NEW.app_id)
   OR (NEW.replaces_request_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM whaleu_verification.phone_requests WHERE account_id=NEW.account_id AND request_id=NEW.replaces_request_id AND state='closed'))
  THEN RAISE EXCEPTION 'Phone request requires current app identity and explicit new consent' USING ERRCODE='23514'; END IF;
  NEW.created_at:=clock_timestamp(); RETURN NEW;
 END IF;
 IF (NEW.account_id,NEW.request_id,NEW.app_id,NEW.consent,NEW.replaces_request_id,NEW.created_at)
 IS DISTINCT FROM (OLD.account_id,OLD.request_id,OLD.app_id,OLD.consent,OLD.replaces_request_id,OLD.created_at)
 OR OLD.state IN ('verified','closed') THEN RAISE EXCEPTION 'Phone request origin and terminal outcome are immutable' USING ERRCODE='23514'; END IF;
 IF OLD.state='reserved' AND NEW.state='claimed' THEN
  IF clock_timestamp()>=OLD.created_at+interval '5 minutes' OR NEW.base_revision IS NULL
   OR NOT EXISTS(SELECT 1 FROM whaleu_identity.sessions WHERE id=NEW.claimed_session_id AND account_id=NEW.account_id AND revoked_at IS NULL)
  THEN RAISE EXCEPTION 'Phone claim is unavailable' USING ERRCODE='23514'; END IF;
  NEW.claimed_at:=clock_timestamp(); NEW.claim_deadline:=NEW.claimed_at+interval '30 seconds'; RETURN NEW;
 END IF;
 IF (NEW.claimed_at,NEW.claim_deadline,NEW.claimed_session_id,NEW.base_revision)
 IS DISTINCT FROM (OLD.claimed_at,OLD.claim_deadline,OLD.claimed_session_id,OLD.base_revision)
 THEN RAISE EXCEPTION 'Phone claim cannot be replaced' USING ERRCODE='23514'; END IF;
 IF OLD.state='claimed' AND NEW.state='verified' AND clock_timestamp()<OLD.claim_deadline
 AND EXISTS(SELECT 1 FROM whaleu_verification.phone_proofs WHERE account_id=NEW.account_id AND request_id=NEW.request_id AND creation_transaction=pg_current_xact_id()) THEN RETURN NEW; END IF;
 IF OLD.state='claimed' AND NEW.state='unknown' THEN RETURN NEW; END IF;
 IF NEW.state='closed' AND (OLD.state IN ('reserved','unknown') OR (OLD.state='claimed' AND clock_timestamp()>=OLD.claim_deadline)) THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'Phone requests cannot replay a consumed authorization' USING ERRCODE='23514';
END $$;
CREATE TRIGGER phone_request_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_verification.phone_requests FOR EACH ROW EXECUTE FUNCTION whaleu_verification.phone_request_guard();
CREATE FUNCTION whaleu_verification.phone_proof_guard() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE r whaleu_verification.phone_requests; BEGIN
 SELECT * INTO r FROM whaleu_verification.phone_requests WHERE account_id=NEW.account_id AND request_id=NEW.request_id FOR UPDATE;
 IF r.state IS DISTINCT FROM 'claimed' OR r.app_id IS DISTINCT FROM NEW.app_id OR clock_timestamp()>=r.claim_deadline
 OR NEW.creation_transaction<>pg_current_xact_id() OR NEW.revision<>r.base_revision+1
 OR NEW.authorized_at>clock_timestamp()+interval '30 seconds' OR NEW.authorized_at<clock_timestamp()-interval '5 minutes'
 OR NEW.valid_until>clock_timestamp()+interval '366 days' THEN RAISE EXCEPTION 'Phone proof requires its exact live claimed request' USING ERRCODE='23514'; END IF;
 NEW.verified_at:=clock_timestamp(); RETURN NEW;
END $$;
CREATE TRIGGER phone_proof_guard BEFORE INSERT ON whaleu_verification.phone_proofs FOR EACH ROW EXECUTE FUNCTION whaleu_verification.phone_proof_guard();
CREATE FUNCTION whaleu_verification.phone_assertion_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (NEW.source_reference LIKE 'wechat_phone_request:%' OR EXISTS(SELECT 1 FROM whaleu_verification.phone_proofs WHERE id=NEW.phone_binding_reference)) AND NEW.assertion_state='verified' AND NOT EXISTS(
 SELECT 1 FROM whaleu_verification.phone_proofs p WHERE p.account_id=NEW.account_id AND p.id=NEW.phone_binding_reference
 AND p.assertion_id=NEW.id AND p.creation_transaction=pg_current_xact_id()
 AND NEW.source_reference='wechat_phone_request:'||p.request_id::text AND NEW.policy_reference='wechat-phone-authorization/v1'
 AND NEW.method='phone_provider' AND NEW.fact_kind='phone' AND NEW.assertion_state='verified'
 AND NEW.coverage_state='complete' AND NEW.provenance_state='accepted' AND NEW.source_account_id=NEW.account_id
 AND NEW.verified_at=p.verified_at AND NEW.expiry_kind='at' AND NEW.expires_at=p.valid_until)
 THEN RAISE EXCEPTION 'Phone assertion requires protected authorization proof' USING ERRCODE='23514'; END IF;
 IF (NEW.source_reference LIKE 'wechat_phone_request:%' OR EXISTS(SELECT 1 FROM whaleu_verification.phone_proofs WHERE id=NEW.phone_binding_reference)) AND NEW.assertion_state<>'verified' AND (
 NEW.assertion_state NOT IN ('revoked','expired') OR NOT EXISTS(SELECT 1 FROM whaleu_verification.assertions a
 WHERE a.id=NEW.previous_assertion_id AND a.account_id=NEW.account_id AND a.fact_kind='phone'
 AND a.method=NEW.method AND a.source_reference=NEW.source_reference AND a.policy_reference=NEW.policy_reference
 AND a.phone_binding_reference=NEW.phone_binding_reference AND a.verified_at=NEW.verified_at
 AND a.expires_at=NEW.expires_at AND NEW.expiry_kind=a.expiry_kind
 AND NEW.coverage_state=a.coverage_state AND NEW.provenance_state=a.provenance_state
 AND NEW.source_account_id=a.source_account_id))
 THEN RAISE EXCEPTION 'Phone revocation requires its original proof' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER phone_assertion_guard BEFORE INSERT ON whaleu_verification.assertions FOR EACH ROW EXECUTE FUNCTION whaleu_verification.phone_assertion_guard();
CREATE FUNCTION whaleu_verification.phone_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.kind='phone_binding' AND NOT EXISTS(SELECT 1 FROM whaleu_verification.phone_proofs p
 WHERE p.account_id=NEW.account_id AND p.request_id=NEW.operation_id AND p.event_id=NEW.id
 AND p.snapshot_id=NEW.snapshot_id AND p.revision=NEW.revision AND p.creation_transaction=pg_current_xact_id()
 AND NEW.fact_kind='phone' AND NEW.actor_account_id=NEW.account_id AND NEW.reason_code='wechat_phone_authorized')
 THEN RAISE EXCEPTION 'Phone event requires protected authorization proof' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER phone_event_guard BEFORE INSERT ON whaleu_verification.events FOR EACH ROW EXECUTE FUNCTION whaleu_verification.phone_event_guard();
CREATE FUNCTION whaleu_verification.phone_proof_complete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM whaleu_verification.phone_requests r WHERE r.account_id=NEW.account_id AND r.request_id=NEW.request_id AND r.state='verified')
 OR NOT EXISTS(SELECT 1 FROM whaleu_verification.assertions a WHERE a.id=NEW.assertion_id AND a.account_id=NEW.account_id AND a.phone_binding_reference=NEW.id)
 OR NOT EXISTS(SELECT 1 FROM whaleu_verification.snapshots s JOIN whaleu_verification.account_heads h
 ON (h.account_id,h.snapshot_id,h.revision)=(s.account_id,s.id,s.revision)
 WHERE s.id=NEW.snapshot_id AND s.account_id=NEW.account_id AND s.revision=NEW.revision AND s.phone_assertion_id=NEW.assertion_id)
 OR NOT EXISTS(SELECT 1 FROM whaleu_verification.events e WHERE e.id=NEW.event_id AND e.account_id=NEW.account_id AND e.operation_id=NEW.request_id AND e.kind='phone_binding' AND e.snapshot_id=NEW.snapshot_id)
 OR NOT EXISTS(SELECT 1 FROM whaleu_verification.snapshots s
 LEFT JOIN whaleu_verification.snapshots prior ON prior.account_id=s.account_id AND prior.revision=s.revision-1
 JOIN whaleu_verification.assertions a ON a.id=s.phone_assertion_id AND a.account_id=s.account_id
 WHERE s.id=NEW.snapshot_id AND s.account_id=NEW.account_id
 AND s.affiliation_assertion_id IS NOT DISTINCT FROM prior.affiliation_assertion_id
 AND s.student_number_assertion_id IS NOT DISTINCT FROM prior.student_number_assertion_id
 AND a.previous_assertion_id IS NOT DISTINCT FROM prior.phone_assertion_id
 AND s.application_state=coalesce(prior.application_state,'unavailable')
 AND s.application_coverage=coalesce(prior.application_coverage,'missing'))
 THEN RAISE EXCEPTION 'Phone verification publication is incomplete' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER phone_proof_complete AFTER INSERT ON whaleu_verification.phone_proofs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_verification.phone_proof_complete();
REVOKE ALL ON whaleu_verification.phone_requests,whaleu_verification.phone_proofs FROM PUBLIC;

CREATE INDEX phone_requests_recent ON whaleu_verification.phone_requests(account_id,created_at DESC);
