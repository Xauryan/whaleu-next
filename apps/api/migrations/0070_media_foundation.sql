-- Shared Media S0: empty, private-by-default state only. No provider, issuer,
-- account grants, retention policy, production activation or historical import.
-- SQL has not been executed as part of the static implementation pass.
SET LOCAL lock_timeout='5s';
SELECT pg_advisory_xact_lock(hashtextextended('whaleu:named-block-policy:v1',0));
CREATE SCHEMA whaleu_media;
CREATE DOMAIN whaleu_media.digest AS text CHECK(VALUE ~ '^[a-f0-9]{64}$');
CREATE DOMAIN whaleu_media.label AS text CHECK(length(btrim(VALUE)) BETWEEN 1 AND 200);
CREATE DOMAIN whaleu_media.audience AS text CHECK(VALUE IN ('content-gated','participant-private','conversation-private'));

CREATE TABLE whaleu_media.upload_intents (
 id uuid PRIMARY KEY,
 actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
 client_request_id uuid NOT NULL,
 canonical_intent_hash whaleu_media.digest NOT NULL,
 purpose whaleu_media.label NOT NULL,
 audience whaleu_media.audience NOT NULL,
 owner_kind whaleu_media.label NOT NULL,
 resource_kind whaleu_media.label NOT NULL,
 -- Draft identity is server-derived owner scope, not an unverified client ID.
 target_kind text NOT NULL CHECK(target_kind IN ('draft','parent')),
 resource_id uuid NOT NULL,
 content_version bigint NOT NULL CHECK(content_version>0),
 scope_revision whaleu_media.label NOT NULL,
 slot whaleu_media.label NOT NULL,
 ordinal integer NOT NULL CHECK(ordinal BETWEEN 0 AND 8),
 policy_revision whaleu_media.label NOT NULL,
 declared_bytes bigint NOT NULL CHECK(declared_bytes BETWEEN 1 AND 5242880),
 declared_mime text NOT NULL CHECK(declared_mime IN ('image/jpeg','image/png')),
 state text NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','upload_observed','sealing','processing','awaiting_review','ready','rejected','cancelled','expired','cleanup_pending','deleting','deleted')),
 generation bigint NOT NULL DEFAULT 1 CHECK(generation>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(created_at)),
 expires_at timestamptz NOT NULL CHECK(isfinite(expires_at) AND expires_at>created_at),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(updated_at)),
 UNIQUE(actor_id,client_request_id), UNIQUE(id,actor_id)
);
CREATE INDEX media_intent_actor_active ON whaleu_media.upload_intents(actor_id,expires_at) WHERE state IN ('prepared','upload_observed','sealing','processing','awaiting_review');
CREATE TABLE whaleu_media.quota_reservations (
 intent_id uuid PRIMARY KEY,
 actor_id uuid NOT NULL,
 window_start date NOT NULL,
 reserved_bytes bigint NOT NULL CHECK(reserved_bytes BETWEEN 1 AND 5242880),
 observed_bytes bigint CHECK(observed_bytes BETWEEN 0 AND 5242880),
 released_at timestamptz CHECK(isfinite(released_at)),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(created_at)),
 FOREIGN KEY(intent_id,actor_id) REFERENCES whaleu_media.upload_intents(id,actor_id)
);
CREATE INDEX media_quota_window ON whaleu_media.quota_reservations(actor_id,window_start);
CREATE TABLE whaleu_media.object_attempts (
 id uuid PRIMARY KEY, intent_id uuid NOT NULL REFERENCES whaleu_media.upload_intents(id),
 generation bigint NOT NULL CHECK(generation>0), effect_key whaleu_media.label NOT NULL UNIQUE,
 provider whaleu_media.label NOT NULL, environment whaleu_media.label NOT NULL,
 staging_bucket whaleu_media.label NOT NULL,
 staging_key text NOT NULL CHECK(length(staging_key) BETWEEN 1 AND 1024),
 source_version text CHECK(length(source_version) BETWEEN 1 AND 1024),
 sealed_bucket whaleu_media.label NOT NULL,
 sealed_key text NOT NULL CHECK(length(sealed_key) BETWEEN 1 AND 1024),
 sealed_version text CHECK(length(sealed_version) BETWEEN 1 AND 1024),
 state text NOT NULL CHECK(state IN ('planned','observed','sealed','failed','cleanup_pending','deleted')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(created_at)),
 UNIQUE(intent_id,generation), UNIQUE(id,intent_id),
 UNIQUE(provider,environment,staging_bucket,staging_key),
 UNIQUE(provider,environment,sealed_bucket,sealed_key),
 CHECK(state<>'sealed' OR (source_version IS NOT NULL AND sealed_version IS NOT NULL))
);
CREATE TABLE whaleu_media.assets (
 id uuid PRIMARY KEY, intent_id uuid NOT NULL UNIQUE,
 actor_id uuid NOT NULL, object_attempt_id uuid NOT NULL,
 purpose whaleu_media.label NOT NULL, audience whaleu_media.audience NOT NULL,
 owner_kind whaleu_media.label NOT NULL, resource_kind whaleu_media.label NOT NULL,
 target_kind text NOT NULL CHECK(target_kind IN ('draft','parent')),
 resource_id uuid NOT NULL, content_version bigint NOT NULL CHECK(content_version>0),
 scope_revision whaleu_media.label NOT NULL, slot whaleu_media.label NOT NULL,
 ordinal integer NOT NULL CHECK(ordinal BETWEEN 0 AND 8),
 policy_revision whaleu_media.label NOT NULL,
 manifest_version integer NOT NULL CHECK(manifest_version=1),
 manifest_digest whaleu_media.digest NOT NULL,
 manifest jsonb NOT NULL CHECK(jsonb_typeof(manifest)='object'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(created_at)),
 FOREIGN KEY(intent_id,actor_id) REFERENCES whaleu_media.upload_intents(id,actor_id),
 FOREIGN KEY(object_attempt_id,intent_id) REFERENCES whaleu_media.object_attempts(id,intent_id),
 UNIQUE(id,manifest_digest)
);
CREATE TABLE whaleu_media.variants (
 asset_id uuid NOT NULL REFERENCES whaleu_media.assets(id),
 variant_name text NOT NULL CHECK(variant_name IN ('thumb-v1','display-v1')),
 provider whaleu_media.label NOT NULL, environment whaleu_media.label NOT NULL,
 bucket whaleu_media.label NOT NULL, object_key text NOT NULL CHECK(length(object_key) BETWEEN 1 AND 1024),
 object_version text NOT NULL CHECK(length(object_version) BETWEEN 1 AND 1024),
 sha256 whaleu_media.digest NOT NULL,
 actual_mime text NOT NULL CHECK(actual_mime IN ('image/jpeg','image/png')),
 width integer NOT NULL CHECK(width BETWEEN 1 AND 2048),
 height integer NOT NULL CHECK(height BETWEEN 1 AND 2048),
 bytes bigint NOT NULL CHECK(bytes BETWEEN 1 AND 5242880),
 transform_version whaleu_media.label NOT NULL,
 PRIMARY KEY(asset_id,variant_name),
 UNIQUE(provider,environment,bucket,object_key,object_version),
 CHECK(variant_name<>'thumb-v1' OR greatest(width,height)<=400)
);
CREATE TABLE whaleu_media.asset_safety_events (
 id uuid PRIMARY KEY, asset_id uuid NOT NULL REFERENCES whaleu_media.assets(id),
 revision bigint NOT NULL CHECK(revision>0),
 state text NOT NULL CHECK(state IN ('allow','held','revoked','unknown')),
 manifest_digest whaleu_media.digest NOT NULL,
 policy_revision whaleu_media.label NOT NULL,
 issuer whaleu_media.label NOT NULL, source_reference whaleu_media.label NOT NULL,
 provenance jsonb NOT NULL CHECK(jsonb_typeof(provenance)='object'),
 effective_at timestamptz NOT NULL CHECK(isfinite(effective_at)),
 valid_until timestamptz NOT NULL CHECK(isfinite(valid_until) AND valid_until>effective_at),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(created_at)),
 FOREIGN KEY(asset_id,manifest_digest) REFERENCES whaleu_media.assets(id,manifest_digest),
 UNIQUE(asset_id,revision), UNIQUE(asset_id,revision,id),
 UNIQUE(issuer,source_reference)
);
CREATE TABLE whaleu_media.asset_safety_heads (
 asset_id uuid PRIMARY KEY REFERENCES whaleu_media.assets(id),
 revision bigint NOT NULL CHECK(revision>0), event_id uuid NOT NULL,
 FOREIGN KEY(asset_id,revision,event_id) REFERENCES whaleu_media.asset_safety_events(asset_id,revision,id)
);
-- One immutable mapping consumes a server-issued draft scope into the actual
-- final parent. Business owners still own durable draft authorization and exact
-- approval. This table does not confer authority merely because evidence exists.
CREATE TABLE whaleu_media.scope_consumptions (
 actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
 owner_kind whaleu_media.label NOT NULL, resource_kind whaleu_media.label NOT NULL,
 scope_resource_id uuid NOT NULL, scope_revision whaleu_media.label NOT NULL,
 resource_id uuid NOT NULL, content_version bigint NOT NULL CHECK(content_version>0),
 attach_evidence jsonb NOT NULL CHECK(jsonb_typeof(attach_evidence)='object'),
 transaction_id xid8 NOT NULL DEFAULT pg_current_xact_id(),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(created_at)),
 PRIMARY KEY(actor_id,owner_kind,resource_kind,scope_resource_id),
 UNIQUE(owner_kind,resource_kind,resource_id,content_version)
);
CREATE TABLE whaleu_media.bindings (
 id uuid PRIMARY KEY, asset_id uuid NOT NULL UNIQUE,
 manifest_digest whaleu_media.digest NOT NULL,
 owner_kind whaleu_media.label NOT NULL, resource_kind whaleu_media.label NOT NULL,
 resource_id uuid NOT NULL, content_version bigint NOT NULL CHECK(content_version>0),
 slot whaleu_media.label NOT NULL, ordinal integer NOT NULL CHECK(ordinal BETWEEN 0 AND 8),
 attach_evidence jsonb NOT NULL CHECK(jsonb_typeof(attach_evidence)='object'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(created_at)),
 detached_at timestamptz CHECK(isfinite(detached_at) AND detached_at>=created_at),
 detach_reason whaleu_media.label,
 FOREIGN KEY(asset_id,manifest_digest) REFERENCES whaleu_media.assets(id,manifest_digest),
 UNIQUE(owner_kind,resource_kind,resource_id,content_version,slot,ordinal),
 CHECK((detached_at IS NULL)=(detach_reason IS NULL))
);
CREATE TABLE whaleu_media.jobs (
 id uuid PRIMARY KEY, kind text NOT NULL CHECK(kind IN ('seal','process','review','reconcile','cleanup')),
 effect_key whaleu_media.label NOT NULL UNIQUE,
 intent_id uuid NOT NULL REFERENCES whaleu_media.upload_intents(id),
 object_attempt_id uuid, asset_id uuid REFERENCES whaleu_media.assets(id),
 expected_generation bigint NOT NULL CHECK(expected_generation>0),
 expected_head_revision bigint CHECK(expected_head_revision>0),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','leased','retryable','succeeded','failed','cancelled')),
 lease_token uuid, lease_until timestamptz CHECK(isfinite(lease_until)),
 attempt integer NOT NULL DEFAULT 0 CHECK(attempt>=0),
 next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(next_attempt_at)),
 error_code text CHECK(error_code ~ '^[A-Z][A-Z0-9_]{0,79}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(created_at)),
 FOREIGN KEY(object_attempt_id,intent_id) REFERENCES whaleu_media.object_attempts(id,intent_id),
 CHECK((status='leased')=(lease_token IS NOT NULL AND lease_until IS NOT NULL)),
 CHECK((lease_token IS NULL)=(lease_until IS NULL))
);
CREATE INDEX media_jobs_due ON whaleu_media.jobs(next_attempt_at,id) WHERE status IN ('pending','retryable');
CREATE INDEX media_jobs_expired_lease ON whaleu_media.jobs(lease_until,id) WHERE status='leased';
CREATE TABLE whaleu_media.cleanup_obligations (
 id uuid PRIMARY KEY, effect_key whaleu_media.label NOT NULL UNIQUE,
 object_attempt_id uuid REFERENCES whaleu_media.object_attempts(id),
 asset_id uuid, variant_name text,
 provider whaleu_media.label NOT NULL, environment whaleu_media.label NOT NULL,
 bucket whaleu_media.label NOT NULL, object_key text NOT NULL CHECK(length(object_key) BETWEEN 1 AND 1024),
 object_version text NOT NULL CHECK(length(object_version) BETWEEN 1 AND 1024),
 reason whaleu_media.label NOT NULL,
 not_before timestamptz NOT NULL CHECK(isfinite(not_before)),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','deleting','retryable','deleted','retained')),
 attempt integer NOT NULL DEFAULT 0 CHECK(attempt>=0),
 lease_token uuid, lease_until timestamptz CHECK(isfinite(lease_until)),
 confirmed_deleted_at timestamptz CHECK(isfinite(confirmed_deleted_at)),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(created_at)),
 FOREIGN KEY(asset_id,variant_name) REFERENCES whaleu_media.variants(asset_id,variant_name),
 CHECK((asset_id IS NULL)=(variant_name IS NULL)),
 CONSTRAINT media_cleanup_one_source CHECK((object_attempt_id IS NOT NULL)::integer+(asset_id IS NOT NULL)::integer=1),
 CHECK((state='deleting')=(lease_token IS NOT NULL AND lease_until IS NOT NULL)),
 CHECK((lease_token IS NULL)=(lease_until IS NULL)),
 CHECK((state='deleted')=(confirmed_deleted_at IS NOT NULL)),
 UNIQUE(provider,environment,bucket,object_key,object_version)
);
CREATE INDEX media_cleanup_due ON whaleu_media.cleanup_obligations(not_before,id) WHERE state IN ('pending','retryable');

