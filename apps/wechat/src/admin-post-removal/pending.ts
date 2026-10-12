import { isUuid } from '../profile/contract';
import { ClientError } from '../api/errors';
import { exact } from '../community/contract';
import type { Storage } from '../platform/contracts';
import {
  decodeAdminPostRemovalCommand,
  adminPostRemovalCommandHash,
  decodeAdminPostRemovalReceipt,
  matchAdminPostRemovalReceipt,
} from './contract';
import type {
  AdminPostRemovalCommand,
  AdminPostRemovalReceipt,
} from './contract';
export interface PendingAdminPostRemoval {
  readonly version: 1;
  readonly requestHash: string;
  readonly accountId: string;
  readonly origin: string;
  readonly phase: 'submit' | 'cancel';
  readonly command: AdminPostRemovalCommand;
}
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const fail = () =>
  new ClientError('storage', 'Admin post removal recovery storage unavailable');
export class PendingAdminPostRemovalStore {
  constructor(
    private readonly storage: Storage,
    readonly origin: string,
  ) {}
  private key(account: string) {
    if (!isUuid(account)) throw fail();
    return `whaleu.admin-post-removal.pending.v1:${this.origin}:${account}`;
  }
  private decode(raw: unknown, account: string): PendingAdminPostRemoval {
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
        adminPostRemovalCommandHash(
          account,
          decodeAdminPostRemovalCommand(raw.command),
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
      command: decodeAdminPostRemovalCommand(raw.command),
    });
  }
  load(account: string): PendingAdminPostRemoval | null {
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
    value: Omit<PendingAdminPostRemoval, 'requestHash'>,
  ): PendingAdminPostRemoval {
    try {
      const next = this.decode(
          {
            ...value,
            requestHash: adminPostRemovalCommandHash(
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
  assertOriginal(value: PendingAdminPostRemoval) {
    if (!same(this.load(value.accountId), value)) throw fail();
  }
  cancel(value: PendingAdminPostRemoval): PendingAdminPostRemoval {
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
    value: PendingAdminPostRemoval,
    raw: AdminPostRemovalReceipt,
  ): AdminPostRemovalReceipt {
    const receipt = decodeAdminPostRemovalReceipt(raw);
    matchAdminPostRemovalReceipt(value.command, receipt);
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
