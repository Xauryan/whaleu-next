-- Additive V7 post / V8 discussion composition. Metadata admission is not
-- activation, activation is not Review, and Review is not access authority.
-- No historical adoption, issuer/provider seed, grants or erasure-owner grant.
SET LOCAL lock_timeout='5s';
SELECT pg_advisory_xact_lock(hashtextextended('whaleu:named-block-policy:v1',0));
SELECT pg_advisory_xact_lock(hashtextextended('whaleu:home-admission:v1',0));

-- Exact reviewed predecessor source preimages, checked BEFORE alteration.
-- A previously drifted implementation cannot be laundered into a new seal.
DO $preimage$ DECLARE item record;BEGIN
 FOR item IN SELECT * FROM (VALUES
  ('whaleu_community.profile_moderation_definition(text,uuid,jsonb)','5961b4a1e6f5f16a7db011d9fdf945cdea77ad2741d5985b6b016c58e15e43c7','plpgsql','v',false,'jsonb',NULL::text[]),
  ('whaleu_community.text_source_definition(text,uuid,jsonb)','9055a1a14a1ad3f0de2d98d2085a04bc89867ab4c9f720aad10279f22cf62d4b','plpgsql','s',false,'jsonb',NULL::text[]),
  ('whaleu_community.text_source_review_current(uuid,boolean)','054fb8fa9bcc7f9a37259391a0e4bacb719fbca7c5d2d81c7287014d7b413e9d','sql','v',false,'boolean',NULL::text[]),
  ('whaleu_community.text_source_assert(text,uuid)','d44e20ff82c9df4072e2a8fa0240c124e8add41144c3787bba66b5bcc60f23db','plpgsql','v',false,'void',NULL::text[]),
  ('whaleu_community.text_source_authority_assert(text,uuid)','cc6805417f965e6a7cae9e195a74a4dabf4b21251338c262b190f84a4f1fd4ac','plpgsql','v',false,'void',NULL::text[]),
  ('whaleu_community.related_review_policy_guard()','9cb4aa9b606afd7b2fcadda090c0e492bfbed37fc87b8648f87dbed439685f4b','plpgsql','v',false,'trigger',NULL::text[]),
  ('whaleu_community.content_binding_dm_definition()','295bfa2fefd85af9823c6c6b2a99c62e25ef0793ca1423eb64e265ac422f7384','plpgsql','v',false,'trigger',NULL::text[]),
  ('whaleu_community.reading_format_source_current(text,uuid)','e78a8651d8aa73632c5fef8ed10123004b688f2b8a34f851147b9dca6545c1f2','plpgsql','v',false,'boolean',NULL::text[]),
  ('whaleu_community.reading_format_source_fence()','0228e0c2b19fe3d109dc301b8d7cb12486a299939313c0de97ca8361b52614c4','plpgsql','v',false,'void',NULL::text[]),
  ('whaleu_community.reading_format_catalog()','4193cd2855e457dbc40ed24a5f1966735e0436b435455eca69e50cbd19893133','sql','s',false,'text',ARRAY['search_path=pg_catalog']::text[]),
  ('whaleu_community.content_canonical_json(jsonb)','9191c3b0d28d569bb8b95b5c67b450c1ac6f09571aeba1055bb516aad794e7f4','plpgsql','i',true,'text',NULL::text[]),
  ('whaleu_community.rating_scoped_nullable_id(jsonb)','1b8e6b0a05d480312ab999c56a7fd96fafb7f3e12d5833662e5beb20ca46d300','sql','i',false,'boolean',NULL::text[]),
  ('whaleu_community.profile_moderation_scope_valid(jsonb)','7a18d2a9200014ddd8802100376e57e99886555a8a55fe444c8c81b996f5aadf','plpgsql','i',true,'boolean',NULL::text[]),
  ('whaleu_community.profile_moderation_media_current(text,uuid,jsonb)','e8dbc46155d5ce74a8722746c40c1c9957bb905bc3341ca4fc91669af2d3b8a8','sql','s',false,'boolean',NULL::text[]),
  ('whaleu_community.related_sync_uuid(jsonb)','0e6a4dc0355d8fd21afea21f5f704761213b168a99ed5fb22b58381be26863a0','sql','i',false,'boolean',NULL::text[]),
  ('whaleu_community.related_sync_exact_keys(jsonb,text[])','9f5322b0eb1d759bcf511d054ca86d376050a4038619e89d7ba5995b043bc073','plpgsql','i',false,'boolean',NULL::text[]),
  ('whaleu_community.text_source_hash(text,text)','59caada5caa4859039a8c9006b5e408665715d409a5d1928bd1d4d450f3f7600','sql','i',true,'text',NULL::text[]),
  ('whaleu_community.text_source_envelope_valid(jsonb)','0162b08fc451f694c5413c20331f0c6c4e70fbcb363eb242b8919360ab25aa16','plpgsql','i',false,'boolean',NULL::text[]),
  ('whaleu_community.text_source_intent_hash(jsonb,text)','cdfad8d9ffff1363fea44d9632c02b74155ae9d17a5da8ff8ef645d0caeae9fc','plpgsql','i',false,'text',NULL::text[]),
  ('whaleu_community.text_source_destination_current(uuid,jsonb,text,text,text,text)','d192b44d71ff02bef28cd40f1c5e926d174d2960c457c8addc43ecc4a3d332ca','plpgsql','v',false,'boolean',NULL::text[]),
  ('whaleu_community.text_source_ancestors_current(jsonb)','e95d9b5cc53722701e06e6ea482b1b516e59509e58d8ebea6bcef3e3d7323093','plpgsql','v',false,'boolean',NULL::text[]),
  ('whaleu_community.text_source_admitted(jsonb)','52bc2e25c10a9e4a9d7e89a23f82d7efff77ddaa4bc5b9dbd74849d7553b0bca','plpgsql','v',false,'boolean',NULL::text[]),
  ('whaleu_community.text_source_fence()','99003944b67193d525b8b409278423935cb76ea5de1250b8c6a683f1ee420d34','plpgsql','v',false,'void',NULL::text[]),
  ('whaleu_community.text_source_insert_guard()','7fa726902d64efc1a7bba97411bd8e89f49566826bd62dd4a9a7a634ab781198','plpgsql','v',false,'trigger',NULL::text[]),
  ('whaleu_community.text_source_complete()','82522c75fb368b3b23b892b41c443085abd5e8f62b225a56f3b43544fbabf9c4','plpgsql','v',false,'trigger',NULL::text[]),
  ('whaleu_community.text_source_review_assert(jsonb,text)','14eda9351cafef07e6e79daceb975c78970dfb731f2f041445d57a380ad1533e','plpgsql','v',false,'void',NULL::text[]),
  ('whaleu_community.text_source_cohort_capture()','999a5e75794c9adc5b784aaaac5615b46ca0b77f161edce03fc57865fc1b5a12','plpgsql','v',false,'trigger',NULL::text[]),
  ('whaleu_community.text_source_review_fresh()','e3b2f0c69bd244cefa439e4214ff54a9da7988ed3b8ca785f6c903ed087e8b87','plpgsql','v',false,'trigger',NULL::text[]),
  ('whaleu_community.text_source_review_complete()','c77ab02a3fdf4e25942bd5c810c15a75e2e6d409f922f15e9f6821516c50fa81','plpgsql','v',false,'trigger',NULL::text[]),
  ('whaleu_community.text_source_review_cohorts_assert()','44e3e6e5db5b3f1b1225d1f8d8c2ed2769163e4778906d4ea550539a3719cc79','plpgsql','v',false,'void',NULL::text[]),
  ('whaleu_community.text_source_recheck_authority()','b4fb03662a9027368ff78df20468b710cb60c7d4b3f122572916e45b0ab8091d','plpgsql','v',false,'trigger',NULL::text[]),
  ('whaleu_community.text_source_recheck_transaction()','d17bc5e8d7086badeec106ba524153e89eac335f094f1bb8823ff824c2173806','plpgsql','v',false,'trigger',NULL::text[]),
  ('whaleu_community.home_policy_definition_valid(jsonb)','1638972e4df07ae11171f826a6adf02963aa54726d46a44886246b82f9265d64','plpgsql','i',true,'boolean',NULL::text[]),
  ('whaleu_community.home_policy_scope_snapshot(jsonb)','58c59e610328a3eb739e8778da441684f0083dfea5879fd482a49812ae89a8f6','sql','s',false,'jsonb',NULL::text[]),
  ('whaleu_community.home_policy_preparation_guard()','adf88041167a7968ea797c363cdcd872cb146c617e1d2165f89d036586ebba8b','plpgsql','v',false,'trigger',NULL::text[]),
  ('whaleu_community.home_policy_write_guard()','d2ed819fdf35165dcd2aedff1d72515b9dcba0219171a7cc46b13a5ef26224a7','plpgsql','v',false,'trigger',NULL::text[]),
  ('whaleu_community.home_policy_complete()','1d022df35c04614c684b86a576f92c4cdb45135d8a3f9838980cabae51a9ba5b','plpgsql','v',false,'trigger',NULL::text[]),
  ('whaleu_community.home_policy_protocol()','153779a8e3f44a7163874edd11d0cada8ea2f43ce11f35b841e0c9bfd4b26bbf','sql','i',false,'jsonb',NULL::text[]),
  ('whaleu_community.home_policy_catalog_valid()','ce5b7736ba437c1974bf3d9a22e1d174efe1341ebbbe0413ec10039bc0aecd75','sql','s',false,'boolean',NULL::text[])) expected(signature,digest,language,volatility,strict_flag,return_type,config) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure(item.signature) AND NOT p.prosecdef AND NOT p.proretset AND NOT p.proleakproof AND p.proparallel='u' AND p.prolang=(SELECT oid FROM pg_language WHERE lanname=item.language) AND p.provolatile::text=item.volatility AND p.proisstrict=item.strict_flag AND p.prorettype=to_regtype(item.return_type) AND p.proconfig IS NOT DISTINCT FROM item.config AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=item.digest)
  THEN RAISE EXCEPTION 'Unexpected Home predecessor source: %',item.signature USING ERRCODE='23514';END IF;
 END LOOP;
 IF whaleu_community.reading_format_protocol()->>'catalog' IS DISTINCT FROM whaleu_community.reading_format_catalog()
 THEN RAISE EXCEPTION 'Reading predecessor catalog drift' USING ERRCODE='23514';END IF;
END $preimage$;

CREATE FUNCTION whaleu_community.home_source_valid(s jsonb,body text) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$BEGIN
 IF s='null'::jsonb THEN RETURN true;END IF;
 IF s->'version' IS DISTINCT FROM '1'::jsonb OR s->>'sourceHash' IS DISTINCT FROM whaleu_community.text_source_hash(s->>'format',body) THEN RETURN false;END IF;
 IF s->>'format'='plain' THEN
  RETURN whaleu_community.related_sync_exact_keys(s,ARRAY['version','format','readingFormatting','sourceHash']) IS TRUE AND s->>'readingFormatting' IN ('auto','off');
 ELSIF s->>'format'='markdown' THEN
  RETURN whaleu_community.related_sync_exact_keys(s,ARRAY['version','format','sourceHash']) IS TRUE
   AND position('whaleu-asset:' IN body)=0 AND NOT ((body COLLATE "C") ~ '#[0-9]');
 END IF;RETURN false;
EXCEPTION WHEN OTHERS THEN RETURN false;END$$;

