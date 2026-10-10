-- Independent Media7 Ratings root/reply images. Additive dispatch only: all
-- historical SQL files and protocol1-6 canonical codecs remain byte-for-byte.
-- This migration creates no provider, issuer, source adoption or activation.
SET LOCAL lock_timeout='5s';
SELECT pg_advisory_xact_lock(hashtextextended('whaleu:named-block-policy:v1',0));
CREATE FUNCTION whaleu_media.ratings_discussion_batch_shape(v jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE t jsonb;keys text[];
BEGIN
 IF NOT whaleu_community.rating_scoped_keys(v,ARRAY['protocol','batchRequestId','commandRequestId','draftRevision','categoryId','expectedCategoryRevision','context','target'])
 OR v->'protocol' IS DISTINCT FROM '"ratings-discussion-media-v1"'::jsonb
 OR NOT whaleu_community.rating_scoped_ids(v,ARRAY['batchRequestId','commandRequestId','draftRevision','categoryId','expectedCategoryRevision'])
 OR v->>'batchRequestId'=v->>'commandRequestId'
 OR NOT whaleu_ratings.discussion_media_command_context_shape(v->'context') THEN RETURN false;END IF;
 t:=v->'target';keys:=ARRAY['kind','targetId','expectedTargetRevision','expectedDefinitionRevision','expectedContentVersion'];
 IF t->>'kind'='reply' THEN
  keys:=keys||ARRAY['rootId','expectedRootRevision','replyTo'];
  IF NOT whaleu_community.rating_scoped_ids(t,ARRAY['rootId','expectedRootRevision'])
   OR (t->'replyTo'='null'::jsonb OR (whaleu_community.rating_scoped_keys(t->'replyTo',ARRAY['replyId','expectedRevision'])
    AND whaleu_community.rating_scoped_ids(t->'replyTo',ARRAY['replyId','expectedRevision']) AND t->'replyTo'->>'replyId'<>t->>'rootId')) IS NOT TRUE THEN RETURN false;END IF;
 ELSIF t->>'kind' IS DISTINCT FROM 'root' THEN RETURN false;END IF;
 RETURN whaleu_community.rating_scoped_keys(t,keys)
 AND whaleu_community.rating_scoped_ids(t,ARRAY['targetId','expectedTargetRevision','expectedDefinitionRevision'])
 AND whaleu_community.rating_scoped_integer(t->'expectedContentVersion',1);
 EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
CREATE FUNCTION whaleu_media.ratings_discussion_batch_hash(actor uuid,v jsonb) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT encode(sha256(convert_to('whaleu:ratings-discussion-media-batch:v1'||chr(10)||whaleu_community.content_canonical_json(jsonb_build_object('actorAccountId',actor::text,'identity',v)),'UTF8')),'hex')
$$;
CREATE FUNCTION whaleu_media.ratings_discussion_member_shape(v jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
 RETURN coalesce(whaleu_community.rating_scoped_keys(v,ARRAY['protocol','clientRequestId','batchId','batchIdentityHash','memberId','sourceSlot','declaration'])
 AND v->'protocol'='"ratings-discussion-media-v1"'::jsonb
 AND whaleu_community.rating_scoped_ids(v,ARRAY['clientRequestId','batchId','memberId'])
 AND jsonb_typeof(v->'batchIdentityHash')='string' AND v->>'batchIdentityHash' ~ '^[a-f0-9]{64}$'
 AND whaleu_community.rating_scoped_integer(v->'sourceSlot',0) AND (v->>'sourceSlot')::integer<=127
 AND whaleu_community.rating_scoped_keys(v->'declaration',ARRAY['mime','bytes','sha256'])
 AND v->'declaration'->>'mime' IN ('image/jpeg','image/png')
 AND whaleu_community.rating_scoped_integer(v->'declaration'->'bytes',1) AND (v->'declaration'->>'bytes')::integer<=5242880
 AND jsonb_typeof(v->'declaration'->'sha256')='string' AND v->'declaration'->>'sha256' ~ '^[a-f0-9]{64}$',false);
 EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
CREATE FUNCTION whaleu_media.ratings_discussion_member_hash(actor uuid,v jsonb) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT encode(sha256(convert_to('whaleu:ratings-discussion-media-member:v1'||chr(10)||whaleu_community.content_canonical_json(jsonb_build_object('actorAccountId',actor::text,'member',v)),'UTF8')),'hex')
$$;
CREATE FUNCTION whaleu_media.ratings_discussion_plan_hash(v jsonb) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT encode(sha256(convert_to('whaleu:ratings-discussion-media-plan:v1'||chr(10)||whaleu_community.content_canonical_json(v),'UTF8')),'hex')
$$;
CREATE TABLE whaleu_media.ratings_discussion_batches(
 id uuid PRIMARY KEY,actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
 batch_request_id uuid NOT NULL,command_request_id uuid NOT NULL,
 identity jsonb NOT NULL CHECK(whaleu_media.ratings_discussion_batch_shape(identity)),
 identity_hash whaleu_media.digest NOT NULL,server_scope_id uuid NOT NULL UNIQUE,scope_revision whaleu_media.label NOT NULL,
 expires_at timestamptz NOT NULL CHECK(isfinite(expires_at)),
 revision uuid NOT NULL,state text NOT NULL DEFAULT 'editing' CHECK(state IN ('editing','sealed','consumed','cancelled')),
 sealed_plan jsonb,sealed_plan_digest whaleu_media.digest,consumed_parent jsonb,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(id,actor_id),UNIQUE(actor_id,batch_request_id),UNIQUE(actor_id,command_request_id),
 CHECK(expires_at>created_at),CHECK(scope_revision=identity_hash),CHECK(identity_hash=whaleu_media.ratings_discussion_batch_hash(actor_id,identity)),
 CHECK(batch_request_id::text=identity->>'batchRequestId' AND command_request_id::text=identity->>'commandRequestId'),
 CHECK((sealed_plan IS NULL)=(sealed_plan_digest IS NULL)),
 CHECK(state NOT IN ('sealed','consumed') OR sealed_plan IS NOT NULL),
 CHECK(state<>'editing' OR sealed_plan IS NULL),
 CHECK((state='consumed')=(consumed_parent IS NOT NULL)),
 CHECK(sealed_plan IS NULL OR coalesce(whaleu_community.rating_scoped_keys(sealed_plan,ARRAY['batchId','batchIdentityHash','orderedMembers'])
  AND sealed_plan->>'batchId'=id::text AND sealed_plan->>'batchIdentityHash'=identity_hash
  AND whaleu_ratings.discussion_media_images_shape(sealed_plan->'orderedMembers',CASE WHEN identity->'target'->>'kind'='reply' THEN 3 ELSE 9 END,true)
  AND jsonb_array_length(sealed_plan->'orderedMembers')>0 AND sealed_plan_digest=whaleu_media.ratings_discussion_plan_hash(sealed_plan),false))
);
-- Batch request recovery has its own immutable receipt, but shares the actor
-- request namespace and rate budget with every upload protocol.
CREATE TABLE whaleu_media.ratings_discussion_batch_request_fences(
 actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),batch_request_id uuid NOT NULL,
 identity_hash whaleu_media.digest NOT NULL,batch_id uuid UNIQUE,
 state text NOT NULL CHECK(state IN ('recorded','cancelled_before_prepare')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(created_at)),
 PRIMARY KEY(actor_id,batch_request_id),
 FOREIGN KEY(batch_id,actor_id) REFERENCES whaleu_media.ratings_discussion_batches(id,actor_id),
 CHECK((state='recorded')=(batch_id IS NOT NULL))
);
CREATE INDEX ratings_discussion_batch_request_budget ON whaleu_media.ratings_discussion_batch_request_fences(actor_id,created_at);
CREATE TABLE whaleu_media.ratings_discussion_members(
 batch_id uuid NOT NULL,member_id uuid PRIMARY KEY,actor_id uuid NOT NULL,client_request_id uuid NOT NULL,
 source_slot integer NOT NULL CHECK(source_slot BETWEEN 0 AND 127),input jsonb NOT NULL CHECK(whaleu_media.ratings_discussion_member_shape(input)),
 intent_id uuid NOT NULL UNIQUE,state text NOT NULL DEFAULT 'live' CHECK(state IN ('live','removed','bound')),
 UNIQUE(batch_id,member_id),UNIQUE(batch_id,source_slot),UNIQUE(actor_id,client_request_id),
 FOREIGN KEY(batch_id,actor_id) REFERENCES whaleu_media.ratings_discussion_batches(id,actor_id),
 FOREIGN KEY(intent_id,actor_id) REFERENCES whaleu_media.upload_intents(id,actor_id),
 CHECK(input->>'batchId'=batch_id::text AND input->>'memberId'=member_id::text AND input->>'clientRequestId'=client_request_id::text AND input->'sourceSlot'=to_jsonb(source_slot))
);
CREATE TABLE whaleu_media.ratings_discussion_request_markers(
 actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),client_request_id uuid NOT NULL,request_hash whaleu_media.digest NOT NULL,
 PRIMARY KEY(actor_id,client_request_id),
 FOREIGN KEY(actor_id,client_request_id) REFERENCES whaleu_media.upload_request_fences(actor_id,client_request_id) DEFERRABLE INITIALLY DEFERRED
);
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['ratings_discussion_batches','ratings_discussion_members','ratings_discussion_request_markers','ratings_discussion_batch_request_fences'] LOOP
  EXECUTE format('CREATE TRIGGER a0_media_policy_gate BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_media.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.content_policy_writer_gate()',t);
  EXECUTE format('CREATE TRIGGER a1_media_owner_epoch BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_media.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_media.advance_owner_epoch()',t);
  EXECUTE format('CREATE TRIGGER media_retain BEFORE TRUNCATE ON whaleu_media.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_media.immutable_record()',t);
 END LOOP;
