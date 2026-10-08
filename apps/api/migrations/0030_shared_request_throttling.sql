-- Generic request-attempt state only. Keys are one-way account/operation hashes;
-- no tokens, addresses, payloads, post identities, or browsing history are stored.
CREATE SCHEMA whaleu_runtime;
CREATE TABLE whaleu_runtime.request_throttle_counters (
  storage_key text PRIMARY KEY CHECK (storage_key ~ '^[0-9a-f]{64}$'),
  total_hits integer NOT NULL CHECK (total_hits >= 0 AND total_hits <= 1000001),
  expires_at timestamptz NOT NULL,
  blocked_until timestamptz
);
CREATE INDEX request_throttle_retention
  ON whaleu_runtime.request_throttle_counters
  ((GREATEST(expires_at, COALESCE(blocked_until, expires_at))));
