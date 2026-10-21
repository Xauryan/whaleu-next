# Framework7 iOS → WhaleU native mini-program port

This is a project-owned native adaptation, not an official Framework7 WeChat implementation. It does not execute Framework7, Dom7, a browser router or an embedded web-view. Existing Page controllers, transport contracts and authorization remain authoritative.

## Pinned source and license

- Framework7 **v9.2.0**, commit `7668f883c29f69dd2ad7bd8ac3b35b9124082b0b`.
- Release: https://github.com/framework7io/framework7/releases/tag/v9.2.0
- Source root: https://github.com/framework7io/framework7/tree/v9.2.0/src/core/components
- Full MIT license: `docs/vendor/framework7-v9.2.0/LICENSE`. Copyright (c) 2014 Vladimir Kharlampidi.
- Upstream paths/blob identities: `docs/vendor/framework7-v9.2.0/upstream-manifest.json`.
- The complete license is also shipped as `third-party-notices.json` with every release containing native F7 ports. Packaging rejects a missing/modified pinned license.

Use the fixed source rather than the live documentation's token table: live docs and v9.2.0 differ in some defaults. No Apple fonts or SF Symbols are copied. System fonts resolve locally; no font binary is bundled.

## First implementation mapping (v27 checkpoint)

| Upstream component / source                                | Native component                  | Scope                                                                                       |
| ---------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------- |
| Button, button-vars.less, button.less, button-ios.less     | components/f7-button              | Plain/fill/tonal/outline, normal/small/large, round, disabled/loading, isolated press event |
| Content Block, block-vars.less, block.less, block-ios.less | components/f7-block               | Optional strong/inset/outline, title/footer and slots                                       |
| List View, list-vars.less, list.less, list-ios.less        | components/f7-list                | List grouping with optional inset/strong/outline                                            |
| List Item, same List sources                               | components/f7-list-item           | Static or actionable row, media/title/body/after/footer, native activation                  |
| Segmented Strong, button-vars.less and button.less         | components/f7-segmented           | Controlled options/value, isolated change, active highlight, disabled items                 |
| iOS Preloader, preloader vars/base/ios                     | Embedded button/row loading state | Native views, no fonts or remote assets                                                     |

Shared `src/design/framework7-ios.wxss` ports only root/iOS/light/dark variables into `.f7-ios-theme`, never global `page`. It preserves fixed-source list row52px/padding16×12px, list/block inset24px, button radius4px, large48px/17px, Segmented padding2px/gap4px, and upstream dark surface/text values. Native dark appearance uses the existing prefers-color-scheme pathway, not a new account preference or parallel theme manager.

### Explicit platform adaptations

- List/Block `spacing="compact"` is an explicit project adaptation to16px; default remains upstream35px. The prop is internal so native style isolation cannot silently defeat a page-level override.
- Buttons and Segmented keep **44px minimum interactive targets**, intentionally larger than upstream normal34px/small28px. The source token values remain documented rather than falsely described as pixel-identical.
- DOM anchors/list elements become native button/view/slot structures. Routing, login/phone permissions, confirmation and cancellation are not proxied by the components.
- Segmented uses a controlled `value`; a tap emits a proposed `change` without changing domain selection. Duplicate/invalid/more-than-ten options fail closed; active or disabled taps do not emit. A native highlight reproduces the padding/gap geometry and200ms transition, with reduced-motion fallback. No DOM queries or sibling selector indexing.
- List-item slots are presentational only when the row is actionable; do not nest independent buttons/navigators beneath its hit layer. Secondary interactive actions must remain siblings or native controls.
- Native loading states and disabled controls suppress business events. No hidden requests, timers or background mutation retries are introduced.
- Slot and event behavior, focus, scrolling/pressed-state cancellation, runtime theme changes and native accessibility still require WeChat device validation. Source-generated HTML is an approximation, not that proof. In particular the static renderer expands actual native templates and slots but does not enforce native stylesheet isolation; its disabled/pressed appearance is not device evidence.

## Current source coverage (October 20, 2026)

The current source inventory has **114 component-using routes** and **3 accepted-layout exceptions** (`community-feed`, `inbox`, `me`). Actual literal template invocations and includes are traced; unused definitions and commented tags do not count. See [the route matrix](NATIVE_COMPONENT_FLOW_COVERAGE.md) for exact retained native controls, focused test references and separate business/provider/device gates. No route is labeled fully verified. This is not a claim that every native control has been replaced or every backend/business feature is complete.

The stage descriptions below retain the historical scope of their original increments; they are not the current total. Source implementation, successful test executions and physical-device acceptance remain separate.

## Historical first page migration boundary

The first stage migrated only `campus-tools`, `directory-hub`, `directory-list` and `browsing-history`. Original action datasets, visibility/disabled guards, current owner checks, pagination and recovery are retained. Directory categories adapt the controlled change event to the original `onKind` controller call.

Native navigators remain native to preserve route semantics. The destructive history-clear confirmation stays a native danger-styled button until a reviewed destructive component variant exists. Native inputs and conditional recovery notices remain where necessary; this is not a claim that every control on the four pages has already been ported.

