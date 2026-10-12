-- Reversible author-only concealment, separate from immutable publication and
-- Review bytes. No role, source grant, history import, deletion or Media detach.
CREATE TABLE whaleu_community.post_owner_visibility_commands (
 actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
 request_id uuid NOT NULL CHECK(request_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
 post_id uuid NOT NULL REFERENCES whaleu_community.posts(id),
 session_id uuid NOT NULL REFERENCES whaleu_identity.sessions(id),
 intent_hash text NOT NULL CHECK(intent_hash ~ '^[a-f0-9]{64}$'),
 command jsonb NOT NULL CHECK(jsonb_typeof(command)='object' AND octet_length(command::text)<4096),
 receipt jsonb NOT NULL CHECK(jsonb_typeof(receipt)='object' AND octet_length(receipt::text)<4096),
 mutation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 PRIMARY KEY(actor_id,request_id),
 CHECK(intent_hash=encode(sha256(convert_to('whaleu:post-owner-visibility:v1'||chr(10)||whaleu_community.content_canonical_json(jsonb_build_object('actor',actor_id::text,'command',command)),'UTF8')),'hex')),
 CHECK((command->>'clientRequestId') IS NOT DISTINCT FROM request_id::text),
 CHECK((command->>'postId') IS NOT DISTINCT FROM post_id::text),
 CHECK((receipt->>'requestId') IS NOT DISTINCT FROM request_id::text),
 CHECK((receipt->>'postId') IS NOT DISTINCT FROM post_id::text),
 CHECK((receipt->'ownerHidden') IS NOT DISTINCT FROM (command->'ownerHidden')),
 CHECK((receipt->'expectedVersion') IS NOT DISTINCT FROM (command->'expectedVersion'))
);
CREATE TABLE whaleu_community.post_owner_visibility (
 post_id uuid PRIMARY KEY REFERENCES whaleu_community.posts(id),
 actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
 request_id uuid NOT NULL,
 owner_hidden boolean NOT NULL,
 version integer NOT NULL CHECK(version BETWEEN 1 AND 2147483647),
 updated_at timestamptz NOT NULL CHECK(isfinite(updated_at)),
 mutation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 UNIQUE(actor_id,request_id),
 FOREIGN KEY(actor_id,request_id) REFERENCES whaleu_community.post_owner_visibility_commands(actor_id,request_id) DEFERRABLE INITIALLY DEFERRED
);
-- Baseline is absence = public/version 0; deletion or resetting a head is forbidden.
CREATE FUNCTION whaleu_community.post_owner_visibility_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Owner visibility evidence cannot be removed or rewritten' USING ERRCODE='23514',CONSTRAINT='post_owner_visibility_causal';END$$;
CREATE TRIGGER post_owner_visibility_command_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON whaleu_community.post_owner_visibility_commands FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.post_owner_visibility_immutable();
CREATE TRIGGER post_owner_visibility_no_delete BEFORE DELETE OR TRUNCATE ON whaleu_community.post_owner_visibility FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.post_owner_visibility_immutable();
CREATE FUNCTION whaleu_community.post_owner_visibility_keys(value jsonb,keys text[]) RETURNS boolean LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT jsonb_typeof(value)='object' AND (SELECT count(*) FROM jsonb_object_keys(value))=cardinality(keys) AND value?&keys
$$;
CREATE FUNCTION whaleu_community.post_owner_visibility_command_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE applied boolean:=NEW.receipt->>'outcome'='applied';target whaleu_community.posts;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('whaleu:post-owner-visibility-request:v1:'||NEW.actor_id::text||':'||NEW.request_id::text,0));
 -- Every direct command uses the same request -> parent order as the API.
 SELECT * INTO target FROM whaleu_community.posts WHERE id=NEW.post_id FOR UPDATE;
 IF target.id IS NULL OR target.account_id<>NEW.actor_id OR NEW.mutation_transaction<>pg_current_xact_id() THEN RAISE EXCEPTION 'Exact original owner and transaction required' USING ERRCODE='23514',CONSTRAINT='post_owner_visibility_causal';END IF;
 IF (whaleu_community.post_owner_visibility_keys(NEW.command,ARRAY['clientRequestId','postId','ownerHidden','expectedVersion'])
   AND jsonb_typeof(NEW.command->'clientRequestId')='string' AND jsonb_typeof(NEW.command->'postId')='string'
   AND jsonb_typeof(NEW.command->'ownerHidden')='boolean' AND jsonb_typeof(NEW.command->'expectedVersion')='number'
   AND (NEW.command->>'expectedVersion')~'^(0|[1-9][0-9]{0,9})$'
   AND (NEW.command->>'expectedVersion')::numeric BETWEEN 0 AND 2147483646
   AND NEW.receipt->>'outcome' IN('applied','rejected')
   AND whaleu_community.post_owner_visibility_keys(NEW.receipt,CASE WHEN applied THEN ARRAY['requestId','postId','ownerHidden','expectedVersion','outcome','version','changed','recordedAt'] ELSE ARRAY['requestId','postId','ownerHidden','expectedVersion','outcome','code'] END)) IS DISTINCT FROM true THEN RAISE EXCEPTION 'Exact strict owner visibility command and receipt required' USING ERRCODE='23514',CONSTRAINT='post_owner_visibility_causal';END IF;
 IF applied THEN
  IF (jsonb_typeof(NEW.receipt->'version')='number' AND (NEW.receipt->>'version')::numeric=(NEW.command->>'expectedVersion')::numeric+1
    AND jsonb_typeof(NEW.receipt->'changed')='boolean' AND jsonb_typeof(NEW.receipt->'recordedAt')='string'
    AND isfinite((NEW.receipt->>'recordedAt')::timestamptz)) IS DISTINCT FROM true THEN RAISE EXCEPTION 'Exact state result required' USING ERRCODE='23514',CONSTRAINT='post_owner_visibility_causal';END IF;
 ELSIF (NEW.receipt->>'code' IN('POST_OWNER_VISIBILITY_STALE','POST_OWNER_VISIBILITY_CANCELLED','POST_OWNER_VISIBILITY_UNAVAILABLE')) IS DISTINCT FROM true THEN
  RAISE EXCEPTION 'Unknown owner visibility rejection' USING ERRCODE='23514',CONSTRAINT='post_owner_visibility_causal';
 END IF;
 RETURN NEW;
