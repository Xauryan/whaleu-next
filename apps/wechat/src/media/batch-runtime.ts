import { ClientError } from '../api/errors';
import type { SessionStore } from '../auth/session';
import { decodeReceipt, type Receipt } from '../community/contract';
import type { CommunityGateway } from '../community/gateway';
import type {
  PendingAttempt,
  PendingAttemptStore,
} from '../community/pending-attempt';
import type { PrivateViewLifecycle } from '../identity-privacy/overlay';
import type { Cancellation, Clock } from '../platform/contracts';
import {
  batchEqual,
  attachmentPlanDigest,
  decodeBatchStatus,
  decodeBatchCommand,
  memberRequestHash,
  type BatchGateway,
  type BatchStatus,
} from './batch-engine-contracts';
import {
  PendingBatchStore,
  type PendingBatch,
  type PendingMember,
} from './batch-pending';
import { MediaBatchController, type BatchView } from './batch-controller';
import { batchEngineGateway } from './batch-engine-gateway';
import type { MediaSession } from './contracts';
import type { UploadTransfer } from './upload-contracts';
import {
  batchPublicationReference as mediaPublicationReference,
  identityMatchesAttempt,
  discussionTarget,
  publicationKind,
} from './batch-publication';
import { batchCommandHash } from './batch-engine-contracts';

const writers = new Set<string>();
/** A process-local single writer, not a cross-key or cross-device transaction. */
export async function batchWriter<T>(
  store: PendingBatchStore,
  actor: string,
  action: () => Promise<T>,
): Promise<T> {
  const key = `${store.origin}:${actor}`;
  if (writers.has(key))
    throw new ClientError('business', 'Original batch operation still running');
  writers.add(key);
  try {
    return await action();
  } finally {
    writers.delete(key);
  }
}
export interface BatchRuntimeOptions {
  readonly sessions: SessionStore;
  readonly pending: PendingBatchStore;
  readonly publicationPending: PendingAttemptStore;
  readonly community: Pick<CommunityGateway, 'receipt'>;
  readonly clock: Clock;
  readonly newRequestId: () => Promise<string>;
  readonly gateway?: import('./batch-contracts').BatchGateway;
  readonly discussionGateway?: import('./discussion-batch-contracts').BatchGateway;
  readonly transfer?: UploadTransfer;
  readonly discussionTransfer?: UploadTransfer;
  readonly privateViews?: PrivateViewLifecycle;
}
export interface MediaBatchRuntime {
  modeForActor(actor: string): 'legacy' | 'batch' | 'conflict';
  create(
    render: (view: BatchView) => void,
    operation?: PendingAttempt['operation'],
  ): MediaBatchController;
  reservePublication(attempt: PendingAttempt): void;
  beforePublication(
    attempt: PendingAttempt,
    cancel: Cancellation,
  ): Promise<void>;
  verifyReceipt(
    attempt: PendingAttempt,
    receipt: Receipt,
    cancel: Cancellation,
  ): Promise<Receipt>;
  publicationSettled(attempt: PendingAttempt): void;
}
export function batchSession(
  sessions: SessionStore,
  cancel: Cancellation,
): MediaSession {
  const ticket = sessions.snapshot();
  if (!ticket.credentials)
    throw new ClientError('auth-required', 'Original account required');
  return {
    current: () => {
      sessions.assertCurrent(ticket);
      if (cancel.isCancelled)
        throw new ClientError('cancelled', 'Batch operation interrupted');
      return sessions.snapshot();
    },
  };
}
export function matchBatch(
  record: PendingBatch,
  raw: BatchStatus,
): BatchStatus {
  const status = decodeBatchStatus(raw);
  if (
    status.version !== record.version ||
    (status.version === 4 &&
      record.resolvedPostId &&
      status.resolvedPostId !== record.resolvedPostId) ||
    status.batchRequestId !== record.batchRequestId ||
    status.batchRequestHash !== record.batchRequestHash ||
    (record.batchId && record.batchId !== status.batchId) ||
    (status.batchIdentity &&
      !batchEqual(status.batchIdentity, record.batchIdentity))
  )
    throw new ClientError('protocol', 'Original batch mismatch');
  for (const member of [...status.members, ...status.retiring]) {
    if (
      member.requestHash !==
      memberRequestHash(
        record.actorAccountId,
        record.batchIdentity,
        member.prepare,
      )
    )
      throw new ClientError('protocol', 'Original member mismatch');
  }
  return status;
}
export function observeBatch(
  store: PendingBatchStore,
  record: PendingBatch,
  status: BatchStatus,
  now: number,
): PendingBatch {
  matchBatch(record, status);
  if (!status.batchId) return record;
  const member = (m: BatchStatus['members'][number]): PendingMember => ({
    memberId: m.memberId,
    sourceSlot: m.sourceSlot,
    prepare: m.prepare,
    requestHash: m.requestHash,
    observation: m,
  });
  const removing =
    record.pendingCommand?.kind === 'layout'
      ? record.pendingCommand.payload.removeMemberIds
      : [];
  const members = status.members
    .filter((m) => !removing.includes(m.memberId))
    .map(member);
  const retiring = [
    ...status.retiring,
    ...status.members.filter((m) => removing.includes(m.memberId)),
  ].map(member);
  // A missing in-flight prepare or retirement is unknown, never silently dropped.
  for (const old of record.members)
    if (![...members, ...retiring].some((m) => m.memberId === old.memberId))
      members.push(old);
  for (const old of record.retiring)
    if (
      ![...members, ...retiring].some((m) => m.memberId === old.memberId) &&
      old.observation?.observation.status !== 'terminal'
    )
      retiring.push(old);
  const orderedMemberIds =
    record.pendingCommand?.kind === 'layout'
      ? record.pendingCommand.payload.orderedMemberIds
      : [
          ...status.orderedMemberIds,
          ...record.orderedMemberIds.filter(
            (id) =>
              !status.orderedMemberIds.includes(id) &&
              members.some((m) => m.memberId === id),
          ),
        ];
  return store.update(record, {
    batchId: status.batchId,
    ...(status.version === 4 ? { resolvedPostId: status.resolvedPostId } : {}),
    serverRevision: status.revision,
    members,
    retiring,
    orderedMemberIds,
    lastObservedAt: Math.max(now, record.lastObservedAt),
  });
}
/** Community remains the only durable publication-body owner. This service stores
 * only reference + exact ordered assets, and verifies both keys at every dispatch. */
