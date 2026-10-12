-- Ordinary original-region administrative post removal, independent of jury,
-- owner Experience and Profile moderation. No grants or source acceptance.
-- Legacy WhaleU@57cf169c Message.php softDelete permits empty reason, ban_user=0,
-- both author modes, and notifies only when the moderator is not the author.
CREATE FUNCTION whaleu_community.admin_post_removal_target(target uuid)
RETURNS TABLE(subject_id uuid,post_id uuid,root_id uuid,region_id uuid)
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT p.account_id,p.id,NULL::uuid,s.operating_region_id
 FROM whaleu_community.posts p JOIN whaleu_community.spaces s ON s.id=p.space_id
 JOIN whaleu_community.content_approval_bindings b ON b.content_kind='post' AND b.content_id=p.id
 WHERE p.id=target AND p.author_mode IN('named','anonymous')
 AND s.kind='regional' AND s.is_active AND s.operating_region_id IS NOT NULL
 AND b.scope->>'sync'='none' AND b.scope->>'originalSpaceId'=s.id::text
 AND b.scope->>'originalRegionId'=s.operating_region_id::text
 AND EXISTS(SELECT 1 FROM whaleu_campus.operating_regions r WHERE r.id=s.operating_region_id AND r.is_active)
$$;
CREATE FUNCTION whaleu_community.admin_post_removal_supported(actor uuid,target uuid,allow_removed boolean DEFAULT false) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
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

-- Separate post tuple from all other facts so the one permitted tombstone can
-- be proven without erasing or re-observing any original input. ctid catches
-- same-transaction same-value and ABA writes that xmin alone cannot detect.
CREATE FUNCTION whaleu_community.admin_post_removal_post_fingerprint(target uuid)
RETURNS text LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT whaleu_profile.moderation_hash(jsonb_build_array(to_jsonb(p),p.xmin::text,p.ctid::text))
 FROM whaleu_community.posts p WHERE p.id=target
