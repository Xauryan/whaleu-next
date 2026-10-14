-- Additive typed component. Historical envelopes/commands keep their original
-- validators, hashes, receipts, and in-flight text Review identities.
SET LOCAL lock_timeout='5s';
SELECT pg_advisory_xact_lock(hashtextextended('whaleu:named-block-policy:v1',0));

CREATE FUNCTION whaleu_community.rating_target_link_binding_shape(b jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE field text;item jsonb;BEGIN
 IF whaleu_community.related_sync_exact_keys(b,ARRAY['version','targetId','categoryId','targetRevision','definitionRevision','contentVersion','originSourceId','sourceId','sourceRevision','placementRevision','categoryRevision','catalogId','headRevision','protocolGeneration','sourceDigest','selector','originRegionId','systemKey','ancestry']) IS DISTINCT FROM true
 OR b->'version' IS DISTINCT FROM '1'::jsonb OR jsonb_typeof(b->'systemKey') IS DISTINCT FROM 'string' OR jsonb_typeof(b->'sourceDigest') IS DISTINCT FROM 'string' OR b->>'systemKey' NOT IN ('course','canteen') OR b->>'sourceDigest' !~ '^[a-f0-9]{64}$'
 OR NOT whaleu_community.rating_scoped_selector_shape(b->'selector')
 OR NOT whaleu_community.rating_scoped_nullable_id(b->'originRegionId')
 OR NOT whaleu_community.rating_scoped_integer(b->'contentVersion',1)
 OR jsonb_typeof(b->'ancestry')<>'array' OR jsonb_array_length(b->'ancestry') NOT BETWEEN 1 AND 3 THEN RETURN false;END IF;
 FOREACH field IN ARRAY ARRAY['targetId','categoryId','targetRevision','definitionRevision','originSourceId','sourceId','sourceRevision','placementRevision','categoryRevision','catalogId','headRevision','protocolGeneration'] LOOP
  IF NOT whaleu_community.related_sync_uuid(b->field) THEN RETURN false;END IF;
 END LOOP;
 FOR item IN SELECT jsonb_array_elements(b->'ancestry') LOOP
  IF NOT whaleu_community.related_sync_exact_keys(item,ARRAY['categoryId','revision']) OR NOT whaleu_community.related_sync_uuid(item->'categoryId') OR NOT whaleu_community.related_sync_uuid(item->'revision') THEN RETURN false;END IF;
 END LOOP;
 RETURN b->'ancestry'->-1->'categoryId'=b->'categoryId' AND b->'ancestry'->-1->'revision'=b->'categoryRevision'
 AND (SELECT count(DISTINCT ancestry_item.value->>'categoryId') FROM jsonb_array_elements(b->'ancestry') AS ancestry_item(value))=jsonb_array_length(b->'ancestry');
EXCEPTION WHEN OTHERS THEN RETURN false;END$$;
CREATE FUNCTION whaleu_community.rating_target_link_envelope_valid(e jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE c jsonb:=e->'component';s jsonb:=e->'scope';field text;BEGIN
 IF NOT whaleu_community.related_sync_exact_keys(e,ARRAY['version','accountId','purpose','spaceId','category','authorMode','commentsPolicy','postId','rootCommentId','targetReplyId','text','images','component','trading','scope'])
 OR e->'version' IS DISTINCT FROM '5'::jsonb OR e->>'purpose' IS DISTINCT FROM 'publish_post' OR e->>'category' IS DISTINCT FROM 'discussion'
 OR jsonb_typeof(e->'authorMode') IS DISTINCT FROM 'string' OR jsonb_typeof(e->'commentsPolicy') IS DISTINCT FROM 'string' OR jsonb_typeof(e->'text') IS DISTINCT FROM 'string'
 OR e->>'authorMode' NOT IN ('named','anonymous') OR e->>'commentsPolicy' NOT IN ('open','restricted')
 OR e->'postId'<>'null'::jsonb OR e->'rootCommentId'<>'null'::jsonb OR e->'targetReplyId'<>'null'::jsonb OR e->'images'<>'[]'::jsonb OR e->'trading'<>'null'::jsonb
 OR NOT whaleu_community.related_sync_uuid(e->'accountId') OR NOT whaleu_community.related_sync_uuid(e->'spaceId')
 OR NOT whaleu_profile.moderation_text_valid(e->>'text',2500) OR whaleu_profile.moderation_trim(e->>'text')=''
 OR NOT whaleu_community.related_sync_exact_keys(c,ARRAY['kind','targetId','label','binding']) OR c->>'kind' IS DISTINCT FROM 'rating_target_link'
 OR NOT whaleu_community.rating_target_link_binding_shape(c->'binding') OR c->'targetId'<>c->'binding'->'targetId'
 OR jsonb_typeof(c->'label')<>'string' OR NOT whaleu_profile.moderation_text_valid(c->>'label',12) OR c->>'label'<>whaleu_profile.moderation_trim(c->>'label') OR c->>'label'='' OR c->>'label' ~ '[[:cntrl:]]' OR c->>'label' ~ U&'[\2028-\202E\2066-\2069]' 
 OR NOT whaleu_community.related_sync_exact_keys(s,ARRAY['originalSpaceId','originalRegionId','authorOriginRegionId','identityRegionId','topologySnapshotId','sync','configurationRevisionId','identityCampusId','identitySelectionId','affiliationSnapshotId','affiliationAssertionId'])
 OR s->>'sync' IS DISTINCT FROM 'none' OR e->'spaceId'<>s->'originalSpaceId' OR NOT whaleu_community.related_sync_uuid(s->'originalRegionId') THEN RETURN false;END IF;
 FOREACH field IN ARRAY ARRAY['authorOriginRegionId','identityRegionId','topologySnapshotId','configurationRevisionId','identityCampusId','identitySelectionId','affiliationSnapshotId','affiliationAssertionId'] LOOP
  IF NOT whaleu_community.rating_scoped_nullable_id(s->field) THEN RETURN false;END IF;
 END LOOP;RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;END$$;

-- SQL callers use the same exact original Category Review bindings as the
-- scalar/batched Ratings owner. A current catalog alone is not a Review allow.
CREATE FUNCTION whaleu_ratings.community_link_category_source_current(source_id uuid,revision uuid,category uuid,depth integer DEFAULT 0) RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
DECLARE s whaleu_ratings.scoped_source_attestations;legacy record;e jsonb;BEGIN
 IF depth>1 THEN RETURN false;END IF;
 SELECT * INTO s FROM whaleu_ratings.scoped_source_attestations a WHERE a.id=source_id AND a.revision=community_link_category_source_current.revision;
 IF s.id IS NULL OR whaleu_ratings.scoped_source_current(s.id,s.revision,clock_timestamp()) IS DISTINCT FROM true THEN RETURN false;END IF;
 IF s.source_kind='legacy_adoption' THEN
  e:=s.payload->'reviewSource';
  IF e->>'kind' IS DISTINCT FROM 'scoped_category_v5' OR NOT EXISTS(SELECT 1 FROM whaleu_ratings.scoped_source_attestations a WHERE a.id=(e->>'sourceId')::uuid AND a.revision=(e->>'sourceRevision')::uuid AND a.source_kind='scoped_category_base') THEN RETURN false;END IF;
  RETURN whaleu_ratings.community_link_category_source_current((e->>'sourceId')::uuid,(e->>'sourceRevision')::uuid,category,depth+1);
 ELSIF s.source_kind='m3a_native_bridge' THEN
  IF s.payload->>'categoryId' IS DISTINCT FROM category::text THEN RETURN false;END IF;
  SELECT b.* INTO legacy FROM whaleu_ratings.catalog_category_lineage l JOIN whaleu_ratings.category_base_versions b ON (b.category_id,b.revision)=(l.category_id,l.base_revision)
  WHERE l.catalog_id=coalesce(s.payload->>'legacyCatalogId',s.payload->>'legacyAfterCatalogId')::uuid AND l.category_id=category AND l.effective_revision=(s.payload->>'categoryRevision')::uuid AND l.source_kind='native';
  RETURN legacy.category_id IS NOT NULL AND whaleu_community.rating_category_base_current(legacy.category_id,legacy.revision,legacy.envelope) IS TRUE;
 ELSIF s.source_kind='scoped_category_override' AND s.payload->>'action'='inherit' THEN
  RETURN coalesce(s.issuer='ratings-category-management' AND s.payload->>'categoryId'=category::text AND s.payload->'modes'='{"name":{"mode":"inherit"},"description":{"mode":"inherit"}}'::jsonb AND NOT s.payload ? 'reviewEnvelope',false);
 ELSIF s.source_kind NOT IN ('scoped_category_base','scoped_category_override') THEN RETURN false;END IF;
 e:=s.payload->'reviewEnvelope';
 RETURN coalesce(e->>'categoryId'=category::text AND e->>'sourceId'=s.id::text AND e->>'sourceRevision'=s.revision::text AND whaleu_community.rating_scoped_category_source_current(s.id,s.revision,e),false);
EXCEPTION WHEN OTHERS THEN RETURN false;END$$;

-- Exact fresh expectation for issuance; current readers deliberately never call
-- this with a permanently frozen target/definition revision after a successor.
CREATE FUNCTION whaleu_ratings.community_link_binding_current(b jsonb,exact_revision boolean DEFAULT true) RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
DECLARE t whaleu_ratings.targets;h whaleu_ratings.target_definition_heads;d whaleu_ratings.target_definition_versions;c whaleu_ratings.scoped_catalogs;
 p whaleu_ratings.target_scope_placements;r record;path jsonb:='[]'::jsonb;previous uuid:=NULL;rootkey text;leafkey text;selected uuid;source whaleu_ratings.scoped_source_attestations;registry whaleu_ratings.scoped_source_attestations;lineage whaleu_ratings.scoped_category_lineage;release whaleu_ratings.scoped_releases;icon record;icons boolean:=false;n integer:=0;BEGIN
 IF NOT whaleu_community.rating_target_link_binding_shape(b) THEN RETURN false;END IF;
 SELECT * INTO t FROM whaleu_ratings.targets WHERE id=(b->>'targetId')::uuid;
 SELECT * INTO h FROM whaleu_ratings.target_definition_heads WHERE target_id=t.id;
 SELECT * INTO d FROM whaleu_ratings.target_definition_versions WHERE (target_id,content_version,definition_revision)=(t.id,h.content_version,h.definition_revision);
 SELECT cat.* INTO c FROM whaleu_ratings.scoped_catalog_heads head JOIN whaleu_ratings.scoped_catalogs cat ON (cat.id,cat.head_revision,cat.scope_key)=(head.catalog_id,head.head_revision,head.scope_key)
 WHERE head.scope_key=CASE WHEN b->'selector'->>'kind'='global' THEN 'global' ELSE 'campus:'||(b->'selector'->>'campusId') END;
 IF t.id IS NULL OR c.id IS NULL OR NOT t.active OR t.category_id::text<>b->>'categoryId' OR t.source_id::text<>b->>'originSourceId'
 OR to_jsonb(t.region_id) IS DISTINCT FROM nullif(b->'originRegionId','null'::jsonb) OR EXISTS(SELECT 1 FROM whaleu_ratings.target_owner_tombstones WHERE target_id=t.id)
 OR NOT whaleu_ratings.scoped_catalog_current(c.id,clock_timestamp()) OR NOT whaleu_ratings.scoped_category_current(c.id,t.category_id)
 OR NOT EXISTS(SELECT 1 FROM whaleu_ratings.target_definition_lifecycles l WHERE (l.target_id,l.target_revision,l.content_version,l.definition_revision)=(t.id,t.revision,h.content_version,h.definition_revision))
 OR NOT whaleu_community.rating_target_definition_current(t.id,d.content_version,d.definition_revision,d.applied_target_revision,d.envelope) THEN RETURN false;END IF;
 SELECT placement.* INTO p FROM whaleu_ratings.scoped_target_memberships m JOIN whaleu_ratings.target_scope_placements placement ON (placement.placement_revision,placement.target_id)=(m.placement_revision,m.target_id)
 WHERE m.catalog_id=c.id AND m.target_id=t.id AND m.category_id=t.category_id AND c.scope_key=ANY(placement.scope_keys) AND whaleu_ratings.scoped_source_current(placement.source_id,placement.source_revision,clock_timestamp());
 IF p.placement_revision IS NULL THEN RETURN false;END IF;
 SELECT * INTO release FROM whaleu_ratings.scoped_releases WHERE id=c.release_id;
 icons:=whaleu_ratings.category_icon_scope_adopted(release.cause,c.scope_key);
 IF icons AND whaleu_ratings.category_icon_release_payload_valid(c.release_id) IS DISTINCT FROM true THEN RETURN false;END IF;
 IF d.envelope->'version'='6'::jsonb AND d.envelope->'cover'<>'null'::jsonb AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.scope_protocol_heads ph JOIN whaleu_ratings.target_cover_capability_sources cap ON cap.protocol_version_id=ph.version_id WHERE ph.logical_scope_key=coalesce(c.region_id::text,'global') AND whaleu_ratings.target_cover_capability_current(cap.id,clock_timestamp())) THEN RETURN false;END IF;
 FOR r IN WITH RECURSIVE ancestry AS (
  SELECT category.*,1 depth FROM whaleu_ratings.scoped_categories category WHERE category.catalog_id=c.id AND category.category_id=t.category_id
  UNION ALL SELECT category.*,parent.depth+1 FROM whaleu_ratings.scoped_categories category JOIN ancestry parent ON category.catalog_id=parent.catalog_id AND category.category_id=parent.parent_id WHERE parent.depth<3)
 SELECT * FROM ancestry ORDER BY level LOOP
  SELECT * INTO lineage FROM whaleu_ratings.scoped_category_lineage l WHERE l.catalog_id=c.id AND l.category_id=r.category_id AND l.effective_revision=r.effective_revision;
  IF lineage.category_id IS NULL OR whaleu_ratings.community_link_category_source_current(lineage.base_source_id,lineage.base_source_revision,r.category_id) IS DISTINCT FROM true
  OR (lineage.override_source_id IS NOT NULL AND whaleu_ratings.community_link_category_source_current(lineage.override_source_id,lineage.override_source_revision,r.category_id) IS DISTINCT FROM true) THEN RETURN false;END IF;
  IF icons THEN
   SELECT projection.*,icon_binding.definition_id,icon_binding.definition_digest,icon_binding.envelope INTO icon FROM whaleu_ratings.category_icon_projections projection JOIN whaleu_ratings.category_icon_review_bindings icon_binding ON icon_binding.id=projection.review_binding_id WHERE projection.release_id=c.release_id AND projection.catalog_id=c.id AND projection.category_id=r.category_id AND projection.effective_revision=r.effective_revision;
   IF icon.category_id IS NULL OR whaleu_community.rating_category_icon_definition_current(icon.definition_id,icon.definition_digest,icon.envelope) IS DISTINCT FROM true OR (icon.appearance_id IS NOT NULL AND whaleu_ratings.category_icon_appearance_current(icon.appearance_id,clock_timestamp()) IS DISTINCT FROM true) THEN RETURN false;END IF;
  END IF;
  n:=n+1;IF r.level<>n OR r.parent_id IS DISTINCT FROM previous OR NOT r.active OR r.hidden THEN RETURN false;END IF;
  previous:=r.category_id;path:=path||jsonb_build_array(jsonb_build_object('categoryId',r.category_id,'revision',r.effective_revision));
  IF n=1 THEN rootkey:=r.system_key;selected:=r.category_id;END IF;
  IF r.category_id=t.category_id THEN leafkey:=r.system_key;IF leafkey IS NOT NULL THEN selected:=r.category_id;END IF;END IF;
  IF r.system_key IS NOT NULL AND r.system_key<>b->>'systemKey' THEN RETURN false;END IF;
 END LOOP;
 IF n=0 OR previous<>t.category_id OR coalesce(leafkey,rootkey) IS DISTINCT FROM b->>'systemKey' THEN RETURN false;END IF;
 SELECT base.* INTO source FROM whaleu_ratings.scoped_category_lineage l JOIN whaleu_ratings.scoped_source_attestations base ON (base.id,base.revision)=(l.base_source_id,l.base_source_revision) WHERE l.catalog_id=c.id AND l.category_id=selected;
 SELECT reg.* INTO registry FROM whaleu_ratings.scoped_source_attestations reg JOIN whaleu_ratings.scoped_source_heads head ON (head.source_id,head.source_revision)=(reg.id,reg.revision)
 WHERE reg.id::text=source.payload->>'registrySourceId' AND reg.revision::text=source.payload->>'registrySourceRevision';
 IF NOT EXISTS(SELECT 1 FROM whaleu_ratings.scoped_categories c2 JOIN whaleu_ratings.scoped_category_lineage l ON (l.catalog_id,l.category_id,l.effective_revision)=(c2.catalog_id,c2.category_id,c2.effective_revision) WHERE c2.catalog_id=c.id AND c2.category_id=selected AND l.proof->'body'->'isSystem'='true'::jsonb AND registry.payload->>'kind'=c2.kind) OR registry.id IS NULL OR registry.source_kind<>'scoped_category_system_registry' OR registry.payload->>'systemKey'<>b->>'systemKey' OR registry.payload->>'consumer'<>'ratings_general_v1' OR registry.payload->'enabled'<>'true'::jsonb OR NOT whaleu_ratings.scoped_source_current(registry.id,registry.revision,clock_timestamp()) THEN RETURN false;END IF;
 IF NOT EXISTS(SELECT 1 FROM whaleu_ratings.scope_protocol_heads ph JOIN whaleu_ratings.scope_protocol_versions pv ON pv.id=ph.version_id WHERE ph.logical_scope_key=coalesce(c.region_id::text,'global') AND pv.phase='adopted' AND (NOT exact_revision OR pv.generation::text=b->>'protocolGeneration') AND whaleu_ratings.scoped_source_current(pv.capability_source_id,pv.capability_source_revision,clock_timestamp())) THEN RETURN false;END IF;
 IF exact_revision AND (t.revision::text<>b->>'targetRevision' OR d.definition_revision::text<>b->>'definitionRevision' OR d.content_version<>(b->>'contentVersion')::integer
 OR c.id::text<>b->>'catalogId' OR c.head_revision::text<>b->>'headRevision' OR c.source_digest<>b->>'sourceDigest' OR p.source_id::text<>b->>'sourceId' OR p.source_revision::text<>b->>'sourceRevision'
 OR p.placement_revision::text<>b->>'placementRevision' OR path<>b->'ancestry') THEN RETURN false;END IF;
 RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;END$$;

CREATE FUNCTION whaleu_community.rating_target_link_intent_hash(e jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE b jsonb:=e->'component'->'binding';selector text;component text;intent text;BEGIN
 IF NOT whaleu_community.rating_target_link_envelope_valid(e) THEN RETURN NULL;END IF;
 selector:=CASE WHEN b->'selector'->>'kind'='global' THEN '{"kind":"global"}' ELSE '{"kind":"campus","campusId":'||(b->'selector'->'campusId')::text||'}' END;
 component:='{"kind":"rating_target_link","targetId":'||(b->'targetId')::text||',"label":'||(e->'component'->'label')::text||',"selector":'||selector||',"expectedTargetRevision":'||(b->'targetRevision')::text||',"expectedCategoryRevision":'||(b->'categoryRevision')::text||',"expectedSourceRevision":'||(b->'sourceRevision')::text||'}';
 intent:='{"spaceId":'||(e->'spaceId')::text||',"category":"discussion","text":'||(e->'text')::text||',"imageAssetIds":[],"authorMode":'||(e->'authorMode')::text||',"commentsPolicy":'||(e->'commentsPolicy')::text||',"component":'||component||'}';
 RETURN encode(sha256(convert_to('whaleu-community-rating-target-link:v1'||chr(10)||'{"operation":"publish_post","intent":'||intent||'}','UTF8')),'hex');END$$;

CREATE TABLE whaleu_community.post_rating_target_links (
 post_id uuid PRIMARY KEY REFERENCES whaleu_community.posts(id),account_id uuid NOT NULL,
 client_request_id uuid NOT NULL,intent_hash text NOT NULL CHECK(intent_hash ~ '^[a-f0-9]{64}$'),component jsonb NOT NULL,
 decision_id uuid NOT NULL UNIQUE REFERENCES whaleu_community.content_approval_decisions(id),digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),
 publication_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 FOREIGN KEY(account_id,client_request_id) REFERENCES whaleu_community.publication_requests(account_id,client_request_id),
 UNIQUE(account_id,client_request_id),CHECK(component->>'kind'='rating_target_link' AND whaleu_community.rating_target_link_binding_shape(component->'binding'))
);
CREATE INDEX post_rating_target_link_target ON whaleu_community.post_rating_target_links(((component->>'targetId')::uuid));
CREATE FUNCTION whaleu_community.rating_target_link_retain() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'Rating target card identity is immutable' USING ERRCODE='23514';END$$;
CREATE TRIGGER rating_target_link_retain BEFORE UPDATE OR DELETE ON whaleu_community.post_rating_target_links FOR EACH ROW EXECUTE FUNCTION whaleu_community.rating_target_link_retain();
CREATE TRIGGER rating_target_link_truncate BEFORE TRUNCATE ON whaleu_community.post_rating_target_links FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.rating_target_link_retain();

-- Extend only explicit v5 checks. The old SQL expression is retained verbatim.
DO $$DECLARE pair text[];definition text;BEGIN
 FOREACH pair SLICE 1 IN ARRAY ARRAY[
  ['posts','post_anonymous_dm_definition','publication_envelope_version=5 AND category=''discussion'' AND feedback IS NULL AND allow_anonymous_dm IS NULL'],
  ['content_approval_decisions','content_approval_envelope_identity','envelope_version=5 AND envelope->>''accountId''=account_id::text AND envelope->>''purpose''=operation AND whaleu_community.rating_target_link_envelope_valid(envelope)'],
  ['text_review_requests','text_review_identity','envelope->>''version''=''5'' AND envelope->>''accountId''=account_id::text AND envelope->>''purpose''=operation AND whaleu_community.rating_target_link_envelope_valid(envelope)'],
  ['text_review_requests','text_review_scope_definition','envelope->>''version''=''5'' AND envelope->>''commentsPolicy''=''open'' AND whaleu_community.rating_target_link_envelope_valid(envelope)']
 ] LOOP
  SELECT pg_get_constraintdef(oid) INTO definition FROM pg_constraint WHERE conrelid=('whaleu_community.'||pair[1])::regclass AND conname=pair[2];
  IF definition IS NULL THEN RAISE EXCEPTION 'Missing historical content constraint';END IF;
  EXECUTE format('ALTER TABLE whaleu_community.%I DROP CONSTRAINT %I',pair[1],pair[2]);
  EXECUTE format('ALTER TABLE whaleu_community.%I ADD CONSTRAINT %I CHECK (%s OR (%s))',pair[1],pair[2],substr(definition,7),pair[3]);
 END LOOP;END$$;
ALTER TABLE whaleu_community.content_approval_decisions DROP CONSTRAINT content_approval_envelope_version;
ALTER TABLE whaleu_community.content_approval_decisions ADD CONSTRAINT content_approval_envelope_version CHECK(envelope_version IN (1,2,3,4,5));
ALTER TABLE whaleu_community.content_approval_bindings DROP CONSTRAINT content_binding_envelope_version;
ALTER TABLE whaleu_community.content_approval_bindings ADD CONSTRAINT content_binding_envelope_version CHECK(envelope_version IN (1,2,3,4,5) AND envelope->>'version'=envelope_version::text AND (envelope_version IN (1,4) OR (content_kind='post' AND operation='publish_post')));

-- Exact discussion-post destination authority, shared with title generation.
-- It deliberately checks post policy, never the distinct comment opt-in.
CREATE FUNCTION whaleu_community.rating_target_link_destination_current(actor uuid,scope jsonb,mode text) RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
DECLARE a whaleu_verification.assertions; v whaleu_verification.snapshots; selection whaleu_campus.community_identity_selections;
 topo whaleu_campus.community_topology_snapshots; cfg whaleu_community.region_policy_revisions;
 verified boolean:=false; origin jsonb; identity_region jsonb; target_region jsonb; assignment jsonb; field text; instant timestamptz:=clock_timestamp();
BEGIN
 IF mode IS NULL OR mode NOT IN ('named','anonymous') OR whaleu_community.related_sync_exact_keys(scope,ARRAY['originalSpaceId','originalRegionId','authorOriginRegionId','identityRegionId','topologySnapshotId','sync','configurationRevisionId','identityCampusId','identitySelectionId','affiliationSnapshotId','affiliationAssertionId']) IS DISTINCT FROM true
 OR scope->>'sync' IS DISTINCT FROM 'none' OR NOT whaleu_community.related_sync_uuid(scope->'originalSpaceId') OR NOT whaleu_community.related_sync_uuid(scope->'originalRegionId')
 OR NOT whaleu_profile.moderation_actor_current(actor,instant) OR NOT whaleu_safety.account_punishment_allows(actor,'interaction')
 OR NOT EXISTS(SELECT 1 FROM whaleu_community.spaces s WHERE s.id=(scope->>'originalSpaceId')::uuid AND s.is_active AND s.kind='regional' AND s.operating_region_id::text=scope->>'originalRegionId') THEN RETURN false;END IF;
 FOREACH field IN ARRAY ARRAY['authorOriginRegionId','identityRegionId','topologySnapshotId','configurationRevisionId','identityCampusId','identitySelectionId','affiliationSnapshotId','affiliationAssertionId'] LOOP
  IF NOT whaleu_community.rating_scoped_nullable_id(scope->field) THEN RETURN false;END IF;
 END LOOP;
 SELECT s.* INTO v FROM whaleu_verification.account_heads h JOIN whaleu_verification.snapshots s ON (s.id,s.account_id,s.revision)=(h.snapshot_id,h.account_id,h.revision) WHERE h.account_id=actor;
 SELECT * INTO a FROM whaleu_verification.assertions WHERE id=v.affiliation_assertion_id AND account_id=actor AND fact_kind='affiliation';
 IF a.id IS NULL OR a.coverage_state<>'complete' OR a.provenance_state<>'accepted' OR a.source_account_id IS DISTINCT FROM actor
 OR coalesce(length(whaleu_profile.moderation_trim(a.source_reference)),0)=0 OR coalesce(length(whaleu_profile.moderation_trim(a.policy_reference)),0)=0
 OR a.issuer_institution_id IS DISTINCT FROM a.source_issuer_institution_id THEN RETURN false; END IF;
 IF a.method='native_enrollment' THEN
  IF a.assertion_state<>'unverified' OR a.source_reference IS DISTINCT FROM 'native_enrollment:'||actor::text OR a.policy_reference<>'native-account-absence/v1'
   OR a.issuer_institution_id IS NOT NULL OR a.origin_region_id IS NOT NULL OR a.phone_binding_reference IS NOT NULL OR a.student_number IS NOT NULL
   OR a.verified_at IS NOT NULL OR a.expiry_kind<>'policy_exempt' OR a.expires_at IS NOT NULL THEN RETURN false; END IF;
 ELSE
  IF a.method NOT IN('document_review','institutional_email','institutional_sso','reconciled_import','administrator_correction') THEN RETURN false; END IF;
  IF a.assertion_state='verified' THEN
   IF a.verified_at IS NULL OR NOT isfinite(a.verified_at) OR a.verified_at>instant
    OR NOT ((a.expiry_kind='policy_exempt' AND a.expires_at IS NULL) OR (a.expiry_kind='at' AND isfinite(a.expires_at) AND a.expires_at>a.verified_at)) THEN RETURN false; END IF;
   verified:=a.expires_at IS NULL OR a.expires_at>instant;
   IF verified AND (a.issuer_institution_id IS NULL OR a.origin_region_id IS NULL) THEN RETURN false; END IF;
  ELSIF a.assertion_state NOT IN('unverified','revoked','expired') THEN RETURN false; END IF;
 END IF;
 IF NOT verified THEN
  IF mode<>'named' THEN RETURN false; END IF;
  FOREACH field IN ARRAY ARRAY['authorOriginRegionId','identityRegionId','topologySnapshotId','identityCampusId','identitySelectionId','affiliationSnapshotId','affiliationAssertionId'] LOOP
   IF scope->field IS DISTINCT FROM 'null'::jsonb THEN RETURN false; END IF;
  END LOOP;
  SELECT p.* INTO cfg FROM whaleu_community.region_policy_heads h JOIN whaleu_community.region_policy_revisions p ON (p.id,p.region_id,p.revision)=(h.revision_id,h.region_id,h.revision) WHERE h.region_id=(scope->>'originalRegionId')::uuid;
  RETURN coalesce(cfg.id::text=scope->>'configurationRevisionId' AND cfg.unverified_post_enabled AND 'discussion'=ANY(cfg.unverified_categories) AND cfg.coverage_state='complete' AND cfg.provenance_state='accepted'
   AND length(whaleu_profile.moderation_trim(cfg.source_reference))>0 AND length(whaleu_profile.moderation_trim(cfg.policy_reference))>0
   AND isfinite(cfg.effective_at) AND cfg.effective_at<=instant AND ((cfg.expiry_kind='policy_exempt' AND cfg.valid_until IS NULL) OR (cfg.expiry_kind='at' AND isfinite(cfg.valid_until) AND cfg.valid_until>cfg.effective_at AND cfg.valid_until>instant)),false);
 END IF;
 IF scope->'configurationRevisionId' IS DISTINCT FROM 'null'::jsonb OR scope->>'authorOriginRegionId' IS DISTINCT FROM a.origin_region_id::text OR scope->>'affiliationSnapshotId' IS DISTINCT FROM v.id::text OR scope->>'affiliationAssertionId' IS DISTINCT FROM a.id::text THEN RETURN false; END IF;
 SELECT s.* INTO selection FROM whaleu_campus.community_identity_heads h JOIN whaleu_campus.community_identity_selections s ON (s.id,s.account_id,s.revision)=(h.selection_id,h.account_id,h.revision) WHERE h.account_id=actor;
 SELECT s.* INTO topo FROM whaleu_campus.community_topology_heads h JOIN whaleu_campus.community_topology_snapshots s ON (s.id,s.revision)=(h.snapshot_id,h.revision) WHERE h.scope_key='community';
 IF selection.id IS NULL OR topo.id IS NULL OR selection.selection_state<>'selected' OR selection.id::text IS DISTINCT FROM scope->>'identitySelectionId'
 OR selection.campus_id::text IS DISTINCT FROM scope->>'identityCampusId' OR selection.affiliation_snapshot_id IS DISTINCT FROM v.id OR selection.affiliation_assertion_id IS DISTINCT FROM a.id
 OR selection.topology_snapshot_id IS DISTINCT FROM topo.id OR topo.id::text IS DISTINCT FROM scope->>'topologySnapshotId'
 OR selection.coverage_state<>'complete' OR selection.provenance_state<>'accepted' OR coalesce(length(whaleu_profile.moderation_trim(selection.source_reference)),0)=0 OR coalesce(length(whaleu_profile.moderation_trim(selection.policy_reference)),0)=0
 OR NOT isfinite(selection.effective_at) OR selection.effective_at>instant OR NOT ((selection.expiry_kind='policy_exempt' AND selection.valid_until IS NULL) OR (selection.expiry_kind='at' AND isfinite(selection.valid_until) AND selection.valid_until>selection.effective_at AND selection.valid_until>instant))
 OR topo.coverage_state<>'complete' OR topo.provenance_state<>'accepted' OR coalesce(length(whaleu_profile.moderation_trim(topo.source_reference)),0)=0 OR coalesce(length(whaleu_profile.moderation_trim(topo.policy_reference)),0)=0
 OR NOT isfinite(topo.effective_at) OR topo.effective_at>instant OR NOT ((topo.expiry_kind='policy_exempt' AND topo.valid_until IS NULL) OR (topo.expiry_kind='at' AND isfinite(topo.valid_until) AND topo.valid_until>topo.effective_at AND topo.valid_until>instant))
 OR whaleu_campus.community_distribution_topology_valid(topo.topology) IS DISTINCT FROM true THEN RETURN false; END IF;
 SELECT r INTO origin FROM jsonb_array_elements(topo.topology->'regions') r WHERE r->>'regionId'=a.origin_region_id::text;
 SELECT p INTO assignment FROM jsonb_array_elements(topo.topology->'assignments') p WHERE p->>'campusId'=selection.campus_id::text;
 SELECT r INTO identity_region FROM jsonb_array_elements(topo.topology->'regions') r WHERE r->>'regionId'=assignment->>'regionId';
 SELECT r INTO target_region FROM jsonb_array_elements(topo.topology->'regions') r WHERE r->>'regionId'=scope->>'originalRegionId';
 IF origin IS NULL OR identity_region IS NULL OR target_region IS NULL OR assignment IS NULL OR assignment->>'coverage' IS DISTINCT FROM 'complete' OR assignment->'isActive' IS DISTINCT FROM 'true'::jsonb
 OR origin->>'institutionId' IS DISTINCT FROM a.issuer_institution_id::text OR assignment->>'institutionId' IS DISTINCT FROM a.issuer_institution_id::text
 OR identity_region->>'groupId' IS DISTINCT FROM origin->>'groupId' OR scope->>'identityRegionId' IS DISTINCT FROM identity_region->>'regionId' THEN RETURN false; END IF;
 IF EXISTS(SELECT 1 FROM (VALUES(origin),(identity_region),(target_region)) node(value)
  WHERE value->>'coverage' IS DISTINCT FROM 'complete' OR value->'isActive' IS DISTINCT FROM 'true'::jsonb
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(topo.topology->'groups') g WHERE g->>'groupId'=value->>'groupId' AND g->>'coverage'='complete' AND g->'isActive'='true'::jsonb)
  OR NOT EXISTS(SELECT 1 FROM whaleu_campus.operating_regions r WHERE r.id=(value->>'regionId')::uuid AND r.is_active)) THEN RETURN false; END IF;
 IF mode='anonymous' AND target_region->>'groupId' IS DISTINCT FROM identity_region->>'groupId' THEN RETURN false;END IF;
 RETURN EXISTS(SELECT 1 FROM whaleu_campus.campuses c JOIN whaleu_campus.institutions i ON i.id=c.institution_id JOIN whaleu_campus.campus_region_assignments assignment ON assignment.campus_id=c.id
  WHERE c.id=selection.campus_id AND c.is_active AND c.institution_id=a.issuer_institution_id AND assignment.operating_region_id=(scope->>'identityRegionId')::uuid);
