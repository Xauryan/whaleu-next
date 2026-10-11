-- Typed Announcement Media12. Shared byte storage, quotas, lifecycle,
-- safety/Review facts and exact delivery are unchanged. No provider is enabled.
SET LOCAL lock_timeout='5s';
SELECT pg_advisory_xact_lock(hashtextextended('whaleu:named-block-policy:v1',0));
ALTER DOMAIN whaleu_media.audience DROP CONSTRAINT audience_check;
ALTER DOMAIN whaleu_media.audience ADD CONSTRAINT audience_check CHECK(VALUE IN ('content-gated','participant-private','conversation-private','profile-public','school-config-gated','organization-gated','activity-gated','announcement-gated'));
ALTER TABLE whaleu_media.upload_request_fences DROP CONSTRAINT upload_request_fences_protocol_namespace_check;
ALTER TABLE whaleu_media.upload_request_fences ADD CONSTRAINT upload_request_fences_protocol_namespace_check CHECK(protocol_namespace IS NULL OR protocol_namespace IN (8,9,10,11,12));
ALTER TABLE whaleu_media.upload_intents DROP CONSTRAINT media_protocol_identity;
ALTER TABLE whaleu_media.upload_intents ADD CONSTRAINT media_protocol_identity CHECK(
 (protocol_version=1 AND request_hash IS NULL AND declared_sha256 IS NULL) OR
 (protocol_version IN (2,3,4,5,6,7,8,9,10,11,12) AND request_hash IS NOT NULL AND declared_sha256 IS NOT NULL));
ALTER TABLE whaleu_media.upload_intents DROP CONSTRAINT media_profile_scope;
ALTER TABLE whaleu_media.upload_intents ADD CONSTRAINT media_profile_scope CHECK(
 (protocol_version=5 AND owner_kind='profile' AND resource_kind='avatar' AND audience='profile-public'
 AND target_kind='edit' AND content_version=1 AND slot='avatar' AND ordinal=0 AND purpose='profile-avatar-image') OR
 (protocol_version<>5 AND owner_kind<>'profile' AND (target_kind<>'edit' OR protocol_version IN (6,8,9,10,11,12)) AND audience<>'profile-public' AND purpose<>'profile-avatar-image'));
ALTER TABLE whaleu_media.assets DROP CONSTRAINT media_profile_asset_scope;
ALTER TABLE whaleu_media.assets ADD CONSTRAINT media_profile_asset_scope CHECK(
 (owner_kind='profile' AND resource_kind='avatar' AND audience='profile-public' AND target_kind='edit'
 AND content_version=1 AND slot='avatar' AND ordinal=0 AND purpose='profile-avatar-image') OR
 (owner_kind<>'profile' AND (target_kind<>'edit' OR owner_kind IN ('ratings','school_configuration','organizations','activities','announcements')) AND audience<>'profile-public' AND purpose<>'profile-avatar-image'));
ALTER TABLE whaleu_media.upload_intents ADD CONSTRAINT media_announcement_media_scope CHECK(
 (protocol_version=12 AND owner_kind='announcements' AND resource_kind='announcement_image' AND audience='announcement-gated' AND purpose='announcement-image' AND target_kind='edit' AND content_version=1 AND slot IN ('gallery0','gallery1','gallery2','gallery3','gallery4','gallery5','gallery6','gallery7','gallery8') AND ordinal=0) OR
 (protocol_version<>12 AND owner_kind<>'announcements' AND resource_kind<>'announcement_image' AND audience<>'announcement-gated' AND purpose<>'announcement-image'));
ALTER TABLE whaleu_media.assets ADD CONSTRAINT media_announcement_media_asset_scope CHECK(
 (owner_kind='announcements' AND resource_kind='announcement_image' AND audience='announcement-gated' AND purpose='announcement-image' AND target_kind='edit' AND content_version=1 AND slot IN ('gallery0','gallery1','gallery2','gallery3','gallery4','gallery5','gallery6','gallery7','gallery8') AND ordinal=0) OR
 (owner_kind<>'announcements' AND resource_kind<>'announcement_image' AND audience<>'announcement-gated' AND purpose<>'announcement-image'));
