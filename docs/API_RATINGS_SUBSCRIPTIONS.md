# Rating target subscriptions and local updates (R2C)

This development slice adds target desired-state subscriptions, independent current membership/count coverage, actor-only shared-pool Experience, and durable local subscription updates for new roots and replies. It preserves the strict R1/R2A/R2B DTOs and adds eight operations to the [40-operation generated contract](openapi/ratings.json). [Acceptance](acceptance/ratings-r2c.md) separates focused evidence from the final local gate and outstanding release gates.

## Target state and recovery

- GET `/v1/ratings/targets/:id/subscription?regionId=...`
- PUT `/v1/ratings/targets/:id/subscription`
- POST `/v1/ratings/subscription-states/query` (read-only)
- GET `/v1/ratings/subscription-requests/:id`

Known state is `{status:'known',targetId,subscribed,count,revision,allowedActions:{setSubscription:true}}`. Unknown coverage is exactly `{status:'unavailable'}`. It never means false or zero. Target/scope/session/phone/current review authorization remains required; unavailable dependencies fail closed. Target creator identity is not a subscription audience or named interaction.

PUT accepts only `clientRequestId`, `regionId` (nullable), `expectedTargetRevision`, `expectedSubscriptionRevision` and `subscribed`. The path is the sole target identity. Membership revision belongs to this actor/target; another subscriber changing the count does not invalidate that CAS. A stale CAS is checked before noop detection. Noops record an independent anchored observation without a new epoch, order, reward or notice, and retain the original exact time.

Success receipts contain only `requestId`, operation `set_target_subscription`, outcome `applied|noop`, `targetId`, `subscribed`, `revision`, and `occurredAt`. Rejections contain only requestId, operation, outcome and the existing rating rejection code. Receipt recovery is actor-owned and separate from score/comment, reply and like recovery. The request namespace is shared, while canonical intent uses `whaleu:rating-subscription-command:v1`. Same key plus same intent replays the original receipt. It never restores a subscription after a later unsubscribe. A receipt is historical, so clients must independently read current state.

The read-only POST accepts `{regionId,targets:[{targetId,expectedTargetRevision}]}`, with 1–20 distinct targets in one scope. It returns `{items:[{targetId,state}]}` in request order. Current invisible or revision-changed cards become unavailable; whole-request authentication or dependency failures remain errors. No request journal, notification owner or discovery cursor is created. Existing target card DTOs stay unchanged. Native pages use at most three sequential batches for fifty cards, cancel the supplement on route/account/origin changes, and clear failed-batch states. They do not issue parallel rating state reads against the existing global Safety final gate.

## Independent coverage and causal history

Subscription baseline is independent of score and like baselines. Exact native target creation, or the immutable subscription writer cutover for an already-existing exact native target source, can establish zero. Source and creation transaction, new-native origin, accepted complete provenance and effective time must agree. Historical, future, missing, conflicting or incoherent evidence stays uncovered. This does not import external subscription history.

Each target has its own serialized stream. Actual subscribe/unsubscribe transitions and captured publications take consecutive target orders while holding the target parent lock. Subscriber epochs use the positive transition identity and immutable close records. An event at E considers starts S<E and no closure at or before E. Wall clock equality, global identity sequence, transaction ID and allocation order are not cross-target commit watermarks. Work is selected by explicit event IDs, never MAX(sequence).

Membership, count head, actor head, epoch, stream entry, transition, request receipt, typed effect and durable XP work have SQL causal constraints. Exact successor checks support multiple legal changes in one transaction and savepoint rollback while rejecting skipped projections, arbitrary count updates, forged noops, split ancestry, lost history and missing work. Final state proof is bounded to twenty facts; existing Safety, grant, campus and count-owner capacities are unchanged.

## Experience

