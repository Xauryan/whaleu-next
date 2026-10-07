-- New identity/session storage only. This is NOT a legacy-data migration.
CREATE SCHEMA whaleu_identity;

CREATE TABLE whaleu_identity.accounts (
  id uuid PRIMARY KEY,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'blocked')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE whaleu_identity.provider_identities (
  provider text NOT NULL CHECK (provider = 'wechat'),
  app_id text NOT NULL CHECK (length(app_id) BETWEEN 1 AND 128),
  subject text NOT NULL CHECK (length(subject) BETWEEN 1 AND 128),
  account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
  union_subject text CHECK (length(union_subject) BETWEEN 1 AND 128),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (provider, app_id, subject)
);
CREATE INDEX provider_identities_account ON whaleu_identity.provider_identities(account_id);

-- Import tooling must populate and reconcile these rows before existing users log in.
-- Preserve source IDs as text, never lossy JavaScript numbers. No import is implemented here.
CREATE TABLE whaleu_identity.legacy_account_mappings (
  source_system text NOT NULL CHECK (length(source_system) BETWEEN 1 AND 128),
  legacy_id text NOT NULL CHECK (length(legacy_id) BETWEEN 1 AND 128),
  account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
  PRIMARY KEY (source_system, legacy_id)
);
CREATE INDEX legacy_account_mappings_account ON whaleu_identity.legacy_account_mappings(account_id);

CREATE TABLE whaleu_identity.sessions (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
  access_expires_at timestamptz NOT NULL,
  refresh_expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  revoke_reason text CHECK (revoke_reason IN ('logout', 'refresh_replay', 'session_limit')),
  CHECK (access_expires_at <= refresh_expires_at),
  CHECK (refresh_expires_at <= absolute_expires_at),
  CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL))
);
CREATE INDEX sessions_account ON whaleu_identity.sessions(account_id, created_at DESC);
CREATE INDEX sessions_expiry ON whaleu_identity.sessions(absolute_expires_at);

-- Access history allows explicit expiry semantics and logout during refresh races.
CREATE TABLE whaleu_identity.access_tokens (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  session_id uuid NOT NULL REFERENCES whaleu_identity.sessions(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
CREATE INDEX access_tokens_session_expiry ON whaleu_identity.access_tokens(session_id, expires_at);

-- Retain consumed token hashes through the session lifetime to detect replay.
CREATE TABLE whaleu_identity.refresh_tokens (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  session_id uuid NOT NULL REFERENCES whaleu_identity.sessions(id) ON DELETE CASCADE,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX refresh_tokens_session ON whaleu_identity.refresh_tokens(session_id);

-- Short-lived HMAC buckets; neither client addresses nor codes/tokens are stored.
CREATE TABLE whaleu_identity.rate_buckets (
  bucket_hash text NOT NULL CHECK (bucket_hash ~ '^[a-f0-9]{64}$'),
  window_start timestamptz NOT NULL,
  hits integer NOT NULL CHECK (hits > 0),
  PRIMARY KEY (bucket_hash, window_start)
);
CREATE INDEX rate_buckets_expiry ON whaleu_identity.rate_buckets(window_start);
