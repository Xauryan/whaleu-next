-- Bounded Classcomment semantics. No production source/history/Review issuer is seeded.
-- Historical client user_id is NOT authenticated author provenance.
SET LOCAL lock_timeout='5s';
-- Exact ECMAScript trim whitespace set; validate without rewriting accepted bytes.
CREATE FUNCTION whaleu_ratings.course_comment_body_valid(value text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT coalesce(octet_length(value) BETWEEN 1 AND 8000 AND length(btrim(value,U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'))>0,false)
$$;
CREATE TABLE whaleu_ratings.course_comment_history_assertions(
 id uuid PRIMARY KEY,course_id uuid NOT NULL REFERENCES whaleu_ratings.course_identities(id),
 kind text NOT NULL CHECK(kind IN('population','likes')),coverage text NOT NULL CHECK(coverage IN('accepted_empty','unknown')),
 source_reference text NOT NULL CHECK(length(btrim(source_reference)) BETWEEN 1 AND 2000),
 policy_reference text NOT NULL CHECK(length(btrim(policy_reference)) BETWEEN 1 AND 2000),
 accepted_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(accepted_at)),
 valid_until timestamptz NOT NULL CHECK(isfinite(valid_until) AND valid_until>accepted_at),UNIQUE(id,course_id,kind)
);
CREATE TABLE whaleu_ratings.course_comment_history_heads(
 course_id uuid NOT NULL,kind text NOT NULL,assertion_id uuid NOT NULL,PRIMARY KEY(course_id,kind),
 FOREIGN KEY(assertion_id,course_id,kind) REFERENCES whaleu_ratings.course_comment_history_assertions(id,course_id,kind)
);
CREATE TABLE whaleu_ratings.course_comment_epoch(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),revision bigint NOT NULL DEFAULT 1 CHECK(revision>0));
INSERT INTO whaleu_ratings.course_comment_epoch(singleton) VALUES(true);
-- Canonical Review owns this separate purpose. No generic rating target/persona.
CREATE TABLE whaleu_community.course_comment_review_policies(
 id uuid PRIMARY KEY,issuer text NOT NULL CHECK(length(btrim(issuer)) BETWEEN 1 AND 200),
 source_reference text NOT NULL CHECK(length(btrim(source_reference)) BETWEEN 1 AND 2000),
 coverage text NOT NULL CHECK(coverage IN('complete','unknown')),
 valid_from timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(valid_from)),
 valid_until timestamptz NOT NULL CHECK(isfinite(valid_until) AND valid_until>valid_from)
);
CREATE TABLE whaleu_community.course_comment_review_decisions(
 id uuid PRIMARY KEY,actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),request_id uuid NOT NULL,
 course_id uuid NOT NULL REFERENCES whaleu_ratings.course_identities(id),catalog_id uuid NOT NULL,course_revision uuid NOT NULL,
 purpose text NOT NULL DEFAULT 'course.comment.publish.v1' CHECK(purpose='course.comment.publish.v1'),
 body text NOT NULL CHECK(whaleu_ratings.course_comment_body_valid(body)),
 policy_id uuid NOT NULL REFERENCES whaleu_community.course_comment_review_policies(id),
 verdict text NOT NULL CHECK(verdict IN('allow','reject')),digest text NOT NULL,
 issued_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(issued_at)),
 consume_until timestamptz NOT NULL CHECK(isfinite(consume_until) AND consume_until>issued_at),
 visibility_until timestamptz NOT NULL CHECK(isfinite(visibility_until) AND visibility_until>issued_at),
 FOREIGN KEY(catalog_id,course_id,course_revision) REFERENCES whaleu_ratings.course_entries(catalog_id,course_id,revision),
 UNIQUE(id,actor_id,request_id),
 CHECK(digest=encode(sha256(convert_to('whaleu:course-comment-review:v1'||chr(10)||whaleu_community.content_canonical_json(jsonb_build_object('version',1,'purpose',purpose,'actorId',actor_id::text,'requestId',request_id::text,'courseId',course_id::text,'catalogRevision',catalog_id::text,'courseRevision',course_revision::text,'body',body)),'UTF8')),'hex'))
);
CREATE TABLE whaleu_community.course_comment_review_heads(
 actor_id uuid NOT NULL,request_id uuid NOT NULL,decision_id uuid NOT NULL,state text NOT NULL CHECK(state IN('active','revoked')),
 PRIMARY KEY(actor_id,request_id),FOREIGN KEY(decision_id,actor_id,request_id) REFERENCES whaleu_community.course_comment_review_decisions(id,actor_id,request_id)
);
CREATE TABLE whaleu_community.course_comment_review_epoch(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),revision bigint NOT NULL DEFAULT 1 CHECK(revision>0));
INSERT INTO whaleu_community.course_comment_review_epoch(singleton) VALUES(true);
CREATE TABLE whaleu_ratings.course_comment_commands(
 actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),request_id uuid NOT NULL,session_id uuid NOT NULL REFERENCES whaleu_identity.sessions(id),
 course_id uuid NOT NULL REFERENCES whaleu_ratings.course_identities(id),comment_id uuid,
 operation text NOT NULL CHECK(operation IN('course.comment.publish.v1','course.comment.like.v1')),
 command jsonb NOT NULL CHECK(jsonb_typeof(command)='object' AND octet_length(command::text)<=50000),
 intent_hash text NOT NULL CHECK(intent_hash~'^[a-f0-9]{64}$'),receipt jsonb NOT NULL CHECK(jsonb_typeof(receipt)='object' AND octet_length(receipt::text)<=2048),
 transaction_id xid8 NOT NULL DEFAULT pg_current_xact_id(),recorded_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds',transaction_timestamp()),
 PRIMARY KEY(actor_id,request_id),CHECK((operation='course.comment.like.v1')=(comment_id IS NOT NULL)),
 CHECK(intent_hash=encode(sha256(convert_to('whaleu:course-comment-command:v1'||chr(10)||whaleu_community.content_canonical_json(jsonb_build_object('actorId',actor_id::text,'courseId',course_id::text,'commentId',comment_id::text,'operation',operation,'command',command)),'UTF8')),'hex')),
 CHECK((command->>'clientRequestId') IS NOT DISTINCT FROM request_id::text),
 CHECK((receipt->>'requestId') IS NOT DISTINCT FROM request_id::text AND (receipt->>'courseId') IS NOT DISTINCT FROM course_id::text AND (receipt->>'operation') IS NOT DISTINCT FROM operation)
);
CREATE TABLE whaleu_ratings.course_comments(
 id uuid PRIMARY KEY,course_id uuid NOT NULL REFERENCES whaleu_ratings.course_identities(id),actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),request_id uuid NOT NULL,
 catalog_id uuid NOT NULL,course_revision uuid NOT NULL,population_assertion_id uuid NOT NULL,
 body text NOT NULL CHECK(whaleu_ratings.course_comment_body_valid(body)),
 created_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds',transaction_timestamp()),transaction_id xid8 NOT NULL DEFAULT pg_current_xact_id(),
 UNIQUE(actor_id,request_id),UNIQUE(id,course_id),
 FOREIGN KEY(actor_id,request_id) REFERENCES whaleu_ratings.course_comment_commands(actor_id,request_id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(catalog_id,course_id,course_revision) REFERENCES whaleu_ratings.course_entries(catalog_id,course_id,revision),
 FOREIGN KEY(population_assertion_id) REFERENCES whaleu_ratings.course_comment_history_assertions(id)
);
CREATE TABLE whaleu_community.course_comment_review_bindings(
 comment_id uuid PRIMARY KEY REFERENCES whaleu_ratings.course_comments(id) DEFERRABLE INITIALLY DEFERRED,
 course_id uuid NOT NULL REFERENCES whaleu_ratings.course_identities(id),decision_id uuid NOT NULL UNIQUE REFERENCES whaleu_community.course_comment_review_decisions(id),
 transaction_id xid8 NOT NULL DEFAULT pg_current_xact_id()
);
CREATE TABLE whaleu_ratings.course_comment_likes(
 comment_id uuid NOT NULL REFERENCES whaleu_ratings.course_comments(id),actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),request_id uuid NOT NULL,
 history_assertion_id uuid NOT NULL REFERENCES whaleu_ratings.course_comment_history_assertions(id),
 created_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds',transaction_timestamp()),transaction_id xid8 NOT NULL DEFAULT pg_current_xact_id(),
 PRIMARY KEY(comment_id,actor_id),UNIQUE(actor_id,request_id),
 FOREIGN KEY(actor_id,request_id) REFERENCES whaleu_ratings.course_comment_commands(actor_id,request_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX course_comment_review_course ON whaleu_community.course_comment_review_bindings(course_id,comment_id);
CREATE INDEX course_comments_time ON whaleu_ratings.course_comments(course_id,created_at DESC,id DESC);
CREATE FUNCTION whaleu_ratings.course_comment_epoch_advance() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN UPDATE whaleu_ratings.course_comment_epoch SET revision=revision+1 WHERE singleton;RETURN NULL;END$$;
CREATE FUNCTION whaleu_community.course_comment_review_epoch_advance() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN UPDATE whaleu_community.course_comment_review_epoch SET revision=revision+1 WHERE singleton;RETURN NULL;END$$;
DO $$DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['course_comment_history_assertions','course_comment_history_heads','course_comments','course_comment_likes'] LOOP
 EXECUTE format('CREATE TRIGGER course_comment_epoch AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_ratings.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.course_comment_epoch_advance()',t);END LOOP;
 FOREACH t IN ARRAY ARRAY['course_comment_review_policies','course_comment_review_decisions','course_comment_review_heads','course_comment_review_bindings'] LOOP
 EXECUTE format('CREATE TRIGGER course_comment_review_epoch AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_community.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.course_comment_review_epoch_advance()',t);END LOOP;
 FOREACH t IN ARRAY ARRAY['course_comment_history_assertions','course_comments','course_comment_likes','course_comment_commands'] LOOP
 EXECUTE format('CREATE TRIGGER immutable_course_comment BEFORE UPDATE OR DELETE OR TRUNCATE ON whaleu_ratings.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.course_immutable()',t);END LOOP;
 FOREACH t IN ARRAY ARRAY['course_comment_review_policies','course_comment_review_decisions','course_comment_review_bindings'] LOOP
 EXECUTE format('CREATE TRIGGER immutable_course_comment_review BEFORE UPDATE OR DELETE OR TRUNCATE ON whaleu_community.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.course_immutable()',t);END LOOP;
END$$;
-- Owner SQL interfaces use one exact PostgreSQL instant; no JS timestamp roundtrip.
CREATE FUNCTION whaleu_identity.course_comment_session(actor uuid,sid uuid,instant timestamptz) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM whaleu_identity.sessions s JOIN whaleu_identity.accounts a ON a.id=s.account_id WHERE s.id=sid AND s.account_id=actor AND a.status='active' AND s.revoked_at IS NULL AND s.access_expires_at>instant AND s.absolute_expires_at>instant)
$$;
CREATE FUNCTION whaleu_verification.course_comment_fact(actor uuid,kind text,instant timestamptz) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM whaleu_verification.account_heads h JOIN whaleu_verification.snapshots s ON s.id=h.snapshot_id AND s.account_id=h.account_id JOIN whaleu_verification.assertions a ON a.id=CASE WHEN kind='phone' THEN s.phone_assertion_id ELSE s.affiliation_assertion_id END
 WHERE h.account_id=actor AND a.account_id=actor AND a.source_account_id=actor AND a.fact_kind=kind AND a.assertion_state='verified' AND a.coverage_state='complete' AND a.provenance_state='accepted'
 AND length(btrim(a.source_reference))>0 AND length(btrim(a.policy_reference))>0 AND a.issuer_institution_id IS NOT DISTINCT FROM a.source_issuer_institution_id
 AND ((kind='phone' AND a.method IN('phone_provider','reconciled_import') AND a.phone_binding_reference IS NOT NULL) OR (kind='affiliation' AND a.method IN('document_review','institutional_email','institutional_sso','reconciled_import') AND a.issuer_institution_id IS NOT NULL AND a.origin_region_id IS NOT NULL))
 AND isfinite(a.verified_at) AND a.verified_at<=instant AND ((a.expiry_kind='policy_exempt' AND a.expires_at IS NULL) OR(a.expiry_kind='at' AND isfinite(a.expires_at) AND a.expires_at>a.verified_at AND a.expires_at>instant)))
