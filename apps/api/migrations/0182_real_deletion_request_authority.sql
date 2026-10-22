-- Real-account request/cause substrate. Production admission is write-closed.
-- The core never treats a test database name, Boolean or application_name as
-- owner coverage / old-reader retirement evidence. Test admission belongs to a
-- separately qualified test-only owner, not a branch in these production guards.
DO $$BEGIN
 IF NOT EXISTS(SELECT 1 FROM whaleu_meta.schema_migrations WHERE name='0181_identity_real_deletion_preparations.sql')
 OR to_regclass('whaleu_real_deletion.requests') IS NOT NULL
 OR to_regnamespace('whaleu_real_deletion_admission') IS NOT NULL THEN
  RAISE EXCEPTION 'Exact real preparation predecessor required' USING ERRCODE='23514';
 END IF;
END$$;
DO $predecessor$DECLARE marker jsonb;BEGIN
 IF (SELECT count(*) FROM pg_proc WHERE pronamespace='whaleu_real_deletion'::regnamespace AND proname IN ('preparation_catalog','preparation_protocol'))<>2
 OR NOT (SELECT count(*)=2 AND bool_and(p.pronargs=0 AND p.pronargdefaults=0 AND p.proargmodes IS NULL AND p.proallargtypes IS NULL AND p.proargdefaults IS NULL AND p.provariadic=0 AND p.prokind='f'
  AND p.prolang=(SELECT oid FROM pg_language WHERE lanname='sql') AND NOT p.proretset AND NOT p.prosecdef AND NOT p.proisstrict AND NOT p.proleakproof AND p.proparallel='u' AND p.prosupport=0 AND p.prosqlbody IS NULL AND p.probin IS NULL AND p.proconfig=ARRAY['search_path=pg_catalog']::text[]
  AND CASE WHEN p.oid=to_regprocedure('whaleu_real_deletion.preparation_catalog()') THEN p.provolatile='s' AND p.prorettype='text'::regtype AND octet_length(p.prosrc)<=16384 AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')='8e0098d98b9e0580a4170c752a19beaa9c57834fd511f649f22783d24dd2170b'
   ELSE p.provolatile='i' AND p.prorettype='jsonb'::regtype AND octet_length(p.prosrc)<=1024 AND p.prosrc ~ $pattern$^SELECT '[^']+'::jsonb$$pattern$ END)
  FROM pg_proc p WHERE p.oid IN (to_regprocedure('whaleu_real_deletion.preparation_catalog()'),to_regprocedure('whaleu_real_deletion.preparation_protocol()')))
 THEN RAISE EXCEPTION 'Exact preparation collector and inert literal marker required' USING ERRCODE='23514';END IF;
 marker:=whaleu_real_deletion.preparation_protocol();
 IF marker IS DISTINCT FROM jsonb_build_object('version',1,'protocol','real-account-deletion-preparation-v1','migration','0181_identity_real_deletion_preparations.sql','acceptance','unavailable','catalog',whaleu_real_deletion.preparation_catalog())
 OR marker->>'catalog' IS NULL THEN RAISE EXCEPTION 'Preparation predecessor seal drifted' USING ERRCODE='23514';END IF;
END$predecessor$;

-- A temporary bounded-history safety limit, not a lifetime deletion allowance.
-- Production activation additionally requires a receipt-preserving retention owner.
DO $qualify$BEGIN
 IF (SELECT count(*) FROM pg_proc WHERE pronamespace='whaleu_real_deletion'::regnamespace AND proname='preparation_guard')<>1
 OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('whaleu_real_deletion.preparation_guard()') AND p.pronargs=0 AND p.pronargdefaults=0
 AND p.proargmodes IS NULL AND p.proallargtypes IS NULL AND p.proargdefaults IS NULL AND p.provariadic=0
 AND p.prokind='f' AND p.prolang=(SELECT oid FROM pg_language WHERE lanname='plpgsql') AND p.prorettype='trigger'::regtype
 AND p.provolatile='v' AND NOT p.proretset AND NOT p.prosecdef AND NOT p.proisstrict AND NOT p.proleakproof
 AND p.proparallel='u' AND p.prosupport=0 AND p.prosqlbody IS NULL AND p.probin IS NULL AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND p.prosrc=$prior$
DECLARE a whaleu_identity.accounts%ROWTYPE; s whaleu_identity.sessions%ROWTYPE; at_time timestamptz; n integer;
BEGIN
 IF TG_OP='UPDATE' THEN
  RAISE EXCEPTION 'Real preparation identity is immutable' USING ERRCODE='23514';
 END IF;
 IF TG_OP='DELETE' THEN
  IF OLD.expires_at>clock_timestamp() THEN
   RAISE EXCEPTION 'Unexpired real preparation cannot be erased' USING ERRCODE='23514';
  END IF;
  RETURN OLD;
 END IF;
 SELECT * INTO a FROM whaleu_identity.accounts WHERE id=NEW.account_id FOR UPDATE NOWAIT;
 SELECT * INTO s FROM whaleu_identity.sessions WHERE id=NEW.session_id AND account_id=NEW.account_id FOR SHARE NOWAIT;
 at_time:=clock_timestamp();
 IF a.id IS NULL OR a.status<>'active' OR a.lifecycle<>'active' OR a.lifecycle_generation<>NEW.base_generation
   OR s.id IS NULL OR s.revoked_at IS NOT NULL OR s.absolute_expires_at<=at_time OR s.access_expires_at<=at_time
   OR s.issued_revocation_epoch<>a.session_revocation_epoch
   OR NOT EXISTS(SELECT 1 FROM whaleu_identity.provider_identities WHERE account_id=a.id AND provider='wechat' AND app_id=NEW.app_id) THEN
  RAISE EXCEPTION 'Real preparation requires current authenticated native identity' USING ERRCODE='23514';
 END IF;
 SELECT count(*) INTO n FROM(SELECT 1 FROM whaleu_real_deletion.preparations WHERE account_id=a.id AND expires_at>at_time LIMIT 4) bounded;
 IF n>=4 THEN RAISE EXCEPTION 'Real preparation budget exhausted' USING ERRCODE='23514'; END IF;
 NEW.created_at:=at_time;
 NEW.expires_at:=at_time+interval '900 seconds';
 NEW.created_transaction:=pg_current_xact_id();
 RETURN NEW;
END$prior$)
 THEN RAISE EXCEPTION 'Exact real authority predecessor mismatch: preparation_guard' USING ERRCODE='23514';END IF;
END$qualify$;
CREATE OR REPLACE FUNCTION whaleu_real_deletion.preparation_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $successor$
DECLARE a whaleu_identity.accounts%ROWTYPE; s whaleu_identity.sessions%ROWTYPE; at_time timestamptz; n integer;
BEGIN
 IF TG_OP='UPDATE' THEN
  RAISE EXCEPTION 'Real preparation identity is immutable' USING ERRCODE='23514';
 END IF;
 IF TG_OP='DELETE' THEN
  IF OLD.expires_at>clock_timestamp() THEN
   RAISE EXCEPTION 'Unexpired real preparation cannot be erased' USING ERRCODE='23514';
  END IF;
  RETURN OLD;
 END IF;
 SELECT * INTO a FROM whaleu_identity.accounts WHERE id=NEW.account_id FOR UPDATE NOWAIT;
 SELECT * INTO s FROM whaleu_identity.sessions WHERE id=NEW.session_id AND account_id=NEW.account_id FOR SHARE NOWAIT;
 at_time:=clock_timestamp();
 IF a.id IS NULL OR a.status<>'active' OR a.lifecycle<>'active' OR a.lifecycle_generation<>NEW.base_generation
   OR s.id IS NULL OR s.revoked_at IS NOT NULL OR s.absolute_expires_at<=at_time OR s.access_expires_at<=at_time
   OR s.issued_revocation_epoch<>a.session_revocation_epoch
   OR NOT EXISTS(SELECT 1 FROM whaleu_identity.provider_identities WHERE account_id=a.id AND provider='wechat' AND app_id=NEW.app_id) THEN
  RAISE EXCEPTION 'Real preparation requires current authenticated native identity' USING ERRCODE='23514';
 END IF;
 SELECT count(*) INTO n FROM(SELECT 1 FROM whaleu_real_deletion.preparations WHERE account_id=a.id AND expires_at>at_time LIMIT 4) bounded;
 IF n>=4 THEN RAISE EXCEPTION 'Real preparation budget exhausted' USING ERRCODE='23514'; END IF;
 SELECT count(*) INTO n FROM(SELECT 1 FROM whaleu_real_deletion.preparations WHERE account_id=a.id LIMIT 64) retained;
 IF n>=64 THEN RAISE EXCEPTION 'Real preparation retained-history budget exhausted' USING ERRCODE='23514';END IF;
 NEW.created_at:=at_time;
 NEW.expires_at:=at_time+interval '900 seconds';
 NEW.created_transaction:=pg_current_xact_id();
 RETURN NEW;