END $$;
CREATE TRIGGER media_ratings_discussion_batch_identity BEFORE UPDATE OR DELETE ON whaleu_media.ratings_discussion_batches FOR EACH ROW EXECUTE FUNCTION whaleu_media.guard_mutable_record('revision,state,sealed_plan,sealed_plan_digest,consumed_parent');
CREATE TRIGGER media_ratings_discussion_member_identity BEFORE UPDATE OR DELETE ON whaleu_media.ratings_discussion_members FOR EACH ROW EXECUTE FUNCTION whaleu_media.guard_mutable_record('state');
CREATE TRIGGER media_ratings_discussion_marker_identity BEFORE UPDATE OR DELETE ON whaleu_media.ratings_discussion_request_markers FOR EACH ROW EXECUTE FUNCTION whaleu_media.immutable_record();
CREATE TRIGGER media_ratings_discussion_batch_fence_identity BEFORE UPDATE OR DELETE ON whaleu_media.ratings_discussion_batch_request_fences FOR EACH ROW EXECUTE FUNCTION whaleu_media.immutable_record();
CREATE FUNCTION whaleu_media.ratings_discussion_batch_request_namespace() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actor uuid;request uuid;BEGIN
 actor:=NEW.actor_id;
 IF TG_TABLE_NAME='ratings_discussion_batch_request_fences' THEN request:=NEW.batch_request_id;ELSE request:=NEW.client_request_id;END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('whaleu:media-reservation:v1:'||actor::text,0));
 IF TG_TABLE_NAME='ratings_discussion_batch_request_fences' THEN
  IF EXISTS(SELECT 1 FROM whaleu_media.upload_request_fences WHERE actor_id=actor AND client_request_id=request)
   OR EXISTS(SELECT 1 FROM whaleu_media.upload_intents WHERE actor_id=actor AND client_request_id=request)
  THEN RAISE EXCEPTION 'Discussion batch key conflicts with upload request' USING ERRCODE='23514';END IF;
 ELSE
  IF EXISTS(SELECT 1 FROM whaleu_media.ratings_discussion_batch_request_fences WHERE actor_id=actor AND batch_request_id=request)
  THEN RAISE EXCEPTION 'Upload key conflicts with discussion batch request' USING ERRCODE='23514';END IF;
 END IF;RETURN NEW;
