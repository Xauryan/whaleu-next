# Major discussion images v2

This forward-only slice extends the independent Major directory/discussion owner
and its 0124 logical withdrawal. Migration 0125 introduces Media17 scopes and
appearances, independent v2 Review and versioned publication. It does not activate
real providers, source/import/model issuers, production deployment or device QA.

## Explicit Next policy and version compatibility

Up to three JPEG/PNG inputs per root/reply; each input is limited to 5 MiB and the
shared static decoder's 24-million-pixel budget. Only thumb-v1/display-v1 derived
variants are delivered. The pinned legacy Major source does not establish its
image-count limit; three is a new bounded Next policy.

Major always requires valid nonblank text, including when images are present.
Existing byte-preserving Unicode/no-NUL/8,000 UTF-8-byte rules remain, including
valid `0`. Image-only, whitespace-only, fourth/duplicate assets, raw URLs, wrong
ordinals and extra fields fail admission. Declaration cannot override decoding.

Existing v1 envelopes, command/Review hash domains, purposes, receipts and exact
original-key recovery stay unchanged; no images field is added to their canonical
bytes. V2 commands use major-discussion-v2 and independent root/reply v2 purposes,
with the exact ordered asset/manifest set included in command and Review hashes.
V2 pages include the complete mixed population. V1 full discussion reads fail
closed for an unrepresentable v2 population instead of dropping rows or images.
Directory counts/hot roots use the same current whole-set visibility; missing
source/history remains unavailable. Directory cursors also retain Media epoch and
off-page v2 Review/Media deadlines.

## Independent owner, atomic publication and final authorization

Shared Media supplies intent/quota, ingress, static processing, MediaSafety,
immutable storage and private delivery. Major uses independent owner `majors`,
resource `major_discussion_image`, scopes, appearances, context and Review storage;
Window/generic Ratings/PM/Errand identities grant no Major authority.

Publication atomically proves the ordered complete image set, exact Review,
content, bindings, appearances, original-key receipt and Major notice obligations.
New publication requires existing Major base eligibility plus phone/session/Safety.
Every positive like, projection, notice preview, descriptor and byte delivery
checks the full current image set and root ancestry. A held sibling suppresses the
whole content, including its text and first thumbnail.

V2 mutations acquire the existing named-policy gate exclusively before the
original publication key. Review consumes the decision and first epoch in the
same SELECT, freezing that epoch through final proof. All own media writes finish
before parent/set dependencies are reread and the final Media epoch is retained.
Raw/zero-row/TRUNCATE writers join statement epochs; existing NOWAIT and 100 ms /
500 ms final-proof budgets remain. The exact Media source-inventory concurrency
helper explicitly includes all three new tables without weakening equality checks.

## Logical withdrawal and original-key recovery

0124 author and exact scoped-admin withdrawal remains intact. Its tombstone-aware
visibility wrapper and deletion fences are preserved. Root withdrawal denies all
descendants immediately; deleting an addressed reply removes that reference while
preserving other authors' content and images.

Delivery authorizes again after storage open, keeps the stream paused through
managed final proof and commit, and emits zero bytes if subject/root deletion or
another dependency change invalidates the plan. Already delivered bytes cannot be
recalled. No original/public/signed URL fallback is provided.

No new physical purge, retention TTL or bound-image retirement cause exists.
Source/Review withdrawal revokes current access only. Bound image variants do not
inherit upload expiry, and withdrawing a root does not destroy other authors'
image objects. Unbound draft lifecycle remains the existing shared mechanism.

Original session-owned receipts/cancellation, author delete and known unlike avoid
unnecessary source/Review dependencies. V2 pending records store bounded original
IDs, hashes, context and upload recovery keys, never body/bytes/paths/descriptors.
Valid old v1 receipts take priority over optional corrupt v2/owner-locator caches;
new admission remains strict and damaged caches are not overwritten. A recovered
v2 publication can produce the existing signed owner locator for later first delete.

## Notifications and native behavior

Root-author notices navigate to the root while text/thumbnail come from the causal
new reply. Addressed-author notices navigate to that new reply. Like notices have
no image, and Major has no creator notice. Both target and causal reply must remain
visible, and the whole image set must allow before the first thumbnail is shown.

Registered Major pages use picker inspection, ordered upload and a controlled
in-page gallery. App retains one shared file registry across owners: two transfers,
10 MiB and four handles. Hide/back/unload/account/session/origin changes invalidate
private presentation; late callbacks cannot revive it. Budget releases require
real native quiet completion.

## Routes and verification scope

Versioned publication/projection/recovery routes live under `/v2/majors` and
`/v2/me/major-discussion/notices`. Media routes live under
`/v3/media/major-discussions`. Existing v1/delete routes remain distinct. All are
strict bearer/no-store/Authorization-varying contracts. The generated artifact is
[Major image discussion OpenAPI](openapi/major-discussion-images.json).

Synthetic integration covers real multipart/processing/SQL publication and real
HTTP/PG native adapters, including genuine legacy lost-response recovery before
upgraded default-App v2 publication, another cold v2 recovery and later owner-locator
withdrawal. Platform IO and explicitly synthetic source/Review/storage remain test
boundaries. Exact frozen-tree validation results must be recorded separately;
this document does not imply production provider or physical-device acceptance.
