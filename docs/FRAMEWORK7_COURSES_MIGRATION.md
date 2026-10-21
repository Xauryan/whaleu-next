# Native Framework7 courses: three-page source freeze

## Scope and pinned reference

The runtime changes are limited to WXML/WXSS/JSON for `course-ratings`,
`course-rating-detail`, and `course-comments`, plus the isolated
`src/course-ratings/framework7-product.wxml` and `.wxss` presentation fork.
No business, controller, gateway, pending-store, contract, Page TypeScript,
shared component, accepted Home/inbox/Me, global app, or legacy presentation
file is changed by this migration.

The pages reuse the shipped project-owned native adaptations of Framework7
**v9.2.0**, commit `7668f883c29f69dd2ad7bd8ac3b35b9124082b0b`.
The fixed button, block, list and input vars/base/iOS LESS references and MIT
license are recorded in `docs/vendor/framework7-v9.2.0/`. Their pinned source
was inspected from the existing local reference, not a moving live token table.
No dependency, browser runtime, H5, web-view, Apple font or symbol asset is added.

## Exact migration map

These are source nodes, not repeated runtime instances.

| Source                              | Original actions | Native components introduced                   | Retained native boundaries                                                        |
| ----------------------------------- | ---------------: | ---------------------------------------------- | --------------------------------------------------------------------------------- |
| course-ratings                      |               11 | 6 Button, 1 Block, 2 Input, 1 List, 1 ListItem | Department picker, navigation, pagination and exact filters                       |
| course-rating-detail                |               11 | 9 Button, 1 Block                              | Existing modal containers, navigation and separate final first-score confirmation |
| course-comments                     |               23 | 19 Button, 1 Block                             | Native textarea, navigation, existing compose/like/cancel confirmation containers |
| course-only status/summary template |                6 | 4 Button                                       | Login/phone-verification navigators and unknown-state text                        |

All **51 original action nodes** retain their datasets, handlers, loading and
disabled conditions, editor constraints, navigation destinations and ancestor
conditional/loop/hidden/disabled/loading gates. The normalization changes only
the native custom-event boundary (`bindtap` to `bind:press`, and the two Input
controls' `bindinput`/`bindconfirm` to `bind:input`/`bind:confirm`). No Page adapter
was introduced. The actionable ListItem has no nested independent control.

Buttons retain the established 44 px minimum activation adaptation; primary
commands use the 48 px large style. Block/List compact spacing remains the
existing explicit 16 px project adaptation. Course-only host rules preserve the
five-column half-step score layout, fluid search and action dock, and wrapping
controls. Isolated components retain responsibility for their own colors,
pressed/disabled state and target sizes.

## Frozen safety boundaries

`test/fixtures/framework7-courses-before-actions.json` contains the pre-edit
source hashes and complete original action inventories. The protected manifest
contains **65 source files**, including all course business modules, every owned
Page TS, original course/ratings presentation files, accepted Home/inbox/Me,
app roots/design tokens and the reused native components. Their hashes are
asserted unchanged. The baseline was captured before edits and was not changed
to accommodate a behavioral difference.

Independent first scores remain one-time and immutable. All thirty half-step
controls preserve numeric datasets; no axis is computed from another.
Unknown history is never treated as an empty or unscored success. Frozen
recovery retains the original request identity, revisions and exact tuple.

Comments keep their anonymous-only public shape with no author/avatar/persona,
self-eligibility, unlike, delete or reply controls. Original UTF-8 text remains
unchanged through native textarea preview and publication. Likes retain their
separate irreversible confirmation. Query-first retry and independently
confirmed cancellation preserve a possibly completed original operation.
Page hide, delayed hits, account changes, journal persistence and source/history
withdrawal remain the existing owners' responsibility and are regression tested.

## Verification observed

- Focused migration suite: **21/21** passing.
- Focused plus all existing `course-*.test.ts`: **74/74** passing.
- Actual registered Button/ListItem methods emit isolated events through the
  unchanged shared `native-press-emitted-harness.mjs` with `extension: 'ts'` into
  real Page/controller/gateway fixtures. Imported status templates, visible
  nodes, ancestor gates, typed datasets and stale captures are followed.
- Actual registered Input methods execute before Page delivery; source-native
  input/confirm bindings, maxlength, raw drafts, busy and lifecycle suppression
  are checked. The retained picker and textarea are explicit native-event model
  boundaries, not fabricated custom components.
- Tested flows include course filters/sort/navigation/pagination/revision drift,
  all thirty half-step inputs, score close/confirm/read-only success/recovery,
  exact comment preview/publish/retry, irreversible like, cancel-vs-completed
  recovery, account changes and hidden/delayed events.
- Existing contract/controller/gateway regressions cover privacy projection,
  unavailable history, receipt tuple matching, journal readback, source loss,
  secure-UUID races, account/origin isolation and signed-out transport.
- **34 fictional default-array fixtures** cover catalog, detail and comments,
  including guest, busy, unavailable, recorded, confirmation and frozen recovery
  states. Their text assertions expand actual registered Component WXML and
  slots without invoking business actions. Shared preview-generator registration
  belongs to the integration owner and is not changed here.
- Focused ESLint passes. Combined ES2020 test typecheck passes against the source
  snapshot used for the freeze; the integration owner must repeat canonical
  compile/build/emitted smokes/package-budget/license checks on the final combined
  source.

Only the authorized two legacy template tests changed: the course-ratings test
reads the actual isolated imported template, and the course-comments selector
recognizes `wu-f7-button`/`bind:press` while retaining its safety assertions.
No shared smoke, shared harness or baseline for another migration was edited.

## Evidence limits and freeze

These are source and model checks, not native device or provider acceptance.
No browser, emulator, build, `dist`, release, database, production provider,
external mutation, commit, push or deployment was run by this migration.
Native stylesheet isolation, keyboard/IME, focus, safe-area, touch targets,
scroll/cancel timing, overlay behavior and accessibility still require Tencent
DevTools/real-device validation. Static fixture text does not prove those facts.

`docs/FRAMEWORK7_COURSES_SOURCE_FREEZE.json` lists the exact owned files and
SHA-256 values. It excludes its own hash. Verify it before integration.
