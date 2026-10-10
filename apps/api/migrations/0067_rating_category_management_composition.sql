-- M3C category composition and eligibility; original identities and target placements remain immutable.
SET LOCAL lock_timeout='5s';
CREATE OR REPLACE FUNCTION whaleu_ratings.scoped_base_category_pre_category(source uuid,revision uuid) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE s whaleu_ratings.scoped_source_attestations;c whaleu_ratings.categories;l whaleu_ratings.catalog_category_lineage;b whaleu_ratings.category_base_versions;e jsonb;ad whaleu_ratings.scoped_adoption_identities;m whaleu_ratings.legacy_adoption_manifests;
BEGIN
 SELECT * INTO s FROM whaleu_ratings.scoped_source_attestations WHERE id=source AND scoped_source_attestations.revision=scoped_base_category_pre_category.revision;
 IF s.source_kind='m3a_native_bridge' AND s.issuer='ratings-legacy-bridge' THEN RETURN whaleu_ratings.legacy_bridge_native_category(source,revision);
 ELSIF s.source_kind='m3a_native_bridge' THEN
  SELECT * INTO c FROM whaleu_ratings.categories WHERE catalog_id=(s.payload->>'legacyCatalogId')::uuid AND id=(s.payload->>'categoryId')::uuid;
  SELECT * INTO l FROM whaleu_ratings.catalog_category_lineage WHERE catalog_id=c.catalog_id AND category_id=c.id;
  SELECT * INTO b FROM whaleu_ratings.category_base_versions WHERE category_id=c.id AND category_base_versions.revision=l.base_revision;
  IF NOT coalesce(c.revision::text=s.payload->>'categoryRevision' AND l.source_kind='native' AND l.base_revision=c.revision AND l.effective_revision=c.revision
   AND EXISTS(SELECT 1 FROM whaleu_ratings.category_base_heads WHERE category_id=c.id AND category_base_heads.revision=l.base_revision)
   AND whaleu_ratings.category_catalog_sources_complete(c.catalog_id) AND whaleu_community.rating_category_base_current(c.id,l.base_revision,b.envelope),false)
  THEN RETURN NULL;END IF;
  RETURN jsonb_build_object('id',c.id,'parentId',c.parent_id,'level',c.level,'kind',c.kind,'systemKey',c.system_key,'isSystem',c.system_key IS NOT NULL,'originKind',c.origin_kind,'name',c.name,'description',c.description,'active',c.active,'hidden',c.hidden,'ordinal',c.ordinal::text,'identityKind','native_bridge','identityId',c.id);
 ELSIF s.source_kind='legacy_adoption' THEN
  RETURN whaleu_ratings.scoped_adoption_category(source,revision);
 ELSIF s.source_kind='scoped_category_base' THEN
  e:=s.payload->'reviewEnvelope';
  IF NOT coalesce(e->>'purpose'='publish_rating_category_base_scoped' AND e->>'sourceId'=s.id::text AND e->>'sourceRevision'=s.revision::text
   AND whaleu_community.rating_scoped_category_source_current(s.id,s.revision,e),false) THEN RETURN NULL;END IF;
  IF NOT coalesce(jsonb_typeof(s.payload->'active')='boolean' AND jsonb_typeof(s.payload->'hidden')='boolean' AND s.payload->>'ordinal' ~ '^(0|[1-9][0-9]{0,18})$'
   AND (s.payload->>'originKind' IN ('global','regional') OR (s.issuer='ratings-category-management' AND s.payload->>'originKind'='system')),false) THEN RETURN NULL;END IF;
  RETURN (e->'body')||jsonb_build_object('id',e->'categoryId','isSystem',e->'body'->'systemKey'<>'null'::jsonb,'originKind',s.payload->'originKind','active',s.payload->'active','hidden',s.payload->'hidden','ordinal',s.payload->>'ordinal','identityKind',CASE WHEN s.source_kind='legacy_adoption' THEN 'adopted' ELSE 'scoped_source' END,'identityId',e->'identityId');
 END IF;RETURN NULL;
END $$;
CREATE FUNCTION whaleu_ratings.category_historical_body(source uuid,revision uuid) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE s whaleu_ratings.scoped_source_attestations;c whaleu_ratings.categories;ai whaleu_ratings.scoped_adoption_identities;
BEGIN
 SELECT * INTO s FROM whaleu_ratings.scoped_source_attestations WHERE id=source AND scoped_source_attestations.revision=category_historical_body.revision;
 IF s.source_kind='scoped_category_base' THEN RETURN (s.payload->'reviewEnvelope'->'body')||jsonb_build_object('id',s.payload->'reviewEnvelope'->'categoryId','identityKind',coalesce(s.payload->>'identityKind','scoped_source'),'identityId',s.payload->'reviewEnvelope'->'identityId');
 ELSIF s.source_kind='m3a_native_bridge' THEN
 SELECT * INTO c FROM whaleu_ratings.categories WHERE catalog_id=coalesce(s.payload->>'legacyCatalogId',s.payload->>'legacyAfterCatalogId')::uuid AND id=(s.payload->>'categoryId')::uuid;
 IF c.id IS NULL THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('id',c.id,'parentId',c.parent_id,'level',c.level,'kind',c.kind,'systemKey',c.system_key,'name',c.name,'description',c.description,'identityKind','native_bridge','identityId',c.id);
 ELSIF s.source_kind='legacy_adoption' THEN
 SELECT * INTO ai FROM whaleu_ratings.scoped_adoption_identities WHERE id=(s.payload->>'identityId')::uuid;
 SELECT * INTO c FROM whaleu_ratings.categories WHERE catalog_id=(SELECT legacy_catalog_id FROM whaleu_ratings.legacy_adoption_manifests WHERE id=ai.manifest_id) AND id=ai.legacy_business_id;
 IF c.id IS NULL THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('id',c.id,'parentId',c.parent_id,'level',c.level,'kind',c.kind,'systemKey',c.system_key,'name',c.name,'description',c.description,'identityKind','adopted','identityId',ai.id);
 END IF;RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION whaleu_ratings.scoped_base_category(source uuid,revision uuid) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE s whaleu_ratings.scoped_source_attestations;b jsonb;anchor jsonb;
