-- Explicit metadata admission only. No seed, grants, publication activation,
-- category widening, historical adoption, or source/Review reinterpretation.
SET LOCAL lock_timeout='5s';
SELECT pg_advisory_xact_lock(hashtextextended('whaleu:named-block-policy:v1',0));
SELECT pg_advisory_xact_lock(hashtextextended('whaleu:home-admission:v1',0));

CREATE FUNCTION whaleu_community.home_policy_definition_valid(d jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE m jsonb;s jsonb;e jsonb;expected integer;seen text[]:='{}';key text;water boolean:=false;BEGIN
 IF NOT whaleu_community.related_sync_exact_keys(d,ARRAY['version','sourceCommit','categoryMappings','scopeMappings','authorModes','exemptions','surfaces','markdownReferences'])
 OR d->'version' IS DISTINCT FROM '1'::jsonb OR d->>'sourceCommit' IS DISTINCT FROM '4494e36b9451e3a92874ccf85f574a36e28e3d48'
 OR d->'markdownReferences' IS DISTINCT FROM 'false'::jsonb
 OR jsonb_typeof(d->'categoryMappings') IS DISTINCT FROM 'array' OR jsonb_array_length(d->'categoryMappings') NOT BETWEEN 1 AND 12
 OR jsonb_typeof(d->'scopeMappings') IS DISTINCT FROM 'array' OR jsonb_array_length(d->'scopeMappings') NOT BETWEEN 1 AND 16
 OR jsonb_typeof(d->'authorModes') IS DISTINCT FROM 'array' OR jsonb_array_length(d->'authorModes') NOT BETWEEN 1 AND 2 THEN RETURN false;END IF;
 FOR m IN SELECT value FROM jsonb_array_elements(d->'authorModes') LOOP
  IF m NOT IN ('"named"'::jsonb,'"anonymous"'::jsonb) OR m::text=ANY(seen) THEN RETURN false;END IF;seen:=array_append(seen,m::text);
 END LOOP;seen:='{}';
 FOR m IN SELECT value FROM jsonb_array_elements(d->'categoryMappings') LOOP
  IF whaleu_community.related_sync_exact_keys(m,ARRAY['nativeCategory','sourceKind','legacyChoose']) IS DISTINCT FROM true OR m->>'sourceKind' IS NULL OR m->>'sourceKind' NOT IN ('regional','global') THEN RETURN false;END IF;
  expected:=CASE m->>'nativeCategory' WHEN 'discussion' THEN 2 WHEN 'confession' THEN 4 WHEN 'companions' THEN 99 WHEN 'pets' THEN 10 WHEN 'internships' THEN 11 WHEN 'scenery' THEN 12 WHEN 'dorms' THEN 13 WHEN 'research' THEN 14 WHEN 'deep_sea' THEN 15 WHEN 'trading' THEN 3 WHEN 'water' THEN 9 ELSE NULL END;
  IF m->>'sourceKind'='global' THEN IF m->>'nativeCategory' IS DISTINCT FROM 'discussion' THEN RETURN false;END IF;expected:=100;END IF;
  IF expected IS NULL OR m->'legacyChoose' IS DISTINCT FROM to_jsonb(expected) THEN RETURN false;END IF;
  key:=(m->>'sourceKind')||':'||(m->>'nativeCategory');IF key=ANY(seen) THEN RETURN false;END IF;seen:=array_append(seen,key);
  IF expected=9 THEN water:=true;END IF;
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d->'scopeMappings') scope WHERE scope->>'sourceKind'=m->>'sourceKind') THEN RETURN false;END IF;
 END LOOP;IF NOT water THEN RETURN false;END IF;seen:='{}';
 FOR s IN SELECT value FROM jsonb_array_elements(d->'scopeMappings') LOOP
  IF whaleu_community.related_sync_exact_keys(s,ARRAY['sourceSpaceId','sourceKind','sourceRegionId','targetWaterSpaceId','targetRegionId']) IS DISTINCT FROM true
  OR s->>'sourceKind' IS NULL OR s->>'sourceKind' NOT IN ('regional','global') THEN RETURN false;END IF;
  FOREACH key IN ARRAY ARRAY['sourceSpaceId','targetWaterSpaceId','targetRegionId'] LOOP
   IF jsonb_typeof(s->key) IS DISTINCT FROM 'string' OR s->>key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN RETURN false;END IF;
  END LOOP;
  IF s->>'sourceKind'='global' THEN IF s->'sourceRegionId' IS DISTINCT FROM 'null'::jsonb THEN RETURN false;END IF;
  ELSIF s->'sourceRegionId' IS DISTINCT FROM s->'targetRegionId' OR s->'sourceSpaceId' IS DISTINCT FROM s->'targetWaterSpaceId' THEN RETURN false;END IF;
  key:=(s->>'sourceSpaceId')||':'||(s->>'targetRegionId');IF key=ANY(seen) THEN RETURN false;END IF;seen:=array_append(seen,key);
 END LOOP;
 e:=d->'exemptions';
 IF e->>'audit'='none' THEN
  IF whaleu_community.related_sync_exact_keys(e,ARRAY['audit','attachments']) IS DISTINCT FROM true THEN RETURN false;END IF;
 ELSIF e->>'audit'='institution5_owner' THEN
  IF whaleu_community.related_sync_exact_keys(e,ARRAY['audit','attachments','owner','legacyInstitution','institutionId','regionId','evidenceRef']) IS DISTINCT FROM true
  OR e->>'owner' IS DISTINCT FROM 'verification_assertion_institution' OR e->'legacyInstitution' IS DISTINCT FROM '5'::jsonb
  OR e->>'institutionId' IS NULL OR e->>'institutionId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  OR e->>'regionId' IS NULL OR e->>'regionId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  OR jsonb_typeof(e->'evidenceRef') IS DISTINCT FROM 'string' OR length(e->>'evidenceRef') NOT BETWEEN 1 AND 500 OR whaleu_profile.moderation_trim(e->>'evidenceRef') IS DISTINCT FROM e->>'evidenceRef' OR (e->>'evidenceRef') ~ U&'[\0001-\001F\007F-\009F]' THEN RETURN false;END IF;
 ELSE RETURN false;END IF;
 IF e->>'attachments' IS DISTINCT FROM 'normalized_server_facts' THEN RETURN false;END IF;
 s:=d->'surfaces';
 RETURN coalesce(whaleu_community.related_sync_exact_keys(s,ARRAY['home','hot','following']) AND s->'home'='true'::jsonb
 AND s->>'hot' IN ('disabled','exclude_water') AND s->>'following' IN ('excluded','named_only_author_filter'),false);
