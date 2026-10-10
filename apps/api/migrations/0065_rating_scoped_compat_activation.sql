-- Typed compatibility and atomic protocol activation. This migration installs
-- validators only: no sources, capabilities, adoption or live heads are seeded.
SET LOCAL lock_timeout='5s';
SELECT pg_advisory_xact_lock(hashtextextended('whaleu:named-block-policy:v1',0));

CREATE UNIQUE INDEX scoped_compat_one_version_per_release ON whaleu_ratings.compat_versions(release_id,compat_key);
CREATE UNIQUE INDEX scoped_protocol_one_version_per_release ON whaleu_ratings.scope_protocol_versions(release_id,logical_scope_key) WHERE release_id IS NOT NULL;

-- A projection manifest must precede its output so the existing INSERT triggers
-- can identify its real type without manufacturing an opaque intermediate row.
ALTER TABLE whaleu_ratings.compat_versions ALTER CONSTRAINT compat_versions_legacy_catalog_id_fkey DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE whaleu_ratings.compat_projection_manifests ALTER CONSTRAINT compat_projection_manifests_after_catalog_id_fkey DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE whaleu_ratings.catalog_materializations ADD COLUMN compat_projection_id uuid REFERENCES whaleu_ratings.compat_projection_manifests(id);
ALTER TABLE whaleu_ratings.catalog_category_lineage ADD COLUMN compat_projection_id uuid REFERENCES whaleu_ratings.compat_projection_manifests(id);
ALTER TABLE whaleu_ratings.catalog_materializations DROP CONSTRAINT catalog_materializations_source_kind_check;
ALTER TABLE whaleu_ratings.catalog_materializations DROP CONSTRAINT catalog_materializations_check;
ALTER TABLE whaleu_ratings.catalog_materializations ADD CONSTRAINT catalog_materializations_source_kind_check CHECK(source_kind IN ('opaque','category_release','target_create','compat_projection'));
ALTER TABLE whaleu_ratings.catalog_materializations ADD CONSTRAINT catalog_materializations_typed_source CHECK(
 (compat_projection_id IS NULL AND ((source_kind='opaque' AND release_id IS NULL AND before_catalog_id IS NULL AND target_id IS NULL AND topology_snapshot_id IS NULL AND campus_ids='{}'::uuid[])
 OR (source_kind='category_release' AND release_id IS NOT NULL AND target_id IS NULL AND topology_snapshot_id IS NOT NULL)
 OR (source_kind='target_create' AND release_id IS NULL AND before_catalog_id IS NOT NULL AND target_id IS NOT NULL)))
 OR (source_kind='compat_projection' AND compat_projection_id IS NOT NULL AND release_id IS NULL AND target_id IS NULL));
ALTER TABLE whaleu_ratings.catalog_category_lineage DROP CONSTRAINT catalog_category_lineage_source_kind_check;
ALTER TABLE whaleu_ratings.catalog_category_lineage DROP CONSTRAINT catalog_category_lineage_check;
ALTER TABLE whaleu_ratings.catalog_category_lineage ADD CONSTRAINT catalog_category_lineage_source_kind_check CHECK(source_kind IN ('opaque','native','compat_effective'));
ALTER TABLE whaleu_ratings.catalog_category_lineage ADD CONSTRAINT catalog_category_lineage_typed_source CHECK(
 (compat_projection_id IS NULL AND ((source_kind='opaque' AND base_revision IS NULL AND scope_version_id IS NULL AND topology_snapshot_id IS NULL)
 OR (source_kind='native' AND base_revision IS NOT NULL AND scope_version_id IS NOT NULL AND topology_snapshot_id IS NOT NULL)))
 OR (source_kind='compat_effective' AND compat_projection_id IS NOT NULL AND base_revision IS NULL AND scope_version_id IS NULL));

CREATE FUNCTION whaleu_ratings.scoped_catalog_body(catalog uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object('categories',coalesce((SELECT jsonb_agg(jsonb_build_object('id',category_id,'parentId',parent_id,'level',level,'kind',kind,'systemKey',system_key,'originKind',origin_kind,'name',name,'description',description,'active',active,'hidden',hidden,'ordinal',ordinal::text) ORDER BY ordinal) FROM whaleu_ratings.scoped_categories WHERE catalog_id=catalog),'[]'::jsonb),
 'memberships',coalesce((SELECT jsonb_agg(jsonb_build_object('targetId',target_id,'categoryId',category_id,'ordinal',ordinal::text) ORDER BY ordinal) FROM whaleu_ratings.scoped_target_memberships WHERE catalog_id=catalog),'[]'::jsonb))
$$;
CREATE FUNCTION whaleu_ratings.legacy_catalog_body(catalog uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object('categories',coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'parentId',parent_id,'level',level,'kind',kind,'systemKey',system_key,'originKind',origin_kind,'name',name,'description',description,'active',active,'hidden',hidden,'ordinal',ordinal::text) ORDER BY ordinal) FROM whaleu_ratings.categories WHERE catalog_id=catalog),'[]'::jsonb),
 'memberships',coalesce((SELECT jsonb_agg(jsonb_build_object('targetId',target_id,'categoryId',category_id,'ordinal',ordinal::text) ORDER BY ordinal) FROM whaleu_ratings.target_memberships WHERE catalog_id=catalog),'[]'::jsonb))
$$;
CREATE FUNCTION whaleu_ratings.scoped_compat_scope_keys(v whaleu_ratings.compat_versions) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE WHEN v.kind='global_compat' THEN ARRAY['global'] ELSE ARRAY(SELECT 'campus:'||id::text FROM unnest(v.campus_ids) id ORDER BY id) END
$$;
CREATE FUNCTION whaleu_ratings.scoped_head_tuples(keys text[]) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('scopeKey',key,'catalogId',h.catalog_id,'headRevision',h.head_revision,'releaseId',h.release_id) ORDER BY key COLLATE "C"),'[]'::jsonb)
 FROM unnest(keys) key LEFT JOIN whaleu_ratings.scoped_catalog_heads h ON h.scope_key=key
$$;
CREATE FUNCTION whaleu_ratings.scoped_compat_domain_current(v whaleu_ratings.compat_versions) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE regions jsonb;campuses uuid[];
BEGIN
 IF v.kind='global_compat' THEN RETURN v.compat_key='global_compat' AND v.region_id IS NULL AND v.campus_ids='{}'::uuid[];END IF;
 regions:=whaleu_ratings.category_topology_regions(v.topology_snapshot_id,v.region_id);
 IF regions IS NULL THEN RETURN false;END IF;
 SELECT coalesce(array_agg(id::uuid ORDER BY id::uuid),'{}'::uuid[]) INTO campuses FROM jsonb_array_elements(regions) r CROSS JOIN LATERAL jsonb_array_elements_text(r->'campusIds') id;
 RETURN cardinality(campuses)>0 AND campuses=v.campus_ids;
END $$;
CREATE FUNCTION whaleu_ratings.scoped_compat_state(v whaleu_ratings.compat_versions) RETURNS text LANGUAGE plpgsql STABLE AS $$
DECLARE keys text[]:=whaleu_ratings.scoped_compat_scope_keys(v);entry jsonb;body jsonb;first_body jsonb;differs boolean:=false;
BEGIN
 IF NOT whaleu_ratings.scoped_compat_domain_current(v) OR cardinality(keys)=0 OR cardinality(keys)>1001
 OR v.scoped_tuples IS DISTINCT FROM whaleu_ratings.scoped_head_tuples(keys)
 OR v.source_digest IS DISTINCT FROM whaleu_ratings.scoped_digest('vector',whaleu_ratings.scoped_current_source_vector(keys))
 THEN RETURN 'unresolved';END IF;
 FOR entry IN SELECT value FROM jsonb_array_elements(v.scoped_tuples) LOOP
  IF NOT whaleu_ratings.scoped_catalog_current((entry->>'catalogId')::uuid,clock_timestamp()) THEN RETURN 'unresolved';END IF;
  -- Review parity includes hidden/inactive category bodies, not only the public
  -- leaves. A withdrawn source cannot become compatible by hiding its output.
  IF EXISTS(SELECT 1 FROM whaleu_ratings.scoped_category_lineage l WHERE l.catalog_id=(entry->>'catalogId')::uuid
   AND whaleu_ratings.scoped_expected_category(l.placement_revision,entry->>'scopeKey') IS DISTINCT FROM l.proof) THEN RETURN 'unresolved';END IF;
  body:=whaleu_ratings.scoped_catalog_body((entry->>'catalogId')::uuid);
  IF first_body IS NULL THEN first_body:=body;ELSIF body<>first_body THEN differs:=true;END IF;
 END LOOP;RETURN CASE WHEN differs THEN 'divergent' ELSE 'equal' END;
END $$;
CREATE FUNCTION whaleu_ratings.scoped_compat_current(version uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT coalesce((SELECT v.state='equal' AND v.valid_until>clock_timestamp() AND whaleu_ratings.scoped_compat_state(v)='equal'
 AND whaleu_ratings.legacy_catalog_body(v.legacy_catalog_id)=whaleu_ratings.scoped_catalog_body((v.scoped_tuples->0->>'catalogId')::uuid)
 AND EXISTS(SELECT 1 FROM whaleu_ratings.catalog_heads h WHERE h.scope_key=coalesce(v.region_id::text,'global') AND h.catalog_id=v.legacy_catalog_id)
 FROM whaleu_ratings.compat_versions v JOIN whaleu_ratings.compat_heads h ON (h.version_id,h.compat_key)=(v.id,v.compat_key) WHERE v.id=version),false)
$$;
CREATE FUNCTION whaleu_ratings.compat_projection_sources_complete(manifest uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT coalesce((SELECT c.sealed AND m.source_kind='compat_projection' AND m.compat_projection_id=p.id AND p.after_catalog_id=c.id
 AND whaleu_ratings.legacy_catalog_body(c.id)=whaleu_ratings.scoped_catalog_body((v.scoped_tuples->0->>'catalogId')::uuid)
 AND NOT EXISTS((SELECT id FROM whaleu_ratings.categories WHERE catalog_id=c.id EXCEPT SELECT category_id FROM whaleu_ratings.compat_projection_lineage WHERE manifest_id=p.id)
 UNION ALL (SELECT category_id FROM whaleu_ratings.compat_projection_lineage WHERE manifest_id=p.id EXCEPT SELECT id FROM whaleu_ratings.categories WHERE catalog_id=c.id))
 AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.categories a LEFT JOIN whaleu_ratings.catalog_category_lineage l ON (l.catalog_id,l.category_id)=(a.catalog_id,a.id)
 LEFT JOIN whaleu_ratings.compat_projection_lineage own ON own.manifest_id=p.id AND own.category_id=a.id
 WHERE a.catalog_id=c.id AND NOT coalesce(l.source_kind='compat_effective' AND l.compat_projection_id=p.id AND l.effective_revision=a.revision AND own.effective_revision=a.revision
 AND own.body_digest=whaleu_ratings.scoped_digest('compat-category',to_jsonb(a)-ARRAY['catalog_id','revision'])
 AND own.scoped_inputs=(SELECT jsonb_agg(jsonb_build_object('scopeKey',input->>'scopeKey','catalogId',a2.catalog_id,'effectiveRevision',a2.effective_revision,'effectiveDigest',a2.effective_digest) ORDER BY input->>'scopeKey') FROM jsonb_array_elements(v.scoped_tuples) input JOIN whaleu_ratings.scoped_categories a2 ON a2.catalog_id=(input->>'catalogId')::uuid AND a2.category_id=a.id)
 AND own.review_sources=(SELECT jsonb_agg(jsonb_build_object('scopeKey',input->>'scopeKey','proof',l2.proof) ORDER BY input->>'scopeKey') FROM jsonb_array_elements(v.scoped_tuples) input JOIN whaleu_ratings.scoped_category_lineage l2 ON l2.catalog_id=(input->>'catalogId')::uuid AND l2.category_id=a.id),false))
 FROM whaleu_ratings.compat_projection_manifests p JOIN whaleu_ratings.compat_versions v ON v.id=p.compat_version_id JOIN whaleu_ratings.catalogs c ON c.id=p.after_catalog_id JOIN whaleu_ratings.catalog_materializations m ON m.catalog_id=c.id WHERE p.id=manifest),false)
$$;
CREATE FUNCTION whaleu_ratings.verify_compat_projection(manifest uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE p whaleu_ratings.compat_projection_manifests;v whaleu_ratings.compat_versions;c whaleu_ratings.catalogs;m whaleu_ratings.catalog_materializations;expected jsonb;
BEGIN
 SELECT * INTO p FROM whaleu_ratings.compat_projection_manifests WHERE id=manifest;SELECT * INTO v FROM whaleu_ratings.compat_versions WHERE id=p.compat_version_id;
 SELECT * INTO c FROM whaleu_ratings.catalogs WHERE id=p.after_catalog_id;SELECT * INTO m FROM whaleu_ratings.catalog_materializations WHERE catalog_id=c.id;
 SELECT coalesce(jsonb_agg(jsonb_build_object('categoryId',old.id,'beforeRevision',old.revision,'afterRevision',fresh.revision,'action',CASE WHEN fresh.id IS NULL THEN 'exit' WHEN to_jsonb(old)-ARRAY['catalog_id','revision']=to_jsonb(fresh)-ARRAY['catalog_id','revision'] THEN 'retain' ELSE 'update' END) ORDER BY old.id),'[]'::jsonb) INTO expected
 FROM whaleu_ratings.categories old JOIN whaleu_ratings.catalog_category_lineage l ON (l.catalog_id,l.category_id)=(old.catalog_id,old.id)
 LEFT JOIN whaleu_ratings.categories fresh ON fresh.catalog_id=c.id AND fresh.id=old.id WHERE old.catalog_id=p.before_catalog_id AND l.source_kind IN ('native','compat_effective');
 IF NOT coalesce(p.publication_transaction=pg_current_xact_id() AND v.publication_transaction=p.publication_transaction AND m.publication_transaction=p.publication_transaction
 AND v.state='equal' AND v.legacy_catalog_id=c.id AND p.release_id=v.release_id AND p.source_digest=v.source_digest AND p.projection_digest=v.equality_digest
 AND c.region_id IS NOT DISTINCT FROM v.region_id AND c.coverage='complete' AND c.provenance='accepted' AND c.source_reference='rating-scoped-compat:'||p.id::text
 AND c.policy_reference='ratings-scoped-compat-v1' AND c.effective_at<=clock_timestamp() AND c.valid_until<=v.valid_until AND c.valid_until>clock_timestamp()
 AND p.native_successions=expected AND m.before_catalog_id IS NOT DISTINCT FROM p.before_catalog_id AND m.campus_ids=v.campus_ids
 AND whaleu_ratings.compat_projection_sources_complete(p.id) AND whaleu_ratings.scoped_compat_current(v.id),false)
 THEN RAISE EXCEPTION 'Compatibility projection has no exact current typed provenance' USING ERRCODE='23514';END IF;
 -- An exit needs its own explicit current placement/lifecycle evidence. A
 -- missing category caused by an unknown source is never an authorized exit.
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(expected) x WHERE x->>'action'='exit' AND NOT EXISTS(
  SELECT 1 FROM whaleu_ratings.scoped_source_heads h JOIN whaleu_ratings.scoped_source_attestations s ON (s.id,s.revision)=(h.source_id,h.source_revision)
  WHERE s.source_kind IN ('scoped_category_scope','scoped_category_lifecycle') AND s.payload->>'categoryId'=x->>'categoryId' AND s.payload->'authorizedExit'='true'::jsonb
  AND s.payload->'legacyBeforeCatalogId'=to_jsonb(p.before_catalog_id) AND whaleu_ratings.scoped_source_current(s.id,s.revision,clock_timestamp())))
 THEN RAISE EXCEPTION 'Native compatibility exit lacks explicit source' USING ERRCODE='23514';END IF;
END $$;
CREATE OR REPLACE FUNCTION whaleu_ratings.verify_compat_version(version uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v whaleu_ratings.compat_versions;r whaleu_ratings.scoped_releases;state text;p uuid;
BEGIN
 SELECT * INTO v FROM whaleu_ratings.compat_versions WHERE id=version;SELECT * INTO r FROM whaleu_ratings.scoped_releases WHERE id=v.release_id;
 state:=whaleu_ratings.scoped_compat_state(v);
 IF NOT coalesce(v.publication_transaction=pg_current_xact_id() AND r.publication_transaction=v.publication_transaction AND v.valid_until>clock_timestamp()
 AND v.valid_until<=r.valid_until AND EXISTS(SELECT 1 FROM whaleu_ratings.compat_heads WHERE version_id=v.id AND compat_key=v.compat_key)
 AND state=v.state AND whaleu_ratings.scoped_compat_scope_keys(v)&&r.affected_scope_keys,false)
 THEN RAISE EXCEPTION 'Compatibility head lacks complete current release domain' USING ERRCODE='23514';END IF;
 IF state='equal' THEN
  IF v.equality_digest IS DISTINCT FROM whaleu_ratings.scoped_digest('compat-body',whaleu_ratings.legacy_catalog_body(v.legacy_catalog_id))
  THEN RAISE EXCEPTION 'Equal compatibility digest differs from exact immutable output' USING ERRCODE='23514';END IF;
  IF NOT whaleu_ratings.scoped_compat_current(v.id) THEN RAISE EXCEPTION 'Equal compatibility requires exact canonical old output' USING ERRCODE='23514';END IF;
  SELECT id INTO p FROM whaleu_ratings.compat_projection_manifests WHERE compat_version_id=v.id;
  IF p IS NOT NULL THEN PERFORM whaleu_ratings.verify_compat_projection(p);
  ELSIF r.cause_kind='legacy_bridge' THEN
   -- The immutable fresh bridge cause and release each have whole-set deferred
   -- verifiers. A compat artifact must point back to that exact cause, without
   -- recursively re-running every catalog/Review proof for every output row.
   IF NOT EXISTS(SELECT 1 FROM whaleu_ratings.scoped_command_causes bridge
    JOIN whaleu_ratings.requests original USING(account_id,request_id)
    WHERE bridge.cause_kind='legacy_bridge' AND bridge.artifact_id::text=r.cause->>'bridgeId'
    AND bridge.account_id::text=r.cause->>'accountId' AND bridge.request_id::text=r.cause->>'requestId'
    AND bridge.mutation_transaction=r.publication_transaction AND bridge.mutation_transaction=pg_current_xact_id()
    AND original.operation IN ('create_target','create_categories') AND original.intent_hash=bridge.proof->>'intentHash'
    AND EXISTS(SELECT 1 FROM jsonb_array_elements(bridge.proof->'domains') domain
      WHERE domain->>'compatVersionId'=v.previous_version_id::text AND domain->>'logicalScopeKey'=coalesce(v.region_id::text,'global'))
    AND EXISTS(SELECT 1 FROM jsonb_array_elements(bridge.proof->'legacyCatalogs') output
      WHERE output->>'logicalScopeKey'=coalesce(v.region_id::text,'global') AND output->>'afterCatalogId'=v.legacy_catalog_id::text))
   THEN RAISE EXCEPTION 'Bridge compatibility lacks its exact fresh original parent cause' USING ERRCODE='23514';END IF;
  ELSIF NOT EXISTS(SELECT 1 FROM whaleu_ratings.compat_versions old WHERE old.id=v.previous_version_id AND old.legacy_catalog_id=v.legacy_catalog_id AND old.equality_digest=v.equality_digest AND old.state='equal')
  THEN RAISE EXCEPTION 'First equal compatibility needs its own typed projection' USING ERRCODE='23514';END IF;
 END IF;
END $$;
CREATE FUNCTION whaleu_ratings.scoped_compat_artifact_causal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE version uuid;
BEGIN
 IF TG_TABLE_NAME='compat_versions' THEN version:=NEW.id;
 ELSIF TG_TABLE_NAME IN ('compat_heads','compat_projection_manifests') THEN
  version:=CASE WHEN TG_TABLE_NAME='compat_heads' THEN (to_jsonb(NEW)->>'version_id')::uuid ELSE (to_jsonb(NEW)->>'compat_version_id')::uuid END;
  IF NOT EXISTS(SELECT 1 FROM whaleu_ratings.compat_versions own JOIN whaleu_ratings.compat_heads head ON head.version_id=own.id AND head.compat_key=own.compat_key
   WHERE own.id=version AND own.publication_transaction=pg_current_xact_id()
   AND (TG_TABLE_NAME='compat_heads' OR (own.publication_transaction=(to_jsonb(NEW)->>'publication_transaction')::xid8
    AND own.release_id=(to_jsonb(NEW)->>'release_id')::uuid AND own.legacy_catalog_id=(to_jsonb(NEW)->>'after_catalog_id')::uuid
    AND own.equality_digest=to_jsonb(NEW)->>'projection_digest' AND own.source_digest=to_jsonb(NEW)->>'source_digest'
    AND EXISTS(SELECT 1 FROM whaleu_ratings.catalog_materializations materialization
     WHERE materialization.catalog_id=own.legacy_catalog_id AND materialization.source_kind='compat_projection'
     AND materialization.compat_projection_id=(to_jsonb(NEW)->>'id')::uuid
     AND materialization.publication_transaction=own.publication_transaction))))
  THEN RAISE EXCEPTION 'Compatibility artifact lacks exact fresh current version' USING ERRCODE='23514';END IF;RETURN NULL;
 ELSE
  -- The fresh parent manifest/version verifies complete lineage exactly once
  -- per publication boundary; rows cannot attach to immutable old manifests.
  IF NOT EXISTS(SELECT 1 FROM whaleu_ratings.compat_projection_manifests parent
   JOIN whaleu_ratings.compat_versions own ON own.id=parent.compat_version_id
   WHERE parent.id=NEW.manifest_id AND parent.publication_transaction=pg_current_xact_id() AND NEW.publication_transaction=parent.publication_transaction
   AND own.publication_transaction=parent.publication_transaction AND own.release_id=parent.release_id
   AND EXISTS(SELECT 1 FROM whaleu_ratings.categories category
    JOIN whaleu_ratings.catalogs catalog ON catalog.id=category.catalog_id
    WHERE category.catalog_id=parent.after_catalog_id AND category.id=NEW.category_id
    AND category.revision=NEW.effective_revision AND catalog.sealed))
  THEN RAISE EXCEPTION 'Compatibility lineage lacks fresh exact parent' USING ERRCODE='23514';END IF;
  RETURN NULL;
 END IF;
 PERFORM whaleu_ratings.verify_compat_version(version);RETURN NULL;
END $$;

-- The complete version body is verified at its immutable INSERT boundary.
-- Every adopted release must also own each affected logical compatibility head;
-- checking only whichever versions a caller chose to insert leaves an omission
-- hole. The owner-derived complete campus domain includes empty/new campuses.
CREATE FUNCTION whaleu_ratings.verify_scoped_release_compat(release uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r whaleu_ratings.scoped_releases;logical text;v whaleu_ratings.compat_versions;keys text[];
BEGIN
 SELECT * INTO r FROM whaleu_ratings.scoped_releases WHERE id=release;
 FOR logical IN SELECT DISTINCT coalesce(c.region_id::text,'global') FROM whaleu_ratings.scoped_catalogs c WHERE c.release_id=release LOOP
  IF r.cause_kind<>'protocol_activation' AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.scope_protocol_heads head JOIN whaleu_ratings.scope_protocol_versions protocol ON protocol.id=head.version_id WHERE head.logical_scope_key=logical AND protocol.phase='adopted') THEN CONTINUE;END IF;
  SELECT version.* INTO v FROM whaleu_ratings.compat_heads head JOIN whaleu_ratings.compat_versions version ON version.id=head.version_id
   WHERE head.compat_key=CASE WHEN logical='global' THEN 'global_compat' ELSE 'region_compat:'||logical END;
  keys:=whaleu_ratings.scoped_compat_scope_keys(v);
  IF NOT coalesce(v.release_id=r.id AND v.publication_transaction=r.publication_transaction AND r.publication_transaction=pg_current_xact_id()
   AND v.valid_until>clock_timestamp() AND v.valid_until<=r.valid_until AND whaleu_ratings.scoped_compat_domain_current(v)
   AND v.scoped_tuples=whaleu_ratings.scoped_head_tuples(keys)
   AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.scoped_catalogs output WHERE output.release_id=r.id AND coalesce(output.region_id::text,'global')=logical
    AND NOT (output.scope_key=ANY(keys) AND v.scoped_tuples @> jsonb_build_array(jsonb_build_object('scopeKey',output.scope_key,'catalogId',output.id,'headRevision',output.head_revision,'releaseId',r.id)))),false)
  THEN RAISE EXCEPTION 'Adopted scoped release lacks its complete fresh compatibility publication' USING ERRCODE='23514';END IF;
 END LOOP;
END $$;
DO $$ DECLARE tab text;BEGIN
 FOREACH tab IN ARRAY ARRAY['compat_versions','compat_heads','compat_projection_manifests','compat_projection_lineage'] LOOP
 EXECUTE format('CREATE CONSTRAINT TRIGGER scoped_compat_causal AFTER INSERT OR UPDATE ON whaleu_ratings.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.scoped_compat_artifact_causal()',tab);
 END LOOP;
END $$;

CREATE FUNCTION whaleu_ratings.category_catalog_sources_complete_pre_scoped(catalog uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM whaleu_ratings.catalogs c JOIN whaleu_ratings.catalog_materializations m ON m.catalog_id=c.id WHERE c.id=catalog AND c.sealed)
 AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.categories c LEFT JOIN whaleu_ratings.catalog_category_lineage l ON (l.catalog_id,l.category_id)=(c.catalog_id,c.id)
  LEFT JOIN whaleu_ratings.category_base_versions b ON (b.category_id,b.revision)=(l.category_id,l.base_revision)
  LEFT JOIN whaleu_ratings.category_identities i ON i.id=b.category_id
  LEFT JOIN whaleu_ratings.category_scope_versions s ON s.id=b.scope_version_id
  WHERE c.catalog_id=catalog AND NOT coalesce(l.effective_revision=c.revision AND
   ((l.source_kind='opaque' AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.category_identities n WHERE n.id=c.id)) OR
   (l.source_kind='native' AND l.base_revision=c.revision AND l.scope_version_id=b.scope_version_id AND l.topology_snapshot_id=s.topology_snapshot_id
    AND (b.parent_id,b.level,b.name,b.description,b.active) IS NOT DISTINCT FROM (c.parent_id,c.level,c.name,c.description,c.active)
    AND NOT c.hidden AND c.kind=i.kind AND c.system_key IS NULL AND NOT i.is_system AND c.origin_kind=CASE WHEN b.is_global THEN 'global' ELSE 'regional' END
    AND b.is_global=(s.region_id IS NULL))),false))
