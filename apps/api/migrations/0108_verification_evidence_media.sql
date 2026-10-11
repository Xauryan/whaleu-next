-- Typed private Verification evidence Media13. No production storage or retention policy is enabled.
SET LOCAL lock_timeout='5s';
SELECT pg_advisory_xact_lock(hashtextextended('whaleu:named-block-policy:v1',0));
ALTER DOMAIN whaleu_media.audience DROP CONSTRAINT audience_check;
ALTER DOMAIN whaleu_media.audience ADD CONSTRAINT audience_check CHECK(VALUE IN ('content-gated','participant-private','conversation-private','profile-public','school-config-gated','organization-gated','activity-gated','announcement-gated','verification-private'));
ALTER TABLE whaleu_media.upload_request_fences DROP CONSTRAINT upload_request_fences_protocol_namespace_check;
ALTER TABLE whaleu_media.upload_request_fences ADD CONSTRAINT upload_request_fences_protocol_namespace_check CHECK(protocol_namespace IS NULL OR protocol_namespace IN (8,9,10,11,12,13));
ALTER TABLE whaleu_media.upload_intents DROP CONSTRAINT media_protocol_identity;
ALTER TABLE whaleu_media.upload_intents ADD CONSTRAINT media_protocol_identity CHECK(
 (protocol_version=1 AND request_hash IS NULL AND declared_sha256 IS NULL) OR
 (protocol_version IN (2,3,4,5,6,7,8,9,10,11,12,13) AND request_hash IS NOT NULL AND declared_sha256 IS NOT NULL));
ALTER TABLE whaleu_media.upload_intents DROP CONSTRAINT media_profile_scope;
ALTER TABLE whaleu_media.upload_intents ADD CONSTRAINT media_profile_scope CHECK(
 (protocol_version=5 AND owner_kind='profile' AND resource_kind='avatar' AND audience='profile-public'
 AND target_kind='edit' AND content_version=1 AND slot='avatar' AND ordinal=0 AND purpose='profile-avatar-image') OR
 (protocol_version<>5 AND owner_kind<>'profile' AND (target_kind<>'edit' OR protocol_version IN (6,8,9,10,11,12,13)) AND audience<>'profile-public' AND purpose<>'profile-avatar-image'));
ALTER TABLE whaleu_media.assets DROP CONSTRAINT media_profile_asset_scope;
ALTER TABLE whaleu_media.assets ADD CONSTRAINT media_profile_asset_scope CHECK(
 (owner_kind='profile' AND resource_kind='avatar' AND audience='profile-public' AND target_kind='edit'
 AND content_version=1 AND slot='avatar' AND ordinal=0 AND purpose='profile-avatar-image') OR
 (owner_kind<>'profile' AND (target_kind<>'edit' OR owner_kind IN ('ratings','school_configuration','organizations','activities','announcements','verification')) AND audience<>'profile-public' AND purpose<>'profile-avatar-image'));
ALTER TABLE whaleu_media.upload_intents ADD CONSTRAINT media_verification_evidence_scope CHECK(
 (protocol_version=13 AND owner_kind='verification' AND resource_kind='student_evidence' AND audience='verification-private' AND purpose='verification-evidence-image' AND target_kind='edit' AND content_version=1 AND slot='evidence' AND ordinal=0) OR
 (protocol_version<>13 AND owner_kind<>'verification' AND resource_kind<>'student_evidence' AND audience<>'verification-private' AND purpose<>'verification-evidence-image'));
ALTER TABLE whaleu_media.assets ADD CONSTRAINT media_verification_evidence_asset_scope CHECK(
 (owner_kind='verification' AND resource_kind='student_evidence' AND audience='verification-private' AND purpose='verification-evidence-image' AND target_kind='edit' AND content_version=1 AND slot='evidence' AND ordinal=0) OR
 (owner_kind<>'verification' AND resource_kind<>'student_evidence' AND audience<>'verification-private' AND purpose<>'verification-evidence-image'));
