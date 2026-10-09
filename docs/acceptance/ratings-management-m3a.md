# Rating management M3A acceptance

Status: isolated focused validation passed; integrated full acceptance is pending.

## Scope

M3A provides native general-category creation, exact Review v4, immutable source
lineage and release causes, all-scope catalog publication, current category and
ancestor Review gates, M1 copy compatibility, and native journal v8 recovery.
It preserves the existing target-owner edit/delete boundary and journals v1–v7.
This is not full M3: campus-specific reads/overrides, editing, ordering,
activation/archive, system-category management, media, and production migration
remain separate M3B/C/D work.

## Executed regression evidence

- Real PostgreSQL: 121 passed, zero failed/skipped across 17 selected files
- All seven M3A files, including native HTTP recovery and genuine schema upgrade
- M1 create/boundaries/recovery; M2B owner/history/races; M2A historical retention
- R3R campus, pending/zero-row proof fences and complete pools through 2,048 targets

- API focused unit: 96 passed; native focused unit: 125 passed
- Exact OpenAPI: two tests cover all 66 rating operations
- API/native TypeScript, full lint, OpenAPI check and native emitted build passed

Final full-repository formatting exposed two newly added test files; they were
formatted without behavioral changes and their focused checks repeated. The
validation baseline includes the integrated CI timeout and prior M2B formatting
fixes; those existing changes are excluded from the M3A-only patch.

The real three-level creation regression publishes one exact release to all
mapped scopes, then an ordinary user creates a target, scores/comments, edits its
current definition, and performs hidden-owner cleanup. The edit observer reads
real SQL results after deferred flush, verifies the current definition and native
catalog/ancestry, and proves the writer actually advances its own navigation
epoch. A writer must retain the after-state epoch, not its pre-edit read epoch.

Separate native-category/M2B tests change the catalog head or revoke the category
Review in another transaction after preparation. A post-deferred category Review
deadline test observes a tentative new definition, waits past visibility expiry,
and verifies complete rollback without a durable pseudo-rejection or lost prior
versions. Existing Review, compatibility, owner, history, race, and random-pool
checks remain mandatory.

The genuine 0057-to-0058 upgrade test compares historical rows, request hashes,
receipts, epochs and revoked Review. Migrations 0001–0057 remain byte-identical.
Only 0058 is introduced by this slice.

## Focused debugging retained in validation evidence

Initial publication failed because a local PL/pgSQL receipt variable was
incorrectly qualified by function name. The next deferred check exposed an
ambiguous ordinal variable. Both are fixed by unambiguous local names without
changing constraints. A test-only grant revocation now supplies the required
revoking account. Public category readers keep their mandatory navigation proof;
M1/M2B use the same category qualification through an explicit writer snapshot,
then retain their current after-state proof.

## Outstanding release gates

Full integrated repository, PostgreSQL and semantic regressions, independent
review and signed integration remain the release owner's gates. No hosted CI,
physical-device, real-provider, production-source/import or deployment claim is
made by these isolated focused checks.
