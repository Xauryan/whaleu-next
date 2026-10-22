# M1/M2 integration on published c27

## Current delivery status, 2026-10-21

The integrated implementation starts from published commit
`c27f173d8057f349469f4f96855d31edb9cff7c5`. Immutable source migration
`apps/api/migrations/0175_community_text_sources.sql` and formal durable-formatting
migration `apps/api/migrations/0176_durable_reading_formatting.sql` are in the
normal checksum/prefix-verified migration sequence. The current binary requires
the complete chain through `0179_identity_registration_guard.sql`, including
Home 0177/0178, before startup, consistent with
[Home activation](../apps/api/docs/HOME_PUBLICATION_ACTIVATION.md) and the
[registration guard](IDENTITY_REGISTRATION_GUARD.md). Published 0001–0174 bytes
remain unchanged. M2 is no longer an unnumbered deployment draft, and its CLI is
not prohibited in production: explicit mode, full schema readiness and a bounded
managed-runtime role are required. No production deployment has occurred.

Implemented product scope:

- Plain/Markdown draft editing, preview and publication use the existing native
  account, Review, pending-command and cancellation owners. Frozen intent is not
  editable; published-source editing is not implemented.
- Six authorized `/v2/community` detail/thread readers retain canonical original
  source independently of optional formatting. Mandatory source/authorization
  failure never becomes a legacy or source fallback.
- Explicit human `source_manual` review is production-capable with configured
  scope, operator and accepted source policy. It selects the issuer, not a schema
  version. Both review and formatting processing default to disabled deliberately;
  migration/startup is not opt-in. The current deployment nevertheless installs
  M2 in the complete chain, and fresh eligible publications may create ordinary
  pending jobs without a running formatter.
- Optional M2 is deterministic `plain-cjk-slices-v2`, not AI/provider output.
  Fresh reviewed plain+auto sources enroll at 300 Unicode scalars for posts or
  200 for comments/replies. Markdown, opt-out and short sources do not enroll;
  historical sources are not backfilled.

Deployment details are in [M2_DEPLOYMENT.md](M2_DEPLOYMENT.md) and
[COMMUNITY_SOURCE_MANUAL_DEPLOYMENT.md](COMMUNITY_SOURCE_MANUAL_DEPLOYMENT.md).
Native routing and privacy are in
[READING_NATIVE_INTEGRATION.md](READING_NATIVE_INTEGRATION.md).

## Exact-input validation attribution

These are local validation results, not cloud CI, production or device acceptance.
Snapshot names identify frozen evidence bundles, not deployment environments.
The results below belong to those prior exact inputs, not new acceptance of the
current binary. Current production API/PTY and worker fixtures install the full
chain through 0179. The Home worker fixture first captures the six pre-Home bodies
at the explicit through-0177 prefix, then upgrades the full chain before creating
runtime actors. It retains the predecessor and original 0176 catalog checks.
Historical exact-0175 producer/current six-reader compatibility is separate in
`apps/api/test/integration/text-source-m1-compatibility.test.ts`; it is not a current
production deployment on a truncated schema.

API `/health/ready` only checks PostgreSQL connectivity and supported version
(`DatabaseService.ready()` in `apps/api/src/database/database.ts`). It cannot confirm the
minimum migration chain, schema qualification or policy readiness.

- `reading-c27-deployable-cli-stage-v1`: 5,729 source files; source-manifest SHA-256
  `22d480aa5e9ae2ed989585629d1ddacfd1379240910ec430bf248bec796d26e7`.
  Formatting, 50 guard tests, strict complete API production/scripts plus all
  seven changed TypeScript test/support files, 62 focused pure tests, and the
  ordinary API build passed. Source and native runtime bytes are unchanged from
  the preceding stage-v2; this successor changes tests, test helpers and CI wiring.