ALTER TABLE whaleu_media.bindings ADD CONSTRAINT media_verification_evidence_binding_scope CHECK(
 (owner_kind='verification' AND resource_kind='student_evidence' AND content_version=1 AND slot='evidence' AND ordinal=0) OR (owner_kind<>'verification' AND resource_kind<>'student_evidence'));
CREATE TABLE whaleu_media.verification_evidence_scopes(
 id uuid PRIMARY KEY,actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),client_request_id uuid NOT NULL,
 application_id uuid NOT NULL REFERENCES whaleu_verification.student_applications(id),revision bigint NOT NULL CHECK(revision>0 AND revision<9007199254740991),
 scope_revision whaleu_media.digest NOT NULL,input jsonb NOT NULL,authority_version text NOT NULL CHECK(length(authority_version) BETWEEN 1 AND 200),
 created_at timestamptz NOT NULL DEFAULT statement_timestamp(),expires_at timestamptz NOT NULL DEFAULT statement_timestamp()+interval '30 minutes',
 evidence_expires_at timestamptz NOT NULL,evidence_policy_ref text NOT NULL CHECK(evidence_policy_ref ~ '^[A-Za-z0-9._:-]{1,200}$'),cleanup_enabled boolean NOT NULL,
 UNIQUE(actor_id,client_request_id),CHECK(expires_at>created_at AND expires_at<=created_at+interval '30 minutes'),
 CHECK(evidence_expires_at>created_at AND evidence_expires_at<=created_at+interval '365 days')
);
CREATE TABLE whaleu_media.verification_evidence_bindings(
 binding_id uuid PRIMARY KEY REFERENCES whaleu_media.bindings(id) DEFERRABLE INITIALLY DEFERRED,
 application_id uuid NOT NULL UNIQUE REFERENCES whaleu_verification.student_applications(id),revision bigint NOT NULL CHECK(revision>0),
 actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),asset_id uuid NOT NULL UNIQUE REFERENCES whaleu_media.assets(id),manifest_digest whaleu_media.digest NOT NULL,
 evidence_expires_at timestamptz NOT NULL,evidence_policy_ref text NOT NULL,publication_transaction xid8 NOT NULL DEFAULT pg_current_xact_id()
);
CREATE TABLE whaleu_media.verification_evidence_retirements(
 binding_id uuid PRIMARY KEY REFERENCES whaleu_media.bindings(id),application_id uuid NOT NULL REFERENCES whaleu_verification.student_applications(id),
 transaction_id xid8 NOT NULL DEFAULT pg_current_xact_id()
);
DO $$DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['verification_evidence_scopes','verification_evidence_bindings','verification_evidence_retirements'] LOOP
 EXECUTE format('CREATE TRIGGER a0_verification_evidence_policy BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_media.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.content_policy_writer_gate()',t);
 EXECUTE format('CREATE TRIGGER a1_verification_evidence_epoch BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_media.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_media.advance_owner_epoch()',t);
 EXECUTE format('CREATE TRIGGER verification_evidence_retain BEFORE TRUNCATE ON whaleu_media.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_media.immutable_record()',t);
 EXECUTE format('CREATE TRIGGER verification_evidence_immutable BEFORE UPDATE OR DELETE ON whaleu_media.%I FOR EACH ROW EXECUTE FUNCTION whaleu_media.immutable_record()',t);
 END LOOP;
END$$;
CREATE FUNCTION whaleu_media.verification_evidence_request_hash(actor uuid,v jsonb) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT encode(sha256(convert_to('whaleu-verification-evidence-media-prepare:v1'||chr(10)||
 '{"protocol":"verification-evidence-media-v1","actorAccountId":'||to_json(actor::text)::text||
 ',"clientRequestId":'||to_json(v->>'clientRequestId')::text||',"applicationId":'||to_json(v->>'applicationId')::text||',"revision":'||(v->>'revision')||
 ',"declaration":{"mime":'||to_json(v->'declaration'->>'mime')::text||',"bytes":'||(v->'declaration'->>'bytes')||',"sha256":'||to_json(v->'declaration'->>'sha256')::text||'}}','UTF8')),'hex')