END$$;
CREATE TRIGGER media7_batch_request_namespace BEFORE INSERT ON whaleu_media.ratings_discussion_batch_request_fences FOR EACH ROW EXECUTE FUNCTION whaleu_media.ratings_discussion_batch_request_namespace();
CREATE TRIGGER media7_upload_request_namespace BEFORE INSERT ON whaleu_media.upload_request_fences FOR EACH ROW EXECUTE FUNCTION whaleu_media.ratings_discussion_batch_request_namespace();
CREATE TRIGGER media7_upload_intent_namespace BEFORE INSERT ON whaleu_media.upload_intents FOR EACH ROW EXECUTE FUNCTION whaleu_media.ratings_discussion_batch_request_namespace();
CREATE FUNCTION whaleu_media.ratings_discussion_batch_request_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actor uuid;request uuid;f whaleu_media.ratings_discussion_batch_request_fences;b whaleu_media.ratings_discussion_batches;BEGIN
 actor:=NEW.actor_id;request:=NEW.batch_request_id;
 SELECT * INTO f FROM whaleu_media.ratings_discussion_batch_request_fences WHERE actor_id=actor AND batch_request_id=request;
 SELECT * INTO b FROM whaleu_media.ratings_discussion_batches WHERE actor_id=actor AND batch_request_id=request;
 IF f.actor_id IS NULL OR (f.state='cancelled_before_prepare' AND b.id IS NOT NULL)
 OR (f.state='recorded' AND (b.id IS NULL OR (f.batch_id,f.identity_hash) IS DISTINCT FROM (b.id,b.identity_hash)))
 THEN RAISE EXCEPTION 'Discussion batch request has no exact durable receipt' USING ERRCODE='23514';END IF;RETURN NULL;
