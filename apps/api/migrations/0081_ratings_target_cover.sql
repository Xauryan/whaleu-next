-- Ratings generic target single cover. Additive protocol dispatch only: all old
-- migration bytes and v1/v2 command / Review1-5 hashes remain frozen.
SET LOCAL lock_timeout='5s';
SELECT pg_advisory_xact_lock(hashtextextended('whaleu:named-block-policy:v1',0));

-- Context3 has a distinct persistent authority/hash domain. Existing context2
-- rows retain their original generated digest and exact validation branch.
CREATE OR REPLACE FUNCTION whaleu_ratings.scoped_context_record_digest(context_body jsonb,authority_body jsonb,protocol_body jsonb) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT whaleu_ratings.scoped_digest(CASE WHEN context_body->'protocolVersion'='3'::jsonb THEN 'target-cover-context-record' ELSE 'context-record' END,jsonb_build_object('context',context_body,'authority',authority_body,'protocolTuples',protocol_body))
$$;
DO $$DECLARE c record;BEGIN
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='whaleu_ratings.scoped_contexts'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%protocolVersion%' LOOP
 EXECUTE format('ALTER TABLE whaleu_ratings.scoped_contexts DROP CONSTRAINT %I',c.conname);
 END LOOP;
END$$;
ALTER TABLE whaleu_ratings.scoped_contexts ADD CONSTRAINT scoped_context_protocol_dispatch CHECK(
 context->>'id'=id::text AND context->>'actorId'=account_id::text AND context->>'tokenDigest'=token_digest AND
 (context->'protocolVersion'='2'::jsonb OR (context->'protocolVersion'='3'::jsonb AND authority->>'contextAuthority'='ratings-target-cover-context-v1' AND jsonb_typeof(authority->'targetCoverCapabilities')='array'))
);

CREATE TABLE whaleu_ratings.target_cover_capability_epoch(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),epoch bigint NOT NULL CHECK(epoch>=0));
INSERT INTO whaleu_ratings.target_cover_capability_epoch VALUES(true,0);
CREATE FUNCTION whaleu_ratings.advance_target_cover_capability_epoch() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 UPDATE whaleu_ratings.target_cover_capability_epoch SET epoch=epoch+1 WHERE singleton;RETURN NULL;
END$$;
CREATE TABLE whaleu_ratings.target_cover_capability_sources(
 id uuid PRIMARY KEY, protocol_version_id uuid NOT NULL UNIQUE REFERENCES whaleu_ratings.scope_protocol_versions(id),
 source_id uuid NOT NULL,source_revision uuid NOT NULL,source_digest text NOT NULL CHECK(source_digest ~ '^[a-f0-9]{64}$'),
 protocol_version integer NOT NULL CHECK(protocol_version=3),review_version integer NOT NULL CHECK(review_version=6),journal_version integer NOT NULL CHECK(journal_version=11),
 routes_digest text NOT NULL CHECK(routes_digest ~ '^[a-f0-9]{64}$'),native_digest text NOT NULL CHECK(native_digest ~ '^[a-f0-9]{64}$'),
 compatibility_digest text NOT NULL CHECK(compatibility_digest ~ '^[a-f0-9]{64}$'),adoption_digest text NOT NULL CHECK(adoption_digest ~ '^[a-f0-9]{64}$'),
 issuer text NOT NULL CHECK(length(btrim(issuer))>0),provenance_ref text NOT NULL CHECK(length(btrim(provenance_ref))>0),
 valid_from timestamptz NOT NULL,valid_until timestamptz NOT NULL,CHECK(isfinite(valid_from) AND isfinite(valid_until) AND valid_until>valid_from),
 FOREIGN KEY(source_id,source_revision) REFERENCES whaleu_ratings.scoped_source_attestations(id,revision)
);
CREATE FUNCTION whaleu_ratings.target_cover_capability_current(capability uuid,instant timestamptz) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT coalesce((SELECT c.valid_from<=instant AND c.valid_until>instant AND v.phase='adopted' AND h.version_id=v.id
 AND (v.capability_source_id,v.capability_source_revision)=(c.source_id,c.source_revision)
 AND s.source_kind='scope_capabilities' AND s.digest=c.source_digest AND whaleu_ratings.scoped_source_current(s.id,s.revision,instant)
 AND c.compatibility_digest=whaleu_ratings.scoped_digest('target-cover-compatibility',jsonb_build_object('protocolVersion',3,'reviewVersion',6,'journalVersion',11,'sourceId',s.id,'sourceRevision',s.revision,'sourceDigest',s.digest,'routesDigest',c.routes_digest,'nativeDigest',c.native_digest))
 AND c.adoption_digest=whaleu_ratings.scoped_digest('target-cover-adoption',jsonb_build_object('protocolVersionId',v.id,'generation',v.generation,'releaseId',v.release_id,'manifest',v.manifest,'compatibilityDigest',c.compatibility_digest))
 FROM whaleu_ratings.target_cover_capability_sources c JOIN whaleu_ratings.scope_protocol_versions v ON v.id=c.protocol_version_id
 JOIN whaleu_ratings.scope_protocol_heads h ON h.logical_scope_key=v.logical_scope_key
 JOIN whaleu_ratings.scoped_source_attestations s ON (s.id,s.revision)=(c.source_id,c.source_revision) WHERE c.id=capability),false)
$$;
CREATE FUNCTION whaleu_ratings.target_cover_context_current(context_id uuid,instant timestamptz) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT coalesce((SELECT c.context->'protocolVersion'='3'::jsonb AND c.authority->>'contextAuthority'='ratings-target-cover-context-v1' AND c.context->'capabilities' ? 'target_cover'
 AND jsonb_array_length(c.authority->'targetCoverCapabilities')=jsonb_array_length(c.protocol_tuples)
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(c.protocol_tuples) p LEFT JOIN whaleu_ratings.target_cover_capability_sources a ON a.protocol_version_id=(p->>'versionId')::uuid
 WHERE a.id IS NULL OR NOT whaleu_ratings.target_cover_capability_current(a.id,instant)
 OR NOT c.authority->'targetCoverCapabilities' @> jsonb_build_array(jsonb_build_object('id',a.id,'protocolVersionId',a.protocol_version_id,'sourceDigest',a.source_digest,'current',true,'validUntil',to_char(a.valid_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))))
 FROM whaleu_ratings.scoped_contexts c WHERE c.id=context_id),false)
$$;
CREATE TRIGGER a00_cover_capability_writer BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_ratings.target_cover_capability_sources FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.scoped_public_writer_gate();
CREATE TRIGGER a01_cover_capability_epoch BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_ratings.target_cover_capability_sources FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.advance_scoped_source_epoch();
CREATE TRIGGER a02_cover_capability_epoch BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_ratings.target_cover_capability_sources FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.advance_target_cover_capability_epoch();
CREATE TRIGGER cover_capability_immutable BEFORE UPDATE OR DELETE ON whaleu_ratings.target_cover_capability_sources FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.immutable();
CREATE TRIGGER cover_capability_retain BEFORE TRUNCATE ON whaleu_ratings.target_cover_capability_sources FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.immutable();

CREATE TABLE whaleu_ratings.target_cover_upload_scopes(
 id uuid PRIMARY KEY,actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),client_request_id uuid NOT NULL,command_request_id uuid NOT NULL,
 scope_revision text NOT NULL CHECK(scope_revision ~ '^[a-f0-9]{64}$'),request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),input jsonb NOT NULL,declaration jsonb NOT NULL,
 context_id uuid NOT NULL REFERENCES whaleu_ratings.scoped_contexts(id),context_revision text NOT NULL,session_id uuid NOT NULL REFERENCES whaleu_identity.sessions(id),
 target_id uuid NOT NULL,category_id uuid NOT NULL,expected_target_revision uuid,expected_definition_revision uuid,expected_content_version integer,
 expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(actor_id,client_request_id),CHECK(isfinite(created_at) AND isfinite(expires_at) AND expires_at>created_at AND expires_at<=created_at+interval '5 minutes'),
 CHECK((expected_target_revision IS NULL)=(expected_definition_revision IS NULL) AND (expected_target_revision IS NULL)=(expected_content_version IS NULL)),
 CHECK(expected_content_version IS NULL OR expected_content_version BETWEEN 1 AND 2147483646)
);
CREATE FUNCTION whaleu_ratings.target_cover_upload_scope_current(scope_id uuid,instant timestamptz) RETURNS boolean LANGUAGE sql AS $$
 SELECT coalesce((SELECT s.expires_at>instant AND whaleu_ratings.scoped_context_current(s.context_id,s.actor_id,s.session_id,instant)
 AND whaleu_ratings.target_cover_context_current(s.context_id,instant)
 AND s.input->'context'->>'scopeRevision'=s.context_revision
 AND EXISTS(SELECT 1 FROM whaleu_ratings.scoped_categories c WHERE c.catalog_id=(s.input->'context'->>'catalogRevision')::uuid AND c.category_id=s.category_id AND c.kind='general'
 AND c.effective_revision::text=s.input->>'expectedCategoryRevision' AND whaleu_ratings.scoped_category_current(c.catalog_id,c.category_id))
 AND (s.expected_target_revision IS NULL OR EXISTS(SELECT 1 FROM whaleu_ratings.targets t JOIN whaleu_ratings.target_definition_heads h ON h.target_id=t.id
 WHERE t.id=s.target_id AND t.creator_id=s.actor_id AND t.active AND t.revision=s.expected_target_revision
 AND h.definition_revision=s.expected_definition_revision AND h.content_version=s.expected_content_version
 AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.target_owner_tombstones x WHERE x.target_id=t.id)))
 FROM whaleu_ratings.target_cover_upload_scopes s WHERE s.id=scope_id),false)
$$;
CREATE TRIGGER cover_upload_scope_immutable BEFORE UPDATE OR DELETE ON whaleu_ratings.target_cover_upload_scopes FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.immutable();
CREATE TRIGGER cover_upload_scope_retain BEFORE TRUNCATE ON whaleu_ratings.target_cover_upload_scopes FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.immutable();

CREATE TABLE whaleu_ratings.target_cover_appearances(
 id uuid PRIMARY KEY,target_id uuid NOT NULL REFERENCES whaleu_ratings.targets(id) DEFERRABLE INITIALLY DEFERRED,
 actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),asset_id uuid NOT NULL UNIQUE REFERENCES whaleu_media.assets(id),
 manifest_digest text NOT NULL CHECK(manifest_digest ~ '^[a-f0-9]{64}$'),media_binding_id uuid NOT NULL UNIQUE REFERENCES whaleu_media.bindings(id) DEFERRABLE INITIALLY DEFERRED,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),publication_transaction xid8 NOT NULL DEFAULT pg_current_xact_id()
);
CREATE INDEX target_cover_appearances_target ON whaleu_ratings.target_cover_appearances(target_id,id);
CREATE TRIGGER a00_cover_appearance_writer BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_ratings.target_cover_appearances FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.target_edit_writer();
CREATE TRIGGER a01_cover_appearance_navigation BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_ratings.target_cover_appearances FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.advance_navigation_epoch();
CREATE TRIGGER a02_cover_appearance_pool BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_ratings.target_cover_appearances FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.advance_random_pool_epoch();
CREATE TRIGGER cover_appearance_immutable BEFORE UPDATE OR DELETE ON whaleu_ratings.target_cover_appearances FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.immutable();
CREATE TRIGGER cover_appearance_retain BEFORE TRUNCATE ON whaleu_ratings.target_cover_appearances FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.immutable();