$$;
CREATE OR REPLACE FUNCTION whaleu_ratings.category_catalog_sources_complete(catalog uuid) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE manifest uuid;BEGIN
 SELECT compat_projection_id INTO manifest FROM whaleu_ratings.catalog_materializations WHERE catalog_id=catalog;
 IF manifest IS NOT NULL THEN RETURN whaleu_ratings.compat_projection_sources_complete(manifest);END IF;
 IF EXISTS(SELECT 1 FROM whaleu_ratings.catalog_category_lineage WHERE catalog_id=catalog AND source_kind='compat_effective') THEN RETURN whaleu_ratings.legacy_bridge_catalog_sources_complete(catalog);END IF;
 RETURN whaleu_ratings.category_catalog_sources_complete_pre_scoped(catalog);
END $$;

CREATE FUNCTION whaleu_ratings.category_ancestry_current_pre_scoped(catalog uuid,category uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 WITH RECURSIVE path AS (
  SELECT c.* FROM whaleu_ratings.categories c WHERE c.catalog_id=catalog AND c.id=category
  UNION ALL SELECT c.* FROM whaleu_ratings.categories c JOIN path p ON c.catalog_id=p.catalog_id AND c.id=p.parent_id WHERE p.level>1)
 SELECT EXISTS(SELECT 1 FROM path WHERE level=1) AND NOT EXISTS(
  SELECT 1 FROM path p LEFT JOIN whaleu_ratings.catalog_category_lineage l ON (l.catalog_id,l.category_id)=(p.catalog_id,p.id)
   LEFT JOIN whaleu_ratings.category_base_versions b ON (b.category_id,b.revision)=(l.category_id,l.base_revision)
  WHERE NOT coalesce(p.active AND NOT p.hidden AND l.effective_revision=p.revision AND
   (l.source_kind='opaque' OR (l.source_kind='native' AND l.base_revision=p.revision AND whaleu_community.rating_category_base_current(p.id,l.base_revision,b.envelope))),false))
$$;
CREATE OR REPLACE FUNCTION whaleu_ratings.category_ancestry_current(catalog uuid,category uuid) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE manifest uuid;v whaleu_ratings.compat_versions;input jsonb;BEGIN
 SELECT compat_projection_id INTO manifest FROM whaleu_ratings.catalog_materializations WHERE catalog_id=catalog;
 IF manifest IS NULL THEN
  IF NOT EXISTS(SELECT 1 FROM whaleu_ratings.catalog_category_lineage WHERE catalog_id=catalog AND source_kind='compat_effective') THEN RETURN whaleu_ratings.category_ancestry_current_pre_scoped(catalog,category);END IF;
  SELECT x.* INTO v FROM whaleu_ratings.compat_heads h JOIN whaleu_ratings.compat_versions x ON x.id=h.version_id WHERE x.legacy_catalog_id=catalog;
  IF NOT whaleu_ratings.scoped_compat_current(v.id) OR NOT whaleu_ratings.category_catalog_sources_complete(catalog) THEN RETURN false;END IF;
  FOR input IN SELECT value FROM jsonb_array_elements(v.scoped_tuples) LOOP IF NOT whaleu_ratings.scoped_category_current((input->>'catalogId')::uuid,category) THEN RETURN false;END IF;END LOOP;RETURN true;
 END IF;
 SELECT x.* INTO v FROM whaleu_ratings.compat_projection_manifests p JOIN whaleu_ratings.compat_versions x ON x.id=p.compat_version_id WHERE p.id=manifest;
 -- A reused old canonical projection keeps its immutable provenance, but live
 -- qualification is against the newest compatibility head for that domain.
 SELECT x.* INTO v FROM whaleu_ratings.compat_heads h JOIN whaleu_ratings.compat_versions x ON x.id=h.version_id WHERE h.compat_key=v.compat_key;
 IF NOT whaleu_ratings.scoped_compat_current(v.id) THEN RETURN false;END IF;
 FOR input IN SELECT value FROM jsonb_array_elements(v.scoped_tuples) LOOP
  IF NOT whaleu_ratings.scoped_category_current((input->>'catalogId')::uuid,category) THEN RETURN false;END IF;
 END LOOP;RETURN true;
END $$;

CREATE FUNCTION whaleu_ratings.category_catalog_compat_current_pre_scoped(catalog uuid) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE c whaleu_ratings.catalogs;m whaleu_ratings.catalog_materializations;regions jsonb;campuses uuid[];global_catalog uuid;
BEGIN
 SELECT * INTO c FROM whaleu_ratings.catalogs WHERE id=catalog;SELECT * INTO m FROM whaleu_ratings.catalog_materializations WHERE catalog_id=catalog;
 IF NOT coalesce(c.sealed AND c.coverage='complete' AND c.provenance='accepted' AND c.effective_at<=clock_timestamp()
  AND (c.valid_until IS NULL OR c.valid_until>clock_timestamp()) AND whaleu_ratings.category_catalog_sources_complete(catalog),false) THEN RETURN false;END IF;
 -- A legacy regional projection cannot conceal newly published global native
 -- sources. Check this before the opaque compatibility branch.
 SELECT catalog_id INTO global_catalog FROM whaleu_ratings.catalog_heads WHERE scope_key='global';
 IF c.region_id IS NOT NULL AND global_catalog IS NOT NULL AND EXISTS(
  SELECT category_id,base_revision,scope_version_id,topology_snapshot_id FROM whaleu_ratings.catalog_category_lineage WHERE catalog_id=global_catalog AND source_kind='native'
  EXCEPT SELECT category_id,base_revision,scope_version_id,topology_snapshot_id FROM whaleu_ratings.catalog_category_lineage WHERE catalog_id=catalog AND source_kind='native') THEN RETURN false;END IF;
 -- Legacy opaque domains retain their frozen effective contract. The presence
 -- of even one native row requires the complete exact compatibility witness.
 IF NOT EXISTS(SELECT 1 FROM whaleu_ratings.catalog_category_lineage WHERE catalog_id=catalog AND source_kind='native') THEN RETURN true;END IF;
 IF m.topology_snapshot_id IS NULL THEN RETURN false;END IF;
 regions:=whaleu_ratings.category_topology_regions(m.topology_snapshot_id,c.region_id);
 IF regions IS NULL THEN RETURN false;END IF;
 SELECT coalesce(array_agg(v::uuid ORDER BY v::uuid),'{}'::uuid[]) INTO campuses FROM jsonb_array_elements(regions) r CROSS JOIN LATERAL jsonb_array_elements_text(r->'campusIds') x(v);
 IF campuses IS DISTINCT FROM m.campus_ids THEN RETURN false;END IF;
 IF EXISTS(SELECT 1 FROM whaleu_ratings.catalog_category_lineage l JOIN whaleu_ratings.category_scope_versions s ON s.id=l.scope_version_id
  JOIN whaleu_ratings.category_base_heads h ON h.category_id=l.category_id
  WHERE l.catalog_id=catalog AND l.source_kind='native' AND (h.revision<>l.base_revision
   OR (s.region_id IS NOT NULL AND s.region_id IS DISTINCT FROM c.region_id))) THEN RETURN false;END IF;
 RETURN true;
END $$;
CREATE OR REPLACE FUNCTION whaleu_ratings.category_catalog_compat_current(catalog uuid) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE c whaleu_ratings.catalogs;phase text;version uuid;BEGIN
 SELECT * INTO c FROM whaleu_ratings.catalogs WHERE id=catalog;
 SELECT v.phase INTO phase FROM whaleu_ratings.scope_protocol_heads h JOIN whaleu_ratings.scope_protocol_versions v ON v.id=h.version_id WHERE h.logical_scope_key=coalesce(c.region_id::text,'global');
 IF phase IS DISTINCT FROM 'adopted' AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.catalog_materializations WHERE catalog_id=catalog AND source_kind='compat_projection') THEN RETURN whaleu_ratings.category_catalog_compat_current_pre_scoped(catalog);END IF;
 SELECT v.id INTO version FROM whaleu_ratings.compat_heads h JOIN whaleu_ratings.compat_versions v ON v.id=h.version_id WHERE h.compat_key=CASE WHEN c.region_id IS NULL THEN 'global_compat' ELSE 'region_compat:'||c.region_id::text END AND v.legacy_catalog_id=catalog;
 RETURN whaleu_ratings.scoped_compat_current(version);
END $$;

CREATE FUNCTION whaleu_ratings.category_catalog_compat_until_pre_scoped(catalog uuid) RETURNS timestamptz LANGUAGE plpgsql STABLE AS $$
DECLARE m whaleu_ratings.catalog_materializations;s whaleu_campus.community_topology_snapshots;
BEGIN
 IF catalog IS NULL THEN RETURN NULL;END IF;
 SELECT * INTO m FROM whaleu_ratings.catalog_materializations WHERE catalog_id=catalog;
 IF m.catalog_id IS NULL OR NOT whaleu_ratings.category_catalog_sources_complete(catalog)
 THEN RAISE EXCEPTION 'Category compatibility deadline source missing' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT 1 FROM whaleu_ratings.catalog_category_lineage WHERE catalog_id=catalog AND source_kind='native') THEN RETURN NULL;END IF;
 SELECT v.* INTO s FROM whaleu_campus.community_topology_heads h JOIN whaleu_campus.community_topology_snapshots v ON (v.id,v.revision)=(h.snapshot_id,h.revision)
 WHERE h.scope_key='community' AND v.id=m.topology_snapshot_id;
 IF NOT coalesce(s.id=m.topology_snapshot_id AND s.coverage_state='complete' AND s.provenance_state='accepted'
  AND length(btrim(s.source_reference))>0 AND length(btrim(s.policy_reference))>0 AND isfinite(s.effective_at) AND s.effective_at<=clock_timestamp(),false)
 THEN RAISE EXCEPTION 'Category compatibility deadline is not current exact topology' USING ERRCODE='23514';END IF;
 IF s.expiry_kind='policy_exempt' AND s.valid_until IS NULL THEN RETURN NULL;END IF;
 IF s.expiry_kind='at' AND isfinite(s.valid_until) AND s.valid_until>s.effective_at AND s.valid_until>clock_timestamp() THEN RETURN s.valid_until;END IF;
 RAISE EXCEPTION 'Category compatibility topology deadline unavailable' USING ERRCODE='23514';
END $$;
CREATE OR REPLACE FUNCTION whaleu_ratings.category_catalog_compat_until(catalog uuid) RETURNS timestamptz LANGUAGE plpgsql STABLE AS $$
DECLARE c whaleu_ratings.catalogs;phase text;deadline timestamptz;BEGIN
 IF catalog IS NULL THEN RETURN NULL;END IF;
 SELECT * INTO c FROM whaleu_ratings.catalogs WHERE id=catalog;
 SELECT v.phase INTO phase FROM whaleu_ratings.scope_protocol_heads h JOIN whaleu_ratings.scope_protocol_versions v ON v.id=h.version_id WHERE h.logical_scope_key=coalesce(c.region_id::text,'global');
 IF phase IS DISTINCT FROM 'adopted' AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.catalog_materializations WHERE catalog_id=catalog AND source_kind='compat_projection') THEN RETURN whaleu_ratings.category_catalog_compat_until_pre_scoped(catalog);END IF;
 SELECT v.valid_until INTO deadline FROM whaleu_ratings.compat_heads h JOIN whaleu_ratings.compat_versions v ON v.id=h.version_id WHERE h.compat_key=CASE WHEN c.region_id IS NULL THEN 'global_compat' ELSE 'region_compat:'||c.region_id::text END AND v.legacy_catalog_id=catalog AND whaleu_ratings.scoped_compat_current(v.id);
 IF deadline IS NULL THEN RAISE EXCEPTION 'Scoped compatibility deadline unavailable' USING ERRCODE='23514';END IF;RETURN deadline;
END $$;

CREATE FUNCTION whaleu_ratings.verify_category_catalog_pre_scoped(catalog uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE m whaleu_ratings.catalog_materializations;c whaleu_ratings.catalogs;old whaleu_ratings.catalog_materializations;e whaleu_ratings.target_create_transitions;
 release whaleu_ratings.category_command_transitions;
BEGIN
 SELECT * INTO c FROM whaleu_ratings.catalogs WHERE id=catalog;
 SELECT * INTO m FROM whaleu_ratings.catalog_materializations WHERE catalog_id=catalog;
 IF NOT coalesce(c.sealed AND m.catalog_id=c.id AND whaleu_ratings.category_catalog_sources_complete(catalog),false)
 THEN RAISE EXCEPTION 'Sealed catalog requires complete immutable lineage and cause' USING ERRCODE='23514';END IF;
 IF m.source_kind='category_release' THEN
  SELECT * INTO release FROM whaleu_ratings.category_command_transitions WHERE release_id=m.release_id;
  PERFORM whaleu_ratings.verify_category_release(release.actor_account_id,release.request_id);
 ELSIF m.source_kind='target_create' THEN
  SELECT * INTO e FROM whaleu_ratings.target_create_transitions WHERE target_id=m.target_id;
  SELECT * INTO old FROM whaleu_ratings.catalog_materializations WHERE catalog_id=m.before_catalog_id;
  IF NOT coalesce(e.after_catalog_id=c.id AND e.before_catalog_id=m.before_catalog_id AND e.mutation_transaction=pg_current_xact_id()
   AND m.publication_transaction=e.mutation_transaction AND m.topology_snapshot_id IS NOT DISTINCT FROM old.topology_snapshot_id AND m.campus_ids=old.campus_ids
   AND whaleu_ratings.category_catalog_compat_current(c.id)
   AND whaleu_ratings.category_ancestry_current(c.id,(SELECT category_id FROM whaleu_ratings.targets WHERE id=e.target_id)),false)
   OR EXISTS((SELECT to_jsonb(x)-'catalog_id' FROM whaleu_ratings.catalog_category_lineage x WHERE catalog_id=e.before_catalog_id
    EXCEPT SELECT to_jsonb(x)-'catalog_id' FROM whaleu_ratings.catalog_category_lineage x WHERE catalog_id=e.after_catalog_id)
   UNION ALL (SELECT to_jsonb(x)-'catalog_id' FROM whaleu_ratings.catalog_category_lineage x WHERE catalog_id=e.after_catalog_id
    EXCEPT SELECT to_jsonb(x)-'catalog_id' FROM whaleu_ratings.catalog_category_lineage x WHERE catalog_id=e.before_catalog_id))
  THEN RAISE EXCEPTION 'M1 lineage must be the exact real create_target predecessor copy' USING ERRCODE='23514';END IF;
  PERFORM whaleu_ratings.verify_target_create(e.account_id,e.request_id);
 ELSE
  IF c.source_reference LIKE 'rating-category-create:%' OR c.source_reference LIKE 'rating-create:%'
   OR EXISTS(SELECT 1 FROM whaleu_ratings.catalog_category_lineage WHERE catalog_id=c.id AND source_kind<>'opaque')
  THEN RAISE EXCEPTION 'Opaque catalog cannot hide a managed publication cause' USING ERRCODE='23514';END IF;
 END IF;
END $$;
CREATE OR REPLACE FUNCTION whaleu_ratings.verify_category_catalog(catalog uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE manifest uuid;BEGIN
 SELECT compat_projection_id INTO manifest FROM whaleu_ratings.catalog_materializations WHERE catalog_id=catalog;
 IF manifest IS NOT NULL THEN PERFORM whaleu_ratings.verify_compat_projection(manifest);
 ELSE PERFORM whaleu_ratings.verify_category_catalog_pre_scoped(catalog);END IF;
END $$;

-- Same-OID exact typed branch; the final 0058 legacy body is retained.
CREATE OR REPLACE FUNCTION whaleu_ratings.category_record_opaque_catalog() RETURNS trigger LANGUAGE plpgsql AS $dispatch$
BEGIN
 IF NEW.source_reference LIKE 'rating-scoped-compat:%' THEN
DECLARE p whaleu_ratings.compat_projection_manifests;v whaleu_ratings.compat_versions;BEGIN
 SELECT * INTO p FROM whaleu_ratings.compat_projection_manifests WHERE after_catalog_id=NEW.id;
 SELECT * INTO v FROM whaleu_ratings.compat_versions WHERE id=p.compat_version_id;
 IF p.id IS NULL OR p.publication_transaction<>pg_current_xact_id() OR NEW.source_reference<>'rating-scoped-compat:'||p.id::text THEN RAISE EXCEPTION 'Scoped compatibility output requires fresh typed manifest before INSERT' USING ERRCODE='23514';END IF;
 INSERT INTO whaleu_ratings.catalog_materializations(catalog_id,source_kind,before_catalog_id,topology_snapshot_id,campus_ids,compat_projection_id) VALUES(NEW.id,'compat_projection',p.before_catalog_id,v.topology_snapshot_id,v.campus_ids,p.id);RETURN NULL;END;
 ELSE

BEGIN
 IF NEW.source_reference NOT LIKE 'rating-category-create:%' AND NEW.source_reference NOT LIKE 'rating-create:%' THEN
  INSERT INTO whaleu_ratings.catalog_materializations(catalog_id,source_kind,campus_ids) VALUES(NEW.id,'opaque','{}'::uuid[]);
 END IF;RETURN NULL;
END ;
 END IF;
END $dispatch$;

-- A successful early constraint flush must not authorize a later single-sided
-- legacy head replacement. In particular, compat_effective predecessors cannot
-- fall through the retained legacy native-only preservation branch to opaque.
-- Divergent/unresolved compatibility keeps the existing legacy head unchanged.
CREATE FUNCTION whaleu_ratings.scoped_legacy_head_causal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM whaleu_ratings.scope_protocol_heads head JOIN whaleu_ratings.scope_protocol_versions protocol ON protocol.id=head.version_id
  WHERE head.logical_scope_key=NEW.scope_key AND protocol.phase='adopted') THEN RETURN NULL;END IF;
 IF NOT EXISTS(SELECT 1 FROM whaleu_ratings.catalog_heads legacy_head
  JOIN whaleu_ratings.compat_heads compat_head ON compat_head.compat_key=CASE WHEN NEW.scope_key='global' THEN 'global_compat' ELSE 'region_compat:'||NEW.scope_key END
  JOIN whaleu_ratings.compat_versions version ON version.id=compat_head.version_id
  JOIN whaleu_ratings.scoped_releases release ON release.id=version.release_id
  WHERE legacy_head.scope_key=NEW.scope_key AND legacy_head.catalog_id=NEW.catalog_id
  AND version.state='equal' AND version.legacy_catalog_id=legacy_head.catalog_id
  AND version.publication_transaction=pg_current_xact_id() AND release.publication_transaction=version.publication_transaction
  AND whaleu_ratings.scoped_compat_scope_keys(version)&&release.affected_scope_keys)
 THEN RAISE EXCEPTION 'Adopted legacy head lacks its exact fresh compatibility cause' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER scoped_legacy_head_causal AFTER INSERT OR UPDATE ON whaleu_ratings.catalog_heads DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.scoped_legacy_head_causal();

-- Same-OID exact typed branch; the final 0058 legacy body is retained.
CREATE OR REPLACE FUNCTION whaleu_ratings.category_record_opaque_lineage() RETURNS trigger LANGUAGE plpgsql AS $dispatch$
BEGIN
 IF EXISTS(SELECT 1 FROM whaleu_ratings.catalog_materializations WHERE catalog_id=NEW.catalog_id AND source_kind='compat_projection') THEN
DECLARE p whaleu_ratings.compat_projection_manifests;v whaleu_ratings.compat_versions;BEGIN
 SELECT x.* INTO p FROM whaleu_ratings.catalog_materializations m JOIN whaleu_ratings.compat_projection_manifests x ON x.id=m.compat_projection_id WHERE m.catalog_id=NEW.catalog_id;
 SELECT * INTO v FROM whaleu_ratings.compat_versions WHERE id=p.compat_version_id;
 IF NOT EXISTS(SELECT 1 FROM whaleu_ratings.compat_projection_lineage l WHERE l.manifest_id=p.id AND l.category_id=NEW.id AND l.effective_revision=NEW.revision) THEN RAISE EXCEPTION 'Scoped canonical category must have its exact independent revision' USING ERRCODE='23514';END IF;
 INSERT INTO whaleu_ratings.catalog_category_lineage(catalog_id,category_id,effective_revision,source_kind,topology_snapshot_id,compat_projection_id) VALUES(NEW.catalog_id,NEW.id,NEW.revision,'compat_effective',v.topology_snapshot_id,p.id);RETURN NULL;END;
 ELSE

BEGIN
 IF EXISTS(SELECT 1 FROM whaleu_ratings.catalog_materializations WHERE catalog_id=NEW.catalog_id AND source_kind='opaque') THEN
  IF EXISTS(SELECT 1 FROM whaleu_ratings.category_identities WHERE id=NEW.id)
  THEN RAISE EXCEPTION 'Native category cannot be downgraded to opaque' USING ERRCODE='23514';END IF;
  INSERT INTO whaleu_ratings.catalog_category_lineage(catalog_id,category_id,effective_revision,source_kind) VALUES(NEW.catalog_id,NEW.id,NEW.revision,'opaque');
 END IF;RETURN NULL;
END ;
 END IF;
END $dispatch$;

-- Same-OID exact typed branch; the final 0058 legacy body is retained.
CREATE OR REPLACE FUNCTION whaleu_ratings.category_head_preserves_native() RETURNS trigger LANGUAGE plpgsql AS $dispatch$
BEGIN
 IF EXISTS(SELECT 1 FROM whaleu_ratings.catalog_materializations WHERE catalog_id=NEW.catalog_id AND source_kind='compat_projection') THEN
DECLARE p whaleu_ratings.compat_projection_manifests;BEGIN
 SELECT x.* INTO p FROM whaleu_ratings.catalog_materializations m JOIN whaleu_ratings.compat_projection_manifests x ON x.id=m.compat_projection_id WHERE m.catalog_id=NEW.catalog_id;
 IF NOT coalesce(p.publication_transaction=pg_current_xact_id() AND p.before_catalog_id IS NOT DISTINCT FROM CASE WHEN TG_OP='UPDATE' THEN OLD.catalog_id ELSE NULL END AND whaleu_ratings.compat_projection_sources_complete(p.id),false) THEN RAISE EXCEPTION 'Native successor requires exact typed canonical predecessor proof' USING ERRCODE='23514';END IF;RETURN NEW;END;
 ELSE

BEGIN
 IF TG_OP='UPDATE' AND EXISTS(
  SELECT to_jsonb(c)-'catalog_id' FROM whaleu_ratings.categories c JOIN whaleu_ratings.catalog_category_lineage l ON (l.catalog_id,l.category_id)=(c.catalog_id,c.id)
   WHERE c.catalog_id=OLD.catalog_id AND l.source_kind='native'
  EXCEPT SELECT to_jsonb(c)-'catalog_id' FROM whaleu_ratings.categories c WHERE c.catalog_id=NEW.catalog_id)
 THEN RAISE EXCEPTION 'Compatible head cannot discard or rewrite native category sources' USING ERRCODE='23514';END IF;
 RETURN NEW;
END ;
 END IF;
END $dispatch$;

-- Same-OID exact typed branch; the final 0058 legacy body is retained.
CREATE OR REPLACE FUNCTION whaleu_ratings.category_catalog_artifact_causal() RETURNS trigger LANGUAGE plpgsql AS $dispatch$
BEGIN
 IF EXISTS(SELECT 1 FROM whaleu_ratings.catalog_materializations WHERE catalog_id=CASE WHEN TG_TABLE_NAME='catalogs' THEN (to_jsonb(NEW)->>'id')::uuid ELSE (to_jsonb(NEW)->>'catalog_id')::uuid END AND source_kind='compat_projection') THEN
DECLARE p whaleu_ratings.compat_projection_manifests;catalog uuid;BEGIN
 catalog:=CASE WHEN TG_TABLE_NAME='catalogs' THEN (to_jsonb(NEW)->>'id')::uuid ELSE (to_jsonb(NEW)->>'catalog_id')::uuid END;
 SELECT x.* INTO p FROM whaleu_ratings.catalog_materializations m JOIN whaleu_ratings.compat_projection_manifests x ON x.id=m.compat_projection_id WHERE m.catalog_id=catalog;
 IF TG_TABLE_NAME='catalog_heads' AND p.before_catalog_id IS DISTINCT FROM (CASE WHEN TG_OP='UPDATE' THEN (to_jsonb(OLD)->>'catalog_id')::uuid ELSE NULL END) THEN RAISE EXCEPTION 'Canonical compat cause differs from actual replaced head' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT 1 FROM whaleu_ratings.compat_versions own JOIN whaleu_ratings.compat_heads head ON head.version_id=own.id
  JOIN whaleu_ratings.catalogs output ON output.id=own.legacy_catalog_id
  WHERE own.id=p.compat_version_id AND own.publication_transaction=p.publication_transaction
  AND p.publication_transaction=pg_current_xact_id() AND p.after_catalog_id=catalog AND output.id=catalog AND output.sealed
  AND EXISTS(SELECT 1 FROM whaleu_ratings.catalog_materializations materialization WHERE materialization.catalog_id=output.id
   AND materialization.compat_projection_id=p.id AND materialization.publication_transaction=p.publication_transaction))
 THEN RAISE EXCEPTION 'Canonical compatibility output lacks its exact fresh sealed parent' USING ERRCODE='23514';END IF;RETURN NULL;END;
 ELSE