$$;
CREATE FUNCTION whaleu_community.admin_post_removal_source_facts(target uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object(
 'approval',(SELECT jsonb_build_array(to_jsonb(b),b.xmin::text,b.ctid::text,
  to_jsonb(d),d.xmin::text,d.ctid::text,to_jsonb(h),h.xmin::text,h.ctid::text,
  to_jsonb(e),e.xmin::text,e.ctid::text,to_jsonb(pol),pol.xmin::text,pol.ctid::text)
  FROM whaleu_community.content_approval_bindings b
  LEFT JOIN whaleu_community.content_approval_decisions d ON d.id=b.decision_id
  LEFT JOIN whaleu_community.content_approval_heads h ON h.decision_id=d.id
  LEFT JOIN whaleu_community.content_approval_events e ON (e.id,e.decision_id)=(h.event_id,d.id)
  LEFT JOIN whaleu_community.content_approval_policies pol ON pol.id=d.policy_revision_id
  WHERE b.content_kind='post' AND b.content_id=target),
 'origin',(SELECT jsonb_build_array(to_jsonb(o),o.xmin::text,o.ctid::text,to_jsonb(q),q.xmin::text,q.ctid::text)
  FROM whaleu_community.report_origins o LEFT JOIN whaleu_community.publication_requests q
  ON (q.account_id,q.client_request_id)=(o.owner_account_id,o.source_request_id)
  WHERE o.kind='post' AND o.target_id=target),
 'scope',(SELECT jsonb_build_array(to_jsonb(s),s.xmin::text,s.ctid::text,to_jsonb(r),r.xmin::text,r.ctid::text)
  FROM whaleu_community.posts p JOIN whaleu_community.spaces s ON s.id=p.space_id
  LEFT JOIN whaleu_campus.operating_regions r ON r.id=s.operating_region_id WHERE p.id=target),
 'visibility',(SELECT jsonb_build_array(to_jsonb(v),v.xmin::text,v.ctid::text)
  FROM whaleu_community.post_owner_visibility v WHERE v.post_id=target),
 'category',(SELECT jsonb_build_array(to_jsonb(h),h.xmin::text,h.ctid::text,to_jsonb(e),e.xmin::text,e.ctid::text,
  to_jsonb(live)) FROM whaleu_community.post_category_heads h
  LEFT JOIN whaleu_community.post_category_events e ON e.id=h.event_id
  LEFT JOIN whaleu_community.post_category_live live ON live.post_id=h.post_id WHERE h.post_id=target),
 'media',whaleu_profile.avatar_moderation_media_facts('post',target))
$$;
CREATE FUNCTION whaleu_community.admin_post_removal_target_version(target uuid)
RETURNS text LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT encode(sha256(convert_to('whaleu:admin-post-removal-target:v1'||chr(10)||
 whaleu_community.content_canonical_json(jsonb_build_object(
 'post',whaleu_community.admin_post_removal_post_fingerprint(target),
 'source',whaleu_community.admin_post_removal_source_facts(target))),'UTF8')),'hex')
$$;
CREATE FUNCTION whaleu_community.admin_post_removal_input_facts(actor uuid,selected uuid,target uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object(
 'post',whaleu_community.admin_post_removal_post_fingerprint(target),
 'community',(SELECT jsonb_agg(jsonb_build_array(slot,version,epoch::text) ORDER BY slot) FROM whaleu_community.discovery_count_epochs),
 'unchanged',whaleu_profile.moderation_hash(jsonb_build_object(
 'grant',(SELECT jsonb_build_array(to_jsonb(g),g.xmin::text,g.ctid::text) FROM whaleu_authorization.role_grants g WHERE g.id=selected),
 'source',whaleu_community.admin_post_removal_source_facts(target),
 'phone',(SELECT jsonb_build_array(to_jsonb(h),h.xmin::text,h.ctid::text,to_jsonb(s),s.xmin::text,s.ctid::text,to_jsonb(a),a.xmin::text,a.ctid::text)
  FROM whaleu_verification.account_heads h JOIN whaleu_verification.snapshots s ON s.id=h.snapshot_id
  JOIN whaleu_verification.assertions a ON a.id=s.phone_assertion_id WHERE h.account_id=actor),
 'media',(SELECT jsonb_agg(jsonb_build_array(slot,version,epoch::text) ORDER BY slot) FROM whaleu_media.media_owner_states),
 'safety',(SELECT jsonb_agg(jsonb_build_array(slot,version,epoch::text) ORDER BY slot) FROM whaleu_safety.discovery_count_epochs),
 'campus',(SELECT jsonb_agg(jsonb_build_array(slot,version,epoch::text) ORDER BY slot) FROM whaleu_campus.discovery_count_epochs))))
$$;

CREATE TABLE whaleu_community.admin_post_removal_commands (
 actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),request_id uuid NOT NULL,
 session_id uuid NOT NULL REFERENCES whaleu_identity.sessions(id),token_hash text NOT NULL,
 target_id uuid NOT NULL,intent_hash text NOT NULL,command jsonb NOT NULL,receipt jsonb NOT NULL,
 -- No nullable source/grant FKs: cold-backend cancellation stays identity-only.
 grant_id uuid,subject_id uuid,original_region_id uuid,
 identity_hash text NOT NULL DEFAULT '',input_hash text,input_before jsonb,
 before_hash text,before_fingerprint text,unchanged_hash text,before_target_version text,
 mutation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),PRIMARY KEY(actor_id,request_id),
 CHECK(request_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
 CHECK(octet_length(command::text)<4096 AND octet_length(receipt::text)<4096),
 CHECK(intent_hash=encode(sha256(convert_to('whaleu:admin-post-removal-command:v1'||chr(10)||whaleu_community.content_canonical_json(jsonb_build_object('actor',actor_id::text,'command',command)),'UTF8')),'hex'))
);
CREATE INDEX admin_post_removal_commands_transaction ON whaleu_community.admin_post_removal_commands(mutation_transaction,target_id);
-- One mutation-aware allowance per transaction; separate pre-existing owner
-- proofs stay strict and cannot be erased by batching an unrelated command.
CREATE UNIQUE INDEX admin_post_removal_one_transaction ON whaleu_community.admin_post_removal_commands(mutation_transaction) WHERE receipt->>'outcome'='applied';
CREATE TABLE whaleu_community.admin_post_removal_statements (
 actor_id uuid NOT NULL,request_id uuid NOT NULL,mutation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 PRIMARY KEY(actor_id,request_id),FOREIGN KEY(actor_id,request_id) REFERENCES whaleu_community.admin_post_removal_commands(actor_id,request_id)
);
CREATE TABLE whaleu_community.admin_post_removal_epochs (
 actor_id uuid NOT NULL,request_id uuid NOT NULL,slot integer NOT NULL,version integer NOT NULL CHECK(version=1),
 before_epoch bigint NOT NULL,after_epoch bigint NOT NULL CHECK(after_epoch=before_epoch+1),
 mutation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),PRIMARY KEY(actor_id,request_id),
 FOREIGN KEY(actor_id,request_id) REFERENCES whaleu_community.admin_post_removal_statements(actor_id,request_id)
);
CREATE TABLE whaleu_community.admin_post_removal_transitions (
 actor_id uuid NOT NULL,request_id uuid NOT NULL,target_id uuid NOT NULL REFERENCES whaleu_community.posts(id),
 before_hash text NOT NULL,before_fingerprint text NOT NULL,after_hash text NOT NULL,after_fingerprint text NOT NULL,unchanged_hash text NOT NULL,
 deleted_at timestamptz NOT NULL,mutation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 PRIMARY KEY(actor_id,request_id),UNIQUE(target_id),
 FOREIGN KEY(actor_id,request_id) REFERENCES whaleu_community.admin_post_removal_commands(actor_id,request_id)
);
CREATE TABLE whaleu_community.admin_post_removal_events (
 id uuid PRIMARY KEY,actor_id uuid NOT NULL,request_id uuid NOT NULL,
 subject_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),target_id uuid NOT NULL REFERENCES whaleu_community.posts(id),
 original_region_id uuid NOT NULL,grant_id uuid NOT NULL REFERENCES whaleu_authorization.role_grants(id),
 selected_authority jsonb NOT NULL,recorded_at timestamptz NOT NULL CHECK(isfinite(recorded_at) AND recorded_at=date_trunc('milliseconds',recorded_at)),
 mutation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),UNIQUE(actor_id,request_id),UNIQUE(target_id),
 FOREIGN KEY(actor_id,request_id) REFERENCES whaleu_community.admin_post_removal_commands(actor_id,request_id)
);
CREATE TABLE whaleu_notifications.admin_post_removal_notices (
 id uuid PRIMARY KEY,event_id uuid NOT NULL UNIQUE REFERENCES whaleu_community.admin_post_removal_events(id),
 recipient_account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
 kind text NOT NULL DEFAULT 'admin_post_removed' CHECK(kind='admin_post_removed'),
 created_at timestamptz NOT NULL CHECK(isfinite(created_at) AND created_at=date_trunc('milliseconds',created_at)),read_at timestamptz,
 CHECK(read_at IS NULL OR (isfinite(read_at) AND read_at>=created_at AND read_at=date_trunc('milliseconds',read_at)))
);
CREATE INDEX admin_post_removal_notice_page ON whaleu_notifications.admin_post_removal_notices(recipient_account_id,created_at DESC,id DESC);
CREATE INDEX admin_post_removal_notice_unread ON whaleu_notifications.admin_post_removal_notices(recipient_account_id) WHERE read_at IS NULL;
CREATE FUNCTION whaleu_community.admin_post_removal_immutable() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 RAISE EXCEPTION 'Administrative post-removal evidence is immutable' USING ERRCODE='23514',CONSTRAINT='admin_post_removal_causal';
END$$;
DO $$DECLARE name text;BEGIN
 FOREACH name IN ARRAY ARRAY['commands','statements','epochs','transitions','events'] LOOP
  EXECUTE format('CREATE TRIGGER admin_post_removal_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON whaleu_community.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.admin_post_removal_immutable()','admin_post_removal_'||name);
 END LOOP;
