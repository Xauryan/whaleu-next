-- M3A native category creation. Existing effective rows remain opaque; no old
-- category is inferred to be a canonical base, Review approval, or campus grant.
-- This additive migration changes no v1-v7 request or receipt bytes.
SET LOCAL lock_timeout='5s';
SELECT pg_advisory_xact_lock(hashtextextended('whaleu:named-block-policy:v1',0));
LOCK TABLE whaleu_ratings.random_pool_epoch,whaleu_ratings.navigation_epoch IN ROW EXCLUSIVE MODE;

CREATE FUNCTION whaleu_ratings.category_intent_valid(i jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE n jsonb;seen text[]:=ARRAY[]::text[];depths jsonb:='{}';depth integer;position integer:=0;k text;
 keys text[]:=ARRAY['clientRequestId','regionId','expectedCatalogRevision','expectedScopeRevision','parentId','expectedParentRevision','nodes','assetIds'];
BEGIN
 IF NOT coalesce(jsonb_typeof(i)='object' AND i-keys='{}'::jsonb AND i ?& keys
  AND jsonb_typeof(i->'clientRequestId')='string' AND whaleu_ratings.owner_delete_id_valid(i->>'clientRequestId')
  AND jsonb_typeof(i->'expectedScopeRevision')='string' AND i->>'expectedScopeRevision' ~ '^[A-Za-z0-9_-]{43}$'
  AND (i->'parentId'='null'::jsonb)=(i->'expectedParentRevision'='null'::jsonb)
  AND jsonb_typeof(i->'nodes')='array' AND i->'assetIds'='[]'::jsonb,false) THEN RETURN false;END IF;
 FOREACH k IN ARRAY ARRAY['regionId','expectedCatalogRevision','parentId','expectedParentRevision'] LOOP
  IF NOT coalesce(i->k='null'::jsonb OR (jsonb_typeof(i->k)='string' AND whaleu_ratings.owner_delete_id_valid(i->>k)),false) THEN RETURN false;END IF;
 END LOOP;
 IF jsonb_array_length(i->'nodes') NOT BETWEEN 1 AND 32 THEN RETURN false;END IF;
 FOR n IN SELECT value FROM jsonb_array_elements(i->'nodes') LOOP
  IF NOT coalesce(jsonb_typeof(n)='object' AND n-ARRAY['key','parentKey','name','description']='{}'::jsonb AND n ?& ARRAY['key','parentKey','name','description']
   AND jsonb_typeof(n->'key')='string' AND n->>'key' ~ '^[a-z][a-z0-9_]{0,31}$' AND NOT n->>'key'=ANY(seen)
   AND jsonb_typeof(n->'name')='string' AND whaleu_ratings.canonical_text(n->>'name',100)
   AND jsonb_typeof(n->'description')='string' AND (n->>'description'='' OR whaleu_ratings.canonical_text(n->>'description',500))
   AND ((position=0 AND n->'parentKey'='null'::jsonb) OR (position>0 AND jsonb_typeof(n->'parentKey')='string' AND n->>'parentKey'=ANY(seen))),false) THEN RETURN false;END IF;
  depth:=CASE WHEN position=0 THEN 1 ELSE (depths->>(n->>'parentKey'))::integer+1 END;
  IF depth>3 THEN RETURN false;END IF;
  seen:=array_append(seen,n->>'key');depths:=depths||jsonb_build_object(n->>'key',depth);position:=position+1;
 END LOOP;RETURN true;
END $$;
CREATE FUNCTION whaleu_ratings.category_intent_hash(i jsonb) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT encode(sha256(convert_to(E'whaleu:rating-category-create:v1\n'||whaleu_ratings.creation_canonical_json(jsonb_build_object('operation','create_categories','intent',i)),'UTF8')),'hex')
$$;
CREATE TABLE whaleu_ratings.category_command_preparations (
 account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),request_id uuid NOT NULL,intent_hash text NOT NULL,
 session_id uuid NOT NULL,context_revision text NOT NULL UNIQUE CHECK(context_revision ~ '^[A-Za-z0-9_-]{43}$'),
 release_id uuid NOT NULL UNIQUE,scope_version_id uuid NOT NULL UNIQUE,topology_snapshot_id uuid NOT NULL REFERENCES whaleu_campus.community_topology_snapshots(id),
 campus_ids uuid[] NOT NULL,intent jsonb NOT NULL,nodes jsonb NOT NULL,catalogs jsonb NOT NULL,envelope jsonb NOT NULL,
 authority_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
 prepared_at timestamptz NOT NULL DEFAULT clock_timestamp(),valid_until timestamptz NOT NULL,preparation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 PRIMARY KEY(account_id,request_id),FOREIGN KEY(account_id,request_id) REFERENCES whaleu_ratings.command_claims(account_id,request_id),
 CHECK(whaleu_ratings.category_intent_valid(intent)),CHECK(intent_hash=whaleu_ratings.category_intent_hash(intent)),CHECK(intent->>'clientRequestId'=request_id::text),
 CHECK(jsonb_typeof(nodes)='array' AND jsonb_array_length(nodes) BETWEEN 1 AND 32),
 CHECK(jsonb_typeof(catalogs)='array' AND jsonb_array_length(catalogs) BETWEEN 1 AND 33),
 CHECK(cardinality(campus_ids)<=1000 AND array_position(campus_ids,NULL) IS NULL),
 CHECK(isfinite(prepared_at) AND isfinite(valid_until) AND valid_until>prepared_at AND valid_until<=prepared_at+interval '5 minutes')
);
CREATE TABLE whaleu_ratings.category_command_transitions (
 release_id uuid PRIMARY KEY,actor_account_id uuid NOT NULL,request_id uuid NOT NULL,intent_hash text NOT NULL,intent jsonb NOT NULL,context_revision text NOT NULL,
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(occurred_at)),mutation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 UNIQUE(actor_account_id,request_id),FOREIGN KEY(actor_account_id,request_id) REFERENCES whaleu_ratings.requests(account_id,request_id),
 FOREIGN KEY(actor_account_id,request_id) REFERENCES whaleu_ratings.category_command_preparations(account_id,request_id),
 CHECK(whaleu_ratings.category_intent_valid(intent)),CHECK(intent_hash=whaleu_ratings.category_intent_hash(intent)),CHECK(intent->>'clientRequestId'=request_id::text)
);
CREATE TABLE whaleu_ratings.category_command_closures (
 actor_account_id uuid NOT NULL,request_id uuid NOT NULL,intent_hash text NOT NULL,intent jsonb NOT NULL,
 code text NOT NULL CHECK(code IN ('RATING_CATEGORY_CONTEXT_CHANGED','CONTENT_REJECTED','RATING_CATEGORY_CANCELLED','RATING_NOT_FOUND','PHONE_VERIFICATION_REQUIRED','SAFETY_ACTION_RESTRICTED')),
 mutation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),PRIMARY KEY(actor_account_id,request_id),
 FOREIGN KEY(actor_account_id,request_id) REFERENCES whaleu_ratings.requests(account_id,request_id),
 CHECK(whaleu_ratings.category_intent_valid(intent)),CHECK(intent_hash=whaleu_ratings.category_intent_hash(intent)),CHECK(intent->>'clientRequestId'=request_id::text)
);
CREATE TABLE whaleu_ratings.category_scope_versions (
 id uuid PRIMARY KEY,region_id uuid REFERENCES whaleu_campus.operating_regions(id),
 topology_snapshot_id uuid NOT NULL REFERENCES whaleu_campus.community_topology_snapshots(id),campus_ids uuid[] NOT NULL,
 release_id uuid NOT NULL UNIQUE REFERENCES whaleu_ratings.category_command_transitions(release_id),
 publication_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 CHECK(array_position(campus_ids,NULL) IS NULL AND cardinality(campus_ids)<=1000),CHECK(region_id IS NULL OR cardinality(campus_ids)>0)
);
CREATE TABLE whaleu_ratings.category_identities (
 id uuid PRIMARY KEY,creator_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),kind text NOT NULL CHECK(kind='general'),
 is_system boolean NOT NULL CHECK(NOT is_system),system_key text CHECK(system_key IS NULL),source_kind text NOT NULL CHECK(source_kind='native'),
 creation_release_id uuid NOT NULL REFERENCES whaleu_ratings.category_command_transitions(release_id),
 creation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id()
);
CREATE TABLE whaleu_ratings.category_base_versions (
 category_id uuid NOT NULL REFERENCES whaleu_ratings.category_identities(id),revision uuid NOT NULL,parent_id uuid REFERENCES whaleu_ratings.category_identities(id),
 level smallint NOT NULL CHECK(level BETWEEN 1 AND 3),name text NOT NULL,description text NOT NULL,active boolean NOT NULL CHECK(active),is_global boolean NOT NULL,
 scope_version_id uuid NOT NULL REFERENCES whaleu_ratings.category_scope_versions(id),release_id uuid NOT NULL REFERENCES whaleu_ratings.category_command_transitions(release_id),
 envelope jsonb NOT NULL,published_at timestamptz NOT NULL CHECK(isfinite(published_at)),publication_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 PRIMARY KEY(category_id,revision),CHECK((parent_id IS NULL)=(level=1)),CHECK(parent_id IS DISTINCT FROM category_id),
 CHECK(whaleu_ratings.canonical_text(name,100) AND (description='' OR whaleu_ratings.canonical_text(description,500)))
);
CREATE TABLE whaleu_ratings.category_base_heads (
 category_id uuid PRIMARY KEY REFERENCES whaleu_ratings.category_identities(id),revision uuid NOT NULL,
 FOREIGN KEY(category_id,revision) REFERENCES whaleu_ratings.category_base_versions(category_id,revision)
);
CREATE TABLE whaleu_ratings.category_release_catalogs (
 release_id uuid NOT NULL REFERENCES whaleu_ratings.category_command_transitions(release_id),scope_key text NOT NULL,region_id uuid REFERENCES whaleu_campus.operating_regions(id),
 before_catalog_id uuid REFERENCES whaleu_ratings.catalogs(id),after_catalog_id uuid NOT NULL UNIQUE REFERENCES whaleu_ratings.catalogs(id),campus_ids uuid[] NOT NULL,
 publication_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),PRIMARY KEY(release_id,scope_key),
 CHECK(scope_key=coalesce(region_id::text,'global')),CHECK(before_catalog_id IS DISTINCT FROM after_catalog_id)
);
CREATE TABLE whaleu_ratings.catalog_materializations (
 catalog_id uuid PRIMARY KEY REFERENCES whaleu_ratings.catalogs(id),source_kind text NOT NULL CHECK(source_kind IN ('opaque','category_release','target_create')),
 release_id uuid REFERENCES whaleu_ratings.category_command_transitions(release_id),before_catalog_id uuid REFERENCES whaleu_ratings.catalogs(id),
 target_id uuid REFERENCES whaleu_ratings.target_create_transitions(target_id),
 topology_snapshot_id uuid REFERENCES whaleu_campus.community_topology_snapshots(id),campus_ids uuid[] NOT NULL,
 publication_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 CHECK((source_kind='opaque' AND release_id IS NULL AND before_catalog_id IS NULL AND target_id IS NULL AND topology_snapshot_id IS NULL AND campus_ids='{}'::uuid[])
  OR (source_kind='category_release' AND release_id IS NOT NULL AND target_id IS NULL AND topology_snapshot_id IS NOT NULL)
  OR (source_kind='target_create' AND release_id IS NULL AND before_catalog_id IS NOT NULL AND target_id IS NOT NULL)),
 CHECK(before_catalog_id IS DISTINCT FROM catalog_id)
);
CREATE TABLE whaleu_ratings.catalog_category_lineage (
 catalog_id uuid NOT NULL,category_id uuid NOT NULL,effective_revision uuid NOT NULL,source_kind text NOT NULL CHECK(source_kind IN ('opaque','native')),
 base_revision uuid,scope_version_id uuid REFERENCES whaleu_ratings.category_scope_versions(id),topology_snapshot_id uuid REFERENCES whaleu_campus.community_topology_snapshots(id),
 PRIMARY KEY(catalog_id,category_id),FOREIGN KEY(catalog_id,category_id) REFERENCES whaleu_ratings.categories(catalog_id,id),
 FOREIGN KEY(category_id,base_revision) REFERENCES whaleu_ratings.category_base_versions(category_id,revision),
 CHECK((source_kind='opaque' AND base_revision IS NULL AND scope_version_id IS NULL AND topology_snapshot_id IS NULL)
  OR (source_kind='native' AND base_revision IS NOT NULL AND scope_version_id IS NOT NULL AND topology_snapshot_id IS NOT NULL))
);
-- Frozen historical effective rows are explicitly opaque, including every old
-- native-target copy. The backfill creates no canonical source or Review grant.
INSERT INTO whaleu_ratings.catalog_materializations(catalog_id,source_kind,campus_ids)
 SELECT id,'opaque','{}'::uuid[] FROM whaleu_ratings.catalogs;
