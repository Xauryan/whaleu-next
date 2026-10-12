-- W1: accepted canteen/floor/window topology and independent mutable signed scores.
-- No production catalog, source mapping, score history or issuer is seeded.
SET LOCAL lock_timeout='5s';
CREATE TABLE whaleu_ratings.window_catalogs (
 id uuid PRIMARY KEY,source_namespace text NOT NULL CHECK(length(btrim(source_namespace)) BETWEEN 1 AND 200),
 source_reference text NOT NULL CHECK(length(btrim(source_reference)) BETWEEN 1 AND 2000),source_revision text NOT NULL CHECK(length(btrim(source_revision)) BETWEEN 1 AND 200),
 coverage text NOT NULL CHECK(coverage IN('complete','unknown')),scope_policy text NOT NULL CHECK(scope_policy='authenticated_phone'),
 policy_reference text NOT NULL CHECK(length(btrim(policy_reference)) BETWEEN 1 AND 2000),
 accepted_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(accepted_at)),
 valid_until timestamptz NOT NULL CHECK(isfinite(valid_until) AND valid_until>accepted_at)
);
CREATE TABLE whaleu_ratings.window_catalog_acceptances(catalog_id uuid PRIMARY KEY REFERENCES whaleu_ratings.window_catalogs(id),accepted_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(accepted_at)));
CREATE TABLE whaleu_ratings.window_catalog_head(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),catalog_id uuid NOT NULL REFERENCES whaleu_ratings.window_catalog_acceptances(catalog_id),state text NOT NULL CHECK(state IN('accepted','withdrawn')));
CREATE TABLE whaleu_ratings.canteen_identities(id uuid PRIMARY KEY,source_namespace text NOT NULL CHECK(length(btrim(source_namespace)) BETWEEN 1 AND 200),source_canteen_key text NOT NULL CHECK(length(btrim(source_canteen_key)) BETWEEN 1 AND 200),UNIQUE(source_namespace,source_canteen_key));
CREATE TABLE whaleu_ratings.window_floor_identities(id uuid PRIMARY KEY,canteen_id uuid NOT NULL REFERENCES whaleu_ratings.canteen_identities(id),source_floor_key text NOT NULL CHECK(length(source_floor_key) BETWEEN 1 AND 200),UNIQUE(canteen_id,source_floor_key),UNIQUE(id,canteen_id));
CREATE TABLE whaleu_ratings.window_identities(id uuid PRIMARY KEY,source_namespace text NOT NULL CHECK(length(btrim(source_namespace)) BETWEEN 1 AND 200),source_window_key text NOT NULL CHECK(length(btrim(source_window_key)) BETWEEN 1 AND 200),UNIQUE(source_namespace,source_window_key));
CREATE TABLE whaleu_ratings.canteen_entries(
 catalog_id uuid NOT NULL REFERENCES whaleu_ratings.window_catalogs(id),canteen_id uuid NOT NULL REFERENCES whaleu_ratings.canteen_identities(id),revision uuid NOT NULL,
 name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 200),is_active boolean NOT NULL,
 campus_id uuid NOT NULL REFERENCES whaleu_campus.campuses(id),source_campus_key text NOT NULL CHECK(length(btrim(source_campus_key)) BETWEEN 1 AND 200),
 campus_label text NOT NULL CHECK(length(btrim(campus_label)) BETWEEN 1 AND 200),campus_mapping_reference text NOT NULL CHECK(length(btrim(campus_mapping_reference)) BETWEEN 1 AND 2000),
 PRIMARY KEY(catalog_id,canteen_id)
);
CREATE TABLE whaleu_ratings.window_floor_entries(
 catalog_id uuid NOT NULL,canteen_id uuid NOT NULL,floor_id uuid NOT NULL,label text NOT NULL CHECK(length(btrim(label)) BETWEEN 1 AND 200),is_active boolean NOT NULL,
 PRIMARY KEY(catalog_id,floor_id),UNIQUE(catalog_id,canteen_id,floor_id),
 FOREIGN KEY(catalog_id,canteen_id) REFERENCES whaleu_ratings.canteen_entries(catalog_id,canteen_id),FOREIGN KEY(floor_id,canteen_id) REFERENCES whaleu_ratings.window_floor_identities(id,canteen_id)
);
CREATE TABLE whaleu_ratings.window_entries(
 catalog_id uuid NOT NULL,window_id uuid NOT NULL REFERENCES whaleu_ratings.window_identities(id),revision uuid NOT NULL,canteen_id uuid NOT NULL,floor_id uuid NOT NULL,
 name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 200),is_active boolean NOT NULL,
 PRIMARY KEY(catalog_id,window_id),UNIQUE(catalog_id,window_id,revision),
 FOREIGN KEY(catalog_id,canteen_id,floor_id) REFERENCES whaleu_ratings.window_floor_entries(catalog_id,canteen_id,floor_id)
);
-- Accepted topology never implies accepted score population. Only separately
-- reconciled empty legacy coverage is supported here; real imports stay gated.
CREATE TABLE whaleu_ratings.window_history_assertions(
 id uuid PRIMARY KEY,window_id uuid NOT NULL REFERENCES whaleu_ratings.window_identities(id),coverage text NOT NULL CHECK(coverage IN('accepted_empty','unknown')),
 source_reference text NOT NULL CHECK(length(btrim(source_reference)) BETWEEN 1 AND 2000),policy_reference text NOT NULL CHECK(length(btrim(policy_reference)) BETWEEN 1 AND 2000),
 accepted_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(accepted_at)),valid_until timestamptz NOT NULL CHECK(isfinite(valid_until) AND valid_until>accepted_at),UNIQUE(id,window_id)
);
CREATE TABLE whaleu_ratings.window_history_heads(window_id uuid PRIMARY KEY,assertion_id uuid NOT NULL,FOREIGN KEY(assertion_id,window_id) REFERENCES whaleu_ratings.window_history_assertions(id,window_id));
CREATE TABLE whaleu_ratings.window_score_epoch(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),revision bigint NOT NULL DEFAULT 1 CHECK(revision>0));
INSERT INTO whaleu_ratings.window_score_epoch(singleton) VALUES(true);
CREATE TABLE whaleu_ratings.window_commands(
 actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),request_id uuid NOT NULL,session_id uuid NOT NULL REFERENCES whaleu_identity.sessions(id),window_id uuid NOT NULL REFERENCES whaleu_ratings.window_identities(id),
 command jsonb NOT NULL CHECK(jsonb_typeof(command)='object' AND octet_length(command::text)<=2048),intent_hash text NOT NULL CHECK(intent_hash ~ '^[a-f0-9]{64}$'),
 receipt jsonb NOT NULL CHECK(jsonb_typeof(receipt)='object' AND octet_length(receipt::text)<=2048),transaction_id xid8 NOT NULL DEFAULT pg_current_xact_id(),PRIMARY KEY(actor_id,request_id),
 CHECK(intent_hash=encode(sha256(convert_to('whaleu:window-score-set:v1'||chr(10)||whaleu_community.content_canonical_json(jsonb_build_object('actorId',actor_id::text,'windowId',window_id::text,'command',command)),'UTF8')),'hex')),
 CHECK((command->>'clientRequestId') IS NOT DISTINCT FROM request_id::text),
 CHECK((receipt->>'requestId') IS NOT DISTINCT FROM request_id::text AND (receipt->>'windowId') IS NOT DISTINCT FROM window_id::text AND (receipt->>'operation') IS NOT DISTINCT FROM 'window.score.set.v1')
);
CREATE TABLE whaleu_ratings.window_score_events(
 id uuid PRIMARY KEY,window_id uuid NOT NULL REFERENCES whaleu_ratings.window_identities(id),actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),request_id uuid NOT NULL,
 previous_revision uuid,catalog_id uuid NOT NULL,window_revision uuid NOT NULL,history_assertion_id uuid NOT NULL,score smallint NOT NULL CHECK(score BETWEEN -10 AND 10),
 recorded_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds',transaction_timestamp()),transaction_id xid8 NOT NULL DEFAULT pg_current_xact_id(),
 UNIQUE(window_id,actor_id,id),UNIQUE(actor_id,request_id),UNIQUE(window_id,actor_id,transaction_id),
 FOREIGN KEY(window_id,actor_id,previous_revision) REFERENCES whaleu_ratings.window_score_events(window_id,actor_id,id),
 FOREIGN KEY(catalog_id,window_id,window_revision) REFERENCES whaleu_ratings.window_entries(catalog_id,window_id,revision),
 FOREIGN KEY(history_assertion_id,window_id) REFERENCES whaleu_ratings.window_history_assertions(id,window_id),
 FOREIGN KEY(actor_id,request_id) REFERENCES whaleu_ratings.window_commands(actor_id,request_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE whaleu_ratings.window_score_heads(window_id uuid NOT NULL,actor_id uuid NOT NULL,revision uuid NOT NULL,PRIMARY KEY(window_id,actor_id),FOREIGN KEY(window_id,actor_id,revision) REFERENCES whaleu_ratings.window_score_events(window_id,actor_id,id));
CREATE FUNCTION whaleu_ratings.window_immutable() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'Accepted window source and original score history is immutable' USING ERRCODE='23514',CONSTRAINT='window_score_causal';END$$;
DO $$DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['window_catalogs','window_catalog_acceptances','canteen_identities','window_floor_identities','window_identities','canteen_entries','window_floor_entries','window_entries','window_history_assertions','window_commands','window_score_events'] LOOP
 EXECUTE format('CREATE TRIGGER window_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON whaleu_ratings.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.window_immutable()',t);END LOOP;END$$;
CREATE TRIGGER window_head_no_delete BEFORE DELETE OR TRUNCATE ON whaleu_ratings.window_score_heads FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.window_immutable();
CREATE FUNCTION whaleu_ratings.window_epoch_advance() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN UPDATE whaleu_ratings.window_score_epoch SET revision=revision+1 WHERE singleton;RETURN NULL;END$$;
DO $$DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['window_catalog_head','window_history_assertions','window_history_heads','window_score_heads'] LOOP
 EXECUTE format('CREATE TRIGGER window_epoch AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_ratings.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.window_epoch_advance()',t);END LOOP;END$$;
CREATE FUNCTION whaleu_ratings.window_source_seal() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Window source writers require read committed' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('whaleu:window-catalog-seal:v1:'||NEW.catalog_id::text,0));
 IF TG_TABLE_NAME='window_catalog_acceptances' THEN
  IF (SELECT count(*) FROM whaleu_ratings.canteen_entries WHERE catalog_id=NEW.catalog_id)>100 OR EXISTS(SELECT 1 FROM whaleu_ratings.window_floor_entries WHERE catalog_id=NEW.catalog_id GROUP BY canteen_id HAVING count(*)>100) THEN RAISE EXCEPTION 'Bounded canteen/floor catalog required' USING ERRCODE='23514';END IF;
 ELSE
  IF EXISTS(SELECT 1 FROM whaleu_ratings.window_catalog_acceptances WHERE catalog_id=NEW.catalog_id) THEN RAISE EXCEPTION 'Accepted catalog is sealed' USING ERRCODE='23514';END IF;
  IF TG_TABLE_NAME='canteen_entries' THEN IF NOT EXISTS(SELECT 1 FROM whaleu_ratings.window_catalogs c JOIN whaleu_ratings.canteen_identities i ON i.id=NEW.canteen_id AND i.source_namespace=c.source_namespace WHERE c.id=NEW.catalog_id) THEN RAISE EXCEPTION 'Canteen source namespace mismatch' USING ERRCODE='23514';END IF;END IF;
  IF TG_TABLE_NAME='window_entries' THEN IF NOT EXISTS(SELECT 1 FROM whaleu_ratings.window_catalogs c JOIN whaleu_ratings.window_identities i ON i.id=NEW.window_id AND i.source_namespace=c.source_namespace WHERE c.id=NEW.catalog_id) THEN RAISE EXCEPTION 'Window source namespace mismatch' USING ERRCODE='23514';END IF;END IF;
 END IF;RETURN NEW;
END$$;
DO $$DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['window_catalog_acceptances','canteen_entries','window_floor_entries','window_entries'] LOOP
 EXECUTE format('CREATE TRIGGER window_source_seal BEFORE INSERT ON whaleu_ratings.%I FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.window_source_seal()',t);END LOOP;END$$;
CREATE FUNCTION whaleu_identity.window_rating_session(actor uuid,sid uuid,instant timestamptz) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM whaleu_identity.sessions s JOIN whaleu_identity.accounts a ON a.id=s.account_id WHERE s.id=sid AND s.account_id=actor AND a.status='active' AND s.revoked_at IS NULL AND s.access_expires_at>instant AND s.absolute_expires_at>instant)
$$;
CREATE FUNCTION whaleu_verification.window_rating_fact(actor uuid,kind text,instant timestamptz) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM whaleu_verification.account_heads h JOIN whaleu_verification.snapshots s ON s.id=h.snapshot_id AND s.account_id=h.account_id JOIN whaleu_verification.assertions a ON a.id=CASE WHEN kind='phone' THEN s.phone_assertion_id ELSE s.affiliation_assertion_id END
 WHERE h.account_id=actor AND a.account_id=actor AND a.source_account_id=actor AND a.fact_kind=kind AND a.assertion_state='verified' AND a.coverage_state='complete' AND a.provenance_state='accepted'
 AND length(btrim(a.source_reference))>0 AND length(btrim(a.policy_reference))>0 AND a.issuer_institution_id IS NOT DISTINCT FROM a.source_issuer_institution_id
 AND ((kind='phone' AND a.method IN('phone_provider','reconciled_import') AND a.phone_binding_reference IS NOT NULL) OR (kind='affiliation' AND a.method IN('document_review','institutional_email','institutional_sso','reconciled_import') AND a.issuer_institution_id IS NOT NULL AND a.origin_region_id IS NOT NULL))
 AND isfinite(a.verified_at) AND a.verified_at<=instant AND ((a.expiry_kind='policy_exempt' AND a.expires_at IS NULL) OR(a.expiry_kind='at' AND isfinite(a.expires_at) AND a.expires_at>a.verified_at AND a.expires_at>instant)))