END$$;

CREATE FUNCTION whaleu_community.admin_post_removal_command_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_row record;p record;BEGIN
 IF current_setting('transaction_isolation')<>'read committed' OR NEW.mutation_transaction<>pg_current_xact_id()
 OR whaleu_community.post_owner_visibility_keys(NEW.command,ARRAY['clientRequestId','target','expectedTargetVersion','action']) IS DISTINCT FROM true
 OR whaleu_community.post_owner_visibility_keys(NEW.command->'target',ARRAY['kind','id']) IS DISTINCT FROM true
 OR NOT whaleu_profile.moderation_uuid_valid(NEW.target_id::text)
 OR NEW.command->>'clientRequestId' IS DISTINCT FROM NEW.request_id::text
 OR NEW.command->'target'->>'kind' IS DISTINCT FROM 'post' OR NEW.command->'target'->>'id' IS DISTINCT FROM NEW.target_id::text
 OR NEW.command->>'action' IS DISTINCT FROM 'remove_post'
 OR (jsonb_typeof(NEW.command->'expectedTargetVersion')='string' AND NEW.command->>'expectedTargetVersion' ~ '^[a-f0-9]{64}$') IS DISTINCT FROM true
 OR NEW.receipt->>'requestId' IS DISTINCT FROM NEW.request_id::text OR NEW.receipt->'target' IS DISTINCT FROM NEW.command->'target'
 OR NEW.receipt->>'action' IS DISTINCT FROM 'remove_post' OR NEW.receipt->'expectedTargetVersion' IS DISTINCT FROM NEW.command->'expectedTargetVersion'
 OR whaleu_community.post_owner_visibility_keys(NEW.receipt,CASE WHEN NEW.receipt->>'outcome'='rejected' THEN ARRAY['requestId','target','expectedTargetVersion','action','outcome','code'] ELSE ARRAY['requestId','target','expectedTargetVersion','action','outcome','eventId','recordedAt'] END) IS DISTINCT FROM true
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
 PERFORM pg_advisory_xact_lock(hashtextextended('whaleu:admin-post-removal-request:v1:'||NEW.actor_id::text||':'||NEW.request_id::text,0));
 PERFORM id FROM whaleu_identity.accounts WHERE id=NEW.actor_id FOR SHARE;
 PERFORM id FROM whaleu_identity.sessions WHERE id=NEW.session_id AND account_id=NEW.actor_id FOR SHARE;
 PERFORM token_hash FROM whaleu_identity.access_tokens WHERE token_hash=NEW.token_hash AND session_id=NEW.session_id FOR SHARE;
 IF NOT whaleu_profile.moderation_identity_current(NEW.actor_id,NEW.session_id,NEW.token_hash) THEN
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
 IF NOT whaleu_profile.moderation_grant_allowed(NEW.actor_id,NEW.grant_id,target_row.region_id)
 OR NOT whaleu_community.admin_post_removal_supported(NEW.actor_id,NEW.target_id,false)
 OR NOT whaleu_profile.moderation_actor_current(NEW.actor_id,clock_timestamp())
 THEN RAISE EXCEPTION 'Current scoped administrative authority required' USING ERRCODE='23514',CONSTRAINT='admin_post_removal_causal';END IF;
 SELECT * INTO p FROM whaleu_community.posts WHERE id=NEW.target_id;
 NEW.subject_id:=target_row.subject_id;NEW.original_region_id:=target_row.region_id;
 NEW.before_target_version:=whaleu_community.admin_post_removal_target_version(NEW.target_id);
 IF (NEW.receipt->>'outcome'='applied' AND NEW.before_target_version IS DISTINCT FROM NEW.command->>'expectedTargetVersion')
 OR (NEW.receipt->>'code'='ADMIN_POST_REMOVAL_STALE' AND NEW.before_target_version IS NOT DISTINCT FROM NEW.command->>'expectedTargetVersion')
 THEN RAISE EXCEPTION 'Exact post source CAS required' USING ERRCODE='23514',CONSTRAINT='admin_post_removal_causal';END IF;
 NEW.before_hash:=whaleu_profile.moderation_hash(to_jsonb(p));
 NEW.before_fingerprint:=whaleu_community.admin_post_removal_post_fingerprint(NEW.target_id);
 NEW.unchanged_hash:=whaleu_profile.moderation_hash(to_jsonb(p)-ARRAY['deleted_at','local_deletion_transaction']);
 NEW.input_before:=whaleu_community.admin_post_removal_input_facts(NEW.actor_id,NEW.grant_id,NEW.target_id);
 NEW.input_hash:=whaleu_profile.moderation_hash(NEW.input_before);
 RETURN NEW;
END$$;
CREATE TRIGGER admin_post_removal_command_guard BEFORE INSERT ON whaleu_community.admin_post_removal_commands FOR EACH ROW EXECUTE FUNCTION whaleu_community.admin_post_removal_command_guard();

CREATE FUNCTION whaleu_community.admin_post_removal_nested_evidence() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF pg_trigger_depth()<2 OR NEW.mutation_transaction<>pg_current_xact_id() THEN
  RAISE EXCEPTION 'Only an actual administrative source transition can issue evidence' USING ERRCODE='23514',CONSTRAINT='admin_post_removal_causal';END IF;
 RETURN NEW;
