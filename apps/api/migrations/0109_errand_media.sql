-- Typed Errand Media14. Bound media has no order-state or age expiry.
-- New production adapters remain disabled; no legacy migration is rewritten.
SET LOCAL lock_timeout='5s';
SELECT pg_advisory_xact_lock(hashtextextended('whaleu:named-block-policy:v1',0));
ALTER DOMAIN whaleu_media.audience DROP CONSTRAINT audience_check;
ALTER DOMAIN whaleu_media.audience ADD CONSTRAINT audience_check CHECK(VALUE IN ('content-gated','participant-private','conversation-private','profile-public','school-config-gated','organization-gated','activity-gated','announcement-gated','verification-private','errand-public','errand-private'));
ALTER TABLE whaleu_media.upload_request_fences DROP CONSTRAINT upload_request_fences_protocol_namespace_check;
ALTER TABLE whaleu_media.upload_request_fences ADD CONSTRAINT upload_request_fences_protocol_namespace_check CHECK(protocol_namespace IS NULL OR protocol_namespace IN (8,9,10,11,12,13,14));
ALTER TABLE whaleu_media.upload_intents DROP CONSTRAINT media_protocol_identity;
ALTER TABLE whaleu_media.upload_intents ADD CONSTRAINT media_protocol_identity CHECK(
 (protocol_version=1 AND request_hash IS NULL AND declared_sha256 IS NULL) OR
 (protocol_version IN (2,3,4,5,6,7,8,9,10,11,12,13,14) AND request_hash IS NOT NULL AND declared_sha256 IS NOT NULL));
ALTER TABLE whaleu_media.upload_intents DROP CONSTRAINT media_profile_scope;
ALTER TABLE whaleu_media.upload_intents ADD CONSTRAINT media_profile_scope CHECK(
 (protocol_version=5 AND owner_kind='profile' AND resource_kind='avatar' AND audience='profile-public'
 AND target_kind='edit' AND content_version=1 AND slot='avatar' AND ordinal=0 AND purpose='profile-avatar-image') OR
 (protocol_version<>5 AND owner_kind<>'profile' AND (target_kind<>'edit' OR protocol_version IN (6,8,9,10,11,12,13,14)) AND audience<>'profile-public' AND purpose<>'profile-avatar-image'));
ALTER TABLE whaleu_media.assets DROP CONSTRAINT media_profile_asset_scope;
ALTER TABLE whaleu_media.assets ADD CONSTRAINT media_profile_asset_scope CHECK(
 (owner_kind='profile' AND resource_kind='avatar' AND audience='profile-public' AND target_kind='edit'
 AND content_version=1 AND slot='avatar' AND ordinal=0 AND purpose='profile-avatar-image') OR
 (owner_kind<>'profile' AND (target_kind<>'edit' OR owner_kind IN ('ratings','school_configuration','organizations','activities','announcements','verification','errands')) AND audience<>'profile-public' AND purpose<>'profile-avatar-image'));
ALTER TABLE whaleu_media.upload_intents ADD CONSTRAINT media_errand_scope CHECK(
 (protocol_version=14 AND owner_kind='errands' AND resource_kind='errand_image' AND target_kind='edit' AND content_version=1 AND ordinal=0 AND
 ((slot IN('public0','public1','public2') AND audience='errand-public' AND purpose='errand-public-image') OR
  (slot IN('private0','private1','private2') AND audience='errand-private' AND purpose='errand-private-image'))) OR
 (protocol_version<>14 AND resource_kind<>'errand_image' AND audience NOT IN('errand-public','errand-private') AND purpose NOT IN('errand-public-image','errand-private-image')));
ALTER TABLE whaleu_media.assets ADD CONSTRAINT media_errand_asset_scope CHECK(
 (owner_kind='errands' AND resource_kind='errand_image' AND target_kind='edit' AND content_version=1 AND ordinal=0 AND
 ((slot IN('public0','public1','public2') AND audience='errand-public' AND purpose='errand-public-image') OR
  (slot IN('private0','private1','private2') AND audience='errand-private' AND purpose='errand-private-image'))) OR
 (resource_kind<>'errand_image' AND audience NOT IN('errand-public','errand-private') AND purpose NOT IN('errand-public-image','errand-private-image')));