BEGIN
 SELECT * INTO s FROM whaleu_ratings.scoped_source_attestations WHERE id=source AND scoped_source_attestations.revision=scoped_base_category.revision;
 b:=whaleu_ratings.scoped_base_category_pre_category(source,revision);
 IF s.issuer IS DISTINCT FROM 'ratings-category-management' OR s.source_kind<>'scoped_category_base' THEN RETURN b;END IF;
 IF b IS NULL OR s.payload->'management'->'version'<>'1'::jsonb THEN RETURN NULL;END IF;
 IF b->'isSystem'='true'::jsonb AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.scoped_source_attestations registry WHERE registry.id=(s.payload->>'registrySourceId')::uuid AND registry.revision=(s.payload->>'registrySourceRevision')::uuid AND registry.source_kind='scoped_category_system_registry' AND registry.payload->'enabled'='true'::jsonb AND registry.payload->>'consumer'='ratings_general_v1' AND registry.payload->'kind'=b->'kind' AND registry.payload->'systemKey'=b->'systemKey' AND whaleu_ratings.scoped_source_current(registry.id,registry.revision,clock_timestamp()) AND b->>'originKind'='system') THEN RETURN NULL;END IF;
 IF s.payload->>'originSourceId' IS NULL THEN
 IF b->>'identityId'<>b->>'id' OR s.payload->>'identityKind'<>'scoped_source' THEN RETURN NULL;END IF;
 ELSE
 anchor:=whaleu_ratings.category_historical_body((s.payload->>'originSourceId')::uuid,(s.payload->>'originSourceRevision')::uuid);
 IF anchor IS NULL OR (anchor-ARRAY['name','description','identityKind']) IS DISTINCT FROM (b-ARRAY['name','description','identityKind','active','hidden','ordinal','originKind','isSystem'])
 OR s.payload->>'identityKind'<>anchor->>'identityKind' THEN RETURN NULL;END IF;
 b:=b||jsonb_build_object('identityKind',anchor->'identityKind');
 END IF;RETURN b;
