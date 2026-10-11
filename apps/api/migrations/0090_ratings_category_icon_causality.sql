-- Category icon extension: sole outer request authority, original text planner
-- projection only, complete recoverable closure and exact same-release seals.
SET LOCAL lock_timeout='5s';
SELECT pg_advisory_xact_lock(hashtextextended('whaleu:named-block-policy:v1',0));
-- Review8 fragment for 0090. No approval issuer, capability or provider seed.
-- Depends on 0088/0089. The Category owner's protocol5 command/release verifier
-- must validate media_plan.reviewEnvelopes as the COMPLETE planned composite set,
-- including dormant campus overrides, and recompute both plan digests. The
-- deferred reverse hook below intentionally calls that original owner dispatcher.

CREATE FUNCTION whaleu_community.rating_category_icon_content_shape(c jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE icon jsonb:=c->'icon';appearance jsonb:=icon->'appearance';source jsonb;BEGIN
 IF NOT coalesce(whaleu_community.rating_scoped_keys(c,ARRAY['categoryId','identityId','parentId','level','kind','systemKey','name','description','selector','baseSource','overrideSource','baseDefinitionId','overrideDefinitionId','icon'])
 AND whaleu_community.rating_scoped_ids(c,ARRAY['categoryId','identityId','baseDefinitionId'])
 AND whaleu_community.rating_scoped_nullable_id(c->'parentId') AND whaleu_community.rating_scoped_nullable_id(c->'overrideDefinitionId')
 AND whaleu_community.rating_scoped_integer(c->'level',1) AND (c->>'level')::integer<=3
 AND ((c->'parentId'='null'::jsonb)=(c->'level'='1'::jsonb))
 AND jsonb_typeof(c->'kind')='string' AND c->>'kind' ~ '^[a-z][a-z0-9_]{0,49}$'
 AND (c->'systemKey'='null'::jsonb OR jsonb_typeof(c->'systemKey')='string')
 AND jsonb_typeof(c->'name')='string' AND jsonb_typeof(c->'description')='string'
 AND whaleu_community.rating_scoped_selector_shape(c->'selector'),false) THEN RETURN false;END IF;
 source:=c->'baseSource';
 IF NOT whaleu_community.rating_scoped_keys(source,ARRAY['id','revision']) OR NOT whaleu_community.rating_scoped_ids(source,ARRAY['id','revision']) THEN RETURN false;END IF;
 source:=c->'overrideSource';
 IF source<>'null'::jsonb AND (NOT whaleu_community.rating_scoped_keys(source,ARRAY['id','revision']) OR NOT whaleu_community.rating_scoped_ids(source,ARRAY['id','revision']) OR c->'overrideDefinitionId'='null'::jsonb) THEN RETURN false;END IF;
 IF c->'selector'->>'kind'='global' AND (source<>'null'::jsonb OR c->'overrideDefinitionId'<>'null'::jsonb) THEN RETURN false;END IF;
 IF NOT coalesce(icon->>'origin' IN ('base','override') AND whaleu_community.rating_scoped_ids(icon,ARRAY['definitionId'])
 AND icon->'definitionId'=CASE icon->>'origin' WHEN 'base' THEN c->'baseDefinitionId' ELSE c->'overrideDefinitionId' END,false) THEN RETURN false;END IF;
 IF icon->>'kind'='absent' THEN
 RETURN coalesce(whaleu_community.rating_scoped_keys(icon,ARRAY['kind','origin','definitionId','evidenceId','evidenceDigest'])
 AND whaleu_community.rating_scoped_ids(icon,ARRAY['evidenceId']) AND jsonb_typeof(icon->'evidenceDigest')='string' AND icon->>'evidenceDigest' ~ '^[a-f0-9]{64}$',false);
 ELSIF icon->>'kind'='image' THEN
 RETURN coalesce(whaleu_community.rating_scoped_keys(icon,ARRAY['kind','origin','definitionId','appearance'])
 AND whaleu_community.rating_scoped_keys(appearance,ARRAY['appearanceId','assetId','manifestDigest','actorId','categoryId','identityId','origin'])
 AND whaleu_community.rating_scoped_ids(appearance,ARRAY['appearanceId','assetId','actorId','categoryId','identityId'])
 AND jsonb_typeof(appearance->'manifestDigest')='string' AND appearance->>'manifestDigest' ~ '^[a-f0-9]{64}$'
 AND appearance->'categoryId'=c->'categoryId' AND appearance->'identityId'=c->'identityId'
 AND appearance->'origin'->>'kind'=icon->>'origin'
 AND CASE icon->>'origin' WHEN 'base' THEN whaleu_community.rating_scoped_keys(appearance->'origin',ARRAY['kind'])
 ELSE whaleu_community.rating_scoped_keys(appearance->'origin',ARRAY['kind','campusId']) AND whaleu_community.rating_scoped_ids(appearance->'origin',ARRAY['campusId'])
 AND c->'selector'->>'kind'='campus' AND appearance->'origin'->'campusId'=c->'selector'->'campusId' END,false);
 END IF;RETURN false;
EXCEPTION WHEN OTHERS THEN RETURN false;END$$;

CREATE FUNCTION whaleu_community.rating_category_icon_envelope_shape(e jsonb,op text) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE context jsonb:=e->'context';BEGIN
 RETURN coalesce(whaleu_community.rating_scoped_keys(e,ARRAY['version','purpose','accountId','clientRequestId','operation','intentHash','textHash','textPlanDigest','mediaPlanDigest','beforeSnapshot','context','definitionId','definitionDigest','content','assetIds'])
 AND e->'version'='8'::jsonb AND op='publish_rating_category_icon' AND e->>'purpose'=op
 AND whaleu_ratings.category_management_operation(e->>'operation')
 AND whaleu_community.rating_scoped_ids(e,ARRAY['accountId','clientRequestId','definitionId'])
 AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['intentHash','textHash','textPlanDigest','mediaPlanDigest','beforeSnapshot','definitionDigest']) k WHERE jsonb_typeof(e->k) IS DISTINCT FROM 'string' OR (e->>k) !~ '^[a-f0-9]{64}$')
 AND whaleu_community.rating_scoped_keys(context,ARRAY['id','digest','protocolGeneration','topologySnapshotId','sourceDigest'])
 AND whaleu_community.rating_scoped_ids(context,ARRAY['id','protocolGeneration'])
 AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['digest','sourceDigest']) k WHERE jsonb_typeof(context->k) IS DISTINCT FROM 'string' OR (context->>k) !~ '^[a-f0-9]{64}$')
 AND whaleu_community.rating_scoped_nullable_id(context->'topologySnapshotId')
 AND (e->'content'->'selector'->>'kind'<>'campus' OR context->'topologySnapshotId'<>'null'::jsonb)
 AND whaleu_community.rating_category_icon_content_shape(e->'content')
 AND e->>'definitionDigest'=whaleu_ratings.category_icon_digest('content',e->'content')
 AND e->'assetIds'=CASE e->'content'->'icon'->>'kind' WHEN 'image' THEN jsonb_build_array(e->'content'->'icon'->'appearance'->'assetId') ELSE '[]'::jsonb END,false);
EXCEPTION WHEN OTHERS THEN RETURN false;END$$;
CREATE FUNCTION whaleu_community.rating_category_icon_approval_digest(e jsonb) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT encode(sha256(convert_to('whaleu-rating-content-approval:v8'||chr(10)||whaleu_community.content_canonical_json(e),'UTF8')),'hex')
$$;
-- Preserve every old branch and the CHECK-referenced dispatcher OID. The original
-- decision digest CHECK already dispatches by envelope_version (0045); leave it
-- intact, including its exact v1-v7 hash domains.
DO $$DECLARE definition text;BEGIN
 SELECT pg_get_functiondef('whaleu_community.rating_envelope_shape(jsonb,text)'::regprocedure) INTO definition;
 EXECUTE replace(definition,'FUNCTION whaleu_community.rating_envelope_shape(', 'FUNCTION whaleu_community.rating_envelope_shape_pre_category_icon(');
