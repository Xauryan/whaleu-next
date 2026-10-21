# Local received social updates

This is a fresh local capability, not historical migration or external delivery.
Migration 0169 adds empty source, work, notice and receipt storage. It does not
adopt existing likes, saved memberships, follows, outbox events or reward work.

## Sources and ownership

Community captures an interaction immediately after its existing immutable
experience-source group is written, in that original source transaction. This
reads the group's exact event, actor, recipient, ancestry, timestamp and like/save
epoch. It neither consumes nor settles an experience unit or Saved obligation.
An actual new positive follow captures only after its original applied command
receipt. Its new edge is bound to that exact request ID and creation transaction.
Duplicate true, command replay, unfollow, rejection and cleanup never enroll a
positive follow. Self-interactions do not enroll a received-social source.

Database guards independently require fresh source provenance, exact receipt and
edge identity, and independent notification work in the same transaction. Failure
of source capture or work enrollment aborts the source mutation. Source facts,
settlement receipts and completed work cannot be rewritten or deleted. Follow
command receipts and positive edge epoch identity cannot be rewritten.

Community owns private source facts and current projections. Notifications owns
work, lifetime deduplication, notices, read timestamps and navigation metadata.
No sender business row is added to Inbox, and no raw `@` text is interpreted.

## Lifetime rule

The required lifetime like rule is preserved. This slice explicitly adopts the
same anti-spam product rule for saves and follows: one notice per recipient,
actor, kind and resource for the lifetime of that relation. A genuinely new
re-like/re-save/re-follow epoch gets its own immutable source and settlement
receipt, but an existing notice is referenced rather than moved, re-dated or made
unread. The exact dedupe key is also checked by the database. This save/follow rule
is a new slice decision, not a claim about historical product behavior.

## Processing and recoverable visibility

Every source has independent transactional work, including sources created in
manual mode. The `SocialUpdatesWorker.run({mode:'apply',sourceIds:[...]})` internal
entry point handles at most 50 explicit sources. Dry-run is the default and does
not create notices or receipts. Production, remote hosts and actual non-loopback
connections are rejected; only `whaleu_test` and `whaleu_dev` are accepted.

With existing `COMMUNITY_UPDATES_PROCESSING=automatic`, the registered
SocialUpdatesDispatcher runs bounded cycles at the configured local interval.
Only work captured under automatic mode is automatically selected. A later mode
change never adopts prior manual work. Each failed source retries with bounded
5–60 second backoff. Shutdown cancels the next tick and awaits in-flight work.
The internal `cycle()` is the same path used by deterministic real-PG acceptance.
There is no public processing endpoint, push provider or external queue.

Materialization stores only source-owned metadata, not a target or actor preview.
The source guard has already proved the non-self recipient and occurrence. All
such events therefore retain a notice even if current visibility has changed:

| Condition at processing/read                                   | Work outcome             | Public read outcome                       |
| -------------------------------------------------------------- | ------------------------ | ----------------------------------------- |
| Valid fresh source, no prior lifetime notice                   | materialized             | Freshly projected                         |
| Valid new epoch, prior lifetime notice                         | existing receipt         | Same notice/time/read state               |
| Hidden/deleted ancestry, block, inactive account, ended follow | materialized or existing | Generic unavailable                       |
| Visibility/authority dependency unavailable                    | materialized or existing | Generic unavailable; exact count unknown  |
| Visibility later restored or follow restored                   | No new unread reset      | Same notice may become available          |
| Missing/inconsistent source or database failure                | No successful settlement | Pending/retryable, count coverage unknown |
| Self-event or duplicate source command                         | No received source       | No received notice                        |

Thus a temporary block/hide/unfollow cannot silently discard the original event.
A receipt does not grant access. All reads recheck session/deadline, current
lifecycle, immutable recipient ownership, complete current post/root/reply and
reply-to ancestry, canonical visibility and relationship proof. Likes and saves
never resolve or return the interaction actor's profile: their activity has no
lawful public-persona contract. Named/anonymous ancestry uses canonical content
policy, not a private actor-account block oracle. Follows require the exact current
edge and current bilateral named public-profile projection.

