# Errands E1/E2A/E2B acceptance status

This increment is text-only and PARTIAL. See [API contract](../API_ERRANDS.md) and
[feature parity](../FEATURE_PARITY.md). No production issuer, real-provider call,
real privilege grant, production data, dependency addition or deployment was used.

## Frozen complete local gate (E1)

Validated 2026-10-08 against base commit
`ad438a304a452da90aee7de1c7ca26616533eec1` plus this E1 increment.
The source freeze included 1,039 tracked and untracked source/config/test files;
documentation was excluded, and all seven generated OpenAPI artifacts were frozen
separately. Canonical source-manifest SHA-256:
`921848a2644a7e234b6f7ed0ca9d189c7661a351aa7625f976d6c5097ff44acd`.
Seven-artifact manifest SHA-256:
`61e267a758afe42fb307953e21b48ca2f3ddf1614699af358ab9b379d9c29305`.

- Complete `npm run check`: exit 0, 19:49:56–19:51:07 UTC, including lint, strict
  types, all seven OpenAPI drift checks, unit tests, builds and emitted native smokes
- Complete `npm run format:check`: exit 0, 19:51:07–19:51:21 UTC
- Unit totals: 5 root statistics + 711 API + 1,063 native = 1,779 passed
- Required real-cloc integration: 1/1 passed separately using the existing
  checksum-verified cloc 2.10; no download, install or dependency audit
- Complete serialized `npm run test:integration`: 1,222 passed, 19:55:07–20:09:55 UTC,
  duration 887.494657961 seconds
- Main combined denominator: 3,001 passed; zero failures, skips, cancellations
  or pending tests. The separate real-cloc integration is not added again.
- PostgreSQL 18.6 (`180006`), isolated disposable loopback database; actual
  launch-only `max_connections=100`, zero application schemas before and after
- Final integration and runner exit 0; PID file absent and server stopped, verified
  in the same runner execution namespace
- Frozen source, all seven OpenAPI files and persistent PostgreSQL configuration
  unchanged before/after the final PostgreSQL gate; whitespace checks pass

Focused development runs below are not double-counted in the aggregate. Hosted verification and deployment are separate.
The independent E1 source/privacy review had no outstanding material findings.

### Test orchestration corrections

The first orchestration passed complete check and format, then stopped because the
private wrapper omitted the required `CLOC_PATH` test precondition. Its failed
status is retained; it is not called a successful wrapper. Supplying the existing
checksum-verified executable made the required real-cloc integration pass 1/1.
Those earlier successful components remained valid because frozen bytes did not
change.

An initial PostgreSQL aggregate used the persistent 50-connection default. It was
interrupted before a product failure to restore the established 100-connection
concurrency-suite precondition. The exclusive locked runner recovered the isolated
cluster, inspected and removed only the interrupted run's disposable fixture
schemas, proved zero schemas, then shut down normally. No active runner lock was
bypassed or PID file manually removed. The final complete PostgreSQL suite started
from a verified empty database with a launch-only 100-connection override; the
persistent configuration stayed unchanged. No test or implementation source was
edited during these gate attempts.

## Focused development evidence

- Fresh API strict schemas preserve 1–500 exact decimal strings up to 100 digits
  without cent rounding; Unicode/source form bounds and contact distinctions
- Canonical errand review is separate from post scope/category semantics; shared
  approval metadata validation remains compatible with post/comment/reply tests
- Normal AppModule and disposable PostgreSQL 18.6 exercise source/target region
  separation, related/foreign own-only discovery, cross-region single-winner
  acceptance, immutable participant scope and campus-change relationship survival
- Completion/cancellation retain private participant text while removing opposite
  contacts; publisher soft-delete preserves lifecycle and historical completion
- Feature publish/accept/all, whole-account and phone gates are distinct; reviewed
  temporary base and current role grants cannot fabricate publication affiliation
- Eight simultaneous claimers produce one winner, one accept transition/notice and
  one preference update; competing lifecycle commands do not overwrite outcomes
- Same-key retry and changed-intent conflict; unknown/unavailable review leaves no
  terminal request; notification insertion failure rolls back state/history/receipt
- Real independent-connection waits prove temporary/grant and phone expiry after
  order locks/quota waits; deferred review-consumption expiry rolls back publication
- Rejected-command savepoint rollback restores provisional managed deadlines
- Numeric reward keysets retain precision/ties in both directions; opaque cursor
  scopes bind owner/session/endpoint/query/campus/topology and contain no private
  text, contact values or public text bodies
- SQL rejects private deletion, edited scope/definition, illegal lifecycle edges,
  missing/pending/false receipts, phantom transitions and causal notice mismatches
