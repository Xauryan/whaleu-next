import { ClientError } from '../api/errors';
import type { SessionTicket } from '../auth/session';
import { decodeReceipt } from '../community/contract';
import { cancellable } from '../platform/cancellable';
import { Cancellation } from '../platform/contracts';
import type { LocalMediaFile, MediaSession, MediaTarget } from './contracts';
import {
  batchCommandHash,
  batchEqual,
  decodeBatchFenceResult,
  decodeBatchCommand,
  decodeMemberPrepare,
  decodeMemberStatus,
  memberRequestHash,
  type BatchStatus,
  type MemberStatus,
} from './batch-contracts';
import type { PendingBatch, PendingMember } from './batch-pending';
import {
  batchSession,
  batchWriter,
  matchBatch,
  observeBatch,
  type BatchPublicationCoordinator,
  type BatchRuntimeOptions,
} from './batch-runtime';
import { mediaPublicationReference } from './upload-runtime';
export interface BatchMemberView {
  readonly memberId: string;
  readonly index: number;
  readonly status: string;
}
export interface BatchView {
  readonly status:
    | 'idle'
    | 'selecting'
    | 'uploading'
    | 'processing'
    | 'ready'
    | 'unavailable'
    | 'publication_pending'
    | 'cancel_pending';
  readonly members: readonly BatchMemberView[];
  readonly ready: number;
  readonly selected: number;
  readonly retiring: number;
  readonly progress: number;
  readonly canAdd: boolean;
  readonly canEdit: boolean;
}
export const initialBatchView = (): BatchView => ({
  status: 'idle',
  members: [],
  ready: 0,
  selected: 0,
  retiring: 0,
  progress: 0,
  canAdd: false,
  canEdit: false,
});
interface Work {
  readonly ticket: SessionTicket;
  readonly session: MediaSession;
  readonly cancel: Cancellation;
  record: PendingBatch | null;
  file: LocalMediaFile | null;
  fileMemberId: string | null;
}
/** One selected file and one actor writer. Ready members keep every immutable
 * recovery identity, but release local bytes before another image is selected. */
