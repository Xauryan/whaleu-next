-- Typed Activity Media11. Shared byte storage, quotas, lifecycle,
-- safety/Review facts and exact delivery are unchanged. No provider is enabled.
SET LOCAL lock_timeout='5s';
SELECT pg_advisory_xact_lock(hashtextextended('whaleu:named-block-policy:v1',0));
ALTER DOMAIN whaleu_media.audience DROP CONSTRAINT audience_check;
ALTER DOMAIN whaleu_media.audience ADD CONSTRAINT audience_check CHECK(VALUE IN ('content-gated','participant-private','conversation-private','profile-public','school-config-gated','organization-gated','activity-gated'));
ALTER TABLE whaleu_media.upload_request_fences DROP CONSTRAINT upload_request_fences_protocol_namespace_check;
ALTER TABLE whaleu_media.upload_request_fences ADD CONSTRAINT upload_request_fences_protocol_namespace_check CHECK(protocol_namespace IS NULL OR protocol_namespace IN (8,9,10,11));
ALTER TABLE whaleu_media.upload_intents DROP CONSTRAINT media_protocol_identity;
ALTER TABLE whaleu_media.upload_intents ADD CONSTRAINT media_protocol_identity CHECK(
 (protocol_version=1 AND request_hash IS NULL AND declared_sha256 IS NULL) OR
 (protocol_version IN (2,3,4,5,6,7,8,9,10,11) AND request_hash IS NOT NULL AND declared_sha256 IS NOT NULL));
ALTER TABLE whaleu_media.upload_intents DROP CONSTRAINT media_profile_scope;
ALTER TABLE whaleu_media.upload_intents ADD CONSTRAINT media_profile_scope CHECK(
 (protocol_version=5 AND owner_kind='profile' AND resource_kind='avatar' AND audience='profile-public'
 AND target_kind='edit' AND content_version=1 AND slot='avatar' AND ordinal=0 AND purpose='profile-avatar-image') OR
 (protocol_version<>5 AND owner_kind<>'profile' AND (target_kind<>'edit' OR protocol_version IN (6,8,9,10,11)) AND audience<>'profile-public' AND purpose<>'profile-avatar-image'));
ALTER TABLE whaleu_media.assets DROP CONSTRAINT media_profile_asset_scope;
ALTER TABLE whaleu_media.assets ADD CONSTRAINT media_profile_asset_scope CHECK(
 (owner_kind='profile' AND resource_kind='avatar' AND audience='profile-public' AND target_kind='edit'
 AND content_version=1 AND slot='avatar' AND ordinal=0 AND purpose='profile-avatar-image') OR
 (owner_kind<>'profile' AND (target_kind<>'edit' OR owner_kind IN ('ratings','school_configuration','organizations','activities')) AND audience<>'profile-public' AND purpose<>'profile-avatar-image'));
ALTER TABLE whaleu_media.upload_intents ADD CONSTRAINT media_activity_media_scope CHECK(
 (protocol_version=11 AND owner_kind='activities' AND resource_kind='activity_image' AND audience='activity-gated' AND purpose='activity-image' AND target_kind='edit' AND content_version=1 AND slot IN ('cover','gallery0','gallery1','gallery2','gallery3','gallery4','gallery5','gallery6','gallery7','gallery8') AND ordinal=0) OR
 (protocol_version<>11 AND owner_kind<>'activities' AND resource_kind<>'activity_image' AND audience<>'activity-gated' AND purpose<>'activity-image'));
ALTER TABLE whaleu_media.assets ADD CONSTRAINT media_activity_media_asset_scope CHECK(
 (owner_kind='activities' AND resource_kind='activity_image' AND audience='activity-gated' AND purpose='activity-image' AND target_kind='edit' AND content_version=1 AND slot IN ('cover','gallery0','gallery1','gallery2','gallery3','gallery4','gallery5','gallery6','gallery7','gallery8') AND ordinal=0) OR
 (owner_kind<>'activities' AND resource_kind<>'activity_image' AND audience<>'activity-gated' AND purpose<>'activity-image'));
ALTER TABLE whaleu_media.bindings ADD CONSTRAINT media_activity_media_binding_scope CHECK(
 (owner_kind='activities' AND resource_kind='activity_image' AND content_version=1 AND slot IN ('cover','gallery0','gallery1','gallery2','gallery3','gallery4','gallery5','gallery6','gallery7','gallery8') AND ordinal=0) OR
 (owner_kind<>'activities' AND resource_kind<>'activity_image'));

