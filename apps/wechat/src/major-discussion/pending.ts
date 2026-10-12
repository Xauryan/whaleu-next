import { majorId } from '../majors/contract';
import { ClientError } from '../api/errors';
import { exact } from '../community/contract';
import type { Storage } from '../platform/contracts';
import {
  decodeDeleteLocator,
  type DiscussionDeleteLocator,
  decodeDiscussionReceipt,
  decodeDiscussionIntent,
  invalidDiscussion,
  matchDiscussionReceipt,
  type DiscussionReceipt,
  type DiscussionIntent,
} from './operation-contract';
export interface PendingMajorDiscussion {
  readonly version: 1;
  readonly accountId: string;
  readonly origin: string;
  readonly intent: DiscussionIntent;
  readonly phase: 'submit' | 'cancel';
}
const equal = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b);
const unavailable = (): ClientError =>
  new ClientError('storage', 'Major discussion recovery storage unavailable');
export interface DiscussionOwnReference {
  readonly majorId: string;
  readonly commentId: string;
}
export class PendingMajorDiscussionStore {
  private readonly locatorFailures = new Set<string>();
  constructor(
    private readonly storage: Storage,
    readonly origin: string,
  ) {}
  private key(accountId: string, deletion = false): string {
    if (!majorId(accountId)) throw unavailable();
    return deletion
      ? `whaleu.major-discussion-delete.pending.v1:${this.origin}:${accountId}`
      : `whaleu.major-discussion.pending.v1:${this.origin}:${accountId}`;
  }
  private decode(raw: unknown, accountId: string): PendingMajorDiscussion {
    exact(raw, ['version', 'accountId', 'origin', 'intent', 'phase']);
    if (
      raw.version !== 1 ||
      !majorId(accountId) ||
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
  load(accountId: string): PendingMajorDiscussion | null {
    try {
      const legacy = this.storage.get(this.key(accountId));
      const deletion = this.storage.get(this.key(accountId, true));
      const present = (v: unknown) => v !== undefined && v !== null && v !== '';
      if (present(legacy) && present(deletion)) throw unavailable();
      const value = present(deletion) ? deletion : legacy;
      if (present(value)) {
        const decoded = this.decode(value, accountId);
        if (
          (decoded.intent.operation === 'major.discussion.delete.v1') !==
          present(deletion)
        )
          throw unavailable();
      }
      return value === undefined || value === null || value === ''
        ? null
        : this.decode(value, accountId);
    } catch {
      throw unavailable();
    }
  }
  private loadNamespace(
    accountId: string,
    deletion: boolean,
  ): PendingMajorDiscussion | null {
    const raw = this.storage.get(this.key(accountId, deletion));
    if (raw === undefined || raw === null || raw === '') return null;
    const value = this.decode(raw, accountId);
    if ((value.intent.operation === 'major.discussion.delete.v1') !== deletion)
      throw unavailable();
    return value;
  }
  // Receipt recovery is scoped to an existing journal, never admission for a new write.
  loadForRecovery(accountId: string): PendingMajorDiscussion | null {
    try {
      return (
        this.loadNamespace(accountId, false) ??
        this.loadNamespace(accountId, true)
      );
    } catch {
      throw unavailable();
    }
  }
  assertRecoveryOriginal(value: PendingMajorDiscussion): void {
    try {
      if (
        !equal(
          this.loadNamespace(
            value.accountId,
            value.intent.operation === 'major.discussion.delete.v1',
          ),
          value,
        )
      )
        throw unavailable();
    } catch {
      throw unavailable();
    }
  }
  freeze(raw: PendingMajorDiscussion): PendingMajorDiscussion {
    try {
      const value = this.decode(raw, raw.accountId),
        old = this.load(value.accountId);
      if (old && !equal(old, value)) throw unavailable();
      if (!old)
        this.storage.set(
          this.key(
            value.accountId,
            value.intent.operation === 'major.discussion.delete.v1',
          ),
          value,
        );
      this.assertOriginal(value);
      return value;
    } catch {
      throw unavailable();
    }
  }
  assertOriginal(value: PendingMajorDiscussion): void {
    if (!equal(this.load(value.accountId), value)) throw unavailable();
  }
  beginCancellation(value: PendingMajorDiscussion): PendingMajorDiscussion {
    this.assertOriginal(value);
    const cancelled = this.decode(
      { ...value, phase: 'cancel' },
      value.accountId,
    );
    try {
      this.storage.set(
        this.key(
          value.accountId,
          value.intent.operation === 'major.discussion.delete.v1',
        ),
        cancelled,
      );
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
        exact(value, ['majorId', 'commentId']);
        if (!majorId(value.majorId) || !majorId(value.commentId))
          throw unavailable();
        return Object.freeze({
          majorId: value.majorId,
          commentId: value.commentId,
        });
      });
      if (
        new Set(result.map((v) => `${v.majorId}:${v.commentId}`)).size !==
        result.length
      )
        throw unavailable();
      return Object.freeze(result);
    } catch {
      throw unavailable();
    }
  }
  deletionLocators(accountId: string): readonly DiscussionDeleteLocator[] {
    try {
      if (!majorId(accountId)) throw unavailable();
      const raw = this.storage.get(
        `whaleu.major-discussion.own-deletion-locators.v1:${this.origin}:${accountId}`,
      );
      if (raw === undefined || raw === null || raw === '') return [];
      if (!majorId(accountId) || !Array.isArray(raw) || raw.length > 100)
        throw unavailable();
      const refs = raw.map(decodeDeleteLocator);
      if (
        new Set(refs.map((r) => `${r.majorId}:${r.commentId}`)).size !==
        refs.length
      )
        throw unavailable();
      return Object.freeze(refs);
    } catch {
      throw unavailable();
    }
  }
  deletionLocatorState(accountId: string): {
    readonly items: readonly DiscussionDeleteLocator[];
    readonly unavailable: boolean;
  } {
    try {
      const items = this.deletionLocators(accountId);
      return {
        items: this.locatorFailures.has(accountId) ? [] : items,
        unavailable: this.locatorFailures.has(accountId),
      };
    } catch {
      return { items: [], unavailable: true };
    }
  }
  private rememberDeletion(
    value: PendingMajorDiscussion,
    result: DiscussionReceipt,
  ): void {
    if (
      result.outcome === 'rejected' ||
      result.operation === 'major.discussion.like.v1'
    )
      return;
    const ref = {
      majorId: result.majorId,
      commentId: result.commentId,
      rootId:
        result.operation === 'major.discussion.root.v1' ? null : result.rootId,
    };
    const prior = this.deletionLocators(value.accountId).filter(
      (r) => r.majorId !== ref.majorId || r.commentId !== ref.commentId,
    );
    const next =
      result.operation === 'major.discussion.delete.v1'
        ? prior
        : [ref, ...prior].slice(0, 100);
    this.storage.set(
      `whaleu.major-discussion.own-deletion-locators.v1:${this.origin}:${value.accountId}`,
      next,
    );
    if (!equal(this.deletionLocators(value.accountId), next))
      throw unavailable();
  }
  private remember(value: PendingMajorDiscussion): void {
    if (value.intent.operation !== 'major.discussion.like.v1') return;
    const ref = {
      majorId: value.intent.majorId,
      commentId: value.intent.commentId,
    };
    const refs = [
      ref,
      ...this.references(value.accountId).filter(
        (r) => r.majorId !== ref.majorId || r.commentId !== ref.commentId,
      ),
    ].slice(0, 20);
    this.storage.set(`${this.key(value.accountId)}:references`, refs);
    if (!equal(this.references(value.accountId), refs)) throw unavailable();
  }
  settle(
    value: PendingMajorDiscussion,
    raw: DiscussionReceipt,
  ): DiscussionReceipt {
    const result = decodeDiscussionReceipt(raw);
    matchDiscussionReceipt(value.intent, result);
    this.assertRecoveryOriginal(value);
    try {
      // This new convenience index must not change legacy receipt settlement.
      // Strict read-before-write preserves corrupt cache bytes for inspection.
      try {
        this.rememberDeletion(value, result);
        if (
          result.outcome !== 'rejected' &&
          result.operation !== 'major.discussion.like.v1'
        )
          this.locatorFailures.delete(value.accountId);
      } catch {
        this.locatorFailures.add(value.accountId);
      }
      this.remember(value);
      this.storage.remove(
        this.key(
          value.accountId,
          value.intent.operation === 'major.discussion.delete.v1',
        ),
      );
      if (
        this.loadNamespace(
          value.accountId,
          value.intent.operation === 'major.discussion.delete.v1',
        )
      )
        throw unavailable();
    } catch {
      try {
        this.storage.set(
          this.key(
            value.accountId,
            value.intent.operation === 'major.discussion.delete.v1',
          ),
          value,
        );
      } catch {
        /* Preserve the blocker. */
      }
      throw unavailable();
    }
    return result;
  }
}
