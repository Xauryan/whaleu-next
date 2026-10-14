import { ClientError } from '../api/errors';
import { exact } from '../community/contract';
import type { Storage } from '../platform/contracts';
import {
  decodeInstitutionalCommand,
  decodeInstitutionalReceipt,
  institutionalActorScope,
  institutionalCommandHash,
  institutionalTerminal,
  matchInstitutionalReceipt,
  type InstitutionalCommand,
  type InstitutionalReceipt,
} from './institutional-contract';
export const institutionalPhases = [
  'prepare_unstarted',
  'prepared_unstarted',
  'authorize_pending',
  'submit_pending',
  'recover_started',
  'cancel',
] as const;
export type InstitutionalPhase = (typeof institutionalPhases)[number];
export interface PendingInstitutional {
  readonly version: 1;
  readonly accountId: string;
  readonly origin: string;
  readonly requestHash: string;
  readonly phase: InstitutionalPhase;
  readonly command: InstitutionalCommand;
}
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const fail = () =>
  new ClientError('storage', 'Institutional recovery storage unavailable');
/** Only frozen correlation/context, never handoff material or verification facts. */
export class PendingInstitutionalStore {
  constructor(
    private readonly storage: Storage,
    readonly origin: string,
  ) {}
  private key(account: string) {
    return `whaleu.institutional-sso.pending.v1:${this.origin}:${institutionalActorScope(account)}`;
  }
  private stored(value: PendingInstitutional) {
    return Object.freeze({
      version: 1,
      actorScope: institutionalActorScope(value.accountId),
      origin: value.origin,
      requestHash: value.requestHash,
      phase: value.phase,
      command: value.command,
    });
  }
  private decode(raw: unknown, account: string): PendingInstitutional {
    exact(raw, [
      'version',
      'actorScope',
      'origin',
      'requestHash',
      'phase',
      'command',
    ]);
    const command = decodeInstitutionalCommand(raw.command);
    if (
      raw.version !== 1 ||
      raw.actorScope !== institutionalActorScope(account) ||
      raw.origin !== this.origin ||
      raw.requestHash !== institutionalCommandHash(account, command) ||
      !(institutionalPhases as readonly unknown[]).includes(raw.phase)
    )
      throw fail();
    return Object.freeze({
      version: 1,
      accountId: account,
      origin: this.origin,
      requestHash: raw.requestHash as string,
      phase: raw.phase as InstitutionalPhase,
      command,
    });
  }
  load(account: string): PendingInstitutional | null {
    try {
      const raw = this.storage.get(this.key(account));
      return raw === undefined || raw === null || raw === ''
        ? null
        : this.decode(raw, account);
    } catch {
      throw fail();
    }
  }
  assertOriginal(value: PendingInstitutional): void {
    if (!same(this.load(value.accountId), value)) throw fail();
  }
  freeze(account: string, input: InstitutionalCommand): PendingInstitutional {
    try {
      const command = decodeInstitutionalCommand(input);
      const value: PendingInstitutional = Object.freeze({
        version: 1,
        accountId: account,
        origin: this.origin,
        requestHash: institutionalCommandHash(account, command),
        phase: 'prepare_unstarted',
        command,
      });
      const old = this.load(account);
      if (old && !same(old, value)) throw fail();
      if (!old) this.storage.set(this.key(account), this.stored(value));
      this.assertOriginal(value);
      return value;
    } catch {
      throw fail();
    }
  }
  advance(
    value: PendingInstitutional,
    phase: InstitutionalPhase,
  ): PendingInstitutional {
    try {
      this.assertOriginal(value);
      if (
        institutionalPhases.indexOf(phase) <
        institutionalPhases.indexOf(value.phase)
      )
        throw fail();
      const next = Object.freeze({ ...value, phase });
      this.storage.set(this.key(value.accountId), this.stored(next));
      this.assertOriginal(next);
      return next;
    } catch {
      throw fail();
    }
  }
  settle(
    value: PendingInstitutional,
    raw: InstitutionalReceipt,
  ): InstitutionalReceipt {
    const receipt = decodeInstitutionalReceipt(raw);
    matchInstitutionalReceipt(value.command, value.requestHash, receipt);
    if (!institutionalTerminal(receipt)) throw fail();
    this.assertOriginal(value);
    try {
      this.storage.remove(this.key(value.accountId));
      if (this.load(value.accountId)) throw fail();
    } catch {
      try {
        this.storage.set(this.key(value.accountId), this.stored(value));
      } catch {
        /* Retain the in-memory barrier as well. */
      }
      throw fail();
    }
    return receipt;
  }
}