$$;
CREATE FUNCTION whaleu_verification.course_comment_temporary(actor uuid,instant timestamptz) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM whaleu_verification.rating_base_heads h JOIN whaleu_verification.rating_base_assertions a ON a.id=h.assertion_id AND a.account_id=h.account_id WHERE h.account_id=actor AND a.coverage='complete' AND a.provenance='accepted' AND a.state='verified' AND length(btrim(a.issuer))>0 AND length(btrim(a.source_reference))>0 AND length(btrim(a.policy_reference))>0 AND a.effective_at<=instant AND a.valid_until>instant)
$$;
CREATE FUNCTION whaleu_authorization.course_comment_admin(actor uuid,instant timestamptz) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM whaleu_authorization.role_grants WHERE account_id=actor AND role IN('school_admin','super_admin') AND revoked_at IS NULL AND valid_from<=instant AND (expires_at IS NULL OR expires_at>instant))
$$;
CREATE FUNCTION whaleu_safety.course_comment_allowed(actor uuid,instant timestamptz) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM whaleu_safety.account_heads WHERE account_id=actor AND restriction_coverage='complete' AND block_coverage='complete' AND provenance<>'unknown' AND actions_allowed AND (valid_until IS NULL OR valid_until>instant))
$$;
CREATE FUNCTION whaleu_community.course_comment_review_status(did uuid,consume boolean,instant timestamptz) RETURNS text LANGUAGE sql STABLE AS $$
 SELECT coalesce((SELECT CASE WHEN p.coverage<>'complete' OR p.valid_from>d.issued_at OR d.issued_at>instant OR p.valid_until<=instant OR d.visibility_until<=instant OR (consume AND d.consume_until<=instant) THEN 'unavailable' WHEN h.state='revoked' THEN 'deny' ELSE d.verdict END
 FROM whaleu_community.course_comment_review_decisions d JOIN whaleu_community.course_comment_review_policies p ON p.id=d.policy_id JOIN whaleu_community.course_comment_review_heads h ON h.decision_id=d.id AND h.actor_id=d.actor_id AND h.request_id=d.request_id WHERE d.id=did),'unavailable')