export class BatchPublicationCoordinator {
  readonly gateway: BatchGateway;
  constructor(readonly options: BatchRuntimeOptions) {
    this.gateway = batchEngineGateway(options);
  }
  private actor(attempt: PendingAttempt): void {
    if (
      this.options.sessions.snapshot().credentials?.accountId !==
      attempt.accountId
    )
      throw new ClientError('stale-session', 'Original batch actor required');
  }
  private matches(record: PendingBatch, attempt: PendingAttempt): void {
    this.actor(attempt);
    if (
      !identityMatchesAttempt(
        record.batchIdentity,
        attempt,
        record.resolvedPostId,
      ) ||
      !batchEqual(
        attempt.payload.imageAssetIds,
        record.publication?.orderedAssets.map((a) => a.assetId),
      ) ||
      !batchEqual(
        record.publication?.reference,
        mediaPublicationReference(attempt),
      )
    )
      throw new ClientError('protocol', 'Publication and batch do not match');
  }
  reserve(attempt: PendingAttempt): void {
    this.options.pending.assertBatchAdmission(attempt.accountId);
    if (!attempt.payload.imageAssetIds.length) {
      if (this.options.pending.load(attempt.accountId))
        throw new ClientError(
          'business',
          'Cancel the complete original batch before text-only publication',
        );
      return;
    }
    this.actor(attempt);
    const { pending, clock } = this.options;
    const record = pending.load(attempt.accountId);
    if (
      !record?.batchId ||
      !record.serverRevision ||
      record.pendingCommand ||
      record.retiring.some(
        (m) => m.observation?.observation.status !== 'terminal',
      )
    )
      throw new ClientError(
        'business',
        'Original batch must be recovered first',
      );
    if (record.publication) {
      this.matches(record, attempt);
      pending.assertStored(record);
      return;
    }
    const assets = record.orderedMemberIds.map((id) => {
      const member = record.members.find((m) => m.memberId === id);
      if (
        member?.observation?.observation.status !== 'ready_unbound' ||
        !member.observation.assetId ||
        !member.observation.manifestDigest
      )
        throw new ClientError('business', 'Every selected image must be ready');
      return {
        memberId: id,
        assetId: member.observation.assetId,
        manifestDigest: member.observation.manifestDigest,
      };
    });
    if (
      !assets.length ||
      !identityMatchesAttempt(
        record.batchIdentity,
        attempt,
        record.resolvedPostId,
      ) ||
      !batchEqual(
        assets.map((a) => a.assetId),
        attempt.payload.imageAssetIds,
      )
    )
      throw new ClientError('protocol', 'Partial publication is forbidden');
    const sealRevision = String(BigInt(record.serverRevision) + 1n);
    pending.update(record, {
      publication: {
        reference: mediaPublicationReference(attempt),
        orderedAssets: assets,
        attachmentPlanDigest: attachmentPlanDigest(
          record.batchId,
          sealRevision,
          assets,
          record.version,
        ),
        sealRevision,
        linkState: 'reserved',
        dispatchState: 'not_dispatched',
        receiptHint: null,
        history: null,
        cancellation: null,
      },
      lastObservedAt: Math.max(clock.now(), record.lastObservedAt),
    });
  }
  async before(attempt: PendingAttempt, cancel: Cancellation): Promise<void> {
    this.options.pending.assertBatchAdmission(attempt.accountId);
    if (!attempt.payload.imageAssetIds.length) {
      if (this.options.pending.load(attempt.accountId))
        throw new ClientError(
          'business',
          'Complete batch cancellation before text-only publication',
        );
      return;
    }
    await batchWriter(this.options.pending, attempt.accountId, async () => {
      const { pending, publicationPending, clock } = this.options;
      const session = batchSession(this.options.sessions, cancel);
      let record = pending.load(attempt.accountId);
      if (!record) {
        // A surviving Community key is sufficient to find the exact original
        // receipt before trying metadata recovery of a missing Media key.
        try {
          const receipt = await this.options.community.receipt(
            attempt.payload.clientRequestId,
            cancel,
          );
          session.current();
          await this.verify(attempt, receipt, cancel, false);
          throw new ClientError(
            'business',
            'Original publication has a receipt; settle it',
          );
        } catch (error) {
          if (
            !(error instanceof ClientError) ||
            error.details.serverCode !== 'REQUEST_NOT_FOUND'
          )
            throw error;
        }
        record = await this.restore(attempt, session, cancel);
      }
      this.matches(record, attempt);
      if (!batchEqual(publicationPending.load(attempt.accountId), attempt))
        throw new ClientError(
          'storage',
          'Publication body was not reliably frozen',
        );
      pending.assertStored(record);
      const newlyReserved = record.publication!.linkState === 'reserved';
      if (newlyReserved)
        record = pending.update(record, {
          publication: { ...record.publication!, linkState: 'linked' },
          lastObservedAt: Math.max(clock.now(), record.lastObservedAt),
        });
      if (record.publication!.cancellation)
        throw new ClientError('business', 'Original publication was cancelled');
      if (record.publication!.linkState !== 'linked')
        throw new ClientError('business', 'Publication is settling');
      // Even a not_dispatched hint does not prove a previous process sent nothing.
      // Before retrying a previously sealed command, establish receipt then history.
      if (!newlyReserved) {
        try {
          const receipt = await this.options.community.receipt(
            attempt.payload.clientRequestId,
            cancel,
          );
          session.current();
          await this.verify(attempt, receipt, cancel, false);
          throw new ClientError(
            'business',
            'Original publication already has a receipt; settle it',
          );
        } catch (error) {
          if (
            !(error instanceof ClientError) ||
            error.details.serverCode !== 'REQUEST_NOT_FOUND'
          )
            throw error;
        }
      }
      if (!record.pendingCommand) {
        if (record.phase === 'publication_uncertain') {
          const recovery = await this.gateway.recover(
            record.batchRequestId,
            session,
            cancel,
          );
          if (
            recovery.state !== 'recorded' ||
            recovery.status.status !== 'publication_pending'
          )
            throw new ClientError(
              'business',
              'Original seal must be recovered',
            );
          this.matchSealed(record, recovery.status);
        } else {
          const payload = {
            commandId: await this.options.newRequestId(),
            expectedRevision: record.serverRevision!,
            orderedMemberIds: record.orderedMemberIds,
            publication: record.publication!.reference,
          };
          session.current();
          const command = { kind: 'seal' as const, payload };
          record = pending.update(record, {
            phase: 'seal_uncertain',
            pendingCommand: {
              ...command,
              commandHash: batchCommandHash(
                record.batchId!,
                command,
                record.version,
              ),
            },
          });
        }
      }
      if (record.pendingCommand) {
        if (record.pendingCommand.kind !== 'seal')
          throw new ClientError(
            'business',
            'Original metadata command must finish first',
          );
        pending.assertStored(record);
        const status = await this.gateway.command(
          record.batchId!,
          decodeBatchCommand(
            record.pendingCommand.kind,
            record.pendingCommand.payload,
            record.version,
          ),
          session,
          cancel,
        );
        session.current();
        if (
          status.status !== 'publication_pending' &&
          status.status !== 'bound_history'
        )
          throw new ClientError('business', 'Entire batch could not be sealed');
        this.matchSealed(record, status);
        record = observeBatch(pending, record, status, clock.now());
        record = pending.update(record, {
          phase: 'publication_uncertain',
          pendingCommand: null,
        });
      }
      this.matches(record, attempt);
      if (!batchEqual(publicationPending.load(attempt.accountId), attempt))
        throw new ClientError('storage', 'Publication body changed');
      session.current();
      pending.update(record, {
        phase: 'publication_uncertain',
        publication: {
          ...record.publication!,
          dispatchState: 'dispatch_uncertain',
        },
      });
    });
  }
  private matchSealed(
    record: PendingBatch,
    status: Extract<
      BatchStatus,
      { status: 'publication_pending' | 'bound_history' }
    >,
  ): void {
    matchBatch(record, status);
    if (
      !record.publication ||
      !batchEqual(status.publication, record.publication.reference) ||
      !batchEqual(status.orderedAssets, record.publication.orderedAssets) ||
      status.attachmentPlanDigest !== record.publication.attachmentPlanDigest
    )
      throw new ClientError('protocol', 'Exact sealed plan mismatch');
  }
  async restore(
    attempt: PendingAttempt,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<PendingBatch> {
    const recovered = await this.gateway.recoverPublication(
      mediaPublicationReference(attempt),
      attempt.payload.imageAssetIds,
      session,
      cancel,
      discussionTarget(attempt),
    );
    session.current();
    if (recovered.state !== 'recorded')
      throw new ClientError('business', 'Exact original batch remains unknown');
    const status = recovered.status,
      identity = status.batchIdentity,
      { pending, clock } = this.options;
    if (
      !identity ||
      !status.batchId ||
      (status.status !== 'publication_pending' &&
        status.status !== 'bound_history' &&
        status.status !== 'ready_unbound')
    )
      throw new ClientError('business', 'Exact original batch remains unknown');
    if (
      !identityMatchesAttempt(
        identity,
        attempt,
        status.version === 4 ? status.resolvedPostId : undefined,
      ) ||
      !batchEqual(
        status.orderedAssets.map((a) => a.assetId),
        attempt.payload.imageAssetIds,
      )
    )
      throw new ClientError('protocol', 'Recovered publication mismatch');
    const sealed =
      status.status === 'publication_pending' ||
      status.status === 'bound_history';
    if (
      sealed &&
      !batchEqual(status.publication, mediaPublicationReference(attempt))
    )
      throw new ClientError('protocol', 'Recovered reference mismatch');
    let record = pending.freeze(attempt.accountId, identity, clock.now());
    record = observeBatch(pending, record, status, clock.now());
    const sealRevision = sealed
      ? status.revision
      : String(BigInt(status.revision) + 1n);
    record = pending.update(record, {
      phase: sealed ? 'publication_uncertain' : 'editing',
      publication: {
        reference: mediaPublicationReference(attempt),
        orderedAssets: status.orderedAssets,
        attachmentPlanDigest: sealed
          ? status.attachmentPlanDigest
          : attachmentPlanDigest(
              status.batchId,
              sealRevision,
              status.orderedAssets,
              status.version,
            ),
        sealRevision,
        linkState: sealed ? 'linked' : 'reserved',
        dispatchState: 'dispatch_uncertain',
        receiptHint: null,
        history: null,
        cancellation: null,
      },
    });
    this.matches(record, attempt);
    return record;
  }
  async verify(
    attempt: PendingAttempt,
    raw: Receipt,
    cancel: Cancellation,
    lock = true,
  ): Promise<Receipt> {
    if (!attempt.payload.imageAssetIds.length) return decodeReceipt(raw);
    if (lock)
      return batchWriter(this.options.pending, attempt.accountId, () =>
        this.verify(attempt, raw, cancel, false),
      );
    const receipt = decodeReceipt(raw),
      session = batchSession(this.options.sessions, cancel),
      { pending, clock } = this.options;
    let record = pending.load(attempt.accountId);
    if (!record) record = await this.restore(attempt, session, cancel);
    this.matches(record, attempt);
    if (
      receipt.requestId !== record.publication!.reference.clientRequestId ||
      receipt.operation !== attempt.operation
    )
      throw new ClientError('protocol', 'Receipt mismatch');
    if (
      ['settlement_verified', 'publication_cleared'].includes(
        record.publication!.linkState,
      )
    ) {
      if (!batchEqual(receipt, record.publication!.receiptHint))
        throw new ClientError('protocol', 'Settled receipt changed');
      pending.assertStored(record);
      return receipt;
    }
    // Original receipt was obtained before any batch/member history read.
    const recovered = await this.gateway.recover(
      record.batchRequestId,
      session,
      cancel,
    );
    session.current();
    if (recovered.state !== 'recorded')
      throw new ClientError('business', 'Original batch history unavailable');
    const status = matchBatch(record, recovered.status);
    if (receipt.outcome === 'created') {
      if (
        status.status !== 'bound_history' ||
        status.parent.resourceId !== receipt.resourceId ||
        status.parent.resourceKind !==
          publicationKind(record.publication!.reference)
      )
        throw new ClientError('protocol', 'Complete bound history is required');
      this.matchSealed(record, status);
      record = observeBatch(pending, record, status, clock.now());
      pending.update(record, {
        phase: 'settlement_pending',
        pendingCommand: null,
        publication: {
          ...record.publication!,
          linkState: 'settlement_verified',
          dispatchState: 'receipt_seen',
          receiptHint: receipt,
          history: status,
        },
      });
    } else {
      if (status.status === 'bound_history')
        throw new ClientError('protocol', 'Receipt and bound history disagree');
      record = observeBatch(pending, record, status, clock.now());
      // Reopen permission is the authoritative non-created receipt, never 404.
      if (record.pendingCommand && record.pendingCommand.kind !== 'reopen') {
        if (record.pendingCommand.kind !== 'seal')
          throw new ClientError(
            'business',
            'Original layout must be recovered',
          );
        record = pending.update(record, {
          pendingCommand: null,
          phase: 'publication_uncertain',
        });
      }
      if (!record.pendingCommand) {
        const command = {
          kind: 'reopen' as const,
          payload: {
            commandId: await this.options.newRequestId(),
            expectedRevision: status.revision,
            publication: record.publication!.reference,
          },
        };
        session.current();
        record = pending.update(record, {
          phase: 'layout_uncertain',
          pendingCommand: {
            ...command,
            commandHash: batchCommandHash(
              record.batchId!,
              command,
              record.version,
            ),
          },
        });
      }
      const reopened = await this.gateway.command(
        record.batchId!,
        decodeBatchCommand(
          record.pendingCommand!.kind,
          record.pendingCommand!.payload,
          record.version,
        ),
        session,
        cancel,
      );
      session.current();
      if (!['editing', 'preparing', 'ready_unbound'].includes(reopened.status))
        throw new ClientError(
          'business',
          'Original publication could not reopen',
        );
      record = observeBatch(pending, record, reopened, clock.now());
      pending.update(record, {
        phase: 'settlement_pending',
        pendingCommand: null,
        publication: {
          ...record.publication!,
          linkState: 'settlement_verified',
          dispatchState: 'receipt_seen',
          receiptHint: receipt,
          history: null,
        },
      });
    }
    return receipt;
  }
  settled(attempt: PendingAttempt): void {
    if (!attempt.payload.imageAssetIds.length) return;
    const { pending, publicationPending } = this.options;
    let record = pending.load(attempt.accountId);
    if (!record) return;
    this.matches(record, attempt);
    if (
      publicationPending.load(attempt.accountId) ||
      !record.publication ||
      !['settlement_verified', 'publication_cleared'].includes(
        record.publication.linkState,
      )
    )
      throw new ClientError('storage', 'Community settlement is not verified');
    if (record.publication.linkState !== 'publication_cleared')
      record = pending.update(record, {
        publication: {
          ...record.publication,
          linkState: 'publication_cleared',
        },
      });
    const history = record.publication!.history;
    if (history) pending.settle(record, history);
    else pending.update(record, { phase: 'editing', publication: null });
  }
}
export function createMediaBatchRuntime(
  options: BatchRuntimeOptions,
): MediaBatchRuntime {
  const publication = new BatchPublicationCoordinator(options);
  return {
    modeForActor: (actor) => options.pending.modeForActor(actor),
    create: (render, operation = 'publish_post') =>
      new MediaBatchController(options, publication, render, operation),
    reservePublication: (attempt) => publication.reserve(attempt),
    beforePublication: (attempt, cancel) => publication.before(attempt, cancel),
    verifyReceipt: (attempt, receipt, cancel) =>
      publication.verify(attempt, receipt, cancel),
    publicationSettled: (attempt) => publication.settled(attempt),
  };
}
