-- Reviewed source opt-in and exact private-message Safety integration. No production grants.
SET LOCAL lock_timeout='5s';
SELECT pg_advisory_xact_lock(hashtextextended('whaleu:named-block-policy:v1',0));
-- Community-owned additive fragment for integration into migration 0061.
-- Historical posts remain Review v1 with UNKNOWN (NULL) opt-in provenance.
-- Content version is still 1: this evolves the publication envelope, not edits.
ALTER TABLE whaleu_community.posts
  ADD COLUMN publication_envelope_version integer NOT NULL DEFAULT 1,
  ADD COLUMN allow_anonymous_dm boolean;
ALTER TABLE whaleu_community.posts
  ADD CONSTRAINT post_anonymous_dm_definition CHECK (
    (publication_envelope_version=1 AND allow_anonymous_dm IS NULL) OR
    (publication_envelope_version=2 AND author_mode='named' AND allow_anonymous_dm IS NOT NULL)
  );

-- Only the three prior envelope/version/digest checks change. Keep policy,
-- issuance, timing, provenance and immutable-evidence constraints untouched.
DO $$
DECLARE item record;
BEGIN
  FOR item IN
    SELECT conname FROM pg_constraint
    WHERE conrelid='whaleu_community.content_approval_decisions'::regclass
      AND contype='c' AND pg_get_constraintdef(oid) LIKE '%envelope%'
  LOOP
    EXECUTE format('ALTER TABLE whaleu_community.content_approval_decisions DROP CONSTRAINT %I',item.conname);
  END LOOP;
END $$;
ALTER TABLE whaleu_community.content_approval_decisions
  ADD CONSTRAINT content_approval_envelope_version CHECK(envelope_version IN (1,2)),
  ADD CONSTRAINT content_approval_envelope_identity CHECK(coalesce(
    jsonb_typeof(envelope)='object' AND envelope->>'version'=envelope_version::text AND
    envelope->>'accountId'=account_id::text AND envelope->>'purpose'=operation AND
    jsonb_typeof(envelope->'scope')='object' AND envelope->'scope'->>'sync'='none' AND
    ((envelope_version=1 AND NOT envelope ? 'allowAnonymousDm') OR
     (envelope_version=2 AND operation='publish_post' AND envelope->>'authorMode'='named' AND
      jsonb_typeof(envelope->'allowAnonymousDm')='boolean' AND
      envelope->'postId'='null'::jsonb AND envelope->'rootCommentId'='null'::jsonb AND envelope->'targetReplyId'='null'::jsonb)),false)),
  ADD CONSTRAINT content_approval_envelope_digest CHECK(
    digest=encode(sha256(convert_to('whaleu-content-approval:v'||envelope_version::text||chr(10)||whaleu_community.content_canonical_json(envelope),'UTF8')),'hex')
  );
ALTER TABLE whaleu_community.content_approval_bindings
  DROP CONSTRAINT content_approval_bindings_envelope_version_check,
  ADD CONSTRAINT content_binding_envelope_version CHECK(
    envelope_version IN (1,2) AND envelope->>'version'=envelope_version::text AND
    (envelope_version=1 OR (content_kind='post' AND operation='publish_post'))
  );

-- Source option and envelope generation are immutable from publication onward;
-- no historical post can later acquire consent without a new exact publication.
CREATE FUNCTION whaleu_community.post_dm_definition_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.publication_envelope_version IS DISTINCT FROM NEW.publication_envelope_version OR
     OLD.allow_anonymous_dm IS DISTINCT FROM NEW.allow_anonymous_dm THEN
    RAISE EXCEPTION 'Published anonymous DM provenance is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER post_dm_definition_immutable BEFORE UPDATE ON whaleu_community.posts
FOR EACH ROW EXECUTE FUNCTION whaleu_community.post_dm_definition_immutable();

-- Supplements the existing complete publication identity/creation transaction
-- binding validator, which is retained unchanged.
CREATE FUNCTION whaleu_community.content_binding_dm_definition() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE post whaleu_community.posts;
BEGIN
  IF NEW.content_kind='post' THEN
    SELECT * INTO post FROM whaleu_community.posts WHERE id=NEW.content_id FOR SHARE;
    IF NOT FOUND OR post.publication_envelope_version IS DISTINCT FROM NEW.envelope_version OR
      (NEW.envelope_version=1 AND (post.allow_anonymous_dm IS NOT NULL OR NEW.envelope ? 'allowAnonymousDm')) OR
      (NEW.envelope_version=2 AND (post.author_mode<>'named' OR
       jsonb_typeof(NEW.envelope->'allowAnonymousDm') IS DISTINCT FROM 'boolean' OR
       to_jsonb(post.allow_anonymous_dm) IS DISTINCT FROM NEW.envelope->'allowAnonymousDm')) THEN
      RAISE EXCEPTION 'Anonymous DM reviewed definition mismatch' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.envelope_version<>1 OR NEW.envelope ? 'allowAnonymousDm' THEN
    RAISE EXCEPTION 'Anonymous DM consent requires a named post' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER content_binding_dm_definition BEFORE INSERT ON whaleu_community.content_approval_bindings