$$;
CREATE FUNCTION whaleu_safety.window_rating_allowed(actor uuid,instant timestamptz) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM whaleu_safety.account_heads WHERE account_id=actor AND restriction_coverage='complete' AND block_coverage='complete' AND provenance<>'unknown' AND actions_allowed AND (valid_until IS NULL OR valid_until>instant))
$$;
CREATE FUNCTION whaleu_ratings.window_history(wid uuid,instant timestamptz) RETURNS uuid LANGUAGE sql STABLE AS $$
 SELECT a.id FROM whaleu_ratings.window_history_heads h JOIN whaleu_ratings.window_history_assertions a ON a.id=h.assertion_id AND a.window_id=h.window_id WHERE h.window_id=wid AND a.coverage='accepted_empty' AND a.accepted_at<=instant AND a.valid_until>instant
$$;
-- Canonical mapping is independently accepted evidence, never browsing-campus
-- authority. The full current mapping population participates in the stamp.
CREATE FUNCTION whaleu_ratings.window_catalog_source(instant timestamptz) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object('catalog',c.id,'head',to_jsonb(h),'source',to_jsonb(c),'acceptance',to_jsonb(a),'mappings',coalesce((SELECT jsonb_agg(jsonb_build_array(e.canteen_id,to_jsonb(campus),to_jsonb(institution),to_jsonb(assignment),to_jsonb(region)) ORDER BY e.canteen_id) FROM whaleu_ratings.canteen_entries e JOIN whaleu_campus.campuses campus ON campus.id=e.campus_id JOIN whaleu_campus.institutions institution ON institution.id=campus.institution_id JOIN whaleu_campus.campus_region_assignments assignment ON assignment.campus_id=campus.id JOIN whaleu_campus.operating_regions region ON region.id=assignment.operating_region_id WHERE e.catalog_id=c.id AND e.is_active),'[]'::jsonb))
 FROM whaleu_ratings.window_catalog_head h JOIN whaleu_ratings.window_catalogs c ON c.id=h.catalog_id JOIN whaleu_ratings.window_catalog_acceptances a ON a.catalog_id=c.id
 WHERE h.singleton AND h.state='accepted' AND c.coverage='complete' AND c.scope_policy='authenticated_phone' AND c.accepted_at<=instant AND a.accepted_at<=instant AND c.valid_until>instant
 AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.canteen_entries e WHERE e.catalog_id=c.id AND e.is_active AND NOT EXISTS(SELECT 1 FROM whaleu_campus.campuses campus JOIN whaleu_campus.institutions institution ON institution.id=campus.institution_id JOIN whaleu_campus.campus_region_assignments assignment ON assignment.campus_id=campus.id JOIN whaleu_campus.operating_regions region ON region.id=assignment.operating_region_id WHERE campus.id=e.campus_id AND campus.is_active AND region.is_active))
