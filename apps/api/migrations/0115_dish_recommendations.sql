-- W2: reversible exact-native dish memberships. No production source/history/Review seeds.
SET LOCAL lock_timeout='5s';
-- Intentional Next contract: code points, well-formed PostgreSQL UTF8, nonblank,
-- no C0/C1 controls. Preserve accepted bytes; identity/order is bytea, never locale.
CREATE FUNCTION whaleu_ratings.dish_name_valid(value text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT coalesce(char_length(value) BETWEEN 1 AND 10 AND octet_length(value)<=40 AND
 length(btrim(value,U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'))>0
 AND NOT EXISTS(SELECT 1 FROM generate_series(1,char_length(value)) n WHERE ascii(substr(value,n,1)) BETWEEN 0 AND 31 OR ascii(substr(value,n,1)) BETWEEN 127 AND 159),false)
$$;
CREATE TABLE whaleu_ratings.dish_history_assertions(
 id uuid PRIMARY KEY,window_id uuid NOT NULL REFERENCES whaleu_ratings.window_identities(id),kind text NOT NULL CHECK(kind IN('population','membership')),
 coverage text NOT NULL CHECK(coverage IN('accepted_empty','unknown')),source_reference text NOT NULL CHECK(length(btrim(source_reference)) BETWEEN 1 AND 2000),policy_reference text NOT NULL CHECK(length(btrim(policy_reference)) BETWEEN 1 AND 2000),
 accepted_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(accepted_at)),valid_until timestamptz NOT NULL CHECK(isfinite(valid_until) AND valid_until>accepted_at),UNIQUE(id,window_id,kind)
);
CREATE TABLE whaleu_ratings.dish_history_heads(window_id uuid NOT NULL,kind text NOT NULL,assertion_id uuid NOT NULL,PRIMARY KEY(window_id,kind),FOREIGN KEY(assertion_id,window_id,kind) REFERENCES whaleu_ratings.dish_history_assertions(id,window_id,kind));
CREATE TABLE whaleu_ratings.dish_epoch(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),revision bigint NOT NULL DEFAULT 1 CHECK(revision>0));
INSERT INTO whaleu_ratings.dish_epoch(singleton) VALUES(true);
CREATE TABLE whaleu_community.dish_review_policies(
 id uuid PRIMARY KEY,issuer text NOT NULL CHECK(length(btrim(issuer)) BETWEEN 1 AND 200),
 source_reference text NOT NULL CHECK(length(btrim(source_reference)) BETWEEN 1 AND 2000),
 coverage text NOT NULL CHECK(coverage IN('complete','unknown')),
 valid_from timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(valid_from)),
 valid_until timestamptz NOT NULL CHECK(isfinite(valid_until) AND valid_until>valid_from)
);
CREATE TABLE whaleu_community.dish_review_decisions(
 id uuid PRIMARY KEY,actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),request_id uuid NOT NULL,
 window_id uuid NOT NULL REFERENCES whaleu_ratings.window_identities(id),catalog_id uuid NOT NULL,window_revision uuid NOT NULL,
 purpose text NOT NULL DEFAULT 'window.dish.recommend.v1' CHECK(purpose='window.dish.recommend.v1'),
 dish_name text NOT NULL CHECK(whaleu_ratings.dish_name_valid(dish_name)),
 policy_id uuid NOT NULL REFERENCES whaleu_community.dish_review_policies(id),
 verdict text NOT NULL CHECK(verdict IN('allow','reject')),digest text NOT NULL,
 issued_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(issued_at)),
 consume_until timestamptz NOT NULL CHECK(isfinite(consume_until) AND consume_until>issued_at),
 visibility_until timestamptz NOT NULL CHECK(isfinite(visibility_until) AND visibility_until>issued_at),
 FOREIGN KEY(catalog_id,window_id,window_revision) REFERENCES whaleu_ratings.window_entries(catalog_id,window_id,revision),
 UNIQUE(id,actor_id,request_id),
 CHECK(digest=encode(sha256(convert_to('whaleu:window-dish-review:v1'||chr(10)||whaleu_community.content_canonical_json(jsonb_build_object('version',1,'purpose',purpose,'actorId',actor_id::text,'requestId',request_id::text,'windowId',window_id::text,'catalogRevision',catalog_id::text,'windowRevision',window_revision::text,'dishName',dish_name,'dishIdentity',encode(convert_to(dish_name,'UTF8'),'hex'))),'UTF8')),'hex'))
);
CREATE TABLE whaleu_community.dish_review_heads(
 actor_id uuid NOT NULL,request_id uuid NOT NULL,decision_id uuid NOT NULL,state text NOT NULL CHECK(state IN('active','revoked')),
 PRIMARY KEY(actor_id,request_id),FOREIGN KEY(decision_id,actor_id,request_id) REFERENCES whaleu_community.dish_review_decisions(id,actor_id,request_id)
);
CREATE TABLE whaleu_community.dish_review_epoch(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),revision bigint NOT NULL DEFAULT 1 CHECK(revision>0));
INSERT INTO whaleu_community.dish_review_epoch(singleton) VALUES(true);

