import { sha256 } from 'js-sha256';
import { isRecord } from '../api/errors';
import { decodeReceipt, type Receipt } from '../community/contract';
import type { Cancellation } from '../platform/contracts';
import type { MediaSession } from './contracts';
import {
  decodePublicationReference,
  decodeUploadStatus,
  MEDIA_UPLOAD_MAX_BYTES,
  uploadDigest,
  uploadExact,
  uploadId,
  uploadInteger,
  uploadInvalid,
  type PublicationReference,
  type UploadDeclaration,
  type UploadGrant,
  type UploadStatus,
} from './upload-contracts';
export const MEDIA_BATCH_MAX_MEMBERS = 9;
export interface BatchIdentity {
  readonly version: 1;
  readonly batchRequestId: string;
  readonly draftId: string;
  readonly spaceId: string;
  readonly purpose: 'community-post-images';
}
export interface MemberPrepare {
  readonly clientRequestId: string;
  readonly memberId: string;
  readonly sourceSlot: number;
  readonly declaration: UploadDeclaration;
}
export interface OrderedAsset {
  readonly memberId: string;
  readonly assetId: string;
  readonly manifestDigest: string;
}
export interface MemberStatus {
  readonly version: 3;
  readonly batchId: string;
  readonly memberId: string;
  readonly sourceSlot: number;
  readonly prepare: MemberPrepare;
  readonly requestId: string;
  readonly requestHash: string;
  readonly intentId: string;
  readonly assetId: string | null;
  readonly manifestDigest: string | null;
  readonly observation: UploadStatus;
}
interface BatchBase {
  readonly version: 3;
  readonly batchIdentity: BatchIdentity | null;
  readonly batchRequestId: string;
  readonly batchRequestHash: string;
  readonly batchId: string | null;
  readonly revision: string;
  readonly serverNow: number;
  readonly orderedMemberIds: readonly string[];
  readonly members: readonly MemberStatus[];
  readonly retiring: readonly MemberStatus[];
}
interface SealedPlan {
  readonly publication: PublicationReference;
  readonly attachmentPlanDigest: string;
  readonly orderedAssets: readonly OrderedAsset[];
}
export type BatchStatus = BatchBase &
  (
    | { readonly status: 'editing' | 'preparing' | 'cancelling' }
    | {
        readonly status: 'ready_unbound';
        readonly orderedAssets: readonly OrderedAsset[];
        readonly draftExpiresAt: number;
        readonly bindBefore: number;
      }
    | ({ readonly status: 'publication_pending' } & SealedPlan)
    | ({
        readonly status: 'bound_history';
        readonly parent: {
          readonly ownerKind: 'community';
          readonly resourceKind: 'post';
          readonly resourceId: string;
          readonly contentVersion: 1;
        };
        readonly bindings: readonly (OrderedAsset & {
          readonly bindingId: string;
          readonly ordinal: number;
          readonly attachmentState: 'active' | 'detached';
        })[];
      } & SealedPlan)
    | {
        readonly status: 'terminal';
        readonly reason: 'cancelled';
        readonly cleanup: 'pending' | 'retained' | 'confirmed';
      }
    | {
        readonly status: 'unavailable';
        readonly reason: 'MEDIA_UNAVAILABLE';
        readonly retryable: boolean;
      }
  );
export type BatchRecovery =
  | {
      readonly version: 3;
      readonly state: 'not_recorded';
      readonly batchRequestId: string;
      readonly serverNow: number;
    }
  | {
      readonly version: 3;
      readonly state: 'recorded';
      readonly status: BatchStatus;
    };
export type BatchPublicationRecovery =
  | {
      readonly version: 3;
      readonly state: 'unknown';
      readonly serverNow: number;
    }
  | {
      readonly version: 3;
      readonly state: 'recorded';
      readonly status: BatchStatus;
    };