ALTER TABLE whaleu_media.bindings ADD CONSTRAINT media_errand_binding_scope CHECK(
 (owner_kind='errands' AND resource_kind='errand_image' AND content_version=1 AND slot IN('public0','public1','public2','private0','private1','private2') AND ordinal=0) OR resource_kind<>'errand_image');
CREATE TABLE whaleu_media.errand_scopes(
 id uuid PRIMARY KEY,actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),client_request_id uuid NOT NULL,
 draft_id uuid NOT NULL,draft_revision bigint NOT NULL CHECK(draft_revision>0 AND draft_revision<9007199254740991),
 target_region_id uuid NOT NULL REFERENCES whaleu_campus.operating_regions(id),
 slot text NOT NULL CHECK(slot IN('public0','public1','public2','private0','private1','private2')),
 scope_revision whaleu_media.digest NOT NULL,input jsonb NOT NULL,authority_version text NOT NULL CHECK(length(authority_version) BETWEEN 1 AND 200),
 created_at timestamptz NOT NULL DEFAULT statement_timestamp(),expires_at timestamptz NOT NULL,
 UNIQUE(actor_id,client_request_id),CHECK(isfinite(expires_at) AND expires_at>created_at AND expires_at<=created_at+interval '30 minutes')
);
CREATE INDEX errand_scope_draft_slot ON whaleu_media.errand_scopes(draft_id,slot);
CREATE TABLE whaleu_media.errand_appearances(
 id uuid PRIMARY KEY,order_id uuid NOT NULL REFERENCES whaleu_errands.orders(id) DEFERRABLE INITIALLY DEFERRED,
 slot text NOT NULL CHECK(slot IN('public0','public1','public2','private0','private1','private2')),
 actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),draft_id uuid NOT NULL,
 draft_revision bigint NOT NULL CHECK(draft_revision>0 AND draft_revision<9007199254740991),
 asset_id uuid NOT NULL UNIQUE REFERENCES whaleu_media.assets(id),manifest_digest whaleu_media.digest NOT NULL,
 binding_id uuid NOT NULL UNIQUE REFERENCES whaleu_media.bindings(id) DEFERRABLE INITIALLY DEFERRED,
 publication_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),UNIQUE(order_id,slot)
);
CREATE TABLE whaleu_media.errand_retirements(
 binding_id uuid PRIMARY KEY REFERENCES whaleu_media.bindings(id),order_id uuid NOT NULL REFERENCES whaleu_errands.orders(id),
 cause text NOT NULL CHECK(cause IN('deleted','audit_subtraction')),transaction_id xid8 NOT NULL DEFAULT pg_current_xact_id()
);
DO $$DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['errand_scopes','errand_appearances','errand_retirements'] LOOP
 EXECUTE format('CREATE TRIGGER a0_errand_media_policy BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_media.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.content_policy_writer_gate()',t);
 EXECUTE format('CREATE TRIGGER a1_errand_media_epoch BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_media.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_media.advance_owner_epoch()',t);
 EXECUTE format('CREATE TRIGGER errand_media_retain BEFORE TRUNCATE ON whaleu_media.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_media.immutable_record()',t);
 EXECUTE format('CREATE TRIGGER errand_media_immutable BEFORE UPDATE OR DELETE ON whaleu_media.%I FOR EACH ROW EXECUTE FUNCTION whaleu_media.immutable_record()',t);
 END LOOP;
