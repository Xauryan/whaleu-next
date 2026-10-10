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
  private imageAware = false;
  private constructor(
    private readonly owners: readonly CapturedOwner[],
    private readonly media: CapturedOwner | null = null,
  ) {}

  /** This is deliberately a separate, fixed profile, not a fourth arbitrary
   * owner admitted by the legacy collector. Capture Media before any candidate
   * read, but select it only after the complete traversal consumes image facts.
   * A missing Media deployment must not erase a proved text-only count. */
  static async captureImageAware(
    tx: PoolClient,
    owners: readonly [
      CountProofOwner,
      CountProofOwner,
      CountProofOwner,
      CountProofOwner,
    ],
    read: PoolClient = tx,
  ): Promise<CountProofCollector | null> {
    const orders = [1464356101, 1464356102, 1464356103, 40];
    if (
      owners.length !== 4 ||
      owners.some((owner, index) => owner.order !== orders[index])
    )
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    const ordinary = await this.capture(tx, owners.slice(0, 3), read);
    // The independent <=1024 fallback takes complete source SHARE fences; it
    // never claims that epoch slots cover unsupported server writer capacity.
    if (!ordinary) return null;
    const owner = owners[3];
    const media = await optionalCountMediaStep(tx, async () => {
      const epochs = await owner.capture(read);
      if (!validEpochs(epochs))
        throw new ApplicationError('COMMUNITY_UNAVAILABLE');
      return { owner, epochs: epochs.map((row) => ({ ...row })) };
    });
    return new CountProofCollector(ordinary.owners, media);
  }

  /** Called only for an actually consumed allow/deny image dependency. */
  requireMedia(): void {
    if (!this.media) throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    this.imageAware = true;
  }

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
    const ordered = [...owners].sort((a, b) => a.order - b.order);
    if (
      !ordered.length ||
      ordered.length > 3 ||
      new Set(ordered.map((owner) => owner.order)).size !== ordered.length
    )
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    if (isolation.writer_capacity >= COUNT_EPOCH_SLOTS) return null;
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
      // Media's mandatory-owner order is 40. This explicit v2 profile instead
      // retains the fixed discovery lock order Community -> Safety -> Campus ->
      // Media, then performs every fresh RC vector read under all four fences.
      const owners = this.imageAware
        ? [...this.owners, this.media!]
        : this.owners;
      for (const { owner } of owners)
        if (!(await owner.fence(read))) return false;
      for (const { owner, epochs } of owners) {
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

/** Recover only the optional Media substep. Rollback/release failure is fatal;
 * mandatory page registrations and locks predate this nested savepoint. */
export async function optionalCountMediaStep<T>(
  tx: PoolClient,
  action: () => Promise<T>,
): Promise<T | null> {
  await tx.query('SAVEPOINT discovery_optional_media');
  let value: T;
  try {
    value = await action();
  } catch (error) {
    await tx.query('ROLLBACK TO SAVEPOINT discovery_optional_media');
    await tx.query('RELEASE SAVEPOINT discovery_optional_media');
    if (
      (error instanceof ApplicationError &&
        ['COMMUNITY_UNAVAILABLE', 'MEDIA_UNAVAILABLE'].includes(error.code)) ||
      (typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        ['55P03', '57014', '53400', '42P01', '42703', '3F000'].includes(
          String(error.code),
        ))
    )
      return null;
    throw error;
  }
  await tx.query('RELEASE SAVEPOINT discovery_optional_media');
  return value;
}
