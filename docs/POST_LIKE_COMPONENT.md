# Local post-like component

This is a separate internal input for future post hotness. It counts actual post
likes, including self-likes, through immutable membership transitions. Comment and
reply likes are excluded. No public score, ranking route, hot-feed UI or received
user total is added. Experience rewards, Saved obligations and current reaction
request/outbox behavior retain their existing owners.

## Independent fresh enrollment

A successful fresh native publication enrolls a known-zero like baseline in its
existing transaction, alongside the independent subscription hook. Exact fresh
post creation, owner, successful receipt and native origin must agree. Both hooks
are atomic with publication. Replay, rejection and read paths do not enroll.

All preexisting posts stay like-unknown, including posts already known to the
subscription component. No current-relation snapshot, old reward/event, timestamp
or later-added origin can establish missing history. There is no reconstruction,
import, repair or production backfill path.

Known baseline is not a freshness guarantee. Component state is its processed
causal prefix and may trail later captured transitions. It is not a complete live
hot score or historical population claim.

## Actual mutation sources

The durable source is an actual `post_likes` INSERT or DELETE. An inserted row's
immutable `like_id` is its epoch. Positive source evidence is retained after the
live row disappears; DELETE captures a negative linked to that exact epoch using
the deletion transaction, not the original insertion stamp.

A desired-state request receipt can also represent a no-op, so it is never counted
as a mutation. Failed or no-op insert/delete attempts create no source. Replaying
an old accepted request after an intervening unlike does not re-like the post.
A genuine re-like creates a distinct epoch.

Capture serializes on the parent before allocating numeric source order. Normal
HTTP mutations already own that parent lock. Known-parent INSERT checks NOWAIT
before child/unique/FK work; DELETE capture likewise refuses to wait while holding
a child lock. An invisible parent is rejected before insertion, without assuming
that later trigger snapshots will repair a publication race. Visible historical
unknown posts retain their non-enrolled behavior.

This fail-fast protocol does not implement arbitrary multi-post bulk mutation.
A future bulk writer needs its own deterministic parent-lock plan. Workers never
lock the deletable live-like row. TRUNCATE cannot bypass capture or erase the new
immutable evidence. These guards assume the trusted schema remains installed;
they do not claim protection against a schema administrator removing constraints.

## Causal settlement

Each apply transaction handles one explicitly selected source and one parent.
It locks parent, component state and retained actor membership in that order,
then checks the earliest unresolved source by PostgreSQL bigint sequence. Sequence
gaps after rollback are valid; there is no contiguous-integer assumption.

A positive requires inactive applied membership. A negative requires that exact
active epoch and a positive count. No decrement is clamped to conceal missing
history or wrong order. Like, unlike and re-like settle as 1, 0, 1 even if all
three actual mutations committed before processing began. Current live relation
presence is not substituted for the retained event history.

An immutable effect receipt and both state/membership effects commit together.
Receipt presence is completion; there is no fabricated Saved obligation or second
mutable work queue. Replaying an old receipt remains valid after newer sources
advance the head and cannot restore old membership. Failed or partially written
effects roll back and remain retryable.

Captured events can be processed after the post or actor becomes hidden, deleted
or inactive. Soft post deletion itself does not remove a live like and therefore
creates no artificial unlike event. This accounting does not authorize a new
cleanup action or make content publicly visible.

## Explicit local CLI

`LIKE_COMPONENT_PROCESSING` is `manual_only` by default and also accepts `disabled`.
There is no automatic mode, timer, implicit backlog adoption or production apply.
The root `likes:process` script forwards to the API entrypoint.

Dry-run is the default. Apply must explicitly select one to 50 unique
`--source-id=<uuid>` values. Request, reward and outbox IDs are not source IDs.
No `--all`, import or repair option is supported. Local/disposable configuration
and actual connection checks precede selected work; other processors, including
subscriptions, are disabled when starting this CLI. No migration runs on startup.

Dry-run makes its transaction read-only before inspection and performs no claims,
locks for mutation, sequence allocation or receipt/effect writes. Results are
advisory and revalidated in apply. Full table and sequence snapshots support its
write-free acceptance; a bounded command is not a whole-backlog audit.

Selected sources run independently. Missing, blocked, unavailable or failed work
is reported without stopping a valid selection for another post. Inspect summary
counts rather than assuming every selected item was applied. Credentials, post
bodies and underlying author data are not printed.

## Remaining boundaries

Retained-source head queries can grow with history. The 50-selection limit is not
a fixed physical-query-work guarantee or production throughput benchmark.
Historical reconciliation, operational processing, comment/view components,
effective scoring configuration, hot-feed/search reads and native UI remain open.
The separate received-total deletion-policy decision is unaffected.
