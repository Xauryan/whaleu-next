/** Synthetic-fixture-only observation. Never stores SQL, values, rows or error text. */
import assert, { AssertionError } from 'node:assert/strict';
import type { INestApplication } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { APP_CONFIG } from '../../src/config/config.js';
import type { RuntimeConfig } from '../../src/config/config.js';
import { DatabaseService } from '../../src/database/database.js';
import type { TransactionOptions } from '../../src/database/database.js';
import { ApplicationError } from '../../src/http/application-error.js';

export type RatingsCiStage =
  | 'operation'
  | 'review-epoch-capture'
  | 'review-fence'
  | 'proof-settings'
  | 'target-lock'
  | 'root-read'
  | 'reply-read'
  | 'notification-owner'
  | 'constraints'
  | 'final-proof'
  | 'commit'
  | 'rollback';
type AttemptKind = 'random-context' | 'score-context' | 'score-write';
type Fixture = 'ratings-updates' | 'ratings-scoped-random-scale';
type QueryEvent = {
  // SQL is available transiently for existing test barriers, never in diagnostics.
  sql: string;
  transaction: number;
  stage: RatingsCiStage;
  lock: 'share' | 'update' | null;
  rootDeleted: boolean | null;
};
type QueryHook = ((event: QueryEvent, tx: PoolClient) => Promise<void>) | null;
type SafeError = {
  sqlstate: string | null;
  exception:
    | 'ApplicationError'
    | 'AssertionError'
    | 'PostgresError'
    | 'TypeError'
    | 'RangeError'
    | 'Error'
    | 'unknown';
  applicationCode: string | null;
};
type Entry = {
  transaction: number;
  attempt: number | null;
  stage: RatingsCiStage;
  boundary: 'query' | 'before-hook' | 'after-hook' | 'transaction';
  elapsedMs: number;
  outcome: 'ok' | 'error';
} & Partial<SafeError>;
const applicationCodes = new Set([
  'CONTENT_REVIEW_UNAVAILABLE',
  'RATING_SCOPE_UNAVAILABLE',
  'RATING_SCOPED_CONTEXT_CHANGED',
  'RATING_UNAVAILABLE',
  'COMMUNITY_UNAVAILABLE',
  'SAFETY_UNAVAILABLE',
]);
export function ratingsCiSafeError(error: unknown): SafeError {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? error.code
      : null;
  const sqlstate =
    typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : null;
  return {
    sqlstate,
    exception:
      error instanceof ApplicationError
        ? 'ApplicationError'
        : error instanceof AssertionError
          ? 'AssertionError'
          : sqlstate !== null
            ? 'PostgresError'
            : error instanceof TypeError
              ? 'TypeError'
              : error instanceof RangeError
                ? 'RangeError'
                : error instanceof Error
                  ? 'Error'
                  : 'unknown',
    applicationCode:
      error instanceof ApplicationError
        ? applicationCodes.has(error.code)
          ? error.code
          : 'other-application-error'
        : null,
  };
}
function stageOf(sql: string, final: boolean): RatingsCiStage {
  if (sql === 'SET CONSTRAINTS ALL IMMEDIATE') return 'constraints';
  if (sql === 'COMMIT') return 'commit';
  if (sql === 'ROLLBACK') return 'rollback';
  if (
    sql.startsWith('LOCK TABLE ') &&
    sql.includes('whaleu_community.rating_review_epoch')
  )
    return 'review-fence';
  if (
    sql.startsWith('SELECT ') &&
    sql.includes('FROM whaleu_community.rating_review_epoch')
  )
    return 'review-epoch-capture';
  if (
    sql.includes("current_setting('statement_timeout')") ||
    sql.includes("set_config('statement_timeout'")
  )
    return 'proof-settings';
  if (sql.includes('FOR SHARE') || sql.includes('FOR UPDATE')) {
    if (sql.includes('FROM whaleu_ratings.targets')) return 'target-lock';
    if (sql.includes('FROM whaleu_ratings.comments')) return 'root-read';
    if (sql.includes('FROM whaleu_ratings.replies')) return 'reply-read';
    if (sql.startsWith('SELECT account_id FROM whaleu_notifications.owners'))
      return 'notification-owner';
  }
  return final ? 'final-proof' : 'operation';
}
function roundedElapsed(started: number) {
  return Math.round((performance.now() - started) * 1000) / 1000;
}
function ring<T>(capacity: number) {
  const values: T[] = [];
  let next = 0,
    dropped = 0;
  return {
    push(value: T) {
      if (values.length < capacity) values.push(value);
      else {
        dropped++;
        values[next] = value;
        next = (next + 1) % capacity;
      }
    },
    read: () => [...values.slice(next), ...values.slice(0, next)],
    dropped: () => dropped,
  };
}

