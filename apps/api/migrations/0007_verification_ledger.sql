-- Empty local canonical ledger only. No source import, provider, role grant or seed.
CREATE SCHEMA whaleu_verification;

CREATE TABLE whaleu_verification.assertions (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
  fact_kind text NOT NULL CHECK (fact_kind IN ('affiliation','student_number','phone')),
  assertion_state text NOT NULL CHECK (assertion_state IN ('verified','unverified','revoked','expired')),
  coverage_state text NOT NULL CHECK (coverage_state IN ('complete','missing','conflict')),
  provenance_state text NOT NULL CHECK (provenance_state IN ('accepted','unknown','conflict')),
  method text NOT NULL CHECK (method IN ('document_review','institutional_email','institutional_sso','phone_provider','reconciled_import','unknown')),
  source_reference text CHECK (char_length(source_reference) BETWEEN 1 AND 200),
  policy_reference text CHECK (char_length(policy_reference) BETWEEN 1 AND 200),
  source_account_id uuid,
  issuer_institution_id uuid REFERENCES whaleu_campus.institutions(id),
  source_issuer_institution_id uuid REFERENCES whaleu_campus.institutions(id),
  origin_region_id uuid REFERENCES whaleu_campus.operating_regions(id),
  -- Exact private text, never a numeric type, login identifier or profile field.
  student_number text CHECK (char_length(student_number) BETWEEN 1 AND 100),
  -- Opaque pointer reserved for protected phone storage. No phone value in this ledger/API.
  phone_binding_reference uuid,
  verified_at timestamptz,
  expiry_kind text NOT NULL CHECK (expiry_kind IN ('unknown','at','policy_exempt')),
  expires_at timestamptz,
  previous_assertion_id uuid,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(id,account_id),
  FOREIGN KEY(previous_assertion_id,account_id) REFERENCES whaleu_verification.assertions(id,account_id),
  CHECK (previous_assertion_id IS NULL OR previous_assertion_id <> id),
  CHECK ((expiry_kind='at' AND expires_at IS NOT NULL) OR (expiry_kind<>'at' AND expires_at IS NULL)),
  CHECK (verified_at IS NULL OR expires_at IS NULL OR expires_at > verified_at),
  CHECK (student_number IS NULL OR fact_kind='student_number'),
  CHECK (phone_binding_reference IS NULL OR fact_kind='phone'),
  CHECK (fact_kind<>'phone' OR (issuer_institution_id IS NULL AND source_issuer_institution_id IS NULL AND origin_region_id IS NULL))
);
CREATE INDEX assertions_account ON whaleu_verification.assertions(account_id,fact_kind,recorded_at);

-- Each immutable snapshot binds all independent facts to one account and revision.
CREATE TABLE whaleu_verification.snapshots (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
  revision integer NOT NULL CHECK (revision > 0),
  affiliation_assertion_id uuid,
  student_number_assertion_id uuid,
  phone_assertion_id uuid,
  application_state text NOT NULL CHECK (application_state IN ('none','pending','rejected','unavailable')),
  application_coverage text NOT NULL CHECK (application_coverage IN ('complete','missing','conflict')),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(account_id,revision),
  UNIQUE(id,account_id,revision),
  FOREIGN KEY(affiliation_assertion_id,account_id) REFERENCES whaleu_verification.assertions(id,account_id),
  FOREIGN KEY(student_number_assertion_id,account_id) REFERENCES whaleu_verification.assertions(id,account_id),
  FOREIGN KEY(phone_assertion_id,account_id) REFERENCES whaleu_verification.assertions(id,account_id)
);
CREATE TABLE whaleu_verification.account_heads (
  account_id uuid PRIMARY KEY REFERENCES whaleu_identity.accounts(id),
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  snapshot_id uuid,
  CHECK ((revision=0 AND snapshot_id IS NULL) OR (revision>0 AND snapshot_id IS NOT NULL)),
  FOREIGN KEY(snapshot_id,account_id,revision) REFERENCES whaleu_verification.snapshots(id,account_id,revision)
);

