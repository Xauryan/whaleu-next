import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import type { ApplicationErrorCode } from '../http/application-error.js';
/** Internal owner facts only. A deadline is registered only while its canonical
 * source is locked. The transaction wrapper checks after ALL deferred waits. */
const deadlines = new WeakMap<PoolClient, Map<ApplicationErrorCode, number>>();
const exactDeadlines = new WeakMap<
  PoolClient,
  { until: string; code: ApplicationErrorCode }[]
>();
const readEpochs = new WeakMap<PoolClient, object>();
// Stable only for one transaction; unlike read epochs, optional rollback must
// not reset shared work budgets. Never use this token as an authority proof.
const lifetimes = new WeakMap<PoolClient, object>();
export function transactionLifetime(tx: PoolClient): object | undefined {
  return lifetimes.get(tx);
}
const optionalDeadlines = new WeakMap<
  PoolClient,
  { until: number; expire: () => void }[]
>();
export interface OptionalTransactionProof {
  /** Must use only nonblocking fences and nonlocking, bounded version reads. */
  validate: () => Promise<boolean>;
  /** Mutates only the private result that has not left the transaction. */
  invalidate: () => void;
  until?: number | null;
}
const optionalProofs = new WeakMap<PoolClient, OptionalTransactionProof[]>();

/** An owner opts a managed read or tentative mutation into one bounded,
 * set-oriented mandatory proof. A failed proof rolls back all tentative writes.
 * Facts are append-only and immutable; rollback prunes facts and their dedupe
 * keys together. Owner validators may fence NOWAIT and read, never mutate data. */
export interface RequiredTransactionProof<T> {
  maximumFacts: number;
  failureCode: ApplicationErrorCode;
  validate(facts: readonly T[], tx: PoolClient): Promise<void>;
}
interface RequiredProofEntry {
  facts: unknown[];
  keys: string[];
  seen: Set<string>;
  validate: (facts: readonly unknown[], tx: PoolClient) => Promise<void>;
}
const requiredProofs = new WeakMap<
  PoolClient,
  Map<object, RequiredProofEntry>
>();

export function enableRequiredTransactionProof<T>(
  tx: PoolClient,
  owner: RequiredTransactionProof<T>,
): void {
  const registry = requiredProofs.get(tx);
  if (!registry) throw new ApplicationError(owner.failureCode);
  if (registry.has(owner)) return;
  if (!Number.isSafeInteger(owner.maximumFacts) || owner.maximumFacts < 1)
    throw new ApplicationError(owner.failureCode);
  registry.set(owner, {
    facts: [],
    keys: [],
    seen: new Set(),
    validate: (facts, client) => owner.validate(facts as readonly T[], client),
  });
}

export function registerRequiredTransactionFact<T>(
  tx: PoolClient,
  owner: RequiredTransactionProof<T>,
  key: string,
  fact: T,
): void {
  const entry = requiredProofs.get(tx)?.get(owner);
  if (!entry || entry.seen.has(key)) return;
  if (entry.facts.length >= owner.maximumFacts)
    throw new ApplicationError(owner.failureCode);
  entry.seen.add(key);
  entry.keys.push(key);
  entry.facts.push(fact);
}

/** Opaque read lifetime. A new transaction or restored checkpoint invalidates
 * explicit owner read contexts; no registry or mutable deadline is exposed. */
export function transactionReadEpoch(tx: PoolClient): object | undefined {
  return readEpochs.get(tx);
}

export function hasTransactionDeadlines(tx: PoolClient): boolean {
  return deadlines.has(tx);
}

export function startTransactionDeadlines(tx: PoolClient) {
  lifetimes.set(tx, Object.freeze({}));
  deadlines.set(tx, new Map());
  exactDeadlines.set(tx, []);
  readEpochs.set(tx, Object.freeze({}));
  optionalDeadlines.set(tx, []);
  optionalProofs.set(tx, []);
  requiredProofs.set(tx, new Map());
}
export function clearTransactionDeadlines(tx: PoolClient) {
  lifetimes.delete(tx);
  deadlines.delete(tx);
  exactDeadlines.delete(tx);
  readEpochs.delete(tx);
  optionalDeadlines.delete(tx);
  optionalProofs.delete(tx);
  requiredProofs.delete(tx);
}
export function registerTransactionDeadline(
  tx: PoolClient,
  until: number | null,
  code: ApplicationErrorCode,
) {
  if (until === null) return;
  if (!Number.isFinite(until)) throw new ApplicationError(code);
  const current = deadlines.get(tx);
  if (!current) return; // Standalone owner reads still perform their own current-clock check.
  current.set(
    code,
    Math.min(current.get(code) ?? Number.POSITIVE_INFINITY, until),
  );
}
/** PostgreSQL-owned timestamp text retains sub-millisecond authority. No Date
 * conversion is used, and the final instant is sampled after every owner proof. */
