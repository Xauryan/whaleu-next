-- Ordinary original-region native comment/reply removal. Legacy ordinary
-- ban_user=0 removes only the selected child and does not notify or deduct XP.
-- This forward migration preserves all old owners, journals and migration bytes.
CREATE FUNCTION whaleu_community.admin_discussion_removal_target(target_kind text,target uuid)
RETURNS TABLE(subject_id uuid,post_id uuid,root_id uuid,region_id uuid)
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT n.account_id,n.post_id,n.root_id,s.operating_region_id
 FROM whaleu_community.profile_moderation_nodes(target_kind,target) n
 JOIN whaleu_community.posts p ON p.id=n.post_id
 JOIN whaleu_community.spaces s ON s.id=p.space_id
 JOIN whaleu_community.content_approval_bindings b ON b.content_kind='post' AND b.content_id=p.id
 WHERE target_kind IN('comment','reply') AND n.kind=target_kind AND n.id=target
 AND n.author_mode IN('named','anonymous') AND s.kind='regional' AND s.is_active AND s.operating_region_id IS NOT NULL
 AND b.scope->>'sync'='none' AND b.scope->>'originalSpaceId'=s.id::text
 AND b.scope->>'originalRegionId'=s.operating_region_id::text
 AND EXISTS(SELECT 1 FROM whaleu_campus.operating_regions r WHERE r.id=s.operating_region_id AND r.is_active)
$$;
CREATE FUNCTION whaleu_community.admin_discussion_removal_supported(actor uuid,target_kind text,target uuid,allow_removed boolean DEFAULT false) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
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

-- Every physical ancestry tuple is observed, but only the selected child may
-- change. xmin plus ctid detects same-value / same-transaction ABA rewrites.
CREATE FUNCTION whaleu_community.admin_discussion_removal_node_fingerprint(kind text,target uuid)
RETURNS text LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT whaleu_profile.moderation_hash(jsonb_build_array(to_jsonb(p),p.xmin::text,p.ctid::text))
 FROM whaleu_community.posts p WHERE kind='post' AND p.id=target
 UNION ALL SELECT whaleu_profile.moderation_hash(jsonb_build_array(to_jsonb(c),c.xmin::text,c.ctid::text))
 FROM whaleu_community.root_comments c WHERE kind='comment' AND c.id=target
 UNION ALL SELECT whaleu_profile.moderation_hash(jsonb_build_array(to_jsonb(r),r.xmin::text,r.ctid::text))
 FROM whaleu_community.replies r WHERE kind='reply' AND r.id=target
