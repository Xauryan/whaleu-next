-- Explicit school administrators publish into the existing regional policy
-- ledger. This adds immutable command/audit evidence, not another policy store.
-- No roles, catalog data, defaults, legacy acceptance or external provider added.
SET LOCAL lock_timeout='5s';
ALTER TABLE whaleu_community.region_policy_revisions ADD COLUMN school_admin_publication_transaction xid8;

CREATE FUNCTION whaleu_community.school_posting_policy_payload_valid(value jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE categories jsonb; expiry jsonb; until_time timestamptz;
BEGIN
 IF jsonb_typeof(value)<>'object' OR value-ARRAY['unverifiedPostEnabled','unverifiedCommentEnabled','unverifiedCategories','expiry']<>'{}'::jsonb
 OR jsonb_typeof(value->'unverifiedPostEnabled') IS DISTINCT FROM 'boolean' OR jsonb_typeof(value->'unverifiedCommentEnabled') IS DISTINCT FROM 'boolean'
 OR jsonb_typeof(value->'unverifiedCategories') IS DISTINCT FROM 'array' OR jsonb_typeof(value->'expiry') IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 categories:=value->'unverifiedCategories'; expiry:=value->'expiry';
 IF jsonb_array_length(categories)>9 OR EXISTS(SELECT 1 FROM jsonb_array_elements(categories) item WHERE jsonb_typeof(item)<>'string' OR item#>>'{}' NOT IN ('discussion','confession','companions','pets','internships','scenery','dorms','research','deep_sea'))
 OR (SELECT count(DISTINCT item) FROM jsonb_array_elements(categories) item)<>jsonb_array_length(categories) THEN RETURN false; END IF;
 IF expiry=jsonb_build_object('kind','policy_exempt') THEN RETURN true; END IF;
 IF expiry->>'kind' IS DISTINCT FROM 'at' OR expiry-ARRAY['kind','validUntil']<>'{}'::jsonb OR jsonb_typeof(expiry->'validUntil') IS DISTINCT FROM 'string'
 OR expiry->>'validUntil' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?Z$' THEN RETURN false; END IF;
 until_time:=(expiry->>'validUntil')::timestamptz;
 RETURN isfinite(until_time);
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
CREATE TABLE whaleu_community.region_policy_commands (
 actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
 client_request_id uuid NOT NULL,
 grant_id uuid NOT NULL REFERENCES whaleu_authorization.role_grants(id),
 region_id uuid NOT NULL REFERENCES whaleu_campus.operating_regions(id),
 previous_revision_id uuid,
 revision_id uuid NOT NULL UNIQUE,
 revision integer NOT NULL CHECK(revision>0),
 command jsonb NOT NULL,
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 receipt jsonb NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(recorded_at)),
 PRIMARY KEY(actor_id,client_request_id),
 FOREIGN KEY(revision_id,region_id,revision) REFERENCES whaleu_community.region_policy_revisions(id,region_id,revision),
 FOREIGN KEY(previous_revision_id) REFERENCES whaleu_community.region_policy_revisions(id),
 CHECK((revision=1 AND previous_revision_id IS NULL) OR (revision>1 AND previous_revision_id IS NOT NULL)),
 CHECK(coalesce(jsonb_typeof(command)='object' AND command-ARRAY['clientRequestId','expectedRevision','policy']='{}'::jsonb AND command->>'clientRequestId'=client_request_id::text
   AND client_request_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
   AND jsonb_typeof(command->'expectedRevision')='number' AND command->>'expectedRevision' ~ '^(0|[1-9][0-9]*)$' AND (command->>'expectedRevision')::numeric=revision-1
   AND whaleu_community.school_posting_policy_payload_valid(command->'policy'),false)),
 CHECK(octet_length(command::text)<=4096),
 CHECK(request_hash=encode(sha256(convert_to('whaleu-school-posting-policy-command:v1'||chr(10)||whaleu_community.content_canonical_json(jsonb_build_object('actorId',actor_id::text,'regionId',region_id::text,'command',command)),'UTF8')),'hex')),
 CHECK(receipt=jsonb_build_object('requestId',client_request_id::text,'requestHash',request_hash,'regionId',region_id::text,'revision',revision,'revisionId',revision_id::text,'outcome','saved'))
);
CREATE TABLE whaleu_community.region_policy_cancellations (
 actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
 client_request_id uuid NOT NULL,
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(recorded_at)),
 PRIMARY KEY(actor_id,client_request_id)
);
CREATE FUNCTION whaleu_community.school_posting_command_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE authority whaleu_authorization.role_grants; policy whaleu_community.region_policy_revisions; previous whaleu_community.region_policy_revisions;
BEGIN
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
CREATE TRIGGER school_posting_command_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_community.region_policy_commands FOR EACH ROW EXECUTE FUNCTION whaleu_community.school_posting_command_guard();
-- Obtain the common policy gate at statement entry, before any command/grant row.
CREATE TRIGGER school_posting_command_writer_gate BEFORE INSERT OR UPDATE OR DELETE ON whaleu_community.region_policy_commands FOR EACH STATEMENT EXECUTE FUNCTION whaleu_campus.community_scope_writer_gate();

CREATE FUNCTION whaleu_community.school_posting_revision_complete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.school_admin_publication_transaction IS NOT NULL OR NEW.policy_reference='whaleu:school-posting-policy:v1' OR NEW.source_reference LIKE 'whaleu:school-posting-command:v1:%' THEN
   IF NEW.school_admin_publication_transaction IS DISTINCT FROM pg_current_xact_id() OR NOT EXISTS(SELECT 1 FROM whaleu_community.region_policy_commands WHERE revision_id=NEW.id AND region_id=NEW.region_id AND revision=NEW.revision)
   THEN RAISE EXCEPTION 'School policy revision requires atomic actor/grant/command audit' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER school_posting_revision_complete AFTER INSERT ON whaleu_community.region_policy_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community.school_posting_revision_complete();
CREATE FUNCTION whaleu_community.school_posting_cancellation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'School policy cancellation history is immutable' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('whaleu:school-posting-policy-request:v1:'||NEW.actor_id::text||':'||NEW.client_request_id::text,0));
 IF EXISTS(SELECT 1 FROM whaleu_community.region_policy_commands WHERE actor_id=NEW.actor_id AND client_request_id=NEW.client_request_id) THEN RAISE EXCEPTION 'Saved school policy cannot be cancelled' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER school_posting_cancellation_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_community.region_policy_cancellations FOR EACH ROW EXECUTE FUNCTION whaleu_community.school_posting_cancellation_guard();
CREATE FUNCTION whaleu_community.school_posting_retain_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'School policy audit history is retained' USING ERRCODE='23514'; END $$;
CREATE TRIGGER school_posting_retain_commands BEFORE TRUNCATE ON whaleu_community.region_policy_commands FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.school_posting_retain_audit();
CREATE TRIGGER school_posting_retain_cancellations BEFORE TRUNCATE ON whaleu_community.region_policy_cancellations FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.school_posting_retain_audit();
