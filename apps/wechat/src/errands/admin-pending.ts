import { ClientError } from '../api/errors';
import { exact } from '../community/contract';
import type { Storage } from '../platform/contracts';
import {
  decodeErrandAdminAuthority,
  type ErrandAdminAuthority,
} from './admin-authority';
import {
  decodeErrandAdminIntent,
  decodeErrandAdminReceipt,
  isOrderAdminIntent,
  matchErrandAdminReceipt,
  type ErrandAdminIntent,
  type ErrandAdminReceipt,
} from './admin-command-contract';
import { errandId, invalidErrand } from './contract';
export interface PendingErrandAdmin {
  readonly version: 1;
  readonly kind: 'errand_admin';
  readonly accountId: string;
  readonly authority: ErrandAdminAuthority;
  readonly intent: ErrandAdminIntent;
}
const unavailable = (): ClientError =>
  new ClientError('storage', 'Administrative request storage unavailable');
const equal = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b);
function decode(value: unknown, accountId: string): PendingErrandAdmin {
  exact(value, ['version', 'kind', 'accountId', 'authority', 'intent']);
  if (
    value.version !== 1 ||
    value.kind !== 'errand_admin' ||
    !errandId(accountId) ||
    value.accountId !== accountId
  )
    invalidErrand();
  const authority = decodeErrandAdminAuthority(value.authority),
    intent = decodeErrandAdminIntent(value.intent);
  if (
    isOrderAdminIntent(intent)
      ? authority.regionId === null
      : authority.regionId !== null || authority.role === 'school_admin'
  )
    invalidErrand();
  return Object.freeze({
    version: 1,
    kind: 'errand_admin',
    accountId,
    authority,
    intent,
  });
}
/** A separate administrative ledger. Unknown outcomes are never evicted or rewritten by a role change. */
export class PendingErrandAdminStore {
  constructor(
    private readonly storage: Storage,
    private readonly origin: string,
  ) {}
  private key(accountId: string): string {
    if (!errandId(accountId)) throw unavailable();
    return `whaleu.errands.admin.pending.v1:${this.origin}:${accountId}`;
  }
  load(accountId: string): PendingErrandAdmin | null {
    try {
      const value = this.storage.get(this.key(accountId));
      return value === undefined || value === null || value === ''
        ? null
        : decode(value, accountId);
    } catch {
      throw unavailable();
    }
  }
  freeze(raw: PendingErrandAdmin): PendingErrandAdmin {
    try {
      const attempt = decode(raw, raw.accountId),
        previous = this.load(raw.accountId);
      if (previous && !equal(previous, attempt)) throw unavailable();
      if (!previous) this.storage.set(this.key(attempt.accountId), attempt);
      this.assertOriginal(attempt);
      return attempt;
    } catch {
      throw unavailable();
    }
  }
  assertOriginal(attempt: PendingErrandAdmin): void {
    if (!equal(this.load(attempt.accountId), attempt)) throw unavailable();
  }
  settle(
    attempt: PendingErrandAdmin,
    raw: ErrandAdminReceipt,
  ): ErrandAdminReceipt {
    const receipt = decodeErrandAdminReceipt(raw);
    matchErrandAdminReceipt(attempt.intent, receipt);
    try {
      this.assertOriginal(attempt);
      this.storage.remove(this.key(attempt.accountId));
      if (this.load(attempt.accountId)) throw unavailable();
    } catch {
      throw unavailable();
    }
    return receipt;
  }
}
