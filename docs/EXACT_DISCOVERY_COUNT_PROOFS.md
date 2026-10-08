# Exact discovery count consistency proof

Development implementation, migration `0021_exact_discovery_count_proofs.sql`.
No production migration, provider, grants, credentials, worker or source-data import
is included. This document describes the proof infrastructure, not an unlimited
interactive count availability claim. Large-history acceptance and operational
measurements are recorded separately.

## Conditional snapshots and finalization

Count paths explicitly request `READ COMMITTED`; ordinary transactions retain
existing isolation behavior. `captureCountProof(tx, read)` checks the actual mode,
then reads owner-owned fixed epoch vectors through the optional count's
remaining-budget query proxy. Unmanaged transactions and malformed/missing proof
metadata cannot create a proof. The read proxy does not replace the managed client
identity used for required deadlines and savepoint checkpointing.

The three owners are community, safety and campus. Each exposes its own snapshot
and final fence operations. The database coordinator never queries another
owner's business tables. No count snapshot registers an unlocked source as a
required, canonically locked transaction deadline. Every allow and authoritative
denial horizon still contributes to the count's optional horizon.

The transaction wrapper performs:

1. All mandatory reads, selected-page serialization and session checks
2. `SET CONSTRAINTS ALL IMMEDIATE`, completing deferred waits
3. Required owner relationship proofs for explicitly opted-in emitting reads
4. Registered optional proof callbacks, each inside a final savepoint
5. One fresh database `clock_timestamp()`
6. Required expiry checks, followed by optional expiry/proof invalidation
7. Commit, without any further source read or constraint wait

This proof phase runs even for a guest and a durable review with no finite
registered horizon. Expiry equality invalidates. A mandatory expiry remains a
request error; an optional conflict modifies only the affected private count.
Callbacks are pruned with existing deadline checkpoints when count work rolls
back. Expected SQL cancellation/lock errors in optional final work roll back its
savepoint and release partial fences; arbitrary errors, failed rollback and broken
connections fail the transaction. Settings reads and restoration are inside this
recovery boundary. Successful fences remain held until commit.

## Mandatory relationship proof scope

Optional safety epochs alone do not protect mandatory profile basics or selected
page content against a raw SQL first block. Public-profile basic/list, own
liked-list and the audited ordinary emitting owners explicitly enable a separate
mandatory safety proof; see [the route inventory](NAMED_READ_FINALIZATION_GAP.md).
Ordinary source calls record only actually consulted allowed named
relationships; anonymous, guest and self bypasses create no identity dependency.
List projections retain outgoing-only semantics; direct/profile relationships
remain bilateral. A later deny or a weaker-purpose allow never overwrites an
already recorded allow requirement.

After deferred constraints and before optional count proofs, Safety takes
`LOCK TABLE whaleu_safety.blocks IN SHARE MODE NOWAIT` and rereads the recorded
pairs in bounded 256-pair set queries. The fresh READ COMMITTED reread closes
absent-pair INSERT and inactive-to-active UPDATE races. The table fence prevents
new raw transitions until commit. Conflict, newly denied relationships, stale
isolation, malformed results or resource exhaustion fail the mandatory request
closed rather than merely nulling its count. No subsequent locking source read
is allowed. Existing locked head coverage and required expiry checks still apply.

The registry belongs to each managed transaction. Opt-in outside a managed
transaction is rejected. It uses append-only immutable facts and O(1) dedupe keys;
checkpoints save per-owner lengths, and rollback removes appended facts and their
keys together. Transaction start/clear prevents state from surviving pooled-client
reuse. Required proofs run even without a finite time horizon.

The conservative 110,000-fact ceiling derives from existing successful page
limits, not total history: 50 selected posts, each with up to 1,024 allowed
comments, 1,024 allowed replies and 20 formation members plus repeated parent
projections; and at most 129 liked chains of depth three. The count snapshot
facades do not feed this registry. The final mandatory owner phase has a 500 ms
elapsed budget and remaining-budget statement caps. This deliberately avoids a
new 256- or 4,096-author limit on previously supported selected-page work.

