import { ClientError } from '../api/errors';
import type { Storage } from '../platform/contracts';
import { isUuid } from '../profile/contract';
import { exact, invalid } from './contract';
import {
  decodeSavedIntent,
  decodeSavedReceipt,
  matchSavedReceipt,
  type SavedIntent,
  type SavedReceipt,
} from './saved-contract';
export interface PendingSaved extends SavedIntent {
  readonly version: 1;
  readonly accountId: string;
}
const equal = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const unavailable = () =>
  new ClientError('storage', 'Saved recovery storage unavailable');
function decode(value: unknown, accountId: string): PendingSaved {
  exact(value, [
    'version',
    'accountId',
    'clientRequestId',
    'operation',
    'postId',
    'desired',
    'channel',
  ]);
  if (
    value.version !== 1 ||
    !isUuid(accountId) ||
    value.accountId !== accountId
  )
    invalid();
  const intent = decodeSavedIntent({
    clientRequestId: value.clientRequestId,
    operation: value.operation,
    postId: value.postId,
    desired: value.desired,
    channel: value.channel,
  });
  return Object.freeze({ version: 1, accountId, ...intent });
}
/** A separate nonexpiring account-wide journal serializes saves and both preference channels. */
export class PendingSavedStore {
  constructor(
    private readonly storage: Storage,
    private readonly namespace: string,
  ) {}
  private key(accountId: string): string {
    if (!isUuid(accountId)) throw unavailable();
    return `whaleu.community.saved.pending.v1:${this.namespace}:${accountId}`;
  }
  load(accountId: string): PendingSaved | null {
    try {
      const value = this.storage.get(this.key(accountId));
      return value === undefined || value === null || value === ''
        ? null
        : decode(value, accountId);
    } catch {
      throw unavailable();
    }
  }
  freeze(attempt: PendingSaved): PendingSaved {
    try {
      const checked = decode(attempt, attempt.accountId),
        old = this.load(attempt.accountId);
      if (old && !equal(old, checked)) throw unavailable();
      if (!old) this.storage.set(this.key(attempt.accountId), checked);
      const saved = this.load(attempt.accountId);
      if (!saved || !equal(saved, checked)) throw unavailable();
      return saved;
    } catch {
      throw unavailable();
    }
  }
  settle(attempt: PendingSaved, raw: SavedReceipt): SavedReceipt {
    const receipt = decodeSavedReceipt(raw);
    matchSavedReceipt(attempt, receipt);
    try {
      const current = this.load(attempt.accountId);
      if (!current || !equal(current, attempt)) throw unavailable();
      this.storage.remove(this.key(attempt.accountId));
      if (this.load(attempt.accountId)) throw unavailable();
    } catch {
      throw unavailable();
    }
    return receipt;
  }
}