END$successor$;

CREATE SCHEMA whaleu_real_deletion_admission;
CREATE TABLE whaleu_real_deletion_admission.receipts (
 request_id uuid PRIMARY KEY REFERENCES whaleu_real_deletion.preparations(intent_id),
 account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
 generation bigint NOT NULL CHECK(generation>0),previous_epoch bigint NOT NULL CHECK(previous_epoch>=0),
 owner_revision text NOT NULL CHECK(length(owner_revision) BETWEEN 1 AND 64),
 owner_evidence text NOT NULL CHECK(owner_evidence ~ '^[a-f0-9]{64}$'),
 reader_revision text NOT NULL CHECK(length(reader_revision) BETWEEN 1 AND 64),
 reader_evidence text NOT NULL CHECK(reader_evidence ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(created_at)),
 valid_until timestamptz NOT NULL CHECK(isfinite(valid_until) AND valid_until>created_at),
 creation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id()
);
CREATE FUNCTION whaleu_real_deletion_admission.unavailable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$BEGIN
 RAISE EXCEPTION 'Real owner coverage and retired-reader authority are not installed' USING ERRCODE='23514',CONSTRAINT='real_deletion_admission_unavailable';
END$$;
CREATE TRIGGER real_admission_closed BEFORE INSERT OR UPDATE OR DELETE ON whaleu_real_deletion_admission.receipts
 FOR EACH ROW EXECUTE FUNCTION whaleu_real_deletion_admission.unavailable();
CREATE TRIGGER real_admission_no_truncate BEFORE TRUNCATE ON whaleu_real_deletion_admission.receipts
 FOR EACH STATEMENT EXECUTE FUNCTION whaleu_real_deletion_admission.unavailable();
CREATE FUNCTION whaleu_real_deletion_admission.current_receipt(target_request uuid,target_account uuid,target_generation bigint,target_epoch bigint) RETURNS boolean
 LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM whaleu_real_deletion_admission.receipts r
 WHERE r.request_id=target_request AND r.account_id=target_account
 AND r.generation=target_generation AND r.previous_epoch=target_epoch
 AND r.creation_transaction=pg_current_xact_id()
 AND r.created_at<=clock_timestamp() AND r.valid_until>clock_timestamp())
$$;

CREATE TABLE whaleu_real_deletion.reauthentication_attempts (
 id uuid PRIMARY KEY,intent_id uuid NOT NULL REFERENCES whaleu_real_deletion.preparations(intent_id),
 account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
 generation bigint NOT NULL CHECK(generation>0),previous_epoch bigint NOT NULL CHECK(previous_epoch>=0),
 session_id uuid NOT NULL,token_hash text NOT NULL CHECK(token_hash ~ '^[a-f0-9]{64}$'),
 app_id text NOT NULL CHECK(app_id ~ '^wx[a-f0-9]{16}$'),
 purpose text NOT NULL CHECK(purpose='acceptance'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(created_at)),
 expires_at timestamptz NOT NULL CHECK(isfinite(expires_at) AND expires_at=created_at+interval '30 seconds'),
 creation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 verified_at timestamptz,verification_transaction xid8,
 CHECK((verified_at IS NULL)=(verification_transaction IS NULL)),
 CHECK(verified_at IS NULL OR (isfinite(verified_at) AND verified_at>=created_at AND verified_at<expires_at))
);
CREATE INDEX real_reauthentication_account ON whaleu_real_deletion.reauthentication_attempts(account_id,expires_at,id);
CREATE INDEX real_reauthentication_intent ON whaleu_real_deletion.reauthentication_attempts(intent_id,id);
CREATE TABLE whaleu_real_deletion.provider_captures (
 attempt_id uuid NOT NULL REFERENCES whaleu_real_deletion.reauthentication_attempts(id),
 key_epoch text NOT NULL CHECK(key_epoch ~ '^[a-z][a-z0-9-]{0,31}$'),
 key_check text NOT NULL CHECK(key_check ~ '^[a-f0-9]{64}$'),
 identity_digest text NOT NULL CHECK(identity_digest ~ '^[a-f0-9]{64}$'),
 capture_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 PRIMARY KEY(attempt_id,key_epoch)
);
CREATE TABLE whaleu_real_deletion.requests (
 id uuid PRIMARY KEY REFERENCES whaleu_real_deletion.preparations(intent_id),
 account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
 generation bigint NOT NULL CHECK(generation>0),
 previous_epoch bigint NOT NULL CHECK(previous_epoch>=0 AND previous_epoch<9223372036854775807),
 revoked_epoch bigint NOT NULL CHECK(revoked_epoch=previous_epoch+1),
 intent_hash text NOT NULL CHECK(intent_hash ~ '^[a-f0-9]{64}$'),
 recovery_hash text NOT NULL CHECK(recovery_hash ~ '^[a-f0-9]{64}$'),
 reauthentication_id uuid NOT NULL UNIQUE REFERENCES whaleu_real_deletion.reauthentication_attempts(id),
 admission_id uuid NOT NULL UNIQUE REFERENCES whaleu_real_deletion_admission.receipts(request_id),
 accepting_session_id uuid NOT NULL,accepting_token_hash text NOT NULL CHECK(accepting_token_hash ~ '^[a-f0-9]{64}$'),
 phase text NOT NULL CHECK(phase IN('cooling','cancelled')),
 revision bigint NOT NULL CHECK(revision>0),
 accepted_at timestamptz NOT NULL CHECK(isfinite(accepted_at)),
 cancel_before timestamptz NOT NULL CHECK(isfinite(cancel_before) AND cancel_before=accepted_at+interval '604800 seconds'),
 accepted_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 cancelled_at timestamptz,
 CHECK((phase='cancelled')=(cancelled_at IS NOT NULL)),
 CHECK(cancelled_at IS NULL OR (isfinite(cancelled_at) AND cancelled_at>=accepted_at AND cancelled_at<cancel_before)),
 UNIQUE(account_id,generation)
);
ALTER TABLE whaleu_identity.accounts ADD COLUMN real_deletion_request_id uuid REFERENCES whaleu_real_deletion.requests(id);
ALTER TABLE whaleu_identity.accounts ADD CONSTRAINT deletion_authority_unambiguous CHECK(real_deletion_request_id IS NULL OR deletion_request_id IS NULL);
CREATE TABLE whaleu_real_deletion.cancellations (
 command_id uuid PRIMARY KEY,request_id uuid NOT NULL REFERENCES whaleu_real_deletion.requests(id),
 expected_revision bigint NOT NULL CHECK(expected_revision>0),
 intent_hash text NOT NULL CHECK(intent_hash ~ '^[a-f0-9]{64}$'),
 recovery_hash text NOT NULL CHECK(recovery_hash ~ '^[a-f0-9]{64}$'),
 cancelled_at timestamptz NOT NULL CHECK(isfinite(cancelled_at)),
 mutation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 UNIQUE(request_id)
);

CREATE FUNCTION whaleu_real_deletion.request_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$BEGIN
 RAISE EXCEPTION 'Real deletion evidence is immutable outside its exact authority' USING ERRCODE='23514',CONSTRAINT='real_deletion_evidence';