-- Identity fields never change, tombstones are retained, and terminal state is
-- not restored to ready. This is not a complete worker protocol: lease-token +
-- generation CAS and current business authority still belong in the facade.
CREATE FUNCTION whaleu_media.immutable_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Media evidence is immutable and retained' USING ERRCODE='23514'; END $$;
CREATE FUNCTION whaleu_media.guard_mutable_record() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE allowed text[];
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Media records are retained' USING ERRCODE='23514'; END IF;
 allowed := string_to_array(TG_ARGV[0],',');
 IF (to_jsonb(NEW)-allowed) IS DISTINCT FROM (to_jsonb(OLD)-allowed) THEN
  RAISE EXCEPTION 'Media identity is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER media_intent_identity BEFORE UPDATE OR DELETE ON whaleu_media.upload_intents FOR EACH ROW EXECUTE FUNCTION whaleu_media.guard_mutable_record('state,generation,updated_at');
CREATE TRIGGER media_quota_identity BEFORE UPDATE OR DELETE ON whaleu_media.quota_reservations FOR EACH ROW EXECUTE FUNCTION whaleu_media.guard_mutable_record('observed_bytes,released_at');
CREATE TRIGGER media_attempt_identity BEFORE UPDATE OR DELETE ON whaleu_media.object_attempts FOR EACH ROW EXECUTE FUNCTION whaleu_media.guard_mutable_record('source_version,sealed_version,state');
CREATE TRIGGER media_binding_identity BEFORE UPDATE OR DELETE ON whaleu_media.bindings FOR EACH ROW EXECUTE FUNCTION whaleu_media.guard_mutable_record('detached_at,detach_reason');
CREATE TRIGGER media_job_identity BEFORE UPDATE OR DELETE ON whaleu_media.jobs FOR EACH ROW EXECUTE FUNCTION whaleu_media.guard_mutable_record('status,lease_token,lease_until,attempt,next_attempt_at,error_code');
CREATE TRIGGER media_cleanup_identity BEFORE UPDATE OR DELETE ON whaleu_media.cleanup_obligations FOR EACH ROW EXECUTE FUNCTION whaleu_media.guard_mutable_record('state,attempt,lease_token,lease_until,confirmed_deleted_at,not_before');
CREATE FUNCTION whaleu_media.guard_transitions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='upload_intents' THEN
  IF NEW.generation<OLD.generation OR NEW.generation>OLD.generation+1 OR NEW.updated_at<OLD.updated_at OR
     (NEW.generation<>OLD.generation AND OLD.state NOT IN ('prepared','upload_observed') AND NEW.state NOT IN ('cancelled','expired','cleanup_pending')) OR
     (NEW.state<>OLD.state AND NOT (
       (OLD.state='prepared' AND NEW.state IN ('upload_observed','cancelled','expired','cleanup_pending')) OR
       (OLD.state='upload_observed' AND NEW.state IN ('sealing','cancelled','expired','cleanup_pending')) OR
       (OLD.state='sealing' AND NEW.state IN ('processing','rejected','cancelled','expired','cleanup_pending')) OR
       (OLD.state='processing' AND NEW.state IN ('awaiting_review','rejected','cancelled','expired','cleanup_pending')) OR
       (OLD.state='awaiting_review' AND NEW.state IN ('ready','rejected','cancelled','expired','cleanup_pending')) OR
       (OLD.state='ready' AND NEW.state='cleanup_pending') OR
       (OLD.state IN ('rejected','cancelled','expired') AND NEW.state='cleanup_pending') OR
       (OLD.state='cleanup_pending' AND NEW.state='deleting') OR
       (OLD.state='deleting' AND NEW.state='deleted')
     )) OR
     (OLD.state IN ('rejected','cancelled','expired','cleanup_pending','deleting','deleted') AND NEW.state NOT IN (OLD.state,'cleanup_pending','deleting','deleted')) OR
     (OLD.state='deleting' AND NEW.state NOT IN ('deleting','deleted')) OR
     (OLD.state='deleted' AND NEW.state<>'deleted') THEN
   RAISE EXCEPTION 'Invalid media lifecycle transition' USING ERRCODE='23514'; END IF;
 ELSIF TG_TABLE_NAME='object_attempts' THEN
  IF (OLD.source_version IS NOT NULL AND NEW.source_version IS DISTINCT FROM OLD.source_version) OR
     (OLD.sealed_version IS NOT NULL AND NEW.sealed_version IS DISTINCT FROM OLD.sealed_version) THEN
   RAISE EXCEPTION 'Exact media object version is immutable' USING ERRCODE='23514'; END IF;
 ELSIF TG_TABLE_NAME='quota_reservations' THEN
  IF (OLD.released_at IS NOT NULL AND NEW.released_at IS DISTINCT FROM OLD.released_at) OR
     (OLD.observed_bytes IS NOT NULL AND NEW.observed_bytes IS DISTINCT FROM OLD.observed_bytes) THEN
   RAISE EXCEPTION 'Media quota settlement is immutable' USING ERRCODE='23514'; END IF;
 ELSIF TG_TABLE_NAME='bindings' THEN
  IF OLD.detached_at IS NOT NULL AND ROW(NEW.detached_at,NEW.detach_reason) IS DISTINCT FROM ROW(OLD.detached_at,OLD.detach_reason) THEN
   RAISE EXCEPTION 'Detached media cannot be reattached' USING ERRCODE='23514'; END IF;
 ELSIF TG_TABLE_NAME='cleanup_obligations' THEN
  IF NEW.attempt<OLD.attempt OR NEW.not_before<OLD.not_before OR (OLD.state='deleted' AND NEW IS DISTINCT FROM OLD) THEN
   RAISE EXCEPTION 'Confirmed media cleanup is retained' USING ERRCODE='23514'; END IF;
 ELSIF TG_TABLE_NAME='jobs' THEN
  IF NEW.attempt<OLD.attempt OR (OLD.status IN ('succeeded','cancelled') AND NEW IS DISTINCT FROM OLD) THEN
   RAISE EXCEPTION 'Terminal media job is retained' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION whaleu_media.guard_safety_head() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Media safety heads are retained' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' AND (NEW.asset_id IS DISTINCT FROM OLD.asset_id OR NEW.revision<=OLD.revision) THEN
  RAISE EXCEPTION 'Media safety revision must advance' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER media_safety_head_guard BEFORE UPDATE OR DELETE ON whaleu_media.asset_safety_heads FOR EACH ROW EXECUTE FUNCTION whaleu_media.guard_safety_head();