END$$;
CREATE CONSTRAINT TRIGGER media7_batch_request_complete AFTER INSERT ON whaleu_media.ratings_discussion_batch_request_fences DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_media.ratings_discussion_batch_request_complete();
CREATE CONSTRAINT TRIGGER media7_batch_has_request AFTER INSERT ON whaleu_media.ratings_discussion_batches DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_media.ratings_discussion_batch_request_complete();
CREATE FUNCTION whaleu_media.ratings_discussion_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='ratings_discussion_batches' THEN
  IF TG_OP='UPDATE' AND (NEW.revision=OLD.revision OR OLD.state IN ('consumed','cancelled')
    OR (OLD.state='sealed' AND NEW.state NOT IN ('consumed','cancelled'))
    OR (OLD.sealed_plan IS NOT NULL AND ROW(NEW.sealed_plan,NEW.sealed_plan_digest) IS DISTINCT FROM ROW(OLD.sealed_plan,OLD.sealed_plan_digest))) THEN
    RAISE EXCEPTION 'Ratings Media batch transition unavailable' USING ERRCODE='23514';END IF;
 ELSE
  IF TG_OP='UPDATE' AND (OLD.state<>'live' OR NEW.state NOT IN ('removed','bound')) THEN
    RAISE EXCEPTION 'Ratings Media member transition unavailable' USING ERRCODE='23514';END IF;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER media_ratings_discussion_transition BEFORE UPDATE ON whaleu_media.ratings_discussion_batches FOR EACH ROW EXECUTE FUNCTION whaleu_media.ratings_discussion_transition();
CREATE TRIGGER media_ratings_discussion_transition BEFORE UPDATE ON whaleu_media.ratings_discussion_members FOR EACH ROW EXECUTE FUNCTION whaleu_media.ratings_discussion_transition();

ALTER TABLE whaleu_media.upload_intents DROP CONSTRAINT media_protocol_identity;
ALTER TABLE whaleu_media.upload_intents ADD CONSTRAINT media_protocol_identity CHECK(
 (protocol_version=1 AND request_hash IS NULL AND declared_sha256 IS NULL) OR
 (protocol_version IN (2,3,4,5,6,7) AND request_hash IS NOT NULL AND declared_sha256 IS NOT NULL));
ALTER TABLE whaleu_media.upload_intents DROP CONSTRAINT upload_intents_ordinal_check;
ALTER TABLE whaleu_media.upload_intents ADD CONSTRAINT upload_intents_ordinal_check CHECK(ordinal BETWEEN 0 AND CASE WHEN protocol_version=7 THEN 127 ELSE 8 END);
ALTER TABLE whaleu_media.assets DROP CONSTRAINT assets_ordinal_check;
ALTER TABLE whaleu_media.assets ADD CONSTRAINT assets_ordinal_check CHECK(ordinal BETWEEN 0 AND CASE WHEN owner_kind='ratings' AND resource_kind IN ('rating_comment','rating_reply') THEN 127 ELSE 8 END);
ALTER TABLE whaleu_media.upload_intents DROP CONSTRAINT media_ratings_scope;
ALTER TABLE whaleu_media.upload_intents ADD CONSTRAINT media_ratings_scope CHECK(
 (protocol_version=6 AND owner_kind='ratings' AND resource_kind='target_cover' AND audience='content-gated'
 AND target_kind='edit' AND content_version=1 AND slot='cover' AND ordinal=0 AND purpose='ratings-target-cover-image') OR
 (protocol_version=7 AND owner_kind='ratings' AND audience='content-gated' AND target_kind='draft' AND content_version=1 AND slot='images'
 AND ((resource_kind='rating_comment' AND purpose='ratings-comment-image') OR (resource_kind='rating_reply' AND purpose='ratings-reply-image'))) OR
 (protocol_version NOT IN (6,7) AND owner_kind<>'ratings' AND purpose NOT IN ('ratings-target-cover-image','ratings-comment-image','ratings-reply-image')));
ALTER TABLE whaleu_media.assets DROP CONSTRAINT media_ratings_asset_scope;
ALTER TABLE whaleu_media.assets ADD CONSTRAINT media_ratings_asset_scope CHECK(
 (owner_kind='ratings' AND resource_kind='target_cover' AND audience='content-gated' AND target_kind='edit'
 AND content_version=1 AND slot='cover' AND ordinal=0 AND purpose='ratings-target-cover-image') OR
 (owner_kind='ratings' AND audience='content-gated' AND target_kind='draft' AND content_version=1 AND slot='images'
 AND ((resource_kind='rating_comment' AND purpose='ratings-comment-image') OR (resource_kind='rating_reply' AND purpose='ratings-reply-image'))) OR
 (owner_kind<>'ratings' AND purpose NOT IN ('ratings-target-cover-image','ratings-comment-image','ratings-reply-image')));
