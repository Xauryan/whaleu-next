-- Typed School Configuration QR Media9. Shared byte storage, quotas, lifecycle,
-- safety/Review facts and exact delivery are unchanged. No provider is enabled.
SET LOCAL lock_timeout='5s';
SELECT pg_advisory_xact_lock(hashtextextended('whaleu:named-block-policy:v1',0));
ALTER DOMAIN whaleu_media.audience DROP CONSTRAINT audience_check;
ALTER DOMAIN whaleu_media.audience ADD CONSTRAINT audience_check CHECK(VALUE IN ('content-gated','participant-private','conversation-private','profile-public','school-config-gated'));
ALTER TABLE whaleu_media.upload_request_fences DROP CONSTRAINT upload_request_fences_protocol_namespace_check;
ALTER TABLE whaleu_media.upload_request_fences ADD CONSTRAINT upload_request_fences_protocol_namespace_check CHECK(protocol_namespace IS NULL OR protocol_namespace IN (8,9));
ALTER TABLE whaleu_media.upload_intents DROP CONSTRAINT media_protocol_identity;
ALTER TABLE whaleu_media.upload_intents ADD CONSTRAINT media_protocol_identity CHECK(
 (protocol_version=1 AND request_hash IS NULL AND declared_sha256 IS NULL) OR
 (protocol_version IN (2,3,4,5,6,7,8,9) AND request_hash IS NOT NULL AND declared_sha256 IS NOT NULL));
ALTER TABLE whaleu_media.upload_intents DROP CONSTRAINT media_profile_scope;
ALTER TABLE whaleu_media.upload_intents ADD CONSTRAINT media_profile_scope CHECK(
 (protocol_version=5 AND owner_kind='profile' AND resource_kind='avatar' AND audience='profile-public'
 AND target_kind='edit' AND content_version=1 AND slot='avatar' AND ordinal=0 AND purpose='profile-avatar-image') OR
 (protocol_version<>5 AND owner_kind<>'profile' AND (target_kind<>'edit' OR protocol_version IN (6,8,9)) AND audience<>'profile-public' AND purpose<>'profile-avatar-image'));
ALTER TABLE whaleu_media.assets DROP CONSTRAINT media_profile_asset_scope;
ALTER TABLE whaleu_media.assets ADD CONSTRAINT media_profile_asset_scope CHECK(
 (owner_kind='profile' AND resource_kind='avatar' AND audience='profile-public' AND target_kind='edit'
 AND content_version=1 AND slot='avatar' AND ordinal=0 AND purpose='profile-avatar-image') OR
 (owner_kind<>'profile' AND (target_kind<>'edit' OR owner_kind IN ('ratings','school_configuration')) AND audience<>'profile-public' AND purpose<>'profile-avatar-image'));
ALTER TABLE whaleu_media.upload_intents ADD CONSTRAINT media_school_qr_scope CHECK(
 (protocol_version=9 AND owner_kind='school_configuration' AND resource_kind='entry_qr' AND audience='school-config-gated' AND purpose='school-configuration-qr-image' AND target_kind='edit' AND content_version=1 AND slot='qr' AND ordinal=0) OR
 (protocol_version<>9 AND owner_kind<>'school_configuration' AND resource_kind<>'entry_qr' AND audience<>'school-config-gated' AND purpose<>'school-configuration-qr-image'));
ALTER TABLE whaleu_media.assets ADD CONSTRAINT media_school_qr_asset_scope CHECK(
 (owner_kind='school_configuration' AND resource_kind='entry_qr' AND audience='school-config-gated' AND purpose='school-configuration-qr-image' AND target_kind='edit' AND content_version=1 AND slot='qr' AND ordinal=0) OR
 (owner_kind<>'school_configuration' AND resource_kind<>'entry_qr' AND audience<>'school-config-gated' AND purpose<>'school-configuration-qr-image'));