END$$;
CREATE FUNCTION whaleu_media.errand_request_hash(actor uuid,v jsonb) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT encode(sha256(convert_to('whaleu-errand-media-prepare:v1'||chr(10)||
 '{"protocol":"errand-media-v1","actorAccountId":'||to_json(actor::text)::text||
 ',"clientRequestId":'||to_json(v->>'clientRequestId')::text||',"draftId":'||to_json(v->>'draftId')::text||
 ',"draftRevision":'||(v->>'draftRevision')||',"targetRegionId":'||to_json(v->>'targetRegionId')::text||',"slot":'||to_json(v->>'slot')::text||
 ',"declaration":{"mime":'||to_json(v->'declaration'->>'mime')::text||',"bytes":'||(v->'declaration'->>'bytes')||',"sha256":'||to_json(v->'declaration'->>'sha256')::text||'}}','UTF8')),'hex')
$$;
-- The owner draft table is installed by 0110. PL/pgSQL resolves it at execution.
CREATE FUNCTION whaleu_media.errand_scope_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v jsonb;BEGIN v:=NEW.input;
 -- The owner row serializes slot intent admission even for direct SQL writers.
 PERFORM 1 FROM whaleu_errands.media_drafts WHERE id=NEW.draft_id FOR UPDATE NOWAIT;
 IF EXISTS(SELECT 1 FROM whaleu_media.errand_scopes prior JOIN whaleu_media.upload_intents i ON i.resource_id=prior.id AND i.actor_id=prior.actor_id AND i.protocol_version=14
 WHERE prior.draft_id=NEW.draft_id AND prior.slot=NEW.slot AND i.state IN('prepared','upload_observed','sealing','processing','awaiting_review','ready'))
 THEN RAISE EXCEPTION 'Errand slot retains an active original request' USING ERRCODE='23514';END IF;
 IF NOT coalesce(whaleu_community.rating_scoped_keys(v,ARRAY['protocol','clientRequestId','draftId','draftRevision','targetRegionId','slot','declaration'])
 AND v->>'protocol'='errand-media-v1' AND v->>'clientRequestId'=NEW.client_request_id::text AND v->>'draftId'=NEW.draft_id::text
 AND jsonb_typeof(v->'draftRevision')='number' AND v->>'draftRevision' ~ '^[1-9][0-9]*$' AND (v->>'draftRevision')::bigint=NEW.draft_revision
 AND v->>'targetRegionId'=NEW.target_region_id::text AND v->>'slot'=NEW.slot
 AND NEW.scope_revision=whaleu_media.errand_request_hash(NEW.actor_id,v)
 AND whaleu_community.rating_scoped_keys(v->'declaration',ARRAY['mime','bytes','sha256']) AND v->'declaration'->>'mime' IN ('image/jpeg','image/png')
 AND whaleu_community.rating_scoped_integer(v->'declaration'->'bytes',1) AND (v->'declaration'->>'bytes')::bigint BETWEEN 1 AND 5242880 AND v->'declaration'->>'sha256' ~ '^[a-f0-9]{64}$'
 AND EXISTS(SELECT 1 FROM whaleu_errands.media_drafts d WHERE d.id=NEW.draft_id AND d.actor_id=NEW.actor_id AND d.revision=NEW.draft_revision AND d.target_region_id=NEW.target_region_id AND d.authority_version=NEW.authority_version AND d.state='open' AND d.expires_at>=NEW.expires_at AND d.expires_at>clock_timestamp()),false)
 THEN RAISE EXCEPTION 'Errand upload requires exact current owner draft' USING ERRCODE='23514';END IF;RETURN NEW;