- Actual native errand and notice gateways cross normal HTTP/PG for publication,
  dropped-success recovery, detail privacy, own/contact histories, notices, read,
  completion and deletion. This is executable transport acceptance, not a device test.
- Swagger generation is official, deterministic and offline; every route has exact
  strict outputs, auth and private cache headers, with sanitized error contracts

The final focused normal-AppModule PostgreSQL run passed 23/23 before the complete
frozen gate. These cases are also included in the 1,222-test integration aggregate.
The 18 new API/review/OpenAPI tests and 133 added native tests are included in the
complete unit totals above. The actual native-gateway roundtrip is transport
acceptance, not physical-device acceptance.

Pre-freeze fixes addressed causal transition/order/receipt proof in both directions,
private snapshot deletion protection, notice deduplication and causal obligations,
reviewed region-column equality, bounded pending/foreign-own keyset indexes,
chronology and output coherence, safe malformed decimal rejection, and real
`ERRAND_NOT_FOUND` notice navigation privacy clearing. An initial SQL CASE parse
error and a test expectation for the shared BAD_REQUEST error were corrected;
focused checks were rerun afterward. No authority bypass or allow-all override
was used to obtain a passing result.

## Open parity and release gates

Read-only historical listing/search with exact-or-unavailable totals is covered
by E2A below. Full E2 still requires administrative delete and
sanctions/release/history;
private/public media ownership/review/delivery and re-review; group/help/QR
preferences, short links and per-destination two-stage promotion; external issuer,
provider and scheduler readiness; source schema/precision/timezone/data mapping and
restore rehearsal; native-device acceptance across independent accounts/regions.
No payment, refund, commission settlement or runner-rating claim is added.

## Hosted verification