CREATE FUNCTION whaleu_community.rating_target_cover_reference_shape(c jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT coalesce(c='null'::jsonb OR (whaleu_community.rating_scoped_keys(c,ARRAY['appearanceId','assetId','manifestDigest']) AND whaleu_community.rating_scoped_ids(c,ARRAY['appearanceId','assetId']) AND c->>'manifestDigest' ~ '^[a-f0-9]{64}$'),false)
$$;
CREATE FUNCTION whaleu_community.rating_target_cover_envelope_shape(e jsonb,op text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT coalesce(NOT e ? 'assetIds' AND e->'version'='6'::jsonb AND op IN ('publish_rating_target_cover_scoped','edit_rating_target_cover_scoped') AND e->>'purpose'=op
 AND whaleu_community.rating_target_cover_reference_shape(e->'cover')
 AND whaleu_community.rating_scoped_envelope_shape((e-'cover')||jsonb_build_object('version',5,'purpose',CASE op WHEN 'publish_rating_target_cover_scoped' THEN 'publish_rating_target_scoped' ELSE 'edit_rating_target_scoped' END,'assetIds','[]'::jsonb),CASE op WHEN 'publish_rating_target_cover_scoped' THEN 'publish_rating_target_scoped' ELSE 'edit_rating_target_scoped' END),false)
$$;
DO $$ DECLARE definition text;BEGIN
 SELECT pg_get_functiondef('whaleu_community.rating_envelope_shape(jsonb,text)'::regprocedure) INTO definition;
 EXECUTE replace(definition,'FUNCTION whaleu_community.rating_envelope_shape(', 'FUNCTION whaleu_community.rating_envelope_shape_pre_target_cover(');
END $$;
CREATE OR REPLACE FUNCTION whaleu_community.rating_envelope_shape(e jsonb,op text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE WHEN op IN ('publish_rating_target_cover_scoped','edit_rating_target_cover_scoped') THEN whaleu_community.rating_target_cover_envelope_shape(e,op) ELSE whaleu_community.rating_envelope_shape_pre_target_cover(e,op) END
$$;
ALTER TABLE whaleu_community.rating_approval_decisions DROP CONSTRAINT rating_decision_protocol_v5;
ALTER TABLE whaleu_community.rating_approval_decisions ADD CONSTRAINT rating_decision_protocol_v6 CHECK(
 (operation IN ('publish_rating_target','publish_rating_comment') AND envelope_version=1) OR (operation='publish_rating_reply' AND envelope_version=2)
 OR (operation='edit_rating_target' AND envelope_version=3) OR (operation='publish_rating_categories' AND envelope_version=4)
 OR (operation IN ('publish_rating_target_scoped','edit_rating_target_scoped','publish_rating_comment_scoped','publish_rating_reply_scoped','publish_rating_category_base_scoped','publish_rating_category_override_scoped') AND envelope_version=5)
 OR (operation IN ('publish_rating_target_cover_scoped','edit_rating_target_cover_scoped') AND envelope_version=6));
CREATE TABLE whaleu_community.rating_target_cover_definition_bindings(
 target_id uuid NOT NULL,content_version integer NOT NULL CHECK(content_version>=1),definition_revision uuid NOT NULL,applied_target_revision uuid NOT NULL,
 decision_id uuid NOT NULL UNIQUE,account_id uuid NOT NULL,operation text NOT NULL,envelope_version integer NOT NULL CHECK(envelope_version=6),digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),envelope jsonb NOT NULL,scope jsonb NOT NULL,
 bound_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(bound_at)),publication_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),PRIMARY KEY(target_id,content_version),UNIQUE(target_id,definition_revision),
 FOREIGN KEY(decision_id,account_id,operation,envelope_version,digest) REFERENCES whaleu_community.rating_approval_decisions(id,account_id,operation,envelope_version,digest),
 FOREIGN KEY(target_id,content_version,definition_revision) REFERENCES whaleu_ratings.target_definition_versions(target_id,content_version,definition_revision) DEFERRABLE INITIALLY DEFERRED,
 CHECK((content_version=1 AND operation='publish_rating_target_cover_scoped' AND definition_revision=applied_target_revision) OR (content_version>=2 AND operation='edit_rating_target_cover_scoped')),
 CHECK(whaleu_community.rating_target_cover_envelope_shape(envelope,operation)),CHECK(envelope->>'targetId'=target_id::text AND envelope->>'targetRevision'=applied_target_revision::text AND envelope->>'definitionRevision'=definition_revision::text AND envelope->'contentVersion'=to_jsonb(content_version) AND envelope->>'accountId'=account_id::text AND scope=envelope->'scope'),
 CHECK(digest=encode(sha256(convert_to('whaleu-rating-content-approval:v6'||chr(10)||whaleu_community.content_canonical_json(envelope),'UTF8')),'hex'))
);


CREATE FUNCTION whaleu_community.rating_target_cover_decision_current(_decision uuid,_consume boolean) RETURNS boolean LANGUAGE sql AS $$
 WITH instant AS MATERIALIZED (SELECT clock_timestamp() now)
 SELECT coalesce((SELECT d.envelope_version=6 AND whaleu_community.rating_target_cover_envelope_shape(d.envelope,d.operation)
  AND d.digest=encode(sha256(convert_to('whaleu-rating-content-approval:v6'||chr(10)||whaleu_community.content_canonical_json(d.envelope),'UTF8')),'hex')
  AND d.result='allow' AND d.coverage='complete' AND d.provenance='accepted'
  AND p.policy_key='local-explicit-v1' AND p.version=1 AND p.coverage='complete' AND p.provenance='accepted'
  AND e.state='allow' AND e.coverage='complete' AND e.provenance='accepted'
  AND length(btrim(d.issuer))>0 AND length(btrim(d.provenance_ref))>0 AND length(btrim(p.issuer))>0 AND length(btrim(p.provenance_ref))>0 AND length(btrim(e.issuer))>0 AND length(btrim(e.provenance_ref))>0
  AND isfinite(d.evaluated_at) AND d.evaluated_at<=instant.now AND isfinite(p.valid_from) AND p.valid_from<=d.evaluated_at AND (p.valid_until IS NULL OR (isfinite(p.valid_until) AND p.valid_until>instant.now))
  AND isfinite(e.occurred_at) AND e.occurred_at>=d.evaluated_at AND e.occurred_at<=instant.now AND isfinite(d.consume_until) AND d.consume_until>d.evaluated_at AND (NOT _consume OR d.consume_until>instant.now)
  AND ((d.visibility_model='durable' AND d.visibility_until IS NULL) OR (d.visibility_model='until' AND isfinite(d.visibility_until) AND d.visibility_until>d.evaluated_at AND d.visibility_until>instant.now))
 FROM whaleu_community.rating_approval_decisions d JOIN whaleu_identity.accounts a ON a.id=d.account_id
 JOIN whaleu_community.content_approval_policies p ON p.id=d.policy_revision_id JOIN whaleu_community.rating_approval_heads h ON h.decision_id=d.id
 JOIN whaleu_community.rating_approval_events e ON e.id=h.event_id AND e.decision_id=d.id CROSS JOIN instant WHERE d.id=_decision),false)
$$;

CREATE FUNCTION whaleu_community.rating_target_cover_binding_validate() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d whaleu_community.rating_approval_decisions;instant timestamptz;BEGIN
 SELECT * INTO d FROM whaleu_community.rating_approval_decisions WHERE id=NEW.decision_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Scoped Review decision missing' USING ERRCODE='23514';END IF;
 PERFORM id FROM whaleu_identity.accounts WHERE id=d.account_id FOR SHARE;
 PERFORM decision_id FROM whaleu_community.rating_approval_heads WHERE decision_id=d.id FOR SHARE;instant:=clock_timestamp();
 IF NOT whaleu_community.rating_target_cover_decision_current(d.id,true) OR NEW.publication_transaction IS DISTINCT FROM pg_current_xact_id()
  OR (NEW.account_id,NEW.operation,NEW.envelope_version,NEW.digest,NEW.envelope) IS DISTINCT FROM (d.account_id,d.operation,d.envelope_version,d.digest,d.envelope)
  OR EXISTS(SELECT 1 FROM whaleu_community.rating_approval_decisions n WHERE n.account_id=d.account_id AND n.operation=d.operation AND n.envelope_version=d.envelope_version AND n.digest=d.digest AND (n.evaluated_at,n.id)>(d.evaluated_at,d.id))
  OR EXISTS(SELECT 1 FROM whaleu_community.rating_scoped_content_bindings WHERE decision_id=d.id)
  OR EXISTS(SELECT 1 FROM whaleu_community.rating_target_cover_definition_bindings WHERE decision_id=d.id)
  OR EXISTS(SELECT 1 FROM whaleu_community.rating_scoped_category_source_bindings WHERE decision_id=d.id)
 THEN RAISE EXCEPTION 'Scoped exact Review consumption mismatch' USING ERRCODE='23514';END IF;
 NEW.bound_at:=instant;RETURN NEW;END $$;

CREATE FUNCTION whaleu_community.rating_target_cover_definition_current(_target uuid,_content_version integer,_definition_revision uuid,_applied_target_revision uuid,_envelope jsonb) RETURNS boolean LANGUAGE sql AS $$
 SELECT coalesce((SELECT b.target_id=_target AND b.content_version=_content_version AND b.definition_revision=_definition_revision AND b.applied_target_revision=_applied_target_revision
  AND b.envelope=_envelope AND b.scope=_envelope->'scope' AND whaleu_community.rating_target_cover_envelope_shape(_envelope,b.operation)
  AND (d.account_id,d.operation,d.envelope_version,d.digest,d.envelope)=(b.account_id,b.operation,b.envelope_version,b.digest,b.envelope)
  AND isfinite(b.bound_at) AND b.bound_at>=d.evaluated_at AND b.bound_at<=clock_timestamp()
  AND whaleu_community.rating_target_cover_decision_current(b.decision_id,false)
 FROM whaleu_community.rating_target_cover_definition_bindings b JOIN whaleu_community.rating_approval_decisions d ON d.id=b.decision_id
 WHERE b.target_id=_target AND b.content_version=_content_version),false)
$$;


CREATE TRIGGER a00_cover_review_writer BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_community.rating_target_cover_definition_bindings FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.target_edit_writer();
CREATE TRIGGER a01_cover_review_epoch BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_community.rating_target_cover_definition_bindings FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.advance_rating_review_binding_epoch();
CREATE TRIGGER a02_cover_review_navigation BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_community.rating_target_cover_definition_bindings FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.advance_navigation_epoch();
CREATE TRIGGER a03_cover_review_pool BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_community.rating_target_cover_definition_bindings FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.advance_random_pool_epoch();
CREATE TRIGGER cover_review_validate BEFORE INSERT ON whaleu_community.rating_target_cover_definition_bindings FOR EACH ROW EXECUTE FUNCTION whaleu_community.rating_target_cover_binding_validate();
CREATE TRIGGER cover_review_immutable BEFORE UPDATE OR DELETE ON whaleu_community.rating_target_cover_definition_bindings FOR EACH ROW EXECUTE FUNCTION whaleu_community.content_approval_immutable();
CREATE TRIGGER cover_review_retain BEFORE TRUNCATE ON whaleu_community.rating_target_cover_definition_bindings FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.content_approval_immutable();


DO $$ DECLARE definition text;BEGIN SELECT pg_get_functiondef('whaleu_ratings.scoped_intent_valid(jsonb)'::regprocedure) INTO definition;EXECUTE replace(definition,'FUNCTION whaleu_ratings.scoped_intent_valid(', 'FUNCTION whaleu_ratings.scoped_intent_valid_pre_target_cover(');END $$;

DO $$ DECLARE definition text;BEGIN SELECT pg_get_functiondef('whaleu_ratings.scoped_intent_hash(jsonb)'::regprocedure) INTO definition;EXECUTE replace(definition,'FUNCTION whaleu_ratings.scoped_intent_hash(', 'FUNCTION whaleu_ratings.scoped_intent_hash_pre_target_cover(');END $$;

DO $$ DECLARE definition text;BEGIN SELECT pg_get_functiondef('whaleu_ratings.scoped_preparation_envelope(whaleu_ratings.scoped_command_preparations)'::regprocedure) INTO definition;EXECUTE replace(definition,'FUNCTION whaleu_ratings.scoped_preparation_envelope(', 'FUNCTION whaleu_ratings.scoped_preparation_envelope_pre_target_cover(');END $$;

