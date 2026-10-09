# Rating target creation API (M1)

All routes require an access token, return no-store responses and share the
existing ratings account throttle. Unknown query/body fields are rejected.

- POST `/v1/ratings/management/prepare`: body `clientRequestId`, nullable
  `regionId`, `categoryId`, `expectedCategoryRevision`,
  `expectedCatalogRevision`, normalized `name` (1–100 Unicode code points),
  `description` (0–500), and `assetIds: []`. Returns `requestId`, stable
  `targetId`, `revision`, and opaque 43-character `contextRevision`.
- POST `/v1/ratings/management/targets`: the exact same intent plus
  `expectedContextRevision`. Returns only `requestId`,
  `operation: create_target`, `outcome: applied`, `targetId`, `revision`,
  `catalogRevision` and `occurredAt`.
- POST `/v1/ratings/management/cancel`: original complete intent, without context.
  Serializes with prepare/create. An existing applied receipt wins; otherwise
  returns a durable rejected receipt with `RATING_CREATION_CANCELLED`.
- GET `/v1/ratings/management/requests/:requestId`: recover the authenticated
  account's minimal receipt. It does not authorize current target content.

Applied and terminal rejected receipts return 200. Rejected receipts contain only
`requestId`, `operation: create_target`, `outcome: rejected` and one of
`RATING_CREATION_CONTEXT_CHANGED`, `CONTENT_REJECTED`, or
`RATING_CREATION_CANCELLED`. Prepare is not publication and grants no
review approval. A preparation expires after at most ten minutes and is bound
to the preparing session. Exact success replay precedes current creation
qualification; changed intent under the same key returns REQUEST_CONFLICT.
Stale category/catalog, expired context or a new session on the same account
closes the original request durably. Prepare signals
RATING_CREATION_CONTEXT_CHANGED after committing the terminal receipt; clients
then recover that receipt before releasing their journal. Create returns the
terminal receipt directly. Unknown or
invalid deployment source policy returns RATING_UNAVAILABLE. Missing exact
Review returns CONTENT_REVIEW_UNAVAILABLE. Existing session/phone/Safety/scope
errors retain their existing meaning. Unknown Review/infrastructure failures do not persist a rejection. Explicit
content rejection and proven obsolete contexts do persist a terminal receipt.
The user may explicitly cancel unresolved work; GET 404 or local timeout never
authorizes clearing a pending journal.

Creator, policy, source, origin, baseline and authority are not client inputs.
Ordinary qualified users need no administrator approval. The original campus
may remain explicitly unknown while creation succeeds; no display-region or
profile-school inference is made. Deployment policy may explicitly require
known original-campus provenance, in which case missing evidence is unavailable.

The native creation form is accessible from a supported general category. It
retains one immutable v5 pending intent across response loss and page changes.
To resume an existing intent, use recovery rather than a new request key. Old
v1–v4 pending commands remain recoverable.