CREATE TABLE whaleu_ratings.dish_commands(
 actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),request_id uuid NOT NULL,session_id uuid NOT NULL REFERENCES whaleu_identity.sessions(id),window_id uuid NOT NULL REFERENCES whaleu_ratings.window_identities(id),
 operation text NOT NULL CHECK(operation IN('window.dish.recommend.v1','window.dish.retract.v1')),
 command jsonb NOT NULL CHECK(jsonb_typeof(command)='object' AND octet_length(command::text)<=2048),intent_hash text NOT NULL CHECK(intent_hash~'^[a-f0-9]{64}$'),receipt jsonb NOT NULL CHECK(jsonb_typeof(receipt)='object' AND octet_length(receipt::text)<=2048),transaction_id xid8 NOT NULL DEFAULT pg_current_xact_id(),PRIMARY KEY(actor_id,request_id),
 CHECK(intent_hash=encode(sha256(convert_to('whaleu:window-dish-command:v1'||chr(10)||whaleu_community.content_canonical_json(jsonb_build_object('actorId',actor_id::text,'windowId',window_id::text,'operation',operation,'command',command)),'UTF8')),'hex')),
 CHECK((command->>'clientRequestId') IS NOT DISTINCT FROM request_id::text),
 CHECK((receipt->>'requestId') IS NOT DISTINCT FROM request_id::text AND (receipt->>'windowId') IS NOT DISTINCT FROM window_id::text AND (receipt->>'operation') IS NOT DISTINCT FROM operation)
);
CREATE FUNCTION whaleu_ratings.dish_bytes(value text) RETURNS bytea LANGUAGE sql IMMUTABLE STRICT AS $$SELECT convert_to(value,'UTF8')$$;
CREATE TABLE whaleu_ratings.dish_events(
 id uuid PRIMARY KEY,window_id uuid NOT NULL REFERENCES whaleu_ratings.window_identities(id),actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),request_id uuid NOT NULL,
 dish_name text NOT NULL CHECK(whaleu_ratings.dish_name_valid(dish_name)),name_bytes bytea GENERATED ALWAYS AS(whaleu_ratings.dish_bytes(dish_name)) STORED,
 previous_revision uuid,active boolean NOT NULL,catalog_id uuid,window_revision uuid,population_assertion_id uuid,membership_assertion_id uuid,review_decision_id uuid REFERENCES whaleu_community.dish_review_decisions(id),
 recorded_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds',transaction_timestamp()),transaction_id xid8 NOT NULL DEFAULT pg_current_xact_id(),
 UNIQUE(window_id,actor_id,name_bytes,id),UNIQUE(actor_id,request_id),UNIQUE(window_id,actor_id,name_bytes,transaction_id),
 FOREIGN KEY(window_id,actor_id,name_bytes,previous_revision) REFERENCES whaleu_ratings.dish_events(window_id,actor_id,name_bytes,id),
 FOREIGN KEY(catalog_id,window_id,window_revision) REFERENCES whaleu_ratings.window_entries(catalog_id,window_id,revision),
 FOREIGN KEY(population_assertion_id) REFERENCES whaleu_ratings.dish_history_assertions(id),FOREIGN KEY(membership_assertion_id) REFERENCES whaleu_ratings.dish_history_assertions(id),
 FOREIGN KEY(actor_id,request_id) REFERENCES whaleu_ratings.dish_commands(actor_id,request_id) DEFERRABLE INITIALLY DEFERRED,
 CHECK((active AND catalog_id IS NOT NULL AND window_revision IS NOT NULL AND population_assertion_id IS NOT NULL AND membership_assertion_id IS NOT NULL AND review_decision_id IS NOT NULL) OR (NOT active AND previous_revision IS NOT NULL AND catalog_id IS NULL AND window_revision IS NULL AND population_assertion_id IS NULL AND membership_assertion_id IS NULL AND review_decision_id IS NULL))
);
CREATE TABLE whaleu_ratings.dish_heads(window_id uuid NOT NULL,actor_id uuid NOT NULL,name_bytes bytea NOT NULL,revision uuid NOT NULL,PRIMARY KEY(window_id,actor_id,name_bytes),FOREIGN KEY(window_id,actor_id,name_bytes,revision) REFERENCES whaleu_ratings.dish_events(window_id,actor_id,name_bytes,id));
CREATE INDEX dish_events_window ON whaleu_ratings.dish_events(window_id,id);
CREATE FUNCTION whaleu_ratings.dish_immutable() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'Dish accepted evidence and membership lineage is immutable' USING ERRCODE='23514',CONSTRAINT='dish_causal';END$$;
CREATE FUNCTION whaleu_ratings.dish_epoch_advance() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN UPDATE whaleu_ratings.dish_epoch SET revision=revision+1 WHERE singleton;RETURN NULL;END$$;
CREATE FUNCTION whaleu_community.dish_review_epoch_advance() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN UPDATE whaleu_community.dish_review_epoch SET revision=revision+1 WHERE singleton;RETURN NULL;END$$;
DO $$DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['dish_history_assertions','dish_history_heads','dish_heads'] LOOP EXECUTE format('CREATE TRIGGER dish_epoch AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_ratings.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.dish_epoch_advance()',t);END LOOP;
 FOREACH t IN ARRAY ARRAY['dish_history_assertions','dish_commands','dish_events'] LOOP EXECUTE format('CREATE TRIGGER dish_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON whaleu_ratings.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.dish_immutable()',t);END LOOP;
 FOREACH t IN ARRAY ARRAY['dish_review_policies','dish_review_decisions','dish_review_heads'] LOOP EXECUTE format('CREATE TRIGGER dish_review_epoch AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_community.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.dish_review_epoch_advance()',t);END LOOP;
 FOREACH t IN ARRAY ARRAY['dish_review_policies','dish_review_decisions'] LOOP EXECUTE format('CREATE TRIGGER dish_review_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON whaleu_community.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.dish_immutable()',t);END LOOP;
