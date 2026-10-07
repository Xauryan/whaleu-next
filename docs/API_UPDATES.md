# Community local in-app Updates, C2E increment 2

This slice implements actual persisted **local in-app** root/reply notices and an
account-owned read model. A notice row is evidence of local materialization, not
push/provider/device delivery. Reward/ranking obligations remain separate and
pending. No external adapter, SDK, email/official-account send, consent, quota,
role grant, real verification, production import or paid service is activated.
All ordinary community authority/visibility/media adapters remain fail-closed;
end-to-end acceptance uses synthetic local fixtures and real PostgreSQL 18.6.

## HTTP and native contract

Every route requires the active bearer session, derives its owner from that
session, validates strict parameters and returns the standard safe error envelope.
There is no actor/account parameter, public worker route, mark-all-read route or
implicit read mutation on GET. Prefix these paths with `/v1`:

- `GET me/community/updates?cursor&limit`: `{items,nextCursor,unreadCount}`;
  decimal limit 1–50, default 20. Order is `(createdAt DESC,noticeId DESC)`
- `GET me/community/updates/unread-count`: `{unreadCount}`
- `GET me/community/updates/:noticeId/target`: either
  `{noticeId,status:"available",target:{postId,commentId,replyId}}` or
  `{noticeId,status:"unavailable"}`
- `PUT me/community/updates/:noticeId/read` with exactly `{}`:
  `{noticeId,readAt,unreadCount}`. It changes only this owner's exact row;
  repeated requests preserve the first read timestamp. Other-owner and absent
  IDs both return `NOTICE_NOT_FOUND` (404)

An available item is exactly:

```text
{noticeId,createdAt,readAt,status:"available",kind:"root"|"reply",
 reason:"direct"|"saved",target:{postId,commentId,replyId:null|UUID},
 preview:{text,images,author}}
```

The preview uses the community's current canonical media/persona serializers,
not a saved body/profile snapshot. An unavailable item is exactly
`{noticeId,createdAt,readAt,status:"unavailable"}`. It contains no kind, reason,
anchor, body, image, author/profile/account identity or removed target identifier.
Read/unread is independent from target availability; the exact badge counts all
own unread persisted notices, including generic unavailable placeholders.

Opaque cursors bind purpose, hashed owner and limit. They never grant access or
contain raw owner IDs. There is no frozen cross-request snapshot: newly inserted
notices may require refresh; read state is reloaded. Within each response,
materialization and read changes are serialized by the owner guard so page/count
are coherent. A separate later request can legitimately see a new count.

The native page revalidates the exact notice target, then uses the existing
post/detail/discussion locator with typed ancestry to find off-first-page roots
and replies. Each content route checks access independently. The page exposes
an explicit exact-notice read acknowledgment; opening or a failed navigation does
not accidentally mark another notice/category read. Refresh/append/open/read and
badge responses are bound to the current account/navigation lifetime. Account
switch, logout, dismissal and stale replies cannot restore another user's list
or unread badge. Physical-device/provider delivery remains unverified.

## Recipients and temporal eligibility

Only canonical newly published community root/reply obligations qualify:

- Root: post author directly, excluding self; historical saved recipients
  excluding the actor and post author. A post author who also saved gets one
  direct notice, never an additional saved notice
- Reply: root author and explicit replied-to author, excluding the actor and
  deduplicating overlap. No extra post-author or saver fan-out
- Saving, unsaving, preferences, ballots, joins, likes, trading status or arbitrary
  content edits do not invent notices. Existing other-category obligations are
  preserved; an explicitly selected unsupported event is ignored terminally

The saved epoch must cover the root's authoritative `interaction_sequence`, and
that exact epoch must remain active at materialization. Equal timestamps never
establish eligibility. Saving after a root and unsave/re-save during delay cannot
qualify an old event. A saved recipient must have updates enabled at event order,
with no subsequent saved-channel disable before processing, and must still have
them enabled now. This prevents mute/re-enable from reviving delayed events.
Direct in-app recipients do not depend on either mute bit; external mute never
suppresses direct or saved in-app notices.

Materialization and reads both check current recipient/content-account state,
active parent scope, local authority availability, named/anonymous visibility
policy and saved-channel preference where applicable. No publication/student/
phone/comments-open gate is added to reading. The anonymous visibility facade
never receives a true anonymous author ID. Materialization also checks the exact
current saved epoch. Unsave retains already received notices and their read state;
current access or saved preference loss projects them generically without stale
content. Restoring access does not recreate or unread an existing notice.

## Module and storage boundary

`NotificationsModule` owns `whaleu_notifications` read/processing tables and
exports the internal `UpdatesWorker`. It uses only exported identity and
`CommunityUpdatesFacade` methods for cross-domain operations. The community
facade owns outbox interpretation, parent-first locks, temporal saved eligibility,
current access and safe serialization. Notifications has no raw query access to
private identity, saved, content or outbox tables. There is no network operation
inside a transaction.

