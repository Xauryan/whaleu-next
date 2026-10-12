-- Media15 private single-image transport. No provider, retention policy, issuer,
-- automatic publication, background effect or real credentials are installed.
SET LOCAL lock_timeout='5s';
SELECT pg_advisory_xact_lock(hashtextextended('whaleu:named-block-policy:v1',0));
ALTER TABLE whaleu_media.upload_request_fences DROP CONSTRAINT upload_request_fences_protocol_namespace_check;
ALTER TABLE whaleu_media.upload_request_fences ADD CONSTRAINT upload_request_fences_protocol_namespace_check CHECK(protocol_namespace IS NULL OR protocol_namespace IN(8,9,10,11,12,13,14,15));
ALTER TABLE whaleu_media.upload_intents DROP CONSTRAINT media_protocol_identity;
ALTER TABLE whaleu_media.upload_intents ADD CONSTRAINT media_protocol_identity CHECK((protocol_version=1 AND request_hash IS NULL AND declared_sha256 IS NULL) OR(protocol_version IN(2,3,4,5,6,7,8,9,10,11,12,13,14,15) AND request_hash IS NOT NULL AND declared_sha256 IS NOT NULL));
ALTER TABLE whaleu_media.upload_intents DROP CONSTRAINT media_profile_scope;
ALTER TABLE whaleu_media.upload_intents ADD CONSTRAINT media_profile_scope CHECK(
 (protocol_version=5 AND owner_kind='profile' AND resource_kind='avatar' AND audience='profile-public' AND target_kind='edit' AND content_version=1 AND slot='avatar' AND ordinal=0 AND purpose='profile-avatar-image') OR
 (protocol_version<>5 AND owner_kind<>'profile' AND(target_kind<>'edit' OR protocol_version IN(6,8,9,10,11,12,13,14,15)) AND audience<>'profile-public' AND purpose<>'profile-avatar-image'));
ALTER TABLE whaleu_media.assets DROP CONSTRAINT media_profile_asset_scope;
ALTER TABLE whaleu_media.assets ADD CONSTRAINT media_profile_asset_scope CHECK(
 (owner_kind='profile' AND resource_kind='avatar' AND audience='profile-public' AND target_kind='edit' AND content_version=1 AND slot='avatar' AND ordinal=0 AND purpose='profile-avatar-image') OR
 (owner_kind<>'profile' AND(target_kind<>'edit' OR owner_kind IN('ratings','school_configuration','organizations','activities','announcements','verification','errands','messaging')) AND audience<>'profile-public' AND purpose<>'profile-avatar-image'));
ALTER TABLE whaleu_media.upload_intents ADD CONSTRAINT private_message_media_scope CHECK(
 (protocol_version=15 AND owner_kind='messaging' AND resource_kind='private_message_image' AND target_kind='edit' AND content_version=1 AND ordinal=0 AND slot='image' AND audience='conversation-private' AND purpose='private-message-image') OR
 (protocol_version<>15 AND resource_kind<>'private_message_image' AND purpose<>'private-message-image' AND audience<>'conversation-private'));
ALTER TABLE whaleu_media.assets ADD CONSTRAINT private_message_media_asset_scope CHECK(
 (owner_kind='messaging' AND resource_kind='private_message_image' AND target_kind='edit' AND content_version=1 AND ordinal=0 AND slot='image' AND audience='conversation-private' AND purpose='private-message-image') OR
 (resource_kind<>'private_message_image' AND purpose<>'private-message-image' AND audience<>'conversation-private'));
