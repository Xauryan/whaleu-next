import { isUuid } from '../profile/contract';
import { ClientError } from '../api/errors';
import { exact } from '../community/contract';
import type { Storage } from '../platform/contracts';
import {
  decodeProfileAvatarModerationCommand,
  profileAvatarModerationCommandHash,
  decodeProfileAvatarModerationReceipt,
  matchProfileAvatarModerationReceipt,
} from './contract';
import type {
  ProfileAvatarModerationCommand,
  ProfileAvatarModerationReceipt,
} from './contract';
export interface PendingProfileAvatarModeration {
  readonly version: 1;
  readonly requestHash: string;
  readonly accountId: string;
  readonly origin: string;
  readonly phase: 'submit' | 'cancel';
  readonly command: ProfileAvatarModerationCommand;
}
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const fail = () =>
  new ClientError(
    'storage',
    'Profile avatar moderation recovery storage unavailable',
  );
export class PendingProfileAvatarModerationStore {
  constructor(
    private readonly storage: Storage,
    readonly origin: string,
  ) {}
  private key(account: string) {
    if (!isUuid(account)) throw fail();
    return `whaleu.profile-avatar-moderation.pending.v1:${this.origin}:${account}`;
  }
  private decode(
    raw: unknown,
    account: string,
  ): PendingProfileAvatarModeration {
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
        profileAvatarModerationCommandHash(
          account,
          decodeProfileAvatarModerationCommand(raw.command),
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
      command: decodeProfileAvatarModerationCommand(raw.command),
    });
  }
  load(account: string): PendingProfileAvatarModeration | null {
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
    value: Omit<PendingProfileAvatarModeration, 'requestHash'>,
  ): PendingProfileAvatarModeration {
    try {
      const next = this.decode(
          {
            ...value,
            requestHash: profileAvatarModerationCommandHash(
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
  assertOriginal(value: PendingProfileAvatarModeration) {
    if (!same(this.load(value.accountId), value)) throw fail();
  }
  cancel(
    value: PendingProfileAvatarModeration,
  ): PendingProfileAvatarModeration {
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
    value: PendingProfileAvatarModeration,
    raw: ProfileAvatarModerationReceipt,
  ): ProfileAvatarModerationReceipt {
    const receipt = decodeProfileAvatarModerationReceipt(raw);
    matchProfileAvatarModerationReceipt(value.command, receipt);
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
