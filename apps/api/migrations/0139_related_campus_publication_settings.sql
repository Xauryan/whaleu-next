-- Publication/settings slice. Apply after core related-sync owner functions.
-- Existing 0100 payload validator and all v1 command/hash/receipt behavior remain.
CREATE FUNCTION whaleu_community.school_posting_command_shape_valid(value jsonb, request_id uuid, target_revision integer) RETURNS boolean LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE payload jsonb;
BEGIN
 IF jsonb_typeof(value)<>'object' OR value->>'clientRequestId' IS DISTINCT FROM request_id::text
 OR request_id::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
 OR jsonb_typeof(value->'expectedRevision') IS DISTINCT FROM 'number'
 OR value->>'expectedRevision' !~ '^(0|[1-9][0-9]*)$'
 OR (value->>'expectedRevision')::numeric<>target_revision-1 THEN RETURN false; END IF;
 payload:=value->'policy';
 IF value ? 'version' THEN
  RETURN coalesce(value->'version'='2'::jsonb AND value-ARRAY['version','clientRequestId','expectedRevision','policy']='{}'::jsonb
   AND jsonb_typeof(payload->'relatedSyncEnabled')='boolean'
   AND whaleu_community.school_posting_policy_payload_valid(payload-'relatedSyncEnabled'),false);
 END IF;
 RETURN coalesce(value-ARRAY['clientRequestId','expectedRevision','policy']='{}'::jsonb
  AND whaleu_community.school_posting_policy_payload_valid(payload),false);
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
-- Replace precisely the legacy shape and command hash checks, preserving all
-- IDs, paired FKs, audit receipt, request length and immutable-owner triggers.
DO $$ DECLARE c record; n integer:=0; BEGIN
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='whaleu_community.region_policy_commands'::regclass AND contype='c'
 AND (pg_get_constraintdef(oid) LIKE '%school_posting_policy_payload_valid%' OR pg_get_constraintdef(oid) LIKE '%whaleu-school-posting-policy-command:v1%') LOOP
  EXECUTE format('ALTER TABLE whaleu_community.region_policy_commands DROP CONSTRAINT %I',c.conname); n:=n+1;
 END LOOP;
 IF n<>2 THEN RAISE EXCEPTION 'Unexpected school policy command constraints'; END IF;
END $$;
ALTER TABLE whaleu_community.region_policy_commands
 ADD COLUMN related_command_transaction xid8,
 ADD COLUMN related_command_fingerprint text CHECK(related_command_fingerprint IS NULL OR related_command_fingerprint ~ '^[a-f0-9]{64}$'),
 ADD COLUMN related_enable_fingerprint text CHECK(related_enable_fingerprint IS NULL OR related_enable_fingerprint ~ '^[a-f0-9]{64}$'),
 ADD CONSTRAINT school_posting_versioned_shape CHECK(whaleu_community.school_posting_command_shape_valid(command,client_request_id,revision)),
 ADD CONSTRAINT school_posting_versioned_hash CHECK(request_hash=encode(sha256(convert_to(
  CASE WHEN command->'version'='2'::jsonb THEN 'whaleu-school-posting-policy-command:v2' ELSE 'whaleu-school-posting-policy-command:v1' END||chr(10)||
  whaleu_community.content_canonical_json(jsonb_build_object('actorId',actor_id::text,'regionId',region_id::text,'command',command)),'UTF8')),'hex')),
 ADD CONSTRAINT school_posting_versioned_evidence CHECK(
  CASE WHEN command->'version'='2'::jsonb THEN related_command_transaction IS NOT NULL AND related_command_fingerprint IS NOT NULL
   AND ((command->'policy'->'relatedSyncEnabled'='true'::jsonb)=(related_enable_fingerprint IS NOT NULL))
  ELSE related_command_transaction IS NULL AND related_command_fingerprint IS NULL AND related_enable_fingerprint IS NULL END);
