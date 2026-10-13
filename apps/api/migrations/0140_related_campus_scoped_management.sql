-- Related-campus scoped management. Forward fragment; no migration number.
-- Shared moderation_grant_allowed, punishment v2, and 0136/0137 source guards
-- remain unchanged. No grant, topology, applicability or pin scope is seeded.
CREATE FUNCTION whaleu_community.related_content_destination_grant_allowed(actor uuid,selected uuid,target uuid,view_space uuid,action text)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT action IN('remove','pin','profile_unavailable') AND EXISTS(
  SELECT 1 FROM whaleu_authorization.role_grants g JOIN whaleu_community.posts p ON p.id=target
  JOIN whaleu_community.spaces s ON s.id=view_space AND s.is_active
  WHERE g.id=selected AND g.account_id=actor AND g.revoked_at IS NULL AND g.valid_from<=clock_timestamp()
  AND (g.expires_at IS NULL OR g.expires_at>clock_timestamp())
  AND (action='pin' OR s.kind='regional')
  AND ((g.role='super_admin' AND g.operating_region_id IS NULL)
   OR (g.role='school_admin' AND s.kind='regional' AND g.operating_region_id=s.operating_region_id)
   OR (action='pin' AND p.space_id=s.id AND g.role='developer' AND g.operating_region_id IS NULL))
  )
$$;
CREATE FUNCTION whaleu_community.related_content_grant_allowed(actor uuid,selected uuid,target uuid,view_space uuid,action text)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT whaleu_community.related_content_destination_grant_allowed(actor,selected,target,view_space,action)
  AND whaleu_community.related_distribution_view_allowed(target,view_space)
$$;
CREATE FUNCTION whaleu_community.related_content_grant_facts(actor uuid,selected uuid,target uuid,view_space uuid,action text)
RETURNS jsonb LANGUAGE sql VOLATILE AS $$
 SELECT jsonb_build_object('actor',actor,'postId',target,'viewSpaceId',view_space,'action',action,
 'grant',(SELECT jsonb_build_array(to_jsonb(g),g.xmin::text,g.ctid::text) FROM whaleu_authorization.role_grants g WHERE g.id=selected),
 'authorityGeneration',whaleu_safety.account_punishment_authority_epoch(),
 'distribution',whaleu_community.related_distribution_view_facts(target,view_space))
$$;
CREATE FUNCTION whaleu_community.related_content_grant_fence() RETURNS void LANGUAGE plpgsql AS $$DECLARE relation record;BEGIN
 -- Fence the ORIGINAL source-writer generation after every deferred wait.
 LOCK TABLE whaleu_authorization.role_grants,whaleu_authorization.account_punishment_authority_epoch,
 whaleu_campus.community_distribution_generation,whaleu_campus.community_topology_heads,whaleu_campus.community_topology_snapshots,whaleu_campus.operating_regions,
 whaleu_community.spaces,whaleu_community.related_sync_view_generation,whaleu_community.post_distribution_bindings,whaleu_community.related_sync_policies,
 whaleu_community.posts,whaleu_community.report_origins,whaleu_community.publication_requests,
 whaleu_community.discovery_count_epochs,whaleu_safety.discovery_count_epochs,whaleu_campus.discovery_count_epochs,whaleu_media.media_owner_states,
 whaleu_community.post_category_heads,whaleu_community.post_category_events,whaleu_community.post_category_policies,
 whaleu_community.post_category_policy_heads,whaleu_community.post_category_policy_withdrawals,
 whaleu_community.post_category_reviews,whaleu_community.post_category_review_withdrawals,
 whaleu_community.post_category_issuers,whaleu_community.post_category_issuer_withdrawals
 IN SHARE MODE NOWAIT;
 FOR relation IN
  WITH dependencies AS MATERIALIZED (SELECT classid,objid FROM pg_catalog.pg_depend
   WHERE refclassid='pg_catalog.pg_proc'::regclass AND refobjid IN(
    'whaleu_community.advance_discovery_count_epoch()'::regprocedure,'whaleu_safety.advance_discovery_count_epoch()'::regprocedure,
    'whaleu_campus.advance_discovery_count_epoch()'::regprocedure,'whaleu_media.advance_owner_epoch()'::regprocedure))
  SELECT DISTINCT n.nspname,c.relname FROM dependencies d JOIN pg_catalog.pg_trigger source_trigger ON source_trigger.oid=d.objid
  JOIN pg_catalog.pg_class c ON c.oid=source_trigger.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  WHERE d.classid='pg_catalog.pg_trigger'::regclass AND NOT source_trigger.tgisinternal AND source_trigger.tgenabled<>'D'
   AND source_trigger.tgfoid IN('whaleu_community.advance_discovery_count_epoch()'::regprocedure,'whaleu_safety.advance_discovery_count_epoch()'::regprocedure,
    'whaleu_campus.advance_discovery_count_epoch()'::regprocedure,'whaleu_media.advance_owner_epoch()'::regprocedure)
  ORDER BY n.nspname,c.relname LOOP
  EXECUTE format('LOCK TABLE %I.%I IN SHARE MODE NOWAIT',relation.nspname,relation.relname);
 END LOOP;
END$$;
CREATE FUNCTION whaleu_community.related_removal_target_version(actor uuid,selected uuid,target_kind text,target uuid,view_space uuid)
RETURNS text LANGUAGE sql VOLATILE AS $$
 SELECT encode(sha256(convert_to('whaleu:admin-'||CASE WHEN target_kind='post' THEN 'post' ELSE 'discussion' END||'-removal-target:v3'||chr(10)||
 whaleu_community.content_canonical_json(jsonb_build_object('canonical',CASE WHEN target_kind='post' THEN whaleu_community.admin_post_removal_target_version(target) ELSE whaleu_community.admin_discussion_removal_target_version(target_kind,target) END,
 'scope',whaleu_community.related_content_grant_facts(actor,selected,(SELECT post_id FROM whaleu_community.profile_moderation_nodes(target_kind,target) WHERE kind=target_kind AND id=target),view_space,'remove'))),'UTF8')),'hex')
$$;


CREATE OR REPLACE FUNCTION whaleu_community.admin_post_removal_target(target uuid)
RETURNS TABLE(subject_id uuid,post_id uuid,root_id uuid,region_id uuid)
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT p.account_id,p.id,NULL::uuid,s.operating_region_id
 FROM whaleu_community.posts p JOIN whaleu_community.spaces s ON s.id=p.space_id
 JOIN whaleu_community.content_approval_bindings b ON b.content_kind='post' AND b.content_id=p.id
 WHERE p.id=target AND p.author_mode IN('named','anonymous')
 AND s.kind='regional' AND s.is_active AND s.operating_region_id IS NOT NULL
 AND (b.scope->>'sync'='none' OR (b.scope->>'sync'='related' AND whaleu_community.related_sync_binding_valid(p.id))) AND b.scope->>'originalSpaceId'=s.id::text
 AND b.scope->>'originalRegionId'=s.operating_region_id::text
 AND EXISTS(SELECT 1 FROM whaleu_campus.operating_regions r WHERE r.id=s.operating_region_id AND r.is_active)
$$;

CREATE OR REPLACE FUNCTION whaleu_community.admin_post_removal_supported(actor uuid,target uuid,allow_removed boolean DEFAULT false) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE target_kind constant text:='post';target_row record;n record;b whaleu_community.content_approval_bindings;category_head whaleu_community.post_category_heads;
 count_nodes integer:=0;BEGIN
 SELECT * INTO target_row FROM whaleu_community.admin_post_removal_target(target);
 IF target_row.subject_id IS NULL THEN RETURN false;END IF;
 IF EXISTS(SELECT 1 FROM whaleu_community.post_owner_visibility WHERE post_id=target_row.post_id AND owner_hidden) THEN RETURN false;END IF;
 FOR n IN SELECT * FROM whaleu_community.profile_moderation_nodes(target_kind,target) LOOP
  count_nodes:=count_nodes+1;
  IF n.payload->>'visibility' IS DISTINCT FROM 'approved' OR (NOT allow_removed AND n.payload->>'deleted_at' IS NOT NULL) THEN RETURN false;END IF;
  SELECT * INTO b FROM whaleu_community.content_approval_bindings WHERE content_kind=n.kind AND content_id=n.id;
  IF b.content_id IS NULL OR b.content_version<>1 OR b.account_id<>n.account_id
   OR b.envelope->>'accountId' IS DISTINCT FROM n.account_id::text OR b.envelope->>'authorMode' IS DISTINCT FROM n.author_mode
   OR b.envelope->>'text' IS DISTINCT FROM n.payload->>'text' OR b.scope IS DISTINCT FROM b.envelope->'scope'
   OR b.envelope IS DISTINCT FROM (CASE WHEN b.envelope_version=4 THEN whaleu_community.related_content_definition(n.kind,n.id) ELSE whaleu_community.profile_moderation_definition(n.kind,n.id,b.scope) END)
   OR (b.scope->>'sync' IS DISTINCT FROM 'none' AND NOT (b.envelope_version=4 AND b.scope->>'sync'=CASE WHEN n.kind='post' THEN 'related' ELSE 'inherited_related' END)) OR b.scope->>'originalRegionId' IS DISTINCT FROM target_row.region_id::text
   OR ((b.envelope_version=4) IS DISTINCT FROM (SELECT publication_envelope_version=4 FROM whaleu_community.posts WHERE id=n.post_id)) OR (b.envelope_version=4 AND (NOT whaleu_community.related_sync_binding_valid(n.post_id) OR (n.kind<>'post' AND NOT EXISTS(SELECT 1 FROM whaleu_community.post_distribution_bindings native WHERE native.post_id=n.post_id AND b.scope->'parentDistribution'=jsonb_build_object('postId',native.post_id,'decisionId',native.decision_id,'digest',native.digest))))) OR b.scope->>'originalSpaceId' IS DISTINCT FROM (SELECT space_id::text FROM whaleu_community.posts WHERE id=n.post_id)
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

CREATE OR REPLACE FUNCTION whaleu_community.admin_discussion_removal_target(target_kind text,target uuid)
RETURNS TABLE(subject_id uuid,post_id uuid,root_id uuid,region_id uuid)
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT n.account_id,n.post_id,n.root_id,s.operating_region_id
 FROM whaleu_community.profile_moderation_nodes(target_kind,target) n
 JOIN whaleu_community.posts p ON p.id=n.post_id
 JOIN whaleu_community.spaces s ON s.id=p.space_id
 JOIN whaleu_community.content_approval_bindings b ON b.content_kind='post' AND b.content_id=p.id
 WHERE target_kind IN('comment','reply') AND n.kind=target_kind AND n.id=target
 AND n.author_mode IN('named','anonymous') AND s.kind='regional' AND s.is_active AND s.operating_region_id IS NOT NULL
 AND (b.scope->>'sync'='none' OR (b.scope->>'sync'='related' AND whaleu_community.related_sync_binding_valid(p.id))) AND b.scope->>'originalSpaceId'=s.id::text
 AND b.scope->>'originalRegionId'=s.operating_region_id::text
 AND EXISTS(SELECT 1 FROM whaleu_campus.operating_regions r WHERE r.id=s.operating_region_id AND r.is_active)
$$;

