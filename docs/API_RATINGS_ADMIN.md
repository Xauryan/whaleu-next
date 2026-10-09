# Ratings deletion authority (R3A)

This local development slice covers one root/reply deletion at a time and author
cleanup beneath hidden parents. It does not implement category/target management,
bulk moderation, role appointment, real provenance import, full-text administrator
access, appeals, external notices or production enablement. See
[acceptance status](acceptance/ratings-r3a.md).

## Shared cleanup eligibility

A current authenticated active account, verified phone and permitted global
Safety status remain necessary. Deletion does not require current affiliation,
a selected campus, anonymous-publication privileges, accepted content review,
public catalog membership or a named bilateral relationship. Those independent
checks still protect publication, public reads, likes and subscriptions.

The immutable content author alone may use the existing owner DELETE routes.
Nonowners receive RATING_NOT_FOUND; an administrator cannot use the owner route
on another person's behalf. The old owner operations, canonical hash domains,
command payloads, receipt fields and request recovery remain unchanged. regionId
in an old owner command is retained as intent data, never as deletion authority.
All supplied parent locators and revision CAS values are still checked. A stale
CAS is not a noop.

GET `/v1/ratings/comments/:id/deletion-context` and
GET `/v1/ratings/replies/:id/deletion-context` return only the current owner's
metadata: subjectKind, targetId, rootId, subjectId, regionId, targetRevision,
rootRevision, revision and deleted. Root contexts use rootId=subjectId and
rootRevision=revision. They contain no text, author identity, persona, quote,
category or review evidence. A known locator can be used after ordinary content
navigation becomes unavailable; this is not a historical enumeration endpoint.

## Independent administrator authority

Only canonical Authorization role grants qualify. A global developer/super-admin
grant can authorize the real target/subject chain even with unknown origin. A
school-admin grant must match the current authoritative Campus mapping of the
target's original campus. Neither the author's current affiliation, the target's
region label, category membership nor a Profile title supplies original-school
provenance.

`target_origin_sources` is immutable accepted evidence with an independently
versioned `target_origin_heads` pointer. Known-school, explicitly schoolless and
unknown facts are distinct; absence is independently proved. No migration
backfills origin from another subsystem, and no public writer or real source is
seeded. A fixed grant fails unavailable when origin or mapping cannot be proved.
Global audit records retain the observed state without inventing a campus.

## Administrator contexts and commands

- GET `/v1/ratings/admin/comments/:id/deletion-context`
- GET `/v1/ratings/admin/replies/:id/deletion-context`
- DELETE `/v1/ratings/admin/comments/:id`
- DELETE `/v1/ratings/admin/replies/:id`
- GET `/v1/ratings/admin/requests/:id`

Administrator contexts add an opaque contextRevision to the same minimal
metadata. The short-lived context binds actor/session, global eligibility,
subject chain/revisions, selected grant and complete grant fingerprint, origin
source/absence and Campus mapping version. It is a confirmation/CAS reference,
not a replacement for fresh authorization. The command re-proves every source.

Root DELETE accepts only clientRequestId, targetId, expectedTargetRevision,
expectedRevision and expectedContextRevision. Reply DELETE additionally requires
rootId and expectedRootRevision. Actor, role, region override, free-text reason,
client time and author fields are rejected. Explicit typed operations are
admin_delete_comment and admin_delete_reply.

The hash domain is `whaleu:rating-admin-delete-command:v1\n`. All rating command
families still share one account/request namespace: a key cannot change between
owner, administrator, likes or subscription commands. Exact receipt replay is
checked before applying current deletion authority. Same-key/different-intent
requests conflict.

Success receipts contain only requestId, operation, outcome (applied or noop),
targetId, rootId, subjectId, revision and occurredAt. A new noop still requires
current authority and exact CAS, and references the original effective deletion
transition/time without a second lifecycle effect. Owner deletion followed by
administrator noop, administrator deletion followed by owner noop, and another
administrator's noop do not relabel the original actor.

Historical receipts are recoverable by their authenticated account through a
current valid session even after the grant disappears. They are not current
content access. Unknown authority, failed final proof and infrastructure failures
roll back instead of inventing terminal rejected receipts. An invalid/expired
context returns RATING_DELETION_CONTEXT_CHANGED; the client must recover any
pending key first, fetch a new context and obtain a fresh confirmation.

## Database causality and concurrency

Migration 0053 is additive; prior migration contents stay unchanged. Live rows
have neither deletion cause. A tombstone has exactly one owner request or typed
administrator audit. account_id remains the author. Administrator audits bind
actual actor/session, shared request/hash, subject and parent chain, before/after
revisions, exact authority evidence and outcome. Deferred constraints prove the
request, audit, transition, effect and receipt bidirectionally.

Administrator transitions stay in the existing root/reply transition stream,
including reply_heads. Each applied deletion has exactly one lifecycle effect
with source_version=4 and rule_version=rating-admin-delete-v1. It has zero new
Experience, direct notice or subscriber fan-out obligations. Scores, like
memberships, counts and historical rewards are unchanged. Root tombstones hide
all descendants without bulk rewriting each reply. A remaining live reply can
be independently deleted beneath its tombstoned root.

The lock order is shared Safety gate, session/account, fresh request, eligibility
and authority sources, target, root, reply, then typed causes/effects. Origin
writers use the exclusive Safety gate, origin head and target. Raw child-first
writes take missing parent locks with NOWAIT. Metadata deletion proofs retain
inactive target observations without weakening public active-target proofs.
Deferred constraints finish before bounded mandatory proofs and final session
validation; final fences never introduce a new blocking wait. Precise SQL time,
source versions and absence proofs prevent future activation, expiry and ABA
from silently authorizing a stale context.

## Native flow and remaining decisions

The native client uses an explicit metadata-only deletion panel, separate owner
and administrator actions, fresh confirmation and the shared account/origin
pending slot. It does not probe administrator scope for every list item or turn
another author's ordinary delete flag on. Admin recovery has a separate receipt
and journal discriminant; old owner journals continue to decode unchanged.

Cumulative received-like display/deduction after deletion remains a product
decision. No extra administrator-deletion notice, appeal or full-text read
permission is inferred. Authoritative production origin imports, real role
grants, provider/device acceptance and the remaining administration features are
outside this slice.