END$$;
CREATE OR REPLACE FUNCTION whaleu_community.rating_envelope_shape(e jsonb,op text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE WHEN op='publish_rating_category_icon' THEN whaleu_community.rating_category_icon_envelope_shape(e,op)
 ELSE whaleu_community.rating_envelope_shape_pre_category_icon(e,op) END
$$;
ALTER TABLE whaleu_community.rating_approval_decisions DROP CONSTRAINT rating_decision_protocol_v7;
ALTER TABLE whaleu_community.rating_approval_decisions ADD CONSTRAINT rating_decision_protocol_v8 CHECK(
 (operation IN ('publish_rating_target','publish_rating_comment') AND envelope_version=1) OR (operation='publish_rating_reply' AND envelope_version=2)
 OR (operation='edit_rating_target' AND envelope_version=3) OR (operation='publish_rating_categories' AND envelope_version=4)
 OR (operation IN ('publish_rating_target_scoped','edit_rating_target_scoped','publish_rating_comment_scoped','publish_rating_reply_scoped','publish_rating_category_base_scoped','publish_rating_category_override_scoped') AND envelope_version=5)
 OR (operation IN ('publish_rating_target_cover_scoped','edit_rating_target_cover_scoped') AND envelope_version=6)
 OR (operation IN ('publish_rating_comment_media_scoped','publish_rating_reply_media_scoped') AND envelope_version=7)
 OR (operation='publish_rating_category_icon' AND envelope_version=8));
ALTER TABLE whaleu_community.rating_approval_decisions ADD CONSTRAINT rating_category_icon_decision_reference UNIQUE(id,account_id,digest);
ALTER TABLE whaleu_ratings.category_icon_review_bindings ADD CONSTRAINT category_icon_review_decision_reference
 FOREIGN KEY(decision_id,account_id,approval_digest) REFERENCES whaleu_community.rating_approval_decisions(id,account_id,digest);
ALTER TABLE whaleu_ratings.category_icon_review_bindings ADD CONSTRAINT category_icon_review_exact_envelope CHECK(
 whaleu_community.rating_category_icon_envelope_shape(envelope,'publish_rating_category_icon')
 AND envelope->>'accountId'=account_id::text AND envelope->>'clientRequestId'=request_id::text
 AND envelope->>'definitionId'=definition_id::text AND envelope->>'definitionDigest'=definition_digest
 AND approval_digest=whaleu_community.rating_category_icon_approval_digest(envelope));

CREATE FUNCTION whaleu_community.rating_category_icon_decision_current(_decision uuid,_consume boolean) RETURNS boolean LANGUAGE sql AS $$
 WITH instant AS MATERIALIZED (SELECT clock_timestamp() now)
 SELECT coalesce((SELECT d.envelope_version=8 AND whaleu_community.rating_category_icon_envelope_shape(d.envelope,d.operation)
 AND d.digest=whaleu_community.rating_category_icon_approval_digest(d.envelope)
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
-- Immutable provenance only. This is deliberately not a replacement for the
-- original current source/catalog/release predicates, nor Media safety current.
CREATE FUNCTION whaleu_community.rating_category_icon_immutable_refs_match(e jsonb) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE c jsonb:=e->'content';icon jsonb:=c->'icon';appearance jsonb:=icon->'appearance';
 b whaleu_ratings.category_icon_definitions;o whaleu_ratings.category_icon_definitions;chosen whaleu_ratings.category_icon_definitions;
BEGIN
 IF NOT whaleu_community.rating_category_icon_envelope_shape(e,'publish_rating_category_icon') THEN RETURN false;END IF;
 SELECT * INTO b FROM whaleu_ratings.category_icon_definitions WHERE id=(c->>'baseDefinitionId')::uuid;
 IF NOT FOUND OR (b.category_id,b.identity_id,b.kind,b.base_source_id,b.base_source_revision,b.text_source_id,b.text_source_revision)
 IS DISTINCT FROM ((c->>'categoryId')::uuid,(c->>'identityId')::uuid,'base'::text,(c->'baseSource'->>'id')::uuid,(c->'baseSource'->>'revision')::uuid,(c->'baseSource'->>'id')::uuid,(c->'baseSource'->>'revision')::uuid) THEN RETURN false;END IF;
 IF c->'overrideDefinitionId'<>'null'::jsonb THEN
 SELECT * INTO o FROM whaleu_ratings.category_icon_definitions WHERE id=(c->>'overrideDefinitionId')::uuid;
 IF NOT FOUND OR (o.category_id,o.identity_id,o.kind,o.campus_id,o.base_source_id,o.base_source_revision,o.text_source_id,o.text_source_revision)
 IS DISTINCT FROM ((c->>'categoryId')::uuid,(c->>'identityId')::uuid,'override'::text,(c->'selector'->>'campusId')::uuid,(c->'baseSource'->>'id')::uuid,(c->'baseSource'->>'revision')::uuid,(c->'overrideSource'->>'id')::uuid,(c->'overrideSource'->>'revision')::uuid) THEN RETURN false;END IF;
 END IF;
 IF icon->>'origin'='base' THEN
 IF o.id IS NOT NULL AND o.value IS DISTINCT FROM '{"kind":"inherit"}'::jsonb THEN RETURN false;END IF;chosen:=b;
 ELSE IF o.id IS NULL THEN RETURN false;END IF;chosen:=o;END IF;
 IF chosen.id::text IS DISTINCT FROM icon->>'definitionId' OR chosen.value IS DISTINCT FROM icon-ARRAY['origin','definitionId'] THEN RETURN false;END IF;
 IF icon->>'kind'='absent' THEN RETURN chosen.appearance_id IS NULL;END IF;
 RETURN chosen.appearance_id=(appearance->>'appearanceId')::uuid AND EXISTS(
 SELECT 1 FROM whaleu_ratings.category_icon_appearances a JOIN whaleu_media.assets asset ON asset.id=a.asset_id
 JOIN whaleu_media.bindings binding ON binding.id=a.media_binding_id
 WHERE a.id=chosen.appearance_id AND (a.asset_id,a.category_id,a.identity_id,a.actor_id,a.manifest_digest,a.origin)
 =((appearance->>'assetId')::uuid,(appearance->>'categoryId')::uuid,(appearance->>'identityId')::uuid,(appearance->>'actorId')::uuid,appearance->>'manifestDigest',appearance->'origin')
 AND asset.actor_id=a.actor_id AND asset.owner_kind='ratings' AND asset.resource_kind='category_icon' AND asset.slot='icon'
 AND asset.manifest_digest=a.manifest_digest AND asset.manifest_digest=encode(sha256(convert_to(E'whaleu-media-manifest:v1\n'||whaleu_media.canonical_json(asset.manifest),'UTF8')),'hex')
 AND binding.asset_id=asset.id AND binding.owner_kind='ratings' AND binding.resource_kind='category_icon' AND binding.resource_id=a.id AND binding.content_version=1 AND binding.slot='icon' AND binding.ordinal=0 AND binding.manifest_digest=a.manifest_digest);
EXCEPTION WHEN OTHERS THEN RETURN false;END$$;

CREATE FUNCTION whaleu_community.rating_category_icon_decision_used(_decision uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(
 SELECT 1 FROM whaleu_community.rating_approval_bindings WHERE decision_id=_decision
 UNION ALL SELECT 1 FROM whaleu_community.rating_target_definition_bindings WHERE decision_id=_decision
 UNION ALL SELECT 1 FROM whaleu_community.rating_category_base_bindings WHERE decision_id=_decision
 UNION ALL SELECT 1 FROM whaleu_community.rating_scoped_content_bindings WHERE decision_id=_decision
 UNION ALL SELECT 1 FROM whaleu_community.rating_scoped_target_definition_bindings WHERE decision_id=_decision
 UNION ALL SELECT 1 FROM whaleu_community.rating_scoped_category_source_bindings WHERE decision_id=_decision
 UNION ALL SELECT 1 FROM whaleu_community.rating_target_cover_definition_bindings WHERE decision_id=_decision
 UNION ALL SELECT 1 FROM whaleu_community.rating_discussion_media_bindings WHERE decision_id=_decision
 UNION ALL SELECT 1 FROM whaleu_ratings.category_icon_review_bindings WHERE decision_id=_decision)
$$;
CREATE FUNCTION whaleu_community.rating_category_icon_binding_validate() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d whaleu_community.rating_approval_decisions;p whaleu_ratings.scoped_command_preparations;
 ip whaleu_ratings.category_icon_preparations;context_row whaleu_ratings.scoped_contexts;instant timestamptz;BEGIN
 SELECT * INTO d FROM whaleu_community.rating_approval_decisions WHERE id=NEW.decision_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Category icon Review decision missing' USING ERRCODE='23514';END IF;
 PERFORM id FROM whaleu_identity.accounts WHERE id=d.account_id FOR SHARE;
 PERFORM decision_id FROM whaleu_community.rating_approval_heads WHERE decision_id=d.id FOR SHARE;instant:=clock_timestamp();
 SELECT * INTO p FROM whaleu_ratings.scoped_command_preparations WHERE account_id=NEW.account_id AND request_id=NEW.request_id;
 SELECT * INTO ip FROM whaleu_ratings.category_icon_preparations WHERE actor_id=NEW.account_id AND request_id=NEW.request_id;
 SELECT * INTO context_row FROM whaleu_ratings.scoped_contexts WHERE id=p.context_id;
 IF NOT coalesce(whaleu_community.rating_category_icon_envelope_shape(NEW.envelope,'publish_rating_category_icon')
 AND d.envelope_version=8 AND d.operation='publish_rating_category_icon'
 AND (NEW.account_id,NEW.approval_digest,NEW.envelope)=(d.account_id,d.digest,d.envelope)
 AND NEW.definition_id::text=NEW.envelope->>'definitionId' AND NEW.definition_digest=NEW.envelope->>'definitionDigest'
 AND NEW.request_id::text=NEW.envelope->>'clientRequestId' AND NEW.publication_transaction=pg_current_xact_id()
 AND p.intent->'protocolVersion'='5'::jsonb AND p.operation=NEW.envelope->>'operation' AND p.intent_hash=NEW.envelope->>'intentHash'
 AND NEW.envelope->'context'=jsonb_build_object('id',context_row.id,'digest',context_row.record_digest,'protocolGeneration',context_row.context->'protocolGeneration','topologySnapshotId',context_row.authority->'topologySnapshotId','sourceDigest',context_row.context->'sourceDigest')
 AND context_row.account_id=NEW.account_id AND p.context_id::text=NEW.envelope->'context'->>'id' AND ip.outer_hash=p.intent_hash AND ip.text_hash=NEW.envelope->>'textHash'
 AND ip.before_snapshot=NEW.envelope->>'beforeSnapshot' AND NOT ip.noop
 AND jsonb_typeof(ip.media_plan->'reviewEnvelopes')='array'
 AND EXISTS(SELECT 1 FROM jsonb_array_elements(ip.media_plan->'reviewEnvelopes') planned WHERE planned=NEW.envelope)
 AND whaleu_community.rating_category_icon_decision_current(d.id,true)
 AND whaleu_community.rating_category_icon_immutable_refs_match(NEW.envelope),false)
 OR EXISTS(SELECT 1 FROM whaleu_community.rating_approval_decisions n WHERE n.account_id=d.account_id AND n.operation=d.operation AND n.envelope_version=d.envelope_version AND n.digest=d.digest AND (n.evaluated_at,n.id)>(d.evaluated_at,d.id))
 OR whaleu_community.rating_category_icon_decision_used(d.id)
 THEN RAISE EXCEPTION 'Category icon exact Review consumption mismatch' USING ERRCODE='23514';END IF;
 NEW.bound_at:=instant;RETURN NEW;
END$$;
CREATE TRIGGER category_icon_review_validate BEFORE INSERT ON whaleu_ratings.category_icon_review_bindings FOR EACH ROW EXECUTE FUNCTION whaleu_community.rating_category_icon_binding_validate();
-- 0088 already installs BEFORE STATEMENT scoped_public_writer_gate and Category
-- epoch on INSERT/UPDATE/DELETE/TRUNCATE, plus immutable/retain guards. This extra
-- binding epoch integrates raw and zero-row writes with Review's shared owner.
CREATE TRIGGER a02_category_icon_review_binding_epoch BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_ratings.category_icon_review_bindings FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.advance_rating_review_binding_epoch();

-- Backward namespace guard reads ONLY the old decision table. Old schema/old
-- protocol queries never touch Category icon tables, including the old facades.
-- Existing exact-version checks/FKs still enforce each old namespace normally.
CREATE FUNCTION whaleu_community.rating_category_icon_legacy_binding_namespace() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF EXISTS(SELECT 1 FROM whaleu_community.rating_approval_decisions WHERE id=NEW.decision_id AND envelope_version=8) THEN
 RAISE EXCEPTION 'Category icon Review cannot be consumed by an older namespace' USING ERRCODE='23514';END IF;RETURN NEW;
END$$;
DO $$DECLARE tab text;BEGIN
 FOREACH tab IN ARRAY ARRAY['rating_approval_bindings','rating_target_definition_bindings','rating_category_base_bindings','rating_scoped_content_bindings','rating_scoped_target_definition_bindings','rating_scoped_category_source_bindings','rating_target_cover_definition_bindings','rating_discussion_media_bindings'] LOOP
 EXECUTE format('CREATE TRIGGER a00_category_icon_review_namespace BEFORE INSERT ON whaleu_community.%I FOR EACH ROW EXECUTE FUNCTION whaleu_community.rating_category_icon_legacy_binding_namespace()',tab);
 END LOOP;
END$$;
CREATE FUNCTION whaleu_community.rating_category_icon_definition_current(_definition uuid,_digest text,_envelope jsonb) RETURNS boolean LANGUAGE sql AS $$
 SELECT coalesce((SELECT b.definition_digest=_digest AND b.envelope=_envelope
 AND whaleu_community.rating_category_icon_envelope_shape(_envelope,'publish_rating_category_icon')
 AND b.definition_id::text=_envelope->>'definitionId' AND b.definition_digest=_envelope->>'definitionDigest'
 AND b.account_id::text=_envelope->>'accountId' AND b.request_id::text=_envelope->>'clientRequestId'
 AND (d.account_id,d.envelope_version,d.operation,d.digest,d.envelope)=(b.account_id,8,'publish_rating_category_icon'::text,b.approval_digest,b.envelope)
 AND b.approval_digest=whaleu_community.rating_category_icon_approval_digest(b.envelope)
 AND isfinite(b.bound_at) AND b.bound_at>=d.evaluated_at AND b.bound_at<=clock_timestamp()
 AND whaleu_community.rating_category_icon_decision_current(b.decision_id,false)
 AND whaleu_community.rating_category_icon_immutable_refs_match(b.envelope)
 FROM whaleu_ratings.category_icon_review_bindings b JOIN whaleu_community.rating_approval_decisions d ON d.id=b.decision_id WHERE b.definition_id=_definition),false)
$$;
CREATE FUNCTION whaleu_ratings.category_icon_review_causal() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF NEW.publication_transaction IS DISTINCT FROM pg_current_xact_id() THEN RAISE EXCEPTION 'Category icon Review publication transaction mismatch' USING ERRCODE='23514';END IF;
 PERFORM whaleu_ratings.verify_category_management_command(NEW.account_id,NEW.request_id);RETURN NULL;
END$$;
CREATE CONSTRAINT TRIGGER category_icon_review_causal AFTER INSERT ON whaleu_ratings.category_icon_review_bindings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.category_icon_review_causal();
-- Integration contract: the new command/release verifier MUST reject a Review
-- binding not represented exactly once by its planned composite definition,
-- require every changed planned composite (including dormant roots) to be bound,
-- and require every published projection to name that exact binding/definition
-- digest at its original release/catalog/category/effective_revision. A metadata
-- command reuses an unchanged binding and MUST NOT consume a new Review. New
-- sources still consume independent exact Review5 with assetIds=[]. No request,
-- receipt, or grant is created for textHash.

CREATE FUNCTION whaleu_ratings.category_icon_root_key(root jsonb) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT whaleu_community.content_canonical_json(jsonb_build_array(root->'kind',root->'categoryId',CASE WHEN root->>'kind'='base' THEN root->'source' ELSE root->'baseSource' END,CASE WHEN root->>'kind'='override' THEN root->'campusId' ELSE 'null'::jsonb END))
$$;
CREATE FUNCTION whaleu_ratings.category_icon_root_body(root jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE STRICT AS $$ SELECT root-ARRAY['scopeKeys','retention'] $$;
CREATE FUNCTION whaleu_ratings.category_icon_stored_roots() RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT coalesce(jsonb_agg(root ORDER BY whaleu_ratings.category_icon_root_key(root) COLLATE "C"),'[]'::jsonb) FROM(
 SELECT CASE WHEN d.kind='base' THEN jsonb_build_object('kind',d.kind,'definitionId',d.id,'categoryId',d.category_id,'identityId',d.identity_id,'source',jsonb_build_object('id',d.base_source_id,'revision',d.base_source_revision),'value',d.value,'scopeKeys',h.scope_keys,'retention',h.retention)
 ELSE jsonb_build_object('kind',d.kind,'definitionId',d.id,'categoryId',d.category_id,'identityId',d.identity_id,'source',CASE WHEN d.text_source_id IS NULL THEN NULL ELSE jsonb_build_object('id',d.text_source_id,'revision',d.text_source_revision) END,'baseSource',jsonb_build_object('id',d.base_source_id,'revision',d.base_source_revision),'campusId',d.campus_id,'value',d.value,'scopeKeys',h.scope_keys,'retention',h.retention) END root
 FROM whaleu_ratings.category_icon_definition_heads h JOIN whaleu_ratings.category_icon_definitions d ON d.id=h.definition_id) roots
$$;
-- A source without media coverage is UNKNOWN, never explicit absence. Virtual
-- unknown roots have deterministic IDs and cannot authorize any bytes or erase
-- an obligation. Authorized replace/clear can supersede them without reading it.
CREATE FUNCTION whaleu_ratings.category_icon_value_equal(a jsonb,b jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT (a->>'kind'='absent' AND b->>'kind'='absent') OR a=b $$;
CREATE FUNCTION whaleu_ratings.category_icon_absence(actor uuid,request uuid,outer_hash text,key text) RETURNS jsonb LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT jsonb_build_object('kind','absent','evidenceId',whaleu_ratings.category_management_artifact(outer_hash,'category-icon-absence:'||key),'evidenceDigest',whaleu_ratings.category_icon_digest('explicit-absence',jsonb_build_object('actor',actor,'requestId',request,'outerHash',outer_hash,'key',key)))
$$;
CREATE FUNCTION whaleu_ratings.category_icon_root_shape(root jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$DECLARE v jsonb:=root->'value';keys text[];BEGIN
 keys:=ARRAY['kind','definitionId','categoryId','identityId','source','scopeKeys','retention','value'];IF root->>'kind'='override' THEN keys:=keys||ARRAY['baseSource','campusId'];ELSIF root->>'kind'<>'base' THEN RETURN false;END IF;
 IF NOT whaleu_community.rating_scoped_keys(root,keys) OR NOT whaleu_community.rating_scoped_ids(root,ARRAY['definitionId','categoryId','identityId']) OR root->>'retention' NOT IN ('current','dormant','archived') OR NOT whaleu_ratings.scoped_scope_keys_valid(ARRAY(SELECT jsonb_array_elements_text(root->'scopeKeys'))) THEN RETURN false;END IF;
 IF root->>'kind'='base' AND NOT (whaleu_community.rating_scoped_keys(root->'source',ARRAY['id','revision']) AND whaleu_community.rating_scoped_ids(root->'source',ARRAY['id','revision'])) THEN RETURN false;END IF;
 IF root->>'kind'='override' AND (NOT whaleu_community.rating_scoped_ids(root,ARRAY['campusId']) OR NOT whaleu_community.rating_scoped_keys(root->'baseSource',ARRAY['id','revision']) OR NOT whaleu_community.rating_scoped_ids(root->'baseSource',ARRAY['id','revision']) OR NOT (root->'source'='null'::jsonb OR (whaleu_community.rating_scoped_keys(root->'source',ARRAY['id','revision']) AND whaleu_community.rating_scoped_ids(root->'source',ARRAY['id','revision'])))) THEN RETURN false;END IF;
 IF v->>'kind'='unresolved' THEN RETURN whaleu_community.rating_scoped_keys(v,ARRAY['kind','reason']) AND v->>'reason' IN ('legacy_unknown','missing_coverage','conflicting_sources');
 ELSIF v->>'kind'='inherit' THEN RETURN root->>'kind'='override' AND whaleu_community.rating_scoped_keys(v,ARRAY['kind']);
 ELSIF v->>'kind'='absent' THEN RETURN whaleu_community.rating_scoped_keys(v,ARRAY['kind','evidenceId','evidenceDigest']) AND whaleu_community.rating_scoped_ids(v,ARRAY['evidenceId']) AND v->>'evidenceDigest' ~ '^[a-f0-9]{64}$';
 ELSIF v->>'kind'='image' THEN RETURN whaleu_community.rating_scoped_keys(v,ARRAY['kind','appearance']) AND whaleu_community.rating_scoped_keys(v->'appearance',ARRAY['appearanceId','assetId','manifestDigest','actorId','categoryId','identityId','origin']) AND whaleu_community.rating_scoped_ids(v->'appearance',ARRAY['appearanceId','assetId','actorId','categoryId','identityId']) AND v->'appearance'->>'manifestDigest' ~ '^[a-f0-9]{64}$' AND (v->'appearance'->'categoryId',v->'appearance'->'identityId')=(root->'categoryId',root->'identityId') AND v->'appearance'->'origin'=CASE WHEN root->>'kind'='base' THEN jsonb_build_object('kind','base') ELSE jsonb_build_object('kind','override','campusId',root->'campusId') END;END IF;RETURN false;
EXCEPTION WHEN others THEN RETURN false;END$$;
CREATE FUNCTION whaleu_ratings.category_icon_roots_valid(roots jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT coalesce(jsonb_typeof(roots)='array' AND jsonb_array_length(roots)<=100000 AND octet_length(whaleu_community.content_canonical_json(roots))<=67108864
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(roots) r WHERE NOT whaleu_ratings.category_icon_root_shape(r))
 AND (SELECT count(*)=count(DISTINCT r->>'definitionId') AND count(*)=count(DISTINCT whaleu_ratings.category_icon_root_key(r)) FROM jsonb_array_elements(roots) r)
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(roots) r WHERE r->>'kind'='override' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(roots) b WHERE b->>'kind'='base' AND (b->'categoryId',b->'identityId',b->'source')=(r->'categoryId',r->'identityId',r->'baseSource'))),false)
$$;
CREATE FUNCTION whaleu_ratings.category_icon_planned_image(p whaleu_ratings.scoped_command_preparations,ip whaleu_ratings.category_icon_preparations,edit jsonb,root jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE upload jsonb;origin jsonb;appearance jsonb;slot text;BEGIN
 SELECT value INTO STRICT upload FROM jsonb_array_elements(ip.media_plan->'plan'->'uploads') WHERE value->'assetId'=edit->'assetId' AND value->'uploadScopeId'=edit->'uploadScopeId';
 origin:=CASE WHEN root->>'kind'='base' THEN jsonb_build_object('kind','base') ELSE jsonb_build_object('kind','override','campusId',root->'campusId') END;
 IF upload->>'actorId'<>p.account_id::text OR (upload->'categoryId',upload->'identityId',upload->'origin') IS DISTINCT FROM (root->'categoryId',root->'identityId',origin) OR upload->>'textHash'<>ip.text_hash THEN RAISE EXCEPTION 'Icon upload slot mismatch' USING ERRCODE='23514';END IF;
 slot:=root->>'categoryId'||':'||whaleu_community.content_canonical_json(origin);
 appearance:=jsonb_build_object('appearanceId',whaleu_ratings.category_management_artifact(ip.outer_hash,'category-icon-appearance:'||slot),'assetId',upload->'assetId','manifestDigest',upload->'manifestDigest','actorId',p.account_id,'categoryId',root->'categoryId','identityId',root->'identityId','origin',origin);
 RETURN jsonb_build_object('kind','image','appearance',appearance);
END$$;
CREATE FUNCTION whaleu_ratings.category_icon_expected_roots(p whaleu_ratings.scoped_command_preparations,ip whaleu_ratings.category_icon_preparations) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE roots jsonb:='{}';before jsonb:=ip.media_plan->'plan'->'beforeRoots';item jsonb;root jsonb;old jsonb;next jsonb;base jsonb;prior jsonb;preds jsonb;allbases jsonb;v jsonb;chosen jsonb;edit jsonb;edits jsonb:='[]';entry jsonb;scope text;source jsonb;origin jsonb;key text;category text;campus text;merging boolean;countbase integer;n integer;BEGIN
 FOR root IN SELECT value FROM jsonb_array_elements(before) LOOP roots:=roots||jsonb_build_object(whaleu_ratings.category_icon_root_key(root),root);END LOOP;
 FOR item IN SELECT value FROM jsonb_array_elements(p.category_plan->'sourceIssues') WHERE value->>'kind'='scoped_category_base' LOOP
 category:=item->'payload'->>'categoryId';source:=jsonb_build_object('id',item->'id','revision',item->'revision');
 SELECT coalesce(jsonb_agg(entry.value ORDER BY entry.key COLLATE "C"),'[]'::jsonb) INTO allbases FROM jsonb_each(roots) entry WHERE value->>'kind'='base' AND value->>'categoryId'=category;
 countbase:=jsonb_array_length(allbases);merging:=p.operation='set_category_scope_scoped' AND countbase>1 AND (SELECT count(*) FROM jsonb_array_elements(p.category_plan->'sourceIssues') x WHERE x->>'kind'='scoped_category_base' AND x->'payload'->>'categoryId'=category)=1;
 SELECT coalesce(jsonb_agg(value),'[]'::jsonb) INTO preds FROM jsonb_array_elements(allbases) WHERE merging OR value->'source'->'id'=item->'payload'->'previousBaseSourceId';
 IF item->'payload'->>'previousBaseSourceId' IS NOT NULL AND jsonb_array_length(preds)=0 THEN RAISE EXCEPTION 'Missing icon predecessor closure' USING ERRCODE='23514';END IF;
 IF jsonb_array_length(preds)=0 THEN chosen:=whaleu_ratings.category_icon_absence(p.account_id,p.request_id,ip.outer_hash,'create:'||category);
 ELSE chosen:=preds->0->'value';END IF;
 IF merging THEN
 IF chosen->>'kind'='unresolved' OR EXISTS(SELECT 1 FROM jsonb_array_elements(preds) x WHERE x->'value'->>'kind'='unresolved' OR NOT whaleu_ratings.category_icon_value_equal(x->'value',chosen)) THEN RAISE EXCEPTION 'Conflicting or unknown base icon lineage' USING ERRCODE='23514';END IF;
 FOR campus IN SELECT DISTINCT value->>'campusId' FROM jsonb_each(roots) WHERE value->>'kind'='override' AND value->>'categoryId'=category LOOP
 v:=NULL;
 FOR prior IN SELECT value FROM jsonb_array_elements(preds) LOOP
 SELECT value->'value' INTO edit FROM jsonb_each(roots) WHERE value->>'kind'='override' AND value->>'categoryId'=category AND value->>'campusId'=campus AND value->'baseSource'=prior->'source';
 edit:=coalesce(edit,jsonb_build_object('kind','inherit'));
 IF edit->>'kind'='unresolved' OR (v IS NOT NULL AND NOT whaleu_ratings.category_icon_value_equal(v,edit)) THEN RAISE EXCEPTION 'Conflicting dormant icon overrides' USING ERRCODE='23514';END IF;v:=edit;
 END LOOP;END LOOP;END IF;
 next:=jsonb_build_object('kind','base','definitionId',whaleu_ratings.category_management_artifact(ip.outer_hash,'category-icon-definition:base:'||(item->>'id')),'categoryId',category,'identityId',item->'payload'->'identityId','source',source,'scopeKeys',item->'scopeKeys','retention',coalesce(preds->0->>'retention','current'),'value',chosen);
 FOR prior IN SELECT value FROM jsonb_array_elements(preds) LOOP
 roots:=roots-whaleu_ratings.category_icon_root_key(prior);
 FOR old IN SELECT value FROM jsonb_each(roots) WHERE value->>'kind'='override' AND value->'baseSource'=prior->'source' LOOP
 roots:=roots-whaleu_ratings.category_icon_root_key(old);
 root:=old||jsonb_build_object('definitionId',whaleu_ratings.category_management_artifact(ip.outer_hash,'category-icon-definition:override:'||(item->>'id')||':'||(old->>'campusId')),'baseSource',source,'retention',CASE WHEN old->>'retention'='archived' THEN 'archived' WHEN item->'scopeKeys' ? ('campus:'||(old->>'campusId')) THEN 'current' ELSE 'dormant' END);
 key:=whaleu_ratings.category_icon_root_key(root);
 IF roots ? key AND NOT whaleu_ratings.category_icon_value_equal(roots->key->'value',root->'value') THEN RAISE EXCEPTION 'Ambiguous icon override successor' USING ERRCODE='23514';END IF;
 roots:=roots||jsonb_build_object(key,root);
 END LOOP;END LOOP;
 roots:=roots||jsonb_build_object(whaleu_ratings.category_icon_root_key(next),next);
 END LOOP;
 FOR item IN SELECT value FROM jsonb_array_elements(p.category_plan->'sourceIssues') WHERE value->>'kind'='scoped_category_override' LOOP
 category:=item->'payload'->>'categoryId';campus:=substring(item->'scopeKeys'->>0 from 8);
 IF jsonb_array_length(item->'scopeKeys')<>1 OR item->'scopeKeys'->>0 NOT LIKE 'campus:%' THEN RAISE EXCEPTION 'Icon override source is not exact campus' USING ERRCODE='23514';END IF;
 source:=jsonb_build_object('id',item->'payload'->'baseSourceId','revision',item->'payload'->'baseSourceRevision');
 SELECT value INTO STRICT base FROM jsonb_each(roots) WHERE value->>'kind'='base' AND value->>'categoryId'=category AND value->'source'=source;
 SELECT value INTO old FROM jsonb_each(roots) WHERE value->>'kind'='override' AND value->>'categoryId'=category AND value->>'campusId'=campus AND value->'baseSource'=source;
 root:=jsonb_build_object('kind','override','definitionId',whaleu_ratings.category_management_artifact(ip.outer_hash,'category-icon-definition:override-source:'||(item->>'id')),'categoryId',category,'identityId',base->'identityId','source',jsonb_build_object('id',item->'id','revision',item->'revision'),'baseSource',source,'campusId',campus,'scopeKeys',item->'scopeKeys','retention',coalesce(old->>'retention','current'),'value',coalesce(old->'value',jsonb_build_object('kind','inherit')));
 IF old IS NOT NULL THEN roots:=roots-whaleu_ratings.category_icon_root_key(old);END IF;roots:=roots||jsonb_build_object(whaleu_ratings.category_icon_root_key(root),root);
 END LOOP;
 IF p.operation IN ('create_categories_scoped','batch_update_subcategories_scoped') THEN
 FOR entry IN SELECT value FROM jsonb_array_elements(p.intent->'payload'->CASE WHEN p.operation='create_categories_scoped' THEN 'nodes' ELSE 'addNodes' END) LOOP
 edits:=edits||jsonb_build_array(jsonb_build_object('categoryId',whaleu_ratings.category_management_artifact(ip.text_hash,'category:'||(entry->>'key')),'edit',entry->'icon'));
 END LOOP;
 ELSIF p.operation='create_system_category_scoped' THEN edits:=jsonb_build_array(jsonb_build_object('categoryId',whaleu_ratings.category_management_artifact(ip.text_hash,'category:root'),'edit',p.intent->'payload'->'icon'));
 ELSIF p.operation='edit_category_base_scoped' THEN edits:=jsonb_build_array(jsonb_build_object('categoryId',p.intent->'payload'->'categoryId','edit',p.intent->'payload'->'icon'));END IF;
 FOR entry IN SELECT value FROM jsonb_array_elements(edits) LOOP
 n:=0;edit:=entry->'edit';
 FOR root IN SELECT value FROM jsonb_each(roots) WHERE value->>'kind'='base' AND value->'categoryId'=entry->'categoryId' LOOP
 n:=n+1;key:=whaleu_ratings.category_icon_root_key(root);
 IF edit->>'mode'='keep' THEN IF root->'value'->>'kind'='unresolved' THEN RAISE EXCEPTION 'Cannot keep unknown icon' USING ERRCODE='23514';END IF;CONTINUE;END IF;
 v:=CASE WHEN edit->>'mode'='clear' THEN whaleu_ratings.category_icon_absence(p.account_id,p.request_id,ip.outer_hash,key) ELSE whaleu_ratings.category_icon_planned_image(p,ip,edit,root) END;
 IF NOT whaleu_ratings.category_icon_value_equal(root->'value',v) THEN root:=root||jsonb_build_object('definitionId',whaleu_ratings.category_management_artifact(ip.outer_hash,'category-icon-definition:'||key),'value',v);roots:=roots||jsonb_build_object(key,root);END IF;
 END LOOP;IF n=0 THEN RAISE EXCEPTION 'Category icon base slot absent' USING ERRCODE='23514';END IF;END LOOP;
 IF p.operation='set_category_override_scoped' THEN
 category:=p.intent->'payload'->>'categoryId';campus:=p.intent->'context'->'selector'->>'campusId';scope:='campus:'||campus;edit:=p.intent->'payload'->'icon';
 SELECT l.proof INTO STRICT entry FROM jsonb_array_elements(p.category_plan->'beforeHeads') h JOIN whaleu_ratings.scoped_category_lineage l ON l.catalog_id=(h->>'catalogRevision')::uuid WHERE h->>'scopeKey'=scope AND l.category_id=category::uuid;
 source:=jsonb_build_object('id',entry->'baseSourceId','revision',entry->'baseSourceRevision');
 SELECT value INTO STRICT base FROM jsonb_each(roots) WHERE value->>'kind'='base' AND value->>'categoryId'=category AND value->'source'=source;
 SELECT value INTO root FROM jsonb_each(roots) WHERE value->>'kind'='override' AND value->>'categoryId'=category AND value->>'campusId'=campus AND value->'baseSource'=source;
 IF root IS NOT NULL OR edit->>'mode'<>'inherit' THEN
 IF root IS NULL THEN root:=jsonb_build_object('kind','override','definitionId',whaleu_ratings.category_management_artifact(ip.outer_hash,'category-icon-definition:override:'||(source->>'id')||':'||campus),'categoryId',category,'identityId',base->'identityId','campusId',campus,'baseSource',source,'source',CASE WHEN entry->'overrideSourceId'='null'::jsonb THEN 'null'::jsonb ELSE jsonb_build_object('id',entry->'overrideSourceId','revision',entry->'overrideSourceRevision') END,'scopeKeys',jsonb_build_array(scope),'retention','current','value',jsonb_build_object('kind','inherit'));END IF;
 key:=whaleu_ratings.category_icon_root_key(root);
 IF edit->>'mode'='inherit' THEN v:=jsonb_build_object('kind','inherit');
 ELSIF edit->'value'='null'::jsonb THEN v:=whaleu_ratings.category_icon_absence(p.account_id,p.request_id,ip.outer_hash,key);
 ELSIF edit->'value'->>'mode'='keep' THEN IF root->'value'->>'kind'<>'image' THEN RAISE EXCEPTION 'Cannot keep nonimage override' USING ERRCODE='23514';END IF;v:=root->'value';
 ELSE v:=whaleu_ratings.category_icon_planned_image(p,ip,edit->'value',root);END IF;
 IF NOT whaleu_ratings.category_icon_value_equal(root->'value',v) THEN root:=root||jsonb_build_object('definitionId',whaleu_ratings.category_management_artifact(ip.outer_hash,'category-icon-definition:'||key),'value',v);END IF;
 roots:=roots||jsonb_build_object(key,root);END IF;END IF;
 RETURN (SELECT coalesce(jsonb_agg(entry.value ORDER BY entry.key COLLATE "C"),'[]'::jsonb) FROM jsonb_each(roots) entry);
END$$;
CREATE TABLE whaleu_ratings.category_icon_upload_authorizations(
 actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),client_request_id uuid NOT NULL,request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 session_id uuid NOT NULL REFERENCES whaleu_identity.sessions(id),context_id uuid NOT NULL REFERENCES whaleu_ratings.scoped_contexts(id),
 text_intent jsonb NOT NULL,text_plan jsonb NOT NULL,scope_keys text[] NOT NULL CHECK(whaleu_ratings.scoped_scope_keys_valid(scope_keys)),global_required boolean NOT NULL,
 category_id uuid NOT NULL,identity_id uuid NOT NULL,origin jsonb NOT NULL,expires_at timestamptz NOT NULL CHECK(isfinite(expires_at)),
 publication_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),PRIMARY KEY(actor_id,client_request_id)
);
CREATE TABLE whaleu_ratings.category_icon_management_review_heads(
 root_key text PRIMARY KEY,root_definition_id uuid NOT NULL REFERENCES whaleu_ratings.category_icon_definitions(id),selector jsonb NOT NULL,
 review_binding_id uuid NOT NULL REFERENCES whaleu_ratings.category_icon_review_bindings(id),mutation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id()
);
DO $$DECLARE tab text;definition text;BEGIN
 FOREACH tab IN ARRAY ARRAY['category_icon_upload_authorizations','category_icon_management_review_heads'] LOOP
 EXECUTE format('CREATE TRIGGER a00_category_icon_writer BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_ratings.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.scoped_public_writer_gate()',tab);
 EXECUTE format('CREATE TRIGGER a01_category_icon_epoch BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_ratings.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.advance_category_icon_epoch()',tab);
 EXECUTE format('CREATE TRIGGER category_icon_retain BEFORE TRUNCATE ON whaleu_ratings.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.immutable()',tab);
 END LOOP;
 CREATE TRIGGER category_icon_upload_authorization_immutable BEFORE UPDATE OR DELETE ON whaleu_ratings.category_icon_upload_authorizations FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.immutable();
 SELECT pg_get_functiondef('whaleu_ratings.category_management_plan_valid(whaleu_ratings.scoped_command_preparations,boolean)'::regprocedure) INTO definition;
 EXECUTE replace(definition,'FUNCTION whaleu_ratings.category_management_plan_valid(', 'FUNCTION whaleu_ratings.category_management_text_plan_valid_pre_icon(');
 SELECT pg_get_functiondef('whaleu_ratings.verify_category_management_command(uuid,uuid)'::regprocedure) INTO definition;
 EXECUTE replace(definition,'FUNCTION whaleu_ratings.verify_category_management_command(', 'FUNCTION whaleu_ratings.verify_category_management_command_pre_icon(');
END$$;
CREATE FUNCTION whaleu_ratings.category_icon_upload_authorization_valid(a whaleu_ratings.category_icon_upload_authorizations,current_before boolean) RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
DECLARE p whaleu_ratings.scoped_command_preparations;c whaleu_ratings.scoped_contexts;BEGIN
 p.account_id:=a.actor_id;p.request_id:=(a.text_intent->'payload'->>'clientRequestId')::uuid;p.operation:=a.text_intent->>'operation';p.intent:=a.text_intent;p.intent_hash:=whaleu_ratings.scoped_intent_hash(a.text_intent);p.context_id:=a.context_id;p.session_id:=a.session_id;p.command_family:='category';p.category_plan:=a.text_plan;p.valid_until:=a.expires_at;
 p.before_state:=jsonb_build_object('heads',a.text_plan->'beforeHeads','vector',a.text_plan->'beforeVector','digest',a.text_plan->'beforeDigest');p.policy_source_id:=(a.text_plan->>'policySourceId')::uuid;p.policy_source_revision:=(a.text_plan->>'policySourceRevision')::uuid;
 SELECT * INTO c FROM whaleu_ratings.scoped_contexts WHERE id=a.context_id;
 RETURN coalesce(a.text_intent->'protocolVersion'='2'::jsonb AND a.text_plan->>'accountId'=a.actor_id::text AND a.text_plan->>'intentHash'=p.intent_hash
 AND a.text_intent->'context'=(c.context-ARRAY['protocolVersion','actorId','purpose','mode','heads','managementSnapshot','expiresAt','operations','mediaSnapshot','capabilities'])
 AND c.context->'protocolVersion'='5'::jsonb AND c.context->>'purpose'='manage_categories' AND c.account_id=a.actor_id AND c.session_id=a.session_id
 AND c.valid_until>=a.expires_at AND whaleu_ratings.scoped_context_current(c.id,a.actor_id,a.session_id,clock_timestamp())
 AND whaleu_ratings.category_management_text_plan_valid_pre_icon(p,current_before)
 AND ARRAY(SELECT jsonb_array_elements_text(a.text_plan->'affectedScopeKeys'))<@a.scope_keys
 AND whaleu_authorization.rating_category_management_authority_covers(a.actor_id,ARRAY(SELECT substring(k from 8)::uuid FROM unnest(a.scope_keys) k WHERE k<>'global'),a.global_required)
 AND (NOT('global'=ANY(a.scope_keys)) OR a.global_required),false);
EXCEPTION WHEN others THEN RETURN false;END$$;
CREATE FUNCTION whaleu_ratings.category_icon_upload_scope_current(scope uuid,actor uuid,instant timestamptz) RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
DECLARE s whaleu_ratings.category_icon_upload_scopes;a whaleu_ratings.category_icon_upload_authorizations;BEGIN
 SELECT * INTO s FROM whaleu_ratings.category_icon_upload_scopes WHERE id=scope AND actor_id=actor;
 SELECT * INTO a FROM whaleu_ratings.category_icon_upload_authorizations WHERE actor_id=actor AND client_request_id=s.client_request_id;
 RETURN coalesce(s.expires_at>instant AND a.request_hash=s.scope_request_hash AND a.expires_at=s.expires_at
 AND (s.category_id,s.identity_id,s.origin,s.context_id,s.session_id)=(a.category_id,a.identity_id,a.origin,a.context_id,a.session_id)
 AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.category_icon_upload_scope_fences f WHERE f.actor_id=actor AND f.client_request_id=s.client_request_id)
 AND whaleu_ratings.category_icon_upload_authorization_valid(a,true),false);
END$$;
CREATE FUNCTION whaleu_ratings.category_icon_upload_scope_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a whaleu_ratings.category_icon_upload_authorizations;q whaleu_ratings.command_claims;media_input jsonb;slot jsonb;expected uuid;BEGIN
 SELECT * INTO a FROM whaleu_ratings.category_icon_upload_authorizations WHERE actor_id=NEW.actor_id AND client_request_id=NEW.client_request_id;
 SELECT * INTO q FROM whaleu_ratings.command_claims WHERE account_id=NEW.actor_id AND request_id=NEW.client_request_id;
 slot:=NEW.input->'slot';
 expected:=CASE WHEN slot->>'kind'='new' THEN whaleu_ratings.category_management_artifact(whaleu_ratings.scoped_intent_hash(a.text_intent),'category:'||(slot->>'key')) ELSE (slot->>'categoryId')::uuid END;
 media_input:=jsonb_build_object('protocol','ratings-category-icon-media-v1','clientRequestId',NEW.client_request_id,'editScopeId',NEW.id,'scopeRevision',NEW.scope_revision,'slot','icon','declaration',NEW.declaration);
 IF NOT coalesce(a.publication_transaction=pg_current_xact_id() AND whaleu_ratings.category_icon_upload_authorization_valid(a,true)
 AND q.operation='prepare_category_icon_upload_scope' AND q.intent_hash=NEW.scope_request_hash AND q.intent_hash=whaleu_ratings.category_icon_upload_scope_request_hash(NEW.input)
 AND NEW.input->'protocolVersion'='5'::jsonb AND NEW.input->>'clientRequestId'=NEW.client_request_id::text AND NEW.input->'payload'->>'clientRequestId'=NEW.command_request_id::text
 AND NEW.input->'context'->>'id'=NEW.context_id::text AND NEW.input->'declaration'=NEW.declaration
 AND a.text_intent=jsonb_build_object('protocolVersion',2,'operation',NEW.input->'operation','context',NEW.input->'context','payload',NEW.input->'payload')
 AND (NEW.category_id,NEW.identity_id,NEW.origin,NEW.context_id,NEW.session_id,NEW.expires_at,NEW.scope_request_hash)=(a.category_id,a.identity_id,a.origin,a.context_id,a.session_id,a.expires_at,a.request_hash)
 AND NEW.category_id=expected AND NEW.origin=CASE WHEN slot->>'kind'='override' THEN jsonb_build_object('kind','override','campusId',slot->'campusId') ELSE jsonb_build_object('kind','base') END
 AND NEW.scope_revision=whaleu_ratings.category_icon_digest('upload-scope',jsonb_build_object('id',NEW.id,'actorId',NEW.actor_id,'sessionId',NEW.session_id,'input',NEW.input,'categoryId',NEW.category_id,'identityId',NEW.identity_id,'origin',NEW.origin,'contextId',NEW.context_id,'expiresAt',to_char(NEW.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
 AND NEW.request_hash=whaleu_media.category_icon_request_hash(NEW.actor_id,media_input)
 AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.category_icon_upload_scope_fences f WHERE f.actor_id=NEW.actor_id AND f.client_request_id=NEW.client_request_id),false)
 THEN RAISE EXCEPTION 'Category upload scope lacks exact original owner authority and request' USING ERRCODE='23514';END IF;RETURN NEW;
END$$;
CREATE TRIGGER category_icon_upload_scope_guard BEFORE INSERT ON whaleu_ratings.category_icon_upload_scopes FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.category_icon_upload_scope_guard();
-- Explicit versioned absence proof. Missing fields are never evidence. These
-- historical predicates do not re-run expired preparation/current Review gates;
-- they verify retained immutable creation authority, not current readability.
CREATE FUNCTION whaleu_ratings.category_icon_native_text_origin(source uuid,revision uuid,category uuid,identity uuid) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE s whaleu_ratings.scoped_source_attestations;c whaleu_ratings.categories;l whaleu_ratings.catalog_category_lineage;b whaleu_ratings.category_base_versions;i whaleu_ratings.category_identities;t whaleu_ratings.category_command_transitions;p whaleu_ratings.category_command_preparations;q whaleu_ratings.requests;e whaleu_ratings.scoped_command_causes;n jsonb;nodes_receipt jsonb;catalogs_receipt jsonb;BEGIN
 SELECT * INTO s FROM whaleu_ratings.scoped_source_attestations WHERE id=source AND scoped_source_attestations.revision=category_icon_native_text_origin.revision;
 IF s.source_kind IS DISTINCT FROM 'm3a_native_bridge' OR identity<>category OR s.payload->>'categoryId'<>category::text THEN RETURN NULL;END IF;
 SELECT * INTO c FROM whaleu_ratings.categories WHERE id=category AND catalog_id=coalesce(s.payload->>'legacyAfterCatalogId',s.payload->>'legacyCatalogId')::uuid;
 SELECT * INTO l FROM whaleu_ratings.catalog_category_lineage WHERE catalog_id=c.catalog_id AND category_id=category;
 SELECT * INTO b FROM whaleu_ratings.category_base_versions WHERE category_id=category AND category_base_versions.revision=l.base_revision;
 SELECT * INTO i FROM whaleu_ratings.category_identities WHERE id=category;
 SELECT * INTO t FROM whaleu_ratings.category_command_transitions WHERE release_id=i.creation_release_id;
 SELECT * INTO p FROM whaleu_ratings.category_command_preparations WHERE account_id=t.actor_account_id AND request_id=t.request_id;
 SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=t.actor_account_id AND request_id=t.request_id;
 SELECT value INTO n FROM jsonb_array_elements(p.nodes) WHERE value->>'id'=category::text;
 SELECT jsonb_agg(value-ARRAY['name','description','scopeVersionId'] ORDER BY ord) INTO nodes_receipt FROM jsonb_array_elements(p.nodes) WITH ORDINALITY x(value,ord);
 SELECT jsonb_agg(jsonb_build_object('regionId',value->'regionId','catalogRevision',value->'afterCatalogId') ORDER BY ord) INTO catalogs_receipt FROM jsonb_array_elements(p.catalogs) WITH ORDINALITY x(value,ord);
 IF NOT coalesce(l.source_kind='native' AND (l.base_revision,l.effective_revision,c.revision)=(b.revision,b.revision,b.revision) AND c.revision::text=s.payload->>'categoryRevision'
 AND i.source_kind='native' AND i.creator_id=t.actor_account_id AND i.creation_release_id=b.release_id AND b.release_id=t.release_id AND t.release_id=p.release_id
 AND (i.creation_transaction,b.publication_transaction)=(t.mutation_transaction,t.mutation_transaction)
 AND q.operation='create_categories' AND (q.intent_hash,t.intent_hash,p.intent_hash)=(whaleu_ratings.category_intent_hash(p.intent),whaleu_ratings.category_intent_hash(p.intent),whaleu_ratings.category_intent_hash(p.intent))
 AND whaleu_ratings.category_intent_valid(p.intent) AND p.intent->'assetIds'='[]'::jsonb AND (t.intent,t.context_revision)=(p.intent,p.context_revision)
 AND p.envelope=whaleu_ratings.category_envelope(p) AND b.envelope=p.envelope
 AND n->>'revision'=b.revision::text AND (n->>'name',n->>'description',n->>'level',n->>'scopeVersionId')=(b.name,b.description,b.level::text,b.scope_version_id::text)
 AND (n->>'parentId')::uuid IS NOT DISTINCT FROM b.parent_id
 AND EXISTS(SELECT 1 FROM whaleu_ratings.command_claims claim WHERE claim.account_id=q.account_id AND claim.request_id=q.request_id AND claim.operation=q.operation AND claim.intent_hash=q.intent_hash)
 AND q.receipt=jsonb_build_object('requestId',q.request_id,'operation','create_categories','outcome','applied','releaseId',t.release_id,'categories',nodes_receipt,'catalogs',catalogs_receipt,'occurredAt',to_char(t.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')),false) THEN RETURN NULL;END IF;
 IF s.issuer='ratings-legacy-bridge' THEN
 SELECT * INTO e FROM whaleu_ratings.scoped_command_causes WHERE cause_kind='legacy_bridge' AND artifact_id=(s.payload->>'bridgeId')::uuid;
 IF NOT coalesce((e.account_id,e.request_id,e.proof->>'intentHash',e.mutation_transaction)=(q.account_id,q.request_id,q.intent_hash,s.publication_transaction) AND e.mutation_transaction=b.publication_transaction
 AND EXISTS(SELECT 1 FROM jsonb_array_elements(e.proof->'legacyCatalogs') x WHERE x->>'afterCatalogId'=c.catalog_id::text),false) THEN RETURN NULL;END IF;END IF;
 RETURN jsonb_build_object('version',1,'kind','next-native-strict-text','sourceId',s.id,'sourceRevision',s.revision,'sourceDigest',s.digest,'categoryId',category,'identityId',identity,'releaseId',t.release_id,'accountId',q.account_id,'requestId',q.request_id,'intentHash',q.intent_hash,'receiptDigest',whaleu_ratings.category_icon_digest('strict-text-receipt',q.receipt),'baseRevision',b.revision);
EXCEPTION WHEN others THEN RETURN NULL;END$$;
CREATE FUNCTION whaleu_ratings.category_icon_strict_text_absence(source uuid,revision uuid,category uuid,identity uuid) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE s whaleu_ratings.scoped_source_attestations;p whaleu_ratings.scoped_command_preparations;q whaleu_ratings.requests;o whaleu_ratings.scoped_command_outcomes;issue jsonb;chain jsonb:='[]';anchor jsonb;seen uuid[]:=ARRAY[]::uuid[];current_id uuid:=source;current_revision uuid:=revision;n integer:=0;node jsonb;BEGIN
 IF EXISTS(SELECT 1 FROM whaleu_ratings.category_icon_appearances WHERE category_id=category OR identity_id=identity) THEN RETURN NULL;END IF;
 LOOP
 n:=n+1;IF n>10000 OR current_id=ANY(seen) THEN RETURN NULL;END IF;seen:=array_append(seen,current_id);
 SELECT * INTO s FROM whaleu_ratings.scoped_source_attestations WHERE id=current_id AND scoped_source_attestations.revision=current_revision;
 IF NOT FOUND OR s.source_kind='legacy_adoption' THEN RETURN NULL;END IF;
 IF s.source_kind='m3a_native_bridge' THEN anchor:=whaleu_ratings.category_icon_native_text_origin(s.id,s.revision,category,identity);EXIT;END IF;
 IF NOT coalesce(s.source_kind='scoped_category_base' AND s.issuer='ratings-category-management' AND s.payload->>'categoryId'=category::text AND s.payload->>'identityId'=identity::text,false) THEN RETURN NULL;END IF;
 SELECT * INTO p FROM whaleu_ratings.scoped_command_preparations WHERE account_id=(s.payload->'management'->>'accountId')::uuid AND request_id=(s.payload->'management'->>'requestId')::uuid;
 SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=p.account_id AND request_id=p.request_id;
 SELECT * INTO o FROM whaleu_ratings.scoped_command_outcomes WHERE account_id=p.account_id AND request_id=p.request_id;
 SELECT value INTO issue FROM jsonb_array_elements(p.category_plan->'sourceIssues') WHERE value->>'id'=s.id::text AND value->>'revision'=s.revision::text;
 IF NOT coalesce(p.command_family='category' AND p.intent->'protocolVersion'='2'::jsonb AND whaleu_ratings.category_management_intent_valid(p.intent)
 AND p.intent_hash=whaleu_ratings.scoped_intent_hash(p.intent) AND p.intent_hash=q.intent_hash AND q.intent_hash=o.intent_hash AND o.intent=p.intent AND q.operation=p.operation AND p.operation=o.operation AND o.outcome='applied'
 AND q.receipt=jsonb_build_object('protocolVersion',2,'requestId',p.request_id,'operation',p.operation,'intentHash',p.intent_hash,'outcome','applied','result',o.result)
 AND issue->'payload'=s.payload AND issue->>'kind'=s.source_kind AND issue->>'key'=s.source_key AND issue->'scopeKeys'=to_jsonb(s.scope_keys)
 AND s.publication_transaction=o.mutation_transaction AND p.category_plan->>'intentHash'=p.intent_hash
 AND s.payload->'reviewEnvelope'->'assetIds'='[]'::jsonb AND s.payload->'reviewEnvelope'->>'purpose'='publish_rating_category_base_scoped',false) THEN RETURN NULL;END IF;
 chain:=chain||jsonb_build_array(jsonb_build_object('sourceId',s.id,'sourceRevision',s.revision,'sourceDigest',s.digest,'accountId',q.account_id,'requestId',q.request_id,'intentHash',q.intent_hash,'receiptDigest',whaleu_ratings.category_icon_digest('strict-text-receipt',q.receipt)));
 IF s.payload->>'previousBaseSourceId' IS NULL THEN
 IF identity<>category OR p.operation NOT IN ('create_categories_scoped','batch_update_subcategories_scoped','create_system_category_scoped') OR s.payload->>'originSourceId' IS NOT NULL THEN RETURN NULL;END IF;
 IF p.operation='create_system_category_scoped' THEN IF category<>whaleu_ratings.category_management_artifact(p.intent_hash,'category:root') THEN RETURN NULL;END IF;
 ELSE SELECT value INTO node FROM jsonb_array_elements(p.intent->'payload'->CASE WHEN p.operation='create_categories_scoped' THEN 'nodes' ELSE 'addNodes' END) WHERE whaleu_ratings.category_management_artifact(p.intent_hash,'category:'||(value->>'key'))=category;IF node IS NULL THEN RETURN NULL;END IF;END IF;
 anchor:=jsonb_build_object('version',1,'kind','next-scoped-strict-text','sourceId',s.id,'sourceRevision',s.revision,'accountId',q.account_id,'requestId',q.request_id,'intentHash',q.intent_hash);EXIT;
 END IF;
 current_id:=(s.payload->>'previousBaseSourceId')::uuid;current_revision:=(s.payload->>'previousBaseSourceRevision')::uuid;
 END LOOP;
 IF anchor IS NULL THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('kind','absent','evidenceId',(anchor->>'requestId')::uuid,'evidenceDigest',whaleu_ratings.category_icon_digest('strict-text-origin-v1',jsonb_build_object('version',1,'categoryId',category,'identityId',identity,'currentSource',jsonb_build_object('id',source,'revision',revision),'anchor',anchor,'chain',chain)));
EXCEPTION WHEN others THEN RETURN NULL;END$$;

-- Only an exact C1 scope consolidation can retire a source-only discovery root.
-- Original text source heads remain immutable under their existing owner.
CREATE FUNCTION whaleu_ratings.category_icon_source_consolidated(category uuid,identity uuid,source uuid,revision uuid) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
BEGIN
 -- Every current scoped/compat domain is relevant, including domains outside
 -- this command or without C1 adoption. A live reference defeats retirement.
 IF EXISTS(SELECT 1 FROM whaleu_ratings.category_icon_definition_heads h JOIN whaleu_ratings.category_icon_definitions d ON d.id=h.definition_id
 WHERE d.category_id=category AND d.identity_id=identity AND d.base_source_id=source AND d.base_source_revision=revision)
 OR EXISTS(SELECT 1 FROM whaleu_ratings.scoped_catalog_heads h JOIN whaleu_ratings.scoped_category_lineage l ON l.catalog_id=h.catalog_id
 WHERE l.category_id=category AND l.base_source_id=source AND l.base_source_revision=revision)
 OR EXISTS(SELECT 1 FROM whaleu_ratings.compat_heads h JOIN whaleu_ratings.compat_versions v ON v.id=h.version_id
 CROSS JOIN LATERAL jsonb_array_elements(v.scoped_tuples) input
 JOIN whaleu_ratings.scoped_category_lineage l ON l.catalog_id=(input->>'catalogId')::uuid
 WHERE l.category_id=category AND l.base_source_id=source AND l.base_source_revision=revision) THEN RETURN false;END IF;
 RETURN EXISTS(
 SELECT 1 FROM whaleu_ratings.category_icon_definitions prior
 JOIN whaleu_ratings.category_icon_definitions successor ON prior.id=ANY(successor.predecessors)
 JOIN whaleu_ratings.scoped_command_preparations p ON (p.account_id,p.request_id)=(successor.actor_id,successor.request_id)
 JOIN whaleu_ratings.category_icon_preparations ip ON (ip.actor_id,ip.request_id)=(p.account_id,p.request_id)
 JOIN whaleu_ratings.scoped_command_causes execution ON (execution.account_id,execution.request_id)=(p.account_id,p.request_id) AND execution.cause_kind='category_execution'
 JOIN whaleu_ratings.scoped_command_causes publication ON (publication.account_id,publication.request_id)=(p.account_id,p.request_id) AND publication.cause_kind='category_release'
 JOIN whaleu_ratings.scoped_releases r ON r.id=publication.artifact_id AND r.id=publication.artifact_revision
 JOIN whaleu_ratings.category_icon_release_manifests manifest ON manifest.release_id=r.id
 LEFT JOIN whaleu_ratings.requests q ON (q.account_id,q.request_id)=(p.account_id,p.request_id)
 LEFT JOIN whaleu_ratings.scoped_command_outcomes outcome ON (outcome.account_id,outcome.request_id)=(p.account_id,p.request_id)
 WHERE prior.kind='base' AND prior.category_id=category AND prior.identity_id=identity
 AND prior.base_source_id=source AND prior.base_source_revision=revision
 AND successor.kind='base' AND successor.category_id=category AND successor.identity_id=identity
 AND (successor.base_source_id,successor.base_source_revision)<>(source,revision)
 AND p.operation='set_category_scope_scoped' AND p.command_family='category' AND p.intent->'protocolVersion'='5'::jsonb
 AND p.intent_hash=ip.outer_hash AND p.intent_hash=successor.intent_hash
 AND p.intent_hash=whaleu_ratings.category_icon_intent_hash(p.intent)
 AND ip.text_hash=whaleu_ratings.scoped_intent_hash(ip.text_intent)
 AND ip.text_intent=whaleu_ratings.category_icon_text_intent(p.intent)
 AND ip.plan_digest=whaleu_ratings.category_icon_digest('plan',(ip.media_plan->'plan')||jsonb_build_object('digest',''))
 AND execution.proof=whaleu_ratings.category_icon_execution_proof(p,ip)
 AND execution.artifact_id=p.context_id AND execution.artifact_revision=p.context_id
 AND execution.mutation_transaction=successor.publication_transaction
 AND publication.mutation_transaction=execution.mutation_transaction AND r.publication_transaction=execution.mutation_transaction
 AND r.cause_kind='category_icon_management' AND r.cause->>'accountId'=p.account_id::text AND r.cause->>'requestId'=p.request_id::text
 AND r.cause->>'categoryIconDigest'=manifest.digest AND manifest.publication_transaction=r.publication_transaction
 AND publication.proof->>'intentHash'=ip.outer_hash AND publication.proof->>'textHash'=ip.text_hash
 AND publication.proof->>'mediaPlanDigest'=ip.plan_digest AND publication.proof->>'mediaReleaseDigest'=manifest.digest
 AND manifest.root_snapshot=ip.media_plan->'plan'->'afterRoots'
 AND EXISTS(SELECT 1 FROM jsonb_array_elements(ip.media_plan->'plan'->'beforeRoots') root
 WHERE root->>'kind'='base' AND root->>'definitionId'=prior.id::text AND root->>'categoryId'=category::text
 AND root->>'identityId'=identity::text AND root->'source'=jsonb_build_object('id',source,'revision',revision))
 AND EXISTS(SELECT 1 FROM jsonb_array_elements(ip.media_plan->'plan'->'afterRoots') root
 WHERE root->>'kind'='base' AND root->>'definitionId'=successor.id::text AND root->>'categoryId'=category::text
 AND root->>'identityId'=identity::text AND root->'source'=jsonb_build_object('id',successor.base_source_id,'revision',successor.base_source_revision))
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(ip.media_plan->'plan'->'afterRoots') root
 WHERE root->>'kind'='base' AND root->>'categoryId'=category::text AND root->'source'=jsonb_build_object('id',source,'revision',revision))
 AND ((execution.mutation_transaction=pg_current_xact_id() AND successor.publication_transaction=pg_current_xact_id())
 OR (q.intent_hash=ip.outer_hash AND outcome.intent_hash=ip.outer_hash AND outcome.intent=p.intent AND outcome.operation=p.operation
 AND outcome.outcome='applied' AND outcome.mutation_transaction=r.publication_transaction
 AND outcome.result->>'releaseId'=r.id::text AND outcome.result->>'mediaReleaseDigest'=manifest.digest
 AND q.receipt=jsonb_build_object('protocolVersion',5,'requestId',p.request_id,'operation',p.operation,'intentHash',ip.outer_hash,'outcome','applied','result',outcome.result)))
 );
EXCEPTION WHEN others THEN RETURN false;END$$;

CREATE FUNCTION whaleu_ratings.category_icon_complete_roots() RETURNS jsonb LANGUAGE sql STABLE AS $$
 WITH stored AS MATERIALIZED(SELECT value root FROM jsonb_array_elements(whaleu_ratings.category_icon_stored_roots())),
 bases AS MATERIALIZED(SELECT DISTINCT l.category_id, (l.proof->'body'->>'identityId')::uuid identity_id,l.base_source_id,l.base_source_revision,s.scope_keys
 FROM whaleu_ratings.scoped_catalog_heads h JOIN whaleu_ratings.scoped_category_lineage l ON l.catalog_id=h.catalog_id
 JOIN whaleu_ratings.scoped_source_attestations s ON (s.id,s.revision)=(l.base_source_id,l.base_source_revision)
 UNION SELECT coalesce(s.payload->>'categoryId',s.payload->'reviewEnvelope'->>'categoryId')::uuid,(s.payload->>'identityId')::uuid,s.id,s.revision,s.scope_keys
 FROM whaleu_ratings.scoped_source_heads h JOIN whaleu_ratings.scoped_source_attestations s ON (s.id,s.revision)=(h.source_id,h.source_revision)
 WHERE s.source_kind='scoped_category_base' AND s.payload->>'identityId' IS NOT NULL
 AND NOT whaleu_ratings.category_icon_source_consolidated(coalesce(s.payload->>'categoryId',s.payload->'reviewEnvelope'->>'categoryId')::uuid,(s.payload->>'identityId')::uuid,s.id,s.revision)),
 missing AS(SELECT b.*,jsonb_build_object('id',base_source_id,'revision',base_source_revision) source FROM bases b WHERE NOT EXISTS(SELECT 1 FROM stored WHERE root->>'kind'='base' AND root->>'categoryId'=b.category_id::text AND root->'source'=jsonb_build_object('id',base_source_id,'revision',base_source_revision))),
 allroots AS(SELECT root FROM stored UNION ALL SELECT jsonb_build_object('kind','base','definitionId',whaleu_ratings.category_management_artifact(whaleu_ratings.category_icon_digest('unresolved-root',jsonb_build_object('categoryId',category_id,'identityId',identity_id,'source',source)),'category-icon-unresolved'),'categoryId',category_id,'identityId',identity_id,'source',source,'scopeKeys',scope_keys,'retention','current','value',coalesce(whaleu_ratings.category_icon_strict_text_absence(base_source_id,base_source_revision,category_id,identity_id),jsonb_build_object('kind','unresolved','reason','legacy_unknown'))) FROM missing)
 SELECT coalesce(jsonb_agg(root ORDER BY whaleu_ratings.category_icon_root_key(root) COLLATE "C"),'[]'::jsonb) FROM allroots
$$;
CREATE FUNCTION whaleu_ratings.category_icon_content(expected jsonb,campus uuid,roots jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE b jsonb:=expected->'body';base jsonb;overriding jsonb;chosen jsonb;icon jsonb;BEGIN
 SELECT value INTO STRICT base FROM jsonb_array_elements(roots) WHERE value->>'kind'='base' AND value->'categoryId'=b->'id' AND value->'identityId'=b->'identityId'
 AND value->'source'=jsonb_build_object('id',expected->'baseSourceId','revision',expected->'baseSourceRevision');
 IF campus IS NOT NULL THEN SELECT value INTO overriding FROM jsonb_array_elements(roots) WHERE value->>'kind'='override' AND value->'categoryId'=b->'id' AND value->'identityId'=b->'identityId' AND value->>'campusId'=campus::text AND value->'baseSource'=base->'source';END IF;
 IF (expected->>'overrideSourceId' IS NOT NULL AND overriding IS NULL) OR (overriding IS NOT NULL AND overriding->'source' IS DISTINCT FROM CASE WHEN expected->>'overrideSourceId' IS NULL THEN 'null'::jsonb ELSE jsonb_build_object('id',expected->'overrideSourceId','revision',expected->'overrideSourceRevision') END) THEN RETURN NULL;END IF;
 chosen:=CASE WHEN overriding IS NULL OR overriding->'value'->>'kind'='inherit' THEN base ELSE overriding END;
 IF chosen->'value'->>'kind' NOT IN ('absent','image') THEN RETURN NULL;END IF;
 icon:=chosen->'value'||jsonb_build_object('origin',chosen->'kind','definitionId',chosen->'definitionId');
 RETURN jsonb_build_object('categoryId',b->'id','identityId',b->'identityId','parentId',b->'parentId','level',b->'level','kind',b->'kind','systemKey',b->'systemKey','name',b->'name','description',b->'description',
 'selector',CASE WHEN campus IS NULL THEN jsonb_build_object('kind','global') ELSE jsonb_build_object('kind','campus','campusId',campus) END,
 'baseSource',base->'source','overrideSource',coalesce(overriding->'source','null'::jsonb),'baseDefinitionId',base->'definitionId','overrideDefinitionId',coalesce(overriding->'definitionId','null'::jsonb),'icon',icon);
EXCEPTION WHEN others THEN RETURN NULL;END$$;
CREATE FUNCTION whaleu_ratings.category_icon_management_slots(roots jsonb,keys text[]) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE root jsonb;base jsonb;scope text;result jsonb:='[]';BEGIN
 FOR root IN SELECT value FROM jsonb_array_elements(roots) WHERE value->'value'->>'kind'='image' LOOP
 SELECT value INTO STRICT base FROM jsonb_array_elements(roots) WHERE value->>'kind'='base'
 AND value->'categoryId'=root->'categoryId' AND value->'identityId'=root->'identityId'
 AND value->'source'=CASE WHEN root->>'kind'='base' THEN root->'source' ELSE root->'baseSource' END;
 FOR scope IN SELECT jsonb_array_elements_text(CASE WHEN root->>'kind'='base' THEN root->'scopeKeys' ELSE jsonb_build_array('campus:'||(root->>'campusId')) END) LOOP
 IF scope=ANY(keys) THEN IF jsonb_array_length(result)>=100000 THEN RETURN NULL;END IF;result:=result||jsonb_build_array(jsonb_build_object('root',root,'base',base,'selector',CASE WHEN scope='global' THEN jsonb_build_object('kind','global') ELSE jsonb_build_object('kind','campus','campusId',substring(scope from 8)) END));END IF;
 END LOOP;END LOOP;RETURN result;
EXCEPTION WHEN others THEN RETURN NULL;END$$;

CREATE FUNCTION whaleu_ratings.category_icon_planned_sources(p whaleu_ratings.scoped_command_preparations) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE sources jsonb;issues jsonb;roots jsonb;BEGIN
 SELECT media_plan->'plan'->'afterRoots' INTO roots FROM whaleu_ratings.category_icon_preparations WHERE actor_id=p.account_id AND request_id=p.request_id;
 -- Complete Category placements and exact referenced original sources only.
 -- Target/discussion sources do not contribute to Category body composition.
 -- One aggregate avoids quadratic JSONB copying over large original ledgers.
 SELECT coalesce(jsonb_object_agg(s.source_kind||':'||s.source_key,jsonb_build_object('id',s.id,'revision',s.revision,'kind',s.source_kind,'key',s.source_key,'scopeKeys',s.scope_keys,'payload',s.payload)),'{}'::jsonb) INTO sources
 FROM whaleu_ratings.scoped_source_heads h JOIN whaleu_ratings.scoped_source_attestations s ON (s.id,s.revision)=(h.source_id,h.source_revision)
 WHERE s.source_kind='scoped_category_scope' OR EXISTS(SELECT 1 FROM jsonb_array_elements(roots) root
 WHERE jsonb_build_object('id',s.id,'revision',s.revision) IN (root->'source',root->'baseSource'));
 SELECT coalesce(jsonb_object_agg((item->>'kind')||':'||(item->>'key'),item),'{}'::jsonb) INTO issues FROM jsonb_array_elements(p.category_plan->'sourceIssues') item;
 RETURN sources||issues;
END$$;

-- Exact original body composition. Callers choose the original source/root slot;
-- a null override is derived by the server for a BASE root, never by the client.
CREATE FUNCTION whaleu_ratings.category_icon_planned_root_content(sources jsonb,base_root jsonb,override_root jsonb,selector jsonb,historical boolean DEFAULT false) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE base jsonb;over_source jsonb;envelope jsonb;body jsonb;source jsonb:=base_root->'source';expected jsonb;roots jsonb;campus uuid;BEGIN
 campus:=CASE WHEN selector->>'kind'='campus' THEN (selector->>'campusId')::uuid ELSE NULL END;
 SELECT value INTO STRICT base FROM jsonb_each(sources) WHERE value->'id'=source->'id' AND value->'revision'=source->'revision';
 IF base->'payload' ? 'reviewEnvelope' THEN
 envelope:=base->'payload'->'reviewEnvelope';
 IF NOT coalesce(base->>'kind'='scoped_category_base' AND whaleu_community.rating_scoped_envelope_shape(envelope,'publish_rating_category_base_scoped')
 AND envelope->'sourceId'=base->'id' AND envelope->'sourceRevision'=base->'revision'
 AND envelope->'categoryId'=base_root->'categoryId' AND envelope->'identityId'=base_root->'identityId',false) THEN RETURN NULL;END IF;
 body:=envelope->'body';
 ELSE body:=CASE WHEN historical THEN whaleu_ratings.category_historical_body((base->>'id')::uuid,(base->>'revision')::uuid) ELSE whaleu_ratings.scoped_base_category((base->>'id')::uuid,(base->>'revision')::uuid) END;
 IF body->'id' IS DISTINCT FROM base_root->'categoryId' OR body->'identityId' IS DISTINCT FROM base_root->'identityId' THEN RETURN NULL;END IF;
 END IF;
 IF body IS NULL THEN RETURN NULL;END IF;
 expected:=jsonb_build_object('body',body||jsonb_build_object('id',base_root->'categoryId','identityId',base_root->'identityId'),
 'baseSourceId',source->'id','baseSourceRevision',source->'revision','overrideSourceId',NULL,'overrideSourceRevision',NULL);
 roots:=jsonb_build_array(base_root);
 IF override_root IS NOT NULL THEN
 IF NOT coalesce(override_root->>'kind'='override' AND override_root->'categoryId'=base_root->'categoryId'
 AND override_root->'identityId'=base_root->'identityId' AND override_root->'baseSource'=source
 AND override_root->>'campusId'=campus::text,false) THEN RETURN NULL;END IF;
 roots:=roots||jsonb_build_array(override_root);
 IF override_root->>'source' IS NOT NULL THEN
 SELECT value INTO STRICT over_source FROM jsonb_each(sources) WHERE value->'id'=override_root->'source'->'id' AND value->'revision'=override_root->'source'->'revision';
 IF over_source->>'kind' IS DISTINCT FROM 'scoped_category_override' THEN RETURN NULL;END IF;
 IF over_source->'payload'->>'action'='inherit' THEN
 IF NOT coalesce(campus IS NOT NULL AND over_source->'scopeKeys'=jsonb_build_array('campus:'||campus::text)
 AND over_source->'payload'->'categoryId'=base_root->'categoryId'
 AND over_source->'payload'->'baseSourceId'=source->'id' AND over_source->'payload'->'baseSourceRevision'=source->'revision'
 AND over_source->'payload'->'modes'='{"name":{"mode":"inherit"},"description":{"mode":"inherit"}}'::jsonb
 AND NOT (over_source->'payload' ? 'reviewEnvelope') AND NOT (over_source->'payload' ? 'issuanceDigest'),false) THEN RETURN NULL;END IF;
 ELSE
 envelope:=over_source->'payload'->'reviewEnvelope';
 IF NOT coalesce(whaleu_community.rating_scoped_envelope_shape(envelope,'publish_rating_category_override_scoped')
 AND envelope->'sourceId'=over_source->'id' AND envelope->'sourceRevision'=over_source->'revision'
 AND envelope->'categoryId'=base_root->'categoryId' AND envelope->'identityId'=base_root->'identityId'
 AND envelope->'baseSourceId'=source->'id' AND envelope->'baseSourceRevision'=source->'revision'
 AND envelope->'scope'=selector,false) THEN RETURN NULL;END IF;
 expected:=jsonb_set(expected,'{body}',(expected->'body')||(envelope->'body'));END IF;
 expected:=expected||jsonb_build_object('overrideSourceId',over_source->'id','overrideSourceRevision',over_source->'revision');
 END IF;END IF;
 RETURN whaleu_ratings.category_icon_content(expected,campus,roots);
EXCEPTION WHEN others THEN RETURN NULL;END$$;

CREATE FUNCTION whaleu_ratings.category_icon_planned_management_contents(p whaleu_ratings.scoped_command_preparations,ip whaleu_ratings.category_icon_preparations) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE sources jsonb:=whaleu_ratings.category_icon_planned_sources(p);slots jsonb;slot jsonb;content jsonb;result jsonb:='[]';BEGIN
 slots:=whaleu_ratings.category_icon_management_slots(ip.media_plan->'plan'->'afterRoots',ip.affected_scope_keys);
 IF slots IS NULL THEN RETURN NULL;END IF;
 FOR slot IN SELECT value FROM jsonb_array_elements(slots) LOOP
 content:=whaleu_ratings.category_icon_planned_root_content(sources,slot->'base',CASE WHEN slot->'root'->>'kind'='override' THEN slot->'root' ELSE NULL END,slot->'selector');
 IF content IS NULL THEN RETURN NULL;END IF;
 result:=result||jsonb_build_array(jsonb_build_object('rootDefinitionId',slot->'root'->'definitionId','selector',slot->'selector','content',content));
 END LOOP;RETURN result;
EXCEPTION WHEN others THEN RETURN NULL;END$$;

-- Replace existing category_icon_planned_contents, preserving separate duplicate
-- public-placement rejection. Canonical union key matches TS exactly.
CREATE OR REPLACE FUNCTION whaleu_ratings.category_icon_planned_contents(p whaleu_ratings.scoped_command_preparations,ip whaleu_ratings.category_icon_preparations) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE sources jsonb:=whaleu_ratings.category_icon_planned_sources(p);place jsonb;base jsonb;overriding jsonb;source jsonb;scope text;category text;selector jsonb;result jsonb:='{}';public_keys jsonb:='{}';content jsonb;management jsonb;slot jsonb;BEGIN
 FOR place IN SELECT value FROM jsonb_each(sources) WHERE value->>'kind'='scoped_category_scope' AND value->'payload'->>'action' IS DISTINCT FROM 'retired' LOOP
 category:=place->'payload'->>'categoryId';source:=jsonb_build_object('id',place->'payload'->'baseSourceId','revision',place->'payload'->'baseSourceRevision');
 SELECT value INTO STRICT base FROM jsonb_array_elements(ip.media_plan->'plan'->'afterRoots') WHERE value->>'kind'='base' AND value->>'categoryId'=category AND value->'source'=source;
 FOR scope IN SELECT jsonb_array_elements_text(place->'scopeKeys') LOOP
 IF NOT scope=ANY(ip.affected_scope_keys) THEN CONTINUE;END IF;
 overriding:=NULL;
 selector:=CASE WHEN scope='global' THEN jsonb_build_object('kind','global') ELSE jsonb_build_object('kind','campus','campusId',substring(scope from 8)) END;
 IF scope<>'global' THEN
 -- SELECT INTO alone does not reject duplicates; the independent roots-valid
 -- verifier already prohibits duplicate exact slots. STRICT count optional.
 SELECT value INTO overriding FROM jsonb_array_elements(ip.media_plan->'plan'->'afterRoots') WHERE value->>'kind'='override' AND value->>'categoryId'=category AND value->'identityId'=base->'identityId' AND value->'baseSource'=source AND value->>'campusId'=substring(scope from 8);END IF;
 content:=whaleu_ratings.category_icon_planned_root_content(sources,base,overriding,selector);
 IF content IS NULL OR public_keys ? (scope||':'||category) THEN RETURN NULL;END IF;
 public_keys:=public_keys||jsonb_build_object(scope||':'||category,true);
 result:=result||jsonb_build_object(scope||':'||category||':'||whaleu_ratings.category_icon_digest('content',content),content);
 END LOOP;END LOOP;
 management:=whaleu_ratings.category_icon_planned_management_contents(p,ip);
 IF management IS NULL THEN RETURN NULL;END IF;
 FOR slot IN SELECT value FROM jsonb_array_elements(management) LOOP
 content:=slot->'content';scope:=CASE WHEN content->'selector'->>'kind'='global' THEN 'global' ELSE 'campus:'||(content->'selector'->>'campusId') END;
 result:=result||jsonb_build_object(scope||':'||(content->>'categoryId')||':'||whaleu_ratings.category_icon_digest('content',content),content);
 END LOOP;
 IF (SELECT count(*) FROM jsonb_each(result))>100000 THEN RETURN NULL;END IF;
 RETURN (SELECT coalesce(jsonb_agg(entry.value ORDER BY entry.key COLLATE "C"),'[]'::jsonb) FROM jsonb_each(result) entry);
EXCEPTION WHEN others THEN RETURN NULL;END$$;


CREATE FUNCTION whaleu_ratings.category_icon_text_preparation(p whaleu_ratings.scoped_command_preparations,ip whaleu_ratings.category_icon_preparations) RETURNS whaleu_ratings.scoped_command_preparations LANGUAGE plpgsql IMMUTABLE AS $$BEGIN
 -- This projection is never inserted or used for a claim, receipt, or Review8.
 -- The original verifier consumes only its frozen text namespace as an internal
 -- computation; every persistent authority remains p.intent_hash (outer hash).
 p.intent:=ip.text_intent;p.intent_hash:=ip.text_hash;RETURN p;
END$$;
CREATE FUNCTION whaleu_ratings.category_icon_scope_adopted(cause jsonb,scope text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT coalesce(cause->>'categoryIconExtension'='ratings-category-icon-v1' AND jsonb_typeof(cause->'categoryIconScopeKeys')='array' AND (cause->'categoryIconScopeKeys') ? scope,false)
$$;
CREATE FUNCTION whaleu_ratings.category_icon_plan_valid(p whaleu_ratings.scoped_command_preparations,current_before boolean) RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
DECLARE ip whaleu_ratings.category_icon_preparations;m jsonb;expected_roots jsonb;category_ids jsonb;wanted uuid[];keys text[];item jsonb;upload jsonb;a whaleu_media.assets;s whaleu_ratings.category_icon_upload_scopes;b whaleu_ratings.category_icon_review_bindings;contents jsonb;fresh jsonb:='[]';c whaleu_ratings.scoped_contexts;expected jsonb;key text;adoption boolean;BEGIN
 SELECT * INTO ip FROM whaleu_ratings.category_icon_preparations WHERE actor_id=p.account_id AND request_id=p.request_id;m:=ip.media_plan->'plan';
 IF NOT coalesce(p.command_family='category' AND whaleu_ratings.category_icon_intent_valid(p.intent) AND p.intent_hash=whaleu_ratings.category_icon_intent_hash(p.intent) AND ip.outer_hash=p.intent_hash
 AND ip.text_intent=whaleu_ratings.category_icon_text_intent(p.intent) AND ip.text_hash=whaleu_ratings.scoped_intent_hash(ip.text_intent)
 AND whaleu_community.rating_scoped_keys(ip.media_plan,ARRAY['plan','coverage','reviewEnvelopes'])
 AND whaleu_community.rating_scoped_keys(m,ARRAY['version','accountId','requestId','outerHash','textHash','textPlan','beforeSnapshot','beforeRoots','afterRoots','newAppearances','uploads','categoryIds','affectedScopeKeys','globalRequired','noop','mediaNoop','adoptionRequired','digest'])
 AND m->'version'='1'::jsonb AND m->>'accountId'=p.account_id::text AND m->>'requestId'=p.request_id::text AND m->>'outerHash'=ip.outer_hash AND m->>'textHash'=ip.text_hash
 AND m->'textPlan'=p.category_plan AND m->>'beforeSnapshot'=ip.before_snapshot AND ip.before_snapshot=p.intent->>'mediaSnapshot'
 AND m->>'digest'=whaleu_ratings.category_icon_digest('plan',m||jsonb_build_object('digest','')) AND ip.plan_digest=m->>'digest'
 AND ip.affected_scope_keys=ARRAY(SELECT jsonb_array_elements_text(m->'affectedScopeKeys')) AND ip.noop=(m->>'noop')::boolean
 AND whaleu_ratings.category_icon_roots_valid(m->'beforeRoots') AND whaleu_ratings.category_icon_roots_valid(m->'afterRoots')
 AND whaleu_ratings.category_management_text_plan_valid_pre_icon(whaleu_ratings.category_icon_text_preparation(p,ip),current_before),false) THEN RETURN false;END IF;
 expected_roots:=whaleu_ratings.category_icon_expected_roots(p,ip);
 IF expected_roots IS DISTINCT FROM m->'afterRoots' OR (m->>'mediaNoop')::boolean IS DISTINCT FROM (m->'afterRoots'=m->'beforeRoots')
 OR (m->>'noop')::boolean IS DISTINCT FROM ((p.category_plan->>'noop')::boolean AND (m->>'mediaNoop')::boolean AND NOT(m->>'adoptionRequired')::boolean) THEN RETURN false;END IF;
 SELECT coalesce(jsonb_agg(id ORDER BY id COLLATE "C"),'[]'::jsonb) INTO category_ids FROM(
 SELECT jsonb_array_elements_text(p.category_plan->'categoryIds') id
 UNION SELECT r->>'categoryId' FROM jsonb_array_elements(m->'afterRoots') r WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(m->'beforeRoots') old WHERE old=r)
 UNION SELECT r->>'categoryId' FROM jsonb_array_elements(m->'beforeRoots') r WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(m->'afterRoots') next WHERE whaleu_ratings.category_icon_root_key(next)=whaleu_ratings.category_icon_root_key(r))) ids;
 IF category_ids IS DISTINCT FROM m->'categoryIds' THEN RETURN false;END IF;
 SELECT array_agg(DISTINCT id::uuid) INTO wanted FROM(SELECT jsonb_array_elements_text(category_ids) id UNION SELECT p.intent->'payload'->>'categoryId' WHERE p.intent->'payload' ? 'categoryId') ids;
 IF p.operation='set_category_scope_scoped' AND p.intent->'payload'->>'propagation'='subtree' THEN
 WITH RECURSIVE nodes AS(SELECT DISTINCT l.category_id,l.proof->'body'->>'parentId' parent_id FROM jsonb_array_elements(p.category_plan->'beforeHeads') h JOIN whaleu_ratings.scoped_category_lineage l ON l.catalog_id=(h->>'catalogRevision')::uuid),tree AS(SELECT * FROM nodes WHERE category_id=(p.intent->'payload'->>'categoryId')::uuid UNION SELECT n.* FROM nodes n JOIN tree t ON n.parent_id=t.category_id::text)
 SELECT ARRAY(SELECT DISTINCT value FROM unnest(coalesce(wanted,ARRAY[]::uuid[])||ARRAY(SELECT category_id FROM tree)) value) INTO wanted;END IF;
 SELECT array_agg(DISTINCT k COLLATE "C" ORDER BY k COLLATE "C") INTO keys FROM(
 SELECT jsonb_array_elements_text(p.category_plan->'affectedScopeKeys') k
 UNION SELECT jsonb_array_elements_text(r->'scopeKeys') FROM jsonb_array_elements((m->'beforeRoots')||(m->'afterRoots')) r WHERE p.operation IN ('edit_category_base_scoped','set_category_scope_scoped','create_categories_scoped','create_system_category_scoped','batch_update_subcategories_scoped') AND (r->>'categoryId')::uuid=ANY(wanted)
 UNION SELECT 'campus:'||(r->>'campusId') FROM jsonb_array_elements((m->'beforeRoots')||(m->'afterRoots')) r WHERE r->>'kind'='override' AND p.operation IN ('edit_category_base_scoped','set_category_scope_scoped','create_categories_scoped','create_system_category_scoped','batch_update_subcategories_scoped') AND (r->>'categoryId')::uuid=ANY(wanted)) domains;
 IF keys IS DISTINCT FROM ip.affected_scope_keys OR (m->>'globalRequired')::boolean IS DISTINCT FROM ((p.category_plan->>'globalRequired')::boolean OR 'global'=ANY(keys))
 OR NOT whaleu_authorization.rating_category_management_authority_covers(p.account_id,ARRAY(SELECT substring(k from 8)::uuid FROM unnest(keys) k WHERE k<>'global'),(m->>'globalRequired')::boolean) THEN RETURN false;END IF;
 IF current_before THEN
 IF m->'beforeRoots' IS DISTINCT FROM whaleu_ratings.category_icon_complete_roots() OR ip.before_heads IS DISTINCT FROM whaleu_ratings.category_management_heads(keys) OR ip.before_vector IS DISTINCT FROM whaleu_ratings.scoped_current_source_vector(keys) OR ip.before_compat_heads IS DISTINCT FROM whaleu_ratings.category_management_compat_heads(keys) THEN RETURN false;END IF;
 SELECT EXISTS(SELECT 1 FROM whaleu_ratings.scoped_catalog_heads h JOIN whaleu_ratings.scoped_releases r ON r.id=h.release_id WHERE h.scope_key=ANY(keys) AND NOT whaleu_ratings.category_icon_scope_adopted(r.cause,h.scope_key)) INTO adoption;
 IF adoption IS DISTINCT FROM (m->>'adoptionRequired')::boolean THEN RETURN false;END IF;
 END IF;
 IF jsonb_typeof(m->'uploads')<>'array' OR jsonb_array_length(m->'uploads')<>jsonb_array_length(whaleu_ratings.category_icon_replacements(p.intent)) OR (SELECT count(*)<>count(DISTINCT x->>'assetId') FROM jsonb_array_elements(m->'uploads') x) THEN RETURN false;END IF;
 FOR upload IN SELECT value FROM jsonb_array_elements(m->'uploads') LOOP
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(whaleu_ratings.category_icon_replacements(p.intent)) x WHERE x->'assetId'=upload->'assetId' AND x->'uploadScopeId'=upload->'uploadScopeId') THEN RETURN false;END IF;
 SELECT * INTO a FROM whaleu_media.assets WHERE id=(upload->>'assetId')::uuid;
 SELECT * INTO s FROM whaleu_ratings.category_icon_upload_scopes WHERE id=(upload->>'uploadScopeId')::uuid;
 IF NOT coalesce(s.actor_id=p.account_id AND s.command_request_id=p.request_id AND s.session_id=p.session_id AND s.scope_revision=upload->>'scopeRevision' AND s.expires_at>clock_timestamp()
 AND upload=jsonb_build_object('uploadScopeId',s.id,'scopeRevision',s.scope_revision,'assetId',a.id,'manifestDigest',a.manifest_digest,'actorId',s.actor_id,'categoryId',s.category_id,'identityId',s.identity_id,'origin',s.origin,'textHash',ip.text_hash,'expiresAt',floor(extract(epoch FROM s.expires_at)*1000)::bigint)
 AND a.actor_id=p.account_id AND a.resource_id=s.id AND a.scope_revision=s.scope_revision AND a.owner_kind='ratings' AND a.resource_kind='category_icon' AND a.target_kind='edit' AND a.content_version=1 AND a.slot='icon'
 AND (NOT current_before OR whaleu_ratings.category_icon_upload_scope_current(s.id,p.account_id,clock_timestamp()))
 AND whaleu_ratings.scoped_intent_hash(jsonb_build_object('protocolVersion',2,'operation',s.input->'operation','context',s.input->'context','payload',s.input->'payload'))=ip.text_hash,false) THEN RETURN false;END IF;
 END LOOP;
 IF m->'newAppearances' IS DISTINCT FROM (SELECT coalesce(jsonb_agg(appearance ORDER BY appearance->>'appearanceId' COLLATE "C"),'[]'::jsonb) FROM(SELECT DISTINCT r->'value'->'appearance' appearance FROM jsonb_array_elements(m->'afterRoots') r WHERE r->'value'->>'kind'='image' AND r->'value'->'appearance'->>'appearanceId'=whaleu_ratings.category_management_artifact(ip.outer_hash,'category-icon-appearance:'||(r->>'categoryId')||':'||whaleu_community.content_canonical_json(r->'value'->'appearance'->'origin'))::text) images) THEN RETURN false;END IF;
 contents:=whaleu_ratings.category_icon_planned_contents(p,ip);
 IF contents IS NULL OR contents IS DISTINCT FROM (SELECT coalesce(jsonb_agg(x->'content' ORDER BY ord),'[]'::jsonb) FROM jsonb_array_elements(ip.media_plan->'coverage') WITH ORDINALITY e(x,ord)) THEN RETURN false;END IF;
 SELECT * INTO c FROM whaleu_ratings.scoped_contexts WHERE id=p.context_id;
 FOR item IN SELECT value FROM jsonb_array_elements(ip.media_plan->'coverage') LOOP
 IF NOT whaleu_community.rating_scoped_keys(item,ARRAY['content','binding']) THEN RETURN false;END IF;
 IF item->'binding'='null'::jsonb THEN
 expected:=jsonb_build_object('version',8,'purpose','publish_rating_category_icon','accountId',p.account_id,'clientRequestId',p.request_id,'operation',p.operation,'intentHash',ip.outer_hash,'textHash',ip.text_hash,'textPlanDigest',p.category_plan->'previewDigest','mediaPlanDigest',ip.plan_digest,'beforeSnapshot',ip.before_snapshot,
 'context',jsonb_build_object('id',c.id,'digest',c.record_digest,'protocolGeneration',c.context->'protocolGeneration','topologySnapshotId',c.authority->'topologySnapshotId','sourceDigest',c.context->'sourceDigest'),
 'definitionId',whaleu_ratings.category_management_artifact(ip.outer_hash,'category-icon-composite:'||whaleu_community.content_canonical_json(jsonb_build_array(item->'content'->'categoryId',item->'content'->'selector',whaleu_ratings.category_icon_digest('content',item->'content')))),
 'definitionDigest',whaleu_ratings.category_icon_digest('content',item->'content'),'content',item->'content','assetIds',CASE WHEN item->'content'->'icon'->>'kind'='image' THEN jsonb_build_array(item->'content'->'icon'->'appearance'->'assetId') ELSE '[]'::jsonb END);
 fresh:=fresh||jsonb_build_array(expected);
 ELSE
 SELECT * INTO b FROM whaleu_ratings.category_icon_review_bindings WHERE id=(item->'binding'->>'id')::uuid;
 IF NOT coalesce(item->'binding'=jsonb_build_object('id',b.id,'definition_id',b.definition_id,'definition_digest',b.definition_digest,'approval_digest',b.approval_digest,'envelope',b.envelope)
 AND b.envelope->'content'=item->'content' AND b.definition_digest=whaleu_ratings.category_icon_digest('content',item->'content') AND whaleu_community.rating_category_icon_definition_current(b.definition_id,b.definition_digest,b.envelope)
 AND (EXISTS(SELECT 1 FROM jsonb_array_elements(ip.before_heads) h JOIN whaleu_ratings.category_icon_projections old ON old.catalog_id=(h->>'catalogRevision')::uuid WHERE old.category_id=(item->'content'->>'categoryId')::uuid AND old.review_binding_id=b.id AND old.projection->'content'=item->'content' AND h->>'scopeKey'=CASE WHEN item->'content'->'selector'->>'kind'='global' THEN 'global' ELSE 'campus:'||(item->'content'->'selector'->>'campusId') END) OR EXISTS(SELECT 1 FROM jsonb_array_elements(ip.before_heads) h JOIN whaleu_ratings.scoped_catalogs old_catalog ON old_catalog.id=(h->>'catalogRevision')::uuid JOIN whaleu_ratings.category_icon_release_manifests old_manifest ON old_manifest.release_id=old_catalog.release_id JOIN LATERAL jsonb_array_elements(old_manifest.management_coverage) entry ON entry->>'scopeKey'=h->>'scopeKey' WHERE entry->'content'=item->'content' AND entry->'review'->>'id'=b.id::text AND entry->>'scopeKey'=CASE WHEN item->'content'->'selector'->>'kind'='global' THEN 'global' ELSE 'campus:'||(item->'content'->'selector'->>'campusId') END)),false) THEN RETURN false;END IF;
 END IF;END LOOP;
 RETURN fresh=ip.media_plan->'reviewEnvelopes';
EXCEPTION WHEN others THEN RETURN false;END$$;
CREATE OR REPLACE FUNCTION whaleu_ratings.category_management_plan_valid(p whaleu_ratings.scoped_command_preparations,current_before boolean) RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$BEGIN
 IF p.intent->'protocolVersion'='5'::jsonb THEN RETURN whaleu_ratings.category_icon_plan_valid(p,current_before);END IF;
 RETURN whaleu_ratings.category_management_text_plan_valid_pre_icon(p,current_before);
END$$;

CREATE FUNCTION whaleu_ratings.category_icon_execution_proof(p whaleu_ratings.scoped_command_preparations,ip whaleu_ratings.category_icon_preparations) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
 SELECT jsonb_build_object('intentHash',ip.outer_hash,'textHash',ip.text_hash,'planDigest',p.category_plan->>'previewDigest','mediaPlanDigest',ip.plan_digest,'contextRevision',p.context_revision,
 'executionDigest',whaleu_ratings.scoped_digest('category-icon-execution',jsonb_build_object('accountId',p.account_id,'requestId',p.request_id,'intentHash',ip.outer_hash,'textHash',ip.text_hash,'mediaPlanDigest',ip.plan_digest)))
$$;
CREATE FUNCTION whaleu_ratings.category_icon_after_vector(p whaleu_ratings.scoped_command_preparations,ip whaleu_ratings.category_icon_preparations) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT coalesce(jsonb_agg(entry ORDER BY entry->>'kind' COLLATE "C",entry->>'key' COLLATE "C"),'[]'::jsonb) FROM (
 SELECT b entry FROM jsonb_array_elements(ip.before_vector) b WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p.category_plan->'sourceIssues') i WHERE i->>'previousSourceId'=b->>'id' AND i->>'previousSourceRevision'=b->>'revision')
 UNION ALL SELECT jsonb_build_object('id',s.id,'revision',s.revision,'kind',s.source_kind,'key',s.source_key,'digest',s.digest) FROM jsonb_array_elements(p.category_plan->'sourceIssues') i JOIN whaleu_ratings.scoped_source_attestations s ON (s.id,s.revision)=((i->>'id')::uuid,(i->>'revision')::uuid)
 ) exact_vector
$$;
CREATE FUNCTION whaleu_ratings.verify_category_icon_command(actor uuid,request uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE q whaleu_ratings.requests;p whaleu_ratings.scoped_command_preparations;o whaleu_ratings.scoped_command_outcomes;e whaleu_ratings.scoped_command_causes;r whaleu_ratings.scoped_releases;plan jsonb;item jsonb;s whaleu_ratings.scoped_source_attestations;heads jsonb;expected jsonb;n integer;ip whaleu_ratings.category_icon_preparations;
BEGIN
 SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=actor AND request_id=request;
 SELECT * INTO o FROM whaleu_ratings.scoped_command_outcomes WHERE account_id=actor AND request_id=request;
 IF NOT coalesce(whaleu_ratings.category_management_operation(q.operation) AND o.operation=q.operation AND o.intent_hash=q.intent_hash AND o.mutation_transaction=pg_current_xact_id(),false) THEN RAISE EXCEPTION 'Category outcome is absent or not exact' USING ERRCODE='23514';END IF;
 expected:=jsonb_build_object('protocolVersion',5,'requestId',request,'operation',q.operation,'intentHash',q.intent_hash,'outcome',o.outcome)||CASE WHEN o.outcome='closed' THEN jsonb_build_object('code',o.code) ELSE jsonb_build_object('result',o.result) END;
 IF q.receipt IS DISTINCT FROM expected OR EXISTS(SELECT 1 FROM whaleu_ratings.score_transitions WHERE account_id=actor AND request_id=request)
 OR EXISTS(SELECT 1 FROM whaleu_ratings.comment_transitions WHERE account_id=actor AND request_id=request) OR EXISTS(SELECT 1 FROM whaleu_ratings.reply_transitions WHERE account_id=actor AND request_id=request)
 OR EXISTS(SELECT 1 FROM whaleu_ratings.like_transitions WHERE account_id=actor AND request_id=request) OR EXISTS(SELECT 1 FROM whaleu_ratings.subscription_transitions WHERE account_id=actor AND request_id=request)
 OR EXISTS(SELECT 1 FROM whaleu_ratings.effect_events WHERE actor_account_id=actor AND request_id=request)
 THEN RAISE EXCEPTION 'Category receipt bytes or command-family isolation violated' USING ERRCODE='23514';END IF;
 SELECT count(*) INTO n FROM whaleu_ratings.scoped_source_attestations WHERE issuer='ratings-category-management' AND payload->'management'->>'accountId'=actor::text AND payload->'management'->>'requestId'=request::text;
 IF o.outcome='closed' THEN
 IF EXISTS(SELECT 1 FROM whaleu_ratings.category_icon_appearances a JOIN whaleu_ratings.category_icon_preparations prepared_media ON prepared_media.media_plan->'plan'->'newAppearances' @> jsonb_build_array(jsonb_build_object('appearanceId',a.id)) WHERE prepared_media.actor_id=actor AND prepared_media.request_id=request) OR EXISTS(SELECT 1 FROM whaleu_ratings.category_icon_definitions WHERE actor_id=actor AND request_id=request) OR EXISTS(SELECT 1 FROM whaleu_ratings.category_icon_review_bindings WHERE account_id=actor AND request_id=request) OR n<>0 OR EXISTS(SELECT 1 FROM whaleu_ratings.scoped_command_causes WHERE account_id=actor AND request_id=request) OR EXISTS(SELECT 1 FROM whaleu_ratings.scoped_releases WHERE cause_kind='category_icon_management' AND cause->>'accountId'=actor::text AND cause->>'requestId'=request::text)
 OR o.code IN ('RATING_CREATION_CANCELLED','RATING_EDIT_CANCELLED') THEN RAISE EXCEPTION 'Category closure cannot hide an artifact' USING ERRCODE='23514';END IF;RETURN;END IF;
 SELECT * INTO p FROM whaleu_ratings.scoped_command_preparations WHERE account_id=actor AND request_id=request;
 SELECT * INTO ip FROM whaleu_ratings.category_icon_preparations WHERE actor_id=actor AND request_id=request;
 plan:=p.category_plan||jsonb_build_object('categoryIds',ip.media_plan->'plan'->'categoryIds','noop',ip.noop,'affectedScopeKeys',to_jsonb(ip.affected_scope_keys),'beforeHeads',ip.before_heads);
 IF p.intent IS DISTINCT FROM o.intent OR NOT whaleu_ratings.category_management_plan_valid(p,false) OR p.intent_hash<>q.intent_hash OR o.result->'categoryIds'<>plan->'categoryIds' OR (o.outcome='noop')<>(plan->>'noop')::boolean
 OR NOT whaleu_community.rating_scoped_keys(o.result,ARRAY['releaseId','mediaReleaseDigest','categoryIds','heads','occurredAt']) OR NOT coalesce(o.result->>'occurredAt' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$',false)
 THEN RAISE EXCEPTION 'Category success lacks exact valid prepared plan' USING ERRCODE='23514';END IF;
 IF (SELECT array_agg(cause_kind ORDER BY cause_kind) FROM whaleu_ratings.scoped_command_causes WHERE account_id=actor AND request_id=request)
 IS DISTINCT FROM (CASE WHEN o.outcome='noop' THEN ARRAY['category_execution'] ELSE ARRAY['category_execution','category_release'] END) THEN RAISE EXCEPTION 'Category cause cardinality mismatch' USING ERRCODE='23514';END IF;
 SELECT * INTO e FROM whaleu_ratings.scoped_command_causes WHERE account_id=actor AND request_id=request AND cause_kind='category_execution';
 IF e.mutation_transaction<>pg_current_xact_id() OR e.artifact_id<>p.context_id OR e.artifact_revision<>p.context_id OR e.proof<>whaleu_ratings.category_icon_execution_proof(p,ip) THEN RAISE EXCEPTION 'Category execution cause mismatch' USING ERRCODE='23514';END IF;
 IF n<>jsonb_array_length(plan->'sourceIssues') THEN RAISE EXCEPTION 'Category managed source domain incomplete' USING ERRCODE='23514';END IF;
 IF whaleu_ratings.scoped_current_source_vector(ARRAY(SELECT jsonb_array_elements_text(plan->'affectedScopeKeys'))) IS DISTINCT FROM whaleu_ratings.category_icon_after_vector(p,ip) THEN RAISE EXCEPTION 'Category publication contains an unplanned source replacement or addition' USING ERRCODE='23514';END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(plan->'sourceIssues') LOOP
 SELECT * INTO s FROM whaleu_ratings.scoped_source_attestations WHERE id=(item->>'id')::uuid AND revision=(item->>'revision')::uuid;
 IF NOT coalesce(s.issuer='ratings-category-management' AND s.publication_transaction=pg_current_xact_id() AND s.source_kind=item->>'kind' AND s.source_key=item->>'key' AND to_jsonb(s.scope_keys)=item->'scopeKeys' AND s.payload=item->'payload' AND s.valid_until=(plan->>'validUntil')::timestamptz AND s.coverage='complete' AND s.provenance='accepted' AND s.source_reference='rating-category-management:'||actor::text||':'||request::text AND whaleu_ratings.scoped_source_current(s.id,s.revision,clock_timestamp()) AND s.policy_reference=(SELECT policy_reference FROM whaleu_ratings.scoped_source_attestations WHERE id=p.policy_source_id AND revision=p.policy_source_revision),false) THEN RAISE EXCEPTION 'Category derivative differs from exact prepared source' USING ERRCODE='23514';END IF;
 IF item ? 'placement' THEN
 IF NOT EXISTS(SELECT 1 FROM whaleu_ratings.category_scope_placements x WHERE x.placement_revision=(item->'placement'->>'revision')::uuid AND x.category_id=(item->'placement'->>'categoryId')::uuid AND x.base_source_id=(item->'placement'->>'baseSourceId')::uuid AND x.base_source_revision=(item->'placement'->>'baseSourceRevision')::uuid AND x.source_id=s.id AND x.source_revision=s.revision AND x.scope_keys=s.scope_keys AND x.publication_transaction=pg_current_xact_id()) THEN RAISE EXCEPTION 'Category derivative lacks exact placement' USING ERRCODE='23514';END IF;
 END IF;
 END LOOP;
 IF o.outcome='noop' THEN
 IF n<>0 OR o.result->'releaseId'<>'null'::jsonb OR o.result->'mediaReleaseDigest'<>'null'::jsonb OR o.result->'heads'<>plan->'beforeHeads' OR plan->'beforeHeads'<>whaleu_ratings.category_management_heads(ARRAY(SELECT jsonb_array_elements_text(plan->'affectedScopeKeys'))) THEN RAISE EXCEPTION 'Category noop cannot mutate sources or heads' USING ERRCODE='23514';END IF;
 ELSE
 SELECT * INTO r FROM whaleu_ratings.scoped_releases WHERE id=(o.result->>'releaseId')::uuid;
 SELECT * INTO e FROM whaleu_ratings.scoped_command_causes WHERE account_id=actor AND request_id=request AND cause_kind='category_release';
 heads:=whaleu_ratings.category_management_heads(r.affected_scope_keys);
 IF NOT coalesce(r.cause_kind='category_icon_management' AND r.publication_transaction=pg_current_xact_id() AND r.cause->>'accountId'=actor::text AND r.cause->>'requestId'=request::text AND to_jsonb(r.affected_scope_keys)=plan->'affectedScopeKeys'
 AND o.result->'heads'=heads AND e.artifact_id=r.id AND e.artifact_revision=r.id AND e.mutation_transaction=pg_current_xact_id() AND e.proof=jsonb_build_object('intentHash',ip.outer_hash,'textHash',ip.text_hash,'planDigest',plan->>'previewDigest','mediaPlanDigest',ip.plan_digest,'mediaReleaseDigest',r.cause->'categoryIconDigest','heads',heads) AND o.result->'mediaReleaseDigest'=r.cause->'categoryIconDigest',false)
 OR EXISTS(SELECT 1 FROM whaleu_ratings.scoped_release_scopes x WHERE x.release_id=r.id AND NOT plan->'beforeHeads' @> jsonb_build_array(jsonb_build_object('scopeKey',x.scope_key,'catalogRevision',x.before_catalog_id,'headRevision',x.before_head_revision)))
 THEN RAISE EXCEPTION 'Category release is not exact whole-set CAS' USING ERRCODE='23514';END IF;
 END IF;
END $$;
-- The shared request has one wire authority. Hash-only cold cancellation creates
-- its minimal actor obligation; it does not invent an old intent or preparation.
CREATE OR REPLACE FUNCTION whaleu_ratings.verify_category_management_command(actor uuid,request uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE q whaleu_ratings.requests;f whaleu_ratings.category_icon_recovery_fences;BEGIN
 SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=actor AND request_id=request;
 IF q.receipt->'protocolVersion'='5'::jsonb THEN
 SELECT * INTO f FROM whaleu_ratings.category_icon_recovery_fences WHERE actor_id=actor AND request_id=request;
 IF f.actor_id IS NOT NULL THEN
 IF NOT coalesce(q.operation=f.operation AND q.intent_hash=f.intent_hash AND q.receipt=jsonb_build_object('protocolVersion',5,'requestId',request,'operation',q.operation,'intentHash',q.intent_hash,'outcome','closed','code','RATING_CATEGORY_CANCELLED'),false)
 OR EXISTS(SELECT 1 FROM whaleu_ratings.scoped_command_outcomes WHERE account_id=actor AND request_id=request)
 OR EXISTS(SELECT 1 FROM whaleu_ratings.scoped_command_causes WHERE account_id=actor AND request_id=request)
 OR EXISTS(SELECT 1 FROM whaleu_ratings.category_icon_definitions WHERE actor_id=actor AND request_id=request)
 OR EXISTS(SELECT 1 FROM whaleu_ratings.category_icon_review_bindings WHERE account_id=actor AND request_id=request)
 OR EXISTS(SELECT 1 FROM whaleu_ratings.scoped_source_attestations WHERE payload->'management'->>'accountId'=actor::text AND payload->'management'->>'requestId'=request::text)
 OR EXISTS(SELECT 1 FROM whaleu_ratings.scoped_releases WHERE cause->>'accountId'=actor::text AND cause->>'requestId'=request::text)
 OR EXISTS(SELECT 1 FROM whaleu_ratings.effect_events WHERE actor_account_id=actor AND request_id=request)
 THEN RAISE EXCEPTION 'Category icon cold closure cannot conceal execution' USING ERRCODE='23514';END IF;RETURN;END IF;
 -- Full set verification is queued by each receipt write at the last generation.
 -- Artifact reverse hooks retain this exact local same-transaction receipt/cause.
 IF NOT EXISTS(SELECT 1 FROM whaleu_ratings.scoped_command_outcomes o WHERE o.account_id=actor AND o.request_id=request AND o.operation=q.operation AND o.intent_hash=q.intent_hash AND o.mutation_transaction=pg_current_xact_id()
 AND q.receipt=jsonb_build_object('protocolVersion',5,'requestId',request,'operation',q.operation,'intentHash',q.intent_hash,'outcome',o.outcome)||CASE WHEN o.outcome='closed' THEN jsonb_build_object('code',o.code) ELSE jsonb_build_object('result',o.result) END)
 THEN RAISE EXCEPTION 'Category icon artifact lacks its exact same-transaction outer receipt' USING ERRCODE='23514';END IF;
 RETURN;END IF;
 PERFORM whaleu_ratings.verify_category_management_command_pre_icon(actor,request);
END$$;
DO $patch$DECLARE definition text;branch text;BEGIN
 SELECT pg_get_functiondef('whaleu_ratings.scoped_preparation_guard()'::regprocedure) INTO definition;
 branch:=$branch$
 IF NEW.intent->'protocolVersion'='5'::jsonb THEN
 SELECT * INTO c FROM whaleu_ratings.scoped_contexts WHERE id=NEW.context_id;
 IF NOT coalesce(NEW.command_family='category' AND NEW.preparation_transaction=pg_current_xact_id() AND c.context->'protocolVersion'='5'::jsonb
 AND c.context->>'purpose'='manage_categories' AND c.context->>'mode'='management' AND c.context->>'managementSnapshot'=NEW.intent->'payload'->>'expectedSnapshot'
 AND c.context->'mediaSnapshot'=NEW.intent->'mediaSnapshot'
 AND (c.context-ARRAY['protocolVersion','actorId','purpose','mode','heads','managementSnapshot','expiresAt','operations','mediaSnapshot','capabilities'])=NEW.intent->'context'
 AND NEW.valid_until<=c.valid_until AND whaleu_ratings.category_icon_plan_valid(NEW,true),false)
 THEN RAISE EXCEPTION 'Category icon preparation requires exact full current plan and context' USING ERRCODE='23514';END IF;RETURN NEW;END IF;
$branch$;
 IF position('BEGIN' in definition)=0 THEN RAISE EXCEPTION 'Missing original preparation body';END IF;
 definition:=overlay(definition placing 'BEGIN'||branch from position('BEGIN' in definition) for 5);EXECUTE definition;
 SELECT pg_get_functiondef('whaleu_ratings.scoped_execution_guard()'::regprocedure) INTO definition;
 branch:=$branch$
 IF NEW.cause_kind IN ('category_execution','category_release') AND EXISTS(SELECT 1 FROM whaleu_ratings.scoped_command_preparations WHERE account_id=NEW.account_id AND request_id=NEW.request_id AND intent->'protocolVersion'='5'::jsonb) THEN
 DECLARE ip whaleu_ratings.category_icon_preparations;BEGIN
 SELECT * INTO p FROM whaleu_ratings.scoped_command_preparations WHERE account_id=NEW.account_id AND request_id=NEW.request_id;
 SELECT * INTO ip FROM whaleu_ratings.category_icon_preparations WHERE actor_id=NEW.account_id AND request_id=NEW.request_id;
 SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=NEW.account_id AND request_id=NEW.request_id FOR UPDATE NOWAIT;
 IF NOT coalesce(NEW.mutation_transaction=pg_current_xact_id() AND p.command_family='category' AND p.operation=q.operation AND p.intent_hash=q.intent_hash AND ip.outer_hash=q.intent_hash AND q.receipt IS NULL AND p.valid_until>clock_timestamp(),false)
 OR EXISTS(SELECT 1 FROM whaleu_ratings.category_icon_recovery_fences WHERE actor_id=p.account_id AND request_id=p.request_id)
 THEN RAISE EXCEPTION 'Category icon execution requires sole fresh outer request authority' USING ERRCODE='23514';END IF;
 IF NEW.cause_kind='category_execution' THEN
 IF NOT whaleu_ratings.category_icon_plan_valid(p,true) OR EXISTS(SELECT 1 FROM whaleu_ratings.scoped_source_attestations s JOIN jsonb_array_elements(p.category_plan->'sourceIssues') i ON s.id=(i->>'id')::uuid)
 OR NEW.artifact_id<>p.context_id OR NEW.artifact_revision<>p.context_id OR NEW.proof<>whaleu_ratings.category_icon_execution_proof(p,ip)
 THEN RAISE EXCEPTION 'Category icon execution lacks exact before-state text and media CAS' USING ERRCODE='23514';END IF;
 ELSE
 IF NOT EXISTS(SELECT 1 FROM whaleu_ratings.scoped_command_causes WHERE account_id=p.account_id AND request_id=p.request_id AND cause_kind='category_execution' AND mutation_transaction=pg_current_xact_id() AND proof=whaleu_ratings.category_icon_execution_proof(p,ip))
 THEN RAISE EXCEPTION 'Category icon release requires original exact execution' USING ERRCODE='23514';END IF;
 END IF;RETURN NEW;END;END IF;
$branch$;
 IF position('BEGIN' in definition)=0 THEN RAISE EXCEPTION 'Missing original execution body';END IF;
 definition:=overlay(definition placing 'BEGIN'||branch from position('BEGIN' in definition) for 5);EXECUTE definition;
END$patch$;
CREATE FUNCTION whaleu_ratings.category_icon_definition_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p whaleu_ratings.scoped_command_preparations;ip whaleu_ratings.category_icon_preparations;r jsonb;source jsonb;predecessors uuid[];BEGIN
 SELECT * INTO p FROM whaleu_ratings.scoped_command_preparations WHERE account_id=NEW.actor_id AND request_id=NEW.request_id;
 SELECT * INTO ip FROM whaleu_ratings.category_icon_preparations WHERE actor_id=NEW.actor_id AND request_id=NEW.request_id;
 SELECT value INTO STRICT r FROM jsonb_array_elements(ip.media_plan->'plan'->'afterRoots') WHERE value->>'definitionId'=NEW.id::text;
 source:=CASE WHEN r->>'kind'='base' THEN r->'source' ELSE r->'baseSource' END;
 SELECT coalesce(array_agg((b->>'definitionId')::uuid ORDER BY b->>'definitionId'),'{}'::uuid[]) INTO predecessors FROM jsonb_array_elements(ip.media_plan->'plan'->'beforeRoots') b
 WHERE b->'categoryId'=r->'categoryId' AND b->'kind'=r->'kind' AND (r->>'kind'='base' OR b->'campusId'=r->'campusId') AND b->>'definitionId'<>NEW.id::text;
 IF NOT coalesce(NEW.publication_transaction=pg_current_xact_id() AND NEW.intent_hash=ip.outer_hash AND p.intent_hash=ip.outer_hash
 AND EXISTS(SELECT 1 FROM whaleu_ratings.scoped_command_causes e WHERE e.account_id=p.account_id AND e.request_id=p.request_id AND e.cause_kind='category_execution' AND e.mutation_transaction=pg_current_xact_id() AND e.proof=whaleu_ratings.category_icon_execution_proof(p,ip))
 AND NEW.category_id::text=r->>'categoryId' AND NEW.identity_id::text=r->>'identityId' AND NEW.kind=r->>'kind' AND NEW.campus_id::text IS NOT DISTINCT FROM r->>'campusId'
 AND (NEW.base_source_id::text,NEW.base_source_revision::text)=(source->>'id',source->>'revision')
 AND (NEW.text_source_id::text,NEW.text_source_revision::text) IS NOT DISTINCT FROM (r->'source'->>'id',r->'source'->>'revision')
 AND NEW.value=r->'value' AND NEW.value->>'kind'<>'unresolved' AND NEW.appearance_id::text IS NOT DISTINCT FROM r->'value'->'appearance'->>'appearanceId'
 AND NEW.predecessors=predecessors AND NEW.definition_digest=whaleu_ratings.category_icon_digest('definition',whaleu_ratings.category_icon_root_body(r)),false)
 THEN RAISE EXCEPTION 'Category icon definition needs complete exact outer command cause' USING ERRCODE='23514';END IF;RETURN NEW;
END$$;
CREATE TRIGGER category_icon_definition_guard BEFORE INSERT ON whaleu_ratings.category_icon_definitions FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.category_icon_definition_guard();
CREATE FUNCTION whaleu_ratings.category_icon_appearance_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ip whaleu_ratings.category_icon_preparations;p whaleu_ratings.scoped_command_preparations;a jsonb;b whaleu_media.bindings;BEGIN
 SELECT preparation.* INTO STRICT ip FROM whaleu_ratings.category_icon_preparations preparation JOIN whaleu_ratings.scoped_command_causes e ON e.account_id=preparation.actor_id AND e.request_id=preparation.request_id AND e.cause_kind='category_execution' AND e.mutation_transaction=pg_current_xact_id()
 WHERE preparation.media_plan->'plan'->'newAppearances' @> jsonb_build_array(jsonb_build_object('appearanceId',NEW.id));
 SELECT * INTO p FROM whaleu_ratings.scoped_command_preparations WHERE account_id=ip.actor_id AND request_id=ip.request_id;
 SELECT value INTO STRICT a FROM jsonb_array_elements(ip.media_plan->'plan'->'newAppearances') WHERE value->>'appearanceId'=NEW.id::text;
 SELECT * INTO b FROM whaleu_media.bindings WHERE id=NEW.media_binding_id;
 IF NOT coalesce(NEW.publication_transaction=pg_current_xact_id() AND a=jsonb_build_object('appearanceId',NEW.id,'categoryId',NEW.category_id,'identityId',NEW.identity_id,'actorId',NEW.actor_id,'assetId',NEW.asset_id,'manifestDigest',NEW.manifest_digest,'origin',NEW.origin)
 AND NEW.actor_id=p.account_id AND b.asset_id=NEW.asset_id AND b.owner_kind='ratings' AND b.resource_kind='category_icon' AND b.resource_id=NEW.id AND b.content_version=1 AND b.slot='icon' AND b.ordinal=0 AND b.manifest_digest=NEW.manifest_digest
 AND b.detached_at IS NULL,false)
 THEN RAISE EXCEPTION 'Category icon appearance requires exact planned Media8 binding' USING ERRCODE='23514';END IF;RETURN NEW;
END$$;
CREATE TRIGGER category_icon_appearance_guard BEFORE INSERT ON whaleu_ratings.category_icon_appearances FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.category_icon_appearance_guard();
CREATE FUNCTION whaleu_ratings.category_icon_root_head_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ip whaleu_ratings.category_icon_preparations;r jsonb;matched integer;BEGIN
 SELECT count(*) INTO matched FROM whaleu_ratings.category_icon_preparations preparation JOIN whaleu_ratings.scoped_command_causes e ON e.account_id=preparation.actor_id AND e.request_id=preparation.request_id AND e.cause_kind='category_execution' AND e.mutation_transaction=pg_current_xact_id()
 WHERE CASE WHEN TG_OP='DELETE' THEN EXISTS(SELECT 1 FROM jsonb_array_elements(preparation.media_plan->'plan'->'beforeRoots') b WHERE b->>'definitionId'=OLD.definition_id::text AND whaleu_ratings.category_icon_root_key(b)=OLD.root_key)
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(preparation.media_plan->'plan'->'afterRoots') a WHERE whaleu_ratings.category_icon_root_key(a)=OLD.root_key)
 ELSE NEW.mutation_transaction=pg_current_xact_id() AND EXISTS(SELECT 1 FROM jsonb_array_elements(preparation.media_plan->'plan'->'afterRoots') a WHERE a->>'definitionId'=NEW.definition_id::text AND whaleu_ratings.category_icon_root_key(a)=NEW.root_key AND a->'scopeKeys'=to_jsonb(NEW.scope_keys) AND a->>'retention'=NEW.retention) END;
 IF matched<>1 THEN RAISE EXCEPTION 'Category icon root head requires unique exact whole-root execution' USING ERRCODE='23514';END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END$$;
CREATE TRIGGER category_icon_root_head_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_ratings.category_icon_definition_heads FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.category_icon_root_head_guard();
CREATE FUNCTION whaleu_ratings.category_icon_final_roots(actor uuid,request uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE p whaleu_ratings.scoped_command_preparations;ip whaleu_ratings.category_icon_preparations;o whaleu_ratings.scoped_command_outcomes;a jsonb;BEGIN
 SELECT * INTO p FROM whaleu_ratings.scoped_command_preparations WHERE account_id=actor AND request_id=request;
 SELECT * INTO ip FROM whaleu_ratings.category_icon_preparations WHERE actor_id=actor AND request_id=request;
 SELECT * INTO o FROM whaleu_ratings.scoped_command_outcomes WHERE account_id=actor AND request_id=request;
 IF p.intent->'protocolVersion' IS DISTINCT FROM '5'::jsonb OR o.outcome NOT IN ('applied','noop') THEN RETURN;END IF;
 IF whaleu_ratings.category_icon_complete_roots() IS DISTINCT FROM ip.media_plan->'plan'->'afterRoots' THEN RAISE EXCEPTION 'Category icon command did not publish complete exact root closure' USING ERRCODE='23514';END IF;
 FOR a IN SELECT value FROM jsonb_array_elements(ip.media_plan->'plan'->'newAppearances') LOOP
 IF NOT EXISTS(SELECT 1 FROM whaleu_ratings.category_icon_appearances fresh WHERE fresh.id=(a->>'appearanceId')::uuid AND fresh.publication_transaction=pg_current_xact_id()) THEN RAISE EXCEPTION 'Category icon command is missing its appearance' USING ERRCODE='23514';END IF;END LOOP;
END$$;
CREATE FUNCTION whaleu_ratings.category_icon_causal_reverse_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actor uuid;request uuid;BEGIN
 IF TG_TABLE_NAME='category_icon_preparations' THEN actor:=NEW.actor_id;request:=NEW.request_id;
 ELSIF TG_TABLE_NAME='category_icon_definitions' THEN actor:=NEW.actor_id;request:=NEW.request_id;
 ELSIF TG_TABLE_NAME='category_icon_review_bindings' THEN actor:=NEW.account_id;request:=NEW.request_id;
 ELSE actor:=NEW.account_id;request:=NEW.request_id;END IF;
 PERFORM whaleu_ratings.verify_category_management_command(actor,request);RETURN NULL;
END$$;
-- A preparation is legal before a command receipt; it is verified immediately
-- through the original preparation trigger, not mistaken for a completed write.
CREATE CONSTRAINT TRIGGER category_icon_definition_reverse AFTER INSERT ON whaleu_ratings.category_icon_definitions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.category_icon_causal_reverse_guard();
CREATE CONSTRAINT TRIGGER category_icon_review_reverse AFTER INSERT ON whaleu_ratings.category_icon_review_bindings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.category_icon_causal_reverse_guard();
CREATE CONSTRAINT TRIGGER category_icon_outcome_roots AFTER INSERT ON whaleu_ratings.scoped_command_outcomes DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.intent->'protocolVersion'='5'::jsonb) EXECUTE FUNCTION whaleu_ratings.category_icon_causal_reverse_guard();
-- Complete coverage is issued against the original adopted release and source
-- lineage. No missing field, boolean, production URL, or opaque legacy adoption
-- is an absence proof. Registrations seed nothing and have no default issuer.
CREATE FUNCTION whaleu_ratings.category_icon_coverage_inventory(protocol uuid) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE v whaleu_ratings.scope_protocol_versions;l record;proof jsonb;override_proof jsonb;s whaleu_ratings.scoped_source_attestations;p whaleu_ratings.scoped_command_preparations;result jsonb:='[]'::jsonb;BEGIN
 SELECT * INTO v FROM whaleu_ratings.scope_protocol_versions WHERE id=protocol;
 IF v.id IS NULL OR v.phase<>'adopted' THEN RETURN NULL;END IF;
 FOR l IN SELECT lineage.*,c.scope_key,c.region_id FROM whaleu_ratings.scoped_catalogs c JOIN whaleu_ratings.scoped_category_lineage lineage ON lineage.catalog_id=c.id
 WHERE c.release_id=v.release_id AND coalesce(c.region_id::text,'global')=v.logical_scope_key ORDER BY c.scope_key COLLATE "C",lineage.category_id LOOP
 proof:=whaleu_ratings.category_icon_strict_text_absence(l.base_source_id,l.base_source_revision,l.category_id,l.identity_id);
 IF proof IS NULL THEN RETURN NULL;END IF;
 override_proof:='null'::jsonb;
 IF l.override_source_id IS NOT NULL THEN
 SELECT * INTO s FROM whaleu_ratings.scoped_source_attestations WHERE id=l.override_source_id AND revision=l.override_source_revision;
 SELECT * INTO p FROM whaleu_ratings.scoped_command_preparations WHERE account_id=(s.payload->'management'->>'accountId')::uuid AND request_id=(s.payload->'management'->>'requestId')::uuid;
 IF NOT coalesce(s.issuer='ratings-category-management' AND p.intent->'protocolVersion'='2'::jsonb AND p.operation='set_category_override_scoped' AND whaleu_ratings.category_management_intent_valid(p.intent)
 AND p.intent_hash=whaleu_ratings.scoped_intent_hash(p.intent) AND EXISTS(SELECT 1 FROM jsonb_array_elements(p.category_plan->'sourceIssues') i WHERE i->>'id'=s.id::text AND i->>'revision'=s.revision::text AND i->'payload'=s.payload)
 AND (s.payload->>'action'='inherit' OR s.payload->'reviewEnvelope'->'assetIds'='[]'::jsonb)
 AND EXISTS(SELECT 1 FROM whaleu_ratings.requests q JOIN whaleu_ratings.scoped_command_outcomes o ON (o.account_id,o.request_id)=(q.account_id,q.request_id) WHERE q.account_id=p.account_id AND q.request_id=p.request_id AND q.intent_hash=p.intent_hash AND q.receipt->'protocolVersion'='2'::jsonb AND o.outcome='applied' AND o.intent=p.intent AND o.intent_hash=q.intent_hash AND o.mutation_transaction=s.publication_transaction),false) THEN RETURN NULL;END IF;
 override_proof:=jsonb_build_object('version','strict-text-override-v1','sourceId',s.id,'sourceRevision',s.revision,'sourceDigest',s.digest,'accountId',p.account_id,'requestId',p.request_id,'intentHash',p.intent_hash);
 END IF;
 result:=result||jsonb_build_array(jsonb_build_object('catalogId',l.catalog_id,'scopeKey',l.scope_key,'categoryId',l.category_id,'identityId',l.identity_id,'baseSource',jsonb_build_object('id',l.base_source_id,'revision',l.base_source_revision),'overrideSource',CASE WHEN l.override_source_id IS NULL THEN 'null'::jsonb ELSE jsonb_build_object('id',l.override_source_id,'revision',l.override_source_revision) END,'baseEvidence',proof,'overrideEvidence',override_proof));
 END LOOP;RETURN result;
EXCEPTION WHEN others THEN RETURN NULL;END$$;
CREATE FUNCTION whaleu_ratings.category_icon_route_contract() RETURNS text LANGUAGE sql IMMUTABLE AS $$
 SELECT whaleu_ratings.category_icon_digest('routes',jsonb_build_object('version',1,'management','v5/ratings/category-management','requests','v5/ratings/requests','public','v5/ratings','media','ratings-category-icon-media-v1','operations',jsonb_build_array('create_categories_scoped','edit_category_base_scoped','set_category_override_scoped','reorder_categories_scoped','set_category_visibility_scoped','set_category_lifecycle_scoped','set_category_scope_scoped','batch_update_subcategories_scoped','create_system_category_scoped')))
$$;
CREATE FUNCTION whaleu_ratings.category_icon_native_contract() RETURNS text LANGUAGE sql IMMUTABLE AS $$
 SELECT whaleu_ratings.category_icon_digest('native',jsonb_build_object('version',1,'protocolVersion',5,'reviewVersion',8,'mediaVersion',8,'journalVersion',13,'scope','single-icon-base-exact-campus-override','pending','same-key-exact-hash-recovery','io',2,'lease',4,'bytes',10485760,'batchNodes',32))
$$;
CREATE FUNCTION whaleu_ratings.category_icon_capability_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s whaleu_ratings.scoped_source_attestations;v whaleu_ratings.scope_protocol_versions;coverage jsonb;BEGIN
 SELECT * INTO s FROM whaleu_ratings.scoped_source_attestations WHERE id=NEW.source_id AND revision=NEW.source_revision;
 SELECT * INTO v FROM whaleu_ratings.scope_protocol_versions WHERE id=NEW.protocol_version_id;
 coverage:=whaleu_ratings.category_icon_coverage_inventory(v.id);
 IF NOT coalesce(NEW.issuer='ratings-category-icon-capability-owner' AND NEW.provenance_ref='rating-category-icon-adoption:'||v.id::text||':'||s.id::text||':'||s.revision::text
 AND coverage IS NOT NULL AND NEW.coverage_inventory=coverage AND NEW.source_digest=s.digest AND (v.capability_source_id,v.capability_source_revision)=(s.id,s.revision)
 AND NEW.routes_digest=whaleu_ratings.category_icon_route_contract() AND NEW.native_digest=whaleu_ratings.category_icon_native_contract()
 AND NEW.valid_from>=s.effective_at AND NEW.valid_until<=s.valid_until AND whaleu_ratings.scoped_source_current(s.id,s.revision,clock_timestamp())
 AND NEW.compatibility_digest=whaleu_ratings.category_icon_digest('compatibility',jsonb_build_object('protocolVersion',5,'reviewVersion',8,'mediaVersion',8,'journalVersion',13,'extensionVersion',NEW.extension_version,'slots',NEW.slots,'sourceId',s.id,'sourceRevision',s.revision,'sourceDigest',s.digest,'routesDigest',NEW.routes_digest,'nativeDigest',NEW.native_digest))
 AND NEW.adoption_digest=whaleu_ratings.category_icon_digest('adoption',jsonb_build_object('protocolVersionId',v.id,'generation',v.generation,'releaseId',v.release_id,'manifest',v.manifest,'compatibilityDigest',NEW.compatibility_digest,'coverageDigest',NEW.coverage_digest)),false)
 THEN RAISE EXCEPTION 'Category icon capability requires complete proven exact adopted source coverage' USING ERRCODE='23514';END IF;RETURN NEW;
END$$;
CREATE TRIGGER category_icon_capability_guard BEFORE INSERT ON whaleu_ratings.category_icon_capability_sources FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.category_icon_capability_guard();
-- Append after the command-owner functions in 0090. This fragment does not
-- replace an original verifier with a weaker wrapper or change an original OID.
-- Historical payload validation is deliberately separate from fresh/current
-- publication: a carried predecessor must retain its own exact original seal.
CREATE FUNCTION whaleu_ratings.category_icon_manifest_management_valid(release uuid) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE m whaleu_ratings.category_icon_release_manifests;r whaleu_ratings.scoped_releases;slots jsonb;slot jsonb;entry jsonb;content jsonb;sources jsonb;b whaleu_ratings.category_icon_review_bindings;position integer:=0;keys text[];BEGIN
 SELECT * INTO m FROM whaleu_ratings.category_icon_release_manifests WHERE release_id=release;
 SELECT * INTO r FROM whaleu_ratings.scoped_releases WHERE id=release;
 SELECT array_agg(value ORDER BY value COLLATE "C") INTO keys FROM jsonb_array_elements_text(r.cause->'categoryIconScopeKeys');
 slots:=whaleu_ratings.category_icon_management_slots(m.root_snapshot,keys);
 IF slots IS NULL OR jsonb_typeof(m.management_coverage) IS DISTINCT FROM 'array' OR jsonb_array_length(slots)<>jsonb_array_length(m.management_coverage) THEN RETURN false;END IF;
 SELECT coalesce(jsonb_object_agg(a.id::text||':'||a.revision::text,jsonb_build_object('id',a.id,'revision',a.revision,'kind',a.source_kind,'key',a.source_key,'scopeKeys',a.scope_keys,'payload',a.payload)),'{}'::jsonb) INTO sources
 FROM whaleu_ratings.scoped_source_attestations a WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(m.root_snapshot) root
 WHERE jsonb_build_object('id',a.id,'revision',a.revision)=CASE WHEN root->>'kind'='base' THEN root->'source' ELSE root->'baseSource' END OR jsonb_build_object('id',a.id,'revision',a.revision)=root->'source');
 FOR slot IN SELECT value FROM jsonb_array_elements(slots) LOOP
 entry:=m.management_coverage->position;position:=position+1;
 content:=whaleu_ratings.category_icon_planned_root_content(sources,slot->'base',CASE WHEN slot->'root'->>'kind'='override' THEN slot->'root' ELSE NULL END,slot->'selector',true);
 SELECT * INTO b FROM whaleu_ratings.category_icon_review_bindings WHERE id=(entry->'review'->>'id')::uuid;
 IF NOT coalesce(content IS NOT NULL AND content->'icon'->>'kind'='image'
 AND entry=jsonb_build_object('scopeKey',CASE WHEN content->'selector'->>'kind'='global' THEN 'global' ELSE 'campus:'||(content->'selector'->>'campusId') END,
 'categoryId',content->'categoryId','content',content,'review',jsonb_build_object('id',b.id,'definitionDigest',b.definition_digest,'approvalDigest',b.approval_digest))
 AND b.envelope->'content'=content AND b.definition_digest=whaleu_ratings.category_icon_digest('content',content)
 AND b.definition_id::text=b.envelope->>'definitionId' AND b.definition_digest=b.envelope->>'definitionDigest'
 AND b.approval_digest=whaleu_community.rating_category_icon_approval_digest(b.envelope)
 AND whaleu_community.rating_category_icon_immutable_refs_match(b.envelope),false) THEN RETURN false;END IF;
 END LOOP;RETURN true;
EXCEPTION WHEN others THEN RETURN false;END$$;

CREATE FUNCTION whaleu_ratings.category_icon_release_payload_valid(release uuid) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE r whaleu_ratings.scoped_releases;m whaleu_ratings.category_icon_release_manifests;
 item record;b whaleu_ratings.category_icon_review_bindings;content jsonb;body jsonb;
 rows_json jsonb;digests jsonb;root jsonb;d whaleu_ratings.category_icon_definitions;definition_body jsonb;n bigint;
BEGIN
 SELECT * INTO r FROM whaleu_ratings.scoped_releases WHERE id=release;
 SELECT * INTO m FROM whaleu_ratings.category_icon_release_manifests WHERE release_id=release;
 IF NOT coalesce(r.cause->>'categoryIconExtension'='ratings-category-icon-v1'
 AND r.cause->>'categoryIconDigest'=m.digest AND m.extension_version='ratings-category-icon-v1'
 AND m.publication_transaction=r.publication_transaction AND whaleu_ratings.category_icon_roots_valid(m.root_snapshot),false)
 THEN RETURN false;END IF;
 -- The extent covers every original output and binds exact predecessor heads,
 -- including the negative fact that an unadopted scope had no Category extent.
 -- Only explicit C1 commands may grow the adopted set; foreign carry is checked below.
 IF jsonb_typeof(r.cause->'categoryIconScopeKeys') IS DISTINCT FROM 'array'
 OR r.cause->'categoryIconScopeKeys'='[]'::jsonb
 OR r.cause->'categoryIconScopeKeys' IS DISTINCT FROM (
 SELECT coalesce(jsonb_agg(scope_key ORDER BY scope_key COLLATE "C"),'[]'::jsonb)
 FROM whaleu_ratings.scoped_release_scopes WHERE release_id=release AND (r.cause->'categoryIconScopeKeys') ? scope_key)
 OR m.scope_extent IS DISTINCT FROM (
 SELECT coalesce(jsonb_agg(jsonb_build_object('scopeKey',s.scope_key,
 'adopted',whaleu_ratings.category_icon_scope_adopted(r.cause,s.scope_key),
 'beforeCatalogId',s.before_catalog_id,'beforeHeadRevision',s.before_head_revision,'beforeReleaseId',prior.release_id,
 'beforeAdopted',whaleu_ratings.category_icon_scope_adopted(old.cause,s.scope_key)) ORDER BY s.scope_key COLLATE "C"),'[]'::jsonb)
 FROM whaleu_ratings.scoped_release_scopes s LEFT JOIN whaleu_ratings.scoped_catalogs prior ON prior.id=s.before_catalog_id
 LEFT JOIN whaleu_ratings.scoped_releases old ON old.id=prior.release_id WHERE s.release_id=release)
 THEN RETURN false;END IF;
 -- A release cannot hide an unlisted catalog or borrow another release's row.
 IF EXISTS(SELECT 1 FROM whaleu_ratings.scoped_catalogs c WHERE c.release_id=release AND NOT EXISTS(
 SELECT 1 FROM whaleu_ratings.scoped_release_scopes s WHERE s.release_id=release AND (s.after_catalog_id,s.scope_key,s.after_head_revision)=(c.id,c.scope_key,c.head_revision)))
 OR EXISTS(SELECT 1 FROM whaleu_ratings.scoped_release_scopes s LEFT JOIN whaleu_ratings.scoped_catalogs c ON c.id=s.after_catalog_id
 WHERE s.release_id=release AND NOT coalesce(c.release_id=release AND c.scope_key=s.scope_key AND c.head_revision=s.after_head_revision AND c.publication_transaction=r.publication_transaction AND c.sealed,false))
 OR EXISTS(SELECT 1 FROM whaleu_ratings.category_icon_projections p LEFT JOIN whaleu_ratings.scoped_catalogs c ON c.id=p.catalog_id
 WHERE p.release_id=release AND NOT coalesce(c.release_id=release AND whaleu_ratings.category_icon_scope_adopted(r.cause,c.scope_key) AND p.publication_transaction=r.publication_transaction,false))
 OR EXISTS(SELECT 1 FROM whaleu_ratings.scoped_categories a JOIN whaleu_ratings.scoped_catalogs c ON c.id=a.catalog_id
 LEFT JOIN whaleu_ratings.category_icon_projections p ON (p.catalog_id,p.category_id,p.effective_revision)=(a.catalog_id,a.category_id,a.effective_revision)
 WHERE c.release_id=release AND whaleu_ratings.category_icon_scope_adopted(r.cause,c.scope_key) AND p.release_id IS DISTINCT FROM release) THEN RETURN false;END IF;
 SELECT count(*) INTO n FROM whaleu_ratings.category_icon_projections WHERE release_id=release;
 IF n<>m.row_count OR n>100000 OR n<>(SELECT count(*) FROM whaleu_ratings.scoped_categories a JOIN whaleu_ratings.scoped_catalogs c ON c.id=a.catalog_id WHERE c.release_id=release AND whaleu_ratings.category_icon_scope_adopted(r.cause,c.scope_key)) THEN RETURN false;END IF;
 -- Snapshot-only virtual legacy roots may be unresolved/strict absence. Every
 -- stored definition, and every root actually selected by Review below, must
 -- retain the exact immutable body, never only an ID or self-declared digest.
 FOR root IN SELECT value FROM jsonb_array_elements(m.root_snapshot) LOOP
 SELECT * INTO d FROM whaleu_ratings.category_icon_definitions WHERE id=(root->>'definitionId')::uuid;
 IF FOUND THEN
 definition_body:=CASE WHEN d.kind='base' THEN jsonb_build_object('kind',d.kind,'definitionId',d.id,'categoryId',d.category_id,'identityId',d.identity_id,'source',jsonb_build_object('id',d.base_source_id,'revision',d.base_source_revision),'value',d.value)
 ELSE jsonb_build_object('kind',d.kind,'definitionId',d.id,'categoryId',d.category_id,'identityId',d.identity_id,'source',CASE WHEN d.text_source_id IS NULL THEN NULL ELSE jsonb_build_object('id',d.text_source_id,'revision',d.text_source_revision) END,'baseSource',jsonb_build_object('id',d.base_source_id,'revision',d.base_source_revision),'campusId',d.campus_id,'value',d.value) END;
 IF definition_body IS DISTINCT FROM whaleu_ratings.category_icon_root_body(root)
 OR d.definition_digest IS DISTINCT FROM whaleu_ratings.category_icon_digest('definition',definition_body)
 OR d.appearance_id IS DISTINCT FROM (root->'value'->'appearance'->>'appearanceId')::uuid THEN RETURN false;END IF;
 END IF;END LOOP;
 FOR item IN SELECT p.*,c.scope_key,c.campus_id,a.effective_digest,l.placement_revision,l.proof
 FROM whaleu_ratings.category_icon_projections p
 JOIN whaleu_ratings.scoped_catalogs c ON c.id=p.catalog_id
 JOIN whaleu_ratings.scoped_categories a ON (a.catalog_id,a.category_id,a.effective_revision)=(p.catalog_id,p.category_id,p.effective_revision)
 LEFT JOIN whaleu_ratings.scoped_category_lineage l ON (l.catalog_id,l.category_id,l.effective_revision)=(a.catalog_id,a.category_id,a.effective_revision)
 WHERE p.release_id=release LOOP
 SELECT * INTO b FROM whaleu_ratings.category_icon_review_bindings WHERE id=item.review_binding_id;
 content:=whaleu_ratings.category_icon_content(item.proof,item.campus_id,m.root_snapshot);
 IF NOT coalesce(content IS NOT NULL AND whaleu_community.rating_category_icon_content_shape(content)
 AND item.effective_digest=whaleu_ratings.scoped_digest('effective',item.proof)
 AND item.placement_revision::text=item.proof->>'placementRevision'
 AND b.definition_digest=whaleu_ratings.category_icon_digest('content',content)
 AND b.envelope->'content'=content AND b.definition_id::text=b.envelope->>'definitionId'
 AND b.definition_digest=b.envelope->>'definitionDigest'
 AND b.approval_digest=whaleu_community.rating_category_icon_approval_digest(b.envelope)
 AND whaleu_community.rating_category_icon_immutable_refs_match(b.envelope),false) THEN RETURN false;END IF;
 body:=jsonb_build_object('releaseId',release,'catalogId',item.catalog_id,'scopeKey',item.scope_key,'categoryId',item.category_id,
 'effectiveRevision',item.effective_revision,'effectiveDigest',item.effective_digest,'placementRevision',item.placement_revision,
 'extensionVersion','ratings-category-icon-v1','content',content,'review',jsonb_build_object('id',b.id,'definitionDigest',b.definition_digest,'approvalDigest',b.approval_digest));
 IF item.extension_digest IS DISTINCT FROM whaleu_ratings.category_icon_digest('release-row',body)
 OR item.projection IS DISTINCT FROM body||jsonb_build_object('digest',item.extension_digest)
 OR item.appearance_id IS DISTINCT FROM (content->'icon'->'appearance'->>'appearanceId')::uuid THEN RETURN false;END IF;
 END LOOP;
 SELECT coalesce(jsonb_agg(p.projection ORDER BY c.scope_key COLLATE "C",p.category_id),'[]'::jsonb),
 coalesce(jsonb_agg(p.extension_digest ORDER BY c.scope_key COLLATE "C",p.category_id),'[]'::jsonb)
 INTO rows_json,digests FROM whaleu_ratings.category_icon_projections p JOIN whaleu_ratings.scoped_catalogs c ON c.id=p.catalog_id WHERE p.release_id=release;
 RETURN whaleu_ratings.category_icon_manifest_management_valid(release) AND m.digest=whaleu_ratings.category_icon_digest('release',jsonb_build_object('extent',m.scope_extent,'rows',digests,'managementCoverage',m.management_coverage))
 AND m.serialized_bytes=octet_length(convert_to(whaleu_community.content_canonical_json(jsonb_build_object('extent',m.scope_extent,'roots',m.root_snapshot,'capabilities',m.capabilities,'rows',rows_json,'managementCoverage',m.management_coverage)),'UTF8'));
EXCEPTION WHEN others THEN RETURN false;END$$;

-- Exact length of the original compact canonical JSON, without sorting keys or
-- recursively allocating every nested serialization. JSONB text uses the same
-- scalar/key escaping; ordering cannot change length. Preserve each complete
-- quoted token (including escaped quotes/backslashes) and remove only external
-- formatting whitespace. This is a budget counter, never a hash/receipt codec.
CREATE FUNCTION whaleu_ratings.category_icon_canonical_octets(value jsonb) RETURNS bigint LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT octet_length(regexp_replace(value::text,$pattern$("(?:[^"\\]|\\.)*")|[[:space:]]+$pattern$,$replacement$\1$replacement$,'g'))::bigint
$$;

CREATE FUNCTION whaleu_ratings.verify_category_icon_release(release uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r whaleu_ratings.scoped_releases;m whaleu_ratings.category_icon_release_manifests;
 p whaleu_ratings.scoped_command_preparations;ip whaleu_ratings.category_icon_preparations;
 previous record;item record;capabilities jsonb;original_bytes bigint;review_bytes bigint;marked boolean;planned_management jsonb;
BEGIN
 SELECT * INTO r FROM whaleu_ratings.scoped_releases WHERE id=release;
 IF r.id IS NULL THEN RAISE EXCEPTION 'Category icon release is missing' USING ERRCODE='23514';END IF;
 marked:=r.cause ? 'categoryIconExtension' OR r.cause ? 'categoryIconDigest' OR r.cause ? 'categoryIconScopeKeys';
 IF NOT marked THEN
 IF r.cause_kind='category_icon_management'
 OR EXISTS(SELECT 1 FROM whaleu_ratings.category_icon_release_manifests WHERE release_id=release)
 OR EXISTS(SELECT 1 FROM whaleu_ratings.category_icon_projections projection JOIN whaleu_ratings.scoped_catalogs c ON c.id=projection.catalog_id WHERE projection.release_id=release OR c.release_id=release)
 OR EXISTS(SELECT 1 FROM whaleu_ratings.scoped_release_scopes s JOIN whaleu_ratings.scoped_catalogs c ON c.id=s.before_catalog_id JOIN whaleu_ratings.scoped_releases old ON old.id=c.release_id
 WHERE s.release_id=release AND whaleu_ratings.category_icon_scope_adopted(old.cause,s.scope_key))
 THEN RAISE EXCEPTION 'Unmarked release cannot insert or discard Category icon publication' USING ERRCODE='23514';END IF;
 RETURN;END IF;
 SELECT * INTO m FROM whaleu_ratings.category_icon_release_manifests WHERE release_id=release;
 IF NOT coalesce(r.publication_transaction=pg_current_xact_id() AND r.cause->>'categoryIconExtension'='ratings-category-icon-v1'
 AND jsonb_typeof(r.cause->'categoryIconDigest')='string' AND r.cause->>'categoryIconDigest' ~ '^[a-f0-9]{64}$'
 AND whaleu_ratings.category_icon_release_payload_valid(release)
 AND m.root_snapshot=whaleu_ratings.category_icon_complete_roots(),false)
 THEN RAISE EXCEPTION 'Category icon full same-release seal mismatch' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(m.root_snapshot) root JOIN whaleu_ratings.category_icon_terminal_retirements retired
 ON retired.appearance_id=(root->'value'->'appearance'->>'appearanceId')::uuid)
 THEN RAISE EXCEPTION 'Category icon release retained a terminal appearance' USING ERRCODE='23514';END IF;
 -- Registrations are the exact current protocol heads of adopted output domains,
 -- including empty catalogs. No arbitrary accepted capability subset suffices.
 IF EXISTS(SELECT 1 FROM (SELECT DISTINCT coalesce(region_id::text,'global') logical FROM whaleu_ratings.scoped_catalogs WHERE release_id=release AND whaleu_ratings.category_icon_scope_adopted(r.cause,scope_key)) domain
 LEFT JOIN whaleu_ratings.scope_protocol_heads h ON h.logical_scope_key=domain.logical
 LEFT JOIN whaleu_ratings.scope_protocol_versions v ON v.id=h.version_id AND v.logical_scope_key=domain.logical
 LEFT JOIN whaleu_ratings.category_icon_capability_sources a ON a.protocol_version_id=v.id
 WHERE a.id IS NULL OR NOT whaleu_ratings.category_icon_capability_current(a.id,clock_timestamp()))
 THEN RAISE EXCEPTION 'Category icon release lacks complete current capabilities' USING ERRCODE='23514';END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',a.id,'protocolVersionId',a.protocol_version_id,'sourceDigest',a.source_digest,
 'validUntil',to_char(a.valid_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'current',true) ORDER BY a.protocol_version_id),'[]'::jsonb)
 INTO capabilities FROM whaleu_ratings.category_icon_capability_sources a JOIN whaleu_ratings.scope_protocol_heads h ON h.version_id=a.protocol_version_id
 WHERE h.logical_scope_key IN (SELECT DISTINCT coalesce(region_id::text,'global') FROM whaleu_ratings.scoped_catalogs WHERE release_id=release AND whaleu_ratings.category_icon_scope_adopted(r.cause,scope_key));
 IF capabilities='[]'::jsonb OR m.capabilities IS DISTINCT FROM capabilities
 THEN RAISE EXCEPTION 'Category icon capability snapshot differs from original output domains' USING ERRCODE='23514';END IF;
 -- Extend, rather than reset, the original whole-release admission budget.
 SELECT coalesce(sum(whaleu_ratings.category_icon_canonical_octets(to_jsonb(x))),0) INTO original_bytes FROM (
 SELECT to_jsonb(a) value FROM whaleu_ratings.scoped_categories a JOIN whaleu_ratings.scoped_catalogs c ON c.id=a.catalog_id WHERE c.release_id=release
 UNION ALL SELECT to_jsonb(a) FROM whaleu_ratings.scoped_category_lineage a JOIN whaleu_ratings.scoped_catalogs c ON c.id=a.catalog_id WHERE c.release_id=release
 UNION ALL SELECT to_jsonb(a) FROM whaleu_ratings.scoped_target_memberships a JOIN whaleu_ratings.scoped_catalogs c ON c.id=a.catalog_id WHERE c.release_id=release
 UNION ALL SELECT to_jsonb(s) FROM whaleu_ratings.scoped_source_attestations s JOIN jsonb_array_elements(r.source_vector) v ON s.id=(v->>'id')::uuid) x;
 SELECT coalesce(sum(whaleu_ratings.category_icon_canonical_octets(to_jsonb(b))),0) INTO review_bytes
 FROM whaleu_ratings.category_icon_review_bindings b WHERE b.id IN (
 SELECT review_binding_id FROM whaleu_ratings.category_icon_projections WHERE release_id=release
 UNION SELECT (entry->'review'->>'id')::uuid FROM jsonb_array_elements(m.management_coverage) entry);
 IF original_bytes+m.serialized_bytes+review_bytes>67108864 THEN RAISE EXCEPTION 'Category icon whole-release admission exceeded' USING ERRCODE='23514';END IF;
 FOR item IN SELECT b.*,projection.projection,projection.appearance_id FROM whaleu_ratings.category_icon_projections projection
 JOIN whaleu_ratings.category_icon_review_bindings b ON b.id=projection.review_binding_id WHERE projection.release_id=release LOOP
 IF NOT whaleu_community.rating_category_icon_definition_current(item.definition_id,item.definition_digest,item.envelope)
 THEN RAISE EXCEPTION 'Category icon release Review8 is not current' USING ERRCODE='23514';END IF;
 IF item.appearance_id IS NOT NULL AND NOT whaleu_ratings.category_icon_appearance_current(item.appearance_id,clock_timestamp()) THEN RAISE EXCEPTION 'Category icon release requires exact current Media8 appearance' USING ERRCODE='23514';END IF;
 END LOOP;
 FOR item IN SELECT coverage.value content_row,b.* FROM jsonb_array_elements(m.management_coverage) coverage
 JOIN whaleu_ratings.category_icon_review_bindings b ON b.id=(coverage.value->'review'->>'id')::uuid LOOP
 IF NOT whaleu_community.rating_category_icon_definition_current(item.definition_id,item.definition_digest,item.envelope)
 OR NOT whaleu_ratings.category_icon_appearance_current((item.content_row->'content'->'icon'->'appearance'->>'appearanceId')::uuid,clock_timestamp())
 OR NOT EXISTS(SELECT 1 FROM whaleu_ratings.category_icon_management_review_heads h JOIN whaleu_ratings.category_icon_definition_heads d ON d.definition_id=h.root_definition_id
 WHERE h.root_definition_id=(item.content_row->'content'->'icon'->>'definitionId')::uuid AND h.selector=item.content_row->'content'->'selector' AND h.review_binding_id=item.id)
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(jsonb_build_array(item.content_row->'content'->'baseSource',item.content_row->'content'->'overrideSource')) source
 LEFT JOIN whaleu_ratings.scoped_source_attestations a ON (a.id,a.revision)=((source->>'id')::uuid,(source->>'revision')::uuid)
 WHERE source<>'null'::jsonb AND (a.id IS NULL OR NOT whaleu_ratings.scoped_source_current(a.id,a.revision,clock_timestamp())
 OR (a.payload ? 'reviewEnvelope' AND NOT whaleu_community.rating_scoped_category_source_current(a.id,a.revision,a.payload->'reviewEnvelope'))
 OR (a.source_kind<>'scoped_category_override' AND whaleu_ratings.scoped_base_category(a.id,a.revision) IS NULL)))
 THEN RAISE EXCEPTION 'Category icon management closure requires exact current source Review and Media' USING ERRCODE='23514';END IF;
 END LOOP;
 IF r.cause_kind='category_icon_management' THEN
 SELECT * INTO p FROM whaleu_ratings.scoped_command_preparations WHERE account_id=(r.cause->>'accountId')::uuid AND request_id=(r.cause->>'requestId')::uuid;
 SELECT * INTO ip FROM whaleu_ratings.category_icon_preparations WHERE actor_id=p.account_id AND request_id=p.request_id;
 IF NOT coalesce(p.command_family='category' AND p.intent->'protocolVersion'='5'::jsonb
 AND p.intent_hash=whaleu_ratings.category_icon_intent_hash(p.intent) AND p.intent_hash=ip.outer_hash AND NOT ip.noop
 AND r.cause->>'kind'=r.cause_kind AND r.affected_scope_keys=ip.affected_scope_keys
 AND r.cause->'categoryIconScopeKeys'=to_jsonb(r.affected_scope_keys)
 AND ip.media_plan->'plan'->'affectedScopeKeys'=to_jsonb(r.affected_scope_keys)
 AND ip.media_plan->'plan'->'afterRoots'=m.root_snapshot
 AND ip.plan_digest=whaleu_ratings.category_icon_digest('plan',(ip.media_plan->'plan')||jsonb_build_object('digest',''))
 AND EXISTS(SELECT 1 FROM whaleu_ratings.scoped_command_causes e WHERE e.account_id=p.account_id AND e.request_id=p.request_id
 AND e.cause_kind='category_release' AND (e.artifact_id,e.artifact_revision)=(r.id,r.id) AND e.mutation_transaction=r.publication_transaction
 AND e.proof->>'intentHash'=ip.outer_hash AND e.proof->>'textHash'=ip.text_hash
 AND e.proof->>'mediaPlanDigest'=ip.plan_digest AND e.proof->>'mediaReleaseDigest'=m.digest),false)
 THEN RAISE EXCEPTION 'Category icon release is not the exact outer prepared whole-scope command' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM whaleu_ratings.scoped_release_scopes s WHERE s.release_id=release AND NOT ip.before_heads @>
 jsonb_build_array(jsonb_build_object('scopeKey',s.scope_key,'catalogRevision',s.before_catalog_id,'headRevision',s.before_head_revision)))
 THEN RAISE EXCEPTION 'Category icon release predecessor differs from full media preparation' USING ERRCODE='23514';END IF;
 planned_management:=whaleu_ratings.category_icon_planned_management_contents(p,ip);
 IF planned_management IS NULL THEN RAISE EXCEPTION 'Category icon exact management contents are unavailable' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(ip.media_plan->'coverage') coverage
 WHERE NOT EXISTS(
   SELECT 1 FROM whaleu_ratings.category_icon_review_bindings b
   WHERE b.envelope->'content'=coverage->'content'
   AND whaleu_community.rating_category_icon_definition_current(b.definition_id,b.definition_digest,b.envelope)
   AND CASE WHEN coverage->'binding'='null'::jsonb THEN b.account_id=p.account_id AND b.request_id=p.request_id
     AND b.publication_transaction=r.publication_transaction AND ip.media_plan->'reviewEnvelopes' @> jsonb_build_array(b.envelope)
     ELSE coverage->'binding'=jsonb_build_object('id',b.id,'definition_id',b.definition_id,'definition_digest',b.definition_digest,'approval_digest',b.approval_digest,'envelope',b.envelope) END
   AND (EXISTS(SELECT 1 FROM whaleu_ratings.category_icon_projections projection
       WHERE projection.release_id=release AND projection.review_binding_id=b.id AND projection.projection->'content'=coverage->'content')
     OR EXISTS(SELECT 1 FROM jsonb_array_elements(planned_management) slot
       JOIN whaleu_ratings.category_icon_management_review_heads head
         ON head.root_definition_id=(slot->>'rootDefinitionId')::uuid AND head.selector=slot->'selector'
       WHERE slot->'content'=coverage->'content' AND head.review_binding_id=b.id))))
 OR EXISTS(SELECT 1 FROM whaleu_ratings.category_icon_projections projection WHERE projection.release_id=release AND NOT EXISTS(
   SELECT 1 FROM jsonb_array_elements(ip.media_plan->'coverage') coverage WHERE coverage->'content'=projection.projection->'content'))
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(planned_management) slot WHERE NOT EXISTS(
   SELECT 1 FROM whaleu_ratings.category_icon_management_review_heads head JOIN whaleu_ratings.category_icon_review_bindings b ON b.id=head.review_binding_id
   JOIN jsonb_array_elements(ip.media_plan->'coverage') coverage ON coverage->'content'=slot->'content'
   WHERE head.root_definition_id=(slot->>'rootDefinitionId')::uuid AND head.selector=slot->'selector'
   AND head.root_key=whaleu_community.content_canonical_json(jsonb_build_array(head.root_definition_id,head.selector))
   AND b.envelope->'content'=slot->'content'
   AND m.management_coverage @> jsonb_build_array(jsonb_build_object('scopeKey',CASE WHEN slot->'selector'->>'kind'='global' THEN 'global' ELSE 'campus:'||(slot->'selector'->>'campusId') END,'categoryId',slot->'content'->'categoryId','content',slot->'content','review',jsonb_build_object('id',b.id,'definitionDigest',b.definition_digest,'approvalDigest',b.approval_digest)))
   AND whaleu_community.rating_category_icon_definition_current(b.definition_id,b.definition_digest,b.envelope)
   AND whaleu_ratings.category_icon_appearance_current((slot->'content'->'icon'->'appearance'->>'appearanceId')::uuid,clock_timestamp())
   AND CASE WHEN coverage->'binding'='null'::jsonb THEN b.account_id=p.account_id AND b.request_id=p.request_id
     AND b.publication_transaction=r.publication_transaction AND ip.media_plan->'reviewEnvelopes' @> jsonb_build_array(b.envelope)
     ELSE coverage->'binding'=jsonb_build_object('id',b.id,'definition_id',b.definition_id,'definition_digest',b.definition_digest,'approval_digest',b.approval_digest,'envelope',b.envelope) END))
 THEN RAISE EXCEPTION 'Category icon planned public and recoverable Review coverage differs from whole publication' USING ERRCODE='23514';END IF;

 ELSE
 -- Foreign publishers preserve the exact per-scope adoption set. Unadopted
 -- outputs remain original text catalogs in this SAME atomic whole release.
 IF EXISTS(SELECT 1 FROM whaleu_ratings.scoped_release_scopes scope_row
 JOIN whaleu_ratings.scoped_catalogs prior_catalog ON prior_catalog.id=scope_row.before_catalog_id
 JOIN whaleu_ratings.category_icon_release_manifests prior_manifest ON prior_manifest.release_id=prior_catalog.release_id
 WHERE scope_row.release_id=release AND whaleu_ratings.category_icon_scope_adopted(r.cause,scope_row.scope_key)
 AND (SELECT coalesce(jsonb_agg(value ORDER BY ord),'[]'::jsonb) FROM jsonb_array_elements(m.management_coverage) WITH ORDINALITY e(value,ord) WHERE value->>'scopeKey'=scope_row.scope_key)
 IS DISTINCT FROM (SELECT coalesce(jsonb_agg(value ORDER BY ord),'[]'::jsonb) FROM jsonb_array_elements(prior_manifest.management_coverage) WITH ORDINALITY e(value,ord) WHERE value->>'scopeKey'=scope_row.scope_key))
 THEN RAISE EXCEPTION 'Foreign release cannot change or incompletely carry recoverable Category icon Review' USING ERRCODE='23514';END IF;
 FOR previous IN SELECT DISTINCT c.release_id predecessor_release FROM whaleu_ratings.scoped_release_scopes s
 JOIN whaleu_ratings.scoped_catalogs c ON c.id=s.before_catalog_id JOIN whaleu_ratings.scoped_releases old ON old.id=c.release_id WHERE s.release_id=release AND whaleu_ratings.category_icon_scope_adopted(old.cause,s.scope_key) LOOP
 IF NOT whaleu_ratings.category_icon_release_payload_valid(previous.predecessor_release)
 THEN RAISE EXCEPTION 'Foreign release predecessor has an incomplete Category icon seal' USING ERRCODE='23514';END IF;
 END LOOP;
 FOR previous IN SELECT s.*,c.release_id predecessor_release,old.cause predecessor_cause FROM whaleu_ratings.scoped_release_scopes s
 LEFT JOIN whaleu_ratings.scoped_catalogs c ON c.id=s.before_catalog_id LEFT JOIN whaleu_ratings.scoped_releases old ON old.id=c.release_id WHERE s.release_id=release LOOP
 IF whaleu_ratings.category_icon_scope_adopted(r.cause,previous.scope_key) IS DISTINCT FROM whaleu_ratings.category_icon_scope_adopted(previous.predecessor_cause,previous.scope_key)
 OR EXISTS(SELECT 1 FROM whaleu_ratings.category_icon_projections fresh LEFT JOIN whaleu_ratings.category_icon_projections old
 ON old.catalog_id=previous.before_catalog_id AND old.category_id=fresh.category_id AND old.release_id=previous.predecessor_release
 WHERE fresh.catalog_id=previous.after_catalog_id AND (old.category_id IS NULL OR old.projection->'content' IS DISTINCT FROM fresh.projection->'content'
 OR old.review_binding_id IS DISTINCT FROM fresh.review_binding_id OR old.projection->'review' IS DISTINCT FROM fresh.projection->'review' OR old.appearance_id IS DISTINCT FROM fresh.appearance_id))
 OR EXISTS(SELECT 1 FROM whaleu_ratings.category_icon_projections old WHERE old.catalog_id=previous.before_catalog_id AND NOT EXISTS(
 SELECT 1 FROM whaleu_ratings.category_icon_projections fresh WHERE fresh.catalog_id=previous.after_catalog_id AND fresh.category_id=old.category_id))
 THEN RAISE EXCEPTION 'Foreign release cannot change or incompletely carry Category icon image' USING ERRCODE='23514';END IF;
 END LOOP;
 END IF;
