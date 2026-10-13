-- Opt-in ordinary roots retain one canonical graph. No accepted topology,
-- applicability, reviewer, relationship, category crosswalk or grant is seeded.
SET LOCAL lock_timeout='5s';
SELECT pg_advisory_xact_lock(hashtextextended('whaleu:named-block-policy:v1',0));

CREATE TABLE whaleu_campus.community_distribution_generation (
 slot integer PRIMARY KEY CHECK(slot>=0), generation bigint NOT NULL CHECK(generation>0)
);
CREATE TABLE whaleu_community.related_sync_applicability_generation (
 slot integer PRIMARY KEY CHECK(slot>=0), generation bigint NOT NULL CHECK(generation>0)
);
CREATE TABLE whaleu_community.related_sync_admission_generation (
 slot integer PRIMARY KEY CHECK(slot>=0), generation bigint NOT NULL CHECK(generation>0)
);
-- Each source family has its own nonblocking writer slots. The number of
-- candidates follows the current postmaster writer bound, not optional-count
-- capacity. A transaction retains one slot; old slots survive restarts and
-- capacity reductions and remain in every full-vector observation.
CREATE FUNCTION whaleu_community.related_sync_generation_namespace(kind text) RETURNS integer LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
 RETURN CASE kind WHEN 'distribution' THEN 1464356120 WHEN 'applicability' THEN 1464356121 WHEN 'admission' THEN 1464356122 WHEN 'view' THEN 1464356123 WHEN 'actor' THEN 1464356124 ELSE NULL END;
END $$;
CREATE FUNCTION whaleu_community.related_sync_generation_relation(kind text) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
 RETURN CASE kind WHEN 'distribution' THEN 'whaleu_campus.community_distribution_generation' WHEN 'applicability' THEN 'whaleu_community.related_sync_applicability_generation' WHEN 'admission' THEN 'whaleu_community.related_sync_admission_generation' WHEN 'view' THEN 'whaleu_community.related_sync_view_generation' WHEN 'actor' THEN 'whaleu_community.related_sync_actor_generation' ELSE NULL END;
END $$;
CREATE FUNCTION whaleu_community.related_sync_generation_capacity() RETURNS integer LANGUAGE sql STABLE AS $$
 SELECT (current_setting('max_connections')::bigint+current_setting('max_prepared_transactions')::bigint+
 current_setting('max_worker_processes')::bigint+current_setting('max_wal_senders')::bigint+
 current_setting('autovacuum_worker_slots')::bigint+1)::integer
$$;
CREATE FUNCTION whaleu_community.related_sync_generation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE namespace integer:=whaleu_community.related_sync_generation_namespace(TG_ARGV[0]);
BEGIN
 IF TG_OP NOT IN('INSERT','UPDATE') OR pg_trigger_depth()<2 OR namespace IS NULL
 OR NEW.slot<0 OR NOT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid() AND granted
  AND mode='ExclusiveLock' AND classid=namespace::oid AND objsubid=2 AND objid=NEW.slot::oid)
 OR (TG_OP='INSERT' AND (NEW.generation<>1 OR NEW.slot>=whaleu_community.related_sync_generation_capacity()))
 OR (TG_OP='UPDATE' AND (NEW.slot IS DISTINCT FROM OLD.slot OR OLD.generation=9223372036854775807 OR NEW.generation IS DISTINCT FROM OLD.generation+1)) THEN
  RAISE EXCEPTION 'Related scope generation is owner-only monotone metadata' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION whaleu_community.related_sync_generation_statement_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP NOT IN('INSERT','UPDATE') OR pg_trigger_depth()<2 THEN
  RAISE EXCEPTION 'Direct related generation statements are forbidden' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END $$;
