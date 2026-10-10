import { ClientError } from '../api/errors';
import { normalizeOrigin } from '../api/origin';
import type { Storage } from '../platform/contracts';
import {
  decodePublicationReference,
  decodeUploadPrepare,
  decodeUploadRecovery,
  decodeUploadStatus,
  uploadDigest,
  uploadId,
  uploadExact,
  uploadInteger,
  uploadInvalid,
  uploadRequestHash,
  type PublicationReference,
  type UploadPrepare,
  type UploadRecovery,
  type UploadStatus,
} from './upload-contracts';

export type MediaPhase =
  | 'prepare_uncertain'
  | 'prepared'
  | 'upload_uncertain'
  | 'processing'
  | 'ready_hint'
  | 'cancel_uncertain'
  | 'publication_uncertain';
export interface PendingMedia {
  readonly version: 1;
  readonly revision: number;
  readonly actorAccountId: string;
  readonly operation: 'community-post-image';
  readonly clientRequestId: string;
  readonly prepare: UploadPrepare;
  readonly requestHash: string;
  readonly intentId: string | null;
  readonly phase: MediaPhase;
  readonly createdAt: number;
  readonly lastObservedAt: number;
  readonly operationDeadlineAt: number | null;
  readonly readyRetentionUntil: number | null;
  readonly draftExpiresAt: number | null;
  readonly bindBefore: number | null;
  readonly assetId: string | null;
  readonly bindingId: string | null;
  readonly publication: PublicationReference | null;
}
const storageError = () =>
  new ClientError('storage', 'Media recovery storage is unavailable');
const equal = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b);
const nullableId = (value: unknown): value is string | null =>
  value === null || uploadId(value);
const nullableTime = (value: unknown): value is number | null =>
  value === null || uploadInteger(value);
export function decodePendingMedia(
  value: unknown,
  actor: string,
): PendingMedia {
  uploadExact(value, [
    'version',
    'revision',
    'actorAccountId',
    'operation',
    'clientRequestId',
    'prepare',
    'requestHash',
    'intentId',
    'phase',
    'createdAt',
    'lastObservedAt',
    'operationDeadlineAt',
    'readyRetentionUntil',
    'draftExpiresAt',
    'bindBefore',
    'assetId',
    'bindingId',
    'publication',
  ]);
  if (
    value.version !== 1 ||
    !uploadInteger(value.revision) ||
    !uploadId(actor) ||
    value.actorAccountId !== actor ||
    value.operation !== 'community-post-image' ||
    !uploadId(value.clientRequestId) ||
    !uploadDigest(value.requestHash) ||
    !nullableId(value.intentId) ||
    !nullableId(value.assetId) ||
    !nullableId(value.bindingId) ||
    !uploadInteger(value.createdAt) ||
    !uploadInteger(value.lastObservedAt) ||
    value.lastObservedAt < value.createdAt ||
    !nullableTime(value.operationDeadlineAt) ||
    !nullableTime(value.readyRetentionUntil) ||
    !nullableTime(value.draftExpiresAt) ||
    !nullableTime(value.bindBefore) ||
    typeof value.phase !== 'string' ||
    ![
      'prepare_uncertain',
      'prepared',
      'upload_uncertain',
      'processing',
      'ready_hint',
      'cancel_uncertain',
      'publication_uncertain',
    ].includes(value.phase)
  )
    uploadInvalid();
  const prepare = decodeUploadPrepare(value.prepare);
  if (
    prepare.clientRequestId !== value.clientRequestId ||
    uploadRequestHash(actor, prepare) !== value.requestHash
  )
    uploadInvalid();
  const publication =
    value.publication === null
      ? null
      : decodePublicationReference(value.publication);
  if (
    value.phase === 'publication_uncertain' &&
    (!publication || !value.assetId || !value.intentId)
  )
    uploadInvalid();
  if (value.bindingId && !value.assetId) uploadInvalid();
  return Object.freeze({
    version: 1,
    revision: value.revision,
    actorAccountId: actor,
    operation: 'community-post-image',
    clientRequestId: value.clientRequestId,
    prepare,
    requestHash: value.requestHash,
    intentId: value.intentId,
    phase: value.phase as MediaPhase,
    createdAt: value.createdAt,
    lastObservedAt: value.lastObservedAt,
    operationDeadlineAt: value.operationDeadlineAt,
    readyRetentionUntil: value.readyRetentionUntil,
    draftExpiresAt: value.draftExpiresAt,
    bindBefore: value.bindBefore,
    assetId: value.assetId,
    bindingId: value.bindingId,
    publication,
  });
}
/** One unresolved chain per origin+actor. Synchronous full-value CAS and readback precede writes.
 * A damaged record is never treated as absence; no enumeration, TTL eviction or path recovery. */
