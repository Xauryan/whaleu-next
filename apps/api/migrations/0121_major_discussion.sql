-- M1 independent Major directory and named text discussion. Empty storage only.
-- Sources: Major.php / MajorComment.php at 57cf169c; no numeric score domain.
-- Production import/issuer/media/deletion remain separate gates.
SET LOCAL lock_timeout='5s';
CREATE SCHEMA whaleu_majors;
CREATE TABLE whaleu_majors.major_catalogs (
 id uuid PRIMARY KEY,source_namespace text NOT NULL CHECK(length(btrim(source_namespace)) BETWEEN 1 AND 200),
 source_reference text NOT NULL CHECK(length(btrim(source_reference)) BETWEEN 1 AND 2000),source_revision text NOT NULL CHECK(length(btrim(source_revision)) BETWEEN 1 AND 200),
 coverage text NOT NULL CHECK(coverage IN('complete','unknown')),scope_policy text NOT NULL CHECK(scope_policy='authenticated_phone'),
 policy_reference text NOT NULL CHECK(length(btrim(policy_reference)) BETWEEN 1 AND 2000),
 accepted_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(accepted_at)),valid_until timestamptz NOT NULL CHECK(isfinite(valid_until) AND valid_until>accepted_at)
);
CREATE TABLE whaleu_majors.major_catalog_acceptances(catalog_id uuid PRIMARY KEY REFERENCES whaleu_majors.major_catalogs(id),accepted_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(accepted_at)));
CREATE TABLE whaleu_majors.major_catalog_head(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),catalog_id uuid NOT NULL REFERENCES whaleu_majors.major_catalog_acceptances(catalog_id),state text NOT NULL CHECK(state IN('accepted','withdrawn')));
-- The source school key is a source identifier, never an inferred current Campus ID.
-- One stable Major identity binds the independently accepted school/department map.
CREATE TABLE whaleu_majors.major_identities(
 id uuid PRIMARY KEY,source_namespace text NOT NULL CHECK(length(btrim(source_namespace)) BETWEEN 1 AND 200),source_major_key text NOT NULL CHECK(length(btrim(source_major_key)) BETWEEN 1 AND 200),
 source_school_key text NOT NULL CHECK(length(btrim(source_school_key)) BETWEEN 1 AND 200),department_id integer NOT NULL,campus_id uuid NOT NULL REFERENCES whaleu_campus.campuses(id),
 UNIQUE(source_namespace,source_major_key),UNIQUE(id,source_school_key,department_id,campus_id)
);
CREATE TABLE whaleu_majors.major_entries(
 catalog_id uuid NOT NULL REFERENCES whaleu_majors.major_catalogs(id),major_id uuid NOT NULL,revision uuid NOT NULL,department_id integer NOT NULL,
 college_name text NOT NULL CHECK(length(btrim(college_name)) BETWEEN 1 AND 200),major_name text NOT NULL CHECK(length(btrim(major_name)) BETWEEN 1 AND 200),is_active boolean NOT NULL,
 campus_id uuid NOT NULL,source_school_key text NOT NULL,school_mapping_reference text NOT NULL CHECK(length(btrim(school_mapping_reference)) BETWEEN 1 AND 2000),
 PRIMARY KEY(catalog_id,major_id),UNIQUE(catalog_id,major_id,revision),FOREIGN KEY(major_id,source_school_key,department_id,campus_id) REFERENCES whaleu_majors.major_identities(id,source_school_key,department_id,campus_id)
);
CREATE TABLE whaleu_majors.major_catalog_epoch(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),revision bigint NOT NULL DEFAULT 1 CHECK(revision>0));
INSERT INTO whaleu_majors.major_catalog_epoch(singleton) VALUES(true);
CREATE FUNCTION whaleu_majors.major_immutable() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'Accepted Major identity and directory evidence is immutable' USING ERRCODE='23514',CONSTRAINT='major_catalog_causal';END$$;
DO $$DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['major_catalogs','major_catalog_acceptances','major_identities','major_entries'] LOOP EXECUTE format('CREATE TRIGGER major_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON whaleu_majors.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_majors.major_immutable()',t);END LOOP;END$$;
CREATE FUNCTION whaleu_majors.major_catalog_epoch_advance() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN UPDATE whaleu_majors.major_catalog_epoch SET revision=revision+1 WHERE singleton;RETURN NULL;END$$;
CREATE TRIGGER major_catalog_epoch AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_majors.major_catalog_head FOR EACH STATEMENT EXECUTE FUNCTION whaleu_majors.major_catalog_epoch_advance();
CREATE FUNCTION whaleu_majors.major_source_seal() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Major source writers require read committed' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('whaleu:major-catalog-seal:v1:'||NEW.catalog_id::text,0));
 IF TG_TABLE_NAME='major_catalog_acceptances' THEN
  IF(SELECT count(*) FROM whaleu_majors.major_entries WHERE catalog_id=NEW.catalog_id)>1000 THEN RAISE EXCEPTION 'Bounded complete Major catalog required' USING ERRCODE='23514';END IF;
 ELSE
  IF EXISTS(SELECT 1 FROM whaleu_majors.major_catalog_acceptances WHERE catalog_id=NEW.catalog_id) THEN RAISE EXCEPTION 'Accepted Major catalog is sealed' USING ERRCODE='23514';END IF;
  IF NOT EXISTS(SELECT 1 FROM whaleu_majors.major_catalogs c JOIN whaleu_majors.major_identities i ON i.id=NEW.major_id AND i.source_namespace=c.source_namespace WHERE c.id=NEW.catalog_id) THEN RAISE EXCEPTION 'Major source namespace mismatch' USING ERRCODE='23514';END IF;
 END IF;RETURN NEW;
END$$;
CREATE TRIGGER major_source_seal BEFORE INSERT ON whaleu_majors.major_entries FOR EACH ROW EXECUTE FUNCTION whaleu_majors.major_source_seal();
CREATE TRIGGER major_source_seal BEFORE INSERT ON whaleu_majors.major_catalog_acceptances FOR EACH ROW EXECUTE FUNCTION whaleu_majors.major_source_seal();
CREATE FUNCTION whaleu_majors.major_catalog_source(instant timestamptz) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object('catalog',c.id,'epoch',(SELECT revision::text FROM whaleu_majors.major_catalog_epoch WHERE singleton),'head',to_jsonb(h),'source',to_jsonb(c),'acceptance',to_jsonb(a),'mappings',coalesce((SELECT jsonb_agg(jsonb_build_array(e.major_id,to_jsonb(campus),to_jsonb(institution),to_jsonb(assignment),to_jsonb(region)) ORDER BY e.major_id) FROM whaleu_majors.major_entries e JOIN whaleu_campus.campuses campus ON campus.id=e.campus_id JOIN whaleu_campus.institutions institution ON institution.id=campus.institution_id JOIN whaleu_campus.campus_region_assignments assignment ON assignment.campus_id=campus.id JOIN whaleu_campus.operating_regions region ON region.id=assignment.operating_region_id WHERE e.catalog_id=c.id AND e.is_active),'[]'::jsonb))
 FROM whaleu_majors.major_catalog_head h JOIN whaleu_majors.major_catalogs c ON c.id=h.catalog_id JOIN whaleu_majors.major_catalog_acceptances a ON a.catalog_id=c.id
 WHERE h.singleton AND h.state='accepted' AND c.coverage='complete' AND c.scope_policy='authenticated_phone' AND c.accepted_at<=instant AND a.accepted_at<=instant AND c.valid_until>instant
 AND NOT EXISTS(SELECT 1 FROM whaleu_majors.major_entries e WHERE e.catalog_id=c.id AND e.is_active AND NOT EXISTS(SELECT 1 FROM whaleu_campus.campuses campus JOIN whaleu_campus.institutions institution ON institution.id=campus.institution_id JOIN whaleu_campus.campus_region_assignments assignment ON assignment.campus_id=campus.id JOIN whaleu_campus.operating_regions region ON region.id=assignment.operating_region_id WHERE campus.id=e.campus_id AND campus.is_active AND region.is_active))
