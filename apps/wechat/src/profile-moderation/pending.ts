import { isUuid } from '../profile/contract';
import { ClientError } from '../api/errors';
import { exact } from '../community/contract';
import type { Storage } from '../platform/contracts';
import {
  decodeProfileModerationCommand,
  decodeProfileModerationReceipt,
  matchProfileModerationReceipt,
} from './contract';
import type {
  ProfileModerationCommand,
  ProfileModerationReceipt,
} from './contract';
export interface PendingProfileModeration {
  readonly version: 1;
  readonly accountId: string;
  readonly origin: string;
  readonly phase: 'submit' | 'cancel';
  readonly command: ProfileModerationCommand;
}
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const fail = () =>
  new ClientError('storage', 'Profile moderation recovery storage unavailable');
export class PendingProfileModerationStore {
  constructor(
    private readonly storage: Storage,
    readonly origin: string,
  ) {}
  private key(account: string) {
    if (!isUuid(account)) throw fail();
    return `whaleu.profile-moderation.pending.v1:${this.origin}:${account}`;
  }
  private decode(raw: unknown, account: string): PendingProfileModeration {
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
      command: decodeProfileModerationCommand(raw.command),
    });
  }
  load(account: string): PendingProfileModeration | null {
    try {
      const raw = this.storage.get(this.key(account));
      return raw === undefined || raw === null || raw === ''
        ? null
        : this.decode(raw, account);
    } catch {
      throw fail();
    }
  }
  freeze(value: PendingProfileModeration): PendingProfileModeration {
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
  assertOriginal(value: PendingProfileModeration) {
    if (!same(this.load(value.accountId), value)) throw fail();
  }
  cancel(value: PendingProfileModeration): PendingProfileModeration {
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
    value: PendingProfileModeration,
    raw: ProfileModerationReceipt,
  ): ProfileModerationReceipt {
    const receipt = decodeProfileModerationReceipt(raw);
    matchProfileModerationReceipt(value.command, receipt);
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
