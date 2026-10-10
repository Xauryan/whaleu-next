# Scalable Profile first-read CI diagnostics

This is observation, not a root-cause fix. The dedicated
`WHALEU_SCALABLE_PROFILE_CI_DIAGNOSTICS=1` flag is read only by
`scalable-discovery-native-roundtrip.test.ts`. It is off by default and enabled
explicitly in the real-PostgreSQL CI test step and local acceptance test step.
No runtime configuration, AppModule, migration, proof budget or retry changes.

Only the first genuine `reader.discovery.profile(authorProfileId, cancel)` is
wrapped. All historical seeds, migrations, scalar authorization, optional counts,
mandatory Safety proof and native transport remain the original fixture path.
The wrapper restores `database.transaction` when that one request ends and restores
each pooled client's `query`/`release` before returning it to the application pool.
Subsequent reads and the 1,102-item traversal are not instrumented.

## Data and bounds

- Query observations retain a transaction ordinal, validated backend PID,
  static phase, monotonic elapsed milliseconds, outcome, allowlisted SQLSTATE and
  error class/application code. The query catch runs before `SAFETY_UNAVAILABLE`
  mapping; unknown SQLSTATE codes become `other-sqlstate`.
- No SQL text, bind values, account/profile IDs, request headers, result payloads,
  error message/detail/hint/stack, credentials or connection URL is emitted.
- Numeric settings are extracted only from existing Safety query results. The
  two unaliased `set_config` results share a column name, so only the final
  `lock_timeout` is available; applied statement timeout stays unknown. Restoration
  is marked only when the successful Safety settings call is followed by entry
  into the optional-final-proof stage. No settings query is added to the proof.
- A separate fixture-pool connection is opened before the request, checked for
  the disposable `whaleu_test` database and destroyed after the request. Its own
  metadata queries have 25 ms statement / 1 ms lock limits. These settings never
  touch an application client or change the mandatory 1 ms / 100 ms / 500 ms
  Safety limits.
- The initial pre-request snapshot has no reader PID yet, hence no lock rows.
  Once the original application transaction supplies its backend PID, an initial
  reader sample runs concurrently with ordinary application work. Sampling resumes
  at the deferred-constraints boundary on a 5 ms timer, for at most 64 queries
  and 1,000 ms. There is at most one observer query in flight; neither the query
  wrapper nor any proof callback awaits it. Only setup and post-request cleanup
  await observer work.
- Samples use `pg_blocking_pids` to identify direct reader/blocker edges and
  `pg_locks` for at most 8 active readers, 8 direct blockers per reader and 32
  rows per sample. Database-local and shared locks are included for those PIDs.
  Only `whaleu_safety.blocks` and its five named indexes are allowlisted; other
  relations become `other-relation`. Lock type/mode are allowlisted, and only
  reader/blocker PID, mode, granted and relation metadata are retained. No
  `pg_stat_activity` data, transaction IDs, advisory keys or page/tuple IDs.
- In-memory rings keep 128 query entries, 16 failures and 16 samples. The complete
  emitted UTF-8 JSON is capped at 32 KiB, including truncation metadata. Failures
  are retained longer than successful context; sampled blocker snapshots are
  preferred over empty samples when trimming output.

## Interpretation and limits

A successful rerun means “not reproduced.” `blockerEvidence: unknown` means no
blocker was sampled, including absent PID, permission/query failure, sampling
limits or a 1 ms wait falling between samples. A nonempty `pg_blocking_pids` edge
is only point-in-time evidence. Sample start/end phases can differ, and a completed
snapshot may already have missed the failed wait. Do not infer checkpoint, index,
DDL or performance causality from timing alone.

The observer consumes one additional fixture connection and adds limited catalog
and event-loop work; even concurrent observation can affect scheduling. Baseline
and diagnostic runs must be identified as such. A direct blocker can be a prepared
transaction (PostgreSQL PID 0), which this positive-backend-PID allowlist omits;
that case remains unknown. This intentionally does not construct a full recursive
blocking graph or synthesize a lock-holder reproduction.

Pure test source covers redaction, truncation, numeric allowlists, phase selection
and the default-off path. Validate these plus ordinary typecheck/lint/format and
the unchanged PostgreSQL fixture in the coordinator's exclusive execution slot
before treating this diagnostic patch as accepted. This patch does not claim any
of those checks passed merely because its source was prepared.