END$$;
CREATE TRIGGER errand_scope BEFORE INSERT ON whaleu_media.errand_scopes FOR EACH ROW EXECUTE FUNCTION whaleu_media.errand_scope_guard();
DROP TRIGGER media_binding_guard ON whaleu_media.bindings;
CREATE TRIGGER media_binding_guard BEFORE INSERT ON whaleu_media.bindings FOR EACH ROW WHEN(NEW.owner_kind NOT IN ('verification','announcements','activities','organizations','school_configuration') AND NOT(NEW.owner_kind='ratings' AND NEW.resource_kind IN ('rating_comment','rating_reply','category_icon')) AND NOT(NEW.owner_kind='errands' AND NEW.resource_kind='errand_image')) EXECUTE FUNCTION whaleu_media.binding_guard();
DROP TRIGGER media_scope_consumption_complete ON whaleu_media.scope_consumptions;
CREATE CONSTRAINT TRIGGER media_scope_consumption_complete AFTER INSERT ON whaleu_media.scope_consumptions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.owner_kind NOT IN ('verification','announcements','activities','organizations','school_configuration') AND NOT(NEW.owner_kind='ratings' AND NEW.resource_kind IN ('rating_comment','rating_reply','category_icon')) AND NOT(NEW.owner_kind='errands' AND NEW.resource_kind='errand_image')) EXECUTE FUNCTION whaleu_media.scope_consumption_complete();
CREATE FUNCTION whaleu_media.errand_namespace_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE f whaleu_media.upload_request_fences;i whaleu_media.upload_intents;actor uuid;request uuid;BEGIN
 actor:=NEW.actor_id;
 IF TG_TABLE_NAME='ratings_discussion_batch_request_fences' THEN request:=NEW.batch_request_id;ELSE request:=NEW.client_request_id;END IF;
 SELECT * INTO f FROM whaleu_media.upload_request_fences WHERE actor_id=actor AND client_request_id=request;
 IF f.protocol_namespace IS DISTINCT FROM 14 THEN
  IF TG_TABLE_NAME='upload_intents' THEN
   IF NEW.protocol_version=14 THEN RAISE EXCEPTION 'Errand media requires Media14 receipt' USING ERRCODE='23514';END IF;
  END IF;RETURN NULL;
 END IF;
 IF EXISTS(SELECT 1 FROM whaleu_media.profile_request_markers WHERE actor_id=actor AND client_request_id=request)
 OR EXISTS(SELECT 1 FROM whaleu_media.ratings_request_markers WHERE actor_id=actor AND client_request_id=request)
 OR EXISTS(SELECT 1 FROM whaleu_media.ratings_discussion_request_markers WHERE actor_id=actor AND client_request_id=request)
 OR EXISTS(SELECT 1 FROM whaleu_media.category_icon_request_markers WHERE actor_id=actor AND client_request_id=request)
 OR EXISTS(SELECT 1 FROM whaleu_media.ratings_discussion_batch_request_fences WHERE actor_id=actor AND batch_request_id=request)
 THEN RAISE EXCEPTION 'Errand media request namespace is exclusive' USING ERRCODE='23514';END IF;
 IF f.intent_id IS NOT NULL THEN
 SELECT * INTO STRICT i FROM whaleu_media.upload_intents WHERE id=f.intent_id;
 IF i.protocol_version<>14 OR (i.actor_id,i.client_request_id,i.request_hash) IS DISTINCT FROM (actor,request,f.request_hash)
 THEN RAISE EXCEPTION 'Errand media exact receipt mismatch' USING ERRCODE='23514';END IF;END IF;
 IF TG_TABLE_NAME='upload_intents' THEN
 IF NEW.protocol_version<>14 OR f.intent_id IS DISTINCT FROM NEW.id THEN RAISE EXCEPTION 'Errand media intent mismatch' USING ERRCODE='23514';END IF;END IF;
 RETURN NULL;
END$$;
DO $$DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['upload_intents','upload_request_fences','profile_request_markers','ratings_request_markers','ratings_discussion_request_markers','category_icon_request_markers','ratings_discussion_batch_request_fences'] LOOP
 EXECUTE format('CREATE CONSTRAINT TRIGGER errand_namespace AFTER INSERT OR UPDATE ON whaleu_media.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_media.errand_namespace_guard()',t);
 END LOOP;