END$$;
CREATE TRIGGER dish_head_no_delete BEFORE DELETE OR TRUNCATE ON whaleu_ratings.dish_heads FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.dish_immutable();
CREATE FUNCTION whaleu_community.dish_review_status(did uuid,consume boolean,instant timestamptz) RETURNS text LANGUAGE sql STABLE AS $$
 SELECT coalesce((SELECT CASE WHEN h.state='revoked' THEN 'deny' WHEN p.coverage<>'complete' OR p.valid_from>d.issued_at OR d.issued_at>instant OR p.valid_until<=instant OR d.visibility_until<=instant OR (consume AND d.consume_until<=instant) THEN 'unavailable' ELSE d.verdict END FROM whaleu_community.dish_review_decisions d JOIN whaleu_community.dish_review_policies p ON p.id=d.policy_id JOIN whaleu_community.dish_review_heads h ON h.decision_id=d.id AND h.actor_id=d.actor_id AND h.request_id=d.request_id WHERE d.id=did),'unavailable')
$$;
CREATE FUNCTION whaleu_safety.dish_contribution_status(actor uuid,instant timestamptz) RETURNS text LANGUAGE sql STABLE AS $$
 SELECT coalesce((SELECT CASE WHEN restriction_coverage<>'complete' OR block_coverage<>'complete' OR provenance='unknown' OR (valid_until IS NOT NULL AND valid_until<=instant) THEN 'unavailable' WHEN actions_allowed THEN 'allow' ELSE 'deny' END FROM whaleu_safety.account_heads WHERE account_id=actor),'unavailable')