- On that exact CLI snapshot, verified-TLS PostgreSQL acceptance passed 6/6
  reported tests, including its parent, with zero failures/skips/cancellations.
  The after-run input check at 16:06:10 UTC verified source, installed binaries and
  execution closure unchanged. It exercised a genuine queued source, actual
  source-entry `once`, ordinary compiled-entry `once`, a direct restricted LOGIN
  session, automatic `serve` followed by SIGTERM after a completed tick, and
  privileged-login rejection before a worker tick. The API-build manifest SHA-256
  was `43184ddd092a51d25a66a21b783642b6086aba8601f6d18b5e5795d7297d6f77`.
  Loopback authentication was explicitly `trust`; TLS hostname and unrelated-CA
  negatives passed. This is not password-authentication, Docker or in-flight
  signal-drain evidence.
- Runtime-identical `reading-c27-deployable-stage-v2`: source-manifest SHA-256
  `b566458a9462434e8cfed5900b5e294eca6ba7f53de54f71901cc07ed14c6554`.
  API 2,638/2,638 and native 5,334/5,334 passed with zero failures/skips. Native
  strict types, lint, route/CI inventories, generated OpenAPI, build and release
  package checks passed. Four strict complete-root API partitions passed; they
  do not replace the original single-Program full API typecheck cloud gate.
- That exact stage-v2 also passed 126/126 reported PostgreSQL tests across ten
  fresh whole-file runs: the reading formatter, native reading roundtrip,
  current-source erasure fail-closed, source storage and source HTTP suites each
  ran under C and en_US.utf8. Counts include parent tests. No result is silently
  attributed to changed test files in the later CLI successor.
- Earlier `reading-c27-production-manual-v3`: source-manifest SHA-256
  `6529db9a4a1fe1f38041fd8b0cad22e1a64f3ea28d03028d4ce985c35c9bfd0a`.
  Its genuine `source_manual` production-mode API/HTTP and private-TTY operator
  whole-file test passed 1/1 under verified TLS/C, with normal 0175 installed and
  M2 absent. This is prior-version exact-input evidence, not a current-binary
  production acceptance, permission to deploy current runtime on exact 0175,
  or a least-privilege reviewer-role test.

## Remaining acceptance boundaries

- Run the original single-Program full API typecheck and the Docker/password-TLS
  CI lane on the final published source. Local strict partitions and loopback
  trust do not satisfy those distinct gates.
- Verify real account/provider eligibility, production secret/role custody,
  deployment configuration and physical-device rendering before activation.
  No external provider, production service or physical device was activated here.
- Published-source editing, inline Markdown media and full-source Markdown
  reference AST integration are not implemented. The existing conservative
  Markdown reference fence remains.
- Source and M2 remain outside account-erasure qualification. Current inventory
  and service/worker checks fail closed, including empty new owner tables.
  Passing rejection tests does not qualify erasure, physical deletion, generation
  closure or late-writer/quiescence coverage.
- Managed commit ownership remains required. Unrestricted raw SQL can drain
  constraints early and idle until COMMIT; SQL triggers are not a universal
  temporal capability boundary or a defense against trusted migration owners.

## Historical integration and failed-gate provenance

The first c27 integration imported a 62-path M1/M2 feature set from the reviewed
v8 packet (manifest
`dce20d5e2c4b70de3a0d3aad2dcdb24a8b718e5be8bb49dc177159e50217162f`).
All 21 M1 existing-file baselines matched c27. Identity initially gained only the
processing-owner seam. Missing files in partial snapshots were never deletions.
Unpublished source-free erasure 0176 and Home v7/0177 were not imported; today's
0176 is the separately implemented durable-reading migration.

Integration-v1 actually failed strict compilation with two TS2345 fixture errors.
Integration-v2 fixed the canonical-envelope fixture type and HTTP request-body
helper without weakening runtime decoding or assertions. Its 115 focused pure
passes and six-file lint pass were the evidence then available, not the present
validation ceiling. Earlier failed logs remain historical failures.

Historical deletion rehearsals explicitly select the reviewed pre-source prefix
through published 0174. The default fixture and registry were not broadened.
The added current-catalog tests keep genuine historical service requests and a
positive control separate from subsequent 0175/M2 inventory denial. They assert
exact catalog deltas, rejection causes, unchanged data/seals and SQLSTATE 23514
with a genuine same-transaction cause. Synthetic cooling-clock advancement is
not a real seven-day wait. These historical construction choices remain useful
provenance; old statements that M2 was only a draft, production CLI was forbidden,
or all PostgreSQL/native gates were unrun no longer describe the current source.