DO $$ DECLARE definition text;BEGIN SELECT pg_get_functiondef('whaleu_ratings.rating_scoped_operation_rule(text,integer)'::regprocedure) INTO definition;EXECUTE replace(definition,'FUNCTION whaleu_ratings.rating_scoped_operation_rule(', 'FUNCTION whaleu_ratings.rating_scoped_operation_rule_pre_target_cover(');END $$;


CREATE FUNCTION whaleu_ratings.target_cover_intent_valid(i jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE c jsonb;legacy jsonb;BEGIN
 IF i->'payload' ? 'assetIds' OR i->'protocolVersion'<>'3'::jsonb OR i->>'operation' NOT IN ('create_target_scoped','edit_target_scoped') THEN RETURN false;END IF;
 c:=i->'payload'->'cover';
 IF c->>'action' IN ('clear','keep') THEN
  IF NOT whaleu_community.rating_scoped_keys(c,ARRAY['action']) OR (c->>'action'='keep' AND i->>'operation'<>'edit_target_scoped') THEN RETURN false;END IF;
 ELSIF c->>'action'='replace' THEN
  IF NOT whaleu_community.rating_scoped_keys(c,ARRAY['action','assetId','uploadScopeId']) OR NOT whaleu_community.rating_scoped_ids(c,ARRAY['assetId','uploadScopeId']) THEN RETURN false;END IF;
 ELSE RETURN false;END IF;
 legacy:=i||jsonb_build_object('protocolVersion',2,'payload',((i->'payload')-'cover')||jsonb_build_object('assetIds','[]'::jsonb));
 RETURN whaleu_ratings.scoped_intent_valid_pre_target_cover(legacy);
 EXCEPTION WHEN OTHERS THEN RETURN false;END $$;
CREATE OR REPLACE FUNCTION whaleu_ratings.scoped_intent_valid(i jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE WHEN i->'protocolVersion'='3'::jsonb THEN whaleu_ratings.target_cover_intent_valid(i) ELSE whaleu_ratings.scoped_intent_valid_pre_target_cover(i) END
$$;
CREATE OR REPLACE FUNCTION whaleu_ratings.scoped_intent_hash(i jsonb) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT CASE WHEN i->'protocolVersion'='3'::jsonb THEN encode(sha256(convert_to('whaleu:rating-target-cover-command:v1'||chr(10)||whaleu_ratings.creation_canonical_json(jsonb_build_object('protocolVersion',i->'protocolVersion','operation',i->'operation','intent',jsonb_build_object('context',i->'context','payload',i->'payload'))),'UTF8')),'hex') ELSE whaleu_ratings.scoped_intent_hash_pre_target_cover(i) END
$$;
CREATE OR REPLACE FUNCTION whaleu_ratings.rating_scoped_operation_rule(op text,protocol integer) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE WHEN protocol=3 THEN CASE op WHEN 'create_target_scoped' THEN '{"domain":"create_target","purpose":"publish_rating_target_cover_scoped","effect":null}'::jsonb WHEN 'edit_target_scoped' THEN '{"domain":"edit_target","purpose":"edit_rating_target_cover_scoped","effect":null}'::jsonb ELSE NULL END ELSE whaleu_ratings.rating_scoped_operation_rule_pre_target_cover(op,protocol) END
$$;
CREATE OR REPLACE FUNCTION whaleu_ratings.scoped_preparation_envelope(p whaleu_ratings.scoped_command_preparations) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE e jsonb;BEGIN
 e:=whaleu_ratings.scoped_preparation_envelope_pre_target_cover(p);
 IF p.intent->'protocolVersion'<>'3'::jsonb THEN RETURN e;END IF;
 RETURN (e-'assetIds')||jsonb_build_object('version',6,'purpose',whaleu_ratings.rating_scoped_operation_rule(p.operation,3)->'purpose','cover',p.before_state->'resolvedCover');
END $$;


CREATE OR REPLACE FUNCTION whaleu_ratings.scoped_domain_request(actor uuid,request uuid) RETURNS whaleu_ratings.requests LANGUAGE plpgsql STABLE AS $$
DECLARE q whaleu_ratings.requests;p whaleu_ratings.scoped_command_preparations;e whaleu_ratings.scoped_command_causes;c whaleu_ratings.scoped_contexts;rule jsonb;BEGIN
 SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=actor AND request_id=request;
 rule:=whaleu_ratings.rating_scoped_operation_rule(q.operation,2);IF rule IS NULL THEN RETURN q;END IF;
 SELECT * INTO p FROM whaleu_ratings.scoped_command_preparations WHERE account_id=actor AND request_id=request;
 SELECT * INTO c FROM whaleu_ratings.scoped_contexts WHERE id=p.context_id;
 SELECT * INTO e FROM whaleu_ratings.scoped_command_causes WHERE account_id=actor AND request_id=request AND cause_kind='execution';
 IF NOT coalesce(p.intent_hash=q.intent_hash AND p.operation=q.operation AND whaleu_ratings.scoped_intent_valid(p.intent)
 AND whaleu_ratings.scoped_intent_hash(p.intent)=q.intent_hash AND c.id=p.context_id AND c.account_id=actor AND c.session_id=p.session_id
 AND c.token_digest=p.intent->'context'->>'tokenDigest' AND c.context->>'scopeRevision'=p.intent->'context'->>'scopeRevision'
 AND c.context->'selector'=p.intent->'context'->'selector' AND c.context->>'protocolGeneration'=p.intent->'context'->>'protocolGeneration'
 AND c.context->>'sourceDigest'=p.intent->'context'->>'sourceDigest'
 AND c.context->'heads'->0->>'catalogRevision'=p.intent->'context'->>'catalogRevision' AND c.context->'heads'->0->>'headRevision'=p.intent->'context'->>'headRevision'
 AND e.mutation_transaction=pg_current_xact_id() AND e.artifact_id=c.id AND e.artifact_revision=p.target_revision
 AND e.proof=jsonb_build_object('intentHash',q.intent_hash,'operation',q.operation,'contextId',c.id,'contextRevision',p.context_revision),false)
 THEN RAISE EXCEPTION 'Scoped request has no exact typed preparation/execution cause' USING ERRCODE='23514';END IF;
 q.operation:=rule->>'domain';
 IF q.receipt IS NOT NULL THEN
  IF NOT coalesce(q.receipt->'protocolVersion'=p.intent->'protocolVersion' AND q.receipt->>'operation'=p.operation AND q.receipt->>'intentHash'=p.intent_hash
   AND q.receipt->>'requestId'=request::text AND q.receipt->>'outcome' IN ('applied','noop') AND jsonb_typeof(q.receipt->'result')='object',false)
  THEN RAISE EXCEPTION 'Scoped domain receipt is not an exact success' USING ERRCODE='23514';END IF;
  q.receipt:=(q.receipt->'result')||jsonb_build_object('requestId',request,'operation',q.operation,'outcome',q.receipt->>'outcome');
 END IF;RETURN q;
END $$;

CREATE OR REPLACE FUNCTION whaleu_ratings.scoped_edit_preparation(target uuid,revision uuid) RETURNS whaleu_ratings.scoped_command_preparations LANGUAGE plpgsql STABLE AS $$
DECLARE p whaleu_ratings.scoped_command_preparations;e whaleu_ratings.scoped_command_causes;BEGIN
 SELECT * INTO e FROM whaleu_ratings.scoped_command_causes WHERE cause_kind='target_edit' AND artifact_id=target AND artifact_revision=revision AND mutation_transaction=pg_current_xact_id();
 SELECT * INTO p FROM whaleu_ratings.scoped_command_preparations WHERE account_id=e.account_id AND request_id=e.request_id;
 IF NOT coalesce(p.operation='edit_target_scoped' AND p.target_id=target AND p.target_revision=revision AND e.proof->>'definitionRevision'=p.definition_revision::text
 AND (e.proof->>'contentVersion')::integer=p.content_version AND p.envelope->>'purpose'=CASE WHEN p.intent->'protocolVersion'='3'::jsonb THEN 'edit_rating_target_cover_scoped' ELSE 'edit_rating_target_scoped' END
 AND p.envelope->>'previousTargetRevision'=p.intent->'payload'->>'expectedTargetRevision' AND p.envelope->>'previousDefinitionRevision'=p.intent->'payload'->>'expectedDefinitionRevision',false)
 THEN RAISE EXCEPTION 'Scoped edit has no exact fresh cause' USING ERRCODE='23514';END IF;
 PERFORM whaleu_ratings.scoped_domain_request(p.account_id,p.request_id);RETURN p;
END $$;

CREATE OR REPLACE FUNCTION whaleu_ratings.verify_scoped_command(actor uuid,request uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE q whaleu_ratings.requests;p whaleu_ratings.scoped_command_preparations;o whaleu_ratings.scoped_command_outcomes;cause whaleu_ratings.scoped_command_causes;expected jsonb;n integer;t whaleu_ratings.targets;
BEGIN
 IF EXISTS(SELECT 1 FROM whaleu_ratings.requests WHERE account_id=actor AND request_id=request AND whaleu_ratings.category_management_operation(operation)) THEN PERFORM whaleu_ratings.verify_category_management_command(actor,request);RETURN;END IF;

 SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=actor AND request_id=request;
 SELECT * INTO o FROM whaleu_ratings.scoped_command_outcomes WHERE account_id=actor AND request_id=request;
 IF NOT coalesce(whaleu_ratings.rating_scoped_operation_rule(q.operation,2) IS NOT NULL AND o.operation=q.operation AND o.intent_hash=q.intent_hash AND o.mutation_transaction=pg_current_xact_id(),false)
 THEN RAISE EXCEPTION 'Scoped outcome is absent or not exact' USING ERRCODE='23514';END IF;
 expected:=jsonb_build_object('protocolVersion',o.intent->'protocolVersion','requestId',request,'operation',q.operation,'intentHash',q.intent_hash,'outcome',o.outcome)||CASE WHEN o.outcome='closed' THEN jsonb_build_object('code',o.code) ELSE jsonb_build_object('result',o.result) END;
 IF q.receipt IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Scoped receipt bytes differ from immutable outcome' USING ERRCODE='23514';END IF;
 SELECT count(*) INTO n FROM (SELECT id FROM whaleu_ratings.score_transitions WHERE account_id=actor AND request_id=request UNION ALL SELECT id FROM whaleu_ratings.comment_transitions WHERE account_id=actor AND request_id=request UNION ALL SELECT id FROM whaleu_ratings.reply_transitions WHERE account_id=actor AND request_id=request UNION ALL SELECT id FROM whaleu_ratings.like_transitions WHERE account_id=actor AND request_id=request UNION ALL SELECT id FROM whaleu_ratings.subscription_transitions WHERE account_id=actor AND request_id=request) mutations;
 IF o.outcome='closed' THEN
  IF n<>0 OR EXISTS(SELECT 1 FROM whaleu_ratings.scoped_command_causes WHERE account_id=actor AND request_id=request)
   OR EXISTS(SELECT 1 FROM whaleu_ratings.effect_events WHERE actor_account_id=actor AND request_id=request)
   OR (o.code='RATING_CREATION_CANCELLED' AND q.operation<>'create_target_scoped') OR (o.code='RATING_EDIT_CANCELLED' AND q.operation<>'edit_target_scoped')
  THEN RAISE EXCEPTION 'Scoped closure cannot hide a mutation' USING ERRCODE='23514';END IF;RETURN;
 END IF;
 SELECT * INTO p FROM whaleu_ratings.scoped_command_preparations WHERE account_id=actor AND request_id=request;
 PERFORM whaleu_ratings.scoped_domain_request(actor,request);
 IF NOT whaleu_ratings.scoped_command_parents_current(p) OR p.intent IS DISTINCT FROM o.intent OR p.envelope IS DISTINCT FROM whaleu_ratings.scoped_preparation_envelope(p) OR p.valid_until<=clock_timestamp() OR p.before_state IS NULL
 OR NOT whaleu_ratings.target_edit_session_current(actor,p.session_id,clock_timestamp()) OR o.result->>'targetId' IS DISTINCT FROM p.target_id::text
 OR NOT coalesce(o.result->>'occurredAt' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$',false)
 THEN RAISE EXCEPTION 'Scoped success preparation/session mismatch' USING ERRCODE='23514';END IF;
 IF (SELECT array_agg(cause_kind ORDER BY cause_kind) FROM whaleu_ratings.scoped_command_causes WHERE account_id=actor AND request_id=request)
 IS DISTINCT FROM (CASE WHEN q.operation='create_target_scoped' THEN ARRAY['catalog_release','execution','target_initial'] WHEN q.operation='edit_target_scoped' AND o.outcome='applied' THEN ARRAY['execution','target_edit'] ELSE ARRAY['execution'] END)
 THEN RAISE EXCEPTION 'Scoped request has missing or extra typed causes' USING ERRCODE='23514';END IF;
 IF q.operation='set_score_scoped' THEN
  IF NOT EXISTS(SELECT 1 FROM whaleu_ratings.scores x WHERE x.target_id=p.target_id AND x.account_id=actor AND x.score=(p.intent->'payload'->>'score')::smallint AND x.revision::text=o.result->>'revision')
   OR (o.outcome='applied' AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.score_transitions x WHERE x.account_id=actor AND x.request_id=request AND x.target_id=p.target_id AND x.new_score=(p.intent->'payload'->>'score')::smallint AND x.old_revision::text IS NOT DISTINCT FROM p.intent->'payload'->>'expectedRevision'))
   OR (o.outcome='noop' AND o.result->>'revision' IS DISTINCT FROM p.intent->'payload'->>'expectedRevision')
  THEN RAISE EXCEPTION 'Scoped score differs from exact original desired state/CAS' USING ERRCODE='23514';END IF;
 ELSIF q.operation IN ('set_comment_like_scoped','set_reply_like_scoped') THEN
  IF (o.outcome='applied' AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.like_transitions x WHERE x.account_id=actor AND x.request_id=request AND x.target_id=p.target_id
    AND x.root_id::text=p.intent->'payload'->>'rootId' AND x.reply_id::text IS NOT DISTINCT FROM p.intent->'payload'->>'replyId'
    AND x.old_revision::text=p.intent->'payload'->>'expectedLikeRevision' AND (x.delta=1)=(p.intent->'payload'->>'liked')::boolean))
   OR (o.outcome='noop' AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.like_noop_observations x WHERE x.account_id=actor AND x.request_id=request
    AND x.subject_id::text=coalesce(p.intent->'payload'->>'replyId',p.intent->'payload'->>'rootId') AND x.revision::text=p.intent->'payload'->>'expectedLikeRevision' AND x.liked=(p.intent->'payload'->>'liked')::boolean))
  THEN RAISE EXCEPTION 'Scoped like differs from original exact subject/CAS/desired state' USING ERRCODE='23514';END IF;
 ELSIF q.operation='set_target_subscription_scoped' THEN
  IF (o.outcome='applied' AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.subscription_transitions x WHERE x.account_id=actor AND x.request_id=request AND x.target_id=p.target_id AND x.old_revision::text=p.intent->'payload'->>'expectedSubscriptionRevision' AND (x.delta=1)=(p.intent->'payload'->>'subscribed')::boolean))
   OR (o.outcome='noop' AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.subscription_noop_observations x WHERE x.account_id=actor AND x.request_id=request AND x.target_id=p.target_id AND x.revision::text=p.intent->'payload'->>'expectedSubscriptionRevision' AND x.subscribed=(p.intent->'payload'->>'subscribed')::boolean))
  THEN RAISE EXCEPTION 'Scoped subscription differs from exact original target/CAS/desired state' USING ERRCODE='23514';END IF;
 END IF;
 IF q.operation IN ('create_target_scoped','edit_target_scoped') THEN
  IF n<>0 OR EXISTS(SELECT 1 FROM whaleu_ratings.effect_events WHERE actor_account_id=actor AND request_id=request) THEN RAISE EXCEPTION 'Target definition cannot cause scalar/content rewards' USING ERRCODE='23514';END IF;
  IF q.operation='create_target_scoped' THEN
   IF o.outcome<>'applied' THEN RAISE EXCEPTION 'Scoped creation cannot noop' USING ERRCODE='23514';END IF;
   PERFORM whaleu_ratings.verify_scoped_target_initial(p.target_id);
   SELECT * INTO cause FROM whaleu_ratings.scoped_command_causes WHERE account_id=actor AND request_id=request AND cause_kind='catalog_release';
   IF NOT coalesce(cause.mutation_transaction=pg_current_xact_id() AND cause.proof->>'catalogId'=o.result->>'catalogRevision'
    AND EXISTS(SELECT 1 FROM whaleu_ratings.scoped_releases r JOIN whaleu_ratings.scoped_catalogs c ON c.release_id=r.id JOIN whaleu_ratings.scoped_catalog_heads h ON h.catalog_id=c.id
     WHERE r.id=cause.artifact_id AND r.cause_kind='create_target_scoped' AND r.cause->>'accountId'=actor::text AND r.cause->>'requestId'=request::text
     AND c.id::text=o.result->>'catalogRevision' AND h.head_revision=cause.artifact_revision AND EXISTS(SELECT 1 FROM whaleu_ratings.scoped_target_memberships m WHERE m.catalog_id=c.id AND m.target_id=p.target_id)),false)
   THEN RAISE EXCEPTION 'Scoped creation requires exact full after catalog' USING ERRCODE='23514';END IF;
  ELSIF o.outcome='applied' THEN PERFORM whaleu_ratings.verify_scoped_target_edit(actor,request);
  ELSE SELECT * INTO t FROM whaleu_ratings.targets WHERE id=p.target_id;
   IF NOT coalesce(t.active AND t.creator_id=actor AND t.revision::text=p.intent->'payload'->>'expectedTargetRevision'
    AND (p.intent->'protocolVersion'<>'3'::jsonb OR coalesce(p.before_state->'definition'->'envelope'->'cover','null'::jsonb)=p.envelope->'cover')
    AND p.before_state->>'name'=p.intent->'payload'->>'name' AND p.before_state->>'description'=p.intent->'payload'->>'description'
    AND o.result->>'revision'=t.revision::text AND o.result->>'definitionRevision'=p.intent->'payload'->>'expectedDefinitionRevision'
    AND o.result->'contentVersion'=p.intent->'payload'->'expectedContentVersion'
    AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.scoped_command_causes WHERE account_id=actor AND request_id=request AND cause_kind<>'execution'),false)
   THEN RAISE EXCEPTION 'Scoped edit noop must retain exact unchanged tuple' USING ERRCODE='23514';END IF;
  END IF;
 ELSE
  IF n<>(CASE WHEN o.outcome='applied' THEN 1 ELSE 0 END) THEN RAISE EXCEPTION 'Scoped scalar/content cardinality mismatch' USING ERRCODE='23514';END IF;
  IF q.operation='create_comment_scoped' THEN PERFORM whaleu_ratings.verify_scoped_content('comment',p.subject_id);
  ELSIF q.operation='create_reply_scoped' THEN PERFORM whaleu_ratings.verify_scoped_content('reply',p.subject_id);END IF;
 END IF;
