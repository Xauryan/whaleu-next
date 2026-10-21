# Framework7 native composer and discussion migration

## Scope and provenance

This change migrates presentation in exactly `compose-entry`, `community-compose`,
`community-detail`, and `community-thread`. It reuses the existing project-owned
native Framework7 9.2.0 Button, Block, List, ListItem and Input adaptations.
Upstream remains commit `7668f883c29f69dd2ad7bd8ac3b35b9124082b0b`, MIT licensed;
source references and the complete license are in `docs/vendor/framework7-v9.2.0`.
No Framework7 DOM runtime, dependencies, browser/web-view or remote assets were
introduced. This is not an official Framework7 WeChat implementation.

The established flat writing canvas, post/reply hierarchy, contextual management
menus and fixed bottom action docks are retained. Blocks replace existing flat
containers rather than adding hero panels. Existing page-local styles remain;
the isolated composer stylesheet resets only native component hosts so old
button padding does not double their hit geometry. The native component's
44 px minimum target remains an explicit platform adaptation, not pixel-identical
upstream behavior. Slotted list rows contain presentation only.

## Binding and authority inventory

The pre-edit inventory records 280 original actions with every original attribute,
dataset, conditional/loop ancestor, loading/disabled gate and navigation target:

| Route             | Original actions | F7 Button | Block | List | ListItem | Input |
| ----------------- | ---------------: | --------: | ----: | ---: | -------: | ----: |
| compose-entry     |                6 |         2 |     3 |    3 |        3 |     0 |
| community-compose |               68 |        22 |    10 |    4 |        4 |    16 |
| community-detail  |              145 |        73 |    12 |    3 |        3 |     4 |
| community-thread  |               61 |        21 |     6 |    1 |        1 |     0 |

Normalization is limited to the real Button/ListItem `press` and Input `input`
boundaries. All original attributes and ancestor guards are still asserted; no
handler alias changes a production Page. `test/fixtures/framework7-composer-before-protected.json`
records 217 byte-identical protected files, including all four Page/controller
TypeScript sources, shared contracts and gateways, pending journals, media and
identity/privacy implementations, and accepted community-feed/inbox/Me roots.
No Page/controller TypeScript was changed.

### Deliberately native controls

- The writing textarea remains native for multiline editing, keyboard and IME.
- All privacy/consent/identity switches remain native, including related-campus
  sync, anonymous DM intent, comments policy, feedback/trading/formation consent.
- Image selection, batch order/replacement/removal/recovery and gallery/avatar
  entry/read/close/error controls stay native. Their temporary local sources,
  no-longpress-menu flags and clear-on-hide/scroll behavior are unchanged.
- Existing deletion confirmation, member-contact dialog and private gallery
  surfaces are not replaced. Their current owner generation, lifecycle,
  permission rechecks and exposure/read barriers remain authoritative.
- Native navigators and the trading share open-type remain native.
- Shared community recovery, moderation, rating-link and identity templates are
  unchanged. This is a controlled route migration, not a claim that every
  control in every imported template has been ported.

## Runtime evidence

`framework7-composer-migration.test.ts` executes actual Component registrations,
Page registrations and existing controllers. It verifies:

- Destination selection, inactive campuses, busy gates and navigation ownership.
- Actual custom Input event details and host datasets, unmodified decimal/contact
  drafts, no rounding, no implicit consent, and suppression after hide/detach.
- Anonymous publication identity, exact pending payload and original request ID,
  receipt queries, cancellation that retains the pending journal, and same-payload
  retry after response loss.
- Detail sort/order and opaque cursors, cancellation, late response rejection,
  cleared private content and account changes.
- Post/reply likes and original pending keys, frozen suppression, and unchanged
  recovery authority; save mutation and native delete/report confirmation gates.
- The rendered-source bridge resolves the actual registered native Component,
  original menu ancestors and typed host datasets before dispatch, and rejects
  closed-menu or hidden stale captures. It does not fabricate handler aliases.

The existing shared recovery controls are deliberately invoked through their
unchanged native Page paths where they have not been migrated. Source/hash tests
separately ensure those original bindings are intact.

## Legacy test and emitted-smoke adaptations

All test and script references to the four routes were searched before freeze.
The exact reference list is recorded in the source-freeze manifest.

- `core-product-presentation.test.ts`: apply existing bounded action
  normalization to these four routes; preserve profile coverage, the single
  submit assertion and nullable-management visibility guards.
- `admin-discussion-removal.test.ts` and `admin-post-removal.test.ts`: exact
  native custom-tag/press selector, retaining nonself eligibility, anonymous
  eligibility, no role-derived authority and irreversible-consequence assertions.
- `smoke-admin-discussion-removal.mjs`: six rendered entry bindings now execute
  real isolated Component presses through `native-press-emitted-harness.mjs`.
  Original self-suppression and direct missing/stale-target negative probes stay.
  The synthetic DTOs include their actual presentation fields so the full ancestor
  tree can render rather than dispatching an isolated handler name.
- `smoke-discussion-pagination.mjs`: positive rendered sort/next/previous/inline
  continuation/reload/cancel paths use the real bridge. Direct concurrent and
  unavailable-page negative probes and all cursor/clear/recovery assertions stay.
- `smoke-runtime-policy.mjs`: the disabled submit is tested through the native
  Button in addition to its original direct controller-negative probe; successful
  like and publication receipt paths use the actual component bridge. Original
  lost-response, visibility, current-authority and request-key checks stay.

No shared harness was modified by this task. Its js/ts support was supplied by
its owning worker and is recorded as a dependency, not an owned source change.

## Preview and evidence limits

`framework7-composer-preview.mjs` supplies 32 fictional states. Source rendering
passes all 64 light/dark frames, plus existing core 12 and menu/settings 4 frames.
Fixtures cover visitors, inactive/loading/error destinations, named and anonymous
writing, reply scope, polls, teams, public feedback, trading, rating links, media
batch recovery, approval/receipt/cancel states, detail/thread pagination, private
media unavailability, contextual menus and native confirmation surfaces.

The populated trading field intentionally hides its placeholder. Preview checks
therefore use the existing visible price constraint label; a separate exact
source assertion retains `如 12.345，不会四舍五入`, and a real Input → Page → controller
test verifies the string `12.345` remains unchanged. Multiline prose is checked
as both visible sentences after renderer whitespace normalization. Idle recovery
and active waiting are separate fixtures: stop-waiting controls are asserted only
in the busy states where the original template actually renders them.

Observed local results:

- Migration suite: 18/18 passing.
- All route-referencing legacy/source tests, including this suite: 650/650 passing.
- Scoped ESLint and JavaScript syntax checks: passing.
- Source preview: 64/64 composer frames, core 12/12, menu/settings 4/4 passing.
- All 280 action constraints and 217 protected-file hashes: passing.

Canonical TypeScript, emitted builds/smokes, package graph/license/budget and
release checks belong to the integrator. This task did not write build/dist,
perform a full build, access PostgreSQL or contact real providers. Source models
are not Tencent DevTools/device evidence for component isolation, native keyboard
and IME ordering, hit targets, focus, scrolling, screen readers, permissions or
observer timing. Those remain explicit device acceptance gates.

## Dependency and package impact

The main-package `compose-entry` route registers only already-promoted
Button/Block/List/ListItem families. Input is limited to feature routes. The one
shared route-local stylesheet imports the existing F7 theme; there are no new
component families, runtime dependencies, fonts or image assets. Final dependency
closure and main/subpackage byte budgets must be measured by the integrator.