CREATE OR REPLACE FUNCTION whaleu_community.admin_discussion_removal_supported(actor uuid,target_kind text,target uuid,allow_removed boolean DEFAULT false) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE target_row record;n record;b whaleu_community.content_approval_bindings;category_head whaleu_community.post_category_heads;
 count_nodes integer:=0;BEGIN
 SELECT * INTO target_row FROM whaleu_community.admin_discussion_removal_target(target_kind,target);
 IF target_row.subject_id IS NULL THEN RETURN false;END IF;
 IF EXISTS(SELECT 1 FROM whaleu_community.post_owner_visibility WHERE post_id=target_row.post_id AND owner_hidden) THEN RETURN false;END IF;
 FOR n IN SELECT * FROM whaleu_community.profile_moderation_nodes(target_kind,target) LOOP
  count_nodes:=count_nodes+1;
  IF n.payload->>'visibility' IS DISTINCT FROM 'approved' OR (n.payload->>'deleted_at' IS NOT NULL AND NOT (allow_removed AND n.kind=target_kind AND n.id=target)) THEN RETURN false;END IF;
  SELECT * INTO b FROM whaleu_community.content_approval_bindings WHERE content_kind=n.kind AND content_id=n.id;
  IF b.content_id IS NULL OR b.content_version<>1 OR b.account_id<>n.account_id
   OR b.envelope->>'accountId' IS DISTINCT FROM n.account_id::text OR b.envelope->>'authorMode' IS DISTINCT FROM n.author_mode
   OR b.envelope->>'text' IS DISTINCT FROM n.payload->>'text' OR b.scope IS DISTINCT FROM b.envelope->'scope'
   OR b.envelope IS DISTINCT FROM (CASE WHEN b.envelope_version=4 THEN whaleu_community.related_content_definition(n.kind,n.id) ELSE whaleu_community.profile_moderation_definition(n.kind,n.id,b.scope) END)
   OR (b.scope->>'sync' IS DISTINCT FROM 'none' AND NOT (b.envelope_version=4 AND b.scope->>'sync'=CASE WHEN n.kind='post' THEN 'related' ELSE 'inherited_related' END)) OR b.scope->>'originalRegionId' IS DISTINCT FROM target_row.region_id::text
   OR ((b.envelope_version=4) IS DISTINCT FROM (SELECT publication_envelope_version=4 FROM whaleu_community.posts WHERE id=n.post_id)) OR (b.envelope_version=4 AND (NOT whaleu_community.related_sync_binding_valid(n.post_id) OR (n.kind<>'post' AND NOT EXISTS(SELECT 1 FROM whaleu_community.post_distribution_bindings native WHERE native.post_id=n.post_id AND b.scope->'parentDistribution'=jsonb_build_object('postId',native.post_id,'decisionId',native.decision_id,'digest',native.digest))))) OR b.scope->>'originalSpaceId' IS DISTINCT FROM (SELECT space_id::text FROM whaleu_community.posts WHERE id=n.post_id)
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
    AND q.operation=(CASE n.kind WHEN 'post' THEN 'publish_post' WHEN 'comment' THEN 'publish_comment' ELSE 'publish_reply' END)
    AND q.receipt->>'operation'=q.operation AND q.receipt->>'requestId'=q.client_request_id::text
    AND q.receipt->>'outcome'='created' AND q.receipt->>'resourceId'=n.id::text)
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
 IF count_nodes<>((CASE target_kind WHEN 'post' THEN 1 WHEN 'comment' THEN 2 WHEN 'reply' THEN 3 ELSE 0 END)) THEN RETURN false;END IF;
 SELECT * INTO category_head FROM whaleu_community.post_category_heads WHERE post_id=target_row.post_id;
 IF category_head.post_id IS NOT NULL THEN
  IF NOT EXISTS(SELECT 1 FROM whaleu_community.post_category_live WHERE post_id=category_head.post_id) THEN RETURN false;END IF;
  FOR n IN SELECT * FROM whaleu_community.profile_moderation_nodes(target_kind,target) WHERE kind<>'post' LOOP
   IF NOT EXISTS(SELECT 1 FROM whaleu_community.post_category_live live JOIN whaleu_community.post_category_policies pol ON pol.id=live.policy_id
    JOIN whaleu_community.content_approval_bindings original ON original.content_kind=n.kind AND original.content_id=n.id
    LEFT JOIN whaleu_community.post_category_child_bindings c ON c.content_kind=n.kind AND c.content_id=n.id AND c.post_id=n.post_id
    LEFT JOIN whaleu_community.post_category_review_live r ON r.id=c.review_id AND r.purpose='community_child_current_parent_classification'
    WHERE live.post_id=n.post_id AND ((CASE WHEN c.content_id IS NULL THEN pol.definition->'continueDescendants'='true'::jsonb ELSE c.original_decision_id=original.decision_id AND c.original_digest=original.digest AND r.id IS NOT NULL AND (c.event_id=category_head.event_id OR pol.definition->'continueDescendants'='true'::jsonb) END))
    AND (original.envelope->'images'='[]'::jsonb OR pol.definition->>'descendantMedia'='retain_current_media_proof')) THEN RETURN false;END IF;
  END LOOP;
 END IF;
 RETURN true;END$$;

CREATE OR REPLACE FUNCTION whaleu_community.removal_punishment_envelope_valid(command jsonb,receipt jsonb,source_kind text)
RETURNS boolean LANGUAGE plpgsql AS $$DECLARE s jsonb;r jsonb;BEGIN
 IF command->'version'='3'::jsonb THEN
  RETURN receipt->'version'='3'::jsonb AND receipt->'viewSpaceId' IS NOT DISTINCT FROM command->'viewSpaceId'
   AND jsonb_typeof(command->'viewSpaceId')='string' AND whaleu_profile.moderation_uuid_valid(command->>'viewSpaceId')
   AND NOT (command ? 'punishment' OR receipt ? 'selection' OR receipt ? 'punishment');
 END IF;
 IF NOT command ? 'version' THEN RETURN NOT (receipt ? 'version' OR receipt ? 'selection' OR receipt ? 'punishment'); END IF;
 s:=command->'punishment';r:=receipt->'punishment';
 IF command->'version' IS DISTINCT FROM '2'::jsonb OR receipt->'version' IS DISTINCT FROM '2'::jsonb OR receipt->'selection' IS DISTINCT FROM s
 OR whaleu_community.post_owner_visibility_keys(s,ARRAY['kind','duration','reason','expectedRevision']) IS DISTINCT FROM true
 OR coalesce(s->>'kind' IN('interaction_mute','access_suspension'),false)=false
 OR jsonb_typeof(s->'reason') IS DISTINCT FROM 'string' OR char_length(s->>'reason') NOT BETWEEN 1 AND 255
 OR s->>'reason' IS DISTINCT FROM whaleu_profile.moderation_trim(s->>'reason')
 OR coalesce(s->>'expectedRevision' ~ '^(0|[1-9][0-9]{0,18})$',false)=false
 OR (s->>'expectedRevision')::numeric>=9223372036854775807 THEN RETURN false;END IF;
 PERFORM whaleu_safety.account_punishment_duration_end(date_trunc('milliseconds',clock_timestamp()),s->'duration',source_kind);
 IF receipt->>'outcome'='applied' THEN
  IF (receipt->>'recordedAt')::timestamptz<date_trunc('milliseconds',transaction_timestamp()) OR (receipt->>'recordedAt')::timestamptz<clock_timestamp()-interval '15 seconds' OR (receipt->>'recordedAt')::timestamptz>clock_timestamp() THEN RETURN false;END IF;
  RETURN whaleu_community.post_owner_visibility_keys(r,ARRAY['punishmentId','kind','revision'])
   AND whaleu_profile.moderation_uuid_valid(r->>'punishmentId')
   AND r->>'kind'=s->>'kind' AND r->>'revision'=((s->>'expectedRevision')::bigint+1)::text;
 END IF;
 RETURN NOT receipt ? 'punishment';
END$$;

ALTER TABLE whaleu_community.admin_post_removal_commands ADD COLUMN distribution_before jsonb;

