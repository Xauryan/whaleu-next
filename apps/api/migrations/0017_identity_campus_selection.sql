-- Additive, empty, own-account declarations only. No review/verification grants,
-- topology issuance, history reconciliation, production data or startup seeds.
CREATE TABLE whaleu_campus.identity_selection_requests (
  account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
  client_request_id uuid NOT NULL,
  operation text NOT NULL CHECK(operation='select_identity_campus'),
  intent_version integer NOT NULL CHECK(intent_version=1),
  intent_hash text NOT NULL CHECK(intent_hash ~ '^[a-f0-9]{64}$'),
  campus_id uuid NOT NULL REFERENCES whaleu_campus.campuses(id),
  expected_state_revision text NOT NULL CHECK(expected_state_revision ~ '^ic1:[a-f0-9]{64}$'),
  selection_id uuid NOT NULL,
  selection_revision integer NOT NULL CHECK(selection_revision>0),
  outcome text NOT NULL CHECK(outcome IN ('applied','unchanged')),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(account_id,client_request_id),
  FOREIGN KEY(selection_id,account_id,selection_revision)
    REFERENCES whaleu_campus.community_identity_selections(id,account_id,revision),
  CHECK(intent_hash=encode(sha256(convert_to('whaleu-identity-campus-intent:v1'||chr(10)||campus_id::text||chr(10)||expected_state_revision,'UTF8')),'hex'))
);
CREATE TRIGGER identity_selection_request_gate BEFORE INSERT OR UPDATE OR DELETE ON whaleu_campus.identity_selection_requests
  FOR EACH STATEMENT EXECUTE FUNCTION whaleu_campus.community_scope_writer_gate();
CREATE TRIGGER immutable_identity_selection_request BEFORE UPDATE OR DELETE ON whaleu_campus.identity_selection_requests
  FOR EACH ROW EXECUTE FUNCTION whaleu_campus.immutable_community_policy_fact();
CREATE FUNCTION whaleu_campus.validate_identity_selection_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM whaleu_campus.community_identity_selections s
    JOIN whaleu_campus.community_identity_heads h ON h.account_id=s.account_id AND h.selection_id=s.id AND h.revision=s.revision
    WHERE s.id=NEW.selection_id AND s.account_id=NEW.account_id AND s.revision=NEW.selection_revision
      AND s.selection_state='selected' AND s.campus_id=NEW.campus_id
  ) THEN RAISE EXCEPTION 'Receipt must bind the current account selection' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER validate_identity_selection_receipt BEFORE INSERT ON whaleu_campus.identity_selection_requests
  FOR EACH ROW EXECUTE FUNCTION whaleu_campus.validate_identity_selection_receipt();
-- A complete candidate inventory requires protection against phantoms, not only
-- locks on existing rows. Future multi-statement catalog writers MUST take this
-- gate explicitly before any earlier row lock; these triggers protect statements.
CREATE TRIGGER identity_campus_catalog_gate BEFORE INSERT OR UPDATE OR DELETE ON whaleu_campus.campuses
  FOR EACH STATEMENT EXECUTE FUNCTION whaleu_campus.community_scope_writer_gate();
CREATE TRIGGER identity_institution_catalog_gate BEFORE INSERT OR UPDATE OR DELETE ON whaleu_campus.institutions
  FOR EACH STATEMENT EXECUTE FUNCTION whaleu_campus.community_scope_writer_gate();
CREATE TRIGGER identity_assignment_catalog_gate BEFORE INSERT OR UPDATE OR DELETE ON whaleu_campus.campus_region_assignments
  FOR EACH STATEMENT EXECUTE FUNCTION whaleu_campus.community_scope_writer_gate();
CREATE TRIGGER identity_region_catalog_gate BEFORE INSERT OR UPDATE OR DELETE ON whaleu_campus.operating_regions
  FOR EACH STATEMENT EXECUTE FUNCTION whaleu_campus.community_scope_writer_gate();
REVOKE ALL ON whaleu_campus.identity_selection_requests FROM PUBLIC;