$$;
CREATE FUNCTION whaleu_ratings.window_source(wid uuid,instant timestamptz) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object('catalog',e.catalog_id,'revision',e.revision,'history',whaleu_ratings.window_history(wid,instant)) FROM whaleu_ratings.window_entries e JOIN whaleu_ratings.canteen_entries c ON c.catalog_id=e.catalog_id AND c.canteen_id=e.canteen_id JOIN whaleu_ratings.window_floor_entries f ON f.catalog_id=e.catalog_id AND f.canteen_id=e.canteen_id AND f.floor_id=e.floor_id WHERE e.window_id=wid AND e.catalog_id=(whaleu_ratings.window_catalog_source(instant)->>'catalog')::uuid AND e.is_active AND c.is_active AND f.is_active
$$;
CREATE FUNCTION whaleu_ratings.window_access(actor uuid,sid uuid,instant timestamptz) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT whaleu_identity.window_rating_session(actor,sid,instant) AND whaleu_verification.window_rating_fact(actor,'phone',instant) AND whaleu_safety.window_rating_allowed(actor,instant)
$$;
CREATE FUNCTION whaleu_ratings.window_deadline(actor uuid,sid uuid,instant timestamptz) RETURNS timestamptz LANGUAGE sql STABLE AS $$
 SELECT min(deadline) FROM (
 SELECT least(s.access_expires_at,s.absolute_expires_at) deadline FROM whaleu_identity.sessions s WHERE s.id=sid AND s.account_id=actor
 UNION ALL SELECT a.expires_at FROM whaleu_verification.account_heads h JOIN whaleu_verification.snapshots s ON s.id=h.snapshot_id JOIN whaleu_verification.assertions a ON a.id=s.phone_assertion_id WHERE h.account_id=actor AND a.assertion_state='verified' AND a.expires_at>instant
 UNION ALL SELECT valid_until FROM whaleu_safety.account_heads WHERE account_id=actor
 UNION ALL SELECT c.valid_until FROM whaleu_ratings.window_catalog_head h JOIN whaleu_ratings.window_catalogs c ON c.id=h.catalog_id
 ) deadlines