CREATE OR REPLACE FUNCTION whaleu_community.admin_post_removal_command_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_row record;p record;identity_observed jsonb;input_observed jsonb;BEGIN
 -- V2 retains its first identity observation before request/account/content waits.
 -- V1 keeps the historical admission behavior and stored receipt bytes.
 IF NEW.command->'version' IN('2'::jsonb,'3'::jsonb) THEN
  identity_observed:=whaleu_profile.moderation_identity_facts(NEW.actor_id,NEW.session_id,NEW.token_hash);
 END IF;
 IF whaleu_community.removal_punishment_envelope_valid(NEW.command,NEW.receipt,'post') IS DISTINCT FROM true
 OR current_setting('transaction_isolation')<>'read committed' OR NEW.mutation_transaction<>pg_current_xact_id()
 OR whaleu_community.post_owner_visibility_keys(NEW.command,ARRAY['clientRequestId','target','expectedTargetVersion','action'] || CASE WHEN NEW.command->'version'='3'::jsonb THEN ARRAY['version','viewSpaceId'] WHEN NEW.command->'version'='2'::jsonb THEN ARRAY['version','punishment'] ELSE ARRAY[]::text[] END) IS DISTINCT FROM true
 OR whaleu_community.post_owner_visibility_keys(NEW.command->'target',ARRAY['kind','id']) IS DISTINCT FROM true
 OR NOT whaleu_profile.moderation_uuid_valid(NEW.target_id::text)
 OR NEW.command->>'clientRequestId' IS DISTINCT FROM NEW.request_id::text
 OR NEW.command->'target'->>'kind' IS DISTINCT FROM 'post' OR NEW.command->'target'->>'id' IS DISTINCT FROM NEW.target_id::text
 OR NEW.command->>'action' IS DISTINCT FROM 'remove_post'
 OR (jsonb_typeof(NEW.command->'expectedTargetVersion')='string' AND NEW.command->>'expectedTargetVersion' ~ '^[a-f0-9]{64}$') IS DISTINCT FROM true
 OR NEW.receipt->>'requestId' IS DISTINCT FROM NEW.request_id::text OR NEW.receipt->'target' IS DISTINCT FROM NEW.command->'target'
 OR NEW.receipt->>'action' IS DISTINCT FROM 'remove_post' OR NEW.receipt->'expectedTargetVersion' IS DISTINCT FROM NEW.command->'expectedTargetVersion'
 OR whaleu_community.post_owner_visibility_keys(NEW.receipt,CASE WHEN NEW.receipt->>'outcome'='rejected' THEN ARRAY['requestId','target','expectedTargetVersion','action','outcome','code'] ELSE ARRAY['requestId','target','expectedTargetVersion','action','outcome','eventId','recordedAt'] END || CASE WHEN NEW.command->'version'='3'::jsonb THEN ARRAY['version','viewSpaceId'] WHEN NEW.command->'version'='2'::jsonb THEN CASE WHEN NEW.receipt->>'outcome'='applied' THEN ARRAY['version','selection','punishment'] ELSE ARRAY['version','selection'] END ELSE ARRAY[]::text[] END) IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'Strict exact administrative post-removal command required' USING ERRCODE='23514',CONSTRAINT='admin_post_removal_causal';END IF;
 IF NEW.receipt->>'outcome'='rejected' THEN
  IF coalesce(NEW.receipt->>'code' IN('ADMIN_POST_REMOVAL_STALE','ADMIN_POST_REMOVAL_CANCELLED'),false)=false THEN
   RAISE EXCEPTION 'Exact terminal administrative rejection required' USING ERRCODE='23514',CONSTRAINT='admin_post_removal_causal';END IF;
 ELSE
  IF NEW.receipt->>'outcome' IS DISTINCT FROM 'applied'
  OR (jsonb_typeof(NEW.receipt->'eventId')='string' AND whaleu_profile.moderation_uuid_valid(NEW.receipt->>'eventId')) IS DISTINCT FROM true
  OR (jsonb_typeof(NEW.receipt->'recordedAt')='string' AND (NEW.receipt->>'recordedAt')~'^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9][.][0-9]{3}Z$') IS DISTINCT FROM true
  OR (NEW.receipt->>'recordedAt')::timestamptz>clock_timestamp()
  THEN RAISE EXCEPTION 'Exact applied administrative receipt required' USING ERRCODE='23514',CONSTRAINT='admin_post_removal_causal';END IF;
 END IF;
 IF NEW.command->'version'='2'::jsonb AND NEW.receipt->>'code' IS DISTINCT FROM 'ADMIN_POST_REMOVAL_CANCELLED' THEN
  input_observed:=whaleu_community.admin_post_removal_input_facts(NEW.actor_id,NEW.grant_id,NEW.target_id);
  SELECT whaleu_safety.account_punishment_protection_hash(t.subject_id) INTO NEW.punishment_protection_before FROM whaleu_community.admin_post_removal_target(NEW.target_id) t;
 END IF;
 IF NEW.command->'version'='3'::jsonb AND NEW.receipt->>'code' IS DISTINCT FROM 'ADMIN_POST_REMOVAL_CANCELLED' THEN
  NEW.distribution_before:=whaleu_community.related_content_grant_facts(NEW.actor_id,NEW.grant_id,NEW.target_id,(NEW.command->>'viewSpaceId')::uuid,'remove');
  input_observed:=whaleu_community.admin_post_removal_input_facts(NEW.actor_id,NEW.grant_id,NEW.target_id);
 ELSE NEW.distribution_before:=NULL;END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('whaleu:admin-post-removal-request:v1:'||NEW.actor_id::text||':'||NEW.request_id::text,0));
 PERFORM id FROM whaleu_identity.accounts WHERE id=NEW.actor_id FOR SHARE;
 PERFORM id FROM whaleu_identity.sessions WHERE id=NEW.session_id AND account_id=NEW.actor_id FOR SHARE;
 PERFORM token_hash FROM whaleu_identity.access_tokens WHERE token_hash=NEW.token_hash AND session_id=NEW.session_id FOR SHARE;
 IF NOT whaleu_profile.moderation_identity_current(NEW.actor_id,NEW.session_id,NEW.token_hash)
 OR (NEW.command->'version' IN('2'::jsonb,'3'::jsonb) AND identity_observed IS DISTINCT FROM whaleu_profile.moderation_identity_facts(NEW.actor_id,NEW.session_id,NEW.token_hash)) THEN
  RAISE EXCEPTION 'Current actor required' USING ERRCODE='23514',CONSTRAINT='admin_post_removal_causal';END IF;
 NEW.identity_hash:=whaleu_profile.moderation_hash(whaleu_profile.moderation_identity_facts(NEW.actor_id,NEW.session_id,NEW.token_hash));
 IF NEW.receipt->>'code'='ADMIN_POST_REMOVAL_CANCELLED' THEN
  IF NEW.grant_id IS NOT NULL THEN RAISE EXCEPTION 'Cancellation contains original key only' USING ERRCODE='23514',CONSTRAINT='admin_post_removal_causal';END IF;
  NEW.subject_id:=NULL;NEW.original_region_id:=NULL;NEW.input_hash:=NULL;NEW.input_before:=NULL;
  NEW.before_hash:=NULL;NEW.before_fingerprint:=NULL;NEW.unchanged_hash:=NULL;NEW.before_target_version:=NULL;
  RETURN NEW;
 END IF;
 IF current_setting('max_connections')::integer+current_setting('max_prepared_transactions')::integer+current_setting('max_worker_processes')::integer+current_setting('max_wal_senders')::integer>=128
 OR NOT (SELECT count(*)=128 AND min(slot)=0 AND max(slot)=127 AND bool_and(version=1) FROM whaleu_community.discovery_count_epochs)
 OR NOT (SELECT count(*)=128 AND min(slot)=0 AND max(slot)=127 AND bool_and(version=1) FROM whaleu_safety.discovery_count_epochs)
 OR NOT (SELECT count(*)=128 AND min(slot)=0 AND max(slot)=127 AND bool_and(version=1) FROM whaleu_campus.discovery_count_epochs)
 OR NOT whaleu_community.admin_post_removal_inventory_current()
 THEN RAISE EXCEPTION 'Complete bounded administrative input inventory required' USING ERRCODE='23514',CONSTRAINT='admin_post_removal_causal';END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('whaleu:named-block-policy:v1',0));
 PERFORM id FROM whaleu_community.posts WHERE id=NEW.target_id FOR UPDATE;
 SELECT * INTO target_row FROM whaleu_community.admin_post_removal_target(NEW.target_id);
 IF target_row.subject_id IS NULL OR target_row.subject_id=NEW.actor_id THEN
  RAISE EXCEPTION 'Another author original regional post required' USING ERRCODE='23514',CONSTRAINT='admin_post_removal_causal';END IF;
 PERFORM id FROM whaleu_authorization.role_grants WHERE id=NEW.grant_id FOR SHARE;
 IF NOT (CASE WHEN NEW.command->'version'='3'::jsonb THEN whaleu_community.related_content_grant_allowed(NEW.actor_id,NEW.grant_id,target_row.post_id,(NEW.command->>'viewSpaceId')::uuid,'remove') ELSE whaleu_profile.moderation_grant_allowed(NEW.actor_id,NEW.grant_id,target_row.region_id) END)
 OR NOT whaleu_community.admin_post_removal_supported(NEW.actor_id,NEW.target_id,false)
 OR NOT whaleu_profile.moderation_actor_current(NEW.actor_id,clock_timestamp())
 THEN RAISE EXCEPTION 'Current scoped administrative authority required' USING ERRCODE='23514',CONSTRAINT='admin_post_removal_causal';END IF;
 SELECT * INTO p FROM whaleu_community.posts WHERE id=NEW.target_id;
 NEW.subject_id:=target_row.subject_id;NEW.original_region_id:=target_row.region_id;
 NEW.before_target_version:=CASE WHEN NEW.command->'version'='3'::jsonb THEN whaleu_community.related_removal_target_version(NEW.actor_id,NEW.grant_id,'post',NEW.target_id,(NEW.command->>'viewSpaceId')::uuid) ELSE whaleu_community.admin_post_removal_target_version(NEW.target_id) END;
 IF (NEW.receipt->>'outcome'='applied' AND NEW.before_target_version IS DISTINCT FROM NEW.command->>'expectedTargetVersion')
 OR (NEW.receipt->>'code'='ADMIN_POST_REMOVAL_STALE' AND NEW.before_target_version IS NOT DISTINCT FROM NEW.command->>'expectedTargetVersion')
 THEN RAISE EXCEPTION 'Exact post source CAS required' USING ERRCODE='23514',CONSTRAINT='admin_post_removal_causal';END IF;
 NEW.before_hash:=whaleu_profile.moderation_hash(to_jsonb(p));
 NEW.before_fingerprint:=whaleu_community.admin_post_removal_post_fingerprint(NEW.target_id);
 NEW.unchanged_hash:=whaleu_profile.moderation_hash(to_jsonb(p)-ARRAY['deleted_at','local_deletion_transaction']);
 NEW.input_before:=whaleu_community.admin_post_removal_input_facts(NEW.actor_id,NEW.grant_id,NEW.target_id);
 IF NEW.command->'version' IN('2'::jsonb,'3'::jsonb) AND NEW.input_before IS DISTINCT FROM input_observed THEN
  RAISE EXCEPTION 'Original pre-wait post inputs required' USING ERRCODE='23514',CONSTRAINT='admin_post_removal_causal';END IF;
 NEW.input_hash:=whaleu_profile.moderation_hash(NEW.input_before);
 IF NEW.command->'version'='2'::jsonb AND (NEW.punishment_protection_before IS DISTINCT FROM whaleu_safety.account_punishment_protection_hash(NEW.subject_id)
 OR NOT whaleu_safety.account_punishment_unprotected(NEW.subject_id)) THEN
 RAISE EXCEPTION 'Original unprotected source author required' USING ERRCODE='23514',CONSTRAINT='account_punishment_causal';END IF;
 IF NEW.command->'version'='3'::jsonb AND NEW.distribution_before IS DISTINCT FROM whaleu_community.related_content_grant_facts(NEW.actor_id,NEW.grant_id,NEW.target_id,(NEW.command->>'viewSpaceId')::uuid,'remove') THEN
 RAISE EXCEPTION 'Original pre-wait related scope required' USING ERRCODE='23514',CONSTRAINT='admin_post_removal_causal';END IF;
 RETURN NEW;
END$$;

ALTER TABLE whaleu_community.admin_post_removal_commands DROP CONSTRAINT admin_post_removal_versioned_intent;
ALTER TABLE whaleu_community.admin_post_removal_commands ADD CONSTRAINT admin_post_removal_versioned_intent CHECK(
 intent_hash=encode(sha256(convert_to('whaleu:admin-post-removal-command:v'||CASE WHEN command->'version'='3'::jsonb THEN '3' WHEN command->'version'='2'::jsonb THEN '2' ELSE '1' END||chr(10)||whaleu_community.content_canonical_json(jsonb_build_object('actor',actor_id::text,'command',command)),'UTF8')),'hex'));