DECLARE m whaleu_ratings.catalog_materializations;predecessor uuid;
BEGIN
 IF TG_TABLE_NAME='catalog_heads' THEN
  SELECT * INTO m FROM whaleu_ratings.catalog_materializations WHERE catalog_id=NEW.catalog_id;
  predecessor:=CASE WHEN TG_OP='UPDATE' THEN OLD.catalog_id ELSE NULL END;
  IF m.source_kind IN ('category_release','target_create') AND m.before_catalog_id IS DISTINCT FROM predecessor
  THEN RAISE EXCEPTION 'Managed catalog cause differs from the actual replaced head' USING ERRCODE='23514';END IF;
 END IF;
 IF TG_TABLE_NAME='catalogs' THEN PERFORM whaleu_ratings.verify_category_catalog(NEW.id);
 ELSE PERFORM whaleu_ratings.verify_category_catalog(NEW.catalog_id);END IF;RETURN NULL;
END ;
 END IF;
END $dispatch$;

CREATE OR REPLACE FUNCTION whaleu_ratings.category_copy_target_lineage() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE m whaleu_ratings.catalog_materializations;
BEGIN
 SELECT * INTO m FROM whaleu_ratings.catalog_materializations WHERE catalog_id=NEW.before_catalog_id;
 IF NOT coalesce(NEW.mutation_transaction=pg_current_xact_id() AND m.catalog_id=NEW.before_catalog_id
  AND (whaleu_ratings.category_catalog_compat_current(NEW.before_catalog_id) OR whaleu_ratings.legacy_bridge_before_catalog_current(NEW.account_id,NEW.request_id,NEW.before_catalog_id,NEW.after_catalog_id)),false)
 THEN RAISE EXCEPTION 'M1 requires exact compatible predecessor lineage' USING ERRCODE='23514';END IF;
 INSERT INTO whaleu_ratings.catalog_materializations(catalog_id,source_kind,before_catalog_id,target_id,topology_snapshot_id,campus_ids)
 VALUES(NEW.after_catalog_id,'target_create',NEW.before_catalog_id,NEW.target_id,m.topology_snapshot_id,m.campus_ids);
 INSERT INTO whaleu_ratings.catalog_category_lineage(catalog_id,category_id,effective_revision,source_kind,base_revision,scope_version_id,topology_snapshot_id,compat_projection_id) SELECT NEW.after_catalog_id,category_id,effective_revision,source_kind,base_revision,scope_version_id,topology_snapshot_id,compat_projection_id
 FROM whaleu_ratings.catalog_category_lineage WHERE catalog_id=NEW.before_catalog_id;
 RETURN NULL;
END $$;

-- The source owner supplies a complete domain; this publisher does not choose
-- one campus as the public regional result until every complete body is equal.
CREATE FUNCTION whaleu_ratings.publish_scoped_compat(release uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r whaleu_ratings.scoped_releases;logical text;region uuid;topology uuid;campuses uuid[];keys text[];regions jsonb;v whaleu_ratings.compat_versions;
 old whaleu_ratings.compat_versions;before_catalog uuid;output uuid;manifest uuid;category record;revision uuid;body jsonb;successions jsonb;instant timestamptz:=clock_timestamp();
BEGIN
 SELECT * INTO r FROM whaleu_ratings.scoped_releases WHERE id=release;
 IF NOT coalesce(r.publication_transaction=pg_current_xact_id() AND r.valid_until>instant,false) THEN RAISE EXCEPTION 'Compatibility needs fresh scoped release' USING ERRCODE='23514';END IF;
 topology:=(r.cause->>'topologySnapshotId')::uuid;
 FOR logical IN SELECT DISTINCT coalesce(c.region_id::text,'global') FROM whaleu_ratings.scoped_catalogs c WHERE c.release_id=release ORDER BY 1 LOOP
  region:=CASE WHEN logical='global' THEN NULL ELSE logical::uuid END;
  IF r.cause_kind<>'protocol_activation' AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.scope_protocol_heads h JOIN whaleu_ratings.scope_protocol_versions p ON p.id=h.version_id WHERE h.logical_scope_key=logical AND p.phase='adopted') THEN CONTINUE;END IF;
  IF region IS NULL THEN campuses:='{}';keys:=ARRAY['global'];
  ELSE
   regions:=whaleu_ratings.category_topology_regions(topology,region);
   IF regions IS NULL THEN RAISE EXCEPTION 'Compatibility region needs complete current Campus inventory' USING ERRCODE='23514';END IF;
   SELECT coalesce(array_agg(id::uuid ORDER BY id::uuid),'{}'::uuid[]) INTO campuses FROM jsonb_array_elements(regions) x CROSS JOIN LATERAL jsonb_array_elements_text(x->'campusIds') id;
   IF cardinality(campuses)=0 THEN RAISE EXCEPTION 'Zero-campus region policy undefined' USING ERRCODE='23514';END IF;
   keys:=ARRAY(SELECT 'campus:'||id::text FROM unnest(campuses) id ORDER BY id);
  END IF;
  SELECT x.* INTO old FROM whaleu_ratings.compat_heads h JOIN whaleu_ratings.compat_versions x ON x.id=h.version_id WHERE h.compat_key=CASE WHEN region IS NULL THEN 'global_compat' ELSE 'region_compat:'||region::text END FOR UPDATE OF h;
  SELECT catalog_id INTO before_catalog FROM whaleu_ratings.catalog_heads WHERE scope_key=logical FOR UPDATE;
  v.id:=gen_random_uuid();v.compat_key:=CASE WHEN region IS NULL THEN 'global_compat' ELSE 'region_compat:'||region::text END;
  v.kind:=CASE WHEN region IS NULL THEN 'global_compat' ELSE 'region_compat' END;v.region_id:=region;v.campus_ids:=campuses;
  v.scoped_tuples:=whaleu_ratings.scoped_head_tuples(keys);v.source_digest:=whaleu_ratings.scoped_digest('vector',whaleu_ratings.scoped_current_source_vector(keys));
  v.release_id:=release;v.previous_version_id:=old.id;v.topology_snapshot_id:=topology;v.valid_until:=r.valid_until;v.publication_transaction:=pg_current_xact_id();
  v.state:=whaleu_ratings.scoped_compat_state(v);v.equality_digest:=NULL;v.legacy_catalog_id:=NULL;manifest:=NULL;
  IF v.state='equal' THEN
   body:=whaleu_ratings.scoped_catalog_body((v.scoped_tuples->0->>'catalogId')::uuid);v.equality_digest:=whaleu_ratings.scoped_digest('compat-body',body);
   -- Reuse only a previously verified exact canonical projection. A historical
   -- opaque head with coincidentally equal text still needs typed provenance.
   IF old.state='equal' AND old.legacy_catalog_id=before_catalog AND old.equality_digest=v.equality_digest AND whaleu_ratings.legacy_catalog_body(before_catalog)=body THEN v.legacy_catalog_id:=before_catalog;
   ELSE v.legacy_catalog_id:=gen_random_uuid();manifest:=gen_random_uuid();END IF;
  END IF;
  INSERT INTO whaleu_ratings.compat_versions SELECT (v).*;
  IF old.id IS NULL THEN INSERT INTO whaleu_ratings.compat_heads VALUES(v.compat_key,v.id) ON CONFLICT DO NOTHING;
  ELSE UPDATE whaleu_ratings.compat_heads SET version_id=v.id WHERE compat_key=v.compat_key AND version_id=old.id;END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'Compatibility predecessor CAS changed' USING ERRCODE='23514';END IF;
  IF manifest IS NOT NULL THEN
   output:=v.legacy_catalog_id;
   -- Allocate independent canonical revisions before materializing any output.
   -- An empty succession vector is only valid for no native predecessor rows;
   -- the exact vector below is computed from immutable after-row descriptors.
   SELECT coalesce(jsonb_agg(jsonb_build_object('categoryId',a.id,'beforeRevision',a.revision,'afterRevision',NULL,'action','pending') ORDER BY a.id),'[]'::jsonb) INTO successions
    FROM whaleu_ratings.categories a JOIN whaleu_ratings.catalog_category_lineage l ON (l.catalog_id,l.category_id)=(a.catalog_id,a.id) WHERE a.catalog_id=before_catalog AND l.source_kind IN ('native','compat_effective');
   -- Manifest is immutable. Build all independent revisions in a local json
   -- array first, then derive successions from that array before INSERT.
   SELECT coalesce(jsonb_agg(jsonb_build_object('body',x,'revision',gen_random_uuid()) ORDER BY (x->>'ordinal')::bigint),'[]'::jsonb) INTO body FROM jsonb_array_elements(body->'categories') x;
   SELECT coalesce(jsonb_agg(jsonb_build_object('categoryId',a.id,'beforeRevision',a.revision,'afterRevision',n->'revision','action',CASE WHEN n IS NULL THEN 'exit' WHEN jsonb_build_object('id',a.id,'parentId',a.parent_id,'level',a.level,'kind',a.kind,'systemKey',a.system_key,'originKind',a.origin_kind,'name',a.name,'description',a.description,'active',a.active,'hidden',a.hidden,'ordinal',a.ordinal::text)=n->'body' THEN 'retain' ELSE 'update' END) ORDER BY a.id),'[]'::jsonb) INTO successions
   FROM whaleu_ratings.categories a JOIN whaleu_ratings.catalog_category_lineage l ON (l.catalog_id,l.category_id)=(a.catalog_id,a.id)
   LEFT JOIN LATERAL (SELECT value n FROM jsonb_array_elements(body) WHERE value->'body'->>'id'=a.id::text) fresh ON true WHERE a.catalog_id=before_catalog AND l.source_kind IN ('native','compat_effective');
   INSERT INTO whaleu_ratings.compat_projection_manifests(id,compat_version_id,release_id,before_catalog_id,after_catalog_id,projection_digest,source_digest,native_successions) VALUES(manifest,v.id,release,before_catalog,output,v.equality_digest,v.source_digest,successions);
   INSERT INTO whaleu_ratings.catalogs(id,region_id,coverage,provenance,source_reference,policy_reference,effective_at,valid_until) VALUES(output,region,'complete','accepted','rating-scoped-compat:'||manifest::text,'ratings-scoped-compat-v1',instant,v.valid_until);
   FOR category IN SELECT x->'body' b,(x->>'revision')::uuid revision FROM jsonb_array_elements(body) x ORDER BY (x->'body'->>'level')::integer,(x->'body'->>'ordinal')::bigint LOOP
    INSERT INTO whaleu_ratings.compat_projection_lineage(manifest_id,category_id,effective_revision,scoped_inputs,body_digest,review_sources)
    SELECT manifest,(category.b->>'id')::uuid,category.revision,
     (SELECT jsonb_agg(jsonb_build_object('scopeKey',input->>'scopeKey','catalogId',a.catalog_id,'effectiveRevision',a.effective_revision,'effectiveDigest',a.effective_digest) ORDER BY input->>'scopeKey') FROM jsonb_array_elements(v.scoped_tuples) input JOIN whaleu_ratings.scoped_categories a ON a.catalog_id=(input->>'catalogId')::uuid AND a.category_id=(category.b->>'id')::uuid),
     whaleu_ratings.scoped_digest('compat-category',jsonb_build_object('id',category.b->'id','parent_id',category.b->'parentId','level',category.b->'level','kind',category.b->'kind','system_key',category.b->'systemKey','origin_kind',category.b->'originKind','name',category.b->'name','description',category.b->'description','active',category.b->'active','hidden',category.b->'hidden','ordinal',(category.b->>'ordinal')::bigint)),
     (SELECT jsonb_agg(jsonb_build_object('scopeKey',input->>'scopeKey','proof',l.proof) ORDER BY input->>'scopeKey') FROM jsonb_array_elements(v.scoped_tuples) input JOIN whaleu_ratings.scoped_category_lineage l ON l.catalog_id=(input->>'catalogId')::uuid AND l.category_id=(category.b->>'id')::uuid);
    INSERT INTO whaleu_ratings.categories(catalog_id,id,revision,parent_id,level,kind,system_key,origin_kind,name,description,active,hidden,ordinal)
    VALUES(output,(category.b->>'id')::uuid,category.revision,(category.b->>'parentId')::uuid,(category.b->>'level')::smallint,category.b->>'kind',category.b->>'systemKey',category.b->>'originKind',category.b->>'name',category.b->>'description',(category.b->>'active')::boolean,(category.b->>'hidden')::boolean,(category.b->>'ordinal')::bigint);
   END LOOP;
   INSERT INTO whaleu_ratings.target_memberships(catalog_id,target_id,category_id,ordinal) SELECT output,target_id,category_id,ordinal FROM whaleu_ratings.scoped_target_memberships WHERE catalog_id=(v.scoped_tuples->0->>'catalogId')::uuid;
   UPDATE whaleu_ratings.catalogs SET sealed=true WHERE id=output;
   IF before_catalog IS NULL THEN INSERT INTO whaleu_ratings.catalog_heads(scope_key,region_id,catalog_id) VALUES(logical,region,output) ON CONFLICT DO NOTHING;
   ELSE UPDATE whaleu_ratings.catalog_heads SET catalog_id=output WHERE scope_key=logical AND catalog_id=before_catalog;END IF;
   IF NOT FOUND THEN RAISE EXCEPTION 'Canonical compatibility old-head CAS changed' USING ERRCODE='23514';END IF;
  END IF;
 END LOOP;
END $$;

CREATE FUNCTION whaleu_ratings.scoped_required_capabilities() RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
 SELECT '["navigation_v2","random_v2","discussion_v2","likes_v2","subscriptions_v2","notices_v2","m1_v2","m2_v2","review_sql_v5","shared_recovery_v9","native_routes_v2","legacy_cleanup_v1"]'::jsonb