$$;
CREATE FUNCTION whaleu_ratings.dish_visibility(eid uuid,instant timestamptz) RETURNS text LANGUAGE sql STABLE AS $$
 SELECT coalesce((SELECT CASE WHEN NOT e.active THEN 'deny' WHEN r.status IN('deny','reject') OR s.status='deny' THEN 'deny' WHEN r.status='allow' AND s.status='allow' THEN 'allow' ELSE 'unavailable' END FROM whaleu_ratings.dish_events e CROSS JOIN LATERAL(SELECT whaleu_community.dish_review_status(e.review_decision_id,false,instant) status) r CROSS JOIN LATERAL(SELECT whaleu_safety.dish_contribution_status(e.actor_id,instant) status) s WHERE e.id=eid),'unavailable')
$$;
CREATE FUNCTION whaleu_ratings.dish_history(wid uuid,hkind text,instant timestamptz) RETURNS uuid LANGUAGE sql STABLE AS $$
 SELECT a.id FROM whaleu_ratings.dish_history_heads h JOIN whaleu_ratings.dish_history_assertions a ON a.id=h.assertion_id AND a.window_id=h.window_id AND a.kind=h.kind WHERE h.window_id=wid AND h.kind=hkind AND a.coverage='accepted_empty' AND a.accepted_at<=instant AND a.valid_until>instant
$$;
CREATE FUNCTION whaleu_ratings.dish_source(wid uuid,instant timestamptz) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN s IS NOT NULL THEN jsonb_build_object('catalog',s->>'catalog','revision',s->>'revision','population',whaleu_ratings.dish_history(wid,'population',instant),'membership',whaleu_ratings.dish_history(wid,'membership',instant)) END FROM (SELECT whaleu_ratings.window_source(wid,instant) s) source
$$;
CREATE FUNCTION whaleu_ratings.dish_deadline(wid uuid,instant timestamptz) RETURNS timestamptz LANGUAGE sql STABLE AS $$
 SELECT min(value) FROM (
 SELECT boundary.value FROM whaleu_ratings.dish_history_heads h JOIN whaleu_ratings.dish_history_assertions a ON a.id=h.assertion_id CROSS JOIN LATERAL(VALUES(a.accepted_at),(a.valid_until)) boundary(value) WHERE h.window_id=wid AND boundary.value>instant
 UNION ALL SELECT boundary.value FROM whaleu_ratings.dish_heads h JOIN whaleu_ratings.dish_events e ON e.id=h.revision JOIN whaleu_community.dish_review_decisions d ON d.id=e.review_decision_id JOIN whaleu_community.dish_review_policies p ON p.id=d.policy_id LEFT JOIN whaleu_safety.account_heads s ON s.account_id=e.actor_id CROSS JOIN LATERAL(VALUES(d.issued_at),(d.visibility_until),(p.valid_until),(s.valid_until)) boundary(value) WHERE h.window_id=wid AND e.active AND boundary.value>instant
 ) boundaries
