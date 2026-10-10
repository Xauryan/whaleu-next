-- Exact category request family. The prepared plan is checked against immutable
-- before facts, fresh all-of authority, exact sources and a same-transaction cause.
SET LOCAL lock_timeout='5s';
CREATE FUNCTION whaleu_ratings.category_management_artifact(hash text,kind text) RETURNS uuid LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE b bytea;h text;BEGIN b:=substring(sha256(convert_to('whaleu:rating-scoped-artifact:v1'||chr(10)||hash||chr(10)||kind,'UTF8')) FROM 1 FOR 16);b:=set_byte(b,6,(get_byte(b,6)&15)|64);b:=set_byte(b,8,(get_byte(b,8)&63)|128);h:=encode(b,'hex');RETURN (substring(h,1,8)||'-'||substring(h,9,4)||'-'||substring(h,13,4)||'-'||substring(h,17,4)||'-'||substring(h,21))::uuid;END $$;
CREATE FUNCTION whaleu_ratings.category_management_heads(keys text[]) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('scopeKey',scope_key,'catalogRevision',catalog_id,'headRevision',head_revision) ORDER BY scope_key COLLATE "C"),'[]'::jsonb) FROM whaleu_ratings.scoped_catalog_heads WHERE scope_key=ANY(keys)
$$;
CREATE FUNCTION whaleu_ratings.category_management_compat_heads(keys text[]) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('compatKey',h.compat_key,'versionId',v.id,'legacyCatalogId',legacy.catalog_id,'scopeKeys',whaleu_ratings.scoped_compat_scope_keys(v)) ORDER BY h.compat_key COLLATE "C"),'[]'::jsonb)
 FROM whaleu_ratings.compat_heads h JOIN whaleu_ratings.compat_versions v ON v.id=h.version_id LEFT JOIN whaleu_ratings.catalog_heads legacy ON legacy.scope_key=coalesce(v.region_id::text,'global') WHERE whaleu_ratings.scoped_compat_scope_keys(v)&&keys
$$;
CREATE FUNCTION whaleu_ratings.category_management_before_category(p whaleu_ratings.scoped_command_preparations,category uuid,scope text) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT l.proof FROM jsonb_array_elements(p.category_plan->'beforeHeads') head JOIN whaleu_ratings.scoped_category_lineage l ON l.catalog_id=(head->>'catalogRevision')::uuid WHERE head->>'scopeKey'=scope AND l.category_id=category
$$;
CREATE FUNCTION whaleu_ratings.category_management_actor_current(
  actor uuid, instant timestamptz
) RETURNS boolean LANGUAGE sql STABLE AS $$
WITH whitespace AS (
  -- ECMAScript String.trim white space and line terminators, used by the
  -- Verification owner policy. Plain btrim would accept tab-only references.
  SELECT U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF' AS chars
)
SELECT coalesce(
  actor IS NOT NULL AND instant IS NOT NULL AND isfinite(instant)
  AND EXISTS (
    SELECT 1 FROM whaleu_identity.accounts account
    WHERE account.id=actor AND account.status='active'
  )
  AND EXISTS (
    SELECT 1
    FROM whaleu_verification.account_heads head
    JOIN whaleu_verification.snapshots snapshot
      ON (snapshot.id,snapshot.account_id,snapshot.revision)
       = (head.snapshot_id,head.account_id,head.revision)
    JOIN whaleu_verification.assertions assertion
      ON assertion.id=snapshot.phone_assertion_id
     AND assertion.account_id=head.account_id
     AND assertion.fact_kind='phone'
    CROSS JOIN whitespace
    WHERE head.account_id=actor
      AND assertion.assertion_state='verified'
      AND assertion.coverage_state='complete'
      AND assertion.provenance_state='accepted'
      AND assertion.source_account_id=actor
      AND length(btrim(assertion.source_reference,whitespace.chars))>0
      AND length(btrim(assertion.policy_reference,whitespace.chars))>0
      AND assertion.method IN ('phone_provider','reconciled_import')
      -- Phone facts have no institution/origin; this also explicitly enforces
      -- the owner's issuer equality and the existing phone-table invariant.
      AND assertion.issuer_institution_id IS NULL
      AND assertion.source_issuer_institution_id IS NULL
      AND assertion.origin_region_id IS NULL
      AND assertion.phone_binding_reference IS NOT NULL
      AND assertion.verified_at IS NOT NULL
      AND isfinite(assertion.verified_at)
      AND assertion.verified_at<=instant
      AND (
        (assertion.expiry_kind='policy_exempt' AND assertion.expires_at IS NULL)
        OR (assertion.expiry_kind='at'
          AND assertion.expires_at IS NOT NULL
          AND isfinite(assertion.expires_at)
          AND assertion.expires_at>assertion.verified_at
          AND assertion.expires_at>instant)
      )
  )
  AND EXISTS (
    SELECT 1 FROM whaleu_safety.account_heads safety
    WHERE safety.account_id=actor
      AND safety.block_coverage='complete'
      AND safety.restriction_coverage='complete'
      -- This is the only known positive value in the real Safety schema.
      -- There is no Safety 'accepted' provenance value or source_reference.
      AND safety.provenance='native_account_creation'
      AND safety.actions_allowed IS TRUE
      AND (safety.valid_until IS NULL
        OR (isfinite(safety.valid_until) AND safety.valid_until>instant))
  ),false);
$$;

CREATE FUNCTION whaleu_ratings.category_management_current_authority(p whaleu_ratings.scoped_command_preparations) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT coalesce((SELECT whaleu_authorization.rating_category_management_authority_covers(p.account_id,ARRAY(SELECT substring(value from 8)::uuid FROM jsonb_array_elements_text(p.category_plan->'affectedScopeKeys') WHERE value<>'global'),(p.category_plan->>'globalRequired')::boolean)
 AND whaleu_ratings.target_edit_session_current(p.account_id,p.session_id,clock_timestamp())
 AND whaleu_ratings.category_management_actor_current(p.account_id,clock_timestamp())
 AND whaleu_ratings.category_topology_regions((c.authority->>'topologySnapshotId')::uuid,NULL) IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(c.protocol_tuples) v LEFT JOIN whaleu_ratings.scope_protocol_heads h ON h.logical_scope_key=v->>'scopeKey' LEFT JOIN whaleu_ratings.scope_protocol_versions current ON current.id=h.version_id WHERE current.id IS NULL OR current.phase<>'adopted' OR current.id::text<>v->>'versionId' OR current.generation::text<>v->>'generation')
 FROM whaleu_ratings.scoped_contexts c WHERE c.id=p.context_id),false)
$$;
CREATE FUNCTION whaleu_ratings.category_historical_metadata(source uuid,revision uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN s.source_kind='scoped_category_base' THEN jsonb_build_object('active',s.payload->'active','hidden',s.payload->'hidden','ordinal',s.payload->'ordinal','originKind',s.payload->'originKind')
 ELSE (SELECT jsonb_build_object('active',c.active,'hidden',c.hidden,'ordinal',c.ordinal::text,'originKind',c.origin_kind) FROM whaleu_ratings.categories c WHERE c.id=coalesce(s.payload->>'categoryId',ai.legacy_business_id::text)::uuid AND c.catalog_id=coalesce(s.payload->>'legacyCatalogId',s.payload->>'legacyAfterCatalogId',am.legacy_catalog_id::text)::uuid) END
 FROM whaleu_ratings.scoped_source_attestations s LEFT JOIN whaleu_ratings.scoped_adoption_identities ai ON s.source_kind='legacy_adoption' AND ai.id=(s.payload->>'identityId')::uuid LEFT JOIN whaleu_ratings.legacy_adoption_manifests am ON am.id=ai.manifest_id WHERE s.id=source AND s.revision=category_historical_metadata.revision
$$;
CREATE FUNCTION whaleu_ratings.category_management_complete_before(p whaleu_ratings.scoped_command_preparations) RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
DECLARE plan jsonb:=p.category_plan;v jsonb:=p.intent->'payload';op text:=p.operation;selected text;all_keys text[];wanted uuid[];row record;desired text[];ids jsonb;ordered jsonb;source_row whaleu_ratings.scoped_source_attestations;
BEGIN
 selected:=CASE WHEN p.intent->'context'->'selector'->>'kind'='global' THEN 'global' ELSE 'campus:'||(p.intent->'context'->'selector'->>'campusId') END;
 all_keys:=ARRAY(SELECT jsonb_array_elements_text(plan->'affectedScopeKeys'));
 wanted:=CASE WHEN op IN ('edit_category_base_scoped','set_category_lifecycle_scoped','set_category_scope_scoped') THEN ARRAY[(v->>'categoryId')::uuid] WHEN op='batch_update_subcategories_scoped' THEN ARRAY(SELECT value::uuid FROM jsonb_array_elements_text((v->'disableIds')||(v->'restoreIds')||(v->'enableIds'))) ELSE ARRAY[]::uuid[] END;
 IF op='set_category_scope_scoped' AND v->>'propagation'='subtree' THEN
 WITH RECURSIVE nodes AS(SELECT DISTINCT l.category_id,l.proof->'body'->>'parentId' parent_id FROM whaleu_ratings.scoped_catalog_heads h JOIN whaleu_ratings.scoped_category_lineage l ON l.catalog_id=h.catalog_id),tree AS(SELECT * FROM nodes WHERE category_id=(v->>'categoryId')::uuid UNION SELECT n.* FROM nodes n JOIN tree t ON n.parent_id=t.category_id::text) SELECT array_agg(category_id) INTO wanted FROM tree;END IF;
 -- All-of is computed from actual current placement/metadata, never declared scopes.
 FOR row IN SELECT DISTINCT unnest(placement.scope_keys) scope_key FROM whaleu_ratings.category_scope_placements placement WHERE placement.category_id=ANY(wanted) AND whaleu_ratings.scoped_source_current(placement.source_id,placement.source_revision,clock_timestamp())
 UNION SELECT DISTINCT unnest(s.scope_keys) FROM whaleu_ratings.scoped_source_heads h JOIN whaleu_ratings.scoped_source_attestations s ON (s.id,s.revision)=(h.source_id,h.source_revision) WHERE s.source_kind IN ('scoped_category_override','scoped_category_lifecycle','scoped_category_order') AND coalesce(s.payload->>'categoryId',s.payload->'reviewEnvelope'->>'categoryId')::uuid=ANY(wanted) LOOP
 IF NOT row.scope_key=ANY(all_keys) THEN RETURN false;END IF;END LOOP;
 IF op='edit_category_base_scoped' AND plan->'noop'<>'true'::jsonb THEN
 FOR row IN SELECT DISTINCT placement.base_source_id,placement.base_source_revision FROM whaleu_ratings.category_scope_placements placement WHERE placement.category_id=(v->>'categoryId')::uuid AND whaleu_ratings.scoped_source_current(placement.source_id,placement.source_revision,clock_timestamp()) LOOP
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(plan->'sourceIssues') item WHERE item->>'kind'='scoped_category_base' AND item->'payload'->>'previousBaseSourceId'=row.base_source_id::text AND item->'payload'->>'previousBaseSourceRevision'=row.base_source_revision::text) THEN RETURN false;END IF;END LOOP;
 END IF;
 IF op IN ('set_category_lifecycle_scoped','batch_update_subcategories_scoped') THEN
 FOR row IN SELECT h.scope_key,l.category_id,l.proof FROM whaleu_ratings.scoped_catalog_heads h JOIN whaleu_ratings.scoped_category_lineage l ON l.catalog_id=h.catalog_id WHERE l.category_id=ANY(wanted) LOOP
 SELECT * INTO source_row FROM whaleu_ratings.scoped_source_attestations WHERE id=(row.proof->>'lifecycleSourceId')::uuid AND revision=(row.proof->>'lifecycleSourceRevision')::uuid;
 IF coalesce(source_row.payload->>'businessState',CASE WHEN row.proof->'body'->'active'='true'::jsonb THEN 'enabled' ELSE 'disabled' END) IS DISTINCT FROM (CASE WHEN op='set_category_lifecycle_scoped' THEN v->>'state' WHEN v->'enableIds' @> to_jsonb(ARRAY[row.category_id]) THEN 'enabled' ELSE 'disabled' END)
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(plan->'sourceIssues') item WHERE item->>'kind'='scoped_category_lifecycle' AND item->'payload'->>'categoryId'=row.category_id::text AND item->'scopeKeys' @> to_jsonb(ARRAY[row.scope_key])) THEN RETURN false;END IF;
 END LOOP;
 END IF;
 IF op='batch_update_subcategories_scoped' THEN
 IF (SELECT count(*)<>count(DISTINCT value) FROM jsonb_array_elements_text((v->'disableIds')||(v->'restoreIds')||(v->'enableIds'))) OR (whaleu_ratings.category_management_before_category(p,(v->>'parentId')::uuid,selected)->'body'->'active') IS DISTINCT FROM 'true'::jsonb THEN RETURN false;END IF;
 FOR row IN SELECT unnest(wanted) id LOOP
 IF (whaleu_ratings.category_management_before_category(p,row.id,selected)->'body'->'parentId') IS DISTINCT FROM v->'parentId' THEN RETURN false;END IF;END LOOP;
 END IF;
 IF op='set_category_scope_scoped' THEN
 desired:=CASE WHEN v->'placement'->>'kind'='global' THEN ARRAY['global'] ELSE ARRAY(SELECT 'campus:'||value FROM jsonb_array_elements_text(v->'placement'->'campusIds') ORDER BY value) END;
 FOR row IN WITH RECURSIVE all_nodes AS (SELECT DISTINCT l.category_id,l.proof->'body'->>'parentId' parent_id FROM whaleu_ratings.scoped_catalog_heads h JOIN whaleu_ratings.scoped_category_lineage l ON l.catalog_id=h.catalog_id), tree AS(SELECT * FROM all_nodes WHERE category_id=(v->>'categoryId')::uuid UNION SELECT node.* FROM all_nodes node JOIN tree parent ON node.parent_id=parent.category_id::text WHERE v->>'propagation'='subtree') SELECT category_id FROM tree LOOP
 IF ARRAY(SELECT DISTINCT unnest(placement.scope_keys) COLLATE "C" k FROM whaleu_ratings.category_scope_placements placement WHERE placement.category_id=row.category_id AND whaleu_ratings.scoped_source_current(placement.source_id,placement.source_revision,clock_timestamp()) ORDER BY k)<>desired
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(plan->'sourceIssues') item WHERE item->>'kind'='scoped_category_scope' AND item->'payload'->>'categoryId'=row.category_id::text AND item->'scopeKeys'=to_jsonb(desired) AND item ? 'placement') THEN RETURN false;END IF;
 END LOOP;
 END IF;
 IF op IN ('reorder_categories_scoped','batch_update_subcategories_scoped') THEN
 ordered:=CASE WHEN op='batch_update_subcategories_scoped' THEN (SELECT coalesce(jsonb_agg(CASE WHEN item->>'kind'='existing' THEN item->>'id' ELSE whaleu_ratings.category_management_artifact(p.intent_hash,'category:'||(item->>'key'))::text END ORDER BY n),'[]'::jsonb) FROM jsonb_array_elements(v->'orderedChildren') WITH ORDINALITY a(item,n)) ELSE CASE WHEN v->>'action'='set' THEN v->'orderedIds' ELSE (SELECT coalesce(jsonb_agg(l.category_id ORDER BY (whaleu_ratings.category_historical_metadata(l.base_source_id,l.base_source_revision)->>'ordinal')::bigint),'[]'::jsonb) FROM whaleu_ratings.scoped_catalog_heads h JOIN whaleu_ratings.scoped_category_lineage l ON l.catalog_id=h.catalog_id WHERE h.scope_key=selected AND l.proof->'body'->'parentId' IS NOT DISTINCT FROM v->'parentId') END END;
 SELECT coalesce(jsonb_agg(l.category_id ORDER BY (l.proof->'body'->>'ordinal')::bigint),'[]'::jsonb) INTO ids FROM whaleu_ratings.scoped_catalog_heads h JOIN whaleu_ratings.scoped_category_lineage l ON l.catalog_id=h.catalog_id WHERE h.scope_key=selected AND l.proof->'body'->'parentId' IS NOT DISTINCT FROM v->'parentId';
 FOR row IN SELECT value id,n FROM jsonb_array_elements_text(ordered) WITH ORDINALITY a(value,n) LOOP
 IF ids->>(row.n-1)::integer<>row.id AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(plan->'sourceIssues') item WHERE item->>'kind'='scoped_category_order' AND item->'payload'->>'categoryId'=row.id AND item->'payload'->'siblingIds'=ordered) THEN RETURN false;END IF;
 END LOOP;
 END IF;
 RETURN true;