INSERT INTO whaleu_ratings.catalog_category_lineage(catalog_id,category_id,effective_revision,source_kind)
 SELECT catalog_id,id,revision,'opaque' FROM whaleu_ratings.categories;

-- REVIEW_FRAGMENT_START
-- M3A Review Owner fragment. Add to the single atomic 0058 after 0057.
-- Separate v4 category purpose and exact immutable category/base bindings.
-- Existing v1-v3 envelopes, digests and target/comment/reply bindings retain
-- their frozen predicates. Integrator owns reverse category release proofs,
-- category/base FK and Safety -> Ratings epochs -> Review binding writer gate.
CREATE FUNCTION whaleu_community.rating_category_keys(e jsonb,keys text[]) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT coalesce(jsonb_typeof(e)='object' AND e-keys='{}'::jsonb AND e ?& keys,false)
$$;
CREATE FUNCTION whaleu_community.rating_category_ids(e jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE value jsonb;previous text;
BEGIN
 IF jsonb_typeof(e) IS DISTINCT FROM 'array' OR jsonb_array_length(e)>1000 THEN RETURN false;END IF;
 FOR value IN SELECT * FROM jsonb_array_elements(e) LOOP
  IF jsonb_typeof(value) IS DISTINCT FROM 'string' OR NOT whaleu_community.rating_target_edit_uuid_valid(value#>>'{}') OR (previous IS NOT NULL AND previous>=value#>>'{}') THEN RETURN false;END IF;
  previous:=value#>>'{}';
 END LOOP;RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
CREATE FUNCTION whaleu_community.rating_category_envelope_shape(e jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE i jsonb;s jsonb;n jsonb;node jsonb;parent jsonb;c jsonb;key text;idx integer;count_nodes integer;seen_keys text[]:=ARRAY[]::text[];seen_ids text[]:=ARRAY[]::text[];seen_revisions text[]:=ARRAY[]::text[];seen_outputs text[]:=ARRAY[]::text[];region_campuses text[]:=ARRAY[]::text[];previous_scope text;scope_key text;campus text;
BEGIN
 IF NOT whaleu_community.rating_category_keys(e,ARRAY['version','purpose','accountId','clientRequestId','releaseId','intent','scope','categories','catalogs','assetIds']) OR e->'version'<>'4'::jsonb OR e->>'purpose'<>'publish_rating_categories' OR e->'assetIds'<>'[]'::jsonb THEN RETURN false;END IF;
 FOREACH key IN ARRAY ARRAY['accountId','clientRequestId','releaseId'] LOOP
  IF jsonb_typeof(e->key) IS DISTINCT FROM 'string' OR NOT whaleu_community.rating_target_edit_uuid_valid(e->>key) THEN RETURN false;END IF;
 END LOOP;
 i:=e->'intent';s:=e->'scope';
 IF NOT whaleu_community.rating_category_keys(i,ARRAY['clientRequestId','regionId','expectedCatalogRevision','expectedScopeRevision','parentId','expectedParentRevision','nodes','assetIds']) OR i->'clientRequestId'<>e->'clientRequestId' OR i->'assetIds'<>'[]'::jsonb THEN RETURN false;END IF;
 FOREACH key IN ARRAY ARRAY['regionId','expectedCatalogRevision','parentId','expectedParentRevision'] LOOP
  IF i->key<>'null'::jsonb AND (jsonb_typeof(i->key) IS DISTINCT FROM 'string' OR NOT whaleu_community.rating_target_edit_uuid_valid(i->>key)) THEN RETURN false;END IF;
 END LOOP;
 IF (i->'parentId'='null'::jsonb)<>(i->'expectedParentRevision'='null'::jsonb) OR jsonb_typeof(i->'expectedScopeRevision') IS DISTINCT FROM 'string' OR i->>'expectedScopeRevision' !~ '^[A-Za-z0-9_-]{43}$' THEN RETURN false;END IF;
 IF NOT whaleu_community.rating_category_keys(s,ARRAY['regionId','topologySnapshotId','campusIds','scopeRevision']) OR s->'regionId'<>i->'regionId' OR s->'scopeRevision'<>i->'expectedScopeRevision' OR jsonb_typeof(s->'topologySnapshotId') IS DISTINCT FROM 'string' OR NOT whaleu_community.rating_target_edit_uuid_valid(s->>'topologySnapshotId') OR NOT whaleu_community.rating_category_ids(s->'campusIds') OR (s->'regionId'<>'null'::jsonb AND jsonb_array_length(s->'campusIds')=0) THEN RETURN false;END IF;
 IF jsonb_typeof(i->'nodes') IS DISTINCT FROM 'array' OR jsonb_typeof(e->'categories') IS DISTINCT FROM 'array' OR jsonb_array_length(e->'categories') NOT BETWEEN 1 AND 32 OR jsonb_array_length(i->'nodes')<>jsonb_array_length(e->'categories') THEN RETURN false;END IF;
 count_nodes:=jsonb_array_length(e->'categories');
 FOR idx IN 0..count_nodes-1 LOOP
  n:=e->'categories'->idx;node:=i->'nodes'->idx;
  IF NOT whaleu_community.rating_category_keys(node,ARRAY['key','parentKey','name','description']) OR NOT whaleu_community.rating_category_keys(n,ARRAY['key','id','revision','parentId','level','name','description','scopeVersionId']) OR jsonb_typeof(node->'key') IS DISTINCT FROM 'string' OR node->>'key' !~ '^[a-z][a-z0-9_]{0,31}$' OR node->>'key'=ANY(seen_keys) OR n->'key'<>node->'key' OR n->'name'<>node->'name' OR n->'description'<>node->'description' THEN RETURN false;END IF;
  FOREACH key IN ARRAY ARRAY['id','revision','scopeVersionId'] LOOP
   IF jsonb_typeof(n->key) IS DISTINCT FROM 'string' OR NOT whaleu_community.rating_target_edit_uuid_valid(n->>key) THEN RETURN false;END IF;
  END LOOP;
  IF n->>'id'=ANY(seen_ids) OR n->>'revision'=ANY(seen_revisions) OR n->'scopeVersionId'<>e->'categories'->0->'scopeVersionId' OR jsonb_typeof(n->'name') IS DISTINCT FROM 'string' OR jsonb_typeof(n->'description') IS DISTINCT FROM 'string' OR NOT whaleu_community.rating_target_edit_text_valid(n->>'name',100,true) OR NOT whaleu_community.rating_target_edit_text_valid(n->>'description',500,false) OR n->'level' NOT IN ('1'::jsonb,'2'::jsonb,'3'::jsonb) THEN RETURN false;END IF;
  IF n->'parentId'<>'null'::jsonb AND (jsonb_typeof(n->'parentId') IS DISTINCT FROM 'string' OR NOT whaleu_community.rating_target_edit_uuid_valid(n->>'parentId')) THEN RETURN false;END IF;
  IF idx=0 THEN
   IF node->'parentKey'<>'null'::jsonb OR n->'parentId'<>i->'parentId' OR (n->'parentId'='null'::jsonb AND n->'level'<>'1'::jsonb) OR (n->'parentId'<>'null'::jsonb AND n->'level'='1'::jsonb) THEN RETURN false;END IF;
  ELSE
   IF jsonb_typeof(node->'parentKey') IS DISTINCT FROM 'string' OR NOT (node->>'parentKey'=ANY(seen_keys)) THEN RETURN false;END IF;
   parent:=e->'categories'->(array_position(seen_keys,node->>'parentKey')-1);
   IF n->'parentId'<>parent->'id' OR (n->>'level')::integer<>(parent->>'level')::integer+1 THEN RETURN false;END IF;
  END IF;
  seen_keys:=array_append(seen_keys,node->>'key');seen_ids:=array_append(seen_ids,n->>'id');seen_revisions:=array_append(seen_revisions,n->>'revision');
 END LOOP;
 IF i->>'parentId'=ANY(seen_ids) THEN RETURN false;END IF;
 IF jsonb_typeof(e->'catalogs') IS DISTINCT FROM 'array' OR jsonb_array_length(e->'catalogs') NOT BETWEEN 1 AND 33 THEN RETURN false;END IF;
 FOR c IN SELECT * FROM jsonb_array_elements(e->'catalogs') LOOP
  IF NOT whaleu_community.rating_category_keys(c,ARRAY['regionId','beforeCatalogId','afterCatalogId','campusIds']) OR NOT whaleu_community.rating_category_ids(c->'campusIds') OR jsonb_typeof(c->'afterCatalogId') IS DISTINCT FROM 'string' OR NOT whaleu_community.rating_target_edit_uuid_valid(c->>'afterCatalogId') OR c->>'afterCatalogId'=ANY(seen_outputs) OR c->'afterCatalogId'=c->'beforeCatalogId' THEN RETURN false;END IF;
  FOREACH key IN ARRAY ARRAY['regionId','beforeCatalogId'] LOOP
   IF c->key<>'null'::jsonb AND (jsonb_typeof(c->key) IS DISTINCT FROM 'string' OR NOT whaleu_community.rating_target_edit_uuid_valid(c->>key)) THEN RETURN false;END IF;
  END LOOP;
  scope_key:=coalesce(c->>'regionId','');
  IF previous_scope IS NOT NULL AND previous_scope>=scope_key THEN RETURN false;END IF;previous_scope:=scope_key;
  IF c->'regionId'<>'null'::jsonb THEN
   IF jsonb_array_length(c->'campusIds')=0 THEN RETURN false;END IF;
   FOR campus IN SELECT jsonb_array_elements_text(c->'campusIds') LOOP
    IF campus=ANY(region_campuses) THEN RETURN false;END IF;region_campuses:=array_append(region_campuses,campus);
   END LOOP;
  END IF;
  IF s->'regionId'<>'null'::jsonb AND (jsonb_array_length(e->'catalogs')<>1 OR c->'regionId'<>s->'regionId' OR c->'campusIds'<>s->'campusIds') THEN RETURN false;END IF;
  IF c->'regionId'=s->'regionId' AND c->'beforeCatalogId'<>i->'expectedCatalogRevision' THEN RETURN false;END IF;
  seen_outputs:=array_append(seen_outputs,c->>'afterCatalogId');
 END LOOP;
 IF s->'regionId'='null'::jsonb AND (e->'catalogs'->0->'regionId'<>'null'::jsonb OR e->'catalogs'->0->'campusIds'<>s->'campusIds' OR (SELECT coalesce(jsonb_agg(value ORDER BY value),'[]'::jsonb) FROM unnest(region_campuses) value)<>s->'campusIds') THEN RETURN false;END IF;
 RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
-- Copy the already-installed v1-v3 function body, then preserve its original
-- OID for all existing CHECK constraints. No old branch is reinterpreted.
DO $$ DECLARE definition text;BEGIN
 definition:=pg_get_functiondef('whaleu_community.rating_envelope_shape(jsonb,text)'::regprocedure);
 IF position('rating_target_edit_envelope_shape' in definition)=0 THEN RAISE EXCEPTION 'Expected Review v3 baseline missing' USING ERRCODE='23514';END IF;
 definition:=replace(definition,'FUNCTION whaleu_community.rating_envelope_shape(', 'FUNCTION whaleu_community.rating_envelope_shape_v3(');
 EXECUTE definition;
END $$;
CREATE OR REPLACE FUNCTION whaleu_community.rating_envelope_shape(e jsonb,op text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE WHEN op='publish_rating_categories' THEN whaleu_community.rating_category_envelope_shape(e) ELSE whaleu_community.rating_envelope_shape_v3(e,op) END
$$;
ALTER TABLE whaleu_community.rating_approval_decisions DROP CONSTRAINT rating_decision_protocol_v3;
ALTER TABLE whaleu_community.rating_approval_decisions ADD CONSTRAINT rating_decision_protocol_v4 CHECK(
 (operation IN ('publish_rating_target','publish_rating_comment') AND envelope_version=1)
 OR (operation='publish_rating_reply' AND envelope_version=2)
 OR (operation='edit_rating_target' AND envelope_version=3)
 OR (operation='publish_rating_categories' AND envelope_version=4));
CREATE TABLE whaleu_community.rating_category_base_bindings (
 category_id uuid NOT NULL,base_revision uuid NOT NULL,release_id uuid NOT NULL,
 decision_id uuid NOT NULL,account_id uuid NOT NULL,
 operation text NOT NULL CHECK(operation='publish_rating_categories'),envelope_version integer NOT NULL CHECK(envelope_version=4),
 digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),envelope jsonb NOT NULL,scope jsonb NOT NULL,
 bound_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(bound_at)),publication_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 PRIMARY KEY(category_id,base_revision),UNIQUE(decision_id,category_id),
 FOREIGN KEY(decision_id,account_id,operation,envelope_version,digest) REFERENCES whaleu_community.rating_approval_decisions(id,account_id,operation,envelope_version,digest),
 CHECK(whaleu_community.rating_category_envelope_shape(envelope)),
 CHECK(envelope->>'accountId'=account_id::text AND envelope->>'releaseId'=release_id::text AND scope=envelope->'scope'),
 CHECK(digest=encode(sha256(convert_to('whaleu-rating-content-approval:v4'||chr(10)||whaleu_community.content_canonical_json(envelope),'UTF8')),'hex'))
);
CREATE FUNCTION whaleu_community.rating_category_decision_current(_decision uuid,_consume boolean) RETURNS boolean LANGUAGE sql AS $$
 WITH instant AS MATERIALIZED (SELECT clock_timestamp() now)
 SELECT coalesce((SELECT d.operation='publish_rating_categories' AND d.envelope_version=4 AND whaleu_community.rating_category_envelope_shape(d.envelope)
  AND d.digest=encode(sha256(convert_to('whaleu-rating-content-approval:v4'||chr(10)||whaleu_community.content_canonical_json(d.envelope),'UTF8')),'hex')
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
CREATE FUNCTION whaleu_community.rating_category_base_binding_validate() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d whaleu_community.rating_approval_decisions;instant timestamptz;
BEGIN
 SELECT * INTO d FROM whaleu_community.rating_approval_decisions WHERE id=NEW.decision_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Category Review decision missing' USING ERRCODE='23514';END IF;
 PERFORM id FROM whaleu_identity.accounts WHERE id=d.account_id FOR SHARE;
 PERFORM decision_id FROM whaleu_community.rating_approval_heads WHERE decision_id=d.id FOR SHARE;
 instant:=clock_timestamp();
 IF NOT whaleu_community.rating_category_decision_current(d.id,true)
  OR (NEW.account_id,NEW.operation,NEW.envelope_version,NEW.digest,NEW.envelope) IS DISTINCT FROM (d.account_id,d.operation,d.envelope_version,d.digest,d.envelope)
  OR NEW.publication_transaction<>pg_current_xact_id()
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d.envelope->'categories') n WHERE n->>'id'=NEW.category_id::text AND n->>'revision'=NEW.base_revision::text)
  OR EXISTS(SELECT 1 FROM whaleu_community.rating_approval_decisions newer WHERE newer.account_id=d.account_id AND newer.operation=d.operation AND newer.envelope_version=d.envelope_version AND newer.digest=d.digest AND (newer.evaluated_at,newer.id)>(d.evaluated_at,d.id))
  OR EXISTS(SELECT 1 FROM whaleu_community.rating_category_base_bindings b WHERE b.decision_id=d.id AND b.publication_transaction<>pg_current_xact_id()) THEN
  RAISE EXCEPTION 'Exact category Review binding mismatch' USING ERRCODE='23514';END IF;
 NEW.bound_at:=instant;RETURN NEW;
END $$;
CREATE TRIGGER rating_category_base_binding_validate BEFORE INSERT ON whaleu_community.rating_category_base_bindings FOR EACH ROW EXECUTE FUNCTION whaleu_community.rating_category_base_binding_validate();
CREATE TRIGGER a1_rating_category_base_binding_epoch BEFORE INSERT OR UPDATE OR DELETE ON whaleu_community.rating_category_base_bindings FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.advance_rating_review_binding_epoch();
CREATE TRIGGER rating_category_base_binding_immutable BEFORE UPDATE OR DELETE ON whaleu_community.rating_category_base_bindings FOR EACH ROW EXECUTE FUNCTION whaleu_community.content_approval_immutable();
CREATE TRIGGER rating_category_base_binding_retain BEFORE TRUNCATE ON whaleu_community.rating_category_base_bindings FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.content_approval_immutable();
CREATE FUNCTION whaleu_community.rating_category_base_current(_category uuid,_revision uuid,_envelope jsonb) RETURNS boolean LANGUAGE sql AS $$
 SELECT coalesce((SELECT whaleu_community.rating_category_envelope_shape(_envelope)
  AND b.envelope=_envelope AND b.scope=_envelope->'scope' AND b.release_id::text=_envelope->>'releaseId' AND b.account_id::text=_envelope->>'accountId'
  AND (d.account_id,d.operation,d.envelope_version,d.digest,d.envelope)=(b.account_id,b.operation,b.envelope_version,b.digest,b.envelope)
  AND EXISTS(SELECT 1 FROM jsonb_array_elements(_envelope->'categories') n WHERE n->>'id'=_category::text AND n->>'revision'=_revision::text)
  AND isfinite(b.bound_at) AND b.bound_at>=d.evaluated_at AND b.bound_at<=clock_timestamp()
  AND whaleu_community.rating_category_decision_current(b.decision_id,false)
 FROM whaleu_community.rating_category_base_bindings b JOIN whaleu_community.rating_approval_decisions d ON d.id=b.decision_id
 WHERE b.category_id=_category AND b.base_revision=_revision),false)
$$;

-- REVIEW_FRAGMENT_END

CREATE FUNCTION whaleu_ratings.category_topology_regions(snapshot uuid,region uuid) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE s whaleu_campus.community_topology_snapshots;t jsonb;item jsonb;result jsonb;keys text[];
BEGIN
 SELECT v.* INTO s FROM whaleu_campus.community_topology_heads h JOIN whaleu_campus.community_topology_snapshots v ON (v.id,v.revision)=(h.snapshot_id,h.revision)
 WHERE h.scope_key='community' AND v.id=snapshot;
 IF NOT coalesce(s.coverage_state='complete' AND s.provenance_state='accepted' AND length(btrim(s.source_reference))>0 AND length(btrim(s.policy_reference))>0
  AND s.effective_at<=clock_timestamp() AND ((s.expiry_kind='policy_exempt' AND s.valid_until IS NULL) OR (s.expiry_kind='at' AND s.valid_until>clock_timestamp())),false) THEN RETURN NULL;END IF;
 t:=s.topology;
 IF NOT coalesce(t->'version'='1'::jsonb AND t-ARRAY['version','groups','regions','assignments']='{}'::jsonb
  AND jsonb_typeof(t->'groups')='array' AND jsonb_typeof(t->'regions')='array' AND jsonb_typeof(t->'assignments')='array',false) THEN RETURN NULL;END IF;
 IF jsonb_array_length(t->'regions')>200 OR jsonb_array_length(t->'assignments')>1000 OR jsonb_array_length(t->'groups')>200
  OR (SELECT count(*) FROM whaleu_campus.operating_regions)>200 OR (SELECT count(*) FROM whaleu_campus.campuses)>1000
  OR (SELECT count(*) FROM whaleu_campus.institutions)>1000 OR (SELECT count(*) FROM whaleu_campus.campus_region_assignments)>1000 THEN RETURN NULL;END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(t->'groups') LOOP
  IF NOT coalesce(item-ARRAY['groupId','coverage','isActive']='{}'::jsonb AND whaleu_ratings.owner_delete_id_valid(item->>'groupId')
   AND item->>'coverage' IN ('complete','missing','conflicting') AND jsonb_typeof(item->'isActive')='boolean',false) THEN RETURN NULL;END IF;
 END LOOP;
 FOR item IN SELECT value FROM jsonb_array_elements(t->'regions') LOOP
  IF NOT coalesce(item-ARRAY['regionId','institutionId','groupId','coverage','isActive']='{}'::jsonb
   AND whaleu_ratings.owner_delete_id_valid(item->>'regionId') AND whaleu_ratings.owner_delete_id_valid(item->>'institutionId') AND whaleu_ratings.owner_delete_id_valid(item->>'groupId')
   AND item->>'coverage' IN ('complete','missing','conflicting') AND jsonb_typeof(item->'isActive')='boolean'
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(t->'groups') g WHERE g->>'groupId'=item->>'groupId'),false) THEN RETURN NULL;END IF;
 END LOOP;
 FOR item IN SELECT value FROM jsonb_array_elements(t->'assignments') LOOP
  IF NOT coalesce(item-ARRAY['campusId','institutionId','regionId','coverage','isActive']='{}'::jsonb
   AND whaleu_ratings.owner_delete_id_valid(item->>'campusId') AND whaleu_ratings.owner_delete_id_valid(item->>'institutionId') AND whaleu_ratings.owner_delete_id_valid(item->>'regionId')
   AND item->>'coverage' IN ('complete','missing','conflicting') AND jsonb_typeof(item->'isActive')='boolean'
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(t->'regions') r WHERE r->>'regionId'=item->>'regionId' AND r->>'institutionId'=item->>'institutionId'),false) THEN RETURN NULL;END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(t->'groups') x GROUP BY x->>'groupId' HAVING count(*)<>1)
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(t->'regions') x GROUP BY x->>'regionId' HAVING count(*)<>1)
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(t->'assignments') x GROUP BY x->>'campusId' HAVING count(*)<>1) THEN RETURN NULL;END IF;
 -- Reconcile both directions with Campus-owned physical inventory, including
 -- inactive assignments and moved campuses. Region IDs never stand for campus IDs.
 IF EXISTS(SELECT 1 FROM whaleu_campus.campuses c
  LEFT JOIN whaleu_campus.campus_region_assignments a ON a.campus_id=c.id
  LEFT JOIN LATERAL (SELECT value v FROM jsonb_array_elements(t->'assignments') WHERE value->>'campusId'=c.id::text) j ON true
  LEFT JOIN LATERAL (SELECT value v FROM jsonb_array_elements(t->'regions') WHERE value->>'regionId'=j.v->>'regionId') r ON true
  LEFT JOIN whaleu_campus.operating_regions physical ON physical.id=a.operating_region_id
  LEFT JOIN LATERAL (SELECT value v FROM jsonb_array_elements(t->'groups') WHERE value->>'groupId'=r.v->>'groupId') g ON true
  WHERE (region IS NULL OR a.operating_region_id=region OR j.v->>'regionId'=region::text)
   AND NOT coalesce(j.v->>'coverage'='complete' AND j.v->>'institutionId'=c.institution_id::text AND (j.v->>'isActive')::boolean=c.is_active
    AND j.v->>'regionId'=a.operating_region_id::text AND r.v->>'coverage'='complete' AND r.v->>'institutionId'=c.institution_id::text
    AND (r.v->>'isActive')::boolean=physical.is_active
    AND (NOT c.is_active OR (physical.is_active AND g.v->>'coverage'='complete' AND g.v->'isActive'='true'::jsonb)),false))
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(t->'assignments') x LEFT JOIN whaleu_campus.campuses c ON c.id::text=x->>'campusId'
   LEFT JOIN whaleu_campus.campus_region_assignments a ON a.campus_id=c.id
   WHERE (region IS NULL OR x->>'regionId'=region::text) AND NOT coalesce(c.institution_id::text=x->>'institutionId' AND c.is_active=(x->>'isActive')::boolean
    AND x->>'coverage'='complete' AND a.operating_region_id::text=x->>'regionId',false))
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(t->'regions') x LEFT JOIN whaleu_campus.operating_regions r ON r.id::text=x->>'regionId'
   WHERE (region IS NULL OR x->>'regionId'=region::text) AND NOT coalesce(r.is_active=(x->>'isActive')::boolean AND x->>'coverage'='complete'
    AND EXISTS(SELECT 1 FROM whaleu_campus.institutions WHERE id::text=x->>'institutionId'),false)) THEN RETURN NULL;END IF;
 SELECT jsonb_agg(jsonb_build_object('regionId',r.id,'campusIds',
   (SELECT coalesce(jsonb_agg(c.id ORDER BY c.id),'[]'::jsonb) FROM whaleu_campus.campuses c JOIN whaleu_campus.campus_region_assignments a ON a.campus_id=c.id
    WHERE c.is_active AND a.operating_region_id=r.id)) ORDER BY r.id)
 INTO result FROM whaleu_campus.operating_regions r WHERE r.is_active AND (region IS NULL OR r.id=region);
 IF result IS NULL OR jsonb_array_length(result)>32 OR EXISTS(SELECT 1 FROM jsonb_array_elements(result) r
  WHERE jsonb_array_length(r->'campusIds')=0 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(t->'regions') v JOIN jsonb_array_elements(t->'groups') g ON g->>'groupId'=v->>'groupId'
   WHERE v->>'regionId'=r->>'regionId' AND v->>'coverage'='complete' AND v->'isActive'='true'::jsonb AND g->>'coverage'='complete' AND g->'isActive'='true'::jsonb)) THEN RETURN NULL;END IF;
 RETURN result;