CREATE OR REPLACE FUNCTION whaleu_community.admin_post_removal_assert_complete(q whaleu_community.admin_post_removal_commands)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE p record;t record;e record;BEGIN
 -- No source rowtype declarations or source reads precede identity-only cancel.
 -- NOWAIT relation fences reject an already queued revocation writer too.
 LOCK TABLE whaleu_identity.accounts,whaleu_identity.sessions,whaleu_identity.access_tokens IN SHARE MODE NOWAIT;
 IF NOT whaleu_profile.moderation_identity_current(q.actor_id,q.session_id,q.token_hash)
 OR q.identity_hash IS DISTINCT FROM whaleu_profile.moderation_hash(whaleu_profile.moderation_identity_facts(q.actor_id,q.session_id,q.token_hash))
 THEN RAISE EXCEPTION 'Original current administrator identity required' USING ERRCODE='23514',CONSTRAINT='admin_post_removal_causal';END IF;
 IF q.receipt->>'code'='ADMIN_POST_REMOVAL_CANCELLED' THEN
  IF q.subject_id IS NOT NULL OR q.grant_id IS NOT NULL OR q.input_before IS NOT NULL
  OR EXISTS(SELECT 1 FROM whaleu_community.admin_post_removal_transitions x WHERE (x.actor_id,x.request_id)=(q.actor_id,q.request_id))
  OR EXISTS(SELECT 1 FROM whaleu_community.admin_post_removal_events x WHERE (x.actor_id,x.request_id)=(q.actor_id,q.request_id))
  OR EXISTS(SELECT 1 FROM whaleu_community.admin_post_removal_statements x WHERE (x.actor_id,x.request_id)=(q.actor_id,q.request_id))
  OR EXISTS(SELECT 1 FROM whaleu_community.admin_post_removal_epochs x WHERE (x.actor_id,x.request_id)=(q.actor_id,q.request_id))
  THEN RAISE EXCEPTION 'Cancelled removal cannot produce administrative side effects' USING ERRCODE='23514',CONSTRAINT='admin_post_removal_causal';END IF;
  RETURN;
 END IF;
 LOCK TABLE whaleu_authorization.role_grants,whaleu_verification.account_heads,whaleu_verification.snapshots,whaleu_verification.assertions,
 whaleu_community.discovery_count_epochs,whaleu_safety.discovery_count_epochs,whaleu_campus.discovery_count_epochs,
 whaleu_community.posts,whaleu_community.report_origins,whaleu_community.publication_requests,
 whaleu_media.media_owner_states,whaleu_media.upload_intents,whaleu_media.assets,whaleu_media.bindings,
 whaleu_media.asset_safety_heads,whaleu_media.asset_safety_events,whaleu_media.variants IN SHARE MODE NOWAIT;
 IF q.command->'version'='3'::jsonb THEN
  PERFORM whaleu_community.related_content_grant_fence();
  IF q.distribution_before IS NULL OR q.distribution_before IS DISTINCT FROM whaleu_community.related_content_grant_facts(q.actor_id,q.grant_id,q.target_id,(q.command->>'viewSpaceId')::uuid,'remove') THEN
   RAISE EXCEPTION 'Original related management sources required at commit' USING ERRCODE='23514',CONSTRAINT='admin_post_removal_causal';END IF;
 END IF;
 IF NOT whaleu_community.admin_post_removal_inventory_current()
 OR NOT (CASE WHEN q.command->'version'='3'::jsonb THEN whaleu_community.related_content_grant_allowed(q.actor_id,q.grant_id,q.target_id,(q.command->>'viewSpaceId')::uuid,'remove') ELSE whaleu_profile.moderation_grant_allowed(q.actor_id,q.grant_id,q.original_region_id) END)
 OR NOT whaleu_profile.moderation_actor_current(q.actor_id,clock_timestamp())
 OR NOT whaleu_community.admin_post_removal_inputs_match(q.actor_id,q.grant_id,q.target_id,q.input_before,q.request_id)
 OR q.input_hash IS DISTINCT FROM whaleu_profile.moderation_hash(q.input_before)
 THEN RAISE EXCEPTION 'Original current scoped removal inputs required' USING ERRCODE='23514',CONSTRAINT='admin_post_removal_causal';END IF;
 SELECT * INTO p FROM whaleu_community.posts WHERE id=q.target_id;
 SELECT * INTO t FROM whaleu_community.admin_post_removal_transitions WHERE actor_id=q.actor_id AND request_id=q.request_id;
 SELECT * INTO e FROM whaleu_community.admin_post_removal_events WHERE actor_id=q.actor_id AND request_id=q.request_id;
 IF q.receipt->>'outcome'='rejected' THEN
  IF p.id IS NULL OR t.request_id IS NOT NULL OR e.id IS NOT NULL
  OR q.before_fingerprint IS DISTINCT FROM whaleu_community.admin_post_removal_post_fingerprint(q.target_id)
  OR NOT whaleu_community.admin_post_removal_supported(q.actor_id,q.target_id,false)
  OR EXISTS(SELECT 1 FROM whaleu_community.admin_post_removal_statements s WHERE (s.actor_id,s.request_id)=(q.actor_id,q.request_id))
  THEN RAISE EXCEPTION 'Stale removal result must remain read-only' USING ERRCODE='23514',CONSTRAINT='admin_post_removal_causal';END IF;RETURN;
 END IF;
 IF p.id IS NULL OR t.request_id IS NULL OR e.id IS NULL OR t.mutation_transaction<>pg_current_xact_id() OR e.mutation_transaction<>pg_current_xact_id()
 OR t.target_id IS DISTINCT FROM q.target_id OR t.before_hash IS DISTINCT FROM q.before_hash OR t.before_fingerprint IS DISTINCT FROM q.before_fingerprint
 OR t.after_hash IS DISTINCT FROM whaleu_profile.moderation_hash(to_jsonb(p))
 OR t.after_fingerprint IS DISTINCT FROM whaleu_community.admin_post_removal_post_fingerprint(q.target_id)
 OR t.unchanged_hash IS DISTINCT FROM q.unchanged_hash OR p.local_deletion_transaction IS DISTINCT FROM pg_current_xact_id() OR p.deleted_at IS DISTINCT FROM e.recorded_at OR p.deleted_at IS DISTINCT FROM t.deleted_at
 OR NOT whaleu_community.admin_post_removal_supported(q.actor_id,q.target_id,true)
 OR EXISTS(SELECT 1 FROM whaleu_community.comment_pins WHERE post_id=q.target_id)
 OR EXISTS(SELECT 1 FROM whaleu_community.post_pins pin WHERE pin.post_id=q.target_id AND NOT EXISTS(SELECT 1 FROM whaleu_community.post_pin_closures c WHERE c.pin_id=pin.id))
 OR NOT EXISTS(SELECT 1 FROM whaleu_community.media_cleanup_jobs j WHERE j.resource_kind='post' AND j.resource_id=q.target_id AND j.post_id=q.target_id
  AND j.source_deleted_at=t.deleted_at AND j.root_comment_id IS NULL AND j.phase='self' AND j.cursor_id IS NULL AND j.detached_targets=0 AND j.enumeration_completed_at IS NULL)
 OR NOT EXISTS(SELECT 1 FROM whaleu_community.outbox o WHERE o.event_key='admin-post-removal:'||e.id::text AND o.event_type='admin_post_removed' AND o.resource_id=q.target_id AND o.local_creation_transaction=pg_current_xact_id())
 OR NOT EXISTS(SELECT 1 FROM whaleu_notifications.admin_post_removal_notices n JOIN whaleu_notifications.system_notice_ids i ON (i.id,i.kind,i.recipient_account_id)=(n.id,n.kind,n.recipient_account_id)
  WHERE n.event_id=e.id AND n.recipient_account_id=e.subject_id AND n.created_at=e.recorded_at AND n.read_at IS NULL)
 THEN RAISE EXCEPTION 'Command, real tombstone, pins, cleanup, independent event and unread notice must commit together' USING ERRCODE='23514',CONSTRAINT='admin_post_removal_causal';END IF;
END$$;

ALTER TABLE whaleu_community.admin_discussion_removal_commands ADD COLUMN distribution_before jsonb;

CREATE OR REPLACE FUNCTION whaleu_community.admin_discussion_removal_command_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_row record;p record;identity_observed jsonb;input_observed jsonb;BEGIN
 identity_observed:=whaleu_profile.moderation_identity_facts(NEW.actor_id,NEW.session_id,NEW.token_hash);
 IF whaleu_community.removal_punishment_envelope_valid(NEW.command,NEW.receipt,NEW.target_kind) IS DISTINCT FROM true
 OR current_setting('transaction_isolation')<>'read committed' OR NEW.mutation_transaction<>pg_current_xact_id()
 OR whaleu_community.post_owner_visibility_keys(NEW.command,ARRAY['clientRequestId','target','expectedTargetVersion','action'] || CASE WHEN NEW.command->'version'='3'::jsonb THEN ARRAY['version','viewSpaceId'] WHEN NEW.command->'version'='2'::jsonb THEN ARRAY['version','punishment'] ELSE ARRAY[]::text[] END) IS DISTINCT FROM true
 OR whaleu_community.post_owner_visibility_keys(NEW.command->'target',ARRAY['kind','id']) IS DISTINCT FROM true
 OR NOT whaleu_profile.moderation_uuid_valid(NEW.target_id::text)
 OR NEW.command->>'clientRequestId' IS DISTINCT FROM NEW.request_id::text
 OR NEW.command->'target'->>'kind' IS DISTINCT FROM NEW.target_kind OR NEW.command->'target'->>'id' IS DISTINCT FROM NEW.target_id::text
 OR NEW.command->>'action' IS DISTINCT FROM 'remove_discussion'
 OR (jsonb_typeof(NEW.command->'expectedTargetVersion')='string' AND NEW.command->>'expectedTargetVersion' ~ '^[a-f0-9]{64}$') IS DISTINCT FROM true
 OR NEW.receipt->>'requestId' IS DISTINCT FROM NEW.request_id::text OR NEW.receipt->'target' IS DISTINCT FROM NEW.command->'target'
 OR NEW.receipt->>'action' IS DISTINCT FROM 'remove_discussion' OR NEW.receipt->'expectedTargetVersion' IS DISTINCT FROM NEW.command->'expectedTargetVersion'
 OR whaleu_community.post_owner_visibility_keys(NEW.receipt,CASE WHEN NEW.receipt->>'outcome'='rejected' THEN ARRAY['requestId','target','expectedTargetVersion','action','outcome','code'] ELSE ARRAY['requestId','target','expectedTargetVersion','action','outcome','eventId','recordedAt'] END || CASE WHEN NEW.command->'version'='3'::jsonb THEN ARRAY['version','viewSpaceId'] WHEN NEW.command->'version'='2'::jsonb THEN CASE WHEN NEW.receipt->>'outcome'='applied' THEN ARRAY['version','selection','punishment'] ELSE ARRAY['version','selection'] END ELSE ARRAY[]::text[] END) IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'Strict exact administrative discussion-removal command required' USING ERRCODE='23514',CONSTRAINT='admin_discussion_removal_causal';END IF;
 IF NEW.receipt->>'outcome'='rejected' THEN
  IF coalesce(NEW.receipt->>'code' IN('ADMIN_DISCUSSION_REMOVAL_STALE','ADMIN_DISCUSSION_REMOVAL_CANCELLED'),false)=false THEN
   RAISE EXCEPTION 'Exact terminal administrative rejection required' USING ERRCODE='23514',CONSTRAINT='admin_discussion_removal_causal';END IF;
 ELSE
  IF NEW.receipt->>'outcome' IS DISTINCT FROM 'applied'
  OR (jsonb_typeof(NEW.receipt->'eventId')='string' AND whaleu_profile.moderation_uuid_valid(NEW.receipt->>'eventId')) IS DISTINCT FROM true
  OR (jsonb_typeof(NEW.receipt->'recordedAt')='string' AND (NEW.receipt->>'recordedAt')~'^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9][.][0-9]{3}Z$') IS DISTINCT FROM true
  OR (NEW.receipt->>'recordedAt')::timestamptz>clock_timestamp()
  THEN RAISE EXCEPTION 'Exact applied administrative receipt required' USING ERRCODE='23514',CONSTRAINT='admin_discussion_removal_causal';END IF;
 END IF;
 IF NEW.receipt->>'code' IS DISTINCT FROM 'ADMIN_DISCUSSION_REMOVAL_CANCELLED' THEN
  input_observed:=whaleu_community.admin_discussion_removal_input_facts(NEW.actor_id,NEW.grant_id,NEW.target_kind,NEW.target_id);
 END IF;
 IF NEW.command->'version'='2'::jsonb AND NEW.receipt->>'code' IS DISTINCT FROM 'ADMIN_DISCUSSION_REMOVAL_CANCELLED' THEN
  SELECT whaleu_safety.account_punishment_protection_hash(t.subject_id) INTO NEW.punishment_protection_before FROM whaleu_community.admin_discussion_removal_target(NEW.target_kind,NEW.target_id) t;
 END IF;
 IF NEW.command->'version'='3'::jsonb AND NEW.receipt->>'code' IS DISTINCT FROM 'ADMIN_DISCUSSION_REMOVAL_CANCELLED' THEN
  NEW.distribution_before:=whaleu_community.related_content_grant_facts(NEW.actor_id,NEW.grant_id,(SELECT post_id FROM whaleu_community.admin_discussion_removal_target(NEW.target_kind,NEW.target_id)),(NEW.command->>'viewSpaceId')::uuid,'remove');
 ELSE NEW.distribution_before:=NULL;END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('whaleu:admin-discussion-removal-request:v1:'||NEW.actor_id::text||':'||NEW.request_id::text,0));
 PERFORM id FROM whaleu_identity.accounts WHERE id=NEW.actor_id FOR SHARE;
 PERFORM id FROM whaleu_identity.sessions WHERE id=NEW.session_id AND account_id=NEW.actor_id FOR SHARE;
 PERFORM token_hash FROM whaleu_identity.access_tokens WHERE token_hash=NEW.token_hash AND session_id=NEW.session_id FOR SHARE;
 IF NOT whaleu_profile.moderation_identity_current(NEW.actor_id,NEW.session_id,NEW.token_hash)
 OR identity_observed IS DISTINCT FROM whaleu_profile.moderation_identity_facts(NEW.actor_id,NEW.session_id,NEW.token_hash) THEN
  RAISE EXCEPTION 'Current actor required' USING ERRCODE='23514',CONSTRAINT='admin_discussion_removal_causal';END IF;
 NEW.identity_hash:=whaleu_profile.moderation_hash(whaleu_profile.moderation_identity_facts(NEW.actor_id,NEW.session_id,NEW.token_hash));
 IF NEW.receipt->>'code'='ADMIN_DISCUSSION_REMOVAL_CANCELLED' THEN
  IF NEW.grant_id IS NOT NULL THEN RAISE EXCEPTION 'Cancellation contains original key only' USING ERRCODE='23514',CONSTRAINT='admin_discussion_removal_causal';END IF;
  NEW.subject_id:=NULL;NEW.post_id:=NULL;NEW.root_id:=NULL;NEW.original_region_id:=NULL;NEW.pin_before:=NULL;NEW.input_hash:=NULL;NEW.input_before:=NULL;
  NEW.before_hash:=NULL;NEW.before_fingerprint:=NULL;NEW.unchanged_hash:=NULL;NEW.before_target_version:=NULL;
  RETURN NEW;
 END IF;
 IF current_setting('max_connections')::integer+current_setting('max_prepared_transactions')::integer+current_setting('max_worker_processes')::integer+current_setting('max_wal_senders')::integer>=128
 OR NOT (SELECT count(*)=128 AND min(slot)=0 AND max(slot)=127 AND bool_and(version=1) FROM whaleu_community.discovery_count_epochs)
 OR NOT (SELECT count(*)=128 AND min(slot)=0 AND max(slot)=127 AND bool_and(version=1) FROM whaleu_safety.discovery_count_epochs)
 OR NOT (SELECT count(*)=128 AND min(slot)=0 AND max(slot)=127 AND bool_and(version=1) FROM whaleu_campus.discovery_count_epochs)
 OR NOT whaleu_community.admin_discussion_removal_inventory_current()
 THEN RAISE EXCEPTION 'Complete bounded administrative input inventory required' USING ERRCODE='23514',CONSTRAINT='admin_discussion_removal_causal';END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('whaleu:named-block-policy:v1',0));
 SELECT * INTO target_row FROM whaleu_community.admin_discussion_removal_target(NEW.target_kind,NEW.target_id);
 PERFORM id FROM whaleu_community.posts WHERE id=target_row.post_id FOR UPDATE;
 PERFORM id FROM whaleu_community.root_comments WHERE id=target_row.root_id AND post_id=target_row.post_id FOR UPDATE;
 IF NEW.target_kind='reply' THEN
  PERFORM id FROM whaleu_community.replies WHERE id=NEW.target_id AND post_id=target_row.post_id AND root_comment_id=target_row.root_id FOR UPDATE;
 END IF;
 SELECT * INTO target_row FROM whaleu_community.admin_discussion_removal_target(NEW.target_kind,NEW.target_id);
 IF target_row.subject_id IS NULL OR target_row.subject_id=NEW.actor_id THEN
  RAISE EXCEPTION 'Another author original regional discussion required' USING ERRCODE='23514',CONSTRAINT='admin_discussion_removal_causal';END IF;
 PERFORM id FROM whaleu_authorization.role_grants WHERE id=NEW.grant_id FOR SHARE;
 IF NOT (CASE WHEN NEW.command->'version'='3'::jsonb THEN whaleu_community.related_content_grant_allowed(NEW.actor_id,NEW.grant_id,target_row.post_id,(NEW.command->>'viewSpaceId')::uuid,'remove') ELSE whaleu_profile.moderation_grant_allowed(NEW.actor_id,NEW.grant_id,target_row.region_id) END)
 OR NOT whaleu_community.admin_discussion_removal_supported(NEW.actor_id,NEW.target_kind,NEW.target_id,false)
 OR NOT whaleu_profile.moderation_actor_current(NEW.actor_id,clock_timestamp())
 THEN RAISE EXCEPTION 'Current scoped administrative authority required' USING ERRCODE='23514',CONSTRAINT='admin_discussion_removal_causal';END IF;
 SELECT payload INTO p FROM whaleu_community.profile_moderation_nodes(NEW.target_kind,NEW.target_id) WHERE kind=NEW.target_kind AND id=NEW.target_id;
 NEW.subject_id:=target_row.subject_id;NEW.post_id:=target_row.post_id;NEW.root_id:=target_row.root_id;NEW.original_region_id:=target_row.region_id;
 NEW.before_target_version:=CASE WHEN NEW.command->'version'='3'::jsonb THEN whaleu_community.related_removal_target_version(NEW.actor_id,NEW.grant_id,NEW.target_kind,NEW.target_id,(NEW.command->>'viewSpaceId')::uuid) ELSE whaleu_community.admin_discussion_removal_target_version(NEW.target_kind,NEW.target_id) END;
 IF (NEW.receipt->>'outcome'='applied' AND NEW.before_target_version IS DISTINCT FROM NEW.command->>'expectedTargetVersion')
 OR (NEW.receipt->>'code'='ADMIN_DISCUSSION_REMOVAL_STALE' AND NEW.before_target_version IS NOT DISTINCT FROM NEW.command->>'expectedTargetVersion')
 THEN RAISE EXCEPTION 'Exact discussion source CAS required' USING ERRCODE='23514',CONSTRAINT='admin_discussion_removal_causal';END IF;
 NEW.before_hash:=whaleu_profile.moderation_hash(p.payload);
 NEW.before_fingerprint:=whaleu_community.admin_discussion_removal_node_fingerprint(NEW.target_kind,NEW.target_id);
 NEW.unchanged_hash:=whaleu_profile.moderation_hash(p.payload-ARRAY['deleted_at','local_deletion_transaction']);
 NEW.input_before:=whaleu_community.admin_discussion_removal_input_facts(NEW.actor_id,NEW.grant_id,NEW.target_kind,NEW.target_id);
 IF NEW.input_before IS DISTINCT FROM input_observed THEN
  RAISE EXCEPTION 'Original pre-wait discussion inputs required' USING ERRCODE='23514',CONSTRAINT='admin_discussion_removal_causal';END IF;
 IF NEW.target_kind='comment' THEN
  SELECT jsonb_build_array(to_jsonb(pin),pin.xmin::text,pin.ctid::text) INTO NEW.pin_before
  FROM whaleu_community.comment_pins pin WHERE pin.post_id=NEW.post_id AND pin.comment_id=NEW.target_id;
 END IF;
 NEW.input_hash:=whaleu_profile.moderation_hash(NEW.input_before);
 IF NEW.command->'version'='2'::jsonb AND (NEW.punishment_protection_before IS DISTINCT FROM whaleu_safety.account_punishment_protection_hash(NEW.subject_id)
 OR NOT whaleu_safety.account_punishment_unprotected(NEW.subject_id)) THEN
 RAISE EXCEPTION 'Original unprotected source author required' USING ERRCODE='23514',CONSTRAINT='account_punishment_causal';END IF;
 IF NEW.command->'version'='3'::jsonb AND NEW.distribution_before IS DISTINCT FROM whaleu_community.related_content_grant_facts(NEW.actor_id,NEW.grant_id,(SELECT post_id FROM whaleu_community.admin_discussion_removal_target(NEW.target_kind,NEW.target_id)),(NEW.command->>'viewSpaceId')::uuid,'remove') THEN
 RAISE EXCEPTION 'Original pre-wait related scope required' USING ERRCODE='23514',CONSTRAINT='admin_discussion_removal_causal';END IF;
 RETURN NEW;