END$$;
CREATE FUNCTION whaleu_real_deletion.request_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE a whaleu_identity.accounts;p whaleu_real_deletion.preparations;r whaleu_real_deletion.reauthentication_attempts;at timestamptz;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Real request identity is retained' USING ERRCODE='23514';END IF;
 SELECT * INTO a FROM whaleu_identity.accounts WHERE id=NEW.account_id FOR UPDATE NOWAIT;
 IF a.id IS NULL THEN RAISE EXCEPTION 'Real request account missing' USING ERRCODE='23514';END IF;
 at:=clock_timestamp();
 IF TG_OP='INSERT' THEN
  SELECT * INTO p FROM whaleu_real_deletion.preparations WHERE intent_id=NEW.id FOR SHARE NOWAIT;
  SELECT * INTO r FROM whaleu_real_deletion.reauthentication_attempts WHERE id=NEW.reauthentication_id FOR SHARE NOWAIT;
  IF p.intent_id IS NULL OR r.id IS NULL OR a.status<>'active' OR a.lifecycle<>'active'
   OR NEW.account_id<>p.account_id OR NEW.generation<>p.next_generation OR NEW.generation<>a.lifecycle_generation+1
   OR NEW.previous_epoch<>a.session_revocation_epoch OR NEW.revoked_epoch<>a.session_revocation_epoch+1
   OR NEW.intent_hash<>p.intent_hash OR NEW.recovery_hash<>p.recovery_hash OR p.expires_at<=at
   OR NEW.phase<>'cooling' OR NEW.revision<>1 OR NEW.cancelled_at IS NOT NULL
   OR NEW.admission_id<>NEW.id OR NOT whaleu_real_deletion_admission.current_receipt(NEW.id,NEW.account_id,NEW.generation,NEW.previous_epoch)
   OR r.intent_id<>NEW.id OR r.account_id<>NEW.account_id OR r.generation<>NEW.generation OR r.previous_epoch<>NEW.previous_epoch
   OR r.session_id<>NEW.accepting_session_id OR r.token_hash<>NEW.accepting_token_hash OR r.purpose<>'acceptance'
   OR r.verification_transaction IS DISTINCT FROM pg_current_xact_id() OR r.verified_at IS NULL OR r.expires_at<=at
   OR (SELECT count(*) FROM(SELECT 1 FROM whaleu_real_deletion.provider_captures WHERE attempt_id=r.id AND capture_transaction=pg_current_xact_id() LIMIT 9) q) NOT BETWEEN 1 AND 8
   OR NOT EXISTS(SELECT 1 FROM whaleu_identity.sessions s JOIN whaleu_identity.access_tokens t ON t.session_id=s.id
    WHERE s.id=r.session_id AND s.account_id=a.id AND t.token_hash=r.token_hash AND s.revoked_at IS NULL
    AND s.issued_revocation_epoch=a.session_revocation_epoch AND t.expires_at>at AND s.absolute_expires_at>at)
  THEN RAISE EXCEPTION 'Exact fresh real acceptance authority required' USING ERRCODE='23514',CONSTRAINT='real_deletion_request';END IF;
  NEW.accepted_at:=at;NEW.cancel_before:=at+interval '604800 seconds';NEW.accepted_transaction:=pg_current_xact_id();RETURN NEW;
 END IF;
 IF (to_jsonb(OLD)-ARRAY['phase','revision','cancelled_at']) IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['phase','revision','cancelled_at'])
  OR OLD.phase<>'cooling' OR NEW.phase<>'cancelled' OR NEW.revision<>OLD.revision+1
  OR a.lifecycle<>'cooling' OR a.real_deletion_request_id IS DISTINCT FROM OLD.id OR a.lifecycle_generation<>OLD.generation
  OR a.session_revocation_epoch<>OLD.revoked_epoch OR at>=OLD.cancel_before
  OR NOT EXISTS(SELECT 1 FROM whaleu_real_deletion.cancellations c WHERE c.request_id=OLD.id AND c.expected_revision=OLD.revision
   AND c.mutation_transaction=pg_current_xact_id() AND c.cancelled_at=NEW.cancelled_at AND c.recovery_hash=OLD.recovery_hash)
 THEN RAISE EXCEPTION 'Exact current cancellation cause required' USING ERRCODE='23514',CONSTRAINT='real_deletion_request';END IF;
 RETURN NEW;
END$$;
CREATE TRIGGER real_request_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_real_deletion.requests FOR EACH ROW EXECUTE FUNCTION whaleu_real_deletion.request_guard();
CREATE TRIGGER real_request_no_truncate BEFORE TRUNCATE ON whaleu_real_deletion.requests FOR EACH STATEMENT EXECUTE FUNCTION whaleu_real_deletion.request_immutable();
CREATE FUNCTION whaleu_real_deletion.request_apply() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$BEGIN
 IF TG_OP='INSERT' THEN
  UPDATE whaleu_identity.accounts SET lifecycle='cooling',lifecycle_generation=NEW.generation,real_deletion_request_id=NEW.id,deletion_request_id=NULL,session_revocation_epoch=NEW.revoked_epoch WHERE id=NEW.account_id;
 ELSE
  UPDATE whaleu_identity.accounts SET lifecycle='active' WHERE id=NEW.account_id AND real_deletion_request_id=NEW.id AND lifecycle_generation=NEW.generation AND session_revocation_epoch=NEW.revoked_epoch;
 END IF;
 IF NOT FOUND THEN RAISE EXCEPTION 'Request lifecycle application lost its account' USING ERRCODE='23514';END IF;RETURN NULL;
END$$;
CREATE TRIGGER real_request_apply AFTER INSERT OR UPDATE ON whaleu_real_deletion.requests FOR EACH ROW EXECUTE FUNCTION whaleu_real_deletion.request_apply();
CREATE FUNCTION whaleu_real_deletion.request_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE r whaleu_real_deletion.requests;BEGIN
 SELECT * INTO r FROM whaleu_real_deletion.requests WHERE id=NEW.id;
 IF r.id IS NULL OR NOT EXISTS(SELECT 1 FROM whaleu_identity.accounts a WHERE a.id=r.account_id AND a.real_deletion_request_id=r.id
  AND a.deletion_request_id IS NULL AND a.lifecycle_generation=r.generation AND a.session_revocation_epoch=r.revoked_epoch
  AND a.lifecycle=CASE r.phase WHEN 'cooling' THEN 'cooling' ELSE 'active' END)
 THEN RAISE EXCEPTION 'Real request lacks exact account lifecycle closure' USING ERRCODE='23514';END IF;RETURN NULL;
END$$;
CREATE CONSTRAINT TRIGGER real_request_complete AFTER INSERT OR UPDATE ON whaleu_real_deletion.requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_real_deletion.request_complete();

CREATE FUNCTION whaleu_real_deletion.attempt_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE p whaleu_real_deletion.preparations;a whaleu_identity.accounts;at timestamptz;BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.expires_at>clock_timestamp() OR EXISTS(SELECT 1 FROM whaleu_real_deletion.requests WHERE reauthentication_id=OLD.id)
  THEN RAISE EXCEPTION 'Live or accepted reauthentication is retained' USING ERRCODE='23514';END IF;RETURN OLD;
 END IF;
 SELECT * INTO a FROM whaleu_identity.accounts WHERE id=NEW.account_id FOR UPDATE NOWAIT;
 SELECT * INTO p FROM whaleu_real_deletion.preparations WHERE intent_id=NEW.intent_id FOR SHARE NOWAIT;
 PERFORM id FROM whaleu_identity.sessions WHERE id=NEW.session_id AND account_id=NEW.account_id FOR SHARE NOWAIT;
 PERFORM token_hash FROM whaleu_identity.access_tokens WHERE token_hash=NEW.token_hash AND session_id=NEW.session_id FOR SHARE NOWAIT;
 at:=clock_timestamp();
 IF a.id IS NULL OR p.intent_id IS NULL OR a.status<>'active' OR a.lifecycle<>'active'
 OR p.account_id<>a.id OR p.session_id<>NEW.session_id OR p.app_id<>NEW.app_id OR p.expires_at<=at
 OR NEW.generation<>p.next_generation OR NEW.generation<>a.lifecycle_generation+1 OR NEW.previous_epoch<>a.session_revocation_epoch
 OR NOT EXISTS(SELECT 1 FROM whaleu_identity.sessions x JOIN whaleu_identity.access_tokens t ON t.session_id=x.id
  WHERE x.id=NEW.session_id AND x.account_id=a.id AND t.token_hash=NEW.token_hash AND x.revoked_at IS NULL
  AND x.issued_revocation_epoch=a.session_revocation_epoch AND t.expires_at>at AND x.absolute_expires_at>at)
 OR (SELECT count(*) FROM(SELECT 1 FROM whaleu_identity.provider_identities WHERE account_id=a.id AND provider='wechat' AND app_id=NEW.app_id LIMIT 2) q)<>1
 THEN RAISE EXCEPTION 'Current exact preparation and session required for reauthentication' USING ERRCODE='23514';END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.verified_at IS NOT NULL OR NEW.verification_transaction IS NOT NULL
   OR (SELECT count(*) FROM(SELECT 1 FROM whaleu_real_deletion.reauthentication_attempts WHERE account_id=a.id AND expires_at>at LIMIT 4) q)>=4
  THEN RAISE EXCEPTION 'Reauthentication attempt capacity exhausted' USING ERRCODE='23514';END IF;
  NEW.created_at:=at;NEW.expires_at:=at+interval '30 seconds';NEW.creation_transaction:=pg_current_xact_id();RETURN NEW;
 END IF;
 IF (to_jsonb(OLD)-ARRAY['verified_at','verification_transaction']) IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['verified_at','verification_transaction'])
  OR OLD.verified_at IS NOT NULL OR OLD.expires_at<=at THEN
  RAISE EXCEPTION 'Reauthentication verification is exact and single use' USING ERRCODE='23514';END IF;
 NEW.verified_at:=at;NEW.verification_transaction:=pg_current_xact_id();RETURN NEW;
