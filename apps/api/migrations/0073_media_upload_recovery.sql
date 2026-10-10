-- Additive v2 original-actor receipts and exact multipart writer protocol.
-- No provider/issuer activation, token persistence, or legacy digest backfill.
SET LOCAL lock_timeout='5s';
SELECT pg_advisory_xact_lock(hashtextextended('whaleu:named-block-policy:v1',0));
ALTER TABLE whaleu_media.upload_intents
 ADD COLUMN protocol_version integer NOT NULL DEFAULT 1,
 ADD COLUMN request_hash whaleu_media.digest,
 ADD COLUMN declared_sha256 whaleu_media.digest,
 ADD CONSTRAINT media_protocol_identity CHECK(
   (protocol_version=1 AND request_hash IS NULL AND declared_sha256 IS NULL) OR
   (protocol_version=2 AND request_hash IS NOT NULL AND declared_sha256 IS NOT NULL));
CREATE TABLE whaleu_media.upload_request_fences (
 actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
 client_request_id uuid NOT NULL,
 request_hash whaleu_media.digest NOT NULL,
 intent_id uuid UNIQUE,
 state text NOT NULL CHECK(state IN ('active','cancelled_before_prepare','terminal')),
 terminal_reason text CHECK(terminal_reason IN ('cancelled','expired','rejected','deleted')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(created_at)),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(updated_at)),
 PRIMARY KEY(actor_id,client_request_id),
 FOREIGN KEY(intent_id,actor_id) REFERENCES whaleu_media.upload_intents(id,actor_id),
 CHECK((state='active' AND intent_id IS NOT NULL AND terminal_reason IS NULL) OR
       (state='cancelled_before_prepare' AND intent_id IS NULL AND terminal_reason='cancelled') OR
       (state='terminal' AND intent_id IS NOT NULL AND terminal_reason IS NOT NULL))
);
CREATE INDEX media_request_fence_budget ON whaleu_media.upload_request_fences(actor_id,created_at);
CREATE TABLE whaleu_media.upload_ingress (
 object_attempt_id uuid PRIMARY KEY,
 intent_id uuid NOT NULL,
 generation bigint NOT NULL CHECK(generation>0),
 grant_id uuid NOT NULL UNIQUE,
 grant_session_id uuid NOT NULL REFERENCES whaleu_identity.sessions(id),
 grant_expires_at timestamptz NOT NULL CHECK(isfinite(grant_expires_at)),
 writer_token uuid,
 writer_instance_id uuid,
 writer_deadline timestamptz CHECK(isfinite(writer_deadline)),
 writer_state text NOT NULL DEFAULT 'idle' CHECK(writer_state IN ('idle','writing','observed','retiring','retired','unknown')),
 transfer_attempt_count integer NOT NULL DEFAULT 0 CHECK(transfer_attempt_count BETWEEN 0 AND 5),
 observed_bytes bigint CHECK(observed_bytes BETWEEN 1 AND 5242880),
 observed_sha256 whaleu_media.digest,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(created_at)),
 UNIQUE(intent_id,generation),
 FOREIGN KEY(object_attempt_id,intent_id) REFERENCES whaleu_media.object_attempts(id,intent_id),
 CHECK((writer_token IS NULL)=(writer_instance_id IS NULL)),
 CHECK((writer_token IS NULL)=(writer_deadline IS NULL)),
 CHECK(writer_state='idle' OR writer_token IS NOT NULL),
 CHECK((observed_bytes IS NULL)=(observed_sha256 IS NULL)),
 CHECK((writer_state='observed')=(observed_bytes IS NOT NULL))
);
-- Per-transfer retained exact scratch identity. Never overwrite an older writer
-- row when issuing another grant; process death must leave a recoverable target.
CREATE TABLE whaleu_media.upload_ingress_writers (
 writer_token uuid PRIMARY KEY,
 object_attempt_id uuid NOT NULL REFERENCES whaleu_media.upload_ingress(object_attempt_id),
 writer_instance_id uuid NOT NULL,
 provider whaleu_media.label NOT NULL, environment whaleu_media.label NOT NULL,
 bucket whaleu_media.label NOT NULL,
 object_key text NOT NULL CHECK(length(object_key) BETWEEN 1 AND 1024),
 object_version text NOT NULL CHECK(length(object_version) BETWEEN 1 AND 1024),
 state text NOT NULL DEFAULT 'writing' CHECK(state IN ('writing','retired','unknown')),
 transferred_bytes bigint NOT NULL DEFAULT 0 CHECK(transferred_bytes BETWEEN 0 AND 5373952),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(created_at)),
 UNIQUE(provider,environment,bucket,object_key,object_version)
);
ALTER TABLE whaleu_media.cleanup_obligations ADD COLUMN ingress_writer_id uuid REFERENCES whaleu_media.upload_ingress_writers(writer_token);
ALTER TABLE whaleu_media.cleanup_obligations DROP CONSTRAINT media_cleanup_one_source;
ALTER TABLE whaleu_media.cleanup_obligations ADD CONSTRAINT media_cleanup_one_source CHECK(
 (object_attempt_id IS NOT NULL)::integer+(asset_id IS NOT NULL)::integer+
 (derived_attempt_id IS NOT NULL)::integer+(ingress_writer_id IS NOT NULL)::integer=1);
