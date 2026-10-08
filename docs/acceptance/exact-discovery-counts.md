# Exact discovery count acceptance and benchmark

This document records an executable, disposable normal-AppModule acceptance run.
It is not production migration approval, provider acceptance, or an operational
parity claim. `totalInteractions` remains a separate unavailable legacy metric.

## Reproduce

Portable prerequisites: Node 24.19.0, npm 11.9.0, the checked-in lockfile, and a
new disposable loopback PostgreSQL **18.6** database named `whaleu_test`. Do not
point these tests at an existing development/business database. The complete
proof suite exercises 65 actual simultaneous writers, so configure at least 100
connections; the default PostgreSQL configuration sum remains inside the
128-slot proof envelope.

For example, this dedicated container uses explicitly synthetic local test
credentials and no persistent volume:

```sh
docker run --rm -d --name whaleu-count-test \
  -e POSTGRES_USER=whaleu_test \
  -e POSTGRES_PASSWORD=local_test_only \
  -e POSTGRES_DB=whaleu_test \
  -p 127.0.0.1:55433:5432 \
  postgres:18.6-bookworm -c max_connections=100
until docker exec whaleu-count-test pg_isready -U whaleu_test -d whaleu_test; do
  sleep 1
done
export TEST_DATABASE_URL=postgresql://whaleu_test:local_test_only@127.0.0.1:55433/whaleu_test
npm ci --ignore-scripts
npm run check
npm run format:check
npm run test:integration
docker stop whaleu-count-test
```

To run only the measured count suite after provisioning that database:

```sh
cd apps/api
node --import tsx --test --test-concurrency=1 \
  test/integration/exact-discovery-counts.test.ts
```

The recorded environment used an optional local runner at
`/tmp/whaleu-pg18/run-with-postgres.sh`, which starts and stops a publisher-source
PostgreSQL 18.6 build in the same shell/network namespace as its command. That
private machine path is not a repository dependency. Its equivalent invocation
was `run-with-postgres.sh bash -c 'export TEST_DATABASE_URL="$DATABASE_URL";
cd apps/api; node --import tsx --test --test-concurrency=1
test/integration/exact-discovery-counts.test.ts'`. Full aggregate runs used a
launch-only `max_connections=100` override for the 65-writer fixture.

The suite refuses a non-loopback database, a database not named `whaleu_test`,
unsupported PostgreSQL, pre-existing WhaleU schemas, or a concurrent migration
suite. It migrates an empty database through 0018, establishes genuine historical
memberships before 0019, then applies every migration and restarts AppModule.
Every content row has a canonical synthetic reviewed envelope, digest, decision,
event, head and publication binding. No provider or visibility override is used.
All application schemas are dropped in `finally`.

Fixture support: `apps/api/test/support/exact-discovery-counts.ts`.
Acceptance suite: `apps/api/test/integration/exact-discovery-counts.test.ts`.

## Workload and measurements

- Three authors with 1,025, 4,097 and 25,000 canonical posts.
- Regional and global scopes in the larger histories.
- 4,097 liked memberships are 1,367 posts, 1,365 roots and 1,365 exact replies.
  Every chain has independent named authors, with shared ancestors across kinds.
- All three membership kinds include genuinely undated migrated memberships.
- Profile timestamps include two distinct microseconds across a count-batch edge.
- 25,000 post-like memberships form a separate large own-history benchmark.
- All 13 trading subtypes, both urgency inputs, resolved-trade liked eligibility,
  and uncertainty before resolution/subtype filtering are covered.
- Eight complete named/anonymous post/root/reply mode combinations exercise
  incoming block and missing named-author coverage with anonymous bypass.
- Exact reply/addressed-reply separation and cross-kind reused UUIDs are covered.
- Direct SQL unrelated post updates run every 500, 100 and 10 ms, with three
  count attempts per rate (approximately 2, 10 and 100 writes/second);
  actual completed writes, longest write and known-count availability are emitted.
  A separate fresh, small AppModule fixture requires known counts after an
  unrelated commit and captures exact PostgreSQL lock holders for maintenance-mode
  and writer-contention failures.

The ordinary HTTP 1,025/4,097 cases require known exact integers under the normal
resource budget. The 25,000 case explicitly uses a finite 15-second internal count
budget with a 30-second outer assertion. Only that resource argument changes;
AppModule policy providers, owner facts, SQL and final proof remain real. A pass
at the larger budget alone does not establish interactive 25,000-count support.

