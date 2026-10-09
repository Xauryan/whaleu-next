# Native ratings R2B

R2B adds independent current root/reply like states and desired-state like commands without changing the frozen R1 root or R2A reply DTO. Like actors use named identity; an anonymous author remains a target-scoped persona. This client does not infer private authors, recipients, reward units or delivery information.

## Current interactions

- `rating-detail` reads like states only for its displayed roots. `rating-thread` reads its root and displayed reply page. Independent GETs currently run one at a time, below the ceiling of four, with a per-read ceiling of 50 rows plus the thread root. The existing Safety final-proof gate is exclusive: parallel reads within this same batch were proven to contend and return 503. Serial dispatch avoids self-contention without changing that owner protocol or adding retries. Loading latency therefore grows with the displayed row count; cancel, hide or route/account changes discard the queued old rows before further dispatch. External authority failures still remain unknown. Unknown coverage displays unknown and no like control; it never becomes zero or `liked: false`. Interaction authorization is separate from content reading, so a denied direct-like read does not erase an independently authorized list row. Protocol, authentication, forbidden and cancellation failures still fail closed.
- A tap freezes the desired boolean and current target/content/membership CAS into the existing v2 journal before dispatch. Repeated taps while pending do not mint another request or coalesce into a re-like. The current count and membership are read separately after a matching terminal receipt; the historical receipt cannot populate current state.
- Root ordering has time/likes and asc/desc choices. An untouched default request omits both new query fields, preserving the legacy newest route. Explicit choices send the selected sort/order and restart from a fresh cursor. A changed order/access head clears old rows and cursors. Unknown like-order coverage remains an error; time-sort buttons remain available to return to a readable ordering.
- Likes do not replace the independent 1–5 score, reply interaction, own-content deletion, or current content authorization.

## One pending slot and old recovery

The original origin/account v1 and v2 key names and envelope versions remain. New likes extend only the v2 operation union. v1 still accepts exactly the original R1 operations. Existing v1 is recovered before v2; both keys survive until their own matching receipt settles them. Old v2 reply intents retain their canonical bytes. There is no second concurrent like slot.

Score/root/reply/like command routing, labels, target extraction and receipt matching explicitly distinguish both like operations. Wrong request/operation/target/root/reply/desired boolean, malformed receipts, missing receipts and transient errors preserve uncertainty. Retry uses exactly the original key, desired state and CAS. Account/origin mismatches, corrupt storage, failed read-back and failed removal fail closed. A successful historical recovery does not require the content still to exist and does not restore its old body or identities.

## Local like notices

The same ratings-updates page provides separate reply and like categories. Legacy reply endpoints and decoders remain reply-only; the parallel like endpoints use a strict named-actor/current-preview DTO. Like targets permit a nullable reply ID for root likes. Unavailable items retain only notice ID and owner-visible timestamps.

Opening a row resolves a current server locator and navigates using a separate `likeNoticeId`. The source page does not mark read. The receiving thread resolves that exact like notice, loads and applies the current root and, for reply likes, inclusive reply position, and only then acknowledges the like endpoint. Root likes need no synthetic reply ID. Legacy `noticeId` behavior is unchanged. Unavailable/mismatched locators, failed current reads, navigation changes and hidden pages do not trigger automatic read. Explicit per-item mark-read remains available.

The local notice contract is once per recipient/actor/subject. The UI explains that unlike/re-like does not reset an already read notice. That rule and actual materialization must be proven by the backend worker; a native applied like receipt is not notice or XP delivery evidence.

## Lifecycle and verification

Page hide/unload, cancellation, account replacement, same-account login epoch changes, logout, app privacy clearing, Safety and browsing-scope changes clear current like maps with content/drafts/cursors and fence late callbacks. Serial batching only removes self-contention within one normal load. A cancelled HTTP request can still finish its server transaction while a newer route loads, and other devices or writers can still contend; those failures remain unknown. A broader batch-read/fence performance protocol is a separate task. An already-dispatched command may commit; its original owner's journal remains available for recovery and cannot clear another owner's state.

`test/ratings-r2b-{contract,gateway,controller}.test.ts` covers strict DTO branches, private-data rejection, exact authenticated routes, immutable auth replay, current-state ancestry, pending compatibility, desired-state receipt matching, bounded reads, command routing, sort reset/unknown coverage, direct root/reply notice reads and lifecycle interruption. The frozen R1/R2A tests remain active. The same suite reads `packages/fixtures/ratings-r2b.json`, captured from actual AppModule HTTP/PostgreSQL responses, through the native strict decoders. `apps/api/test/integration/ratings-r2b-native-roundtrip.test.ts` exercises these actual gateways and controllers, including serial current reads, lost committed replies, fresh-state recovery, local notices and root sorting; it runs under the backend database integration gate.

`scripts/smoke-ratings-r2b.mjs` evaluates emitted JavaScript page handlers through real `ApiClient`/strict gateways and the repository's bounded WXML condition/loop/template evaluator using synthetic data. It covers visible controls, current vs. historical state, late responses, same-key recovery, storage failures and receiving-page read acknowledgement. It is not a WeChat device renderer or real backend integration.

Backend normal-composition HTTP/PostgreSQL causality, exact cursor proofs, actual Experience settlement and local-notice workers require their separate integration gates. Trusted review issuance, production catalog/history enrollment, device/provider acceptance, external delivery, subscriptions, media, management, author cumulative-like policy and other clients remain separate. This slice does not claim complete legacy feature parity.
