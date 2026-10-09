# Ratings R2C: target subscriptions and local subscription updates

## Current target state

The rating target detail page reads subscription state independently from scores, score history, root text and likes. A known response supplies this actor's current membership revision, exact current target subscriber count and permission to set the desired state. Unknown responses have only `status: unavailable`: no false membership, zero count or enabled mutation button is synthesized.

Ordinary category target cards use an independent read-only POST to `/v1/ratings/subscription-states/query`. The original strict target/list DTO is unchanged. Each request has one region and 1–20 distinct target IDs with the exact rendered target revisions. The response must have the same IDs in the same order, and each known state must match its enclosing target. One displayed server page has at most 50 cards, so its supplement uses at most three batches, sequentially, with one request in flight. It never performs one status GET per card. Detail uses one GET instead. Supplemental like and subscription reads also run sequentially within a detail load.

A failed batch gives every target in that batch an unavailable state; stale known counts do not survive a fresh refresh. Other successful batches remain independent. A precise interaction-purpose denial leaves separately authorized readable content intact. Authentication, account blocking, unexpected forbidden replies, malformed protocol and stale sessions fail closed. A 503 is not automatically retried. Cancel, a valid region or route change, sort selection, page/app hide, Safety invalidation and account/login-epoch changes cancel the old chain, discard remaining unsent batches and fence late results.

A valid non-global region selection must come from the server's current region choices; passing an arbitrary UUID is not a way to change the browsing scope. Returning to the global root remains possible during a pending supplement and cancels it.

## Desired-state commands and recovery

The sole operation is `set_target_subscription`. A command binds its path target, original request ID, region, rendered target revision, current actor subscription revision and desired boolean. Neither count, actor identity, audience nor experience is accepted from the client. No score or comment is required to subscribe.

New subscription commands use `whaleu.ratings.pending.v3:<origin>:<account>`. Versions 1 and 2 retain their original key, intent decoder, request body and receipt route. Version 2 does not accept subscription commands; version 3 accepts only subscription commands. Recovery checks the legacy v1 slot, then v2, then v3. Before saving a fresh command all three slots are checked, so a pending old command or untrusted storage prevents a replacement. Storage write/read-back precedes HTTP dispatch. Cross-account and cross-origin recovery is forbidden.

Repeated taps mint one request. Stopping the wait does not claim cancellation of a request already sent. An unknown result is recovered by the original receipt key or explicitly retried with identical desired state and revisions. It never becomes a new subscribe/re-subscribe command. Matching minimal receipts settle historical intent only. The current badge/count is re-read after settlement, including when another device has since unsubscribed. Rejected CAS requires a fresh read and explicit new choice.

A real subscribe/re-subscribe epoch may earn experience through the backend's existing shared daily quota. Unsubscribe does not reverse captured experience. The native UI never treats a command receipt as experience settlement or notice delivery confirmation.

## Independent subscription updates

The rating-updates page has separate Reply, Like and Subscription categories. Each has a strict decoder, dedicated gateway and cursor/read/unread routes. Subscription items use `kind: subscription`, `reason: target_subscription`, and `activity: root | reply`; root activity requires a null reply ID and reply activity requires an exact reply ID. Previews show the current named author or current target-scoped persona. An unavailable item contains no locator, preview, author identity or text.

A list tap resolves the current locator without marking read. The receiving thread repeats that resolution, verifies the full region/target/root/reply tuple, reads the current root or exact inclusive reply position, and only after applying that content calls the subscription-specific read endpoint. The route accepts at most one of `noticeId`, `likeNoticeId`, and `subscriptionNoticeId`. Failed location, deleted content, cancelled navigation and invalidation do not automatically mark read. The list retains explicit per-notice acknowledgement for unavailable entries.

Direct replies and subscription updates remain separate even for the same event and recipient. Reading one category does not consume the other. Already materialized notices remain readable after unsubscribe when the current content is still authorized. Read timestamps are server-owned and monotonic; the client never resets them or infers unread count from a failed response.

## Scope and verification boundaries

There is no new personal ratings-saved list: the existing personal saved-message surface remains community-only. This slice covers rating target directory cards, details, subscriptions and independently typed local updates.

- Native unit tests exercise strict DTO/gateway boundaries, all three immutable journal versions, response loss, retries, current-state independence, serial batches, exact notice location and lifecycle races.
- `scripts/smoke-ratings-r2c.mjs`, invoked by the regular native build smoke, executes emitted page handlers, real ApiClient/gateway code and actual repository WXML branches against a synthetic transport.
- `apps/api/test/integration/ratings-r2c-native-roundtrip.test.ts` separately exercises Native controllers through the actual AppModule HTTP pipeline and PostgreSQL with isolated synthetic identity/catalog/review facts. Its execution and database-worker evidence belong to the backend integration gate.

Synthetic WXML evaluation is not WeChat DevTools or physical-device rendering. Local HTTP/PostgreSQL evidence does not establish production source coverage, historical subscription import, production throughput, trusted review issuance, external WeChat delivery, media or remaining specialist/administrative parity.