-- The exact historical insertion order is deliberately NOT canonical JSON.
-- This is new-domain reconstruction; V1--V6 hash functions remain untouched.
CREATE FUNCTION whaleu_community.home_requested_intent_hash(i jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE body text;descriptor text;BEGIN
 IF jsonb_typeof(i) IS DISTINCT FROM 'object' OR i-ARRAY['spaceId','category','text','imageAssetIds','authorMode','commentsPolicy','allowAnonymousDm','syncToRelatedCampuses','textSource']<>'{}'::jsonb
 OR NOT(i ?& ARRAY['spaceId','category','text','imageAssetIds','authorMode','commentsPolicy'])
 OR whaleu_community.related_sync_uuid(i->'spaceId') IS DISTINCT FROM true
 OR i->>'category' IS NULL OR i->>'category' NOT IN ('discussion','confession','companions','pets','internships','scenery','dorms','research','deep_sea')
 OR i->>'authorMode' IS NULL OR i->>'authorMode' NOT IN ('named','anonymous') OR i->>'commentsPolicy' IS NULL OR i->>'commentsPolicy' NOT IN ('open','restricted')
 OR i->'imageAssetIds' IS DISTINCT FROM '[]'::jsonb OR jsonb_typeof(i->'text') IS DISTINCT FROM 'string'
 OR whaleu_profile.moderation_text_valid(i->>'text',2500) IS DISTINCT FROM true OR whaleu_profile.moderation_trim(i->>'text')=''
 OR (i ? 'allowAnonymousDm' AND (jsonb_typeof(i->'allowAnonymousDm') IS DISTINCT FROM 'boolean' OR i->>'authorMode'<>'named'))
 OR (i ? 'syncToRelatedCampuses' AND i->'syncToRelatedCampuses' IS DISTINCT FROM 'true'::jsonb) THEN RETURN NULL;END IF;
 body:='{"spaceId":'||(i->'spaceId')::text||',"category":'||(i->'category')::text||',"text":'||(i->'text')::text||',"imageAssetIds":[],"authorMode":'||(i->'authorMode')::text||',"commentsPolicy":'||(i->'commentsPolicy')::text;
 IF i ? 'allowAnonymousDm' THEN body:=body||',"allowAnonymousDm":'||(i->'allowAnonymousDm')::text;END IF;
 IF i ? 'syncToRelatedCampuses' THEN body:=body||',"syncToRelatedCampuses":true';END IF;
 IF i ? 'textSource' THEN
  IF (i->'textSource' ? 'sourceHash') OR whaleu_community.home_source_valid((i->'textSource')||jsonb_build_object('sourceHash',whaleu_community.text_source_hash(i->'textSource'->>'format',i->>'text')),i->>'text') IS DISTINCT FROM true
   OR i->>'commentsPolicy'<>'open' OR i->'allowAnonymousDm'='true'::jsonb OR i ? 'syncToRelatedCampuses' THEN RETURN NULL;END IF;
  descriptor:='{"version":1,"format":'||(i->'textSource'->'format')::text;
  IF i->'textSource'->>'format'='plain' THEN descriptor:=descriptor||',"readingFormatting":'||(i->'textSource'->'readingFormatting')::text;END IF;
  body:=body||',"textSource":'||descriptor||'}';
 END IF;
 RETURN encode(sha256(convert_to(CASE WHEN i ? 'textSource' THEN 'whaleu-community-text-source-intent:v1'||chr(10) ELSE '' END||'{"operation":"publish_post","intent":'||body||'}}','UTF8')),'hex');
EXCEPTION WHEN OTHERS THEN RETURN NULL;END$$;

-- Plain-only reference conversion is the identity. Markdown admission rejects
-- every #digit before this rule, so no Markdown converter is approximated here.
-- PCRE /u Z + historical U+180E whitespace is enumerated, not locale-dependent.
CREATE FUNCTION whaleu_community.home_restriction(body text,format text) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE value text:=btrim(body,E' \t\n\r\013');ws text:=E'\t\n\013\014\r'||chr(133)||chr(6158)||chr(32)||chr(160)||chr(5760)||chr(8192)||chr(8193)||chr(8194)||chr(8195)||chr(8196)||chr(8197)||chr(8198)||chr(8199)||chr(8200)||chr(8201)||chr(8202)||chr(8232)||chr(8233)||chr(8239)||chr(8287)||chr(12288);
 token text;codes text[];BEGIN
 IF format IS NULL OR format NOT IN ('plain','markdown') OR body IS NULL OR char_length(body)>2500 THEN RAISE EXCEPTION 'Invalid normalized Home rule input' USING ERRCODE='22023';END IF;
 -- PostgreSQL text rejects U+0000 at input; no replacement/stripping occurs.
 IF char_length(value)<=3 THEN RETURN 'short_text';END IF;
 IF format='markdown' THEN RETURN NULL;END IF;
 IF format IS DISTINCT FROM 'plain' OR NOT ((value COLLATE "C") ~ ('^['||ws||']*(#[1-9][0-9]{6,8}['||ws||']*)+$')) THEN RETURN NULL;END IF;
 -- Match original lexical boundaries; adjacent repeats are accepted only when
 -- their value appears in the recognized set, exactly as fixed-source PHP.
 SELECT array_agg(match[1]) INTO codes FROM regexp_matches(value COLLATE "C",'(?<![A-Za-z0-9_/#\\])#([1-9][0-9]{6,8})(?![A-Za-z0-9_])','g') match;
 IF codes IS NULL THEN RETURN NULL;END IF;
 FOR token IN SELECT match[1] FROM regexp_matches(value COLLATE "C",'#([1-9][0-9]{6,8})','g') match LOOP
  IF NOT(token=ANY(codes)) THEN RETURN NULL;END IF;
 END LOOP;RETURN 'reference_only';
END$$;

CREATE FUNCTION whaleu_community.home_evidence_valid(h jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE i jsonb:=h->'requestedIntent';a jsonb:=h->'admission';field text;BEGIN
 IF whaleu_community.related_sync_exact_keys(h,ARRAY['version','admission','requestedIntent','requestedIntentHash','requestedRegionId','legacyChoose','targetWaterSpaceId','targetWaterRegionId','auditExempt','result']) IS DISTINCT FROM true
 OR h->'version' IS DISTINCT FROM '1'::jsonb OR h->'auditExempt' IS DISTINCT FROM 'false'::jsonb
 OR whaleu_community.related_sync_exact_keys(a,ARRAY['id','revision','digest','sourceCommit','validUntil']) IS DISTINCT FROM true
 OR whaleu_community.related_sync_uuid(a->'id') IS DISTINCT FROM true
 OR jsonb_typeof(a->'revision') IS DISTINCT FROM 'number' OR a->>'revision' !~ '^[1-9][0-9]*$' OR (a->>'revision')::numeric>2147483647
 OR a->>'digest' IS NULL OR a->>'digest' !~ '^[a-f0-9]{64}$' OR a->>'sourceCommit' IS DISTINCT FROM '4494e36b9451e3a92874ccf85f574a36e28e3d48'
 OR jsonb_typeof(a->'validUntil') IS DISTINCT FROM 'string' OR NOT isfinite((a->>'validUntil')::timestamptz)
 OR jsonb_typeof(h->'legacyChoose') IS DISTINCT FROM 'number' OR h->>'legacyChoose' !~ '^[1-9][0-9]*$' OR (h->>'legacyChoose')::integer NOT BETWEEN 1 AND 100
 OR whaleu_community.home_requested_intent_hash(i) IS NULL OR h->>'requestedIntentHash' IS DISTINCT FROM whaleu_community.home_requested_intent_hash(i)
 OR h->'result' IS NULL OR h->'result' NOT IN ('null'::jsonb,'"short_text"'::jsonb,'"reference_only"'::jsonb)
 OR h->>'result' IS DISTINCT FROM whaleu_community.home_restriction(i->>'text',coalesce(i->'textSource'->>'format','plain'))
 OR (h->'targetWaterSpaceId'='null'::jsonb) IS DISTINCT FROM (h->'targetWaterRegionId'='null'::jsonb)
 OR (h->'result'<>'null'::jsonb AND h->'targetWaterSpaceId'='null'::jsonb)
 OR (h->'result'='null'::jsonb AND i ? 'syncToRelatedCampuses') THEN RETURN false;END IF;
 FOREACH field IN ARRAY ARRAY['requestedRegionId','targetWaterSpaceId','targetWaterRegionId'] LOOP
  IF whaleu_community.rating_scoped_nullable_id(h->field) IS DISTINCT FROM true THEN RETURN false;END IF;
 END LOOP;RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;END$$;

CREATE FUNCTION whaleu_community.home_envelope_valid(e jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE v text:=e->>'version';field text;i jsonb:=e->'home'->'requestedIntent';h jsonb:=e->'home';image jsonb;ids text[]:='{}';BEGIN
 IF v IS NULL OR v NOT IN ('7','8') OR whaleu_community.related_sync_exact_keys(e,ARRAY['version','accountId','purpose','spaceId','category','authorMode','commentsPolicy','postId','rootCommentId','targetReplyId','text','images','component','trading','scope','allowAnonymousDm','textSource',CASE v WHEN '7' THEN 'home' ELSE 'homeParent' END]) IS DISTINCT FROM true
 OR e->'version' IS DISTINCT FROM to_jsonb(v::integer) OR e->>'authorMode' IS NULL OR e->>'authorMode' NOT IN ('named','anonymous')
 OR e->>'category' IS NULL OR e->>'category' NOT IN ('discussion','confession','companions','pets','internships','scenery','dorms','research','deep_sea','water')
 OR e->>'commentsPolicy' IS NULL OR e->>'commentsPolicy' NOT IN ('open','restricted')
 OR e->'component' IS DISTINCT FROM '{"kind":"none"}'::jsonb OR e->'trading' IS DISTINCT FROM 'null'::jsonb
 OR whaleu_community.profile_moderation_scope_valid(e->'scope') IS DISTINCT FROM true OR e->'scope'->>'sync' IS DISTINCT FROM 'none' OR e->'spaceId' IS DISTINCT FROM e->'scope'->'originalSpaceId'
 OR jsonb_typeof(e->'text') IS DISTINCT FROM 'string' OR whaleu_profile.moderation_text_valid(e->>'text',CASE v WHEN '7' THEN 2500 ELSE 500 END) IS DISTINCT FROM true
 OR jsonb_typeof(e->'images') IS DISTINCT FROM 'array' OR jsonb_array_length(e->'images')>(CASE v WHEN '7' THEN 0 ELSE 3 END)
 OR (whaleu_profile.moderation_trim(e->>'text')='' AND (v='7' OR jsonb_array_length(e->'images')=0))
 OR whaleu_community.home_source_valid(e->'textSource',e->>'text') IS DISTINCT FROM true THEN RETURN false;END IF;
 FOREACH field IN ARRAY ARRAY['accountId','spaceId'] LOOP IF whaleu_community.related_sync_uuid(e->field) IS DISTINCT FROM true THEN RETURN false;END IF;END LOOP;
 FOREACH field IN ARRAY ARRAY['postId','rootCommentId','targetReplyId'] LOOP IF whaleu_community.rating_scoped_nullable_id(e->field) IS DISTINCT FROM true THEN RETURN false;END IF;END LOOP;
 FOR image IN SELECT value FROM jsonb_array_elements(e->'images') LOOP
  IF whaleu_community.related_sync_exact_keys(image,ARRAY['assetId','digest']) IS DISTINCT FROM true OR whaleu_community.related_sync_uuid(image->'assetId') IS DISTINCT FROM true OR image->>'digest' IS NULL OR image->>'digest' !~ '^[a-f0-9]{64}$' OR image->>'assetId'=ANY(ids) THEN RETURN false;END IF;
  ids:=array_append(ids,image->>'assetId');
 END LOOP;
 IF e->'textSource'<>'null'::jsonb AND (e->>'commentsPolicy'<>'open' OR e->'images'<>'[]'::jsonb OR whaleu_profile.moderation_trim(e->>'text')='') THEN RETURN false;END IF;
 IF v='7' THEN
  RETURN coalesce(e->>'purpose'='publish_post' AND e->'postId'='null'::jsonb AND e->'rootCommentId'='null'::jsonb AND e->'targetReplyId'='null'::jsonb
   AND whaleu_community.home_evidence_valid(h) AND e->'text'=i->'text' AND e->'authorMode'=i->'authorMode' AND e->'commentsPolicy'=i->'commentsPolicy'
   AND e->'allowAnonymousDm'=CASE WHEN e->>'authorMode'='named' THEN coalesce(i->'allowAnonymousDm','null'::jsonb) ELSE 'null'::jsonb END
   AND e->'spaceId'=CASE WHEN h->'result'='null'::jsonb THEN i->'spaceId' ELSE h->'targetWaterSpaceId' END
   AND e->'scope'->'originalRegionId'=CASE WHEN h->'result'='null'::jsonb THEN h->'requestedRegionId' ELSE h->'targetWaterRegionId' END
   AND e->>'category'=CASE WHEN h->'result'='null'::jsonb THEN i->>'category' ELSE 'water' END
   AND CASE WHEN e->'textSource'='null'::jsonb THEN NOT(i ? 'textSource') ELSE ((e->'textSource')-'sourceHash')=i->'textSource' END,false);
 END IF;
 RETURN coalesce(e->>'purpose' IN ('publish_comment','publish_reply') AND e->'allowAnonymousDm'='null'::jsonb AND e->'postId'<>'null'::jsonb
  AND ((e->>'purpose'='publish_comment' AND e->'rootCommentId'='null'::jsonb AND e->'targetReplyId'='null'::jsonb) OR (e->>'purpose'='publish_reply' AND e->'rootCommentId'<>'null'::jsonb))
  AND whaleu_community.related_sync_exact_keys(e->'homeParent',ARRAY['postId','decisionId','digest'])
  AND e->'homeParent'->'postId'=e->'postId' AND whaleu_community.related_sync_uuid(e->'homeParent'->'decisionId')
  AND e->'homeParent'->>'digest' ~ '^[a-f0-9]{64}$',false);
EXCEPTION WHEN OTHERS THEN RETURN false;END$$;

CREATE FUNCTION whaleu_community.home_intent_hash(e jsonb,requested_mode text) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE body text;descriptor text;images text;BEGIN
 IF whaleu_community.home_envelope_valid(e) IS DISTINCT FROM true OR requested_mode IS NULL OR requested_mode NOT IN ('named','anonymous') THEN RETURN NULL;END IF;
 IF e->>'version'='7' THEN RETURN CASE WHEN requested_mode=e->'home'->'requestedIntent'->>'authorMode' THEN whaleu_community.home_requested_intent_hash(e->'home'->'requestedIntent') ELSE NULL END;END IF;
 SELECT '['||coalesce(string_agg((value->'assetId')::text,',' ORDER BY ordinal),'')||']' INTO images FROM jsonb_array_elements(e->'images') WITH ORDINALITY item(value,ordinal);
 IF e->>'purpose'='publish_comment' THEN body:='{"postId":'||(e->'postId')::text;
 ELSE body:='{"rootCommentId":'||(e->'rootCommentId')::text||',"targetReplyId":'||(e->'targetReplyId')::text;END IF;
 body:=body||',"text":'||(e->'text')::text||',"imageAssetIds":'||images||',"authorMode":'||to_jsonb(requested_mode)::text;
 IF e->'textSource'<>'null'::jsonb THEN
  descriptor:='{"version":1,"format":'||(e->'textSource'->'format')::text;
  IF e->'textSource'->>'format'='plain' THEN descriptor:=descriptor||',"readingFormatting":'||(e->'textSource'->'readingFormatting')::text;END IF;
  body:=body||',"textSource":'||descriptor||'}';
 END IF;
 RETURN encode(sha256(convert_to(CASE WHEN e->'textSource'<>'null'::jsonb THEN 'whaleu-community-text-source-intent:v1'||chr(10) ELSE '' END||'{"operation":'||(e->'purpose')::text||',"intent":'||body||'}}','UTF8')),'hex');
END$$;

CREATE TABLE whaleu_community.home_post_dispositions(
 post_id uuid PRIMARY KEY REFERENCES whaleu_community.posts(id),decision_id uuid NOT NULL UNIQUE REFERENCES whaleu_community.content_approval_decisions(id),
 digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),evidence jsonb NOT NULL CHECK(whaleu_community.home_evidence_valid(evidence)),
 publication_transaction xid8 NOT NULL DEFAULT pg_current_xact_id()
);
CREATE INDEX home_post_dispositions_transaction ON whaleu_community.home_post_dispositions(publication_transaction);
CREATE TABLE whaleu_community.home_discussion_parent_bindings(
 content_kind text NOT NULL CHECK(content_kind IN ('comment','reply')),content_id uuid NOT NULL,
 post_id uuid NOT NULL REFERENCES whaleu_community.home_post_dispositions(post_id),parent_decision_id uuid NOT NULL REFERENCES whaleu_community.content_approval_decisions(id),
 parent_digest text NOT NULL CHECK(parent_digest ~ '^[a-f0-9]{64}$'),decision_id uuid NOT NULL UNIQUE REFERENCES whaleu_community.content_approval_decisions(id),
 digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),publication_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),PRIMARY KEY(content_kind,content_id)
);
CREATE INDEX home_discussion_parent_transaction ON whaleu_community.home_discussion_parent_bindings(publication_transaction);
CREATE TRIGGER home_post_dispositions_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON whaleu_community.home_post_dispositions FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.content_approval_immutable();
CREATE TRIGGER home_discussion_parent_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON whaleu_community.home_discussion_parent_bindings FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.content_approval_immutable();

-- An explicit operator preparation/apply records actual deployment readiness.
-- Neither a migration nor a metadata admission inserts an activation.
CREATE TABLE whaleu_community.home_publication_preparations(
 id uuid PRIMARY KEY,payload jsonb NOT NULL CHECK(octet_length(payload::text)<=32768),
 digest text NOT NULL CHECK(digest=encode(sha256(convert_to('whaleu-home-publication-preview:v1'||chr(10)||whaleu_community.content_canonical_json(payload),'UTF8')),'hex')),
 issued_at timestamptz NOT NULL CHECK(isfinite(issued_at)),expires_at timestamptz NOT NULL CHECK(expires_at=issued_at+interval '5 minutes'),
 valid_until timestamptz NOT NULL CHECK(isfinite(valid_until) AND valid_until>issued_at),publication_transaction xid8 NOT NULL DEFAULT pg_current_xact_id()
);
CREATE TABLE whaleu_community.home_publication_activations(
 id uuid PRIMARY KEY,preparation_id uuid NOT NULL UNIQUE REFERENCES whaleu_community.home_publication_preparations(id),
 revision integer NOT NULL UNIQUE CHECK(revision>0),previous_id uuid REFERENCES whaleu_community.home_publication_activations(id),
 admission_id uuid NOT NULL,admission_revision integer NOT NULL,admission_digest text NOT NULL CHECK(admission_digest ~ '^[a-f0-9]{64}$'),
 catalog_revision integer NOT NULL CHECK(catalog_revision=1),catalog_digest text NOT NULL CHECK(catalog_digest ~ '^[a-f0-9]{64}$'),
 source_review_policy_id uuid REFERENCES whaleu_community.content_approval_policies(id),explicit_review_policy_id uuid REFERENCES whaleu_community.content_approval_policies(id),
 configured_space_id uuid NOT NULL REFERENCES whaleu_community.spaces(id),configured_region_id uuid NOT NULL REFERENCES whaleu_campus.operating_regions(id),
 operator_ref text NOT NULL CHECK(operator_ref LIKE 'manual:%' AND length(operator_ref)<=200),database_actor text NOT NULL CHECK(length(database_actor)>0),
 evidence_ref text NOT NULL CHECK(length(evidence_ref) BETWEEN 1 AND 1000 AND whaleu_profile.moderation_trim(evidence_ref)=evidence_ref AND evidence_ref !~ U&'[\0001-\001F\007F-\009F]'),
 accepted_at timestamptz NOT NULL CHECK(isfinite(accepted_at)),valid_until timestamptz NOT NULL CHECK(isfinite(valid_until) AND valid_until>accepted_at),
 publication_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),UNIQUE(id,revision),
 FOREIGN KEY(admission_id,admission_revision) REFERENCES whaleu_community.home_policy_admissions(id,revision),
 CHECK(source_review_policy_id IS NOT NULL OR explicit_review_policy_id IS NOT NULL),
 CHECK((revision=1 AND previous_id IS NULL) OR (revision>1 AND previous_id IS NOT NULL))
);
CREATE TABLE whaleu_community.home_publication_head(
 slot integer PRIMARY KEY CHECK(slot=1),revision integer NOT NULL CHECK(revision>0),activation_id uuid NOT NULL,
 FOREIGN KEY(activation_id,revision) REFERENCES whaleu_community.home_publication_activations(id,revision)
);
CREATE TRIGGER home_publication_preparations_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON whaleu_community.home_publication_preparations FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.content_approval_immutable();
CREATE TRIGGER home_publication_activations_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON whaleu_community.home_publication_activations FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.content_approval_immutable();
CREATE TRIGGER home_publication_head_retain BEFORE DELETE OR TRUNCATE ON whaleu_community.home_publication_head FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.content_approval_immutable();

CREATE FUNCTION whaleu_community.home_review_policy_current(target uuid,key text) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT coalesce((SELECT policy_key=key AND version=1 AND coverage='complete' AND provenance='accepted'
  AND length(whaleu_profile.moderation_trim(issuer))>0 AND length(whaleu_profile.moderation_trim(provenance_ref))>0
  AND isfinite(valid_from) AND valid_from<=clock_timestamp() AND (valid_until IS NULL OR (isfinite(valid_until) AND valid_until>clock_timestamp()))
 FROM whaleu_community.content_approval_policies WHERE id=target),false)