$$;
CREATE FUNCTION whaleu_media.verification_evidence_scope_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v jsonb;BEGIN v:=NEW.input;
 IF NOT coalesce(whaleu_community.rating_scoped_keys(v,ARRAY['protocol','clientRequestId','applicationId','revision','declaration'])
 AND v->>'protocol'='verification-evidence-media-v1' AND v->>'clientRequestId'=NEW.client_request_id::text AND v->>'applicationId'=NEW.application_id::text
 AND jsonb_typeof(v->'revision')='number' AND v->>'revision' ~ '^[1-9][0-9]*$' AND (v->>'revision')::bigint=NEW.revision
 AND NEW.scope_revision=whaleu_media.verification_evidence_request_hash(NEW.actor_id,v)
 AND whaleu_community.rating_scoped_keys(v->'declaration',ARRAY['mime','bytes','sha256']) AND v->'declaration'->>'mime' IN ('image/jpeg','image/png')
 AND whaleu_community.rating_scoped_integer(v->'declaration'->'bytes',1) AND (v->'declaration'->>'bytes')::bigint BETWEEN 1 AND 5242880 AND v->'declaration'->>'sha256' ~ '^[a-f0-9]{64}$'
 AND EXISTS(SELECT 1 FROM whaleu_verification.student_applications a WHERE a.id=NEW.application_id AND a.account_id=NEW.actor_id AND a.revision=NEW.revision AND a.state='draft'),false)
 THEN RAISE EXCEPTION 'Verification evidence requires exact current private draft' USING ERRCODE='23514';END IF;RETURN NEW;
END$$;
CREATE TRIGGER verification_evidence_scope BEFORE INSERT ON whaleu_media.verification_evidence_scopes FOR EACH ROW EXECUTE FUNCTION whaleu_media.verification_evidence_scope_guard();
-- Protocol13 must not enter historical public/general-owner binding guards.
DROP TRIGGER media_binding_guard ON whaleu_media.bindings;
CREATE TRIGGER media_binding_guard BEFORE INSERT ON whaleu_media.bindings FOR EACH ROW WHEN(NEW.owner_kind NOT IN ('verification','announcements','activities','organizations','school_configuration') AND NOT(NEW.owner_kind='ratings' AND NEW.resource_kind IN ('rating_comment','rating_reply','category_icon'))) EXECUTE FUNCTION whaleu_media.binding_guard();
DROP TRIGGER media_scope_consumption_complete ON whaleu_media.scope_consumptions;
CREATE CONSTRAINT TRIGGER media_scope_consumption_complete AFTER INSERT ON whaleu_media.scope_consumptions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.owner_kind NOT IN ('verification','announcements','activities','organizations','school_configuration') AND NOT(NEW.owner_kind='ratings' AND NEW.resource_kind IN ('rating_comment','rating_reply','category_icon'))) EXECUTE FUNCTION whaleu_media.scope_consumption_complete();
CREATE FUNCTION whaleu_media.verification_evidence_namespace_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE f whaleu_media.upload_request_fences;i whaleu_media.upload_intents;actor uuid;request uuid;BEGIN
 actor:=NEW.actor_id;
 IF TG_TABLE_NAME='ratings_discussion_batch_request_fences' THEN request:=NEW.batch_request_id;ELSE request:=NEW.client_request_id;END IF;
 SELECT * INTO f FROM whaleu_media.upload_request_fences WHERE actor_id=actor AND client_request_id=request;
 IF f.protocol_namespace IS DISTINCT FROM 13 THEN
  IF TG_TABLE_NAME='upload_intents' THEN
   IF NEW.protocol_version=13 THEN RAISE EXCEPTION 'Verification evidence requires Media13 receipt' USING ERRCODE='23514';END IF;
  END IF;RETURN NULL;
 END IF;
 IF EXISTS(SELECT 1 FROM whaleu_media.profile_request_markers WHERE actor_id=actor AND client_request_id=request)
 OR EXISTS(SELECT 1 FROM whaleu_media.ratings_request_markers WHERE actor_id=actor AND client_request_id=request)
 OR EXISTS(SELECT 1 FROM whaleu_media.ratings_discussion_request_markers WHERE actor_id=actor AND client_request_id=request)
 OR EXISTS(SELECT 1 FROM whaleu_media.category_icon_request_markers WHERE actor_id=actor AND client_request_id=request)
 OR EXISTS(SELECT 1 FROM whaleu_media.ratings_discussion_batch_request_fences WHERE actor_id=actor AND batch_request_id=request)
 THEN RAISE EXCEPTION 'Verification evidence request namespace is exclusive' USING ERRCODE='23514';END IF;
 IF f.intent_id IS NOT NULL THEN
 SELECT * INTO STRICT i FROM whaleu_media.upload_intents WHERE id=f.intent_id;
 IF i.protocol_version<>13 OR (i.actor_id,i.client_request_id,i.request_hash) IS DISTINCT FROM (actor,request,f.request_hash)
 THEN RAISE EXCEPTION 'Verification evidence exact receipt mismatch' USING ERRCODE='23514';END IF;END IF;
 IF TG_TABLE_NAME='upload_intents' THEN
 IF NEW.protocol_version<>13 OR f.intent_id IS DISTINCT FROM NEW.id THEN RAISE EXCEPTION 'Verification evidence intent mismatch' USING ERRCODE='23514';END IF;END IF;
 RETURN NULL;
