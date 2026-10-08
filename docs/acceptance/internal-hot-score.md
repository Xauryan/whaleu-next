# Local internal hot-score acceptance

Verified 2026-10-08 against base `3857e48dd54368cf015e94ed4ad0787d8d19cce5`
plus this increment. Hosted verification is reported separately.

## Frozen gates

All 784 source/test/config/asset files retained fingerprint
`6acd9885700d5fd137d0f1d6e9b5db0023f43b7a12b91c5a6f9a47e48a6ee2f4` through
final verification. [Machine-readable evidence](internal-hot-score.json) records
file and log hashes; Markdown/docs are excluded from the source freeze.

- Lint, types, OpenAPI drift, 608 API and 842 native tests passed
- Builds, emitted native smokes and formatting passed
- 995 PostgreSQL integration tests passed in 684.437 seconds
- Total: 2,445 passed, zero failures/skips
- PostgreSQL 18.6, launch-only 100 connections, one-minute autovacuum; zero remaining
  application schemas and runner stopped

## Focused evidence

Forty score unit tests and 21 real PostgreSQL entries cover independent missing
baselines, exact source/receipt/obligation composition, bigint and sequence gaps,
real capture/settlement/replay, author exclusion, aggregate comment cap and retained
replies. Known zero differs from unknown, and live counts returning to zero do not
hide unresolved captured work.

Concurrency tests cover parent waits, capture/settlement, accepted reporting,
direct view-state increments, timeouts and unrelated-post progress. Exact table
and sequence snapshots show no mutation in advisory or locked modes. Actual
READ ONLY and local/manual/background isolation are tested; the module is not
registered in production HTTP owners.

Numeric acceptance includes support thresholds, natural logarithms, bigint-range
inputs, cap/one-plus overflow prevention, four-decimal format and wider working-
scale regression around tested rounding boundaries. It is not a proof of universal
real-arithmetic error bounds or PHP bit equivalence. Raw-root-plus-reply maxima
that existing bigint CHECKs cannot store were exercised at the evaluator layer,
not represented as production component states. Existing owners/triggers were not
disabled to manufacture those cases.

Review identified and corrected malformed-string BigInt refinement throwing
outside safe validation. A test-only tamper query referenced a nonexistent field;
it was corrected before the 21-test focused run. No PostgreSQL implementation
failure was found in that completed run. Final full acceptance includes all new
and existing tests together.

## Release boundary

The formula's source version is verified checked-in metadata only. The named
PostgreSQL profile has independent identity and is not an assertion of deployed
PHP score equality. Formula fingerprint:
`d13db20fa6b3db237bbf58b0d1158b023bb63db00649308adeec8300d2ed0508`.
SQL expression fingerprint:
`889310ad4cdd3400804d56df8c5cd72057ee330c3b928106d10bc51c30964af1`.

No dependency, migration, public DTO/OpenAPI/native field, materialized score,
provider, automatic processor or production dataset was added. View snapshot
locking does not establish independent receipt provenance for privileged direct
SQL counter writes. Public ranking privacy, population, freshness, ties and
pagination remain open, as does the separate author received-total decision.

## Hosted verification

Verified SSH-signed commit `816d288269c0ac32e2dadea0437516b20a75b48e` passed
[GitHub Actions run 37770188335](https://github.com/Xauryan/whaleu-next/actions/runs/37770188335):
608 API, 842 native and 995 PostgreSQL tests, 2,445 total with zero failures/skips.
PostgreSQL took 701.512 seconds. Lint, types, OpenAPI drift, builds, emitted native
smokes and formatting passed. No public ranking or deployment is implied.
