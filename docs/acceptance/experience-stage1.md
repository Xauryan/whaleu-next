# Experience Stage1 local acceptance

Final integrated local verification completed on 2026-10-08 against base
`ca7dbd8eef35af041995e331b83508b1a5d7bc9e` plus the experience/source/native
implementation. This is local evidence; hosted CI for the resulting commit is
reported separately.

## Frozen source and gates

Fingerprint: `451ce4c782a4666edbd1ed821547ea8e1df900e43a82c477c4ce81c02164b663`.
All 613 source/test/config/asset files were unchanged across the final gates.
The exact manifest, hashing convention, log hashes and prior failed attempt are
recorded in [experience-stage1.json](experience-stage1.json). Documentation is
excluded from the source fingerprint so verified evidence can be written afterward.

- `npm run check`: lint, strict API/native types, 356 API and 763 native tests,
  both builds and compiled native smokes passed
- `npm run format:check`: passed
- `npm run test:integration`: 623/623 passed in 352.634 seconds
- Total: 1,742 passing tests, zero failures/skips
- In-run database confirmation: PostgreSQL 18.6, launch-only maximum 100
  connections, zero remaining application schemas; server stopped afterward
- `git diff --check`: passed

Use the root/API documented disposable PostgreSQL test workflow. No production
connection, historical import, external provider or real-account grant was used.

## Coverage

The integrated suite exercises genuine new-account zero versus existing unknown
baseline, independently retained undated history/title ownership, canonical fresh
source enrollment, complete beneficiary sets and independent ordered settlement.
It covers source-mapped shared quotas, self/deduplicated recipients, nominal versus
floor-clipped deletion, application-day refunds, capped replay, concurrency,
post-lock Shanghai-day sign-in, earned/retained appearance and durable notices.
Commit-time failure after Saved acknowledgement rolls back all owner effects and
recovers once. Historical outbox/obligations are not silently adopted.

Real native gateway/controller/HTTP/PostgreSQL acceptance covers lost post-like,
sign-in and appearance responses; intervening unlike; separate pending journals;
stale callback and session handling; undated pagination; retained high color after
downgrade; hidden-source reward privacy; local automatic processing backoff and
restart; and CLI dry-run with all inherited processors automatic. Full table and
sequence snapshots verify that dry-run remains inert.

Compiled native handlers cover read-only page loads, explicit coalesced foreground
commands, hide/reopen recovery, unknown baseline and undated-title/base-color
selection. Public/native privacy and discussion navigation regressions remain in
the complete aggregate. Physical device/provider behavior was not tested.

## Integration failures resolved before this pass

The first aggregate passed 595/610 PostgreSQL tests and failed 15 including enclosing
suites. It exposed an actual interaction between new deletion provenance and the
existing trading whole-row guard, and loss of microsecond source timestamps during
JavaScript conversion. Only the new provenance triggers were moved after existing
guards; old immutable definitions were not weakened. Capture and ledger insertion
now preserve exact PostgreSQL timestamp text. Explicit ordering, metadata-forgery,
trading/formation deletion and source-to-ledger microsecond regressions passed.

Two expectations were also updated without relaxing privacy: the count migration
must be present, but need not be the newest feature migration; formation's internal
publication event can contain its exact required actor/mode provenance, while
public receipt/contact/identity leak checks remain strict. Separate historical
fixtures now seed canonical pre-0019 data directly, apply full migrations and only
then start current AppModule. Genuine migrated null dates, old records, canonical
approval bindings and all count/privacy/pagination assertions are retained.

## Remaining gates

This local owner slice is partial feature parity. Representative-history ledger
throughput is not established by these small correctness fixtures; full-history
reconciliation scans require measurement before a production performance claim.
Production worker activation, historical baseline reconciliation/import, public
experience and received-interaction displays, rankings, redemption, global title
maintenance and provider/device acceptance remain outstanding. See the
[experience API boundaries](../API_EXPERIENCE.md).

## Subsequent verification

Signed snapshot `8f4eee24bff7fb35608b9bb56e50685fad8800d6` also passed
[hosted CI](https://github.com/Xauryan/whaleu-next/actions/runs/37720411199):
356 API, 763 native and 623 PostgreSQL tests, zero failures/skips. A separate
[bounded history benchmark](experience-history-capacity.md) subsequently measured
1,000/10,000 settled units with all constraints enabled. Its warm-cache worker
latencies do not establish production or automatic backlog-drain capacity.
