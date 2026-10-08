# Local bounded view-reporting acceptance

Verified 2026-10-08 against base `83230f92ae6f49ec91d6d0d02d041615033918db`
plus this increment. Hosted verification is reported separately. No production
service, provider, account data or deployment was used.

## Frozen complete gates

All 748 source/test/config/asset files retained fingerprint
`e093b1df20c973b9a6119ddbd83a3e3afcd7479b65200ad1f1c45b98ebce68f8` throughout
final verification. [Machine-readable evidence](view-reporting.json) includes file
and log hashes; Markdown and docs are excluded from the source freeze.

- Lint, typecheck, 525 API tests and 842 native tests passed
- Builds, emitted native smokes and formatting passed
- 891 PostgreSQL tests passed in 589.158 seconds
- Total: 2,258 passed, zero failures/skips
- PostgreSQL 18.6, launch-only 100 connections, one-minute autovacuum; zero remaining
  application schemas and runner stopped

The first aggregate attempt passed API/native tests but failed 12 PostgreSQL test
entries: six direct storage assertions, two cascading profile cases and four
parent suites. Constructing the new view queue unnecessarily persisted an empty
owner document. No private DTO had been stored. Empty/no-change cleanup now stays
read-only; a new regression proves zero writes through unrelated hydration,
cleanup, hide and logout. All 52 tests in the four unchanged affected suites passed
before the final complete rerun. No old privacy assertion was weakened.

## Scope and executed proof

The 31 new PostgreSQL cases cover actual guarded publication enrollment, old
nonenrollment, phone-unverified reporting, directional list/direct privacy,
multiset replay/conflicts, detail cooldown, receipt/count atomicity, epoch expiry,
capacity and cleanup races. Existing like/subscription fixtures add only the new
constructor dependency or real fresh enrollment after current migrations; their
historical records and deliberate negative-proof assertions remain intact.

Real scheduler acceptance waits for the official 60-second idle sweep, verifies
cleanup without request traffic and waits for in-flight database cleanup during
shutdown. Shared limiter tests cover concurrent instances and request-budget
persistence after a failed business transaction. Cleanup retains live/locked
receipts and preserves aggregate counts. Deferred-expiry instrumentation preserves
multi-result SQL responses; its initial observer defect was fixed in tests, not
production deadline machinery.

Native acceptance adds 25 tests and compiled feed/detail smoke coverage, including
viewport boundaries, once-per-presentation detail, no recount on appended pages,
ready-epoch reattachment, offline/logout expiry pruning, exact receipt matching,
owner isolation and harmless late settlement after expected expiry removal.
Vetted SHA-256 executes in an emitted no-Node/no-npm-resolution VM. Independent
review also checked standard/Unicode/large-input hashes and relative imports.
This is synthetic emitted-page testing, not physical WeChat device validation.

## Reuse and publication review

Exact pinned additions are @nestjs/schedule 12.0.2, @nestjs/throttler 6.7.1 and
js-sha256 1.0.0. The lockfile adds six packages including cron 4.4.0, luxon 3.7.2
and @types/luxon 3.7.6; existing dependency versions are unchanged. All six declare
MIT licenses and registry integrity values. Production dependency audit reported
zero vulnerabilities at the check; this is not a guarantee of absence of defects.
Native distribution and license bytes match the installed package. Independent
review did not rehash unavailable cached tarballs and does not claim it did.

Independent safety review identified and verified fixes for observation
recounting, readiness, network-independent pruning, late expired settlement and
epoch-collection boundary responses. Publication review found no apparent secrets,
private source material, personal fixtures or internal-note paths. Existing safety
and final-deadline owner implementations remain unchanged.

## Boundaries

The approved recovery boundary is 24 hours from epoch issuance; hourly collection
means ordinary observations have about 23–24 hours remaining. Expired uncertain
work is never repackaged. Aggregate counts survive metadata cleanup. Capacity and
rate values are engineering defaults, not claims of legacy parity.

Logical admission expiry and a functioning cleanup schedule do not establish
exact-instant physical erasure from suspended clients, stopped services or
backups/WAL. Deployment retention verification remains open. No public view count,
hot score, search exposure, historical view reconstruction or author received-total
policy is delivered by this slice.

## Hosted verification

Verified SSH-signed commit `d20a0880d75e69e4ed536c83772930b5664f7810` passed
[GitHub Actions run 37756410832](https://github.com/Xauryan/whaleu-next/actions/runs/37756410832):
525 API, 842 native and 891 PostgreSQL tests, 2,258 total with zero failures/skips.
PostgreSQL acceptance took 746.849 seconds. Lint, typecheck, builds, emitted native
smokes and formatting passed. This is hosted acceptance, not a production rollout.
