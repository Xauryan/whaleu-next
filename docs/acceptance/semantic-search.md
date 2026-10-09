# Semantic community search acceptance

Status on 2026-10-09 at 08:46 UTC: **final frozen-snapshot local acceptance
passed**. The final source fingerprint remained unchanged. Hosted CI, signed
publication, production deployment, real-device and real-provider acceptance are
separate remaining gates.

## Frozen candidate

- Source/test/config/asset snapshot: 1,342 files, SHA-256
  `9509826d75257c41d6c1112ba131a9d0e15af3caf790102c1e35608cb9e9e53a`.
- Generated OpenAPI snapshot: 8 files, SHA-256
  `961e3c8b67732640a68c22109bdf57a7c4884d12ff40803bdb5ffb1981182334`.
- Increment snapshot before this acceptance document: 64 files, SHA-256
  `00841fb405e2b62eca40103e6c1b573b535fb65bba77a51f8f493f6a0b13e8d2`.
- Documentation is outside the source snapshot so final evidence can be added
  after verification. Final log hashes are recorded below; the signed commit and
  published verification remain pending.

## Verification ledger

| Evidence                                                                        | Result                     | Scope and qualification                                                                                                                     |
| ------------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Final statistics unit tests                                                     | 5 passed                   | Final frozen candidate                                                                                                                      |
| Final search evaluation tool tests                                              | 20 passed                  | Synthetic evaluation tooling; not a model-quality comparison                                                                                |
| Final API tests                                                                 | 996 passed                 | Offline unit/contract checks                                                                                                                |
| Final native tests                                                              | 1,567 passed               | Synthetic native tests, not physical-device acceptance                                                                                      |
| Final main PostgreSQL regression                                                | 1,562 passed               | 1,221,947.513631 ms                                                                                                                         |
| Final semantic PostgreSQL integration                                           | 27 passed                  | 13,715.787895 ms; real PostgreSQL with stub model transport                                                                                 |
| Final aggregate                                                                 | **4,177 passed**           | Zero failures, skips or cancellations                                                                                                       |
| Final real-cloc gate                                                            | 1 passed separately        | Not added to the 4,177 aggregate                                                                                                            |
| Final lint, typecheck, OpenAPI generation, builds, native smokes and formatting | Passed                     | Final frozen candidate                                                                                                                      |
| Earlier focused PostgreSQL run                                                  | 48 passed                  | Complete exact-discovery-counts file plus semantic suite; not added to final totals                                                         |
| Historical candidate 3 repository check                                         | 2,588 passed               | Earlier candidate, retained as historical evidence only                                                                                     |
| Historical code-statistics gate                                                 | 1 passed                   | Earlier candidate, not added to final totals                                                                                                |
| First historical full PostgreSQL run                                            | 1,560 passed / 1,562 tests | One failing subtest plus its parent; UTC-text assumption described below                                                                    |
| Second historical full PostgreSQL run                                           | 1,560 passed / 1,562 tests | One failing subtest plus its parent; optional-count fixture coupling described below                                                        |
| Hosted CI                                                                       | Pending                    | Official PostgreSQL 18.6 / pgvector 0.8.7 image identity was verified; added workflow has not been executed on hosted CI for this candidate |

The final successful full runs supersede the historical failures for this frozen
candidate. Earlier focused runs and failed-run passes are not added to the final
total. The first repository-check retry was stopped by a policy restriction on an
unrelated npm version-notification registry request; rerunning with npm offline
mode and its update notifier disabled passed. This was not a real-model request.

PostgreSQL shut down normally after the final suites. At 08:46:38 UTC the parent
verifier confirmed that the PID file was absent and the runner lock was free.
No separate post-run SQL inspection of schema residue was performed; this record
does not claim that such an inspection passed.

### Final local log fingerprints

SHA-256 fingerprints of the final logs:

| Log               | SHA-256                                                            |
| ----------------- | ------------------------------------------------------------------ |
| `check.log`       | `06b2fabd51b60e6edbdf062797d7de724be7286bcd4ab0b1722e75d5c81a5c6b` |
| `format.log`      | `427b0c5b34c041d5422b0a9c8ec8e97c52f668433f3cd2caedc31d12a912bd17` |
| `cloc.log`        | `33c4fa735f9106b3cee5eb0ef221f3d043fbeb85df93d8ced7cb9c855b5003a1` |
| `pg-main.log`     | `e88bc76f901e7ddb6c0fb8df57270c37e1fc8a9178efba4725895a4b60098670` |
| `pg-semantic.log` | `3a8edededef806d4f70c6aeecafa56153bfe7b8fcf50762396bd69cf53c0e499` |
| `pg-runner.log`   | `d52c3d19b27719cac3b95cb56fbb6749d5ac0e8050f3edbc29e813a31e042d4e` |