END$$;

-- The two reverse boundaries reject raw late appends, mismatched releases and
-- unmarked extension rows even if SET CONSTRAINTS already flushed a release.
CREATE FUNCTION whaleu_ratings.category_icon_release_row_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r whaleu_ratings.scoped_releases;BEGIN
 SELECT * INTO r FROM whaleu_ratings.scoped_releases WHERE id=NEW.release_id;
 IF NOT coalesce(NEW.publication_transaction=pg_current_xact_id() AND r.publication_transaction=NEW.publication_transaction
 AND r.cause->>'categoryIconExtension'='ratings-category-icon-v1' AND r.cause->>'categoryIconDigest' ~ '^[a-f0-9]{64}$',false)
 THEN RAISE EXCEPTION 'Category icon artifact requires its exact fresh marked release' USING ERRCODE='23514';END IF;
 IF TG_TABLE_NAME='category_icon_projections' THEN
 IF NOT EXISTS(SELECT 1 FROM whaleu_ratings.scoped_catalogs c
 JOIN whaleu_ratings.scoped_categories a ON a.catalog_id=c.id
 JOIN whaleu_ratings.category_icon_release_manifests m ON m.release_id=c.release_id
 WHERE c.id=NEW.catalog_id AND c.release_id=NEW.release_id AND c.publication_transaction=r.publication_transaction
 AND a.category_id=NEW.category_id AND a.effective_revision=NEW.effective_revision
 AND m.publication_transaction=r.publication_transaction AND m.digest=r.cause->>'categoryIconDigest' AND whaleu_ratings.category_icon_scope_adopted(r.cause,c.scope_key))
 THEN RAISE EXCEPTION 'Category icon projection cannot borrow a catalog, row or manifest' USING ERRCODE='23514';END IF;
 END IF;
 RETURN NEW;END$$;