END $$;
CREATE FUNCTION whaleu_ratings.category_authority_snapshot(actor uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'role',role,'regionId',operating_region_id,'validFrom',extract(epoch FROM valid_from),'expiresAt',extract(epoch FROM expires_at)) ORDER BY id),'[]'::jsonb)
 FROM whaleu_authorization.role_grants WHERE account_id=actor AND revoked_at IS NULL AND valid_from<=clock_timestamp() AND (expires_at IS NULL OR expires_at>clock_timestamp())
$$;
CREATE FUNCTION whaleu_ratings.category_envelope(p whaleu_ratings.category_command_preparations) RETURNS jsonb LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT jsonb_build_object('version',4,'purpose','publish_rating_categories','accountId',(p).account_id,'clientRequestId',(p).request_id,'releaseId',(p).release_id,
  'intent',(p).intent,'scope',jsonb_build_object('regionId',(p).intent->'regionId','topologySnapshotId',(p).topology_snapshot_id,'campusIds',to_jsonb((p).campus_ids),'scopeRevision',(p).intent->'expectedScopeRevision'),
  'categories',(p).nodes,'catalogs',(p).catalogs,'assetIds','[]'::jsonb)
$$;
CREATE FUNCTION whaleu_ratings.category_catalog_sources_complete(catalog uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
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
CREATE FUNCTION whaleu_ratings.category_ancestry_current(catalog uuid,category uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 WITH RECURSIVE path AS (
  SELECT c.* FROM whaleu_ratings.categories c WHERE c.catalog_id=catalog AND c.id=category
  UNION ALL SELECT c.* FROM whaleu_ratings.categories c JOIN path p ON c.catalog_id=p.catalog_id AND c.id=p.parent_id WHERE p.level>1)
 SELECT EXISTS(SELECT 1 FROM path WHERE level=1) AND NOT EXISTS(
  SELECT 1 FROM path p LEFT JOIN whaleu_ratings.catalog_category_lineage l ON (l.catalog_id,l.category_id)=(p.catalog_id,p.id)
   LEFT JOIN whaleu_ratings.category_base_versions b ON (b.category_id,b.revision)=(l.category_id,l.base_revision)
  WHERE NOT coalesce(p.active AND NOT p.hidden AND l.effective_revision=p.revision AND
   (l.source_kind='opaque' OR (l.source_kind='native' AND l.base_revision=p.revision AND whaleu_community.rating_category_base_current(p.id,l.base_revision,b.envelope))),false))
$$;
CREATE FUNCTION whaleu_ratings.category_catalog_compat_current(catalog uuid) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
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
CREATE FUNCTION whaleu_ratings.assert_category_context(p whaleu_ratings.category_command_preparations,afterstate boolean) RETURNS void LANGUAGE plpgsql AS $$
DECLARE region uuid:=(p.intent->>'regionId')::uuid;regions jsonb;expected jsonb;entry jsonb;n jsonb;original jsonb;prior jsonb;idx integer:=0;
 campuses uuid[];head uuid;before_id uuid;after_id uuid;parent whaleu_ratings.category_base_versions;parent_scope whaleu_ratings.category_scope_versions;
 current_authority jsonb;level integer;parent_id uuid;
BEGIN
 PERFORM id FROM whaleu_identity.sessions WHERE id=p.session_id AND account_id=p.account_id FOR SHARE NOWAIT;
 PERFORM id FROM whaleu_authorization.role_grants WHERE account_id=p.account_id ORDER BY id FOR SHARE NOWAIT;
 PERFORM snapshot_id FROM whaleu_campus.community_topology_heads WHERE scope_key='community' FOR SHARE NOWAIT;
 current_authority:=whaleu_ratings.category_authority_snapshot(p.account_id);
 IF NOT coalesce(whaleu_ratings.target_edit_session_current(p.account_id,p.session_id,clock_timestamp())
  AND current_authority=p.authority_snapshot AND jsonb_array_length(current_authority) BETWEEN 1 AND 3
  AND (SELECT count(*) FROM jsonb_array_elements(current_authority) g WHERE g->>'role'='school_admin')<=1
  AND EXISTS(SELECT 1 FROM jsonb_array_elements(current_authority) g WHERE
   (g->>'role' IN ('developer','super_admin') AND g->'regionId'='null'::jsonb) OR (region IS NOT NULL AND g->>'role'='school_admin' AND g->>'regionId'=region::text)),false)
 THEN RAISE EXCEPTION 'Category actor session or exact authority unavailable' USING ERRCODE='23514';END IF;
 regions:=whaleu_ratings.category_topology_regions(p.topology_snapshot_id,region);
 IF regions IS NULL THEN RAISE EXCEPTION 'Category exact campus scope unavailable' USING ERRCODE='23514';END IF;
 SELECT coalesce(array_agg(v::uuid ORDER BY v::uuid),'{}'::uuid[]) INTO campuses FROM jsonb_array_elements(regions) r CROSS JOIN LATERAL jsonb_array_elements_text(r->'campusIds') x(v);
 IF campuses IS DISTINCT FROM p.campus_ids THEN RAISE EXCEPTION 'Category campus scope differs' USING ERRCODE='23514';END IF;
 expected:=CASE WHEN region IS NULL THEN jsonb_build_array(jsonb_build_object('regionId',NULL,'campusIds',to_jsonb(campuses)))||regions ELSE regions END;
 IF (SELECT jsonb_agg(value-ARRAY['beforeCatalogId','afterCatalogId'] ORDER BY ord) FROM jsonb_array_elements(p.catalogs) WITH ORDINALITY x(value,ord)) IS DISTINCT FROM expected
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p.catalogs) c WHERE c->'regionId'=p.intent->'regionId' AND c->'beforeCatalogId'=p.intent->'expectedCatalogRevision')
 THEN RAISE EXCEPTION 'Category release omits or substitutes an affected scope' USING ERRCODE='23514';END IF;
 PERFORM catalog_id FROM whaleu_ratings.catalog_heads WHERE scope_key IN (SELECT coalesce(value->>'regionId','global') FROM jsonb_array_elements(p.catalogs)) ORDER BY scope_key FOR UPDATE NOWAIT;
 -- Whole release budgets, including copies to every affected scope. A 33-scope
 -- command never multiplies a per-catalog limit into a partial 3.3m-row release.
 IF (SELECT count(*) FROM (SELECT 1 FROM whaleu_ratings.categories c WHERE c.catalog_id IN
    (SELECT (v->>'beforeCatalogId')::uuid FROM jsonb_array_elements(p.catalogs) v) LIMIT 10001) counted)
    +jsonb_array_length(p.catalogs)*jsonb_array_length(p.nodes)>10000
  OR (SELECT count(*) FROM (SELECT 1 FROM whaleu_ratings.target_memberships m WHERE m.catalog_id IN
    (SELECT (v->>'beforeCatalogId')::uuid FROM jsonb_array_elements(p.catalogs) v) LIMIT 100001) counted)>100000
 THEN RAISE EXCEPTION 'Complete category release exceeds aggregate copy budget' USING ERRCODE='23514';END IF;
 FOR entry IN SELECT value FROM jsonb_array_elements(p.catalogs) LOOP
  IF NOT coalesce(entry-ARRAY['regionId','beforeCatalogId','afterCatalogId','campusIds']='{}'::jsonb
   AND whaleu_ratings.owner_delete_id_valid(entry->>'afterCatalogId')
   AND (entry->'beforeCatalogId'='null'::jsonb OR whaleu_ratings.owner_delete_id_valid(entry->>'beforeCatalogId'))
   AND entry->'beforeCatalogId' IS DISTINCT FROM entry->'afterCatalogId',false) THEN RAISE EXCEPTION 'Category release head shape invalid' USING ERRCODE='23514';END IF;
  before_id:=(entry->>'beforeCatalogId')::uuid;after_id:=(entry->>'afterCatalogId')::uuid;
  SELECT catalog_id INTO head FROM whaleu_ratings.catalog_heads WHERE scope_key=coalesce(entry->>'regionId','global');
  IF head IS DISTINCT FROM (CASE WHEN afterstate THEN after_id ELSE before_id END)
  THEN RAISE EXCEPTION 'Category release catalog CAS changed' USING ERRCODE='23514';END IF;
  IF before_id IS NULL THEN
   IF EXISTS(SELECT 1 FROM whaleu_ratings.catalog_heads h JOIN whaleu_ratings.catalog_category_lineage l ON l.catalog_id=h.catalog_id
    WHERE h.scope_key='global' AND l.source_kind='native' AND entry->'regionId'<>'null'::jsonb
     AND (NOT afterstate OR h.catalog_id NOT IN (SELECT (v->>'afterCatalogId')::uuid FROM jsonb_array_elements(p.catalogs) v)))
   THEN RAISE EXCEPTION 'Missing regional head cannot discard global native sources' USING ERRCODE='23514';END IF;
  ELSE
   IF NOT EXISTS(SELECT 1 FROM whaleu_ratings.catalogs c WHERE c.id=before_id AND c.region_id IS NOT DISTINCT FROM (entry->>'regionId')::uuid
    AND c.sealed AND c.coverage='complete' AND c.provenance='accepted' AND c.effective_at<=p.prepared_at AND (c.valid_until IS NULL OR c.valid_until>clock_timestamp()))
    OR NOT whaleu_ratings.category_catalog_sources_complete(before_id)
    OR (NOT afterstate AND NOT whaleu_ratings.category_catalog_compat_current(before_id))
    OR (SELECT count(*) FROM (SELECT 1 FROM whaleu_ratings.categories WHERE catalog_id=before_id LIMIT 10001) b)+jsonb_array_length(p.nodes)>10000
    OR (SELECT count(*) FROM (SELECT 1 FROM whaleu_ratings.target_memberships WHERE catalog_id=before_id LIMIT 100001) b)>100000
   THEN RAISE EXCEPTION 'Category predecessor unavailable or exceeds complete copy budget' USING ERRCODE='23514';END IF;
  END IF;
  IF afterstate AND NOT whaleu_ratings.category_catalog_compat_current(after_id)
  THEN RAISE EXCEPTION 'Category afterstate compatibility unavailable' USING ERRCODE='23514';END IF;
 END LOOP;
 IF p.intent->'parentId'<>'null'::jsonb THEN
  SELECT b.* INTO parent FROM whaleu_ratings.category_base_heads h JOIN whaleu_ratings.category_base_versions b ON (b.category_id,b.revision)=(h.category_id,h.revision)
   WHERE h.category_id=(p.intent->>'parentId')::uuid AND h.revision=(p.intent->>'expectedParentRevision')::uuid FOR SHARE OF h NOWAIT;
  SELECT * INTO parent_scope FROM whaleu_ratings.category_scope_versions WHERE id=parent.scope_version_id;
  IF NOT coalesce(parent.active AND parent.level<3 AND parent_scope.region_id IS NOT DISTINCT FROM region AND parent_scope.campus_ids=p.campus_ids
   AND whaleu_community.rating_category_base_current(parent.category_id,parent.revision,parent.envelope)
   AND EXISTS(SELECT 1 FROM whaleu_ratings.categories c WHERE c.catalog_id=(p.intent->>'expectedCatalogRevision')::uuid
    AND c.id=parent.category_id AND c.revision=parent.revision AND c.active AND NOT c.hidden),false)
  THEN RAISE EXCEPTION 'Category parent is not exact native current same-scope source' USING ERRCODE='23514';END IF;
  IF EXISTS(WITH RECURSIVE ancestry AS (
    SELECT v.* FROM whaleu_ratings.category_base_versions v WHERE v.category_id=parent.category_id AND v.revision=parent.revision
    UNION ALL SELECT v.* FROM ancestry a JOIN whaleu_ratings.category_base_heads h ON h.category_id=a.parent_id
     JOIN whaleu_ratings.category_base_versions v ON (v.category_id,v.revision)=(h.category_id,h.revision) WHERE a.level>1)
   SELECT 1 FROM ancestry a JOIN whaleu_ratings.category_scope_versions source ON source.id=a.scope_version_id
    WHERE NOT a.active OR source.region_id IS DISTINCT FROM region OR NOT whaleu_community.rating_category_base_current(a.category_id,a.revision,a.envelope))
  THEN RAISE EXCEPTION 'Category parent ancestry Review or source scope changed' USING ERRCODE='23514';END IF;
 END IF;
 IF jsonb_array_length(p.nodes)<>jsonb_array_length(p.intent->'nodes') OR EXISTS(SELECT 1 FROM jsonb_array_elements(p.nodes) x GROUP BY x->>'id' HAVING count(*)<>1)
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(p.nodes) x GROUP BY x->>'revision' HAVING count(*)<>1)
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(p.catalogs) x GROUP BY x->>'afterCatalogId' HAVING count(*)<>1)
 THEN RAISE EXCEPTION 'Category allocation set is not exact' USING ERRCODE='23514';END IF;
 FOR n IN SELECT value FROM jsonb_array_elements(p.nodes) LOOP
  original:=p.intent->'nodes'->idx;
  IF idx=0 THEN parent_id:=(p.intent->>'parentId')::uuid;level:=coalesce(parent.level,0)+1;
  ELSE SELECT value INTO prior FROM jsonb_array_elements(p.nodes) WITH ORDINALITY a(value,ord) WHERE value->>'key'=original->>'parentKey' AND ord<=idx;
   parent_id:=(prior->>'id')::uuid;level:=(prior->>'level')::integer+1;
  END IF;
  IF NOT coalesce(n-ARRAY['key','id','revision','parentId','level','name','description','scopeVersionId']='{}'::jsonb
   AND n->'key'=original->'key' AND n->'name'=original->'name' AND n->'description'=original->'description'
   AND whaleu_ratings.owner_delete_id_valid(n->>'id') AND whaleu_ratings.owner_delete_id_valid(n->>'revision')
   AND n->>'scopeVersionId'=p.scope_version_id::text AND n->'parentId'=coalesce(to_jsonb(parent_id),'null'::jsonb)
   AND n->'level'=to_jsonb(level) AND level BETWEEN 1 AND 3,false)
  THEN RAISE EXCEPTION 'Category allocation differs from exact original intent' USING ERRCODE='23514';END IF;
  idx:=idx+1;
 END LOOP;
