-- Nickname-only, content-bound moderation. No grants, providers, crosswalks or
-- production source acceptance are created. Prior migration bytes remain intact.
CREATE FUNCTION whaleu_community.profile_moderation_nodes(target_kind text,target uuid)
RETURNS TABLE(kind text,id uuid,post_id uuid,root_id uuid,account_id uuid,author_mode text,payload jsonb,tuple_version text)
LANGUAGE sql STABLE AS $$
 WITH reference AS (
 SELECT p.id post_id,NULL::uuid root_id FROM whaleu_community.posts p WHERE target_kind='post' AND p.id=target
 UNION ALL SELECT c.post_id,c.id FROM whaleu_community.root_comments c WHERE target_kind='comment' AND c.id=target
 UNION ALL SELECT r.post_id,r.root_comment_id FROM whaleu_community.replies r WHERE target_kind='reply' AND r.id=target
 )
 SELECT 'post',p.id,p.id,NULL::uuid,p.account_id,p.author_mode,to_jsonb(p),p.xmin::text FROM reference q JOIN whaleu_community.posts p ON p.id=q.post_id
 UNION ALL SELECT 'comment',c.id,c.post_id,c.id,c.account_id,c.author_mode,to_jsonb(c),c.xmin::text FROM reference q JOIN whaleu_community.root_comments c ON c.id=q.root_id AND c.post_id=q.post_id
 UNION ALL SELECT 'reply',r.id,r.post_id,r.root_comment_id,r.account_id,r.author_mode,to_jsonb(r),r.xmin::text FROM reference q JOIN whaleu_community.replies r ON r.id=target AND r.post_id=q.post_id AND r.root_comment_id=q.root_id WHERE target_kind='reply'
$$;
CREATE FUNCTION whaleu_community.profile_moderation_target(target_kind text,target uuid)
RETURNS TABLE(subject_id uuid,post_id uuid,root_id uuid,region_id uuid) LANGUAGE sql STABLE AS $$
 SELECT n.account_id,n.post_id,n.root_id,s.operating_region_id FROM whaleu_community.profile_moderation_nodes(target_kind,target) n
 JOIN whaleu_community.posts p ON p.id=n.post_id JOIN whaleu_community.spaces s ON s.id=p.space_id
 JOIN whaleu_community.content_approval_bindings b ON b.content_kind='post' AND b.content_id=p.id
 WHERE n.kind=target_kind AND n.id=target AND n.author_mode='named'
 AND s.kind='regional' AND s.is_active AND s.operating_region_id IS NOT NULL
 AND b.scope->>'sync'='none' AND b.scope->>'originalSpaceId'=s.id::text AND b.scope->>'originalRegionId'=s.operating_region_id::text
 AND EXISTS(SELECT 1 FROM whaleu_campus.operating_regions r WHERE r.id=s.operating_region_id AND r.is_active)
$$;
CREATE FUNCTION whaleu_profile.moderation_grant_allowed(actor uuid,selected uuid,region uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM whaleu_authorization.role_grants g WHERE g.id=selected AND g.account_id=actor
 AND g.revoked_at IS NULL AND g.valid_from<=clock_timestamp() AND (g.expires_at IS NULL OR g.expires_at>clock_timestamp())
 AND ((g.role='super_admin' AND g.operating_region_id IS NULL) OR (g.role='school_admin' AND g.operating_region_id=region)))
$$;
CREATE FUNCTION whaleu_profile.moderation_hash(value jsonb) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT encode(sha256(convert_to(whaleu_community.content_canonical_json(value),'UTF8')),'hex')
$$;
CREATE FUNCTION whaleu_profile.moderation_identity_facts(actor uuid,session uuid,token text) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object(
 'account',(SELECT jsonb_build_array(to_jsonb(a),a.xmin::text,a.ctid::text) FROM whaleu_identity.accounts a WHERE a.id=actor),
 'session',(SELECT jsonb_build_array(to_jsonb(s),s.xmin::text,s.ctid::text) FROM whaleu_identity.sessions s WHERE s.id=session AND s.account_id=actor),
 'token',(SELECT jsonb_build_array(to_jsonb(t),t.xmin::text,t.ctid::text) FROM whaleu_identity.access_tokens t WHERE t.token_hash=token AND t.session_id=session))
$$;
CREATE FUNCTION whaleu_profile.moderation_identity_current(actor uuid,session uuid,token text) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM whaleu_identity.accounts a JOIN whaleu_identity.sessions s ON s.account_id=a.id JOIN whaleu_identity.access_tokens t ON t.session_id=s.id
 WHERE a.id=actor AND a.status='active' AND s.id=session AND s.revoked_at IS NULL AND s.absolute_expires_at>clock_timestamp() AND t.token_hash=token AND t.expires_at>clock_timestamp())