ALTER TABLE whaleu_media.bindings ADD CONSTRAINT private_message_media_binding_scope CHECK(resource_kind<>'private_message_image' OR(owner_kind='messaging' AND content_version=1 AND slot='image' AND ordinal=0));
CREATE TABLE whaleu_media.private_message_scopes(
 id uuid PRIMARY KEY,actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),client_request_id uuid NOT NULL,
 conversation_id uuid NOT NULL REFERENCES whaleu_messaging.conversations(id),message_request_id uuid NOT NULL,
 context_digest whaleu_media.digest NOT NULL,scope_revision whaleu_media.digest NOT NULL,input jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT statement_timestamp(),expires_at timestamptz NOT NULL,
 UNIQUE(actor_id,client_request_id),UNIQUE(actor_id,message_request_id),
 CHECK(isfinite(expires_at) AND expires_at>created_at AND expires_at<=created_at+interval '30 minutes')
);
CREATE TABLE whaleu_media.private_message_cancel_scopes(
 actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),client_request_id uuid NOT NULL,request_hash whaleu_media.digest NOT NULL,
 conversation_id uuid NOT NULL,message_request_id uuid NOT NULL,PRIMARY KEY(actor_id,client_request_id)
);
CREATE TABLE whaleu_media.private_message_appearances(
 message_id uuid PRIMARY KEY REFERENCES whaleu_messaging.messages(id) DEFERRABLE INITIALLY DEFERRED,
 conversation_id uuid NOT NULL REFERENCES whaleu_messaging.conversations(id),actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
 message_request_id uuid NOT NULL,context_digest whaleu_media.digest NOT NULL,
 asset_id uuid NOT NULL UNIQUE REFERENCES whaleu_media.assets(id),manifest_digest whaleu_media.digest NOT NULL,
 binding_id uuid NOT NULL UNIQUE REFERENCES whaleu_media.bindings(id) DEFERRABLE INITIALLY DEFERRED,
 publication_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),UNIQUE(actor_id,message_request_id)
);
CREATE TABLE whaleu_media.private_message_retirements(
 binding_id uuid PRIMARY KEY REFERENCES whaleu_media.bindings(id),message_id uuid NOT NULL UNIQUE REFERENCES whaleu_messaging.messages(id),
 cause text NOT NULL CHECK(cause='recalled'),transaction_id xid8 NOT NULL DEFAULT pg_current_xact_id()
);
DO $$DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['private_message_scopes','private_message_cancel_scopes','private_message_appearances','private_message_retirements'] LOOP
 EXECUTE format('CREATE TRIGGER a0_private_message_policy BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_media.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.content_policy_writer_gate()',t);
 EXECUTE format('CREATE TRIGGER a1_private_message_epoch BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_media.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_media.advance_owner_epoch()',t);
 EXECUTE format('CREATE TRIGGER private_message_retain BEFORE TRUNCATE ON whaleu_media.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_media.immutable_record()',t);
 EXECUTE format('CREATE TRIGGER private_message_immutable BEFORE UPDATE OR DELETE ON whaleu_media.%I FOR EACH ROW EXECUTE FUNCTION whaleu_media.immutable_record()',t);
 END LOOP;
END$$;
CREATE FUNCTION whaleu_media.private_message_request_hash(actor uuid,v jsonb) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT encode(sha256(convert_to('whaleu-private-message-media-prepare:v1'||chr(10)||
 '{"protocol":"private-message-media-v1","actorAccountId":'||to_json(actor::text)::text||
 ',"clientRequestId":'||to_json(v->>'clientRequestId')::text||',"conversationId":'||to_json(v->>'conversationId')::text||
 ',"messageRequestId":'||to_json(v->>'messageRequestId')::text||
 ',"declaration":{"mime":'||to_json(v->'declaration'->>'mime')::text||',"bytes":'||(v->'declaration'->>'bytes')||',"sha256":'||to_json(v->'declaration'->>'sha256')::text||'}}','UTF8')),'hex')
