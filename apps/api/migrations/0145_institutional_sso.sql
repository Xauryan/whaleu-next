-- Bounded institutional verification owner. Empty configuration, no real issuer,
-- credentials, synthetic registration endpoint, role grant, or historical rewrite.
-- Existing migration bytes and document/correction source recipes are retained.
LOCK TABLE whaleu_verification.account_heads,whaleu_verification.snapshots IN SHARE ROW EXCLUSIVE MODE;
CREATE TABLE whaleu_verification.relevant_fact_generations (
 account_id uuid PRIMARY KEY REFERENCES whaleu_verification.account_heads(account_id),
 tracking_epoch uuid NOT NULL DEFAULT gen_random_uuid(),
 affiliation_generation bigint NOT NULL DEFAULT 0 CHECK(affiliation_generation>=0),
 student_number_generation bigint NOT NULL DEFAULT 0 CHECK(student_number_generation>=0)
);
INSERT INTO whaleu_verification.relevant_fact_generations(account_id) SELECT account_id FROM whaleu_verification.account_heads;
CREATE TABLE whaleu_verification.institutional_bindings (
 id uuid PRIMARY KEY,version text NOT NULL UNIQUE CHECK(length(version) BETWEEN 1 AND 200),
 issuer_namespace text NOT NULL CHECK(length(issuer_namespace) BETWEEN 1 AND 200),
 adapter_id text NOT NULL CHECK(length(adapter_id) BETWEEN 1 AND 200),
 campus_id uuid NOT NULL REFERENCES whaleu_campus.campuses(id),
 institution_id uuid NOT NULL REFERENCES whaleu_campus.institutions(id),
 origin_region_id uuid NOT NULL REFERENCES whaleu_campus.operating_regions(id),
 policy_reference text NOT NULL CHECK(policy_reference LIKE 'institutional-sso/%'),
 purpose text NOT NULL CHECK(length(purpose) BETWEEN 1 AND 200),
 audience text NOT NULL CHECK(length(audience) BETWEEN 1 AND 200),
 consent_version text NOT NULL CHECK(length(consent_version) BETWEEN 1 AND 200),
 supports_student_number boolean NOT NULL,enabled boolean NOT NULL DEFAULT false,
 source_fingerprint text NOT NULL CHECK(source_fingerprint~'^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE whaleu_verification.institutional_binding_heads (
 campus_id uuid PRIMARY KEY REFERENCES whaleu_campus.campuses(id),
 binding_id uuid NOT NULL UNIQUE REFERENCES whaleu_verification.institutional_bindings(id),
 revision integer NOT NULL CHECK(revision>0)
);
CREATE TABLE whaleu_verification.institutional_requests (
 account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),request_id uuid NOT NULL,
 request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),
 frozen_context jsonb NOT NULL CHECK(jsonb_typeof(frozen_context)='object' AND octet_length(frozen_context::text)<8192),
 binding_id uuid NOT NULL REFERENCES whaleu_verification.institutional_bindings(id),
 relevant_witness jsonb NOT NULL CHECK(jsonb_typeof(relevant_witness)='object'),
 prepared_at timestamptz NOT NULL DEFAULT clock_timestamp(),request_expires_at timestamptz NOT NULL,
 state text NOT NULL CHECK(state IN('prepared','processing','outcome_unknown','ready_to_finalize','completed','cancelled','rejected','expired','challenge_required','provider_unavailable','conflict','stale')),
 -- Session is an immutable audit UUID, not a retention FK; Identity owns
 -- eventual terminal-session purge, while current issuance still proves it live.
 claim_id uuid UNIQUE,session_id uuid,claimed_at timestamptz,claim_deadline timestamptz,
 result_id uuid UNIQUE,completion_id uuid UNIQUE,receipt jsonb,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 PRIMARY KEY(account_id,request_id),
 CHECK((claim_id IS NULL)=(session_id IS NULL) AND (claim_id IS NULL)=(claimed_at IS NULL) AND (claim_id IS NULL)=(claim_deadline IS NULL)),
 CHECK((state='completed')=(completion_id IS NOT NULL)),
 CHECK((state IN('completed','cancelled','rejected','expired','challenge_required','provider_unavailable','conflict','stale'))=(receipt IS NOT NULL)),
 CHECK(receipt IS NULL OR (jsonb_typeof(receipt)='object' AND octet_length(receipt::text)<4096))
);
CREATE UNIQUE INDEX institutional_one_active_request ON whaleu_verification.institutional_requests(account_id) WHERE state IN('prepared','processing','outcome_unknown','ready_to_finalize');
CREATE TABLE whaleu_verification.institutional_cancel_fences (
 account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),request_id uuid NOT NULL,
 request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),
 receipt jsonb NOT NULL CHECK(jsonb_typeof(receipt)='object' AND octet_length(receipt::text)<4096),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(account_id,request_id)
);
CREATE TABLE whaleu_verification.institutional_request_transitions (
 account_id uuid NOT NULL,request_id uuid NOT NULL,revision integer NOT NULL,
 old_state jsonb,new_state jsonb NOT NULL,
 creation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(account_id,request_id,revision),FOREIGN KEY(account_id,request_id) REFERENCES whaleu_verification.institutional_requests(account_id,request_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE FUNCTION whaleu_verification.institutional_number_safe(value text) RETURNS boolean LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT char_length(value) BETWEEN 1 AND 100 AND value=whaleu_profile.moderation_trim(value)
 AND char_length(value)+(SELECT count(*) FROM regexp_split_to_table(value,'') cp WHERE ascii(cp)>65535)<=100
 AND value !~ U&'[@\0001-\001F\007F-\009F\00AD\0600-\0605\061C\06DD\070F\0890-\0891\08E2\180E\200B-\200F\202A-\202E\2060-\2064\2066-\206F\FEFF\FFF9-\FFFB\+0110BD\+0110CD\+013430-\+01343F\+01BCA0-\+01BCA3\+01D173-\+01D17A\+0E0001\+0E0020-\+0E007F]'
$$;
CREATE TABLE whaleu_verification.institutional_results (
 id uuid PRIMARY KEY,account_id uuid NOT NULL,request_id uuid NOT NULL,claim_id uuid NOT NULL UNIQUE,
 binding_id uuid NOT NULL REFERENCES whaleu_verification.institutional_bindings(id),
 issuer_namespace text NOT NULL,provider_subject text NOT NULL CHECK(length(provider_subject) BETWEEN 1 AND 300),
 institution_id uuid NOT NULL REFERENCES whaleu_campus.institutions(id),origin_region_id uuid NOT NULL REFERENCES whaleu_campus.operating_regions(id),
 policy_reference text NOT NULL,student_number text CHECK(whaleu_verification.institutional_number_safe(student_number)),
 authenticated_at timestamptz NOT NULL,response_use_expires_at timestamptz NOT NULL,fact_expires_at timestamptz NOT NULL,
 evidence_digest text NOT NULL UNIQUE CHECK(evidence_digest~'^[a-f0-9]{64}$'),
 admitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),finalize_deadline timestamptz NOT NULL,
 creation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 UNIQUE(account_id,request_id),FOREIGN KEY(account_id,request_id) REFERENCES whaleu_verification.institutional_requests(account_id,request_id)
);
CREATE TABLE whaleu_verification.institutional_subjects (
 issuer_namespace text NOT NULL,provider_subject text NOT NULL,account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
 first_result_id uuid NOT NULL UNIQUE REFERENCES whaleu_verification.institutional_results(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(issuer_namespace,provider_subject),UNIQUE(issuer_namespace,account_id)
);
CREATE TABLE whaleu_verification.institutional_completions (
 id uuid PRIMARY KEY,account_id uuid NOT NULL,request_id uuid NOT NULL,result_id uuid NOT NULL UNIQUE REFERENCES whaleu_verification.institutional_results(id),
 cause_id uuid NOT NULL UNIQUE REFERENCES whaleu_school_uid.producing_causes(id) DEFERRABLE INITIALLY DEFERRED,
 old_head jsonb NOT NULL,old_snapshot jsonb NOT NULL,relevant_witness jsonb NOT NULL,
 new_affiliation_assertion_id uuid UNIQUE,new_student_number_assertion_id uuid UNIQUE,
 affiliation_assertion_id uuid NOT NULL,student_number_assertion_id uuid,
 snapshot_id uuid NOT NULL UNIQUE,event_id uuid NOT NULL UNIQUE,
 creation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(account_id,request_id),FOREIGN KEY(account_id,request_id) REFERENCES whaleu_verification.institutional_requests(account_id,request_id)
);
CREATE TABLE whaleu_verification.institutional_uid_results (
 completion_id uuid PRIMARY KEY REFERENCES whaleu_verification.institutional_completions(id),
 cause_id uuid NOT NULL UNIQUE REFERENCES whaleu_school_uid.producing_causes(id),event_id uuid NOT NULL UNIQUE REFERENCES whaleu_school_uid.assignment_events(id),
 outcome text NOT NULL CHECK(outcome IN('issued','retained','deferred_unavailable')),
 unavailable_reason text CHECK(unavailable_reason IN('inventory_unknown','account_history_unknown')),
 creation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((outcome='deferred_unavailable')=(unavailable_reason IS NOT NULL))
);
CREATE TABLE whaleu_verification.institutional_descendants (
 assertion_id uuid PRIMARY KEY,account_id uuid NOT NULL,fact_kind text NOT NULL CHECK(fact_kind IN('affiliation','student_number')),
 predecessor_id uuid NOT NULL,old_head jsonb NOT NULL,old_snapshot jsonb NOT NULL,
 creation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(account_id,creation_transaction)
);
ALTER TABLE whaleu_verification.institutional_requests ADD FOREIGN KEY(result_id) REFERENCES whaleu_verification.institutional_results(id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE whaleu_verification.institutional_requests ADD FOREIGN KEY(completion_id) REFERENCES whaleu_verification.institutional_completions(id) DEFERRABLE INITIALLY DEFERRED;

-- Continuity is owned exclusively by actual Verification head transitions.
CREATE FUNCTION whaleu_verification.relevant_fact_generation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF pg_trigger_depth()<>2 OR TG_OP NOT IN('INSERT','UPDATE') THEN RAISE EXCEPTION 'Relevant fact generations are Verification-head owned' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' AND (NEW.account_id<>OLD.account_id OR NEW.tracking_epoch<>OLD.tracking_epoch
 OR NEW.affiliation_generation NOT BETWEEN OLD.affiliation_generation AND OLD.affiliation_generation+1
 OR NEW.student_number_generation NOT BETWEEN OLD.student_number_generation AND OLD.student_number_generation+1)
 THEN RAISE EXCEPTION 'Relevant fact continuity cannot be reset' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER relevant_fact_generation_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_verification.relevant_fact_generations FOR EACH ROW EXECUTE FUNCTION whaleu_verification.relevant_fact_generation_guard();
CREATE TRIGGER relevant_fact_generation_owned BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_verification.relevant_fact_generations FOR EACH STATEMENT EXECUTE FUNCTION whaleu_verification.school_identity_statement_guard();
CREATE TRIGGER relevant_fact_generation_no_truncate BEFORE TRUNCATE ON whaleu_verification.relevant_fact_generations FOR EACH STATEMENT EXECUTE FUNCTION whaleu_verification.immutable_record();
CREATE FUNCTION whaleu_verification.advance_relevant_fact_generations() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_s whaleu_verification.snapshots;new_s whaleu_verification.snapshots;affected integer;
BEGIN
 IF TG_OP='INSERT' THEN INSERT INTO whaleu_verification.relevant_fact_generations(account_id) VALUES(NEW.account_id);RETURN NULL; END IF;
 SELECT * INTO old_s FROM whaleu_verification.snapshots WHERE id=OLD.snapshot_id AND account_id=OLD.account_id;
 SELECT * INTO new_s FROM whaleu_verification.snapshots WHERE id=NEW.snapshot_id AND account_id=NEW.account_id;
 UPDATE whaleu_verification.relevant_fact_generations SET
 affiliation_generation=affiliation_generation+(CASE WHEN old_s.affiliation_assertion_id IS DISTINCT FROM new_s.affiliation_assertion_id THEN 1 ELSE 0 END),
 student_number_generation=student_number_generation+(CASE WHEN old_s.student_number_assertion_id IS DISTINCT FROM new_s.student_number_assertion_id THEN 1 ELSE 0 END)
 WHERE account_id=NEW.account_id;
 GET DIAGNOSTICS affected=ROW_COUNT;
 IF affected<>1 THEN RAISE EXCEPTION 'Missing relevant fact continuity' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER institutional_relevant_fact_transition AFTER INSERT OR UPDATE ON whaleu_verification.account_heads FOR EACH ROW EXECUTE FUNCTION whaleu_verification.advance_relevant_fact_generations();
CREATE FUNCTION whaleu_verification.institutional_continuity_valid() RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT current_setting('session_replication_role')='origin' AND NOT EXISTS(
 SELECT 1 FROM(VALUES
 ('whaleu_verification.account_heads','institutional_relevant_fact_transition','whaleu_verification.advance_relevant_fact_generations()',21),
 ('whaleu_verification.relevant_fact_generations','relevant_fact_generation_guard','whaleu_verification.relevant_fact_generation_guard()',31),
 ('whaleu_verification.relevant_fact_generations','relevant_fact_generation_owned','whaleu_verification.school_identity_statement_guard()',62),
 ('whaleu_verification.relevant_fact_generations','relevant_fact_generation_no_truncate','whaleu_verification.immutable_record()',34)
 ) required(relation_name,trigger_name,function_name,trigger_type) WHERE NOT EXISTS(SELECT 1 FROM pg_trigger t
 WHERE t.tgrelid=required.relation_name::regclass AND t.tgname=required.trigger_name AND t.tgfoid=required.function_name::regprocedure
 AND t.tgenabled='O' AND t.tgtype=required.trigger_type AND NOT t.tgisinternal AND t.tgargs=''::bytea))
 AND NOT EXISTS(SELECT 1 FROM(VALUES
 ('whaleu_verification.advance_relevant_fact_generations()', 'ae0bb2fdd80dccaaf55838b73fa10338'),
 ('whaleu_verification.relevant_fact_generation_guard()', '84d08a321e1d0755f7e7a6612746dbb4'),
 ('whaleu_verification.school_identity_statement_guard()', '50b651b48207a97f634f95b31d7a1075')
 ) source(function_name,source_digest) WHERE NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=source.function_name::regprocedure AND md5(p.prosrc)=source.source_digest))
$$;
CREATE FUNCTION whaleu_verification.relevant_fact_witness(subject uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object('trackingEpoch',g.tracking_epoch,'affiliationGeneration',g.affiliation_generation::text,'studentNumberGeneration',g.student_number_generation::text,
 'affiliationAssertionId',s.affiliation_assertion_id,'studentNumberAssertionId',s.student_number_assertion_id)
 FROM whaleu_verification.relevant_fact_generations g JOIN whaleu_verification.account_heads h ON h.account_id=g.account_id
 JOIN whaleu_verification.snapshots s ON(s.id,s.account_id,s.revision)=(h.snapshot_id,h.account_id,h.revision) WHERE g.account_id=subject AND whaleu_verification.institutional_continuity_valid()
$$;
CREATE FUNCTION whaleu_verification.institutional_binding_head_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR (TG_OP='UPDATE' AND (NEW.campus_id<>OLD.campus_id OR NEW.revision<>OLD.revision+1))
 OR (TG_OP='INSERT' AND NEW.revision<>1) OR NOT EXISTS(SELECT 1 FROM whaleu_verification.institutional_bindings b WHERE b.id=NEW.binding_id AND b.campus_id=NEW.campus_id)
 THEN RAISE EXCEPTION 'Institutional binding head requires exact immutable revision' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER institutional_binding_head_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_verification.institutional_binding_heads FOR EACH ROW EXECUTE FUNCTION whaleu_verification.institutional_binding_head_guard();
CREATE TRIGGER institutional_binding_head_retain BEFORE TRUNCATE ON whaleu_verification.institutional_binding_heads FOR EACH STATEMENT EXECUTE FUNCTION whaleu_verification.immutable_record();
CREATE FUNCTION whaleu_verification.institutional_binding_current(binding uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM whaleu_verification.institutional_bindings b JOIN whaleu_verification.institutional_binding_heads h ON(h.binding_id,h.campus_id)=(b.id,b.campus_id)
 JOIN whaleu_campus.campuses c ON(c.id,c.institution_id)=(b.campus_id,b.institution_id)
 JOIN whaleu_campus.campus_region_assignments a ON(a.campus_id,a.operating_region_id)=(b.campus_id,b.origin_region_id)
 JOIN whaleu_campus.operating_regions r ON r.id=b.origin_region_id WHERE b.id=binding AND b.enabled AND c.is_active AND r.is_active)
$$;
CREATE FUNCTION whaleu_verification.institutional_request_hash(subject uuid,operation uuid,context jsonb) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT encode(sha256(convert_to('whaleu:institutional-sso-command:v1'||chr(10)||subject::text||chr(10)||operation::text||chr(10)||(context->>'campusId')||chr(10)||(context->>'capabilityVersion')||chr(10)||(context->>'consent')||chr(10)||'institutional_verification','UTF8')),'hex')
$$;
CREATE FUNCTION whaleu_verification.institutional_lock(subject uuid,operation uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('whaleu:institutional-active:v1:'||subject::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('whaleu:institutional-request:v1:'||subject::text||':'||operation::text,0));
END $$;
CREATE FUNCTION whaleu_verification.institutional_session_current(subject uuid,session uuid) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT EXISTS(SELECT 1 FROM whaleu_identity.sessions s JOIN whaleu_identity.accounts a ON a.id=s.account_id
 WHERE s.id=session AND s.account_id=subject AND a.status='active' AND s.revoked_at IS NULL
 AND s.access_expires_at>clock_timestamp() AND s.refresh_expires_at>clock_timestamp() AND s.absolute_expires_at>clock_timestamp())
 AND NOT whaleu_safety.account_punishment_effective(subject,'access_suspension')
$$;
CREATE FUNCTION whaleu_verification.institutional_request_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE result whaleu_verification.institutional_results;instant timestamptz:=clock_timestamp();
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Original institutional keys are permanent' USING ERRCODE='23514';END IF;
 PERFORM whaleu_verification.institutional_lock(NEW.account_id,NEW.request_id);
 instant:=clock_timestamp();
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'prepared' OR NEW.claim_id IS NOT NULL OR NEW.result_id IS NOT NULL OR NEW.completion_id IS NOT NULL OR NEW.receipt IS NOT NULL OR NEW.revision<>1
  OR NEW.request_hash IS DISTINCT FROM whaleu_verification.institutional_request_hash(NEW.account_id,NEW.request_id,NEW.frozen_context)
  OR EXISTS(SELECT 1 FROM whaleu_verification.institutional_cancel_fences f WHERE(f.account_id,f.request_id)=(NEW.account_id,NEW.request_id))
  OR NEW.relevant_witness IS DISTINCT FROM whaleu_verification.relevant_fact_witness(NEW.account_id)
  OR whaleu_verification.relevant_fact_witness(NEW.account_id) IS NULL OR NOT whaleu_verification.institutional_context_current(NEW)
  THEN RAISE EXCEPTION 'Institutional prepare requires exact current original intent' USING ERRCODE='23514';END IF;
  NEW.prepared_at:=instant;NEW.request_expires_at:=instant+interval '300 seconds';
 ELSE
  IF (to_jsonb(NEW)-ARRAY['state','claim_id','session_id','claimed_at','claim_deadline','result_id','completion_id','receipt','revision'])
   IS DISTINCT FROM(to_jsonb(OLD)-ARRAY['state','claim_id','session_id','claimed_at','claim_deadline','result_id','completion_id','receipt','revision'])
  OR OLD.state NOT IN('prepared','processing','outcome_unknown','ready_to_finalize') OR NEW.revision<>OLD.revision+1
  OR (OLD.claim_id IS NOT NULL AND (NEW.claim_id,NEW.session_id,NEW.claimed_at,NEW.claim_deadline) IS DISTINCT FROM(OLD.claim_id,OLD.session_id,OLD.claimed_at,OLD.claim_deadline))
  OR (OLD.result_id IS NOT NULL AND NEW.result_id IS DISTINCT FROM OLD.result_id)
  THEN RAISE EXCEPTION 'Institutional request cannot replace its immutable original state' USING ERRCODE='23514';END IF;
  IF NEW.state='processing' THEN
   IF OLD.state<>'prepared' OR NEW.claim_id IS NULL OR NEW.session_id IS NULL OR instant>=OLD.request_expires_at
   OR NOT whaleu_verification.institutional_session_current(NEW.account_id,NEW.session_id)
   OR NOT whaleu_verification.institutional_context_current(NEW)
   OR NEW.relevant_witness IS DISTINCT FROM whaleu_verification.relevant_fact_witness(NEW.account_id)
   THEN RAISE EXCEPTION 'Institutional claim requires original current witness and session' USING ERRCODE='23514';END IF;
   NEW.claimed_at:=instant;NEW.claim_deadline:=least(NEW.request_expires_at,instant+interval '60 seconds');
  ELSIF NEW.state='ready_to_finalize' THEN
   SELECT * INTO result FROM whaleu_verification.institutional_results WHERE id=NEW.result_id;
   IF OLD.state<>'processing' OR result.id IS NULL OR(result.account_id,result.request_id,result.claim_id)<>(NEW.account_id,NEW.request_id,NEW.claim_id)
    OR result.creation_transaction<>pg_current_xact_id() THEN RAISE EXCEPTION 'Institutional admission requires its exact result' USING ERRCODE='23514';END IF;
  ELSIF NEW.state='completed' THEN
   IF OLD.state<>'ready_to_finalize' OR NEW.completion_id IS NULL OR NOT EXISTS(SELECT 1 FROM whaleu_verification.institutional_completions c
    WHERE(c.id,c.account_id,c.request_id,c.result_id)=(NEW.completion_id,NEW.account_id,NEW.request_id,NEW.result_id) AND c.creation_transaction=pg_current_xact_id())
   THEN RAISE EXCEPTION 'Institutional completion requires exact admitted source' USING ERRCODE='23514';END IF;
  ELSIF NEW.state='outcome_unknown' THEN
   IF OLD.state<>'processing' OR NEW.result_id IS NOT NULL THEN RAISE EXCEPTION 'Only an unadmitted claim can become unknown' USING ERRCODE='23514';END IF;
  ELSIF NEW.state='expired' THEN
   SELECT * INTO result FROM whaleu_verification.institutional_results WHERE id=OLD.result_id;
   IF NOT((OLD.state='prepared' AND instant>=OLD.request_expires_at) OR(OLD.state='ready_to_finalize' AND instant>=result.finalize_deadline))
   THEN RAISE EXCEPTION 'Expiry requires original authoritative deadline' USING ERRCODE='23514';END IF;
  ELSIF NEW.state IN('rejected','challenge_required') THEN
   IF OLD.state<>'processing' OR OLD.claim_id IS NULL OR instant>=OLD.claim_deadline OR instant>=OLD.request_expires_at
   THEN RAISE EXCEPTION 'Definitive provider verdict requires its live original claim' USING ERRCODE='23514';END IF;
  ELSIF NEW.state NOT IN('cancelled','provider_unavailable','conflict','stale') THEN
   RAISE EXCEPTION 'Unsupported institutional transition' USING ERRCODE='23514';
  END IF;
  IF NEW.state<>'processing' AND OLD.claim_id IS NULL AND NEW.claim_id IS NOT NULL THEN RAISE EXCEPTION 'Only claim transition establishes session authority' USING ERRCODE='23514';END IF;
  IF NEW.state<>'ready_to_finalize' AND NEW.result_id IS DISTINCT FROM OLD.result_id THEN RAISE EXCEPTION 'Only admission transition establishes proof' USING ERRCODE='23514';END IF;
 END IF;
 IF NEW.receipt IS NOT NULL AND (NEW.receipt->>'requestId' IS DISTINCT FROM NEW.request_id::text OR NEW.receipt->>'requestHash' IS DISTINCT FROM NEW.request_hash OR NEW.receipt->>'state' IS DISTINCT FROM NEW.state)
 THEN RAISE EXCEPTION 'Institutional terminal receipt must preserve original identity' USING ERRCODE='23514';END IF;
 INSERT INTO whaleu_verification.institutional_request_transitions(account_id,request_id,revision,old_state,new_state)
 VALUES(NEW.account_id,NEW.request_id,NEW.revision,CASE WHEN TG_OP='UPDATE' THEN to_jsonb(OLD) ELSE NULL END,to_jsonb(NEW));
 RETURN NEW;
END $$;
CREATE TRIGGER institutional_request_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_verification.institutional_requests FOR EACH ROW EXECUTE FUNCTION whaleu_verification.institutional_request_guard();
CREATE TRIGGER institutional_request_retain BEFORE TRUNCATE ON whaleu_verification.institutional_requests FOR EACH STATEMENT EXECUTE FUNCTION whaleu_verification.immutable_record();
CREATE TRIGGER institutional_transition_owned BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_verification.institutional_request_transitions FOR EACH STATEMENT EXECUTE FUNCTION whaleu_verification.school_identity_statement_guard();
CREATE FUNCTION whaleu_verification.institutional_cancel_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM whaleu_verification.institutional_lock(NEW.account_id,NEW.request_id);
 IF EXISTS(SELECT 1 FROM whaleu_verification.institutional_requests q WHERE(q.account_id,q.request_id)=(NEW.account_id,NEW.request_id))
 OR NEW.receipt->>'requestId' IS DISTINCT FROM NEW.request_id::text OR NEW.receipt->>'requestHash' IS DISTINCT FROM NEW.request_hash OR NEW.receipt->>'state' IS DISTINCT FROM 'cancelled'
 THEN RAISE EXCEPTION 'Absent-key fence must preserve exact cancellation identity' USING ERRCODE='23514';END IF;
 NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER institutional_cancel_guard BEFORE INSERT ON whaleu_verification.institutional_cancel_fences FOR EACH ROW EXECUTE FUNCTION whaleu_verification.institutional_cancel_guard();

CREATE FUNCTION whaleu_verification.institutional_binding_fingerprint(binding uuid) RETURNS text LANGUAGE sql STABLE AS $$
 SELECT whaleu_profile.moderation_hash(jsonb_build_object('binding',to_jsonb(b),'head',to_jsonb(h),'headXmin',h.xmin::text,
 'campus',to_jsonb(c),'campusXmin',c.xmin::text,'assignment',to_jsonb(a),'assignmentXmin',a.xmin::text,'region',to_jsonb(r),'regionXmin',r.xmin::text))
 FROM whaleu_verification.institutional_bindings b JOIN whaleu_verification.institutional_binding_heads h ON(h.binding_id,h.campus_id)=(b.id,b.campus_id)
 JOIN whaleu_campus.campuses c ON c.id=b.campus_id JOIN whaleu_campus.campus_region_assignments a ON a.campus_id=c.id
 JOIN whaleu_campus.operating_regions r ON r.id=a.operating_region_id WHERE b.id=binding
$$;
CREATE FUNCTION whaleu_verification.institutional_context_current(q whaleu_verification.institutional_requests) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT whaleu_verification.institutional_binding_current(q.binding_id) AND EXISTS(SELECT 1 FROM whaleu_verification.institutional_bindings b WHERE b.id=q.binding_id
 AND q.frozen_context->>'campusId'=b.campus_id::text AND q.frozen_context->>'institutionId'=b.institution_id::text
 AND q.frozen_context->>'originRegionId'=b.origin_region_id::text AND q.frozen_context->>'purpose'=b.purpose
 AND q.frozen_context->>'bindingFingerprint'=whaleu_verification.institutional_binding_fingerprint(b.id)
 AND q.frozen_context->>'capabilityVersion'=q.frozen_context->>'bindingFingerprint'
 AND q.frozen_context->>'consent'=b.consent_version
 AND q.frozen_context->>'requestId'=q.request_id::text
 AND whaleu_community.post_owner_visibility_keys(q.frozen_context,ARRAY['requestId','campusId','capabilityVersion','consent','purpose','institutionId','originRegionId','campusVersion','bindingFingerprint']))
$$;
CREATE FUNCTION whaleu_verification.institutional_fact_current(a whaleu_verification.assertions,kind text,institution uuid,instant timestamptz) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT coalesce(a.id IS NOT NULL AND a.fact_kind=kind AND a.assertion_state='verified' AND a.coverage_state='complete' AND a.provenance_state='accepted'
 AND a.source_account_id=a.account_id AND a.issuer_institution_id=institution AND a.source_issuer_institution_id=institution
 AND btrim(a.source_reference)<>'' AND btrim(a.policy_reference)<>'' AND a.phone_binding_reference IS NULL
 AND ((kind='affiliation' AND a.origin_region_id IS NOT NULL AND a.student_number IS NULL AND a.method IN('document_review','institutional_email','institutional_sso','reconciled_import','administrator_correction'))
 OR(kind='student_number' AND a.student_number IS NOT NULL AND whaleu_verification.institutional_number_safe(a.student_number) AND a.method IN('institutional_sso','reconciled_import')))
 AND isfinite(a.verified_at) AND a.verified_at<=instant
 AND ((a.expiry_kind='policy_exempt' AND a.expires_at IS NULL) OR(a.expiry_kind='at' AND isfinite(a.expires_at) AND a.expires_at>a.verified_at AND a.expires_at>instant)),false)
$$;
CREATE FUNCTION whaleu_verification.institutional_result_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q whaleu_verification.institutional_requests;b whaleu_verification.institutional_bindings;instant timestamptz:=clock_timestamp();retained_deadline timestamptz;
BEGIN
 PERFORM whaleu_verification.institutional_lock(NEW.account_id,NEW.request_id);
 SELECT * INTO q FROM whaleu_verification.institutional_requests WHERE(account_id,request_id)=(NEW.account_id,NEW.request_id) FOR UPDATE;
 SELECT * INTO b FROM whaleu_verification.institutional_bindings WHERE id=q.binding_id;
 instant:=clock_timestamp();
 IF q.state IS DISTINCT FROM 'processing' OR q.claim_id IS DISTINCT FROM NEW.claim_id OR q.result_id IS NOT NULL
 OR(NEW.binding_id,NEW.issuer_namespace,NEW.institution_id,NEW.origin_region_id,NEW.policy_reference) IS DISTINCT FROM(b.id,b.issuer_namespace,b.institution_id,b.origin_region_id,b.policy_reference)
 OR NOT whaleu_verification.institutional_session_current(q.account_id,q.session_id)
 OR NOT whaleu_verification.institutional_context_current(q)
 OR q.relevant_witness IS DISTINCT FROM whaleu_verification.relevant_fact_witness(q.account_id)
 OR instant>=q.request_expires_at OR instant>=q.claim_deadline OR instant>=NEW.response_use_expires_at OR instant>=NEW.fact_expires_at
 OR NOT isfinite(NEW.authenticated_at) OR NEW.authenticated_at>instant OR NOT isfinite(NEW.response_use_expires_at)
 OR NEW.response_use_expires_at>q.request_expires_at OR NEW.response_use_expires_at>NEW.authenticated_at+interval '60 seconds'
 OR NEW.fact_expires_at IS DISTINCT FROM NEW.authenticated_at+interval '600 seconds'
 OR(NEW.student_number IS NOT NULL AND NOT b.supports_student_number)
 OR EXISTS(SELECT 1 FROM whaleu_verification.institutional_subjects s WHERE(s.issuer_namespace=NEW.issuer_namespace AND s.provider_subject=NEW.provider_subject AND s.account_id<>NEW.account_id)
 OR(s.issuer_namespace=NEW.issuer_namespace AND s.account_id=NEW.account_id AND s.provider_subject<>NEW.provider_subject))
 OR(NOT EXISTS(SELECT 1 FROM whaleu_verification.institutional_subjects s WHERE(s.issuer_namespace,s.provider_subject,s.account_id)=(NEW.issuer_namespace,NEW.provider_subject,NEW.account_id))
 AND EXISTS(SELECT 1 FROM whaleu_verification.assertions a WHERE a.account_id=NEW.account_id AND a.fact_kind='student_number' AND(a.student_number IS NOT NULL OR a.assertion_state IN('verified','revoked','expired'))))
 THEN RAISE EXCEPTION 'Institutional result requires exact current one-use claim and legitimate subject history' USING ERRCODE='23514';END IF;
 SELECT min(a.expires_at) INTO retained_deadline FROM whaleu_verification.account_heads h JOIN whaleu_verification.snapshots s ON(s.id,s.account_id,s.revision)=(h.snapshot_id,h.account_id,h.revision)
 JOIN whaleu_verification.assertions a ON a.account_id=h.account_id AND a.id IN(s.affiliation_assertion_id,s.student_number_assertion_id)
 WHERE h.account_id=NEW.account_id AND whaleu_verification.institutional_fact_current(a,a.fact_kind,NEW.institution_id,instant) AND a.expiry_kind='at';
 NEW.admitted_at:=instant;NEW.finalize_deadline:=least(q.request_expires_at,instant+interval '120 seconds',NEW.fact_expires_at,retained_deadline);
 NEW.creation_transaction:=pg_current_xact_id();RETURN NEW;
END $$;
CREATE TRIGGER institutional_result_guard BEFORE INSERT ON whaleu_verification.institutional_results FOR EACH ROW EXECUTE FUNCTION whaleu_verification.institutional_result_guard();
CREATE FUNCTION whaleu_verification.institutional_subject_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM whaleu_verification.institutional_results r WHERE(r.id,r.account_id,r.issuer_namespace,r.provider_subject)=(NEW.first_result_id,NEW.account_id,NEW.issuer_namespace,NEW.provider_subject)
 AND r.creation_transaction=pg_current_xact_id()) THEN RAISE EXCEPTION 'Institutional subject must originate in an admitted proof' USING ERRCODE='23514';END IF;
 NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER institutional_subject_guard BEFORE INSERT ON whaleu_verification.institutional_subjects FOR EACH ROW EXECUTE FUNCTION whaleu_verification.institutional_subject_guard();
CREATE FUNCTION whaleu_verification.institutional_result_complete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM whaleu_verification.institutional_requests q WHERE(q.account_id,q.request_id,q.claim_id,q.result_id)=(NEW.account_id,NEW.request_id,NEW.claim_id,NEW.id)
 AND q.state IN('ready_to_finalize','completed','cancelled','rejected','expired','challenge_required','provider_unavailable','conflict','stale')
 AND q.request_expires_at>clock_timestamp() AND q.claim_deadline>clock_timestamp()
 AND NEW.response_use_expires_at>clock_timestamp() AND NEW.fact_expires_at>clock_timestamp()
 AND whaleu_verification.institutional_session_current(q.account_id,q.session_id)
 AND whaleu_verification.institutional_context_current(q)
 AND(q.state='completed' OR q.relevant_witness IS NOT DISTINCT FROM whaleu_verification.relevant_fact_witness(q.account_id)))
 OR NOT EXISTS(SELECT 1 FROM whaleu_verification.institutional_subjects s WHERE(s.issuer_namespace,s.provider_subject,s.account_id)=(NEW.issuer_namespace,NEW.provider_subject,NEW.account_id))
 THEN RAISE EXCEPTION 'Admitted proof must close through its original request and subject owner' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER institutional_result_complete AFTER INSERT ON whaleu_verification.institutional_results DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_verification.institutional_result_complete();

-- This slice permits only covered compatible absence; no renewal/reverification
-- policy is selected. Expired, revoked, or uncertain history needs its owner.
CREATE FUNCTION whaleu_verification.institutional_fact_issuable(a whaleu_verification.assertions,kind text,r whaleu_verification.institutional_results) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT coalesce(a.id IS NOT NULL AND a.fact_kind=kind AND a.account_id=r.account_id AND a.coverage_state='complete' AND a.provenance_state='accepted'
 AND a.source_account_id=r.account_id AND btrim(a.source_reference)<>'' AND btrim(a.policy_reference)<>'' AND a.phone_binding_reference IS NULL
 AND a.assertion_state='unverified' AND a.method IN('native_enrollment','reconciled_import')
 AND a.issuer_institution_id IS NULL AND a.source_issuer_institution_id IS NULL AND a.origin_region_id IS NULL
 AND a.student_number IS NULL AND a.verified_at IS NULL AND a.expiry_kind='policy_exempt' AND a.expires_at IS NULL
 AND NOT EXISTS(SELECT 1 FROM whaleu_verification.assertions history WHERE history.account_id=r.account_id AND history.fact_kind=kind
  AND history.assertion_state IN('verified','revoked','expired')),false)
$$;
CREATE FUNCTION whaleu_verification.institutional_completion_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q whaleu_verification.institutional_requests;r whaleu_verification.institutional_results;h whaleu_verification.account_heads;s whaleu_verification.snapshots;a whaleu_verification.assertions;n whaleu_verification.assertions;instant timestamptz:=clock_timestamp();
BEGIN
 PERFORM whaleu_verification.institutional_lock(NEW.account_id,NEW.request_id);
 SELECT * INTO q FROM whaleu_verification.institutional_requests WHERE(account_id,request_id)=(NEW.account_id,NEW.request_id) FOR UPDATE;
 SELECT * INTO r FROM whaleu_verification.institutional_results WHERE id=q.result_id;
 SELECT * INTO h FROM whaleu_verification.account_heads WHERE account_id=NEW.account_id FOR UPDATE;
 SELECT * INTO s FROM whaleu_verification.snapshots WHERE(id,account_id,revision)=(h.snapshot_id,h.account_id,h.revision);
 SELECT * INTO a FROM whaleu_verification.assertions WHERE(id,account_id)=(s.affiliation_assertion_id,s.account_id);
 SELECT * INTO n FROM whaleu_verification.assertions WHERE(id,account_id)=(s.student_number_assertion_id,s.account_id);
 instant:=clock_timestamp();
 IF q.state IS DISTINCT FROM 'ready_to_finalize' OR r.id IS NULL OR NEW.result_id IS DISTINCT FROM r.id OR instant>=r.finalize_deadline
 OR NOT whaleu_verification.institutional_session_current(q.account_id,q.session_id) OR NOT whaleu_verification.institutional_context_current(q)
 OR NEW.old_head IS DISTINCT FROM to_jsonb(h) OR NEW.old_snapshot IS DISTINCT FROM to_jsonb(s)
 OR NEW.relevant_witness IS DISTINCT FROM q.relevant_witness OR NEW.relevant_witness IS DISTINCT FROM whaleu_verification.relevant_fact_witness(NEW.account_id)
 OR NOT EXISTS(SELECT 1 FROM whaleu_verification.institutional_subjects sub WHERE(sub.issuer_namespace,sub.provider_subject,sub.account_id)=(r.issuer_namespace,r.provider_subject,r.account_id))
 OR(NEW.new_affiliation_assertion_id IS NULL AND(NEW.affiliation_assertion_id IS DISTINCT FROM a.id OR NOT whaleu_verification.institutional_fact_current(a,'affiliation',r.institution_id,instant)))
 OR(NEW.new_affiliation_assertion_id IS NOT NULL AND(NEW.affiliation_assertion_id<>NEW.new_affiliation_assertion_id OR NOT whaleu_verification.institutional_fact_issuable(a,'affiliation',r)))
 OR(NEW.new_student_number_assertion_id IS NULL AND(NEW.student_number_assertion_id IS DISTINCT FROM n.id
  OR NOT(whaleu_verification.institutional_fact_current(n,'student_number',r.institution_id,instant)
    OR(r.student_number IS NULL AND whaleu_verification.institutional_fact_issuable(n,'student_number',r)))
  OR(r.student_number IS NOT NULL AND n.student_number IS DISTINCT FROM r.student_number)))
 OR(NEW.new_student_number_assertion_id IS NOT NULL AND(NEW.student_number_assertion_id<>NEW.new_student_number_assertion_id OR r.student_number IS NULL OR NOT whaleu_verification.institutional_fact_issuable(n,'student_number',r)))
 THEN RAISE EXCEPTION 'Institutional completion requires exact original compatible facts and admitted source' USING ERRCODE='23514';END IF;
 NEW.creation_transaction:=pg_current_xact_id();NEW.recorded_at:=instant;RETURN NEW;
END $$;
CREATE TRIGGER institutional_completion_guard BEFORE INSERT ON whaleu_verification.institutional_completions FOR EACH ROW EXECUTE FUNCTION whaleu_verification.institutional_completion_guard();

ALTER TABLE whaleu_verification.events DROP CONSTRAINT verification_event_kind;
ALTER TABLE whaleu_verification.events DROP CONSTRAINT verification_event_fact;
ALTER TABLE whaleu_verification.events ADD CONSTRAINT verification_event_kind CHECK(kind IN('reconciled_snapshot','revoke','expire','native_enrollment','phone_binding','student_application','student_decision','school_identity_correction','institutional_sso'));
ALTER TABLE whaleu_verification.events ADD CONSTRAINT verification_event_fact CHECK((kind IN('revoke','expire','phone_binding','school_identity_correction') AND fact_kind IS NOT NULL) OR(kind='student_decision' AND(fact_kind IS NULL OR fact_kind='affiliation')) OR(kind IN('reconciled_snapshot','native_enrollment','student_application','institutional_sso') AND fact_kind IS NULL));
CREATE FUNCTION whaleu_verification.institutional_assertion_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c whaleu_verification.institutional_completions;r whaleu_verification.institutional_results;a whaleu_verification.assertions;h whaleu_verification.account_heads;s whaleu_verification.snapshots;prior uuid;
BEGIN
 IF NEW.method<>'institutional_sso' AND NOT starts_with(coalesce(NEW.source_reference,''),'institutional_sso:') AND NOT starts_with(coalesce(NEW.policy_reference,''),'institutional-sso/') THEN RETURN NEW;END IF;
 -- Faithful historical descendants do not require modern reserved namespaces.
 IF NEW.method='institutional_sso' AND NEW.assertion_state IN('revoked','expired') THEN
  SELECT * INTO a FROM whaleu_verification.assertions WHERE(id,account_id)=(NEW.previous_assertion_id,NEW.account_id);
  SELECT * INTO h FROM whaleu_verification.account_heads WHERE account_id=NEW.account_id FOR UPDATE;
  SELECT * INTO s FROM whaleu_verification.snapshots WHERE(id,account_id,revision)=(h.snapshot_id,h.account_id,h.revision);
  prior:=CASE NEW.fact_kind WHEN 'affiliation' THEN s.affiliation_assertion_id WHEN 'student_number' THEN s.student_number_assertion_id END;
  IF a.id IS NULL OR a.method<>'institutional_sso' OR NEW.fact_kind NOT IN('affiliation','student_number') OR a.assertion_state NOT IN('verified','expired') OR prior IS DISTINCT FROM a.id
  OR(to_jsonb(NEW)-ARRAY['id','assertion_state','previous_assertion_id','recorded_at']) IS DISTINCT FROM(to_jsonb(a)-ARRAY['id','assertion_state','previous_assertion_id','recorded_at'])
  OR(NEW.assertion_state='expired' AND(a.assertion_state<>'verified' OR a.expiry_kind<>'at' OR a.expires_at>clock_timestamp()))
  THEN RAISE EXCEPTION 'Institutional descendant requires exact current byte-preserving predecessor' USING ERRCODE='23514';END IF;
  NEW.recorded_at:=clock_timestamp();
  INSERT INTO whaleu_verification.institutional_descendants(assertion_id,account_id,fact_kind,predecessor_id,old_head,old_snapshot)
  VALUES(NEW.id,NEW.account_id,NEW.fact_kind,a.id,to_jsonb(h),to_jsonb(s));RETURN NEW;
 END IF;
 SELECT * INTO c FROM whaleu_verification.institutional_completions WHERE account_id=NEW.account_id AND creation_transaction=pg_current_xact_id()
 AND NEW.id IN(new_affiliation_assertion_id,new_student_number_assertion_id);
 SELECT * INTO r FROM whaleu_verification.institutional_results WHERE id=c.result_id;
 prior:=(c.old_snapshot->>CASE NEW.fact_kind WHEN 'affiliation' THEN 'affiliation_assertion_id' WHEN 'student_number' THEN 'student_number_assertion_id' END)::uuid;
 IF c.id IS NULL OR r.id IS NULL OR NEW.method<>'institutional_sso' OR NEW.assertion_state<>'verified' OR NEW.fact_kind NOT IN('affiliation','student_number')
 OR NEW.coverage_state<>'complete' OR NEW.provenance_state<>'accepted' OR NEW.source_account_id IS DISTINCT FROM NEW.account_id
 OR NEW.source_reference IS DISTINCT FROM 'institutional_sso:'||c.id::text OR NEW.policy_reference IS DISTINCT FROM r.policy_reference
 OR NEW.issuer_institution_id IS DISTINCT FROM r.institution_id OR NEW.source_issuer_institution_id IS DISTINCT FROM r.institution_id
 OR NEW.origin_region_id IS DISTINCT FROM r.origin_region_id OR NEW.phone_binding_reference IS NOT NULL
 OR NEW.previous_assertion_id IS DISTINCT FROM prior OR NEW.verified_at IS DISTINCT FROM r.authenticated_at OR NEW.expiry_kind<>'at' OR NEW.expires_at IS DISTINCT FROM r.fact_expires_at
 OR(NEW.fact_kind='affiliation' AND(NEW.id IS DISTINCT FROM c.new_affiliation_assertion_id OR NEW.student_number IS NOT NULL))
 OR(NEW.fact_kind='student_number' AND(NEW.id IS DISTINCT FROM c.new_student_number_assertion_id OR NEW.student_number IS DISTINCT FROM r.student_number OR NEW.student_number IS NULL))
 THEN RAISE EXCEPTION 'Fresh institutional assertion requires its exact admitted completion' USING ERRCODE='23514';END IF;
 NEW.recorded_at:=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER institutional_assertion_guard BEFORE INSERT ON whaleu_verification.assertions FOR EACH ROW EXECUTE FUNCTION whaleu_verification.institutional_assertion_guard();
CREATE TRIGGER institutional_descendant_owned BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_verification.institutional_descendants FOR EACH STATEMENT EXECUTE FUNCTION whaleu_verification.school_identity_statement_guard();
CREATE FUNCTION whaleu_verification.institutional_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.kind='institutional_sso' AND NOT EXISTS(SELECT 1 FROM whaleu_verification.institutional_completions c
 WHERE c.creation_transaction=pg_current_xact_id() AND(c.event_id,c.account_id,c.request_id,c.snapshot_id)=(NEW.id,NEW.account_id,NEW.operation_id,NEW.snapshot_id)
 AND NEW.actor_account_id=NEW.account_id AND NEW.fact_kind IS NULL AND NEW.expected_revision=(c.old_head->>'revision')::integer
 AND NEW.revision=NEW.expected_revision+1 AND NEW.reason_code='institutional_verified')
 THEN RAISE EXCEPTION 'Institutional event requires exact compound completion' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER institutional_event_guard BEFORE INSERT ON whaleu_verification.events FOR EACH ROW EXECUTE FUNCTION whaleu_verification.institutional_event_guard();
CREATE FUNCTION whaleu_verification.institutional_pointer_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prior uuid;next_id uuid;kind text;a whaleu_verification.assertions;old_s whaleu_verification.snapshots;new_s whaleu_verification.snapshots;fresh whaleu_verification.institutional_completions;d whaleu_verification.institutional_descendants;
BEGIN
 IF TG_TABLE_NAME='account_heads' THEN
  SELECT * INTO old_s FROM whaleu_verification.snapshots WHERE(id,account_id)=(OLD.snapshot_id,OLD.account_id);
  SELECT * INTO new_s FROM whaleu_verification.snapshots WHERE(id,account_id)=(NEW.snapshot_id,NEW.account_id);
 ELSE new_s:=NEW;END IF;
 FOREACH kind IN ARRAY ARRAY['affiliation','student_number'] LOOP
  prior:=CASE kind WHEN 'affiliation' THEN old_s.affiliation_assertion_id ELSE old_s.student_number_assertion_id END;
  next_id:=CASE kind WHEN 'affiliation' THEN new_s.affiliation_assertion_id ELSE new_s.student_number_assertion_id END;
  SELECT * INTO a FROM whaleu_verification.assertions WHERE(id,account_id)=(next_id,NEW.account_id);
  IF a.method IS DISTINCT FROM 'institutional_sso' THEN CONTINUE;END IF;
  SELECT * INTO fresh FROM whaleu_verification.institutional_completions c WHERE c.creation_transaction=pg_current_xact_id()
   AND next_id IN(c.new_affiliation_assertion_id,c.new_student_number_assertion_id);
  SELECT * INTO d FROM whaleu_verification.institutional_descendants WHERE assertion_id=next_id AND creation_transaction=pg_current_xact_id();
  IF TG_TABLE_NAME='account_heads' THEN
   IF prior IS NOT DISTINCT FROM next_id THEN CONTINUE;END IF;
   IF NOT(fresh.id IS NOT NULL AND fresh.snapshot_id=NEW.snapshot_id) AND NOT(d.assertion_id IS NOT NULL AND d.old_head=to_jsonb(OLD)
    AND new_s.revision=(d.old_head->>'revision')::integer+1)
   THEN RAISE EXCEPTION 'Institutional pointer cannot revive or adopt an unrelated assertion' USING ERRCODE='23514';END IF;
  ELSE
   IF fresh.id IS NOT NULL AND fresh.snapshot_id<>NEW.id THEN RAISE EXCEPTION 'Fresh institutional assertion belongs to exactly one snapshot' USING ERRCODE='23514';END IF;
   IF d.assertion_id IS NOT NULL AND (NEW.revision<>(d.old_head->>'revision')::integer+1 OR NEW.account_id<>d.account_id)
   THEN RAISE EXCEPTION 'Institutional descendant belongs to its exact successor snapshot' USING ERRCODE='23514';END IF;
   IF fresh.id IS NULL AND d.assertion_id IS NULL AND NOT EXISTS(SELECT 1 FROM whaleu_verification.account_heads h JOIN whaleu_verification.snapshots s ON(s.id,s.account_id,s.revision)=(h.snapshot_id,h.account_id,h.revision)
    WHERE h.account_id=NEW.account_id AND next_id=CASE kind WHEN 'affiliation' THEN s.affiliation_assertion_id ELSE s.student_number_assertion_id END)
   THEN RAISE EXCEPTION 'Independent snapshot may retain only the current institutional pointer' USING ERRCODE='23514';END IF;
  END IF;
 END LOOP;
 RETURN NEW;
END $$;
CREATE TRIGGER institutional_pointer_guard BEFORE INSERT ON whaleu_verification.snapshots FOR EACH ROW EXECUTE FUNCTION whaleu_verification.institutional_pointer_guard();
CREATE TRIGGER institutional_pointer_guard BEFORE UPDATE ON whaleu_verification.account_heads FOR EACH ROW EXECUTE FUNCTION whaleu_verification.institutional_pointer_guard();
CREATE FUNCTION whaleu_verification.institutional_descendant_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a whaleu_verification.assertions;
BEGIN
 SELECT * INTO a FROM whaleu_verification.assertions WHERE(id,account_id)=(NEW.assertion_id,NEW.account_id);
 IF NOT EXISTS(SELECT 1 FROM whaleu_verification.snapshots s JOIN whaleu_verification.account_heads h ON(s.id,s.account_id,s.revision)=(h.snapshot_id,h.account_id,h.revision)
 JOIN whaleu_verification.events e ON(e.snapshot_id,e.account_id,e.revision)=(s.id,s.account_id,s.revision)
 WHERE s.account_id=NEW.account_id AND s.revision=(NEW.old_head->>'revision')::integer+1
 AND s.affiliation_assertion_id IS NOT DISTINCT FROM CASE NEW.fact_kind WHEN 'affiliation' THEN NEW.assertion_id ELSE(NEW.old_snapshot->>'affiliation_assertion_id')::uuid END
 AND s.student_number_assertion_id IS NOT DISTINCT FROM CASE NEW.fact_kind WHEN 'student_number' THEN NEW.assertion_id ELSE(NEW.old_snapshot->>'student_number_assertion_id')::uuid END
 AND s.phone_assertion_id IS NOT DISTINCT FROM(NEW.old_snapshot->>'phone_assertion_id')::uuid
 AND s.application_state=NEW.old_snapshot->>'application_state' AND s.application_coverage=NEW.old_snapshot->>'application_coverage'
 AND e.kind=CASE a.assertion_state WHEN 'revoked' THEN 'revoke' WHEN 'expired' THEN 'expire' END AND e.fact_kind=NEW.fact_kind
 AND e.expected_revision=(NEW.old_head->>'revision')::integer AND e.recorded_at>=NEW.recorded_at)
 OR EXISTS(SELECT 1 FROM whaleu_school_uid.producing_causes c WHERE c.account_id=NEW.account_id AND c.creation_transaction=pg_current_xact_id())
 OR EXISTS(SELECT 1 FROM whaleu_school_uid.assignment_events e WHERE e.account_id=NEW.account_id AND e.creation_transaction=pg_current_xact_id())
 OR EXISTS(SELECT 1 FROM whaleu_verification.institutional_results r WHERE r.account_id=NEW.account_id AND r.creation_transaction=pg_current_xact_id())
 OR EXISTS(SELECT 1 FROM whaleu_verification.institutional_completions c WHERE c.account_id=NEW.account_id AND c.creation_transaction=pg_current_xact_id())
 THEN RAISE EXCEPTION 'Institutional descendant requires exact one-fact denial and no new admission or UID mutation' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER institutional_descendant_complete AFTER INSERT ON whaleu_verification.institutional_descendants DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_verification.institutional_descendant_complete();

-- Same immutable first V0, exact full-vector +1 slot advance and one-row source
-- ownership as 0142. Only a protected institutional completion selects 2/3/4.
ALTER TABLE whaleu_verification.school_identity_source_statements DROP CONSTRAINT school_identity_source_statements_phase_check;
ALTER TABLE whaleu_verification.school_identity_source_statements ADD CONSTRAINT school_identity_source_statements_phase_check CHECK(phase BETWEEN 1 AND 4);
CREATE FUNCTION whaleu_verification.institutional_recipe(completion uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT (CASE WHEN c.new_affiliation_assertion_id IS NOT NULL THEN jsonb_build_array(jsonb_build_object('id',c.new_affiliation_assertion_id,'fact','affiliation')) ELSE '[]'::jsonb END)
 ||(CASE WHEN c.new_student_number_assertion_id IS NOT NULL THEN jsonb_build_array(jsonb_build_object('id',c.new_student_number_assertion_id,'fact','student_number')) ELSE '[]'::jsonb END)
 FROM whaleu_verification.institutional_completions c WHERE c.id=completion AND c.creation_transaction=pg_current_xact_id()
$$;
CREATE OR REPLACE FUNCTION whaleu_verification.school_identity_source_before() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p whaleu_verification.school_identity_source_proofs; c whaleu_school_uid.producing_causes; step integer; expected jsonb; recipe jsonb; n integer;
BEGIN
 SELECT * INTO p FROM whaleu_verification.school_identity_source_proofs WHERE creation_transaction=pg_current_xact_id();
 IF p.cause_id IS NULL THEN RETURN NULL; END IF;
 SELECT * INTO c FROM whaleu_school_uid.producing_causes WHERE id=p.cause_id;
 SELECT coalesce(max(phase),0)+1 INTO step FROM whaleu_verification.school_identity_source_statements WHERE cause_id=p.cause_id;
 SELECT after_vector INTO expected FROM whaleu_verification.school_identity_source_statements WHERE cause_id=p.cause_id AND phase=step-1;
 IF step=1 THEN expected:=p.initial_vector; END IF;
 IF c.kind='institutional_sso' THEN
  recipe:=whaleu_verification.institutional_recipe(c.source_id);n:=jsonb_array_length(recipe)+2;
  IF recipe IS NULL OR step>n OR TG_TABLE_NAME IS DISTINCT FROM(CASE WHEN step<=n-2 THEN 'assertions' WHEN step=n-1 THEN 'snapshots' ELSE 'account_heads' END)
   OR TG_OP IS DISTINCT FROM(CASE WHEN step=n THEN 'UPDATE' ELSE 'INSERT' END)
   OR expected IS NULL OR expected IS DISTINCT FROM whaleu_verification.school_identity_admission_vector()
  THEN RAISE EXCEPTION 'Unexpected institutional source statement' USING ERRCODE='23514';END IF;
 ELSIF c.kind NOT IN('correct_school','student_approval') OR step>3
 OR TG_TABLE_NAME IS DISTINCT FROM (CASE step WHEN 1 THEN 'assertions' WHEN 2 THEN 'snapshots' WHEN 3 THEN 'account_heads' END)
 OR TG_OP IS DISTINCT FROM (CASE step WHEN 3 THEN 'UPDATE' ELSE 'INSERT' END)
 OR expected IS NULL OR expected IS DISTINCT FROM whaleu_verification.school_identity_admission_vector()
 THEN RAISE EXCEPTION 'Unexpected or foreign school identity source statement' USING ERRCODE='23514'; END IF;
 INSERT INTO whaleu_verification.school_identity_source_statements(cause_id,phase,relation_name,operation,before_vector) VALUES(p.cause_id,step,TG_TABLE_SCHEMA||'.'||TG_TABLE_NAME,TG_OP,expected);
 RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION whaleu_verification.school_identity_source_after() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p whaleu_verification.school_identity_source_proofs; c whaleu_school_uid.producing_causes; j whaleu_verification.school_identity_source_statements; v jsonb; row_data jsonb; delta record; delta_count integer; prior_slot integer; completion whaleu_verification.institutional_completions; recipe jsonb; n integer; item jsonb;
BEGIN
 SELECT * INTO p FROM whaleu_verification.school_identity_source_proofs WHERE creation_transaction=pg_current_xact_id();
 IF p.cause_id IS NULL THEN RETURN NULL; END IF;
 SELECT * INTO c FROM whaleu_school_uid.producing_causes WHERE id=p.cause_id;
 SELECT * INTO j FROM whaleu_verification.school_identity_source_statements WHERE cause_id=p.cause_id AND after_vector IS NULL;
 v:=whaleu_verification.school_identity_admission_vector(); row_data:=j.new_rows->0;
 IF j.cause_id IS NULL OR j.relation_name<>TG_TABLE_SCHEMA||'.'||TG_TABLE_NAME OR j.operation<>TG_OP
 OR jsonb_array_length(j.new_rows)<>1 OR row_data->>'account_id' IS DISTINCT FROM c.account_id::text
 THEN RAISE EXCEPTION 'School identity source requires exactly its own row' USING ERRCODE='23514'; END IF;
 SELECT count(*) INTO delta_count FROM jsonb_each_text(j.before_vector) b FULL JOIN jsonb_each_text(v) a USING(key) WHERE b.value IS DISTINCT FROM a.value;
 SELECT coalesce(a.key,b.key) key,b.value before_value,a.value after_value INTO delta FROM jsonb_each_text(j.before_vector) b FULL JOIN jsonb_each_text(v) a USING(key) WHERE b.value IS DISTINCT FROM a.value;
 SELECT writer_slot INTO prior_slot FROM whaleu_verification.school_identity_source_statements WHERE cause_id=p.cause_id AND phase=j.phase-1;
 IF delta_count<>1 OR delta.after_value IS NULL OR delta.after_value::numeric IS DISTINCT FROM coalesce(delta.before_value::numeric,0)+1
 OR (j.phase>1 AND delta.key::integer IS DISTINCT FROM prior_slot)
 OR NOT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid() AND granted AND mode='ExclusiveLock'
  AND classid=whaleu_community.related_sync_generation_namespace('admission')::oid AND objsubid=2 AND objid=delta.key::oid)
 THEN RAISE EXCEPTION 'School identity source has an unexplained admission-generation delta' USING ERRCODE='23514'; END IF;
 IF c.kind='institutional_sso' THEN
  SELECT * INTO completion FROM whaleu_verification.institutional_completions WHERE id=c.source_id AND cause_id=c.id AND creation_transaction=pg_current_xact_id();
  recipe:=whaleu_verification.institutional_recipe(c.source_id);n:=jsonb_array_length(recipe)+2;item:=recipe->(j.phase-1);
  IF completion.id IS NULL OR recipe IS NULL
  OR(j.phase<=n-2 AND(row_data->>'id' IS DISTINCT FROM item->>'id' OR row_data->>'fact_kind' IS DISTINCT FROM item->>'fact'
   OR row_data->>'assertion_state'<>'verified' OR row_data->>'issuer_institution_id' IS DISTINCT FROM c.institution_id::text
   OR row_data->>'previous_assertion_id' IS DISTINCT FROM p.old_snapshot->>(CASE item->>'fact' WHEN 'affiliation' THEN 'affiliation_assertion_id' ELSE 'student_number_assertion_id' END)))
  OR(j.phase=n-1 AND(row_data->>'id' IS DISTINCT FROM c.snapshot_id::text OR(row_data->>'revision')::integer<>c.old_revision+1
   OR row_data->>'affiliation_assertion_id' IS DISTINCT FROM completion.affiliation_assertion_id::text
   OR row_data->>'student_number_assertion_id' IS DISTINCT FROM completion.student_number_assertion_id::text
   OR row_data->'phone_assertion_id' IS DISTINCT FROM p.old_snapshot->'phone_assertion_id'
   OR row_data->'application_state' IS DISTINCT FROM p.old_snapshot->'application_state' OR row_data->'application_coverage' IS DISTINCT FROM p.old_snapshot->'application_coverage'))
  OR(j.phase=n AND(j.old_rows IS DISTINCT FROM jsonb_build_array(p.old_head) OR row_data IS DISTINCT FROM jsonb_build_object('account_id',c.account_id,'revision',c.old_revision+1,'snapshot_id',c.snapshot_id)))
  THEN RAISE EXCEPTION 'Institutional source row does not match protected recipe' USING ERRCODE='23514';END IF;
 ELSIF j.phase=1 AND (row_data->>'id' IS DISTINCT FROM c.affiliation_assertion_id::text OR row_data->>'fact_kind'<>'affiliation' OR row_data->>'assertion_state'<>'verified'
  OR row_data->>'issuer_institution_id' IS DISTINCT FROM c.institution_id::text
  OR row_data->>'previous_assertion_id' IS DISTINCT FROM p.old_snapshot->>'affiliation_assertion_id')
 OR j.phase=2 AND (row_data->>'id' IS DISTINCT FROM c.snapshot_id::text OR (row_data->>'revision')::integer<>c.old_revision+1
  OR row_data->>'affiliation_assertion_id' IS DISTINCT FROM c.affiliation_assertion_id::text
  OR row_data->'student_number_assertion_id' IS DISTINCT FROM p.old_snapshot->'student_number_assertion_id'
  OR row_data->'phone_assertion_id' IS DISTINCT FROM p.old_snapshot->'phone_assertion_id'
  OR (c.kind='correct_school' AND (row_data->'application_state' IS DISTINCT FROM p.old_snapshot->'application_state' OR row_data->'application_coverage' IS DISTINCT FROM p.old_snapshot->'application_coverage'))
  OR (c.kind='student_approval' AND (row_data->>'application_state'<>'none' OR row_data->>'application_coverage'<>'complete')))
 OR j.phase=3 AND (j.old_rows IS DISTINCT FROM jsonb_build_array(p.old_head) OR row_data IS DISTINCT FROM jsonb_build_object('account_id',c.account_id,'revision',c.old_revision+1,'snapshot_id',c.snapshot_id))
 THEN RAISE EXCEPTION 'School identity source row does not match its exact cause and predecessor' USING ERRCODE='23514'; END IF;
 UPDATE whaleu_verification.school_identity_source_statements SET after_vector=v,writer_slot=delta.key::integer WHERE cause_id=p.cause_id AND phase=j.phase;
 RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION whaleu_verification.school_identity_source_final(cause uuid) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE p whaleu_verification.school_identity_source_proofs; c whaleu_school_uid.producing_causes; expected jsonb; n integer;
BEGIN
 LOCK TABLE whaleu_verification.assertions,whaleu_verification.snapshots,whaleu_verification.account_heads,whaleu_community.related_sync_admission_generation IN SHARE MODE NOWAIT;
 SELECT * INTO p FROM whaleu_verification.school_identity_source_proofs WHERE cause_id=cause AND creation_transaction=pg_current_xact_id();
 SELECT * INTO c FROM whaleu_school_uid.producing_causes WHERE id=cause AND creation_transaction=pg_current_xact_id();
 n:=CASE WHEN c.kind='institutional_sso' THEN jsonb_array_length(whaleu_verification.institutional_recipe(c.source_id))+2 WHEN c.kind IN('correct_school','student_approval') THEN 3 ELSE 0 END;
 IF n IS NULL OR p.cause_id IS NULL OR c.id IS NULL OR NOT EXISTS(SELECT 1 FROM whaleu_verification.school_identity_source_observations o WHERE o.id=p.observation_id AND o.account_id=c.account_id AND o.creation_transaction=pg_current_xact_id() AND o.initial_vector=p.initial_vector) OR (SELECT count(*) FROM whaleu_verification.school_identity_source_statements WHERE cause_id=cause)<>n
 OR EXISTS(SELECT 1 FROM whaleu_verification.school_identity_source_statements WHERE cause_id=cause AND (after_vector IS NULL OR jsonb_array_length(new_rows)<>1)) THEN RETURN false; END IF;
 IF n=0 THEN expected:=p.initial_vector; ELSE SELECT after_vector INTO expected FROM whaleu_verification.school_identity_source_statements WHERE cause_id=cause AND phase=n; END IF;
 IF expected IS DISTINCT FROM whaleu_verification.school_identity_admission_vector() THEN RETURN false; END IF;
 IF n=0 THEN RETURN EXISTS(SELECT 1 FROM whaleu_verification.account_heads h WHERE h.account_id=c.account_id AND to_jsonb(h)=p.old_head); END IF;
 RETURN EXISTS(SELECT 1 FROM whaleu_verification.account_heads h WHERE h.account_id=c.account_id AND h.snapshot_id=c.snapshot_id AND h.revision=c.old_revision+1);
END $$;

-- Distinct causal owner, never a document review or management impersonation.
ALTER TABLE whaleu_school_uid.producing_causes DROP CONSTRAINT producing_causes_kind_check;
ALTER TABLE whaleu_school_uid.producing_causes ADD CONSTRAINT producing_causes_kind_check CHECK(kind IN('student_approval','correct_school','complete_uid','unchanged','imported','institutional_sso'));
CREATE FUNCTION whaleu_verification.institutional_source_valid(c whaleu_school_uid.producing_causes) RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
DECLARE x whaleu_verification.institutional_completions;q whaleu_verification.institutional_requests;r whaleu_verification.institutional_results;
BEGIN
 SELECT * INTO x FROM whaleu_verification.institutional_completions WHERE id=c.source_id;
 SELECT * INTO q FROM whaleu_verification.institutional_requests WHERE(account_id,request_id)=(x.account_id,x.request_id);
 SELECT * INTO r FROM whaleu_verification.institutional_results WHERE id=x.result_id;
 RETURN coalesce(c.kind='institutional_sso' AND x.id IS NOT NULL AND r.id IS NOT NULL AND c.creation_transaction=pg_current_xact_id() AND x.creation_transaction=c.creation_transaction
 AND(c.id,c.account_id,c.actor_account_id,c.affiliation_assertion_id,c.snapshot_id,c.verification_event_id,c.institution_id,c.old_snapshot_id,c.old_revision)
  =(x.cause_id,x.account_id,x.account_id,x.affiliation_assertion_id,x.snapshot_id,x.event_id,r.institution_id,(x.old_head->>'snapshot_id')::uuid,(x.old_head->>'revision')::integer)
 AND q.result_id=r.id AND q.state IN('ready_to_finalize','completed') AND q.relevant_witness=x.relevant_witness
 AND r.finalize_deadline>clock_timestamp() AND whaleu_verification.institutional_session_current(q.account_id,q.session_id)
 AND whaleu_verification.institutional_context_current(q)
 AND EXISTS(SELECT 1 FROM whaleu_verification.institutional_subjects sub WHERE(sub.issuer_namespace,sub.provider_subject,sub.account_id)=(r.issuer_namespace,r.provider_subject,r.account_id)),false);
END $$;
CREATE FUNCTION whaleu_verification.institutional_uid_result_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM whaleu_verification.institutional_completions x JOIN whaleu_school_uid.producing_causes c ON(c.id,c.source_id)=(x.cause_id,x.id)
 JOIN whaleu_school_uid.assignment_events e ON e.cause_id=c.id WHERE(x.id,c.id,e.id,e.outcome)=(NEW.completion_id,NEW.cause_id,NEW.event_id,NEW.outcome)
 AND e.unavailable_reason IS NOT DISTINCT FROM NEW.unavailable_reason AND c.kind='institutional_sso' AND c.creation_transaction=pg_current_xact_id()
 AND x.creation_transaction=c.creation_transaction AND e.creation_transaction=c.creation_transaction)
 THEN RAISE EXCEPTION 'Institutional UID result requires exact distinct source outcome' USING ERRCODE='23514';END IF;
 NEW.creation_transaction:=pg_current_xact_id();NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER institutional_uid_result_guard BEFORE INSERT ON whaleu_verification.institutional_uid_results FOR EACH ROW EXECUTE FUNCTION whaleu_verification.institutional_uid_result_guard();