END$$;
DO $$DECLARE name text;BEGIN FOREACH name IN ARRAY ARRAY['statements','epochs','transitions'] LOOP
 EXECUTE format('CREATE TRIGGER admin_post_removal_nested_evidence BEFORE INSERT ON whaleu_community.%I FOR EACH ROW EXECUTE FUNCTION whaleu_community.admin_post_removal_nested_evidence()','admin_post_removal_'||name);
END LOOP;END$$;
CREATE FUNCTION whaleu_community.admin_post_removal_source_statement_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q record;BEGIN
 FOR q IN SELECT * FROM whaleu_community.admin_post_removal_commands WHERE mutation_transaction=pg_current_xact_id() LOOP
  IF q.receipt->>'outcome' IS DISTINCT FROM 'applied' OR TG_TABLE_SCHEMA<>'whaleu_community' OR TG_TABLE_NAME<>'posts' OR TG_OP<>'UPDATE' THEN
   RAISE EXCEPTION 'Administrative removal may change only one post source statement' USING ERRCODE='23514',CONSTRAINT='admin_post_removal_causal';END IF;
  INSERT INTO whaleu_community.admin_post_removal_statements(actor_id,request_id) VALUES(q.actor_id,q.request_id);
 END LOOP;
 RETURN NULL;
END$$;
CREATE FUNCTION whaleu_community.admin_post_removal_capture_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q record;BEGIN
 FOR q IN SELECT * FROM whaleu_community.admin_post_removal_commands WHERE mutation_transaction=pg_current_xact_id() LOOP
  IF q.receipt->>'outcome' IS DISTINCT FROM 'applied' OR pg_trigger_depth()<2
  OR NEW.slot<>OLD.slot OR NEW.version<>OLD.version OR NEW.epoch<>OLD.epoch+1
  OR NOT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid() AND granted AND mode='ExclusiveLock' AND classid=1464356101::oid AND objsubid=2 AND objid=NEW.slot::oid)
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(q.input_before->'community') v WHERE (v->>0)::integer=OLD.slot AND (v->>1)::integer=OLD.version AND (v->>2)::bigint=OLD.epoch)
  THEN RAISE EXCEPTION 'Only the original exact owned Community epoch may advance' USING ERRCODE='23514',CONSTRAINT='admin_post_removal_causal';END IF;
  INSERT INTO whaleu_community.admin_post_removal_epochs(actor_id,request_id,slot,version,before_epoch,after_epoch)
   VALUES(q.actor_id,q.request_id,NEW.slot,NEW.version,OLD.epoch,NEW.epoch);
 END LOOP;
 RETURN NULL;
END$$;
CREATE TRIGGER admin_post_removal_capture_epoch AFTER UPDATE ON whaleu_community.discovery_count_epochs FOR EACH ROW EXECUTE FUNCTION whaleu_community.admin_post_removal_capture_epoch();
CREATE FUNCTION whaleu_community.admin_post_removal_post_row_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q record;BEGIN
 -- Administrative removal has no undelete operation. Retain only its canonical
 -- tombstone/provenance; this does not freeze other existing owner behavior.
 IF TG_OP='UPDATE' AND EXISTS(SELECT 1 FROM whaleu_community.admin_post_removal_transitions t WHERE t.target_id=OLD.id
  AND (NEW.deleted_at IS DISTINCT FROM t.deleted_at OR NEW.local_deletion_transaction IS DISTINCT FROM t.mutation_transaction)) THEN
  RAISE EXCEPTION 'An administratively removed post cannot be resurrected' USING ERRCODE='23514',CONSTRAINT='admin_post_removal_causal';END IF;
 FOR q IN SELECT * FROM whaleu_community.admin_post_removal_commands WHERE mutation_transaction=pg_current_xact_id() LOOP
  IF TG_OP<>'UPDATE' OR q.receipt->>'outcome' IS DISTINCT FROM 'applied' OR OLD.id<>q.target_id OR OLD.deleted_at IS NOT NULL OR NEW.deleted_at IS NULL
  OR OLD.local_deletion_transaction IS NOT NULL OR NEW.local_deletion_transaction IS DISTINCT FROM OLD.local_deletion_transaction
  OR NEW.deleted_at IS DISTINCT FROM (q.receipt->>'recordedAt')::timestamptz OR NEW.deleted_at>clock_timestamp()
  OR whaleu_profile.moderation_hash(jsonb_build_array(to_jsonb(OLD),OLD.xmin::text,OLD.ctid::text)) IS DISTINCT FROM q.before_fingerprint
  OR whaleu_profile.moderation_hash(to_jsonb(OLD)) IS DISTINCT FROM q.before_hash
  OR whaleu_profile.moderation_hash(to_jsonb(NEW)-ARRAY['deleted_at','local_deletion_transaction']) IS DISTINCT FROM q.unchanged_hash
  OR EXISTS(SELECT 1 FROM whaleu_community.admin_post_removal_transitions t WHERE (t.actor_id,t.request_id)=(q.actor_id,q.request_id))
  THEN RAISE EXCEPTION 'Only the exact original live post may become a tombstone' USING ERRCODE='23514',CONSTRAINT='admin_post_removal_causal';END IF;
 END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END$$;
CREATE TRIGGER a00_admin_post_removal_row BEFORE INSERT OR UPDATE OR DELETE ON whaleu_community.posts FOR EACH ROW EXECUTE FUNCTION whaleu_community.admin_post_removal_post_row_guard();
CREATE FUNCTION whaleu_community.admin_post_removal_capture_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q record;BEGIN
 FOR q IN SELECT * FROM whaleu_community.admin_post_removal_commands WHERE mutation_transaction=pg_current_xact_id() AND receipt->>'outcome'='applied' LOOP
  IF OLD.local_deletion_transaction IS NOT NULL OR NEW.local_deletion_transaction IS DISTINCT FROM pg_current_xact_id()
  OR whaleu_profile.moderation_hash(to_jsonb(NEW)-ARRAY['deleted_at','local_deletion_transaction']) IS DISTINCT FROM q.unchanged_hash
  THEN RAISE EXCEPTION 'Canonical local deletion provenance required' USING ERRCODE='23514',CONSTRAINT='admin_post_removal_causal';END IF;
  INSERT INTO whaleu_community.admin_post_removal_transitions(actor_id,request_id,target_id,before_hash,before_fingerprint,after_hash,after_fingerprint,unchanged_hash,deleted_at)
   VALUES(q.actor_id,q.request_id,NEW.id,q.before_hash,q.before_fingerprint,whaleu_profile.moderation_hash(to_jsonb(NEW)),
   whaleu_community.admin_post_removal_post_fingerprint(NEW.id),q.unchanged_hash,NEW.deleted_at);
 END LOOP;RETURN NULL;