$$;
-- Messaging's additional command-fence table arrives in 0117; PL/pgSQL resolves
-- its relation only when a Media15 operation is actually requested.
CREATE FUNCTION whaleu_media.private_message_scope_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v jsonb:=NEW.input;BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('["whaleu:dm-image-command:v1","'||NEW.actor_id::text||'","'||NEW.message_request_id::text||'"]',0));
 IF NOT coalesce(whaleu_community.rating_scoped_keys(v,ARRAY['protocol','clientRequestId','conversationId','messageRequestId','declaration'])
 AND v->>'protocol'='private-message-media-v1' AND v->>'clientRequestId'=NEW.client_request_id::text AND v->>'conversationId'=NEW.conversation_id::text AND v->>'messageRequestId'=NEW.message_request_id::text
 AND NEW.scope_revision=whaleu_media.private_message_request_hash(NEW.actor_id,v)
 AND whaleu_community.rating_scoped_keys(v->'declaration',ARRAY['mime','bytes','sha256']) AND v->'declaration'->>'mime' IN('image/jpeg','image/png')
 AND whaleu_community.rating_scoped_integer(v->'declaration'->'bytes',1) AND(v->'declaration'->>'bytes')::bigint BETWEEN 1 AND 5242880 AND v->'declaration'->>'sha256' ~ '^[a-f0-9]{64}$'
 AND EXISTS(SELECT 1 FROM whaleu_messaging.conversations c JOIN whaleu_messaging.participants p ON p.conversation_id=c.id WHERE c.id=NEW.conversation_id AND p.account_id=NEW.actor_id AND c.context_digest=NEW.context_digest)
 AND NOT EXISTS(SELECT 1 FROM whaleu_messaging.participants p WHERE p.conversation_id=NEW.conversation_id AND p.blocked_at IS NOT NULL)
 AND NOT EXISTS(SELECT 1 FROM whaleu_messaging.requests r WHERE(r.account_id,r.request_id)=(NEW.actor_id,NEW.message_request_id))
 AND NOT EXISTS(SELECT 1 FROM whaleu_messaging.image_command_fences f WHERE(f.account_id,f.request_id)=(NEW.actor_id,NEW.message_request_id)),false)
 THEN RAISE EXCEPTION 'Private media requires exact current original image command scope' USING ERRCODE='23514';END IF;RETURN NEW;
END$$;
CREATE TRIGGER private_message_scope BEFORE INSERT ON whaleu_media.private_message_scopes FOR EACH ROW EXECUTE FUNCTION whaleu_media.private_message_scope_guard();
CREATE FUNCTION whaleu_media.private_message_intent_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s whaleu_media.private_message_scopes;BEGIN
 SELECT * INTO s FROM whaleu_media.private_message_scopes WHERE id=NEW.resource_id AND actor_id=NEW.actor_id;
 IF s.id IS NULL OR(NEW.client_request_id,NEW.scope_revision,NEW.request_hash,NEW.expires_at) IS DISTINCT FROM(s.client_request_id,s.scope_revision,s.scope_revision,s.expires_at)
 OR NEW.declared_bytes<>(s.input->'declaration'->>'bytes')::bigint OR NEW.declared_mime<>s.input->'declaration'->>'mime' OR NEW.declared_sha256<>s.input->'declaration'->>'sha256'
 THEN RAISE EXCEPTION 'Private media intent must match exact immutable scope' USING ERRCODE='23514';END IF;RETURN NEW;
END$$;
CREATE TRIGGER private_message_intent BEFORE INSERT ON whaleu_media.upload_intents FOR EACH ROW WHEN(NEW.protocol_version=15) EXECUTE FUNCTION whaleu_media.private_message_intent_guard();
CREATE FUNCTION whaleu_media.private_message_namespace_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE f whaleu_media.upload_request_fences;i whaleu_media.upload_intents;actor uuid:=NEW.actor_id;request uuid;BEGIN
 IF TG_TABLE_NAME='ratings_discussion_batch_request_fences' THEN request:=NEW.batch_request_id;ELSE request:=NEW.client_request_id;END IF;
 SELECT * INTO f FROM whaleu_media.upload_request_fences WHERE actor_id=actor AND client_request_id=request;
 IF f.protocol_namespace IS DISTINCT FROM 15 THEN
 IF TG_TABLE_NAME='upload_intents' THEN IF NEW.protocol_version=15 THEN RAISE EXCEPTION 'Private media requires Media15 receipt' USING ERRCODE='23514';END IF;END IF;RETURN NULL;END IF;
 IF EXISTS(SELECT 1 FROM whaleu_media.profile_request_markers WHERE actor_id=actor AND client_request_id=request)
 OR EXISTS(SELECT 1 FROM whaleu_media.ratings_request_markers WHERE actor_id=actor AND client_request_id=request)
 OR EXISTS(SELECT 1 FROM whaleu_media.ratings_discussion_request_markers WHERE actor_id=actor AND client_request_id=request)
 OR EXISTS(SELECT 1 FROM whaleu_media.category_icon_request_markers WHERE actor_id=actor AND client_request_id=request)
 OR EXISTS(SELECT 1 FROM whaleu_media.ratings_discussion_batch_request_fences WHERE actor_id=actor AND batch_request_id=request)
 THEN RAISE EXCEPTION 'Private media receipt namespace is exclusive' USING ERRCODE='23514';END IF;
 IF f.intent_id IS NOT NULL THEN SELECT * INTO STRICT i FROM whaleu_media.upload_intents WHERE id=f.intent_id;
 IF i.protocol_version<>15 OR(i.actor_id,i.client_request_id,i.request_hash) IS DISTINCT FROM(actor,request,f.request_hash) THEN RAISE EXCEPTION 'Private media receipt mismatch' USING ERRCODE='23514';END IF;
 ELSE IF NOT EXISTS(SELECT 1 FROM whaleu_media.private_message_cancel_scopes s JOIN whaleu_messaging.image_command_fences command ON(command.account_id,command.request_id,command.conversation_id)=(s.actor_id,s.message_request_id,s.conversation_id) WHERE(s.actor_id,s.client_request_id,s.request_hash)=(actor,request,f.request_hash)) THEN RAISE EXCEPTION 'Private media cancellation receipt requires original command closure' USING ERRCODE='23514';END IF;END IF;
 IF TG_TABLE_NAME='upload_intents' THEN IF NEW.protocol_version<>15 OR f.intent_id IS DISTINCT FROM NEW.id THEN RAISE EXCEPTION 'Private media intent mismatch' USING ERRCODE='23514';END IF;END IF;RETURN NULL;
