-- Additive test-DI-only v3 coordination. No provider/issuer or production activation.
SET LOCAL lock_timeout='5s';
SELECT pg_advisory_xact_lock(hashtextextended('whaleu:named-block-policy:v1',0));
ALTER TABLE whaleu_media.upload_intents DROP CONSTRAINT media_protocol_identity;
ALTER TABLE whaleu_media.upload_intents ADD CONSTRAINT media_protocol_identity CHECK(
 (protocol_version=1 AND request_hash IS NULL AND declared_sha256 IS NULL) OR
 (protocol_version IN (2,3) AND request_hash IS NOT NULL AND declared_sha256 IS NOT NULL));
CREATE TABLE whaleu_media.publication_batches (
 id uuid PRIMARY KEY,
 actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
 client_batch_id uuid NOT NULL,
 request_hash whaleu_media.digest NOT NULL,
 identity jsonb,
 server_scope_id uuid REFERENCES whaleu_community.media_drafts(id),
 scope_revision whaleu_media.label,
 state text NOT NULL CHECK(state IN ('fenced','editing','sealed','cancelling','terminal','consumed')),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
 ordered_member_ids jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(ordered_member_ids)='array' AND jsonb_array_length(ordered_member_ids)<=9),
 publication jsonb,
 attachment_plan_digest whaleu_media.digest,
 consumed_parent jsonb,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(created_at)),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(updated_at)),
 UNIQUE(actor_id,client_batch_id), UNIQUE(id,actor_id),
 CHECK((state='fenced' AND identity IS NULL AND server_scope_id IS NULL AND scope_revision IS NULL AND ordered_member_ids='[]' AND publication IS NULL AND attachment_plan_digest IS NULL AND consumed_parent IS NULL) OR
  (state<>'fenced' AND identity IS NOT NULL AND jsonb_typeof(identity)='object' AND identity-ARRAY['version','batchRequestId','draftId','spaceId','purpose']='{}'::jsonb AND server_scope_id IS NOT NULL AND scope_revision IS NOT NULL)),
 CHECK((publication IS NULL)=(attachment_plan_digest IS NULL)),
 CHECK((state IN ('sealed','consumed'))=(publication IS NOT NULL AND attachment_plan_digest IS NOT NULL)),
 CHECK((state='consumed')=(consumed_parent IS NOT NULL)),
 CHECK(publication IS NULL OR coalesce((jsonb_typeof(publication)='object' AND publication->>'operation'='publish_post' AND publication->>'intentHash' ~ '^[a-f0-9]{64}$' AND publication-ARRAY['clientRequestId','operation','intentHash']='{}'::jsonb AND publication->>'clientRequestId' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'),false))
);
CREATE INDEX media_batches_budget ON whaleu_media.publication_batches(actor_id,created_at);
CREATE TABLE whaleu_media.publication_batch_members (
 batch_id uuid NOT NULL, actor_id uuid NOT NULL,
 member_id uuid NOT NULL, source_slot integer NOT NULL CHECK(source_slot BETWEEN 0 AND 8),
 client_request_id uuid NOT NULL, request_hash whaleu_media.digest NOT NULL,
 declaration jsonb NOT NULL CHECK(jsonb_typeof(declaration)='object'),
 intent_id uuid NOT NULL UNIQUE, asset_id uuid UNIQUE REFERENCES whaleu_media.assets(id),
 state text NOT NULL CHECK(state IN ('live','retiring','terminal','bound')),
 added_revision bigint NOT NULL CHECK(added_revision>0), removed_revision bigint CHECK(removed_revision>=added_revision),
 PRIMARY KEY(batch_id,member_id), UNIQUE(actor_id,client_request_id),
 FOREIGN KEY(batch_id,actor_id) REFERENCES whaleu_media.publication_batches(id,actor_id),
 FOREIGN KEY(intent_id,actor_id) REFERENCES whaleu_media.upload_intents(id,actor_id),
 CHECK((state IN ('retiring','terminal'))=(removed_revision IS NOT NULL))
);
CREATE UNIQUE INDEX media_batch_live_slot ON whaleu_media.publication_batch_members(batch_id,source_slot) WHERE state IN ('live','bound');
CREATE TABLE whaleu_media.publication_batch_commands (
 batch_id uuid NOT NULL REFERENCES whaleu_media.publication_batches(id), command_id uuid NOT NULL,
 request_hash whaleu_media.digest NOT NULL, kind text NOT NULL CHECK(kind IN ('layout','seal','reopen')),
 expected_revision bigint NOT NULL CHECK(expected_revision>0), result_revision bigint NOT NULL CHECK(result_revision>0),
 result jsonb NOT NULL CHECK(jsonb_typeof(result)='object' AND octet_length(result::text)<=65536),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(created_at)),
 PRIMARY KEY(batch_id,command_id)
);
CREATE TRIGGER media_batch_identity BEFORE UPDATE OR DELETE ON whaleu_media.publication_batches FOR EACH ROW EXECUTE FUNCTION whaleu_media.guard_mutable_record('state,revision,ordered_member_ids,publication,attachment_plan_digest,consumed_parent,updated_at');
CREATE TRIGGER media_batch_member_identity BEFORE UPDATE OR DELETE ON whaleu_media.publication_batch_members FOR EACH ROW EXECUTE FUNCTION whaleu_media.guard_mutable_record('state,removed_revision,asset_id');
CREATE TRIGGER media_batch_command_immutable BEFORE UPDATE OR DELETE ON whaleu_media.publication_batch_commands FOR EACH ROW EXECUTE FUNCTION whaleu_media.immutable_record();
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['publication_batches','publication_batch_members','publication_batch_commands'] LOOP
  EXECUTE format('CREATE TRIGGER a0_media_policy_gate BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_media.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.content_policy_writer_gate()',tab);
  EXECUTE format('CREATE TRIGGER a1_media_owner_epoch BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_media.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_media.advance_owner_epoch()',tab);
  EXECUTE format('CREATE TRIGGER media_retain BEFORE TRUNCATE ON whaleu_media.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_media.immutable_record()',tab);
 END LOOP;
END $$;
CREATE FUNCTION whaleu_media.batch_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b whaleu_media.publication_batches;i whaleu_media.upload_intents;a whaleu_media.assets;
BEGIN
 IF TG_TABLE_NAME='publication_batches' THEN
  IF TG_OP='UPDATE' AND (NEW.revision<OLD.revision OR NEW.revision>OLD.revision+1 OR NEW.updated_at<OLD.updated_at OR (OLD.state IN ('fenced','terminal','consumed') AND NEW IS DISTINCT FROM OLD)) THEN
   RAISE EXCEPTION 'Terminal batch retained or invalid revision' USING ERRCODE='23514';END IF;
  IF TG_OP='INSERT' THEN
   PERFORM pg_advisory_xact_lock(hashtextextended('whaleu:media-reservation:v1:'||NEW.actor_id::text,0));
   IF (SELECT count(*) FROM whaleu_media.publication_batches WHERE actor_id=NEW.actor_id AND created_at>=date_trunc('day',clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')>=16 THEN RAISE EXCEPTION 'Daily batch budget exhausted' USING ERRCODE='23514';END IF;
  END IF;
  IF NEW.identity IS NOT NULL AND NOT coalesce(NEW.identity->'version'='1'::jsonb AND NEW.identity->>'batchRequestId'=NEW.client_batch_id::text AND NEW.identity->>'purpose'='community-post-images'
    AND (SELECT d.actor_id=NEW.actor_id AND d.client_draft_id::text=NEW.identity->>'draftId' AND d.space_id::text=NEW.identity->>'spaceId' AND d.scope_revision=NEW.scope_revision FROM whaleu_community.media_drafts d WHERE d.id=NEW.server_scope_id),false) THEN
   RAISE EXCEPTION 'Batch requires exact owner scope' USING ERRCODE='23514';END IF;
  RETURN NEW;
 ELSIF TG_TABLE_NAME='publication_batch_commands' THEN
  PERFORM id FROM whaleu_media.publication_batches WHERE id=NEW.batch_id FOR UPDATE;
  IF (SELECT count(*) FROM whaleu_media.publication_batch_commands WHERE batch_id=NEW.batch_id)>=128 THEN RAISE EXCEPTION 'Batch command budget exhausted' USING ERRCODE='23514';END IF;
  RETURN NEW;
 END IF;
 SELECT * INTO STRICT b FROM whaleu_media.publication_batches WHERE id=NEW.batch_id FOR UPDATE;
 IF TG_OP='INSERT' AND (b.state<>'editing' OR (SELECT count(*) FROM whaleu_media.publication_batch_members WHERE batch_id=NEW.batch_id)>=128) THEN RAISE EXCEPTION 'Batch membership is frozen or bounded' USING ERRCODE='23514';END IF;
 SELECT * INTO STRICT i FROM whaleu_media.upload_intents WHERE id=NEW.intent_id;
 IF (i.actor_id,i.client_request_id,i.request_hash,i.ordinal,i.resource_id,i.scope_revision,i.protocol_version)
 IS DISTINCT FROM (NEW.actor_id,NEW.client_request_id,NEW.request_hash,NEW.source_slot,b.server_scope_id,b.scope_revision,3)
 OR NEW.declaration IS DISTINCT FROM jsonb_build_object('mime',i.declared_mime,'bytes',i.declared_bytes,'sha256',i.declared_sha256) THEN
  RAISE EXCEPTION 'Member requires exact v3 immutable source' USING ERRCODE='23514';END IF;
 IF NEW.asset_id IS NOT NULL THEN
  SELECT * INTO a FROM whaleu_media.assets WHERE id=NEW.asset_id;
  IF a.intent_id IS DISTINCT FROM NEW.intent_id OR a.actor_id IS DISTINCT FROM NEW.actor_id OR a.ordinal IS DISTINCT FROM NEW.source_slot THEN RAISE EXCEPTION 'Wrong member asset' USING ERRCODE='23514';END IF;
 END IF;
 IF TG_OP='UPDATE' AND ((OLD.asset_id IS NOT NULL AND NEW.asset_id IS DISTINCT FROM OLD.asset_id) OR (OLD.state IN ('terminal','bound') AND NEW IS DISTINCT FROM OLD)) THEN RAISE EXCEPTION 'Member terminal identity retained' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER media_batch_guard BEFORE INSERT OR UPDATE ON whaleu_media.publication_batches FOR EACH ROW EXECUTE FUNCTION whaleu_media.batch_identity_guard();
CREATE TRIGGER media_batch_member_guard BEFORE INSERT OR UPDATE ON whaleu_media.publication_batch_members FOR EACH ROW EXECUTE FUNCTION whaleu_media.batch_identity_guard();
CREATE TRIGGER media_batch_command_guard BEFORE INSERT ON whaleu_media.publication_batch_commands FOR EACH ROW EXECUTE FUNCTION whaleu_media.batch_identity_guard();
CREATE FUNCTION whaleu_media.batch_set_consistent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b whaleu_media.publication_batches;bid uuid;ids jsonb;
BEGIN
 IF TG_TABLE_NAME='publication_batches' THEN bid:=NEW.id; ELSE bid:=NEW.batch_id; END IF;
 SELECT * INTO STRICT b FROM whaleu_media.publication_batches WHERE id=bid;
 IF (SELECT count(*) FROM whaleu_media.publication_batch_members WHERE batch_id=bid AND state IN ('live','bound'))>9
 OR (SELECT count(*) FROM whaleu_media.publication_batch_members WHERE batch_id=bid AND state='retiring')>9
 OR (SELECT count(*) FROM jsonb_array_elements_text(b.ordered_member_ids))<>(SELECT count(DISTINCT value) FROM jsonb_array_elements_text(b.ordered_member_ids))
 OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(b.ordered_member_ids) x LEFT JOIN whaleu_media.publication_batch_members m ON m.batch_id=bid AND m.member_id::text=x.value AND m.state IN ('live','bound') WHERE m.member_id IS NULL)
 OR EXISTS(SELECT 1 FROM whaleu_media.publication_batch_members m WHERE m.batch_id=bid AND m.state IN ('live','bound') AND NOT b.ordered_member_ids ? m.member_id::text)
 THEN RAISE EXCEPTION 'Batch ordered full-set mismatch' USING ERRCODE='23514';END IF;
 IF b.state IN ('sealed','consumed') AND (jsonb_array_length(b.ordered_member_ids)=0 OR EXISTS(SELECT 1 FROM whaleu_media.publication_batch_members WHERE batch_id=bid AND state='retiring')) THEN RAISE EXCEPTION 'Sealed batch has missing or retiring members' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER media_batch_set AFTER INSERT OR UPDATE ON whaleu_media.publication_batches DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_media.batch_set_consistent();
CREATE CONSTRAINT TRIGGER media_batch_member_set AFTER INSERT OR UPDATE ON whaleu_media.publication_batch_members DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_media.batch_set_consistent();
CREATE FUNCTION whaleu_media.v3_member_consistent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE m whaleu_media.publication_batch_members;f whaleu_media.upload_request_fences;
BEGIN
 IF NEW.protocol_version<>3 THEN RETURN NULL;END IF;
 SELECT * INTO m FROM whaleu_media.publication_batch_members WHERE intent_id=NEW.id;
 SELECT * INTO f FROM whaleu_media.upload_request_fences WHERE actor_id=NEW.actor_id AND client_request_id=NEW.client_request_id;
 IF m.intent_id IS NULL OR f.intent_id IS DISTINCT FROM NEW.id OR f.request_hash IS DISTINCT FROM NEW.request_hash THEN RAISE EXCEPTION 'V3 intent requires exact batch member and original request fence' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER media_v3_member AFTER INSERT ON whaleu_media.upload_intents DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_media.v3_member_consistent();
-- Optional SQL users use this owner-native final source fence too. Historical
-- optional migrations remain byte-identical; future captures include new sources.
CREATE OR REPLACE FUNCTION whaleu_media.try_owner_fence() RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' OR
  current_setting('max_connections')::integer+current_setting('max_prepared_transactions')::integer+
  current_setting('max_worker_processes')::integer+current_setting('max_wal_senders')::integer>=128 THEN RETURN false; END IF;
 LOCK TABLE whaleu_media.media_owner_states,
  whaleu_media.upload_intents,whaleu_media.quota_reservations,whaleu_media.object_attempts,
  whaleu_media.assets,whaleu_media.variants,whaleu_media.asset_safety_events,whaleu_media.asset_safety_heads,
  whaleu_media.scope_consumptions,whaleu_media.bindings,whaleu_media.jobs,whaleu_media.cleanup_obligations,
  whaleu_media.derived_object_attempts,whaleu_media.upload_request_fences,
  whaleu_media.upload_ingress,whaleu_media.upload_ingress_writers,
  whaleu_media.publication_batches,whaleu_media.publication_batch_members,whaleu_media.publication_batch_commands IN SHARE MODE NOWAIT;
 RETURN true;
EXCEPTION WHEN lock_not_available THEN RETURN false;
END $$;