END$$;
CREATE TRIGGER admin_post_removal_capture_transition AFTER UPDATE ON whaleu_community.posts FOR EACH ROW EXECUTE FUNCTION whaleu_community.admin_post_removal_capture_transition();

-- An input captured with selected=NULL and a later selected-grant input are
-- checked independently. Neither can be overwritten by the command's snapshot.
CREATE FUNCTION whaleu_community.admin_post_removal_inputs_match(actor uuid,selected uuid,target uuid,expected_facts jsonb,request uuid DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE facts jsonb;q record;t record;epoch_receipt record;expected_epochs jsonb;BEGIN
 facts:=whaleu_community.admin_post_removal_input_facts(actor,selected,target);
 IF facts IS NOT DISTINCT FROM expected_facts THEN RETURN true;END IF;
 IF request IS NULL THEN RETURN false;END IF;
 SELECT * INTO q FROM whaleu_community.admin_post_removal_commands c WHERE c.actor_id=actor AND c.target_id=target
  AND c.mutation_transaction=pg_current_xact_id() AND c.receipt->>'outcome'='applied' AND c.request_id=request;
 IF NOT FOUND OR q.input_before->'post' IS DISTINCT FROM expected_facts->'post'
 OR q.input_before->'community' IS DISTINCT FROM expected_facts->'community'
 OR facts->'unchanged' IS DISTINCT FROM expected_facts->'unchanged' THEN RETURN false;END IF;
 SELECT * INTO t FROM whaleu_community.admin_post_removal_transitions WHERE actor_id=q.actor_id AND request_id=q.request_id;
 SELECT * INTO epoch_receipt FROM whaleu_community.admin_post_removal_epochs WHERE actor_id=q.actor_id AND request_id=q.request_id;
 IF t.request_id IS NULL OR epoch_receipt.request_id IS NULL OR t.mutation_transaction<>pg_current_xact_id() OR epoch_receipt.mutation_transaction<>pg_current_xact_id()
 OR t.before_fingerprint IS DISTINCT FROM q.before_fingerprint OR t.before_fingerprint IS DISTINCT FROM expected_facts->>'post'
 OR t.after_fingerprint IS DISTINCT FROM facts->>'post' OR t.unchanged_hash IS DISTINCT FROM q.unchanged_hash
 OR t.deleted_at IS DISTINCT FROM (q.receipt->>'recordedAt')::timestamptz
 OR NOT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid() AND granted AND mode='ExclusiveLock' AND classid=1464356101::oid AND objsubid=2 AND objid=epoch_receipt.slot::oid)
 THEN RETURN false;END IF;
 SELECT jsonb_agg(CASE WHEN (v->>0)::integer=epoch_receipt.slot THEN jsonb_build_array(epoch_receipt.slot,epoch_receipt.version,epoch_receipt.after_epoch::text) ELSE v END ORDER BY (v->>0)::integer)
 INTO expected_epochs FROM jsonb_array_elements(expected_facts->'community') v;
 RETURN facts->'community' IS NOT DISTINCT FROM expected_epochs;
END$$;
CREATE FUNCTION whaleu_community.admin_post_removal_inputs_current(actor uuid,selected uuid,target uuid,expected_facts jsonb,request uuid DEFAULT NULL)
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT whaleu_community.admin_post_removal_inputs_match(actor,selected,target,expected_facts,request)
$$;

CREATE FUNCTION whaleu_community.admin_post_removal_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q record;t record;authority jsonb;BEGIN
 SELECT * INTO q FROM whaleu_community.admin_post_removal_commands WHERE actor_id=NEW.actor_id AND request_id=NEW.request_id;
 SELECT * INTO t FROM whaleu_community.admin_post_removal_transitions WHERE actor_id=NEW.actor_id AND request_id=NEW.request_id;
 SELECT jsonb_build_object('id',g.id,'accountId',g.account_id,'role',g.role,'operatingRegionId',g.operating_region_id,'validFrom',g.valid_from,'expiresAt',g.expires_at)
 INTO authority FROM whaleu_authorization.role_grants g WHERE g.id=q.grant_id;
 IF NEW.selected_authority IS NULL THEN NEW.selected_authority:=authority;END IF;
 IF q.request_id IS NULL OR t.request_id IS NULL OR q.mutation_transaction<>pg_current_xact_id() OR t.mutation_transaction<>pg_current_xact_id() OR NEW.mutation_transaction<>pg_current_xact_id()
 OR q.receipt->>'outcome' IS DISTINCT FROM 'applied' OR q.receipt->>'eventId' IS DISTINCT FROM NEW.id::text
 OR (NEW.subject_id,NEW.target_id,NEW.original_region_id,NEW.grant_id) IS DISTINCT FROM (q.subject_id,q.target_id,q.original_region_id,q.grant_id)
 OR t.target_id IS DISTINCT FROM q.target_id OR t.before_fingerprint IS DISTINCT FROM q.before_fingerprint
 OR t.after_fingerprint IS DISTINCT FROM whaleu_community.admin_post_removal_post_fingerprint(q.target_id)
 OR NEW.recorded_at IS DISTINCT FROM t.deleted_at OR NEW.recorded_at IS DISTINCT FROM (q.receipt->>'recordedAt')::timestamptz
 OR NEW.recorded_at>clock_timestamp() OR NEW.selected_authority IS DISTINCT FROM authority
 THEN RAISE EXCEPTION 'Exact administrative post-removal event cause required' USING ERRCODE='23514',CONSTRAINT='admin_post_removal_causal';END IF;
 RETURN NEW;