$$;
CREATE FUNCTION whaleu_ratings.scoped_capability_current(source uuid,revision uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT coalesce((SELECT s.source_kind='scope_capabilities' AND whaleu_ratings.scoped_source_current(s.id,s.revision,clock_timestamp())
 AND s.payload->>'capabilityVersion'='ratings-scoped-full-v1' AND s.payload->'protocolVersion'='2'::jsonb AND s.payload->'reviewVersion'='5'::jsonb AND s.payload->'journalVersion'='9'::jsonb
 AND s.payload->'capabilities' @> whaleu_ratings.scoped_required_capabilities() AND jsonb_array_length(s.payload->'capabilities')=12
 AND s.payload->>'routesDigest' ~ '^[a-f0-9]{64}$' AND s.payload->>'nativeDigest' ~ '^[a-f0-9]{64}$'
 AND s.payload->>'serviceDigest' ~ '^[a-f0-9]{64}$' AND s.payload->>'ownerEvidenceDigest' ~ '^[a-f0-9]{64}$'
 AND s.payload->>'legacyFreshWritePolicy'='requires_explicit_bridge'
 FROM whaleu_ratings.scoped_source_attestations s WHERE s.id=source AND s.revision=revision),false)
$$;
-- Initial adoption must acknowledge the actual complete legacy head that
-- activation replaces. A dormant compilation over an older snapshot cannot
-- hide an intervening genuine M1/M3A publication. After activation the exact
-- immutable projection manifest retains that predecessor even though live old
-- heads now point at the canonical scoped output.
CREATE FUNCTION whaleu_ratings.verify_initial_scoped_legacy_inputs(release uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE output record;current_protocol whaleu_ratings.scope_protocol_versions;prior_phase text;before_catalog uuid;projection_found boolean;coverage whaleu_ratings.scoped_source_attestations;
BEGIN
 FOR output IN SELECT c.* FROM whaleu_ratings.scoped_catalogs c WHERE c.release_id=release LOOP
  SELECT v.* INTO current_protocol FROM whaleu_ratings.scope_protocol_heads h JOIN whaleu_ratings.scope_protocol_versions v ON v.id=h.version_id
   WHERE h.logical_scope_key=coalesce(output.region_id::text,'global');
  prior_phase:=current_protocol.phase;
  IF current_protocol.release_id=release THEN SELECT phase INTO prior_phase FROM whaleu_ratings.scope_protocol_versions WHERE id=current_protocol.previous_version_id;END IF;
  IF prior_phase='adopted' THEN CONTINUE;END IF;
  SELECT manifest.before_catalog_id INTO before_catalog FROM whaleu_ratings.compat_projection_manifests manifest
   JOIN whaleu_ratings.compat_versions version ON version.id=manifest.compat_version_id
   WHERE manifest.release_id=release AND version.region_id IS NOT DISTINCT FROM output.region_id;
  projection_found:=FOUND;
  IF NOT projection_found THEN SELECT catalog_id INTO before_catalog FROM whaleu_ratings.catalog_heads WHERE scope_key=coalesce(output.region_id::text,'global');END IF;
  IF before_catalog IS NULL THEN CONTINUE;END IF;
  SELECT source.* INTO coverage FROM whaleu_ratings.scoped_source_heads head JOIN whaleu_ratings.scoped_source_attestations source
   ON (source.id,source.revision)=(head.source_id,head.source_revision)
   WHERE head.source_kind='scope_absence' AND head.source_key=output.scope_key;
  IF NOT coalesce(whaleu_ratings.scoped_source_current(coverage.id,coverage.revision,clock_timestamp())
   AND coverage.payload->'legacyCatalogIds' @> jsonb_build_array(before_catalog),false)
  THEN RAISE EXCEPTION 'Initial activation source closure omits the actual legacy predecessor head' USING ERRCODE='23514';END IF;
 END LOOP;
END $$;
CREATE FUNCTION whaleu_ratings.verify_scope_activation(release uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r whaleu_ratings.scoped_releases;s whaleu_ratings.scoped_source_attestations;logical_keys text[];logical text;v whaleu_ratings.scope_protocol_versions;compat whaleu_ratings.compat_versions;expected_keys text[];actual_keys text[];
BEGIN
 PERFORM whaleu_ratings.verify_initial_scoped_legacy_inputs(release);
 SELECT * INTO r FROM whaleu_ratings.scoped_releases WHERE id=release;
 SELECT * INTO s FROM whaleu_ratings.scoped_source_attestations WHERE id=(r.cause->>'capabilitySourceId')::uuid AND revision=(r.cause->>'capabilitySourceRevision')::uuid;
 SELECT array_agg(DISTINCT coalesce(c.region_id::text,'global') ORDER BY coalesce(c.region_id::text,'global')) INTO logical_keys FROM whaleu_ratings.scoped_catalogs c WHERE c.release_id=release;
 IF NOT coalesce(r.cause_kind='protocol_activation' AND r.publication_transaction=pg_current_xact_id() AND r.valid_until>clock_timestamp() AND r.valid_until<=s.valid_until
 AND whaleu_ratings.scoped_capability_current(s.id,s.revision) AND r.affected_scope_keys<@s.scope_keys AND to_jsonb(logical_keys)=r.cause->'logicalScopeKeys'
 AND r.cause->>'generation' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
 AND r.source_vector=whaleu_ratings.scoped_current_source_vector(r.affected_scope_keys)
 AND (SELECT count(*) FROM whaleu_ratings.scope_protocol_versions WHERE release_id=release AND phase='adopted')=cardinality(logical_keys),false)
 THEN RAISE EXCEPTION 'Activation requires current full service/native/owner capability and exact affected set' USING ERRCODE='23514';END IF;
 FOR logical IN SELECT unnest(logical_keys) LOOP
  SELECT x.* INTO v FROM whaleu_ratings.scope_protocol_heads h JOIN whaleu_ratings.scope_protocol_versions x ON x.id=h.version_id WHERE h.logical_scope_key=logical;
  SELECT x.* INTO compat FROM whaleu_ratings.compat_heads h JOIN whaleu_ratings.compat_versions x ON x.id=h.version_id WHERE h.compat_key=CASE WHEN logical='global' THEN 'global_compat' ELSE 'region_compat:'||logical END;
  expected_keys:=whaleu_ratings.scoped_compat_scope_keys(compat);
  SELECT array_agg(scope_key ORDER BY scope_key COLLATE "C") INTO actual_keys FROM whaleu_ratings.scoped_catalogs WHERE release_id=release AND coalesce(region_id::text,'global')=logical;
  IF NOT coalesce(v.phase='adopted' AND v.release_id=release AND v.generation::text=r.cause->>'generation' AND v.publication_transaction=r.publication_transaction
   AND (v.capability_source_id,v.capability_source_revision)=(s.id,s.revision) AND compat.release_id=release AND compat.publication_transaction=r.publication_transaction
   AND whaleu_ratings.scoped_compat_domain_current(compat) AND actual_keys=expected_keys
   AND v.manifest=jsonb_build_object('releaseId',release,'generation',v.generation,'scopeKeys',expected_keys,'compatVersionId',compat.id,'capabilitySourceId',s.id,'capabilitySourceRevision',s.revision,'routesDigest',s.payload->'routesDigest','nativeDigest',s.payload->'nativeDigest','serviceDigest',s.payload->'serviceDigest','ownerEvidenceDigest',s.payload->'ownerEvidenceDigest','legacyFreshWritePolicy','requires_explicit_bridge'),false)
  THEN RAISE EXCEPTION 'Activation cannot omit campus/global/compat/protocol outputs or swap build evidence' USING ERRCODE='23514';END IF;
  IF compat.state IS DISTINCT FROM whaleu_ratings.scoped_compat_state(compat) THEN RAISE EXCEPTION 'Activation compatibility state is no longer current' USING ERRCODE='23514';END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM whaleu_ratings.scoped_release_scopes x LEFT JOIN whaleu_ratings.scoped_catalog_heads h ON h.scope_key=x.scope_key WHERE x.release_id=release AND (h.catalog_id,h.head_revision,h.release_id) IS DISTINCT FROM (x.after_catalog_id,x.after_head_revision,release)) THEN RAISE EXCEPTION 'Activation scoped head CAS incomplete' USING ERRCODE='23514';END IF;
END $$;
CREATE FUNCTION whaleu_ratings.activate_rating_scopes(release uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r whaleu_ratings.scoped_releases;s whaleu_ratings.scoped_source_attestations;logical text;old uuid;compat whaleu_ratings.compat_versions;version uuid;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('whaleu:named-block-policy:v1',0));
 LOCK TABLE whaleu_ratings.scoped_source_epoch,whaleu_ratings.scope_protocol_epoch,whaleu_ratings.random_pool_epoch,whaleu_ratings.navigation_epoch IN ROW EXCLUSIVE MODE;
 SELECT * INTO r FROM whaleu_ratings.scoped_releases WHERE id=release;
 SELECT * INTO s FROM whaleu_ratings.scoped_source_attestations WHERE id=(r.cause->>'capabilitySourceId')::uuid AND revision=(r.cause->>'capabilitySourceRevision')::uuid;
 IF NOT coalesce(r.cause_kind='protocol_activation' AND r.publication_transaction=pg_current_xact_id() AND whaleu_ratings.scoped_capability_current(s.id,s.revision),false) THEN RAISE EXCEPTION 'Activation is not a fresh capability-bound release' USING ERRCODE='23514';END IF;
 PERFORM whaleu_ratings.verify_initial_scoped_legacy_inputs(release);
 PERFORM whaleu_ratings.publish_scoped_compat(release);
 FOR logical IN SELECT jsonb_array_elements_text(r.cause->'logicalScopeKeys') ORDER BY 1 LOOP
  SELECT version_id INTO old FROM whaleu_ratings.scope_protocol_heads WHERE logical_scope_key=logical FOR UPDATE;
  SELECT x.* INTO compat FROM whaleu_ratings.compat_heads h JOIN whaleu_ratings.compat_versions x ON x.id=h.version_id WHERE h.compat_key=CASE WHEN logical='global' THEN 'global_compat' ELSE 'region_compat:'||logical END;
  version:=gen_random_uuid();
  INSERT INTO whaleu_ratings.scope_protocol_versions(id,logical_scope_key,phase,previous_version_id,generation,release_id,capability_source_id,capability_source_revision,manifest)
  VALUES(version,logical,'adopted',old,(r.cause->>'generation')::uuid,release,s.id,s.revision,
   jsonb_build_object('releaseId',release,'generation',(r.cause->>'generation')::uuid,'scopeKeys',whaleu_ratings.scoped_compat_scope_keys(compat),'compatVersionId',compat.id,'capabilitySourceId',s.id,'capabilitySourceRevision',s.revision,'routesDigest',s.payload->'routesDigest','nativeDigest',s.payload->'nativeDigest','serviceDigest',s.payload->'serviceDigest','ownerEvidenceDigest',s.payload->'ownerEvidenceDigest','legacyFreshWritePolicy','requires_explicit_bridge'));
  IF old IS NULL THEN INSERT INTO whaleu_ratings.scope_protocol_heads VALUES(logical,version) ON CONFLICT DO NOTHING;
  ELSE UPDATE whaleu_ratings.scope_protocol_heads SET version_id=version WHERE logical_scope_key=logical AND version_id=old;END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'Activation protocol CAS changed' USING ERRCODE='23514';END IF;
 END LOOP;
 PERFORM whaleu_ratings.verify_scope_activation(release);
END $$;
CREATE FUNCTION whaleu_ratings.scoped_protocol_artifact_causal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v whaleu_ratings.scope_protocol_versions;
BEGIN
 IF TG_TABLE_NAME='scope_protocol_heads' THEN SELECT * INTO v FROM whaleu_ratings.scope_protocol_versions WHERE id=NEW.version_id;ELSE v:=NEW;END IF;
 IF NOT coalesce(v.publication_transaction=pg_current_xact_id() AND EXISTS(SELECT 1 FROM whaleu_ratings.scope_protocol_heads WHERE logical_scope_key=v.logical_scope_key AND version_id=v.id),false) THEN RAISE EXCEPTION 'Protocol version must be exact current fresh head' USING ERRCODE='23514';END IF;
 IF v.phase='adopted' THEN
  IF NOT EXISTS(SELECT 1 FROM whaleu_ratings.scoped_releases parent
   WHERE parent.id=v.release_id AND parent.cause_kind='protocol_activation' AND parent.publication_transaction=v.publication_transaction
   AND parent.cause->>'generation'=v.generation::text AND parent.cause->'logicalScopeKeys' @> jsonb_build_array(v.logical_scope_key)
   AND parent.cause->>'capabilitySourceId'=v.capability_source_id::text AND parent.cause->>'capabilitySourceRevision'=v.capability_source_revision::text)
  THEN RAISE EXCEPTION 'Adopted protocol lacks exact immutable fresh activation parent' USING ERRCODE='23514';END IF;
 ELSIF v.release_id IS NOT NULL OR v.capability_source_id IS NOT NULL OR v.manifest<>jsonb_build_object('phase',v.phase,'logicalScopeKey',v.logical_scope_key) THEN RAISE EXCEPTION 'Dormant readiness cannot assert active release capability' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER scoped_protocol_causal AFTER INSERT ON whaleu_ratings.scope_protocol_versions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.scoped_protocol_artifact_causal();
CREATE CONSTRAINT TRIGGER scoped_protocol_head_causal AFTER INSERT OR UPDATE ON whaleu_ratings.scope_protocol_heads DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.scoped_protocol_artifact_causal();

-- Opaque adoption has its own evidence identity. It never inserts a native
-- category_identity or alters the target's immutable category/business key.
CREATE FUNCTION whaleu_ratings.scoped_legacy_catalog_digest(catalog uuid) RETURNS text LANGUAGE sql STABLE AS $$
 SELECT whaleu_ratings.scoped_digest('legacy-catalog',jsonb_build_object('catalog',(SELECT to_jsonb(c) FROM whaleu_ratings.catalogs c WHERE id=catalog),
 'categories',coalesce((SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM whaleu_ratings.categories c WHERE catalog_id=catalog),'[]'::jsonb),
 'lineage',coalesce((SELECT jsonb_agg(to_jsonb(l)-'compat_projection_id' ORDER BY category_id) FROM whaleu_ratings.catalog_category_lineage l WHERE catalog_id=catalog),'[]'::jsonb),
 'memberships',coalesce((SELECT jsonb_agg(to_jsonb(m) ORDER BY target_id) FROM whaleu_ratings.target_memberships m WHERE catalog_id=catalog),'[]'::jsonb)))
$$;
CREATE FUNCTION whaleu_ratings.scoped_adoption_category(source uuid,revision uuid) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE s whaleu_ratings.scoped_source_attestations;m whaleu_ratings.legacy_adoption_manifests;a whaleu_ratings.scoped_adoption_identities;c whaleu_ratings.categories;review whaleu_ratings.scoped_source_attestations;e jsonb;
BEGIN
 SELECT * INTO s FROM whaleu_ratings.scoped_source_attestations WHERE id=source AND scoped_source_attestations.revision=scoped_adoption_category.revision;
 SELECT * INTO m FROM whaleu_ratings.legacy_adoption_manifests WHERE source_id=s.id AND source_revision=s.revision;
 SELECT * INTO a FROM whaleu_ratings.scoped_adoption_identities WHERE manifest_id=m.id AND entity_kind='category' AND id=(s.payload->>'identityId')::uuid;
 SELECT * INTO c FROM whaleu_ratings.categories WHERE catalog_id=m.legacy_catalog_id AND id=a.legacy_business_id;
 -- The full immutable legacy catalog digest is verified at both fresh
 -- manifest/source boundaries. Runtime per-category Review qualification uses
 -- that retained manifest and the exact original row digest, never rehashing
 -- every unrelated membership once per category/path.
 IF NOT coalesce(s.source_kind='legacy_adoption' AND s.scope_keys=m.scope_keys
 AND EXISTS(SELECT 1 FROM whaleu_ratings.catalogs original_catalog WHERE original_catalog.id=m.legacy_catalog_id AND original_catalog.sealed)
 AND a.source_row_digest=whaleu_ratings.scoped_digest('legacy-category',to_jsonb(c)) AND c.id::text=s.payload->>'categoryId'
 AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.category_identities WHERE id=c.id)
 AND EXISTS(SELECT 1 FROM whaleu_ratings.catalog_category_lineage WHERE catalog_id=c.catalog_id AND category_id=c.id AND source_kind='opaque'),false) THEN RETURN NULL;END IF;
 -- Imported Review facts remain separate. This branch consumes an exact real
 -- scoped source binding over the old body, not a copied accepted flag or a
 -- second binding that relabels the historical decision as adoption.
 SELECT * INTO review FROM whaleu_ratings.scoped_source_attestations WHERE id=(s.payload->'reviewSource'->>'sourceId')::uuid AND scoped_source_attestations.revision=(s.payload->'reviewSource'->>'sourceRevision')::uuid;
 e:=review.payload->'reviewEnvelope';
 IF NOT coalesce(s.payload->'reviewSource'->>'kind'='scoped_category_v5' AND review.source_kind='scoped_category_base'
 AND s.scope_keys<@review.scope_keys
 AND whaleu_ratings.scoped_source_current(review.id,review.revision,clock_timestamp()) AND whaleu_community.rating_scoped_category_source_current(review.id,review.revision,e)
 AND e->>'identityId'=a.id::text AND e->>'categoryId'=c.id::text
 AND e->'body'=jsonb_build_object('parentId',c.parent_id,'level',c.level,'kind',c.kind,'systemKey',c.system_key,'name',c.name,'description',c.description),false) THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('id',c.id,'parentId',c.parent_id,'level',c.level,'kind',c.kind,'systemKey',c.system_key,'isSystem',c.system_key IS NOT NULL,'originKind',c.origin_kind,'name',c.name,'description',c.description,'active',c.active,'hidden',c.hidden,'ordinal',c.ordinal::text,'identityKind','adopted','identityId',a.id);
END $$;
CREATE FUNCTION whaleu_ratings.verify_scoped_adoption(manifest uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE m whaleu_ratings.legacy_adoption_manifests;s whaleu_ratings.scoped_source_attestations;a record;expected jsonb;
BEGIN
 SELECT * INTO m FROM whaleu_ratings.legacy_adoption_manifests WHERE id=manifest;SELECT * INTO s FROM whaleu_ratings.scoped_source_attestations WHERE id=m.source_id AND revision=m.source_revision;
 IF NOT coalesce(m.publication_transaction=pg_current_xact_id() AND s.publication_transaction=m.publication_transaction AND s.source_kind='legacy_adoption'
 AND s.scope_keys=m.scope_keys AND m.legacy_digest=whaleu_ratings.scoped_legacy_catalog_digest(m.legacy_catalog_id)
 AND s.payload->>'manifestId'=m.id::text AND s.payload->'crosswalk'=m.crosswalk AND s.payload->'placement'=m.placement
 AND whaleu_ratings.scoped_source_current(s.id,s.revision,clock_timestamp()),false) THEN RAISE EXCEPTION 'Adoption manifest lacks exact complete original source' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT 1 FROM whaleu_ratings.scoped_source_attestations review
  WHERE review.id=(s.payload->'reviewSource'->>'sourceId')::uuid AND review.revision=(s.payload->'reviewSource'->>'sourceRevision')::uuid
  AND review.source_kind='scoped_category_base' AND m.scope_keys<@review.scope_keys)
 THEN RAISE EXCEPTION 'Adoption scope exceeds its exact reviewed source scope' USING ERRCODE='23514';END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('entityKind',entity_kind,'legacyBusinessId',legacy_business_id,'identityId',id,'sourceRowDigest',source_row_digest) ORDER BY entity_kind,legacy_business_id),'[]'::jsonb) INTO expected FROM whaleu_ratings.scoped_adoption_identities WHERE manifest_id=m.id;
 IF expected IS DISTINCT FROM m.crosswalk THEN RAISE EXCEPTION 'Adoption canonical crosswalk is not exact identity set' USING ERRCODE='23514';END IF;
 FOR a IN SELECT * FROM whaleu_ratings.scoped_adoption_identities WHERE manifest_id=m.id LOOP
  IF a.publication_transaction<>m.publication_transaction OR (a.entity_kind='category' AND (EXISTS(SELECT 1 FROM whaleu_ratings.category_identities WHERE id=a.legacy_business_id) OR NOT EXISTS(SELECT 1 FROM whaleu_ratings.categories c WHERE catalog_id=m.legacy_catalog_id AND id=a.legacy_business_id AND a.source_row_digest=whaleu_ratings.scoped_digest('legacy-category',to_jsonb(c)))))
   OR (a.entity_kind='target' AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.target_memberships membership JOIN whaleu_ratings.targets t ON t.id=membership.target_id WHERE membership.catalog_id=m.legacy_catalog_id AND t.id=a.legacy_business_id AND a.source_row_digest=whaleu_ratings.scoped_digest('legacy-target',to_jsonb(t))))
  THEN RAISE EXCEPTION 'Adoption identity cannot rename or fabricate a legacy row' USING ERRCODE='23514';END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM whaleu_ratings.scoped_adoption_identities identity_row
  WHERE identity_row.manifest_id=m.id AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.scoped_adoption_aliases alias_row
   WHERE alias_row.manifest_id=m.id AND alias_row.identity_id=identity_row.id))
 THEN RAISE EXCEPTION 'Adoption identity lacks its exact original alias' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM whaleu_ratings.scoped_adoption_aliases alias_row LEFT JOIN whaleu_ratings.scoped_adoption_identities i ON i.id=alias_row.identity_id WHERE alias_row.manifest_id=m.id AND NOT coalesce(alias_row.publication_transaction=m.publication_transaction AND alias_row.source_kind='legacy_catalog' AND alias_row.source_key=m.legacy_catalog_id::text AND alias_row.source_revision=m.legacy_catalog_id AND alias_row.source_row_digest=i.source_row_digest,false)) THEN RAISE EXCEPTION 'Adoption alias is not exact original source identity' USING ERRCODE='23514';END IF;
END $$;
CREATE FUNCTION whaleu_ratings.scoped_adoption_causal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE manifest uuid;parent whaleu_ratings.legacy_adoption_manifests;identity_row whaleu_ratings.scoped_adoption_identities;BEGIN
 IF TG_TABLE_NAME='legacy_adoption_manifests' THEN manifest:=NEW.id;
 ELSIF TG_TABLE_NAME='scoped_source_attestations' THEN SELECT id INTO manifest FROM whaleu_ratings.legacy_adoption_manifests WHERE source_id=NEW.id AND source_revision=NEW.revision;
 ELSE
  SELECT * INTO parent FROM whaleu_ratings.legacy_adoption_manifests WHERE id=NEW.manifest_id;
  IF NOT coalesce(parent.publication_transaction=pg_current_xact_id() AND NEW.publication_transaction=parent.publication_transaction,false)
  THEN RAISE EXCEPTION 'Adoption artifact lacks exact fresh parent' USING ERRCODE='23514';END IF;
  IF TG_TABLE_NAME='scoped_adoption_identities' THEN
   IF NOT parent.crosswalk @> jsonb_build_array(jsonb_build_object('entityKind',NEW.entity_kind,'legacyBusinessId',NEW.legacy_business_id,'identityId',NEW.id,'sourceRowDigest',NEW.source_row_digest))
   THEN RAISE EXCEPTION 'Adoption identity is absent from immutable exact crosswalk' USING ERRCODE='23514';END IF;
  ELSE
   SELECT * INTO identity_row FROM whaleu_ratings.scoped_adoption_identities WHERE id=NEW.identity_id;
   IF NOT coalesce(NEW.source_kind='legacy_catalog' AND NEW.source_key=parent.legacy_catalog_id::text
    AND NEW.source_revision=parent.legacy_catalog_id AND NEW.source_row_digest=identity_row.source_row_digest
    AND identity_row.manifest_id=parent.id AND identity_row.entity_kind=NEW.entity_kind
    AND identity_row.legacy_business_id=NEW.legacy_business_id AND identity_row.publication_transaction=parent.publication_transaction,false)
   THEN RAISE EXCEPTION 'Adoption alias differs from exact original identity' USING ERRCODE='23514';END IF;
  END IF;
  -- The immutable manifest/source boundaries verify the complete identity and
  -- alias sets. Exact crosswalk membership plus unique keys prevent appending
  -- new artifacts after an earlier SET CONSTRAINTS flush.
  RETURN NULL;
 END IF;
 PERFORM whaleu_ratings.verify_scoped_adoption(manifest);RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER scoped_adoption_source_reverse AFTER INSERT ON whaleu_ratings.scoped_source_attestations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.source_kind='legacy_adoption') EXECUTE FUNCTION whaleu_ratings.scoped_adoption_causal();
DO $$ DECLARE tab text;BEGIN FOREACH tab IN ARRAY ARRAY['legacy_adoption_manifests','scoped_adoption_identities','scoped_adoption_aliases'] LOOP
 EXECUTE format('CREATE CONSTRAINT TRIGGER scoped_adoption_causal AFTER INSERT ON whaleu_ratings.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.scoped_adoption_causal()',tab);
END LOOP;END $$;