END $$;

CREATE OR REPLACE FUNCTION whaleu_ratings.target_definition_version_guard() RETURNS trigger LANGUAGE plpgsql AS $dispatch$
BEGIN IF NEW.content_version>1 AND NEW.envelope->'version' IN ('5'::jsonb,'6'::jsonb) THEN
DECLARE p whaleu_ratings.scoped_command_preparations;t whaleu_ratings.targets;h whaleu_ratings.target_definition_heads;e whaleu_ratings.scoped_command_causes;BEGIN
 p:=whaleu_ratings.scoped_edit_preparation(NEW.target_id,NEW.applied_target_revision);
 SELECT * INTO t FROM whaleu_ratings.targets WHERE id=p.target_id FOR UPDATE NOWAIT;
 SELECT * INTO h FROM whaleu_ratings.target_definition_heads WHERE target_id=p.target_id FOR UPDATE NOWAIT;
 SELECT * INTO e FROM whaleu_ratings.scoped_command_causes WHERE account_id=p.account_id AND request_id=p.request_id AND cause_kind='target_edit';
 IF NOT coalesce(t.active AND t.creator_id=p.account_id AND t.revision::text=p.intent->'payload'->>'expectedTargetRevision'
 AND h.definition_revision::text=p.intent->'payload'->>'expectedDefinitionRevision' AND h.content_version=(p.intent->'payload'->>'expectedContentVersion')::integer
 AND (NEW.content_version,NEW.definition_revision,NEW.applied_target_revision,NEW.name,NEW.description,NEW.envelope,NEW.publication_transaction,NEW.published_at)
 =(p.content_version,p.definition_revision,p.target_revision,p.intent->'payload'->>'name',p.intent->'payload'->>'description',p.envelope,pg_current_xact_id(),(e.proof->>'occurredAt')::timestamptz)
 AND NEW.content_version=h.content_version+1 AND NEW.definition_revision<>h.definition_revision
 AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.target_owner_tombstones WHERE target_id=t.id),false)
 THEN RAISE EXCEPTION 'Scoped definition version has no exact predecessor/cause' USING ERRCODE='23514';END IF;RETURN NEW;END;
ELSE

DECLARE t whaleu_ratings.targets;e whaleu_ratings.target_edit_transitions;p whaleu_ratings.target_edit_preparations;h whaleu_ratings.target_definition_heads;
BEGIN
 SELECT * INTO t FROM whaleu_ratings.targets WHERE id=NEW.target_id FOR UPDATE NOWAIT;
 IF NEW.content_version=1 THEN
  IF NOT coalesce(pg_trigger_depth()>=2 AND t.id=NEW.target_id AND t.creation_transaction=pg_current_xact_id()
   AND (NEW.definition_revision,NEW.applied_target_revision,NEW.name,NEW.description,NEW.envelope,NEW.publication_transaction,NEW.published_at)
    =((t.envelope->>'targetRevision')::uuid,(t.envelope->>'targetRevision')::uuid,t.name,t.description,t.envelope,t.creation_transaction,t.created_at)
   AND t.revision::text=t.envelope->>'targetRevision' AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.target_definition_heads WHERE target_id=t.id),false)
  THEN RAISE EXCEPTION 'Initial target definition requires exact fresh target insertion' USING ERRCODE='23514';END IF;
 ELSE
  SELECT * INTO e FROM whaleu_ratings.target_edit_transitions WHERE target_id=NEW.target_id AND after_content_version=NEW.content_version;
  SELECT * INTO p FROM whaleu_ratings.target_edit_preparations WHERE account_id=e.actor_account_id AND request_id=e.request_id;
  SELECT * INTO h FROM whaleu_ratings.target_definition_heads WHERE target_id=NEW.target_id FOR UPDATE NOWAIT;
  IF NOT coalesce(e.id IS NOT NULL AND e.mutation_transaction=pg_current_xact_id() AND t.active AND t.creator_id=e.actor_account_id AND t.revision=e.before_revision
   AND (h.content_version,h.definition_revision)=(e.before_content_version,e.before_definition_revision)
   AND (NEW.definition_revision,NEW.applied_target_revision,NEW.name,NEW.description,NEW.envelope,NEW.publication_transaction,NEW.published_at)
    =(e.after_definition_revision,e.after_revision,p.intent->>'name',p.intent->>'description',p.envelope,e.mutation_transaction,e.occurred_at)
   AND whaleu_community.rating_envelope_shape(NEW.envelope,'edit_rating_target')
   AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.target_owner_tombstones WHERE target_id=t.id),false)
  THEN RAISE EXCEPTION 'Target definition version has no exact edit cause' USING ERRCODE='23514';END IF;
 END IF;RETURN NEW;
END;
END IF;END $dispatch$;

