import type { PoolClient } from 'pg';
import { transactionReadEpoch } from '../../database/transaction-deadlines.js';
import { ApplicationError } from '../../http/application-error.js';

/** Explicit, lazy owner reads for one search callback only. No client-global
 * cache, mutation, savepoint recovery, optional proof or Safety decision reuse.
 * Each owner keeps its namespace private and supplies its own locked read. */
export class SearchReadContext {
  private readonly epoch: object;
  private readonly values = new Map<object, Map<string, unknown>>();
  private closed = false;
  constructor(private readonly tx: PoolClient) {
    const epoch = transactionReadEpoch(tx);
    if (!epoch) throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    this.epoch = epoch;
  }
  /** Synchronous seal after the last application work, before returning data. */
  assertCurrent(tx: PoolClient): void {
    if (
      this.closed ||
      tx !== this.tx ||
      transactionReadEpoch(tx) !== this.epoch
    )
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
  }
  async read<T>(
    owner: object,
    key: string,
    tx: PoolClient,
    load: () => Promise<T>,
    retain: (value: T) => boolean,
  ): Promise<T> {
    this.assertCurrent(tx);
    const entries = this.values.get(owner);
    if (entries?.has(key)) return entries.get(key) as T;
    const value = await load();
    this.assertCurrent(tx);
    if (retain(value)) {
      const destination = this.values.get(owner) ?? new Map<string, unknown>();
      destination.set(key, value);
      this.values.set(owner, destination);
    }
    return value;
  }
  close(): void {
    this.closed = true;
    this.values.clear();
  }
}