CREATE FUNCTION whaleu_ratings.scoped_placement_source_causal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s whaleu_ratings.scoped_source_attestations;category whaleu_ratings.category_scope_placements;target whaleu_ratings.target_scope_placements;rows integer;key text;logical text;expected jsonb;affected_keys text[];
BEGIN
 IF TG_TABLE_NAME='scoped_source_attestations' THEN s:=NEW;
 ELSIF TG_TABLE_NAME='scoped_source_heads' THEN SELECT * INTO s FROM whaleu_ratings.scoped_source_attestations WHERE id=NEW.source_id AND revision=NEW.source_revision;
 ELSE SELECT * INTO s FROM whaleu_ratings.scoped_source_attestations WHERE id=NEW.source_id AND revision=NEW.source_revision;END IF;
 IF NOT coalesce(s.publication_transaction=pg_current_xact_id(),false) THEN RAISE EXCEPTION 'Scoped source artifact cannot be added to historical issuance' USING ERRCODE='23514';END IF;
 IF s.source_kind='scoped_category_scope' THEN
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
DO $$ DECLARE tab text;BEGIN FOREACH tab IN ARRAY ARRAY['scoped_source_attestations','scoped_source_heads','category_scope_placements','target_scope_placements'] LOOP
 EXECUTE format('CREATE CONSTRAINT TRIGGER scoped_placement_source_causal AFTER INSERT OR UPDATE ON whaleu_ratings.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.scoped_placement_source_causal()',tab);
END LOOP;END $$;
CREATE FUNCTION whaleu_ratings.scoped_request_writer() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('whaleu:named-block-policy:v1',0));RETURN NULL;
END $$;
DO $$ DECLARE tab text;BEGIN FOREACH tab IN ARRAY ARRAY['scoped_contexts','scoped_command_preparations','scoped_command_outcomes','scoped_command_causes'] LOOP
 EXECUTE format('CREATE TRIGGER a00_scoped_request_writer BEFORE INSERT OR UPDATE OR DELETE ON whaleu_ratings.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.scoped_request_writer()',tab);
END LOOP;END $$;

-- Explicit old-column copy preserves every legacy branch after nullable typed extension.
CREATE OR REPLACE FUNCTION whaleu_ratings.category_command_publish(actor uuid,request uuid,context text,decision uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE p whaleu_ratings.category_command_preparations;e whaleu_ratings.category_command_transitions;q whaleu_ratings.requests;
 d whaleu_community.rating_approval_decisions;n jsonb;c jsonb;before_id uuid;after_id uuid;ordinal bigint;published_receipt jsonb;node_receipts jsonb;catalog_receipts jsonb;
BEGIN
 -- The service already enters Safety exclusive before any owner proof. Keep
 -- independent direct calls in the identical order, never pool -> Safety.
 PERFORM pg_advisory_xact_lock(hashtextextended('whaleu:named-block-policy:v1',0));
 LOCK TABLE whaleu_ratings.random_pool_epoch,whaleu_ratings.navigation_epoch IN ROW EXCLUSIVE MODE;
 SELECT * INTO p FROM whaleu_ratings.category_command_preparations WHERE account_id=actor AND request_id=request FOR SHARE NOWAIT;
 IF p.account_id IS NULL THEN RAISE EXCEPTION 'Category preparation absent' USING ERRCODE='23514';END IF;
 INSERT INTO whaleu_ratings.requests(account_id,request_id,operation,intent_hash) VALUES(actor,request,'create_categories',p.intent_hash) ON CONFLICT DO NOTHING;
 SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=actor AND request_id=request FOR UPDATE NOWAIT;
 IF (q.operation,q.intent_hash) IS DISTINCT FROM ('create_categories',p.intent_hash) THEN RAISE EXCEPTION 'Category command namespace conflict' USING ERRCODE='23514';END IF;
 IF q.receipt IS NOT NULL THEN RETURN q.receipt;END IF;
 IF p.context_revision IS DISTINCT FROM context THEN RAISE EXCEPTION 'Category preparation context changed' USING ERRCODE='23514';END IF;
 SELECT * INTO d FROM whaleu_community.rating_approval_decisions WHERE id=decision;
 IF NOT coalesce(d.account_id=actor AND d.operation='publish_rating_categories' AND d.envelope_version=4 AND d.envelope=p.envelope,false)
 THEN RAISE EXCEPTION 'Category Review envelope differs' USING ERRCODE='23514';END IF;
 INSERT INTO whaleu_ratings.category_command_transitions(release_id,actor_account_id,request_id,intent_hash,intent,context_revision)
 VALUES(p.release_id,actor,request,p.intent_hash,p.intent,p.context_revision) RETURNING * INTO e;
 INSERT INTO whaleu_ratings.category_scope_versions(id,region_id,topology_snapshot_id,campus_ids,release_id)
 VALUES(p.scope_version_id,(p.intent->>'regionId')::uuid,p.topology_snapshot_id,p.campus_ids,e.release_id);
 FOR n IN SELECT value FROM jsonb_array_elements(p.nodes) LOOP
  INSERT INTO whaleu_ratings.category_identities(id,creator_id,kind,is_system,system_key,source_kind,creation_release_id)
  VALUES((n->>'id')::uuid,actor,'general',false,NULL,'native',e.release_id);
  INSERT INTO whaleu_ratings.category_base_versions(category_id,revision,parent_id,level,name,description,active,is_global,scope_version_id,release_id,envelope,published_at)
  VALUES((n->>'id')::uuid,(n->>'revision')::uuid,(n->>'parentId')::uuid,(n->>'level')::smallint,n->>'name',n->>'description',true,p.intent->'regionId'='null'::jsonb,p.scope_version_id,e.release_id,p.envelope,e.occurred_at);
  INSERT INTO whaleu_ratings.category_base_heads(category_id,revision) VALUES((n->>'id')::uuid,(n->>'revision')::uuid);
  INSERT INTO whaleu_community.rating_category_base_bindings(category_id,base_revision,release_id,decision_id,account_id,operation,envelope_version,digest,envelope,scope)
  VALUES((n->>'id')::uuid,(n->>'revision')::uuid,e.release_id,d.id,actor,d.operation,d.envelope_version,d.digest,d.envelope,d.envelope->'scope');
 END LOOP;
 FOR c IN SELECT value FROM jsonb_array_elements(p.catalogs) LOOP
  before_id:=(c->>'beforeCatalogId')::uuid;after_id:=(c->>'afterCatalogId')::uuid;
  INSERT INTO whaleu_ratings.catalogs(id,region_id,coverage,provenance,source_reference,policy_reference,effective_at,valid_until)
  VALUES(after_id,(c->>'regionId')::uuid,'complete','accepted','rating-category-create:'||actor::text||':'||request::text,'rating-category-native-v1',e.occurred_at,
   (SELECT valid_until FROM whaleu_ratings.catalogs WHERE id=before_id));
  INSERT INTO whaleu_ratings.category_release_catalogs(release_id,scope_key,region_id,before_catalog_id,after_catalog_id,campus_ids)
  VALUES(e.release_id,coalesce(c->>'regionId','global'),(c->>'regionId')::uuid,before_id,after_id,ARRAY(SELECT v::uuid FROM jsonb_array_elements_text(c->'campusIds') x(v)));
  INSERT INTO whaleu_ratings.catalog_materializations(catalog_id,source_kind,release_id,before_catalog_id,topology_snapshot_id,campus_ids)
  VALUES(after_id,'category_release',e.release_id,before_id,p.topology_snapshot_id,ARRAY(SELECT v::uuid FROM jsonb_array_elements_text(c->'campusIds') x(v)));
  INSERT INTO whaleu_ratings.categories SELECT after_id,old.id,old.revision,old.parent_id,old.level,old.origin_kind,old.kind,old.system_key,old.name,old.description,old.active,old.hidden,old.ordinal
   FROM whaleu_ratings.categories old WHERE old.catalog_id=before_id ORDER BY old.level,old.ordinal;
  INSERT INTO whaleu_ratings.catalog_category_lineage(catalog_id,category_id,effective_revision,source_kind,base_revision,scope_version_id,topology_snapshot_id,compat_projection_id) SELECT after_id,category_id,effective_revision,source_kind,base_revision,scope_version_id,topology_snapshot_id,compat_projection_id
   FROM whaleu_ratings.catalog_category_lineage WHERE catalog_id=before_id;
  INSERT INTO whaleu_ratings.target_memberships SELECT after_id,old.target_id,old.category_id,old.ordinal FROM whaleu_ratings.target_memberships old WHERE old.catalog_id=before_id;
  SELECT coalesce(max(x.ordinal),-1)+1 INTO ordinal FROM whaleu_ratings.categories x WHERE catalog_id=before_id;
  FOR n IN SELECT value FROM jsonb_array_elements(p.nodes) LOOP
   INSERT INTO whaleu_ratings.categories(catalog_id,id,revision,parent_id,level,origin_kind,kind,system_key,name,description,active,hidden,ordinal)
   VALUES(after_id,(n->>'id')::uuid,(n->>'revision')::uuid,(n->>'parentId')::uuid,(n->>'level')::smallint,
    CASE WHEN p.intent->'regionId'='null'::jsonb THEN 'global' ELSE 'regional' END,'general',NULL,n->>'name',n->>'description',true,false,ordinal);
   INSERT INTO whaleu_ratings.catalog_category_lineage(catalog_id,category_id,effective_revision,source_kind,base_revision,scope_version_id,topology_snapshot_id)
   VALUES(after_id,(n->>'id')::uuid,(n->>'revision')::uuid,'native',(n->>'revision')::uuid,p.scope_version_id,p.topology_snapshot_id);
   ordinal:=ordinal+1;
  END LOOP;
  UPDATE whaleu_ratings.catalogs SET sealed=true WHERE id=after_id;
  IF before_id IS NULL THEN
   INSERT INTO whaleu_ratings.catalog_heads(scope_key,region_id,catalog_id) VALUES(coalesce(c->>'regionId','global'),(c->>'regionId')::uuid,after_id);
  ELSE
   UPDATE whaleu_ratings.catalog_heads SET catalog_id=after_id WHERE scope_key=coalesce(c->>'regionId','global') AND catalog_id=before_id;
   IF NOT FOUND THEN RAISE EXCEPTION 'Category publication lost catalog CAS' USING ERRCODE='23514';END IF;
  END IF;
 END LOOP;
 SELECT jsonb_agg(value-ARRAY['name','description','scopeVersionId'] ORDER BY ord) INTO node_receipts FROM jsonb_array_elements(p.nodes) WITH ORDINALITY x(value,ord);
 SELECT jsonb_agg(jsonb_build_object('regionId',value->'regionId','catalogRevision',value->'afterCatalogId') ORDER BY ord) INTO catalog_receipts FROM jsonb_array_elements(p.catalogs) WITH ORDINALITY x(value,ord);
 published_receipt:=jsonb_build_object('requestId',request,'operation','create_categories','outcome','applied','releaseId',e.release_id,'categories',node_receipts,'catalogs',catalog_receipts,
  'occurredAt',to_char(e.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
 UPDATE whaleu_ratings.requests SET receipt=published_receipt WHERE account_id=actor AND request_id=category_command_publish.request;
 RETURN published_receipt;
END $$;

-- Exact old request bridge, preserving original legacy outcomes and ledgers.
-- Append after 0065. Genuine original legacy requests only; no scoped preparation.
CREATE FUNCTION whaleu_ratings.legacy_bridge_intent_hash(op text,intent jsonb) RETURNS text LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE WHEN op IN ('set_score','create_comment','create_reply','set_comment_like','set_reply_like','set_target_subscription','create_target','edit_target','create_categories') THEN
 encode(sha256(convert_to(CASE op
 WHEN 'set_score' THEN 'whaleu:rating-command:v1' WHEN 'create_comment' THEN 'whaleu:rating-command:v1'
 WHEN 'create_reply' THEN 'whaleu:rating-reply-command:v1'
 WHEN 'set_comment_like' THEN 'whaleu:rating-like-command:v1' WHEN 'set_reply_like' THEN 'whaleu:rating-like-command:v1'
 WHEN 'set_target_subscription' THEN 'whaleu:rating-subscription-command:v1'
 WHEN 'create_target' THEN 'whaleu:rating-target-create:v1' WHEN 'edit_target' THEN 'whaleu:rating-target-edit:v1'
 WHEN 'create_categories' THEN 'whaleu:rating-category-create:v1' END||chr(10)||whaleu_ratings.creation_canonical_json(jsonb_build_object('operation',op,'intent',intent)),'UTF8')),'hex') ELSE NULL END
$$;
CREATE FUNCTION whaleu_ratings.legacy_bridge_observation(logical text,op text) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE p whaleu_ratings.scope_protocol_versions;v whaleu_ratings.compat_versions;s whaleu_ratings.scoped_source_attestations;keys text[];
BEGIN
 SELECT x.* INTO p FROM whaleu_ratings.scope_protocol_heads h JOIN whaleu_ratings.scope_protocol_versions x ON x.id=h.version_id WHERE h.logical_scope_key=logical;
 IF p.phase IS DISTINCT FROM 'adopted' THEN RETURN NULL;END IF;
 SELECT x.* INTO v FROM whaleu_ratings.compat_heads h JOIN whaleu_ratings.compat_versions x ON x.id=h.version_id WHERE h.compat_key=CASE WHEN logical='global' THEN 'global_compat' ELSE 'region_compat:'||logical END;
 SELECT x.* INTO s FROM whaleu_ratings.scoped_source_heads h JOIN whaleu_ratings.scoped_source_attestations x ON (x.id,x.revision)=(h.source_id,h.source_revision) WHERE h.source_kind='native_v1_compat_write' AND h.source_key=logical;
 keys:=whaleu_ratings.scoped_compat_scope_keys(v);
 IF NOT coalesce(whaleu_ratings.scoped_compat_current(v.id) AND whaleu_ratings.scoped_source_current(s.id,s.revision,clock_timestamp())
  AND s.scope_keys=keys AND s.payload->>'policyVersion'='native-v1-compat-write-v1' AND s.payload->'enabled'='true'::jsonb
  AND s.payload->>'logicalScopeKey'=logical AND s.payload->'scopeKeys'=to_jsonb(keys)
  AND jsonb_typeof(s.payload->'operations')='array' AND (op IS NULL OR s.payload->'operations' ? op)
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(s.payload->'operations') x WHERE x NOT IN ('set_score','create_comment','create_reply','set_comment_like','set_reply_like','set_target_subscription','create_target','edit_target','create_categories'))
  AND s.payload->>'placementPolicy'='exact_legacy_domain' AND s.payload->>'categoryPolicy'='append_native_only'
  AND whaleu_community.rating_scoped_keys(s.payload,ARRAY['policyVersion','enabled','logicalScopeKey','scopeKeys','operations','placementPolicy','categoryPolicy'])
  AND jsonb_array_length(s.payload->'operations') BETWEEN 1 AND 9
  AND (SELECT count(DISTINCT operation) FROM jsonb_array_elements_text(s.payload->'operations') operation)=jsonb_array_length(s.payload->'operations'),false)
 THEN RAISE EXCEPTION 'Adopted legacy fresh execution lacks exact native_v1_compat_write source' USING ERRCODE='23514';END IF;
 RETURN jsonb_build_object('logicalScopeKey',logical,'protocolVersionId',p.id,'protocolGeneration',p.generation,'compatVersionId',v.id,
  'legacyCatalogId',v.legacy_catalog_id,'scopeKeys',keys,'scopedTuples',v.scoped_tuples,'sourceVector',whaleu_ratings.scoped_current_source_vector(keys),
  'policySourceId',s.id,'policySourceRevision',s.revision,'policyDigest',s.digest,'validUntil',least(s.valid_until,v.valid_until));
END $$;
CREATE FUNCTION whaleu_ratings.legacy_score_before(actor uuid,operation text,intent jsonb) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN operation='set_score' THEN coalesce((SELECT jsonb_build_object('score',score,'revision',revision)
  FROM whaleu_ratings.scores WHERE account_id=actor AND target_id=(intent->>'targetId')::uuid),'null'::jsonb) ELSE 'null'::jsonb END
$$;
CREATE FUNCTION whaleu_ratings.legacy_bridge_guard(e whaleu_ratings.scoped_command_causes) RETURNS void LANGUAGE plpgsql AS $$
DECLARE q whaleu_ratings.requests;d jsonb;expected jsonb;legacy_intent jsonb:=e.proof->'intent';catalogs jsonb;logical text;actual jsonb;
BEGIN
 SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=e.account_id AND request_id=e.request_id FOR UPDATE NOWAIT;
 IF q.operation IN ('set_score','create_comment','create_reply','set_comment_like','set_reply_like','set_target_subscription') AND NOT whaleu_ratings.legacy_original_intent_valid(q.operation,e.proof->'intent') THEN RAISE EXCEPTION 'Original legacy bridge intent shape invalid' USING ERRCODE='23514';END IF;
 IF NOT coalesce(e.cause_kind='legacy_bridge' AND e.mutation_transaction=pg_current_xact_id() AND q.receipt IS NULL
  AND e.proof->'version'='1'::jsonb AND e.proof->>'operation'=q.operation AND e.proof->>'intentHash'=q.intent_hash
  AND legacy_intent->>'clientRequestId'=q.request_id::text AND whaleu_ratings.legacy_bridge_intent_hash(q.operation,legacy_intent)=q.intent_hash
  AND whaleu_community.rating_scoped_keys(e.proof,ARRAY['version','operation','intentHash','intent','domains','legacyCatalogs','scoreBefore'])
  AND e.proof->'scoreBefore'=whaleu_ratings.legacy_score_before(e.account_id,q.operation,legacy_intent)
  AND jsonb_typeof(e.proof->'domains')='array' AND jsonb_array_length(e.proof->'domains') BETWEEN 1 AND 33
  AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.scoped_command_preparations WHERE account_id=q.account_id AND request_id=q.request_id)
  AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.scoped_command_causes WHERE account_id=q.account_id AND request_id=q.request_id),false)
 THEN RAISE EXCEPTION 'Legacy bridge needs one original fresh legacy request and original hash' USING ERRCODE='23514';END IF;
 IF q.operation='create_target' THEN
  IF NOT EXISTS(SELECT 1 FROM whaleu_ratings.target_preparations p WHERE p.account_id=q.account_id AND p.request_id=q.request_id AND p.intent=legacy_intent AND p.intent_hash=q.intent_hash AND p.valid_until>clock_timestamp())
   OR jsonb_array_length(e.proof->'legacyCatalogs')<>1 THEN RAISE EXCEPTION 'Legacy M1 bridge differs from original preparation' USING ERRCODE='23514';END IF;
  catalogs:=e.proof->'legacyCatalogs';
  IF NOT coalesce(catalogs->0->>'logicalScopeKey'=coalesce(legacy_intent->>'regionId','global') AND catalogs->0->'beforeCatalogId'=legacy_intent->'expectedCatalogRevision'
   AND whaleu_community.rating_scoped_ids(catalogs->0,ARRAY['beforeCatalogId','afterCatalogId']) AND catalogs->0->'beforeCatalogId'<>catalogs->0->'afterCatalogId'
   AND whaleu_community.rating_scoped_keys(catalogs->0,ARRAY['logicalScopeKey','beforeCatalogId','afterCatalogId']),false) THEN RAISE EXCEPTION 'Legacy M1 bridge output plan differs' USING ERRCODE='23514';END IF;
 ELSIF q.operation='create_categories' THEN
  SELECT jsonb_agg(jsonb_build_object('logicalScopeKey',coalesce(c->>'regionId','global'),'beforeCatalogId',c->'beforeCatalogId','afterCatalogId',c->'afterCatalogId') ORDER BY coalesce(c->>'regionId','global')) INTO catalogs
   FROM whaleu_ratings.category_command_preparations p CROSS JOIN LATERAL jsonb_array_elements(p.catalogs) c WHERE p.account_id=q.account_id AND p.request_id=q.request_id AND p.intent=legacy_intent AND p.intent_hash=q.intent_hash AND p.valid_until>clock_timestamp();
  IF catalogs IS NULL OR catalogs<>e.proof->'legacyCatalogs' THEN RAISE EXCEPTION 'Legacy M3A bridge differs from original complete output plan' USING ERRCODE='23514';END IF;
 ELSE
  IF e.proof->'legacyCatalogs'<>'[]'::jsonb THEN RAISE EXCEPTION 'Noncatalog legacy command cannot publish catalogs' USING ERRCODE='23514';END IF;
  IF q.operation='edit_target' AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.target_edit_preparations p WHERE p.account_id=q.account_id AND p.request_id=q.request_id AND p.intent=legacy_intent AND p.intent_hash=q.intent_hash AND p.valid_until>clock_timestamp()) THEN RAISE EXCEPTION 'Legacy M2 bridge differs from original preparation' USING ERRCODE='23514';END IF;
  catalogs:=jsonb_build_array(jsonb_build_object('logicalScopeKey',coalesce(legacy_intent->>'regionId','global')));
 END IF;
 SELECT coalesce(jsonb_agg(observation ORDER BY logical_key),'[]'::jsonb) INTO expected FROM (
  SELECT c->>'logicalScopeKey' logical_key,whaleu_ratings.legacy_bridge_observation(c->>'logicalScopeKey',q.operation) observation FROM jsonb_array_elements(catalogs) c
 ) domains WHERE observation IS NOT NULL;
 IF expected IS DISTINCT FROM e.proof->'domains' THEN RAISE EXCEPTION 'Legacy bridge omitted or substituted a complete current adopted domain' USING ERRCODE='23514';END IF;
 FOR d IN SELECT value FROM jsonb_array_elements(expected) LOOP
  logical:=d->>'logicalScopeKey';
  IF q.operation IN ('create_target','create_categories') AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(catalogs) c WHERE c->>'logicalScopeKey'=logical AND c->'beforeCatalogId'=d->'legacyCatalogId') THEN RAISE EXCEPTION 'Legacy bridge old head differs from original CAS' USING ERRCODE='23514';END IF;
 END LOOP;
