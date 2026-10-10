# Scoped ratings M3B acceptance

Status as of 2026-10-10 UTC: implementation, isolated focused validation and
integrated whole-repository regression passed. Signed publication and hosted
release checks remain pending. This record is not a
production activation, production-data migration, provider or device acceptance
claim. See the [API contract](../API_RATINGS_SCOPED.md).

## Integrated local acceptance

The integrated runtime and test tree passed 5,364 tests with zero failures, skips
or cancellations: code statistics 5, search evaluation 20, API 1,293, native 1,947,
complete PostgreSQL 2,072 and semantic PostgreSQL 27. Lint, type checks, exact
OpenAPI, all builds/smoke, formatting and diff checks passed. The complete database
stage finished on 2026-10-10 at 01:34 UTC. All 1,814 frozen source-file hashes
matched afterward; only these acceptance-status documents were then updated and
format-checked. The isolated 654-test evidence below remains distinct.

## Implemented scope

- All 39 exact authenticated v2 routes and eight scoped command operations
- Exact campus navigation, independent global view and complete
  institution-plus-global random selection
- Current Campus/source/Review v5 proof, immutable compiler output, typed
  compatibility, independent opaque adoption and atomic protocol activation
- Legal original-intent legacy write bridges; shared business state, request
  namespace, effects and historical receipt/cleanup contracts
- Native journal v9 alongside byte-preserved v1–v8 recovery
- Current recipient-scoped fan-out and explicit current notice-locator recovery

Migrations 0062–0065 implement the forward schema changes. Historical migrations
0001–0061 remain byte-identical. The genuine baseline-upgrade test checks retained
old rows, request hashes, receipts and source semantics; test-only synthetic
issuance does not represent production adoption.

## Executed final gates

The final source tree passed these checks without a runtime/test edit between the
final cheap gate and the final combined PostgreSQL gate:

| Gate                                          | Result                                |
| --------------------------------------------- | ------------------------------------- |
| `npm run format:check`                        | Passed                                |
| `npm run check`                               | Passed                                |
| Lint and all-workspace TypeScript             | Passed                                |
| Code-statistics units                         | 5 passed                              |
| Search-evaluation units                       | 20 passed                             |
| Exact generated OpenAPI check                 | Passed                                |
| API unit tests                                | 1,293 passed                          |
| Native unit tests                             | 1,947 passed                          |
| All workspace builds and emitted native smoke | Passed                                |
| Focused real PostgreSQL combination           | 654 passed, 0 failed/skipped/canceled |
| Historical migration byte comparison          | Passed                                |

The PostgreSQL combination used PostgreSQL 18.6 on a disposable loopback database,
`node --import tsx --test --test-concurrency=1`, 49 explicitly selected files and
an unchanged 1,200-second runner budget. It completed in 1,033.982 seconds. Test
runner totals include parent tests. The 654 result is focused cross-module
evidence, not the repository's complete integration suite.

### Selected PostgreSQL coverage

Fifteen M3B files under `apps/api/test/integration/`:

- `ratings-scoped-activation.test.ts`
- `ratings-scoped-adoption.test.ts`
- `ratings-scoped-boundaries.test.ts`
- `ratings-scoped-bridge.test.ts`
- `ratings-scoped-catalogs.test.ts`
- `ratings-scoped-causality.test.ts`
- `ratings-scoped-cleanup.test.ts`
- `ratings-scoped-commands.test.ts`
- `ratings-scoped-context-integrity.test.ts`
- `ratings-scoped-maintenance-fences.test.ts`
- `ratings-scoped-native-roundtrip.test.ts`
- `ratings-scoped-notices.test.ts`
- `ratings-scoped-random-scale.test.ts`
- `ratings-scoped-reverse-boundaries.test.ts`
- `ratings-scoped-upgrade.test.ts`

The same run included 34 existing or cross-owner regression files in that folder:

- `owner-count-reader-fences.test.ts`, `exact-count-proofs.test.ts`,
  `exact-discovery-counts.test.ts`
- `ratings-likes-integrity.test.ts`, `ratings-storage-proof.test.ts`,
  `ratings-subscription-integrity.test.ts`, `ratings-owner-proof.test.ts`
- `ratings-random-proofs.test.ts`, `ratings-like-proofs.test.ts`,
  `ratings-reply-proofs.test.ts`, `ratings-subscription-races.test.ts`
- `ratings-target-edit-races.test.ts`, `ratings-target-deletion-races.test.ts`
- `ratings-updates.test.ts`, `ratings-like-updates.test.ts`,
  `ratings-subscription-updates.test.ts`
