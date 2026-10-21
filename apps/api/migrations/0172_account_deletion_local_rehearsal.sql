-- Local synthetic deletion protocol. No public route, provider, production key,
-- policy approval or real-account enrollment is installed by this migration.
CREATE SCHEMA whaleu_account_deletion;
ALTER TABLE whaleu_identity.accounts ADD COLUMN lifecycle text NOT NULL DEFAULT 'active' CHECK(lifecycle IN('active','cooling','erasing','completed'));
ALTER TABLE whaleu_identity.accounts ADD COLUMN lifecycle_generation bigint NOT NULL DEFAULT 0 CHECK(lifecycle_generation>=0);
ALTER TABLE whaleu_identity.accounts ADD COLUMN deletion_request_id uuid;
ALTER TABLE whaleu_identity.sessions DROP CONSTRAINT sessions_revoke_reason_check;
ALTER TABLE whaleu_identity.sessions ADD CONSTRAINT sessions_revoke_reason_check CHECK(revoke_reason IN('logout','refresh_replay','session_limit','account_deletion'));
CREATE TABLE whaleu_account_deletion.sandboxes (
 id uuid PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 now_at timestamptz NOT NULL CHECK(isfinite(now_at)), inventory text NOT NULL,
 policy text NOT NULL CHECK(policy='synthetic-deletion-policy-v1'), catalog_hash text NOT NULL CHECK(catalog_hash ~ '^[a-f0-9]{64}$')
);
CREATE TABLE whaleu_account_deletion.inventory (
 sandbox_id uuid NOT NULL REFERENCES whaleu_account_deletion.sandboxes(id), relation text NOT NULL,
 shape_hash text NOT NULL, rows_hash text NOT NULL, row_count integer NOT NULL CHECK(row_count BETWEEN 0 AND 10000),
 supported boolean NOT NULL, PRIMARY KEY(sandbox_id,relation)
);
CREATE TABLE whaleu_account_deletion.fixture_accounts (
 account_id uuid PRIMARY KEY REFERENCES whaleu_identity.accounts(id),sandbox_id uuid NOT NULL REFERENCES whaleu_account_deletion.sandboxes(id),
 identity_digest text NOT NULL CHECK(identity_digest ~ '^[a-f0-9]{64}$'), baseline jsonb NOT NULL,
 creation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id()
);
CREATE TABLE whaleu_account_deletion.requests (
 id uuid PRIMARY KEY,account_id uuid NOT NULL REFERENCES whaleu_account_deletion.fixture_accounts(account_id),
 generation bigint NOT NULL CHECK(generation>0),intent_hash text NOT NULL CHECK(intent_hash ~ '^[a-f0-9]{64}$'),
 policy text NOT NULL CHECK(policy='synthetic-deletion-policy-v1'),inventory text NOT NULL,
 phase text NOT NULL CHECK(phase IN('cooling','erasing','waiting','completed','cancelled')),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),requested_at timestamptz NOT NULL,eligible_at timestamptz NOT NULL,
 irreversible_at timestamptz,completed_at timestamptz,reregister_after timestamptz,cancelled_at timestamptz,
 pending text[] NOT NULL DEFAULT '{}',receipt_key_hash text NOT NULL CHECK(receipt_key_hash ~ '^[a-f0-9]{64}$'),
 creation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 UNIQUE(account_id,generation),CHECK(eligible_at=requested_at+interval '604800 seconds'),
 CHECK((phase='completed')=(completed_at IS NOT NULL)),CHECK((phase='cancelled')=(cancelled_at IS NOT NULL)),
 CHECK((completed_at IS NULL AND reregister_after IS NULL) OR reregister_after=completed_at+interval '2592000 seconds')
);
CREATE UNIQUE INDEX account_deletion_one_open ON whaleu_account_deletion.requests(account_id) WHERE phase IN('cooling','erasing','waiting');
CREATE TABLE whaleu_account_deletion.commands (
 account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),command_id uuid NOT NULL,request_id uuid NOT NULL REFERENCES whaleu_account_deletion.requests(id),
 intent_hash text NOT NULL CHECK(intent_hash ~ '^[a-f0-9]{64}$'),outcome text NOT NULL CHECK(outcome IN('requested','cancelled')),receipt jsonb NOT NULL,
 PRIMARY KEY(account_id,command_id)
);
CREATE TABLE whaleu_account_deletion.recovery_grants (
 token_hash text PRIMARY KEY CHECK(token_hash ~ '^[a-f0-9]{64}$'),request_id uuid NOT NULL REFERENCES whaleu_account_deletion.requests(id),
 generation bigint NOT NULL,purpose text NOT NULL CHECK(purpose='account-deletion-status-cancel'),expires_at timestamptz NOT NULL
);
CREATE TABLE whaleu_account_deletion.owner_causes (
 request_id uuid NOT NULL REFERENCES whaleu_account_deletion.requests(id),owner text NOT NULL,
 generation bigint NOT NULL,mutation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 PRIMARY KEY(request_id,owner,mutation_transaction)
);
CREATE TABLE whaleu_account_deletion.owner_receipts (
 request_id uuid NOT NULL REFERENCES whaleu_account_deletion.requests(id),owner text NOT NULL CHECK(owner IN('identity','profile','timetable','legacy-follow','native-baseline','unsupported-inventory','media')),
 generation bigint NOT NULL,inventory text NOT NULL,proof text NOT NULL CHECK(proof ~ '^[a-f0-9]{64}$'),PRIMARY KEY(request_id,owner)
);
CREATE TABLE whaleu_account_deletion.reregistration_guards (
 identity_digest text NOT NULL CHECK(identity_digest ~ '^[a-f0-9]{64}$'),key_version text NOT NULL CHECK(key_version='synthetic-explicit-key-v1'),
 request_id uuid NOT NULL UNIQUE REFERENCES whaleu_account_deletion.requests(id),completed_at timestamptz NOT NULL,reregister_after timestamptz NOT NULL,
 CHECK(reregister_after=completed_at+interval '2592000 seconds'),PRIMARY KEY(identity_digest,request_id)
);
CREATE TABLE whaleu_account_deletion.reserved_profile_ids (
 public_id uuid PRIMARY KEY,request_id uuid NOT NULL REFERENCES whaleu_account_deletion.requests(id)
);
CREATE FUNCTION whaleu_account_deletion.immutable() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'Deletion evidence is immutable' USING ERRCODE='23514';END$$;
DO $$DECLARE name text;BEGIN FOREACH name IN ARRAY ARRAY['inventory','fixture_accounts','commands','owner_causes','owner_receipts','reregistration_guards','reserved_profile_ids'] LOOP
 EXECUTE format('CREATE TRIGGER deletion_evidence_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON whaleu_account_deletion.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_account_deletion.immutable()',name);