export class PendingMediaStore {
  private readonly origin: string;
  constructor(
    private readonly storage: Storage,
    origin: string,
  ) {
    this.origin = normalizeOrigin(origin);
  }
  private key(actor: string): string {
    if (!uploadId(actor)) throw storageError();
    return `whaleu.media.pending.v1:${this.origin}:${actor}`;
  }
  load(actor: string): PendingMedia | null {
    try {
      const raw = this.storage.get(this.key(actor));
      return raw === undefined || raw === null
        ? null
        : decodePendingMedia(raw, actor);
    } catch {
      throw storageError();
    }
  }
  freeze(actor: string, raw: UploadPrepare, now: number): PendingMedia {
    try {
      const prepare = decodeUploadPrepare(raw);
      const value = decodePendingMedia(
        {
          version: 1,
          revision: 1,
          actorAccountId: actor,
          operation: 'community-post-image',
          clientRequestId: prepare.clientRequestId,
          prepare,
          requestHash: uploadRequestHash(actor, prepare),
          intentId: null,
          phase: 'prepare_uncertain',
          createdAt: now,
          lastObservedAt: now,
          operationDeadlineAt: null,
          readyRetentionUntil: null,
          draftExpiresAt: null,
          bindBefore: null,
          assetId: null,
          bindingId: null,
          publication: null,
        },
        actor,
      );
      const old = this.load(actor);
      if (old) {
        if (!equal(old, value)) throw storageError();
        return old;
      }
      this.storage.set(this.key(actor), value);
      return this.assertStored(value);
    } catch {
      throw storageError();
    }
  }
  assertStored(expected: PendingMedia): PendingMedia {
    const actual = this.load(expected.actorAccountId);
    if (!actual || !equal(actual, expected)) throw storageError();
    return actual;
  }
  update(
    expected: PendingMedia,
    patch: Partial<
      Pick<
        PendingMedia,
        | 'intentId'
        | 'phase'
        | 'lastObservedAt'
        | 'operationDeadlineAt'
        | 'readyRetentionUntil'
        | 'draftExpiresAt'
        | 'bindBefore'
        | 'assetId'
        | 'bindingId'
        | 'publication'
      >
    >,
  ): PendingMedia {
    try {
      this.assertStored(expected);
      const next = decodePendingMedia(
        { ...expected, ...patch, revision: expected.revision + 1 },
        expected.actorAccountId,
      );
      if (
        (expected.intentId && next.intentId !== expected.intentId) ||
        (expected.assetId && next.assetId !== expected.assetId) ||
        (expected.bindingId && next.bindingId !== expected.bindingId) ||
        (expected.publication &&
          next.publication &&
          !equal(expected.publication, next.publication))
      )
        throw storageError();
      this.storage.set(this.key(expected.actorAccountId), next);
      return this.assertStored(next);
    } catch {
      throw storageError();
    }
  }
  /** Only a strict server terminal or matching bound history settles media; local clocks never do. */
  settle(
    expected: PendingMedia,
    evidence: UploadStatus | UploadRecovery,
  ): void {
    const statusEvidence =
      'status' in evidence && typeof evidence.status === 'string';
    const proof = statusEvidence
      ? decodeUploadStatus(evidence)
      : decodeUploadRecovery(evidence);
    if (
      proof.requestId !== expected.clientRequestId ||
      proof.requestHash !== expected.requestHash
    )
      uploadInvalid();
    if ('state' in proof) {
      if (proof.state !== 'terminal' && proof.state !== 'bound_history')
        uploadInvalid();
      if (
        proof.status &&
        expected.intentId &&
        proof.status.intentId !== expected.intentId
      )
        uploadInvalid();
      if (proof.state === 'bound_history')
        this.matchBound(expected, proof.status);
    } else {
      if (proof.status !== 'terminal' && proof.status !== 'bound_history')
        uploadInvalid();
      if (expected.intentId && proof.intentId !== expected.intentId)
        uploadInvalid();
      if (proof.status === 'bound_history') this.matchBound(expected, proof);
    }
    try {
      this.assertStored(expected);
      this.storage.remove(this.key(expected.actorAccountId));
      if (this.load(expected.actorAccountId)) throw storageError();
    } catch {
      throw storageError();
    }
  }
  private matchBound(
    expected: PendingMedia,
    status: Extract<UploadStatus, { status: 'bound_history' }>,
  ): void {
    if (
      (expected.assetId && expected.assetId !== status.assetId) ||
      (expected.publication &&
        status.publication &&
        !equal(expected.publication, status.publication))
    )
      uploadInvalid();
  }
}