CREATE FUNCTION whaleu_ratings.category_icon_release_row_causal() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF TG_TABLE_NAME='category_icon_release_manifests' THEN
 -- The original immutable release owns its unchanged whole-ledger verifier.
 -- This reverse artifact hook proves exact membership; the manifest statement
 -- also advances the Category epoch, whose final deferred generation rechecks
 -- the complete mutable extension after every relevant later writer.
 IF NOT EXISTS(SELECT 1 FROM whaleu_ratings.scoped_releases r
 WHERE r.id=NEW.release_id AND r.publication_transaction=pg_current_xact_id()
 AND NEW.publication_transaction=r.publication_transaction
 AND r.cause->>'categoryIconExtension'='ratings-category-icon-v1'
 AND r.cause->>'categoryIconDigest'=NEW.digest
 AND whaleu_ratings.category_icon_release_payload_valid(r.id))
 THEN RAISE EXCEPTION 'Category icon manifest lacks its exact immutable release payload' USING ERRCODE='23514';END IF;
 RETURN NULL;END IF;
 -- The immutable release and manifest boundaries verify the full set once.
 -- Every projection must occupy an existing exact fresh category key; after
 -- either boundary is flushed, complete coverage + PK makes late additions
 -- impossible. Do not rescan 100,000 rows for every row-level reverse hook.
 IF NOT EXISTS(SELECT 1 FROM whaleu_ratings.scoped_releases r
 JOIN whaleu_ratings.category_icon_release_manifests m ON m.release_id=r.id
 JOIN whaleu_ratings.scoped_catalogs c ON c.release_id=r.id AND c.id=NEW.catalog_id
 JOIN whaleu_ratings.scoped_release_scopes s ON s.release_id=r.id AND s.after_catalog_id=c.id AND s.scope_key=c.scope_key
 JOIN whaleu_ratings.scoped_catalog_heads h ON h.scope_key=c.scope_key AND h.catalog_id=c.id AND h.release_id=r.id AND h.head_revision=c.head_revision
 WHERE r.id=NEW.release_id AND r.publication_transaction=pg_current_xact_id() AND NEW.publication_transaction=r.publication_transaction
 AND c.sealed AND c.publication_transaction=r.publication_transaction AND m.publication_transaction=r.publication_transaction
 AND s.after_head_revision=c.head_revision AND whaleu_ratings.category_icon_scope_adopted(r.cause,c.scope_key) AND r.cause->>'categoryIconExtension'='ratings-category-icon-v1' AND r.cause->>'categoryIconDigest'=m.digest)
 THEN RAISE EXCEPTION 'Category icon projection lacks its exact sealed current publication' USING ERRCODE='23514';END IF;RETURN NULL;
