# Native Framework7 ratings: five-page source freeze

## Scope and fixed reference

The only runtime edits are the WXML/WXSS/JSON of `rating-catalog`,
`rating-detail`, `rating-thread`, `rating-create`, and `rating-scoped`, plus
`apps/wechat/src/ratings/framework7-product.wxml` and
`apps/wechat/src/ratings/framework7-product.wxss`.

These pages reuse the project-owned native adaptations of Framework7 **v9.2.0**,
commit `7668f883c29f69dd2ad7bd8ac3b35b9124082b0b`. Reference files are the
button, block, list and input vars/base/iOS LESS under
`src/core/components` in that pinned release. The MIT license and upstream blob
identities remain in `docs/vendor/framework7-v9.2.0/`. No Framework7 DOM runtime,
new dependency, H5, web-view, Apple font or symbol binary is added.

The pre-edit action capture was made after the integration owner's V29B source
checkpoint, whose manifest SHA-256 was
`d121ad064f5ab283f416c188298be9193906ed115b5e0cf76b11f131f0333440`.
Both original ratings product files and every ratings TypeScript source remain
byte-identical. The isolated template is consumed only by the five named pages;
legacy ratings, course, window and management surfaces are not re-skinned.

## Exact migration map

Counts below are source nodes, not repeated runtime list instances. Shared
status/like template nodes are counted separately.

| Page                                   | Original action nodes | Native components introduced                               | Explicitly retained native boundaries                                                                                    |
| -------------------------------------- | --------------------: | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| rating-catalog                         |                    21 | 14 Button, 1 Block, 2 List, 2 actionable ListItem          | Navigators, range disclosures, category/target identity and pagination                                                   |
| rating-detail                          |                    28 | 27 Button, 1 Block                                         | Textarea, independent score confirmation, author identity selection, existing modal containers and deletion confirmation |
| rating-thread                          |                    21 | 18 Button, 1 Block                                         | Textarea, reply anchors, quote visibility, existing reply/delete modal containers                                        |
| rating-create                          |                     7 | 4 Button, 1 Block, 1 Input                                 | Textarea, native maxlength values, explicit server-confirmed cancellation, return navigator                              |
| rating-scoped                          |                    77 | 65 Button, 1 Block, 3 Input, 2 List, 2 actionable ListItem | All scoped submodes, native cover/media template, thumbnail observer anchors, textareas and existing modal containers    |
| isolated product status/like templates |                     9 | 5 Button                                                   | Four navigator actions and unknown-state text                                                                            |
| unchanged target-cover templates       |                     8 | None                                                       | Six native security/media buttons and image tap/error callbacks                                                          |

All **171 original action nodes** retain their datasets, event destinations,
loop/conditional ancestor scopes, disabled/loading conditions, input constraints
and navigation targets. Only the explicitly migrated Component event boundary
changes: `bindtap` becomes `bind:press`; `bindinput` becomes `bind:input` for the
four one-line editors. No Page/controller adapter or state module was added.
ListItem contains no nested independent action. Secondary actions remain siblings.

Buttons retain the existing bounded native 44 px target adaptation; primary
commands use the pinned 48 px large style. Compact Block/List spacing remains
the established explicit 16 px project adaptation. Host-only layout rules allow
buttons to wrap and keep the five-point scale/dock fluid. The existing flat
content-first product text, uncertainty states and contextual disclosures remain.
No generic card or duplicated title prose is introduced.

## Frozen safety boundaries

`test/fixtures/framework7-ratings-before-actions.json` stores original hashes
and complete action/ancestor inventories. The companion
`framework7-ratings-before-protected.json` protects **146 source files**, including
all ratings controllers/contracts/gateways/media/receipt modules, five Page TS
files, accepted Home/inbox/Me roots, design tokens and app globals. Protected
source hashes are asserted by the focused migration suite.

No new overlay is introduced. Existing composer, score, delete and media
containers retain their owners and lifecycle. Cover viewport anchors remain
native `view` elements, and the original thumbnail observer implementation,
media upload/read permissions, request identities, unknown receipt recovery,
anonymous 分身 author restrictions and account/hide clearing are unchanged.

## Verification observed

- Focused migration suite: **24/24** passing, including exact parity, protected
  hashes, actual Component registration → emitted isolated event → Page → real
  controller/gateway flows, draft raw-value retention, delayed/hidden control
  suppression, explicit score/definition/delete/cancel confirmation and
  frozen retry identity. Tests use ES2020-compatible array operations.
- Focused plus directly affected legacy source suites: **42/42** passing.
- Broad `ratings-*.test.ts` and `rating-*.test.ts`: **805/805** passing after
  correcting three stale static entry binding assertions in owner-management
  and owner-editing smokes. The initial run was 803/805; only those assertions
  failed. The category-management entry assertion was also corrected without
  changing its native management scenario or confirmation checks.
- **53 fictional source fixtures** cover all five pages, scoped catalog/detail/
  thread/create/edit/random/subscriptions/updates modes, guest/busy/error,
  score/author/delete/cancel confirmation, frozen recovery and unknown counts.
  Actual local templates, Component WXML and slots are expanded for text checks.
- Isolated emitted-model diagnostic: six legacy ratings smoke families
  (R1, R2A, R2B, R2C, R3R and scoped), target-cover Page smoke, and the three
  ratings-assistance emitted tests pass. Real registered Button/ListItem and
  Input methods execute before Page delivery; no custom-event alias directly
  calls a Page handler. Actual imported templates are followed. Existing direct
  Page-method calls remain explicit legacy controller/hostile-event probes,
  not claims about component delivery.
- Lint passes for owned test/fixture/smoke scripts. Canonical combined ES2020
  typecheck, build, package/budget graph and integration previews belong to the
  integration owner and must be re-run against the final source freeze.

### Diagnostic provenance and limitations

The emitted diagnostic copied frozen V29C emitted JS into an isolated temporary
fixture and overlaid only the owned WXML/WXSS/JSON and isolated presentation
files. No compiler was run and no original/live `dist` was written. The saved
before/overlay manifest identifies that model explicitly; it is **not** a new
canonical build or final release acceptance. Initial diagnostic failures were
missing synthetic `SafetyChanges` in the diagnostic runner, fixed by constructing
that existing emitted runtime dependency, not by changing application code.

Source projections do not prove WeChat stylesheet isolation, keyboard/IME,
focus, safe-area, touch, observer timing, animation or accessibility behavior.
No browser, emulator, production provider, PostgreSQL flow, live mutation,
commit, push or deployment was performed by this five-page migration.

## Freeze artifact

`docs/FRAMEWORK7_RATINGS_SOURCE_FREEZE.json` enumerates the exact owned files and
SHA-256 values. Integrators should verify the list before canonical compilation;
the manifest does not hash itself. Shared `test/framework7-action-parity.ts` is
an integration dependency owned/frozen by the information-page migration and
is intentionally not claimed as a ratings-owned edit.
