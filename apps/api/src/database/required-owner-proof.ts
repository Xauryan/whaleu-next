import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import type { ApplicationErrorCode } from '../http/application-error.js';
import type { CountEpochRow, CountProofOwner } from './count-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
} from './transaction-deadlines.js';
import type { RequiredTransactionProof } from './transaction-deadlines.js';
/** Mandatory owner fences intentionally fail closed on unrelated conflicting
 * writers too. They never turn authority uncertainty into a missing display field. */
export async function boundedOwnerProof(
  tx: PoolClient,
  code: ApplicationErrorCode,
  run: (read: PoolClient) => Promise<void>,
): Promise<void> {
  const expires = performance.now() + 500;
  const settings = (
    await tx.query<{
      isolation: string;
      statement_timeout: string;
      lock_timeout: string;
    }>(
      `SELECT current_setting('transaction_isolation') isolation,current_setting('statement_timeout') statement_timeout,current_setting('lock_timeout') lock_timeout`,
    )
  ).rows[0];
  if (!settings || settings.isolation !== 'read committed')
    throw new ApplicationError(code);
  const milliseconds = (value: string) => {
    const match = /^(\d+(?:\.\d+)?)\s*(ms|s|min|h|d)?$/.exec(value);
    const units: Record<string, number> = {
      ms: 1,
      s: 1000,
      min: 60000,
      h: 3600000,
      d: 86400000,
    };
    if (!match) throw new ApplicationError(code);
    const n = Number(match[1]) * units[match[2] ?? 'ms']!;
    if (!Number.isFinite(n)) throw new ApplicationError(code);
    return n;
  };
  const timeout = milliseconds(settings.statement_timeout),
    lockTimeout = milliseconds(settings.lock_timeout);
  const read = new Proxy(tx, {
    get(target, property, receiver) {
      if (property !== 'query') return Reflect.get(target, property, receiver);
      return async (sql: string, values?: unknown[]) => {
        const remaining = Math.floor(expires - performance.now());
        if (remaining <= 0) throw new ApplicationError(code);
        await target.query(
          `SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$2,true)`,
          [
            `${Math.min(100, remaining, timeout || 100)}ms`,
            `${Math.min(1, lockTimeout || 1)}ms`,
          ],
        );
        return target.query(sql, values);
      };
    },
  });
  try {
    await run(read);
    if (performance.now() >= expires) throw new ApplicationError(code);
    await tx.query(
      `SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$2,true)`,
      [settings.statement_timeout, settings.lock_timeout],
    );
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    throw new ApplicationError(code);
  }
}
export function ownerFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function epochFingerprint(
  rows: readonly CountEpochRow[],
  code: ApplicationErrorCode,
) {
  if (
    rows.length !== 128 ||
    rows.some(
      (r, i) =>
        r.slot !== i ||
        r.version !== 1 ||
        !/^(0|[1-9][0-9]*)$/.test(r.epoch) ||
        BigInt(r.epoch) > 9223372036854775807n,
    )
  )
    throw new ApplicationError(code);
  return ownerFingerprint(rows);
}
/** Independent required owner, never a fourth optional CountProofCollector owner. */
export function requiredOwnerEpoch(
  owner: CountProofOwner,
  code: ApplicationErrorCode,
) {
  const proof: RequiredTransactionProof<string> = {
    maximumFacts: 256,
    failureCode: code,
    validate: (facts, tx) =>
      boundedOwnerProof(tx, code, async (read) => {
        if (!(await owner.fence(read))) throw new ApplicationError(code);
        const current = epochFingerprint(await owner.capture(read), code);
        if (facts.some((f) => f !== current)) throw new ApplicationError(code);
      }),
  };
  return async (tx: PoolClient): Promise<string> => {
    enableRequiredTransactionProof(tx, proof);
    const settings = (
      await tx.query<{ isolation: string; capacity: number }>(
        `SELECT current_setting('transaction_isolation') isolation,current_setting('max_connections')::integer+current_setting('max_prepared_transactions')::integer+current_setting('max_worker_processes')::integer+current_setting('max_wal_senders')::integer capacity`,
      )
    ).rows[0];
    if (
      !settings ||
      settings.isolation !== 'read committed' ||
      !Number.isInteger(settings.capacity) ||
      settings.capacity < 1 ||
      settings.capacity >= 128
    )
      throw new ApplicationError(code);
    const fingerprint = epochFingerprint(await owner.capture(tx), code);
    registerRequiredTransactionFact(tx, proof, fingerprint, fingerprint);
    return fingerprint;
  };
}
