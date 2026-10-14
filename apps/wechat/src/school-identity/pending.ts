import { isUuid } from '../profile/contract';
import { ClientError } from '../api/errors';
import { exact } from '../community/contract';
import type { Storage } from '../platform/contracts';
import {
  decodeSchoolIdentityCommand,
  schoolIdentityJournalHash,
  schoolIdentityActorScope,
  decodeSchoolIdentityReceipt,
  matchSchoolIdentityReceipt,
} from './contract';
import type { SchoolIdentityCommand, SchoolIdentityReceipt } from './contract';
export interface PendingSchoolIdentity {
  readonly version: 1;
  readonly requestHash: string;
  readonly accountId: string;
  readonly origin: string;
  readonly phase: 'submit' | 'cancel';
  readonly command: SchoolIdentityCommand;
}
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const fail = () =>
  new ClientError('storage', 'School identity recovery storage unavailable');
export class PendingSchoolIdentityStore {
  constructor(
    private readonly storage: Storage,
    readonly origin: string,
  ) {}
  private key(account: string) {
    if (!isUuid(account)) throw fail();
    return `whaleu.school-identity.pending.v1:${this.origin}:${schoolIdentityActorScope(account)}`;
  }
  private decode(raw: unknown, account: string): PendingSchoolIdentity {
    exact(raw, [
      'version',
      'actorScope',
      'origin',
      'phase',
      'command',
      'requestHash',
    ]);
    if (
      raw.version !== 1 ||
      raw.actorScope !== schoolIdentityActorScope(account) ||
      raw.origin !== this.origin ||
      raw.requestHash !==
        schoolIdentityJournalHash(
          account,
          decodeSchoolIdentityCommand(raw.command),
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
      command: decodeSchoolIdentityCommand(raw.command),
    });
  }
  load(account: string): PendingSchoolIdentity | null {
    try {
      const raw = this.storage.get(this.key(account));
      return raw === undefined || raw === null || raw === ''
        ? null
        : this.decode(raw, account);
    } catch {
      throw fail();
    }
  }
  private stored(value: PendingSchoolIdentity) {
    return Object.freeze({
      version: value.version,
      actorScope: schoolIdentityActorScope(value.accountId),
      origin: value.origin,
      phase: value.phase,
      command: value.command,
      requestHash: value.requestHash,
    });
  }
  freeze(
    value: Omit<PendingSchoolIdentity, 'requestHash'>,
  ): PendingSchoolIdentity {
    try {
      exact(value, ['version', 'accountId', 'origin', 'phase', 'command']);
      const next = this.decode(
          this.stored({
            ...value,
            requestHash: schoolIdentityJournalHash(
              value.accountId,
              value.command,
            ),
          }),
          value.accountId,
        ),
        old = this.load(value.accountId);
      if (old && !same(old, next)) throw fail();
      if (!old) this.storage.set(this.key(next.accountId), this.stored(next));
      this.assertOriginal(next);
      return next;
    } catch {
      throw fail();
    }
  }
  assertOriginal(value: PendingSchoolIdentity) {
    if (!same(this.load(value.accountId), value)) throw fail();
  }
  cancel(value: PendingSchoolIdentity): PendingSchoolIdentity {
    this.assertOriginal(value);
    const next = this.decode(
      { ...this.stored(value), phase: 'cancel' },
      value.accountId,
    );
    try {
      this.storage.set(this.key(value.accountId), this.stored(next));
      this.assertOriginal(next);
      return next;
    } catch {
      throw fail();
    }
  }
  settle(
    value: PendingSchoolIdentity,
    raw: SchoolIdentityReceipt,
  ): SchoolIdentityReceipt {
    const receipt = decodeSchoolIdentityReceipt(raw);
    matchSchoolIdentityReceipt(value.command, receipt);
    this.assertOriginal(value);
    try {
      this.storage.remove(this.key(value.accountId));
      if (this.load(value.accountId)) throw fail();
    } catch {
      try {
        this.storage.set(this.key(value.accountId), this.stored(value));
      } catch {
        /* Remain blocked. */
      }
      throw fail();
    }
    return receipt;
  }
}
