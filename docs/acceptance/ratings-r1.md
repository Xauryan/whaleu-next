# Ratings R1 local acceptance

Status: local full regression passed on 2026-10-09. This is a bounded R1 development slice, not complete rating parity, a deployment or a production-data claim. Publication and hosted CI remain pending.

## Executed focused checks

Final focused source checkpoint, 2026-10-09:

- All newly added rating contract, owner/review and offline OpenAPI unit tests: 48 passed
- Four newly added PostgreSQL test files, run serially with 100 connections: 34 passed
  - Normal AppModule R1 HTTP workflow: 16
  - Owner authority, independent anonymous eligibility and deferred-expiry proofs: 10
  - Storage causality, independent fresh provenance and late catalog deadline: 7
  - Actual native gateway through real HTTP/default AppModule/PostgreSQL: 1
- Latest API type checking and focused lint passed; final aggregate checks remain separately recorded

The final focused PostgreSQL run included the single-snapshot active/future grant horizon, non-reusable target lifecycle revisions, target lifecycle cursor epoch, reverse summary/transition causality, and the explicit late-validator catalog expiry assertion. All 34 passed with no skips. The local runner verified zero remaining application schemas, stopped PostgreSQL and released its exclusive lock with no postmaster PID remaining.

The focused database run validated current global/regional permissions, phone exemption for category navigation, three-level ancestry, true same-score noop, CAS conflicts, concurrent score changes, exact bucket totals, score-independent text, stable target personas, own deletion without score withdrawal, default missing/pending/rejected canonical review, opaque negative-observation invalidation, rejected raw uncaused summary/score/receipt changes, unknown historical coverage, source transaction forgery, multi-transition transactions, exact receipt timestamps, catalog expiry during a later required validator, and ancestor disabling.

All synthetic facts are explicitly labelled in test helpers. No approval facade is replaced by an allow-all adapter. No external provider or production account is contacted. Successful standalone runs removed all application schemas and stopped the isolated PostgreSQL instance; failed intermediate runs also cleaned up and stopped.

## Intermediate issues fixed

- A review-envelope SQL JSON subtraction expression needed explicit parentheses
- Category ordinal ordering needed its table qualifier
- Parallel independent read proofs can legitimately fail closed on a conflicting final fence; identity/privacy tests run sequentially, while mutation concurrency is tested separately
- Target lifecycle changes now invalidate cursor negative observations and cannot reuse prior CAS revisions
- Catalog expiry remains registered for the final transaction clock after later owner validators

## Final local full gate

One unchanged source freeze passed the root check (lint, both type checks,
offline OpenAPI verification, tests and both builds including emitted native
smoke), whole-repository formatting and the full isolated PostgreSQL suite.
The total was **3,396 tests**: 5 statistics, 806 API, 1,246 native and 1,339
PostgreSQL tests. All passed with zero failures, skips or cancellations.
The separate real-cloc 2.10 integration test also passed (1/1), outside this total.

PostgreSQL 18.6 ran with launch-only max_connections=100. Full-suite duration
was 940.255043585 seconds. The runner verified zero remaining application
schemas, stopped its server, removed its own postmaster PID through normal
shutdown, and released the exclusive runner lock. No persistent configuration
or production database was changed.

The source manifest covered 1,169 files (documentation and Markdown excluded):
`69e438bb0a4949e95f06fbd69e1e14ebb030a6d3130ca58214379667eda8af99`.
The eight OpenAPI artifacts had manifest hash
`15488dbd8be132eca1ffa3c047734c9acc52ee1a48efa71c11f5a3558088a73f`.
Every recorded file was rechecked after the complete gate; none changed.
The only preceding aggregate formatting failure was the E2B historical
acceptance appendix, corrected before this source freeze and passing rerun.

## Remaining verification

Public push and hosted CI remain pending. Real directory/score provenance
issuance, authoritative imports, production privileges, provider work and
physical-device acceptance are not covered by local synthetic fixtures.
Replies, interactions, subscriptions, experience/notification settlement,
media and administrative lifecycle work remain explicit subsequent slices.
No model API, real account operation or external content transmission was
performed as part of this R1 gate.