$$;
CREATE FUNCTION whaleu_community.admin_discussion_removal_category_facts(target uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_array(to_jsonb(h),h.xmin::text,h.ctid::text,to_jsonb(e),e.xmin::text,e.ctid::text,
  to_jsonb(p),p.xmin::text,p.ctid::text,to_jsonb(ph),ph.xmin::text,ph.ctid::text,
  to_jsonb(i),i.xmin::text,i.ctid::text,to_jsonb(iw),iw.xmin::text,iw.ctid::text,
  to_jsonb(pw),pw.xmin::text,pw.ctid::text,to_jsonb(r),r.xmin::text,r.ctid::text,
  to_jsonb(rw),rw.xmin::text,rw.ctid::text,to_jsonb(live))
 FROM whaleu_community.post_category_heads h
 LEFT JOIN whaleu_community.post_category_events e ON e.id=h.event_id
 LEFT JOIN whaleu_community.post_category_policies p ON p.id=e.policy_id
 LEFT JOIN whaleu_community.post_category_policy_heads ph ON ph.source_key=p.source_key
 LEFT JOIN whaleu_community.post_category_issuers i ON i.id=p.issuer_id
 LEFT JOIN whaleu_community.post_category_issuer_withdrawals iw ON iw.issuer_id=i.id
 LEFT JOIN whaleu_community.post_category_policy_withdrawals pw ON pw.policy_id=p.id
 LEFT JOIN whaleu_community.post_category_reviews r ON r.id=e.review_id
 LEFT JOIN whaleu_community.post_category_review_withdrawals rw ON rw.review_id=r.id
 LEFT JOIN whaleu_community.post_category_live live ON live.post_id=h.post_id
 WHERE h.post_id=target
$$;
CREATE FUNCTION whaleu_community.admin_discussion_removal_source_facts(target_kind text,target uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 WITH nodes AS MATERIALIZED (SELECT * FROM whaleu_community.profile_moderation_nodes(target_kind,target)),
 routing AS (SELECT post_id FROM nodes WHERE kind=target_kind AND id=target)
 SELECT jsonb_build_object(
 'ancestors',(SELECT jsonb_agg(jsonb_build_array(n.kind,n.id,whaleu_community.admin_discussion_removal_node_fingerprint(n.kind,n.id)) ORDER BY n.kind,n.id)
  FROM nodes n WHERE (n.kind,n.id)<>(target_kind,target)),
 'nodes',(SELECT jsonb_agg(jsonb_build_array(n.kind,n.id,
  to_jsonb(b),b.xmin::text,b.ctid::text,to_jsonb(d),d.xmin::text,d.ctid::text,
  to_jsonb(h),h.xmin::text,h.ctid::text,to_jsonb(e),e.xmin::text,e.ctid::text,
  to_jsonb(pol),pol.xmin::text,pol.ctid::text,
  to_jsonb(o),o.xmin::text,o.ctid::text,to_jsonb(q),q.xmin::text,q.ctid::text,
  whaleu_profile.avatar_moderation_media_facts(n.kind,n.id)) ORDER BY n.kind,n.id)
  FROM nodes n
  LEFT JOIN whaleu_community.content_approval_bindings b ON b.content_kind=n.kind AND b.content_id=n.id
  LEFT JOIN whaleu_community.content_approval_decisions d ON d.id=b.decision_id
  LEFT JOIN whaleu_community.content_approval_heads h ON h.decision_id=d.id
  LEFT JOIN whaleu_community.content_approval_events e ON (e.id,e.decision_id)=(h.event_id,d.id)
  LEFT JOIN whaleu_community.content_approval_policies pol ON pol.id=d.policy_revision_id
  LEFT JOIN whaleu_community.report_origins o ON o.kind=n.kind AND o.target_id=n.id
  LEFT JOIN whaleu_community.publication_requests q ON (q.account_id,q.client_request_id)=(o.owner_account_id,o.source_request_id)),
 'scope',(SELECT jsonb_build_array(to_jsonb(s),s.xmin::text,s.ctid::text,to_jsonb(r),r.xmin::text,r.ctid::text)
  FROM routing q JOIN whaleu_community.posts p ON p.id=q.post_id JOIN whaleu_community.spaces s ON s.id=p.space_id
  LEFT JOIN whaleu_campus.operating_regions r ON r.id=s.operating_region_id),
 'visibility',(SELECT jsonb_build_array(to_jsonb(v),v.xmin::text,v.ctid::text)
  FROM routing q JOIN whaleu_community.post_owner_visibility v ON v.post_id=q.post_id),
 'category',(SELECT whaleu_community.admin_discussion_removal_category_facts(post_id) FROM routing),
 'categoryChildren',(SELECT jsonb_agg(jsonb_build_array(n.kind,n.id,
  to_jsonb(c),c.xmin::text,c.ctid::text,to_jsonb(e),e.xmin::text,e.ctid::text,
  to_jsonb(r),r.xmin::text,r.ctid::text,to_jsonb(rw),rw.xmin::text,rw.ctid::text,
  to_jsonb(p),p.xmin::text,p.ctid::text,to_jsonb(ph),ph.xmin::text,ph.ctid::text,
  to_jsonb(pw),pw.xmin::text,pw.ctid::text,to_jsonb(i),i.xmin::text,i.ctid::text,
  to_jsonb(iw),iw.xmin::text,iw.ctid::text,to_jsonb(live)) ORDER BY n.kind,n.id)
  FROM nodes n
  LEFT JOIN whaleu_community.post_category_child_bindings c ON c.content_kind=n.kind AND c.content_id=n.id
  LEFT JOIN whaleu_community.post_category_events e ON e.id=c.event_id
  LEFT JOIN whaleu_community.post_category_reviews r ON r.id=c.review_id
  LEFT JOIN whaleu_community.post_category_review_withdrawals rw ON rw.review_id=r.id
  LEFT JOIN whaleu_community.post_category_policies p ON p.id=r.policy_id
  LEFT JOIN whaleu_community.post_category_policy_heads ph ON ph.source_key=p.source_key
  LEFT JOIN whaleu_community.post_category_policy_withdrawals pw ON pw.policy_id=p.id
  LEFT JOIN whaleu_community.post_category_issuers i ON i.id=p.issuer_id
  LEFT JOIN whaleu_community.post_category_issuer_withdrawals iw ON iw.issuer_id=i.id
  LEFT JOIN whaleu_community.post_category_review_live live ON live.id=r.id WHERE n.kind<>'post'),
 'componentBaseline',(SELECT jsonb_build_array(to_jsonb(b),b.xmin::text,b.ctid::text)
  FROM routing q JOIN whaleu_post_hotness.comment_baselines b ON b.post_id=q.post_id),
 'componentPositive',(SELECT jsonb_build_array(to_jsonb(s),s.xmin::text,s.ctid::text)
  FROM whaleu_post_hotness.comment_sources s WHERE s.kind=(CASE target_kind WHEN 'comment' THEN 'root' ELSE 'reply' END)
  AND s.content_id=target AND s.transition='created'))
$$;
CREATE FUNCTION whaleu_community.admin_discussion_removal_target_version(target_kind text,target uuid)
RETURNS text LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT encode(sha256(convert_to('whaleu:admin-discussion-removal-target:v1'||chr(10)||
 whaleu_community.content_canonical_json(jsonb_build_object('kind',target_kind,'id',target,
 'target',whaleu_community.admin_discussion_removal_node_fingerprint(target_kind,target),
 'source',whaleu_community.admin_discussion_removal_source_facts(target_kind,target))),'UTF8')),'hex')
$$;
CREATE FUNCTION whaleu_community.admin_discussion_removal_input_facts(actor uuid,selected uuid,target_kind text,target uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object(
 'target',whaleu_community.admin_discussion_removal_node_fingerprint(target_kind,target),
 'community',(SELECT jsonb_agg(jsonb_build_array(slot,version,epoch::text) ORDER BY slot) FROM whaleu_community.discovery_count_epochs),
 'unchanged',whaleu_profile.moderation_hash(jsonb_build_object(
 'grant',(SELECT jsonb_build_array(to_jsonb(g),g.xmin::text,g.ctid::text) FROM whaleu_authorization.role_grants g WHERE g.id=selected),
 'source',whaleu_community.admin_discussion_removal_source_facts(target_kind,target),
 'phone',(SELECT jsonb_build_array(to_jsonb(h),h.xmin::text,h.ctid::text,to_jsonb(s),s.xmin::text,s.ctid::text,to_jsonb(a),a.xmin::text,a.ctid::text)
  FROM whaleu_verification.account_heads h JOIN whaleu_verification.snapshots s ON s.id=h.snapshot_id
  JOIN whaleu_verification.assertions a ON a.id=s.phone_assertion_id WHERE h.account_id=actor),
 'media',(SELECT jsonb_agg(jsonb_build_array(slot,version,epoch::text) ORDER BY slot) FROM whaleu_media.media_owner_states),
 'safety',(SELECT jsonb_agg(jsonb_build_array(slot,version,epoch::text) ORDER BY slot) FROM whaleu_safety.discovery_count_epochs),
 'campus',(SELECT jsonb_agg(jsonb_build_array(slot,version,epoch::text) ORDER BY slot) FROM whaleu_campus.discovery_count_epochs))))
$$;

CREATE TABLE whaleu_community.admin_discussion_removal_commands (
 actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),request_id uuid NOT NULL,
 session_id uuid NOT NULL REFERENCES whaleu_identity.sessions(id),token_hash text NOT NULL,
 target_kind text NOT NULL CHECK(target_kind IN('comment','reply')),target_id uuid NOT NULL,intent_hash text NOT NULL,command jsonb NOT NULL,receipt jsonb NOT NULL,
 -- No nullable source/grant FKs: cold-backend cancellation stays identity-only.
 grant_id uuid,subject_id uuid,post_id uuid,root_id uuid,original_region_id uuid,
 identity_hash text NOT NULL DEFAULT '',input_hash text,input_before jsonb,
 before_hash text,before_fingerprint text,unchanged_hash text,before_target_version text,pin_before jsonb,
 mutation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),PRIMARY KEY(actor_id,request_id),
 CHECK(request_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
 CHECK(octet_length(command::text)<4096 AND octet_length(receipt::text)<4096),
 CHECK(intent_hash=encode(sha256(convert_to('whaleu:admin-discussion-removal-command:v1'||chr(10)||whaleu_community.content_canonical_json(jsonb_build_object('actor',actor_id::text,'command',command)),'UTF8')),'hex'))
);
CREATE INDEX admin_discussion_removal_commands_transaction ON whaleu_community.admin_discussion_removal_commands(mutation_transaction,target_kind,target_id);
-- One mutation-aware allowance per transaction; separate pre-existing owner
-- proofs stay strict and cannot be erased by batching an unrelated command.
CREATE UNIQUE INDEX admin_discussion_removal_one_transaction ON whaleu_community.admin_discussion_removal_commands(mutation_transaction) WHERE receipt->>'outcome'='applied';
CREATE TABLE whaleu_community.admin_discussion_removal_statements (
 actor_id uuid NOT NULL,request_id uuid NOT NULL,mutation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 PRIMARY KEY(actor_id,request_id),FOREIGN KEY(actor_id,request_id) REFERENCES whaleu_community.admin_discussion_removal_commands(actor_id,request_id)
);
CREATE TABLE whaleu_community.admin_discussion_removal_epochs (
 actor_id uuid NOT NULL,request_id uuid NOT NULL,slot integer NOT NULL,version integer NOT NULL CHECK(version=1),
 before_epoch bigint NOT NULL,after_epoch bigint NOT NULL CHECK(after_epoch=before_epoch+1),
 mutation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),PRIMARY KEY(actor_id,request_id),
 FOREIGN KEY(actor_id,request_id) REFERENCES whaleu_community.admin_discussion_removal_statements(actor_id,request_id)
);
CREATE TABLE whaleu_community.admin_discussion_removal_transitions (
 actor_id uuid NOT NULL,request_id uuid NOT NULL,target_kind text NOT NULL CHECK(target_kind IN('comment','reply')),target_id uuid NOT NULL,
 post_id uuid NOT NULL REFERENCES whaleu_community.posts(id),root_id uuid NOT NULL,
 before_hash text NOT NULL,before_fingerprint text NOT NULL,after_hash text NOT NULL,after_fingerprint text NOT NULL,unchanged_hash text NOT NULL,
 deleted_at timestamptz NOT NULL,mutation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 PRIMARY KEY(actor_id,request_id),UNIQUE(target_kind,target_id),
 FOREIGN KEY(actor_id,request_id) REFERENCES whaleu_community.admin_discussion_removal_commands(actor_id,request_id)
);
CREATE TABLE whaleu_community.admin_discussion_removal_events (
 id uuid PRIMARY KEY,actor_id uuid NOT NULL,request_id uuid NOT NULL,
 subject_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),target_kind text NOT NULL CHECK(target_kind IN('comment','reply')),target_id uuid NOT NULL,
 post_id uuid NOT NULL REFERENCES whaleu_community.posts(id),root_id uuid NOT NULL,
 original_region_id uuid NOT NULL,grant_id uuid NOT NULL REFERENCES whaleu_authorization.role_grants(id),
 selected_authority jsonb NOT NULL,recorded_at timestamptz NOT NULL CHECK(isfinite(recorded_at) AND recorded_at=date_trunc('milliseconds',recorded_at)),
 mutation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),UNIQUE(actor_id,request_id),UNIQUE(target_kind,target_id),
 FOREIGN KEY(actor_id,request_id) REFERENCES whaleu_community.admin_discussion_removal_commands(actor_id,request_id)
);
CREATE TABLE whaleu_community.admin_discussion_removal_components (
 actor_id uuid NOT NULL,request_id uuid NOT NULL,source_id uuid NOT NULL UNIQUE REFERENCES whaleu_post_hotness.comment_sources(id),
 source_fingerprint text NOT NULL,mutation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),PRIMARY KEY(actor_id,request_id),
 FOREIGN KEY(actor_id,request_id) REFERENCES whaleu_community.admin_discussion_removal_transitions(actor_id,request_id)
);
CREATE FUNCTION whaleu_community.admin_discussion_removal_immutable() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 RAISE EXCEPTION 'Administrative discussion-removal evidence is immutable' USING ERRCODE='23514',CONSTRAINT='admin_discussion_removal_causal';
END$$;
DO $$DECLARE name text;BEGIN
 FOREACH name IN ARRAY ARRAY['commands','statements','epochs','transitions','events','components'] LOOP
  EXECUTE format('CREATE TRIGGER admin_discussion_removal_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON whaleu_community.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.admin_discussion_removal_immutable()','admin_discussion_removal_'||name);
 END LOOP;
