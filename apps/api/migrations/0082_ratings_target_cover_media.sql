-- Additive Ratings target-cover Media protocol 6. No legacy row is reclassified.
SET LOCAL lock_timeout='5s';
SELECT pg_advisory_xact_lock(hashtextextended('whaleu:named-block-policy:v1',0));
CREATE TABLE whaleu_media.ratings_request_markers (
 actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id), client_request_id uuid NOT NULL,
 request_hash whaleu_media.digest NOT NULL, PRIMARY KEY(actor_id,client_request_id),
 FOREIGN KEY(actor_id,client_request_id) REFERENCES whaleu_media.upload_request_fences(actor_id,client_request_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TRIGGER a0_media_policy_gate BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_media.ratings_request_markers FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.content_policy_writer_gate();
CREATE TRIGGER a1_media_owner_epoch BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_media.ratings_request_markers FOR EACH STATEMENT EXECUTE FUNCTION whaleu_media.advance_owner_epoch();
CREATE TRIGGER media_retain BEFORE TRUNCATE ON whaleu_media.ratings_request_markers FOR EACH STATEMENT EXECUTE FUNCTION whaleu_media.immutable_record();
CREATE TRIGGER media_immutable BEFORE UPDATE OR DELETE ON whaleu_media.ratings_request_markers FOR EACH ROW EXECUTE FUNCTION whaleu_media.immutable_record();
CREATE FUNCTION whaleu_media.ratings_request_marker_consistent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE marker whaleu_media.ratings_request_markers;fence whaleu_media.upload_request_fences;
BEGIN
 SELECT * INTO marker FROM whaleu_media.ratings_request_markers WHERE actor_id=NEW.actor_id AND client_request_id=NEW.client_request_id;
 IF NOT FOUND THEN RETURN NULL;END IF;
 SELECT * INTO fence FROM whaleu_media.upload_request_fences WHERE actor_id=marker.actor_id AND client_request_id=marker.client_request_id;
 IF NOT FOUND OR fence.request_hash<>marker.request_hash OR EXISTS(SELECT 1 FROM whaleu_media.profile_request_markers WHERE actor_id=marker.actor_id AND client_request_id=marker.client_request_id)
 OR (fence.intent_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM whaleu_media.upload_intents WHERE id=fence.intent_id AND protocol_version=6)) THEN
 RAISE EXCEPTION 'Ratings request requires its exact protocol fence' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER media_ratings_marker_fence AFTER INSERT ON whaleu_media.ratings_request_markers DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_media.ratings_request_marker_consistent();
CREATE CONSTRAINT TRIGGER media_ratings_fence_marker AFTER INSERT OR UPDATE ON whaleu_media.upload_request_fences DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_media.ratings_request_marker_consistent();
ALTER TABLE whaleu_media.upload_intents DROP CONSTRAINT media_protocol_identity;
ALTER TABLE whaleu_media.upload_intents ADD CONSTRAINT media_protocol_identity CHECK(
 (protocol_version=1 AND request_hash IS NULL AND declared_sha256 IS NULL) OR
 (protocol_version IN (2,3,4,5,6) AND request_hash IS NOT NULL AND declared_sha256 IS NOT NULL));
-- Retain Profile's exact branch; only the independent Ratings branch may use edit.
ALTER TABLE whaleu_media.upload_intents DROP CONSTRAINT media_profile_scope;
ALTER TABLE whaleu_media.upload_intents ADD CONSTRAINT media_profile_scope CHECK(
 (protocol_version=5 AND owner_kind='profile' AND resource_kind='avatar' AND audience='profile-public'
 AND target_kind='edit' AND content_version=1 AND slot='avatar' AND ordinal=0 AND purpose='profile-avatar-image') OR
 (protocol_version<>5 AND owner_kind<>'profile' AND (target_kind<>'edit' OR protocol_version=6) AND audience<>'profile-public' AND purpose<>'profile-avatar-image'));