EXCEPTION WHEN OTHERS THEN RETURN NULL;END $$;
CREATE OR REPLACE FUNCTION whaleu_ratings.scoped_expected_category(placement uuid,scope text) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE p whaleu_ratings.category_scope_placements;base jsonb;over whaleu_ratings.scoped_source_attestations;life whaleu_ratings.scoped_source_attestations;ordering whaleu_ratings.scoped_source_attestations;over_count integer;life_count integer;order_count integer;
BEGIN
 SELECT * INTO p FROM whaleu_ratings.category_scope_placements WHERE placement_revision=placement;
 IF p.placement_revision IS NULL OR NOT scope=ANY(p.scope_keys) OR NOT whaleu_ratings.scoped_source_current(p.source_id,p.source_revision,clock_timestamp())
 OR NOT whaleu_ratings.scoped_source_current(p.base_source_id,p.base_source_revision,clock_timestamp()) THEN RETURN NULL;END IF;
 base:=whaleu_ratings.scoped_base_category(p.base_source_id,p.base_source_revision);
 IF base IS NULL OR base->>'id'<>p.category_id::text THEN RETURN NULL;END IF;
 SELECT count(*) INTO over_count FROM whaleu_ratings.scoped_source_heads h JOIN whaleu_ratings.scoped_source_attestations s ON (s.id,s.revision)=(h.source_id,h.source_revision)
 WHERE s.source_kind='scoped_category_override' AND scope=ANY(s.scope_keys) AND coalesce(s.payload->'reviewEnvelope'->>'categoryId',s.payload->>'categoryId')=p.category_id::text;
 SELECT count(*) INTO life_count FROM whaleu_ratings.scoped_source_heads h JOIN whaleu_ratings.scoped_source_attestations s ON (s.id,s.revision)=(h.source_id,h.source_revision)
 WHERE s.source_kind='scoped_category_lifecycle' AND scope=ANY(s.scope_keys) AND s.payload->>'categoryId'=p.category_id::text;
 SELECT count(*) INTO order_count FROM whaleu_ratings.scoped_source_heads h JOIN whaleu_ratings.scoped_source_attestations s ON (s.id,s.revision)=(h.source_id,h.source_revision)
 WHERE s.source_kind='scoped_category_order' AND scope=ANY(s.scope_keys) AND s.payload->>'categoryId'=p.category_id::text;
 IF over_count>1 OR life_count>1 OR order_count>1 THEN RETURN NULL;END IF;
 IF over_count=1 THEN
  SELECT s.* INTO over FROM whaleu_ratings.scoped_source_heads h JOIN whaleu_ratings.scoped_source_attestations s ON (s.id,s.revision)=(h.source_id,h.source_revision)
  WHERE s.source_kind='scoped_category_override' AND scope=ANY(s.scope_keys) AND coalesce(s.payload->'reviewEnvelope'->>'categoryId',s.payload->>'categoryId')=p.category_id::text;
  IF over.issuer='ratings-category-management' AND over.payload->>'action'='inherit' THEN
   IF NOT coalesce(whaleu_ratings.scoped_source_current(over.id,over.revision,clock_timestamp()) AND over.scope_keys=ARRAY[scope] AND scope<>'global' AND over.payload->>'baseSourceId'=p.base_source_id::text AND over.payload->>'baseSourceRevision'=p.base_source_revision::text AND over.payload->'modes'=jsonb_build_object('name',jsonb_build_object('mode','inherit'),'description',jsonb_build_object('mode','inherit')) AND NOT over.payload ? 'reviewEnvelope',false) THEN RETURN NULL;END IF;
  ELSE
  IF NOT coalesce(whaleu_ratings.scoped_source_current(over.id,over.revision,clock_timestamp()) AND scope='campus:'||(over.payload->'reviewEnvelope'->'scope'->>'campusId')
   AND over.payload->'reviewEnvelope'->>'identityId'=base->>'identityId'
   AND over.payload->'reviewEnvelope'->>'baseSourceId'=p.base_source_id::text AND over.payload->'reviewEnvelope'->>'baseSourceRevision'=p.base_source_revision::text
   AND whaleu_community.rating_scoped_category_source_current(over.id,over.revision,over.payload->'reviewEnvelope'),false) THEN RETURN NULL;END IF;
  base:=base||(over.payload->'reviewEnvelope'->'body');
  END IF;
 END IF;
 IF life_count=1 THEN
  SELECT s.* INTO life FROM whaleu_ratings.scoped_source_heads h JOIN whaleu_ratings.scoped_source_attestations s ON (s.id,s.revision)=(h.source_id,h.source_revision)
  WHERE s.source_kind='scoped_category_lifecycle' AND scope=ANY(s.scope_keys) AND s.payload->>'categoryId'=p.category_id::text;
  IF NOT coalesce(whaleu_ratings.scoped_source_current(life.id,life.revision,clock_timestamp()) AND jsonb_typeof(life.payload->'active')='boolean' AND jsonb_typeof(life.payload->'hidden')='boolean'
   AND life.payload->>'baseSourceId'=p.base_source_id::text AND life.payload->>'baseSourceRevision'=p.base_source_revision::text,false) THEN RETURN NULL;END IF;
  base:=base||jsonb_build_object('active',life.payload->'active','hidden',life.payload->'hidden');
 END IF;
 IF order_count=1 THEN
  SELECT s.* INTO ordering FROM whaleu_ratings.scoped_source_heads h JOIN whaleu_ratings.scoped_source_attestations s ON (s.id,s.revision)=(h.source_id,h.source_revision)
  WHERE s.source_kind='scoped_category_order' AND scope=ANY(s.scope_keys) AND s.payload->>'categoryId'=p.category_id::text;
  IF NOT coalesce(whaleu_ratings.scoped_source_current(ordering.id,ordering.revision,clock_timestamp()) AND ordering.payload->>'ordinal' ~ '^(0|[1-9][0-9]{0,18})$'
   AND ordering.payload->>'baseSourceId'=p.base_source_id::text AND ordering.payload->>'baseSourceRevision'=p.base_source_revision::text,false) THEN RETURN NULL;END IF;
  base:=base||jsonb_build_object('ordinal',ordering.payload->>'ordinal');
 END IF;
 RETURN jsonb_build_object('body',base,'baseSourceId',p.base_source_id,'baseSourceRevision',p.base_source_revision,'overrideSourceId',over.id,'overrideSourceRevision',over.revision,
  'lifecycleSourceId',life.id,'lifecycleSourceRevision',life.revision,'orderSourceId',ordering.id,'orderSourceRevision',ordering.revision,'placementRevision',p.placement_revision);
