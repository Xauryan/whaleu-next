# M1 target creation acceptance

Status: local development evidence, not release approval.

Implemented coverage:

- Strict native/API contracts and Unicode normalization; creator/source/origin
  injection rejected; opaque context excluded from stable intent hash.
- Ordinary qualified user flow without a create-role grant. Missing deployment
  policy and missing Review fail closed separately.
- Stable prepare and same-key concurrent create, one object/baseline/head switch,
  exact receipt replay and cross-account receipt privacy.
- Whole sealed catalog derivation, inherited categories/memberships, independent
  known-zero summary, normal HTTP target read and first score write.
- Unknown origin retained independently from global scope; explicit original
  campus retained even for a global target; policy can require known origin.
- Common namespace reservation before commit; raw managed-source forgery,
  altered preparation hashes and immutable transition updates rejected.
- Native same-key interrupted prepare/commit recovery, lifecycle/account changes,
  double taps, pending-slot contention and unchanged v1–v4 decoding.

Evidence and current commands are recorded by the integration owner. Initial
focused PostgreSQL HTTP roundtrip passed on local PostgreSQL 18.6. The final three focused PostgreSQL files (create, boundaries, recovery)
passed together after terminal-receipt and optional-origin repairs. They cover
real clock expiry, same-account fresh-session closure, cancel/create races,
closure recovery and policy-head TRUNCATE defense. Native focused ratings suite
passed 493 tests (19 M1 cases);
API contracts plus future-origin final-clock regression passed six cases.
API TypeScript, OpenAPI generation/check and changed-file ESLint also passed.
The final source query uses one materialized database instant, with a deadline
for a future optional original-campus assertion, including time spent after the
creation owner proof. These are not a full repository check.

Required before release: final integrated migration numbering, complete aggregate
regression and OpenAPI verification; Review/source policy operational issuance;
production/source reconciliation; representative 100k catalog concurrency/load;
native device rendering and transport acceptance; hosted CI. No production
roles, provider calls, historical zero import, edits/deletes or category override
management were enabled by this slice.