export interface PublicationCancellation {
  readonly requestId: string;
  readonly operation: 'publish_post';
  readonly outcome: 'cancelled';
  readonly intentHash: string;
}
export interface BatchFenceResult {
  readonly version: 3;
  readonly status: BatchStatus;
  readonly cancellation: PublicationCancellation | Receipt;
}
export function decodePublicationCancellation(
  raw: unknown,
): PublicationCancellation {
  uploadExact(raw, ['requestId', 'operation', 'outcome', 'intentHash']);
  if (
    !uploadId(raw.requestId) ||
    raw.operation !== 'publish_post' ||
    raw.outcome !== 'cancelled' ||
    !uploadDigest(raw.intentHash)
  )
    uploadInvalid();
  return Object.freeze({
    requestId: raw.requestId,
    operation: 'publish_post',
    outcome: 'cancelled',
    intentHash: raw.intentHash,
  });
}
export function decodeBatchFenceResult(raw: unknown): BatchFenceResult {
  uploadExact(raw, ['version', 'status', 'cancellation']);
  if (raw.version !== 3 || !isRecord(raw.cancellation)) uploadInvalid();
  const cancellation =
    raw.cancellation.outcome === 'cancelled'
      ? decodePublicationCancellation(raw.cancellation)
      : decodeReceipt(raw.cancellation);
  if (cancellation.operation !== 'publish_post') uploadInvalid();
  return Object.freeze({
    version: 3,
    status: decodeBatchStatus(raw.status),
    cancellation,
  });
}
export interface LayoutCommand {
  readonly commandId: string;
  readonly expectedRevision: string;
  readonly orderedMemberIds: readonly string[];
  readonly removeMemberIds: readonly string[];
}
export interface SealCommand {
  readonly commandId: string;
  readonly expectedRevision: string;
  readonly orderedMemberIds: readonly string[];
  readonly publication: PublicationReference;
}
export interface ReopenCommand {
  readonly commandId: string;
  readonly expectedRevision: string;
  readonly publication: PublicationReference;
}
export type BatchCommand =
  | { readonly kind: 'layout'; readonly payload: LayoutCommand }
  | { readonly kind: 'seal'; readonly payload: SealCommand }
  | { readonly kind: 'reopen'; readonly payload: ReopenCommand };
export const batchEqual = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b);
export const batchRevision = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[1-9][0-9]{0,18}$/.test(value) &&
  (value.length < 19 || value <= '9223372036854775807');