END $$;

CREATE OR REPLACE FUNCTION whaleu_ratings.claim_command() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c whaleu_ratings.command_claims;op text;
BEGIN
 IF TG_TABLE_NAME='target_preparations' THEN op:='create_target';
 ELSIF TG_TABLE_NAME='target_edit_preparations' THEN op:='edit_target';
 ELSIF TG_TABLE_NAME='category_command_preparations' THEN op:='create_categories';ELSE op:=NEW.operation;END IF;
 INSERT INTO whaleu_ratings.command_claims VALUES(NEW.account_id,NEW.request_id,op,NEW.intent_hash) ON CONFLICT DO NOTHING;
 SELECT * INTO c FROM whaleu_ratings.command_claims WHERE account_id=NEW.account_id AND request_id=NEW.request_id FOR UPDATE;
 IF ROW(c.operation,c.intent_hash) IS DISTINCT FROM ROW(op,NEW.intent_hash) THEN RAISE EXCEPTION 'Command namespace conflict' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
ALTER TABLE whaleu_ratings.requests DROP CONSTRAINT requests_operation_check;
ALTER TABLE whaleu_ratings.requests ADD CONSTRAINT requests_operation_check CHECK(operation IN ('set_score','create_comment','delete_comment','create_reply','delete_reply','set_comment_like','set_reply_like','set_target_subscription','admin_delete_comment','admin_delete_reply','create_target','delete_target','edit_target','create_categories'));
DROP TRIGGER rating_request_causal ON whaleu_ratings.requests;
CREATE CONSTRAINT TRIGGER rating_request_causal AFTER INSERT OR UPDATE ON whaleu_ratings.requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.operation NOT IN ('set_comment_like','set_reply_like','set_target_subscription','admin_delete_comment','admin_delete_reply','create_target','delete_target','edit_target','create_categories')) EXECUTE FUNCTION whaleu_ratings.request_causal();
CREATE FUNCTION whaleu_ratings.category_preparation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 NEW.prepared_at:=clock_timestamp();NEW.authority_snapshot:=whaleu_ratings.category_authority_snapshot(NEW.account_id);
 IF NOT coalesce(NEW.preparation_transaction=pg_current_xact_id() AND NEW.valid_until>NEW.prepared_at AND NEW.valid_until<=NEW.prepared_at+interval '5 minutes'
  AND NEW.envelope=whaleu_ratings.category_envelope(NEW) AND whaleu_community.rating_envelope_shape(NEW.envelope,'publish_rating_categories')
  AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.requests WHERE account_id=NEW.account_id AND request_id=NEW.request_id)
  AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.category_identities WHERE id IN (SELECT (x->>'id')::uuid FROM jsonb_array_elements(NEW.nodes) x))
  AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.categories WHERE id IN (SELECT (x->>'id')::uuid FROM jsonb_array_elements(NEW.nodes) x))
  AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.catalogs WHERE id IN (SELECT (x->>'afterCatalogId')::uuid FROM jsonb_array_elements(NEW.catalogs) x)),false)
 THEN RAISE EXCEPTION 'Category preparation is not exact fresh reserved intent' USING ERRCODE='23514';END IF;
 PERFORM whaleu_ratings.assert_category_context(NEW,false);RETURN NEW;