Explicit owner enrollment also covers ordinary current emitting reads and the
audited identity POST. The [named-read finalization document](NAMED_READ_FINALIZATION_GAP.md)
records routes, directionality, v3 discussion cursor and audit-scope semantics.
Controlled block/unblock, historical receipts, own blocked-name cleanup and worker
materialization remain intentionally outside this unchanged-relationship read
proof. This does not establish universal mutation/raw-writer protection or
production readiness.

## Fixed transactional writer slots

Each owner has exactly 128 immutable metadata slots, each with format version 1
and a checked nonnegative bigint epoch. Every relevant source statement claims a
free exclusive transaction advisory slot using try-lock and increments its epoch
in that same transaction. A transaction reuses its one slot for every subsequent
statement and target under that owner. Source and epoch rollbacks are atomic;
no-op statements may conservatively invalidate a count.

Claim reuse is verified against the current backend's actual granted exclusive
advisory locks, never a custom setting or application cache. Even when a selected
lock is session-owned, the trigger explicitly acquires transaction ownership so
a later session unlock cannot remove the mutation fence. Savepoint rollback
releases a new claim together with its source/epoch changes. Epoch reset, insert,
delete and truncate are rejected; valid nested source statements may only advance
the existing counter. Bigint overflow is an error, never wraparound.

Namespace integers are 1464356101 (community), 1464356102 (safety), and
1464356103 (campus), with slots 0–127. The separate notification key is 128.
These keys are reserved for the proof implementation; application/maintenance
code must not acquire arbitrary additional slot locks or disable owner triggers.
As with existing policy integrity, superuser DDL/trigger bypass is outside the
source-mutation contract.

## Writer progress and the supported server envelope

The implementation does not introduce a 64-writer admission limit. Epoch proofs
are supported when the following actual, postmaster-stable configuration sum is
strictly less than 128:

- `max_connections`
- `max_prepared_transactions`
- `max_worker_processes`
- `max_wal_senders`

Worker processes are included conservatively. Database-connected WAL senders may
execute ordinary SQL before streaming. Autovacuum, bgwriter, checkpointer and
other auxiliary maintenance processes do not make logical business-row DML and
are excluded. Prepared transactions retain their slot and are explicitly counted.
A restart is required to change these settings, so an active proof cannot cross
a server-capacity change.

The backend bound was checked against PostgreSQL 18.6 source:
`src/backend/utils/init/postinit.c`, `InitializeMaxBackends`, includes connection,
worker and WAL-sender slots separately. `src/backend/replication/walsender.c`,
`exec_replication_command`, returns non-replication commands to the ordinary SQL
executor when the WAL sender has a database connection; only physical replication
connections reject that path. This is why `max_wal_senders` is not omitted.

A final reader first tries the exclusive owner notification gate and then tries
shared locks on all 128 slots. A new writer that encounters all slots fenced
acquires the notification gate in shared mode, waits only for final readers, and
retries its slot scan. Notification readers never perform a later blocking source
read or deferred constraint check. Notification writers are mutually compatible.
Once final readers leave, the checked backend bound guarantees a free slot: each
possible source writer owns at most one. There is no new writer-to-writer epoch
wait or incremental multi-target gate ordering.

On larger servers the epoch path explicitly returns no proof and the mutation
triggers retain normal source writes without epoch admission. An independently
fenced, bounded small-count fallback can still provide an exact count; larger
counts remain unavailable until an appropriate proof envelope is implemented.
This is an explicit operational limit, not a request to lower server capacity.
There is no resettable sequence or nontransactional mutation-generation shortcut.

## Audited source coverage

Every listed table has a `BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE` statement
trigger, covering raw SQL and first-insert/absence as well as service writers.

- Community: spaces; posts, root comments and replies; all three image tables;
  all three like memberships; polls and poll options; formations and formation
  members; trading listings; review policies, decisions, events and heads;
  publication approval bindings
- Safety: account coverage heads and directional blocks
- Campus: operating regions