END$$;

ALTER TABLE whaleu_community.admin_discussion_removal_commands DROP CONSTRAINT admin_discussion_removal_versioned_intent;
ALTER TABLE whaleu_community.admin_discussion_removal_commands ADD CONSTRAINT admin_discussion_removal_versioned_intent CHECK(
 intent_hash=encode(sha256(convert_to('whaleu:admin-discussion-removal-command:v'||CASE WHEN command->'version'='3'::jsonb THEN '3' WHEN command->'version'='2'::jsonb THEN '2' ELSE '1' END||chr(10)||whaleu_community.content_canonical_json(jsonb_build_object('actor',actor_id::text,'command',command)),'UTF8')),'hex'));

CREATE OR REPLACE FUNCTION whaleu_community.admin_discussion_removal_assert_complete(q whaleu_community.admin_discussion_removal_commands)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE p record;t record;e record;component record;cleanup record;pin record;relation record;enrolled boolean;BEGIN
 -- No source composite declarations, FK source opens or current-source planning
 -- precede this identity-only cancellation branch, including on a cold backend.
 LOCK TABLE whaleu_identity.accounts,whaleu_identity.sessions,whaleu_identity.access_tokens IN SHARE MODE NOWAIT;
 IF NOT whaleu_profile.moderation_identity_current(q.actor_id,q.session_id,q.token_hash)
 OR q.identity_hash IS DISTINCT FROM whaleu_profile.moderation_hash(whaleu_profile.moderation_identity_facts(q.actor_id,q.session_id,q.token_hash))
 THEN RAISE EXCEPTION 'Original current administrator identity required' USING ERRCODE='23514',CONSTRAINT='admin_discussion_removal_causal';END IF;
 IF q.receipt->>'code'='ADMIN_DISCUSSION_REMOVAL_CANCELLED' THEN
  IF q.subject_id IS NOT NULL OR q.post_id IS NOT NULL OR q.root_id IS NOT NULL OR q.grant_id IS NOT NULL OR q.input_before IS NOT NULL
  OR EXISTS(SELECT 1 FROM whaleu_community.admin_discussion_removal_transitions x WHERE (x.actor_id,x.request_id)=(q.actor_id,q.request_id))
  OR EXISTS(SELECT 1 FROM whaleu_community.admin_discussion_removal_events x WHERE (x.actor_id,x.request_id)=(q.actor_id,q.request_id))
  OR EXISTS(SELECT 1 FROM whaleu_community.admin_discussion_removal_statements x WHERE (x.actor_id,x.request_id)=(q.actor_id,q.request_id))
  OR EXISTS(SELECT 1 FROM whaleu_community.admin_discussion_removal_epochs x WHERE (x.actor_id,x.request_id)=(q.actor_id,q.request_id))
  OR EXISTS(SELECT 1 FROM whaleu_community.admin_discussion_removal_components x WHERE (x.actor_id,x.request_id)=(q.actor_id,q.request_id))
  OR EXISTS(SELECT 1 FROM whaleu_community.admin_discussion_removal_cleanup x WHERE (x.actor_id,x.request_id)=(q.actor_id,q.request_id))
  OR EXISTS(SELECT 1 FROM whaleu_community.admin_discussion_removal_pins x WHERE (x.actor_id,x.request_id)=(q.actor_id,q.request_id))
  THEN RAISE EXCEPTION 'Cancelled removal cannot produce side effects' USING ERRCODE='23514',CONSTRAINT='admin_discussion_removal_causal';END IF;
  RETURN;
 END IF;
 LOCK TABLE whaleu_authorization.role_grants,whaleu_verification.account_heads,whaleu_verification.snapshots,whaleu_verification.assertions,
 whaleu_community.discovery_count_epochs,whaleu_safety.discovery_count_epochs,whaleu_campus.discovery_count_epochs,whaleu_media.media_owner_states,
 whaleu_community.posts,whaleu_community.root_comments,whaleu_community.replies,
 whaleu_community.report_origins,whaleu_community.publication_requests,
 whaleu_community.comment_pins,whaleu_post_hotness.comment_baselines,whaleu_post_hotness.comment_sources IN SHARE MODE NOWAIT;
 -- Fence actual current epoch source relations, rejecting queued writers as
 -- well as already-applied revocations. This does not persist an inventory.
 FOR relation IN
  WITH dependencies AS MATERIALIZED (SELECT classid,objid FROM pg_catalog.pg_depend
   WHERE refclassid='pg_catalog.pg_proc'::regclass AND refobjid IN(
    'whaleu_community.advance_discovery_count_epoch()'::regprocedure,'whaleu_safety.advance_discovery_count_epoch()'::regprocedure,
    'whaleu_campus.advance_discovery_count_epoch()'::regprocedure,'whaleu_media.advance_owner_epoch()'::regprocedure))
  SELECT DISTINCT n.nspname,c.relname FROM dependencies d JOIN pg_catalog.pg_trigger source_trigger ON source_trigger.oid=d.objid
  JOIN pg_catalog.pg_class c ON c.oid=source_trigger.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  WHERE d.classid='pg_catalog.pg_trigger'::regclass AND NOT source_trigger.tgisinternal AND source_trigger.tgenabled<>'D'
   AND source_trigger.tgfoid IN('whaleu_community.advance_discovery_count_epoch()'::regprocedure,'whaleu_safety.advance_discovery_count_epoch()'::regprocedure,
    'whaleu_campus.advance_discovery_count_epoch()'::regprocedure,'whaleu_media.advance_owner_epoch()'::regprocedure)
  ORDER BY n.nspname,c.relname LOOP
  EXECUTE format('LOCK TABLE %I.%I IN SHARE MODE NOWAIT',relation.nspname,relation.relname);
 END LOOP;
 IF q.command->'version'='3'::jsonb THEN
  PERFORM whaleu_community.related_content_grant_fence();
  IF q.distribution_before IS NULL OR q.distribution_before IS DISTINCT FROM whaleu_community.related_content_grant_facts(q.actor_id,q.grant_id,q.post_id,(q.command->>'viewSpaceId')::uuid,'remove') THEN
   RAISE EXCEPTION 'Original related management sources required at commit' USING ERRCODE='23514',CONSTRAINT='admin_discussion_removal_causal';END IF;
 END IF;
 IF NOT whaleu_community.admin_discussion_removal_inventory_current()
 OR NOT (CASE WHEN q.command->'version'='3'::jsonb THEN whaleu_community.related_content_grant_allowed(q.actor_id,q.grant_id,q.post_id,(q.command->>'viewSpaceId')::uuid,'remove') ELSE whaleu_profile.moderation_grant_allowed(q.actor_id,q.grant_id,q.original_region_id) END)
 OR NOT whaleu_profile.moderation_actor_current(q.actor_id,clock_timestamp())
 OR NOT whaleu_community.admin_discussion_removal_inputs_match(q.actor_id,q.grant_id,q.target_kind,q.target_id,q.input_before,q.request_id)
 OR q.input_hash IS DISTINCT FROM whaleu_profile.moderation_hash(q.input_before)
 THEN RAISE EXCEPTION 'Original current scoped discussion inputs required' USING ERRCODE='23514',CONSTRAINT='admin_discussion_removal_causal';END IF;
 SELECT payload INTO p FROM whaleu_community.profile_moderation_nodes(q.target_kind,q.target_id) WHERE kind=q.target_kind AND id=q.target_id;
 SELECT * INTO t FROM whaleu_community.admin_discussion_removal_transitions WHERE actor_id=q.actor_id AND request_id=q.request_id;
 SELECT * INTO e FROM whaleu_community.admin_discussion_removal_events WHERE actor_id=q.actor_id AND request_id=q.request_id;
 SELECT * INTO component FROM whaleu_community.admin_discussion_removal_components WHERE actor_id=q.actor_id AND request_id=q.request_id;
 SELECT * INTO cleanup FROM whaleu_community.admin_discussion_removal_cleanup WHERE actor_id=q.actor_id AND request_id=q.request_id;
 SELECT * INTO pin FROM whaleu_community.admin_discussion_removal_pins WHERE actor_id=q.actor_id AND request_id=q.request_id;
 IF q.receipt->>'outcome'='rejected' THEN
  IF p.payload IS NULL OR t.request_id IS NOT NULL OR e.id IS NOT NULL OR component.request_id IS NOT NULL OR cleanup.request_id IS NOT NULL OR pin.request_id IS NOT NULL
  OR q.before_fingerprint IS DISTINCT FROM whaleu_community.admin_discussion_removal_node_fingerprint(q.target_kind,q.target_id)
  OR NOT whaleu_community.admin_discussion_removal_supported(q.actor_id,q.target_kind,q.target_id,false)
  OR EXISTS(SELECT 1 FROM whaleu_community.admin_discussion_removal_statements s WHERE (s.actor_id,s.request_id)=(q.actor_id,q.request_id))
  THEN RAISE EXCEPTION 'Stale discussion result must remain read-only' USING ERRCODE='23514',CONSTRAINT='admin_discussion_removal_causal';END IF;RETURN;
 END IF;
 IF p.payload IS NULL OR t.request_id IS NULL OR e.id IS NULL OR t.mutation_transaction<>pg_current_xact_id() OR e.mutation_transaction<>pg_current_xact_id()
 OR (t.target_kind,t.target_id,t.post_id,t.root_id) IS DISTINCT FROM (q.target_kind,q.target_id,q.post_id,q.root_id)
 OR t.before_hash IS DISTINCT FROM q.before_hash OR t.before_fingerprint IS DISTINCT FROM q.before_fingerprint
 OR t.after_hash IS DISTINCT FROM whaleu_profile.moderation_hash(p.payload)
 OR t.after_fingerprint IS DISTINCT FROM whaleu_community.admin_discussion_removal_node_fingerprint(q.target_kind,q.target_id)
 OR t.unchanged_hash IS DISTINCT FROM q.unchanged_hash
 OR p.payload->>'local_deletion_transaction' IS DISTINCT FROM pg_current_xact_id()::text
 OR (p.payload->>'deleted_at')::timestamptz IS DISTINCT FROM e.recorded_at OR e.recorded_at IS DISTINCT FROM t.deleted_at
 OR NOT whaleu_community.admin_discussion_removal_supported(q.actor_id,q.target_kind,q.target_id,true)
 OR (q.target_kind='comment' AND EXISTS(SELECT 1 FROM whaleu_community.comment_pins WHERE post_id=q.post_id AND comment_id=q.target_id))
 OR (q.pin_before IS NULL AND pin.request_id IS NOT NULL)
 OR (q.pin_before IS NOT NULL AND (pin.request_id IS NULL OR pin.pin_before IS DISTINCT FROM q.pin_before OR pin.mutation_transaction<>pg_current_xact_id()))
 OR cleanup.request_id IS NULL OR cleanup.mutation_transaction<>pg_current_xact_id()
 OR NOT EXISTS(SELECT 1 FROM whaleu_community.media_cleanup_jobs j WHERE j.id=cleanup.job_id
  AND j.resource_kind=q.target_kind AND j.resource_id=q.target_id AND j.post_id=q.post_id AND j.root_comment_id=q.root_id
  AND j.source_deleted_at=t.deleted_at AND j.phase='self' AND j.cursor_id IS NULL AND j.detached_targets=0 AND j.enumeration_completed_at IS NULL
  AND cleanup.job_fingerprint=whaleu_profile.moderation_hash(jsonb_build_array(to_jsonb(j),j.xmin::text,j.ctid::text)))
 OR NOT EXISTS(SELECT 1 FROM whaleu_community.outbox o WHERE o.event_key='admin-discussion-removal:'||e.id::text AND o.event_type='admin_discussion_removed'
  AND o.resource_id=q.target_id AND o.local_creation_transaction=pg_current_xact_id()
  AND o.context=jsonb_build_object('cause','admin_discussion_removal','eventId',e.id,'kind',q.target_kind,'postId',q.post_id,'rootCommentId',q.root_id,'obligations',jsonb_build_array('content_invalidation','media_cleanup')))
 THEN RAISE EXCEPTION 'Command, exact child tombstone, root pin, pending cleanup and independent event must commit together' USING ERRCODE='23514',CONSTRAINT='admin_discussion_removal_causal';END IF;
 SELECT EXISTS(SELECT 1 FROM whaleu_post_hotness.comment_baselines WHERE post_id=q.post_id) INTO enrolled;
 IF enrolled THEN
  IF component.request_id IS NULL OR component.mutation_transaction<>pg_current_xact_id()
  OR NOT EXISTS(SELECT 1 FROM whaleu_post_hotness.comment_sources s JOIN whaleu_post_hotness.comment_sources positive ON positive.id=s.positive_source_id
   WHERE s.id=component.source_id AND s.post_id=q.post_id AND s.actor_id=q.subject_id AND s.content_id=q.target_id
   AND s.kind=(CASE q.target_kind WHEN 'comment' THEN 'root' ELSE 'reply' END)
   AND s.root_id IS NOT DISTINCT FROM (CASE q.target_kind WHEN 'comment' THEN NULL::uuid ELSE q.root_id END)
   AND s.transition='deleted' AND s.delta=-1 AND s.source_transaction=pg_current_xact_id()
   AND (positive.post_id,positive.actor_id,positive.kind,positive.content_id,positive.root_id,positive.transition)
    IS NOT DISTINCT FROM (s.post_id,s.actor_id,s.kind,s.content_id,s.root_id,'created'::text)
   AND component.source_fingerprint=whaleu_profile.moderation_hash(jsonb_build_array(to_jsonb(s),s.xmin::text,s.ctid::text)))
  THEN RAISE EXCEPTION 'Enrolled child requires its exact canonical negative source' USING ERRCODE='23514',CONSTRAINT='admin_discussion_removal_causal';END IF;
 ELSIF component.request_id IS NOT NULL OR EXISTS(SELECT 1 FROM whaleu_post_hotness.comment_sources s
  WHERE s.kind=(CASE q.target_kind WHEN 'comment' THEN 'root' ELSE 'reply' END) AND s.content_id=q.target_id) THEN
  RAISE EXCEPTION 'Unenrolled content must not invent component history' USING ERRCODE='23514',CONSTRAINT='admin_discussion_removal_causal';
 END IF;