export function registerTransactionExactDeadline(
  tx: PoolClient,
  until: string | null,
  code: ApplicationErrorCode,
) {
  if (until === null) return;
  const registry = exactDeadlines.get(tx);
  if (
    !registry ||
    typeof until !== 'string' ||
    until.length < 10 ||
    until.length > 80 ||
    registry.length >= 128
  )
    throw new ApplicationError(code);
  if (!registry.some((f) => f.until === until && f.code === code))
    registry.push({ until, code });
}
/** Conservative transport expiry for literal private previews. This does not
 * authorize a cache or replace final proof checking; sub-millisecond SQL facts
 * are rounded down so a client never receives a later expiry than an owner. */
export function transactionResultExpiry(
  tx: PoolClient,
  ceiling: number,
): number {
  const values = [ceiling, ...(deadlines.get(tx)?.values() ?? [])];
  for (const fact of exactDeadlines.get(tx) ?? [])
    values.push(Date.parse(fact.until));
  const result = Math.floor(Math.min(...values));
  if (!Number.isSafeInteger(result) || result < 0)
    throw new Error('Invalid private result expiry');
  return result;
}
export async function checkTransactionDeadlines(tx: PoolClient) {
  const current = deadlines.get(tx);
  const exact = exactDeadlines.get(tx) ?? [];
  const optional = optionalDeadlines.get(tx) ?? [];
  const proofs = optionalProofs.get(tx) ?? [];
  const required = [...(requiredProofs.get(tx)?.values() ?? [])].filter(
    (entry) => entry.facts.length > 0,
  );
  if (
    !current?.size &&
    !exact.length &&
    !optional.length &&
    !proofs.length &&
    !required.length
  )
    return;
  await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
  // Flush every deferred wait before taking any final fence. No mandatory source
  // read or further constraint wait may follow these nonblocking validations.
  for (const entry of required) await entry.validate(entry.facts, tx);
  const invalid = new Set<OptionalTransactionProof>();
  for (const proof of proofs)
    if (!(await validateOptionalProof(tx, proof))) invalid.add(proof);
  const instant = exact.length
    ? (
        await tx.query<{ now: Date; expired: string[] }>(
          `WITH instant AS MATERIALIZED (SELECT clock_timestamp() now) SELECT now, ARRAY(SELECT ordinal::text FROM unnest($1::timestamptz[]) WITH ORDINALITY d(until,ordinal) WHERE NOT isfinite(until) OR until<=instant.now) expired FROM instant`,
          [exact.map((f) => f.until)],
        )
      ).rows[0]!
    : (
        await tx.query<{ now: Date; expired?: string[] }>(
          'SELECT clock_timestamp() AS now',
        )
      ).rows[0]!;
  for (const ordinal of instant.expired ?? [])
    throw new ApplicationError(exact[Number(ordinal) - 1]!.code);
  const now = instant.now.getTime();
  if (!Number.isFinite(now))
    throw new ApplicationError('COMMUNITY_UNAVAILABLE');
  for (const [code, until] of current ?? [])
    if (until <= now) throw new ApplicationError(code);
  for (const entry of optional) if (entry.until <= now) entry.expire();
  for (const proof of proofs)
    if (invalid.has(proof) || (proof.until != null && proof.until <= now))
      proof.invalidate();
}

const optionalCheckpoints = new WeakMap<
  Map<ApplicationErrorCode, number>,
  {
    deadlines: number;
    exact: number;
    proofs: number;
    required: Map<object, number>;
  }
>();
export function checkpointTransactionDeadlines(tx: PoolClient) {
  const snapshot = new Map(deadlines.get(tx));
  optionalCheckpoints.set(snapshot, {
    deadlines: optionalDeadlines.get(tx)?.length ?? 0,
    exact: exactDeadlines.get(tx)?.length ?? 0,
    proofs: optionalProofs.get(tx)?.length ?? 0,
    required: new Map(
      [...(requiredProofs.get(tx)?.entries() ?? [])].map(([owner, entry]) => [
        owner,
        entry.facts.length,
      ]),
    ),
  });
  return snapshot;
}
export function restoreTransactionDeadlines(
  tx: PoolClient,
  checkpoint: Map<ApplicationErrorCode, number>,
) {
  if (deadlines.has(tx)) {
    deadlines.set(tx, new Map(checkpoint));
    readEpochs.set(tx, Object.freeze({}));
    const size = optionalCheckpoints.get(checkpoint);
    if (size !== undefined) {
      optionalDeadlines.get(tx)?.splice(size.deadlines);
      exactDeadlines.get(tx)?.splice(size.exact);
      optionalProofs.get(tx)?.splice(size.proofs);
      const required = requiredProofs.get(tx);
      for (const [owner, entry] of required ?? []) {
        const length = size.required.get(owner);
        if (length === undefined) required?.delete(owner);
        else {
          for (const key of entry.keys.splice(length)) entry.seen.delete(key);
          entry.facts.splice(length);
        }
      }
    }
  }
}