export function batchIds(raw: unknown, min = 0): readonly string[] {
  if (
    !Array.isArray(raw) ||
    raw.length < min ||
    raw.length > 9 ||
    raw.some((id) => !uploadId(id)) ||
    new Set(raw).size !== raw.length
  )
    uploadInvalid();
  return Object.freeze([...raw]) as readonly string[];
}
export function decodeBatchIdentity(raw: unknown): BatchIdentity {
  uploadExact(raw, [
    'version',
    'batchRequestId',
    'draftId',
    'spaceId',
    'purpose',
  ]);
  if (
    raw.version !== 1 ||
    !uploadId(raw.batchRequestId) ||
    !uploadId(raw.draftId) ||
    !uploadId(raw.spaceId) ||
    raw.purpose !== 'community-post-images'
  )
    uploadInvalid();
  return Object.freeze({
    version: 1,
    batchRequestId: raw.batchRequestId,
    draftId: raw.draftId,
    spaceId: raw.spaceId,
    purpose: 'community-post-images',
  });
}
export function decodeMemberPrepare(raw: unknown): MemberPrepare {
  uploadExact(raw, [
    'clientRequestId',
    'memberId',
    'sourceSlot',
    'declaration',
  ]);
  uploadExact(raw.declaration, ['mime', 'bytes', 'sha256']);
  if (
    !uploadId(raw.clientRequestId) ||
    !uploadId(raw.memberId) ||
    !uploadInteger(raw.sourceSlot, 0, 8) ||
    (raw.declaration.mime !== 'image/jpeg' &&
      raw.declaration.mime !== 'image/png') ||
    !uploadInteger(raw.declaration.bytes, 1, MEDIA_UPLOAD_MAX_BYTES) ||
    !uploadDigest(raw.declaration.sha256)
  )
    uploadInvalid();
  return Object.freeze({
    clientRequestId: raw.clientRequestId,
    memberId: raw.memberId,
    sourceSlot: raw.sourceSlot,
    declaration: Object.freeze({
      mime: raw.declaration.mime,
      bytes: raw.declaration.bytes,
      sha256: raw.declaration.sha256,
    }),
  });
}
export function batchRequestHash(actor: string, raw: unknown): string {
  if (!uploadId(actor)) uploadInvalid();
  return sha256(
    'whaleu-media-batch:v1\n' +
      JSON.stringify({
        actorAccountId: actor,
        identity: decodeBatchIdentity(raw),
      }),
  );
}
export function memberRequestHash(
  actor: string,
  identity: BatchIdentity,
  raw: unknown,
): string {
  const m = decodeMemberPrepare(raw);
  return sha256(
    'whaleu-media-member:v3\n' +
      JSON.stringify({
        version: 3,
        actorAccountId: actor,
        batchRequestHash: batchRequestHash(actor, identity),
        clientRequestId: m.clientRequestId,
        memberId: m.memberId,
        sourceSlot: m.sourceSlot,
        declaration: m.declaration,
      }),
  );
}
export function decodeOrderedAssets(raw: unknown): readonly OrderedAsset[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 9) uploadInvalid();
  const result = raw.map((item) => {
    uploadExact(item, ['memberId', 'assetId', 'manifestDigest']);
    if (
      !uploadId(item.memberId) ||
      !uploadId(item.assetId) ||
      !uploadDigest(item.manifestDigest)
    )
      uploadInvalid();
    return Object.freeze({
      memberId: item.memberId,
      assetId: item.assetId,
      manifestDigest: item.manifestDigest,
    });
  });
  if (
    new Set(result.map((item) => item.memberId)).size !== result.length ||
    new Set(result.map((item) => item.assetId)).size !== result.length
  )
    uploadInvalid();
  return Object.freeze(result);
}
export function attachmentPlanDigest(
  batchId: string,
  revision: string,
  assets: readonly OrderedAsset[],
): string {
  if (!uploadId(batchId) || !batchRevision(revision)) uploadInvalid();
  return sha256(
    'whaleu-media-attachment-plan:v1\n' +
      JSON.stringify({
        version: 1,
        batchId,
        revision,
        orderedAssets: decodeOrderedAssets(assets),
      }),
  );
}
export function decodeBatchCommand(
  kind: BatchCommand['kind'],
  raw: unknown,
): BatchCommand {
  const keys = ['commandId', 'expectedRevision'];
  uploadExact(raw, [
    ...keys,
    ...(kind === 'layout'
      ? ['orderedMemberIds', 'removeMemberIds']
      : kind === 'seal'
        ? ['orderedMemberIds', 'publication']
        : ['publication']),
  ]);
  if (!uploadId(raw.commandId) || !batchRevision(raw.expectedRevision))
    uploadInvalid();
  const base = {
    commandId: raw.commandId,
    expectedRevision: raw.expectedRevision,
  };
  if (kind === 'layout') {
    const orderedMemberIds = batchIds(raw.orderedMemberIds),
      removeMemberIds = batchIds(raw.removeMemberIds);
    if (removeMemberIds.some((id) => orderedMemberIds.includes(id)))
      uploadInvalid();
    return {
      kind,
      payload: Object.freeze({ ...base, orderedMemberIds, removeMemberIds }),
    };
  }
  const publication = decodePublicationReference(raw.publication);
  return kind === 'seal'
    ? {
        kind,
        payload: Object.freeze({
          ...base,
          orderedMemberIds: batchIds(raw.orderedMemberIds, 1),
          publication,
        }),
      }
    : { kind, payload: Object.freeze({ ...base, publication }) };
}
export function batchCommandHash(
  batchId: string,
  command: BatchCommand,
): string {
  if (!uploadId(batchId)) uploadInvalid();
  const checked = decodeBatchCommand(command.kind, command.payload);
  return sha256(
    'whaleu-media-batch-command:v1\n' +
      JSON.stringify({
        version: 1,
        batchId,
        kind: checked.kind,
        command: checked.payload,
      }),
  );
}
export function decodeMemberStatus(raw: unknown): MemberStatus {
  uploadExact(raw, [
    'version',
    'batchId',
    'memberId',
    'sourceSlot',
    'prepare',
    'requestId',
    'requestHash',
    'intentId',
    'assetId',
    'manifestDigest',
    'observation',
  ]);
  if (
    raw.version !== 3 ||
    !uploadId(raw.batchId) ||
    !uploadId(raw.memberId) ||
    !uploadInteger(raw.sourceSlot, 0, 8) ||
    !uploadId(raw.requestId) ||
    !uploadDigest(raw.requestHash) ||
    !uploadId(raw.intentId) ||
    (raw.assetId !== null && !uploadId(raw.assetId)) ||
    (raw.manifestDigest !== null && !uploadDigest(raw.manifestDigest))
  )
    uploadInvalid();
  const prepare = decodeMemberPrepare(raw.prepare),
    observation = decodeUploadStatus(raw.observation);
  if (
    prepare.memberId !== raw.memberId ||
    prepare.clientRequestId !== raw.requestId ||
    prepare.sourceSlot !== raw.sourceSlot ||
    observation.intentId !== raw.intentId ||
    observation.requestId !== raw.requestId ||
    observation.requestHash !== raw.requestHash ||
    ('assetId' in observation && observation.assetId !== raw.assetId) ||
    (raw.assetId === null) !== (raw.manifestDigest === null)
  )
    uploadInvalid();
  return Object.freeze({
    version: 3,
    batchId: raw.batchId,
    memberId: raw.memberId,
    sourceSlot: raw.sourceSlot,
    prepare,
    requestId: raw.requestId,
    requestHash: raw.requestHash,
    intentId: raw.intentId,
    assetId: raw.assetId,
    manifestDigest: raw.manifestDigest,
    observation,
  });
}
export function decodeBatchStatus(raw: unknown): BatchStatus {
  if (
    !isRecord(raw) ||
    raw.version !== 3 ||
    !uploadId(raw.batchRequestId) ||
    !uploadDigest(raw.batchRequestHash) ||
    (raw.batchId !== null && !uploadId(raw.batchId)) ||
    !batchRevision(raw.revision) ||
    !uploadInteger(raw.serverNow) ||
    !Array.isArray(raw.members) ||
    raw.members.length > 9 ||
    !Array.isArray(raw.retiring) ||
    raw.retiring.length > 9
  )
    uploadInvalid();
  const batchIdentity =
    raw.batchIdentity === null ? null : decodeBatchIdentity(raw.batchIdentity);
  if (
    (batchIdentity && batchIdentity.batchRequestId !== raw.batchRequestId) ||
    (!batchIdentity && (raw.status !== 'terminal' || raw.batchId !== null))
  )
    uploadInvalid();
  const orderedMemberIds = batchIds(raw.orderedMemberIds),
    members = raw.members.map(decodeMemberStatus),
    retiring = raw.retiring.map(decodeMemberStatus);
  const all = [...members, ...retiring];
  if (
    new Set(all.map((m) => m.memberId)).size !== all.length ||
    new Set(all.map((m) => m.requestId)).size !== all.length ||
    new Set(members.map((m) => m.sourceSlot)).size !== members.length ||
    !batchEqual(
      orderedMemberIds,
      members.map((m) => m.memberId),
    ) ||
    all.some((m) => m.batchId !== raw.batchId)
  )
    uploadInvalid();
  const base = {
    version: 3 as const,
    batchIdentity,
    batchRequestId: raw.batchRequestId,
    batchRequestHash: raw.batchRequestHash,
    batchId: raw.batchId,
    revision: raw.revision,
    serverNow: raw.serverNow,
    orderedMemberIds,
    members: Object.freeze(members),
    retiring: Object.freeze(retiring),
  };
  const keys = [
    'version',
    'batchIdentity',
    'batchRequestId',
    'batchRequestHash',
    'batchId',
    'revision',
    'serverNow',
    'orderedMemberIds',
    'members',
    'retiring',
    'status',
  ];
  if (
    raw.status === 'editing' ||
    raw.status === 'preparing' ||
    raw.status === 'cancelling'
  ) {
    uploadExact(raw, keys);
    return Object.freeze({ ...base, status: raw.status });
  }
  if (raw.status === 'terminal') {
    uploadExact(raw, [...keys, 'reason', 'cleanup']);
    if (
      raw.reason !== 'cancelled' ||
      !['pending', 'retained', 'confirmed'].includes(String(raw.cleanup))
    )
      uploadInvalid();
    return Object.freeze({
      ...base,
      status: 'terminal',
      reason: 'cancelled',
      cleanup: raw.cleanup as 'pending' | 'retained' | 'confirmed',
    });
  }
  if (raw.status === 'unavailable') {
    uploadExact(raw, [...keys, 'reason', 'retryable']);
    if (
      raw.reason !== 'MEDIA_UNAVAILABLE' ||
      typeof raw.retryable !== 'boolean'
    )
      uploadInvalid();
    return Object.freeze({
      ...base,
      status: 'unavailable',
      reason: 'MEDIA_UNAVAILABLE',
      retryable: raw.retryable,
    });
  }
  const orderedAssets = decodeOrderedAssets(raw.orderedAssets);
  if (
    !batchEqual(
      orderedAssets.map((a) => a.memberId),
      orderedMemberIds,
    ) ||
    retiring.some((m) => m.observation.status !== 'terminal') ||
    orderedAssets.some(
      (a) =>
        !members.some(
          (m) =>
            m.memberId === a.memberId &&
            m.assetId === a.assetId &&
            m.manifestDigest === a.manifestDigest,
        ),
    )
  )
    uploadInvalid();
  if (raw.status === 'ready_unbound') {
    uploadExact(raw, [
      ...keys,
      'orderedAssets',
      'draftExpiresAt',
      'bindBefore',
    ]);
    if (
      !uploadInteger(raw.draftExpiresAt) ||
      !uploadInteger(raw.bindBefore) ||
      retiring.length !== 0 ||
      members.some((m) => m.observation.status !== 'ready_unbound') ||
      raw.bindBefore !==
        Math.min(
          raw.draftExpiresAt,
          ...members.map((m) =>
            m.observation.status === 'ready_unbound'
              ? m.observation.bindBefore
              : 0,
          ),
        )
    )
      uploadInvalid();
    return Object.freeze({
      ...base,
      status: 'ready_unbound',
      orderedAssets,
      draftExpiresAt: raw.draftExpiresAt,
      bindBefore: raw.bindBefore,
    });
  }
  const publication = decodePublicationReference(raw.publication);
  if (!uploadDigest(raw.attachmentPlanDigest)) uploadInvalid();
  const sealed = {
    publication,
    attachmentPlanDigest: raw.attachmentPlanDigest,
    orderedAssets,
  };
  if (raw.status === 'publication_pending') {
    uploadExact(raw, [
      ...keys,
      'publication',
      'attachmentPlanDigest',
      'orderedAssets',
    ]);
    return Object.freeze({ ...base, status: 'publication_pending', ...sealed });
  }
  if (raw.status !== 'bound_history') uploadInvalid();
  uploadExact(raw, [
    ...keys,
    'publication',
    'attachmentPlanDigest',
    'orderedAssets',
    'parent',
    'bindings',
  ]);
  uploadExact(raw.parent, [
    'ownerKind',
    'resourceKind',
    'resourceId',
    'contentVersion',
  ]);
  if (
    raw.parent.ownerKind !== 'community' ||
    raw.parent.resourceKind !== 'post' ||
    !uploadId(raw.parent.resourceId) ||
    raw.parent.contentVersion !== 1 ||
    !Array.isArray(raw.bindings) ||
    raw.bindings.length !== orderedAssets.length
  )
    uploadInvalid();
  const bindings = raw.bindings.map((b, n) => {
    uploadExact(b, [
      'memberId',
      'assetId',
      'manifestDigest',
      'bindingId',
      'ordinal',
      'attachmentState',
    ]);
    const expected = orderedAssets[n]!,
      observation = members[n]!.observation;
    if (
      observation.status !== 'bound_history' ||
      observation.bindingId !== b.bindingId ||
      !batchEqual(observation.publication, publication) ||
      observation.attachmentState !== b.attachmentState
    )
      uploadInvalid();
    if (
      b.memberId !== expected.memberId ||
      b.assetId !== expected.assetId ||
      b.manifestDigest !== expected.manifestDigest ||
      !uploadId(b.bindingId) ||
      b.ordinal !== n ||
      (b.attachmentState !== 'active' && b.attachmentState !== 'detached')
    )
      uploadInvalid();
    return Object.freeze({
      ...expected,
      bindingId: b.bindingId,
      ordinal: n,
      attachmentState: b.attachmentState,
    });
  });
  if (new Set(bindings.map((b) => b.bindingId)).size !== bindings.length)
    uploadInvalid();
  return Object.freeze({
    ...base,
    status: 'bound_history',
    ...sealed,
    parent: Object.freeze({
      ownerKind: 'community',
      resourceKind: 'post',
      resourceId: raw.parent.resourceId,
      contentVersion: 1,
    }),
    bindings: Object.freeze(bindings),
  });
}
export function decodeBatchRecovery(raw: unknown): BatchRecovery {
  if (!isRecord(raw) || raw.version !== 3) uploadInvalid();
  if (raw.state === 'recorded') {
    uploadExact(raw, ['version', 'state', 'status']);
    return Object.freeze({
      version: 3,
      state: 'recorded',
      status: decodeBatchStatus(raw.status),
    });
  }
  uploadExact(raw, ['version', 'state', 'batchRequestId', 'serverNow']);
  if (
    raw.state !== 'not_recorded' ||
    !uploadId(raw.batchRequestId) ||
    !uploadInteger(raw.serverNow)
  )
    uploadInvalid();
  return Object.freeze({
    version: 3,
    state: 'not_recorded',
    batchRequestId: raw.batchRequestId,
    serverNow: raw.serverNow,
  });
}
export function decodeBatchPublicationRecovery(
  raw: unknown,
): BatchPublicationRecovery {
  if (!isRecord(raw) || raw.version !== 3) uploadInvalid();
  if (raw.state === 'recorded')
    return decodeBatchRecovery(raw) as Extract<
      BatchRecovery,
      { state: 'recorded' }
    >;
  uploadExact(raw, ['version', 'state', 'serverNow']);
  if (raw.state !== 'unknown' || !uploadInteger(raw.serverNow)) uploadInvalid();
  return Object.freeze({
    version: 3,
    state: 'unknown',
    serverNow: raw.serverNow,
  });
}
export interface BatchGateway {
  prepare(
    identity: BatchIdentity,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<BatchStatus>;
  recover(
    requestId: string,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<BatchRecovery>;
  cancel(
    requestId: string,
    hash: string,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<BatchRecovery>;
  command(
    batchId: string,
    command: BatchCommand,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<BatchStatus>;
  recoverPublication(
    publication: PublicationReference,
    assetIds: readonly string[],
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<BatchPublicationRecovery>;
  fencePublication(
    batchId: string,
    publication: PublicationReference,
    assetIds: readonly string[],
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<BatchFenceResult>;
  prepareMember(
    batchId: string,
    input: MemberPrepare,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<MemberStatus>;
  memberStatus(
    intentId: string,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<MemberStatus>;
  grant(
    intentId: string,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<UploadGrant>;
  finalize(
    intentId: string,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<MemberStatus>;
}
