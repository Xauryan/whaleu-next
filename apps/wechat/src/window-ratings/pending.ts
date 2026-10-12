import { ClientError } from '../api/errors';
import { exact } from '../community/contract';
import type { Storage } from '../platform/contracts';
import {
  decodeWindowReceipt,
  decodeWindowSetScore,
  invalidWindow,
  matchWindowReceipt,
  windowId,
  type WindowReceipt,
  type WindowSetScore,
} from './contract';
export interface PendingWindowRating {
  readonly version: 1;
  readonly accountId: string;
  readonly origin: string;
  readonly operation: 'window.score.set.v1';
  readonly windowId: string;
  readonly command: WindowSetScore;
  readonly phase: 'submit' | 'cancel';
}
const equal = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b);
const unavailable = (): ClientError =>
  new ClientError('storage', 'Window rating recovery storage unavailable');
export class PendingWindowRatingStore {
  constructor(
    private readonly storage: Storage,
    readonly origin: string,
  ) {}
  private key(accountId: string): string {
    if (!windowId(accountId)) throw unavailable();
    return `whaleu.window-ratings.pending.v1:${this.origin}:${accountId}`;
  }
  private decode(raw: unknown, accountId: string): PendingWindowRating {
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
      raw.operation !== 'window.score.set.v1' ||
      !windowId(raw.windowId) ||
      (raw.phase !== 'submit' && raw.phase !== 'cancel')
    )
      invalidWindow();
    return Object.freeze({
      version: 1,
      accountId,
      origin: this.origin,
      operation: 'window.score.set.v1',
      windowId: raw.windowId,
      command: decodeWindowSetScore(raw.command),
      phase: raw.phase,
    });
  }
  load(accountId: string): PendingWindowRating | null {
    try {
      const value = this.storage.get(this.key(accountId));
      return value === undefined || value === null || value === ''
        ? null
        : this.decode(value, accountId);
    } catch {
      throw unavailable();
    }
  }
  freeze(raw: PendingWindowRating): PendingWindowRating {
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
  assertOriginal(value: PendingWindowRating): void {
    if (!equal(this.load(value.accountId), value)) throw unavailable();
  }
  beginCancellation(value: PendingWindowRating): PendingWindowRating {
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
  settle(value: PendingWindowRating, raw: WindowReceipt): WindowReceipt {
    const result = decodeWindowReceipt(raw);
    matchWindowReceipt(value.windowId, value.command, result);
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