EXCEPTION WHEN OTHERS THEN RETURN false;END $$;

CREATE FUNCTION whaleu_community.rating_target_link_admitted(e jsonb) RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
DECLARE b jsonb:=e->'component'->'binding';actor uuid:=(e->>'accountId')::uuid;BEGIN
 RETURN whaleu_community.rating_target_link_envelope_valid(e) IS TRUE
 AND whaleu_ratings.community_link_binding_current(b,true) IS TRUE
 AND whaleu_community.rating_target_link_destination_current(actor,e->'scope',e->>'authorMode') IS TRUE
 AND (b->'selector'->>'kind'='global' OR (b->'selector'->>'campusId'=e->'scope'->>'identityCampusId' AND e->'scope'->>'identityRegionId'=e->'scope'->>'originalRegionId'));
EXCEPTION WHEN OTHERS THEN RETURN false;END$$;
CREATE FUNCTION whaleu_community.rating_target_link_fresh_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e jsonb;BEGIN
 IF TG_TABLE_NAME='post_rating_target_links' THEN
  SELECT envelope INTO e FROM whaleu_community.content_approval_decisions WHERE id=NEW.decision_id;
  IF e->'component' IS DISTINCT FROM NEW.component OR NEW.publication_transaction<>pg_current_xact_id() OR NEW.intent_hash IS DISTINCT FROM whaleu_community.rating_target_link_intent_hash(e) THEN RAISE EXCEPTION 'Card requires exact original reviewed intent' USING ERRCODE='23514';END IF;
 ELSE e:=NEW.envelope;IF e->>'version'<>'5' THEN RETURN NEW;END IF;END IF;
 IF whaleu_community.rating_target_link_admitted(e) IS DISTINCT FROM true THEN RAISE EXCEPTION 'Card target must be exactly current and public' USING ERRCODE='23514';END IF;
 RETURN NEW;END$$;
