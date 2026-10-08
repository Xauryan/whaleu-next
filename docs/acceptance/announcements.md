# Local announcement acceptance

Verified 2026-10-08 against base `637ecf3c73d1c51895f8d0b9b51a9925ab03e31c`
plus this increment. Hosted verification is reported separately.

## Frozen gates

All 911 source/test/config/asset files retained fingerprint
`9fd62607069ebf593002e36b390fe9c09e5d2e40870e963cda0bde9fa09f34b5` through
final verification. Generated artifacts were frozen independently;
[the evidence JSON](announcements.json) records file/artifact/log hashes.

- Lint, types, OpenAPI drift, 641 API and 903 native tests passed
- Builds, emitted native smokes and formatting passed
- 1,116 PostgreSQL integration tests passed in 823.435 seconds
- Total: 2,660 passed, zero failures/skips
- PostgreSQL 18.6, launch-only 100 connections, one-minute autovacuum; zero remaining
  application schemas and runner stopped

## Executed evidence

Thirty-two focused normal-AppModule/PostgreSQL tests cover public versus invalid
optional authentication, current account restrictions without phone/student gates,
exact physical-campus/global audience, sealed current authority, unknown old marker
coverage, ID/version distinctions, repeated/concurrent acknowledgement, response
loss, rollback/deferred COMMIT failure and real policy/deadline waits.

Exact microsecond since-created newness and 127-item keyset traversal are tested
separately from acknowledgement. Actual native gateways/controllers run against
Nest HTTP/PostgreSQL for public reading and account popup behavior, with current
scope, hide and stale-response fences. No existing test assertion was weakened or
permissive authority replacement installed.

Thirteen new native tests and emitted-page smoke cover guest list/detail,
authenticated popup, explicit close, lost/repeated confirmation, background
clearing and browsing-campus reload. Review found and fixed timestamp precision,
optional-count requests swallowing authority denial, mismatched feed/popup context
on reload, and missing Authorization variance on parser-level failures.

The first database run found an actual changes-query SQL precedence error causing
500 responses. It was fixed before the final focused and full runs. A later test
attempted to mutate immutable cursor expiry; the fixture now creates an aged
cursor instead, preserving production invariants.

## Release boundary

Reads and explicit popup acknowledgement are a partial vertical slice. No runtime
content issuer, admin writer, media provider, production announcement, reviewed
historical import or feedback module is added. Unknown coverage never becomes
empty or unread. Native emitted tests are synthetic and do not establish physical
WeChat rendering. No production deployment is claimed.
