# Local internal comment-component acceptance

Verified 2026-10-08 against base `52ebc87503e6b130bf7f19dca973628c81f634d0`
plus this increment. Hosted verification is reported separately.

## Frozen gates

All 771 source/test/config/asset files retained fingerprint
`0da919524d51934c8c8db0e0465fe70b2f01cc2f1618889fa478f0ff46dd3fc0` throughout
final verification. [Machine-readable evidence](comment-component.json) records
file/log hashes; Markdown and docs are excluded from the source freeze.

- Lint, types, OpenAPI drift, 568 API tests and 842 native tests passed
- Builds, emitted native smokes and formatting passed
- 974 real PostgreSQL tests passed in 650.983 seconds
- Total: 2,384 passed, zero failures/skips
- PostgreSQL 18.6, launch-only 100 connections, one-minute autovacuum, zero remaining
  application schemas and runner stopped

## Focused evidence

Twenty-eight component unit/facade tests and a final 156-test PostgreSQL selection
cover new component suites plus existing like/subscription/view proof regressions.
Real HTTP and database tests establish fresh enrollment, author exclusion,
named/anonymous cardinality, independent kind identity, root deletion with
surviving replies, actual self-delete and report-threshold removal, failed tenth
report rollback, block/unblock no-op accounting, immutable replay and unsupported
writes. Public thread visibility remains separate from internal accounting.

Concurrent acceptance covers invisible newborn parents under both tested
isolation levels, parent/child ordering, workers, moderation and capture.
Deferred proof tests reject forged sources, wrong positive references, incorrect
counts/memberships and incomplete effects. Dry-run table/sequence snapshots and
CLI isolation preserve the existing local safeguards. Existing fixture changes
add only new constructor dependencies or real current-schema fresh enrollment;
historical stages and deliberate negative proofs remain unchanged.

The first focused database run stopped at an actual PL/pgSQL parse error in a
CASE expression before assertions. Parenthesizing the expression fixed it before
156 focused and all 974 final integration tests passed. Static review also found
and corrected root-record access to a reply-only field by nesting the reply-kind
check. Neither initial attempt is recorded as a successful acceptance run.

## Release boundary

This is an internal processed-prefix component, not visible discussion totals or
a public ranking. No author received-total deletion decision, native response,
experience rule, notification delivery, outbox completion or production dataset
was changed. No new dependency or background processor was introduced.

Effective formula/version, all-component consistent freshness, historical
coverage, ranking privacy, hot-feed pagination, production throughput and device
acceptance remain open. Installed-schema guards do not protect against a database
administrator disabling them. No deployment is claimed.

## Hosted verification

Verified SSH-signed commit `3857e48dd54368cf015e94ed4ad0787d8d19cce5` passed
[GitHub Actions run 37765968165](https://github.com/Xauryan/whaleu-next/actions/runs/37765968165):
568 API, 842 native and 974 PostgreSQL tests, 2,384 total with zero failures/skips.
PostgreSQL took 564.241 seconds. Lint, types, OpenAPI drift, builds, emitted smokes
and formatting passed. No deployment is implied.