CREATE TRIGGER rating_target_link_fresh BEFORE INSERT ON whaleu_community.post_rating_target_links FOR EACH ROW EXECUTE FUNCTION whaleu_community.rating_target_link_fresh_guard();
CREATE TRIGGER rating_target_link_review_fresh BEFORE INSERT ON whaleu_community.text_review_requests FOR EACH ROW EXECUTE FUNCTION whaleu_community.rating_target_link_fresh_guard();
CREATE TRIGGER rating_target_link_decision_fresh BEFORE INSERT ON whaleu_community.content_approval_decisions FOR EACH ROW WHEN(NEW.envelope_version=5) EXECUTE FUNCTION whaleu_community.rating_target_link_fresh_guard();


CREATE FUNCTION whaleu_community.rating_target_link_review_current(decision uuid,consume boolean DEFAULT false) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT coalesce((SELECT d.envelope_version=5 AND d.result='allow' AND d.coverage='complete' AND d.provenance='accepted' AND p.policy_key='local-explicit-v1' AND p.version=1 AND p.coverage='complete' AND p.provenance='accepted'
 AND whaleu_community.rating_target_link_envelope_valid(d.envelope)
 AND d.digest=encode(sha256(convert_to('whaleu-content-approval:v5'||chr(10)||whaleu_community.content_canonical_json(d.envelope),'UTF8')),'hex')
 AND length(whaleu_profile.moderation_trim(p.issuer))>0 AND length(whaleu_profile.moderation_trim(p.provenance_ref))>0 AND length(whaleu_profile.moderation_trim(d.issuer))>0 AND length(whaleu_profile.moderation_trim(d.provenance_ref))>0
 AND length(whaleu_profile.moderation_trim(e.issuer))>0 AND length(whaleu_profile.moderation_trim(e.provenance_ref))>0
 AND e.state='allow' AND e.coverage='complete' AND e.provenance='accepted' AND isfinite(p.valid_from) AND isfinite(d.evaluated_at) AND isfinite(e.occurred_at) AND isfinite(d.consume_until) AND (d.visibility_until IS NULL OR isfinite(d.visibility_until)) AND (p.valid_until IS NULL OR isfinite(p.valid_until)) AND p.valid_from<=d.evaluated_at AND d.evaluated_at<=clock_timestamp() AND e.occurred_at>=d.evaluated_at AND e.occurred_at<=clock_timestamp()
 AND (p.valid_until IS NULL OR p.valid_until>clock_timestamp()) AND (d.visibility_until IS NULL OR d.visibility_until>clock_timestamp()) AND (NOT consume OR d.consume_until>clock_timestamp())
 FROM whaleu_community.content_approval_decisions d JOIN whaleu_community.content_approval_policies p ON p.id=d.policy_revision_id JOIN whaleu_community.content_approval_heads h ON h.decision_id=d.id JOIN whaleu_community.content_approval_events e ON e.id=h.event_id AND e.decision_id=d.id WHERE d.id=decision),false)
