import {
  decodePublicationReference,
  protocolFor,
  type ProtocolVersion,
  type PublicationReference,
} from './batch-engine-contracts';
import { PendingMediaStore } from './pending';
import { ClientError } from '../api/errors';
import { normalizeOrigin } from '../api/origin';
import type { Storage } from '../platform/contracts';
import { decodeReceipt, type Receipt } from '../community/contract';
import {
  attachmentPlanDigest,
  batchCommandHash,
  batchEqual,
  batchIds,
  batchRequestHash,
  batchRevision,
  decodeBatchCommand,
  decodeBatchIdentity,
  decodeBatchStatus,
  decodeMemberPrepare,
  decodeMemberStatus,
  decodeOrderedAssets,
  decodePublicationCancellation,
  memberRequestHash,
  type BatchCommand,
  type BatchIdentity,
  type BatchStatus,
  type MemberPrepare,
  type MemberStatus,
  type OrderedAsset,
  type PublicationCancellation,
} from './batch-engine-contracts';
import {
  uploadDigest,
  uploadExact,
  uploadId,
  uploadInteger,
  uploadInvalid,
} from './upload-contracts';
export const MEDIA_BATCH_JOURNAL_BYTES = 64 * 1024;
export type BatchPhase =
  | 'selecting'
  | 'editing'
  | 'layout_uncertain'
  | 'seal_uncertain'
  | 'publication_uncertain'
  | 'cancel_uncertain'
  | 'settlement_pending';
export interface PendingMember {
  readonly memberId: string;
  readonly sourceSlot: number;
  readonly prepare: MemberPrepare;
  readonly requestHash: string;
  readonly observation: MemberStatus | null;
}
export interface BatchPublication {
  readonly reference: PublicationReference;
  readonly attachmentPlanDigest: string;
  readonly sealRevision: string;
  readonly orderedAssets: readonly OrderedAsset[];
  readonly linkState:
    'reserved' | 'linked' | 'settlement_verified' | 'publication_cleared';
  readonly dispatchState:
    'not_dispatched' | 'dispatch_uncertain' | 'receipt_seen';
  readonly receiptHint: Receipt | null;
  readonly cancellation: PublicationCancellation | null;
  readonly history: Extract<BatchStatus, { status: 'bound_history' }> | null;
}
export interface PendingBatch {
  readonly version: 3 | 4;
  /** Present only in journal v4; immutable server ancestry, never read authority. */
  readonly resolvedPostId?: string | null;
  readonly revision: number;
  readonly actorAccountId: string;
  readonly origin: string;
  readonly batchRequestId: string;
  readonly batchRequestHash: string;
  readonly batchIdentity: BatchIdentity;
  readonly batchId: string | null;
  readonly serverRevision: string | null;
  readonly createdAt: number;
  readonly lastObservedAt: number;
  readonly phase: BatchPhase;
  readonly orderedMemberIds: readonly string[];
  readonly members: readonly PendingMember[];
  readonly retiring: readonly PendingMember[];
  readonly pendingCommand:
    (BatchCommand & { readonly commandHash: string }) | null;
  readonly publication: BatchPublication | null;
}
const storageError = () =>
  new ClientError('storage', 'Batch recovery storage is unavailable');