END$$;
CREATE TRIGGER real_attempt_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_real_deletion.reauthentication_attempts FOR EACH ROW EXECUTE FUNCTION whaleu_real_deletion.attempt_guard();
CREATE TRIGGER real_attempt_no_truncate BEFORE TRUNCATE ON whaleu_real_deletion.reauthentication_attempts FOR EACH STATEMENT EXECUTE FUNCTION whaleu_real_deletion.request_immutable();
CREATE FUNCTION whaleu_real_deletion.capture_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$BEGIN
 IF NOT EXISTS(SELECT 1 FROM whaleu_real_deletion.reauthentication_attempts a WHERE a.id=NEW.attempt_id
  AND a.verification_transaction=pg_current_xact_id() AND a.verified_at IS NOT NULL AND a.expires_at>clock_timestamp())
 OR (SELECT count(*) FROM(SELECT 1 FROM whaleu_real_deletion.provider_captures WHERE attempt_id=NEW.attempt_id LIMIT 8) q)>=8
 THEN RAISE EXCEPTION 'Current request-scoped server verification capture required' USING ERRCODE='23514';END IF;
 NEW.capture_transaction:=pg_current_xact_id();RETURN NEW;
END$$;
CREATE TRIGGER real_capture_guard BEFORE INSERT ON whaleu_real_deletion.provider_captures FOR EACH ROW EXECUTE FUNCTION whaleu_real_deletion.capture_guard();
CREATE TRIGGER real_capture_immutable BEFORE UPDATE OR DELETE ON whaleu_real_deletion.provider_captures FOR EACH ROW EXECUTE FUNCTION whaleu_real_deletion.request_immutable();
CREATE TRIGGER real_capture_no_truncate BEFORE TRUNCATE ON whaleu_real_deletion.provider_captures FOR EACH STATEMENT EXECUTE FUNCTION whaleu_real_deletion.request_immutable();
CREATE FUNCTION whaleu_real_deletion.cancellation_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE r whaleu_real_deletion.requests;at timestamptz;BEGIN
 SELECT * INTO r FROM whaleu_real_deletion.requests WHERE id=NEW.request_id;
 IF r.id IS NULL THEN RAISE EXCEPTION 'Cancellation scope unavailable' USING ERRCODE='23514';END IF;
 PERFORM id FROM whaleu_identity.accounts WHERE id=r.account_id FOR UPDATE NOWAIT;
 SELECT * INTO r FROM whaleu_real_deletion.requests WHERE id=NEW.request_id FOR UPDATE NOWAIT;
 at:=clock_timestamp();
 IF r.phase<>'cooling' OR r.revision<>NEW.expected_revision OR r.recovery_hash<>NEW.recovery_hash OR at>=r.cancel_before
 OR NOT EXISTS(SELECT 1 FROM whaleu_identity.accounts a WHERE a.id=r.account_id AND a.lifecycle='cooling'
  AND a.real_deletion_request_id=r.id AND a.lifecycle_generation=r.generation AND a.session_revocation_epoch=r.revoked_epoch)
 THEN RAISE EXCEPTION 'Current cooling scope and exact revision required' USING ERRCODE='23514';END IF;
 NEW.cancelled_at:=at;NEW.mutation_transaction:=pg_current_xact_id();RETURN NEW;
END$$;
CREATE TRIGGER real_cancellation_guard BEFORE INSERT ON whaleu_real_deletion.cancellations FOR EACH ROW EXECUTE FUNCTION whaleu_real_deletion.cancellation_guard();
CREATE TRIGGER real_cancellation_immutable BEFORE UPDATE OR DELETE ON whaleu_real_deletion.cancellations FOR EACH ROW EXECUTE FUNCTION whaleu_real_deletion.request_immutable();
CREATE TRIGGER real_cancellation_no_truncate BEFORE TRUNCATE ON whaleu_real_deletion.cancellations FOR EACH STATEMENT EXECUTE FUNCTION whaleu_real_deletion.request_immutable();
CREATE FUNCTION whaleu_real_deletion.cancellation_apply() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$BEGIN
 UPDATE whaleu_real_deletion.requests SET phase='cancelled',revision=revision+1,cancelled_at=NEW.cancelled_at WHERE id=NEW.request_id AND revision=NEW.expected_revision;
 IF NOT FOUND THEN RAISE EXCEPTION 'Cancellation lost exact revision' USING ERRCODE='23514';END IF;RETURN NULL;
END$$;
CREATE TRIGGER real_cancellation_apply AFTER INSERT ON whaleu_real_deletion.cancellations FOR EACH ROW EXECUTE FUNCTION whaleu_real_deletion.cancellation_apply();
CREATE FUNCTION whaleu_real_deletion.account_pointer_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.real_deletion_request_id IS NOT NULL THEN RAISE EXCEPTION 'New accounts cannot claim a prior real request' USING ERRCODE='23514';END IF;RETURN NEW;
 END IF;
 IF OLD.real_deletion_request_id IS DISTINCT FROM NEW.real_deletion_request_id AND
  (NEW.real_deletion_request_id IS NULL OR NOT EXISTS(SELECT 1 FROM whaleu_real_deletion.requests r WHERE r.id=NEW.real_deletion_request_id
   AND r.account_id=NEW.id AND r.generation=NEW.lifecycle_generation AND r.accepted_transaction=pg_current_xact_id()
   AND r.phase='cooling' AND OLD.lifecycle='active' AND NEW.lifecycle='cooling' AND NEW.lifecycle_generation=OLD.lifecycle_generation+1))
 THEN RAISE EXCEPTION 'Exact real request owns its account pointer' USING ERRCODE='23514';END IF;RETURN NEW;
END$$;
CREATE TRIGGER real_deletion_pointer BEFORE INSERT OR UPDATE ON whaleu_identity.accounts FOR EACH ROW EXECUTE FUNCTION whaleu_real_deletion.account_pointer_guard();
CREATE FUNCTION whaleu_real_deletion.account_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE a whaleu_identity.accounts;BEGIN
 SELECT * INTO a FROM whaleu_identity.accounts WHERE id=NEW.id;
 IF a.real_deletion_request_id IS NULL THEN RETURN NULL;END IF;
 IF NOT EXISTS(SELECT 1 FROM whaleu_real_deletion.requests r
 WHERE r.id=a.real_deletion_request_id AND r.account_id=a.id AND r.generation=a.lifecycle_generation
 AND r.revoked_epoch=a.session_revocation_epoch AND a.deletion_request_id IS NULL
 AND a.lifecycle=CASE r.phase WHEN 'cooling' THEN 'cooling' ELSE 'active' END)
 THEN RAISE EXCEPTION 'Account lacks exact real request closure' USING ERRCODE='23514';END IF;RETURN NULL;
END$$;
CREATE CONSTRAINT TRIGGER real_deletion_account_complete AFTER INSERT OR UPDATE ON whaleu_identity.accounts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_real_deletion.account_complete();