export class MediaBatchController {
  private work: Work | null = null;
  private running: Promise<void> | null = null;
  private disposed = false;
  private view = initialBatchView();
  private readonly unsubscribe: () => void;
  private readonly stopPrivate: () => void;
  constructor(
    private readonly options: BatchRuntimeOptions,
    private readonly publication: BatchPublicationCoordinator,
    private readonly render: (view: BatchView) => void,
  ) {
    this.unsubscribe = options.sessions.subscribe(() => {
      if (!this.work) return;
      try {
        options.sessions.assertCurrent(this.work.ticket);
      } catch {
        this.hide();
      }
    });
    this.stopPrivate =
      options.privateViews?.subscribe((actor) => {
        if (!actor || actor === this.work?.ticket.credentials?.accountId)
          this.hide();
      }) ?? (() => undefined);
  }
  get available(): boolean {
    return !!this.options.transfer && !!this.options.gateway;
  }
  snapshot(): BatchView {
    return this.view;
  }
  private current(work: Work): void {
    work.session.current();
    if (this.work !== work || this.disposed)
      throw new ClientError('cancelled', 'Batch view replaced');
  }
  private getWork(): Work {
    if (this.disposed) throw new ClientError('cancelled', 'Batch view closed');
    if (this.work) {
      this.current(this.work);
      this.work.record = this.options.pending.load(
        this.work.ticket.credentials!.accountId,
      );
      return this.work;
    }
    const ticket = this.options.sessions.snapshot(),
      cancel = new Cancellation();
    if (!ticket.credentials)
      throw new ClientError('auth-required', 'Original account required');
    const work: Work = {
      ticket,
      cancel,
      session: batchSession(this.options.sessions, cancel),
      record: this.options.pending.load(ticket.credentials.accountId),
      file: null,
      fileMemberId: null,
    };
    this.work = work;
    return work;
  }
  private change(
    work: Work,
    patch: Parameters<BatchRuntimeOptions['pending']['update']>[1],
  ): PendingBatch {
    this.current(work);
    if (!work.record)
      throw new ClientError('protocol', 'Missing batch journal');
    work.record = this.options.pending.update(work.record, {
      ...patch,
      lastObservedAt: Math.max(
        this.options.clock.now(),
        work.record.lastObservedAt,
      ),
    });
    this.publish(work);
    return work.record;
  }
  private async request<T>(work: Work, action: () => Promise<T>): Promise<T> {
    this.current(work);
    if (work.record) this.options.pending.assertStored(work.record);
    const result = await cancellable(action(), work.cancel);
    this.current(work);
    return result;
  }
  private run(action: (work: Work) => Promise<void>): Promise<void> {
    if (this.running) return this.running;
    let work: Work;
    try {
      work = this.getWork();
    } catch (error) {
      return Promise.reject(error);
    }
    const task = batchWriter(
      this.options.pending,
      work.ticket.credentials!.accountId,
      async () => {
        try {
          await action(work);
          this.current(work);
          this.publish(work);
        } catch (error) {
          if (this.work === work && !work.cancel.isCancelled)
            this.publish(
              work,
              work.record?.publication
                ? 'publication_pending'
                : work.record?.phase === 'cancel_uncertain'
                  ? 'cancel_pending'
                  : 'unavailable',
            );
          throw error;
        }
      },
    );
    this.running = task;
    void task.then(
      () => {
        if (this.running === task) this.running = null;
      },
      () => {
        if (this.running === task) this.running = null;
      },
    );
    return task;
  }
  select(target: MediaTarget): Promise<void> {
    return this.run(async (work) => {
      this.options.pending.assertBatchAdmission(
        work.ticket.credentials!.accountId,
      );
      if (!this.available)
        throw new ClientError('configuration', 'Batch upload unavailable');
      if (work.record) {
        if (work.record.batchIdentity.spaceId !== target.spaceId)
          throw new ClientError('business', 'Recover the original draft first');
        await this.reconcile(work);
      }
      if (
        work.record &&
        (work.record.publication ||
          work.record.pendingCommand ||
          work.record.phase === 'cancel_uncertain' ||
          work.record.members.length >= 9 ||
          work.record.retiring.some(
            (m) => m.observation?.observation.status !== 'terminal',
          ) ||
          work.record.members.some(
            (m) => m.observation?.observation.status !== 'ready_unbound',
          ))
      )
        throw new ClientError(
          'business',
          'Resolve every selected image before adding another',
        );
      if (work.file)
        throw new ClientError('business', 'Original file is still in use');
      this.publish(work, 'selecting');
      const transfer = this.options.transfer!;
      const received = transfer
        .pick(work.session, work.cancel)
        .then(async (file) => {
          try {
            this.current(work);
          } catch (error) {
            await transfer.remove(file);
            throw error;
          }
          work.file = file;
          return file;
        });
      const file = await cancellable(received, work.cancel);
      try {
        const inspected = await this.request(work, () =>
          transfer.inspect(file, work.session, work.cancel),
        );
        if (inspected.frameCount !== 'unknown' && inspected.frameCount !== 1)
          throw new ClientError('protocol', 'Only still images are accepted');
        if (!work.record) {
          const batchRequestId = await this.request(
            work,
            this.options.newRequestId,
          );
          work.record = this.options.pending.freeze(
            work.ticket.credentials!.accountId,
            {
              version: 1,
              batchRequestId,
              draftId: target.draftId,
              spaceId: target.spaceId,
              purpose: 'community-post-images',
            },
            this.options.clock.now(),
          );
        }
        const memberId = await this.request(work, this.options.newRequestId),
          clientRequestId = await this.request(work, this.options.newRequestId);
        const sourceSlot = Array.from({ length: 9 }, (_, n) => n).find(
          (slot) => !work.record!.members.some((m) => m.sourceSlot === slot),
        );
        if (sourceSlot === undefined)
          throw new ClientError('business', 'Nine image limit reached');
        const prepare = decodeMemberPrepare({
          memberId,
          clientRequestId,
          sourceSlot,
          declaration: {
            mime: inspected.mime,
            bytes: inspected.bytes,
            sha256: inspected.sha256,
          },
        });
        const member: PendingMember = {
          memberId,
          sourceSlot,
          prepare,
          requestHash: memberRequestHash(
            work.record.actorAccountId,
            work.record.batchIdentity,
            prepare,
          ),
          observation: null,
        };
        this.change(work, {
          phase: 'editing',
          members: [...work.record.members, member],
          orderedMemberIds: [...work.record.orderedMemberIds, memberId],
        });
        work.fileMemberId = memberId;
        // The complete local member identity is durable before batch or member prepare.
        await this.reconcile(work);
      } catch (error) {
        // A failed/unknown member remains in the WAL; releasing bytes is not removal.
        await this.releaseFile(work);
        throw error;
      }
    });
  }
  start(): Promise<void> {
    return this.recover();
  }
  recover(): Promise<void> {
    return this.run((work) => this.reconcile(work));
  }
  private async reconcile(work: Work): Promise<void> {
    if (!work.record) return;
    if (work.record.publication) {
      await this.recoverPublication(work);
      return;
    }
    const recovered = await this.request(work, () =>
      this.publication.gateway.recover(
        work.record!.batchRequestId,
        work.session,
        work.cancel,
      ),
    );
    let status: BatchStatus;
    if (work.record.phase === 'cancel_uncertain') {
      await this.cancelBatch(work);
      return;
    }
    if (recovered.state === 'not_recorded') {
      status = await this.request(work, () =>
        this.publication.gateway.prepare(
          work.record!.batchIdentity,
          work.session,
          work.cancel,
        ),
      );
    } else status = recovered.status;
    this.observe(work, status);
    if (status.status === 'terminal') {
      this.options.pending.settle(work.record!, status);
      work.record = null;
      await this.releaseFile(work);
      return;
    }
    if (
      status.status === 'bound_history' ||
      status.status === 'publication_pending'
    )
      throw new ClientError(
        'business',
        'Recover original publication before editing',
      );
    if (work.record!.pendingCommand) {
      const command = work.record!.pendingCommand;
      if (command.kind !== 'layout')
        throw new ClientError(
          'business',
          'Original publication command requires recovery',
        );
      const result = await this.request(work, () =>
        this.publication.gateway.command(
          work.record!.batchId!,
          decodeBatchCommand(command.kind, command.payload),
          work.session,
          work.cancel,
        ),
      );
      this.observe(work, result);
      if (
        !batchEqual(result.orderedMemberIds, command.payload.orderedMemberIds)
      )
        throw new ClientError(
          'protocol',
          'Layout response differs from full desired order',
        );
      this.change(work, { pendingCommand: null, phase: 'editing' });
      // Command replay is its original snapshot. Read again before trusting current readiness.
      const latest = await this.request(work, () =>
        this.publication.gateway.recover(
          work.record!.batchRequestId,
          work.session,
          work.cancel,
        ),
      );
      if (latest.state !== 'recorded')
        throw new ClientError('business', 'Current batch is unknown');
      this.observe(work, latest.status);
    }
    await this.confirmRetirements(work);
    for (const original of [...work.record!.members]) {
      const current = work.record!.members.find(
        (m) => m.memberId === original.memberId,
      )!;
      let observed = current.observation;
      if (!observed)
        observed = await this.request(work, () =>
          this.publication.gateway.prepareMember(
            work.record!.batchId!,
            current.prepare,
            work.session,
            work.cancel,
          ),
        );
      else
        observed = await this.request(work, () =>
          this.publication.gateway.memberStatus(
            observed!.intentId,
            work.session,
            work.cancel,
          ),
        );
      await this.advance(work, current.memberId, observed);
    }
    const latest = await this.request(work, () =>
      this.publication.gateway.recover(
        work.record!.batchRequestId,
        work.session,
        work.cancel,
      ),
    );
    if (latest.state !== 'recorded')
      throw new ClientError('business', 'Current batch remains unknown');
    this.observe(work, latest.status);
  }
  private async confirmRetirements(work: Work): Promise<void> {
    for (const old of [...work.record!.retiring]) {
      if (old.observation?.observation.status === 'terminal') continue;
      if (!old.observation)
        throw new ClientError(
          'business',
          'Original retirement has no confirmed intent',
        );
      const observation = decodeMemberStatus(
        await this.request(work, () =>
          this.publication.gateway.memberStatus(
            old.observation!.intentId,
            work.session,
            work.cancel,
          ),
        ),
      );
      if (
        observation.memberId !== old.memberId ||
        observation.requestHash !== old.requestHash ||
        observation.batchId !== work.record!.batchId ||
        !batchEqual(observation.prepare, old.prepare)
      )
        throw new ClientError('protocol', 'Retirement observation mismatch');
      this.change(work, {
        retiring: work.record!.retiring.map((m) =>
          m.memberId === old.memberId ? { ...m, observation } : m,
        ),
      });
    }
    // Only explicit terminal observations discharge removal obligations.
    if (
      work.record!.retiring.some(
        (m) => m.observation?.observation.status === 'terminal',
      )
    )
      this.change(work, {
        retiring: work.record!.retiring.filter(
          (m) => m.observation?.observation.status !== 'terminal',
        ),
      });
  }
  private observe(work: Work, raw: BatchStatus): void {
    if (!work.record)
      throw new ClientError('protocol', 'Missing original batch');
    const status = matchBatch(work.record, raw);
    work.record = observeBatch(
      this.options.pending,
      work.record,
      status,
      this.options.clock.now(),
    );
    this.publish(work);
  }
  private observeMember(
    work: Work,
    id: string,
    raw: MemberStatus,
  ): MemberStatus {
    const status = decodeMemberStatus(raw),
      member = work.record!.members.find((m) => m.memberId === id);
    if (
      !member ||
      status.batchId !== work.record!.batchId ||
      status.memberId !== id ||
      status.requestHash !== member.requestHash ||
      !batchEqual(status.prepare, member.prepare)
    )
      throw new ClientError('protocol', 'Member status mismatch');
    this.change(work, {
      members: work.record!.members.map((m) =>
        m.memberId === id ? { ...m, observation: status } : m,
      ),
    });
    return status;
  }
  private async advance(
    work: Work,
    memberId: string,
    raw: MemberStatus,
  ): Promise<void> {
    let member = this.observeMember(work, memberId, raw);
    // Reuses the existing authenticated single-file transfer, hash inspection,
    // grant/observe/finalize lifecycle; no multipart array or resident byte queue.
    for (;;) {
      const status = member.observation;
      if (
        ['ready_unbound', 'terminal', 'bound_history', 'unavailable'].includes(
          status.status,
        )
      ) {
        if (work.fileMemberId === memberId) await this.releaseFile(work);
        return;
      }
      if (status.status === 'processing') {
        if (work.fileMemberId === memberId) await this.releaseFile(work);
        return;
      }
      if (status.status === 'prepared') {
        if (
          status.upload !== 'none' ||
          !work.file ||
          work.fileMemberId !== memberId ||
          !this.options.transfer
        )
          return;
        const transfer = this.options.transfer,
          declaration = member.prepare.declaration;
        const actual = await this.request(work, () =>
          transfer.inspect(work.file!, work.session, work.cancel),
        );
        if (
          actual.bytes !== declaration.bytes ||
          actual.sha256 !== declaration.sha256 ||
          actual.mime !== declaration.mime
        )
          throw new ClientError('protocol', 'Original image bytes changed');
        const grant = await this.request(work, () =>
          this.publication.gateway.grant(
            member.intentId,
            work.session,
            work.cancel,
          ),
        );
        if (
          grant.intentId !== member.intentId ||
          grant.expectedBytes !== declaration.bytes ||
          grant.expectedMime !== declaration.mime ||
          grant.expectedSha256 !== declaration.sha256
        )
          throw new ClientError('protocol', 'Member grant mismatch');
        const handle = transfer.register(grant, work.session);
        this.change(work, { phase: 'editing' }); // CAS/readback before byte mutation.
        this.publish(work, 'uploading');
        await this.request(work, () =>
          transfer.upload(
            handle,
            work.file!,
            (percent) => {
              try {
                this.current(work);
              } catch {
                return;
              }
              if (Number.isFinite(percent))
                this.publish(
                  work,
                  'uploading',
                  Math.max(0, Math.min(100, percent)),
                );
            },
            work.session,
            work.cancel,
          ),
        );
        member = this.observeMember(
          work,
          memberId,
          await this.request(work, () =>
            this.publication.gateway.memberStatus(
              member.intentId,
              work.session,
              work.cancel,
            ),
          ),
        );
        if (member.observation.status === 'prepared')
          throw new ClientError('protocol', 'Upload observation not confirmed');
        continue;
      }
      if (status.status === 'uploaded') {
        this.change(work, { phase: 'editing' });
        this.publish(work, 'processing');
        member = this.observeMember(
          work,
          memberId,
          await this.request(work, () =>
            this.publication.gateway.finalize(
              member.intentId,
              work.session,
              work.cancel,
            ),
          ),
        );
      }
    }
  }
  async publicationAssets(
    spaceId: string,
    cancel: Cancellation,
  ): Promise<readonly string[]> {
    if (this.running)
      throw new ClientError(
        'business',
        'Wait for the current complete batch operation',
      );
    const actor = this.options.sessions.snapshot().credentials?.accountId;
    if (!actor)
      throw new ClientError('auth-required', 'Original account required');
    this.options.pending.assertBatchAdmission(actor);
    let assets: readonly string[] = [];
    await this.run(async (work) => {
      const stop = cancel.subscribe(() => work.cancel.cancel());
      try {
        if (!work.record) return;
        if (
          work.record.batchIdentity.spaceId !== spaceId ||
          work.record.publication ||
          work.record.pendingCommand ||
          work.record.phase === 'cancel_uncertain'
        )
          throw new ClientError('business', 'Original batch must be recovered');
        await this.reconcile(work);
        if (!work.record) return;
        const recovered = await this.request(work, () =>
          this.publication.gateway.recover(
            work.record!.batchRequestId,
            work.session,
            work.cancel,
          ),
        );
        if (
          recovered.state !== 'recorded' ||
          recovered.status.status !== 'ready_unbound'
        )
          throw new ClientError(
            'business',
            'Every selected image must be ready',
          );
        this.observe(work, recovered.status);
        if (
          !batchEqual(
            recovered.status.orderedMemberIds,
            work.record.orderedMemberIds,
          ) ||
          work.record.retiring.some(
            (m) => m.observation?.observation.status !== 'terminal',
          )
        )
          throw new ClientError(
            'business',
            'Unknown members cannot be omitted',
          );
        assets = recovered.status.orderedAssets.map((a) => a.assetId);
      } finally {
        stop();
      }
    });
    return assets;
  }
  remove(memberId: string): Promise<void> {
    return this.layout((record) => ({
      orderedMemberIds: record.orderedMemberIds.filter((id) => id !== memberId),
      removeMemberIds: [memberId],
    }));
  }
  move(memberId: string, direction: -1 | 1): Promise<void> {
    return this.layout((record) => {
      const ids = [...record.orderedMemberIds],
        from = ids.indexOf(memberId),
        to = from + direction;
      if (from < 0 || to < 0 || to >= ids.length)
        throw new ClientError('business', 'Image cannot move there');
      [ids[from], ids[to]] = [ids[to]!, ids[from]!];
      return { orderedMemberIds: ids, removeMemberIds: [] };
    });
  }
  async replace(memberId: string, target: MediaTarget): Promise<void> {
    await this.remove(memberId);
    await this.select(target);
  }
  private layout(
    plan: (record: PendingBatch) => {
      orderedMemberIds: readonly string[];
      removeMemberIds: readonly string[];
    },
  ): Promise<void> {
    return this.run(async (work) => {
      this.options.pending.assertBatchAdmission(
        work.ticket.credentials!.accountId,
      );
      if (!work.record || work.record.publication)
        throw new ClientError('business', 'Original publication is frozen');
      await this.reconcile(work);
      const record = work.record;
      if (
        !record?.batchId ||
        !record.serverRevision ||
        record.pendingCommand ||
        record.publication
      )
        throw new ClientError('business', 'Batch layout is unknown');
      const change = plan(record);
      if (
        change.removeMemberIds.some(
          (id) =>
            !record.members.some((m) => m.memberId === id && m.observation),
        )
      )
        throw new ClientError(
          'business',
          'Recover original member prepare before removal',
        );
      if (record.retiring.length + change.removeMemberIds.length > 9)
        throw new ClientError(
          'business',
          'Confirm prior image cancellations first',
        );
      const command = {
        kind: 'layout' as const,
        payload: {
          commandId: await this.request(work, this.options.newRequestId),
          expectedRevision: record.serverRevision,
          ...change,
        },
      };
      const removed = record.members.filter((m) =>
        change.removeMemberIds.includes(m.memberId),
      );
      this.change(work, {
        phase: 'layout_uncertain',
        orderedMemberIds: change.orderedMemberIds,
        members: record.members.filter(
          (m) => !change.removeMemberIds.includes(m.memberId),
        ),
        retiring: [...record.retiring, ...removed],
        pendingCommand: {
          ...command,
          commandHash: batchCommandHash(record.batchId, command),
        },
      });
      const status = await this.request(work, () =>
        this.publication.gateway.command(
          record.batchId!,
          decodeBatchCommand(command.kind, command.payload),
          work.session,
          work.cancel,
        ),
      );
      this.observe(work, status);
      if (
        !batchEqual(status.orderedMemberIds, command.payload.orderedMemberIds)
      )
        throw new ClientError(
          'protocol',
          'Layout response differs from desired order',
        );
      this.change(work, { phase: 'editing', pendingCommand: null });
      await this.confirmRetirements(work);
      if (!status.orderedMemberIds.length) {
        this.change(work, { phase: 'cancel_uncertain' });
        await this.cancelBatch(work);
      }
    });
  }
  async cancelOriginal(): Promise<void> {
    // Abort local waits first, then serialize the durable same-key cancellation.
    // Unfinished native callbacks retain their own transfer/reservation credits.
    const running = this.running;
    if (running) {
      this.work?.cancel.cancel();
      try {
        await running;
      } catch {
        /* Original journal remains recoverable. */
      }
      this.hide();
    }
    await this.run(async (work) => {
      if (!work.record) {
        await this.releaseFile(work);
        return;
      }
      if (work.record.publication) {
        await this.recoverPublication(work, true);
        if (work.record?.publication) return;
      }
      if (!work.record) return;
      this.change(work, { phase: 'cancel_uncertain' });
      await this.cancelBatch(work);
    });
  }
  private async cancelBatch(work: Work): Promise<void> {
    const record = work.record!;
    const recovered = await this.request(work, () =>
      this.publication.gateway.cancel(
        record.batchRequestId,
        record.batchRequestHash,
        work.session,
        work.cancel,
      ),
    );
    if (recovered.state !== 'recorded')
      throw new ClientError('protocol', 'Cancellation fence missing');
    this.observe(work, recovered.status);
    if (recovered.status.status === 'terminal') {
      this.options.pending.settle(work.record!, recovered.status);
      work.record = null;
      await this.releaseFile(work);
    }
  }
  private async recoverPublication(
    work: Work,
    explicitCancel = false,
  ): Promise<void> {
    const record = work.record!,
      publication = record.publication!;
    // Receipt first on page reopening and explicit cancellation; not-found is
    // neither a cancel fence nor permission to create another publication key.
    let receipt;
    try {
      receipt = decodeReceipt(
        await this.request(work, () =>
          this.options.community.receipt(
            publication.reference.clientRequestId,
            work.cancel,
          ),
        ),
      );
    } catch (error) {
      if (
        !(error instanceof ClientError) ||
        error.details.serverCode !== 'REQUEST_NOT_FOUND'
      )
        throw error;
      if (publication.cancellation) {
        await this.finishCancellation(work);
        return;
      }
      if (!explicitCancel) throw error;
      this.change(work, { phase: 'cancel_uncertain' });
      const fenced = decodeBatchFenceResult(
        await this.request(work, () =>
          this.publication.gateway.fencePublication(
            record.batchId!,
            publication.reference,
            publication.orderedAssets.map((a) => a.assetId),
            work.session,
            work.cancel,
          ),
        ),
      );
      matchBatch(record, fenced.status);
      if (
        fenced.cancellation.requestId !==
          publication.reference.clientRequestId ||
        fenced.cancellation.operation !== 'publish_post'
      )
        throw new ClientError('protocol', 'Publication fence key mismatch');
      if (fenced.cancellation.outcome === 'cancelled') {
        if (
          fenced.cancellation.intentHash !== publication.reference.intentHash ||
          fenced.status.status === 'bound_history'
        )
          throw new ClientError('protocol', 'Publication fence mismatch');
        this.observe(work, fenced.status);
        this.change(work, {
          phase: 'settlement_pending',
          pendingCommand: null,
          publication: {
            ...work.record!.publication!,
            cancellation: fenced.cancellation,
            linkState: 'settlement_verified',
          },
        });
        await this.finishCancellation(work);
        return;
      }
      receipt = fenced.cancellation;
    }

    if (
      receipt.requestId !== publication.reference.clientRequestId ||
      receipt.operation !== 'publish_post'
    )
      throw new ClientError('protocol', 'Receipt mismatch');
    const attempt = this.options.publicationPending.load(record.actorAccountId);
    if (attempt) {
      if (
        !batchEqual(mediaPublicationReference(attempt), publication.reference)
      )
        throw new ClientError('protocol', 'Publication key mismatch');
      await this.publication.verify(attempt, receipt, work.cancel, false);
      if (explicitCancel && receipt.outcome === 'rejected') {
        this.options.publicationPending.settle(attempt, receipt);
        this.publication.settled(attempt);
      }
      work.record = this.options.pending.load(record.actorAccountId);
      return; // Compose owns created draft/body settlement after verification.
    }
    const recovered = await this.request(work, () =>
      this.publication.gateway.recover(
        record.batchRequestId,
        work.session,
        work.cancel,
      ),
    );
    if (recovered.state !== 'recorded')
      throw new ClientError('business', 'Original batch history is unknown');
    const status = matchBatch(record, recovered.status);
    if (receipt.outcome === 'rejected') {
      if (status.status === 'bound_history')
        throw new ClientError('protocol', 'Receipt and history disagree');
      if (
        !['settlement_verified', 'publication_cleared'].includes(
          work.record!.publication!.linkState,
        )
      ) {
        if (work.record!.pendingCommand?.kind === 'seal')
          this.change(work, {
            pendingCommand: null,
            phase: 'publication_uncertain',
          });
        if (!work.record!.pendingCommand) {
          const command = {
            kind: 'reopen' as const,
            payload: {
              commandId: await this.request(work, this.options.newRequestId),
              expectedRevision: status.revision,
              publication: publication.reference,
            },
          };
          this.change(work, {
            phase: 'layout_uncertain',
            pendingCommand: {
              ...command,
              commandHash: batchCommandHash(work.record!.batchId!, command),
            },
          });
        }
        const reopened = await this.request(work, () =>
          this.publication.gateway.command(
            work.record!.batchId!,
            decodeBatchCommand(
              work.record!.pendingCommand!.kind,
              work.record!.pendingCommand!.payload,
            ),
            work.session,
            work.cancel,
          ),
        );
        if (
          !['editing', 'preparing', 'ready_unbound'].includes(reopened.status)
        )
          throw new ClientError(
            'business',
            'Original publication could not reopen',
          );
        this.observe(work, reopened);
      }
      this.change(work, {
        phase: 'settlement_pending',
        pendingCommand: null,
        publication: {
          ...work.record!.publication!,
          receiptHint: receipt,
          history: null,
          linkState: 'publication_cleared',
          dispatchState: 'receipt_seen',
        },
      });
      this.change(work, { phase: 'editing', publication: null });
      return;
    }
    if (
      receipt.outcome !== 'created' ||
      status.status !== 'bound_history' ||
      !batchEqual(status.publication, publication.reference) ||
      !batchEqual(status.orderedAssets, publication.orderedAssets) ||
      status.attachmentPlanDigest !== publication.attachmentPlanDigest ||
      status.parent.resourceId !== receipt.resourceId
    )
      throw new ClientError(
        'business',
        'Original publication requires exact settlement evidence',
      );
    this.observe(work, status);
    this.change(work, {
      phase: 'settlement_pending',
      pendingCommand: null,
      publication: {
        ...publication,
        receiptHint: receipt,
        history: status,
        linkState: 'publication_cleared',
        dispatchState: 'receipt_seen',
      },
    });
    this.options.pending.settle(work.record!, status);
    work.record = null;
  }
  private async finishCancellation(work: Work): Promise<void> {
    const record = work.record!,
      publication = record.publication!;
    if (!publication.cancellation)
      throw new ClientError('protocol', 'Durable cancellation fence required');
    if (publication.linkState !== 'publication_cleared') {
      const recovered = await this.request(work, () =>
        this.publication.gateway.recover(
          record.batchRequestId,
          work.session,
          work.cancel,
        ),
      );
      if (recovered.state !== 'recorded')
        throw new ClientError(
          'business',
          'Original cancellation history is unknown',
        );
      const status = matchBatch(record, recovered.status);
      if (status.status === 'unavailable' || status.status === 'bound_history')
        throw new ClientError(
          'business',
          'Original cancellation history is not settled',
        );
      if (
        status.status === 'publication_pending' &&
        (!batchEqual(status.publication, publication.reference) ||
          !batchEqual(status.orderedAssets, publication.orderedAssets) ||
          status.attachmentPlanDigest !== publication.attachmentPlanDigest ||
          status.revision !== publication.sealRevision)
      )
        throw new ClientError(
          'protocol',
          'Cancelled seal does not match the original plan',
        );
      if (['editing', 'preparing', 'ready_unbound'].includes(status.status)) {
        const replay = record.pendingCommand;
        if (replay && replay.kind !== 'reopen')
          throw new ClientError(
            'business',
            'Original cancellation command is unresolved',
          );
        const expectedRevision = replay
          ? String(BigInt(replay.payload.expectedRevision) + 1n)
          : String(BigInt(publication.sealRevision) - 1n);
        if (
          status.revision !== expectedRevision ||
          status.retiring.length !== 0 ||
          !batchEqual(
            status.orderedMemberIds,
            publication.orderedAssets.map((asset) => asset.memberId),
          ) ||
          !batchEqual(
            status.members.map((member) => ({
              memberId: member.memberId,
              assetId: member.assetId,
              manifestDigest: member.manifestDigest,
            })),
            publication.orderedAssets,
          ) ||
          status.members.some(
            (member) =>
              member.observation.status !== 'ready_unbound' &&
              member.observation.status !== 'terminal',
          )
        )
          throw new ClientError(
            'business',
            'Complete original cancellation layout is not confirmed',
          );
      }
      this.observe(work, status);
      // Reserved-before-body has never sealed. The authoritative editing state
      // plus the typed owner fence permits cancellation without a bogus reopen.
      // If a reopen was already journaled, replay its exact key even when a lost
      // response left the current server state editing.
      if (
        !work.record!.pendingCommand &&
        status.status === 'publication_pending'
      ) {
        const command = {
          kind: 'reopen' as const,
          payload: {
            commandId: await this.request(work, this.options.newRequestId),
            expectedRevision: status.revision,
            publication: publication.reference,
          },
        };
        this.change(work, {
          phase: 'layout_uncertain',
          pendingCommand: {
            ...command,
            commandHash: batchCommandHash(record.batchId!, command),
          },
        });
      }
      if (work.record!.pendingCommand) {
        if (work.record!.pendingCommand.kind !== 'reopen')
          throw new ClientError(
            'business',
            'Original cancellation command is unresolved',
          );
        const result = await this.request(work, () =>
          this.publication.gateway.command(
            work.record!.batchId!,
            decodeBatchCommand(
              work.record!.pendingCommand!.kind,
              work.record!.pendingCommand!.payload,
            ),
            work.session,
            work.cancel,
          ),
        );
        if (!['editing', 'preparing', 'ready_unbound'].includes(result.status))
          throw new ClientError(
            'business',
            'Cancelled publication could not reopen',
          );
        this.observe(work, result);
      }
      const attempt = this.options.publicationPending.load(
        record.actorAccountId,
      );
      if (attempt) {
        if (
          !batchEqual(mediaPublicationReference(attempt), publication.reference)
        )
          throw new ClientError('protocol', 'Cancelled body key mismatch');
        this.options.publicationPending.settleCancelled(
          attempt,
          publication.cancellation,
          publication.reference.intentHash,
        );
      }
      this.change(work, {
        phase: 'settlement_pending',
        pendingCommand: null,
        publication: {
          ...work.record!.publication!,
          linkState: 'publication_cleared',
        },
      });
    }
    this.change(work, { phase: 'cancel_uncertain', publication: null });
    await this.cancelBatch(work);
  }
  private async releaseFile(work: Work): Promise<void> {
    const file = work.file;
    work.file = null;
    work.fileMemberId = null;
    if (file) await this.options.transfer?.remove(file);
  }
  hide(): void {
    const work = this.work;
    this.work = null;
    this.running = null;
    this.view = initialBatchView();
    this.render(this.view);
    if (work) {
      work.cancel.cancel();
      this.options.transfer?.clearSession(work.ticket);
      void this.releaseFile(work).catch(() => undefined);
    }
  }
  dispose(): void {
    this.disposed = true;
    this.unsubscribe();
    this.stopPrivate();
    this.hide();
  }
  private publish(
    work: Work,
    override?: BatchView['status'],
    progress = 0,
  ): void {
    this.current(work);
    const record = work.record;
    const members =
      record?.orderedMemberIds.map((id, index) => ({
        memberId: id,
        index,
        status:
          record.members.find((m) => m.memberId === id)?.observation
            ?.observation.status ?? 'unknown',
      })) ?? [];
    const ready = members.filter((m) => m.status === 'ready_unbound').length;
    const retiring =
      record?.retiring.filter(
        (m) => m.observation?.observation.status !== 'terminal',
      ).length ?? 0;
    const canEdit =
      !record?.publication &&
      !record?.pendingCommand &&
      record?.phase !== 'cancel_uncertain';
    this.view = Object.freeze({
      status:
        override ??
        (record?.publication
          ? 'publication_pending'
          : record?.phase === 'cancel_uncertain'
            ? 'cancel_pending'
            : !members.length && !record
              ? 'idle'
              : members.length > 0 && ready === members.length && !retiring
                ? 'ready'
                : 'processing'),
      members,
      ready,
      selected: members.length,
      retiring,
      progress,
      canAdd:
        this.available &&
        canEdit &&
        !retiring &&
        members.length < 9 &&
        ready === members.length &&
        !work.file,
      canEdit,
    });
    this.render(this.view);
  }
}
