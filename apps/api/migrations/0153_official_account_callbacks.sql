-- Isolated synthetic-only owner. No historical enrollment, live key or destination.
CREATE SCHEMA whaleu_official_callbacks;
CREATE TABLE whaleu_official_callbacks.accounts (
  account_ref uuid PRIMARY KEY,
  mini_app_ref uuid NOT NULL,
  union_namespace uuid NOT NULL,
  revision text NOT NULL CHECK (revision ~ '^[0-9a-f]{64}$'),
  deleted boolean NOT NULL DEFAULT false
);
CREATE TABLE whaleu_official_callbacks.registrations (
  registration_id uuid PRIMARY KEY,
  account_ref uuid NOT NULL REFERENCES whaleu_official_callbacks.accounts(account_ref)
);
CREATE TABLE whaleu_official_callbacks.epochs (
  registration_id uuid NOT NULL REFERENCES whaleu_official_callbacks.registrations(registration_id),
  epoch integer NOT NULL CHECK (epoch IN (1,2)),
  valid_from timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (isfinite(expires_at)),
  PRIMARY KEY (registration_id,epoch), CHECK(valid_from < expires_at)
);
CREATE TABLE whaleu_official_callbacks.rate_buckets (
  bucket text PRIMARY KEY,
  tokens double precision NOT NULL CHECK(tokens >= 0 AND tokens <= 10),
  sampled_at timestamptz NOT NULL
);
CREATE TABLE whaleu_official_callbacks.events (
  account_ref uuid NOT NULL REFERENCES whaleu_official_callbacks.accounts(account_ref),
  event_id uuid NOT NULL,
  official_subject text NOT NULL CHECK(official_subject ~ '^synthetic:official:[0-9a-f-]{36}$'),
  kind text NOT NULL CHECK(kind IN ('subscribe','unsubscribe')),
  sequence bigint NOT NULL CHECK(sequence BETWEEN 1 AND 9007199254740991),
  occurred_at bigint NOT NULL CHECK(occurred_at >= 0),
  logical_hash text NOT NULL CHECK(logical_hash ~ '^[0-9a-f]{64}$'),
  semantic_hash text NOT NULL CHECK(semantic_hash ~ '^[0-9a-f]{64}$'),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(account_ref,event_id)
);
CREATE TABLE whaleu_official_callbacks.admissions (
  account_ref uuid NOT NULL, event_id uuid NOT NULL,
  registration_id uuid NOT NULL REFERENCES whaleu_official_callbacks.registrations(registration_id),
  epoch integer NOT NULL CHECK(epoch IN (1,2)),
  PRIMARY KEY(account_ref,event_id,registration_id,epoch),
  FOREIGN KEY(account_ref,event_id) REFERENCES whaleu_official_callbacks.events(account_ref,event_id)
);
CREATE TABLE whaleu_official_callbacks.jobs (
  account_ref uuid NOT NULL, event_id uuid NOT NULL,
  outcome text CHECK(outcome IN ('applied','ignored_ordered','duplicate_semantic','quarantined','account_deleted')),
  processed_at timestamptz,
  PRIMARY KEY(account_ref,event_id),
  FOREIGN KEY(account_ref,event_id) REFERENCES whaleu_official_callbacks.events(account_ref,event_id),
  CHECK((outcome IS NULL) = (processed_at IS NULL))
);
CREATE INDEX official_callbacks_pending ON whaleu_official_callbacks.jobs(account_ref,event_id) WHERE processed_at IS NULL;
CREATE TABLE whaleu_official_callbacks.conflicts (
  account_ref uuid NOT NULL, event_id uuid NOT NULL, conflict_hash text NOT NULL CHECK(conflict_hash ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY(account_ref,event_id,conflict_hash),
  FOREIGN KEY(account_ref,event_id) REFERENCES whaleu_official_callbacks.events(account_ref,event_id)
);
CREATE TABLE whaleu_official_callbacks.follow (
  account_ref uuid NOT NULL REFERENCES whaleu_official_callbacks.accounts(account_ref),
  official_subject text NOT NULL,
  latest_sequence bigint NOT NULL DEFAULT 0 CHECK(latest_sequence BETWEEN 0 AND 9007199254740991),
  latest_semantic_hash text,
  latest_logical_hash text,
  state text NOT NULL DEFAULT 'unknown' CHECK(state IN ('unknown','followed','unfollowed')),
  generation bigint NOT NULL DEFAULT 0,
  binding_revision bigint NOT NULL DEFAULT 0,
  revocation_watermark bigint NOT NULL DEFAULT 0 CHECK(revocation_watermark BETWEEN 0 AND 9007199254740991),
  mapping_state text NOT NULL DEFAULT 'unknown' CHECK(mapping_state IN ('unknown','accepted','revoked','quarantined')),
  local_account_ref uuid,
  union_subject text,
  mini_subject text,
  proof_id uuid,
  mini_assertion_ref uuid,
  proof_expires_at timestamptz,
  PRIMARY KEY(account_ref,official_subject)
);
CREATE INDEX official_callbacks_local ON whaleu_official_callbacks.follow(account_ref,local_account_ref);
CREATE INDEX official_callbacks_union ON whaleu_official_callbacks.follow(account_ref,union_subject);
CREATE INDEX official_callbacks_mini ON whaleu_official_callbacks.follow(account_ref,mini_subject);
CREATE TABLE whaleu_official_callbacks.mini_assertions (
  assertion_ref uuid PRIMARY KEY,
  mini_app_ref uuid NOT NULL, mini_subject text NOT NULL,
  local_account_ref uuid NOT NULL,
  identity_binding_version text NOT NULL CHECK(identity_binding_version ~ '^[0-9]+$'),
  union_namespace uuid NOT NULL, union_subject text NOT NULL,
  revoked boolean NOT NULL DEFAULT false
);
CREATE TABLE whaleu_official_callbacks.synthetic_acceptances (
  acceptance_id uuid PRIMARY KEY,
  account_ref uuid NOT NULL, official_subject text NOT NULL,
  local_account_ref uuid NOT NULL, purpose text NOT NULL CHECK(purpose='synthetic-notification-v1'),
  follow_generation bigint NOT NULL, binding_revision bigint NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(account_ref,official_subject) REFERENCES whaleu_official_callbacks.follow(account_ref,official_subject)
);
-- Tombstones cannot be cleared by rotation or ordinary payload retention.
CREATE FUNCTION whaleu_official_callbacks.immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'immutable synthetic callback evidence'; END $$;
CREATE TRIGGER official_callbacks_events_immutable BEFORE UPDATE OR DELETE ON whaleu_official_callbacks.events FOR EACH ROW EXECUTE FUNCTION whaleu_official_callbacks.immutable();
CREATE TRIGGER official_callbacks_admissions_immutable BEFORE UPDATE OR DELETE ON whaleu_official_callbacks.admissions FOR EACH ROW EXECUTE FUNCTION whaleu_official_callbacks.immutable();
CREATE TRIGGER official_callbacks_conflicts_immutable BEFORE UPDATE OR DELETE ON whaleu_official_callbacks.conflicts FOR EACH ROW EXECUTE FUNCTION whaleu_official_callbacks.immutable();
CREATE TRIGGER official_callbacks_registration_immutable BEFORE UPDATE OR DELETE ON whaleu_official_callbacks.registrations FOR EACH ROW EXECUTE FUNCTION whaleu_official_callbacks.immutable();

CREATE TABLE whaleu_official_callbacks.mapping_proofs (
  proof_id uuid PRIMARY KEY, account_ref uuid NOT NULL, official_subject text NOT NULL,
  assertion_ref uuid NOT NULL, assertion_hash text NOT NULL, registry_revision text NOT NULL,
  expires_at timestamptz NOT NULL, proof_hash text NOT NULL CHECK(proof_hash ~ '^[0-9a-f]{64}$'),
  FOREIGN KEY(account_ref,official_subject) REFERENCES whaleu_official_callbacks.follow(account_ref,official_subject)
);
CREATE TRIGGER official_callbacks_proofs_immutable BEFORE UPDATE OR DELETE ON whaleu_official_callbacks.mapping_proofs FOR EACH ROW EXECUTE FUNCTION whaleu_official_callbacks.immutable();
CREATE TRIGGER official_callbacks_epochs_immutable BEFORE UPDATE OR DELETE ON whaleu_official_callbacks.epochs FOR EACH ROW EXECUTE FUNCTION whaleu_official_callbacks.immutable();
CREATE TRIGGER official_callbacks_acceptances_immutable BEFORE UPDATE OR DELETE ON whaleu_official_callbacks.synthetic_acceptances FOR EACH ROW EXECUTE FUNCTION whaleu_official_callbacks.immutable();
CREATE FUNCTION whaleu_official_callbacks.guard_account() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'callback account tombstone required'; END IF;
  IF NEW.account_ref<>OLD.account_ref OR NEW.mini_app_ref<>OLD.mini_app_ref OR NEW.union_namespace<>OLD.union_namespace OR NEW.revision<>OLD.revision OR (OLD.deleted AND NOT NEW.deleted) THEN
    RAISE EXCEPTION 'immutable callback account registration';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER official_callbacks_account_guard BEFORE UPDATE OR DELETE ON whaleu_official_callbacks.accounts FOR EACH ROW EXECUTE FUNCTION whaleu_official_callbacks.guard_account();
CREATE FUNCTION whaleu_official_callbacks.guard_follow() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'callback follow tombstone required'; END IF;
  IF NEW.account_ref<>OLD.account_ref OR NEW.official_subject<>OLD.official_subject OR NEW.latest_sequence<OLD.latest_sequence OR NEW.revocation_watermark<OLD.revocation_watermark OR NEW.generation<OLD.generation OR NEW.binding_revision<OLD.binding_revision THEN
    RAISE EXCEPTION 'callback watermark rollback';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER official_callbacks_follow_guard BEFORE UPDATE OR DELETE ON whaleu_official_callbacks.follow FOR EACH ROW EXECUTE FUNCTION whaleu_official_callbacks.guard_follow();
CREATE FUNCTION whaleu_official_callbacks.guard_job() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR OLD.processed_at IS NOT NULL THEN RAISE EXCEPTION 'immutable callback processing receipt'; END IF;
  IF NEW.account_ref<>OLD.account_ref OR NEW.event_id<>OLD.event_id THEN RAISE EXCEPTION 'immutable callback obligation'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER official_callbacks_job_guard BEFORE UPDATE OR DELETE ON whaleu_official_callbacks.jobs FOR EACH ROW EXECUTE FUNCTION whaleu_official_callbacks.guard_job();

CREATE FUNCTION whaleu_official_callbacks.guard_mini_assertion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'mini assertion tombstone required'; END IF;
  IF (to_jsonb(NEW)-'revoked')<>(to_jsonb(OLD)-'revoked') OR (OLD.revoked AND NOT NEW.revoked) THEN RAISE EXCEPTION 'immutable mini assertion'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER official_callbacks_assertion_guard BEFORE UPDATE OR DELETE ON whaleu_official_callbacks.mini_assertions FOR EACH ROW EXECUTE FUNCTION whaleu_official_callbacks.guard_mini_assertion();
CREATE FUNCTION whaleu_official_callbacks.guard_epoch_overlap() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE stable uuid;
BEGIN
  SELECT a.account_ref INTO stable FROM whaleu_official_callbacks.accounts a
    JOIN whaleu_official_callbacks.registrations r USING(account_ref)
    WHERE r.registration_id=NEW.registration_id FOR UPDATE OF a;
  IF EXISTS(SELECT 1 FROM whaleu_official_callbacks.epochs e
    JOIN whaleu_official_callbacks.registrations r USING(registration_id)
    WHERE r.account_ref=stable AND e.epoch<>NEW.epoch AND
    least(e.expires_at,NEW.expires_at)-greatest(e.valid_from,NEW.valid_from)>interval '600 seconds') THEN
    RAISE EXCEPTION 'synthetic callback key overlap exceeds profile';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER official_callbacks_epoch_overlap BEFORE INSERT ON whaleu_official_callbacks.epochs FOR EACH ROW EXECUTE FUNCTION whaleu_official_callbacks.guard_epoch_overlap();

-- Causal callback/mapping tombstones cannot be reset independently. Isolated test
-- teardown drops the entire owned schema; replay never gets a fresh empty ledger.
DO $$ DECLARE t record; BEGIN
 FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='whaleu_official_callbacks' LOOP
  EXECUTE format('CREATE TRIGGER official_callback_retain BEFORE TRUNCATE ON whaleu_official_callbacks.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_media.immutable_record()',t.tablename);
 END LOOP;
END $$;