CREATE FUNCTION whaleu_media.asset_scope_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE i whaleu_media.upload_intents; a whaleu_media.object_attempts;
BEGIN
 SELECT * INTO STRICT i FROM whaleu_media.upload_intents WHERE id=NEW.intent_id FOR UPDATE;
 SELECT * INTO STRICT a FROM whaleu_media.object_attempts WHERE id=NEW.object_attempt_id;
 IF ROW(NEW.actor_id,NEW.purpose,NEW.audience,NEW.owner_kind,NEW.resource_kind,NEW.target_kind,NEW.resource_id,NEW.content_version,NEW.scope_revision,NEW.slot,NEW.ordinal,NEW.policy_revision)
 IS DISTINCT FROM ROW(i.actor_id,i.purpose,i.audience,i.owner_kind,i.resource_kind,i.target_kind,i.resource_id,i.content_version,i.scope_revision,i.slot,i.ordinal,i.policy_revision)
 OR a.intent_id<>i.id OR a.state<>'sealed' OR a.generation<>i.generation
 OR i.state NOT IN ('processing','awaiting_review') THEN
  RAISE EXCEPTION 'Media asset scope or sealed attempt mismatch' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER media_asset_scope BEFORE INSERT ON whaleu_media.assets FOR EACH ROW EXECUTE FUNCTION whaleu_media.asset_scope_guard();