$$;

CREATE FUNCTION whaleu_community.rating_target_link_assert(postid uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE p whaleu_community.posts;l whaleu_community.post_rating_target_links;b whaleu_community.content_approval_bindings;q whaleu_community.publication_requests;BEGIN
 SELECT * INTO p FROM whaleu_community.posts WHERE id=postid;
 IF p.publication_envelope_version=5 AND p.publication_transaction=pg_current_xact_id() THEN
  LOCK TABLE whaleu_ratings.navigation_epoch,whaleu_ratings.random_pool_epoch,whaleu_ratings.scoped_source_epoch,whaleu_ratings.scope_protocol_epoch,whaleu_ratings.target_cover_capability_epoch,whaleu_ratings.category_icon_epoch,whaleu_media.media_owner_states,whaleu_community.rating_review_epoch,whaleu_community.rating_review_binding_epoch,whaleu_community.content_approval_heads,whaleu_community.content_approval_policies,whaleu_campus.community_identity_heads,whaleu_campus.community_topology_heads,whaleu_campus.community_topology_snapshots,whaleu_campus.campuses,whaleu_campus.institutions,whaleu_campus.campus_region_assignments,whaleu_campus.operating_regions,whaleu_community.spaces,whaleu_community.region_policy_heads,whaleu_community.region_policy_revisions,whaleu_verification.account_heads,whaleu_safety.account_heads,whaleu_safety.account_punishment_heads IN SHARE MODE NOWAIT;
 END IF;
 SELECT * INTO l FROM whaleu_community.post_rating_target_links WHERE post_id=postid;
 IF p.publication_envelope_version<>5 AND l.post_id IS NULL THEN RETURN;END IF;
 SELECT * INTO b FROM whaleu_community.content_approval_bindings WHERE content_kind='post' AND content_id=postid AND content_version=1;
 SELECT * INTO q FROM whaleu_community.publication_requests WHERE account_id=l.account_id AND client_request_id=l.client_request_id;
 IF p.id IS NULL OR p.publication_envelope_version IS DISTINCT FROM 5 OR l.post_id IS NULL OR b.envelope_version IS DISTINCT FROM 5
 OR (p.account_id,p.publication_transaction) IS DISTINCT FROM (l.account_id,l.publication_transaction)
 OR (b.account_id,b.decision_id,b.digest) IS DISTINCT FROM (l.account_id,l.decision_id,l.digest)
 OR b.envelope->'component' IS DISTINCT FROM l.component OR b.envelope->>'text' IS DISTINCT FROM p.text OR b.envelope->>'authorMode' IS DISTINCT FROM p.author_mode
 OR b.envelope->>'category'<>'discussion' OR b.envelope->>'commentsPolicy' IS DISTINCT FROM p.comments_policy OR b.envelope->>'spaceId' IS DISTINCT FROM p.space_id::text
 OR q.operation IS DISTINCT FROM 'publish_post' OR q.payload_hash IS DISTINCT FROM l.intent_hash OR l.intent_hash IS DISTINCT FROM whaleu_community.rating_target_link_intent_hash(b.envelope)
 OR q.receipt->>'outcome' IS DISTINCT FROM 'created' OR q.receipt->>'resourceId' IS DISTINCT FROM p.id::text
 OR EXISTS(SELECT 1 FROM whaleu_community.post_images WHERE post_id=postid) OR EXISTS(SELECT 1 FROM whaleu_community.polls WHERE post_id=postid)
 OR EXISTS(SELECT 1 FROM whaleu_community.formations WHERE post_id=postid) OR EXISTS(SELECT 1 FROM whaleu_community.trading_listings WHERE post_id=postid)
 OR EXISTS(SELECT 1 FROM whaleu_community.post_distribution_bindings WHERE post_id=postid)
 OR (l.publication_transaction=pg_current_xact_id() AND (NOT whaleu_community.rating_target_link_admitted(b.envelope) OR NOT whaleu_community.rating_target_link_review_current(b.decision_id,true)))
 THEN RAISE EXCEPTION 'Rating target card causal completeness failed' USING ERRCODE='23514',CONSTRAINT='rating_target_link_causal';END IF;END$$;
CREATE FUNCTION whaleu_community.rating_target_link_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE postid uuid;request whaleu_community.publication_requests;BEGIN
 IF TG_TABLE_NAME='posts' THEN postid:=NEW.id;
 ELSIF TG_TABLE_NAME='content_approval_bindings' THEN IF NEW.content_kind<>'post' THEN RETURN NULL;END IF;postid:=NEW.content_id;
 ELSIF TG_TABLE_NAME='publication_requests' THEN
  -- Deferred INSERT retains its original NULL receipt even when this transaction
  -- later completes publication. Inspect the final original-key row instead.
  SELECT * INTO request FROM whaleu_community.publication_requests
   WHERE account_id=NEW.account_id AND client_request_id=NEW.client_request_id;
  IF request.operation IS DISTINCT FROM 'publish_post' OR request.receipt->>'outcome' IS DISTINCT FROM 'created' THEN RETURN NULL;END IF;
  postid:=(request.receipt->>'resourceId')::uuid;
 ELSE postid:=NEW.post_id;END IF;
 PERFORM whaleu_community.rating_target_link_assert(postid);RETURN NULL;END$$;
CREATE CONSTRAINT TRIGGER rating_target_link_complete AFTER INSERT ON whaleu_community.post_rating_target_links DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community.rating_target_link_complete();
CREATE CONSTRAINT TRIGGER rating_target_link_post_complete AFTER INSERT ON whaleu_community.posts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.publication_envelope_version=5) EXECUTE FUNCTION whaleu_community.rating_target_link_complete();
CREATE CONSTRAINT TRIGGER rating_target_link_binding_complete AFTER INSERT ON whaleu_community.content_approval_bindings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.envelope_version=5) EXECUTE FUNCTION whaleu_community.rating_target_link_complete();
CREATE CONSTRAINT TRIGGER rating_target_link_request_complete AFTER INSERT OR UPDATE ON whaleu_community.publication_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community.rating_target_link_complete();

