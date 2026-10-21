# Permanent community references

## Implemented boundary

The additive owner lives in `apps/api/src/community/content-references`. Migration 0171 seeds an inactive policy, empty immutable reservations/canonicals, and transactional range counters. It neither imports content nor initializes allocation nor exposes public capability. No runtime initializer, production importer, external service or provider is introduced. `source_kind` admits synthetic fixtures only. Production activation needs a separately reviewed provenance/schema migration and an authoritative inventory, not ad hoc updates to these policy rows.

UUID resource routes, discussion pagination, publication request hashes and stored receipt schemas are unchanged. A canonical code is optional for historical/unbackfilled content; readers never allocate or invent one. Native post allocation uses 8 digits; roots and replies share one 9-digit sequence. The historical 7-digit counter is reserved for a future verified import, not selectable by a public caller.

## Publication integration

Register `ContentReferenceRepository`, `ContentReferenceAllocation`, `ContentReferenceService` and `ContentReferenceController` with the community module. `PublicationRepository` requires the allocation owner before its optional review runtime:

`allocateForPublication({ kind: 'post' | 'comment' | 'reply', targetId: UUID }, tx)`

Call once after a successful `create` and the review-only guard, inside `publication_work` and before its release. Stored-receipt replay exits earlier and never calls allocation. A terminal rejection or review-only submission allocates nothing. The hook is a trusted publication-owner boundary, not an arbitrary target-creation API.

- Inactive: observe policy and acquire a compatible shared policy fence. Return `{state:'inactive'}`. Existing ordinary publication remains usable.
- Initialization wins the inactive fence race: fail unavailable and retry the complete publication; do not upgrade a shared lock or publish without the newly required number.
- Allocating/ready: acquire the exclusive policy lock, replay the existing canonical mapping or lock the relevant counter and allocate. Public resolution can remain off during allocation.
- An allocator fault, range exhaustion or work-budget exhaustion throws `COMMUNITY_UNAVAILABLE`, which is not a terminal invalid-content receipt. The transaction rolls back content, bindings, outbox effects, numbers, counters and request state together.

Lock order is existing business/authority owners, policy, sequence, reservations. Future import/backfill writers must acquire business locks before the allocator fence, never invert this order. Readers observe readiness without a policy lock first, acquire canonical content/ancestry/visibility locks, then fence readiness with a shared policy lock before their final session recheck. Capability has no business content locks.

## Permanent reservation model

Canonical and alias numbers share the primary key of one reservation table. A typed-target canonical relation references that exact `(code,kind,targetId)` tuple. Width never determines kind. An already reserved candidate for the exact same typed target may become canonical without rewriting its reservation. The same UUID with a different kind is a different target and must be skipped. Other reserved numbers for the same target are aliases; an orphan reservation can have no canonical at all. Reservations and canonical bindings reject update, delete and truncate. They have no content/account foreign keys and survive removal; ephemeral quota rows alone reference accounts with cascade deletion.

Counters are transactional rows, not PostgreSQL sequences. A failed transaction leaves no committed reservation or advancement. Counters cannot rewind, ranges cannot change and initialized cutoff/provenance cannot change. Existing canonical replay succeeds even after range exhaustion. Allocation probes at most 4,096 consecutive candidates, consulting the global reservation PK for each; encountering a fully occupied scan window is explicit unavailable even if the wider range still has room. It is not a false claim of numeric exhaustion, does not skip/advance silently, and needs trusted inventory/high-water reconciliation before allocation resumes. No allocator reads a full discussion or source inventory.

## Authenticated read API

All three routes use ordinary browse/entry account policy, current actor/session checks at entry and completion, `Cache-Control: no-store` and `Vary: Authorization`.

- `GET /v1/community/content-references/capability` → `{available:boolean}`. Inactive/incomplete/disabled policy yields false; missing/corrupt dependency is unavailable.
- `POST /v1/community/content-references/resolve` takes `{code,viewSpaceId?}` and returns a strict navigation destination with kind, post UUID, and stored root/reply UUIDs where applicable. It returns neither alias/canonical identity nor body, author or media. Unknown, deleted and unreadable targets have the same `REFERENCE_NOT_FOUND` response. Infrastructure faults remain unavailable.
- `POST /v1/community/content-references/lookup` takes 1–30 `{kind,targetId}` targets and optional view scope. Targets are deduplicated and ordered deterministically. Only existing currently readable canonical codes are returned. Missing/unauthorized entries are omitted, and no missing code is allocated.

Resolve and lookup reuse `CommunityAccessService.accessiblePost`, `accessibleComment`, `accessibleReply`, and mandatory final Safety relationship proofs. This includes current post category, owner-hidden semantics, deleted ancestors, reply/root/post matching, named blocks, anonymous isolation and current session/scope. No manager bypass is added. The selected-view helper duplicates the exact current `FeedService.detail` distribution sequence (`space`, `resolveView`, current category, `allows`) to avoid an unrelated shared refactor in this slice. Keep those owners in parity. UUID case is normalized before same-space comparison.

A returned destination is a hint, not a grant: the existing detail/located-discussion route reauthorizes after navigation. References do not become discussion cursors or pagination positions.

## Limiter and privacy

An atomic PostgreSQL upsert allows 60 resolves and 120 lookup requests per viewer/minute. Storage is two bounded rows per account, not one growing row per minute. A conflict waits for the current request and only increments below the cap. Moving time backward cannot reset a bucket. Unknown/unreadable outcomes are returned internally and converted to an HTTP error only after transaction commit, so enumeration misses consume quota. Dependency/session/proof faults roll back and fail unavailable/revoked, never return a stale destination or a false empty result.

No reference-generated telemetry records code, mapped target, account identity or content. Existing generic HTTP telemetry records method/status/duration/request ID only.

## Verification and remaining boundary

Focused tests cover strict contracts, source immutability, inactive/required allocation, shared child sequence, replay ordering, actual publication savepoint hookup, rejection/review-only exclusion, unavailable rollback classification, alias-free responses, current-authority dispatch, negative-outcome quota commits, final session expiry and OpenAPI. The dedicated real AppModule/PostgreSQL suite is `apps/api/test/integration/content-references.test.ts`; it covers all three publication hooks, original receipt replay, alias/orphan collisions, SQL immutability, rollback after allocation including actual Media/Review bindings, same-target concurrency, shared roots/replies, hidden-parent/manager/block/anonymous behavior, root deletion, queued canonical post deletion, malformed ancestry at the second-read adapter boundary plus schema reparenting rejection, raw uncommitted block final-proof rejection, selected-space revocation during a row wait, final session expiry during a limiter wait, unrelated view denial, concurrent quota excess, bounded collision scans and range exhaustion. Tests only run against the preexisting disposable-loopback fixture contract.

The scope-race fixture revokes the original/same selected space; it does not establish a cross-campus distribution-policy-change race. Cross-campus ordinary denial is covered separately.

The implementation author ran focused unit tests only while central full-suite gates were active. Compilation, the new PostgreSQL integration suite and aggregate checks must be run by the central owner against the final assembled candidate; writing these tests is not evidence that they passed.

Not implemented or claimed: a real legacy crosswalk, original canonical/alias inventory, legacy v1-to-v2 remapping, resumable production backfill/checkpoints, writer fencing, historical cutoff verification, production coverage, migration rehearsal/restore, Home reference classification or Markdown authoring. The synthetic test assertions establish only their explicit fixture data. Before a real import, inventory every retained/deleted/orphan target and alias, reconcile all high-water marks, prove typed ancestry and immutable cutoff, fence all writers, implement resumable acceptance and coherent restore, then review and authorize production activation separately.
