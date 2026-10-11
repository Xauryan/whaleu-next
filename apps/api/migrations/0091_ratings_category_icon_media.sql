-- Independent Category icon Media8. Historical codecs and protocol1-7 trigger
-- functions are untouched; only explicit typed8 dispatch admits these parents.
-- No production provider, Review issuer, source adoption or runtime activation.
SET LOCAL lock_timeout='5s';
SELECT pg_advisory_xact_lock(hashtextextended('whaleu:named-block-policy:v1',0));

-- A shared nullable discriminator prevents old generic cancelled-before recovery
-- from interpreting a Media8 tombstone. NULL retains every historical protocol.
ALTER TABLE whaleu_media.upload_request_fences ADD COLUMN protocol_namespace integer
 CHECK(protocol_namespace IS NULL OR protocol_namespace=8);
CREATE TABLE whaleu_media.category_icon_request_markers(
 actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
 client_request_id uuid NOT NULL,request_hash whaleu_media.digest NOT NULL,
 PRIMARY KEY(actor_id,client_request_id),
 FOREIGN KEY(actor_id,client_request_id) REFERENCES whaleu_media.upload_request_fences(actor_id,client_request_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TRIGGER a0_media_policy_gate BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_media.category_icon_request_markers FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.content_policy_writer_gate();
CREATE TRIGGER a1_media_owner_epoch BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_media.category_icon_request_markers FOR EACH STATEMENT EXECUTE FUNCTION whaleu_media.advance_owner_epoch();
CREATE TRIGGER media_retain BEFORE TRUNCATE ON whaleu_media.category_icon_request_markers FOR EACH STATEMENT EXECUTE FUNCTION whaleu_media.immutable_record();
CREATE TRIGGER media_immutable BEFORE UPDATE OR DELETE ON whaleu_media.category_icon_request_markers FOR EACH ROW EXECUTE FUNCTION whaleu_media.immutable_record();

CREATE FUNCTION whaleu_media.category_icon_prepare_shape(v jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
 RETURN coalesce(whaleu_community.rating_scoped_keys(v,ARRAY['protocol','clientRequestId','editScopeId','scopeRevision','slot','declaration'])
 AND v->'protocol'='"ratings-category-icon-media-v1"'::jsonb AND v->'slot'='"icon"'::jsonb
 AND whaleu_community.rating_scoped_ids(v,ARRAY['clientRequestId','editScopeId'])
 AND jsonb_typeof(v->'scopeRevision')='string' AND v->>'scopeRevision' ~ '^[a-f0-9]{64}$'
 AND whaleu_community.rating_scoped_keys(v->'declaration',ARRAY['mime','bytes','sha256'])
 AND v->'declaration'->>'mime' IN ('image/jpeg','image/png')
 AND whaleu_community.rating_scoped_integer(v->'declaration'->'bytes',1)
 AND (v->'declaration'->>'bytes')::integer<=5242880
 AND jsonb_typeof(v->'declaration'->'sha256')='string'
 AND v->'declaration'->>'sha256' ~ '^[a-f0-9]{64}$',false);
 EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
-- The TS codec deliberately serializes fixed keys in this exact order. All
-- scalar strings are closed UUID/digest/MIME/slot tokens without whitespace.
CREATE FUNCTION whaleu_media.category_icon_request_hash(actor uuid,v jsonb) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT encode(sha256(convert_to('whaleu-ratings-category-icon-media-prepare:v1'||chr(10)||
  '{"protocol":"ratings-category-icon-media-v1","actorAccountId":'||to_json(actor::text)::text||
  ',"clientRequestId":'||to_json(v->>'clientRequestId')::text||',"editScopeId":'||to_json(v->>'editScopeId')::text||
  ',"scopeRevision":'||to_json(v->>'scopeRevision')::text||',"slot":"icon","declaration":{"mime":'||to_json(v->'declaration'->>'mime')::text||
  ',"bytes":'||(v->'declaration'->>'bytes')||',"sha256":'||to_json(v->'declaration'->>'sha256')::text||'}}','UTF8')),'hex')
$$;

ALTER TABLE whaleu_media.upload_intents DROP CONSTRAINT media_protocol_identity;
ALTER TABLE whaleu_media.upload_intents ADD CONSTRAINT media_protocol_identity CHECK(
 (protocol_version=1 AND request_hash IS NULL AND declared_sha256 IS NULL) OR
 (protocol_version IN (2,3,4,5,6,7,8) AND request_hash IS NOT NULL AND declared_sha256 IS NOT NULL));
ALTER TABLE whaleu_media.upload_intents DROP CONSTRAINT media_profile_scope;
ALTER TABLE whaleu_media.upload_intents ADD CONSTRAINT media_profile_scope CHECK(
 (protocol_version=5 AND owner_kind='profile' AND resource_kind='avatar' AND audience='profile-public'
 AND target_kind='edit' AND content_version=1 AND slot='avatar' AND ordinal=0 AND purpose='profile-avatar-image') OR
 (protocol_version<>5 AND owner_kind<>'profile' AND (target_kind<>'edit' OR protocol_version IN (6,8)) AND audience<>'profile-public' AND purpose<>'profile-avatar-image'));
ALTER TABLE whaleu_media.upload_intents DROP CONSTRAINT media_ratings_scope;
ALTER TABLE whaleu_media.upload_intents ADD CONSTRAINT media_ratings_scope CHECK(
 (protocol_version=6 AND owner_kind='ratings' AND resource_kind='target_cover' AND audience='content-gated'
 AND target_kind='edit' AND content_version=1 AND slot='cover' AND ordinal=0 AND purpose='ratings-target-cover-image') OR
 (protocol_version=7 AND owner_kind='ratings' AND audience='content-gated' AND target_kind='draft' AND content_version=1 AND slot='images'
 AND ((resource_kind='rating_comment' AND purpose='ratings-comment-image') OR (resource_kind='rating_reply' AND purpose='ratings-reply-image'))) OR
 (protocol_version=8 AND owner_kind='ratings' AND resource_kind='category_icon' AND audience='content-gated'
 AND target_kind='edit' AND content_version=1 AND slot='icon' AND ordinal=0 AND purpose='ratings-category-icon-image') OR
 (protocol_version NOT IN (6,7,8) AND owner_kind<>'ratings' AND purpose NOT IN ('ratings-target-cover-image','ratings-comment-image','ratings-reply-image','ratings-category-icon-image')));
ALTER TABLE whaleu_media.assets DROP CONSTRAINT media_ratings_asset_scope;
ALTER TABLE whaleu_media.assets ADD CONSTRAINT media_ratings_asset_scope CHECK(
 (owner_kind='ratings' AND resource_kind='target_cover' AND audience='content-gated' AND target_kind='edit'
 AND content_version=1 AND slot='cover' AND ordinal=0 AND purpose='ratings-target-cover-image') OR
 (owner_kind='ratings' AND audience='content-gated' AND target_kind='draft' AND content_version=1 AND slot='images'
 AND ((resource_kind='rating_comment' AND purpose='ratings-comment-image') OR (resource_kind='rating_reply' AND purpose='ratings-reply-image'))) OR
 (owner_kind='ratings' AND resource_kind='category_icon' AND audience='content-gated' AND target_kind='edit'
 AND content_version=1 AND slot='icon' AND ordinal=0 AND purpose='ratings-category-icon-image') OR
 (owner_kind<>'ratings' AND purpose NOT IN ('ratings-target-cover-image','ratings-comment-image','ratings-reply-image','ratings-category-icon-image')));
ALTER TABLE whaleu_media.bindings DROP CONSTRAINT media_ratings_binding_slot;
ALTER TABLE whaleu_media.bindings ADD CONSTRAINT media_ratings_binding_slot CHECK(owner_kind<>'ratings' OR
 (resource_kind='target_cover' AND content_version=1 AND slot='cover' AND ordinal=0) OR
 (resource_kind='rating_comment' AND content_version=1 AND slot='images' AND ordinal BETWEEN 0 AND 8) OR
 (resource_kind='rating_reply' AND content_version=1 AND slot='images' AND ordinal BETWEEN 0 AND 2) OR
 (resource_kind='category_icon' AND content_version=1 AND slot='icon' AND ordinal=0));

CREATE FUNCTION whaleu_media.category_icon_request_consistent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE marker whaleu_media.category_icon_request_markers;f whaleu_media.upload_request_fences;i whaleu_media.upload_intents;actor uuid;request uuid;
BEGIN
 actor:=NEW.actor_id;request:=NEW.client_request_id;
 SELECT * INTO marker FROM whaleu_media.category_icon_request_markers WHERE actor_id=actor AND client_request_id=request;
 SELECT * INTO f FROM whaleu_media.upload_request_fences WHERE actor_id=actor AND client_request_id=request;
 IF marker.actor_id IS NULL THEN
  IF TG_TABLE_NAME='upload_request_fences' THEN
   IF NEW.protocol_namespace=8 THEN RAISE EXCEPTION 'Category icon fence requires exact Media8 marker' USING ERRCODE='23514';END IF;
  END IF;
  IF TG_TABLE_NAME='upload_intents' THEN
   IF NEW.protocol_version=8 THEN RAISE EXCEPTION 'Category icon intent requires Media8 marker' USING ERRCODE='23514';END IF;
  END IF;
  RETURN NULL;
 END IF;
 IF f.actor_id IS NULL OR f.protocol_namespace IS DISTINCT FROM 8 OR f.request_hash<>marker.request_hash
 OR EXISTS(SELECT 1 FROM whaleu_media.profile_request_markers WHERE actor_id=actor AND client_request_id=request)
 OR EXISTS(SELECT 1 FROM whaleu_media.ratings_request_markers WHERE actor_id=actor AND client_request_id=request)
 OR EXISTS(SELECT 1 FROM whaleu_media.ratings_discussion_request_markers WHERE actor_id=actor AND client_request_id=request)
 OR EXISTS(SELECT 1 FROM whaleu_media.ratings_discussion_batch_request_fences WHERE actor_id=actor AND batch_request_id=request) THEN
  RAISE EXCEPTION 'Category icon requires exclusive exact Media8 shared request namespace' USING ERRCODE='23514';END IF;
 IF f.intent_id IS NOT NULL THEN
  SELECT * INTO STRICT i FROM whaleu_media.upload_intents WHERE id=f.intent_id;
  IF i.protocol_version<>8 OR ROW(i.actor_id,i.client_request_id,i.request_hash) IS DISTINCT FROM ROW(actor,request,marker.request_hash) THEN
   RAISE EXCEPTION 'Category icon request protocol mismatch' USING ERRCODE='23514';END IF;
 END IF;
 IF TG_TABLE_NAME='upload_intents' THEN
  IF NEW.protocol_version<>8 OR f.intent_id IS DISTINCT FROM NEW.id THEN
   RAISE EXCEPTION 'Category icon intent requires its original request receipt' USING ERRCODE='23514';END IF;
 END IF;
 RETURN NULL;
END $$;
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['category_icon_request_markers','profile_request_markers','ratings_request_markers','ratings_discussion_request_markers','upload_request_fences','upload_intents'] LOOP
  EXECUTE format('CREATE CONSTRAINT TRIGGER media8_request_consistent AFTER INSERT OR UPDATE ON whaleu_media.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_media.category_icon_request_consistent()',t);
 END LOOP;
END $$;
CREATE FUNCTION whaleu_media.category_icon_intent_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s whaleu_ratings.category_icon_upload_scopes;v jsonb;
BEGIN
 SELECT * INTO s FROM whaleu_ratings.category_icon_upload_scopes WHERE id=NEW.resource_id AND actor_id=NEW.actor_id;
 v:=jsonb_build_object('protocol','ratings-category-icon-media-v1','clientRequestId',NEW.client_request_id::text,'editScopeId',NEW.resource_id::text,
 'scopeRevision',NEW.scope_revision,'slot','icon','declaration',jsonb_build_object('mime',NEW.declared_mime,'bytes',NEW.declared_bytes,'sha256',NEW.declared_sha256));
 IF s.id IS NULL OR EXISTS(SELECT 1 FROM whaleu_ratings.category_icon_upload_scope_fences f WHERE f.actor_id=s.actor_id AND f.client_request_id=s.client_request_id)
 OR ROW(s.client_request_id,s.scope_revision,s.request_hash,s.expires_at) IS DISTINCT FROM ROW(NEW.client_request_id,NEW.scope_revision,NEW.request_hash,NEW.expires_at)
 OR s.declaration IS DISTINCT FROM v->'declaration' OR NEW.request_hash<>whaleu_media.category_icon_request_hash(NEW.actor_id,v)
 OR NOT whaleu_media.category_icon_prepare_shape(v) THEN
  RAISE EXCEPTION 'Category icon intent requires exact immutable owner upload scope and declaration' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER media8_intent BEFORE INSERT ON whaleu_media.upload_intents FOR EACH ROW WHEN(NEW.protocol_version=8) EXECUTE FUNCTION whaleu_media.category_icon_intent_guard();

-- Frozen old functions are not changed or called with the new parent kind.
DROP TRIGGER media_binding_guard ON whaleu_media.bindings;
CREATE TRIGGER media_binding_guard BEFORE INSERT ON whaleu_media.bindings FOR EACH ROW
 WHEN(NOT(NEW.owner_kind='ratings' AND NEW.resource_kind IN ('rating_comment','rating_reply','category_icon'))) EXECUTE FUNCTION whaleu_media.binding_guard();
DROP TRIGGER media_scope_consumption_complete ON whaleu_media.scope_consumptions;
CREATE CONSTRAINT TRIGGER media_scope_consumption_complete AFTER INSERT ON whaleu_media.scope_consumptions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 WHEN(NOT(NEW.owner_kind='ratings' AND NEW.resource_kind IN ('rating_comment','rating_reply','category_icon'))) EXECUTE FUNCTION whaleu_media.scope_consumption_complete();

CREATE FUNCTION whaleu_media.category_icon_binding_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a whaleu_media.assets;i whaleu_media.upload_intents;c whaleu_media.scope_consumptions;s whaleu_ratings.category_icon_upload_scopes;approved boolean;intent uuid;
BEGIN
 SELECT intent_id INTO STRICT intent FROM whaleu_media.assets WHERE id=NEW.asset_id;
 SELECT * INTO STRICT i FROM whaleu_media.upload_intents WHERE id=intent FOR UPDATE NOWAIT;
 SELECT * INTO STRICT a FROM whaleu_media.assets WHERE id=NEW.asset_id FOR UPDATE NOWAIT;
 SELECT * INTO s FROM whaleu_ratings.category_icon_upload_scopes WHERE id=a.resource_id AND actor_id=a.actor_id AND scope_revision=a.scope_revision;
 SELECT e.state='allow' AND e.effective_at<=clock_timestamp() AND e.valid_until>clock_timestamp()
  AND e.manifest_digest=a.manifest_digest AND e.policy_revision=a.policy_revision INTO approved
 FROM whaleu_media.asset_safety_heads h JOIN whaleu_media.asset_safety_events e ON (e.asset_id,e.revision,e.id)=(h.asset_id,h.revision,h.event_id) WHERE h.asset_id=a.id;
 SELECT * INTO c FROM whaleu_media.scope_consumptions WHERE actor_id=a.actor_id AND owner_kind='ratings' AND resource_kind='category_icon' AND scope_resource_id=a.resource_id;
 IF i.protocol_version<>8 OR i.state<>'ready' OR approved IS DISTINCT FROM true OR s.id IS NULL
 OR EXISTS(SELECT 1 FROM whaleu_ratings.category_icon_upload_scope_fences f WHERE f.actor_id=s.actor_id AND f.client_request_id=s.client_request_id)
 OR least(a.created_at+interval '24 hours',s.expires_at)<=clock_timestamp() OR NEW.detached_at IS NOT NULL
 OR ROW(NEW.owner_kind,NEW.resource_kind,NEW.content_version,NEW.slot,NEW.ordinal,NEW.manifest_digest) IS DISTINCT FROM ROW(a.owner_kind,a.resource_kind,a.content_version,a.slot,a.ordinal,a.manifest_digest)
 OR NEW.attach_evidence IS DISTINCT FROM jsonb_build_object('version',8,'scopeId',a.resource_id::text,'scopeRevision',a.scope_revision)
 OR c.transaction_id IS DISTINCT FROM pg_current_xact_id() OR c.scope_revision IS DISTINCT FROM a.scope_revision OR c.resource_id IS DISTINCT FROM NEW.resource_id OR c.content_version IS DISTINCT FROM 1::bigint
 OR c.attach_evidence IS DISTINCT FROM jsonb_build_object('version',8,'operation','select_category_icon','assets',jsonb_build_array(jsonb_build_object('assetId',a.id::text,'digest',a.manifest_digest))) THEN
 RAISE EXCEPTION 'Category icon binding requires exact current source in original owner transaction' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER media8_binding BEFORE INSERT ON whaleu_media.bindings FOR EACH ROW WHEN(NEW.owner_kind='ratings' AND NEW.resource_kind='category_icon') EXECUTE FUNCTION whaleu_media.category_icon_binding_guard();
CREATE CONSTRAINT TRIGGER media8_binding_final AFTER INSERT ON whaleu_media.bindings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.owner_kind='ratings' AND NEW.resource_kind='category_icon') EXECUTE FUNCTION whaleu_media.category_icon_binding_guard();
CREATE FUNCTION whaleu_media.category_icon_appearance_coupling() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM whaleu_ratings.category_icon_appearances p JOIN whaleu_media.assets a ON a.id=NEW.asset_id
 JOIN whaleu_ratings.category_icon_upload_scopes s ON s.id=a.resource_id AND s.actor_id=a.actor_id AND s.scope_revision=a.scope_revision
 WHERE p.id=NEW.resource_id AND p.actor_id=a.actor_id AND p.asset_id=a.id AND p.manifest_digest=NEW.manifest_digest AND p.media_binding_id=NEW.id
 AND p.category_id=s.category_id AND p.identity_id=s.identity_id AND p.origin=s.origin
 AND p.publication_transaction=pg_current_xact_id()) THEN
 RAISE EXCEPTION 'Media8 binding requires exact immutable Category appearance and slot origin' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER media8_appearance AFTER INSERT ON whaleu_media.bindings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.owner_kind='ratings' AND NEW.resource_kind='category_icon') EXECUTE FUNCTION whaleu_media.category_icon_appearance_coupling();
