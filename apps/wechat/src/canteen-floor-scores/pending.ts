import { ClientError } from '../api/errors';
import { exact } from '../community/contract';
import type { Storage } from '../platform/contracts';
import {
  decodeFloorReceipt,
  decodeFloorSetScore,
  invalidFloor,
  matchFloorReceipt,
  floorId,
  type FloorReceipt,
  type FloorSetScore,
} from './contract';
export interface PendingFloorRating {
  readonly version: 1;
  readonly accountId: string;
  readonly origin: string;
  readonly operation: 'floor.score.first.v1';
  readonly floorId: string;
  readonly command: FloorSetScore;
  readonly phase: 'submit' | 'cancel';
}
const equal = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b);
const unavailable = (): ClientError =>
  new ClientError('storage', 'Floor rating recovery storage unavailable');
export class PendingFloorRatingStore {
  constructor(
    private readonly storage: Storage,
    readonly origin: string,
  ) {}
  private key(accountId: string): string {
    if (!floorId(accountId)) throw unavailable();
    return `whaleu.canteen-floor-scores.pending.v1:${this.origin}:${accountId}`;
  }
  private decode(raw: unknown, accountId: string): PendingFloorRating {
    exact(raw, [
      'version',
      'accountId',
      'origin',
      'operation',
      'floorId',
      'command',
      'phase',
    ]);
    if (
      raw.version !== 1 ||
      !floorId(accountId) ||
      raw.accountId !== accountId ||
      raw.origin !== this.origin ||
      raw.operation !== 'floor.score.first.v1' ||
      !floorId(raw.floorId) ||
      (raw.phase !== 'submit' && raw.phase !== 'cancel')
    )
      invalidFloor();
    return Object.freeze({
      version: 1,
      accountId,
      origin: this.origin,
      operation: 'floor.score.first.v1',
      floorId: raw.floorId,
      command: decodeFloorSetScore(raw.command),
      phase: raw.phase,
    });
  }
  load(accountId: string): PendingFloorRating | null {
    try {
      const value = this.storage.get(this.key(accountId));
      return value === undefined || value === null || value === ''
        ? null
        : this.decode(value, accountId);
    } catch {
      throw unavailable();
    }
  }
  freeze(raw: PendingFloorRating): PendingFloorRating {
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
  assertOriginal(value: PendingFloorRating): void {
    if (!equal(this.load(value.accountId), value)) throw unavailable();
  }
  beginCancellation(value: PendingFloorRating): PendingFloorRating {
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
  settle(value: PendingFloorRating, raw: FloorReceipt): FloorReceipt {
    const result = decodeFloorReceipt(raw);
    matchFloorReceipt(value.floorId, value.command, result);
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