CREATE OR REPLACE FUNCTION whaleu_school_uid.cause_source_valid(c whaleu_school_uid.producing_causes) RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
BEGIN
 IF c.creation_transaction<>pg_current_xact_id() THEN RETURN false; END IF;
 IF c.kind='institutional_sso' THEN RETURN whaleu_verification.institutional_source_valid(c);END IF;
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
CREATE OR REPLACE FUNCTION whaleu_school_uid.cause_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('whaleu:school-uid-account:v1:'||NEW.account_id::text,0));
 NEW.creation_transaction:=pg_current_xact_id();NEW.created_at:=clock_timestamp();
 IF NOT EXISTS(SELECT 1 FROM whaleu_verification.account_heads h WHERE h.account_id=NEW.account_id AND h.snapshot_id=NEW.old_snapshot_id AND h.revision=NEW.old_revision)
 OR (NEW.coverage_observation_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM whaleu_school_uid.native_absence_observations o WHERE o.id=NEW.coverage_observation_id AND o.account_id=NEW.account_id AND o.creation_transaction=pg_current_xact_id()))
 OR (NEW.kind IN('student_approval','correct_school','complete_uid','institutional_sso') AND EXISTS(SELECT 1 FROM whaleu_school_uid.account_heads h WHERE h.account_id=NEW.account_id AND h.allocation_id IS NOT NULL) AND whaleu_school_uid.runtime_history_known(NEW) IS DISTINCT FROM true)
 OR (NEW.kind IN('student_approval','institutional_sso') AND whaleu_school_uid.cause_source_valid(NEW) IS DISTINCT FROM true)
 THEN RAISE EXCEPTION 'UID cause requires exact pre-write source' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION whaleu_school_uid.event_insert() RETURNS trigger LANGUAGE plpgsql AS $$
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
 OR (NEW.outcome='deferred_unavailable' AND (c.kind NOT IN('student_approval','institutional_sso') OR h.allocation_id IS NOT NULL OR
  (NEW.unavailable_reason='inventory_unknown' AND (whaleu_school_uid.runtime_history_known(c) IS DISTINCT FROM true OR EXISTS(SELECT 1 FROM whaleu_school_uid.admission_heads ah JOIN whaleu_school_uid.school_admissions ad ON ad.id=ah.admission_id WHERE ah.institution_id=c.institution_id AND ad.issuance_available))) OR
  (NEW.unavailable_reason='account_history_unknown' AND whaleu_school_uid.runtime_history_known(c) IS TRUE)))
 THEN RAISE EXCEPTION 'UID event requires exact cause outcome and head predecessor' USING ERRCODE='23514'; END IF;
 NEW.creation_transaction:=pg_current_xact_id();NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION whaleu_school_uid.producing_cause_complete(cause_id uuid) RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
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
  IF c.kind NOT IN('student_approval','institutional_sso') OR e.resulting_allocation_id IS NOT NULL OR e.previous_allocation_id IS NOT NULL
   OR EXISTS(SELECT 1 FROM whaleu_school_uid.allocations WHERE allocations.cause_id=c.id)
   OR (e.unavailable_reason='inventory_unknown' AND (whaleu_school_uid.runtime_history_known(c) IS DISTINCT FROM true OR EXISTS(SELECT 1 FROM whaleu_school_uid.admission_heads ah JOIN whaleu_school_uid.school_admissions ad ON ad.id=ah.admission_id WHERE ah.institution_id=c.institution_id AND ad.issuance_available)))
   OR (e.unavailable_reason='account_history_unknown' AND whaleu_school_uid.runtime_history_known(c) IS TRUE) THEN RETURN false; END IF;
 END IF;
 IF c.kind='student_approval' THEN
  RETURN EXISTS(SELECT 1 FROM whaleu_school_uid.issuance_decisions d WHERE d.student_decision_id=c.source_id AND d.cause_id=c.id AND d.event_id=e.id AND d.outcome=e.outcome AND d.unavailable_reason IS NOT DISTINCT FROM e.unavailable_reason AND d.creation_transaction=c.creation_transaction);
 END IF;
 IF c.kind='institutional_sso' THEN
  RETURN NOT EXISTS(SELECT 1 FROM whaleu_school_uid.issuance_decisions d WHERE d.cause_id=c.id)
  AND EXISTS(SELECT 1 FROM whaleu_verification.institutional_uid_results r WHERE r.completion_id=c.source_id AND r.cause_id=c.id AND r.event_id=e.id
   AND r.outcome=e.outcome AND r.unavailable_reason IS NOT DISTINCT FROM e.unavailable_reason AND r.creation_transaction=c.creation_transaction);
 END IF;
 RETURN NOT EXISTS(SELECT 1 FROM whaleu_school_uid.issuance_decisions d WHERE d.cause_id=c.id);
