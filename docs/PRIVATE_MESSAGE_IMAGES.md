# PM3: bounded private single-image messages

This additive local slice extends the existing Messaging PM0–PM2 owner and shared Media protocol 15. It is not production storage/Review activation or complete legacy-format/history parity. Prior text-v1 canonical envelopes, hashes, command receipts and migrations 0059/0060 are unchanged.

## Exact command and content owners

POST `/v1/private-messages/conversations/:id/images` takes exactly `{clientRequestId,image:{assetId,manifestDigest}}`. Its operation is `send_image`, using the existing Messaging account/request collision boundary and quotas. Text and image with the same key conflict. Image is not text containing `[图片]`; the label is only a typed list/placeholder preview. The image Review-v2 envelope binds the account, original request, conversation, immutable context digest, sender slot, both modes and exactly one sealed asset/manifest. It has no text property, client approval ID, URL or audience override. The image branch has a distinct versioned digest; v1 bytes remain unchanged.

MediaSafety and MessageReview are separate authorities. Missing or pending content evidence remains unavailable and retryable under the same key; an exact content rejection produces a terminal original receipt. Current hold/revoke suppresses projections and fresh byte delivery. Asset bind, immutable message, Review binding, message/event sequence, lifetime and unread counters, delivery obligation and receipt commit atomically. Deferred cross-owner SQL guards reject partial publications and partial recalls.

All existing identity rules apply: exactly two immutable participants, named/anonymous/mixed modes and original source provenance, explicit opt-in for mixed initiation. Filenames, metadata, display names, administrative roles and raw storage locators grant no access. Source removal removes navigation eligibility but does not remove retained membership/history or member send authority. Image/text first contacts spend the same one lifetime accepted message until a peer replies. Recall never refunds this allowance.

## Typed transport and authenticated pixels

`/v3/media/private-messages` provides the typed prepare/grant/multipart/finalize/status/recovery/cancel routes and conversation/message/binding-scoped descriptor and byte routes. Prepare is tied to sender, conversation, server context digest and original image command. The sole accepted input is one static JPEG or PNG, at most 5 MiB, with exact declaration/digest and actual shared decode/re-encode/MediaSafety. No original variant is served. Storage is private; JSON contains no original key, bucket, provider locator, signed read URL or public URL.

Both participants independently reauthenticate their current session, DM eligibility, membership, actor Safety, MessageReview and exact Media binding/Safety. These facts are checked before and after external storage open and at the final transaction proof before output bytes. Delivery uses the shared process budget, private/no-store headers, no ranges and no redirects. This cannot retract bytes previously delivered or promise instantaneous revocation of an already authorized in-flight stream.

Blocking denies new prepare/send and suppresses existing outbox obligations. It preserves currently eligible participants' retained history. Anonymous/mixed latches never consult or reveal the hidden named pair. Hide is only the owner's inbox cleanup watermark; it is not deletion, a read receipt or revocation for the peer. Reopen neither restores cleaned unread nor unblocks.

Recall uses the existing inclusive PostgreSQL-time 120-second predicate. It atomically tombstones the message, removes both content projections, retires its Media binding, suppresses outbox and stages durable cleanup. Original receipts and lifetime counters remain immutable. Bound history outlives upload/bind deadlines; there is no new bound-image age TTL or hard-delete endpoint. The new delivery hold closes only after actual provider/stream quiet, never by elapsed timeout. Physical cleanup requires a current explicit owner retention policy and exact authorization; both registries start empty. Pending/retained database state is never reported as confirmed physical deletion.

## Native lifecycle and recovery

The existing registered Messaging detail/list/recovery pages use the one App MediaLocalFiles pool (10 MiB, two concurrent transfers) and owner-image adapters. Album/camera select exactly one original image; processing/progress, original-request recovery and current authenticated viewing use existing pages. Only one image is temporarily displayed at a time. There is no second PM file budget/cache and no persistent image bytes, file path, descriptor, asset manifest or committed-history cache.

A bounded origin/account-scoped unresolved journal contains only conversation/original-command/upload IDs and the original upload hash. The image command's persisted Messaging journal stores ID, operation and intent hash without image content. Same-process exact manifests are volatile. A lost original file requires recovery or server-confirmed cancellation before another selection/key. A `not_recorded` upload response is not cancellation: Media cancellation first fences the original Messaging image command under the same lock as sending. An already applied message wins. Session-only public recovery remains reachable after losing source/eligibility; receipt recovery never grants pixels. Text recovery remains independent; re-edit is text-only.

Picker-induced hide/show clears presentation while preserving its bounded pending chooser; return rechecks foreground/session/generation before upload. Other hide/logout/account/disposal, Review loss, recall and stale upload/download callbacks revoke transient presentation and schedule cleanup. Native reservations/transfer credits release only on real completion. Failed unlink remains a revoked capacity-consuming tombstone, with the existing shared retry mechanism.

## Pinned legacy evidence and deliberate fixes

Pinned legacy commit: `57cf169c11123acf249909a1a7215b8cb1ec1f8e` in WhaleUCampus/WhaleU.

- `treehole/app/controller/PrivateMessage.php:155–225` and `PrivateMessageService.php:179–269`: one real uploaded image, conversation lock, block/first-contact checks and typed `[图片]` preview.
- `treehole/app/util/ImageSecurityUtil.php:13–42,240–291`: 5 MiB JPEG/PNG/GIF and conditionally available HEIC/HEIF conversion. GIF and conditional HEIC remain explicit compatibility gaps; PM3 does not silently flatten animation or claim unsupported decoding.
- `miniprogram1/packageUser/pages/privateMsg/detail/detail.js:2141–2228`: count-one original album/camera selection.
- The same detail file `:844–848,2477` calls `processImageUrl(...,'public')`; `miniprogram1/utils/imageUtil.js:41–79,90–103` builds/pass-through public URLs even for private messages. PM3 deliberately fixes that exposure, rather than carrying a public-URL compatibility path.
- Legacy cache `detail.js:19–23,924–926,1059–1133` is not an account-scoped private authority; recall `:2955–2983` does not prove saved files or underlying bytes erased. PM3 does not adopt those cache/deletion claims.

Source root: https://github.com/WhaleUCampus/WhaleU/tree/57cf169c11123acf249909a1a7215b8cb1ec1f8e

## Evidence and remaining gates

Tests exercise actual AppModule/PostgreSQL, real synthetic multipart bytes and static re-encode, exact synthetic asset/content decisions, and actual emitted App/Page/WXML via simulated native APIs. The full simulated runner includes this PM journey without removing fixed W2/C2/W1 entries. Tests do not establish device domains/redirect/auth headers/camera permissions/background behavior, production provider credentials or review issuance, legally approved retention, remote cleanup quiescence, external push consent/templates/quota/delivery, GIF/HEIC compatibility, accepted historical IDs/objects or import/cutover. Outbox remains `not_configured`, pending or suppressed, never a real push-delivery claim. No admin/private-support image endpoint exists.
