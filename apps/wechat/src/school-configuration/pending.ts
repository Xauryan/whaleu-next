import type { Storage } from '../platform/contracts';
import { ClientError } from '../api/errors';
import { exact } from '../community/contract';
import {
  schoolUuid,
  schoolKey,
  schoolCommand,
  schoolCommandHash,
  invalidSchool,
} from './contract';
import type { SchoolEntryKey, SchoolCommand, SchoolReceipt } from './contract';
export interface PendingSchoolCommand {
  version: 1;
  actorId: string;
  regionId: string;
  entryKey: SchoolEntryKey;
  requestHash: string;
  command: SchoolCommand;
}
/** One unresolved command per account/environment. It is not a queue and never
 * stores credentials, provider keys, file paths or media bytes. */
export class SchoolCommandJournal {
  constructor(
    private readonly storage: Storage,
    private readonly namespace: string,
  ) {}
  private key(actor: string) {
    return `whaleu.school-configuration.v1:${this.namespace}:${schoolUuid(actor)}`;
  }
  read(actorId: string): PendingSchoolCommand | null {
    try {
      const raw = this.storage.get(this.key(actorId));
      if (raw === undefined || raw === null || raw === '') return null;
      exact(raw, [
        'version',
        'actorId',
        'regionId',
        'entryKey',
        'requestHash',
        'command',
      ]);
      if (raw.version !== 1 || raw.actorId !== actorId) invalidSchool();
      const regionId = schoolUuid(raw.regionId),
        entryKey = schoolKey(raw.entryKey),
        command = schoolCommand(raw.command, entryKey);
      const hash = schoolCommandHash(actorId, regionId, entryKey, command);
      if (raw.requestHash !== hash) invalidSchool();
      return {
        version: 1,
        actorId,
        regionId,
        entryKey,
        requestHash: hash,
        command,
      };
    } catch {
      throw new ClientError(
        'storage',
        'The pending school command cannot be recovered safely',
      );
    }
  }
  write(
    actorId: string,
    regionId: string,
    entryKey: SchoolEntryKey,
    command: SchoolCommand,
  ): PendingSchoolCommand {
    const value: PendingSchoolCommand = {
      version: 1,
      actorId,
      regionId,
      entryKey,
      command: schoolCommand(command, entryKey),
      requestHash: schoolCommandHash(actorId, regionId, entryKey, command),
    };
    const previous = this.read(actorId);
    if (previous && previous.requestHash !== value.requestHash)
      throw new ClientError(
        'storage',
        'Resolve the pending school command first',
      );
    try {
      this.storage.set(this.key(actorId), value);
      const verified = this.read(actorId);
      if (verified?.requestHash !== value.requestHash)
        throw new Error('Storage mismatch');
      return value;
    } catch {
      throw new ClientError(
        'storage',
        'The school command could not be stored',
      );
    }
  }
  settle(pending: PendingSchoolCommand, receipt: SchoolReceipt) {
    if (
      receipt.requestHash !== pending.requestHash ||
      receipt.requestId !== pending.command.clientRequestId ||
      receipt.entryKey !== pending.entryKey ||
      receipt.regionId !== pending.regionId ||
      receipt.revision !== pending.command.expectedRevision + 1
    )
      invalidSchool();
    this.discard(pending);
  }
  discard(pending: PendingSchoolCommand) {
    const current = this.read(pending.actorId);
    if (current?.requestHash !== pending.requestHash)
      throw new ClientError('storage', 'The pending school command changed');
    try {
      this.storage.remove(this.key(pending.actorId));
      if (this.read(pending.actorId) !== null)
        throw new Error('Storage mismatch');
    } catch {
      throw new ClientError(
        'storage',
        'The school command is retained for recovery',
      );
    }
  }
}
