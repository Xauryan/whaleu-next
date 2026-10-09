# Rating target creator cleanup (M2A)

Status: implementation in progress. Initial API and native runtime type checks
passed; native test compilation needs a rerun after a target-library compatibility
fix. Unit, generated OpenAPI, PostgreSQL and final integrated acceptance remain
unrun. This is a development slice, not a
production-readiness or full target-management claim. M2B multi-version target
editing remains open.

## Authority and content boundary

Only the immutable target creator can delete it. Administrator status gives no
additional target permission. The existing active-account, phone and global
Safety cleanup checks remain required. Current school affiliation, public catalog
membership, active target, accepted Review and source-score availability are not
cleanup prerequisites.

A known target locator authorizes only a lookup attempt. Successful creator context
returns exactly targetId, revision and deletion.kind (`not_owner_deleted` or
`owner_deleted`). It returns no name, description, creator/profile identity,
region, original campus, source, review information, score or descendant counts.
Normal inactive and owner-deleted are separate facts. There is no hidden-target
history enumeration or content visibility exemption.

## Routes

All routes use bearer sessions, strict fields, no-store and Vary Authorization,
plus the existing shared rating-account request budget.

Prefix: `/v1/ratings/management/owner-deletion`.

- GET `targets/:targetId/context`: creator-only minimal context.
- POST `targets/:targetId`: body `clientRequestId, expectedTargetRevision`.
- POST `cancel`: body `clientRequestId, targetId, expectedTargetRevision`.
- GET `requests/:requestId`: own historical deletion receipt.

Canonical original intent includes all three request/target/revision fields.
The hash domain is `whaleu:rating-target-delete:v1`, operation `delete_target`.
This shares the account/request namespace with every earlier rating command and
M1 preparations. Reusing a key with changed target, CAS or operation conflicts.

Fresh deletion checks ownership/cleanup eligibility and exact CAS before noop.
The first owner deletion always creates a new lifecycle UUID and typed tombstone,
even if the target was already inactive. An exact-CAS request for an already
owner-deleted target returns noop without a lifecycle mutation. Stale-CAS is never
silently accepted as noop. Tombstones cannot be removed or reactivated.

Success receipts contain requestId, operation, applied/noop outcome, targetId,
revision and occurredAt. A noop timestamp records that command's observation;
its source tombstone and original deletion time remain unchanged. Rejected
receipts contain only requestId, operation, outcome and code. Durable rejection
codes are RATING_NOT_FOUND, RATING_REVISION_CONFLICT, PHONE_VERIFICATION_REQUIRED,
SAFETY_ACTION_RESTRICTED and RATING_TARGET_DELETION_CANCELLED. Missing/unknown
authority, infrastructure failures and failed final proofs roll back rather than
minting a rejection.

An existing exact receipt wins before current cleanup eligibility. Another valid
session on the same account can recover it. It proves history only, not current
content or permission. Other accounts and wrong operation receipt lookups return
REQUEST_NOT_FOUND. Cancellation closes the exact original key; an earlier applied
or noop receipt wins. Cancellation never restores an already deleted target.

## History and SQL causality

Migration 0056 preserves migrations 0001–0055 and adds deletion audits,
tombstones and terminal closures. An applied command binds request/hash/intent,
real creator and before-state, database-minted time, lifecycle state event,
tombstone and receipt in the same transaction with forward and reverse checks.
All historical rows are retained; audit/tombstone/closure mutation and TRUNCATE
are rejected. No general target editing or true-to-true revision mutation opens.

Public paths keep the existing active-target gate. R3R continues to scan complete
paths and excludes inactive targets under its existing mutation epoch. Existing
reply/like/subscription notifications reauthorize on read and become minimal
unavailable metadata, rather than exposing retained hidden previews.

Scores, score summaries/revisions, baselines/sources, personas, comments/replies,
likes, subscriptions, original campus, captured Experience obligations, old
requests and notification history are not rewritten. No new rewards, notices,
unlikes, unsubscribes, deductions or child-deletion fan-out is created. Existing
child-content authors retain the R3A metadata cleanup path. Already captured
Experience units remain settleable under their original rules.

Mutation lock order is common exclusive Safety before command and parent locks;
new tombstone statement triggers take that gate before pool/navigation epochs and
row guards. Applied final proofs retain after-state only, never an old public
active-target fact invalidated by their own mutation.

## Native recovery

The independent owner-deletion page accepts only a known target ID. It can open
without successful public target loading and never uses old cached text as a
fallback. Deletion requires explicit confirmation. Native v6 adds only
`delete_target` to the existing single account/origin pending slot; v1–v5 retain
their original decoding, storage keys, payloads and hash semantics.

An original intent is frozen before network work. Close, Back, account changes,
transport errors and missing receipts never silently clear it. Recovery performs
own receipt lookup or retries the same command. Explicit server-confirmed
cancellation can close it. A receipt is never rendered as a current target;
normal content must be refreshed and independently authorized afterward.

## Remaining work

See the M2A acceptance record for checks actually run. Real device/provider
acceptance, production sources and history import remain separate gates.
Multi-version editing, category management and school overrides are not part of
M2A and remain required later work.