END $$;
CREATE TRIGGER a1_category_preparation_claim BEFORE INSERT ON whaleu_ratings.category_command_preparations FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.claim_command();
CREATE TRIGGER a2_category_preparation_guard BEFORE INSERT ON whaleu_ratings.category_command_preparations FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.category_preparation_guard();
CREATE FUNCTION whaleu_ratings.category_transition_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p whaleu_ratings.category_command_preparations;q whaleu_ratings.requests;
BEGIN
 SELECT * INTO p FROM whaleu_ratings.category_command_preparations WHERE account_id=NEW.actor_account_id AND request_id=NEW.request_id FOR SHARE NOWAIT;
 SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=NEW.actor_account_id AND request_id=NEW.request_id FOR UPDATE NOWAIT;
 NEW.occurred_at:=clock_timestamp();
 IF NOT coalesce(NEW.mutation_transaction=pg_current_xact_id() AND q.operation='create_categories' AND q.intent_hash=NEW.intent_hash AND q.receipt IS NULL
  AND (NEW.release_id,NEW.context_revision,NEW.intent,NEW.intent_hash)=(p.release_id,p.context_revision,p.intent,p.intent_hash)
  AND p.prepared_at<=NEW.occurred_at AND p.valid_until>NEW.occurred_at
  AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.category_command_closures WHERE actor_account_id=NEW.actor_account_id AND request_id=NEW.request_id)
  AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.category_identities WHERE id IN (SELECT (x->>'id')::uuid FROM jsonb_array_elements(p.nodes) x))
  AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.categories WHERE id IN (SELECT (x->>'id')::uuid FROM jsonb_array_elements(p.nodes) x))
  AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.catalogs WHERE id IN (SELECT (x->>'afterCatalogId')::uuid FROM jsonb_array_elements(p.catalogs) x)),false)
 THEN RAISE EXCEPTION 'Category transition requires exact live unused preparation' USING ERRCODE='23514';END IF;
 PERFORM whaleu_ratings.assert_category_context(p,false);RETURN NEW;
