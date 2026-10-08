# Authorized title maintenance acceptance

Local aggregate verification completed on 2026-10-08 against base
`7be98239da1fedb4866b9177f180828ebdfcffe1` plus this increment. Hosted CI for the
resulting commit is reported separately. No maintenance was run on real accounts.

## Frozen gates

All 658 source/test/config/asset files remained unchanged across the successful
final gates. Fingerprint:
`24541019969ea072b406f4e8e5ea6d2b842f5369287a1a0b237a2fffb5f8e9f0`.
The [machine-readable evidence](title-maintenance.json) contains the manifest,
hashing convention, final log hashes and prior attempt dispositions. Documentation
is excluded so evidence can be added after testing.

- `npm run check`: lint, strict types, 442 API and 784 native tests, both builds
  and fresh emitted native smokes passed
- `npm run format:check`: passed
- `npm run test:integration`: 730 tests passed in 406.301 seconds
- Total: 1,956 passed, zero failures/skips
- PostgreSQL 18.6, launch-only maximum 100 connections, normal one-minute
  autovacuum scheduling, zero remaining application schemas and runner shutdown

## Actual capability

A fresh global developer or superadministrator grant authorizes explicit bounded
maintenance. Each authenticated transaction processes at most one candidate;
immutable actor-owned receipts and server-held sweep bounds support continuation
and lost-response recovery. A predecessor has at most one successor. No client
owner/title/role selectors, implicit administrator or startup repair are added.
This is a bounded live sweep, not a complete historical population snapshot or a
high-throughput bulk-maintenance benchmark.

Known current balances justify missing level titles, including level one at known
zero. Unknown history is skipped. Default repair independently requires canonical
provider-identity eligibility; target login blocking does not erase cosmetic
eligibility. Existing undated ownership and higher retained titles are unchanged.
New maintenance grants record actual repair time, not reconstructed achievement
time. There is no equip, point/streak change, notice award, profile creation,
coverage promotion, limited/special title grant or actual role appointment.

## Authority, proof and recovery evidence

Focused PostgreSQL acceptance passed 64 tests across maintenance HTTP, concurrency
and direct-proof suites plus existing ledger/redemption regressions. Cases cover
role restrictions, immutable replay and consumed continuations, finite sweep
boundaries, reciprocal administrator targets, unknown/default eligibility and
current-level thresholds. Direct SQL tests reject forged operator, scope, balance,
title, timestamp, counts, cursor and reused or incomplete transaction evidence.

Observed request/owner/grant/deferred waits verify session and selected-grant
expiry or revocation cannot commit stale-authority work. State-dependent receipt
errors, including the successor recovery reference, pass full finalization before
being returned. Only the exact typed continuation exception exposes that one
validated reference. Arbitrary exception fields remain excluded.

Review caught and fixed two implementation issues: receipt-state error metadata
initially bypassed final deadline checks, and numerically ordered level keys did
not match SQL's canonical key-array ordering. Focused PostgreSQL tests also found
SQL authority expiry could preempt finalization with a generic error; only exact
named expiry constraints with SQLSTATE 23514 now map to the corresponding safe
authority/session condition. Forged-proof failures retain normal constraint
behavior. Timeout settings preserve stricter inherited values and remain active
through deferred proofs, with a separate completion-validity deadline.

## Aggregate retry and maintenance contention

One earlier aggregate ended without a terminal result. A subsequent complete run
passed 727/729 tests: one positive named-read baseline and its enclosing test failed
at the mandatory blocks-table NOWAIT SHARE fence with SQL 55P03. No proof-budget
expiry was observed. A separate instrumented reproduction identified an actual
autovacuum worker holding SHARE UPDATE EXCLUSIVE while baseline reads returned
503 in 34–48 ms. The original worker identity was not recorded, so attributing that
historical conflict specifically to autovacuum remains an inference.

The correction is confined to the disposable timing-sensitive test table:
background autovacuum is disabled there so positive cases control their writers.
A new explicit maintenance-lock case requires exact fence failure, minimal 503,
no protected contacts, prompt completion and successful recovery after release.
Two focused runs passed 54/54 under one-second autovacuum scheduling. Production
settings, mandatory proof and runtime budgets are unchanged. See the
[named-read availability boundary](../NAMED_READ_FINALIZATION_GAP.md).
Another check invocation was interrupted before PostgreSQL began; it did not count
as a pass. The final complete aggregate above used normal one-minute scheduling.

## Remaining gates

Existing approved operational role grants are required; none were provisioned.
Real-account execution, historical import, bulk throughput, role-title appointment,
received-interaction policy, live redemption activation and provider/device
acceptance remain separate. Contending writers or database maintenance can still
make mandatory named reads fail closed; this does not establish universal
production availability.