END$$;

CREATE FUNCTION whaleu_community.admin_discussion_removal_command_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_row record;p record;identity_observed jsonb;input_observed jsonb;BEGIN
 identity_observed:=whaleu_profile.moderation_identity_facts(NEW.actor_id,NEW.session_id,NEW.token_hash);
 IF current_setting('transaction_isolation')<>'read committed' OR NEW.mutation_transaction<>pg_current_xact_id()
 OR whaleu_community.post_owner_visibility_keys(NEW.command,ARRAY['clientRequestId','target','expectedTargetVersion','action']) IS DISTINCT FROM true
 OR whaleu_community.post_owner_visibility_keys(NEW.command->'target',ARRAY['kind','id']) IS DISTINCT FROM true
 OR NOT whaleu_profile.moderation_uuid_valid(NEW.target_id::text)
 OR NEW.command->>'clientRequestId' IS DISTINCT FROM NEW.request_id::text
 OR NEW.command->'target'->>'kind' IS DISTINCT FROM NEW.target_kind OR NEW.command->'target'->>'id' IS DISTINCT FROM NEW.target_id::text
 OR NEW.command->>'action' IS DISTINCT FROM 'remove_discussion'
 OR (jsonb_typeof(NEW.command->'expectedTargetVersion')='string' AND NEW.command->>'expectedTargetVersion' ~ '^[a-f0-9]{64}$') IS DISTINCT FROM true
 OR NEW.receipt->>'requestId' IS DISTINCT FROM NEW.request_id::text OR NEW.receipt->'target' IS DISTINCT FROM NEW.command->'target'
 OR NEW.receipt->>'action' IS DISTINCT FROM 'remove_discussion' OR NEW.receipt->'expectedTargetVersion' IS DISTINCT FROM NEW.command->'expectedTargetVersion'
 OR whaleu_community.post_owner_visibility_keys(NEW.receipt,(CASE WHEN NEW.receipt->>'outcome'='rejected' THEN ARRAY['requestId','target','expectedTargetVersion','action','outcome','code'] ELSE ARRAY['requestId','target','expectedTargetVersion','action','outcome','eventId','recordedAt'] END)) IS DISTINCT FROM true
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
 IF NOT whaleu_profile.moderation_grant_allowed(NEW.actor_id,NEW.grant_id,target_row.region_id)
 OR NOT whaleu_community.admin_discussion_removal_supported(NEW.actor_id,NEW.target_kind,NEW.target_id,false)
 OR NOT whaleu_profile.moderation_actor_current(NEW.actor_id,clock_timestamp())
 THEN RAISE EXCEPTION 'Current scoped administrative authority required' USING ERRCODE='23514',CONSTRAINT='admin_discussion_removal_causal';END IF;
 SELECT payload INTO p FROM whaleu_community.profile_moderation_nodes(NEW.target_kind,NEW.target_id) WHERE kind=NEW.target_kind AND id=NEW.target_id;
 NEW.subject_id:=target_row.subject_id;NEW.post_id:=target_row.post_id;NEW.root_id:=target_row.root_id;NEW.original_region_id:=target_row.region_id;
 NEW.before_target_version:=whaleu_community.admin_discussion_removal_target_version(NEW.target_kind,NEW.target_id);
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
 RETURN NEW;
END$$;
CREATE TRIGGER admin_discussion_removal_command_guard BEFORE INSERT ON whaleu_community.admin_discussion_removal_commands FOR EACH ROW EXECUTE FUNCTION whaleu_community.admin_discussion_removal_command_guard();

CREATE FUNCTION whaleu_community.admin_discussion_removal_nested_evidence() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF pg_trigger_depth()<2 OR NEW.mutation_transaction<>pg_current_xact_id() THEN
  RAISE EXCEPTION 'Only an actual administrative source transition can issue evidence' USING ERRCODE='23514',CONSTRAINT='admin_discussion_removal_causal';END IF;
 RETURN NEW;
END$$;
DO $$DECLARE name text;BEGIN FOREACH name IN ARRAY ARRAY['statements','epochs','transitions','components'] LOOP
 EXECUTE format('CREATE TRIGGER admin_discussion_removal_nested_evidence BEFORE INSERT ON whaleu_community.%I FOR EACH ROW EXECUTE FUNCTION whaleu_community.admin_discussion_removal_nested_evidence()','admin_discussion_removal_'||name);
END LOOP;END$$;
-- Statement admission precedes every installed owner epoch. The one nested
-- 0031 INSERT is permitted only after the selected real transition exists.
CREATE FUNCTION whaleu_community.admin_discussion_removal_source_statement_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q record;BEGIN
 FOR q IN SELECT * FROM whaleu_community.admin_discussion_removal_commands WHERE mutation_transaction=pg_current_xact_id() LOOP
  IF q.receipt->>'outcome' IS DISTINCT FROM 'applied' THEN
   RAISE EXCEPTION 'Rejected discussion removal is read-only' USING ERRCODE='23514',CONSTRAINT='admin_discussion_removal_causal';
  ELSIF TG_TABLE_SCHEMA='whaleu_community' AND TG_TABLE_NAME=(CASE q.target_kind WHEN 'comment' THEN 'root_comments' ELSE 'replies' END) AND TG_OP='UPDATE' THEN
   INSERT INTO whaleu_community.admin_discussion_removal_statements(actor_id,request_id) VALUES(q.actor_id,q.request_id);
  ELSIF TG_TABLE_SCHEMA='whaleu_post_hotness' AND TG_TABLE_NAME='comment_sources' AND TG_OP='INSERT' AND pg_trigger_depth()=2
   AND EXISTS(SELECT 1 FROM whaleu_community.admin_discussion_removal_transitions t WHERE (t.actor_id,t.request_id)=(q.actor_id,q.request_id))
   AND NOT EXISTS(SELECT 1 FROM whaleu_community.admin_discussion_removal_components c WHERE (c.actor_id,c.request_id)=(q.actor_id,q.request_id)) THEN
   NULL;
  ELSE RAISE EXCEPTION 'Only one selected child statement and canonical component capture allowed' USING ERRCODE='23514',CONSTRAINT='admin_discussion_removal_causal';END IF;
 END LOOP;RETURN NULL;
