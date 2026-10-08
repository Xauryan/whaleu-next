import { performance } from 'node:perf_hooks';
import type { PoolClient } from 'pg';
import type { CountProofCollector } from './count-proof.js';
import {
  checkpointTransactionDeadlines,
  restoreTransactionDeadlines,
} from './transaction-deadlines.js';
import { ApplicationError } from '../http/application-error.js';
export const DISCOVERY_COUNT_BATCH = 256;
export const DISCOVERY_COUNT_BUDGET_MS = 2000;
const MAX_CONCURRENT_COUNTS = 2;
const COUNT_SOURCE_STATEMENT_MS = 100;
export const SMALL_COUNT_PROOF_CANDIDATES = 1024;
export const SMALL_COUNT_PROOF_BUDGET_MS = 500;
export interface CountScanResult<T extends number | bigint = number> {
  value: T;
  candidates: number;
}

export type CurrentOptionalCount<T extends number | bigint = number> =
  | {
      status: 'known';
      value: T;
      optionalUntil: number | null;
      /** Internal proof only; never spread this object into a wire DTO. */
      proof?: (() => Promise<boolean>) | undefined;
    }
  | {
      status: 'unavailable';
      value: null;
      optionalUntil: null;
    };
interface TimeoutSettings {
  statement_timeout: string;
  lock_timeout: string;
  work_mem: string;
}

export class OptionalCountUnavailable extends Error {}

const unavailable = <T extends number | bigint>(): CurrentOptionalCount<T> => ({
  status: 'unavailable',
  value: null,
  optionalUntil: null,
});

function optionalFailure(error: unknown): boolean {
  if (error instanceof OptionalCountUnavailable) return true;
  if (error instanceof ApplicationError)
    return error.code === 'COMMUNITY_UNAVAILABLE';
  // These are recoverable only inside this optional operation's savepoint.
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    (error.code === '57014' || error.code === '55P03' || error.code === '53400')
  );
}

export function configuredTimeout(value: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|min|h|d)?$/.exec(value);
  const units: Record<string, number> = {
    ms: 1,
    s: 1000,
    min: 60000,
    h: 3600000,
    d: 86400000,
  };
  const result = match ? Number(match[1]) * units[match[2] ?? 'ms']! : NaN;
  if (!Number.isFinite(result)) throw new OptionalCountUnavailable();
  return result === 0 ? Infinity : result;
}

/** Every source statement gets the remaining monotonic budget, rather than a
 * fresh whole timeout per query/batch. Only snapshot facades receive this client;
 * required policy and finalization keep the original managed client identity. */
export function budgetedClient(
  tx: PoolClient,
  expires: number,
  statementLimit: number,
  lockLimit: number,
): PoolClient {
  let appliedStatement: number | null = null;
  let appliedLock: number | null = null;
  return new Proxy(tx, {
    get(target, property, receiver) {
      if (property !== 'query') return Reflect.get(target, property, receiver);
      return async (text: string, values?: unknown[]) => {
        const remaining = Math.floor(expires - performance.now());
        if (remaining <= 0) throw new OptionalCountUnavailable();
        const statement = Math.min(
          remaining,
          statementLimit,
          COUNT_SOURCE_STATEMENT_MS,
        );
        const lock = Math.min(remaining, lockLimit, 25);
        // A fixed short timeout already below the remaining allowance needs no
        // redundant configuration roundtrip. Tighten it as the total budget ends.
        if (statement !== appliedStatement || lock !== appliedLock) {
          await target.query(
            "SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$2,true)",
            [`${statement}ms`, `${lock}ms`],
          );
          appliedStatement = statement;
          appliedLock = lock;
        }
        if (performance.now() >= expires) throw new OptionalCountUnavailable();
        return target.query(text, values);
      };
    },
  });
}

/** Mechanically shared bounded optional scan admission, savepoint recovery and
 * final-only owner proof. Domain callers supply only scans and owner fences. */
