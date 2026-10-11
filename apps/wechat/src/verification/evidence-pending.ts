import { sha256 } from 'js-sha256';
import { ClientError } from '../api/errors';
import { normalizeOrigin } from '../api/origin';
import { exact } from '../community/contract';
import type { Storage } from '../platform/contracts';
import {
  verificationEvidenceUuid,
  verificationEvidenceRevision,
} from './evidence-validation';
/** No file declaration/hash, bytes, URL, selected path, name, student number or
 * token is persisted. requestHash is only the opaque original request identity. */
export interface PendingVerificationEvidence {
  readonly actor: string;
  readonly applicationId: string;
  readonly revision: number;
  readonly requestId: string;
  readonly requestHash: string;
}
export class VerificationEvidencePending {
  private readonly prefix: string;
  constructor(
    private readonly storage: Storage,
    origin: string,
  ) {
    this.prefix = `whaleu.verification-evidence.v1.${sha256(normalizeOrigin(origin))}.`;
  }
  readAll(actor: string): PendingVerificationEvidence[] {
    const raw = this.storage.get(this.prefix + verificationEvidenceUuid(actor));
    if (raw === null || raw === undefined || raw === '') return [];
    if (!Array.isArray(raw) || raw.length > 20)
      throw new ClientError('storage', '认证材料恢复记录损坏');
    const seen = new Set<string>();
    return raw.map((entry: unknown) => {
      exact(entry, [
        'actor',
        'applicationId',
        'revision',
        'requestId',
        'requestHash',
      ]);
      if (
        entry.actor !== actor ||
        typeof entry.requestHash !== 'string' ||
        !/^[a-f0-9]{64}$/.test(entry.requestHash)
      )
        throw new ClientError('storage', '认证材料恢复记录损坏');
      const record = {
        actor,
        applicationId: verificationEvidenceUuid(entry.applicationId),
        revision: verificationEvidenceRevision(entry.revision),
        requestId: verificationEvidenceUuid(entry.requestId),
        requestHash: entry.requestHash,
      };
      if (seen.has(record.requestId))
        throw new ClientError('storage', '认证材料恢复记录损坏');
      seen.add(record.requestId);
      return Object.freeze(record);
    });
  }
  read(actor: string, target: { applicationId: string; revision: number }) {
    return (
      this.readAll(actor).find(
        (v) =>
          v.applicationId === target.applicationId &&
          v.revision === target.revision,
      ) ?? null
    );
  }
  write(record: PendingVerificationEvidence) {
    // Reject extra private fields before the first persistent write, even if a
    // JavaScript caller forged a value past the compile-time interface.
    exact(record, [
      'actor',
      'applicationId',
      'revision',
      'requestId',
      'requestHash',
    ]);
    if (
      typeof record.requestHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(record.requestHash)
    )
      throw new ClientError('storage', '原认证材料请求无效');
    record = {
      actor: verificationEvidenceUuid(record.actor),
      applicationId: verificationEvidenceUuid(record.applicationId),
      revision: verificationEvidenceRevision(record.revision),
      requestId: verificationEvidenceUuid(record.requestId),
      requestHash: record.requestHash,
    };
    const all = this.readAll(record.actor),
      old = all.find((v) => v.requestId === record.requestId);
    if (old && JSON.stringify(old) !== JSON.stringify(record))
      throw new ClientError('storage', '原认证材料请求不可更改');
    const next = all.filter((v) => v.requestId !== record.requestId);
    if (next.length >= 20)
      throw new ClientError('storage', '请先恢复或撤回旧认证材料请求');
    next.push(record);
    this.save(record.actor, next);
    if (
      this.readAll(record.actor).find((v) => v.requestId === record.requestId)
        ?.requestHash !== record.requestHash
    )
      throw new ClientError('storage', '无法保存认证材料恢复记录');
  }
  clear(record: PendingVerificationEvidence) {
    this.save(
      record.actor,
      this.readAll(record.actor).filter(
        (v) => v.requestId !== record.requestId,
      ),
    );
    if (
      this.readAll(record.actor).some((v) => v.requestId === record.requestId)
    )
      throw new ClientError('storage', '无法清除认证材料恢复记录');
  }
  private save(actor: string, records: PendingVerificationEvidence[]) {
    if (records.length)
      this.storage.set(
        this.prefix + actor,
        JSON.parse(JSON.stringify(records)),
      );
    else this.storage.remove(this.prefix + actor);
  }
}
