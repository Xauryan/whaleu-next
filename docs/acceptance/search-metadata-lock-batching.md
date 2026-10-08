# Local search metadata-lock batching acceptance

Stage 1, verified 2026-10-08 against base
`1632952fd2b750b3f4e2a3fe2ca98937cf4fb946` plus this increment. Hosted verification
for this increment is separate. No deployment, production change, provider call
or new dependency is included.
[Machine-readable evidence](search-metadata-lock-batching.json) records every
frozen source/artifact hash, terminal totals, both full attempts, the test-only
synchronization correction, and measured SQL counts.

## Frozen final gates

All 929 non-Markdown source/test/config/asset files retained manifest fingerprint
`fd56099e0ae8a9b580a347d7e1b7f1b0c7c82fdeaa15f3b57c8e8e1fb471c3ab` throughout the
final aggregate. All five generated OpenAPI artifacts retained fingerprint
`cde136d5b7a3447a861d8ec15158f7dab7dbfc5057fa290874ea50cd496c95d2`.
Documentation is excluded from the source freeze.

- `npm run check`: exit 0, including lint, strict types, OpenAPI drift, builds
  and emitted native smokes
- `npm run format:check`: exit 0
- Unit totals: 5 statistics + 659 API + 914 native = 1,578 passed
- Complete `npm run test:integration`: 1,135 passed in 844.278414363 seconds
- Total: 2,713 passed, zero failures, skips, cancellations or pending tests
- PostgreSQL 18.6 (`180006`), isolated local cluster, launch-only
  `max_connections=100`; zero non-system schemas before and after
- Integration and runner exits 0; server stopped, confirmed by `pg_ctl status`
  exit 3; exact source/OpenAPI comparison exit 0

The separately successful focused tests are not added again to these totals.

## Narrow implementation

The search owner acquires candidate-ancestry metadata locks in at most three SQL
statements: referenced posts, roots and replies, in that order. Each statement
selects only the existing structural metadata and uses
`ORDER BY <alias>.id ASC FOR SHARE OF <alias>`. Canonical UUID inputs are bounded
to 130 per kind: the 128-candidate window, one sentinel and the previous visible
guard. Empty kinds perform no lock query. Existing candidate/reference queries
remain separate and unchanged.

The service rejects malformed, unexpected, duplicate, unsorted or wrong-kind
results. Missing metadata retains the previous handling and mandatory second
structural query. Complete ancestry, kind-qualified identities, parent/root
consistency, cursor guards, query-independent candidate selection, sequential
body authorization and final mandatory proof are unchanged. No canonical-approval,
Safety or cross-request cache is introduced.

The unchanged statement timeout now bounds an entire kind's batch, rather than
one scalar row query. Multiple contended rows can therefore exhaust that budget
sooner. No timeout increase or retry is added. The real timeout regression keeps
the existing sanitized HTTP 500 `INTERNAL_ERROR`, observes PostgreSQL `57014`,
checks rollback and released earlier locks, and verifies that no body or cursor
work occurred.

New regressions compare scalar and batch IDs, original snippets, logical cursor
positions, continuation and exact unknown/restart errors. Identical UUIDs across
post/root/reply tables and throughout one chain remain distinct. Maximum 130-node
per-kind guard/sentinel ancestry is covered without off-page body access.

Real lock tests block the middle UUID in each kind: lower UUIDs are held, higher
UUIDs remain lockable, all prior kinds are held, and later kinds remain unlocked.
Lock-wait deletion/hiding and newly eligible unheld children retain stable reread
behavior. Sentinel, anonymous/named ancestry, final relationship, review-expiry,
session/phone and cursor-rollback tests remain green. Independent review found no
blocking issue.

## First aggregate and deterministic test correction

The first full PostgreSQL attempt passed 1,133 of 1,135 tests in 843.100799448
seconds. One existing reporting test and its enclosing suite failed: the
765.220532 ms late-vote race expected `JURY_CLOSED` but received
`REPORT_TARGET_UNAVAILABLE`. Root check/format passed, source/artifact manifests
remained frozen, and database cleanup completed.

Source inspection established that the test invoked the vote but never observed
it waiting on the held post lock before starting the due worker. The vote has
session, request, rate and eligibility work first. If the worker acquires the post
first and removes it, current visibility correctly rejects the vote before its
jury-state check. This schedule strongly explains the original result; it was
not retrospectively proven because that run had no lock trace.

The unchanged-source reporting rerun passed 22/22. The authorized correction is
confined to `apps/api/test/integration/reporting.test.ts`: the test now observes
its sole pending vote's exact post UPDATE query waiting on the barrier backend,
using `pg_stat_activity` and `pg_blocking_pids`, before launching the due worker.
The strict `JURY_CLOSED` assertion and final zero keep / one remove vote outcome
remain unchanged. No reporting or settlement production code changed.

Three independent focused runs of the corrected test file passed 22/22 each
(10.082151432, 9.862762470 and 9.684384449 seconds), with complete cleanup. Independent
review confirmed the synchronization. The source freeze was refreshed and the
entire aggregate then passed as recorded above. The new final runs prove the
intended lock ordering.

An earlier focused benchmark assertion also exposed a fixture comparison issue:
it compared successor insertion with successor reuse. Priming the exact same
successor before both measured paths removed that unrelated SQL difference
without weakening the exact metadata-savings assertion or changing production.

## Actual paired SQL measurements

The unchanged synthetic fixture contains two posts, 1,300 roots and 1,300 replies.
Each request selects 129 structural metadata rows and consumes 128 nonmatching
candidates. The baseline executes frozen scalar owner SQL from `1632952` through
a test-only adapter; every other owner and final proof remains real. Both paths
reuse the same primed successor. Final aggregate measurements:

| Request           | Scalar SQL | Batched SQL | Saved | Scalar metadata | Batched metadata | Scalar ms | Batched ms |
| ----------------- | ---------: | ----------: | ----: | --------------: | ---------------: | --------: | ---------: |
| All child sources |      8,163 |       8,035 |   128 |             131 |                3 |  1,822.90 |   2,034.73 |
| Root source       |      5,795 |       5,666 |   129 |             131 |                2 |  1,484.58 |   1,368.92 |
| Reply source      |     10,533 |      10,403 |   130 |             133 |                3 |  2,157.95 |   2,341.05 |
| Within-topic      |      8,162 |       8,035 |   127 |             130 |                3 |  1,646.77 |   1,636.54 |

Complete endpoint SQL reduction equals exactly the metadata round trips removed,
with unchanged public results and logical cursor positions. Candidate SQL itself
took 0.382–3.185 ms. Actual default-planner
`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` evidence is retained in test diagnostics.
The machine-readable report also preserves the earlier focused measurements.

This stage removes 127–130 statements, roughly 1.2–2.2% of these requests' total.
Latency varied and did not consistently improve. These single local synthetic
observations are not an SLA, production throughput estimate or claim that
canonical proof cost is solved. The theoretical maximum remains 390 scalar
metadata queries versus three batches when window/sentinel/guard ancestry is
fully fragmented; that bound is not a measured endpoint speedup. Further proof
reuse is a separate increment requiring its own authorization and validation.