END $$;
CREATE TRIGGER category_transition_guard BEFORE INSERT ON whaleu_ratings.category_command_transitions FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.category_transition_guard();
CREATE FUNCTION whaleu_ratings.category_closure_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q whaleu_ratings.requests;p whaleu_ratings.category_command_preparations;
BEGIN
 SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=NEW.actor_account_id AND request_id=NEW.request_id FOR UPDATE NOWAIT;
 SELECT * INTO p FROM whaleu_ratings.category_command_preparations WHERE account_id=NEW.actor_account_id AND request_id=NEW.request_id;
 IF NOT coalesce(q.operation='create_categories' AND q.intent_hash=NEW.intent_hash AND q.receipt IS NULL AND NEW.mutation_transaction=pg_current_xact_id()
  AND (p.account_id IS NULL OR (p.intent,p.intent_hash)=(NEW.intent,NEW.intent_hash))
  AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.category_command_transitions WHERE actor_account_id=NEW.actor_account_id AND request_id=NEW.request_id),false)
 THEN RAISE EXCEPTION 'Category closure requires exact uncompleted intent' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER category_closure_guard BEFORE INSERT ON whaleu_ratings.category_command_closures FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.category_closure_guard();

CREATE FUNCTION whaleu_ratings.category_command_publish(actor uuid,request uuid,context text,decision uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
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
  INSERT INTO whaleu_ratings.catalog_category_lineage SELECT after_id,category_id,effective_revision,source_kind,base_revision,scope_version_id,topology_snapshot_id
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

CREATE FUNCTION whaleu_ratings.category_record_opaque_catalog() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.source_reference NOT LIKE 'rating-category-create:%' AND NEW.source_reference NOT LIKE 'rating-create:%' THEN
  INSERT INTO whaleu_ratings.catalog_materializations(catalog_id,source_kind,campus_ids) VALUES(NEW.id,'opaque','{}'::uuid[]);
 END IF;RETURN NULL;
END $$;
CREATE TRIGGER category_record_opaque_catalog AFTER INSERT ON whaleu_ratings.catalogs FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.category_record_opaque_catalog();
CREATE FUNCTION whaleu_ratings.category_record_opaque_lineage() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM whaleu_ratings.catalog_materializations WHERE catalog_id=NEW.catalog_id AND source_kind='opaque') THEN
  IF EXISTS(SELECT 1 FROM whaleu_ratings.category_identities WHERE id=NEW.id)
  THEN RAISE EXCEPTION 'Native category cannot be downgraded to opaque' USING ERRCODE='23514';END IF;
  INSERT INTO whaleu_ratings.catalog_category_lineage(catalog_id,category_id,effective_revision,source_kind) VALUES(NEW.catalog_id,NEW.id,NEW.revision,'opaque');
 END IF;RETURN NULL;
END $$;
CREATE TRIGGER category_record_opaque_lineage AFTER INSERT ON whaleu_ratings.categories FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.category_record_opaque_lineage();
CREATE FUNCTION whaleu_ratings.category_copy_target_lineage() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE m whaleu_ratings.catalog_materializations;
BEGIN
 SELECT * INTO m FROM whaleu_ratings.catalog_materializations WHERE catalog_id=NEW.before_catalog_id;
 IF NOT coalesce(NEW.mutation_transaction=pg_current_xact_id() AND m.catalog_id=NEW.before_catalog_id
  AND whaleu_ratings.category_catalog_compat_current(NEW.before_catalog_id),false)
 THEN RAISE EXCEPTION 'M1 requires exact compatible predecessor lineage' USING ERRCODE='23514';END IF;
 INSERT INTO whaleu_ratings.catalog_materializations(catalog_id,source_kind,before_catalog_id,target_id,topology_snapshot_id,campus_ids)
 VALUES(NEW.after_catalog_id,'target_create',NEW.before_catalog_id,NEW.target_id,m.topology_snapshot_id,m.campus_ids);
 INSERT INTO whaleu_ratings.catalog_category_lineage SELECT NEW.after_catalog_id,category_id,effective_revision,source_kind,base_revision,scope_version_id,topology_snapshot_id
 FROM whaleu_ratings.catalog_category_lineage WHERE catalog_id=NEW.before_catalog_id;
 RETURN NULL;
END $$;
CREATE TRIGGER category_copy_target_lineage AFTER INSERT ON whaleu_ratings.target_create_transitions FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.category_copy_target_lineage();

