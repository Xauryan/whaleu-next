# Framework7 native errands transcription

## Scope and provenance

This stage transcribes exactly five existing user-facing routes: `errand-list`,
`errand-mine`, `errand-detail`, `errand-compose`, and `errand-notices`. It does not
migrate `errand-admin` or `errand-restrictions`, change accepted Home/Inbox/Me,
or execute Framework7's DOM runtime.

The existing native Button, Input, Content Block, List and List Item ports derive
from Framework7 **v9.2.0**, commit
`7668f883c29f69dd2ad7bd8ac3b35b9124082b0b`. The pinned reference was inspected at
`src/core/components/button/button-vars.less`, `block/block-ios.less`,
`list/list-ios.less`, and `input/input-ios.less`. Full upstream identities and
MIT license remain in `docs/vendor/framework7-v9.2.0`; the existing packaged
third-party notice requirement remains unchanged.

No runtime dependency, shared component implementation, browser/emulator,
provider request, build/release output or Git publication is added by this work.
The pages reuse the already-existing `f7-button`, `f7-input`, `f7-block`,
`f7-list`, `f7-list-item` and local icon components. The only new presentation
closure is `src/errands/f7-common.wxml` and `f7-errands.wxss`.

## Preserved product hierarchy

- Discovery and personal orders retain exact reward strings, order state,
  public description, target campus, time and image count. A native F7 list
  groups each summary and its separate detail action; no actionable control is
  nested inside a List Item slot.
- Target-campus search and sort remain bounded owner-managed disclosures.
  Filter/relation selections use native F7 buttons with the original datasets,
  not a new Segmented adapter or independent selection state.
- Detail preserves participant-only notes/images, accepted-state-only contact
  information, target-region group notices, controlled media readers and the
  existing capability-dependent action bar.
- Compose preserves required title, description, time, reward and both publisher
  contacts; optional private text and six public/private image slots stay
  collapsed by default. Accepters still need at least one contact method.
- Notices retain accepted/completed navigation and administrative historical
  records. A restriction record is not represented as current restriction state.

Root F7 tokens and isolated components own iOS colors, typography, list/block
surfaces and button/input geometry. Compact block/list spacing is the existing
explicit 16px native adaptation; native activation remains at least 44px.
The existing exact decimal strings are never coerced to floating point or rounded.

## Intentional native exceptions

Native navigators retain platform routing. Native textareas retain multiline
IME and keyboard behavior. Images remain the existing bounded local-file reader
projections, not new URLs or public/private permission mechanisms.

The two existing owner-managed acceptance/irreversible confirmation surfaces
remain native view layouts. Their visible inner controls are F7 Button/Input,
but **they are not F7 Sheet/Dialog lifecycle migrations**: Page TypeScript,
confirmation state, cancellation and recovery authority are unchanged. This
stage does not claim new scroll-lock, session-key, focus-restoration or backdrop
lifecycle guarantees. Those changes require a separately reviewed owner
integration rather than a presentation-only substitution.

## Immutable evidence and verification

Before changes, `framework7-errands-before-actions.json` captured **71** action
nodes, including all original bindings, datasets, disabled/loading properties,
input limits/types and conditional/loop ancestors: list 13, mine 6, detail 19,
compose 18, notices 6, shared product templates 9. The shared template inventory
maps only to the isolated new `f7-common.wxml`. It was not replaced with a new
baseline to accept the migration.

`framework7-errands-before-protected.json` captures **68** unchanged sources:
all five Page entrypoints, the shared Page/controller/contracts/gateways and
errand media/publication/recovery code, original product/common presentation,
admin/restriction pages, accepted root pages, global stylesheet and F7 tokens.

`framework7-errands-native-flow.test.ts` verifies exact normalized action parity,
all protected hashes, component registration and noninteractive slot boundaries,
real Component registration/native inner events through Page/controller to
synthetic HTTP, original request-journal snapshots, publication and acceptance
contact rules, lost-response identical retry, storage failure, owner/hide
clearing, notices navigation/read, media slot/revision delivery, draft recovery,
retry/cancellation and busy/stale suppression. Filter/sort/relation and
irreversible confirmation opening/dismissal/rejection also execute real native
component presses.

`smoke-errands.mjs` executes positive UI presses through the shared actual
Component bridge in both source `.ts` and emitted `.js` modes. It retains the
original deliberate direct duplicate, hidden-pagination and invalid-key probes
against the controller. Native multiline input remains explicitly separate.
Migrated single-line inputs run the actual Input component and its native input
handler. Original private/media/error/recovery tests remain part of the focused
suite, including all errand administration suites even though those pages were
not edited.

The new default-array fixture module contains **37** synthetic variants across
exactly these five pages. Tests expand actual component templates/slots, verify
markers and private canaries, and cover list/mine, campus/sort, unknown results,
public/private media, terminal contact hiding, confirmations, image drafts and
all notice categories. Parent-owned source preview generation provides light
and dark frames; no browser or emulator is used by this stage.

Focused local gate: **262 tests passed**; changed JS/TS files passed ESLint and
format checks. A concurrent full test-project TypeScript invocation was killed
with exit 137 and is **not** a successful type gate; the integrator owns the
serialized full typecheck, emitted build/smoke, package/license/budget gates and
final source-bound preview regeneration.

Source projections and event models do not prove Tencent runtime rendering,
stylesheet isolation, hit testing, IME ordering, focus, safe-area/scroll locking,
assistive technology, database behavior or provider availability. No device
acceptance is claimed.
