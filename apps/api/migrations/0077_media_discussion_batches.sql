-- Explicit discussion protocol v4; historical protocol bytes and identities remain untouched.
SET LOCAL lock_timeout='5s';
SELECT pg_advisory_xact_lock(hashtextextended('whaleu:named-block-policy:v1',0));
ALTER TABLE whaleu_community.media_drafts
 ADD COLUMN protocol_version integer NOT NULL DEFAULT 1 CHECK(protocol_version IN (1,2)),
 ADD COLUMN discussion_target jsonb,
 ADD COLUMN ancestor_post_id uuid REFERENCES whaleu_community.posts(id),
 ADD CONSTRAINT media_draft_target_version CHECK(
  (protocol_version=1 AND discussion_target IS NULL AND ancestor_post_id IS NULL) OR
  (protocol_version=2 AND discussion_target IS NOT NULL AND ancestor_post_id IS NOT NULL));
ALTER TABLE whaleu_media.publication_batches ADD COLUMN protocol_version integer NOT NULL DEFAULT 3 CHECK(protocol_version IN (3,4));
ALTER TABLE whaleu_media.upload_intents DROP CONSTRAINT media_protocol_identity;
ALTER TABLE whaleu_media.upload_intents ADD CONSTRAINT media_protocol_identity CHECK(
 (protocol_version=1 AND request_hash IS NULL AND declared_sha256 IS NULL) OR
 (protocol_version IN (2,3,4) AND request_hash IS NOT NULL AND declared_sha256 IS NOT NULL));
ALTER TABLE whaleu_media.upload_intents ADD CONSTRAINT media_discussion_scope CHECK(protocol_version<>4 OR
 (owner_kind='community' AND audience='content-gated' AND target_kind='draft' AND content_version=1 AND slot='images' AND ordinal BETWEEN 0 AND 2 AND
  ((resource_kind='comment' AND purpose='community-comment-image') OR (resource_kind='reply' AND purpose='community-reply-image'))));
ALTER TABLE whaleu_community.publication_cancel_fences DROP CONSTRAINT publication_cancel_fences_operation_check;
ALTER TABLE whaleu_community.publication_cancel_fences ADD CONSTRAINT publication_cancel_fences_operation_check CHECK(operation IN ('publish_post','publish_comment','publish_reply'));
-- Replace only the two original strict post identity/reference shape constraints.
DO $$ DECLARE c record; BEGIN
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='whaleu_media.publication_batches'::regclass AND contype='c'
  AND (position('batchRequestId' in pg_get_constraintdef(oid))>0 OR position('publish_post' in pg_get_constraintdef(oid))>0)
 LOOP EXECUTE format('ALTER TABLE whaleu_media.publication_batches DROP CONSTRAINT %I',c.conname); END LOOP;
END $$;
ALTER TABLE whaleu_media.publication_batches ADD CONSTRAINT media_batch_versioned_identity CHECK(
 (state='fenced' AND identity IS NULL AND server_scope_id IS NULL AND scope_revision IS NULL AND ordered_member_ids='[]' AND publication IS NULL AND attachment_plan_digest IS NULL AND consumed_parent IS NULL) OR
 (state<>'fenced' AND identity IS NOT NULL AND jsonb_typeof(identity)='object' AND server_scope_id IS NOT NULL AND scope_revision IS NOT NULL AND
  ((protocol_version=3 AND identity-ARRAY['version','batchRequestId','draftId','spaceId','purpose']='{}'::jsonb) OR
   (protocol_version=4 AND identity-ARRAY['version','batchRequestId','draftId','spaceId','purpose','target']='{}'::jsonb AND jsonb_array_length(ordered_member_ids)<=3))));
ALTER TABLE whaleu_media.publication_batches ADD CONSTRAINT media_batch_versioned_publication CHECK(publication IS NULL OR coalesce(
 jsonb_typeof(publication)='object' AND publication->>'intentHash' ~ '^[a-f0-9]{64}$'
 AND publication-ARRAY['clientRequestId','operation','intentHash']='{}'::jsonb
 AND publication->>'clientRequestId' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
 AND ((protocol_version=3 AND publication->>'operation'='publish_post') OR
 (protocol_version=4 AND publication->>'operation'='publish_'||(identity->'target'->>'kind'))),false));