END $$;

CREATE FUNCTION whaleu_ratings.category_management_noop_scopes(p whaleu_ratings.scoped_command_preparations) RETURNS text[] LANGUAGE plpgsql STABLE AS $$
DECLARE v jsonb:=p.intent->'payload';selected text;wanted uuid[];result text[];
BEGIN
 selected:=CASE WHEN p.intent->'context'->'selector'->>'kind'='global' THEN 'global' ELSE 'campus:'||(p.intent->'context'->'selector'->>'campusId') END;
 wanted:=CASE WHEN p.operation IN ('edit_category_base_scoped','set_category_lifecycle_scoped','set_category_scope_scoped') THEN ARRAY[(v->>'categoryId')::uuid] WHEN p.operation='batch_update_subcategories_scoped' THEN ARRAY(SELECT value::uuid FROM jsonb_array_elements_text((v->'disableIds')||(v->'restoreIds')||(v->'enableIds'))) ELSE ARRAY[]::uuid[] END;
 IF p.operation='set_category_scope_scoped' AND v->>'propagation'='subtree' THEN
 WITH RECURSIVE nodes AS(SELECT DISTINCT l.category_id,l.proof->'body'->>'parentId' parent_id FROM whaleu_ratings.scoped_catalog_heads h JOIN whaleu_ratings.scoped_category_lineage l ON l.catalog_id=h.catalog_id),tree AS(SELECT * FROM nodes WHERE category_id=(v->>'categoryId')::uuid UNION SELECT n.* FROM nodes n JOIN tree t ON n.parent_id=t.category_id::text) SELECT array_agg(category_id) INTO wanted FROM tree;
 END IF;
 SELECT ARRAY(SELECT DISTINCT key COLLATE "C" FROM (SELECT selected key UNION ALL SELECT unnest(placement.scope_keys) FROM whaleu_ratings.category_scope_placements placement WHERE placement.category_id=ANY(wanted) AND whaleu_ratings.scoped_source_current(placement.source_id,placement.source_revision,clock_timestamp()) UNION ALL SELECT unnest(s.scope_keys) FROM whaleu_ratings.scoped_source_heads h JOIN whaleu_ratings.scoped_source_attestations s ON (s.id,s.revision)=(h.source_id,h.source_revision) WHERE s.source_kind IN ('scoped_category_override','scoped_category_lifecycle','scoped_category_order') AND coalesce(s.payload->>'categoryId',s.payload->'reviewEnvelope'->>'categoryId')::uuid=ANY(wanted)) all_keys ORDER BY 1) INTO result;
 RETURN result;
END $$;
CREATE FUNCTION whaleu_ratings.category_management_desired_before(p whaleu_ratings.scoped_command_preparations) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE v jsonb:=p.intent->'payload';op text:=p.operation;selected text;before jsonb;body jsonb;source_row whaleu_ratings.scoped_source_attestations;row record;desired jsonb;actual jsonb;wanted text[];state text;
BEGIN
 selected:=CASE WHEN p.intent->'context'->'selector'->>'kind'='global' THEN 'global' ELSE 'campus:'||(p.intent->'context'->'selector'->>'campusId') END;
 IF op IN ('create_categories_scoped','create_system_category_scoped') THEN RETURN false;END IF;
 IF op IN ('edit_category_base_scoped','set_category_override_scoped','set_category_visibility_scoped','set_category_lifecycle_scoped','set_category_scope_scoped') THEN
 before:=whaleu_ratings.category_management_before_category(p,(v->>'categoryId')::uuid,selected);body:=before->'body';IF before IS NULL THEN RETURN false;END IF;END IF;
 IF op='edit_category_base_scoped' THEN
 FOR row IN SELECT DISTINCT base_source_id,base_source_revision FROM jsonb_array_elements(p.category_plan->'beforeVector') vector JOIN whaleu_ratings.category_scope_placements placement ON (placement.source_id,placement.source_revision)=((vector->>'id')::uuid,(vector->>'revision')::uuid) WHERE placement.category_id=(v->>'categoryId')::uuid LOOP
 IF NOT p.category_plan->'beforeBaseAvailability' @> jsonb_build_array(jsonb_build_object('sourceId',row.base_source_id,'sourceRevision',row.base_source_revision,'current',true)) THEN RETURN false;END IF;
 body:=whaleu_ratings.category_historical_body(row.base_source_id,row.base_source_revision);
 IF body IS NULL OR body->'name' IS DISTINCT FROM v->'name' OR body->'description' IS DISTINCT FROM v->'description' THEN RETURN false;END IF;END LOOP;RETURN true;
 ELSIF op='set_category_override_scoped' THEN
 SELECT * INTO source_row FROM whaleu_ratings.scoped_source_attestations WHERE id=(before->>'overrideSourceId')::uuid AND revision=(before->>'overrideSourceRevision')::uuid;
 RETURN coalesce(coalesce(source_row.payload->'modes',CASE WHEN source_row.id IS NULL THEN jsonb_build_object('name',jsonb_build_object('mode','inherit'),'description',jsonb_build_object('mode','inherit')) ELSE jsonb_build_object('name',jsonb_build_object('mode','set','value',body->'name'),'description',jsonb_build_object('mode','set','value',body->'description')) END)=jsonb_build_object('name',v->'name','description',v->'description'),false);
 ELSIF op='set_category_visibility_scoped' THEN RETURN coalesce(body->'hidden'=v->'hidden',false);
 ELSIF op='set_category_lifecycle_scoped' THEN
 IF v->'restore'<>'false'::jsonb THEN RETURN false;END IF;
 FOR row IN SELECT (h->>'scopeKey') scope_key,l.proof FROM jsonb_array_elements(p.category_plan->'beforeHeads') h JOIN whaleu_ratings.scoped_category_lineage l ON l.catalog_id=(h->>'catalogRevision')::uuid WHERE l.category_id=(v->>'categoryId')::uuid LOOP
 SELECT * INTO source_row FROM whaleu_ratings.scoped_source_attestations WHERE id=(row.proof->>'lifecycleSourceId')::uuid AND revision=(row.proof->>'lifecycleSourceRevision')::uuid;
 state:=coalesce(source_row.payload->>'businessState',CASE WHEN row.proof->'body'->'active'='true'::jsonb THEN 'enabled' ELSE 'disabled' END);
 IF state IS DISTINCT FROM v->>'state' THEN RETURN false;END IF;END LOOP;
 FOR row IN SELECT s.payload FROM jsonb_array_elements(p.category_plan->'beforeVector') b JOIN whaleu_ratings.scoped_source_attestations s ON (s.id,s.revision)=((b->>'id')::uuid,(b->>'revision')::uuid) WHERE s.source_kind='scoped_category_lifecycle' AND s.payload->'categoryId'=v->'categoryId' LOOP
 IF coalesce(row.payload->>'businessState',CASE WHEN row.payload->'active'='true'::jsonb THEN 'enabled' ELSE 'disabled' END) IS DISTINCT FROM v->>'state' THEN RETURN false;END IF;END LOOP;RETURN true;
 ELSIF op='set_category_scope_scoped' THEN
 wanted:=CASE WHEN v->'placement'->>'kind'='global' THEN ARRAY['global'] ELSE ARRAY(SELECT 'campus:'||value FROM jsonb_array_elements_text(v->'placement'->'campusIds') ORDER BY value) END;
 FOR row IN WITH RECURSIVE nodes AS(SELECT DISTINCT l.category_id,l.proof->'body'->>'parentId' parent_id FROM jsonb_array_elements(p.category_plan->'beforeHeads') h JOIN whaleu_ratings.scoped_category_lineage l ON l.catalog_id=(h->>'catalogRevision')::uuid),tree AS(SELECT * FROM nodes WHERE category_id=(v->>'categoryId')::uuid UNION SELECT n.* FROM nodes n JOIN tree t ON n.parent_id=t.category_id::text WHERE v->>'propagation'='subtree') SELECT category_id FROM tree LOOP
 IF wanted IS DISTINCT FROM ARRAY(SELECT DISTINCT unnest(placement.scope_keys) COLLATE "C" key FROM jsonb_array_elements(p.category_plan->'beforeVector') vector JOIN whaleu_ratings.category_scope_placements placement ON (placement.source_id,placement.source_revision)=((vector->>'id')::uuid,(vector->>'revision')::uuid) WHERE placement.category_id=row.category_id ORDER BY 1) THEN RETURN false;END IF;
 END LOOP;RETURN true;
 ELSIF op='batch_update_subcategories_scoped' THEN
 IF v->'addNodes'<>'[]'::jsonb OR v->'restoreIds'<>'[]'::jsonb THEN RETURN false;END IF;
 FOR row IN SELECT id,expected FROM (SELECT value::uuid id,'disabled' expected FROM jsonb_array_elements_text(v->'disableIds') UNION ALL SELECT value::uuid,'enabled' FROM jsonb_array_elements_text(v->'enableIds')) wanted_states LOOP
 FOR source_row IN SELECT s.* FROM jsonb_array_elements(p.category_plan->'beforeHeads') h JOIN whaleu_ratings.scoped_category_lineage l ON l.catalog_id=(h->>'catalogRevision')::uuid LEFT JOIN whaleu_ratings.scoped_source_attestations s ON s.id=(l.proof->>'lifecycleSourceId')::uuid AND s.revision=(l.proof->>'lifecycleSourceRevision')::uuid WHERE l.category_id=row.id LOOP
 IF source_row.id IS NOT NULL AND coalesce(source_row.payload->>'businessState',CASE WHEN source_row.payload->'active'='true'::jsonb THEN 'enabled' ELSE 'disabled' END) IS DISTINCT FROM row.expected THEN RETURN false;END IF;END LOOP;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p.category_plan->'beforeHeads') h JOIN whaleu_ratings.scoped_category_lineage l ON l.catalog_id=(h->>'catalogRevision')::uuid WHERE l.category_id=row.id AND l.proof->>'lifecycleSourceId' IS NULL AND (CASE WHEN l.proof->'body'->'active'='true'::jsonb THEN 'enabled' ELSE 'disabled' END)<>row.expected) THEN RETURN false;END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p.category_plan->'beforeVector') b JOIN whaleu_ratings.scoped_source_attestations old_life ON (old_life.id,old_life.revision)=((b->>'id')::uuid,(b->>'revision')::uuid) WHERE old_life.source_kind='scoped_category_lifecycle' AND old_life.payload->>'categoryId'=row.id::text AND coalesce(old_life.payload->>'businessState',CASE WHEN old_life.payload->'active'='true'::jsonb THEN 'enabled' ELSE 'disabled' END) IS DISTINCT FROM row.expected) THEN RETURN false;END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(v->'orderedChildren') item WHERE item->>'kind'<>'existing') THEN RETURN false;END IF;
 desired:=(SELECT coalesce(jsonb_agg(item->'id' ORDER BY n),'[]'::jsonb) FROM jsonb_array_elements(v->'orderedChildren') WITH ORDINALITY a(item,n));
 ELSIF op='reorder_categories_scoped' THEN
 IF v->>'action'='set' THEN desired:=v->'orderedIds';ELSE
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p.category_plan->'beforeHeads') h JOIN whaleu_ratings.scoped_category_lineage l ON l.catalog_id=(h->>'catalogRevision')::uuid JOIN whaleu_ratings.scoped_source_attestations s ON s.id=(l.proof->>'orderSourceId')::uuid AND s.revision=(l.proof->>'orderSourceRevision')::uuid WHERE (h->>'scopeKey')=selected AND l.proof->'body'->'parentId' IS NOT DISTINCT FROM v->'parentId' AND s.payload->>'action' IS DISTINCT FROM 'inherit') THEN RETURN false;END IF;
 SELECT coalesce(jsonb_agg(l.category_id ORDER BY (whaleu_ratings.category_historical_metadata(l.base_source_id,l.base_source_revision)->>'ordinal')::bigint),'[]'::jsonb) INTO desired FROM jsonb_array_elements(p.category_plan->'beforeHeads') h JOIN whaleu_ratings.scoped_category_lineage l ON l.catalog_id=(h->>'catalogRevision')::uuid WHERE (h->>'scopeKey')=selected AND l.proof->'body'->'parentId' IS NOT DISTINCT FROM v->'parentId';
 END IF;
 ELSE RETURN false;END IF;
 SELECT coalesce(jsonb_agg(l.category_id ORDER BY (l.proof->'body'->>'ordinal')::bigint),'[]'::jsonb) INTO actual FROM jsonb_array_elements(p.category_plan->'beforeHeads') h JOIN whaleu_ratings.scoped_category_lineage l ON l.catalog_id=(h->>'catalogRevision')::uuid WHERE (h->>'scopeKey')=selected AND l.proof->'body'->'parentId' IS NOT DISTINCT FROM v->'parentId';
 RETURN coalesce(actual=desired,false);