ALTER TABLE whaleu_media.bindings ADD CONSTRAINT media_school_qr_binding_scope CHECK(
 (owner_kind='school_configuration' AND resource_kind='entry_qr' AND content_version=1 AND slot='qr' AND ordinal=0) OR
 (owner_kind<>'school_configuration' AND resource_kind<>'entry_qr' AND slot<>'qr'));

CREATE TABLE whaleu_school_configuration.qr_upload_scopes(
 id uuid PRIMARY KEY,actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
 client_request_id uuid NOT NULL,region_id uuid NOT NULL REFERENCES whaleu_campus.operating_regions(id),
 entry_key text NOT NULL CHECK(entry_key IN ('treehole','trading','errand','review','official_account','admin')),
 expected_revision bigint NOT NULL CHECK(expected_revision>=0),scope_revision whaleu_media.digest NOT NULL,
 input jsonb NOT NULL,grant_id uuid NOT NULL REFERENCES whaleu_authorization.role_grants(id),
 created_at timestamptz NOT NULL DEFAULT statement_timestamp(),expires_at timestamptz NOT NULL DEFAULT statement_timestamp()+interval '30 minutes',
 UNIQUE(actor_id,client_request_id),CHECK(expires_at>created_at AND expires_at<=created_at+interval '30 minutes')
);
CREATE TABLE whaleu_school_configuration.qr_appearances(
 id uuid PRIMARY KEY,region_id uuid NOT NULL REFERENCES whaleu_campus.operating_regions(id),entry_key text NOT NULL,
 actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),asset_id uuid NOT NULL UNIQUE REFERENCES whaleu_media.assets(id),
 manifest_digest whaleu_media.digest NOT NULL,binding_id uuid NOT NULL UNIQUE REFERENCES whaleu_media.bindings(id) DEFERRABLE INITIALLY DEFERRED,
 entry_revision bigint NOT NULL CHECK(entry_revision>0),publication_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 UNIQUE(region_id,entry_key,entry_revision)
);
CREATE TABLE whaleu_school_configuration.qr_retirements(
 binding_id uuid PRIMARY KEY REFERENCES whaleu_media.bindings(id),actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
 region_id uuid NOT NULL,entry_key text NOT NULL,entry_revision bigint NOT NULL CHECK(entry_revision>0),
 transaction_id xid8 NOT NULL DEFAULT pg_current_xact_id()
);
DO $$DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['qr_upload_scopes','qr_appearances','qr_retirements'] LOOP
 EXECUTE format('CREATE TRIGGER a0_school_qr_policy BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_school_configuration.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.content_policy_writer_gate()',t);
 EXECUTE format('CREATE TRIGGER a1_school_qr_epoch BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_school_configuration.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_media.advance_owner_epoch()',t);
 EXECUTE format('CREATE TRIGGER school_qr_retain BEFORE TRUNCATE ON whaleu_school_configuration.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_media.immutable_record()',t);
 EXECUTE format('CREATE TRIGGER school_qr_immutable BEFORE UPDATE OR DELETE ON whaleu_school_configuration.%I FOR EACH ROW EXECUTE FUNCTION whaleu_media.immutable_record()',t);
 END LOOP;
END$$;
CREATE FUNCTION whaleu_school_configuration.qr_request_hash(actor uuid,v jsonb) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT encode(sha256(convert_to('whaleu-school-configuration-qr-prepare:v1'||chr(10)||
 '{"protocol":"school-configuration-qr-media-v1","actorAccountId":'||to_json(actor::text)::text||
 ',"clientRequestId":'||to_json(v->>'clientRequestId')::text||',"regionId":'||to_json(v->>'regionId')::text||
 ',"entryKey":'||to_json(v->>'entryKey')::text||',"expectedRevision":'||(v->>'expectedRevision')||
 ',"declaration":{"mime":'||to_json(v->'declaration'->>'mime')::text||',"bytes":'||(v->'declaration'->>'bytes')||
 ',"sha256":'||to_json(v->'declaration'->>'sha256')::text||'}}','UTF8')),'hex')