const journalBytes = (value: unknown): number => {
  const text = JSON.stringify(value);
  // All allowed field values are ASCII. JSON escapes any control content, and
  // strict schemas reject text/paths/URLs/credentials before this budget check.
  return text.length;
};
function decodeMember(
  raw: unknown,
  actor: string,
  identity: BatchIdentity,
): PendingMember {
  uploadExact(raw, [
    'memberId',
    'sourceSlot',
    'prepare',
    'requestHash',
    'observation',
  ]);
  const prepare = decodeMemberPrepare(raw.prepare, protocolFor(identity));
  if (
    raw.memberId !== prepare.memberId ||
    raw.sourceSlot !== prepare.sourceSlot ||
    raw.requestHash !== memberRequestHash(actor, identity, prepare)
  )
    uploadInvalid();
  const observation =
    raw.observation === null ? null : decodeMemberStatus(raw.observation);
  if (
    observation &&
    (observation.version !== protocolFor(identity) ||
      observation.memberId !== prepare.memberId ||
      observation.requestHash !== raw.requestHash ||
      !batchEqual(observation.prepare, prepare))
  )
    uploadInvalid();
  return Object.freeze({
    memberId: prepare.memberId,
    sourceSlot: prepare.sourceSlot,
    prepare,
    requestHash: raw.requestHash,
    observation,
  });
}
function decodePublication(
  raw: unknown,
  batchId: string | null,
  version: ProtocolVersion,
): BatchPublication {
  uploadExact(raw, [
    'reference',
    'attachmentPlanDigest',
    'sealRevision',
    'orderedAssets',
    'linkState',
    'dispatchState',
    'receiptHint',
    'history',
    'cancellation',
  ]);
  const reference = decodePublicationReference(raw.reference),
    orderedAssets = decodeOrderedAssets(raw.orderedAssets, version);
  if (
    !batchId ||
    !batchRevision(raw.sealRevision) ||
    !uploadDigest(raw.attachmentPlanDigest) ||
    raw.attachmentPlanDigest !==
      attachmentPlanDigest(batchId, raw.sealRevision, orderedAssets, version) ||
    ![
      'reserved',
      'linked',
      'settlement_verified',
      'publication_cleared',
    ].includes(String(raw.linkState)) ||
    !['not_dispatched', 'dispatch_uncertain', 'receipt_seen'].includes(
      String(raw.dispatchState),
    )
  )
    uploadInvalid();
  if ((reference.operation === 'publish_post') !== (version === 3))
    uploadInvalid();
  const receiptHint =
    raw.receiptHint === null ? null : decodeReceipt(raw.receiptHint);
  if (
    receiptHint &&
    (receiptHint.requestId !== reference.clientRequestId ||
      receiptHint.operation !== reference.operation)
  )
    uploadInvalid();
  const cancellation =
    raw.cancellation === null
      ? null
      : decodePublicationCancellation(raw.cancellation);
  if (
    cancellation &&
    (cancellation.operation !== reference.operation ||
      cancellation.requestId !== reference.clientRequestId ||
      cancellation.intentHash !== reference.intentHash ||
      receiptHint)
  )
    uploadInvalid();
  const history = raw.history === null ? null : decodeBatchStatus(raw.history);
  if (
    history &&
    (history.version !== version ||
      history.status !== 'bound_history' ||
      !batchEqual(history.publication, reference) ||
      !batchEqual(history.orderedAssets, orderedAssets) ||
      history.attachmentPlanDigest !== raw.attachmentPlanDigest ||
      history.batchId !== batchId ||
      receiptHint?.outcome !== 'created' ||
      history.parent.resourceId !== receiptHint.resourceId)
  )
    uploadInvalid();
  if (
    ['settlement_verified', 'publication_cleared'].includes(
      String(raw.linkState),
    ) &&
    ((!receiptHint && !cancellation) ||
      (receiptHint?.outcome === 'created' && !history))
  )
    uploadInvalid();
  if (raw.dispatchState === 'receipt_seen' && !receiptHint && !cancellation)
    uploadInvalid();
  return Object.freeze({
    reference,
    orderedAssets,
    attachmentPlanDigest: raw.attachmentPlanDigest,
    sealRevision: raw.sealRevision,
    linkState: raw.linkState as BatchPublication['linkState'],
    dispatchState: raw.dispatchState as BatchPublication['dispatchState'],
    receiptHint,
    cancellation,
    history: history as BatchPublication['history'],
  });
}
function decodePendingVersion(
  raw: unknown,
  actor: string,
  origin: string,
  version: ProtocolVersion,
): PendingBatch {
  uploadExact(raw, [
    'version',
    ...(version === 4 ? ['resolvedPostId'] : []),
    'revision',
    'actorAccountId',
    'origin',
    'batchRequestId',
    'batchRequestHash',
    'batchIdentity',
    'batchId',
    'serverRevision',
    'createdAt',
    'lastObservedAt',
    'phase',
    'orderedMemberIds',
    'members',
    'retiring',
    'pendingCommand',
    'publication',
  ]);
  if (
    raw.version !== version ||
    (version === 4 &&
      ((raw.resolvedPostId !== null && !uploadId(raw.resolvedPostId)) ||
        (raw.batchId !== null && raw.resolvedPostId === null))) ||
    !uploadInteger(raw.revision) ||
    !uploadId(actor) ||
    raw.actorAccountId !== actor ||
    raw.origin !== normalizeOrigin(origin) ||
    !uploadId(raw.batchRequestId) ||
    !uploadDigest(raw.batchRequestHash) ||
    (raw.batchId !== null && !uploadId(raw.batchId)) ||
    (raw.serverRevision !== null && !batchRevision(raw.serverRevision)) ||
    (raw.batchId === null) !== (raw.serverRevision === null) ||
    !uploadInteger(raw.createdAt) ||
    !uploadInteger(raw.lastObservedAt) ||
    raw.lastObservedAt < raw.createdAt ||
    ![
      'selecting',
      'editing',
      'layout_uncertain',
      'seal_uncertain',
      'publication_uncertain',
      'cancel_uncertain',
      'settlement_pending',
    ].includes(String(raw.phase)) ||
    !Array.isArray(raw.members) ||
    raw.members.length > (version === 3 ? 9 : 3) ||
    !Array.isArray(raw.retiring) ||
    raw.retiring.length > (version === 3 ? 9 : 3)
  )
    uploadInvalid();
  const batchIdentity = decodeBatchIdentity(raw.batchIdentity);
  if (
    protocolFor(batchIdentity) !== version ||
    batchIdentity.batchRequestId !== raw.batchRequestId ||
    batchRequestHash(actor, batchIdentity) !== raw.batchRequestHash
  )
    uploadInvalid();
  const members = raw.members.map((m) => decodeMember(m, actor, batchIdentity)),
    retiring = raw.retiring.map((m) => decodeMember(m, actor, batchIdentity)),
    all = [...members, ...retiring],
    orderedMemberIds = batchIds(raw.orderedMemberIds, 0, version);
  if (
    new Set(all.map((m) => m.memberId)).size !== all.length ||
    new Set(all.map((m) => m.prepare.clientRequestId)).size !== all.length ||
    new Set(members.map((m) => m.sourceSlot)).size !== members.length ||
    orderedMemberIds.length !== members.length ||
    orderedMemberIds.some((id) => !members.some((m) => m.memberId === id)) ||
    all.some((m) => m.observation && m.observation.batchId !== raw.batchId)
  )
    uploadInvalid();
  let pendingCommand: PendingBatch['pendingCommand'] = null;
  if (raw.pendingCommand !== null) {
    uploadExact(raw.pendingCommand, ['kind', 'payload', 'commandHash']);
    if (
      !raw.batchId ||
      !['layout', 'seal', 'reopen'].includes(String(raw.pendingCommand.kind))
    )
      uploadInvalid();
    const command = decodeBatchCommand(
      raw.pendingCommand.kind as BatchCommand['kind'],
      raw.pendingCommand.payload,
      version,
    );
    if (
      raw.pendingCommand.commandHash !==
      batchCommandHash(raw.batchId, command, version)
    )
      uploadInvalid();
    pendingCommand = Object.freeze({
      ...command,
      commandHash: raw.pendingCommand.commandHash,
    });
  }
  const publication =
    raw.publication === null
      ? null
      : decodePublication(raw.publication, raw.batchId, version);
  if (
    (raw.phase === 'seal_uncertain' && pendingCommand?.kind !== 'seal') ||
    (raw.phase === 'layout_uncertain' && !pendingCommand) ||
    (raw.phase === 'publication_uncertain' &&
      (!publication || publication.linkState === 'reserved')) ||
    (raw.phase === 'settlement_pending' && !publication) ||
    (publication &&
      (!batchEqual(
        publication.orderedAssets.map((a) => a.memberId),
        orderedMemberIds,
      ) ||
        publication.orderedAssets.some(
          (a) =>
            !members.some(
              (m) =>
                m.memberId === a.memberId &&
                m.observation?.assetId === a.assetId &&
                m.observation.manifestDigest === a.manifestDigest,
            ),
        )))
  )
    uploadInvalid();
  if (batchIdentity.version === 2) {
    if (
      raw.resolvedPostId !== null &&
      batchIdentity.target.kind === 'comment' &&
      raw.resolvedPostId !== batchIdentity.target.postId
    )
      uploadInvalid();
    const operation =
      batchIdentity.target.kind === 'comment'
        ? 'publish_comment'
        : 'publish_reply';
    if (publication && publication.reference.operation !== operation)
      uploadInvalid();
    if (
      pendingCommand &&
      pendingCommand.kind !== 'layout' &&
      (!publication ||
        !batchEqual(pendingCommand.payload.publication, publication.reference))
    )
      uploadInvalid();
    const history = publication?.history;
    if (
      history &&
      (history.version !== 4 ||
        history.resolvedPostId !== raw.resolvedPostId ||
        history.batchRequestId !== raw.batchRequestId ||
        history.batchRequestHash !== raw.batchRequestHash ||
        !batchEqual(history.batchIdentity, batchIdentity) ||
        history.members.some(
          (member) =>
            member.requestHash !==
            memberRequestHash(actor, batchIdentity, member.prepare),
        ))
    )
      uploadInvalid();
  }
  const value: PendingBatch = Object.freeze({
    version,
    ...(version === 4
      ? { resolvedPostId: raw.resolvedPostId as string | null }
      : {}),
    revision: raw.revision,
    actorAccountId: actor,
    origin: normalizeOrigin(origin),
    batchRequestId: raw.batchRequestId,
    batchRequestHash: raw.batchRequestHash,
    batchIdentity,
    batchId: raw.batchId,
    serverRevision: raw.serverRevision,
    createdAt: raw.createdAt,
    lastObservedAt: raw.lastObservedAt,
    phase: raw.phase as BatchPhase,
    orderedMemberIds,
    members: Object.freeze(members),
    retiring: Object.freeze(retiring),
    pendingCommand,
    publication,
  });
  if (journalBytes(value) > MEDIA_BATCH_JOURNAL_BYTES) uploadInvalid();
  return value;
}
/** Frozen v3 entry point: v4 data is never admitted under the old decoder. */
export function decodePendingBatch(
  raw: unknown,
  actor: string,
  origin: string,
): PendingBatch {
  return decodePendingVersion(raw, actor, origin, 3);
}
export function decodePendingDiscussionBatch(
  raw: unknown,
  actor: string,
  origin: string,
): PendingBatch {
  return decodePendingVersion(raw, actor, origin, 4);
}
/** Metadata-only aggregate WAL. Storage CAS is synchronous and process-local;
 * server batch revisions arbitrate other devices. No ready member is evicted. */