END$$;
CREATE FUNCTION whaleu_media.errand_intent_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s whaleu_media.errand_scopes;BEGIN
 SELECT * INTO s FROM whaleu_media.errand_scopes WHERE id=NEW.resource_id AND actor_id=NEW.actor_id;
 PERFORM 1 FROM whaleu_errands.media_drafts WHERE id=s.draft_id FOR UPDATE NOWAIT;
 IF EXISTS(SELECT 1 FROM whaleu_media.errand_scopes prior JOIN whaleu_media.upload_intents i ON i.resource_id=prior.id AND i.actor_id=prior.actor_id AND i.protocol_version=14
 WHERE prior.draft_id=s.draft_id AND prior.slot=s.slot AND i.state IN('prepared','upload_observed','sealing','processing','awaiting_review','ready'))
 THEN RAISE EXCEPTION 'Errand slot retains an active original request' USING ERRCODE='23514';END IF;
 IF s.id IS NULL OR (NEW.client_request_id,NEW.scope_revision,NEW.request_hash,NEW.expires_at,NEW.slot) IS DISTINCT FROM (s.client_request_id,s.scope_revision,s.scope_revision,s.expires_at,s.slot)
 OR NEW.declared_bytes<>(s.input->'declaration'->>'bytes')::bigint OR NEW.declared_mime<>s.input->'declaration'->>'mime' OR NEW.declared_sha256<>s.input->'declaration'->>'sha256'
 THEN RAISE EXCEPTION 'Errand media intent requires exact original owner scope' USING ERRCODE='23514';END IF;RETURN NEW;
END$$;
CREATE TRIGGER errand_intent BEFORE INSERT ON whaleu_media.upload_intents FOR EACH ROW WHEN(NEW.protocol_version=14) EXECUTE FUNCTION whaleu_media.errand_intent_guard();
CREATE FUNCTION whaleu_media.errand_binding_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a whaleu_media.assets;i whaleu_media.upload_intents;s whaleu_media.errand_scopes;c whaleu_media.scope_consumptions;BEGIN
 SELECT * INTO STRICT a FROM whaleu_media.assets WHERE id=NEW.asset_id;SELECT * INTO STRICT i FROM whaleu_media.upload_intents WHERE id=a.intent_id;
 SELECT * INTO s FROM whaleu_media.errand_scopes WHERE id=a.resource_id AND actor_id=a.actor_id;
 SELECT * INTO c FROM whaleu_media.scope_consumptions WHERE actor_id=a.actor_id AND owner_kind='errands' AND resource_kind='errand_image' AND scope_resource_id=a.resource_id;
 IF i.protocol_version<>14 OR i.state<>'ready' OR s.id IS NULL OR least(s.expires_at,a.created_at+interval '24 hours')<=clock_timestamp()
 OR NEW.detached_at IS NOT NULL
 OR (NEW.owner_kind,NEW.resource_kind,NEW.content_version,NEW.slot,NEW.ordinal,NEW.manifest_digest) IS DISTINCT FROM (a.owner_kind,a.resource_kind,a.content_version,a.slot,a.ordinal,a.manifest_digest)
 OR NEW.attach_evidence IS DISTINCT FROM jsonb_build_object('version',14,'scopeId',a.resource_id::text,'scopeRevision',a.scope_revision)
 OR c.transaction_id IS DISTINCT FROM pg_current_xact_id() OR c.resource_id IS DISTINCT FROM NEW.resource_id OR c.scope_revision IS DISTINCT FROM a.scope_revision OR c.content_version IS DISTINCT FROM 1::bigint
 OR c.attach_evidence IS DISTINCT FROM jsonb_build_object('version',14,'assets',jsonb_build_array(jsonb_build_object('assetId',a.id::text,'digest',a.manifest_digest)))
 OR NOT EXISTS(SELECT 1 FROM whaleu_media.asset_safety_heads h JOIN whaleu_media.asset_safety_events e ON(e.asset_id,e.revision,e.id)=(h.asset_id,h.revision,h.event_id) WHERE h.asset_id=a.id AND e.state='allow' AND e.manifest_digest=a.manifest_digest AND e.policy_revision=a.policy_revision AND e.effective_at<=clock_timestamp() AND e.valid_until>clock_timestamp())
 THEN RAISE EXCEPTION 'Errand binding requires exact current Media14 acceptance' USING ERRCODE='23514';END IF;
 IF TG_WHEN='BEFORE' AND NOT EXISTS(SELECT 1 FROM whaleu_errands.media_drafts d WHERE d.id=s.draft_id AND d.actor_id=s.actor_id AND d.revision=s.draft_revision AND d.target_region_id=s.target_region_id AND d.authority_version=s.authority_version AND d.state='open' AND d.expires_at>clock_timestamp())
 THEN RAISE EXCEPTION 'Only exact current owner draft may publish errand media' USING ERRCODE='23514';END IF;
 IF TG_WHEN='AFTER' AND NOT EXISTS(SELECT 1 FROM whaleu_media.errand_appearances p
 JOIN whaleu_errands.media_publications pub ON pub.order_id=p.order_id
 JOIN whaleu_errands.media_sets ms ON ms.order_id=p.order_id AND ms.revision=1
 WHERE p.id=NEW.resource_id AND p.binding_id=NEW.id AND p.asset_id=a.id AND p.manifest_digest=a.manifest_digest AND p.actor_id=a.actor_id AND p.slot=a.slot
 AND (p.draft_id,p.draft_revision,p.actor_id)=(s.draft_id,s.draft_revision,s.actor_id)
 AND (pub.draft_id,pub.draft_revision,pub.actor_id)=(p.draft_id,p.draft_revision,p.actor_id)
 AND p.publication_transaction=pg_current_xact_id() AND pub.publication_transaction=p.publication_transaction AND ms.transaction_id=p.publication_transaction
 AND EXISTS(SELECT 1 FROM jsonb_array_elements(ms.public_media||ms.private_media) v WHERE v=jsonb_build_object('slot',p.slot,'assetId',p.asset_id::text,'manifestDigest',p.manifest_digest,'bindingId',p.binding_id::text)))
 THEN RAISE EXCEPTION 'Errand binding must publish exact initial owner set atomically' USING ERRCODE='23514';END IF;RETURN NEW;