CREATE FUNCTION whaleu_ratings.verify_category_release(actor uuid,request uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE q whaleu_ratings.requests;p whaleu_ratings.category_command_preparations;e whaleu_ratings.category_command_transitions;
 closed whaleu_ratings.category_command_closures;s whaleu_ratings.category_scope_versions;i whaleu_ratings.category_identities;
 b whaleu_ratings.category_base_versions;binding whaleu_community.rating_category_base_bindings;
 c jsonb;n jsonb;manifest whaleu_ratings.category_release_catalogs;m whaleu_ratings.catalog_materializations;
 catalog whaleu_ratings.catalogs;before_id uuid;after_id uuid;expected_ordinal bigint;nodes_receipt jsonb;catalogs_receipt jsonb;instant timestamptz:=clock_timestamp();
BEGIN
 SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=actor AND request_id=request;
 SELECT * INTO p FROM whaleu_ratings.category_command_preparations WHERE account_id=actor AND request_id=request;
 SELECT * INTO e FROM whaleu_ratings.category_command_transitions WHERE actor_account_id=actor AND request_id=request;
 SELECT * INTO closed FROM whaleu_ratings.category_command_closures WHERE actor_account_id=actor AND request_id=request;
 IF NOT coalesce(q.operation='create_categories' AND q.receipt IS NOT NULL
  AND EXISTS(SELECT 1 FROM whaleu_ratings.command_claims k WHERE k.account_id=actor AND k.request_id=request AND k.operation=q.operation AND k.intent_hash=q.intent_hash),false)
 THEN RAISE EXCEPTION 'Category receipt requires exact shared command namespace' USING ERRCODE='23514';END IF;
 IF q.receipt->>'outcome'='rejected' THEN
  IF NOT coalesce(closed.actor_account_id=actor AND closed.intent_hash=q.intent_hash AND closed.mutation_transaction=pg_current_xact_id() AND e.release_id IS NULL
   AND q.receipt=jsonb_build_object('requestId',request,'operation','create_categories','outcome','rejected','code',closed.code)
   AND (p.account_id IS NULL OR (p.intent,p.intent_hash)=(closed.intent,closed.intent_hash))
   AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.category_identities WHERE creation_release_id=p.release_id)
   AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.category_scope_versions WHERE release_id=p.release_id)
   AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.category_release_catalogs WHERE release_id=p.release_id)
   AND NOT EXISTS(SELECT 1 FROM whaleu_community.rating_category_base_bindings WHERE release_id=p.release_id),false)
  THEN RAISE EXCEPTION 'Category rejected receipt has publication artifacts or wrong intent' USING ERRCODE='23514';END IF;RETURN;
 END IF;
 IF NOT coalesce(e.release_id=p.release_id AND e.actor_account_id=actor AND e.intent_hash=q.intent_hash AND closed.actor_account_id IS NULL
  AND (e.intent,e.context_revision,e.intent_hash)=(p.intent,p.context_revision,p.intent_hash)
  AND p.envelope=whaleu_ratings.category_envelope(p) AND p.prepared_at<=e.occurred_at AND e.occurred_at<=instant AND p.valid_until>instant
  AND e.mutation_transaction=pg_current_xact_id(),false)
 THEN RAISE EXCEPTION 'Category release lacks exact fresh preparation and transition' USING ERRCODE='23514';END IF;
 PERFORM whaleu_ratings.assert_category_context(p,true);
 SELECT * INTO s FROM whaleu_ratings.category_scope_versions WHERE id=p.scope_version_id;
 IF NOT coalesce((s.region_id,s.topology_snapshot_id,s.campus_ids,s.release_id,s.publication_transaction)
  IS NOT DISTINCT FROM ((p.intent->>'regionId')::uuid,p.topology_snapshot_id,p.campus_ids,e.release_id,e.mutation_transaction)
  AND (SELECT count(*) FROM whaleu_ratings.category_identities WHERE creation_release_id=e.release_id)=jsonb_array_length(p.nodes)
  AND (SELECT count(*) FROM whaleu_ratings.category_base_versions WHERE release_id=e.release_id)=jsonb_array_length(p.nodes)
  AND (SELECT count(*) FROM whaleu_community.rating_category_base_bindings WHERE release_id=e.release_id)=jsonb_array_length(p.nodes)
  AND (SELECT count(DISTINCT decision_id) FROM whaleu_community.rating_category_base_bindings WHERE release_id=e.release_id)=1
  AND (SELECT count(*) FROM whaleu_ratings.category_release_catalogs WHERE release_id=e.release_id)=jsonb_array_length(p.catalogs)
  AND (SELECT count(*) FROM whaleu_ratings.catalog_materializations WHERE release_id=e.release_id)=jsonb_array_length(p.catalogs),false)
 THEN RAISE EXCEPTION 'Category release exact artifact cardinality differs' USING ERRCODE='23514';END IF;
 FOR n IN SELECT value FROM jsonb_array_elements(p.nodes) LOOP
  SELECT * INTO i FROM whaleu_ratings.category_identities WHERE id=(n->>'id')::uuid;
  SELECT * INTO b FROM whaleu_ratings.category_base_versions WHERE category_id=i.id AND revision=(n->>'revision')::uuid;
  SELECT * INTO binding FROM whaleu_community.rating_category_base_bindings WHERE category_id=i.id AND base_revision=b.revision;
  IF NOT coalesce(i.creator_id=actor AND i.kind='general' AND NOT i.is_system AND i.system_key IS NULL AND i.source_kind='native'
   AND i.creation_release_id=e.release_id AND i.creation_transaction=e.mutation_transaction
   AND (b.parent_id,b.level,b.name,b.description,b.active,b.is_global,b.scope_version_id,b.release_id,b.envelope,b.published_at,b.publication_transaction)
    IS NOT DISTINCT FROM ((n->>'parentId')::uuid,(n->>'level')::smallint,n->>'name',n->>'description',true,p.intent->'regionId'='null'::jsonb,p.scope_version_id,e.release_id,p.envelope,e.occurred_at,e.mutation_transaction)
   AND EXISTS(SELECT 1 FROM whaleu_ratings.category_base_heads h WHERE h.category_id=i.id AND h.revision=b.revision)
   AND (binding.release_id,binding.account_id,binding.envelope,binding.publication_transaction)=(e.release_id,actor,p.envelope,e.mutation_transaction)
   AND binding.bound_at>=e.occurred_at AND binding.bound_at<=instant
   AND EXISTS(SELECT 1 FROM whaleu_community.rating_approval_decisions d WHERE d.id=binding.decision_id AND d.evaluated_at<=e.occurred_at AND d.consume_until>instant)
   AND whaleu_community.rating_category_base_current(i.id,b.revision,b.envelope),false)
  THEN RAISE EXCEPTION 'Category identity/base/head/Review exact causal chain differs' USING ERRCODE='23514';END IF;
 END LOOP;
 FOR c IN SELECT value FROM jsonb_array_elements(p.catalogs) LOOP
  before_id:=(c->>'beforeCatalogId')::uuid;after_id:=(c->>'afterCatalogId')::uuid;
  SELECT * INTO manifest FROM whaleu_ratings.category_release_catalogs WHERE release_id=e.release_id AND scope_key=coalesce(c->>'regionId','global');
  SELECT * INTO m FROM whaleu_ratings.catalog_materializations WHERE catalog_id=after_id;
  SELECT * INTO catalog FROM whaleu_ratings.catalogs WHERE id=after_id;
  IF NOT coalesce((manifest.region_id,manifest.before_catalog_id,manifest.after_catalog_id,to_jsonb(manifest.campus_ids),manifest.publication_transaction)
   IS NOT DISTINCT FROM ((c->>'regionId')::uuid,before_id,after_id,c->'campusIds',e.mutation_transaction)
   AND (m.source_kind,m.release_id,m.before_catalog_id,m.topology_snapshot_id,to_jsonb(m.campus_ids),m.publication_transaction)
    IS NOT DISTINCT FROM ('category_release',e.release_id,before_id,p.topology_snapshot_id,c->'campusIds',e.mutation_transaction)
   AND catalog.region_id IS NOT DISTINCT FROM (c->>'regionId')::uuid AND catalog.sealed AND catalog.coverage='complete' AND catalog.provenance='accepted'
   AND catalog.effective_at=e.occurred_at AND catalog.valid_until IS NOT DISTINCT FROM (SELECT valid_until FROM whaleu_ratings.catalogs WHERE id=before_id)
   AND catalog.source_reference='rating-category-create:'||actor::text||':'||request::text AND catalog.policy_reference='rating-category-native-v1'
   AND whaleu_ratings.category_catalog_sources_complete(after_id),false)
  THEN RAISE EXCEPTION 'Category release manifest/materialization differs' USING ERRCODE='23514';END IF;
  -- Set equality in BOTH directions, preserving old row ordinals and every
  -- membership. Creation may append only the exactly prepared new category set.
  IF EXISTS((SELECT to_jsonb(x)-'catalog_id' FROM whaleu_ratings.categories x WHERE catalog_id=before_id
    EXCEPT SELECT to_jsonb(x)-'catalog_id' FROM whaleu_ratings.categories x WHERE catalog_id=after_id AND id NOT IN (SELECT (v->>'id')::uuid FROM jsonb_array_elements(p.nodes) v))
   UNION ALL (SELECT to_jsonb(x)-'catalog_id' FROM whaleu_ratings.categories x WHERE catalog_id=after_id AND id NOT IN (SELECT (v->>'id')::uuid FROM jsonb_array_elements(p.nodes) v)
    EXCEPT SELECT to_jsonb(x)-'catalog_id' FROM whaleu_ratings.categories x WHERE catalog_id=before_id))
   OR EXISTS((SELECT to_jsonb(x)-'catalog_id' FROM whaleu_ratings.target_memberships x WHERE catalog_id=before_id
    EXCEPT SELECT to_jsonb(x)-'catalog_id' FROM whaleu_ratings.target_memberships x WHERE catalog_id=after_id)
   UNION ALL (SELECT to_jsonb(x)-'catalog_id' FROM whaleu_ratings.target_memberships x WHERE catalog_id=after_id
    EXCEPT SELECT to_jsonb(x)-'catalog_id' FROM whaleu_ratings.target_memberships x WHERE catalog_id=before_id))
   OR EXISTS((SELECT to_jsonb(x)-'catalog_id' FROM whaleu_ratings.catalog_category_lineage x WHERE catalog_id=before_id
    EXCEPT SELECT to_jsonb(x)-'catalog_id' FROM whaleu_ratings.catalog_category_lineage x WHERE catalog_id=after_id AND category_id NOT IN (SELECT (v->>'id')::uuid FROM jsonb_array_elements(p.nodes) v))
   UNION ALL (SELECT to_jsonb(x)-'catalog_id' FROM whaleu_ratings.catalog_category_lineage x WHERE catalog_id=after_id AND category_id NOT IN (SELECT (v->>'id')::uuid FROM jsonb_array_elements(p.nodes) v)
    EXCEPT SELECT to_jsonb(x)-'catalog_id' FROM whaleu_ratings.catalog_category_lineage x WHERE catalog_id=before_id))
  THEN RAISE EXCEPTION 'Category release lost or invented copied effective rows or lineage' USING ERRCODE='23514';END IF;
  SELECT coalesce(max(x.ordinal),-1)+1 INTO expected_ordinal FROM whaleu_ratings.categories x WHERE catalog_id=before_id;
  FOR n IN SELECT value FROM jsonb_array_elements(p.nodes) LOOP
   IF NOT EXISTS(SELECT 1 FROM whaleu_ratings.categories x JOIN whaleu_ratings.catalog_category_lineage l ON (l.catalog_id,l.category_id)=(x.catalog_id,x.id)
    WHERE x.catalog_id=after_id AND x.id=(n->>'id')::uuid AND x.revision=(n->>'revision')::uuid AND x.ordinal=expected_ordinal
     AND l.source_kind='native' AND l.base_revision=x.revision AND l.scope_version_id=p.scope_version_id AND l.topology_snapshot_id=p.topology_snapshot_id)
   THEN RAISE EXCEPTION 'Category release new row or exact lineage absent' USING ERRCODE='23514';END IF;
   expected_ordinal:=expected_ordinal+1;
  END LOOP;
 END LOOP;
 SELECT jsonb_agg(value-ARRAY['name','description','scopeVersionId'] ORDER BY ord) INTO nodes_receipt FROM jsonb_array_elements(p.nodes) WITH ORDINALITY x(value,ord);
 SELECT jsonb_agg(jsonb_build_object('regionId',value->'regionId','catalogRevision',value->'afterCatalogId') ORDER BY ord) INTO catalogs_receipt FROM jsonb_array_elements(p.catalogs) WITH ORDINALITY x(value,ord);
 IF q.receipt IS DISTINCT FROM jsonb_build_object('requestId',request,'operation','create_categories','outcome','applied','releaseId',e.release_id,'categories',nodes_receipt,'catalogs',catalogs_receipt,
  'occurredAt',to_char(e.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
 THEN RAISE EXCEPTION 'Category receipt differs from exact publication' USING ERRCODE='23514';END IF;
END $$;

CREATE FUNCTION whaleu_ratings.verify_category_catalog(catalog uuid) RETURNS void LANGUAGE plpgsql AS $$
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

CREATE FUNCTION whaleu_ratings.category_command_causal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='requests' THEN PERFORM whaleu_ratings.verify_category_release(NEW.account_id,NEW.request_id);
 ELSE PERFORM whaleu_ratings.verify_category_release(NEW.actor_account_id,NEW.request_id);END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER category_request_causal AFTER INSERT OR UPDATE ON whaleu_ratings.requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.operation='create_categories') EXECUTE FUNCTION whaleu_ratings.category_command_causal();
CREATE CONSTRAINT TRIGGER category_transition_causal AFTER INSERT ON whaleu_ratings.category_command_transitions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.category_command_causal();
CREATE CONSTRAINT TRIGGER category_closure_causal AFTER INSERT ON whaleu_ratings.category_command_closures DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.category_command_causal();
CREATE FUNCTION whaleu_ratings.category_preparation_causal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM whaleu_ratings.command_claims WHERE account_id=NEW.account_id AND request_id=NEW.request_id AND operation='create_categories' AND intent_hash=NEW.intent_hash)
 THEN RAISE EXCEPTION 'Category preparation namespace absent' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM whaleu_ratings.requests WHERE account_id=NEW.account_id AND request_id=NEW.request_id) THEN
  PERFORM whaleu_ratings.verify_category_release(NEW.account_id,NEW.request_id);
 ELSE
  IF NEW.valid_until<=clock_timestamp() THEN RAISE EXCEPTION 'Category preparation expired at deferred proof' USING ERRCODE='23514';END IF;
  PERFORM whaleu_ratings.assert_category_context(NEW,false);
 END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER category_preparation_causal AFTER INSERT ON whaleu_ratings.category_command_preparations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.category_preparation_causal();