- `safety.test.ts`, `safety-client-contract.test.ts`,
  `safety-relationship-proof.test.ts`
- `search-safety-eligibility.test.ts`, `search-safety-head-reuse.test.ts`,
  `search-canonical-reuse.test.ts`, `named-read-finalization.test.ts`
- `profile-discovery.test.ts`, `dm-owner-proofs.test.ts`,
  `messaging-final-proof.test.ts`, `messaging-concurrency.test.ts`,
  `messaging-identities.test.ts`
- `scalable-discovery-native-roundtrip.test.ts`, `discussion-search.test.ts`,
  `federated-search.test.ts`, `ratings-random-campus.test.ts`,
  `identity-campus.test.ts`, `identity-campus-native-roundtrip.test.ts`

## Important real-database checks

The matrix includes divergent same-region campuses, independently valid global
compatibility, complete empty/negative domains, exact category and target source
parity, adopted opaque identities, all eight command families and cross-protocol
objects. Original legacy M1/M2/M3A bridges retain their actual intent/hash/Review
and publish affected old/new states atomically. Raw SQL orphan, source/Review
substitution, missing compat closure, late artifacts and duplicate logical
versions fail at deferred constraints rather than relying only on HTTP guards.

Real activation races with old M1/M3A publication, readiness failures and adopted
irreversibility are covered. Real native API/PG roundtrips exercise journal
recovery, separate read/interaction contexts, interruption and stale callbacks.
Notice tests cover current A/B recipient differences, retryable unknown,
metadata-only history, original v1 IDs/read timestamps and no duplicate effects.

The complete-pool suite passed all eight tests in 118.812 seconds in the final
combination. It includes 2,048 distinct targets, 6,144 real paths, a 1,001-child
subtree, more than 520 mixed Review descriptors, full threshold evaluation,
unknown unselected sources, expiry, phantom/zero-row writers and after-scan
lifecycle/score changes. These tested sizes are not a production capacity claim.

### Safety/Campus count-reader fences

The two owners now use retained epoch relation SHARE NOWAIT for final readers.
Their previous reader-side exclusive advisory gate and shared reader slots were
removed together; original writer and overflow functions remain unchanged.
Tests cover concurrent readers, both writer orders, registered zero-row writers,
old-reader saturation/overflow, savepoint release, own writes/late mutation and
incomplete metadata. A maintenance ShareUpdateExclusive holder can still cause
conservative unavailability for these owners; this limitation remains explicit.

### Scoped snapshot and context fences

Only the context snapshot owner's source/protocol epoch fences changed from
whole-relation SHARE to explicit ROW SHARE NOWAIT plus every retained epoch row
FOR SHARE NOWAIT. The two heads retain SHARE. Full fixed-shape snapshots, current
source vectors, hashes and deadlines remain mandatory. Real BEFORE STATEMENT
epoch UPDATE, zero-row writer, reader-first wait, writer-first rejection,
EXCLUSIVE blocker and missing/extra metadata rollback are covered.

The maintenance regression uses single-stage `VACUUM (TRUNCATE FALSE)` on each
scoped epoch table. It observes the same backend's granted ShareUpdateExclusive
lock inside the actual successful final row fence, then verifies HTTP 200 and
unchanged epochs. Reader-first waits are attributed to the actual reader PID.
Autovacuum stays enabled; no proof budget or timeout was increased.

Context records independently retain a database-generated immutable full-record
digest and exact-row proof. Tests cover overlapping issuances, forged input,
update/delete/truncate rejection and relation conflicts. Other release,
compatibility, legacy-bridge, head and owner SHARE fences remain conservatively
unavailable under conflicting maintenance; this is not universal maintenance
availability.

## Earlier failures and final interpretation

Two earlier 48-file combinations were not fully green. The first had 641 tests,
634 passes and seven failures (five fixture-drift children plus two parents).
After fixture correction, the second had 639 passes and two failures: a scale
positive and its parent, caused by scoped epoch maintenance contention. A real
VACUUM reproduction identified that conflict. The minimal fence change and new
maintenance regression produced the final 49-file, 654-pass result above.
No failed or partial earlier run is counted as full acceptance.

## Outstanding release gates

The integrated complete PostgreSQL and semantic suites have passed, including
the owner-fence regressions. Signing/publication checks and hosted CI on the exact
released commit remain to be verified. Source and deployment readiness must be revalidated before any explicit
production activation. No production provider, adoption data or activation was
installed by this work.

M3C category/base/override authoring and management, and M3D production source
reconciliation/adoption/import/cutover, remain open. Production load, external
provider delivery and physical WeChat device acceptance are separate gates.