END$$;
ALTER TABLE whaleu_community.post_pin_commands ADD COLUMN distribution_before jsonb;
ALTER TABLE whaleu_community.post_pins ADD COLUMN distribution_before jsonb;
ALTER TABLE whaleu_community.post_pin_reads ADD COLUMN distribution_before jsonb;
CREATE INDEX post_pin_commands_related_transaction ON whaleu_community.post_pin_commands(transaction_id) WHERE command->'version'='2'::jsonb;
DO $$DECLARE c record;BEGIN
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='whaleu_community.post_pin_commands'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%intent_hash%' LOOP
 EXECUTE format('ALTER TABLE whaleu_community.post_pin_commands DROP CONSTRAINT %I',c.conname);END LOOP;
END$$;
ALTER TABLE whaleu_community.post_pin_commands ADD CONSTRAINT post_pin_versioned_intent CHECK(
 intent_hash=encode(sha256(convert_to('whaleu:post-pin:v'||CASE WHEN command->'version'='2'::jsonb THEN '2' ELSE '1' END||chr(10)||whaleu_community.content_canonical_json(jsonb_build_object('actor',actor_id::text,'command',command)),'UTF8')),'hex'));
ALTER TABLE whaleu_community.post_pin_commands ADD CONSTRAINT post_pin_destination_shape CHECK(
 NOT command ? 'version' OR (command->'version'='2'::jsonb AND jsonb_typeof(command->'spaceId')='string' AND whaleu_profile.moderation_uuid_valid(command->>'spaceId')));
CREATE FUNCTION whaleu_community.related_pin_visibility_facts(target uuid) RETURNS jsonb LANGUAGE sql VOLATILE AS $$
 -- Pin/marker/head/closure writes are not sources of these existing owner
 -- epochs. Retain their original complete vectors: no pin-local epoch delta,
 -- refreshed baseline, or current-boolean substitute is permitted. Exact
 -- source tuples additionally preserve native origin, Review and Media state.
 SELECT jsonb_build_object(
 'post',whaleu_community.admin_post_removal_post_fingerprint(target),
 'source',whaleu_community.admin_post_removal_source_facts(target),
 'community',(SELECT jsonb_agg(jsonb_build_array(slot,version,epoch::text) ORDER BY slot) FROM whaleu_community.discovery_count_epochs),
 'safety',(SELECT jsonb_agg(jsonb_build_array(slot,version,epoch::text) ORDER BY slot) FROM whaleu_safety.discovery_count_epochs),
 'campus',(SELECT jsonb_agg(jsonb_build_array(slot,version,epoch::text) ORDER BY slot) FROM whaleu_campus.discovery_count_epochs),
 'media',(SELECT jsonb_agg(jsonb_build_array(slot,version,epoch::text) ORDER BY slot) FROM whaleu_media.media_owner_states))
