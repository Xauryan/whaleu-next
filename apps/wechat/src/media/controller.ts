import { ClientError } from '../api/errors';
import { SessionStore, type SessionTicket } from '../auth/session';
import { cancellable } from '../platform/cancellable';
import { Cancellation, type Clock } from '../platform/contracts';
import type {
  LocalMediaFile,
  MediaAttachment,
  MediaDeclaration,
  MediaGateway,
  MediaIntentStatus,
  MediaPrepare,
  MediaSession,
  MediaTarget,
  MediaTransfer,
  MediaVariant,
} from './contracts';
import { unavailableMediaGateway } from './gateway';

export interface MediaView {
  readonly status:
    | 'idle'
    | 'selecting'
    | 'selected'
    | 'uploading'
    | 'processing'
    | 'ready'
    | 'rejected'
    | 'expired'
    | 'cancelled'
    | 'unavailable';
  readonly progress: number;
  readonly assetId: string | null;
}
interface Work {
  readonly ticket: SessionTicket;
  readonly cancel: Cancellation;
  readonly session: MediaSession;
  readonly files: Set<LocalMediaFile>;
  prepare: MediaPrepare | null;
  declaration: MediaDeclaration | null;
  file: LocalMediaFile | null;
  intentId: string | null;
  uploaded: boolean;
}
const empty = (): MediaView => ({ status: 'idle', progress: 0, assetId: null });

/** In-memory, single-image driver foundation; no publication or production platform wiring.
 * Cancellation clears local state. Server expiration/durable cleanup remains the server's job.
 * Temporary removal is best-effort and is not proof that the OS preview has discarded pixels. */
export class MediaController {
  private work: Work | null = null;
  private running: Promise<void> | null = null;
  private disposed = false;
  private view: MediaView = Object.freeze(empty());
  private readonly unsubscribe: () => void;

  constructor(
    private readonly sessions: SessionStore,
    private readonly transfer: MediaTransfer,
    private readonly clock: Clock,
    private readonly requestId: () => string,
    private readonly gateway: MediaGateway = unavailableMediaGateway,
    private readonly render: (view: MediaView) => void = () => undefined,
  ) {
    this.unsubscribe = sessions.subscribe(() => {
      if (!this.work) return;
      try {
        sessions.assertCurrent(this.work.ticket);
      } catch {
        this.invalidate();
      }
    });
  }
  snapshot(): MediaView {
    return this.view;
  }

  async select(target: MediaTarget, compress = false): Promise<void> {
    const selection = Object.freeze({
      draftId: target.draftId,
      spaceId: target.spaceId,
    });
    this.invalidate();
    if (this.disposed)
      throw new ClientError('cancelled', 'Media view is closed');
    const ticket = this.sessions.snapshot();
    if (!ticket.credentials)
      throw new ClientError('auth-required', 'Sign in to select media');
    const cancel = new Cancellation();
    const session: MediaSession = {
      current: () => {
        this.sessions.assertCurrent(ticket);
        if (cancel.isCancelled)
          throw new ClientError('cancelled', 'Media task was cancelled');
        return this.sessions.snapshot();
      },
    };
    const work: Work = {
      ticket,
      cancel,
      session,
      files: new Set(),
      prepare: null,
      file: null,
      declaration: null,
      intentId: null,
      uploaded: false,
    };
    this.work = work;
    this.publish(work, { status: 'selecting', progress: 0, assetId: null });
    try {
      let file = await this.receiveFile(
        work,
        this.transfer.pick(session, cancel),
      );
      if (compress && this.transfer.optionalCompress) {
        file = await this.receiveFile(
          work,
          this.transfer.optionalCompress(file, session, cancel),
        );
      }
      // Inspect after compression; never reuse declarations for changed local bytes.
      const declaration = await cancellable(
        this.transfer.inspectLocal(file, session, cancel),
        cancel,
      );
      this.assert(work);
      this.checkDeclaration(declaration);
      if (
        !this.identifier(selection.draftId) ||
        !this.identifier(selection.spaceId)
      )
        this.protocol();
      const clientRequestId = this.requestId();
      if (!this.identifier(clientRequestId)) this.protocol();
      work.file = file;
      work.declaration = Object.freeze({
        bytes: declaration.bytes,
        mime: declaration.mime,
        width: declaration.width,
        height: declaration.height,
        frames: declaration.frames,
      });
      work.prepare = Object.freeze({
        clientRequestId,
        purpose: 'community-post-image',
        draftId: selection.draftId,
        spaceId: selection.spaceId,
        slot: 'images',
        ordinal: 0,
        declaration: Object.freeze({
          bytes: declaration.bytes,
          mime: declaration.mime,
        }),
      });
      this.publish(work, { status: 'selected', progress: 0, assetId: null });
    } catch (error) {
      if (this.isCurrent(work)) {
        this.invalidate();
        this.view = Object.freeze({
          status: 'unavailable',
          progress: 0,
          assetId: null,
        });
        this.render(this.view);
      }
      throw error;
    }
  }