ALTER TABLE whaleu_media.bindings ADD CONSTRAINT media_announcement_media_binding_scope CHECK(
 (owner_kind='announcements' AND resource_kind='announcement_image' AND content_version=1 AND slot IN ('gallery0','gallery1','gallery2','gallery3','gallery4','gallery5','gallery6','gallery7','gallery8') AND ordinal=0) OR
 (owner_kind<>'announcements' AND resource_kind<>'announcement_image'));

CREATE TABLE whaleu_announcements.media_upload_scopes(
 id uuid PRIMARY KEY,actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
 client_request_id uuid NOT NULL,announcement_id uuid NOT NULL REFERENCES whaleu_announcements.native_announcements(id),
 slot text NOT NULL CHECK(slot IN ('gallery0','gallery1','gallery2','gallery3','gallery4','gallery5','gallery6','gallery7','gallery8')),
 revision bigint NOT NULL CHECK(revision>0),scope_revision whaleu_media.digest NOT NULL,
 input jsonb NOT NULL,authority_version text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT statement_timestamp(),expires_at timestamptz NOT NULL DEFAULT statement_timestamp()+interval '30 minutes',
 UNIQUE(actor_id,client_request_id),CHECK(expires_at>created_at AND expires_at<=created_at+interval '30 minutes')
);
CREATE TABLE whaleu_announcements.media_appearances(
 id uuid PRIMARY KEY,announcement_id uuid NOT NULL REFERENCES whaleu_announcements.native_announcements(id),slot text NOT NULL,
 actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),asset_id uuid NOT NULL UNIQUE REFERENCES whaleu_media.assets(id),
 manifest_digest whaleu_media.digest NOT NULL,binding_id uuid NOT NULL UNIQUE REFERENCES whaleu_media.bindings(id) DEFERRABLE INITIALLY DEFERRED,
 revision bigint NOT NULL CHECK(revision>0),publication_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 UNIQUE(announcement_id,slot,revision)
);
CREATE TABLE whaleu_announcements.media_retirements(
 binding_id uuid PRIMARY KEY REFERENCES whaleu_media.bindings(id),actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
 announcement_id uuid NOT NULL,slot text NOT NULL,revision bigint NOT NULL CHECK(revision>0),
 transaction_id xid8 NOT NULL DEFAULT pg_current_xact_id()
);
DO $$DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['media_upload_scopes','media_appearances','media_retirements'] LOOP
 EXECUTE format('CREATE TRIGGER a0_announcement_media_policy BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_announcements.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.content_policy_writer_gate()',t);
 EXECUTE format('CREATE TRIGGER a1_announcement_media_epoch BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_announcements.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_media.advance_owner_epoch()',t);
 EXECUTE format('CREATE TRIGGER announcement_media_retain BEFORE TRUNCATE ON whaleu_announcements.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_media.immutable_record()',t);
 EXECUTE format('CREATE TRIGGER announcement_media_immutable BEFORE UPDATE OR DELETE ON whaleu_announcements.%I FOR EACH ROW EXECUTE FUNCTION whaleu_media.immutable_record()',t);
 END LOOP;
END$$;
CREATE FUNCTION whaleu_announcements.media_request_hash(actor uuid,v jsonb) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT encode(sha256(convert_to('whaleu-announcement-media-prepare:v1'||chr(10)||
 '{"protocol":"announcement-media-v1","actorAccountId":'||to_json(actor::text)::text||
 ',"clientRequestId":'||to_json(v->>'clientRequestId')::text||',"announcementId":'||to_json(v->>'announcementId')::text||
 ',"slot":'||to_json(v->>'slot')::text||',"revision":'||(v->>'revision')||
 ',"declaration":{"mime":'||to_json(v->'declaration'->>'mime')::text||',"bytes":'||(v->'declaration'->>'bytes')||
 ',"sha256":'||to_json(v->'declaration'->>'sha256')::text||'}}','UTF8')),'hex')