/** Optional display counts retain their source locks but must not turn their
 * expiry into a failure of separately authorized mandatory profile basics.
 * The callback updates the still-private response before it leaves commit. */
export function registerOptionalTransactionDeadline(
  tx: PoolClient,
  until: number | null,
  expire: () => void,
) {
  if (until === null) return;
  if (!Number.isFinite(until))
    throw new ApplicationError('COMMUNITY_UNAVAILABLE');
  optionalDeadlines.get(tx)?.push({ until, expire });
}

/** Unlocked optional facts are never promoted to required locked deadlines. */
export function registerOptionalTransactionProof(
  tx: PoolClient,
  proof: OptionalTransactionProof,
) {
  if (proof.until != null && !Number.isFinite(proof.until))
    throw new ApplicationError('COMMUNITY_UNAVAILABLE');
  const registry = optionalProofs.get(tx);
  if (!registry) throw new ApplicationError('COMMUNITY_UNAVAILABLE');
  registry.push(proof);
}

const FINAL_PROOF_STATEMENT_MS = 100;
function timeoutMilliseconds(value: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|min|h|d)?$/.exec(value);
  if (!match) throw new ApplicationError('COMMUNITY_UNAVAILABLE');
  const multiplier: Record<string, number> = {
    ms: 1,
    s: 1000,
    min: 60000,
    h: 3600000,
    d: 86400000,
  };
  const milliseconds = Number(match[1]) * (multiplier[match[2] ?? 'ms'] ?? NaN);
  if (!Number.isFinite(milliseconds))
    throw new ApplicationError('COMMUNITY_UNAVAILABLE');
  return milliseconds;
}
function boundedTimeout(value: string, maximum: number): string {
  const current = timeoutMilliseconds(value);
  return `${Math.max(1, Math.min(current || maximum, maximum))}ms`;
}
function optionalProofCancellation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === '55P03' || error.code === '57014')
  );
}
async function validateOptionalProof(
  tx: PoolClient,
  proof: OptionalTransactionProof,
): Promise<boolean> {
  const expires = performance.now() + 600;
  // Even the optional settings read must be recoverable. A failed SAVEPOINT
  // itself is not safely recoverable as an optional display-field failure.
  await tx.query('SAVEPOINT optional_final_count_proof');
  let valid: boolean;
  try {
    const settings = (
      await tx.query<{
        statement_timeout: string;
        lock_timeout: string;
      }>(`SELECT current_setting('statement_timeout') AS statement_timeout,
      current_setting('lock_timeout') AS lock_timeout`)
    ).rows[0];
    if (!settings) throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    await tx.query(
      `SELECT set_config('statement_timeout',$1,true),
      set_config('lock_timeout',$2,true)`,
      [
        boundedTimeout(settings.statement_timeout, FINAL_PROOF_STATEMENT_MS),
        boundedTimeout(settings.lock_timeout, 1),
      ],
    );
    valid = await proof.validate();
    valid = valid && performance.now() < expires;
    if (valid) {
      // Restore while the rollback boundary still owns all newly acquired
      // fences. A count-only cancellation here must not erase valid basics.
      await tx.query(
        `SELECT set_config('statement_timeout',$1,true),
        set_config('lock_timeout',$2,true)`,
        [settings.statement_timeout, settings.lock_timeout],
      );
    }
  } catch (error) {
    // Failed rollback is fatal. Never keep partially acquired final fences or
    // swallow a poisoned connection / arbitrary owner error as an optional count.
    await tx.query('ROLLBACK TO SAVEPOINT optional_final_count_proof');
    await tx.query('RELEASE SAVEPOINT optional_final_count_proof');
    if (optionalProofCancellation(error)) return false;
    throw error;
  }
  if (!valid) {
    await tx.query('ROLLBACK TO SAVEPOINT optional_final_count_proof');
    await tx.query('RELEASE SAVEPOINT optional_final_count_proof');
    return false;
  }
  await tx.query('RELEASE SAVEPOINT optional_final_count_proof');
  return true;
}
