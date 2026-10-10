-- Every derivative destination is durably planned before a storage side effect.
-- Synthetic adapter can preallocate exact versions. A real provider must supply
-- an equivalent recoverable immutable identity protocol before activation.
SET LOCAL lock_timeout='5s';
SELECT pg_advisory_xact_lock(hashtextextended('whaleu:named-block-policy:v1',0));
CREATE TABLE whaleu_media.derived_object_attempts (
 id uuid PRIMARY KEY,
 intent_id uuid NOT NULL REFERENCES whaleu_media.upload_intents(id),
 generation bigint NOT NULL CHECK(generation>0),
 variant_name text NOT NULL CHECK(variant_name IN ('thumb-v1','display-v1')),
 effect_key whaleu_media.label NOT NULL UNIQUE,
 provider whaleu_media.label NOT NULL, environment whaleu_media.label NOT NULL,
 bucket whaleu_media.label NOT NULL, object_key text NOT NULL CHECK(length(object_key) BETWEEN 1 AND 1024),
 object_version text NOT NULL CHECK(length(object_version) BETWEEN 1 AND 1024),
 sha256 whaleu_media.digest, bytes bigint CHECK(bytes BETWEEN 1 AND 5242880),
 state text NOT NULL DEFAULT 'planned' CHECK(state IN ('planned','written','cleanup_pending','deleted')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(created_at)),
 UNIQUE(intent_id,generation,variant_name),
 UNIQUE(provider,environment,bucket,object_key,object_version),
 CHECK((sha256 IS NULL)=(bytes IS NULL)),
 CHECK(state<>'written' OR sha256 IS NOT NULL)
);
CREATE TRIGGER a0_media_policy_gate BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_media.derived_object_attempts FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.content_policy_writer_gate();
CREATE TRIGGER a1_media_owner_epoch BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_media.derived_object_attempts FOR EACH STATEMENT EXECUTE FUNCTION whaleu_media.advance_owner_epoch();
CREATE TRIGGER media_derived_identity BEFORE UPDATE OR DELETE ON whaleu_media.derived_object_attempts FOR EACH ROW EXECUTE FUNCTION whaleu_media.guard_mutable_record('sha256,bytes,state');
CREATE TRIGGER media_derived_retain BEFORE TRUNCATE ON whaleu_media.derived_object_attempts FOR EACH STATEMENT EXECUTE FUNCTION whaleu_media.immutable_record();
CREATE FUNCTION whaleu_media.guard_derived_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (OLD.sha256 IS NOT NULL AND ROW(NEW.sha256,NEW.bytes) IS DISTINCT FROM ROW(OLD.sha256,OLD.bytes))
 OR (OLD.state='written' AND NEW.state NOT IN ('written','cleanup_pending','deleted'))
 OR (OLD.state='cleanup_pending' AND NEW.state NOT IN ('cleanup_pending','deleted'))
 OR (OLD.state='deleted' AND NEW IS DISTINCT FROM OLD) THEN
 RAISE EXCEPTION 'Derived media identity/state is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER media_derived_transition BEFORE UPDATE ON whaleu_media.derived_object_attempts FOR EACH ROW EXECUTE FUNCTION whaleu_media.guard_derived_transition();
ALTER TABLE whaleu_media.cleanup_obligations ADD COLUMN derived_attempt_id uuid REFERENCES whaleu_media.derived_object_attempts(id);
ALTER TABLE whaleu_media.cleanup_obligations DROP CONSTRAINT media_cleanup_one_source;
ALTER TABLE whaleu_media.cleanup_obligations ADD CONSTRAINT media_cleanup_one_source CHECK(
 (object_attempt_id IS NOT NULL)::integer+(asset_id IS NOT NULL)::integer+(derived_attempt_id IS NOT NULL)::integer=1);
CREATE OR REPLACE FUNCTION whaleu_media.cleanup_exact_object() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a whaleu_media.object_attempts; v whaleu_media.variants; d whaleu_media.derived_object_attempts;
BEGIN
 IF NEW.derived_attempt_id IS NOT NULL THEN
  SELECT * INTO STRICT d FROM whaleu_media.derived_object_attempts WHERE id=NEW.derived_attempt_id;
  IF ROW(NEW.provider,NEW.environment,NEW.bucket,NEW.object_key,NEW.object_version)
  IS DISTINCT FROM ROW(d.provider,d.environment,d.bucket,d.object_key,d.object_version) THEN
   RAISE EXCEPTION 'Cleanup must target its exact planned derivative' USING ERRCODE='23514'; END IF;
 ELSIF NEW.object_attempt_id IS NOT NULL THEN
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
-- Final Media validator fences newly added sources too.
CREATE OR REPLACE FUNCTION whaleu_media.try_owner_fence() RETURNS boolean LANGUAGE plpgsql AS $$
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
  whaleu_media.scope_consumptions,whaleu_media.bindings,whaleu_media.jobs,whaleu_media.cleanup_obligations,
  whaleu_media.derived_object_attempts IN SHARE MODE NOWAIT;
 RETURN true;
EXCEPTION WHEN lock_not_available THEN RETURN false;
END $$;