END$$;
DO $$DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['upload_intents','upload_request_fences','profile_request_markers','ratings_request_markers','ratings_discussion_request_markers','category_icon_request_markers','ratings_discussion_batch_request_fences'] LOOP
 EXECUTE format('CREATE CONSTRAINT TRIGGER verification_evidence_namespace AFTER INSERT OR UPDATE ON whaleu_media.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_media.verification_evidence_namespace_guard()',t);
 END LOOP;
END$$;
CREATE FUNCTION whaleu_media.verification_evidence_intent_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s whaleu_media.verification_evidence_scopes;BEGIN
 SELECT * INTO s FROM whaleu_media.verification_evidence_scopes WHERE id=NEW.resource_id AND actor_id=NEW.actor_id;
 IF s.id IS NULL OR (NEW.client_request_id,NEW.scope_revision,NEW.request_hash,NEW.expires_at) IS DISTINCT FROM (s.client_request_id,s.scope_revision,s.scope_revision,s.expires_at)
 OR NEW.declared_bytes<>(s.input->'declaration'->>'bytes')::bigint OR NEW.declared_mime<>s.input->'declaration'->>'mime' OR NEW.declared_sha256<>s.input->'declaration'->>'sha256'
 THEN RAISE EXCEPTION 'Verification evidence intent requires exact original owner scope' USING ERRCODE='23514';END IF;RETURN NEW;
