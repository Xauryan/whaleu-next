# W3 Window text discussion

This is a bounded local Next slice under the existing specialist Window owner.
It adds named text roots, flat replies, reversible actor/comment likes, local
reply/like notices, original-key recovery and newly registered native pages. W1
signed window scores, W2 dish endorsements, C2 author-undisclosed permanent likes
and generic Ratings remain separate. This is not whole-Next, real-history import,
provider activation, physical-device acceptance or production deployment.

## Source and deliberate boundaries

The pinned executable source is
[Window.php at 57cf169c](https://github.com/WhaleUCampus/WhaleU/blob/57cf169c11123acf249909a1a7215b8cb1ec1f8e/treehole/app/controller/Window.php).
Lines 117–227 expose named roots and flat replies; 440–514 publish; 536–604 reverse
likes; 846–954 write local notices. The native registration of this old specialist
journey is unproven. Next registers its own routes instead of claiming restoration
of an established legacy native page.

- Roots sort by likes, creation time and stable ID descending. Optional time sort
  and bounded continuations are explicit Next additions. Flat replies sort by time
  and ID ascending. There is no nested thread or author-undisclosed mode.
- Replies take the exact root ID and an optional same-root reply target ID. The
  server derives the addressed actor. It rejects cross-window/root targets, a
  reply used as the parent/root, inaccessible targets and client author/recipient
  fields. Legacy unvalidated parent/user arguments are not preserved as bypasses.
- Fresh reads, roots, replies and positive likes retain W1's current session,
  verified phone, Safety and accepted active window/floor/canteen/Campus mapping.
  No verified affiliation, student number, administrator or matching-school gate
  is invented. Named direct policy suppresses either block direction. Missing
  author coverage is unavailable rather than an empty ranking.
- Public names come through Profile's safe public ID/display-name interface.
  Raw account IDs and legacy avatar URLs are not public authors. Avatar parity is
  not added here. No deletion, reports, rewards or generic subscription effects
  are introduced.
- This slice accepts exact nonblank, well-formed Unicode text up to 8,000 UTF-8
  bytes, excluding NUL. Whitespace is preserved, and text `0` is valid. These are
  explicit Next limits, not recovered PHP limits. Images and image-only roots or
  replies are rejected. The source supports both: typed Window Media + Review
  publication/delivery and image-only parity remain a separate required follow-on.

## Independent source, history and Review

Migration 0119 creates empty Window discussion, like-lineage, command, Review and
local-notice storage. Catalog acceptance, W1 score history and W2 dish history
prove neither discussion population nor like membership. Separate accepted-empty
population and like assertions plus native records are the only initial supported
history. Missing, unknown or expired assertions remain unavailable, never zero or
not-liked. Synthetic fixtures alone accept such facts. There is no runtime issuer,
seed, activation endpoint or production account crosswalk.

Distinct Review purposes `window.discussion.root.v1` and
`window.discussion.reply.v1` bind exact body, authenticated actor, original request,
stable window, catalog/window revisions, root, optional reply target and the
server-derived addressed actor. Allow, reject, unavailable, revocation, consumption
and visibility deadlines stay distinct. Review uncertainty never manufactures a
terminal rejected receipt. Hidden roots suppress all dependent replies and notice
targets. A hidden addressed reply yields no addressed identity or target ID in a
remaining visible reply; its text is not a quote of that target.

Reads inspect the complete window population up to 1,000 candidates, then fail
unavailable if that complete-proof budget is exceeded. They do not truncate the
aggregate. Like counts derive from current active membership heads, and reply
counts derive from the viewer's currently visible accepted replies. Root totals
are distinct from W1 ratingCount, dishes, diners and raw stored reply counters.
Whole-ranking Review/history/author-Safety future boundaries, including off-page
and currently denied rows, are bound as exact PostgreSQL timestamp text. Opaque
cursors bind actor/session, source/history, content/like/Review/Safety/Profile
revisions, window/root, ordering and page size. Relevant change requires restart.

## Reversible membership and durable recovery

The like command carries desired `active` state and nullable
`expectedMembershipRevision`, rather than toggling. Per-request and per-actor/subject
locks serialize the absent-head case and each transition. CAS is checked before
state equality: stale same-state intent conflicts; current same-state intent is a
noop. Changing transitions produce immutable events and a current head that keeps
inactive revisions. A new re-like is a new transition, not a lifetime duplicate.

Original receipts and command hashes are immutable and actor-owned. Exact replay,
receipt lookup and durable same-key cancellation require the current owner session
but survive source, phone or Safety withdrawal. Known own membership can be reduced
to inactive after those losses. Absence is known only under independent current
like history. An old success receipt never rewinds a later head or restores a
withdrawn source. A response with uncertain outcome cannot authorize a new key.

Native journals freeze and persist/read back account, origin, operation, original
key, window/root/target, source revisions, CAS and exact text before transport.
Standalone recovery is reachable without a current window detail. A bounded,
account/origin-bound recent-like ID list supports fresh own-state lookup and unlike
after cold restart or source withdrawal. Hide/back/unload, account/origin/session
changes and late callbacks invalidate private displays. Settled receipts are
historical outcomes followed by fresh reads, not current-state assignments.

## Local notices and the explicit creator gate

Notifications owns immutable per-event/recipient obligations, a private list,
exact unread count, explicit read acknowledgments and freshly resolved targets.
A reply notifies the root author and, when distinct, the explicitly addressed reply
author. Self and duplicate recipients are suppressed. Each genuine false→true like
transition notifies the subject author unless self. Unlike, noop and original-key
replay emit no notice. Re-like emits a new notice; unlike retains historical notices.
Atomic causal guards require the exact obligation set in the mutation transaction.
No provider or generic lifetime actor/subject dedupe is invoked.

The legacy root→window-creator notice is explicitly unavailable. W1's accepted
window metadata has no creator actor or accepted creator crosswalk. A source name,
numeric ID, catalog acceptance or publishing actor cannot establish that recipient.
`creatorNotice: unavailable` is exposed on discussion pages, and the native UI states
the limitation. An independently accepted creator-mapping owner with provenance,
withdrawal and current proofs is a remaining follow-on, not a guessed notification.

Both reply notice kinds navigate the causal new reply in W3, whereas the pinned
legacy Window handler used parentId navigation. This already-published Next
difference is preserved by [the independent v2 image extension](WINDOW_DISCUSSION_IMAGES.md);
it is not silently reversed as image parity.

Notices expose current safe previews or an unavailable shell. Fresh target lookup
precedes native navigation and is checked again by the receiving thread. Marking a
notice read neither restores visibility nor grants source access.

## Typed HTTP surface

Bearer authenticated, strict request/response codecs, account throttling,
`Cache-Control: no-store` and `Vary: Authorization`:

- GET/POST `/v1/ratings/windows/:id/discussion`: roots and publication
- GET `/:id/discussion/:rootId`: root plus flat reply page
- POST `/:id/discussion/:rootId/replies`: direct or explicitly addressed reply
- POST `/:id/discussion/:commentId/like`: desired-state CAS
- GET `/:id/discussion/:commentId/my-like`: minimal own known state
- GET `/discussion-requests/:requestId`: original receipt
- POST `/discussion-requests/:requestId/cancel`: exact original intent fence
- GET `/v1/me/window-discussion/notices`: private local page/unread count
- GET `/:noticeId/target` and PUT `/:noticeId/read`: fresh target and acknowledgment

The generated [OpenAPI](openapi/window-discussion.json) is checked independently.

## Proof boundary and verification

SQL statement and deferred guards bind actor/session, strict exact intent,
source/history, root/target relationship, Review, predecessor/head, receipt and
notice obligation causality. Accepted evidence/events/receipts are immutable.
Complete fixed NOWAIT owner fences and monotonic epochs make stale current facts
fail closed. Managed Database transactions flush deferred waits, run mandatory
owner proofs, then enforce exact clock deadlines. Arbitrary raw transactions that
flush constraints and then wait are not promised a COMMIT-clock hook; their guards
linearize at their own execution points.

The focused tests cover same-key concurrency, CAS-before-noop, multi-recipient
notices, re-like transitions, strict codecs, source/eligibility loss, independent
histories, root withdrawal, named visibility, cancellation, raw no-cause receipts,
missing notice obligations, complete pagination, off-page expiry and the 1,001-row
budget boundary. Emitted App/Page/WXML use production gateways against ordinary
loopback AppModule and disposable PostgreSQL; only native platform callbacks and
explicit accepted synthetic source/Review facts are substituted. W1/W2/C2, generic
Ratings, Profile and Notifications remain regression requirements. Final validation
records identify what actually passed; physical WeChat, live providers, nonempty
history import, creator mapping, images and production are separate gates.

### Local validation record

On 2026-10-12, baseline `285d984` plus W3 passed the complete repository check:
1,897 API tests, 2,741 native tests, lint, TypeScript checks, deterministic OpenAPI,
stats/search checks and builds with emitted native smoke checks. The final W3
PostgreSQL set passed 27 tests, including the actual emitted W1 detail → W3 entry,
cold recovery, hidden addressed-target tombstones, and notice reads that do not
restore access. The complete 42-file simulated manifest passed as a documented
exact-source split after the original aggregate timeout; see the
[execution record](SIMULATED_NATIVE_E2E.md#w3-local-execution-record-2026-10-12).
All 117 pre-existing SQL migrations remain byte-identical. These are synthetic
local results, not provider/device/import or production acceptance.

The additional 24-file generic regression batch passed 295 tests and failed the
R1 same-actor score-CAS assertion (one child and its parent). The exact unchanged
`285d984` baseline reproduced that failure. Diagnostic responses established a
legacy boundary race: one request applied, the other returned HTTP 500
`INTERNAL_ERROR` with no durable request row; retrying its original key returned
`RATING_REVISION_CONFLICT` without another score transition. PostgreSQL reported
`legacy_boundary_guard` inside `begin_legacy_boundary` on both sources. Separate
W3-source reruns passed 16/16 R1 tests, but do not erase the observed baseline
race. The generic implementation and assertions remain unchanged in this slice;
that independent generic race needs its own fix and validation.

## Forward image extension

The historical W3 text validation record above remains unchanged.
[Window images v2](WINDOW_DISCUSSION_IMAGES.md) documents the independent forward
protocol, mixed-population compatibility and new bounded image policy.
