import { isUuid } from '../profile/contract';
import { ClientError } from '../api/errors';
import { exact, uuid4 } from '../community/contract';
import type { Storage } from '../platform/contracts';
import {
  decodePinCommand,
  decodePinReceipt,
  matchPinReceipt,
} from './contract';
import type { PinCommand, PinReceipt } from './contract';
export interface PendingPin {
  version: 1;
  accountId: string;
  origin: string;
  phase: 'submit' | 'cancel';
  command: PinCommand;
}
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const fail = () =>
  new ClientError('storage', 'Post pin recovery storage unavailable');
export class PendingPostPinStore {
  constructor(
    private readonly storage: Storage,
    readonly origin: string,
  ) {}
  private key(account: string) {
    if (!isUuid(account)) throw fail();
    return `whaleu.post-pins.pending.v1:${this.origin}:${account}`;
  }
  private decode(raw: unknown, account: string): PendingPin {
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
      command: decodePinCommand(raw.command),
    });
  }
  load(account: string): PendingPin | null {
    try {
      const raw = this.storage.get(this.key(account));
      return raw === undefined || raw === null || raw === ''
        ? null
        : this.decode(raw, account);
    } catch {
      throw fail();
    }
  }
  freeze(value: PendingPin): PendingPin {
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
  assertOriginal(value: PendingPin) {
    if (!same(this.load(value.accountId), value)) throw fail();
  }
  cancel(value: PendingPin): PendingPin {
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
  settle(value: PendingPin, raw: PinReceipt): PinReceipt {
    const receipt = decodePinReceipt(raw);
    matchPinReceipt(value.command, receipt);
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
  dismissed(account: string | null, pinId: string): boolean {
    if (!uuid4(pinId)) throw fail();
    try {
      const raw = this.storage.get(
        `whaleu.post-pins.dismissed.v1:${this.origin}:${account ?? 'guest'}:${pinId}`,
      );
      if (raw !== undefined && raw !== null && raw !== '' && raw !== true)
        throw fail();
      return raw === true;
    } catch {
      throw fail();
    }
  }
  dismiss(account: string | null, pinId: string): void {
    if (!uuid4(pinId)) throw fail();
    try {
      this.storage.set(
        `whaleu.post-pins.dismissed.v1:${this.origin}:${account ?? 'guest'}:${pinId}`,
        true,
      );
      if (!this.dismissed(account, pinId)) throw fail();
    } catch {
      throw fail();
    }
  }
}
