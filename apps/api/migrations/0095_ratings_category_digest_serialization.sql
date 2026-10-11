-- Only the two Category digest shapes below gain a faster serializer. This is
-- an encoding optimization, never a validation cache: every original plan,
-- expiry, current-source, authority and deferred publication proof still runs.
-- Keep the original creation codec and every other digest domain unchanged.
SET LOCAL lock_timeout='5s';

CREATE FUNCTION whaleu_ratings.category_digest_record_shape(value jsonb,fields jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE STRICT AS $$
BEGIN
 IF jsonb_typeof(value)<>'object' THEN RETURN false;END IF;
 RETURN value-ARRAY(SELECT jsonb_object_keys(fields))='{}'::jsonb
 AND NOT EXISTS(SELECT 1 FROM jsonb_each_text(fields) field(key,expected_type) WHERE
  jsonb_typeof(value->field.key) IS NULL OR NOT jsonb_typeof(value->field.key)=ANY(string_to_array(field.expected_type,'|')));
END$$;

-- Identical JSONB scalar spelling, C key order and array ordinality to the
-- original codec. Scalar children are emitted in the aggregate, rather than
-- invoking the recursive SQL function separately for every scalar leaf.
CREATE FUNCTION whaleu_ratings.category_digest_canonical_json(value jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE encoded text;
BEGIN
 CASE jsonb_typeof(value)
 WHEN 'object' THEN
  SELECT '{'||coalesce(string_agg(to_jsonb(key)::text||':'||CASE WHEN jsonb_typeof(val) IN ('object','array')
   THEN whaleu_ratings.category_digest_canonical_json(val) ELSE val::text END,',' ORDER BY key COLLATE "C"),'')||'}'
  INTO encoded FROM jsonb_each(value) entry(key,val);
 WHEN 'array' THEN
  SELECT '['||coalesce(string_agg(CASE WHEN jsonb_typeof(val) IN ('object','array')
   THEN whaleu_ratings.category_digest_canonical_json(val) ELSE val::text END,',' ORDER BY ordinal),'')||']'
  INTO encoded FROM jsonb_array_elements(value) WITH ORDINALITY entry(val,ordinal);
 ELSE encoded:=value::text;
 END CASE;
 RETURN encoded;
END$$;

-- NULL means an unfamiliar shape: scoped_digest must use its original codec.
-- Payloads and Review envelopes in a text plan are JSON objects by contract;
-- their complete contents are encoded, not selected, trusted or normalized.
CREATE FUNCTION whaleu_ratings.category_digest_fast_canonical(domain text,value jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE entry jsonb;descriptor record;memberships text;
BEGIN
 IF domain='compat-body' THEN
  IF NOT whaleu_ratings.category_digest_record_shape(value,'{"categories":"array","memberships":"array"}') THEN RETURN NULL;END IF;
  FOR entry IN SELECT item FROM jsonb_array_elements(value->'categories') item LOOP
   IF NOT whaleu_ratings.category_digest_record_shape(entry,'{"id":"string","parentId":"string|null","level":"number","kind":"string","systemKey":"string|null","originKind":"string","name":"string","description":"string","active":"boolean","hidden":"boolean","ordinal":"string"}') THEN RETURN NULL;END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(value->'memberships') item WHERE CASE WHEN jsonb_typeof(item)='object' THEN
   item-ARRAY['targetId','categoryId','ordinal']<>'{}'::jsonb
   OR NOT coalesce(jsonb_typeof(item->'targetId')='string' AND jsonb_typeof(item->'categoryId')='string' AND jsonb_typeof(item->'ordinal')='string',false)
   ELSE true END) THEN RETURN NULL;END IF;
  SELECT '['||coalesce(string_agg('{"categoryId":'||(item->'categoryId')::text||',"ordinal":'||(item->'ordinal')::text||',"targetId":'||(item->'targetId')::text||'}',',' ORDER BY ordinal),'')||']'
   INTO memberships FROM jsonb_array_elements(value->'memberships') WITH ORDINALITY encoded_items(item,ordinal);
  RETURN '{"categories":'||whaleu_ratings.category_digest_canonical_json(value->'categories')||',"memberships":'||memberships||'}';
 ELSIF domain='category-plan' THEN
  IF NOT whaleu_ratings.category_digest_record_shape(value,'{"version":"number","accountId":"string","requestId":"string","intentHash":"string","operation":"string","sourceIssues":"array","envelopes":"array","categoryIds":"array","affectedScopeKeys":"array","globalRequired":"boolean","beforeHeads":"array","beforeCompatHeads":"array","beforeBaseAvailability":"array","beforeVector":"array","beforeDigest":"string","policySourceId":"string","policySourceRevision":"string","registrySourceIds":"array","changes":"array","affectedTargetCount":"number","previewDigest":"string","validUntil":"string","noop":"boolean"}') OR value->'version'<>'1'::jsonb THEN RETURN NULL;END IF;
  FOR descriptor IN SELECT * FROM jsonb_each('{
   "beforeHeads":{"scopeKey":"string","catalogRevision":"string","headRevision":"string"},
   "beforeCompatHeads":{"compatKey":"string","versionId":"string","legacyCatalogId":"string|null","scopeKeys":"array"},
   "beforeBaseAvailability":{"sourceId":"string","sourceRevision":"string","current":"boolean"},
   "beforeVector":{"id":"string","revision":"string","kind":"string","key":"string","digest":"string"},
   "changes":{"categoryId":"string","scopeKeys":"array","field":"string","before":"string|null","after":"string|null","beforeStatus":"string","afterStatus":"string"}
  }'::jsonb) LOOP
   FOR entry IN SELECT item FROM jsonb_array_elements(value->descriptor.key) item LOOP
    IF NOT whaleu_ratings.category_digest_record_shape(entry,descriptor.value) THEN RETURN NULL;END IF;
    IF entry ? 'scopeKeys' AND EXISTS(SELECT 1 FROM jsonb_array_elements(entry->'scopeKeys') item WHERE jsonb_typeof(item)<>'string') THEN RETURN NULL;END IF;
   END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements((value->'categoryIds')||(value->'affectedScopeKeys')||(value->'registrySourceIds')) item WHERE jsonb_typeof(item)<>'string')
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(value->'envelopes') item WHERE jsonb_typeof(item)<>'object') THEN RETURN NULL;END IF;
  FOR entry IN SELECT item FROM jsonb_array_elements(value->'sourceIssues') item LOOP
   IF jsonb_typeof(entry)<>'object' THEN RETURN NULL;END IF;
   IF NOT whaleu_ratings.category_digest_record_shape(entry-'placement','{"id":"string","revision":"string","kind":"string","key":"string","scopeKeys":"array","payload":"object","previousSourceId":"string|null","previousSourceRevision":"string|null"}') THEN RETURN NULL;END IF;
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(entry->'scopeKeys') item WHERE jsonb_typeof(item)<>'string') THEN RETURN NULL;END IF;
   IF entry ? 'placement' AND NOT whaleu_ratings.category_digest_record_shape(entry->'placement','{"revision":"string","categoryId":"string","baseSourceId":"string","baseSourceRevision":"string"}') THEN RETURN NULL;END IF;
  END LOOP;
  RETURN whaleu_ratings.category_digest_canonical_json(value);
 END IF;
 RETURN NULL;
