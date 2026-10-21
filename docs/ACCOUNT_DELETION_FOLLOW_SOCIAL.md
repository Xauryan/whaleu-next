# Synthetic follow/social account-deletion owner

Status: local synthetic-cohort validation only, with a subsequently discovered and reproduced locale regression. This document retains the sealed V38d evidence and describes the 0174 correction under validation. Neither is production readiness or a public deletion feature.

## Scope and admission

Migration `apps/api/migrations/0173_account_deletion_follow_social.sql` adds the `follow-social` owner under inventory `account-deletion-local-0173-v1`. Admission requires explicitly generated fixture accounts in the same admitted sandbox, real application-written follow provenance, and an exact supported-table/catalog seal. Social sources must be follow-only profile events with no reward, post, comment, reply or target-reply payload. Supported social graphs, follow commands/heads, notification owners and private cursor buckets must belong to the admitted cohort. Cursor admission validates exact shape, types, bigint bounds and real calendar timestamps.

This is not a general account-erasure engine. Likes, saves, rewards, non-cohort history and unsupported owner data remain blockers rather than being silently certified absent. Native experience/safety/verification retention is restricted to the separately validated baseline; it is not permission to retain arbitrary history. Unknown relations, schema drift and changed unsupported rows block progress. The local inventory deliberately over-blocks unrelated activity.

Sources: `apps/api/src/account-deletion/{contracts,owner-registry}.ts`, `apps/api/src/account-deletion/owners/preflight.ts`, and migration functions `follow_partition_valid`, `follow_cursor_position_valid`, `inventory_current`.

## Bounded phases and exact authority

`follow_social_page` has phases 0–10, followed by completion phase 11:

0. Remove incoming/outgoing follow edges and prove each affected peer feed-revision advance.
1. Remove the deleting account's follow commands.
2. Record exact incoming-source erasure intents.
3. Remove incoming receipts.
4. Remove incoming notices.
5. Remove incoming work.
6. Remove incoming sources and record their erasure evidence.
7. Retire outgoing sources; settle pending work with an exact `account_deleted` receipt and no fabricated notice.
8. Remove the deleting account's follow head.
9. Remove its private discovery cursors.
10. Remove its notification owner.

Each page examines a maximum of 101 candidate coordinates to determine exhaustion and grants at most 100 mutations. A worker tick commits at most one nonempty follow/social page, traversing empty phases without artificial pauses. Progress boundaries, exact row fingerprints, mutation count and deferred closure checks commit with the actual writes. This bounds page mutations, not the total cost of inventory validation or scans. Broad local inventory table fences are not a production-scalability design.

Authority is bound to the exact request, generation, `follow-social` owner, current database transaction, inventory/policy and account lifecycle/current deletion-request pointer. A stale request, unrelated owner cause or arbitrary row seal cannot authorize erasure. Completion requires actual closure and owner proof, not a synthesized count-based success. Source UUIDs recorded in intent, retirement or erasure evidence remain reserved against reinsertion/reuse.

Sources: migration functions `follow_cause`, `follow_granted`, `follow_page_guard`, `follow_page_complete`, `follow_social_page`, `follow_social_complete`, `follow_writer_fence`; `apps/api/src/account-deletion/{worker.ts,owners/follow-social.ts}`.

## Erasure versus retained history

Deleting a recipient removes that recipient's own incoming source/work/receipt/notice graph, private cursors and notification owner. Deleting an actor does not erase another recipient's independent history. Peer-held notices retain their original identity, source timestamp and first-read timestamp, but are reprojected as unavailable without actor/profile/target payload. Explicit first-read handling remains the recipient's authority and cannot revive the sender. A later recipient deletion takes precedence and removes that retained graph with exact erasure evidence.

Retained internal actor/public target identifiers, event/command identities, timestamps, lifetime dedupe keys and fingerprints remain linkable. Hashing them is not anonymization. Do not describe this policy as deleting every trace of the account.

Sources: `apps/api/src/community/social-source/{facade,projection}.ts`, `apps/api/src/notifications/social/{worker,repository,read.service}.ts`, and `followSocialRetention` in the owner adapter.

## Contention and recovery

Lifecycle fences precede follow/source gates and notification-owner locks; private cursor quota locking comes last. NOWAIT row locks and try-advisory locks avoid waiting under incompatible fences. Primary page candidates, peer follow heads and outgoing work are prelocked before mutation. Contention rejects/rolls back the attempted transaction without advancing page evidence or proof; the same request/page may be retried after the competing lock is released. A lock failure is not completion. The synthetic worker does not itself provide a production retry scheduler.

Late workers revalidate the source and lifecycle after locking. A worker that located an incoming source before deletion cannot recreate it afterward. A cursor resolved before sender retirement still requires current projection, rather than carrying a stale disclosure grant.

## Verified PostgreSQL evidence and limits

The exact sealed candidate was `business-validation/v38d-follow-social-alias-successor`. Its 0173 SHA-256 is `c5061212477b697bc16dd1e7da5f7b9f16d977782b39d07800d6362180013c53`.

The fresh, serialized PostgreSQL 18.6 loopback `whaleu_test` runs passed all three files: **26/26 tests, zero failures/cancellations/skips**:

- `apps/api/test/integration/account-deletion-follow-social.test.ts`: 9/9.
- `apps/api/test/integration/account-deletion-follow-social-races.test.ts`: 12/12.
- `apps/api/test/integration/account-deletion-local-rehearsal.test.ts`: 5/5.