CREATE TABLE whaleu_activities.media_upload_scopes(
 id uuid PRIMARY KEY,actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
 client_request_id uuid NOT NULL,activity_id uuid NOT NULL REFERENCES whaleu_activities.publication_drafts(id),
 slot text NOT NULL CHECK(slot IN ('cover','gallery0','gallery1','gallery2','gallery3','gallery4','gallery5','gallery6','gallery7','gallery8')),
 revision bigint NOT NULL CHECK(revision>0),scope_revision whaleu_media.digest NOT NULL,
 input jsonb NOT NULL,authority_version text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT statement_timestamp(),expires_at timestamptz NOT NULL DEFAULT statement_timestamp()+interval '30 minutes',
 UNIQUE(actor_id,client_request_id),CHECK(expires_at>created_at AND expires_at<=created_at+interval '30 minutes')
);
CREATE TABLE whaleu_activities.media_appearances(
 id uuid PRIMARY KEY,activity_id uuid NOT NULL REFERENCES whaleu_activities.publication_drafts(id),slot text NOT NULL,
 actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),asset_id uuid NOT NULL UNIQUE REFERENCES whaleu_media.assets(id),
 manifest_digest whaleu_media.digest NOT NULL,binding_id uuid NOT NULL UNIQUE REFERENCES whaleu_media.bindings(id) DEFERRABLE INITIALLY DEFERRED,
 revision bigint NOT NULL CHECK(revision>0),publication_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 UNIQUE(activity_id,slot,revision)
);
CREATE TABLE whaleu_activities.media_retirements(
 binding_id uuid PRIMARY KEY REFERENCES whaleu_media.bindings(id),actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
 activity_id uuid NOT NULL,slot text NOT NULL,revision bigint NOT NULL CHECK(revision>0),
 transaction_id xid8 NOT NULL DEFAULT pg_current_xact_id()
);
DO $$DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['media_upload_scopes','media_appearances','media_retirements'] LOOP
 EXECUTE format('CREATE TRIGGER a0_activity_media_policy BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_activities.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.content_policy_writer_gate()',t);
 EXECUTE format('CREATE TRIGGER a1_activity_media_epoch BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_activities.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_media.advance_owner_epoch()',t);
 EXECUTE format('CREATE TRIGGER activity_media_retain BEFORE TRUNCATE ON whaleu_activities.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_media.immutable_record()',t);
 EXECUTE format('CREATE TRIGGER activity_media_immutable BEFORE UPDATE OR DELETE ON whaleu_activities.%I FOR EACH ROW EXECUTE FUNCTION whaleu_media.immutable_record()',t);
 END LOOP;
END$$;
CREATE FUNCTION whaleu_activities.media_request_hash(actor uuid,v jsonb) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT encode(sha256(convert_to('whaleu-activity-media-prepare:v1'||chr(10)||
 '{"protocol":"activity-media-v1","actorAccountId":'||to_json(actor::text)::text||
 ',"clientRequestId":'||to_json(v->>'clientRequestId')::text||',"activityId":'||to_json(v->>'activityId')::text||
 ',"slot":'||to_json(v->>'slot')::text||',"revision":'||(v->>'revision')||
 ',"declaration":{"mime":'||to_json(v->'declaration'->>'mime')::text||',"bytes":'||(v->'declaration'->>'bytes')||
 ',"sha256":'||to_json(v->'declaration'->>'sha256')::text||'}}','UTF8')),'hex')
$$;
CREATE FUNCTION whaleu_activities.media_scope_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v jsonb;BEGIN
 v:=NEW.input;
 IF NOT coalesce(whaleu_community.rating_scoped_keys(v,ARRAY['protocol','clientRequestId','activityId','slot','revision','declaration'])
 AND v->>'protocol'='activity-media-v1' AND v->>'clientRequestId'=NEW.client_request_id::text
 AND v->>'activityId'=NEW.activity_id::text AND v->>'slot'=NEW.slot AND (v->>'revision')::bigint=NEW.revision
 AND jsonb_typeof(v->'revision')='number' AND v->>'revision' ~ '^[1-9][0-9]*$' AND NEW.revision<=9007199254740990
 AND NEW.scope_revision=whaleu_activities.media_request_hash(NEW.actor_id,v)
 AND whaleu_community.rating_scoped_keys(v->'declaration',ARRAY['mime','bytes','sha256'])
 AND v->'declaration'->>'mime' IN ('image/jpeg','image/png')
 AND whaleu_community.rating_scoped_integer(v->'declaration'->'bytes',1) AND (v->'declaration'->>'bytes')::bigint BETWEEN 1 AND 5242880 AND v->'declaration'->>'sha256' ~ '^[a-f0-9]{64}$'
 AND whaleu_activities.media_actor_current(NEW.actor_id,NEW.activity_id,NEW.revision,NEW.authority_version),false)
 THEN RAISE EXCEPTION 'Activity image scope requires exact current activity authority' USING ERRCODE='23514';END IF;RETURN NEW;