END $$;
CREATE FUNCTION whaleu_ratings.begin_legacy_scoped_bridge(actor uuid,request uuid,intent jsonb,catalog_plan jsonb DEFAULT '[]'::jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE q whaleu_ratings.requests;proof jsonb;domains jsonb;catalogs jsonb;keys text[];id uuid:=gen_random_uuid();revision uuid:=gen_random_uuid();
BEGIN
 SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=actor AND request_id=request FOR UPDATE NOWAIT;
 IF q.operation='create_categories' THEN
  SELECT jsonb_agg(jsonb_build_object('logicalScopeKey',coalesce(c->>'regionId','global'),'beforeCatalogId',c->'beforeCatalogId','afterCatalogId',c->'afterCatalogId') ORDER BY coalesce(c->>'regionId','global')) INTO catalogs FROM whaleu_ratings.category_command_preparations p CROSS JOIN LATERAL jsonb_array_elements(p.catalogs) c WHERE p.account_id=actor AND p.request_id=request;
 ELSIF q.operation='create_target' THEN catalogs:=catalog_plan;ELSE catalogs:='[]'::jsonb;END IF;
 SELECT coalesce(jsonb_agg(observation ORDER BY logical),'[]'::jsonb) INTO domains FROM (
  SELECT logical,whaleu_ratings.legacy_bridge_observation(logical,q.operation) observation FROM (
   SELECT c->>'logicalScopeKey' logical FROM jsonb_array_elements(catalogs) c
   UNION SELECT coalesce(intent->>'regionId','global') WHERE q.operation NOT IN ('create_target','create_categories')
  ) keys
 ) observed WHERE observation IS NOT NULL;
 IF domains='[]'::jsonb THEN RETURN whaleu_ratings.begin_legacy_boundary(actor,request,intent);END IF;
 proof:=jsonb_build_object('version',1,'operation',q.operation,'intentHash',q.intent_hash,'intent',intent,'domains',domains,'legacyCatalogs',catalogs,'scoreBefore',whaleu_ratings.legacy_score_before(actor,q.operation,intent));
 INSERT INTO whaleu_ratings.scoped_command_causes(account_id,request_id,cause_kind,artifact_id,artifact_revision,proof) VALUES(actor,request,'legacy_bridge',id,revision,proof);
 RETURN jsonb_build_object('bridgeId',id,'revision',revision,'proof',proof);
END $$;

-- Copied compat-effective rows keep the exact historical lineage pointer. Their
-- provenance remains the original immutable canonical projection; the actual
-- M1/M3A materialization remains target_create/category_release, respectively.
CREATE FUNCTION whaleu_ratings.legacy_bridge_catalog_sources_complete(catalog uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT coalesce((SELECT c.sealed AND m.source_kind IN ('target_create','category_release')
 AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.categories a LEFT JOIN whaleu_ratings.catalog_category_lineage l ON (l.catalog_id,l.category_id)=(a.catalog_id,a.id)
 LEFT JOIN whaleu_ratings.category_base_versions b ON (b.category_id,b.revision)=(l.category_id,l.base_revision)
 LEFT JOIN whaleu_ratings.category_identities i ON i.id=b.category_id LEFT JOIN whaleu_ratings.category_scope_versions s ON s.id=b.scope_version_id
 WHERE a.catalog_id=c.id AND NOT coalesce(l.effective_revision=a.revision AND (
 (l.source_kind='opaque' AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.category_identities n WHERE n.id=a.id)) OR
 (l.source_kind='native' AND l.base_revision=a.revision AND l.scope_version_id=b.scope_version_id AND l.topology_snapshot_id=s.topology_snapshot_id
 AND (b.parent_id,b.level,b.name,b.description,b.active) IS NOT DISTINCT FROM (a.parent_id,a.level,a.name,a.description,a.active)
 AND NOT a.hidden AND a.kind=i.kind AND a.system_key IS NULL AND NOT i.is_system AND a.origin_kind=CASE WHEN b.is_global THEN 'global' ELSE 'regional' END AND b.is_global=(s.region_id IS NULL)) OR
 (l.source_kind='compat_effective' AND EXISTS(SELECT 1 FROM whaleu_ratings.compat_projection_manifests p
 JOIN whaleu_ratings.categories original ON original.catalog_id=p.after_catalog_id AND original.id=a.id
 JOIN whaleu_ratings.catalog_category_lineage original_line ON (original_line.catalog_id,original_line.category_id)=(original.catalog_id,original.id)
 JOIN whaleu_ratings.categories predecessor ON predecessor.catalog_id=m.before_catalog_id AND predecessor.id=a.id
 JOIN whaleu_ratings.catalog_category_lineage predecessor_line ON (predecessor_line.catalog_id,predecessor_line.category_id)=(predecessor.catalog_id,predecessor.id)
 WHERE p.id=l.compat_projection_id AND whaleu_ratings.compat_projection_sources_complete(p.id)
 AND to_jsonb(original)-'catalog_id'=to_jsonb(a)-'catalog_id' AND to_jsonb(original_line)-'catalog_id'=to_jsonb(l)-'catalog_id'
 AND to_jsonb(predecessor)-'catalog_id'=to_jsonb(a)-'catalog_id' AND to_jsonb(predecessor_line)-'catalog_id'=to_jsonb(l)-'catalog_id'))),false))
 FROM whaleu_ratings.catalogs c JOIN whaleu_ratings.catalog_materializations m ON m.catalog_id=c.id WHERE c.id=catalog),false)
$$;
CREATE FUNCTION whaleu_ratings.legacy_bridge_native_category(source uuid,revision uuid) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE s whaleu_ratings.scoped_source_attestations;e whaleu_ratings.scoped_command_causes;q whaleu_ratings.requests;c whaleu_ratings.categories;l whaleu_ratings.catalog_category_lineage;b whaleu_ratings.category_base_versions;
BEGIN
 SELECT * INTO s FROM whaleu_ratings.scoped_source_attestations WHERE id=source AND scoped_source_attestations.revision=legacy_bridge_native_category.revision;
 SELECT * INTO e FROM whaleu_ratings.scoped_command_causes WHERE cause_kind='legacy_bridge' AND artifact_id=(s.payload->>'bridgeId')::uuid;
 SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=e.account_id AND request_id=e.request_id;
 SELECT * INTO c FROM whaleu_ratings.categories WHERE catalog_id=(s.payload->>'legacyAfterCatalogId')::uuid AND id=(s.payload->>'categoryId')::uuid;
 SELECT * INTO l FROM whaleu_ratings.catalog_category_lineage WHERE catalog_id=c.catalog_id AND category_id=c.id;
 SELECT * INTO b FROM whaleu_ratings.category_base_versions WHERE category_id=c.id AND category_base_versions.revision=l.base_revision;
 IF NOT coalesce(s.issuer='ratings-legacy-bridge' AND s.source_kind='m3a_native_bridge' AND q.operation='create_categories' AND q.receipt->>'outcome'='applied'
  AND e.proof->>'intentHash'=q.intent_hash AND e.mutation_transaction=s.publication_transaction AND b.publication_transaction=e.mutation_transaction
  AND c.revision::text=s.payload->>'categoryRevision' AND l.source_kind='native' AND b.revision=c.revision
  AND EXISTS(SELECT 1 FROM whaleu_ratings.category_command_preparations p WHERE p.account_id=e.account_id AND p.request_id=e.request_id AND p.release_id=b.release_id AND p.nodes @> jsonb_build_array(jsonb_build_object('id',c.id,'revision',c.revision)))
  AND EXISTS(SELECT 1 FROM jsonb_array_elements(e.proof->'legacyCatalogs') output WHERE output->>'afterCatalogId'=c.catalog_id::text)
  AND EXISTS(SELECT 1 FROM whaleu_ratings.category_base_heads WHERE category_id=c.id AND category_base_heads.revision=b.revision)
  AND whaleu_community.rating_category_base_current(c.id,b.revision,b.envelope),false) THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('id',c.id,'parentId',c.parent_id,'level',c.level,'kind',c.kind,'systemKey',c.system_key,'isSystem',c.system_key IS NOT NULL,'originKind',c.origin_kind,'name',c.name,'description',c.description,'active',c.active,'hidden',c.hidden,'ordinal',c.ordinal::text,'identityKind','native_bridge','identityId',c.id);
END $$;
CREATE FUNCTION whaleu_ratings.legacy_bridge_issue_source(bridge uuid,kind text,key text,keys text[],body jsonb,deadline timestamptz) RETURNS whaleu_ratings.scoped_source_attestations LANGUAGE plpgsql AS $$
DECLARE e whaleu_ratings.scoped_command_causes;s whaleu_ratings.scoped_source_attestations;old whaleu_ratings.scoped_source_attestations;at timestamptz:=clock_timestamp();
BEGIN
 SELECT * INTO e FROM whaleu_ratings.scoped_command_causes WHERE cause_kind='legacy_bridge' AND artifact_id=bridge;
 IF NOT coalesce(e.mutation_transaction=pg_current_xact_id() AND kind IN ('m3a_native_bridge','scoped_category_scope','scoped_target_placement','scope_absence'),false) THEN RAISE EXCEPTION 'Unknown legacy bridge derivative issuer' USING ERRCODE='23514';END IF;
 SELECT x.* INTO old FROM whaleu_ratings.scoped_source_heads h JOIN whaleu_ratings.scoped_source_attestations x ON (x.id,x.revision)=(h.source_id,h.source_revision) WHERE h.source_kind=kind AND h.source_key=key FOR UPDATE OF h;
 body:=body||jsonb_build_object('bridgeId',bridge);
 s.id:=gen_random_uuid();s.revision:=gen_random_uuid();s.source_kind:=kind;s.source_key:=key;s.scope_keys:=keys;s.payload:=body;
 s.digest:=whaleu_ratings.scoped_digest('source',jsonb_build_object('id',s.id,'revision',s.revision,'kind',kind,'key',key,'scopeKeys',keys,'payload',body));
 s.coverage:='complete';s.provenance:='accepted';s.issuer:='ratings-legacy-bridge';s.source_reference:='rating-legacy-bridge:'||bridge::text;s.policy_reference:='native-v1-compat-write-v1';
 s.effective_at:=greatest(at,old.effective_at+interval '1 microsecond');s.valid_until:=deadline;s.publication_transaction:=pg_current_xact_id();
 INSERT INTO whaleu_ratings.scoped_source_attestations SELECT(s).*;
 INSERT INTO whaleu_ratings.scoped_source_heads VALUES(kind,key,s.id,s.revision) ON CONFLICT(source_kind,source_key) DO UPDATE SET source_id=excluded.source_id,source_revision=excluded.source_revision WHERE scoped_source_heads.source_id=old.id AND scoped_source_heads.source_revision=old.revision;
 IF NOT FOUND THEN RAISE EXCEPTION 'Legacy bridge source CAS changed' USING ERRCODE='23514';END IF;
 RETURN s;
END $$;
CREATE FUNCTION whaleu_ratings.legacy_bridge_sources(actor uuid,request uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE e whaleu_ratings.scoped_command_causes;q whaleu_ratings.requests;d jsonb;node jsonb;output jsonb;keys text[];key text;old whaleu_ratings.scoped_source_attestations;s whaleu_ratings.scoped_source_attestations;base whaleu_ratings.scoped_source_attestations;place uuid;payload jsonb;p whaleu_ratings.target_preparations;deadline timestamptz;nodes jsonb;
BEGIN
 SELECT * INTO e FROM whaleu_ratings.scoped_command_causes WHERE account_id=actor AND request_id=request AND cause_kind='legacy_bridge';
 SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=actor AND request_id=request;
 IF e.artifact_id IS NULL THEN RETURN;END IF;
 IF NOT coalesce(e.mutation_transaction=pg_current_xact_id() AND q.receipt->>'outcome'='applied' AND q.operation IN ('create_target','create_categories') AND q.intent_hash=e.proof->>'intentHash',false) THEN RAISE EXCEPTION 'Legacy catalog derivative requires original applied command in this transaction' USING ERRCODE='23514';END IF;
 SELECT min((x->>'validUntil')::timestamptz) INTO deadline FROM jsonb_array_elements(e.proof->'domains') x;
 IF q.operation='create_target' THEN
  SELECT * INTO p FROM whaleu_ratings.target_preparations WHERE account_id=actor AND request_id=request;
  SELECT array_agg(scope_item.scope_key ORDER BY scope_item.scope_key COLLATE "C") INTO keys FROM jsonb_array_elements(e.proof->'domains') x CROSS JOIN LATERAL jsonb_array_elements_text(x->'scopeKeys') AS scope_item(scope_key);
  s:=whaleu_ratings.legacy_bridge_issue_source(e.artifact_id,'scoped_target_placement',p.target_id::text,keys,jsonb_build_object('targetId',p.target_id,'categoryId',p.intent->'categoryId'),deadline);
  INSERT INTO whaleu_ratings.target_scope_placements(placement_revision,target_id,scope_keys,source_id,source_revision) VALUES(gen_random_uuid(),p.target_id,keys,s.id,s.revision);
 ELSE
  SELECT x.nodes INTO nodes FROM whaleu_ratings.category_command_preparations x WHERE account_id=actor AND request_id=request;
  FOR d IN SELECT value FROM jsonb_array_elements(e.proof->'domains') LOOP
   SELECT value INTO output FROM jsonb_array_elements(e.proof->'legacyCatalogs') WHERE value->'logicalScopeKey'=d->'logicalScopeKey';
   keys:=ARRAY(SELECT jsonb_array_elements_text(d->'scopeKeys'));
   FOR node IN SELECT value FROM jsonb_array_elements(nodes) LOOP
    base:=whaleu_ratings.legacy_bridge_issue_source(e.artifact_id,'m3a_native_bridge','bridge-category:'||(node->>'id')||':'||(d->>'logicalScopeKey'),keys,
     jsonb_build_object('categoryId',node->'id','categoryRevision',node->'revision','legacyAfterCatalogId',output->'afterCatalogId'),deadline);
    place:=gen_random_uuid();payload:=jsonb_build_object('categoryId',node->'id','baseSourceId',base.id,'baseSourceRevision',base.revision,'placementRevision',place,'scopeKeys',keys,
     'placement',CASE WHEN keys=ARRAY['global'] THEN jsonb_build_object('kind','global') ELSE jsonb_build_object('kind','campuses','campusIds',ARRAY(SELECT substring(k from 8)::uuid FROM unnest(keys) k ORDER BY k)) END);
    s:=whaleu_ratings.legacy_bridge_issue_source(e.artifact_id,'scoped_category_scope','bridge-placement:'||(node->>'id')||':'||(d->>'logicalScopeKey'),keys,payload,deadline);
    INSERT INTO whaleu_ratings.category_scope_placements(placement_revision,category_id,base_source_id,base_source_revision,scope_keys,source_id,source_revision) VALUES(place,(node->>'id')::uuid,base.id,base.revision,keys,s.id,s.revision);
   END LOOP;
  END LOOP;
 END IF;
 FOR d IN SELECT value FROM jsonb_array_elements(e.proof->'domains') LOOP
  FOR key IN SELECT jsonb_array_elements_text(d->'scopeKeys') LOOP
   SELECT src.* INTO old FROM whaleu_ratings.scoped_source_heads h JOIN whaleu_ratings.scoped_source_attestations src ON (src.id,src.revision)=(h.source_id,h.source_revision) WHERE h.source_kind='scope_absence' AND h.source_key=key FOR UPDATE OF h;
   IF NOT coalesce(whaleu_ratings.scoped_source_current(old.id,old.revision,clock_timestamp()) AND old.payload->'complete'='true'::jsonb
    AND d->'sourceVector' @> jsonb_build_array(jsonb_build_object('id',old.id,'revision',old.revision,'digest',old.digest)),false) THEN RAISE EXCEPTION 'Legacy bridge absence predecessor changed' USING ERRCODE='23514';END IF;
   IF q.operation='create_target' THEN payload:=jsonb_set(old.payload,'{targetIds}',(SELECT jsonb_agg(id ORDER BY id) FROM (SELECT jsonb_array_elements_text(old.payload->'targetIds') id UNION SELECT p.target_id::text) ids));
   ELSE payload:=jsonb_set(old.payload,'{categoryIds}',(SELECT jsonb_agg(id ORDER BY id) FROM (SELECT jsonb_array_elements_text(old.payload->'categoryIds') id UNION SELECT n->>'id' FROM jsonb_array_elements(nodes) n) ids));END IF;
   payload:=payload||jsonb_build_object('previousSourceId',old.id,'previousSourceRevision',old.revision);
   PERFORM whaleu_ratings.legacy_bridge_issue_source(e.artifact_id,'scope_absence',key,ARRAY[key],payload,least(deadline,old.valid_until));
  END LOOP;
 END LOOP;
END $$;
CREATE FUNCTION whaleu_ratings.publish_legacy_bridge_compat(release uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r whaleu_ratings.scoped_releases;e whaleu_ratings.scoped_command_causes;d jsonb;output jsonb;old whaleu_ratings.compat_versions;v whaleu_ratings.compat_versions;keys text[];
BEGIN
 SELECT * INTO r FROM whaleu_ratings.scoped_releases WHERE id=release;
 SELECT * INTO e FROM whaleu_ratings.scoped_command_causes WHERE cause_kind='legacy_bridge' AND artifact_id=(r.cause->>'bridgeId')::uuid AND account_id=(r.cause->>'accountId')::uuid AND request_id=(r.cause->>'requestId')::uuid;
 IF NOT coalesce(r.cause_kind='legacy_bridge' AND r.publication_transaction=pg_current_xact_id() AND e.mutation_transaction=r.publication_transaction,false) THEN RAISE EXCEPTION 'Legacy bridge compatibility requires its original fresh companion' USING ERRCODE='23514';END IF;
 FOR d IN SELECT value FROM jsonb_array_elements(e.proof->'domains') LOOP
  SELECT value INTO output FROM jsonb_array_elements(e.proof->'legacyCatalogs') WHERE value->'logicalScopeKey'=d->'logicalScopeKey';
  SELECT x.* INTO old FROM whaleu_ratings.compat_heads h JOIN whaleu_ratings.compat_versions x ON x.id=h.version_id WHERE x.id=(d->>'compatVersionId')::uuid FOR UPDATE OF h;
  IF old.id IS NULL OR output IS NULL THEN RAISE EXCEPTION 'Legacy bridge compat CAS changed' USING ERRCODE='23514';END IF;
  keys:=ARRAY(SELECT jsonb_array_elements_text(d->'scopeKeys'));
  v:=old;v.id:=gen_random_uuid();v.previous_version_id:=old.id;v.release_id:=release;v.publication_transaction:=pg_current_xact_id();
  v.scoped_tuples:=whaleu_ratings.scoped_head_tuples(keys);v.source_digest:=whaleu_ratings.scoped_digest('vector',whaleu_ratings.scoped_current_source_vector(keys));
  v.legacy_catalog_id:=(output->>'afterCatalogId')::uuid;v.valid_until:=least(r.valid_until,(d->>'validUntil')::timestamptz);
  v.state:=whaleu_ratings.scoped_compat_state(v);v.equality_digest:=whaleu_ratings.scoped_digest('compat-body',whaleu_ratings.legacy_catalog_body(v.legacy_catalog_id));
  IF NOT coalesce(v.state='equal' AND whaleu_ratings.legacy_catalog_body(v.legacy_catalog_id)=whaleu_ratings.scoped_catalog_body((v.scoped_tuples->0->>'catalogId')::uuid)
   AND EXISTS(SELECT 1 FROM whaleu_ratings.catalog_heads WHERE scope_key=d->>'logicalScopeKey' AND catalog_id=v.legacy_catalog_id),false) THEN RAISE EXCEPTION 'Legacy bridge cannot widen or reinterpret original legacy output' USING ERRCODE='23514';END IF;
  INSERT INTO whaleu_ratings.compat_versions SELECT(v).*;
  UPDATE whaleu_ratings.compat_heads SET version_id=v.id WHERE compat_key=v.compat_key AND version_id=old.id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Legacy bridge compat predecessor CAS changed' USING ERRCODE='23514';END IF;
 END LOOP;
END $$;
CREATE FUNCTION whaleu_ratings.verify_legacy_scoped_bridge(actor uuid,request uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE e whaleu_ratings.scoped_command_causes;q whaleu_ratings.requests;r whaleu_ratings.scoped_releases;d jsonb;output jsonb;prior whaleu_ratings.compat_versions;v whaleu_ratings.compat_versions;policy whaleu_ratings.scoped_source_attestations;item record;expected_keys text[];keys text[];source record;nodes jsonb;target uuid;before_catalog uuid;after_catalog uuid;n integer;
BEGIN
 SELECT * INTO e FROM whaleu_ratings.scoped_command_causes WHERE account_id=actor AND request_id=request AND cause_kind='legacy_bridge';
 SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=actor AND request_id=request;
 IF NOT coalesce(e.mutation_transaction=pg_current_xact_id() AND q.intent_hash=e.proof->>'intentHash' AND q.operation=e.proof->>'operation'
  AND whaleu_ratings.legacy_bridge_intent_hash(q.operation,e.proof->'intent')=q.intent_hash AND e.proof->'intent'->>'clientRequestId'=request::text
  AND q.receipt->>'operation'=q.operation AND q.receipt->>'requestId'=request::text AND q.receipt->>'outcome' IN ('applied','noop')
  AND (SELECT count(*) FROM whaleu_ratings.scoped_command_causes WHERE account_id=actor AND request_id=request)=1
  AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.scoped_command_preparations WHERE account_id=actor AND request_id=request)
  AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.scoped_command_outcomes WHERE account_id=actor AND request_id=request),false)
 THEN RAISE EXCEPTION 'Legacy bridge cannot reinterpret historical, rejected or scoped requests' USING ERRCODE='23514';END IF;
 PERFORM whaleu_ratings.verify_legacy_bridge_interaction(e,q);
 SELECT count(*) INTO n FROM whaleu_ratings.scoped_releases WHERE cause_kind='legacy_bridge' AND cause->>'bridgeId'=e.artifact_id::text;
 IF q.operation IN ('create_target','create_categories') THEN
  SELECT * INTO r FROM whaleu_ratings.scoped_releases WHERE cause_kind='legacy_bridge' AND cause->>'bridgeId'=e.artifact_id::text;
  SELECT array_agg(k ORDER BY k COLLATE "C") INTO expected_keys FROM jsonb_array_elements(e.proof->'domains') x CROSS JOIN LATERAL jsonb_array_elements_text(x->'scopeKeys') k;
  SELECT array_agg(scope_key ORDER BY scope_key COLLATE "C") INTO keys FROM whaleu_ratings.scoped_release_scopes WHERE release_id=r.id;
  IF NOT coalesce(n=1 AND r.publication_transaction=e.mutation_transaction AND r.cause->>'accountId'=actor::text AND r.cause->>'requestId'=request::text
   AND r.affected_scope_keys=expected_keys AND keys=expected_keys AND r.source_vector=whaleu_ratings.scoped_current_source_vector(keys)
   AND r.valid_until>clock_timestamp() AND r.source_digest=whaleu_ratings.scoped_digest('vector',r.source_vector),false) THEN RAISE EXCEPTION 'Legacy bridge did not publish its whole exact affected set' USING ERRCODE='23514';END IF;
  IF q.operation='create_target' THEN SELECT target_id INTO target FROM whaleu_ratings.target_preparations WHERE account_id=actor AND request_id=request;
  ELSE SELECT x.nodes INTO nodes FROM whaleu_ratings.category_command_preparations x WHERE account_id=actor AND request_id=request;END IF;
 ELSIF n<>0 OR EXISTS(SELECT 1 FROM whaleu_ratings.scoped_source_attestations WHERE issuer='ratings-legacy-bridge' AND payload->>'bridgeId'=e.artifact_id::text) THEN RAISE EXCEPTION 'Legacy interaction/edit cannot manufacture placement or catalog publication' USING ERRCODE='23514';END IF;
 FOR d IN SELECT value FROM jsonb_array_elements(e.proof->'domains') LOOP
  SELECT * INTO policy FROM whaleu_ratings.scoped_source_attestations WHERE id=(d->>'policySourceId')::uuid AND revision=(d->>'policySourceRevision')::uuid;
  SELECT * INTO prior FROM whaleu_ratings.compat_versions WHERE id=(d->>'compatVersionId')::uuid;
  IF NOT coalesce(whaleu_ratings.scoped_source_current(policy.id,policy.revision,clock_timestamp()) AND policy.digest=d->>'policyDigest'
   AND policy.source_kind='native_v1_compat_write' AND policy.source_key=d->>'logicalScopeKey' AND policy.scope_keys=ARRAY(SELECT jsonb_array_elements_text(d->'scopeKeys'))
   AND policy.payload->'operations' ? q.operation AND policy.payload->'enabled'='true'::jsonb AND (d->>'validUntil')::timestamptz>clock_timestamp()
   AND prior.scoped_tuples=d->'scopedTuples' AND prior.legacy_catalog_id::text=d->>'legacyCatalogId' AND whaleu_ratings.scoped_compat_domain_current(prior)
   AND EXISTS(SELECT 1 FROM whaleu_ratings.scope_protocol_heads h JOIN whaleu_ratings.scope_protocol_versions p ON p.id=h.version_id WHERE h.logical_scope_key=d->>'logicalScopeKey' AND p.id::text=d->>'protocolVersionId' AND p.generation::text=d->>'protocolGeneration' AND p.phase='adopted'),false)
  THEN RAISE EXCEPTION 'Legacy bridge policy/domain/generation/deadline changed' USING ERRCODE='23514';END IF;
  IF q.operation NOT IN ('create_target','create_categories') THEN
   IF whaleu_ratings.legacy_bridge_observation(d->>'logicalScopeKey',q.operation) IS DISTINCT FROM d THEN RAISE EXCEPTION 'Legacy interaction/edit compatibility source changed' USING ERRCODE='23514';END IF;
   CONTINUE;
  END IF;
  SELECT value INTO output FROM jsonb_array_elements(e.proof->'legacyCatalogs') WHERE value->'logicalScopeKey'=d->'logicalScopeKey';
  SELECT x.* INTO v FROM whaleu_ratings.compat_heads h JOIN whaleu_ratings.compat_versions x ON x.id=h.version_id WHERE x.previous_version_id=prior.id;
  IF NOT coalesce(v.release_id=r.id AND v.publication_transaction=e.mutation_transaction AND v.legacy_catalog_id::text=output->>'afterCatalogId'
   AND v.valid_until<=(d->>'validUntil')::timestamptz AND whaleu_ratings.scoped_compat_current(v.id)
   AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.compat_projection_manifests WHERE release_id=r.id),false) THEN RAISE EXCEPTION 'Legacy bridge must retain the one genuine original final legacy output' USING ERRCODE='23514';END IF;
  -- All observed inputs are retained exactly, except the explicitly derived
  -- absence successor. Extra unrelated inputs cannot hide behind equal text.
  FOR source IN SELECT value entry FROM jsonb_array_elements(d->'sourceVector') LOOP
   IF NOT EXISTS(SELECT 1 FROM whaleu_ratings.scoped_source_heads h JOIN whaleu_ratings.scoped_source_attestations s ON (s.id,s.revision)=(h.source_id,h.source_revision)
    WHERE h.source_kind=source.entry->>'kind' AND h.source_key=source.entry->>'key' AND
    ((s.id::text=source.entry->>'id' AND s.revision::text=source.entry->>'revision' AND s.digest=source.entry->>'digest') OR
     (s.source_kind='scope_absence' AND s.issuer='ratings-legacy-bridge' AND s.payload->>'bridgeId'=e.artifact_id::text AND s.payload->>'previousSourceId'=source.entry->>'id' AND s.payload->>'previousSourceRevision'=source.entry->>'revision')))
   THEN RAISE EXCEPTION 'Legacy bridge lost or replaced an observed source' USING ERRCODE='23514';END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM whaleu_ratings.scoped_source_heads h JOIN whaleu_ratings.scoped_source_attestations s ON (s.id,s.revision)=(h.source_id,h.source_revision)
   WHERE s.scope_keys&&ARRAY(SELECT jsonb_array_elements_text(d->'scopeKeys')) AND NOT
    (d->'sourceVector' @> jsonb_build_array(jsonb_build_object('id',s.id,'revision',s.revision,'digest',s.digest)) OR
     (s.issuer='ratings-legacy-bridge' AND s.payload->>'bridgeId'=e.artifact_id::text AND s.publication_transaction=e.mutation_transaction))) THEN RAISE EXCEPTION 'Legacy bridge added an unrelated source' USING ERRCODE='23514';END IF;
  FOR item IN SELECT x.*,before_row->>'catalogId' observed_catalog,before_row->>'headRevision' observed_head FROM whaleu_ratings.scoped_release_scopes x
   JOIN jsonb_array_elements(d->'scopedTuples') before_row ON before_row->>'scopeKey'=x.scope_key WHERE x.release_id=r.id LOOP
   before_catalog:=item.before_catalog_id;after_catalog:=item.after_catalog_id;
   IF NOT coalesce(before_catalog::text=item.observed_catalog AND item.before_head_revision::text=item.observed_head
    AND EXISTS(SELECT 1 FROM whaleu_ratings.scoped_catalog_heads h WHERE (h.scope_key,h.catalog_id,h.head_revision,h.release_id)=(item.scope_key,after_catalog,item.after_head_revision,r.id)),false) THEN RAISE EXCEPTION 'Legacy bridge scoped before/after CAS differs' USING ERRCODE='23514';END IF;
   PERFORM whaleu_ratings.verify_scoped_catalog(after_catalog);
   IF EXISTS((SELECT to_jsonb(a)-ARRAY['catalog_id','effective_revision'] FROM whaleu_ratings.scoped_categories a WHERE catalog_id=before_catalog EXCEPT SELECT to_jsonb(a)-ARRAY['catalog_id','effective_revision'] FROM whaleu_ratings.scoped_categories a WHERE catalog_id=after_catalog AND (q.operation='create_target' OR NOT nodes @> jsonb_build_array(jsonb_build_object('id',a.category_id))))
    UNION ALL(SELECT to_jsonb(a)-ARRAY['catalog_id','effective_revision'] FROM whaleu_ratings.scoped_categories a WHERE catalog_id=after_catalog AND (q.operation='create_target' OR NOT nodes @> jsonb_build_array(jsonb_build_object('id',a.category_id))) EXCEPT SELECT to_jsonb(a)-ARRAY['catalog_id','effective_revision'] FROM whaleu_ratings.scoped_categories a WHERE catalog_id=before_catalog))
    OR EXISTS((SELECT to_jsonb(a)-ARRAY['catalog_id','effective_revision'] FROM whaleu_ratings.scoped_category_lineage a WHERE catalog_id=before_catalog EXCEPT SELECT to_jsonb(a)-ARRAY['catalog_id','effective_revision'] FROM whaleu_ratings.scoped_category_lineage a WHERE catalog_id=after_catalog AND (q.operation='create_target' OR NOT nodes @> jsonb_build_array(jsonb_build_object('id',a.category_id))))
    UNION ALL(SELECT to_jsonb(a)-ARRAY['catalog_id','effective_revision'] FROM whaleu_ratings.scoped_category_lineage a WHERE catalog_id=after_catalog AND (q.operation='create_target' OR NOT nodes @> jsonb_build_array(jsonb_build_object('id',a.category_id))) EXCEPT SELECT to_jsonb(a)-ARRAY['catalog_id','effective_revision'] FROM whaleu_ratings.scoped_category_lineage a WHERE catalog_id=before_catalog))
   THEN RAISE EXCEPTION 'Legacy bridge rewrote existing scoped category/body/lineage' USING ERRCODE='23514';END IF;
   IF EXISTS((SELECT to_jsonb(a)-'catalog_id' FROM whaleu_ratings.scoped_target_memberships a WHERE catalog_id=before_catalog EXCEPT SELECT to_jsonb(a)-'catalog_id' FROM whaleu_ratings.scoped_target_memberships a WHERE catalog_id=after_catalog AND (target IS NULL OR target_id<>target))
    UNION ALL(SELECT to_jsonb(a)-'catalog_id' FROM whaleu_ratings.scoped_target_memberships a WHERE catalog_id=after_catalog AND (target IS NULL OR target_id<>target) EXCEPT SELECT to_jsonb(a)-'catalog_id' FROM whaleu_ratings.scoped_target_memberships a WHERE catalog_id=before_catalog))
   THEN RAISE EXCEPTION 'Legacy bridge lost or reordered existing membership' USING ERRCODE='23514';END IF;
   IF target IS NOT NULL AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.scoped_target_memberships a WHERE a.catalog_id=after_catalog AND a.target_id=target AND a.ordinal=(SELECT coalesce(max(ordinal),-1)+1 FROM whaleu_ratings.scoped_target_memberships WHERE catalog_id=before_catalog)) THEN RAISE EXCEPTION 'Legacy M1 must append exactly its original target in each allowed domain' USING ERRCODE='23514';END IF;
  END LOOP;
 END LOOP;
 IF q.operation='create_target' THEN
  PERFORM whaleu_ratings.verify_target_create(actor,request);
  IF NOT EXISTS(SELECT 1 FROM whaleu_ratings.target_create_transitions t JOIN jsonb_array_elements(e.proof->'legacyCatalogs') x ON t.before_catalog_id::text=x->>'beforeCatalogId' AND t.after_catalog_id::text=x->>'afterCatalogId' WHERE t.account_id=actor AND t.request_id=request AND t.mutation_transaction=e.mutation_transaction) THEN RAISE EXCEPTION 'Legacy M1 actual output differs from bridge plan' USING ERRCODE='23514';END IF;
 ELSIF q.operation='create_categories' THEN PERFORM whaleu_ratings.verify_category_release(actor,request);
 ELSIF q.operation='edit_target' THEN PERFORM whaleu_ratings.verify_target_edit(actor,request);
 END IF;