DO $qualify$BEGIN
 IF (SELECT count(*) FROM pg_proc WHERE pronamespace='whaleu_identity'::regnamespace AND proname='session_epoch_account_guard')<>1
 OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('whaleu_identity.session_epoch_account_guard()') AND p.pronargs=0 AND p.pronargdefaults=0
 AND p.proargmodes IS NULL AND p.proallargtypes IS NULL AND p.proargdefaults IS NULL AND p.provariadic=0
 AND p.prokind='f' AND p.prolang=(SELECT oid FROM pg_language WHERE lanname='plpgsql') AND p.prorettype='trigger'::regtype
 AND p.provolatile='v' AND NOT p.proretset AND NOT p.prosecdef AND NOT p.proisstrict AND NOT p.proleakproof
 AND p.proparallel='u' AND p.prosupport=0 AND p.prosqlbody IS NULL AND p.probin IS NULL AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND p.prosrc=$prior$BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.session_revocation_epoch IS DISTINCT FROM 0::bigint THEN
   RAISE EXCEPTION 'New accounts require the initial session epoch' USING ERRCODE='23514',CONSTRAINT='session_epoch_account';
  END IF;
 ELSIF NEW.session_revocation_epoch IS DISTINCT FROM OLD.session_revocation_epoch THEN
  RAISE EXCEPTION 'Real accepted deletion authority is not installed' USING ERRCODE='23514',CONSTRAINT='session_epoch_account';
 END IF;
 RETURN NEW;
END$prior$)
 THEN RAISE EXCEPTION 'Exact real authority predecessor mismatch: whaleu_identity.session_epoch_account_guard' USING ERRCODE='23514';END IF;
END$qualify$;
CREATE OR REPLACE FUNCTION whaleu_identity.session_epoch_account_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $successor$BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.session_revocation_epoch IS DISTINCT FROM 0::bigint THEN
   RAISE EXCEPTION 'New accounts require the initial session epoch' USING ERRCODE='23514',CONSTRAINT='session_epoch_account';
  END IF;
 ELSIF NEW.session_revocation_epoch IS DISTINCT FROM OLD.session_revocation_epoch THEN
  IF OLD.session_revocation_epoch>=9223372036854775807 OR NEW.session_revocation_epoch<>OLD.session_revocation_epoch+1
   OR NOT EXISTS(SELECT 1 FROM whaleu_real_deletion.requests r WHERE r.id=NEW.real_deletion_request_id AND r.account_id=NEW.id
    AND r.accepted_transaction=pg_current_xact_id() AND r.phase='cooling' AND r.revision=1
    AND r.previous_epoch=OLD.session_revocation_epoch AND r.revoked_epoch=NEW.session_revocation_epoch
    AND OLD.lifecycle='active' AND NEW.lifecycle='cooling' AND NEW.lifecycle_generation=OLD.lifecycle_generation+1
    AND NEW.lifecycle_generation=r.generation AND NEW.deletion_request_id IS NULL)
  THEN RAISE EXCEPTION 'Exact accepted real request owns epoch advance' USING ERRCODE='23514',CONSTRAINT='session_epoch_account';END IF;
 END IF;
 RETURN NEW;
END$successor$;

DO $qualify$BEGIN
 IF (SELECT count(*) FROM pg_proc WHERE pronamespace='whaleu_identity'::regnamespace AND proname='session_epoch_protocol')<>1
 OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('whaleu_identity.session_epoch_protocol()') AND p.pronargs=0 AND p.pronargdefaults=0
 AND p.proargmodes IS NULL AND p.proallargtypes IS NULL AND p.proargdefaults IS NULL AND p.provariadic=0
 AND p.prokind='f' AND p.prolang=(SELECT oid FROM pg_language WHERE lanname='sql') AND p.prorettype='jsonb'::regtype
 AND p.provolatile='i' AND NOT p.proretset AND NOT p.prosecdef AND NOT p.proisstrict AND NOT p.proleakproof
 AND p.proparallel='u' AND p.prosupport=0 AND p.prosqlbody IS NULL AND p.probin IS NULL AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND p.prosrc=$prior$SELECT '{"version":1,"protocol":"identity-session-revocation-epoch-v1","bumpAuthority":"unavailable"}'::jsonb$prior$)
 THEN RAISE EXCEPTION 'Exact real authority predecessor mismatch: whaleu_identity.session_epoch_protocol' USING ERRCODE='23514';END IF;
END$qualify$;
CREATE OR REPLACE FUNCTION whaleu_identity.session_epoch_protocol() RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $successor$SELECT '{"version":2,"protocol":"identity-session-revocation-epoch-v2","bumpAuthority":"exact-real-request-with-qualified-admission"}'::jsonb$successor$;

DO $qualify$BEGIN
 IF (SELECT count(*) FROM pg_proc WHERE pronamespace='whaleu_account_deletion'::regnamespace AND proname='lifecycle_guard')<>1
 OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('whaleu_account_deletion.lifecycle_guard()') AND p.pronargs=0 AND p.pronargdefaults=0
 AND p.proargmodes IS NULL AND p.proallargtypes IS NULL AND p.proargdefaults IS NULL AND p.provariadic=0
 AND p.prokind='f' AND p.prolang=(SELECT oid FROM pg_language WHERE lanname='plpgsql') AND p.prorettype='trigger'::regtype
 AND p.provolatile='v' AND NOT p.proretset AND NOT p.prosecdef AND NOT p.proisstrict AND NOT p.proleakproof
 AND p.proparallel='u' AND p.prosupport=0 AND p.prosqlbody IS NULL AND p.probin IS NULL AND p.proconfig IS NULL AND p.prosrc=$prior$DECLARE r whaleu_account_deletion.requests;BEGIN
 IF (NEW.lifecycle,NEW.lifecycle_generation,NEW.deletion_request_id) IS NOT DISTINCT FROM (OLD.lifecycle,OLD.lifecycle_generation,OLD.deletion_request_id) THEN RETURN NEW;END IF;
 SELECT * INTO r FROM whaleu_account_deletion.requests WHERE id=NEW.deletion_request_id AND account_id=NEW.id;
 IF r.id IS NULL OR r.generation<>NEW.lifecycle_generation OR NEW.status IS DISTINCT FROM OLD.status
 OR NOT ((OLD.lifecycle='active' AND NEW.lifecycle='cooling' AND r.phase='cooling' AND r.creation_transaction=pg_current_xact_id() AND NEW.lifecycle_generation=OLD.lifecycle_generation+1)
 OR (OLD.lifecycle='cooling' AND NEW.lifecycle='active' AND r.phase='cancelled' AND NEW.lifecycle_generation=OLD.lifecycle_generation)
 OR (OLD.lifecycle='cooling' AND NEW.lifecycle='erasing' AND r.phase='erasing' AND NEW.lifecycle_generation=OLD.lifecycle_generation)
 OR (OLD.lifecycle='erasing' AND NEW.lifecycle='completed' AND r.phase='completed' AND NEW.lifecycle_generation=OLD.lifecycle_generation))
 THEN RAISE EXCEPTION 'Exact deletion lifecycle cause required' USING ERRCODE='23514';END IF;RETURN NEW;
END$prior$)
 THEN RAISE EXCEPTION 'Exact real authority predecessor mismatch: whaleu_account_deletion.lifecycle_guard' USING ERRCODE='23514';END IF;
END$qualify$;
CREATE OR REPLACE FUNCTION whaleu_account_deletion.lifecycle_guard() RETURNS trigger LANGUAGE plpgsql AS $successor$DECLARE r whaleu_account_deletion.requests;BEGIN

 IF NEW.real_deletion_request_id IS NOT NULL OR OLD.real_deletion_request_id IS NOT NULL THEN
  IF (NEW.lifecycle,NEW.lifecycle_generation,NEW.deletion_request_id,NEW.real_deletion_request_id) IS NOT DISTINCT FROM
   (OLD.lifecycle,OLD.lifecycle_generation,OLD.deletion_request_id,OLD.real_deletion_request_id) THEN RETURN NEW;END IF;
  IF NEW.status IS DISTINCT FROM OLD.status OR NEW.deletion_request_id IS NOT NULL OR NOT EXISTS(
   SELECT 1 FROM whaleu_real_deletion.requests q WHERE q.id=NEW.real_deletion_request_id AND q.account_id=NEW.id AND q.generation=NEW.lifecycle_generation
    AND ((OLD.lifecycle='active' AND NEW.lifecycle='cooling' AND q.phase='cooling' AND q.accepted_transaction=pg_current_xact_id() AND NEW.lifecycle_generation=OLD.lifecycle_generation+1)
     OR (OLD.lifecycle='cooling' AND NEW.lifecycle='active' AND q.phase='cancelled' AND NEW.lifecycle_generation=OLD.lifecycle_generation
      AND EXISTS(SELECT 1 FROM whaleu_real_deletion.cancellations c WHERE c.request_id=q.id AND c.mutation_transaction=pg_current_xact_id() AND c.cancelled_at=q.cancelled_at))))
  THEN RAISE EXCEPTION 'Exact real deletion lifecycle cause required' USING ERRCODE='23514';END IF;RETURN NEW;
 END IF;
 IF (NEW.lifecycle,NEW.lifecycle_generation,NEW.deletion_request_id) IS NOT DISTINCT FROM (OLD.lifecycle,OLD.lifecycle_generation,OLD.deletion_request_id) THEN RETURN NEW;END IF;
 SELECT * INTO r FROM whaleu_account_deletion.requests WHERE id=NEW.deletion_request_id AND account_id=NEW.id;
 IF r.id IS NULL OR r.generation<>NEW.lifecycle_generation OR NEW.status IS DISTINCT FROM OLD.status
 OR NOT ((OLD.lifecycle='active' AND NEW.lifecycle='cooling' AND r.phase='cooling' AND r.creation_transaction=pg_current_xact_id() AND NEW.lifecycle_generation=OLD.lifecycle_generation+1)
 OR (OLD.lifecycle='cooling' AND NEW.lifecycle='active' AND r.phase='cancelled' AND NEW.lifecycle_generation=OLD.lifecycle_generation)
 OR (OLD.lifecycle='cooling' AND NEW.lifecycle='erasing' AND r.phase='erasing' AND NEW.lifecycle_generation=OLD.lifecycle_generation)
 OR (OLD.lifecycle='erasing' AND NEW.lifecycle='completed' AND r.phase='completed' AND NEW.lifecycle_generation=OLD.lifecycle_generation))
 THEN RAISE EXCEPTION 'Exact deletion lifecycle cause required' USING ERRCODE='23514';END IF;RETURN NEW;
