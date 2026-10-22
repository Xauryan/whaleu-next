# Application installation readiness

`GET /health/live` remains process-only and returns `{ "status": "ok" }` without
reading configuration, deployment files or PostgreSQL. `GET /health/ready` returns
the same body only when the checks below succeed. Failure uses the existing safe
503 `NOT_READY` envelope and `no-store` HTTP contract. It never returns migration
names, checksums, configuration values, file paths or raw errors.

## Required installation

The application gate in `apps/api/src/health/readiness.ts` preserves
`DatabaseService.ready()` for supported PostgreSQL 18.6–18.x connectivity and
shutdown behavior. It reuses `loadConfig` for the existing runtime configuration
and cross-field prerequisites; it does not invent provider configuration or make
an optional disabled feature mandatory.

The normal `apps/api/migrations/` directory is the versioned deployment source of
required names and SHA-256 checksums, using exactly `readMigrations` and
`verifyHistory` from the migration runner. The path is relative to the module in
both `src/health/` and `dist/health/`, matching the existing source/compiled
migration CLI. Production packaging must include that immutable directory beside
`dist/`, not just JavaScript. No migration is run by startup or a probe.

The artifact must contain a contiguous numbered chain beginning at 0001 and
including `0182_real_deletion_request_authority.sql`. This is the current minimum,
not a permanent cutoff: any additional normal migration shipped in a later
version automatically becomes required. An unknown installed migration that is
not in this binary's deployment artifact fails closed. The request-aware runtime raises the prior0181 floor to0182: an artifact
truncated at0181 is not ready even if its0181 ledger is otherwise complete.
The original0179/0180 truncation negatives remain required. This dependency
change does not itself establish production admission, cancellation recovery
for a lost secret, owner erasure or completed-at guard authority.

Every shipped migration must be installed exactly once, with its exact name and
checksum. Empty, historical-0175, truncated, gapped, duplicate, unknown and drifted
histories fail. Formatting/review being disabled does not lower these requirements.
Historical source-reader compatibility is not full-application readiness.

The migration files are lazily loaded once per process, with concurrent probes
sharing one promise. A missing or invalid artifact remains unready until it is
repaired and the process restarted. This avoids repeatedly hashing roughly 5 MB
of trusted checked-in SQL on every probe and keeps liveness independent of file
availability. Do not mutate a running release artifact in place.

## Read-only database boundary

Each probe uses the existing managed transaction helper with explicit READ
COMMITTED isolation and SET TRANSACTION READ ONLY. It first acquires the
nonblocking transaction-shared form of the approved migrator's existing advisory
key, then reads installation records in a separate bounded SELECT. That ordering
ensures the ledger statement's snapshot is taken after acquiring the gate, not
before a concurrently finishing migration. The gate is held through COMMIT or
ROLLBACK, and connection cleanup remains owned by DatabaseService. A busy
migrator returns unavailable without waiting for its advisory lock. The query
reads at most the shipped migration count plus one, does not sort the history,
and returns at most 255 bytes per name and 64 bytes per checksum. Application
requirements are bounded by the existing four-digit migration namespace. Existing
pool connection/statement timeouts still apply.

The API role needs only schema USAGE and SELECT on
`whaleu_meta.schema_migrations` in addition to its already authorized runtime
privileges, and the ordinary read/advisory functions used here. Missing privileges
fail closed. This patch grants nothing and requires no application-table UPDATE,
MAINTAIN, DDL, schema installation or production role expansion.

This is a point-in-time **migration-ledger and configuration** check, not a full
catalog fingerprint, least-privilege audit, policy/grant/identity qualification,
worker-progress check, source-content acceptance or provider health test. A
forged ledger or out-of-band DDL is not ruled out by ledger agreement. Existing
owner-level schema seals, authorization, source policies and per-operation
fail-closed checks remain authoritative. A ready process does not thereby enable
payments, grades, account erasure, moderation or external providers. No business
owner or provider is invoked by this gate.

## Verification boundary

`apps/api/test/application-readiness.test.ts` uses synthetic migration files and
an isolated HealthModule with a fake database, not AppModule or external services.
It covers loader/hash compatibility, current 182 with formatting disabled,
missing/unknown/drifted/gapped history, invalid configuration, migration contention,
future artifact extension, caching, sanitized failure and independent liveness.
The fake-client transaction tests additionally cover statement ordering, explicit
read-only/isolation modes, lock contention, rollback/release and completion failure.
The existing HTTP-envelope tests separately mock the application readiness result.
These unit checks do not establish PostgreSQL advisory-lock behavior, restricted
role permissions, compiled-release packaging or production acceptance; those
remain integration/deployment checks.

### Fresh PostgreSQL qualification

`apps/api/test/integration/application-readiness.test.ts` is registered exactly
once in the existing `shared-foundation-1` CI shard. It requires controlled test
maintenance, a loopback database named `whaleu_test`, a supported PostgreSQL
version, the existing suite advisory lease, and no pre-existing `whaleu_` schema.
It installs the complete actual shipped migration chain, currently 0001–0182.
It never substitutes a historical prefix, fake checksums or a mocked ready
provider, and mounts only Configuration, Observability and the real HealthModule.

The prepared cases exercise real HTTP 200/503 and unchanged liveness, an absent
ledger before installation, missing/drifted/unknown installation records,
rollback after an unavailable ledger, exclusive approved-migrator contention,
lock-release recovery, unchanged exact ledger timestamps and shutdown. All ledger
fault injection and schema cleanup are limited to the freshly owned disposable
database. No application migration file or external owner capability is changed.
Use the existing controlled integration runner; do not point it at a shared,
historical or production database. This authored test is not a PostgreSQL pass
until it has actually executed on the exact integrated source. It does not by
itself qualify production permissions, TLS or provider acceptance.

Current0182 boundary: full deployment includes the request substrate and local
accept/cancel HTTP coordination, but production admission remains explicitly
unavailable. Neither configuration nor a completed migration establishes owner
erasure, reader retirement, lost-secret recovery or completed-at guard writing.
Earlier validation results retain their original exact-source scope; this
documentation does not inherit them as new-stack passes.
