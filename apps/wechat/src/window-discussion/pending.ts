import { windowId } from '../window-ratings/contract';
import { ClientError } from '../api/errors';
import { exact } from '../community/contract';
import type { Storage } from '../platform/contracts';
import {
  decodeDiscussionReceipt,
  decodeDiscussionIntent,
  invalidDiscussion,
  matchDiscussionReceipt,
  type DiscussionReceipt,
  type DiscussionIntent,
} from './contract';
export interface PendingWindowDiscussion {
  readonly version: 1;
  readonly accountId: string;
  readonly origin: string;
  readonly intent: DiscussionIntent;
  readonly phase: 'submit' | 'cancel';
}
const equal = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b);
const unavailable = (): ClientError =>
  new ClientError('storage', 'Window discussion recovery storage unavailable');
export interface DiscussionOwnReference {
  readonly windowId: string;
  readonly commentId: string;
}
export class PendingWindowDiscussionStore {
  constructor(
    private readonly storage: Storage,
    readonly origin: string,
  ) {}
  private key(accountId: string): string {
    if (!windowId(accountId)) throw unavailable();
    return `whaleu.window-discussion.pending.v1:${this.origin}:${accountId}`;
  }
  private decode(raw: unknown, accountId: string): PendingWindowDiscussion {
    exact(raw, ['version', 'accountId', 'origin', 'intent', 'phase']);
    if (
      raw.version !== 1 ||
      !windowId(accountId) ||
      raw.accountId !== accountId ||
      raw.origin !== this.origin ||
      (raw.phase !== 'submit' && raw.phase !== 'cancel')
    )
      invalidDiscussion();
    return Object.freeze({
      version: 1,
      accountId,
      origin: this.origin,
      intent: decodeDiscussionIntent(raw.intent),
      phase: raw.phase,
    });
  }
  load(accountId: string): PendingWindowDiscussion | null {
    try {
      const value = this.storage.get(this.key(accountId));
      return value === undefined || value === null || value === ''
        ? null
        : this.decode(value, accountId);
    } catch {
      throw unavailable();
    }
  }
  freeze(raw: PendingWindowDiscussion): PendingWindowDiscussion {
    try {
      const value = this.decode(raw, raw.accountId),
        old = this.load(value.accountId);
      if (old && !equal(old, value)) throw unavailable();
      if (!old) this.storage.set(this.key(value.accountId), value);
      this.assertOriginal(value);
      return value;
    } catch {
      throw unavailable();
    }
  }
  assertOriginal(value: PendingWindowDiscussion): void {
    if (!equal(this.load(value.accountId), value)) throw unavailable();
  }
  beginCancellation(value: PendingWindowDiscussion): PendingWindowDiscussion {
    this.assertOriginal(value);
    const cancelled = this.decode(
      { ...value, phase: 'cancel' },
      value.accountId,
    );
    try {
      this.storage.set(this.key(value.accountId), cancelled);
      this.assertOriginal(cancelled);
      return cancelled;
    } catch {
      throw unavailable();
    }
  }
  references(accountId: string): readonly DiscussionOwnReference[] {
    try {
      const raw = this.storage.get(`${this.key(accountId)}:references`);
      if (raw === undefined || raw === null || raw === '') return [];
      if (!Array.isArray(raw) || raw.length > 20) throw unavailable();
      const result = raw.map((value) => {
        exact(value, ['windowId', 'commentId']);
        if (!windowId(value.windowId) || !windowId(value.commentId))
          throw unavailable();
        return Object.freeze({
          windowId: value.windowId,
          commentId: value.commentId,
        });
      });
      if (
        new Set(result.map((v) => `${v.windowId}:${v.commentId}`)).size !==
        result.length
      )
        throw unavailable();
      return Object.freeze(result);
    } catch {
      throw unavailable();
    }
  }
  private remember(value: PendingWindowDiscussion): void {
    if (value.intent.operation !== 'window.discussion.like.v1') return;
    const ref = {
      windowId: value.intent.windowId,
      commentId: value.intent.commentId,
    };
    const refs = [
      ref,
      ...this.references(value.accountId).filter(
        (r) => r.windowId !== ref.windowId || r.commentId !== ref.commentId,
      ),
    ].slice(0, 20);
    this.storage.set(`${this.key(value.accountId)}:references`, refs);
    if (!equal(this.references(value.accountId), refs)) throw unavailable();
  }
  settle(
    value: PendingWindowDiscussion,
    raw: DiscussionReceipt,
  ): DiscussionReceipt {
    const result = decodeDiscussionReceipt(raw);
    matchDiscussionReceipt(value.intent, result);
    this.assertOriginal(value);
    try {
      this.remember(value);
      this.storage.remove(this.key(value.accountId));
      if (this.load(value.accountId)) throw unavailable();
    } catch {
      try {
        this.storage.set(this.key(value.accountId), value);
      } catch {
        /* Preserve the blocker. */
      }
      throw unavailable();
    }
    return result;
  }
}