CREATE OR REPLACE FUNCTION whaleu_ratings.target_definition_head_guard() RETURNS trigger LANGUAGE plpgsql AS $dispatch$
BEGIN IF TG_OP='UPDATE' AND EXISTS(SELECT 1 FROM whaleu_ratings.target_definition_versions WHERE target_id=NEW.target_id AND content_version=NEW.content_version AND envelope->'version' IN ('5'::jsonb,'6'::jsonb)) THEN
DECLARE p whaleu_ratings.scoped_command_preparations;v whaleu_ratings.target_definition_versions;BEGIN
 SELECT * INTO v FROM whaleu_ratings.target_definition_versions WHERE target_id=NEW.target_id AND content_version=NEW.content_version;
 p:=whaleu_ratings.scoped_edit_preparation(NEW.target_id,v.applied_target_revision);
 IF NOT coalesce(NEW.target_id=OLD.target_id AND NEW.content_version=OLD.content_version+1 AND NEW.definition_revision<>OLD.definition_revision
 AND (NEW.content_version,NEW.definition_revision)=(p.content_version,p.definition_revision)
 AND OLD.definition_revision::text=p.intent->'payload'->>'expectedDefinitionRevision' AND OLD.content_version=(p.intent->'payload'->>'expectedContentVersion')::integer
 AND EXISTS(SELECT 1 FROM whaleu_ratings.targets t WHERE t.id=p.target_id AND t.active AND t.creator_id=p.account_id AND t.revision=p.target_revision)
 AND EXISTS(SELECT 1 FROM whaleu_ratings.target_definition_lifecycles l WHERE l.target_id=p.target_id AND l.target_revision=p.target_revision AND (l.content_version,l.definition_revision)=(p.content_version,p.definition_revision)),false)
 THEN RAISE EXCEPTION 'Scoped head must advance exactly caused version' USING ERRCODE='23514';END IF;RETURN NEW;END;
ELSE

DECLARE t whaleu_ratings.targets;v whaleu_ratings.target_definition_versions;e whaleu_ratings.target_edit_transitions;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Target definition head is retained' USING ERRCODE='23514';END IF;
 SELECT * INTO t FROM whaleu_ratings.targets WHERE id=NEW.target_id FOR UPDATE NOWAIT;
 SELECT * INTO v FROM whaleu_ratings.target_definition_versions WHERE target_id=NEW.target_id AND content_version=NEW.content_version AND definition_revision=NEW.definition_revision;
 IF TG_OP='INSERT' THEN
  IF NOT coalesce(pg_trigger_depth()>=2 AND NEW.content_version=1 AND v.publication_transaction=pg_current_xact_id()
   AND t.creation_transaction=v.publication_transaction AND t.revision=v.applied_target_revision AND NEW.definition_revision=v.applied_target_revision,false)
  THEN RAISE EXCEPTION 'Initial target definition head has no fresh target' USING ERRCODE='23514';END IF;
 ELSE
  SELECT * INTO e FROM whaleu_ratings.target_edit_transitions WHERE target_id=NEW.target_id AND after_content_version=NEW.content_version;
  IF NOT coalesce(NEW.target_id=OLD.target_id AND OLD.content_version<2147483647 AND NEW.content_version=OLD.content_version+1
   AND NEW.definition_revision<>OLD.definition_revision AND e.id IS NOT NULL AND e.mutation_transaction=pg_current_xact_id()
   AND (OLD.content_version,OLD.definition_revision)=(e.before_content_version,e.before_definition_revision)
   AND (NEW.content_version,NEW.definition_revision)=(e.after_content_version,e.after_definition_revision)
   AND t.active AND t.creator_id=e.actor_account_id AND t.revision=e.after_revision AND v.applied_target_revision=e.after_revision
   AND EXISTS(SELECT 1 FROM whaleu_ratings.target_definition_lifecycles l WHERE l.target_id=t.id AND l.target_revision=t.revision AND (l.content_version,l.definition_revision)=(NEW.content_version,NEW.definition_revision))
   AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.target_owner_tombstones WHERE target_id=t.id),false)
  THEN RAISE EXCEPTION 'Target definition head must advance exactly one caused version' USING ERRCODE='23514';END IF;
 END IF;RETURN NEW;
END;
END IF;END $dispatch$;

CREATE OR REPLACE FUNCTION whaleu_ratings.target_definition_artifact_causal() RETURNS trigger LANGUAGE plpgsql AS $dispatch$
BEGIN IF TG_TABLE_NAME IN ('target_definition_versions','target_definition_heads') AND (to_jsonb(NEW)->>'content_version')::integer>1 AND EXISTS(SELECT 1 FROM whaleu_ratings.target_definition_versions WHERE target_id=(to_jsonb(NEW)->>'target_id')::uuid AND content_version=(to_jsonb(NEW)->>'content_version')::integer AND envelope->'version' IN ('5'::jsonb,'6'::jsonb)) THEN
DECLARE p whaleu_ratings.scoped_command_preparations;v whaleu_ratings.target_definition_versions;BEGIN
 SELECT * INTO v FROM whaleu_ratings.target_definition_versions WHERE target_id=NEW.target_id AND content_version=NEW.content_version;
 p:=whaleu_ratings.scoped_edit_preparation(NEW.target_id,v.applied_target_revision);
 IF TG_TABLE_NAME='target_definition_heads' AND TG_OP='UPDATE' AND (OLD.definition_revision::text,OLD.content_version) IS DISTINCT FROM (p.intent->'payload'->>'expectedDefinitionRevision',(p.intent->'payload'->>'expectedContentVersion')::integer)
 THEN RAISE EXCEPTION 'Scoped definition artifact predecessor mismatch' USING ERRCODE='23514';END IF;
 PERFORM whaleu_ratings.verify_scoped_target_edit(p.account_id,p.request_id);RETURN NULL;END;
ELSE

DECLARE e whaleu_ratings.target_edit_transitions;v whaleu_ratings.target_definition_versions;
BEGIN
 IF TG_TABLE_NAME='target_definition_lifecycles' THEN
  PERFORM whaleu_ratings.verify_target_definition_lifecycle(NEW.target_id,NEW.target_revision);RETURN NULL;
 ELSIF TG_TABLE_NAME='target_state_revisions' THEN
  PERFORM whaleu_ratings.verify_target_definition_lifecycle(NEW.target_id,NEW.revision);RETURN NULL;
 END IF;
 IF NEW.content_version=1 THEN
  PERFORM whaleu_ratings.verify_target_definition_initial(NEW.target_id);RETURN NULL;
 END IF;
 SELECT * INTO e FROM whaleu_ratings.target_edit_transitions WHERE target_id=NEW.target_id AND after_content_version=NEW.content_version;
 SELECT * INTO v FROM whaleu_ratings.target_definition_versions WHERE target_id=NEW.target_id AND content_version=NEW.content_version;
 IF NOT coalesce(e.id IS NOT NULL AND e.mutation_transaction=pg_current_xact_id()
  AND NEW.definition_revision=e.after_definition_revision AND v.definition_revision=e.after_definition_revision
  AND v.applied_target_revision=e.after_revision AND v.publication_transaction=e.mutation_transaction,false)
 THEN RAISE EXCEPTION 'Target definition artifact has no exact fresh edit' USING ERRCODE='23514';END IF;
 IF TG_TABLE_NAME='target_definition_heads' AND TG_OP='UPDATE' THEN
  IF (OLD.target_id,OLD.content_version,OLD.definition_revision) IS DISTINCT FROM (e.target_id,e.before_content_version,e.before_definition_revision)
  THEN RAISE EXCEPTION 'Target definition head predecessor mismatch' USING ERRCODE='23514';END IF;
 END IF;
 PERFORM whaleu_ratings.verify_target_edit(e.actor_account_id,e.request_id);RETURN NULL;
END;
END IF;END $dispatch$;

CREATE OR REPLACE FUNCTION whaleu_ratings.require_review_binding() RETURNS trigger LANGUAGE plpgsql AS $dispatch$
BEGIN IF TG_TABLE_SCHEMA='whaleu_ratings' AND NEW.envelope->'version' IN ('5'::jsonb,'6'::jsonb) THEN
BEGIN
 IF TG_TABLE_NAME='targets' THEN PERFORM whaleu_ratings.verify_scoped_target_initial(NEW.id);
 ELSE PERFORM whaleu_ratings.verify_scoped_content(CASE TG_TABLE_NAME WHEN 'replies' THEN 'reply' ELSE 'comment' END,NEW.id);END IF;
 RETURN NULL;END;
ELSE

DECLARE requested_kind text;subject uuid;definition jsonb;publication xid8;b whaleu_community.rating_approval_bindings;t whaleu_ratings.targets;c whaleu_ratings.comments;category whaleu_ratings.categories;r whaleu_ratings.replies;parent whaleu_ratings.comments;direct whaleu_ratings.replies;
BEGIN
 IF TG_TABLE_SCHEMA='whaleu_community' THEN requested_kind:=NEW.kind;subject:=NEW.subject_id;ELSE requested_kind:=CASE TG_TABLE_NAME WHEN 'targets' THEN 'target' WHEN 'replies' THEN 'reply' ELSE 'comment' END;subject:=NEW.id;END IF;
 IF requested_kind='target' THEN
 SELECT * INTO t FROM whaleu_ratings.targets WHERE id=subject;definition:=t.envelope;publication:=t.creation_transaction;
 IF NOT coalesce(t.id IS NOT NULL AND definition->>'accountId'=t.creator_id::text AND definition->>'purpose'='publish_rating_target' AND definition->>'targetId'=t.id::text AND definition->>'targetRevision'=t.revision::text AND definition->>'categoryId'=t.category_id::text AND definition->>'name'=t.name AND definition->>'description'=t.description AND (definition->'scope'->>'regionId') IS NOT DISTINCT FROM t.region_id::text,false) THEN RAISE EXCEPTION 'Target definition mismatch' USING ERRCODE='23514';END IF;
 ELSIF requested_kind='reply' THEN
 SELECT * INTO r FROM whaleu_ratings.replies WHERE id=subject;definition:=r.envelope;publication:=r.publication_transaction;
 SELECT * INTO t FROM whaleu_ratings.targets WHERE id=r.target_id;
 SELECT * INTO parent FROM whaleu_ratings.comments WHERE id=r.root_id AND target_id=r.target_id;
 IF NOT coalesce(r.id IS NOT NULL AND definition->>'accountId'=r.account_id::text AND definition->>'purpose'='publish_rating_reply' AND definition->>'targetId'=r.target_id::text AND definition->>'targetRevision'=t.revision::text AND definition->>'rootId'=r.root_id::text AND definition->>'rootRevision'=parent.revision::text AND parent.deleted_at IS NULL AND t.active AND definition->>'categoryId'=t.category_id::text AND definition->>'clientRequestId'=r.request_id::text AND definition->>'authorMode'=r.author_mode AND definition->>'body'=r.body,false) THEN RAISE EXCEPTION 'Reply definition mismatch' USING ERRCODE='23514';END IF;
 IF r.reply_to_id IS NULL THEN IF definition->'replyTo' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'Reply root binding mismatch' USING ERRCODE='23514';END IF;
 ELSE SELECT * INTO direct FROM whaleu_ratings.replies WHERE id=r.reply_to_id AND root_id=r.root_id AND target_id=r.target_id;
 IF direct.id IS NULL OR direct.deleted_at IS NOT NULL OR definition->'replyTo' IS DISTINCT FROM jsonb_build_object('replyId',direct.id,'revision',direct.revision) THEN RAISE EXCEPTION 'Reply direct binding mismatch' USING ERRCODE='23514';END IF;END IF;
 ELSE
 SELECT * INTO c FROM whaleu_ratings.comments WHERE id=subject;definition:=c.envelope;publication:=c.publication_transaction;SELECT * INTO t FROM whaleu_ratings.targets WHERE id=c.target_id;
 IF NOT coalesce(c.id IS NOT NULL AND definition->>'accountId'=c.account_id::text AND definition->>'purpose'='publish_rating_comment' AND definition->>'targetId'=c.target_id::text AND definition->>'targetRevision'=t.revision::text AND definition->>'categoryId'=t.category_id::text AND t.active AND definition->>'clientRequestId'=c.request_id::text AND definition->>'authorMode'=c.author_mode AND definition->>'body'=c.body,false) THEN RAISE EXCEPTION 'Comment definition mismatch' USING ERRCODE='23514';END IF;
 END IF;
 SELECT * INTO b FROM whaleu_community.rating_approval_bindings WHERE kind=requested_kind AND subject_id=subject;
 IF b.subject_id IS NULL OR b.envelope IS DISTINCT FROM definition OR b.publication_transaction IS DISTINCT FROM publication OR publication<>pg_current_xact_id() OR b.content_version<>1 OR definition->'assetIds' IS DISTINCT FROM '[]'::jsonb THEN RAISE EXCEPTION 'Exact same-transaction review binding required' USING ERRCODE='23514';END IF;
 SELECT * INTO category FROM whaleu_ratings.categories WHERE catalog_id=(definition->>'catalogRevision')::uuid AND id=(definition->>'categoryId')::uuid;
 IF category.id IS NULL OR category.revision::text<>definition->>'categoryRevision' THEN RAISE EXCEPTION 'Category review mismatch' USING ERRCODE='23514';END IF;RETURN NULL;
