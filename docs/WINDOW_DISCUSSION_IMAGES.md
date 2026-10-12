# Window discussion images v2

This forward-only slice extends the independently owned W3 Window discussion.
It does not add Major images, Window deletion, creator mapping, provider activation,
real-history import, device acceptance or production deployment.

## Explicit new bounded policy

The pinned [legacy Window source](https://github.com/WhaleUCampus/WhaleU/blob/57cf169c11123acf249909a1a7215b8cb1ec1f8e/treehole/app/controller/Window.php)
allows image-only roots and replies (440–501), and preserves image array order
(117–227). It does not establish an upload count, actual MIME allowlist, byte limit,
or specialist native picker registration. The new Next policy is at most three
JPEG/PNG images for either root or reply. Each input is bounded by the shared
media-static-v1 5 MiB declaration and actual decoder's 24-million-pixel budget.
Only derived thumb-v1/display-v1 variants are delivered. This is a new bounded
policy, not evidence of a legacy three-image limit or arbitrary-format parity.

Empty body is allowed only with a nonempty accepted typed image set. Otherwise the
existing exact nonblank Unicode/8,000 UTF-8-byte/no-NUL text policy remains; `0` is
valid. Raw URLs, a string containing `[]`, duplicate assets, extra fields, fourth
images and wrong ordinals are rejected. PNG/JPEG declarations do not override the
actual decoder; animation/HEIC/GIF are not newly supported.

## Separate version domains and compatibility

- Existing SQL through 0122 is unchanged. Migration 0123 creates empty Media16
  scopes/appearances and independent v2 Review policy/decision/head storage.
- The W3 v1 envelope, command and Review hash domains, purposes, receipt codecs and
  native exact-text journal remain unchanged. No `images: []` is added to their
  canonical bytes. V1 SQL still rejects empty/blank body and extra image fields.
- V2 commands use `window-discussion-v2`, purposes `window.discussion.root.v2` and
  `window.discussion.reply.v2`, and a new canonical hash domain. Ordered image facts
  are `{assetId, manifestDigest}` and participate in exact Review and command hash.
- V2 pages project the complete mixed v1/v2 population. V1 readers fail closed on a
  population containing any v2 row rather than silently omit a row, fabricate text,
  or report an incomplete ranking/count. V1 notices expose an unavailable shell
  for an image-version target. Existing like/own protocols stay v1 and apply their
  current subject proof to either version.
- Raw SQL publication must atomically establish the exact content, full image set,
  bindings, immutable appearances, Review, command, receipt and complete recipient
  obligations. A wrong author, source, root, target, order or purpose cannot borrow
  another owner's UUID or generic Ratings target history.

## Owner authorization and current whole-set proof

Media reuses the existing intent/quota/ingress/static processing/MediaSafety/
immutable storage/delivery budget implementation. The owner/context/appearance/
Review/read proof is independently Window-specific. Phone and current Safety are
required, with the real accepted Window/floor/canteen/Campus source and separate
population/like coverage. A verified affiliation is not added. PM retained-history
rules, Errand audiences, generic target definitions and administrator bypasses do
not grant Window authority.

Every list, thread, ranking, count, positive like, notice target/preview, descriptor
and byte delivery checks the complete current image set and the root's current
visibility. A held sibling suppresses the entire content, including its first
image and body. Unknown/missing evidence makes the complete read unavailable.
A hidden addressed reply removes only its reference and addressed identity from
an otherwise visible reply; it does not destroy that reply's own images.

Media/source/Review/owner epochs include statement-level writes, including zero-row
writers. Final bounded NOWAIT fences and exact clock deadlines remain mandatory.
V2 Review captures its epoch in the same query as the consumed decision and keeps
that first observation through final proof; a later capture cannot erase a
committed zero-row writer or revoked-to-active transition. V2 mutations acquire
Media's existing exclusive named-block-policy gate before the original publication
key. They never upgrade a shared policy gate while another same-key request waits.
Own publication writes complete before the depended-on parent/set is re-read and
the final Media epoch is captured; an earlier proof is never discarded to accept
a stale snapshot. Delivery checks authorization before and after external storage
open, with the stream paused until managed final proof and commit complete. Range,
original files, public/signed read URLs and cross-owner UUID authorization are absent.

## Receipts, cancellation and lifecycle

Media upload keys have their own typed hashes and recovery routes. Publication is
independently keyed. A frozen publication journal retains only original IDs,
operation/source context, hash and bounded ordered upload recovery keys. It stores
no draft body, image bytes, file path or descriptor. Cold recovery can query or
cancel the original key; `REQUEST_NOT_FOUND` is not cancellation and does not mint
a new key or recreate an incomplete payload.

Before a publication payload is frozen, a metadata cancellation with null hash
fences that actor/request/window/root/operation against every late publication.
After freezing, the exact command hash is supplied and altered body/order conflicts.
A committed publication receipt always wins over cancellation. Receipt and minimal
cancel recovery require the current owning session and survive source/phone/Safety
loss, but provide no image access. Bound images do not inherit upload scope expiry.
Draft expiry/cancellation can clean up unbound uploads; bound delivery variants have
no accepted retirement cause in this slice. Normal staging/original cleanup can
finish after publication without deleting the bound delivery variants.

Source withdrawal, missing Review, Safety hold, native hide or account change revoke
current access only. They do not imply permanent deletion, retention TTL, cleanup
completion or an invented author/admin Window delete API.

## Notices and native pages

Reply notices keep W3's existing causal-reply navigation. This is an already-published
Next difference from the old Window parentId navigation; images do not rewrite it.
Only after the whole causal reply image set is allowed can ordinal zero appear as a
thumbnail. Like notices always have a null thumbnail. Root creator notices remain
`unavailable`; accepted catalog metadata is not a creator account crosswalk.

The existing registered W3 pages use picker/inspection/ordered upload and a controlled
in-page gallery. App's single shared native file registry remains 10 MiB, two
transfers and four handles across all owners. No native previewImage gallery is
introduced. Hide/back/unload/account/origin/session changes invalidate private
presentation; picker-induced hide has its own bounded suspension. Late callbacks
cannot revive closed UI, and files/transfers are released only after real native
quiet completion. Failed durable writes/readback close upload/publication admission.

## HTTP and verification

V2 owner routes are under `/v2/ratings/windows` and
`/v2/me/window-discussion/notices`. Media16 routes are under
`/v3/media/window-discussions`. All use strict bearer-authenticated, no-store,
Authorization-varying contracts. Default real provider/storage/source/Review wiring
remains unavailable. The [generated contract](openapi/window-discussion-images.json)
separates these routes from the unchanged v1 artifact.

The original `window-discussion-native-roundtrip` is explicitly a legacy-client
capability compatibility harness; every original v1 assertion is retained. It is
not the default upgraded App acceptance. The separate
`window-discussion-images-native-roundtrip` uses three cold processes: an actual
legacy client first loses a committed v1 response and persists its genuine journal;
the untouched default App then recovers that same v1 key before publishing an
ordered image-only v2 root; a third default App restores the metadata-only v2
journal, queries the original receipt, and exercises galleries, reply notices,
like notices, uncertain-upload cancellation and quiet native cleanup. There is
no production test flag and no replacement key/hash migration.

The raw upgrade fixture writes valid v1 data before applying 0123, then compares
command, receipt, intent hash and Review digest exactly and replays the original
key. Invalid raw v1 empty bodies and extra image fields remain rejected.

Validation records are published only after the exact frozen tree is checked.
Synthetic integration substitutes only approved fixture source/Review/storage and
native platform boundaries; it does not establish live provider, physical device,
nonempty legacy history, or production acceptance.