$$;
CREATE FUNCTION whaleu_community.related_pin_facts(actor uuid,target uuid,view_space uuid) RETURNS jsonb LANGUAGE sql VOLATILE AS $$
 SELECT jsonb_build_object('actor',actor,'distribution',whaleu_community.related_distribution_view_facts(target,view_space),
 'visibility',whaleu_community.related_pin_visibility_facts(target),
 'authorityGeneration',whaleu_safety.account_punishment_authority_epoch())
$$;
CREATE FUNCTION whaleu_community.related_pin_visible(actor uuid,target uuid,view_space uuid) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT EXISTS(SELECT 1 FROM whaleu_community.posts p WHERE p.id=target
  AND whaleu_community.related_distribution_view_allowed(target,view_space)
  AND (p.space_id=view_space AND p.publication_envelope_version<>4
   OR whaleu_community.admin_post_removal_supported(actor,target,false)))
$$;


CREATE OR REPLACE FUNCTION whaleu_community.post_pin_guard() RETURNS trigger LANGUAGE plpgsql AS $$DECLARE s whaleu_community.post_pin_scopes;p whaleu_community.posts;current_pin whaleu_community.post_pins;BEGIN
 SELECT whaleu_community.related_pin_facts(NEW.actor_id,NEW.post_id,destination_scope.space_id) INTO NEW.distribution_before FROM whaleu_community.post_pin_scopes destination_scope WHERE destination_scope.id=NEW.scope_id;
 PERFORM whaleu_community.post_pin_lock(NEW.scope_id);
 SELECT * INTO s FROM whaleu_community.post_pin_scopes WHERE id=NEW.scope_id;
 SELECT * INTO p FROM whaleu_community.posts WHERE id=NEW.post_id FOR SHARE;
 IF NOT EXISTS(SELECT 1 FROM whaleu_community.post_pin_history WHERE scope_id=NEW.scope_id AND coverage='accepted_empty' AND accepted_at<=clock_timestamp() AND valid_until>clock_timestamp()) OR s.accepted_at>clock_timestamp() OR s.valid_until<=clock_timestamp() OR NEW.transaction_id<>pg_current_xact_id() OR p.id IS NULL OR NOT whaleu_community.related_pin_visible(NEW.actor_id,p.id,s.space_id) OR p.deleted_at IS NOT NULL OR p.visibility<>'approved' OR NEW.pinned_at>clock_timestamp() OR NEW.pinned_until<=clock_timestamp() OR (s.kind='university_city' AND p.category<>'discussion') OR (s.kind='feedback' AND p.category<>'feedback') OR (s.kind='regional' AND p.category='feedback') THEN RAISE EXCEPTION 'Exact current pin post and scope required' USING ERRCODE='23514',CONSTRAINT='post_pin_causal';END IF;
 SELECT pins.* INTO current_pin FROM whaleu_community.post_pin_heads h JOIN whaleu_community.post_pins pins ON pins.id=h.pin_id JOIN whaleu_community.posts posts ON posts.id=pins.post_id WHERE h.scope_id=NEW.scope_id AND pins.pinned_until>clock_timestamp() AND posts.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM whaleu_community.post_pin_closures c WHERE c.pin_id=pins.id);
 IF current_pin.id IS NOT NULL THEN RAISE EXCEPTION 'Previous live pin must be explicitly closed' USING ERRCODE='23514',CONSTRAINT='post_pin_causal';END IF;
 IF NEW.distribution_before IS DISTINCT FROM whaleu_community.related_pin_facts(NEW.actor_id,NEW.post_id,s.space_id) THEN RAISE EXCEPTION 'Original pin destination proof required' USING ERRCODE='23514',CONSTRAINT='post_pin_causal';END IF;
 RETURN NEW;
END$$;

CREATE OR REPLACE FUNCTION whaleu_community.post_pin_read_guard() RETURNS trigger LANGUAGE plpgsql AS $$DECLARE sid uuid;destination uuid;target uuid;BEGIN
 SELECT p.post_id,s.space_id INTO target,destination FROM whaleu_community.post_pins p JOIN whaleu_community.post_pin_scopes s ON s.id=p.scope_id WHERE p.id=NEW.pin_id;
 NEW.distribution_before:=whaleu_community.related_pin_facts(NEW.actor_id,target,destination);
 SELECT scope_id INTO sid FROM whaleu_community.post_pins WHERE id=NEW.pin_id;PERFORM whaleu_community.post_pin_lock(sid);
 IF NOT EXISTS(SELECT 1 FROM whaleu_community.post_pins p JOIN whaleu_community.post_pin_heads h ON h.pin_id=p.id AND h.scope_id=p.scope_id JOIN whaleu_community.posts post ON post.id=p.post_id WHERE p.id=NEW.pin_id AND NEW.read_at>=p.pinned_at AND NEW.read_at<=clock_timestamp() AND NEW.read_at<p.pinned_until AND p.pinned_until>clock_timestamp() AND post.deleted_at IS NULL AND post.visibility='approved' AND NOT EXISTS(SELECT 1 FROM whaleu_community.post_pin_closures c WHERE c.pin_id=p.id) FOR SHARE OF post) THEN RAISE EXCEPTION 'Read marker requires exact visible active pin' USING ERRCODE='23514',CONSTRAINT='post_pin_causal';END IF;
 IF NOT whaleu_community.related_pin_visible(NEW.actor_id,target,destination) OR NEW.distribution_before IS DISTINCT FROM whaleu_community.related_pin_facts(NEW.actor_id,target,destination) THEN RAISE EXCEPTION 'Read requires original current related destination' USING ERRCODE='23514',CONSTRAINT='post_pin_causal';END IF;
 RETURN NEW;
END$$;

CREATE OR REPLACE FUNCTION whaleu_community.post_pin_complete() RETURNS trigger LANGUAGE plpgsql AS $$DECLARE q whaleu_community.post_pin_commands;BEGIN
 SELECT * INTO q FROM whaleu_community.post_pin_commands WHERE actor_id=NEW.actor_id AND request_id=NEW.request_id;
 IF q.request_id IS NULL OR q.transaction_id<>pg_current_xact_id() OR q.scope_id IS DISTINCT FROM NEW.scope_id OR q.command->>'operation'<>'pin' OR q.command->>'postId'<>NEW.post_id::text OR q.receipt->>'outcome'<>'applied' OR q.receipt->>'pinId'<>NEW.id::text OR (q.command->>'durationHours')::integer<>NEW.duration_hours OR (q.command->>'level')::integer<>NEW.level THEN RAISE EXCEPTION 'Pin needs original exact command and receipt' USING ERRCODE='23514',CONSTRAINT='post_pin_causal';END IF;RETURN NULL;
END$$;

CREATE OR REPLACE FUNCTION whaleu_community.post_pin_marker_complete() RETURNS trigger LANGUAGE plpgsql AS $$DECLARE q whaleu_community.post_pin_commands;p whaleu_community.post_pins;BEGIN
 IF TG_TABLE_NAME='post_pin_closures' AND NEW.actor_id IS NULL THEN RETURN NULL;END IF;
 SELECT * INTO q FROM whaleu_community.post_pin_commands WHERE actor_id=NEW.actor_id AND request_id=NEW.request_id;
 SELECT * INTO p FROM whaleu_community.post_pins WHERE id=NEW.pin_id;
 IF q.request_id IS NULL OR q.transaction_id<>pg_current_xact_id() OR p.id IS NULL OR p.post_id::text IS DISTINCT FROM q.command->>'postId' OR q.scope_id IS DISTINCT FROM p.scope_id OR q.receipt->>'outcome'<>'applied' THEN RAISE EXCEPTION 'Pin marker needs same-transaction exact owner command' USING ERRCODE='23514',CONSTRAINT='post_pin_causal';END IF;
 IF TG_TABLE_NAME='post_pin_reads' THEN
  IF q.command->>'operation'<>'read' OR q.command->>'pinId' IS DISTINCT FROM NEW.pin_id::text OR q.receipt->>'pinId' IS DISTINCT FROM NEW.pin_id::text THEN RAISE EXCEPTION 'Read marker needs exact pin read command' USING ERRCODE='23514',CONSTRAINT='post_pin_causal';END IF;
 ELSE
  IF (NEW.reason='unpin' AND(q.command->>'operation'<>'unpin' OR q.command->>'pinId' IS DISTINCT FROM NEW.pin_id::text OR q.receipt->>'pinId' IS DISTINCT FROM NEW.pin_id::text)) OR (NEW.reason='renewed' AND(q.command->>'operation'<>'pin' OR NOT EXISTS(SELECT 1 FROM whaleu_community.post_pins WHERE id=(q.receipt->>'pinId')::uuid AND actor_id=NEW.actor_id AND request_id=NEW.request_id AND scope_id=p.scope_id AND post_id=p.post_id))) THEN RAISE EXCEPTION 'Closure needs exact unpin or same-post renewal' USING ERRCODE='23514',CONSTRAINT='post_pin_causal';END IF;
 END IF;RETURN NULL;
END$$;

CREATE FUNCTION whaleu_community.post_pin_distribution_admit() RETURNS trigger LANGUAGE plpgsql AS $$DECLARE target uuid;view_space uuid;BEGIN
 NEW.distribution_before:=NULL;
 IF NEW.command->'version'='2'::jsonb AND NEW.receipt->>'code' IS DISTINCT FROM 'POST_PIN_CANCELLED' THEN
  SELECT space_id INTO view_space FROM whaleu_community.post_pin_scopes WHERE id=NEW.scope_id;
  IF view_space IS DISTINCT FROM (NEW.command->>'spaceId')::uuid THEN RAISE EXCEPTION 'Exact versioned pin destination required' USING ERRCODE='23514',CONSTRAINT='post_pin_causal';END IF;
  target:=(NEW.command->>'postId')::uuid;
  NEW.distribution_before:=CASE WHEN NEW.command->>'operation'='unpin' THEN
   jsonb_build_object('grant',(SELECT jsonb_build_array(to_jsonb(g),g.xmin::text,g.ctid::text) FROM whaleu_authorization.role_grants g WHERE g.id=NEW.grant_id),
    'authorityGeneration',whaleu_safety.account_punishment_authority_epoch())
   ELSE whaleu_community.related_pin_facts(NEW.actor_id,target,view_space) END;
 END IF;
 RETURN NEW;
END$$;
CREATE TRIGGER post_pin_distribution_admit BEFORE INSERT ON whaleu_community.post_pin_commands FOR EACH ROW EXECUTE FUNCTION whaleu_community.post_pin_distribution_admit();


