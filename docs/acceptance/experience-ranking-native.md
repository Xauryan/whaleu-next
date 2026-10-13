# Native bounded known-participant experience list

## Scope and source

Legacy ref `WhaleUCampus/WhaleU@57cf169c11123acf249909a1a7215b8cb1ec1f8e`:
`treehole/route/app.php:374–375`, `treehole/app/controller/Experience.php:105–113`
and `treehole/app/service/ExperienceService.php:443–456` establish the legacy
bounded ranking backend. The checked legacy native experience JS/WXML did not
contain a ranking call or entry; this checkpoint does not claim otherwise.

Next reuses the existing `GET /v1/experience/ranking` contract and unchanged source,
scan/proof budgets, safety policy and bigint ordering. The “经验与头衔” entry opens
“已知参与者等级列表”, with direct guest access, strict optional authentication,
50-item cap, server order and independent public level/title/color evidence.

Coverage always remains `global` / `known_participants` / `incomplete`.
`limit_reached`, `available_candidates_exhausted` and `scan_limited` have distinct
copy; an empty scan-limited page never claims an empty user population. No ordinal,
exact points, owner rank, count, school-wide completeness, avatar prefetch, role,
UID, provider, migration, reward, ledger or recovery-journal write is introduced.
The public-profile destination performs its own current permission read.

Repeated refresh cancels the prior request; cancel, hide, unload, account/login
changes and root-hide clear current cards and fence late callbacks. API origins
are immutable per build with origin-scoped session storage; a new page load binds
the current app runtime. Merely viewing this list never replays pending personal
sign-in, appearance or redemption requests. Unsaved appearance selection departure
is explicitly labelled, following the existing refresh-and-discard UI policy.

## Verification inventory

- Native contract, gateway, controller and actual registered Page tests:
  `apps/wechat/test/experience-ranking-*.test.ts`.
- Build-integrated emitted smoke: `scripts/smoke-experience-ranking.mjs` in the
  WeChat workspace; synthetic response coverage is not real-device acceptance.
- `apps/api/test/integration/experience-ranking-native-roundtrip.test.ts` runs
  emitted App/Page through the native transport bridge, loopback HTTP and a fresh
  disposable PostgreSQL fixture. Includes all-table/sequence read-only snapshots,
  known zero, missing history/profile, inactive account, bigint/tie order,
  bilateral blocks/self, hideProfilePosts, identity replacement, revoked token,
  delayed cancellation/hide/unload, 50-limit and 257-candidate scan-limited cases.
- The new spec is in the existing experience integration module. Existing
  `experience-ranking.test.ts` proof/settlement/concurrency regressions remain
  unchanged; the existing 10-shard/max-8 layout is not rebalanced.

## Local verification — 2026-10-13

Validated on base `c51b5e2fd777d3b6166d1a4cb5980d7f4c353981` with the
candidate's final source bytes:

- Focused native contract/gateway/controller/Page tests: 16/16 passed.
- Native and API type checks, native build and emitted smoke: passed. Initial
  test-only type errors were corrected before the successful checks.
- New native ranking roundtrip plus existing ranking PostgreSQL regressions:
  29/29 passed on a fresh disposable PostgreSQL 18 instance.
- All ten experience PostgreSQL integration files: 113/113 passed; controlled
  database shutdown completed. A final rerun bound all 890 emitted native files
  and the full source inventory with identical before/after SHA-256 manifests.
  No production database or provider was used.
- CI manifest/guard tests: 32/32 passed.
- Complete `npm run check`: exit 0, including 2,028 API and 3,074 native tests,
  strict type checks, lint, offline OpenAPI verification and workspace builds.
- `npm run format:check`: exit 0.

An earlier aggregate run was interrupted during environment recovery without a
recorded exit status; it is neither a pass nor a product-test failure. The full
aggregate was rerun after its original timeout boundary and completed normally.
The earlier PostgreSQL runs and the successful aggregate used identical source
bytes; only this verification record was updated afterward. The final PostgreSQL
rerun also verifies the aggregate's emitted artifacts directly. Its first command
used the wrong working directory and failed during TypeScript decorator loading;
the corrected API-workspace invocation passed without any code change.
Candidate-specific
remote workflow gates remain pending publication and are not claimed here.

Complete historical population, real devices, production data/provider acceptance
and a full leaderboard remain separate, incomplete gates.