FOR EACH ROW EXECUTE FUNCTION whaleu_community.content_binding_dm_definition();

-- A v2 post cannot commit a naked option without its immutable exact binding.
CREATE FUNCTION whaleu_community.post_dm_definition_bound() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.publication_envelope_version=2 AND NOT EXISTS (
    SELECT 1 FROM whaleu_community.content_approval_bindings b
    WHERE b.content_kind='post' AND b.content_id=NEW.id AND b.content_version=1 AND
      b.envelope_version=2 AND b.account_id=NEW.account_id AND
      b.envelope->>'authorMode'='named' AND
      b.envelope->'allowAnonymousDm'=to_jsonb(NEW.allow_anonymous_dm)
  ) THEN
    RAISE EXCEPTION 'Anonymous DM option has no exact reviewed publication' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER post_dm_definition_bound AFTER INSERT ON whaleu_community.posts
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION whaleu_community.post_dm_definition_bound();
-- A retained named DM participant is an eligible Safety source even when its
-- original post/profile is deleted. source_id is the original DM command ID.
ALTER TABLE whaleu_safety.blocks DROP CONSTRAINT blocks_source_kind_check;
ALTER TABLE whaleu_safety.blocks ADD CONSTRAINT blocks_source_kind_check CHECK(source_kind IN ('post','comment','reply','profile','private_message'));
CREATE TABLE whaleu_safety.dm_block_bindings (
 account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),request_id uuid NOT NULL,
 target_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),relationship_id uuid NOT NULL,
 revision bigint NOT NULL CHECK(revision>0),bound_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(bound_at)),
 mutation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 PRIMARY KEY(account_id,request_id),
 FOREIGN KEY(relationship_id,account_id) REFERENCES whaleu_safety.blocks(id,blocker_id),
 FOREIGN KEY(account_id,request_id) REFERENCES whaleu_messaging.requests(account_id,request_id),
 CHECK(account_id<>target_id)
);
CREATE TRIGGER dm_block_binding_immutable BEFORE UPDATE OR DELETE ON whaleu_safety.dm_block_bindings FOR EACH ROW EXECUTE FUNCTION whaleu_safety.immutable_event();
CREATE TRIGGER dm_block_binding_retain BEFORE TRUNCATE ON whaleu_safety.dm_block_bindings FOR EACH STATEMENT EXECUTE FUNCTION whaleu_safety.immutable_event();
CREATE FUNCTION whaleu_safety.dm_block_binding_causal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q whaleu_messaging.requests; t whaleu_messaging.transitions; b whaleu_safety.blocks;
BEGIN
 SELECT * INTO q FROM whaleu_messaging.requests WHERE account_id=NEW.account_id AND request_id=NEW.request_id;
 SELECT * INTO t FROM whaleu_messaging.transitions WHERE account_id=NEW.account_id AND request_id=NEW.request_id;
 SELECT * INTO b FROM whaleu_safety.blocks WHERE id=NEW.relationship_id;
 IF q.operation IS DISTINCT FROM 'block' OR coalesce(q.receipt->>'outcome' NOT IN ('applied','noop'),true)
 OR t.mutation_transaction IS DISTINCT FROM pg_current_xact_id() OR NEW.mutation_transaction IS DISTINCT FROM pg_current_xact_id()
 OR b.blocker_id IS DISTINCT FROM NEW.account_id OR b.blocked_id IS DISTINCT FROM NEW.target_id OR NOT coalesce(b.active,false) OR b.revision IS DISTINCT FROM NEW.revision
 OR NOT EXISTS(SELECT 1 FROM whaleu_messaging.participants p JOIN whaleu_messaging.participants a ON a.conversation_id=p.conversation_id AND a.account_id=NEW.account_id WHERE p.conversation_id=t.conversation_id AND p.account_id=NEW.target_id AND p.mode='named')
 THEN RAISE EXCEPTION 'DM named block lacks exact participant command' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER dm_block_binding_causal AFTER INSERT ON whaleu_safety.dm_block_bindings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_safety.dm_block_binding_causal();

