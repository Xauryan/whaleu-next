-- Independent canteen-floor scalar scores. Reuses accepted W1 raw floor identity,
-- never requires child windows, never imports or invents production history.
SET LOCAL lock_timeout='5s';
-- New Next codec: JSON finite binary64 numbers in [1,5]. Keep the shortest
-- round-trip decimal exactly in numeric; no integer/half-step quantization.
-- Raw SQL decimals that cannot round-trip through this codec are rejected.
CREATE FUNCTION whaleu_ratings.floor_scalar(n numeric) RETURNS boolean LANGUAGE sql IMMUTABLE STRICT SET extra_float_digits=3 AS $$
 SELECT n BETWEEN 1 AND 5 AND n=((n::double precision)::text)::numeric
$$;
CREATE FUNCTION whaleu_ratings.floor_canonical_command(q jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT CASE WHEN jsonb_typeof(q->'score')='number' THEN jsonb_set(q,'{score}',to_jsonb(trim_scale((q->>'score')::numeric))) ELSE q END
$$;
CREATE TABLE whaleu_ratings.floor_history_assertions(
 id uuid PRIMARY KEY,floor_id uuid NOT NULL REFERENCES whaleu_ratings.window_floor_identities(id),coverage text NOT NULL CHECK(coverage IN('accepted_empty','unknown')),
 source_reference text NOT NULL CHECK(length(btrim(source_reference)) BETWEEN 1 AND 2000),policy_reference text NOT NULL CHECK(length(btrim(policy_reference)) BETWEEN 1 AND 2000),
 accepted_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(accepted_at)),valid_until timestamptz NOT NULL CHECK(isfinite(valid_until) AND valid_until>accepted_at),UNIQUE(id,floor_id)
);
CREATE TABLE whaleu_ratings.floor_history_heads(floor_id uuid PRIMARY KEY,assertion_id uuid NOT NULL,FOREIGN KEY(assertion_id,floor_id) REFERENCES whaleu_ratings.floor_history_assertions(id,floor_id));
CREATE TABLE whaleu_ratings.floor_score_epoch(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),revision bigint NOT NULL DEFAULT 1 CHECK(revision>0));
INSERT INTO whaleu_ratings.floor_score_epoch(singleton) VALUES(true);
CREATE TABLE whaleu_ratings.floor_commands(
 actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),request_id uuid NOT NULL,session_id uuid NOT NULL REFERENCES whaleu_identity.sessions(id),floor_id uuid NOT NULL REFERENCES whaleu_ratings.window_floor_identities(id),
 command jsonb NOT NULL CHECK(jsonb_typeof(command)='object' AND octet_length(command::text)<=2048),intent_hash text NOT NULL CHECK(intent_hash ~ '^[a-f0-9]{64}$'),
 receipt jsonb NOT NULL CHECK(jsonb_typeof(receipt)='object' AND octet_length(receipt::text)<=2048),transaction_id xid8 NOT NULL DEFAULT pg_current_xact_id(),PRIMARY KEY(actor_id,request_id),
 CHECK(intent_hash=encode(sha256(convert_to('whaleu:floor-score-first:v1'||chr(10)||whaleu_community.content_canonical_json(jsonb_build_object('actorId',actor_id::text,'floorId',floor_id::text,'command',whaleu_ratings.floor_canonical_command(command))),'UTF8')),'hex')),
 CHECK((command->>'clientRequestId') IS NOT DISTINCT FROM request_id::text),
 CHECK((receipt->>'requestId') IS NOT DISTINCT FROM request_id::text AND (receipt->>'floorId') IS NOT DISTINCT FROM floor_id::text AND (receipt->>'operation') IS NOT DISTINCT FROM 'floor.score.first.v1')
);
CREATE TABLE whaleu_ratings.floor_score_events(
 id uuid PRIMARY KEY,floor_id uuid NOT NULL REFERENCES whaleu_ratings.window_floor_identities(id),actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),request_id uuid NOT NULL,
 catalog_id uuid NOT NULL,canteen_revision uuid NOT NULL,history_assertion_id uuid NOT NULL,score numeric NOT NULL CHECK(whaleu_ratings.floor_scalar(score)),
 recorded_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds',transaction_timestamp()),transaction_id xid8 NOT NULL DEFAULT pg_current_xact_id(),
 UNIQUE(floor_id,actor_id,id),UNIQUE(actor_id,request_id),UNIQUE(floor_id,actor_id,transaction_id),
 FOREIGN KEY(catalog_id,floor_id) REFERENCES whaleu_ratings.window_floor_entries(catalog_id,floor_id),
 FOREIGN KEY(history_assertion_id,floor_id) REFERENCES whaleu_ratings.floor_history_assertions(id,floor_id),
 FOREIGN KEY(actor_id,request_id) REFERENCES whaleu_ratings.floor_commands(actor_id,request_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE whaleu_ratings.floor_score_heads(floor_id uuid NOT NULL,actor_id uuid NOT NULL,revision uuid NOT NULL,PRIMARY KEY(floor_id,actor_id),FOREIGN KEY(floor_id,actor_id,revision) REFERENCES whaleu_ratings.floor_score_events(floor_id,actor_id,id));

CREATE FUNCTION whaleu_ratings.floor_immutable() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'Floor source assertions and published score history are immutable' USING ERRCODE='23514',CONSTRAINT='floor_score_causal';END$$;
DO $$DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['floor_history_assertions','floor_commands','floor_score_events','floor_score_heads'] LOOP
 EXECUTE format('CREATE TRIGGER floor_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON whaleu_ratings.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.floor_immutable()',t);END LOOP;END$$;
-- No lifetime actor/floor uniqueness on the ledger. Only this active head is
-- unique. Native retirement/import is intentionally unavailable in this slice.
CREATE FUNCTION whaleu_ratings.floor_epoch_advance() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN UPDATE whaleu_ratings.floor_score_epoch SET revision=revision+1 WHERE singleton;RETURN NULL;END$$;
DO $$DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['floor_history_assertions','floor_history_heads','floor_score_heads'] LOOP
 EXECUTE format('CREATE TRIGGER floor_epoch AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_ratings.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.floor_epoch_advance()',t);END LOOP;END$$;
CREATE FUNCTION whaleu_ratings.floor_history(fid uuid,instant timestamptz) RETURNS uuid LANGUAGE sql STABLE AS $$
 SELECT a.id FROM whaleu_ratings.floor_history_heads h JOIN whaleu_ratings.floor_history_assertions a ON a.id=h.assertion_id AND a.floor_id=h.floor_id WHERE h.floor_id=fid AND a.coverage='accepted_empty' AND a.accepted_at<=instant AND a.valid_until>instant
$$;
CREATE FUNCTION whaleu_ratings.floor_source(fid uuid,instant timestamptz) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object('catalog',f.catalog_id,'revision',c.revision,'history',whaleu_ratings.floor_history(fid,instant)) FROM whaleu_ratings.window_floor_entries f JOIN whaleu_ratings.canteen_entries c ON c.catalog_id=f.catalog_id AND c.canteen_id=f.canteen_id WHERE f.floor_id=fid AND f.catalog_id=(whaleu_ratings.window_catalog_source(instant)->>'catalog')::uuid AND c.is_active AND f.is_active
$$;
CREATE FUNCTION whaleu_ratings.floor_fence() RETURNS void LANGUAGE plpgsql VOLATILE AS $$BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Floor scores require read committed' USING ERRCODE='23514',CONSTRAINT='floor_score_causal';END IF;
 LOCK TABLE whaleu_ratings.window_catalog_head,whaleu_ratings.window_catalogs,whaleu_ratings.window_catalog_acceptances,whaleu_ratings.canteen_identities,whaleu_ratings.window_floor_identities,whaleu_ratings.canteen_entries,whaleu_ratings.window_floor_entries,whaleu_ratings.floor_history_assertions,whaleu_ratings.floor_history_heads,whaleu_ratings.floor_score_events,whaleu_ratings.floor_score_heads,whaleu_ratings.floor_commands,whaleu_ratings.floor_score_epoch,whaleu_identity.accounts,whaleu_identity.sessions,whaleu_verification.account_heads,whaleu_verification.snapshots,whaleu_verification.assertions,whaleu_safety.account_heads,whaleu_campus.campuses,whaleu_campus.institutions,whaleu_campus.campus_region_assignments,whaleu_campus.operating_regions IN SHARE MODE NOWAIT;
 IF NOT EXISTS(SELECT 1 FROM whaleu_ratings.floor_score_epoch WHERE singleton) THEN RAISE EXCEPTION 'Floor score epoch unavailable' USING ERRCODE='23514',CONSTRAINT='floor_score_causal';END IF;
END$$;
CREATE FUNCTION whaleu_ratings.floor_lock(actor uuid,rid uuid,fid uuid) RETURNS void LANGUAGE plpgsql VOLATILE AS $$BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Floor writers require read committed' USING ERRCODE='23514',CONSTRAINT='floor_score_causal';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('whaleu:floor-request:v1:'||actor::text||':'||rid::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('whaleu:floor-own-score:v1:'||actor::text||':'||fid::text,0));
END$$;
CREATE FUNCTION whaleu_ratings.floor_write_lock() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 PERFORM whaleu_ratings.floor_lock(NEW.actor_id,NEW.request_id,NEW.floor_id);
 NEW.command:=whaleu_ratings.floor_canonical_command(NEW.command);
 NEW.receipt:=whaleu_ratings.floor_canonical_command(NEW.receipt);RETURN NEW;
END$$;
CREATE TRIGGER floor_command_lock BEFORE INSERT ON whaleu_ratings.floor_commands FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.floor_write_lock();
CREATE FUNCTION whaleu_ratings.floor_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$DECLARE source jsonb;BEGIN
 NEW.score:=trim_scale(NEW.score);
 PERFORM whaleu_ratings.floor_lock(NEW.actor_id,NEW.request_id,NEW.floor_id);
 source:=whaleu_ratings.floor_source(NEW.floor_id,clock_timestamp());
 IF EXISTS(SELECT 1 FROM whaleu_ratings.floor_score_heads WHERE floor_id=NEW.floor_id AND actor_id=NEW.actor_id) OR NEW.transaction_id<>pg_current_xact_id() OR NEW.recorded_at<>date_trunc('milliseconds',transaction_timestamp()) OR (source->>'catalog',source->>'revision',source->>'history') IS DISTINCT FROM(NEW.catalog_id::text,NEW.canteen_revision::text,NEW.history_assertion_id::text) OR source->>'history' IS NULL THEN RAISE EXCEPTION 'Floor publication needs no active head and exact current source/history' USING ERRCODE='23514',CONSTRAINT='floor_score_causal';END IF;
 RETURN NEW;
END$$;
CREATE TRIGGER floor_event_guard BEFORE INSERT ON whaleu_ratings.floor_score_events FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.floor_event_guard();
CREATE FUNCTION whaleu_ratings.floor_head_guard() RETURNS trigger LANGUAGE plpgsql AS $$DECLARE e whaleu_ratings.floor_score_events;BEGIN
 SELECT * INTO e FROM whaleu_ratings.floor_score_events WHERE id=NEW.revision AND actor_id=NEW.actor_id AND floor_id=NEW.floor_id;
 IF e.id IS NULL OR e.transaction_id<>pg_current_xact_id() THEN RAISE EXCEPTION 'Floor active head requires its new atomic publication' USING ERRCODE='23514',CONSTRAINT='floor_score_causal';END IF;
 PERFORM whaleu_ratings.floor_lock(e.actor_id,e.request_id,e.floor_id);RETURN NEW;
END$$;
CREATE TRIGGER floor_head_guard BEFORE INSERT ON whaleu_ratings.floor_score_heads FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.floor_head_guard();
-- SQL guards linearize at execution, not at arbitrary raw COMMIT after early
-- constraint flushing. Managed API adds exact final proof after all waits.
CREATE FUNCTION whaleu_ratings.floor_complete(actor uuid,rid uuid) RETURNS void LANGUAGE plpgsql VOLATILE AS $$
DECLARE q whaleu_ratings.floor_commands;e whaleu_ratings.floor_score_events;own whaleu_ratings.floor_score_events;source jsonb;instant timestamptz;BEGIN
 PERFORM whaleu_ratings.floor_fence();instant:=clock_timestamp();
 SELECT * INTO q FROM whaleu_ratings.floor_commands WHERE actor_id=actor AND request_id=rid;
 IF q.request_id IS NULL OR q.transaction_id<>pg_current_xact_id() OR NOT whaleu_identity.window_rating_session(actor,q.session_id,instant) THEN RAISE EXCEPTION 'Current exact floor request required' USING ERRCODE='23514',CONSTRAINT='floor_score_causal';END IF;
 IF NOT whaleu_community.rating_scoped_keys(q.command,ARRAY['clientRequestId','expectedCatalogRevision','expectedCanteenRevision','score']) OR NOT whaleu_community.rating_scoped_ids(q.command,ARRAY['clientRequestId','expectedCatalogRevision','expectedCanteenRevision']) OR jsonb_typeof(q.command->'score') IS DISTINCT FROM 'number' OR NOT whaleu_ratings.floor_scalar((q.command->>'score')::numeric) THEN RAISE EXCEPTION 'Strict floor binary64 scalar intent required' USING ERRCODE='23514',CONSTRAINT='floor_score_causal';END IF;
 SELECT * INTO e FROM whaleu_ratings.floor_score_events WHERE actor_id=actor AND request_id=rid;
 SELECT events.* INTO own FROM whaleu_ratings.floor_score_heads h JOIN whaleu_ratings.floor_score_events events ON events.id=h.revision WHERE h.floor_id=q.floor_id AND h.actor_id=actor;
 IF q.receipt->>'outcome'='rejected' THEN
  IF NOT whaleu_community.rating_scoped_keys(q.receipt,ARRAY['requestId','operation','floorId','outcome','code']) OR e.id IS NOT NULL THEN RAISE EXCEPTION 'Floor rejection cannot create event' USING ERRCODE='23514',CONSTRAINT='floor_score_causal';END IF;
  IF q.receipt->>'code'='FLOOR_SCORE_CANCELLED' THEN RETURN;END IF;
 END IF;
 IF NOT whaleu_ratings.window_access(actor,q.session_id,instant) THEN RAISE EXCEPTION 'Current phone and Safety required' USING ERRCODE='23514',CONSTRAINT='floor_score_causal';END IF;
 source:=whaleu_ratings.floor_source(q.floor_id,instant);
 IF source IS NULL OR source->>'history' IS NULL THEN RAISE EXCEPTION 'Current floor source and separate history required' USING ERRCODE='23514',CONSTRAINT='floor_score_causal';END IF;
 IF q.receipt->>'outcome'='rejected' AND q.receipt->>'code'='FLOOR_REVISION_CONFLICT' THEN
  IF (source->>'catalog',source->>'revision') IS NOT DISTINCT FROM(q.command->>'expectedCatalogRevision',q.command->>'expectedCanteenRevision') THEN RAISE EXCEPTION 'Floor source conflict must be causal' USING ERRCODE='23514',CONSTRAINT='floor_score_causal';END IF;RETURN;
 END IF;
 IF (source->>'catalog',source->>'revision') IS DISTINCT FROM(q.command->>'expectedCatalogRevision',q.command->>'expectedCanteenRevision') THEN RAISE EXCEPTION 'Exact current catalog/canteen required' USING ERRCODE='23514',CONSTRAINT='floor_score_causal';END IF;
 IF q.receipt->>'outcome'='rejected' AND q.receipt->>'code'='FLOOR_ALREADY_RATED' THEN
  IF own.id IS NULL OR own.transaction_id=pg_current_xact_id() THEN RAISE EXCEPTION 'Already-rated requires prior active publication' USING ERRCODE='23514',CONSTRAINT='floor_score_causal';END IF;RETURN;
 END IF;
 IF q.receipt->>'outcome' IS DISTINCT FROM 'applied' OR NOT whaleu_community.rating_scoped_keys(q.receipt,ARRAY['requestId','operation','floorId','outcome','score','scoreRevision','recordedAt']) OR NOT whaleu_community.rating_scoped_ids(q.receipt,ARRAY['scoreRevision']) OR q.receipt->'score' IS DISTINCT FROM q.command->'score' OR e.id IS NULL OR own.id IS NULL OR e.id<>own.id OR q.receipt->>'scoreRevision' IS DISTINCT FROM e.id::text OR jsonb_typeof(q.receipt->'recordedAt') IS DISTINCT FROM 'string' OR q.receipt->>'recordedAt' IS DISTINCT FROM to_char(e.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') OR e.floor_id<>q.floor_id OR e.transaction_id<>pg_current_xact_id() OR (e.catalog_id::text,e.canteen_revision::text,e.history_assertion_id::text) IS DISTINCT FROM(source->>'catalog',source->>'revision',source->>'history') OR e.score<>(q.command->>'score')::numeric THEN RAISE EXCEPTION 'Applied floor receipt requires atomic exact event/head' USING ERRCODE='23514',CONSTRAINT='floor_score_causal';END IF;
END$$;
CREATE FUNCTION whaleu_ratings.floor_final() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN PERFORM whaleu_ratings.floor_complete(NEW.actor_id,NEW.request_id);RETURN NULL;END$$;
DO $$DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['floor_commands','floor_score_events'] LOOP
 EXECUTE format('CREATE CONSTRAINT TRIGGER floor_final AFTER INSERT ON whaleu_ratings.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.floor_final()',t);END LOOP;END$$;
CREATE FUNCTION whaleu_ratings.floor_head_final() RETURNS trigger LANGUAGE plpgsql AS $$DECLARE e whaleu_ratings.floor_score_events;BEGIN SELECT * INTO e FROM whaleu_ratings.floor_score_events WHERE id=NEW.revision;PERFORM whaleu_ratings.floor_complete(e.actor_id,e.request_id);RETURN NULL;END$$;
CREATE CONSTRAINT TRIGGER floor_head_final AFTER INSERT ON whaleu_ratings.floor_score_heads DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.floor_head_final();
CREATE FUNCTION whaleu_ratings.floor_statement_final() RETURNS trigger LANGUAGE plpgsql AS $$DECLARE q record;BEGIN FOR q IN SELECT actor_id,request_id FROM inserted LOOP PERFORM whaleu_ratings.floor_complete(q.actor_id,q.request_id);END LOOP;RETURN NULL;END$$;
CREATE TRIGGER floor_statement_final AFTER INSERT ON whaleu_ratings.floor_commands REFERENCING NEW TABLE AS inserted FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.floor_statement_final();