END$$;
CREATE TRIGGER activity_media_scope BEFORE INSERT ON whaleu_activities.media_upload_scopes FOR EACH ROW EXECUTE FUNCTION whaleu_activities.media_scope_guard();

-- Protocol routing adds typed11 guards, preserving the original function bodies.
DROP TRIGGER media_binding_guard ON whaleu_media.bindings;
CREATE TRIGGER media_binding_guard BEFORE INSERT ON whaleu_media.bindings FOR EACH ROW
 WHEN(NEW.owner_kind NOT IN ('activities','organizations','school_configuration') AND NOT(NEW.owner_kind='ratings' AND NEW.resource_kind IN ('rating_comment','rating_reply','category_icon'))) EXECUTE FUNCTION whaleu_media.binding_guard();
DROP TRIGGER media_scope_consumption_complete ON whaleu_media.scope_consumptions;
CREATE CONSTRAINT TRIGGER media_scope_consumption_complete AFTER INSERT ON whaleu_media.scope_consumptions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 WHEN(NEW.owner_kind NOT IN ('activities','organizations','school_configuration') AND NOT(NEW.owner_kind='ratings' AND NEW.resource_kind IN ('rating_comment','rating_reply','category_icon'))) EXECUTE FUNCTION whaleu_media.scope_consumption_complete();
CREATE FUNCTION whaleu_activities.media_namespace_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE f whaleu_media.upload_request_fences;i whaleu_media.upload_intents;actor uuid;request uuid;BEGIN
 actor:=NEW.actor_id;
 IF TG_TABLE_NAME='ratings_discussion_batch_request_fences' THEN request:=NEW.batch_request_id;ELSE request:=NEW.client_request_id;END IF;
 SELECT * INTO f FROM whaleu_media.upload_request_fences WHERE actor_id=actor AND client_request_id=request;
 IF f.protocol_namespace IS DISTINCT FROM 11 THEN
  IF TG_TABLE_NAME='upload_intents' THEN
   IF NEW.protocol_version=11 THEN RAISE EXCEPTION 'Activity image requires Media11 receipt' USING ERRCODE='23514';END IF;
  END IF;RETURN NULL;
 END IF;
 IF EXISTS(SELECT 1 FROM whaleu_media.profile_request_markers WHERE actor_id=actor AND client_request_id=request)
 OR EXISTS(SELECT 1 FROM whaleu_media.ratings_request_markers WHERE actor_id=actor AND client_request_id=request)
 OR EXISTS(SELECT 1 FROM whaleu_media.ratings_discussion_request_markers WHERE actor_id=actor AND client_request_id=request)
 OR EXISTS(SELECT 1 FROM whaleu_media.category_icon_request_markers WHERE actor_id=actor AND client_request_id=request)
 OR EXISTS(SELECT 1 FROM whaleu_media.ratings_discussion_batch_request_fences WHERE actor_id=actor AND batch_request_id=request)
 THEN RAISE EXCEPTION 'Activity image request namespace is exclusive' USING ERRCODE='23514';END IF;
 IF f.intent_id IS NOT NULL THEN
 SELECT * INTO STRICT i FROM whaleu_media.upload_intents WHERE id=f.intent_id;
 IF i.protocol_version<>11 OR (i.actor_id,i.client_request_id,i.request_hash) IS DISTINCT FROM (actor,request,f.request_hash)
 THEN RAISE EXCEPTION 'Activity image exact receipt mismatch' USING ERRCODE='23514';END IF;END IF;
 IF TG_TABLE_NAME='upload_intents' THEN
 IF NEW.protocol_version<>11 OR f.intent_id IS DISTINCT FROM NEW.id THEN RAISE EXCEPTION 'Activity image intent mismatch' USING ERRCODE='23514';END IF;END IF;
 RETURN NULL;