END $$;
CREATE OR REPLACE FUNCTION whaleu_school_uid.completion_source_valid(c whaleu_school_uid.producing_causes) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
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
 -- A committed institutional source may later complete its still-current UID
 -- through the existing explicitly authorized completion command.
 IF EXISTS(SELECT 1 FROM whaleu_verification.institutional_completions x
 JOIN whaleu_verification.institutional_requests q ON(q.account_id,q.request_id,q.completion_id)=(x.account_id,x.request_id,x.id)
 JOIN whaleu_verification.institutional_results r ON r.id=x.result_id
 JOIN whaleu_verification.institutional_subjects sub ON(sub.issuer_namespace,sub.provider_subject,sub.account_id)=(r.issuer_namespace,r.provider_subject,r.account_id)
 JOIN whaleu_verification.events e ON(e.id,e.account_id,e.snapshot_id)=(x.event_id,x.account_id,x.snapshot_id)
 JOIN whaleu_verification.institutional_uid_results u ON(u.completion_id,u.cause_id)=(x.id,x.cause_id)
 WHERE x.account_id=c.account_id AND x.affiliation_assertion_id=c.affiliation_assertion_id AND r.institution_id=c.institution_id
 AND q.state='completed' AND e.kind='institutional_sso' AND e.fact_kind IS NULL AND u.outcome IN('issued','retained','deferred_unavailable')) THEN RETURN true;END IF;
 -- Covered imported absence requires an exact admitted account crosswalk entry.
 RETURN EXISTS(SELECT 1 FROM whaleu_school_uid.account_coverage cv JOIN whaleu_school_uid.inventory_batches b ON b.id=cv.batch_id
  JOIN whaleu_school_uid.school_admissions ad ON ad.batch_id=b.id AND ad.institution_id=c.institution_id
  CROSS JOIN LATERAL jsonb_array_elements(b.manifest->'package'->'schools') sc
  CROSS JOIN LATERAL jsonb_array_elements(coalesce(sc->'accountCoverage','[]')) ac
  WHERE cv.account_id=c.account_id AND cv.kind='accepted_import' AND sc->>'institutionId'=c.institution_id::text
   AND ac->>'accountId'=c.account_id::text AND ac->>'sourceAccountId'=cv.source_account_id AND ac->>'status'='known_missing');
