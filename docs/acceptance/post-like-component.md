# Local post-like component acceptance

Local verification completed on 2026-10-08 against base
`ceda58f302482a2d02be5ac3d69692f7b1031307` plus this increment. Hosted CI for the
resulting commit is reported separately. No public hot score or feed is claimed.

## Frozen gates

All 686 source/test/config/asset files remained unchanged across the final gates.
Fingerprint: `e908551d2b4605db1b8cb1208a1b4e9387fa757a9d98375ed362002f16f57a8d`.
The [machine-readable evidence](post-like-component.json) includes the manifest,
hashing convention and final verification-log hashes. Documentation is excluded
so evidence can be written after testing.

- `npm run check`: lint, strict types, 468 API and 784 native tests, both builds
  and emitted native smokes passed
- `npm run format:check`: passed
- `npm run test:integration`: 824 tests passed in 436.030 seconds
- Total: 2,076 passed, zero failures/skips
- PostgreSQL 18.6, launch-only maximum 100 connections, one-minute autovacuum
  scheduling, zero application schemas remaining and runner shutdown

The first gate invocation stopped at lint because two newly added rejection-test
callbacks used explicit `any`. They now use guarded `unknown` with identical
SQLSTATE assertions. It did not run PostgreSQL or count as an aggregate pass.

## Source and causal proof

Only fresh native publication establishes the independent like baseline. Old
posts, including subscription-known native posts, remain like-unknown. Real
INSERT/DELETE triggers capture retained like epochs with their actual current
transactions. Request receipts and no-ops do not create effects. Self-likes count;
comment/reply likes do not. No reward or Saved obligation is manufactured.

A source's immutable receipt and exact state/membership effects commit together.
Tests cover 1/0/1 replay, negative-before-positive, another actor's later positive,
ended live-row replay, old request replay after unlike, duplicate workers, large
sequences and rollback gaps. Direct SQL proofs reject forged sources, reused
identity, wrong epoch/count/head, incomplete effect closure, mutation and TRUNCATE
bypass. Current soft deletion alone does not create an unlike.

## Locking, visibility and rollback evidence

Review identified a potential INSERT ordering problem: immediate FK work could
precede AFTER capture's parent NOWAIT check. The final implementation checks known
parents BEFORE INSERT and retains capture-time serialization. Direct INSERT and
DELETE contention tests require prompt failure rather than waiting while holding
child state. This is a defensive protocol; the historical deadlock was not
experimentally established and is not claimed as a reproduced incident.

At READ COMMITTED and REPEATABLE READ, a concurrent invisible newborn-parent
insert is rejected before child locking; the publisher then inserts the same tuple
and commits a captured source. Same-transaction publication remains valid, and
visible historical unknown posts remain non-enrolled. This does not rely on
snapshot refresh later in the trigger chain or impose new parent locking on all
historical unknown posts.

Real-policy HTTP tests inject failures in source capture, outbox, request receipt,
component receipt/state/member and deferred closure. An AFTER request-receipt
fixture blocks the actor; actual final identity revalidation rejects the request
and rolls back all effects, including that injected account change. Retrying after
rollback captures exactly once. No permissive identity or visibility replacement
is used for this assertion.

Focused PostgreSQL acceptance passed 85 tests across the existing subscription
proof and all three new like suites. The old subscription helper adds only real
like enrollment after its current migration stage, before the deliberately varied
subscription branch. Its pre-migration history and all assertions are unchanged,
so negative subscription cases are not masked by missing-like proof.

## CLI and limits

Actual CLI tests establish full table and sequence snapshot equality in dry-run,
no background work, explicit selection, local-only guards and bounded inputs.
Read-only-before-inspection ordering is additionally verified in unit queries;
it is not claimed as a database statement-log capture. Apply is manual and limited
to at most 50 explicitly selected sources. Receipt presence is completion, with
no second work queue or unrelated acknowledgement.

Historical import, production processing/throughput, views/comments, effective
formula configuration and public hot-feed/search/native UI remain open. Component
state is a processed prefix, not a universal current-count guarantee. Head-query
cost can grow with retained history. The separate received-total deletion-policy
decision is unaffected. No production data or real user action was processed.
