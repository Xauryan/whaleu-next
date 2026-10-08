import { ClientError } from '../api/errors';
import type { Storage } from '../platform/contracts';
import { isUuid } from '../profile/contract';
import { exact, invalid } from './contract';
import {
  decodePostLikeIntent,
  decodePostLikeReceipt,
  matchPostLikeReceipt,
  type PostLikeIntent,
  type PostLikeReceipt,
} from './post-like-contract';
export interface PendingPostLike extends PostLikeIntent {
  readonly version: 1;
  readonly accountId: string;
}
const equal = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const unavailable = () =>
  new ClientError('storage', 'PostLike recovery storage unavailable');
function decode(value: unknown, accountId: string): PendingPostLike {
  exact(value, [
    'version',
    'accountId',
    'requestId',
    'operation',
    'postId',
    'liked',
  ]);
  if (
    value.version !== 1 ||
    !isUuid(accountId) ||
    value.accountId !== accountId
  )
    invalid();
  const intent = decodePostLikeIntent({
    requestId: value.requestId,
    operation: value.operation,
    postId: value.postId,
    liked: value.liked,
  });
  return Object.freeze({ version: 1, accountId, ...intent });
}
/** A nonexpiring account/API-origin journal preserves one exact unresolved post-like intent. */
export class PendingPostLikeStore {
  constructor(
    private readonly storage: Storage,
    private readonly namespace: string,
  ) {}
  private key(accountId: string): string {
    if (!isUuid(accountId)) throw unavailable();
    return `whaleu.community.post-like.pending.v1:${this.namespace}:${accountId}`;
  }
  load(accountId: string): PendingPostLike | null {
    try {
      const value = this.storage.get(this.key(accountId));
      return value === undefined || value === null || value === ''
        ? null
        : decode(value, accountId);
    } catch {
      throw unavailable();
    }
  }
  freeze(attempt: PendingPostLike): PendingPostLike {
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
  settle(attempt: PendingPostLike, raw: PostLikeReceipt): PostLikeReceipt {
    const receipt = decodePostLikeReceipt(raw);
    matchPostLikeReceipt(attempt, receipt);
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