ALTER TABLE whaleu_media.bindings DROP CONSTRAINT media_ratings_binding_slot;
ALTER TABLE whaleu_media.bindings ADD CONSTRAINT media_ratings_binding_slot CHECK(owner_kind<>'ratings' OR
 (resource_kind='target_cover' AND content_version=1 AND slot='cover' AND ordinal=0) OR
 (resource_kind='rating_comment' AND content_version=1 AND slot='images' AND ordinal BETWEEN 0 AND 8) OR
 (resource_kind='rating_reply' AND content_version=1 AND slot='images' AND ordinal BETWEEN 0 AND 2));

-- Historical trigger functions are untouched. Explicit row dispatch preserves
-- their precise legacy behavior and routes only new typed parents to Media7.
DROP TRIGGER media_binding_guard ON whaleu_media.bindings;
CREATE TRIGGER media_binding_guard BEFORE INSERT ON whaleu_media.bindings FOR EACH ROW
 WHEN(NOT(NEW.owner_kind='ratings' AND NEW.resource_kind IN ('rating_comment','rating_reply'))) EXECUTE FUNCTION whaleu_media.binding_guard();
DROP TRIGGER media_ratings_binding ON whaleu_media.bindings;
CREATE TRIGGER media_ratings_binding BEFORE INSERT ON whaleu_media.bindings FOR EACH ROW
 WHEN(NEW.owner_kind='ratings' AND NEW.resource_kind='target_cover') EXECUTE FUNCTION whaleu_media.ratings_binding_guard();
DROP TRIGGER media_ratings_binding_final ON whaleu_media.bindings;
CREATE CONSTRAINT TRIGGER media_ratings_binding_final AFTER INSERT ON whaleu_media.bindings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 WHEN(NEW.owner_kind='ratings' AND NEW.resource_kind='target_cover') EXECUTE FUNCTION whaleu_media.ratings_binding_guard();
DROP TRIGGER media_ratings_appearance ON whaleu_media.bindings;
CREATE CONSTRAINT TRIGGER media_ratings_appearance AFTER INSERT ON whaleu_media.bindings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 WHEN(NEW.owner_kind='ratings' AND NEW.resource_kind='target_cover') EXECUTE FUNCTION whaleu_media.ratings_appearance_coupling();
DROP TRIGGER media_scope_consumption_complete ON whaleu_media.scope_consumptions;
CREATE CONSTRAINT TRIGGER media_scope_consumption_complete AFTER INSERT ON whaleu_media.scope_consumptions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 WHEN(NOT(NEW.owner_kind='ratings' AND NEW.resource_kind IN ('rating_comment','rating_reply'))) EXECUTE FUNCTION whaleu_media.scope_consumption_complete();

CREATE FUNCTION whaleu_media.ratings_discussion_request_consistent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actor uuid;request uuid;marker whaleu_media.ratings_discussion_request_markers;f whaleu_media.upload_request_fences;i whaleu_media.upload_intents;
BEGIN
 actor:=NEW.actor_id;request:=NEW.client_request_id;
 SELECT * INTO marker FROM whaleu_media.ratings_discussion_request_markers WHERE actor_id=actor AND client_request_id=request;
 IF NOT FOUND THEN
  IF TG_TABLE_NAME='upload_intents' THEN
   IF NEW.protocol_version=7 THEN RAISE EXCEPTION 'Media7 requires its protocol marker' USING ERRCODE='23514';END IF;
  END IF;
  RETURN NULL;
 END IF;
 SELECT * INTO f FROM whaleu_media.upload_request_fences WHERE actor_id=actor AND client_request_id=request;
 IF NOT FOUND OR f.request_hash<>marker.request_hash OR EXISTS(SELECT 1 FROM whaleu_media.ratings_request_markers WHERE actor_id=actor AND client_request_id=request)
 OR EXISTS(SELECT 1 FROM whaleu_media.profile_request_markers WHERE actor_id=actor AND client_request_id=request) THEN
  RAISE EXCEPTION 'Media7 requires its exact shared request fence' USING ERRCODE='23514';END IF;
 IF f.intent_id IS NOT NULL THEN
  SELECT * INTO STRICT i FROM whaleu_media.upload_intents WHERE id=f.intent_id;
  IF i.protocol_version<>7 OR i.request_hash<>f.request_hash THEN RAISE EXCEPTION 'Media7 request protocol mismatch' USING ERRCODE='23514';END IF;
 END IF;RETURN NULL;
END $$;
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['ratings_discussion_request_markers','ratings_request_markers','profile_request_markers','upload_request_fences','upload_intents'] LOOP
  EXECUTE format('CREATE CONSTRAINT TRIGGER media7_request_consistent AFTER INSERT OR UPDATE ON whaleu_media.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_media.ratings_discussion_request_consistent()',t);
 END LOOP;