$$;
CREATE FUNCTION whaleu_ratings.window_fence() RETURNS void LANGUAGE plpgsql VOLATILE AS $$BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Window ratings require read committed' USING ERRCODE='23514',CONSTRAINT='window_score_causal';END IF;
 LOCK TABLE whaleu_ratings.window_catalog_head,whaleu_ratings.window_catalogs,whaleu_ratings.window_catalog_acceptances,whaleu_ratings.canteen_identities,whaleu_ratings.window_floor_identities,whaleu_ratings.window_identities,whaleu_ratings.canteen_entries,whaleu_ratings.window_floor_entries,whaleu_ratings.window_entries,whaleu_ratings.window_history_assertions,whaleu_ratings.window_history_heads,whaleu_ratings.window_score_events,whaleu_ratings.window_score_heads,whaleu_ratings.window_commands,whaleu_ratings.window_score_epoch,whaleu_identity.accounts,whaleu_identity.sessions,whaleu_verification.account_heads,whaleu_verification.snapshots,whaleu_verification.assertions,whaleu_safety.account_heads,whaleu_campus.campuses,whaleu_campus.institutions,whaleu_campus.campus_region_assignments,whaleu_campus.operating_regions IN SHARE MODE NOWAIT;
 IF NOT EXISTS(SELECT 1 FROM whaleu_ratings.window_score_epoch WHERE singleton) THEN RAISE EXCEPTION 'Window score epoch unavailable' USING ERRCODE='23514',CONSTRAINT='window_score_causal';END IF;