CREATE TRIGGER media_request_fence_identity BEFORE UPDATE OR DELETE ON whaleu_media.upload_request_fences FOR EACH ROW EXECUTE FUNCTION whaleu_media.guard_mutable_record('state,terminal_reason,updated_at');
CREATE TRIGGER media_ingress_identity BEFORE UPDATE OR DELETE ON whaleu_media.upload_ingress FOR EACH ROW EXECUTE FUNCTION whaleu_media.guard_mutable_record('grant_id,grant_session_id,grant_expires_at,writer_token,writer_instance_id,writer_deadline,writer_state,transfer_attempt_count,observed_bytes,observed_sha256');
CREATE TRIGGER media_ingress_writer_identity BEFORE UPDATE OR DELETE ON whaleu_media.upload_ingress_writers FOR EACH ROW EXECUTE FUNCTION whaleu_media.guard_mutable_record('state,transferred_bytes');
CREATE FUNCTION whaleu_media.guard_ingress_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='upload_request_fences' THEN
  IF OLD.state<>'active' AND NEW IS DISTINCT FROM OLD OR NEW.updated_at<OLD.updated_at THEN
   RAISE EXCEPTION 'Terminal upload request fence is retained' USING ERRCODE='23514'; END IF;
 ELSIF TG_TABLE_NAME='upload_ingress_writers' THEN
  IF (OLD.state='retired' AND NEW.state<>'retired') OR NEW.transferred_bytes<OLD.transferred_bytes THEN
   RAISE EXCEPTION 'Retired writer cannot restart' USING ERRCODE='23514'; END IF;
 ELSE
  IF NEW.transfer_attempt_count<OLD.transfer_attempt_count OR NEW.transfer_attempt_count>OLD.transfer_attempt_count+1 OR
   (OLD.writer_state='observed' AND NEW IS DISTINCT FROM OLD) OR
   (OLD.writer_state IN ('writing','retiring','unknown') AND ROW(NEW.grant_id,NEW.grant_session_id,NEW.writer_token) IS DISTINCT FROM ROW(OLD.grant_id,OLD.grant_session_id,OLD.writer_token)) OR
   (NEW.writer_token IS DISTINCT FROM OLD.writer_token AND OLD.writer_state NOT IN ('idle','retired')) THEN
   RAISE EXCEPTION 'Invalid upload writer CAS transition' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['upload_request_fences','upload_ingress','upload_ingress_writers'] LOOP
  EXECUTE format('CREATE TRIGGER a0_media_policy_gate BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_media.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.content_policy_writer_gate()',t);
  EXECUTE format('CREATE TRIGGER a1_media_owner_epoch BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_media.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_media.advance_owner_epoch()',t);
  EXECUTE format('CREATE TRIGGER media_retain BEFORE TRUNCATE ON whaleu_media.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_media.immutable_record()',t);
  EXECUTE format('CREATE TRIGGER media_ingress_transition BEFORE UPDATE ON whaleu_media.%I FOR EACH ROW EXECUTE FUNCTION whaleu_media.guard_ingress_transition()',t);
 END LOOP;
END $$;
CREATE FUNCTION whaleu_media.request_fence_consistent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE i whaleu_media.upload_intents; f whaleu_media.upload_request_fences;
BEGIN
 IF TG_TABLE_NAME='upload_intents' THEN i:=NEW;
 ELSE
  IF NEW.intent_id IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO STRICT i FROM whaleu_media.upload_intents WHERE id=NEW.intent_id;
 END IF;
 IF i.protocol_version<>2 THEN RETURN NULL; END IF;
 SELECT * INTO f FROM whaleu_media.upload_request_fences WHERE actor_id=i.actor_id AND client_request_id=i.client_request_id;
 IF NOT FOUND OR f.intent_id IS DISTINCT FROM i.id OR f.request_hash<>i.request_hash THEN
  RAISE EXCEPTION 'Upload v2 requires exact original request fence' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER media_v2_request_fence AFTER INSERT ON whaleu_media.upload_intents DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_media.request_fence_consistent();
