import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import { hasTransactionDeadlines } from './transaction-deadlines.js';

export const COUNT_EPOCH_SLOTS = 128;
export interface CountEpochRow {
  slot: number;
  version: number;
  epoch: string;
}
/** Opaque owner operations. The coordinator never reads another owner's tables. */
export interface CountProofOwner {
  readonly order: number;
  capture(tx: PoolClient): Promise<readonly CountEpochRow[]>;
  fence(tx: PoolClient): Promise<boolean>;
}
interface CapturedOwner {
  owner: CountProofOwner;
  epochs: readonly CountEpochRow[];
}
function validEpochs(rows: readonly CountEpochRow[]): boolean {
  return (
    rows.length === COUNT_EPOCH_SLOTS &&
    rows.every(
      (row, slot) =>
        row.slot === slot &&
        row.version === 1 &&
        /^(0|[1-9][0-9]*)$/.test(row.epoch) &&
        BigInt(row.epoch) <= 9223372036854775807n,
    )
  );
}

/** Fixed retained metadata, independent of history/author/scope cardinality.
 * Facts remain conditional until registered pre-commit validation succeeds. */
export class CountProofCollector {
  private horizon: number | null = null;
  private constructor(private readonly owners: readonly CapturedOwner[]) {}

  static async capture(
    tx: PoolClient,
    owners: readonly CountProofOwner[],
    read: PoolClient = tx,
  ): Promise<CountProofCollector | null> {
    if (!hasTransactionDeadlines(tx))
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    const isolation = (
      await read.query<{ isolation: string; writer_capacity: number }>(
        `SELECT current_setting('transaction_isolation') AS isolation,
          current_setting('max_connections')::integer +
          current_setting('max_prepared_transactions')::integer +
          current_setting('max_worker_processes')::integer +
          current_setting('max_wal_senders')::integer AS writer_capacity`,
      )
    ).rows[0];
    if (
      isolation?.isolation !== 'read committed' ||
      !Number.isInteger(isolation.writer_capacity) ||
      isolation.writer_capacity < 1
    )
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    if (isolation.writer_capacity >= COUNT_EPOCH_SLOTS) return null;
    const ordered = [...owners].sort((a, b) => a.order - b.order);
    if (
      !ordered.length ||
      ordered.length > 3 ||
      new Set(ordered.map((owner) => owner.order)).size !== ordered.length
    )
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    const captured: CapturedOwner[] = [];
    for (const owner of ordered) {
      const epochs = await owner.capture(read);
      if (!validEpochs(epochs))
        throw new ApplicationError('COMMUNITY_UNAVAILABLE');
      captured.push({ owner, epochs: epochs.map((row) => ({ ...row })) });
    }
    return new CountProofCollector(captured);
  }

  includeUntil(until: number | null): void {
    if (until === null) return;
    if (!Number.isFinite(until))
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    this.horizon = Math.min(this.horizon ?? Infinity, until);
  }
  get until(): number | null {
    return this.horizon;
  }

  /** Called ONLY by registerOptionalTransactionProof, inside its rollbackable
   * final savepoint. Every fence is try-only; all version reads use fresh RC
   * statements AFTER every required owner fence has been acquired. */
  async validate(tx: PoolClient): Promise<boolean> {
    const expires = performance.now() + COUNT_FINAL_PROOF_BUDGET_MS;
    const settings = (
      await tx.query<{ timeout: string }>(
        "SELECT current_setting('statement_timeout') AS timeout",
      )
    ).rows[0]?.timeout;
    if (!settings) throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    const match = /^(\d+(?:\.\d+)?)\s*(ms|s|min|h|d)?$/.exec(settings);
    const units: Record<string, number> = {
      ms: 1,
      s: 1000,
      min: 60000,
      h: 3600000,
      d: 86400000,
    };
    if (!match) throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    const configured = Number(match[1]) * units[match[2] ?? 'ms']!;
    const statementLimit = Math.min(
      configured || COUNT_FINAL_PROOF_BUDGET_MS,
      COUNT_FINAL_PROOF_BUDGET_MS,
    );
    const read = new Proxy(tx, {
      get(target, property, receiver) {
        if (property !== 'query')
          return Reflect.get(target, property, receiver);
        return async (sql: string, values?: unknown[]) => {
          const remaining = Math.floor(expires - performance.now());
          if (remaining <= 0) throw new FinalProofBudgetExpired();
          await target.query("SELECT set_config('statement_timeout',$1,true)", [
            `${Math.min(remaining, statementLimit)}ms`,
          ]);
          if (performance.now() >= expires) throw new FinalProofBudgetExpired();
          return target.query(sql, values);
        };
      },
    });
    try {
      for (const { owner } of this.owners)
        if (!(await owner.fence(read))) return false;
      for (const { owner, epochs } of this.owners) {
        const current = await owner.capture(read);
        if (
          !validEpochs(current) ||
          current.some((row, slot) => row.epoch !== epochs[slot]!.epoch)
        )
          return false;
      }
      return performance.now() < expires;
    } catch (error) {
      if (error instanceof FinalProofBudgetExpired) return false;
      throw error;
    }
  }
}

export const COUNT_FINAL_PROOF_BUDGET_MS = 100;
class FinalProofBudgetExpired extends Error {}