Approved `community-feed`, `inbox`, `me`, their global tokens and layouts remain unchanged. At that first-stage checkpoint, the other 113 registered pages were not yet Framework7 component migrations, even though v26 had supplied presentation candidates for all 117. The current totals above supersede that historical count.

## Further component boundaries

Navbar still needs native safe-area/permission adaptation. Input/Searchbar and Toggle are implemented in the second stage described below. Sheet/ActionSheet needs controlled visibility, safe-area ownership, background observer suspension, cancel/back/close handling and focus restoration before migration of any mutation surface. Overlay components are not implemented by the first or second stage. Do not mechanically replace native authorization controls or existing uncertain-request recovery with a new visual abstraction.

## Verification

Require component state/event tests, before/after action parity, light/dark source previews from the actual component WXML/slots, native build/emitted smokes, package graph/license/budget checks and immutable source export. Record observed outcomes separately; no PostgreSQL, production provider or Tencent-device validation is implied by component tests.

## Second stage: native form controls (source implemented)

The fixed-source mapping now adds `components/f7-input`, `f7-searchbar` and
`f7-toggle`. Their source references are the corresponding `*-vars.less`, base
and iOS LESS files in the pinned upstream manifest. Upstream JavaScript is a
behavior reference only: no DOM runtime is copied or installed.

- Input and Searchbar wrap real native `input` controls. Owners retain draft
  values, selection and submit authority. Input strings are not trimmed,
  truncated or rewritten by JavaScript; native IME events are not treated as
  browser composition events. Clear and cancel emit intent, not mutations.
- Read-only uses the native disabled editor because WeChat does not provide a
  browser-style read-only input. Errors and descriptions remain contextual.
- Toggle uses the source-derived 64 × 28 px track, 38 × 24 px knob, 22 px travel
  and 300 ms transition, with a real native switch/label as its activation and
  accessibility surface. Only the owner `checked` property controls the visible
  track. A native control can transiently change internally before its event;
  reconciliation happens before dispatch and is not a successful saved setting.
- Searchbar preserves the pinned glass token as provenance, but uses an explicit
  opaque native surface (#fff light / #323232 dark) for its input and cancel
  control because browser backdrop blur is unavailable. This readability
  adaptation is not a claim of glass-effect fidelity.
- Disabled/read-only, page hide/detach and stale events must not dispatch actions.
  The minimum activation area remains 44 px where upstream visuals are smaller.

The second-stage consumers are `community-search`, `settings`, `directory-detail`
and `school-services`. Their source/action inventories, controller regressions,
emitted build and package gates passed in the sealed v28E checkpoint. Device
acceptance remains separate. The original four v27 routes stay separately
recorded; none of these stages changes the accepted Home, Messages or Me layouts.

### Evidence boundaries

Component registration/event unit tests and source-rendered light/dark HTML do
not establish native keyboard/IME ordering, focus behavior, transparent-switch
hit testing or assistive-technology behavior. Those are explicit Tencent
DevTools/real-device gates. The per-route migration and flow matrix records these
separately from database and provider coverage.

## Third stage: controlled overlays and identity consumers (in progress)

`f7-sheet`, `f7-actions`, and `f7-dialog` transcribe the same pinned source into
native components. Their shared lifecycle has owner-controlled visibility,
unique opening/session identity, generation and attempt fences, native render
acknowledgements, and cancellation on hide/detach. A captured interaction key
travels through the actual Button so a delayed old native hit cannot authorize
a newly rearmed confirmation. Both action and request-close events carry the
captured attempt; owners must reject already-emitted stale events as well.

The native Sheet deliberately uses a backdrop, unlike Framework7's iOS default
of no backdrop. This is a documented safety adaptation, not an upstream default.
Dialog uses the actual source's round, large 48px Button composition rather than
the obsolete 44px variable. Native opaque surfaces replace unavailable browser
backdrop-filter. No Apple font or symbol assets are bundled.

Owners must acquire their page scrolling/occlusion lease before opening and
retain it until a valid native closed acknowledgement. Components do not own
business readers: exposure/read observers must be paused by the consumer when
present. The first browsing-history consumer has no such observers; it fences
background navigation, current owner, hide/logout and local-clear retries.
Native page-meta scrolling behavior still requires official support verification
and a real-device gate; static HTML omits this nonvisual control and cannot prove
that scrolling was locked.

Six additional source consumers are login, phone-binding, campus,
identity-campus, verification and institutional-verification. Real native
getPhoneNumber and consent controls remain platform-owned. Their 62 original
bindings retain their guard/constraint inventory, and Page/controller TypeScript
remains unchanged. The source fixtures are fictional and cannot establish login,
school authorization, evidence handling or provider availability.

Static overlay previews execute the actual trusted local Component attached,
render callbacks and a bounded synthetic timer queue, record lifecycle events,
capture projected data, then detach and restore globals. They never invoke
business actions or manually fabricate an open component projection. These are
source/model checks, not WeChat animation, keyboard, focus or accessibility proof.