END LOOP;END$$;
CREATE FUNCTION whaleu_account_deletion.sandbox_clock_guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF TG_OP<>'UPDATE' OR NEW.now_at<OLD.now_at OR (to_jsonb(NEW)-'now_at') IS DISTINCT FROM (to_jsonb(OLD)-'now_at')
 THEN RAISE EXCEPTION 'Synthetic sandbox identity is immutable and its clock is monotone' USING ERRCODE='23514';END IF;RETURN NEW;
END$$;
CREATE TRIGGER deletion_sandbox_clock_guard BEFORE UPDATE OR DELETE ON whaleu_account_deletion.sandboxes FOR EACH ROW EXECUTE FUNCTION whaleu_account_deletion.sandbox_clock_guard();
CREATE TRIGGER deletion_sandbox_no_truncate BEFORE TRUNCATE ON whaleu_account_deletion.sandboxes FOR EACH STATEMENT EXECUTE FUNCTION whaleu_account_deletion.immutable();
CREATE FUNCTION whaleu_account_deletion.fixture_admit() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF current_database()<>'whaleu_test' OR NEW.creation_transaction<>pg_current_xact_id()
 OR NOT EXISTS(SELECT 1 FROM whaleu_identity.accounts WHERE id=NEW.account_id AND lifecycle='active' AND local_creation_transaction=pg_current_xact_id())
 OR NOT EXISTS(SELECT 1 FROM whaleu_identity.provider_identities WHERE account_id=NEW.account_id AND provider='wechat' AND app_id='synthetic-account-deletion-rehearsal' AND subject ~ '^synthetic-[a-f0-9-]{36}$')
 THEN RAISE EXCEPTION 'Only newly generated isolated rehearsal accounts may enroll' USING ERRCODE='23514';END IF;RETURN NEW;
END$$;
CREATE TRIGGER deletion_fixture_admit BEFORE INSERT ON whaleu_account_deletion.fixture_accounts FOR EACH ROW EXECUTE FUNCTION whaleu_account_deletion.fixture_admit();
CREATE FUNCTION whaleu_account_deletion.owner_cause(target uuid,owner_key text) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM whaleu_account_deletion.owner_causes c JOIN whaleu_account_deletion.requests r ON r.id=c.request_id JOIN whaleu_identity.accounts a ON a.id=r.account_id
 WHERE r.account_id=target AND r.phase IN('erasing','waiting') AND a.lifecycle='erasing' AND a.deletion_request_id=r.id AND a.lifecycle_generation=r.generation
 AND c.owner=owner_key AND c.generation=r.generation AND c.mutation_transaction=pg_current_xact_id())
$$;
CREATE FUNCTION whaleu_account_deletion.lifecycle_guard() RETURNS trigger LANGUAGE plpgsql AS $$DECLARE r whaleu_account_deletion.requests;BEGIN
 IF (NEW.lifecycle,NEW.lifecycle_generation,NEW.deletion_request_id) IS NOT DISTINCT FROM (OLD.lifecycle,OLD.lifecycle_generation,OLD.deletion_request_id) THEN RETURN NEW;END IF;
 SELECT * INTO r FROM whaleu_account_deletion.requests WHERE id=NEW.deletion_request_id AND account_id=NEW.id;
 IF r.id IS NULL OR r.generation<>NEW.lifecycle_generation OR NEW.status IS DISTINCT FROM OLD.status
 OR NOT ((OLD.lifecycle='active' AND NEW.lifecycle='cooling' AND r.phase='cooling' AND r.creation_transaction=pg_current_xact_id() AND NEW.lifecycle_generation=OLD.lifecycle_generation+1)
 OR (OLD.lifecycle='cooling' AND NEW.lifecycle='active' AND r.phase='cancelled' AND NEW.lifecycle_generation=OLD.lifecycle_generation)
 OR (OLD.lifecycle='cooling' AND NEW.lifecycle='erasing' AND r.phase='erasing' AND NEW.lifecycle_generation=OLD.lifecycle_generation)
 OR (OLD.lifecycle='erasing' AND NEW.lifecycle='completed' AND r.phase='completed' AND NEW.lifecycle_generation=OLD.lifecycle_generation))
 THEN RAISE EXCEPTION 'Exact deletion lifecycle cause required' USING ERRCODE='23514';END IF;RETURN NEW;