END $$;
CREATE FUNCTION whaleu_ratings.legacy_bridge_source_causal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e whaleu_ratings.scoped_command_causes;q whaleu_ratings.requests;d jsonb;output jsonb;old whaleu_ratings.scoped_source_attestations;base whaleu_ratings.scoped_source_attestations;expected jsonb;nodes jsonb;target uuid;keys text[];
BEGIN
 SELECT * INTO e FROM whaleu_ratings.scoped_command_causes WHERE cause_kind='legacy_bridge' AND artifact_id=(NEW.payload->>'bridgeId')::uuid;
 SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=e.account_id AND request_id=e.request_id;
 IF NOT coalesce(NEW.publication_transaction=e.mutation_transaction AND e.mutation_transaction=pg_current_xact_id() AND NEW.source_reference='rating-legacy-bridge:'||e.artifact_id::text AND NEW.policy_reference='native-v1-compat-write-v1'
  AND NEW.coverage='complete' AND NEW.provenance='accepted' AND whaleu_ratings.scoped_source_current(NEW.id,NEW.revision,clock_timestamp()) AND q.operation IN ('create_target','create_categories'),false) THEN RAISE EXCEPTION 'Legacy source has no exact original companion cause' USING ERRCODE='23514';END IF;
 SELECT x.nodes INTO nodes FROM whaleu_ratings.category_command_preparations x WHERE account_id=e.account_id AND request_id=e.request_id;
 SELECT target_id INTO target FROM whaleu_ratings.target_preparations WHERE account_id=e.account_id AND request_id=e.request_id;
 SELECT value INTO d FROM jsonb_array_elements(e.proof->'domains') WHERE NEW.scope_keys<@ARRAY(SELECT jsonb_array_elements_text(value->'scopeKeys'));
 SELECT value INTO output FROM jsonb_array_elements(e.proof->'legacyCatalogs') WHERE value->'logicalScopeKey'=d->'logicalScopeKey';
 IF d IS NULL OR NEW.valid_until>(d->>'validUntil')::timestamptz THEN RAISE EXCEPTION 'Legacy derivative widened its exact policy scope/deadline' USING ERRCODE='23514';END IF;
 IF NEW.source_kind='m3a_native_bridge' THEN
  IF q.operation<>'create_categories' OR whaleu_ratings.legacy_bridge_native_category(NEW.id,NEW.revision) IS NULL OR NEW.scope_keys<>ARRAY(SELECT jsonb_array_elements_text(d->'scopeKeys'))
   OR NEW.payload IS DISTINCT FROM jsonb_build_object('bridgeId',e.artifact_id,'categoryId',NEW.payload->'categoryId','categoryRevision',NEW.payload->'categoryRevision','legacyAfterCatalogId',output->'afterCatalogId')
   OR NEW.source_key<>'bridge-category:'||(NEW.payload->>'categoryId')||':'||(d->>'logicalScopeKey') THEN RAISE EXCEPTION 'Legacy native category derivative differs' USING ERRCODE='23514';END IF;
 ELSIF NEW.source_kind='scoped_category_scope' THEN
  SELECT * INTO base FROM whaleu_ratings.scoped_source_attestations WHERE id=(NEW.payload->>'baseSourceId')::uuid AND revision=(NEW.payload->>'baseSourceRevision')::uuid;
  IF NOT coalesce(q.operation='create_categories' AND base.source_kind='m3a_native_bridge' AND base.issuer=NEW.issuer AND base.payload->'bridgeId'=NEW.payload->'bridgeId' AND base.payload->'categoryId'=NEW.payload->'categoryId' AND base.scope_keys=NEW.scope_keys
   AND NEW.source_key='bridge-placement:'||(NEW.payload->>'categoryId')||':'||(d->>'logicalScopeKey')
   AND whaleu_community.rating_scoped_keys(NEW.payload,ARRAY['bridgeId','categoryId','baseSourceId','baseSourceRevision','placementRevision','scopeKeys','placement']),false) THEN RAISE EXCEPTION 'Legacy category placement must use its exact native derivative' USING ERRCODE='23514';END IF;
 ELSIF NEW.source_kind='scoped_target_placement' THEN
  keys:=ARRAY(SELECT jsonb_array_elements_text(d->'scopeKeys'));
  IF q.operation<>'create_target' OR NEW.scope_keys<>keys OR NEW.source_key<>target::text OR NEW.payload IS DISTINCT FROM jsonb_build_object('bridgeId',e.artifact_id,'targetId',target,'categoryId',e.proof->'intent'->'categoryId') THEN RAISE EXCEPTION 'Legacy target placement differs from original target and complete allowed domain' USING ERRCODE='23514';END IF;
 ELSIF NEW.source_kind='scope_absence' THEN
  SELECT * INTO old FROM whaleu_ratings.scoped_source_attestations WHERE id=(NEW.payload->>'previousSourceId')::uuid AND revision=(NEW.payload->>'previousSourceRevision')::uuid;
  IF NOT coalesce(old.source_kind='scope_absence' AND old.source_key=NEW.source_key AND NEW.scope_keys=ARRAY[NEW.source_key]
   AND d->'sourceVector' @> jsonb_build_array(jsonb_build_object('id',old.id,'revision',old.revision,'digest',old.digest)) AND NEW.valid_until<=old.valid_until,false) THEN RAISE EXCEPTION 'Legacy absence derivative differs from observed negative source' USING ERRCODE='23514';END IF;
  IF q.operation='create_target' THEN expected:=jsonb_set(old.payload,'{targetIds}',(SELECT jsonb_agg(id ORDER BY id) FROM (SELECT jsonb_array_elements_text(old.payload->'targetIds') id UNION SELECT target::text) x));
  ELSE expected:=jsonb_set(old.payload,'{categoryIds}',(SELECT jsonb_agg(id ORDER BY id) FROM (SELECT jsonb_array_elements_text(old.payload->'categoryIds') id UNION SELECT n->>'id' FROM jsonb_array_elements(nodes) n) x));END IF;
  expected:=expected||jsonb_build_object('bridgeId',e.artifact_id,'previousSourceId',old.id,'previousSourceRevision',old.revision);
  IF NEW.payload IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Legacy absence derivative omitted or invented a category/target/source' USING ERRCODE='23514';END IF;
 ELSE RAISE EXCEPTION 'Unknown legacy derivative source kind' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT 1 FROM whaleu_ratings.scoped_releases parent
  WHERE parent.cause_kind='legacy_bridge' AND parent.publication_transaction=e.mutation_transaction
  AND parent.cause->>'bridgeId'=e.artifact_id::text AND parent.cause->>'accountId'=e.account_id::text
  AND parent.cause->>'requestId'=e.request_id::text
  AND parent.source_vector @> jsonb_build_array(jsonb_build_object('id',NEW.id,'revision',NEW.revision,'digest',NEW.digest)))
 THEN RAISE EXCEPTION 'Legacy derivative is absent from its exact immutable release vector' USING ERRCODE='23514';END IF;
 -- Full original request, affected-set and source-vector checks belong to the
 -- immutable bridge cause/release boundaries. This row has already proved its
 -- exact derivative shape, source, transaction and original command above.
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER legacy_bridge_source_causal AFTER INSERT ON whaleu_ratings.scoped_source_attestations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.issuer='ratings-legacy-bridge') EXECUTE FUNCTION whaleu_ratings.legacy_bridge_source_causal();
CREATE FUNCTION whaleu_ratings.legacy_bridge_before_catalog_current(actor uuid,request uuid,before_catalog uuid,after_catalog uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT coalesce((SELECT e.mutation_transaction=pg_current_xact_id() AND q.operation='create_target' AND q.receipt IS NULL AND q.intent_hash=e.proof->>'intentHash'
 AND EXISTS(SELECT 1 FROM jsonb_array_elements(e.proof->'legacyCatalogs') output JOIN jsonb_array_elements(e.proof->'domains') d ON d->'logicalScopeKey'=output->'logicalScopeKey'
 JOIN whaleu_ratings.compat_versions v ON v.id=(d->>'compatVersionId')::uuid
 WHERE output->>'beforeCatalogId'=before_catalog::text AND output->>'afterCatalogId'=after_catalog::text AND v.legacy_catalog_id=before_catalog
 AND d->'sourceVector'=whaleu_ratings.scoped_current_source_vector(ARRAY(SELECT jsonb_array_elements_text(d->'scopeKeys')))
 AND d->'scopedTuples'=whaleu_ratings.scoped_head_tuples(ARRAY(SELECT jsonb_array_elements_text(d->'scopeKeys')))
 AND whaleu_ratings.scoped_compat_domain_current(v) AND whaleu_ratings.scoped_source_current((d->>'policySourceId')::uuid,(d->>'policySourceRevision')::uuid,clock_timestamp())
 AND (d->>'validUntil')::timestamptz>clock_timestamp())
 FROM whaleu_ratings.scoped_command_causes e JOIN whaleu_ratings.requests q USING(account_id,request_id) WHERE e.account_id=actor AND e.request_id=request AND e.cause_kind='legacy_bridge'),false)
$$;
CREATE OR REPLACE FUNCTION whaleu_ratings.legacy_bridge_request_causal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q whaleu_ratings.requests;keys text[];
BEGIN
 SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=NEW.account_id AND request_id=NEW.request_id;
 IF q.receipt->>'outcome' NOT IN ('applied','noop') OR q.receipt IS NULL THEN RETURN NULL;END IF;
 IF EXISTS(SELECT 1 FROM whaleu_ratings.scoped_command_causes WHERE account_id=q.account_id AND request_id=q.request_id AND cause_kind='legacy_bridge') THEN
  PERFORM whaleu_ratings.verify_legacy_scoped_bridge(q.account_id,q.request_id);RETURN NULL;
 END IF;
 IF q.operation IN ('set_score','create_comment','create_reply','set_comment_like','set_reply_like','set_target_subscription') THEN
  PERFORM whaleu_ratings.verify_legacy_boundary(q.account_id,q.request_id);RETURN NULL;
 END IF;
 -- Genuine old preparation is the selector witness for management commands.
 IF q.operation='create_categories' THEN SELECT array_agg(coalesce(x->>'regionId','global')) INTO keys FROM whaleu_ratings.category_command_preparations p CROSS JOIN LATERAL jsonb_array_elements(p.catalogs) x WHERE p.account_id=q.account_id AND p.request_id=q.request_id;
 ELSIF q.operation='create_target' THEN SELECT ARRAY[coalesce(intent->>'regionId','global')] INTO keys FROM whaleu_ratings.target_preparations WHERE account_id=q.account_id AND request_id=q.request_id;
 ELSIF q.operation='edit_target' THEN SELECT ARRAY[coalesce(intent->>'regionId','global')] INTO keys FROM whaleu_ratings.target_edit_preparations WHERE account_id=q.account_id AND request_id=q.request_id;END IF;
 IF EXISTS(SELECT 1 FROM whaleu_ratings.scope_protocol_heads h JOIN whaleu_ratings.scope_protocol_versions p ON p.id=h.version_id WHERE h.logical_scope_key=ANY(keys) AND p.phase='adopted')
 THEN PERFORM whaleu_ratings.verify_legacy_scoped_bridge(q.account_id,q.request_id);END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER legacy_bridge_request_causal AFTER INSERT OR UPDATE ON whaleu_ratings.requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.operation IN ('set_score','create_comment','create_reply','set_comment_like','set_reply_like','set_target_subscription','create_target','edit_target','create_categories')) EXECUTE FUNCTION whaleu_ratings.legacy_bridge_request_causal();




