## Implemented boundary

The original strict literal-search contract remains separate from the new
semantic endpoint. Semantic responses identify the actual mode and current index
status, return at most ten hits from an embedding-top-32 reranked candidate set,
and expose no semantic continuation cursor or fabricated total.

The full structural scope is evaluated before vector ranking. Canonical content
certificates and the Safety owner establish a current authorized relation;
unknown evidence or incomplete current authorized-vector coverage is unavailable,
not zero or an empty successful search. Denied content does not participate in
vector candidate budgets. The existing bounded canonical source proof remains
required before content can be supplied to the reranker or returned.

Source-generation tokens and full ancestry/review revisions prevent stale
indexing tasks from restoring deleted, withdrawn or superseded evidence. Index
writes require a fresh authorization/CAS transaction. Model waits occur outside
source-lock transactions. After reranking, a second independent transaction
revalidates the complete eligibility snapshot and candidate ordering, then
serializes fresh source content; an invalidated snapshot is not silently shortened.
Actor-authorized bounded batches and structural resume support historical
backfill, without granting a background worker unrestricted content access.

These are implementation and local synthetic-test claims, not authorization to
send real community text to an external service. See the
[design and activation gates](../design/semantic-search.md) for the precise owner,
coverage and lifecycle contracts.

## Corrections during verification

- The initial semantic throttle registration replaced the shared Nest throttler
  options and changed old routes' defaults. It was replaced with per-guard
  semantic options using the existing PostgreSQL storage. Regression assertions
  preserve old defaults and the separate semantic limit; focused old-route and
  semantic HTTP checks passed after the correction.
- A historical source-registry test required one UTC string representation of an
  internal SQL timestamp. The local PostgreSQL session used
  `America/Los_Angeles` and returned the same instant with `-07`. The test now
  checks both UTC and Los Angeles transaction-local sessions using PostgreSQL
  `timestamptz` equality, including the exact `.123456` microseconds and the
  resulting settlement record. Runtime timestamp handling was not changed.
- The durable guest source-proof test required a 4,097-row optional count to be
  known while also testing final source fencing. The observed failure retained
  available profile basics and a known zero trade count but returned an
  unavailable optional post count. That invariant test now uses the existing
  1,025-row fixture, still above the 1,024-row fallback limit, and retains the
  explicit source-fence assertion. Independent 4,097/25,000-row scale tests and
  production scan/final-proof/statement budgets were not changed. This does not
  establish a specific CPU cause or label the failure a random flake. The smaller
  fixture proves the source-fence invariant, not that 4,097 rows reliably fit the
  default budget with the SQL observer enabled. That performance-availability
  limitation remains visible and requires separate measurement.

## Disabled defaults and remaining acceptance

Qwen/Qwen3-Embedding-8B and Qwen/Qwen3-Reranker-8B are configured for the user's
fixed Tumuer gateway. Semantic search and external transmission default to
**disabled**. The separate SiliconFlow adapter is not an automatic fallback and
cannot receive a Tumuer credential through the Tumuer adapter.

No real gateway inference, real-community-content transmission, credential
configuration, paid request, model-quality comparison or remote immutable-weight
attestation was performed. Local tests use injected synthetic transports. Model
selection is not a measured quality winner. Actual activation needs the explicit
operational, data-transmission and secret-handling gates documented in the design.

The optional pgvector path retains all 4,096 dimensions and uses exact distance
search over authorized current vectors. It has no shared ANN index. Work remains
O(authorized vector count × 4,096), plus structural eligibility processing; the
100,000-row metadata safety cap is not a production latency guarantee. Synthetic
correctness fixtures do not establish large-forum throughput. Hosted models avoid
self-hosted inference GPUs, but PostgreSQL still needs CPU, storage and capacity
validation. Physical stale-vector cleanup and operational reindexing policies
remain deployment work.

Production migration/deployment, real-provider quality/cost/latency evaluation,
physical WeChat-device acceptance and final hosted verification remain pending.
Native builds and synthetic transport tests are not device or production proof.

## Publication follow-up

Local acceptance is complete for the frozen candidate above. The signed commit
and hosted run are pending and must be recorded only after they exist. Neither
publication nor hosted CI alone activates external model transmission or
constitutes production, device or model-quality acceptance.
