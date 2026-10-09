# Ratings R3R acceptance

Local implementation on the rewrite branch; no production activation, import,
provider, credential or publication action. The [API](../API_RATINGS_RANDOM.md)
records new explicit semantics and complete streaming admission. This is not
production-load acceptance or proof of legacy SQL equivalence.

## Implemented

- Native campus institution-wide scope with bidirectional accepted topology and
  current physical inventory reconciliation, then separate per-region access
- Selected category plus all visible descendants and global catalog membership
- Complete candidate streaming, explicit whole-request budget failure, uniform single draw
- Exact inclusive raw-average filtering, known-zero/unknown distinction
- Canonical lifecycle, Review, summary and final-proof reuse
- Strict HTTP/OpenAPI and native request/response contracts
- Separate explicit-scope native selection page, cancellation and stale-result isolation

## Verification record (2026-10-09, local pre-merge slice)

- Focused API owner/contract/service tests: 94/94 passed. Coverage includes
  1001/2048 streams, independent 10,000/10,001 admission, strict source handles,
  copied/skipped/replayed/read-epoch batches, unknown/deny, exact deadlines,
  metadata ABA, fixed final proofs and complete campus inventory reconciliation.
- Native focused tests: 30/30 passed, including actual native handlers/WXML plus
  real ApiClient/gateway, 2048 pool count, explicit campus choice, returned-catalog
  context wording/navigation, unknown/zero/empty, cancel/hide/session/Safety races.
- Real PostgreSQL 18.6: initial pool/proof run 8/8 passed; lock/proof rerun 4/4
  passed; campus/path-dedup run 1/1 passed. These runs overlap and must not be
  summed as unique tests. Normal-AppModule 1001/2048 pools reach a deterministic
  last target; denying the first 128 leaves the complete remaining 1920 pool.
  Two-client checks cover unselected score threshold change/ABA, pending score
  and binding writers, and a raw authority writer waiting at the actual Safety
  advisory barrier while an already-authorized normal score completes.
- Campus PG covers three campuses across two authentication groups, all-regions
  authorization, duplicate global paths counting once, actual returned-catalog
  detail reads, and a new unreviewed active sibling failing the whole scope.
- Emitted WeChat build and its full native smoke passed after adding a meaningful
  random-page `loaded` state: successful draws (including proven empty pools)
  set it true; invalidation, failure, cancellation and hide reset it false.
  A dedicated lifecycle regression covers these transitions. The first aggregate
  run found this missing common-page state; no smoke assertion was removed.
- API TypeScript passed; changed-source ESLint and diff checks passed.
- OpenAPI regenerated; both deterministic/offline artifact and all 48-operation
  exact schema/auth/error metadata tests passed.

The prior R1/R2/R3A total is not reused as evidence. Full integrated checks,
all PostgreSQL regressions, final frozen manifest and
publication/backup are owned by the parent integration pass. Local source tests
are not WeChat device rendering or production/load acceptance.

## Open gates

- Representative production load/throughput acceptance; whole-request budgets
  fail closed rather than returning a truncated sample
- Exact legacy random query/threshold/no-score source details not recovered
- Legacy school→native campus crosswalk and real catalog/score source acceptance
- Native device, provider and production rollout acceptance
