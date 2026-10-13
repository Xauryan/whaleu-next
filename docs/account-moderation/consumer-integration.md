# Account punishment consumer integration

Status: source implementation and static inventories; PostgreSQL and full application results are maintained by the integration owner. This document does not claim unexecuted tests passed.

## Authority and semantic boundaries

- Existing Identity terminal lifecycle, imported/unknown baseline Safety, phone, affiliation, role, source, Review and Errand restrictions remain independently required. Punishment release only terminates its own ledger entry.
- Account actor policy is independent of target-author eligibility. `SafetyRepository.baseRestriction` retains target/imported predicates; `restriction` additionally invokes the caller's explicit action policy. Muting an author does not hide all their old content.
- Browsing, private personal profile/avatar/preferences, sign-in/rewards/redemption/equip, administrative reading and noncontent management permit mute. Interaction and public content management deny mute. Suspension permits only the explicitly bounded recovery/status/private-appeal/safe-notice paths.
- Saved-post creation is interaction because it changes public counts and author reward/ranking obligations. Saved-post removal is cleanup. Personal update-channel preference enable is private self-service, disable cleanup. Ratings subscription creation affects publicly readable subscription count and is interaction; unsubscribe is cleanup. Like/unlike dispatch follows the verified desired boolean. Trading reopening is interaction and resolving one's listing is cleanup. Public pin/unpin remains content management; pin-read bookkeeping is separate.
- Route tuples are server-owned classification, never a caller-supplied permission. Typed mixed-operation owners dispatch from their closed operation/boolean unions and reject unknown operations. A request method alone never establishes action class.

## Entry classification versus owner proof

`routes.ts` has explicit handler/method/path/action/phase tuples. `route-owners.json` maps each to its concrete controller-to-service calls and exact decorator expressions. The source AST script additionally recognizes the three existing decorator factories, but AST discovery is NOT a completeness proof.

The application test `account-policy-route-inventory.test.ts` constructs the actual Nest AppModule and compares instantiated module/controller effective method metadata bidirectionally against the semantic tuples. It covers generated/applyDecorators, aliases and inherited methods and rejects omissions, stale entries and duplicate routes. Runtime interception resolves a handler by effective prototype property identity; JavaScript `function.name` is not authoritative for wrapped methods. Wrappers preserve all original Reflect method metadata and do not replace parameter metadata.

An entry check is defense in depth. The owning transaction's authenticated session and/or explicit actor gate retains the ledger owner's original fingerprint and deadline through final bounded fences. Commands are annotated `owner_after_recovery` and retain historical receipt/cancel handling before fresh eligibility. Direct service calls have their own explicit semantic annotations/gates. Media's final authorization callbacks must independently retain caller policy; a previously returned callback is not assumed to retain request async context.

The common service annotations are mechanical routing integration. Actual semantic changes are in Safety actor/target separation, explicit fresh command gates, typed mixed dispatch, safe notice projection, profile/phone/experience owners, forward SQL predicates and causal sidecars. These must not be mistaken for one global HTTP guard proving every mutation.

## Safe notices and privacy

Pure own metadata lists/counts/acknowledgements retain their original independent ownership/phone/role gates. Preview-bearing Community, Ratings, Major and Window notices first retain an explicit browse observation; a suspended viewer receives only the existing `unavailable` envelope, without target locator, preview, author, actor or media. The original negative observation survives until final proof and finite expiry invalidates stale projections. Target navigation stays browse-protected. Student notices similarly emit `available=false`; owned read acknowledgement may return the existing unavailable target result. Feedback read skips its target lookup only for an explicitly suspended owner and retains its separate notification authority.

## SQL and raw writers

`sql-baseline-consumers.json` mechanically inventories 27 current direct baseline consumers and their 91-function transitive dependency graph, hashing original migration definitions. Eight predicates are replaced forward-only; target/import/legacy owner rules are retained. `sql-source-owners.json` lists 58 exact causal source relations and their real caller/source keys.

The new sidecar captures fresh immutable commands or terminal mutable receipts, not historical replay. Pending review remains legitimate. Mutable request owners retain original pending-to-terminal guards; they are not made globally immutable. The source hash includes the entire terminal record, including legacy payload hashes and booleans. Composite Media batch keys retain batch AND command, while actor comes from the exact owning batch, never from the batch ID or stored asset uploader. New preparation predicates complement, rather than replace, final consuming-command proof.

Sidecars retain no live Identity/session/token foreign keys. Admission is source-trigger-only; final validation checks exact source, original actor fingerprint, DB-clock allowed/suspended state and finite negative deadline under NOWAIT ledger table fences. Ledger mutations recheck only current-transaction proofs for the exact affected actor with fixed fact/time bounds. No historical receipt backfill or global owner-vector scan is introduced. Existing budgets and old migration bytes are preserved.

The internal Profile self-edit cause is separately reviewed: exact caller/session/prewait tuple, permitted patch and original CAS, with final identity/punishment/source facts. It does not infer actor from a moderator's subject. Authoritative raw/import fixture writes remain source invalidations, not fabricated authenticated commands.

## Test-only historical compatibility

`AccountPunishmentPolicy` is a per-application provider. DatabaseService binds it only to its exact live transaction through a unique lifetime Symbol, a PoolClient WeakMap and a tiny captured ALS Symbol. Read-checkpoint epoch refresh does not create a new transaction. A recycled client or retained callback cannot borrow the next transaction's override; direct standalone `inTransaction` calls use production. No environment/GUC/request bypass exists in production. Historical prefix adapters and isolated controller-boundary mocks are explicit test-only overrides and do not remove old baseline checks.

## Reproducible static checks

- `node scripts/check-account-policy-routes.mjs` checks source tuples and the controller/service inventory artifact. Regenerate only after reviewing semantic changes with `--write-inventory`.
- `node scripts/check-account-policy-sql.mjs` checks current baseline-function hashes and dependency inventory. Runtime route equality, actual HTTP metadata behavior, real PostgreSQL policy/expiry/race tests and Media delivery tests are separate requirements.