END $$;
CREATE FUNCTION whaleu_media.ratings_discussion_member_consistent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE m whaleu_media.ratings_discussion_members;b whaleu_media.ratings_discussion_batches;i whaleu_media.upload_intents;
BEGIN
 IF TG_TABLE_NAME='upload_intents' THEN
  IF NEW.protocol_version<>7 THEN RETURN NULL;END IF;
  SELECT * INTO STRICT m FROM whaleu_media.ratings_discussion_members WHERE intent_id=NEW.id;
 ELSE SELECT * INTO STRICT m FROM whaleu_media.ratings_discussion_members WHERE member_id=NEW.member_id;END IF;
 SELECT * INTO STRICT b FROM whaleu_media.ratings_discussion_batches WHERE id=m.batch_id;
 SELECT * INTO STRICT i FROM whaleu_media.upload_intents WHERE id=m.intent_id;
 IF (m.state='bound' AND b.state<>'consumed') OR i.protocol_version<>7 OR i.actor_id<>m.actor_id OR i.client_request_id<>m.client_request_id
 OR i.request_hash<>whaleu_media.ratings_discussion_member_hash(m.actor_id,m.input)
 OR m.input->>'batchIdentityHash'<>b.identity_hash
 OR ROW(i.resource_id,i.scope_revision,i.expires_at,i.ordinal) IS DISTINCT FROM ROW(b.server_scope_id,b.scope_revision,b.expires_at,m.source_slot)
 OR i.resource_kind<>(CASE WHEN b.identity->'target'->>'kind'='reply' THEN 'rating_reply' ELSE 'rating_comment' END)
 OR m.input->'declaration' IS DISTINCT FROM jsonb_build_object('mime',i.declared_mime,'bytes',i.declared_bytes,'sha256',i.declared_sha256)
 OR (SELECT count(*) FROM whaleu_media.ratings_discussion_members WHERE batch_id=b.id)>128
 OR (SELECT count(*) FROM whaleu_media.ratings_discussion_members WHERE batch_id=b.id AND state IN ('live','bound'))>(CASE WHEN b.identity->'target'->>'kind'='reply' THEN 3 ELSE 9 END) THEN
 RAISE EXCEPTION 'Media7 member requires exact immutable scope and declaration' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER media7_member_complete AFTER INSERT OR UPDATE ON whaleu_media.ratings_discussion_members DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_media.ratings_discussion_member_consistent();
CREATE CONSTRAINT TRIGGER media7_intent_complete AFTER INSERT ON whaleu_media.upload_intents DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_media.ratings_discussion_member_consistent();