END$$;
DO $$DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['upload_intents','upload_request_fences','profile_request_markers','ratings_request_markers','ratings_discussion_request_markers','category_icon_request_markers','ratings_discussion_batch_request_fences'] LOOP
 EXECUTE format('CREATE CONSTRAINT TRIGGER private_message_namespace AFTER INSERT OR UPDATE ON whaleu_media.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_media.private_message_namespace_guard()',t);END LOOP;
END$$;
DROP TRIGGER media_binding_guard ON whaleu_media.bindings;
CREATE TRIGGER media_binding_guard BEFORE INSERT ON whaleu_media.bindings FOR EACH ROW WHEN(NEW.owner_kind NOT IN('verification','announcements','activities','organizations','school_configuration') AND NOT(NEW.owner_kind='ratings' AND NEW.resource_kind IN('rating_comment','rating_reply','category_icon')) AND NOT(NEW.owner_kind='errands' AND NEW.resource_kind='errand_image') AND NOT(NEW.owner_kind='messaging' AND NEW.resource_kind='private_message_image')) EXECUTE FUNCTION whaleu_media.binding_guard();
DROP TRIGGER media_scope_consumption_complete ON whaleu_media.scope_consumptions;
CREATE CONSTRAINT TRIGGER media_scope_consumption_complete AFTER INSERT ON whaleu_media.scope_consumptions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.owner_kind NOT IN('verification','announcements','activities','organizations','school_configuration') AND NOT(NEW.owner_kind='ratings' AND NEW.resource_kind IN('rating_comment','rating_reply','category_icon')) AND NOT(NEW.owner_kind='errands' AND NEW.resource_kind='errand_image') AND NOT(NEW.owner_kind='messaging' AND NEW.resource_kind='private_message_image')) EXECUTE FUNCTION whaleu_media.scope_consumption_complete();
CREATE FUNCTION whaleu_media.private_message_binding_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a whaleu_media.assets;i whaleu_media.upload_intents;s whaleu_media.private_message_scopes;c whaleu_media.scope_consumptions;BEGIN
 SELECT * INTO STRICT a FROM whaleu_media.assets WHERE id=NEW.asset_id;SELECT * INTO STRICT i FROM whaleu_media.upload_intents WHERE id=a.intent_id;
 SELECT * INTO s FROM whaleu_media.private_message_scopes WHERE id=a.resource_id AND actor_id=a.actor_id;
 SELECT * INTO c FROM whaleu_media.scope_consumptions WHERE actor_id=a.actor_id AND owner_kind='messaging' AND resource_kind='private_message_image' AND scope_resource_id=a.resource_id;
 IF i.protocol_version<>15 OR i.state<>'ready' OR s.id IS NULL OR least(s.expires_at,a.created_at+interval '24 hours')<=clock_timestamp() OR NEW.detached_at IS NOT NULL
 OR(NEW.owner_kind,NEW.resource_kind,NEW.content_version,NEW.slot,NEW.ordinal,NEW.manifest_digest) IS DISTINCT FROM(a.owner_kind,a.resource_kind,a.content_version,a.slot,a.ordinal,a.manifest_digest)
 OR NEW.attach_evidence IS DISTINCT FROM jsonb_build_object('version',15,'scopeId',a.resource_id::text,'scopeRevision',a.scope_revision)
 OR c.transaction_id IS DISTINCT FROM pg_current_xact_id() OR c.resource_id IS DISTINCT FROM NEW.resource_id OR c.scope_revision IS DISTINCT FROM a.scope_revision OR c.content_version IS DISTINCT FROM 1::bigint
 OR c.attach_evidence IS DISTINCT FROM jsonb_build_object('version',15,'assets',jsonb_build_array(jsonb_build_object('assetId',a.id::text,'digest',a.manifest_digest)))
 OR NOT EXISTS(SELECT 1 FROM whaleu_media.asset_safety_heads h JOIN whaleu_media.asset_safety_events e ON(e.asset_id,e.revision,e.id)=(h.asset_id,h.revision,h.event_id) WHERE h.asset_id=a.id AND e.state='allow' AND e.manifest_digest=a.manifest_digest AND e.policy_revision=a.policy_revision AND e.effective_at<=clock_timestamp() AND e.valid_until>clock_timestamp())
 THEN RAISE EXCEPTION 'Private image requires exact current Media15 acceptance' USING ERRCODE='23514';END IF;
 IF TG_WHEN='AFTER' AND NOT EXISTS(SELECT 1 FROM whaleu_media.private_message_appearances p JOIN whaleu_messaging.messages msg ON msg.id=p.message_id
 WHERE p.message_id=NEW.resource_id AND p.binding_id=NEW.id AND p.asset_id=a.id AND p.manifest_digest=a.manifest_digest
 AND(p.actor_id,p.conversation_id,p.message_request_id,p.context_digest)=(s.actor_id,s.conversation_id,s.message_request_id,s.context_digest)
 AND(msg.sender_id,msg.conversation_id,msg.request_id)=(p.actor_id,p.conversation_id,p.message_request_id) AND msg.recalled_at IS NULL AND p.publication_transaction=pg_current_xact_id())
 THEN RAISE EXCEPTION 'Private image binding requires atomic exact message publication' USING ERRCODE='23514';END IF;RETURN NEW;