END$$;
DO $$DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['upload_intents','upload_request_fences','profile_request_markers','ratings_request_markers','ratings_discussion_request_markers','category_icon_request_markers','ratings_discussion_batch_request_fences'] LOOP
 EXECUTE format('CREATE CONSTRAINT TRIGGER activity_media_namespace AFTER INSERT OR UPDATE ON whaleu_media.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_activities.media_namespace_guard()',t);
 END LOOP;
END$$;
CREATE FUNCTION whaleu_activities.media_intent_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s whaleu_activities.media_upload_scopes;BEGIN
 SELECT * INTO s FROM whaleu_activities.media_upload_scopes WHERE id=NEW.resource_id AND actor_id=NEW.actor_id;
 IF s.id IS NULL OR (NEW.client_request_id,NEW.scope_revision,NEW.request_hash,NEW.expires_at) IS DISTINCT FROM (s.client_request_id,s.scope_revision,s.scope_revision,s.expires_at)
 OR NEW.declared_bytes<>(s.input->'declaration'->>'bytes')::bigint OR NEW.declared_mime<>s.input->'declaration'->>'mime' OR NEW.declared_sha256<>s.input->'declaration'->>'sha256'
 THEN RAISE EXCEPTION 'Activity image intent requires exact original owner scope' USING ERRCODE='23514';END IF;RETURN NEW;
END$$;
CREATE TRIGGER activity_media_intent BEFORE INSERT ON whaleu_media.upload_intents FOR EACH ROW WHEN(NEW.protocol_version=11) EXECUTE FUNCTION whaleu_activities.media_intent_guard();
CREATE FUNCTION whaleu_activities.media_binding_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a whaleu_media.assets;i whaleu_media.upload_intents;s whaleu_activities.media_upload_scopes;c whaleu_media.scope_consumptions;BEGIN
 SELECT * INTO STRICT a FROM whaleu_media.assets WHERE id=NEW.asset_id;
 SELECT * INTO STRICT i FROM whaleu_media.upload_intents WHERE id=a.intent_id;
 SELECT * INTO s FROM whaleu_activities.media_upload_scopes WHERE id=a.resource_id AND actor_id=a.actor_id;
 SELECT * INTO c FROM whaleu_media.scope_consumptions WHERE actor_id=a.actor_id AND owner_kind='activities' AND resource_kind='activity_image' AND scope_resource_id=a.resource_id;
 IF i.protocol_version<>11 OR i.state<>'ready' OR s.id IS NULL OR least(s.expires_at,a.created_at+interval '24 hours')<=clock_timestamp()
 OR NEW.detached_at IS NOT NULL OR (NEW.owner_kind,NEW.resource_kind,NEW.content_version,NEW.slot,NEW.ordinal,NEW.manifest_digest) IS DISTINCT FROM (a.owner_kind,a.resource_kind,a.content_version,a.slot,a.ordinal,a.manifest_digest)
 OR NEW.attach_evidence IS DISTINCT FROM jsonb_build_object('version',11,'scopeId',a.resource_id::text,'scopeRevision',a.scope_revision)
 OR c.transaction_id IS DISTINCT FROM pg_current_xact_id() OR c.resource_id IS DISTINCT FROM NEW.resource_id OR c.scope_revision IS DISTINCT FROM a.scope_revision OR c.content_version IS DISTINCT FROM 1::bigint
 OR c.attach_evidence IS DISTINCT FROM jsonb_build_object('version',11,'assets',jsonb_build_array(jsonb_build_object('assetId',a.id::text,'digest',a.manifest_digest)))
 OR NOT EXISTS(SELECT 1 FROM whaleu_media.asset_safety_heads h JOIN whaleu_media.asset_safety_events e ON (e.asset_id,e.revision,e.id)=(h.asset_id,h.revision,h.event_id)
 WHERE h.asset_id=a.id AND e.state='allow' AND e.manifest_digest=a.manifest_digest AND e.policy_revision=a.policy_revision AND e.effective_at<=clock_timestamp() AND e.valid_until>clock_timestamp())
 OR (TG_WHEN='BEFORE' AND NOT whaleu_activities.media_actor_current(a.actor_id,s.activity_id,s.revision,s.authority_version))
 THEN RAISE EXCEPTION 'Activity image binding requires current exact Media11 acceptance' USING ERRCODE='23514';END IF;
 IF TG_WHEN='AFTER' AND NOT EXISTS(SELECT 1 FROM whaleu_activities.media_appearances p JOIN whaleu_activities.publication_drafts o ON o.id=p.activity_id
 WHERE p.id=NEW.resource_id AND p.binding_id=NEW.id AND p.asset_id=a.id AND p.manifest_digest=a.manifest_digest AND p.actor_id=a.actor_id AND (p.activity_id,p.slot,p.revision)=(s.activity_id,s.slot,s.revision+1)
 AND p.publication_transaction=pg_current_xact_id() AND o.media_bindings->>p.slot=NEW.id::text AND o.revision=p.revision AND whaleu_activities.media_content_writer(o.id,o.revision)=p.actor_id)
 THEN RAISE EXCEPTION 'Activity image binding must publish exact owner slot atomically' USING ERRCODE='23514';END IF;RETURN NEW;
