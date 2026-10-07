# Named blocking S1A

This provider-independent slice implements directional named-content blocking,
owner-only unblock/list/status, durable recovery, and real local block enforcement
through community-owned access. It does not implement reports, juries, review,
bans, restriction issuance, grants, providers, production imports or moderation
parity. Runtime community base visibility/publication authority remain unavailable
until their independent authoritative sources exist. Real block facts never turn
an unavailable aggregate into allow. Synthetic test adapters are test-only.

## Public API

All routes require a current active session and reject unexpected fields/query
parameters. Private account IDs, source author overrides, incoming rosters,
private profile lookups and anonymous owner resolution are not accepted.

- `PUT /v1/me/safety/blocks`: `{clientRequestId, source:{kind:'post'|'comment'|'reply',id}, blocked:true}`
- `PUT /v1/me/safety/blocks/:relationshipId`: `{clientRequestId,blocked:false,expectedRevision}`; revision is a positive decimal string
- `GET /v1/me/safety/blocks?limit=20&cursor=...`: maximum 50; opaque own relationship ID/revision, blocked-at timestamp, current safe named display or explicitly labeled snapshot, removable state
- `GET /v1/me/safety/blocks/:relationshipId`: own current `{relationshipId,blocked,revision}`
- `GET /v1/me/safety/block-requests/:requestId`: minimal immutable receipt plus separate current own relationship state

Mutation and recovery return `{receipt,current}`. Applied receipt contains
request ID, operation (`block_named`/`unblock_named`), outcome, opaque relationship
ID, original desired state and original revision. Rejected receipts contain only
request ID, operation, outcome and safe error code; `current` is null. Receipts
are account-owned and recoverable from any current active session for that same
account. Recovery does not require the old source, current phone or restriction
eligibility and cannot change state. Reusing the same account/key with a different
normalized payload conflicts. Replaying an old block after a newer unblock returns
the old receipt and newer inactive state, never reactivating the relationship.

A fresh block command resolves current accessible content through the community
owner, then rejects anonymous/self sources. Already-blocked source access may
reject a fresh request; matching committed request recovery remains available.
No-op state changes add no relationship revision or transition event. Original
source kind/ID and creation time are immutable; reactivation refreshes only the
safe display snapshot and current transition timestamp/revision.

## Eligibility and cleanup

New native accounts receive explicit empty block/restriction coverage and an
audit event only inside identity's account-creation transaction. Migration and
later login do not infer empty history for existing/imported accounts. Missing,
conflicting, unprovenanced or expired coverage is unavailable.

Block, unblock, own list and own state require only canonical verified phone and
known allowed safety-action policy, plus active authentication. Affiliation,
student number, student status, identity campus, selected browse campus, category
and grants do not establish or gate these actions. Verification's narrow owned
phone facade retains validity bounds without revealing phone binding information.

Unblock/list do not require the source or target profile to remain readable or
present: opaque ownership allows cleanup after parent deletion or access loss.
This slice deliberately retains phone and known restriction gates for these
operations. It does not introduce an owner-unblock exception for banned,
unverified or restricted accounts. Minimal receipt recovery remains session-only.

## Purpose matrix

All entries retain ordinary live/approved/scope/ancestry/media/authority gates.
Anonymous subjects contain no account/profile ID and never consult block pairs.

| Consumer                                 | Block checks                                                                                                             |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Feed card                                | Outgoing viewer → named post author                                                                                      |
| Direct post and normal post interactions | Either direction on named post                                                                                           |
| Root/reply list and location             | Post either; root and child outgoing                                                                                     |
| New comment                              | Named post either                                                                                                        |
| New reply/reply-to-reply                 | Named post, root and explicit reply target each either, regardless of submitting author mode                             |
| Child likes/pins                         | Read ancestry only; child outgoing, no invented bilateral child rule                                                     |
| Saved preview/read                       | Direct post either; owner cleanup remains separate                                                                       |
| Local Updates preview/deep link          | Post either; root/child/visible reply-target outgoing; no hidden event-actor lookup                                      |
| Formation roster/contacts                | Post either; ordinary named member outgoing; creator follows actual post mode; existing contact/member authority remains |
| Developer content identity               | Same ordinary target route before separate authorized audited private disclosure                                         |

A reverse-only named post may appear in discovery and fail direct access. Its
formation roster component is omitted; contacts remain direct-gated. Own-block
copy (`POST_BLOCKED_BY_YOU`) is available only on direct post detail after live,
scope and base access succeed. Other denial paths are generic absence. A named
profile resolver is deferred: follow-on must preserve authorized outgoing and
incoming flags plus canBlock/canUnblock, including incoming-only Block suppression.
That intended profile behavior is unfinished parity, not prohibited functionality.
There is still no raw-account relationship oracle, incoming roster or anonymous
profile lookup. Anonymous-conversation blocking is separately deferred.

## Transactions, locks, deadlines and capacity

All work is local PostgreSQL only. The bounded S1A implementation uses a coarse
transaction advisory policy gate before community/session/content locks. Ordinary
reads and interactions hold it shared; named-block transitions hold it exclusive
through commit. Thus absent pairs and reciprocal intents are serialized without
read-to-write lock upgrades. Mutation also locks a deterministic sorted reciprocal
pair key. This deliberately prioritizes correctness over mutation concurrency;
finer-grained lock partitioning is follow-on work, not current capability.

Order: policy gate → authenticated account/session/token → request key → safety
coverage/verification → content parent/root/target → sorted pair → relationship,
audit, receipt. Updates worker/read and privileged identity entrypoints acquire
the gate before their own notification/grant locks. Writers of future safety
policy/coverage must obey the same exclusive-gate contract. No provider/network
call belongs under any transaction lock.

Locked session, finite phone and coverage deadlines are registered with the
transaction owner. Immediately before COMMIT, pending deferred constraints are
forced, then a fresh database clock validates every registered deadline. No
further application data read/write follows that clock. Savepoint rejection
restores speculative deadlines while preserving authentication bounds. Expiry,
audit/storage/commit failure cannot return success or commit a partial relationship.
Receipts and transition audits are durable and immutable; safety cleanup never
prunes them or deletes inactive pair history.

New abuse-control policy (not source-inherited numbers): 30 fresh mutation
requests per account/action/minute and 120 own reads/recovery/replays per account
per minute. Committed replay consumes no fresh mutation allowance. Rate storage
is one row per account/action; counters reset by database minute and replies use
a safe 60-second Retry-After. These are bounded static S1A limits, not configurable
policy yet. Lists default to 20/max50 with account-scoped cursors. Old migrations
remain unchanged; schema0014 is forward-only, and all disposable integration
refusal/cleanup guards share the full migration schema list.

## Verification boundary

Tests use synthetic local accounts, phone assertions, scoped test authority,
approved content and media adapters only. No real provider, roles, credentials,
production data or new institution SSO is activated. Native stale response and
account/session fencing, real PostgreSQL concurrent/replay/expiry tests and the
full aggregate checks are required before publication. This document describes
the implemented contract, not a production-readiness declaration.