END $$;

-- Required-owner validation is nonblocking. The orchestrator registers exact DB
-- text deadlines after this owner proof; no subsequent blocking read is added.
CREATE FUNCTION whaleu_verification.institutional_completion_valid(completion uuid) RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
DECLARE x whaleu_verification.institutional_completions;q whaleu_verification.institutional_requests;r whaleu_verification.institutional_results;
 c whaleu_school_uid.producing_causes;expected jsonb;actual jsonb;changed jsonb;u whaleu_verification.institutional_uid_results;
BEGIN
 LOCK TABLE whaleu_verification.institutional_requests,whaleu_verification.institutional_results,
 whaleu_verification.institutional_subjects,whaleu_verification.institutional_completions,whaleu_verification.institutional_uid_results,
 whaleu_verification.institutional_bindings,whaleu_verification.institutional_binding_heads,whaleu_verification.relevant_fact_generations,
 whaleu_verification.assertions,whaleu_verification.snapshots,whaleu_verification.events,whaleu_verification.account_heads,
 whaleu_identity.accounts,whaleu_identity.sessions,whaleu_campus.campuses,whaleu_campus.campus_region_assignments,whaleu_campus.operating_regions
 IN SHARE MODE NOWAIT;
 SELECT * INTO x FROM whaleu_verification.institutional_completions WHERE id=completion AND creation_transaction=pg_current_xact_id();
 SELECT * INTO q FROM whaleu_verification.institutional_requests WHERE(account_id,request_id)=(x.account_id,x.request_id);
 SELECT * INTO r FROM whaleu_verification.institutional_results WHERE id=x.result_id;
 SELECT * INTO c FROM whaleu_school_uid.producing_causes WHERE id=x.cause_id;
 SELECT * INTO u FROM whaleu_verification.institutional_uid_results WHERE completion_id=x.id;
 IF x.id IS NULL OR q.state IS DISTINCT FROM 'completed' OR q.completion_id IS DISTINCT FROM x.id OR q.result_id IS DISTINCT FROM r.id
 OR u.completion_id IS NULL OR u.cause_id IS DISTINCT FROM c.id
 OR whaleu_verification.institutional_source_valid(c) IS DISTINCT FROM true
 OR whaleu_verification.school_identity_source_final(c.id) IS DISTINCT FROM true
 OR whaleu_school_uid.producing_cause_complete(c.id) IS DISTINCT FROM true
 THEN RETURN false;END IF;
 expected:=x.relevant_witness||jsonb_build_object(
 'affiliationGeneration',((x.relevant_witness->>'affiliationGeneration')::bigint+(CASE WHEN x.new_affiliation_assertion_id IS NULL THEN 0 ELSE 1 END))::text,
 'studentNumberGeneration',((x.relevant_witness->>'studentNumberGeneration')::bigint+(CASE WHEN x.new_student_number_assertion_id IS NULL THEN 0 ELSE 1 END))::text,
 'affiliationAssertionId',x.affiliation_assertion_id,'studentNumberAssertionId',x.student_number_assertion_id);
 actual:=whaleu_verification.relevant_fact_witness(x.account_id);
 changed:=(CASE WHEN x.new_affiliation_assertion_id IS NULL THEN '[]'::jsonb ELSE '["affiliation"]'::jsonb END)
 ||(CASE WHEN x.new_student_number_assertion_id IS NULL THEN '[]'::jsonb ELSE '["student_number"]'::jsonb END);
 IF actual IS DISTINCT FROM expected OR q.receipt->'changedFacts' IS DISTINCT FROM changed OR q.receipt->>'uidOutcome' IS DISTINCT FROM u.outcome
 OR q.receipt->>'uidReason' IS DISTINCT FROM u.unavailable_reason THEN RETURN false;END IF;
 IF NOT EXISTS(SELECT 1 FROM whaleu_verification.account_heads h JOIN whaleu_verification.snapshots s ON(s.id,s.account_id,s.revision)=(h.snapshot_id,h.account_id,h.revision)
 JOIN whaleu_verification.events e ON(e.id,e.account_id,e.snapshot_id,e.revision)=(x.event_id,h.account_id,h.snapshot_id,h.revision)
 WHERE(h.account_id,h.snapshot_id,h.revision)=(x.account_id,x.snapshot_id,(x.old_head->>'revision')::integer+1)
 AND s.affiliation_assertion_id=x.affiliation_assertion_id AND s.student_number_assertion_id IS NOT DISTINCT FROM x.student_number_assertion_id
 AND s.phone_assertion_id IS NOT DISTINCT FROM(x.old_snapshot->>'phone_assertion_id')::uuid
 AND s.application_state=x.old_snapshot->>'application_state' AND s.application_coverage=x.old_snapshot->>'application_coverage'
 AND e.kind='institutional_sso' AND e.fact_kind IS NULL AND e.operation_id=x.request_id AND e.actor_account_id=x.account_id
 AND e.expected_revision=(x.old_head->>'revision')::integer AND e.reason_code='institutional_verified') THEN RETURN false;END IF;
 IF NOT EXISTS(SELECT 1 FROM whaleu_verification.school_identity_source_proofs p WHERE p.cause_id=c.id AND p.old_head=x.old_head AND p.old_snapshot=x.old_snapshot) THEN RETURN false;END IF;
 -- Failure to retain any required owner trigger is unavailable, never repaired
 -- with guessed continuity. Exact source functions are trusted migration code.
 IF EXISTS(SELECT 1 FROM(VALUES
  ('whaleu_verification.account_heads','institutional_relevant_fact_transition','whaleu_verification.advance_relevant_fact_generations()'),
  ('whaleu_verification.relevant_fact_generations','relevant_fact_generation_guard','whaleu_verification.relevant_fact_generation_guard()'),
  ('whaleu_verification.relevant_fact_generations','relevant_fact_generation_owned','whaleu_verification.school_identity_statement_guard()'),
  ('whaleu_verification.relevant_fact_generations','relevant_fact_generation_no_truncate','whaleu_verification.immutable_record()'),
  ('whaleu_verification.assertions','institutional_assertion_guard','whaleu_verification.institutional_assertion_guard()'),
  ('whaleu_verification.snapshots','institutional_pointer_guard','whaleu_verification.institutional_pointer_guard()'),
  ('whaleu_verification.account_heads','institutional_pointer_guard','whaleu_verification.institutional_pointer_guard()')
 ) required(relation_name,trigger_name,function_name) WHERE NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=required.relation_name::regclass
 AND t.tgname=required.trigger_name AND t.tgfoid=required.function_name::regprocedure AND t.tgenabled='O' AND NOT t.tgisinternal)) THEN RETURN false;END IF;
 RETURN true;