END$$;
CREATE TRIGGER errand_binding BEFORE INSERT ON whaleu_media.bindings FOR EACH ROW WHEN(NEW.owner_kind='errands' AND NEW.resource_kind='errand_image') EXECUTE FUNCTION whaleu_media.errand_binding_guard();
CREATE CONSTRAINT TRIGGER errand_binding_final AFTER INSERT ON whaleu_media.bindings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.owner_kind='errands' AND NEW.resource_kind='errand_image') EXECUTE FUNCTION whaleu_media.errand_binding_guard();
CREATE FUNCTION whaleu_media.errand_consumption_guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF NEW.transaction_id<>pg_current_xact_id() OR NOT EXISTS(SELECT 1 FROM whaleu_media.bindings b JOIN whaleu_media.assets a ON a.id=b.asset_id WHERE b.owner_kind='errands' AND b.resource_kind='errand_image' AND b.resource_id=NEW.resource_id AND b.detached_at IS NULL AND a.resource_id=NEW.scope_resource_id AND a.actor_id=NEW.actor_id AND a.scope_revision=NEW.scope_revision)
 THEN RAISE EXCEPTION 'Errand consumption requires exact atomic binding' USING ERRCODE='23514';END IF;RETURN NULL;END$$;
CREATE CONSTRAINT TRIGGER errand_consumption_final AFTER INSERT ON whaleu_media.scope_consumptions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.owner_kind='errands' AND NEW.resource_kind='errand_image') EXECUTE FUNCTION whaleu_media.errand_consumption_guard();
CREATE FUNCTION whaleu_media.errand_appearance_guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF NEW.publication_transaction<>pg_current_xact_id() OR NOT EXISTS(
 SELECT 1 FROM whaleu_media.bindings b JOIN whaleu_media.assets a ON a.id=b.asset_id
 JOIN whaleu_media.upload_intents i ON i.id=a.intent_id JOIN whaleu_media.errand_scopes s ON s.id=a.resource_id
 JOIN whaleu_errands.media_publications p ON p.order_id=NEW.order_id JOIN whaleu_errands.media_sets ms ON ms.order_id=p.order_id AND ms.revision=1
 WHERE b.id=NEW.binding_id AND b.owner_kind='errands' AND b.resource_kind='errand_image' AND b.resource_id=NEW.id AND b.slot=NEW.slot AND b.asset_id=NEW.asset_id AND b.manifest_digest=NEW.manifest_digest
 AND i.protocol_version=14 AND a.actor_id=NEW.actor_id AND a.slot=NEW.slot AND a.manifest_digest=NEW.manifest_digest
 AND (s.draft_id,s.draft_revision,s.actor_id,s.slot)=(NEW.draft_id,NEW.draft_revision,NEW.actor_id,NEW.slot)
 AND (p.draft_id,p.draft_revision,p.actor_id)=(NEW.draft_id,NEW.draft_revision,NEW.actor_id)
 AND p.publication_transaction=NEW.publication_transaction AND ms.transaction_id=NEW.publication_transaction
 AND EXISTS(SELECT 1 FROM jsonb_array_elements(ms.public_media||ms.private_media) v WHERE v=jsonb_build_object('slot',NEW.slot,'assetId',NEW.asset_id::text,'manifestDigest',NEW.manifest_digest,'bindingId',NEW.binding_id::text)))
 THEN RAISE EXCEPTION 'Errand appearance requires atomic exact owner publication' USING ERRCODE='23514';END IF;RETURN NULL;END$$;
