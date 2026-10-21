import { ClientError } from '../api/errors';
import { exact, invalid } from '../community/contract';
import type { Storage } from '../platform/contracts';
import { isUuid } from '../profile/contract';
import { decodeFollowReceipt, type FollowReceipt } from './contract';

export interface PendingFollow {
  readonly version: 1;
  readonly accountId: string;
  readonly profileId: string;
  readonly following: boolean;
  readonly requestId: string;
}
const equal = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const unavailable = () =>
  new ClientError('storage', 'Follow recovery storage unavailable');
function decode(value: unknown, accountId: string): PendingFollow {
  exact(value, ['version', 'accountId', 'profileId', 'following', 'requestId']);
  if (
    value.version !== 1 ||
    !isUuid(accountId) ||
    value.accountId !== accountId ||
    !isUuid(value.profileId) ||
    !isUuid(value.requestId) ||
    typeof value.following !== 'boolean'
  )
    invalid();
  return Object.freeze({
    version: 1,
    accountId,
    profileId: value.profileId,
    following: value.following,
    requestId: value.requestId,
  });
}
/** One immutable unresolved intent per actor. Reads never replay it. */
export class PendingFollowStore {
  constructor(
    private readonly storage: Storage,
    private readonly namespace: string,
  ) {}
  private key(accountId: string): string {
    if (!isUuid(accountId)) throw unavailable();
    return `whaleu.following.pending.v1:${this.namespace}:${accountId}`;
  }
  load(accountId: string): PendingFollow | null {
    try {
      const value = this.storage.get(this.key(accountId));
      return value === undefined || value === null || value === ''
        ? null
        : decode(value, accountId);
    } catch {
      throw unavailable();
    }
  }
  freeze(attempt: PendingFollow): PendingFollow {
    try {
      const checked = decode(attempt, attempt.accountId);
      const old = this.load(attempt.accountId);
      if (old && !equal(old, checked)) throw unavailable();
      if (!old) this.storage.set(this.key(attempt.accountId), checked);
      const saved = this.load(attempt.accountId);
      if (!saved || !equal(saved, checked)) throw unavailable();
      return saved;
    } catch {
      throw unavailable();
    }
  }
  settle(attempt: PendingFollow, raw: FollowReceipt): FollowReceipt {
    const result = decodeFollowReceipt(raw);
    if (
      result.requestId !== attempt.requestId ||
      result.profileId !== attempt.profileId ||
      result.following !== attempt.following
    )
      throw new ClientError('protocol', 'Follow acknowledgement mismatch');
    try {
      const current = this.load(attempt.accountId);
      if (!current || !equal(current, attempt)) throw unavailable();
      this.storage.remove(this.key(attempt.accountId));
      if (this.load(attempt.accountId)) throw unavailable();
    } catch {
      throw unavailable();
    }
    return result;
  }
}
