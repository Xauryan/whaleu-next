/** Opt-in observation of one real synthetic-fixture Profile request only.
 * No production imports this file. No SQL, bind values, rows or error text are
 * retained. Sampling never adds an awaited query to an application transaction.
 */
import assert from 'node:assert/strict';
import type { INestApplication } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { APP_CONFIG } from '../../src/config/config.js';
import type { RuntimeConfig } from '../../src/config/config.js';
import { DatabaseService } from '../../src/database/database.js';
import type { TransactionOptions } from '../../src/database/database.js';
import { ratingsCiSafeError } from './ratings-ci-diagnostics.js';

export const SCALABLE_PROFILE_CI_MAX_BYTES = 32 * 1024;
const MAX_SAMPLES = 64;
const MAX_LOCK_ROWS = 32;
const MAX_READERS = 8;
const MAX_BLOCKERS = 8;
const SAMPLE_INTERVAL_MS = 5;
const SAMPLE_WINDOW_MS = 1000;
type Phase =
  | 'first-profile'
  | 'optional-count-scan'
  | 'constraints'
  | 'safety-settings'
  | 'safety-table-fence'
  | 'safety-batch'
  | 'safety-other'
  | 'optional-final-proof'
  | 'commit'
  | 'rollback';
const sqlstates = new Set([
  '55P03',
  '57014',
  '40P01',
  '40001',
  '25P02',
  '08000',
  '08001',
  '08003',
  '08004',
  '08006',
  '08007',
  '08P01',
  '53300',
  '53400',
  '57P01',
  '57P02',
  '57P03',
  'XX000',
  '0A000',
  '42P01',
  '42703',
  '42501',
  '3D000',
]);

export function scalableProfileCiSafeError(error: unknown) {
  const safe = ratingsCiSafeError(error);
  return {
    ...safe,
    sqlstate:
      safe.sqlstate === null
        ? null
        : sqlstates.has(safe.sqlstate)
          ? safe.sqlstate
          : 'other-sqlstate',
  };
}
type SafeError = ReturnType<typeof scalableProfileCiSafeError>;

function pid(value: unknown): number | null {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= 2147483647
    ? value
    : null;
}
function elapsed(start: number): number {
  return Math.round((performance.now() - start) * 1000) / 1000;
}
export function scalableProfileCiTimeoutMs(value: unknown): number | null {
  if (typeof value !== 'string' || value.length > 32) return null;
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|min|h|d)?$/.exec(value);
  if (!match) return null;
  const units: Record<string, number> = {
    ms: 1,
    s: 1000,
    min: 60000,
    h: 3600000,
    d: 86400000,
  };
  const milliseconds = Number(match[1]) * units[match[2] ?? 'ms']!;
  return Number.isFinite(milliseconds) && milliseconds <= 2147483647
    ? milliseconds
    : null;
}
const relations = new Set([
  'whaleu_safety.blocks',
  'whaleu_safety.blocks_pkey',
  'whaleu_safety.blocks_blocker_id_blocked_id_key',
  'whaleu_safety.blocks_id_blocker_id_key',
  'whaleu_safety.blocks_own_active',
  'whaleu_safety.blocks_reverse_active',
]);
const modes = new Set([
  'AccessShareLock',
  'RowShareLock',
  'RowExclusiveLock',
  'ShareUpdateExclusiveLock',
  'ShareLock',
  'ShareRowExclusiveLock',
  'ExclusiveLock',
  'AccessExclusiveLock',
  'SIReadLock',
]);
const locktypes = new Set([
  'relation',
  'extend',
  'frozenid',
  'page',
  'tuple',
  'transactionid',
  'virtualxid',
  'spectoken',
  'object',
  'userlock',
  'advisory',
  'applytransaction',
]);
/** Select fields explicitly even though the sampler SQL also redacts names. */
export function scalableProfileCiSafeLock(value: Record<string, unknown>) {
  return {
    readerPid: pid(value['reader_pid']),
    blockingPids: Array.isArray(value['blocking_pids'])
      ? value['blocking_pids']
          .slice(0, MAX_BLOCKERS)
          .map(pid)
          .filter((item): item is number => item !== null)
      : [],
    pid: pid(value['pid']),
    relation:
      typeof value['relation'] === 'string' && relations.has(value['relation'])
        ? value['relation']
        : 'other-relation',
    mode:
      typeof value['mode'] === 'string' && modes.has(value['mode'])
        ? value['mode']
        : 'other-mode',
    locktype:
      typeof value['locktype'] === 'string' && locktypes.has(value['locktype'])
        ? value['locktype']
        : 'other-locktype',
    granted: typeof value['granted'] === 'boolean' ? value['granted'] : null,
  };
}
type Lock = ReturnType<typeof scalableProfileCiSafeLock>;
type Entry = {
  transaction: number;
  backendPid: number | null;
  phase: Phase;
  boundary: 'query' | 'transaction';
  elapsedMs: number;
  outcome: 'ok' | 'error';
  error: SafeError | null;
  settings: {
    source: 'existing-settings-read' | 'existing-set-config-result';
    statementMs: number | null;
    lockMs: number | null;
  } | null;
};
type Sample = {
  phaseAtStart: Phase | 'before-request';
  phaseAtEnd: Phase | 'before-request';
  elapsedMs: number;
  outcome: 'ok' | 'error';
  error: SafeError | null;
  truncated: boolean;
  locks: Lock[];
};
type Snapshot = {
  transactions: number;
  request: {
    outcome: 'ok' | 'error';
    elapsedMs: number;
    error: SafeError | null;
  };
  observer: {
    available: boolean;
    error: SafeError | null;
    samples: number;
    sampleLimitReached: boolean;
    windowExpired: boolean;
    unknownBackendPid: boolean;
    readerLimitReached: boolean;
    // A sampled blocker is a point-in-time observation, never a cause claim.
    blockerEvidence: 'sampled' | 'unknown';
    restorationObserved: boolean;
  };
  recent: Entry[];
  failures: Entry[];
  samples: Sample[];
};
function ring<T>(capacity: number) {
  const values: T[] = [];
  let dropped = 0;
  return {
    push(value: T) {
      if (values.length === capacity) {
        values.shift();
        dropped++;
      }
      values.push(value);
    },
    read: () => [...values],
    dropped: () => dropped,
  };
}
/** Called after the request finishes. The cap includes truncation metadata;
 * preserve query failures longer than successful context and lock samples. */
