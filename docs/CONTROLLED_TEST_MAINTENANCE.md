# Disposable PostgreSQL maintenance in correctness tests

The CI main and optional semantic jobs start new, unmounted PostgreSQL 18.6
containers with `autovacuum=off` supplied only on the server command line. This
is an explicit **test environment**, not a recommended deployment setting. The
application's configuration, migrations, transaction limits, NOWAIT proofs and
production defaults are unchanged. Healthy fixtures still require their original
successful HTTP responses; a 503 is never accepted as a healthy success.

`NODE_ENV=test` and `WHALEU_TEST_MAINTENANCE=controlled` are required by the
read-only `scripts/verify-test-postgres.mjs` admission check. It verifies the exact
loopback `whaleu_test` database/user, pinned server version, command-line setting
source, enabled statistics, low cluster XID/multixact ages, recent server start,
no application schemas/public tables and no other client or maintenance workers.
It does not issue ALTER SYSTEM, change table reloptions, edit configuration or
connect to an existing production target. Freshness additionally comes from the
new container without mounted data, or local initdb directory, not from a name
check alone. Admission runs before migrations and fixture creation.

## Lifetime and cleanup

CI uses `always()` container removal including anonymous volumes on success,
failure and job cancellation. No persistent database volume is attached. The
local equivalent also creates a new initdb directory for each invocation, stops
PostgreSQL normally in its EXIT/INT/TERM trap, and prints the directory for optional
failure inspection. It never adopts or modifies an existing cluster. Retained
local diagnostic files are not automatically reused. An uncatchable process kill
can interrupt shell cleanup; inspect the reported directory/port before any
manual cleanup and do not assume a trap ran.

Example using already installed PostgreSQL binaries, from `apps/api`:

```sh
NODE_ENV=test WHALEU_TEST_MAINTENANCE=controlled \
WHALEU_TEST_PG_BIN=/absolute/path/to/postgres18/bin \
bash ../../scripts/run-controlled-test-postgres.sh \
  timeout 600 npm run test:semantic:integration
```

The optional semantic suite additionally requires the pinned pgvector extension
already installed in those PostgreSQL binaries. The script installs no software.
The default local port is 55432; `WHALEU_TEST_PG_PORT` selects another explicit
unprivileged port. The port lease prevents concurrent use by this wrapper.

## Real maintenance and conflict evidence

Ordinary background maintenance is not randomly scheduled during the healthy
suite, including fixture setup. There are no early business-table prelocks or
HTTP retries to manufacture successful results. Existing real concurrent-writer
and SHARE UPDATE EXCLUSIVE refusal tests remain unisolated, retaining exact 503,
rollback and no-side-effect assertions. The scoped-random acceptance case also
performs real manual `VACUUM ANALYZE` at its explicit quiescent boundary, verifies
manual maintenance statistics, and retains the healthy 200/2048 and real conflict
checks. This is scheduled maintenance, not a mocked success.

A separate maintenance-on diagnostic used real autovacuum with a one-second
naptime. It observed an autovacuum worker holding a granted
ShareUpdateExclusiveLock on a Media table. That bounded run passed; the historical
CI failure's exact holder remains unknown. Do not describe the controlled suite
as proving that production maintenance or other concurrent writers cannot cause
503 responses. Real deployment availability and same-key recovery under normal
maintenance remain a separate operational concern.