$$;
CREATE FUNCTION whaleu_announcements.media_scope_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v jsonb;BEGIN
 v:=NEW.input;
 IF NOT coalesce(whaleu_community.rating_scoped_keys(v,ARRAY['protocol','clientRequestId','announcementId','slot','revision','declaration'])
 AND v->>'protocol'='announcement-media-v1' AND v->>'clientRequestId'=NEW.client_request_id::text
 AND v->>'announcementId'=NEW.announcement_id::text AND v->>'slot'=NEW.slot AND (v->>'revision')::bigint=NEW.revision
 AND jsonb_typeof(v->'revision')='number' AND v->>'revision' ~ '^[1-9][0-9]*$' AND NEW.revision<=9007199254740990
 AND NEW.scope_revision=whaleu_announcements.media_request_hash(NEW.actor_id,v)
 AND whaleu_community.rating_scoped_keys(v->'declaration',ARRAY['mime','bytes','sha256'])
 AND v->'declaration'->>'mime' IN ('image/jpeg','image/png')
 AND whaleu_community.rating_scoped_integer(v->'declaration'->'bytes',1) AND (v->'declaration'->>'bytes')::bigint BETWEEN 1 AND 5242880 AND v->'declaration'->>'sha256' ~ '^[a-f0-9]{64}$'
 AND whaleu_announcements.media_actor_current(NEW.actor_id,NEW.announcement_id,NEW.revision,NEW.authority_version),false)
 THEN RAISE EXCEPTION 'Announcement image scope requires exact current announcement authority' USING ERRCODE='23514';END IF;RETURN NEW;
END$$;
CREATE TRIGGER announcement_media_scope BEFORE INSERT ON whaleu_announcements.media_upload_scopes FOR EACH ROW EXECUTE FUNCTION whaleu_announcements.media_scope_guard();

-- Protocol routing adds typed12 guards, preserving the original function bodies.
DROP TRIGGER media_binding_guard ON whaleu_media.bindings;
CREATE TRIGGER media_binding_guard BEFORE INSERT ON whaleu_media.bindings FOR EACH ROW
 WHEN(NEW.owner_kind NOT IN ('announcements','activities','organizations','school_configuration') AND NOT(NEW.owner_kind='ratings' AND NEW.resource_kind IN ('rating_comment','rating_reply','category_icon'))) EXECUTE FUNCTION whaleu_media.binding_guard();
DROP TRIGGER media_scope_consumption_complete ON whaleu_media.scope_consumptions;
CREATE CONSTRAINT TRIGGER media_scope_consumption_complete AFTER INSERT ON whaleu_media.scope_consumptions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 WHEN(NEW.owner_kind NOT IN ('announcements','activities','organizations','school_configuration') AND NOT(NEW.owner_kind='ratings' AND NEW.resource_kind IN ('rating_comment','rating_reply','category_icon'))) EXECUTE FUNCTION whaleu_media.scope_consumption_complete();
CREATE FUNCTION whaleu_announcements.media_namespace_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE f whaleu_media.upload_request_fences;i whaleu_media.upload_intents;actor uuid;request uuid;BEGIN
 actor:=NEW.actor_id;
 IF TG_TABLE_NAME='ratings_discussion_batch_request_fences' THEN request:=NEW.batch_request_id;ELSE request:=NEW.client_request_id;END IF;
 SELECT * INTO f FROM whaleu_media.upload_request_fences WHERE actor_id=actor AND client_request_id=request;
 IF f.protocol_namespace IS DISTINCT FROM 12 THEN
  IF TG_TABLE_NAME='upload_intents' THEN
   IF NEW.protocol_version=12 THEN RAISE EXCEPTION 'Announcement image requires Media12 receipt' USING ERRCODE='23514';END IF;
  END IF;RETURN NULL;
 END IF;
 IF EXISTS(SELECT 1 FROM whaleu_media.profile_request_markers WHERE actor_id=actor AND client_request_id=request)
 OR EXISTS(SELECT 1 FROM whaleu_media.ratings_request_markers WHERE actor_id=actor AND client_request_id=request)
 OR EXISTS(SELECT 1 FROM whaleu_media.ratings_discussion_request_markers WHERE actor_id=actor AND client_request_id=request)
 OR EXISTS(SELECT 1 FROM whaleu_media.category_icon_request_markers WHERE actor_id=actor AND client_request_id=request)
 OR EXISTS(SELECT 1 FROM whaleu_media.ratings_discussion_batch_request_fences WHERE actor_id=actor AND batch_request_id=request)
 THEN RAISE EXCEPTION 'Announcement image request namespace is exclusive' USING ERRCODE='23514';END IF;
 IF f.intent_id IS NOT NULL THEN
 SELECT * INTO STRICT i FROM whaleu_media.upload_intents WHERE id=f.intent_id;
 IF i.protocol_version<>12 OR (i.actor_id,i.client_request_id,i.request_hash) IS DISTINCT FROM (actor,request,f.request_hash)
 THEN RAISE EXCEPTION 'Announcement image exact receipt mismatch' USING ERRCODE='23514';END IF;END IF;
 IF TG_TABLE_NAME='upload_intents' THEN
 IF NEW.protocol_version<>12 OR f.intent_id IS DISTINCT FROM NEW.id THEN RAISE EXCEPTION 'Announcement image intent mismatch' USING ERRCODE='23514';END IF;END IF;
 RETURN NULL;