END$$;
CREATE TRIGGER activity_media_binding BEFORE INSERT ON whaleu_media.bindings FOR EACH ROW WHEN(NEW.owner_kind='activities') EXECUTE FUNCTION whaleu_activities.media_binding_guard();
CREATE CONSTRAINT TRIGGER activity_media_binding_final AFTER INSERT ON whaleu_media.bindings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.owner_kind='activities') EXECUTE FUNCTION whaleu_activities.media_binding_guard();
CREATE FUNCTION whaleu_activities.media_consumption_guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF NEW.transaction_id<>pg_current_xact_id() OR NOT EXISTS(SELECT 1 FROM whaleu_media.bindings b JOIN whaleu_media.assets a ON a.id=b.asset_id WHERE b.owner_kind='activities' AND b.resource_kind='activity_image' AND b.resource_id=NEW.resource_id AND b.detached_at IS NULL AND a.resource_id=NEW.scope_resource_id AND a.actor_id=NEW.actor_id AND a.scope_revision=NEW.scope_revision)
 THEN RAISE EXCEPTION 'Activity image consumption requires atomic original binding' USING ERRCODE='23514';END IF;RETURN NULL;END$$;
CREATE CONSTRAINT TRIGGER activity_media_consumption_final AFTER INSERT ON whaleu_media.scope_consumptions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.owner_kind='activities') EXECUTE FUNCTION whaleu_activities.media_consumption_guard();
CREATE FUNCTION whaleu_activities.media_detach_guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF OLD.detached_at IS NULL AND NEW.detached_at IS NOT NULL AND (NEW.detach_reason NOT IN('activity-media-replaced','activity-draft-cancelled') OR NOT EXISTS(SELECT 1 FROM whaleu_activities.media_retirements r WHERE r.binding_id=NEW.id AND r.transaction_id=pg_current_xact_id()))
 THEN RAISE EXCEPTION 'Activity image detach requires original owner retirement' USING ERRCODE='23514';END IF;RETURN NEW;END$$;
CREATE TRIGGER activity_media_detach BEFORE UPDATE ON whaleu_media.bindings FOR EACH ROW WHEN(NEW.owner_kind='activities') EXECUTE FUNCTION whaleu_activities.media_detach_guard();
CREATE FUNCTION whaleu_activities.media_retirement_guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF NEW.transaction_id<>pg_current_xact_id() OR NOT EXISTS(SELECT 1 FROM whaleu_activities.publication_drafts o JOIN whaleu_activities.media_appearances p ON p.activity_id=o.id JOIN whaleu_media.bindings b ON b.id=p.binding_id
 WHERE p.binding_id=NEW.binding_id AND (o.id,p.slot,o.revision)=(NEW.activity_id,NEW.slot,NEW.revision) AND o.media_bindings->>p.slot IS DISTINCT FROM NEW.binding_id::text AND whaleu_activities.media_content_writer(o.id,o.revision)=NEW.actor_id AND b.detached_at IS NOT NULL
 AND ((o.state='draft' AND b.detach_reason='activity-media-replaced') OR(o.state='cancelled' AND b.detach_reason='activity-draft-cancelled'
  AND o.account_id=NEW.actor_id AND NOT EXISTS(SELECT 1 FROM whaleu_activities.native_activities n WHERE n.id=o.id)
  AND EXISTS(SELECT 1 FROM whaleu_activities.publication_events e JOIN whaleu_activities.publication_requests q ON(q.actor_id,q.client_request_id)=(e.actor_id,e.client_request_id)
    WHERE e.activity_id=o.id AND e.actor_id=o.account_id AND e.revision=o.revision AND e.action='cancel_draft' AND e.created_at=transaction_timestamp()
    AND e.content=o.content AND e.media_bindings=o.media_bindings AND q.command->>'action'='cancel_draft' AND(q.command->>'expectedRevision')::bigint=o.revision)))
 AND (b.owner_kind,b.resource_kind,b.resource_id,b.asset_id,b.manifest_digest)=('activities','activity_image',p.id,p.asset_id,p.manifest_digest))
 THEN RAISE EXCEPTION 'Activity image retirement requires exact atomic save or original draft cancellation' USING ERRCODE='23514';END IF;RETURN NULL;END$$;
