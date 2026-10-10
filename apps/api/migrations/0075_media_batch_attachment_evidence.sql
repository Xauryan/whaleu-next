-- Versioned batch source-slot -> final-ordinal evidence. Existing v1 evidence
-- and all historical migration bytes remain unchanged.
SET LOCAL lock_timeout='5s';
SELECT pg_advisory_xact_lock(hashtextextended('whaleu:named-block-policy:v1',0));

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
 IF i.protocol_version=3 THEN
  SELECT * INTO m FROM whaleu_media.publication_batch_members WHERE intent_id=i.id;
  expected_evidence:=jsonb_build_object('version',2,'scopeId',a.resource_id::text,'scopeRevision',a.scope_revision,
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
  IF i.protocol_version=3 AND (c.attach_evidence->'version' IS DISTINCT FROM '2'::jsonb
   OR c.attach_evidence->>'batchId' IS DISTINCT FROM b.id::text
   OR c.attach_evidence->>'batchRevision' IS DISTINCT FROM b.revision::text
   OR c.attach_evidence->>'attachmentPlanDigest' IS DISTINCT FROM b.attachment_plan_digest
   OR c.attach_evidence->'publication' IS DISTINCT FROM b.publication) THEN
   RAISE EXCEPTION 'V3 scope consumption requires exact sealed publication' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION whaleu_media.assert_batch_consumed(batch_id uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE b whaleu_media.publication_batches;c whaleu_media.scope_consumptions;
 images jsonb;mappings jsonb;actual_images jsonb;expected_evidence jsonb;parent_id uuid;n integer;
BEGIN
 SELECT * INTO STRICT b FROM whaleu_media.publication_batches WHERE id=batch_id;
 IF b.state<>'consumed' THEN RETURN;END IF;
 parent_id:=(b.consumed_parent->>'resourceId')::uuid;
 IF b.consumed_parent IS DISTINCT FROM jsonb_build_object('ownerKind','community','resourceKind','post','resourceId',parent_id::text,'contentVersion',1)
  OR parent_id IS NULL THEN RAISE EXCEPTION 'Invalid consumed batch parent' USING ERRCODE='23514';END IF;
 n:=jsonb_array_length(b.ordered_member_ids);
 IF n NOT BETWEEN 1 AND 9 THEN RAISE EXCEPTION 'Invalid consumed member count' USING ERRCODE='23514';END IF;
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
 expected_evidence:=jsonb_build_object('version',2,'batchId',b.id::text,'batchRevision',b.revision::text,
  'attachmentPlanDigest',b.attachment_plan_digest,'publication',b.publication,'assets',images,'mappings',mappings);
 SELECT * INTO c FROM whaleu_media.scope_consumptions WHERE actor_id=b.actor_id AND owner_kind='community'
  AND resource_kind='post' AND scope_resource_id=b.server_scope_id;
 IF c.resource_id IS DISTINCT FROM parent_id OR c.scope_revision IS DISTINCT FROM b.scope_revision
  OR c.content_version IS DISTINCT FROM 1 OR c.attach_evidence IS DISTINCT FROM expected_evidence THEN
  RAISE EXCEPTION 'Consumed batch lacks full versioned scope evidence' USING ERRCODE='23514';END IF;
 IF (SELECT count(*) FROM whaleu_media.bindings WHERE owner_kind='community' AND resource_kind='post'
  AND resource_id=parent_id AND content_version=1)<>n OR EXISTS(
   SELECT 1 FROM jsonb_array_elements(mappings) x
   LEFT JOIN whaleu_media.bindings a ON a.asset_id=(x->>'assetId')::uuid
    AND a.owner_kind='community' AND a.resource_kind='post' AND a.resource_id=parent_id AND a.content_version=1
    AND a.slot='images' AND a.ordinal=(x->>'ordinal')::integer AND a.manifest_digest=x->>'manifestDigest'
    AND a.attach_evidence=jsonb_build_object('version',2,'scopeId',b.server_scope_id::text,'scopeRevision',b.scope_revision,
     'batchId',b.id::text,'batchRevision',b.revision::text,'attachmentPlanDigest',b.attachment_plan_digest,
     'memberId',x->>'memberId','sourceSlot',(x->>'sourceSlot')::integer)
   WHERE a.id IS NULL
  ) THEN RAISE EXCEPTION 'Consumed batch bindings must close the entire ordered set' USING ERRCODE='23514';END IF;
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
 IF NEW.attach_evidence->'version'='2'::jsonb THEN
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
CREATE FUNCTION whaleu_media.batch_consumption_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE bid uuid;
BEGIN
 IF TG_TABLE_NAME='publication_batches' THEN bid:=NEW.id; ELSE bid:=NEW.batch_id; END IF;
 PERFORM whaleu_media.assert_batch_consumed(bid);
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER media_batch_consumed_complete AFTER INSERT OR UPDATE ON whaleu_media.publication_batches DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_media.batch_consumption_complete();
CREATE CONSTRAINT TRIGGER media_batch_member_consumed_complete AFTER INSERT OR UPDATE ON whaleu_media.publication_batch_members DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_media.batch_consumption_complete();
