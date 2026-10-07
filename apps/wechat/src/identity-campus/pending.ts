import { ClientError } from '../api/errors';
import type { Storage } from '../platform/contracts';
import { isUuid } from '../profile/contract';
import {
  decodeIdentityCampusIntent,
  decodeIdentityCampusReceipt,
  exactIdentityCampus,
  invalidIdentityCampus,
  matchIdentityCampusReceipt,
  type IdentityCampusIntent,
  type IdentityCampusReceipt,
} from './contract';
export interface PendingIdentityCampus extends IdentityCampusIntent {
  readonly version: 1;
  readonly accountId: string;
}
const same = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b);
const unavailable = () =>
  new ClientError('storage', 'Identity campus recovery storage unavailable');
function decode(value: unknown, accountId: string): PendingIdentityCampus {
  exactIdentityCampus(value, [
    'version',
    'accountId',
    'requestId',
    'campusId',
    'expectedStateRevision',
  ]);
  if (
    value.version !== 1 ||
    !isUuid(accountId) ||
    accountId !== accountId.toLowerCase() ||
    value.accountId !== accountId
  )
    invalidIdentityCampus();
  return Object.freeze({
    version: 1,
    accountId,
    ...decodeIdentityCampusIntent({
      requestId: value.requestId,
      campusId: value.campusId,
      expectedStateRevision: value.expectedStateRevision,
    }),
  });
}
/** One immutable unresolved intent per account and API origin; never stores credentials or option facts. */
export class PendingIdentityCampusStore {
  constructor(
    private readonly storage: Storage,
    private readonly namespace: string,
  ) {}
  private key(accountId: string): string {
    if (!isUuid(accountId)) throw unavailable();
    return `whaleu.identity-campus.pending.v1:${this.namespace}:${accountId}`;
  }
  load(accountId: string): PendingIdentityCampus | null {
    try {
      const value = this.storage.get(this.key(accountId));
      return value === undefined || value === null || value === ''
        ? null
        : decode(value, accountId);
    } catch {
      throw unavailable();
    }
  }
  freeze(raw: PendingIdentityCampus): PendingIdentityCampus {
    try {
      const checked = decode(raw, raw.accountId),
        old = this.load(raw.accountId);
      if (old && !same(old, checked)) throw unavailable();
      if (!old) this.storage.set(this.key(raw.accountId), checked);
      const saved = this.load(raw.accountId);
      if (!saved || !same(saved, checked)) throw unavailable();
      return saved;
    } catch {
      throw unavailable();
    }
  }
  assertOriginal(attempt: PendingIdentityCampus): void {
    if (!same(this.load(attempt.accountId), attempt)) throw unavailable();
  }
  private remove(attempt: PendingIdentityCampus): void {
    try {
      this.assertOriginal(attempt);
      this.storage.remove(this.key(attempt.accountId));
      if (this.load(attempt.accountId)) throw unavailable();
    } catch {
      throw unavailable();
    }
  }
  settle(
    attempt: PendingIdentityCampus,
    raw: IdentityCampusReceipt,
  ): IdentityCampusReceipt {
    const receipt = decodeIdentityCampusReceipt(raw);
    matchIdentityCampusReceipt(attempt, receipt);
    this.remove(attempt);
    return receipt;
  }
  /** Only the exact awaited PUT's definitive version conflict can release an unsuccessful intent. */
  rejectRevision(attempt: PendingIdentityCampus, error: ClientError): void {
    if (
      error.kind === 'protocol' ||
      error.details.httpStatus !== 409 ||
      error.details.serverCode !== 'IDENTITY_CAMPUS_REVISION_CONFLICT'
    )
      invalidIdentityCampus();
    this.remove(attempt);
  }
}