CREATE CONSTRAINT TRIGGER activity_media_retirement_final AFTER INSERT ON whaleu_activities.media_retirements DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_activities.media_retirement_guard();
-- Both directions are checked: unrelated valid bindings cannot be adopted,
-- replaced pointers cannot resurrect detached data, and retirement is atomic.
CREATE FUNCTION whaleu_activities.media_pointer_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p whaleu_activities.media_appearances;b whaleu_media.bindings;k text;v text;prior text;changes jsonb;change jsonb;action text;BEGIN
 IF jsonb_typeof(NEW.media_bindings)<>'object' THEN RAISE EXCEPTION 'Invalid activity media set' USING ERRCODE='23514';END IF;
 IF TG_OP='UPDATE' THEN
  IF NEW.state='draft' THEN
   SELECT q.command->'mediaChanges' INTO changes FROM whaleu_activities.publication_events e
   JOIN whaleu_activities.publication_requests q ON(q.actor_id,q.client_request_id)=(e.actor_id,e.client_request_id)
   WHERE e.activity_id=NEW.id AND e.revision=NEW.revision AND e.action='save' AND e.created_at=transaction_timestamp()
    AND e.content=NEW.content AND e.media_bindings=NEW.media_bindings;
   IF changes IS NULL OR jsonb_typeof(changes)<>'object' THEN
    RAISE EXCEPTION 'Activity media save requires exact original change command' USING ERRCODE='23514';
   END IF;
   FOR k IN SELECT jsonb_object_keys(changes) LOOP
    IF k NOT IN ('cover','gallery0','gallery1','gallery2','gallery3','gallery4','gallery5','gallery6','gallery7','gallery8') THEN
     RAISE EXCEPTION 'Activity media change contains unknown slot' USING ERRCODE='23514';
    END IF;
   END LOOP;
   FOREACH k IN ARRAY ARRAY['cover','gallery0','gallery1','gallery2','gallery3','gallery4','gallery5','gallery6','gallery7','gallery8'] LOOP
    change:=changes->k;action:=coalesce(change->>'action','keep');prior:=OLD.media_bindings->>k;v:=NEW.media_bindings->>k;
    IF change IS NOT NULL AND NOT coalesce(jsonb_typeof(change->'action')='string' AND(
      (action IN('keep','remove') AND whaleu_community.rating_scoped_keys(change,ARRAY['action']))
      OR(action='replace' AND whaleu_community.rating_scoped_keys(change,ARRAY['action','assetId']) AND jsonb_typeof(change->'assetId')='string')),false)
    THEN RAISE EXCEPTION 'Activity media change requires closed original action' USING ERRCODE='23514';END IF;
    IF (action='keep' AND v IS DISTINCT FROM prior) OR(action='remove' AND v IS NOT NULL)
     OR(action='replace' AND(v IS NULL OR v IS NOT DISTINCT FROM prior OR NOT EXISTS(
      SELECT 1 FROM whaleu_activities.media_appearances a WHERE a.binding_id=v::uuid AND a.activity_id=NEW.id AND a.slot=k AND a.asset_id::text=change->>'assetId')))
    THEN RAISE EXCEPTION 'Activity media binding must implement exact original slot change' USING ERRCODE='23514';END IF;
   END LOOP;
  ELSIF NEW.state='cancelled' THEN
   IF OLD.state<>'draft' OR NEW.revision<>OLD.revision OR NEW.content IS DISTINCT FROM OLD.content
    OR whaleu_activities.media_content_writer(NEW.id,NEW.revision) IS DISTINCT FROM OLD.account_id
    OR EXISTS(SELECT 1 FROM whaleu_activities.native_activities n WHERE n.id=NEW.id)
    OR EXISTS(SELECT 1 FROM jsonb_each(NEW.media_bindings) binding WHERE binding.value<>'null'::jsonb)
   THEN RAISE EXCEPTION 'Activity cancellation must clear only the exact original unpublished draft media' USING ERRCODE='23514';END IF;
  ELSIF NEW.media_bindings IS DISTINCT FROM OLD.media_bindings THEN
   RAISE EXCEPTION 'Activity publication cannot change saved media' USING ERRCODE='23514';
  END IF;
 END IF;
 FOR k,v IN SELECT key,value FROM jsonb_each_text(NEW.media_bindings) LOOP
  IF k NOT IN ('cover','gallery0','gallery1','gallery2','gallery3','gallery4','gallery5','gallery6','gallery7','gallery8') THEN RAISE EXCEPTION 'Unknown activity image slot' USING ERRCODE='23514';END IF;
  IF v IS NULL THEN CONTINUE;END IF;
  prior:=CASE WHEN TG_OP='UPDATE' THEN OLD.media_bindings->>k ELSE NULL END;
  SELECT * INTO p FROM whaleu_activities.media_appearances WHERE binding_id=v::uuid;
  SELECT * INTO b FROM whaleu_media.bindings WHERE id=v::uuid;
  IF p.id IS NULL OR b.id IS NULL OR b.detached_at IS NOT NULL OR (p.activity_id,p.slot) IS DISTINCT FROM (NEW.id,k)
  OR (b.owner_kind,b.resource_kind,b.resource_id,b.asset_id,b.manifest_digest,b.content_version,b.slot,b.ordinal) IS DISTINCT FROM ('activities','activity_image',p.id,p.asset_id,p.manifest_digest,1::bigint,k,0)
  OR (v IS DISTINCT FROM prior AND (p.revision<>NEW.revision OR p.actor_id IS DISTINCT FROM whaleu_activities.media_content_writer(NEW.id,NEW.revision) OR p.publication_transaction<>pg_current_xact_id()))
  THEN RAISE EXCEPTION 'Activity requires exact current same-slot appearance' USING ERRCODE='23514';END IF;
 END LOOP;
 IF TG_OP='UPDATE' THEN
  FOR k,prior IN SELECT key,value FROM jsonb_each_text(OLD.media_bindings) LOOP
   IF prior IS NOT NULL AND prior IS DISTINCT FROM NEW.media_bindings->>k AND NOT EXISTS(
    SELECT 1 FROM whaleu_activities.media_retirements r WHERE r.binding_id=prior::uuid AND r.actor_id=whaleu_activities.media_content_writer(NEW.id,NEW.revision)
    AND (r.activity_id,r.slot,r.revision)=(NEW.id,k,NEW.revision) AND r.transaction_id=pg_current_xact_id())
   THEN RAISE EXCEPTION 'Activity replacement must retire original image atomically' USING ERRCODE='23514';END IF;
  END LOOP;
 END IF;RETURN NULL;