END$successor$;

REVOKE ALL ON SCHEMA whaleu_real_deletion_admission FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA whaleu_real_deletion_admission FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA whaleu_real_deletion_admission FROM PUBLIC;
REVOKE ALL ON whaleu_real_deletion.reauthentication_attempts,whaleu_real_deletion.provider_captures,whaleu_real_deletion.requests,whaleu_real_deletion.cancellations FROM PUBLIC;
REVOKE ALL ON FUNCTION whaleu_real_deletion.request_immutable(),whaleu_real_deletion.request_guard(),whaleu_real_deletion.request_apply(),whaleu_real_deletion.request_complete(),whaleu_real_deletion.attempt_guard(),whaleu_real_deletion.capture_guard(),whaleu_real_deletion.cancellation_guard(),whaleu_real_deletion.cancellation_apply(),whaleu_real_deletion.account_pointer_guard(),whaleu_real_deletion.account_complete() FROM PUBLIC;

CREATE FUNCTION whaleu_real_deletion.verification_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE attempt uuid;a whaleu_real_deletion.reauthentication_attempts;BEGIN
 IF TG_TABLE_SCHEMA='whaleu_real_deletion_admission' THEN
  IF NOT EXISTS(SELECT 1 FROM whaleu_real_deletion.requests r WHERE r.id=NEW.request_id AND r.admission_id=NEW.request_id AND r.account_id=NEW.account_id AND r.generation=NEW.generation AND r.previous_epoch=NEW.previous_epoch AND r.accepted_transaction=NEW.creation_transaction AND NEW.creation_transaction=pg_current_xact_id())
  THEN RAISE EXCEPTION 'Admission evidence lacks its exact accepted request' USING ERRCODE='23514';END IF;RETURN NULL;
 END IF;
 IF TG_TABLE_NAME='provider_captures' THEN attempt:=NEW.attempt_id;ELSE attempt:=NEW.id;END IF;
 SELECT * INTO a FROM whaleu_real_deletion.reauthentication_attempts WHERE id=attempt;
 IF a.verified_at IS NOT NULL AND (a.verification_transaction IS DISTINCT FROM pg_current_xact_id() OR NOT EXISTS(
  SELECT 1 FROM whaleu_real_deletion.requests r WHERE r.reauthentication_id=a.id AND r.account_id=a.account_id AND r.generation=a.generation AND r.id=a.intent_id
  AND r.accepted_transaction=a.verification_transaction AND r.previous_epoch=a.previous_epoch AND r.accepting_session_id=a.session_id AND r.accepting_token_hash=a.token_hash))
 THEN RAISE EXCEPTION 'Verified provider evidence lacks its exact accepted request' USING ERRCODE='23514';END IF;RETURN NULL;
END$$;
CREATE CONSTRAINT TRIGGER real_admission_complete AFTER INSERT ON whaleu_real_deletion_admission.receipts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_real_deletion.verification_complete();
CREATE CONSTRAINT TRIGGER real_verification_complete AFTER UPDATE ON whaleu_real_deletion.reauthentication_attempts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_real_deletion.verification_complete();
CREATE CONSTRAINT TRIGGER real_capture_complete AFTER INSERT ON whaleu_real_deletion.provider_captures DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_real_deletion.verification_complete();