END$$;
CREATE FUNCTION whaleu_ratings.window_lock(actor uuid,rid uuid,wid uuid) RETURNS void LANGUAGE plpgsql VOLATILE AS $$BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Window writers require read committed' USING ERRCODE='23514',CONSTRAINT='window_score_causal';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('whaleu:window-request:v1:'||actor::text||':'||rid::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('whaleu:window-own-score:v1:'||actor::text||':'||wid::text,0));
END$$;
CREATE FUNCTION whaleu_ratings.window_write_lock() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 PERFORM whaleu_ratings.window_lock(NEW.actor_id,NEW.request_id,NEW.window_id);RETURN NEW;
END$$;
CREATE TRIGGER window_command_lock BEFORE INSERT ON whaleu_ratings.window_commands FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.window_write_lock();
CREATE FUNCTION whaleu_ratings.window_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$DECLARE own uuid;source jsonb;BEGIN
 PERFORM whaleu_ratings.window_lock(NEW.actor_id,NEW.request_id,NEW.window_id);
 SELECT revision INTO own FROM whaleu_ratings.window_score_heads WHERE window_id=NEW.window_id AND actor_id=NEW.actor_id;
 source:=whaleu_ratings.window_source(NEW.window_id,clock_timestamp());
 IF NEW.transaction_id<>pg_current_xact_id() OR NEW.recorded_at<>date_trunc('milliseconds',transaction_timestamp()) OR NEW.previous_revision IS DISTINCT FROM own OR (source->>'catalog',source->>'revision',source->>'history') IS DISTINCT FROM(NEW.catalog_id::text,NEW.window_revision::text,NEW.history_assertion_id::text) OR source->>'history' IS NULL THEN RAISE EXCEPTION 'Score event needs current source, history and exact predecessor' USING ERRCODE='23514',CONSTRAINT='window_score_causal';END IF;
 RETURN NEW;