END$$;
CREATE FUNCTION whaleu_community.admin_discussion_removal_capture_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q record;BEGIN
 FOR q IN SELECT * FROM whaleu_community.admin_discussion_removal_commands WHERE mutation_transaction=pg_current_xact_id() LOOP
  IF q.receipt->>'outcome' IS DISTINCT FROM 'applied' OR pg_trigger_depth()<2
  OR NEW.slot<>OLD.slot OR NEW.version<>OLD.version OR NEW.epoch<>OLD.epoch+1
  OR NOT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid() AND granted AND mode='ExclusiveLock' AND classid=1464356101::oid AND objsubid=2 AND objid=NEW.slot::oid)
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(q.input_before->'community') v WHERE (v->>0)::integer=OLD.slot AND (v->>1)::integer=OLD.version AND (v->>2)::bigint=OLD.epoch)
  THEN RAISE EXCEPTION 'Only the original exact owned Community epoch may advance' USING ERRCODE='23514',CONSTRAINT='admin_discussion_removal_causal';END IF;
  INSERT INTO whaleu_community.admin_discussion_removal_epochs(actor_id,request_id,slot,version,before_epoch,after_epoch)
   VALUES(q.actor_id,q.request_id,NEW.slot,NEW.version,OLD.epoch,NEW.epoch);
 END LOOP;
 RETURN NULL;
END$$;
CREATE TRIGGER admin_discussion_removal_capture_epoch AFTER UPDATE ON whaleu_community.discovery_count_epochs FOR EACH ROW EXECUTE FUNCTION whaleu_community.admin_discussion_removal_capture_epoch();
CREATE FUNCTION whaleu_community.admin_discussion_removal_child_row_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q record;kind text:=(CASE TG_TABLE_NAME WHEN 'root_comments' THEN 'comment' ELSE 'reply' END);BEGIN
 -- Administrative removal has no undelete operation. Retain only its canonical
 -- tombstone/provenance; this does not freeze other existing owner behavior.
 IF TG_OP='DELETE' AND EXISTS(SELECT 1 FROM whaleu_community.admin_discussion_removal_transitions t WHERE t.target_kind=kind AND t.target_id=OLD.id) THEN
  RAISE EXCEPTION 'Administrative discussion tombstones are retained' USING ERRCODE='23514',CONSTRAINT='admin_discussion_removal_causal';END IF;
 IF TG_OP='UPDATE' AND EXISTS(SELECT 1 FROM whaleu_community.admin_discussion_removal_transitions t WHERE t.target_kind=kind AND t.target_id=OLD.id
  AND (NEW.deleted_at IS DISTINCT FROM t.deleted_at OR NEW.local_deletion_transaction IS DISTINCT FROM t.mutation_transaction)) THEN
  RAISE EXCEPTION 'An administratively removed discussion cannot be resurrected' USING ERRCODE='23514',CONSTRAINT='admin_discussion_removal_causal';END IF;
 FOR q IN SELECT * FROM whaleu_community.admin_discussion_removal_commands WHERE mutation_transaction=pg_current_xact_id() LOOP
  IF TG_OP<>'UPDATE' OR q.receipt->>'outcome' IS DISTINCT FROM 'applied' OR kind<>q.target_kind OR OLD.id<>q.target_id OR OLD.deleted_at IS NOT NULL OR NEW.deleted_at IS NULL
  OR OLD.local_deletion_transaction IS NOT NULL OR NEW.local_deletion_transaction IS DISTINCT FROM OLD.local_deletion_transaction
  OR NEW.deleted_at IS DISTINCT FROM (q.receipt->>'recordedAt')::timestamptz OR NEW.deleted_at>clock_timestamp()
  OR whaleu_profile.moderation_hash(jsonb_build_array(to_jsonb(OLD),OLD.xmin::text,OLD.ctid::text)) IS DISTINCT FROM q.before_fingerprint
  OR whaleu_profile.moderation_hash(to_jsonb(OLD)) IS DISTINCT FROM q.before_hash
  OR whaleu_profile.moderation_hash(to_jsonb(NEW)-ARRAY['deleted_at','local_deletion_transaction']) IS DISTINCT FROM q.unchanged_hash
  OR EXISTS(SELECT 1 FROM whaleu_community.admin_discussion_removal_transitions t WHERE (t.actor_id,t.request_id)=(q.actor_id,q.request_id))
  THEN RAISE EXCEPTION 'Only the exact original live child may become a tombstone' USING ERRCODE='23514',CONSTRAINT='admin_discussion_removal_causal';END IF;
 END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END$$;
CREATE TRIGGER a00_admin_discussion_removal_row BEFORE INSERT OR UPDATE OR DELETE ON whaleu_community.root_comments FOR EACH ROW EXECUTE FUNCTION whaleu_community.admin_discussion_removal_child_row_guard();
CREATE TRIGGER a00_admin_discussion_removal_row BEFORE INSERT OR UPDATE OR DELETE ON whaleu_community.replies FOR EACH ROW EXECUTE FUNCTION whaleu_community.admin_discussion_removal_child_row_guard();
CREATE FUNCTION whaleu_community.admin_discussion_removal_capture_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q record;kind text:=(CASE TG_TABLE_NAME WHEN 'root_comments' THEN 'comment' ELSE 'reply' END);BEGIN
 FOR q IN SELECT * FROM whaleu_community.admin_discussion_removal_commands WHERE mutation_transaction=pg_current_xact_id() AND receipt->>'outcome'='applied' LOOP
  IF OLD.local_deletion_transaction IS NOT NULL OR NEW.local_deletion_transaction IS DISTINCT FROM pg_current_xact_id()
  OR whaleu_profile.moderation_hash(to_jsonb(NEW)-ARRAY['deleted_at','local_deletion_transaction']) IS DISTINCT FROM q.unchanged_hash
  THEN RAISE EXCEPTION 'Canonical local deletion provenance required' USING ERRCODE='23514',CONSTRAINT='admin_discussion_removal_causal';END IF;
  INSERT INTO whaleu_community.admin_discussion_removal_transitions(actor_id,request_id,target_kind,target_id,post_id,root_id,before_hash,before_fingerprint,after_hash,after_fingerprint,unchanged_hash,deleted_at)
   VALUES(q.actor_id,q.request_id,q.target_kind,NEW.id,q.post_id,q.root_id,q.before_hash,q.before_fingerprint,whaleu_profile.moderation_hash(to_jsonb(NEW)),
   whaleu_community.admin_discussion_removal_node_fingerprint(q.target_kind,NEW.id),q.unchanged_hash,NEW.deleted_at);
 END LOOP;RETURN NULL;
END$$;
CREATE TRIGGER admin_discussion_removal_capture_transition AFTER UPDATE ON whaleu_community.root_comments FOR EACH ROW EXECUTE FUNCTION whaleu_community.admin_discussion_removal_capture_transition();
CREATE TRIGGER admin_discussion_removal_capture_transition AFTER UPDATE ON whaleu_community.replies FOR EACH ROW EXECUTE FUNCTION whaleu_community.admin_discussion_removal_capture_transition();