EXCEPTION WHEN OTHERS THEN RETURN false;END $$;

CREATE FUNCTION whaleu_ratings.category_management_scope_bases(p whaleu_ratings.scoped_command_preparations,category uuid) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE row record;canonical jsonb;metadata jsonb;state text;first_body jsonb;first_metadata jsonb;first_state text;next_base jsonb;dep record;multiple boolean;
BEGIN
 SELECT count(DISTINCT (l.base_source_id,l.base_source_revision))>1 INTO multiple FROM jsonb_array_elements(p.category_plan->'beforeHeads') h JOIN whaleu_ratings.scoped_category_lineage l ON l.catalog_id=(h->>'catalogRevision')::uuid WHERE l.category_id=category;
 FOR row IN SELECT l.* FROM jsonb_array_elements(p.category_plan->'beforeHeads') h JOIN whaleu_ratings.scoped_category_lineage l ON l.catalog_id=(h->>'catalogRevision')::uuid WHERE l.category_id=category LOOP
 canonical:=whaleu_ratings.category_historical_body(row.base_source_id,row.base_source_revision);metadata:=whaleu_ratings.category_historical_metadata(row.base_source_id,row.base_source_revision)-'originKind';
 SELECT coalesce(s.payload->>'businessState',CASE WHEN row.proof->'body'->'active'='true'::jsonb THEN 'enabled' ELSE 'disabled' END) INTO state FROM (SELECT 1) x LEFT JOIN whaleu_ratings.scoped_source_attestations s ON s.id=(row.proof->>'lifecycleSourceId')::uuid;
 IF first_body IS NULL THEN first_body:=canonical;first_metadata:=metadata;first_state:=state;
 ELSIF canonical IS DISTINCT FROM first_body OR metadata IS DISTINCT FROM first_metadata OR (multiple AND state IS DISTINCT FROM first_state) THEN RETURN false;END IF;
 END LOOP;
 IF first_body IS NULL THEN RETURN false;END IF;
 SELECT i INTO next_base FROM jsonb_array_elements(p.category_plan->'sourceIssues') i WHERE i->>'kind'='scoped_category_base' AND i->'payload'->>'categoryId'=category::text;
 IF next_base IS NULL THEN RETURN false;END IF;
 FOR dep IN SELECT s.* FROM jsonb_array_elements(p.category_plan->'beforeVector') b JOIN whaleu_ratings.scoped_source_attestations s ON (s.id,s.revision)=((b->>'id')::uuid,(b->>'revision')::uuid) WHERE s.source_kind IN ('scoped_category_scope','scoped_category_override','scoped_category_lifecycle','scoped_category_order') AND coalesce(s.payload->>'categoryId',s.payload->'reviewEnvelope'->>'categoryId')=category::text LOOP
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p.category_plan->'sourceIssues') i WHERE i->>'previousSourceId'=dep.id::text AND i->>'previousSourceRevision'=dep.revision::text AND i->'payload'->>'baseSourceId'=next_base->>'id' AND i->'payload'->>'baseSourceRevision'=next_base->>'revision') THEN RETURN false;END IF;
 END LOOP;
 RETURN true;
END $$;

CREATE FUNCTION whaleu_ratings.category_management_required_delta(p whaleu_ratings.scoped_command_preparations) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE plan jsonb:=p.category_plan;v jsonb:=p.intent->'payload';op text:=p.operation;selected text;node jsonb;row record;ids jsonb;actual jsonb;wanted uuid[];before jsonb;ordered jsonb;slots jsonb;desired_state text;old_state text;old_source whaleu_ratings.scoped_source_attestations;desired_scopes text[];old_scopes text[];
BEGIN
 selected:=CASE WHEN p.intent->'context'->'selector'->>'kind'='global' THEN 'global' ELSE 'campus:'||(p.intent->'context'->'selector'->>'campusId') END;
 IF plan->'noop'='true'::jsonb THEN RETURN whaleu_ratings.category_management_desired_before(p);END IF;
 IF whaleu_ratings.category_management_desired_before(p) THEN RETURN false;END IF;
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(plan->'sourceIssues') i WHERE i->>'kind'<>'scope_absence') THEN RETURN false;END IF;
 -- New identities are an exact bijection with all user node keys. A partial tree
 -- or an auxiliary coverage successor cannot fulfill a create/batch intent.
 ids:=CASE WHEN op='create_system_category_scoped' THEN to_jsonb(ARRAY[whaleu_ratings.category_management_artifact(p.intent_hash,'category:root')]) WHEN op IN ('create_categories_scoped','batch_update_subcategories_scoped') THEN (SELECT coalesce(jsonb_agg(whaleu_ratings.category_management_artifact(p.intent_hash,'category:'||(n->>'key')) ORDER BY whaleu_ratings.category_management_artifact(p.intent_hash,'category:'||(n->>'key'))),'[]'::jsonb) FROM jsonb_array_elements(CASE WHEN op='create_categories_scoped' THEN v->'nodes' ELSE v->'addNodes' END) n) ELSE '[]'::jsonb END;
 SELECT coalesce(jsonb_agg((i->'payload'->>'categoryId')::uuid ORDER BY (i->'payload'->>'categoryId')::uuid),'[]'::jsonb) INTO actual FROM jsonb_array_elements(plan->'sourceIssues') i WHERE i->>'kind'='scoped_category_base' AND i->'payload'->>'previousBaseSourceId' IS NULL;
 IF actual IS DISTINCT FROM ids THEN RETURN false;END IF;
 FOR node IN SELECT i FROM jsonb_array_elements(plan->'sourceIssues') i WHERE i->>'kind'='scoped_category_base' LOOP
 IF (SELECT count(*) FROM jsonb_array_elements(plan->'sourceIssues') scope WHERE scope->>'kind'='scoped_category_scope' AND scope ? 'placement' AND scope->'payload'->'categoryId'=node->'payload'->'categoryId' AND scope->'payload'->>'baseSourceId'=node->>'id' AND scope->'payload'->>'baseSourceRevision'=node->>'revision')<1 THEN RETURN false;END IF;
 END LOOP;
 IF op='edit_category_base_scoped' THEN
 FOR row IN SELECT DISTINCT l.base_source_id,l.base_source_revision FROM jsonb_array_elements(plan->'beforeHeads') h JOIN whaleu_ratings.scoped_category_lineage l ON l.catalog_id=(h->>'catalogRevision')::uuid WHERE l.category_id=(v->>'categoryId')::uuid LOOP
 IF (SELECT count(*) FROM jsonb_array_elements(plan->'sourceIssues') i WHERE i->>'kind'='scoped_category_base' AND i->'payload'->>'previousBaseSourceId'=row.base_source_id::text AND i->'payload'->>'previousBaseSourceRevision'=row.base_source_revision::text)<>1 THEN RETURN false;END IF;END LOOP;
 ELSIF op='set_category_override_scoped' THEN
 IF (SELECT count(*) FROM jsonb_array_elements(plan->'sourceIssues') i WHERE i->>'kind'='scoped_category_override' AND i->'payload'->>'categoryId'=v->>'categoryId' AND i->'scopeKeys'=to_jsonb(ARRAY[selected]))<>1 THEN RETURN false;END IF;
 ELSIF op='set_category_visibility_scoped' THEN
 IF (SELECT count(*) FROM jsonb_array_elements(plan->'sourceIssues') i WHERE i->>'kind'='scoped_category_lifecycle' AND i->'payload'->>'categoryId'=v->>'categoryId' AND i->'scopeKeys'=to_jsonb(ARRAY[selected]))<>1 THEN RETURN false;END IF;
 ELSIF op='set_category_scope_scoped' THEN
 desired_scopes:=CASE WHEN v->'placement'->>'kind'='global' THEN ARRAY['global'] ELSE ARRAY(SELECT 'campus:'||value FROM jsonb_array_elements_text(v->'placement'->'campusIds') ORDER BY value) END;
 FOR row IN WITH RECURSIVE nodes AS(SELECT DISTINCT l.category_id,l.proof->'body'->>'parentId' parent_id FROM jsonb_array_elements(plan->'beforeHeads') h JOIN whaleu_ratings.scoped_category_lineage l ON l.catalog_id=(h->>'catalogRevision')::uuid),tree AS(SELECT * FROM nodes WHERE category_id=(v->>'categoryId')::uuid UNION SELECT n.* FROM nodes n JOIN tree t ON n.parent_id=t.category_id::text WHERE v->>'propagation'='subtree') SELECT category_id FROM tree LOOP
 SELECT ARRAY(SELECT DISTINCT unnest(placement.scope_keys) COLLATE "C" key FROM jsonb_array_elements(plan->'beforeVector') b JOIN whaleu_ratings.category_scope_placements placement ON (placement.source_id,placement.source_revision)=((b->>'id')::uuid,(b->>'revision')::uuid) WHERE placement.category_id=row.category_id ORDER BY 1) INTO old_scopes;
 IF old_scopes IS DISTINCT FROM desired_scopes THEN
 IF NOT whaleu_ratings.category_management_scope_bases(p,row.category_id) THEN RETURN false;END IF;
 IF (SELECT count(*) FROM jsonb_array_elements(plan->'sourceIssues') i WHERE i->>'kind'='scoped_category_scope' AND i ? 'placement' AND i->'payload'->>'categoryId'=row.category_id::text AND i->'scopeKeys'=to_jsonb(desired_scopes))<>1 THEN RETURN false;END IF;
 ELSIF EXISTS(SELECT 1 FROM jsonb_array_elements(plan->'sourceIssues') i WHERE i->'payload'->>'categoryId'=row.category_id::text) THEN RETURN false;END IF;
 END LOOP;
 END IF;
 IF op IN ('set_category_lifecycle_scoped','batch_update_subcategories_scoped') THEN
 wanted:=CASE WHEN op='set_category_lifecycle_scoped' THEN ARRAY[(v->>'categoryId')::uuid] ELSE ARRAY(SELECT value::uuid FROM jsonb_array_elements_text((v->'disableIds')||(v->'restoreIds')||(v->'enableIds'))) END;
 FOR row IN SELECT h->>'scopeKey' scope_key,l.category_id,l.proof FROM jsonb_array_elements(plan->'beforeHeads') h JOIN whaleu_ratings.scoped_category_lineage l ON l.catalog_id=(h->>'catalogRevision')::uuid WHERE l.category_id=ANY(wanted)
 UNION ALL SELECT unnest(s.scope_keys),(s.payload->>'categoryId')::uuid,NULL::jsonb FROM jsonb_array_elements(plan->'beforeVector') b JOIN whaleu_ratings.scoped_source_attestations s ON (s.id,s.revision)=((b->>'id')::uuid,(b->>'revision')::uuid) WHERE s.source_kind='scoped_category_lifecycle' AND (s.payload->>'categoryId')::uuid=ANY(wanted) LOOP
 desired_state:=CASE WHEN op='set_category_lifecycle_scoped' THEN v->>'state' WHEN v->'enableIds' @> to_jsonb(ARRAY[row.category_id]) THEN 'enabled' ELSE 'disabled' END;
 SELECT s.* INTO old_source FROM jsonb_array_elements(plan->'beforeVector') b JOIN whaleu_ratings.scoped_source_attestations s ON (s.id,s.revision)=((b->>'id')::uuid,(b->>'revision')::uuid) WHERE s.source_kind='scoped_category_lifecycle' AND s.payload->>'categoryId'=row.category_id::text AND row.scope_key=ANY(s.scope_keys);
 old_state:=coalesce(old_source.payload->>'businessState',CASE WHEN coalesce(old_source.payload->'active',row.proof->'body'->'active')='true'::jsonb THEN 'enabled' ELSE 'disabled' END);
 IF old_state IS DISTINCT FROM desired_state AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(plan->'sourceIssues') i WHERE i->>'kind'='scoped_category_lifecycle' AND i->'payload'->>'categoryId'=row.category_id::text AND i->'scopeKeys'=to_jsonb(ARRAY[row.scope_key]) AND i->'payload'->>'businessState'=desired_state) THEN RETURN false;END IF;
 END LOOP;
 END IF;
 IF op IN ('reorder_categories_scoped','batch_update_subcategories_scoped') THEN
 SELECT coalesce(jsonb_agg(id ORDER BY ordinal::bigint),'[]'::jsonb),coalesce(jsonb_agg(ordinal ORDER BY ordinal::bigint),'[]'::jsonb) INTO actual,slots FROM (
 SELECT l.category_id id,l.proof->'body'->>'ordinal' ordinal FROM jsonb_array_elements(plan->'beforeHeads') h JOIN whaleu_ratings.scoped_category_lineage l ON l.catalog_id=(h->>'catalogRevision')::uuid WHERE h->>'scopeKey'=selected AND l.proof->'body'->'parentId' IS NOT DISTINCT FROM v->'parentId'
 UNION ALL SELECT (i->'payload'->>'categoryId')::uuid,i->'payload'->>'ordinal' FROM jsonb_array_elements(plan->'sourceIssues') i WHERE i->>'kind'='scoped_category_base' AND i->'payload'->>'previousBaseSourceId' IS NULL AND i->'payload'->'reviewEnvelope'->'body'->'parentId' IS NOT DISTINCT FROM v->'parentId') siblings;
 ordered:=CASE WHEN op='batch_update_subcategories_scoped' THEN (SELECT coalesce(jsonb_agg(CASE WHEN n->>'kind'='existing' THEN n->>'id' ELSE whaleu_ratings.category_management_artifact(p.intent_hash,'category:'||(n->>'key'))::text END ORDER BY position),'[]'::jsonb) FROM jsonb_array_elements(v->'orderedChildren') WITH ORDINALITY a(n,position)) WHEN v->>'action'='set' THEN v->'orderedIds' ELSE (SELECT coalesce(jsonb_agg(l.category_id ORDER BY (whaleu_ratings.category_historical_metadata(l.base_source_id,l.base_source_revision)->>'ordinal')::bigint),'[]'::jsonb) FROM jsonb_array_elements(plan->'beforeHeads') h JOIN whaleu_ratings.scoped_category_lineage l ON l.catalog_id=(h->>'catalogRevision')::uuid WHERE h->>'scopeKey'=selected AND l.proof->'body'->'parentId' IS NOT DISTINCT FROM v->'parentId') END;
 IF (SELECT coalesce(jsonb_agg(x ORDER BY x),'[]'::jsonb) FROM jsonb_array_elements(ordered) x) IS DISTINCT FROM (SELECT coalesce(jsonb_agg(x ORDER BY x),'[]'::jsonb) FROM jsonb_array_elements(actual) x) THEN RETURN false;END IF;
 FOR row IN SELECT value id,n FROM jsonb_array_elements_text(ordered) WITH ORDINALITY a(value,n) LOOP
 before:=whaleu_ratings.category_management_before_category(p,row.id::uuid,selected);
 SELECT * INTO old_source FROM whaleu_ratings.scoped_source_attestations WHERE id=(before->>'orderSourceId')::uuid AND revision=(before->>'orderSourceRevision')::uuid;
 IF actual->>(row.n-1)::integer IS DISTINCT FROM row.id OR (op='reorder_categories_scoped' AND v->>'action'='inherit' AND old_source.id IS NOT NULL AND old_source.payload->>'action' IS DISTINCT FROM 'inherit') THEN
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(plan->'sourceIssues') i WHERE i->>'kind'='scoped_category_order' AND i->'payload'->>'categoryId'=row.id AND i->'payload'->'siblingIds'=ordered AND i->'payload'->>'ordinal'=slots->>(row.n-1)::integer AND i->'payload'->>'action'=(CASE WHEN op='reorder_categories_scoped' THEN v->>'action' ELSE 'set' END)) THEN RETURN false;END IF;END IF;
 END LOOP;
 END IF;
 RETURN true;