-- An event is a durable receipt and audit record, without private assertion values.
CREATE TABLE whaleu_verification.events (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
  operation_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('reconciled_snapshot','revoke')),
  fact_kind text CHECK (fact_kind IN ('affiliation','student_number','phone')),
  actor_account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
  expected_revision integer NOT NULL CHECK (expected_revision >= 0),
  snapshot_id uuid NOT NULL,
  revision integer NOT NULL,
  reason_code text NOT NULL CHECK (reason_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(account_id,operation_id),
  UNIQUE(account_id,revision),
  FOREIGN KEY(snapshot_id,account_id,revision) REFERENCES whaleu_verification.snapshots(id,account_id,revision),
  CHECK (revision=expected_revision+1),
  CHECK ((kind='revoke' AND fact_kind IS NOT NULL) OR (kind='reconciled_snapshot' AND fact_kind IS NULL))
);

CREATE FUNCTION whaleu_verification.immutable_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Verification history is append-only';
END;
$$;
CREATE TRIGGER immutable_assertion BEFORE UPDATE OR DELETE ON whaleu_verification.assertions FOR EACH ROW EXECUTE FUNCTION whaleu_verification.immutable_record();
CREATE TRIGGER immutable_snapshot BEFORE UPDATE OR DELETE ON whaleu_verification.snapshots FOR EACH ROW EXECUTE FUNCTION whaleu_verification.immutable_record();
CREATE TRIGGER immutable_event BEFORE UPDATE OR DELETE ON whaleu_verification.events FOR EACH ROW EXECUTE FUNCTION whaleu_verification.immutable_record();
CREATE FUNCTION whaleu_verification.protect_head() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Verification heads cannot be deleted'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.revision<>0 OR NEW.snapshot_id IS NOT NULL THEN RAISE EXCEPTION 'Initialize empty head first'; END IF;
  ELSE
    IF NEW.account_id<>OLD.account_id OR NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'Verification head revision conflict'; END IF;
    IF NOT EXISTS (SELECT 1 FROM whaleu_verification.events WHERE account_id=NEW.account_id AND revision=NEW.revision AND snapshot_id=NEW.snapshot_id) THEN
      RAISE EXCEPTION 'Verification transition requires durable event';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER protect_head BEFORE INSERT OR UPDATE OR DELETE ON whaleu_verification.account_heads FOR EACH ROW EXECUTE FUNCTION whaleu_verification.protect_head();

-- Generic lossless staging envelope, deliberately no guessed MySQL field mapping.
-- This schema is never a read-authority source. No import/apply route is supplied.
CREATE TABLE whaleu_verification.import_batches (
  id uuid PRIMARY KEY,
  schema_digest text NOT NULL CHECK (schema_digest ~ '^[0-9a-f]{64}$'),
  source_digest text NOT NULL CHECK (source_digest ~ '^[0-9a-f]{64}$'),
  source_label text NOT NULL CHECK (char_length(source_label) BETWEEN 1 AND 200),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE whaleu_verification.raw_records (
  id uuid PRIMARY KEY,
  batch_id uuid NOT NULL REFERENCES whaleu_verification.import_batches(id),
  source_relation text NOT NULL CHECK (char_length(source_relation) BETWEEN 1 AND 200),
  source_key text NOT NULL CHECK (char_length(source_key) BETWEEN 1 AND 1000),
  -- Exact bytes preserve types, encodings, nulls and spelling. Restricted staging only.
  raw_record bytea NOT NULL,
  record_digest text NOT NULL CHECK (record_digest ~ '^[0-9a-f]{64}$'),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(batch_id,source_relation,source_key)
);
CREATE TRIGGER immutable_import_batch BEFORE UPDATE OR DELETE ON whaleu_verification.import_batches FOR EACH ROW EXECUTE FUNCTION whaleu_verification.immutable_record();
CREATE TRIGGER immutable_raw_record BEFORE UPDATE OR DELETE ON whaleu_verification.raw_records FOR EACH ROW EXECUTE FUNCTION whaleu_verification.immutable_record();
REVOKE ALL ON SCHEMA whaleu_verification FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA whaleu_verification FROM PUBLIC;