END$$;
CREATE TRIGGER window_event_guard BEFORE INSERT ON whaleu_ratings.window_score_events FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.window_event_guard();
CREATE FUNCTION whaleu_ratings.window_head_guard() RETURNS trigger LANGUAGE plpgsql AS $$DECLARE e whaleu_ratings.window_score_events;previous uuid;BEGIN
 SELECT * INTO e FROM whaleu_ratings.window_score_events WHERE id=NEW.revision AND actor_id=NEW.actor_id AND window_id=NEW.window_id;
 IF e.id IS NULL THEN RAISE EXCEPTION 'Head requires exact score event' USING ERRCODE='23514',CONSTRAINT='window_score_causal';END IF;
 PERFORM whaleu_ratings.window_lock(e.actor_id,e.request_id,e.window_id);
 IF TG_OP='UPDATE' THEN previous:=OLD.revision;IF (NEW.window_id,NEW.actor_id) IS DISTINCT FROM(OLD.window_id,OLD.actor_id) THEN RAISE EXCEPTION 'Score ownership is immutable' USING ERRCODE='23514',CONSTRAINT='window_score_causal';END IF;END IF;
 IF e.transaction_id<>pg_current_xact_id() OR e.previous_revision IS DISTINCT FROM previous THEN RAISE EXCEPTION 'Head transition requires new atomic event and current predecessor' USING ERRCODE='23514',CONSTRAINT='window_score_causal';END IF;
 RETURN NEW;