$$;
CREATE FUNCTION whaleu_school_configuration.qr_scope_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v jsonb;g whaleu_authorization.role_grants;BEGIN
 v:=NEW.input;SELECT * INTO g FROM whaleu_authorization.role_grants WHERE id=NEW.grant_id;
 IF NOT coalesce(whaleu_community.rating_scoped_keys(v,ARRAY['protocol','clientRequestId','regionId','entryKey','expectedRevision','declaration'])
 AND v->>'protocol'='school-configuration-qr-media-v1' AND v->>'clientRequestId'=NEW.client_request_id::text
 AND v->>'regionId'=NEW.region_id::text AND v->>'entryKey'=NEW.entry_key AND (v->>'expectedRevision')::bigint=NEW.expected_revision
 AND jsonb_typeof(v->'expectedRevision')='number' AND v->>'expectedRevision' ~ '^(0|[1-9][0-9]*)$' AND NEW.expected_revision<=9007199254740990
 AND NEW.scope_revision=whaleu_school_configuration.qr_request_hash(NEW.actor_id,v)
 AND whaleu_community.rating_scoped_keys(v->'declaration',ARRAY['mime','bytes','sha256'])
 AND v->'declaration'->>'mime' IN ('image/jpeg','image/png')
 AND whaleu_community.rating_scoped_integer(v->'declaration'->'bytes',1) AND (v->'declaration'->>'bytes')::bigint BETWEEN 1 AND 5242880 AND v->'declaration'->>'sha256' ~ '^[a-f0-9]{64}$'
 AND g.account_id=NEW.actor_id AND g.revoked_at IS NULL AND g.valid_from<=clock_timestamp() AND (g.expires_at IS NULL OR g.expires_at>clock_timestamp())
 AND (g.role='super_admin' OR (g.role='school_admin' AND g.operating_region_id=NEW.region_id))
 AND EXISTS(SELECT 1 FROM whaleu_campus.operating_regions r WHERE r.id=NEW.region_id AND r.is_active)
 AND coalesce((SELECT revision FROM whaleu_school_configuration.entries WHERE region_id=NEW.region_id AND entry_key=NEW.entry_key),0)=NEW.expected_revision,false)
 THEN RAISE EXCEPTION 'School QR scope requires exact current school management CAS' USING ERRCODE='23514';END IF;RETURN NEW;
END$$;
CREATE TRIGGER school_qr_scope BEFORE INSERT ON whaleu_school_configuration.qr_upload_scopes FOR EACH ROW EXECUTE FUNCTION whaleu_school_configuration.qr_scope_guard();

-- Protocol routing adds typed9 guards, preserving the original function bodies.
DROP TRIGGER media_binding_guard ON whaleu_media.bindings;
CREATE TRIGGER media_binding_guard BEFORE INSERT ON whaleu_media.bindings FOR EACH ROW
 WHEN(NEW.owner_kind<>'school_configuration' AND NOT(NEW.owner_kind='ratings' AND NEW.resource_kind IN ('rating_comment','rating_reply','category_icon'))) EXECUTE FUNCTION whaleu_media.binding_guard();