  /** Duplicate taps coalesce. Retry reads the same intent before any reupload/finalize.
   * A lost prepare response retries the same frozen request key and exact declaration. */
  start(): Promise<void> {
    if (this.running) return this.running;
    const work = this.work;
    if (!work?.prepare || !work.file)
      return Promise.reject(
        new ClientError('business', 'Select an image first'),
      );
    const operation = this.run(work);
    this.running = operation;
    void operation.then(
      () => {
        if (this.running === operation) this.running = null;
      },
      () => {
        if (this.running === operation) this.running = null;
      },
    );
    return operation;
  }

  private async run(work: Work): Promise<void> {
    try {
      this.assert(work);
      if (!work.prepare || !work.file || !work.declaration) this.protocol();
      let status = await this.request(work, () =>
        work.intentId
          ? this.gateway.status(work.intentId, work.session, work.cancel)
          : this.gateway.prepare(work.prepare!, work.session, work.cancel),
      );
      this.validateStatus(work, status);
      work.intentId = status.intentId;
      if (status.status === 'prepared' || status.status === 'uploading') {
        if (status.expiresAt <= this.clock.now()) {
          this.publish(work, {
            status: 'expired',
            progress: this.view.progress,
            assetId: null,
          });
          return;
        }
        if (!work.uploaded) {
          // Missing/changed local files require a new selection, never a mutated same-key prepare.
          const actual = await this.request(work, () =>
            this.transfer.inspectLocal(work.file!, work.session, work.cancel),
          );
          this.checkDeclaration(actual);
          const expected = work.declaration;
          if (
            actual.bytes !== expected.bytes ||
            actual.mime !== expected.mime ||
            actual.width !== expected.width ||
            actual.height !== expected.height ||
            actual.frames !== expected.frames
          )
            this.protocol();
          const plan = await this.request(work, () =>
            this.gateway.grant(status.intentId, work.session, work.cancel),
          );
          if (
            plan.intentId !== work.intentId ||
            !Number.isSafeInteger(plan.generation) ||
            plan.generation < 1 ||
            !Number.isSafeInteger(plan.expiresAt) ||
            plan.expiresAt <= this.clock.now() ||
            !plan.handle
          )
            this.protocol();
          this.publish(work, {
            status: 'uploading',
            progress: 0,
            assetId: null,
          });
          let acceptingProgress = true;
          try {
            await this.request(work, () =>
              this.transfer.upload(
                plan,
                work.file!,
                (percent) => {
                  if (
                    !acceptingProgress ||
                    !this.isCurrent(work) ||
                    !Number.isFinite(percent)
                  )
                    return;
                  const progress = Math.max(
                    this.view.progress,
                    Math.min(100, Math.max(0, percent)),
                  );
                  this.publish(work, {
                    status: progress === 100 ? 'processing' : 'uploading',
                    progress,
                    assetId: null,
                  });
                },
                work.session,
                work.cancel,
              ),
            );
          } finally {
            acceptingProgress = false;
          }
          work.uploaded = true;
        }
        this.publish(work, {
          status: 'processing',
          progress: 100,
          assetId: null,
        });
        status = await this.request(work, () =>
          this.gateway.finalize(work.intentId!, work.session, work.cancel),
        );
      }
      for (;;) {
        this.validateStatus(work, status);
        if (status.status === 'ready') {
          this.publish(work, {
            status: 'ready',
            progress: 100,
            assetId: status.assetId,
          });
          return;
        }
        if (
          ['rejected', 'expired', 'cancelled', 'unavailable'].includes(
            status.status,
          )
        ) {
          this.publish(work, {
            status: status.status as
              'rejected' | 'expired' | 'cancelled' | 'unavailable',
            progress: this.view.progress,
            assetId: null,
          });
          return;
        }
        if (status.expiresAt <= this.clock.now()) {
          this.publish(work, {
            status: 'expired',
            progress: this.view.progress,
            assetId: null,
          });
          return;
        }
        this.publish(work, {
          status: 'processing',
          progress: this.view.progress,
          assetId: null,
        });
        await this.pause(
          work,
          Math.min(1000, status.expiresAt - this.clock.now()),
        );
        status = await this.request(work, () =>
          this.gateway.status(work.intentId!, work.session, work.cancel),
        );
      }
    } catch (error) {
      if (this.isCurrent(work))
        this.publish(work, {
          status: 'unavailable',
          progress: this.view.progress,
          assetId: null,
        });
      throw error;
    }
  }