END$$;
CREATE TRIGGER deletion_lifecycle_guard BEFORE UPDATE ON whaleu_identity.accounts FOR EACH ROW EXECUTE FUNCTION whaleu_account_deletion.lifecycle_guard();
CREATE FUNCTION whaleu_account_deletion.request_guard() RETURNS trigger LANGUAGE plpgsql AS $$DECLARE at timestamptz;a whaleu_identity.accounts;BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Deletion request identity is retained' USING ERRCODE='23514';END IF;
 SELECT * INTO a FROM whaleu_identity.accounts WHERE id=NEW.account_id FOR UPDATE NOWAIT;
 SELECT s.now_at INTO at FROM whaleu_account_deletion.fixture_accounts f JOIN whaleu_account_deletion.sandboxes s ON s.id=f.sandbox_id WHERE f.account_id=NEW.account_id;
 IF at IS NULL OR current_database()<>'whaleu_test' THEN RAISE EXCEPTION 'Synthetic deletion unavailable' USING ERRCODE='23514';END IF;
 IF TG_OP='INSERT' THEN
  IF a.lifecycle<>'active' OR a.status<>'active' OR NEW.generation<>a.lifecycle_generation+1 OR NEW.revision<>1 OR NEW.phase<>'cooling' OR NEW.requested_at<>at OR NEW.eligible_at<>at+interval '604800 seconds' OR NEW.irreversible_at IS NOT NULL OR NEW.creation_transaction<>pg_current_xact_id() THEN RAISE EXCEPTION 'Invalid initial deletion request' USING ERRCODE='23514';END IF;RETURN NEW;
 END IF;
 IF (to_jsonb(OLD)-ARRAY['phase','revision','irreversible_at','completed_at','reregister_after','cancelled_at','pending']) IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['phase','revision','irreversible_at','completed_at','reregister_after','cancelled_at','pending']) OR NEW.revision<>OLD.revision+1 OR OLD.phase IN('completed','cancelled') THEN RAISE EXCEPTION 'Deletion intent and terminal times are immutable' USING ERRCODE='23514';END IF;
 IF OLD.phase='cooling' AND NEW.phase='cancelled' AND at<OLD.eligible_at AND NEW.cancelled_at=at AND NEW.irreversible_at IS NULL THEN RETURN NEW;END IF;
 IF OLD.phase='cooling' AND NEW.phase='erasing' AND at>=OLD.eligible_at AND NEW.irreversible_at=at THEN RETURN NEW;END IF;
 IF OLD.phase IN('erasing','waiting') AND NEW.phase='waiting' AND NEW.irreversible_at=OLD.irreversible_at AND NEW.completed_at IS NULL THEN RETURN NEW;END IF;
 IF OLD.phase IN('erasing','waiting') AND NEW.phase='completed' AND NEW.irreversible_at=OLD.irreversible_at AND NEW.completed_at=at AND NEW.reregister_after=at+interval '2592000 seconds'
 AND (SELECT count(*) FROM whaleu_account_deletion.owner_receipts WHERE request_id=NEW.id AND generation=NEW.generation AND inventory=NEW.inventory)=7
 AND NOT EXISTS(SELECT 1 FROM whaleu_identity.provider_identities WHERE account_id=NEW.account_id)
 AND NOT EXISTS(SELECT 1 FROM whaleu_identity.sessions WHERE account_id=NEW.account_id)
 AND NOT EXISTS(SELECT 1 FROM whaleu_profile.profiles WHERE account_id=NEW.account_id)
 AND NOT EXISTS(SELECT 1 FROM whaleu_profile.details WHERE account_id=NEW.account_id)
 AND NOT EXISTS(SELECT 1 FROM whaleu_profile.self_edit_causes WHERE actor_id=NEW.account_id AND (erased_by_request_id IS NULL OR patch<>'{}'::jsonb OR before_row<>'{}'::jsonb OR token_hash<>repeat('0',64)))
 AND NOT EXISTS(SELECT 1 FROM whaleu_timetable.terms WHERE account_id=NEW.account_id AND deleted_at IS NULL)
 AND NOT EXISTS(SELECT 1 FROM whaleu_timetable.entries WHERE account_id=NEW.account_id AND deleted_at IS NULL)
 AND NOT EXISTS(SELECT 1 FROM whaleu_community.user_follows WHERE follower_id=NEW.account_id OR followed_id=NEW.account_id)
 AND NOT EXISTS(SELECT 1 FROM whaleu_community.follow_requests WHERE account_id=NEW.account_id)
 THEN RETURN NEW;END IF;
 RAISE EXCEPTION 'Deletion transition or completion predicate failed' USING ERRCODE='23514';
END$$;
CREATE TRIGGER deletion_request_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_account_deletion.requests FOR EACH ROW EXECUTE FUNCTION whaleu_account_deletion.request_guard();
CREATE FUNCTION whaleu_account_deletion.request_apply() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF TG_OP='INSERT' THEN
 UPDATE whaleu_identity.accounts SET lifecycle='cooling',lifecycle_generation=NEW.generation,deletion_request_id=NEW.id WHERE id=NEW.account_id;
 UPDATE whaleu_identity.sessions SET revoked_at=NEW.requested_at,revoke_reason='account_deletion' WHERE account_id=NEW.account_id AND revoked_at IS NULL;
 ELSE
 UPDATE whaleu_identity.accounts SET lifecycle=CASE NEW.phase WHEN 'cancelled' THEN 'active' WHEN 'completed' THEN 'completed' ELSE 'erasing' END WHERE id=NEW.account_id;
 END IF;RETURN NULL;
END$$;
CREATE TRIGGER deletion_request_apply AFTER INSERT OR UPDATE ON whaleu_account_deletion.requests FOR EACH ROW EXECUTE FUNCTION whaleu_account_deletion.request_apply();
-- This additive writer fence does not erase or bypass any old owner invariant.
-- Match account UUIDs even in nested JSON and actor references without FKs. A
-- bounded NOWAIT lock plus fresh recheck closes the snapshot/lock-wait race.
-- Nonmatching indirect/opaque owners are still covered by the conservative
-- complete-relation inventory seal and final table locks, never guessed empty.
CREATE FUNCTION whaleu_account_deletion.writer_fence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE payload text;target record;owner_key text;allowed boolean;BEGIN
 payload:=CASE TG_OP WHEN 'INSERT' THEN to_jsonb(NEW)::text WHEN 'DELETE' THEN to_jsonb(OLD)::text ELSE to_jsonb(NEW)::text||to_jsonb(OLD)::text END;
 FOR target IN SELECT a.id FROM whaleu_identity.accounts a JOIN whaleu_account_deletion.fixture_accounts f ON f.account_id=a.id WHERE position(a.id::text IN payload)>0 ORDER BY a.id LOOP
  PERFORM id FROM whaleu_identity.accounts WHERE id=target.id FOR SHARE NOWAIT;
  IF (SELECT lifecycle FROM whaleu_identity.accounts WHERE id=target.id)='active' THEN CONTINUE;END IF;
  owner_key:=CASE WHEN TG_TABLE_SCHEMA='whaleu_profile' AND TG_TABLE_NAME IN('profiles','details','self_edit_causes') THEN 'profile'
   WHEN TG_TABLE_SCHEMA='whaleu_timetable' AND TG_TABLE_NAME IN('terms','entries') THEN 'timetable'
   WHEN TG_TABLE_SCHEMA='whaleu_community' AND TG_TABLE_NAME IN('user_follows','follow_heads','follow_requests') THEN 'legacy-follow'
   WHEN TG_TABLE_SCHEMA='whaleu_identity' AND TG_TABLE_NAME IN('sessions','provider_identities') THEN 'identity' ELSE NULL END;
  allowed:=owner_key IS NOT NULL AND whaleu_account_deletion.owner_cause(target.id,owner_key);
  IF allowed AND TG_OP='DELETE' AND owner_key IN('profile','legacy-follow','identity') THEN CONTINUE;END IF;
  IF allowed AND TG_OP='UPDATE' AND owner_key='profile' AND TG_TABLE_NAME='self_edit_causes' AND to_jsonb(NEW)->>'erased_by_request_id' IS NOT NULL THEN CONTINUE;END IF;
  IF allowed AND TG_OP='UPDATE' AND owner_key='timetable' AND to_jsonb(NEW)->>'deleted_at' IS NOT NULL THEN CONTINUE;END IF;
  IF TG_TABLE_SCHEMA='whaleu_identity' AND TG_TABLE_NAME='sessions' AND TG_OP='UPDATE' AND to_jsonb(NEW)->>'revoked_at' IS NOT NULL AND to_jsonb(NEW)->>'revoke_reason'='account_deletion'
   AND EXISTS(SELECT 1 FROM whaleu_account_deletion.requests WHERE account_id=target.id AND creation_transaction=pg_current_xact_id() AND phase='cooling') THEN CONTINUE;END IF;
  RAISE EXCEPTION 'Account lifecycle denies this owner write' USING ERRCODE='23514',CONSTRAINT='account_deletion_writer_fence';
 END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END$$;