END $$;

CREATE FUNCTION whaleu_ratings.category_management_system_policy(p whaleu_ratings.scoped_command_preparations) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE plan jsonb:=p.category_plan;v jsonb:=p.intent->'payload';op text:=p.operation;selected text;wanted uuid[];id uuid;proof jsonb;node jsonb;root jsonb;registry whaleu_ratings.scoped_source_attestations;root_source whaleu_ratings.scoped_source_attestations;depth integer;configured integer;item jsonb;is_new boolean;parent_id uuid;
BEGIN
 selected:=CASE WHEN p.intent->'context'->'selector'->>'kind'='global' THEN 'global' ELSE 'campus:'||(p.intent->'context'->>'selector') END;
 IF p.intent->'context'->'selector'->>'kind'='campus' THEN selected:='campus:'||(p.intent->'context'->'selector'->>'campusId');END IF;
 wanted:=CASE WHEN op IN ('create_categories_scoped','batch_update_subcategories_scoped','reorder_categories_scoped') THEN CASE WHEN v->>'parentId' IS NULL THEN ARRAY[]::uuid[] ELSE ARRAY[(v->>'parentId')::uuid] END WHEN op='create_system_category_scoped' THEN ARRAY[]::uuid[] ELSE ARRAY[(v->>'categoryId')::uuid] END;
 wanted:=wanted||ARRAY(SELECT (i->'payload'->>'categoryId')::uuid FROM jsonb_array_elements(plan->'sourceIssues') i WHERE i->>'kind'='scoped_category_base');
 FOREACH id IN ARRAY wanted LOOP
 proof:=whaleu_ratings.category_management_before_category(p,id,selected);is_new:=proof IS NULL;
 IF proof IS NULL THEN SELECT jsonb_build_object('body',(i->'payload'->'reviewEnvelope'->'body')||jsonb_build_object('id',id),'baseSourceId',i->>'id','baseSourceRevision',i->>'revision') INTO proof FROM jsonb_array_elements(plan->'sourceIssues') i WHERE i->>'kind'='scoped_category_base' AND i->'payload'->>'categoryId'=id::text LIMIT 1;END IF;
 IF proof IS NULL THEN SELECT l.proof INTO proof FROM jsonb_array_elements(plan->'beforeHeads') h JOIN whaleu_ratings.scoped_category_lineage l ON l.catalog_id=(h->>'catalogRevision')::uuid WHERE l.category_id=id LIMIT 1;END IF;
 IF proof IS NULL THEN RETURN false;END IF;
 IF proof->'body'->>'originKind'='global' AND plan->'globalRequired' IS DISTINCT FROM 'true'::jsonb THEN RETURN false;END IF;
 node:=proof;root:=NULL;depth:=0;
 LOOP
 depth:=depth+1;IF depth>3 THEN RETURN false;END IF;
 IF node->'body'->>'systemKey' IS NOT NULL THEN root:=node;EXIT;END IF;
 IF node->'body'->>'parentId' IS NULL THEN EXIT;END IF;
 parent_id:=(node->'body'->>'parentId')::uuid;
 SELECT l.proof INTO node FROM jsonb_array_elements(plan->'beforeHeads') h JOIN whaleu_ratings.scoped_category_lineage l ON l.catalog_id=(h->>'catalogRevision')::uuid WHERE l.category_id=parent_id ORDER BY (h->>'scopeKey'=selected) DESC LIMIT 1;
 IF node IS NULL THEN
 SELECT jsonb_build_object('body',(i->'payload'->'reviewEnvelope'->'body')||jsonb_build_object('id',i->'payload'->'categoryId'),'baseSourceId',i->>'id','baseSourceRevision',i->>'revision') INTO node FROM jsonb_array_elements(plan->'sourceIssues') i WHERE i->>'kind'='scoped_category_base' AND i->'payload'->>'categoryId'=parent_id::text LIMIT 1;
 END IF;
 IF node IS NULL THEN RETURN false;END IF;
 END LOOP;
 IF root IS NULL THEN CONTINUE;END IF;
 SELECT s.* INTO registry FROM whaleu_ratings.scoped_source_heads h JOIN whaleu_ratings.scoped_source_attestations s ON (s.id,s.revision)=(h.source_id,h.source_revision) WHERE s.source_kind='scoped_category_system_registry' AND s.payload->'systemKey'=root->'body'->'systemKey' AND whaleu_ratings.scoped_source_current(s.id,s.revision,clock_timestamp());
 IF NOT coalesce(registry.payload->'enabled'='true'::jsonb AND p.valid_until<=registry.valid_until AND (plan->>'validUntil')::timestamptz<=registry.valid_until AND registry.payload->>'kind'='general' AND registry.payload->>'consumer'='ratings_general_v1' AND plan->'registrySourceIds' @> to_jsonb(ARRAY[registry.id]),false) THEN RETURN false;END IF;
 SELECT root_attestation.* INTO root_source FROM whaleu_ratings.scoped_source_attestations root_attestation WHERE root_attestation.id=(root->>'baseSourceId')::uuid AND root_attestation.revision=(root->>'baseSourceRevision')::uuid;
 IF root_source.id IS NULL THEN SELECT i->'payload' INTO item FROM jsonb_array_elements(plan->'sourceIssues') i WHERE i->>'id'=root->>'baseSourceId';ELSE item:=root_source.payload;END IF;
 configured:=coalesce((item->>'maximumDepth')::integer,(registry.payload->>'maximumDepth')::integer);
 IF configured<1 OR configured>3 OR (proof->'body'->>'level')::integer>least(configured,(registry.payload->>'maximumDepth')::integer) THEN RETURN false;END IF;
 IF op IN ('create_categories_scoped','create_system_category_scoped','edit_category_base_scoped','set_category_scope_scoped','set_category_lifecycle_scoped','batch_update_subcategories_scoped') AND plan->'globalRequired' IS DISTINCT FROM 'true'::jsonb THEN RETURN false;END IF;
 IF op IN ('set_category_override_scoped','set_category_visibility_scoped') AND registry.payload->'allowCampusOverride' IS DISTINCT FROM 'true'::jsonb THEN RETURN false;END IF;
 IF op='set_category_lifecycle_scoped' AND root->'body'->'id'=v->'categoryId' AND (v->>'state'='archived' OR (v->>'state'='disabled' AND registry.payload->'allowDisable' IS DISTINCT FROM 'true'::jsonb)) THEN RETURN false;END IF;
 IF op IN ('create_categories_scoped','batch_update_subcategories_scoped') AND (op='create_categories_scoped' OR jsonb_array_length(v->'addNodes')>0) AND registry.payload->'allowChildren' IS DISTINCT FROM 'true'::jsonb THEN RETURN false;END IF;
 END LOOP;
 RETURN true;
END $$;

CREATE FUNCTION whaleu_ratings.category_management_lifecycle_predecessor(p whaleu_ratings.scoped_command_preparations,item jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE ref jsonb:=item->'payload'->'lifecyclePredecessor';s whaleu_ratings.scoped_source_attestations;views text[];expected_keys text[];
BEGIN
 IF ref IS NULL THEN RETURN NULL;END IF;
 IF NOT whaleu_community.rating_scoped_keys(ref,ARRAY['sourceId','sourceRevision']) OR NOT whaleu_community.rating_scoped_ids(ref,ARRAY['sourceId','sourceRevision']) THEN RETURN NULL;END IF;
 SELECT * INTO s FROM whaleu_ratings.scoped_source_attestations WHERE id=(ref->>'sourceId')::uuid AND revision=(ref->>'sourceRevision')::uuid;
 IF s.source_kind IS DISTINCT FROM 'scoped_category_lifecycle' OR s.payload->'categoryId' IS DISTINCT FROM item->'payload'->'categoryId' OR NOT p.category_plan->'beforeVector' @> jsonb_build_array(jsonb_build_object('id',s.id,'revision',s.revision,'kind',s.source_kind,'key',s.source_key,'digest',s.digest)) THEN RETURN NULL;END IF;
 SELECT array_agg(key ORDER BY key COLLATE "C") INTO views FROM jsonb_array_elements(p.category_plan->'sourceIssues') i CROSS JOIN LATERAL jsonb_array_elements_text(i->'scopeKeys') key WHERE i->>'kind'='scoped_category_lifecycle' AND i->'payload'->'lifecyclePredecessor'=ref;
 SELECT array_agg(key ORDER BY key COLLATE "C") INTO expected_keys FROM unnest(s.scope_keys) key;
 IF views IS DISTINCT FROM expected_keys OR NOT item->'scopeKeys'<@to_jsonb(s.scope_keys) THEN RETURN NULL;END IF;
 IF item->'scopeKeys'->>0=s.scope_keys[1] THEN
 IF item->>'key' IS DISTINCT FROM s.source_key OR item->>'previousSourceId' IS DISTINCT FROM s.id::text OR item->>'previousSourceRevision' IS DISTINCT FROM s.revision::text THEN RETURN NULL;END IF;
 ELSIF item->>'key' IS DISTINCT FROM 'category:'||(s.payload->>'categoryId')||':'||(item->'scopeKeys'->>0) THEN RETURN NULL;END IF;
 RETURN s.payload;
END $$;

-- Exact immutable inventory derivation: a C operation can only change category
-- placements described by its own typed plan; target origin placements are retained.
CREATE FUNCTION whaleu_ratings.category_management_inventory(p whaleu_ratings.scoped_command_preparations,scope text) RETURNS jsonb LANGUAGE sql STABLE AS $$
 WITH old_placements AS (
 SELECT x.category_id,x.scope_keys FROM whaleu_ratings.category_scope_placements x JOIN jsonb_array_elements(p.category_plan->'beforeVector') b ON (b->>'id')::uuid=x.source_id AND (b->>'revision')::uuid=x.source_revision
 WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p.category_plan->'sourceIssues') i WHERE i->>'previousSourceId'=x.source_id::text AND i->>'previousSourceRevision'=x.source_revision::text)
 ), new_placements AS (
 SELECT (i->'placement'->>'categoryId')::uuid category_id,ARRAY(SELECT jsonb_array_elements_text(i->'scopeKeys')) scope_keys FROM jsonb_array_elements(p.category_plan->'sourceIssues') i WHERE i->>'kind'='scoped_category_scope' AND i ? 'placement'
 ), categories AS (SELECT category_id FROM old_placements WHERE scope=ANY(scope_keys) UNION SELECT category_id FROM new_placements WHERE scope=ANY(scope_keys)), targets AS (
 SELECT DISTINCT x.target_id FROM whaleu_ratings.target_scope_placements x JOIN jsonb_array_elements(p.category_plan->'beforeVector') b ON (b->>'id')::uuid=x.source_id AND (b->>'revision')::uuid=x.source_revision JOIN whaleu_ratings.targets t ON t.id=x.target_id JOIN categories c ON c.category_id=t.category_id WHERE scope=ANY(x.scope_keys)
 ) SELECT jsonb_build_object('categoryIds',(SELECT coalesce(jsonb_agg(category_id ORDER BY category_id),'[]'::jsonb) FROM categories),'targetIds',(SELECT coalesce(jsonb_agg(target_id ORDER BY target_id),'[]'::jsonb) FROM targets))
$$;
CREATE FUNCTION whaleu_ratings.category_management_after_vector(p whaleu_ratings.scoped_command_preparations) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT coalesce(jsonb_agg(entry ORDER BY entry->>'kind' COLLATE "C",entry->>'key' COLLATE "C"),'[]'::jsonb) FROM (
 SELECT b entry FROM jsonb_array_elements(p.category_plan->'beforeVector') b WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p.category_plan->'sourceIssues') i WHERE i->>'previousSourceId'=b->>'id' AND i->>'previousSourceRevision'=b->>'revision')
 UNION ALL SELECT jsonb_build_object('id',s.id,'revision',s.revision,'kind',s.source_kind,'key',s.source_key,'digest',s.digest) FROM jsonb_array_elements(p.category_plan->'sourceIssues') i JOIN whaleu_ratings.scoped_source_attestations s ON (s.id,s.revision)=((i->>'id')::uuid,(i->>'revision')::uuid)
 ) exact_vector