CREATE FUNCTION whaleu_real_deletion.request_protocol() RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$SELECT null::jsonb$$;
CREATE FUNCTION whaleu_real_deletion.request_catalog() RETURNS text LANGUAGE sql STABLE SET search_path=pg_catalog AS $catalog$
WITH relations AS MATERIALIZED (
 SELECT c.oid,c.relname,c.relkind,c.relpersistence,c.relowner,c.relrowsecurity,c.relforcerowsecurity,c.reloptions,c.relispartition,c.relhassubclass,(names.name='whaleu_identity.accounts') borrowed FROM (VALUES ('whaleu_real_deletion.reauthentication_attempts'),('whaleu_real_deletion.provider_captures'),('whaleu_real_deletion.requests'),('whaleu_real_deletion.cancellations'),('whaleu_real_deletion_admission.receipts'),('whaleu_identity.accounts')) names(name)
 JOIN pg_class c ON c.oid=to_regclass(names.name)
), constraint_sources AS MATERIALIZED (
 SELECT x.* FROM relations r JOIN pg_constraint x ON x.conrelid=r.oid
 WHERE NOT r.borrowed OR x.conname IN ('accounts_real_deletion_request_id_fkey','deletion_authority_unambiguous') LIMIT 129
), index_ids AS MATERIALIZED (
 SELECT DISTINCT id FROM (
  (SELECT i.indexrelid id FROM relations r JOIN pg_index i ON i.indrelid=r.oid WHERE NOT r.borrowed LIMIT 65)
  UNION ALL (SELECT conindid id FROM constraint_sources WHERE conindid<>0 LIMIT 65)
 ) limited LIMIT 65
), indexes AS MATERIALIZED (
 SELECT i.*,ic.reloptions index_options,
 coalesce(octet_length(i.indexprs::text)>16384,false) OR coalesce(octet_length(i.indpred::text)>16384,false) OR coalesce(octet_length(ic.reloptions::text)>16384,false) source_oversized
 FROM index_ids ids JOIN pg_index i ON i.indexrelid=ids.id JOIN pg_class ic ON ic.oid=i.indexrelid LIMIT 65
), objects AS MATERIALIZED (
 SELECT oid FROM relations UNION ALL SELECT indexrelid FROM indexes
 UNION ALL SELECT 'whaleu_real_deletion.preparations'::regclass::oid
 UNION ALL SELECT indexrelid FROM pg_index WHERE indrelid='whaleu_real_deletion.preparations'::regclass LIMIT 65
), known_functions AS MATERIALIZED (
 SELECT to_regprocedure(name)::oid oid FROM (VALUES ('whaleu_real_deletion.preparation_guard()'),('whaleu_real_deletion.preparation_unavailable()'),('whaleu_real_deletion.preparation_catalog()'),('whaleu_real_deletion.preparation_protocol()'),('whaleu_real_deletion_admission.unavailable()'),('whaleu_real_deletion_admission.current_receipt(uuid,uuid,bigint,bigint)'),('whaleu_real_deletion.request_immutable()'),('whaleu_real_deletion.request_guard()'),('whaleu_real_deletion.request_apply()'),('whaleu_real_deletion.request_complete()'),('whaleu_real_deletion.attempt_guard()'),('whaleu_real_deletion.capture_guard()'),('whaleu_real_deletion.cancellation_guard()'),('whaleu_real_deletion.cancellation_apply()'),('whaleu_real_deletion.account_pointer_guard()'),('whaleu_real_deletion.account_complete()'),('whaleu_real_deletion.request_catalog()'),('whaleu_real_deletion.request_protocol()'),('whaleu_real_deletion.verification_complete()'),('whaleu_identity.session_epoch_account_guard()'),('whaleu_account_deletion.lifecycle_guard()')) functions(name)
), columns AS MATERIALIZED (
 SELECT 'column'::text kind,c.relname::text||':'||a.attnum::text key,
 jsonb_build_array(a.attname,a.atttypid,a.atttypmod,a.attnotnull,a.attidentity,a.attgenerated,a.attisdropped,a.attcollation,CASE WHEN octet_length(d.adbin::text)>16384 THEN NULL ELSE pg_get_expr(d.adbin,d.adrelid) END) value,coalesce(octet_length(d.adbin::text)>16384,false) oversized
 FROM relations c JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0
 LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
 WHERE NOT c.borrowed OR a.attname='real_deletion_request_id' LIMIT 129
), constraints AS MATERIALIZED (
 SELECT 'constraint'::text kind,c.relname::text||':'||x.conname::text key,
 jsonb_build_array(CASE WHEN coalesce(octet_length(x.conbin::text)>16384,false) OR (x.conindid<>0 AND (ix.indexrelid IS NULL OR ix.source_oversized)) THEN NULL ELSE pg_get_constraintdef(x.oid,true) END,x.convalidated,x.conenforced,x.condeferrable,x.condeferred,x.conislocal,x.coninhcount,x.connoinherit,x.conparentid) value,(coalesce(octet_length(x.conbin::text)>16384,false) OR (x.conindid<>0 AND (ix.indexrelid IS NULL OR ix.source_oversized))) oversized
 FROM relations c JOIN constraint_sources x ON x.conrelid=c.oid LEFT JOIN indexes ix ON ix.indexrelid=x.conindid LIMIT 129
), triggers AS MATERIALIZED (
 SELECT 'trigger'::text kind,c.relname::text||':'||t.tgname::text key,
 jsonb_build_array(CASE WHEN octet_length(t.tgargs)>16384 OR octet_length(t.tgqual::text)>16384 THEN NULL ELSE pg_get_triggerdef(t.oid,true) END,t.tgenabled,t.tgisinternal,t.tgdeferrable,t.tginitdeferred) value,coalesce(octet_length(t.tgargs)>16384,false) OR coalesce(octet_length(t.tgqual::text)>16384,false) oversized
 FROM relations c JOIN pg_trigger t ON t.tgrelid=c.oid
 WHERE NOT c.borrowed OR t.tgname IN ('real_deletion_pointer','real_deletion_account_complete') OR t.tgconstraint IN (SELECT oid FROM constraint_sources WHERE conname='accounts_real_deletion_request_id_fkey') LIMIT 129
), functions AS MATERIALIZED (
 SELECT 'function'::text kind,p.proname::text||'('||pg_get_function_identity_arguments(p.oid)||')' key,
 jsonb_build_array(CASE WHEN octet_length(p.prosrc)>16384 THEN NULL ELSE p.prosrc END,p.proowner,p.prolang,p.provolatile,p.prosecdef,p.proleakproof,p.proparallel,p.proisstrict,p.proretset,p.prorettype,CASE WHEN octet_length(p.proconfig::text)>16384 THEN NULL ELSE p.proconfig END) value,octet_length(p.prosrc)>16384 OR coalesce(octet_length(p.proconfig::text)>16384,false) oversized
 FROM known_functions f JOIN pg_proc p ON p.oid=f.oid
 WHERE p.oid NOT IN (to_regprocedure('whaleu_real_deletion.preparation_protocol()'),to_regprocedure('whaleu_real_deletion.request_protocol()'))
), facts AS MATERIALIZED (
 SELECT 'relation'::text kind,c.relname::text key,jsonb_build_array(c.relkind,c.relpersistence,c.relowner,c.relrowsecurity,c.relforcerowsecurity,CASE WHEN octet_length(c.reloptions::text)>16384 THEN NULL ELSE c.reloptions END,c.relispartition,c.relhassubclass) value,coalesce(octet_length(c.reloptions::text)>16384,false) oversized FROM relations c
 UNION ALL SELECT * FROM columns
 UNION ALL SELECT * FROM constraints
 UNION ALL SELECT 'index',i.indexrelid::regclass::text,jsonb_build_array(CASE WHEN i.source_oversized THEN NULL ELSE pg_get_indexdef(i.indexrelid) END,i.indisvalid,i.indisready,i.indislive),i.source_oversized FROM indexes i
 UNION ALL SELECT * FROM triggers
 UNION ALL SELECT * FROM functions
 UNION ALL SELECT 'unexpected-relation','exists',to_jsonb(EXISTS(
  SELECT 1 FROM pg_class c WHERE c.relnamespace IN ('whaleu_real_deletion'::regnamespace,'whaleu_real_deletion_admission'::regnamespace)
  AND NOT EXISTS(SELECT 1 FROM objects o WHERE o.oid=c.oid) LIMIT 1)),false
 UNION ALL SELECT 'unexpected-function','exists',to_jsonb(EXISTS(
  SELECT 1 FROM pg_proc p WHERE p.pronamespace IN ('whaleu_real_deletion'::regnamespace,'whaleu_real_deletion_admission'::regnamespace)
  AND NOT EXISTS(SELECT 1 FROM known_functions f WHERE f.oid=p.oid) LIMIT 1)),false
 LIMIT 385
), sized AS MATERIALIZED (
 SELECT *,octet_length(jsonb_build_array(kind,key,value)::text) bytes FROM facts
), budget AS MATERIALIZED (
 SELECT coalesce(bool_and(NOT oversized),false) AND count(*)<=384 AND coalesce(max(bytes),0)<=32768 AND coalesce(sum(bytes),0)+greatest(count(*)-1,0)*2+2<=262144
  AND (SELECT count(*) FROM columns)<=128 AND (SELECT count(*) FROM constraints)<=128
  AND (SELECT count(*) FROM indexes)<=64 AND (SELECT count(*) FROM triggers)<=128 AS valid FROM sized
), admitted AS MATERIALIZED (
 SELECT kind,key,value FROM sized WHERE bytes<=32768 AND (SELECT valid FROM budget)
)
SELECT CASE WHEN (SELECT valid FROM budget) THEN encode(sha256(convert_to(coalesce(jsonb_agg(jsonb_build_array(kind,key,value) ORDER BY kind COLLATE "C",key COLLATE "C"),'[]'::jsonb)::text,'UTF8')),'hex') ELSE NULL END FROM admitted
$catalog$;
CREATE OR REPLACE FUNCTION whaleu_real_deletion.preparation_catalog() RETURNS text LANGUAGE sql STABLE SET search_path=pg_catalog AS $catalog$
WITH relations AS MATERIALIZED (
 SELECT c.oid,c.relname,c.relkind,c.relpersistence,c.relowner,c.relrowsecurity,c.relforcerowsecurity,c.reloptions,c.relispartition,c.relhassubclass FROM (VALUES ('whaleu_real_deletion.preparations')) names(name)
 JOIN pg_class c ON c.oid=to_regclass(names.name)
), constraint_sources AS MATERIALIZED (
 SELECT x.* FROM relations r JOIN pg_constraint x ON x.conrelid=r.oid LIMIT 65
), index_ids AS MATERIALIZED (
 SELECT DISTINCT id FROM (
  (SELECT i.indexrelid id FROM relations r JOIN pg_index i ON i.indrelid=r.oid LIMIT 33)
  UNION ALL (SELECT conindid id FROM constraint_sources WHERE conindid<>0 LIMIT 33)
 ) limited LIMIT 33
), indexes AS MATERIALIZED (
 SELECT i.*,ic.reloptions index_options,
 coalesce(octet_length(i.indexprs::text)>16384,false) OR coalesce(octet_length(i.indpred::text)>16384,false) OR coalesce(octet_length(ic.reloptions::text)>16384,false) source_oversized
 FROM index_ids ids JOIN pg_index i ON i.indexrelid=ids.id JOIN pg_class ic ON ic.oid=i.indexrelid LIMIT 33
), objects AS MATERIALIZED (
 SELECT oid FROM relations UNION ALL SELECT indexrelid FROM indexes
 UNION ALL SELECT c.oid FROM (VALUES ('whaleu_real_deletion.reauthentication_attempts'),('whaleu_real_deletion.provider_captures'),('whaleu_real_deletion.requests'),('whaleu_real_deletion.cancellations')) names(name) JOIN pg_class c ON c.oid=to_regclass(names.name)
 UNION ALL SELECT i.indexrelid FROM (VALUES ('whaleu_real_deletion.reauthentication_attempts'),('whaleu_real_deletion.provider_captures'),('whaleu_real_deletion.requests'),('whaleu_real_deletion.cancellations')) names(name) JOIN pg_index i ON i.indrelid=to_regclass(names.name) LIMIT 65
), known_functions AS MATERIALIZED (
 SELECT to_regprocedure(name)::oid oid FROM (VALUES ('whaleu_real_deletion.preparation_guard()'),('whaleu_real_deletion.preparation_unavailable()'),('whaleu_real_deletion.preparation_catalog()'),('whaleu_real_deletion.preparation_protocol()'),('whaleu_real_deletion.request_immutable()'),('whaleu_real_deletion.request_guard()'),('whaleu_real_deletion.request_apply()'),('whaleu_real_deletion.request_complete()'),('whaleu_real_deletion.attempt_guard()'),('whaleu_real_deletion.capture_guard()'),('whaleu_real_deletion.cancellation_guard()'),('whaleu_real_deletion.cancellation_apply()'),('whaleu_real_deletion.account_pointer_guard()'),('whaleu_real_deletion.account_complete()'),('whaleu_real_deletion.request_catalog()'),('whaleu_real_deletion.request_protocol()'),('whaleu_real_deletion.verification_complete()')) functions(name)
), columns AS MATERIALIZED (
 SELECT 'column'::text kind,c.relname::text||':'||a.attnum::text key,
 jsonb_build_array(a.attname,a.atttypid,a.atttypmod,a.attnotnull,a.attidentity,a.attgenerated,a.attisdropped,a.attcollation,CASE WHEN octet_length(d.adbin::text)>16384 THEN NULL ELSE pg_get_expr(d.adbin,d.adrelid) END) value,coalesce(octet_length(d.adbin::text)>16384,false) oversized
 FROM relations c JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0
 LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum LIMIT 65
), constraints AS MATERIALIZED (
 SELECT 'constraint'::text kind,c.relname::text||':'||x.conname::text key,
 jsonb_build_array(CASE WHEN coalesce(octet_length(x.conbin::text)>16384,false) OR (x.conindid<>0 AND (ix.indexrelid IS NULL OR ix.source_oversized)) THEN NULL ELSE pg_get_constraintdef(x.oid,true) END,x.convalidated,x.conenforced,x.condeferrable,x.condeferred,x.conislocal,x.coninhcount,x.connoinherit,x.conparentid) value,(coalesce(octet_length(x.conbin::text)>16384,false) OR (x.conindid<>0 AND (ix.indexrelid IS NULL OR ix.source_oversized))) oversized
 FROM relations c JOIN constraint_sources x ON x.conrelid=c.oid LEFT JOIN indexes ix ON ix.indexrelid=x.conindid LIMIT 65
), triggers AS MATERIALIZED (
 SELECT 'trigger'::text kind,c.relname::text||':'||t.tgname::text key,
 jsonb_build_array(CASE WHEN octet_length(t.tgargs)>16384 OR octet_length(t.tgqual::text)>16384 THEN NULL ELSE pg_get_triggerdef(t.oid,true) END,t.tgenabled,t.tgisinternal,t.tgdeferrable,t.tginitdeferred) value,coalesce(octet_length(t.tgargs)>16384,false) OR coalesce(octet_length(t.tgqual::text)>16384,false) oversized
 FROM relations c JOIN pg_trigger t ON t.tgrelid=c.oid LIMIT 65
), functions AS MATERIALIZED (
 SELECT 'function'::text kind,p.proname::text||'('||pg_get_function_identity_arguments(p.oid)||')' key,
 jsonb_build_array(CASE WHEN octet_length(p.prosrc)>16384 THEN NULL ELSE p.prosrc END,p.proowner,p.prolang,p.provolatile,p.prosecdef,p.proleakproof,p.proparallel,p.proisstrict,p.proretset,p.prorettype,CASE WHEN octet_length(p.proconfig::text)>16384 THEN NULL ELSE p.proconfig END) value,octet_length(p.prosrc)>16384 OR coalesce(octet_length(p.proconfig::text)>16384,false) oversized
 FROM known_functions f JOIN pg_proc p ON p.oid=f.oid
 WHERE p.oid IN (to_regprocedure('whaleu_real_deletion.preparation_guard()'),to_regprocedure('whaleu_real_deletion.preparation_unavailable()'),to_regprocedure('whaleu_real_deletion.preparation_catalog()'))
), facts AS MATERIALIZED (
 SELECT 'relation'::text kind,c.relname::text key,jsonb_build_array(c.relkind,c.relpersistence,c.relowner,c.relrowsecurity,c.relforcerowsecurity,CASE WHEN octet_length(c.reloptions::text)>16384 THEN NULL ELSE c.reloptions END,c.relispartition,c.relhassubclass) value,coalesce(octet_length(c.reloptions::text)>16384,false) oversized FROM relations c
 UNION ALL SELECT * FROM columns
 UNION ALL SELECT * FROM constraints
 UNION ALL SELECT 'index',i.indexrelid::regclass::text,jsonb_build_array(CASE WHEN i.source_oversized THEN NULL ELSE pg_get_indexdef(i.indexrelid) END,i.indisvalid,i.indisready,i.indislive),i.source_oversized FROM indexes i
 UNION ALL SELECT * FROM triggers
 UNION ALL SELECT * FROM functions
 UNION ALL SELECT 'unexpected-relation','exists',to_jsonb(EXISTS(
  SELECT 1 FROM pg_class c WHERE c.relnamespace='whaleu_real_deletion'::regnamespace
  AND NOT EXISTS(SELECT 1 FROM objects o WHERE o.oid=c.oid) LIMIT 1)),false
 UNION ALL SELECT 'unexpected-function','exists',to_jsonb(EXISTS(
  SELECT 1 FROM pg_proc p WHERE p.pronamespace='whaleu_real_deletion'::regnamespace
  AND NOT EXISTS(SELECT 1 FROM known_functions f WHERE f.oid=p.oid) LIMIT 1)),false
 LIMIT 129
), sized AS MATERIALIZED (
 SELECT *,octet_length(jsonb_build_array(kind,key,value)::text) bytes FROM facts
), budget AS MATERIALIZED (
 SELECT coalesce(bool_and(NOT oversized),false) AND count(*)<=128 AND coalesce(max(bytes),0)<=32768 AND coalesce(sum(bytes),0)+greatest(count(*)-1,0)*2+2<=262144
  AND (SELECT count(*) FROM columns)<=64 AND (SELECT count(*) FROM constraints)<=64
  AND (SELECT count(*) FROM indexes)<=32 AND (SELECT count(*) FROM triggers)<=64 AS valid FROM sized
), admitted AS MATERIALIZED (
 SELECT kind,key,value FROM sized WHERE bytes<=32768 AND (SELECT valid FROM budget)
)
SELECT CASE WHEN (SELECT valid FROM budget) THEN encode(sha256(convert_to(coalesce(jsonb_agg(jsonb_build_array(kind,key,value) ORDER BY kind COLLATE "C",key COLLATE "C"),'[]'::jsonb)::text,'UTF8')),'hex') ELSE NULL END FROM admitted
$catalog$;
DO $markers$DECLARE preparation_seal text;request_seal text;BEGIN
 preparation_seal:=whaleu_real_deletion.preparation_catalog();request_seal:=whaleu_real_deletion.request_catalog();
 IF preparation_seal IS NULL OR request_seal IS NULL THEN RAISE EXCEPTION 'Real authority schema exceeds finite qualification budget' USING ERRCODE='23514';END IF;
 EXECUTE format('CREATE OR REPLACE FUNCTION whaleu_real_deletion.preparation_protocol() RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS %L',
  'SELECT '||quote_literal(jsonb_build_object('version',2,'protocol','real-account-deletion-preparation-v2','migration','0182_real_deletion_request_authority.sql','acceptance','unavailable','catalog',preparation_seal)::text)||'::jsonb');
 EXECUTE format('CREATE OR REPLACE FUNCTION whaleu_real_deletion.request_protocol() RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS %L',
  'SELECT '||quote_literal(jsonb_build_object('version',1,'protocol','real-account-deletion-request-v1','migration','0182_real_deletion_request_authority.sql','admission','separate_owner_required','catalog',request_seal)::text)||'::jsonb');
END$markers$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA whaleu_real_deletion FROM PUBLIC;