CREATE INDEX school_posting_v2_transaction ON whaleu_community.region_policy_commands(related_command_transaction) WHERE related_command_transaction IS NOT NULL;
CREATE FUNCTION whaleu_community.school_posting_v2_fingerprint(grant_key uuid, region uuid) RETURNS text LANGUAGE sql STABLE AS $$
 SELECT encode(sha256(convert_to(whaleu_community.content_canonical_json(jsonb_build_object(
  'grant',(SELECT jsonb_build_array(to_jsonb(g),g.xmin::text,g.ctid::text) FROM whaleu_authorization.role_grants g WHERE g.id=grant_key),
  'region',(SELECT jsonb_build_array(to_jsonb(r),r.xmin::text,r.ctid::text) FROM whaleu_campus.operating_regions r WHERE r.id=region),
  'policy',(SELECT jsonb_build_array(to_jsonb(h),h.xmin::text,h.ctid::text,to_jsonb(p),p.xmin::text,p.ctid::text)
   FROM whaleu_community.region_policy_heads h LEFT JOIN whaleu_community.region_policy_revisions p ON p.id=h.revision_id AND p.region_id=h.region_id AND p.revision=h.revision WHERE h.region_id=region)
 )),'UTF8')),'hex')
$$;
CREATE OR REPLACE FUNCTION whaleu_community.school_posting_command_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE authority whaleu_authorization.role_grants; policy whaleu_community.region_policy_revisions; previous whaleu_community.region_policy_revisions;
BEGIN

 IF NEW.command->>'version'='2' THEN
  IF TG_OP<>'INSERT' OR NEW.related_command_transaction IS NOT NULL OR NEW.related_command_fingerprint IS NOT NULL OR NEW.related_enable_fingerprint IS NOT NULL THEN
   RAISE EXCEPTION 'School v2 admission evidence is owner-issued' USING ERRCODE='23514';
  END IF;
  NEW.related_command_transaction:=pg_current_xact_id();
  NEW.related_command_fingerprint:=whaleu_community.school_posting_v2_fingerprint(NEW.grant_id,NEW.region_id);
  IF NEW.command->'policy'->'relatedSyncEnabled'='true'::jsonb THEN
   NEW.related_enable_fingerprint:=whaleu_community.related_sync_enable_fingerprint(NEW.region_id);
   IF NOT whaleu_community.related_sync_enable_allowed(NEW.region_id) OR NEW.related_enable_fingerprint IS NULL THEN
    RAISE EXCEPTION 'Related sync requires complete current multi-region applicability' USING ERRCODE='23514';
   END IF;
  END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'School policy commands are immutable' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('whaleu:school-posting-policy-request:v1:'||NEW.actor_id::text||':'||NEW.client_request_id::text,0));
 IF EXISTS(SELECT 1 FROM whaleu_community.region_policy_cancellations WHERE actor_id=NEW.actor_id AND client_request_id=NEW.client_request_id) THEN RAISE EXCEPTION 'School policy command was cancelled' USING ERRCODE='23514'; END IF;
 SELECT * INTO authority FROM whaleu_authorization.role_grants WHERE id=NEW.grant_id FOR SHARE;
 IF NOT FOUND OR authority.account_id<>NEW.actor_id OR authority.revoked_at IS NOT NULL OR authority.valid_from>clock_timestamp() OR (authority.expires_at IS NOT NULL AND authority.expires_at<=clock_timestamp())
 OR NOT ((authority.role='super_admin' AND authority.operating_region_id IS NULL) OR (authority.role='school_admin' AND authority.operating_region_id=NEW.region_id)) THEN RAISE EXCEPTION 'School policy requires current exact authority' USING ERRCODE='23514'; END IF;
 PERFORM 1 FROM whaleu_campus.operating_regions WHERE id=NEW.region_id AND is_active FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'School region is unavailable' USING ERRCODE='23514'; END IF;
 SELECT * INTO policy FROM whaleu_community.region_policy_revisions WHERE id=NEW.revision_id AND region_id=NEW.region_id AND revision=NEW.revision;
 IF NOT FOUND OR policy.school_admin_publication_transaction IS DISTINCT FROM pg_current_xact_id() OR policy.coverage_state<>'complete' OR policy.provenance_state<>'accepted'
 OR policy.source_reference IS DISTINCT FROM 'whaleu:school-posting-command:v2:'||NEW.actor_id::text||':'||NEW.client_request_id::text
 OR policy.policy_reference IS DISTINCT FROM 'whaleu:school-posting-policy:v2' OR policy.related_sync_enabled IS DISTINCT FROM (NEW.command->'policy'->>'relatedSyncEnabled')::boolean
 OR policy.effective_at>clock_timestamp() OR policy.effective_at<transaction_timestamp()
 OR policy.unverified_post_enabled IS DISTINCT FROM (NEW.command->'policy'->>'unverifiedPostEnabled')::boolean
 OR policy.unverified_comment_enabled IS DISTINCT FROM (NEW.command->'policy'->>'unverifiedCommentEnabled')::boolean
 OR to_jsonb(policy.unverified_categories) IS DISTINCT FROM NEW.command->'policy'->'unverifiedCategories'
 OR policy.expiry_kind IS DISTINCT FROM NEW.command->'policy'->'expiry'->>'kind'
 OR (policy.expiry_kind='at' AND (policy.valid_until IS DISTINCT FROM (NEW.command->'policy'->'expiry'->>'validUntil')::timestamptz OR policy.valid_until<=clock_timestamp()))
 OR (policy.expiry_kind='policy_exempt' AND policy.valid_until IS NOT NULL)
 THEN RAISE EXCEPTION 'School policy revision must match its exact command' USING ERRCODE='23514'; END IF;
 IF NEW.previous_revision_id IS NOT NULL THEN
   SELECT * INTO previous FROM whaleu_community.region_policy_revisions WHERE id=NEW.previous_revision_id AND region_id=NEW.region_id AND revision=NEW.revision-1;
   IF NOT FOUND OR previous.coverage_state<>'complete' OR previous.provenance_state<>'accepted' OR coalesce(length(btrim(previous.source_reference)),0)=0 OR coalesce(length(btrim(previous.policy_reference)),0)=0
   OR previous.effective_at>clock_timestamp() OR previous.expiry_kind='unknown'
   OR (previous.expiry_kind='policy_exempt' AND previous.valid_until IS NOT NULL)
   OR (previous.expiry_kind='at' AND (previous.valid_until IS NULL OR previous.valid_until<=previous.effective_at))
   OR NOT whaleu_community.school_posting_policy_payload_valid(jsonb_build_object('unverifiedPostEnabled',previous.unverified_post_enabled,'unverifiedCommentEnabled',previous.unverified_comment_enabled,'unverifiedCategories',to_jsonb(previous.unverified_categories),'expiry',jsonb_build_object('kind','policy_exempt')))
   THEN RAISE EXCEPTION 'Resolve previous school policy evidence first' USING ERRCODE='23514'; END IF;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM whaleu_community.region_policy_heads WHERE region_id=NEW.region_id AND revision=NEW.revision AND revision_id=NEW.revision_id) THEN RAISE EXCEPTION 'School policy command requires its exact current head' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 IF NEW.related_command_transaction IS NOT NULL OR NEW.related_command_fingerprint IS NOT NULL OR NEW.related_enable_fingerprint IS NOT NULL THEN
  RAISE EXCEPTION 'Legacy command cannot claim related admission evidence' USING ERRCODE='23514';
 END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'School policy commands are immutable' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('whaleu:school-posting-policy-request:v1:'||NEW.actor_id::text||':'||NEW.client_request_id::text,0));
 IF EXISTS(SELECT 1 FROM whaleu_community.region_policy_cancellations WHERE actor_id=NEW.actor_id AND client_request_id=NEW.client_request_id) THEN RAISE EXCEPTION 'School policy command was cancelled' USING ERRCODE='23514'; END IF;
 SELECT * INTO authority FROM whaleu_authorization.role_grants WHERE id=NEW.grant_id FOR SHARE;
 IF NOT FOUND OR authority.account_id<>NEW.actor_id OR authority.revoked_at IS NOT NULL OR authority.valid_from>clock_timestamp() OR (authority.expires_at IS NOT NULL AND authority.expires_at<=clock_timestamp())
 OR NOT ((authority.role='super_admin' AND authority.operating_region_id IS NULL) OR (authority.role='school_admin' AND authority.operating_region_id=NEW.region_id)) THEN RAISE EXCEPTION 'School policy requires current exact authority' USING ERRCODE='23514'; END IF;
 PERFORM 1 FROM whaleu_campus.operating_regions WHERE id=NEW.region_id AND is_active FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'School region is unavailable' USING ERRCODE='23514'; END IF;
 SELECT * INTO policy FROM whaleu_community.region_policy_revisions WHERE id=NEW.revision_id AND region_id=NEW.region_id AND revision=NEW.revision;
 IF NOT FOUND OR policy.school_admin_publication_transaction IS DISTINCT FROM pg_current_xact_id() OR policy.coverage_state<>'complete' OR policy.provenance_state<>'accepted'
 OR policy.source_reference IS DISTINCT FROM 'whaleu:school-posting-command:v1:'||NEW.actor_id::text||':'||NEW.client_request_id::text
 OR policy.policy_reference IS DISTINCT FROM 'whaleu:school-posting-policy:v1' OR policy.related_sync_enabled
 OR policy.effective_at>clock_timestamp() OR policy.effective_at<transaction_timestamp()
 OR policy.unverified_post_enabled IS DISTINCT FROM (NEW.command->'policy'->>'unverifiedPostEnabled')::boolean
 OR policy.unverified_comment_enabled IS DISTINCT FROM (NEW.command->'policy'->>'unverifiedCommentEnabled')::boolean
 OR to_jsonb(policy.unverified_categories) IS DISTINCT FROM NEW.command->'policy'->'unverifiedCategories'
 OR policy.expiry_kind IS DISTINCT FROM NEW.command->'policy'->'expiry'->>'kind'
 OR (policy.expiry_kind='at' AND (policy.valid_until IS DISTINCT FROM (NEW.command->'policy'->'expiry'->>'validUntil')::timestamptz OR policy.valid_until<=clock_timestamp()))
 OR (policy.expiry_kind='policy_exempt' AND policy.valid_until IS NOT NULL)
 THEN RAISE EXCEPTION 'School policy revision must match its exact command' USING ERRCODE='23514'; END IF;
 IF NEW.previous_revision_id IS NOT NULL THEN
   SELECT * INTO previous FROM whaleu_community.region_policy_revisions WHERE id=NEW.previous_revision_id AND region_id=NEW.region_id AND revision=NEW.revision-1;
   IF NOT FOUND OR previous.coverage_state<>'complete' OR previous.provenance_state<>'accepted' OR coalesce(length(btrim(previous.source_reference)),0)=0 OR coalesce(length(btrim(previous.policy_reference)),0)=0
   OR previous.related_sync_enabled OR previous.effective_at>clock_timestamp() OR previous.expiry_kind='unknown'
   OR (previous.expiry_kind='policy_exempt' AND previous.valid_until IS NOT NULL)
   OR (previous.expiry_kind='at' AND (previous.valid_until IS NULL OR previous.valid_until<=previous.effective_at))
   OR NOT whaleu_community.school_posting_policy_payload_valid(jsonb_build_object('unverifiedPostEnabled',previous.unverified_post_enabled,'unverifiedCommentEnabled',previous.unverified_comment_enabled,'unverifiedCategories',to_jsonb(previous.unverified_categories),'expiry',jsonb_build_object('kind','policy_exempt')))
   THEN RAISE EXCEPTION 'Resolve previous school policy evidence first' USING ERRCODE='23514'; END IF;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM whaleu_community.region_policy_heads WHERE region_id=NEW.region_id AND revision=NEW.revision AND revision_id=NEW.revision_id) THEN RAISE EXCEPTION 'School policy command requires its exact current head' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION whaleu_community.school_posting_revision_complete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.school_admin_publication_transaction IS NOT NULL OR NEW.policy_reference IN ('whaleu:school-posting-policy:v1','whaleu:school-posting-policy:v2') OR NEW.source_reference LIKE 'whaleu:school-posting-command:v1:%' OR NEW.source_reference LIKE 'whaleu:school-posting-command:v2:%' THEN
   IF NEW.school_admin_publication_transaction IS DISTINCT FROM pg_current_xact_id() OR NOT EXISTS(SELECT 1 FROM whaleu_community.region_policy_commands WHERE revision_id=NEW.id AND region_id=NEW.region_id AND revision=NEW.revision)
   THEN RAISE EXCEPTION 'School policy revision requires atomic actor/grant/command audit' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NULL;