$$;
CREATE FUNCTION whaleu_community.course_comment_visibility(cid uuid,instant timestamptz) RETURNS text LANGUAGE sql STABLE AS $$
 SELECT coalesce((SELECT whaleu_community.course_comment_review_status(b.decision_id,false,instant) FROM whaleu_community.course_comment_review_bindings b WHERE b.comment_id=cid),'unavailable')
$$;
CREATE FUNCTION whaleu_ratings.course_comment_history(cid uuid,hkind text,instant timestamptz) RETURNS uuid LANGUAGE sql STABLE AS $$
 SELECT a.id FROM whaleu_ratings.course_comment_history_heads h JOIN whaleu_ratings.course_comment_history_assertions a ON a.id=h.assertion_id AND a.course_id=h.course_id AND a.kind=h.kind WHERE h.course_id=cid AND h.kind=hkind AND a.coverage='accepted_empty' AND a.accepted_at<=instant AND a.valid_until>instant
$$;
CREATE FUNCTION whaleu_ratings.course_comment_source(cid uuid,instant timestamptz) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object('catalog',c.id,'revision',e.revision,'population',whaleu_ratings.course_comment_history(cid,'population',instant),'likes',whaleu_ratings.course_comment_history(cid,'likes',instant))
 FROM whaleu_ratings.course_catalog_head h JOIN whaleu_ratings.course_catalogs c ON c.id=h.catalog_id JOIN whaleu_ratings.course_catalog_acceptances a ON a.catalog_id=c.id JOIN whaleu_ratings.course_entries e ON e.catalog_id=c.id AND e.course_id=cid
 JOIN whaleu_campus.campuses campus ON campus.id=e.campus_id JOIN whaleu_campus.institutions institution ON institution.id=campus.institution_id JOIN whaleu_campus.campus_region_assignments assignment ON assignment.campus_id=campus.id JOIN whaleu_campus.operating_regions region ON region.id=assignment.operating_region_id
 WHERE h.state='accepted' AND c.coverage='complete' AND c.scope_policy='authenticated_phone' AND c.accepted_at<=instant AND a.accepted_at<=instant AND c.valid_until>instant AND campus.is_active AND region.is_active