export class PendingBatchStore {
  readonly origin: string;
  readonly legacy: PendingMediaStore;
  constructor(
    private readonly storage: Storage,
    origin: string,
  ) {
    this.origin = normalizeOrigin(origin);
    this.legacy = new PendingMediaStore(storage, this.origin);
  }
  modeForActor(actor: string): 'legacy' | 'batch' | 'conflict' {
    // Same Storage and normalized origin; damage is never interpreted as absence.
    const legacy = this.legacy.load(actor),
      batch = this.load(actor);
    return legacy ? (batch ? 'conflict' : 'legacy') : 'batch';
  }
  assertBatchAdmission(actor: string): void {
    if (this.modeForActor(actor) !== 'batch')
      throw new ClientError(
        'business',
        'Recover the original legacy image before creating or changing a batch',
      );
  }
  private key(actor: string, version: ProtocolVersion): string {
    if (!uploadId(actor)) throw storageError();
    return `whaleu.media.batch.pending.v${version}:${this.origin}:${actor}`;
  }
  load(actor: string): PendingBatch | null {
    try {
      const v3 = this.storage.get(this.key(actor, 3)),
        v4 = this.storage.get(this.key(actor, 4));
      const has3 = v3 !== undefined && v3 !== null,
        has4 = v4 !== undefined && v4 !== null;
      if (has3 && has4) throw storageError();
      return has3
        ? decodePendingBatch(v3, actor, this.origin)
        : has4
          ? decodePendingDiscussionBatch(v4, actor, this.origin)
          : null;
    } catch {
      throw storageError();
    }
  }
  freeze(actor: string, identity: BatchIdentity, now: number): PendingBatch {
    try {
      this.assertBatchAdmission(actor);
      const checked = decodeBatchIdentity(identity);
      const value = decodePendingVersion(
        {
          version: protocolFor(checked),
          ...(checked.version === 2 ? { resolvedPostId: null } : {}),
          revision: 1,
          actorAccountId: actor,
          origin: this.origin,
          batchRequestId: checked.batchRequestId,
          batchRequestHash: batchRequestHash(actor, checked),
          batchIdentity: checked,
          batchId: null,
          serverRevision: null,
          createdAt: now,
          lastObservedAt: now,
          phase: 'selecting',
          orderedMemberIds: [],
          members: [],
          retiring: [],
          pendingCommand: null,
          publication: null,
        },
        actor,
        this.origin,
        protocolFor(checked),
      );
      const old = this.load(actor);
      if (old) {
        if (!batchEqual(old.batchIdentity, checked)) throw storageError();
        return this.assertStored(old);
      }
      this.storage.set(this.key(actor, value.version), value);
      return this.assertStored(value);
    } catch {
      throw storageError();
    }
  }
  assertStored(expected: PendingBatch): PendingBatch {
    const value = this.load(expected.actorAccountId);
    if (!value || !batchEqual(value, expected)) throw storageError();
    return value;
  }
  update(
    expected: PendingBatch,
    patch: Partial<
      Pick<
        PendingBatch,
        | 'batchId'
        | 'resolvedPostId'
        | 'serverRevision'
        | 'lastObservedAt'
        | 'phase'
        | 'orderedMemberIds'
        | 'members'
        | 'retiring'
        | 'pendingCommand'
        | 'publication'
      >
    >,
  ): PendingBatch {
    try {
      this.assertStored(expected);
      const next = decodePendingVersion(
        { ...expected, ...patch, revision: expected.revision + 1 },
        expected.actorAccountId,
        this.origin,
        expected.version,
      );
      if (
        (expected.batchId && next.batchId !== expected.batchId) ||
        (expected.resolvedPostId &&
          next.resolvedPostId !== expected.resolvedPostId)
      )
        throw storageError();
      for (const old of [...expected.members, ...expected.retiring]) {
        const current = [...next.members, ...next.retiring].find(
          (m) => m.memberId === old.memberId,
        );
        if (!current) {
          if (old.observation?.observation.status !== 'terminal')
            throw storageError();
        } else if (
          !batchEqual(current.prepare, old.prepare) ||
          current.requestHash !== old.requestHash ||
          (old.observation &&
            (!current.observation ||
              current.observation.intentId !== old.observation.intentId ||
              (old.observation.assetId &&
                current.observation.assetId !== old.observation.assetId)))
        )
          throw storageError();
      }
      if (
        expected.publication &&
        next.publication &&
        !batchEqual(expected.publication.reference, next.publication.reference)
      )
        throw storageError();
      if (
        expected.publication &&
        !next.publication &&
        expected.publication.linkState !== 'publication_cleared'
      )
        throw storageError();
      this.storage.set(
        this.key(expected.actorAccountId, expected.version),
        next,
      );
      return this.assertStored(next);
    } catch {
      throw storageError();
    }
  }
  /** Only matching full bound history after Community settlement or durable batch terminal clears the WAL. */
  settle(expected: PendingBatch, raw: BatchStatus): void {
    const proof = decodeBatchStatus(raw);
    if (
      proof.version !== expected.version ||
      (proof.version === 4 &&
        proof.resolvedPostId !== expected.resolvedPostId) ||
      proof.batchRequestId !== expected.batchRequestId ||
      proof.batchRequestHash !== expected.batchRequestHash ||
      (expected.batchId && proof.batchId !== expected.batchId)
    )
      uploadInvalid();
    if (proof.status === 'bound_history') {
      const publication = expected.publication;
      if (
        !publication ||
        publication.linkState !== 'publication_cleared' ||
        !batchEqual(publication.history, proof)
      )
        uploadInvalid();
    } else if (proof.status !== 'terminal' || expected.publication)
      uploadInvalid();
    try {
      this.assertStored(expected);
      this.storage.remove(this.key(expected.actorAccountId, expected.version));
      if (this.load(expected.actorAccountId)) throw storageError();
    } catch {
      throw storageError();
    }
  }
}