The existing common policy gates are retained for review/campus writers; safety
head creation does not acquire a new common exclusive gate after account locks.
This avoids reversing identity lifecycle versus readers' lock order. Poll ballots,
ordinary counters, profile display text, cursor storage and request/outbox records
are not eligibility inputs. Formation member changes are conservatively covered
even though only the creator definition is reconstructed.

A statement claims a slot before source changes. Existing application row locks
may already exist; epoch acquisition never waits on another writer. Metadata rows
also use `FOR UPDATE NOWAIT`, preventing an unexpected direct metadata locker from
introducing a new source-writer cycle. Any later source-lock behavior is unchanged.
All current count-domain foreign keys were audited: no current cascading-delete
path adds an unreviewed writer order. The increment guard also supports genuinely
nested future source statements rather than hard-coding trigger depth two.

## Proof and fixed resource footprint

Each optional count scan has a **2,000 ms** monotonic budget. This is per count,
not an HTTP timeout: profile basics can run two scans, followed by two 600 ms
optional finalization envelopes and the 500 ms required relationship proof, for
5.7 seconds of configured phase allowances. A profile list or liked list has one
scan and one optional callback, for 3.1 seconds including the required proof.
Mandatory initial/page work, scheduling and recovery add elapsed time. The existing
shared policy gate and mandatory row locks remain held until commit; compared
with the previous 1,500 ms setting, scan allowance grows by 500 ms per count and
by 1 second for two-count basics. The 15-second internal benchmark is separate.

Admission remains at most two active scans/final recounts per application instance
and at most `PG_POOL_MAX - 1`, preserving a pool slot for mandatory work. Source
statements remain capped at 100 ms and the remaining scan allowance, lock waits
at 25 ms, and each batch at 4 MiB reconstructed wire data. The change does not
extend the final proof, small recount or required relationship-proof budgets.

Initial epoch vectors precede candidate traversal. The finalizer acquires all
owner gates in namespace/slot order and only then rereads the vectors in fresh
READ COMMITTED statements. An uncommitted relevant writer conflicts with a fence;
a committed mutation changes an epoch. A writer starting after final fences waits
until the reader finishes. Equality therefore proves that the exhausted keyset
traversal describes one current set at the final database clock.

Retained metadata is 384 rows, independent of history, candidates, authors or
scopes. Successful final proof holds 387 advisory locks, plus bounded relation
locks and the mandatory page/target locks. An empty history uses the same proof.
The first version is deliberately conservative: any relevant owner mutation may
invalidate an unrelated count. The bounded small-count recount fallback and later
more precise owner shards/rollups address availability without weakening proof.

Capture uses four source statements (mode/capacity and three vectors). Optimistic
validation uses nine owner source statements (three notification fences, three
slot-fence sets, three vector reads), plus one timeout read and per-statement
remaining-budget configuration. Its monotonic elapsed budget is 100 ms; each
source statement is capped by the remaining budget and any smaller inherited
statement timeout. The registry permits a 600 ms total callback envelope so a
separately bounded 500 ms small-count recount can follow an unsuccessful epoch
proof. These are resource budgets, not authority clocks. Scheduling and rollback
cleanup overhead cannot be made hard real-time promises.

## Regression coverage

`test/count-proof.test.ts` covers explicit isolation, deadline-free proof runs,
checkpoint rollback, exact bigint comparisons, malformed vectors, independent
field invalidation, owner ordering, optional SQL errors, and unsupported capacity.
`test/integration/exact-count-proofs.test.ts` exercises real forward migration,
every trigger table, retained metadata, transactional/savepoint rollback, first
insert, session-lock reuse, partial fences, raw head/scope changes, deferred waits,
final clocks, writer progress and more than 64 simultaneous source writers.
`test/safety-relationship-proof.test.ts` checks required proof rollback, pooled
reuse, directionality, prior-allow preservation, mandatory failures and 387-pair
liked chains. The normal-AppModule integration counterpart exercises actual raw
INSERT/reactivation races across profile basics, profile pages and liked pages in
both directions, plus intended controlled block/unblock and guest/self bypasses.
`test/integration/named-read-finalization.test.ts` separately exercises the
additional emitting routes, exclusions and outgoing-only/bilateral boundaries.
