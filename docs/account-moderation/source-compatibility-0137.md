# Forward 0137 consumer source compatibility

Candidate based on b6ebb02. Migrations 0001–0136 are not edited. This note is source analysis and a test plan, not a claim that the candidate has passed PostgreSQL.

## Findings and bounded changes

All 58 capture sources are listed in `source-compatibility-0137.json`. Exactly 21 old immutable command sources received additional blanket statement and empty-insert rejection in 0136. The consumer-guard section leaves the other 37 sources and their original mutable receipt, upload, provider and evidence lifecycles unchanged. The separately reviewed Profile appendix refines only the existing self-edit cause proof, as described below.

Among the 21, 15 already had unconditional BEFORE STATEMENT UPDATE/DELETE immutability. Six had unconditional BEFORE ROW immutability: scoped command preparations/outcomes, Experience requests/maintenance requests, Community post-category commands, and region-policy commands. None of these 21 had an original authenticated retention/cleanup exception allowing actual UPDATE or DELETE. Historical session retention releases credentials by removing exact foreign keys, not by deleting these command rows.

0136 changed zero-row writes for the six row-guarded sources. In particular, old scoped writer statements intentionally advance their registered epochs even when no row matches. Rejecting the statement prevented that contract. The new guard also preempted original immutable diagnostics on actual row deletion.

0137 removes only the two added guards on those exact 21 sources. It keeps all original triggers, keeps AFTER INSERT row capture, adds bounded AFTER UPDATE/DELETE transition-table rejection for any affected row, and retains a BEFORE TRUNCATE fallback ordered after ordinary original guards. Empty INSERT creates no sidecar and follows the original source's own statement rules. Original statement guards still reject zero-row UPDATE/DELETE for the 15 sources where that was already required.

The sidecar's own immutability and source-trigger admission remain unchanged. A separate precise isolation error splits the existing read-committed check from the source-depth/fingerprint checks; every check remains required. The Course comment fence's independent isolation requirement and its original trigger chain remain intact.

## Before/after attack matrix

| Action                                                        | 0136                                                                       | 0137 candidate                                                                                                |
| ------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Empty source INSERT, exact 21                                 | New consumer rejection, even without a row                                 | Original source statement contract; no row capture, no policy evidence minted                                 |
| Empty UPDATE/DELETE, six row-guarded sources                  | New statement rejection                                                    | Original writer/epoch touch executes; actual row count remains zero                                           |
| Empty UPDATE/DELETE, fifteen statement-guarded sources        | Consumer rejection can preempt original                                    | Original statement rejection remains                                                                          |
| Actual row UPDATE/DELETE, all 21                              | Consumer statement rejection first                                         | Original guard rejects first; nonempty transition fallback independently rejects if an old guard were missing |
| TRUNCATE                                                      | Rejected                                                                   | Original rejection plus retained consumer fallback; never permitted                                           |
| Forged sidecar INSERT or sidecar UPDATE/DELETE/TRUNCATE       | Rejected                                                                   | Unchanged                                                                                                     |
| Fresh inserted command under mute/suspension                  | Captured exact actor policy and validated with source/ledger proof         | Unchanged                                                                                                     |
| Late ledger change or finite expiry after capture             | Original observation invalidated                                           | Unchanged                                                                                                     |
| Same-transaction zero-write ABA on scoped sources             | Added guard can prevent the intended mutation test from reaching its owner | Existing epoch increments occur; retained source snapshots must reject at final fence                         |
| Existing metadata maintenance / VACUUM / credential retention | Source observer can corrupt the wrong entry transaction in tests           | Tests target the captured business transaction; runtime maintenance rules unchanged                           |
| Unsupported writer isolation                                  | New combined admission diagnostic masks the isolation cause                | Same rejection with precise read-committed reason; old independent Course fence retained                      |

## Transaction-scoped observation repairs

The HTTP entry policy now explicitly requests read committed. Relying on a server default of repeatable read was a real runtime regression because the required final proof requires read committed.

The extra entry transaction also exposes brittle tests that treated the first `SET CONSTRAINTS ALL IMMEDIATE` in an HTTP request as the business final boundary. Ratings hooks now wait for their exact context or topology-read query and retain the observer's unique transaction-lifetime token, which stays stable through proof-epoch restoration and changes on client reuse. They neither skip an arbitrary number of flushes nor lengthen deadlines. All existing NOWAIT, no-post-flush-source-lock, topology-expiry, metadata rollback and ABA assertions remain.

## Required validation

- New `account-policy-source-compatibility.test.ts`: exact 58/21/6 inventory; all original guards remain enabled; 21 empty INSERTs mint no proof; six zero UPDATE/DELETEs succeed and fifteen retain original rejection; real issued command remains immutable; original Course isolation guard remains.
- Existing `ratings-scoped-boundaries.test.ts`: exact registered epoch deltas, real lock holders, final NOWAIT and same-transaction ABA.
- Existing `ratings-scoped-maintenance-fences.test.ts`: VACUUM coexistence, reader-first writer waiting, and exact metadata corruption rollback.
- Existing `rating-category-icon-receipt-fences.test.ts`: actual retained command/graph rows hit their original immutable guards. Its expected guard regex is unchanged.
- Existing `course-comments.test.ts`: unsupported isolation rejects with the unchanged read-committed expectation and creates no terminal receipt.
- Existing `ratings-category-review.test.ts`: topology expiry occurs after genuine captured business facts.
- New interceptor unit assertion and existing real shared HTTP read-committed tests.
- Existing moderation raw writer, clock-only expiry, original receipt, causal issue/appeal and retention suites remain mandatory regression coverage.

## Separately reviewed Profile concurrency appendix

The appended `profile-self-edit-concurrency-forward.sql` replaces the global Profile-epoch own-write witness with immutable per-cause statement evidence and exact own-row fences. It retains original caller/session/token/CAS/patch facts, final policy and exact deadlines, and does not rewrite historical cause/epoch rows. `whaleu_profile.self_edit_statements` is internal proof material, not a new command source: the consumer-capture registry remains exactly 58 relations. The source worker's dedicated tests cover different actors, same-actor source changes, session/token revocation, retained history and proof-table mutation. Runtime results are recorded by the integration owner, not asserted by this source document.