CREATE FUNCTION whaleu_media.binding_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a whaleu_media.assets; i whaleu_media.upload_intents; c whaleu_media.scope_consumptions; approved boolean;
BEGIN
 SELECT * INTO STRICT a FROM whaleu_media.assets WHERE id=NEW.asset_id FOR UPDATE;
 SELECT * INTO STRICT i FROM whaleu_media.upload_intents WHERE id=a.intent_id FOR UPDATE;
 SELECT e.state='allow' AND e.effective_at<=clock_timestamp() AND e.valid_until>clock_timestamp()
  AND e.manifest_digest=a.manifest_digest AND e.policy_revision=a.policy_revision
 INTO approved FROM whaleu_media.asset_safety_heads h
 JOIN whaleu_media.asset_safety_events e ON (e.asset_id,e.revision,e.id)=(h.asset_id,h.revision,h.event_id)
 WHERE h.asset_id=a.id;
 IF i.state<>'ready' OR approved IS DISTINCT FROM true OR
 ROW(NEW.owner_kind,NEW.resource_kind,NEW.content_version,NEW.slot,NEW.ordinal,NEW.manifest_digest)
 IS DISTINCT FROM ROW(a.owner_kind,a.resource_kind,a.content_version,a.slot,a.ordinal,a.manifest_digest)
 OR NEW.detached_at IS NOT NULL THEN
  RAISE EXCEPTION 'Media binding requires exact currently allowed ready asset' USING ERRCODE='23514'; END IF;
 IF a.target_kind='parent' THEN
  IF NEW.resource_id<>a.resource_id THEN
   RAISE EXCEPTION 'Media parent target mismatch' USING ERRCODE='23514'; END IF;
 ELSE
  SELECT * INTO c FROM whaleu_media.scope_consumptions WHERE actor_id=a.actor_id
   AND owner_kind=a.owner_kind AND resource_kind=a.resource_kind AND scope_resource_id=a.resource_id;
  IF NOT FOUND OR c.scope_revision<>a.scope_revision OR c.resource_id<>NEW.resource_id
   OR c.content_version<>NEW.content_version OR c.transaction_id<>pg_current_xact_id() THEN
   RAISE EXCEPTION 'Media draft must be consumed by this exact publication transaction' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER media_binding_guard BEFORE INSERT ON whaleu_media.bindings FOR EACH ROW EXECUTE FUNCTION whaleu_media.binding_guard();