CREATE FUNCTION whaleu_community.discussion_media_draft_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.protocol_version=1 THEN RETURN NEW;END IF;
 IF NOT coalesce(
  (NEW.discussion_target->>'kind'='comment' AND NEW.discussion_target= jsonb_build_object('kind','comment','postId',NEW.ancestor_post_id::text)) OR
  (NEW.discussion_target->>'kind'='reply'
   AND NEW.discussion_target-ARRAY['kind','rootCommentId','targetReplyId']='{}'::jsonb
   AND NEW.discussion_target ?& ARRAY['kind','rootCommentId','targetReplyId']
   AND EXISTS(SELECT 1 FROM whaleu_community.root_comments r WHERE r.id::text=NEW.discussion_target->>'rootCommentId' AND r.post_id=NEW.ancestor_post_id)
   AND (NEW.discussion_target->'targetReplyId'='null'::jsonb OR EXISTS(SELECT 1 FROM whaleu_community.replies r WHERE r.id::text=NEW.discussion_target->>'targetReplyId' AND r.post_id=NEW.ancestor_post_id AND r.root_comment_id::text=NEW.discussion_target->>'rootCommentId'))),false)
 THEN RAISE EXCEPTION 'Invalid immutable discussion target' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER community_discussion_media_draft BEFORE INSERT ON whaleu_community.media_drafts FOR EACH ROW EXECUTE FUNCTION whaleu_community.discussion_media_draft_guard();
