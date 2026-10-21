# Native overlay foundations, Framework7 v9.2.0

These three controlled components adapt the pinned Framework7 v9.2.0 commit
7668f883c29f69dd2ad7bd8ac3b35b9124082b0b. Upstream references: sheet, actions,
dialog and modal base/iOS LESS, variables and class JS. Full MIT notice lives in
docs/vendor/framework7-v9.2.0/LICENSE. This is not a DOM runtime or a claim of
native-device validation. There are no page consumers in this checkpoint.

## Shared controlled contract

- open=false; sessionId='' requires a UI-only opening identity matching
  `[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}`. It is not a business request ID, secret,
  route name or authorization token. Supply a fresh identity for every logical
  opening, and always after a page hide/show.
- disabled=false, loading=false; either blocks actions and cancellation.
- attemptKey=0 must be a nonnegative safe integer. An accepted action or close
  request latches synchronously. Ordinary loading/value/label updates do not
  re-arm. Only a fresh opening or an explicitly increased valid attemptKey does.
  The owner increases attemptKey only after the previous attempt has settled or
  was rejected locally, never while an uncertain mutation is in flight.
- keyboardHeight=0 is the owner's viewport occlusion in px, finite and clamped
  to 0…2000. This is one keyboard-avoidance strategy, not a second scroll/pan.
  safeAreaBottom=true applies the bottom home-indicator inset once and only when
  keyboardHeight is zero. The prompt's f7-input has adjust-position=false.
  The owner must supply current keyboard height through its existing native
  keyboard manager, clear it on dismissal and detach that manager on unload.
- Events are isolated (`bubbles:false, composed:false`). opened/closed carry
  `{sessionId,generation}`. requestclose and action also capture attemptKey,
  so owners can reject already-emitted events from a settled earlier attempt.
  requestclose adds reason: backdrop/cancel/close; action adds stable id. Native hits carry the rendered session
  and generation plus attemptKey; stale hits and stale callbacks cannot affect a
  new opening or a re-armed attempt. Event handlers use the original native or
  custom press event currentTarget dataset, never reconstruct it from current
  owner properties. f7-button additionally captures its optional interactionKey
  on the original inner native button event and forwards it in press detail.
  Overlay handlers verify that key independently of the custom host dataset;
  its unambiguous length-prefixed identity also includes Dialog mode/confirmId
  so an earlier Save tap cannot become a newer Delete action.
- Opening is closed → opening → open. Closing is controlled open=false →
  closing → closed. Requests never change open or imply successful business
  results. Keep the component mounted while closing; unmounting suppresses the
  closed event. closed is dispatched only after native removal is acknowledged
  by setData callback and the visibility/generation checks still hold. The 300ms sheet/actions and 400ms dialog completion timers retain
  conservative timing even under reduced-motion styles.
- Hide/detach cancels timers, invalidates generation and discards rendered
  content/focus. It emits no closed or confirm, and cannot trigger a late close
  callback. Showing the page does not resurrect the same suppressed session,
  even if open was toggled false/true while hidden. A fresh identity is required.
- No callback, HTML, inline backend style, URL or mutation is accepted. Labels
  and messages use plain text. No network, storage, analytics or platform
  permission logic is present.

## Owner integration is mandatory before any consumer migration

1. Pause exposure/read/visibility observers and lock background scrolling BEFORE
   setting open=true. A component cannot infer or suspend domain readers. CSS
   z-index and the backdrop do not establish this guarantee.
2. Use a per-owner token/count/stack, not a shared boolean. Keep every lease
   through closing. Queue confirm dialogs instead of showing indistinguishable
   overlapping confirmation surfaces. Sheet/action/dialog z-indices do not
   coordinate ownership or distinguish multiple same-kind overlays.
3. Resume only on the matching valid closed event, after no blocking lease
   remains and the originating page is still current and visible. On page hide
   or unload, invalidate the owner's leases without resuming hidden readers;
   do not wait for a component closed event, because it is deliberately absent.
4. On action, validate the id against the page's explicit allowlist and check
   current ownership/auth/domain state. Set loading=true before awaiting the
   existing authorized mutation. Keep open while pending or uncertain. Close
   only on confirmed success, or show failure and explicitly re-arm after a
   known failure. Component suppression is not server idempotency/security.
5. Cancel/backdrop only requests cancellation. It must invoke zero destructive
   mutations. Parent input changes are drafts, not permission or confirmation.
6. Native back navigation is handled by the page's existing navigation lifecycle.
   No browser Escape/keyCodes or interception of platform back is implemented.