-- A commit cannot expose half of the required immutable derivative set. The
-- function is extended below with exact canonical manifest integrity; neither
-- SQL checks nor hashes prove decoding/provider/Review observations occurred.
CREATE FUNCTION whaleu_media.complete_asset() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid; n integer;
BEGIN
 IF TG_TABLE_NAME='assets' THEN target:=NEW.id; ELSE target:=NEW.asset_id; END IF;
 SELECT count(*) INTO n FROM whaleu_media.variants WHERE asset_id=target;
 IF n<>2 THEN RAISE EXCEPTION 'Media requires both immutable variants' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER media_asset_complete AFTER INSERT ON whaleu_media.assets DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_media.complete_asset();
CREATE CONSTRAINT TRIGGER media_variant_complete AFTER INSERT ON whaleu_media.variants DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_media.complete_asset();
CREATE FUNCTION whaleu_media.ready_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE approved boolean;
BEGIN
 IF NEW.state='ready' THEN
  SELECT e.state='allow' AND e.effective_at<=clock_timestamp() AND e.valid_until>clock_timestamp()
    AND e.policy_revision=a.policy_revision AND e.manifest_digest=a.manifest_digest
  INTO approved FROM whaleu_media.assets a
  JOIN whaleu_media.asset_safety_heads h ON h.asset_id=a.id
  JOIN whaleu_media.asset_safety_events e ON (e.asset_id,e.revision,e.id)=(h.asset_id,h.revision,h.event_id)
  WHERE a.intent_id=NEW.id;
  IF approved IS DISTINCT FROM true THEN
   RAISE EXCEPTION 'Media ready requires current asset approval' USING ERRCODE='23514'; END IF;
 END IF;
 IF NEW.state IN ('deleting','deleted') AND EXISTS(
  SELECT 1 FROM whaleu_media.assets a JOIN whaleu_media.bindings b ON b.asset_id=a.id
  WHERE a.intent_id=NEW.id AND b.detached_at IS NULL
 ) THEN RAISE EXCEPTION 'Attached media cannot be deleted' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER media_ready_guard BEFORE INSERT OR UPDATE ON whaleu_media.upload_intents FOR EACH ROW EXECUTE FUNCTION whaleu_media.ready_guard();

