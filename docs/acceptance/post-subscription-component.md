# Local post subscription component acceptance

Local verification completed on 2026-10-08 against base
`764746ddebbd237f4c0f779b5e63948046d96983` plus this increment. Hosted CI for the
resulting commit is reported separately. This is an internal component, not a
complete hot-feed release.

## Frozen gates

All 672 source/test/config/asset files remained unchanged across the final gates.
Fingerprint: `4609a59eb06d5bcf802f34ac33b7bd03dd6d79cff89f00faee718a100365d03e`.
The [machine-readable evidence](post-subscription-component.json) records the full
manifest, hashing convention, log hashes and prior failed aggregate. Documentation
is excluded so evidence can be written after testing.

- `npm run check`: lint, strict types, 453 API and 784 native tests, both builds
  and emitted native smokes passed
- `npm run format:check`: passed
- `npm run test:integration`: 767 tests passed in 408.326 seconds
- Total: 2,004 passed, zero failures/skips
- PostgreSQL 18.6, launch-only maximum 100 connections, one-minute autovacuum
  scheduling, zero application schemas remaining and runner shutdown

## Verified scope

Fresh successful native publication enrolls zero in its existing transaction,
with exact creation/receipt/origin proof. Every preexisting post remains unknown,
including a genuine native publication created before migration 0026. Actual
save/unsave transitions supply independent causal provenance; epoch creation alone
does not establish a later removal. Self-save is included in this component.

The consumer applies only selected `save_ranking` obligations, with parent-first
serialization, exact membership epochs, numeric causal order, immutable receipts
and atomic effect/acknowledgement. A later negative cannot overtake its positive
or remove a re-saved epoch. Unknown or bad work does not prevent independently
selected posts from progressing. No public score, feed, search, exposure counter
or native page is added; received totals and experience rewards remain separate.

Real PostgreSQL HTTP/worker/CLI/proof acceptance passed 37 tests, followed by a
51-test Saved/component regression run. Cases include replay, concurrent workers,
rollback at effect boundaries, ended-epoch replay, hidden/deleted cleanup, large
sequences, independent actors and direct SQL source/receipt/state/membership
forgery. A born-ended known-post epoch hole found during review was explicitly
rejected and tested. Existing migrations are unchanged; only new 0026 is added.

The actual CLI runs with explicit selections, max 50 and local/disposable checks.
Dry-run is first-SQL read-only and disables other processors, even under inherited
automatic settings. Full application table snapshots and sequence
`last_value/is_called` snapshots remain identical. Source completion affects only
the selected action, and retries produce no duplicate effect.

## Aggregate fixture repair

The first full aggregate passed 765/767 PostgreSQL tests. An existing tied-timestamp
Saved fixture inserted epochs on freshly published known posts without their
same-transaction ranking obligations; the new proof guard correctly rejected it.
The fixture now holds each parent lock and calls the owning SavedRepository
obligation method in that transaction. Deliberately tied timestamps, pagination,
movement, empty-visibility and bound assertions are unchanged. Raw bulk legacy-like
posts remain unknown. Runtime guards were not relaxed. The final complete aggregate
above passed after this narrow correction.

## Remaining gates

This remains a fresh-post-only, explicit manual, local development component.
Known baseline and processing freshness differ: state can trail later pending
sources. Historical reconstruction/import, production processing, view/like/comment
components, effective formula configuration and public hot-feed/search/UI remain
open. Retained-source causal-head queries can grow with history; no fixed physical
query-work bound or production throughput claim is made. The separate received-total
deletion-policy decision is unaffected. No production data or real user action was
processed by these tests.