export function boundedScalableProfileCiSnapshot(
  snapshot: Snapshot,
  ringDrops = { recent: 0, failures: 0, samples: 0 },
) {
  const result = {
    fixture: 'scalable-discovery-native-roundtrip',
    window: 'first-profile-only',
    serializedByteLimit: SCALABLE_PROFILE_CI_MAX_BYTES,
    truncated:
      Object.values(ringDrops).some((count) => count > 0) ||
      snapshot.samples.some((sample) => sample.truncated),
    dropped: { ...ringDrops },
    transactions: snapshot.transactions,
    request: { ...snapshot.request },
    observer: { ...snapshot.observer },
    recent: [...snapshot.recent],
    failures: [...snapshot.failures],
    samples: [...snapshot.samples],
  };
  while (
    Buffer.byteLength(JSON.stringify(result), 'utf8') >
    SCALABLE_PROFILE_CI_MAX_BYTES
  ) {
    result.truncated = true;
    if (result.recent.length) {
      result.recent.shift();
      result.dropped.recent++;
    } else if (result.samples.length) {
      // Preserve a sample with blockers over an empty/unsampled one.
      const empty = result.samples.findIndex(
        (sample) => !sample.locks.some((lock) => lock.blockingPids.length),
      );
      result.samples.splice(empty < 0 ? 0 : empty, 1);
      result.dropped.samples++;
    } else if (result.failures.length) {
      result.failures.shift();
      result.dropped.failures++;
    } else break; // Only fixed-size metadata remains (< 2 KiB).
  }
  return result;
}

// Exact owner query shape, not the similar optional-count settings read.
const safetySettings =
  "SELECT current_setting('transaction_isolation') AS isolation, current_setting('statement_timeout') AS statement_timeout, current_setting('lock_timeout') AS lock_timeout";
const setTimeouts =
  "SELECT set_config('statement_timeout',$1,true), set_config('lock_timeout',$2,true)";
