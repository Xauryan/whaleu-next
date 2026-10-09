# R2A local acceptance status

Date: 2026-10-09 UTC. The final frozen R2A snapshot passed the complete local repository gate described below. This is not release approval or complete rating parity. Publication, hosted CI, physical WeChat devices, real review issuance, authoritative history and provider delivery remain unverified.

## Implemented local scope

- Normal AppModule text reply/discussion/single/position/create/delete/recovery routes and native strict gateways/controllers
- Same-target personas, server-derived typed ancestry and private beneficiaries/recipients
- Root-wide effective tombstones; single-reply deletion preserves later replies with unavailable quotes
- Atomic transition/effect/reward/registry/work/direct-obligation capture and strict minimal receipts
- Real shared-pool Experience settlement and independent unknown-baseline handling
- Direct local rating notices, current previews, owner unread/read state and safe native position navigation
- Existing R1 journal/recovery compatibility and separate reply recovery under one request namespace

Likes, target subscriptions, media, management, specialist review domains and historical reconciliation remain separate parity gates. Author cumulative received-like deletion policy remains undecided. No additional default was implemented.

## Focused evidence

The exact current focused PostgreSQL command is run from `apps/api` using `node --import tsx --test --test-concurrency=1` with:

- `test/integration/ratings-r1.test.ts`
- `test/integration/ratings-replies.test.ts`
- `test/integration/ratings-reply-proofs.test.ts`
- `test/integration/ratings-updates.test.ts`
- `test/integration/ratings-experience.test.ts`
- `test/integration/experience-source-registry.test.ts`
- `test/integration/ratings-r2a-native-roundtrip.test.ts`
- `test/integration/ratings-owner-proof.test.ts`
- `test/integration/ratings-storage-proof.test.ts`
- `test/integration/ratings-native-roundtrip.test.ts`

The final focused invocation on 2026-10-09 01:47:57–01:49:01 UTC passed 105 tests with 0 failed, cancelled or skipped (runner duration 63.884 seconds). Test-runner counts include parent tests; they are not counts of distinct business scenarios. It includes the last SQL canonical-text and positive-ordinal guards. The run ended with zero application schemas, a normally stopped server and a free exclusive runner lock. This is still the ten-file focused command above, not the full repository gate.

Other focused checks:

- 103 contract, Review, authority, notice and typed-source unit tests passed in one invocation
- 2 offline OpenAPI tests passed; 18 paths expose 23 operations, with strict output schemas and auth/cache/error metadata
- API TypeScript and scoped ESLint passed
- Native build, emitted-runtime smoke and native tests were included in the final root gate recorded below

PostgreSQL runs use the exclusively leased disposable PostgreSQL 18.6 loopback database with a launch-only 100-connection limit. Completed runs verify zero application schemas and stop their own server normally. Prior migration/test failures were fixed and rerun; they are not recorded as successful runs. No existing migration 0001–0044 was changed.

## Important measured cases

These are focused measurements, not production-throughput claims:

- A real 100-reply root, including a position page of 50 replies referencing 50 different earlier replies, uses 104 Ratings facts and 205 Review facts. Final checks contain no repair writes. Deleting the root makes early and late descendants inaccessible without copying tombstones to a first batch.
- Twenty distinct notification target/root/reply chains use 61 Ratings facts and 121 Review facts, with the existing 128-slot Safety fence. Only the 20 selected current reply bodies are read; quoted bodies are not read for previews.
- A root-local head lookup reads current continuation metadata rather than scanning transition history. Its typed FK, fresh transition guard, monotonic advancement, reverse completeness and savepoint rollback are tested.
- Raw root/child updates fail immediately when they would wait backward on another transaction's parent lock. Publication/root deletion and materializer/read/delete/markRead interleavings exercise actual PostgreSQL locks.
- Missing capture, work, automatic effects, notice obligations, units or root heads abort the publication. Independent same-transaction roots/replies and create-then-delete retain exact causal receipts and reward history.
- Reply-v2 review consumption and existing session/phone/catalog authority expirations after deferred waits roll back tentative content/effects/receipts.
- New root, root/self/nested recipient matrices, shared community/rating fifth/sixth quota boundaries, unknown beneficiaries, concurrent processing, exact acknowledgement failures and deletion-before-settlement use real settlements, records, balances and buckets.
- A nonempty 0044 database containing community completed/pending/blocked/saved work migrates with its old rows and enrollment sequence unchanged. Existing R1 root/request replay creates no fresh effect or reward. A new reply to that same old root produces and settles current genuine units.
- Actual native controllers/gateways cross AppModule HTTP and PostgreSQL for legacy-v1 journal recovery, v2 uncertain root/reply recovery, real ledger/local notices, position-before-markRead and stale same-account navigation fencing.

## Regression found by the new history probes

An ordinal selected as text was also used unqualified in ORDER BY, so PostgreSQL could sort it lexicographically. The R1 root-page path had this gap; the R2A reply/notice implementations initially shared it. All three now explicitly order by the numeric stored column. Real pages spanning ordinal 9/10/100 and opaque continuation tests cover the fix. The signed R1 checkpoint and its old acceptance record were not rewritten; those earlier tests did not cover this larger history.

## Final local full gate

The same frozen source passed the root check: whole-repository lint, both
TypeScript checks, deterministic offline OpenAPI verification, unit tests and
both builds including all old and new native emitted-runtime smoke. Whole-repo
format checking and the separate real-cloc 2.10 integration test also passed.

The full total was **3,684 tests**: 5 statistics, 880 API, 1,389 native and
1,410 PostgreSQL tests. All passed, with zero failures, skips or cancellations.
The separate real-cloc integration test passed 1/1 outside that total.

The isolated PostgreSQL 18.6 full suite used launch-only max_connections=100,
took 988.515115109 seconds, and completed on 2026-10-09 at 02:08:05 UTC. The
runner verified zero remaining application schemas, stopped normally, left no
postmaster PID and released the exclusive lock. No persistent configuration or
production data was changed.

Source manifest: 1,228 files, excluding docs and Markdown, SHA-256
`bd36db327f79f59a7a2e8ca6c139316dc87cf3edb1a0f9dbb540e477833e5cd5`.
Eight OpenAPI artifacts: SHA-256
`8157f6031687d10f0a2a3f691ecd11a31d974417fac1c652635d4ff17fcc4e7a`.
Every recorded file was rechecked after the complete gate with no changes.
Final source review and publication-hygiene review found no confirmed remaining
blocker in this bounded slice.

## Release boundaries

Remote branch publication and hosted CI remain pending. Local results do not
establish production readiness, real review issuance, authoritative historical
coverage, provider delivery or physical-device behavior. The previous R1 total
is separate historical evidence and is not used as this R2A gate result.