-- Fixed metadata compatible with requiredOwnerEpoch. No read-time head repair.
-- Advisory namespace 1464356110 is reserved for Media, gate slot 128. Every
-- source statement including raw fixture writers advances a slot. On servers
-- beyond the bounded writer capacity, requiredOwnerEpoch refuses enrollment.
CREATE TABLE whaleu_media.media_owner_states (
 slot integer PRIMARY KEY CHECK(slot BETWEEN 0 AND 127),
 version integer NOT NULL CHECK(version=1), epoch bigint NOT NULL CHECK(epoch>=0)
);
INSERT INTO whaleu_media.media_owner_states SELECT slot,1,0 FROM generate_series(0,127) slot;
CREATE FUNCTION whaleu_media.guard_owner_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'UPDATE' THEN RAISE EXCEPTION 'Media owner epochs are retained' USING ERRCODE='23514'; END IF;
 IF pg_trigger_depth()<2 OR NEW.slot IS DISTINCT FROM OLD.slot OR NEW.version IS DISTINCT FROM OLD.version OR
 OLD.epoch=9223372036854775807 OR NEW.epoch IS DISTINCT FROM OLD.epoch+1 THEN
  RAISE EXCEPTION 'Media owner epoch must advance from source mutation' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER media_owner_epoch_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_media.media_owner_states FOR EACH ROW EXECUTE FUNCTION whaleu_media.guard_owner_epoch();
CREATE TRIGGER media_owner_epoch_retain BEFORE TRUNCATE ON whaleu_media.media_owner_states FOR EACH STATEMENT EXECUTE FUNCTION whaleu_media.guard_owner_epoch();
CREATE FUNCTION whaleu_media.advance_owner_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE chosen integer; first_slot integer; candidate integer; step integer;
BEGIN
 IF current_setting('max_connections')::integer+current_setting('max_prepared_transactions')::integer+
    current_setting('max_worker_processes')::integer+current_setting('max_wal_senders')::integer>=128 THEN RETURN NULL; END IF;
 SELECT objid::integer INTO chosen FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid() AND granted
 AND mode='ExclusiveLock' AND classid=1464356110::oid AND objsubid=2 AND objid BETWEEN 0::oid AND 127::oid ORDER BY objid LIMIT 1;
 first_slot:=mod(pg_current_xact_id()::text::numeric,128)::integer;
 IF chosen IS NULL THEN
  FOR step IN 0..127 LOOP
   candidate:=mod(first_slot+step,128);
   IF pg_try_advisory_xact_lock(1464356110,candidate) THEN chosen:=candidate; EXIT; END IF;
  END LOOP;
 END IF;
 IF chosen IS NOT NULL THEN
  IF NOT pg_try_advisory_xact_lock(1464356110,chosen) THEN chosen:=NULL; END IF;
 END IF;
 IF chosen IS NULL THEN
  PERFORM pg_advisory_xact_lock_shared(1464356110,128);
  FOR step IN 0..127 LOOP
   candidate:=mod(first_slot+step,128);
   IF pg_try_advisory_xact_lock(1464356110,candidate) THEN chosen:=candidate; EXIT; END IF;
  END LOOP;
  IF chosen IS NULL THEN RAISE EXCEPTION 'Media owner fences inconsistent' USING ERRCODE='55P03'; END IF;
 END IF;
 PERFORM 1 FROM whaleu_media.media_owner_states WHERE slot=chosen FOR UPDATE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'Media owner epoch absent' USING ERRCODE='23514'; END IF;
 UPDATE whaleu_media.media_owner_states SET epoch=epoch+1 WHERE slot=chosen;
 RETURN NULL;
END $$;

