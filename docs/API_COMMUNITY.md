# Community C1 API and safety boundary

C1 is a **partial development slice**, not production-ready community parity.
It implements explicit operating-region mapping, chronological regional/global
feeds, detail, text publication, thread-local anonymous personas, root comments,
desired-state post likes, own deletion and durable publication recovery. Normal
runtime authorization, visibility, moderation and media adapters are unavailable.
No environment switch, campus selection or client flag enables them. Synthetic
fixtures are injected only from test modules.

Image references and attachment/moderation ports are tested with synthetic local
fixtures. Binary upload, preview, media recovery, real review and delivery are
**not implemented**. Image publishing remains PARTIAL; there is no upload endpoint
or arbitrary URL input. No provider, production account, production dataset or
external moderation call is part of this slice.

## Operating regions and spaces

Physical campuses, institutions, operating regions, verified identity campuses
and community spaces are distinct. Campus owns `operating_regions` and explicit
`campus_region_assignments`. Several physical campuses can share one region; two
campuses at one institution can have different regions. There is no inferred
mapping from institution/name/district, selected campus or administrative role.
A fresh migration contains no regions, mappings, spaces or synthetic users.

- `GET /v1/operating-regions?campusId=<uuid>` returns `{items:[{id,name,isActive}]}`;
  missing mapping is an empty list, unknown campus is `404 CAMPUS_NOT_FOUND`
- `GET /v1/community/spaces?campusId=<uuid>` returns `{regional,global}`. Regional
  is null without an active campus/region/space mapping. Each space has exactly
  `{id,kind,name,isActive,operatingRegionId}`. Global spaces use kind `global` and
  null region; regional spaces use kind `regional` and a region UUID
- `PUT /v1/me/campus` still saves a browsing preference and grants no authority

Production import must preserve separate institution, physical-campus and
operating-region crosswalks, reconcile unresolved mappings without guessing and
validate historical post origin independently. Identity campus, related regions,
fixed school-administrator grants and verified affiliation remain separate work.

## Transport and exact data shapes

Use the existing safe error envelope and active opaque bearer sessions. Timestamps
below are UTC ISO strings with milliseconds. Community timestamps are stored at
millisecond precision so cursor seeks never lose PostgreSQL microseconds.
Unknown JSON/query keys, repeated query keys, coercions, invalid Unicode and
control characters except LF/TAB are rejected. Text only normalizes CRLF to LF;
it is never silently trimmed, truncated or SQL-filtered.

Category keys: `discussion`, `confession`, `companions`, `pets`, `internships`,
`scenery`, `dorms`, `research`, `deep_sea`. Global publication accepts discussion
only. Unsupported polls/trading/replies and other modes reject unknown fields.

`MediaView` is output-only:
`{assetId,width,height,displayUrl,thumbnailUrl,expiresAt}`. Dimensions are positive
bounded integers, gateway URLs are HTTPS without credentials, expiration is null
or a future UTC timestamp. No storage keys, filenames, owner IDs or EXIF are sent.
Publication accepts only ordered distinct asset UUIDs, never remote URLs.

Author is an exact tagged union:

- Named: `{kind:"named",profileId,displayName,avatar}`. Public profile UUID is
  separately generated, never the account or session UUID. Avatar is currently null
- Anonymous: `{kind:"anonymous",personaId,displayName,avatar,isPostAuthor}`. Persona
  is a random persisted identity unique to `(post,account)`; avatar is null and
  display name is a server-owned persona snapshot. No account/profile/campus ID,
  named avatar or original-author field is included, even in the author's response

Anonymous visibility evaluation never receives the underlying author account.
Ownership UI uses `viewer.isSelf`. Anonymous comments on a named parent never
expose `isPostAuthor:true`, which would identify the hidden author via the parent. Any separately privileged identity inspection
must have independent server authorization and audit; normal DTOs do not change.

`PostView` (same detail and summary shape):
`{id,space:{id,kind,name},category,text,images,author,publishedAt,likeCount,commentCount,viewer:{isSelf,isLiked,canDelete,canComment},commentsPolicy}`.
Comment count includes currently visible root comments only. No fabricated views,
pins, subscriptions, polls, notification or reward counts are returned.

`CommentView`:
`{id,postId,text,images,author,createdAt,viewer:{isSelf,canDelete}}`.

## Capabilities and current authority

