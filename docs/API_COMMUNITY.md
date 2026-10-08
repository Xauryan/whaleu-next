# Community C1 + C2A + C2B + C2C API and safety boundary

C1, C2A polls, C2B discussion and C2C trading are **partial development slices**, not production-ready community parity.
It implements explicit operating-region mapping, chronological regional/global
feeds, detail, text publication, thread-local anonymous personas, root comments,
desired-state post likes, own deletion, durable publication recovery, poll composition/reads and immutable
ballots with owner-only recovery, flat replies, discussion ordering/context,
author root pins and recoverable discussion reactions. Normal runtime now composes
canonical phone/affiliation/safety/grant and identity-scope facts, consumes exact
immutable text approvals, and verifies bound content through the real named-block
visibility wrapper. No environment switch, browse-campus selection or client flag
enables authority. Review issuance and media remain unavailable; ordinary native
compose capabilities remain unavailable. See [runtime policy increment 1](COMMUNITY_RUNTIME_POLICY.md)
for the text-only boundary and normal-AppModule synthetic acceptance.

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
validate historical post origin independently. Current local identity-campus,
related topology, fixed school-admin grants and affiliation records are consumed
independently; production issuance, administration and reconciliation remain work.

## Transport and exact data shapes

Use the existing safe error envelope and active opaque bearer sessions. Public
timestamps below are UTC ISO strings with milliseconds. Source enrollment retains
exact PostgreSQL timestamp coordinates, including finer stored precision; a
rendered timestamp is not a substitute for an opaque server cursor.
Unknown JSON/query keys, repeated query keys, coercions, invalid Unicode and
control characters except LF/TAB are rejected. Text only normalizes CRLF to LF;
it is never silently trimmed, truncated or SQL-filtered.

Category keys: `discussion`, `confession`, `companions`, `pets`, `internships`,
`scenery`, `dorms`, `research`, `deep_sea`, `trading`. Global publication accepts discussion
only. Trading is specified in C2C below; unsupported group/link modes reject unknown fields. C2A polls use
the strict discriminated component described below.

`MediaView` is output-only:
`{assetId,width,height,displayUrl,thumbnailUrl,expiresAt}`. Dimensions are positive
bounded integers, gateway URLs are HTTPS without credentials, expiration is null
or a future UTC timestamp. No storage keys, filenames, owner IDs or EXIF are sent.
Publication accepts only ordered distinct asset UUIDs, never remote URLs.

Author is an exact tagged union:

- Named: `{kind:"named",profileId,displayName,avatar,experienceDisplay}`. Public profile UUID is
  separately generated, never the account or session UUID. Avatar is currently null
- Anonymous: `{kind:"anonymous",personaId,displayName,avatar,isPostAuthor}`. Persona
  is a random persisted identity unique to `(post,account)`; avatar is null and
  display name is a server-owned persona snapshot. No account/profile/campus ID,
  named avatar or original-author field is included, even in the author's response

