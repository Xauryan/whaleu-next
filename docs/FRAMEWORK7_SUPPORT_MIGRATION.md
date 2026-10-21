# Native Framework7 consumer support: six-page source freeze

## Scope and provenance

This migration changes only the WXML/WXSS/JSON for `feedback`,
`feedback-contacts`, `report-progress`, `account-status`, `safety-appeal` and
`status`; the two already consumer-local recovery templates; and one new
consumer support host stylesheet. The six Page TypeScript entrypoints,
feedback controller, shared account-moderation/report/contact controllers,
contracts, journals, privacy/permission boundaries, accepted Home/inbox/Me
sources, component implementations and global tokens are unchanged.

The pages reuse the existing project-owned native Button, Block and List ports
of Framework7 **9.2.0**, pinned commit
`7668f883c29f69dd2ad7bd8ac3b35b9124082b0b`. MIT provenance, the source path/blob
manifest and platform adaptations remain in `FRAMEWORK7_NATIVE_PORT.md` and
`vendor/framework7-v9.2.0/`. No dependency, DOM/H5 runtime, browser router,
web-view, icon or font was introduced. The 44 px Button target and 16 px compact
Block/List spacing remain the existing explicit native adaptations.

| Consumer route    | Button | Block | List | Preserved native exceptions                                                |
| ----------------- | -----: | ----: | ---: | -------------------------------------------------------------------------- |
| feedback          |      3 |     2 |    0 | Native route links and unchanged shared post-pin feed/management templates |
| feedback-contacts |      5 |     2 |    1 | Contact values remain parent-authored slot content, not persisted state    |
| report-progress   |      7 |     4 |    1 | Native navigators; unchanged confirmation/recovery container semantics     |
| account-status    |      4 |     3 |    1 | Native navigators and historical timeline                                  |
| safety-appeal     |      7 |     4 |    1 | Native 4,000-character textarea and route links                            |
| status            |      0 |     1 |    1 | Two native read-only destination links; no new operation                   |

The report recovery template adds ten Button instances; the account/appeal
recovery template adds five. All **61 original action nodes** retain their
handler identity, datasets, disabled/loading expressions, navigation/editor
constraints, and ancestor conditional/loop/hidden/disabled/loading gates.
Exactly 41 Button boundaries change from `bindtap` to `bind:press`; 19
navigators and one textarea remain native. No new Page adapter is needed.
The confirmation containers remain their original native view/alert/dialog
containers, not a new overlay protocol. Post-pin shared templates and all
feedback-notices/admin moderation templates are untouched.

## Preserved safeguards

- Feedback stays global/public and guest-safe. Admin reminders are not added.
  Pinned-content authority and ordinary feed continuation remain controller-owned.
- Every contact reveal/copy obtains a fresh permission check. Stale, failed,
  hidden and switched-account responses cannot repopulate private values or
  reach the clipboard. Contact-field datasets are emitted by the real component
  boundary and delivered unchanged to the Page handler.
- Report/jury confirmation is still explicit. Busy/frozen choices cannot submit
  again, vote identity remains immutable, and protected tallies stay hidden.
  Target-free recovery does not grant removed-content access and only retries
  the exact original request. Report and jury journals remain separate.
- Unknown safety coverage remains unknown, never “clear”. Independent mute and
  suspension status, per-punishment appeal links and history remain distinct.
- Private appeals are not public feedback. Text, confirmation, punishment
  reference/version and retry remain controller-owned. Switching accounts clears
  projections while preserving the original account's journal. Cancellation
  requires its own confirmation and returns an already-recorded result without
  rolling it back. No consumer path invokes an admin gateway.
- The development status page retains the disclosure that production services
  and automatic login are not connected. No provider capability is invented.

## Original evidence and narrow compatibility changes

`framework7-support-before-actions.json` stores the eight original WXML source
hashes and action inventories, captured before repository writes were released.
`framework7-support-before-protected.json` records **137** immutable entries:
136 runtime/helper source files plus the original legacy presentation-test
source. The unchanged legacy support stylesheet is hashed from its separately
captured original copy, not from a re-recorded post-migration source.

The original `support-product-presentation.test.ts` is preserved byte-for-byte
as `test/fixtures/framework7-support-original-presentation.txt`, with SHA-256
`5ad9b1518a8d12b576f340626245b1f883f52f29e884cfe1af5eb4256645e32e`.
The protected test explicitly maps only that entry to its original evidence
copy. All other protected entries still read the live source. Its existing
business assertions and `support-action-inventory.json` stay intact; the test
normalizes only the known Button event boundary and the two known
presentational Block/List ancestor tags. It does not re-record the inventory
or admit arbitrary custom components.

Two allocated smoke changes are limited to consumer paths:

- `smoke-reporting.mjs` uses `createNativePressBridge` for the target-free
  report-progress receipt control and additionally checks both consumer WXML
  files. Existing shared-report controls and deliberate raw negative probes
  remain intact.
- `smoke-account-moderation.mjs` dispatches actual consumer Button presses
  through the registered component bridge. Native textarea events and every
  admin control path remain on their original native-control path.

The frozen bridge is unchanged at SHA-256
`f271187e9a5a7110e8d9632b2b88213191e32a878946e9cf5e1ffcfd5ceccd05`.
No unknown-component fallback or shared helper was loosened.

Cross-family searches covered all test/script references to the six page paths
and names. The account moderation registration/shared-admin-screen assertion,
Me menu-link assertions and smoke-build route exclusion need no changes. The
central coverage inventory's negative fixture currently uses the `status`
route as an unfinished example; its owner must select a still-unfinished route
when marking this family implemented. This worker did not edit coverage.

## Observed verification and remaining acceptance

- Original support/feedback/account-moderation/report-gateway baseline:
  **64/64** tests passed before writes.
- Dedicated migration suite: **25/25** passed, including exact action and
  protected-source parity, registered component constraints, 23 fictional
  fixture contracts, and eight real registered Component → Page → controller
  flow proofs using the unchanged source-mode bridge.
- Focused support, feedback, account moderation, report contract/controller/
  gateway, view reporting, trading, admin-presentation and WXML syntax checks:
  **180/180** passed. Additional migration/Me-menu/feedback-admin-notice preflight:
  **41/41** passed. These are overlapping focused sets, not aggregate full-suite
  totals.
- Scoped ESLint, JavaScript syntax and selected-file Prettier checks passed.
- Actual component-source/slot preview expansion passed all **46 light/dark
  frames** from the 23 dedicated fictional fixtures. This is static semantic
  source-preview validation, not a browser screenshot or native rendering proof.
- Source presentation size changes from **43,540 to 50,294 bytes**
  (**+6,754 bytes**) across the six page triplets, two local recovery templates
  and new host stylesheet. No new component implementation or transitive
  dependency is introduced. Release package sizes require the central build.

The central integration owner must run serialized source/test TypeScript,
combined emitted smokes, package/import/icon/license/budget checks and coverage
updates against the final combined artifact. This worker did not run workspace
TypeScript or build, or write dist/release. No browser, emulator, database,
production provider/moderation action, commit, push or deployment was performed.
Tencent DevTools and real-device acceptance remain **unrun**, including native
style isolation/slot layout, touch/scroll cancellation, keyboard/IME, focus,
safe-area and accessibility.

`FRAMEWORK7_SUPPORT_SOURCE_FREEZE.json` lists the exact owned source manifest and
SHA-256 hashes, excluding its own hash. Verify it before integration.