const admissions = new WeakMap<object, { active: number }>();
export class OptionalCountRunner {
  private readonly admission: { active: number };
  private readonly maxConcurrent: number;
  constructor(poolMax: number, scope: object = {}) {
    this.admission = admissions.get(scope) ?? { active: 0 };
    admissions.set(scope, this.admission);
    this.maxConcurrent = Math.min(
      MAX_CONCURRENT_COUNTS,
      Math.max(0, poolMax - 1),
    );
  }
  async attempt<T extends number | bigint>(
    tx: PoolClient,
    scan: (
      read: PoolClient,
      includeUntil: (until: number | null) => void,
      maxCandidates: number,
    ) => Promise<CountScanResult<T>>,
    budgetMs: number,
    capture: (
      tx: PoolClient,
      read: PoolClient,
    ) => Promise<CountProofCollector | null>,
    fence: (read: PoolClient) => Promise<void>,
  ): Promise<CurrentOptionalCount<T>> {
    if (
      this.admission.active >= this.maxConcurrent ||
      !Number.isFinite(budgetMs) ||
      budgetMs <= 0
    )
      return unavailable();
    this.admission.active++;
    const baseline = checkpointTransactionDeadlines(tx);
    const expires = performance.now() + budgetMs;
    let savepoint = false;
    try {
      await tx.query('SAVEPOINT discovery_optional_count');
      savepoint = true;
      const settings = (
        await tx.query<TimeoutSettings>(
          `SELECT current_setting('statement_timeout') AS statement_timeout,
           current_setting('lock_timeout') AS lock_timeout,current_setting('work_mem') AS work_mem`,
        )
      ).rows[0];
      if (!settings) throw new OptionalCountUnavailable();
      const statementLimit = configuredTimeout(settings.statement_timeout);
      const lockLimit = configuredTimeout(settings.lock_timeout);
      await tx.query(
        "SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$2,true),set_config('work_mem',CASE WHEN pg_size_bytes(current_setting('work_mem'))>4194304 THEN '4MB' ELSE current_setting('work_mem') END,true)",
        [
          `${Math.max(1, Math.min(statementLimit, COUNT_SOURCE_STATEMENT_MS, Math.floor(expires - performance.now())))}ms`,
          `${Math.min(lockLimit, 25)}ms`,
        ],
      );
      const read = budgetedClient(tx, expires, statementLimit, lockLimit);
      const proof = await capture(tx, read);
      let optionalUntil: number | null = null;
      const includeUntil = (until: number | null) => {
        if (until === null) return;
        if (!Number.isFinite(until)) throw new OptionalCountUnavailable();
        optionalUntil = Math.min(optionalUntil ?? Infinity, until);
        proof?.includeUntil(until);
      };
      const scanned = await scan(
        read,
        includeUntil,
        proof ? Infinity : SMALL_COUNT_PROOF_CANDIDATES,
      );
      const value = scanned.value;
      if (
        performance.now() >= expires ||
        (typeof value === 'number'
          ? !Number.isSafeInteger(value) || value < 0
          : value < 0n)
      )
        throw new OptionalCountUnavailable();
      await tx.query(
        "SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$2,true),set_config('work_mem',$3,true)",
        [settings.statement_timeout, settings.lock_timeout, settings.work_mem],
      );
      restoreTransactionDeadlines(tx, baseline);
      await tx.query('RELEASE SAVEPOINT discovery_optional_count');
      savepoint = false;
      const count: CurrentOptionalCount<T> = {
        status: 'known',
        value,
        optionalUntil,
        proof: async () => {
          if (proof && (await proof.validate(tx))) return true;
          if (
            scanned.candidates > SMALL_COUNT_PROOF_CANDIDATES ||
            this.admission.active >= this.maxConcurrent
          )
            return false;
          this.admission.active++;
          // Independent bounded proof for the formerly supported small set.
          // Unrelated committed churn does not discard exact small counts. All
          // source fences are final-only/NOWAIT; no locking scalar path follows.
          const finalExpires = performance.now() + SMALL_COUNT_PROOF_BUDGET_MS;
          const finalRead = budgetedClient(tx, finalExpires, 100, 1);
          try {
            await fence(finalRead);
            const current = await scan(
              finalRead,
              (until) => {
                includeUntil(until);
                count.optionalUntil = optionalUntil;
              },
              SMALL_COUNT_PROOF_CANDIDATES,
            );
            return performance.now() < finalExpires && current.value === value;
          } catch (error) {
            if (optionalFailure(error)) return false;
            throw error;
          } finally {
            this.admission.active--;
          }
        },
      };
      return count;
    } catch (error) {
      if (!optionalFailure(error)) throw error;
      if (savepoint) {
        // A failed rollback/release must escape and fail the whole transaction.
        await tx.query('ROLLBACK TO SAVEPOINT discovery_optional_count');
        await tx.query('RELEASE SAVEPOINT discovery_optional_count');
        restoreTransactionDeadlines(tx, baseline);
      }
      return unavailable();
    } finally {
      this.admission.active--;
    }
  }
}
