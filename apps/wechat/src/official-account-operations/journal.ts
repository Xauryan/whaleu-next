import type { Storage } from '../platform/contracts';
import { ClientError } from '../api/errors';
import { normalizeOrigin } from '../api/origin';
import {
  object,
  uuid,
  decodeCommand,
  commandHash,
  invalid,
  terminal,
} from './contracts';
import type {
  Command,
  Operation,
  Result,
  CancellationTombstone,
} from './contracts';
export interface PendingOfficialCommand {
  version: 1;
  actorId: string;
  origin: string;
  operation: Operation;
  command: Command;
  intentHash: string;
}
/** Full immutable original intent only. No preview bodies, bearer, media bytes or provider IDs. */
export class OfficialCommandJournal {
  readonly origin: string;
  constructor(
    private readonly storage: Storage,
    origin: string,
  ) {
    this.origin = normalizeOrigin(origin);
  }
  private key(actor: string) {
    return `whaleu.official-account.v1:${this.origin}:${uuid(actor)}`;
  }
  read(actorId: string): PendingOfficialCommand | null {
    try {
      const raw = this.storage.get(this.key(actorId));
      if (raw === undefined || raw === null || raw === '') return null;
      const v = object(raw, [
        'version',
        'actorId',
        'origin',
        'operation',
        'command',
        'intentHash',
      ]);
      if (
        v.version !== 1 ||
        v.actorId !== actorId ||
        v.origin !== this.origin ||
        (v.operation !== 'config_save' && v.operation !== 'test_draft')
      )
        invalid();
      const command = decodeCommand(v.command, v.operation),
        intentHash = commandHash(command);
      if (v.intentHash !== intentHash) invalid();
      return {
        version: 1,
        actorId,
        origin: this.origin,
        operation: v.operation,
        command,
        intentHash,
      };
    } catch {
      throw new ClientError('storage', '原请求记录无法安全读取，请勿重新提交');
    }
  }
  write(
    actorId: string,
    operation: Operation,
    command: Command,
  ): PendingOfficialCommand {
    const checked = decodeCommand(command, operation),
      intentHash = commandHash(checked);
    const value: PendingOfficialCommand = {
      version: 1,
      actorId: uuid(actorId),
      origin: this.origin,
      operation,
      command: checked,
      intentHash,
    };
    const previous = this.read(actorId);
    if (
      previous &&
      (previous.intentHash !== intentHash || previous.operation !== operation)
    )
      throw new ClientError('storage', '请先恢复原请求');
    try {
      this.storage.set(this.key(actorId), value);
      const actual = this.read(actorId);
      if (JSON.stringify(actual) !== JSON.stringify(value)) throw new Error();
      return actual!;
    } catch {
      throw new ClientError('storage', '原请求未能可靠保存，未发送');
    }
  }
  settleCancellation(
    pending: PendingOfficialCommand,
    result: CancellationTombstone,
  ) {
    if (
      result.requestId !== pending.command.requestId ||
      result.intentHash !== pending.intentHash
    )
      invalid();
    const current = this.read(pending.actorId);
    if (
      current?.intentHash !== pending.intentHash ||
      current.operation !== pending.operation
    )
      invalid();
    this.storage.remove(this.key(pending.actorId));
    if (this.read(pending.actorId) !== null)
      throw new ClientError('storage', '原请求记录仍保留，请恢复查询');
  }
  settle(pending: PendingOfficialCommand, result: Result) {
    if (
      result.receipt.requestId !== pending.command.requestId ||
      result.receipt.intentHash !== pending.intentHash ||
      result.receipt.operation !== pending.operation ||
      result.receipt.programId !== pending.command.programId
    )
      invalid();
    if (!terminal(result.status)) return;
    const current = this.read(pending.actorId);
    if (
      current?.intentHash !== pending.intentHash ||
      current.operation !== pending.operation
    )
      invalid();
    this.storage.remove(this.key(pending.actorId));
    if (this.read(pending.actorId) !== null)
      throw new ClientError('storage', '原请求记录仍保留，请恢复查询');
  }
}