CREATE FUNCTION whaleu_community.post_pin_assert_complete(q whaleu_community.post_pin_commands) RETURNS void LANGUAGE plpgsql AS $$
DECLARE instant timestamptz:=clock_timestamp();scope whaleu_community.post_pin_scopes;target whaleu_community.posts;pin whaleu_community.post_pins;operation text:=q.command->>'operation';applied boolean:=q.receipt->>'outcome'='applied';current_pin uuid;
BEGIN
 IF q.transaction_id<>pg_current_xact_id() OR NOT EXISTS(SELECT 1 FROM whaleu_identity.sessions s JOIN whaleu_identity.accounts a ON a.id=s.account_id WHERE s.id=q.session_id AND s.account_id=q.actor_id AND a.status='active' AND s.revoked_at IS NULL AND s.absolute_expires_at>instant) THEN RAISE EXCEPTION 'Current actor session required for pin command' USING ERRCODE='23514',CONSTRAINT='post_pin_causal';END IF;
 IF operation IS NULL OR operation NOT IN('pin','unpin','read') OR NOT whaleu_community.post_pin_keys(q.command,CASE WHEN operation='pin' THEN ARRAY['clientRequestId','operation','postId','durationHours','level'] ELSE ARRAY['clientRequestId','operation','postId','pinId'] END || CASE WHEN q.command->'version'='2'::jsonb THEN ARRAY['version','spaceId'] ELSE ARRAY[]::text[] END) OR NOT whaleu_community.post_pin_keys(q.receipt,CASE WHEN applied THEN ARRAY['requestId','operation','postId','outcome','pinId','recordedAt'] ELSE ARRAY['requestId','operation','postId','outcome','code'] END) THEN RAISE EXCEPTION 'Exact pin intent and receipt required' USING ERRCODE='23514',CONSTRAINT='post_pin_causal';END IF;
 IF q.receipt->>'outcome'='rejected' AND q.receipt->>'code'='POST_PIN_CANCELLED' AND NOT applied THEN
  IF q.scope_id IS NOT NULL OR q.grant_id IS NOT NULL OR EXISTS(SELECT 1 FROM whaleu_community.post_pins WHERE actor_id=q.actor_id AND request_id=q.request_id) OR EXISTS(SELECT 1 FROM whaleu_community.post_pin_closures WHERE actor_id=q.actor_id AND request_id=q.request_id) OR EXISTS(SELECT 1 FROM whaleu_community.post_pin_reads WHERE actor_id=q.actor_id AND request_id=q.request_id) THEN RAISE EXCEPTION 'Cancelled pin request cannot mutate' USING ERRCODE='23514',CONSTRAINT='post_pin_causal';END IF;
  RETURN;
 END IF;
 SELECT * INTO scope FROM whaleu_community.post_pin_scopes WHERE id=q.scope_id;
 IF scope.id IS NULL OR scope.accepted_at>instant OR scope.valid_until<=instant OR NOT EXISTS(SELECT 1 FROM whaleu_community.post_pin_history h WHERE h.scope_id=scope.id AND h.coverage='accepted_empty' AND h.accepted_at<=instant AND h.valid_until>instant) OR NOT EXISTS(SELECT 1 FROM whaleu_community.spaces s WHERE s.id=scope.space_id AND s.is_active AND ((scope.kind='regional' AND s.kind='regional' AND s.operating_region_id=scope.operating_region_id AND EXISTS(SELECT 1 FROM whaleu_campus.operating_regions r WHERE r.id=scope.operating_region_id AND r.is_active)) OR(scope.kind<>'regional' AND s.kind='global' AND s.operating_region_id IS NULL))) THEN RAISE EXCEPTION 'Current accepted pin scope and independent history required' USING ERRCODE='23514',CONSTRAINT='post_pin_causal';END IF;
 IF operation<>'read' AND NOT EXISTS(SELECT 1 FROM whaleu_authorization.role_grants g WHERE g.id=q.grant_id AND g.account_id=q.actor_id AND g.revoked_at IS NULL AND g.valid_from<=instant AND (g.expires_at IS NULL OR g.expires_at>instant) AND (((g.role='super_admin' OR (g.role='developer' AND NOT EXISTS(SELECT 1 FROM whaleu_community.posts p WHERE p.id=(q.command->>'postId')::uuid AND p.space_id<>scope.space_id))) AND g.operating_region_id IS NULL) OR(g.role='school_admin' AND scope.kind='regional' AND g.operating_region_id=scope.operating_region_id))) THEN RAISE EXCEPTION 'Exact current scoped pin grant required' USING ERRCODE='23514',CONSTRAINT='post_pin_causal';END IF;
 SELECT * INTO target FROM whaleu_community.posts WHERE id=(q.command->>'postId')::uuid;
 IF target.id IS NULL THEN RAISE EXCEPTION 'Pin command target required' USING ERRCODE='23514',CONSTRAINT='post_pin_causal';END IF;
 IF q.command->'version'='2'::jsonb THEN
  IF operation='unpin' THEN
   -- Cleanup keeps only the exact current destination grant. It does not reopen
   -- topology, Review, Media or distribution owners for a withdrawn projection.
   LOCK TABLE whaleu_authorization.role_grants,whaleu_authorization.account_punishment_authority_epoch IN SHARE MODE NOWAIT;
  ELSE PERFORM whaleu_community.related_content_grant_fence();END IF;
  IF scope.space_id::text IS DISTINCT FROM q.command->>'spaceId' OR q.distribution_before IS NULL THEN RAISE EXCEPTION 'Exact destination command required' USING ERRCODE='23514',CONSTRAINT='post_pin_causal';END IF;
  IF operation='unpin' THEN
   IF q.distribution_before IS DISTINCT FROM jsonb_build_object('grant',(SELECT jsonb_build_array(to_jsonb(g),g.xmin::text,g.ctid::text) FROM whaleu_authorization.role_grants g WHERE g.id=q.grant_id),'authorityGeneration',whaleu_safety.account_punishment_authority_epoch()) THEN RAISE EXCEPTION 'Exact original cleanup grant required' USING ERRCODE='23514',CONSTRAINT='post_pin_causal';END IF;
  ELSIF NOT whaleu_community.related_pin_visible(q.actor_id,target.id,scope.space_id)
   OR q.distribution_before IS DISTINCT FROM whaleu_community.related_pin_facts(q.actor_id,target.id,scope.space_id)
   OR EXISTS(SELECT 1 FROM whaleu_community.post_pins p WHERE p.actor_id=q.actor_id AND p.request_id=q.request_id AND p.distribution_before IS DISTINCT FROM q.distribution_before)
   OR EXISTS(SELECT 1 FROM whaleu_community.post_pin_reads r WHERE r.actor_id=q.actor_id AND r.request_id=q.request_id AND r.distribution_before IS DISTINCT FROM q.distribution_before)
   THEN RAISE EXCEPTION 'Original current pin projection required' USING ERRCODE='23514',CONSTRAINT='post_pin_causal';END IF;
 ELSIF target.space_id<>scope.space_id THEN RAISE EXCEPTION 'Legacy pin command cannot select remote destination' USING ERRCODE='23514',CONSTRAINT='post_pin_causal';END IF;
 SELECT p.id INTO current_pin FROM whaleu_community.post_pin_heads h JOIN whaleu_community.post_pins p ON p.id=h.pin_id JOIN whaleu_community.posts post ON post.id=p.post_id WHERE h.scope_id=scope.id AND p.pinned_until>instant AND post.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM whaleu_community.post_pin_closures c WHERE c.pin_id=p.id);
 IF NOT applied THEN
  IF EXISTS(SELECT 1 FROM whaleu_community.post_pins WHERE actor_id=q.actor_id AND request_id=q.request_id) OR EXISTS(SELECT 1 FROM whaleu_community.post_pin_closures WHERE actor_id=q.actor_id AND request_id=q.request_id) OR EXISTS(SELECT 1 FROM whaleu_community.post_pin_reads WHERE actor_id=q.actor_id AND request_id=q.request_id) THEN RAISE EXCEPTION 'Rejected pin command cannot mutate' USING ERRCODE='23514',CONSTRAINT='post_pin_causal';END IF;
  IF q.receipt->>'code'='POST_PIN_CONFLICT' AND operation='pin' AND EXISTS(SELECT 1 FROM whaleu_community.post_pins WHERE id=current_pin AND post_id<>target.id) THEN RETURN;END IF;
  IF q.receipt->>'code'='POST_PIN_STALE' AND operation IN('read','unpin') AND NOT EXISTS(SELECT 1 FROM whaleu_community.post_pins WHERE id=current_pin AND id=(q.command->>'pinId')::uuid AND post_id=target.id) THEN RETURN;END IF;
  RAISE EXCEPTION 'Pin rejection must be causal' USING ERRCODE='23514',CONSTRAINT='post_pin_causal';
 END IF;
 SELECT * INTO pin FROM whaleu_community.post_pins WHERE id=(q.receipt->>'pinId')::uuid;
 IF pin.id IS NULL OR pin.scope_id<>scope.id OR pin.post_id<>target.id THEN RAISE EXCEPTION 'Exact pin receipt target required' USING ERRCODE='23514',CONSTRAINT='post_pin_causal';END IF;
 IF operation='pin' THEN
  IF (q.receipt->>'recordedAt')::timestamptz IS DISTINCT FROM date_trunc('milliseconds',pin.pinned_at) OR pin.actor_id<>q.actor_id OR pin.request_id<>q.request_id OR pin.id IS DISTINCT FROM current_pin THEN RAISE EXCEPTION 'Pin receipt needs atomic current identity' USING ERRCODE='23514',CONSTRAINT='post_pin_causal';END IF;
 ELSIF pin.id::text IS DISTINCT FROM q.command->>'pinId' THEN RAISE EXCEPTION 'Exact original pin required' USING ERRCODE='23514',CONSTRAINT='post_pin_causal';
 ELSIF operation='unpin' THEN
  IF NOT EXISTS(SELECT 1 FROM whaleu_community.post_pin_closures WHERE pin_id=pin.id AND reason='unpin' AND actor_id=q.actor_id AND request_id=q.request_id AND date_trunc('milliseconds',closed_at)=(q.receipt->>'recordedAt')::timestamptz) THEN RAISE EXCEPTION 'Unpin receipt needs exact atomic closure' USING ERRCODE='23514',CONSTRAINT='post_pin_causal';END IF;
 ELSE
  IF pin.id IS DISTINCT FROM current_pin OR target.visibility<>'approved' OR target.deleted_at IS NOT NULL OR NOT EXISTS(SELECT 1 FROM whaleu_community.post_pin_reads WHERE actor_id=q.actor_id AND pin_id=pin.id AND date_trunc('milliseconds',read_at)=(q.receipt->>'recordedAt')::timestamptz) THEN RAISE EXCEPTION 'Read receipt needs visible current exact pin marker' USING ERRCODE='23514',CONSTRAINT='post_pin_causal';END IF;
 END IF;
 RETURN;
END$$;

CREATE OR REPLACE FUNCTION whaleu_community.post_pin_command_complete() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 PERFORM whaleu_community.post_pin_assert_complete(NEW);RETURN NULL;END$$;
CREATE FUNCTION whaleu_community.related_management_recheck_active() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE post_command whaleu_community.admin_post_removal_commands;
 discussion_command whaleu_community.admin_discussion_removal_commands;
 pin_command whaleu_community.post_pin_commands;
BEGIN
 FOR post_command IN SELECT * FROM whaleu_community.admin_post_removal_commands WHERE mutation_transaction=pg_current_xact_id() AND command->'version'='3'::jsonb LOOP
  PERFORM whaleu_community.admin_post_removal_assert_complete(post_command);END LOOP;
 FOR discussion_command IN SELECT * FROM whaleu_community.admin_discussion_removal_commands WHERE mutation_transaction=pg_current_xact_id() AND command->'version'='3'::jsonb LOOP
  PERFORM whaleu_community.admin_discussion_removal_assert_complete(discussion_command);END LOOP;
 FOR pin_command IN SELECT * FROM whaleu_community.post_pin_commands WHERE transaction_id=pg_current_xact_id() AND command->'version'='2'::jsonb LOOP
  PERFORM whaleu_community.post_pin_assert_complete(pin_command);END LOOP;
 RETURN NULL;
END$$;
CREATE CONSTRAINT TRIGGER related_management_recheck AFTER INSERT OR UPDATE ON whaleu_campus.community_distribution_generation DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community.related_management_recheck_active();
CREATE CONSTRAINT TRIGGER related_management_recheck AFTER INSERT OR UPDATE ON whaleu_community.related_sync_view_generation DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community.related_management_recheck_active();
CREATE CONSTRAINT TRIGGER related_management_recheck AFTER UPDATE ON whaleu_authorization.account_punishment_authority_epoch DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community.related_management_recheck_active();
CREATE CONSTRAINT TRIGGER related_management_recheck AFTER UPDATE ON whaleu_community.post_category_read_epoch DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community.related_management_recheck_active();
DO $$DECLARE rel text;BEGIN
 FOREACH rel IN ARRAY ARRAY['whaleu_community.discovery_count_epochs','whaleu_safety.discovery_count_epochs','whaleu_campus.discovery_count_epochs','whaleu_media.media_owner_states'] LOOP
  EXECUTE format('CREATE CONSTRAINT TRIGGER related_management_recheck AFTER INSERT OR UPDATE OR DELETE ON %s DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community.related_management_recheck_active()',rel);
 END LOOP;
END$$;