-- Application lock order remains Safety policy gate, business parent ancestors,
-- then Media assets in UUID order. Workers never call back into business owners.
-- Multi-statement maintenance must acquire the same outer policy gate first.
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['upload_intents','quota_reservations','object_attempts','assets','variants','asset_safety_events','asset_safety_heads','scope_consumptions','bindings','jobs','cleanup_obligations'] LOOP
  EXECUTE format('CREATE TRIGGER a0_media_policy_gate BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_media.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.content_policy_writer_gate()',t);
  EXECUTE format('CREATE TRIGGER a1_media_owner_epoch BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_media.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_media.advance_owner_epoch()',t);
  EXECUTE format('CREATE TRIGGER media_retain BEFORE TRUNCATE ON whaleu_media.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_media.immutable_record()',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['assets','variants','asset_safety_events','scope_consumptions'] LOOP
  EXECUTE format('CREATE TRIGGER media_immutable BEFORE UPDATE OR DELETE ON whaleu_media.%I FOR EACH ROW EXECUTE FUNCTION whaleu_media.immutable_record()',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['upload_intents','quota_reservations','object_attempts','bindings','jobs','cleanup_obligations'] LOOP
  EXECUTE format('CREATE TRIGGER media_transition BEFORE UPDATE ON whaleu_media.%I FOR EACH ROW EXECUTE FUNCTION whaleu_media.guard_transitions()',t);
 END LOOP;
END $$;
CREATE FUNCTION whaleu_media.try_owner_fence() RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE s integer;
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' OR
    current_setting('max_connections')::integer+current_setting('max_prepared_transactions')::integer+
    current_setting('max_worker_processes')::integer+current_setting('max_wal_senders')::integer>=128 THEN RETURN false; END IF;
 IF NOT pg_try_advisory_xact_lock(1464356110,128) THEN RETURN false; END IF;
 FOR s IN 0..127 LOOP
  IF NOT pg_try_advisory_xact_lock_shared(1464356110,s) THEN RETURN false; END IF;
 END LOOP;
 LOCK TABLE whaleu_media.upload_intents,whaleu_media.quota_reservations,whaleu_media.object_attempts,
  whaleu_media.assets,whaleu_media.variants,whaleu_media.asset_safety_events,whaleu_media.asset_safety_heads,
  whaleu_media.scope_consumptions,whaleu_media.bindings,whaleu_media.jobs,whaleu_media.cleanup_obligations IN SHARE MODE NOWAIT;
 RETURN true;
EXCEPTION WHEN lock_not_available THEN RETURN false;
END $$;

-- Compact recursively sorted JSON for the deliberately narrow v1 manifest.
-- Numbers in accepted manifests are positive bounded integers. Non-ASCII
-- sorting is irrelevant to the fixed ASCII schema keys. Scalars use PostgreSQL
-- JSON escaping; compatibility with the TS encoder still requires fixture tests.
CREATE FUNCTION whaleu_media.canonical_json(value jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE encoded text;
BEGIN
 CASE jsonb_typeof(value)
 WHEN 'object' THEN
  SELECT '{'||coalesce(string_agg(to_jsonb(key)::text||':'||whaleu_media.canonical_json(val),',' ORDER BY key COLLATE "C"),'')||'}'
  INTO encoded FROM jsonb_each(value) AS entries(key,val);
 WHEN 'array' THEN
  SELECT '['||coalesce(string_agg(whaleu_media.canonical_json(val),',' ORDER BY position),'')||']'
  INTO encoded FROM jsonb_array_elements(value) WITH ORDINALITY AS entries(val,position);
 ELSE encoded:=value::text;
 END CASE;
 RETURN encoded;
END $$;
CREATE OR REPLACE FUNCTION whaleu_media.complete_asset() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid; a whaleu_media.assets; attempt whaleu_media.object_attempts;
 original jsonb; expected_variants jsonb; original_object jsonb;
 original_width integer; original_height integer; original_bytes bigint;
BEGIN
 IF TG_TABLE_NAME='assets' THEN target:=NEW.id; ELSE target:=NEW.asset_id; END IF;
 SELECT * INTO STRICT a FROM whaleu_media.assets WHERE id=target;
 SELECT * INTO STRICT attempt FROM whaleu_media.object_attempts WHERE id=a.object_attempt_id;
 IF (SELECT count(*) FROM whaleu_media.variants WHERE asset_id=target)<>2 THEN
  RAISE EXCEPTION 'Media requires both immutable variants' USING ERRCODE='23514'; END IF;
 original:=a.manifest->'original';
 original_width:=(original->>'width')::integer; original_height:=(original->>'height')::integer;
 original_bytes:=(original->>'bytes')::bigint;
 original_object:=jsonb_build_object('provider',attempt.provider,'environment',attempt.environment,
  'bucket',attempt.sealed_bucket,'key',attempt.sealed_key,'version',attempt.sealed_version);
 IF original_width NOT BETWEEN 1 AND 8192 OR original_height NOT BETWEEN 1 AND 8192 OR
    original_width::bigint*original_height>24000000 OR original_bytes NOT BETWEEN 1 AND 5242880 OR
    (original->>'sha256') !~ '^[a-f0-9]{64}$' OR (original->>'mime') NOT IN ('image/jpeg','image/png') OR
    original IS DISTINCT FROM jsonb_build_object('object',original_object,'sha256',original->>'sha256',
     'mime',original->>'mime','bytes',original_bytes,'width',original_width,'height',original_height) OR
    original_width IS NULL OR original_height IS NULL OR original_bytes IS NULL OR
    original->>'sha256' IS NULL OR original->>'mime' IS NULL THEN
  RAISE EXCEPTION 'Invalid sealed Media original manifest' USING ERRCODE='23514'; END IF;
 SELECT jsonb_agg(jsonb_build_object('name',variant_name,'object',jsonb_build_object('provider',provider,
  'environment',environment,'bucket',bucket,'key',object_key,'version',object_version),
  'sha256',sha256,'mime',actual_mime,'bytes',bytes,'width',width,'height',height)
  ORDER BY CASE variant_name WHEN 'thumb-v1' THEN 0 ELSE 1 END)
 INTO expected_variants FROM whaleu_media.variants WHERE asset_id=target;
 IF EXISTS(SELECT 1 FROM whaleu_media.variants v WHERE v.asset_id=target AND
   (v.provider<>attempt.provider OR v.environment<>attempt.environment OR v.actual_mime<>original->>'mime'
    OR v.transform_version<>'static-reencode-v1'
    OR greatest(v.width,v.height)>greatest(original_width,original_height)
    OR v.width::bigint*v.height>original_width::bigint*original_height
    OR ROW(v.bucket,v.object_key,v.object_version)=ROW(attempt.sealed_bucket,attempt.sealed_key,attempt.sealed_version)))
 OR a.policy_revision<>'media-static-v1'
 OR a.manifest IS DISTINCT FROM jsonb_build_object('version',1,'policyVersion','media-static-v1',
   'transformVersion','static-reencode-v1','original',original,'variants',expected_variants)
 OR a.manifest_digest<>encode(sha256(convert_to(E'whaleu-media-manifest:v1\n'||whaleu_media.canonical_json(a.manifest),'UTF8')),'hex') THEN
  RAISE EXCEPTION 'Media manifest, digest or exact variants mismatch' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;

ALTER TABLE whaleu_media.assets ADD CONSTRAINT media_asset_intent_identity UNIQUE(id,intent_id);
ALTER TABLE whaleu_media.jobs ADD CONSTRAINT media_job_asset_intent FOREIGN KEY(asset_id,intent_id) REFERENCES whaleu_media.assets(id,intent_id);
CREATE FUNCTION whaleu_media.quota_consistent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid; i whaleu_media.upload_intents; q whaleu_media.quota_reservations;
BEGIN
 IF TG_TABLE_NAME='upload_intents' THEN target:=NEW.id; ELSE target:=NEW.intent_id; END IF;
 SELECT * INTO STRICT i FROM whaleu_media.upload_intents WHERE id=target;
 SELECT * INTO q FROM whaleu_media.quota_reservations WHERE intent_id=target;
 IF NOT FOUND OR q.reserved_bytes<>i.declared_bytes OR q.actor_id<>i.actor_id THEN
  RAISE EXCEPTION 'Media intent requires its exact quota reservation' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER media_intent_quota AFTER INSERT ON whaleu_media.upload_intents DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_media.quota_consistent();
CREATE CONSTRAINT TRIGGER media_quota_intent AFTER INSERT ON whaleu_media.quota_reservations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_media.quota_consistent();
CREATE FUNCTION whaleu_media.cleanup_exact_object() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a whaleu_media.object_attempts; v whaleu_media.variants;
BEGIN
 IF NEW.object_attempt_id IS NOT NULL THEN
  SELECT * INTO STRICT a FROM whaleu_media.object_attempts WHERE id=NEW.object_attempt_id;
  IF ROW(NEW.provider,NEW.environment) IS DISTINCT FROM ROW(a.provider,a.environment) OR
   (ROW(NEW.bucket,NEW.object_key,NEW.object_version) IS DISTINCT FROM ROW(a.staging_bucket,a.staging_key,a.source_version)
    AND ROW(NEW.bucket,NEW.object_key,NEW.object_version) IS DISTINCT FROM ROW(a.sealed_bucket,a.sealed_key,a.sealed_version)) THEN
   RAISE EXCEPTION 'Cleanup must target an observed exact attempt version' USING ERRCODE='23514'; END IF;
 ELSE
  SELECT * INTO STRICT v FROM whaleu_media.variants WHERE asset_id=NEW.asset_id AND variant_name=NEW.variant_name;
  IF ROW(NEW.provider,NEW.environment,NEW.bucket,NEW.object_key,NEW.object_version)
   IS DISTINCT FROM ROW(v.provider,v.environment,v.bucket,v.object_key,v.object_version) THEN
   RAISE EXCEPTION 'Cleanup must target its immutable variant' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER media_cleanup_exact BEFORE INSERT ON whaleu_media.cleanup_obligations FOR EACH ROW EXECUTE FUNCTION whaleu_media.cleanup_exact_object();

CREATE FUNCTION whaleu_media.scope_consumption_transaction() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.transaction_id<>pg_current_xact_id() THEN
  RAISE EXCEPTION 'Media scope consumption transaction mismatch' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER media_scope_consumption_transaction BEFORE INSERT ON whaleu_media.scope_consumptions FOR EACH ROW EXECUTE FUNCTION whaleu_media.scope_consumption_transaction();
CREATE FUNCTION whaleu_media.scope_consumption_complete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM whaleu_media.assets a JOIN whaleu_media.bindings b ON b.asset_id=a.id
  WHERE a.actor_id=NEW.actor_id AND a.owner_kind=NEW.owner_kind AND a.resource_kind=NEW.resource_kind
   AND a.target_kind='draft' AND a.resource_id=NEW.scope_resource_id AND a.scope_revision=NEW.scope_revision
   AND b.owner_kind=NEW.owner_kind AND b.resource_kind=NEW.resource_kind AND b.resource_id=NEW.resource_id
   AND b.content_version=NEW.content_version AND b.detached_at IS NULL) THEN
  RAISE EXCEPTION 'Media draft consumption requires an atomic exact binding' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER media_scope_consumption_complete AFTER INSERT ON whaleu_media.scope_consumptions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_media.scope_consumption_complete();