Measurements are emitted as TAP diagnostics containing `exactCountMeasurement`.
They include elapsed HTTP time, observed real PostgreSQL statement count, sum
and maximum JSON-serialized result bytes, largest cumulative count-batch bytes,
largest result row batch, largest UUID bind array, sampled process heap start/end
and high-water mark, query groups, and selected
transaction isolation. Measurement wraps actual transaction clients and includes
final proof SQL; it does not fabricate successful owner decisions. Query bytes
are serialized JavaScript row bytes, not physical PostgreSQL protocol bytes.
Content-node batches are capped at 768; the safety-head lookup can include those
768 distinct named authors plus the viewer, for a separate 769-entry bound.
Heap is sampled process heap, not an allocation-profiler retained-memory proof.
The test itself retains 25,000 canonical seed records and other fixture arrays;
start/end/high-water values include those fixtures and ordinary GC variation.
Neither their total nor high-water-minus-start is a count-only retained-memory
measurement. Bounded result rows/bind arrays/batch bytes are recorded separately.
Observed HTTP timings include the observer’s JSON serialization CPU/heap cost;
a separate uninstrumented 4,097-row profile and liked request reports the
comparison without that observer.
The first statement (`BEGIN`) precedes the client observer; isolation selections
are separately recorded from actual transaction options and checked by the proof.

Environment diagnostics include Node, CPU model, logical CPU count, memory and
relevant actual PostgreSQL settings. Bulk-fixture maintenance is completed with normal `VACUUM (ANALYZE)` before
timed quiet-window measurements; autovacuum is never disabled. Cache state is
explicitly post-seed warm;
this suite does not evict OS caches or claim cold-cache measurements.

## Additional correctness gates

- Scalar current-policy oracle for whole liked ancestry and held-parent/root
  short-circuiting; unavailable review after a long visible prefix.
- Profile privacy hidden zero, self preference bypass and liked privacy semantics.
- Current phone/student verification unavailable without erasing historical reads.
- Optional SQL cancellation, recovery on the next request, and SQL programming
  errors propagating as sanitized HTTP failure instead of a null count.
- Optional review horizon expiring after deferred checks while basic fields and
  independently proven trade count remain usable; durable guest final proof.
- Explicit READ COMMITTED even when new connections default REPEATABLE READ.
- Candidate EXPLAIN (ANALYZE, BUFFERS) records actual index/sort/temp-block plans.
- Unrelated writer conflict, baseline recovery, sparse scan continuation, and
  opaque cursor continuity over an AppModule restart.

Low-level epoch and fence coverage is separately owned by
`integration/exact-count-proofs.test.ts`; unit differential tests are in
`count-snapshot.test.ts`. The complete serial integration aggregate and native
regressions remain required in addition to this focused suite.

## Hosted CI failure and the 2-second scan budget