END $$;

CREATE FUNCTION whaleu_community.school_posting_v2_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE authority whaleu_authorization.role_grants; policy whaleu_community.region_policy_revisions;
BEGIN
 IF NEW.command->'version' IS DISTINCT FROM '2'::jsonb THEN RETURN NULL; END IF;
 IF NEW.related_command_transaction IS DISTINCT FROM pg_current_xact_id() THEN RAISE EXCEPTION 'School command creation transaction changed' USING ERRCODE='23514'; END IF;
 LOCK TABLE whaleu_authorization.role_grants,whaleu_campus.operating_regions,whaleu_community.region_policy_heads,whaleu_community.region_policy_revisions IN SHARE MODE NOWAIT;
 IF NEW.related_command_fingerprint IS DISTINCT FROM whaleu_community.school_posting_v2_fingerprint(NEW.grant_id,NEW.region_id) THEN
  RAISE EXCEPTION 'School command original sources changed' USING ERRCODE='23514'; END IF;
 SELECT * INTO authority FROM whaleu_authorization.role_grants WHERE id=NEW.grant_id;
 IF NOT FOUND OR authority.account_id<>NEW.actor_id OR authority.revoked_at IS NOT NULL OR authority.valid_from>clock_timestamp() OR (authority.expires_at IS NOT NULL AND authority.expires_at<=clock_timestamp())
 OR NOT ((authority.role='super_admin' AND authority.operating_region_id IS NULL) OR (authority.role='school_admin' AND authority.operating_region_id=NEW.region_id)) THEN RAISE EXCEPTION 'School command authority expired' USING ERRCODE='23514'; END IF;
 SELECT * INTO policy FROM whaleu_community.region_policy_revisions WHERE id=NEW.revision_id;
 IF NOT FOUND OR (policy.expiry_kind='at' AND policy.valid_until<=clock_timestamp()) THEN RAISE EXCEPTION 'School command policy expired' USING ERRCODE='23514'; END IF;
 IF NEW.related_enable_fingerprint IS NOT NULL THEN
  PERFORM whaleu_community.related_sync_enable_assert(NEW.region_id,NEW.related_enable_fingerprint);
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER school_posting_v2_complete AFTER INSERT ON whaleu_community.region_policy_commands DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community.school_posting_v2_complete();
-- A source statement after a v2 command is never part of that single settings
-- publication. Retain original facts even after SET CONSTRAINTS IMMEDIATE.
-- This guard does not affect legacy-only transactions or their zero-row writes.
CREATE FUNCTION whaleu_community.school_posting_v2_source_writer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM whaleu_community.region_policy_commands c WHERE c.related_command_transaction=pg_current_xact_id()
  AND (TG_TABLE_SCHEMA='whaleu_authorization' OR TG_TABLE_NAME IN ('operating_regions','region_policy_heads','region_policy_revisions') OR c.related_enable_fingerprint IS NOT NULL)) THEN
  RAISE EXCEPTION 'School v2 command retains its original sources' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END $$;
