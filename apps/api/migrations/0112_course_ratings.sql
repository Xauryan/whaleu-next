-- Source-backed specialist Course.php semantics, deliberately separate from
-- generic rating_target/user_score. NO production catalog, crosswalk or baseline
-- is seeded. An accepted directory alone NEVER certifies an empty score history.
SET LOCAL lock_timeout='5s';
CREATE TABLE whaleu_ratings.course_catalogs (
 id uuid PRIMARY KEY,
 source_namespace text NOT NULL CHECK(length(btrim(source_namespace)) BETWEEN 1 AND 200),
 source_reference text NOT NULL CHECK(length(btrim(source_reference)) BETWEEN 1 AND 2000),
 source_revision text NOT NULL CHECK(length(btrim(source_revision)) BETWEEN 1 AND 200),
 coverage text NOT NULL CHECK(coverage IN ('complete','unknown')),
 scope_policy text NOT NULL CHECK(scope_policy='authenticated_phone'),
 policy_reference text NOT NULL CHECK(length(btrim(policy_reference)) BETWEEN 1 AND 2000),
 accepted_at timestamptz NOT NULL DEFAULT transaction_timestamp() CHECK(isfinite(accepted_at)),
 valid_until timestamptz NOT NULL CHECK(isfinite(valid_until) AND valid_until>accepted_at)
);
CREATE TABLE whaleu_ratings.course_catalog_acceptances (
 catalog_id uuid PRIMARY KEY REFERENCES whaleu_ratings.course_catalogs(id),
 accepted_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);
