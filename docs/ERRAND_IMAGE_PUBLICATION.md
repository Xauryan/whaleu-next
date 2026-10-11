# Errand image publication, E3

This is a new, separately versioned owner implementation. It does not enable a
live image provider, text review issuer, production storage, institutional
verification, customer support or external group-message dispatch. Synthetic
external ports and the native callback harness are development evidence, not
WeChat DevTools/device or production acceptance.

## Grounded product scope

Pinned legacy source: `WhaleUCampus/WhaleU` at
`57cf169c11123acf249909a1a7215b8cb1ec1f8e`.

- The native picker has independent public/private collections, three each:
  [publish.js, lines 138–190 and 302–346](https://github.com/WhaleUCampus/WhaleU/blob/57cf169c11123acf249909a1a7215b8cb1ec1f8e/miniprogram1/pages/fold1/errand/publish/publish.js#L138).
  This establishes the fresh native limit; it does not claim the old server
  independently enforced that bound.
- [Errand.php, publication and detail](https://github.com/WhaleUCampus/WhaleU/blob/57cf169c11123acf249909a1a7215b8cb1ec1f8e/treehole/app/controller/Errand.php#L564)
  stores public/private sets separately. Private images are available to the
  publisher, including pending orders, and stored accepter after completion or
  cancellation. Opposite contacts are available only while accepted. No
  arbitrary post-publication user terms/image edit is established.
- [Image audit, captured-set removal](https://github.com/WhaleUCampus/WhaleU/blob/57cf169c11123acf249909a1a7215b8cb1ec1f8e/treehole/app/service/DeepSeekImageAuditService.php#L273)
  conditionally removes selected images against the captured field snapshot.
  It does not establish an automatic history TTL or physical-deletion schedule.

## Contracts and trust boundaries

`errand-media-v1` is internal Media protocol 14, reached through
`/v3/media/errands`. `errand-publication-v2` owns draft/prepare/publish/cancel
routes under `/v2`. V1 command hashes, receipt bytes, lifecycle and administrative
commands retain their existing namespace and meaning. The original V1 route
still rejects nonempty old asset arrays rather than reinterpreting old requests.

The six immutable slots are `public0`–`public2` and `private0`–`private2`.
Each upload fixes actor, server-owned draft, revision, original target/scope,
slot, audience, declaration and manifest. A private asset cannot become a public
asset by changing a route or label. Each slot permits one live original upload;
replacement/removal must durably cancel that original request first. Remaining
slots retain their original assets and slot identities, including gaps.

Publication reserves a complete canonical command and original key on the
server before submitting it. Exact content Review covers the text, contacts,
provenance, ordered public/private asset identities, immutable manifest digests
and media-set revision. All selected assets bind together in one transaction;
all Media writes precede the final Media epoch proof. There is no subset success.
The normal lifecycle UUID revision and the media-set revision are independent.

A request-result loss is resolved through the original actor/key/hash. A missing
receipt is not cancellation. Cancelling an uncertain draft first installs the
original publication rejection fence and closes the owner draft, then schedules
unbound upload cleanup. If the initial draft creation never arrived, an
actor/draft cancellation-before-create fence closes that original identity
without needing current campus or publication eligibility; a late create cannot
resurrect it. The parent journal is retained until every original upload key,
including an unrecorded key, has an exact terminal or bound-history response.
Cancellation still shares the existing request-key quotas; an uncertain or
rate-limited cleanup remains reachable for retry. Upload cancellation cannot
destroy any bound history.
The native V2 journal contains only scoped IDs, immutable declarations and
hashes. Form text, contacts, paths, bytes and credentials are never added to it.
The existing V1 pending-command journal is unchanged and still stores its
original V1 intent; it is not described as metadata-only.

## Current reads and lifetime

Every descriptor and derived-byte request uses the actual Errands readable-order
boundary: current authenticated session, verified phone, account Safety,
undeleted order and exact current business Review. Nonparticipants need the
existing base eligibility. Participants retain their relationship authority;
changing campus, losing affiliation or a publish/accept feature restriction
alone does not erase their history. No new same-campus or student-only gate is
introduced.

A currently proved held/revoked image hides its entire order while unrelated
healthy discovery/history candidates remain readable. Negative owner and Media
proofs are retained through final commit; unknown or malformed image evidence
still fails closed.

Public images mean authenticated, authorized Errand reads, not guest storage.
Private images require the publisher or stored accepter. Administrative role
alone grants no private image authority. Unauthorized DTOs omit the private
collection completely, including counts, IDs and dimensions. Opposite contacts
remain an independent accepted-only projection.

Every byte authorization checks the whole active image set and every sibling's
current image Safety, exact appearance/binding/manifest, requested derived
variant, session and owner revision. The existing exact delivery service
commits two current authorizations around paused immutable storage open. No
originals, redirects, public cache, signed URLs or range reads are exposed.
Native files use the existing shared two-transfer/10 MiB resource pool. Closing,
hiding, account/session change and stale-detail replacement revoke preview
handles; late callbacks retain capacity until the underlying operation is quiet.

Completed and cancelled orders keep active bindings and participant history.
Upload admission/bind deadlines do not become a bound-history expiry. Student
verification-evidence expiry is not reused. Normal/admin deletion immediately
denies reads and atomically retires every original appearance, including held
assets whose Review is no longer readable. Physical removal uses the existing
exact-object obligations and quiet-writer protocol.

## Audited subtraction

The trusted integration method has no public HTTP route. It accepts only an
exact current revision and exact removed appearances, preserves all surviving
bindings, appends an audit/set revision and retires removed bindings. Late or
foreign results cannot overwrite another set. No restoration/reclassification
is supported. A changed surviving set stays closed until a new exact Review
binding is recorded; it cannot inherit the original approval. Original
publication/Review bindings, receipts and lifecycle history remain immutable.

## Explicit remaining gates

- Historical administrative public-image byte preview needs a dedicated policy
  for held/tombstoned public material. Existing administrative text visibility
  is not silently promoted into byte authority. Private admin preview is denied.
- No external image/text audit provider or institutional-auth activation is
  claimed. The public UI can honestly remain Review-unavailable until a real
  accepted adapter is configured and independently approved.
- Existing raw legacy URLs do not establish native asset ownership or empty
  native sets. No legacy asset import, authoritative data reconciliation,
  production retention policy, real provider or device acceptance is claimed.
- External group messaging and live customer support remain outside E3; E4a's
  order-target School QR/Profile preference behavior is preserved independently.

## Verification inventory

The focused API/PG and native test files describe reproducible simulated
acceptance: exact scope and namespace tampering, private/admin separation,
sibling Safety revocation during storage open, lifecycle retention, quiet
retirement, draft cancellation fencing and audited subtraction. The emitted
App/Page/WXML test performs real picker-file transfer, multipart admission,
static processing, exact Review and owner publication for zero, one and three
images per audience. Execution results and exact-source coverage are supplied
with the integration handoff; test presence alone is not a pass claim.
