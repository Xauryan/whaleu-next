import { ClientError } from '../api/errors';
import { exact } from '../community/contract';
import type { Storage } from '../platform/contracts';
import {
  activityUuid,
  decodeActivityVisitIntent,
  decodeActivityVisitReceipt,
  invalidActivity,
  matchActivityVisit,
  type ActivityVisitIntent,
  type ActivityVisitReceipt,
} from './contract';
export interface PendingActivityVisit extends ActivityVisitIntent {
  readonly version: 1;
  readonly accountId: string;
}
const equal = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b);
const unavailable = (): ClientError =>
  new ClientError('storage', 'Activity visit recovery unavailable');
function decode(value: unknown, accountId: string): PendingActivityVisit {
  exact(value, [
    'version',
    'accountId',
    'requestId',
    'regionId',
    'expectedCatalogRevision',
  ]);
  if (
    value.version !== 1 ||
    !activityUuid(accountId) ||
    value.accountId !== accountId
  )
    invalidActivity();
  return Object.freeze({
    version: 1,
    accountId,
    ...decodeActivityVisitIntent({
      requestId: value.requestId,
      regionId: value.regionId,
      expectedCatalogRevision: value.expectedCatalogRevision,
    }),
  });
}
/** One unresolved immutable command per account and API origin. Never stores content or cursors. */
export class PendingActivityVisitStore {
  constructor(
    private readonly storage: Storage,
    private readonly origin: string,
  ) {}
  private key(accountId: string): string {
    if (!activityUuid(accountId)) throw unavailable();
    return `whaleu.activity.visit.pending.v1:${this.origin}:${accountId}`;
  }
  load(accountId: string): PendingActivityVisit | null {
    try {
      const value = this.storage.get(this.key(accountId));
      return value === undefined || value === null || value === ''
        ? null
        : decode(value, accountId);
    } catch {
      throw unavailable();
    }
  }
  freeze(raw: PendingActivityVisit): PendingActivityVisit {
    try {
      const attempt = decode(raw, raw.accountId),
        existing = this.load(raw.accountId);
      if (existing && !equal(attempt, existing)) throw unavailable();
      if (!existing) this.storage.set(this.key(attempt.accountId), attempt);
      this.assertOriginal(attempt);
      return attempt;
    } catch {
      throw unavailable();
    }
  }
  assertOriginal(attempt: PendingActivityVisit): void {
    if (!equal(this.load(attempt.accountId), attempt)) throw unavailable();
  }
  settle(
    attempt: PendingActivityVisit,
    raw: ActivityVisitReceipt,
  ): ActivityVisitReceipt {
    const receipt = decodeActivityVisitReceipt(raw);
    matchActivityVisit(attempt, receipt);
    this.release(attempt);
    return receipt;
  }
  /** Only a definitive exact-command revision conflict may release without a receipt. */
  release(attempt: PendingActivityVisit): void {
    try {
      this.assertOriginal(attempt);
      this.storage.remove(this.key(attempt.accountId));
      if (this.load(attempt.accountId)) throw unavailable();
    } catch {
      throw unavailable();
    }
  }
}
