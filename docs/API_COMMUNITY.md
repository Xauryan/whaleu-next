# Community C1 + C2A + C2B API and safety boundary

C1, C2A polls and C2B discussion are **partial development slices**, not production-ready community parity.
It implements explicit operating-region mapping, chronological regional/global
feeds, detail, text publication, thread-local anonymous personas, root comments,
desired-state post likes, own deletion, durable publication recovery, poll composition/reads and immutable
ballots with owner-only recovery, flat replies, discussion ordering/context,
author root pins and recoverable discussion reactions. Normal
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
only. Unsupported trading/group/link modes reject unknown fields. C2A polls use
the strict discriminated component described below.

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
`{id,space:{id,kind,name},category,text,images,author,publishedAt,likeCount,commentCount,replyCount,discussionCount,viewer:{isSelf,isLiked,canDelete,canComment},commentsPolicy,component}`.
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

Authorization requires authoritative phone proof, current student verification,
identity region, per-action restrictions, explicit unverified category exceptions,
cross-region policy and scoped management permission. Runtime has no adapter for
these facts yet. Phone-unverified actors cannot write/like or continue feeds.
Student-unverified actors can publish named posts in explicitly enabled regional
categories. Root/reply publication instead uses the independent authoritative
regional unverifiedCommentsAllowed switch and requires named identity and a named
parent post; the new-post category allowlist does not govern comments/replies. Global
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

## C2A poll contract

C2A is an end-to-end development slice with synthetic local approval/authority
fixtures. Ordinary runtime safety adapters remain unavailable. It does not add a
provider, student-verification method, institutional SSO, student-number backfill,
production import or physical-device acceptance.

`PostComponent` is absent, `{kind:"none"}`, or
`{kind:"poll",question,selectionMode:"single"|"multiple",options:string[]}`.
Polls supplement required nonblank post text. Publication inherits all C1
category, region, named/anonymous, configured unverified-category and review
rules. Group/link/trading fields remain rejected, including conflicting fields
inside a poll component. New creation accepts no deadline field; deadline is null.

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
fail-closed; synthetic fixtures are injected only by tests. Anonymous subjects
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
- Root cursors bind viewer, parent, sort, direction, limits and a fingerprint of
  the complete visible ordered result. Mutated ordering/counts/visibility or a
  changed typed scope/size returns `409 DISCUSSION_RESTART_REQUIRED`. Refresh must
  discard the old traversal. Malformed cursors return 400. The viewer binding is
  hashed; raw private account identifiers never appear in cursors
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
fields, anonymous DM choices, trading, group formation, linked boards/groups
and ratings, feedback channels, post status workflows.

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