CREATE OR REPLACE FUNCTION whaleu_media.batch_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b whaleu_media.publication_batches;i whaleu_media.upload_intents;a whaleu_media.assets;
BEGIN
 IF TG_TABLE_NAME='publication_batches' THEN
  IF TG_OP='UPDATE' AND (NEW.revision<OLD.revision OR NEW.revision>OLD.revision+1 OR NEW.updated_at<OLD.updated_at OR (OLD.state IN ('fenced','terminal','consumed') AND NEW IS DISTINCT FROM OLD)) THEN
   RAISE EXCEPTION 'Terminal batch retained or invalid revision' USING ERRCODE='23514';END IF;
  IF TG_OP='INSERT' THEN
   PERFORM pg_advisory_xact_lock(hashtextextended('whaleu:media-reservation:v1:'||NEW.actor_id::text,0));
   IF (SELECT count(*) FROM whaleu_media.publication_batches WHERE actor_id=NEW.actor_id AND created_at>=date_trunc('day',clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')>=16 THEN RAISE EXCEPTION 'Daily batch budget exhausted' USING ERRCODE='23514';END IF;
  END IF;
  IF NEW.identity IS NOT NULL AND NOT coalesce(
   NEW.identity->>'batchRequestId'=NEW.client_batch_id::text AND
   (SELECT d.actor_id=NEW.actor_id AND d.client_draft_id::text=NEW.identity->>'draftId' AND d.space_id::text=NEW.identity->>'spaceId' AND d.scope_revision=NEW.scope_revision AND
    ((NEW.protocol_version=3 AND d.protocol_version=1 AND NEW.identity->'version'='1'::jsonb AND NEW.identity->>'purpose'='community-post-images') OR
     (NEW.protocol_version=4 AND d.protocol_version=2 AND NEW.identity->'version'='2'::jsonb AND NEW.identity->'target'=d.discussion_target AND NEW.identity->>'purpose'='community-'||(d.discussion_target->>'kind')||'-images'))
    FROM whaleu_community.media_drafts d WHERE d.id=NEW.server_scope_id),false) THEN
   RAISE EXCEPTION 'Batch requires exact versioned owner scope' USING ERRCODE='23514';END IF;
  RETURN NEW;
 ELSIF TG_TABLE_NAME='publication_batch_commands' THEN
  PERFORM id FROM whaleu_media.publication_batches WHERE id=NEW.batch_id FOR UPDATE;
  IF (SELECT count(*) FROM whaleu_media.publication_batch_commands WHERE batch_id=NEW.batch_id)>=128 THEN RAISE EXCEPTION 'Batch command budget exhausted' USING ERRCODE='23514';END IF;
  RETURN NEW;
 END IF;
 SELECT * INTO STRICT b FROM whaleu_media.publication_batches WHERE id=NEW.batch_id FOR UPDATE;
 IF TG_OP='INSERT' AND (b.state<>'editing' OR (SELECT count(*) FROM whaleu_media.publication_batch_members WHERE batch_id=NEW.batch_id)>=128) THEN RAISE EXCEPTION 'Batch membership is frozen or bounded' USING ERRCODE='23514';END IF;
 IF b.protocol_version=4 AND NEW.source_slot NOT BETWEEN 0 AND 2 THEN RAISE EXCEPTION 'Discussion source slot exceeds limit' USING ERRCODE='23514';END IF;
 SELECT * INTO STRICT i FROM whaleu_media.upload_intents WHERE id=NEW.intent_id;
 IF b.protocol_version=4 AND (i.resource_kind IS DISTINCT FROM b.identity->'target'->>'kind' OR i.purpose IS DISTINCT FROM 'community-'||(b.identity->'target'->>'kind')||'-image') THEN RAISE EXCEPTION 'Discussion member purpose differs from immutable target' USING ERRCODE='23514';END IF;
 IF (i.actor_id,i.client_request_id,i.request_hash,i.ordinal,i.resource_id,i.scope_revision,i.protocol_version)
 IS DISTINCT FROM (NEW.actor_id,NEW.client_request_id,NEW.request_hash,NEW.source_slot,b.server_scope_id,b.scope_revision,b.protocol_version)
 OR NEW.declaration IS DISTINCT FROM jsonb_build_object('mime',i.declared_mime,'bytes',i.declared_bytes,'sha256',i.declared_sha256) THEN
  RAISE EXCEPTION 'Member requires exact v3 immutable source' USING ERRCODE='23514';END IF;
 IF NEW.asset_id IS NOT NULL THEN
  SELECT * INTO a FROM whaleu_media.assets WHERE id=NEW.asset_id;
  IF a.intent_id IS DISTINCT FROM NEW.intent_id OR a.actor_id IS DISTINCT FROM NEW.actor_id OR a.ordinal IS DISTINCT FROM NEW.source_slot THEN RAISE EXCEPTION 'Wrong member asset' USING ERRCODE='23514';END IF;
 END IF;
 IF TG_OP='UPDATE' AND ((OLD.asset_id IS NOT NULL AND NEW.asset_id IS DISTINCT FROM OLD.asset_id) OR (OLD.state IN ('terminal','bound') AND NEW IS DISTINCT FROM OLD)) THEN RAISE EXCEPTION 'Member terminal identity retained' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION whaleu_media.batch_set_consistent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b whaleu_media.publication_batches;bid uuid;ids jsonb;
BEGIN
 IF TG_TABLE_NAME='publication_batches' THEN bid:=NEW.id; ELSE bid:=NEW.batch_id; END IF;
 SELECT * INTO STRICT b FROM whaleu_media.publication_batches WHERE id=bid;
 IF (SELECT count(*) FROM whaleu_media.publication_batch_members WHERE batch_id=bid AND state IN ('live','bound'))>(CASE WHEN b.protocol_version=4 THEN 3 ELSE 9 END)
 OR (SELECT count(*) FROM whaleu_media.publication_batch_members WHERE batch_id=bid AND state='retiring')>(CASE WHEN b.protocol_version=4 THEN 3 ELSE 9 END)
 OR (SELECT count(*) FROM jsonb_array_elements_text(b.ordered_member_ids))<>(SELECT count(DISTINCT value) FROM jsonb_array_elements_text(b.ordered_member_ids))
 OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(b.ordered_member_ids) x LEFT JOIN whaleu_media.publication_batch_members m ON m.batch_id=bid AND m.member_id::text=x.value AND m.state IN ('live','bound') WHERE m.member_id IS NULL)
 OR EXISTS(SELECT 1 FROM whaleu_media.publication_batch_members m WHERE m.batch_id=bid AND m.state IN ('live','bound') AND NOT b.ordered_member_ids ? m.member_id::text)
 THEN RAISE EXCEPTION 'Batch ordered full-set mismatch' USING ERRCODE='23514';END IF;
 IF b.state IN ('sealed','consumed') AND (jsonb_array_length(b.ordered_member_ids)=0 OR EXISTS(SELECT 1 FROM whaleu_media.publication_batch_members WHERE batch_id=bid AND state='retiring')) THEN RAISE EXCEPTION 'Sealed batch has missing or retiring members' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION whaleu_media.v3_member_consistent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE m whaleu_media.publication_batch_members;f whaleu_media.upload_request_fences;
BEGIN
 IF NEW.protocol_version NOT IN (3,4) THEN RETURN NULL;END IF;
 SELECT * INTO m FROM whaleu_media.publication_batch_members WHERE intent_id=NEW.id;
 SELECT * INTO f FROM whaleu_media.upload_request_fences WHERE actor_id=NEW.actor_id AND client_request_id=NEW.client_request_id;
 IF m.intent_id IS NULL OR f.intent_id IS DISTINCT FROM NEW.id OR f.request_hash IS DISTINCT FROM NEW.request_hash THEN RAISE EXCEPTION 'V3 intent requires exact batch member and original request fence' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION whaleu_media.binding_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a whaleu_media.assets; i whaleu_media.upload_intents; c whaleu_media.scope_consumptions;
 b whaleu_media.publication_batches; m whaleu_media.publication_batch_members;
 approved boolean; hint_intent uuid; hint_batch uuid; expected_evidence jsonb;
BEGIN
 -- Immutable routing reads precede the shared mutation order: batch -> intent
 -- -> asset. NOWAIT rejects a competing late worker without a lock upgrade cycle.
 SELECT intent_id INTO STRICT hint_intent FROM whaleu_media.assets WHERE id=NEW.asset_id;
 SELECT batch_id INTO hint_batch FROM whaleu_media.publication_batch_members WHERE intent_id=hint_intent;
 IF hint_batch IS NOT NULL THEN
  SELECT * INTO STRICT b FROM whaleu_media.publication_batches WHERE id=hint_batch FOR UPDATE NOWAIT;
 END IF;
 SELECT * INTO STRICT i FROM whaleu_media.upload_intents WHERE id=hint_intent FOR UPDATE NOWAIT;
 SELECT * INTO STRICT a FROM whaleu_media.assets WHERE id=NEW.asset_id FOR UPDATE NOWAIT;
 SELECT e.state='allow' AND e.effective_at<=clock_timestamp() AND e.valid_until>clock_timestamp()
  AND e.manifest_digest=a.manifest_digest AND e.policy_revision=a.policy_revision
 INTO approved FROM whaleu_media.asset_safety_heads h
 JOIN whaleu_media.asset_safety_events e ON (e.asset_id,e.revision,e.id)=(h.asset_id,h.revision,h.event_id)
 WHERE h.asset_id=a.id;
 IF i.state<>'ready' OR approved IS DISTINCT FROM true OR
 ROW(NEW.owner_kind,NEW.resource_kind,NEW.content_version,NEW.slot,NEW.manifest_digest)
 IS DISTINCT FROM ROW(a.owner_kind,a.resource_kind,a.content_version,a.slot,a.manifest_digest)
 OR NEW.detached_at IS NOT NULL THEN
  RAISE EXCEPTION 'Media binding requires exact currently allowed ready asset' USING ERRCODE='23514'; END IF;
 IF i.protocol_version IN (3,4) THEN
  SELECT * INTO m FROM whaleu_media.publication_batch_members WHERE intent_id=i.id;
  expected_evidence:=jsonb_build_object('version',CASE WHEN i.protocol_version=4 THEN 3 ELSE 2 END,'scopeId',a.resource_id::text,'scopeRevision',a.scope_revision,
   'batchId',b.id::text,'batchRevision',b.revision::text,'attachmentPlanDigest',b.attachment_plan_digest,
   'memberId',m.member_id::text,'sourceSlot',m.source_slot);
  IF b.id IS NULL OR b.state<>'sealed' OR m.state<>'live' OR m.asset_id IS DISTINCT FROM a.id
   OR m.actor_id IS DISTINCT FROM a.actor_id OR m.source_slot IS DISTINCT FROM a.ordinal
   OR b.server_scope_id IS DISTINCT FROM a.resource_id OR b.scope_revision IS DISTINCT FROM a.scope_revision
   OR NEW.ordinal<0 OR NEW.ordinal>=jsonb_array_length(b.ordered_member_ids)
   OR b.ordered_member_ids->>NEW.ordinal IS DISTINCT FROM m.member_id::text
   OR NEW.attach_evidence IS DISTINCT FROM expected_evidence THEN
   RAISE EXCEPTION 'V3 binding requires exact sealed source-slot mapping' USING ERRCODE='23514'; END IF;
 ELSE
  -- Never relax the legacy ordinal rule merely because a batch implementation exists.
  IF NEW.ordinal IS DISTINCT FROM a.ordinal THEN
   RAISE EXCEPTION 'Legacy Media binding ordinal mismatch' USING ERRCODE='23514'; END IF;
 END IF;
 IF a.target_kind='parent' THEN
  IF NEW.resource_id<>a.resource_id THEN
   RAISE EXCEPTION 'Media parent target mismatch' USING ERRCODE='23514'; END IF;
 ELSE
  SELECT * INTO c FROM whaleu_media.scope_consumptions WHERE actor_id=a.actor_id
   AND owner_kind=a.owner_kind AND resource_kind=a.resource_kind AND scope_resource_id=a.resource_id;
  IF NOT FOUND OR c.scope_revision<>a.scope_revision OR c.resource_id<>NEW.resource_id
   OR c.content_version<>NEW.content_version OR c.transaction_id<>pg_current_xact_id() THEN
   RAISE EXCEPTION 'Media draft must be consumed by this exact publication transaction' USING ERRCODE='23514'; END IF;
  IF i.protocol_version IN (3,4) AND (c.attach_evidence->'version' IS DISTINCT FROM to_jsonb(CASE WHEN i.protocol_version=4 THEN 3 ELSE 2 END)
   OR c.attach_evidence->>'batchId' IS DISTINCT FROM b.id::text
   OR c.attach_evidence->>'batchRevision' IS DISTINCT FROM b.revision::text
   OR c.attach_evidence->>'attachmentPlanDigest' IS DISTINCT FROM b.attachment_plan_digest
   OR c.attach_evidence->'publication' IS DISTINCT FROM b.publication) THEN
   RAISE EXCEPTION 'V3 scope consumption requires exact sealed publication' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION whaleu_community.assert_discussion_media_publication(kind text,parent_id uuid,actor uuid,reference jsonb,images jsonb,target jsonb) RETURNS void LANGUAGE plpgsql AS $$
DECLARE actual_images jsonb; actual_target jsonb; n integer:=jsonb_array_length(images);
BEGIN
 IF kind NOT IN ('comment','reply') OR n NOT BETWEEN 1 AND 3 THEN RAISE EXCEPTION 'Invalid discussion media parent' USING ERRCODE='23514';END IF;
 IF kind='comment' THEN
  SELECT jsonb_build_object('kind','comment','postId',post_id::text) INTO actual_target FROM whaleu_community.root_comments WHERE id=parent_id AND account_id=actor;
  SELECT jsonb_agg(jsonb_build_object('assetId',asset_id::text,'digest',digest) ORDER BY position) INTO actual_images FROM whaleu_community.comment_images WHERE comment_id=parent_id;
  IF EXISTS(SELECT 1 FROM whaleu_community.comment_images WHERE comment_id=parent_id AND (position<0 OR position>=n)) THEN RAISE EXCEPTION 'Invalid discussion image positions' USING ERRCODE='23514';END IF;
 ELSE
  SELECT jsonb_build_object('kind','reply','rootCommentId',root_comment_id::text,'targetReplyId',target_reply_id::text) INTO actual_target FROM whaleu_community.replies WHERE id=parent_id AND account_id=actor;
  SELECT jsonb_agg(jsonb_build_object('assetId',asset_id::text,'digest',digest) ORDER BY position) INTO actual_images FROM whaleu_community.reply_images WHERE reply_id=parent_id;
  IF EXISTS(SELECT 1 FROM whaleu_community.reply_images WHERE reply_id=parent_id AND (position<0 OR position>=n)) THEN RAISE EXCEPTION 'Invalid discussion image positions' USING ERRCODE='23514';END IF;
 END IF;
 IF actual_target IS DISTINCT FROM target OR actual_images IS DISTINCT FROM images
 OR NOT EXISTS(SELECT 1 FROM whaleu_community.content_approval_bindings WHERE content_kind=kind AND content_id=parent_id AND content_version=1 AND account_id=actor AND operation='publish_'||kind AND envelope->'images'=images)
 OR NOT EXISTS(SELECT 1 FROM whaleu_community.publication_requests WHERE account_id=actor AND client_request_id::text=reference->>'clientRequestId' AND operation='publish_'||kind AND payload_hash=reference->>'intentHash' AND receipt->>'outcome'='created' AND receipt->>'resourceId'=parent_id::text)
 OR NOT EXISTS(SELECT 1 FROM whaleu_community.outbox WHERE event_key=kind||':'||parent_id::text||':created' AND event_type=kind||'_created' AND resource_id=parent_id)
 THEN RAISE EXCEPTION 'Discussion batch requires exact atomic owner publication' USING ERRCODE='23514';END IF;
END $$;
CREATE OR REPLACE FUNCTION whaleu_media.assert_batch_consumed(batch_id uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE b whaleu_media.publication_batches;c whaleu_media.scope_consumptions;
 images jsonb;mappings jsonb;actual_images jsonb;expected_evidence jsonb;parent_id uuid;n integer;kind text;evidence_version integer;
BEGIN
 SELECT * INTO STRICT b FROM whaleu_media.publication_batches WHERE id=batch_id;
 IF b.state<>'consumed' THEN RETURN;END IF;
 parent_id:=(b.consumed_parent->>'resourceId')::uuid;
 kind:=CASE WHEN b.protocol_version=4 THEN b.identity->'target'->>'kind' ELSE 'post' END;
 evidence_version:=CASE WHEN b.protocol_version=4 THEN 3 ELSE 2 END;
 IF b.consumed_parent IS DISTINCT FROM jsonb_build_object('ownerKind','community','resourceKind',kind,'resourceId',parent_id::text,'contentVersion',1)
  OR parent_id IS NULL THEN RAISE EXCEPTION 'Invalid consumed batch parent' USING ERRCODE='23514';END IF;
 n:=jsonb_array_length(b.ordered_member_ids);
 IF (n<1 OR n>CASE WHEN b.protocol_version=4 THEN 3 ELSE 9 END) THEN RAISE EXCEPTION 'Invalid consumed member count' USING ERRCODE='23514';END IF;
 SELECT jsonb_agg(jsonb_build_object('assetId',a.id::text,'digest',a.manifest_digest) ORDER BY x.ordinal),
  jsonb_agg(jsonb_build_object('memberId',m.member_id::text,'sourceSlot',m.source_slot,
   'assetId',a.id::text,'manifestDigest',a.manifest_digest,'ordinal',x.ordinal-1) ORDER BY x.ordinal)
 INTO images,mappings
 FROM jsonb_array_elements_text(b.ordered_member_ids) WITH ORDINALITY x(member_id,ordinal)
 JOIN whaleu_media.publication_batch_members m ON m.batch_id=b.id AND m.member_id::text=x.member_id AND m.state='bound'
 JOIN whaleu_media.assets a ON a.id=m.asset_id AND a.intent_id=m.intent_id AND a.actor_id=b.actor_id
  AND a.resource_id=b.server_scope_id AND a.scope_revision=b.scope_revision AND a.ordinal=m.source_slot;
 IF images IS NULL OR jsonb_array_length(images)<>n OR jsonb_array_length(mappings)<>n THEN
  RAISE EXCEPTION 'Consumed batch missing exact member asset' USING ERRCODE='23514';END IF;
 expected_evidence:=jsonb_build_object('version',evidence_version,'batchId',b.id::text,'batchRevision',b.revision::text,
  'attachmentPlanDigest',b.attachment_plan_digest,'publication',b.publication,'assets',images,'mappings',mappings);
 SELECT * INTO c FROM whaleu_media.scope_consumptions WHERE actor_id=b.actor_id AND owner_kind='community'
  AND resource_kind=kind AND scope_resource_id=b.server_scope_id;
 IF c.resource_id IS DISTINCT FROM parent_id OR c.scope_revision IS DISTINCT FROM b.scope_revision
  OR c.content_version IS DISTINCT FROM 1 OR c.attach_evidence IS DISTINCT FROM expected_evidence THEN
  RAISE EXCEPTION 'Consumed batch lacks full versioned scope evidence' USING ERRCODE='23514';END IF;
 IF (SELECT count(*) FROM whaleu_media.bindings WHERE owner_kind='community' AND resource_kind=kind
  AND resource_id=parent_id AND content_version=1)<>n OR EXISTS(
   SELECT 1 FROM jsonb_array_elements(mappings) x
   LEFT JOIN whaleu_media.bindings a ON a.asset_id=(x->>'assetId')::uuid
    AND a.owner_kind='community' AND a.resource_kind=kind AND a.resource_id=parent_id AND a.content_version=1
    AND a.slot='images' AND a.ordinal=(x->>'ordinal')::integer AND a.manifest_digest=x->>'manifestDigest'
    AND a.attach_evidence=jsonb_build_object('version',evidence_version,'scopeId',b.server_scope_id::text,'scopeRevision',b.scope_revision,
     'batchId',b.id::text,'batchRevision',b.revision::text,'attachmentPlanDigest',b.attachment_plan_digest,
     'memberId',x->>'memberId','sourceSlot',(x->>'sourceSlot')::integer)
   WHERE a.id IS NULL
  ) THEN RAISE EXCEPTION 'Consumed batch bindings must close the entire ordered set' USING ERRCODE='23514';END IF;
 IF b.protocol_version=4 THEN
  PERFORM whaleu_community.assert_discussion_media_publication(kind,parent_id,b.actor_id,b.publication,images,b.identity->'target');
  RETURN;
 END IF;
 SELECT jsonb_agg(jsonb_build_object('assetId',asset_id::text,'digest',digest) ORDER BY position)
 INTO actual_images FROM whaleu_community.post_images WHERE post_id=parent_id;
 IF actual_images IS DISTINCT FROM images OR EXISTS(SELECT 1 FROM whaleu_community.post_images WHERE post_id=parent_id AND (position<0 OR position>=n)) THEN
  RAISE EXCEPTION 'Owner definition differs from complete batch' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT 1 FROM whaleu_community.content_approval_bindings WHERE content_kind='post' AND content_id=parent_id
   AND content_version=1 AND account_id=b.actor_id AND operation='publish_post' AND envelope->'images'=images)
 OR NOT EXISTS(SELECT 1 FROM whaleu_community.publication_requests WHERE account_id=b.actor_id
   AND client_request_id::text=b.publication->>'clientRequestId' AND operation='publish_post'
   AND payload_hash=b.publication->>'intentHash' AND receipt->>'outcome'='created' AND receipt->>'resourceId'=parent_id::text)
 OR NOT EXISTS(SELECT 1 FROM whaleu_community.outbox WHERE event_key='post:'||parent_id::text||':created'
   AND event_type='post_created' AND resource_id=parent_id) THEN
  RAISE EXCEPTION 'Consumed batch requires atomic approval receipt and outbox' USING ERRCODE='23514';END IF;
END $$;

CREATE OR REPLACE FUNCTION whaleu_media.scope_consumption_complete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.attach_evidence->'version' IN ('2'::jsonb,'3'::jsonb) THEN
  PERFORM whaleu_media.assert_batch_consumed((NEW.attach_evidence->>'batchId')::uuid);
  IF NOT EXISTS(SELECT 1 FROM whaleu_media.publication_batches WHERE id=(NEW.attach_evidence->>'batchId')::uuid AND state='consumed')
   OR EXISTS(SELECT 1 FROM whaleu_media.bindings WHERE owner_kind=NEW.owner_kind AND resource_kind=NEW.resource_kind
    AND resource_id=NEW.resource_id AND content_version=NEW.content_version AND detached_at IS NOT NULL) THEN
   RAISE EXCEPTION 'V3 scope requires atomic complete active consumption' USING ERRCODE='23514';END IF;
 ELSE
  IF NOT EXISTS(SELECT 1 FROM whaleu_media.assets a JOIN whaleu_media.bindings b ON b.asset_id=a.id
   WHERE a.actor_id=NEW.actor_id AND a.owner_kind=NEW.owner_kind AND a.resource_kind=NEW.resource_kind
    AND a.target_kind='draft' AND a.resource_id=NEW.scope_resource_id AND a.scope_revision=NEW.scope_revision
    AND b.owner_kind=NEW.owner_kind AND b.resource_kind=NEW.resource_kind AND b.resource_id=NEW.resource_id
    AND b.content_version=NEW.content_version AND b.detached_at IS NULL) THEN
   RAISE EXCEPTION 'Media draft consumption requires an atomic exact binding' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NULL;
END $$;
