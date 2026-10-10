# V4 discussion media publication

Status: implemented with focused local PostgreSQL, native process, and independent
API/processing-process regression evidence. Final acceptance is recorded separately
against the frozen source tree; this document is not the gate manifest. Normal
AppModule and normal native wiring remain unavailable. Real COS, model, Review
provider, production data, and physical-device behavior are not enabled or verified
by synthetic DI tests.

## Original business owners

Original Community root comments, direct replies to roots, and replies to replies
accept zero to three ordered JPEG/PNG attachments. Empty text is valid only with
one to three images. Ordinary post text requirements remain unchanged. The same
Community publication request, original intent hash, exact content Review, receipt,
attachment definitions, and committed outbox perform publication once. A v4 batch
coordinates bytes and exact ordered evidence; it is not a second publisher.

The original post ID is an ancestor for every discussion object. A reply's root is
also an ancestor. Its nullable target reply is a reference: it must be valid when
publishing, but later disappearance degrades the reference instead of hiding the
otherwise eligible reply. Deleted/revoked ancestors still deny all child reads.

## Explicit new protocol

Only `/v4/media` uses discussion identity version 2. The strict purpose/target union
is `community-comment-images` with `{kind:comment, postId}` or
`community-reply-images` with `{kind:reply, rootCommentId, targetReplyId}`. `spaceId`
is an equality hint checked against the server-resolved ancestor space. Scope
contains immutable resolved ancestry and is never changed to follow the page.

V4 status has `resolvedPostId`, populated from the same actor's immutable Community
draft evidence. Cancel-before-prepare has no such evidence and returns null. This
historical metadata may survive ancestor deletion; it grants no content or image
read authority. Native reply recovery compares it against the original Community
pending record's post ID, including when the reply intent hash excludes post ID.
Missing or conflicting evidence remains unresolved.

Request/hash domains are batch v2, member v4, command v2, and attachment-plan v2.
Publication references use the unchanged original `publish_comment`/`publish_reply`
intent algorithms, never an effective-mode Review hash. Recover/fence-publication
also require the exact typed target and full ordered asset IDs. V1/V2/V3 strict
codecs, reject vectors, hashes, old native journal bytes, original Community pending
bytes, and historical migration files remain frozen.

## Shared limits and lock order

Both versions dispatch into the same batch, intent, ingress, lifecycle, and recovery
engines and tables. V4 has at most three live and three retiring members. The
existing actor limit of three active intents, one unresolved writer, ten new
intents/minute, sixteen batches/day, 100 MiB/day, 5 MiB/input, and 128 retained batch
members/commands is unchanged. Real transport still uses one storage-keyed shared
admission counter. Native v3/v4/legacy pending admission is actor-wide; gallery and
uploads share the original two IO slots, four file leases, and 10 MiB display cap.

Mutation operations acquire the existing Safety writer gate before actor/business
locks. Ordinary reads retain shared gates and bounded owner final fences. Publication
then locks the original Community command, post, root and target as applicable,
immutable draft, batch, sorted intents/assets and bindings. V4 seal rechecks owner
publication eligibility before acquiring its batch lock. Metadata-only historical
status/cancel needs the authenticated actor, not renewed publication permission.
No global exclusive reader latch or increased metadata budget is introduced.

An explicit transaction-bound discussion mutation collector retains typed complete
ancestor obligations while lawful Media writes occur. Only its original business
authorization reads substitute typed obligations for the pre-write Media epoch;
other consumers keep their existing epoch facts. After the last mutation, the
original authorization runs again and must match actor, typed target, publication
scope and complete ordered ancestor sets. The mandatory final validator checks
its finalized read lifetime and exact Media fingerprint under the existing bounded
shared fence, after deferred SQL. No checkpoint restore, fact truncation, deadline
removal or final-validator proof registration is used. The final 500 ms bound is
unchanged. Child deletion has a separate exact owner/tombstone/detached-set/queued
cleanup transition; it does not require the deleted content to remain readable.

## Current reads and cleanup

Community resolves typed current parent eligibility and exact ordered image
expectations. Media verifies the entire typed set, manifest digests, current safety
heads, scope and ordinals. A missing/extra/denied member never becomes a successful
partial gallery. Delivery retains original first proof, exact object open, second
fresh authorization and final proof before bytes. Conditional snapshots group by
kind and ID, so the same UUID in post/comment/reply namespaces cannot collide.

Reply owner deletion detaches bindings in its original deletion transaction.
Migration 0078 atomically enqueues Community-owned cleanup for post/root/reply
tombstones, including moderation paths. A worker enumerates no more than sixteen
typed targets per transaction, performs one bounded Media detach batch with a single
post-write Media proof, and advances a
persisted cursor atomically. Process death or failed detach rolls back the page.
Completed enumeration means all selected bindings were detached; it does not mean
objects whose cleanup is pending/retained were physically deleted. Binding history
and original receipt remain available as historical evidence.

