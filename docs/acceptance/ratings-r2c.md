# R2C local acceptance status

Date: 2026-10-09 UTC. The final frozen implementation passed the complete local repository gate recorded below. This is not production release approval, historical reconciliation, external delivery or complete rating parity.

## Scope

- Independent native-source target subscription coverage and current actor CAS/count
- Minimal receipts/noop observations and v3 native pending recovery
- Target-only v3 Experience source with actual shared-pool ledger settlement
- Target-serialized membership epochs and same-transaction root/reply capture
- Bounded durable raw pages and independent per-recipient local materialization
- Current authorized notification projection, typed locator and monotonic owner read state
- Existing strict directory DTO plus sequential single-scope supplemental card batches

## Focused evidence

- New XP unit tests and old source-adapter regressions passed 57 tests; API typecheck passed.
- Strict subscription contract and offline deterministic OpenAPI checks passed 9 tests. The generated rating contract now has 40 operations.
- A disposable PostgreSQL run passed 11 tests: ordinary AppModule status/CAS/noop/replay/owner recovery and read-only batch, real actor-only v3 ledger settlement, shared community/Saved/rating tenth/eleventh quota boundaries and Shanghai day, unknown XP baseline recovery, missing capture/work rollback, acknowledgement failures, duplicates and owner/target lock compatibility.
- A second run passed 14 tests: actual fifty-card native HTTP integration uses exactly three sequential batches; exact v3 retry after a lost committed response and independent later membership/count; cancellation stops the old supplement; real root and reply subscription notices coexist with direct notices and use independent read state. Raw SQL covers legal multi-transition/noop history in one transaction, savepoint rollback, projection failure, forged receipts, immutable history, unknown historical coverage and future-effective source rejection.
- Public-only actual AppModule HTTP golden DTOs are frozen in `packages/fixtures/ratings-r2c.json`, using synthetic isolated identities, catalogs and review evidence.
- PostgreSQL runs use the exclusively leased PostgreSQL 18.6 loopback test runner. The above completed runs verified zero application schemas/public objects at cleanup and a normally stopped server.

The first PostgreSQL attempt used the wrong TypeScript working directory and ran no application tests. The first migration attempt found an unparenthesized CASE expression in the new fan-out function; it was corrected before the passing runs. These failed attempts are not acceptance evidence.

## Latest combined focused gate

A single unchanged implementation snapshot passed 63 PostgreSQL tests across all R2C integration files, the actual native HTTP roundtrip, and the existing nonempty R2B activation regression. This is the latest combined focused result; earlier counts above describe development runs and must not be added together or treated as a full gate.

The combined run includes:

- Real 0050→0051→0052 activation with ten preexisting provenance variants, native target without score coverage, retained score coverage that cannot justify subscription coverage, an approved gap publication with settled XP, no historical replay, and exact new root/reply source/job transaction identity
- 130 historical raw epochs over three bounded pages, including 121 ended epochs, an excluded actor, and eight currently active regional recipients processed in independent transactions under the unchanged grant/campus proof budgets
- Current epoch cancellation/re-subscribe semantics, both real target-lock race directions, duplicate workers and independent direct/subscription notices
- Unknown authority, missing content, exact anonymous projections, unavailable privacy and owner-only monotonic reads
- Expired phone and grant NOWAIT failure after a tentative notice, with full recipient rollback and durable retry
- Raw SQL omitted source/stream/job for root and reply, false-empty/skipped pages, one missing candidate among valid page work, missing notice/receipt, and withheld completion/page/retry writes
- Explicit row acknowledgements ensure swallowed SQL writes cannot claim completed delivery, page progress or persisted retry backoff
- Only the first actor count projection is suppressed in both initial/noninitial counterexamples; the later actor remains a normal write and cannot hide the missing predecessor. Legal same-transaction transitions/noops and SAVEPOINT rollback also pass.

This run ended with zero application schemas/public objects and a normally stopped PostgreSQL 18.6 server. API typecheck, scoped ESLint, formatting and diff checks passed. The final root-owned whole-repository gate is recorded separately below. Migration 0001–0050 and the lockfile are unchanged. No production account or paid model/provider operation was performed. Remote branch publication and hosted CI remain pending.

## Release boundaries

Source authority and historical import/reconciliation, media/admin/specialist capabilities, actual review issuance, external providers and real-device behavior remain open. Author cumulative received-like inclusion/deletion rules remain undecided. The personal saved-post list remains community-only; no rating personal-list parity is claimed. Only local/manual in-app delivery and synthetic authorization fixtures are covered by these tests.

## Final local full gate

The final unchanged source freeze passed whole-repository lint, both TypeScript
checks, deterministic offline OpenAPI verification, tests, both builds and all
native emitted-runtime smoke. Whole-repository format checking and the separate
real-cloc 2.10 integration test also passed.

The total was **4,066 tests**: 5 statistics, 947 API, 1,559 native and 1,555
PostgreSQL tests. All passed with zero failures, skips or cancellations. The
separate real-cloc integration test passed 1/1 outside this total.

The full PostgreSQL 18.6 suite used launch-only max_connections=100 and took
1,181.427896764 seconds. It completed on 2026-10-09 at 04:03:11 UTC. Cleanup
verified zero application schemas/public objects, a normally stopped server,
no postmaster PID and a free exclusive runner lock. No persistent configuration
or production database was changed.

The initial whole-repo format check found two new test files needing formatting.
They were formatted without changing logic. The earlier root check was retained
as pre-format evidence; a new source freeze and a complete root-check rerun
preceded the final full PostgreSQL run. Earlier results are not substituted for
this final snapshot.

Source manifest: 1,309 files, excluding docs and Markdown, SHA-256
`8ff1fbf49fec757c79917848b48b7abbadf03b4cda3f8654785e5d085e2a4786`.
Eight OpenAPI artifacts: SHA-256
`21309c2d46b0a3cb50887358bdebf0f3643fc6d440271b76402e12339dc531e0`.
Every recorded file was rechecked after the complete gate with no changes.
Independent source and publication-hygiene review found no confirmed remaining
blocker within this slice. The release boundaries above still apply.