type PhaseState = {
  final: boolean;
  safety: boolean;
  optionalCount: boolean;
  optionalFinal: boolean;
};
export function scalableProfileCiPhase(sql: string, state: PhaseState): Phase {
  const text = sql.replace(/\s+/g, ' ').trim();
  if (text === 'COMMIT') return 'commit';
  if (text === 'ROLLBACK') return 'rollback';
  if (text === 'SET CONSTRAINTS ALL IMMEDIATE') {
    state.final = true;
    return 'constraints';
  }
  if (text === 'SAVEPOINT optional_final_count_proof') {
    state.safety = false;
    state.optionalFinal = true;
  }
  if (state.optionalFinal) return 'optional-final-proof';
  if (state.final && text === safetySettings) state.safety = true;
  if (state.safety) {
    if (text === safetySettings || text === setTimeouts)
      return 'safety-settings';
    if (text === 'LOCK TABLE whaleu_safety.blocks IN SHARE MODE NOWAIT')
      return 'safety-table-fence';
    if (
      text.startsWith('SELECT r.ordinality::integer AS ordinal,') &&
      text.includes('LEFT JOIN whaleu_safety.blocks outgoing') &&
      text.includes('LEFT JOIN whaleu_safety.blocks incoming')
    )
      return 'safety-batch';
    return 'safety-other';
  }
  if (text === 'SAVEPOINT discovery_optional_count') state.optionalCount = true;
  const phase = state.optionalCount ? 'optional-count-scan' : 'first-profile';
  if (text === 'RELEASE SAVEPOINT discovery_optional_count')
    state.optionalCount = false;
  return phase;
}

// The observer reads lock metadata only, for active readers and their direct
// pg_blocking_pids edges. It never selects backend query text, transaction IDs,
// advisory keys, tuple/page identifiers or any application rows.
const lockSnapshotSql = `WITH readers AS MATERIALIZED (
  SELECT reader_pid, pg_blocking_pids(reader_pid) AS blockers
  FROM unnest($1::integer[]) AS r(reader_pid)
), participants AS (
  SELECT reader_pid, blockers, reader_pid AS pid FROM readers
  UNION
  SELECT reader_pid, blockers, unnest(blockers[1:8]) AS pid FROM readers
)
SELECT p.reader_pid, p.blockers[1:8] AS blocking_pids,
  cardinality(p.blockers)>8 AS blockers_truncated,
  l.pid, l.locktype, l.mode, l.granted,
  CASE WHEN n.nspname='whaleu_safety' AND c.relname IN (
    'blocks','blocks_pkey','blocks_blocker_id_blocked_id_key',
    'blocks_id_blocker_id_key','blocks_own_active','blocks_reverse_active'
  ) THEN 'whaleu_safety.' || c.relname ELSE 'other-relation' END AS relation
FROM participants p LEFT JOIN pg_locks l ON l.pid=p.pid
  AND (l.database IS NULL OR l.database=(
    SELECT oid FROM pg_database WHERE datname=current_database()))
LEFT JOIN pg_class c ON c.oid=l.relation
LEFT JOIN pg_namespace n ON n.oid=c.relnamespace
ORDER BY cardinality(p.blockers)>0 DESC, l.granted ASC NULLS LAST,
  (n.nspname='whaleu_safety' AND c.relname IN (
    'blocks','blocks_pkey','blocks_blocker_id_blocked_id_key',
    'blocks_id_blocker_id_key','blocks_own_active','blocks_reverse_active'
  )) DESC NULLS LAST, p.reader_pid, l.pid, l.mode
LIMIT 33`;