$$;
CREATE FUNCTION whaleu_ratings.dish_fence() RETURNS void LANGUAGE plpgsql VOLATILE AS $$BEGIN
 -- The W1 owner fence retains accepted stable topology, Identity, phone, Safety,
 -- canonical Campus and mapping. No score history is used as dish coverage.
 PERFORM whaleu_ratings.window_fence();
 LOCK TABLE whaleu_ratings.dish_history_assertions,whaleu_ratings.dish_history_heads,whaleu_ratings.dish_events,whaleu_ratings.dish_heads,whaleu_ratings.dish_commands,whaleu_ratings.dish_epoch,whaleu_community.dish_review_policies,whaleu_community.dish_review_decisions,whaleu_community.dish_review_heads,whaleu_community.dish_review_epoch IN SHARE MODE NOWAIT;
 IF NOT EXISTS(SELECT 1 FROM whaleu_ratings.dish_epoch WHERE singleton) OR NOT EXISTS(SELECT 1 FROM whaleu_community.dish_review_epoch WHERE singleton) THEN RAISE EXCEPTION 'Dish owner epoch missing' USING ERRCODE='23514',CONSTRAINT='dish_causal';END IF;
END$$;
CREATE FUNCTION whaleu_ratings.dish_lock(actor uuid,rid uuid,wid uuid,name text) RETURNS void LANGUAGE plpgsql AS $$BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Dish commands require read committed' USING ERRCODE='23514',CONSTRAINT='dish_causal';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('whaleu:window-dish-request:v1:'||actor::text||':'||rid::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('whaleu:window-dish-membership:v1:'||actor::text||':'||wid::text||':'||encode(convert_to(name,'UTF8'),'hex'),0));
END$$;
CREATE FUNCTION whaleu_ratings.dish_command_lock() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN PERFORM whaleu_ratings.dish_lock(NEW.actor_id,NEW.request_id,NEW.window_id,NEW.command->>'dishName');RETURN NEW;END$$;
CREATE TRIGGER dish_command_lock BEFORE INSERT ON whaleu_ratings.dish_commands FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.dish_command_lock();
CREATE FUNCTION whaleu_ratings.dish_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$DECLARE own whaleu_ratings.dish_events;source jsonb;BEGIN
 PERFORM whaleu_ratings.dish_lock(NEW.actor_id,NEW.request_id,NEW.window_id,NEW.dish_name);
 SELECT e.* INTO own FROM whaleu_ratings.dish_heads h JOIN whaleu_ratings.dish_events e ON e.id=h.revision WHERE h.window_id=NEW.window_id AND h.actor_id=NEW.actor_id AND h.name_bytes=convert_to(NEW.dish_name,'UTF8');
 IF NEW.transaction_id<>pg_current_xact_id() OR NEW.recorded_at<>date_trunc('milliseconds',transaction_timestamp()) OR NEW.previous_revision IS DISTINCT FROM own.id OR NEW.active=coalesce(own.active,false) THEN RAISE EXCEPTION 'Dish transition needs exact changing predecessor' USING ERRCODE='23514',CONSTRAINT='dish_causal';END IF;
 IF NEW.active THEN
  source:=whaleu_ratings.dish_source(NEW.window_id,clock_timestamp());
  IF source IS NULL OR source->>'population' IS NULL OR source->>'membership' IS NULL OR (NEW.catalog_id::text,NEW.window_revision::text,NEW.population_assertion_id::text,NEW.membership_assertion_id::text) IS DISTINCT FROM(source->>'catalog',source->>'revision',source->>'population',source->>'membership') THEN RAISE EXCEPTION 'Dish add needs current source and independent histories' USING ERRCODE='23514',CONSTRAINT='dish_causal';END IF;
 END IF;RETURN NEW;