DROP TRIGGER media_scope_consumption_complete ON whaleu_media.scope_consumptions;
CREATE CONSTRAINT TRIGGER media_scope_consumption_complete AFTER INSERT ON whaleu_media.scope_consumptions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 WHEN(NEW.owner_kind<>'school_configuration' AND NOT(NEW.owner_kind='ratings' AND NEW.resource_kind IN ('rating_comment','rating_reply','category_icon'))) EXECUTE FUNCTION whaleu_media.scope_consumption_complete();
CREATE FUNCTION whaleu_school_configuration.qr_namespace_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE f whaleu_media.upload_request_fences;i whaleu_media.upload_intents;actor uuid;request uuid;BEGIN
 actor:=NEW.actor_id;
 IF TG_TABLE_NAME='ratings_discussion_batch_request_fences' THEN request:=NEW.batch_request_id;ELSE request:=NEW.client_request_id;END IF;
 SELECT * INTO f FROM whaleu_media.upload_request_fences WHERE actor_id=actor AND client_request_id=request;
 IF f.protocol_namespace IS DISTINCT FROM 9 THEN
  IF TG_TABLE_NAME='upload_intents' THEN
   IF NEW.protocol_version=9 THEN RAISE EXCEPTION 'School QR requires Media9 receipt' USING ERRCODE='23514';END IF;
  END IF;RETURN NULL;
 END IF;
 IF EXISTS(SELECT 1 FROM whaleu_media.profile_request_markers WHERE actor_id=actor AND client_request_id=request)
 OR EXISTS(SELECT 1 FROM whaleu_media.ratings_request_markers WHERE actor_id=actor AND client_request_id=request)
 OR EXISTS(SELECT 1 FROM whaleu_media.ratings_discussion_request_markers WHERE actor_id=actor AND client_request_id=request)
 OR EXISTS(SELECT 1 FROM whaleu_media.category_icon_request_markers WHERE actor_id=actor AND client_request_id=request)
 OR EXISTS(SELECT 1 FROM whaleu_media.ratings_discussion_batch_request_fences WHERE actor_id=actor AND batch_request_id=request)
 THEN RAISE EXCEPTION 'School QR request namespace is exclusive' USING ERRCODE='23514';END IF;
 IF f.intent_id IS NOT NULL THEN
 SELECT * INTO STRICT i FROM whaleu_media.upload_intents WHERE id=f.intent_id;
 IF i.protocol_version<>9 OR (i.actor_id,i.client_request_id,i.request_hash) IS DISTINCT FROM (actor,request,f.request_hash)
 THEN RAISE EXCEPTION 'School QR exact receipt mismatch' USING ERRCODE='23514';END IF;END IF;
 IF TG_TABLE_NAME='upload_intents' THEN
 IF NEW.protocol_version<>9 OR f.intent_id IS DISTINCT FROM NEW.id THEN RAISE EXCEPTION 'School QR intent mismatch' USING ERRCODE='23514';END IF;END IF;
 RETURN NULL;
END$$;
DO $$DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['upload_intents','upload_request_fences','profile_request_markers','ratings_request_markers','ratings_discussion_request_markers','category_icon_request_markers','ratings_discussion_batch_request_fences'] LOOP
 EXECUTE format('CREATE CONSTRAINT TRIGGER school_qr_namespace AFTER INSERT OR UPDATE ON whaleu_media.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_school_configuration.qr_namespace_guard()',t);
 END LOOP;
END$$;
CREATE FUNCTION whaleu_school_configuration.qr_intent_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s whaleu_school_configuration.qr_upload_scopes;BEGIN
 SELECT * INTO s FROM whaleu_school_configuration.qr_upload_scopes WHERE id=NEW.resource_id AND actor_id=NEW.actor_id;
 IF s.id IS NULL OR (NEW.client_request_id,NEW.scope_revision,NEW.request_hash,NEW.expires_at) IS DISTINCT FROM (s.client_request_id,s.scope_revision,s.scope_revision,s.expires_at)
 OR NEW.declared_bytes<>(s.input->'declaration'->>'bytes')::bigint OR NEW.declared_mime<>s.input->'declaration'->>'mime' OR NEW.declared_sha256<>s.input->'declaration'->>'sha256'
 THEN RAISE EXCEPTION 'School QR intent requires exact original owner scope' USING ERRCODE='23514';END IF;RETURN NEW;