These runs cover real source provenance, bounded cleanup and rollback, forged-cause rejection, unsupported partitions, seven held-lock cases, concurrent peer deletion, stale-worker/cursor barriers and retained first-read behavior. The concurrent whole-worker test may reject at inventory serialization; the separate held peer-lifecycle case specifically exercises endpoint NOWAIT contention. Each owned test cluster was stopped and removed. Source/API/native/release manifests were unchanged; their verification is an integrity check, not execution of every corresponding artifact.

Authoritative run record: `/tmp/whaleu-pg18-source.nwdz7ABW/v38d-follow-social-three/three-validation-summary.json` (SHA-256 `e085beb73b8cee589024f279e9308812c6e25cd6e3e1783acf834af03cf5a941`), with per-file logs and hashes referenced there. Seal SHA-256: `81fbe3676a2cdd5a6e7b7a2124ff0b7b0861d1e3f1a6a989edacdf62f15e8711`. These local paths are evidence locators, not published links.

Earlier failures remain part of the record:

- V38 failed during migration installation with PostgreSQL `42601`: two unparenthesized CASE expressions inside a PL/pgSQL IF. No behavior acceptance followed from that run.
- V38b installed the migration but failed behavior with `42703`: the profile alias `p` collided with the typed page variable. The successor disambiguated that alias plus two related identifier collisions, preserving predicates and locks. The old failures were not edited into passes.

Prior records remain under `/tmp/whaleu-pg18-source.nwdz7ABW/{v38-follow-social-three,v38b-follow-social-three}/`; source corrections have separate patches/manifests under `business-validation/follow-social-erasure-{syntax,identifier}-correction/`.

## No production or signing claim

`accountDeletionCapability()` still returns `unavailable` with reason `REAL_OWNER_POLICY_AND_PROVIDER_COVERAGE_UNPROVEN`. No public deletion route or production activation is introduced by this owner. Real-owner policies, provider coverage, production storage/media behavior and unsupported owners require separate work and approval criteria.

The 26-test acceptance does not establish full broader regressions, whole-corpus unit acceptance, native/browser/device behavior, production deployment or production performance. Those remain outside this run's evidence and must not inherit a pass from these focused suites.

SHA-256 manifests and row fingerprints identify bytes and causal evidence; they are **not signed Git commits**, cryptographic signatures, proof of signer identity, remote publication or deployment verification. No commit-signing claim follows from a matching hash or successful local tests.

## Locale regression and successor qualification (2026-10-21)

The earlier 26-test run used PostgreSQL's C locale. It did not establish acceptance under every database collation. GitHub Actions run 39569827733 on published commit ad61a16b379e1a143eee5f02a2f215a9fee606e5 exposed a genuine 0173 inventory comparison defect under en_US.utf8. A fresh local run of those exact published migration bytes reproduced the failure. The source correction is not a relaxation of account, request, generation, lifecycle or transaction authority.

The same-transaction diagnostic showed the exact current cause and lifecycle predicates remained true. Both relation inventories contained 837 entries, but 103 positions differed because one ordering used the database's text collation while the catalog-name expression used C ordering. Explicit C ordering produced identical arrays. The diagnostic is evidence of the cause, not a successful deletion run.

Migration 0174 explicitly fixes all four relation-identifier sorts to COLLATE "C". It also qualifies the coordinator seal with a versioned, stable function profile so a previously sealed inventory cannot silently inherit a changed inventory_current implementation. Existing seals are immutable and fail closed after this change; they are not updated or backfilled. A new supported qualification is required. The original 0173 file and all owner causality predicates remain unchanged. The new seal uses typed pg_proc metadata, not caller-sensitive pg_get_functiondef output. Its local settings normalize search_path, quote_all_identifiers and IntervalStyle; this is not an invariance claim for arbitrary GUCs or every part of admission. Its deliberately finite function profile rejects unsupported metadata.

The successor still describes a synthetic local owner, not a public production deletion feature. Real content/media owners, full retained-history policy, providers and production admission remain separate requirements.

Validation record must distinguish the unchanged original suites, the added collation/seal negatives, and the complete cloud regression run. The first version of the new body-tamper test failed before reaching its assertion because JavaScript replacement-string syntax collapsed $$ into $. That failed test is retained in the evidence. The callback-based test successor preserves the SQL delimiter and asserts the injected comment is the only change. Only real PostgreSQL execution of that successor can establish body-tamper rejection.

### Successor validation evidence

The unmodified original three deletion suites subsequently passed 26/26 in each of C and en_US.utf8 on the same 0174 production bytes. The corrected full collation/seal suite then passed 7/7 in each locale, including real function-body mutation, rejection of stale qualifications, exact-cause negatives, unsupported inventory changes and genuine owner completion. No failure from the first malformed test construction was erased or counted as a pass.

These are focused local PostgreSQL 18.6 results. The test-only v2 successor differs from its predecessor only in construction of the body-mutation SQL; its 5,601-file manifest SHA-256 is `8b26df5e468998b18cde893e851e9bce332777aeef7fbeccc904768eb1f656c9`. Its two-locale terminal matrix SHA-256 is `a159f0c530304b2df9ba3b7f297718c9951da4d7fd46638727f00fdd1bf62d41`. The preceding twelve-run matrix, including the original test failures, remains `189c29b3af1540adcd348b23342d0cbeb4cfa392388d6b936c72cbf4d2e841b9`.

A later test-only v3 restores the unchanged native thread's original text assertion and adds a regression for its actual template. This does not change the migration or any production runtime. Full clean cloud CI on the eventual signed commit is still required; this focused evidence is not a claim that all integration files passed on one successor version.