END $$;
CREATE OR REPLACE FUNCTION whaleu_ratings.scoped_placement_source_causal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s whaleu_ratings.scoped_source_attestations;category whaleu_ratings.category_scope_placements;target whaleu_ratings.target_scope_placements;rows integer;key text;logical text;expected jsonb;affected_keys text[];
BEGIN
 IF TG_TABLE_NAME='scoped_source_attestations' THEN s:=NEW;
 ELSIF TG_TABLE_NAME='scoped_source_heads' THEN SELECT * INTO s FROM whaleu_ratings.scoped_source_attestations WHERE id=NEW.source_id AND revision=NEW.source_revision;
 ELSE SELECT * INTO s FROM whaleu_ratings.scoped_source_attestations WHERE id=NEW.source_id AND revision=NEW.source_revision;END IF;
 IF NOT coalesce(s.publication_transaction=pg_current_xact_id(),false) THEN RAISE EXCEPTION 'Scoped source artifact cannot be added to historical issuance' USING ERRCODE='23514';END IF;
 IF s.source_kind='scoped_category_scope' AND s.issuer='ratings-category-management' AND s.payload->>'action'='retired' THEN
  IF EXISTS(SELECT 1 FROM whaleu_ratings.category_scope_placements WHERE source_id=s.id AND source_revision=s.revision) OR s.payload->'authorizedExit'<>'true'::jsonb THEN RAISE EXCEPTION 'Retired category scope cannot invent replacement placement' USING ERRCODE='23514';END IF;
 ELSIF s.source_kind='scoped_category_scope' THEN
  SELECT count(*) INTO rows FROM whaleu_ratings.category_scope_placements WHERE source_id=s.id AND source_revision=s.revision;
  SELECT * INTO category FROM whaleu_ratings.category_scope_placements WHERE source_id=s.id AND source_revision=s.revision;
  IF NOT coalesce(rows=1 AND category.publication_transaction=s.publication_transaction AND category.scope_keys=s.scope_keys
   AND s.payload->>'categoryId'=category.category_id::text AND s.payload->>'baseSourceId'=category.base_source_id::text AND s.payload->>'baseSourceRevision'=category.base_source_revision::text
   AND s.payload->>'placementRevision'=category.placement_revision::text AND s.payload->'scopeKeys'=to_jsonb(category.scope_keys)
   AND s.scope_keys=CASE WHEN s.payload->'placement'->>'kind'='global' THEN ARRAY['global'] ELSE ARRAY(SELECT 'campus:'||value FROM jsonb_array_elements_text(s.payload->'placement'->'campusIds') ORDER BY value) END,false)
  THEN RAISE EXCEPTION 'Category placement requires its exact fresh scope issuance' USING ERRCODE='23514';END IF;
  -- A placed base must be in every dependent scope's exact source vector.
  -- Merely naming a reviewed foreign-scope base cannot widen its authority or
  -- hide that dependency from adopted-source reverse publication checks.
  IF NOT EXISTS(SELECT 1 FROM whaleu_ratings.scoped_source_attestations base
   WHERE (base.id,base.revision)=(category.base_source_id,category.base_source_revision) AND category.scope_keys<@base.scope_keys)
  THEN RAISE EXCEPTION 'Category placement exceeds its exact base source scope' USING ERRCODE='23514';END IF;
 ELSIF s.source_kind='scoped_target_placement' THEN
  SELECT count(*) INTO rows FROM whaleu_ratings.target_scope_placements WHERE source_id=s.id AND source_revision=s.revision;
  SELECT * INTO target FROM whaleu_ratings.target_scope_placements WHERE source_id=s.id AND source_revision=s.revision;
  IF NOT coalesce(rows=1 AND target.publication_transaction=s.publication_transaction AND target.scope_keys=s.scope_keys AND s.payload->>'targetId'=target.target_id::text
   AND EXISTS(SELECT 1 FROM whaleu_ratings.targets t WHERE t.id=target.target_id AND t.category_id::text=s.payload->>'categoryId'
    AND NOT EXISTS(SELECT 1 FROM unnest(s.scope_keys) k LEFT JOIN whaleu_campus.campus_region_assignments a ON k='campus:'||a.campus_id::text WHERE t.region_id IS NOT NULL AND (k='global' OR a.operating_region_id IS DISTINCT FROM t.region_id))),false)
  THEN RAISE EXCEPTION 'Target placement cannot infer/move target origin or category' USING ERRCODE='23514';END IF;
 ELSIF TG_TABLE_NAME IN ('category_scope_placements','target_scope_placements') THEN
  RAISE EXCEPTION 'Placement must use its registered typed source owner' USING ERRCODE='23514';
 END IF;
 IF s.issuer='ratings-category-management' THEN
  PERFORM whaleu_ratings.verify_scoped_command((s.payload->'management'->>'accountId')::uuid,(s.payload->'management'->>'requestId')::uuid);
 END IF;
 IF s.issuer='ratings-native-command' THEN
  IF NOT coalesce(s.source_kind IN ('scoped_target_placement','scope_absence') AND s.payload ? 'nativeCommand',false) THEN RAISE EXCEPTION 'Native source requires exact registered derivative' USING ERRCODE='23514';END IF;
  PERFORM whaleu_ratings.verify_scoped_command((s.payload->'nativeCommand'->>'accountId')::uuid,(s.payload->'nativeCommand'->>'requestId')::uuid);
 END IF;
 -- Once adopted, even a zero-member scope is part of the atomic publication.
 -- Staging new inputs alone is allowed only before runtime activation.
 affected_keys:=s.scope_keys;
 IF TG_TABLE_NAME='scoped_source_heads' AND TG_OP='UPDATE' THEN
  SELECT ARRAY(SELECT DISTINCT key_value COLLATE "C" FROM unnest(s.scope_keys||previous_source.scope_keys) key_value ORDER BY 1) INTO affected_keys FROM whaleu_ratings.scoped_source_attestations previous_source WHERE previous_source.id=OLD.source_id AND previous_source.revision=OLD.source_revision;
 END IF;
 FOREACH key IN ARRAY affected_keys LOOP
  IF key='global' THEN logical:='global';ELSE SELECT operating_region_id::text INTO logical FROM whaleu_campus.campus_region_assignments WHERE campus_id=substring(key from 8)::uuid;END IF;
  IF EXISTS(SELECT 1 FROM whaleu_ratings.scope_protocol_heads h JOIN whaleu_ratings.scope_protocol_versions p ON p.id=h.version_id WHERE h.logical_scope_key=logical AND p.phase='adopted')
   AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.scoped_catalog_heads h JOIN whaleu_ratings.scoped_catalogs c ON c.id=h.catalog_id JOIN whaleu_ratings.scoped_releases r ON r.id=c.release_id WHERE h.scope_key=key AND r.publication_transaction=pg_current_xact_id() AND c.source_vector=whaleu_ratings.scoped_current_source_vector(ARRAY[key]))
  THEN RAISE EXCEPTION 'Adopted source change requires complete atomic scoped publication' USING ERRCODE='23514';END IF;
 END LOOP;
 RETURN NULL;