$$;
CREATE FUNCTION whaleu_ratings.course_comment_access(actor uuid,sid uuid,cid uuid,publish boolean,instant timestamptz) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT whaleu_identity.course_comment_session(actor,sid,instant) AND whaleu_verification.course_comment_fact(actor,'phone',instant) AND whaleu_safety.course_comment_allowed(actor,instant)
 AND whaleu_ratings.course_comment_source(cid,instant) IS NOT NULL
 AND (NOT publish OR whaleu_verification.course_comment_fact(actor,'affiliation',instant) OR whaleu_verification.course_comment_temporary(actor,instant) OR whaleu_authorization.course_comment_admin(actor,instant))
$$;
CREATE FUNCTION whaleu_ratings.course_comment_deadline(actor uuid,sid uuid,cid uuid,publish boolean,instant timestamptz) RETURNS timestamptz LANGUAGE sql STABLE AS $$
 SELECT min(deadline) FROM (
 SELECT least(s.access_expires_at,s.absolute_expires_at) deadline FROM whaleu_identity.sessions s WHERE s.id=sid AND s.account_id=actor
 UNION ALL SELECT a.expires_at FROM whaleu_verification.account_heads h JOIN whaleu_verification.snapshots s ON s.id=h.snapshot_id JOIN whaleu_verification.assertions a ON a.id=s.phone_assertion_id OR (publish AND a.id=s.affiliation_assertion_id) WHERE h.account_id=actor AND a.assertion_state='verified' AND a.expires_at>instant
 UNION ALL SELECT a.valid_until FROM whaleu_verification.rating_base_heads h JOIN whaleu_verification.rating_base_assertions a ON a.id=h.assertion_id WHERE h.account_id=actor AND publish AND a.state='verified' AND a.valid_until>instant
 UNION ALL SELECT least(CASE WHEN g.valid_from>instant THEN g.valid_from END,g.expires_at) FROM whaleu_authorization.role_grants g WHERE g.account_id=actor AND publish AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at>instant)
 UNION ALL SELECT valid_until FROM whaleu_safety.account_heads WHERE account_id=actor
 UNION ALL SELECT c.valid_until FROM whaleu_ratings.course_catalog_head h JOIN whaleu_ratings.course_catalogs c ON c.id=h.catalog_id
 UNION ALL SELECT a.valid_until FROM whaleu_ratings.course_comment_history_heads h JOIN whaleu_ratings.course_comment_history_assertions a ON a.id=h.assertion_id WHERE h.course_id=cid
 ) deadlines
