-- Independent Profile protocol 5. Historical codecs, rows and migrations remain unchanged.
SET LOCAL lock_timeout='5s';
SELECT pg_advisory_xact_lock(hashtextextended('whaleu:named-block-policy:v1',0));
CREATE TABLE whaleu_media.profile_request_markers (
 actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id), client_request_id uuid NOT NULL,
 request_hash whaleu_media.digest NOT NULL, PRIMARY KEY(actor_id,client_request_id),
 FOREIGN KEY(actor_id,client_request_id) REFERENCES whaleu_media.upload_request_fences(actor_id,client_request_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TRIGGER a0_media_policy_gate BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_media.profile_request_markers FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.content_policy_writer_gate();
CREATE TRIGGER a1_media_owner_epoch BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_media.profile_request_markers FOR EACH STATEMENT EXECUTE FUNCTION whaleu_media.advance_owner_epoch();
CREATE TRIGGER media_retain BEFORE TRUNCATE ON whaleu_media.profile_request_markers FOR EACH STATEMENT EXECUTE FUNCTION whaleu_media.immutable_record();
CREATE TRIGGER media_immutable BEFORE UPDATE OR DELETE ON whaleu_media.profile_request_markers FOR EACH ROW EXECUTE FUNCTION whaleu_media.immutable_record();
CREATE FUNCTION whaleu_media.profile_request_marker_consistent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE marker whaleu_media.profile_request_markers;fence whaleu_media.upload_request_fences;
BEGIN
 SELECT * INTO marker FROM whaleu_media.profile_request_markers WHERE actor_id=NEW.actor_id AND client_request_id=NEW.client_request_id;
 IF NOT FOUND THEN RETURN NULL;END IF;
 SELECT * INTO fence FROM whaleu_media.upload_request_fences WHERE actor_id=marker.actor_id AND client_request_id=marker.client_request_id;
 IF NOT FOUND OR fence.request_hash<>marker.request_hash OR (fence.intent_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM whaleu_media.upload_intents WHERE id=fence.intent_id AND protocol_version=5)) THEN
  RAISE EXCEPTION 'Profile request marker must match its exact shared fence' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER media_profile_marker_fence AFTER INSERT ON whaleu_media.profile_request_markers DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_media.profile_request_marker_consistent();
CREATE CONSTRAINT TRIGGER media_profile_fence_marker AFTER INSERT OR UPDATE ON whaleu_media.upload_request_fences DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_media.profile_request_marker_consistent();
ALTER DOMAIN whaleu_media.audience DROP CONSTRAINT audience_check;
ALTER DOMAIN whaleu_media.audience ADD CONSTRAINT audience_check CHECK(VALUE IN ('content-gated','participant-private','conversation-private','profile-public'));
ALTER TABLE whaleu_media.upload_intents DROP CONSTRAINT upload_intents_target_kind_check;
ALTER TABLE whaleu_media.upload_intents ADD CONSTRAINT upload_intents_target_kind_check CHECK(target_kind IN ('draft','parent','edit'));
ALTER TABLE whaleu_media.assets DROP CONSTRAINT assets_target_kind_check;
ALTER TABLE whaleu_media.assets ADD CONSTRAINT assets_target_kind_check CHECK(target_kind IN ('draft','parent','edit'));
ALTER TABLE whaleu_media.upload_intents DROP CONSTRAINT media_protocol_identity;
ALTER TABLE whaleu_media.upload_intents ADD CONSTRAINT media_protocol_identity CHECK(
 (protocol_version=1 AND request_hash IS NULL AND declared_sha256 IS NULL) OR
 (protocol_version IN (2,3,4,5) AND request_hash IS NOT NULL AND declared_sha256 IS NOT NULL));