END$$;
CREATE TRIGGER school_qr_intent BEFORE INSERT ON whaleu_media.upload_intents FOR EACH ROW WHEN(NEW.protocol_version=9) EXECUTE FUNCTION whaleu_school_configuration.qr_intent_guard();
CREATE FUNCTION whaleu_school_configuration.qr_binding_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a whaleu_media.assets;i whaleu_media.upload_intents;s whaleu_school_configuration.qr_upload_scopes;c whaleu_media.scope_consumptions;BEGIN
 SELECT * INTO STRICT a FROM whaleu_media.assets WHERE id=NEW.asset_id;
 SELECT * INTO STRICT i FROM whaleu_media.upload_intents WHERE id=a.intent_id;
 SELECT * INTO s FROM whaleu_school_configuration.qr_upload_scopes WHERE id=a.resource_id AND actor_id=a.actor_id;
 SELECT * INTO c FROM whaleu_media.scope_consumptions WHERE actor_id=a.actor_id AND owner_kind='school_configuration' AND resource_kind='entry_qr' AND scope_resource_id=a.resource_id;
 IF i.protocol_version<>9 OR i.state<>'ready' OR s.id IS NULL OR least(s.expires_at,a.created_at+interval '24 hours')<=clock_timestamp()
 OR NEW.detached_at IS NOT NULL OR (NEW.owner_kind,NEW.resource_kind,NEW.content_version,NEW.slot,NEW.ordinal,NEW.manifest_digest) IS DISTINCT FROM (a.owner_kind,a.resource_kind,a.content_version,a.slot,a.ordinal,a.manifest_digest)
 OR NEW.attach_evidence IS DISTINCT FROM jsonb_build_object('version',9,'scopeId',a.resource_id::text,'scopeRevision',a.scope_revision)
 OR c.transaction_id IS DISTINCT FROM pg_current_xact_id() OR c.resource_id IS DISTINCT FROM NEW.resource_id OR c.scope_revision IS DISTINCT FROM a.scope_revision OR c.content_version IS DISTINCT FROM 1::bigint
 OR c.attach_evidence IS DISTINCT FROM jsonb_build_object('version',9,'assets',jsonb_build_array(jsonb_build_object('assetId',a.id::text,'digest',a.manifest_digest)))
 OR NOT EXISTS(SELECT 1 FROM whaleu_media.asset_safety_heads h JOIN whaleu_media.asset_safety_events e ON (e.asset_id,e.revision,e.id)=(h.asset_id,h.revision,h.event_id)
 WHERE h.asset_id=a.id AND e.state='allow' AND e.manifest_digest=a.manifest_digest AND e.policy_revision=a.policy_revision AND e.effective_at<=clock_timestamp() AND e.valid_until>clock_timestamp())
 THEN RAISE EXCEPTION 'School QR binding requires current exact Media9 acceptance' USING ERRCODE='23514';END IF;
 IF TG_WHEN='AFTER' AND NOT EXISTS(SELECT 1 FROM whaleu_school_configuration.qr_appearances p JOIN whaleu_school_configuration.entries e ON (e.region_id,e.entry_key)=(p.region_id,p.entry_key)
 WHERE p.id=NEW.resource_id AND p.binding_id=NEW.id AND p.asset_id=a.id AND p.manifest_digest=a.manifest_digest AND p.actor_id=a.actor_id AND (p.region_id,p.entry_key,p.entry_revision)=(s.region_id,s.entry_key,s.expected_revision+1)
 AND p.publication_transaction=pg_current_xact_id() AND e.qr_binding_id=NEW.id AND e.revision=p.entry_revision)
 THEN RAISE EXCEPTION 'School QR binding must publish exact owner entry atomically' USING ERRCODE='23514';END IF;RETURN NEW;