END$$;
DO $$DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['upload_intents','upload_request_fences','profile_request_markers','ratings_request_markers','ratings_discussion_request_markers','category_icon_request_markers','ratings_discussion_batch_request_fences'] LOOP
 EXECUTE format('CREATE CONSTRAINT TRIGGER announcement_media_namespace AFTER INSERT OR UPDATE ON whaleu_media.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_announcements.media_namespace_guard()',t);
 END LOOP;
END$$;
CREATE FUNCTION whaleu_announcements.media_intent_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s whaleu_announcements.media_upload_scopes;BEGIN
 SELECT * INTO s FROM whaleu_announcements.media_upload_scopes WHERE id=NEW.resource_id AND actor_id=NEW.actor_id;
 IF s.id IS NULL OR (NEW.client_request_id,NEW.scope_revision,NEW.request_hash,NEW.expires_at) IS DISTINCT FROM (s.client_request_id,s.scope_revision,s.scope_revision,s.expires_at)
 OR NEW.declared_bytes<>(s.input->'declaration'->>'bytes')::bigint OR NEW.declared_mime<>s.input->'declaration'->>'mime' OR NEW.declared_sha256<>s.input->'declaration'->>'sha256'
 THEN RAISE EXCEPTION 'Announcement image intent requires exact original owner scope' USING ERRCODE='23514';END IF;RETURN NEW;
END$$;
CREATE TRIGGER announcement_media_intent BEFORE INSERT ON whaleu_media.upload_intents FOR EACH ROW WHEN(NEW.protocol_version=12) EXECUTE FUNCTION whaleu_announcements.media_intent_guard();
CREATE FUNCTION whaleu_announcements.media_binding_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a whaleu_media.assets;i whaleu_media.upload_intents;s whaleu_announcements.media_upload_scopes;c whaleu_media.scope_consumptions;BEGIN
 SELECT * INTO STRICT a FROM whaleu_media.assets WHERE id=NEW.asset_id;
 SELECT * INTO STRICT i FROM whaleu_media.upload_intents WHERE id=a.intent_id;
 SELECT * INTO s FROM whaleu_announcements.media_upload_scopes WHERE id=a.resource_id AND actor_id=a.actor_id;
 SELECT * INTO c FROM whaleu_media.scope_consumptions WHERE actor_id=a.actor_id AND owner_kind='announcements' AND resource_kind='announcement_image' AND scope_resource_id=a.resource_id;
 IF i.protocol_version<>12 OR i.state<>'ready' OR s.id IS NULL OR least(s.expires_at,a.created_at+interval '24 hours')<=clock_timestamp()
 OR NEW.detached_at IS NOT NULL OR (NEW.owner_kind,NEW.resource_kind,NEW.content_version,NEW.slot,NEW.ordinal,NEW.manifest_digest) IS DISTINCT FROM (a.owner_kind,a.resource_kind,a.content_version,a.slot,a.ordinal,a.manifest_digest)
 OR NEW.attach_evidence IS DISTINCT FROM jsonb_build_object('version',12,'scopeId',a.resource_id::text,'scopeRevision',a.scope_revision)
 OR c.transaction_id IS DISTINCT FROM pg_current_xact_id() OR c.resource_id IS DISTINCT FROM NEW.resource_id OR c.scope_revision IS DISTINCT FROM a.scope_revision OR c.content_version IS DISTINCT FROM 1::bigint
 OR c.attach_evidence IS DISTINCT FROM jsonb_build_object('version',12,'assets',jsonb_build_array(jsonb_build_object('assetId',a.id::text,'digest',a.manifest_digest)))
 OR NOT EXISTS(SELECT 1 FROM whaleu_media.asset_safety_heads h JOIN whaleu_media.asset_safety_events e ON (e.asset_id,e.revision,e.id)=(h.asset_id,h.revision,h.event_id)
 WHERE h.asset_id=a.id AND e.state='allow' AND e.manifest_digest=a.manifest_digest AND e.policy_revision=a.policy_revision AND e.effective_at<=clock_timestamp() AND e.valid_until>clock_timestamp())
 OR (TG_WHEN='BEFORE' AND NOT whaleu_announcements.media_actor_current(a.actor_id,s.announcement_id,s.revision,s.authority_version))
 THEN RAISE EXCEPTION 'Announcement image binding requires current exact Media12 acceptance' USING ERRCODE='23514';END IF;
 IF TG_WHEN='AFTER' AND NOT EXISTS(SELECT 1 FROM whaleu_announcements.media_appearances p JOIN whaleu_announcements.native_announcements o ON o.id=p.announcement_id
 WHERE p.id=NEW.resource_id AND p.binding_id=NEW.id AND p.asset_id=a.id AND p.manifest_digest=a.manifest_digest AND p.actor_id=a.actor_id AND (p.announcement_id,p.slot,p.revision)=(s.announcement_id,s.slot,s.revision+1)
 AND p.publication_transaction=pg_current_xact_id() AND o.media_bindings->>p.slot=NEW.id::text AND o.revision=p.revision AND whaleu_announcements.media_content_writer(o.id,o.revision)=p.actor_id)
 THEN RAISE EXCEPTION 'Announcement image binding must publish exact owner slot atomically' USING ERRCODE='23514';END IF;RETURN NEW;
