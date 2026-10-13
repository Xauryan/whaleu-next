# Native level-title rule directory

## Fixed source and scope

Legacy `WhaleUCampus/WhaleU@57cf169c11123acf249909a1a7215b8cb1ec1f8e`,
`miniprogram1/packageUser/pages/experience/experience.js:132–146` and
`experience.wxml:38–59`, generates the fifteen odd-level titles and displays
unlocked and locked sections. This establishes a native presentation source,
not device or production acceptance.

On Next base `319b3cc910627f6aa67d80b2d5ff9d61f649e0c9`, the existing strict
catalog decoder already supplies all fifteen level titles. The personal
“经验与头衔” page now has a collapsed “等级头衔规则一览” section. It displays
only catalog names and rule unlock levels, sorted by level. Default, limited and
special titles are not part of this directory.

The directory deliberately makes no personal unlocked/locked, ownership,
entitlement, grant, earned-date or historical-coverage claim. The owned appearance
inventory and its owned-only selection guard remain authoritative. A low current
level does not remove a retained title; unknown experience or partial entitlement
history cannot be converted into inferred absence. No equipment, grant, redemption
or management control is added to the directory.

Toggle changes only local presentation. It does not fetch, save, sign in, replay,
acknowledge, issue request IDs, or change an unsaved appearance selection or any
pending journal. Existing load/cancel/private-view disposal and session fencing
clear the directory; reopen starts collapsed. No API, SQL, policy, provider,
migration, persistence or CI grouping changes are required.

## Verification mapping

- `experience-runtime.test.ts`: complete sorted rules, strict catalog provenance,
  known zero versus unknown baseline, partial entitlement history, retained
  high-level owned title, owned-only guard, local-toggle equality, failed reads,
  ACCOUNT_BLOCKED logout, private-view invalidation, cancel/hide/dispose,
  account and same-account session replacement, and late catalog responses.
- `experience-ranking-page.test.ts`: actual personal Page plus bounded rendering
  of its WXML; all fifteen rows, expanded/collapsed states and no row action;
  dirty selection plus original sign-in/appearance/redemption journals unchanged;
  hide/unload and runtime replacement with a different origin-scoped store.
- Existing build-integrated `smoke-experience.mjs`: emitted Page, API and decoder,
  rendered WXML, known and unknown history, dirty selection, pending sign-in and
  redemption handles, and application hide. Original save/recovery flows remain.
- Existing `experience-native-roundtrip.test.ts`: emitted personal Page, runtime,
  API, gateway and decoder through loopback HTTP to ordinary AppModule and
  disposable PostgreSQL; known-zero and unknown-baseline states; fifteen rendered
  rows; no command or extra request when toggling; all application tables and
  sequences unchanged. Pending-journal combinations are separately covered by
  the actual Page unit test, not claimed as PostgreSQL pending-journal coverage.
- Existing contract/gateway/runtime/redemption/ranking tests and all ten existing
  experience integration files remain regression gates. No timeout, budget,
  skip or test-selection relaxation is introduced.

These are local simulated-platform checks, not WeChat physical-device rendering,
real-provider acceptance, historical import, campaign activation, role appointment,
complete-population coverage or completion of Experience/Next.

## Local verification — 2026-10-13

On the implementation based on `319b3cc910627f6aa67d80b2d5ff9d61f649e0c9`:

- Focused actual Page/WXML and controller tests: 26 passed, zero failures/skips.
- Default-heap API typecheck and complete `npm run check`: exit 0, including
  2,028 API and 3,076 native unit tests, strict types, lint, tooling tests,
  OpenAPI verification and all workspace builds/emitted smoke checks.
- All ten existing experience PostgreSQL files: 114 passed, zero failures,
  cancellations or skips on disposable PostgreSQL 18.6, followed by confirmed
  shutdown. This adds one emitted-directory scenario to the previous 113 tests.
- All 3,472 source files and 890 emitted payloads had identical before/after
  SHA-256 inventories across the successful full check and final PostgreSQL run.
  Only acceptance documentation was updated afterward. All 132 existing SQL
  migrations remained byte-identical to the base.

Earlier failures were retained rather than relabeled: a test runtime-factory
wiring error; an incomplete test Safety rejection branch; and an unintended
static native type import in the API test, which pulled the separate native
CommonJS graph into API typechecking. The latter first exhausted the default
heap, then a larger-heap run was killed, and a 3GB run exposed cross-project
module errors. A precise local test interface and strict index accesses fixed
that boundary; final checks used the default heap without repository configuration,
assertion, timeout or budget relaxation. These earlier runs are not passes.
