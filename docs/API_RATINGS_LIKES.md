# Rating likes and root ordering (R2B)

This local development slice adds root/reply desired-state likes, exact current counts, per-transition Experience, once-per-actor/subject local notices, and time/likes root ordering. Existing R1 root, R2A reply and reply-notice DTOs remain unchanged. The [generated contract](openapi/ratings.json) contains 32 operations. Historical import, real review issuance, external providers, subscription fan-out, media and administration remain separate gates.

## Current state and commands

- GET/PUT `/v1/ratings/comments/:id/like`
- GET/PUT `/v1/ratings/replies/:id/like`
- GET `/v1/ratings/like-requests/:id`

State GET accepts only optional regionId and an empty body. Known state contains status, targetId, rootId, replyId (null for a root), count, liked, revision and allowedActions.setLike=true. Uncovered native history returns exactly `{status:'unavailable'}`. Missing membership alone, accepted catalog and score coverage do not establish zero likes. Deleted or denied content is inaccessible; unknown current authority fails closed.

A root PUT requires clientRequestId, regionId, targetId, expectedTargetRevision, expectedRevision, expectedLikeRevision and liked. A reply additionally requires rootId and expectedRootRevision. Actor, author, recipient, points, quota day, count and notice identity are never client inputs. Every command checks target, root, optional reply, scope, phone and current Review/Safety. Quoted reply-to content is not an ancestor of the liked reply.

The membership revision belongs to this actor/subject. Another actor changing count does not invalidate it. All content and membership CAS checks precede noop detection. A true positive transition gets a new incarnation; an unlike refers to that exact incarnation. Inactive membership tombstones remain durable. Current count changes in the same transaction, using exact predecessor count/head and immutable transition evidence.

Successful receipts contain only requestId, operation (set_comment_like or set_reply_like), outcome (applied/noop), targetId, rootId, replyId, liked, revision and exact occurredAt. A rejection contains only requestId, operation, outcome and code. They disclose neither author identity nor current count. The three recovery APIs have closed operation sets but share one account/request namespace.

An existing request with identical canonical intent returns its committed receipt after session recheck. Retrying an old like after a later unlike cannot create a new like. New request keys must pass current authority and CAS. True noops create only a durable request and independently verified actor/subject observation; they do not create membership, transition, count updates, rewards or notices, nor refresh the anchor time.

## Native coverage and SQL integrity

A new like subject is enrolled with its actual native publication transition, same publication transaction, exact Review binding and final applied receipt. One additive activation enrolls older local native publications only when all those sources match. It records the introduction of this domain's writer/storage; it does not claim or import any older external system's likes. Incomplete sources stay unavailable.

SQL owns memberships, transitions, counts, effects, expected beneficiaries and obligations. Initial and subsequent count/actor transitions have unique predecessors/successors; deferred checks require each event to reach the retained head through exact successors. Suppressed intermediate writes, forged sources, missing work and incomplete receipts roll back. Old migrations and old review digests are unchanged.

Deletion changes content accessibility without producing an unlike, decrementing Experience, removing notices or rewriting descendant memberships. Author cumulative received-like inclusion and deletion policy remain undecided and are not projected by this slice.

## Shared Experience and local notices

Each real positive transition captures actor/like_save and, unless self, subject-author/received_like_save. The existing +1/+2 and shared daily limits apply across community, Saved and ratings. Unlike has no deduction or refund. A later genuine re-like creates another independently limited opportunity; request replay and noop do not. Anonymous authors retain private eligibility without exposing their accounts in receipts, journals or public state.

Typed rating v2 sources coexist with strictly preserved community v1 and rating v1 sources. Capture includes exact registry/work tuples. The real worker loads immutable sources before a single beneficiary owner, determines the Shanghai settlement day after locking, and commits records/buckets/balances/work atomically. Unknown beneficiaries block independently. Current deletion or lost display access does not erase previously captured Experience obligations.

Likes use four separate routes so old reply-only clients never receive a new discriminator:

- GET `/v1/me/ratings/like-updates`
- GET `/v1/me/ratings/like-updates/unread-count`
- GET `/v1/me/ratings/like-updates/:noticeId/target`
- PUT `/v1/me/ratings/like-updates/:noticeId/read` with empty body

Each nonself positive event captures an obligation. The lifetime notice key is recipient + named actor + typed root/reply subject. First eligible materialization creates one notice; later events receive an exact existing receipt referencing that notice without changing event, creation time, ordinal or read time. Unlike does not revoke a notice. A suppressed first event does not consume a future eligible notice key; unavailable authority is retryable.

Current notice projection reauthorizes the recipient's entire target/root/subject chain and named liker Profile/Safety. The preview is current subject text, not a stored snapshot. Inaccessible materialized notices have only the generic unavailable shape and retained read state. Target lookup never implicitly marks read. Existing `/updates` routes explicitly filter kind=reply, including counts and owned-ID lookups. Both kinds reuse the same owner and manual, local, loopback-only worker, with at most 50 explicitly supplied events and no external delivery.

## Root ordering and bounded proofs

Root comments GET accepts optional sort=time|likes and order=asc|desc. Omitting both preserves the original cursor path. Explicit ordering uses a separate opaque v2 position; omitted fields within that branch default to time/desc. Time ties use numeric ordinal in the selected direction. Likes ties always use exact creation time descending, then numeric ordinal descending. Root item and page-context shapes are unchanged.

Every target has a source-owned order head and complete projection of all roots, including unknown like coverage. Its missing-live-coverage count changes from exact create/delete/enrollment sources. Likes ordering fails closed when any live root lacks coverage; time ordering remains available. Creation, deletion and root-like transitions advance the causal head, making previous positions restart with DISCOVERY_RESTART_REQUIRED. Review, Safety, navigation, scope, session, sort, order and limit are bound too. Hidden candidate pages return a bounded scan continuation rather than scanning indefinitely to fill a page.

Seek keys normalize directions so SQL uses indexed tuple ranges, with no nullable seek OR, full-history COUNT, membership aggregation or off-page body/author reads. Only the chosen at-most-50 bodies are projected. This bounds returned candidates, body reads and authorization facts, not PostgreSQL physical metadata work. Depending on statistics, data distribution and MVCC, PostgreSQL can use a bitmap scan plus sort and visit more index/metadata tuples than the page limit. The populated plan probe records those actual plans without changing planner settings. A one-time activation scan is distinct from request work. Independent like-state and order-head required proofs each admit one exact fact; final checks use bounded SQL and NOWAIT fences after deferred constraints. Existing Ratings 161, Review 520 and Safety 128 budgets and CountProofCollector ownership are unchanged.

## Native recovery and verification

The native client uses the existing version-2 journal slot and preserves old v1/v2 formats and hashes. Likes do not get a second concurrently writable slot. The journal must persist before sending; uncertain results recover the same request. A receipt settles intent, then a separate current read settles UI state. Unknown is never displayed as zero. Close, navigation, account changes and late callbacks are fenced. Only displayed rows load state, at most 50 replies plus their root. Current state GETs are sequential within the batch because the existing Safety final fence is exclusive; this avoids reader-on-reader contention without changing the Safety protocol. External contention or unknown authority still yields unavailable, and cancellation prevents later queued reads.

See [native implementation](../apps/wechat/docs/ratings-r2b.md) and [local acceptance](acceptance/ratings-r2b.md). Focused checks are not a full repository or production release claim.