export const RATINGS_CI_DIAGNOSTICS_MAX_BYTES = 32 * 1024;
type HttpAttempt = {
  attempt: number;
  kind: AttemptKind;
  status: number | null;
  requestId: string | null;
  elapsedMs: number;
  error: SafeError | null;
};
type Snapshot = {
  fixture: Fixture;
  enabled: boolean;
  transactions: number;
  attempts: HttpAttempt[];
  aggregate: Record<string, { count: number; maximumMs: number }>;
  recent: Entry[];
  failures: { error: Entry; recent: Entry[] }[];
};

/** Called only after requests finish, never inside query/proof execution.
 * Cap the entire UTF-8 JSON payload, including its truncation metadata. Keep
 * error summaries longer than context, and never mutate the live rings. */
export function boundedRatingsCiSnapshot(
  snapshot: Snapshot,
  ringDrops = { recent: 0, attempts: 0, failures: 0 },
) {
  const result = {
    serializedByteLimit: RATINGS_CI_DIAGNOSTICS_MAX_BYTES,
    truncated: Object.values(ringDrops).some((count) => count > 0),
    dropped: { ...ringDrops, failureContext: 0, aggregate: 0 },
    fixture: snapshot.fixture,
    enabled: snapshot.enabled,
    transactions: snapshot.transactions,
    attempts: [...snapshot.attempts],
    aggregate: { ...snapshot.aggregate },
    recent: [...snapshot.recent],
    failures: snapshot.failures.map(({ error, recent }) => ({
      error,
      recent: [...recent],
    })),
  };
  const aggregateKeys = Object.keys(result.aggregate);
  while (
    Buffer.byteLength(JSON.stringify(result), 'utf8') >
    RATINGS_CI_DIAGNOSTICS_MAX_BYTES
  ) {
    result.truncated = true;
    const oldestContext = result.failures.find(({ recent }) => recent.length);
    if (oldestContext) {
      result.dropped.failureContext += oldestContext.recent.length;
      oldestContext.recent = [];
    } else if (result.recent.length) {
      result.dropped.recent += result.recent.splice(0, 16).length;
    } else if (result.attempts.length) {
      result.attempts.shift();
      result.dropped.attempts++;
    } else if (result.failures.length) {
      result.failures.shift();
      result.dropped.failures++;
    } else {
      const key = aggregateKeys.shift();
      // The remaining fixed metadata is less than 1 KiB. This branch can only
      // be reached while aggregate entries remain to be removed.
      if (key === undefined) break;
      delete result.aggregate[key];
      result.dropped.aggregate++;
    }
  }
  return result;
}