CREATE CONSTRAINT TRIGGER errand_appearance_final AFTER INSERT ON whaleu_media.errand_appearances DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_media.errand_appearance_guard();
CREATE FUNCTION whaleu_media.errand_detach_guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF OLD.detached_at IS NULL AND NEW.detached_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM whaleu_media.errand_retirements r WHERE r.binding_id=NEW.id AND r.transaction_id=pg_current_xact_id() AND NEW.detach_reason='errand-media-'||r.cause)
 THEN RAISE EXCEPTION 'Errand detach requires exact owner retirement' USING ERRCODE='23514';END IF;RETURN NEW;END$$;
CREATE TRIGGER errand_detach BEFORE UPDATE ON whaleu_media.bindings FOR EACH ROW WHEN(NEW.owner_kind='errands' AND NEW.resource_kind='errand_image') EXECUTE FUNCTION whaleu_media.errand_detach_guard();
CREATE FUNCTION whaleu_media.errand_retirement_guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF NEW.transaction_id<>pg_current_xact_id() OR NOT EXISTS(SELECT 1 FROM whaleu_media.errand_appearances p JOIN whaleu_media.bindings b ON b.id=p.binding_id JOIN whaleu_errands.orders o ON o.id=p.order_id
 WHERE p.binding_id=NEW.binding_id AND p.order_id=NEW.order_id AND b.resource_id=p.id AND b.asset_id=p.asset_id AND b.manifest_digest=p.manifest_digest AND b.detached_at IS NOT NULL AND b.detach_reason='errand-media-'||NEW.cause
 AND ((NEW.cause='deleted' AND o.deleted_at IS NOT NULL) OR (NEW.cause='audit_subtraction' AND EXISTS(
 SELECT 1 FROM whaleu_errands.media_heads h JOIN whaleu_errands.media_sets s ON(s.order_id,s.revision)=(h.order_id,h.revision)
 JOIN whaleu_errands.media_sets prior ON(prior.order_id,prior.revision)=(s.order_id,s.prior_revision)
 WHERE h.order_id=o.id AND s.cause='audit_subtraction' AND s.revision=prior.revision+1 AND s.transaction_id=pg_current_xact_id()
 AND EXISTS(SELECT 1 FROM jsonb_array_elements(prior.public_media||prior.private_media) v WHERE v->>'bindingId'=NEW.binding_id::text)
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(s.public_media||s.private_media) v WHERE v->>'bindingId'=NEW.binding_id::text)))))
 THEN RAISE EXCEPTION 'Errand retirement requires owner deletion or exact audit subtraction' USING ERRCODE='23514';END IF;RETURN NULL;END$$;
CREATE CONSTRAINT TRIGGER errand_retirement_final AFTER INSERT ON whaleu_media.errand_retirements DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_media.errand_retirement_guard();