END$$;
CREATE TRIGGER private_message_binding BEFORE INSERT ON whaleu_media.bindings FOR EACH ROW WHEN(NEW.resource_kind='private_message_image') EXECUTE FUNCTION whaleu_media.private_message_binding_guard();
CREATE CONSTRAINT TRIGGER private_message_binding_final AFTER INSERT ON whaleu_media.bindings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.resource_kind='private_message_image') EXECUTE FUNCTION whaleu_media.private_message_binding_guard();
CREATE FUNCTION whaleu_media.private_message_appearance_guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF NEW.publication_transaction<>pg_current_xact_id() OR NOT EXISTS(SELECT 1 FROM whaleu_media.bindings b JOIN whaleu_media.assets a ON a.id=b.asset_id JOIN whaleu_media.private_message_scopes s ON s.id=a.resource_id JOIN whaleu_messaging.messages msg ON msg.id=NEW.message_id
 WHERE b.id=NEW.binding_id AND b.resource_id=NEW.message_id AND b.asset_id=NEW.asset_id AND b.manifest_digest=NEW.manifest_digest AND b.resource_kind='private_message_image' AND b.owner_kind='messaging' AND b.detached_at IS NULL
 AND(s.actor_id,s.conversation_id,s.message_request_id,s.context_digest)=(NEW.actor_id,NEW.conversation_id,NEW.message_request_id,NEW.context_digest)
 AND(msg.sender_id,msg.conversation_id,msg.request_id)=(NEW.actor_id,NEW.conversation_id,NEW.message_request_id))
 THEN RAISE EXCEPTION 'Private image appearance requires exact immutable owner and binding' USING ERRCODE='23514';END IF;RETURN NULL;
