import { sha256 } from 'js-sha256';
import { normalizeOrigin } from '../api/origin';
import type { Storage } from '../platform/contracts';
import { exactStudent, studentUuid, invalidStudent } from './student-contract';
export interface PendingStudentCommand {
  actor: string;
  requestId: string;
  requestHash: string;
  applicationId: string | null;
  operation: 'reserve' | 'submit' | 'withdraw' | 'decide';
}
/** One original mutation at a time. No reason, evidence descriptor, path, bytes or facts persist. */
export class StudentCommandJournal {
  private readonly prefix: string;
  constructor(
    readonly storage: Storage,
    origin: string,
  ) {
    this.prefix = `whaleu.student-verification.v1.${sha256(normalizeOrigin(origin))}.`;
  }
  read(actor: string): PendingStudentCommand | null {
    const raw = this.storage.get(this.prefix + studentUuid(actor));
    if (raw == null || raw === '') return null;
    exactStudent(raw, [
      'actor',
      'requestId',
      'requestHash',
      'applicationId',
      'operation',
    ]);
    if (
      raw.actor !== actor ||
      typeof raw.requestHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(raw.requestHash) ||
      !['reserve', 'submit', 'withdraw', 'decide'].includes(
        String(raw.operation),
      )
    )
      invalidStudent();
    return {
      actor: studentUuid(raw.actor),
      requestId: studentUuid(raw.requestId),
      requestHash: raw.requestHash,
      applicationId:
        raw.applicationId === null ? null : studentUuid(raw.applicationId),
      operation: raw.operation as PendingStudentCommand['operation'],
    };
  }
  save(record: PendingStudentCommand) {
    exactStudent(record, [
      'actor',
      'requestId',
      'requestHash',
      'applicationId',
      'operation',
    ]);
    if (this.read(record.actor)) invalidStudent();
    this.storage.set(this.prefix + record.actor, { ...record });
  }
  clear(record: PendingStudentCommand) {
    if (this.read(record.actor)?.requestId === record.requestId)
      this.storage.remove(this.prefix + record.actor);
  }
}