END$$;
CREATE TRIGGER verification_evidence_intent BEFORE INSERT ON whaleu_media.upload_intents FOR EACH ROW WHEN(NEW.protocol_version=13) EXECUTE FUNCTION whaleu_media.verification_evidence_intent_guard();
CREATE FUNCTION whaleu_media.verification_evidence_binding_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a whaleu_media.assets;i whaleu_media.upload_intents;s whaleu_media.verification_evidence_scopes;c whaleu_media.scope_consumptions;BEGIN
 SELECT * INTO STRICT a FROM whaleu_media.assets WHERE id=NEW.asset_id;SELECT * INTO STRICT i FROM whaleu_media.upload_intents WHERE id=a.intent_id;
 SELECT * INTO s FROM whaleu_media.verification_evidence_scopes WHERE id=a.resource_id AND actor_id=a.actor_id;
 SELECT * INTO c FROM whaleu_media.scope_consumptions WHERE actor_id=a.actor_id AND owner_kind='verification' AND resource_kind='student_evidence' AND scope_resource_id=a.resource_id;
 IF i.protocol_version<>13 OR i.state<>'ready' OR s.id IS NULL OR least(s.expires_at,s.evidence_expires_at,a.created_at+interval '24 hours')<=clock_timestamp()
 OR NEW.detached_at IS NOT NULL OR NEW.resource_id IS DISTINCT FROM s.application_id
 OR (NEW.owner_kind,NEW.resource_kind,NEW.content_version,NEW.slot,NEW.ordinal,NEW.manifest_digest) IS DISTINCT FROM (a.owner_kind,a.resource_kind,a.content_version,a.slot,a.ordinal,a.manifest_digest)
 OR NEW.attach_evidence IS DISTINCT FROM jsonb_build_object('version',13,'scopeId',a.resource_id::text,'scopeRevision',a.scope_revision)
 OR c.transaction_id IS DISTINCT FROM pg_current_xact_id() OR c.resource_id IS DISTINCT FROM NEW.resource_id OR c.scope_revision IS DISTINCT FROM a.scope_revision OR c.content_version IS DISTINCT FROM 1::bigint
 OR c.attach_evidence IS DISTINCT FROM jsonb_build_object('version',13,'assets',jsonb_build_array(jsonb_build_object('assetId',a.id::text,'digest',a.manifest_digest)))
 OR NOT EXISTS(SELECT 1 FROM whaleu_media.asset_safety_heads h JOIN whaleu_media.asset_safety_events e ON(e.asset_id,e.revision,e.id)=(h.asset_id,h.revision,h.event_id) WHERE h.asset_id=a.id AND e.state='allow' AND e.manifest_digest=a.manifest_digest AND e.policy_revision=a.policy_revision AND e.effective_at<=clock_timestamp() AND e.valid_until>clock_timestamp())
 THEN RAISE EXCEPTION 'Verification evidence requires exact current Media13 acceptance' USING ERRCODE='23514';END IF;
 IF TG_WHEN='BEFORE' AND NOT EXISTS(SELECT 1 FROM whaleu_verification.student_applications p WHERE p.id=s.application_id AND p.account_id=s.actor_id AND p.revision=s.revision AND p.state='draft' AND p.evidence_id IS NULL)
 THEN RAISE EXCEPTION 'Only exact original draft may freeze evidence' USING ERRCODE='23514';END IF;
 IF TG_WHEN='AFTER' AND NOT EXISTS(SELECT 1 FROM whaleu_media.verification_evidence_bindings b JOIN whaleu_verification.student_applications p ON p.id=b.application_id
 WHERE b.binding_id=NEW.id AND b.asset_id=a.id AND b.actor_id=a.actor_id AND b.manifest_digest=a.manifest_digest AND b.application_id=s.application_id AND b.revision=s.revision
 AND b.publication_transaction=pg_current_xact_id() AND p.evidence_id=b.binding_id AND p.evidence_revision=b.revision AND p.account_id=b.actor_id AND p.state='pending'
 AND p.evidence_expires_at=b.evidence_expires_at AND p.evidence_policy_ref=b.evidence_policy_ref AND b.evidence_expires_at=s.evidence_expires_at AND b.evidence_policy_ref=s.evidence_policy_ref)
 THEN RAISE EXCEPTION 'Verification evidence must freeze with exact pending application' USING ERRCODE='23514';END IF;RETURN NEW;
