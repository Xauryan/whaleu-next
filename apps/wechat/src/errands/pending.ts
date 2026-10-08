import { ClientError } from '../api/errors';
import { exact } from '../community/contract';
import type { Storage } from '../platform/contracts';
import {
  decodeErrandContacts,
  decodeErrandIntent,
  decodeErrandReceipt,
  errandId,
  invalidErrand,
  matchErrandReceipt,
  type ErrandContacts,
  type ErrandIntent,
  type ErrandReceipt,
} from './contract';
export interface PendingErrand {
  readonly version: 1;
  readonly accountId: string;
  readonly intent: ErrandIntent;
}
const equal = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b);
const unavailable = (): ClientError =>
  new ClientError('storage', 'Errand recovery storage unavailable');
function decode(value: unknown, accountId: string): PendingErrand {
  exact(value, ['version', 'accountId', 'intent']);
  if (
    value.version !== 1 ||
    !errandId(accountId) ||
    value.accountId !== accountId
  )
    invalidErrand();
  return Object.freeze({
    version: 1,
    accountId,
    intent: decodeErrandIntent(value.intent),
  });
}
/** One bounded immutable command per account/origin. No expiry or missing-receipt escape hatch. */
export class PendingErrandStore {
  constructor(
    private readonly storage: Storage,
    private readonly origin: string,
  ) {}
  private key(accountId: string, kind = 'pending'): string {
    if (!errandId(accountId)) throw unavailable();
    return `whaleu.errands.${kind}.v1:${this.origin}:${accountId}`;
  }
  load(accountId: string): PendingErrand | null {
    try {
      const value = this.storage.get(this.key(accountId));
      return value === undefined || value === null || value === ''
        ? null
        : decode(value, accountId);
    } catch {
      throw unavailable();
    }
  }
  freeze(raw: PendingErrand): PendingErrand {
    try {
      const attempt = decode(raw, raw.accountId),
        old = this.load(raw.accountId);
      if (old && !equal(old, attempt)) throw unavailable();
      if (!old) this.storage.set(this.key(attempt.accountId), attempt);
      this.assertOriginal(attempt);
      return attempt;
    } catch {
      throw unavailable();
    }
  }
  assertOriginal(attempt: PendingErrand): void {
    if (!equal(this.load(attempt.accountId), attempt)) throw unavailable();
  }
  publisherContacts(accountId: string): ErrandContacts | null {
    try {
      const value = this.storage.get(this.key(accountId, 'publisher-contacts'));
      if (value === undefined || value === null || value === '') return null;
      exact(value, ['version', 'accountId', 'contacts']);
      if (value.version !== 1 || value.accountId !== accountId)
        throw unavailable();
      return decodeErrandContacts(value.contacts, 'publisher');
    } catch {
      throw unavailable();
    }
  }
  settle(attempt: PendingErrand, raw: ErrandReceipt): ErrandReceipt {
    const receipt = decodeErrandReceipt(raw);
    matchErrandReceipt(attempt.intent, receipt);
    try {
      this.assertOriginal(attempt);
      if (
        receipt.outcome === 'applied' &&
        attempt.intent.operation === 'publish'
      ) {
        const contacts = attempt.intent.payload.publisherContacts;
        this.storage.set(this.key(attempt.accountId, 'publisher-contacts'), {
          version: 1,
          accountId: attempt.accountId,
          contacts,
        });
        if (!equal(this.publisherContacts(attempt.accountId), contacts))
          throw unavailable();
      }
      this.storage.remove(this.key(attempt.accountId));
      if (this.load(attempt.accountId)) throw unavailable();
    } catch {
      throw unavailable();
    }
    return receipt;
  }
}