CREATE FUNCTION whaleu_community.related_sync_generation_advance(kind text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE namespace integer:=whaleu_community.related_sync_generation_namespace(kind); relation text:=whaleu_community.related_sync_generation_relation(kind);
 capacity integer:=whaleu_community.related_sync_generation_capacity(); chosen integer; first_slot integer; candidate integer; step integer; previous bigint;
BEGIN
 IF pg_trigger_depth()<1 OR namespace IS NULL OR relation IS NULL OR capacity<1 THEN RAISE EXCEPTION 'Related generation requires an exact source trigger' USING ERRCODE='23514'; END IF;
 SELECT objid::integer INTO chosen FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid() AND granted
 AND mode='ExclusiveLock' AND classid=namespace::oid AND objsubid=2 AND objid<capacity::oid ORDER BY objid LIMIT 1;
 first_slot:=mod(pg_current_xact_id()::text::numeric,capacity)::integer;
 IF chosen IS NULL THEN
  FOR step IN 0..capacity-1 LOOP
   candidate:=mod(first_slot::bigint+step,capacity)::integer;
   IF pg_try_advisory_xact_lock(namespace,candidate) THEN chosen:=candidate;EXIT;END IF;
  END LOOP;
 END IF;
 -- pg_locks can include session ownership; always retain the xact lock too.
 IF chosen IS NULL OR NOT pg_try_advisory_xact_lock(namespace,chosen) THEN
  RAISE EXCEPTION 'Reserved related generation writer slots are inconsistent' USING ERRCODE='55P03';
 END IF;
 EXECUTE format('SELECT generation FROM %s WHERE slot=$1 FOR UPDATE NOWAIT',relation) INTO previous USING chosen;
 IF previous IS NULL THEN
  EXECUTE format('INSERT INTO %s(slot,generation) VALUES($1,1)',relation) USING chosen;
 ELSE
  EXECUTE format('UPDATE %s SET generation=generation+1 WHERE slot=$1',relation) USING chosen;
 END IF;
END $$;
CREATE FUNCTION whaleu_community.related_sync_generation_fingerprint(kind text) RETURNS text LANGUAGE plpgsql VOLATILE AS $$
DECLARE relation text:=whaleu_community.related_sync_generation_relation(kind); vector jsonb;
BEGIN
 IF relation IS NULL THEN RAISE EXCEPTION 'Unknown related generation owner' USING ERRCODE='23514'; END IF;
 EXECUTE format('SELECT coalesce(jsonb_agg(jsonb_build_array(slot,generation::text) ORDER BY slot),''[]''::jsonb) FROM %s',relation) INTO vector;
 RETURN encode(sha256(convert_to('whaleu:related-source-generation:v1:'||kind||chr(10)||whaleu_community.content_canonical_json(vector),'UTF8')),'hex');
END $$;
CREATE FUNCTION whaleu_community.related_sync_advance_generation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM whaleu_community.related_sync_generation_advance(TG_ARGV[0]);
 RETURN NULL;
END $$;
DO $$ DECLARE rel text; kind text; BEGIN
 FOREACH kind IN ARRAY ARRAY['distribution','applicability','admission'] LOOP
  rel:=whaleu_community.related_sync_generation_relation(kind);
  EXECUTE format('CREATE TRIGGER related_generation_statement_guard BEFORE INSERT OR UPDATE OR DELETE ON %s FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.related_sync_generation_statement_guard()',rel);
  EXECUTE format('CREATE TRIGGER related_generation_guard BEFORE INSERT OR UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION whaleu_community.related_sync_generation_guard(%L)',rel,kind);
  EXECUTE format('CREATE TRIGGER related_generation_retain BEFORE TRUNCATE ON %s FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.content_approval_immutable()',rel);
 END LOOP;
 FOREACH rel IN ARRAY ARRAY['whaleu_campus.community_topology_snapshots','whaleu_campus.community_topology_heads','whaleu_campus.operating_regions'] LOOP
  EXECUTE format('CREATE TRIGGER a000_related_distribution_generation BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON %s FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.related_sync_advance_generation(''distribution'')',rel);
 END LOOP;
 FOREACH rel IN ARRAY ARRAY['whaleu_community.region_policy_revisions','whaleu_community.region_policy_heads','whaleu_campus.community_identity_selections','whaleu_campus.community_identity_heads','whaleu_campus.campuses','whaleu_campus.institutions','whaleu_campus.campus_region_assignments','whaleu_verification.account_heads','whaleu_verification.snapshots','whaleu_verification.assertions'] LOOP
  EXECUTE format('CREATE TRIGGER a000_related_admission_generation BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON %s FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.related_sync_advance_generation(''admission'')',rel);
 END LOOP;
END $$;

CREATE FUNCTION whaleu_community.related_sync_uuid(value jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT coalesce(jsonb_typeof(value)='string' AND whaleu_profile.moderation_uuid_valid(value#>>'{}'),false)
$$;
CREATE FUNCTION whaleu_community.related_sync_exact_keys(value jsonb,keys text[]) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
 RETURN coalesce(jsonb_typeof(value)='object' AND (SELECT array_agg(k ORDER BY k COLLATE "C") FROM jsonb_object_keys(value) k)=(SELECT array_agg(k ORDER BY k COLLATE "C") FROM unnest(keys) k),false);
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
CREATE FUNCTION whaleu_campus.community_distribution_topology_valid(value jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE item jsonb; key text;
BEGIN
 IF NOT whaleu_community.related_sync_exact_keys(value,ARRAY['version','groups','regions','assignments']) OR value->'version'<>'1'::jsonb OR jsonb_typeof(value->'groups')<>'array' OR jsonb_typeof(value->'regions')<>'array' OR jsonb_typeof(value->'assignments')<>'array' THEN RETURN false; END IF;
 FOR item IN SELECT jsonb_array_elements(value->'groups') LOOP
  IF NOT whaleu_community.related_sync_exact_keys(item,ARRAY['groupId','coverage','isActive']) OR NOT whaleu_community.related_sync_uuid(item->'groupId') OR (jsonb_typeof(item->'coverage') IS DISTINCT FROM 'string' OR item->>'coverage' NOT IN ('complete','missing','conflicting')) OR jsonb_typeof(item->'isActive')<>'boolean' THEN RETURN false; END IF;
 END LOOP;
 FOR item IN SELECT jsonb_array_elements(value->'regions') LOOP
  IF NOT whaleu_community.related_sync_exact_keys(item,ARRAY['regionId','institutionId','groupId','coverage','isActive']) OR (jsonb_typeof(item->'coverage') IS DISTINCT FROM 'string' OR item->>'coverage' NOT IN ('complete','missing','conflicting')) OR jsonb_typeof(item->'isActive')<>'boolean' THEN RETURN false; END IF;
  FOREACH key IN ARRAY ARRAY['regionId','institutionId','groupId'] LOOP IF NOT whaleu_community.related_sync_uuid(item->key) THEN RETURN false; END IF; END LOOP;
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(value->'groups') g WHERE g->>'groupId'=item->>'groupId') THEN RETURN false; END IF;
 END LOOP;
 FOR item IN SELECT jsonb_array_elements(value->'assignments') LOOP
  IF NOT whaleu_community.related_sync_exact_keys(item,ARRAY['campusId','institutionId','regionId','coverage','isActive']) OR (jsonb_typeof(item->'coverage') IS DISTINCT FROM 'string' OR item->>'coverage' NOT IN ('complete','missing','conflicting')) OR jsonb_typeof(item->'isActive')<>'boolean' THEN RETURN false; END IF;
  FOREACH key IN ARRAY ARRAY['campusId','institutionId','regionId'] LOOP IF NOT whaleu_community.related_sync_uuid(item->key) THEN RETURN false; END IF; END LOOP;
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(value->'regions') r WHERE r->>'regionId'=item->>'regionId' AND r->>'institutionId'=item->>'institutionId') THEN RETURN false; END IF;
 END LOOP;
 RETURN (SELECT count(*)=count(DISTINCT g->>'groupId') FROM jsonb_array_elements(value->'groups') g)
  AND (SELECT count(*)=count(DISTINCT r->>'regionId') FROM jsonb_array_elements(value->'regions') r)
  AND (SELECT count(*)=count(DISTINCT a->>'campusId') FROM jsonb_array_elements(value->'assignments') a);
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
CREATE FUNCTION whaleu_campus.community_distribution_group(region uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE AS $$
DECLARE snap whaleu_campus.community_topology_snapshots; head jsonb; origin jsonb; grp jsonb; members uuid[]; sources jsonb; generation text; fp text; missing jsonb;
BEGIN
 generation:=whaleu_community.related_sync_generation_fingerprint('distribution');
 SELECT to_jsonb(h) INTO head FROM whaleu_campus.community_topology_heads h WHERE scope_key='community';
 SELECT s.* INTO snap FROM whaleu_campus.community_topology_heads h JOIN whaleu_campus.community_topology_snapshots s ON s.id=h.snapshot_id AND s.revision=h.revision WHERE h.scope_key='community';
 fp:=encode(sha256(convert_to(whaleu_community.content_canonical_json(jsonb_build_array(region,generation,head,to_jsonb(snap))),'UTF8')),'hex');
 missing:=jsonb_build_object('status','unavailable','sourceGeneration',generation,'fingerprint',fp);
 IF generation IS NULL OR snap.id IS NULL OR snap.coverage_state<>'complete' OR snap.provenance_state<>'accepted' OR coalesce(length(whaleu_profile.moderation_trim(snap.source_reference)),0)=0 OR coalesce(length(whaleu_profile.moderation_trim(snap.policy_reference)),0)=0 OR NOT isfinite(snap.effective_at) OR snap.effective_at>clock_timestamp() OR NOT ((snap.expiry_kind='policy_exempt' AND snap.valid_until IS NULL) OR (snap.expiry_kind='at' AND snap.valid_until>clock_timestamp())) OR NOT whaleu_campus.community_distribution_topology_valid(snap.topology) THEN RETURN missing; END IF;
 SELECT r INTO origin FROM jsonb_array_elements(snap.topology->'regions') r WHERE r->>'regionId'=region::text;
 SELECT g INTO grp FROM jsonb_array_elements(snap.topology->'groups') g WHERE g->>'groupId'=origin->>'groupId';
 IF origin IS NULL OR origin->>'coverage' IS DISTINCT FROM 'complete' OR origin->'isActive'<>'true'::jsonb OR grp->>'coverage' IS DISTINCT FROM 'complete' OR grp->'isActive'<>'true'::jsonb THEN RETURN missing; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(snap.topology->'regions') r LEFT JOIN whaleu_campus.operating_regions live ON live.id=(r->>'regionId')::uuid WHERE r->>'groupId'=origin->>'groupId' AND (r->>'coverage' IS DISTINCT FROM 'complete' OR (r->'isActive'='true'::jsonb AND live.id IS NULL))) THEN RETURN missing; END IF;
 SELECT coalesce(array_agg(live.id ORDER BY live.id),'{}'::uuid[]),jsonb_agg(jsonb_build_array(r,to_jsonb(live),live.xmin::text,live.ctid::text) ORDER BY r->>'regionId') INTO members,sources
 FROM jsonb_array_elements(snap.topology->'regions') r JOIN whaleu_campus.operating_regions live ON live.id=(r->>'regionId')::uuid
 WHERE r->>'groupId'=origin->>'groupId' AND r->'isActive'='true'::jsonb AND live.is_active;
 IF NOT region=ANY(members) THEN RETURN missing; END IF;
 fp:=encode(sha256(convert_to(whaleu_community.content_canonical_json(jsonb_build_array(region,generation,head,to_jsonb(snap),sources)),'UTF8')),'hex');
 RETURN jsonb_build_object('status','known','topologySnapshotId',snap.id,'topologyRevision',snap.revision,'groupId',origin->>'groupId','memberRegionIds',to_jsonb(members),'sourceGeneration',generation,'fingerprint',fp,'validUntil',snap.valid_until::text);
END $$;

CREATE FUNCTION whaleu_community.related_sync_sorted_texts(items text[]) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT items=ARRAY(SELECT DISTINCT item COLLATE "C" FROM unnest(items) item ORDER BY item COLLATE "C")
$$;
CREATE TABLE whaleu_community.related_sync_policies (
 id uuid PRIMARY KEY, policy_key text NOT NULL CHECK(policy_key='ordinary-related-v1'), version integer NOT NULL CHECK(version>0),
 operating_region_id uuid NOT NULL REFERENCES whaleu_campus.operating_regions(id),
 categories text[] NOT NULL CHECK(cardinality(categories)>0 AND categories<@ARRAY['discussion','confession','companions','pets','internships','scenery','dorms','research','deep_sea']::text[]),
 author_modes text[] NOT NULL CHECK(cardinality(author_modes)>0 AND author_modes<@ARRAY['named','anonymous']::text[]),
 component_kinds text[] NOT NULL CHECK(cardinality(component_kinds)>0 AND component_kinds<@ARRAY['none','poll','formation']::text[]),
 images_allowed boolean NOT NULL, anonymous_dm_allowed boolean NOT NULL,
 review_policy_revision_id uuid NOT NULL REFERENCES whaleu_community.content_approval_policies(id),
 coverage text NOT NULL CHECK(coverage IN ('complete','missing','conflicting')), provenance text NOT NULL CHECK(provenance IN ('accepted','unknown','conflicting')),
 issuer text NOT NULL CHECK(length(whaleu_profile.moderation_trim(issuer))>0), provenance_ref text NOT NULL CHECK(length(whaleu_profile.moderation_trim(provenance_ref))>0),
 valid_from timestamptz NOT NULL CHECK(isfinite(valid_from)), valid_until timestamptz CHECK(valid_until IS NULL OR (isfinite(valid_until) AND valid_until>valid_from)),
 UNIQUE(id,operating_region_id,version),UNIQUE(operating_region_id,version),
 CHECK(array_position(categories,NULL) IS NULL AND array_position(author_modes,NULL) IS NULL AND array_position(component_kinds,NULL) IS NULL),
 CHECK(whaleu_community.related_sync_sorted_texts(categories) AND whaleu_community.related_sync_sorted_texts(author_modes) AND whaleu_community.related_sync_sorted_texts(component_kinds))
);
CREATE TABLE whaleu_community.related_sync_policy_heads (
 operating_region_id uuid PRIMARY KEY REFERENCES whaleu_campus.operating_regions(id),revision integer NOT NULL DEFAULT 0 CHECK(revision>=0),policy_id uuid,
 CHECK((revision=0 AND policy_id IS NULL) OR (revision>0 AND policy_id IS NOT NULL)),
 FOREIGN KEY(policy_id,operating_region_id,revision) REFERENCES whaleu_community.related_sync_policies(id,operating_region_id,version)
);
CREATE FUNCTION whaleu_community.related_sync_policy_head_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR (TG_OP='INSERT' AND NEW.revision<>0) OR (TG_OP='UPDATE' AND (NEW.operating_region_id<>OLD.operating_region_id OR NEW.revision<>OLD.revision+1)) THEN RAISE EXCEPTION 'Invalid related policy head transition' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER related_policy_head_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_community.related_sync_policy_heads FOR EACH ROW EXECUTE FUNCTION whaleu_community.related_sync_policy_head_guard();
CREATE TRIGGER related_policy_immutable BEFORE UPDATE OR DELETE ON whaleu_community.related_sync_policies FOR EACH ROW EXECUTE FUNCTION whaleu_community.content_approval_immutable();
CREATE TRIGGER related_policy_retain BEFORE TRUNCATE ON whaleu_community.related_sync_policies FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.content_approval_immutable();
CREATE TRIGGER related_policy_head_retain BEFORE TRUNCATE ON whaleu_community.related_sync_policy_heads FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.content_approval_immutable();
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['related_sync_policies','related_sync_policy_heads'] LOOP
  EXECUTE format('CREATE TRIGGER a000_related_applicability_generation BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_community.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.related_sync_advance_generation(''applicability'')',tab);
 END LOOP;
END $$;
-- This expands only a separately named explicit Review domain. Runtime local
-- related acceptance requires its own nonproduction config and exact policy.
ALTER TABLE whaleu_community.content_approval_policies DROP CONSTRAINT content_approval_policies_policy_key_check;
ALTER TABLE whaleu_community.content_approval_policies ADD CONSTRAINT content_approval_policies_policy_key_check CHECK(policy_key IN ('local-explicit-v1','local-related-v1'));
CREATE FUNCTION whaleu_community.related_sync_policy_current(policy uuid) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT coalesce((SELECT p.coverage='complete' AND p.provenance='accepted' AND p.valid_from<=clock_timestamp() AND (p.valid_until IS NULL OR p.valid_until>clock_timestamp())
 AND cardinality(p.categories)=(SELECT count(DISTINCT c) FROM unnest(p.categories) c) AND cardinality(p.author_modes)=(SELECT count(DISTINCT c) FROM unnest(p.author_modes) c) AND cardinality(p.component_kinds)=(SELECT count(DISTINCT c) FROM unnest(p.component_kinds) c)
 AND length(whaleu_profile.moderation_trim(r.issuer))>0 AND length(whaleu_profile.moderation_trim(r.provenance_ref))>0
 AND r.policy_key='local-related-v1' AND r.version=1 AND r.coverage='complete' AND r.provenance='accepted' AND r.valid_from<=clock_timestamp() AND (r.valid_until IS NULL OR r.valid_until>clock_timestamp())
 FROM whaleu_community.related_sync_policies p JOIN whaleu_community.related_sync_policy_heads h ON h.policy_id=p.id AND h.operating_region_id=p.operating_region_id AND h.revision=p.version JOIN whaleu_community.content_approval_policies r ON r.id=p.review_policy_revision_id WHERE p.id=policy),false)
$$;
CREATE FUNCTION whaleu_community.related_sync_enable_allowed(region uuid) RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
DECLARE g jsonb; BEGIN
 g:=whaleu_campus.community_distribution_group(region);
 RETURN coalesce(g->>'status'='known' AND jsonb_array_length(g->'memberRegionIds')>=2 AND EXISTS(SELECT 1 FROM whaleu_community.related_sync_policy_heads h WHERE h.operating_region_id=region AND whaleu_community.related_sync_policy_current(h.policy_id)),false);
END $$;
CREATE FUNCTION whaleu_community.related_sync_enable_fingerprint(region uuid) RETURNS text LANGUAGE sql VOLATILE AS $$
 SELECT encode(sha256(convert_to(whaleu_community.content_canonical_json(jsonb_build_array(region,whaleu_campus.community_distribution_group(region),
 whaleu_community.related_sync_generation_fingerprint('applicability'),
 (SELECT jsonb_build_array(to_jsonb(h),to_jsonb(p),to_jsonb(r)) FROM whaleu_community.related_sync_policy_heads h LEFT JOIN whaleu_community.related_sync_policies p ON p.id=h.policy_id LEFT JOIN whaleu_community.content_approval_policies r ON r.id=p.review_policy_revision_id WHERE h.operating_region_id=region))),'UTF8')),'hex')
$$;
CREATE FUNCTION whaleu_community.related_sync_enable_assert(region uuid,observed text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 LOCK TABLE whaleu_campus.community_distribution_generation,whaleu_community.related_sync_applicability_generation IN SHARE MODE NOWAIT;
 IF observed IS DISTINCT FROM whaleu_community.related_sync_enable_fingerprint(region) OR NOT whaleu_community.related_sync_enable_allowed(region) THEN RAISE EXCEPTION 'Related enable source changed' USING ERRCODE='23514'; END IF;
END $$;

CREATE FUNCTION whaleu_community.related_sync_scope_valid(value jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE key text; sync text:=value->>'sync'; base text[]:=ARRAY['originalSpaceId','originalRegionId','authorOriginRegionId','identityRegionId','topologySnapshotId','sync','configurationRevisionId','identityCampusId','identitySelectionId','affiliationSnapshotId','affiliationAssertionId'];
BEGIN
 IF sync='related' THEN
  IF whaleu_community.related_sync_exact_keys(value,base||ARRAY['syncPolicyId','publicationGroupId','publicationMembersDigest']) IS DISTINCT FROM true OR value->>'identityRegionId' IS DISTINCT FROM value->>'originalRegionId' OR jsonb_typeof(value->'publicationMembersDigest')<>'string' OR value->>'publicationMembersDigest' !~ '^[a-f0-9]{64}$' THEN RETURN false; END IF;
 ELSIF sync='inherited_related' THEN
  IF whaleu_community.related_sync_exact_keys(value,base||ARRAY['parentDistribution']) IS DISTINCT FROM true OR whaleu_community.related_sync_exact_keys(value->'parentDistribution',ARRAY['postId','decisionId','digest']) IS DISTINCT FROM true OR NOT whaleu_community.related_sync_uuid(value->'parentDistribution'->'postId') OR NOT whaleu_community.related_sync_uuid(value->'parentDistribution'->'decisionId') OR jsonb_typeof(value->'parentDistribution'->'digest')<>'string' OR value->'parentDistribution'->>'digest' !~ '^[a-f0-9]{64}$' THEN RETURN false; END IF;
 ELSE RETURN false; END IF;
 FOREACH key IN ARRAY base LOOP
  IF key='sync' THEN CONTINUE; END IF;
  IF (sync='related' OR key IN ('originalSpaceId','originalRegionId') OR value->key<>'null'::jsonb) AND NOT whaleu_community.related_sync_uuid(value->key) THEN RETURN false; END IF;
 END LOOP;
 RETURN sync<>'related' OR (whaleu_community.related_sync_uuid(value->'syncPolicyId') AND whaleu_community.related_sync_uuid(value->'publicationGroupId'));
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
CREATE FUNCTION whaleu_community.related_sync_envelope_valid(value jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE image jsonb; component jsonb:=value->'component'; purpose text:=value->>'purpose'; root boolean:=purpose='publish_post';
BEGIN
 IF whaleu_community.related_sync_exact_keys(value,ARRAY['version','accountId','purpose','spaceId','category','authorMode','commentsPolicy','postId','rootCommentId','targetReplyId','text','images','component','trading','scope','allowAnonymousDm']) IS DISTINCT FROM true
 OR value->'version'<>'4'::jsonb OR NOT whaleu_community.related_sync_uuid(value->'accountId') OR NOT whaleu_community.related_sync_uuid(value->'spaceId')
 OR jsonb_typeof(value->'purpose') IS DISTINCT FROM 'string' OR jsonb_typeof(value->'category') IS DISTINCT FROM 'string' OR jsonb_typeof(value->'authorMode') IS DISTINCT FROM 'string' OR jsonb_typeof(value->'commentsPolicy') IS DISTINCT FROM 'string'
 OR purpose NOT IN ('publish_post','publish_comment','publish_reply') OR value->>'category' NOT IN ('discussion','confession','companions','pets','internships','scenery','dorms','research','deep_sea')
 OR value->>'authorMode' NOT IN ('named','anonymous') OR value->>'commentsPolicy' NOT IN ('open','restricted') OR value->'trading'<>'null'::jsonb
 OR whaleu_community.related_sync_scope_valid(value->'scope') IS DISTINCT FROM true OR value->>'spaceId' IS DISTINCT FROM value->'scope'->>'originalSpaceId'
 OR jsonb_typeof(value->'images')<>'array' OR jsonb_array_length(value->'images')>(CASE WHEN root THEN 9 ELSE 3 END)
 OR jsonb_typeof(value->'text')<>'string' OR whaleu_profile.moderation_text_valid(value->>'text',CASE WHEN root THEN 2500 ELSE 500 END) IS DISTINCT FROM true THEN RETURN false; END IF;
 FOR image IN SELECT jsonb_array_elements(value->'images') LOOP
  IF NOT whaleu_community.related_sync_exact_keys(image,ARRAY['assetId','digest']) OR NOT whaleu_community.related_sync_uuid(image->'assetId') OR jsonb_typeof(image->'digest')<>'string' OR image->>'digest' !~ '^[a-f0-9]{64}$' THEN RETURN false; END IF;
 END LOOP;
 IF (SELECT count(DISTINCT i->>'assetId') FROM jsonb_array_elements(value->'images') i)<>jsonb_array_length(value->'images') THEN RETURN false; END IF;
 IF root THEN
  IF value->'postId'<>'null'::jsonb OR value->'rootCommentId'<>'null'::jsonb OR value->'targetReplyId'<>'null'::jsonb OR value->'scope'->>'sync'<>'related' OR whaleu_profile.moderation_trim(value->>'text')='' THEN RETURN false; END IF;
  IF value->'allowAnonymousDm'<>'null'::jsonb AND (value->>'authorMode'<>'named' OR jsonb_typeof(value->'allowAnonymousDm')<>'boolean') THEN RETURN false; END IF;
 ELSE
  IF NOT whaleu_community.related_sync_uuid(value->'postId') OR value->'scope'->>'sync'<>'inherited_related' OR value->>'postId' IS DISTINCT FROM value->'scope'->'parentDistribution'->>'postId' OR value->'allowAnonymousDm'<>'null'::jsonb OR component<>'{"kind":"none"}'::jsonb OR (whaleu_profile.moderation_trim(value->>'text')='' AND jsonb_array_length(value->'images')=0) THEN RETURN false; END IF;
  IF purpose='publish_comment' AND (value->'rootCommentId'<>'null'::jsonb OR value->'targetReplyId'<>'null'::jsonb) THEN RETURN false; END IF;
  IF purpose='publish_reply' AND (NOT whaleu_community.related_sync_uuid(value->'rootCommentId') OR (value->'targetReplyId'<>'null'::jsonb AND NOT whaleu_community.related_sync_uuid(value->'targetReplyId'))) THEN RETURN false; END IF;
 END IF;
 IF component->>'kind'='none' THEN RETURN whaleu_community.related_sync_exact_keys(component,ARRAY['kind']); END IF;
 IF NOT root THEN RETURN false; END IF;
 IF component->>'kind'='poll' THEN
  RETURN whaleu_community.related_sync_exact_keys(component,ARRAY['kind','question','selectionMode','options']) AND jsonb_typeof(component->'selectionMode')='string' AND component->>'selectionMode' IN ('single','multiple')
   AND jsonb_typeof(component->'question')='string' AND whaleu_profile.moderation_text_valid(component->>'question',255) AND whaleu_profile.moderation_trim(component->>'question')<>'' AND jsonb_typeof(component->'options')='array' AND jsonb_array_length(component->'options') BETWEEN 2 AND 5
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(component->'options') o WHERE jsonb_typeof(o)<>'string' OR NOT whaleu_profile.moderation_text_valid(o#>>'{}',255) OR whaleu_profile.moderation_trim(o#>>'{}')='')
   AND (SELECT count(DISTINCT whaleu_profile.moderation_trim(o#>>'{}')) FROM jsonb_array_elements(component->'options') o)=jsonb_array_length(component->'options')
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(component->'options') WITH ORDINALITY item(label,position) WHERE whaleu_profile.moderation_trim(label)='吃瓜🍉' AND (position<>jsonb_array_length(component->'options') OR position<3));
 END IF;
 IF component->>'kind'='formation' THEN
  RETURN whaleu_community.related_sync_exact_keys(component,ARRAY['kind','capacity','theme','contacts','contactSharing']) AND jsonb_typeof(component->'capacity')='number' AND component->>'capacity' ~ '^[0-9]+$' AND (component->>'capacity')::integer BETWEEN 1 AND 20
   AND jsonb_typeof(component->'theme')='string' AND whaleu_profile.moderation_text_valid(component->>'theme',12) AND component->>'theme'=whaleu_profile.moderation_trim(component->>'theme') AND whaleu_profile.moderation_trim(component->>'theme')<>'' AND jsonb_typeof(component->'contactSharing')='string' AND component->>'contactSharing'='members_v1'
   AND whaleu_community.related_sync_exact_keys(component->'contacts',ARRAY['wechat','qq','phone'])
   AND NOT EXISTS(SELECT 1 FROM jsonb_each(component->'contacts') p WHERE jsonb_typeof(p.value)<>'string')
   AND NOT EXISTS(SELECT 1 FROM (VALUES(component->'contacts'->>'wechat',100),(component->'contacts'->>'qq',50),(component->'contacts'->>'phone',20)) c(value,maximum) WHERE c.value IS DISTINCT FROM whaleu_profile.moderation_trim(c.value) OR octet_length(c.value)>c.maximum OR whaleu_profile.moderation_text_valid(c.value,c.maximum) IS DISTINCT FROM true)
   AND (component->'contacts'->>'wechat')||(component->'contacts'->>'qq')||(component->'contacts'->>'phone')<>'';
 END IF;
 RETURN false;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;

-- Exact native postIntent/publicationHash bytes, including the final explicit opt-in.
-- JSONB canonical object order is not the historical command protocol order.
CREATE FUNCTION whaleu_community.related_sync_post_intent_hash(envelope jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE component jsonb:=envelope->'component'; images jsonb; intent text; definition text;
BEGIN
 IF whaleu_community.related_sync_envelope_valid(envelope) IS DISTINCT FROM true OR envelope->>'purpose'<>'publish_post' THEN RETURN NULL; END IF;
 SELECT coalesce(jsonb_agg(image->'assetId' ORDER BY position),'[]'::jsonb) INTO images FROM jsonb_array_elements(envelope->'images') WITH ORDINALITY item(image,position);
 intent:='{"spaceId":'||(envelope->'spaceId')::text||',"category":'||(envelope->'category')::text||',"text":'||(envelope->'text')::text||',"imageAssetIds":'||whaleu_community.content_canonical_json(images)||',"authorMode":'||(envelope->'authorMode')::text||',"commentsPolicy":'||(envelope->'commentsPolicy')::text;
 IF component->>'kind'='poll' THEN
  definition:='{"kind":"poll","question":'||(component->'question')::text||',"selectionMode":'||(component->'selectionMode')::text||',"options":'||whaleu_community.content_canonical_json(component->'options')||'}';
 ELSIF component->>'kind'='formation' THEN
  definition:='{"kind":"formation","capacity":'||(component->'capacity')::text||',"theme":'||(component->'theme')::text||',"contacts":{"wechat":'||(component->'contacts'->'wechat')::text||',"qq":'||(component->'contacts'->'qq')::text||',"phone":'||(component->'contacts'->'phone')::text||'},"contactSharing":'||(component->'contactSharing')::text||'}';
 END IF;
 IF definition IS NOT NULL THEN intent:=intent||',"component":'||definition; END IF;
 IF envelope->'allowAnonymousDm'<>'null'::jsonb THEN intent:=intent||',"allowAnonymousDm":'||(envelope->'allowAnonymousDm')::text; END IF;
 intent:=intent||',"syncToRelatedCampuses":true}';
 RETURN encode(sha256(convert_to('{"operation":"publish_post","intent":'||intent||'}','UTF8')),'hex');
END $$;

CREATE FUNCTION whaleu_community.related_sync_root_admitted(actor uuid,scope jsonb) RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
DECLARE g jsonb; selection whaleu_campus.community_identity_selections; affiliation whaleu_verification.assertions; config whaleu_community.region_policy_revisions; campus whaleu_campus.campuses; topo jsonb; origin jsonb; assignment jsonb; identity_region jsonb;
BEGIN
 IF whaleu_community.related_sync_scope_valid(scope) IS DISTINCT FROM true OR scope->>'sync'<>'related' THEN RETURN false; END IF;
 g:=whaleu_campus.community_distribution_group((scope->>'originalRegionId')::uuid);
 IF g->>'status'<>'known' OR jsonb_array_length(g->'memberRegionIds')<2 OR g->>'topologySnapshotId' IS DISTINCT FROM scope->>'topologySnapshotId' OR g->>'groupId' IS DISTINCT FROM scope->>'publicationGroupId'
 OR scope->>'publicationMembersDigest' IS DISTINCT FROM encode(sha256(convert_to('whaleu-related-publication-members:v1'||chr(10)||whaleu_community.content_canonical_json(g->'memberRegionIds'),'UTF8')),'hex') THEN RETURN false; END IF;
 IF NOT EXISTS(SELECT 1 FROM whaleu_community.spaces WHERE id=(scope->>'originalSpaceId')::uuid AND kind='regional' AND is_active AND operating_region_id=(scope->>'originalRegionId')::uuid) OR NOT whaleu_community.related_sync_policy_current((scope->>'syncPolicyId')::uuid) OR NOT EXISTS(SELECT 1 FROM whaleu_community.related_sync_policies WHERE id=(scope->>'syncPolicyId')::uuid AND operating_region_id=(scope->>'originalRegionId')::uuid) THEN RETURN false; END IF;
 SELECT s.* INTO selection FROM whaleu_campus.community_identity_heads h JOIN whaleu_campus.community_identity_selections s ON s.id=h.selection_id AND s.account_id=h.account_id AND s.revision=h.revision WHERE h.account_id=actor AND s.id=(scope->>'identitySelectionId')::uuid;
 SELECT a.* INTO affiliation FROM whaleu_verification.account_heads h JOIN whaleu_verification.snapshots s ON s.id=h.snapshot_id AND s.account_id=h.account_id AND s.revision=h.revision JOIN whaleu_verification.assertions a ON a.id=s.affiliation_assertion_id AND a.account_id=s.account_id WHERE h.account_id=actor AND s.id=(scope->>'affiliationSnapshotId')::uuid AND a.id=(scope->>'affiliationAssertionId')::uuid;
 IF selection.id IS NULL OR selection.selection_state<>'selected' OR selection.campus_id::text IS DISTINCT FROM scope->>'identityCampusId' OR selection.topology_snapshot_id::text IS DISTINCT FROM scope->>'topologySnapshotId' OR selection.affiliation_assertion_id IS DISTINCT FROM affiliation.id OR selection.affiliation_snapshot_id::text IS DISTINCT FROM scope->>'affiliationSnapshotId'
 OR selection.coverage_state<>'complete' OR selection.provenance_state<>'accepted' OR coalesce(length(whaleu_profile.moderation_trim(selection.source_reference)),0)=0 OR coalesce(length(whaleu_profile.moderation_trim(selection.policy_reference)),0)=0 OR NOT isfinite(selection.effective_at) OR selection.effective_at>clock_timestamp() OR NOT ((selection.expiry_kind='policy_exempt' AND selection.valid_until IS NULL) OR (selection.expiry_kind='at' AND selection.valid_until>clock_timestamp()))
 OR affiliation.id IS NULL OR affiliation.fact_kind<>'affiliation' OR affiliation.assertion_state<>'verified' OR affiliation.coverage_state<>'complete' OR affiliation.provenance_state<>'accepted' OR affiliation.source_account_id IS DISTINCT FROM actor OR affiliation.issuer_institution_id IS NULL OR affiliation.issuer_institution_id IS DISTINCT FROM affiliation.source_issuer_institution_id OR affiliation.origin_region_id::text IS DISTINCT FROM scope->>'authorOriginRegionId'
 OR affiliation.method NOT IN ('document_review','institutional_email','institutional_sso','reconciled_import') OR coalesce(length(whaleu_profile.moderation_trim(affiliation.source_reference)),0)=0 OR coalesce(length(whaleu_profile.moderation_trim(affiliation.policy_reference)),0)=0 OR affiliation.verified_at IS NULL OR NOT isfinite(affiliation.verified_at) OR affiliation.verified_at>clock_timestamp() OR NOT ((affiliation.expiry_kind='policy_exempt' AND affiliation.expires_at IS NULL) OR (affiliation.expiry_kind='at' AND isfinite(affiliation.expires_at) AND affiliation.expires_at>clock_timestamp() AND affiliation.expires_at>affiliation.verified_at)) THEN RETURN false; END IF;
 SELECT topology INTO topo FROM whaleu_campus.community_topology_snapshots WHERE id=selection.topology_snapshot_id;
 SELECT r INTO origin FROM jsonb_array_elements(topo->'regions') r WHERE r->>'regionId'=affiliation.origin_region_id::text;
 SELECT a INTO assignment FROM jsonb_array_elements(topo->'assignments') a WHERE a->>'campusId'=selection.campus_id::text;
 SELECT r INTO identity_region FROM jsonb_array_elements(topo->'regions') r WHERE r->>'regionId'=scope->>'identityRegionId';
 SELECT * INTO campus FROM whaleu_campus.campuses WHERE id=selection.campus_id;
 IF origin IS NULL OR assignment IS NULL OR identity_region IS NULL OR origin->>'institutionId' IS DISTINCT FROM affiliation.issuer_institution_id::text OR identity_region->>'groupId' IS DISTINCT FROM origin->>'groupId' OR origin->>'coverage' IS DISTINCT FROM 'complete' OR origin->'isActive'<>'true'::jsonb OR assignment->>'coverage' IS DISTINCT FROM 'complete' OR assignment->'isActive'<>'true'::jsonb OR assignment->>'regionId' IS DISTINCT FROM scope->>'identityRegionId' OR assignment->>'institutionId' IS DISTINCT FROM affiliation.issuer_institution_id::text
 OR campus.id IS NULL OR NOT campus.is_active OR campus.institution_id IS DISTINCT FROM affiliation.issuer_institution_id OR NOT EXISTS(SELECT 1 FROM whaleu_campus.campus_region_assignments WHERE campus_id=campus.id AND operating_region_id=(scope->>'identityRegionId')::uuid) OR NOT EXISTS(SELECT 1 FROM whaleu_campus.operating_regions WHERE id=affiliation.origin_region_id AND is_active) THEN RETURN false; END IF;
 SELECT p.* INTO config FROM whaleu_community.region_policy_heads h JOIN whaleu_community.region_policy_revisions p ON p.id=h.revision_id AND p.region_id=h.region_id AND p.revision=h.revision WHERE h.region_id=(scope->>'originalRegionId')::uuid AND p.id=(scope->>'configurationRevisionId')::uuid;
 RETURN config.id IS NOT NULL AND config.related_sync_enabled AND config.coverage_state='complete' AND config.provenance_state='accepted' AND coalesce(length(whaleu_profile.moderation_trim(config.source_reference)),0)>0 AND coalesce(length(whaleu_profile.moderation_trim(config.policy_reference)),0)>0 AND isfinite(config.effective_at) AND config.effective_at<=clock_timestamp() AND ((config.expiry_kind='policy_exempt' AND config.valid_until IS NULL) OR (config.expiry_kind='at' AND config.valid_until>clock_timestamp()));
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;
END $$;
CREATE FUNCTION whaleu_community.related_sync_root_admission_fingerprint(actor uuid,scope jsonb) RETURNS text LANGUAGE sql VOLATILE AS $$
 SELECT encode(sha256(convert_to(whaleu_community.content_canonical_json(jsonb_build_array(actor,scope,
 whaleu_community.related_sync_enable_fingerprint((scope->>'originalRegionId')::uuid),
 whaleu_community.related_sync_generation_fingerprint('admission'),
 (SELECT jsonb_build_array(to_jsonb(h),to_jsonb(p)) FROM whaleu_community.region_policy_heads h LEFT JOIN whaleu_community.region_policy_revisions p ON p.id=h.revision_id WHERE h.region_id=(scope->>'originalRegionId')::uuid),
 (SELECT jsonb_build_array(to_jsonb(h),to_jsonb(s)) FROM whaleu_campus.community_identity_heads h LEFT JOIN whaleu_campus.community_identity_selections s ON s.id=h.selection_id WHERE h.account_id=actor),
 (SELECT jsonb_build_array(to_jsonb(h),to_jsonb(s),to_jsonb(a)) FROM whaleu_verification.account_heads h LEFT JOIN whaleu_verification.snapshots s ON s.id=h.snapshot_id LEFT JOIN whaleu_verification.assertions a ON a.id=s.affiliation_assertion_id WHERE h.account_id=actor))),'UTF8')),'hex')
$$;
CREATE FUNCTION whaleu_community.related_sync_root_admission_assert(actor uuid,scope jsonb,observed text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 LOCK TABLE whaleu_campus.community_distribution_generation,whaleu_community.related_sync_applicability_generation,whaleu_community.related_sync_admission_generation IN SHARE MODE NOWAIT;
 IF observed IS DISTINCT FROM whaleu_community.related_sync_root_admission_fingerprint(actor,scope) OR NOT whaleu_community.related_sync_root_admitted(actor,scope) THEN RAISE EXCEPTION 'Related publication admission changed' USING ERRCODE='23514'; END IF;
END $$;

CREATE TABLE whaleu_community.post_distribution_bindings (
 post_id uuid PRIMARY KEY REFERENCES whaleu_community.posts(id),
 original_space_id uuid NOT NULL REFERENCES whaleu_community.spaces(id), original_region_id uuid NOT NULL REFERENCES whaleu_campus.operating_regions(id),
 topology_snapshot_id uuid NOT NULL REFERENCES whaleu_campus.community_topology_snapshots(id), publication_group_id uuid NOT NULL,
 publication_members uuid[] NOT NULL CHECK(cardinality(publication_members)>=2 AND array_position(publication_members,NULL) IS NULL),
 publication_members_digest text NOT NULL CHECK(publication_members_digest ~ '^[a-f0-9]{64}$'),
 sync_policy_id uuid NOT NULL REFERENCES whaleu_community.related_sync_policies(id), scope jsonb NOT NULL,
 decision_id uuid NOT NULL UNIQUE REFERENCES whaleu_community.content_approval_decisions(id),digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),
 account_id uuid NOT NULL,client_request_id uuid NOT NULL,intent_hash text NOT NULL CHECK(intent_hash ~ '^[a-f0-9]{64}$'),
 publication_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(), admission_fingerprint text NOT NULL CHECK(admission_fingerprint ~ '^[a-f0-9]{64}$'),
 FOREIGN KEY(account_id,client_request_id) REFERENCES whaleu_community.publication_requests(account_id,client_request_id),
 CHECK(whaleu_community.related_sync_scope_valid(scope) AND scope->>'sync'='related'
 AND scope->>'originalSpaceId'=original_space_id::text AND scope->>'originalRegionId'=original_region_id::text
 AND scope->>'topologySnapshotId'=topology_snapshot_id::text AND scope->>'publicationGroupId'=publication_group_id::text
 AND scope->>'publicationMembersDigest'=publication_members_digest AND scope->>'syncPolicyId'=sync_policy_id::text),
 CHECK(publication_members_digest=encode(sha256(convert_to('whaleu-related-publication-members:v1'||chr(10)||whaleu_community.content_canonical_json(to_jsonb(publication_members)),'UTF8')),'hex'))
);
CREATE INDEX post_distribution_original ON whaleu_community.post_distribution_bindings(original_space_id,post_id);
CREATE INDEX related_posts_scope_page ON whaleu_community.posts(space_id,category,published_at DESC,id DESC) WHERE publication_envelope_version=4;
CREATE TRIGGER distribution_binding_immutable BEFORE UPDATE OR DELETE ON whaleu_community.post_distribution_bindings FOR EACH ROW EXECUTE FUNCTION whaleu_community.content_approval_immutable();
CREATE TRIGGER distribution_binding_retain BEFORE TRUNCATE ON whaleu_community.post_distribution_bindings FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.content_approval_immutable();

-- New v4 issuance retains the actor's own authority, never a root-author proxy.
-- These columns are native issuance evidence, not a second distribution row.
ALTER TABLE whaleu_community.content_approval_bindings
 ADD COLUMN related_actor_fingerprint text,
 ADD COLUMN related_actor_transaction xid8,
 ADD CONSTRAINT related_actor_proof_shape CHECK(
  (envelope_version=4 AND related_actor_fingerprint ~ '^[a-f0-9]{64}$' AND related_actor_fingerprint IS NOT NULL AND related_actor_transaction IS NOT NULL)
  OR (envelope_version<>4 AND related_actor_fingerprint IS NULL AND related_actor_transaction IS NULL));

CREATE FUNCTION whaleu_community.related_sync_binding_valid(postid uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT coalesce((SELECT p.publication_envelope_version=4 AND p.id=d.post_id AND p.account_id=d.account_id AND p.space_id=d.original_space_id AND p.publication_transaction=d.publication_transaction
 AND b.related_actor_transaction=p.publication_transaction AND b.related_actor_fingerprint IS NOT NULL
 AND b.content_kind='post' AND b.content_version=1 AND b.envelope_version=4 AND b.account_id=d.account_id AND b.decision_id=d.decision_id AND b.digest=d.digest AND b.scope=d.scope
 AND whaleu_community.related_sync_envelope_valid(b.envelope) AND b.envelope->'scope'=d.scope AND b.envelope->>'accountId'=p.account_id::text AND b.envelope->>'spaceId'=p.space_id::text AND b.envelope->>'category'=p.category
 AND policy.operating_region_id=d.original_region_id AND policy.coverage='complete' AND policy.provenance='accepted' AND policy.valid_from<=p.published_at AND (policy.valid_until IS NULL OR policy.valid_until>p.published_at)
 AND p.category=ANY(policy.categories) AND p.author_mode=ANY(policy.author_modes) AND b.envelope->'component'->>'kind'=ANY(policy.component_kinds) AND (b.envelope->'images'='[]'::jsonb OR policy.images_allowed) AND (b.envelope->'allowAnonymousDm'<>'true'::jsonb OR policy.anonymous_dm_allowed)
 AND a.policy_revision_id=policy.review_policy_revision_id AND a.envelope=b.envelope AND a.digest=b.digest
 AND r.operation='publish_post' AND r.payload_hash=d.intent_hash AND d.intent_hash=whaleu_community.related_sync_post_intent_hash(b.envelope) AND r.receipt->>'outcome'='created' AND r.receipt->>'resourceId'=p.id::text
 AND EXISTS(SELECT 1 FROM whaleu_community.report_origins o WHERE o.kind='post' AND o.target_id=p.id AND o.owner_account_id=p.account_id AND o.source_request_id=d.client_request_id)
 FROM whaleu_community.post_distribution_bindings d JOIN whaleu_community.posts p ON p.id=d.post_id
 JOIN whaleu_community.content_approval_bindings b ON b.content_kind='post' AND b.content_id=p.id
 JOIN whaleu_community.content_approval_decisions a ON a.id=b.decision_id
 JOIN whaleu_community.related_sync_policies policy ON policy.id=d.sync_policy_id
 JOIN whaleu_community.publication_requests r ON r.account_id=d.account_id AND r.client_request_id=d.client_request_id WHERE d.post_id=postid),false)
$$;
CREATE FUNCTION whaleu_community.related_sync_review_current(decision uuid,consume boolean DEFAULT false) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT coalesce((SELECT d.envelope_version=4 AND d.result='allow' AND d.coverage='complete' AND d.provenance='accepted' AND p.policy_key='local-related-v1' AND p.version=1 AND p.coverage='complete' AND p.provenance='accepted'
 AND length(whaleu_profile.moderation_trim(p.issuer))>0 AND length(whaleu_profile.moderation_trim(p.provenance_ref))>0 AND length(whaleu_profile.moderation_trim(d.issuer))>0 AND length(whaleu_profile.moderation_trim(d.provenance_ref))>0
 AND length(whaleu_profile.moderation_trim(e.issuer))>0 AND length(whaleu_profile.moderation_trim(e.provenance_ref))>0
 AND e.state='allow' AND e.coverage='complete' AND e.provenance='accepted' AND isfinite(p.valid_from) AND isfinite(d.evaluated_at) AND isfinite(e.occurred_at) AND isfinite(d.consume_until) AND (d.visibility_until IS NULL OR isfinite(d.visibility_until)) AND (p.valid_until IS NULL OR isfinite(p.valid_until)) AND p.valid_from<=d.evaluated_at AND d.evaluated_at<=clock_timestamp() AND e.occurred_at>=d.evaluated_at AND e.occurred_at<=clock_timestamp()
 AND (p.valid_until IS NULL OR p.valid_until>clock_timestamp()) AND (d.visibility_until IS NULL OR d.visibility_until>clock_timestamp()) AND (NOT consume OR d.consume_until>clock_timestamp())
 FROM whaleu_community.content_approval_decisions d JOIN whaleu_community.content_approval_policies p ON p.id=d.policy_revision_id JOIN whaleu_community.content_approval_heads h ON h.decision_id=d.id JOIN whaleu_community.content_approval_events e ON e.id=h.event_id AND e.decision_id=d.id WHERE d.id=decision),false)
$$;
CREATE FUNCTION whaleu_community.related_sync_envelope_admitted(value jsonb) RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
DECLARE policy whaleu_community.related_sync_policies; binding whaleu_community.post_distribution_bindings;
BEGIN
 IF whaleu_community.related_sync_envelope_valid(value) IS DISTINCT FROM true THEN RETURN false; END IF;
 IF value->>'purpose'='publish_post' THEN
  IF whaleu_community.related_sync_root_admitted((value->>'accountId')::uuid,value->'scope') IS DISTINCT FROM true THEN RETURN false; END IF;
  SELECT * INTO policy FROM whaleu_community.related_sync_policies WHERE id=(value->'scope'->>'syncPolicyId')::uuid;
  RETURN value->>'category'=ANY(policy.categories) AND value->>'authorMode'=ANY(policy.author_modes) AND value->'component'->>'kind'=ANY(policy.component_kinds)
   AND (jsonb_array_length(value->'images')=0 OR policy.images_allowed) AND (value->'allowAnonymousDm'<>'true'::jsonb OR policy.anonymous_dm_allowed);
 END IF;
 SELECT * INTO binding FROM whaleu_community.post_distribution_bindings WHERE post_id=(value->>'postId')::uuid;
 RETURN binding.post_id IS NOT NULL AND whaleu_community.related_sync_binding_valid(binding.post_id)
  AND whaleu_community.related_sync_review_current(binding.decision_id,false)
  AND value->'scope'->'parentDistribution'=jsonb_build_object('postId',binding.post_id,'decisionId',binding.decision_id,'digest',binding.digest)
  AND value->'scope'->>'originalSpaceId'=binding.original_space_id::text AND value->'scope'->>'originalRegionId'=binding.original_region_id::text;
END $$;
CREATE FUNCTION whaleu_community.related_sync_binding_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b whaleu_community.content_approval_bindings; g jsonb; policy whaleu_community.related_sync_policies;
BEGIN
 IF NEW.admission_fingerprint IS NOT NULL OR NEW.publication_transaction IS DISTINCT FROM pg_current_xact_id() THEN RAISE EXCEPTION 'Distribution binding requires owner issuance' USING ERRCODE='23514'; END IF;
 NEW.admission_fingerprint:=whaleu_community.related_sync_root_admission_fingerprint(NEW.account_id,NEW.scope);
 SELECT * INTO b FROM whaleu_community.content_approval_bindings WHERE content_kind='post' AND content_id=NEW.post_id;
 SELECT * INTO policy FROM whaleu_community.related_sync_policies WHERE id=NEW.sync_policy_id;
 g:=whaleu_campus.community_distribution_group(NEW.original_region_id);
 IF b.decision_id IS DISTINCT FROM NEW.decision_id OR b.digest IS DISTINCT FROM NEW.digest OR b.scope IS DISTINCT FROM NEW.scope OR b.account_id IS DISTINCT FROM NEW.account_id OR b.envelope_version IS DISTINCT FROM 4
 OR whaleu_community.related_sync_envelope_admitted(b.envelope) IS DISTINCT FROM true OR whaleu_community.related_sync_review_current(b.decision_id,true) IS DISTINCT FROM true
 OR NOT EXISTS(SELECT 1 FROM whaleu_community.content_approval_decisions WHERE id=b.decision_id AND policy_revision_id=policy.review_policy_revision_id)
 OR NEW.intent_hash IS DISTINCT FROM whaleu_community.related_sync_post_intent_hash(b.envelope)
 OR g->'memberRegionIds' IS DISTINCT FROM to_jsonb(NEW.publication_members)
 OR NOT EXISTS(SELECT 1 FROM whaleu_community.posts WHERE id=NEW.post_id AND publication_transaction=pg_current_xact_id() AND account_id=NEW.account_id AND space_id=NEW.original_space_id AND publication_envelope_version=4)
 OR NOT EXISTS(SELECT 1 FROM whaleu_community.publication_requests WHERE account_id=NEW.account_id AND client_request_id=NEW.client_request_id AND operation='publish_post' AND payload_hash=NEW.intent_hash AND receipt IS NULL)
 THEN RAISE EXCEPTION 'Distribution binding has no exact native reviewed root' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER distribution_binding_guard BEFORE INSERT ON whaleu_community.post_distribution_bindings FOR EACH ROW EXECUTE FUNCTION whaleu_community.related_sync_binding_guard();
CREATE FUNCTION whaleu_community.related_sync_assert_root(postid uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE b whaleu_community.post_distribution_bindings;
BEGIN
 SELECT * INTO b FROM whaleu_community.post_distribution_bindings WHERE post_id=postid;
 IF b.post_id IS NULL OR b.publication_transaction IS DISTINCT FROM pg_current_xact_id() OR whaleu_community.related_sync_binding_valid(postid) IS DISTINCT FROM true OR whaleu_community.related_sync_review_current(b.decision_id,true) IS DISTINCT FROM true THEN RAISE EXCEPTION 'Related root lacks atomic native publication' USING ERRCODE='23514'; END IF;
 PERFORM whaleu_community.related_sync_root_admission_assert(b.account_id,b.scope,b.admission_fingerprint);
 PERFORM whaleu_community.related_sync_assert_actor('post',postid);
END $$;
CREATE FUNCTION whaleu_community.related_sync_root_complete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='posts' THEN
  IF NEW.publication_envelope_version=4 THEN PERFORM whaleu_community.related_sync_assert_root(NEW.id); END IF;
 ELSIF TG_TABLE_NAME='post_distribution_bindings' THEN PERFORM whaleu_community.related_sync_assert_root(NEW.post_id); END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER related_root_complete AFTER INSERT ON whaleu_community.posts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community.related_sync_root_complete();
CREATE CONSTRAINT TRIGGER related_binding_complete AFTER INSERT ON whaleu_community.post_distribution_bindings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community.related_sync_root_complete();
CREATE FUNCTION whaleu_community.related_sync_child_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE child_kind text; node uuid; postid uuid; b whaleu_community.content_approval_bindings; parent whaleu_community.post_distribution_bindings; version integer;
BEGIN
 IF TG_TABLE_NAME='content_approval_bindings' THEN
  IF NEW.content_kind='post' THEN RETURN NULL; END IF;
  child_kind:=NEW.content_kind;node:=NEW.content_id;postid:=(NEW.envelope->>'postId')::uuid;
 ELSE child_kind:=CASE TG_TABLE_NAME WHEN 'root_comments' THEN 'comment' ELSE 'reply' END;node:=NEW.id;postid:=NEW.post_id; END IF;
 SELECT publication_envelope_version INTO version FROM whaleu_community.posts WHERE id=postid;
 SELECT * INTO b FROM whaleu_community.content_approval_bindings WHERE content_kind=child_kind AND content_id=node;
 IF version<>4 AND coalesce(b.envelope_version,1)<>4 THEN RETURN NULL; END IF;
 SELECT * INTO parent FROM whaleu_community.post_distribution_bindings WHERE post_id=postid;
 IF version IS DISTINCT FROM 4 OR b.envelope_version IS DISTINCT FROM 4 OR parent.post_id IS NULL OR whaleu_community.related_sync_envelope_admitted(b.envelope) IS DISTINCT FROM true OR whaleu_community.related_sync_review_current(b.decision_id,true) IS DISTINCT FROM true
 OR whaleu_community.related_content_definition(child_kind,node) IS DISTINCT FROM b.envelope
 OR NOT EXISTS(SELECT 1 FROM whaleu_community.report_origins o JOIN whaleu_community.publication_requests r ON r.account_id=o.owner_account_id AND r.client_request_id=o.source_request_id WHERE o.kind=child_kind AND o.target_id=node AND o.owner_account_id=b.account_id AND r.operation=b.operation AND (r.payload_hash=whaleu_community.related_sync_child_intent_hash(b.envelope,b.envelope->>'authorMode') OR (b.envelope->>'authorMode'='anonymous' AND EXISTS(SELECT 1 FROM whaleu_community.posts original WHERE original.id=postid AND original.author_mode='anonymous' AND original.account_id=b.account_id) AND r.payload_hash=whaleu_community.related_sync_child_intent_hash(b.envelope,'named'))) AND r.receipt->>'outcome'='created' AND r.receipt->>'resourceId'=node::text)
 THEN RAISE EXCEPTION 'Related child requires its own exact inherited native approval' USING ERRCODE='23514'; END IF;
 PERFORM whaleu_community.related_sync_assert_actor(child_kind,node);
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER related_comment_complete AFTER INSERT ON whaleu_community.root_comments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community.related_sync_child_complete();
CREATE CONSTRAINT TRIGGER related_reply_complete AFTER INSERT ON whaleu_community.replies DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community.related_sync_child_complete();
CREATE CONSTRAINT TRIGGER related_child_binding_complete AFTER INSERT ON whaleu_community.content_approval_bindings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community.related_sync_child_complete();

DO $$ DECLARE definition text; BEGIN
 SELECT pg_get_constraintdef(oid) INTO definition FROM pg_constraint WHERE conrelid='whaleu_community.posts'::regclass AND conname='post_anonymous_dm_definition';
 IF definition IS NULL THEN RAISE EXCEPTION 'Missing historical post definition constraint'; END IF;
 ALTER TABLE whaleu_community.posts DROP CONSTRAINT post_anonymous_dm_definition;
 EXECUTE 'ALTER TABLE whaleu_community.posts ADD CONSTRAINT post_anonymous_dm_definition CHECK ('||substr(definition,7)||' OR (publication_envelope_version=4 AND feedback IS NULL AND category IN (''discussion'',''confession'',''companions'',''pets'',''internships'',''scenery'',''dorms'',''research'',''deep_sea'') AND (author_mode=''named'' OR allow_anonymous_dm IS NULL)))';
 SELECT pg_get_constraintdef(oid) INTO definition FROM pg_constraint WHERE conrelid='whaleu_community.content_approval_decisions'::regclass AND conname='content_approval_envelope_identity';
 IF definition IS NULL THEN RAISE EXCEPTION 'Missing historical review identity constraint'; END IF;
 ALTER TABLE whaleu_community.content_approval_decisions DROP CONSTRAINT content_approval_envelope_identity;
 EXECUTE 'ALTER TABLE whaleu_community.content_approval_decisions ADD CONSTRAINT content_approval_envelope_identity CHECK ('||substr(definition,7)||' OR (envelope_version=4 AND envelope->>''accountId''=account_id::text AND envelope->>''purpose''=operation AND whaleu_community.related_sync_envelope_valid(envelope)))';
END $$;
ALTER TABLE whaleu_community.content_approval_decisions DROP CONSTRAINT content_approval_envelope_version;
ALTER TABLE whaleu_community.content_approval_decisions ADD CONSTRAINT content_approval_envelope_version CHECK(envelope_version IN (1,2,3,4));
ALTER TABLE whaleu_community.content_approval_bindings DROP CONSTRAINT content_binding_envelope_version;
ALTER TABLE whaleu_community.content_approval_bindings ADD CONSTRAINT content_binding_envelope_version CHECK(envelope_version IN (1,2,3,4) AND envelope->>'version'=envelope_version::text AND (envelope_version IN (1,4) OR (content_kind='post' AND operation='publish_post')));
CREATE FUNCTION whaleu_community.related_review_policy_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE key text; BEGIN
 SELECT policy_key INTO key FROM whaleu_community.content_approval_policies WHERE id=NEW.policy_revision_id;
 IF (NEW.envelope_version=4 AND key IS DISTINCT FROM 'local-related-v1') OR (NEW.envelope_version<>4 AND key IS DISTINCT FROM 'local-explicit-v1') THEN RAISE EXCEPTION 'Review envelope policy domain mismatch' USING ERRCODE='23514'; END IF;
 IF NEW.envelope_version=4 AND NEW.envelope->>'purpose'='publish_post' AND NOT EXISTS(SELECT 1 FROM whaleu_community.related_sync_policies p WHERE p.id=(NEW.envelope->'scope'->>'syncPolicyId')::uuid AND p.review_policy_revision_id=NEW.policy_revision_id) THEN RAISE EXCEPTION 'Root Review requires exact applicability reviewer' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER related_review_policy_guard BEFORE INSERT ON whaleu_community.content_approval_decisions FOR EACH ROW EXECUTE FUNCTION whaleu_community.related_review_policy_guard();

CREATE OR REPLACE FUNCTION whaleu_community.content_binding_dm_definition() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE post whaleu_community.posts;
BEGIN
 IF NEW.envelope_version=4 THEN
  IF whaleu_community.related_sync_envelope_valid(NEW.envelope) IS DISTINCT FROM true THEN RAISE EXCEPTION 'Invalid v4 content definition' USING ERRCODE='23514'; END IF;
  IF NEW.content_kind='post' THEN
   IF NOT EXISTS(SELECT 1 FROM whaleu_community.posts p WHERE p.id=NEW.content_id AND p.publication_envelope_version=4 AND to_jsonb(p.allow_anonymous_dm)=nullif(NEW.envelope->'allowAnonymousDm','null'::jsonb)) AND NOT EXISTS(SELECT 1 FROM whaleu_community.posts p WHERE p.id=NEW.content_id AND p.publication_envelope_version=4 AND p.allow_anonymous_dm IS NULL AND NEW.envelope->'allowAnonymousDm'='null'::jsonb) THEN RAISE EXCEPTION 'Related root DM definition mismatch' USING ERRCODE='23514'; END IF;
  ELSIF NOT EXISTS(SELECT 1 FROM whaleu_community.posts p WHERE p.id=(NEW.envelope->>'postId')::uuid AND p.publication_envelope_version=4) THEN RAISE EXCEPTION 'Inherited child requires related root' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 IF NEW.content_kind<>'post' AND EXISTS(SELECT 1 FROM whaleu_community.posts p WHERE p.id=(NEW.envelope->>'postId')::uuid AND p.publication_envelope_version=4) THEN RAISE EXCEPTION 'Related child cannot downgrade to v1' USING ERRCODE='23514'; END IF;
  IF NEW.content_kind='post' THEN
    SELECT * INTO post FROM whaleu_community.posts WHERE id=NEW.content_id FOR SHARE;
    IF NOT FOUND OR post.publication_envelope_version IS DISTINCT FROM NEW.envelope_version OR
      (NEW.envelope_version=1 AND (post.allow_anonymous_dm IS NOT NULL OR NEW.envelope ? 'allowAnonymousDm')) OR
      (NEW.envelope_version=2 AND (post.author_mode<>'named' OR
       jsonb_typeof(NEW.envelope->'allowAnonymousDm') IS DISTINCT FROM 'boolean' OR
       to_jsonb(post.allow_anonymous_dm) IS DISTINCT FROM NEW.envelope->'allowAnonymousDm')) THEN
      RAISE EXCEPTION 'Anonymous DM reviewed definition mismatch' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.envelope_version<>1 OR NEW.envelope ? 'allowAnonymousDm' THEN
    RAISE EXCEPTION 'Anonymous DM consent requires a named post' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION whaleu_community.related_content_definition(target_kind text,target uuid) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE scope jsonb; n record;p whaleu_community.posts;poll whaleu_community.polls;formation whaleu_community.formations;creator whaleu_community.formation_members;listing whaleu_community.trading_listings;
 images jsonb;component jsonb:='{"kind":"none"}'::jsonb;trading jsonb:='null'::jsonb;options jsonb;result jsonb;version integer;valid boolean;BEGIN
 SELECT b.scope INTO scope FROM whaleu_community.content_approval_bindings b WHERE b.content_kind=target_kind AND b.content_id=target;
 SELECT * INTO n FROM whaleu_community.profile_moderation_nodes(target_kind,target) WHERE kind=target_kind AND id=target;
 IF n.id IS NULL THEN RETURN NULL;END IF;
 SELECT * INTO p FROM whaleu_community.posts WHERE id=n.post_id;
 IF p.publication_envelope_version<>4 THEN RETURN whaleu_community.profile_moderation_definition(target_kind,target,scope); END IF;
 IF p.id IS NULL OR p.publication_state<>'published' OR whaleu_community.related_sync_scope_valid(scope) IS DISTINCT FROM true
 OR EXISTS(SELECT 1 FROM (VALUES(n.id::text),(n.account_id::text),(p.id::text),(p.space_id::text),(n.root_id::text),(n.payload->>'target_reply_id')) ids(value) WHERE value IS NOT NULL AND NOT whaleu_profile.moderation_uuid_valid(value))
 OR whaleu_profile.moderation_text_valid(n.payload->>'text',CASE WHEN target_kind='post' THEN 2500 ELSE 500 END) IS DISTINCT FROM true THEN RETURN NULL;END IF;
 EXECUTE format('SELECT coalesce(jsonb_agg(jsonb_build_object(''assetId'',asset_id,''digest'',digest) ORDER BY position),''[]''::jsonb),coalesce(bool_and(position=expected),true) FROM (SELECT *,row_number() OVER(ORDER BY position)-1 expected FROM whaleu_community.%I WHERE %I=$1) ordered',target_kind||'_images',target_kind||'_id') INTO images,valid USING target;
 IF NOT valid OR EXISTS(SELECT 1 FROM jsonb_array_elements(images) image WHERE NOT whaleu_profile.moderation_uuid_valid(image->>'assetId')) OR jsonb_array_length(images)>(CASE WHEN target_kind='post' THEN 9 ELSE 3 END)
 OR (whaleu_profile.moderation_trim(n.payload->>'text')='' AND (target_kind='post' OR jsonb_array_length(images)=0)) THEN RETURN NULL;END IF;
 IF target_kind='post' THEN
  SELECT * INTO poll FROM whaleu_community.polls WHERE post_id=target;
  SELECT * INTO formation FROM whaleu_community.formations WHERE post_id=target;
  SELECT * INTO listing FROM whaleu_community.trading_listings WHERE post_id=target;
  IF (poll.id IS NOT NULL)::integer+(formation.id IS NOT NULL)::integer+(listing.post_id IS NOT NULL)::integer>1 THEN RETURN NULL;END IF;
  IF poll.id IS NOT NULL THEN
   SELECT coalesce(jsonb_agg(label ORDER BY position),'[]'::jsonb),coalesce(bool_and(position=expected),true) INTO options,valid FROM (SELECT label,position,row_number() OVER(ORDER BY position)-1 expected FROM whaleu_community.poll_options WHERE poll_id=poll.id) ordered;
   IF poll.deadline IS NOT NULL OR NOT valid OR whaleu_profile.moderation_text_valid(poll.question,255) IS DISTINCT FROM true OR whaleu_profile.moderation_trim(poll.question)=''
   OR jsonb_array_length(options) NOT BETWEEN 2 AND 5
   OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(options) value WHERE whaleu_profile.moderation_text_valid(value,255) IS DISTINCT FROM true OR whaleu_profile.moderation_trim(value)='')
   OR (SELECT count(DISTINCT whaleu_profile.moderation_trim(value)) FROM jsonb_array_elements_text(options) value)<>jsonb_array_length(options)
   OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(options) WITH ORDINALITY item(value,ordinal) WHERE whaleu_profile.moderation_trim(value)='吃瓜🍉' AND (ordinal<>jsonb_array_length(options) OR ordinal<3)) THEN RETURN NULL;END IF;
   component:=jsonb_build_object('kind','poll','question',poll.question,'selectionMode',poll.selection_mode,'options',options);
  END IF;
  IF formation.id IS NOT NULL THEN
   SELECT * INTO creator FROM whaleu_community.formation_members WHERE formation_id=formation.id AND is_creator;
   IF formation.reconciliation<>'current' OR creator.id IS NULL OR creator.account_id<>p.account_id OR creator.contact_sharing<>'members_v1'
    OR (SELECT count(*) FROM whaleu_community.formation_members WHERE formation_id=formation.id AND is_creator)<>1
    OR whaleu_profile.moderation_text_valid(formation.theme,12) IS DISTINCT FROM true OR formation.theme IS DISTINCT FROM whaleu_profile.moderation_trim(formation.theme) OR formation.theme=''
    OR EXISTS(SELECT 1 FROM (VALUES(creator.wechat,100),(creator.qq,50),(creator.phone,20)) c(value,maximum) WHERE c.value IS DISTINCT FROM whaleu_profile.moderation_trim(c.value) OR octet_length(c.value)>c.maximum OR whaleu_profile.moderation_text_valid(c.value,c.maximum) IS DISTINCT FROM true)
    OR creator.wechat||creator.qq||creator.phone='' THEN RETURN NULL;END IF;
   component:=jsonb_build_object('kind','formation','capacity',formation.capacity,'theme',formation.theme,'contacts',jsonb_build_object('wechat',creator.wechat,'qq',creator.qq,'phone',creator.phone),'contactSharing',creator.contact_sharing);
  END IF;
  IF listing.post_id IS NOT NULL THEN
   IF listing.legacy_raw_price IS NOT NULL OR listing.legacy_raw_subtype IS NOT NULL
   OR listing.subtype NOT IN('qiugou','shuma','shujia','yifu','meizhuang','yundong','riyong','shipin','kaquan','xiangbao','zixingche','diandongche','xianshiqi')
   OR listing.price IS NULL OR length(listing.price::text)>100 OR (listing.subtype='qiugou' AND listing.urgency<>'normal')
   OR EXISTS(SELECT 1 FROM (VALUES(listing.wechat,50),(listing.qq,50),(listing.phone,50),(listing.location,200)) c(value,maximum) WHERE octet_length(value)>maximum OR whaleu_profile.moderation_text_valid(value,maximum) IS DISTINCT FROM true)
   OR whaleu_profile.moderation_trim(listing.location)='' OR whaleu_profile.moderation_trim(listing.wechat)||whaleu_profile.moderation_trim(listing.qq)||whaleu_profile.moderation_trim(listing.phone)='' THEN RETURN NULL;END IF;
   trading:=jsonb_build_object('subtype',listing.subtype,'price',trim_scale(listing.price)::text,'urgency',listing.urgency,'location',listing.location,'contacts',jsonb_build_object('wechat',listing.wechat,'qq',listing.qq,'phone',listing.phone));
  END IF;
 END IF;
 version:=4;
 IF p.feedback IS NOT NULL OR (target_kind='post' AND scope->>'sync'<>'related') OR (target_kind<>'post' AND (scope->>'sync'<>'inherited_related' OR scope->'parentDistribution'->>'postId'<>p.id::text)) THEN RETURN NULL; END IF;
 result:=jsonb_build_object('version',version,'accountId',n.account_id,'purpose',CASE target_kind WHEN 'post' THEN 'publish_post' WHEN 'comment' THEN 'publish_comment' ELSE 'publish_reply' END,
  'spaceId',p.space_id,'category',p.category,'authorMode',n.author_mode,'commentsPolicy',p.comments_policy,
  'postId',CASE WHEN target_kind='post' THEN NULL ELSE p.id END,'rootCommentId',CASE WHEN target_kind='reply' THEN n.root_id ELSE NULL END,'targetReplyId',CASE WHEN target_kind='reply' THEN n.payload->'target_reply_id' ELSE 'null'::jsonb END,
  'text',n.payload->>'text','images',images,'component',component,'trading',trading,'scope',scope);
 result:=result||jsonb_build_object('allowAnonymousDm',CASE WHEN target_kind='post' THEN p.allow_anonymous_dm ELSE NULL END);
 IF whaleu_community.related_sync_envelope_valid(result) IS DISTINCT FROM true THEN RETURN NULL; END IF;
 RETURN result;END$$;

CREATE TABLE whaleu_community.related_sync_view_generation (
 slot integer PRIMARY KEY CHECK(slot>=0),generation bigint NOT NULL CHECK(generation>0)
);
CREATE TRIGGER related_generation_statement_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_community.related_sync_view_generation FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.related_sync_generation_statement_guard();
CREATE TRIGGER related_generation_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_community.related_sync_view_generation FOR EACH ROW EXECUTE FUNCTION whaleu_community.related_sync_generation_guard('view');
CREATE TRIGGER related_generation_retain BEFORE TRUNCATE ON whaleu_community.related_sync_view_generation FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.content_approval_immutable();
CREATE FUNCTION whaleu_community.related_sync_advance_view_generation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM whaleu_community.related_sync_generation_advance('view');
 RETURN NULL;
END $$;
CREATE TRIGGER a000_related_view_generation BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_community.spaces FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.related_sync_advance_view_generation();
CREATE FUNCTION whaleu_community.related_sync_view_assert(observed text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 LOCK TABLE whaleu_community.related_sync_view_generation IN SHARE MODE NOWAIT;
 IF observed IS DISTINCT FROM whaleu_community.related_sync_generation_fingerprint('view') THEN RAISE EXCEPTION 'Distribution space catalog changed' USING ERRCODE='23514'; END IF;
END $$;
CREATE FUNCTION whaleu_community.related_sync_observation() RETURNS text LANGUAGE sql VOLATILE AS $$
 SELECT encode(sha256(convert_to(whaleu_community.content_canonical_json(jsonb_build_array(
 whaleu_community.related_sync_generation_fingerprint('distribution'),
 whaleu_community.related_sync_generation_fingerprint('applicability'),
 whaleu_community.related_sync_generation_fingerprint('admission'),
 whaleu_community.related_sync_generation_fingerprint('view'))),'UTF8')),'hex')
$$;
CREATE FUNCTION whaleu_community.related_sync_observation_assert(observed text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 LOCK TABLE whaleu_campus.community_distribution_generation,whaleu_community.related_sync_applicability_generation,whaleu_community.related_sync_admission_generation,whaleu_community.related_sync_view_generation IN SHARE MODE NOWAIT;
 IF observed IS DISTINCT FROM whaleu_community.related_sync_observation() THEN RAISE EXCEPTION 'Original related publication observation changed' USING ERRCODE='23514'; END IF;
END $$;

CREATE FUNCTION whaleu_community.related_distribution_view_facts(postid uuid,viewspace uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE AS $$
DECLARE p whaleu_community.posts; source whaleu_community.spaces; destination whaleu_community.spaces; binding whaleu_community.post_distribution_bindings; grp jsonb; category_source jsonb; structure jsonb; fp text; allowed boolean:=false; status text:='denied'; generation text; view_generation text;
BEGIN
 SELECT * INTO p FROM whaleu_community.posts WHERE id=postid;
 SELECT * INTO source FROM whaleu_community.spaces WHERE id=p.space_id;
 SELECT * INTO destination FROM whaleu_community.spaces WHERE id=viewspace;
 SELECT * INTO binding FROM whaleu_community.post_distribution_bindings WHERE post_id=postid;
 SELECT jsonb_build_array(to_jsonb(h),to_jsonb(l)) INTO category_source FROM whaleu_community.post_category_heads h LEFT JOIN whaleu_community.post_category_live l ON l.post_id=h.post_id WHERE h.post_id=postid;
 view_generation:=whaleu_community.related_sync_generation_fingerprint('view');
 IF source.id=destination.id THEN
  allowed:=source.is_active AND (source.operating_region_id IS NULL OR EXISTS(SELECT 1 FROM whaleu_campus.operating_regions WHERE id=source.operating_region_id AND is_active));
  status:=CASE WHEN allowed THEN 'allowed' ELSE 'denied' END;
 ELSE
  grp:=whaleu_campus.community_distribution_group(destination.operating_region_id);
  generation:=grp->>'sourceGeneration';
  allowed:=coalesce(source.kind='regional' AND destination.kind='regional' AND source.is_active AND destination.is_active
   AND grp->>'status'='known' AND grp->'memberRegionIds' @> jsonb_build_array(source.operating_region_id)
   AND whaleu_community.related_sync_binding_valid(postid) AND NOT EXISTS(SELECT 1 FROM whaleu_community.post_category_heads WHERE post_id=postid),false);
  status:=CASE
   WHEN allowed THEN 'allowed'
   WHEN source.id IS NULL OR destination.id IS NULL OR NOT source.is_active OR NOT destination.is_active OR source.kind<>'regional' OR destination.kind<>'regional' THEN 'denied'
   WHEN grp->>'status' IS DISTINCT FROM 'known' THEN 'unavailable'
   WHEN NOT (grp->'memberRegionIds' @> jsonb_build_array(source.operating_region_id)) THEN 'denied'
   WHEN p.publication_envelope_version=4 OR binding.post_id IS NOT NULL THEN 'unavailable'
   ELSE 'denied' END;
 END IF;
 -- Mutable tombstones, row xmin/ctid, counters and pin state are intentionally
 -- excluded. The removal owner independently proves its exact allowed delta.
 structure:=jsonb_build_array(postid,viewspace,to_jsonb(p)-ARRAY['visibility','deleted_at','local_deletion_transaction','owner_hidden'],to_jsonb(source),to_jsonb(destination),to_jsonb(binding),category_source,grp,view_generation);
 fp:=encode(sha256(convert_to(whaleu_community.content_canonical_json(structure),'UTF8')),'hex');
 RETURN jsonb_build_object('postId',postid,'viewSpaceId',viewspace,'allowed',coalesce(allowed,false),'status',status,'originalSpaceId',p.space_id,'originalRegionId',source.operating_region_id,'viewRegionId',destination.operating_region_id,'topologySnapshotId',grp->'topologySnapshotId','topologyRevision',grp->'topologyRevision','sourceGeneration',generation,'validUntil',grp->'validUntil','fingerprint',fp);
END $$;
CREATE FUNCTION whaleu_community.related_distribution_view_allowed(postid uuid,viewspace uuid) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT coalesce((whaleu_community.related_distribution_view_facts(postid,viewspace)->>'allowed')::boolean,false)
$$;

CREATE FUNCTION whaleu_community.related_sync_recheck_transaction() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE root uuid; child record; BEGIN
 FOR root IN SELECT post_id FROM whaleu_community.post_distribution_bindings WHERE publication_transaction=pg_current_xact_id() LOOP
  PERFORM whaleu_community.related_sync_assert_root(root);
 END LOOP;
 FOR child IN SELECT content_kind,content_id FROM whaleu_community.content_approval_bindings WHERE envelope_version=4 AND related_actor_transaction=pg_current_xact_id() LOOP
  PERFORM whaleu_community.related_sync_assert_actor(child.content_kind,child.content_id);
 END LOOP;
 RETURN NULL;
END $$;
DO $$ DECLARE rel text; BEGIN
 FOREACH rel IN ARRAY ARRAY['whaleu_campus.community_distribution_generation','whaleu_community.related_sync_applicability_generation','whaleu_community.related_sync_admission_generation','whaleu_community.related_sync_view_generation'] LOOP
  EXECUTE format('CREATE CONSTRAINT TRIGGER related_sync_recheck AFTER INSERT OR UPDATE ON %s DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community.related_sync_recheck_transaction()',rel);
 END LOOP;
END $$;
-- New Community epoch sources enter both exact removal inventories. Campus's
-- existing epoch triggers stay unchanged, including zero-row/TRUNCATE coverage.
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['related_sync_policies','related_sync_policy_heads','post_distribution_bindings'] LOOP
  EXECUTE format('CREATE TRIGGER a_discovery_count_epoch BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_community.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.advance_discovery_count_epoch()',tab);
  EXECUTE format('CREATE TRIGGER a00_admin_post_removal_source_statement BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_community.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.admin_post_removal_source_statement_guard()',tab);
  EXECUTE format('CREATE TRIGGER a00_admin_discussion_removal_source_statement BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_community.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.admin_discussion_removal_source_statement_guard()',tab);
 END LOOP;
END $$;
REVOKE ALL ON whaleu_campus.community_distribution_generation,whaleu_community.related_sync_applicability_generation,whaleu_community.related_sync_admission_generation,whaleu_community.related_sync_view_generation,whaleu_community.related_sync_policies,whaleu_community.related_sync_policy_heads,whaleu_community.post_distribution_bindings FROM PUBLIC;

-- Immutable native provenance participates in retained binding/count proof.
-- Existing removal statement guards already cover these legacy relations.
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['report_origins','publication_requests'] LOOP
  EXECUTE format('CREATE TRIGGER a_discovery_count_epoch BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_community.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.advance_discovery_count_epoch()',tab);
 END LOOP;
END $$;

CREATE OR REPLACE FUNCTION whaleu_community.related_sync_binding_valid(postid uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT coalesce((SELECT p.publication_envelope_version=4 AND p.id=d.post_id AND p.account_id=d.account_id AND p.space_id=d.original_space_id AND p.publication_transaction=d.publication_transaction
 AND b.related_actor_transaction=p.publication_transaction AND b.related_actor_fingerprint IS NOT NULL
 AND b.content_kind='post' AND b.content_version=1 AND b.envelope_version=4 AND b.account_id=d.account_id AND b.decision_id=d.decision_id AND b.digest=d.digest AND b.scope=d.scope
 AND whaleu_community.related_content_definition('post',p.id)=b.envelope AND whaleu_community.related_sync_envelope_valid(b.envelope) AND b.envelope->'scope'=d.scope AND b.envelope->>'accountId'=p.account_id::text AND b.envelope->>'spaceId'=p.space_id::text AND b.envelope->>'category'=p.category
 AND policy.operating_region_id=d.original_region_id AND policy.coverage='complete' AND policy.provenance='accepted' AND policy.valid_from<=p.published_at AND (policy.valid_until IS NULL OR policy.valid_until>p.published_at)
 AND p.category=ANY(policy.categories) AND p.author_mode=ANY(policy.author_modes) AND b.envelope->'component'->>'kind'=ANY(policy.component_kinds) AND (b.envelope->'images'='[]'::jsonb OR policy.images_allowed) AND (b.envelope->'allowAnonymousDm'<>'true'::jsonb OR policy.anonymous_dm_allowed)
 AND a.policy_revision_id=policy.review_policy_revision_id AND a.envelope=b.envelope AND a.digest=b.digest
 AND r.operation='publish_post' AND r.payload_hash=d.intent_hash AND d.intent_hash=whaleu_community.related_sync_post_intent_hash(b.envelope) AND r.receipt->>'outcome'='created' AND r.receipt->>'resourceId'=p.id::text
 AND EXISTS(SELECT 1 FROM whaleu_community.report_origins o WHERE o.kind='post' AND o.target_id=p.id AND o.owner_account_id=p.account_id AND o.source_request_id=d.client_request_id)
 FROM whaleu_community.post_distribution_bindings d JOIN whaleu_community.posts p ON p.id=d.post_id
 JOIN whaleu_community.content_approval_bindings b ON b.content_kind='post' AND b.content_id=p.id
 JOIN whaleu_community.content_approval_decisions a ON a.id=b.decision_id
 JOIN whaleu_community.related_sync_policies policy ON policy.id=d.sync_policy_id
 JOIN whaleu_community.publication_requests r ON r.account_id=d.account_id AND r.client_request_id=d.client_request_id WHERE d.post_id=postid),false)
$$;



CREATE TABLE whaleu_community.related_sync_actor_generation (slot integer PRIMARY KEY CHECK(slot>=0),generation bigint NOT NULL CHECK(generation>0));
CREATE TRIGGER related_generation_statement_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_community.related_sync_actor_generation FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.related_sync_generation_statement_guard();
CREATE TRIGGER related_generation_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_community.related_sync_actor_generation FOR EACH ROW EXECUTE FUNCTION whaleu_community.related_sync_generation_guard('actor');
CREATE TRIGGER related_generation_retain BEFORE TRUNCATE ON whaleu_community.related_sync_actor_generation FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.content_approval_immutable();
CREATE CONSTRAINT TRIGGER related_sync_recheck AFTER INSERT OR UPDATE ON whaleu_community.related_sync_actor_generation DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community.related_sync_recheck_transaction();
REVOKE ALL ON whaleu_community.related_sync_actor_generation FROM PUBLIC;

CREATE FUNCTION whaleu_community.related_sync_comment_control(actor uuid,region uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM whaleu_authorization.role_grants g WHERE g.account_id=actor AND g.revoked_at IS NULL
 AND isfinite(g.valid_from) AND g.valid_from<=clock_timestamp() AND (g.expires_at IS NULL OR (isfinite(g.expires_at) AND g.expires_at>clock_timestamp()))
 AND ((g.role IN('developer','super_admin') AND g.operating_region_id IS NULL) OR (g.role='school_admin' AND g.operating_region_id=region)))
$$;
CREATE FUNCTION whaleu_community.related_sync_child_scope_current(actor uuid,scope jsonb,mode text,root_mode text) RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
DECLARE a whaleu_verification.assertions; v whaleu_verification.snapshots; selection whaleu_campus.community_identity_selections;
 topo whaleu_campus.community_topology_snapshots; cfg whaleu_community.region_policy_revisions;
 verified boolean:=false; origin jsonb; identity_region jsonb; target_region jsonb; assignment jsonb; field text; instant timestamptz:=clock_timestamp();
BEGIN
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
  IF a.method NOT IN('document_review','institutional_email','institutional_sso','reconciled_import') THEN RETURN false; END IF;
  IF a.assertion_state='verified' THEN
   IF a.verified_at IS NULL OR NOT isfinite(a.verified_at) OR a.verified_at>instant
    OR NOT ((a.expiry_kind='policy_exempt' AND a.expires_at IS NULL) OR (a.expiry_kind='at' AND isfinite(a.expires_at) AND a.expires_at>a.verified_at)) THEN RETURN false; END IF;
   verified:=a.expires_at IS NULL OR a.expires_at>instant;
   IF verified AND (a.issuer_institution_id IS NULL OR a.origin_region_id IS NULL) THEN RETURN false; END IF;
  ELSIF a.assertion_state NOT IN('unverified','revoked','expired') THEN RETURN false; END IF;
 END IF;
 IF NOT verified THEN
  IF mode<>'named' OR root_mode<>'named' THEN RETURN false; END IF;
  FOREACH field IN ARRAY ARRAY['authorOriginRegionId','identityRegionId','topologySnapshotId','identityCampusId','identitySelectionId','affiliationSnapshotId','affiliationAssertionId'] LOOP
   IF scope->field IS DISTINCT FROM 'null'::jsonb THEN RETURN false; END IF;
  END LOOP;
  SELECT p.* INTO cfg FROM whaleu_community.region_policy_heads h JOIN whaleu_community.region_policy_revisions p ON (p.id,p.region_id,p.revision)=(h.revision_id,h.region_id,h.revision) WHERE h.region_id=(scope->>'originalRegionId')::uuid;
  RETURN coalesce(cfg.id::text=scope->>'configurationRevisionId' AND cfg.unverified_comment_enabled AND cfg.coverage_state='complete' AND cfg.provenance_state='accepted'
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
 RETURN EXISTS(SELECT 1 FROM whaleu_campus.campuses c JOIN whaleu_campus.institutions i ON i.id=c.institution_id JOIN whaleu_campus.campus_region_assignments assignment ON assignment.campus_id=c.id
  WHERE c.id=selection.campus_id AND c.is_active AND c.institution_id=a.issuer_institution_id AND assignment.operating_region_id=(scope->>'identityRegionId')::uuid);
END $$;

CREATE FUNCTION whaleu_community.related_sync_ancestor_facts(value jsonb) RETURNS jsonb LANGUAGE sql STABLE AS $$
 WITH targets(kind,id) AS (
  SELECT 'post', (value->>'postId')::uuid WHERE value->>'purpose'<>'publish_post'
  UNION SELECT 'comment',(value->>'rootCommentId')::uuid WHERE value->>'purpose'='publish_reply'
  UNION SELECT 'reply',(value->>'targetReplyId')::uuid WHERE value->>'purpose'='publish_reply' AND value->'targetReplyId'<>'null'::jsonb
 )
 SELECT coalesce(jsonb_agg(jsonb_build_array(t.kind,t.id,
  CASE t.kind WHEN 'post' THEN (SELECT jsonb_build_array(to_jsonb(p),p.xmin::text,p.ctid::text) FROM whaleu_community.posts p WHERE p.id=t.id)
  WHEN 'comment' THEN (SELECT jsonb_build_array(to_jsonb(p),p.xmin::text,p.ctid::text) FROM whaleu_community.root_comments p WHERE p.id=t.id)
  ELSE (SELECT jsonb_build_array(to_jsonb(p),p.xmin::text,p.ctid::text) FROM whaleu_community.replies p WHERE p.id=t.id) END,
  (SELECT jsonb_build_array(to_jsonb(b),to_jsonb(d),to_jsonb(h),h.xmin::text,h.ctid::text,to_jsonb(e),to_jsonb(p)) FROM whaleu_community.content_approval_bindings b JOIN whaleu_community.content_approval_decisions d ON d.id=b.decision_id JOIN whaleu_community.content_approval_heads h ON h.decision_id=d.id JOIN whaleu_community.content_approval_events e ON e.id=h.event_id JOIN whaleu_community.content_approval_policies p ON p.id=d.policy_revision_id WHERE b.content_kind=t.kind AND b.content_id=t.id),
  (SELECT jsonb_agg(jsonb_build_array(to_jsonb(b),b.xmin::text,b.ctid::text,to_jsonb(a),to_jsonb(i),i.xmin::text,i.ctid::text,to_jsonb(h),h.xmin::text,h.ctid::text,to_jsonb(e)) ORDER BY b.id) FROM whaleu_media.bindings b JOIN whaleu_media.assets a ON a.id=b.asset_id JOIN whaleu_media.upload_intents i ON i.id=a.intent_id LEFT JOIN whaleu_media.asset_safety_heads h ON h.asset_id=a.id LEFT JOIN whaleu_media.asset_safety_events e ON e.id=h.event_id WHERE b.owner_kind='community' AND b.resource_kind=t.kind AND b.resource_id=t.id),
  (SELECT jsonb_build_array(to_jsonb(o),to_jsonb(q)) FROM whaleu_community.report_origins o JOIN whaleu_community.publication_requests q ON (q.account_id,q.client_request_id)=(o.owner_account_id,o.source_request_id) WHERE o.kind=t.kind AND o.target_id=t.id)
 ) ORDER BY t.kind,t.id),'[]'::jsonb) FROM targets t
$$;
CREATE FUNCTION whaleu_community.related_sync_ancestors_current(value jsonb) RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
DECLARE actor uuid:=(value->>'accountId')::uuid; p whaleu_community.posts; n record; b whaleu_community.content_approval_bindings; expected integer;
BEGIN
 SELECT * INTO p FROM whaleu_community.posts WHERE id=(value->>'postId')::uuid;
 IF p.id IS NULL OR p.publication_envelope_version<>4 OR p.space_id::text IS DISTINCT FROM value->>'spaceId'
 OR p.category IS DISTINCT FROM value->>'category' OR p.comments_policy IS DISTINCT FROM value->>'commentsPolicy'
 OR whaleu_community.related_sync_binding_valid(p.id) IS DISTINCT FROM true
 OR EXISTS(SELECT 1 FROM whaleu_community.post_owner_visibility WHERE post_id=p.id AND owner_hidden)
 OR EXISTS(SELECT 1 FROM whaleu_community.post_category_heads WHERE post_id=p.id) THEN RETURN false; END IF;
 IF p.comments_policy='restricted' AND actor<>p.account_id AND NOT whaleu_community.related_sync_comment_control(actor,(value->'scope'->>'originalRegionId')::uuid) THEN RETURN false; END IF;
 IF p.author_mode='anonymous' AND actor=p.account_id AND value->>'authorMode'<>'anonymous' THEN RETURN false; END IF;
 expected:=CASE WHEN value->>'purpose'='publish_comment' THEN 1 WHEN value->'targetReplyId'='null'::jsonb THEN 2 ELSE 3 END;
 FOR n IN
  SELECT 'post' kind,id,account_id,author_mode,visibility,deleted_at,NULL::uuid root_id FROM whaleu_community.posts WHERE id=p.id
  UNION ALL SELECT 'comment',id,account_id,author_mode,visibility,deleted_at,id FROM whaleu_community.root_comments WHERE id=(value->>'rootCommentId')::uuid AND post_id=p.id
  UNION ALL SELECT 'reply',id,account_id,author_mode,visibility,deleted_at,root_comment_id FROM whaleu_community.replies WHERE id=(value->>'targetReplyId')::uuid AND post_id=p.id AND root_comment_id=(value->>'rootCommentId')::uuid
 LOOP
  expected:=expected-1;
  SELECT * INTO b FROM whaleu_community.content_approval_bindings WHERE content_kind=n.kind AND content_id=n.id;
  IF n.visibility<>'approved' OR n.deleted_at IS NOT NULL OR b.envelope_version IS DISTINCT FROM 4 OR whaleu_community.related_sync_review_current(b.decision_id) IS DISTINCT FROM true
   OR b.envelope IS DISTINCT FROM whaleu_community.related_content_definition(n.kind,n.id)
   OR whaleu_community.profile_moderation_media_current(n.kind,n.id,b.envelope->'images') IS DISTINCT FROM true THEN RETURN false; END IF;
  IF n.author_mode='named' AND n.account_id<>actor THEN
   IF NOT EXISTS(SELECT 1 FROM whaleu_safety.account_heads h WHERE h.account_id=n.account_id AND h.block_coverage='complete' AND h.provenance='native_account_creation' AND (h.valid_until IS NULL OR h.valid_until>clock_timestamp()))
   OR EXISTS(SELECT 1 FROM whaleu_safety.blocks WHERE active AND ((blocker_id=actor AND blocked_id=n.account_id) OR (blocker_id=n.account_id AND blocked_id=actor))) THEN RETURN false; END IF;
  END IF;
 END LOOP;
 RETURN expected=0;
END $$;
CREATE INDEX related_actor_inflight ON whaleu_community.content_approval_bindings(related_actor_transaction) WHERE envelope_version=4;
CREATE INDEX related_distribution_inflight ON whaleu_community.post_distribution_bindings(publication_transaction);

CREATE FUNCTION whaleu_community.related_sync_actor_current(value jsonb) RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
DECLARE actor uuid:=(value->>'accountId')::uuid; parent_mode text;
BEGIN
 IF whaleu_community.related_sync_envelope_valid(value) IS DISTINCT FROM true OR whaleu_profile.moderation_actor_current(actor,clock_timestamp()) IS DISTINCT FROM true THEN RETURN false; END IF;
 IF value->>'purpose'='publish_post' THEN
  RETURN whaleu_community.related_sync_root_admitted(actor,value->'scope')
   AND (value->>'commentsPolicy'='open' OR whaleu_community.related_sync_comment_control(actor,(value->'scope'->>'originalRegionId')::uuid));
 END IF;
 SELECT author_mode INTO parent_mode FROM whaleu_community.posts WHERE id=(value->>'postId')::uuid;
 RETURN whaleu_community.related_sync_child_scope_current(actor,value->'scope',value->>'authorMode',parent_mode)
  AND whaleu_community.related_sync_ancestors_current(value);
END $$;
CREATE FUNCTION whaleu_community.related_sync_actor_fingerprint(value jsonb) RETURNS text LANGUAGE sql VOLATILE AS $$
 SELECT encode(sha256(convert_to(whaleu_community.content_canonical_json(jsonb_build_array(value->'accountId',value->'scope',
 whaleu_community.related_sync_generation_fingerprint('actor'),
 whaleu_community.related_sync_generation_fingerprint('admission'),
 whaleu_community.related_sync_generation_fingerprint('distribution'),
 whaleu_community.related_sync_generation_fingerprint('view'),
 whaleu_community.related_sync_ancestor_facts(value))),'UTF8')),'hex')
$$;
CREATE FUNCTION whaleu_community.related_sync_capture_actor() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.related_actor_fingerprint IS NOT NULL OR NEW.related_actor_transaction IS NOT NULL THEN RAISE EXCEPTION 'Related actor proof is owner issued' USING ERRCODE='23514'; END IF;
 IF NEW.envelope_version=4 THEN
  IF whaleu_community.related_sync_actor_current(NEW.envelope) IS DISTINCT FROM true THEN RAISE EXCEPTION 'Current own related actor authority required' USING ERRCODE='23514'; END IF;
  NEW.related_actor_fingerprint:=whaleu_community.related_sync_actor_fingerprint(NEW.envelope);
  NEW.related_actor_transaction:=pg_current_xact_id();
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER a_related_actor_capture BEFORE INSERT ON whaleu_community.content_approval_bindings FOR EACH ROW EXECUTE FUNCTION whaleu_community.related_sync_capture_actor();
CREATE FUNCTION whaleu_community.related_sync_assert_actor(kind text,node uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE b whaleu_community.content_approval_bindings;
BEGIN
 SELECT * INTO b FROM whaleu_community.content_approval_bindings WHERE content_kind=kind AND content_id=node;
 LOCK TABLE whaleu_community.related_sync_actor_generation,whaleu_community.related_sync_admission_generation,whaleu_campus.community_distribution_generation,whaleu_community.related_sync_view_generation IN SHARE MODE NOWAIT;
 IF b.related_actor_transaction IS DISTINCT FROM pg_current_xact_id() OR b.related_actor_fingerprint IS DISTINCT FROM whaleu_community.related_sync_actor_fingerprint(b.envelope)
 OR whaleu_community.related_sync_actor_current(b.envelope) IS DISTINCT FROM true
 OR whaleu_community.profile_moderation_media_current(kind,node,b.envelope->'images') IS DISTINCT FROM true THEN RAISE EXCEPTION 'Original related actor publication proof changed' USING ERRCODE='23514'; END IF;
END $$;

-- Actor/ancestry sources have statement coverage, including zero-row attempts.
DO $$ DECLARE relation text; BEGIN
 FOREACH relation IN ARRAY ARRAY['whaleu_identity.accounts','whaleu_safety.account_heads','whaleu_safety.blocks','whaleu_authorization.role_grants',
 'whaleu_community.posts','whaleu_community.root_comments','whaleu_community.replies','whaleu_community.post_owner_visibility','whaleu_community.post_category_heads','whaleu_community.post_category_events','whaleu_community.post_category_issuers','whaleu_community.post_category_issuer_withdrawals',
 'whaleu_community.post_category_policies','whaleu_community.post_category_policy_heads','whaleu_community.post_category_policy_withdrawals','whaleu_community.post_category_reviews','whaleu_community.post_category_review_withdrawals',
 'whaleu_community.post_images','whaleu_community.comment_images','whaleu_community.reply_images','whaleu_community.polls','whaleu_community.poll_options','whaleu_community.formations','whaleu_community.formation_members',
 'whaleu_community.content_approval_bindings','whaleu_community.content_approval_policies','whaleu_community.content_approval_decisions','whaleu_community.content_approval_events','whaleu_community.content_approval_heads',
 'whaleu_media.assets','whaleu_media.upload_intents','whaleu_media.asset_safety_heads','whaleu_media.asset_safety_events'] LOOP
  EXECUTE format('CREATE TRIGGER a000_related_actor_generation BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON %s FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.related_sync_advance_generation(''actor'')',relation);
 END LOOP;
END $$;
CREATE TRIGGER a000_related_actor_generation BEFORE UPDATE OR DELETE OR TRUNCATE ON whaleu_media.bindings FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.related_sync_advance_generation('actor');
CREATE FUNCTION whaleu_community.related_sync_media_binding_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 -- The only excluded delta is a nonempty set of exact newly issued v4 nodes'
 -- own image bindings in this transaction. It cannot alter any prior ancestor.
 -- Empty INSERTs and any other target advance the original observation.
 IF EXISTS(SELECT 1 FROM related_inserted_bindings) AND NOT EXISTS(
  SELECT 1 FROM related_inserted_bindings m WHERE NOT EXISTS(
   SELECT 1 FROM whaleu_community.content_approval_bindings b WHERE b.envelope_version=4 AND b.related_actor_transaction=pg_current_xact_id()
    AND m.owner_kind='community' AND m.resource_kind=b.content_kind AND m.resource_id=b.content_id AND m.content_version=1 AND m.slot='images' AND m.detached_at IS NULL
    AND b.envelope->'images'->m.ordinal=jsonb_build_object('assetId',m.asset_id,'digest',m.manifest_digest))) THEN RETURN NULL; END IF;
 PERFORM whaleu_community.related_sync_generation_advance('actor');
 RETURN NULL;
END $$;
CREATE TRIGGER related_actor_media_insert AFTER INSERT ON whaleu_media.bindings REFERENCING NEW TABLE AS related_inserted_bindings FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.related_sync_media_binding_insert();

CREATE FUNCTION whaleu_community.related_sync_child_intent_hash(value jsonb,requested_mode text) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE images jsonb; intent text;
BEGIN
 IF whaleu_community.related_sync_envelope_valid(value) IS DISTINCT FROM true OR value->>'purpose'='publish_post' OR requested_mode NOT IN('named','anonymous') THEN RETURN NULL; END IF;
 SELECT coalesce(jsonb_agg(image->'assetId' ORDER BY position),'[]'::jsonb) INTO images FROM jsonb_array_elements(value->'images') WITH ORDINALITY item(image,position);
 IF value->>'purpose'='publish_comment' THEN intent:='{"postId":'||(value->'postId')::text;
 ELSE intent:='{"rootCommentId":'||(value->'rootCommentId')::text||',"targetReplyId":'||(value->'targetReplyId')::text; END IF;
 intent:=intent||',"text":'||(value->'text')::text||',"imageAssetIds":'||whaleu_community.content_canonical_json(images)||',"authorMode":'||to_jsonb(requested_mode)::text||'}';
 RETURN encode(sha256(convert_to('{"operation":'||(value->'purpose')::text||',"intent":'||intent||'}','UTF8')),'hex');
END $$;

-- Every new count dependency remains in both independently checked removal inventories.
DO $$ BEGIN
 IF whaleu_community.admin_post_removal_inventory_current() IS DISTINCT FROM true OR whaleu_community.admin_discussion_removal_inventory_current() IS DISTINCT FROM true THEN
  RAISE EXCEPTION 'Incomplete related publication removal source inventory' USING ERRCODE='23514';
 END IF;
END $$;