CREATE CONSTRAINT TRIGGER media_request_fence_intent AFTER INSERT ON whaleu_media.upload_request_fences DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_media.request_fence_consistent();
CREATE OR REPLACE FUNCTION whaleu_media.cleanup_exact_object() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a whaleu_media.object_attempts; v whaleu_media.variants; d whaleu_media.derived_object_attempts; w whaleu_media.upload_ingress_writers;
BEGIN
 IF NEW.ingress_writer_id IS NOT NULL THEN
  SELECT * INTO STRICT w FROM whaleu_media.upload_ingress_writers WHERE writer_token=NEW.ingress_writer_id;
  IF ROW(NEW.provider,NEW.environment,NEW.bucket,NEW.object_key,NEW.object_version)
  IS DISTINCT FROM ROW(w.provider,w.environment,w.bucket,w.object_key,w.object_version) THEN
   RAISE EXCEPTION 'Cleanup must target exact precommitted ingress scratch' USING ERRCODE='23514'; END IF;
 ELSIF NEW.derived_attempt_id IS NOT NULL THEN
  SELECT * INTO STRICT d FROM whaleu_media.derived_object_attempts WHERE id=NEW.derived_attempt_id;
  IF ROW(NEW.provider,NEW.environment,NEW.bucket,NEW.object_key,NEW.object_version)
  IS DISTINCT FROM ROW(d.provider,d.environment,d.bucket,d.object_key,d.object_version) THEN
   RAISE EXCEPTION 'Cleanup must target its exact planned derivative' USING ERRCODE='23514'; END IF;
 ELSIF NEW.object_attempt_id IS NOT NULL THEN
  SELECT * INTO STRICT a FROM whaleu_media.object_attempts WHERE id=NEW.object_attempt_id;
  IF ROW(NEW.provider,NEW.environment) IS DISTINCT FROM ROW(a.provider,a.environment) OR
   (ROW(NEW.bucket,NEW.object_key,NEW.object_version) IS DISTINCT FROM ROW(a.staging_bucket,a.staging_key,a.source_version)
    AND ROW(NEW.bucket,NEW.object_key,NEW.object_version) IS DISTINCT FROM ROW(a.sealed_bucket,a.sealed_key,a.sealed_version)) THEN
   RAISE EXCEPTION 'Cleanup must target exact planned attempt version' USING ERRCODE='23514'; END IF;
 ELSE
  SELECT * INTO STRICT v FROM whaleu_media.variants WHERE asset_id=NEW.asset_id AND variant_name=NEW.variant_name;
  IF ROW(NEW.provider,NEW.environment,NEW.bucket,NEW.object_key,NEW.object_version)
   IS DISTINCT FROM ROW(v.provider,v.environment,v.bucket,v.object_key,v.object_version) THEN
   RAISE EXCEPTION 'Cleanup must target immutable variant' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
-- Additional trigger preserves the existing binding guard and lock order. The
-- application registers these deadlines again in mandatory commit finalization.
CREATE FUNCTION whaleu_media.binding_retention_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a whaleu_media.assets; deadline timestamptz;
BEGIN
 SELECT * INTO STRICT a FROM whaleu_media.assets WHERE id=NEW.asset_id;
 deadline:=a.created_at+interval '24 hours';
 IF a.owner_kind='community' AND a.target_kind='draft' THEN
  SELECT least(deadline,d.expires_at) INTO deadline FROM whaleu_community.media_drafts d
  WHERE d.id=a.resource_id AND d.actor_id=a.actor_id AND d.scope_revision=a.scope_revision;
 END IF;
 IF deadline IS NULL OR deadline<=clock_timestamp() THEN
  RAISE EXCEPTION 'Media binding retention deadline expired' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER media_binding_retention BEFORE INSERT ON whaleu_media.bindings FOR EACH ROW EXECUTE FUNCTION whaleu_media.binding_retention_guard();

CREATE CONSTRAINT TRIGGER media_binding_retention_final AFTER INSERT ON whaleu_media.bindings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_media.binding_retention_guard();