END$$;
CREATE TRIGGER dish_event_guard BEFORE INSERT ON whaleu_ratings.dish_events FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.dish_event_guard();
CREATE FUNCTION whaleu_ratings.dish_head_guard() RETURNS trigger LANGUAGE plpgsql AS $$DECLARE e whaleu_ratings.dish_events;previous uuid;BEGIN
 SELECT * INTO e FROM whaleu_ratings.dish_events WHERE id=NEW.revision AND actor_id=NEW.actor_id AND window_id=NEW.window_id AND name_bytes=NEW.name_bytes;
 IF e.id IS NULL THEN RAISE EXCEPTION 'Dish head needs exact event' USING ERRCODE='23514',CONSTRAINT='dish_causal';END IF;
 PERFORM whaleu_ratings.dish_lock(e.actor_id,e.request_id,e.window_id,e.dish_name);
 IF TG_OP='UPDATE' THEN previous:=OLD.revision;IF (NEW.window_id,NEW.actor_id,NEW.name_bytes) IS DISTINCT FROM(OLD.window_id,OLD.actor_id,OLD.name_bytes) THEN RAISE EXCEPTION 'Dish membership identity is immutable' USING ERRCODE='23514',CONSTRAINT='dish_causal';END IF;END IF;
 IF e.transaction_id<>pg_current_xact_id() OR e.previous_revision IS DISTINCT FROM previous THEN RAISE EXCEPTION 'Dish head needs new atomic causal event' USING ERRCODE='23514',CONSTRAINT='dish_causal';END IF;RETURN NEW;
