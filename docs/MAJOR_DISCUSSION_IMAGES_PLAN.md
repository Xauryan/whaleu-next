# Major discussion images: pre-integration plan

Status: integrated implementation under validation on signed baseline
51437e41187ceb5ab1817153b2870ada38679f37. Migration 0125 and Media17 now extend
0124 in this isolated worktree. The original preparation scope has expanded to
runtime registration, SQL, native adapters and real synthetic integration tests.
See [implementation](MAJOR_DISCUSSION_IMAGES.md) for the current behavior. Exact
frozen-tree results remain a separate acceptance record; neither this checklist
nor a partial passing run establishes production or physical-device acceptance.

Next policy: up to three JPEG/PNG inputs, each 5 MiB, with the existing 24-million
pixel decoder budget. Only derived thumb-v1/display-v1 are deliverable. The legacy
Major image count is unknown. Both roots and replies require nonblank, valid
Unicode, no-NUL text within 8,000 UTF-8 bytes; images never admit image-only posts.
Text bytes are preserved, including surrounding whitespace; `0` remains valid.

## 0125 integration checklist

1. Freeze existing v1 command, Review, receipt, recovery and delete golden cases.
   Apply only a new 0125 migration; do not edit historical migration bytes.
2. Add Major-specific media scopes, cancel scopes, immutable appearances and v2
   Review policy/decisions/heads. Register Media17 with shared prepare/intent,
   ingress, static processing and recovery. Keep Major identity/context/Review
   separate from Window, generic Ratings, PM and Errand. Prefer an explicit
   `majors` owner namespace and `major_discussion_image` resource registration;
   shared storage tags never confer business authority.
3. Add versioned Major root/reply commands and receipts. Freeze the exact ordered
   asset/manifest list in the Review envelope and command hash. SQL deferred
   completion must prove publication, Review, every binding/appearance, receipt,
   all required notice obligations and original actor/request key atomically.
4. Compose the complete-set media predicate with the signed 0124 tombstone-aware
   visibility. Do not replace `major_discussion_visibility_base` with Window's
   implementation or bypass the renamed `without_tombstone` boundary. Keep
   `major_discussion_fence()`'s tombstone/delete-command fence and parent denial.
   Directory counts/hot roots, thread population, positive likes, notices,
   descriptors and delivery all consume this same visibility.
5. Add full mixed v1/v2 readers. V1 population reads must fail closed if they cannot
   faithfully represent any current v2 row; never filter v2 away and report a
   partial total/ranking as complete. Missing source/history is unavailable, not 0.
6. Register v2 API/module/media routes and contract artifact. Add native thin
   codecs only after merging the signed soft-delete controller/pending changes.
7. Acquire the parent's explicit heavy-test lease before running typecheck,
   build, PostgreSQL, emitted smoke or simulated native acceptance.

## Non-negotiable concurrency and authorization

Acquire the existing named-policy gate exclusively before the original publication
key for v2 mutations; never upgrade a shared gate while a same-key waiter holds
other locks. Retain the first Review epoch captured in the decision-consuming
SELECT. The new facade already preserves this immutable final fact; do not capture
a fresh epoch at the end to erase zero-row/ABA writes.

After all owned media writes, re-read every depended-on parent and image member
before capturing the final Media epoch. Preserve source, Profile, Safety, session,
Review and exact time dependencies. All raw/zero-row/TRUNCATE writers participate
in statement epochs. Keep NOWAIT and 100 ms/500 ms proof budgets unchanged.

0124 author and scoped-admin deletion remains its own reduced authority. New
positive publication/like requires current source/Review/full-set proof, while
known unlike, existing delete and original-key receipt/cancel must not acquire
unnecessary source/Review dependencies. Root deletion denies every descendant
immediately. Deleting an addressed reply removes only its reference from other
replies, preserving other authors' content and image bindings.

Private delivery reauthorizes after external storage open, before final proof and
commit allow any bytes. A new tombstone during open closes the paused stream with
zero response bytes. No original/public/signed URL fallback, and no new bound-image
cleanup cause, retention TTL or physical purge. Source/Review withdrawal is access
revocation only; uploading expiry does not expire bound delivery variants.

## Major-specific notifications and native recovery

Root-author reply notices navigate to the root but derive the preview/first image
from the causal new reply. Addressed-author notices navigate to that new reply.
Like notices have no thumbnail; Major creates no creator notice. Both navigation
target and causal reply must be visible, with the whole image set allowed before
ordinal zero can be exposed.

Keep real old v1 receipts ahead of any new metadata journal or ownership locator.
Corrupt optional side caches must not block valid original-key v1 recovery or be
overwritten during failed admission. New v2 pending records contain original IDs,
hashes, source context and bounded upload recovery keys only, never draft body,
image bytes, paths or descriptors. Default upgraded App must cold-recover a real
old v1 lost response, then publish and cold-recover v2. A later same-owner locator
must allow the first delete of v2 content using the signed 0124 API.

Use the existing App-wide file pool (two transfers, 10 MiB, four handles). Hide,
back/unload, account/session/origin change and late callbacks cannot resurrect
private views; release budgets only on native quiet completion.

## Shared owner-fence source inventory

The Media owner-fence concurrency helper at
`apps/api/test/support/media/owner-fence-concurrency.ts` maintains an explicit
expected source-table inventory. The parent identified a Window CI failure on
fca344b because its installed-protocol inventory omitted the three Window tables;
the parent owns that correction and its PostgreSQL verification. This is not a
Major scaffold test result.

When installing 0125, extend this same helper with an installed Major probe and
explicit `major_discussion_scopes`, `major_discussion_cancel_scopes` and
`major_discussion_appearances` expectations. Preserve exact full-set equality,
trigger `tgtype = 62`, enabled state `O`, and each source table's zero-row writer
concurrent exclusion plus rollback restoration. Do not weaken to subset checks or
derive the expected inventory from the actual trigger list. Validate both older
installed schemas and the fully installed Media17 schema under the heavy lease.

## Required evidence before completion

- Upgrade pre-0125 real v1 records; compare byte domains and original-key replay.
- Raw invalid/partial/reordered/cross-owner/cross-actor publications roll back.
- Whole-set sibling deny/unavailable propagates to all read surfaces and previews.
- Concurrent new v2 root/reply publication and positive like versus root delete;
  same-key repeat mutations; original receipt/delete/known-unlike independence.
- Storage open race with subject/root deletion and Review/Media/source changes;
  zero bytes before final authorization, no leaked reservations on quiet close.
- Review first-consume zero-row writer and ABA; exact deadlines; final Media epoch.
- Major root-author navigation plus causal-reply thumbnail, addressed notice and
  like-null-thumbnail; deleted addressed reply preserves other reply images.
- Real default-App cold processes for legacy v1 recovery, v2 metadata recovery,
  later ownership locator/delete, bad cache admission and native lifetime races.
- Preserve all existing registered journeys; report synthetic versus real-device,
  provider/source/history/production evidence separately.

API test commands run from apps/api. PostgreSQL runtime, when leased, is
`/workspace/scratch/8fe388fb34d2/test-runtime/pg18/bin`. No verification success is
implied by this checklist.
