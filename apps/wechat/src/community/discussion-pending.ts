import { ClientError } from '../api/errors';
import type { Storage } from '../platform/contracts';
import { isUuid } from '../profile/contract';
import { exact, invalid, uuid4 } from './contract';
import {
  decodeDiscussionReceipt,
  type DiscussionOperation,
  type DiscussionReceipt,
} from './discussion-contract';
export interface PendingDiscussion {
  readonly version: 1;
  readonly accountId: string;
  readonly operation: DiscussionOperation;
  readonly postId: string;
  readonly rootCommentId: string;
  readonly targetId: string;
  readonly desired: boolean;
  readonly clientRequestId: string;
}
const equal = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const unavailable = () =>
  new ClientError('storage', 'Discussion recovery storage unavailable');
function decode(value: unknown, accountId: string): PendingDiscussion {
  exact(value, [
    'version',
    'accountId',
    'operation',
    'postId',
    'rootCommentId',
    'targetId',
    'desired',
    'clientRequestId',
  ]);
  if (
    value.version !== 1 ||
    !isUuid(accountId) ||
    value.accountId !== accountId ||
    !isUuid(value.postId) ||
    !isUuid(value.rootCommentId) ||
    !isUuid(value.targetId) ||
    !uuid4(value.clientRequestId) ||
    typeof value.desired !== 'boolean' ||
    !['set_comment_like', 'set_reply_like', 'set_comment_pin'].includes(
      String(value.operation),
    ) ||
    (value.operation !== 'set_reply_like' &&
      value.targetId !== value.rootCommentId)
  )
    invalid();
  return Object.freeze({
    version: 1,
    accountId,
    operation: value.operation as DiscussionOperation,
    postId: value.postId,
    rootCommentId: value.rootCommentId,
    targetId: value.targetId,
    desired: value.desired,
    clientRequestId: value.clientRequestId,
  });
}
/** One unresolved desired-state mutation per account; never silently replace an unknown opposite intent. */
export class PendingDiscussionStore {
  constructor(
    private readonly storage: Storage,
    private readonly namespace: string,
  ) {}
  private key(accountId: string): string {
    if (!isUuid(accountId)) throw unavailable();
    return `whaleu.community.discussion.pending.v1:${this.namespace}:${accountId}`;
  }
  load(accountId: string): PendingDiscussion | null {
    try {
      const value = this.storage.get(this.key(accountId));
      return value === undefined || value === null || value === ''
        ? null
        : decode(value, accountId);
    } catch {
      throw unavailable();
    }
  }
  freeze(attempt: PendingDiscussion): PendingDiscussion {
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
  settle(
    attempt: PendingDiscussion,
    raw: DiscussionReceipt,
  ): DiscussionReceipt {
    const receipt = decodeDiscussionReceipt(raw);
    if (
      receipt.requestId !== attempt.clientRequestId ||
      receipt.operation !== attempt.operation ||
      (receipt.outcome === 'applied' &&
        (receipt.resourceId !== attempt.targetId ||
          receipt.desired !== attempt.desired))
    )
      invalid();
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
