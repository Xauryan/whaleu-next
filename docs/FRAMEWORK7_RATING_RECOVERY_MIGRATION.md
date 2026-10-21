# Native Framework7 rating management and recovery

## Scope and provenance

This batch migrates the native presentation of exactly eleven routes:

- `rating-random`, `rating-discussion-media`, `rating-recovery`, `rating-deletion`
- `rating-category-create`, `rating-category-manage`, `rating-category-editor`
- `target-owner-delete`, `target-owner-edit`
- `window-discussion-recovery`, `major-discussion-recovery`

Runtime edits are limited to their WXML/WXSS/JSON and six new isolated
presentation files. All eleven Page TypeScript files, business controllers,
contracts, gateways, pending stores, request identities, permission checks, CAS
rules and media lifecycles are unchanged against the pre-edit capture. The large
pre-existing dirty working tree is not a baseline for attributing this batch.

The fixed reference is Framework7 **v9.2.0**, commit
`7668f883c29f69dd2ad7bd8ac3b35b9124082b0b`, using the previously implemented native
Button, Input and Block components. Relevant upstream button/block/input vars,
base and iOS LESS were checked in the pinned reference. MIT attribution and the
upstream source identities remain in `docs/vendor/framework7-v9.2.0/`.
No DOM/H5 runtime, browser fallback, font/symbol binary, dependency, global style,
component implementation or application registration was changed.

## Presentation map

The batch introduces 235 native Button nodes, 13 native Input nodes and 10
compact Block containers across the eleven route files and four isolated WXML
forks. Counts are source nodes, not repeated runtime instances. Category manage
and editor both include the same isolated category presentation. Native
navigators, textareas, images, controlled gallery containers and confirmation
containers retain their original ownership and constraints.

The four forks are:

- `ratings/framework7-recovery-common.wxml`
- `ratings/framework7-recovery-category.wxml`
- `major-discussion/framework7-recovery-common.wxml`
- `window-discussion/framework7-recovery-common.wxml`

Original `common.wxml` and `category-scoped.wxml` files and their original shared
styles remain byte-identical. Only these eleven routes import the new forks.
Host-only styles in `ratings/framework7-recovery.wxss` and
`ratings/framework7-recovery-category.wxss` handle wrapping, spacing, safe-area
ownership and component-host layout. Buttons use the existing native 44 px target
adaptation; primary commands use the pinned 48 px large variant. Compact Block
spacing is the established explicit 16 px project adaptation. Selection uses
the original conditional expression to choose a filled native Button variant.

## Frozen action and safety evidence

`test/fixtures/framework7-rating-recovery-before-actions.json` captures all
**282 original action nodes**, with full original attributes and ancestor
conditional/loop scopes, before any runtime edits. Its SHA-256 is:

`0be8a6ee1335b4842178a6d70d23f56cc0ce919a3989fe53b2b0b0cec47f2db2`

`test/fixtures/framework7-rating-recovery-before-protected.json` captures
**183 protected source/provenance entries**, including all family business
TypeScript, the eleven Page files, original shared templates/styles, reused
native components and nine specifically allocated test/smoke adapters. Its
SHA-256 is:

`702ad98406037a0238bfa4e80aa22358f5dd174bc009eb22eca9fde5ec1c1f10`

The original bytes of allocated adapter files are retained separately; the
protected hash checks explicitly map only those entries to their original
copies. Business and runtime source entries are checked directly. The later
allocated `smoke-ratings-r3r.mjs` original is separately sealed at SHA-256
`7b712d627f43edd27ee62344e51ebc847ece1950a82cae2891a7a83cc4d7f831`.
Neither original manifest is rerecorded after migration.

All action targets, datasets, disabled/loading gates, maxlength/value bindings,
ancestor scopes and all warning text remain exact. The intentional event-boundary
adaptations are only `bindtap` → `bind:press` and native one-line `bindinput` →
`bind:input`. Native textareas remain native. No Page/controller adapter is added.