export function observeRatingsCiQueries(
  app: INestApplication,
  options: { syntheticFixture: Fixture; enabled?: boolean },
) {
  assert.equal(app.get<RuntimeConfig>(APP_CONFIG).NODE_ENV, 'test');
  const enabled = options.enabled === true;
  const database = app.get(DatabaseService);
  const originalTransaction = database.transaction;
  const recent = ring<Entry>(128);
  const failures = ring<{ error: Entry; recent: Entry[] }>(16);
  const http = ring<HttpAttempt>(32);
  const counts = new Map<string, { count: number; maximumMs: number }>();
  let nextTransaction = 0,
    nextAttempt = 0,
    activeAttempt: number | null = null,
    hook: QueryHook = null,
    beforeHook: QueryHook = null;
  const record = (entry: Entry) => {
    if (!enabled) return;
    recent.push(entry);
    const key = `${entry.stage}:${entry.boundary}:${entry.outcome}`;
    const current = counts.get(key) ?? { count: 0, maximumMs: 0 };
    current.count++;
    current.maximumMs = Math.max(current.maximumMs, entry.elapsedMs);
    counts.set(key, current);
    if (entry.outcome === 'error')
      failures.push({
        error: entry,
        recent: recent
          .read()
          .filter((item) => item.transaction === entry.transaction),
      });
  };
  database.transaction = async function <T>(
    operation: (tx: PoolClient) => Promise<T>,
    transactionOptions: TransactionOptions = {},
  ): Promise<T> {
    if (!enabled && !hook && !beforeHook)
      return originalTransaction.call(
        database,
        operation,
        transactionOptions,
      ) as Promise<T>;
    const transaction = ++nextTransaction,
      attempt = activeAttempt,
      started = performance.now();
    let phase: RatingsCiStage = 'operation';
    try {
      const result = (await originalTransaction.call(
        database,
        async (tx) => {
          const query = tx.query,
            boundQuery = tx.query.bind(tx),
            release = tx.release;
          // Restore before returning a pooled client, not after another transaction
          // could borrow it. Traces are local transaction numbers, never client IDs.
          tx.release = (error) => {
            tx.query = query;
            tx.release = release;
            release.call(tx, error);
          };
          tx.query = (async (sql: string, values?: unknown[]) => {
            const stage = stageOf(sql, phase !== 'operation');
            if (stage === 'constraints' || stage === 'commit') phase = stage;
            const event: QueryEvent = {
              sql,
              transaction,
              stage,
              lock: sql.includes('FOR SHARE')
                ? 'share'
                : sql.includes('FOR UPDATE')
                  ? 'update'
                  : null,
              rootDeleted: null,
            };
            const runHook = async (
              value: QueryHook,
              boundary: 'before-hook' | 'after-hook',
            ) => {
              if (!value) return;
              const hookStarted = performance.now();
              try {
                await value(event, tx);
              } catch (error) {
                record({
                  transaction,
                  attempt,
                  stage,
                  boundary,
                  elapsedMs: roundedElapsed(hookStarted),
                  outcome: 'error',
                  ...ratingsCiSafeError(error),
                });
                throw error;
              }
            };
            await runHook(beforeHook, 'before-hook');
            const queryStarted = performance.now();
            let result;
            try {
              result = await boundQuery(sql, values);
            } catch (error) {
              // This executes inside boundedOwnerProof's query, before it maps a
              // PostgreSQL exception to the public owner-unavailable condition.
              record({
                transaction,
                attempt,
                stage,
                boundary: 'query',
                elapsedMs: roundedElapsed(queryStarted),
                outcome: 'error',
                ...ratingsCiSafeError(error),
              });
              throw error;
            }
            record({
              transaction,
              attempt,
              stage,
              boundary: 'query',
              elapsedMs: roundedElapsed(queryStarted),
              outcome: 'ok',
            });
            if (stage === 'root-read' && !Array.isArray(result)) {
              const row = result.rows[0] as
                { deleted_at?: unknown } | undefined;
              if (row && Object.hasOwn(row, 'deleted_at'))
                event.rootDeleted = row.deleted_at !== null;
            }
            await runHook(hook, 'after-hook');
            if (stage === 'constraints') phase = 'final-proof';
            return result;
          }) as typeof tx.query;
          const result = await operation(tx);
          // Also captures a JS final-proof rejection without a failing SQL query.
          phase = 'final-proof';
          return result;
        },
        transactionOptions,
      )) as T;
      record({
        transaction,
        attempt,
        stage: 'commit',
        boundary: 'transaction',
        elapsedMs: roundedElapsed(started),
        outcome: 'ok',
      });
      return result;
    } catch (error) {
      record({
        transaction,
        attempt,
        stage: phase,
        boundary: 'transaction',
        elapsedMs: roundedElapsed(started),
        outcome: 'error',
        ...ratingsCiSafeError(error),
      });
      throw error;
    }
  };
  return {
    enabled,
    setHook(value: QueryHook) {
      hook = value;
    },
    setBeforeHook(value: QueryHook) {
      beforeHook = value;
    },
    async attempt<T>(
      kind: AttemptKind,
      operation: () => PromiseLike<T>,
    ): Promise<T> {
      if (!enabled) return operation();
      const attempt = ++nextAttempt,
        started = performance.now();
      // HTTP server async resources do not inherit an outgoing request's ALS.
      // These synthetic attempts are explicitly serial, so a bounded request
      // window associates all of its server transactions with the returned ID.
      assert.equal(
        activeAttempt,
        null,
        'Synthetic diagnostic attempts must not overlap',
      );
      activeAttempt = attempt;
      let status: number | null = null,
        requestId: string | null = null,
        error: SafeError | null = null;
      try {
        const result = await operation();
        if (typeof result === 'object' && result !== null) {
          if ('status' in result && typeof result.status === 'number')
            status = result.status;
          if (
            'headers' in result &&
            typeof result.headers === 'object' &&
            result.headers !== null
          ) {
            const headers = result.headers as Record<string, unknown>;
            const id = headers['x-request-id'];
            if (
              typeof id === 'string' &&
              /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
                id,
              )
            )
              requestId = id;
          }
        }
        return result;
      } catch (caught) {
        error = ratingsCiSafeError(caught);
        throw caught;
      } finally {
        http.push({
          attempt,
          kind,
          status,
          requestId,
          elapsedMs: roundedElapsed(started),
          error,
        });
        activeAttempt = null;
      }
    },
    snapshot() {
      return boundedRatingsCiSnapshot(
        {
          fixture: options.syntheticFixture,
          enabled,
          transactions: nextTransaction,
          attempts: http.read(),
          aggregate: Object.fromEntries(counts),
          recent: recent.read(),
          failures: failures.read(),
        },
        {
          recent: recent.dropped(),
          attempts: http.dropped(),
          failures: failures.dropped(),
        },
      );
    },
    restore() {
      hook = null;
      beforeHook = null;
      database.transaction = originalTransaction;
    },
  };
}
