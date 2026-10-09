# Rating text discussion and direct local updates (R2A)

R2A extends the normal Nest application with text replies, same-target personas, durable effects, shared-pool Experience settlement and direct in-app notices. It does not install a production reviewer, import historical rewards, send external notifications, or implement rating likes, subscriptions, media or administration. The [R1 contract](API_RATINGS.md) remains wire-compatible; the [generated contract](openapi/ratings.json) includes these 23 operations and later additive slices.

## Discussion routes

- GET `/v1/ratings/comments/:id/discussion`: unchanged R1 root plus a separate discussion context and create-reply capability
- GET `/v1/ratings/comments/:id/replies`: bounded oldest-first page, default 20 and maximum 50
- GET `/v1/ratings/replies/:id`: currently authorized single reply
- GET `/v1/ratings/replies/:id/position`: a bounded page starting at the authorized anchor
- POST `/v1/ratings/comments/:id/replies`: canonical text publication
- DELETE `/v1/ratings/replies/:id`: owner-only soft deletion
- GET `/v1/ratings/reply-requests/:id`: account-owned historical result

Create requires clientRequestId, regionId, targetId, expectedTargetRevision, expectedRootRevision, replyTo (null or replyId/expectedRevision), authorMode, body and empty assetIds. Root comes from the path. Delete requires clientRequestId, regionId, targetId, rootId and the expected target/root/reply revisions. Strict schemas reject all client-supplied identities, recipients, points and timestamps. Text uses the existing 1–500-code-point normalizer.

The server resolves every parent and author. A reply-to-reply must belong to the same root and target. All reads retain the root visibility gate; a root tombstone hides every descendant without per-page cascading writes. Deleting one reply leaves later replies intact. An unavailable quote has only `{kind:'reply',status:'unavailable'}`, with no old ID, author or text. Anonymous author projections reuse the target-scoped persona and never expose the private account.

Reply receipts contain only requestId, operation, outcome, targetId, rootId, replyId, revision and exact occurredAt; rejected receipts contain requestId, operation, outcome and code. Create cannot noop. The R1 recovery route returns only R1 operations; the reply route returns only reply operations. Both use the same account/request namespace. Applied confirms content and complete durable obligations committed together, not that workers ran. Native confirmation reloads current content and never reconstructs it from the journal.

The reply review envelope is separately versioned v2 and binds the full typed parent chain, revisions, actor, request, canonical text, mode, empty assets and catalog/scope. Target/root approval v1 bytes and digest are unchanged. Unknown evidence fails closed rather than becoming a rejected publication or an empty successful page.

## Effects and Experience

New root creation captures actor/comment. Reply-to-root captures actor/comment and nonself root-author/received_comment. Reply-to-reply captures actor/comment and only the nonself direct reply-author/received_comment. A third-party root author receives no extra nested-reply experience. Root/reply deletion creates lifecycle evidence but no reward, deduction or quota refund.

Every new transition has an immutable effect; all expected reward units, real work and direct notice obligations are required in the publication transaction. The thin Experience registry has separate exact foreign keys for community and rating sources. Existing community records are bridged without new work, balances or enrollment orders. The normal worker reads immutable source facts before its single owner lock, uses the existing Shanghai settlement day and shared action pools, and atomically writes settlements, records, buckets, balance, unlocks and work completion. Unknown historical baselines remain blocked and do not prevent another known beneficiary from settling independently.

Existing R1 roots have no fabricated fresh effects. Their presence alone does not prove an unpaid historical reward. Historical reconciliation remains a separate release gate.

## Local notifications

- GET `/v1/me/ratings/updates`: owner page, default/maximum 20
- GET `/v1/me/ratings/updates/unread-count`
- GET `/v1/me/ratings/updates/:noticeId/target`: resolve without marking read
- PUT `/v1/me/ratings/updates/:noticeId/read`: empty body; monotonic idempotent read state

Replies to roots notify a nonself root author. Nested replies notify the nonself root and direct authors, deduplicated by recipient; when these authors are the same, the reason is direct_reply. Self recipients are excluded. These rules deliberately differ from the nested Experience beneficiary set.

Notices store typed locators and read state, never text or author snapshots. Current unavailable targets produce a generic notice with no locator or preview. Unread counts include such already-materialized notices, exclude pending/suppressed obligations and remain separate from community counts. Unknown authority is retryable; explicit current denial or tombstones suppress an unmaterialized obligation. Read-state history does not become unread again after access returns.

The worker is manual and local only:

`RATINGS_UPDATES_PROCESSING=manual npm run ratings:updates:process -- apply --event-id=<uuid>`

Default mode is dry-run; apply requires explicitly selected events (at most 50), manual configuration, a configured and actual loopback connection and a disposable whaleu_dev/whaleu_test database. It creates no external delivery rows or automatic dispatcher. All recipients finish current parent-chain projection before sorted notification-owner locks. List/target also project before owner locks; markRead never locks rating parents.

## Bounded continuation and proofs

Reply pages use numeric immutable ordinals and a per-root transition head, not a history count or max scan. The head has an exact transition FK, advances only from fresh source transitions, and cannot rewind. Cursors bind account/session, authority, target/root revisions, root head, limit and Safety/Review epochs. Position pages begin at the anchor; they do not report a fabricated page number. Lifecycle or policy changes require restarting old cursors.

The existing Ratings 161-fact, Review 520-fact and Safety 128-slot limits remain unchanged; no fourth CountProofCollector owner is added. Focused local tests measure 104 Ratings and 205 Review facts for 50 replies with 50 distinct quotes; these measurements are not a full regression or production-throughput result. [Acceptance status](acceptance/ratings-r2a.md) tracks focused and final local acceptance. Final proofs remain READ COMMITTED, deferred-constraint-first, NOWAIT and bounded-read only. Raw child/root SQL updates never wait backward for a missing parent lock.

The native implementation preserves pre-upgrade v1 journals, coordinates every new command through one account/origin pending slot, rejects mismatched recovery receipts and invalidates stale callbacks on session/navigation lifecycle changes. See [native implementation notes](../apps/wechat/docs/ratings-r2a.md).