END$$;
CREATE CONSTRAINT TRIGGER private_message_appearance_final AFTER INSERT ON whaleu_media.private_message_appearances DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_media.private_message_appearance_guard();
CREATE FUNCTION whaleu_media.private_message_consumption_guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF NEW.transaction_id<>pg_current_xact_id() OR NOT EXISTS(SELECT 1 FROM whaleu_media.bindings b JOIN whaleu_media.assets a ON a.id=b.asset_id WHERE b.owner_kind='messaging' AND b.resource_kind='private_message_image' AND b.resource_id=NEW.resource_id AND b.detached_at IS NULL AND a.resource_id=NEW.scope_resource_id AND a.actor_id=NEW.actor_id AND a.scope_revision=NEW.scope_revision)
 THEN RAISE EXCEPTION 'Private media consumption requires atomic exact binding' USING ERRCODE='23514';END IF;RETURN NULL;
END$$;
CREATE CONSTRAINT TRIGGER private_message_consumption_final AFTER INSERT ON whaleu_media.scope_consumptions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.resource_kind='private_message_image') EXECUTE FUNCTION whaleu_media.private_message_consumption_guard();
CREATE FUNCTION whaleu_media.private_message_detach_guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF OLD.detached_at IS NULL AND NEW.detached_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM whaleu_media.private_message_retirements r JOIN whaleu_messaging.messages msg ON msg.id=r.message_id WHERE r.binding_id=NEW.id AND r.message_id=NEW.resource_id AND r.transaction_id=pg_current_xact_id() AND msg.recalled_at IS NOT NULL AND NEW.detach_reason='private-message-recalled')
 THEN RAISE EXCEPTION 'Private image detach requires atomic recall' USING ERRCODE='23514';END IF;RETURN NEW;
END$$;
CREATE TRIGGER private_message_detach BEFORE UPDATE ON whaleu_media.bindings FOR EACH ROW WHEN(NEW.resource_kind='private_message_image') EXECUTE FUNCTION whaleu_media.private_message_detach_guard();
CREATE FUNCTION whaleu_media.private_message_retirement_guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF NEW.transaction_id<>pg_current_xact_id() OR NOT EXISTS(SELECT 1 FROM whaleu_media.private_message_appearances p JOIN whaleu_media.bindings b ON b.id=p.binding_id JOIN whaleu_messaging.messages msg ON msg.id=p.message_id JOIN whaleu_media.assets a ON a.id=p.asset_id JOIN whaleu_media.upload_intents i ON i.id=a.intent_id WHERE p.message_id=NEW.message_id AND p.binding_id=NEW.binding_id AND b.resource_id=p.message_id AND b.detached_at IS NOT NULL AND b.detach_reason='private-message-recalled' AND msg.recalled_at IS NOT NULL AND i.state='cleanup_pending')
 THEN RAISE EXCEPTION 'Private retirement requires recall, exact detach and durable cleanup' USING ERRCODE='23514';END IF;RETURN NULL;
END$$;
CREATE CONSTRAINT TRIGGER private_message_retirement_final AFTER INSERT ON whaleu_media.private_message_retirements DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_media.private_message_retirement_guard();
-- Delivery bookkeeping is not read authority. A failed final proof/open/error or
-- expired timer never closes this record; only actual provider/stream quiet can.
CREATE TABLE whaleu_media.private_message_delivery_holds(
 id uuid PRIMARY KEY,binding_id uuid NOT NULL REFERENCES whaleu_media.bindings(id),account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),session_id uuid NOT NULL REFERENCES whaleu_identity.sessions(id),
 plan_digest whaleu_media.digest NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),closed_at timestamptz,
 CHECK(isfinite(created_at) AND(closed_at IS NULL OR(isfinite(closed_at) AND closed_at>=created_at)))
);
CREATE INDEX private_message_delivery_open ON whaleu_media.private_message_delivery_holds(binding_id) WHERE closed_at IS NULL;
CREATE FUNCTION whaleu_media.private_message_delivery_hold_guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF TG_OP='INSERT' THEN
 IF NEW.closed_at IS NOT NULL OR NOT EXISTS(SELECT 1 FROM whaleu_media.private_message_appearances p JOIN whaleu_media.bindings b ON b.id=p.binding_id JOIN whaleu_messaging.messages msg ON msg.id=p.message_id JOIN whaleu_messaging.participants member ON member.conversation_id=p.conversation_id JOIN whaleu_identity.sessions session ON session.account_id=member.account_id
 WHERE p.binding_id=NEW.binding_id AND member.account_id=NEW.account_id AND session.id=NEW.session_id AND b.detached_at IS NULL AND msg.recalled_at IS NULL)
 THEN RAISE EXCEPTION 'Private delivery hold requires exact active participant binding' USING ERRCODE='23514';END IF;
 ELSE IF OLD.closed_at IS NOT NULL OR NEW.closed_at IS NULL OR(to_jsonb(NEW)-'closed_at') IS DISTINCT FROM(to_jsonb(OLD)-'closed_at') THEN RAISE EXCEPTION 'Private delivery closure is one way' USING ERRCODE='23514';END IF;END IF;RETURN NEW;