$$;
CREATE FUNCTION whaleu_community.home_activation_payload_current(p jsonb) RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
DECLARE a whaleu_community.home_policy_admissions;prepared whaleu_community.home_policy_preparations;m jsonb;BEGIN
 SELECT n.* INTO a FROM whaleu_community.home_policy_head h JOIN whaleu_community.home_policy_admissions n ON (n.id,n.revision)=(h.admission_id,h.revision) WHERE h.slot=1 FOR SHARE OF h,n;
 SELECT * INTO prepared FROM whaleu_community.home_policy_preparations WHERE id=a.preparation_id;
 IF a.id IS NULL OR a.accepted_at>clock_timestamp() OR a.valid_until<=clock_timestamp() OR whaleu_community.home_policy_catalog_valid() IS DISTINCT FROM true
 OR whaleu_community.home_policy_definition_valid(a.definition) IS DISTINCT FROM true OR a.definition->'exemptions'->>'audit' IS DISTINCT FROM 'none'
 OR (p->>'admissionId',p->>'admissionRevision',p->>'admissionDigest') IS DISTINCT FROM (a.id::text,a.revision::text,a.digest)
 OR p->>'catalogRevision' IS DISTINCT FROM '1' OR p->>'catalogDigest' IS DISTINCT FROM whaleu_community.home_publication_catalog()
 OR p->>'catalogDigest' IS DISTINCT FROM whaleu_community.home_publication_protocol()->>'catalog'
 OR (p->>'validUntil')::timestamptz>a.valid_until OR (p->>'validUntil')::timestamptz<=clock_timestamp()
 OR (p->>'configuredSpaceId',p->>'configuredRegionId') IS DISTINCT FROM (prepared.payload->>'configuredSpaceId',prepared.payload->>'configuredRegionId')
 OR prepared.payload->'scopes' IS DISTINCT FROM whaleu_community.home_policy_scope_snapshot(a.definition)
 OR (p->'sourceReviewPolicyId'='null'::jsonb AND p->'explicitReviewPolicyId'='null'::jsonb) THEN RETURN false;END IF;
 IF p->'sourceReviewPolicyId'<>'null'::jsonb AND (p->>'sourceReviewPolicyId' IS DISTINCT FROM prepared.payload->>'sourceReviewPolicyId'
  OR whaleu_community.home_review_policy_current((p->>'sourceReviewPolicyId')::uuid,'local-text-source-v1') IS DISTINCT FROM true
  OR NOT EXISTS(SELECT 1 FROM whaleu_community.content_approval_policies WHERE id=(p->>'sourceReviewPolicyId')::uuid AND issuer=p->>'operator')) THEN RETURN false;END IF;
 IF p->'explicitReviewPolicyId'<>'null'::jsonb AND whaleu_community.home_review_policy_current((p->>'explicitReviewPolicyId')::uuid,'local-explicit-v1') IS DISTINCT FROM true THEN RETURN false;END IF;
 FOR m IN SELECT value FROM jsonb_array_elements(a.definition->'scopeMappings') LOOP
  IF (m->>'targetWaterSpaceId',m->>'targetRegionId') IS DISTINCT FROM (p->>'configuredSpaceId',p->>'configuredRegionId') THEN RETURN false;END IF;
 END LOOP;RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;END$$;