ALTER TABLE whaleu_media.assets DROP CONSTRAINT media_profile_asset_scope;
ALTER TABLE whaleu_media.assets ADD CONSTRAINT media_profile_asset_scope CHECK(
 (owner_kind='profile' AND resource_kind='avatar' AND audience='profile-public' AND target_kind='edit'
 AND content_version=1 AND slot='avatar' AND ordinal=0 AND purpose='profile-avatar-image') OR
 (owner_kind<>'profile' AND (target_kind<>'edit' OR owner_kind='ratings') AND audience<>'profile-public' AND purpose<>'profile-avatar-image'));
ALTER TABLE whaleu_media.upload_intents ADD CONSTRAINT media_ratings_scope CHECK(
 (protocol_version=6 AND owner_kind='ratings' AND resource_kind='target_cover' AND audience='content-gated'
 AND target_kind='edit' AND content_version=1 AND slot='cover' AND ordinal=0 AND purpose='ratings-target-cover-image') OR
 (protocol_version<>6 AND owner_kind<>'ratings' AND purpose<>'ratings-target-cover-image'));
ALTER TABLE whaleu_media.assets ADD CONSTRAINT media_ratings_asset_scope CHECK(
 (owner_kind='ratings' AND resource_kind='target_cover' AND audience='content-gated' AND target_kind='edit'
 AND content_version=1 AND slot='cover' AND ordinal=0 AND purpose='ratings-target-cover-image') OR
 (owner_kind<>'ratings' AND purpose<>'ratings-target-cover-image'));
ALTER TABLE whaleu_media.bindings ADD CONSTRAINT media_ratings_binding_slot CHECK(owner_kind<>'ratings' OR (resource_kind='target_cover' AND content_version=1 AND slot='cover' AND ordinal=0));
CREATE FUNCTION whaleu_media.ratings_intent_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.protocol_version<>6 THEN RETURN NEW;END IF;
 IF NOT EXISTS(SELECT 1 FROM whaleu_ratings.target_cover_upload_scopes s WHERE s.id=NEW.resource_id AND s.actor_id=NEW.actor_id
 AND s.client_request_id=NEW.client_request_id AND s.scope_revision=NEW.scope_revision AND s.request_hash=NEW.request_hash
 AND s.declaration=jsonb_build_object('mime',NEW.declared_mime,'bytes',NEW.declared_bytes,'sha256',NEW.declared_sha256)
 AND s.expires_at=NEW.expires_at) THEN
 RAISE EXCEPTION 'Ratings intent requires exact immutable owner upload scope' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER media_ratings_intent BEFORE INSERT ON whaleu_media.upload_intents FOR EACH ROW EXECUTE FUNCTION whaleu_media.ratings_intent_guard();
CREATE FUNCTION whaleu_media.ratings_request_fence_consistent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE i whaleu_media.upload_intents;f whaleu_media.upload_request_fences;
BEGIN
 IF TG_TABLE_NAME='upload_intents' THEN i:=NEW;ELSE
 IF NEW.intent_id IS NULL THEN RETURN NULL;END IF;SELECT * INTO STRICT i FROM whaleu_media.upload_intents WHERE id=NEW.intent_id;END IF;
 IF i.protocol_version<>6 THEN RETURN NULL;END IF;
 IF NOT EXISTS(SELECT 1 FROM whaleu_media.ratings_request_markers WHERE actor_id=i.actor_id AND client_request_id=i.client_request_id AND request_hash=i.request_hash) THEN
 RAISE EXCEPTION 'Ratings intent requires its protocol marker' USING ERRCODE='23514';END IF;
 SELECT * INTO f FROM whaleu_media.upload_request_fences WHERE actor_id=i.actor_id AND client_request_id=i.client_request_id;
 IF f.intent_id IS DISTINCT FROM i.id OR f.request_hash IS DISTINCT FROM i.request_hash THEN
 RAISE EXCEPTION 'Ratings intent requires exact original request fence' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER media_ratings_request_fence AFTER INSERT ON whaleu_media.upload_intents DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_media.ratings_request_fence_consistent();