CREATE FUNCTION whaleu_media.ratings_discussion_binding_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a whaleu_media.assets;i whaleu_media.upload_intents;m whaleu_media.ratings_discussion_members;b whaleu_media.ratings_discussion_batches;c whaleu_media.scope_consumptions;approved boolean;image jsonb;
BEGIN
 SELECT * INTO STRICT m FROM whaleu_media.ratings_discussion_members WHERE intent_id=(SELECT intent_id FROM whaleu_media.assets WHERE id=NEW.asset_id);
 SELECT * INTO STRICT b FROM whaleu_media.ratings_discussion_batches WHERE id=m.batch_id FOR UPDATE NOWAIT;
 PERFORM member_id FROM whaleu_media.ratings_discussion_members WHERE batch_id=b.id ORDER BY member_id FOR UPDATE NOWAIT;
 SELECT * INTO STRICT i FROM whaleu_media.upload_intents WHERE id=m.intent_id FOR UPDATE NOWAIT;
 SELECT * INTO STRICT a FROM whaleu_media.assets WHERE id=NEW.asset_id FOR UPDATE NOWAIT;
 SELECT e.state='allow' AND e.effective_at<=clock_timestamp() AND e.valid_until>clock_timestamp()
 AND e.manifest_digest=a.manifest_digest AND e.policy_revision=a.policy_revision INTO approved
 FROM whaleu_media.asset_safety_heads h JOIN whaleu_media.asset_safety_events e ON (e.asset_id,e.revision,e.id)=(h.asset_id,h.revision,h.event_id) WHERE h.asset_id=a.id;
 image:=b.sealed_plan->'orderedMembers'->NEW.ordinal;
 IF i.protocol_version<>7 OR i.state<>'ready' OR approved IS DISTINCT FROM true OR b.state NOT IN ('sealed','consumed')
 OR m.state NOT IN ('live','bound') OR b.expires_at<=clock_timestamp()
 OR ROW(NEW.owner_kind,NEW.resource_kind,NEW.content_version,NEW.slot,NEW.manifest_digest) IS DISTINCT FROM ROW(a.owner_kind,a.resource_kind,a.content_version,a.slot,a.manifest_digest)
 OR ROW(a.resource_id,a.scope_revision,a.ordinal) IS DISTINCT FROM ROW(b.server_scope_id,b.scope_revision,m.source_slot)
 OR NEW.detached_at IS NOT NULL OR image IS DISTINCT FROM jsonb_build_object('ordinal',NEW.ordinal,'memberId',m.member_id::text,'assetId',a.id::text,'manifestDigest',a.manifest_digest)
 OR NEW.attach_evidence IS DISTINCT FROM jsonb_build_object('version',7,'batchId',b.id::text,'memberId',m.member_id::text,'sourceSlot',m.source_slot,'sealedPlanDigest',b.sealed_plan_digest,'scopeId',b.server_scope_id::text,'scopeRevision',b.scope_revision) THEN
 RAISE EXCEPTION 'Media7 binding requires exact live complete sealed source' USING ERRCODE='23514';END IF;
 SELECT * INTO c FROM whaleu_media.scope_consumptions WHERE actor_id=b.actor_id AND owner_kind='ratings' AND resource_kind=a.resource_kind AND scope_resource_id=b.server_scope_id;
 IF NOT FOUND OR c.transaction_id<>pg_current_xact_id() OR c.resource_id<>NEW.resource_id OR c.scope_revision<>b.scope_revision OR c.content_version<>1
 OR c.attach_evidence->'version' IS DISTINCT FROM '7'::jsonb OR c.attach_evidence->>'batchId' IS DISTINCT FROM b.id::text OR c.attach_evidence->>'sealedPlanDigest' IS DISTINCT FROM b.sealed_plan_digest THEN
 RAISE EXCEPTION 'Media7 binding needs this exact original-owner transaction' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER media7_binding_guard BEFORE INSERT ON whaleu_media.bindings FOR EACH ROW WHEN(NEW.owner_kind='ratings' AND NEW.resource_kind IN ('rating_comment','rating_reply')) EXECUTE FUNCTION whaleu_media.ratings_discussion_binding_guard();
CREATE CONSTRAINT TRIGGER media7_binding_final AFTER INSERT ON whaleu_media.bindings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.owner_kind='ratings' AND NEW.resource_kind IN ('rating_comment','rating_reply')) EXECUTE FUNCTION whaleu_media.ratings_discussion_binding_guard();