-- SQL-only definition consumers must reconstruct the component too. No v5 body
-- is accepted by old none-only reconstruction or a supplemental unchecked row.
ALTER FUNCTION whaleu_community.profile_moderation_definition(text,uuid,jsonb) RENAME TO profile_moderation_definition_pre_rating_link;
CREATE FUNCTION whaleu_community.profile_moderation_definition(target_kind text,target uuid,scope jsonb) RETURNS jsonb LANGUAGE plpgsql VOLATILE AS $$
DECLARE p whaleu_community.posts;l whaleu_community.post_rating_target_links;e jsonb;BEGIN
 IF target_kind<>'post' THEN RETURN whaleu_community.profile_moderation_definition_pre_rating_link(target_kind,target,scope);END IF;
 SELECT * INTO p FROM whaleu_community.posts WHERE id=target;
 IF p.publication_envelope_version<>5 THEN RETURN whaleu_community.profile_moderation_definition_pre_rating_link(target_kind,target,scope);END IF;
 SELECT * INTO l FROM whaleu_community.post_rating_target_links WHERE post_id=target;
 IF l.post_id IS NULL OR whaleu_ratings.community_link_binding_current(l.component->'binding',false) IS DISTINCT FROM true OR p.publication_state<>'published' OR p.allow_anonymous_dm IS NOT NULL OR p.feedback IS NOT NULL
 OR EXISTS(SELECT 1 FROM whaleu_community.post_images WHERE post_id=target) OR EXISTS(SELECT 1 FROM whaleu_community.polls WHERE post_id=target) OR EXISTS(SELECT 1 FROM whaleu_community.formations WHERE post_id=target) OR EXISTS(SELECT 1 FROM whaleu_community.trading_listings WHERE post_id=target) THEN RETURN NULL;END IF;
 e:=jsonb_build_object('version',5,'accountId',p.account_id,'purpose','publish_post','spaceId',p.space_id,'category',p.category,'authorMode',p.author_mode,'commentsPolicy',p.comments_policy,'postId',NULL,'rootCommentId',NULL,'targetReplyId',NULL,'text',p.text,'images','[]'::jsonb,'component',l.component,'trading',NULL,'scope',scope);
 RETURN CASE WHEN whaleu_community.rating_target_link_envelope_valid(e) THEN e ELSE NULL END;END$$;