END;
END IF;END $dispatch$;

CREATE OR REPLACE FUNCTION whaleu_ratings.verify_target_definition_initial(target uuid) RETURNS void LANGUAGE plpgsql AS $dispatch$
BEGIN IF EXISTS(SELECT 1 FROM whaleu_ratings.targets WHERE id=target AND envelope->'version' IN ('5'::jsonb,'6'::jsonb)) THEN
BEGIN PERFORM whaleu_ratings.verify_scoped_target_initial(target);RETURN;END;
ELSE

DECLARE t whaleu_ratings.targets;v whaleu_ratings.target_definition_versions;h whaleu_ratings.target_definition_heads;
 l whaleu_ratings.target_definition_lifecycles;b whaleu_community.rating_approval_bindings;
BEGIN
 SELECT * INTO t FROM whaleu_ratings.targets WHERE id=target;
 SELECT * INTO v FROM whaleu_ratings.target_definition_versions WHERE target_id=target AND content_version=1;
 SELECT * INTO h FROM whaleu_ratings.target_definition_heads WHERE target_id=target;
 SELECT * INTO l FROM whaleu_ratings.target_definition_lifecycles WHERE target_id=target AND target_revision=t.revision;
 SELECT * INTO b FROM whaleu_community.rating_approval_bindings WHERE kind='target' AND subject_id=target;
 IF NOT coalesce(t.id=target AND t.creation_transaction=pg_current_xact_id()
  AND (v.definition_revision,v.applied_target_revision,v.name,v.description,v.envelope,v.publication_transaction,v.published_at)
   =((t.envelope->>'targetRevision')::uuid,(t.envelope->>'targetRevision')::uuid,t.name,t.description,t.envelope,t.creation_transaction,t.created_at)
  AND t.revision=v.applied_target_revision AND (h.content_version,h.definition_revision)=(1,v.definition_revision)
  AND (l.content_version,l.definition_revision)=(1,v.definition_revision)
  AND EXISTS(SELECT 1 FROM whaleu_ratings.target_state_revisions s WHERE s.target_id=target AND s.revision=t.revision AND s.active=t.active AND s.mutation_transaction=t.creation_transaction)
  AND (b.content_version,b.account_id,b.envelope,b.publication_transaction)=(1,t.creator_id,t.envelope,t.creation_transaction),false)
 THEN RAISE EXCEPTION 'Initial target definition/head/state/binding reverse link incomplete' USING ERRCODE='23514';END IF;
END;
END IF;END $dispatch$;