-- Deterministic complete membership ordering: keep every surviving predecessor
-- ordinal, append only new IDs in canonical ID order above the old maximum.
CREATE FUNCTION whaleu_ratings.scoped_membership_order_valid(catalog uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 WITH predecessor AS (SELECT x.before_catalog_id FROM whaleu_ratings.scoped_catalogs c JOIN whaleu_ratings.scoped_release_scopes x ON x.release_id=c.release_id AND x.scope_key=c.scope_key AND x.after_catalog_id=c.id WHERE c.id=catalog),
 maximum AS (SELECT coalesce(max(m.ordinal),-1) ordinal FROM predecessor p LEFT JOIN whaleu_ratings.scoped_target_memberships m ON m.catalog_id=p.before_catalog_id),
 members AS (SELECT m.target_id,m.ordinal actual,old.ordinal previous FROM whaleu_ratings.scoped_target_memberships m CROSS JOIN predecessor p LEFT JOIN whaleu_ratings.scoped_target_memberships old ON old.catalog_id=p.before_catalog_id AND old.target_id=m.target_id WHERE m.catalog_id=catalog),
 expected AS (SELECT actual,coalesce(previous,(SELECT ordinal FROM maximum)+sum(CASE WHEN previous IS NULL THEN 1 ELSE 0 END) OVER(ORDER BY target_id)) ordinal FROM members)
 SELECT EXISTS(SELECT 1 FROM predecessor) AND NOT EXISTS(SELECT 1 FROM expected WHERE actual<>ordinal)
$$;

-- Additional original routine-intent binding. Invoke from
-- verify_legacy_scoped_bridge immediately after its first request/cause guard:
-- PERFORM whaleu_ratings.verify_legacy_bridge_interaction(e,q);
CREATE OR REPLACE FUNCTION whaleu_ratings.verify_legacy_bridge_interaction(e whaleu_ratings.scoped_command_causes,q whaleu_ratings.requests) RETURNS void LANGUAGE plpgsql AS $$
DECLARE i jsonb:=e.proof->'intent';keys text[];t whaleu_ratings.targets;c whaleu_ratings.comments;reply whaleu_ratings.replies;subject uuid;envelope jsonb;domain jsonb;
BEGIN
 IF q.operation IN ('create_target','edit_target','create_categories') THEN RETURN;END IF;
 IF NOT whaleu_ratings.legacy_original_intent_valid(q.operation,i) THEN RAISE EXCEPTION 'Legacy original interaction intent shape is invalid' USING ERRCODE='23514';END IF;
 keys:=ARRAY['clientRequestId','targetId','regionId','expectedTargetRevision'];
 CASE q.operation
 WHEN 'set_score' THEN keys:=keys||ARRAY['expectedRevision','score'];
 WHEN 'create_comment' THEN keys:=keys||ARRAY['authorMode','body','assetIds'];
 WHEN 'create_reply' THEN keys:=keys||ARRAY['rootId','expectedRootRevision','replyTo','authorMode','body','assetIds'];
 WHEN 'set_comment_like' THEN keys:=keys||ARRAY['rootId','expectedRevision','expectedLikeRevision','liked'];
 WHEN 'set_reply_like' THEN keys:=keys||ARRAY['rootId','replyId','expectedRootRevision','expectedRevision','expectedLikeRevision','liked'];
 WHEN 'set_target_subscription' THEN keys:=keys||ARRAY['expectedSubscriptionRevision','subscribed'];
 ELSE RAISE EXCEPTION 'Unknown original legacy interaction' USING ERRCODE='23514';END CASE;
 SELECT * INTO t FROM whaleu_ratings.targets WHERE id=(i->>'targetId')::uuid;
 SELECT value INTO domain FROM jsonb_array_elements(e.proof->'domains') WHERE value->>'logicalScopeKey'=coalesce(i->>'regionId','global');
 IF e.cause_kind='legacy_boundary' THEN
  SELECT jsonb_build_object('logicalScopeKey',x->'logicalScopeKey','legacyCatalogId',x->'catalogId') INTO domain
  FROM jsonb_array_elements(e.proof->'boundary'->'protocolTuples') x WHERE x->>'logicalScopeKey'=coalesce(i->>'regionId','global');
 END IF;
 IF NOT coalesce(whaleu_community.rating_scoped_keys(i,keys) AND t.id::text=q.receipt->>'targetId' AND t.active
  AND (t.region_id IS NULL OR t.region_id=(i->>'regionId')::uuid) AND t.revision::text=i->>'expectedTargetRevision'
  AND EXISTS(SELECT 1 FROM whaleu_ratings.catalogs selected_catalog WHERE selected_catalog.id=(domain->>'legacyCatalogId')::uuid AND selected_catalog.region_id IS NOT DISTINCT FROM (i->>'regionId')::uuid AND selected_catalog.sealed AND selected_catalog.coverage='complete' AND selected_catalog.provenance='accepted' AND selected_catalog.effective_at<=clock_timestamp() AND (selected_catalog.valid_until IS NULL OR selected_catalog.valid_until>clock_timestamp()) AND whaleu_ratings.category_catalog_compat_current(selected_catalog.id) AND whaleu_ratings.category_ancestry_current(selected_catalog.id,t.category_id))
  AND EXISTS(SELECT 1 FROM whaleu_ratings.target_memberships m WHERE m.catalog_id=(domain->>'legacyCatalogId')::uuid AND m.target_id=t.id AND m.category_id=t.category_id)
  AND EXISTS(SELECT 1 FROM whaleu_ratings.target_definition_heads h JOIN whaleu_ratings.target_definition_versions v ON (v.target_id,v.content_version,v.definition_revision)=(h.target_id,h.content_version,h.definition_revision) WHERE h.target_id=t.id AND whaleu_community.rating_target_definition_current(t.id,v.content_version,v.definition_revision,v.applied_target_revision,v.envelope))
  AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.target_owner_tombstones WHERE target_id=t.id),false) THEN RAISE EXCEPTION 'Legacy bridge original target/scope/shape/CAS differs' USING ERRCODE='23514';END IF;
 IF q.operation='set_score' THEN
  IF (q.receipt->>'outcome'='applied' AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.score_transitions x WHERE x.account_id=q.account_id AND x.request_id=q.request_id AND x.target_id=t.id AND x.new_score=(i->>'score')::smallint AND x.old_revision IS NOT DISTINCT FROM (i->>'expectedRevision')::uuid AND x.mutation_transaction=e.mutation_transaction))
   OR (q.receipt->>'outcome'='noop' AND NOT coalesce(e.proof->'scoreBefore'=jsonb_build_object('score',i->'score','revision',i->'expectedRevision')
    AND EXISTS(SELECT 1 FROM whaleu_ratings.score_transitions x WHERE x.account_id=q.account_id AND x.target_id=t.id
     AND x.new_score=(i->>'score')::smallint AND x.new_revision::text=i->>'expectedRevision' AND x.new_revision::text=q.receipt->>'revision'),false))
  THEN RAISE EXCEPTION 'Legacy score differs from original desired score/CAS' USING ERRCODE='23514';END IF;
 ELSIF q.operation IN ('create_comment','create_reply') THEN
  IF q.operation='create_comment' THEN
   SELECT * INTO c FROM whaleu_ratings.comments WHERE account_id=q.account_id AND request_id=q.request_id AND target_id=t.id AND publication_transaction=e.mutation_transaction;
   envelope:=c.envelope;
  ELSE
   SELECT * INTO reply FROM whaleu_ratings.replies WHERE account_id=q.account_id AND request_id=q.request_id AND target_id=t.id AND publication_transaction=e.mutation_transaction;
   envelope:=reply.envelope;
   IF NOT coalesce(reply.root_id::text=i->>'rootId' AND envelope->>'rootRevision'=i->>'expectedRootRevision'
    AND envelope->'replyTo'=CASE WHEN i->'replyTo'='null'::jsonb THEN 'null'::jsonb ELSE jsonb_build_object('replyId',i->'replyTo'->'replyId','revision',i->'replyTo'->'expectedRevision') END
    AND whaleu_community.rating_scoped_parent_review_current('comment',reply.root_id,(i->>'expectedRootRevision')::uuid)
    AND (i->'replyTo'='null'::jsonb OR whaleu_community.rating_scoped_parent_review_current('reply',(i->'replyTo'->>'replyId')::uuid,(i->'replyTo'->>'expectedRevision')::uuid)),false) THEN RAISE EXCEPTION 'Legacy reply original parent/CAS differs' USING ERRCODE='23514';END IF;
  END IF;
  IF NOT coalesce(envelope->>'accountId'=q.account_id::text AND envelope->>'clientRequestId'=q.request_id::text AND envelope->>'targetId'=t.id::text
   AND envelope->'targetRevision'=i->'expectedTargetRevision' AND envelope->'scope'->'regionId'=i->'regionId'
   AND envelope->'body'=i->'body' AND envelope->'authorMode'=i->'authorMode' AND envelope->'assetIds'=i->'assetIds' AND i->'assetIds'='[]'::jsonb
   AND envelope->'catalogRevision'=domain->'legacyCatalogId' AND EXISTS(SELECT 1 FROM whaleu_ratings.categories a WHERE a.catalog_id=(domain->>'legacyCatalogId')::uuid AND a.id=t.category_id AND a.revision::text=envelope->>'categoryRevision'),false)
  THEN RAISE EXCEPTION 'Legacy content Review differs from original bytes and exact canonical category' USING ERRCODE='23514';END IF;
 ELSIF q.operation IN ('set_comment_like','set_reply_like') THEN
  subject:=CASE WHEN q.operation='set_comment_like' THEN (i->>'rootId')::uuid ELSE (i->>'replyId')::uuid END;
  SELECT * INTO c FROM whaleu_ratings.comments WHERE id=(i->>'rootId')::uuid AND target_id=t.id AND deleted_at IS NULL;
  IF q.operation='set_reply_like' THEN SELECT * INTO reply FROM whaleu_ratings.replies WHERE id=subject AND root_id=c.id AND target_id=t.id AND deleted_at IS NULL;END IF;
  IF NOT coalesce(c.id::text=i->>'rootId' AND (CASE WHEN q.operation='set_comment_like' THEN c.revision ELSE reply.revision END)::text=i->>'expectedRevision'
   AND whaleu_community.rating_scoped_parent_review_current('comment',c.id,c.revision)
   AND (q.operation='set_comment_like' OR (c.revision::text=i->>'expectedRootRevision' AND whaleu_community.rating_scoped_parent_review_current('reply',reply.id,reply.revision))),false)
   OR (q.receipt->>'outcome'='applied' AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.like_transitions x WHERE x.account_id=q.account_id AND x.request_id=q.request_id AND x.subject_id=subject AND x.target_id=t.id AND x.operation=q.operation AND x.old_revision::text=i->>'expectedLikeRevision' AND (x.delta=1)=(i->>'liked')::boolean AND x.mutation_transaction=e.mutation_transaction))
   OR (q.receipt->>'outcome'='noop' AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.like_noop_observations x WHERE x.account_id=q.account_id AND x.request_id=q.request_id AND x.subject_id=subject AND x.revision::text=i->>'expectedLikeRevision' AND x.liked=(i->>'liked')::boolean AND x.observation_transaction=e.mutation_transaction))
  THEN RAISE EXCEPTION 'Legacy like differs from original subject/CAS/desired state' USING ERRCODE='23514';END IF;
 ELSIF q.operation='set_target_subscription' THEN
  IF (q.receipt->>'outcome'='applied' AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.subscription_transitions x WHERE x.account_id=q.account_id AND x.request_id=q.request_id AND x.target_id=t.id AND x.old_revision::text=i->>'expectedSubscriptionRevision' AND (x.delta=1)=(i->>'subscribed')::boolean AND x.mutation_transaction=e.mutation_transaction))
   OR (q.receipt->>'outcome'='noop' AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.subscription_noop_observations x WHERE x.account_id=q.account_id AND x.request_id=q.request_id AND x.target_id=t.id AND x.revision::text=i->>'expectedSubscriptionRevision' AND x.subscribed=(i->>'subscribed')::boolean AND x.observation_transaction=e.mutation_transaction))
  THEN RAISE EXCEPTION 'Legacy subscription differs from original target/CAS/desired state' USING ERRCODE='23514';END IF;
 END IF;
END $$;

-- Every upgraded fresh routine legacy request preserves its complete original
-- selector/intent/hash in one typed companion, independently of adoption state.
-- No historical request is backfilled. Management requests already retain their
-- exact original preparation; adopted management execution still needs bridge.
ALTER TABLE whaleu_ratings.scoped_command_causes DROP CONSTRAINT scoped_command_causes_cause_kind_check;
ALTER TABLE whaleu_ratings.scoped_command_causes ADD CONSTRAINT scoped_command_causes_cause_kind_check CHECK(cause_kind IN ('execution','domain_transition','target_initial','target_edit','catalog_release','legacy_bridge','legacy_boundary'));

-- Canonical post-schema original intents; JSON strings never stand in for numbers,
-- booleans or UUID-or-null fields. No coercion before this predicate succeeds.
CREATE FUNCTION whaleu_ratings.legacy_original_intent_valid(op text,i jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE keys text[]:=ARRAY['clientRequestId','targetId','regionId','expectedTargetRevision'];ids text[]:=ARRAY['clientRequestId','targetId','expectedTargetRevision'];
BEGIN
 CASE op
 WHEN 'set_score' THEN keys:=keys||ARRAY['expectedRevision','score'];
 WHEN 'create_comment' THEN keys:=keys||ARRAY['authorMode','body','assetIds'];
 WHEN 'create_reply' THEN keys:=keys||ARRAY['rootId','expectedRootRevision','replyTo','authorMode','body','assetIds'];ids:=ids||ARRAY['rootId','expectedRootRevision'];
 WHEN 'set_comment_like' THEN keys:=keys||ARRAY['rootId','expectedRevision','expectedLikeRevision','liked'];ids:=ids||ARRAY['rootId','expectedRevision','expectedLikeRevision'];
 WHEN 'set_reply_like' THEN keys:=keys||ARRAY['rootId','replyId','expectedRootRevision','expectedRevision','expectedLikeRevision','liked'];ids:=ids||ARRAY['rootId','replyId','expectedRootRevision','expectedRevision','expectedLikeRevision'];
 WHEN 'set_target_subscription' THEN keys:=keys||ARRAY['expectedSubscriptionRevision','subscribed'];ids:=ids||ARRAY['expectedSubscriptionRevision'];
 ELSE RETURN false;END CASE;
 IF NOT coalesce(whaleu_community.rating_scoped_keys(i,keys) AND whaleu_community.rating_scoped_ids(i,ids)
  AND whaleu_community.rating_scoped_nullable_id(i->'regionId'),false) THEN RETURN false;END IF;
 IF op='set_score' THEN RETURN coalesce(whaleu_community.rating_scoped_nullable_id(i->'expectedRevision') AND jsonb_typeof(i->'score')='number' AND (i->'score')::text ~ '^[1-5]$',false);END IF;
 IF op IN ('set_comment_like','set_reply_like') THEN RETURN jsonb_typeof(i->'liked')='boolean';END IF;
 IF op='set_target_subscription' THEN RETURN jsonb_typeof(i->'subscribed')='boolean';END IF;
 IF NOT coalesce(jsonb_typeof(i->'authorMode')='string' AND i->>'authorMode' IN ('named','anonymous')
  AND jsonb_typeof(i->'body')='string' AND whaleu_community.rating_target_edit_text_valid(i->>'body',500,true)
  AND i->'assetIds'='[]'::jsonb,false) THEN RETURN false;END IF;
 IF op='create_reply' THEN RETURN coalesce(i->'replyTo'='null'::jsonb OR (whaleu_community.rating_scoped_keys(i->'replyTo',ARRAY['replyId','expectedRevision']) AND whaleu_community.rating_scoped_ids(i->'replyTo',ARRAY['replyId','expectedRevision'])),false);END IF;
 RETURN true;
END $$;
CREATE FUNCTION whaleu_ratings.legacy_boundary_capture(target uuid,selected text) RETURNS jsonb LANGUAGE sql STABLE AS $$
 WITH keys AS (
  SELECT selected logical
  UNION SELECT h.scope_key FROM whaleu_ratings.catalog_heads h JOIN whaleu_ratings.target_memberships m ON m.catalog_id=h.catalog_id WHERE m.target_id=target
  UNION SELECT coalesce(t.region_id::text,'global') FROM whaleu_ratings.targets t WHERE t.id=target
 ), tuples AS (
  SELECT k.logical,c.catalog_id,p.version_id,v.generation,coalesce(v.phase,'legacy_only') phase FROM keys k
  LEFT JOIN whaleu_ratings.catalog_heads c ON c.scope_key=k.logical
  LEFT JOIN whaleu_ratings.scope_protocol_heads p ON p.logical_scope_key=k.logical
  LEFT JOIN whaleu_ratings.scope_protocol_versions v ON v.id=p.version_id
 )
 SELECT jsonb_build_object('targetId',target,'selectedScopeKey',selected,
  'protocolEpoch',(SELECT epoch::text FROM whaleu_ratings.scope_protocol_epoch WHERE singleton AND version=1),
  'protocolTuples',(SELECT jsonb_agg(jsonb_build_object('logicalScopeKey',logical,'catalogId',catalog_id,'versionId',version_id,'generation',generation,'phase',phase) ORDER BY logical COLLATE "C") FROM tuples))
$$;
CREATE FUNCTION whaleu_ratings.legacy_boundary_guard(e whaleu_ratings.scoped_command_causes) RETURNS void LANGUAGE plpgsql AS $$
DECLARE q whaleu_ratings.requests;i jsonb:=e.proof->'intent';selected text:=coalesce(i->>'regionId','global');snapshot jsonb;
BEGIN
 SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=e.account_id AND request_id=e.request_id FOR UPDATE NOWAIT;
 IF NOT whaleu_ratings.legacy_original_intent_valid(q.operation,i) THEN RAISE EXCEPTION 'Legacy boundary original intent shape is invalid' USING ERRCODE='23514';END IF;
 snapshot:=whaleu_ratings.legacy_boundary_capture((i->>'targetId')::uuid,selected);
 IF NOT coalesce(e.cause_kind='legacy_boundary' AND e.mutation_transaction=pg_current_xact_id() AND q.receipt IS NULL
  AND q.operation IN ('set_score','create_comment','create_reply','set_comment_like','set_reply_like','set_target_subscription')
  AND q.operation=e.proof->>'operation' AND q.intent_hash=e.proof->>'intentHash' AND i->>'clientRequestId'=q.request_id::text
  AND q.intent_hash=whaleu_ratings.legacy_bridge_intent_hash(q.operation,i) AND e.proof->'version'='1'::jsonb
  AND whaleu_community.rating_scoped_keys(e.proof,ARRAY['version','operation','intentHash','intent','domains','legacyCatalogs','boundary','scoreBefore'])
  AND e.proof->'scoreBefore'=whaleu_ratings.legacy_score_before(e.account_id,q.operation,i)
  AND e.proof->'domains'='[]'::jsonb AND e.proof->'legacyCatalogs'='[]'::jsonb AND e.proof->'boundary'=snapshot
  AND EXISTS(SELECT 1 FROM jsonb_array_elements(snapshot->'protocolTuples') x WHERE x->>'logicalScopeKey'=selected AND x->>'phase'<>'adopted')
  AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.scoped_command_preparations WHERE account_id=e.account_id AND request_id=e.request_id)
  AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.scoped_command_causes WHERE account_id=e.account_id AND request_id=e.request_id),false)
 THEN RAISE EXCEPTION 'Legacy boundary needs fresh original selector/hash and exact nonadopted protocol proof' USING ERRCODE='23514';END IF;
END $$;
CREATE FUNCTION whaleu_ratings.begin_legacy_boundary(actor uuid,request uuid,intent jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE q whaleu_ratings.requests;body jsonb;id uuid:=gen_random_uuid();revision uuid:=gen_random_uuid();
BEGIN
 SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=actor AND request_id=request FOR UPDATE NOWAIT;
 IF q.operation NOT IN ('set_score','create_comment','create_reply','set_comment_like','set_reply_like','set_target_subscription') THEN RETURN NULL;END IF;
 IF NOT whaleu_ratings.legacy_original_intent_valid(q.operation,intent) THEN RAISE EXCEPTION 'Legacy boundary original intent shape is invalid' USING ERRCODE='23514';END IF;
 body:=jsonb_build_object('version',1,'operation',q.operation,'intentHash',q.intent_hash,'intent',intent,'domains','[]'::jsonb,'legacyCatalogs','[]'::jsonb,'scoreBefore',whaleu_ratings.legacy_score_before(actor,q.operation,intent),
  'boundary',whaleu_ratings.legacy_boundary_capture((intent->>'targetId')::uuid,coalesce(intent->>'regionId','global')));
 INSERT INTO whaleu_ratings.scoped_command_causes(account_id,request_id,cause_kind,artifact_id,artifact_revision,proof) VALUES(actor,request,'legacy_boundary',id,revision,body);
 RETURN jsonb_build_object('kind','legacy_boundary','bridgeId',id,'revision',revision,'proof',body);
END $$;
CREATE FUNCTION whaleu_ratings.verify_legacy_boundary(actor uuid,request uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE e whaleu_ratings.scoped_command_causes;q whaleu_ratings.requests;i jsonb;snapshot jsonb;
BEGIN
 LOCK TABLE whaleu_ratings.scope_protocol_epoch,whaleu_ratings.navigation_epoch IN SHARE MODE NOWAIT;
 SELECT * INTO e FROM whaleu_ratings.scoped_command_causes WHERE account_id=actor AND request_id=request AND cause_kind='legacy_boundary';
 SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=actor AND request_id=request;i:=e.proof->'intent';
 IF NOT whaleu_ratings.legacy_original_intent_valid(q.operation,i) THEN RAISE EXCEPTION 'Legacy boundary original intent shape is invalid' USING ERRCODE='23514';END IF;
 snapshot:=whaleu_ratings.legacy_boundary_capture((i->>'targetId')::uuid,coalesce(i->>'regionId','global'));
 IF NOT coalesce(e.mutation_transaction=pg_current_xact_id() AND q.operation IN ('set_score','create_comment','create_reply','set_comment_like','set_reply_like','set_target_subscription')
  AND q.operation=e.proof->>'operation' AND q.intent_hash=e.proof->>'intentHash' AND q.intent_hash=whaleu_ratings.legacy_bridge_intent_hash(q.operation,i)
  AND q.receipt->>'operation'=q.operation AND q.receipt->>'requestId'=request::text AND q.receipt->>'outcome' IN ('applied','noop')
  AND e.proof->'boundary'=snapshot AND EXISTS(SELECT 1 FROM jsonb_array_elements(snapshot->'protocolTuples') x WHERE x->>'logicalScopeKey'=snapshot->>'selectedScopeKey' AND x->>'phase'<>'adopted')
  AND (SELECT count(*) FROM whaleu_ratings.scoped_command_causes WHERE account_id=actor AND request_id=request)=1
  AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.scoped_command_preparations WHERE account_id=actor AND request_id=request)
  AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.scoped_command_outcomes WHERE account_id=actor AND request_id=request)
  AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.scoped_releases WHERE cause->>'accountId'=actor::text AND cause->>'requestId'=request::text)
  AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.scoped_source_attestations WHERE payload->>'bridgeId'=e.artifact_id::text),false)
 THEN RAISE EXCEPTION 'Legacy negative selector witness or exact original request changed' USING ERRCODE='23514';END IF;
 PERFORM whaleu_ratings.verify_legacy_bridge_interaction(e,q);
END $$;