## HTTP contract

All routes are authenticated, `no-store`, and require category `likes`, `saves` or
`followers`. Unknown keys are rejected. The four operations are:

- GET `/v1/me/social-updates?category=likes&limit=20&cursor=...`
- GET `/v1/me/social-updates/unread-count?category=likes`
- GET `/v1/me/social-updates/:noticeId/target?category=likes`
- PUT `/v1/me/social-updates/:noticeId/read?category=likes`, body `{}`

List limit is 1–20. All timestamps are UTC strings with six fractional digits.
createdAt is the actual immutable source occurrence time, not dispatch time. The
first materialized lifetime source fixes this time permanently; processing a later
explicit epoch never implicitly adopts an earlier manual source or rewrites time.
Unavailable rows contain exactly noticeId, createdAt, readAt and status. Available
like/save rows add only kind and a Community target. Saves are post-only; likes
may locate post/root/reply. Available follow rows add a current named actor with
profileId/displayName and a profile target with the same profileId. No account
IDs, source epochs, internal reasons, content text or cached previews are exposed.

List/target/category entry never mark read. Exact individual acknowledgment also
supports unavailable rows, does not disclose target data, and preserves its
original timestamp on retry. Other owner/category IDs are indistinguishable
NOTICE_NOT_FOUND results.

Opaque cursors use the existing durable bounded/expiring navigation owner, scoped
to account, session, token, category, limit and source-time descending order. They
store an initial per-owner/category maximum committed delivery ordinal plus the
exact last scanned event-time/ordinal coordinate, never a private payload.

A composite event-time/ordinal index seeks at most limit+1 raw candidates. The
service filters candidates above the initial delivery-ordinal ceiling only after
that bounded query; the cursor advances by the last raw scanned candidate, even
when none belongs to the old snapshot. Empty pages with nextCursor therefore mean
continue, not exhaustion. Late-dispatched/backdated events appear on a fresh
refresh but cannot create gaps or duplicates in an earlier pagination snapshot.

Both the application and database insertion guard hold the recipient owner lock
through commit. The database allocates the delivery ordinal only after this lock,
so a smaller same-owner ordinal cannot commit behind a higher observed ordinal.
Sampling the committed maximum before source projection needs no early owner lock
and preserves domain-before-notification lock order. The DB independently binds
createdAt to the first source occurrence, so callers cannot invent a current time.

## Exact counts and bounded uncertainty

Unread means currently readable unread notices in the requested category, not
historical source totals or a count of the current page. Read/unread receipts stay
independent of current availability. An unavailable row can remain unread in
storage yet not contribute to the readable count.

A count first rejects any pending source work in the category. It examines at
most 33 unread candidates: 32 are the projection budget and the 33rd proves that
coverage is not bounded. Overflow, pending work, transient authority uncertainty,
lock contention or time budget failure returns unreadCount null with
unreadCountStatus unavailable, never a prefix value or invented zero. A proven
result returns a nonnegative integer and status available.

Count source statements use at most 20 ms each, a 1 ms lock timeout and a 500 ms
monotonic budget checked around the bounded per-row projections. A projection
already underway has a bounded fixed ancestry/query depth. After all domain
locks, the notification owner lock precedes NOWAIT work/notice table fences and an
exact candidate/backlog recheck. Read acknowledgments take a write-compatible
fence, avoiding shared-lock upgrade deadlocks. These conservative fences can
make unrelated concurrent mutation yield unknown counts. Mandatory final source,
safety and deadline proof remains fail-closed; it may reject an entire response
rather than return stale target data. No fake exact-zero promise is made.

## Validation status

Focused contract/projection/read/capture/worker and existing-follow tests run
locally against mocks. Real PostgreSQL and emitted-native integration source is
added separately for centralized serial execution. Source presence is not a
claim that PostgreSQL, native packaging, providers, devices or production passed.
No production migration, deployment or provider activation is implied.