END$$;
CREATE TRIGGER private_message_delivery_hold_guard BEFORE INSERT OR UPDATE ON whaleu_media.private_message_delivery_holds FOR EACH ROW EXECUTE FUNCTION whaleu_media.private_message_delivery_hold_guard();
CREATE TRIGGER private_message_delivery_retain BEFORE DELETE ON whaleu_media.private_message_delivery_holds FOR EACH ROW EXECUTE FUNCTION whaleu_media.immutable_record();
CREATE TRIGGER private_message_delivery_retain_all BEFORE TRUNCATE ON whaleu_media.private_message_delivery_holds FOR EACH STATEMENT EXECUTE FUNCTION whaleu_media.immutable_record();
-- Empty until a separately approved real retention policy and exact per-intent
-- authorization are configured. Time passing alone cannot authorize deletion.
CREATE TABLE whaleu_media.private_message_retention_policies(
 id uuid PRIMARY KEY,revision whaleu_media.digest NOT NULL UNIQUE,policy_reference text NOT NULL CHECK(length(btrim(policy_reference)) BETWEEN 1 AND 1000),
 active boolean NOT NULL,valid_from timestamptz NOT NULL,valid_until timestamptz NOT NULL,
 CHECK(isfinite(valid_from) AND isfinite(valid_until) AND valid_until>valid_from)
);
CREATE TABLE whaleu_media.private_message_cleanup_authorizations(
 intent_id uuid PRIMARY KEY REFERENCES whaleu_media.upload_intents(id),policy_id uuid NOT NULL REFERENCES whaleu_media.private_message_retention_policies(id),
 policy_revision whaleu_media.digest NOT NULL,not_before timestamptz NOT NULL,valid_until timestamptz NOT NULL,
 CHECK(isfinite(not_before) AND isfinite(valid_until) AND valid_until>not_before)
);
CREATE TRIGGER private_message_cleanup_authorization_immutable BEFORE UPDATE OR DELETE ON whaleu_media.private_message_cleanup_authorizations FOR EACH ROW EXECUTE FUNCTION whaleu_media.immutable_record();
CREATE TRIGGER private_message_cleanup_authorization_retain BEFORE TRUNCATE ON whaleu_media.private_message_cleanup_authorizations FOR EACH STATEMENT EXECUTE FUNCTION whaleu_media.immutable_record();
CREATE FUNCTION whaleu_media.private_message_cleanup_allowed(iid uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT coalesce(EXISTS(SELECT 1 FROM whaleu_media.upload_intents i JOIN whaleu_media.private_message_cleanup_authorizations auth ON auth.intent_id=i.id JOIN whaleu_media.private_message_retention_policies policy ON policy.id=auth.policy_id AND policy.revision=auth.policy_revision
 WHERE i.id=iid AND i.protocol_version=15 AND i.state IN('cancelled','expired','rejected','cleanup_pending','deleting','deleted')
 AND policy.active AND policy.valid_from<=clock_timestamp() AND policy.valid_until>clock_timestamp() AND auth.not_before<=clock_timestamp() AND auth.valid_until>clock_timestamp()
 AND NOT EXISTS(SELECT 1 FROM whaleu_media.assets a JOIN whaleu_media.bindings b ON b.asset_id=a.id WHERE a.intent_id=i.id AND b.detached_at IS NULL)
 AND NOT EXISTS(SELECT 1 FROM whaleu_media.assets a JOIN whaleu_media.bindings b ON b.asset_id=a.id JOIN whaleu_media.private_message_delivery_holds h ON h.binding_id=b.id WHERE a.intent_id=i.id AND h.closed_at IS NULL)
 AND NOT EXISTS(SELECT 1 FROM whaleu_media.jobs j WHERE j.intent_id=i.id AND((j.status<>'succeeded' AND NOT(j.status='cancelled' AND j.attempt=0)) OR j.lease_token IS NOT NULL OR j.lease_until IS NOT NULL))
 AND NOT EXISTS(SELECT 1 FROM whaleu_media.upload_ingress g WHERE g.intent_id=i.id AND g.writer_state NOT IN('observed','retired'))
 AND NOT EXISTS(SELECT 1 FROM whaleu_media.upload_ingress_writers w JOIN whaleu_media.upload_ingress g ON g.object_attempt_id=w.object_attempt_id WHERE g.intent_id=i.id AND w.state<>'retired')
 AND NOT EXISTS(SELECT 1 FROM whaleu_media.object_attempts o WHERE o.intent_id=i.id AND o.state NOT IN('sealed','deleted'))
 AND NOT EXISTS(SELECT 1 FROM whaleu_media.derived_object_attempts d WHERE d.intent_id=i.id AND d.state NOT IN('written','deleted'))),false)
$$;
CREATE FUNCTION whaleu_media.private_message_cleanup_claim_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE iid uuid;protocol integer;BEGIN
 IF NEW.state<>'deleting' THEN RETURN NEW;END IF;
 SELECT coalesce((SELECT intent_id FROM whaleu_media.object_attempts WHERE id=NEW.object_attempt_id),
 (SELECT intent_id FROM whaleu_media.assets WHERE id=NEW.asset_id),
 (SELECT intent_id FROM whaleu_media.derived_object_attempts WHERE id=NEW.derived_attempt_id),
 (SELECT a.intent_id FROM whaleu_media.upload_ingress_writers w JOIN whaleu_media.object_attempts a ON a.id=w.object_attempt_id WHERE w.writer_token=NEW.ingress_writer_id)) INTO iid;
 SELECT protocol_version INTO protocol FROM whaleu_media.upload_intents WHERE id=iid;
 IF protocol=15 THEN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Private media cleanup requires read committed' USING ERRCODE='23514';END IF;
 LOCK TABLE whaleu_media.private_message_delivery_holds,whaleu_media.private_message_cleanup_authorizations,whaleu_media.private_message_retention_policies IN SHARE MODE NOWAIT;
 IF NOT whaleu_media.private_message_cleanup_allowed(iid) THEN RAISE EXCEPTION 'Private media physical cleanup requires real retention authority and durable quiet' USING ERRCODE='23514';END IF;
 END IF;RETURN NEW;
END$$;
CREATE TRIGGER private_message_cleanup_claim BEFORE INSERT OR UPDATE ON whaleu_media.cleanup_obligations FOR EACH ROW EXECUTE FUNCTION whaleu_media.private_message_cleanup_claim_guard();
-- Before-prepare cancellation is valid only together with original-command
-- fencing. This remains metadata closure, never a message/binary read grant.
CREATE FUNCTION whaleu_media.private_message_cancel_guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF NOT EXISTS(SELECT 1 FROM whaleu_media.upload_request_fences f WHERE(f.actor_id,f.client_request_id,f.request_hash)=(NEW.actor_id,NEW.client_request_id,NEW.request_hash) AND f.protocol_namespace=15 AND f.intent_id IS NULL AND f.state='cancelled_before_prepare')
 OR NOT EXISTS(SELECT 1 FROM whaleu_messaging.image_command_fences f WHERE(f.account_id,f.request_id,f.conversation_id)=(NEW.actor_id,NEW.message_request_id,NEW.conversation_id))
 THEN RAISE EXCEPTION 'Private media cancellation requires exact original image command fence' USING ERRCODE='23514';END IF;RETURN NULL;
END$$;
CREATE CONSTRAINT TRIGGER private_message_cancel_final AFTER INSERT ON whaleu_media.private_message_cancel_scopes DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_media.private_message_cancel_guard();