-- An input captured with selected=NULL and a later selected-grant input are
-- checked independently. Neither can be overwritten by the command's snapshot.
CREATE FUNCTION whaleu_community.admin_discussion_removal_inputs_match(actor uuid,selected uuid,target_kind text,target uuid,expected_facts jsonb,request uuid DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE facts jsonb;q record;t record;epoch_receipt record;expected_epochs jsonb;BEGIN
 facts:=whaleu_community.admin_discussion_removal_input_facts(actor,selected,target_kind,target);
 IF facts IS NOT DISTINCT FROM expected_facts THEN RETURN true;END IF;
 IF request IS NULL THEN RETURN false;END IF;
 SELECT * INTO q FROM whaleu_community.admin_discussion_removal_commands c WHERE c.actor_id=actor AND c.target_kind=$3 AND c.target_id=target
  AND c.mutation_transaction=pg_current_xact_id() AND c.receipt->>'outcome'='applied' AND c.request_id=request;
 IF NOT FOUND OR q.input_before->'target' IS DISTINCT FROM expected_facts->'target'
 OR q.input_before->'community' IS DISTINCT FROM expected_facts->'community'
 OR facts->'unchanged' IS DISTINCT FROM expected_facts->'unchanged' THEN RETURN false;END IF;
 SELECT * INTO t FROM whaleu_community.admin_discussion_removal_transitions WHERE actor_id=q.actor_id AND request_id=q.request_id;
 SELECT * INTO epoch_receipt FROM whaleu_community.admin_discussion_removal_epochs WHERE actor_id=q.actor_id AND request_id=q.request_id;
 IF t.request_id IS NULL OR epoch_receipt.request_id IS NULL OR t.mutation_transaction<>pg_current_xact_id() OR epoch_receipt.mutation_transaction<>pg_current_xact_id()
 OR t.before_fingerprint IS DISTINCT FROM q.before_fingerprint OR t.before_fingerprint IS DISTINCT FROM expected_facts->>'target'
 OR t.after_fingerprint IS DISTINCT FROM facts->>'target' OR t.unchanged_hash IS DISTINCT FROM q.unchanged_hash
 OR t.deleted_at IS DISTINCT FROM (q.receipt->>'recordedAt')::timestamptz
 OR NOT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid() AND granted AND mode='ExclusiveLock' AND classid=1464356101::oid AND objsubid=2 AND objid=epoch_receipt.slot::oid)
 THEN RETURN false;END IF;
 SELECT jsonb_agg((CASE WHEN (v->>0)::integer=epoch_receipt.slot THEN jsonb_build_array(epoch_receipt.slot,epoch_receipt.version,epoch_receipt.after_epoch::text) ELSE v END) ORDER BY (v->>0)::integer)
 INTO expected_epochs FROM jsonb_array_elements(expected_facts->'community') v;
 RETURN facts->'community' IS NOT DISTINCT FROM expected_epochs;
END$$;
CREATE FUNCTION whaleu_community.admin_discussion_removal_inputs_current(actor uuid,selected uuid,target_kind text,target uuid,expected_facts jsonb,request uuid DEFAULT NULL)
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT whaleu_community.admin_discussion_removal_inputs_match(actor,selected,target_kind,target,expected_facts,request)
$$;

CREATE FUNCTION whaleu_community.admin_discussion_removal_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q record;t record;authority jsonb;BEGIN
 SELECT * INTO q FROM whaleu_community.admin_discussion_removal_commands WHERE actor_id=NEW.actor_id AND request_id=NEW.request_id;
 SELECT * INTO t FROM whaleu_community.admin_discussion_removal_transitions WHERE actor_id=NEW.actor_id AND request_id=NEW.request_id;
 SELECT jsonb_build_object('id',g.id,'accountId',g.account_id,'role',g.role,'operatingRegionId',g.operating_region_id,'validFrom',g.valid_from,'expiresAt',g.expires_at)
 INTO authority FROM whaleu_authorization.role_grants g WHERE g.id=q.grant_id;
 IF NEW.selected_authority IS NULL THEN NEW.selected_authority:=authority;END IF;
 IF q.request_id IS NULL OR t.request_id IS NULL OR q.mutation_transaction<>pg_current_xact_id() OR t.mutation_transaction<>pg_current_xact_id() OR NEW.mutation_transaction<>pg_current_xact_id()
 OR q.receipt->>'outcome' IS DISTINCT FROM 'applied' OR q.receipt->>'eventId' IS DISTINCT FROM NEW.id::text
 OR (NEW.subject_id,NEW.target_kind,NEW.target_id,NEW.post_id,NEW.root_id,NEW.original_region_id,NEW.grant_id) IS DISTINCT FROM (q.subject_id,q.target_kind,q.target_id,q.post_id,q.root_id,q.original_region_id,q.grant_id)
 OR (t.target_kind,t.target_id,t.post_id,t.root_id) IS DISTINCT FROM (q.target_kind,q.target_id,q.post_id,q.root_id) OR t.before_fingerprint IS DISTINCT FROM q.before_fingerprint
 OR t.after_fingerprint IS DISTINCT FROM whaleu_community.admin_discussion_removal_node_fingerprint(q.target_kind,q.target_id)
 OR NEW.recorded_at IS DISTINCT FROM t.deleted_at OR NEW.recorded_at IS DISTINCT FROM (q.receipt->>'recordedAt')::timestamptz
 OR NEW.recorded_at>clock_timestamp() OR NEW.selected_authority IS DISTINCT FROM authority
 THEN RAISE EXCEPTION 'Exact administrative discussion-removal event cause required' USING ERRCODE='23514',CONSTRAINT='admin_discussion_removal_causal';END IF;
 RETURN NEW;
END$$;
CREATE TRIGGER admin_discussion_removal_event_guard BEFORE INSERT ON whaleu_community.admin_discussion_removal_events FOR EACH ROW EXECUTE FUNCTION whaleu_community.admin_discussion_removal_event_guard();

CREATE FUNCTION whaleu_community.admin_discussion_removal_outbox_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e record;q record;BEGIN
 IF TG_OP='TRUNCATE' THEN
  IF EXISTS(SELECT 1 FROM whaleu_community.outbox WHERE event_type='admin_discussion_removed') THEN
   RAISE EXCEPTION 'Administrative outbox evidence retained' USING ERRCODE='23514',CONSTRAINT='admin_discussion_removal_causal';END IF;RETURN NULL;
 END IF;
 IF TG_OP<>'INSERT' AND (OLD.event_type='admin_discussion_removed' OR OLD.event_key LIKE 'admin-discussion-removal:%') THEN
  RAISE EXCEPTION 'Administrative outbox evidence is immutable' USING ERRCODE='23514',CONSTRAINT='admin_discussion_removal_causal';END IF;
 IF TG_OP<>'DELETE' AND (NEW.event_type='admin_discussion_removed' OR NEW.event_key LIKE 'admin-discussion-removal:%') THEN
  SELECT * INTO e FROM whaleu_community.admin_discussion_removal_events WHERE id::text=NEW.context->>'eventId';
  IF TG_OP<>'INSERT' OR e.id IS NULL OR e.mutation_transaction<>pg_current_xact_id()
  OR NEW.local_creation_transaction IS DISTINCT FROM pg_current_xact_id()
  OR NEW.event_type IS DISTINCT FROM 'admin_discussion_removed' OR NEW.event_key IS DISTINCT FROM 'admin-discussion-removal:'||e.id::text
  OR NEW.resource_id IS DISTINCT FROM e.target_id
  OR NEW.context IS DISTINCT FROM jsonb_build_object('cause','admin_discussion_removal','eventId',e.id,'kind',e.target_kind,'postId',e.post_id,'rootCommentId',e.root_id,'obligations',jsonb_build_array('content_invalidation','media_cleanup'))
  OR NEW.created_at<e.recorded_at OR NEW.created_at>clock_timestamp()
  THEN RAISE EXCEPTION 'Exact independent administrative invalidation event required' USING ERRCODE='23514',CONSTRAINT='admin_discussion_removal_causal';END IF;
 END IF;
 FOR q IN SELECT * FROM whaleu_community.admin_discussion_removal_commands WHERE mutation_transaction=pg_current_xact_id() LOOP
  IF TG_OP<>'INSERT' OR NEW.event_type IS DISTINCT FROM 'admin_discussion_removed' OR q.receipt->>'eventId' IS DISTINCT FROM NEW.context->>'eventId' THEN
   RAISE EXCEPTION 'Administrative removal cannot produce owner Experience or unrelated events' USING ERRCODE='23514',CONSTRAINT='admin_discussion_removal_causal';END IF;
 END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END$$;
