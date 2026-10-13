import { isUuid } from '../profile/contract';
import { ClientError } from '../api/errors';
import { exact } from '../community/contract';
import type { Storage } from '../platform/contracts';
import {
  decodeAdminDiscussionRemovalCommand,
  adminDiscussionRemovalCommandHash,
  decodeAdminDiscussionRemovalReceipt,
  matchAdminDiscussionRemovalReceipt,
} from './contract';
import type {
  AdminDiscussionRemovalCommand,
  AdminDiscussionRemovalReceipt,
} from './contract';
export interface PendingAdminDiscussionRemoval {
  readonly version: 1;
  readonly requestHash: string;
  readonly accountId: string;
  readonly origin: string;
  readonly phase: 'submit' | 'cancel';
  readonly command: AdminDiscussionRemovalCommand;
}
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const fail = () =>
  new ClientError(
    'storage',
    'Admin discussion removal recovery storage unavailable',
  );
export class PendingAdminDiscussionRemovalStore {
  constructor(
    private readonly storage: Storage,
    readonly origin: string,
  ) {}
  private key(account: string) {
    if (!isUuid(account)) throw fail();
    return `whaleu.admin-discussion-removal.pending.v1:${this.origin}:${account}`;
  }
  private decode(raw: unknown, account: string): PendingAdminDiscussionRemoval {
    exact(raw, [
      'version',
      'accountId',
      'origin',
      'phase',
      'command',
      'requestHash',
    ]);
    if (
      raw.version !== 1 ||
      raw.accountId !== account ||
      raw.origin !== this.origin ||
      raw.requestHash !==
        adminDiscussionRemovalCommandHash(
          account,
          decodeAdminDiscussionRemovalCommand(raw.command),
        ) ||
      (raw.phase !== 'submit' && raw.phase !== 'cancel')
    )
      throw fail();
    return Object.freeze({
      version: 1,
      requestHash: raw.requestHash as string,
      accountId: account,
      origin: this.origin,
      phase: raw.phase,
      command: decodeAdminDiscussionRemovalCommand(raw.command),
    });
  }
  load(account: string): PendingAdminDiscussionRemoval | null {
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
    value: Omit<PendingAdminDiscussionRemoval, 'requestHash'>,
  ): PendingAdminDiscussionRemoval {
    try {
      const next = this.decode(
          {
            ...value,
            requestHash: adminDiscussionRemovalCommandHash(
              value.accountId,
              value.command,
            ),
          },
          value.accountId,
        ),
        old = this.load(next.accountId);
      if (old && !same(old, next)) throw fail();
      if (!old) this.storage.set(this.key(next.accountId), next);
      this.assertOriginal(next);
      return next;
    } catch {
      throw fail();
    }
  }
  assertOriginal(value: PendingAdminDiscussionRemoval) {
    if (!same(this.load(value.accountId), value)) throw fail();
  }
  cancel(value: PendingAdminDiscussionRemoval): PendingAdminDiscussionRemoval {
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
    value: PendingAdminDiscussionRemoval,
    raw: AdminDiscussionRemovalReceipt,
  ): AdminDiscussionRemovalReceipt {
    const receipt = decodeAdminDiscussionRemovalReceipt(raw);
    matchAdminDiscussionRemovalReceipt(value.command, receipt);
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
