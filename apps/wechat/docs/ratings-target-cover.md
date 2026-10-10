# Ratings target single cover: static implementation

This change adds command protocol 3 (original create/edit operation names), independent hash domain, shared Ratings journal 11, and `ratings-target-media-v1`. Versions 1–10 keep their original decoders, hashes, keys and recovery precedence. No new account system or durable queue is introduced.

## Native flow

- Covered media and command3 require an independently issued exact context3 with `target_cover`; pure-text read3 does not claim that capability.
- A single JPEG/PNG selection uses the existing `chooseMedia` generation, cancellation and native `complete` fence. Maximum input is 5 MiB, 24 million pixels and 8192 per side.
- Before upload-scope dispatch, journal 11 freezes the original scope request. Scope/prepare/status observations remain metadata-only; temporary paths, bytes and grants are never persisted.
- An unknown request is recovered or explicitly cancelled. The cancel-before-scope endpoint verifies the original actor/input-derived scope and Media request hash, even when no scope response exists and the old context has expired. Not-found cannot release the journal. On ready, the original scope, asset and command request ID are sealed into the same Ratings command slot.
- Name is required. `keep`, `replace` and `clear` travel with body text in one version-CAS command. Receipt lookup precedes v3 retry. Replacement settlement additionally verifies the original Media bound history; closed commands terminate the original unbound upload before releasing the shared journal.
- New detail/list routes preserve the old v2 DTO decoder and add exact Ratings descriptors. Committed viewport observations automatically admit up to four visible row thumbnails, read sequentially through the shared registry; offscreen rows revoke their sources. Details load a thumbnail automatically, and opening a full preview releases row thumbnails. The in-page viewer reloads current metadata and authenticated controlled bytes, with current context ID/token. No `wx.previewImage` lifetime inference is used.
- Logout, account switch, hide and scope invalidation immediately clear displayed sources and revoke local grants/files, preserving the original actor's unresolved journal.

## Budgets and isolation

Callers of the explicit native test adapter must provide the same `MediaLocalFiles` instance used by Community/Profile on the page: two native transfers, four retained leases and ten MiB total. Native cancellation retains transfer credit until the native complete callback. The server process-wide 64-delivery-credit pool is an independent server concern, not a second native quota.

Ratings download requires an authenticated `SessionStore` ticket and exact Ratings descriptor. Profile guest principals, named-avatar/persona data and Community attachment descriptors are not accepted.

## Admission and validation status

The ordinary runtime constructs metadata gateways, but does not enable native upload/download transports. These still require the existing real-device domain/header/redirect/provider acceptance gate. Test DI does not imply production acceptance.

The complete frozen local gate passed 6,320 cases, including 2,364 native tests, emitted Page/WXML smoke, strict API/native contracts and real HTTP-to-PostgreSQL native interaction and receipt-first SIGKILL recovery. Build, typechecks, lint and formatting passed. Hosted verification remains pending. Synthetic local validation does not enable real transport providers or replace physical-device acceptance.

The explicit v3 contexts, subscriptions and random projection are independent of
v2. The page co-observes a v2 auxiliary/interact lease and a v3 cover/content lease;
it never lends either token or write capability across protocols. Random v3
validates its selected read3 context against the locator and keeps that context
out of `setData`. Selected covers load inline through a fresh exact detail read.
Unknown upload-scope cancellation uses the original immutable scope input at
`/v3/ratings/target-cover/upload-scopes/cancel`; only a matching authoritative
Media cancellation fence clears journal11. `not_recorded` and `bound_history`
remain pending. List thumbnails are automatically admitted by native visibility,
with at most four active readers on the existing shared local file budget.

The executed subprocess matrix uses flushed on-disk journal state and separate
SessionStore instances across SIGKILL/restart. Separate real HTTP/API/PostgreSQL
cases observe create/replace committed receipts before killing the native child,
then recover through the original receipt and historical binding without duplicate
publication. Keep/clear, cancellation races and original v2 interactions also passed.
These native-process cuts do not prove independent server-writer retirement or
physical WeChat-device behavior.
