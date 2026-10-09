# R2B local acceptance status

Date: 2026-10-09 UTC. Implementation and the root-owned complete local repository gate passed on one frozen source snapshot, recorded below. This is not production release approval, historical reconciliation, external delivery or complete rating parity.

## Scope

- Normal AppModule root/reply current-like, desired-state and minimal recovery APIs
- Native publication/cutover coverage, exact actor CAS, count chains and anchored noops
- Typed v2 Experience registry and actual shared-pool worker/ledger settlement
- Separate local like-notice APIs, current projection and lifetime once-key/read preservation
- Explicit time/likes root ordering with source-bound coverage and opaque seek positions
- Existing v1/v2 journal compatibility and actual native HTTP integration

Subscription fan-out, media, admin deletion, specialist domains, historical migration and real review/provider/device gates remain separate. Author cumulative received-like inclusion and deletion rules are still undecided. No default cumulative-total policy is implemented.

## Focused checks recorded so far

- API typecheck, scoped lint and strict contract checks passed during implementation.
- Offline OpenAPI has 32 operations; 2 artifact/schema tests and 12 new strict like-contract/actual-fixture tests passed.
- A combined PostgreSQL invocation passed 70 tests, including 5 parent tests: current authority/recovery, true Experience ledger settlement, new/old notice APIs and hostile integrity probes. It used the exclusively leased disposable PostgreSQL 18.6 loopback runner, verified zero application schemas and stopped normally.
- Experience tests include root/reply × self/nonself × named/anonymous, current versus historical state, unknown owners independently blocked, community/Saved shared tenth/eleventh quota, Shanghai day changes, exact acknowledgement, after-deletion settlement, missing capture/work rollback and actual owner/parent lock ordering.
- Notice tests include first creation, unlike preservation, mark-read then re-like, multiple actors, exact existing receipts, suppression then later eligibility, authority retries, current unavailable projection and reply-only endpoint isolation.
- Raw membership tests verify minimal receipt source matching, rejected/noop absence of transitions, immutable count/actor history and typed registry restrictions. The subsequent focused run passed exact reply-only actor/request first/noninitial suppression, legal multi-actor and same-actor chains, SAVEPOINT rollback, final NOWAIT rollback, parent deletion concurrency, raw parent-lock inversion and phone expiry after deferred work.
- The explicit same-microsecond ordering probe caught an unqualified text ordinal ORDER BY alias; the implementation now orders by the stored bigint column. Its rerun passed. A 180-root late-seek probe passed all four directions: time asc/desc and likes desc used index scans returning 3 metadata rows; likes asc used an index bitmap over 80 suffix metadata rows plus sort to return 3. Candidate/body/proof limits are hard bounds; physical PostgreSQL metadata work is not asserted to equal LIMIT. No planner settings are forced.

- Nonempty 0047→0050 activation passed 4 tests: exact original-column/sequence preservation for receipts, effects, settled/pending Experience and read notices; exact native root/reply enrollment; incomplete-source unavailable state/order; rejected late fresh/cutover claims.
- Final ordering passed 10 tests, including 180-root seeks and a separate 180-target final-head observation. The final proof explicitly joins the primary-key target before comparing nullable head fields. Physical plans are recorded outside the final-proof callback, without affecting that proof's execution.
- The real native HTTP/PG roundtrip passed five consecutive six-test runs after fixing self-induced concurrent-reader contention: the existing Safety final gate is exclusive, so a same-batch root/reply pair could cause a 503. The native batch now has exactly one in-flight state GET, asserts all normally visible rows are known, retains true unknown/denial behavior and performs no blind retry or receipt backfill. The five runs ended with zero application schemas and a normally stopped PostgreSQL server.
- Public-only actual HTTP golden DTOs are frozen in `packages/fixtures/ratings-r2b.json` for both API and native strict decoders. They contain synthetic public IDs, not credentials or private author accounts.

No migration 0001–0047 or lockfile was changed. No production account operations, provider calls or paid model operations were performed. Remote branch publication and hosted CI remain pending.

## Final local full gate

One unchanged source freeze passed the root check (whole-repository lint,
TypeScript, offline OpenAPI verification, unit tests, both builds and all native
emitted-runtime smoke), whole-repository formatting and the full PostgreSQL suite.
The total was **3,899 tests**: 5 statistics, 915 API, 1,483 native and 1,496
PostgreSQL tests. All passed with zero failures, skips or cancellations. The
separate real-cloc 2.10 integration test passed 1/1, outside that total.

PostgreSQL 18.6 used launch-only max_connections=100. Full-suite duration was
1,050.431892456 seconds and it completed on 2026-10-09 at 03:06:15 UTC. The
runner verified zero remaining application schemas, stopped normally, left no
postmaster PID and released the exclusive lock. No persistent configuration
or production database was changed.

Source manifest: 1,264 files, excluding docs and Markdown, SHA-256
`bdd64c792e152d53d936b4d4af353b3257c602a17224cf47db70fb1f295629b4`.
Eight OpenAPI artifacts: SHA-256
`5c251bcc635ccc3c2601f68aaf1526647c1bdf08dc2f8e65f49e93faf366b5af`.
Every recorded file was rechecked after the full gate with no changes. Independent
source and publication-hygiene review found no confirmed remaining blocker in
this bounded slice.

Serial supplemental reads avoid this native batch's self-induced reader-fence
collision. Cancelled requests may still finish server-side, and external readers
or writers may still produce unavailable responses. The batch is not a guarantee
of global contention-free behavior or production throughput. Physical-device,
real review issuance, historical-source and provider acceptance remain open.