END $$;
CREATE FUNCTION whaleu_community.verify_rating_scoped_source_binding_pre_category(_source uuid,_revision uuid) RETURNS void LANGUAGE plpgsql AS $$
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
CREATE OR REPLACE FUNCTION whaleu_community.verify_rating_scoped_source_binding(_source uuid,_revision uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE s whaleu_ratings.scoped_source_attestations;
BEGIN
 SELECT * INTO s FROM whaleu_ratings.scoped_source_attestations WHERE id=_source AND revision=_revision;
 IF s.issuer='ratings-category-management' AND s.source_kind='scoped_category_override' AND s.payload->>'action'='inherit' THEN
  IF s.publication_transaction<>pg_current_xact_id() OR s.payload ? 'reviewEnvelope' OR s.payload ? 'issuanceDigest' OR s.payload->'modes'<>jsonb_build_object('name',jsonb_build_object('mode','inherit'),'description',jsonb_build_object('mode','inherit')) OR EXISTS(SELECT 1 FROM whaleu_community.rating_scoped_category_source_bindings WHERE source_id=_source AND source_revision=_revision) THEN RAISE EXCEPTION 'Inheritance reset is exact metadata, never fabricated Review' USING ERRCODE='23514';END IF;
  PERFORM whaleu_ratings.verify_scoped_command((s.payload->'management'->>'accountId')::uuid,(s.payload->'management'->>'requestId')::uuid);
 ELSE PERFORM whaleu_community.verify_rating_scoped_source_binding_pre_category(_source,_revision);END IF;
END $$;
CREATE FUNCTION whaleu_ratings.category_scope_eligible(category uuid,scope text) RETURNS boolean LANGUAGE sql STABLE AS $$
 WITH RECURSIVE path AS (
 SELECT p.category_id,whaleu_ratings.scoped_base_category(p.base_source_id,p.base_source_revision) body,1 depth FROM whaleu_ratings.category_scope_placements p WHERE p.category_id=category AND scope=ANY(p.scope_keys) AND whaleu_ratings.scoped_source_current(p.source_id,p.source_revision,clock_timestamp())
 UNION ALL SELECT p.category_id,whaleu_ratings.scoped_base_category(p.base_source_id,p.base_source_revision),path.depth+1 FROM path JOIN whaleu_ratings.category_scope_placements p ON p.category_id=(path.body->>'parentId')::uuid WHERE path.depth<3 AND scope=ANY(p.scope_keys) AND whaleu_ratings.scoped_source_current(p.source_id,p.source_revision,clock_timestamp())
 ) SELECT coalesce((SELECT count(*)>0 AND count(*)<=3 AND count(*)=count(DISTINCT category_id) AND bool_and(body IS NOT NULL) AND count(*) FILTER(WHERE body->'parentId'='null'::jsonb)=1 FROM path),false)
$$;
CREATE OR REPLACE FUNCTION whaleu_ratings.verify_scoped_catalog(catalog uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE c whaleu_ratings.scoped_catalogs;r whaleu_ratings.scoped_releases;coverage whaleu_ratings.scoped_source_attestations;expected_ids jsonb;actual_ids jsonb;row_count integer;digest text;item record;expected jsonb;body jsonb;
BEGIN
 SELECT * INTO c FROM whaleu_ratings.scoped_catalogs WHERE id=catalog;SELECT * INTO r FROM whaleu_ratings.scoped_releases WHERE id=c.release_id;
 IF NOT coalesce(c.sealed AND c.publication_transaction=pg_current_xact_id() AND r.publication_transaction=pg_current_xact_id()
  AND c.scope_key=ANY(r.affected_scope_keys) AND c.source_vector=whaleu_ratings.scoped_current_source_vector(ARRAY[c.scope_key])
  AND (c.scope_key='global' OR EXISTS(SELECT 1 FROM whaleu_campus.campus_region_assignments assignment WHERE assignment.campus_id=c.campus_id AND assignment.operating_region_id=c.region_id))
  AND c.source_digest=whaleu_ratings.scoped_digest('vector',c.source_vector) AND c.effective_at<=clock_timestamp() AND c.valid_until>clock_timestamp(),false)
 THEN RAISE EXCEPTION 'Scoped catalog needs current complete fresh release' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(c.source_vector) s WHERE NOT whaleu_ratings.scoped_source_current((s->>'id')::uuid,(s->>'revision')::uuid,clock_timestamp()))
 THEN RAISE EXCEPTION 'Scoped catalog includes unknown source' USING ERRCODE='23514';END IF;
 SELECT s.* INTO coverage FROM whaleu_ratings.scoped_source_heads h JOIN whaleu_ratings.scoped_source_attestations s ON (s.id,s.revision)=(h.source_id,h.source_revision)
 WHERE h.source_kind='scope_absence' AND h.source_key=c.scope_key AND s.scope_keys=ARRAY[c.scope_key];
 IF NOT coalesce(whaleu_ratings.scoped_source_current(coverage.id,coverage.revision,clock_timestamp()) AND coverage.payload->'complete'='true'::jsonb
  AND jsonb_typeof(coverage.payload->'categoryIds')='array' AND jsonb_typeof(coverage.payload->'targetIds')='array' AND jsonb_typeof(coverage.payload->'legacyCatalogIds')='array',false)
 THEN RAISE EXCEPTION 'Unknown source domain is never an empty catalog' USING ERRCODE='23514';END IF;
 SELECT coalesce(jsonb_agg(category_id ORDER BY category_id),'[]'::jsonb) INTO expected_ids FROM whaleu_ratings.category_scope_placements p
 WHERE c.scope_key=ANY(p.scope_keys) AND whaleu_ratings.scoped_source_current(p.source_id,p.source_revision,clock_timestamp());
 SELECT coalesce(jsonb_agg(category_id ORDER BY category_id),'[]'::jsonb),count(*) INTO actual_ids,row_count FROM whaleu_ratings.scoped_categories WHERE catalog_id=catalog;
 IF actual_ids IS DISTINCT FROM expected_ids OR actual_ids IS DISTINCT FROM coverage.payload->'categoryIds' OR row_count<>c.category_count
 THEN RAISE EXCEPTION 'Scoped category domain is incomplete or ambiguous' USING ERRCODE='23514';END IF;
 FOR item IN SELECT a.*,l.identity_kind,l.identity_id,l.base_source_id,l.base_source_revision,l.override_source_id,l.override_source_revision,l.lifecycle_source_id,l.lifecycle_source_revision,l.order_source_id,l.order_source_revision,l.placement_revision,l.proof
 FROM whaleu_ratings.scoped_categories a LEFT JOIN whaleu_ratings.scoped_category_lineage l ON (l.catalog_id,l.category_id,l.effective_revision)=(a.catalog_id,a.category_id,a.effective_revision) WHERE a.catalog_id=catalog LOOP
  expected:=whaleu_ratings.scoped_expected_category(item.placement_revision,c.scope_key);body:=expected->'body';
  IF expected IS NULL OR item.proof IS DISTINCT FROM expected OR item.effective_digest<>whaleu_ratings.scoped_digest('effective',expected)
   OR jsonb_build_object('id',item.category_id,'parentId',item.parent_id,'level',item.level,'kind',item.kind,'systemKey',item.system_key,'isSystem',item.is_system,'originKind',item.origin_kind,'name',item.name,'description',item.description,'active',item.active,'hidden',item.hidden,'ordinal',item.ordinal::text,'identityKind',item.identity_kind,'identityId',item.identity_id) IS DISTINCT FROM body
   OR jsonb_build_array(item.base_source_id,item.base_source_revision,item.override_source_id,item.override_source_revision,item.lifecycle_source_id,item.lifecycle_source_revision,item.order_source_id,item.order_source_revision)
    IS DISTINCT FROM jsonb_build_array(expected->'baseSourceId',expected->'baseSourceRevision',expected->'overrideSourceId',expected->'overrideSourceRevision',expected->'lifecycleSourceId',expected->'lifecycleSourceRevision',expected->'orderSourceId',expected->'orderSourceRevision')
   OR (item.parent_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.scoped_categories parent WHERE parent.catalog_id=catalog AND parent.category_id=item.parent_id AND parent.level+1=item.level AND parent.kind=item.kind))
  THEN RAISE EXCEPTION 'Scoped effective row lacks exact composed lineage' USING ERRCODE='23514';END IF;
 END LOOP;
 SELECT whaleu_ratings.scoped_digest('categories',coalesce(jsonb_agg(jsonb_build_object('revision',a.effective_revision,'digest',a.effective_digest,'expected',l.proof) ORDER BY a.ordinal),'[]'::jsonb)) INTO digest
 FROM whaleu_ratings.scoped_categories a JOIN whaleu_ratings.scoped_category_lineage l ON (l.catalog_id,l.category_id)=(a.catalog_id,a.category_id) WHERE a.catalog_id=catalog;
 IF digest<>c.category_digest THEN RAISE EXCEPTION 'Scoped category digest mismatch' USING ERRCODE='23514';END IF;
 -- Category rows above already form the exact complete placement/lineage set.
 -- Evaluate their current ancestry once per distinct category, not once for each
 -- target in a large pool. Both MATERIALIZED boundaries are intentional: the
 -- same exact eligibility proof must not be inlined into a per-target predicate.
 WITH category_candidates AS MATERIALIZED (
 SELECT category_id FROM whaleu_ratings.scoped_categories WHERE catalog_id=catalog
 ), eligible_categories AS MATERIALIZED (
 SELECT category_id FROM category_candidates WHERE whaleu_ratings.category_scope_eligible(category_id,c.scope_key)
 ) SELECT coalesce(jsonb_agg(p.target_id ORDER BY p.target_id),'[]'::jsonb) INTO expected_ids
 FROM whaleu_ratings.target_scope_placements p JOIN whaleu_ratings.targets target ON target.id=p.target_id
 JOIN eligible_categories eligible ON eligible.category_id=target.category_id
 WHERE c.scope_key=ANY(p.scope_keys) AND whaleu_ratings.scoped_source_current(p.source_id,p.source_revision,clock_timestamp());
 SELECT coalesce(jsonb_agg(target_id ORDER BY target_id),'[]'::jsonb),count(*) INTO actual_ids,row_count FROM whaleu_ratings.scoped_target_memberships WHERE catalog_id=catalog;
 IF actual_ids IS DISTINCT FROM expected_ids OR actual_ids IS DISTINCT FROM coverage.payload->'targetIds' OR row_count<>c.membership_count
 THEN RAISE EXCEPTION 'Scoped target placement set incomplete or ambiguous' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM whaleu_ratings.scoped_target_memberships m JOIN whaleu_ratings.targets t ON t.id=m.target_id
  JOIN whaleu_ratings.target_scope_placements p ON (p.placement_revision,p.target_id)=(m.placement_revision,m.target_id)
  WHERE m.catalog_id=catalog AND (m.category_id<>t.category_id OR NOT c.scope_key=ANY(p.scope_keys) OR NOT whaleu_ratings.scoped_source_current(p.source_id,p.source_revision,clock_timestamp())))
 THEN RAISE EXCEPTION 'Scoped target membership is not exact placement' USING ERRCODE='23514';END IF;
 SELECT whaleu_ratings.scoped_digest('memberships',coalesce(jsonb_agg(jsonb_build_object('targetId',target_id,'categoryId',category_id,'placementRevision',placement_revision,'ordinal',ordinal::text) ORDER BY ordinal),'[]'::jsonb)) INTO digest FROM whaleu_ratings.scoped_target_memberships WHERE catalog_id=catalog;
 IF digest<>c.membership_digest THEN RAISE EXCEPTION 'Scoped membership digest mismatch' USING ERRCODE='23514';END IF;
 IF NOT whaleu_ratings.scoped_membership_order_valid(catalog) THEN RAISE EXCEPTION 'Scoped membership order must retain before ordinals and append canonical new IDs' USING ERRCODE='23514';END IF;
 -- Any native bridge from a mixed legacy catalog carries the full legacy set.
 -- A known native subset cannot erase unknown opaque categories or targets.
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(c.source_vector) v JOIN whaleu_ratings.scoped_source_attestations s ON s.id=(v->>'id')::uuid
  WHERE s.source_kind='m3a_native_bridge' AND s.issuer<>'ratings-legacy-bridge' AND NOT coverage.payload->'legacyCatalogIds' @> jsonb_build_array(s.payload->'legacyCatalogId'))
 OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(coverage.payload->'legacyCatalogIds') legacy(id) JOIN whaleu_ratings.categories old ON old.catalog_id=legacy.id::uuid
  WHERE NOT EXISTS(SELECT 1 FROM whaleu_ratings.category_scope_placements p JOIN whaleu_ratings.scoped_source_attestations src ON (src.id,src.revision)=(p.base_source_id,p.base_source_revision)
   WHERE p.category_id=old.id AND whaleu_ratings.scoped_source_current(p.source_id,p.source_revision,clock_timestamp()) AND whaleu_ratings.scoped_source_current(src.id,src.revision,clock_timestamp())
    AND ((src.issuer='ratings-category-management' AND src.source_kind='scoped_category_base' AND EXISTS(SELECT 1 FROM whaleu_ratings.scoped_source_attestations original WHERE (original.id,original.revision)=((src.payload->>'originSourceId')::uuid,(src.payload->>'originSourceRevision')::uuid) AND ((original.source_kind='m3a_native_bridge' AND coalesce(original.payload->>'legacyCatalogId',original.payload->>'legacyAfterCatalogId')=legacy.id AND original.payload->>'categoryId'=old.id::text) OR (original.source_kind='legacy_adoption' AND EXISTS(SELECT 1 FROM whaleu_ratings.scoped_adoption_identities ai JOIN whaleu_ratings.legacy_adoption_manifests am ON am.id=ai.manifest_id WHERE ai.id=(original.payload->>'identityId')::uuid AND am.legacy_catalog_id=old.catalog_id AND ai.legacy_business_id=old.id)))))
     OR (src.source_kind='m3a_native_bridge' AND src.payload->>'legacyCatalogId'=legacy.id AND src.payload->>'categoryRevision'=old.revision::text)
     OR (src.source_kind='legacy_adoption' AND EXISTS(SELECT 1 FROM whaleu_ratings.scoped_adoption_identities ai JOIN whaleu_ratings.legacy_adoption_manifests am ON am.id=ai.manifest_id WHERE ai.id=(src.payload->>'identityId')::uuid AND am.legacy_catalog_id=old.catalog_id AND ai.legacy_business_id=old.id)))))
 THEN RAISE EXCEPTION 'Mixed legacy category source set is unresolved' USING ERRCODE='23514';END IF;