END$$;
CREATE TRIGGER announcement_media_binding BEFORE INSERT ON whaleu_media.bindings FOR EACH ROW WHEN(NEW.owner_kind='announcements') EXECUTE FUNCTION whaleu_announcements.media_binding_guard();
CREATE CONSTRAINT TRIGGER announcement_media_binding_final AFTER INSERT ON whaleu_media.bindings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.owner_kind='announcements') EXECUTE FUNCTION whaleu_announcements.media_binding_guard();
CREATE FUNCTION whaleu_announcements.media_consumption_guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF NEW.transaction_id<>pg_current_xact_id() OR NOT EXISTS(SELECT 1 FROM whaleu_media.bindings b JOIN whaleu_media.assets a ON a.id=b.asset_id WHERE b.owner_kind='announcements' AND b.resource_kind='announcement_image' AND b.resource_id=NEW.resource_id AND b.detached_at IS NULL AND a.resource_id=NEW.scope_resource_id AND a.actor_id=NEW.actor_id AND a.scope_revision=NEW.scope_revision)
 THEN RAISE EXCEPTION 'Announcement image consumption requires atomic original binding' USING ERRCODE='23514';END IF;RETURN NULL;END$$;
CREATE CONSTRAINT TRIGGER announcement_media_consumption_final AFTER INSERT ON whaleu_media.scope_consumptions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.owner_kind='announcements') EXECUTE FUNCTION whaleu_announcements.media_consumption_guard();
CREATE FUNCTION whaleu_announcements.media_detach_guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF OLD.detached_at IS NULL AND NEW.detached_at IS NOT NULL AND (NEW.detach_reason NOT IN('announcement-media-replaced','announcement-draft-cancelled') OR NOT EXISTS(SELECT 1 FROM whaleu_announcements.media_retirements r WHERE r.binding_id=NEW.id AND r.transaction_id=pg_current_xact_id()))
 THEN RAISE EXCEPTION 'Announcement image detach requires original owner retirement' USING ERRCODE='23514';END IF;RETURN NEW;END$$;
