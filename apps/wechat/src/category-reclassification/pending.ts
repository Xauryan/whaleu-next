import { isUuid } from '../profile/contract';
import { ClientError } from '../api/errors';
import { exact } from '../community/contract';
import type { Storage } from '../platform/contracts';
import {
  decodeReclassificationCommand,
  decodeReclassificationReceipt,
  matchReclassificationReceipt,
} from './contract';
import type {
  ReclassificationCommand,
  ReclassificationReceipt,
} from './contract';
export interface PendingCategoryReclassification {
  readonly version: 1;
  readonly accountId: string;
  readonly origin: string;
  readonly phase: 'submit' | 'cancel';
  readonly command: ReclassificationCommand;
}
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const fail = () =>
  new ClientError(
    'storage',
    'Category reclassification recovery storage unavailable',
  );
export class PendingCategoryReclassificationStore {
  constructor(
    private readonly storage: Storage,
    readonly origin: string,
  ) {}
  private key(account: string) {
    if (!isUuid(account)) throw fail();
    return `whaleu.category-reclassification.pending.v1:${this.origin}:${account}`;
  }
  private decode(
    raw: unknown,
    account: string,
  ): PendingCategoryReclassification {
    exact(raw, ['version', 'accountId', 'origin', 'phase', 'command']);
    if (
      raw.version !== 1 ||
      raw.accountId !== account ||
      raw.origin !== this.origin ||
      (raw.phase !== 'submit' && raw.phase !== 'cancel')
    )
      throw fail();
    return Object.freeze({
      version: 1,
      accountId: account,
      origin: this.origin,
      phase: raw.phase,
      command: decodeReclassificationCommand(raw.command),
    });
  }
  load(account: string): PendingCategoryReclassification | null {
    try {
      const raw = this.storage.get(this.key(account));
      return raw === undefined || raw === null || raw === ''
        ? null
        : this.decode(raw, account);
    } catch {
      throw fail();
    }
  }
  freeze(
    value: PendingCategoryReclassification,
  ): PendingCategoryReclassification {
    try {
      const next = this.decode(value, value.accountId),
        old = this.load(next.accountId);
      if (old && !same(old, next)) throw fail();
      if (!old) this.storage.set(this.key(next.accountId), next);
      this.assertOriginal(next);
      return next;
    } catch {
      throw fail();
    }
  }
  assertOriginal(value: PendingCategoryReclassification) {
    if (!same(this.load(value.accountId), value)) throw fail();
  }
  cancel(
    value: PendingCategoryReclassification,
  ): PendingCategoryReclassification {
    this.assertOriginal(value);
    const next = this.decode({ ...value, phase: 'cancel' }, value.accountId);
    try {
      this.storage.set(this.key(value.accountId), next);
      this.assertOriginal(next);
      return next;
    } catch {
      throw fail();
    }
  }
  settle(
    value: PendingCategoryReclassification,
    raw: ReclassificationReceipt,
  ): ReclassificationReceipt {
    const receipt = decodeReclassificationReceipt(raw);
    matchReclassificationReceipt(value.command, receipt);
    this.assertOriginal(value);
    try {
      this.storage.remove(this.key(value.accountId));
      if (this.load(value.accountId)) throw fail();
    } catch {
      try {
        this.storage.set(this.key(value.accountId), value);
      } catch {
        /* Remain blocked. */
      }
      throw fail();
    }
    return receipt;
  }
}
