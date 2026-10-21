import { ClientError } from '../api/errors';
import { normalizeOrigin } from '../api/origin';
import type { Storage } from '../platform/contracts';
import {
  object,
  uuid,
  decodeCommand,
  commandHash,
  matchReceipt,
  invalid,
} from './contracts';
import type { Command, Receipt } from './contracts';
export interface Pending {
  version: 1;
  actorId: string;
  origin: string;
  command: Command;
  intentHash: string;
  phase: 'send' | 'cancel';
}
function frozen(command: Command): Command {
  const copy = decodeCommand(command);
  if ('weeks' in copy.payload) Object.freeze(copy.payload.weeks);
  Object.freeze(copy.payload);
  return Object.freeze(copy);
}
/** One unresolved original per account/origin. Never remove on hide/logout or unknown outcome. */
export class TimetableJournal {
  readonly origin: string;
  constructor(
    private readonly storage: Storage,
    origin: string,
  ) {
    this.origin = normalizeOrigin(origin);
  }
  private key(actor: string) {
    return `whaleu.personal-timetable.v1:${this.origin}:${uuid(actor)}`;
  }
  read(actorId: string): Pending | null {
    try {
      const raw = this.storage.get(this.key(actorId));
      if (raw === undefined || raw === null || raw === '') return null;
      const value = object(raw, [
        'version',
        'actorId',
        'origin',
        'command',
        'intentHash',
        'phase',
      ]);
      if (
        value.version !== 1 ||
        value.actorId !== actorId ||
        value.origin !== this.origin ||
        !['send', 'cancel'].includes(String(value.phase))
      )
        invalid();
      const command = frozen(decodeCommand(value.command)),
        intentHash = commandHash(command);
      if (value.intentHash !== intentHash) invalid();
      return Object.freeze({
        version: 1,
        actorId,
        origin: this.origin,
        command,
        intentHash,
        phase: value.phase as 'send' | 'cancel',
      });
    } catch {
      throw new ClientError('storage', '原请求记录无法安全读取，请勿重新提交');
    }
  }
  write(
    actorId: string,
    command: Command,
    phase: 'send' | 'cancel' = 'send',
  ): Pending {
    const previous = this.read(actorId),
      checked = frozen(command),
      intentHash = commandHash(checked);
    if (
      previous &&
      (previous.intentHash !== intentHash ||
        previous.command.requestId !== checked.requestId ||
        (previous.phase === 'cancel' && phase !== 'cancel'))
    )
      throw new ClientError('storage', '请先处理原请求');
    const value: Pending = {
      version: 1,
      actorId: uuid(actorId),
      origin: this.origin,
      command: checked,
      intentHash,
      phase,
    };
    try {
      this.storage.set(this.key(actorId), value);
      const actual = this.read(actorId);
      if (JSON.stringify(actual) !== JSON.stringify(value)) throw new Error();
      return actual!;
    } catch {
      throw new ClientError('storage', '原请求未能可靠保存，未发送');
    }
  }
  settle(pending: Pending, receipt: Receipt): void {
    matchReceipt(pending.command, receipt);
    const actual = this.read(pending.actorId);
    if (
      actual?.intentHash !== pending.intentHash ||
      actual.command.requestId !== pending.command.requestId
    )
      invalid();
    try {
      this.storage.remove(this.key(pending.actorId));
      if (this.read(pending.actorId) !== null) throw new Error();
    } catch {
      throw new ClientError(
        'storage',
        '已查到结果，但原请求记录未能清除，请再次恢复',
      );
    }
  }
}