$$;

CREATE FUNCTION whaleu_ratings.category_management_plan_valid(p whaleu_ratings.scoped_command_preparations,current_before boolean) RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
DECLARE plan jsonb:=p.category_plan;v jsonb:=p.intent->'payload';op text:=p.operation;keys text[];wanted text[];selected text;policy whaleu_ratings.scoped_source_attestations;
 issue jsonb;issue_payload jsonb;previous whaleu_ratings.scoped_source_attestations;before jsonb;body jsonb;base jsonb;envelope jsonb;category uuid;scope text;node jsonb;expected_id uuid;node_parent uuid;registry whaleu_ratings.scoped_source_attestations;ids jsonb;expected_ids jsonb;ordinal text;other jsonb;scopes text[];old_state text;new_state text;
BEGIN
 IF p.command_family<>'category' OR NOT whaleu_ratings.category_management_intent_valid(p.intent) OR p.intent_hash<>whaleu_ratings.scoped_intent_hash(p.intent) OR p.envelope IS NOT NULL
 OR p.target_id IS NOT NULL OR p.subject_id IS NOT NULL OR p.target_revision IS NOT NULL OR p.subject_revision IS NOT NULL OR p.definition_revision IS NOT NULL OR p.content_version IS NOT NULL
 OR NOT whaleu_community.rating_scoped_keys(plan,ARRAY['version','accountId','requestId','intentHash','operation','sourceIssues','envelopes','categoryIds','affectedScopeKeys','globalRequired','beforeHeads','beforeCompatHeads','beforeBaseAvailability','beforeVector','beforeDigest','policySourceId','policySourceRevision','registrySourceIds','changes','affectedTargetCount','previewDigest','validUntil','noop'])
 OR plan->'version'<>'1'::jsonb OR plan->>'accountId'<>p.account_id::text OR plan->>'requestId'<>p.request_id::text OR plan->>'intentHash'<>p.intent_hash OR plan->>'operation'<>p.operation
 OR plan->>'previewDigest'<>whaleu_ratings.scoped_digest('category-plan',plan||jsonb_build_object('previewDigest',''))
 OR plan->>'beforeDigest'<>whaleu_ratings.scoped_digest('category-before',jsonb_build_object('heads',plan->'beforeHeads','vector',plan->'beforeVector'))
 OR p.before_state<>jsonb_build_object('heads',plan->'beforeHeads','vector',plan->'beforeVector','digest',plan->'beforeDigest')
 OR (plan->>'validUntil')::timestamptz<p.valid_until OR p.valid_until<=clock_timestamp()
 OR jsonb_typeof(plan->'sourceIssues')<>'array' OR jsonb_array_length(plan->'sourceIssues')>100000 OR octet_length(plan::text)>67108864
 OR (plan->>'noop')::boolean<>(jsonb_array_length(plan->'sourceIssues')=0) THEN RETURN FALSE;END IF;
 keys:=ARRAY(SELECT value FROM jsonb_array_elements_text(plan->'affectedScopeKeys'));
 selected:=CASE WHEN p.intent->'context'->'selector'->>'kind'='global' THEN 'global' ELSE 'campus:'||(p.intent->'context'->'selector'->>'campusId') END;
 IF cardinality(keys)<1 OR cardinality(keys)>1001 OR NOT selected=ANY(keys) OR keys<>ARRAY(SELECT DISTINCT k COLLATE "C" FROM unnest(keys) k ORDER BY 1)
 OR EXISTS(SELECT 1 FROM unnest(keys) k WHERE k<>'global' AND k!~ '^campus:[0-9a-f-]{36}$')
 OR NOT whaleu_ratings.category_management_current_authority(p)
 OR (('global'=ANY(keys) OR op IN ('set_category_scope_scoped','create_system_category_scoped')) AND plan->'globalRequired'<>'true'::jsonb) THEN RETURN FALSE;END IF;
 SELECT * INTO policy FROM whaleu_ratings.scoped_source_attestations WHERE id=p.policy_source_id AND revision=p.policy_source_revision;
 IF NOT coalesce(policy.source_kind='native_scoped_category_management' AND policy.payload->'enabled'='true'::jsonb AND policy.payload->'operations' @> jsonb_build_array(op) AND keys<@policy.scope_keys AND whaleu_ratings.scoped_source_current(policy.id,policy.revision,clock_timestamp()) AND plan->>'policySourceId'=policy.id::text AND plan->>'policySourceRevision'=policy.revision::text AND p.valid_until<=policy.valid_until,false) THEN RETURN FALSE;END IF;
 IF current_before THEN
 IF plan->'beforeBaseAvailability' IS DISTINCT FROM (SELECT coalesce(jsonb_agg(jsonb_build_object('sourceId',base_source_id,'sourceRevision',base_source_revision,'current',whaleu_ratings.scoped_base_category(base_source_id,base_source_revision) IS NOT NULL) ORDER BY base_source_id),'[]'::jsonb) FROM (SELECT DISTINCT l.base_source_id,l.base_source_revision FROM jsonb_array_elements(plan->'beforeHeads') h JOIN whaleu_ratings.scoped_category_lineage l ON l.catalog_id=(h->>'catalogRevision')::uuid) bases) THEN RETURN false;END IF;
 IF NOT whaleu_ratings.category_management_complete_before(p) THEN RETURN false;END IF;
 IF NOT whaleu_ratings.scoped_context_current(p.context_id,p.account_id,p.session_id,clock_timestamp()) OR plan->'beforeHeads'<>whaleu_ratings.category_management_heads(keys) OR plan->'beforeVector'<>whaleu_ratings.scoped_current_source_vector(keys) OR plan->'beforeCompatHeads' IS DISTINCT FROM whaleu_ratings.category_management_compat_heads(keys) THEN RETURN FALSE;END IF;
 END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(plan->'beforeVector') x LEFT JOIN whaleu_ratings.scoped_source_attestations s ON (s.id,s.revision)=((x->>'id')::uuid,(x->>'revision')::uuid) WHERE s.id IS NULL OR s.digest<>x->>'digest' OR s.source_kind<>x->>'kind' OR s.source_key<>x->>'key' OR s.valid_until<p.valid_until OR s.effective_at>p.prepared_at) THEN RETURN FALSE;END IF;
 -- The complete affected identity set cannot be caller-labelled.
 IF plan->'categoryIds'<>(SELECT coalesce(jsonb_agg(id ORDER BY id),'[]'::jsonb) FROM (SELECT DISTINCT (x->'payload'->>'categoryId')::uuid id FROM jsonb_array_elements(plan->'sourceIssues') x WHERE x->>'kind'<>'scope_absence') ids) THEN RETURN FALSE;END IF;
 IF op IN ('edit_category_base_scoped','set_category_override_scoped','set_category_visibility_scoped','set_category_lifecycle_scoped','set_category_scope_scoped') AND whaleu_ratings.category_management_before_category(p,(v->>'categoryId')::uuid,selected) IS NULL THEN RETURN FALSE;END IF;
 IF op='reorder_categories_scoped' THEN
 SELECT coalesce(jsonb_agg(l.category_id ORDER BY l.category_id),'[]'::jsonb) INTO expected_ids FROM jsonb_array_elements(plan->'beforeHeads') h JOIN whaleu_ratings.scoped_category_lineage l ON l.catalog_id=(h->>'catalogRevision')::uuid WHERE h->>'scopeKey'=selected AND l.proof->'body'->'parentId' IS NOT DISTINCT FROM v->'parentId';
 IF v->>'action'='set' AND expected_ids<>(SELECT coalesce(jsonb_agg(value ORDER BY value),'[]'::jsonb) FROM jsonb_array_elements(v->'orderedIds')) THEN RETURN FALSE;END IF;
 END IF;
 IF op='set_category_scope_scoped' THEN
 -- Scope changes are closed over the selected subtree, including descendants not
 -- currently visible in the selected view. Parent coverage is checked again by compiler.
 IF EXISTS(WITH RECURSIVE all_categories AS (SELECT DISTINCT l.category_id,l.proof->'body'->>'parentId' parent FROM jsonb_array_elements(plan->'beforeHeads') h JOIN whaleu_ratings.scoped_category_lineage l ON l.catalog_id=(h->>'catalogRevision')::uuid), tree AS (SELECT category_id,parent FROM all_categories WHERE category_id=(v->>'categoryId')::uuid UNION SELECT c.category_id,c.parent FROM all_categories c JOIN tree t ON c.parent=t.category_id::text WHERE v->>'propagation'='subtree') SELECT 1 FROM jsonb_array_elements_text(plan->'categoryIds') id WHERE NOT EXISTS(SELECT 1 FROM tree WHERE category_id=id::uuid)) THEN RETURN FALSE;END IF;
 END IF;
 -- Every body approval is a one-to-one exact newly issued source envelope.
 IF plan->'envelopes'<>(SELECT coalesce(jsonb_agg(x->'payload'->'reviewEnvelope' ORDER BY n),'[]'::jsonb) FROM jsonb_array_elements(plan->'sourceIssues') WITH ORDINALITY a(x,n) WHERE x->'payload' ? 'reviewEnvelope')
 OR (SELECT count(*)<>count(DISTINCT x->>'id') OR count(*)<>count(DISTINCT (x->>'kind')||':'||(x->>'key')) FROM jsonb_array_elements(plan->'sourceIssues') x) THEN RETURN FALSE;END IF;
 wanted:=ARRAY(SELECT DISTINCT k COLLATE "C" FROM (SELECT selected k UNION ALL SELECT jsonb_array_elements_text(x->'scopeKeys') FROM jsonb_array_elements(plan->'sourceIssues') x UNION ALL SELECT unnest(s.scope_keys) FROM jsonb_array_elements(plan->'sourceIssues') x JOIN whaleu_ratings.scoped_source_attestations s ON (s.id,s.revision)=((x->>'previousSourceId')::uuid,(x->>'previousSourceRevision')::uuid)) all_scopes ORDER BY 1);
 IF plan->'noop'='true'::jsonb THEN wanted:=whaleu_ratings.category_management_noop_scopes(p);IF NOT whaleu_ratings.category_management_desired_before(p) THEN RETURN false;END IF;END IF;
 IF NOT whaleu_ratings.category_management_system_policy(p) OR NOT whaleu_ratings.category_management_required_delta(p) THEN RETURN false;END IF;
 IF keys<>wanted THEN RETURN FALSE;END IF;
 FOR issue IN SELECT value FROM jsonb_array_elements(plan->'sourceIssues') LOOP
 issue_payload:=issue->'payload';category:=coalesce(issue_payload->>'categoryId',issue_payload->'reviewEnvelope'->>'categoryId')::uuid;scopes:=ARRAY(SELECT value FROM jsonb_array_elements_text(issue->'scopeKeys'));
 IF issue->>'kind' NOT IN ('scoped_category_base','scoped_category_scope','scoped_category_override','scoped_category_lifecycle','scoped_category_order','scope_absence')
 OR (issue->>'id')::uuid<>whaleu_ratings.category_management_artifact(p.intent_hash,'category-source:'||(issue->>'kind')||':'||(issue->>'key'))
 OR (issue->>'revision')::uuid<>whaleu_ratings.category_management_artifact(p.intent_hash,'category-source-revision:'||(issue->>'kind')||':'||(issue->>'key'))
 OR scopes<>ARRAY(SELECT DISTINCT k COLLATE "C" FROM unnest(scopes) k ORDER BY 1) OR cardinality(scopes)<1 OR NOT scopes<@keys
 OR issue_payload->'management'<>jsonb_build_object('version',1,'accountId',p.account_id,'requestId',p.request_id,'intentHash',p.intent_hash) THEN RETURN FALSE;END IF;
 previous:=NULL;
 IF issue->>'previousSourceId' IS NOT NULL THEN
 SELECT * INTO previous FROM whaleu_ratings.scoped_source_attestations WHERE id=(issue->>'previousSourceId')::uuid AND revision=(issue->>'previousSourceRevision')::uuid;
 IF previous.id IS NULL OR previous.source_kind<>issue->>'kind' OR previous.source_key<>issue->>'key' OR NOT plan->'beforeVector' @> jsonb_build_array(jsonb_build_object('id',previous.id,'revision',previous.revision,'kind',previous.source_kind,'key',previous.source_key,'digest',previous.digest)) THEN RETURN FALSE;END IF;
 ELSIF EXISTS(SELECT 1 FROM jsonb_array_elements(plan->'beforeVector') x WHERE x->>'kind'=issue->>'kind' AND x->>'key'=issue->>'key') THEN RETURN FALSE;END IF;
 IF issue->>'kind'='scope_absence' THEN
 IF previous.id IS NULL OR scopes<>ARRAY[issue->>'key'] OR issue_payload->'complete'<>'true'::jsonb
 OR (issue_payload-ARRAY['management','complete','categoryIds','targetIds','previousSourceId','previousSourceRevision']) IS DISTINCT FROM (previous.payload-ARRAY['management','complete','categoryIds','targetIds','previousSourceId','previousSourceRevision'])
 OR issue_payload->>'previousSourceId' IS DISTINCT FROM previous.id::text OR issue_payload->>'previousSourceRevision' IS DISTINCT FROM previous.revision::text
 OR jsonb_build_object('categoryIds',issue_payload->'categoryIds','targetIds',issue_payload->'targetIds') IS DISTINCT FROM whaleu_ratings.category_management_inventory(p,issue->>'key') THEN RETURN FALSE;END IF;
 CONTINUE;END IF;
 IF category IS NULL OR NOT plan->'categoryIds' @> to_jsonb(ARRAY[category]) THEN RETURN FALSE;END IF;
 IF op IN ('edit_category_base_scoped','set_category_override_scoped','set_category_visibility_scoped','set_category_lifecycle_scoped') AND category::text IS DISTINCT FROM v->>'categoryId' THEN RETURN false;END IF;
 IF op IN ('edit_category_base_scoped','set_category_scope_scoped') AND issue->>'kind'<>'scoped_category_base' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(plan->'sourceIssues') rebound WHERE rebound->>'kind'='scoped_category_base' AND rebound->'payload'->>'categoryId'=category::text AND rebound->>'id'=issue_payload->>'baseSourceId' AND rebound->>'revision'=issue_payload->>'baseSourceRevision') THEN RETURN false;END IF;
 before:=whaleu_ratings.category_management_before_category(p,category,selected);body:=before->'body';
 IF body IS NULL THEN SELECT l.proof,l.proof->'body' INTO before,body FROM jsonb_array_elements(plan->'beforeHeads') h JOIN whaleu_ratings.scoped_category_lineage l ON l.catalog_id=(h->>'catalogRevision')::uuid WHERE l.category_id=category LIMIT 1;END IF;
 IF body->'isSystem'='true'::jsonb AND op IN ('edit_category_base_scoped','set_category_scope_scoped','set_category_lifecycle_scoped','batch_update_subcategories_scoped') AND issue->>'kind' IN ('scoped_category_base','scoped_category_lifecycle') AND plan->'globalRequired'<>'true'::jsonb THEN RETURN FALSE;END IF;
 IF issue->>'kind' IN ('scoped_category_base','scoped_category_scope') AND issue_payload->>'action' IS DISTINCT FROM 'retired' THEN
 IF op IN ('create_categories_scoped','create_system_category_scoped','set_category_scope_scoped') THEN
 IF scopes<>(CASE WHEN v->'placement'->>'kind'='global' THEN ARRAY['global'] ELSE ARRAY(SELECT 'campus:'||value FROM jsonb_array_elements_text(v->'placement'->'campusIds') ORDER BY value) END) THEN RETURN FALSE;END IF;
 ELSIF op='batch_update_subcategories_scoped' AND scopes<>ARRAY[selected] THEN RETURN FALSE;
 ELSIF op='edit_category_base_scoped' AND issue->>'kind'='scoped_category_scope' AND (previous.id IS NULL OR scopes<>previous.scope_keys) THEN RETURN FALSE;END IF;
 END IF;
 IF issue->>'kind'='scoped_category_base' THEN
 envelope:=issue_payload->'reviewEnvelope';
 IF op IN ('create_categories_scoped','create_system_category_scoped','batch_update_subcategories_scoped','set_category_scope_scoped') AND issue_payload->>'originKind' IS DISTINCT FROM (CASE WHEN envelope->'body'->>'systemKey' IS NOT NULL THEN 'system' WHEN scopes=ARRAY['global'] THEN 'global' ELSE 'regional' END) THEN RETURN false;END IF;
 IF envelope->>'purpose'<>'publish_rating_category_base_scoped' OR envelope->>'accountId'<>p.account_id::text OR envelope->>'sourceId'<>issue->>'id' OR envelope->>'sourceRevision'<>issue->>'revision' OR envelope->>'categoryId'<>category::text OR envelope->>'identityId'<>issue_payload->>'identityId' THEN RETURN FALSE;END IF;
 IF body IS NULL THEN
 IF op NOT IN ('create_categories_scoped','create_system_category_scoped','batch_update_subcategories_scoped') OR issue_payload->>'previousBaseSourceId' IS NOT NULL OR issue_payload->>'originSourceId' IS NOT NULL OR issue_payload->>'identityKind'<>'scoped_source' OR issue_payload->>'identityId'<>category::text
 OR EXISTS(SELECT 1 FROM whaleu_ratings.categories legacy WHERE legacy.id=category AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.compat_projection_manifests projection WHERE projection.after_catalog_id=legacy.catalog_id AND projection.publication_transaction=pg_current_xact_id())) OR EXISTS(SELECT 1 FROM whaleu_ratings.scoped_category_lineage l JOIN whaleu_ratings.scoped_catalogs c ON c.id=l.catalog_id WHERE l.category_id=category AND c.publication_transaction<>pg_current_xact_id()) THEN RETURN FALSE;END IF;
 IF op='create_system_category_scoped' THEN
 expected_id:=whaleu_ratings.category_management_artifact(p.intent_hash,'category:root');
 IF NOT whaleu_community.rating_scoped_integer(issue_payload->'maximumDepth',1) OR (issue_payload->>'maximumDepth')::integer>3 OR category<>expected_id OR envelope->'body'<>jsonb_build_object('parentId',NULL,'level',1,'kind','general','systemKey',v->'systemKey','name',v->'name','description',v->'description') OR issue_payload->'maximumDepth'<>v->'levelCount' THEN RETURN FALSE;END IF;
 ELSE
 SELECT value INTO node FROM jsonb_array_elements(CASE WHEN op='create_categories_scoped' THEN v->'nodes' ELSE v->'addNodes' END) n WHERE whaleu_ratings.category_management_artifact(p.intent_hash,'category:'||(n->>'key'))=category;
 IF node IS NULL OR (node->>'parentKey' IS NULL AND v->>'parentId' IS NULL AND envelope->'body'->>'kind'<>'general') THEN RETURN FALSE;END IF;
 node_parent:=CASE WHEN node->>'parentKey' IS NULL THEN (v->>'parentId')::uuid ELSE whaleu_ratings.category_management_artifact(p.intent_hash,'category:'||(node->>'parentKey')) END;
 IF envelope->'body'->>'parentId' IS DISTINCT FROM node_parent::text OR envelope->'body'->'name'<>node->'name' OR envelope->'body'->'description'<>node->'description' OR envelope->'body'->'systemKey'<>'null'::jsonb THEN RETURN FALSE;END IF;
 END IF;
 IF issue_payload->'active'<>'true'::jsonb OR issue_payload->'hidden'<>'false'::jsonb THEN RETURN FALSE;END IF;
 ELSE
 IF op NOT IN ('edit_category_base_scoped','set_category_scope_scoped') OR (op='edit_category_base_scoped' AND category::text<>v->>'categoryId') THEN RETURN FALSE;END IF;
 base:=whaleu_ratings.category_historical_body((issue_payload->>'previousBaseSourceId')::uuid,(issue_payload->>'previousBaseSourceRevision')::uuid);
 IF NOT EXISTS(SELECT 1 FROM whaleu_ratings.scoped_source_attestations original WHERE original.id=(issue_payload->>'previousBaseSourceId')::uuid AND original.revision=(issue_payload->>'previousBaseSourceRevision')::uuid AND issue_payload->>'originSourceId'=coalesce(original.payload->>'originSourceId',original.id::text) AND issue_payload->>'originSourceRevision'=coalesce(original.payload->>'originSourceRevision',original.revision::text)) THEN RETURN false;END IF;
 IF base IS NULL OR (envelope->'body')-ARRAY['name','description']<>(base-ARRAY['id','name','description','identityKind','identityId']) OR envelope->>'identityId'<>body->>'identityId' OR issue_payload->>'identityKind'<>body->>'identityKind' THEN RETURN FALSE;END IF;
 IF (issue_payload-ARRAY['management','reviewEnvelope','issuanceDigest','categoryId','identityId','identityKind','originSourceId','originSourceRevision','previousBaseSourceId','previousBaseSourceRevision','maximumDepth','registrySourceId','registrySourceRevision','originKind']) IS DISTINCT FROM (whaleu_ratings.category_historical_metadata((issue_payload->>'previousBaseSourceId')::uuid,(issue_payload->>'previousBaseSourceRevision')::uuid)-'originKind') THEN RETURN false;END IF;
 IF op='edit_category_base_scoped' AND issue_payload->'originKind' IS DISTINCT FROM whaleu_ratings.category_historical_metadata((issue_payload->>'previousBaseSourceId')::uuid,(issue_payload->>'previousBaseSourceRevision')::uuid)->'originKind' THEN RETURN false;END IF;
 IF body->'isSystem'='true'::jsonb AND EXISTS(SELECT 1 FROM whaleu_ratings.scoped_source_attestations old_base WHERE old_base.id=(issue_payload->>'previousBaseSourceId')::uuid AND old_base.revision=(issue_payload->>'previousBaseSourceRevision')::uuid AND old_base.payload ? 'maximumDepth' AND old_base.payload->'maximumDepth' IS DISTINCT FROM issue_payload->'maximumDepth') THEN RETURN false;END IF;
 IF op='edit_category_base_scoped' AND (envelope->'body'->'name'<>v->'name' OR envelope->'body'->'description'<>v->'description') THEN RETURN FALSE;END IF;
 IF op='set_category_scope_scoped' AND (envelope->'body'->'name'<>base->'name' OR envelope->'body'->'description'<>base->'description') THEN RETURN FALSE;END IF;
 -- Every current dependent placement and override is renewed on base change.
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(plan->'beforeVector') x JOIN whaleu_ratings.scoped_source_attestations dep ON (dep.id,dep.revision)=((x->>'id')::uuid,(x->>'revision')::uuid) WHERE dep.source_kind IN ('scoped_category_scope','scoped_category_override','scoped_category_lifecycle','scoped_category_order') AND coalesce(dep.payload->>'baseSourceId',dep.payload->'reviewEnvelope'->>'baseSourceId')=issue_payload->>'previousBaseSourceId' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(plan->'sourceIssues') next WHERE next->>'previousSourceId'=dep.id::text AND next->>'previousSourceRevision'=dep.revision::text AND next->'payload'->>'baseSourceId'=issue->>'id' AND next->'payload'->>'baseSourceRevision'=issue->>'revision')) THEN RETURN FALSE;END IF;
 END IF;
 IF issue_payload->>'registrySourceId' IS NOT NULL THEN
 SELECT * INTO registry FROM whaleu_ratings.scoped_source_attestations WHERE id=(issue_payload->>'registrySourceId')::uuid AND revision=(issue_payload->>'registrySourceRevision')::uuid;
 IF (SELECT count(*) FROM whaleu_ratings.scoped_source_heads h JOIN whaleu_ratings.scoped_source_attestations x ON (x.id,x.revision)=(h.source_id,h.source_revision) WHERE x.source_kind='scoped_category_system_registry' AND x.payload->'systemKey'=registry.payload->'systemKey' AND whaleu_ratings.scoped_source_current(x.id,x.revision,clock_timestamp()))<>1 OR (op='create_system_category_scoped' AND (EXISTS(SELECT 1 FROM whaleu_ratings.scoped_source_attestations prior_system WHERE prior_system.source_kind='scoped_category_base' AND prior_system.payload->'reviewEnvelope'->'body'->'systemKey'=v->'systemKey' AND prior_system.publication_transaction<>pg_current_xact_id()) OR EXISTS(SELECT 1 FROM whaleu_ratings.scoped_category_lineage historical JOIN whaleu_ratings.scoped_catalogs catalog ON catalog.id=historical.catalog_id WHERE historical.proof->'body'->'systemKey'=v->'systemKey' AND catalog.publication_transaction<>pg_current_xact_id()))) OR registry.source_kind<>'scoped_category_system_registry' OR registry.payload->'enabled'<>'true'::jsonb OR registry.payload->>'kind'<>'general' OR registry.payload->>'consumer'<>'ratings_general_v1' OR registry.payload->'systemKey'<>envelope->'body'->'systemKey' OR NOT whaleu_ratings.scoped_source_current(registry.id,registry.revision,clock_timestamp()) OR (issue_payload->>'maximumDepth')::integer>(registry.payload->>'maximumDepth')::integer THEN RETURN FALSE;END IF;
 ELSIF envelope->'body'->'systemKey'<>'null'::jsonb THEN RETURN FALSE;END IF;
 ELSIF issue->>'kind'='scoped_category_override' THEN
 IF cardinality(scopes)<>1 OR scopes[1]='global' OR NOT whaleu_ratings.category_management_override(issue_payload->'modes'->'name',true) OR NOT whaleu_ratings.category_management_override(issue_payload->'modes'->'description',false) THEN RETURN FALSE;END IF;
 IF op='set_category_override_scoped' THEN
 IF category::text<>v->>'categoryId' OR scopes<>ARRAY[selected] OR issue_payload->'modes'<>jsonb_build_object('name',v->'name','description',v->'description') THEN RETURN FALSE;END IF;
 ELSIF op NOT IN ('edit_category_base_scoped','set_category_scope_scoped') OR previous.id IS NULL THEN RETURN FALSE;
 ELSIF NOT previous.payload ? 'modes' AND issue_payload->'modes'<>jsonb_build_object('name',jsonb_build_object('mode','set','value',previous.payload->'reviewEnvelope'->'body'->'name'),'description',jsonb_build_object('mode','set','value',previous.payload->'reviewEnvelope'->'body'->'description')) THEN RETURN false;
 ELSIF previous.payload ? 'modes' AND issue_payload->'modes'<>previous.payload->'modes' THEN RETURN FALSE;END IF;
 IF issue_payload->>'action'='inherit' THEN IF issue_payload ? 'reviewEnvelope' OR issue_payload->'modes'<>jsonb_build_object('name',jsonb_build_object('mode','inherit'),'description',jsonb_build_object('mode','inherit')) THEN RETURN FALSE;END IF;
 ELSE
 envelope:=issue_payload->'reviewEnvelope';
 SELECT next->'payload'->'reviewEnvelope'->'body' INTO base FROM jsonb_array_elements(plan->'sourceIssues') next WHERE next->>'id'=issue_payload->>'baseSourceId' AND next->>'kind'='scoped_category_base';
 IF base IS NULL THEN base:=whaleu_ratings.category_historical_body((issue_payload->>'baseSourceId')::uuid,(issue_payload->>'baseSourceRevision')::uuid);END IF;
 IF envelope->'body'<>jsonb_build_object('name',CASE WHEN issue_payload->'modes'->'name'->>'mode'='set' THEN issue_payload->'modes'->'name'->'value' ELSE base->'name' END,'description',CASE WHEN issue_payload->'modes'->'description'->>'mode'='set' THEN issue_payload->'modes'->'description'->'value' ELSE base->'description' END) OR envelope->>'baseSourceId'<>issue_payload->>'baseSourceId' OR envelope->>'baseSourceRevision'<>issue_payload->>'baseSourceRevision' THEN RETURN FALSE;END IF;
 END IF;
 ELSIF issue->>'kind'='scoped_category_lifecycle' THEN
 IF NOT coalesce(cardinality(scopes)=1 AND issue_payload->>'businessState' IN ('enabled','disabled','archived') AND jsonb_typeof(issue_payload->'active')='boolean' AND jsonb_typeof(issue_payload->'hidden')='boolean' AND issue_payload->'active'=to_jsonb(issue_payload->>'businessState'='enabled') AND whaleu_community.rating_scoped_ids(issue_payload,ARRAY['categoryId','baseSourceId','baseSourceRevision','businessStateRevision']) AND issue_payload->'authorizedExit'=to_jsonb(issue_payload->>'businessState'<>'enabled'),false) THEN RETURN FALSE;END IF;
 before:=whaleu_ratings.category_management_before_category(p,category,scopes[1]);
 other:=whaleu_ratings.category_management_lifecycle_predecessor(p,issue);
 IF issue_payload ? 'lifecyclePredecessor' AND other IS NULL THEN RETURN false;END IF;
 IF before->>'lifecycleSourceId' IS NOT NULL AND (issue_payload->'lifecyclePredecessor') IS DISTINCT FROM jsonb_build_object('sourceId',before->'lifecycleSourceId','sourceRevision',before->'lifecycleSourceRevision') THEN RETURN false;END IF;
 SELECT coalesce(s.payload->>'businessState',CASE WHEN before->'body'->'active'='true'::jsonb THEN 'enabled' ELSE 'disabled' END) INTO old_state FROM (SELECT 1) x LEFT JOIN whaleu_ratings.scoped_source_attestations s ON s.id=(before->>'lifecycleSourceId')::uuid AND s.revision=(before->>'lifecycleSourceRevision')::uuid;
 IF other IS NOT NULL THEN old_state:=coalesce(other->>'businessState',CASE WHEN other->'active'='true'::jsonb THEN 'enabled' ELSE 'disabled' END);END IF;
 IF op='set_category_visibility_scoped' THEN
 IF issue_payload->>'businessStateRevision' IS DISTINCT FROM coalesce(other->>'businessStateRevision',other->>'baseSourceRevision',before->>'baseSourceRevision') THEN RETURN false;END IF;
 IF category::text<>v->>'categoryId' OR issue_payload->>'businessState'<>old_state OR (scopes=ARRAY[selected] AND issue_payload->'hidden'<>v->'hidden') OR (scopes<>ARRAY[selected] AND (issue_payload->'hidden'<>before->'body'->'hidden' OR NOT EXISTS(SELECT 1 FROM whaleu_ratings.scoped_source_attestations shared WHERE shared.id=(before->>'lifecycleSourceId')::uuid AND cardinality(shared.scope_keys)>1 AND selected=ANY(shared.scope_keys)))) THEN RETURN FALSE;END IF;
 ELSIF op IN ('set_category_lifecycle_scoped','batch_update_subcategories_scoped') THEN
 IF issue_payload->>'businessStateRevision' IS DISTINCT FROM whaleu_ratings.category_management_artifact(p.intent_hash,'business-state:'||category::text)::text THEN RETURN false;END IF;
 IF (v->'restore'='true'::jsonb OR v->'restoreIds' @> to_jsonb(ARRAY[category])) AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(plan->'beforeVector') b JOIN whaleu_ratings.scoped_source_attestations old_life ON (old_life.id,old_life.revision)=((b->>'id')::uuid,(b->>'revision')::uuid) WHERE old_life.source_kind='scoped_category_lifecycle' AND old_life.payload->>'categoryId'=category::text AND old_life.payload->>'businessState'='archived') THEN RETURN false;END IF;
 new_state:=CASE WHEN op='set_category_lifecycle_scoped' THEN v->>'state' WHEN v->'enableIds' @> to_jsonb(ARRAY[category]) THEN 'enabled' WHEN ((v->'disableIds')||(v->'restoreIds')) @> to_jsonb(ARRAY[category]) THEN 'disabled' ELSE NULL END;
 IF new_state IS NULL OR issue_payload->>'businessState'<>new_state OR (before IS NOT NULL AND issue_payload->'hidden'<>before->'body'->'hidden') OR (op='set_category_lifecycle_scoped' AND category::text<>v->>'categoryId') OR (old_state='archived' AND NOT (new_state='disabled' AND (v->'restore'='true'::jsonb OR v->'restoreIds' @> to_jsonb(ARRAY[category])))) THEN RETURN FALSE;END IF;
 ELSIF op NOT IN ('edit_category_base_scoped','set_category_scope_scoped') THEN RETURN FALSE;
 ELSIF other IS NOT NULL THEN
 IF issue_payload->'active' IS DISTINCT FROM other->'active' OR issue_payload->'hidden' IS DISTINCT FROM other->'hidden' OR issue_payload->>'businessState' IS DISTINCT FROM coalesce(other->>'businessState',CASE WHEN other->'active'='true'::jsonb THEN 'enabled' ELSE 'disabled' END) OR issue_payload->>'businessStateRevision' IS DISTINCT FROM coalesce(other->>'businessStateRevision',other->>'baseSourceRevision') THEN RETURN false;END IF;
 ELSIF op<>'set_category_scope_scoped' OR before IS NOT NULL OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(plan->'sourceIssues') b WHERE b->>'kind'='scoped_category_base' AND b->>'id'=issue_payload->>'baseSourceId' AND b->'scopeKeys' @> to_jsonb(scopes)) THEN RETURN false;END IF;
 ELSIF issue->>'kind'='scoped_category_order' THEN
 IF op IN ('edit_category_base_scoped','set_category_scope_scoped') THEN
 IF previous.id IS NULL OR (issue_payload-ARRAY['management','baseSourceId','baseSourceRevision','categoryId'])<>(previous.payload-ARRAY['management','baseSourceId','baseSourceRevision','categoryId']) THEN RETURN FALSE;END IF;
 ELSIF op IN ('reorder_categories_scoped','batch_update_subcategories_scoped') THEN
 IF scopes<>ARRAY[selected] OR issue_payload->'parentId' IS DISTINCT FROM v->'parentId' OR issue_payload ? 'reviewEnvelope' THEN RETURN FALSE;END IF;
 IF op='batch_update_subcategories_scoped' AND issue_payload->'siblingIds'<>(SELECT coalesce(jsonb_agg(CASE WHEN item->>'kind'='existing' THEN item->>'id' ELSE whaleu_ratings.category_management_artifact(p.intent_hash,'category:'||(item->>'key'))::text END ORDER BY n),'[]'::jsonb) FROM jsonb_array_elements(v->'orderedChildren') WITH ORDINALITY a(item,n)) THEN RETURN false;END IF;
 IF op='reorder_categories_scoped' AND v->>'action'='set' AND issue_payload->'siblingIds'<>v->'orderedIds' THEN RETURN FALSE;END IF;
 SELECT coalesce(jsonb_agg(id ORDER BY id),'[]'::jsonb) INTO expected_ids FROM (SELECT l.category_id id FROM jsonb_array_elements(plan->'beforeHeads') h JOIN whaleu_ratings.scoped_category_lineage l ON l.catalog_id=(h->>'catalogRevision')::uuid WHERE h->>'scopeKey'=selected AND l.proof->'body'->'parentId' IS NOT DISTINCT FROM v->'parentId' UNION ALL SELECT (s->'payload'->>'categoryId')::uuid FROM jsonb_array_elements(plan->'sourceIssues') s WHERE s->>'kind'='scoped_category_base' AND s->'payload'->>'previousBaseSourceId' IS NULL AND s->'payload'->'reviewEnvelope'->'body'->'parentId' IS NOT DISTINCT FROM v->'parentId') siblings;
 SELECT jsonb_agg(value ORDER BY value) INTO ids FROM jsonb_array_elements(issue_payload->'siblingIds');
 IF ids<>expected_ids OR (SELECT count(*)<>count(DISTINCT value) FROM jsonb_array_elements(issue_payload->'siblingIds')) THEN RETURN FALSE;END IF;
 SELECT slot INTO ordinal FROM (SELECT slot,row_number() OVER(ORDER BY slot::bigint)-1 position FROM (SELECT l.proof->'body'->>'ordinal' slot FROM jsonb_array_elements(plan->'beforeHeads') h JOIN whaleu_ratings.scoped_category_lineage l ON l.catalog_id=(h->>'catalogRevision')::uuid WHERE h->>'scopeKey'=selected AND l.proof->'body'->'parentId' IS NOT DISTINCT FROM v->'parentId' UNION ALL SELECT s->'payload'->>'ordinal' FROM jsonb_array_elements(plan->'sourceIssues') s WHERE s->>'kind'='scoped_category_base' AND s->'payload'->>'previousBaseSourceId' IS NULL AND s->'payload'->'reviewEnvelope'->'body'->'parentId' IS NOT DISTINCT FROM v->'parentId') slots) numbered WHERE position=(SELECT n-1 FROM jsonb_array_elements_text(issue_payload->'siblingIds') WITH ORDINALITY x(id,n) WHERE id=category::text);
 IF issue_payload->>'ordinal'<>ordinal THEN RETURN FALSE;END IF;
 ELSE RETURN FALSE;END IF;
 ELSIF issue->>'kind'='scoped_category_scope' THEN
 IF op NOT IN ('create_categories_scoped','create_system_category_scoped','edit_category_base_scoped','set_category_scope_scoped','batch_update_subcategories_scoped') THEN RETURN FALSE;END IF;
 IF issue_payload->>'action'='retired' THEN IF op<>'set_category_scope_scoped' OR previous.id IS NULL OR issue ? 'placement' THEN RETURN FALSE;END IF;
 ELSIF issue->'placement'<>jsonb_build_object('revision',issue_payload->'placementRevision','categoryId',issue_payload->'categoryId','baseSourceId',issue_payload->'baseSourceId','baseSourceRevision',issue_payload->'baseSourceRevision') OR issue_payload->'scopeKeys'<>issue->'scopeKeys' THEN RETURN FALSE;END IF;
 END IF;
 -- All body approvals carry exact source identity, placement and issuance bytes.
 IF issue_payload ? 'reviewEnvelope' THEN
 envelope:=issue_payload->'reviewEnvelope';
 IF NOT whaleu_community.rating_scoped_envelope_shape(envelope,envelope->>'purpose') OR envelope->>'accountId'<>p.account_id::text OR envelope->>'sourceId'<>issue->>'id' OR envelope->>'sourceRevision'<>issue->>'revision' OR envelope->>'categoryId'<>category::text
 OR envelope->>'issuanceDigest'<>issue_payload->>'issuanceDigest' OR issue_payload->>'issuanceDigest'<>whaleu_ratings.scoped_digest('category-issuance',jsonb_build_object('accountId',p.account_id,'requestId',p.request_id,'intentHash',p.intent_hash,'kind',issue->'kind','key',issue->'key','scopeKeys',issue->'scopeKeys','payload',issue_payload-ARRAY['reviewEnvelope','issuanceDigest'])) THEN RETURN FALSE;END IF;
 END IF;
 END LOOP;
 RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN FALSE;END $$;