  /** Downloads are always authenticated, transient and tied to the active selection's session.
   * A future page integration may give read-only previews their own scoped controller. */
  async preview(
    attachment?: MediaAttachment,
    variant: MediaVariant = 'display-v1',
  ): Promise<void> {
    const work = this.work;
    if (!work) throw new ClientError('business', 'No media session');
    this.assert(work);
    let file = work.file;
    if (attachment) {
      if (
        attachment.version !== 1 ||
        attachment.kind !== 'authenticated-media' ||
        !['thumb-v1', 'display-v1'].includes(variant) ||
        attachment.variants.length !== 2 ||
        attachment.variants[0] !== 'thumb-v1' ||
        attachment.variants[1] !== 'display-v1' ||
        !this.identifier(attachment.assetId) ||
        !this.identifier(attachment.bindingId) ||
        !Number.isSafeInteger(attachment.width) ||
        !Number.isSafeInteger(attachment.height) ||
        attachment.width <= 0 ||
        attachment.height <= 0 ||
        attachment.width > 2048 ||
        attachment.height > 2048
      )
        this.protocol();
      const descriptor: MediaAttachment = Object.freeze({
        version: 1,
        kind: 'authenticated-media',
        assetId: attachment.assetId,
        bindingId: attachment.bindingId,
        variants: Object.freeze(['thumb-v1', 'display-v1'] as const),
        width: attachment.width,
        height: attachment.height,
      });
      file = await this.receiveFile(
        work,
        this.transfer.downloadAuthenticated(
          descriptor,
          variant,
          work.session,
          work.cancel,
        ),
      );
    }
    if (!file) throw new ClientError('business', 'No local image');
    this.assert(work);
    try {
      await this.request(work, () =>
        this.transfer.previewTemporary(file!, work.session, work.cancel),
      );
    } finally {
      if (attachment) {
        work.files.delete(file);
        await this.remove(file);
      }
    }
  }

  async cancel(): Promise<void> {
    const work = this.work;
    // Explicit cancellation captures current authorization, but never retargets a new account.
    const current = work && this.isCurrent(work);
    const intentId = work?.intentId;
    this.invalidate();
    if (!current || !work || !intentId) return;
    const cancel = new Cancellation();
    const unsubscribe = this.sessions.subscribe(() => {
      try {
        this.sessions.assertCurrent(work.ticket);
      } catch {
        cancel.cancel();
      }
    });
    const session: MediaSession = {
      current: () => {
        this.sessions.assertCurrent(work.ticket);
        if (cancel.isCancelled)
          throw new ClientError('cancelled', 'Media cancellation superseded');
        return this.sessions.snapshot();
      },
    };
    try {
      session.current();
      await cancellable(this.gateway.cancel(intentId, session, cancel), cancel);
    } finally {
      unsubscribe();
    }
  }
  dispose(): void {
    this.disposed = true;
    this.unsubscribe();
    this.invalidate();
  }
  /** Page hide/back cancels local tasks. No remote cancellation is sent with a new login. */
  hide(): void {
    this.invalidate();
  }