CREATE OR REPLACE FUNCTION whaleu_ratings.verify_scoped_target_initial(target uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE t whaleu_ratings.targets;p whaleu_ratings.scoped_command_preparations;e whaleu_ratings.scoped_command_causes;v whaleu_ratings.target_definition_versions;
 b whaleu_community.rating_scoped_target_definition_bindings;s whaleu_ratings.target_sources;o whaleu_ratings.target_origin_sources;policy whaleu_ratings.scoped_source_attestations;
BEGIN
 SELECT * INTO t FROM whaleu_ratings.targets WHERE id=target;
 SELECT * INTO p FROM whaleu_ratings.scoped_command_preparations WHERE account_id=t.creator_id AND request_id=(t.envelope->>'clientRequestId')::uuid;
 SELECT * INTO e FROM whaleu_ratings.scoped_command_causes WHERE account_id=p.account_id AND request_id=p.request_id AND cause_kind='target_initial';
 SELECT * INTO v FROM whaleu_ratings.target_definition_versions WHERE target_id=target AND content_version=1;
 IF p.envelope->'version'='6'::jsonb THEN SELECT * INTO b FROM whaleu_community.rating_target_cover_definition_bindings WHERE target_id=target AND content_version=1; ELSE SELECT * INTO b FROM whaleu_community.rating_scoped_target_definition_bindings WHERE target_id=target AND content_version=1; END IF;
 SELECT * INTO s FROM whaleu_ratings.target_sources WHERE id=t.source_id;
 SELECT src.* INTO o FROM whaleu_ratings.target_origin_sources src JOIN whaleu_ratings.target_origin_heads h ON h.source_id=src.id WHERE h.target_id=target;
 SELECT policy_source.* INTO policy FROM whaleu_ratings.scoped_source_attestations policy_source WHERE policy_source.id=p.policy_source_id AND policy_source.revision=p.policy_source_revision;
 IF NOT coalesce(p.operation='create_target_scoped' AND t.id=p.target_id AND t.revision=p.target_revision AND t.creation_transaction=pg_current_xact_id()
 AND t.category_id::text=p.intent->'payload'->>'categoryId' AND t.name=p.intent->'payload'->>'name' AND t.description=p.intent->'payload'->>'description' AND t.envelope=p.envelope
 AND t.region_id::text IS NOT DISTINCT FROM p.envelope->'targetOrigin'->>'regionId'
 AND e.artifact_id=t.id AND e.artifact_revision=t.revision AND e.mutation_transaction=t.creation_transaction AND (e.proof->>'occurredAt')::timestamptz=t.created_at
 AND (v.definition_revision,v.applied_target_revision,v.name,v.description,v.envelope,v.publication_transaction,v.published_at)=(p.definition_revision,p.target_revision,t.name,t.description,t.envelope,t.creation_transaction,t.created_at)
 AND (b.content_version,b.definition_revision,b.applied_target_revision,b.account_id,b.envelope,b.publication_transaction)=(1,p.definition_revision,p.target_revision,t.creator_id,t.envelope,t.creation_transaction)
 AND whaleu_community.rating_target_definition_current(target,1,p.definition_revision,p.target_revision,t.envelope)
 AND s.id::text=e.proof->>'sourceId' AND s.target_id=t.id AND s.origin='new_native' AND s.coverage='complete' AND s.provenance='accepted'
 AND s.source_reference='rating-scoped-create:'||p.account_id::text||':'||p.request_id::text AND s.policy_reference=policy.policy_reference AND s.effective_at=t.created_at
 AND policy.source_kind='native_scoped_create' AND policy.payload->'enabled'='true'::jsonb AND whaleu_ratings.scoped_source_current(policy.id,policy.revision,clock_timestamp())
 AND EXISTS(SELECT 1 FROM whaleu_ratings.score_baselines sb WHERE sb.target_id=t.id AND sb.id::text=e.proof->>'baselineId' AND sb.kind='fresh_zero' AND sb.source_id=s.id AND sb.source_reference=s.source_reference AND sb.policy_reference=s.policy_reference)
 AND o.id::text=e.proof->>'originId' AND o.target_id=t.id AND o.origin_campus_id::text IS NOT DISTINCT FROM p.envelope->'targetOrigin'->>'originCampusId'
 AND o.source_reference=s.source_reference AND o.policy_reference=s.policy_reference AND NOT o.revoked
 AND EXISTS(SELECT 1 FROM whaleu_ratings.target_definition_heads h WHERE h.target_id=t.id AND (h.content_version,h.definition_revision)=(1,p.definition_revision))
 AND EXISTS(SELECT 1 FROM whaleu_ratings.target_definition_lifecycles l WHERE l.target_id=t.id AND l.target_revision=t.revision AND (l.content_version,l.definition_revision)=(1,p.definition_revision)),false)
 THEN RAISE EXCEPTION 'Scoped initial target/source/baseline/origin/Review chain incomplete' USING ERRCODE='23514';END IF;
 PERFORM whaleu_ratings.scoped_domain_request(p.account_id,p.request_id);
END $$;

CREATE OR REPLACE FUNCTION whaleu_ratings.verify_scoped_target_edit(actor uuid,request uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE p whaleu_ratings.scoped_command_preparations;t whaleu_ratings.targets;v whaleu_ratings.target_definition_versions;e whaleu_ratings.scoped_command_causes;b whaleu_community.rating_scoped_target_definition_bindings;
BEGIN
 SELECT * INTO p FROM whaleu_ratings.scoped_command_preparations WHERE account_id=actor AND request_id=request;
 SELECT * INTO e FROM whaleu_ratings.scoped_command_causes WHERE account_id=actor AND request_id=request AND cause_kind='target_edit';
 SELECT * INTO t FROM whaleu_ratings.targets WHERE id=p.target_id;
 SELECT * INTO v FROM whaleu_ratings.target_definition_versions WHERE target_id=t.id AND content_version=p.content_version;
 IF p.envelope->'version'='6'::jsonb THEN SELECT * INTO b FROM whaleu_community.rating_target_cover_definition_bindings WHERE target_id=t.id AND content_version=p.content_version; ELSE SELECT * INTO b FROM whaleu_community.rating_scoped_target_definition_bindings WHERE target_id=t.id AND content_version=p.content_version; END IF;
 IF NOT coalesce(p.operation='edit_target_scoped' AND t.creator_id=actor AND t.active AND t.revision=p.target_revision AND e.artifact_id=t.id AND e.artifact_revision=t.revision AND e.mutation_transaction=pg_current_xact_id()
 AND (v.definition_revision,v.applied_target_revision,v.name,v.description,v.envelope,v.publication_transaction,v.published_at)=(p.definition_revision,p.target_revision,p.intent->'payload'->>'name',p.intent->'payload'->>'description',p.envelope,e.mutation_transaction,(e.proof->>'occurredAt')::timestamptz)
 AND (b.definition_revision,b.applied_target_revision,b.account_id,b.envelope,b.publication_transaction)=(p.definition_revision,p.target_revision,actor,p.envelope,e.mutation_transaction)
 AND whaleu_community.rating_target_definition_current(t.id,p.content_version,p.definition_revision,p.target_revision,p.envelope)
 AND EXISTS(SELECT 1 FROM whaleu_ratings.target_definition_versions old WHERE old.target_id=t.id AND old.content_version=p.content_version-1 AND old.definition_revision::text=p.intent->'payload'->>'expectedDefinitionRevision')
 AND EXISTS(SELECT 1 FROM whaleu_ratings.target_definition_heads h WHERE h.target_id=t.id AND (h.content_version,h.definition_revision)=(p.content_version,p.definition_revision))
 AND EXISTS(SELECT 1 FROM whaleu_ratings.target_definition_lifecycles l WHERE l.target_id=t.id AND l.target_revision=t.revision AND (l.content_version,l.definition_revision)=(p.content_version,p.definition_revision))
 AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.target_owner_tombstones WHERE target_id=t.id),false)
 THEN RAISE EXCEPTION 'Scoped edit/definition/Review/head chain incomplete' USING ERRCODE='23514';END IF;
 PERFORM whaleu_ratings.scoped_domain_request(actor,request);
END $$;


DO $$ DECLARE definition text;BEGIN SELECT pg_get_functiondef('whaleu_community.rating_target_definition_current(uuid,integer,uuid,uuid,jsonb)'::regprocedure) INTO definition;EXECUTE replace(definition,'FUNCTION whaleu_community.rating_target_definition_current(', 'FUNCTION whaleu_community.rating_target_definition_current_pre_target_cover(');END $$;
CREATE OR REPLACE FUNCTION whaleu_community.rating_target_definition_current(_target uuid,_content_version integer,_definition_revision uuid,_applied_target_revision uuid,_envelope jsonb) RETURNS boolean LANGUAGE sql AS $$
 SELECT CASE WHEN _envelope->'version'='6'::jsonb THEN whaleu_community.rating_target_cover_definition_current(_target,_content_version,_definition_revision,_applied_target_revision,_envelope) ELSE whaleu_community.rating_target_definition_current_pre_target_cover(_target,_content_version,_definition_revision,_applied_target_revision,_envelope) END
$$;


-- New-command guards qualify a whole current definition, never only its body.
CREATE FUNCTION whaleu_ratings.target_cover_preparation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cover jsonb;old jsonb;scope whaleu_ratings.target_cover_upload_scopes;a whaleu_media.assets;BEGIN
 IF (SELECT context->'protocolVersion' FROM whaleu_ratings.scoped_contexts WHERE id=NEW.context_id) IS DISTINCT FROM NEW.intent->'protocolVersion' THEN RAISE EXCEPTION 'Scoped command/context protocol mismatch' USING ERRCODE='23514';END IF;
 IF NEW.intent->'protocolVersion'<>'3'::jsonb THEN
  IF NEW.operation='edit_target_scoped' AND EXISTS(SELECT 1 FROM whaleu_ratings.target_definition_heads h JOIN whaleu_ratings.target_definition_versions d USING(target_id,content_version,definition_revision) WHERE h.target_id=NEW.target_id AND d.envelope->'version'='6'::jsonb)
  THEN RAISE EXCEPTION 'Fresh legacy edit cannot reinterpret an exact cover definition' USING ERRCODE='23514';END IF;RETURN NEW;
 END IF;
 IF NOT whaleu_ratings.target_cover_context_current(NEW.context_id,clock_timestamp()) OR NOT whaleu_community.rating_target_cover_envelope_shape(NEW.envelope,NEW.envelope->>'purpose') THEN RAISE EXCEPTION 'Target cover capability or exact Review absent' USING ERRCODE='23514';END IF;
 cover:=NEW.intent->'payload'->'cover';
 SELECT coalesce(d.envelope->'cover','null'::jsonb) INTO old FROM whaleu_ratings.target_definition_heads h JOIN whaleu_ratings.target_definition_versions d USING(target_id,content_version,definition_revision) WHERE h.target_id=NEW.target_id;
 old:=coalesce(old,'null'::jsonb);
 IF cover->>'action'='keep' THEN
  IF NEW.operation<>'edit_target_scoped' OR NEW.envelope->'cover' IS DISTINCT FROM old THEN RAISE EXCEPTION 'Keep requires the exact current appearance' USING ERRCODE='23514';END IF;
 ELSIF cover->>'action'='clear' THEN
  IF NEW.envelope->'cover' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'Clear requires explicit null exact content' USING ERRCODE='23514';END IF;
 ELSE
  SELECT * INTO scope FROM whaleu_ratings.target_cover_upload_scopes WHERE id=(cover->>'uploadScopeId')::uuid;
  SELECT * INTO a FROM whaleu_media.assets WHERE id=(cover->>'assetId')::uuid;
  IF NOT coalesce(scope.actor_id=NEW.account_id AND scope.command_request_id=NEW.request_id AND scope.target_id=NEW.target_id AND scope.category_id::text=NEW.intent->'payload'->>'categoryId'
   AND scope.context_id=NEW.context_id AND scope.context_revision=NEW.intent->'context'->>'scopeRevision' AND whaleu_ratings.target_cover_upload_scope_current(scope.id,clock_timestamp())
   AND a.actor_id=NEW.account_id AND a.resource_id=scope.id AND a.scope_revision=scope.scope_revision AND a.owner_kind='ratings' AND a.resource_kind='target_cover' AND a.slot='cover' AND a.ordinal=0
   AND NEW.envelope->'cover'->>'assetId'=a.id::text AND NEW.envelope->'cover'->>'manifestDigest'=a.manifest_digest
   AND NOT EXISTS(SELECT 1 FROM whaleu_media.bindings WHERE asset_id=a.id),false)
  THEN RAISE EXCEPTION 'Replace requires exact unbound ready scope asset' USING ERRCODE='23514';END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER target_cover_preparation_guard BEFORE INSERT ON whaleu_ratings.scoped_command_preparations FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.target_cover_preparation_guard();
CREATE FUNCTION whaleu_ratings.verify_target_cover_definition(target uuid,version integer) RETURNS void LANGUAGE plpgsql AS $$
DECLARE d whaleu_ratings.target_definition_versions;p whaleu_ratings.scoped_command_preparations;a whaleu_ratings.target_cover_appearances;old jsonb;b whaleu_media.bindings;BEGIN
 SELECT * INTO d FROM whaleu_ratings.target_definition_versions WHERE target_id=target AND content_version=version;
 IF d.envelope->'version'<>'6'::jsonb THEN RETURN;END IF;
 SELECT * INTO p FROM whaleu_ratings.scoped_command_preparations WHERE account_id=(d.envelope->>'accountId')::uuid AND request_id=(d.envelope->>'clientRequestId')::uuid;
 IF p.intent->'protocolVersion' IS DISTINCT FROM '3'::jsonb OR p.envelope IS DISTINCT FROM d.envelope OR NOT whaleu_ratings.target_cover_context_current(p.context_id,clock_timestamp())
  OR NOT whaleu_community.rating_target_cover_definition_current(target,version,d.definition_revision,d.applied_target_revision,d.envelope)
 THEN RAISE EXCEPTION 'Cover definition requires complete exact new protocol chain' USING ERRCODE='23514';END IF;
 IF d.envelope->'cover'<>'null'::jsonb THEN
  SELECT * INTO a FROM whaleu_ratings.target_cover_appearances WHERE id=(d.envelope->'cover'->>'appearanceId')::uuid;
  SELECT * INTO b FROM whaleu_media.bindings WHERE id=a.media_binding_id;
  IF NOT coalesce(a.target_id=target AND a.actor_id=p.account_id AND a.asset_id::text=d.envelope->'cover'->>'assetId' AND a.manifest_digest=d.envelope->'cover'->>'manifestDigest'
   AND b.owner_kind='ratings' AND b.resource_kind='target_cover' AND b.resource_id=a.id AND b.asset_id=a.asset_id AND b.manifest_digest=a.manifest_digest
   AND b.slot='cover' AND b.ordinal=0 AND b.content_version=1 AND b.detached_at IS NULL
   AND (p.intent->'payload'->'cover'->>'action'='keep' OR a.publication_transaction=pg_current_xact_id()),false)
  THEN RAISE EXCEPTION 'Cover appearance and atomic Media binding differ' USING ERRCODE='23514';END IF;
 END IF;
 IF version>1 THEN
  SELECT coalesce(envelope->'cover','null'::jsonb) INTO old FROM whaleu_ratings.target_definition_versions WHERE target_id=target AND content_version=version-1;
  IF old<>'null'::jsonb AND old IS DISTINCT FROM d.envelope->'cover' AND EXISTS(SELECT 1 FROM whaleu_media.bindings WHERE owner_kind='ratings' AND resource_kind='target_cover' AND resource_id=(old->>'appearanceId')::uuid AND detached_at IS NULL)
  THEN RAISE EXCEPTION 'Replacement or clear must detach the original appearance atomically' USING ERRCODE='23514';END IF;
 END IF;
END $$;
CREATE FUNCTION whaleu_ratings.target_cover_definition_causal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid;version integer;BEGIN
 IF TG_TABLE_NAME='target_cover_appearances' THEN
  IF NOT EXISTS(SELECT 1 FROM whaleu_ratings.target_definition_versions d JOIN whaleu_ratings.scoped_command_preparations p ON p.target_id=d.target_id AND p.content_version=d.content_version AND p.envelope=d.envelope
   WHERE d.target_id=NEW.target_id AND d.envelope->'version'='6'::jsonb AND d.envelope->'cover'->>'appearanceId'=NEW.id::text
   AND p.intent->'payload'->'cover'->>'action'='replace' AND d.publication_transaction=pg_current_xact_id() AND NEW.publication_transaction=pg_current_xact_id())
  THEN RAISE EXCEPTION 'Unreferenced cover appearance has no original replacement cause' USING ERRCODE='23514';END IF;
  SELECT d.target_id,d.content_version INTO target,version FROM whaleu_ratings.target_definition_versions d WHERE d.target_id=NEW.target_id AND d.envelope->'cover'->>'appearanceId'=NEW.id::text AND d.publication_transaction=pg_current_xact_id();
 ELSE target:=NEW.target_id;version:=NEW.content_version;END IF;
 PERFORM whaleu_ratings.verify_target_cover_definition(target,version);RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER cover_definition_causal AFTER INSERT ON whaleu_ratings.target_definition_versions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.envelope->'version'='6'::jsonb) EXECUTE FUNCTION whaleu_ratings.target_cover_definition_causal();
CREATE CONSTRAINT TRIGGER cover_review_reverse AFTER INSERT ON whaleu_community.rating_target_cover_definition_bindings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.target_cover_definition_causal();
CREATE CONSTRAINT TRIGGER cover_appearance_reverse AFTER INSERT ON whaleu_ratings.target_cover_appearances DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.target_cover_definition_causal();

-- Deletion immediately gates reads through the existing owner tombstone. This
-- bounded durable enumeration is separate from physical Media garbage collection.
CREATE TABLE whaleu_ratings.target_cover_cleanup(
 target_id uuid PRIMARY KEY REFERENCES whaleu_ratings.target_owner_tombstones(target_id),
 after_appearance_id uuid,phase text NOT NULL DEFAULT 'pending' CHECK(phase IN ('pending','complete')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),completed_at timestamptz,
 CHECK((phase='complete')=(completed_at IS NOT NULL))
);
CREATE FUNCTION whaleu_ratings.enqueue_target_cover_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 -- Immutable history, not the current definition or readable Review/Media,
 -- determines whether this tombstone has any cleanup work. Cleared/replaced
 -- appearances remain eligible; a never-covered legacy target has no side effect.
 INSERT INTO whaleu_ratings.target_cover_cleanup(target_id)
 SELECT NEW.target_id WHERE EXISTS(SELECT 1 FROM whaleu_ratings.target_cover_appearances a WHERE a.target_id=NEW.target_id)
 ON CONFLICT DO NOTHING;RETURN NULL;END $$;
CREATE TRIGGER target_cover_cleanup_enqueue AFTER INSERT ON whaleu_ratings.target_owner_tombstones FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.enqueue_target_cover_cleanup();
INSERT INTO whaleu_ratings.target_cover_cleanup(target_id)
SELECT t.target_id FROM whaleu_ratings.target_owner_tombstones t
WHERE EXISTS(SELECT 1 FROM whaleu_ratings.target_cover_appearances a WHERE a.target_id=t.target_id);
CREATE FUNCTION whaleu_ratings.target_cover_cleanup_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' OR OLD.phase='complete' OR NEW.target_id<>OLD.target_id OR NEW.created_at<>OLD.created_at
 OR (OLD.after_appearance_id IS NOT NULL AND (NEW.after_appearance_id IS NULL OR NEW.after_appearance_id<OLD.after_appearance_id))
 OR EXISTS(SELECT 1 FROM whaleu_ratings.target_cover_appearances a JOIN whaleu_media.bindings b ON b.id=a.media_binding_id WHERE a.target_id=NEW.target_id AND b.detached_at IS NULL AND (NEW.phase='complete' OR a.id<=NEW.after_appearance_id))
 THEN RAISE EXCEPTION 'Cleanup cursor cannot skip live bindings or rewrite completion' USING ERRCODE='23514';END IF;RETURN NEW;END $$;
