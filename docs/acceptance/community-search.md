# Local explicit-space search acceptance

Verified on 2026-10-08 against base `c133b653df89374d336dfe155119c8165dda06a6`
plus this increment. This is partial search parity, not deployment or real-device
acceptance. Hosted verification of the resulting commit is reported separately.

## Frozen verification

All 709 source/test/config/asset files retained fingerprint
`d30b0342cffbe3ef19c4b9c7a76ada79c6c38826e15f6b4748de3b56101c24b0` through
verification. [Machine-readable evidence](community-search.json) records file and
log hashes. Documentation is excluded so evidence can be added after tests.

- Lint, strict types, 487 API tests, 807 native tests, builds and emitted native
  smokes passed
- Formatting passed
- 839 PostgreSQL integration tests passed in 475.147 seconds
- Total: 2,133 passed, zero failures/skips
- PostgreSQL 18.6, launch-only 100 connections, one-minute autovacuum scheduling;
  zero application schemas left and server stopped

The shell's final summary grep expected TAP markers while Node emitted its spec
reporter, returning status 1 after all gates had succeeded. Individual log totals,
formatting success, database cleanup and unchanged source hashes were checked
separately. This is not recorded as a test failure or an unverified aggregate pass.

## Evidence and remaining limits

Focused backend acceptance covers strict queries, Unicode17.0 lowercase semantics,
exact opaque cursor validation, visibility-before-match, sentinel rows that are
not text-matched or serialized,
phone/session authority and final proof rollback. Normal-AppModule PostgreSQL
acceptance passed 15 tests including equivalent valid fixture worlds whose
hidden/held/blocked text differs, 1,100-row sparse traversal, microsecond/UUID
ordering, current scope/filter policies, parent-lock rereads, unheld additions,
nested formation personas and final cursor rollback. Differential assertions use
logical fixture coordinate mapping rather than comparing random opaque tokens.

Final phone/session expiry uses a real-SQL observer barrier after deferred
constraints; it is not a newly installed blocking deferred database trigger.
Concurrent scope-deactivation and review-revocation waits were not separate race
cases. Current inactive scopes, held/revoked rows and invalidated visible anchors
are covered. Existing mandatory safety owners and proof guards are unchanged.

Native acceptance includes strict wire contracts, draft/submitted separation,
fresh Previous/Next, sparse continuation, scope restart, account/session/safety
invalidation, hide/reopen and stale response rejection. The emitted page smoke
uses real ApiClient and strict gateways with synthetic transport, not a physical
WeChat device or a live provider. No queries are persistently stored by this slice.

Independent review found and corrected a native BAD_REQUEST restart-state mapping
and a backend unit-test SQL-hook matcher. Early PostgreSQL failures included an
unexported test URL (before mutations) and a test wrongly assuming query `0` would
not match `100%`; corrected final acceptance preserves literal matching.

Cross-school/related-campus modes, remaining historical categories, history/hot
suggestions, imported unknown dates/raw text, indexed scale and real-device
validation remain open. The per-request structural window is bounded; whole
search traversal is O(corpus). No totals or relevance scores are fabricated.
Pending view-expiry and author received-total decisions are unaffected.