CREATE TRIGGER admin_discussion_removal_outbox_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_community.outbox FOR EACH ROW EXECUTE FUNCTION whaleu_community.admin_discussion_removal_outbox_guard();
CREATE TRIGGER admin_discussion_removal_outbox_retain BEFORE TRUNCATE ON whaleu_community.outbox FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.admin_discussion_removal_outbox_guard();

-- These ledgers distinguish canonical capture from a pre-existing/spoofed job,
-- standalone component source, or a DELETE that did not remove the original pin.
CREATE TABLE whaleu_community.admin_discussion_removal_cleanup (
 actor_id uuid NOT NULL,request_id uuid NOT NULL,job_id uuid NOT NULL UNIQUE REFERENCES whaleu_community.media_cleanup_jobs(id),
 job_fingerprint text NOT NULL,mutation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),PRIMARY KEY(actor_id,request_id),
 FOREIGN KEY(actor_id,request_id) REFERENCES whaleu_community.admin_discussion_removal_transitions(actor_id,request_id)
);
CREATE TABLE whaleu_community.admin_discussion_removal_pins (
 actor_id uuid NOT NULL,request_id uuid NOT NULL,pin_before jsonb NOT NULL,
 mutation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),PRIMARY KEY(actor_id,request_id),
 FOREIGN KEY(actor_id,request_id) REFERENCES whaleu_community.admin_discussion_removal_commands(actor_id,request_id)
);
DO $$DECLARE name text;BEGIN FOREACH name IN ARRAY ARRAY['cleanup','pins'] LOOP
 EXECUTE format('CREATE TRIGGER admin_discussion_removal_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON whaleu_community.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.admin_discussion_removal_immutable()','admin_discussion_removal_'||name);
 EXECUTE format('CREATE TRIGGER admin_discussion_removal_nested_evidence BEFORE INSERT ON whaleu_community.%I FOR EACH ROW EXECUTE FUNCTION whaleu_community.admin_discussion_removal_nested_evidence()','admin_discussion_removal_'||name);
END LOOP;END$$;
CREATE FUNCTION whaleu_community.admin_discussion_removal_side_statement_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q record;BEGIN
 FOR q IN SELECT * FROM whaleu_community.admin_discussion_removal_commands WHERE mutation_transaction=pg_current_xact_id() LOOP
  IF q.receipt->>'outcome' IS DISTINCT FROM 'applied'
  OR NOT ((TG_TABLE_NAME='comment_pins' AND TG_OP='DELETE' AND q.target_kind='comment'
    AND NOT EXISTS(SELECT 1 FROM whaleu_community.admin_discussion_removal_statements statement WHERE (statement.actor_id,statement.request_id)=(q.actor_id,q.request_id)))
   OR (TG_TABLE_NAME='media_cleanup_jobs' AND TG_OP='INSERT' AND pg_trigger_depth()=2
    AND EXISTS(SELECT 1 FROM whaleu_community.admin_discussion_removal_transitions t WHERE (t.actor_id,t.request_id)=(q.actor_id,q.request_id)))) THEN
   RAISE EXCEPTION 'Only exact root pin deletion and canonical cleanup insertion allowed' USING ERRCODE='23514',CONSTRAINT='admin_discussion_removal_causal';END IF;
 END LOOP;RETURN NULL;
END$$;
CREATE FUNCTION whaleu_community.admin_discussion_removal_side_effect_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q record;valid boolean;BEGIN
 FOR q IN SELECT * FROM whaleu_community.admin_discussion_removal_commands WHERE mutation_transaction=pg_current_xact_id() LOOP
  valid:=false;
  IF q.receipt->>'outcome'='applied' THEN
   IF TG_TABLE_NAME='comment_pins' AND TG_OP='DELETE' THEN
    valid:=q.target_kind='comment' AND OLD.post_id=q.post_id AND OLD.comment_id=q.target_id
     AND q.pin_before IS NOT DISTINCT FROM jsonb_build_array(to_jsonb(OLD),OLD.xmin::text,OLD.ctid::text);
   ELSIF TG_TABLE_NAME='media_cleanup_jobs' AND TG_OP='INSERT' THEN
    valid:=pg_trigger_depth()=2 AND NEW.resource_kind=q.target_kind AND NEW.resource_id=q.target_id AND NEW.post_id=q.post_id
     AND NEW.root_comment_id=q.root_id AND NEW.source_deleted_at=(q.receipt->>'recordedAt')::timestamptz
     AND NEW.phase='self' AND NEW.cursor_id IS NULL AND NEW.detached_targets=0 AND NEW.enumeration_completed_at IS NULL
     AND NEW.created_at>=NEW.source_deleted_at AND NEW.created_at<=clock_timestamp()
     AND EXISTS(SELECT 1 FROM whaleu_community.admin_discussion_removal_transitions t WHERE (t.actor_id,t.request_id)=(q.actor_id,q.request_id));
   END IF;
  END IF;
  IF valid IS DISTINCT FROM true THEN RAISE EXCEPTION 'Only exact canonical discussion side effects allowed' USING ERRCODE='23514',CONSTRAINT='admin_discussion_removal_causal';END IF;
 END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END$$;
CREATE FUNCTION whaleu_community.admin_discussion_removal_capture_side_effect() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q record;BEGIN
 FOR q IN SELECT * FROM whaleu_community.admin_discussion_removal_commands WHERE mutation_transaction=pg_current_xact_id() LOOP
  IF TG_TABLE_NAME='comment_pins' THEN
   INSERT INTO whaleu_community.admin_discussion_removal_pins(actor_id,request_id,pin_before)
   VALUES(q.actor_id,q.request_id,jsonb_build_array(to_jsonb(OLD),OLD.xmin::text,OLD.ctid::text));
  ELSE
   IF pg_trigger_depth()<>2 THEN RAISE EXCEPTION 'Cleanup capture must be canonical and nested' USING ERRCODE='23514',CONSTRAINT='admin_discussion_removal_causal';END IF;
   INSERT INTO whaleu_community.admin_discussion_removal_cleanup(actor_id,request_id,job_id,job_fingerprint)
    SELECT q.actor_id,q.request_id,j.id,whaleu_profile.moderation_hash(jsonb_build_array(to_jsonb(j),j.xmin::text,j.ctid::text))
    FROM whaleu_community.media_cleanup_jobs j WHERE j.id=NEW.id;
  END IF;
 END LOOP;RETURN NULL;