END$$;
CREATE TRIGGER window_head_guard BEFORE INSERT OR UPDATE ON whaleu_ratings.window_score_heads FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.window_head_guard();
-- Strict causal validation linearizes at SQL statement/deferred execution.
-- This is not an arbitrary raw COMMIT wall-clock hook after early constraint
-- flushing; managed API transactions retain exact post-all-waits owner proofs.
CREATE FUNCTION whaleu_ratings.window_complete(actor uuid,rid uuid) RETURNS void LANGUAGE plpgsql VOLATILE AS $$
DECLARE q whaleu_ratings.window_commands;e whaleu_ratings.window_score_events;own whaleu_ratings.window_score_events;source jsonb;instant timestamptz;expected uuid;BEGIN
 PERFORM whaleu_ratings.window_fence();instant:=clock_timestamp();
 SELECT * INTO q FROM whaleu_ratings.window_commands WHERE actor_id=actor AND request_id=rid;
 IF q.request_id IS NULL OR q.transaction_id<>pg_current_xact_id() OR NOT whaleu_identity.window_rating_session(actor,q.session_id,instant) THEN RAISE EXCEPTION 'Current exact window request required' USING ERRCODE='23514',CONSTRAINT='window_score_causal';END IF;
 IF NOT whaleu_community.rating_scoped_keys(q.command,ARRAY['clientRequestId','expectedCatalogRevision','expectedWindowRevision','expectedOwnScoreRevision','score']) OR NOT whaleu_community.rating_scoped_ids(q.command,ARRAY['clientRequestId','expectedCatalogRevision','expectedWindowRevision']) OR (q.command->'expectedOwnScoreRevision'<>'null'::jsonb AND NOT whaleu_community.rating_scoped_ids(q.command,ARRAY['expectedOwnScoreRevision'])) OR jsonb_typeof(q.command->'score') IS DISTINCT FROM 'number' OR NOT ((q.command->>'score')::numeric BETWEEN -10 AND 10 AND mod((q.command->>'score')::numeric,1)=0) THEN RAISE EXCEPTION 'Strict signed integer score intent required' USING ERRCODE='23514',CONSTRAINT='window_score_causal';END IF;
 expected:=(q.command->>'expectedOwnScoreRevision')::uuid;
 SELECT * INTO e FROM whaleu_ratings.window_score_events WHERE actor_id=actor AND request_id=rid;
 SELECT events.* INTO own FROM whaleu_ratings.window_score_heads h JOIN whaleu_ratings.window_score_events events ON events.id=h.revision WHERE h.window_id=q.window_id AND h.actor_id=actor;
 IF q.receipt->>'outcome'='rejected' THEN
  IF NOT whaleu_community.rating_scoped_keys(q.receipt,ARRAY['requestId','operation','windowId','outcome','code']) OR e.id IS NOT NULL THEN RAISE EXCEPTION 'Rejection cannot create score event' USING ERRCODE='23514',CONSTRAINT='window_score_causal';END IF;
  IF q.receipt->>'code'='WINDOW_SCORE_CANCELLED' THEN RETURN;END IF;
 END IF;
 IF NOT whaleu_ratings.window_access(actor,q.session_id,instant) THEN RAISE EXCEPTION 'Current phone and Safety required' USING ERRCODE='23514',CONSTRAINT='window_score_causal';END IF;
 source:=whaleu_ratings.window_source(q.window_id,instant);
 IF source IS NULL OR source->>'history' IS NULL THEN RAISE EXCEPTION 'Current source and separate history required' USING ERRCODE='23514',CONSTRAINT='window_score_causal';END IF;
 IF q.receipt->>'outcome'='rejected' AND q.receipt->>'code'='WINDOW_REVISION_CONFLICT' THEN
  IF (source->>'catalog',source->>'revision') IS NOT DISTINCT FROM(q.command->>'expectedCatalogRevision',q.command->>'expectedWindowRevision') THEN RAISE EXCEPTION 'Source conflict must be causal' USING ERRCODE='23514',CONSTRAINT='window_score_causal';END IF;RETURN;
 END IF;
 IF (source->>'catalog',source->>'revision') IS DISTINCT FROM(q.command->>'expectedCatalogRevision',q.command->>'expectedWindowRevision') THEN RAISE EXCEPTION 'Exact current catalog/window required' USING ERRCODE='23514',CONSTRAINT='window_score_causal';END IF;
 IF q.receipt->>'outcome'='rejected' AND q.receipt->>'code'='WINDOW_SCORE_REVISION_CONFLICT' THEN
  IF own.id IS NOT DISTINCT FROM expected THEN RAISE EXCEPTION 'Own score conflict must be causal' USING ERRCODE='23514',CONSTRAINT='window_score_causal';END IF;RETURN;
 END IF;
 IF NOT whaleu_community.rating_scoped_keys(q.receipt,ARRAY['requestId','operation','windowId','outcome','score','scoreRevision','recordedAt']) OR NOT whaleu_community.rating_scoped_ids(q.receipt,ARRAY['scoreRevision']) OR q.receipt->'score' IS DISTINCT FROM q.command->'score' OR own.id IS NULL OR q.receipt->>'scoreRevision' IS DISTINCT FROM own.id::text OR jsonb_typeof(q.receipt->'recordedAt') IS DISTINCT FROM 'string' OR q.receipt->>'recordedAt' IS DISTINCT FROM to_char(own.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') THEN RAISE EXCEPTION 'Exact signed score receipt required' USING ERRCODE='23514',CONSTRAINT='window_score_causal';END IF;
 IF q.receipt->>'outcome'='noop' THEN
  IF e.id IS NOT NULL OR own.id IS DISTINCT FROM expected OR own.score<>(q.command->>'score')::numeric THEN RAISE EXCEPTION 'Noop still requires exact current own revision' USING ERRCODE='23514',CONSTRAINT='window_score_causal';END IF;RETURN;
 END IF;
 IF q.receipt->>'outcome' IS DISTINCT FROM 'applied' OR e.id IS NULL OR e.id<>own.id OR e.window_id<>q.window_id OR e.transaction_id<>pg_current_xact_id() OR e.previous_revision IS DISTINCT FROM expected OR (e.catalog_id::text,e.window_revision::text,e.history_assertion_id::text) IS DISTINCT FROM(source->>'catalog',source->>'revision',source->>'history') OR e.score<>(q.command->>'score')::numeric OR (e.previous_revision IS NOT NULL AND EXISTS(SELECT 1 FROM whaleu_ratings.window_score_events WHERE id=e.previous_revision AND score=e.score)) THEN RAISE EXCEPTION 'Applied receipt requires atomic exact changing event/head' USING ERRCODE='23514',CONSTRAINT='window_score_causal';END IF;
END$$;
CREATE FUNCTION whaleu_ratings.window_final() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN PERFORM whaleu_ratings.window_complete(NEW.actor_id,NEW.request_id);RETURN NULL;END$$;
DO $$DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['window_commands','window_score_events'] LOOP
 EXECUTE format('CREATE CONSTRAINT TRIGGER window_final AFTER INSERT ON whaleu_ratings.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.window_final()',t);END LOOP;END$$;
CREATE FUNCTION whaleu_ratings.window_head_final() RETURNS trigger LANGUAGE plpgsql AS $$DECLARE e whaleu_ratings.window_score_events;BEGIN SELECT * INTO e FROM whaleu_ratings.window_score_events WHERE id=NEW.revision;PERFORM whaleu_ratings.window_complete(e.actor_id,e.request_id);RETURN NULL;END$$;
CREATE CONSTRAINT TRIGGER window_head_final AFTER INSERT OR UPDATE ON whaleu_ratings.window_score_heads DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.window_head_final();
CREATE FUNCTION whaleu_ratings.window_statement_final() RETURNS trigger LANGUAGE plpgsql AS $$DECLARE q record;BEGIN FOR q IN SELECT actor_id,request_id FROM inserted LOOP PERFORM whaleu_ratings.window_complete(q.actor_id,q.request_id);END LOOP;RETURN NULL;END$$;
CREATE TRIGGER window_statement_final AFTER INSERT ON whaleu_ratings.window_commands REFERENCING NEW TABLE AS inserted FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.window_statement_final();