$$;
-- A digest retains exact input rows, including mutable xmin and independent owner
-- epochs, without persisting phone/verification values in the moderation audit.
CREATE FUNCTION whaleu_profile.moderation_input_facts(actor uuid,selected uuid,target_kind text,target uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object(
 'grant',(SELECT jsonb_build_array(to_jsonb(g),g.xmin::text,g.ctid::text) FROM whaleu_authorization.role_grants g WHERE g.id=selected),
 'nodes',(SELECT jsonb_agg(jsonb_build_array(n.kind,n.payload,n.tuple_version,b,d,h,e,pol,o,q) ORDER BY n.kind,n.id)
 FROM whaleu_community.profile_moderation_nodes(target_kind,target) n
 LEFT JOIN whaleu_community.content_approval_bindings b ON b.content_kind=n.kind AND b.content_id=n.id
 LEFT JOIN whaleu_community.content_approval_decisions d ON d.id=b.decision_id
 LEFT JOIN whaleu_community.content_approval_heads h ON h.decision_id=d.id
 LEFT JOIN whaleu_community.content_approval_events e ON (e.id,e.decision_id)=(h.event_id,d.id)
 LEFT JOIN whaleu_community.content_approval_policies pol ON pol.id=d.policy_revision_id
 LEFT JOIN whaleu_community.report_origins o ON o.kind=n.kind AND o.target_id=n.id
 LEFT JOIN whaleu_community.publication_requests q ON (q.account_id,q.client_request_id)=(o.owner_account_id,o.source_request_id)),
 'phone',(SELECT jsonb_build_array(to_jsonb(h),h.xmin::text,h.ctid::text,to_jsonb(s),to_jsonb(a)) FROM whaleu_verification.account_heads h JOIN whaleu_verification.snapshots s ON s.id=h.snapshot_id JOIN whaleu_verification.assertions a ON a.id=s.phone_assertion_id WHERE h.account_id=actor),
 'media',CASE WHEN EXISTS(SELECT 1 FROM whaleu_community.profile_moderation_nodes(target_kind,target) n JOIN whaleu_community.content_approval_bindings b ON b.content_kind=n.kind AND b.content_id=n.id WHERE b.envelope->'images'<>'[]'::jsonb) THEN (SELECT jsonb_agg(jsonb_build_array(slot,version,epoch::text) ORDER BY slot) FROM whaleu_media.media_owner_states) ELSE NULL END,
 'community',(SELECT jsonb_agg(jsonb_build_array(slot,version,epoch::text) ORDER BY slot) FROM whaleu_community.discovery_count_epochs),
 'safety',(SELECT jsonb_agg(jsonb_build_array(slot,version,epoch::text) ORDER BY slot) FROM whaleu_safety.discovery_count_epochs),
 'campus',(SELECT jsonb_agg(jsonb_build_array(slot,version,epoch::text) ORDER BY slot) FROM whaleu_campus.discovery_count_epochs))
$$;
CREATE FUNCTION whaleu_profile.moderation_avatar_facts(subject uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT coalesce((SELECT jsonb_build_array(to_jsonb(c),c.xmin::text,c.ctid::text,to_jsonb(d)) FROM whaleu_profile.avatar_current c JOIN whaleu_profile.avatar_definitions d ON d.id=c.appearance_id AND d.actor_id=c.actor_id WHERE c.actor_id=subject),'null'::jsonb)
$$;
CREATE FUNCTION whaleu_profile.moderation_actor_current(
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

CREATE FUNCTION whaleu_profile.moderation_trim(value text) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT btrim(value,U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')
$$;
CREATE FUNCTION whaleu_profile.moderation_text_valid(value text,maximum integer) RETURNS boolean LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT char_length(value)<=maximum AND value !~ U&'[\0001-\0008\000B-\001F\007F-\009F]'
$$;
CREATE FUNCTION whaleu_profile.moderation_uuid_valid(value text) RETURNS boolean LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' OR value IN('00000000-0000-0000-0000-000000000000','ffffffff-ffff-ffff-ffff-ffffffffffff')
$$;
CREATE FUNCTION whaleu_community.profile_moderation_scope_valid(value jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE key text;BEGIN
 IF whaleu_community.post_owner_visibility_keys(value,ARRAY['originalSpaceId','originalRegionId','authorOriginRegionId','identityRegionId','topologySnapshotId','sync','configurationRevisionId','identityCampusId','identitySelectionId','affiliationSnapshotId','affiliationAssertionId']) IS DISTINCT FROM true
 OR value->>'sync' IS DISTINCT FROM 'none' OR jsonb_typeof(value->'originalSpaceId') IS DISTINCT FROM 'string' THEN RETURN false;END IF;
 FOR key IN SELECT k FROM jsonb_object_keys(value) AS k WHERE k<>'sync' LOOP
  IF (key='originalSpaceId' OR value->key<>'null'::jsonb) AND (jsonb_typeof(value->key) IS DISTINCT FROM 'string' OR whaleu_profile.moderation_uuid_valid(value->>key) IS DISTINCT FROM true) THEN RETURN false;END IF;
 END LOOP;RETURN true;END$$;
CREATE FUNCTION whaleu_media.profile_moderation_locator_valid(value jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT coalesce(whaleu_community.post_owner_visibility_keys(value,ARRAY['provider','environment','bucket','key','version'])
 AND value->>'provider' ~ '^[a-z][a-z0-9-]{0,31}$' AND value->>'environment' ~ '^[a-z][a-z0-9-]{0,63}$' AND value->>'bucket' ~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$'
 AND NOT EXISTS(SELECT 1 FROM jsonb_each(value) p WHERE jsonb_typeof(p.value)<>'string')
 AND NOT EXISTS(SELECT 1 FROM jsonb_each_text(value) p WHERE p.key IN('key','version') AND
 (char_length(p.value)<1 OR p.value ~ U&'[\0001-\001F\007F]' OR char_length(p.value)>1024)),false)
$$;
-- Reconstruct the immutable publication payload just as the existing content
-- definition owner does. Trading, poll and formation are not excluded by this
-- profile action, but a mismatched accepted envelope never becomes authority.
CREATE FUNCTION whaleu_community.profile_moderation_definition(target_kind text,target uuid,scope jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE n record;p whaleu_community.posts;poll whaleu_community.polls;formation whaleu_community.formations;creator whaleu_community.formation_members;listing whaleu_community.trading_listings;
 images jsonb;component jsonb:='{"kind":"none"}'::jsonb;trading jsonb:='null'::jsonb;options jsonb;result jsonb;version integer;valid boolean;BEGIN
 SELECT * INTO n FROM whaleu_community.profile_moderation_nodes(target_kind,target) WHERE kind=target_kind AND id=target;
 IF n.id IS NULL THEN RETURN NULL;END IF;
 SELECT * INTO p FROM whaleu_community.posts WHERE id=n.post_id;
 IF p.id IS NULL OR p.publication_state<>'published' OR whaleu_community.profile_moderation_scope_valid(scope) IS DISTINCT FROM true
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
    OR EXISTS(SELECT 1 FROM (VALUES(creator.wechat,100),(creator.qq,50),(creator.phone,20)) c(value,maximum) WHERE value IS DISTINCT FROM whaleu_profile.moderation_trim(value) OR octet_length(value)>maximum OR whaleu_profile.moderation_text_valid(value,maximum) IS DISTINCT FROM true)
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
 version:=CASE WHEN target_kind='post' THEN p.publication_envelope_version ELSE 1 END;
 IF version NOT IN(1,2) OR p.feedback IS NOT NULL OR (target_kind='post' AND ((version=1 AND p.allow_anonymous_dm IS NOT NULL) OR (version=2 AND (p.author_mode<>'named' OR p.allow_anonymous_dm IS NULL)))) THEN RETURN NULL;END IF;
 result:=jsonb_build_object('version',version,'accountId',n.account_id,'purpose',CASE target_kind WHEN 'post' THEN 'publish_post' WHEN 'comment' THEN 'publish_comment' ELSE 'publish_reply' END,
  'spaceId',p.space_id,'category',p.category,'authorMode',n.author_mode,'commentsPolicy',p.comments_policy,
  'postId',CASE WHEN target_kind='post' THEN NULL ELSE p.id END,'rootCommentId',CASE WHEN target_kind='reply' THEN n.root_id ELSE NULL END,'targetReplyId',CASE WHEN target_kind='reply' THEN n.payload->'target_reply_id' ELSE 'null'::jsonb END,
  'text',n.payload->>'text','images',images,'component',component,'trading',trading,'scope',scope);
 IF version=2 THEN result:=result||jsonb_build_object('allowAnonymousDm',p.allow_anonymous_dm);END IF;
 RETURN result;END$$;
-- The ordinary Community owner still proves Media through its required proof.
-- Raw command causality independently rejects absent/detached/revoked media.
CREATE FUNCTION whaleu_community.profile_moderation_media_current(kind text,content uuid,images jsonb) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT coalesce(jsonb_typeof(images)='array'
 AND jsonb_array_length(images)=(SELECT count(*) FROM whaleu_media.bindings WHERE owner_kind='community' AND resource_kind=kind AND resource_id=content AND content_version=1 AND slot='images' AND detached_at IS NULL)
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(images) WITH ORDINALITY image(value,ordinal) WHERE NOT EXISTS(
  SELECT 1 FROM whaleu_media.bindings b JOIN whaleu_media.assets a ON a.id=b.asset_id JOIN whaleu_media.upload_intents i ON i.id=a.intent_id
  JOIN whaleu_media.asset_safety_heads h ON h.asset_id=a.id JOIN whaleu_media.asset_safety_events e ON (e.asset_id,e.revision,e.id)=(h.asset_id,h.revision,h.event_id)
  WHERE b.owner_kind='community' AND b.resource_kind=kind AND b.resource_id=content AND b.content_version=1 AND b.slot='images' AND b.detached_at IS NULL
  AND b.ordinal=image.ordinal-1 AND b.asset_id::text=image.value->>'assetId' AND b.manifest_digest=image.value->>'digest'
  AND a.audience='content-gated' AND a.owner_kind=b.owner_kind AND a.resource_kind=kind AND a.content_version=1 AND a.slot='images'
  AND a.purpose='community-'||kind||'-image' AND a.manifest_digest=b.manifest_digest
  AND a.manifest_digest=encode(sha256(convert_to(E'whaleu-media-manifest:v1\n'||whaleu_media.canonical_json(a.manifest),'UTF8')),'hex')
  AND a.manifest->>'policyVersion'=a.policy_revision
  AND whaleu_media.profile_moderation_locator_valid(a.manifest->'original'->'object')
  AND whaleu_media.profile_moderation_locator_valid(a.manifest->'variants'->0->'object')
  AND whaleu_media.profile_moderation_locator_valid(a.manifest->'variants'->1->'object') AND i.state='ready' AND e.state='allow' AND e.manifest_digest=a.manifest_digest AND e.policy_revision=a.policy_revision
  AND isfinite(e.effective_at) AND e.effective_at<=clock_timestamp() AND isfinite(e.valid_until) AND e.valid_until>clock_timestamp())),false)
$$;
CREATE FUNCTION whaleu_community.profile_moderation_supported(actor uuid,target_kind text,target uuid) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE target_row record;n record;b whaleu_community.content_approval_bindings;category_head whaleu_community.post_category_heads;
 count_nodes integer:=0;BEGIN
 SELECT * INTO target_row FROM whaleu_community.profile_moderation_target(target_kind,target);
 IF target_row.subject_id IS NULL THEN RETURN false;END IF;
 IF EXISTS(SELECT 1 FROM whaleu_community.post_owner_visibility WHERE post_id=target_row.post_id AND owner_hidden) THEN RETURN false;END IF;
 FOR n IN SELECT * FROM whaleu_community.profile_moderation_nodes(target_kind,target) LOOP
  count_nodes:=count_nodes+1;
  IF n.payload->>'visibility' IS DISTINCT FROM 'approved' OR n.payload->>'deleted_at' IS NOT NULL THEN RETURN false;END IF;
  SELECT * INTO b FROM whaleu_community.content_approval_bindings WHERE content_kind=n.kind AND content_id=n.id;
  IF b.content_id IS NULL OR b.content_version<>1 OR b.account_id<>n.account_id
   OR b.envelope->>'accountId' IS DISTINCT FROM n.account_id::text OR b.envelope->>'authorMode' IS DISTINCT FROM n.author_mode
   OR b.envelope->>'text' IS DISTINCT FROM n.payload->>'text' OR b.scope IS DISTINCT FROM b.envelope->'scope'
   OR b.envelope IS DISTINCT FROM whaleu_community.profile_moderation_definition(n.kind,n.id,b.scope)
   OR b.scope->>'sync' IS DISTINCT FROM 'none' OR b.scope->>'originalRegionId' IS DISTINCT FROM target_row.region_id::text
   OR b.scope->>'originalSpaceId' IS DISTINCT FROM (SELECT space_id::text FROM whaleu_community.posts WHERE id=n.post_id)
   OR whaleu_community.profile_moderation_media_current(n.kind,n.id,b.envelope->'images') IS DISTINCT FROM true
   OR (n.kind='post' AND (b.envelope->>'spaceId' IS DISTINCT FROM n.payload->>'space_id' OR b.envelope->>'category' IS DISTINCT FROM n.payload->>'category' OR b.envelope->>'commentsPolicy' IS DISTINCT FROM n.payload->>'comments_policy'))
   OR (n.kind<>'post' AND b.envelope->>'postId' IS DISTINCT FROM n.post_id::text)
   OR (n.kind='reply' AND (b.envelope->>'rootCommentId' IS DISTINCT FROM n.root_id::text OR b.envelope->>'targetReplyId' IS DISTINCT FROM n.payload->>'target_reply_id'))
   OR NOT EXISTS(SELECT 1 FROM whaleu_community.content_approval_decisions d JOIN whaleu_community.content_approval_heads h ON h.decision_id=d.id JOIN whaleu_community.content_approval_events e ON (e.id,e.decision_id)=(h.event_id,d.id) JOIN whaleu_community.content_approval_policies p ON p.id=d.policy_revision_id
    WHERE d.id=b.decision_id AND d.envelope=b.envelope AND d.digest=b.digest AND d.account_id=b.account_id AND d.operation=b.operation
    AND d.result='allow' AND d.coverage='complete' AND d.provenance='accepted' AND d.evaluated_at<=clock_timestamp()
    AND whaleu_profile.moderation_trim(d.issuer)<>'' AND whaleu_profile.moderation_trim(d.provenance_ref)<>''
    AND whaleu_profile.moderation_trim(e.issuer)<>'' AND whaleu_profile.moderation_trim(e.provenance_ref)<>''
    AND whaleu_profile.moderation_trim(p.issuer)<>'' AND whaleu_profile.moderation_trim(p.provenance_ref)<>''
    AND e.state='allow' AND e.coverage='complete' AND e.provenance='accepted' AND e.occurred_at>=d.evaluated_at AND e.occurred_at<=clock_timestamp()
    AND (d.visibility_until IS NULL OR d.visibility_until>clock_timestamp())
    AND p.coverage='complete' AND p.provenance='accepted' AND p.valid_from<=d.evaluated_at AND (p.valid_until IS NULL OR p.valid_until>clock_timestamp()))
   OR NOT EXISTS(SELECT 1 FROM whaleu_community.report_origins o JOIN whaleu_community.publication_requests q ON (q.account_id,q.client_request_id)=(o.owner_account_id,o.source_request_id)
    WHERE o.kind=n.kind AND o.target_id=n.id AND o.owner_account_id=n.account_id AND o.provenance='native_publication'
    AND q.operation=CASE n.kind WHEN 'post' THEN 'publish_post' WHEN 'comment' THEN 'publish_comment' ELSE 'publish_reply' END AND q.receipt->>'outcome'='created' AND q.receipt->>'resourceId'=n.id::text)
  THEN RETURN false;END IF;
  -- Parent direct reads require both directions; child detail projection keeps
  -- the existing outgoing-only relationship rule. Anonymous ancestry is valid.
  IF n.author_mode='named' AND n.account_id<>actor THEN
   IF NOT EXISTS(SELECT 1 FROM whaleu_safety.account_heads s WHERE s.account_id=actor AND s.block_coverage='complete' AND s.provenance<>'unknown' AND (s.valid_until IS NULL OR s.valid_until>clock_timestamp()))
   OR EXISTS(SELECT 1 FROM whaleu_safety.blocks WHERE blocker_id=actor AND blocked_id=n.account_id AND active)
   OR (n.kind='post' AND (NOT EXISTS(SELECT 1 FROM whaleu_safety.account_heads s WHERE s.account_id=n.account_id AND s.block_coverage='complete' AND s.provenance<>'unknown' AND (s.valid_until IS NULL OR s.valid_until>clock_timestamp()))
    OR EXISTS(SELECT 1 FROM whaleu_safety.blocks WHERE blocker_id=n.account_id AND blocked_id=actor AND active))) THEN RETURN false;END IF;
  END IF;
 END LOOP;
 IF count_nodes<>(CASE target_kind WHEN 'post' THEN 1 WHEN 'comment' THEN 2 WHEN 'reply' THEN 3 ELSE 0 END) THEN RETURN false;END IF;
 SELECT * INTO category_head FROM whaleu_community.post_category_heads WHERE post_id=target_row.post_id;
 IF category_head.post_id IS NOT NULL THEN
  IF NOT EXISTS(SELECT 1 FROM whaleu_community.post_category_live WHERE post_id=category_head.post_id) THEN RETURN false;END IF;
  FOR n IN SELECT * FROM whaleu_community.profile_moderation_nodes(target_kind,target) WHERE kind<>'post' LOOP
   IF NOT EXISTS(SELECT 1 FROM whaleu_community.post_category_live live JOIN whaleu_community.post_category_policies pol ON pol.id=live.policy_id
    JOIN whaleu_community.content_approval_bindings original ON original.content_kind=n.kind AND original.content_id=n.id
    LEFT JOIN whaleu_community.post_category_child_bindings c ON c.content_kind=n.kind AND c.content_id=n.id AND c.post_id=n.post_id
    LEFT JOIN whaleu_community.post_category_review_live r ON r.id=c.review_id AND r.purpose='community_child_current_parent_classification'
    WHERE live.post_id=n.post_id AND (CASE WHEN c.content_id IS NULL THEN pol.definition->'continueDescendants'='true'::jsonb ELSE c.original_decision_id=original.decision_id AND c.original_digest=original.digest AND r.id IS NOT NULL AND (c.event_id=category_head.event_id OR pol.definition->'continueDescendants'='true'::jsonb) END)
    AND (original.envelope->'images'='[]'::jsonb OR pol.definition->>'descendantMedia'='retain_current_media_proof')) THEN RETURN false;END IF;
  END LOOP;
 END IF;
 RETURN true;END$$;
CREATE TABLE whaleu_profile.moderation_commands (
 actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),request_id uuid NOT NULL,
 session_id uuid NOT NULL REFERENCES whaleu_identity.sessions(id),token_hash text NOT NULL,
 target_kind text NOT NULL CHECK(target_kind IN('post','comment','reply')),target_id uuid NOT NULL,
 intent_hash text NOT NULL,command jsonb NOT NULL,receipt jsonb NOT NULL,
 -- Nullable FKs still open the referenced relation in PostgreSQL. The positive
 -- command guard proves these exact rows; applied event/transition FKs retain
 -- them. Keeping the command metadata FK-free makes first cancellation depend
 -- only on actor/session/token, even while grant/content/Profile tables are locked.
 grant_id uuid,subject_id uuid,
 post_id uuid,root_id uuid,original_region_id uuid,
 identity_hash text NOT NULL,input_hash text,
 before_revision integer,before_nickname text,before_hash text,before_fingerprint text,unchanged_hash text,avatar_hash text,
 mutation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 PRIMARY KEY(actor_id,request_id),
 CHECK(request_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
 CHECK(octet_length(command::text)<4096 AND octet_length(receipt::text)<4096),
 CHECK(intent_hash=encode(sha256(convert_to('whaleu:profile-moderation-command:v1'||chr(10)||whaleu_community.content_canonical_json(jsonb_build_object('actor',actor_id::text,'command',command)),'UTF8')),'hex'))
);
CREATE INDEX moderation_commands_transaction ON whaleu_profile.moderation_commands(mutation_transaction,subject_id);
CREATE TABLE whaleu_profile.moderation_transitions (
 actor_id uuid NOT NULL,request_id uuid NOT NULL,subject_id uuid NOT NULL REFERENCES whaleu_profile.profiles(account_id),
 before_revision integer NOT NULL,after_revision integer NOT NULL,before_nickname text,after_nickname text NOT NULL,
 before_hash text NOT NULL,after_hash text NOT NULL,unchanged_hash text NOT NULL,
 mutation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),PRIMARY KEY(actor_id,request_id),
 FOREIGN KEY(actor_id,request_id) REFERENCES whaleu_profile.moderation_commands(actor_id,request_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE whaleu_profile.moderation_events (
 id uuid PRIMARY KEY,actor_id uuid NOT NULL,request_id uuid NOT NULL,subject_id uuid NOT NULL REFERENCES whaleu_profile.profiles(account_id),
 target_kind text NOT NULL,target_id uuid NOT NULL,post_id uuid NOT NULL,root_id uuid,original_region_id uuid NOT NULL,
 grant_id uuid NOT NULL REFERENCES whaleu_authorization.role_grants(id),selected_authority jsonb NOT NULL,
 before_revision integer NOT NULL,revision integer NOT NULL,old_nickname text,nickname text NOT NULL CHECK(nickname ~ '^违规昵称[A-Za-z0-9]{6}$'),
 recorded_at timestamptz NOT NULL CHECK(isfinite(recorded_at) AND recorded_at=date_trunc('milliseconds',recorded_at)),
 mutation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 UNIQUE(actor_id,request_id),UNIQUE(subject_id,revision),
 FOREIGN KEY(actor_id,request_id) REFERENCES whaleu_profile.moderation_commands(actor_id,request_id) DEFERRABLE INITIALLY DEFERRED,
 CHECK(before_revision BETWEEN 0 AND 2147483646 AND revision=before_revision+1)
);
CREATE TABLE whaleu_notifications.profile_moderation_notices (
 id uuid PRIMARY KEY,event_id uuid NOT NULL UNIQUE REFERENCES whaleu_profile.moderation_events(id),
 recipient_account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),kind text NOT NULL DEFAULT 'profile_nickname_reset' CHECK(kind='profile_nickname_reset'),
 nickname text NOT NULL CHECK(nickname ~ '^违规昵称[A-Za-z0-9]{6}$'),
 created_at timestamptz NOT NULL CHECK(isfinite(created_at) AND created_at=date_trunc('milliseconds',created_at)),read_at timestamptz,
 CHECK(read_at IS NULL OR (isfinite(read_at) AND read_at>=created_at AND read_at=date_trunc('milliseconds',read_at)))
);
CREATE INDEX profile_moderation_notice_page ON whaleu_notifications.profile_moderation_notices(recipient_account_id,created_at DESC,id DESC);
CREATE INDEX profile_moderation_notice_unread ON whaleu_notifications.profile_moderation_notices(recipient_account_id) WHERE read_at IS NULL;
CREATE FUNCTION whaleu_profile.moderation_immutable() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'Profile moderation evidence is immutable' USING ERRCODE='23514',CONSTRAINT='profile_moderation_causal';END$$;
DO $$DECLARE name text;BEGIN FOREACH name IN ARRAY ARRAY['moderation_commands','moderation_events','moderation_transitions'] LOOP
 EXECUTE format('CREATE TRIGGER moderation_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON whaleu_profile.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_profile.moderation_immutable()',name);
END LOOP;END$$;
CREATE FUNCTION whaleu_profile.moderation_command_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_row record;p whaleu_profile.profiles;BEGIN
 IF current_setting('transaction_isolation')<>'read committed' OR NEW.mutation_transaction<>pg_current_xact_id()
 OR whaleu_community.post_owner_visibility_keys(NEW.command,ARRAY['clientRequestId','target','expectedProfileRevision','action']) IS DISTINCT FROM true
 OR whaleu_community.post_owner_visibility_keys(NEW.command->'target',ARRAY['kind','id']) IS DISTINCT FROM true
 OR NOT whaleu_profile.moderation_uuid_valid(NEW.target_id::text)
 OR NEW.command->>'clientRequestId' IS DISTINCT FROM NEW.request_id::text
 OR NEW.command->'target'->>'kind' IS DISTINCT FROM NEW.target_kind OR NEW.command->'target'->>'id' IS DISTINCT FROM NEW.target_id::text
 OR NEW.command->>'action' IS DISTINCT FROM 'reset_nickname'
 OR (jsonb_typeof(NEW.command->'expectedProfileRevision')='number' AND (NEW.command->>'expectedProfileRevision')~'^(0|[1-9][0-9]{0,9})$' AND (NEW.command->>'expectedProfileRevision')::numeric BETWEEN 0 AND 2147483646) IS DISTINCT FROM true
 OR NEW.receipt->>'requestId' IS DISTINCT FROM NEW.request_id::text OR NEW.receipt->'target' IS DISTINCT FROM NEW.command->'target'
 OR NEW.receipt->>'action' IS DISTINCT FROM 'reset_nickname' OR NEW.receipt->'expectedProfileRevision' IS DISTINCT FROM NEW.command->'expectedProfileRevision'
 OR whaleu_community.post_owner_visibility_keys(NEW.receipt,CASE WHEN NEW.receipt->>'outcome'='rejected' THEN ARRAY['requestId','target','expectedProfileRevision','action','outcome','code'] ELSE ARRAY['requestId','target','expectedProfileRevision','action','outcome','revision','eventId','recordedAt'] END) IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'Strict exact nickname command required' USING ERRCODE='23514',CONSTRAINT='profile_moderation_causal';END IF;
 IF NEW.receipt->>'outcome'='rejected' THEN
  IF coalesce(NEW.receipt->>'code' IN('PROFILE_MODERATION_STALE','PROFILE_MODERATION_CANCELLED'),false)=false THEN RAISE EXCEPTION 'Exact terminal nickname rejection required' USING ERRCODE='23514',CONSTRAINT='profile_moderation_causal';END IF;
 ELSE
  IF NEW.receipt->>'outcome' IS DISTINCT FROM 'applied' OR NEW.receipt->'revision' IS DISTINCT FROM to_jsonb((NEW.command->>'expectedProfileRevision')::integer+1)
  OR (jsonb_typeof(NEW.receipt->'eventId')='string' AND whaleu_profile.moderation_uuid_valid(NEW.receipt->>'eventId')) IS DISTINCT FROM true
  OR (jsonb_typeof(NEW.receipt->'recordedAt')='string' AND (NEW.receipt->>'recordedAt')~'^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]([.][0-9]{1,3})?Z$') IS DISTINCT FROM true
  OR (NEW.receipt->>'recordedAt')::timestamptz>clock_timestamp()
  THEN RAISE EXCEPTION 'Exact applied nickname receipt required' USING ERRCODE='23514',CONSTRAINT='profile_moderation_causal';END IF;
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('whaleu:profile-moderation-request:v1:'||NEW.actor_id::text||':'||NEW.request_id::text,0));
 PERFORM id FROM whaleu_identity.accounts WHERE id=NEW.actor_id FOR SHARE;
 PERFORM id FROM whaleu_identity.sessions WHERE id=NEW.session_id AND account_id=NEW.actor_id FOR SHARE;
 PERFORM token_hash FROM whaleu_identity.access_tokens WHERE token_hash=NEW.token_hash AND session_id=NEW.session_id FOR SHARE;
 IF NOT whaleu_profile.moderation_identity_current(NEW.actor_id,NEW.session_id,NEW.token_hash) THEN RAISE EXCEPTION 'Current actor required' USING ERRCODE='23514',CONSTRAINT='profile_moderation_causal';END IF;
 NEW.identity_hash:=whaleu_profile.moderation_hash(whaleu_profile.moderation_identity_facts(NEW.actor_id,NEW.session_id,NEW.token_hash));
 IF NEW.receipt->>'code'='PROFILE_MODERATION_CANCELLED' THEN
  IF NEW.grant_id IS NOT NULL THEN RAISE EXCEPTION 'Cancellation is only original key metadata' USING ERRCODE='23514',CONSTRAINT='profile_moderation_causal';END IF;
  NEW.subject_id:=NULL;NEW.post_id:=NULL;NEW.root_id:=NULL;NEW.original_region_id:=NULL;NEW.input_hash:=NULL;NEW.before_revision:=NULL;NEW.before_nickname:=NULL;NEW.before_hash:=NULL;NEW.before_fingerprint:=NULL;NEW.unchanged_hash:=NULL;NEW.avatar_hash:=NULL;
  RETURN NEW;
 END IF;
 IF current_setting('max_connections')::integer+current_setting('max_prepared_transactions')::integer+current_setting('max_worker_processes')::integer+current_setting('max_wal_senders')::integer>=128
 OR NOT (SELECT count(*)=128 AND min(slot)=0 AND max(slot)=127 AND bool_and(version=1) FROM whaleu_community.discovery_count_epochs)
 OR NOT (SELECT count(*)=128 AND min(slot)=0 AND max(slot)=127 AND bool_and(version=1) FROM whaleu_safety.discovery_count_epochs)
 OR NOT (SELECT count(*)=128 AND min(slot)=0 AND max(slot)=127 AND bool_and(version=1) FROM whaleu_campus.discovery_count_epochs)
 THEN RAISE EXCEPTION 'Existing bounded owner epoch admission required' USING ERRCODE='23514',CONSTRAINT='profile_moderation_causal';END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('whaleu:named-block-policy:v1',0));
 SELECT * INTO target_row FROM whaleu_community.profile_moderation_target(NEW.target_kind,NEW.target_id);
 IF target_row.subject_id IS NULL THEN RAISE EXCEPTION 'Named original regional target required' USING ERRCODE='23514',CONSTRAINT='profile_moderation_causal';END IF;
 PERFORM id FROM whaleu_community.posts WHERE id=target_row.post_id FOR UPDATE;
 IF target_row.root_id IS NOT NULL THEN PERFORM id FROM whaleu_community.root_comments WHERE id=target_row.root_id FOR SHARE;END IF;
 IF NEW.target_kind='reply' THEN PERFORM id FROM whaleu_community.replies WHERE id=NEW.target_id FOR SHARE;END IF;
 PERFORM id FROM whaleu_authorization.role_grants WHERE id=NEW.grant_id FOR SHARE;
 IF NOT whaleu_profile.moderation_grant_allowed(NEW.actor_id,NEW.grant_id,target_row.region_id)
 OR NOT whaleu_community.profile_moderation_supported(NEW.actor_id,NEW.target_kind,NEW.target_id)
 OR NOT whaleu_profile.moderation_actor_current(NEW.actor_id,clock_timestamp())
 THEN RAISE EXCEPTION 'Current scoped nickname authority required' USING ERRCODE='23514',CONSTRAINT='profile_moderation_causal';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('whaleu:profile-avatar:actor:v1:'||target_row.subject_id::text,0));
 SELECT * INTO p FROM whaleu_profile.profiles WHERE account_id=target_row.subject_id FOR UPDATE;
 IF p.account_id IS NULL OR p.public_id IS NULL THEN RAISE EXCEPTION 'Existing subject Profile required' USING ERRCODE='23514',CONSTRAINT='profile_moderation_causal';END IF;
 IF (NEW.receipt->>'outcome'='applied' AND p.revision<>(NEW.command->>'expectedProfileRevision')::integer)
 OR (NEW.receipt->>'code'='PROFILE_MODERATION_STALE' AND p.revision=(NEW.command->>'expectedProfileRevision')::integer)
 THEN RAISE EXCEPTION 'Exact shared Profile CAS required' USING ERRCODE='23514',CONSTRAINT='profile_moderation_causal';END IF;
 NEW.subject_id:=target_row.subject_id;NEW.post_id:=target_row.post_id;NEW.root_id:=target_row.root_id;NEW.original_region_id:=target_row.region_id;
 NEW.before_revision:=p.revision;NEW.before_nickname:=p.nickname;
 NEW.before_hash:=whaleu_profile.moderation_hash(to_jsonb(p));
 SELECT whaleu_profile.moderation_hash(jsonb_build_array(to_jsonb(current),current.xmin::text,current.ctid::text)) INTO NEW.before_fingerprint FROM whaleu_profile.profiles current WHERE current.account_id=p.account_id;
 NEW.unchanged_hash:=whaleu_profile.moderation_hash(to_jsonb(p)-ARRAY['nickname','revision','updated_at']);
 NEW.avatar_hash:=whaleu_profile.moderation_hash(whaleu_profile.moderation_avatar_facts(p.account_id));
 NEW.input_hash:=whaleu_profile.moderation_hash(whaleu_profile.moderation_input_facts(NEW.actor_id,NEW.grant_id,NEW.target_kind,NEW.target_id));
 RETURN NEW;END$$;
CREATE TRIGGER moderation_command_guard BEFORE INSERT ON whaleu_profile.moderation_commands FOR EACH ROW EXECUTE FUNCTION whaleu_profile.moderation_command_guard();
CREATE FUNCTION whaleu_profile.moderation_capture_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q whaleu_profile.moderation_commands;BEGIN
 FOR q IN SELECT * FROM whaleu_profile.moderation_commands WHERE mutation_transaction=pg_current_xact_id() AND subject_id=OLD.account_id AND receipt->>'outcome'='applied' LOOP
  IF (OLD.account_id,OLD.revision,OLD.nickname) IS DISTINCT FROM (q.subject_id,q.before_revision,q.before_nickname)
  OR whaleu_profile.moderation_hash(to_jsonb(OLD))<>q.before_hash
  OR whaleu_profile.moderation_hash(to_jsonb(NEW)-ARRAY['nickname','revision','updated_at'])<>q.unchanged_hash
  OR NEW.revision<>OLD.revision+1 OR NEW.nickname !~ '^违规昵称[A-Za-z0-9]{6}$' OR NEW.updated_at<OLD.updated_at OR NEW.updated_at>clock_timestamp()
  THEN RAISE EXCEPTION 'Nickname-only exact Profile transition required' USING ERRCODE='23514',CONSTRAINT='profile_moderation_causal';END IF;
  INSERT INTO whaleu_profile.moderation_transitions(actor_id,request_id,subject_id,before_revision,after_revision,before_nickname,after_nickname,before_hash,after_hash,unchanged_hash)
   VALUES(q.actor_id,q.request_id,q.subject_id,OLD.revision,NEW.revision,OLD.nickname,NEW.nickname,q.before_hash,whaleu_profile.moderation_hash(to_jsonb(NEW)),q.unchanged_hash);
 END LOOP;
 RETURN NULL;END$$;
CREATE TRIGGER moderation_capture_transition AFTER UPDATE ON whaleu_profile.profiles FOR EACH ROW EXECUTE FUNCTION whaleu_profile.moderation_capture_transition();
CREATE FUNCTION whaleu_profile.moderation_transition_guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF pg_trigger_depth()<2 OR NEW.mutation_transaction<>pg_current_xact_id() THEN RAISE EXCEPTION 'Only the actual Profile transition can produce its cause' USING ERRCODE='23514',CONSTRAINT='profile_moderation_causal';END IF;RETURN NEW;END$$;
CREATE TRIGGER moderation_transition_guard BEFORE INSERT ON whaleu_profile.moderation_transitions FOR EACH ROW EXECUTE FUNCTION whaleu_profile.moderation_transition_guard();
CREATE FUNCTION whaleu_profile.moderation_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q whaleu_profile.moderation_commands;t whaleu_profile.moderation_transitions;authority jsonb;BEGIN
 SELECT * INTO q FROM whaleu_profile.moderation_commands WHERE actor_id=NEW.actor_id AND request_id=NEW.request_id;
 SELECT * INTO t FROM whaleu_profile.moderation_transitions WHERE actor_id=NEW.actor_id AND request_id=NEW.request_id;
 SELECT jsonb_build_object('id',g.id,'accountId',g.account_id,'role',g.role,'operatingRegionId',g.operating_region_id,'validFrom',g.valid_from,'expiresAt',g.expires_at) INTO authority FROM whaleu_authorization.role_grants g WHERE id=q.grant_id;
 IF NEW.selected_authority IS NULL THEN NEW.selected_authority:=authority;END IF;
 IF q.request_id IS NULL OR t.request_id IS NULL OR q.mutation_transaction<>pg_current_xact_id() OR t.mutation_transaction<>pg_current_xact_id() OR NEW.mutation_transaction<>pg_current_xact_id()
 OR (NEW.subject_id,NEW.target_kind,NEW.target_id,NEW.post_id,NEW.root_id,NEW.original_region_id,NEW.grant_id) IS DISTINCT FROM (q.subject_id,q.target_kind,q.target_id,q.post_id,q.root_id,q.original_region_id,q.grant_id)
 OR (NEW.before_revision,NEW.revision,NEW.old_nickname,NEW.nickname) IS DISTINCT FROM (t.before_revision,t.after_revision,t.before_nickname,t.after_nickname)
 OR q.receipt->>'outcome' IS DISTINCT FROM 'applied' OR q.receipt->>'eventId' IS DISTINCT FROM NEW.id::text OR q.receipt->>'revision' IS DISTINCT FROM NEW.revision::text
 OR (q.receipt->>'recordedAt')::timestamptz IS DISTINCT FROM NEW.recorded_at OR NEW.recorded_at>clock_timestamp()
 OR NEW.selected_authority IS DISTINCT FROM authority
 THEN RAISE EXCEPTION 'Exact nickname event cause required' USING ERRCODE='23514',CONSTRAINT='profile_moderation_causal';END IF;
 RETURN NEW;END$$;
CREATE TRIGGER moderation_event_guard BEFORE INSERT ON whaleu_profile.moderation_events FOR EACH ROW EXECUTE FUNCTION whaleu_profile.moderation_event_guard();
CREATE FUNCTION whaleu_notifications.profile_moderation_notice_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e whaleu_profile.moderation_events;BEGIN
 IF TG_OP='DELETE' OR TG_OP='TRUNCATE' THEN RAISE EXCEPTION 'Profile notice retained' USING ERRCODE='23514',CONSTRAINT='profile_moderation_causal';END IF;
 IF TG_OP='UPDATE' THEN
  SELECT * INTO e FROM whaleu_profile.moderation_events WHERE id=OLD.event_id;
  IF e.mutation_transaction=pg_current_xact_id() THEN RAISE EXCEPTION 'New nickname notice must commit unread' USING ERRCODE='23514',CONSTRAINT='profile_moderation_causal';END IF;
  IF (to_jsonb(NEW)-'read_at') IS DISTINCT FROM (to_jsonb(OLD)-'read_at') OR NEW.read_at IS NULL OR (OLD.read_at IS NOT NULL AND NEW.read_at<>OLD.read_at) OR NEW.read_at>clock_timestamp()
  THEN RAISE EXCEPTION 'Only first owner read timestamp can change' USING ERRCODE='23514',CONSTRAINT='profile_moderation_causal';END IF;
 ELSE
  SELECT * INTO e FROM whaleu_profile.moderation_events WHERE id=NEW.event_id;
  IF e.id IS NULL OR e.mutation_transaction<>pg_current_xact_id() OR (NEW.recipient_account_id,NEW.nickname,NEW.created_at) IS DISTINCT FROM (e.subject_id,e.nickname,e.recorded_at) OR NEW.read_at IS NOT NULL
  THEN RAISE EXCEPTION 'Profile notice requires same-transaction event' USING ERRCODE='23514',CONSTRAINT='profile_moderation_causal';END IF;
 END IF;
 INSERT INTO whaleu_notifications.system_notice_owners(account_id) VALUES(NEW.recipient_account_id) ON CONFLICT DO NOTHING;
 PERFORM account_id FROM whaleu_notifications.system_notice_owners WHERE account_id=NEW.recipient_account_id FOR UPDATE;
 RETURN NEW;END$$;
CREATE TRIGGER profile_moderation_notice_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_notifications.profile_moderation_notices FOR EACH ROW EXECUTE FUNCTION whaleu_notifications.profile_moderation_notice_guard();
CREATE TRIGGER profile_moderation_notice_retain BEFORE TRUNCATE ON whaleu_notifications.profile_moderation_notices FOR EACH STATEMENT EXECUTE FUNCTION whaleu_notifications.profile_moderation_notice_guard();
-- Cross-kind UUID identity is enforced, not probabilistic. AFTER INSERT avoids
-- registering rows discarded by the existing jury ON CONFLICT replay path.
CREATE TABLE whaleu_notifications.system_notice_ids (
 id uuid PRIMARY KEY CHECK(whaleu_profile.moderation_uuid_valid(id::text)),kind text NOT NULL CHECK(kind IN('post_jury_removed','profile_nickname_reset')),
 recipient_account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),UNIQUE(id,kind,recipient_account_id)
);
INSERT INTO whaleu_notifications.system_notice_ids(id,kind,recipient_account_id) SELECT id,kind,recipient_account_id FROM whaleu_notifications.system_notices;
CREATE FUNCTION whaleu_notifications.register_system_notice_id() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 INSERT INTO whaleu_notifications.system_notice_ids(id,kind,recipient_account_id) VALUES(NEW.id,NEW.kind,NEW.recipient_account_id);RETURN NULL;END$$;
CREATE TRIGGER register_system_notice_id AFTER INSERT ON whaleu_notifications.system_notices FOR EACH ROW EXECUTE FUNCTION whaleu_notifications.register_system_notice_id();
CREATE TRIGGER register_system_notice_id AFTER INSERT ON whaleu_notifications.profile_moderation_notices FOR EACH ROW EXECUTE FUNCTION whaleu_notifications.register_system_notice_id();
ALTER TABLE whaleu_notifications.system_notices ADD CONSTRAINT system_notice_exact_id FOREIGN KEY(id,kind,recipient_account_id) REFERENCES whaleu_notifications.system_notice_ids(id,kind,recipient_account_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE whaleu_notifications.profile_moderation_notices ADD CONSTRAINT profile_notice_exact_id FOREIGN KEY(id,kind,recipient_account_id) REFERENCES whaleu_notifications.system_notice_ids(id,kind,recipient_account_id) DEFERRABLE INITIALLY DEFERRED;
CREATE TRIGGER system_notice_id_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON whaleu_notifications.system_notice_ids FOR EACH STATEMENT EXECUTE FUNCTION whaleu_profile.moderation_immutable();
CREATE TRIGGER system_notice_source_retain BEFORE TRUNCATE ON whaleu_notifications.system_notices FOR EACH STATEMENT EXECUTE FUNCTION whaleu_profile.moderation_immutable();
CREATE FUNCTION whaleu_notifications.system_notice_id_complete() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF (NEW.kind='post_jury_removed' AND NOT EXISTS(SELECT 1 FROM whaleu_notifications.system_notices n WHERE (n.id,n.kind,n.recipient_account_id)=(NEW.id,NEW.kind,NEW.recipient_account_id)))
 OR (NEW.kind='profile_nickname_reset' AND NOT EXISTS(SELECT 1 FROM whaleu_notifications.profile_moderation_notices n WHERE (n.id,n.kind,n.recipient_account_id)=(NEW.id,NEW.kind,NEW.recipient_account_id)))
 THEN RAISE EXCEPTION 'System notice registry requires exact source' USING ERRCODE='23514',CONSTRAINT='profile_moderation_causal';END IF;RETURN NULL;END$$;
CREATE CONSTRAINT TRIGGER system_notice_id_complete AFTER INSERT ON whaleu_notifications.system_notice_ids DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_notifications.system_notice_id_complete();
CREATE FUNCTION whaleu_profile.moderation_assert_complete(q whaleu_profile.moderation_commands) RETURNS void LANGUAGE plpgsql AS $$
DECLARE p whaleu_profile.profiles;t whaleu_profile.moderation_transitions;e whaleu_profile.moderation_events;BEGIN
 -- These final fences also reject a revocation writer already queued behind the
 -- earlier row SHARE lock. Final checks never wait for a new authority writer.
 LOCK TABLE whaleu_identity.accounts,whaleu_identity.sessions,whaleu_identity.access_tokens IN SHARE MODE NOWAIT;
 IF NOT whaleu_profile.moderation_identity_current(q.actor_id,q.session_id,q.token_hash)
 OR q.identity_hash<>whaleu_profile.moderation_hash(whaleu_profile.moderation_identity_facts(q.actor_id,q.session_id,q.token_hash))
 THEN RAISE EXCEPTION 'Original current actor facts required' USING ERRCODE='23514',CONSTRAINT='profile_moderation_causal';END IF;
 SELECT * INTO t FROM whaleu_profile.moderation_transitions WHERE actor_id=q.actor_id AND request_id=q.request_id;
 SELECT * INTO e FROM whaleu_profile.moderation_events WHERE actor_id=q.actor_id AND request_id=q.request_id;
 IF q.receipt->>'code'='PROFILE_MODERATION_CANCELLED' THEN
  IF t.request_id IS NOT NULL OR e.id IS NOT NULL OR q.subject_id IS NOT NULL OR q.grant_id IS NOT NULL THEN RAISE EXCEPTION 'Cancel cannot produce side effects' USING ERRCODE='23514',CONSTRAINT='profile_moderation_causal';END IF;
  RETURN;
 END IF;
 LOCK TABLE whaleu_authorization.role_grants,whaleu_verification.account_heads,whaleu_verification.snapshots,whaleu_verification.assertions,
 whaleu_community.discovery_count_epochs,whaleu_safety.discovery_count_epochs,whaleu_campus.discovery_count_epochs IN SHARE MODE NOWAIT;
 IF EXISTS(SELECT 1 FROM whaleu_community.profile_moderation_nodes(q.target_kind,q.target_id) n JOIN whaleu_community.content_approval_bindings b ON b.content_kind=n.kind AND b.content_id=n.id WHERE b.envelope->'images'<>'[]'::jsonb) THEN
  LOCK TABLE whaleu_media.media_owner_states,whaleu_media.upload_intents,whaleu_media.assets,whaleu_media.bindings,whaleu_media.asset_safety_heads,whaleu_media.asset_safety_events,whaleu_media.variants IN SHARE MODE NOWAIT;
 END IF;
 IF NOT whaleu_profile.moderation_grant_allowed(q.actor_id,q.grant_id,q.original_region_id)
 OR NOT whaleu_community.profile_moderation_supported(q.actor_id,q.target_kind,q.target_id)
 OR NOT whaleu_profile.moderation_actor_current(q.actor_id,clock_timestamp())
 OR q.input_hash<>whaleu_profile.moderation_hash(whaleu_profile.moderation_input_facts(q.actor_id,q.grant_id,q.target_kind,q.target_id))
 OR q.avatar_hash<>whaleu_profile.moderation_hash(whaleu_profile.moderation_avatar_facts(q.subject_id))
 THEN RAISE EXCEPTION 'Original current nickname inputs required' USING ERRCODE='23514',CONSTRAINT='profile_moderation_causal';END IF;
 SELECT * INTO p FROM whaleu_profile.profiles WHERE account_id=q.subject_id;
 IF q.receipt->>'code'='PROFILE_MODERATION_STALE' THEN
  IF p.account_id IS NULL OR t.request_id IS NOT NULL OR e.id IS NOT NULL OR p.revision=(q.command->>'expectedProfileRevision')::integer OR q.before_hash IS DISTINCT FROM whaleu_profile.moderation_hash(to_jsonb(p))
  OR q.before_fingerprint IS DISTINCT FROM (SELECT whaleu_profile.moderation_hash(jsonb_build_array(to_jsonb(current),current.xmin::text,current.ctid::text)) FROM whaleu_profile.profiles current WHERE current.account_id=q.subject_id)
  THEN RAISE EXCEPTION 'Stale nickname result must be causal and read-only' USING ERRCODE='23514',CONSTRAINT='profile_moderation_causal';END IF;
  RETURN;
 END IF;
 IF e.id IS NULL OR t.request_id IS NULL OR e.mutation_transaction<>pg_current_xact_id() OR t.mutation_transaction<>pg_current_xact_id()
 OR t.before_hash<>q.before_hash OR t.unchanged_hash<>q.unchanged_hash OR t.after_hash<>whaleu_profile.moderation_hash(to_jsonb(p))
 OR (p.revision,p.nickname) IS DISTINCT FROM (e.revision,e.nickname)
 OR (t.after_revision,t.after_nickname) IS DISTINCT FROM (e.revision,e.nickname)
 OR NOT EXISTS(SELECT 1 FROM whaleu_notifications.profile_moderation_notices n JOIN whaleu_notifications.system_notice_ids i ON (i.id,i.kind,i.recipient_account_id)=(n.id,n.kind,n.recipient_account_id) WHERE n.event_id=e.id AND n.recipient_account_id=e.subject_id AND n.nickname=e.nickname AND n.created_at=e.recorded_at AND n.read_at IS NULL)
 THEN RAISE EXCEPTION 'Nickname event, real Profile transition, receipt and notice must commit together' USING ERRCODE='23514',CONSTRAINT='profile_moderation_causal';END IF;
END$$;
CREATE FUNCTION whaleu_profile.moderation_complete() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN PERFORM whaleu_profile.moderation_assert_complete(NEW);RETURN NULL;END$$;
CREATE CONSTRAINT TRIGGER moderation_complete AFTER INSERT ON whaleu_profile.moderation_commands DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_profile.moderation_complete();

-- A later DML statement after SET CONSTRAINTS ... IMMEDIATE must not escape a
-- raw command's final proof. Existing owner epoch writes cover even zero-row,
-- TRUNCATE and ABA mutations without adding new reads to public surfaces.
CREATE FUNCTION whaleu_profile.moderation_recheck_active() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q whaleu_profile.moderation_commands;BEGIN
 FOR q IN SELECT * FROM whaleu_profile.moderation_commands WHERE mutation_transaction=pg_current_xact_id() LOOP
  PERFORM whaleu_profile.moderation_assert_complete(q);
 END LOOP;RETURN NULL;END$$;
DO $$DECLARE relation text;BEGIN
 FOREACH relation IN ARRAY ARRAY['whaleu_community.discovery_count_epochs','whaleu_safety.discovery_count_epochs','whaleu_campus.discovery_count_epochs','whaleu_media.media_owner_states',
 'whaleu_identity.accounts','whaleu_identity.sessions','whaleu_identity.access_tokens','whaleu_authorization.role_grants','whaleu_verification.account_heads','whaleu_profile.profiles','whaleu_profile.avatar_current'] LOOP
 EXECUTE format('CREATE CONSTRAINT TRIGGER moderation_recheck_active AFTER INSERT OR UPDATE OR DELETE ON %s DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_profile.moderation_recheck_active()',relation);
 END LOOP;
END$$;