DO $$DECLARE relation record;BEGIN
 FOR relation IN SELECT n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname LIKE 'whaleu\_%' ESCAPE '\' AND n.nspname NOT IN('whaleu_account_deletion','whaleu_meta') AND c.relkind='r' AND (n.nspname,c.relname)<>('whaleu_identity','accounts') LOOP
  EXECUTE format('CREATE TRIGGER a000_account_deletion_writer_fence BEFORE INSERT OR UPDATE OR DELETE ON %I.%I FOR EACH ROW EXECUTE FUNCTION whaleu_account_deletion.writer_fence()',relation.nspname,relation.relname);
 END LOOP;
END$$;
CREATE FUNCTION whaleu_account_deletion.profile_id_reserved() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF EXISTS(SELECT 1 FROM whaleu_account_deletion.reserved_profile_ids WHERE public_id=NEW.public_id) THEN RAISE EXCEPTION 'Erased public profile identity is permanently reserved' USING ERRCODE='23514';END IF;RETURN NEW;
END$$;
CREATE TRIGGER deletion_profile_id_reserved BEFORE INSERT OR UPDATE ON whaleu_profile.profiles FOR EACH ROW EXECUTE FUNCTION whaleu_account_deletion.profile_id_reserved();
CREATE OR REPLACE FUNCTION whaleu_safety.require_account_punishment_allowed(actor uuid,action text)
RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$BEGIN
 PERFORM id FROM whaleu_identity.accounts WHERE id=actor FOR SHARE NOWAIT;
 IF NOT EXISTS(SELECT 1 FROM whaleu_identity.accounts WHERE id=actor AND (lifecycle='active' OR (action='private_self_service' AND whaleu_account_deletion.owner_cause(actor,'timetable')))) THEN
 RAISE EXCEPTION 'Account lifecycle denies this operation' USING ERRCODE='23514',CONSTRAINT='account_deletion_writer_fence';END IF;
 LOCK TABLE whaleu_safety.account_punishments,whaleu_safety.account_punishment_heads,whaleu_safety.account_punishment_terminals IN SHARE MODE NOWAIT;
 IF NOT whaleu_safety.account_punishment_allows(actor,action) THEN RAISE EXCEPTION 'Current account punishment denies this operation' USING ERRCODE='23514',CONSTRAINT='account_punishment_policy';END IF;RETURN true;
