# Rating notice acknowledgment: conservative explicit-only correction

## Outcome and scope

Rating notices no longer become read merely by resolving, opening, loading,
rendering, refreshing or expanding their target. Exact explicit confirmation
remains available. This change is deliberately not completion of viewport/dwell
notification receipts or snapshot-cursor proof.

The three original notice namespaces remain independent: reply `updates`,
`like-updates` and `subscription-updates`. No backend producer, owner endpoint,
DTO, permission rule, counter namespace, content authority or pending-command
format changes. DM observations, pin unread, activity visitation, verification,
Home, inbox and Me are outside this change.

## Every production behavior change

1. `ratings/discussion-controller.ts`: removes the post-load `markRead` branch
   for all three notice owners. The full notice ID, exact target tuple,
   receiving-page owner resolution, root/reply ancestry, current scope and
   current position reads remain mandatory. `noticeRead=explicit` stays accepted
   as a backward-compatible non-authorizing route marker, but automatic read is
   now absent for entries both with and without it. Legacy standalone thread
   entries retain their source-list explicit acknowledgment, not a new thread
   read button.
2. `ratings/scoped-controller.ts`: `noticePath` freezes the selected notice kind,
   resolves the v2 owner target and current locator under the existing context,
   and returns a route without calling any v1 read owner. A new separate
   `acknowledgeNotice` accepts only a currently listed unread notice, its current
   category and exact render interaction key. The selected v1 owner is captured
   before dispatch. Existing account/login epoch/request-generation cancellation
   remains authoritative; route, category, scope, Safety, hide and replacement
   fences prevent a late response from updating a replacement view.
3. `ratings/scoped-page.ts` and scoped WXML: add one native F7 row action,
   `onNoticeRead`, with exact notice ID, category and interaction key. F7 captures
   the inner native interaction key; the handler requires the current page and
   no open UI panel, and the controller rejects busy, frozen, refresh-required,
   picker, composer, confirmation, score, cover and icon-overlay states. Missing
   read services are visibly unavailable rather than reported as successful.
4. Scoped acknowledgment decodes the matching receipt and applies only its exact
   `readAt` and canonical owner `unreadCount`. It does not decrement locally,
   request target permission or grant access. A lost/malformed/mismatched result
   leaves the row explicitly “result pending,” keeps count unknown and permits
   only an explicit retry of that source/ID. Duplicate pending or confirmed taps
   dispatch nothing. Owner-visible unavailable metadata can be acknowledged
   without making unavailable content readable.
5. `ratings/discussion-media-page-controller.ts`: removes the pre-content
   `markRead`. Original notice resolution and preview authorization still happen
   before thread/position retrieval, and the post-preview generation check is
   retained. A separate frozen minimal notice reference survives the internal
   locator-route rewrite: original category/ID/selector and account/session/page
   identity, never a preview, context token or durable content grant.
6. The media page adds `onReadNotice` and a native F7 explicit action. Standalone
   notice routes can confirm the original notice even when its content is
   unavailable, provided the original account/page and current read-context lease
   still match. This is bookkeeping only: content errors remain visible and no
   content requests are issued by acknowledgment. Busy operations, composer,
   gallery, cancel confirmation, recovery, pending/frozen editor or selected
   media block the control. Hide, account/session change, scope invalidation,
   expiry and new load remove or disable the stale owner/control. Missing
   gateways and invalid context stay visibly unavailable.
7. Media acknowledgment uses the original owner-specific receipt decoder,
   matching notice ID, server timestamp and canonical count. Lost or malformed
   replies are “unknown,” never read or unread success, and retry keeps the same
   owner/ID. Reload clears the prior read context before revalidation; an invalid
   replacement route cannot leave the old route as a fallback.
8. `ratings/updates-controller.ts`: changes only the existing successful-open
   status text to explain that opening is nonmutating and explicit confirmation
   remains on the source list. No source-list business logic changes.

## Regression and historical evidence treatment

The existing R2A/B/C controller tests that expected receiving-load acknowledgment
now assert exact target resolution followed by zero read calls across successful
load, reload and expand. Existing failure, mismatch, ancestry, privacy and
lifecycle assertions are retained. New tests exercise the real controllers and
Page/F7 controls, all three owner kinds, missing gateways, unavailable metadata,
canonical receipts, unknown responses, repeated clicks, stale native keys,
account/session/category/scope replacement, expiry, overlays and late callbacks.

The three emitted R2A/B/C smoke scripts now retain the same locator/content
assertions, assert no reads during receiving-page load/refresh/expand, and perform
read endpoint/receipt assertions only after the source explicit action. R2A's
already-sent/late-read boundary cases now originate from that explicit source
control, rather than an obsolete receiving-page side effect.

The three API native-roundtrip tests likewise assert zero acknowledgment PUTs and
unchanged owner counts after successful native target loading, then explicitly
acknowledge and retain exact owner endpoint/body/receipt/idempotency and
cross-owner rejection assertions. Those integration tests were edited but not
executed in this isolated task.

No historical F7 action inventory, baseline hash, reviewed-business successor,
fixture, screenshot or prior report was rewritten. The two new controls and
changed controller hashes need the parent's separate, auditable business-successor
integration before the full historical F7 protection suites can pass. Selected
existing F7 behavior tests are not a claim that those frozen guards passed.

## Verification on this isolated source

- 447/447 focused native tests passed serially across 19 files: exact notice
  behavior, legacy R2A/B/C controllers/contracts/gateways, scoped
  controllers/native/contracts/gateways, and media
  notices/context/native-pipeline/contract/pending.
- 25/25 selected existing real F7 interaction regressions passed. Historical
  action/hash protection tests were not selected and were not changed.
- 53/53 social aggregation, merged notice and rating explicit-read regressions
  passed. The final three serial runs contain 525 passing tests in total.
- Scoped ESLint and Prettier passed for changed TS/MJS/Markdown files. All three
  modified smoke scripts passed `node --check` syntax checks.
- Not run: TypeScript compiler/typecheck, builds, emitted smoke execution,
  PostgreSQL/backend integration, browser, emulator, real-device geometry or
  timing, provider calls, dependency installation, commit or push.

The exact before/after source manifests and patch are supplied separately against
the immutable isolated baseline. This is source/controller correctness evidence,
not server-validated dwell/snapshot receipts or full legacy parity acceptance.