$$;
-- Fixed complete owner table fences. This is also invoked by raw statement and
-- deferred guards, not just managed API transactions.
CREATE FUNCTION whaleu_ratings.course_comment_fence() RETURNS void LANGUAGE plpgsql VOLATILE AS $$BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Course comments require read committed' USING ERRCODE='23514',CONSTRAINT='course_comment_causal';END IF;
 LOCK TABLE whaleu_ratings.course_catalog_head,whaleu_ratings.course_catalogs,whaleu_ratings.course_catalog_acceptances,whaleu_ratings.course_entries,whaleu_ratings.course_identities,whaleu_ratings.course_comment_history_assertions,whaleu_ratings.course_comment_history_heads,whaleu_ratings.course_comments,whaleu_ratings.course_comment_likes,whaleu_ratings.course_comment_commands,whaleu_ratings.course_comment_epoch,whaleu_identity.accounts,whaleu_identity.sessions,whaleu_verification.account_heads,whaleu_verification.snapshots,whaleu_verification.assertions,whaleu_verification.rating_base_heads,whaleu_verification.rating_base_assertions,whaleu_safety.account_heads,whaleu_authorization.role_grants,whaleu_campus.campuses,whaleu_campus.institutions,whaleu_campus.campus_region_assignments,whaleu_campus.operating_regions,whaleu_community.course_comment_review_policies,whaleu_community.course_comment_review_decisions,whaleu_community.course_comment_review_heads,whaleu_community.course_comment_review_bindings,whaleu_community.course_comment_review_epoch IN SHARE MODE NOWAIT;
 IF NOT EXISTS(SELECT 1 FROM whaleu_ratings.course_comment_epoch WHERE singleton) OR NOT EXISTS(SELECT 1 FROM whaleu_community.course_comment_review_epoch WHERE singleton) THEN RAISE EXCEPTION 'Course comment owner epochs unavailable' USING ERRCODE='23514',CONSTRAINT='course_comment_causal';END IF;