CREATE FUNCTION whaleu_community.home_publication_preparation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p jsonb:=NEW.payload;h whaleu_community.home_publication_head;field text;BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('whaleu:named-block-policy:v1',0));
 PERFORM pg_advisory_xact_lock(hashtextextended('whaleu:home-admission:v1',0));
 SELECT * INTO h FROM whaleu_community.home_publication_head WHERE slot=1 FOR UPDATE;
 IF whaleu_community.related_sync_exact_keys(p,ARRAY['previousRevision','previousId','admissionId','admissionRevision','admissionDigest','catalogRevision','catalogDigest','sourceReviewPolicyId','explicitReviewPolicyId','configuredSpaceId','configuredRegionId','operator','databaseActor','evidenceRef','preparationId','issuedAt','expiresAt','validUntil']) IS DISTINCT FROM true
 OR p->'previousRevision' IS DISTINCT FROM to_jsonb(coalesce(h.revision,0)) OR p->'previousId' IS DISTINCT FROM coalesce(to_jsonb(h.activation_id),'null'::jsonb)
 OR p->>'preparationId' IS DISTINCT FROM NEW.id::text OR p->>'databaseActor' IS DISTINCT FROM current_user
 OR p->>'operator' IS NULL OR p->>'operator' NOT LIKE 'manual:%' OR length(p->>'operator')>200
 OR jsonb_typeof(p->'evidenceRef') IS DISTINCT FROM 'string' OR length(p->>'evidenceRef') NOT BETWEEN 1 AND 1000 OR whaleu_profile.moderation_trim(p->>'evidenceRef') IS DISTINCT FROM p->>'evidenceRef' OR p->>'evidenceRef' ~ U&'[\0001-\001F\007F-\009F]'
 OR NEW.issued_at IS DISTINCT FROM date_trunc('milliseconds',statement_timestamp()) OR NEW.publication_transaction IS DISTINCT FROM pg_current_xact_id()
 OR p->>'issuedAt' IS DISTINCT FROM to_char(NEW.issued_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
 OR p->>'expiresAt' IS DISTINCT FROM to_char(NEW.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
 OR p->>'validUntil' IS DISTINCT FROM to_char(NEW.valid_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') THEN RAISE EXCEPTION 'Exact Home publication preparation required' USING ERRCODE='23514';END IF;
 FOREACH field IN ARRAY ARRAY['admissionId','configuredSpaceId','configuredRegionId'] LOOP
  IF whaleu_community.related_sync_uuid(p->field) IS DISTINCT FROM true THEN RAISE EXCEPTION 'Canonical activation identity required' USING ERRCODE='23514';END IF;
 END LOOP;
 FOREACH field IN ARRAY ARRAY['sourceReviewPolicyId','explicitReviewPolicyId'] LOOP
  IF whaleu_community.rating_scoped_nullable_id(p->field) IS DISTINCT FROM true THEN RAISE EXCEPTION 'Canonical Review configuration required' USING ERRCODE='23514';END IF;
 END LOOP;
 IF jsonb_typeof(p->'admissionRevision') IS DISTINCT FROM 'number' OR p->'catalogRevision' IS DISTINCT FROM '1'::jsonb OR whaleu_community.home_activation_payload_current(p) IS DISTINCT FROM true THEN RAISE EXCEPTION 'Current exact Home readiness required' USING ERRCODE='23514';END IF;
 RETURN NEW;
END$$;
CREATE TRIGGER home_publication_preparation_guard BEFORE INSERT ON whaleu_community.home_publication_preparations FOR EACH ROW EXECUTE FUNCTION whaleu_community.home_publication_preparation_guard();
CREATE FUNCTION whaleu_community.home_publication_activation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE h whaleu_community.home_publication_head;a whaleu_community.home_publication_activations;p whaleu_community.home_publication_preparations;BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('whaleu:named-block-policy:v1',0));
 PERFORM pg_advisory_xact_lock(hashtextextended('whaleu:home-admission:v1',0));
 SELECT * INTO h FROM whaleu_community.home_publication_head WHERE slot=1 FOR UPDATE;
 IF TG_TABLE_NAME='home_publication_activations' THEN
  SELECT * INTO p FROM whaleu_community.home_publication_preparations WHERE id=NEW.preparation_id FOR SHARE;
  IF p.id IS NULL OR p.issued_at>clock_timestamp() OR p.expires_at<=clock_timestamp() OR p.valid_until IS DISTINCT FROM NEW.valid_until
   OR NEW.revision<>coalesce(h.revision,0)+1 OR NEW.previous_id IS DISTINCT FROM h.activation_id OR NEW.publication_transaction IS DISTINCT FROM pg_current_xact_id()
   OR NEW.accepted_at IS DISTINCT FROM statement_timestamp() OR NEW.database_actor IS DISTINCT FROM current_user
   OR p.payload->'previousRevision' IS DISTINCT FROM to_jsonb(NEW.revision-1) OR p.payload->'previousId' IS DISTINCT FROM coalesce(to_jsonb(NEW.previous_id),'null'::jsonb)
   OR (p.payload->>'admissionId',p.payload->>'admissionRevision',p.payload->>'admissionDigest',p.payload->>'catalogRevision',p.payload->>'catalogDigest') IS DISTINCT FROM (NEW.admission_id::text,NEW.admission_revision::text,NEW.admission_digest,NEW.catalog_revision::text,NEW.catalog_digest)
   OR (p.payload->>'sourceReviewPolicyId',p.payload->>'explicitReviewPolicyId',p.payload->>'configuredSpaceId',p.payload->>'configuredRegionId',p.payload->>'operator',p.payload->>'databaseActor',p.payload->>'evidenceRef') IS DISTINCT FROM (NEW.source_review_policy_id::text,NEW.explicit_review_policy_id::text,NEW.configured_space_id::text,NEW.configured_region_id::text,NEW.operator_ref,NEW.database_actor,NEW.evidence_ref)
   OR whaleu_community.home_activation_payload_current(p.payload) IS DISTINCT FROM true THEN RAISE EXCEPTION 'Exact fresh Home publication activation required' USING ERRCODE='23514';END IF;
 ELSE
  SELECT * INTO a FROM whaleu_community.home_publication_activations WHERE id=NEW.activation_id;
  IF NEW.revision<>coalesce(h.revision,0)+1 OR a.revision IS DISTINCT FROM NEW.revision OR a.previous_id IS DISTINCT FROM h.activation_id OR a.publication_transaction IS DISTINCT FROM pg_current_xact_id() OR a.valid_until<=clock_timestamp() THEN RAISE EXCEPTION 'Exact fresh activation head required' USING ERRCODE='23514';END IF;
 END IF;RETURN NEW;
END$$;
CREATE TRIGGER home_publication_activation_guard BEFORE INSERT ON whaleu_community.home_publication_activations FOR EACH ROW EXECUTE FUNCTION whaleu_community.home_publication_activation_guard();
CREATE TRIGGER home_publication_head_guard BEFORE INSERT OR UPDATE ON whaleu_community.home_publication_head FOR EACH ROW EXECUTE FUNCTION whaleu_community.home_publication_activation_guard();
CREATE FUNCTION whaleu_community.home_publication_activation_complete() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF NOT EXISTS(SELECT 1 FROM whaleu_community.home_publication_head WHERE slot=1 AND revision>=NEW.revision) THEN RAISE EXCEPTION 'Activation must atomically advance head' USING ERRCODE='23514';END IF;RETURN NULL;
END$$;
CREATE CONSTRAINT TRIGGER home_publication_activation_complete AFTER INSERT ON whaleu_community.home_publication_activations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community.home_publication_activation_complete();

CREATE FUNCTION whaleu_community.home_publication_current() RETURNS jsonb LANGUAGE plpgsql VOLATILE AS $$
DECLARE a whaleu_community.home_publication_activations;ad whaleu_community.home_policy_admissions;p whaleu_community.home_publication_preparations;BEGIN
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('whaleu:named-block-policy:v1',0));
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('whaleu:home-admission:v1',0));
 IF NOT EXISTS(SELECT 1 FROM whaleu_community.home_publication_head WHERE slot=1) THEN RETURN NULL;END IF;
 SELECT n.* INTO a FROM whaleu_community.home_publication_head h JOIN whaleu_community.home_publication_activations n ON (n.id,n.revision)=(h.activation_id,h.revision) WHERE h.slot=1 FOR SHARE OF h,n;
 SELECT * INTO p FROM whaleu_community.home_publication_preparations WHERE id=a.preparation_id;
 IF a.id IS NULL OR a.accepted_at>clock_timestamp() OR a.valid_until<=clock_timestamp() OR whaleu_community.home_activation_payload_current(p.payload) IS DISTINCT FROM true THEN RAISE EXCEPTION 'Configured Home publication authority unavailable' USING ERRCODE='23514';END IF;
 SELECT * INTO ad FROM whaleu_community.home_policy_admissions WHERE id=a.admission_id;
 RETURN jsonb_build_object('activationId',a.id,'admission',jsonb_build_object('id',ad.id,'revision',ad.revision,'digest',ad.digest,'sourceCommit',ad.source_commit,'validUntil',to_char(ad.valid_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),'validUntil',to_char(a.valid_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
END$$;

CREATE FUNCTION whaleu_community.home_publication_fence() RETURNS void LANGUAGE plpgsql AS $$BEGIN
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('whaleu:named-block-policy:v1',0));
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('whaleu:home-admission:v1',0));
 PERFORM whaleu_community.text_source_fence();
 LOCK TABLE whaleu_community.home_policy_preparations,whaleu_community.home_policy_admissions,whaleu_community.home_policy_head,
 whaleu_community.home_publication_preparations,whaleu_community.home_publication_activations,whaleu_community.home_publication_head,
 whaleu_community.home_post_dispositions,whaleu_community.home_discussion_parent_bindings,
 whaleu_identity.accounts,whaleu_campus.operating_regions,whaleu_community.posts,whaleu_community.root_comments,whaleu_community.replies,whaleu_community.spaces,
 whaleu_community.community_text_sources,whaleu_community.content_approval_bindings,whaleu_community.content_approval_decisions,whaleu_community.content_approval_events,
 whaleu_community.post_owner_visibility,whaleu_community.post_category_heads,whaleu_community.post_images,whaleu_community.comment_images,whaleu_community.reply_images,
 whaleu_community.polls,whaleu_community.formations,whaleu_media.bindings,whaleu_media.assets,whaleu_media.upload_intents,whaleu_media.asset_safety_heads,whaleu_media.asset_safety_events IN SHARE MODE NOWAIT;
END$$;

-- Reconstruct every reviewed field from actual immutable publication owners.
-- scope alone is an accepted publication-time snapshot. A missing source row
-- yields NULL for an expected source, never a relabelled legacyPlain envelope.
CREATE FUNCTION whaleu_community.home_definition(kind text,target uuid,scope jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE p whaleu_community.posts;c jsonb;creation xid8;relation text;h whaleu_community.home_post_dispositions;parent whaleu_community.home_discussion_parent_bindings;
 s whaleu_community.community_text_sources;d whaleu_community.content_approval_decisions;descriptor jsonb:='null'::jsonb;images jsonb;ordered boolean;e jsonb;BEGIN
 IF kind IS NULL OR kind NOT IN ('post','comment','reply') THEN RETURN NULL;END IF;
 relation:=CASE kind WHEN 'post' THEN 'posts' WHEN 'comment' THEN 'root_comments' ELSE 'replies' END;
 EXECUTE format('SELECT to_jsonb(n),%I FROM whaleu_community.%I n WHERE id=$1',CASE kind WHEN 'post' THEN 'publication_transaction' ELSE 'approval_publication_transaction' END,relation) INTO c,creation USING target;
 SELECT * INTO p FROM whaleu_community.posts WHERE id=CASE kind WHEN 'post' THEN target ELSE (c->>'post_id')::uuid END;
 SELECT * INTO h FROM whaleu_community.home_post_dispositions WHERE post_id=p.id;
 IF c IS NULL OR p.id IS NULL OR h.post_id IS NULL OR p.publication_state<>'published' OR p.publication_envelope_version<>7 OR p.feedback IS NOT NULL
 OR h.publication_transaction IS DISTINCT FROM p.publication_transaction
 OR EXISTS(SELECT 1 FROM whaleu_community.post_distribution_bindings WHERE post_id=p.id)
 OR EXISTS(SELECT 1 FROM whaleu_community.polls WHERE post_id=p.id) OR EXISTS(SELECT 1 FROM whaleu_community.formations WHERE post_id=p.id)
 OR EXISTS(SELECT 1 FROM whaleu_community.trading_listings WHERE post_id=p.id) OR EXISTS(SELECT 1 FROM whaleu_community.post_rating_target_links WHERE post_id=p.id) THEN RETURN NULL;END IF;
 IF kind='post' THEN SELECT * INTO d FROM whaleu_community.content_approval_decisions WHERE id=h.decision_id;
 ELSE
  SELECT * INTO parent FROM whaleu_community.home_discussion_parent_bindings WHERE content_kind=kind AND content_id=target;
  IF parent.content_id IS NULL OR parent.publication_transaction IS DISTINCT FROM creation OR (parent.post_id,parent.parent_decision_id,parent.parent_digest) IS DISTINCT FROM (p.id,h.decision_id,h.digest) THEN RETURN NULL;END IF;
  SELECT * INTO d FROM whaleu_community.content_approval_decisions WHERE id=parent.decision_id;
 END IF;
 SELECT * INTO s FROM whaleu_community.community_text_sources WHERE content_kind=kind AND content_id=target;
 IF s.content_id IS NOT NULL THEN
  IF (s.account_id::text,s.decision_id,s.approval_digest,s.publication_transaction) IS DISTINCT FROM (c->>'account_id',d.id,d.digest,creation)
   OR s.source_hash IS DISTINCT FROM whaleu_community.text_source_hash(s.source_format,c->>'text') THEN RETURN NULL;END IF;
  descriptor:=jsonb_build_object('version',s.source_version,'format',s.source_format,'sourceHash',s.source_hash);
  IF s.source_format='plain' THEN descriptor:=descriptor||jsonb_build_object('readingFormatting',s.reading_formatting);END IF;
 END IF;
 IF d.id IS NULL OR descriptor IS DISTINCT FROM d.envelope->'textSource' THEN RETURN NULL;END IF;
 EXECUTE format('SELECT coalesce(jsonb_agg(jsonb_build_object(''assetId'',asset_id,''digest'',digest) ORDER BY position),''[]''::jsonb),coalesce(bool_and(position=expected),true) FROM (SELECT *,row_number() OVER(ORDER BY position)-1 expected FROM whaleu_community.%I WHERE %I=$1) ordered',kind||'_images',kind||'_id') INTO images,ordered USING target;
 IF ordered IS DISTINCT FROM true THEN RETURN NULL;END IF;
 e:=jsonb_build_object('version',CASE kind WHEN 'post' THEN 7 ELSE 8 END,'accountId',c->'account_id','purpose','publish_'||kind,'spaceId',p.space_id,'category',p.category,'authorMode',c->>'author_mode','commentsPolicy',p.comments_policy,
  'postId',CASE kind WHEN 'post' THEN NULL ELSE p.id END,'rootCommentId',CASE kind WHEN 'reply' THEN c->'root_comment_id' ELSE 'null'::jsonb END,'targetReplyId',CASE kind WHEN 'reply' THEN c->'target_reply_id' ELSE 'null'::jsonb END,
  'text',c->>'text','images',images,'component',jsonb_build_object('kind','none'),'trading',NULL,'scope',scope,'allowAnonymousDm',CASE kind WHEN 'post' THEN p.allow_anonymous_dm ELSE NULL END,'textSource',descriptor);
 IF kind='post' THEN e:=e||jsonb_build_object('home',h.evidence);
 ELSE e:=e||jsonb_build_object('homeParent',jsonb_build_object('postId',parent.post_id,'decisionId',parent.parent_decision_id,'digest',parent.parent_digest));END IF;
 RETURN CASE WHEN whaleu_community.home_envelope_valid(e) IS TRUE THEN e ELSE NULL END;
EXCEPTION WHEN OTHERS THEN RETURN NULL;END$$;

CREATE FUNCTION whaleu_community.home_review_current(decision uuid,consume boolean DEFAULT false) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT coalesce((SELECT d.envelope_version IN (7,8) AND whaleu_community.home_envelope_valid(d.envelope) AND d.result='allow' AND d.coverage='complete' AND d.provenance='accepted'
 AND p.policy_key=CASE WHEN d.envelope->'textSource'='null'::jsonb THEN 'local-explicit-v1' ELSE 'local-text-source-v1' END AND p.version=1 AND p.coverage='complete' AND p.provenance='accepted'
 AND d.digest=encode(sha256(convert_to('whaleu-content-approval:v'||d.envelope_version::text||chr(10)||whaleu_community.content_canonical_json(d.envelope),'UTF8')),'hex')
 AND length(whaleu_profile.moderation_trim(p.issuer))>0 AND length(whaleu_profile.moderation_trim(p.provenance_ref))>0 AND length(whaleu_profile.moderation_trim(d.issuer))>0 AND length(whaleu_profile.moderation_trim(d.provenance_ref))>0
 AND length(whaleu_profile.moderation_trim(e.issuer))>0 AND length(whaleu_profile.moderation_trim(e.provenance_ref))>0
 AND e.state='allow' AND e.coverage='complete' AND e.provenance='accepted' AND isfinite(p.valid_from) AND isfinite(d.evaluated_at) AND isfinite(e.occurred_at) AND isfinite(d.consume_until)
 AND (NOT consume OR d.id=(SELECT latest.id FROM whaleu_community.content_approval_decisions latest
  WHERE (latest.account_id,latest.operation,latest.envelope_version,latest.digest)=(d.account_id,d.operation,d.envelope_version,d.digest)
  ORDER BY latest.evaluated_at DESC,latest.id DESC LIMIT 1))
 AND (d.visibility_until IS NULL OR isfinite(d.visibility_until)) AND (p.valid_until IS NULL OR isfinite(p.valid_until)) AND p.valid_from<=d.evaluated_at AND d.evaluated_at<=clock_timestamp() AND e.occurred_at>=d.evaluated_at AND e.occurred_at<=clock_timestamp()
 AND (p.valid_until IS NULL OR p.valid_until>clock_timestamp()) AND (d.visibility_until IS NULL OR d.visibility_until>clock_timestamp()) AND (NOT consume OR d.consume_until>clock_timestamp())
 FROM whaleu_community.content_approval_decisions d JOIN whaleu_community.content_approval_policies p ON p.id=d.policy_revision_id JOIN whaleu_community.content_approval_heads h ON h.decision_id=d.id JOIN whaleu_community.content_approval_events e ON e.id=h.event_id AND e.decision_id=d.id WHERE d.id=decision),false)
$$;

CREATE FUNCTION whaleu_community.home_parent_current(value jsonb) RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
DECLARE actor uuid:=(value->>'accountId')::uuid;p whaleu_community.posts;n record;b whaleu_community.content_approval_bindings;d whaleu_community.content_approval_decisions;expected integer;BEGIN
 IF value->>'version' IS DISTINCT FROM '8' THEN RETURN false;END IF;
 SELECT * INTO p FROM whaleu_community.posts WHERE id=(value->>'postId')::uuid;
 IF p.id IS NULL OR p.publication_state<>'published' OR p.publication_envelope_version<>7 OR p.space_id::text IS DISTINCT FROM value->>'spaceId'
 OR p.category IS DISTINCT FROM value->>'category' OR p.comments_policy IS DISTINCT FROM value->>'commentsPolicy'
 OR EXISTS(SELECT 1 FROM whaleu_community.post_owner_visibility WHERE post_id=p.id AND owner_hidden)
 OR EXISTS(SELECT 1 FROM whaleu_community.post_category_heads WHERE post_id=p.id)
 OR (p.author_mode='anonymous' AND actor=p.account_id AND value->>'authorMode'<>'anonymous') THEN RETURN false;END IF;
 expected:=CASE WHEN value->>'purpose'='publish_comment' THEN 1 WHEN value->'targetReplyId'='null'::jsonb THEN 2 ELSE 3 END;
 FOR n IN SELECT 'post' kind,id,account_id,author_mode,visibility,deleted_at FROM whaleu_community.posts WHERE id=p.id
 UNION ALL SELECT 'comment',id,account_id,author_mode,visibility,deleted_at FROM whaleu_community.root_comments WHERE id=(value->>'rootCommentId')::uuid AND post_id=p.id
 UNION ALL SELECT 'reply',id,account_id,author_mode,visibility,deleted_at FROM whaleu_community.replies WHERE id=(value->>'targetReplyId')::uuid AND post_id=p.id AND root_comment_id=(value->>'rootCommentId')::uuid
 LOOP
  expected:=expected-1;
  SELECT * INTO b FROM whaleu_community.content_approval_bindings WHERE content_kind=n.kind AND content_id=n.id AND content_version=1;
  SELECT * INTO d FROM whaleu_community.content_approval_decisions WHERE id=b.decision_id;
  IF n.visibility<>'approved' OR n.deleted_at IS NOT NULL OR b.content_id IS NULL OR b.envelope_version IS DISTINCT FROM (CASE n.kind WHEN 'post' THEN 7 ELSE 8 END)
   OR (b.account_id,b.operation,b.envelope_version,b.digest,b.envelope,b.scope) IS DISTINCT FROM (n.account_id,'publish_'||n.kind,d.envelope_version,d.digest,d.envelope,d.envelope->'scope')
   OR b.envelope IS DISTINCT FROM whaleu_community.home_definition(n.kind,n.id,b.scope)
   OR whaleu_community.home_review_current(b.decision_id) IS DISTINCT FROM true
   OR whaleu_community.profile_moderation_media_current(n.kind,n.id,b.envelope->'images') IS DISTINCT FROM true
   OR NOT EXISTS(SELECT 1 FROM whaleu_identity.accounts WHERE id=n.account_id AND status='active' AND lifecycle='active')
   OR (n.kind='post' AND value->'homeParent' IS DISTINCT FROM jsonb_build_object('postId',n.id,'decisionId',b.decision_id,'digest',b.digest))
   OR (n.kind<>'post' AND b.envelope->'homeParent' IS DISTINCT FROM value->'homeParent')
   OR NOT EXISTS(SELECT 1 FROM whaleu_community.report_origins o JOIN whaleu_community.publication_requests q ON (q.account_id,q.client_request_id)=(o.owner_account_id,o.source_request_id)
    WHERE o.kind=n.kind AND o.target_id=n.id AND o.owner_account_id=n.account_id AND o.provenance='native_publication'
    AND q.operation='publish_'||n.kind AND q.receipt->>'operation'=q.operation AND q.receipt->>'requestId'=q.client_request_id::text AND q.receipt->>'outcome'='created' AND q.receipt->>'resourceId'=n.id::text) THEN RETURN false;END IF;
  IF n.author_mode='named' AND n.account_id<>actor AND (NOT EXISTS(SELECT 1 FROM whaleu_safety.account_heads h WHERE h.account_id=n.account_id AND h.block_coverage='complete' AND h.provenance='native_account_creation' AND (h.valid_until IS NULL OR h.valid_until>clock_timestamp()))
   OR EXISTS(SELECT 1 FROM whaleu_safety.blocks WHERE active AND ((blocker_id=actor AND blocked_id=n.account_id) OR (blocker_id=n.account_id AND blocked_id=actor)))) THEN RETURN false;END IF;
 END LOOP;RETURN expected=0;
EXCEPTION WHEN OTHERS THEN RETURN false;END$$;

-- Pre-Review callable: no request, queue, decision or publication is invented.
CREATE FUNCTION whaleu_community.home_review_admitted(e jsonb) RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
DECLARE active jsonb;a whaleu_community.home_publication_activations;ad whaleu_community.home_policy_admissions;h jsonb:=e->'home';i jsonb:=h->'requestedIntent';scope jsonb;source whaleu_community.spaces;matches integer;root_mode text;authorization_category text;BEGIN
 IF whaleu_community.home_envelope_valid(e) IS DISTINCT FROM true THEN RETURN false;END IF;
 PERFORM whaleu_community.home_publication_fence();active:=whaleu_community.home_publication_current();
 IF active IS NULL THEN RETURN false;END IF;
 SELECT * INTO a FROM whaleu_community.home_publication_activations WHERE id=(active->>'activationId')::uuid;
 IF (e->'textSource'='null'::jsonb AND a.explicit_review_policy_id IS NULL) OR (e->'textSource'<>'null'::jsonb AND a.source_review_policy_id IS NULL) THEN RETURN false;END IF;
 IF NOT EXISTS(SELECT 1 FROM whaleu_identity.accounts WHERE id=(e->>'accountId')::uuid AND status='active' AND lifecycle='active') THEN RETURN false;END IF;
 IF e->>'commentsPolicy'='restricted' AND (e->>'version'='7' OR NOT EXISTS(SELECT 1 FROM whaleu_community.posts WHERE id=(e->>'postId')::uuid AND account_id=(e->>'accountId')::uuid))
  AND NOT EXISTS(SELECT 1 FROM whaleu_authorization.role_grants g WHERE whaleu_profile.moderation_grant_allowed((e->>'accountId')::uuid,g.id,(e->'scope'->>'originalRegionId')::uuid)) THEN RETURN false;END IF;
 IF e->>'version'='7' THEN
  authorization_category:=i->>'category';
  IF h->'admission' IS DISTINCT FROM active->'admission' THEN RETURN false;END IF;
  SELECT * INTO ad FROM whaleu_community.home_policy_admissions WHERE id=a.admission_id;
  SELECT * INTO source FROM whaleu_community.spaces WHERE id=(i->>'spaceId')::uuid AND is_active;
  IF source.id IS NULL OR source.operating_region_id::text IS DISTINCT FROM h->>'requestedRegionId' OR NOT(ad.definition->'authorModes' @> jsonb_build_array(i->>'authorMode'))
   OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(ad.definition->'categoryMappings') mapping WHERE mapping->>'nativeCategory'=i->>'category' AND mapping->>'sourceKind'=source.kind AND mapping->'legacyChoose'=h->'legacyChoose') THEN RETURN false;END IF;
  SELECT count(*) INTO matches FROM jsonb_array_elements(ad.definition->'scopeMappings') mapping
   WHERE mapping->>'sourceSpaceId'=source.id::text AND mapping->>'sourceKind'=source.kind AND mapping->>'sourceRegionId' IS NOT DISTINCT FROM source.operating_region_id::text
   AND (source.kind='regional' OR (e->'scope'->>'authorOriginRegionId' IS NOT NULL AND mapping->>'targetRegionId'=e->'scope'->>'authorOriginRegionId'))
   AND mapping->'targetWaterSpaceId'=h->'targetWaterSpaceId' AND mapping->'targetRegionId'=h->'targetWaterRegionId';
  IF matches<>1 THEN RETURN false;END IF;
  scope:=(e->'scope')||jsonb_build_object('originalSpaceId',source.id,'originalRegionId',source.operating_region_id);
  IF whaleu_community.text_source_destination_current((e->>'accountId')::uuid,scope,i->>'authorMode',i->>'category','publish_post',NULL) IS DISTINCT FROM true THEN RETURN false;END IF;
 ELSE
  IF whaleu_community.home_parent_current(e) IS DISTINCT FROM true THEN RETURN false;END IF;
  SELECT author_mode INTO root_mode FROM whaleu_community.posts WHERE id=(e->>'postId')::uuid;
  SELECT evidence->'requestedIntent'->>'category' INTO authorization_category FROM whaleu_community.home_post_dispositions WHERE post_id=(e->>'postId')::uuid;
 END IF;
 -- Water is server classification, not a new client publication permission.
 RETURN whaleu_community.text_source_destination_current((e->>'accountId')::uuid,e->'scope',e->>'authorMode',authorization_category,e->>'purpose',root_mode) IS TRUE;
EXCEPTION WHEN OTHERS THEN RETURN false;END$$;

CREATE FUNCTION whaleu_community.home_intent_matches(e jsonb,intent text) RETURNS boolean LANGUAGE plpgsql STABLE AS $$BEGIN
 IF intent=whaleu_community.home_intent_hash(e,e->>'authorMode') THEN RETURN true;END IF;
 RETURN coalesce(e->>'version'='8' AND e->>'authorMode'='anonymous' AND intent=whaleu_community.home_intent_hash(e,'named')
  AND EXISTS(SELECT 1 FROM whaleu_community.posts WHERE id=(e->>'postId')::uuid AND account_id=(e->>'accountId')::uuid AND author_mode='anonymous'),false);
EXCEPTION WHEN OTHERS THEN RETURN false;END$$;
CREATE FUNCTION whaleu_community.home_review_assert(e jsonb,intent text DEFAULT NULL,policy uuid DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $$
DECLARE a whaleu_community.home_publication_activations;BEGIN
 IF e->>'version' IS NULL OR e->>'version' NOT IN ('7','8') THEN RETURN;END IF;
 IF whaleu_community.home_review_admitted(e) IS DISTINCT FROM true THEN RAISE EXCEPTION 'Current Home Review authority unavailable' USING ERRCODE='23514',CONSTRAINT='home_publication_causal';END IF;
 IF intent IS NOT NULL AND whaleu_community.home_intent_matches(e,intent) IS DISTINCT FROM true THEN RAISE EXCEPTION 'Home Review original request mismatch' USING ERRCODE='23514',CONSTRAINT='home_publication_causal';END IF;
 IF policy IS NOT NULL THEN
  SELECT n.* INTO a FROM whaleu_community.home_publication_head h JOIN whaleu_community.home_publication_activations n ON (n.id,n.revision)=(h.activation_id,h.revision) WHERE h.slot=1;
  IF policy IS DISTINCT FROM (CASE WHEN e->'textSource'='null'::jsonb THEN a.explicit_review_policy_id ELSE a.source_review_policy_id END) THEN RAISE EXCEPTION 'Exact activated Review policy required' USING ERRCODE='23514',CONSTRAINT='home_publication_causal';END IF;
 END IF;
END$$;

-- First phase does not pretend a receipt, optional source or binding exists.
-- It validates all already-present facts and retains the current authority fence.
CREATE FUNCTION whaleu_community.home_publication_authority(kind text,target uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE d whaleu_community.content_approval_decisions;h whaleu_community.home_post_dispositions;parent whaleu_community.home_discussion_parent_bindings;
 c jsonb;p whaleu_community.posts;creation xid8;publication xid8;relation text;e jsonb;images jsonb;ordered boolean;BEGIN
 IF kind='post' THEN
  SELECT * INTO h FROM whaleu_community.home_post_dispositions WHERE post_id=target;publication:=h.publication_transaction;
  SELECT * INTO d FROM whaleu_community.content_approval_decisions WHERE id=h.decision_id;
 ELSE
  SELECT * INTO parent FROM whaleu_community.home_discussion_parent_bindings WHERE content_kind=kind AND content_id=target;publication:=parent.publication_transaction;
  SELECT * INTO d FROM whaleu_community.content_approval_decisions WHERE id=parent.decision_id;
 END IF;
 IF publication IS NULL OR publication<>pg_current_xact_id() THEN RETURN;END IF;
 IF kind IS NULL OR kind NOT IN ('post','comment','reply') THEN RAISE EXCEPTION 'Invalid Home publication identity' USING ERRCODE='23514';END IF;
 relation:=CASE kind WHEN 'post' THEN 'posts' WHEN 'comment' THEN 'root_comments' ELSE 'replies' END;
 EXECUTE format('SELECT to_jsonb(n),%I FROM whaleu_community.%I n WHERE id=$1',CASE kind WHEN 'post' THEN 'publication_transaction' ELSE 'approval_publication_transaction' END,relation) INTO c,creation USING target;
 SELECT * INTO p FROM whaleu_community.posts WHERE id=CASE kind WHEN 'post' THEN target ELSE (c->>'post_id')::uuid END;
 e:=d.envelope;
 IF d.id IS NULL OR c IS NULL OR p.id IS NULL OR creation IS DISTINCT FROM publication OR p.publication_state<>'published' OR p.publication_envelope_version<>7 OR p.feedback IS NOT NULL
 OR d.operation IS DISTINCT FROM 'publish_'||kind OR d.envelope_version IS DISTINCT FROM (CASE kind WHEN 'post' THEN 7 ELSE 8 END)
 OR (c->>'account_id',c->>'text',c->>'author_mode',p.space_id::text,p.category,p.comments_policy) IS DISTINCT FROM (d.account_id::text,e->>'text',e->>'authorMode',e->>'spaceId',e->>'category',e->>'commentsPolicy')
 OR (kind='post' AND (h.digest IS DISTINCT FROM d.digest OR h.evidence IS DISTINCT FROM e->'home' OR coalesce(to_jsonb(p.allow_anonymous_dm),'null'::jsonb) IS DISTINCT FROM e->'allowAnonymousDm'))
 OR (kind<>'post' AND (parent.digest IS DISTINCT FROM d.digest OR parent.post_id IS DISTINCT FROM p.id OR e->'homeParent' IS DISTINCT FROM jsonb_build_object('postId',parent.post_id,'decisionId',parent.parent_decision_id,'digest',parent.parent_digest)))
 OR (kind='reply' AND (c->'root_comment_id',c->'target_reply_id') IS DISTINCT FROM (e->'rootCommentId',e->'targetReplyId'))
 OR EXISTS(SELECT 1 FROM whaleu_community.post_distribution_bindings WHERE post_id=p.id)
 OR EXISTS(SELECT 1 FROM whaleu_community.polls WHERE post_id=p.id) OR EXISTS(SELECT 1 FROM whaleu_community.formations WHERE post_id=p.id)
 OR EXISTS(SELECT 1 FROM whaleu_community.trading_listings WHERE post_id=p.id) OR EXISTS(SELECT 1 FROM whaleu_community.post_rating_target_links WHERE post_id=p.id)
 OR EXISTS(SELECT 1 FROM whaleu_community.post_category_heads WHERE post_id=p.id)
 OR whaleu_community.home_review_current(d.id,true) IS DISTINCT FROM true THEN RAISE EXCEPTION 'Exact fresh Home publication authority required' USING ERRCODE='23514',CONSTRAINT='home_publication_causal';END IF;
 EXECUTE format('SELECT coalesce(jsonb_agg(jsonb_build_object(''assetId'',asset_id,''digest'',digest) ORDER BY position),''[]''::jsonb),coalesce(bool_and(position=expected),true) FROM (SELECT *,row_number() OVER(ORDER BY position)-1 expected FROM whaleu_community.%I WHERE %I=$1) ordered',kind||'_images',kind||'_id') INTO images,ordered USING target;
 IF ordered IS DISTINCT FROM true OR images IS DISTINCT FROM e->'images' OR whaleu_community.profile_moderation_media_current(kind,target,images) IS DISTINCT FROM true THEN RAISE EXCEPTION 'Home publication Media mismatch' USING ERRCODE='23514',CONSTRAINT='home_publication_causal';END IF;
 PERFORM whaleu_community.home_review_assert(e,NULL,d.policy_revision_id);
 IF EXISTS(SELECT 1 FROM whaleu_community.community_text_sources WHERE content_kind=kind AND content_id=target) AND e IS DISTINCT FROM whaleu_community.home_definition(kind,target,e->'scope') THEN RAISE EXCEPTION 'Actual Home source definition mismatch' USING ERRCODE='23514',CONSTRAINT='home_publication_causal';END IF;
 IF EXISTS(SELECT 1 FROM whaleu_community.text_review_requests q JOIN whaleu_community.publication_cancel_fences f USING(account_id,client_request_id) WHERE q.decision_id=d.id) THEN RAISE EXCEPTION 'Home Review cancelled' USING ERRCODE='23514',CONSTRAINT='home_publication_causal';END IF;
END$$;

CREATE FUNCTION whaleu_community.home_metadata_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c jsonb;creation xid8;relation text;kind text;target uuid;d whaleu_community.content_approval_decisions;BEGIN
 kind:=CASE TG_TABLE_NAME WHEN 'home_post_dispositions' THEN 'post' ELSE to_jsonb(NEW)->>'content_kind' END;
 target:=(to_jsonb(NEW)->>CASE TG_TABLE_NAME WHEN 'home_post_dispositions' THEN 'post_id' ELSE 'content_id' END)::uuid;
 relation:=CASE kind WHEN 'post' THEN 'posts' WHEN 'comment' THEN 'root_comments' ELSE 'replies' END;
 EXECUTE format('SELECT to_jsonb(n),%I FROM whaleu_community.%I n WHERE id=$1 FOR SHARE',CASE kind WHEN 'post' THEN 'publication_transaction' ELSE 'approval_publication_transaction' END,relation) INTO c,creation USING target;
 SELECT * INTO d FROM whaleu_community.content_approval_decisions WHERE id=NEW.decision_id;
 IF c IS NULL OR creation IS DISTINCT FROM pg_current_xact_id() OR NEW.publication_transaction IS DISTINCT FROM pg_current_xact_id()
 OR d.id IS NULL OR d.digest IS DISTINCT FROM NEW.digest OR d.envelope_version IS DISTINCT FROM (CASE kind WHEN 'post' THEN 7 ELSE 8 END)
 OR d.account_id::text IS DISTINCT FROM c->>'account_id' OR d.operation IS DISTINCT FROM 'publish_'||kind
 OR EXISTS(SELECT 1 FROM whaleu_community.content_approval_bindings WHERE content_kind=kind AND content_id=target)
 THEN RAISE EXCEPTION 'Home evidence requires fresh exact publication' USING ERRCODE='23514',CONSTRAINT='home_publication_causal';END IF;
 IF kind='post' THEN
  IF NEW.evidence IS DISTINCT FROM d.envelope->'home' THEN RAISE EXCEPTION 'Immutable original Home evidence mismatch' USING ERRCODE='23514';END IF;
 ELSE
  IF c->>'post_id' IS DISTINCT FROM NEW.post_id::text OR d.envelope->'homeParent' IS DISTINCT FROM jsonb_build_object('postId',NEW.post_id,'decisionId',NEW.parent_decision_id,'digest',NEW.parent_digest)
   OR whaleu_community.home_parent_current(d.envelope) IS DISTINCT FROM true THEN RAISE EXCEPTION 'Actual current V7 parent required' USING ERRCODE='23514';END IF;
 END IF;
 PERFORM whaleu_community.home_review_assert(d.envelope,NULL,d.policy_revision_id);RETURN NEW;
END$$;
CREATE TRIGGER home_metadata_insert_guard BEFORE INSERT ON whaleu_community.home_post_dispositions FOR EACH ROW EXECUTE FUNCTION whaleu_community.home_metadata_insert_guard();
CREATE TRIGGER home_metadata_insert_guard BEFORE INSERT ON whaleu_community.home_discussion_parent_bindings FOR EACH ROW EXECUTE FUNCTION whaleu_community.home_metadata_insert_guard();

CREATE FUNCTION whaleu_community.home_publication_assert(kind text,target uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE b whaleu_community.content_approval_bindings;d whaleu_community.content_approval_decisions;s whaleu_community.community_text_sources;
 q whaleu_community.publication_requests;e jsonb;h whaleu_community.home_post_dispositions;parent whaleu_community.home_discussion_parent_bindings;publication xid8;BEGIN
 SELECT * INTO b FROM whaleu_community.content_approval_bindings WHERE content_kind=kind AND content_id=target AND content_version=1;
 IF kind='post' THEN SELECT * INTO h FROM whaleu_community.home_post_dispositions WHERE post_id=target;publication:=h.publication_transaction;
 ELSE SELECT * INTO parent FROM whaleu_community.home_discussion_parent_bindings WHERE content_kind=kind AND content_id=target;publication:=parent.publication_transaction;END IF;
 IF publication IS NULL AND (b.envelope_version IS NULL OR b.envelope_version NOT IN (7,8))
 AND NOT(kind='post' AND EXISTS(SELECT 1 FROM whaleu_community.posts WHERE id=target AND publication_envelope_version=7))
 AND NOT(kind<>'post' AND EXISTS(SELECT 1 FROM whaleu_community.profile_moderation_nodes(kind,target) n JOIN whaleu_community.posts p ON p.id=n.post_id WHERE p.publication_envelope_version=7)) THEN RETURN;END IF;
 SELECT * INTO d FROM whaleu_community.content_approval_decisions WHERE id=b.decision_id;
 SELECT * INTO s FROM whaleu_community.community_text_sources WHERE content_kind=kind AND content_id=target;
 SELECT r.* INTO q FROM whaleu_community.report_origins o JOIN whaleu_community.publication_requests r ON (r.account_id,r.client_request_id)=(o.owner_account_id,o.source_request_id)
  WHERE o.kind=home_publication_assert.kind AND o.target_id=target AND o.owner_account_id=b.account_id AND o.provenance='native_publication';
 e:=whaleu_community.home_definition(kind,target,b.scope);
 IF publication IS NULL OR b.content_id IS NULL OR d.id IS NULL OR q.account_id IS NULL OR e IS NULL
 OR (b.account_id,b.operation,b.envelope_version,b.digest,b.envelope,b.scope) IS DISTINCT FROM (d.account_id,'publish_'||kind,CASE kind WHEN 'post' THEN 7 ELSE 8 END,d.digest,e,e->'scope')
 OR d.envelope IS DISTINCT FROM e OR d.operation IS DISTINCT FROM b.operation OR d.envelope_version IS DISTINCT FROM b.envelope_version
 OR (kind='post' AND (h.decision_id,h.digest) IS DISTINCT FROM (b.decision_id,b.digest))
 OR (kind<>'post' AND (parent.decision_id,parent.digest) IS DISTINCT FROM (b.decision_id,b.digest))
 OR q.operation IS DISTINCT FROM 'publish_'||kind OR whaleu_community.home_intent_matches(e,q.payload_hash) IS DISTINCT FROM true
 OR q.receipt->>'outcome' IS DISTINCT FROM 'created' OR q.receipt->>'resourceId' IS DISTINCT FROM target::text OR q.receipt->>'requestId' IS DISTINCT FROM q.client_request_id::text OR q.receipt->>'operation' IS DISTINCT FROM q.operation
 OR EXISTS(SELECT 1 FROM whaleu_community.publication_cancel_fences WHERE account_id=q.account_id AND client_request_id=q.client_request_id)
 OR NOT EXISTS(SELECT 1 FROM whaleu_community.outbox WHERE event_key=kind||':'||target::text||':created' AND event_type=kind||'_created' AND resource_id=target)
 OR ((e->'textSource'='null'::jsonb) IS DISTINCT FROM (s.content_id IS NULL))
 OR (s.content_id IS NOT NULL AND ((s.account_id,s.client_request_id,s.original_intent_hash,s.decision_id,s.approval_digest,s.publication_transaction) IS DISTINCT FROM (q.account_id,q.client_request_id,q.payload_hash,b.decision_id,b.digest,publication)
  OR s.original_intent_hash IS DISTINCT FROM whaleu_community.home_intent_hash(e,s.requested_author_mode)))
 THEN RAISE EXCEPTION 'Home publication causal completeness failed' USING ERRCODE='23514',CONSTRAINT='home_publication_causal';END IF;
 IF publication=pg_current_xact_id() THEN PERFORM whaleu_community.home_publication_authority(kind,target);END IF;
END$$;

CREATE FUNCTION whaleu_community.home_publication_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE kind text;target uuid;q whaleu_community.publication_requests;BEGIN
 IF TG_TABLE_NAME IN ('posts','home_post_dispositions') THEN kind:='post';target:=(to_jsonb(NEW)->>CASE TG_TABLE_NAME WHEN 'posts' THEN 'id' ELSE 'post_id' END)::uuid;
 ELSIF TG_TABLE_NAME='root_comments' THEN kind:='comment';target:=NEW.id;
 ELSIF TG_TABLE_NAME='replies' THEN kind:='reply';target:=NEW.id;
 ELSIF TG_TABLE_NAME='publication_requests' THEN
  SELECT * INTO q FROM whaleu_community.publication_requests WHERE account_id=NEW.account_id AND client_request_id=NEW.client_request_id;
  IF q.receipt->>'outcome' IS DISTINCT FROM 'created' THEN RETURN NULL;END IF;
  kind:=CASE q.operation WHEN 'publish_post' THEN 'post' WHEN 'publish_comment' THEN 'comment' WHEN 'publish_reply' THEN 'reply' END;target:=(q.receipt->>'resourceId')::uuid;
 ELSE kind:=NEW.content_kind;target:=NEW.content_id;END IF;
 PERFORM whaleu_community.home_publication_assert(kind,target);RETURN NULL;
END$$;
CREATE CONSTRAINT TRIGGER home_post_complete AFTER INSERT ON whaleu_community.posts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.publication_envelope_version=7) EXECUTE FUNCTION whaleu_community.home_publication_complete();
DO $$DECLARE relation text;BEGIN FOREACH relation IN ARRAY ARRAY['home_post_dispositions','home_discussion_parent_bindings','root_comments','replies','community_text_sources','content_approval_bindings'] LOOP
 EXECUTE format('CREATE CONSTRAINT TRIGGER home_publication_complete AFTER INSERT ON whaleu_community.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community.home_publication_complete()',relation);
END LOOP;END$$;

-- Point-ID historical proof for distribution candidates. Admission expiry/head
-- changes never turn a restricted publication into an unrestricted one. Review,
-- Safety and audience access remain separate current checks at the read owner.
CREATE FUNCTION whaleu_community.home_post_disposition_valid(postid uuid) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE p whaleu_community.posts;h whaleu_community.home_post_dispositions;b whaleu_community.content_approval_bindings;d whaleu_community.content_approval_decisions;
 a whaleu_community.home_policy_admissions;i jsonb;source_kind text;matches integer;BEGIN
 SELECT * INTO p FROM whaleu_community.posts WHERE id=postid;
 SELECT * INTO h FROM whaleu_community.home_post_dispositions WHERE post_id=postid;
 SELECT * INTO b FROM whaleu_community.content_approval_bindings WHERE content_kind='post' AND content_id=postid AND content_version=1;
 SELECT * INTO d FROM whaleu_community.content_approval_decisions WHERE id=h.decision_id;
 SELECT * INTO a FROM whaleu_community.home_policy_admissions WHERE id=(h.evidence->'admission'->>'id')::uuid;
 IF p.id IS NULL OR p.publication_envelope_version<>7 OR h.post_id IS NULL OR b.content_id IS NULL OR d.id IS NULL OR a.id IS NULL
 OR h.publication_transaction IS DISTINCT FROM p.publication_transaction
 OR (h.decision_id,h.digest) IS DISTINCT FROM (b.decision_id,b.digest)
 OR (b.account_id,b.operation,b.envelope_version,b.digest,b.envelope,b.scope) IS DISTINCT FROM (p.account_id,'publish_post',7,d.digest,d.envelope,d.envelope->'scope')
 OR d.account_id IS DISTINCT FROM p.account_id OR d.operation<>'publish_post' OR d.envelope_version<>7
 OR b.envelope->'home' IS DISTINCT FROM h.evidence OR whaleu_community.home_envelope_valid(b.envelope) IS DISTINCT FROM true
 OR (p.text,p.author_mode,p.space_id::text,p.category,p.comments_policy,coalesce(to_jsonb(p.allow_anonymous_dm),'null'::jsonb)) IS DISTINCT FROM (b.envelope->>'text',b.envelope->>'authorMode',b.envelope->>'spaceId',b.envelope->>'category',b.envelope->>'commentsPolicy',b.envelope->'allowAnonymousDm')
 OR d.digest IS DISTINCT FROM encode(sha256(convert_to('whaleu-content-approval:v7'||chr(10)||whaleu_community.content_canonical_json(d.envelope),'UTF8')),'hex')
 OR h.evidence->'admission' IS DISTINCT FROM jsonb_build_object('id',a.id,'revision',a.revision,'digest',a.digest,'sourceCommit',a.source_commit,'validUntil',to_char(a.valid_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
 OR whaleu_community.home_policy_definition_valid(a.definition) IS DISTINCT FROM true OR a.definition->'exemptions'->>'audit' IS DISTINCT FROM 'none'
 OR a.digest IS DISTINCT FROM encode(sha256(convert_to('whaleu-home-admission:v1'||chr(10)||whaleu_community.content_canonical_json(a.definition),'UTF8')),'hex') THEN RETURN false;END IF;
 i:=h.evidence->'requestedIntent';source_kind:=CASE WHEN h.evidence->'requestedRegionId'='null'::jsonb THEN 'global' ELSE 'regional' END;
 IF NOT(a.definition->'authorModes' @> jsonb_build_array(i->>'authorMode')) OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(a.definition->'categoryMappings') m WHERE m->>'nativeCategory'=i->>'category' AND m->>'sourceKind'=source_kind AND m->'legacyChoose'=h.evidence->'legacyChoose') THEN RETURN false;END IF;
 SELECT count(*) INTO matches FROM jsonb_array_elements(a.definition->'scopeMappings') m WHERE m->'sourceSpaceId'=i->'spaceId' AND m->>'sourceKind'=source_kind AND m->'sourceRegionId'=h.evidence->'requestedRegionId'
  AND m->'targetWaterSpaceId'=h.evidence->'targetWaterSpaceId' AND m->'targetRegionId'=h.evidence->'targetWaterRegionId'
  AND (source_kind='regional' OR m->'targetRegionId'=b.scope->'authorOriginRegionId');
 RETURN matches=1;
EXCEPTION WHEN OTHERS THEN RETURN false;END$$;
CREATE CONSTRAINT TRIGGER home_request_complete AFTER INSERT OR UPDATE ON whaleu_community.publication_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community.home_publication_complete();

-- Preserve old predicates, hashes and owners. Only exact new definitions enter
-- the additive branch; merely claiming a larger version never suffices.
DO $$DECLARE pair text[];definition text;BEGIN FOREACH pair SLICE 1 IN ARRAY ARRAY[
 ['posts','posts_category_check','publication_envelope_version=7 AND category=''water'''],
 ['posts','post_anonymous_dm_definition','publication_envelope_version=7 AND category IN (''discussion'',''confession'',''companions'',''pets'',''internships'',''scenery'',''dorms'',''research'',''deep_sea'',''water'') AND feedback IS NULL AND (author_mode=''named'' OR allow_anonymous_dm IS NULL)'],
 ['content_approval_decisions','content_approval_envelope_identity','envelope_version IN (7,8) AND envelope->>''version''=envelope_version::text AND envelope->>''accountId''=account_id::text AND envelope->>''purpose''=operation AND whaleu_community.home_envelope_valid(envelope)'],
 ['text_review_requests','text_review_identity','envelope->>''version'' IN (''7'',''8'') AND envelope->>''accountId''=account_id::text AND envelope->>''purpose''=operation AND whaleu_community.home_envelope_valid(envelope)'],
 ['text_review_requests','text_review_scope_definition','envelope->>''version'' IN (''7'',''8'') AND whaleu_community.home_envelope_valid(envelope)']
 ] LOOP
 SELECT pg_get_constraintdef(oid) INTO definition FROM pg_constraint WHERE conrelid=('whaleu_community.'||pair[1])::regclass AND conname=pair[2];
 IF definition IS NULL THEN RAISE EXCEPTION 'Missing historical Home prerequisite constraint';END IF;
 EXECUTE format('ALTER TABLE whaleu_community.%I DROP CONSTRAINT %I',pair[1],pair[2]);
 EXECUTE format('ALTER TABLE whaleu_community.%I ADD CONSTRAINT %I CHECK (%s OR coalesce((%s),false))',pair[1],pair[2],substr(definition,7),pair[3]);
 END LOOP;END$$;
ALTER TABLE whaleu_community.content_approval_decisions DROP CONSTRAINT content_approval_envelope_version;
ALTER TABLE whaleu_community.content_approval_decisions ADD CONSTRAINT content_approval_envelope_version CHECK(envelope_version IN (1,2,3,4,5,6) OR (envelope_version IN (7,8) AND whaleu_community.home_envelope_valid(envelope)));
ALTER TABLE whaleu_community.content_approval_bindings DROP CONSTRAINT content_binding_envelope_version;
ALTER TABLE whaleu_community.content_approval_bindings ADD CONSTRAINT content_binding_envelope_version CHECK(
 (envelope_version IN (1,2,3,4,5,6) AND envelope->>'version'=envelope_version::text AND (envelope_version IN (1,4,6) OR (content_kind='post' AND operation='publish_post')))
 OR (envelope_version IN (7,8) AND envelope->>'version'=envelope_version::text AND whaleu_community.home_envelope_valid(envelope) AND ((envelope_version=7 AND content_kind='post') OR (envelope_version=8 AND content_kind IN ('comment','reply')))));

ALTER FUNCTION whaleu_community.profile_moderation_definition(text,uuid,jsonb) RENAME TO profile_moderation_definition_pre_home;
CREATE FUNCTION whaleu_community.profile_moderation_definition(target_kind text,target uuid,scope jsonb) RETURNS jsonb LANGUAGE plpgsql VOLATILE AS $$BEGIN
 IF EXISTS(SELECT 1 FROM whaleu_community.content_approval_bindings WHERE content_kind=target_kind AND content_id=target AND envelope_version IN (7,8))
 OR EXISTS(SELECT 1 FROM whaleu_community.home_post_dispositions WHERE target_kind='post' AND post_id=target)
 OR EXISTS(SELECT 1 FROM whaleu_community.home_discussion_parent_bindings WHERE content_kind=target_kind AND content_id=target)
 OR EXISTS(SELECT 1 FROM whaleu_community.profile_moderation_nodes(target_kind,target) n JOIN whaleu_community.posts p ON p.id=n.post_id WHERE p.publication_envelope_version=7) THEN RETURN whaleu_community.home_definition(target_kind,target,scope);END IF;
 RETURN whaleu_community.profile_moderation_definition_pre_home(target_kind,target,scope);
END$$;

ALTER FUNCTION whaleu_community.text_source_definition(text,uuid,jsonb) RENAME TO text_source_definition_pre_home;
CREATE FUNCTION whaleu_community.text_source_definition(kind text,target uuid,scope jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$BEGIN
 IF EXISTS(SELECT 1 FROM whaleu_community.community_text_sources s JOIN whaleu_community.content_approval_decisions d ON d.id=s.decision_id WHERE s.content_kind=kind AND s.content_id=target AND d.envelope_version IN (7,8)) THEN RETURN whaleu_community.home_definition(kind,target,scope);END IF;
 RETURN whaleu_community.text_source_definition_pre_home(kind,target,scope);
END$$;
ALTER FUNCTION whaleu_community.text_source_review_current(uuid,boolean) RENAME TO text_source_review_current_pre_home;
CREATE FUNCTION whaleu_community.text_source_review_current(decision uuid,consume boolean DEFAULT false) RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$BEGIN
 IF EXISTS(SELECT 1 FROM whaleu_community.content_approval_decisions WHERE id=decision AND envelope_version IN (7,8)) THEN RETURN whaleu_community.home_review_current(decision,consume);END IF;
 RETURN whaleu_community.text_source_review_current_pre_home(decision,consume);
END$$;
ALTER FUNCTION whaleu_community.text_source_assert(text,uuid) RENAME TO text_source_assert_pre_home;
CREATE FUNCTION whaleu_community.text_source_assert(kind text,target uuid) RETURNS void LANGUAGE plpgsql AS $$BEGIN
 IF EXISTS(SELECT 1 FROM whaleu_community.community_text_sources s JOIN whaleu_community.content_approval_decisions d ON d.id=s.decision_id WHERE s.content_kind=kind AND s.content_id=target AND d.envelope_version IN (7,8))
 OR EXISTS(SELECT 1 FROM whaleu_community.content_approval_bindings WHERE content_kind=kind AND content_id=target AND envelope_version IN (7,8)) THEN PERFORM whaleu_community.home_publication_assert(kind,target);RETURN;END IF;
 PERFORM whaleu_community.text_source_assert_pre_home(kind,target);
END$$;
ALTER FUNCTION whaleu_community.text_source_authority_assert(text,uuid) RENAME TO text_source_authority_assert_pre_home;
CREATE FUNCTION whaleu_community.text_source_authority_assert(kind text,target uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE s whaleu_community.community_text_sources;d whaleu_community.content_approval_decisions;e jsonb;BEGIN
 SELECT * INTO s FROM whaleu_community.community_text_sources WHERE content_kind=kind AND content_id=target AND publication_transaction=pg_current_xact_id();
 SELECT * INTO d FROM whaleu_community.content_approval_decisions WHERE id=s.decision_id;
 IF d.envelope_version IN (7,8) THEN
  e:=whaleu_community.home_definition(kind,target,d.envelope->'scope');
  IF e IS NULL OR d.envelope IS DISTINCT FROM e OR (s.account_id,s.approval_digest) IS DISTINCT FROM (d.account_id,d.digest)
   OR s.original_intent_hash IS DISTINCT FROM whaleu_community.home_intent_hash(e,s.requested_author_mode)
   OR NOT EXISTS(SELECT 1 FROM whaleu_community.publication_requests q WHERE (q.account_id,q.client_request_id,q.operation,q.payload_hash)=(s.account_id,s.client_request_id,'publish_'||kind,s.original_intent_hash))
   OR EXISTS(SELECT 1 FROM whaleu_community.publication_cancel_fences WHERE account_id=s.account_id AND client_request_id=s.client_request_id)
   THEN RAISE EXCEPTION 'Exact Home source request authority required' USING ERRCODE='23514',CONSTRAINT='home_publication_causal';END IF;
  PERFORM whaleu_community.home_publication_authority(kind,target);RETURN;
 END IF;
 PERFORM whaleu_community.text_source_authority_assert_pre_home(kind,target);
END$$;

-- Home issuance and queue-transition cohorts are server-owned observations.
-- They are separate from the untouched historical V6 source cohort.
ALTER TABLE whaleu_community.content_approval_decisions ADD COLUMN home_issuance_transaction xid8;
ALTER TABLE whaleu_community.text_review_requests ADD COLUMN home_transition_transaction xid8;
ALTER TABLE whaleu_community.content_approval_decisions ADD CONSTRAINT home_decision_cohort CHECK((envelope_version IN (7,8))=(home_issuance_transaction IS NOT NULL));
ALTER TABLE whaleu_community.text_review_requests ADD CONSTRAINT home_queue_cohort CHECK((envelope->>'version' IN ('7','8'))=(home_transition_transaction IS NOT NULL));
CREATE INDEX home_decision_transaction ON whaleu_community.content_approval_decisions(home_issuance_transaction) WHERE envelope_version IN (7,8);
CREATE INDEX home_queue_transaction ON whaleu_community.text_review_requests(home_transition_transaction) WHERE envelope->>'version' IN ('7','8');
CREATE FUNCTION whaleu_community.home_review_capture() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d whaleu_community.content_approval_decisions;BEGIN
 IF TG_TABLE_NAME='content_approval_decisions' THEN
  IF NEW.home_issuance_transaction IS NOT NULL THEN RAISE EXCEPTION 'Home decision cohort is server owned' USING ERRCODE='23514';END IF;
  IF NEW.envelope_version IN (7,8) THEN NEW.home_issuance_transaction:=pg_current_xact_id();PERFORM whaleu_community.home_review_assert(NEW.envelope,NULL,NEW.policy_revision_id);END IF;
 ELSE
  IF TG_OP='INSERT' THEN
   IF NEW.home_transition_transaction IS NOT NULL THEN RAISE EXCEPTION 'Home queue cohort is server owned' USING ERRCODE='23514';END IF;
   IF NEW.envelope->>'version' IN ('7','8') THEN NEW.home_transition_transaction:=pg_current_xact_id();END IF;
  ELSIF NEW.home_transition_transaction IS DISTINCT FROM OLD.home_transition_transaction THEN RAISE EXCEPTION 'Home queue cohort is immutable to callers' USING ERRCODE='23514';
  ELSIF NEW.envelope->>'version' IN ('7','8') AND OLD.decision_id IS NULL AND NEW.decision_id IS NOT NULL THEN
   SELECT * INTO d FROM whaleu_community.content_approval_decisions WHERE id=NEW.decision_id;
   IF d.id IS NULL OR (d.account_id,d.operation,d.digest,d.envelope) IS DISTINCT FROM (NEW.account_id,NEW.operation,NEW.digest,NEW.envelope)
    OR NOT EXISTS(SELECT 1 FROM whaleu_community.publication_requests q WHERE (q.account_id,q.client_request_id,q.operation,q.payload_hash)=(NEW.account_id,NEW.client_request_id,NEW.operation,NEW.intent_hash)) THEN RAISE EXCEPTION 'Exact Home queue transition required' USING ERRCODE='23514';END IF;
   NEW.home_transition_transaction:=pg_current_xact_id();
  END IF;
  IF NEW.envelope->>'version' IN ('7','8') THEN PERFORM whaleu_community.home_review_assert(NEW.envelope,NEW.intent_hash);END IF;
 END IF;RETURN NEW;
END$$;
CREATE TRIGGER home_review_capture BEFORE INSERT ON whaleu_community.content_approval_decisions FOR EACH ROW EXECUTE FUNCTION whaleu_community.home_review_capture();
CREATE TRIGGER home_review_capture BEFORE INSERT OR UPDATE ON whaleu_community.text_review_requests FOR EACH ROW EXECUTE FUNCTION whaleu_community.home_review_capture();
CREATE FUNCTION whaleu_community.home_review_cohorts_assert() RETURNS void LANGUAGE plpgsql AS $$DECLARE q record;d record;BEGIN
 FOR q IN SELECT * FROM whaleu_community.text_review_requests WHERE home_transition_transaction=pg_current_xact_id() AND envelope->>'version' IN ('7','8') LOOP
  IF EXISTS(SELECT 1 FROM whaleu_community.publication_cancel_fences WHERE account_id=q.account_id AND client_request_id=q.client_request_id) THEN RAISE EXCEPTION 'Home Review cancelled in current transaction' USING ERRCODE='23514';END IF;
  PERFORM whaleu_community.home_review_assert(q.envelope,q.intent_hash);
 END LOOP;
 FOR d IN SELECT * FROM whaleu_community.content_approval_decisions WHERE home_issuance_transaction=pg_current_xact_id() AND envelope_version IN (7,8) LOOP
  PERFORM whaleu_community.home_review_assert(d.envelope,NULL,d.policy_revision_id);
 END LOOP;
END$$;
CREATE FUNCTION whaleu_community.home_recheck_transaction() RETURNS trigger LANGUAGE plpgsql AS $$DECLARE c record;BEGIN
 FOR c IN SELECT 'post' kind,post_id id FROM whaleu_community.home_post_dispositions WHERE publication_transaction=pg_current_xact_id()
  UNION ALL SELECT content_kind,content_id FROM whaleu_community.home_discussion_parent_bindings WHERE publication_transaction=pg_current_xact_id() LOOP
  PERFORM whaleu_community.home_publication_assert(c.kind,c.id);
 END LOOP;PERFORM whaleu_community.home_review_cohorts_assert();RETURN NULL;
END$$;
CREATE FUNCTION whaleu_community.home_recheck_authority() RETURNS trigger LANGUAGE plpgsql AS $$DECLARE c record;BEGIN
 FOR c IN SELECT 'post' kind,post_id id FROM whaleu_community.home_post_dispositions WHERE publication_transaction=pg_current_xact_id()
  UNION ALL SELECT content_kind,content_id FROM whaleu_community.home_discussion_parent_bindings WHERE publication_transaction=pg_current_xact_id() LOOP
  PERFORM whaleu_community.home_publication_authority(c.kind,c.id);
  IF TG_OP='TRUNCATE' THEN PERFORM whaleu_community.home_publication_assert(c.kind,c.id);END IF;
 END LOOP;PERFORM whaleu_community.home_review_cohorts_assert();RETURN NULL;
END$$;
CREATE CONSTRAINT TRIGGER home_review_complete AFTER INSERT OR UPDATE ON whaleu_community.text_review_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community.home_recheck_transaction();
CREATE CONSTRAINT TRIGGER home_decision_complete AFTER INSERT ON whaleu_community.content_approval_decisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.envelope_version IN (7,8)) EXECUTE FUNCTION whaleu_community.home_recheck_transaction();


-- Complete predecessor body retained after the explicit Home branch.
CREATE OR REPLACE FUNCTION whaleu_community.related_review_policy_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE key text;BEGIN
 IF NEW.envelope_version IN (7,8) THEN
  IF whaleu_community.home_envelope_valid(NEW.envelope) IS DISTINCT FROM true THEN RAISE EXCEPTION 'Invalid exact Home Review envelope' USING ERRCODE='23514';END IF;
  PERFORM whaleu_community.home_review_assert(NEW.envelope,NULL,NEW.policy_revision_id);RETURN NEW;
 END IF;

 SELECT policy_key INTO key FROM whaleu_community.content_approval_policies WHERE id=NEW.policy_revision_id;
 IF NEW.envelope_version=6 THEN
  IF key IS DISTINCT FROM 'local-text-source-v1' THEN RAISE EXCEPTION 'Review envelope policy domain mismatch' USING ERRCODE='23514';END IF;
  RETURN NEW;
 END IF;
 IF (NEW.envelope_version=4 AND key IS DISTINCT FROM 'local-related-v1') OR (NEW.envelope_version<>4 AND key IS DISTINCT FROM 'local-explicit-v1') THEN RAISE EXCEPTION 'Review envelope policy domain mismatch' USING ERRCODE='23514'; END IF;
 IF NEW.envelope_version=4 AND NEW.envelope->>'purpose'='publish_post' AND NOT EXISTS(SELECT 1 FROM whaleu_community.related_sync_policies p WHERE p.id=(NEW.envelope->'scope'->>'syncPolicyId')::uuid AND p.review_policy_revision_id=NEW.policy_revision_id) THEN RAISE EXCEPTION 'Root Review requires exact applicability reviewer' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END$$;

-- Complete predecessor body retained after the explicit Home branch.
CREATE OR REPLACE FUNCTION whaleu_community.content_binding_dm_definition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE post whaleu_community.posts;BEGIN
 IF NEW.envelope_version IN (7,8) THEN
  IF whaleu_community.home_envelope_valid(NEW.envelope) IS DISTINCT FROM true OR NEW.envelope IS DISTINCT FROM whaleu_community.home_definition(NEW.content_kind,NEW.content_id,NEW.scope)
   THEN RAISE EXCEPTION 'Exact Home reviewed definition required' USING ERRCODE='23514';END IF;
  PERFORM whaleu_community.home_publication_authority(NEW.content_kind,NEW.content_id);RETURN NEW;
 END IF;
 IF EXISTS(SELECT 1 FROM whaleu_community.posts WHERE id=CASE WHEN NEW.content_kind='post' THEN NEW.content_id ELSE (NEW.envelope->>'postId')::uuid END AND publication_envelope_version=7)
  OR EXISTS(SELECT 1 FROM whaleu_community.home_post_dispositions WHERE NEW.content_kind='post' AND post_id=NEW.content_id)
  OR EXISTS(SELECT 1 FROM whaleu_community.home_discussion_parent_bindings WHERE content_kind=NEW.content_kind AND content_id=NEW.content_id)
 THEN RAISE EXCEPTION 'Home content cannot downgrade Review' USING ERRCODE='23514';END IF;

 IF NEW.envelope_version=6 THEN
  IF whaleu_community.text_source_envelope_valid(NEW.envelope) IS DISTINCT FROM true
   OR NEW.envelope IS DISTINCT FROM whaleu_community.text_source_definition(NEW.content_kind,NEW.content_id,NEW.scope)
   THEN RAISE EXCEPTION 'Text source reviewed definition mismatch' USING ERRCODE='23514';END IF;
  RETURN NEW;
 END IF;
 IF EXISTS(SELECT 1 FROM whaleu_community.community_text_sources WHERE content_kind=NEW.content_kind AND content_id=NEW.content_id) THEN
  RAISE EXCEPTION 'Explicit source cannot acquire a legacy approval' USING ERRCODE='23514';END IF;
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
   (NEW.envelope_version=2 AND (post.author_mode<>'named' OR jsonb_typeof(NEW.envelope->'allowAnonymousDm') IS DISTINCT FROM 'boolean' OR to_jsonb(post.allow_anonymous_dm) IS DISTINCT FROM NEW.envelope->'allowAnonymousDm')) THEN
   RAISE EXCEPTION 'Anonymous DM reviewed definition mismatch' USING ERRCODE='23514';END IF;
 ELSIF NEW.envelope_version<>1 OR NEW.envelope ? 'allowAnonymousDm' THEN
  RAISE EXCEPTION 'Anonymous DM consent requires a named post' USING ERRCODE='23514';END IF;
 RETURN NEW;
END$$;

ALTER FUNCTION whaleu_community.reading_format_source_current(text,uuid) RENAME TO reading_format_source_current_pre_home;
CREATE FUNCTION whaleu_community.reading_format_source_current(kind text,target uuid) RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
DECLARE s whaleu_community.community_text_sources;p whaleu_community.posts;target_row record;n record;b whaleu_community.content_approval_bindings;root_binding whaleu_community.content_approval_bindings;d whaleu_community.content_approval_decisions;seen integer:=0;expected integer;BEGIN
 IF NOT EXISTS(SELECT 1 FROM whaleu_community.content_approval_bindings WHERE content_kind=kind AND content_id=target AND envelope_version IN (7,8)) THEN RETURN whaleu_community.reading_format_source_current_pre_home(kind,target);END IF;
 SELECT * INTO s FROM whaleu_community.community_text_sources WHERE content_kind=kind AND content_id=target;
 SELECT * INTO target_row FROM whaleu_community.profile_moderation_target(kind,target);
 IF s.content_id IS NULL OR target_row.subject_id IS NULL OR s.source_format<>'plain' OR s.reading_formatting IS DISTINCT FROM 'auto' THEN RETURN false;END IF;
 SELECT * INTO p FROM whaleu_community.posts WHERE id=target_row.post_id;
 IF p.id IS NULL OR p.publication_state<>'published' OR p.publication_envelope_version<>7
 OR EXISTS(SELECT 1 FROM whaleu_community.post_owner_visibility WHERE post_id=p.id AND owner_hidden)
 OR EXISTS(SELECT 1 FROM whaleu_community.post_category_heads WHERE post_id=p.id)
 OR NOT EXISTS(SELECT 1 FROM whaleu_community.spaces x LEFT JOIN whaleu_campus.operating_regions r ON r.id=x.operating_region_id WHERE x.id=p.space_id AND x.is_active AND (x.operating_region_id IS NULL OR r.is_active))
 OR whaleu_safety.account_punishment_allows(s.account_id,'passive_bookkeeping') IS DISTINCT FROM true THEN RETURN false;END IF;
 SELECT * INTO root_binding FROM whaleu_community.content_approval_bindings WHERE content_kind='post' AND content_id=p.id AND content_version=1 AND envelope_version=7;
 IF root_binding.content_id IS NULL THEN RETURN false;END IF;
 expected:=CASE kind WHEN 'post' THEN 1 WHEN 'comment' THEN 2 WHEN 'reply' THEN 3 ELSE 0 END;
 FOR n IN SELECT * FROM whaleu_community.profile_moderation_nodes(kind,target) LOOP
  seen:=seen+1;
  SELECT * INTO b FROM whaleu_community.content_approval_bindings WHERE content_kind=n.kind AND content_id=n.id AND content_version=1;
  SELECT * INTO d FROM whaleu_community.content_approval_decisions WHERE id=b.decision_id;
  IF n.payload->>'visibility' IS DISTINCT FROM 'approved' OR n.payload->'deleted_at' IS DISTINCT FROM 'null'::jsonb OR b.account_id IS DISTINCT FROM n.account_id OR b.content_id IS NULL OR b.envelope_version IS DISTINCT FROM (CASE n.kind WHEN 'post' THEN 7 ELSE 8 END) OR b.envelope->'scope'->>'sync' IS DISTINCT FROM 'none'
   OR b.envelope->'component' IS DISTINCT FROM '{"kind":"none"}'::jsonb OR b.envelope->'trading' IS DISTINCT FROM 'null'::jsonb
   OR NOT EXISTS(SELECT 1 FROM whaleu_community.spaces space WHERE space.id=p.space_id AND space.kind IN ('regional','global') AND space.id::text=b.scope->>'originalSpaceId' AND space.operating_region_id::text IS NOT DISTINCT FROM b.scope->>'originalRegionId')
   OR b.envelope IS DISTINCT FROM whaleu_community.home_definition(n.kind,n.id,b.scope)
   OR (n.kind<>'post' AND (b.envelope->'homeParent' IS DISTINCT FROM jsonb_build_object('postId',p.id,'decisionId',root_binding.decision_id,'digest',root_binding.digest)
    OR (b.envelope->'category',b.envelope->'spaceId',b.scope->'originalSpaceId',b.scope->'originalRegionId',b.envelope->'commentsPolicy') IS DISTINCT FROM (root_binding.envelope->'category',root_binding.envelope->'spaceId',root_binding.scope->'originalSpaceId',root_binding.scope->'originalRegionId',root_binding.envelope->'commentsPolicy')))
   OR (b.account_id,b.operation,b.envelope_version,b.digest,b.envelope,b.scope) IS DISTINCT FROM (d.account_id,d.operation,d.envelope_version,d.digest,d.envelope,d.envelope->'scope')
   OR whaleu_community.home_review_current(b.decision_id) IS DISTINCT FROM true
   OR whaleu_community.profile_moderation_media_current(n.kind,n.id,b.envelope->'images') IS DISTINCT FROM true
   OR NOT EXISTS(SELECT 1 FROM whaleu_identity.accounts WHERE id=b.account_id AND status='active' AND lifecycle='active') THEN RETURN false;END IF;
  IF n.kind=kind AND n.id=target AND (b.envelope->'textSource'='null'::jsonb OR b.account_id<>s.account_id OR b.decision_id<>s.decision_id OR b.digest<>s.approval_digest OR char_length(b.envelope->>'text')<CASE kind WHEN 'post' THEN 300 ELSE 200 END OR s.source_hash IS DISTINCT FROM whaleu_community.text_source_hash('plain',b.envelope->>'text')) THEN RETURN false;END IF;
 END LOOP;
 RETURN seen=expected;
EXCEPTION WHEN OTHERS THEN RETURN false;END$$;
-- Worker parameters, retry schedule, computation, slot count, lease bounds and
-- passive-bookkeeping authority are unchanged. These are new source dependencies.
-- ALTER FUNCTION changes PL/pgSQL's implicit parameter-block label. Preserve
-- the two old qualified parameter references by exact, preimage-checked rename;
-- every old predicate and original request/source hash byte stays unchanged.
DO $relabel$ DECLARE item record;body text;qualified text;definition text;attributes jsonb;function_oid oid;BEGIN
 FOR item IN SELECT * FROM (VALUES
  ('text_source_assert','d44e20ff82c9df4072e2a8fa0240c124e8add41144c3787bba66b5bcc60f23db','void'),
  ('reading_format_source_current','e78a8651d8aa73632c5fef8ed10123004b688f2b8a34f851147b9dca6545c1f2','boolean')
 ) expected(name,digest,result_type) LOOP
  function_oid:=to_regprocedure('whaleu_community.'||item.name||'_pre_home(text,uuid)');
  SELECT prosrc,to_jsonb(p)-'prosrc',pg_get_functiondef(p.oid) INTO body,attributes,definition FROM pg_proc p WHERE p.oid=function_oid;
  qualified:=item.name||'.kind';
  IF body IS NULL OR encode(sha256(convert_to(body,'UTF8')),'hex') IS DISTINCT FROM item.digest
   OR (length(body)-length(replace(body,qualified,'')))/length(qualified)<>1
  THEN RAISE EXCEPTION 'Unexpected qualified legacy parameter preimage: %',item.name USING ERRCODE='23514';END IF;
  EXECUTE replace(definition,qualified,item.name||'_pre_home.kind');
  IF (SELECT to_jsonb(p)-'prosrc' FROM pg_proc p WHERE p.oid=function_oid) IS DISTINCT FROM attributes
   OR (SELECT prosrc FROM pg_proc WHERE oid=function_oid) IS DISTINCT FROM replace(body,qualified,item.name||'_pre_home.kind')
  THEN RAISE EXCEPTION 'Legacy parameter adaptation changed other function properties: %',item.name USING ERRCODE='23514';END IF;
 END LOOP;
END $relabel$;

CREATE OR REPLACE FUNCTION whaleu_community.reading_format_source_fence() RETURNS void LANGUAGE plpgsql AS $$BEGIN
 -- Historical exact-key Home evidence is immutable and insertion is fresh-only.
 -- Managed readers retain the independently pinned home_reading_catalog seal;
 -- they need SELECT, not MAINTAIN or UPDATE, on these two proof owners.
 -- Original source fences and both Home reading_late_guard triggers remain.
 PERFORM whaleu_community.text_source_fence();
 LOCK TABLE whaleu_identity.accounts,whaleu_campus.operating_regions,
 whaleu_community.posts,whaleu_community.root_comments,whaleu_community.replies,whaleu_community.spaces,
 whaleu_community.community_text_sources,whaleu_community.content_approval_bindings,whaleu_community.content_approval_decisions,whaleu_community.content_approval_events,
 whaleu_community.post_owner_visibility,whaleu_community.post_category_heads,whaleu_community.post_images,whaleu_community.comment_images,whaleu_community.reply_images,
 whaleu_community.polls,whaleu_community.poll_options,whaleu_community.formations,whaleu_community.formation_members,
 whaleu_media.bindings,whaleu_media.assets,whaleu_media.upload_intents,whaleu_media.asset_safety_heads,whaleu_media.asset_safety_events IN SHARE MODE NOWAIT;
END$$;
DO $$DECLARE relation text;BEGIN FOREACH relation IN ARRAY ARRAY['home_post_dispositions','home_discussion_parent_bindings'] LOOP
 EXECUTE format('CREATE TRIGGER reading_late_guard AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_community.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.reading_format_late_guard()',relation);
END LOOP;END$$;

-- Full post-statement dependency closure, including zero-row statements and
-- TRUNCATE. Phase one supports construction; deferred causal checks close phase
-- two. Early constraint drain never disables subsequent authority rechecks.
DO $$DECLARE relation text;BEGIN FOREACH relation IN ARRAY ARRAY[
 'whaleu_campus.community_topology_snapshots',
 'whaleu_campus.community_topology_heads',
 'whaleu_campus.operating_regions',
 'whaleu_community.region_policy_revisions',
 'whaleu_community.region_policy_heads',
 'whaleu_campus.community_identity_selections',
 'whaleu_campus.community_identity_heads',
 'whaleu_campus.campuses',
 'whaleu_campus.institutions',
 'whaleu_campus.campus_region_assignments',
 'whaleu_verification.account_heads',
 'whaleu_verification.snapshots',
 'whaleu_verification.assertions',
 'whaleu_community.spaces',
 'whaleu_identity.accounts',
 'whaleu_safety.account_heads',
 'whaleu_safety.blocks',
 'whaleu_authorization.role_grants',
 'whaleu_community.posts',
 'whaleu_community.root_comments',
 'whaleu_community.replies',
 'whaleu_community.post_owner_visibility',
 'whaleu_community.post_category_heads',
 'whaleu_community.post_category_events',
 'whaleu_community.post_category_issuers',
 'whaleu_community.post_category_issuer_withdrawals',
 'whaleu_community.post_category_policies',
 'whaleu_community.post_category_policy_heads',
 'whaleu_community.post_category_policy_withdrawals',
 'whaleu_community.post_category_reviews',
 'whaleu_community.post_category_review_withdrawals',
 'whaleu_community.post_images',
 'whaleu_community.comment_images',
 'whaleu_community.reply_images',
 'whaleu_community.polls',
 'whaleu_community.poll_options',
 'whaleu_community.formations',
 'whaleu_community.formation_members',
 'whaleu_community.content_approval_bindings',
 'whaleu_community.content_approval_policies',
 'whaleu_community.content_approval_decisions',
 'whaleu_community.content_approval_events',
 'whaleu_community.content_approval_heads',
 'whaleu_media.assets',
 'whaleu_media.upload_intents',
 'whaleu_media.asset_safety_heads',
 'whaleu_media.asset_safety_events',
 'whaleu_media.bindings',
 'whaleu_safety.account_punishment_heads',
 'whaleu_safety.account_punishments',
 'whaleu_safety.account_punishment_terminals',
 'whaleu_community.publication_cancel_fences',
 'whaleu_media.media_owner_states',
 'whaleu_community.community_text_sources',
 'whaleu_community.post_distribution_bindings',
 'whaleu_community.trading_listings',
 'whaleu_community.post_rating_target_links',
 'whaleu_community.report_origins',
 'whaleu_community.publication_requests',
 'whaleu_community.outbox',
 'whaleu_community.text_review_requests',
 'whaleu_community.home_post_dispositions',
 'whaleu_community.home_discussion_parent_bindings',
 'whaleu_community.home_policy_preparations',
 'whaleu_community.home_policy_admissions',
 'whaleu_community.home_policy_head',
 'whaleu_community.home_publication_preparations',
 'whaleu_community.home_publication_activations',
 'whaleu_community.home_publication_head'] LOOP
 EXECUTE format('CREATE TRIGGER home_dependency_recheck AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON %s FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.home_recheck_authority()',relation);
END LOOP;
FOREACH relation IN ARRAY ARRAY['whaleu_community.related_sync_actor_generation','whaleu_community.related_sync_admission_generation','whaleu_campus.community_distribution_generation','whaleu_community.related_sync_view_generation'] LOOP
 EXECUTE format('CREATE CONSTRAINT TRIGGER home_generation_recheck AFTER INSERT OR UPDATE ON %s DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community.home_recheck_transaction()',relation);
END LOOP;
FOREACH relation IN ARRAY ARRAY['whaleu_community.report_origins','whaleu_community.publication_requests','whaleu_community.outbox'] LOOP
 EXECUTE format('CREATE CONSTRAINT TRIGGER home_causal_recheck AFTER INSERT OR UPDATE OR DELETE ON %s DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community.home_recheck_transaction()',relation);
END LOOP;END$$;
-- Extend existing administrative/lifecycle source fences, not erasure admission.
DO $$DECLARE relation text;BEGIN FOREACH relation IN ARRAY ARRAY['home_post_dispositions','home_discussion_parent_bindings'] LOOP
 EXECUTE format('CREATE TRIGGER a_discovery_count_epoch BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_community.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.advance_discovery_count_epoch()',relation);
 EXECUTE format('CREATE TRIGGER a000_related_actor_generation BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_community.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.related_sync_advance_generation(''actor'')',relation);
 EXECUTE format('CREATE TRIGGER a00_admin_post_removal_source_statement BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_community.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.admin_post_removal_source_statement_guard()',relation);
 EXECUTE format('CREATE TRIGGER a00_admin_discussion_removal_source_statement BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_community.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.admin_discussion_removal_source_statement_guard()',relation);
 EXECUTE format('CREATE TRIGGER a000_account_deletion_writer_fence BEFORE INSERT OR UPDATE OR DELETE ON whaleu_community.%I FOR EACH ROW EXECUTE FUNCTION whaleu_account_deletion.writer_fence()',relation);
END LOOP;END$$;

-- Narrow historical-reading premises, independent of the unchanged 0176
-- collector and of current Home activation/admission values. Exact owner keys,
-- immutable guards, fresh canonical xids, closure attachments and current Home
-- definition/Review helpers are sealed. This is not an issuance-authorization
-- shortcut. The finite helper list includes rewritten predecessor adapters;
-- original source/current-authority fences remain independently mandatory.
-- Collectors/markers are excluded to avoid circular seals. Runtime separately
-- pins this collector body and parses its constant marker, never trusting a
-- self-attesting function result. OID-indexed lookups retain bounded scan cost.
CREATE FUNCTION whaleu_community.home_reading_catalog() RETURNS text
LANGUAGE sql STABLE SET search_path=pg_catalog AS $home_reading_catalog$
 WITH owners AS MATERIALIZED (
  SELECT c.* FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='whaleu_community' AND c.relname IN ('home_post_dispositions','home_discussion_parent_bindings','posts','root_comments','replies')
 ), relations AS MATERIALIZED (
  SELECT * FROM owners
  UNION ALL
  SELECT c.* FROM owners o JOIN pg_index i ON i.indrelid=o.oid JOIN pg_class c ON c.oid=i.indexrelid
 ), target_triggers AS MATERIALIZED (
  SELECT t.* FROM owners o JOIN pg_trigger t ON t.tgrelid=o.oid
  WHERE NOT t.tgisinternal AND o.relname IN ('home_post_dispositions','home_discussion_parent_bindings')
  UNION ALL
  SELECT t.* FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgname IN ('home_post_complete','home_publication_complete','home_request_complete','home_review_capture','home_review_complete','home_decision_complete','home_dependency_recheck','home_generation_recheck','home_causal_recheck','approved_post_immutable','approved_comment_immutable','approved_reply_immutable','content_binding_validate','content_binding_dm_definition')
   AND NOT EXISTS(SELECT 1 FROM owners o WHERE o.oid=t.tgrelid AND o.relname IN ('home_post_dispositions','home_discussion_parent_bindings'))
 ), function_oids AS MATERIALIZED (
  SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE (n.nspname='whaleu_community' AND p.proname IN ('approved_content_immutable','content_approval_immutable','content_binding_dm_definition','content_binding_validate','content_canonical_json','home_activation_payload_current','home_definition','home_envelope_valid','home_evidence_valid','home_intent_hash','home_intent_matches','home_metadata_insert_guard','home_parent_current','home_policy_catalog_valid','home_policy_definition_valid','home_policy_scope_snapshot','home_publication_assert','home_publication_authority','home_publication_complete','home_publication_current','home_publication_fence','home_recheck_authority','home_recheck_transaction','home_requested_intent_hash','home_restriction','home_review_admitted','home_review_assert','home_review_capture','home_review_cohorts_assert','home_review_current','home_review_policy_current','home_source_valid','post_owner_visibility_keys','profile_moderation_definition','profile_moderation_definition_pre_home','profile_moderation_media_current','profile_moderation_scope_valid','rating_scoped_nullable_id','rating_scoped_uuid_valid','related_review_policy_guard','related_sync_exact_keys','related_sync_uuid','text_source_admitted','text_source_ancestors_current','text_source_assert','text_source_assert_pre_home','text_source_authority_assert','text_source_authority_assert_pre_home','text_source_cohort_capture','text_source_complete','text_source_definition','text_source_definition_pre_home','text_source_destination_current','text_source_envelope_valid','text_source_fence','text_source_hash','text_source_insert_guard','text_source_intent_hash','text_source_recheck_authority','text_source_recheck_transaction','text_source_review_assert','text_source_review_cohorts_assert','text_source_review_complete','text_source_review_current','text_source_review_current_pre_home','text_source_review_fresh'))
   OR (n.nspname='whaleu_profile' AND p.proname IN ('moderation_text_valid','moderation_trim','moderation_uuid_valid'))
  UNION SELECT tgfoid FROM target_triggers
 ), facts AS (
  SELECT 'relation' kind,c.relname::text key,
   jsonb_build_array(c.oid,c.relkind,c.relpersistence,c.relowner,c.relrowsecurity,c.relforcerowsecurity,c.reloptions,c.relispartition,c.relhasrules,pg_get_expr(c.relpartbound,c.oid)) value FROM relations c
  UNION ALL
  SELECT 'inheritance',i.inhrelid::text||':'||i.inhseqno::text,jsonb_build_array(i.inhparent,i.inhdetachpending)
   FROM pg_inherits i WHERE i.inhrelid IN(SELECT oid FROM relations) OR i.inhparent IN(SELECT oid FROM relations)
  UNION ALL
  SELECT 'column',c.relname||':'||a.attnum::text,
   jsonb_build_array(a.attname,a.atttypid,a.atttypmod,a.attnotnull,a.attidentity,a.attgenerated,a.attisdropped,a.attcollation,pg_get_expr(d.adbin,d.adrelid))
   FROM relations c JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
  UNION ALL
  SELECT 'constraint',c.relname||':'||x.conname,jsonb_build_array(pg_get_constraintdef(x.oid,true),x.convalidated,x.condeferrable,x.condeferred)
   FROM relations c JOIN pg_constraint x ON x.conrelid=c.oid
  UNION ALL
  SELECT 'index',c.relname,jsonb_build_array(pg_get_indexdef(c.oid),i.indisvalid,i.indisready,i.indislive)
   FROM relations c JOIN pg_index i ON i.indexrelid=c.oid
  UNION ALL
  SELECT 'function',n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')',jsonb_build_array(pg_get_functiondef(p.oid),p.proowner)
   FROM function_oids wanted
   CROSS JOIN LATERAL(SELECT p.oid,p.proname,p.pronamespace,p.proowner FROM pg_proc p WHERE p.oid=wanted.oid OFFSET 0) p
   JOIN pg_namespace n ON n.oid=p.pronamespace
  UNION ALL
  SELECT 'trigger',n.nspname||'.'||c.relname||':'||t.tgname,jsonb_build_array(pg_get_triggerdef(t.oid,true),t.tgenabled,t.tgdeferrable,t.tginitdeferred)
   FROM target_triggers t
   CROSS JOIN LATERAL(SELECT c.oid,c.relname,c.relnamespace FROM pg_class c WHERE c.oid=t.tgrelid OFFSET 0) c
   JOIN pg_namespace n ON n.oid=c.relnamespace
 ) SELECT encode(sha256(convert_to(coalesce(jsonb_agg(jsonb_build_array(kind,key,value) ORDER BY kind COLLATE "C",key COLLATE "C"),'[]'::jsonb)::text,'UTF8')),'hex') FROM facts
$home_reading_catalog$;
DO $home_reading_seal$ DECLARE seal jsonb;BEGIN
 seal:=jsonb_build_object('version',1,'migration','0178_home_publication_protocol.sql','catalog',whaleu_community.home_reading_catalog());
 EXECUTE format('CREATE FUNCTION whaleu_community.home_reading_protocol() RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS %L','SELECT '||quote_literal(seal::text)||'::jsonb');
END $home_reading_seal$;

-- A migration-created catalog seal is a schema comparison, not activation or
-- publication authority. The fixed predecessor preimages above must all match
-- before this extension is installed and either catalog is sealed.
CREATE FUNCTION whaleu_community.home_publication_catalog() RETURNS text
LANGUAGE sql STABLE SET search_path=pg_catalog AS $catalog$
 WITH relations AS (
  SELECT c.* FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='whaleu_community' AND (c.relname LIKE 'home_%'
   OR c.relname IN ('community_text_sources','posts','root_comments','replies','content_approval_decisions','content_approval_bindings','content_approval_policies','text_review_requests','publication_requests'))
 ), target_triggers AS (
  SELECT t.* FROM pg_trigger t WHERE NOT t.tgisinternal AND
   (t.tgrelid IN(SELECT oid FROM relations) OR t.tgname IN ('home_dependency_recheck','home_generation_recheck','home_causal_recheck'))
 ), facts AS (
  SELECT 'relation' kind,c.relname::text key,
   jsonb_build_array(c.relkind,c.relpersistence,c.relowner,c.relrowsecurity,c.relforcerowsecurity,c.reloptions,c.relispartition) value FROM relations c
  UNION ALL
  SELECT 'column',c.relname||':'||a.attnum::text,
   jsonb_build_array(a.attname,a.atttypid,a.atttypmod,a.attnotnull,a.attidentity,a.attgenerated,a.attisdropped,a.attcollation,pg_get_expr(d.adbin,d.adrelid))
   FROM relations c JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0
   LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
  UNION ALL
  SELECT 'constraint',c.relname||':'||x.conname,
   jsonb_build_array(pg_get_constraintdef(x.oid,true),x.convalidated,x.condeferrable,x.condeferred)
   FROM relations c JOIN pg_constraint x ON x.conrelid=c.oid
  UNION ALL
  SELECT 'index',c.relname,
   jsonb_build_array(pg_get_indexdef(c.oid),i.indisvalid,i.indisready,i.indislive)
   FROM relations c JOIN pg_index i ON i.indexrelid=c.oid
  UNION ALL
  SELECT 'function',n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')',jsonb_build_array(pg_get_functiondef(p.oid),p.proowner)
   FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE (n.nspname='whaleu_community' AND (
     (p.proname LIKE 'home_%' AND p.proname<>'home_publication_protocol')
     OR p.proname IN ('profile_moderation_definition','profile_moderation_definition_pre_home','text_source_definition','text_source_definition_pre_home','text_source_review_current','text_source_review_current_pre_home',
      'text_source_assert','text_source_assert_pre_home','text_source_authority_assert','text_source_authority_assert_pre_home','related_review_policy_guard','content_binding_dm_definition',
      'home_envelope_valid','text_source_hash','text_source_destination_current','text_source_fence','profile_moderation_scope_valid','profile_moderation_media_current','content_canonical_json',
      'reading_format_source_current','reading_format_source_current_pre_home','reading_format_source_fence','content_binding_dm_definition','content_canonical_json','home_policy_catalog_valid','home_policy_complete','home_policy_definition_valid','home_policy_preparation_guard','home_policy_protocol','home_policy_scope_snapshot','home_policy_write_guard','profile_moderation_definition','profile_moderation_media_current','profile_moderation_scope_valid','rating_scoped_nullable_id','related_review_policy_guard','related_sync_exact_keys','related_sync_uuid','text_source_admitted','text_source_ancestors_current','text_source_assert','text_source_authority_assert','text_source_cohort_capture','text_source_complete','text_source_definition','text_source_destination_current','text_source_envelope_valid','text_source_fence','text_source_hash','text_source_insert_guard','text_source_intent_hash','text_source_recheck_authority','text_source_recheck_transaction','text_source_review_assert','text_source_review_cohorts_assert','text_source_review_complete','text_source_review_current','text_source_review_fresh')))
     OR p.oid IN(SELECT tgfoid FROM target_triggers)
  UNION ALL
  SELECT 'trigger',n.nspname||'.'||c.relname||':'||t.tgname,
   jsonb_build_array(pg_get_triggerdef(t.oid,true),t.tgenabled,t.tgdeferrable,t.tginitdeferred)
   FROM target_triggers t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
 ) SELECT encode(sha256(convert_to(coalesce(jsonb_agg(jsonb_build_array(kind,key,value) ORDER BY kind COLLATE "C",key COLLATE "C"),'[]'::jsonb)::text,'UTF8')),'hex') FROM facts
$catalog$;
DO $seal$ DECLARE seal jsonb;BEGIN
 IF whaleu_community.home_policy_catalog_valid() IS DISTINCT FROM true
 OR (SELECT array_agg(slot_id ORDER BY slot_id) FROM whaleu_community.reading_format_slots) IS DISTINCT FROM ARRAY[1,2]
 THEN RAISE EXCEPTION 'Home extension prerequisites incomplete' USING ERRCODE='23514';END IF;
 -- The existing formatter and its public protocol remain unchanged. Only its
 -- explicitly verified source adapter/dependency catalog gains this extension.
 seal:=jsonb_build_object('version',1,'formatter','plain-cjk-slices-v2','generation',1,'migration','0176_durable_reading_formatting.sql','catalog',whaleu_community.reading_format_catalog());
 EXECUTE format('CREATE OR REPLACE FUNCTION whaleu_community.reading_format_protocol() RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS %L','SELECT '||quote_literal(seal::text)||'::jsonb');
 seal:=jsonb_build_object('version',1,'migration','0178_home_publication_protocol.sql','envelopeVersions',jsonb_build_array(7,8),'catalogRevision',1,'catalog',whaleu_community.home_publication_catalog(),'publicationReady',true);
 EXECUTE format('CREATE FUNCTION whaleu_community.home_publication_protocol() RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS %L','SELECT '||quote_literal(seal::text)||'::jsonb');
END $seal$;
-- No activation rows or policy/provider/grant records are inserted here.
-- Raw-role early-constraint-drain then idle COMMIT is not a supported writer.
-- Managed transaction owners perform final rechecks; deadlines are not tokens.
