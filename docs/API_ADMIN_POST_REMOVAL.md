# Scoped ordinary administrator post removal

This is a bounded development slice, not the completed rewrite, general account
moderation, full legacy parity, or production acceptance. It does not grant real
roles, accept real historical source, activate a provider, or enable a worker.

## Source and scope

Fixed legacy source is
[WhaleU@57cf169c Message.softDelete](https://github.com/WhaleUCampus/WhaleU/blob/57cf169c11123acf249909a1a7215b8cb1ec1f8e/treehole/app/controller/Message.php#L2967-L3111)
and its
[original-region authority](https://github.com/WhaleUCampus/WhaleU/blob/57cf169c11123acf249909a1a7215b8cb1ec1f8e/treehole/app/service/AdminScopeService.php#L99-L168).
Legacy permits an empty reason with `ban_user=0`, both author modes, and sends a
content-deletion notice only for another author's post. Only author deletion
calls its author Experience trigger. Legacy's fail-open errors, mixed account
status mutations, optional bans and report-style notices are not copied.

The first Next slice accepts a currently readable **post**, native publication
origin, original regional space, and `sync:none`. Named and anonymous text, image,
trading, poll and formation posts retain their normal canonical eligibility.
Only an actual current `school_admin` grant for that original region, or global
`super_admin`, can remove another author's post. Developer-only grants, role
labels, browsing campus, affiliation campus, and caller account IDs confer no
permission. Anonymous authors remain internal recipients; no public Profile,
identity-view lookup, account roster or identity association is returned.

An administrator's own post uses the established author-delete action and its
existing obligations. The administrative endpoint rejects self-targets. There
is no target-role protection copied from unrelated ban/restriction APIs.

## HTTP and durable intent

All routes require a current active account and presented session token. Output
is `no-store`; authenticated reads vary on Authorization.

- `GET /v1/community/admin-post-removal/management?kind=post&id=UUID`
- `POST /v1/community/admin-post-removal/commands`
- `POST /v1/community/admin-post-removal/commands/cancel`
- `GET /v1/community/admin-post-removal/requests/UUID4`

Management returns only `target`, `targetVersion` (64 lowercase hex), and
`canRemove:true`. The version covers exact target tuple lineage and source
facts, including current classification and owner visibility; it is not an
actor/region capability, content preview, or public author locator.

Command is a strict object containing `clientRequestId`, `target:{kind:'post',id}`,
`expectedTargetVersion`, and `action:'remove_post'`. The hash domain is
`whaleu:admin-post-removal-command:v1` over canonical actor + command. A receipt
contains those exact intent fields with `requestId`, plus either `applied` with
`eventId` and millisecond `recordedAt`, or `rejected` with
`ADMIN_POST_REMOVAL_STALE` / `ADMIN_POST_REMOVAL_CANCELLED`. It never includes the
private subject ID, administrator ID, deleted text, or source deep link.

A fresh apply proves exact current authority even when its submitted version is
stale. Unreadable/out-of-scope/unknown source fails closed without an apply receipt.
An existing original-key receipt is returned before source, grant, phone or
policy resolution. Recovery and fresh cancellation also need only active account,
session and token, including on a cold backend while unrelated source tables are
locked. The original key has exactly one immutable outcome; cancellation cannot
resurrect a completed deletion. Another account sees `not_recorded`.

## Atomic ownership and exact proofs

Forward migration 0131 leaves the earlier migration bytes unchanged. Its independent immutable
command, trigger-issued statement/epoch/transition evidence, administrative event,
canonical outbox cause, private author notice and original-key receipt close in
one transaction. The only content mutation is one real live→tombstone update and
0022's exact current-transaction `local_deletion_transaction` stamp. Zero-row or
unrelated/multiple-row updates cannot manufacture a removal. Established admin
tombstones cannot be revived or redated by a later raw transaction.

Canonical access continues to own Review, native origin, category continuation,
Safety, owner-hidden and Media eligibility. Exact initial and selected-grant facts
are retained separately across waits. The mutation proof permits only the recorded
post transition and its actual one-slot Community epoch increment; it cannot
replace earlier observations, absorb unrelated source/zero-row writers, erase an
ordinary proof enrolled outside the scope, or accept same-value/ABA mutation.
Actual epoch-source inventory, statement guards, deferred closure and late-DML
checks preserve this contract after `SET CONSTRAINTS ALL IMMEDIATE`.

The original 100 ms per SQL statement / 500 ms whole owner proof limits and exact
PostgreSQL token/session/phone/grant/Review deadlines remain unchanged. Final
NOWAIT fences reject queued authority/source changes. Exact counts retain their
separate original two-second budget.

Existing 0118 post-pin closure and root-comment pin release are reused. Existing
0078 durable cleanup capture stays in the tombstone transaction. There is no
unbounded discussion traversal, replacement deletion flag, new cleanup engine,
owner `post_deleted` Experience event, or fabricated jury vote/decision.

## Read denial, cleanup and private notices

Fresh canonical reads/interactions and source-open DM requests deny the removed
post and its discussion. Existing private-conversation membership and message
history remain independent. Community Media stays authenticated-only: guests
cannot reach storage. Session thumb/display requests, including storage opens
paused before final reauthorization, cannot return new bytes after tombstone commit. Already final-authorized streams and downloaded/local pixels
are not recalled.

Logical unavailability, later binding retirement and physical deletion are
separate outcomes. The existing cleanup owner processes at most 16 targets per
transaction with durable cursors, restart/crash rollback and exact binding
ownership. Physical cleanup still requires its actual retention period and exact
quiescence evidence. No provider or automatic cleanup processing is enabled.

`admin_post_removed` is a fourth system-notice kind beside jury, nickname and
custom-avatar notices. Its fixed native text is “你的帖子已被管理员删除”. The shared
UUID registry, owner-only list/count/read, stable first-read time and exact tied
pagination remain. Cursor v4 adds the fourth kind; legacy v1/v2/v3 cursors keep
their original owner/limit/seek binding. Notices remain readable after source
removal, grant withdrawal and phone expiry when the recipient session is active.

## Native and verification boundary

The real community-detail entry is separate from author deletion, profile
moderation and reporting, and works for anonymous targets. Confirmation explains
post/discussion unavailability, author notification and the absence of an undelete
path. A dedicated action/page/journal freezes and reads back the exact request
before network work. Lost responses, cold restart, retry, cancel/apply competition,
account/session-generation/API-origin changes, late callbacks and storage failures
keep original-key ownership. Known application clears old content/Media leases;
Back/reopen must reload current state.

Focused tests use emitted native App/Page/WXML with actual HTTP AppModule and
local disposable PostgreSQL 18.6, canonical synthetic publication/Review, and
explicit synthetic Media read leaves. This is not WeChat DevTools, physical-device,
real provider, production throughput or real source/history acceptance. Test
results are reported for the exact final candidate separately; file presence is
not a pass claim. New integration files extend the existing ten-job/max-eight
manifest exactly once without rebalancing jobs or changing the historical
333-file benchmark.

Still excluded: bans/unbans, comments/replies administration, role appointment or
revocation, associated-campus/university-city scopes, report-style notices,
free-text reasons, real grants/source acceptance, provider activation and rollout.