END$$;
CREATE TRIGGER category_icon_release_row_guard BEFORE INSERT ON whaleu_ratings.category_icon_release_manifests FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.category_icon_release_row_guard();
CREATE TRIGGER category_icon_release_row_guard BEFORE INSERT ON whaleu_ratings.category_icon_projections FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.category_icon_release_row_guard();
CREATE CONSTRAINT TRIGGER category_icon_release_row_causal AFTER INSERT ON whaleu_ratings.category_icon_release_manifests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.category_icon_release_row_causal();
CREATE CONSTRAINT TRIGGER category_icon_release_row_causal AFTER INSERT ON whaleu_ratings.category_icon_projections DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.category_icon_release_row_causal();

ALTER TABLE whaleu_ratings.category_icon_management_review_heads ADD CONSTRAINT category_icon_management_review_head_shape CHECK(
 whaleu_community.rating_scoped_selector_shape(selector)
 AND root_key=whaleu_community.content_canonical_json(jsonb_build_array(root_definition_id,selector)));
CREATE FUNCTION whaleu_ratings.category_icon_management_review_head_guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Category icon management Review pointers are retained' USING ERRCODE='23514';END IF;
 IF NEW.mutation_transaction IS DISTINCT FROM pg_current_xact_id()
 OR (TG_OP='UPDATE' AND (NEW.root_key,NEW.root_definition_id,NEW.selector) IS DISTINCT FROM (OLD.root_key,OLD.root_definition_id,OLD.selector))
 THEN RAISE EXCEPTION 'Category icon management pointer identity is immutable' USING ERRCODE='23514';END IF;RETURN NEW;
