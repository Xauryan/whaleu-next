# Bounded view reporting: development scope

This partial increment implements fresh-post aggregate views and explicit native
feed/detail reporting. It does not add public view counts, hot ranking, historical
view import, search exposure tracking or author received-interaction totals.
Local full regression has passed; see [acceptance](acceptance/view-reporting.md).
Hosted verification and production/device acceptance are separate.

## Reporting and bounded recovery

Authenticated accounts may report without phone/student verification. Self views
count. List reporting follows current list-projection visibility; detail follows
current direct-post visibility. Missing/known denied/view-unknown targets are
omitted without per-target disclosure. Unavailable policy or infrastructure fails
the whole batch rather than pretending it accepted zero. Ordinary GET reads stay
read-only.

`POST /v1/me/community/view-reporting-epoch` accepts exactly `{version:1}` and
returns `{version,epochId,issuedAt,collectionUntil,expiresAt,serverNow}`. Epochs are
server-issued, account-owned UUIDs, not credentials. Issuance reuses the current
hourly collection epoch without extending it. Each epoch expires 24 hours after
issuance. New observations normally have about 23–24 hours of recovery, rather
than a fresh 24-hour lifetime individually. Offline after the collection window,
the client stops collecting new events but can retain already-bound pending work.

`POST /v1/me/community/view-reports` accepts exactly
`{version:1,epochId,batchId,kind,postIds}`. List exposure has 1–50 events and preserves
duplicates; detail visit has exactly one. A receipt returns exactly
`{version,epochId,batchId,kind,payloadFingerprint,acceptedCount}`. It contains no
accepted/denied post list or current public count.

The fingerprint is SHA-256 of the UTF-8 JSON representation of
`[1,kind,sortedPairs]`, where pairs are lowercase post UUID and occurrence count,
sorted by UUID. It covers all submitted events, including ineligible ones.
Equivalent reordered multisets replay the original result; changed kind or
multiplicity conflicts. Authentication and live epoch ownership remain required.

Expired or missing epochs are closed permanently. An uncertain batch is never
moved to a new epoch or batch identity. Already committed aggregate increments
remain. An expired result means recovery is unavailable, not proof the batch was
never counted. A matching live receipt replays its original acknowledgement even
if the post later becomes hidden or deleted.

## Transactions and fresh-only coverage

Fresh native publication enrolls the view baseline in its original transaction,
with matching creation, publication receipt and native-origin proof. Historical
posts and old publication receipt replay do not gain a fabricated zero. View
coverage is independent of like/subscription coverage.

Reporting uses current authentication and the common safety gate, account/epoch
serialization and sorted parent locks. Receipt, quota, aggregate deltas and detail
cooldown commit atomically. There is no unreceipted fallback or second server
queue. Detail counting has a fixed 300-second actor/post cooldown; duplicate visits
do not extend it. List exposure and detail counting are independent.

The existing database wrapper rechecks deadlines after deferred constraints and
privacy proofs immediately before COMMIT. This is a final acceptance fence, not a
promise that physical WAL completion or the HTTP response arrives before expiry.
Epoch locks remain held while the transaction resolves, preventing cleanup races.

## Native lifecycle and retained data

Only rendered active feed cards qualify at ratio ≥0.5 continuously for one second.
Repeated callbacks or appending another page do not recount the same uninterrupted
interval. Leaving/re-entering, or a new page-show session, may qualify again.
Detail records one positive-viewport presentation per page-show/navigation, not
network prefetch, comment pagination, refresh or every GET.

Pending work is scoped to API origin and authenticated account, persisted and
read-back verified before transmission. Retries preserve frozen identity. Valid
receipt matching is required before removal; failed removal leaves the same batch
recoverable. Account changes, hidden pages and stale callbacks cannot mutate a new
owner's work. Expired in-flight settlement is harmless after expected pruning.

The queue has bounded owner/event/batch/byte capacity, drops new observations at
capacity and may evict an inactive owner. These are best-effort telemetry limits,
not guaranteed event delivery. All-owner expiry cleanup runs independently of
network/authentication while foreground, and before work resumes. Clock rollback
pauses collection until server time is re-established. A closed/suspended app
cannot physically erase storage until it runs again.

Server receipts retain fingerprints but no raw post lists. Short-lived detail
cooldowns contain the actor/post association required for deduplication. There is
no permanent actor/post browsing ledger. Fingerprints remain potentially
identifying metadata; they are not described as anonymous.

## Reused modules and operational retention

- Official `@nestjs/schedule` 12.0.2 triggers startup and 60-second cleanup in the
  explicitly enabled HTTP runtime; default/manual application contexts start no job
- Official `@nestjs/throttler` 6.7.1 provides the request guard, backed by a shared
  PostgreSQL storage adapter whose attempt budget commits outside the business
  transaction
- `js-sha256` 1.0.0 supplies native hashing; the build copies its browser/CommonJS
  distribution and MIT license to a relative native artifact, without Node crypto
  or a runtime npm resolution requirement

Business receipt quotas, current visibility, final deadline checks and cleanup
races remain project-owned. Per-process scheduler overlap protection is not a
distributed lock. Cleanup uses database locking/SKIP LOCKED, bounded work and
expiry rechecks, never removes live receipts or changes aggregate counts. HTTP
reporting fails closed if retention is unhealthy. Shutdown waits for in-flight
cleanup before closing the pool.

Logical expiry is immediate for admission; physical cleanup normally follows the
next healthy sweep. Downtime, backups/WAL and suspended clients need separate
operational retention verification. No exact-instant physical erasure or
production deployment is claimed. See [API operations](../apps/api/README.md).