CREATE TRIGGER announcement_media_detach BEFORE UPDATE ON whaleu_media.bindings FOR EACH ROW WHEN(NEW.owner_kind='announcements') EXECUTE FUNCTION whaleu_announcements.media_detach_guard();
CREATE FUNCTION whaleu_announcements.media_retirement_guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF NEW.transaction_id<>pg_current_xact_id() OR NOT EXISTS(
  SELECT 1 FROM whaleu_announcements.native_announcements o
  JOIN whaleu_announcements.native_publications h ON(h.announcement_id,h.revision)=(o.id,o.revision)
  JOIN whaleu_announcements.media_appearances p ON p.announcement_id=o.id
  JOIN whaleu_media.bindings b ON b.id=p.binding_id
  WHERE p.binding_id=NEW.binding_id AND(o.id,p.slot,o.revision)=(NEW.announcement_id,NEW.slot,NEW.revision)
   AND o.media_bindings->>p.slot IS DISTINCT FROM NEW.binding_id::text AND h.actor_id=NEW.actor_id AND h.created_at=transaction_timestamp()
   AND b.detached_at IS NOT NULL AND(b.owner_kind,b.resource_kind,b.resource_id,b.asset_id,b.manifest_digest)=('announcements','announcement_image',p.id,p.asset_id,p.manifest_digest)
   AND ((h.operation IN('save','update') AND b.detach_reason='announcement-media-replaced') OR
    (h.operation='cancel_draft' AND o.state='cancelled' AND b.detach_reason='announcement-draft-cancelled' AND o.creator_id=NEW.actor_id AND p.actor_id=NEW.actor_id
     AND NOT EXISTS(SELECT 1 FROM whaleu_announcements.native_publications historical WHERE historical.announcement_id=o.id AND historical.operation='publish'))))
 THEN RAISE EXCEPTION 'Announcement image retirement requires atomic original operation' USING ERRCODE='23514';END IF;RETURN NULL;