### One explicitly approved presentation correction

The inherited category lifecycle choice class contained an invalid nested
interpolation: `lifecycleAction === '{{item.value}}'`. Only the new isolated
fork corrects it to `lifecycleAction === item.value`. The original shared
markup and captured hash remain unchanged. Exact parity permits only this
specific old/new class pair on `onChoice` with `data-field="lifecycleAction"`.
A regression checks every real lifecycle option's value, allowed/disabled gate,
selection and native filled state; a fictional lifecycle fixture renders the
same branch. No command, dataset, permission, state or CAS rule changed.

## Verification observed

- **47/47 focused migration tests:** 282-action and warning-text parity, original
  hashes, native registrations and boundaries, actual Component→Page delivery,
  explicit deletion/edit/cancellation confirmation, duplicate/hidden/stale
  suppression, raw Input retention, random candidate results, own-unlike
  membership CAS, and all nine category prepare→full preview→commit operations.
- **42 fictional fixtures:** all eleven pages, random result/empty/guest/busy/
  campus selection, category draft/preview/expiry/lifecycle/icons, owner
  confirmations and recovery, media gallery/cancel, unavailable own history.
  Tests expand the actual imports/includes, native Component WXML and slots.
- **1,243/1,243 broad tests:** the ratings, category, major/window discussion
  families and the ratings/discussions/recovery Framework7 migration suites.
- **91/91 final focused plus affected presentation tests** after the last
  template-resolution refinements.
- The four native/HTTPS smoke suites for owner deletion, owner editing, category
  tree creation and random selection pass using source TypeScript registrations.
  Positive migrated actions execute actual native Component registrations before
  Page delivery; original hostile/direct Page-method probes remain explicit
  negative/controller tests. Random coverage retains the 2,048 candidate pool,
  zero/unknown/empty/unavailable distinction, independent scope and lifecycle
  boundaries.
- The rating media Page smoke passes against selected source TS, including native
  Button→Page publication, ordered-member movement, frozen suppression, gallery
  release and hide. Its new delivery portion uses explicitly labeled controller
  delegate spies; it is not a provider upload or business command claim. The
  unchanged real media pipeline/controller suites are part of the broad run.
- Owned test/helper/fixture/smoke scripts pass ESLint and Prettier checks.

### Include-model boundary

The shared frozen press bridge is unchanged at SHA-256
`f271187e9a5a7110e8d9632b2b88213191e32a878946e9cf5e1ffcfd5ceccd05`.
It follows imports but does not implement WXML `include`. Therefore the two
category wrappers use an explicit bounded test adapter, not a weakened bridge:

1. Read the exact actual static include and reject any other route, dynamic,
   escaping, cyclic, nested include or imported/rebased dependency.
2. Preserve included markup byte-for-byte and assert the deterministic expansion.
3. Stage only the projected presentation and byte-identical native component
   files in a temporary diagnostic tree, with original source/include/projection
   hashes. The actual registered Page and business controller remain unchanged.
4. Use this same include provenance in source tests and the emitted scoped smoke.

This is include-model evidence, not proof of the native compiler. No emitted
application build, live `dist`, release directory or central preview generator
was written by this batch. Existing historical source freezes that list these
reassigned smoke files remain historical; their hashes are not silently updated.

## Remaining acceptance boundaries

Canonical combined ES2020 typecheck, fresh build, package/budget graph, emitted
full application smoke, aggregate coverage/provenance and central visual previews
belong to the integration owner and must be checked against the source freeze.
Source projections do not prove WeChat style isolation, touch, keyboard/IME,
focus, safe area, accessibility, observer timing, gallery/upload timing or device
behavior. No browser, emulator, live provider/API mutation, PostgreSQL flow,
commit, push, merge or deployment was performed by this batch.

`FRAMEWORK7_RATING_RECOVERY_SOURCE_FREEZE.json` enumerates every owned deliverable
with exact SHA-256 and byte count. It does not hash itself.