END$$;
DO $$DECLARE name text;BEGIN
 FOREACH name IN ARRAY ARRAY['comment_pins','media_cleanup_jobs'] LOOP
  EXECUTE format('CREATE TRIGGER a00_admin_discussion_removal_side_statement BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_community.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.admin_discussion_removal_side_statement_guard()',name);
  EXECUTE format('CREATE TRIGGER a00_admin_discussion_removal_side_effect BEFORE INSERT OR UPDATE OR DELETE ON whaleu_community.%I FOR EACH ROW EXECUTE FUNCTION whaleu_community.admin_discussion_removal_side_effect_guard()',name);
 END LOOP;
END$$;
CREATE TRIGGER admin_discussion_removal_capture_pin AFTER DELETE ON whaleu_community.comment_pins FOR EACH ROW EXECUTE FUNCTION whaleu_community.admin_discussion_removal_capture_side_effect();
CREATE TRIGGER admin_discussion_removal_capture_cleanup AFTER INSERT ON whaleu_community.media_cleanup_jobs FOR EACH ROW EXECUTE FUNCTION whaleu_community.admin_discussion_removal_capture_side_effect();
CREATE FUNCTION whaleu_community.admin_discussion_removal_component_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q record;positive record;BEGIN
 FOR q IN SELECT * FROM whaleu_community.admin_discussion_removal_commands WHERE mutation_transaction=pg_current_xact_id() LOOP
  SELECT s.* INTO positive FROM whaleu_post_hotness.comment_sources s WHERE s.id=NEW.positive_source_id;
  IF q.receipt->>'outcome' IS DISTINCT FROM 'applied' OR pg_trigger_depth()<>2
  OR NEW.kind IS DISTINCT FROM (CASE q.target_kind WHEN 'comment' THEN 'root' ELSE 'reply' END)
  OR (NEW.post_id,NEW.actor_id,NEW.content_id,NEW.transition,NEW.delta)
   IS DISTINCT FROM (q.post_id,q.subject_id,q.target_id,'deleted'::text,(-1)::smallint)
  OR NEW.root_id IS DISTINCT FROM (CASE q.target_kind WHEN 'comment' THEN NULL::uuid ELSE q.root_id END)
  OR positive.id IS NULL OR (positive.post_id,positive.actor_id,positive.kind,positive.content_id,positive.root_id,positive.transition)
   IS DISTINCT FROM (NEW.post_id,NEW.actor_id,NEW.kind,NEW.content_id,NEW.root_id,'created'::text)
  OR q.input_before->'unchanged' IS NULL
  OR NOT EXISTS(SELECT 1 FROM whaleu_community.admin_discussion_removal_transitions t WHERE (t.actor_id,t.request_id)=(q.actor_id,q.request_id) AND t.mutation_transaction=pg_current_xact_id())
  THEN RAISE EXCEPTION 'One exact author-owned negative component source required' USING ERRCODE='23514',CONSTRAINT='admin_discussion_removal_causal';END IF;
 END LOOP;RETURN NEW;
END$$;
CREATE TRIGGER a00_admin_discussion_removal_component BEFORE INSERT ON whaleu_post_hotness.comment_sources FOR EACH ROW EXECUTE FUNCTION whaleu_community.admin_discussion_removal_component_guard();
CREATE FUNCTION whaleu_community.admin_discussion_removal_capture_component() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q record;BEGIN
 FOR q IN SELECT * FROM whaleu_community.admin_discussion_removal_commands WHERE mutation_transaction=pg_current_xact_id() LOOP
  IF pg_trigger_depth()<>2 OR NEW.source_transaction IS DISTINCT FROM pg_current_xact_id() THEN
   RAISE EXCEPTION 'Actual nested component capture required' USING ERRCODE='23514',CONSTRAINT='admin_discussion_removal_causal';END IF;
  INSERT INTO whaleu_community.admin_discussion_removal_components(actor_id,request_id,source_id,source_fingerprint)
   SELECT q.actor_id,q.request_id,s.id,whaleu_profile.moderation_hash(jsonb_build_array(to_jsonb(s),s.xmin::text,s.ctid::text))
   FROM whaleu_post_hotness.comment_sources s WHERE s.id=NEW.id;
 END LOOP;RETURN NULL;
END$$;
CREATE TRIGGER admin_discussion_removal_capture_component AFTER INSERT ON whaleu_post_hotness.comment_sources FOR EACH ROW EXECUTE FUNCTION whaleu_community.admin_discussion_removal_capture_component();
-- Catalog dependencies are indexed candidate sets, not evidence. Actual tgfoid,
-- operation, enabled mode and absence of WHEN/arguments are always checked.
CREATE FUNCTION whaleu_community.admin_discussion_removal_inventory_current() RETURNS boolean LANGUAGE sql STABLE AS $$
 WITH source_dependencies AS MATERIALIZED (
  SELECT classid,objid FROM pg_catalog.pg_depend
  WHERE refclassid='pg_catalog.pg_proc'::regclass AND refobjid IN(
   'whaleu_community.advance_discovery_count_epoch()'::regprocedure,
   'whaleu_safety.advance_discovery_count_epoch()'::regprocedure,
   'whaleu_campus.advance_discovery_count_epoch()'::regprocedure,
   'whaleu_media.advance_owner_epoch()'::regprocedure)
 ), guard_dependencies AS MATERIALIZED (
  SELECT classid,objid FROM pg_catalog.pg_depend
  WHERE refclassid='pg_catalog.pg_proc'::regclass
   AND refobjid='whaleu_community.admin_discussion_removal_source_statement_guard()'::regprocedure
 ), required(relation,func,trigger_type,attribute) AS (
  SELECT r::regclass,f::regprocedure,k,a FROM (VALUES
   ('whaleu_community.root_comments','whaleu_community.advance_discovery_count_epoch()',62,NULL),
   ('whaleu_community.replies','whaleu_community.advance_discovery_count_epoch()',62,NULL),
   ('whaleu_community.root_comments','whaleu_community.reward_content_provenance()',23,NULL),
   ('whaleu_community.replies','whaleu_community.reward_content_provenance()',23,NULL),
   ('whaleu_community.root_comments','whaleu_post_hotness.capture_comment()',21,NULL),
   ('whaleu_community.replies','whaleu_post_hotness.capture_comment()',21,NULL),
   ('whaleu_community.root_comments','whaleu_community.capture_media_cleanup()',17,'deleted_at'),
   ('whaleu_community.replies','whaleu_community.capture_media_cleanup()',17,'deleted_at'),
   ('whaleu_community.root_comments','whaleu_community.admin_discussion_removal_child_row_guard()',31,NULL),
   ('whaleu_community.replies','whaleu_community.admin_discussion_removal_child_row_guard()',31,NULL),
   ('whaleu_community.root_comments','whaleu_community.admin_discussion_removal_capture_transition()',17,NULL),
   ('whaleu_community.replies','whaleu_community.admin_discussion_removal_capture_transition()',17,NULL),
   ('whaleu_community.discovery_count_epochs','whaleu_community.admin_discussion_removal_capture_epoch()',17,NULL),
   ('whaleu_post_hotness.comment_sources','whaleu_post_hotness.comment_source_guard()',7,NULL),
   ('whaleu_post_hotness.comment_sources','whaleu_community.admin_discussion_removal_source_statement_guard()',62,NULL),
   ('whaleu_post_hotness.comment_sources','whaleu_community.admin_discussion_removal_component_guard()',7,NULL),
   ('whaleu_post_hotness.comment_sources','whaleu_community.admin_discussion_removal_capture_component()',5,NULL),
   ('whaleu_community.media_cleanup_jobs','whaleu_community.admin_discussion_removal_side_statement_guard()',62,NULL),
   ('whaleu_community.media_cleanup_jobs','whaleu_community.admin_discussion_removal_side_effect_guard()',31,NULL),
   ('whaleu_community.media_cleanup_jobs','whaleu_community.admin_discussion_removal_capture_side_effect()',5,NULL),
   ('whaleu_community.comment_pins','whaleu_community.admin_discussion_removal_side_statement_guard()',62,NULL),
   ('whaleu_community.comment_pins','whaleu_community.admin_discussion_removal_side_effect_guard()',31,NULL),
   ('whaleu_community.comment_pins','whaleu_community.admin_discussion_removal_capture_side_effect()',9,NULL)
  ) v(r,f,k,a)
 )
 SELECT NOT EXISTS(SELECT 1 FROM source_dependencies dependency
  JOIN pg_catalog.pg_trigger source ON source.oid=dependency.objid
  WHERE dependency.classid='pg_catalog.pg_trigger'::regclass
  AND source.tgfoid IN('whaleu_community.advance_discovery_count_epoch()'::regprocedure,
   'whaleu_safety.advance_discovery_count_epoch()'::regprocedure,'whaleu_campus.advance_discovery_count_epoch()'::regprocedure,
   'whaleu_media.advance_owner_epoch()'::regprocedure)
  AND NOT source.tgisinternal AND source.tgenabled<>'D'
  AND (source.tgtype<>62 OR source.tgqual IS NOT NULL OR source.tgnargs<>0 OR NOT EXISTS(
   SELECT 1 FROM guard_dependencies guard_dependency JOIN pg_catalog.pg_trigger guard ON guard.oid=guard_dependency.objid
   WHERE guard_dependency.classid='pg_catalog.pg_trigger'::regclass AND guard.tgrelid=source.tgrelid
   AND guard.tgfoid='whaleu_community.admin_discussion_removal_source_statement_guard()'::regprocedure
   AND guard.tgenabled='O' AND guard.tgtype=62 AND guard.tgqual IS NULL AND guard.tgnargs=0 AND NOT guard.tgisinternal)))
 AND NOT EXISTS(SELECT 1 FROM required r WHERE NOT EXISTS(
  SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid=r.relation AND t.tgfoid=r.func AND t.tgtype=r.trigger_type
  AND t.tgenabled='O' AND NOT t.tgisinternal AND t.tgqual IS NULL AND t.tgnargs=0
  AND t.tgattr::text=(CASE WHEN r.attribute IS NULL THEN '' ELSE
   (SELECT a.attnum::text FROM pg_catalog.pg_attribute a WHERE a.attrelid=r.relation AND a.attname=r.attribute AND NOT a.attisdropped) END)))