`GET /v1/community/capabilities?spaceId=<uuid>&category=<key>` requires an active
session and returns exactly:

```
{
  publish: {availability: "allowed"|"denied"|"unavailable", reason: ErrorCode|null},
  authorModes: ("named"|"anonymous")[],
  canDisableComments: boolean,
  postImageLimit: 9,
  commentImageLimit: 3,
  mediaAvailability: "unavailable",
  commentRules: {unverifiedRequiresNamed: true, ownAnonymousPostForcesAnonymous: true}
}
```

`GET /v1/community/posts/:postId/comment-capabilities` independently evaluates
comment permission and same-parent visibility. It returns
`{availability,reason,authorModes,forcedAuthorMode:"anonymous"|null}`. Post publish
restrictions are not accidentally used to disable otherwise allowed comments.
Capabilities are advisory; every mutation re-evaluates authority under locks.

Authorization requires authoritative phone proof, current student verification,
identity region, per-action restrictions, explicit unverified category exceptions,
cross-region policy and scoped management permission. Runtime has no adapter for
these facts yet. Phone-unverified actors cannot write/like or continue feeds.
Student-unverified actors can only publish named content in explicitly enabled
regional categories; their comments additionally require a named parent. Global
publishing has no unverified exception. Student-verified actors need a current
identity region; cross-region anonymity is denied. Restricted comments require
scoped management for creation, and permit comments only by the true post author
or a scoped manager, in addition to all other verification and safety checks.
Own anonymous posts force the same anonymous persona for their author's comments.
Deletion and likes each have distinct phone/action checks.

## Feeds, detail and recovery reads

- `GET /v1/community/posts?spaceId=<uuid>&category=<optional>&limit=10&cursor=<optional>`
  returns `{items,nextCursor,continuation}`. Limit is 1–10. Continuation is
  `available|end|login_required|phone_verification_required`
- Guest/phone-unverified readers get at most the first ten records and no cursor.
  Every supplied cursor requires active auth and current phone proof. An invalid,
  revoked or blocked supplied bearer never silently becomes a guest
- Ordering is descending `(publishedAt,id)`. Versioned bounded cursors bind scope,
  category and page size and grant no authority. Refresh starts a new traversal
- C1 regional feeds include only explicitly regional posts, global feeds only
  global posts. Global aggregation and related-region synchronization remain C2
- `GET /v1/community/posts/:postId` requires an active session. Hidden, deleted,
  blocked, inactive-scope and missing posts all return generic `404 POST_NOT_FOUND`
- `GET /v1/community/posts/:postId/comments?limit=10&cursor=<optional>` requires an
  active session and the identical parent-visibility gate, returning `{items,nextCursor}`
- `GET /v1/me/community/posts?limit=10&cursor=<optional>` returns
  `{items:[{id,spaceId,category,status,publishedAt}],nextCursor}`, with status
  `published|hidden|deleted`. This minimal owner-only recovery list contains no
  content bodies, media or author identity and does not bypass safety removal

## Durable post/comment publication

`POST /v1/community/posts` accepts:
`{clientRequestId,spaceId,category,text,imageAssetIds:[],authorMode,commentsPolicy:"open"}`.
Text needs non-whitespace and 1–2500 Unicode codepoints; at most nine distinct
ordered assets. Image-only posts reject. Omitted images/policy materialize to
`[]`/`open` before hashing. `restricted` policy requires live scoped management.

`POST /v1/community/posts/:postId/comments` accepts
`{clientRequestId,text,imageAssetIds:[],authorMode}`. At most 500 codepoints and
three distinct assets; non-whitespace text or at least one asset is required.
C1 root comments only. Own-anonymous forcing is applied by the server.

Both POST routes return HTTP 201 for a durable terminal receipt, including a
terminal rejected receipt; clients must inspect the discriminated outcome:

- Created: `{requestId,operation,outcome:"created",resourceId,createdAt}`
- Rejected: `{requestId,operation,outcome:"rejected",code}`
- Operation is `publish_post` or `publish_comment`

`GET /v1/me/community/requests/:clientRequestId` returns the same receipt with
HTTP 200, accessible only to the active original account. Unknown is 404
`REQUEST_NOT_FOUND`; that is not evidence an in-flight request cannot still commit.