END$$;
CREATE CONSTRAINT TRIGGER activity_media_pointer_final AFTER INSERT OR UPDATE ON whaleu_activities.publication_drafts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_activities.media_pointer_guard();
CREATE FUNCTION whaleu_activities.media_appearance_guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF NEW.publication_transaction<>pg_current_xact_id() OR NOT EXISTS(
  SELECT 1 FROM whaleu_media.bindings b JOIN whaleu_media.assets a ON a.id=b.asset_id JOIN whaleu_media.upload_intents i ON i.id=a.intent_id
  JOIN whaleu_activities.media_upload_scopes s ON s.id=a.resource_id AND s.actor_id=a.actor_id AND s.scope_revision=a.scope_revision
  JOIN whaleu_activities.publication_drafts o ON o.id=s.activity_id
  WHERE i.protocol_version=11 AND b.id=NEW.binding_id AND b.detached_at IS NULL
   AND (b.owner_kind,b.resource_kind,b.resource_id,b.asset_id,b.manifest_digest,b.slot)=('activities','activity_image',NEW.id,NEW.asset_id,NEW.manifest_digest,NEW.slot)
   AND a.actor_id=NEW.actor_id AND (s.activity_id,s.slot,s.revision+1)=(NEW.activity_id,NEW.slot,NEW.revision)
   AND o.revision=NEW.revision AND whaleu_activities.media_content_writer(o.id,o.revision)=NEW.actor_id AND o.media_bindings->>NEW.slot=NEW.binding_id::text)
 THEN RAISE EXCEPTION 'Activity appearance requires exact atomic owner publication' USING ERRCODE='23514';END IF;RETURN NULL;END$$;
