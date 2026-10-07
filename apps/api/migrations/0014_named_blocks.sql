-- Named privacy preferences only. No historical coverage inference, data import,
-- grants, verification, moderation issuance, provider work or automatic ban lift.
CREATE SCHEMA whaleu_safety;
CREATE TABLE whaleu_safety.account_heads (
  account_id uuid PRIMARY KEY REFERENCES whaleu_identity.accounts(id),
  block_coverage text NOT NULL CHECK(block_coverage IN ('complete','missing','conflict')),
  restriction_coverage text NOT NULL CHECK(restriction_coverage IN ('complete','missing','conflict')),
  provenance text NOT NULL CHECK(provenance IN ('native_account_creation','unknown')),
  actions_allowed boolean,
  valid_until timestamptz CHECK(valid_until IS NULL OR isfinite(valid_until)),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (restriction_coverage <> 'complete' OR actions_allowed IS NOT NULL),
  CHECK (provenance <> 'unknown' OR (block_coverage <> 'complete' AND restriction_coverage <> 'complete'))
);
CREATE TABLE whaleu_safety.blocks (
  id uuid PRIMARY KEY,
  blocker_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
  blocked_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
  active boolean NOT NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK(revision > 0),
  display_snapshot text CHECK(length(display_snapshot) <= 256),
  source_kind text NOT NULL CHECK(source_kind IN ('post','comment','reply')),
  source_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),
  updated_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),
  UNIQUE(blocker_id,blocked_id),
  UNIQUE(id,blocker_id),
  CHECK(blocker_id<>blocked_id)
);
CREATE INDEX blocks_own_active ON whaleu_safety.blocks(blocker_id,updated_at DESC,id DESC) WHERE active;
CREATE INDEX blocks_reverse_active ON whaleu_safety.blocks(blocked_id,blocker_id) WHERE active;
CREATE TABLE whaleu_safety.requests (
  account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
  client_request_id uuid NOT NULL,
  operation text NOT NULL CHECK(operation IN ('block_named','unblock_named')),
  payload_hash text NOT NULL CHECK(payload_hash ~ '^[a-f0-9]{64}$'),
  receipt jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(account_id,client_request_id),
  CHECK(receipt IS NULL OR coalesce(jsonb_typeof(receipt)='object' AND
    receipt->>'requestId'=client_request_id::text AND receipt->>'operation'=operation AND
    ((receipt->>'outcome'='applied' AND
      jsonb_typeof(receipt->'relationshipId')='string' AND receipt->>'relationshipId' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' AND
      receipt->'blocked'=to_jsonb(operation='block_named') AND
      jsonb_typeof(receipt->'revision')='string' AND receipt->>'revision' ~ '^[1-9][0-9]{0,18}$' AND
      receipt-ARRAY['requestId','operation','outcome','relationshipId','blocked','revision']='{}'::jsonb) OR
     (receipt->>'outcome'='rejected' AND jsonb_typeof(receipt->'code')='string' AND
      receipt->>'code' IN ('BLOCK_TARGET_NOT_ALLOWED','BLOCK_NOT_FOUND','BLOCK_REVISION_CONFLICT','PHONE_VERIFICATION_REQUIRED','SAFETY_ACTION_RESTRICTED','POST_NOT_FOUND','COMMENT_NOT_FOUND','REPLY_NOT_FOUND','COMMUNITY_SCOPE_UNAVAILABLE') AND
      receipt-ARRAY['requestId','operation','outcome','code']='{}'::jsonb)),false))
);
CREATE TABLE whaleu_safety.events (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
  relationship_id uuid REFERENCES whaleu_safety.blocks(id),
  kind text NOT NULL CHECK(kind IN ('native_account_created','blocked','unblocked')),
  revision bigint,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(relationship_id,account_id) REFERENCES whaleu_safety.blocks(id,blocker_id),
  CHECK(coalesce((kind='native_account_created' AND relationship_id IS NULL AND revision IS NULL) OR (kind<>'native_account_created' AND relationship_id IS NOT NULL AND revision>0),false))
);
CREATE UNIQUE INDEX safety_birth_event ON whaleu_safety.events(account_id) WHERE kind='native_account_created';
CREATE UNIQUE INDEX safety_transition_event ON whaleu_safety.events(relationship_id,revision) WHERE relationship_id IS NOT NULL;
CREATE TABLE whaleu_safety.rate_buckets (
  account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
  action text NOT NULL CHECK(action IN ('block_named','unblock_named','read_own_blocks')),
  window_start timestamptz NOT NULL,
  hits integer NOT NULL CHECK(hits BETWEEN 1 AND 1000000),
  PRIMARY KEY(account_id,action)
);
CREATE FUNCTION whaleu_safety.immutable_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Safety audit is immutable' USING ERRCODE='23514'; END $$;
CREATE TRIGGER immutable_event BEFORE UPDATE OR DELETE ON whaleu_safety.events FOR EACH ROW EXECUTE FUNCTION whaleu_safety.immutable_event();
CREATE FUNCTION whaleu_safety.receipt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR OLD.receipt IS NOT NULL OR NEW.receipt IS NULL OR
    (to_jsonb(OLD)-'receipt') IS DISTINCT FROM (to_jsonb(NEW)-'receipt') THEN
    RAISE EXCEPTION 'Safety receipt is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER receipt_guard BEFORE UPDATE OR DELETE ON whaleu_safety.requests FOR EACH ROW EXECUTE FUNCTION whaleu_safety.receipt_guard();