EXCEPTION WHEN OTHERS THEN RETURN false;END$$;

-- Preparation is an explicit persisted operator action, not a read-only preview.
CREATE TABLE whaleu_community.home_policy_preparations(
 id uuid PRIMARY KEY,definition jsonb NOT NULL CHECK(whaleu_community.home_policy_definition_valid(definition)),
 payload jsonb NOT NULL CHECK(octet_length(payload::text)<=65536),
 digest text NOT NULL CHECK(digest=encode(sha256(convert_to('whaleu-home-preview:v1'||chr(10)||whaleu_community.content_canonical_json(payload),'UTF8')),'hex')),
 issued_at timestamptz NOT NULL CHECK(isfinite(issued_at)),expires_at timestamptz NOT NULL CHECK(expires_at=issued_at+interval '5 minutes'),
 valid_until timestamptz NOT NULL CHECK(isfinite(valid_until)),publication_transaction xid8 NOT NULL DEFAULT pg_current_xact_id()
);
CREATE TRIGGER home_policy_preparations_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON whaleu_community.home_policy_preparations FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.content_approval_immutable();

CREATE TABLE whaleu_community.home_policy_admissions(
 id uuid PRIMARY KEY,preparation_id uuid NOT NULL UNIQUE REFERENCES whaleu_community.home_policy_preparations(id),revision integer NOT NULL UNIQUE CHECK(revision>0),previous_id uuid REFERENCES whaleu_community.home_policy_admissions(id),
 source_commit text NOT NULL CHECK(source_commit='4494e36b9451e3a92874ccf85f574a36e28e3d48'),
 definition jsonb NOT NULL CHECK(octet_length(definition::text)<=32768 AND whaleu_community.home_policy_definition_valid(definition)),
 digest text NOT NULL CHECK(digest=encode(sha256(convert_to('whaleu-home-admission:v1'||chr(10)||whaleu_community.content_canonical_json(definition),'UTF8')),'hex')),
 operator_ref text NOT NULL CHECK(length(btrim(operator_ref)) BETWEEN 1 AND 200),
 database_actor text NOT NULL CHECK(length(database_actor)>0),evidence_ref text NOT NULL CHECK(length(evidence_ref) BETWEEN 1 AND 1000 AND whaleu_profile.moderation_trim(evidence_ref)=evidence_ref AND evidence_ref !~ U&'[\0001-\001F\007F-\009F]'),
 accepted_at timestamptz NOT NULL CHECK(isfinite(accepted_at)),valid_until timestamptz NOT NULL CHECK(isfinite(valid_until) AND valid_until>accepted_at AND valid_until<=accepted_at+interval '168 hours'),
 publication_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),UNIQUE(id,revision),
 CHECK((revision=1 AND previous_id IS NULL) OR (revision>1 AND previous_id IS NOT NULL))
);
CREATE TABLE whaleu_community.home_policy_head(
 slot integer PRIMARY KEY CHECK(slot=1),revision integer NOT NULL CHECK(revision>0),admission_id uuid NOT NULL,
 FOREIGN KEY(admission_id,revision) REFERENCES whaleu_community.home_policy_admissions(id,revision)
);
CREATE TRIGGER home_policy_admissions_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON whaleu_community.home_policy_admissions FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.content_approval_immutable();
CREATE TRIGGER home_policy_head_no_delete BEFORE DELETE OR TRUNCATE ON whaleu_community.home_policy_head FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.content_approval_immutable();