END$$;
CREATE TRIGGER verification_evidence_binding BEFORE INSERT ON whaleu_media.bindings FOR EACH ROW WHEN(NEW.owner_kind='verification') EXECUTE FUNCTION whaleu_media.verification_evidence_binding_guard();
CREATE CONSTRAINT TRIGGER verification_evidence_binding_final AFTER INSERT ON whaleu_media.bindings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.owner_kind='verification') EXECUTE FUNCTION whaleu_media.verification_evidence_binding_guard();
CREATE FUNCTION whaleu_media.verification_evidence_consumption_guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF NEW.transaction_id<>pg_current_xact_id() OR NOT EXISTS(SELECT 1 FROM whaleu_media.bindings b JOIN whaleu_media.assets a ON a.id=b.asset_id WHERE b.owner_kind='verification' AND b.resource_kind='student_evidence' AND b.resource_id=NEW.resource_id AND b.detached_at IS NULL AND a.resource_id=NEW.scope_resource_id AND a.actor_id=NEW.actor_id AND a.scope_revision=NEW.scope_revision)
 THEN RAISE EXCEPTION 'Verification evidence consumption requires exact atomic binding' USING ERRCODE='23514';END IF;RETURN NULL;END$$;
CREATE CONSTRAINT TRIGGER verification_evidence_consumption_final AFTER INSERT ON whaleu_media.scope_consumptions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.owner_kind='verification') EXECUTE FUNCTION whaleu_media.verification_evidence_consumption_guard();
CREATE FUNCTION whaleu_media.verification_evidence_pointer_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND OLD.evidence_id IS NOT NULL AND (NEW.evidence_id,NEW.evidence_revision,NEW.evidence_expires_at,NEW.evidence_policy_ref) IS DISTINCT FROM (OLD.evidence_id,OLD.evidence_revision,OLD.evidence_expires_at,OLD.evidence_policy_ref)
 THEN RAISE EXCEPTION 'Submitted verification evidence is immutable' USING ERRCODE='23514';END IF;
 IF NEW.evidence_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM whaleu_media.verification_evidence_bindings e JOIN whaleu_media.bindings b ON b.id=e.binding_id WHERE e.binding_id=NEW.evidence_id AND e.application_id=NEW.id AND e.actor_id=NEW.account_id AND e.revision=NEW.evidence_revision AND e.evidence_expires_at=NEW.evidence_expires_at AND e.evidence_policy_ref=NEW.evidence_policy_ref AND b.owner_kind='verification' AND b.resource_kind='student_evidence' AND b.resource_id=NEW.id AND b.asset_id=e.asset_id AND b.manifest_digest=e.manifest_digest)
 THEN RAISE EXCEPTION 'Application requires its exact private evidence' USING ERRCODE='23514';END IF;
 IF NEW.state IN ('pending','approved','rejected') AND (TG_OP='INSERT' OR NEW.state IS DISTINCT FROM OLD.state) AND NOT EXISTS(
 SELECT 1 FROM whaleu_media.verification_evidence_bindings e JOIN whaleu_media.bindings b ON b.id=e.binding_id JOIN whaleu_media.assets a ON a.id=e.asset_id JOIN whaleu_media.upload_intents i ON i.id=a.intent_id JOIN whaleu_media.asset_safety_heads h ON h.asset_id=a.id JOIN whaleu_media.asset_safety_events v ON (v.asset_id,v.revision,v.id)=(h.asset_id,h.revision,h.event_id)
 WHERE e.binding_id=NEW.evidence_id AND b.detached_at IS NULL AND i.protocol_version=13 AND i.state='ready' AND e.evidence_expires_at>clock_timestamp() AND v.state='allow' AND v.manifest_digest=a.manifest_digest AND v.policy_revision=a.policy_revision AND v.effective_at<=clock_timestamp() AND v.valid_until>clock_timestamp())
 THEN RAISE EXCEPTION 'Submission or decision requires current exact evidence Safety and retention' USING ERRCODE='23514';END IF;RETURN NULL;