$$;
DO $$DECLARE relation record;BEGIN
 -- Discover the full currently installed epoch graph. Also prohibit incidental
 -- Profile, XP, notifications, grants, credentials and aggregate settlements.
 FOR relation IN SELECT DISTINCT n.nspname schema_name,c.relname relation_name
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN('r','p') AND (
   n.nspname IN('whaleu_profile','whaleu_experience','whaleu_verification','whaleu_authorization','whaleu_notifications','whaleu_post_hotness')
   OR (n.nspname='whaleu_identity' AND c.relname IN('accounts','sessions','access_tokens'))
   OR (n.nspname='whaleu_community' AND c.relname IN('post_pins','post_pin_heads','post_pin_reads','post_pin_scopes','post_pin_history','post_pin_closures','report_origins','publication_requests','post_category_read_epoch'))
   OR EXISTS(SELECT 1 FROM pg_trigger source WHERE source.tgrelid=c.oid AND NOT source.tgisinternal AND source.tgfoid IN(
    'whaleu_community.advance_discovery_count_epoch()'::regprocedure,'whaleu_safety.advance_discovery_count_epoch()'::regprocedure,
    'whaleu_campus.advance_discovery_count_epoch()'::regprocedure,'whaleu_media.advance_owner_epoch()'::regprocedure)))
  ORDER BY n.nspname,c.relname LOOP
  EXECUTE format('CREATE TRIGGER a00_admin_discussion_removal_source_statement BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON %I.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.admin_discussion_removal_source_statement_guard()',relation.schema_name,relation.relation_name);
 END LOOP;
 IF NOT whaleu_community.admin_discussion_removal_inventory_current() THEN RAISE EXCEPTION 'Incomplete discussion removal source inventory' USING ERRCODE='23514';END IF;
END$$;
CREATE FUNCTION whaleu_community.admin_discussion_removal_outbox_statement_guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF TG_OP<>'INSERT' AND EXISTS(SELECT 1 FROM whaleu_community.admin_discussion_removal_commands WHERE mutation_transaction=pg_current_xact_id()) THEN
  RAISE EXCEPTION 'Discussion removal can only append its exact invalidation' USING ERRCODE='23514',CONSTRAINT='admin_discussion_removal_causal';END IF;RETURN NULL;
END$$;
CREATE TRIGGER a00_admin_discussion_removal_outbox_statement BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_community.outbox FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.admin_discussion_removal_outbox_statement_guard();
CREATE FUNCTION whaleu_community.admin_discussion_removal_assert_complete(q whaleu_community.admin_discussion_removal_commands)
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
 IF NOT whaleu_community.admin_discussion_removal_inventory_current()
 OR NOT whaleu_profile.moderation_grant_allowed(q.actor_id,q.grant_id,q.original_region_id)
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
CREATE FUNCTION whaleu_community.admin_discussion_removal_complete() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 PERFORM whaleu_community.admin_discussion_removal_assert_complete(NEW);RETURN NULL;
END$$;
CREATE CONSTRAINT TRIGGER admin_discussion_removal_complete AFTER INSERT ON whaleu_community.admin_discussion_removal_commands DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community.admin_discussion_removal_complete();
CREATE FUNCTION whaleu_community.admin_discussion_removal_recheck_active() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q whaleu_community.admin_discussion_removal_commands;BEGIN
 FOR q IN SELECT * FROM whaleu_community.admin_discussion_removal_commands WHERE mutation_transaction=pg_current_xact_id() LOOP
  PERFORM whaleu_community.admin_discussion_removal_assert_complete(q);
 END LOOP;RETURN NULL;
END$$;
DO $$DECLARE relation text;BEGIN
 FOREACH relation IN ARRAY ARRAY['whaleu_identity.accounts','whaleu_identity.sessions','whaleu_identity.access_tokens',
 'whaleu_authorization.role_grants','whaleu_verification.account_heads','whaleu_verification.snapshots','whaleu_verification.assertions',
 'whaleu_community.discovery_count_epochs','whaleu_safety.discovery_count_epochs','whaleu_campus.discovery_count_epochs','whaleu_media.media_owner_states',
 'whaleu_community.root_comments','whaleu_community.replies','whaleu_community.comment_pins','whaleu_community.media_cleanup_jobs','whaleu_community.outbox',
 'whaleu_community.admin_discussion_removal_statements','whaleu_community.admin_discussion_removal_epochs','whaleu_community.admin_discussion_removal_transitions','whaleu_community.admin_discussion_removal_events',
 'whaleu_community.admin_discussion_removal_components','whaleu_community.admin_discussion_removal_cleanup','whaleu_community.admin_discussion_removal_pins',
 'whaleu_post_hotness.comment_sources'] LOOP
  EXECUTE format('CREATE CONSTRAINT TRIGGER admin_discussion_removal_recheck_active AFTER INSERT OR UPDATE OR DELETE ON %s DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community.admin_discussion_removal_recheck_active()',relation);
 END LOOP;
END$$;