CREATE FUNCTION whaleu_media.category_icon_consumption_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actual jsonb;
BEGIN
 SELECT jsonb_agg(jsonb_build_object('assetId',a.id::text,'digest',a.manifest_digest) ORDER BY b.ordinal) INTO actual
 FROM whaleu_media.assets a JOIN whaleu_media.bindings b ON b.asset_id=a.id
 WHERE a.actor_id=NEW.actor_id AND a.owner_kind='ratings' AND a.resource_kind='category_icon' AND a.target_kind='edit'
 AND a.resource_id=NEW.scope_resource_id AND a.scope_revision=NEW.scope_revision
 AND b.owner_kind='ratings' AND b.resource_kind='category_icon' AND b.resource_id=NEW.resource_id AND b.content_version=1 AND b.slot='icon' AND b.ordinal=0 AND b.detached_at IS NULL;
 IF NEW.content_version<>1 OR actual IS NULL OR jsonb_array_length(actual)<>1 OR NEW.transaction_id<>pg_current_xact_id()
 OR NEW.attach_evidence IS DISTINCT FROM jsonb_build_object('version',8,'operation','select_category_icon','assets',actual) THEN
 RAISE EXCEPTION 'Category icon scope requires atomic exact single icon consumption' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER media8_scope_complete AFTER INSERT ON whaleu_media.scope_consumptions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.owner_kind='ratings' AND NEW.resource_kind='category_icon') EXECUTE FUNCTION whaleu_media.category_icon_consumption_complete();