CREATE CONSTRAINT TRIGGER activity_media_appearance_final AFTER INSERT ON whaleu_activities.media_appearances DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_activities.media_appearance_guard();

-- A native publication adopts only its own complete frozen draft slot set.
-- No history binding, other owner descriptor, detached object, or fresh safety
-- revocation can be smuggled through publication even with a raw SQL writer.
CREATE FUNCTION whaleu_activities.native_media_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d whaleu_activities.publication_drafts;k text;v text;reviewed jsonb;expected_media jsonb;BEGIN
 SELECT * INTO d FROM whaleu_activities.publication_drafts WHERE id=NEW.id;
 IF d.id IS NULL OR d.state<>'published' OR NEW.original_publisher_account_id<>d.account_id
 OR (NEW.organization_id,NEW.organization_revision,NEW.revision,NEW.content,NEW.media_bindings)
 IS DISTINCT FROM (d.organization_id,d.organization_revision,d.revision,d.content,d.media_bindings)
 OR jsonb_typeof(NEW.media_bindings)<>'object' OR NEW.media_bindings->>'cover' IS NULL
 THEN RAISE EXCEPTION 'Activity publication requires complete exact original draft media' USING ERRCODE='23514';END IF;
 FOR k,v IN SELECT key,value FROM jsonb_each_text(NEW.media_bindings) LOOP
  IF k NOT IN ('cover','gallery0','gallery1','gallery2','gallery3','gallery4','gallery5','gallery6','gallery7','gallery8') THEN RAISE EXCEPTION 'Invalid activity image slot' USING ERRCODE='23514';END IF;
  IF v IS NULL THEN CONTINUE;END IF;
  IF NOT EXISTS(SELECT 1 FROM whaleu_activities.media_appearances p
   JOIN whaleu_media.bindings b ON b.id=p.binding_id AND b.asset_id=p.asset_id AND b.manifest_digest=p.manifest_digest
   JOIN whaleu_media.assets a ON a.id=b.asset_id AND a.manifest_digest=b.manifest_digest
   JOIN whaleu_media.upload_intents i ON i.id=a.intent_id
   JOIN whaleu_media.asset_safety_heads h ON h.asset_id=a.id
   JOIN whaleu_media.asset_safety_events e ON (e.asset_id,e.revision,e.id)=(h.asset_id,h.revision,h.event_id)
   WHERE p.activity_id=NEW.id AND p.slot=k AND p.binding_id=v::uuid AND p.actor_id=NEW.original_publisher_account_id
   AND b.owner_kind='activities' AND b.resource_kind='activity_image' AND b.resource_id=p.id AND b.slot=k AND b.ordinal=0 AND b.content_version=1 AND b.detached_at IS NULL
   AND i.protocol_version=11 AND i.state='ready' AND a.owner_kind='activities' AND a.resource_kind='activity_image'
   AND e.state='allow' AND e.manifest_digest=a.manifest_digest AND e.policy_revision=a.policy_revision
   AND e.effective_at<=clock_timestamp() AND e.valid_until>clock_timestamp())
  THEN RAISE EXCEPTION 'Activity publication requires current exact reviewed image' USING ERRCODE='23514';END IF;
 END LOOP;
 SELECT j.envelope->'media' INTO reviewed FROM whaleu_activities.review_decisions decision
 JOIN whaleu_activities.review_jobs j ON j.id=decision.job_id WHERE decision.id=NEW.review_decision_id;
 SELECT jsonb_agg(jsonb_build_object('slot',p.slot,'assetId',p.asset_id::text,'manifestDigest',p.manifest_digest)
   ORDER BY CASE WHEN p.slot='cover' THEN 0 ELSE 1 END,p.slot) INTO expected_media
 FROM whaleu_activities.media_appearances p
 WHERE p.activity_id=NEW.id AND NEW.media_bindings->>p.slot=p.binding_id::text;
 IF reviewed IS DISTINCT FROM expected_media THEN
  RAISE EXCEPTION 'Activity publication review must cover exact current asset identities and manifests' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END$$;
CREATE CONSTRAINT TRIGGER activity_native_media_final AFTER INSERT OR UPDATE ON whaleu_activities.native_activities
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_activities.native_media_guard();