END$$;
CREATE TRIGGER school_qr_binding BEFORE INSERT ON whaleu_media.bindings FOR EACH ROW WHEN(NEW.owner_kind='school_configuration') EXECUTE FUNCTION whaleu_school_configuration.qr_binding_guard();
CREATE CONSTRAINT TRIGGER school_qr_binding_final AFTER INSERT ON whaleu_media.bindings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.owner_kind='school_configuration') EXECUTE FUNCTION whaleu_school_configuration.qr_binding_guard();
CREATE FUNCTION whaleu_school_configuration.qr_consumption_guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF NEW.transaction_id<>pg_current_xact_id() OR NOT EXISTS(SELECT 1 FROM whaleu_media.bindings b JOIN whaleu_media.assets a ON a.id=b.asset_id WHERE b.owner_kind='school_configuration' AND b.resource_kind='entry_qr' AND b.resource_id=NEW.resource_id AND b.detached_at IS NULL AND a.resource_id=NEW.scope_resource_id AND a.actor_id=NEW.actor_id AND a.scope_revision=NEW.scope_revision)
 THEN RAISE EXCEPTION 'School QR consumption requires atomic original binding' USING ERRCODE='23514';END IF;RETURN NULL;END$$;
CREATE CONSTRAINT TRIGGER school_qr_consumption_final AFTER INSERT ON whaleu_media.scope_consumptions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.owner_kind='school_configuration') EXECUTE FUNCTION whaleu_school_configuration.qr_consumption_guard();
CREATE FUNCTION whaleu_school_configuration.qr_detach_guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF OLD.detached_at IS NULL AND NEW.detached_at IS NOT NULL AND (NEW.detach_reason<>'school-configuration-qr-replaced' OR NOT EXISTS(SELECT 1 FROM whaleu_school_configuration.qr_retirements r WHERE r.binding_id=NEW.id AND r.transaction_id=pg_current_xact_id()))
 THEN RAISE EXCEPTION 'School QR detach requires original owner retirement' USING ERRCODE='23514';END IF;RETURN NEW;END$$;
CREATE TRIGGER school_qr_detach BEFORE UPDATE ON whaleu_media.bindings FOR EACH ROW WHEN(NEW.owner_kind='school_configuration') EXECUTE FUNCTION whaleu_school_configuration.qr_detach_guard();
CREATE FUNCTION whaleu_school_configuration.qr_retirement_guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF NEW.transaction_id<>pg_current_xact_id() OR NOT EXISTS(SELECT 1 FROM whaleu_school_configuration.entries e JOIN whaleu_school_configuration.qr_appearances p ON (p.region_id,p.entry_key)=(e.region_id,e.entry_key) JOIN whaleu_media.bindings b ON b.id=p.binding_id
 WHERE p.binding_id=NEW.binding_id AND (e.region_id,e.entry_key,e.revision)=(NEW.region_id,NEW.entry_key,NEW.entry_revision) AND e.qr_binding_id IS DISTINCT FROM NEW.binding_id AND e.actor_id=NEW.actor_id AND b.detached_at IS NOT NULL
 AND b.detach_reason='school-configuration-qr-replaced' AND (b.owner_kind,b.resource_kind,b.resource_id,b.asset_id,b.manifest_digest) = ('school_configuration','entry_qr',p.id,p.asset_id,p.manifest_digest))
 THEN RAISE EXCEPTION 'School QR retirement requires exact atomic replacement or removal' USING ERRCODE='23514';END IF;RETURN NULL;END$$;