-- Neither a replacement nor archive/hide/remove is a terminal retirement. The
-- original owner must prove no recoverable root/hold and record that exact tuple.
CREATE FUNCTION whaleu_media.category_icon_detach_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.detached_at IS NULL AND NEW.detached_at IS NOT NULL THEN
  IF NEW.detach_reason<>'ratings-category-icon-terminal-retirement' OR NOT EXISTS(
   SELECT 1 FROM whaleu_ratings.category_icon_terminal_retirements r JOIN whaleu_media.assets a ON a.id=NEW.asset_id
   WHERE r.appearance_id=NEW.resource_id AND r.asset_id=NEW.asset_id AND r.binding_id=NEW.id AND r.actor_id=a.actor_id
   AND r.manifest_digest=NEW.manifest_digest AND r.transaction_id=pg_current_xact_id()) THEN
   RAISE EXCEPTION 'Category icon detach requires exact owner-authorized terminal closure' USING ERRCODE='23514';END IF;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER media8_detach BEFORE UPDATE ON whaleu_media.bindings FOR EACH ROW WHEN(NEW.owner_kind='ratings' AND NEW.resource_kind='category_icon') EXECUTE FUNCTION whaleu_media.category_icon_detach_guard();
CREATE CONSTRAINT TRIGGER media8_detach_final AFTER UPDATE ON whaleu_media.bindings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.owner_kind='ratings' AND NEW.resource_kind='category_icon') EXECUTE FUNCTION whaleu_media.category_icon_detach_guard();