END$$;
CREATE CONSTRAINT TRIGGER announcement_media_retirement_final AFTER INSERT ON whaleu_announcements.media_retirements DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_announcements.media_retirement_guard();
CREATE FUNCTION whaleu_announcements.media_pointer_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE k text;v text;prior text;p whaleu_announcements.media_appearances;b whaleu_media.bindings;h whaleu_announcements.native_publications;changes jsonb;change jsonb;action text;BEGIN
 SELECT * INTO h FROM whaleu_announcements.native_publications WHERE announcement_id=NEW.id AND revision=NEW.revision;
 IF h.announcement_id IS NULL OR h.created_at<>transaction_timestamp() OR jsonb_typeof(NEW.media_bindings)<>'object'
 THEN RAISE EXCEPTION 'Announcement media requires exact immutable publication' USING ERRCODE='23514';END IF;
 IF TG_OP='INSERT' AND EXISTS(SELECT 1 FROM jsonb_each(NEW.media_bindings) value WHERE value.value<>'null'::jsonb)
 THEN RAISE EXCEPTION 'New announcement starts without media' USING ERRCODE='23514';END IF;
 IF TG_OP='UPDATE' THEN
  IF h.operation IN('save','update') THEN
   SELECT q.command->'mediaChanges' INTO changes FROM whaleu_announcements.native_requests q
    WHERE q.announcement_id=NEW.id AND(q.receipt->>'revision')::bigint=NEW.revision AND q.actor_id=h.actor_id AND q.command->>'action'=h.operation;
   IF changes IS NULL OR jsonb_typeof(changes)<>'object' THEN RAISE EXCEPTION 'Announcement media requires exact original changes' USING ERRCODE='23514';END IF;
   FOR k IN SELECT jsonb_object_keys(changes) LOOP
    IF k NOT IN('gallery0','gallery1','gallery2','gallery3','gallery4','gallery5','gallery6','gallery7','gallery8') THEN RAISE EXCEPTION 'Unknown announcement image slot' USING ERRCODE='23514';END IF;
   END LOOP;
   FOREACH k IN ARRAY ARRAY['gallery0','gallery1','gallery2','gallery3','gallery4','gallery5','gallery6','gallery7','gallery8'] LOOP
    change:=changes->k;action:=coalesce(change->>'action','keep');prior:=OLD.media_bindings->>k;v:=NEW.media_bindings->>k;
    IF change IS NOT NULL AND NOT coalesce(jsonb_typeof(change->'action')='string' AND(
      (action IN('keep','remove') AND whaleu_community.rating_scoped_keys(change,ARRAY['action'])) OR
      (action='replace' AND whaleu_community.rating_scoped_keys(change,ARRAY['action','assetId']) AND jsonb_typeof(change->'assetId')='string')),false)
    THEN RAISE EXCEPTION 'Announcement media change requires closed original action' USING ERRCODE='23514';END IF;
    IF(action='keep' AND v IS DISTINCT FROM prior) OR(action='remove' AND v IS NOT NULL) OR(action='replace' AND(v IS NULL OR v IS NOT DISTINCT FROM prior OR NOT EXISTS(
      SELECT 1 FROM whaleu_announcements.media_appearances a WHERE a.binding_id=v::uuid AND a.announcement_id=NEW.id AND a.slot=k AND a.asset_id::text=change->>'assetId')))
    THEN RAISE EXCEPTION 'Announcement media must implement original change' USING ERRCODE='23514';END IF;
   END LOOP;
  ELSIF h.operation='cancel_draft' THEN
   IF OLD.state<>'draft' OR NEW.state<>'cancelled' OR h.actor_id<>OLD.creator_id OR EXISTS(SELECT 1 FROM whaleu_announcements.native_publications historical WHERE historical.announcement_id=NEW.id AND historical.operation='publish')
    OR EXISTS(SELECT 1 FROM jsonb_each(NEW.media_bindings) binding WHERE binding.value<>'null'::jsonb)
   THEN RAISE EXCEPTION 'Only original unpublished draft images can be cancelled' USING ERRCODE='23514';END IF;
  ELSIF NEW.media_bindings IS DISTINCT FROM OLD.media_bindings THEN RAISE EXCEPTION 'Announcement operation cannot change saved images' USING ERRCODE='23514';END IF;
 END IF;
 FOR k,v IN SELECT key,value FROM jsonb_each_text(NEW.media_bindings) LOOP
  IF k NOT IN('gallery0','gallery1','gallery2','gallery3','gallery4','gallery5','gallery6','gallery7','gallery8') THEN RAISE EXCEPTION 'Unknown announcement image slot' USING ERRCODE='23514';END IF;
  IF v IS NULL THEN CONTINUE;END IF;
  prior:=CASE WHEN TG_OP='UPDATE' THEN OLD.media_bindings->>k ELSE NULL END;
  SELECT * INTO p FROM whaleu_announcements.media_appearances WHERE binding_id=v::uuid;
  SELECT * INTO b FROM whaleu_media.bindings WHERE id=v::uuid;
  IF p.id IS NULL OR b.id IS NULL OR b.detached_at IS NOT NULL OR(p.announcement_id,p.slot) IS DISTINCT FROM(NEW.id,k)
   OR(b.owner_kind,b.resource_kind,b.resource_id,b.asset_id,b.manifest_digest,b.content_version,b.slot,b.ordinal) IS DISTINCT FROM('announcements','announcement_image',p.id,p.asset_id,p.manifest_digest,1::bigint,k,0)
   OR(v IS DISTINCT FROM prior AND(p.revision<>NEW.revision OR p.actor_id<>h.actor_id OR p.publication_transaction<>pg_current_xact_id()))
  THEN RAISE EXCEPTION 'Announcement requires exact current same-slot appearance' USING ERRCODE='23514';END IF;
 END LOOP;
 IF TG_OP='UPDATE' THEN
  FOR k,prior IN SELECT key,value FROM jsonb_each_text(OLD.media_bindings) LOOP
   IF prior IS NOT NULL AND prior IS DISTINCT FROM NEW.media_bindings->>k AND NOT EXISTS(SELECT 1 FROM whaleu_announcements.media_retirements r WHERE r.binding_id=prior::uuid AND r.actor_id=h.actor_id AND(r.announcement_id,r.slot,r.revision)=(NEW.id,k,NEW.revision) AND r.transaction_id=pg_current_xact_id())
   THEN RAISE EXCEPTION 'Announcement replacement requires atomic retirement' USING ERRCODE='23514';END IF;
  END LOOP;
 END IF;RETURN NULL;