Verified SSH-signed commit `07370757703610f1a530f050275b706f0a11f36e` passed
[GitHub Actions run 37837837903](https://github.com/Xauryan/whaleu-next/actions/runs/37837837903),
job 113519343748. Actual logs confirm 5 statistics, 711 API, 1,063 native and 1,222
PostgreSQL tests: 3,001 passed with zero failures/skips/cancellations. PostgreSQL
took 922.065057595 seconds. All seven OpenAPI checks, emitted errand smoke, full
check, formatting and Docker container/network cleanup passed. All 1,039 published
source files and seven OpenAPI artifacts match the tested freeze.
[Automatic statistics publication](https://github.com/Xauryan/whaleu-next/actions/runs/37837837806)
also passed its five offline tests and separate real-cloc test; the live SVG
matches the exact committed SHA. E1 remains partial; production issuer, device,
provider, administration, media and migration gates remain separate.

## E2A read-only increment: complete local gate

Validated against base commit `07370757703610f1a530f050275b706f0a11f36e` plus
this E2A read-only historical administration increment. Existing E1 hosted
evidence above is not an E2A CI claim; hosted verification is separate from
these local results.

Final E2A source freeze: 1,068 tracked/untracked source, configuration and test
files (documentation excluded), SHA-256
`7fb9b064427e1ab80696623bb81d8ac53f286fd594bd2346ea06adbcdf15a98d`.
All seven generated OpenAPI artifacts were independently frozen; manifest SHA-256
`1282c4f8145e03e158bb076fc9a5a87233db9aa33c2c7f067ed370e8c1724f35`.
The focused source/privacy review had no unresolved material findings.

- Complete `npm run check`: exit 0, 21:05:08–21:06:17 UTC, covering root lint,
  all strict types, seven offline OpenAPI checks, unit suites and emitted native
  builds/smokes, including the read-only errand administration page
- Complete `npm run format:check`: exit 0, 21:06:17–21:06:31 UTC
- Unit totals: 5 root statistics + 735 API + 1,082 native = 1,822 passed
- Complete serialized `npm run test:integration`: 1,242 passed,
  21:06:32–21:21:31 UTC, duration 897.792348623 seconds
- Main combined denominator: 3,064 passed; zero failures, skips, cancellations
  or pending tests. Focused development runs are not counted again.
- Required real-cloc integration: 1/1 passed separately using existing
  checksum-verified cloc 2.10; no download/install or dependency change
- PostgreSQL 18.6 (`180006`), disposable loopback database, actual launch-only
  `max_connections=100`; zero application schemas before and after
- Final runner exit 0; server stopped, PID file absent and runner lease released
- Source freeze, all seven OpenAPI artifacts and persistent PostgreSQL/HBA
  configurations remained byte-identical throughout the complete gate
- Actual native gateway→ordinary AppModule E2A roundtrip and existing E1
  lifecycle/concurrency/native regressions passed. A separate focused launch-only
  `max_connections=128` run proved small-count fallback with epoch proofs disabled.

### E2A focused development evidence

- Ordinary AppModule focused scope/privacy suite: 9 tests passed, including all
  six statuses, exact school/global authority, current names/public UUIDs,
  numeric-mapping unavailability, selected-grant expiry, ignored irrelevant
  short grants, profile creation/rename and E1 tombstone races after cursor waits
- Supplemental ordinary AppModule proof suite: 10 tests passed, including 1,032
  canonical service publications with old tied microsecond timestamps; >1,024
  exact streaming; sparse empty-more negative facts; equal-cardinality name swap
  and count change beyond the first 101 candidates; legal E1 status-entry race;
  deferred-constraint barrier; active Profile writer NOWAIT failure and completion;
  malformed old coordinate degrading only the total; parser/privacy headers
- Unit proof coverage includes empty/end membership changing at finalization,
  no count capacity with a valid page, large bigint values, shared mixed-domain
  admission and savepoint capacity recovery. Existing discovery/count owner and
  finalization tests are retained through the mechanical shared-runner extraction.
- Focused PostgreSQL runs used isolated 18.6 with zero application schemas after
  cleanup and a stopped runner afterward; these support, and are not added to,
  the complete aggregate above.

No administrative mutation/capability, ban, restriction issue/release/history,
notice writer, external provider or production action is present in E2A. E2B and
all E3–E5 limitations remain open. Legacy numeric UID mapping is unavailable;
public UUIDs are not aliases for internal account IDs.

### E2A hosted verification

Verified SSH-signed commit `7536756156dbf225a05e3a4bc8a0b837e84f6636` passed
[GitHub Actions run 37846874412](https://github.com/Xauryan/whaleu-next/actions/runs/37846874412),
job 113549816152. Actual logs confirm 5 statistics, 735 API, 1,082 native and 1,242
PostgreSQL tests: 3,064 passed with zero failures/skips/cancellations. PostgreSQL
took 1,162.369387767 seconds. Seven OpenAPI checks, full check/format, emitted
administration-page smoke and container/network deletion passed. All 1,068
published source files and seven OpenAPI artifacts match the tested freeze.
[Automatic statistics publication](https://github.com/Xauryan/whaleu-next/actions/runs/37846874522)
also succeeded; the live SVG matches the exact commit. This verifies E2A only;
E2B mutations and all remaining provider/device/import gates stay separate.

## Frozen complete local gate (E2B)

Validated 2026-10-08 against base commit
`7536756156dbf225a05e3a4bc8a0b837e84f6636` plus this E2B increment.
Independent focused review found no remaining material blocker before the final
freeze. The final native verification used the same DTOs and unchanged source.

- Frozen source/config/test files: 1,115; source-manifest SHA-256
  `dedbf399877cd742b8691478eb348b417c25be5e10d78c0699a5e69ba4ea9471`
- Seven generated OpenAPI artifacts, independently frozen; manifest SHA-256
  `58807bc2520fb800c9384694667e1a4c6d23aa5f47aea0ffc581f6b71f1aa984`
- Complete `npm run check`: exit 0, 22:43:01–22:44:10 UTC, including lint, strict
  types, all seven OpenAPI drift checks, unit tests, builds and emitted native
  WXML/gateway smokes
- Complete `npm run format:check`: exit 0, 22:44:10–22:44:24 UTC
- Unit totals: 5 root statistics + 758 API + 1,125 native = 1,888 passed
- Required real-cloc integration: 1/1 passed separately at 22:44:25 UTC using the
  existing checksum-verified cloc 2.10; no install or dependency change
- Complete serialized `npm run test:integration`: 1,305 passed,
  22:44:26–22:59:33 UTC, duration 907.276981379 seconds
- Main combined denominator: 3,193 passed, zero failures/skips/cancellations.
  The separate cloc test and focused development runs are not counted again.
- PostgreSQL 18.6 (`180006`), isolated disposable loopback `whaleu_test`, actual
  launch-only `max_connections=100`; zero application schemas before and after
- Final runner/gate exit 0 at 22:59:34 UTC; server stopped, PID absent and exclusive
  runner lock released; persistent PostgreSQL configuration unchanged
- All 1,115 source files and all seven OpenAPI artifacts match the same freeze
  before, during and after the full gate. Whitespace checks pass.

### E2B implementation and focused evidence

Scoped deletion retains the original lifecycle and completion history. Optional
publisher restriction is atomic with deletion, audit, materialization, notices
and receipt. Restricting an accepter leaves the order revision unchanged and does
not manufacture a lifecycle transition. Exact school/global authority is distinct
from the resulting account-wide feature effect; global history/release remain
global-only. Own deletion uses E1, while a publisher-admin may independently
restrict another accepter under current exact-target authority.

The 106-test affected PostgreSQL regression passed before the full freeze,
including ordinary AppModule HTTP and actual native gateways. It covered:

- Direct, noncooperating role-grant writers before/during/after the final NOWAIT
  fence, future activation, selected-grant expiry, insufficient lock privilege,
  unchanged target-row locks and bounded target-account/Safety inversion
- Combined-command rollback after late role changes, expiry, notice faults and
  receipt faults; original-key recovery with no partial lifecycle/ledger/notice
  effects; multiple managers and competing E1 acceptance/cancellation
- Immutable request/intent/event/transition/materialization/notice linkage;
  wrong target/action/reason/duration, missing obligations, stale/late predecessor
  claims and later sanctions appended to an old delete-only request are rejected
- Unknown historical audit independent of current effective coverage; baseline
  terms and release times retained; no invented operator or past issuance;
  independent actions, exact release, supersession and derived expiration
- 256 effective-fact capacity fails closed without truncation, while 257 recorded
  definitions remain pageable. Missing/conflicting/future/currently expired
  coverage cannot be reset or renewed by an administrative action.
- Legacy baseline UTF-16 acceptance remains unchanged. New 255-code-point local
  reasons, including astral characters, require real local definition and
  materialization evidence; mixed snapshots immediately enforce through E1.
  Copying a known restriction UUID to another subject fails unavailable.
- Exact PostgreSQL microsecond effectiveness and scheduled-role deadlines.
  Deterministic one-microsecond probes explicitly substitute the database instant
  in the actual owner query; separate races and ordinary HTTP use unmodified
  clocks. These probes are not claims of wall-clock scheduling precision.
- Expired filters initially returning zero still retain the upcoming active end
  as a deadline. Profile display changes fail final proof; changed public-reference
  ownership or committed source versions restart opaque continuation. Independent
  raw event writers cannot hide committed changes using an overridden sequence;
  rolled-back events do not create a visible source version.
- Original-session cleanup followed by freshly authorized receipt recovery;
  actual native issue/list/history/release/replay/receipt and baseline-release
  decoding; all five durable notice variants, monotonic read/unread and hidden
  order-detail recovery without private participant fields

### Development failures retained and corrected

Focused attempts before the final freeze were not all green. The record retains
an initial runner PATH failure before tests, a PL/pgSQL CASE syntax error, an SQL
alias/record-variable ambiguity and invalid synthetic fixture fields. Later
focused tests exposed existing-local Unicode facts being checked as new baseline
inserts before `ON CONFLICT`, unrelated copied baseline identities interfering
with known-ID release, and a stale Profile-bound cursor returning a generic error
instead of explicit restart. Each was corrected and its affected paths rerun.
No lock/proof constraint was disabled, legacy baseline acceptance was not widened,
and the final complete gate used one unchanged source freeze.

### Remaining acceptance boundaries

This closes the bounded text-only E2B implementation and local verification. It
is not complete errand parity or production readiness. E3 media, E4 external/group/
QR/help delivery, E5 authoritative migration, complete historical identity/audit
reconciliation and real-device/provider acceptance remain open. No production
account data, real grants/restrictions/deletions, provider calls or dependency
changes were used. Deployment must separately verify the actual application
role's final table-lock privileges; no persistent privilege expansion was made.
Hosted CI for this E2B publication commit remains separate from this local gate.

### E2B hosted publication verification

Published commit `fef997fe1b7d3581fa4e12f636bc37d6bda8c412` subsequently
passed [the hosted foundation workflow](https://github.com/Xauryan/whaleu-next/actions/runs/37857580838)
(job `113585364406`). The hosted total was **3,193 tests**: 5 statistics,
758 API, 1,125 native and 1,305 PostgreSQL tests, with zero failures,
skips or cancellations. The separate real-cloc integration test also passed.
Hosted PostgreSQL duration was 1,206.797726668 seconds; the workflow removed
its database container and network. The local zero-schema cleanup assertion
above is separate evidence, not an assertion printed by the hosted workflow.

The published 1,115 source files and seven OpenAPI artifacts matched the
verified freeze. [The statistics workflow](https://github.com/Xauryan/whaleu-next/actions/runs/37857580851)
also succeeded and refreshed the branch image. This hosted result does not
close the remaining production privileges, provider, migration or real-device
acceptance boundaries described above.