END$$;
CREATE FUNCTION whaleu_ratings.course_comment_complete(actor uuid,rid uuid) RETURNS void LANGUAGE plpgsql VOLATILE AS $$
DECLARE q whaleu_ratings.course_comment_commands;c whaleu_ratings.course_comments;l whaleu_ratings.course_comment_likes;d whaleu_community.course_comment_review_decisions;b whaleu_community.course_comment_review_bindings;source jsonb;instant timestamptz;pub boolean;keys text[];BEGIN
 PERFORM whaleu_ratings.course_comment_fence();instant:=clock_timestamp();
 SELECT * INTO q FROM whaleu_ratings.course_comment_commands WHERE actor_id=actor AND request_id=rid;
 IF NOT FOUND OR q.transaction_id<>pg_current_xact_id() OR NOT whaleu_identity.course_comment_session(actor,q.session_id,instant) THEN RAISE EXCEPTION 'Exact current course comment request required' USING ERRCODE='23514',CONSTRAINT='course_comment_causal';END IF;
 pub:=q.operation='course.comment.publish.v1';keys:=CASE WHEN pub THEN ARRAY['clientRequestId','expectedCatalogRevision','expectedCourseRevision','body'] ELSE ARRAY['clientRequestId','expectedCatalogRevision','expectedCourseRevision'] END;
 IF NOT whaleu_community.rating_scoped_keys(q.command,keys) OR NOT whaleu_community.rating_scoped_ids(q.command,ARRAY['clientRequestId','expectedCatalogRevision','expectedCourseRevision']) OR (pub AND (jsonb_typeof(q.command->'body')<>'string' OR NOT whaleu_ratings.course_comment_body_valid(q.command->>'body'))) THEN RAISE EXCEPTION 'Exact typed course comment intent required' USING ERRCODE='23514',CONSTRAINT='course_comment_causal';END IF;
 SELECT * INTO c FROM whaleu_ratings.course_comments WHERE actor_id=actor AND request_id=rid;
 SELECT * INTO l FROM whaleu_ratings.course_comment_likes WHERE actor_id=actor AND request_id=rid;
 IF q.receipt->>'outcome'='rejected' THEN
  keys:=CASE WHEN pub THEN ARRAY['requestId','operation','courseId','outcome','code'] ELSE ARRAY['requestId','operation','courseId','commentId','outcome','code'] END;
  IF NOT whaleu_community.rating_scoped_keys(q.receipt,keys) OR c.id IS NOT NULL OR l.comment_id IS NOT NULL OR (NOT pub AND q.receipt->>'commentId' IS DISTINCT FROM q.comment_id::text) THEN RAISE EXCEPTION 'Rejection must have no mutation' USING ERRCODE='23514',CONSTRAINT='course_comment_causal';END IF;
  IF q.receipt->>'code'='COURSE_COMMENT_CANCELLED' THEN RETURN;END IF;
 END IF;
 IF NOT whaleu_ratings.course_comment_access(actor,q.session_id,q.course_id,pub,instant) THEN RAISE EXCEPTION 'Current course comment authority required' USING ERRCODE='23514',CONSTRAINT='course_comment_causal';END IF;
 source:=whaleu_ratings.course_comment_source(q.course_id,instant);
 IF source->>'population' IS NULL OR source->>'likes' IS NULL THEN RAISE EXCEPTION 'Separate comment and like history required' USING ERRCODE='23514',CONSTRAINT='course_comment_causal';END IF;
 IF q.receipt->>'outcome'='rejected' AND q.receipt->>'code'='COURSE_REVISION_CONFLICT' THEN
  IF (source->>'catalog',source->>'revision') IS NOT DISTINCT FROM (q.command->>'expectedCatalogRevision',q.command->>'expectedCourseRevision') THEN RAISE EXCEPTION 'Revision rejection must be causal' USING ERRCODE='23514',CONSTRAINT='course_comment_causal';END IF;RETURN;
 END IF;
 IF (source->>'catalog',source->>'revision') IS DISTINCT FROM(q.command->>'expectedCatalogRevision',q.command->>'expectedCourseRevision') THEN RAISE EXCEPTION 'Exact source revision required' USING ERRCODE='23514',CONSTRAINT='course_comment_causal';END IF;
 IF pub THEN
  SELECT decisions.* INTO d FROM whaleu_community.course_comment_review_decisions decisions JOIN whaleu_community.course_comment_review_heads h ON h.decision_id=decisions.id WHERE h.actor_id=actor AND h.request_id=rid;
  IF d.id IS NULL OR (d.actor_id,d.request_id,d.course_id,d.catalog_id::text,d.course_revision::text,d.body) IS DISTINCT FROM(actor,rid,q.course_id,q.command->>'expectedCatalogRevision',q.command->>'expectedCourseRevision',q.command->>'body') THEN RAISE EXCEPTION 'Exact Review binding required' USING ERRCODE='23514',CONSTRAINT='course_comment_causal';END IF;
  IF q.receipt->>'outcome'='rejected' AND q.receipt->>'code'='CONTENT_REJECTED' AND whaleu_community.course_comment_review_status(d.id,true,instant)='reject' THEN RETURN;END IF;
  SELECT * INTO b FROM whaleu_community.course_comment_review_bindings WHERE comment_id=c.id;
  IF q.receipt->>'outcome' IS DISTINCT FROM 'applied' OR NOT whaleu_community.rating_scoped_keys(q.receipt,ARRAY['requestId','operation','courseId','outcome','commentId','createdAt']) OR c.id IS NULL OR l.comment_id IS NOT NULL OR c.created_at<>date_trunc('milliseconds',transaction_timestamp()) OR c.transaction_id<>pg_current_xact_id() OR b.transaction_id<>pg_current_xact_id() OR b.decision_id IS DISTINCT FROM d.id OR b.course_id IS DISTINCT FROM q.course_id OR (c.course_id,c.catalog_id::text,c.course_revision::text,c.body,c.population_assertion_id::text) IS DISTINCT FROM(q.course_id,q.command->>'expectedCatalogRevision',q.command->>'expectedCourseRevision',q.command->>'body',source->>'population') OR q.receipt->>'commentId' IS DISTINCT FROM c.id::text OR jsonb_typeof(q.receipt->'createdAt') IS DISTINCT FROM 'string' OR q.receipt->>'createdAt' IS DISTINCT FROM to_char(c.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') OR whaleu_community.course_comment_review_status(d.id,true,instant)<>'allow' THEN RAISE EXCEPTION 'Publication requires atomic exact Review, body and receipt' USING ERRCODE='23514',CONSTRAINT='course_comment_causal';END IF;
 ELSE
  IF whaleu_community.course_comment_visibility(q.comment_id,instant)<>'allow' OR NOT EXISTS(SELECT 1 FROM whaleu_ratings.course_comments WHERE id=q.comment_id AND course_id=q.course_id) THEN RAISE EXCEPTION 'Like target requires current reviewed visibility' USING ERRCODE='23514',CONSTRAINT='course_comment_causal';END IF;
  IF q.receipt->>'outcome'='rejected' AND q.receipt->>'code'='COURSE_COMMENT_ALREADY_LIKED' AND EXISTS(SELECT 1 FROM whaleu_ratings.course_comment_likes WHERE comment_id=q.comment_id AND actor_id=actor AND request_id<>rid) THEN RETURN;END IF;
  IF q.receipt->>'outcome' IS DISTINCT FROM 'applied' OR NOT whaleu_community.rating_scoped_keys(q.receipt,ARRAY['requestId','operation','courseId','commentId','outcome','recordedAt']) OR l.comment_id IS NULL OR c.id IS NOT NULL OR l.created_at<>date_trunc('milliseconds',transaction_timestamp()) OR l.transaction_id<>pg_current_xact_id() OR l.comment_id<>q.comment_id OR l.history_assertion_id::text<>source->>'likes' OR q.receipt->>'commentId' IS DISTINCT FROM q.comment_id::text OR jsonb_typeof(q.receipt->'recordedAt') IS DISTINCT FROM 'string' OR q.receipt->>'recordedAt' IS DISTINCT FROM to_char(l.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') THEN RAISE EXCEPTION 'Like requires atomic lifetime membership and exact receipt' USING ERRCODE='23514',CONSTRAINT='course_comment_causal';END IF;
 END IF;
END$$;
CREATE FUNCTION whaleu_ratings.course_comment_final() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 PERFORM whaleu_ratings.course_comment_complete(NEW.actor_id,NEW.request_id);RETURN NULL;END$$;
DO $$DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['course_comment_commands','course_comments','course_comment_likes'] LOOP
 EXECUTE format('CREATE CONSTRAINT TRIGGER course_comment_final AFTER INSERT ON whaleu_ratings.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.course_comment_final()',t);END LOOP;END$$;
CREATE FUNCTION whaleu_community.course_comment_binding_final() RETURNS trigger LANGUAGE plpgsql AS $$DECLARE c whaleu_ratings.course_comments;BEGIN
 SELECT * INTO c FROM whaleu_ratings.course_comments WHERE id=NEW.comment_id;
 IF c.id IS NULL THEN RAISE EXCEPTION 'Course Review binding requires publication' USING ERRCODE='23514',CONSTRAINT='course_comment_causal';END IF;
 PERFORM whaleu_ratings.course_comment_complete(c.actor_id,c.request_id);RETURN NULL;END$$;
CREATE CONSTRAINT TRIGGER course_comment_binding_final AFTER INSERT ON whaleu_community.course_comment_review_bindings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community.course_comment_binding_final();
CREATE FUNCTION whaleu_ratings.course_comment_statement_final() RETURNS trigger LANGUAGE plpgsql AS $$DECLARE q record;BEGIN
 FOR q IN SELECT actor_id,request_id FROM inserted LOOP PERFORM whaleu_ratings.course_comment_complete(q.actor_id,q.request_id);END LOOP;RETURN NULL;END$$;
CREATE TRIGGER course_comment_statement_final AFTER INSERT ON whaleu_ratings.course_comment_commands REFERENCING NEW TABLE AS inserted FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.course_comment_statement_final();
