# Ratings discussion media native candidate

Complete frozen-tree local acceptance passed all 6,443 cases, including native
contracts, shared registry/windowing, emitted Page smoke and independent-process
SIGKILL recovery through real AppModule/ScopedCommands/Media root9 and reply3
integration. Hosted verification is pending. Physical-device validation has not
run and the ordinary server Media runtime remains null; overall parity is incomplete.

## Real entry points

The shipped page is `pages/rating-discussion-media/rating-discussion-media`.
Scoped target cards, detail/thread pages, scoped notification metadata rows and
the existing all-version recovery page link to it. Routes carry only scope and
resource IDs; tokens, grants, paths and command payloads never enter navigation
or page data. Random continues selecting targets on its original routes. Images
require a separately issued context4 after navigation; context2/3 are not upgraded.

Ordinary App assembly constructs one shared `MediaLocalFiles` registry and passes
it to the media reader and discussion native adapters. `connectRatingDiscussionNative`
installs the actual `wx.chooseMedia`, `wx.uploadFile` and authenticated
`wx.downloadFile` implementations when those APIs and the original identity
runtime exist. No custom account, provider or production enablement is created.
Explicit native test adapter injection must use this same registry for target
cover, Community and Profile. Limits remain 2 native IO, 4 leases and 10 MiB,
including failed unlink and outstanding reservations.

## Draft and publication

The root composer accumulates up to nine metadata members, the reply composer
three. A picker invocation selects one image and completes its upload window
before another selection. The chooser has its own generation and original
account epoch. JPEG/PNG inspection reuses the established bounded native file
capabilities; selected bytes are not serialized. Pure-image bodies are allowed.
Removing and reordering is available only before sealing. Missing original bytes
are never reselected under the old upload identity; the member must be explicitly
removed or the batch cancelled first.

The original Ratings journal v12 holds reciprocal batch and business keys.
Unreadable or pending versions 1–11 precede v12; v12 also blocks fresh historical
commands. Commit runs only through original Ratings ScopedCommands prepare/commit.
Review7 and the sealed ordered whole-set remain server authority. Explicit
cancellation and original request retries are separate controls.

Every cold recovery queries the business receipt first, then the batch using its
original key. On first hydration, already-persisted v12 records become in-memory
opaque obligations, even if both disk scrub writes failed in the previous
process. Cold start never restores unsubmitted body, persona, context or image
selection to the editor and cannot retry publication. It can query receipts or,
after explicit cancellation, close the original hash/key. Unknown responses
retain obligations and do not automatically cancel or create a new request.
Same-process newly created journals retain their normal prepare/commit flow.
Ready members are never retransmitted after cold start. A cold uncommitted batch
can only be recovered to settlement or explicitly cancelled. Batch cancellation before
prepare uses an actor/hash durable fence; `not_recorded` is not cancellation.
Settlement requires exact server publication or cancellation evidence and the
native upload completion observation. The receipt is durably recorded before
removing the batch key, then the command key, so an interrupted removal retains
a receipt-bearing command obligation.

## Current reading and actions

Strict v4 full-set projections validate every descriptor and reject partial,
wrong-context, reordered and mismatched subject sets. The in-page gallery has one
visible allocation. It reloads the complete current subject for each opening or
page change, downloads through the dedicated Ratings route, releases the old
allocation, and never uses `wx.previewImage` completion as evidence of closure.
Download queries include every descriptor field and encode a null reply ID as
`replyId=null`. No DTO-provided URL, Range, redirect or public cache is accepted.

Like state uses explicit v4 current reads. Like and subscription writes still use
original protocol2 commands, a newly issued context2 interaction lease, matching
source/head evidence, and the original pending journal. Image draft obligations
block these fresh commands until settled. Author/scoped-admin deletion links use
the existing minimal deletion locator page. Notification metadata lists remain
unchanged; their explicit image-detail link issues context4 and decodes current
body, author, imageCount, thumbnail and kind-specific actor/activity data before
opening the discussion.

## Known remaining evidence gaps

Account switches clear body, author choices, descriptors, local presentation,
grants and callbacks from the page. The original two v12 keys are scrubbed when storage permits into
strict opaque phases containing only the original actor, recovery keys, hashes
and optional receipt. Successfully scrubbed records contain no body, context/token, draft input, persona,
descriptor or temporary file. Returning A can query its original business receipt
or explicitly use the original owner hash-only cancellation fence. An opaque
obligation cannot retry publication or become B's content. Partial writes retain
a blocking key and are re-read before settlement; unreadable storage is never
silently cleared. If storage rejects both scrub writes, sensitive bytes may
remain on disk; memory-only opacity is not a claim of successful physical
erasure. A fresh process still refuses full-intent/UI restoration independently
of whether a scrub write succeeds.
The passing focused independent child-process tests include durable file Storage, fresh
SessionStore/ApiClient/gateway instances, reconnection to a parent-owned synthetic
HTTP server and SIGKILL at batch/prepare/seal/command/applied/native-completion/
account-scrub boundaries, plus valid and corrupt v1–v11 precedence. Native
chooser/upload/download tests use real synthetic PNG bytes and explicit callbacks.
The reusable process runner also exposes `commit-and-stop`: the actual native
gateway calls prepare/commit against a supplied loopback API, then waits for
SIGKILL before persisting the applied receipt. Its IPC includes request method
and path evidence. The API-owned `ratings-discussion-media-native-process.test.ts`
uses this runner with real AppModule, original ScopedCommands/Media owners and
independent database assertions for root9/reply3. It is distinct from the focused
HTTP-stub state-machine test; both focused suites have passed.

Complete frozen-tree local regression/build acceptance passed 6,443 cases, including 2,400 native and 2,451 real PostgreSQL cases; hosted verification remains pending. Real-device
callback/headers/redirect and domain acceptance still require a controlled device
environment and are not established by the synthetic native bridge tests.