ALTER TABLE whaleu_media.upload_intents ADD CONSTRAINT media_profile_scope CHECK(
 (protocol_version=5 AND owner_kind='profile' AND resource_kind='avatar' AND audience='profile-public'
  AND target_kind='edit' AND content_version=1 AND slot='avatar' AND ordinal=0 AND purpose='profile-avatar-image') OR
 (protocol_version<>5 AND owner_kind<>'profile' AND target_kind<>'edit' AND audience<>'profile-public' AND purpose<>'profile-avatar-image'));
ALTER TABLE whaleu_media.assets ADD CONSTRAINT media_profile_asset_scope CHECK(
 (owner_kind='profile' AND resource_kind='avatar' AND audience='profile-public' AND target_kind='edit'
  AND content_version=1 AND slot='avatar' AND ordinal=0 AND purpose='profile-avatar-image') OR
 (owner_kind<>'profile' AND target_kind<>'edit' AND audience<>'profile-public' AND purpose<>'profile-avatar-image'));
ALTER TABLE whaleu_media.bindings ADD CONSTRAINT media_profile_binding_slot CHECK(owner_kind<>'profile' OR (resource_kind='avatar' AND content_version=1 AND slot='avatar' AND ordinal=0));

CREATE FUNCTION whaleu_media.profile_intent_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.protocol_version<>5 THEN RETURN NEW;END IF;
 IF NOT EXISTS(SELECT 1 FROM whaleu_profile.avatar_edits e WHERE e.id=NEW.resource_id AND e.actor_id=NEW.actor_id
  AND e.client_request_id=NEW.client_request_id AND e.scope_revision=NEW.scope_revision
  AND e.request_hash=NEW.request_hash AND e.declaration=jsonb_build_object('mime',NEW.declared_mime,'bytes',NEW.declared_bytes,'sha256',NEW.declared_sha256)
  AND e.expires_at=NEW.expires_at) THEN
  RAISE EXCEPTION 'Profile intent requires exact immutable edit' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER media_profile_intent BEFORE INSERT ON whaleu_media.upload_intents FOR EACH ROW EXECUTE FUNCTION whaleu_media.profile_intent_guard();
CREATE FUNCTION whaleu_media.profile_request_fence_consistent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE i whaleu_media.upload_intents;f whaleu_media.upload_request_fences;
BEGIN
 IF TG_TABLE_NAME='upload_intents' THEN i:=NEW;
 ELSE IF NEW.intent_id IS NULL THEN RETURN NULL;END IF;
  SELECT * INTO STRICT i FROM whaleu_media.upload_intents WHERE id=NEW.intent_id;
 END IF;
 IF i.protocol_version<>5 THEN RETURN NULL;END IF;
 IF NOT EXISTS(SELECT 1 FROM whaleu_media.profile_request_markers WHERE actor_id=i.actor_id AND client_request_id=i.client_request_id AND request_hash=i.request_hash) THEN
  RAISE EXCEPTION 'Profile intent requires its protocol marker' USING ERRCODE='23514';END IF;
 SELECT * INTO f FROM whaleu_media.upload_request_fences WHERE actor_id=i.actor_id AND client_request_id=i.client_request_id;
 IF f.intent_id IS DISTINCT FROM i.id OR f.request_hash IS DISTINCT FROM i.request_hash THEN
  RAISE EXCEPTION 'Profile intent requires exact original request fence' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER media_profile_request_fence AFTER INSERT ON whaleu_media.upload_intents DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_media.profile_request_fence_consistent();
CREATE CONSTRAINT TRIGGER media_profile_fence_intent AFTER INSERT ON whaleu_media.upload_request_fences DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_media.profile_request_fence_consistent();

