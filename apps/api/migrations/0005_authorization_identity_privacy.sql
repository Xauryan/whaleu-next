-- Empty privilege/audit schema only. No default, first-login or deployer account grants.
CREATE SCHEMA whaleu_authorization;
CREATE TABLE whaleu_authorization.role_grants (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
  role text NOT NULL CHECK (role IN ('developer','super_admin','school_admin')),
  operating_region_id uuid REFERENCES whaleu_campus.operating_regions(id),
  approved_by_account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
  approval_reference text NOT NULL CHECK (char_length(approval_reference) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  valid_from timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz,
  revoked_at timestamptz,
  revoked_by_account_id uuid REFERENCES whaleu_identity.accounts(id),
  CHECK ((role IN ('developer','super_admin') AND operating_region_id IS NULL)
      OR (role='school_admin' AND operating_region_id IS NOT NULL)),
  CHECK (expires_at IS NULL OR expires_at > valid_from),
  CHECK ((revoked_at IS NULL AND revoked_by_account_id IS NULL)
      OR (revoked_at IS NOT NULL AND revoked_by_account_id IS NOT NULL))
);
-- A school administrator has one explicit operating-region binding until revocation.
-- Expired grants must be revoked before replacement; no silent widening or reassignment.
CREATE UNIQUE INDEX role_grants_unrevoked ON whaleu_authorization.role_grants(account_id,role) WHERE revoked_at IS NULL;
CREATE INDEX role_grants_actor ON whaleu_authorization.role_grants(account_id);
CREATE FUNCTION whaleu_authorization.protect_grant() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Role grants must be revoked, not deleted';
  END IF;
  IF (NEW.id,NEW.account_id,NEW.role,NEW.operating_region_id,NEW.approved_by_account_id,NEW.approval_reference,NEW.created_at,NEW.valid_from,NEW.expires_at)
      IS DISTINCT FROM
     (OLD.id,OLD.account_id,OLD.role,OLD.operating_region_id,OLD.approved_by_account_id,OLD.approval_reference,OLD.created_at,OLD.valid_from,OLD.expires_at)
     OR (OLD.revoked_at IS NOT NULL AND (NEW.revoked_at,NEW.revoked_by_account_id) IS DISTINCT FROM (OLD.revoked_at,OLD.revoked_by_account_id)) THEN
    RAISE EXCEPTION 'Grant facts are immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER protect_grant BEFORE UPDATE OR DELETE ON whaleu_authorization.role_grants FOR EACH ROW EXECUTE FUNCTION whaleu_authorization.protect_grant();

CREATE TABLE whaleu_authorization.identity_view_audit (
  id uuid PRIMARY KEY,
  batch_id uuid NOT NULL,
  actor_account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
  -- Session ID is retained as metadata without a foreign key, so session cleanup remains possible.
  session_id uuid NOT NULL,
  grant_id uuid REFERENCES whaleu_authorization.role_grants(id),
  request_id uuid NOT NULL,
  target_kind text NOT NULL CHECK (target_kind IN ('post','comment')),
  target_id uuid NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('disclosed','unavailable','denied')),
  disclosed_fields text[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (disclosed_fields <@ ARRAY['accountId','nickname','studentNumber']::text[]),
  CHECK ((outcome='disclosed' AND grant_id IS NOT NULL AND cardinality(disclosed_fields) >= 1)
      OR (outcome IN ('unavailable','denied') AND cardinality(disclosed_fields)=0))
);
-- No target account ID or identity values: this ledger records access without copying its payload.
CREATE INDEX identity_view_audit_actor ON whaleu_authorization.identity_view_audit(actor_account_id,created_at DESC);
CREATE INDEX identity_view_audit_batch ON whaleu_authorization.identity_view_audit(batch_id);
CREATE FUNCTION whaleu_authorization.protect_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Identity view audit is append-only';
END;
$$;
CREATE TRIGGER protect_audit BEFORE UPDATE OR DELETE ON whaleu_authorization.identity_view_audit FOR EACH ROW EXECUTE FUNCTION whaleu_authorization.protect_audit();
