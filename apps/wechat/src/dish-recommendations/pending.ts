import { windowId } from '../window-ratings/contract';
import { ClientError } from '../api/errors';
import { exact } from '../community/contract';
import type { Storage } from '../platform/contracts';
import {
  decodeDishReceipt,
  decodeDishCommand,
  invalidDish,
  matchDishReceipt,
  dishOperation,
  type DishOperation,
  type DishReceipt,
  type DishCommand,
} from './contract';
export interface PendingDishRecommendation {
  readonly version: 1;
  readonly accountId: string;
  readonly origin: string;
  readonly operation: DishOperation;
  readonly windowId: string;
  readonly command: DishCommand;
  readonly phase: 'submit' | 'cancel';
}
const equal = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b);
const unavailable = (): ClientError =>
  new ClientError(
    'storage',
    'Dish recommendation recovery storage unavailable',
  );
export class PendingDishRecommendationStore {
  constructor(
    private readonly storage: Storage,
    readonly origin: string,
  ) {}
  private key(accountId: string): string {
    if (!windowId(accountId)) throw unavailable();
    return `whaleu.dish-recommendations.pending.v1:${this.origin}:${accountId}`;
  }
  private decode(raw: unknown, accountId: string): PendingDishRecommendation {
    exact(raw, [
      'version',
      'accountId',
      'origin',
      'operation',
      'windowId',
      'command',
      'phase',
    ]);
    if (
      raw.version !== 1 ||
      !windowId(accountId) ||
      raw.accountId !== accountId ||
      raw.origin !== this.origin ||
      !dishOperation(raw.operation) ||
      !windowId(raw.windowId) ||
      (raw.phase !== 'submit' && raw.phase !== 'cancel')
    )
      invalidDish();
    return Object.freeze({
      version: 1,
      accountId,
      origin: this.origin,
      operation: raw.operation,
      windowId: raw.windowId,
      command: decodeDishCommand(raw.command),
      phase: raw.phase,
    });
  }
  load(accountId: string): PendingDishRecommendation | null {
    try {
      const value = this.storage.get(this.key(accountId));
      return value === undefined || value === null || value === ''
        ? null
        : this.decode(value, accountId);
    } catch {
      throw unavailable();
    }
  }
  freeze(raw: PendingDishRecommendation): PendingDishRecommendation {
    try {
      const value = this.decode(raw, raw.accountId),
        old = this.load(value.accountId);
      if (old && !equal(old, value)) throw unavailable();
      if (!old) this.storage.set(this.key(value.accountId), value);
      this.assertOriginal(value);
      return value;
    } catch {
      throw unavailable();
    }
  }
  assertOriginal(value: PendingDishRecommendation): void {
    if (!equal(this.load(value.accountId), value)) throw unavailable();
  }
  beginCancellation(
    value: PendingDishRecommendation,
  ): PendingDishRecommendation {
    this.assertOriginal(value);
    const cancelled = this.decode(
      { ...value, phase: 'cancel' },
      value.accountId,
    );
    try {
      this.storage.set(this.key(value.accountId), cancelled);
      this.assertOriginal(cancelled);
      return cancelled;
    } catch {
      throw unavailable();
    }
  }
  settle(value: PendingDishRecommendation, raw: DishReceipt): DishReceipt {
    const result = decodeDishReceipt(raw);
    matchDishReceipt(value.windowId, value.operation, value.command, result);
    this.assertOriginal(value);
    try {
      this.storage.remove(this.key(value.accountId));
      if (this.load(value.accountId)) throw unavailable();
    } catch {
      try {
        this.storage.set(this.key(value.accountId), value);
      } catch {
        /* Preserve the blocker. */
      }
      throw unavailable();
    }
    return result;
  }
}