PostgreSQL defaults autovacuum to on. Turning it off does **not** disable forced
anti-wraparound vacuum. Fresh, low-age disposable clusters avoid relying on that
exception being absent in an old database; no freeze/failsafe limits are raised.
See the [PostgreSQL 18 vacuum settings](https://www.postgresql.org/docs/18/runtime-config-vacuum.html)
and [lock compatibility](https://www.postgresql.org/docs/18/explicit-locking.html).

## Hosted compatibility follow-up

The first controlled hosted run on `01d157c` passed admission, all 42 semantic cases, the 32-image and complete 1,001/2,048 Category scenarios, and both encoding optimizations. Its four failing leaf cases were older maintenance tests: two assumed ordinary autovacuum must be on even in the explicitly admitted controlled mode; two unqualified whole-database VACUUM commands spent their unchanged budget cleaning shared system catalogs accumulated during the full suite.

The follow-up changes only three test files and one test helper. Default-mode tests still require autovacuum on; controlled mode requires off from command-line configuration. Actual VACUUM holding its granted maintenance lock, concurrent HTTP success, unchanged epochs and all writer/refusal assertions remain mandatory. Three unqualified VACUUM calls now enumerate only the fixture-owned application relations in the complete migration-schema whitelist, reject escaping inheritance, and verify each table's manual vacuum and analyze counters increased. They still execute one real VACUUM statement under the original timeout, without scanning unrelated system catalogs.

The three affected files passed 52/52 real PostgreSQL tests with zero skips, along with type, lint and formatting checks. Only a two-line stale comment changed after that run. No production code, migrations, workflow, 10-second SQL budget or 500-millisecond recount budget changed. Hosted full follow-up remains pending.

## Complete file-sharded CI

The `foundation` job runs the existing cheap checks, database admission unit
checks, and the shard allocator's unit/coverage checks once. Its success admits
four `main-integration` matrix jobs. Each job starts its own fresh PostgreSQL
18.6 container on its own hosted runner, with the same controlled-maintenance
configuration, read-only freshness admission, diagnostics and unconditional
container/volume cleanup as before. No database is shared across shards. The
optional semantic job remains independent and unchanged. Each main job performs
only the required WeChat build after installation, because emitted native-worker
tests load `apps/wechat/dist` and a fresh job does not inherit foundation's build
outputs. It does not repeat the full cheap test/type/lint/OpenAPI suite.

The existing required-check name `verify` is now the final aggregate. It uses
`always()` and requires `foundation`, the whole main matrix, and
`semantic-integration` to report `success`. A failure, cancellation or skipped
dependency cannot produce a green aggregate. Matrix `fail-fast: false` lets the
other shards finish after one fails; it does not turn that failure into success.
Check every job for the exact commit and the final workflow conclusion. An older
run cancelled by workflow concurrency is cancelled, not successfully verified.

`scripts/run-integration-shard.mjs` discovers exactly
`apps/api/test/integration/*.test.ts`. It sorts the files and assigns each by the
first unsigned 32 bits of SHA-256 of its filename, modulo the shard count. With a
fixed count, adding files automatically includes them without moving existing
files. Before spawning tests, it rejects invalid indices/counts, duplicates,
non-files, empty shards, and any partition whose union differs from the complete
glob. No case list or historical timing file controls coverage. Every invocation
logs the complete corpus count/digest, selected count and exact selected paths.
The foundation log includes all four manifests for comparison.

Each shard runs the original Node test command and `--test-concurrency=1` from
`apps/api`, with the inherited environment and only its assigned file arguments.
The outer `timeout 7200` remains unchanged, as do all individual test, SQL,
clock, media and proof budgets. The ordinary unsharded `npm run test:integration`
command remains available. These commands inspect allocation without loading
`tsx`, opening a database, or executing integration tests:

```sh
node --test scripts/run-integration-shard.test.mjs
node scripts/run-integration-shard.mjs --verify 4
node scripts/run-integration-shard.mjs --shard 1/4 --list
```

For totals, use each Node process's terminal `tests`, `pass`, `fail`, `cancelled`,
`skipped` and `todo` summary once, across all four main shards. Do not add the
individual child/parent failure lines again: one failing leaf can also fail its
parent. Main coverage is only complete when all manifests cover the same corpus,
all four processes finish successfully, and their terminal summaries have no
unexpected cancellations/skips. Report semantic and cheap-suite totals separately.

### Timing evidence and verification limit

[Hosted run 38140263937](https://github.com/Xauryan/whaleu-next/actions/runs/38140263937)
(`bf508da`) completed 263 main files and 2,640 tests in 90.98 minutes.
[Hosted run 38151758064](https://github.com/Xauryan/whaleu-next/actions/runs/38151758064)
(`cddc675`) finished 252 of 267 files, with useful progress until 17:40:04 UTC,
then hit the unchanged 7,200-second process timeout on 2026-10-11. Its terminal
summary was 2,490 tests: 2,471 pass, four fail (two failing leaves and their two
parents), and 15 cancelled. This is failed, incomplete evidence, not a pass or
proof of an open-handle hang. The functional failures require their own fixes.

Mapping top-level completion names to each run's source files, and measuring
consecutive file completion boundaries, gives a longest completed file of
264.53 seconds (`rating-category-icon-management.test.ts`). The 248 common
completed files grew from 87.45 to 118.88 minutes; the four new completed files
added only 65.4 seconds. The common-file median increase was 4.58 seconds and
median ratio 1.60. These observational runs do not isolate migration 0099,
runner performance or accumulated catalog costs as the cause.

For the 273-file `aaf9cc8` tree, using the latest observed file durations, old
unreached files scaled by that 1.60 ratio, and median estimates for unpublished
files gives four projected shard times of 36.6, 30.4, 35.7 and 25.0 minutes
(three shards would project 31.6, 45.3 and 50.9 minutes). These are planning
estimates excluding installation, not new hosted results or guarantees. Local
allocator/command/YAML checks establish selection and wiring only. All four
real PostgreSQL shards on the final commit must pass in hosted CI before the
sharded integration gate is considered verified.

### Hosted four-shard verification on 2026-10-11

[Verify 38162875745](https://github.com/Xauryan/whaleu-next/actions/runs/38162875745)
completed successfully on baseline `754e140eef0062c0805d7e973746800126d8b752`
in 38 minutes 36 seconds. All four ordinary PostgreSQL shards passed:
596 + 788 + 689 + 634 = 2,707 tests. Semantic PostgreSQL passed 42 tests;
API and native units passed 1,820 and 2,549 respectively. Including stats/search,
admission/shard guards and the foundation-emitted tests, the main reported
suite total was 7,164. Repeated emitted smoke checks in each of the four shards
and the separate successful Stats workflow are additional checks, not added to
that total. This is actual hosted evidence replacing the projection for this
baseline, and verifies the repaired functional regressions and complete sharded
gate; the earlier `cddc675` failure remains recorded above.

The later native announcement-authoring/Media12 increment is not covered by this
baseline run. Its local verification is recorded in
[announcement authoring](ANNOUNCEMENT_AUTHORING.md); its own hosted run remains
pending until performed on that increment's final tree.

### Per-file ordinary CI cluster lifetime

Ordinary module shards now opt in to `WHALEU_TEST_PG_ISOLATION=per-file-docker`.
The complete inventory, stable module assignments and native-artifact provenance
checks remain unchanged. Each selected ordinary file runs serially in its own
new, unmounted PostgreSQL 18.6 container, with command-line `autovacuum=off` and
loopback-only listening on the existing host network. This bounds accumulation
of dead system-catalog entries across destructive fixture files without adding
background maintenance, changing migrations or increasing any test/SQL deadline.
All tests, concurrent writers and shared state inside a file remain together.
The two browser-only single-file shards keep their existing service setup and
TAP diagnostics; optional semantic and production strict-TLS lanes are unchanged.

The runner requires explicit controlled CI admission and the exact synthetic
loopback target before creating anything. It creates a unique container, checks
its full ID, exact job-owner label, pinned image, server command, network and
absence of host/reused named mounts, then starts it and waits for health. The
[official PostgreSQL 18.6 Bookworm Dockerfile](https://github.com/docker-library/postgres/blob/master/18/bookworm/Dockerfile)
defines `PGDATA=/var/lib/postgresql/18/docker` and its anonymous volume at
`/var/lib/postgresql`, which is the exact mount destination admitted here. The
existing read-only database freshness admission runs before the file. Each child
receives its own full container ID in `MAIN_PG_CONTAINER`, preserving restore and
`pg_dump` fixtures. No existing cluster or container name is adopted.

A start/end JSON record identifies each file, source-content SHA-256, workflow
source SHA, owner, container and child exit status. The file content is rehashed
immediately before and after its child process; changed content fails closed
rather than being attributed to the initial hash. Assertion failures retain a
nonzero aggregate while later files still run. Infrastructure, admission, signal
or cleanup failures stop execution and are never recorded as successful tests.
The end record is successful only after the original test command and owned
container cleanup both succeed. An infrastructure failure can leave selected
files unrun: a manifest is a plan, not a pass record. For leaf totals, sum each
single-file Node process's terminal summary once, and require zero unexpected
skips/cancellations plus all expected successful per-file records. Do not count
JSON records as extra tests or count parent failures twice.

Cleanup removes only a full ID whose owner and configuration still match,
including its anonymous volume. CI's unconditional cleanup separately discovers
only containers bearing this exact job-owner label and repeats ownership checks
before removal, covering interrupted execution or uncertain container creation.
Unknown ownership or failed inspection/removal fails closed; it never triggers
broad pruning. The original 7,200-second ordinary outer deadline and 150-minute
job deadline remain unchanged. Image pull occurs once per ordinary job. Additional
container startup/teardown overhead has not yet been measured in hosted CI;
mock lifecycle/guard tests establish wiring and failure behavior, not real
PostgreSQL correctness or a successful complete hosted run.
