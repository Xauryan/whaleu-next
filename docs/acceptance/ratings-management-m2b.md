# Rating management M2B acceptance

Status: isolated focused acceptance passed; integrated full acceptance is pending.

## Executed evidence

- API unit: 1,174 passed, zero failed/skipped.
- Native unit: 1,756 passed, zero failed/skipped.
- New M2B PostgreSQL suites: 87 passed across owner, integrity, history, races,
  mixed-pool and native HTTP roundtrip files.
- M1/M2A PostgreSQL compatibility: 47 passed across three management suites and
  five owner-deletion suites, including the genuine 0055→0056 upgrade.
- OpenAPI generation/check and the complete emitted native build passed.
- API TypeScript, native runtime/test TypeScript, changed-file formatting and
  lint passed in the preceding short validation window. The later output-schema
  fix and its new test assertions were formatted and passed OpenAPI compilation
  and all units; a final isolated API-test TypeScript/lint repeat was not run.

The first API TypeScript attempt found three history-fixture typing errors,
subsequently corrected. The next window found an OpenAPI response-transform
error. Context responses now reuse the existing canonical public target text
schemas; the input's normalization remains unchanged. Both failures and their
subsequent successful gates are retained in the delivery evidence.

One tool session was interrupted during OpenAPI check. Its result was treated
as unknown, and check/build were explicitly restarted under a renewed lease.
The interrupted and successful logs remain separate. Both real PostgreSQL runs
used the authorized disposable test-runtime runner, with normal server shutdown.

## Source baseline and outstanding gates

Baseline is the full M2A source tree
`11f394391a2afb4bf6143f3ac6d07b826bbc293b`, captured by write-tree without a commit.
This original baseline is not a signed release. Main and frozen M2A were not
modified. Migrations 0001–0056 remain byte-identical; M2B adds only 0057.

Integrated repository check, final merged-tree TypeScript/lint, full PostgreSQL
and semantic regressions remain required. No physical-device, hosted CI,
real-provider/source, production-import or deployment claim is made.

## Historical fixture boundaries

M2A SQL-upgrade acceptance retains the real 0055→0056 prefix and its assertion
that M2A alone introduces no definition tables. Its historical root is written
through an explicitly selected 0055 canonical SQL/Review/Experience fixture,
without running the current 0057 publication service against old schema.
M2B separately passed the real 0056→0057 upgrade suite.

M2A history assertions retain every old lifecycle-to-definition row and require
exactly one new deletion lifecycle mapping to the unchanged definition. They do
not broadly relax historical row-count or hash checks.

Main's separately added M1 `rating-legacy-upgrade-fixture.ts` is absent from this
source baseline. Integration must narrow its publication envelope to exactly
comment/reply while preserving its genuine 0051/0052 prefix and all SQL guards.
A separate minimal integration-only patch is supplied for that adaptation.

The OpenAPI test preserves root's four owner-deletion routes and adds five
owner-edit routes: exact 61-operation count, full schemas, authentication and
error/header checks. Its integration diff is based on root's accepted 56-route
version rather than the old 52-route index version.

## Independent review and complete-pool evidence

Read-only review identified missing real-PG cases, which were added and passed:
predecessor Review visibility/policy, catalog and ordinary-affiliation deferred
expiry; five interaction kinds in both gate orders; and a 529-target, five-batch
mixed-v1/v2/v3 pool. The pool tests restore both superseded versions to allow
before testing current-v3 denial/uncertainty, so erroneous fallback cannot be
masked by old denials. Pending new-binding writers and complete tentative-chain
rollback are observed through real PostgreSQL results, not fabricated rows.

The two notification-preview invalidation files also received independent M2A
acceptance and are identical to main's accepted version. M2B integration skips
those duplicate changes. They fix stale previews and late navigation while
retaining session/cancellation protection and persisted notice/read history.
