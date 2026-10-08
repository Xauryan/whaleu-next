# Local organization-directory acceptance

Verified 2026-10-08 against base `816d288269c0ac32e2dadea0437516b20a75b48e`
plus this increment. Hosted verification is reported separately.

## Frozen gates

All 830 source/test/config/asset files retained fingerprint
`809e19f11e4b1eb5466742fd8b397bdbe5b200983b52318741edcc90542c94b6` through
final verification. Both generated OpenAPI artifacts were frozen independently;
[the evidence JSON](organization-directory.json) records artifact/file/log hashes.

- Lint, types, both OpenAPI drift checks, 619 API and 869 native tests passed
- Builds, emitted native smokes and formatting passed
- 1,051 PostgreSQL tests passed in 741.251 seconds
- Total: 2,539 passed, zero failures/skips
- PostgreSQL 18.6, launch-only 100 connections, one-minute autovacuum; zero remaining
  application schemas and runner stopped

The first aggregate passed check/build/tests but stopped before PostgreSQL because
the new generated JSON differed from Prettier style. The shared renderer now uses
the already-installed Prettier after deterministic key sorting. Both artifacts
preserve parsed JSON content; the old view artifact formatting exclusion was
removed. Generator drift and formatting checks now agree without exclusions.

## Executed evidence

Fifty-six focused PostgreSQL tests cover normal-AppModule canonical member gates,
phone/affiliation/safety/identity unknown/revoked/expired states, real admin roles
without Stage 1 bypass, independent global taxonomy and regional entry isolation,
complete-empty versus missing coverage, strict approval binding, accepted numeric
ordering, literal ASCII case-insensitive search and traversal beyond 50 rows.

Lock-wait tests cover category withdrawal, approval changes and session/identity
changes. Separate sequential tests cover shared taxonomy-head replacement; an
injected query delay verifies final cursor-deadline rollback. The
shared 120-plus-one request budget and unsupported GET body are tested. Actual
native ApiClient/gateway/strict decoders/controllers run against Nest HTTP and
PostgreSQL, including immediately cancelled QQ copy. No existing assertion was
weakened and no permissive authorization replacement was used.

Twenty-seven new native tests and emitted-page smoke cover the three registered
pages, nine kind/platform combinations, independent badges, current-home context,
search/pagination/Back, exact DTO copy, unavailable media and lifecycle clearing.
The emitted conditional/handler model is synthetic and does not establish
physical-device rendering or provider acceptance.

Review found and corrected missing shared taxonomy heads, SQL-null approval
checks, cursor repository ownership, guard-time Vary handling and deferred
clipboard cancellation. Final refinements include strict query syntax, numeric
rather than textual ordinal ordering, and independent inapplicable media state.
Initial focused failures from coupled expiry fixtures were corrected before the
final 56-test run; no authority rule was relaxed to pass them.

## Scope and release boundary

Empty migration 0032 installs sealed revision/coverage structures, not production
records, a runtime issuer, media integration or a historical import. Approved
member reads are PARTIAL directory parity. Administrative exceptions, role/manager
projections, application/review mutations, visits/order updates, media, history and
other platforms remain open. GET purity means no directory business mutation;
bounded cursor and request-throttle metadata are intentionally maintained.

No dependency was added. Existing Nest/Zod/pg/Swagger and owner facades are reused.
All generated schemas remain derived from actual owners/controllers. No public
hot-ranking decision or author received-total policy is changed by this feature.