CREATE CONSTRAINT TRIGGER media_ratings_fence_intent AFTER INSERT ON whaleu_media.upload_request_fences DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_media.ratings_request_fence_consistent();
CREATE FUNCTION whaleu_media.ratings_binding_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a whaleu_media.assets;deadline timestamptz;
BEGIN
 IF NEW.owner_kind<>'ratings' THEN RETURN NEW;END IF;
 SELECT * INTO STRICT a FROM whaleu_media.assets WHERE id=NEW.asset_id;
 SELECT least(a.created_at+interval '24 hours',s.expires_at) INTO deadline FROM whaleu_ratings.target_cover_upload_scopes s
 WHERE s.id=a.resource_id AND s.actor_id=a.actor_id AND s.scope_revision=a.scope_revision;
 IF deadline IS NULL OR deadline<=clock_timestamp() OR NEW.attach_evidence IS DISTINCT FROM
 jsonb_build_object('version',6,'scopeId',a.resource_id::text,'scopeRevision',a.scope_revision) THEN
 RAISE EXCEPTION 'Ratings binding requires live exact upload scope' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER media_ratings_binding BEFORE INSERT ON whaleu_media.bindings FOR EACH ROW EXECUTE FUNCTION whaleu_media.ratings_binding_guard();
CREATE CONSTRAINT TRIGGER media_ratings_binding_final AFTER INSERT ON whaleu_media.bindings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_media.ratings_binding_guard();
CREATE FUNCTION whaleu_media.ratings_appearance_coupling() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.owner_kind<>'ratings' THEN RETURN NULL;END IF;
 IF NOT EXISTS(SELECT 1 FROM whaleu_ratings.target_cover_appearances p JOIN whaleu_media.assets a ON a.id=NEW.asset_id
 WHERE p.id=NEW.resource_id AND p.actor_id=a.actor_id AND p.asset_id=a.id AND p.manifest_digest=NEW.manifest_digest
 AND p.media_binding_id=NEW.id) THEN RAISE EXCEPTION 'Ratings binding requires its exact immutable owner appearance' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER media_ratings_appearance AFTER INSERT ON whaleu_media.bindings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_media.ratings_appearance_coupling();

CREATE OR REPLACE FUNCTION whaleu_media.scope_consumption_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE profile_assets jsonb;
BEGIN
 IF NEW.owner_kind='ratings' THEN
  SELECT jsonb_agg(jsonb_build_object('assetId',a.id::text,'digest',a.manifest_digest) ORDER BY b.ordinal)
   INTO profile_assets FROM whaleu_media.assets a JOIN whaleu_media.bindings b ON b.asset_id=a.id
   WHERE a.actor_id=NEW.actor_id AND a.owner_kind='ratings' AND a.resource_kind='target_cover'
   AND a.target_kind='edit' AND a.resource_id=NEW.scope_resource_id AND a.scope_revision=NEW.scope_revision
   AND b.owner_kind='ratings' AND b.resource_kind='target_cover' AND b.resource_id=NEW.resource_id
   AND b.content_version=1 AND b.slot='cover' AND b.ordinal=0 AND b.detached_at IS NULL;
  IF NEW.resource_kind<>'target_cover' OR NEW.content_version<>1 OR profile_assets IS NULL OR jsonb_array_length(profile_assets)<>1
   OR NEW.attach_evidence IS DISTINCT FROM jsonb_build_object('version',6,'operation','select_target_cover','assets',profile_assets) THEN
   RAISE EXCEPTION 'Ratings scope requires atomic exact single cover binding' USING ERRCODE='23514';END IF;
 ELSIF NEW.owner_kind='profile' THEN
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