END$$;
CREATE CONSTRAINT TRIGGER announcement_media_pointer_final AFTER INSERT OR UPDATE ON whaleu_announcements.native_announcements DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_announcements.media_pointer_guard();
CREATE FUNCTION whaleu_announcements.media_appearance_guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF NEW.publication_transaction<>pg_current_xact_id() OR NOT EXISTS(
  SELECT 1 FROM whaleu_media.bindings b JOIN whaleu_media.assets a ON a.id=b.asset_id JOIN whaleu_media.upload_intents i ON i.id=a.intent_id
  JOIN whaleu_announcements.media_upload_scopes s ON s.id=a.resource_id AND s.actor_id=a.actor_id AND s.scope_revision=a.scope_revision
  JOIN whaleu_announcements.native_announcements o ON o.id=s.announcement_id
  WHERE i.protocol_version=12 AND b.id=NEW.binding_id AND b.detached_at IS NULL
   AND (b.owner_kind,b.resource_kind,b.resource_id,b.asset_id,b.manifest_digest,b.slot)=('announcements','announcement_image',NEW.id,NEW.asset_id,NEW.manifest_digest,NEW.slot)
   AND a.actor_id=NEW.actor_id AND (s.announcement_id,s.slot,s.revision+1)=(NEW.announcement_id,NEW.slot,NEW.revision)
   AND o.revision=NEW.revision AND whaleu_announcements.media_content_writer(o.id,o.revision)=NEW.actor_id AND o.media_bindings->>NEW.slot=NEW.binding_id::text)
 THEN RAISE EXCEPTION 'Announcement appearance requires exact atomic owner publication' USING ERRCODE='23514';END IF;RETURN NULL;END$$;
CREATE CONSTRAINT TRIGGER announcement_media_appearance_final AFTER INSERT ON whaleu_announcements.media_appearances DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_announcements.media_appearance_guard();

-- Immutable operation facts bind actual asset identities/manifests, never client approval flags.
CREATE FUNCTION whaleu_announcements.native_media_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE k text;v text;expected_media jsonb;BEGIN
 SELECT coalesce(jsonb_agg(jsonb_build_object('slot',p.slot,'assetId',p.asset_id::text,'manifestDigest',p.manifest_digest) ORDER BY p.slot),'[]'::jsonb) INTO expected_media
 FROM whaleu_announcements.media_appearances p WHERE p.announcement_id=NEW.announcement_id AND NEW.media_bindings->>p.slot=p.binding_id::text;
 IF NEW.media_facts IS DISTINCT FROM expected_media THEN RAISE EXCEPTION 'Announcement requires exact immutable media facts' USING ERRCODE='23514';END IF;
 -- Deactivation and original draft closure cannot be blocked by a later image revocation.
 IF NEW.operation='cancel_draft' OR(NEW.operation='set_enabled' AND NEW.state='inactive') THEN RETURN NULL;END IF;
 FOR k,v IN SELECT key,value FROM jsonb_each_text(NEW.media_bindings) LOOP
  IF v IS NULL THEN CONTINUE;END IF;
  IF NOT EXISTS(SELECT 1 FROM whaleu_announcements.media_appearances p
   JOIN whaleu_media.bindings b ON b.id=p.binding_id AND b.asset_id=p.asset_id AND b.manifest_digest=p.manifest_digest
   JOIN whaleu_media.assets a ON a.id=b.asset_id AND a.manifest_digest=b.manifest_digest
   JOIN whaleu_media.upload_intents i ON i.id=a.intent_id
   JOIN whaleu_media.asset_safety_heads h ON h.asset_id=a.id
   JOIN whaleu_media.asset_safety_events e ON(e.asset_id,e.revision,e.id)=(h.asset_id,h.revision,h.event_id)
   WHERE p.announcement_id=NEW.announcement_id AND p.slot=k AND p.binding_id=v::uuid
    AND b.owner_kind='announcements' AND b.resource_kind='announcement_image' AND b.resource_id=p.id AND b.slot=k AND b.ordinal=0 AND b.content_version=1 AND b.detached_at IS NULL
    AND i.protocol_version=12 AND i.state='ready' AND a.owner_kind='announcements' AND a.resource_kind='announcement_image'
    AND e.state='allow' AND e.manifest_digest=a.manifest_digest AND e.policy_revision=a.policy_revision AND e.effective_at<=clock_timestamp() AND e.valid_until>clock_timestamp())
  THEN RAISE EXCEPTION 'Announcement operation requires current exact image Safety Review' USING ERRCODE='23514';END IF;
 END LOOP;RETURN NULL;
END$$;
CREATE CONSTRAINT TRIGGER announcement_native_media_final AFTER INSERT ON whaleu_announcements.native_publications DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_announcements.native_media_guard();