END$$;
REVOKE ALL ON SCHEMA whaleu_account_deletion FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA whaleu_account_deletion FROM PUBLIC;
-- Admission evidence is not a freely insertable bag of shaped hashes. A receipt
-- belongs to an exact current owner cause, and completion rereads the physical
-- predicates under the same local inventory fences as the coordinator.
CREATE FUNCTION whaleu_account_deletion.canonical_json(value jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE result text;BEGIN
 CASE jsonb_typeof(value)
 WHEN 'array' THEN SELECT '['||coalesce(string_agg(whaleu_account_deletion.canonical_json(v),',' ORDER BY ord),'')||']' INTO result FROM jsonb_array_elements(value) WITH ORDINALITY a(v,ord);
 WHEN 'object' THEN SELECT '{'||coalesce(string_agg(to_jsonb(k)::text||':'||whaleu_account_deletion.canonical_json(v),',' ORDER BY k COLLATE "C"),'')||'}' INTO result FROM jsonb_each(value) a(k,v);
 ELSE result:=value::text;
 END CASE;RETURN result;
END$$;
CREATE FUNCTION whaleu_account_deletion.json_hash(value jsonb) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT encode(sha256(convert_to(whaleu_account_deletion.canonical_json(value),'UTF8')),'hex')
$$;
CREATE FUNCTION whaleu_account_deletion.inventory_current(request uuid) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE sandbox uuid;item record;shape jsonb;rows jsonb;row_total integer;known text[];BEGIN
 SELECT f.sandbox_id INTO sandbox FROM whaleu_account_deletion.requests r JOIN whaleu_account_deletion.fixture_accounts f ON f.account_id=r.account_id WHERE r.id=request;
 IF sandbox IS NULL THEN RETURN false;END IF;
 IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname LIKE 'whaleu\_%' ESCAPE '\' AND c.relkind IN('m','f'))
 OR (SELECT array_agg(n.nspname||'.'||c.relname ORDER BY n.nspname||'.'||c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN('whaleu_account_deletion','whaleu_meta') AND c.relkind IN('r','p'))
 IS DISTINCT FROM ARRAY['whaleu_account_deletion.commands','whaleu_account_deletion.fixture_accounts','whaleu_account_deletion.fixture_media_cohorts','whaleu_account_deletion.inventory','whaleu_account_deletion.media_observations','whaleu_account_deletion.owner_causes','whaleu_account_deletion.owner_receipts','whaleu_account_deletion.recovery_grants','whaleu_account_deletion.requests','whaleu_account_deletion.reregistration_guards','whaleu_account_deletion.reserved_profile_ids','whaleu_account_deletion.sandboxes','whaleu_meta.schema_migrations']::text[] THEN RETURN false;END IF;
 SELECT array_agg(relation ORDER BY relation) INTO known FROM whaleu_account_deletion.inventory WHERE sandbox_id=sandbox;
 IF known IS NULL OR known IS DISTINCT FROM (SELECT array_agg(n.nspname||'.'||c.relname ORDER BY n.nspname||'.'||c.relname)
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname LIKE 'whaleu\_%' ESCAPE '\' AND n.nspname NOT IN('whaleu_account_deletion','whaleu_meta') AND c.relkind IN('r','p'))
 OR EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname LIKE 'whaleu\_%' ESCAPE '\' AND n.nspname NOT IN('whaleu_account_deletion','whaleu_meta') AND NOT EXISTS(SELECT 1 FROM unnest(known) k WHERE split_part(k,'.',1)=n.nspname)) THEN RETURN false;END IF;
 FOR item IN SELECT * FROM whaleu_account_deletion.inventory WHERE sandbox_id=sandbox ORDER BY relation LOOP
  IF item.relation!~'^whaleu_[a-z_]+\.[a-z_][a-z0-9_]*$' THEN RETURN false;END IF;
  EXECUTE format('LOCK TABLE %I.%I IN SHARE ROW EXCLUSIVE MODE NOWAIT',split_part(item.relation,'.',1),split_part(item.relation,'.',2));
  SELECT jsonb_build_object('columns',(SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull) ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
   'constraints',(SELECT jsonb_agg(pg_get_constraintdef(k.oid) ORDER BY k.conname) FROM pg_constraint k WHERE k.conrelid=c.oid),
   'triggers',(SELECT jsonb_agg(pg_get_triggerdef(t.oid) ORDER BY t.tgname) FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal)) INTO shape FROM pg_class c WHERE c.oid=item.relation::regclass;
  IF whaleu_account_deletion.json_hash(shape) IS DISTINCT FROM item.shape_hash THEN RETURN false;END IF;
  IF NOT item.supported THEN
   EXECUTE format('SELECT count(*),coalesce(jsonb_agg(raw ORDER BY raw),''[]''::jsonb) FROM (SELECT to_jsonb(t)::text raw FROM %I.%I t ORDER BY to_jsonb(t)::text LIMIT 10001) q',split_part(item.relation,'.',1),split_part(item.relation,'.',2)) INTO row_total,rows;
   IF row_total<>item.row_count OR whaleu_account_deletion.json_hash(rows) IS DISTINCT FROM item.rows_hash THEN RETURN false;END IF;
  END IF;
 END LOOP;
 RETURN true;
END$$;
CREATE FUNCTION whaleu_account_deletion.baseline_current(target uuid) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE sealed jsonb;current_rows jsonb;item record;row jsonb;names text[];BEGIN
 SELECT baseline INTO sealed FROM whaleu_account_deletion.fixture_accounts WHERE account_id=target;
 IF sealed IS NULL OR jsonb_typeof(sealed)<>'object' THEN RETURN false;END IF;
 names:=ARRAY['whaleu_experience.owners','whaleu_experience.baselines','whaleu_experience.account_states','whaleu_experience.entitlements','whaleu_experience.appearance','whaleu_safety.account_heads','whaleu_safety.events','whaleu_verification.account_heads','whaleu_verification.assertions','whaleu_verification.snapshots','whaleu_verification.events','whaleu_verification.native_enrollments','whaleu_verification.relevant_fact_generations'];
 IF (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(sealed) k) IS DISTINCT FROM (SELECT array_agg(k ORDER BY k) FROM unnest(names) k) THEN RETURN false;END IF;
 FOR item IN SELECT * FROM (VALUES
 ('whaleu_experience.owners','owner_id'),
 ('whaleu_experience.baselines','owner_id origin opening_balance opening_signin_day opening_streak history_coverage entitlement_coverage rule_version recorded_at'),
 ('whaleu_experience.account_states','owner_id balance last_signin_day streak revision'),
 ('whaleu_experience.entitlements','owner_id title_key origin settlement_id earned_at recorded_at redemption_request_id creation_transaction maintenance_actor_id maintenance_request_id school_admin_actor_id school_admin_request_id'),
 ('whaleu_experience.appearance','owner_id title_key color_id revision'),
 ('whaleu_safety.account_heads','account_id block_coverage restriction_coverage provenance actions_allowed valid_until created_at'),
 ('whaleu_safety.events','id account_id relationship_id kind revision created_at'),
 ('whaleu_verification.account_heads','account_id revision snapshot_id'),
 ('whaleu_verification.assertions','id account_id fact_kind assertion_state coverage_state provenance_state method source_reference policy_reference source_account_id issuer_institution_id source_issuer_institution_id origin_region_id student_number phone_binding_reference verified_at expiry_kind expires_at previous_assertion_id recorded_at'),
 ('whaleu_verification.snapshots','id account_id revision affiliation_assertion_id student_number_assertion_id phone_assertion_id application_state application_coverage recorded_at'),
 ('whaleu_verification.events','id account_id operation_id kind fact_kind actor_account_id expected_revision snapshot_id revision reason_code recorded_at'),
 ('whaleu_verification.native_enrollments','account_id app_id operation_id affiliation_id student_number_id phone_id snapshot_id event_id creation_transaction created_at'),
 ('whaleu_verification.relevant_fact_generations','account_id tracking_epoch affiliation_generation student_number_generation head_revision head_snapshot_id')) v(relation,fields) LOOP
  EXECUTE format('SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),''[]''::jsonb) FROM %I.%I t WHERE %I=$1',split_part(item.relation,'.',1),split_part(item.relation,'.',2),CASE WHEN item.relation LIKE 'whaleu_experience.%' THEN 'owner_id' ELSE 'account_id' END) INTO current_rows USING target;
  IF current_rows IS DISTINCT FROM sealed->item.relation THEN RETURN false;END IF;
  FOR row IN SELECT value FROM jsonb_array_elements(current_rows) LOOP
   IF (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(row) k) IS DISTINCT FROM (SELECT array_agg(k ORDER BY k) FROM unnest(string_to_array(item.fields,' ')) k) THEN RETURN false;END IF;
  END LOOP;
 END LOOP;
 IF (SELECT count(*) FROM whaleu_experience.owners WHERE owner_id=target)<>1
 OR (SELECT count(*) FROM whaleu_experience.baselines WHERE owner_id=target AND origin='native_account_creation' AND opening_balance=0 AND opening_signin_day IS NULL AND opening_streak=0 AND history_coverage='complete' AND entitlement_coverage='complete' AND rule_version='local-experience-v1')<>1
 OR (SELECT count(*) FROM whaleu_experience.account_states WHERE owner_id=target AND balance=0 AND last_signin_day IS NULL AND streak=0 AND revision=0)<>1
 OR (SELECT count(*) FROM whaleu_experience.appearance WHERE owner_id=target AND title_key IS NULL AND color_id IS NULL AND revision=0)<>1
 OR (SELECT count(*) FROM whaleu_experience.entitlements WHERE owner_id=target)<>2
 OR (SELECT count(*) FROM whaleu_experience.entitlements WHERE owner_id=target AND title_key IN('default_jingxiaoyu','level_1') AND origin='registration' AND settlement_id IS NULL AND redemption_request_id IS NULL AND creation_transaction IS NULL AND maintenance_actor_id IS NULL AND maintenance_request_id IS NULL AND school_admin_actor_id IS NULL AND school_admin_request_id IS NULL)<>2
 OR (SELECT count(*) FROM whaleu_safety.account_heads WHERE account_id=target AND block_coverage='complete' AND restriction_coverage='complete' AND provenance='native_account_creation' AND actions_allowed AND valid_until IS NULL)<>1
 OR (SELECT count(*) FROM whaleu_safety.events WHERE account_id=target)<>1
 OR (SELECT count(*) FROM whaleu_safety.events WHERE account_id=target AND kind='native_account_created' AND relationship_id IS NULL AND revision IS NULL)<>1 THEN RETURN false;END IF;
 IF jsonb_array_length(sealed->'whaleu_verification.assertions')=0 THEN
  RETURN NOT EXISTS(SELECT 1 FROM jsonb_each(sealed) a WHERE a.key LIKE 'whaleu_verification.%' AND a.value<>'[]'::jsonb);
 END IF;
 IF (SELECT count(*) FROM whaleu_verification.assertions WHERE account_id=target)<>3
 OR (SELECT count(DISTINCT fact_kind) FROM whaleu_verification.assertions WHERE account_id=target AND fact_kind IN('affiliation','phone','student_number') AND assertion_state='unverified' AND coverage_state='complete' AND provenance_state='accepted' AND method='native_enrollment' AND source_reference='native_enrollment:'||target::text AND source_account_id=target AND policy_reference='native-account-absence/v1' AND expiry_kind='policy_exempt' AND issuer_institution_id IS NULL AND source_issuer_institution_id IS NULL AND origin_region_id IS NULL AND student_number IS NULL AND phone_binding_reference IS NULL AND verified_at IS NULL AND expires_at IS NULL AND previous_assertion_id IS NULL)<>3
 OR (SELECT count(*) FROM whaleu_verification.snapshots WHERE account_id=target)<>1
 OR (SELECT count(*) FROM whaleu_verification.snapshots s WHERE s.account_id=target AND s.revision=1 AND s.application_state='none' AND s.application_coverage='complete' AND EXISTS(SELECT 1 FROM whaleu_verification.assertions a WHERE a.account_id=target AND a.id=s.affiliation_assertion_id AND a.fact_kind='affiliation') AND EXISTS(SELECT 1 FROM whaleu_verification.assertions a WHERE a.account_id=target AND a.id=s.student_number_assertion_id AND a.fact_kind='student_number') AND EXISTS(SELECT 1 FROM whaleu_verification.assertions a WHERE a.account_id=target AND a.id=s.phone_assertion_id AND a.fact_kind='phone'))<>1
 OR (SELECT count(*) FROM whaleu_verification.account_heads h JOIN whaleu_verification.snapshots s ON s.id=h.snapshot_id AND s.account_id=h.account_id WHERE h.account_id=target AND h.revision=1)<>1
 OR (SELECT count(*) FROM whaleu_verification.events WHERE account_id=target)<>1
 OR (SELECT count(*) FROM whaleu_verification.events e JOIN whaleu_verification.account_heads h ON h.account_id=e.account_id AND h.snapshot_id=e.snapshot_id WHERE e.account_id=target AND e.kind='native_enrollment' AND e.fact_kind IS NULL AND e.actor_account_id=target AND e.expected_revision=0 AND e.revision=1 AND e.reason_code='native_account_created')<>1
 OR (SELECT count(*) FROM whaleu_verification.native_enrollments n JOIN whaleu_verification.snapshots s ON s.account_id=n.account_id AND s.id=n.snapshot_id AND s.affiliation_assertion_id=n.affiliation_id AND s.student_number_assertion_id=n.student_number_id AND s.phone_assertion_id=n.phone_id JOIN whaleu_verification.events e ON e.id=n.event_id AND e.account_id=n.account_id AND e.operation_id=n.operation_id WHERE n.account_id=target AND n.app_id='synthetic-account-deletion-rehearsal')<>1
 OR (SELECT count(*) FROM whaleu_verification.relevant_fact_generations g JOIN whaleu_verification.account_heads h ON h.account_id=g.account_id AND h.snapshot_id=g.head_snapshot_id WHERE g.account_id=target AND g.affiliation_generation=1 AND g.student_number_generation=1 AND g.head_revision=1)<>1 THEN RETURN false;END IF;
 RETURN true;
END$$;
CREATE FUNCTION whaleu_account_deletion.owner_receipt_admit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r whaleu_account_deletion.requests;BEGIN
 SELECT * INTO r FROM whaleu_account_deletion.requests WHERE id=NEW.request_id;
 IF r.id IS NULL OR NEW.generation<>r.generation OR NEW.inventory<>r.inventory
 OR NOT whaleu_account_deletion.owner_cause(r.account_id,NEW.owner)
 OR NOT EXISTS(SELECT 1 FROM whaleu_account_deletion.owner_causes c WHERE c.request_id=r.id AND c.owner=NEW.owner AND c.generation=r.generation AND c.mutation_transaction=pg_current_xact_id())
 THEN RAISE EXCEPTION 'Exact current owner receipt cause required' USING ERRCODE='23514';END IF;
 IF NEW.owner='profile' AND (EXISTS(SELECT 1 FROM whaleu_profile.profiles WHERE account_id=r.account_id) OR EXISTS(SELECT 1 FROM whaleu_profile.details WHERE account_id=r.account_id) OR EXISTS(SELECT 1 FROM whaleu_profile.self_edit_causes WHERE actor_id=r.account_id AND (erased_by_request_id IS DISTINCT FROM r.id OR patch<>'{}'::jsonb OR before_row<>'{}'::jsonb OR token_hash<>repeat('0',64))))
 OR NEW.owner='identity' AND (EXISTS(SELECT 1 FROM whaleu_identity.sessions WHERE account_id=r.account_id) OR EXISTS(SELECT 1 FROM whaleu_identity.provider_identities WHERE account_id=r.account_id))
 OR NEW.owner='timetable' AND (EXISTS(SELECT 1 FROM whaleu_timetable.terms WHERE account_id=r.account_id AND (deleted_at IS NULL OR name IS NOT NULL OR week_one_monday IS NOT NULL OR week_count IS NOT NULL OR time_zone IS NOT NULL)) OR EXISTS(SELECT 1 FROM whaleu_timetable.entries WHERE account_id=r.account_id AND (deleted_at IS NULL OR name IS NOT NULL OR teacher IS NOT NULL OR location IS NOT NULL OR note IS NOT NULL OR day_of_week IS NOT NULL OR start_minute IS NOT NULL OR end_minute IS NOT NULL OR weeks IS NOT NULL OR color IS NOT NULL)))
 OR NEW.owner='legacy-follow' AND (EXISTS(SELECT 1 FROM whaleu_community.user_follows WHERE follower_id=r.account_id OR followed_id=r.account_id) OR EXISTS(SELECT 1 FROM whaleu_community.follow_requests WHERE account_id=r.account_id))
 OR NEW.owner='native-baseline' AND NOT whaleu_account_deletion.baseline_current(r.account_id)
 OR NEW.owner='unsupported-inventory' AND NOT whaleu_account_deletion.inventory_current(r.id)
 OR NEW.owner='media' AND (NOT whaleu_account_deletion.media_complete(r.id)
   OR NOT EXISTS(SELECT 1 FROM whaleu_account_deletion.media_observations o WHERE o.request_id=r.id AND o.generation=r.generation AND o.mutation_transaction=pg_current_xact_id() AND o.proof=NEW.proof))
 THEN RAISE EXCEPTION 'Owner receipt requires actual erasure evidence' USING ERRCODE='23514';END IF;
 RETURN NEW;
END$$;
CREATE TRIGGER deletion_owner_receipt_admit BEFORE INSERT ON whaleu_account_deletion.owner_receipts FOR EACH ROW EXECUTE FUNCTION whaleu_account_deletion.owner_receipt_admit();
CREATE FUNCTION whaleu_account_deletion.owner_cause_admit() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF NEW.mutation_transaction<>pg_current_xact_id() OR NEW.owner NOT IN('identity','profile','timetable','legacy-follow','native-baseline','unsupported-inventory','media')
 OR NOT EXISTS(SELECT 1 FROM whaleu_account_deletion.requests r JOIN whaleu_identity.accounts a ON a.id=r.account_id
  WHERE r.id=NEW.request_id AND r.generation=NEW.generation AND r.phase IN('erasing','waiting')
    AND a.lifecycle='erasing' AND a.deletion_request_id=r.id AND a.lifecycle_generation=r.generation)
 THEN RAISE EXCEPTION 'Owner cause requires exact current erasure generation' USING ERRCODE='23514';END IF;RETURN NEW;
END$$;
CREATE TRIGGER deletion_owner_cause_admit BEFORE INSERT ON whaleu_account_deletion.owner_causes FOR EACH ROW EXECUTE FUNCTION whaleu_account_deletion.owner_cause_admit();
CREATE FUNCTION whaleu_account_deletion.reregistration_guard_admit() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF NOT EXISTS(SELECT 1 FROM whaleu_account_deletion.requests r JOIN whaleu_account_deletion.fixture_accounts f ON f.account_id=r.account_id JOIN whaleu_account_deletion.sandboxes s ON s.id=f.sandbox_id
  WHERE r.id=NEW.request_id AND NEW.identity_digest=f.identity_digest AND NEW.completed_at=s.now_at AND NEW.reregister_after=s.now_at+interval '2592000 seconds'
    AND whaleu_account_deletion.owner_cause(r.account_id,'identity')
    AND NOT EXISTS(SELECT 1 FROM whaleu_identity.provider_identities WHERE account_id=r.account_id)
    AND NOT EXISTS(SELECT 1 FROM whaleu_identity.sessions WHERE account_id=r.account_id))
 THEN RAISE EXCEPTION 'Registration guard requires completed identity cleanup' USING ERRCODE='23514';END IF;RETURN NEW;
END$$;
CREATE TRIGGER deletion_reregistration_guard_admit BEFORE INSERT ON whaleu_account_deletion.reregistration_guards FOR EACH ROW EXECUTE FUNCTION whaleu_account_deletion.reregistration_guard_admit();
CREATE FUNCTION whaleu_account_deletion.finalize_guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF NEW.phase<>'completed' THEN RETURN NEW;END IF;
 IF NOT whaleu_account_deletion.owner_cause(NEW.account_id,'identity')
 OR NOT whaleu_account_deletion.baseline_current(NEW.account_id)
 OR NOT whaleu_account_deletion.inventory_current(NEW.id)
 OR NOT whaleu_account_deletion.media_complete(NEW.id)
 OR NOT EXISTS(SELECT 1 FROM whaleu_account_deletion.reregistration_guards g JOIN whaleu_account_deletion.fixture_accounts f ON f.account_id=NEW.account_id WHERE g.request_id=NEW.id AND g.identity_digest=f.identity_digest AND g.completed_at=NEW.completed_at AND g.reregister_after=NEW.reregister_after AND g.key_version='synthetic-explicit-key-v1')
 THEN RAISE EXCEPTION 'Verified final deletion evidence is incomplete' USING ERRCODE='23514';END IF;
 RETURN NEW;
END$$;
CREATE TRIGGER deletion_finalization_guard BEFORE UPDATE ON whaleu_account_deletion.requests FOR EACH ROW EXECUTE FUNCTION whaleu_account_deletion.finalize_guard();

-- Exact physical redaction of Profile's historical private patch and full old
-- row. The old fingerprints remain ORIGINAL evidence, not a digest of the new
-- erased representation. This explicit tagged one-way cause versions that fact.
ALTER TABLE whaleu_profile.self_edit_causes ADD COLUMN erased_by_request_id uuid REFERENCES whaleu_account_deletion.requests(id);
DROP TRIGGER self_edit_immutable ON whaleu_profile.self_edit_causes;
CREATE TRIGGER self_edit_no_truncate BEFORE TRUNCATE ON whaleu_profile.self_edit_causes FOR EACH STATEMENT EXECUTE FUNCTION whaleu_profile.moderation_immutable();
CREATE FUNCTION whaleu_profile.self_edit_erasure_guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF TG_OP<>'UPDATE' OR OLD.erased_by_request_id IS NOT NULL OR NEW.erased_by_request_id IS NULL
 OR NOT whaleu_account_deletion.owner_cause(OLD.actor_id,'profile')
 OR NOT EXISTS(SELECT 1 FROM whaleu_account_deletion.requests r
   JOIN whaleu_account_deletion.owner_causes c ON c.request_id=r.id AND c.owner='profile'
   JOIN whaleu_identity.accounts a ON a.id=r.account_id
   WHERE r.id=NEW.erased_by_request_id AND r.account_id=OLD.actor_id
     AND r.phase IN('erasing','waiting') AND a.lifecycle='erasing'
     AND a.deletion_request_id=r.id AND a.lifecycle_generation=r.generation
     AND c.generation=r.generation AND c.mutation_transaction=pg_current_xact_id())
 OR NEW.patch<>'{}'::jsonb OR NEW.before_row<>'{}'::jsonb OR NEW.token_hash<>repeat('0',64)
 OR (to_jsonb(OLD)-ARRAY['patch','before_row','token_hash','erased_by_request_id']) IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['patch','before_row','token_hash','erased_by_request_id'])
 THEN RAISE EXCEPTION 'Profile history permits only exact causal payload erasure' USING ERRCODE='23514';END IF;RETURN NEW;
END$$;
CREATE TRIGGER self_edit_immutable BEFORE UPDATE OR DELETE ON whaleu_profile.self_edit_causes FOR EACH ROW EXECUTE FUNCTION whaleu_profile.self_edit_erasure_guard();
CREATE FUNCTION whaleu_profile.self_edit_erasure_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF NEW.erased_by_request_id IS NOT NULL THEN RAISE EXCEPTION 'New Profile commands cannot fabricate erasure evidence' USING ERRCODE='23514';END IF;RETURN NEW;
END$$;
CREATE TRIGGER self_edit_erasure_insert_guard BEFORE INSERT ON whaleu_profile.self_edit_causes FOR EACH ROW EXECUTE FUNCTION whaleu_profile.self_edit_erasure_insert_guard();

-- The synthetic binary store is deliberately process-local, but its identity is
-- durable. Losing/replacing it is an unknown effect, not an empty-store proof.
CREATE TABLE whaleu_account_deletion.fixture_media_cohorts (
 account_id uuid PRIMARY KEY REFERENCES whaleu_account_deletion.fixture_accounts(account_id),
 cohort_id uuid NOT NULL,creation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id()
);
CREATE FUNCTION whaleu_account_deletion.fixture_media_admit() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF current_database()<>'whaleu_test' OR NEW.creation_transaction<>pg_current_xact_id()
 OR NOT EXISTS(SELECT 1 FROM whaleu_account_deletion.fixture_accounts f JOIN whaleu_identity.accounts a ON a.id=f.account_id
 WHERE f.account_id=NEW.account_id AND f.creation_transaction=pg_current_xact_id() AND a.lifecycle='active')
 THEN RAISE EXCEPTION 'Synthetic media cohort must be enrolled with its new fixture' USING ERRCODE='23514';END IF;RETURN NEW;
END$$;
CREATE TRIGGER deletion_fixture_media_admit BEFORE INSERT ON whaleu_account_deletion.fixture_media_cohorts FOR EACH ROW EXECUTE FUNCTION whaleu_account_deletion.fixture_media_admit();
CREATE TRIGGER deletion_fixture_media_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON whaleu_account_deletion.fixture_media_cohorts FOR EACH STATEMENT EXECUTE FUNCTION whaleu_account_deletion.immutable();
CREATE TABLE whaleu_account_deletion.media_observations (
 request_id uuid NOT NULL REFERENCES whaleu_account_deletion.requests(id),cohort_id uuid NOT NULL,
 generation bigint NOT NULL,proof text NOT NULL CHECK(proof ~ '^[a-f0-9]{64}$'),
 mutation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),PRIMARY KEY(request_id,mutation_transaction)
);
CREATE FUNCTION whaleu_account_deletion.media_observation_admit() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF NEW.mutation_transaction<>pg_current_xact_id()
 OR NOT EXISTS(SELECT 1 FROM whaleu_account_deletion.requests r JOIN whaleu_account_deletion.fixture_media_cohorts m ON m.account_id=r.account_id
 WHERE r.id=NEW.request_id AND r.generation=NEW.generation AND m.cohort_id=NEW.cohort_id
 AND (whaleu_account_deletion.owner_cause(r.account_id,'media') OR whaleu_account_deletion.owner_cause(r.account_id,'identity')))
 THEN RAISE EXCEPTION 'Exact synthetic media cohort and current owner cause required' USING ERRCODE='23514';END IF;RETURN NEW;
END$$;
CREATE TRIGGER deletion_media_observation_admit BEFORE INSERT ON whaleu_account_deletion.media_observations FOR EACH ROW EXECUTE FUNCTION whaleu_account_deletion.media_observation_admit();
CREATE TRIGGER deletion_media_observation_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON whaleu_account_deletion.media_observations FOR EACH STATEMENT EXECUTE FUNCTION whaleu_account_deletion.immutable();
CREATE FUNCTION whaleu_account_deletion.media_complete(request uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM whaleu_account_deletion.requests r
 JOIN whaleu_account_deletion.fixture_media_cohorts c ON c.account_id=r.account_id
 JOIN whaleu_account_deletion.media_observations m ON m.request_id=r.id AND m.cohort_id=c.cohort_id AND m.generation=r.generation
 WHERE r.id=request AND m.mutation_transaction=pg_current_xact_id()
 AND (whaleu_account_deletion.owner_cause(r.account_id,'media') OR whaleu_account_deletion.owner_cause(r.account_id,'identity')))
$$;
REVOKE ALL ON whaleu_account_deletion.fixture_media_cohorts,whaleu_account_deletion.media_observations FROM PUBLIC;
