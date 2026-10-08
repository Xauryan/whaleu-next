# Local static view OpenAPI acceptance

Verified 2026-10-08 against base `d20a0880d75e69e4ed536c83772930b5664f7810`
plus this increment. Hosted verification is reported separately.

## Frozen gates

All 756 source/test/config files retained fingerprint
`17536ed9e9ccec1d79c28415cf4a97fb0a0052abb7497480375cf013729f30df`.
The separately frozen generated artifact retained SHA-256
`a95811329c685c5e0da9a86cdd0b20fc5f8df8e484a40de4c697acb20940c8b5`.
[Machine-readable evidence](view-openapi.json) includes the manifest and log hashes.

- Lint, typecheck, deterministic OpenAPI drift check, 538 API tests and 842 native
  tests passed
- Builds, emitted native smokes and formatting passed
- 898 PostgreSQL tests passed in 617.733 seconds
- Total: 2,278 passed, zero failures/skips
- PostgreSQL 18.6, launch-only 100 connections, one-minute autovacuum; zero remaining
  application schemas and runner stopped

## Contract and isolation evidence

Independent request parity review exercised 1,214 old/new cases. Strict UUID
normalization, duplicated list events and detail cardinality are retained. Focused
32-test acceptance verifies schemas, actual controller metadata, filter output,
service transaction placement and deterministic artifacts. Dedicated TypeScript
metadata emission fixed an early exporter omission of request bodies under tsx.
Tooling output was moved outside production dist and raw-tsx export now fails
explicitly. Exactly two POST operations, required bodies, opaque bearer security,
safe errors and headers are emitted; no unconstrained request body is accepted.

Offline probes prohibit network/PG access, timers, listen/init and shutdown-hook
registration while rendering identical bytes repeatedly. The exporter never
imports AppModule or invokes service work. No public documentation route is added.
This is targeted schema/ref-resolution acceptance, not an exhaustive independent
OpenAPI standards-validator certification.

Seven new PostgreSQL test entries verify actual rollback when an epoch response
is malformed, a new receipt fails validation after aggregate changes, and a replay
response fails validation without changing its durable acknowledgement. Actual
HTTP/native decoding, safe error responses and the retained maintenance successor
envelope are covered. All four existing view suites and three maintenance suites
also passed in the 85-test focused regression before the full run.

## Dependencies and audit

Official @nestjs/swagger 12.0.2 adds eight lockfile packages: @nestjs/mapped-types
12.0.0, @microsoft/tsdoc 0.17.0, es-toolkit 1.52.0, js-yaml 5.4.2, argparse 2.0.1,
swagger-ui-dist 5.33.0 and @scarf/scarf 1.4.0 alongside Swagger. Existing versions
are unchanged. MIT, Apache-2.0 and Python-2.0 licenses were checked. UI assets are
not mounted; Scarf's lifecycle script was skipped and root analytics opt-out set.

The npm audit completed at 10:02:06 UTC with HTTP 200/exit 0 and reported zero
vulnerabilities across 305 dependencies, including development/optional packages.
The audited lockfile SHA-256 was unchanged:
`d376e5af91c77ffaf401567bf8a4f23e56f85af36f4668de3758817e7e4cda01`.
No auto-fix, version update or install lifecycle script was executed by the audit.

Scoped upstream advisory review and the registry result do not prove absence of
all vulnerabilities. Public API coverage beyond these two operations, physical
client testing and production deployment remain separate work.