Migration `0013_community_updates.sql` is forward-only and leaves all prior
migration checksums, publication/discussion/Saved receipts and payload hashes
unchanged. Community owns an immutable local-enrollment table; only a newly
inserted canonical root/reply event is registered by the publication repository
in the same transaction. Top-level xid8 provenance works across the existing
publication SAVEPOINT and is immutable. Migration does not enroll old rows;
later repair/import cannot adopt an old row by changing its provenance.
Enrollment order is allocated **after** its commit-order advisory guard, not in
a pre-lock identity default. This prevents a later committed event from causing
an earlier uncommitted order to be skipped by discovery.

A unique `(eventId,recipient,in_app)` processing receipt and notice commit
atomically with the terminal event receipt. Deferred constraints forbid a
successful receipt without its notice or an unmatched notice. Event and receipt
identity are immutable. Read state can transition only from unread to one stable
read timestamp. Counts derive from actual rows, not increment/decrement counters.
An event advisory lock plus owner guards serialize concurrent workers; a crash
before commit rolls everything back, and a lost response after commit is settled
by the same receipt on replay. No read state is resurrected by replay.

Current suppression (inactive account, inaccessible target, ended epoch or saved
mute) is terminal per event/recipient/channel. Future enabling cannot backfill it.
Temporary local authority/media unavailability leaves the **whole event** retryable
with a typed `retryable_attempts` record, no partial notices and no terminal
recipient/event receipt. An exact replay rechecks all current policy. External
work always settles as `unavailable` or `suppressed`; no provider-ready queue or
automatic future drain is created. Preserved malformed/unknown-origin obligations
get explicit unavailable event outcomes instead of fabricated delivery.

## Processing configuration and operator safety

`COMMUNITY_UPDATES_PROCESSING` is a closed enum:

- `disabled`: reads of existing own notices remain available; apply processing is
  refused and no automatic dispatcher starts
- `manual_only` (default): explicit bounded internal processing is available;
  no timer or automatic consumer starts
- `automatic`: explicitly starts a bounded local dispatcher. This is a processing
  configuration, not evidence of any particular recipient's delivery

Per-post preference DTOs expose `inAppCapability:"local"` plus the configured
`inAppProcessing` value above. `externalCapability` is always `"unavailable"`.
Neither preference bit grants provider consent or starts the dispatcher.

Automatic eligibility is stamped server-side at new publication by an application
configured `automatic`, never by a public request field. Switching modes does not
adopt old manual, imported or unknown-origin events. Notifications owns a durable
discovery cursor and pending automatic queue; enqueue and cursor advancement are
one guarded transaction. A crash before discovery, after enqueue, during
materialization or before queue completion resumes safely on restart. Concurrent
dispatchers can select the same pending event, but receipt locking permits only
one notice set. Previously enrolled automatic work stays durable across a pause;
new manual-only events never enter its queue.

Each tick discovers and processes at most `COMMUNITY_UPDATES_BATCH_SIZE` events
(default 20, maximum 50). `COMMUNITY_UPDATES_INTERVAL_MS` bounds the tick cadence
(default 5000, maximum 60000). Retryable failures use persisted exponential
backoff from 5 to 60 seconds and remain pending until settled; there is no silent
in-memory retry eviction. Start is idempotent, stop cancels timers and awaits
initialization/in-flight work, and generation guards prevent old timer chains
from being revived by concurrent stop/restart. Database closure follows stop.

The internal command always starts an application in nonautomatic mode. It is
dry-run/empty-selection by default, accepts at most 50 distinct `--event-id=UUID`
arguments, rejects unknown flags, and prints aggregate counts only. Apply needs
explicit event selection. It refuses production and non-loopback database URLs,
with no production override. The reusable materializer is separately scoped so
future reviewed deployment can use its domain logic without bypassing a CLI
safety check. This increment does not execute or enable anything in production.

## Acceptance and retained work

`test/updates.test.ts` covers strict queries/owner cursors, bounded/default-off
CLI configuration and dispatcher initialization/stop/restart races. The real
PostgreSQL `updates-client-contract.test.ts` exercises normal SAVEPOINT
publication, actual default materialization and persisted rows, temporal epochs
and mute fences, direct/saved/reply recipient matrices, exact read ownership and
idempotence, rollback/concurrent retries, current unavailable projections,
anonymous privacy, Page/gateway deep locators and badge lifetimes. It also
exercises an explicitly configured synthetic automatic dispatcher and durable
restart/retry behavior. These are local runtime proofs, not production/provider
or physical-device acceptance.

Run aggregate lint/typecheck/unit/build plus the serial isolated PostgreSQL suite
before release. All suites include the new notifications schema in their
existing-schema refusal and cleanup contract. Full notification categories,
moderation, authority adapters, media/provider operation, reward/ranking
settlement, production mapping/import, consent/quota and delivery reconciliation
remain separate unchecked work.
