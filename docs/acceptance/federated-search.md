# Local federated search acceptance

Verified 2026-10-08 against base `aebf19b26f9db2c3fdedd92a4f77ef336354ecb1`
plus this increment. Hosted verification is reported separately. No deployment,
production catalog/import or real-device acceptance is implied.

## Frozen gates

All 718 source/test/config/asset files retained fingerprint
`8a18d4ffef03a92c8bf4891d6e469ca0aad927c165f5333853d7153fe12aec1e` through
verification. [Machine-readable evidence](federated-search.json) records file/log
hashes; Markdown and docs are excluded from the source freeze.

- Lint, strict types, 500 API tests and 817 native tests passed
- Builds, emitted native smokes and formatting passed
- 860 real PostgreSQL tests passed in 496.653 seconds
- Total 2,177 passed, zero failures/skips
- PostgreSQL 18.6, launch-only 100 connections, one-minute autovacuum, zero remaining
  application schemas, runner stopped

## Functional and privacy evidence

New PostgreSQL acceptance adds 21 tests over all/regional/global semantics,
true-source rendering, urgent/resolved trading, complete multi-batch metadata,
membership-change restart before scanning, private-body differential behavior,
empty-catalog phone authority, initial phantom insertion, catalog writer ordering,
raw visibility changes, cursor quota waits, nested formation/comment/reply final
proofs and rollback. Existing explicit search remains covered; its sole old test
change updates the observed SQL string to the new metadata-only first parent lock.
Full-body reads occur only for evaluated rows/visible guards; lookahead is locked
without reading its body.

The metadata fixture includes 2,057 active spaces. Separate query-plan acceptance
uses 12,000 approved synthetic posts, three populated regional spaces, two populated
global spaces and 518 active catalog members. Actual EXPLAIN ANALYZE is used.
Common all/regional/global selectors used posts_search_chronological Index Only
Scan, returning 129 candidates and filtering 0/84/195 additional rows in the measured
fixture. Rare research used a sequential scan, returning 72 and rejecting 11,928;
rare yifu subtype used a bitmap posts_feed scan over 7,200 index entries, returning 37.
Final aggregate candidate SQL times were roughly 0.197–1.585 ms; complete common-selector
HTTP work was roughly 561–737 ms, with 2,084–2,217 statements,128 distinct evaluated
posts and 256 canonical body/review rereads. These are observations of the local
fixture and may vary. Neither 128 candidates nor this index guarantees bounded
physical rows, constant SQL count or production latency.

Early test failures were corrected observer/assertion/fixture issues: the old
SELECT-star lock matcher, treating the 129 th lookahead as evaluated, reusing a race
observer after its scenario, an overlong formation theme, and counting canonical
body rereads as distinct candidates. Final aggregate acceptance includes the
corrected performance and all behavioral tests together.

Native acceptance has 33 focused search tests and expanded emitted page smoke.
No-campus aggregate entry, optional campus lookup independence, scope/filter
transitions, actual-source strict decoding, frozen query, stale responses, safety,
account, cancel, hide/reopen, restart and sparse continuation are covered. The
emitted smoke uses real client/gateway code with synthetic transport; physical
WeChat rendering remains unverified.

Independent review cleared final production code. The existing campus catalog
trigger order was corrected additively in 0028 alongside the new community-space
gate; historical migrations and authorization guards are unchanged. Arbitrary
TRUNCATE/DDL writers remain subject to documented outer-gate-first coordination.

Related opt-in distribution, unsupported historical populations/import, history,
hot suggestions and full product parity remain open. Pending view-expiry and
author received-total decisions are unaffected.

## Hosted verification

Verified SSH-signed commit `83230f92ae6f49ec91d6d0d02d041615033918db` passed
[GitHub Actions run 37748630211](https://github.com/Xauryan/whaleu-next/actions/runs/37748630211).
The run passed 500 API, 817 native and 860 PostgreSQL tests, 2,177 total with zero
failures/skips. PostgreSQL took 522.774 seconds; lint, typecheck, build, emitted
smoke and formatting also passed. No production deployment is implied.