CREATE FUNCTION whaleu_safety.block_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Block history is retained' USING ERRCODE='23514'; END IF;
  IF (OLD.id,OLD.blocker_id,OLD.blocked_id,OLD.source_kind,OLD.source_id,OLD.created_at) IS DISTINCT FROM (NEW.id,NEW.blocker_id,NEW.blocked_id,NEW.source_kind,NEW.source_id,NEW.created_at)
    OR (NEW.active IS DISTINCT FROM OLD.active AND NEW.revision<>OLD.revision+1)
    OR (NEW.active IS NOT DISTINCT FROM OLD.active AND NEW IS DISTINCT FROM OLD) THEN
    RAISE EXCEPTION 'Block identity, creation provenance and revision are protected' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER block_guard BEFORE UPDATE OR DELETE ON whaleu_safety.blocks FOR EACH ROW EXECUTE FUNCTION whaleu_safety.block_guard();
CREATE FUNCTION whaleu_safety.request_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_request whaleu_safety.requests; current_block whaleu_safety.blocks;
BEGIN
  SELECT * INTO current_request FROM whaleu_safety.requests WHERE account_id=NEW.account_id AND client_request_id=NEW.client_request_id;
  IF current_request.receipt IS NULL THEN RAISE EXCEPTION 'Safety request is incomplete' USING ERRCODE='23514'; END IF;
  IF current_request.receipt->>'outcome'='applied' THEN
    SELECT * INTO current_block FROM whaleu_safety.blocks WHERE id=(current_request.receipt->>'relationshipId')::uuid AND blocker_id=current_request.account_id;
    IF current_block.id IS NULL OR NOT EXISTS(SELECT 1 FROM whaleu_safety.events WHERE relationship_id=current_block.id AND revision::numeric=(current_request.receipt->>'revision')::numeric AND kind=CASE WHEN current_request.operation='block_named' THEN 'blocked' ELSE 'unblocked' END) THEN
      RAISE EXCEPTION 'Safety receipt has no owned transition' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER request_complete AFTER INSERT OR UPDATE ON whaleu_safety.requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_safety.request_complete();
CREATE FUNCTION whaleu_safety.event_shape() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind='native_account_created' THEN
    IF NOT EXISTS(SELECT 1 FROM whaleu_safety.account_heads WHERE account_id=NEW.account_id AND provenance='native_account_creation') THEN
      RAISE EXCEPTION 'Safety birth lacks coverage provenance' USING ERRCODE='23514';
    END IF;
  ELSIF NOT EXISTS(SELECT 1 FROM whaleu_safety.blocks WHERE id=NEW.relationship_id AND blocker_id=NEW.account_id AND revision=NEW.revision AND active=(NEW.kind='blocked')) THEN
    RAISE EXCEPTION 'Safety audit disagrees with owned transition' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER event_shape BEFORE INSERT ON whaleu_safety.events FOR EACH ROW EXECUTE FUNCTION whaleu_safety.event_shape();
CREATE FUNCTION whaleu_safety.block_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_block whaleu_safety.blocks;
BEGIN
  SELECT * INTO current_block FROM whaleu_safety.blocks WHERE id=NEW.id;
  IF NOT EXISTS(SELECT 1 FROM whaleu_safety.events WHERE relationship_id=current_block.id AND account_id=current_block.blocker_id AND revision=current_block.revision AND kind=CASE WHEN current_block.active THEN 'blocked' ELSE 'unblocked' END) THEN
    RAISE EXCEPTION 'Safety relationship lacks transition audit' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER block_complete AFTER INSERT OR UPDATE ON whaleu_safety.blocks DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_safety.block_complete();
