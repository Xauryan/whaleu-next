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
