# Internal post comment/reply component

This partial increment supplies independent fresh-post comment inputs for future
hotness work. It exposes no endpoint, public count, actor membership, score or
ranking, and changes no native UI or author received-like/save policy.

## Accounting semantics

The component retains raw live root count, raw live reply count, eligible live
contribution count and unique eligible real-account count for the settled source
prefix. Raw counts include the
post author's own contributions. Eligible and unique counts exclude that author.
One real account remains one unique contributor across roots, replies and named or
anonymous presentation. Reply recipients and root authors do not replace the post
author for this comparison.

Deleting a root subtracts only that root. Still-live replies underneath it retain
internal contributions. Deleting a replied-to reply similarly does not delete
other replies. Existing read owners continue to hide inaccessible threads; these
internal counts are not a viewer's visible-discussion totals. Hidden/approved
changes, blocks, account state and parent-post deletion are not child tombstones
and do not fabricate contribution deletions.

No score formula or public ranking behavior follows from this component. Retained
or hidden contributions may affect a future score, so public ranking needs its own
privacy and coverage review before exposing these inputs indirectly.

## Fresh coverage and transactional capture

Only exact new native publication can establish a zero baseline in its own
transaction, with matching post author, request receipt and creation provenance.
Historical posts remain comment-unknown even if another component is known. Reads,
old publication replay, existing outbox labels and experience history cannot
create coverage. Existing published data is not reconstructed or backfilled.

Migration 0031 captures actual live root/reply INSERT and null-to-deleted UPDATE
transitions, including self-delete and supported moderation removal. It does not
consume generic discussion_ranking labels, which also describe unrelated likes
and do not cover every moderation path. Sources bind actual current creation or
deletion transaction, kind-scoped content identity, actor, parent and causal
sequence. Deletion references its exact retained positive source.

Early raw-write admission precedes the existing saved-discussion parent lock.
Invisible newborn-parent writes fail before child/FK waits. Known-parent capture
uses parent serialization and fail-fast locking; arbitrary bulk writers still
need deterministic parent prelocks. Unsupported enrolled undelete, identity
rewrites, hard deletion and TRUNCATE cannot silently leave a known but wrong
component. These are installed-schema guarantees, not resistance to an
administrator removing database guards.

## Selected-source settlement

Each apply handles one source for one post, in numeric causal order. A later
selection returns blockedPredecessor until its predecessor is settled; the CLI
does not automatically wait or retry. Per-content membership prevents one
child's deletion from subtracting another contribution; per-actor cardinality
changes unique count only at zero/one boundaries. Receipt, post state, content
membership and actor membership commit together. Counters use bigint; underflow is
rejected, never clamped. Old receipts replay without rewinding later state.

Settlement uses immutable capture and does not lock live children, accounts,
safety, saved, experience or outbox records. It can process captured work while
public reads deny the content. No unrelated work status or obligation is marked
complete.

`npm run comments:process -- ...` follows existing manual component processing:
dry-run by default, explicit 1–50 distinct source UUIDs for apply, dedicated local
URL/socket/database checks, no all/backfill/import/repair option, and unrelated
background jobs disabled. Dry-run starts read-only and does not allocate sequence
values or mutate tables. It is not a complete-backlog certificate.

The implementation reuses Nest, pg, Zod and existing transaction/manual tooling;
no dependency, scheduler, queue or provider is added. Historical import, production
processing/throughput, effective formula metadata and full hot-feed parity remain
open. See [acceptance](acceptance/comment-component.md).