-- Every local latch retains the original successful command, including after
-- later noop commands or unrelated global relationship changes.
CREATE FUNCTION whaleu_messaging.local_block_origin(cid uuid,actor uuid,origin uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS (
  SELECT 1 FROM whaleu_messaging.requests q
  JOIN whaleu_messaging.transitions t ON t.account_id=q.account_id AND t.request_id=q.request_id
  JOIN whaleu_messaging.conversations c ON c.id=t.conversation_id
  WHERE q.account_id=actor AND q.request_id=origin AND q.operation='block' AND q.receipt->>'outcome'='applied'
   AND t.conversation_id=cid AND t.message_id IS NULL AND t.receipt=q.receipt AND q.receipt->>'conversationId'=cid::text
   AND (c.mode0='anonymous' OR c.mode1='anonymous')
   AND q.intent_hash=encode(sha256(convert_to('whaleu:dm:v1'||chr(10)||whaleu_community.content_canonical_json(jsonb_build_object('operation','block','intent',jsonb_build_object('conversationId',cid,'clientRequestId',origin))),'UTF8')),'hex')
 )
$$;
CREATE FUNCTION whaleu_messaging.local_block_causal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p whaleu_messaging.participants;
BEGIN
 SELECT * INTO p FROM whaleu_messaging.participants WHERE conversation_id=NEW.conversation_id AND slot=NEW.slot;
 IF p.blocked_request_id IS NOT NULL AND NOT whaleu_messaging.local_block_origin(p.conversation_id,p.account_id,p.blocked_request_id) THEN
  RAISE EXCEPTION 'DM local block lacks exact originating command' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER dm_local_block_causal AFTER INSERT OR UPDATE ON whaleu_messaging.participants DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_messaging.local_block_causal();

-- The reverse implication is required too: a successful receipt cannot claim a
-- block while omitting its Safety binding or its independent conversation latch.
-- Check both applied and noop commands against retained immutable peer modes.
CREATE FUNCTION whaleu_messaging.block_request_causal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q whaleu_messaging.requests; t whaleu_messaging.transitions;
 self_participant whaleu_messaging.participants; peer_participant whaleu_messaging.participants;
BEGIN
 SELECT * INTO q FROM whaleu_messaging.requests WHERE account_id=NEW.account_id AND request_id=NEW.request_id;
 IF q.operation IS DISTINCT FROM 'block' OR coalesce(q.receipt->>'outcome' NOT IN ('applied','noop'),true) THEN RETURN NULL; END IF;
 SELECT * INTO t FROM whaleu_messaging.transitions WHERE account_id=q.account_id AND request_id=q.request_id;
 SELECT * INTO self_participant FROM whaleu_messaging.participants WHERE conversation_id=t.conversation_id AND account_id=q.account_id;
 SELECT * INTO peer_participant FROM whaleu_messaging.participants WHERE conversation_id=t.conversation_id AND slot<>self_participant.slot;
 IF t.mutation_transaction IS DISTINCT FROM pg_current_xact_id() OR t.receipt IS DISTINCT FROM q.receipt OR t.message_id IS NOT NULL
 OR self_participant.account_id IS NULL OR peer_participant.account_id IS NULL THEN
  RAISE EXCEPTION 'DM block receipt lacks exact participant transition' USING ERRCODE='23514';
 END IF;
 IF self_participant.mode='anonymous' OR peer_participant.mode='anonymous' THEN
  IF self_participant.blocked_at IS NULL THEN
   RAISE EXCEPTION 'DM block receipt has no conversation latch' USING ERRCODE='23514';
  END IF;
  IF NOT whaleu_messaging.local_block_origin(t.conversation_id,q.account_id,self_participant.blocked_request_id) THEN
   RAISE EXCEPTION 'DM local block lacks exact originating command' USING ERRCODE='23514';
  END IF;
  IF peer_participant.mode='anonymous' AND (q.receipt->>'outcome'='applied') IS DISTINCT FROM (self_participant.blocked_request_id=q.request_id) THEN
   RAISE EXCEPTION 'DM block receipt does not match local latch transition' USING ERRCODE='23514';
  END IF;
 END IF;
 IF peer_participant.mode='named' AND NOT EXISTS (
  SELECT 1 FROM whaleu_safety.dm_block_bindings d JOIN whaleu_safety.blocks b ON b.id=d.relationship_id
  WHERE d.account_id=q.account_id AND d.request_id=q.request_id AND d.target_id=peer_participant.account_id
   AND d.mutation_transaction=pg_current_xact_id() AND b.blocker_id=q.account_id AND b.blocked_id=peer_participant.account_id
   AND b.active AND b.revision=d.revision
 ) THEN
  RAISE EXCEPTION 'DM block receipt has no named peer binding' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER dm_block_request_causal AFTER INSERT OR UPDATE ON whaleu_messaging.requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_messaging.block_request_causal();
