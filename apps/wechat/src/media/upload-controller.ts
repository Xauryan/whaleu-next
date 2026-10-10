import { ClientError, clientError } from '../api/errors';
import { SessionStore, type SessionTicket } from '../auth/session';
import { decodeReceipt, type Receipt } from '../community/contract';
import type { PrivateViewLifecycle } from '../identity-privacy/overlay';
import { cancellable } from '../platform/cancellable';
import { Cancellation, type Clock } from '../platform/contracts';
import type { LocalMediaFile, MediaSession, MediaTarget } from './contracts';
import { PendingMediaStore, type PendingMedia } from './pending';
import {
  decodeUploadPrepare,
  decodeUploadRecovery,
  decodeUploadStatus,
  uploadInvalid,
  type PublicationReference,
  type UploadGateway,
  type UploadRecovery,
  type UploadStatus,
  type UploadTransfer,
} from './upload-contracts';

export interface UploadView {
  readonly status:
    | 'idle'
    | 'selecting'
    | 'selected'
    | 'uploading'
    | 'processing'
    | 'ready'
    | 'needs_reselection'
    | 'cancel_pending'
    | 'publication_pending'
    | 'bound_history'
    | 'terminal'
    | 'unavailable';
  readonly progress: number;
  readonly assetId: string | null;
  readonly cleanup: 'pending' | 'retained' | 'confirmed' | null;
}
export interface MediaPublicationOwner {
  receipt(
    reference: PublicationReference,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<Receipt>;
}
interface Work {
  readonly ticket: SessionTicket;
  readonly cancel: Cancellation;
  readonly session: MediaSession;
  record: PendingMedia | null;
  file: LocalMediaFile | null;
}
const idle = (): UploadView => ({
  status: 'idle',
  progress: 0,
  assetId: null,
  cleanup: null,
});
/** Durable request recovery is independent from ephemeral files/grants. New login never inherits old Work. */
export class MediaUploadController {
  private work: Work | null = null;
  private running: Promise<void> | null = null;
  private disposed = false;
  private view: UploadView = Object.freeze(idle());
  private readonly unsubscribe: () => void;
  private readonly stopPrivate: () => void;
  constructor(
    private readonly sessions: SessionStore,
    private readonly pending: PendingMediaStore,
    private readonly gateway: UploadGateway,
    private readonly transfer: UploadTransfer | undefined,
    private readonly clock: Clock,
    private readonly newRequestId: () => Promise<string>,
    private readonly render: (view: UploadView) => void = () => undefined,
    private readonly publication?: MediaPublicationOwner,
    privateViews?: PrivateViewLifecycle,
  ) {
    this.unsubscribe = sessions.subscribe(() => {
      if (this.work) {
        try {
          sessions.assertCurrent(this.work.ticket);
        } catch {
          this.hide();
        }
      }
    });
    this.stopPrivate =
      privateViews?.subscribe((actor) => {
        if (
          actor === undefined ||
          actor === this.work?.ticket.credentials?.accountId
        )
          this.hide();
      }) ?? (() => undefined);
  }
  get available(): boolean {
    return !!this.transfer;
  }
  snapshot(): UploadView {
    return this.view;
  }
  private createWork(record: PendingMedia | null = null): Work {
    if (this.disposed) throw new ClientError('cancelled', 'Media view closed');
    const ticket = this.sessions.snapshot();
    if (!ticket.credentials)
      throw new ClientError('auth-required', 'Sign in to use media');
    if (record && record.actorAccountId !== ticket.credentials.accountId)
      throw new ClientError('stale-session', 'Original media actor required');
    const cancel = new Cancellation();
    const session: MediaSession = {
      current: () => {
        this.sessions.assertCurrent(ticket);
        if (cancel.isCancelled)
          throw new ClientError('cancelled', 'Media operation interrupted');
        const current = this.sessions.snapshot();
        if (!current.credentials)
          throw new ClientError('auth-required', 'Sign in to use media');
        return current;
      },
    };
    const work: Work = { ticket, cancel, session, record, file: null };
    this.work = work;
    return work;
  }
  private assert(work: Work): void {
    work.session.current();
    if (this.work !== work || this.disposed)
      throw new ClientError('cancelled', 'Media operation replaced');
  }
  private current(work: Work): boolean {
    try {
      this.assert(work);
      return true;
    } catch {
      return false;
    }
  }
  private publish(
    work: Work,
    status: UploadView['status'],
    assetId: string | null = null,
    cleanup: UploadView['cleanup'] = null,
  ): void {
    this.assert(work);
    this.view = Object.freeze({
      status,
      progress: this.view.progress,
      assetId,
      cleanup,
    });
    this.render(this.view);
  }
  private change(
    work: Work,
    patch: Parameters<PendingMediaStore['update']>[1],
  ): PendingMedia {
    this.assert(work);
    if (!work.record) uploadInvalid();
    work.record = this.pending.update(work.record, {
      ...patch,
      lastObservedAt: Math.max(this.clock.now(), work.record.lastObservedAt),
    });
    return work.record;
  }
  private async request<T>(work: Work, action: () => Promise<T>): Promise<T> {
    this.assert(work);
    const value = await cancellable(action(), work.cancel);
    this.assert(work);
    return value;
  }
  async select(target: MediaTarget): Promise<void> {
    if (!this.transfer)
      throw new ClientError('configuration', 'Image upload unavailable');
    const actor = this.sessions.snapshot().credentials?.accountId;
    if (!actor)
      throw new ClientError('auth-required', 'Sign in to select image');
    // Check before hiding: damage/full capacity cannot silently evict an unresolved operation.
    if (this.pending.load(actor))
      throw new ClientError(
        'business',
        'Recover or cancel the original image before selecting another',
      );
    this.hide();
    const work = this.createWork();
    this.publish(work, 'selecting');
    try {
      const received = this.transfer
        .pick(work.session, work.cancel)
        .then(async (file) => {
          if (!this.current(work)) {
            await this.transfer!.remove(file);
            this.assert(work);
          }
          work.file = file;
          return file;
        });
      const file = await this.request(work, () => received);
      const inspection = await this.request(work, () =>
        this.transfer!.inspect(file, work.session, work.cancel),
      );
      if (inspection.frameCount !== 'unknown' && inspection.frameCount !== 1)
        uploadInvalid();
      const clientRequestId = await this.request(work, () =>
        this.newRequestId(),
      );
      const input = decodeUploadPrepare({
        clientRequestId,
        purpose: 'community-post-image',
        draftId: target.draftId,
        spaceId: target.spaceId,
        slot: 'images',
        ordinal: 0,
        declaration: {
          mime: inspection.mime,
          bytes: inspection.bytes,
          sha256: inspection.sha256,
        },
      });
      this.assert(work);
      work.record = this.pending.freeze(actor, input, this.clock.now());
      this.publish(work, 'selected');
    } catch (error) {
      if (this.current(work)) {
        this.hide();
        if (clientError(error).kind !== 'cancelled') {
          this.view = Object.freeze({ ...idle(), status: 'unavailable' });
          this.render(this.view);
        }
      }
      throw error;
    }
  }
  /** Duplicate taps share a promise. Every continuation starts by recovering the same original key. */
  start(): Promise<void> {
    return this.run(false);
  }
  recover(): Promise<void> {
    return this.run(true);
  }
  private run(recovering: boolean): Promise<void> {
    if (this.running) return this.running;
    let work = this.work;
    try {
      if (!work) {
        const actor = this.sessions.snapshot().credentials?.accountId;
        if (!actor)
          throw new ClientError('auth-required', 'Original account required');
        const record = this.pending.load(actor);
        if (!record) {
          this.view = Object.freeze(idle());
          this.render(this.view);
          return Promise.resolve();
        }
        work = this.createWork(record);
      }
      this.assert(work);
      const saved = this.pending.load(work.ticket.credentials!.accountId);
      if (
        saved &&
        work.record &&
        saved.clientRequestId === work.record.clientRequestId &&
        saved.requestHash === work.record.requestHash
      )
        work.record = saved;
      if (!work.record)
        throw new ClientError('business', 'Select an image first');
    } catch (error) {
      return Promise.reject(error);
    }
    const owner = work;
    const task = this.perform(owner, recovering).catch((error) => {
      if (this.current(owner))
        this.publish(
          owner,
          owner.record?.phase === 'cancel_uncertain'
            ? 'cancel_pending'
            : owner.record?.phase === 'publication_uncertain'
              ? 'publication_pending'
              : 'unavailable',
        );
      throw error;
    });
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
  private async perform(work: Work, _recovering: boolean): Promise<void> {
    this.assert(work);
    let record = work.record!;
    this.pending.assertStored(record);
    if (record.phase === 'publication_uncertain') {
      // The existing publication receipt owner is always queried before media status/cancellation.
      if (!(await this.publicationReceipt(work, false))) return;
      record = work.record!;
    }
    const recovered = decodeUploadRecovery(
      await this.request(work, () =>
        this.gateway.recover(record.clientRequestId, work.session, work.cancel),
      ),
    );
    this.matchRecovery(work, recovered);
    if (this.settleRecovery(work, recovered)) return;
    if (work.record!.phase === 'cancel_uncertain') {
      await this.sendCancel(work);
      return;
    }
    let status: UploadStatus;
    if (recovered.state === 'not_recorded') {
      this.change(work, { phase: 'prepare_uncertain' });
      status = decodeUploadStatus(
        await this.request(work, () =>
          this.gateway.prepare(work.record!.prepare, work.session, work.cancel),
        ),
      );
    } else {
      if (recovered.state !== 'active') uploadInvalid();
      status = recovered.status;
    }
    this.matchStatus(work, status);
    await this.advance(work, status);
  }
  private async advance(work: Work, initial: UploadStatus): Promise<void> {
    let status = initial;
    for (;;) {
      this.matchStatus(work, status);
      if (status.status === 'terminal' || status.status === 'bound_history') {
        this.settleStatus(work, status);
        return;
      }
      if (status.status === 'unavailable') {
        this.publish(work, 'unavailable');
        return;
      }
      if (status.status === 'ready_unbound') {
        this.change(work, {
          intentId: status.intentId,
          phase: 'ready_hint',
          assetId: status.assetId,
          readyRetentionUntil: status.readyRetentionUntil,
          draftExpiresAt: status.draftExpiresAt,
          bindBefore: status.bindBefore,
        });
        // A ready response is current server evidence; the old 30-minute deadline is never applied here.
        this.publish(work, 'ready', status.assetId);
        await this.releaseFile(work);
        return;
      }
      this.change(work, {
        intentId: status.intentId,
        operationDeadlineAt: status.operationDeadlineAt,
        phase:
          status.status === 'prepared'
            ? 'prepared'
            : status.status === 'uploaded'
              ? 'upload_uncertain'
              : 'processing',
      });
      if (status.status === 'prepared') {
        if (status.upload !== 'none') {
          this.publish(work, 'processing');
          return;
        }
        if (!work.file || !this.transfer) {
          this.publish(work, 'needs_reselection');
          return;
        }
        const declaration = work.record!.prepare.declaration;
        const actual = await this.request(work, () =>
          this.transfer!.inspect(work.file!, work.session, work.cancel),
        );
        if (
          actual.bytes !== declaration.bytes ||
          actual.mime !== declaration.mime ||
          actual.sha256 !== declaration.sha256 ||
          (actual.frameCount !== 'unknown' && actual.frameCount !== 1)
        )
          uploadInvalid();
        const grant = await this.request(work, () =>
          this.gateway.grant(status.intentId, work.session, work.cancel),
        );
        if (
          grant.intentId !== status.intentId ||
          grant.expectedBytes !== declaration.bytes ||
          grant.expectedMime !== declaration.mime ||
          grant.expectedSha256 !== declaration.sha256
        )
          uploadInvalid();
        const handle = this.transfer.register(grant, work.session);
        this.change(work, { phase: 'upload_uncertain' });
        this.publish(work, 'uploading');
        await this.request(work, () =>
          this.transfer!.upload(
            handle,
            work.file!,
            (percent) => {
              if (this.current(work) && Number.isFinite(percent)) {
                this.view = Object.freeze({
                  ...this.view,
                  status: 'uploading',
                  progress: Math.max(
                    this.view.progress,
                    Math.min(100, Math.max(0, percent)),
                  ),
                  assetId: null,
                });
                this.render(this.view);
              }
            },
            work.session,
            work.cancel,
          ),
        );
        // Even a valid upload receipt is not ready. Reconcile observed status before finalize.
        status = decodeUploadStatus(
          await this.request(work, () =>
            this.gateway.status(
              work.record!.intentId!,
              work.session,
              work.cancel,
            ),
          ),
        );
        if (status.status === 'prepared')
          throw new ClientError(
            'protocol',
            'Observed upload was not reflected in current status',
          );
        continue;
      }
      if (status.status === 'uploaded') {
        this.change(work, { phase: 'processing' });
        this.publish(work, 'processing');
        status = decodeUploadStatus(
          await this.request(work, () =>
            this.gateway.finalize(status.intentId, work.session, work.cancel),
          ),
        );
        continue;
      }
      this.publish(work, 'processing');
      await this.pause(work, status.retryAfterMs);
      status = decodeUploadStatus(
        await this.request(work, () =>
          this.gateway.status(
            work.record!.intentId!,
            work.session,
            work.cancel,
          ),
        ),
      );
    }
  }
  /** Always uses a durable cancel-by-key fence, including a prepare request still in transit. */
  async cancelOriginal(): Promise<void> {
    const actor = this.sessions.snapshot().credentials?.accountId;
    if (!actor)
      throw new ClientError('auth-required', 'Original account required');
    const record = this.pending.load(actor);
    if (!record) {
      this.hide();
      return;
    }
    this.hide();
    const work = this.createWork(record);
    try {
      if (
        record.phase === 'publication_uncertain' &&
        !(await this.publicationReceipt(work, true))
      )
        return;
      this.change(work, { phase: 'cancel_uncertain' });
      this.publish(work, 'cancel_pending');
      await this.sendCancel(work);
    } catch (error) {
      if (this.current(work))
        this.publish(
          work,
          work.record?.phase === 'publication_uncertain'
            ? 'publication_pending'
            : 'cancel_pending',
        );
      throw error;
    }
  }
  private async sendCancel(work: Work): Promise<void> {
    this.change(work, { phase: 'cancel_uncertain' });
    const record = work.record!;
    const result = decodeUploadRecovery(
      await this.request(work, () =>
        this.gateway.cancelRequest(
          record.clientRequestId,
          record.requestHash,
          work.session,
          work.cancel,
        ),
      ),
    );
    this.matchRecovery(work, result);
    if (!this.settleRecovery(work, result))
      this.publish(work, 'cancel_pending');
  }
  private async publicationReceipt(
    work: Work,
    cancelling: boolean,
  ): Promise<boolean> {
    const reference = work.record!.publication;
    if (!reference || !this.publication) {
      this.publish(work, 'publication_pending');
      return false;
    }
    try {
      const receipt = decodeReceipt(
        await this.request(work, () =>
          this.publication!.receipt(reference, work.session, work.cancel),
        ),
      );
      if (
        receipt.requestId !== reference.clientRequestId ||
        receipt.operation !== reference.operation
      )
        uploadInvalid();
      if (receipt.outcome === 'created') {
        // A receipt is not permission to render or reuse an asset. Obtain binding history before settling media.
        const status = decodeUploadStatus(
          await this.request(work, () =>
            this.gateway.status(
              work.record!.intentId!,
              work.session,
              work.cancel,
            ),
          ),
        );
        this.matchStatus(work, status);
        if (status.status === 'bound_history') {
          this.settleStatus(work, status);
          return false;
        }
        this.publish(work, 'publication_pending');
        return false;
      }
      this.change(work, {
        phase: cancelling ? 'cancel_uncertain' : 'ready_hint',
        publication: null,
      });
      return true;
    } catch (error) {
      this.assert(work);
      if (clientError(error).details.serverCode === 'REQUEST_NOT_FOUND') {
        this.publish(work, 'publication_pending');
        // Explicit cancellation can race late publication under the server's intent-first lock.
        return cancelling;
      }
      throw error;
    }
  }
  /** Fresh status before publication, never ready_hint or a remembered asset id alone. */
  async publicationAssets(
    spaceId: string,
    cancel: Cancellation,
  ): Promise<readonly string[]> {
    const actor = this.sessions.snapshot().credentials?.accountId;
    if (!actor)
      throw new ClientError('auth-required', 'Original account required');
    const record = this.pending.load(actor);
    if (!record) return [];
    if (
      record.prepare.spaceId !== spaceId ||
      record.phase === 'publication_uncertain' ||
      !record.intentId
    )
      throw new ClientError(
        'business',
        'Recover the original media operation first',
      );
    if (!this.work) this.createWork(record);
    const work = this.work!;
    this.assert(work);
    if (!work.record || work.record.requestHash !== record.requestHash)
      uploadInvalid();
    this.pending.assertStored(work.record);
    const stop = cancel.subscribe(() => work.cancel.cancel());
    try {
      const status = decodeUploadStatus(
        await this.request(work, () =>
          this.gateway.status(record.intentId!, work.session, work.cancel),
        ),
      );
      this.matchStatus(work, status);
      if (status.status !== 'ready_unbound')
        throw new ClientError(
          'business',
          'Image not currently ready for publication',
        );
      this.change(work, {
        phase: 'ready_hint',
        assetId: status.assetId,
        readyRetentionUntil: status.readyRetentionUntil,
        draftExpiresAt: status.draftExpiresAt,
        bindBefore: status.bindBefore,
      });
      return Object.freeze([status.assetId]);
    } finally {
      stop();
    }
  }
  private matchStatus(work: Work, status: UploadStatus): void {
    this.assert(work);
    const record = work.record!;
    if (
      status.requestId !== record.clientRequestId ||
      status.requestHash !== record.requestHash ||
      (record.intentId && status.intentId !== record.intentId) ||
      (record.assetId &&
        'assetId' in status &&
        status.assetId !== record.assetId)
    )
      uploadInvalid();
  }
  private matchRecovery(work: Work, value: UploadRecovery): void {
    this.assert(work);
    const record = work.record!;
    if (
      value.requestId !== record.clientRequestId ||
      (value.state !== 'not_recorded' &&
        value.requestHash !== record.requestHash)
    )
      uploadInvalid();
    if (value.state !== 'not_recorded' && value.status)
      this.matchStatus(work, value.status);
  }
  private settleRecovery(work: Work, value: UploadRecovery): boolean {
    if (value.state !== 'terminal' && value.state !== 'bound_history')
      return false;
    this.pending.settle(work.record!, value);
    work.record = null;
    this.publish(
      work,
      value.state === 'bound_history' ? 'bound_history' : 'terminal',
      null,
      value.state === 'terminal' ? (value.status?.cleanup ?? 'pending') : null,
    );
    void this.releaseFile(work);
    return true;
  }
  private settleStatus(work: Work, value: UploadStatus): void {
    this.pending.settle(work.record!, value);
    work.record = null;
    this.publish(
      work,
      value.status === 'bound_history' ? 'bound_history' : 'terminal',
      null,
      value.status === 'terminal' ? value.cleanup : null,
    );
    void this.releaseFile(work);
  }
  private pause(work: Work, ms: number): Promise<void> {
    return new Promise((resolve, reject) => {
      let stopCancel = () => undefined as void;
      const stop = this.clock.schedule(() => {
        stopCancel();
        resolve();
      }, ms);
      stopCancel = work.cancel.subscribe(() => {
        stop();
        reject(new ClientError('cancelled', 'Media status wait cancelled'));
      });
    });
  }
  private async releaseFile(work: Work): Promise<void> {
    const file = work.file;
    work.file = null;
    if (file && this.transfer)
      await this.transfer.remove(file).catch(() => undefined);
  }
  hide(): void {
    const work = this.work;
    this.work = null;
    this.running = null;
    this.view = Object.freeze(idle());
    this.render(this.view);
    if (work) {
      work.cancel.cancel();
      try {
        this.transfer?.clearSession(work.ticket);
      } catch {
        /* UI and Work are already revoked. */
      }
      void this.releaseFile(work);
    }
  }
  dispose(): void {
    this.disposed = true;
    this.unsubscribe();
    this.stopPrivate();
    this.hide();
  }
}
