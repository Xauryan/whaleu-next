# Native ratings R2A

R2A extends the frozen R1 score/root wire contract with text replies and a separate owner-only local ratings-updates source. It does not rename rating resources to community posts or change the independent 1–5 score. The original R1 operations, receipts and uncertain v1 storage remain recoverable.

## Current native pages

- `rating-detail` retains its R1 score, text and own-root deletion controls. Each current root opens `rating-thread`; root deletion warns that all its replies become unavailable while the independent score remains.
- `rating-thread` reads the current target and discussion root, then a separate oldest-first bounded reply page. Every current row can offer its own reply action, including a row whose older quoted reply is now unavailable. Reply targeting uses only server-confirmed typed target/root/reply IDs and revisions. The client never supplies recipient accounts or copied names.
- A position link reads an inclusive anchor page. That page has its own cursor and is not appended to earlier pages. “From the earliest reply” starts a fresh first-page read. Empty scan pages with a cursor still allow continuation. Collapse clears bodies, quotes, drafts and cursors; expand reauthorizes all current content.
- Only current `isMine` plus `allowedActions.delete` enables the own-reply confirmation. Deleting one reply reloads surviving rows and current safe references. A deleted/hidden root makes the entire current thread unavailable. An applied receipt never rebuilds its historical body from the journal.
- `rating-updates`, linked from the local community updates page and reply thread, displays only materialized direct rating-reply notices. Its unread count includes unavailable materialized records, excludes pending obligations and never substitutes the community unread count. The page does not claim historical coverage or external delivery.

Named and anonymous authors reuse the exact R1 safe union. Every anonymous outer author and available quote must belong to the same target. Unavailable quotes contain neither the old reply ID, name, body nor a reason. Unavailable notices contain only the notice ID and owner-visible timestamps. No hidden actor/recipient account, original-user ID, review decision, experience amount or delivery snapshot is accepted.

## Recovery compatibility

The single `PendingRatingStore` coordinates all score/root/reply commands per origin and account. New commands use the v2 envelope. On load, an existing immutable v1 is recovered first through the original R1 operation and receipt routes, without changing its canonical intent or writing it as v2. If both keys already exist, each survives until its own matching terminal receipt settles it, with v1 first. No third command can be persisted while either exists. A corrupt second key blocks further commands rather than being erased.

Before first dispatch, the coordinator reads both keys, stores the frozen command and verifies read-back. Storage failure means no first dispatch. Reply creates cannot have a no-op outcome. An uncertain response, 404 missing receipt, 503 authority/review failure, malformed DTO, wrong operation/request/target/root/reply or other mismatch does not release the journal. The explicit same-request retry retains the original body, author mode, revisions and key. No transport error is treated as a terminal business receipt.

Successful historical recovery clears only the matching account/origin/version key. Current content is read separately. The independent `rating-recovery` page also restores reply commands without requiring the target to remain visible. Recovery UI never renders frozen text or author snapshots.

## Notice navigation and lifecycle

Opening a list row first resolves its own current server locator. Native navigation itself does not mark it read. The receiving thread re-resolves the same notice and exact typed locator, successfully reads/applies the current root, target and inclusive reply-position page, and only then requests the exact current notice's idempotent read endpoint. An unavailable target, failed position, failed navigation, newer route or dismissed page does not trigger an automatic read. Explicit “mark this one read” remains available for an owner-visible unavailable notice.

Account replacement, same-account login epoch changes, logout, page/app hide, unload, cancel, Safety or identity/browsing-scope changes clear transient content, quotes, drafts, selection and cursors and fence delayed callbacks. Cancelling during UUID generation prevents persistence. Cancelling after dispatch preserves the original uncertain journal. Late responses never clear another account's journal or navigate/read an old notice in the replacement view.

## Validation and unfinished gates

`test/ratings-r2a-{contract,gateway,controller}.test.ts` tests strict DTOs, real ApiClient routes, v1/v2 storage, receipt matching, read state, source errors and lifecycle races. It includes changes at the precise position-applied/before-read boundary, not only interruption before network completion. R1 regression tests remain active.

`scripts/smoke-ratings-r2a.mjs` uses emitted JavaScript page handlers, real ApiClient/gateways and the repository's bounded WXML condition/loop/template model with synthetic transport data. This is not a WeChat device renderer, real provider delivery or PostgreSQL proof. Backend AppModule/HTTP/PostgreSQL integration is separately owned and must be verified against the final shared source snapshot.

The UI does not infer experience settlement or notice materialization from an applied reply receipt. Experience is inspected through the existing actual ledger page. Trusted review issuance, production catalog/history enrollment, real device/provider acceptance, likes, subscriptions and subscriber fan-out, management, media, specialist scales, author cumulative-like policy and other clients remain separate unfinished gates. This text-only slice does not claim full feature parity.