END$$;

CREATE OR REPLACE FUNCTION whaleu_ratings.scoped_digest(domain text,value jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE canonical text;
BEGIN
 IF domain IN ('category-plan','compat-body') THEN
  canonical:=whaleu_ratings.category_digest_fast_canonical(domain,value);
 END IF;
 IF domain='vector' AND jsonb_typeof(value)='array' THEN
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(value) entry WHERE CASE WHEN jsonb_typeof(entry)='object' THEN
   entry-ARRAY['digest','id','key','kind','revision']<>'{}'::jsonb
   OR NOT coalesce(jsonb_typeof(entry->'digest')='string' AND jsonb_typeof(entry->'id')='string'
    AND jsonb_typeof(entry->'key')='string' AND jsonb_typeof(entry->'kind')='string' AND jsonb_typeof(entry->'revision')='string',false)
   ELSE true END) THEN
   SELECT '['||coalesce(string_agg('{"digest":'||(entry->'digest')::text||',"id":'||(entry->'id')::text
    ||',"key":'||(entry->'key')::text||',"kind":'||(entry->'kind')::text||',"revision":'||(entry->'revision')::text||'}',',' ORDER BY ordinal),'')||']'
    INTO canonical FROM jsonb_array_elements(value) WITH ORDINALITY item(entry,ordinal);
  END IF;
 END IF;
 canonical:=coalesce(canonical,whaleu_ratings.creation_canonical_json(value));
 RETURN encode(sha256(convert_to('whaleu:rating-scoped-'||domain||':v1'||chr(10)||canonical,'UTF8')),'hex');
END$$;