CREATE FUNCTION whaleu_ratings.verify_category_management_command(actor uuid,request uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE q whaleu_ratings.requests;p whaleu_ratings.scoped_command_preparations;o whaleu_ratings.scoped_command_outcomes;e whaleu_ratings.scoped_command_causes;r whaleu_ratings.scoped_releases;plan jsonb;item jsonb;s whaleu_ratings.scoped_source_attestations;heads jsonb;expected jsonb;n integer;
BEGIN
 SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=actor AND request_id=request;
 SELECT * INTO o FROM whaleu_ratings.scoped_command_outcomes WHERE account_id=actor AND request_id=request;
 IF NOT coalesce(whaleu_ratings.category_management_operation(q.operation) AND o.operation=q.operation AND o.intent_hash=q.intent_hash AND o.mutation_transaction=pg_current_xact_id(),false) THEN RAISE EXCEPTION 'Category outcome is absent or not exact' USING ERRCODE='23514';END IF;
 expected:=jsonb_build_object('protocolVersion',2,'requestId',request,'operation',q.operation,'intentHash',q.intent_hash,'outcome',o.outcome)||CASE WHEN o.outcome='closed' THEN jsonb_build_object('code',o.code) ELSE jsonb_build_object('result',o.result) END;
 IF q.receipt IS DISTINCT FROM expected OR EXISTS(SELECT 1 FROM whaleu_ratings.score_transitions WHERE account_id=actor AND request_id=request)
 OR EXISTS(SELECT 1 FROM whaleu_ratings.comment_transitions WHERE account_id=actor AND request_id=request) OR EXISTS(SELECT 1 FROM whaleu_ratings.reply_transitions WHERE account_id=actor AND request_id=request)
 OR EXISTS(SELECT 1 FROM whaleu_ratings.like_transitions WHERE account_id=actor AND request_id=request) OR EXISTS(SELECT 1 FROM whaleu_ratings.subscription_transitions WHERE account_id=actor AND request_id=request)
 OR EXISTS(SELECT 1 FROM whaleu_ratings.effect_events WHERE actor_account_id=actor AND request_id=request)
 THEN RAISE EXCEPTION 'Category receipt bytes or command-family isolation violated' USING ERRCODE='23514';END IF;
 SELECT count(*) INTO n FROM whaleu_ratings.scoped_source_attestations WHERE issuer='ratings-category-management' AND payload->'management'->>'accountId'=actor::text AND payload->'management'->>'requestId'=request::text;
 IF o.outcome='closed' THEN
 IF n<>0 OR EXISTS(SELECT 1 FROM whaleu_ratings.scoped_command_causes WHERE account_id=actor AND request_id=request) OR EXISTS(SELECT 1 FROM whaleu_ratings.scoped_releases WHERE cause_kind='category_management' AND cause->>'accountId'=actor::text AND cause->>'requestId'=request::text)
 OR o.code IN ('RATING_CREATION_CANCELLED','RATING_EDIT_CANCELLED') THEN RAISE EXCEPTION 'Category closure cannot hide an artifact' USING ERRCODE='23514';END IF;RETURN;END IF;
 SELECT * INTO p FROM whaleu_ratings.scoped_command_preparations WHERE account_id=actor AND request_id=request;
 plan:=p.category_plan;
 IF p.intent IS DISTINCT FROM o.intent OR NOT whaleu_ratings.category_management_plan_valid(p,false) OR p.intent_hash<>q.intent_hash OR o.result->'categoryIds'<>plan->'categoryIds' OR (o.outcome='noop')<>(plan->>'noop')::boolean
 OR NOT whaleu_community.rating_scoped_keys(o.result,ARRAY['releaseId','categoryIds','heads','occurredAt']) OR NOT coalesce(o.result->>'occurredAt' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$',false)
 THEN RAISE EXCEPTION 'Category success lacks exact valid prepared plan' USING ERRCODE='23514';END IF;
 IF (SELECT array_agg(cause_kind ORDER BY cause_kind) FROM whaleu_ratings.scoped_command_causes WHERE account_id=actor AND request_id=request)
 IS DISTINCT FROM (CASE WHEN o.outcome='noop' THEN ARRAY['category_execution'] ELSE ARRAY['category_execution','category_release'] END) THEN RAISE EXCEPTION 'Category cause cardinality mismatch' USING ERRCODE='23514';END IF;
 SELECT * INTO e FROM whaleu_ratings.scoped_command_causes WHERE account_id=actor AND request_id=request AND cause_kind='category_execution';
 IF e.mutation_transaction<>pg_current_xact_id() OR e.artifact_id<>p.context_id OR e.artifact_revision<>p.context_id OR e.proof<>jsonb_build_object('intentHash',p.intent_hash,'planDigest',plan->>'previewDigest','contextRevision',p.context_revision,'executionDigest',whaleu_ratings.scoped_digest('category-execution',jsonb_build_object('accountId',actor,'requestId',request,'planDigest',plan->>'previewDigest'))) THEN RAISE EXCEPTION 'Category execution cause mismatch' USING ERRCODE='23514';END IF;
 IF n<>jsonb_array_length(plan->'sourceIssues') THEN RAISE EXCEPTION 'Category managed source domain incomplete' USING ERRCODE='23514';END IF;
 IF whaleu_ratings.scoped_current_source_vector(ARRAY(SELECT jsonb_array_elements_text(plan->'affectedScopeKeys'))) IS DISTINCT FROM whaleu_ratings.category_management_after_vector(p) THEN RAISE EXCEPTION 'Category publication contains an unplanned source replacement or addition' USING ERRCODE='23514';END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(plan->'sourceIssues') LOOP
 SELECT * INTO s FROM whaleu_ratings.scoped_source_attestations WHERE id=(item->>'id')::uuid AND revision=(item->>'revision')::uuid;
 IF NOT coalesce(s.issuer='ratings-category-management' AND s.publication_transaction=pg_current_xact_id() AND s.source_kind=item->>'kind' AND s.source_key=item->>'key' AND to_jsonb(s.scope_keys)=item->'scopeKeys' AND s.payload=item->'payload' AND s.valid_until=(plan->>'validUntil')::timestamptz AND s.coverage='complete' AND s.provenance='accepted' AND s.source_reference='rating-category-management:'||actor::text||':'||request::text AND whaleu_ratings.scoped_source_current(s.id,s.revision,clock_timestamp()) AND s.policy_reference=(SELECT policy_reference FROM whaleu_ratings.scoped_source_attestations WHERE id=p.policy_source_id AND revision=p.policy_source_revision),false) THEN RAISE EXCEPTION 'Category derivative differs from exact prepared source' USING ERRCODE='23514';END IF;
 IF item ? 'placement' THEN
 IF NOT EXISTS(SELECT 1 FROM whaleu_ratings.category_scope_placements x WHERE x.placement_revision=(item->'placement'->>'revision')::uuid AND x.category_id=(item->'placement'->>'categoryId')::uuid AND x.base_source_id=(item->'placement'->>'baseSourceId')::uuid AND x.base_source_revision=(item->'placement'->>'baseSourceRevision')::uuid AND x.source_id=s.id AND x.source_revision=s.revision AND x.scope_keys=s.scope_keys AND x.publication_transaction=pg_current_xact_id()) THEN RAISE EXCEPTION 'Category derivative lacks exact placement' USING ERRCODE='23514';END IF;
 END IF;
 END LOOP;
 IF o.outcome='noop' THEN
 IF n<>0 OR o.result->'releaseId'<>'null'::jsonb OR o.result->'heads'<>plan->'beforeHeads' OR plan->'beforeHeads'<>whaleu_ratings.category_management_heads(ARRAY(SELECT jsonb_array_elements_text(plan->'affectedScopeKeys'))) THEN RAISE EXCEPTION 'Category noop cannot mutate sources or heads' USING ERRCODE='23514';END IF;
 ELSE
 SELECT * INTO r FROM whaleu_ratings.scoped_releases WHERE id=(o.result->>'releaseId')::uuid;
 SELECT * INTO e FROM whaleu_ratings.scoped_command_causes WHERE account_id=actor AND request_id=request AND cause_kind='category_release';
 heads:=whaleu_ratings.category_management_heads(r.affected_scope_keys);
 IF NOT coalesce(r.cause_kind='category_management' AND r.publication_transaction=pg_current_xact_id() AND r.cause->>'accountId'=actor::text AND r.cause->>'requestId'=request::text AND to_jsonb(r.affected_scope_keys)=plan->'affectedScopeKeys'
 AND o.result->'heads'=heads AND e.artifact_id=r.id AND e.artifact_revision=r.id AND e.mutation_transaction=pg_current_xact_id() AND e.proof=jsonb_build_object('planDigest',plan->>'previewDigest','heads',heads),false)
 OR EXISTS(SELECT 1 FROM whaleu_ratings.scoped_release_scopes x WHERE x.release_id=r.id AND NOT plan->'beforeHeads' @> jsonb_build_array(jsonb_build_object('scopeKey',x.scope_key,'catalogRevision',x.before_catalog_id,'headRevision',x.before_head_revision)))
 THEN RAISE EXCEPTION 'Category release is not exact whole-set CAS' USING ERRCODE='23514';END IF;
 END IF;
END $$;
CREATE FUNCTION whaleu_ratings.category_management_foreign_absence(s whaleu_ratings.scoped_source_attestations) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE old whaleu_ratings.scoped_source_attestations;p whaleu_ratings.scoped_command_preparations;e whaleu_ratings.scoped_command_causes;expected jsonb;
BEGIN
 IF s.source_kind<>'scope_absence' OR s.issuer NOT IN ('ratings-native-command','ratings-legacy-bridge') OR s.payload ? 'management' OR s.publication_transaction<>pg_current_xact_id() THEN RETURN false;END IF;
 SELECT * INTO old FROM whaleu_ratings.scoped_source_attestations WHERE id=(s.payload->>'previousSourceId')::uuid AND revision=(s.payload->>'previousSourceRevision')::uuid;
 IF old.source_kind IS DISTINCT FROM 'scope_absence' OR old.source_key IS DISTINCT FROM s.source_key OR s.scope_keys<>ARRAY[s.source_key] THEN RETURN false;END IF;
 IF s.issuer='ratings-native-command' THEN
 SELECT * INTO p FROM whaleu_ratings.scoped_command_preparations WHERE account_id=(s.payload->'nativeCommand'->>'accountId')::uuid AND request_id=(s.payload->'nativeCommand'->>'requestId')::uuid;
 IF NOT coalesce(p.operation='create_target_scoped' AND s.source_key=(CASE WHEN p.intent->'context'->'selector'->>'kind'='global' THEN 'global' ELSE 'campus:'||(p.intent->'context'->'selector'->>'campusId') END) AND EXISTS(SELECT 1 FROM whaleu_ratings.scoped_catalogs catalog WHERE catalog.id=(p.intent->'context'->>'catalogRevision')::uuid AND catalog.source_vector @> jsonb_build_array(jsonb_build_object('id',old.id,'revision',old.revision,'kind',old.source_kind,'key',old.source_key,'digest',old.digest))) AND EXISTS(SELECT 1 FROM whaleu_ratings.scoped_source_attestations policy WHERE policy.id=p.policy_source_id AND policy.revision=p.policy_source_revision AND policy.source_kind='native_scoped_create' AND policy.payload->'enabled'='true'::jsonb AND s.source_key=ANY(policy.scope_keys) AND s.policy_reference=policy.policy_reference AND s.valid_until<=least(policy.valid_until,old.valid_until) AND whaleu_ratings.scoped_source_current(policy.id,policy.revision,clock_timestamp())) AND EXISTS(SELECT 1 FROM whaleu_ratings.scoped_command_causes cause WHERE cause.account_id=p.account_id AND cause.request_id=p.request_id AND cause.cause_kind='target_initial' AND cause.artifact_id=p.target_id AND cause.mutation_transaction=pg_current_xact_id()),false) THEN RETURN false;END IF;
 expected:=jsonb_set(old.payload-'management','{targetIds}',(SELECT jsonb_agg(id ORDER BY id) FROM (SELECT jsonb_array_elements_text(old.payload->'targetIds') id UNION SELECT p.target_id::text) ids))||jsonb_build_object('nativeCommand',jsonb_build_object('accountId',p.account_id,'requestId',p.request_id),'previousSourceId',old.id,'previousSourceRevision',old.revision);
 RETURN s.payload=expected AND s.source_reference='rating-scoped-create:'||p.account_id::text||':'||p.request_id::text;
 END IF;
 SELECT * INTO e FROM whaleu_ratings.scoped_command_causes WHERE cause_kind='legacy_bridge' AND artifact_id=(s.payload->>'bridgeId')::uuid;
 -- The existing exact legacy derivative verifier closes node/target additions,
 -- predecessor vectors, original requests and all scopes at deferred boundary.
 RETURN coalesce(e.mutation_transaction=pg_current_xact_id() AND s.source_reference='rating-legacy-bridge:'||e.artifact_id::text AND EXISTS(SELECT 1 FROM jsonb_array_elements(e.proof->'domains') d WHERE d->'sourceVector' @> jsonb_build_array(jsonb_build_object('id',old.id,'revision',old.revision,'digest',old.digest)) AND d->'scopeKeys' @> to_jsonb(s.scope_keys)),false);
END $$;

CREATE FUNCTION whaleu_ratings.category_management_source_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p whaleu_ratings.scoped_command_preparations;e whaleu_ratings.scoped_command_causes;item jsonb;
BEGIN
 IF NEW.issuer<>'ratings-category-management' THEN
 IF whaleu_ratings.category_management_foreign_absence(NEW) THEN RETURN NEW;END IF;
 IF NEW.payload ?| ARRAY['management','businessState','businessStateRevision','lifecyclePredecessor']
 OR EXISTS(SELECT 1 FROM whaleu_ratings.scoped_source_attestations managed_previous WHERE managed_previous.issuer='ratings-category-management' AND ((managed_previous.source_kind,managed_previous.source_key)=(NEW.source_kind,NEW.source_key) OR managed_previous.id::text=coalesce(NEW.payload->>'baseSourceId',NEW.payload->'reviewEnvelope'->>'baseSourceId') OR managed_previous.id::text=NEW.payload->>'previousBaseSourceId' OR managed_previous.id::text=NEW.payload->>'originSourceId'))
 OR (NEW.source_kind IN ('scoped_category_override','scoped_category_lifecycle','scoped_category_order','scoped_category_scope','scoped_category_base') AND EXISTS(SELECT 1 FROM whaleu_ratings.scoped_source_attestations managed_previous WHERE managed_previous.issuer='ratings-category-management' AND managed_previous.source_kind='scoped_category_base' AND managed_previous.payload->>'categoryId'=coalesce(NEW.payload->>'categoryId',NEW.payload->'reviewEnvelope'->>'categoryId')))
 THEN RAISE EXCEPTION 'Managed lineage cannot drop its typed command causality' USING ERRCODE='23514';END IF;
 RETURN NEW;END IF;
 SELECT * INTO p FROM whaleu_ratings.scoped_command_preparations WHERE account_id=(NEW.payload->'management'->>'accountId')::uuid AND request_id=(NEW.payload->'management'->>'requestId')::uuid;
 SELECT * INTO e FROM whaleu_ratings.scoped_command_causes WHERE account_id=p.account_id AND request_id=p.request_id AND cause_kind='category_execution';
 SELECT value INTO item FROM jsonb_array_elements(p.category_plan->'sourceIssues') WHERE value->>'id'=NEW.id::text AND value->>'revision'=NEW.revision::text;
 IF NOT coalesce(p.command_family='category' AND e.mutation_transaction=pg_current_xact_id() AND NEW.publication_transaction=pg_current_xact_id() AND p.valid_until>clock_timestamp() AND item->>'kind'=NEW.source_kind AND item->>'key'=NEW.source_key AND item->'scopeKeys'=to_jsonb(NEW.scope_keys) AND item->'payload'=NEW.payload,false) THEN RAISE EXCEPTION 'Managed source needs prior exact same-transaction execution' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER category_management_source_guard BEFORE INSERT ON whaleu_ratings.scoped_source_attestations FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.category_management_source_guard();

-- Run at the final boundary as well as the immediate management discriminator:
-- a child inserted before its managed system parent cannot escape the registry
-- owner merely by choosing the legacy source shape or another issuer string.
CREATE FUNCTION whaleu_ratings.category_management_foreign_ancestry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE managed_system boolean;
BEGIN
 IF NEW.issuer='ratings-category-management' OR NEW.source_kind<>'scoped_category_base' THEN RETURN NULL;END IF;
 WITH RECURSIVE ancestors(id,path) AS (
 SELECT NEW.payload->'reviewEnvelope'->'body'->>'parentId',ARRAY[NEW.payload->'reviewEnvelope'->'body'->>'parentId']
 UNION ALL SELECT base.payload->'reviewEnvelope'->'body'->>'parentId',a.path||(base.payload->'reviewEnvelope'->'body'->>'parentId') FROM ancestors a JOIN whaleu_ratings.scoped_source_heads h ON h.source_kind='scoped_category_base' JOIN whaleu_ratings.scoped_source_attestations base ON (base.id,base.revision)=(h.source_id,h.source_revision) AND base.payload->>'categoryId'=a.id WHERE cardinality(a.path)<4 AND NOT (base.payload->'reviewEnvelope'->'body'->>'parentId')=ANY(a.path)
 ) SELECT EXISTS(SELECT 1 FROM ancestors a JOIN whaleu_ratings.scoped_source_heads h ON h.source_kind='scoped_category_base' JOIN whaleu_ratings.scoped_source_attestations base ON (base.id,base.revision)=(h.source_id,h.source_revision) AND base.payload->>'categoryId'=a.id WHERE base.issuer='ratings-category-management' AND base.payload->'reviewEnvelope'->'body'->>'systemKey' IS NOT NULL) INTO managed_system;
 IF managed_system THEN RAISE EXCEPTION 'Managed system descendants require the exact category registry command owner' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER category_management_foreign_ancestry AFTER INSERT ON whaleu_ratings.scoped_source_attestations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.category_management_foreign_ancestry();