END$$;
CREATE TRIGGER admin_post_removal_event_guard BEFORE INSERT ON whaleu_community.admin_post_removal_events FOR EACH ROW EXECUTE FUNCTION whaleu_community.admin_post_removal_event_guard();

CREATE FUNCTION whaleu_notifications.admin_post_removal_notice_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e record;BEGIN
 IF TG_OP IN('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'Administrative post-removal notice retained' USING ERRCODE='23514',CONSTRAINT='admin_post_removal_causal';END IF;
 IF TG_OP='UPDATE' THEN
  SELECT * INTO e FROM whaleu_community.admin_post_removal_events WHERE id=OLD.event_id;
  IF e.mutation_transaction=pg_current_xact_id() THEN RAISE EXCEPTION 'New administrative notice must commit unread' USING ERRCODE='23514',CONSTRAINT='admin_post_removal_causal';END IF;
  IF (to_jsonb(NEW)-'read_at') IS DISTINCT FROM (to_jsonb(OLD)-'read_at') OR NEW.read_at IS NULL OR (OLD.read_at IS NOT NULL AND NEW.read_at<>OLD.read_at) OR NEW.read_at>clock_timestamp()
  THEN RAISE EXCEPTION 'Only the first owner read timestamp can change' USING ERRCODE='23514',CONSTRAINT='admin_post_removal_causal';END IF;
 ELSE
  SELECT * INTO e FROM whaleu_community.admin_post_removal_events WHERE id=NEW.event_id;
  IF e.id IS NULL OR e.mutation_transaction<>pg_current_xact_id() OR (NEW.recipient_account_id,NEW.created_at) IS DISTINCT FROM (e.subject_id,e.recorded_at) OR NEW.read_at IS NOT NULL
  THEN RAISE EXCEPTION 'Administrative notice requires same-transaction exact event' USING ERRCODE='23514',CONSTRAINT='admin_post_removal_causal';END IF;
 END IF;
 INSERT INTO whaleu_notifications.system_notice_owners(account_id) VALUES(NEW.recipient_account_id) ON CONFLICT DO NOTHING;
 PERFORM account_id FROM whaleu_notifications.system_notice_owners WHERE account_id=NEW.recipient_account_id FOR UPDATE;
 RETURN NEW;
END$$;
CREATE TRIGGER admin_post_removal_notice_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_notifications.admin_post_removal_notices FOR EACH ROW EXECUTE FUNCTION whaleu_notifications.admin_post_removal_notice_guard();
CREATE TRIGGER admin_post_removal_notice_retain BEFORE TRUNCATE ON whaleu_notifications.admin_post_removal_notices FOR EACH STATEMENT EXECUTE FUNCTION whaleu_notifications.admin_post_removal_notice_guard();
ALTER TABLE whaleu_notifications.system_notice_ids DROP CONSTRAINT system_notice_ids_kind_check;
ALTER TABLE whaleu_notifications.system_notice_ids ADD CONSTRAINT system_notice_ids_kind_check CHECK(kind IN('post_jury_removed','profile_nickname_reset','profile_custom_avatar_cleared','admin_post_removed'));
CREATE TRIGGER register_system_notice_id AFTER INSERT ON whaleu_notifications.admin_post_removal_notices FOR EACH ROW EXECUTE FUNCTION whaleu_notifications.register_system_notice_id();
ALTER TABLE whaleu_notifications.admin_post_removal_notices ADD CONSTRAINT admin_post_removal_notice_exact_id FOREIGN KEY(id,kind,recipient_account_id) REFERENCES whaleu_notifications.system_notice_ids(id,kind,recipient_account_id) DEFERRABLE INITIALLY DEFERRED;
CREATE OR REPLACE FUNCTION whaleu_notifications.system_notice_id_complete() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF (NEW.kind='post_jury_removed' AND NOT EXISTS(SELECT 1 FROM whaleu_notifications.system_notices n WHERE (n.id,n.kind,n.recipient_account_id)=(NEW.id,NEW.kind,NEW.recipient_account_id)))
 OR (NEW.kind='profile_nickname_reset' AND NOT EXISTS(SELECT 1 FROM whaleu_notifications.profile_moderation_notices n WHERE (n.id,n.kind,n.recipient_account_id)=(NEW.id,NEW.kind,NEW.recipient_account_id)))
 OR (NEW.kind='profile_custom_avatar_cleared' AND NOT EXISTS(SELECT 1 FROM whaleu_notifications.profile_avatar_moderation_notices n WHERE (n.id,n.kind,n.recipient_account_id)=(NEW.id,NEW.kind,NEW.recipient_account_id)))
 OR (NEW.kind='admin_post_removed' AND NOT EXISTS(SELECT 1 FROM whaleu_notifications.admin_post_removal_notices n WHERE (n.id,n.kind,n.recipient_account_id)=(NEW.id,NEW.kind,NEW.recipient_account_id)))
 THEN RAISE EXCEPTION 'System notice registry requires exact source' USING ERRCODE='23514',CONSTRAINT='admin_post_removal_causal';END IF;RETURN NULL;
END$$;

CREATE FUNCTION whaleu_community.admin_post_removal_outbox_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e record;q record;BEGIN
 IF TG_OP='TRUNCATE' THEN
  IF EXISTS(SELECT 1 FROM whaleu_community.outbox WHERE event_type='admin_post_removed') THEN
   RAISE EXCEPTION 'Administrative outbox evidence retained' USING ERRCODE='23514',CONSTRAINT='admin_post_removal_causal';END IF;RETURN NULL;
 END IF;
 IF TG_OP<>'INSERT' AND (OLD.event_type='admin_post_removed' OR OLD.event_key LIKE 'admin-post-removal:%') THEN
  RAISE EXCEPTION 'Administrative outbox evidence is immutable' USING ERRCODE='23514',CONSTRAINT='admin_post_removal_causal';END IF;
 IF TG_OP<>'DELETE' AND (NEW.event_type='admin_post_removed' OR NEW.event_key LIKE 'admin-post-removal:%') THEN
  SELECT * INTO e FROM whaleu_community.admin_post_removal_events WHERE id::text=NEW.context->>'eventId';
  IF TG_OP<>'INSERT' OR e.id IS NULL OR e.mutation_transaction<>pg_current_xact_id()
  OR NEW.local_creation_transaction IS DISTINCT FROM pg_current_xact_id()
  OR NEW.event_type IS DISTINCT FROM 'admin_post_removed' OR NEW.event_key IS DISTINCT FROM 'admin-post-removal:'||e.id::text
  OR NEW.resource_id IS DISTINCT FROM e.target_id
  OR NEW.context IS DISTINCT FROM jsonb_build_object('cause','admin_post_removal','eventId',e.id,'kind','post','postId',e.target_id,'obligations',jsonb_build_array('content_invalidation','media_cleanup'))
  OR NEW.created_at<e.recorded_at OR NEW.created_at>clock_timestamp()
  THEN RAISE EXCEPTION 'Exact independent administrative invalidation event required' USING ERRCODE='23514',CONSTRAINT='admin_post_removal_causal';END IF;
 END IF;
 FOR q IN SELECT * FROM whaleu_community.admin_post_removal_commands WHERE mutation_transaction=pg_current_xact_id() LOOP
  IF TG_OP<>'INSERT' OR NEW.event_type IS DISTINCT FROM 'admin_post_removed' OR q.receipt->>'eventId' IS DISTINCT FROM NEW.context->>'eventId' THEN
   RAISE EXCEPTION 'Administrative removal cannot produce owner Experience or unrelated events' USING ERRCODE='23514',CONSTRAINT='admin_post_removal_causal';END IF;
 END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END$$;
CREATE TRIGGER admin_post_removal_outbox_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_community.outbox FOR EACH ROW EXECUTE FUNCTION whaleu_community.admin_post_removal_outbox_guard();
CREATE TRIGGER admin_post_removal_outbox_retain BEFORE TRUNCATE ON whaleu_community.outbox FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.admin_post_removal_outbox_guard();

-- The canonical 0078/0118 hooks still own cleanup and post-pin closure. These
-- guards constrain only a live administrative command, preserving normal owner,
-- jury, pin and cleanup-worker paths. Root pins are a bounded singleton by post.
CREATE FUNCTION whaleu_community.admin_post_removal_side_effect_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q record;valid boolean;BEGIN
 FOR q IN SELECT * FROM whaleu_community.admin_post_removal_commands WHERE mutation_transaction=pg_current_xact_id() LOOP
  valid:=false;
  IF q.receipt->>'outcome'='applied' THEN
   IF TG_TABLE_NAME='comment_pins' AND TG_OP='DELETE' THEN valid:=OLD.post_id=q.target_id;
   ELSIF TG_TABLE_NAME='post_pin_closures' AND TG_OP='INSERT' THEN
    valid:=pg_trigger_depth()>=2 AND NEW.reason='deleted' AND NEW.actor_id IS NULL AND NEW.request_id IS NULL
     AND EXISTS(SELECT 1 FROM whaleu_community.post_pins p WHERE p.id=NEW.pin_id AND p.post_id=q.target_id);
   ELSIF TG_TABLE_NAME='media_cleanup_jobs' AND TG_OP='INSERT' THEN
    valid:=pg_trigger_depth()>=2 AND NEW.resource_kind='post' AND NEW.resource_id=q.target_id AND NEW.post_id=q.target_id
     AND NEW.root_comment_id IS NULL AND NEW.source_deleted_at=(q.receipt->>'recordedAt')::timestamptz
     AND NEW.phase='self' AND NEW.cursor_id IS NULL AND NEW.detached_targets=0 AND NEW.enumeration_completed_at IS NULL;
   END IF;
  END IF;
  IF valid IS DISTINCT FROM true THEN RAISE EXCEPTION 'Only exact canonical administrative side effects allowed' USING ERRCODE='23514',CONSTRAINT='admin_post_removal_causal';END IF;
 END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END$$;
DO $$DECLARE name text;BEGIN
 FOREACH name IN ARRAY ARRAY['comment_pins','post_pin_closures','media_cleanup_jobs'] LOOP
  EXECUTE format('CREATE TRIGGER a00_admin_post_removal_side_effect BEFORE INSERT OR UPDATE OR DELETE ON whaleu_community.%I FOR EACH ROW EXECUTE FUNCTION whaleu_community.admin_post_removal_side_effect_guard()',name);
 END LOOP;
END$$;

CREATE FUNCTION whaleu_community.admin_post_removal_inventory_current() RETURNS boolean LANGUAGE sql STABLE AS $$
 -- Catalog dependencies are candidates, never authority: WHEN expressions can
 -- mention either function without selecting it as the trigger entry point.
 -- These statement-local CTEs preserve live DDL visibility and every original
 -- source/guard predicate. There is no stored inventory or cross-request cache.
 WITH source_dependencies AS MATERIALIZED (
  SELECT classid,objid FROM pg_catalog.pg_depend
  WHERE refclassid='pg_catalog.pg_proc'::regclass
  AND refobjid IN('whaleu_community.advance_discovery_count_epoch()'::regprocedure,
   'whaleu_safety.advance_discovery_count_epoch()'::regprocedure,'whaleu_campus.advance_discovery_count_epoch()'::regprocedure,
   'whaleu_media.advance_owner_epoch()'::regprocedure)
 ), guard_dependencies AS MATERIALIZED (
  SELECT classid,objid FROM pg_catalog.pg_depend
  WHERE refclassid='pg_catalog.pg_proc'::regclass
  AND refobjid='whaleu_community.admin_post_removal_source_statement_guard()'::regprocedure
 )
 SELECT NOT EXISTS(SELECT 1 FROM source_dependencies source_dep
  JOIN pg_catalog.pg_trigger source ON source.oid=source_dep.objid
  WHERE source_dep.classid='pg_catalog.pg_trigger'::regclass
  AND source.tgfoid IN('whaleu_community.advance_discovery_count_epoch()'::regprocedure,
   'whaleu_safety.advance_discovery_count_epoch()'::regprocedure,'whaleu_campus.advance_discovery_count_epoch()'::regprocedure,
   'whaleu_media.advance_owner_epoch()'::regprocedure)
  AND NOT source.tgisinternal AND source.tgenabled<>'D'
  AND NOT EXISTS(SELECT 1 FROM guard_dependencies guard_dep
   JOIN pg_catalog.pg_trigger guard ON guard.oid=guard_dep.objid
   WHERE guard_dep.classid='pg_catalog.pg_trigger'::regclass
   AND guard.tgrelid=source.tgrelid
   AND guard.tgfoid='whaleu_community.admin_post_removal_source_statement_guard()'::regprocedure
   AND guard.tgenabled='O' AND guard.tgtype=62))
$$;
DO $$DECLARE relation record;BEGIN
 -- Inventory real epoch source triggers rather than copying a stale table list.
 -- Profile/Experience are not inputs to this content action and may not acquire
 -- a same-transaction administrative mutation as an accidental side effect.
 FOR relation IN SELECT DISTINCT n.nspname schema_name,c.relname relation_name
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE c.relkind IN('r','p') AND (
   n.nspname IN('whaleu_profile','whaleu_experience','whaleu_verification','whaleu_authorization')
   OR (n.nspname='whaleu_identity' AND c.relname IN('accounts','sessions','access_tokens'))
   OR (n.nspname='whaleu_community' AND c.relname IN('post_pins','post_pin_heads','post_pin_reads','post_pin_scopes','post_pin_history','report_origins','publication_requests'))
   OR EXISTS(SELECT 1 FROM pg_trigger source WHERE source.tgrelid=c.oid AND NOT source.tgisinternal AND source.tgfoid IN(
    'whaleu_community.advance_discovery_count_epoch()'::regprocedure,'whaleu_safety.advance_discovery_count_epoch()'::regprocedure,
    'whaleu_campus.advance_discovery_count_epoch()'::regprocedure,'whaleu_media.advance_owner_epoch()'::regprocedure)))
  ORDER BY n.nspname,c.relname LOOP
  EXECUTE format('CREATE TRIGGER a00_admin_post_removal_source_statement BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON %I.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.admin_post_removal_source_statement_guard()',relation.schema_name,relation.relation_name);
 END LOOP;
 IF NOT whaleu_community.admin_post_removal_inventory_current() THEN RAISE EXCEPTION 'Incomplete administrative removal source inventory' USING ERRCODE='23514';END IF;
END$$;
CREATE TRIGGER a00_admin_post_removal_comment_pins_truncate BEFORE TRUNCATE ON whaleu_community.comment_pins FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.admin_post_removal_source_statement_guard();

CREATE FUNCTION whaleu_community.admin_post_removal_assert_complete(q whaleu_community.admin_post_removal_commands)
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
 IF NOT whaleu_community.admin_post_removal_inventory_current()
 OR NOT whaleu_profile.moderation_grant_allowed(q.actor_id,q.grant_id,q.original_region_id)
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
CREATE FUNCTION whaleu_community.admin_post_removal_complete() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 PERFORM whaleu_community.admin_post_removal_assert_complete(NEW);RETURN NULL;
END$$;
CREATE CONSTRAINT TRIGGER admin_post_removal_complete AFTER INSERT ON whaleu_community.admin_post_removal_commands DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community.admin_post_removal_complete();
CREATE FUNCTION whaleu_community.admin_post_removal_recheck_active() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q whaleu_community.admin_post_removal_commands;BEGIN
 FOR q IN SELECT * FROM whaleu_community.admin_post_removal_commands WHERE mutation_transaction=pg_current_xact_id() LOOP
  PERFORM whaleu_community.admin_post_removal_assert_complete(q);
 END LOOP;RETURN NULL;
END$$;
DO $$DECLARE relation text;BEGIN
 FOREACH relation IN ARRAY ARRAY['whaleu_identity.accounts','whaleu_identity.sessions','whaleu_identity.access_tokens',
 'whaleu_authorization.role_grants','whaleu_verification.account_heads','whaleu_verification.snapshots','whaleu_verification.assertions',
 'whaleu_community.discovery_count_epochs','whaleu_safety.discovery_count_epochs','whaleu_campus.discovery_count_epochs','whaleu_media.media_owner_states',
 'whaleu_community.posts','whaleu_community.comment_pins','whaleu_community.post_pin_closures','whaleu_community.media_cleanup_jobs','whaleu_community.outbox',
 'whaleu_community.admin_post_removal_statements','whaleu_community.admin_post_removal_epochs','whaleu_community.admin_post_removal_transitions','whaleu_community.admin_post_removal_events',
 'whaleu_notifications.admin_post_removal_notices','whaleu_notifications.system_notice_ids'] LOOP
  EXECUTE format('CREATE CONSTRAINT TRIGGER admin_post_removal_recheck_active AFTER INSERT OR UPDATE OR DELETE ON %s DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community.admin_post_removal_recheck_active()',relation);
 END LOOP;
END$$;
