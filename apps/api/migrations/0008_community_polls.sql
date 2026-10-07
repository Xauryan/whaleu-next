-- Empty C2A storage only; no legacy import, synthetic grants or provider activation.
-- Text deliberately has no new-write length constraint: import reconciliation must
-- retain historical raw text rather than truncate it to the API's 255 codepoints.
CREATE TABLE whaleu_community.polls (
  id uuid PRIMARY KEY,
  post_id uuid NOT NULL UNIQUE REFERENCES whaleu_community.posts(id),
  question text NOT NULL,
  selection_mode text NOT NULL CHECK (selection_mode IN ('single','multiple')),
  deadline timestamptz CHECK (deadline IS NULL OR isfinite(deadline)),
  created_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),
  creation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id()
);
CREATE TABLE whaleu_community.poll_options (
  id uuid PRIMARY KEY,
  poll_id uuid NOT NULL REFERENCES whaleu_community.polls(id),
  position integer NOT NULL CHECK (position BETWEEN 0 AND 4),
  label text NOT NULL,
  UNIQUE(poll_id,position), UNIQUE(id,poll_id)
);
CREATE TABLE whaleu_community.poll_ballots (
  id uuid PRIMARY KEY,
  poll_id uuid NOT NULL REFERENCES whaleu_community.polls(id),
  account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
  created_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),
  creation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
  UNIQUE(poll_id,account_id), UNIQUE(id,poll_id)
);
CREATE INDEX poll_ballots_account ON whaleu_community.poll_ballots(account_id,poll_id);
CREATE TABLE whaleu_community.poll_selections (
  ballot_id uuid NOT NULL,
  poll_id uuid NOT NULL,
  option_id uuid NOT NULL,
  PRIMARY KEY(ballot_id,option_id),
  FOREIGN KEY(ballot_id,poll_id) REFERENCES whaleu_community.poll_ballots(id,poll_id),
  FOREIGN KEY(option_id,poll_id) REFERENCES whaleu_community.poll_options(id,poll_id)
);
CREATE INDEX poll_selections_option ON whaleu_community.poll_selections(poll_id,option_id);
-- Isolated request namespace. A publication UUID is not a ballot request UUID.
CREATE TABLE whaleu_community.poll_ballot_requests (
  account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
  client_request_id uuid NOT NULL,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  receipt jsonb,
  PRIMARY KEY(account_id,client_request_id),
  CHECK (receipt IS NULL OR coalesce(
    jsonb_typeof(receipt)='object' AND
    receipt->>'operation'='cast_poll_ballot' AND
    receipt->>'requestId'=client_request_id::text AND
    receipt->>'outcome' IN ('created','rejected'), false))
);
-- Ballots and their choices are immutable, including after permission loss or
-- parent soft deletion. A later transaction cannot append another selection.
CREATE FUNCTION whaleu_community.poll_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Poll record is immutable' USING ERRCODE='23514'; END $$;
CREATE TRIGGER poll_ballot_immutable BEFORE UPDATE OR DELETE ON whaleu_community.poll_ballots
  FOR EACH ROW EXECUTE FUNCTION whaleu_community.poll_immutable();
CREATE TRIGGER poll_selection_immutable BEFORE UPDATE OR DELETE ON whaleu_community.poll_selections
  FOR EACH ROW EXECUTE FUNCTION whaleu_community.poll_immutable();
CREATE TRIGGER poll_option_immutable BEFORE UPDATE OR DELETE ON whaleu_community.poll_options
  FOR EACH ROW EXECUTE FUNCTION whaleu_community.poll_immutable();
CREATE FUNCTION whaleu_community.poll_child_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE creation xid8;
BEGIN
  IF TG_TABLE_NAME='poll_options' THEN
    SELECT creation_transaction INTO creation FROM whaleu_community.polls WHERE id=NEW.poll_id;
  ELSE
    SELECT creation_transaction INTO creation FROM whaleu_community.poll_ballots WHERE id=NEW.ballot_id;
  END IF;
  IF creation IS DISTINCT FROM pg_current_xact_id() THEN
    RAISE EXCEPTION 'Poll child must be created atomically' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER poll_option_insert BEFORE INSERT ON whaleu_community.poll_options
  FOR EACH ROW EXECUTE FUNCTION whaleu_community.poll_child_insert();
CREATE TRIGGER poll_selection_insert BEFORE INSERT ON whaleu_community.poll_selections
  FOR EACH ROW EXECUTE FUNCTION whaleu_community.poll_child_insert();
CREATE FUNCTION whaleu_community.poll_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE total integer; first_position integer; last_position integer; mode text;
BEGIN
  IF TG_TABLE_NAME='polls' THEN
    SELECT count(*),min(position),max(position) INTO total,first_position,last_position
      FROM whaleu_community.poll_options WHERE poll_id=NEW.id;
    IF total < 2 OR total > 5 OR first_position<>0 OR last_position<>total-1 THEN
      RAISE EXCEPTION 'Poll options are incomplete' USING ERRCODE='23514';
    END IF;
  ELSE
    SELECT count(*) INTO total FROM whaleu_community.poll_selections WHERE ballot_id=NEW.id;
    SELECT selection_mode INTO mode FROM whaleu_community.polls WHERE id=NEW.poll_id;
    IF total < 1 OR total > 5 OR (mode='single' AND total<>1) THEN
      RAISE EXCEPTION 'Poll ballot is incomplete' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER poll_definition_complete AFTER INSERT ON whaleu_community.polls
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community.poll_complete();
CREATE CONSTRAINT TRIGGER poll_ballot_complete AFTER INSERT ON whaleu_community.poll_ballots
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community.poll_complete();
CREATE TRIGGER poll_definition_immutable BEFORE UPDATE OR DELETE ON whaleu_community.polls
  FOR EACH ROW EXECUTE FUNCTION whaleu_community.poll_immutable();
-- A request may be finalized exactly once, and no pending reservation may commit.
CREATE FUNCTION whaleu_community.poll_request_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Poll request is immutable' USING ERRCODE='23514';
  END IF;
  IF OLD.account_id IS DISTINCT FROM NEW.account_id OR
     OLD.client_request_id IS DISTINCT FROM NEW.client_request_id OR
     OLD.payload_hash IS DISTINCT FROM NEW.payload_hash OR
     OLD.receipt IS NOT NULL OR NEW.receipt IS NULL THEN
    RAISE EXCEPTION 'Poll request is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER poll_request_immutable BEFORE UPDATE OR DELETE ON whaleu_community.poll_ballot_requests
  FOR EACH ROW EXECUTE FUNCTION whaleu_community.poll_request_immutable();
CREATE FUNCTION whaleu_community.poll_request_complete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM whaleu_community.poll_ballot_requests
    WHERE account_id=NEW.account_id AND client_request_id=NEW.client_request_id AND receipt IS NULL) THEN
    RAISE EXCEPTION 'Poll request is incomplete' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER poll_request_complete AFTER INSERT ON whaleu_community.poll_ballot_requests
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community.poll_request_complete();