7. Restore focus only to a still-valid originating control on a visible current
   page, never from a stale timer. For prompt validation, retain open, show
   errorText, set focus intent and re-arm when appropriate. Clear owner-bound
   sensitive values yourself on hide/close; unmounting removes the native editor
   but cannot erase the owner's data. This is not a password/login abstraction.

## Component APIs

### f7-sheet

Common props plus title='', closeLabel='关闭', showClose=true, backdrop=true,
closeByBackdropClick=true. Named header/footer and default content slots.
Default height 260px, top radius 32px, 300ms. Header/footer occupy layout space;
the bounded native scroll-view owns interior scroll.

Pinned iOS defaults backdrop=false. This port deliberately defaults to a modal,
dismissible backdrop for safe product integration. backdrop=false only removes
mask dimming; it is NOT a nonmodal sheet and still intercepts background input.
No push, swipe, top placement, breakpoints or step properties are advertised.
Slots must not grant capabilities. Slotted interactive controls are owned by the
parent and must enforce the same session/loading guards themselves.

### f7-actions

Common props plus title='', actions=[], cancelLabel='取消',
closeByBackdropClick=true. Backdrop is always true as upstream. Cancel has a
separate group, never maps to the first action. No automatic Popover conversion.
Each item: `{id,label,disabled?,destructive?,strong?}`. IDs match
`[A-Za-z][A-Za-z0-9_-]{0,63}`; the entire list fails closed on malformed items,
duplicate IDs, invalid boolean flags, blank or >1000-character labels, or more
than 100 entries. A rendered list revision rejects stale item events when the
owner replaces/reorders actions. Dispatch resolves live items by id, not index.
Rows retain upstream 56px minimum/20px font but grow for long labels, an explicit
accessibility adaptation from fixed-height, single-line upstream rows. Group
radius 32px, margin 8px; at widths >=496px the surface is 480px and centered.

### f7-dialog

Common props plus mode='alert'|'confirm'|'prompt' (default alert), title='',
message='', confirmLabel='确定', cancelLabel='取消', confirmId='confirm',
confirmDisabled=false, destructive=false. Prompt props: value='',
placeholder='', inputLabel='输入内容', errorText='', focus=false, maxlength=140.
Invalid mode or confirmId fails closed. errorText/confirmDisabled block confirm.
Backdrops never dismiss. Alert has a single action; confirm/prompt add cancel.

Prompt uses existing f7-input and forwards raw input with session/generation and
optional cursor. It does not normalize the draft, persist it or duplicate it in
the generic action event. keyboardconfirm is an isolated observation without
value, never submit. inputfocus may carry native height; inputblur carries only
identity. A fresh opening or explicit attempt rearm replaces the prompt editor subtree;
normal value/cursor/error/loading changes do not. Existing f7-input lifecycle
guards discard queued native events for the detached previous editor. Owner
value remains controlled, so retry retains the draft, with a newly mounted
editor rather than the old native selection. Focus intent activates only once
the dialog is fully open, not while
closing, disabled, pending, loading or hidden.

Actual upstream v9.2.0 dialog-class.js creates button-round button-large iOS
buttons, 48px, strong fill / other tonal. The port uses those f7-button variants,
not the leftover 44px dialog token. Title/body/24px padding/32px radius/270px
width/12px gap/14px footer/8px gap/400ms scaling follow pinned source. Existing
f7-input preserves its 16px editor/44px target instead of pretending that outer
CSS pierces isolation to impose upstream dialog 14px/40px/16px-radius styling.
Destructive uses f7-button's reviewed tone="danger" property, not an assumed
external CSS override through native isolation. The caller must supply clear
consequential title/action text and
retain existing authorization/confirmation semantics.

## Native adaptations and evidence boundary

All surfaces use opaque #fff / dark #323232 fallbacks instead of unsupported
browser glass blur/shadows. Neither translucency without blur nor a substitute
shadow is claimed to be glass fidelity. Runtime dark mode follows existing
prefers-color-scheme. No fonts, SF Symbols, HTML or browser runtime are shipped.

Only masks and fixed chrome consume touchmove. The root and content ancestors
do not, so interior scroll is not intentionally swallowed. The owner locks the
background page. Sheet has explicit height/flex scroll; Actions/Dialog use
bounded native scroll-view flex/max-height sizing. Verify overflow and touch
chaining in the actual WeChat renderer, especially very short viewports and
open keyboards. Native video/camera/canvas/input stacking, assistive focus,
Chinese IME, 2×/3× layout, keyboard event ordering, scroll-view sizing, and
runtime theme changes require Tencent DevTools and real-device checks. Source
and mocked Component tests do not establish any of these, real API authority,
provider integration, PostgreSQL correctness, or production readiness.
