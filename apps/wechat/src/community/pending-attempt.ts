import {
  decodeTradingContacts,
  tradingText,
  type TradingContacts,
} from './trading-contract';
import { decodeTradingDraft, type TradingDraft } from './trading-draft';
import { decodeReplyIntent, type ReplyIntent } from './discussion-contract';
import { ClientError, isRecord } from '../api/errors';
import type { Storage } from '../platform/contracts';
import { isUuid } from '../profile/contract';
import { decodePollDraft, type PollDraft } from './poll-draft';
import { decodeFormationDraft, type FormationDraft } from './formation-draft';
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
      readonly operation: 'publish_reply';
      readonly postId: string;
      readonly rootCommentId: string;
      readonly payload: ReplyIntent;
    }
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
  if (value.operation === 'publish_reply') {
    exact(value, [
      'version',
      'accountId',
      'operation',
      'postId',
      'rootCommentId',
      'payload',
    ]);
    if (
      value.version !== 1 ||
      value.accountId !== accountId ||
      !isUuid(accountId) ||
      !isUuid(value.postId) ||
      !isUuid(value.rootCommentId)
    )
      invalid();
    const payload = decodeReplyIntent(value.payload);
    if (payload.targetReplyId === value.rootCommentId) invalid();
    return Object.freeze({
      version: 1,
      accountId,
      operation: 'publish_reply',
      postId: value.postId,
      rootCommentId: value.rootCommentId,
      payload,
    });
  }
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
  /** Additive batch cancellation settlement. A not-found response and dispatch hint
   * never reach this method; only the exact durable owner fence is accepted. */
  settleCancelled(
    attempt: PendingAttempt,
    raw: unknown,
    expectedIntentHash: string,
  ): void {
    exact(raw, ['requestId', 'operation', 'outcome', 'intentHash']);
    if (
      raw.requestId !== attempt.payload.clientRequestId ||
      raw.operation !== attempt.operation ||
      raw.outcome !== 'cancelled' ||
      typeof expectedIntentHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(expectedIntentHash) ||
      raw.intentHash !== expectedIntentHash
    )
      invalid();
    try {
      if (!equal(this.load(attempt.accountId), attempt)) throw storageError();
      this.storage.remove(this.key(attempt.accountId));
      if (this.load(attempt.accountId)) throw storageError();
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
  readonly allowAnonymousDm?: boolean;
  readonly trading?: TradingDraft;
  readonly poll?: PollDraft;
  readonly formation?: FormationDraft;
  readonly version: 1;
  readonly text: string;
  readonly authorMode: AuthorMode;
  readonly commentsPolicy: 'open' | 'restricted';
}
export interface TradingPreferences {
  readonly version: 1;
  readonly location: string;
  readonly contacts: TradingContacts;
}
export class DraftStore {
  constructor(
    private readonly storage: Storage,
    private readonly namespace: string,
  ) {}
  private key(accountId: string, target: string): string {
    if (
      !isUuid(accountId) ||
      !/^(?:post|comment|reply):[a-z0-9_:-]{1,160}$/.test(target)
    )
      throw storageError();
    return `whaleu.community.draft.v1:${this.namespace}:${accountId}:${target}`;
  }
  private tradingPreferenceKey(accountId: string): string {
    if (!isUuid(accountId)) throw storageError();
    return `whaleu.community.trading.preferences.v1:${this.namespace}:${accountId}`;
  }
  loadTradingPreferences(accountId: string): TradingPreferences | null {
    try {
      const value = this.storage.get(this.tradingPreferenceKey(accountId));
      if (value === undefined || value === null || value === '') return null;
      exact(value, ['version', 'location', 'contacts']);
      if (value.version !== 1 || !tradingText(value.location, 200))
        throw storageError();
      return Object.freeze({
        version: 1,
        location: value.location,
        contacts: decodeTradingContacts(value.contacts),
      });
    } catch {
      throw storageError();
    }
  }
  rememberTrading(
    accountId: string,
    location: string,
    contacts: TradingContacts,
  ): void {
    try {
      if (!tradingText(location, 200)) throw storageError();
      const value = {
        version: 1 as const,
        location,
        contacts: decodeTradingContacts(contacts),
      };
      this.storage.set(this.tradingPreferenceKey(accountId), value);
      if (!equal(this.loadTradingPreferences(accountId), value))
        throw storageError();
    } catch {
      throw storageError();
    }
  }
  load(accountId: string, target: string): Draft | null {
    try {
      const value = this.storage.get(this.key(accountId, target));
      if (value === undefined || value === null || value === '') return null;
      if (!isRecord(value)) throw storageError();
      const hasAnonymousDm = Object.prototype.hasOwnProperty.call(
        value,
        'allowAnonymousDm',
      );
      if (
        hasAnonymousDm &&
        (typeof value.allowAnonymousDm !== 'boolean' ||
          !target.startsWith('post:'))
      )
        throw storageError();
      const hasTrading = Object.prototype.hasOwnProperty.call(value, 'trading');
      const hasPoll = Object.prototype.hasOwnProperty.call(value, 'poll');
      const hasFormation = Object.prototype.hasOwnProperty.call(
        value,
        'formation',
      );
      if ((hasPoll || hasFormation) && hasTrading) throw storageError();
      if (
        hasFormation &&
        (!target.startsWith('post:') || target.endsWith(':trading'))
      )
        throw storageError();
      exact(value, [
        ...(hasAnonymousDm ? ['allowAnonymousDm'] : []),
        'version',
        'text',
        'authorMode',
        'commentsPolicy',
        ...(hasPoll ? ['poll'] : []),
        ...(hasFormation ? ['formation'] : []),
        ...(hasTrading ? ['trading'] : []),
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
      const poll = hasPoll ? decodePollDraft(value.poll) : undefined;
      const formation = hasFormation
        ? decodeFormationDraft(value.formation)
        : undefined;
      if (poll?.enabled && formation?.enabled) throw storageError();
      return Object.freeze({
        version: 1,
        ...(hasAnonymousDm
          ? { allowAnonymousDm: value.allowAnonymousDm as boolean }
          : {}),
        ...(hasPoll ? { poll: poll! } : {}),
        ...(hasFormation ? { formation: formation! } : {}),
        ...(hasTrading ? { trading: decodeTradingDraft(value.trading) } : {}),
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
      const hasAnonymousDm = Object.prototype.hasOwnProperty.call(
        draft,
        'allowAnonymousDm',
      );
      if (
        hasAnonymousDm &&
        (typeof draft.allowAnonymousDm !== 'boolean' ||
          !target.startsWith('post:'))
      )
        throw storageError();
      if (!boundedText(draft.text.replace(/\r\n/g, '\n'), 0, 10000))
        throw storageError();
      if ((draft.poll || draft.formation) && draft.trading)
        throw storageError();
      if (
        draft.formation &&
        (!target.startsWith('post:') || target.endsWith(':trading'))
      )
        throw storageError();
      const poll = draft.poll ? decodePollDraft(draft.poll) : undefined;
      const formation = draft.formation
        ? decodeFormationDraft(draft.formation)
        : undefined;
      if (poll?.enabled && formation?.enabled) throw storageError();
      const checked: Draft = {
        version: 1,
        ...(hasAnonymousDm
          ? { allowAnonymousDm: draft.allowAnonymousDm! }
          : {}),
        ...(poll ? { poll } : {}),
        ...(formation ? { formation } : {}),
        ...(draft.trading
          ? { trading: decodeTradingDraft(draft.trading) }
          : {}),
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
