# Rating management M2A acceptance

Status: focused validation passed; integrated acceptance remains pending.

Validation evidence from the isolated M2A worktree:

- Final changed-file formatting and ESLint both passed.
- First API compile found an optional Vary-header assertion typing error; corrected.
- Second native test compile found eight Array.at calls outside the existing target
  library; replaced with ordinary array indexing.
- Third API, native runtime and native test TypeScript compiles all passed.
- API M2A unit: 5/5 passed.
- Third native M2A unit: 25/26 passed. Its new native-page smoke used a non-HTTPS
  fixture origin; corrected to the same explicit HTTPS origin as ApiClient.
- Fourth native M2A unit: 26/26 passed, including native-page HTTP/storage recovery
  and five loaded/in-flight random invalidation regressions.
- First real PostgreSQL focused run: all five M2A integration files passed,
  44/44 tests, zero failures/skips/cancellations, approximately 37.4 seconds.
  The standard PostgreSQL runner completed and stopped its server normally.
- Generated OpenAPI and its check passed. Full native emitted build passed,
  including the new owner-deletion smoke and real cold-state page assertions.
- Integrated repository check and full PostgreSQL/semantic regressions remain pending.
  Source formatting after the focused run changed layout only; no second PostgreSQL
  run was performed in the final short CPU window.

Failures and passes are retained separately; no focused pass implies full acceptance.

Base HEAD: e9f889cbd1f64cfe3060e3f14a8ca88a7ddc26af.
Source/index baseline: 907d323a82babd126f2c49c1b6a4a8f0d621783b, the frozen
R3R+M1 integration snapshot; it is not a signed commit or accepted release.

## Intended scope

Creator-only target soft deletion, independently typed owner tombstone for already
inactive targets, known-locator minimal cleanup context, lifecycle CAS before
noop, same-key durable recovery/cancellation, history retention, no new effects,
existing public and notification read-time gates, native v6 recovery.

Review protocol, target definition editing, category/school overrides, production
configuration/import, hosted CI and physical devices are excluded. M2B editing
remains open after this slice.

## Required verification

- Contract/hash/minimal metadata and historical-replay unit tests
- Native strict decoding, gateway, controller, cancellation, cross-page and
  account/lifecycle callback recovery tests; v1–v5 compatibility
- Real native runtime/controller → AppModule HTTP → PostgreSQL roundtrip, including
  v1 shared-journal recovery, v6 response loss, explicit cancellation and new sessions
- Catalog/detail/thread/random target-deletion invalidation, cancelled in-flight
  reads, stale callback rejection and disposal unsubscribe
- Real local PostgreSQL owner/hidden/CAS/recovery/concurrency integrity suites
- Raw SQL cause guards and irreversible tombstone tests
- Score/discussion/like/subscription/Experience and existing materialized-notice
  history retention; child-author cleanup after parent deletion
- Final owner proof expiry/failure rollback and R3R pool epoch concurrency
- API/native TypeScript, changed-file lint/format, generated OpenAPI check
- Integrated repository check, full real PostgreSQL/semantic regressions required
  by the repository, after final shared-file integration

No successful result should be inferred from this checklist.