END$$;
CREATE TRIGGER category_icon_management_review_head_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_ratings.category_icon_management_review_heads FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.category_icon_management_review_head_guard();
CREATE OR REPLACE FUNCTION whaleu_ratings.category_icon_management_review_head_causal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE release uuid;BEGIN
 SELECT DISTINCT r.id INTO STRICT release FROM whaleu_ratings.scoped_releases r
 JOIN whaleu_ratings.scoped_command_preparations p ON p.account_id=(r.cause->>'accountId')::uuid AND p.request_id=(r.cause->>'requestId')::uuid
 JOIN whaleu_ratings.category_icon_preparations ip ON ip.actor_id=p.account_id AND ip.request_id=p.request_id
 JOIN whaleu_ratings.category_icon_release_manifests manifest ON manifest.release_id=r.id
 JOIN whaleu_ratings.category_icon_review_bindings b ON b.id=NEW.review_binding_id
 JOIN whaleu_ratings.category_icon_definitions d ON d.id=NEW.root_definition_id
 JOIN whaleu_ratings.category_icon_definition_heads h ON h.definition_id=d.id
 JOIN LATERAL jsonb_array_elements(whaleu_ratings.category_icon_planned_management_contents(p,ip)) slot
   ON slot->>'rootDefinitionId'=NEW.root_definition_id::text AND slot->'selector'=NEW.selector
 JOIN LATERAL jsonb_array_elements(ip.media_plan->'coverage') coverage ON coverage->'content'=slot->'content'
 WHERE r.cause_kind='category_icon_management' AND p.command_family='category' AND p.intent->'protocolVersion'='5'::jsonb
 AND r.publication_transaction=NEW.mutation_transaction AND r.publication_transaction=pg_current_xact_id()
 AND manifest.publication_transaction=r.publication_transaction AND r.cause->>'categoryIconExtension'='ratings-category-icon-v1'
 AND r.cause->>'categoryIconDigest'=manifest.digest AND manifest.root_snapshot=ip.media_plan->'plan'->'afterRoots'
 AND p.intent_hash=ip.outer_hash AND p.intent_hash=whaleu_ratings.category_icon_intent_hash(p.intent)
 AND manifest.management_coverage @> jsonb_build_array(jsonb_build_object('scopeKey',CASE WHEN slot->'selector'->>'kind'='global' THEN 'global' ELSE 'campus:'||(slot->'selector'->>'campusId') END,'categoryId',slot->'content'->'categoryId','content',slot->'content','review',jsonb_build_object('id',b.id,'definitionDigest',b.definition_digest,'approvalDigest',b.approval_digest)))
 AND b.envelope->'content'=slot->'content' AND b.envelope->'content'->'icon'->>'definitionId'=d.id::text
 AND d.value=(b.envelope->'content'->'icon')-ARRAY['origin','definitionId'] AND d.value->>'kind'='image'
 AND d.appearance_id=(b.envelope->'content'->'icon'->'appearance'->>'appearanceId')::uuid AND d.category_id=(b.envelope->'content'->>'categoryId')::uuid
 AND CASE WHEN coverage->'binding'='null'::jsonb THEN b.account_id=p.account_id AND b.request_id=p.request_id
   AND b.publication_transaction=r.publication_transaction AND ip.media_plan->'reviewEnvelopes' @> jsonb_build_array(b.envelope)
   ELSE coverage->'binding'=jsonb_build_object('id',b.id,'definition_id',b.definition_id,'definition_digest',b.definition_digest,'approval_digest',b.approval_digest,'envelope',b.envelope) END
 AND whaleu_community.rating_category_icon_definition_current(b.definition_id,b.definition_digest,b.envelope)
 AND whaleu_ratings.category_icon_appearance_current(d.appearance_id,clock_timestamp());
 RETURN NULL;