END$$;
CREATE TRIGGER post_owner_visibility_command_guard BEFORE INSERT ON whaleu_community.post_owner_visibility_commands FOR EACH ROW EXECUTE FUNCTION whaleu_community.post_owner_visibility_command_guard();
-- Restoration checks only the existing action restriction owner. No new phone,
-- affiliation, region, category or content approval is created by this command.
CREATE FUNCTION whaleu_community.require_post_owner_restore_safety(actor uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE head whaleu_safety.account_heads;
BEGIN
 SELECT * INTO head FROM whaleu_safety.account_heads WHERE account_id=actor FOR SHARE;
 IF head.account_id IS NULL OR head.block_coverage<>'complete' OR head.restriction_coverage<>'complete'
  OR head.provenance='unknown' OR head.actions_allowed IS DISTINCT FROM true
  OR (head.valid_until IS NOT NULL AND head.valid_until<=clock_timestamp())
 THEN RAISE EXCEPTION 'Current allowed Safety owner required for restoration' USING ERRCODE='23514',CONSTRAINT='post_owner_visibility_causal';END IF;
END$$;
CREATE FUNCTION whaleu_community.post_owner_visibility_state_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target whaleu_community.posts;q whaleu_community.post_owner_visibility_commands;previous_version integer:=0;previous_hidden boolean:=false;
BEGIN
 -- Includes raw writers and absent -> first hidden state. Existing canonical
 -- post SHARE readers cannot race this independent overlay's commit.
 SELECT * INTO target FROM whaleu_community.posts WHERE id=NEW.post_id FOR UPDATE;
 IF TG_OP='UPDATE' THEN
  IF (NEW.post_id,NEW.actor_id) IS DISTINCT FROM (OLD.post_id,OLD.actor_id) OR NEW.request_id=OLD.request_id THEN RAISE EXCEPTION 'Owner visibility identity and request lineage are immutable' USING ERRCODE='23514',CONSTRAINT='post_owner_visibility_causal';END IF;
  previous_version:=OLD.version;previous_hidden:=OLD.owner_hidden;
 END IF;
 IF NOT NEW.owner_hidden THEN PERFORM whaleu_community.require_post_owner_restore_safety(NEW.actor_id);END IF;
 SELECT * INTO q FROM whaleu_community.post_owner_visibility_commands WHERE actor_id=NEW.actor_id AND request_id=NEW.request_id;
 IF target.id IS NULL OR target.account_id<>NEW.actor_id OR target.deleted_at IS NOT NULL
  OR NEW.version::bigint<>previous_version::bigint+1 OR NEW.mutation_transaction<>pg_current_xact_id()
  OR NEW.updated_at>clock_timestamp() OR (TG_OP='UPDATE' AND NEW.updated_at<OLD.updated_at)
  OR q.request_id IS NULL OR q.mutation_transaction<>pg_current_xact_id() OR q.post_id<>NEW.post_id
  OR q.receipt->>'outcome' IS DISTINCT FROM 'applied'
  OR q.command->'ownerHidden' IS DISTINCT FROM to_jsonb(NEW.owner_hidden)
  OR q.command->'expectedVersion' IS DISTINCT FROM to_jsonb(previous_version)
  OR q.receipt->'version' IS DISTINCT FROM to_jsonb(NEW.version)
  OR q.receipt->'changed' IS DISTINCT FROM to_jsonb(NEW.owner_hidden<>previous_hidden)
  OR (q.receipt->>'recordedAt')::timestamptz IS DISTINCT FROM NEW.updated_at
 THEN RAISE EXCEPTION 'Exact atomic owner visibility CAS and receipt required' USING ERRCODE='23514',CONSTRAINT='post_owner_visibility_causal';END IF;
 RETURN NEW;
END$$;
CREATE TRIGGER post_owner_visibility_state_guard BEFORE INSERT OR UPDATE ON whaleu_community.post_owner_visibility FOR EACH ROW EXECUTE FUNCTION whaleu_community.post_owner_visibility_state_guard();
CREATE FUNCTION whaleu_community.post_owner_visibility_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target whaleu_community.posts;state whaleu_community.post_owner_visibility;instant timestamptz:=clock_timestamp();
BEGIN
 IF NOT EXISTS(SELECT 1 FROM whaleu_identity.sessions s JOIN whaleu_identity.accounts a ON a.id=s.account_id WHERE s.id=NEW.session_id AND s.account_id=NEW.actor_id AND a.status='active' AND s.revoked_at IS NULL AND s.absolute_expires_at>instant) THEN RAISE EXCEPTION 'Current authenticated actor session required' USING ERRCODE='23514',CONSTRAINT='post_owner_visibility_causal';END IF;
 SELECT * INTO target FROM whaleu_community.posts WHERE id=NEW.post_id;
 SELECT * INTO state FROM whaleu_community.post_owner_visibility WHERE post_id=NEW.post_id;
 IF target.id IS NULL OR target.account_id<>NEW.actor_id THEN RAISE EXCEPTION 'Exact owner required' USING ERRCODE='23514',CONSTRAINT='post_owner_visibility_causal';END IF;
 IF NEW.receipt->>'outcome'='applied' THEN
  IF (NEW.command->>'ownerHidden')::boolean=false THEN PERFORM whaleu_community.require_post_owner_restore_safety(NEW.actor_id);END IF;
  IF target.deleted_at IS NOT NULL OR state.post_id IS NULL
    OR (state.actor_id,state.request_id,state.mutation_transaction) IS DISTINCT FROM (NEW.actor_id,NEW.request_id,pg_current_xact_id())
    OR state.owner_hidden IS DISTINCT FROM (NEW.command->>'ownerHidden')::boolean
    OR state.version<>(NEW.command->>'expectedVersion')::integer+1
    OR state.updated_at IS DISTINCT FROM (NEW.receipt->>'recordedAt')::timestamptz
  THEN RAISE EXCEPTION 'Applied receipt requires exact atomic surviving state' USING ERRCODE='23514',CONSTRAINT='post_owner_visibility_causal';END IF;
 ELSE
  IF EXISTS(SELECT 1 FROM whaleu_community.post_owner_visibility WHERE actor_id=NEW.actor_id AND request_id=NEW.request_id) THEN RAISE EXCEPTION 'Rejected owner request cannot change state' USING ERRCODE='23514',CONSTRAINT='post_owner_visibility_causal';END IF;
  IF NEW.receipt->>'code'='POST_OWNER_VISIBILITY_CANCELLED' THEN RETURN NULL;END IF;
  IF NEW.receipt->>'code'='POST_OWNER_VISIBILITY_UNAVAILABLE' AND target.deleted_at IS NOT NULL THEN RETURN NULL;END IF;
  IF NEW.receipt->>'code'='POST_OWNER_VISIBILITY_STALE' AND target.deleted_at IS NULL AND coalesce(state.version,0)<>(NEW.command->>'expectedVersion')::integer THEN RETURN NULL;END IF;
  RAISE EXCEPTION 'Owner visibility rejection must be causal' USING ERRCODE='23514',CONSTRAINT='post_owner_visibility_causal';
 END IF;
 RETURN NULL;
END$$;
CREATE CONSTRAINT TRIGGER post_owner_visibility_complete AFTER INSERT ON whaleu_community.post_owner_visibility_commands DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community.post_owner_visibility_complete();
-- Reuse the canonical bounded epoch owner for count and search proof invalidation.
CREATE TRIGGER a_discovery_count_epoch BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_community.post_owner_visibility FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.advance_discovery_count_epoch();