CREATE CONSTRAINT TRIGGER school_qr_retirement_final AFTER INSERT ON whaleu_school_configuration.qr_retirements DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_school_configuration.qr_retirement_guard();
-- The pointer is checked in both directions. A valid text publication/hash does
-- not authorize foreign Media, resurrect a detached binding or skip retirement.
CREATE FUNCTION whaleu_school_configuration.qr_entry_pointer_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p whaleu_school_configuration.qr_appearances;b whaleu_media.bindings;prior uuid;BEGIN
 prior:=CASE WHEN TG_OP='UPDATE' THEN OLD.qr_binding_id ELSE NULL END;
 IF NEW.qr_binding_id IS NOT NULL THEN
  SELECT * INTO p FROM whaleu_school_configuration.qr_appearances WHERE binding_id=NEW.qr_binding_id;
  SELECT * INTO b FROM whaleu_media.bindings WHERE id=NEW.qr_binding_id;
  IF p.id IS NULL OR b.id IS NULL OR b.detached_at IS NOT NULL
   OR (p.region_id,p.entry_key) IS DISTINCT FROM (NEW.region_id,NEW.entry_key)
   OR (b.owner_kind,b.resource_kind,b.resource_id,b.asset_id,b.manifest_digest,b.content_version,b.slot,b.ordinal) IS DISTINCT FROM ('school_configuration','entry_qr',p.id,p.asset_id,p.manifest_digest,1::bigint,'qr',0)
   OR (NEW.qr_binding_id IS DISTINCT FROM prior AND (p.entry_revision<>NEW.revision OR p.actor_id<>NEW.actor_id OR p.publication_transaction<>pg_current_xact_id()))
  THEN RAISE EXCEPTION 'School entry requires exact current same-entry QR appearance' USING ERRCODE='23514';END IF;
 END IF;
 IF prior IS NOT NULL AND prior IS DISTINCT FROM NEW.qr_binding_id AND NOT EXISTS(
  SELECT 1 FROM whaleu_school_configuration.qr_retirements r WHERE r.binding_id=prior AND r.actor_id=NEW.actor_id
   AND (r.region_id,r.entry_key,r.entry_revision)=(NEW.region_id,NEW.entry_key,NEW.revision) AND r.transaction_id=pg_current_xact_id())
 THEN RAISE EXCEPTION 'School entry replacement must retire its original QR atomically' USING ERRCODE='23514';END IF;
 RETURN NULL;
END$$;
CREATE CONSTRAINT TRIGGER school_qr_entry_pointer_final AFTER INSERT OR UPDATE ON whaleu_school_configuration.entries
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_school_configuration.qr_entry_pointer_guard();

-- Reverse causality: an appearance cannot be manufactured independently of its
-- original typed9 binding and the same owner publication transaction.
CREATE FUNCTION whaleu_school_configuration.qr_appearance_guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF NEW.publication_transaction<>pg_current_xact_id() OR NOT EXISTS(
  SELECT 1 FROM whaleu_media.bindings b JOIN whaleu_media.assets a ON a.id=b.asset_id
   JOIN whaleu_media.upload_intents i ON i.id=a.intent_id
   JOIN whaleu_school_configuration.qr_upload_scopes s ON s.id=a.resource_id AND s.actor_id=a.actor_id AND s.scope_revision=a.scope_revision
   JOIN whaleu_school_configuration.entries e ON (e.region_id,e.entry_key)=(s.region_id,s.entry_key)
  WHERE i.protocol_version=9 AND b.id=NEW.binding_id AND b.detached_at IS NULL
   AND (b.owner_kind,b.resource_kind,b.resource_id,b.asset_id,b.manifest_digest)=('school_configuration','entry_qr',NEW.id,NEW.asset_id,NEW.manifest_digest)
   AND a.actor_id=NEW.actor_id AND (s.region_id,s.entry_key,s.expected_revision+1)=(NEW.region_id,NEW.entry_key,NEW.entry_revision)
   AND (e.revision,e.actor_id,e.qr_binding_id)=(NEW.entry_revision,NEW.actor_id,NEW.binding_id))
 THEN RAISE EXCEPTION 'School QR appearance requires exact atomic owner publication' USING ERRCODE='23514';END IF;
 RETURN NULL;
END$$;
CREATE CONSTRAINT TRIGGER school_qr_appearance_final AFTER INSERT ON whaleu_school_configuration.qr_appearances
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_school_configuration.qr_appearance_guard();