EXCEPTION WHEN no_data_found OR too_many_rows THEN RAISE EXCEPTION 'Category icon management pointer lacks one exact current-root same-release publication' USING ERRCODE='23514';END$$;

CREATE CONSTRAINT TRIGGER category_icon_management_review_head_causal AFTER INSERT OR UPDATE ON whaleu_ratings.category_icon_management_review_heads DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.category_icon_management_review_head_causal();

-- The new cause uses the SAME whole legacy-domain exit proof as 0069. It does
-- not turn absence, an icon label, or a single surviving domain into exit proof.
CREATE FUNCTION whaleu_ratings.category_icon_management_compat_exit(manifest uuid,category uuid) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE m whaleu_ratings.compat_projection_manifests;v whaleu_ratings.compat_versions;r whaleu_ratings.scoped_releases;
 p whaleu_ratings.scoped_command_preparations;ip whaleu_ratings.category_icon_preparations;domain_keys text[];item jsonb;row record;
BEGIN
 SELECT * INTO m FROM whaleu_ratings.compat_projection_manifests WHERE id=manifest;
 SELECT * INTO v FROM whaleu_ratings.compat_versions WHERE id=m.compat_version_id;
 SELECT * INTO r FROM whaleu_ratings.scoped_releases WHERE id=m.release_id;
 IF r.cause_kind IS DISTINCT FROM 'category_icon_management' OR r.publication_transaction<>pg_current_xact_id()
 OR m.publication_transaction<>r.publication_transaction OR v.publication_transaction<>r.publication_transaction OR v.release_id<>r.id THEN RETURN false;END IF;
 SELECT * INTO p FROM whaleu_ratings.scoped_command_preparations WHERE account_id=(r.cause->>'accountId')::uuid AND request_id=(r.cause->>'requestId')::uuid;
 SELECT * INTO ip FROM whaleu_ratings.category_icon_preparations WHERE actor_id=p.account_id AND request_id=p.request_id;
 domain_keys:=whaleu_ratings.scoped_compat_scope_keys(v);
 IF NOT coalesce(p.command_family='category' AND p.operation='set_category_scope_scoped' AND p.intent->'protocolVersion'='5'::jsonb
 AND p.intent_hash=whaleu_ratings.category_icon_intent_hash(p.intent) AND ip.outer_hash=p.intent_hash AND NOT ip.noop
 AND ip.text_intent=whaleu_ratings.category_icon_text_intent(p.intent) AND ip.text_hash=whaleu_ratings.scoped_intent_hash(ip.text_intent)
 AND p.category_plan->'categoryIds' @> to_jsonb(ARRAY[category]) AND ip.affected_scope_keys=r.affected_scope_keys
 AND ip.media_plan->'plan'->'affectedScopeKeys'=to_jsonb(r.affected_scope_keys) AND domain_keys<@ip.affected_scope_keys
 AND ip.before_compat_heads @> jsonb_build_array(jsonb_build_object('compatKey',v.compat_key,'versionId',v.previous_version_id,'legacyCatalogId',m.before_catalog_id,'scopeKeys',domain_keys))
 AND r.cause->>'categoryIconExtension'='ratings-category-icon-v1'
 AND EXISTS(SELECT 1 FROM whaleu_ratings.category_icon_release_manifests seal WHERE seal.release_id=r.id AND seal.digest=r.cause->>'categoryIconDigest'
 AND seal.publication_transaction=r.publication_transaction AND seal.root_snapshot=ip.media_plan->'plan'->'afterRoots')
 AND EXISTS(SELECT 1 FROM whaleu_ratings.scoped_command_causes e JOIN whaleu_ratings.requests q USING(account_id,request_id)
 WHERE e.account_id=p.account_id AND e.request_id=p.request_id AND e.cause_kind='category_execution' AND e.mutation_transaction=pg_current_xact_id()
 AND e.artifact_id=p.context_id AND e.artifact_revision=p.context_id AND q.operation=p.operation AND q.intent_hash=p.intent_hash
 AND e.proof=jsonb_build_object('intentHash',ip.outer_hash,'textHash',ip.text_hash,'planDigest',p.category_plan->>'previewDigest','mediaPlanDigest',ip.plan_digest,'contextRevision',p.context_revision,
 'executionDigest',whaleu_ratings.scoped_digest('category-icon-execution',jsonb_build_object('accountId',p.account_id,'requestId',p.request_id,'intentHash',ip.outer_hash,'textHash',ip.text_hash,'mediaPlanDigest',ip.plan_digest))))
 AND EXISTS(SELECT 1 FROM whaleu_ratings.scoped_command_causes e WHERE e.account_id=p.account_id AND e.request_id=p.request_id AND e.cause_kind='category_release'
 AND e.artifact_id=r.id AND e.artifact_revision=r.id AND e.mutation_transaction=pg_current_xact_id()
 AND e.proof=jsonb_build_object('intentHash',ip.outer_hash,'textHash',ip.text_hash,'planDigest',p.category_plan->>'previewDigest','mediaPlanDigest',ip.plan_digest,
 'mediaReleaseDigest',r.cause->>'categoryIconDigest','heads',whaleu_ratings.category_management_heads(r.affected_scope_keys))),false) THEN RETURN false;END IF;
 SELECT i INTO item FROM jsonb_array_elements(p.category_plan->'sourceIssues') i WHERE i->>'kind'='scoped_category_scope' AND i ? 'placement' AND i->'payload'->>'categoryId'=category::text;
 IF item IS NULL OR ARRAY(SELECT jsonb_array_elements_text(item->'scopeKeys'))&&domain_keys OR NOT EXISTS(
 SELECT 1 FROM whaleu_ratings.scoped_source_attestations s JOIN whaleu_ratings.category_scope_placements placement ON (placement.source_id,placement.source_revision)=(s.id,s.revision)
 WHERE s.id=(item->>'id')::uuid AND s.revision=(item->>'revision')::uuid AND s.issuer='ratings-category-management' AND s.publication_transaction=pg_current_xact_id()
 AND s.payload=item->'payload' AND placement.category_id=category AND placement.placement_revision=(item->'placement'->>'revision')::uuid
 AND whaleu_ratings.scoped_source_current(s.id,s.revision,clock_timestamp())) THEN RETURN false;END IF;
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(ip.before_heads) head JOIN whaleu_ratings.scoped_category_lineage l ON l.catalog_id=(head->>'catalogRevision')::uuid
 WHERE head->>'scopeKey'=ANY(domain_keys) AND l.category_id=category) THEN RETURN false;END IF;
 IF EXISTS(SELECT 1 FROM unnest(domain_keys) domain WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(ip.before_heads) head WHERE head->>'scopeKey'=domain)) THEN RETURN false;END IF;
 FOR row IN SELECT head FROM jsonb_array_elements(ip.before_heads) head WHERE head->>'scopeKey'=ANY(domain_keys) LOOP
 IF NOT EXISTS(SELECT 1 FROM whaleu_ratings.scoped_release_scopes output WHERE output.release_id=r.id AND output.scope_key=row.head->>'scopeKey'
 AND output.before_catalog_id=(row.head->>'catalogRevision')::uuid AND output.before_head_revision=(row.head->>'headRevision')::uuid
 AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.scoped_categories c WHERE c.catalog_id=output.after_catalog_id AND c.category_id=category)) THEN RETURN false;END IF;
 END LOOP;RETURN true;