END$$;
CREATE TRIGGER dish_head_guard BEFORE INSERT OR UPDATE ON whaleu_ratings.dish_heads FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.dish_head_guard();
-- SQL checks linearize at statement/deferred execution, not arbitrary COMMIT
-- wall clock after an untrusted caller flushes constraints then waits again.
CREATE FUNCTION whaleu_ratings.dish_complete(actor uuid,rid uuid) RETURNS void LANGUAGE plpgsql VOLATILE AS $$
DECLARE q whaleu_ratings.dish_commands;e whaleu_ratings.dish_events;own whaleu_ratings.dish_events;d whaleu_community.dish_review_decisions;source jsonb;instant timestamptz;expected uuid;add boolean;BEGIN
 PERFORM whaleu_ratings.dish_fence();instant:=clock_timestamp();
 SELECT * INTO q FROM whaleu_ratings.dish_commands WHERE actor_id=actor AND request_id=rid;
 IF q.request_id IS NULL OR q.transaction_id<>pg_current_xact_id() OR NOT whaleu_identity.window_rating_session(actor,q.session_id,instant) THEN RAISE EXCEPTION 'Current actor session and exact dish command required' USING ERRCODE='23514',CONSTRAINT='dish_causal';END IF;
 IF NOT whaleu_community.rating_scoped_keys(q.command,ARRAY['clientRequestId','expectedCatalogRevision','expectedWindowRevision','expectedMembershipRevision','dishName']) OR NOT whaleu_community.rating_scoped_ids(q.command,ARRAY['clientRequestId','expectedCatalogRevision','expectedWindowRevision']) OR (q.command->'expectedMembershipRevision'<>'null'::jsonb AND NOT whaleu_community.rating_scoped_ids(q.command,ARRAY['expectedMembershipRevision'])) OR jsonb_typeof(q.command->'dishName') IS DISTINCT FROM 'string' OR NOT whaleu_ratings.dish_name_valid(q.command->>'dishName') OR jsonb_typeof(q.receipt->'dishIdentity') IS DISTINCT FROM 'string' OR q.receipt->>'dishIdentity' IS DISTINCT FROM encode(convert_to(q.command->>'dishName','UTF8'),'hex') THEN RAISE EXCEPTION 'Strict byte-preserving dish intent required' USING ERRCODE='23514',CONSTRAINT='dish_causal';END IF;
 expected:=(q.command->>'expectedMembershipRevision')::uuid;add:=q.operation='window.dish.recommend.v1';
 SELECT * INTO e FROM whaleu_ratings.dish_events WHERE actor_id=actor AND request_id=rid;
 SELECT events.* INTO own FROM whaleu_ratings.dish_heads h JOIN whaleu_ratings.dish_events events ON events.id=h.revision WHERE h.window_id=q.window_id AND h.actor_id=actor AND h.name_bytes=convert_to(q.command->>'dishName','UTF8');
 IF q.receipt->>'outcome'='rejected' THEN
  IF NOT whaleu_community.rating_scoped_keys(q.receipt,ARRAY['requestId','operation','windowId','dishIdentity','outcome','code']) OR e.id IS NOT NULL THEN RAISE EXCEPTION 'Dish rejection cannot mutate' USING ERRCODE='23514',CONSTRAINT='dish_causal';END IF;
  IF q.receipt->>'code'='DISH_CANCELLED' THEN RETURN;END IF;
 END IF;
 IF add THEN
  IF NOT whaleu_ratings.window_access(actor,q.session_id,instant) THEN RAISE EXCEPTION 'Dish add needs current phone and Safety' USING ERRCODE='23514',CONSTRAINT='dish_causal';END IF;
  source:=whaleu_ratings.dish_source(q.window_id,instant);
  IF source IS NULL OR source->>'population' IS NULL OR source->>'membership' IS NULL THEN RAISE EXCEPTION 'Dish add needs source and distinct histories' USING ERRCODE='23514',CONSTRAINT='dish_causal';END IF;
  IF q.receipt->>'outcome'='rejected' AND q.receipt->>'code'='WINDOW_REVISION_CONFLICT' THEN
   IF (source->>'catalog',source->>'revision') IS NOT DISTINCT FROM(q.command->>'expectedCatalogRevision',q.command->>'expectedWindowRevision') THEN RAISE EXCEPTION 'Dish source conflict must be causal' USING ERRCODE='23514',CONSTRAINT='dish_causal';END IF;RETURN;
  END IF;
  IF (source->>'catalog',source->>'revision') IS DISTINCT FROM(q.command->>'expectedCatalogRevision',q.command->>'expectedWindowRevision') THEN RAISE EXCEPTION 'Current exact dish source required' USING ERRCODE='23514',CONSTRAINT='dish_causal';END IF;
 ELSE
  -- Owner-only closure intentionally survives source/history/Review/eligibility
  -- withdrawal. Known absence still needs an independently current history fact.
  IF own.id IS NULL AND whaleu_ratings.dish_history(q.window_id,'membership',instant) IS NULL THEN RAISE EXCEPTION 'Missing membership is not known absence' USING ERRCODE='23514',CONSTRAINT='dish_causal';END IF;
 END IF;
 IF q.receipt->>'outcome'='rejected' AND q.receipt->>'code'='DISH_MEMBERSHIP_REVISION_CONFLICT' THEN
  IF own.id IS NOT DISTINCT FROM expected THEN RAISE EXCEPTION 'Dish CAS rejection must be causal' USING ERRCODE='23514',CONSTRAINT='dish_causal';END IF;RETURN;
 END IF;
 IF q.receipt->>'outcome'='rejected' THEN
  IF own.id IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Dish state rejection follows exact CAS' USING ERRCODE='23514',CONSTRAINT='dish_causal';END IF;
  IF add AND own.active AND q.receipt->>'code'='DISH_ALREADY_RECOMMENDED' THEN RETURN;END IF;
  IF NOT add AND NOT coalesce(own.active,false) AND q.receipt->>'code'='DISH_NOT_RECOMMENDED' THEN RETURN;END IF;
 END IF;
 IF add THEN
  SELECT decisions.* INTO d FROM whaleu_community.dish_review_decisions decisions JOIN whaleu_community.dish_review_heads h ON h.decision_id=decisions.id WHERE h.actor_id=actor AND h.request_id=rid;
  IF d.id IS NULL OR (d.actor_id,d.request_id,d.window_id,d.catalog_id::text,d.window_revision::text,convert_to(d.dish_name,'UTF8')) IS DISTINCT FROM(actor,rid,q.window_id,q.command->>'expectedCatalogRevision',q.command->>'expectedWindowRevision',convert_to(q.command->>'dishName','UTF8')) THEN RAISE EXCEPTION 'Exact original dish Review required' USING ERRCODE='23514',CONSTRAINT='dish_causal';END IF;
  IF q.receipt->>'outcome'='rejected' AND NOT coalesce(own.active,false) AND q.receipt->>'code'='CONTENT_REJECTED' AND whaleu_community.dish_review_status(d.id,true,instant)='reject' THEN RETURN;END IF;
  IF whaleu_community.dish_review_status(d.id,true,instant)<>'allow' THEN RAISE EXCEPTION 'Current dish Review allow required' USING ERRCODE='23514',CONSTRAINT='dish_causal';END IF;
 END IF;
 IF q.receipt->>'outcome' IS DISTINCT FROM 'applied' OR NOT whaleu_community.rating_scoped_keys(q.receipt,ARRAY['requestId','operation','windowId','dishIdentity','outcome','active','membershipRevision','recordedAt']) OR NOT whaleu_community.rating_scoped_ids(q.receipt,ARRAY['membershipRevision']) OR q.receipt->'active' IS DISTINCT FROM to_jsonb(add) OR e.id IS NULL OR own.id IS DISTINCT FROM e.id OR e.window_id<>q.window_id OR e.name_bytes IS DISTINCT FROM convert_to(q.command->>'dishName','UTF8') OR e.active<>add OR e.transaction_id<>pg_current_xact_id() OR e.recorded_at<>date_trunc('milliseconds',transaction_timestamp()) OR e.previous_revision IS DISTINCT FROM expected OR q.receipt->>'membershipRevision' IS DISTINCT FROM e.id::text OR jsonb_typeof(q.receipt->'recordedAt') IS DISTINCT FROM 'string' OR q.receipt->>'recordedAt' IS DISTINCT FROM to_char(e.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') OR (add AND ((e.catalog_id::text,e.window_revision::text,e.population_assertion_id::text,e.membership_assertion_id::text) IS DISTINCT FROM(source->>'catalog',source->>'revision',source->>'population',source->>'membership') OR e.review_decision_id IS DISTINCT FROM d.id)) THEN RAISE EXCEPTION 'Applied dish receipt requires atomic exact transition and Review' USING ERRCODE='23514',CONSTRAINT='dish_causal';END IF;
END$$;
CREATE FUNCTION whaleu_ratings.dish_final() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN PERFORM whaleu_ratings.dish_complete(NEW.actor_id,NEW.request_id);RETURN NULL;END$$;
DO $$DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['dish_commands','dish_events'] LOOP EXECUTE format('CREATE CONSTRAINT TRIGGER dish_final AFTER INSERT ON whaleu_ratings.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.dish_final()',t);END LOOP;END$$;
CREATE FUNCTION whaleu_ratings.dish_head_final() RETURNS trigger LANGUAGE plpgsql AS $$DECLARE e whaleu_ratings.dish_events;BEGIN SELECT * INTO e FROM whaleu_ratings.dish_events WHERE id=NEW.revision;PERFORM whaleu_ratings.dish_complete(e.actor_id,e.request_id);RETURN NULL;END$$;
CREATE CONSTRAINT TRIGGER dish_head_final AFTER INSERT OR UPDATE ON whaleu_ratings.dish_heads DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.dish_head_final();
CREATE FUNCTION whaleu_ratings.dish_statement_final() RETURNS trigger LANGUAGE plpgsql AS $$DECLARE q record;BEGIN FOR q IN SELECT actor_id,request_id FROM inserted LOOP PERFORM whaleu_ratings.dish_complete(q.actor_id,q.request_id);END LOOP;RETURN NULL;END$$;
CREATE TRIGGER dish_statement_final AFTER INSERT ON whaleu_ratings.dish_commands REFERENCING NEW TABLE AS inserted FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.dish_statement_final();
