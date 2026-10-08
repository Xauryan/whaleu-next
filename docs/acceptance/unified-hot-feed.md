# Local unified public hot-feed acceptance

Verified 2026-10-08 against base `d82aeffc91a9d2fe74e1c23e4216a8b62a6dfc0b`
plus this increment. Hosted verification is reported separately. The base differs
from the prior directory release only by CI timeout allowance.

## Frozen gates

All 871 source/test/config/asset files retained fingerprint
`101d7f2599000220d8af5b4d1005f639160f5343b509b431cbc28fa8663b0ced` through
final verification. Generated OpenAPI artifacts were frozen independently;
[the evidence JSON](unified-hot-feed.json) records file/artifact/log hashes.

- Lint, types, OpenAPI drift, 631 API and 890 native tests passed
- Builds, emitted native smokes and formatting passed
- 1,084 PostgreSQL tests passed in 788.307 seconds
- Total: 2,605 passed, zero failures/skips
- PostgreSQL 18.6, launch-only 100 connections, one-minute autovacuum; zero remaining
  application schemas and runner stopped

## Execution evidence

Thirty-three focused PostgreSQL/native-HTTP tests cover certificate integrity,
exact decimal order, six elapsed-age ranges and caps, 128+1 structural traversal,
current visibility, final block/session/phone checks and independently covered
population. The actual HTTP automatic runner demonstrates publication → score →
like/save/comment/view interaction → stale exclusion → owner settlement and score
refresh → reappearance, without manual recovery between those steps.

Concurrency acceptance covers duplicate runners/settlement, parent/state ordering,
retry backoff, partial-coverage rejection, bounded fairness, shutdown draining and
current certificate comparison. Public reads do not catch up component work or
write scores. Existing fixture changes enroll scheduling only through real complete
native coverage; earlier component proof/history stages retain their assertions.

Actual native gateway/decoder runs against Nest and PostgreSQL: a post can repeat
on a later page after score movement, Previous is a fresh read, range/session late
responses are rejected, and existing 50%/one-second render-qualified exposure
reaches accepted view storage. Twenty-one new native tests and emitted hot-page
smoke retain within-response uniqueness and cursor-loop checks without requiring
frozen cross-page identities. Physical-device rendering is not verified.

Review found and verified fixes for automatic tail starvation after budget
exhaustion, manual processing of incomplete coverage, repeated manual selections
starving their tail, and calendar-day arithmetic across DST. Retry metadata no
longer waits on the parent that caused a failure. Final age windows use elapsed
hours; neither an API limit nor a cycle budget is a production throughput claim.

## Scope and release boundary

One unified source-faithful score affects ordering, while current per-viewer post
and nested-content visibility remains independent. No public score, actor input,
certificate, stable numeric rank or readable score cursor is added. Live navigation
can repeat or omit moving posts across pages; caps count delivered slots.

Only complete native component coverage is enrolled. Missing historical coverage
is never zero, and stale inputs are withheld until refresh. Source formula version
6 and the pinned PostgreSQL numeric profile are retained; no PHP bit-equality or
verified deployed-formula claim is introduced.

Default processing is disabled. Automatic mode requires explicit coherent settings
and mounts only in the HTTP runtime. Manual application/CLI contexts do not start
jobs. No production activation, dependency, provider, reward or author received-
total adjustment was performed. Related distribution, historic import, auxiliary
hot widgets/suggestions, production query-plan/load proof and real-device acceptance
remain open. See [operation and behavior](../unified-public-hot-feed.md).

Certificate arithmetic and view input integrity retain the trusted database/owner
boundary: snapshot locking is not independent per-event receipt provenance for
privileged raw SQL increments. The partial-baseline rejection fixture is explicitly
rollback-only, not evidence a committed partially enrolled population was accepted.
Manual selected bootstrap remains fail-fast on a parent-lock/database error before
later IDs; automatic retry isolation is a separate tested behavior.

## Hosted verification

Verified SSH-signed commit `637ecf3c73d1c51895f8d0b9b51a9925ab03e31c` passed
[GitHub Actions run 37782713948](https://github.com/Xauryan/whaleu-next/actions/runs/37782713948):
631 API, 890 native and 1,084 PostgreSQL tests, 2,605 total with zero failures/skips.
PostgreSQL took 588.993 seconds. Lint, types, OpenAPI drift, builds, emitted smokes
and formatting passed. This does not activate the production processing modes.