CREATE TRIGGER target_cover_cleanup_guard BEFORE UPDATE OR DELETE ON whaleu_ratings.target_cover_cleanup FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.target_cover_cleanup_guard();
CREATE TRIGGER target_cover_cleanup_retain BEFORE TRUNCATE ON whaleu_ratings.target_cover_cleanup FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.immutable();
CREATE TRIGGER a00_cover_upload_scope_writer BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_ratings.target_cover_upload_scopes FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.scoped_public_writer_gate();
CREATE TRIGGER a01_cover_upload_scope_epoch BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_ratings.target_cover_upload_scopes FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.advance_scoped_source_epoch();
CREATE FUNCTION whaleu_ratings.target_cover_legacy_edit_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM whaleu_ratings.target_definition_heads h JOIN whaleu_ratings.target_definition_versions d USING(target_id,content_version,definition_revision) WHERE h.target_id=(NEW.intent->>'targetId')::uuid AND d.envelope->'version'='6'::jsonb)
 THEN RAISE EXCEPTION 'Legacy fresh edit cannot clear or omit a cover definition' USING ERRCODE='23514';END IF;RETURN NEW;END $$;
CREATE TRIGGER target_cover_legacy_edit_guard BEFORE INSERT ON whaleu_ratings.target_edit_preparations FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.target_cover_legacy_edit_guard();
CREATE FUNCTION whaleu_ratings.target_cover_upload_scope_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE i jsonb:=NEW.input;c whaleu_ratings.scoped_contexts;shape jsonb;expected_hash text;BEGIN
 IF NOT whaleu_community.rating_scoped_keys(i,ARRAY['protocolVersion','context','clientRequestId','commandRequestId','draftRevision','categoryId','expectedCategoryRevision','target','declaration'])
 OR i->'protocolVersion'<>'3'::jsonb OR NOT whaleu_community.rating_scoped_ids(i,ARRAY['clientRequestId','commandRequestId','draftRevision','categoryId','expectedCategoryRevision'])
 OR NOT whaleu_community.rating_scoped_keys(i->'declaration',ARRAY['mime','bytes','sha256']) OR i->'declaration'->>'mime' NOT IN ('image/jpeg','image/png')
 OR NOT whaleu_community.rating_scoped_integer(i->'declaration'->'bytes',1) OR (i->'declaration'->>'bytes')::integer>5242880 OR i->'declaration'->>'sha256' !~ '^[a-f0-9]{64}$'
 OR (i->'target'<>'null'::jsonb AND (NOT whaleu_community.rating_scoped_keys(i->'target',ARRAY['targetId','expectedTargetRevision','expectedDefinitionRevision','expectedContentVersion']) OR NOT whaleu_community.rating_scoped_ids(i->'target',ARRAY['targetId','expectedTargetRevision','expectedDefinitionRevision']) OR NOT whaleu_community.rating_scoped_integer(i->'target'->'expectedContentVersion',1) OR (i->'target'->>'expectedContentVersion')::integer>2147483646))
 THEN RAISE EXCEPTION 'Invalid exact cover upload scope input' USING ERRCODE='23514';END IF;
 shape:=jsonb_build_object('protocolVersion',2,'operation',CASE WHEN i->'target'='null'::jsonb THEN 'create_target_scoped' ELSE 'edit_target_scoped' END,'context',i->'context','payload',jsonb_build_object('clientRequestId',i->'commandRequestId','categoryId',i->'categoryId','expectedCategoryRevision',i->'expectedCategoryRevision','name','upload scope','description','','assetIds','[]'::jsonb)||CASE WHEN i->'target'='null'::jsonb THEN '{}'::jsonb ELSE i->'target' END);
 SELECT * INTO c FROM whaleu_ratings.scoped_contexts WHERE id=NEW.context_id;
 expected_hash:=encode(sha256(convert_to('whaleu:rating-target-cover-upload-scope:v1'||chr(10)||NEW.actor_id::text||chr(10)||whaleu_ratings.creation_canonical_json(i),'UTF8')),'hex');
 IF NOT coalesce(whaleu_ratings.scoped_intent_valid_pre_target_cover(shape) AND c.account_id=NEW.actor_id AND c.session_id=NEW.session_id AND c.context->>'mode'='public'
 AND c.context->>'purpose'=CASE WHEN i->'target'='null'::jsonb THEN 'create_target' ELSE 'edit_target' END
 AND whaleu_ratings.scoped_context_current(c.id,NEW.actor_id,NEW.session_id,clock_timestamp()) AND whaleu_ratings.target_cover_context_current(c.id,clock_timestamp())
 AND NEW.context_revision=c.context->>'scopeRevision' AND i->'context'->>'scopeRevision'=NEW.context_revision AND i->'context'->>'id'=NEW.context_id::text
 AND i->'context'->>'tokenDigest'=c.token_digest AND i->'context'->'selector'=c.context->'selector' AND i->'context'->'protocolGeneration'=c.context->'protocolGeneration'
 AND i->'context'->'sourceDigest'=c.context->'sourceDigest' AND i->'context'->'catalogRevision'=c.context->'heads'->0->'catalogRevision' AND i->'context'->'headRevision'=c.context->'heads'->0->'headRevision'
 AND NEW.request_hash=encode(sha256(convert_to('whaleu-ratings-target-media-prepare:v1'||chr(10)||'{"protocol":"ratings-target-media-v1","actorAccountId":'||to_json(NEW.actor_id::text)::text||',"clientRequestId":'||to_json(NEW.client_request_id::text)::text||',"editScopeId":'||to_json(NEW.id::text)::text||',"scopeRevision":'||to_json(NEW.scope_revision)::text||',"slot":"cover","declaration":{"mime":'||(i->'declaration'->'mime')::text||',"bytes":'||(i->'declaration'->>'bytes')||',"sha256":'||(i->'declaration'->'sha256')::text||'}}','UTF8')),'hex')
 AND NEW.scope_revision=expected_hash AND NEW.declaration=i->'declaration' AND NEW.client_request_id::text=i->>'clientRequestId' AND NEW.command_request_id::text=i->>'commandRequestId'
 AND NEW.category_id::text=i->>'categoryId' AND NEW.expected_target_revision::text IS NOT DISTINCT FROM i->'target'->>'expectedTargetRevision'
 AND NEW.expected_definition_revision::text IS NOT DISTINCT FROM i->'target'->>'expectedDefinitionRevision' AND NEW.expected_content_version IS NOT DISTINCT FROM (i->'target'->>'expectedContentVersion')::integer
 AND (i->'target'='null'::jsonb OR NEW.target_id::text=i->'target'->>'targetId') AND NEW.expires_at=c.valid_until,false)
 THEN RAISE EXCEPTION 'Cover upload scope lacks exact current original authority/CAS' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER target_cover_upload_scope_guard BEFORE INSERT ON whaleu_ratings.target_cover_upload_scopes FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.target_cover_upload_scope_guard();
CREATE FUNCTION whaleu_ratings.target_cover_upload_scope_final() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT whaleu_ratings.target_cover_upload_scope_current(NEW.id,clock_timestamp()) THEN RAISE EXCEPTION 'Cover upload scope expired or changed during final wait' USING ERRCODE='23514';END IF;RETURN NULL;END $$;
CREATE CONSTRAINT TRIGGER target_cover_upload_scope_final AFTER INSERT ON whaleu_ratings.target_cover_upload_scopes DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.target_cover_upload_scope_final();
-- SQL current/causal dispatch includes asset Safety as part of exact content.
-- Unknown is false here; TypeScript distinguishes unavailable from denied for
-- complete-pool scans and never treats either as a nullable image decoration.
CREATE FUNCTION whaleu_ratings.target_cover_media_current(target uuid,cover jsonb,instant timestamptz) RETURNS boolean LANGUAGE sql AS $$
 SELECT coalesce(cover='null'::jsonb OR EXISTS(
 SELECT 1 FROM whaleu_ratings.target_cover_appearances p JOIN whaleu_media.bindings b ON b.id=p.media_binding_id
 JOIN whaleu_media.assets a ON a.id=p.asset_id JOIN whaleu_media.upload_intents i ON i.id=a.intent_id
 JOIN whaleu_media.asset_safety_heads h ON h.asset_id=a.id JOIN whaleu_media.asset_safety_events e ON (e.asset_id,e.revision,e.id)=(h.asset_id,h.revision,h.event_id)
 WHERE p.target_id=target AND p.id::text=cover->>'appearanceId' AND p.asset_id::text=cover->>'assetId' AND p.manifest_digest=cover->>'manifestDigest'
 AND b.owner_kind='ratings' AND b.resource_kind='target_cover' AND b.resource_id=p.id AND b.asset_id=p.asset_id AND b.manifest_digest=p.manifest_digest AND b.slot='cover' AND b.ordinal=0 AND b.content_version=1 AND b.detached_at IS NULL
 AND a.actor_id=p.actor_id AND a.owner_kind='ratings' AND a.resource_kind='target_cover' AND a.target_kind='edit' AND a.slot='cover' AND a.ordinal=0 AND a.audience='content-gated' AND a.purpose='ratings-target-cover-image' AND a.content_version=1
 AND a.manifest_digest=p.manifest_digest AND a.manifest_digest=encode(sha256(convert_to(E'whaleu-media-manifest:v1\n'||whaleu_media.canonical_json(a.manifest),'UTF8')),'hex')
 AND i.protocol_version=6 AND i.state='ready' AND e.state='allow' AND e.manifest_digest=a.manifest_digest AND e.policy_revision=a.policy_revision AND e.effective_at<=instant AND e.valid_until>instant
 ),false)
$$;
DO $$ DECLARE definition text;BEGIN SELECT pg_get_functiondef('whaleu_community.rating_target_cover_definition_current(uuid,integer,uuid,uuid,jsonb)'::regprocedure) INTO definition;EXECUTE replace(definition,'FUNCTION whaleu_community.rating_target_cover_definition_current(', 'FUNCTION whaleu_community.rating_target_cover_definition_review_current(');END $$;
CREATE OR REPLACE FUNCTION whaleu_community.rating_target_cover_definition_current(_target uuid,_content_version integer,_definition_revision uuid,_applied_target_revision uuid,_envelope jsonb) RETURNS boolean LANGUAGE sql AS $$
 SELECT whaleu_community.rating_target_cover_definition_review_current(_target,_content_version,_definition_revision,_applied_target_revision,_envelope)
 AND whaleu_ratings.target_cover_media_current(_target,_envelope->'cover',clock_timestamp())
$$;

-- Existing text/score/like/subscription commands gain only a stricter parent
-- qualification when their actual current definition contains a cover. Their
-- v2 context, intent, hash, Review and receipt retain the original definitions.
CREATE FUNCTION whaleu_ratings.target_cover_existing_operation_scope_current(context_id uuid,instant timestamptz) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT coalesce((SELECT jsonb_array_length(c.protocol_tuples)=1 AND NOT EXISTS(
 SELECT 1 FROM jsonb_array_elements(c.protocol_tuples) p
 LEFT JOIN whaleu_ratings.target_cover_capability_sources a ON a.protocol_version_id=(p->>'versionId')::uuid
 WHERE a.id IS NULL OR NOT whaleu_ratings.target_cover_capability_current(a.id,instant))
 FROM whaleu_ratings.scoped_contexts c WHERE c.id=context_id),false)
$$;
DO $$DECLARE definition text;BEGIN
 SELECT pg_get_functiondef('whaleu_ratings.scoped_command_parents_current(whaleu_ratings.scoped_command_preparations)'::regprocedure) INTO definition;
 EXECUTE replace(definition,'FUNCTION whaleu_ratings.scoped_command_parents_current(', 'FUNCTION whaleu_ratings.scoped_command_parents_current_pre_target_cover(');
END$$;
CREATE OR REPLACE FUNCTION whaleu_ratings.scoped_command_parents_current(prepared whaleu_ratings.scoped_command_preparations) RETURNS boolean LANGUAGE sql AS $$
 SELECT whaleu_ratings.scoped_command_parents_current_pre_target_cover(prepared) AND
 (NOT EXISTS(SELECT 1 FROM whaleu_ratings.target_definition_heads h JOIN whaleu_ratings.target_definition_versions d USING(target_id,content_version,definition_revision)
 WHERE h.target_id=prepared.target_id AND d.envelope->'version'='6'::jsonb AND d.envelope->'cover'<>'null'::jsonb)
 OR whaleu_ratings.target_cover_existing_operation_scope_current(prepared.context_id,clock_timestamp()))
$$;