CREATE FUNCTION whaleu_ratings.category_source_artifact_causal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE release uuid;e whaleu_ratings.category_command_transitions;
BEGIN
 IF TG_TABLE_NAME='category_identities' THEN release:=NEW.creation_release_id;
 ELSIF TG_TABLE_NAME='category_base_heads' THEN
  SELECT release_id INTO release FROM whaleu_ratings.category_base_versions WHERE category_id=NEW.category_id AND revision=NEW.revision;
 ELSE release:=NEW.release_id;END IF;
 SELECT * INTO e FROM whaleu_ratings.category_command_transitions WHERE release_id=release;
 IF e.release_id IS NULL OR e.mutation_transaction<>pg_current_xact_id()
 THEN RAISE EXCEPTION 'Category artifact requires a fresh exact creation transition' USING ERRCODE='23514';END IF;
 PERFORM whaleu_ratings.verify_category_release(e.actor_account_id,e.request_id);RETURN NULL;
END $$;
DO $$ DECLARE tab text;BEGIN
 FOREACH tab IN ARRAY ARRAY['category_identities','category_base_versions','category_base_heads','category_scope_versions','category_release_catalogs'] LOOP
  EXECUTE format('CREATE CONSTRAINT TRIGGER category_source_artifact_causal AFTER INSERT ON whaleu_ratings.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.category_source_artifact_causal()',tab);
 END LOOP;
END $$;
ALTER TABLE whaleu_community.rating_category_base_bindings ADD FOREIGN KEY(category_id,base_revision) REFERENCES whaleu_ratings.category_base_versions(category_id,revision);
ALTER TABLE whaleu_community.rating_category_base_bindings ADD FOREIGN KEY(release_id) REFERENCES whaleu_ratings.category_command_transitions(release_id);
CREATE CONSTRAINT TRIGGER category_binding_reverse_causal AFTER INSERT ON whaleu_community.rating_category_base_bindings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.category_source_artifact_causal();
CREATE FUNCTION whaleu_ratings.category_catalog_artifact_causal() RETURNS trigger LANGUAGE plpgsql AS $$
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
END $$;
CREATE CONSTRAINT TRIGGER category_catalog_causal AFTER INSERT OR UPDATE ON whaleu_ratings.catalogs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.category_catalog_artifact_causal();
CREATE CONSTRAINT TRIGGER category_catalog_head_causal AFTER INSERT OR UPDATE ON whaleu_ratings.catalog_heads DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.category_catalog_artifact_causal();
CREATE CONSTRAINT TRIGGER category_materialization_causal AFTER INSERT ON whaleu_ratings.catalog_materializations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.category_catalog_artifact_causal();
-- Per-row reverse checks are O(1). Full set equality is checked at the catalog,
-- materialization and head boundaries, not once per copied 100,000-member row.
CREATE FUNCTION whaleu_ratings.category_effective_row_causal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE category uuid;c whaleu_ratings.categories;l whaleu_ratings.catalog_category_lineage;m whaleu_ratings.catalog_materializations;
BEGIN
 IF TG_TABLE_NAME='categories' THEN category:=NEW.id;ELSE category:=NEW.category_id;END IF;
 SELECT * INTO c FROM whaleu_ratings.categories WHERE catalog_id=NEW.catalog_id AND id=category;
 SELECT * INTO l FROM whaleu_ratings.catalog_category_lineage WHERE catalog_id=NEW.catalog_id AND category_id=category;
 SELECT * INTO m FROM whaleu_ratings.catalog_materializations WHERE catalog_id=NEW.catalog_id;
 IF NOT coalesce(c.id=category AND l.effective_revision=c.revision AND m.catalog_id=NEW.catalog_id
  AND m.publication_transaction=pg_current_xact_id() AND EXISTS(SELECT 1 FROM whaleu_ratings.catalogs WHERE id=NEW.catalog_id AND sealed),false)
 THEN RAISE EXCEPTION 'Effective category/lineage lacks fresh sealed materialization' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER category_effective_row_causal AFTER INSERT ON whaleu_ratings.categories DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.category_effective_row_causal();
CREATE CONSTRAINT TRIGGER category_lineage_row_causal AFTER INSERT ON whaleu_ratings.catalog_category_lineage DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.category_effective_row_causal();
CREATE FUNCTION whaleu_ratings.category_materialization_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.publication_transaction<>pg_current_xact_id() OR (NEW.source_kind='opaque' AND pg_trigger_depth()<2)
 THEN RAISE EXCEPTION 'Catalog materialization source must be causally minted' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER category_materialization_guard BEFORE INSERT ON whaleu_ratings.catalog_materializations FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.category_materialization_guard();
CREATE FUNCTION whaleu_ratings.category_writer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('whaleu:named-block-policy:v1',0));
 LOCK TABLE whaleu_ratings.random_pool_epoch,whaleu_ratings.navigation_epoch IN ROW EXCLUSIVE MODE;
 RETURN NULL;
END $$;
DO $$ DECLARE tab text;BEGIN
 FOREACH tab IN ARRAY ARRAY['category_command_preparations','category_command_transitions','category_command_closures','category_identities','category_scope_versions','category_base_versions','category_base_heads','category_release_catalogs','catalog_materializations','catalog_category_lineage'] LOOP
  EXECUTE format('CREATE TRIGGER a0_category_writer BEFORE INSERT OR UPDATE OR DELETE ON whaleu_ratings.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.category_writer()',tab);
  EXECUTE format('CREATE TRIGGER category_immutable BEFORE UPDATE OR DELETE ON whaleu_ratings.%I FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.immutable()',tab);
  EXECUTE format('CREATE TRIGGER category_retain BEFORE TRUNCATE ON whaleu_ratings.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.immutable()',tab);
 END LOOP;
 FOREACH tab IN ARRAY ARRAY['category_identities','category_scope_versions','category_base_versions','category_base_heads','category_release_catalogs','catalog_materializations','catalog_category_lineage'] LOOP
  EXECUTE format('CREATE TRIGGER a1_category_pool BEFORE INSERT OR UPDATE OR DELETE ON whaleu_ratings.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.advance_random_pool_epoch()',tab);
  EXECUTE format('CREATE TRIGGER a2_category_navigation BEFORE INSERT OR UPDATE OR DELETE ON whaleu_ratings.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.advance_navigation_epoch()',tab);
 END LOOP;
END $$;
CREATE TRIGGER a0_category_binding_writer BEFORE INSERT OR UPDATE OR DELETE ON whaleu_community.rating_category_base_bindings FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.category_writer();
-- Existing M1 writes enter through the same common gate before their first
-- epoch, including zero-row statements. No reader/shared-lock upgrade is added.
CREATE TRIGGER a00_category_catalog_writer BEFORE INSERT OR UPDATE OR DELETE ON whaleu_ratings.catalogs FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.category_writer();
CREATE TRIGGER a00_category_head_writer BEFORE INSERT OR UPDATE OR DELETE ON whaleu_ratings.catalog_heads FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.category_writer();
CREATE TRIGGER a00_category_effective_writer BEFORE INSERT OR UPDATE OR DELETE ON whaleu_ratings.categories FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.category_writer();
CREATE TRIGGER a00_category_membership_writer BEFORE INSERT OR UPDATE OR DELETE ON whaleu_ratings.target_memberships FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.category_writer();
CREATE INDEX category_base_release ON whaleu_ratings.category_base_versions(release_id,category_id);
CREATE INDEX category_identity_release ON whaleu_ratings.category_identities(creation_release_id,id);
CREATE INDEX category_lineage_source ON whaleu_ratings.catalog_category_lineage(category_id,base_revision,catalog_id);
CREATE INDEX category_materialization_predecessor ON whaleu_ratings.catalog_materializations(before_catalog_id,catalog_id);
-- Install v1 compatibility anti-downgrade now. A later campus-divergent protocol
-- must replace this exact guard explicitly, never silently choose one campus.
CREATE FUNCTION whaleu_ratings.category_head_preserves_native() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND EXISTS(
  SELECT to_jsonb(c)-'catalog_id' FROM whaleu_ratings.categories c JOIN whaleu_ratings.catalog_category_lineage l ON (l.catalog_id,l.category_id)=(c.catalog_id,c.id)
   WHERE c.catalog_id=OLD.catalog_id AND l.source_kind='native'
  EXCEPT SELECT to_jsonb(c)-'catalog_id' FROM whaleu_ratings.categories c WHERE c.catalog_id=NEW.catalog_id)
 THEN RAISE EXCEPTION 'Compatible head cannot discard or rewrite native category sources' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER category_head_preserves_native BEFORE INSERT OR UPDATE ON whaleu_ratings.catalog_heads FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.category_head_preserves_native();
-- Native compatibility depends on Campus-owned topology and full inventory.
-- Fence those source mutations even when a statement touches no rows. These
-- statements already require Safety exclusive; retain the common-first order.
-- TRUNCATE maintenance must obtain that outer gate before its relation locks.
DO $$ DECLARE tab text;BEGIN
 FOREACH tab IN ARRAY ARRAY['community_topology_snapshots','community_topology_heads','operating_regions','institutions','campuses','campus_region_assignments'] LOOP
  EXECUTE format('CREATE TRIGGER a00_rating_category_scope_writer BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_campus.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.category_writer()',tab);
  EXECUTE format('CREATE TRIGGER a01_rating_category_scope_pool BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_campus.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.advance_random_pool_epoch()',tab);
  EXECUTE format('CREATE TRIGGER a02_rating_category_scope_navigation BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_campus.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.advance_navigation_epoch()',tab);
 END LOOP;
END $$;
-- A compact exact deadline for public/random final proofs. NULL means proven
-- opaque legacy scope or a current explicit policy-exempt topology, never a
-- missing native source. Call alongside compat_current in the initial read.
CREATE FUNCTION whaleu_ratings.category_catalog_compat_until(catalog uuid) RETURNS timestamptz LANGUAGE plpgsql STABLE AS $$
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
-- Preserve the M2B v3 before-context predicate verbatim, then add the native
-- category/source boundary at its existing deferred verification call site.
-- No old request shape, target revision meaning or deletion path is changed.
DO $$ DECLARE definition text;BEGIN
 definition:=pg_get_functiondef('whaleu_ratings.target_edit_catalog_current(uuid,jsonb,timestamptz)'::regprocedure);
 IF position('whaleu_ratings.categories' in definition)=0 THEN RAISE EXCEPTION 'Expected M2B catalog predicate absent' USING ERRCODE='23514';END IF;
 definition:=replace(definition,'FUNCTION whaleu_ratings.target_edit_catalog_current(', 'FUNCTION whaleu_ratings.target_edit_catalog_current_v3(');
 EXECUTE definition;
END $$;
CREATE OR REPLACE FUNCTION whaleu_ratings.target_edit_catalog_current(target uuid,i jsonb,instant timestamptz) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT whaleu_ratings.target_edit_catalog_current_v3(target,i,instant)
  AND whaleu_ratings.category_catalog_compat_current((i->>'expectedCatalogRevision')::uuid)
  AND whaleu_ratings.category_ancestry_current((i->>'expectedCatalogRevision')::uuid,(i->>'categoryId')::uuid)
$$;