A real false→true transition captures one target-only v3 `like_save` unit for the actor, in the existing ratings Experience registry and shared daily pool. Root, reply, root author and content-author mode are null only in this explicit v3 branch. Old v1/v2 constraints remain strict. There is no target creator received reward. Unsubscribe, noop and receipt replay award nothing and deduct nothing. A later genuine subscribe epoch may participate in the shared quota again. Unknown XP history remains pending even when subscription state is known; later unsubscribe or visibility changes do not erase captured rewards.

## Publication capture and bounded local processing

The fan-out migration has its own immutable activation and installs capture under the Safety policy gate and ordered source table locks. A root or reply committed between membership activation and fan-out activation is not replayed. All later new roots and replies capture a source and initial job in the same content transaction. Pure score changes, likes and deletion do not fan out. Unknown subscription coverage captures a blocked job rather than an empty audience or a false completion.

Each raw epoch page reads at most 51 entries, commits at most 50 raw candidates and records exact before/through coordinates, selected IDs and scan completion. Closed and actor epochs still advance the cursor. SQL recomputes the same bounded page and checks work and cursor completeness. Every eligible recipient is processed in a separate sequential transaction, with fresh identity/scope/catalog/target/root/reply/review/Safety checks, current same-epoch membership and owner locking before notification materialization.

Unsubscribe committed before materialization suppresses outstanding work from that epoch. Unsubscribe after materialization preserves the notice. Re-subscribe does not revive older events. Explicit current denial is terminal suppression; missing or unavailable authority retries with backoff. One unknown recipient does not block other known recipients, but prevents event completion. A completion receipt requires a genuine terminal scan page and no pending/retry work. Direct reply, like and subscription receipts are independent; a person who is both a direct recipient and a subscriber may receive one of each.

Local command:

`npm run ratings:subscriptions:process -w @whaleu/api -- dry-run --event-id=<UUID>`

Apply additionally requires `RATINGS_UPDATES_PROCESSING=manual`, a verified loopback connection to the disposable development/test database, a nonproduction runtime, and explicit event IDs (maximum 50). Optional `--max-pages=1..20` and `--max-recipients=1..1000` bound the whole invocation; defaults are two pages and fifty recipient steps. A partial result remains resumable by the same event IDs. Multiple workers serialize individual event transactions; transient closing-proof contention is retryable. Dry-run performs SELECT-only forecasts, including no owner creation, attempts, page/cursor advancement or write-then-rollback simulation. No external provider queue or automatic worker is installed.

## Independent subscription notifications

- GET `/v1/me/ratings/subscription-updates?limit=20&cursor=...`
- GET `/v1/me/ratings/subscription-updates/unread-count`
- GET `/v1/me/ratings/subscription-updates/:noticeId/target`
- PUT `/v1/me/ratings/subscription-updates/:noticeId/read`

Pages are `{items,nextCursor,unreadCount}`, maximum twenty items. An available notice has noticeId/createdAt/readAt, status, domain `ratings`, kind `subscription`, reason `target_subscription`, activity `root|reply`, target locator `{regionId,targetId,rootId,replyId}` and current preview `{text,author}`. Root activity requires null replyId; reply activity requires an exact reply identity. Anonymous previews expose only the target-scoped persona. An unavailable notice exposes only noticeId, createdAt, readAt and status, without target or text snapshots.

Target lookup never marks read. Native opens the current root or exact reply successfully before acknowledging that category's notice. Explicit mark-read remains available for inaccessible content, owner-only and idempotent, preserving the exact original SQL timestamp. Notices retain their read state across permission loss/recovery and unsubscribe. Subscription, direct and like cursors, counts, locators and read APIs cannot be mixed.

## Remaining boundaries

Historical subscription/notice import, source authority, production target administration, random/specialist rating domains, media, real review issuance, devices and external providers remain separate release gates. The existing personal saved-post list remains community-only; this slice covers rating catalog cards and detail subscriptions, not a newly invented cross-domain personal list. Author cumulative received-like policy remains undecided and unchanged. No production account, provider, model, billing, signing or publication action is part of this API slice.
