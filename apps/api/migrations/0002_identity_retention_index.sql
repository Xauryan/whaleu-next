-- Support operator-only terminal-session retention; no data is deleted by this migration.
-- LEAST ignores NULL revoked_at, so active sessions sort by refresh expiry.
CREATE INDEX sessions_terminal_time ON whaleu_identity.sessions
  ((LEAST(refresh_expires_at, revoked_at)), id);