CREATE FUNCTION whaleu_community.home_policy_scope_snapshot(d jsonb) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT coalesce(jsonb_agg(to_jsonb(found) ORDER BY found.id),'[]'::jsonb) FROM (
  SELECT s.id,s.kind,s.operating_region_id region_id,r.is_active region_active
  FROM whaleu_community.spaces s LEFT JOIN whaleu_campus.operating_regions r ON r.id=s.operating_region_id
  WHERE s.is_active AND s.id IN (SELECT (v->>'sourceSpaceId')::uuid FROM jsonb_array_elements(d->'scopeMappings') v UNION SELECT (v->>'targetWaterSpaceId')::uuid FROM jsonb_array_elements(d->'scopeMappings') v)
 ) found
$$;
CREATE FUNCTION whaleu_community.home_policy_preparation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p jsonb:=NEW.payload;h whaleu_community.home_policy_head;m jsonb;field text;BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('whaleu:named-block-policy:v1',0));
 PERFORM pg_advisory_xact_lock(hashtextextended('whaleu:home-admission:v1',0));
 SELECT * INTO h FROM whaleu_community.home_policy_head WHERE slot=1 FOR UPDATE;
 IF whaleu_community.related_sync_exact_keys(p,ARRAY['previousRevision','previousId','scopes','definitionDigest','evidenceRef','validForHours','operator','databaseActor','sourceReviewPolicyId','configuredSpaceId','configuredRegionId','preparationId','issuedAt','expiresAt','validUntil']) IS DISTINCT FROM true
 OR p->'previousRevision' IS DISTINCT FROM to_jsonb(coalesce(h.revision,0)) OR p->'previousId' IS DISTINCT FROM coalesce(to_jsonb(h.admission_id),'null'::jsonb)
 OR p->>'preparationId' IS DISTINCT FROM NEW.id::text OR p->>'databaseActor' IS DISTINCT FROM current_user OR p->>'operator' IS NULL OR p->>'operator' NOT LIKE 'manual:%' OR length(p->>'operator')>200
 OR p->>'definitionDigest' IS DISTINCT FROM encode(sha256(convert_to('whaleu-home-admission:v1'||chr(10)||whaleu_community.content_canonical_json(NEW.definition),'UTF8')),'hex')
 OR jsonb_typeof(p->'evidenceRef') IS DISTINCT FROM 'string' OR length(p->>'evidenceRef') NOT BETWEEN 1 AND 1000
 OR whaleu_profile.moderation_trim(p->>'evidenceRef') IS DISTINCT FROM p->>'evidenceRef' OR (p->>'evidenceRef') ~ U&'[\0001-\001F\007F-\009F]'
 OR jsonb_typeof(p->'validForHours') IS DISTINCT FROM 'number' OR p->>'validForHours' !~ '^[1-9][0-9]{0,2}$' OR (p->>'validForHours')::integer NOT BETWEEN 1 AND 168
 OR NEW.issued_at<>date_trunc('milliseconds',statement_timestamp()) OR NEW.expires_at<>NEW.issued_at+interval '5 minutes'
 OR NEW.valid_until<>NEW.issued_at+((p->>'validForHours')::integer*interval '1 hour') OR NEW.publication_transaction<>pg_current_xact_id()
 OR p->>'issuedAt' IS DISTINCT FROM to_char(NEW.issued_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
 OR p->>'expiresAt' IS DISTINCT FROM to_char(NEW.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
 OR p->>'validUntil' IS DISTINCT FROM to_char(NEW.valid_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
 THEN RAISE EXCEPTION 'Exact server-issued home-policy preparation required' USING ERRCODE='23514';END IF;
 FOREACH field IN ARRAY ARRAY['sourceReviewPolicyId','configuredSpaceId','configuredRegionId'] LOOP
  IF p->>field IS NULL OR p->>field !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN RAISE EXCEPTION 'Exact home-policy configuration identifiers required' USING ERRCODE='23514';END IF;
 END LOOP;
 FOR m IN SELECT value FROM jsonb_array_elements(NEW.definition->'scopeMappings') LOOP
  PERFORM 1 FROM whaleu_community.spaces WHERE id IN ((m->>'sourceSpaceId')::uuid,(m->>'targetWaterSpaceId')::uuid) ORDER BY id FOR SHARE;
  PERFORM 1 FROM whaleu_campus.operating_regions WHERE id=(m->>'targetRegionId')::uuid FOR SHARE;
  IF m->>'targetWaterSpaceId' IS DISTINCT FROM p->>'configuredSpaceId' OR m->>'targetRegionId' IS DISTINCT FROM p->>'configuredRegionId'
   OR NOT EXISTS(SELECT 1 FROM whaleu_community.spaces s WHERE s.id=(m->>'sourceSpaceId')::uuid AND s.is_active AND s.kind=m->>'sourceKind' AND s.operating_region_id::text IS NOT DISTINCT FROM m->>'sourceRegionId')
   OR NOT EXISTS(SELECT 1 FROM whaleu_community.spaces s JOIN whaleu_campus.operating_regions r ON r.id=s.operating_region_id WHERE s.id=(m->>'targetWaterSpaceId')::uuid AND s.kind='regional' AND s.is_active AND r.is_active AND r.id=(m->>'targetRegionId')::uuid)
  THEN RAISE EXCEPTION 'Exact configured home-policy scopes required' USING ERRCODE='23514';END IF;
 END LOOP;
 IF p->'scopes' IS DISTINCT FROM whaleu_community.home_policy_scope_snapshot(NEW.definition) THEN RAISE EXCEPTION 'Exact current scope snapshot required' USING ERRCODE='23514';END IF;
 RETURN NEW;
END$$;
CREATE TRIGGER home_policy_preparations_guard BEFORE INSERT ON whaleu_community.home_policy_preparations FOR EACH ROW EXECUTE FUNCTION whaleu_community.home_policy_preparation_guard();

CREATE FUNCTION whaleu_community.home_policy_write_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE h whaleu_community.home_policy_head;a whaleu_community.home_policy_admissions;p whaleu_community.home_policy_preparations;m jsonb;BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('whaleu:named-block-policy:v1',0));
 PERFORM pg_advisory_xact_lock(hashtextextended('whaleu:home-admission:v1',0));
 SELECT * INTO h FROM whaleu_community.home_policy_head WHERE slot=1 FOR UPDATE;
 IF TG_TABLE_NAME='home_policy_admissions' THEN
  SELECT * INTO p FROM whaleu_community.home_policy_preparations WHERE id=NEW.preparation_id FOR SHARE;
  IF p.id IS NULL OR p.expires_at<=clock_timestamp() OR p.issued_at>clock_timestamp()
   OR p.definition IS DISTINCT FROM NEW.definition OR p.payload->>'databaseActor' IS DISTINCT FROM NEW.database_actor
   OR p.payload->>'operator' IS DISTINCT FROM NEW.operator_ref OR p.payload->>'evidenceRef' IS DISTINCT FROM NEW.evidence_ref
   OR p.payload->'previousRevision' IS DISTINCT FROM to_jsonb(NEW.revision-1) OR p.payload->'previousId' IS DISTINCT FROM coalesce(to_jsonb(NEW.previous_id),'null'::jsonb)
   OR p.valid_until IS DISTINCT FROM NEW.valid_until OR p.payload->'scopes' IS DISTINCT FROM whaleu_community.home_policy_scope_snapshot(NEW.definition)
  THEN RAISE EXCEPTION 'Exact unexpired immutable preparation required' USING ERRCODE='23514';END IF;
  IF NEW.revision<>coalesce(h.revision,0)+1 OR NEW.previous_id IS DISTINCT FROM h.admission_id
   OR NEW.database_actor<>current_user OR NEW.publication_transaction<>pg_current_xact_id()
   OR NEW.accepted_at<>statement_timestamp() OR NEW.operator_ref NOT LIKE 'manual:%'
  THEN RAISE EXCEPTION 'Exact current home-policy predecessor and operator required' USING ERRCODE='23514';END IF;
  FOR m IN SELECT value FROM jsonb_array_elements(NEW.definition->'scopeMappings') LOOP
   PERFORM 1 FROM whaleu_community.spaces WHERE id IN ((m->>'sourceSpaceId')::uuid,(m->>'targetWaterSpaceId')::uuid) ORDER BY id FOR SHARE;
   PERFORM 1 FROM whaleu_campus.operating_regions WHERE id=(m->>'targetRegionId')::uuid FOR SHARE;
   IF NOT EXISTS(SELECT 1 FROM whaleu_community.spaces s WHERE s.id=(m->>'sourceSpaceId')::uuid AND s.is_active AND s.kind=m->>'sourceKind' AND s.operating_region_id::text IS NOT DISTINCT FROM m->>'sourceRegionId')
    OR NOT EXISTS(SELECT 1 FROM whaleu_community.spaces s JOIN whaleu_campus.operating_regions r ON r.id=s.operating_region_id WHERE s.id=(m->>'targetWaterSpaceId')::uuid AND s.kind='regional' AND s.is_active AND r.is_active AND r.id=(m->>'targetRegionId')::uuid)
   THEN RAISE EXCEPTION 'Current exact home-policy scopes required' USING ERRCODE='23514';END IF;
  END LOOP;
 ELSE
  SELECT * INTO a FROM whaleu_community.home_policy_admissions WHERE id=NEW.admission_id;
  IF NEW.revision<>coalesce(h.revision,0)+1 OR a.previous_id IS DISTINCT FROM h.admission_id OR a.revision<>NEW.revision
   OR a.publication_transaction<>pg_current_xact_id() OR a.valid_until<=clock_timestamp()
  THEN RAISE EXCEPTION 'Exact fresh home-policy head transition required' USING ERRCODE='23514';END IF;
 END IF;RETURN NEW;
END$$;
CREATE TRIGGER home_policy_admissions_guard BEFORE INSERT ON whaleu_community.home_policy_admissions FOR EACH ROW EXECUTE FUNCTION whaleu_community.home_policy_write_guard();
CREATE TRIGGER home_policy_head_guard BEFORE INSERT OR UPDATE ON whaleu_community.home_policy_head FOR EACH ROW EXECUTE FUNCTION whaleu_community.home_policy_write_guard();
CREATE FUNCTION whaleu_community.home_policy_complete() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF NOT EXISTS(SELECT 1 FROM whaleu_community.home_policy_head WHERE slot=1 AND revision>=NEW.revision) THEN
  RAISE EXCEPTION 'Home-policy admission must atomically advance head' USING ERRCODE='23514';END IF;RETURN NULL;END$$;
CREATE CONSTRAINT TRIGGER home_policy_admission_complete AFTER INSERT ON whaleu_community.home_policy_admissions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community.home_policy_complete();
CREATE FUNCTION whaleu_community.home_policy_protocol() RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
 SELECT '{"version":1,"sourceCommit":"4494e36b9451e3a92874ccf85f574a36e28e3d48","migration":"0177_home_policy_admission.sql","publicationReady":false}'::jsonb
$$;
CREATE FUNCTION whaleu_community.home_policy_catalog_valid() RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled='O' AND (tgrelid,tgname::text) IN (
 ('whaleu_community.home_policy_preparations'::regclass,'home_policy_preparations_immutable'),
 ('whaleu_community.home_policy_preparations'::regclass,'home_policy_preparations_guard'),
 ('whaleu_community.home_policy_admissions'::regclass,'home_policy_admissions_immutable'),
 ('whaleu_community.home_policy_admissions'::regclass,'home_policy_admissions_guard'),
 ('whaleu_community.home_policy_admissions'::regclass,'home_policy_admission_complete'),
 ('whaleu_community.home_policy_head'::regclass,'home_policy_head_no_delete'),
 ('whaleu_community.home_policy_head'::regclass,'home_policy_head_guard')))=7
 AND NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid IN ('whaleu_community.home_policy_preparations'::regclass,'whaleu_community.home_policy_admissions'::regclass,'whaleu_community.home_policy_head'::regclass) AND NOT convalidated)
$$;