END $$;
CREATE FUNCTION whaleu_verification.institutional_completion_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE selected uuid;
BEGIN
 IF TG_TABLE_NAME='institutional_completions' THEN selected:=NEW.id;ELSE selected:=NEW.completion_id;END IF;
 IF whaleu_verification.institutional_completion_valid(selected) IS DISTINCT FROM true THEN
 RAISE EXCEPTION 'Institutional source, Verification and UID effects must close exactly together' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER institutional_completion_complete AFTER INSERT ON whaleu_verification.institutional_completions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_verification.institutional_completion_complete();
CREATE CONSTRAINT TRIGGER institutional_uid_complete AFTER INSERT ON whaleu_verification.institutional_uid_results DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_verification.institutional_completion_complete();

DO $$ DECLARE relation text;BEGIN
 FOREACH relation IN ARRAY ARRAY['institutional_bindings','institutional_cancel_fences','institutional_request_transitions','institutional_results','institutional_subjects','institutional_completions','institutional_uid_results','institutional_descendants'] LOOP
  EXECUTE format('CREATE TRIGGER institutional_history_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON whaleu_verification.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_verification.immutable_record()',relation);
 END LOOP;
END $$;
REVOKE ALL ON whaleu_verification.relevant_fact_generations,whaleu_verification.institutional_bindings,whaleu_verification.institutional_binding_heads,
 whaleu_verification.institutional_requests,whaleu_verification.institutional_cancel_fences,whaleu_verification.institutional_request_transitions,
 whaleu_verification.institutional_results,whaleu_verification.institutional_subjects,whaleu_verification.institutional_completions,
 whaleu_verification.institutional_uid_results,whaleu_verification.institutional_descendants FROM PUBLIC;