$$;
CREATE FUNCTION whaleu_majors.major_source(mid uuid,instant timestamptz) RETURNS jsonb LANGUAGE sql STABLE AS $$
 WITH catalog_capture AS MATERIALIZED(SELECT whaleu_majors.major_catalog_source(instant) source) SELECT jsonb_build_object('catalog',e.catalog_id,'revision',e.revision,'owner',encode(sha256(convert_to(catalog_capture.source::text,'UTF8')),'hex')) FROM whaleu_majors.major_entries e CROSS JOIN catalog_capture WHERE e.major_id=mid AND e.catalog_id=(catalog_capture.source->>'catalog')::uuid AND e.is_active
$$;
CREATE FUNCTION whaleu_majors.major_uuid_valid(v text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$SELECT coalesce(v ~ '^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$',false)$$;
CREATE FUNCTION whaleu_majors.major_exact_keys(e jsonb,keys text[]) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$SELECT coalesce(jsonb_typeof(e)='object' AND e ?& keys AND e-keys='{}'::jsonb,false)$$;
CREATE FUNCTION whaleu_majors.major_exact_ids(e jsonb,keys text[]) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$SELECT coalesce(jsonb_typeof(e)='object' AND NOT EXISTS(SELECT 1 FROM unnest(keys) k WHERE jsonb_typeof(e->k) IS DISTINCT FROM 'string' OR NOT whaleu_majors.major_uuid_valid(e->>k)),false)$$;

CREATE FUNCTION whaleu_identity.major_rating_session(actor uuid,sid uuid,instant timestamptz) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM whaleu_identity.sessions s JOIN whaleu_identity.accounts a ON a.id=s.account_id WHERE s.id=sid AND s.account_id=actor AND a.status='active' AND s.revoked_at IS NULL AND s.access_expires_at>instant AND s.absolute_expires_at>instant)
$$;
CREATE FUNCTION whaleu_verification.major_rating_fact(actor uuid,kind text,instant timestamptz) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM whaleu_verification.account_heads h JOIN whaleu_verification.snapshots s ON s.id=h.snapshot_id AND s.account_id=h.account_id JOIN whaleu_verification.assertions a ON a.id=CASE WHEN kind='phone' THEN s.phone_assertion_id ELSE s.affiliation_assertion_id END
 WHERE h.account_id=actor AND a.account_id=actor AND a.source_account_id=actor AND a.fact_kind=kind AND a.assertion_state='verified' AND a.coverage_state='complete' AND a.provenance_state='accepted'
 AND length(btrim(a.source_reference))>0 AND length(btrim(a.policy_reference))>0 AND a.issuer_institution_id IS NOT DISTINCT FROM a.source_issuer_institution_id
 AND ((kind='phone' AND a.method IN('phone_provider','reconciled_import') AND a.phone_binding_reference IS NOT NULL) OR (kind='affiliation' AND a.method IN('document_review','institutional_email','institutional_sso','reconciled_import') AND a.issuer_institution_id IS NOT NULL AND a.origin_region_id IS NOT NULL))
 AND isfinite(a.verified_at) AND a.verified_at<=instant AND ((a.expiry_kind='policy_exempt' AND a.expires_at IS NULL) OR(a.expiry_kind='at' AND isfinite(a.expires_at) AND a.expires_at>a.verified_at AND a.expires_at>instant)))
$$;
CREATE FUNCTION whaleu_safety.major_rating_allowed(actor uuid,instant timestamptz) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM whaleu_safety.account_heads WHERE account_id=actor AND restriction_coverage='complete' AND block_coverage='complete' AND provenance<>'unknown' AND actions_allowed AND (valid_until IS NULL OR valid_until>instant))
$$;
CREATE FUNCTION whaleu_majors.major_access(actor uuid,sid uuid,instant timestamptz) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT whaleu_identity.major_rating_session(actor,sid,instant) AND whaleu_verification.major_rating_fact(actor,'phone',instant) AND whaleu_safety.major_rating_allowed(actor,instant)
$$;
CREATE FUNCTION whaleu_verification.major_discussion_temporary(actor uuid,instant timestamptz) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM whaleu_verification.rating_base_heads h JOIN whaleu_verification.rating_base_assertions a ON a.id=h.assertion_id AND a.account_id=h.account_id WHERE h.account_id=actor AND a.coverage='complete' AND a.provenance='accepted' AND a.state='verified' AND length(btrim(a.issuer))>0 AND length(btrim(a.source_reference))>0 AND length(btrim(a.policy_reference))>0 AND a.effective_at<=instant AND a.valid_until>instant)
$$;
CREATE FUNCTION whaleu_authorization.major_discussion_admin(actor uuid,instant timestamptz) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM whaleu_authorization.role_grants WHERE account_id=actor AND role IN('school_admin','super_admin') AND revoked_at IS NULL AND valid_from<=instant AND (expires_at IS NULL OR expires_at>instant))
$$;
CREATE FUNCTION whaleu_majors.major_publish_base(actor uuid,instant timestamptz) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT whaleu_verification.major_rating_fact(actor,'affiliation',instant) OR whaleu_verification.major_discussion_temporary(actor,instant) OR whaleu_authorization.major_discussion_admin(actor,instant) $$;
CREATE FUNCTION whaleu_majors.major_fence() RETURNS void LANGUAGE plpgsql VOLATILE AS $$BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Major owner requires read committed' USING ERRCODE='23514',CONSTRAINT='major_catalog_causal';END IF;
 LOCK TABLE whaleu_majors.major_catalog_head,whaleu_majors.major_catalogs,whaleu_majors.major_catalog_acceptances,whaleu_majors.major_identities,whaleu_majors.major_entries,whaleu_majors.major_catalog_epoch,whaleu_identity.accounts,whaleu_identity.sessions,whaleu_verification.account_heads,whaleu_verification.snapshots,whaleu_verification.assertions,whaleu_verification.rating_base_heads,whaleu_verification.rating_base_assertions,whaleu_safety.account_heads,whaleu_authorization.role_grants,whaleu_campus.campuses,whaleu_campus.institutions,whaleu_campus.campus_region_assignments,whaleu_campus.operating_regions IN SHARE MODE NOWAIT;
 IF NOT EXISTS(SELECT 1 FROM whaleu_majors.major_catalog_epoch WHERE singleton) THEN RAISE EXCEPTION 'Major catalog epoch unavailable' USING ERRCODE='23514',CONSTRAINT='major_catalog_causal';END IF;
