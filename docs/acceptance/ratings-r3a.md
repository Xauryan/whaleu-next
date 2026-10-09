# Ratings R3A local acceptance

Status: local integrated acceptance passed on the search checkpoint a4429cf
plus the R3A diff and the reporting concurrency-test clarification below.
Hosted CI, production migration and real-device acceptance remain pending.

Scope: owner hidden-parent metadata cleanup, typed single-subject administrator
deletion, original-campus authority, precise causal audit/effects, minimal
contexts/receipts and interrupted native recovery. Full rating administration,
real source/role issuance and cumulative received-like product rules remain open.

## Integrated acceptance

- The final integrated `npm run check` passed lint, all workspace types,
  statistics tests (5), search evaluation tests (20), deterministic OpenAPI,
  API units (1035), native units (1607), all builds and compiled native smoke.
  Repository format and the real cloc integration gate (1) passed.
- The final complete main PostgreSQL suite passed 1607/1607 tests, followed
  by the separate semantic PostgreSQL suite at 27/27, with zero failures or
  skips. Both ran serially inside one disposable runner and it stopped normally.
- The first integrated main PostgreSQL run had one failing reporting subtest
  (also counted as its parent suite failure): a late vote returned target
  unavailable instead of jury closed. Its final source-lock order was not
  recorded; five unchanged focused repetitions then passed. No product defect
  or specific scheduling cause is claimed from that evidence.
- That existing test now distinguishes known vote-first and removed-target-first
  orderings with strict respective rejection codes, while preserving the real
  simultaneous source-lock race. The race admits only those two independently
  proved rejection codes and verifies no late ballot, exactly one prior remove
  ballot, one removal decision, deleted content, one notice, and exact immutable
  receipt recovery/replay before and after settlement. No product code changed.
  Five final focused repetitions passed 24/24 each, and the same frozen source
  then passed the final complete suites above.
- Earlier failed runs remain recorded; cloc's first invocation omitted its
  required path and was rerun with the existing pinned local cloc 2.10 tool.

## Isolated worktree evidence

- API typecheck and scoped ESLint passed. The isolated full API unit suite passed
  986 tests, with zero failures or skips (including mandatory authority/time,
  context/replay and negative Safety deadline tests).
- The isolated full repository `npm run check` passed lint, all workspace types,
  statistics tests (5), deterministic OpenAPI, API units (986), native units
  (1599) and all builds/compiled native smoke. Format check also passed.
  The final rerun includes all PostgreSQL-driven fixes and three additional
  authority regression tests.
- The first exclusively leased disposable PostgreSQL run completed normally:
  11 tests, 8 passed and 3 failed (including parent failure counts). The populated
  0052-to-0053 upgrade passed without rewriting old authors, receipts or effects.
  All four owner-cleanup subtests passed. Global unknown/schoolless deletion and
  reply deletion passed. Fixed-school deletion exposed an ambiguous PL/pgSQL
  parameter in topology validation; it was renamed. The owner test's final
  summary comparison included a newly created fixture target; the assertion was
  narrowed to its original targets. Both fixes were verified in the subsequent
  43-test PostgreSQL run recorded below.
- The next exclusively leased PostgreSQL focused run passed all 43 tests with
  zero failures/skips and a normally stopped server. It covered fixed/global
  deletion, all owner gates, strict raw causes and one SQL-minted deletion
  instant, cross-owner/admin noops, origin immutability/ABA, grant insertion
  during a target lock wait, grant/source/Safety expiry across deferred waits,
  the populated upgrade and the real native HTTP/PG roundtrip.
- Nine explicit-barrier concurrency subcases passed: both orderings against
  reply creation, reply cleanup, likes and subscriber materialization, plus
  raw child-first target/root NOWAIT collisions. Earlier legitimate rewards
  survive; administrative deletion creates no reward, direct notice or fan-out.
- Real native response loss followed by grant revocation recovers the same
  historical receipt, while hidden-parent cleanup and v1/v4 journal isolation
  passed through actual AppModule HTTP and PostgreSQL.
- Expanded OpenAPI comparison confirms all 32 preexisting paths are unchanged;
  the rating document adds 7 paths and now has 47 operations.
- Final full PostgreSQL integration passed all 1598 tests, with zero failures
  or skips, in 1255 seconds; the disposable server stopped normally. The final
  full repository check and format check also passed.
- Two separately reviewed baseline test corrections are included: compare exact
  timestamp instants across UTC/Los Angeles instead of one display string, and
  use the 1025-row fixture for the optional source-proof expiry case while
  preserving separate 4097/25000 scale coverage. Neither changes product code.

## Required acceptance boundaries

Verify ordinary/public publication and interaction protections remain intact;
nonowner opacity; hidden/inactive/withdrawn parent cleanup with exact CAS;
fixed/global authority and absent/schoolless/unknown provenance; grant/source/
topology/session/phone/Safety final fences; raw typed-cause and effect forgery;
owner/admin cross-noops and shared request namespace; source-version4 zero
reward/notice/fan-out; immutable history and migration-from-history behavior;
reply head advancement; native cancellation, response loss, double-click,
session/account/origin/navigation fences and old journal compatibility.

No role, production source, provider, historical reward, third-party delivery or
real user content is created by this work. Tests use isolated synthetic fixtures.
