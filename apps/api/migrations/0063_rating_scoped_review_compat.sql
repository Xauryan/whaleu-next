-- Typed Review5 and retained legacy compatibility. Historical migrations are immutable.
SET LOCAL lock_timeout='5s';
SELECT pg_advisory_xact_lock(hashtextextended('whaleu:named-block-policy:v1',0));
-- Review-owned M3B fragment. Install after 0062, before scoped compiler guards.
-- No provider or default approvals. Legacy v1-v4 predicates remain byte-for-byte
-- in their preserved function bodies and all historical bindings remain intact.
CREATE FUNCTION whaleu_community.rating_scoped_uuid_valid(v text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT coalesce(v ~ '^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$',false)
$$;
CREATE FUNCTION whaleu_community.rating_scoped_keys(e jsonb,keys text[]) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT coalesce(jsonb_typeof(e)='object' AND e ?& keys AND e-keys='{}'::jsonb,false)
$$;
CREATE FUNCTION whaleu_community.rating_scoped_ids(e jsonb,keys text[]) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT coalesce(jsonb_typeof(e)='object' AND NOT EXISTS(SELECT 1 FROM unnest(keys) k WHERE jsonb_typeof(e->k) IS DISTINCT FROM 'string' OR NOT whaleu_community.rating_scoped_uuid_valid(e->>k)),false)
$$;
CREATE FUNCTION whaleu_community.rating_scoped_nullable_id(e jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT coalesce(e='null'::jsonb OR (jsonb_typeof(e)='string' AND whaleu_community.rating_scoped_uuid_valid(e#>>'{}')),false)
$$;
CREATE FUNCTION whaleu_community.rating_scoped_integer(e jsonb,minimum integer) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$ BEGIN
 RETURN coalesce(jsonb_typeof(e)='number' AND e::text ~ '^[0-9]+$' AND (e::text)::numeric BETWEEN minimum AND 2147483647,false);
 EXCEPTION WHEN OTHERS THEN RETURN false;END $$;
CREATE FUNCTION whaleu_community.rating_scoped_selector_shape(e jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE WHEN e->>'kind'='global' THEN whaleu_community.rating_scoped_keys(e,ARRAY['kind'])
 WHEN e->>'kind'='campus' THEN whaleu_community.rating_scoped_keys(e,ARRAY['kind','campusId']) AND whaleu_community.rating_scoped_ids(e,ARRAY['campusId']) ELSE false END
$$;
CREATE FUNCTION whaleu_community.rating_scoped_scope_shape(e jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT coalesce(whaleu_community.rating_scoped_keys(e,ARRAY['selector','scopeKey','catalogRevision','headRevision','scopeRevision','contextId','contextDigest','protocolGeneration','sourceDigest','topologySnapshotId'])
 AND whaleu_community.rating_scoped_selector_shape(e->'selector')
 AND whaleu_community.rating_scoped_ids(e,ARRAY['catalogRevision','headRevision','contextId','protocolGeneration'])
 AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['scopeRevision','contextDigest','sourceDigest']) k WHERE jsonb_typeof(e->k) IS DISTINCT FROM 'string' OR (e->>k) !~ '^[a-f0-9]{64}$')
 AND whaleu_community.rating_scoped_nullable_id(e->'topologySnapshotId')
 AND CASE WHEN e->'selector'->>'kind'='global' THEN e->>'scopeKey'='global'
 ELSE e->>'scopeKey'='campus:'||(e->'selector'->>'campusId') AND e->'topologySnapshotId'<>'null'::jsonb END,false)
$$;
CREATE FUNCTION whaleu_community.rating_scoped_placement_shape(e jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE item jsonb;previous text;BEGIN
 IF e->>'kind'='global' THEN RETURN whaleu_community.rating_scoped_keys(e,ARRAY['kind']);END IF;
 IF NOT whaleu_community.rating_scoped_keys(e,ARRAY['kind','campusIds']) OR e->>'kind'<>'campuses' OR jsonb_typeof(e->'campusIds')<>'array' OR jsonb_array_length(e->'campusIds') NOT BETWEEN 1 AND 1000 THEN RETURN false;END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(e->'campusIds') LOOP
  IF jsonb_typeof(item)<>'string' OR NOT whaleu_community.rating_scoped_uuid_valid(item#>>'{}') OR (previous IS NOT NULL AND previous COLLATE "C">=(item#>>'{}') COLLATE "C") THEN RETURN false;END IF;
  previous:=item#>>'{}';
 END LOOP;RETURN true;EXCEPTION WHEN OTHERS THEN RETURN false;END $$;
CREATE FUNCTION whaleu_community.rating_scoped_envelope_shape(e jsonb,op text) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE keys text[];body jsonb;scope jsonb;BEGIN
 IF e->'version'<>'5'::jsonb OR e->>'purpose' IS DISTINCT FROM op OR e->'assetIds'<>'[]'::jsonb OR NOT whaleu_community.rating_scoped_ids(e,ARRAY['accountId','categoryId']) THEN RETURN false;END IF;
 IF op IN ('publish_rating_category_base_scoped','publish_rating_category_override_scoped') THEN
  keys:=ARRAY['version','purpose','accountId','sourceId','sourceRevision','categoryId','identityId','issuanceId','issuanceDigest','placement','assetIds','body'];
  IF NOT whaleu_community.rating_scoped_ids(e,ARRAY['sourceId','sourceRevision','identityId','issuanceId']) OR e->>'issuanceId'<>e->>'sourceId'
   OR jsonb_typeof(e->'issuanceDigest')<>'string' OR (e->>'issuanceDigest') !~ '^[a-f0-9]{64}$' OR NOT whaleu_community.rating_scoped_placement_shape(e->'placement') THEN RETURN false;END IF;
  body:=e->'body';
  IF jsonb_typeof(body->'name')<>'string' OR jsonb_typeof(body->'description')<>'string' OR NOT whaleu_community.rating_target_edit_text_valid(body->>'name',100,true) OR NOT whaleu_community.rating_target_edit_text_valid(body->>'description',500,false) THEN RETURN false;END IF;
  IF op='publish_rating_category_base_scoped' THEN
   IF NOT whaleu_community.rating_scoped_keys(body,ARRAY['parentId','level','kind','systemKey','name','description'])
    OR NOT whaleu_community.rating_scoped_nullable_id(body->'parentId') OR NOT whaleu_community.rating_scoped_integer(body->'level',1)
    OR (body->>'level')::integer>3 OR ((body->'parentId'='null'::jsonb) IS DISTINCT FROM (body->'level'='1'::jsonb))
    OR jsonb_typeof(body->'kind')<>'string' OR (body->>'kind') !~ '^[a-z][a-z0-9_]{0,49}$'
    OR NOT (body->'systemKey'='null'::jsonb OR (jsonb_typeof(body->'systemKey')='string' AND body->>'systemKey' ~ '^[a-z][a-z0-9_]{1,48}$')) THEN RETURN false;END IF;
  ELSE
   keys:=keys||ARRAY['baseSourceId','baseSourceRevision','scope'];scope:=e->'scope';
   IF NOT whaleu_community.rating_scoped_keys(body,ARRAY['name','description']) OR NOT whaleu_community.rating_scoped_ids(e,ARRAY['baseSourceId','baseSourceRevision'])
    OR NOT whaleu_community.rating_scoped_keys(scope,ARRAY['kind','campusId']) OR scope->>'kind'<>'campus' OR NOT whaleu_community.rating_scoped_ids(scope,ARRAY['campusId'])
    OR e->'placement'<>jsonb_build_object('kind','campuses','campusIds',jsonb_build_array(scope->'campusId')) THEN RETURN false;END IF;
  END IF;RETURN whaleu_community.rating_scoped_keys(e,keys);
 END IF;
 keys:=ARRAY['version','purpose','accountId','clientRequestId','targetId','targetRevision','categoryId','categoryRevision','scope','targetOrigin','assetIds'];
 IF NOT whaleu_community.rating_scoped_ids(e,ARRAY['clientRequestId','targetId','targetRevision','categoryRevision'])
  OR NOT whaleu_community.rating_scoped_scope_shape(e->'scope') OR NOT whaleu_community.rating_scoped_keys(e->'targetOrigin',ARRAY['regionId','originCampusId'])
  OR NOT whaleu_community.rating_scoped_nullable_id(e->'targetOrigin'->'regionId') OR NOT whaleu_community.rating_scoped_nullable_id(e->'targetOrigin'->'originCampusId') THEN RETURN false;END IF;
 IF op IN ('publish_rating_target_scoped','edit_rating_target_scoped') THEN
  keys:=keys||ARRAY['definitionRevision','contentVersion','name','description'];
  IF NOT whaleu_community.rating_scoped_ids(e,ARRAY['definitionRevision']) OR NOT whaleu_community.rating_scoped_integer(e->'contentVersion',1)
   OR jsonb_typeof(e->'name')<>'string' OR jsonb_typeof(e->'description')<>'string' OR NOT whaleu_community.rating_target_edit_text_valid(e->>'name',100,true) OR NOT whaleu_community.rating_target_edit_text_valid(e->>'description',500,false) THEN RETURN false;END IF;
  IF op='publish_rating_target_scoped' THEN
   IF e->'contentVersion'<>'1'::jsonb OR e->>'definitionRevision'<>e->>'targetRevision' THEN RETURN false;END IF;
  ELSE
   keys:=keys||ARRAY['previousTargetRevision','previousDefinitionRevision'];
   IF NOT whaleu_community.rating_scoped_ids(e,ARRAY['previousTargetRevision','previousDefinitionRevision']) OR NOT whaleu_community.rating_scoped_integer(e->'contentVersion',2)
    OR e->>'previousTargetRevision'=e->>'targetRevision' OR e->>'previousDefinitionRevision'=e->>'definitionRevision' THEN RETURN false;END IF;
  END IF;
 ELSIF op IN ('publish_rating_comment_scoped','publish_rating_reply_scoped') THEN
  keys:=keys||ARRAY['subjectId','subjectRevision','targetDefinitionRevision','targetContentVersion','authorMode','body'];
  IF NOT whaleu_community.rating_scoped_ids(e,ARRAY['subjectId','subjectRevision','targetDefinitionRevision']) OR NOT whaleu_community.rating_scoped_integer(e->'targetContentVersion',1)
   OR jsonb_typeof(e->'authorMode')<>'string' OR e->>'authorMode' NOT IN ('named','anonymous') OR jsonb_typeof(e->'body')<>'string' OR NOT whaleu_community.rating_target_edit_text_valid(e->>'body',500,true) THEN RETURN false;END IF;
  IF op='publish_rating_reply_scoped' THEN
   keys:=keys||ARRAY['rootId','rootRevision','replyTo'];
   IF NOT whaleu_community.rating_scoped_ids(e,ARRAY['rootId','rootRevision']) OR e->>'subjectId'=e->>'rootId'
    OR NOT (e->'replyTo'='null'::jsonb OR (whaleu_community.rating_scoped_keys(e->'replyTo',ARRAY['replyId','revision']) AND whaleu_community.rating_scoped_ids(e->'replyTo',ARRAY['replyId','revision']) AND e->>'subjectId'<>e->'replyTo'->>'replyId')) THEN RETURN false;END IF;
  END IF;
 ELSE RETURN false;END IF;
 RETURN whaleu_community.rating_scoped_keys(e,keys);
EXCEPTION WHEN OTHERS THEN RETURN false;END $$;
DO $$ DECLARE definition text;columns smallint[];names text[];BEGIN
 definition:=pg_get_functiondef('whaleu_community.rating_envelope_shape(jsonb,text)'::regprocedure);
 IF definition NOT LIKE '%rating_category_envelope_shape%' OR definition NOT LIKE '%rating_envelope_shape_v3%' THEN RAISE EXCEPTION 'Expected exact Review v4 dispatcher missing' USING ERRCODE='23514';END IF;
 EXECUTE replace(definition,'FUNCTION whaleu_community.rating_envelope_shape(', 'FUNCTION whaleu_community.rating_envelope_shape_pre_scoped(');
 SELECT array_agg(attnum::smallint ORDER BY attnum) INTO columns FROM pg_attribute WHERE attrelid='whaleu_community.rating_approval_decisions'::regclass AND attname IN ('operation','envelope_version') AND NOT attisdropped;
 SELECT array_agg(conname) INTO names FROM pg_constraint c WHERE conrelid='whaleu_community.rating_approval_decisions'::regclass AND contype='c' AND ARRAY(SELECT k FROM unnest(c.conkey) k ORDER BY k)=columns;
 IF cardinality(columns) IS DISTINCT FROM 2 OR names IS DISTINCT FROM ARRAY['rating_decision_protocol_v4']::text[] THEN RAISE EXCEPTION 'Review v4 discriminator baseline mismatch' USING ERRCODE='23514';END IF;
END $$;
CREATE OR REPLACE FUNCTION whaleu_community.rating_envelope_shape(e jsonb,op text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE WHEN op IN ('publish_rating_target_scoped','edit_rating_target_scoped','publish_rating_comment_scoped','publish_rating_reply_scoped','publish_rating_category_base_scoped','publish_rating_category_override_scoped')
 THEN whaleu_community.rating_scoped_envelope_shape(e,op) ELSE whaleu_community.rating_envelope_shape_pre_scoped(e,op) END
$$;
ALTER TABLE whaleu_community.rating_approval_decisions DROP CONSTRAINT rating_decision_protocol_v4;
ALTER TABLE whaleu_community.rating_approval_decisions ADD CONSTRAINT rating_decision_protocol_v5 CHECK(
 (operation IN ('publish_rating_target','publish_rating_comment') AND envelope_version=1)
 OR (operation='publish_rating_reply' AND envelope_version=2)
 OR (operation='edit_rating_target' AND envelope_version=3)
 OR (operation='publish_rating_categories' AND envelope_version=4)
 OR (operation IN ('publish_rating_target_scoped','edit_rating_target_scoped','publish_rating_comment_scoped','publish_rating_reply_scoped','publish_rating_category_base_scoped','publish_rating_category_override_scoped') AND envelope_version=5));
CREATE TABLE whaleu_community.rating_scoped_content_bindings(
 kind text NOT NULL CHECK(kind IN ('comment','reply')),subject_id uuid NOT NULL,subject_revision uuid NOT NULL,content_version integer NOT NULL CHECK(content_version=1),
 decision_id uuid NOT NULL UNIQUE,account_id uuid NOT NULL,operation text NOT NULL,envelope_version integer NOT NULL CHECK(envelope_version=5),digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),envelope jsonb NOT NULL,scope jsonb NOT NULL,
 bound_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(bound_at)),publication_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),PRIMARY KEY(kind,subject_id),
 FOREIGN KEY(decision_id,account_id,operation,envelope_version,digest) REFERENCES whaleu_community.rating_approval_decisions(id,account_id,operation,envelope_version,digest),
 CHECK((kind='comment' AND operation='publish_rating_comment_scoped') OR (kind='reply' AND operation='publish_rating_reply_scoped')),
 CHECK(whaleu_community.rating_scoped_envelope_shape(envelope,operation)),CHECK(envelope->>'subjectId'=subject_id::text AND envelope->>'subjectRevision'=subject_revision::text AND envelope->>'accountId'=account_id::text AND scope=envelope->'scope'),
 CHECK(digest=encode(sha256(convert_to('whaleu-rating-content-approval:v5'||chr(10)||whaleu_community.content_canonical_json(envelope),'UTF8')),'hex'))
);
CREATE TABLE whaleu_community.rating_scoped_target_definition_bindings(
 target_id uuid NOT NULL,content_version integer NOT NULL CHECK(content_version>=1),definition_revision uuid NOT NULL,applied_target_revision uuid NOT NULL,
 decision_id uuid NOT NULL UNIQUE,account_id uuid NOT NULL,operation text NOT NULL,envelope_version integer NOT NULL CHECK(envelope_version=5),digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),envelope jsonb NOT NULL,scope jsonb NOT NULL,
 bound_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(bound_at)),publication_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),PRIMARY KEY(target_id,content_version),UNIQUE(target_id,definition_revision),
 FOREIGN KEY(decision_id,account_id,operation,envelope_version,digest) REFERENCES whaleu_community.rating_approval_decisions(id,account_id,operation,envelope_version,digest),
 FOREIGN KEY(target_id,content_version,definition_revision) REFERENCES whaleu_ratings.target_definition_versions(target_id,content_version,definition_revision) DEFERRABLE INITIALLY DEFERRED,
 CHECK((content_version=1 AND operation='publish_rating_target_scoped' AND definition_revision=applied_target_revision) OR (content_version>=2 AND operation='edit_rating_target_scoped')),
 CHECK(whaleu_community.rating_scoped_envelope_shape(envelope,operation)),CHECK(envelope->>'targetId'=target_id::text AND envelope->>'targetRevision'=applied_target_revision::text AND envelope->>'definitionRevision'=definition_revision::text AND envelope->'contentVersion'=to_jsonb(content_version) AND envelope->>'accountId'=account_id::text AND scope=envelope->'scope'),
 CHECK(digest=encode(sha256(convert_to('whaleu-rating-content-approval:v5'||chr(10)||whaleu_community.content_canonical_json(envelope),'UTF8')),'hex'))
);
CREATE TABLE whaleu_community.rating_scoped_category_source_bindings(
 source_id uuid NOT NULL,source_revision uuid NOT NULL,category_id uuid NOT NULL,issuance_id uuid NOT NULL,issuance_digest text NOT NULL CHECK(issuance_digest ~ '^[a-f0-9]{64}$'),
 decision_id uuid NOT NULL UNIQUE,account_id uuid NOT NULL,operation text NOT NULL CHECK(operation IN ('publish_rating_category_base_scoped','publish_rating_category_override_scoped')),envelope_version integer NOT NULL CHECK(envelope_version=5),digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),envelope jsonb NOT NULL,
 bound_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(bound_at)),publication_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),PRIMARY KEY(source_id,source_revision),
 FOREIGN KEY(decision_id,account_id,operation,envelope_version,digest) REFERENCES whaleu_community.rating_approval_decisions(id,account_id,operation,envelope_version,digest),
 FOREIGN KEY(source_id,source_revision) REFERENCES whaleu_ratings.scoped_source_attestations(id,revision) DEFERRABLE INITIALLY DEFERRED,
 CHECK(whaleu_community.rating_scoped_envelope_shape(envelope,operation)),CHECK(envelope->>'sourceId'=source_id::text AND envelope->>'sourceRevision'=source_revision::text AND envelope->>'categoryId'=category_id::text AND envelope->>'accountId'=account_id::text AND envelope->>'issuanceId'=issuance_id::text AND issuance_id=source_id AND envelope->>'issuanceDigest'=issuance_digest),
 CHECK(digest=encode(sha256(convert_to('whaleu-rating-content-approval:v5'||chr(10)||whaleu_community.content_canonical_json(envelope),'UTF8')),'hex'))
);
CREATE FUNCTION whaleu_community.rating_scoped_decision_current(_decision uuid,_consume boolean) RETURNS boolean LANGUAGE sql AS $$
 WITH instant AS MATERIALIZED (SELECT clock_timestamp() now)
 SELECT coalesce((SELECT d.envelope_version=5 AND whaleu_community.rating_scoped_envelope_shape(d.envelope,d.operation)
  AND d.digest=encode(sha256(convert_to('whaleu-rating-content-approval:v5'||chr(10)||whaleu_community.content_canonical_json(d.envelope),'UTF8')),'hex')
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
CREATE FUNCTION whaleu_community.rating_scoped_binding_validate() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d whaleu_community.rating_approval_decisions;instant timestamptz;BEGIN
 SELECT * INTO d FROM whaleu_community.rating_approval_decisions WHERE id=NEW.decision_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Scoped Review decision missing' USING ERRCODE='23514';END IF;
 PERFORM id FROM whaleu_identity.accounts WHERE id=d.account_id FOR SHARE;
 PERFORM decision_id FROM whaleu_community.rating_approval_heads WHERE decision_id=d.id FOR SHARE;instant:=clock_timestamp();
 IF NOT whaleu_community.rating_scoped_decision_current(d.id,true) OR NEW.publication_transaction IS DISTINCT FROM pg_current_xact_id()
  OR (NEW.account_id,NEW.operation,NEW.envelope_version,NEW.digest,NEW.envelope) IS DISTINCT FROM (d.account_id,d.operation,d.envelope_version,d.digest,d.envelope)
  OR EXISTS(SELECT 1 FROM whaleu_community.rating_approval_decisions n WHERE n.account_id=d.account_id AND n.operation=d.operation AND n.envelope_version=d.envelope_version AND n.digest=d.digest AND (n.evaluated_at,n.id)>(d.evaluated_at,d.id))
  OR EXISTS(SELECT 1 FROM whaleu_community.rating_scoped_content_bindings WHERE decision_id=d.id)
  OR EXISTS(SELECT 1 FROM whaleu_community.rating_scoped_target_definition_bindings WHERE decision_id=d.id)
  OR EXISTS(SELECT 1 FROM whaleu_community.rating_scoped_category_source_bindings WHERE decision_id=d.id)
 THEN RAISE EXCEPTION 'Scoped exact Review consumption mismatch' USING ERRCODE='23514';END IF;
 NEW.bound_at:=instant;RETURN NEW;END $$;
-- Statement registration is deliberately explicit. Ordinary comment/reply
-- publication never upgrades the shared outer gate to the exclusive gate.
CREATE FUNCTION whaleu_community.rating_scoped_content_writer() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('whaleu:named-block-policy:v1',0));RETURN NULL;END $$;
CREATE TRIGGER a00_scoped_content_writer BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_community.rating_scoped_content_bindings FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.rating_scoped_content_writer();
CREATE TRIGGER a00_scoped_definition_writer BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_community.rating_scoped_target_definition_bindings FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.target_edit_writer();
CREATE TRIGGER a00_scoped_category_writer BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_community.rating_scoped_category_source_bindings FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.scoped_public_writer_gate();
DO $$ DECLARE tab text;BEGIN
 FOREACH tab IN ARRAY ARRAY['rating_scoped_content_bindings','rating_scoped_target_definition_bindings','rating_scoped_category_source_bindings'] LOOP
  EXECUTE format('CREATE TRIGGER a01_scoped_binding_epoch BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_community.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.advance_rating_review_binding_epoch()',tab);
  EXECUTE format('CREATE TRIGGER scoped_binding_validate BEFORE INSERT ON whaleu_community.%I FOR EACH ROW EXECUTE FUNCTION whaleu_community.rating_scoped_binding_validate()',tab);
  EXECUTE format('CREATE TRIGGER scoped_binding_immutable BEFORE UPDATE OR DELETE ON whaleu_community.%I FOR EACH ROW EXECUTE FUNCTION whaleu_community.content_approval_immutable()',tab);
  EXECUTE format('CREATE TRIGGER scoped_binding_retain BEFORE TRUNCATE ON whaleu_community.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.content_approval_immutable()',tab);
 END LOOP;
 FOREACH tab IN ARRAY ARRAY['rating_scoped_target_definition_bindings','rating_scoped_category_source_bindings'] LOOP
  EXECUTE format('CREATE TRIGGER a03_scoped_binding_pool BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_community.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.advance_random_pool_epoch()',tab);
  EXECUTE format('CREATE TRIGGER a04_scoped_binding_navigation BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_community.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.advance_navigation_epoch()',tab);
 END LOOP;
END $$;
CREATE TRIGGER a02_scoped_category_source BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_community.rating_scoped_category_source_bindings FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.advance_scoped_source_epoch();
CREATE FUNCTION whaleu_community.rating_scoped_target_definition_current(_target uuid,_content_version integer,_definition_revision uuid,_applied_target_revision uuid,_envelope jsonb) RETURNS boolean LANGUAGE sql AS $$
 SELECT coalesce((SELECT b.target_id=_target AND b.content_version=_content_version AND b.definition_revision=_definition_revision AND b.applied_target_revision=_applied_target_revision
  AND b.envelope=_envelope AND b.scope=_envelope->'scope' AND whaleu_community.rating_scoped_envelope_shape(_envelope,b.operation)
  AND (d.account_id,d.operation,d.envelope_version,d.digest,d.envelope)=(b.account_id,b.operation,b.envelope_version,b.digest,b.envelope)
  AND isfinite(b.bound_at) AND b.bound_at>=d.evaluated_at AND b.bound_at<=clock_timestamp()
  AND whaleu_community.rating_scoped_decision_current(b.decision_id,false)
 FROM whaleu_community.rating_scoped_target_definition_bindings b JOIN whaleu_community.rating_approval_decisions d ON d.id=b.decision_id
 WHERE b.target_id=_target AND b.content_version=_content_version),false)
$$;
CREATE FUNCTION whaleu_community.rating_scoped_content_current(_kind text,_subject uuid,_revision uuid,_envelope jsonb) RETURNS boolean LANGUAGE sql AS $$
 SELECT coalesce((SELECT b.subject_revision=_revision AND b.envelope=_envelope AND b.scope=_envelope->'scope' AND whaleu_community.rating_scoped_envelope_shape(_envelope,b.operation)
  AND (d.account_id,d.operation,d.envelope_version,d.digest,d.envelope)=(b.account_id,b.operation,b.envelope_version,b.digest,b.envelope)
  AND isfinite(b.bound_at) AND b.bound_at>=d.evaluated_at AND b.bound_at<=clock_timestamp() AND whaleu_community.rating_scoped_decision_current(b.decision_id,false)
 FROM whaleu_community.rating_scoped_content_bindings b JOIN whaleu_community.rating_approval_decisions d ON d.id=b.decision_id
 WHERE b.kind=_kind AND b.subject_id=_subject),false)
$$;
-- Current parent authority is version-dispatched from its own immutable binding.
-- A child decision, matching body hash or known parent UUID never authorizes it.
CREATE FUNCTION whaleu_community.rating_scoped_parent_review_current(_kind text,_subject uuid,_revision uuid) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE content_row record;valid boolean;
BEGIN
 SELECT x.* INTO content_row FROM (
  SELECT c.envelope,c.revision,c.account_id,c.body,c.author_mode,c.target_id,c.deleted_at FROM whaleu_ratings.comments c WHERE _kind='comment' AND c.id=_subject
  UNION ALL SELECT c.envelope,c.revision,c.account_id,c.body,c.author_mode,c.target_id,c.deleted_at FROM whaleu_ratings.replies c WHERE _kind='reply' AND c.id=_subject
 ) x;
 IF NOT FOUND OR content_row.deleted_at IS NOT NULL OR content_row.revision IS DISTINCT FROM _revision
 OR NOT coalesce(content_row.envelope->>'accountId'=content_row.account_id::text AND content_row.envelope->>'targetId'=content_row.target_id::text
  AND content_row.envelope->>'body'=content_row.body AND content_row.envelope->>'authorMode'=content_row.author_mode,false) THEN RETURN false;END IF;
 IF content_row.envelope->'version'='5'::jsonb THEN
  RETURN whaleu_community.rating_scoped_content_current(_kind,_subject,_revision,content_row.envelope);
 END IF;
 WITH instant AS MATERIALIZED (SELECT clock_timestamp() now)
 SELECT coalesce((SELECT b.envelope=content_row.envelope AND b.scope=content_row.envelope->'scope'
  AND b.account_id=content_row.account_id AND whaleu_community.rating_envelope_shape(content_row.envelope,b.operation)
  AND (d.account_id,d.operation,d.envelope_version,d.digest,d.envelope)=(b.account_id,b.operation,b.envelope_version,b.digest,b.envelope)
  AND d.digest=encode(sha256(convert_to('whaleu-rating-content-approval:v'||d.envelope_version::text||chr(10)||whaleu_community.content_canonical_json(content_row.envelope),'UTF8')),'hex')
  AND d.result='allow' AND d.coverage='complete' AND d.provenance='accepted'
  AND p.policy_key='local-explicit-v1' AND p.version=1 AND p.coverage='complete' AND p.provenance='accepted'
  AND e.state='allow' AND e.coverage='complete' AND e.provenance='accepted'
  AND length(btrim(d.issuer))>0 AND length(btrim(d.provenance_ref))>0 AND length(btrim(p.issuer))>0 AND length(btrim(p.provenance_ref))>0 AND length(btrim(e.issuer))>0 AND length(btrim(e.provenance_ref))>0
  AND isfinite(d.evaluated_at) AND d.evaluated_at<=instant.now AND isfinite(p.valid_from) AND p.valid_from<=d.evaluated_at AND (p.valid_until IS NULL OR (isfinite(p.valid_until) AND p.valid_until>instant.now))
  AND isfinite(e.occurred_at) AND e.occurred_at>=d.evaluated_at AND e.occurred_at<=instant.now AND isfinite(d.consume_until) AND d.consume_until>d.evaluated_at
  AND ((d.visibility_model='durable' AND d.visibility_until IS NULL) OR (d.visibility_model='until' AND isfinite(d.visibility_until) AND d.visibility_until>d.evaluated_at AND d.visibility_until>instant.now))
  AND isfinite(b.bound_at) AND b.bound_at>=d.evaluated_at AND b.bound_at<=instant.now
 FROM whaleu_community.rating_approval_bindings b JOIN whaleu_community.rating_approval_decisions d ON d.id=b.decision_id
 JOIN whaleu_identity.accounts a ON a.id=d.account_id JOIN whaleu_community.content_approval_policies p ON p.id=d.policy_revision_id
 JOIN whaleu_community.rating_approval_heads h ON h.decision_id=d.id JOIN whaleu_community.rating_approval_events e ON e.id=h.event_id AND e.decision_id=d.id CROSS JOIN instant
 WHERE b.kind=_kind AND b.subject_id=_subject AND b.content_version=1),false) INTO valid;
 RETURN valid;
END $$;
CREATE FUNCTION whaleu_community.rating_scoped_category_source_current(_source uuid,_revision uuid,_envelope jsonb) RETURNS boolean LANGUAGE sql AS $$
 SELECT coalesce((SELECT b.envelope=_envelope AND whaleu_community.rating_scoped_envelope_shape(_envelope,b.operation)
  AND (d.account_id,d.operation,d.envelope_version,d.digest,d.envelope)=(b.account_id,b.operation,b.envelope_version,b.digest,b.envelope)
  AND isfinite(b.bound_at) AND b.bound_at>=d.evaluated_at AND b.bound_at<=clock_timestamp() AND whaleu_community.rating_scoped_decision_current(b.decision_id,false)
 FROM whaleu_community.rating_scoped_category_source_bindings b JOIN whaleu_community.rating_approval_decisions d ON d.id=b.decision_id
 WHERE b.source_id=_source AND b.source_revision=_revision),false)
$$;
DO $$ DECLARE definition text;BEGIN
 definition:=pg_get_functiondef('whaleu_community.rating_target_definition_current(uuid,integer,uuid,uuid,jsonb)'::regprocedure);
 IF definition NOT LIKE '%rating_target_definition_bindings%' OR definition LIKE '%scoped%' THEN RAISE EXCEPTION 'Expected legacy current-definition baseline missing' USING ERRCODE='23514';END IF;
 EXECUTE replace(definition,'FUNCTION whaleu_community.rating_target_definition_current(', 'FUNCTION whaleu_community.rating_target_definition_current_pre_scoped(');
END $$;
CREATE OR REPLACE FUNCTION whaleu_community.rating_target_definition_current(_target uuid,_content_version integer,_definition_revision uuid,_applied_target_revision uuid,_envelope jsonb) RETURNS boolean LANGUAGE sql AS $$
 SELECT CASE WHEN _envelope->'version'='5'::jsonb THEN whaleu_community.rating_scoped_target_definition_current(_target,_content_version,_definition_revision,_applied_target_revision,_envelope)
 ELSE whaleu_community.rating_target_definition_current_pre_scoped(_target,_content_version,_definition_revision,_applied_target_revision,_envelope) END
$$;
-- Bidirectional immutable artifact proof. Current-head qualification remains
-- with Ratings; Review proves that the supplied immutable artifact really owns
-- this exact decision and was published in the same original transaction.
CREATE FUNCTION whaleu_community.verify_rating_scoped_source_binding(_source uuid,_revision uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE b whaleu_community.rating_scoped_category_source_bindings;s whaleu_ratings.scoped_source_attestations;
BEGIN
 SELECT * INTO s FROM whaleu_ratings.scoped_source_attestations WHERE id=_source AND revision=_revision;
 SELECT * INTO b FROM whaleu_community.rating_scoped_category_source_bindings WHERE source_id=_source AND source_revision=_revision;
 IF s.id IS NULL OR b.source_id IS NULL OR s.publication_transaction<>pg_current_xact_id() OR b.publication_transaction<>s.publication_transaction
  OR (s.source_kind='scoped_category_base' AND b.operation<>'publish_rating_category_base_scoped')
  OR (s.source_kind='scoped_category_override' AND b.operation<>'publish_rating_category_override_scoped')
  OR s.source_kind NOT IN ('scoped_category_base','scoped_category_override')
  OR s.payload->'reviewEnvelope' IS DISTINCT FROM b.envelope OR s.payload->>'issuanceDigest' IS DISTINCT FROM b.issuance_digest
  OR s.scope_keys IS DISTINCT FROM (CASE WHEN b.envelope->'placement'->>'kind'='global' THEN ARRAY['global'] ELSE ARRAY(SELECT 'campus:'||value FROM jsonb_array_elements_text(b.envelope->'placement'->'campusIds') ORDER BY value) END)
  OR NOT whaleu_community.rating_scoped_category_source_current(_source,_revision,b.envelope) OR NOT whaleu_community.rating_scoped_decision_current(b.decision_id,true)
 THEN RAISE EXCEPTION 'Scoped category source needs exact fresh Review issuance binding' USING ERRCODE='23514';END IF;
END $$;
CREATE FUNCTION whaleu_community.rating_scoped_binding_causal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e jsonb;actor uuid;request uuid;matched boolean;
BEGIN
 IF TG_TABLE_NAME='scoped_source_attestations' THEN
  IF NEW.source_kind IN ('scoped_category_base','scoped_category_override') THEN PERFORM whaleu_community.verify_rating_scoped_source_binding(NEW.id,NEW.revision);END IF;RETURN NULL;
 ELSIF TG_TABLE_NAME='rating_scoped_category_source_bindings' THEN PERFORM whaleu_community.verify_rating_scoped_source_binding(NEW.source_id,NEW.source_revision);RETURN NULL;
 ELSIF TG_TABLE_NAME='target_definition_versions' THEN
  IF NEW.envelope->'version'<>'5'::jsonb THEN RETURN NULL;END IF;
  e:=NEW.envelope;
  SELECT b.envelope=NEW.envelope AND b.applied_target_revision=NEW.applied_target_revision AND b.publication_transaction=NEW.publication_transaction
   INTO matched FROM whaleu_community.rating_scoped_target_definition_bindings b
   WHERE b.target_id=NEW.target_id AND b.content_version=NEW.content_version AND b.definition_revision=NEW.definition_revision;
 ELSIF TG_TABLE_NAME IN ('comments','replies') THEN
  IF NEW.envelope->'version'<>'5'::jsonb THEN RETURN NULL;END IF;e:=NEW.envelope;
  SELECT b.envelope=NEW.envelope AND b.subject_revision=NEW.revision AND b.publication_transaction=NEW.publication_transaction
   INTO matched FROM whaleu_community.rating_scoped_content_bindings b
   WHERE b.kind=CASE WHEN TG_TABLE_NAME='comments' THEN 'comment' ELSE 'reply' END AND b.subject_id=NEW.id;
 ELSIF TG_TABLE_NAME='rating_scoped_target_definition_bindings' THEN
  e:=NEW.envelope;
  SELECT v.envelope=NEW.envelope AND v.applied_target_revision=NEW.applied_target_revision AND v.publication_transaction=NEW.publication_transaction
   INTO matched FROM whaleu_ratings.target_definition_versions v
   WHERE v.target_id=NEW.target_id AND v.content_version=NEW.content_version AND v.definition_revision=NEW.definition_revision;
 ELSIF TG_TABLE_NAME='rating_scoped_content_bindings' THEN
  e:=NEW.envelope;
  IF NEW.kind='comment' THEN
   SELECT c.envelope=NEW.envelope AND c.revision=NEW.subject_revision AND c.publication_transaction=NEW.publication_transaction
    AND c.account_id=NEW.account_id AND c.request_id::text=e->>'clientRequestId' AND c.target_id::text=e->>'targetId'
    AND c.body=e->>'body' AND c.author_mode=e->>'authorMode' AND c.deleted_at IS NULL INTO matched FROM whaleu_ratings.comments c WHERE c.id=NEW.subject_id;
  ELSE
   SELECT c.envelope=NEW.envelope AND c.revision=NEW.subject_revision AND c.publication_transaction=NEW.publication_transaction
    AND c.account_id=NEW.account_id AND c.request_id::text=e->>'clientRequestId' AND c.target_id::text=e->>'targetId'
    AND c.root_id::text=e->>'rootId' AND c.reply_to_id::text IS NOT DISTINCT FROM e->'replyTo'->>'replyId'
    AND c.body=e->>'body' AND c.author_mode=e->>'authorMode' AND c.deleted_at IS NULL INTO matched FROM whaleu_ratings.replies c WHERE c.id=NEW.subject_id;
  END IF;
 ELSE RAISE EXCEPTION 'Unregistered scoped Review artifact' USING ERRCODE='23514';END IF;
 IF matched IS DISTINCT FROM true OR NEW.publication_transaction<>pg_current_xact_id() THEN RAISE EXCEPTION 'Scoped Review publication missing opposite artifact' USING ERRCODE='23514';END IF;
 actor:=(e->>'accountId')::uuid;request:=(e->>'clientRequestId')::uuid;
 -- Defined by the scoped command migration. Deferred execution means all
 -- migration functions exist before a first publication can be committed.
 PERFORM whaleu_ratings.verify_scoped_command(actor,request);
 RETURN NULL;END $$;
CREATE CONSTRAINT TRIGGER scoped_content_binding_causal AFTER INSERT ON whaleu_community.rating_scoped_content_bindings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community.rating_scoped_binding_causal();
CREATE CONSTRAINT TRIGGER scoped_definition_binding_causal AFTER INSERT ON whaleu_community.rating_scoped_target_definition_bindings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community.rating_scoped_binding_causal();
CREATE CONSTRAINT TRIGGER scoped_category_binding_causal AFTER INSERT ON whaleu_community.rating_scoped_category_source_bindings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community.rating_scoped_binding_causal();
CREATE CONSTRAINT TRIGGER scoped_category_review_reverse AFTER INSERT ON whaleu_ratings.scoped_source_attestations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community.rating_scoped_binding_causal();
CREATE CONSTRAINT TRIGGER scoped_definition_review_reverse AFTER INSERT ON whaleu_ratings.target_definition_versions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.envelope->'version'='5'::jsonb) EXECUTE FUNCTION whaleu_community.rating_scoped_binding_causal();
CREATE CONSTRAINT TRIGGER scoped_comment_review_reverse AFTER INSERT ON whaleu_ratings.comments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.envelope->'version'='5'::jsonb) EXECUTE FUNCTION whaleu_community.rating_scoped_binding_causal();
CREATE CONSTRAINT TRIGGER scoped_reply_review_reverse AFTER INSERT ON whaleu_ratings.replies DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.envelope->'version'='5'::jsonb) EXECUTE FUNCTION whaleu_community.rating_scoped_binding_causal();
