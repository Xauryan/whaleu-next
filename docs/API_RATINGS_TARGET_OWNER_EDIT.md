# Creator-owned rating target text editing (M2B)

This slice adds versioned name/description editing for currently visible generic
(`general`) targets. It is creator-only. Administrator roles cannot replace the
ordinary affiliation/campus qualification required for a regional target.
Global targets remain global. Target identity, original category/region/source,
original campus evidence and original creation fields stay immutable.

## HTTP

All routes are authenticated, private (`Cache-Control: no-store`,
`Vary: Authorization`), strict about body/query fields, and use the existing
rating request guard. Prefix: `/v1/ratings/management/owner-edit`.

- `GET targets/:targetId/context`: current authorized text and exact lifecycle,
  definition, category and catalog CAS. The server derives canonical region from
  immutable target identity; there is no caller-selected alternate edit scope.
- `POST prepare`: persist an immutable original intent and stable next definition
  identity. This neither approves nor publishes content.
- `POST commit`: original intent plus its opaque 43-character base64url
  `expectedContextRevision`. Current ordinary eligibility, exact current Review,
  all CAS fields and the preparation's original session/deadline are rechecked.
- `POST cancel`: exact original intent. A durable completed result wins;
  cancellation never undoes a completed edit.
- `GET requests/:requestId`: own historical receipt, independent of present
  publication eligibility. No historical text is returned.

Original intent fields: `clientRequestId`, `targetId`, nullable `regionId`,
`expectedTargetRevision`, `expectedDefinitionRevision`,
`expectedContentVersion`, `categoryId`, `expectedCategoryRevision`,
`expectedCatalogRevision`, `name`, `description`, and `assetIds: []`.
Name/description use the existing normalization and 100/500-character rules.
Scope/category/source/creator/media changes are not accepted.

Preparation returns `requestId`, `targetId`, the stable next lifecycle `revision`,
next `definitionRevision`, next `contentVersion`, and `contextRevision`. Exact
retries return that preparation; an already-rejected request returns its minimal
rejected receipt. A successful command is recovered through the receipt route or
replay-first commit, never by interpreting preparation as current public content.

Successful receipts contain `requestId`, `operation: edit_target`,
`outcome: applied | noop`, `targetId`, `revision`, `definitionRevision`,
`contentVersion`, and canonical UTC `occurredAt`. A noop preserves all current
versions and requires full current qualification/CAS before text equality.
It creates no definition, Review binding or public epoch mutation.

Rejected receipts contain only `requestId`, `operation`, `outcome: rejected`,
and one strictly allowed code. Unknown Review, verification, Safety, database and
final-proof failures never become terminal rejection receipts.

## Definition, Review and historical ownership

Migration 0057 adds immutable definition versions, an advancing current head and
an immutable lifecycle-to-definition mapping. Existing versions map to original
v1 creation content, including targets whose lifecycle revision has since changed
or which already have an M2A owner tombstone. Migration does not create approvals,
repair source coverage, rewrite historical effects or make withdrawn Review allow.

New edits use exact Review envelope v3 (`edit_rating_target`) and a separate
versioned binding table. Old target/comment v1 and reply v2 bindings remain
unchanged. Every public target read, discussion gate, like/subscription gate,
notification projection and complete random pool uses the current definition.
Missing current evidence is unavailable, never a fallback to old creation text.
Revoking the latest definition does not reactivate an older accepted version.

An applied command forms a same-transaction bidirectional SQL chain from original
preparation/request through transition, immutable definition, lifecycle event,
head, lifecycle mapping, Review binding and receipt. Definitions and all original
interactions remain retained. New head/lifecycle facts are proved after mutation;
old head currentness is not retained accidentally. The prior Review decision is
still an authorization premise and retains its independent validity deadline.

Every new lifecycle/definition writer enters exclusive common Safety before
pool/navigation epoch fences and row locks. Edit-only Review binding writers
follow the same ordering before their independent binding epoch. Existing comment
and reply publication do not upgrade their shared Safety lock.

## Native recovery

The independent editing page loads text only from a currently authorized context.
Native v7 shares the original origin/account slot with unchanged v1–v6 commands.
The normalized original intent is frozen and read back before the first prepare.
Prepare/commit response loss, closing, navigation and session changes never
silently clear it. Recovery starts with own receipt lookup; retry and server
cancellation retain the exact original intent.

A new session cannot publish using an old preparation's session context. A
historical receipt does not populate the current editing form, including after
visibility or eligibility loss. Successful settlement publishes only target ID
and lifecycle revision, invalidating live catalog/detail/thread/random snapshots
and cancelling their late callbacks. The same minimal event clears all three
rating-notification preview lists, pagination and in-flight navigation, while
leaving persisted notice/read history unchanged.

M2A hidden owner deletion remains independent of editing visibility, affiliation
and current Review. This slice does not add public version-history browsing,
restoration, category/scope moves, administrator editing or new rewards/notices.