ALTER FUNCTION whaleu_community.post_category_supported(uuid) RENAME TO post_category_supported_pre_rating_link;
CREATE FUNCTION whaleu_community.post_category_supported(postid uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM whaleu_community.posts WHERE id=postid AND publication_envelope_version<>5) AND whaleu_community.post_category_supported_pre_rating_link(postid)
$$;

-- Reverse-side completeness is explicit even when an older component's guard
-- happens to reject approved-row mutation. This covers post-commit INSERTs too.
CREATE FUNCTION whaleu_community.rating_target_link_component_exclusive() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE postid uuid;BEGIN
 postid:=NEW.post_id;
 IF EXISTS(SELECT 1 FROM whaleu_community.posts WHERE id=postid AND publication_envelope_version=5)
 THEN RAISE EXCEPTION 'Rating target cards cannot acquire another component or distribution' USING ERRCODE='23514',CONSTRAINT='rating_target_link_causal';END IF;
 RETURN NEW;END$$;
DO $$DECLARE relation text;BEGIN
 FOREACH relation IN ARRAY ARRAY['post_images','polls','formations','trading_listings','post_distribution_bindings'] LOOP
  EXECUTE format('CREATE TRIGGER rating_target_link_exclusive BEFORE INSERT OR UPDATE ON whaleu_community.%I FOR EACH ROW EXECUTE FUNCTION whaleu_community.rating_target_link_component_exclusive()',relation);
 END LOOP;END$$;

