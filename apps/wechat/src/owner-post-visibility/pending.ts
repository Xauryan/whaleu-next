import { isUuid } from '../profile/contract';
import { ClientError } from '../api/errors';
import { exact } from '../community/contract';
import type { Storage } from '../platform/contracts';
import {
  decodeOwnerVisibilityCommand,
  decodeOwnerVisibilityReceipt,
  matchOwnerVisibilityReceipt,
} from './contract';
import type {
  OwnerVisibilityCommand,
  OwnerVisibilityReceipt,
} from './contract';
export interface PendingOwnerVisibility {
  version: 1;
  accountId: string;
  origin: string;
  phase: 'submit' | 'cancel';
  command: OwnerVisibilityCommand;
}
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const fail = () =>
  new ClientError('storage', 'Owner visibility recovery storage unavailable');
export class PendingOwnerPostVisibilityStore {
  constructor(
    private readonly storage: Storage,
    readonly origin: string,
  ) {}
  private key(account: string) {
    if (!isUuid(account)) throw fail();
    return `whaleu.owner-post-visibility.pending.v1:${this.origin}:${account}`;
  }
  private decode(raw: unknown, account: string): PendingOwnerVisibility {
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
      command: decodeOwnerVisibilityCommand(raw.command),
    });
  }
  load(account: string): PendingOwnerVisibility | null {
    try {
      const raw = this.storage.get(this.key(account));
      return raw === undefined || raw === null || raw === ''
        ? null
        : this.decode(raw, account);
    } catch {
      throw fail();
    }
  }
  freeze(value: PendingOwnerVisibility): PendingOwnerVisibility {
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
  assertOriginal(value: PendingOwnerVisibility) {
    if (!same(this.load(value.accountId), value)) throw fail();
  }
  cancel(value: PendingOwnerVisibility): PendingOwnerVisibility {
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
    value: PendingOwnerVisibility,
    raw: OwnerVisibilityReceipt,
  ): OwnerVisibilityReceipt {
    const receipt = decodeOwnerVisibilityReceipt(raw);
    matchOwnerVisibilityReceipt(value.command, receipt);
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
