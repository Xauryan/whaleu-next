# Specialist course comments, C2

This bounded local-development slice extends the existing Next course detail
with author-undisclosed text comments and irreversible one-way likes. It preserves
the separate C1 three-axis first-lifetime scoring contract and generic Ratings'
integer 1–5 contract. It is not whole-Next completion, a real catalog/history
migration, production acceptance or proof of registered legacy native pages.

## Fixed executable source

[Classcomment.php at 57cf169c](https://github.com/WhaleUCampus/WhaleU/blob/57cf169c11123acf249909a1a7215b8cb1ec1f8e/treehole/app/controller/Classcomment.php)
provides the three relevant handlers:

- Lines 16–68 list by course, likes or time, bounded page size 1–50. Each row
  exposes only ID, content, like count and creation time.
- Lines 73–136 publish nonempty text after token actor/base permission and course
  existence checks. Multiple distinct comments from one actor/course are allowed.
- Lines 141–223 add one membership and increment likes in one transaction. A
  repeated like is rejected. There is no unlike, toggle or self-like prohibition.

The executable source accepts client `user_id` for stored authors and identity
parameters for likes. These bypasses are not compatibility requirements. New
native rows privately retain the authenticated actor. Historical raw `user_id`
cannot prove ownership, establish profiles or grant any author rights.

`PermissionHelper::hasBasePermission` and `PermissionService::BASE_PERMISSIONS`
accept verified/temporary-verified or actual administrator status. There is no
matching-course-school, student-number or browsing-campus gate. Reads and likes
do not inherit publication's base gate. Next requires current Identity session,
phone Verification and Safety for each fresh read/write, closing the legacy
middleware's absent/invalid-token fail-open behavior.

There is no source evidence for course-comment replies, deletion, reports,
administration, images, personas, rewards or notifications. No such feature or
side effect is added. Public omission of author fields is described as
“author-undisclosed,” not a stronger guarantee of anonymity. No public actor,
avatar, profile, stable pseudonym, author mode, isMine or isLiked is emitted.

## Explicit Next additions

- The text policy accepts nonblank well-formed Unicode, excludes NUL, and limits
  the exact body to 8,000 UTF-8 bytes. This bounds even worst-case escaped input
  below the existing HTTP 64 KiB body limit. It is a new Next limit, not a
  recovered legacy maximum. Accepted whitespace/text is never silently trimmed,
  normalized or rewritten. String `0` is valid rather than reproducing PHP empty.
- Review is deliberate Next hardening; the legacy course controller has no
  content-review invocation. A distinct `course.comment.publish.v1` purpose in
  the existing Review owner binds actor, original request, course, catalog and
  course revision, and exact body. No fake generic target/category or persona is
  created. Allow, reject, unavailable, revocation, consumption and visibility
  deadlines stay distinct. There is no production issuer/provider or approval API.
- Time ties use stable descending public IDs; likes order is count DESC, time
  DESC, ID DESC. Opaque continuations bind actor, session, query, course, source,
  separate history, phone/Safety, comment/like epoch and Review epoch. A changed
  ordering or current proof requires restart. Whole-ranking deadlines include
  off-page Review visibility, rather than validating only displayed rows.
- Pending intent is frozen before transport. Original account/origin/key/payload
  survive response loss and restart. Explicit cancellation is a durable same-key
  server fence, serialized against publication/like; missing receipts alone do
  not authorize discarding uncertainty or minting a replacement key.

## Independent coverage and production boundary

Migration 0113 creates empty comment, lifetime-like, original-command,
comment-population/like-history and Review storage. No catalog, historical
membership, real source, provider, policy or approval is seeded. Only tests accept
explicit synthetic known-empty population and separate like-history baselines.
C1 score history proves neither of those facts. Unknown, absent or expired
coverage remains unavailable, never zero likes, no comments or not-liked.

Current publication eligibility composes Verification affiliation or separately
accepted temporary-base facts and Authorization's real school_admin/super_admin
grants. A developer-only grant is not rebranded as a legacy administrator.
Existing authenticated phone, Safety and accepted Campus/catalog proofs remain
required; none grants access from a user's chosen browsing campus.

Real nonempty import needs authoritative DDL/export, source comment identity,
timestamps, like counts/membership reconciliation, account crosswalk and
provenance policy for untrusted legacy author IDs. None is supplied or inferred.
There is no import activation endpoint, seed source or production deployment.

## Typed API

All endpoints are under `/v1/ratings/courses`, bearer-authenticated, strictly
validated, account-throttled, `Cache-Control: no-store`, `Vary: Authorization`:

- `GET /:id/comments`: sort likes/time, limit 1–50, optional opaque cursor.
  Returns current catalog/course/comment revisions, four-field public comments
  and continuation; there is no fabricated total or own-like state.
- `POST /:id/comments`: original clientRequestId, expected catalog/course
  revisions and exact body. Publish has its own typed receipt.
- `POST /:id/comments/:commentId/like`: original clientRequestId and expected
  catalog/course revisions. One lifetime membership. A new repeated key gets a
  durable `COURSE_COMMENT_ALREADY_LIKED` rejection without another increment.
- `GET /comment-requests/:requestId`: current actor's immutable original receipt.
- `POST /comment-requests/:requestId/cancel`: discriminated operation/course,
  original command and like target if applicable. Existing original result wins;
  otherwise a durable `COURSE_COMMENT_CANCELLED` receipt prevents delayed writes.

Receipt lookup, exact replay and cancellation require the current actor's session
but remain recoverable after source withdrawal or later phone/base/Safety loss.
Receipts carry minimal IDs/outcome/time; they do not disclose the public body or
confer current visibility. Changed intent under an old key conflicts. Source,
history or Review uncertainty never becomes a fabricated terminal rejection.

## Durable constraints and exact current proofs

Comments, like memberships, original commands and Review bindings are immutable.
Like count is derived from exact membership, not a separately mutable counter.
Per-request and per-actor/comment locks serialize original results. Causal SQL
constraints and command-statement guards require matching mutation, intent hash,
exact Review binding, current source/history/eligibility and typed receipt in the
same transaction. Raw SQL cannot create a success or false rejection without its
cause; unsupported isolation and incomplete pairs fail closed.

Owner SQL interfaces evaluate source, history, session, Verification, Safety,
actual administrator and Review times with PostgreSQL clocks. SQL statement and
deferred guards enforce current authority at their own execution points and
causal mutation/receipt integrity. They are not a PostgreSQL commit-time hook: an
arbitrary raw transaction that flushes constraints and then does more work must
not be represented as having the API final-clock guarantee.

For supported API writers, the shared Database transaction wrapper flushes all
deferred constraint waits before mandatory current-owner proofs. Fixed complete
NOWAIT table fences and monotonic owner epochs protect those final proofs. PostgreSQL timestamp text carries exact microseconds into the
shared final-deadline check; JavaScript Date truncation is not an authority check.
A failed final proof rolls back both tentative mutation and receipt. Conservatively
unavailable results are acceptable during conflicting writers; stale success is not.

## Local verification boundary

Focused suites cover strict HTTP/public codecs, exact-review binding, independent
coverage, repeated publications, concurrent one-winner permanent likes, source and
eligibility loss, same-key recovery/cancellation, whole-ranking continuations,
revocation/expiry and SQL immutability. Actual emitted App/Page/WXML journeys use
production gateways against loopback AppModule and controlled PostgreSQL 18.6;
only native platform callbacks/transport and explicit source/Review fixture facts
are synthetic. C1 and generic Ratings regressions remain required. Final freeze
records identify the tested tree, commands and truthful limits. These tests do not
claim real-provider, physical-device, hosted CI or production history acceptance.