CREATE FUNCTION whaleu_media.assert_ratings_discussion_consumed(batch uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE b whaleu_media.ratings_discussion_batches;c whaleu_media.scope_consumptions;kind text;parent uuid;assets jsonb;actual jsonb;target uuid;root uuid;
BEGIN
 SELECT * INTO STRICT b FROM whaleu_media.ratings_discussion_batches WHERE id=batch;
 IF b.state<>'consumed' THEN RETURN;END IF;
 kind:=CASE WHEN b.identity->'target'->>'kind'='reply' THEN 'rating_reply' ELSE 'rating_comment' END;
 parent:=(b.consumed_parent->>'resourceId')::uuid;target:=(b.identity->'target'->>'targetId')::uuid;
 IF kind='rating_reply' THEN
  root:=(b.identity->'target'->>'rootId')::uuid;
  IF parent=root OR b.consumed_parent IS DISTINCT FROM jsonb_build_object('ownerKind','ratings','resourceKind',kind,'targetId',target::text,'rootId',root::text,'resourceId',parent::text,'contentVersion',1) THEN RAISE EXCEPTION 'Media7 parent mismatch' USING ERRCODE='23514';END IF;
 ELSE
  IF b.consumed_parent IS DISTINCT FROM jsonb_build_object('ownerKind','ratings','resourceKind',kind,'targetId',target::text,'resourceId',parent::text,'contentVersion',1) THEN RAISE EXCEPTION 'Media7 parent mismatch' USING ERRCODE='23514';END IF;
 END IF;
 SELECT jsonb_agg(jsonb_build_object('assetId',x->>'assetId','digest',x->>'manifestDigest') ORDER BY (x->>'ordinal')::integer) INTO assets FROM jsonb_array_elements(b.sealed_plan->'orderedMembers') x;
 SELECT jsonb_agg(jsonb_build_object('assetId',a.id::text,'digest',a.manifest_digest) ORDER BY d.ordinal) INTO actual
 FROM whaleu_media.bindings d JOIN whaleu_media.assets a ON a.id=d.asset_id JOIN whaleu_media.ratings_discussion_members m ON m.intent_id=a.intent_id
 WHERE d.owner_kind='ratings' AND d.resource_kind=kind AND d.resource_id=parent AND d.content_version=1 AND d.slot='images'
 AND m.batch_id=b.id AND m.state='bound' AND m.actor_id=b.actor_id;
 SELECT * INTO c FROM whaleu_media.scope_consumptions WHERE actor_id=b.actor_id AND owner_kind='ratings' AND resource_kind=kind AND scope_resource_id=b.server_scope_id;
 IF parent IS NULL OR assets IS DISTINCT FROM actual OR (SELECT count(*) FROM whaleu_media.bindings WHERE owner_kind='ratings' AND resource_kind=kind AND resource_id=parent AND content_version=1)<>jsonb_array_length(assets)
 OR c.resource_id IS DISTINCT FROM parent OR c.scope_revision IS DISTINCT FROM b.scope_revision OR c.content_version IS DISTINCT FROM 1
 OR (c.transaction_id=pg_current_xact_id() AND EXISTS(SELECT 1 FROM whaleu_media.bindings WHERE owner_kind='ratings' AND resource_kind=kind AND resource_id=parent AND detached_at IS NOT NULL))
 OR c.attach_evidence IS DISTINCT FROM jsonb_build_object('version',7,'batchId',b.id::text,'sealedPlanDigest',b.sealed_plan_digest,'parent',b.consumed_parent,'assets',assets) THEN
 RAISE EXCEPTION 'Media7 requires atomic complete ordered consumption' USING ERRCODE='23514';END IF;
END $$;
CREATE FUNCTION whaleu_media.ratings_discussion_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE batch uuid;b whaleu_media.ratings_discussion_batches;actual jsonb;expected_count integer;
BEGIN
 IF TG_TABLE_NAME='ratings_discussion_batches' THEN batch:=NEW.id;
 ELSIF TG_TABLE_NAME='ratings_discussion_members' THEN batch:=NEW.batch_id;
 ELSE batch:=(NEW.attach_evidence->>'batchId')::uuid;END IF;
 SELECT * INTO STRICT b FROM whaleu_media.ratings_discussion_batches WHERE id=batch;
 IF TG_TABLE_NAME IN ('scope_consumptions','bindings') AND b.state<>'consumed' THEN
  RAISE EXCEPTION 'Media7 cannot persist partial scope/binding consumption' USING ERRCODE='23514';END IF;
 IF b.state IN ('sealed','consumed') THEN
  expected_count:=jsonb_array_length(b.sealed_plan->'orderedMembers');
  SELECT jsonb_agg(jsonb_build_object('ordinal',(x.value->>'ordinal')::integer,'memberId',m.member_id::text,'assetId',a.id::text,'manifestDigest',a.manifest_digest) ORDER BY (x.value->>'ordinal')::integer)
   INTO actual FROM jsonb_array_elements(b.sealed_plan->'orderedMembers') x
   JOIN whaleu_media.ratings_discussion_members m ON m.batch_id=b.id AND m.member_id::text=x.value->>'memberId'
    AND m.state=CASE WHEN b.state='consumed' THEN 'bound' ELSE 'live' END
   JOIN whaleu_media.assets a ON a.intent_id=m.intent_id AND a.actor_id=b.actor_id
    AND a.resource_id=b.server_scope_id AND a.scope_revision=b.scope_revision AND a.ordinal=m.source_slot;
  IF expected_count IS NULL OR actual IS DISTINCT FROM b.sealed_plan->'orderedMembers'
   OR (SELECT count(*) FROM whaleu_media.ratings_discussion_members WHERE batch_id=b.id AND state<>'removed')<>expected_count THEN
   RAISE EXCEPTION 'Media7 sealed plan requires every selected immutable member exactly once' USING ERRCODE='23514';END IF;
 END IF;
 PERFORM whaleu_media.assert_ratings_discussion_consumed(batch);RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER media7_batch_complete AFTER INSERT OR UPDATE ON whaleu_media.ratings_discussion_batches DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_media.ratings_discussion_complete();
CREATE CONSTRAINT TRIGGER media7_member_consumption AFTER INSERT OR UPDATE ON whaleu_media.ratings_discussion_members DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_media.ratings_discussion_complete();
CREATE CONSTRAINT TRIGGER media7_scope_complete AFTER INSERT ON whaleu_media.scope_consumptions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.owner_kind='ratings' AND NEW.resource_kind IN ('rating_comment','rating_reply')) EXECUTE FUNCTION whaleu_media.ratings_discussion_complete();
CREATE CONSTRAINT TRIGGER media7_binding_complete AFTER INSERT OR UPDATE ON whaleu_media.bindings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.owner_kind='ratings' AND NEW.resource_kind IN ('rating_comment','rating_reply')) EXECUTE FUNCTION whaleu_media.ratings_discussion_complete();