CREATE TABLE whaleu_ratings.course_catalog_head (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 catalog_id uuid NOT NULL REFERENCES whaleu_ratings.course_catalog_acceptances(catalog_id),
 state text NOT NULL CHECK(state IN ('accepted','withdrawn'))
);
CREATE TABLE whaleu_ratings.course_identities (
 id uuid PRIMARY KEY,
 source_namespace text NOT NULL CHECK(length(btrim(source_namespace)) BETWEEN 1 AND 200),
 source_course_key text NOT NULL CHECK(length(btrim(source_course_key)) BETWEEN 1 AND 200),
 UNIQUE(source_namespace,source_course_key)
);
CREATE TABLE whaleu_ratings.course_entries (
 catalog_id uuid NOT NULL REFERENCES whaleu_ratings.course_catalogs(id),
 course_id uuid NOT NULL REFERENCES whaleu_ratings.course_identities(id),
 revision uuid NOT NULL,
 name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 200),
 department integer NOT NULL CHECK(department BETWEEN 1 AND 54 OR department BETWEEN 90 AND 99),
 category text CHECK(length(category) BETWEEN 1 AND 80),
 nature text CHECK(length(nature)<=100),
 code text CHECK(length(code)<=100),
 campus_id uuid NOT NULL REFERENCES whaleu_campus.campuses(id),
 source_campus_key text NOT NULL CHECK(length(btrim(source_campus_key)) BETWEEN 1 AND 200),
 campus_label text NOT NULL CHECK(length(btrim(campus_label)) BETWEEN 1 AND 200),
 campus_mapping_reference text NOT NULL CHECK(length(btrim(campus_mapping_reference)) BETWEEN 1 AND 2000),
 source_created_at timestamptz NOT NULL CHECK(isfinite(source_created_at)),
 PRIMARY KEY(catalog_id,course_id), UNIQUE(catalog_id,course_id,revision)
);
-- accepted_empty is an explicit independent historical reconciliation assertion.
-- Nonempty/malformed/unmapped legacy history is NOT imported or silently reset.
CREATE TABLE whaleu_ratings.course_history_assertions (
 id uuid PRIMARY KEY,course_id uuid NOT NULL REFERENCES whaleu_ratings.course_identities(id),
 coverage text NOT NULL CHECK(coverage IN ('accepted_empty','unknown')),
 source_reference text NOT NULL CHECK(length(btrim(source_reference)) BETWEEN 1 AND 2000),
 policy_reference text NOT NULL CHECK(length(btrim(policy_reference)) BETWEEN 1 AND 2000),
 accepted_at timestamptz NOT NULL DEFAULT transaction_timestamp() CHECK(isfinite(accepted_at)),
 valid_until timestamptz NOT NULL CHECK(isfinite(valid_until) AND valid_until>accepted_at),
 UNIQUE(id,course_id)
);
CREATE TABLE whaleu_ratings.course_history_heads (
 course_id uuid PRIMARY KEY REFERENCES whaleu_ratings.course_identities(id),
 assertion_id uuid NOT NULL,
 FOREIGN KEY(assertion_id,course_id) REFERENCES whaleu_ratings.course_history_assertions(id,course_id)
);
CREATE TABLE whaleu_ratings.course_score_epoch (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0)
);
INSERT INTO whaleu_ratings.course_score_epoch(singleton) VALUES(true);
CREATE TABLE whaleu_ratings.course_commands (
 actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),request_id uuid NOT NULL,
 course_id uuid NOT NULL REFERENCES whaleu_ratings.course_identities(id),
 command jsonb NOT NULL CHECK(jsonb_typeof(command)='object' AND octet_length(command::text)<=2048),
 intent_hash text NOT NULL CHECK(intent_hash ~ '^[a-f0-9]{64}$'),
 receipt jsonb NOT NULL CHECK(jsonb_typeof(receipt)='object' AND octet_length(receipt::text)<=2048),
 recorded_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds',transaction_timestamp()),
 PRIMARY KEY(actor_id,request_id),
 CHECK(intent_hash=encode(sha256(convert_to('whaleu:course-first-score:v1'||chr(10)||whaleu_community.content_canonical_json(jsonb_build_object('actorId',actor_id::text,'courseId',course_id::text,'command',command)),'UTF8')),'hex')),
 CHECK((command->>'clientRequestId') IS NOT DISTINCT FROM request_id::text),
 CHECK((receipt->>'requestId') IS NOT DISTINCT FROM request_id::text AND (receipt->>'courseId') IS NOT DISTINCT FROM course_id::text AND (receipt->>'operation') IS NOT DISTINCT FROM 'course.first-score.v1')
);
CREATE TABLE whaleu_ratings.course_scores (
 course_id uuid NOT NULL REFERENCES whaleu_ratings.course_identities(id),
 actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
 request_id uuid NOT NULL,
 catalog_id uuid NOT NULL,course_revision uuid NOT NULL,
 history_assertion_id uuid NOT NULL,
 grade_half_units smallint NOT NULL CHECK(grade_half_units BETWEEN 1 AND 10),
 ability_half_units smallint NOT NULL CHECK(ability_half_units BETWEEN 1 AND 10),
 overall_half_units smallint NOT NULL CHECK(overall_half_units BETWEEN 1 AND 10),
 recorded_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds',transaction_timestamp()),
 PRIMARY KEY(course_id,actor_id),UNIQUE(actor_id,request_id),
 FOREIGN KEY(catalog_id,course_id,course_revision) REFERENCES whaleu_ratings.course_entries(catalog_id,course_id,revision),
 FOREIGN KEY(history_assertion_id,course_id) REFERENCES whaleu_ratings.course_history_assertions(id,course_id),
 FOREIGN KEY(actor_id,request_id) REFERENCES whaleu_ratings.course_commands(actor_id,request_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX course_entries_time ON whaleu_ratings.course_entries(catalog_id,source_created_at DESC,course_id);
CREATE INDEX course_scores_summary ON whaleu_ratings.course_scores(course_id);
CREATE FUNCTION whaleu_ratings.course_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Course source, original tuple and receipt history is immutable' USING ERRCODE='23514'; END $$;
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['course_catalogs','course_catalog_acceptances','course_identities','course_entries','course_history_assertions','course_commands','course_scores'] LOOP
 EXECUTE format('CREATE TRIGGER course_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON whaleu_ratings.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.course_immutable()',t);
END LOOP; END $$;
-- Entry assembly and acceptance share the same transaction lock. A seal cannot
-- commit while an earlier entry is uncommitted; a later insert must observe it.
CREATE FUNCTION whaleu_ratings.course_acceptance_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Course source and command writers require READ COMMITTED' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('whaleu:course-catalog-seal:v1:'||NEW.catalog_id::text,0));
 RETURN NEW;
END $$;
CREATE TRIGGER course_acceptance_guard BEFORE INSERT ON whaleu_ratings.course_catalog_acceptances FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.course_acceptance_guard();
CREATE FUNCTION whaleu_ratings.course_entry_source_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Course source and command writers require READ COMMITTED' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('whaleu:course-catalog-seal:v1:'||NEW.catalog_id::text,0));
 IF EXISTS(SELECT 1 FROM whaleu_ratings.course_catalog_acceptances WHERE catalog_id=NEW.catalog_id) OR NOT EXISTS(SELECT 1 FROM whaleu_ratings.course_catalogs c JOIN whaleu_ratings.course_identities i ON i.id=NEW.course_id AND i.source_namespace=c.source_namespace WHERE c.id=NEW.catalog_id) THEN RAISE EXCEPTION 'Course identity requires exact source namespace' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER course_entry_source_guard BEFORE INSERT ON whaleu_ratings.course_entries FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.course_entry_source_guard();
CREATE FUNCTION whaleu_ratings.course_score_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Course source and command writers require READ COMMITTED' USING ERRCODE='23514'; END IF;
 IF NEW.recorded_at<>date_trunc('milliseconds',transaction_timestamp()) OR NOT EXISTS(SELECT 1 FROM whaleu_ratings.course_catalog_head h JOIN whaleu_ratings.course_catalogs c ON c.id=h.catalog_id WHERE h.state='accepted' AND c.id=NEW.catalog_id AND c.coverage='complete' AND c.accepted_at<=clock_timestamp() AND c.valid_until>clock_timestamp()) OR NOT EXISTS(SELECT 1 FROM whaleu_ratings.course_history_heads h JOIN whaleu_ratings.course_history_assertions a ON a.id=h.assertion_id AND a.course_id=h.course_id WHERE h.course_id=NEW.course_id AND a.id=NEW.history_assertion_id AND a.coverage='accepted_empty' AND a.accepted_at<=clock_timestamp() AND a.valid_until>clock_timestamp()) THEN RAISE EXCEPTION 'First course tuple requires current accepted catalog and separate history proof' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER course_score_insert_guard BEFORE INSERT ON whaleu_ratings.course_scores FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.course_score_insert_guard();
CREATE FUNCTION whaleu_ratings.course_advance_score_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN UPDATE whaleu_ratings.course_score_epoch SET revision=revision+1 WHERE singleton; RETURN NULL; END $$;
CREATE TRIGGER course_advance_score_epoch AFTER INSERT ON whaleu_ratings.course_scores FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.course_advance_score_epoch();
CREATE FUNCTION whaleu_ratings.course_command_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q whaleu_ratings.course_commands; s whaleu_ratings.course_scores; aid uuid; rid uuid;
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Course source and command writers require READ COMMITTED' USING ERRCODE='23514'; END IF;
 IF TG_TABLE_NAME='course_commands' THEN aid:=NEW.actor_id;rid:=NEW.request_id; ELSE aid:=NEW.actor_id;rid:=NEW.request_id; END IF;
 SELECT * INTO q FROM whaleu_ratings.course_commands WHERE actor_id=aid AND request_id=rid;
 IF NOT FOUND OR q.recorded_at<>date_trunc('milliseconds',transaction_timestamp()) OR NOT (q.command ?& ARRAY['clientRequestId','expectedCatalogRevision','expectedCourseRevision','gradeScore','abilityScore','overallScore']) OR q.command-ARRAY['clientRequestId','expectedCatalogRevision','expectedCourseRevision','gradeScore','abilityScore','overallScore']<>'{}'::jsonb OR jsonb_typeof(q.command->'clientRequestId')<>'string' OR jsonb_typeof(q.command->'expectedCatalogRevision')<>'string' OR jsonb_typeof(q.command->'expectedCourseRevision')<>'string' OR NOT coalesce(q.command->>'expectedCatalogRevision' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$',false) OR NOT coalesce(q.command->>'expectedCourseRevision' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$',false) OR jsonb_typeof(q.command->'gradeScore')<>'number' OR jsonb_typeof(q.command->'abilityScore')<>'number' OR jsonb_typeof(q.command->'overallScore')<>'number' OR NOT ((q.command->>'gradeScore')::numeric*2 BETWEEN 1 AND 10 AND mod((q.command->>'gradeScore')::numeric*2,1)=0 AND (q.command->>'abilityScore')::numeric*2 BETWEEN 1 AND 10 AND mod((q.command->>'abilityScore')::numeric*2,1)=0 AND (q.command->>'overallScore')::numeric*2 BETWEEN 1 AND 10 AND mod((q.command->>'overallScore')::numeric*2,1)=0) THEN RAISE EXCEPTION 'Course receipt requires exact typed intent' USING ERRCODE='23514'; END IF;
 SELECT * INTO s FROM whaleu_ratings.course_scores WHERE actor_id=aid AND request_id=rid;
 IF q.receipt->>'outcome'='applied' THEN
  IF NOT FOUND OR NOT (q.receipt ?& ARRAY['requestId','operation','courseId','outcome','gradeScore','abilityScore','overallScore','recordedAt']) OR s.course_id<>q.course_id OR (q.command->>'expectedCatalogRevision')::uuid<>s.catalog_id OR (q.command->>'expectedCourseRevision')::uuid<>s.course_revision OR (q.command->>'gradeScore')::numeric*2<>s.grade_half_units OR (q.command->>'abilityScore')::numeric*2<>s.ability_half_units OR (q.command->>'overallScore')::numeric*2<>s.overall_half_units OR q.receipt-ARRAY['requestId','operation','courseId','outcome','gradeScore','abilityScore','overallScore','recordedAt']<>'{}'::jsonb OR q.receipt->'gradeScore' IS DISTINCT FROM q.command->'gradeScore' OR q.receipt->'abilityScore' IS DISTINCT FROM q.command->'abilityScore' OR q.receipt->'overallScore' IS DISTINCT FROM q.command->'overallScore' OR jsonb_typeof(q.receipt->'recordedAt')<>'string' OR (q.receipt->>'recordedAt')::timestamptz IS DISTINCT FROM s.recorded_at THEN RAISE EXCEPTION 'Applied course receipt requires its exact atomic original tuple' USING ERRCODE='23514'; END IF;
 ELSIF q.receipt->>'outcome'='rejected' THEN
  -- A terminal rejection needs positive current source authority, not merely
  -- the absence of a matching revision (withdrawn/missing is unavailable).
  PERFORM 1 FROM whaleu_ratings.course_catalog_head h JOIN whaleu_ratings.course_catalogs c ON c.id=h.catalog_id JOIN whaleu_ratings.course_entries e ON e.catalog_id=c.id WHERE h.state='accepted' AND c.coverage='complete' AND c.accepted_at<=clock_timestamp() AND c.valid_until>clock_timestamp() AND e.course_id=q.course_id FOR SHARE OF h,c,e;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unavailable course source cannot mint terminal rejection' USING ERRCODE='23514'; END IF;
  IF s.course_id IS NOT NULL OR NOT (q.receipt ?& ARRAY['requestId','operation','courseId','outcome','code']) OR q.receipt-ARRAY['requestId','operation','courseId','outcome','code']<>'{}'::jsonb OR NOT coalesce(q.receipt->>'code' IN ('COURSE_ALREADY_RATED','COURSE_REVISION_CONFLICT'),false) OR (q.receipt->>'code'='COURSE_ALREADY_RATED' AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.course_scores WHERE course_id=q.course_id AND actor_id=q.actor_id)) OR (q.receipt->>'code'='COURSE_REVISION_CONFLICT' AND EXISTS(SELECT 1 FROM whaleu_ratings.course_catalog_head h JOIN whaleu_ratings.course_entries e ON e.catalog_id=h.catalog_id WHERE h.state='accepted' AND e.course_id=q.course_id AND e.catalog_id=(q.command->>'expectedCatalogRevision')::uuid AND e.revision=(q.command->>'expectedCourseRevision')::uuid)) THEN RAISE EXCEPTION 'Rejected course receipt cannot claim an inserted tuple' USING ERRCODE='23514'; END IF;
 ELSE RAISE EXCEPTION 'Unknown course receipt outcome' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER course_command_complete AFTER INSERT ON whaleu_ratings.course_commands DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.course_command_complete();
CREATE CONSTRAINT TRIGGER course_score_complete AFTER INSERT ON whaleu_ratings.course_scores DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.course_command_complete();
-- Catalog activation/withdrawal and history coverage changes invalidate every
-- directory continuation as well as changes to score-based ordering.
CREATE TRIGGER course_history_navigation AFTER INSERT OR UPDATE OR DELETE ON whaleu_ratings.course_history_heads FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.course_advance_score_epoch();
CREATE TRIGGER course_catalog_navigation AFTER INSERT OR UPDATE OR DELETE ON whaleu_ratings.course_catalog_head FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.course_advance_score_epoch();