EXCEPTION WHEN others THEN RETURN false;END$$;

-- Fail migration rather than silently omit an owner hook if the frozen source
-- differs. CREATE OR REPLACE runs against the original signatures and OIDs.
DO $$DECLARE definition text;needle text;replacement text;expression text;found_count integer;old_oid oid;BEGIN
 SELECT count(*),min(pg_get_expr(conbin,conrelid)) INTO found_count,expression FROM pg_constraint
 WHERE conrelid='whaleu_ratings.scoped_releases'::regclass AND contype='c' AND conname='scoped_releases_cause_kind_check';
 IF found_count<>1 OR expression IS NULL OR position('category_management' in expression)=0 OR position('category_icon_management' in expression)<>0
 THEN RAISE EXCEPTION 'Original scoped release cause constraint has changed';END IF;
 ALTER TABLE whaleu_ratings.scoped_releases DROP CONSTRAINT scoped_releases_cause_kind_check;
 EXECUTE format('ALTER TABLE whaleu_ratings.scoped_releases ADD CONSTRAINT scoped_releases_cause_kind_check CHECK ((%s) OR cause_kind=''category_icon_management'')',expression);
 old_oid:='whaleu_ratings.verify_scoped_release(uuid)'::regprocedure::oid;
 SELECT pg_get_functiondef(old_oid) INTO definition;
 needle:='ELSIF r.cause_kind IN (''create_target_scoped'',''category_management'') THEN';
 replacement:='ELSIF r.cause_kind IN (''create_target_scoped'',''category_management'',''category_icon_management'') THEN';
 IF (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'Original scoped release command dispatch has changed';END IF;
 definition:=replace(definition,needle,replacement);
 needle:=' PERFORM whaleu_ratings.verify_scoped_release_compat(release);';
 IF (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'Original scoped release compatibility seal has changed';END IF;
 definition:=replace(definition,needle,needle||E'\n PERFORM whaleu_ratings.verify_category_icon_release(release);');
 EXECUTE definition;
 IF 'whaleu_ratings.verify_scoped_release(uuid)'::regprocedure::oid<>old_oid THEN RAISE EXCEPTION 'Original scoped release verifier OID changed';END IF;
 old_oid:='whaleu_ratings.category_management_compat_exit(uuid,uuid)'::regprocedure::oid;
 SELECT pg_get_functiondef(old_oid) INTO definition;
 needle:=' SELECT * INTO r FROM whaleu_ratings.scoped_releases WHERE id=m.release_id;';
 IF (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'Original Category whole-domain exit dispatch has changed';END IF;
 definition:=replace(definition,needle,needle||E'\n IF r.cause_kind=''category_icon_management'' THEN RETURN whaleu_ratings.category_icon_management_compat_exit(manifest,category);END IF;');
 EXECUTE definition;
 IF 'whaleu_ratings.category_management_compat_exit(uuid,uuid)'::regprocedure::oid<>old_oid THEN RAISE EXCEPTION 'Original Category exit verifier OID changed';END IF;
END$$;
CREATE FUNCTION whaleu_ratings.category_icon_upload_input_valid(i jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE slot jsonb:=i->'slot';d jsonb:=i->'declaration';op text:=i->>'operation';p jsonb:=i->'payload';BEGIN
 IF NOT coalesce(whaleu_community.rating_scoped_keys(i,ARRAY['protocolVersion','mediaSnapshot','clientRequestId','draftRevision','slot','declaration','operation','context','payload'])
 AND i->'protocolVersion'='5'::jsonb AND i->>'mediaSnapshot' ~ '^[a-f0-9]{64}$' AND whaleu_community.rating_scoped_ids(i,ARRAY['clientRequestId','draftRevision']) AND i->'clientRequestId'<>p->'clientRequestId'
 AND whaleu_ratings.category_management_intent_valid(jsonb_build_object('protocolVersion',2,'operation',op,'context',i->'context','payload',p))
 AND whaleu_community.rating_scoped_keys(d,ARRAY['mime','bytes','sha256']) AND d->>'mime' IN ('image/jpeg','image/png') AND whaleu_community.rating_scoped_integer(d->'bytes',1) AND (d->>'bytes')::bigint<=5242880 AND d->>'sha256' ~ '^[a-f0-9]{64}$',false) THEN RETURN false;END IF;
 IF op IN ('create_categories_scoped','batch_update_subcategories_scoped','create_system_category_scoped') THEN
 RETURN coalesce(whaleu_community.rating_scoped_keys(slot,ARRAY['kind','key']) AND slot->>'kind'='new' AND slot->>'key' ~ '^[a-z][a-z0-9_]{0,31}$'
 AND CASE WHEN op='create_system_category_scoped' THEN slot->>'key'='root' ELSE EXISTS(SELECT 1 FROM jsonb_array_elements(p->CASE WHEN op='create_categories_scoped' THEN 'nodes' ELSE 'addNodes' END) n WHERE n->'key'=slot->'key') END,false);
 ELSIF op='edit_category_base_scoped' THEN RETURN coalesce(whaleu_community.rating_scoped_keys(slot,ARRAY['kind','categoryId']) AND slot->>'kind'='base' AND slot->'categoryId'=p->'categoryId',false);
 ELSIF op='set_category_override_scoped' THEN RETURN coalesce(whaleu_community.rating_scoped_keys(slot,ARRAY['kind','categoryId','campusId']) AND slot->>'kind'='override' AND slot->'categoryId'=p->'categoryId' AND i->'context'->'selector'->>'kind'='campus' AND slot->'campusId'=i->'context'->'selector'->'campusId',false);END IF;
 RETURN false;EXCEPTION WHEN others THEN RETURN false;END$$;
ALTER TABLE whaleu_ratings.category_icon_upload_scopes ADD CONSTRAINT category_icon_upload_input_shape CHECK(whaleu_ratings.category_icon_upload_input_valid(input));
ALTER TABLE whaleu_ratings.category_icon_definitions ADD CONSTRAINT category_icon_definition_required_shape CHECK(
 value ? 'kind' AND (kind<>'base' OR (text_source_id IS NOT NULL AND text_source_revision IS NOT NULL)) AND array_position(predecessors,NULL) IS NULL);
CREATE FUNCTION whaleu_ratings.category_icon_upload_authorization_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE keys text[];BEGIN
 SELECT ARRAY(SELECT DISTINCT k COLLATE "C" FROM (
 SELECT jsonb_array_elements_text(NEW.text_plan->'affectedScopeKeys') k UNION ALL
 SELECT jsonb_array_elements_text(root->'scopeKeys') FROM jsonb_array_elements(whaleu_ratings.category_icon_complete_roots()) root WHERE NEW.origin->>'kind'='base' AND root->>'categoryId'=NEW.category_id::text
 ) domains ORDER BY 1) INTO keys;
 IF NOT coalesce(NEW.publication_transaction=pg_current_xact_id() AND whaleu_ratings.category_icon_upload_authorization_valid(NEW,true) AND NEW.scope_keys=keys
 AND NEW.global_required=((NEW.text_plan->>'globalRequired')::boolean OR 'global'=ANY(keys))
 AND (TG_WHEN='BEFORE' OR EXISTS(SELECT 1 FROM whaleu_ratings.command_claims WHERE account_id=NEW.actor_id AND request_id=NEW.client_request_id AND operation='prepare_category_icon_upload_scope' AND intent_hash=NEW.request_hash)),false)
 THEN RAISE EXCEPTION 'Category upload authorization lacks complete exact original all-of domains' USING ERRCODE='23514';END IF;RETURN NEW;
END$$;
CREATE TRIGGER category_icon_upload_authorization_guard BEFORE INSERT ON whaleu_ratings.category_icon_upload_authorizations FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.category_icon_upload_authorization_guard();
CREATE FUNCTION whaleu_ratings.category_icon_upload_cancel_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM whaleu_ratings.command_claims q WHERE q.account_id=NEW.actor_id AND q.request_id=NEW.client_request_id AND q.operation='prepare_category_icon_upload_scope' AND q.intent_hash=NEW.request_hash)
 OR EXISTS(SELECT 1 FROM whaleu_ratings.category_icon_upload_scopes s WHERE s.actor_id=NEW.actor_id AND s.client_request_id=NEW.client_request_id AND s.scope_request_hash<>NEW.request_hash)
 THEN RAISE EXCEPTION 'Category upload cancellation requires exact shared owner claim' USING ERRCODE='23514';END IF;RETURN NEW;
END$$;
CREATE TRIGGER category_icon_upload_cancel_guard BEFORE INSERT ON whaleu_ratings.category_icon_upload_scope_fences FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.category_icon_upload_cancel_guard();

CREATE FUNCTION whaleu_ratings.category_icon_receipt_full_boundary() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 -- Deferred reverse validation is still mandatory for receipt-only raw writes:
 -- a missing/mismatched outcome or cold fence fails even without an execution.
 PERFORM whaleu_ratings.verify_category_management_command(NEW.account_id,NEW.request_id);RETURN NULL;
END$$;
CREATE CONSTRAINT TRIGGER category_icon_receipt_full_boundary AFTER INSERT OR UPDATE ON whaleu_ratings.requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.receipt->'protocolVersion'='5'::jsonb) EXECUTE FUNCTION whaleu_ratings.category_icon_receipt_full_boundary();
CREATE FUNCTION whaleu_ratings.category_icon_receipt_generation() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 -- Immediate trigger event, not a mutable validation cache. Receipt writes
 -- always queue a fresh final generation after their complete body is present.
 UPDATE whaleu_ratings.category_icon_epoch SET epoch=epoch+1 WHERE singleton;
 RETURN NULL;
END$$;
CREATE TRIGGER category_icon_receipt_generation AFTER INSERT OR UPDATE ON whaleu_ratings.requests FOR EACH ROW WHEN(NEW.receipt->'protocolVersion'='5'::jsonb) EXECUTE FUNCTION whaleu_ratings.category_icon_receipt_generation();
CREATE FUNCTION whaleu_ratings.category_icon_epoch_guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF TG_OP<>'UPDATE' THEN RAISE EXCEPTION 'Category icon generation cannot be removed or recreated' USING ERRCODE='23514';END IF;
 IF (NEW.singleton,NEW.version) IS DISTINCT FROM (OLD.singleton,OLD.version) OR NEW.epoch IS DISTINCT FROM OLD.epoch+1
 THEN RAISE EXCEPTION 'Category icon generation must advance exactly once' USING ERRCODE='23514';END IF;
 RETURN NEW;
END$$;
CREATE TRIGGER category_icon_epoch_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_ratings.category_icon_epoch FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.category_icon_epoch_guard();
CREATE TRIGGER category_icon_epoch_retain BEFORE TRUNCATE ON whaleu_ratings.category_icon_epoch FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.category_icon_epoch_guard();

-- Last-generation validation is a trigger event, never a trusted cache row.
-- Every Category statement writer (including zero rows) advances this epoch.
-- SET CONSTRAINTS early cannot consume a future write's event, and rollback to
-- a savepoint discards its events together with its facts.
-- Keep the additive related-writer check bounded by this transaction rather
-- than scanning the historical original command/release ledgers on old writes.
CREATE INDEX category_icon_execution_transaction ON whaleu_ratings.scoped_command_causes(mutation_transaction,account_id,request_id) WHERE cause_kind='category_execution';
CREATE INDEX category_icon_release_transaction ON whaleu_ratings.scoped_releases(publication_transaction,id) WHERE cause->>'categoryIconExtension'='ratings-category-icon-v1';
CREATE INDEX category_icon_outcome_transaction ON whaleu_ratings.scoped_command_outcomes(mutation_transaction,account_id,request_id);
CREATE FUNCTION whaleu_ratings.category_icon_final_generation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_epoch bigint;command record;publication record;BEGIN
 SELECT epoch INTO current_epoch FROM whaleu_ratings.category_icon_epoch WHERE singleton;
 IF NEW.epoch<>current_epoch THEN RETURN NULL;END IF;
 FOR command IN
 SELECT o.account_id,o.request_id FROM whaleu_ratings.scoped_command_outcomes o
 WHERE o.mutation_transaction=pg_current_xact_id() AND (o.intent->'protocolVersion'='5'::jsonb
 OR EXISTS(SELECT 1 FROM whaleu_ratings.requests q WHERE (q.account_id,q.request_id)=(o.account_id,o.request_id) AND q.receipt->'protocolVersion'='5'::jsonb))
 UNION SELECT e.account_id,e.request_id FROM whaleu_ratings.scoped_command_causes e
 JOIN whaleu_ratings.scoped_command_preparations p ON (p.account_id,p.request_id)=(e.account_id,e.request_id)
 WHERE e.mutation_transaction=pg_current_xact_id() AND e.cause_kind='category_execution' AND p.intent->'protocolVersion'='5'::jsonb LOOP
 PERFORM whaleu_ratings.verify_category_icon_command(command.account_id,command.request_id);
 PERFORM whaleu_ratings.category_icon_final_roots(command.account_id,command.request_id);END LOOP;
 FOR publication IN SELECT id FROM whaleu_ratings.scoped_releases WHERE publication_transaction=pg_current_xact_id() AND cause->>'categoryIconExtension'='ratings-category-icon-v1' LOOP
 PERFORM whaleu_ratings.verify_category_icon_release(publication.id);END LOOP;RETURN NULL;
END$$;
CREATE CONSTRAINT TRIGGER category_icon_final_generation AFTER UPDATE ON whaleu_ratings.category_icon_epoch DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.category_icon_final_generation();

CREATE CONSTRAINT TRIGGER category_icon_upload_authorization_final AFTER INSERT ON whaleu_ratings.category_icon_upload_authorizations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.category_icon_upload_authorization_guard();
-- Original mutable owner epochs also re-enqueue the final generation while a
-- fresh C1 command/release exists. They never acquire a second request authority.
CREATE FUNCTION whaleu_ratings.category_icon_related_writer() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF EXISTS(SELECT 1 FROM whaleu_ratings.scoped_command_causes e JOIN whaleu_ratings.scoped_command_preparations p ON (p.account_id,p.request_id)=(e.account_id,e.request_id)
 WHERE e.mutation_transaction=pg_current_xact_id() AND e.cause_kind='category_execution' AND p.intent->'protocolVersion'='5'::jsonb)
 OR EXISTS(SELECT 1 FROM whaleu_ratings.scoped_releases r WHERE r.publication_transaction=pg_current_xact_id() AND r.cause->>'categoryIconExtension'='ratings-category-icon-v1') THEN
 UPDATE whaleu_ratings.category_icon_epoch SET epoch=epoch+1 WHERE singleton;END IF;RETURN NULL;
END$$;
CREATE TRIGGER category_icon_related_writer AFTER UPDATE ON whaleu_ratings.scoped_source_epoch FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.category_icon_related_writer();
CREATE TRIGGER category_icon_related_writer AFTER UPDATE ON whaleu_ratings.scope_protocol_epoch FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.category_icon_related_writer();
CREATE TRIGGER category_icon_related_writer AFTER UPDATE ON whaleu_community.rating_review_epoch FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.category_icon_related_writer();
CREATE TRIGGER category_icon_related_writer AFTER UPDATE ON whaleu_community.rating_review_binding_epoch FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.category_icon_related_writer();
CREATE TRIGGER category_icon_related_writer AFTER UPDATE ON whaleu_media.media_owner_states FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.category_icon_related_writer();
CREATE FUNCTION whaleu_ratings.category_icon_appearance_current(appearance uuid,instant timestamptz) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT coalesce((SELECT b.detached_at IS NULL AND b.asset_id=a.id AND b.manifest_digest=a.manifest_digest AND b.owner_kind='ratings' AND b.resource_kind='category_icon' AND b.resource_id=owner.id AND b.content_version=1 AND b.slot='icon' AND b.ordinal=0
 AND a.actor_id=owner.actor_id AND a.manifest_digest=owner.manifest_digest AND a.owner_kind='ratings' AND a.resource_kind='category_icon' AND a.purpose='ratings-category-icon-image' AND a.audience='content-gated' AND a.slot='icon' AND a.content_version=1
 AND i.state='ready' AND i.protocol_version=8 AND e.state='allow' AND e.manifest_digest=a.manifest_digest AND e.policy_revision=a.policy_revision AND e.effective_at<=instant AND e.valid_until>instant AND e.valid_until>e.effective_at
 AND a.manifest->>'policyVersion'=a.policy_revision AND a.manifest_digest=encode(sha256(convert_to(E'whaleu-media-manifest:v1\n'||whaleu_media.canonical_json(a.manifest),'UTF8')),'hex')
 AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.category_icon_terminal_retirements t WHERE t.appearance_id=owner.id)
 FROM whaleu_ratings.category_icon_appearances owner JOIN whaleu_media.assets a ON a.id=owner.asset_id JOIN whaleu_media.bindings b ON b.id=owner.media_binding_id
 JOIN whaleu_media.upload_intents i ON i.id=a.intent_id JOIN whaleu_media.asset_safety_heads h ON h.asset_id=a.id JOIN whaleu_media.asset_safety_events e ON (e.asset_id,e.revision,e.id)=(h.asset_id,h.revision,h.event_id)
 WHERE owner.id=appearance),false)
$$;
CREATE FUNCTION whaleu_ratings.category_icon_context_shape(c jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE keys text[];h jsonb;BEGIN
 keys:=ARRAY['protocolVersion','id','token','tokenDigest','actorId','selector','scopeRevision','protocolGeneration','heads','sourceDigest','expiresAt','capabilities','mediaSnapshot','purpose','mode'];
 IF c->>'purpose'='manage_categories' THEN keys:=keys||ARRAY['catalogRevision','headRevision','managementSnapshot','operations'];
 ELSE keys:=keys||ARRAY['sessionGeneration','identityCampusId','issuedAt'];END IF;
 IF NOT coalesce(whaleu_community.rating_scoped_keys(c,keys) AND c->'protocolVersion'='5'::jsonb AND whaleu_community.rating_scoped_ids(c,ARRAY['id','actorId','protocolGeneration'])
 AND c->>'token' ~ '^[A-Za-z0-9_-]{43}$' AND c->>'tokenDigest'=encode(sha256(convert_to(c->>'token','UTF8')),'hex')
 AND c->>'scopeRevision' ~ '^[a-f0-9]{64}$' AND c->>'sourceDigest' ~ '^[a-f0-9]{64}$' AND c->>'mediaSnapshot' ~ '^[a-f0-9]{64}$'
 AND jsonb_typeof(c->'heads')='array' AND jsonb_array_length(c->'heads') BETWEEN 1 AND 1001
 AND (SELECT count(*)=count(DISTINCT x->>'scopeKey') FROM jsonb_array_elements(c->'heads') x)
 AND jsonb_typeof(c->'capabilities')='array' AND jsonb_array_length(c->'capabilities') BETWEEN 1 AND 32 AND c->'capabilities' ? 'category_icon'
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(c->'capabilities') cap WHERE jsonb_typeof(cap)<>'string' OR cap#>>'{}' !~ '^[a-z][a-z0-9_]{0,63}$')
 AND c->>'expiresAt' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$',false) THEN RETURN false;END IF;
 FOR h IN SELECT value FROM jsonb_array_elements(c->'heads') LOOP
 IF NOT coalesce(whaleu_community.rating_scoped_keys(h,ARRAY['scopeKey','catalogRevision','headRevision']) AND whaleu_ratings.scoped_scope_key_valid(h->>'scopeKey') AND whaleu_community.rating_scoped_ids(h,ARRAY['catalogRevision','headRevision']),false) THEN RETURN false;END IF;END LOOP;
 IF c->>'purpose'='manage_categories' THEN RETURN coalesce(c->>'mode'='management' AND c->'capabilities'='["category_icon"]'::jsonb AND jsonb_array_length(c->'heads')=1 AND whaleu_community.rating_scoped_selector_shape(c->'selector')
 AND whaleu_community.rating_scoped_ids(c,ARRAY['catalogRevision','headRevision']) AND c->>'managementSnapshot' ~ '^[a-f0-9]{64}$'
 AND jsonb_typeof(c->'operations')='array' AND jsonb_array_length(c->'operations') BETWEEN 1 AND 9 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(c->'operations') op WHERE NOT whaleu_ratings.category_management_operation(op)),false);
 END IF;
 RETURN coalesce(c->>'purpose' IN ('read','interact','create_target','edit_target','random') AND c->>'mode' IN ('public','admin_preview') AND c->>'sessionGeneration' ~ '^[a-f0-9]{64}$'
 AND whaleu_community.rating_scoped_nullable_id(c->'identityCampusId') AND c->>'issuedAt' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$'
 AND (c->>'expiresAt')::timestamptz>(c->>'issuedAt')::timestamptz AND (c->>'expiresAt')::timestamptz<=(c->>'issuedAt')::timestamptz+interval '5 minutes'
 AND (c->>'purpose'='read' OR c->>'mode'='public')
 AND CASE WHEN c->>'purpose'='random' THEN (whaleu_community.rating_scoped_keys(c->'selector',ARRAY['kind']) AND c->'selector'->>'kind'='global') OR (whaleu_community.rating_scoped_keys(c->'selector',ARRAY['kind','anchorCampusId']) AND c->'selector'->>'kind'='institution_with_global' AND whaleu_community.rating_scoped_ids(c->'selector',ARRAY['anchorCampusId'])) ELSE whaleu_community.rating_scoped_selector_shape(c->'selector') END,false);
EXCEPTION WHEN others THEN RETURN false;END$$;
ALTER TABLE whaleu_ratings.scoped_contexts ADD CONSTRAINT category_icon_context_shape CHECK(context->'protocolVersion' IS DISTINCT FROM '5'::jsonb OR whaleu_ratings.category_icon_context_shape(context));