Published snapshot `8f22600dc1e75b76fded79dbe1dd4da6b5c72b10` passed the local
1,511-test run below, but its [hosted CI job](https://github.com/Xauryan/whaleu-next/actions/runs/37713167590/job/113103541530)
passed only **520/529 PostgreSQL tests**, after **297 API + 685 native** passes.
Eight mixed-liked known-count assertions and their parent suite failed under
the 1,500 ms scan budget. The instrumented 4,097 mixed-liked request returned
unavailable at 1,646 ms HTTP after 14 of 17 candidate batches. Its uninstrumented
counterpart was exact at 1,617 ms HTTP; page/final work is outside the scan budget.
The 25,000-record 15-second benchmarks were exact at 5,307 ms profile and
6,170 ms liked HTTP. Raw extracted CI diagnostics and failure names are retained
in `exact-discovery-counts.ci-8f22600.json`; that job is not a correctness pass.

The default scan allowance is now a finite **2,000 ms per count**, a 500 ms (33%)
increase supported by the measured hosted-runner shortfall. Exact-value assertions
and all canonical policy/proof checks are unchanged. Deterministic clock coverage
requires default completion at 1,750 ms, rejection at 2,000 ms, and rejection of
the same 1,750 ms work under an explicit 1,500 ms allowance. A real acceptance
rerun is required; the old table below is not relabeled as 2-second evidence.

This is not a 2-second HTTP timeout. Profile basics has two count scans, so its
scan allowance rises by 1 second to 4 seconds. Two separate 600 ms optional final
callbacks and the 500 ms mandatory relationship proof give 5.7 seconds of
configured phase allowances. Single-count profile/liked lists have 3.1 seconds,
plus their mandatory page work. Scheduling and cleanup can add elapsed time.
Existing shared policy gates and mandatory row locks remain held until commit.
Admission stays at two scans/recounts and below the full configured pool size;
100 ms source statements, 25 ms lock waits, 4 MiB batches, 500 ms small recounts
and mandatory proof, and the separate 15-second benchmark remain unchanged.
Coarse invalidation and finalizer contention still leave operational parity open.

The local focused rerun with this default and the integrated named-read changes
passed **21/21 in 87.95 seconds** on PostgreSQL 18.6. Instrumented 4,097 profile
counts were exact at 725–731 ms and mixed-liked counts at 1,362–1,444 ms;
uninstrumented requests were exact at 612 ms and 1,242 ms respectively. Normal
25,000 counts remained unavailable at 2,023 ms profile and 2,053 ms liked HTTP.
The separate 15-second benchmarks completed exactly at 4,073 ms and 5,634 ms.
`exact-discovery-counts.2s-run.json` retains the diagnostics and source fingerprint.
This local rerun does not establish hosted CI success; integrated gates and the
next published commit's CI remain separate evidence.

The same rerun still had **0/3 known** large counts at each unrelated-writer rate,
**3/6 known** for concurrent profile/profile, and **6/6 known** for concurrent
profile/mixed-liked. Longest observed writer times were **92.4, 13.2 and 25.5 ms**
at the 2/10/100-per-second schedules; the 92.4 ms observation is not an established
lock-only delay. No improved churn or worst-case writer latency is claimed.
Cleanup verified zero remaining application schemas and a stopped local server.

## Prior local 1,500 ms baseline

2026-10-08 final serial aggregate: **529/529 PostgreSQL tests passed in 317.3
seconds**. The exact-count fixture contributes **21/21 in 83.2 seconds**; the
fresh small-fallback/mandatory-relationship fixture and every native roundtrip
also pass. Local `npm run check` passed **297 API + 685 native tests**, lint,
strict type checks, builds and compiled native smokes. Formatting and whitespace
checks pass. These are historical local results for the published snapshot whose
subsequent hosted CI failure is recorded above.

Runtime/test freeze: `76f831c0d5b5e6caa5a34552dca2c8ddbb85868dfbcd7669359c3d83afeb1ee0`.
The exact sorted file manifest and hashing convention (path + NUL + file bytes +
NUL) are recorded in `exact-discovery-counts.final-run.json` with the final raw
measurement diagnostics. Acceptance prose/JSON are outside that source/test
manifest. That source used the original 1,500 ms normal count budget.

Historical measurements remain separately labeled in
`exact-discovery-counts.first-run.json`, `exact-discovery-counts.optimized-run.json`
and `exact-discovery-counts.pre-freeze-run.json`. They are not evidence for the
final source. The early required mixed-liked positive gate failed; canonical
parse/equality caching and removal of redundant timeout round trips restored it.
A subsequent full run exposed a distinct historical timestamp bug: PostgreSQL
JSON retained the pre-1883 Los Angeles offset `-07:52:58`, which native JavaScript
Date parsing rejected. Standard ISO parsing now has a scalar-pg-compatible
fallback for those historical offsets, with differential boundary regressions.
The source also skips only provably empty indexed child-key queries. Microsecond
post seek coordinates remain separate lossless database text.

The prior local table includes scoped mandatory relationship proof overhead and the
post-seed `VACUUM (ANALYZE)` preparation described above.

| Workload                |        Count budget | Known exact result | Observed HTTP ms | SQL calls |       JS result bytes |     Candidate batches |
| ----------------------- | ------------------: | -----------------: | ---------------: | --------: | --------------------: | --------------------: |
| Profile 1,025           |            1,500 ms |              1,025 |          219–259 |       166 |             4,702,223 |  5 + empty trade scan |
| Post likes 1,025        |            1,500 ms |              1,025 |          218–255 |   286–289 |   5,114,093–5,114,694 |                     5 |
| Profile 4,097           |            1,500 ms |              4,097 |          647–745 |       334 |            18,372,347 | 17 + empty trade scan |
| Mixed chain likes 4,097 |            1,500 ms |              4,097 |      1,268–1,402 |   704–707 | 36,162,940–36,163,543 |                    17 |
| Profile 25,000          |            1,500 ms |        unavailable |            1,521 |       559 |            37,808,513 |               aborted |
| Post likes 25,000       |            1,500 ms |        unavailable |            1,537 |       651 |            36,328,564 |               aborted |
| Profile 25,000          | 15,000 ms benchmark |             25,000 |            4,141 |     1,468 |           111,739,702 | 98 + empty trade scan |
| Post likes 25,000       | 15,000 ms benchmark |             25,000 |            5,295 |     1,679 |           119,836,882 |                    98 |

Uninstrumented 4,097 requests: profile 702 ms, mixed likes 1,260 ms, both known.
Observed maximum query rows/binds were 257/256 for post-only workloads and
527/527 for mixed likes. Largest observed cumulative count-batch row JSON was
1,156,421 bytes for 1,025-profile and 2,424,526 bytes for mixed likes. Process
heap high-water reached approximately 528 MB in this fixture-heavy process;
this is not a count-only retained-memory bound.

The profile candidate EXPLAIN used an index scan. The six-branch liked candidate
EXPLAIN used indexed branches and bounded merge/incremental sorting, with no
reported temporary read/write blocks. This does not prove every snapshot query
is spill-free or establish cold-cache support.

Cleanup was separately verified against PostgreSQL 18.6: **zero remaining
`whaleu_%` schemas**. The local runner stopped the server, removed its postmaster
PID file and released the serialized runner lock. The runtime timezone was
`America/Los_Angeles`, so the historical-offset regression was exercised in the
actual environment rather than hidden by forcing UTC.

### Operational availability is still a release gap

These are correctness passes, not an operational-parity pass:

- An unrelated post writer at **2 writes/second** caused **0/3 known** 4,097-profile
  counts. The same happened at 10 and 100 writes/second. The visible profile and
  pages remain independently available, but coarse whole-owner epoch validation
  invalidates an unaffected user's complete count. Longest observed writes at
  the three rates were 1.9, 8.9 and 12.4 ms respectively, so this run did not hide
  the count unavailability by serializing those writers behind the whole scan.
- Two concurrent identical profile requests produced **3/6 known** counts (4/6
  in a previous run), even without a source writer. Finalizer contention is conservative but materially
  lowers availability. Concurrent profile + mixed-liked produced 6/6 known.
- The fresh-fixture three-post fallback remained known after an unrelated commit. A
  subsequent unrelated writer launched after its final table fence waited and
  executed in **11.3 ms**, within this fixture’s 500 ms recount budget. That
  limited test does not establish worst-case writer latency for all 1,024-row
  mixed-chain fallbacks.
- The default 25,000-row workload remains unavailable. A 15-second benchmark
  budget proves exact completion, but does not make 4–6 seconds of policy-gate
  hold time suitable for an interactive supported workload.

Finer dependency invalidation and/or indexed-definition/aggregate optimization
remain needed before calling large-count operational parity complete. Broader
cold-cache, realistic many-author skew, admission saturation, physical-device,
provider and production migration acceptance are separate remaining gates.

### Maintenance contention evidence

A later heavy-fixture run failed the small fallback's NOWAIT SHARE fence on
`content_approval_decisions` in 48.9 ms. The server log identified the relation
and SQLSTATE 55P03, but did not retain the conflicting backend PID/mode, so that
historical holder is unknown; autovacuum is a hypothesis, not an established cause.

The final regression structure isolates the strict three-post success/writer
latency gate in a fresh tiny AppModule fixture. Separate deterministic tests hold
an actual `ShareUpdateExclusiveLock` (a mode also used by maintenance) on review
decisions and an actual uncommitted post writer. Failed-query diagnostics capture
`pg_locks` relation/mode and backend type/PID from another connection. Following
an unrelated committed epoch change, both conflicts must leave the fallback count
unavailable while independently valid basics, and a maintenance-conflicted selected
page, remain usable. After release, exact counts must recover. Maintenance alone
need not invalidate an unchanged optimistic proof; the broad fallback fence is
the additional contention point tested here. Runtime fences are unchanged, and no
wait/retry or zero fallback is introduced to hide this availability limit.
