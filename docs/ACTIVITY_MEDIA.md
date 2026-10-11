# Activity image owner (Media11)

Activities uses the independent `activity-media-v1` contract and typed protocol
`11`: owner `activities`, resource `activity_image`, audience `activity-gated`,
and purpose `activity-image`. Migration `0104_activity_media.sql` adds its scopes,
immutable appearances, retirements, and owner guards after Activity Publication
(`0103`). It shares Media's immutable storage, multipart admission, canonical
image processing, image Safety review, quotas, cleanup, and exact delivery.

## Slots, authority, and saves

There are ten distinct slots: required publication `cover` and zero to nine
gallery images in `gallery0` through `gallery8`. Drafts may temporarily omit the
cover. Slot bindings cannot repeat; foreign owners, activities, actors, slots,
revisions, and detached bindings cannot be adopted. Activity drafts and their
published records retain the same activity ID.

Prepare binds the original actor, activity ID, draft revision, slot, exact byte
declaration, and current organization authority snapshot. Activities implements
`ActivityMediaAccessPort`: management writes require the original publisher and
current target-organization owner/admin authority. Grant, ingress, observation,
and finalize recheck the original authority. Original-key status and cancellation
remain historical recovery operations, never a read or bind grant. Cancellation
before prepare creates a durable request tombstone.

`ActivityMediaService.mutate` accepts the current bindings and partial
keep/remove/replace changes in the publication transaction. Omitted slots mean
keep. Save advances the content revision once; publication copies that saved
revision unchanged. SQL deferred guards require exact agreement between the
original save command, binding asset and slot, immutable appearance, content
event, final draft pointers, and retirements. A raw event cannot turn a keep into
a replace or bind a different asset under an existing command receipt.

## Review and read boundary

Image Safety is independent of activity text-and-images Review. `reviewFacts`
checks current image Safety and returns canonical slot-ordered
`{slot, assetId, manifestDigest}` facts. `requireCurrentBindings` additionally
supports mandatory-cover validation. Activity Publication includes these exact
facts in its Review envelope; the final native publication SQL guard checks that
the reviewed facts equal the exact current assets and immutable manifests.
Publication approval does not replace image Safety. An optional organizer QR
remains an Organizations-owned public reference, outside these activity slots.

API prefix: `/v3/media/activities`.

- `POST /upload-intents`
- `GET /upload-requests/:id`
- `POST /upload-requests/:id/cancel`
- `GET /upload-intents/:id`
- `POST /upload-intents/:id/{grant,finalize,cancel}`
- `POST /upload-intents/:id/uploads/:grantId`
- `GET /{public|management}/activities/:activityId/slots/:slot/descriptor?revision=N`
- `GET /{public|management}/activities/:activityId/slots/:slot/bindings/:bindingId/:variant?revision=N`

Descriptors and `thumb-v1`/`display-v1` bytes require an authenticated current
Activities read permission. Public reads require published content, current
organization/home visibility, and current Safety for the entire bound image set,
including the required cover. Authorization and exact image evidence are checked
again after immutable storage opens, before bytes are released. No original
images, external URLs, redirects, provider locators, range responses, or public
caching are exposed.

## Limits and interrupted work

Shared server limits remain 5 MiB per input, three active uploads per actor,
100 MiB reserved per UTC day, and 10 new request keys per minute / 100 per UTC
day across Media owners. Prepare scopes expire after 30 minutes. Selecting all
ten activity images after uploading organizer images may therefore require
waiting for the real request-key window. A quota 429 includes a bounded
`Retry-After` derived from the real minute window or next UTC day. The native UI
displays that earliest retry interval; additional requests can extend the wait.
Retries must not mint keys to bypass it.

The WeChat `createActivityMediaRuntime` reuses the native resource pool: two
transfers, one upload writer per actor, four local-file reservations/leases, and
10 MiB combined local-file budget. Credits and paths remain held until actual
native completion, including late callbacks and failed cleanup. Its durable
origin/account-partitioned journal has at most 20 original requests and contains
no credentials, local paths, or image bytes. Use `pendingTargets`, `recover`, and
`cancelPending` for interruption recovery; call `reconcile(activityId)` after a
successful content save. Hiding/disposal and account changes revoke local use.
An explicit recovery of an unrecorded or not-yet-uploaded request asks the user
to reselect the original image, checks MIME/byte length/SHA-256, and retains the
original request key. A different image cannot silently replace that declaration.

Stale authority or content revisions fail closed. A Safety rejection/revocation,
expired policy/evaluation, missing immutable object, or changed second-check
proof prevents binding or delivery. An uncertain upload is recovered through its
original request key before trying another operation.

An original publisher can close only an unfinished owned draft, atomically retiring
its Activity bindings while retaining the historical events and receipts. This
uses the original reference-count and cleanup queue, not a hard byte deletion.
Original not-before/quiet-period constraints and an exact stopped-writer proof
still apply. Organization QR bindings and already published activities are not
retired by this command.

## Runtime and validation status

`ACTIVITY_MEDIA_RUNTIME` is trusted explicit DI and defaults to `null` in normal
application registration. Prepare/upload/read remain unavailable without real
immutable storage, ingress, processing and Review infrastructure. Synthetic test
DI does not enable a production provider.

The seven focused media files passed all 23 cases (10 API, 13 WeChat), including
quota retry metadata and exact-key recovery. The first composed Activity PG run
passed 12/12, including the ten-slot lifecycle, raw SQL review mismatches, actual
emitted native roundtrip, and a storage-open wait during which another gallery
image is revoked: the cover emits zero bytes. The independent organization main
QR remains readable when Activity QR display is disabled. The broader final
combined rerun is recorded separately. These checks do not establish production provider,
production migration, deployment, or physical-device acceptance.
