import { ClientError, isRecord } from '../api/errors';
import type { Storage } from '../platform/contracts';
import { isUuid } from '../profile/contract';
import { decodePollDraft, type PollDraft } from './poll-draft';
import {
  boundedText,
  decodeCommentIntent,
  decodePostIntent,
  decodeReceipt,
  exact,
  invalid,
  type AuthorMode,
  type CommentIntent,
  type PostIntent,
  type Receipt,
} from './contract';
export type PendingAttempt =
  | {
      readonly version: 1;
      readonly accountId: string;
      readonly operation: 'publish_post';
      readonly payload: PostIntent;
    }
  | {
      readonly version: 1;
      readonly accountId: string;
      readonly operation: 'publish_comment';
      readonly postId: string;
      readonly payload: CommentIntent;
    };
function decodeAttempt(value: unknown, accountId: string): PendingAttempt {
  if (!isRecord(value)) invalid();
  if (value.operation === 'publish_post') {
    exact(value, ['version', 'accountId', 'operation', 'payload']);
    if (
      value.version !== 1 ||
      value.accountId !== accountId ||
      !isUuid(accountId)
    )
      invalid();
    return Object.freeze({
      version: 1,
      accountId,
      operation: 'publish_post',
      payload: decodePostIntent(value.payload),
    });
  }
  exact(value, ['version', 'accountId', 'operation', 'postId', 'payload']);
  if (
    value.version !== 1 ||
    value.accountId !== accountId ||
    !isUuid(accountId) ||
    value.operation !== 'publish_comment' ||
    !isUuid(value.postId)
  )
    invalid();
  return Object.freeze({
    version: 1,
    accountId,
    operation: 'publish_comment',
    postId: value.postId,
    payload: decodeCommentIntent(value.payload),
  });
}
const equal = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b);
const storageError = (): ClientError =>
  new ClientError('storage', 'Publication recovery storage is unavailable');
/** One unresolved publication per account, across all pages and operations. Never expire/delete unknown attempts. */
export class PendingAttemptStore {
  constructor(
    private readonly storage: Storage,
    private readonly namespace: string,
  ) {}
  private key(accountId: string): string {
    if (!isUuid(accountId)) throw storageError();
    return `whaleu.community.pending.v1:${this.namespace}:${accountId}`;
  }
  load(accountId: string): PendingAttempt | null {
    try {
      const raw = this.storage.get(this.key(accountId));
      return raw === undefined || raw === null || raw === ''
        ? null
        : decodeAttempt(raw, accountId);
    } catch {
      throw storageError();
    }
  }
  freeze(attempt: PendingAttempt): PendingAttempt {
    try {
      const checked = decodeAttempt(attempt, attempt.accountId),
        old = this.load(checked.accountId);
      if (old && !equal(old, checked)) throw storageError();
      if (!old) this.storage.set(this.key(checked.accountId), checked);
      const saved = this.load(checked.accountId);
      if (!saved || !equal(saved, checked)) throw storageError();
      return saved;
    } catch {
      throw storageError();
    }
  }
  settle(attempt: PendingAttempt, rawReceipt: Receipt): Receipt {
    const receipt = decodeReceipt(rawReceipt);
    if (
      receipt.requestId !== attempt.payload.clientRequestId ||
      receipt.operation !== attempt.operation
    )
      invalid();
    try {
      const current = this.load(attempt.accountId);
      if (!current || !equal(current, attempt)) throw storageError();
      this.storage.remove(this.key(attempt.accountId));
      if (this.load(attempt.accountId)) throw storageError();
    } catch {
      throw storageError();
    }
    return receipt;
  }
}
export interface Draft {
  readonly poll?: PollDraft;
  readonly version: 1;
  readonly text: string;
  readonly authorMode: AuthorMode;
  readonly commentsPolicy: 'open' | 'restricted';
}
export class DraftStore {
  constructor(
    private readonly storage: Storage,
    private readonly namespace: string,
  ) {}
  private key(accountId: string, target: string): string {
    if (
      !isUuid(accountId) ||
      !/^(?:post|comment):[a-z0-9_:-]{1,100}$/.test(target)
    )
      throw storageError();
    return `whaleu.community.draft.v1:${this.namespace}:${accountId}:${target}`;
  }
  load(accountId: string, target: string): Draft | null {
    try {
      const value = this.storage.get(this.key(accountId, target));
      if (value === undefined || value === null || value === '') return null;
      if (!isRecord(value)) throw storageError();
      const hasPoll = Object.prototype.hasOwnProperty.call(value, 'poll');
      exact(value, [
        'version',
        'text',
        'authorMode',
        'commentsPolicy',
        ...(hasPoll ? ['poll'] : []),
      ]);
      if (
        value.version !== 1 ||
        !(
          typeof value.text === 'string' &&
          boundedText(value.text.replace(/\r\n/g, '\n'), 0, 10000)
        ) ||
        !['named', 'anonymous'].includes(String(value.authorMode)) ||
        !['open', 'restricted'].includes(String(value.commentsPolicy))
      )
        throw storageError();
      return Object.freeze({
        version: 1,
        ...(hasPoll ? { poll: decodePollDraft(value.poll) } : {}),
        text: value.text,
        authorMode: value.authorMode as AuthorMode,
        commentsPolicy: value.commentsPolicy as Draft['commentsPolicy'],
      });
    } catch {
      throw storageError();
    }
  }
  save(accountId: string, target: string, draft: Draft): void {
    try {
      if (!boundedText(draft.text.replace(/\r\n/g, '\n'), 0, 10000))
        throw storageError();
      const checked: Draft = {
        version: 1,
        ...(draft.poll ? { poll: decodePollDraft(draft.poll) } : {}),
        text: draft.text,
        authorMode: draft.authorMode,
        commentsPolicy: draft.commentsPolicy,
      };
      this.storage.set(this.key(accountId, target), checked);
      if (!equal(this.load(accountId, target), checked)) throw storageError();
    } catch {
      throw storageError();
    }
  }
  clear(accountId: string, target: string): void {
    try {
      this.storage.remove(this.key(accountId, target));
      if (this.load(accountId, target)) throw storageError();
    } catch {
      throw storageError();
    }
  }
}