CREATE FUNCTION whaleu_community.rating_target_link_review_complete() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF NEW.envelope->>'version'<>'5' THEN RETURN NULL;END IF;
 LOCK TABLE whaleu_ratings.navigation_epoch,whaleu_ratings.random_pool_epoch,whaleu_ratings.scoped_source_epoch,whaleu_ratings.scope_protocol_epoch,whaleu_ratings.target_cover_capability_epoch,whaleu_ratings.category_icon_epoch,whaleu_media.media_owner_states,whaleu_community.rating_review_epoch,whaleu_community.rating_review_binding_epoch,whaleu_community.content_approval_policies,whaleu_campus.community_identity_heads,whaleu_campus.community_topology_heads,whaleu_campus.community_topology_snapshots,whaleu_campus.campuses,whaleu_campus.institutions,whaleu_campus.campus_region_assignments,whaleu_campus.operating_regions,whaleu_community.spaces,whaleu_community.region_policy_heads,whaleu_community.region_policy_revisions,whaleu_verification.account_heads,whaleu_safety.account_heads,whaleu_safety.account_punishment_heads IN SHARE MODE NOWAIT;
 IF whaleu_community.rating_target_link_admitted(NEW.envelope) IS DISTINCT FROM true THEN RAISE EXCEPTION 'Rating card review source changed before commit' USING ERRCODE='23514',CONSTRAINT='rating_target_link_causal';END IF;
 RETURN NULL;END$$;
CREATE CONSTRAINT TRIGGER rating_target_link_review_complete AFTER INSERT ON whaleu_community.text_review_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community.rating_target_link_review_complete();
CREATE CONSTRAINT TRIGGER rating_target_link_decision_complete AFTER INSERT ON whaleu_community.content_approval_decisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.envelope_version=5) EXECUTE FUNCTION whaleu_community.rating_target_link_review_complete();