Required UUIDv4 request keys are scoped to the account across BOTH operations.
Hash includes operation and every normalized behavior field, including target
post/space and ordered assets. Equal intent returns one receipt and resource;
changed intent is 409 `REQUEST_CONFLICT`. A replay checks active session/account
before the receipt, then returns the original result before current publishing
privileges. Deleted content is never recreated and successful keys never expire.
The transaction owns ledger reservation, content/persona/assets and outbox. Unique
conflicts use `ON CONFLICT`, not an aborted-transaction retry. A savepoint rolls
back any work before storing a terminal rejection. Commit/lock/database failures,
503 unavailable dependencies and auth/validation errors are never terminal.

Terminal rejection codes: `COMMUNITY_SCOPE_UNAVAILABLE`,
`PHONE_VERIFICATION_REQUIRED`, `STUDENT_VERIFICATION_REQUIRED`,
`IDENTITY_CAMPUS_REQUIRED`, `COMMUNITY_ACTION_RESTRICTED`,
`AUTHOR_MODE_NOT_ALLOWED`, `COMMENTS_DISABLED`, `CONTENT_REJECTED`,
`MEDIA_NOT_READY`, `POST_NOT_FOUND`, `POST_DELETED`.

Native clients must durably freeze the request before dispatch and preserve it
through timeout, cancellation, malformed response, auth refresh, page closure and
account switching. A canceled wait cannot cancel a committed transaction. Never
mint a new key until a matching terminal receipt settles the previous attempt.

## Desired-state likes and own deletion

- `PUT /v1/community/posts/:postId/like` sets liked; DELETE at that path sets
  unliked. Both return `{postId,isLiked,likeCount}`. There is no toggle endpoint
- A unique `(post,account)` row and a parent lock guarantee desired state. Only
  actual transitions enqueue outbox events. No external notifications are delivered
- `DELETE /v1/community/posts/:postId` and `/v1/community/comments/:commentId`
  are own-only and idempotent HTTP 204. Foreign ownership returns generic absence
- Deletion marks state once and enqueues one event; content, category and durable
  receipts remain internally retained. Post deletion immediately gates dependent
  comments/media/likes. No physical data/media removal occurs on these routes

## Transaction and module boundaries

Community SQL never reads identity/campus/profile tables. Exported facades supply
transaction-aware active identity, active region and minimal public author display.
All dependent mutations lock parent before child. Current local authorization,
visibility, media and approval state must be locked through commit by adapters.
No network/provider operation is permitted while locks are held. Future external
review needs a queued durable workflow, not a synchronous call hidden inside a
request handler. A separate authorization/audit module can use the internal-only
content-identity facade; it applies the same visibility gate and is not an HTTP
capability itself.

Real isolated PostgreSQL tests cover concurrent deduplication, account/operation
conflicts, delayed/lost response recovery, commit failure, terminal versus transient
rejections, revocation and scope/session locking, anonymous privacy, blocked named
authors, hidden/deleted parents, media owner/digest mismatch, desired-state likes,
delete/comment races, preview cursor bypass and ordinary fail-closed defaults.
These tests do not establish real provider or physical-device acceptance.

C1 read processing has a defensive 1,024-candidate scan budget and a 1,024-root-
comment counting budget per post. Exceeding either fails with
`COMMUNITY_UNAVAILABLE`; it never emits a partial count or a cursor derived from
an invisible row. Query-level authoritative visibility filtering and scalable
viewer-specific counts remain a production-scale gate.

## Retained parity backlog

C2 discovery: category reconciliation, global school filters/aggregation, explicit
related-region sync, cross-region labels, water-post quotas, hot/search feeds,
public profile privacy, subscriptions, exposures, pins, unread state.

C2 composition: title fidelity, full drafts, remembered contact/location/link
fields, anonymous DM choices, polls, trading, group formation, linked boards/groups
and ratings, feedback channels, post status workflows.

C2 discussion: replies and target deep links, reply pagination, comment sorting,
comment/reply likes/history, pins, complete identity defaults, moderation/removal
transitions and administrative deletion consequences.

Prerequisites: phone/student/email/affiliation verification and expiry, identity
campus, related-region policy, current restrictions, real administration/review/
report/ban/block systems, content/media approval and deployment.

Consumers: notifications, mini-program/official-account delivery, subscriptions,
reward/experience/refunds, ranking/exposure persistence, assisted classification,
provider retries/cost controls, media cleanup and audit.

Every other master feature-parity group remains in scope. This API does not mark
full community, school identity, media, native device acceptance or migration done.