## Native and text discovery

The shared two-key coordinator retains reserve, Community body freeze/readback,
link/readback, seal, dispatch, exact receipt/history verification and ordered key
clear markers. Selected-file failure, missing bytes, retirement uncertainty or a
mismatched operation/target freezes publication rather than silently filtering the
set. Native detail/thread pages select one active image group using a shared
registry, and pure-image replies have visible navigation controls. Ordinary post
detail retains its automatic single-image read and multi-image thumbnail window.
Comment/reply groups require explicit selection; switching or returning to the post
revokes old sources and waits for owned cleanup within the original shared limits.

Notifications use existing receiver deduplication, saved epochs, current owner
eligibility and original target. No stored public URL or extra per-image business
event is introduced. Literal and semantic search use actual text only. Pure-image
comments/replies are known nontext sources; they do not need fabricated text,
OCR, image embeddings, or an external model call to establish eligibility.

## Verification boundaries

Regression sources cover strict cross-version vectors, typed same-UUID snapshots,
real multipart root/direct/targeted publication, pure-image/three-image bodies,
last-binding rollback, exact historical target recovery, notification replay,
literal and semantic eligibility, bounded cleanup failures and actual process death,
and native nine-boundary SIGKILL recovery. They also exercise missing finalization,
independent transaction contexts, preservation of unrelated required facts and
expiry, late and deferred Media writes, complete ancestor Review/Safety changes,
and exact owner deletion rollback. Repository-wide gates and generated OpenAPI are
validated against the final frozen source manifest, not inferred from focused tests.

Server writer process death is not authoritative quiescence. Foreign writers after
restart remain unknown/retained and prevent unsafe replacement until actual terminal
evidence exists. Separate test-only server/processing-worker child harnesses exercise
committed-response loss, real lease expiry and conservative retained writers; no cross-process retirement/supervisor feature is claimed.

The official inline OpenAPI artifact is currently about 11 MB. Equivalent `$ref`
component deduplication is follow-up maintenance, not a reason to remove strict
union constraints or change current schema semantics. The offline export test
compares two complete fresh generations, reads a per-run output file and verifies
its SHA-256 over bounded stdout before applying every original and v4 schema
assertion; its existing stdout buffer budget is unchanged.

## Composed local acceptance

Local acceptance covers 6,140 tests: 5 statistics, 20 search evaluations, 1,443 API
units, 2,302 native units, 2,328 main PostgreSQL tests and 42 semantic tests. Every
group passed with zero failures, skips, cancellations and TODOs. Lint, typechecks,
OpenAPI, build/emitted smoke and formatting passed.

This is explicitly composed evidence, not a claim that complete PostgreSQL was
rerun after the final UI-only change. The full PostgreSQL/semantic tree was
`53cb9bcbb0926435dbd4061e0b90f295f3c3c681`; main PostgreSQL took 58 minutes
50 seconds inside its unchanged 3,600-second stage budget. The final UI-tested tree
was `6d68b74ef1880bc64da3a7fcd658f2b46ec3029c`. Its only two changes were the
post-image button numeric WXML expression and a smoke assertion rendering that
actual emitted button. All other 2,051 source files remained byte-identical.
The final tree passed the complete cheap/build/format gate again, 16 directly
affected native tests and 3 original real HTTP/native PostgreSQL tests. Those
19 repeats are not counted twice in the 6,140 total. Of 481 emitted native files,
only the copied WXML changed; the other 480 remained identical. Documentation
status edits followed and were formatted separately.

The original ordinary-post automatic single-image and multi-image windows remain
intact; original HTTP tests were not rewritten to require an extra tap. Legacy v2
draft SQL and 30-minute/24-hour deadline regressions also remain intact. Main
migrations 0001–0076 and semantic migrations 0001–0002 are byte-identical; main
0077–0078 are additive.

The previous `0e77fed` hosted run failed, despite its local pass. Its Ratings
notification observer incorrectly demanded a reply-row read even after a deleted
root had already suppressed the projection. A test-only red reproduction and
separate deterministic live/deleted schedules preserve the appropriate lock-order,
zero-disclosure and mark-read assertions. The historical context Review 503 and
one earlier generic seal-recovery rejection were not reproduced locally; their
causes remain unproven. Bounded, allowlisted test diagnostics preserve future
failure evidence without changing public errors, production logic or proof budgets.
A new full hosted run remains required. Physical-device/provider activation,
other attachment owners and production rollout are still separate gates.