END$$;
CREATE CONSTRAINT TRIGGER verification_evidence_pointer_final AFTER INSERT OR UPDATE ON whaleu_verification.student_applications DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_media.verification_evidence_pointer_guard();
CREATE FUNCTION whaleu_media.verification_evidence_appearance_guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF NEW.publication_transaction<>pg_current_xact_id() OR NOT EXISTS(SELECT 1 FROM whaleu_media.bindings b JOIN whaleu_media.assets a ON a.id=b.asset_id JOIN whaleu_media.verification_evidence_scopes s ON s.id=a.resource_id JOIN whaleu_verification.student_applications p ON p.id=NEW.application_id WHERE b.id=NEW.binding_id AND b.owner_kind='verification' AND b.resource_kind='student_evidence' AND b.asset_id=NEW.asset_id AND b.manifest_digest=NEW.manifest_digest AND b.resource_id=NEW.application_id AND a.actor_id=NEW.actor_id AND s.application_id=NEW.application_id AND s.revision=NEW.revision AND s.evidence_expires_at=NEW.evidence_expires_at AND s.evidence_policy_ref=NEW.evidence_policy_ref AND p.evidence_id=NEW.binding_id AND p.evidence_revision=NEW.revision AND p.state='pending')
 THEN RAISE EXCEPTION 'Evidence record requires atomic exact submission' USING ERRCODE='23514';END IF;RETURN NULL;END$$;
CREATE CONSTRAINT TRIGGER verification_evidence_appearance_final AFTER INSERT ON whaleu_media.verification_evidence_bindings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_media.verification_evidence_appearance_guard();
CREATE FUNCTION whaleu_media.verification_evidence_detach_guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF OLD.detached_at IS NULL AND NEW.detached_at IS NOT NULL AND (NEW.detach_reason<>'verification-evidence-expired' OR NOT EXISTS(SELECT 1 FROM whaleu_media.verification_evidence_retirements r JOIN whaleu_media.verification_evidence_bindings e ON e.binding_id=r.binding_id JOIN whaleu_media.assets a ON a.id=e.asset_id JOIN whaleu_media.verification_evidence_scopes s ON s.id=a.resource_id WHERE r.binding_id=NEW.id AND r.application_id=e.application_id AND r.transaction_id=pg_current_xact_id() AND e.evidence_expires_at<=clock_timestamp() AND s.cleanup_enabled))
 THEN RAISE EXCEPTION 'Evidence cleanup requires immutable expiry and explicit policy' USING ERRCODE='23514';END IF;RETURN NEW;END$$;
CREATE TRIGGER verification_evidence_detach BEFORE UPDATE ON whaleu_media.bindings FOR EACH ROW WHEN(NEW.owner_kind='verification') EXECUTE FUNCTION whaleu_media.verification_evidence_detach_guard();
CREATE FUNCTION whaleu_media.verification_evidence_retirement_guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF NEW.transaction_id<>pg_current_xact_id() OR NOT EXISTS(SELECT 1 FROM whaleu_media.verification_evidence_bindings e JOIN whaleu_media.bindings b ON b.id=e.binding_id JOIN whaleu_media.assets a ON a.id=e.asset_id JOIN whaleu_media.verification_evidence_scopes s ON s.id=a.resource_id WHERE e.binding_id=NEW.binding_id AND e.application_id=NEW.application_id AND e.evidence_expires_at<=clock_timestamp() AND s.cleanup_enabled AND b.detached_at IS NOT NULL AND b.detach_reason='verification-evidence-expired')
 THEN RAISE EXCEPTION 'Evidence retirement requires expired quiet-cleanup enrollment' USING ERRCODE='23514';END IF;RETURN NULL;END$$;
CREATE CONSTRAINT TRIGGER verification_evidence_retirement_final AFTER INSERT ON whaleu_media.verification_evidence_retirements DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_media.verification_evidence_retirement_guard();