  private invalidate(): void {
    const work = this.work;
    this.work = null;
    this.running = null;
    if (work) {
      work.cancel.cancel();
      try {
        this.transfer.clearSession(work.ticket);
      } catch {
        /* Local state still clears. */
      }
      for (const file of work.files) void this.remove(file);
      work.files.clear();
      work.file = null;
      work.prepare = null;
      work.declaration = null;
      work.intentId = null;
      work.uploaded = false;
    }
    this.view = Object.freeze(empty());
    this.render(this.view);
  }
  private async remove(file: LocalMediaFile): Promise<void> {
    try {
      await this.transfer.removeTemporary(file);
    } catch {
      /* OS cleanup is not guaranteed. */
    }
  }
  private async receiveFile(
    work: Work,
    result: Promise<LocalMediaFile>,
  ): Promise<LocalMediaFile> {
    // Observe late resolution even if the adapter ignores abort, and remove its temporary output.
    const owned = result.then(async (file) => {
      if (!this.isCurrent(work)) {
        await this.remove(file);
        this.assert(work);
      }
      work.files.add(file);
      return file;
    });
    const file = await cancellable(owned, work.cancel);
    this.assert(work);
    return file;
  }
  private async request<T>(work: Work, action: () => Promise<T>): Promise<T> {
    this.assert(work);
    const value = await cancellable(action(), work.cancel);
    this.assert(work);
    return value;
  }
  private pause(work: Work, milliseconds: number): Promise<void> {
    return new Promise((resolve, reject) => {
      let unsubscribe = () => undefined as void;
      const stop = this.clock.schedule(() => {
        unsubscribe();
        resolve();
      }, milliseconds);
      unsubscribe = work.cancel.subscribe(() => {
        stop();
        reject(new ClientError('cancelled', 'Media polling cancelled'));
      });
    });
  }
  private assert(work: Work): void {
    work.session.current();
    if (this.work !== work || this.disposed)
      throw new ClientError('cancelled', 'Media task was replaced');
  }
  private isCurrent(work: Work): boolean {
    try {
      this.assert(work);
      return true;
    } catch {
      return false;
    }
  }
  private publish(work: Work, view: MediaView): void {
    this.assert(work);
    this.view = Object.freeze(view);
    this.render(this.view);
  }
  private validateStatus(work: Work, status: MediaIntentStatus): void {
    if (
      !this.identifier(status.intentId) ||
      (work.intentId !== null && status.intentId !== work.intentId) ||
      !Number.isSafeInteger(status.expiresAt) ||
      status.expiresAt <= 0 ||
      ![
        'prepared',
        'uploading',
        'processing',
        'ready',
        'rejected',
        'expired',
        'cancelled',
        'unavailable',
      ].includes(status.status) ||
      (status.status === 'ready' && !this.identifier(status.assetId))
    )
      this.protocol();
  }
  private checkDeclaration(value: MediaDeclaration): void {
    if (
      !['image/jpeg', 'image/png'].includes(value.mime) ||
      (value.frames !== 1 && value.frames !== 'unknown') ||
      !Number.isSafeInteger(value.bytes) ||
      value.bytes <= 0 ||
      value.bytes > 5 * 1024 * 1024 ||
      !Number.isSafeInteger(value.width) ||
      !Number.isSafeInteger(value.height) ||
      value.width <= 0 ||
      value.height <= 0 ||
      value.width > 8192 ||
      value.height > 8192 ||
      value.width * value.height > 24_000_000
    )
      this.protocol();
  }
  private identifier(value: string): boolean {
    return /^(?:[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/i.test(
      value,
    );
  }
  private protocol(): never {
    throw new ClientError('protocol', 'Invalid media transfer response');
  }
}