Named experience cosmetics use the same independent evidence contract as public
profiles; see [public experience](API_EXPERIENCE.md#public-experience-projection).
Anonymous/unavailable variants never carry that block, including all-null values.
Balances, ownership dates, source history and grant provenance remain private.

Anonymous visibility evaluation never receives the underlying author account.
Ownership UI uses `viewer.isSelf`. Anonymous comments on a named parent never
expose `isPostAuthor:true`, which would identify the hidden author via the parent. Any separately privileged identity inspection
must have independent server authorization and audit; normal DTOs do not change.

`PostView` (same detail and summary shape):
`{id,space:{id,kind,name},category,text,images,author,publishedAt,likeCount,commentCount,replyCount,discussionCount,viewer:{isSelf,isLiked,canDelete,canComment},commentsPolicy,component,trading}`.
Comment count includes currently visible root comments only; replyCount is visible
replies under visible roots, discussionCount is their sum. No fabricated views,
subscriptions, notification or reward counts are returned.

`CommentView`:
`{id,postId,text,images,author,createdAt,likeCount,replyCount,isPinned,replyPreview:{items,nextCursor},viewer:{isSelf,canDelete,isLiked,canPin}}`.

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
`{availability,reason,authorModes,forcedAuthorMode:"anonymous"|null,lastAuthorMode:"named"|"anonymous"|null}`. Post publish
restrictions are not accidentally used to disable otherwise allowed comments.
Capabilities are advisory; every mutation re-evaluates authority under locks.

Publication authorization composes authoritative phone proof, independent current
affiliation, identity selection, per-action restrictions, explicit unverified
exceptions, scope relation and applicable management permission. These are now
read from canonical owner facades. Phone-unverified actors cannot write/like or
continue feeds; phone-only interactions do not require affiliation or selection.
Student-unverified actors can publish named posts in explicitly enabled regional
categories. Root/reply publication instead uses the independent authoritative
regional unverifiedCommentsAllowed switch and requires named identity and a named
parent post; the new-post category allowlist does not govern comments/replies. Global
publishing has no unverified exception. Student-verified actors need a current
identity selection. Related posts may be anonymous; foreign posts are named-only,
while verified roots/replies may be anonymous across regions. Restricted new-post
comments require the distinct canDisableComments permission; existing restricted
content permits comments only by the true post author or a target manager, in
addition to all other verification and safety checks.
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
`{clientRequestId,spaceId,category,text,imageAssetIds:[],authorMode,commentsPolicy:"open",component?:PostComponent}`.
Text needs non-whitespace and 1–2500 Unicode codepoints; at most nine distinct
ordered assets. Image-only posts reject. Omitted images/policy materialize to
`[]`/`open` before hashing. `restricted` policy requires live scoped management.

`POST /v1/community/posts/:postId/comments` accepts
`{clientRequestId,text,imageAssetIds:[],authorMode}`. At most 500 codepoints and
three distinct assets; non-whitespace text or at least one asset is required.
This route publishes roots. C2B replies use their own route below.
Own-anonymous forcing is applied by the server.

Both POST routes return HTTP 201 for a durable terminal receipt, including a
terminal rejected receipt; clients must inspect the discriminated outcome:

- Created: `{requestId,operation,outcome:"created",resourceId,createdAt}`
- Rejected: `{requestId,operation,outcome:"rejected",code}`
- Operation is `publish_post`, `publish_comment` or C2B `publish_reply`

`GET /v1/me/community/requests/:clientRequestId` returns the same receipt with
HTTP 200, accessible only to the active original account. Unknown is 404
`REQUEST_NOT_FOUND`; that is not evidence an in-flight request cannot still commit.

Required UUIDv4 request keys are scoped to the account across all THREE publication operations.
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
`MEDIA_NOT_READY`, `POST_NOT_FOUND`, `POST_DELETED`, `COMMENT_NOT_FOUND`,
`REPLY_NOT_FOUND`.

Native clients must durably freeze the request before dispatch and preserve it
through timeout, cancellation, malformed response, auth refresh, page closure and
account switching. A canceled wait cannot cancel a committed transaction. Never
mint a new key until a matching terminal receipt settles the previous attempt.

## Desired-state likes and own deletion

- `PUT /v1/community/posts/:postId/like` accepts strict `{requestId,liked}`.
  The former bodyless PUT/DELETE commands are not retained. There is no toggle endpoint
- `GET /v1/me/community/post-like-requests/:requestId` returns the owner's immutable
  `{requestId,operation:"set_post_like",postId,liked,outcome,code?}` receipt. Applied
  and safely rejected outcomes are durable; request/intent conflicts are HTTP 409
  `REQUEST_CONFLICT`, and unknown receipts are HTTP 404 `REQUEST_NOT_FOUND`
- Safe rejection codes are `POST_NOT_FOUND`, `COMMUNITY_SCOPE_UNAVAILABLE`,
  `PHONE_VERIFICATION_REQUIRED` and `COMMUNITY_ACTION_RESTRICTED`. A historical
  receipt contains no current count or membership assertion. Native clients reload
  current content after settlement rather than applying a stale receipt as state
- A unique `(post,account)` row and parent lock guarantee desired state. Only actual
  transitions enqueue events. Retrying an old successful intent after an intervening
  unlike does not reapply it; a genuine new re-like uses a new request ID
- Fresh experience source enrollment commits with the transition; each beneficiary
  settles independently. See [local experience](API_EXPERIENCE.md). No external
  notifications are delivered
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

## C2A poll contract

C2A is an end-to-end development slice. Canonical runtime acceptance now covers
approved text polls and phone-only voting without policy overrides. It does not add a
provider, student-verification method, institutional SSO, student-number backfill,
production import or physical-device acceptance.

`PostComponent` is absent, `{kind:"none"}`, or
`{kind:"poll",question,selectionMode:"single"|"multiple",options:string[]}`.
Polls supplement required nonblank post text. Publication inherits all C1
category, region, named/anonymous, configured unverified-category and review
rules. Group/link fields remain rejected; trading cannot contain a poll, including
conflicting fields inside a poll component. New creation accepts no deadline field; deadline is null.

- Question and each option require nonblank text and at most 255 Unicode
  codepoints. These are new-write limits, not historical source limits
- Text retains whitespace and normalizes CRLF only. Strict Unicode/control checks
  match C1. Duplicate labels compare trimmed text without changing stored text
- There are 2–5 total options with at least two ordinary options. Optional
  “吃瓜🍉”, matched after trimming, is allowed only last and counts toward five
- Native composition defaults that final option on. It is an ordinary selectable
  option, not abstention or a different authorization path
- Component absence and explicit none omit the component from the canonical
  publication intent. Previously frozen C1 intent hashes/receipts remain valid
- Poll question, mode and ordered options join every other normalized publication
  behavior field in the publication hash. Typed version-2 structured review
  requires this full intent hash in addition to approved media digests. Approval
  for the same post body alone cannot approve a poll or altered options
- Post, poll, options, persona, publication receipt and existing `post_created`
  outbox obligation commit atomically. Rejection or commit failure leaves none
  of the attempted content behind

Every `PostView` now has `component:{kind:"none"}|{kind:"poll",poll:PollView}`.
`GET /v1/community/posts/:postId/poll` requires an active session and the exact
same visible/active parent gate as post detail. Missing component is
`404 POLL_NOT_FOUND`; hidden/deleted/blocked/inactive parent stays generic
`404 POST_NOT_FOUND`. No naked poll route bypasses parent visibility.

`PollView` is exactly:

```
{
  id, postId, question, selectionMode: "single"|"multiple",
  options: [{id,label,position,count}],
  deadline: string|null, expired: boolean,
  voterCount: number, selectionCount: number,
  viewer: {hasVoted,selectedOptionIds,canVote,reason}
}
```

Options have server-generated UUIDs and contiguous zero-based positions. Counts
are actual committed ballots/selections: two voters selecting five options total
produce `voterCount:2,selectionCount:5`. Eligible readers, including eligible
preview-feed readers, receive aggregate counts. Native result bars reveal after
the viewer votes or expiry; that UI is not a secrecy guarantee. Other accounts'
choices, account IDs, profiles and voter lists are never returned.

Viewer reason precedence is already voted (`POLL_ALREADY_VOTED`), expired
(`POLL_EXPIRED`), guest (`AUTHENTICATION_REQUIRED`), unavailable authority
(`COMMUNITY_UNAVAILABLE`), phone proof (`PHONE_VERIFICATION_REQUIRED`), vote
restriction (`COMMUNITY_ACTION_RESTRICTED`), otherwise null. `canVote` is true
only with a null reason; committed own choices are read-only. Advisory decisions
are rechecked on mutation.

### Ballot creation and recovery

`POST /v1/community/posts/:postId/poll/ballots` accepts only
`{clientRequestId,optionIds:string[]}`. Active identity determines the actor.
Single choice requires exactly one option; multiple choice permits one through
all distinct options. Empty/repeated IDs, coercions and caller-supplied identity
fields are rejected by HTTP validation. Foreign/unknown options and single-choice
multiples produce terminal `POLL_OPTIONS_INVALID` without recording a ballot.
UUID casing and selected option order normalize to a canonical set for intent
hashing; poll definition option order remains significant.

The dedicated `vote` action requires active account/session, authoritative phone
proof, current vote restrictions and visible active parent/scope. It does not
require student verification, identity-campus selection, publishing privilege or
being someone other than the post author. There is no revote, unvote or edit.

HTTP 201 returns a minimal durable terminal receipt:

- `{requestId,operation:"cast_poll_ballot",outcome:"created",resourceId,createdAt}`
- `{requestId,operation:"cast_poll_ballot",outcome:"rejected",code}`

`GET /v1/me/community/poll-requests/:clientRequestId` returns the receipt with
HTTP 200, or `404 REQUEST_NOT_FOUND`. This is a dedicated account-owned namespace,
separate from C1 publication requests. Equal-key/equal-intent replays return the
same receipt; changed intent returns `409 REQUEST_CONFLICT`. Different keys
cannot defeat unique `(poll,account)` ballots: later attempts get durable
`POLL_ALREADY_VOTED`. IDs and terminal receipts never expire or reset on deletion.

Terminal ballot codes are `POST_NOT_FOUND`, `POLL_NOT_FOUND`, `POLL_EXPIRED`,
`POLL_ALREADY_VOTED`, `POLL_OPTIONS_INVALID`, `PHONE_VERIFICATION_REQUIRED`,
`COMMUNITY_ACTION_RESTRICTED` and `COMMUNITY_SCOPE_UNAVAILABLE`. Authentication,
validation, conflict, database/commit failure and unavailable dependencies do not
commit a terminal receipt. Receipt-not-found never proves a concurrent original
request cannot still commit.

`GET /v1/me/community/poll-ballots/:postId` returns only the active account's
`{postId,ballotId,createdAt,selectedOptionIds}`, or `404 BALLOT_NOT_FOUND`.
Receipt and own-status recovery remain available after permission loss, deadline,
hidden/deleted parent, without question, labels, live counts or hidden content.
Active account/session checks still precede successful replay and recovery.

Native clients durably freeze account-and-origin-isolated ballot intent before
sending. Unknown outcomes survive timeout, malformed responses, Back/reopen,
session refresh and account switching; a conflicting new ballot stays disabled
until receipt recovery settles the frozen request. Single-choice taps submit;
multiple choice uses local selection and explicit submit. Counts always refresh
from the server, never from persisted optimistic increments.

### Poll storage, import and transaction boundary

Migration `0008_community_polls.sql` adds empty community-owned poll/option,
ballot/selection and dedicated request tables; it changes no earlier migration
or existing schema ownership. The existing community integration cleanup/guard
covers these tables. Foreign keys bind ballot selections to the same poll,
uniqueness enforces one poll per post/ballot per account, and deferred constraints
require complete option/ballot sets at commit. Definitions, ordered options,
ballots and choices are immutable. Child rows can only be added in their parent's
creation transaction; terminal request payload/receipt cannot be replaced or
removed, and pending reservations cannot commit alone.

Historical question/option text is stored verbatim without the new-write text
limit. Reconciled historical polls insert their nullable/datetime deadline at the
import boundary; there is no public deadline editor/early-close route. Preserve
raw original timestamps/timezone and irregular source records privately until
explicit reconciliation, never silently truncate text or guess source indices.
Production source extraction/import remains separate required work.

Voting locks active session/account, its request reservation, parent post, scope,
authority and poll in the established order. After these locks, a separate
`clock_timestamp()` query evaluates expiry; request-start/transaction-start time
cannot admit a ballot queued across its deadline. Parent locking serializes votes
with deletion/hiding and gives coherent read counts. Local authority, visibility
and approval adapters must hold their facts through commit; no provider call is
allowed under locks. Ballot/selections/receipt and one minimal `poll_ballot_cast`
outbox transition commit together. There is no invented ballot notification or
reward obligation, and outbox creation is not external delivery.

Real isolated PostgreSQL tests cover equal/different-key races, changed intent,
complete rollback, strict HTTP validation, immutable DB constraints, expiry after
lock waits, publication review binding, two-voter/five-selection counts, author
and student-unverified voting, global/regional publication, named/anonymous
privacy, lost permission/deleted-parent recovery, restriction/block/session/scope
locks and ordinary fail-closed adapters. Actual native gateway → HTTP → PostgreSQL
coverage is separate from mocked gateway/controller tests. Physical WeChat
DevTools/device acceptance and production-scale count/query performance remain
release gates.

## C2B discussion contract

C2B extends the same development-only boundaries. It creates no provider, production
account, real moderation adapter or media upload. Its normal runtime remains
fail-closed on missing facts; canonical synthetic records also exercise normal
providers without overrides. Anonymous subjects
never carry their underlying account into the visibility adapter. No new student
verification, campus selection, SSO or student-number backfill is required.

### Flat threads, counts and access

A root belongs to one post. Every reply belongs directly to that root and post,
and targets either its root or an already committed reply in the same root. There
are no recursive child reply arrays. Database composite foreign keys enforce this
relationship; a target-before-reply sequence constraint rejects future/cyclic
relations. Reply content/ownership/target and root parent/ownership are immutable.
Historical reply text has no database length cap, permitting reconciled import
without truncation; new HTTP writes retain the established 500-codepoint limit.

Every child read/action checks active session, parent visibility and active scope,
then root visibility. Target identity is separately visibility-gated. A deleted
root suppresses all of its replies. Deleting one reply does not delete later
siblings: an unavailable target becomes exactly `{status:"unavailable"}` without
its ID, author, text or media. New replies may not target such an unavailable row.

`ReplyView` is exactly:
`{id,postId,rootCommentId,target,text,images,author,createdAt,likeCount,viewer:{isSelf,canDelete,isLiked}}`.
Available target is `{status:"available",kind:"comment"|"reply",id,author}`;
unavailable target is the status-only variant above. Author uses the existing
strict named/anonymous union. An anonymous reply on a named post never exposes
`isPostAuthor:true`, even to its own account. Own anonymous-post authors are forced
to their existing thread persona. Recovery receipts contain no authors or content.

Comment capabilities also return `lastAuthorMode`, the current account's most
recent nondeleted root/reply participation under a nondeleted root, or null. A
shared server-owned sequence determines order under the parent lock, avoiding
wall-clock ties/rollback. This advisory value carries no author ID or body and
cannot override forced/allowed modes or a touched draft. Historical source order
must be explicitly reconciled during import; no production import has occurred.

`commentCount` remains the visible-root count. New `replyCount` counts visible
replies beneath visible roots, including siblings whose explicit target vanished.
`discussionCount` is their sum. Root `replyCount` is full visible count, independent
from its inline preview size. The 1,024 candidate/reply budgets fail with
`COMMUNITY_UNAVAILABLE` rather than presenting partial counts as exact. Scalable
query-level authoritative filtering remains a release gate.

### Read, sort, preview and location

- `GET /v1/community/posts/:postId/comments` accepts `limit=1..10`,
  `sort=time|likes` (default likes), `order=asc|desc` (default desc),
  `previewLimit=1..5` (default 2), and optional cursor
- Root order is pinned first. Time follows the selected direction; likes follows
  the selected direction then newest timestamp and deterministic ID. Each root
  embeds earliest-first `replyPreview:{items,nextCursor}`
- Opaque v3 root cursors bind viewer, parent, sort, direction and limits. Their
  fingerprint covers visible root IDs, creation times and pins, plus like counts
  only for likes ordering. Relevant root eligibility/order or typed scope/size
  changes return `409 DISCUSSION_RESTART_REQUIRED`; valid v2 cursors explicitly
  require the same safe restart. Malformed cursors return 400. The viewer binding
  is hashed; raw private account identifiers never appear in cursors
- Root traversal filters/orders at most 1,024 candidate roots, then serializes only
  the selected page of at most 10. Off-page replies/counts/previews/media/names are
  not read for the cursor. Off-page reply changes and time-sort like changes do
  not invalidate traversal; each selected root still gets fresh counts/previews
- Native Previous/Next replaces roots through a fresh parent/page/context read and
  stores cursor history only. It never restores old root DTOs or expanded previews.
  Restart, sort, reload, session/safety changes and cancellation clear traversal;
  located context and reply drafts/targets remain independent
- This endpoint-local bound does not remove the existing PostView serializer's
  1,024 visible-replies-per-post aggregate limit. Native navigation rereads that
  parent, and the 1,024-root and per-selected-root 1,024-reply candidate limits
  remain separate scale gates
- `GET /v1/community/comments/:commentId` reads one visible root with its preview
- `GET /v1/community/comments/:commentId/replies` accepts limit 1–50, default 20,
  and cursor. Replies use a server-owned monotonic sequence, allocated while the
  parent write lock serializes commits, not random UUID or client-time ordering
- Preview continuation is bound to the ordinary default page size 20, positioned
  after the last earliest-preview reply. Changing an explicit reply-page size
  requires restarting that traversal; cursor ancestry/size mismatches return 400
- `GET /v1/community/replies/:replyId` reads one visible reply through parent/root
- `GET /v1/community/posts/:postId/discussion-context` accepts exactly one of
  `commentId` or `replyId`. It returns `{comment,reply,replies:{items,nextCursor}}`,
  with `reply:null` for root location, otherwise the target and up to two adjacent
  replies on each side. This separate located window always has null nextCursor;
  the root's ordinary earliest-preview cursor is unchanged. Located context never
  skips normal traversal or adds a second count. Consumers deduplicate by ID

Neither cursor nor receipt is an access grant. Every continuation/location read
rechecks current visibility. Hidden/blocked/deleted parents and inactive scopes
produce the existing generic absence. Missing roots/replies use
`COMMENT_NOT_FOUND`/`REPLY_NOT_FOUND` without identity or body details.

### Reply publication and recovery

`POST /v1/community/comments/:rootCommentId/replies` accepts only
`{clientRequestId,targetReplyId:null|string,text,imageAssetIds:[],authorMode}`.
Omitted target becomes null (the root); a UUID targets an existing reply in this
root. No target person/profile/name, alternate root, scope or claimed role is
accepted. Text is nonblank or there are 1–3 distinct ordered approved assets;
image-only intent is supported by the schema but actual media remains gated.

HTTP 201 returns the existing minimal publication receipt with operation
`publish_reply`. It shares the account-owned publication-key namespace and
`GET /v1/me/community/requests/:requestId` recovery. Normalized root/target,
requested mode, body and ordered asset IDs join the request hash. Typed version-3
content approval additionally binds the resolved post/root/target, effective
forced mode and approved image digests. A root's parent cannot be reassigned.
An approval for another target, identity mode or body cannot approve this reply.
C1 publication hashes and receipts are unchanged.

Request reservation, reply, persona, attachments, frozen terminal receipt and
outbox obligation commit atomically. Equal concurrent intent yields one resource.
Changed intent is `REQUEST_CONFLICT`. Terminal missing-root/target rejections are
frozen; transient auth/validation/DB/approval/media unavailability creates no
terminal receipt. Recovery and successful replay check active account before
returning the old receipt, then bypass current publication permissions without
recreating hidden/deleted content. Unknown receipt never proves no in-flight commit.

### Recoverable desired-state reactions and author root pins

All following routes require active identity and a JSON body
`{clientRequestId:<UUIDv4>}`, including DELETE:

- `PUT|DELETE /v1/community/comments/:commentId/like`
- `PUT|DELETE /v1/community/replies/:replyId/like`
- `PUT|DELETE /v1/community/comments/:commentId/pin`

PUT means true and DELETE false. They use independent phone/action checks for
`like` or `pin`; student/publication/category gates and restricted-comments policy
do not prohibit these actions. Only the true post author can pin/unpin. A manager
who is not the author cannot, nor can a root author merely by owning that root.
At most one active root is pinned per post. Pinning another returns a frozen
`COMMENT_PIN_CONFLICT`; explicitly unpin first. Same-root re-pin is a no-op and
preserves its original time. Unauthorized author pin is generic `COMMENT_NOT_FOUND`.

HTTP 200 returns a frozen receipt:
`{requestId,operation,outcome:"applied",resourceId,desired}` or
`{requestId,operation,outcome:"rejected",code}`. Operations are
`set_comment_like`, `set_reply_like`, `set_comment_pin`.
`GET /v1/me/community/discussion-requests/:requestId` recovers this separate
account-owned namespace. Minimal receipts deliberately contain no live counters,
pin actor or target content. Refetch visible state after resolution.

This receipt design prevents an already-committed old request from reapplying a
stale like/pin after a newer opposite transition. Clients freeze one unresolved
mutation before dispatch and resolve it before issuing opposite intent. Different
independent client requests serialize by database arrival, not an invented global
wall-clock order of user gestures. No global multi-device last-gesture guarantee
is claimed. Actual state transitions alone create outbox events; desired-state
no-ops and receipt replays do not create duplicate obligations.

`DELETE /v1/community/replies/:replyId` is own-only idempotent 204; repeated and
concurrent same-owner deletion creates one event. Root deletion clears its pin
atomically and gates descendants without physically deleting them or charging
all descendant authors. Post authors have no implicit right to delete someone
else's comment/reply. Administrative removal/reasons/bans remain separate work.

### Integrity, privileged identity and side effects

Migration `0009_community_discussion.sql` adds only empty target-owned discussion
storage and forward constraints. Migrations 0001–0008 are unchanged. It strengthens
publication receipts against mutation/pending-only commits without rewriting old
payloads and adds separately immutable discussion mutation receipts. Parent-first
locking serializes publication, reactions, pins and deletion. Local authority,
visibility and approval adapters hold their facts through commit; no network or
provider work occurs under locks.

The developer-only audited identity endpoint now accepts `kind:"reply"`. It uses
the same private owner facade, parent/root visibility checks, current developer
grant and metadata-only audit before disclosure. Reply identity never enriches
ordinary discussion DTOs. The private route does not reveal a removed target or
bypass hidden/deleted parents, and nondeveloper managers remain denied.

Outbox context is internal. New roots preserve actor/post references and obligations
for distinct nonself post-author notification/reward, eligible current saved-post
subscriber notification, actor reward, ranking and media audit. New replies
preserve new reply/root/explicit target, actor and deduplicated nonself root/target
recipients, with reply notification and reward/ranking/media obligations; there is
no invented saved-subscriber fan-out for replies. Actual likes/unlikes retain
transition identity/actor/recipient and applicable lifetime-deduplicated
notification, capped reward or ranking obligations. Unlike does not imply reward
reversal. Own deletion retains one deduction/refund/ranking/media-cleanup obligation.

Consumers must still implement current eligibility/visibility, self/overlap and
mute/consent/quota checks, their own idempotent receipts, retries and delivery or
reward recovery. Persisting an event is not notification delivery, paid experience,
ranking completion or media cleanup. Full notification/subscription/reward and
moderation providers remain explicitly unimplemented gates.

## Retained parity backlog

C2 discovery: category reconciliation, global school filters/aggregation, explicit
related-region sync, cross-region labels, water-post quotas, hot/search feeds,
public profile privacy, subscriptions, exposures, pins, unread state.

C2 composition: title fidelity, full drafts, remembered contact/location/link
fields, anonymous DM choices, group formation, linked boards/groups
and ratings, feedback channels and non-trading post status workflows. C2C below
implements the listing slice; scoped-manager trading status, public-profile
trading privacy and external trade distribution remain outstanding.

C2 discussion remaining: liked and own/received histories, reaction batch status,
full report/block/moderation/removal and ban workflows, administrative deletion
consequences, full persistent drafts and additional composition conveniences.
Administrator feed-post pins are separate from implemented author root pins.

Prerequisites: phone/student/email/affiliation verification and expiry, identity
campus, related-region policy, current restrictions, real administration/review/
report/ban/block systems, content/media approval and deployment.

Consumers: notifications, mini-program/official-account delivery, subscriptions,
reward/experience/refunds, ranking/exposure persistence, assisted classification,
provider retries/cost controls, media cleanup and audit.

Every other master feature-parity group remains in scope. This API does not mark
full community, school identity, media, native device acceptance or migration done.

## C2C trading listings (development slice)

C2C adds regional named listings, exact money text, chosen contact disclosures,
subtype filtering, visible own listings and durable author resolution. It remains
partial: no checkout, escrow, payment, order, fulfillment, production import,
external group push, real review/media integration or physical-device acceptance.
Canonical runtime authorization, approved text visibility and exact review
consumption now work with explicit owned facts; review issuance and media remain
unavailable. Neither native category selection nor environment flags grant
permission. Real-provider acceptance uses isolated canonical synthetic records.

### Strict publication input and review

The existing `POST /v1/community/posts` accepts category `trading` with a required
`trading` object. Other categories must omit it. Trading requires `authorMode:named`,
a regional space, and absent/`none` component; polls, groups and links cannot be
combined with it. General independent phone/student/category/region authorization
still applies, including explicitly configured unverified-category exceptions.

```
trading: {
  subtype: "qiugou"|"shuma"|"shujia"|"yifu"|"meizhuang"|"yundong"|
    "riyong"|"shipin"|"kaquan"|"xiangbao"|"zixingche"|"diandongche"|"xianshiqi",
  price: string,
  urgency?: "normal"|"urgent",
  location: string,
  contacts: {wechat:string,qq:string,phone:string}
}
```

These thirteen keys preserve the original wanted, digital, books, clothing,
beauty, sports, daily necessities, food, vouchers/cards, bags, bicycle, electric
bicycle and monitor categories. Ordinary sale defaults to urgent; wanted
(`qiugou`) always canonicalizes to normal, including explicit urgent input.

Price must be plain ASCII decimal text, positive and at most 99,999 yuan. JSON
numbers, exponent notation, signs, spaces, currency suffixes and trailing decimal
points reject. The 100-character ASCII envelope follows the source server's
100-byte raw-price field; it is not a two-decimal constraint. Redundant leading
integer zeros and trailing fractional zeros normalize exactly. All significant
fractional digits survive in a string/scale-free PostgreSQL NUMERIC; no binary
float conversion, cents coercion or rounding is used. Zero/free-price writes
remain unsupported. Price canonicalization occurs before intent hashing.

Location is required, nonblank and at most 200 UTF-8 bytes. Contacts have exactly
three string keys, at most 50 UTF-8 bytes each, with at least one nonblank value.
Empty unused values are allowed. These byte ceilings preserve the original
server field envelopes while rejecting overlong input instead of byte-truncating
Unicode. The old native manual-location control used ten characters; it did not
establish a server-wide ten-character historical limit. Text retains whitespace
and normalizes only CRLF, with the existing strict Unicode/control checks.
Contacts are explicitly chosen listing disclosures, not a verification claim.
No profile, verified-phone or private identity contact is copied into them.

Normalized trading metadata and all contact values join the publication intent
hash. Version-4 structured review receives that full hash and the complete
trading object; body-only approval cannot approve or mutate a listing's contact,
location, subtype, amount or distribution choice. A listing, post, existing
publication receipt, media references and `post_created` outbox obligation commit
atomically. Existing no-trading publication hashes remain unchanged.

### Contact-free projections, contacts and historical preservation

Every `PostView` gains `trading:null|TradingView`. Non-trading posts return null.
The contact-free trading projection is:

```
{
  subtype: {kind:"known",key:<subtype>,legacyText:string|null}
    | {kind:"legacy",text:string},
  price: {kind:"exact",amount:string,legacyText:string|null}
    | {kind:"legacy",text:string},
  urgency: "normal"|"urgent",
  location: string,
  resolution: "open"|"resolved",
  viewer: {canSetResolution:boolean}
}
```

Current writes produce known subtype/exact canonical amount with null legacy
text. A historical amount that cannot be parsed unambiguously has only a legacy
text projection. Raw price and subtype text are independently retained even
when an exact/known value also exists. Unknown historical subtype remains a
legacy display string, never silently mapped to a current category. Historical
location/contact strings are preserved without current-write length truncation.
These read-only shapes are tested with synthetic historical rows; they do not
constitute an importer or evidence of a production schema. Native rendering uses
plain text and a bounded read envelope, never interprets raw price as a number.

`GET /v1/community/posts/:postId/trading/contacts` requires an active session and
the identical visible, active parent gate as detail, plus a currently `open`
listing. It returns exactly `{postId,contacts:{wechat,qq,phone}}`.
Resolved listings, including owner reads, return generic HTTP 404
`POST_NOT_FOUND`, as do hidden/deleted/blocked/inactive or non-trading parents.
All three fields are suppressed together, including arbitrary or empty historical
values. This is disclosure suppression, not contact erasure. No phone, student or
identity-campus proof is added to the existing authenticated read gate. Unknown
canonical dependencies still fail closed; responses and errors remain `no-store`.
No feed, ordinary post detail, own
recovery list, resolution receipt, public author projection, generic event or log
contains these contact values. A contact-copy action must recheck this endpoint;
a previously revealed contact is not a grant after visibility/session changes.
Publicly selected listing contacts remain distinct from private account data.

The contact transaction retains the policy/session, parent then listing shared
lock order and final canonical policy-deadline checks. A read ordered after a
committed resolve cannot return contacts; a read ordered before it can be
authorized at that time. Already returned or copied values cannot be recalled.
A new reopen intent restores only eligibility for a fresh contact read under all
current policy checks; it never restores an unavailable parent or bypasses a block.

Native resolved/unavailable projections disable reveal and copy. Beginning a
resolution or recovering an uncertain result synchronously clears contacts and
invalidates pending reads/copies. Unknown outcomes retain the original journal
and keep contact access disabled. Only a successful current post read begun after
the latest mutation/recovery barrier can re-enable an open listing; old callbacks,
unrelated likes/replies renders and historical receipts cannot do so. Re-enabling
does not restore contact values: another authorized GET is required. A denied
contact check, cancellation, account/login replacement and page/app hide clear
private state. A clipboard call already handed to the platform cannot be undone;
late network results must not initiate a new clipboard call.

### Distribution and owner listings

- Existing feed accepts `tradingSubtype` only together with `category=trading`;
  the cursor binds it in addition to region, category and page size
- Explicit trading feed includes normal and urgent listings, within the selected
  operating region. A general uncategorized feed excludes urgent listings;
  ordinary sale remains eligible for general regional exposure
- Urgency is a distribution choice. Fast-trade/general-group external delivery
  remains unavailable; storing an outbox obligation is not successful delivery
- `GET /v1/me/community/trading?limit=10&cursor=<optional>&tradingSubtype=<optional>`
  returns `{items:PostView[],nextCursor}` for the active account's visible listings
  across active own scopes. It includes urgent listings, uses the same parent
  safety and visibility gates, and never returns contact values. Hidden, deleted,
  blocked and inactive-scope rows are skipped; safety-adapter failure fails closed
- Minimal existing `GET /v1/me/community/posts` recovery keeps urgency independent
  from `published|hidden|deleted`; urgent is not deletion
- Other users' public-profile trading lists remain deferred until the owning
  public-profile/privacy facade enforces hidden-profile-post and other visibility
  preferences. A public profile UUID alone is not that authorization

### Durable resolution and independent state

`POST /v1/community/posts/:postId/trading/resolution` accepts exactly
`{clientRequestId:<UUIDv4>,resolution:"open"|"resolved"}` and returns HTTP 201:

- Applied: `{requestId,operation:"set_trading_resolution",outcome:"applied",resourceId,resolution}`
- Rejected: `{requestId,operation:"set_trading_resolution",outcome:"rejected",code}`

`GET /v1/me/community/trading-requests/:requestId` recovers the same immutable
receipt (200), scoped to its active original account. Requests use a dedicated
account+UUID namespace. Equal-key/equal-intent replay returns the original receipt
before current parent or action eligibility; changed intent is `REQUEST_CONFLICT`.
A resolve → reopen → old-resolve replay never re-resolves the listing. This is a
receipt of the earlier intent, not a snapshot of current state. Clients refresh
detail after settlement and never overwrite newer state using an old receipt.

Only the true owner can mutate in this slice. Phone proof and the independent
`resolve_trading` restriction are rechecked under lock; student publication
permission is not reused as a status gate. A generic `canManage` flag cannot
mutate another account's listing. Scoped manager status remains a separate live
authorization/audit gate, not an invented grant.

Resolution changes neither urgency nor stored chosen contacts, amount, category,
visibility or deletion. A resolved listing remains readable in detail and own
history but discloses no contacts, even to its owner. Parent then listing locks serialize resolution with
safety changes and deletion. Only real transitions create a minimal
`trading_resolution_changed` internal event, with no contact/body data or external
delivery claim. Receipt, status and event commit atomically. Terminal codes are
`POST_NOT_FOUND`, `COMMUNITY_SCOPE_UNAVAILABLE`, `PHONE_VERIFICATION_REQUIRED` and
`COMMUNITY_ACTION_RESTRICTED`; unavailable dependencies, invalid auth/input and
transaction failures never leave a terminal receipt.

`trading-contacts-runtime.test.ts` exercises normal AppModule, canonical synthetic
owner records, real PostgreSQL lock ordering and native gateway decoding without
application provider overrides. Regressions cover resolve/reopen/replay, bilateral
blocks, deletion/hidden/approval/scope loss, current deadlines and late native
results. Separate historical projection fixtures cover lossless arbitrary and
empty contacts. Native controller tests and emitted-page smoke cover immediate
clearing, unknown-result recovery, read-start generation and lifecycle races.
These checks do not establish production data migration or physical-device QA.

Migration `0010` only adds empty storage and forward constraints. A deferred
shape guard rejects missing trading children, nonregional/anonymous parents and
poll coexistence. Listing metadata and approved trading parent ownership/scope/body
are immutable; separate visibility/deletion and resolution state remain mutable.
Terminal request receipts cannot change or disappear, and a pending reservation
cannot commit. Earlier migrations are unchanged. Any eventual import still needs
complete schema evidence, actor/region crosswalks, raw urgency/deletion provenance
and reviewed reconciliation; urgent legacy flags must never be interpreted as
deleted. Student-number backfill and new institutional SSO remain deferred.

## C2D post group formation development slice

Formation is a component of a non-trading post, separate from organization/group
directories and group chat. The normal post body remains required. A single
component is absent/`none`, `poll`, or `formation`; trading cannot attach one.
Internal links remain a separate unfinished slice. This development flow does not
activate real safety, approval, media or provider adapters.

### Composition and explicit disclosure

A formation component is:

```json
{
  "kind": "formation",
  "capacity": 4,
  "theme": "周末爬山",
  "contacts": { "wechat": "chosen-contact", "qq": "", "phone": "" },
  "contactSharing": "members_v1"
}
```

Capacity is an integer from 1 through 20. Theme is trimmed, nonblank and at most
12 Unicode codepoints. Creator and joiner contacts use the same source ceilings:
WeChat 100, QQ 50 and phone 20 UTF-8 **bytes**. New writes trim the supplied fields,
require at least one nonblank value, reject unsafe Unicode/control characters,
and reject overlong values without byte truncation. These differ from trading's
contact bounds. Contact values are freely supplied text, not verified phone proof.

The native composer/join dialog must explicitly obtain `members_v1` consent:
only the contacts the user supplies will be shared with current authorized
members. Joining is permanent in this slice. Named joiners use their public
profile display. Anonymous creators keep the parent post's thread persona in the
public roster, but their chosen contact data can identify them to authorized
members. Never promise complete anonymity, prefill verified/profile phone or
student information, or infer consent from an old source row. Changing submitted
contacts requires a different intent and cannot edit a committed membership.

Post, formation definition, creator membership, publication receipt and existing
post-created outbox obligation commit atomically. The creator occupies seat 1;
capacity 1 is immediately full. Structured content approval version 5 binds the
entire publication intent, including theme, capacity, chosen contacts and consent.
C1 absent/explicit-none and earlier poll/trading intent hashes remain unchanged.
Generic publication receipts and events contain no formation contacts.

### Read, join and recovery contracts

All routes are under `/v1` and use the current bearer token; public feed projection
can still use the existing guest-first-page policy. Unknown query/body keys are
rejected on formation routes.

- `GET community/posts/:postId/formation` returns the same formation object used
  by `post.component = {kind:"formation",formation}`
- `POST community/posts/:postId/formation/memberships` accepts only
  `{clientRequestId,contacts,contactSharing:"members_v1"}`
- `GET community/posts/:postId/formation/contacts` returns
  `{postId,members:[{membershipId,contacts:{wechat,qq,phone}}]}`
- `GET me/community/formation-requests/:requestId` recovers the original
  account's immutable join receipt
- `GET me/community/formation-memberships/:postId` returns only
  `{postId,membershipId,joinedAt,isCreator}` for the active original account

Formation read fields are `id`, `postId`, `capacity`, `theme`, `status`
(`open|full|unavailable`), `memberCount`, `members`, and `viewer`. A public member
contains only `{id,author,isCreator,joinedAt,viewer:{isSelf}}`; `author` is the
existing safe named public-profile or anonymous thread-persona DTO. Membership IDs
are independently generated UUIDs, never actor IDs. The creator is first, then
joiners by recorded time with a stable seat tie-breaker. Named members hidden by
current member safety/block policy are omitted from roster and contact lists;
`memberCount` still reflects every occupied seat, including filtered members.
There is no public account identifier or embedded contact field.

`viewer` is `{isMember,isCreator,canJoin,reason,canReadContacts}`. These are advisory
server-owned booleans, not grants. New joins require current active session,
authoritative phone proof, the independent `join_formation` action, a visible
active parent/scope, an available definition, capacity, and no prior membership.
There is no additional student-verification or identity-campus requirement.
Creator publication retains the ordinary publication rules.

A join receipt is minimal:

```json
{
  "requestId": "00000000-0000-4000-8000-000000000001",
  "operation": "join_formation",
  "outcome": "created",
  "resourceId": "00000000-0000-4000-8000-000000000002",
  "createdAt": "2026-10-07T00:00:00.000Z"
}
```

A terminal rejection instead has `outcome:"rejected"` and `code`. Equal key and
canonical intent replays the stored result before current parent permissions;
equal key with changed contacts/consent/parent conflicts. A new key cannot defeat
one membership per formation/account or overwrite contacts. Terminal codes are
`POST_NOT_FOUND`, `FORMATION_NOT_FOUND`, `FORMATION_FULL`,
`FORMATION_ALREADY_JOINED`, `FORMATION_UNAVAILABLE`,
`PHONE_VERIFICATION_REQUIRED`, `COMMUNITY_ACTION_RESTRICTED`, and
`COMMUNITY_SCOPE_UNAVAILABLE`. Temporary unavailable adapters and infrastructure
failures roll back without manufacturing a terminal decision. Owner recovery
survives parent hiding/deletion and permission loss but always requires an active
original-account session. Neither a missing receipt nor a timeout proves that an
in-flight request cannot still commit.

### Contacts and transaction privacy

Contacts are separately loaded only for a current member whose own membership
is visible and who passes active parent/scope visibility, authoritative phone proof, the independent
`read_formation_contacts` action, current per-member visibility and recorded
sharing consent. Unjoined readers receive `FORMATION_MEMBERSHIP_REQUIRED`;
missing own recovery is `FORMATION_MEMBERSHIP_NOT_FOUND`. Hidden/deleted/blocked
parents use generic `POST_NOT_FOUND`. Contact lists may be empty after visibility
or historical-consent filtering. No viewer/profile/verification facts are used as
fallback contact values.

Responses have `Cache-Control: no-store`. Native code fetches contacts afresh on
open/copy, keeps them only in a short-lived display lease, and clears them on
close/navigation/account transition. This cannot revoke text already copied by a
person. Membership never becomes a standing bypass around safety/privacy gates.
After potentially blocking authority and visibility work, the service rechecks
the presented token at the current database clock before returning private data.
Authority and visibility ports must lock local authoritative facts until commit;
no provider/network call is allowed under these locks.

Lock order is active account/session, account-owned request, parent, scope and
local authority/visibility, then formation. Parent/formation locking serializes
joins with capacity and parent removal. Migration `0011` also enforces creator
ownership/seat, same-transaction parent/definition/creator publication, unique
formation+account and formation+seat, maximum capacity, component exclusivity,
immutable membership/contact/definition and approved image attachments, and immutable formation-parent facts
except independent safety visibility/deletion. Receipt rows cannot commit while
pending, cannot be overwritten, and permit only typed minimal terminal fields.
A join, receipt and minimal `formation_member_joined` internal transition commit
atomically. This transition contains no contacts and does not invent a reward,
notification or provider-delivery promise.

### Historical and release boundaries

No production import runs in this migration. Future authorized import must keep
original parent/capacity/theme/count/status, membership IDs/actors/creator flags,
display snapshots, contact fields and timestamps privately with crosswalks and
provenance. Canonical rows support private `legacy_raw` metadata and an immutable
`unreconciled` marker; irregular source rows that cannot satisfy canonical
capacity/unique-creator invariants require a separate raw staging/reconciliation
process, not deletion or guessed repairs. Unknown status never becomes an
invented close/expiry operation. Historical consent is `legacy_unconfirmed`
unless explicit evidence supports the current sharing contract.

Read validation is separate from new-write limits: safely encoded reconciled
historical themes/consented contacts remain verbatim, including raw spacing and
CRLF. The safety envelope is 1 MiB per field and per private contact response,
with unsafe Unicode/control data withheld and raw provenance preserved. A blank
or unsafe theme projects a neutral unavailable label and denies joins/contact
reads using the same eligibility predicate. Unreconciled definitions never grant
join/contact capability. Historical-unconfirmed contacts are not exposed. This
is a safe schema/read boundary, not a completed import or reconciliation claim.

There are no leave, kick, contact-edit, transfer, creator-close/reopen or scheduled
expiry operations. Live authority and accepted text visibility remain fail-closed
on missing facts; media and review issuance remain unavailable. Normal runtime
acceptance now covers reviewed formation definitions, membership and contacts.
PostgreSQL tests cover
last-seat/duplicate-key races, hidden/deleted/inactive parent, block and permission
races, rollback, owner recovery, immutable database constraints, safe historical
reads and final-token expiry. Device acceptance and all remaining full-parity
work remain explicit release gates.

The existing developer-only audited identity API also accepts
`{kind:"formation_member",id:<membership UUID>}` for visible roster members.
The server resolves the actual stored membership and parent, then reapplies
parent/member visibility. A client cannot attach an arbitrary account or replace
the parent context. Named and anonymous identity disclosure uses the existing
separate privilege/audit DTO and unchanged final-clock safeguards. It never adds
identity fields to the ordinary roster and does not grant formation-contact
access. No developer role grants are seeded outside synthetic tests.

## C2E Saved posts and per-post preferences, increment 1

This increment implements account-owned saving and two independent preference
bits. Save transitions do not deliver notices, settle experience or apply ranking
changes. The separate [C2E local Updates increment](API_UPDATES.md) now materializes
root/reply notices with exact read state; external delivery remains unavailable. All existing
publication/ballot/discussion/trading/formation receipt bytes and intent hashes
remain unchanged. No real provider, production data, paid API, role grant, student
number import or institutional authentication is activated.

### Strict HTTP and projection contracts

All routes require the current bearer session, reject unrecognized query/body
keys and derive the owner from that session. Every mutation below returns HTTP
200 with a terminal receipt; validation and unavailable infrastructure use the
existing error envelope. Prefix all paths below with `/v1`.

- `PUT community/posts/:postId/save` and `DELETE community/posts/:postId/save`
  accept exactly `{clientRequestId}` and set the desired saved state
- `GET me/community/saved?cursor&limit` accepts a decimal limit from 1 to 50,
  default 20, and returns `{items:[{post,savedAt,saveEpochId}],nextCursor,visibleSavedCount}`
- `POST me/community/saved/status` accepts `{postIds}` with 1–100 distinct UUIDs,
  rejecting case-insensitive duplicates before queries. It returns HTTP 200
  `{items}` in request order. An unavailable or nonexistent target is only
  `{postId,status:"unavailable"}`; an accessible target is
  `{postId,status:"available",saveCount,isSaved,savedAt,saveEpochId,preferences}`
- `GET community/posts/:postId/update-preferences` returns the preferences DTO
- `PUT community/posts/:postId/update-preferences` accepts only
  `{clientRequestId,channel:"saved"|"external",enabled:boolean}`
- `GET me/community/saved-requests/:requestId` recovers the original account's
  immutable terminal receipt without returning live parent data

Canonical post projections now include `saveCount` and three additional viewer
booleans: `isSaved`, `canSave`, `canSetUpdatePreference`. Aggregate save count is
all active account/post relations, including self-saves and bookmark-only saves.
There is no saver roster, account ID or contact expansion. Saved items reuse the
canonical poll/trading/formation post serializer. Urgent and resolved trades
remain saveable/readable under the normal parent policy; urgency never means
hidden/deleted. Existing root/reply/discussion counts retain their meanings.

The preferences DTO is exactly
`{postId,savedUpdatesEnabled,externalUpdatesEnabled,revision,canSetPreference,reason,inAppCapability,inAppProcessing,externalCapability}`.
`revision` is a nonnegative decimal string, initially `"0"`, and advances only
when a bit really changes. `canSetPreference` is advisory and its `reason` is
null, `COMMUNITY_UNAVAILABLE`, `PHONE_VERIFICATION_REQUIRED`, or
`COMMUNITY_ACTION_RESTRICTED`. `inAppCapability` is `"local"`, while
`inAppProcessing` is configured `"disabled"|"manual_only"|"automatic"` (default
`"manual_only"`). These describe implementation/configuration, not a particular
delivery. `externalCapability` stays `"unavailable"`. Preferences are exposed in their own endpoint and batch DTO,
not silently added to unrelated post viewer fields.

Absent preferences logically default to both enabled. The `saved` channel
changes only `savedUpdatesEnabled`; the `external` channel changes only
`externalUpdatesEnabled`. An unsaved post, including the viewer's own post, can
have either setting. Unsave/re-save never deletes or resets them. A no-op does
not rewrite revision or per-channel change times. Both-default rows and their
history are retained once any real change has occurred.

The intended future delivery policy remains:

- Saved updates disabled means bookmark-only for the saved-recipient branch of
  in-app and external notices; direct comments/replies remain independent
- External updates disabled suppresses this post's direct and saved external
  notices, without muting direct or saved in-app notices
- Enabled preferences record intent. They never grant provider consent, quota,
  device permission or account enrollment
- Reminder-banner visibility is a separate invitation-display setting. This
  increment does not alter it, other categories, template settings or devices

### Current access and explicit owner cleanup

Ordinary save/unsave uses the independent `save_post` action. Ordinary preference
changes use `set_post_update_preference`. Both require active account/session,
authoritative phone proof, current action restrictions and current parent/scope
visibility. Neither reuses publication-category, student verification,
identity-campus, comments-open or formation membership rules. The real safety
wrapper and canonical runtime adapters are used in the new no-override local
acceptance; isolated injected ports remain only in earlier focused suites.

Read/list/batch/preferences use the established authenticated post-read policy:
current active parent/scope and named/anonymous visibility policy. Phone proof
is not newly required merely to read the first or later Saved pages. Active
regional and global scopes use their ordinary policies; a selected browsing
campus is not a Saved filter and cannot remove relationships. Anonymous visibility
checks never receive a private named-account selector.

Two separately routed reduction-only operations support cleanup after access
loss. They accept only `{clientRequestId}` and return the same minimal receipt:

- `DELETE me/community/saved/:postId` removes only the active session owner's
  relation. A missing relation/parent is an applied no-op, revealing no existence
- `DELETE me/community/post-update-preferences/:postId/:channel` disables only
  one channel of an already persisted own preference row. Absent own state is a
  generic terminal `POST_NOT_FOUND`, even if a parent exists

These explicit cleanup routes require an active original-account session and
bypass phone/action/parent-visibility gates solely to reduce that account's
existing state. They cannot enable, save, change another owner or return hidden
parent previews, counts, personas or permissions. Ordinary native controls use
the ordinary gated routes; cleanup is not a silent fallback around restrictions.
Previously terminal rejection still replays unchanged; a new cleanup intent
requires a new key. Recovery also remains available after parent deletion,
phone/scope loss or restrictions, but not after token/session/account revocation.
Presented-token validity is rechecked after potentially blocking work and before
commit/response.

### Receipts and opposite-intent recovery

A dedicated saved request ledger is separate from publication requests. Both
applied and rejected receipts include the same exact frozen intent identity:

```json
{
  "requestId": "00000000-0000-4000-8000-000000000001",
  "operation": "set_post_saved",
  "postId": "00000000-0000-4000-8000-000000000002",
  "desired": true,
  "channel": null,
  "outcome": "applied"
}
```

Preference operation is `set_post_update_preference`, with channel `saved` or
`external` and desired equal to the intended Boolean. A rejected result adds
only `code`, one of `POST_NOT_FOUND`, `COMMUNITY_SCOPE_UNAVAILABLE`,
`PHONE_VERIFICATION_REQUIRED`, `COMMUNITY_ACTION_RESTRICTED`. Temporary unavailable
adapters/infrastructure roll back with no committed terminal request. Receipts
never contain live count/epoch/settings, actors, contacts or delivery claims.

Equal account/key/canonical intent returns the original immutable receipt.
Changing the post, operation, channel or desired value under the same key is
`REQUEST_CONFLICT`. A receipt row cannot commit while pending. A no-op stores a
receipt without a new epoch, history transition, outbox event or obligation.
After save-A and unsave-B settle, replaying A can only return A's receipt; it
cannot restore the relation or overwrite B. Preferences obey the same rule.
Different devices serialize by database arrival, not by guessed gesture time.

Clients must persist a frozen account-owned intent before dispatch and settle it
before sending an opposite intent. Timeout, cancellation, malformed response,
page dismissal and `REQUEST_NOT_FOUND` are uncertain, not evidence of rollback.
Receipt settlement is followed by a fresh authorized live read. Stale account,
authentication, navigation and list responses cannot overwrite a newer choice.
Native implementation uses one unresolved saved/preference intent per account
for conservative cross-channel ordering, independently of publication journals.

### Pagination, epochs and future event eligibility

Saved order is `(savedAt DESC,saveEpochId DESC)`. A no-op save retains both values;
a genuine unsave/re-save closes the old epoch and creates a new UUID epoch/time.
Inactive current state has null `savedAt`/`saveEpochId` while history is retained.
The cursor contains the last visible saved epoch/time, bounded limit and an opaque
purpose-bound digest of the viewer identity. It contains no raw account ID or
hidden post ID. Digest binding is not authentication or a visibility grant;
every call independently reauthorizes.

For the injectable policy adapter, list/count collect at most 1024 active candidate
relations, then acquire parent-first locks and filter through the same current
read policy. `visibleSavedCount`, `items` and `nextCursor` all use that one filtered
candidate set. The count describes the current filtered candidate set for this
response, not a transaction-wide or cross-request frozen snapshot. More than
1024 candidates returns `COMMUNITY_UNAVAILABLE` rather than an unfiltered total.
Concurrent additions may appear on refresh; re-save can move an item before a
previous cursor. Native deduplication is by post ID within the loaded window.
Hidden/deleted/inactive/blocked rows do not leak IDs, counts or cursor anchors.
A completely filtered set returns an empty page, zero total and no cursor.

Migration `0012` adds current relations, immutable start/end epoch history,
persistent preference snapshots/history, immutable desired-state receipts and
pending obligations. It does not change earlier migration files. Current/active
epoch consistency, independent preference snapshot/history consistency, unique
active membership and immutable terminal request identity are enforced in
PostgreSQL as well as service code. Obligation identity/payload is retained;
future consumers may update its separate outcome without changing its target.

Save starts/ends and preference changes obtain the shared discussion sequence
only after locking the parent. New root/reply inserts also acquire this parent
lock before allocating their authoritative order; existing root/reply sequences
and old receipts are unchanged. This disambiguates equal wall-clock timestamps.
The [local Updates consumer](API_UPDATES.md) requires a saved epoch covering the
root event order and the same still-active epoch at materialization, then checks
current visibility/accounts/preferences. Unsave/re-save and mute/re-enable cannot
qualify old events. Historical imports cannot invent absent epoch history;
processed suppression is terminal and never backfilled.

### Durable obligations and retained release work

Only an actual save transition adds a saver reward obligation and a distinct
nonself author reward obligation, plus author-interaction/ranking contributions.
Self-save creates no second author reward or notice. Unsave records the inverse
interaction/ranking contribution without reward reversal/refund. Each obligation
has a unique epoch/transition/action/recipient key and starts `pending`; receipt,
relationship/history, obligations and minimal internal outbox event commit in
one transaction. Preference changes, no-ops, reads and retries generate no reward
obligations. No code marks a reward paid or an update delivered. Save transitions
do not invent a “someone saved you” notification.

The experience domain still owns amounts, shared caps, accounting day, grant
receipts and settlement. Reward/ranking and external delivery consumers remain
pending. [Local Updates](API_UPDATES.md) now implements direct/saved recipient
dedupe, exact owner unread/read rows, current safe previews, typed root/reply
anchors and crash-safe materialization. Replies, poll ballots, formation joins and trading
resolution do not gain new saved-recipient fan-out here. External capability stays
unavailable until separately implemented consent/quota/mapping/current-access
and ambiguous-send recovery gates have been verified. Stored unavailable work
must not be automatically drained when a provider is eventually activated.

Production import is separate and unauthorized here. It must preserve private
relation/preference/raw timestamps, source timezone/provenance, duplicates/orphans,
independent urgency/resolution/deletion, notification/read history and unknown
delivery/consent/reward outcomes for explicit reconciliation. Do not replay
historic rewards/notices or fabricate missing epochs. Full parity, actual device
acceptance and real provider verification remain outstanding.

## Explicit-space search

The partial `GET /v1/community/search` endpoint and native page use the existing
PostView and current visibility authorities. Query-only outer whitespace trimming
is intentional; stored post text remains untouched. See [search contract and
limits](COMMUNITY_SEARCH.md) for matching, filters, continuation and remaining
parity work.

Search also accepts `scope=all|regional|global` instead of `spaceId`. Only regional
aggregate requests accept category/subtype filters; all/global reject them.
Aggregate scope is revalidated from complete owner-held catalog facts and changes
restart navigation. See [federated contract](COMMUNITY_SEARCH.md#federated-allregionalglobal-search-increment).

## Explicit bounded view reporting

Authenticated `POST /v1/me/community/view-reporting-epoch` and
`POST /v1/me/community/view-reports` record eligible fresh-post feed/detail events
with immutable bounded recovery. They require no phone/student gate. Existing GET
reads and PostView fields are unchanged. See [contracts and retention](VIEW_REPORTING.md).

## Unified hot discovery

The optional-auth `GET /v1/community/hot` reads one explicit current space with
six publication-age ranges, current unified score certificates and final viewer
visibility. Live opaque pagination exposes no score or stable numerical rank.
Default processing is disabled; coherent explicit processing settings are required
for a maintained board. See [operational scope](unified-public-hot-feed.md) and
[generated contract](openapi/community-hot.json).