END$$;
-- Major named text roots, flat replies, reversible likes and local notices.
-- Empty discussion owner storage only. No production source/history or Review issuer.
SET LOCAL lock_timeout='5s';
CREATE FUNCTION whaleu_majors.major_discussion_body_valid(value text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT coalesce(octet_length(value) BETWEEN 1 AND 8000 AND length(btrim(value,U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'))>0,false)
$$;
CREATE TABLE whaleu_majors.major_discussion_history_assertions(
 id uuid PRIMARY KEY,major_id uuid NOT NULL REFERENCES whaleu_majors.major_identities(id),kind text NOT NULL CHECK(kind IN('population','likes')),
 coverage text NOT NULL CHECK(coverage IN('accepted_empty','unknown')),source_reference text NOT NULL CHECK(length(btrim(source_reference)) BETWEEN 1 AND 2000),policy_reference text NOT NULL CHECK(length(btrim(policy_reference)) BETWEEN 1 AND 2000),
 accepted_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(accepted_at)),valid_until timestamptz NOT NULL CHECK(isfinite(valid_until) AND valid_until>accepted_at),UNIQUE(id,major_id,kind)
);
CREATE TABLE whaleu_majors.major_discussion_history_heads(major_id uuid NOT NULL,kind text NOT NULL,assertion_id uuid NOT NULL,PRIMARY KEY(major_id,kind),FOREIGN KEY(assertion_id,major_id,kind) REFERENCES whaleu_majors.major_discussion_history_assertions(id,major_id,kind));
CREATE TABLE whaleu_majors.major_discussion_epoch(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),revision bigint NOT NULL DEFAULT 1 CHECK(revision>0));
INSERT INTO whaleu_majors.major_discussion_epoch(singleton) VALUES(true);
CREATE TABLE whaleu_community.major_discussion_review_policies(
 id uuid PRIMARY KEY,issuer text NOT NULL CHECK(length(btrim(issuer)) BETWEEN 1 AND 200),source_reference text NOT NULL CHECK(length(btrim(source_reference)) BETWEEN 1 AND 2000),coverage text NOT NULL CHECK(coverage IN('complete','unknown')),
 valid_from timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(valid_from)),valid_until timestamptz NOT NULL CHECK(isfinite(valid_until) AND valid_until>valid_from)
);
CREATE TABLE whaleu_community.major_discussion_review_decisions(
 id uuid PRIMARY KEY,actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),request_id uuid NOT NULL,major_id uuid NOT NULL REFERENCES whaleu_majors.major_identities(id),catalog_id uuid NOT NULL,major_revision uuid NOT NULL,
 purpose text NOT NULL CHECK(purpose IN('major.discussion.root.v1','major.discussion.reply.v1')),root_id uuid,reply_to_reply_id uuid,reply_to_actor_id uuid REFERENCES whaleu_identity.accounts(id),body text NOT NULL CHECK(whaleu_majors.major_discussion_body_valid(body)),
 policy_id uuid NOT NULL REFERENCES whaleu_community.major_discussion_review_policies(id),verdict text NOT NULL CHECK(verdict IN('allow','reject')),digest text NOT NULL,
 issued_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(issued_at)),consume_until timestamptz NOT NULL CHECK(isfinite(consume_until) AND consume_until>issued_at),visibility_until timestamptz NOT NULL CHECK(isfinite(visibility_until) AND visibility_until>issued_at),
 FOREIGN KEY(catalog_id,major_id,major_revision) REFERENCES whaleu_majors.major_entries(catalog_id,major_id,revision),UNIQUE(id,actor_id,request_id),
 CHECK((purpose='major.discussion.reply.v1')=(root_id IS NOT NULL)),CHECK((reply_to_reply_id IS NULL)=(reply_to_actor_id IS NULL)),CHECK(root_id IS NOT NULL OR reply_to_reply_id IS NULL),
 CHECK(digest=encode(sha256(convert_to('whaleu:major-discussion-review:v1'||chr(10)||whaleu_community.content_canonical_json(jsonb_build_object('version',1,'purpose',purpose,'actorId',actor_id::text,'requestId',request_id::text,'majorId',major_id::text,'catalogRevision',catalog_id::text,'majorRevision',major_revision::text,'body',body,'rootId',root_id::text,'replyToReplyId',reply_to_reply_id::text,'replyToActorId',reply_to_actor_id::text)),'UTF8')),'hex'))
);
CREATE TABLE whaleu_community.major_discussion_review_heads(actor_id uuid NOT NULL,request_id uuid NOT NULL,decision_id uuid NOT NULL,state text NOT NULL CHECK(state IN('active','revoked')),PRIMARY KEY(actor_id,request_id),FOREIGN KEY(decision_id,actor_id,request_id) REFERENCES whaleu_community.major_discussion_review_decisions(id,actor_id,request_id));
CREATE TABLE whaleu_community.major_discussion_review_epoch(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),revision bigint NOT NULL DEFAULT 1 CHECK(revision>0));
INSERT INTO whaleu_community.major_discussion_review_epoch(singleton) VALUES(true);
CREATE TABLE whaleu_majors.major_discussion_commands(
 actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),request_id uuid NOT NULL,session_id uuid NOT NULL REFERENCES whaleu_identity.sessions(id),major_id uuid NOT NULL REFERENCES whaleu_majors.major_identities(id),subject_id uuid,
 operation text NOT NULL CHECK(operation IN('major.discussion.root.v1','major.discussion.reply.v1','major.discussion.like.v1')),
 command jsonb NOT NULL CHECK(jsonb_typeof(command)='object' AND octet_length(command::text)<=50000),intent_hash text NOT NULL CHECK(intent_hash~'^[a-f0-9]{64}$'),receipt jsonb NOT NULL CHECK(jsonb_typeof(receipt)='object' AND octet_length(receipt::text)<=2048),transaction_id xid8 NOT NULL DEFAULT pg_current_xact_id(),PRIMARY KEY(actor_id,request_id),
 CHECK((operation='major.discussion.root.v1')=(subject_id IS NULL)),
 CHECK(intent_hash=encode(sha256(convert_to('whaleu:major-discussion-command:v1'||chr(10)||whaleu_community.content_canonical_json(jsonb_build_object('actorId',actor_id::text,'majorId',major_id::text,'subjectId',subject_id::text,'operation',operation,'command',command)),'UTF8')),'hex')),
 CHECK((command->>'clientRequestId') IS NOT DISTINCT FROM request_id::text),CHECK((receipt->>'requestId') IS NOT DISTINCT FROM request_id::text AND (receipt->>'majorId') IS NOT DISTINCT FROM major_id::text AND (receipt->>'operation') IS NOT DISTINCT FROM operation)
);
CREATE TABLE whaleu_majors.major_discussion_comments(
 id uuid PRIMARY KEY,major_id uuid NOT NULL REFERENCES whaleu_majors.major_identities(id),root_id uuid,reply_to_reply_id uuid,reply_to_actor_id uuid REFERENCES whaleu_identity.accounts(id),actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),request_id uuid NOT NULL,
 catalog_id uuid NOT NULL,major_revision uuid NOT NULL,population_assertion_id uuid NOT NULL REFERENCES whaleu_majors.major_discussion_history_assertions(id),review_decision_id uuid NOT NULL UNIQUE REFERENCES whaleu_community.major_discussion_review_decisions(id),
 body text NOT NULL CHECK(whaleu_majors.major_discussion_body_valid(body)),created_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds',transaction_timestamp()),transaction_id xid8 NOT NULL DEFAULT pg_current_xact_id(),
 UNIQUE(actor_id,request_id),UNIQUE(id,major_id),UNIQUE(id,major_id,root_id),FOREIGN KEY(root_id,major_id) REFERENCES whaleu_majors.major_discussion_comments(id,major_id),FOREIGN KEY(reply_to_reply_id,major_id,root_id) REFERENCES whaleu_majors.major_discussion_comments(id,major_id,root_id),
 FOREIGN KEY(actor_id,request_id) REFERENCES whaleu_majors.major_discussion_commands(actor_id,request_id) DEFERRABLE INITIALLY DEFERRED,FOREIGN KEY(catalog_id,major_id,major_revision) REFERENCES whaleu_majors.major_entries(catalog_id,major_id,revision),
 CHECK(root_id IS DISTINCT FROM id AND reply_to_reply_id IS DISTINCT FROM id),CHECK((reply_to_reply_id IS NULL)=(reply_to_actor_id IS NULL)),CHECK(root_id IS NOT NULL OR reply_to_reply_id IS NULL)
);
CREATE TABLE whaleu_majors.major_discussion_like_events(
 id uuid PRIMARY KEY,major_id uuid NOT NULL,comment_id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),request_id uuid NOT NULL,previous_revision uuid,active boolean NOT NULL,
 catalog_id uuid,major_revision uuid,population_assertion_id uuid REFERENCES whaleu_majors.major_discussion_history_assertions(id),likes_assertion_id uuid REFERENCES whaleu_majors.major_discussion_history_assertions(id),
 recorded_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds',transaction_timestamp()),transaction_id xid8 NOT NULL DEFAULT pg_current_xact_id(),
 UNIQUE(actor_id,request_id),UNIQUE(major_id,comment_id,actor_id,id),UNIQUE(major_id,comment_id,actor_id,transaction_id),
 FOREIGN KEY(comment_id,major_id) REFERENCES whaleu_majors.major_discussion_comments(id,major_id),FOREIGN KEY(major_id,comment_id,actor_id,previous_revision) REFERENCES whaleu_majors.major_discussion_like_events(major_id,comment_id,actor_id,id),
 FOREIGN KEY(actor_id,request_id) REFERENCES whaleu_majors.major_discussion_commands(actor_id,request_id) DEFERRABLE INITIALLY DEFERRED,FOREIGN KEY(catalog_id,major_id,major_revision) REFERENCES whaleu_majors.major_entries(catalog_id,major_id,revision),
 CHECK((active AND catalog_id IS NOT NULL AND major_revision IS NOT NULL AND population_assertion_id IS NOT NULL AND likes_assertion_id IS NOT NULL) OR (NOT active AND previous_revision IS NOT NULL AND catalog_id IS NULL AND major_revision IS NULL AND population_assertion_id IS NULL AND likes_assertion_id IS NULL))
);
CREATE TABLE whaleu_majors.major_discussion_like_heads(major_id uuid NOT NULL,comment_id uuid NOT NULL,actor_id uuid NOT NULL,revision uuid NOT NULL,PRIMARY KEY(major_id,comment_id,actor_id),FOREIGN KEY(major_id,comment_id,actor_id,revision) REFERENCES whaleu_majors.major_discussion_like_events(major_id,comment_id,actor_id,id));
CREATE TABLE whaleu_notifications.major_discussion_notices(
 id uuid PRIMARY KEY,recipient_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),request_id uuid NOT NULL,kind text NOT NULL CHECK(kind IN('reply','like')),event_id uuid NOT NULL,major_id uuid NOT NULL,comment_id uuid NOT NULL,root_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds',transaction_timestamp()),transaction_id xid8 NOT NULL DEFAULT pg_current_xact_id(),UNIQUE(kind,event_id,recipient_id),UNIQUE(id,recipient_id),CHECK(recipient_id<>actor_id),
 FOREIGN KEY(actor_id,request_id) REFERENCES whaleu_majors.major_discussion_commands(actor_id,request_id) DEFERRABLE INITIALLY DEFERRED,FOREIGN KEY(comment_id,major_id) REFERENCES whaleu_majors.major_discussion_comments(id,major_id),FOREIGN KEY(root_id,major_id) REFERENCES whaleu_majors.major_discussion_comments(id,major_id)
);
CREATE TABLE whaleu_notifications.major_discussion_reads(notice_id uuid PRIMARY KEY,recipient_id uuid NOT NULL,session_id uuid NOT NULL REFERENCES whaleu_identity.sessions(id),read_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds',transaction_timestamp()),FOREIGN KEY(notice_id,recipient_id) REFERENCES whaleu_notifications.major_discussion_notices(id,recipient_id));
CREATE INDEX major_discussion_order ON whaleu_majors.major_discussion_comments(major_id,root_id,created_at,id);
CREATE INDEX major_discussion_notice_order ON whaleu_notifications.major_discussion_notices(recipient_id,created_at DESC,id DESC);
CREATE FUNCTION whaleu_majors.major_discussion_immutable() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'Major discussion accepted evidence, events and receipts are immutable' USING ERRCODE='23514',CONSTRAINT='major_discussion_causal';END$$;
CREATE FUNCTION whaleu_majors.major_discussion_epoch_advance() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN UPDATE whaleu_majors.major_discussion_epoch SET revision=revision+1 WHERE singleton;RETURN NULL;END$$;
CREATE FUNCTION whaleu_community.major_discussion_review_epoch_advance() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN UPDATE whaleu_community.major_discussion_review_epoch SET revision=revision+1 WHERE singleton;RETURN NULL;END$$;
DO $$DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['major_discussion_history_assertions','major_discussion_history_heads','major_discussion_comments','major_discussion_like_heads'] LOOP EXECUTE format('CREATE TRIGGER major_discussion_epoch AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_majors.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_majors.major_discussion_epoch_advance()',t);END LOOP;
 FOREACH t IN ARRAY ARRAY['major_discussion_history_assertions','major_discussion_comments','major_discussion_like_events','major_discussion_commands'] LOOP EXECUTE format('CREATE TRIGGER major_discussion_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON whaleu_majors.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_majors.major_discussion_immutable()',t);END LOOP;
 FOREACH t IN ARRAY ARRAY['major_discussion_review_policies','major_discussion_review_decisions','major_discussion_review_heads'] LOOP EXECUTE format('CREATE TRIGGER major_discussion_review_epoch AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_community.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.major_discussion_review_epoch_advance()',t);END LOOP;
 FOREACH t IN ARRAY ARRAY['major_discussion_review_policies','major_discussion_review_decisions'] LOOP EXECUTE format('CREATE TRIGGER major_discussion_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON whaleu_community.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_majors.major_discussion_immutable()',t);END LOOP;
 FOREACH t IN ARRAY ARRAY['major_discussion_notices','major_discussion_reads'] LOOP EXECUTE format('CREATE TRIGGER major_discussion_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON whaleu_notifications.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_majors.major_discussion_immutable()',t);END LOOP;
END$$;
CREATE TRIGGER major_discussion_head_no_delete BEFORE DELETE OR TRUNCATE ON whaleu_majors.major_discussion_like_heads FOR EACH STATEMENT EXECUTE FUNCTION whaleu_majors.major_discussion_immutable();
CREATE FUNCTION whaleu_community.major_discussion_review_status(did uuid,consume boolean,instant timestamptz) RETURNS text LANGUAGE sql STABLE AS $$
 SELECT coalesce((SELECT CASE WHEN h.state='revoked' THEN 'deny' WHEN p.coverage<>'complete' OR p.valid_from>d.issued_at OR d.issued_at>instant OR p.valid_until<=instant OR d.visibility_until<=instant OR (consume AND d.consume_until<=instant) THEN 'unavailable' ELSE d.verdict END FROM whaleu_community.major_discussion_review_decisions d JOIN whaleu_community.major_discussion_review_policies p ON p.id=d.policy_id JOIN whaleu_community.major_discussion_review_heads h ON h.decision_id=d.id AND h.actor_id=d.actor_id AND h.request_id=d.request_id WHERE d.id=did),'unavailable')
$$;
-- Named Major direct policy: both block directions suppress identity and text.
CREATE FUNCTION whaleu_safety.major_discussion_named(viewer uuid,author uuid,instant timestamptz) RETURNS text LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN EXISTS(SELECT 1 FROM whaleu_safety.account_heads WHERE account_id IN(viewer,author) AND (restriction_coverage<>'complete' OR block_coverage<>'complete' OR provenance='unknown' OR (valid_until IS NOT NULL AND valid_until<=instant))) OR (SELECT count(*) FROM whaleu_safety.account_heads WHERE account_id IN(viewer,author))<>CASE WHEN viewer=author THEN 1 ELSE 2 END THEN 'unavailable'
 WHEN EXISTS(SELECT 1 FROM whaleu_safety.account_heads WHERE account_id=author AND NOT actions_allowed) OR EXISTS(SELECT 1 FROM whaleu_safety.blocks WHERE active AND ((blocker_id=viewer AND blocked_id=author) OR(blocker_id=author AND blocked_id=viewer))) THEN 'deny' ELSE 'allow' END
$$;
CREATE FUNCTION whaleu_profile.major_discussion_display_known(actor uuid) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT EXISTS(SELECT 1 FROM whaleu_profile.profiles WHERE account_id=actor)$$;
CREATE FUNCTION whaleu_majors.major_discussion_visibility_base(cid uuid,viewer uuid,instant timestamptz) RETURNS text LANGUAGE sql STABLE AS $$
 SELECT coalesce((SELECT CASE WHEN r.status IN('deny','reject') OR s.status='deny' THEN 'deny' WHEN r.status='allow' AND s.status='allow' AND whaleu_profile.major_discussion_display_known(c.actor_id) THEN 'allow' ELSE 'unavailable' END FROM whaleu_majors.major_discussion_comments c CROSS JOIN LATERAL(SELECT whaleu_community.major_discussion_review_status(c.review_decision_id,false,instant) status) r CROSS JOIN LATERAL(SELECT whaleu_safety.major_discussion_named(viewer,c.actor_id,instant) status) s WHERE c.id=cid),'unavailable')
$$;
CREATE FUNCTION whaleu_majors.major_discussion_visibility(cid uuid,viewer uuid,instant timestamptz) RETURNS text LANGUAGE sql STABLE AS $$
 SELECT coalesce((SELECT CASE WHEN own.status='deny' OR parent.status='deny' THEN 'deny' WHEN own.status='allow' AND parent.status='allow' THEN 'allow' ELSE 'unavailable' END FROM whaleu_majors.major_discussion_comments c CROSS JOIN LATERAL(SELECT whaleu_majors.major_discussion_visibility_base(c.id,viewer,instant) status) own CROSS JOIN LATERAL(SELECT CASE WHEN c.root_id IS NULL THEN 'allow' ELSE whaleu_majors.major_discussion_visibility_base(c.root_id,viewer,instant) END status) parent WHERE c.id=cid),'unavailable')
$$;
CREATE FUNCTION whaleu_majors.major_discussion_history(wid uuid,hkind text,instant timestamptz) RETURNS uuid LANGUAGE sql STABLE AS $$
 SELECT a.id FROM whaleu_majors.major_discussion_history_heads h JOIN whaleu_majors.major_discussion_history_assertions a ON a.id=h.assertion_id AND a.major_id=h.major_id AND a.kind=h.kind WHERE h.major_id=wid AND h.kind=hkind AND a.coverage='accepted_empty' AND a.accepted_at<=instant AND a.valid_until>instant
$$;
CREATE FUNCTION whaleu_majors.major_discussion_source(wid uuid,instant timestamptz) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN s IS NOT NULL THEN jsonb_build_object('catalog',s->>'catalog','revision',s->>'revision','owner',s->>'owner','population',whaleu_majors.major_discussion_history(wid,'population',instant),'likes',whaleu_majors.major_discussion_history(wid,'likes',instant)) END FROM(SELECT whaleu_majors.major_source(wid,instant) s) source
$$;
CREATE FUNCTION whaleu_majors.major_discussion_deadline(wid uuid,instant timestamptz) RETURNS timestamptz LANGUAGE sql STABLE AS $$
 SELECT min(value) FROM(
 SELECT boundary.value FROM whaleu_majors.major_discussion_history_heads h JOIN whaleu_majors.major_discussion_history_assertions a ON a.id=h.assertion_id CROSS JOIN LATERAL(VALUES(a.accepted_at),(a.valid_until)) boundary(value) WHERE h.major_id=wid AND boundary.value>instant
 UNION ALL SELECT boundary.value FROM whaleu_majors.major_discussion_comments c JOIN whaleu_community.major_discussion_review_decisions d ON d.id=c.review_decision_id JOIN whaleu_community.major_discussion_review_policies p ON p.id=d.policy_id LEFT JOIN whaleu_safety.account_heads s ON s.account_id=c.actor_id CROSS JOIN LATERAL(VALUES(d.issued_at),(d.visibility_until),(p.valid_from),(p.valid_until),(s.valid_until)) boundary(value) WHERE c.major_id=wid AND boundary.value>instant
 ) boundaries
$$;
CREATE FUNCTION whaleu_majors.major_discussion_fence() RETURNS void LANGUAGE plpgsql VOLATILE AS $$BEGIN
 PERFORM whaleu_majors.major_fence();
 LOCK TABLE whaleu_majors.major_discussion_history_assertions,whaleu_majors.major_discussion_history_heads,whaleu_majors.major_discussion_comments,whaleu_majors.major_discussion_like_events,whaleu_majors.major_discussion_like_heads,whaleu_majors.major_discussion_commands,whaleu_majors.major_discussion_epoch,whaleu_community.major_discussion_review_policies,whaleu_community.major_discussion_review_decisions,whaleu_community.major_discussion_review_heads,whaleu_community.major_discussion_review_epoch,whaleu_safety.blocks,whaleu_profile.profiles,whaleu_notifications.major_discussion_notices IN SHARE MODE NOWAIT;
 IF NOT EXISTS(SELECT 1 FROM whaleu_majors.major_discussion_epoch WHERE singleton) OR NOT EXISTS(SELECT 1 FROM whaleu_community.major_discussion_review_epoch WHERE singleton) THEN RAISE EXCEPTION 'Major discussion epochs unavailable' USING ERRCODE='23514',CONSTRAINT='major_discussion_causal';END IF;
END$$;
CREATE FUNCTION whaleu_majors.major_discussion_lock(actor uuid,rid uuid,subject uuid) RETURNS void LANGUAGE plpgsql AS $$BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Major discussion needs read committed' USING ERRCODE='23514',CONSTRAINT='major_discussion_causal';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('whaleu:major-discussion-request:v1:'||actor::text||':'||rid::text,0));
 IF subject IS NOT NULL THEN PERFORM pg_advisory_xact_lock(hashtextextended('whaleu:major-discussion-like:v1:'||actor::text||':'||subject::text,0));END IF;
END$$;
CREATE FUNCTION whaleu_majors.major_discussion_command_lock() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN PERFORM whaleu_majors.major_discussion_lock(NEW.actor_id,NEW.request_id,CASE WHEN NEW.operation='major.discussion.like.v1' THEN NEW.subject_id END);RETURN NEW;END$$;
CREATE TRIGGER major_discussion_command_lock BEFORE INSERT ON whaleu_majors.major_discussion_commands FOR EACH ROW EXECUTE FUNCTION whaleu_majors.major_discussion_command_lock();
CREATE FUNCTION whaleu_majors.major_discussion_like_guard() RETURNS trigger LANGUAGE plpgsql AS $$DECLARE own whaleu_majors.major_discussion_like_events;BEGIN
 PERFORM whaleu_majors.major_discussion_lock(NEW.actor_id,NEW.request_id,NEW.comment_id);
 SELECT e.* INTO own FROM whaleu_majors.major_discussion_like_heads h JOIN whaleu_majors.major_discussion_like_events e ON e.id=h.revision WHERE h.major_id=NEW.major_id AND h.comment_id=NEW.comment_id AND h.actor_id=NEW.actor_id;
 IF NEW.transaction_id<>pg_current_xact_id() OR NEW.recorded_at<>date_trunc('milliseconds',transaction_timestamp()) OR NEW.previous_revision IS DISTINCT FROM own.id OR NEW.active=coalesce(own.active,false) THEN RAISE EXCEPTION 'Like event needs exact changing predecessor' USING ERRCODE='23514',CONSTRAINT='major_discussion_causal';END IF;RETURN NEW;
END$$;
CREATE TRIGGER major_discussion_like_guard BEFORE INSERT ON whaleu_majors.major_discussion_like_events FOR EACH ROW EXECUTE FUNCTION whaleu_majors.major_discussion_like_guard();
CREATE FUNCTION whaleu_majors.major_discussion_head_guard() RETURNS trigger LANGUAGE plpgsql AS $$DECLARE e whaleu_majors.major_discussion_like_events;previous uuid;BEGIN
 SELECT * INTO e FROM whaleu_majors.major_discussion_like_events WHERE id=NEW.revision AND major_id=NEW.major_id AND comment_id=NEW.comment_id AND actor_id=NEW.actor_id;
 IF e.id IS NULL THEN RAISE EXCEPTION 'Like head needs exact event' USING ERRCODE='23514',CONSTRAINT='major_discussion_causal';END IF;
 PERFORM whaleu_majors.major_discussion_lock(e.actor_id,e.request_id,e.comment_id);
 IF TG_OP='UPDATE' THEN previous:=OLD.revision;IF(NEW.major_id,NEW.comment_id,NEW.actor_id) IS DISTINCT FROM(OLD.major_id,OLD.comment_id,OLD.actor_id) THEN RAISE EXCEPTION 'Like identity immutable' USING ERRCODE='23514',CONSTRAINT='major_discussion_causal';END IF;END IF;
 IF e.transaction_id<>pg_current_xact_id() OR e.previous_revision IS DISTINCT FROM previous THEN RAISE EXCEPTION 'Like head needs new atomic predecessor event' USING ERRCODE='23514',CONSTRAINT='major_discussion_causal';END IF;RETURN NEW;
END$$;
CREATE TRIGGER major_discussion_head_guard BEFORE INSERT OR UPDATE ON whaleu_majors.major_discussion_like_heads FOR EACH ROW EXECUTE FUNCTION whaleu_majors.major_discussion_head_guard();
-- Exact local notice obligation. Relikes use distinct transition IDs, never a
-- lifetime actor/subject dedupe. Major has no creator notification.
CREATE FUNCTION whaleu_notifications.major_discussion_expected(actor uuid,rid uuid) RETURNS TABLE(recipient_id uuid,kind text,event_id uuid,major_id uuid,comment_id uuid,root_id uuid) LANGUAGE sql STABLE AS $$
 SELECT root.actor_id,'reply',c.id,c.major_id,root.id,root.id FROM whaleu_majors.major_discussion_comments c JOIN whaleu_majors.major_discussion_comments root ON root.id=c.root_id WHERE c.actor_id=actor AND c.request_id=rid AND root.actor_id<>actor
 UNION ALL SELECT c.reply_to_actor_id,'reply',c.id,c.major_id,c.id,c.root_id FROM whaleu_majors.major_discussion_comments c JOIN whaleu_majors.major_discussion_comments root ON root.id=c.root_id WHERE c.actor_id=actor AND c.request_id=rid AND c.reply_to_actor_id IS NOT NULL AND c.reply_to_actor_id<>actor AND c.reply_to_actor_id<>root.actor_id
 UNION ALL SELECT c.actor_id,'like',e.id,e.major_id,e.comment_id,coalesce(c.root_id,c.id) FROM whaleu_majors.major_discussion_like_events e JOIN whaleu_majors.major_discussion_comments c ON c.id=e.comment_id WHERE e.actor_id=actor AND e.request_id=rid AND e.active AND c.actor_id<>actor
$$;
CREATE FUNCTION whaleu_majors.major_discussion_complete(actor uuid,rid uuid) RETURNS void LANGUAGE plpgsql VOLATILE AS $$
DECLARE q whaleu_majors.major_discussion_commands;c whaleu_majors.major_discussion_comments;target whaleu_majors.major_discussion_comments;root whaleu_majors.major_discussion_comments;e whaleu_majors.major_discussion_like_events;own whaleu_majors.major_discussion_like_events;d whaleu_community.major_discussion_review_decisions;source jsonb;instant timestamptz;pub boolean;reply boolean;positive boolean;expected uuid;keys text[];BEGIN
 PERFORM whaleu_majors.major_discussion_fence();instant:=clock_timestamp();
 SELECT * INTO q FROM whaleu_majors.major_discussion_commands WHERE actor_id=actor AND request_id=rid;
 IF q.request_id IS NULL OR q.transaction_id<>pg_current_xact_id() OR NOT whaleu_identity.major_rating_session(actor,q.session_id,instant) THEN RAISE EXCEPTION 'Major discussion requires current owner session and exact command' USING ERRCODE='23514',CONSTRAINT='major_discussion_causal';END IF;
 pub:=q.operation<>'major.discussion.like.v1';reply:=q.operation='major.discussion.reply.v1';
 keys:=CASE WHEN NOT pub THEN ARRAY['clientRequestId','expectedCatalogRevision','expectedMajorRevision','expectedMembershipRevision','active'] WHEN reply THEN ARRAY['clientRequestId','expectedCatalogRevision','expectedMajorRevision','body','replyToReplyId'] ELSE ARRAY['clientRequestId','expectedCatalogRevision','expectedMajorRevision','body'] END;
 IF NOT whaleu_majors.major_exact_keys(q.command,keys) OR NOT whaleu_majors.major_exact_ids(q.command,ARRAY['clientRequestId','expectedCatalogRevision','expectedMajorRevision']) OR(pub AND(jsonb_typeof(q.command->'body') IS DISTINCT FROM 'string' OR NOT whaleu_majors.major_discussion_body_valid(q.command->>'body'))) OR(reply AND q.command->'replyToReplyId'<>'null'::jsonb AND NOT whaleu_majors.major_exact_ids(q.command,ARRAY['replyToReplyId'])) OR(NOT pub AND(jsonb_typeof(q.command->'active') IS DISTINCT FROM 'boolean' OR(q.command->'expectedMembershipRevision'<>'null'::jsonb AND NOT whaleu_majors.major_exact_ids(q.command,ARRAY['expectedMembershipRevision'])))) THEN RAISE EXCEPTION 'Strict exact Major intent required' USING ERRCODE='23514',CONSTRAINT='major_discussion_causal';END IF;
 IF(reply AND q.receipt->>'rootId' IS DISTINCT FROM q.subject_id::text) OR(NOT pub AND q.receipt->>'commentId' IS DISTINCT FROM q.subject_id::text) THEN RAISE EXCEPTION 'Exact Major receipt subject required' USING ERRCODE='23514',CONSTRAINT='major_discussion_causal';END IF;
 SELECT * INTO c FROM whaleu_majors.major_discussion_comments WHERE actor_id=actor AND request_id=rid;
 SELECT * INTO e FROM whaleu_majors.major_discussion_like_events WHERE actor_id=actor AND request_id=rid;
 -- Every expected recipient exists once, and there are no extra or forged rows.
 IF EXISTS((SELECT recipient_id,kind,event_id,major_id,comment_id,root_id FROM whaleu_notifications.major_discussion_expected(actor,rid) EXCEPT SELECT recipient_id,kind,event_id,major_id,comment_id,root_id FROM whaleu_notifications.major_discussion_notices WHERE actor_id=actor AND request_id=rid) UNION ALL(SELECT recipient_id,kind,event_id,major_id,comment_id,root_id FROM whaleu_notifications.major_discussion_notices WHERE actor_id=actor AND request_id=rid EXCEPT SELECT recipient_id,kind,event_id,major_id,comment_id,root_id FROM whaleu_notifications.major_discussion_expected(actor,rid))) OR EXISTS(SELECT 1 FROM whaleu_notifications.major_discussion_notices WHERE actor_id=actor AND request_id=rid AND(transaction_id<>pg_current_xact_id() OR created_at<>date_trunc('milliseconds',transaction_timestamp()))) THEN RAISE EXCEPTION 'Exact atomic transition notice obligations required' USING ERRCODE='23514',CONSTRAINT='major_discussion_causal';END IF;
 IF q.receipt->>'outcome'='rejected' THEN
  keys:=ARRAY['requestId','operation','majorId','outcome','code']||CASE WHEN reply THEN ARRAY['rootId'] WHEN NOT pub THEN ARRAY['commentId'] ELSE ARRAY[]::text[] END;
  IF NOT whaleu_majors.major_exact_keys(q.receipt,keys) OR c.id IS NOT NULL OR e.id IS NOT NULL THEN RAISE EXCEPTION 'Rejection has no mutation' USING ERRCODE='23514',CONSTRAINT='major_discussion_causal';END IF;
  IF q.receipt->>'code'='MAJOR_DISCUSSION_CANCELLED' THEN RETURN;END IF;
 END IF;
 positive:=pub OR(q.command->>'active')::boolean;
 IF positive THEN
  IF pub AND NOT whaleu_majors.major_publish_base(actor,instant) THEN RAISE EXCEPTION 'Major publication needs verified, temporary or actual administrator base identity' USING ERRCODE='23514',CONSTRAINT='major_discussion_causal';END IF;
  IF NOT whaleu_majors.major_access(actor,q.session_id,instant) THEN RAISE EXCEPTION 'Fresh Major actions need phone and Safety' USING ERRCODE='23514',CONSTRAINT='major_discussion_causal';END IF;
  source:=whaleu_majors.major_discussion_source(q.major_id,instant);
  IF source IS NULL OR source->>'population' IS NULL OR source->>'likes' IS NULL THEN RAISE EXCEPTION 'Independent Major discussion histories required' USING ERRCODE='23514',CONSTRAINT='major_discussion_causal';END IF;
  IF q.receipt->>'outcome'='rejected' AND q.receipt->>'code'='MAJOR_REVISION_CONFLICT' THEN
   IF(source->>'catalog',source->>'revision') IS NOT DISTINCT FROM(q.command->>'expectedCatalogRevision',q.command->>'expectedMajorRevision') THEN RAISE EXCEPTION 'Source conflict must be causal' USING ERRCODE='23514',CONSTRAINT='major_discussion_causal';END IF;RETURN;
  END IF;
  IF(source->>'catalog',source->>'revision') IS DISTINCT FROM(q.command->>'expectedCatalogRevision',q.command->>'expectedMajorRevision') THEN RAISE EXCEPTION 'Current exact Major source required' USING ERRCODE='23514',CONSTRAINT='major_discussion_causal';END IF;
 END IF;
 IF pub THEN
  IF reply THEN
   SELECT * INTO root FROM whaleu_majors.major_discussion_comments WHERE id=q.subject_id AND major_id=q.major_id AND root_id IS NULL;
   IF root.id IS NULL OR whaleu_majors.major_discussion_visibility(root.id,actor,instant)<>'allow' THEN RAISE EXCEPTION 'Reply requires current same-major root' USING ERRCODE='23514',CONSTRAINT='major_discussion_causal';END IF;
   IF q.command->>'replyToReplyId' IS NOT NULL THEN SELECT * INTO target FROM whaleu_majors.major_discussion_comments WHERE id=(q.command->>'replyToReplyId')::uuid AND major_id=q.major_id AND root_id=root.id;
    IF target.id IS NULL OR whaleu_majors.major_discussion_visibility(target.id,actor,instant)<>'allow' THEN RAISE EXCEPTION 'Addressed reply requires same root and current visibility' USING ERRCODE='23514',CONSTRAINT='major_discussion_causal';END IF;
   END IF;
  END IF;
  SELECT decisions.* INTO d FROM whaleu_community.major_discussion_review_decisions decisions JOIN whaleu_community.major_discussion_review_heads h ON h.decision_id=decisions.id WHERE h.actor_id=actor AND h.request_id=rid;
  IF d.id IS NULL OR(d.actor_id,d.request_id,d.major_id,d.catalog_id::text,d.major_revision::text,d.purpose,d.root_id,d.reply_to_reply_id,d.reply_to_actor_id,d.body) IS DISTINCT FROM(actor,rid,q.major_id,q.command->>'expectedCatalogRevision',q.command->>'expectedMajorRevision',q.operation,root.id,target.id,target.actor_id,q.command->>'body') THEN RAISE EXCEPTION 'Exact original Major root/reply Review required' USING ERRCODE='23514',CONSTRAINT='major_discussion_causal';END IF;
  IF q.receipt->>'outcome'='rejected' AND q.receipt->>'code'='CONTENT_REJECTED' AND whaleu_community.major_discussion_review_status(d.id,true,instant)='reject' THEN RETURN;END IF;
  keys:=ARRAY['requestId','operation','majorId','outcome','commentId','createdAt']||CASE WHEN reply THEN ARRAY['rootId'] ELSE ARRAY[]::text[] END;
  IF q.receipt->>'outcome' IS DISTINCT FROM 'applied' OR NOT whaleu_majors.major_exact_keys(q.receipt,keys) OR c.id IS NULL OR e.id IS NOT NULL OR(c.major_id,c.root_id,c.reply_to_reply_id,c.reply_to_actor_id,c.body,c.catalog_id::text,c.major_revision::text,c.population_assertion_id::text,c.review_decision_id) IS DISTINCT FROM(q.major_id,root.id,target.id,target.actor_id,q.command->>'body',source->>'catalog',source->>'revision',source->>'population',d.id) OR c.transaction_id<>pg_current_xact_id() OR c.created_at<>date_trunc('milliseconds',transaction_timestamp()) OR q.receipt->>'commentId' IS DISTINCT FROM c.id::text OR q.receipt->>'createdAt' IS DISTINCT FROM to_char(c.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') OR whaleu_community.major_discussion_review_status(d.id,true,instant)<>'allow' OR NOT EXISTS(SELECT 1 FROM whaleu_profile.profiles WHERE account_id=actor) THEN RAISE EXCEPTION 'Publication needs exact atomic content, Review, profile and receipt' USING ERRCODE='23514',CONSTRAINT='major_discussion_causal';END IF;
 ELSE
  expected:=(q.command->>'expectedMembershipRevision')::uuid;
  IF NOT EXISTS(SELECT 1 FROM whaleu_majors.major_discussion_comments WHERE id=q.subject_id AND major_id=q.major_id) THEN RAISE EXCEPTION 'Like membership subject must exist in exact major' USING ERRCODE='23514',CONSTRAINT='major_discussion_causal';END IF;
  SELECT events.* INTO own FROM whaleu_majors.major_discussion_like_heads h JOIN whaleu_majors.major_discussion_like_events events ON events.id=h.revision WHERE h.major_id=q.major_id AND h.comment_id=q.subject_id AND h.actor_id=actor;
  IF positive THEN
   IF NOT EXISTS(SELECT 1 FROM whaleu_majors.major_discussion_comments WHERE id=q.subject_id AND major_id=q.major_id) OR whaleu_majors.major_discussion_visibility(q.subject_id,actor,instant)<>'allow' THEN RAISE EXCEPTION 'Positive like needs current subject' USING ERRCODE='23514',CONSTRAINT='major_discussion_causal';END IF;
  ELSIF own.id IS NULL AND whaleu_majors.major_discussion_history(q.major_id,'likes',instant) IS NULL THEN RAISE EXCEPTION 'Missing membership is not known absence' USING ERRCODE='23514',CONSTRAINT='major_discussion_causal';END IF;
  IF q.receipt->>'outcome'='rejected' AND q.receipt->>'code'='MAJOR_DISCUSSION_MEMBERSHIP_CONFLICT' THEN IF own.id IS NOT DISTINCT FROM expected THEN RAISE EXCEPTION 'Like CAS conflict must be causal' USING ERRCODE='23514',CONSTRAINT='major_discussion_causal';END IF;RETURN;END IF;
  keys:=ARRAY['requestId','operation','majorId','commentId','outcome','active','membershipRevision','recordedAt'];
  IF NOT whaleu_majors.major_exact_keys(q.receipt,keys) OR c.id IS NOT NULL OR q.receipt->'active' IS DISTINCT FROM q.command->'active' THEN RAISE EXCEPTION 'Exact like receipt required' USING ERRCODE='23514',CONSTRAINT='major_discussion_causal';END IF;
  IF q.receipt->>'outcome'='noop' THEN
   IF e.id IS NOT NULL OR own.id IS DISTINCT FROM expected OR coalesce(own.active,false)<>positive OR q.receipt->'membershipRevision' IS DISTINCT FROM coalesce(to_jsonb(own.id::text),'null'::jsonb) OR q.receipt->'recordedAt' IS DISTINCT FROM coalesce(to_jsonb(to_char(own.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),'null'::jsonb) THEN RAISE EXCEPTION 'Noop requires CAS before state equality and no event' USING ERRCODE='23514',CONSTRAINT='major_discussion_causal';END IF;RETURN;
  END IF;
  IF q.receipt->>'outcome' IS DISTINCT FROM 'applied' OR e.id IS NULL OR own.id IS DISTINCT FROM e.id OR e.major_id<>q.major_id OR e.comment_id<>q.subject_id OR e.active<>positive OR e.transaction_id<>pg_current_xact_id() OR e.recorded_at<>date_trunc('milliseconds',transaction_timestamp()) OR e.previous_revision IS DISTINCT FROM expected OR q.receipt->>'membershipRevision' IS DISTINCT FROM e.id::text OR q.receipt->>'recordedAt' IS DISTINCT FROM to_char(e.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') OR(positive AND(e.catalog_id::text,e.major_revision::text,e.population_assertion_id::text,e.likes_assertion_id::text) IS DISTINCT FROM(source->>'catalog',source->>'revision',source->>'population',source->>'likes')) THEN RAISE EXCEPTION 'Like applied requires atomic causal event/head/receipt' USING ERRCODE='23514',CONSTRAINT='major_discussion_causal';END IF;
 END IF;
END$$;
CREATE FUNCTION whaleu_majors.major_discussion_final() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN PERFORM whaleu_majors.major_discussion_complete(NEW.actor_id,NEW.request_id);RETURN NULL;END$$;
DO $$DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['major_discussion_commands','major_discussion_comments','major_discussion_like_events'] LOOP EXECUTE format('CREATE CONSTRAINT TRIGGER major_discussion_final AFTER INSERT ON whaleu_majors.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_majors.major_discussion_final()',t);END LOOP;END$$;
CREATE CONSTRAINT TRIGGER major_discussion_notice_final AFTER INSERT ON whaleu_notifications.major_discussion_notices DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_majors.major_discussion_final();
CREATE FUNCTION whaleu_majors.major_discussion_head_final() RETURNS trigger LANGUAGE plpgsql AS $$DECLARE e whaleu_majors.major_discussion_like_events;BEGIN SELECT * INTO e FROM whaleu_majors.major_discussion_like_events WHERE id=NEW.revision;PERFORM whaleu_majors.major_discussion_complete(e.actor_id,e.request_id);RETURN NULL;END$$;
CREATE CONSTRAINT TRIGGER major_discussion_head_final AFTER INSERT OR UPDATE ON whaleu_majors.major_discussion_like_heads DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_majors.major_discussion_head_final();
CREATE FUNCTION whaleu_majors.major_discussion_statement_final() RETURNS trigger LANGUAGE plpgsql AS $$DECLARE q record;BEGIN FOR q IN SELECT actor_id,request_id FROM inserted LOOP PERFORM whaleu_majors.major_discussion_complete(q.actor_id,q.request_id);END LOOP;RETURN NULL;END$$;
CREATE TRIGGER major_discussion_statement_final AFTER INSERT ON whaleu_majors.major_discussion_commands REFERENCING NEW TABLE AS inserted FOR EACH STATEMENT EXECUTE FUNCTION whaleu_majors.major_discussion_statement_final();
CREATE FUNCTION whaleu_notifications.major_discussion_read_guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.read_at<>date_trunc('milliseconds',transaction_timestamp()) OR NOT whaleu_identity.major_rating_session(NEW.recipient_id,NEW.session_id,clock_timestamp()) THEN RAISE EXCEPTION 'Current notice owner required' USING ERRCODE='23514',CONSTRAINT='major_discussion_causal';END IF;RETURN NEW;END$$;
CREATE TRIGGER major_discussion_read_guard BEFORE INSERT ON whaleu_notifications.major_discussion_reads FOR EACH ROW EXECUTE FUNCTION whaleu_notifications.major_discussion_read_guard();
CREATE TABLE whaleu_notifications.major_discussion_epoch(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),revision bigint NOT NULL DEFAULT 1 CHECK(revision>0));
INSERT INTO whaleu_notifications.major_discussion_epoch(singleton) VALUES(true);
CREATE FUNCTION whaleu_notifications.major_discussion_epoch_advance() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN UPDATE whaleu_notifications.major_discussion_epoch SET revision=revision+1 WHERE singleton;RETURN NULL;END$$;
CREATE TRIGGER major_discussion_notice_epoch AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_notifications.major_discussion_notices FOR EACH STATEMENT EXECUTE FUNCTION whaleu_notifications.major_discussion_epoch_advance();
CREATE TRIGGER major_discussion_read_epoch AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_notifications.major_discussion_reads FOR EACH STATEMENT EXECUTE FUNCTION whaleu_notifications.major_discussion_epoch_advance();
-- Current reader access is separate from source availability. An already-expired
-- catalog cannot veto a private unavailable notice shell or owner-only closure.
CREATE FUNCTION whaleu_majors.major_discussion_access_deadline(actor uuid,sid uuid,instant timestamptz) RETURNS timestamptz LANGUAGE sql STABLE AS $$
 SELECT min(deadline) FROM(
 SELECT least(s.access_expires_at,s.absolute_expires_at) deadline FROM whaleu_identity.sessions s WHERE s.id=sid AND s.account_id=actor
 UNION ALL SELECT a.expires_at FROM whaleu_verification.account_heads h JOIN whaleu_verification.snapshots s ON s.id=h.snapshot_id JOIN whaleu_verification.assertions a ON a.id=s.phone_assertion_id WHERE h.account_id=actor AND a.assertion_state='verified' AND a.expires_at>instant
 UNION ALL SELECT valid_until FROM whaleu_safety.account_heads WHERE account_id=actor
 ) boundaries
$$;
CREATE FUNCTION whaleu_majors.major_discussion_source_boundary(instant timestamptz) RETURNS timestamptz LANGUAGE sql STABLE AS $$
 SELECT min(boundary.value) FROM whaleu_majors.major_catalog_head h JOIN whaleu_majors.major_catalogs c ON c.id=h.catalog_id JOIN whaleu_majors.major_catalog_acceptances a ON a.catalog_id=c.id CROSS JOIN LATERAL(VALUES(c.accepted_at),(c.valid_until),(a.accepted_at)) boundary(value) WHERE boundary.value>instant
$$;

-- Exact publication eligibility deadlines include off-path upcoming/expiring owner facts.
CREATE FUNCTION whaleu_majors.major_publish_deadline(actor uuid,instant timestamptz) RETURNS timestamptz LANGUAGE sql STABLE AS $$
 SELECT min(value) FROM(
 SELECT b.value FROM whaleu_verification.account_heads h JOIN whaleu_verification.snapshots s ON s.id=h.snapshot_id JOIN whaleu_verification.assertions a ON a.id=s.affiliation_assertion_id CROSS JOIN LATERAL(VALUES(a.verified_at),(a.expires_at)) b(value) WHERE h.account_id=actor AND b.value>instant
 UNION ALL SELECT b.value FROM whaleu_verification.rating_base_heads h JOIN whaleu_verification.rating_base_assertions a ON a.id=h.assertion_id CROSS JOIN LATERAL(VALUES(a.effective_at),(a.valid_until)) b(value) WHERE h.account_id=actor AND b.value>instant
 UNION ALL SELECT b.value FROM whaleu_authorization.role_grants g CROSS JOIN LATERAL(VALUES(g.valid_from),(g.expires_at)) b(value) WHERE g.account_id=actor AND g.revoked_at IS NULL AND b.value>instant
 ) boundaries
$$;