DO $$ DECLARE source text; BEGIN
 FOREACH source IN ARRAY ARRAY['whaleu_authorization.role_grants','whaleu_campus.operating_regions','whaleu_community.region_policy_heads','whaleu_community.region_policy_revisions','whaleu_campus.community_topology_heads','whaleu_campus.community_topology_snapshots','whaleu_community.related_sync_policies','whaleu_community.related_sync_policy_heads'] LOOP
  EXECUTE format('CREATE TRIGGER a000_school_posting_v2_source BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON %s FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.school_posting_v2_source_writer()',source);
 END LOOP;
END $$;

-- Only the new v4 branch uses accepted full-shape related applicability. The
-- old ordinary named-text and feedback branches are byte-for-byte preserved.
ALTER TABLE whaleu_community.text_review_requests DROP CONSTRAINT text_review_identity, DROP CONSTRAINT text_review_scope_definition;
ALTER TABLE whaleu_community.text_review_requests ADD CONSTRAINT text_review_identity CHECK(coalesce(jsonb_typeof(envelope)='object' AND envelope->>'accountId'=account_id::text AND envelope->>'purpose'=operation AND envelope->>'version' IN ('1','2','3','4'),false)),
 ADD CONSTRAINT text_review_scope_definition CHECK(coalesce((envelope->>'version'='4' AND whaleu_community.related_sync_envelope_admitted(envelope)) OR (envelope->'component'='{"kind":"none"}'::jsonb AND envelope->'trading'='null'::jsonb AND envelope->>'commentsPolicy'='open' AND (
 (envelope->>'category'<>'feedback' AND envelope->>'authorMode'='named' AND envelope->'images'='[]'::jsonb AND (envelope->>'version'='1' OR (envelope->>'version'='2' AND envelope->>'allowAnonymousDm'='false')))
 OR (envelope->>'category'='feedback' AND envelope->>'authorMode' IN ('named','anonymous') AND envelope->'scope'->'originalRegionId'='null'::jsonb AND jsonb_typeof(envelope->'images')='array' AND jsonb_array_length(envelope->'images')<=CASE WHEN operation='publish_post' THEN 9 ELSE 3 END AND ((operation='publish_post' AND envelope->>'version'='3' AND whaleu_community.feedback_definition_shape(envelope->'feedback')) OR (operation<>'publish_post' AND envelope->>'version'='1')))
 )),false));