-- An additional deadline guard leaves every legacy deadline rule in force.
CREATE FUNCTION whaleu_media.profile_binding_retention_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a whaleu_media.assets;deadline timestamptz;
BEGIN
 IF NEW.owner_kind<>'profile' THEN RETURN NEW;END IF;
 SELECT * INTO STRICT a FROM whaleu_media.assets WHERE id=NEW.asset_id;
 SELECT least(a.created_at+interval '24 hours',e.expires_at) INTO deadline FROM whaleu_profile.avatar_edits e
  WHERE e.id=a.resource_id AND e.actor_id=a.actor_id AND e.scope_revision=a.scope_revision;
 IF deadline IS NULL OR deadline<=clock_timestamp() THEN
  RAISE EXCEPTION 'Profile edit retention deadline expired' USING ERRCODE='23514';END IF;
 IF NEW.attach_evidence IS DISTINCT FROM jsonb_build_object('version',5,'scopeId',a.resource_id::text,'scopeRevision',a.scope_revision) THEN
  RAISE EXCEPTION 'Profile binding requires exact edit evidence' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER media_profile_binding_retention BEFORE INSERT ON whaleu_media.bindings FOR EACH ROW EXECUTE FUNCTION whaleu_media.profile_binding_retention_guard();
CREATE CONSTRAINT TRIGGER media_profile_binding_retention_final AFTER INSERT ON whaleu_media.bindings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_media.profile_binding_retention_guard();

CREATE OR REPLACE FUNCTION whaleu_media.scope_consumption_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE profile_assets jsonb;
BEGIN
 IF NEW.owner_kind='profile' THEN
  SELECT jsonb_agg(jsonb_build_object('assetId',a.id::text,'digest',a.manifest_digest) ORDER BY b.ordinal)
   INTO profile_assets FROM whaleu_media.assets a JOIN whaleu_media.bindings b ON b.asset_id=a.id
   WHERE a.actor_id=NEW.actor_id AND a.owner_kind='profile' AND a.resource_kind='avatar'
    AND a.target_kind='edit' AND a.resource_id=NEW.scope_resource_id AND a.scope_revision=NEW.scope_revision
    AND b.owner_kind='profile' AND b.resource_kind='avatar' AND b.resource_id=NEW.resource_id
    AND b.content_version=1 AND b.slot='avatar' AND b.ordinal=0 AND b.detached_at IS NULL;
  IF NEW.resource_kind<>'avatar' OR NEW.content_version<>1 OR profile_assets IS NULL OR jsonb_array_length(profile_assets)<>1
   OR NEW.attach_evidence IS DISTINCT FROM jsonb_build_object('version',5,'operation','select_avatar','assets',profile_assets) THEN
   RAISE EXCEPTION 'Profile edit requires atomic exact single avatar binding' USING ERRCODE='23514';END IF;
 ELSIF NEW.attach_evidence->'version' IN ('2'::jsonb,'3'::jsonb) THEN
  PERFORM whaleu_media.assert_batch_consumed((NEW.attach_evidence->>'batchId')::uuid);
  IF NOT EXISTS(SELECT 1 FROM whaleu_media.publication_batches WHERE id=(NEW.attach_evidence->>'batchId')::uuid AND state='consumed')
   OR EXISTS(SELECT 1 FROM whaleu_media.bindings WHERE owner_kind=NEW.owner_kind AND resource_kind=NEW.resource_kind
    AND resource_id=NEW.resource_id AND content_version=NEW.content_version AND detached_at IS NOT NULL) THEN
   RAISE EXCEPTION 'V3 scope requires atomic complete active consumption' USING ERRCODE='23514';END IF;
 ELSE
  IF NOT EXISTS(SELECT 1 FROM whaleu_media.assets a JOIN whaleu_media.bindings b ON b.asset_id=a.id
   WHERE a.actor_id=NEW.actor_id AND a.owner_kind=NEW.owner_kind AND a.resource_kind=NEW.resource_kind
    AND a.target_kind='draft' AND a.resource_id=NEW.scope_resource_id AND a.scope_revision=NEW.scope_revision
    AND b.owner_kind=NEW.owner_kind AND b.resource_kind=NEW.resource_kind AND b.resource_id=NEW.resource_id
    AND b.content_version=NEW.content_version AND b.detached_at IS NULL) THEN
   RAISE EXCEPTION 'Media draft consumption requires an atomic exact binding' USING ERRCODE='23514';END IF;
 END IF;
 RETURN NULL;
END $$;
