-- Explicit new dispatch only. The original v2 planner input remains an internal
-- projection, never a second shared request, receipt or Review8 authority.
SET LOCAL lock_timeout='5s';
SELECT pg_advisory_xact_lock(hashtextextended('whaleu:named-block-policy:v1',0));
CREATE FUNCTION whaleu_ratings.category_icon_replace_shape(v jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT coalesce(whaleu_community.rating_scoped_keys(v,ARRAY['mode','assetId','uploadScopeId']) AND v->>'mode'='replace' AND whaleu_community.rating_scoped_ids(v,ARRAY['assetId','uploadScopeId']),false)
$$;
CREATE FUNCTION whaleu_ratings.category_icon_base_shape(v jsonb,allow_keep boolean) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT coalesce(whaleu_ratings.category_icon_replace_shape(v) OR
 (whaleu_community.rating_scoped_keys(v,ARRAY['mode']) AND (v->>'mode'='clear' OR (allow_keep AND v->>'mode'='keep'))),false)
$$;
CREATE FUNCTION whaleu_ratings.category_icon_override_shape(v jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT coalesce((whaleu_community.rating_scoped_keys(v,ARRAY['mode']) AND v->>'mode'='inherit') OR
 (whaleu_community.rating_scoped_keys(v,ARRAY['mode','value']) AND v->>'mode'='set' AND (v->'value'='null'::jsonb OR
 whaleu_ratings.category_icon_replace_shape(v->'value') OR (whaleu_community.rating_scoped_keys(v->'value',ARRAY['mode']) AND v->'value'->>'mode'='keep'))),false)
$$;
CREATE FUNCTION whaleu_ratings.category_icon_text_intent(i jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE p jsonb:=i->'payload';op text:=i->>'operation';BEGIN
 IF op='create_categories_scoped' THEN p:=jsonb_set(p,'{nodes}',(SELECT coalesce(jsonb_agg(n-'icon' ORDER BY ordinal),'[]'::jsonb) FROM jsonb_array_elements(p->'nodes') WITH ORDINALITY x(n,ordinal)));
 ELSIF op='batch_update_subcategories_scoped' THEN p:=jsonb_set(p,'{addNodes}',(SELECT coalesce(jsonb_agg(n-'icon' ORDER BY ordinal),'[]'::jsonb) FROM jsonb_array_elements(p->'addNodes') WITH ORDINALITY x(n,ordinal)));
 ELSIF op IN ('edit_category_base_scoped','set_category_override_scoped','create_system_category_scoped') THEN p:=p-'icon';END IF;
 RETURN jsonb_build_object('protocolVersion',2,'operation',op,'context',i->'context','payload',p);
EXCEPTION WHEN OTHERS THEN RETURN NULL;END$$;
CREATE FUNCTION whaleu_ratings.category_icon_replacements(i jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE p jsonb:=i->'payload';op text:=i->>'operation';BEGIN
 IF op IN ('create_categories_scoped','batch_update_subcategories_scoped') THEN
 RETURN (SELECT coalesce(jsonb_agg(n->'icon' ORDER BY ordinal),'[]'::jsonb) FROM jsonb_array_elements(p->CASE WHEN op='create_categories_scoped' THEN 'nodes' ELSE 'addNodes' END) WITH ORDINALITY x(n,ordinal) WHERE n->'icon'->>'mode'='replace');
 ELSIF op IN ('edit_category_base_scoped','create_system_category_scoped') AND p->'icon'->>'mode'='replace' THEN RETURN jsonb_build_array(p->'icon');
 ELSIF op='set_category_override_scoped' AND p->'icon'->>'mode'='set' AND p->'icon'->'value'->>'mode'='replace' THEN RETURN jsonb_build_array(p->'icon'->'value');
 END IF;RETURN '[]'::jsonb;
EXCEPTION WHEN OTHERS THEN RETURN NULL;END$$;
CREATE FUNCTION whaleu_ratings.category_icon_intent_valid(i jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE p jsonb:=i->'payload';op text:=i->>'operation';n jsonb;refs jsonb;t jsonb;BEGIN
 IF NOT coalesce(whaleu_community.rating_scoped_keys(i,ARRAY['protocolVersion','mediaSnapshot','operation','context','payload']) AND i->'protocolVersion'='5'::jsonb
 AND i->>'mediaSnapshot' ~ '^[a-f0-9]{64}$',false) THEN RETURN false;END IF;
 t:=whaleu_ratings.category_icon_text_intent(i);
 IF NOT coalesce(whaleu_ratings.category_management_intent_valid(t),false) THEN RETURN false;END IF;
 IF op IN ('create_categories_scoped','batch_update_subcategories_scoped') THEN
 FOR n IN SELECT value FROM jsonb_array_elements(p->CASE WHEN op='create_categories_scoped' THEN 'nodes' ELSE 'addNodes' END) LOOP
 IF NOT whaleu_community.rating_scoped_keys(n,ARRAY['key','parentKey','name','description','icon']) OR NOT whaleu_ratings.category_icon_base_shape(n->'icon',false) THEN RETURN false;END IF;END LOOP;
 ELSIF op IN ('edit_category_base_scoped','create_system_category_scoped') THEN
 IF NOT whaleu_ratings.category_icon_base_shape(p->'icon',op='edit_category_base_scoped') THEN RETURN false;END IF;
 ELSIF op='set_category_override_scoped' THEN
 IF i->'context'->'selector'->>'kind'<>'campus' OR NOT whaleu_ratings.category_icon_override_shape(p->'icon') THEN RETURN false;END IF;
 ELSE IF p ? 'icon' THEN RETURN false;END IF;END IF;
 -- Projection cannot strip any other field, and command slots cannot alias.
 IF op IN ('create_categories_scoped','batch_update_subcategories_scoped') THEN
 IF (p-CASE WHEN op='create_categories_scoped' THEN 'nodes' ELSE 'addNodes' END) IS DISTINCT FROM ((t->'payload')-CASE WHEN op='create_categories_scoped' THEN 'nodes' ELSE 'addNodes' END) THEN RETURN false;END IF;
 ELSIF op IN ('edit_category_base_scoped','create_system_category_scoped','set_category_override_scoped') THEN
 IF p-'icon' IS DISTINCT FROM t->'payload' THEN RETURN false;END IF;
 ELSE IF p IS DISTINCT FROM t->'payload' THEN RETURN false;END IF;END IF;
 refs:=whaleu_ratings.category_icon_replacements(i);
 IF refs IS NULL OR jsonb_array_length(refs)>32 OR EXISTS(SELECT 1 FROM jsonb_array_elements(refs) x GROUP BY x->>'assetId' HAVING count(*)<>1)
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(refs) x GROUP BY x->>'uploadScopeId' HAVING count(*)<>1) THEN RETURN false;END IF;
 RETURN true;EXCEPTION WHEN OTHERS THEN RETURN false;END$$;
CREATE FUNCTION whaleu_ratings.category_icon_intent_hash(i jsonb) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT encode(sha256(convert_to('ratings-category-icon-command:v1:'||whaleu_community.content_canonical_json(i),'UTF8')),'hex')
$$;
CREATE FUNCTION whaleu_ratings.category_icon_upload_scope_request_hash(i jsonb) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT encode(sha256(convert_to('ratings-category-icon-upload-scope:v1:'||whaleu_community.content_canonical_json(i),'UTF8')),'hex')
$$;
DO $$DECLARE definition text;BEGIN
 SELECT pg_get_functiondef('whaleu_ratings.scoped_intent_valid(jsonb)'::regprocedure) INTO definition;
 EXECUTE replace(definition,'FUNCTION whaleu_ratings.scoped_intent_valid(', 'FUNCTION whaleu_ratings.scoped_intent_valid_pre_category_icon(');
 SELECT pg_get_functiondef('whaleu_ratings.scoped_intent_hash(jsonb)'::regprocedure) INTO definition;
 EXECUTE replace(definition,'FUNCTION whaleu_ratings.scoped_intent_hash(', 'FUNCTION whaleu_ratings.scoped_intent_hash_pre_category_icon(');
 SELECT pg_get_functiondef('whaleu_ratings.rating_scoped_operation_rule(text,integer)'::regprocedure) INTO definition;
 EXECUTE replace(definition,'FUNCTION whaleu_ratings.rating_scoped_operation_rule(', 'FUNCTION whaleu_ratings.rating_scoped_operation_rule_pre_category_icon(');
END$$;
CREATE OR REPLACE FUNCTION whaleu_ratings.scoped_intent_valid(i jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE WHEN i->'protocolVersion'='5'::jsonb THEN whaleu_ratings.category_icon_intent_valid(i) ELSE whaleu_ratings.scoped_intent_valid_pre_category_icon(i) END
$$;
CREATE OR REPLACE FUNCTION whaleu_ratings.scoped_intent_hash(i jsonb) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT CASE WHEN i->'protocolVersion'='5'::jsonb THEN whaleu_ratings.category_icon_intent_hash(i) ELSE whaleu_ratings.scoped_intent_hash_pre_category_icon(i) END
$$;
CREATE OR REPLACE FUNCTION whaleu_ratings.rating_scoped_operation_rule(op text,protocol integer) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE WHEN protocol=5 AND whaleu_ratings.category_management_operation(op) THEN jsonb_build_object('domain','category_icon_management','purpose',NULL,'effect',NULL) ELSE whaleu_ratings.rating_scoped_operation_rule_pre_category_icon(op,protocol) END
$$;

CREATE FUNCTION whaleu_ratings.category_icon_capability_current(capability uuid,instant timestamptz) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT coalesce((SELECT c.valid_from<=instant AND c.valid_until>instant AND v.phase='adopted' AND h.version_id=v.id
 AND (v.capability_source_id,v.capability_source_revision)=(c.source_id,c.source_revision)
 AND s.source_kind='scope_capabilities' AND s.digest=c.source_digest AND whaleu_ratings.scoped_source_current(s.id,s.revision,instant)
 AND c.compatibility_digest=whaleu_ratings.category_icon_digest('compatibility',jsonb_build_object('protocolVersion',5,'reviewVersion',8,'mediaVersion',8,'journalVersion',13,'extensionVersion',c.extension_version,'slots',c.slots,'sourceId',s.id,'sourceRevision',s.revision,'sourceDigest',s.digest,'routesDigest',c.routes_digest,'nativeDigest',c.native_digest))
 AND c.adoption_digest=whaleu_ratings.category_icon_digest('adoption',jsonb_build_object('protocolVersionId',v.id,'generation',v.generation,'releaseId',v.release_id,'manifest',v.manifest,'compatibilityDigest',c.compatibility_digest,'coverageDigest',c.coverage_digest))
 FROM whaleu_ratings.category_icon_capability_sources c JOIN whaleu_ratings.scope_protocol_versions v ON v.id=c.protocol_version_id
 JOIN whaleu_ratings.scope_protocol_heads h ON h.logical_scope_key=v.logical_scope_key
 JOIN whaleu_ratings.scoped_source_attestations s ON (s.id,s.revision)=(c.source_id,c.source_revision) WHERE c.id=capability),false)
$$;
CREATE FUNCTION whaleu_ratings.category_icon_snapshot(keys text[]) RETURNS text LANGUAGE sql STABLE AS $$
 SELECT whaleu_ratings.category_icon_digest('snapshot',jsonb_build_object(
 'heads',whaleu_ratings.scoped_head_tuples(keys),
 'roots',(SELECT coalesce(jsonb_agg(jsonb_build_object('head',to_jsonb(h),'definition',to_jsonb(d)) ORDER BY h.root_key COLLATE "C"),'[]'::jsonb)
 FROM whaleu_ratings.category_icon_definition_heads h JOIN whaleu_ratings.category_icon_definitions d ON d.id=h.definition_id
 WHERE h.scope_keys&&keys OR d.category_id IN (SELECT c.category_id FROM whaleu_ratings.scoped_catalog_heads current_head JOIN whaleu_ratings.scoped_categories c ON c.catalog_id=current_head.catalog_id WHERE current_head.scope_key=ANY(keys))),
 'capabilities',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.protocol_version_id),'[]'::jsonb) FROM whaleu_ratings.category_icon_capability_sources a
 JOIN whaleu_ratings.scope_protocol_versions p ON p.id=a.protocol_version_id WHERE p.logical_scope_key=ANY(ARRAY(SELECT DISTINCT coalesce(c.region_id::text,'global') FROM whaleu_ratings.scoped_catalog_heads h JOIN whaleu_ratings.scoped_catalogs c ON c.id=h.catalog_id WHERE h.scope_key=ANY(keys))))))
$$;
DO $$DECLARE definition text;constraint_row record;BEGIN
 SELECT pg_get_functiondef('whaleu_ratings.scoped_context_record_digest(jsonb,jsonb,jsonb)'::regprocedure) INTO definition;
 EXECUTE replace(definition,'FUNCTION whaleu_ratings.scoped_context_record_digest(', 'FUNCTION whaleu_ratings.scoped_context_record_digest_pre_category_icon(');
 SELECT pg_get_functiondef('whaleu_ratings.scoped_context_current(uuid,uuid,uuid,timestamp with time zone)'::regprocedure) INTO definition;
 EXECUTE replace(definition,'FUNCTION whaleu_ratings.scoped_context_current(', 'FUNCTION whaleu_ratings.scoped_context_current_pre_category_icon(');
 FOR constraint_row IN SELECT conname,pg_get_expr(conbin,conrelid) expression FROM pg_constraint WHERE conrelid='whaleu_ratings.scoped_contexts'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%protocolVersion%' LOOP
 EXECUTE format('ALTER TABLE whaleu_ratings.scoped_contexts DROP CONSTRAINT %I',constraint_row.conname);
 EXECUTE format('ALTER TABLE whaleu_ratings.scoped_contexts ADD CONSTRAINT %I CHECK ((context->''protocolVersion''=''5''::jsonb AND context->>''id''=id::text AND context->>''actorId''=account_id::text AND context->>''tokenDigest''=token_digest AND context->>''mediaSnapshot'' ~ ''^[a-f0-9]{64}$'' AND authority->>''contextAuthority''=''ratings-category-icon-context-v1'' AND jsonb_typeof(authority->''categoryIconCapabilities'')=''array'') OR (context->''protocolVersion'' IS DISTINCT FROM ''5''::jsonb AND (%s)))',constraint_row.conname,constraint_row.expression);
 END LOOP;
END$$;
CREATE OR REPLACE FUNCTION whaleu_ratings.scoped_context_record_digest(context_body jsonb,authority_body jsonb,protocol_body jsonb) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT CASE WHEN context_body->'protocolVersion'='5'::jsonb THEN whaleu_ratings.category_icon_digest('context-record',jsonb_build_object('context',context_body,'authority',authority_body,'protocolTuples',protocol_body))
 ELSE whaleu_ratings.scoped_context_record_digest_pre_category_icon(context_body,authority_body,protocol_body) END
$$;
CREATE FUNCTION whaleu_ratings.category_icon_context_current(context_id uuid,instant timestamptz) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT coalesce((SELECT c.context->'protocolVersion'='5'::jsonb AND c.authority->>'contextAuthority'='ratings-category-icon-context-v1'
 AND c.context->'capabilities' ? 'category_icon' AND c.context->>'mediaSnapshot'=whaleu_ratings.category_icon_snapshot(ARRAY(SELECT h->>'scopeKey' FROM jsonb_array_elements(c.context->'heads') h))
 AND jsonb_array_length(c.authority->'categoryIconCapabilities')=jsonb_array_length(c.protocol_tuples)
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(c.protocol_tuples) p LEFT JOIN whaleu_ratings.category_icon_capability_sources a ON a.protocol_version_id=(p->>'versionId')::uuid
 WHERE a.id IS NULL OR NOT whaleu_ratings.category_icon_capability_current(a.id,instant)
 OR NOT c.authority->'categoryIconCapabilities' @> jsonb_build_array(jsonb_build_object('id',a.id,'protocolVersionId',a.protocol_version_id,'sourceDigest',a.source_digest,'current',true,'validUntil',to_char(a.valid_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))))
 FROM whaleu_ratings.scoped_contexts c WHERE c.id=context_id),false)
$$;
CREATE OR REPLACE FUNCTION whaleu_ratings.scoped_context_current(context_id uuid,actor uuid,session uuid,instant timestamptz) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT whaleu_ratings.scoped_context_current_pre_category_icon(context_id,actor,session,instant) AND
 CASE WHEN (SELECT context->'protocolVersion' FROM whaleu_ratings.scoped_contexts WHERE id=context_id)='5'::jsonb THEN whaleu_ratings.category_icon_context_current(context_id,instant) ELSE true END
$$;