END $$;
CREATE OR REPLACE FUNCTION whaleu_ratings.verify_scoped_release(release uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r whaleu_ratings.scoped_releases;keys text[];item record;nodes bigint;members bigint;bytes bigint;
BEGIN
 SELECT * INTO r FROM whaleu_ratings.scoped_releases WHERE id=release;
 SELECT array_agg(scope_key ORDER BY scope_key COLLATE "C") INTO keys FROM whaleu_ratings.scoped_release_scopes WHERE release_id=release;
 IF NOT coalesce(r.publication_transaction=pg_current_xact_id() AND r.published_at<=clock_timestamp() AND r.valid_until>clock_timestamp() AND keys=r.affected_scope_keys
  AND r.source_vector=whaleu_ratings.scoped_current_source_vector(r.affected_scope_keys)
  AND r.negative_digest=whaleu_ratings.scoped_digest('negative',jsonb_build_object('inventory',r.cause->'inventoryFingerprint','sources',r.source_vector)),false)
 THEN RAISE EXCEPTION 'Release affected set or exact source vector incomplete' USING ERRCODE='23514';END IF;
 SELECT coalesce(sum(category_count),0),coalesce(sum(membership_count),0) INTO nodes,members FROM whaleu_ratings.scoped_catalogs WHERE release_id=release;
 SELECT coalesce(sum(octet_length(whaleu_ratings.creation_canonical_json(to_jsonb(x)))),0) INTO bytes FROM (
  SELECT to_jsonb(a) value FROM whaleu_ratings.scoped_categories a JOIN whaleu_ratings.scoped_catalogs c ON c.id=a.catalog_id WHERE c.release_id=release
  UNION ALL SELECT to_jsonb(a) FROM whaleu_ratings.scoped_category_lineage a JOIN whaleu_ratings.scoped_catalogs c ON c.id=a.catalog_id WHERE c.release_id=release
  UNION ALL SELECT to_jsonb(a) FROM whaleu_ratings.scoped_target_memberships a JOIN whaleu_ratings.scoped_catalogs c ON c.id=a.catalog_id WHERE c.release_id=release
  UNION ALL SELECT to_jsonb(s) FROM whaleu_ratings.scoped_source_attestations s JOIN jsonb_array_elements(r.source_vector) v ON s.id=(v->>'id')::uuid
 ) x;
 IF nodes>100000 OR members>100000 OR bytes>67108864 THEN RAISE EXCEPTION 'Scoped whole-release admission exceeded' USING ERRCODE='23514';END IF;
 FOR item IN SELECT s.*,h.catalog_id current_catalog,h.head_revision current_head,c.release_id catalog_release FROM whaleu_ratings.scoped_release_scopes s
  LEFT JOIN whaleu_ratings.scoped_catalog_heads h ON h.scope_key=s.scope_key LEFT JOIN whaleu_ratings.scoped_catalogs c ON c.id=s.after_catalog_id WHERE s.release_id=release LOOP
  IF (item.current_catalog,item.current_head,item.catalog_release) IS DISTINCT FROM (item.after_catalog_id,item.after_head_revision,release)
  THEN RAISE EXCEPTION 'Scoped release lacks its atomic current head' USING ERRCODE='23514';END IF;
  PERFORM whaleu_ratings.verify_scoped_catalog(item.after_catalog_id);
 END LOOP;
 -- Each cause-specific verifier is installed by 0064/0065; no labels authorize.
 IF r.cause_kind='legacy_bridge' THEN PERFORM whaleu_ratings.verify_legacy_scoped_bridge((r.cause->>'accountId')::uuid,(r.cause->>'requestId')::uuid);
 ELSIF r.cause_kind IN ('create_target_scoped','category_management') THEN PERFORM whaleu_ratings.verify_scoped_command((r.cause->>'accountId')::uuid,(r.cause->>'requestId')::uuid);
 ELSIF r.cause_kind='protocol_activation' THEN PERFORM whaleu_ratings.verify_scope_activation(release);
 ELSIF NOT coalesce(r.cause_kind='source_release' AND r.cause->>'sourceDigest'=r.source_digest AND EXISTS(SELECT 1 FROM whaleu_ratings.scoped_source_attestations s WHERE s.id=(r.cause->>'issuanceSourceId')::uuid AND s.revision=(r.cause->>'issuanceSourceRevision')::uuid AND r.affected_scope_keys<@s.scope_keys AND whaleu_ratings.scoped_source_current(s.id,s.revision,clock_timestamp())),false) THEN RAISE EXCEPTION 'Unknown scoped release cause' USING ERRCODE='23514';END IF;
 -- Installed by 0065. Whole-set compatibility publication is a release
 -- obligation, including ordinary source releases in already adopted domains.
 PERFORM whaleu_ratings.verify_scoped_release_compat(release);
END $$;