export async function observeFirstScalableProfile<T>(
  app: INestApplication,
  pool: Pool,
  options: {
    enabled: boolean;
    emit: (
      snapshot: ReturnType<typeof boundedScalableProfileCiSnapshot>,
    ) => void;
  },
  operation: () => Promise<T>,
): Promise<T> {
  if (!options.enabled) return operation();
  const config = app.get<RuntimeConfig>(APP_CONFIG);
  assert.equal(config.NODE_ENV, 'test');
  // The enclosing fixture already enforces loopback and the disposable DB.
  // Do not inspect its connection string or credentials in the observer.
  const database = app.get(DatabaseService);
  const originalTransaction = database.transaction;
  const recent = ring<Entry>(128),
    failures = ring<Entry>(16);
  const samples = ring<Sample>(16);
  const active = new Map<number, { backendPid: number | null; phase: Phase }>();
  const restorers = new Set<() => void>();
  const observer: Snapshot['observer'] = {
    available: false,
    error: null,
    samples: 0,
    sampleLimitReached: false,
    windowExpired: false,
    unknownBackendPid: false,
    readerLimitReached: false,
    blockerEvidence: 'unknown',
    restorationObserved: false,
  };
  let connection: PoolClient | undefined;
  let nextTransaction = 0;
  let stopped = false;
  let samplingUntil = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let pending: Promise<void> | null = null;
  const currentPhase = (): Phase | 'before-request' =>
    [...active.values()].at(-1)?.phase ?? 'before-request';
  const sample = () => {
    if (stopped || pending || !connection || !observer.available) return;
    if (observer.samples >= MAX_SAMPLES) {
      observer.sampleLimitReached = true;
      if (timer) clearInterval(timer);
      return;
    }
    if (samplingUntil && performance.now() >= samplingUntil) {
      observer.windowExpired = true;
      if (timer) clearInterval(timer);
      return;
    }
    const readers = [
      ...new Set(
        [...active.values()]
          .map((value) => value.backendPid)
          .filter((value): value is number => value !== null),
      ),
    ];
    observer.readerLimitReached ||= readers.length > MAX_READERS;
    const phaseAtStart = currentPhase(),
      started = performance.now();
    observer.samples++;
    // Fire-and-observe: never awaited by tx.query, a proof or its callback.
    pending = connection
      .query<Record<string, unknown>>(lockSnapshotSql, [
        readers.slice(0, MAX_READERS),
      ])
      .then(
        (result) => {
          const locks = result.rows
            .slice(0, MAX_LOCK_ROWS)
            .map(scalableProfileCiSafeLock);
          if (locks.some((lock) => lock.blockingPids.length))
            observer.blockerEvidence = 'sampled';
          samples.push({
            phaseAtStart,
            phaseAtEnd: currentPhase(),
            elapsedMs: elapsed(started),
            outcome: 'ok',
            error: null,
            truncated:
              result.rows.length > MAX_LOCK_ROWS ||
              result.rows.some((row) => row['blockers_truncated'] === true),
            locks,
          });
        },
        (error: unknown) => {
          samples.push({
            phaseAtStart,
            phaseAtEnd: currentPhase(),
            elapsedMs: elapsed(started),
            outcome: 'error',
            error: scalableProfileCiSafeError(error),
            truncated: false,
            locks: [],
          });
        },
      )
      .finally(() => {
        pending = null;
      });
  };
  const startFinalSampling = () => {
    if (timer || stopped) return;
    samplingUntil = performance.now() + SAMPLE_WINDOW_MS;
    sample();
    timer = setInterval(sample, SAMPLE_INTERVAL_MS);
  };
  const record = (entry: Entry) => {
    recent.push(entry);
    if (entry.outcome === 'error') failures.push(entry);
  };
  try {
    // Separate connection, opened before the request and always destroyed after
    // the window. These limits apply ONLY to observer metadata queries.
    connection = await pool.connect();
    connection.on('error', (error) => {
      observer.available = false;
      observer.error = scalableProfileCiSafeError(error);
    });
    const guard = await connection.query<{ disposable: boolean }>(
      "SELECT current_database()='whaleu_test' AS disposable",
    );
    assert.equal(guard.rows[0]?.disposable, true);
    await connection.query(
      "SET statement_timeout='25ms'; SET lock_timeout='1ms'",
    );
    observer.available = true;
    // No application backend exists yet: this baseline has no reader targets.
    // An empty baseline never establishes absence of a blocker.
    sample();
    await pending;
  } catch (error) {
    observer.error = scalableProfileCiSafeError(error);
    observer.available = false;
  }
  database.transaction = async function <R>(
    operation: (tx: PoolClient) => Promise<R>,
    transactionOptions: TransactionOptions = {},
  ): Promise<R> {
    const transaction = ++nextTransaction,
      started = performance.now();
    const trace = {
      backendPid: null as number | null,
      phase: 'first-profile' as Phase,
    };
    const state: PhaseState = {
      final: false,
      safety: false,
      optionalCount: false,
      optionalFinal: false,
    };
    let lastSuccessfulPhase: Phase | null = null;
    active.set(transaction, trace);
    try {
      const result = (await originalTransaction.call(
        database,
        async (tx) => {
          // pg exposes the BackendKeyData PID on the client. Missing/invalid is
          // explicitly unknown; do not query for the PID inside the proof.
          trace.backendPid = pid(
            (tx as PoolClient & { processID?: unknown }).processID,
          );
          observer.unknownBackendPid ||= trace.backendPid === null;
          const query = tx.query,
            boundQuery = tx.query.bind(tx),
            release = tx.release;
          const restore = () => {
            tx.query = query;
            tx.release = release;
            restorers.delete(restore);
          };
          restorers.add(restore);
          tx.release = (error) => {
            restore();
            release.call(tx, error);
          };
          sample(); // Initial reader snapshot, concurrent with ordinary work.
          tx.query = (async (sql: string, values?: unknown[]) => {
            const phase = scalableProfileCiPhase(sql, state);
            trace.phase = phase;
            if (phase === 'constraints') startFinalSampling();
            if (
              phase === 'optional-final-proof' &&
              lastSuccessfulPhase === 'safety-settings'
            )
              observer.restorationObserved = true;
            const queryStarted = performance.now();
            let result;
            try {
              result = await boundQuery(sql, values);
            } catch (error) {
              // Capture the PostgreSQL SQLSTATE before the Safety owner maps it.
              record({
                transaction,
                backendPid: trace.backendPid,
                phase,
                boundary: 'query',
                elapsedMs: elapsed(queryStarted),
                outcome: 'error',
                error: scalableProfileCiSafeError(error),
                settings: null,
              });
              throw error;
            }
            let settings: Entry['settings'] = null;
            if (phase === 'safety-settings' && !Array.isArray(result)) {
              const row = result.rows[0] as Record<string, unknown> | undefined;
              if (row && Object.hasOwn(row, 'statement_timeout')) {
                settings = {
                  source: 'existing-settings-read',
                  statementMs: scalableProfileCiTimeoutMs(
                    row['statement_timeout'],
                  ),
                  lockMs: scalableProfileCiTimeoutMs(row['lock_timeout']),
                };
              } else if (row && Object.hasOwn(row, 'set_config')) {
                // Both expressions have the same column name; pg retains only
                // the last (lock_timeout). Statement timeout stays unknown.
                settings = {
                  source: 'existing-set-config-result',
                  statementMs: null,
                  lockMs: scalableProfileCiTimeoutMs(row['set_config']),
                };
              }
            }
            record({
              transaction,
              backendPid: trace.backendPid,
              phase,
              boundary: 'query',
              elapsedMs: elapsed(queryStarted),
              outcome: 'ok',
              error: null,
              settings,
            });
            lastSuccessfulPhase = phase;
            return result;
          }) as typeof tx.query;
          return operation(tx);
        },
        transactionOptions,
      )) as R;
      record({
        transaction,
        backendPid: trace.backendPid,
        phase: 'commit',
        boundary: 'transaction',
        elapsedMs: elapsed(started),
        outcome: 'ok',
        error: null,
        settings: null,
      });
      return result;
    } catch (error) {
      record({
        transaction,
        backendPid: trace.backendPid,
        phase: trace.phase,
        boundary: 'transaction',
        elapsedMs: elapsed(started),
        outcome: 'error',
        error: scalableProfileCiSafeError(error),
        settings: null,
      });
      throw error;
    } finally {
      active.delete(transaction);
    }
  };
  const started = performance.now();
  let requestError: SafeError | null = null;
  try {
    return await operation();
  } catch (error) {
    requestError = scalableProfileCiSafeError(error);
    throw error;
  } finally {
    const requestElapsed = elapsed(started);
    stopped = true;
    if (timer) clearInterval(timer);
    database.transaction = originalTransaction;
    for (const restore of restorers) restore();
    // Await ONLY after the HTTP/native request has completed, never in proof.
    await pending;
    connection?.release(true);
    options.emit(
      boundedScalableProfileCiSnapshot(
        {
          transactions: nextTransaction,
          request: {
            outcome: requestError ? 'error' : 'ok',
            elapsedMs: requestElapsed,
            error: requestError,
          },
          observer,
          recent: recent.read(),
          failures: failures.read(),
          samples: samples.read(),
        },
        {
          recent: recent.dropped(),
          failures: failures.dropped(),
          samples: samples.dropped(),
        },
      ),
    );
  }
}
