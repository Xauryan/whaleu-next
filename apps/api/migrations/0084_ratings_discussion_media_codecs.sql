-- Independent codecs only. Historical dispatchers, constraints and owner write
-- paths are not relaxed until atomic publication/Review/Media integration lands.
SET LOCAL lock_timeout='5s';
CREATE FUNCTION whaleu_ratings.discussion_media_capability_shape(c jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
 IF NOT whaleu_community.rating_scoped_keys(c,ARRAY['id','generation','sourceDigest','validUntil'])
 OR NOT whaleu_community.rating_scoped_ids(c,ARRAY['id','generation'])
 OR jsonb_typeof(c->'sourceDigest') IS DISTINCT FROM 'string'
 OR (c->>'sourceDigest' ~ '^[a-f0-9]{64}$') IS NOT TRUE
 OR jsonb_typeof(c->'validUntil') IS DISTINCT FROM 'string'
 OR (c->>'validUntil' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?Z$') IS NOT TRUE
 THEN RETURN false;END IF;
 RETURN isfinite((c->>'validUntil')::timestamptz);
 EXCEPTION WHEN OTHERS THEN RETURN false;
END$$;
CREATE FUNCTION whaleu_ratings.discussion_media_images_shape(images jsonb,maximum integer,with_manifests boolean) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE image jsonb;slot_index integer:=0;keys text[];assets text[]:=ARRAY[]::text[];members text[]:=ARRAY[]::text[];
BEGIN
 IF maximum IS NULL OR with_manifests IS NULL OR maximum NOT IN (3,9) OR jsonb_typeof(images) IS DISTINCT FROM 'array' THEN RETURN false;END IF;
 IF jsonb_array_length(images)>maximum THEN RETURN false;END IF;
 keys:=ARRAY['ordinal','memberId','assetId'];IF with_manifests THEN keys:=keys||ARRAY['manifestDigest'];END IF;
 FOR image IN SELECT value FROM jsonb_array_elements(images) LOOP
  IF NOT whaleu_community.rating_scoped_keys(image,keys)
  OR NOT whaleu_community.rating_scoped_ids(image,ARRAY['memberId','assetId'])
  OR NOT whaleu_community.rating_scoped_integer(image->'ordinal',0)
  OR image->'ordinal' IS DISTINCT FROM to_jsonb(slot_index)
  OR image->>'memberId'=ANY(members) OR image->>'assetId'=ANY(assets)
  OR (with_manifests AND (jsonb_typeof(image->'manifestDigest') IS DISTINCT FROM 'string' OR (image->>'manifestDigest' ~ '^[a-f0-9]{64}$') IS NOT TRUE))
  THEN RETURN false;END IF;
  assets:=array_append(assets,image->>'assetId');members:=array_append(members,image->>'memberId');slot_index:=slot_index+1;
 END LOOP;
 RETURN true;
 EXCEPTION WHEN OTHERS THEN RETURN false;
END$$;
CREATE FUNCTION whaleu_ratings.discussion_media_content_shape(v jsonb,maximum integer,with_manifests boolean) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
 IF NOT whaleu_ratings.discussion_media_images_shape(v->'images',maximum,with_manifests)
 OR jsonb_typeof(v->'body') IS DISTINCT FROM 'string'
 OR NOT whaleu_community.rating_target_edit_text_valid(v->>'body',500,false)
 OR NOT whaleu_community.rating_scoped_ids(v,ARRAY['clientRequestId','draftRevision'])
 OR jsonb_typeof(v->'authorMode') IS DISTINCT FROM 'string'
 OR (v->>'authorMode' IN ('named','anonymous')) IS NOT TRUE
 THEN RETURN false;END IF;
 IF jsonb_array_length(v->'images')=0 THEN
  RETURN coalesce(length(v->>'body')>0 AND v->'batchRequestId'='null'::jsonb AND v->'batchId'='null'::jsonb AND v->'sealedPlanDigest'='null'::jsonb,false);
 END IF;
 RETURN coalesce(whaleu_community.rating_scoped_ids(v,ARRAY['batchRequestId','batchId'])
  AND v->>'batchRequestId'<>v->>'clientRequestId'
  AND jsonb_typeof(v->'sealedPlanDigest')='string' AND v->>'sealedPlanDigest' ~ '^[a-f0-9]{64}$',false);
 EXCEPTION WHEN OTHERS THEN RETURN false;
END$$;
CREATE FUNCTION whaleu_ratings.discussion_media_command_context_shape(c jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT coalesce(whaleu_community.rating_scoped_keys(c,ARRAY['id','tokenDigest','token','selector','scopeRevision','protocolGeneration','catalogRevision','headRevision','sourceDigest','discussionMedia'])
 AND whaleu_community.rating_scoped_ids(c,ARRAY['id','protocolGeneration','catalogRevision','headRevision'])
 AND whaleu_community.rating_scoped_selector_shape(c->'selector')
 AND jsonb_typeof(c->'token')='string' AND c->>'token' ~ '^[A-Za-z0-9_-]{43}$'
 AND jsonb_typeof(c->'tokenDigest')='string' AND c->>'tokenDigest'=encode(sha256(convert_to(c->>'token','UTF8')),'hex')
 AND jsonb_typeof(c->'scopeRevision')='string' AND c->>'scopeRevision' ~ '^[a-f0-9]{64}$'
 AND jsonb_typeof(c->'sourceDigest')='string' AND c->>'sourceDigest' ~ '^[a-f0-9]{64}$'
 AND whaleu_ratings.discussion_media_capability_shape(c->'discussionMedia'),false)
$$;
CREATE FUNCTION whaleu_ratings.discussion_media_intent_valid(i jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE p jsonb;op text;keys text[];maximum integer;
BEGIN
 IF NOT whaleu_community.rating_scoped_keys(i,ARRAY['protocolVersion','operation','context','payload'])
 OR i->'protocolVersion' IS DISTINCT FROM '4'::jsonb OR jsonb_typeof(i->'operation') IS DISTINCT FROM 'string'
 OR NOT whaleu_ratings.discussion_media_command_context_shape(i->'context') THEN RETURN false;END IF;
 op:=i->>'operation';p:=i->'payload';
 IF op NOT IN ('create_comment_scoped','create_reply_scoped') THEN RETURN false;END IF;
 maximum:=CASE WHEN op='create_comment_scoped' THEN 9 ELSE 3 END;
 keys:=ARRAY['clientRequestId','categoryId','expectedCategoryRevision','targetId','expectedTargetRevision','expectedDefinitionRevision','expectedContentVersion','draftRevision','batchRequestId','batchId','sealedPlanDigest','authorMode','body','images'];
 IF op='create_reply_scoped' THEN
  keys:=keys||ARRAY['rootId','expectedRootRevision','replyTo'];
  IF NOT whaleu_community.rating_scoped_ids(p,ARRAY['rootId','expectedRootRevision']) THEN RETURN false;END IF;
  IF (p->'replyTo'='null'::jsonb OR (whaleu_community.rating_scoped_keys(p->'replyTo',ARRAY['replyId','expectedRevision'])
   AND whaleu_community.rating_scoped_ids(p->'replyTo',ARRAY['replyId','expectedRevision']) AND p->'replyTo'->>'replyId'<>p->>'rootId')) IS NOT TRUE THEN RETURN false;END IF;
 END IF;
 RETURN whaleu_community.rating_scoped_keys(p,keys)
  AND whaleu_community.rating_scoped_ids(p,ARRAY['clientRequestId','categoryId','expectedCategoryRevision','targetId','expectedTargetRevision','expectedDefinitionRevision','draftRevision'])
  AND whaleu_community.rating_scoped_integer(p->'expectedContentVersion',1)
  AND whaleu_ratings.discussion_media_content_shape(p,maximum,false);
 EXCEPTION WHEN OTHERS THEN RETURN false;
END$$;
CREATE FUNCTION whaleu_ratings.discussion_media_intent_hash(i jsonb) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT encode(sha256(convert_to('whaleu:rating-discussion-media-command:v1'||chr(10)||whaleu_ratings.creation_canonical_json(jsonb_build_object(
  'protocolVersion',i->'protocolVersion','operation',i->'operation','intent',jsonb_build_object('context',i->'context','payload',i->'payload'))),'UTF8')),'hex')
$$;
CREATE FUNCTION whaleu_community.rating_discussion_attachment_set_digest(images jsonb) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT encode(sha256(convert_to('whaleu:rating-discussion-attachment-set:v1'||chr(10)||whaleu_community.content_canonical_json(images),'UTF8')),'hex')
$$;
CREATE FUNCTION whaleu_community.rating_discussion_media_envelope_shape(e jsonb,op text) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE keys text[];maximum integer;
BEGIN
 IF op IS NULL OR jsonb_typeof(e->'purpose') IS DISTINCT FROM 'string' OR e->'version' IS DISTINCT FROM '7'::jsonb OR e->>'purpose' IS DISTINCT FROM op
 OR op NOT IN ('publish_rating_comment_media_scoped','publish_rating_reply_media_scoped') THEN RETURN false;END IF;
 maximum:=CASE WHEN op='publish_rating_comment_media_scoped' THEN 9 ELSE 3 END;
 keys:=ARRAY['version','purpose','accountId','clientRequestId','targetId','targetRevision','categoryId','categoryRevision','scope','discussionMedia','targetOrigin','targetDefinitionRevision','targetContentVersion','subjectId','subjectRevision','draftRevision','batchRequestId','batchId','sealedPlanDigest','authorMode','body','images','attachmentSetDigest'];
 IF NOT whaleu_community.rating_scoped_ids(e,ARRAY['accountId','clientRequestId','targetId','targetRevision','categoryId','categoryRevision','targetDefinitionRevision','subjectId','subjectRevision','draftRevision'])
 OR NOT whaleu_community.rating_scoped_integer(e->'targetContentVersion',1)
 OR NOT whaleu_community.rating_scoped_scope_shape(e->'scope')
 OR NOT whaleu_ratings.discussion_media_capability_shape(e->'discussionMedia')
 OR NOT whaleu_community.rating_scoped_keys(e->'targetOrigin',ARRAY['regionId','originCampusId'])
 OR NOT whaleu_community.rating_scoped_nullable_id(e->'targetOrigin'->'regionId')
 OR NOT whaleu_community.rating_scoped_nullable_id(e->'targetOrigin'->'originCampusId')
 OR NOT whaleu_ratings.discussion_media_content_shape(e,maximum,true)
 OR jsonb_typeof(e->'attachmentSetDigest') IS DISTINCT FROM 'string'
 OR e->>'attachmentSetDigest' IS DISTINCT FROM whaleu_community.rating_discussion_attachment_set_digest(e->'images')
 THEN RETURN false;END IF;
 IF op='publish_rating_reply_media_scoped' THEN
  keys:=keys||ARRAY['rootId','rootRevision','replyTo'];
  IF NOT whaleu_community.rating_scoped_ids(e,ARRAY['rootId','rootRevision']) OR e->>'rootId'=e->>'subjectId'
  OR (e->'replyTo'='null'::jsonb OR (whaleu_community.rating_scoped_keys(e->'replyTo',ARRAY['replyId','revision'])
   AND whaleu_community.rating_scoped_ids(e->'replyTo',ARRAY['replyId','revision']) AND e->'replyTo'->>'replyId'<>e->>'rootId'
   AND e->'replyTo'->>'replyId'<>e->>'subjectId')) IS NOT TRUE THEN RETURN false;END IF;
 END IF;
 RETURN whaleu_community.rating_scoped_keys(e,keys);
 EXCEPTION WHEN OTHERS THEN RETURN false;
END$$;
CREATE FUNCTION whaleu_community.rating_discussion_media_approval_digest(e jsonb) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT encode(sha256(convert_to('whaleu-rating-content-approval:v7'||chr(10)||whaleu_community.content_canonical_json(e),'UTF8')),'hex')
$$;
