import { ClientError } from '../api/errors';
import type { SessionStore, SessionTicket } from '../auth/session';
import type { LocalMediaFile, MediaSession } from '../media/contracts';
import { Cancellation } from '../platform/contracts';
import type { UploadDeclaration } from '../media/upload-contracts';
import { PendingRatingStore } from './pending';
import { type RatingTargetCoverIntent } from './target-cover-contract';
import { type RatingCoverMediaGateway } from './target-cover-media-gateway';
import { type RatingCoverMediaStatus } from './target-cover-media-contract';
import {
  decodeRatingCoverScopeInput,
  type PendingRatingCoverUpload,
  type RatingCoverScopeInput,
} from './target-cover-upload-scope';
import type { RatingCoverUploadTransfer } from './target-cover-transfer';
export interface RatingCoverUploadView {
  readonly status:
    'idle' | 'selecting' | 'uploading' | 'pending' | 'ready' | 'unavailable';
  readonly localSrc: string;
  readonly progress: number;
  readonly pickerWaiting: boolean;
  readonly message: string;
}
/** Upload metadata occupies journal 11 before the first scope request. Selected bytes and
 * grants are ephemeral and are revoked on hide, account change, or superseding selection. */
export class RatingCoverUploadController {
  private generation = 0;
  private disposed = false;
  private active = false;
  private owner: SessionTicket;
  private cancel = new Cancellation();
  private file: LocalMediaFile | null = null;
  private view: RatingCoverUploadView = {
    status: 'idle',
    localSrc: '',
    progress: 0,
    pickerWaiting: false,
    message: '',
  };
  private readonly unsubscribe: () => void;
  private readonly unsubscribePicker: () => void;
  constructor(
    private readonly sessions: SessionStore,
    private readonly pending: PendingRatingStore,
    private readonly gateway: RatingCoverMediaGateway,
    private readonly transfer: RatingCoverUploadTransfer | undefined,
    private readonly render: (view: RatingCoverUploadView) => void,
  ) {
    this.owner = sessions.snapshot();
    this.unsubscribe = sessions.subscribe(() => {
      const now = sessions.snapshot();
      if (
        now.epoch !== this.owner.epoch ||
        now.credentials?.accountId !== this.owner.credentials?.accountId
      ) {
        this.hide();
        this.owner = now;
      }
    });
    this.unsubscribePicker =
      transfer?.subscribePicker(() => {
        if (!this.disposed)
          this.publish({
            ...this.view,
            pickerWaiting: transfer.pickerState === 'waiting-native',
          });
      }) ?? (() => undefined);
  }
  snapshot(): RatingCoverUploadView {
    return this.view;
  }
  private publish(value: RatingCoverUploadView): void {
    this.view = Object.freeze(value);
    this.render(this.view);
  }
  private session(
    generation: number,
    owner: SessionTicket,
    cancel: Cancellation,
  ): MediaSession {
    return {
      current: () => {
        this.sessions.assertCurrent(owner);
        if (
          this.disposed ||
          generation !== this.generation ||
          cancel.isCancelled
        )
          throw new ClientError('cancelled', 'Ratings cover selection changed');
        const current = this.sessions.snapshot();
        if (!current.credentials)
          throw new ClientError(
            'auth-required',
            'Original Ratings account required',
          );
        return current;
      },
    };
  }
  async choose(
    makeScope: (
      declaration: UploadDeclaration,
    ) => Promise<RatingCoverScopeInput>,
  ): Promise<void> {
    if (this.active || this.disposed) return;
    if (!this.transfer) {
      this.publish({
        ...this.view,
        status: 'unavailable',
        message: '当前设备上传能力尚未验收，暂不能选择封面',
      });
      return;
    }
    const owner = this.sessions.snapshot(),
      accountId = owner.credentials?.accountId;
    if (!accountId)
      throw new ClientError('auth-required', 'Sign in to select a cover');
    if (this.pending.loadCoverUpload(accountId) || this.pending.load(accountId))
      throw new ClientError(
        'business',
        'Recover or cancel the original Ratings request first',
      );
    this.hide();
    const generation = this.generation,
      cancel = (this.cancel = new Cancellation()),
      session = this.session(generation, owner, cancel);
    this.active = true;
    this.publish({ ...this.view, status: 'selecting', message: '' });
    try {
      const file = await this.transfer.pick(session, cancel);
      try {
        session.current();
      } catch (error) {
        await this.transfer.remove(file);
        throw error;
      }
      this.file = file;
      const inspected = await this.transfer.inspect(file, session, cancel);
      session.current();
      const scopeInput = decodeRatingCoverScopeInput(
        await makeScope({
          mime: inspected.mime,
          bytes: inspected.bytes,
          sha256: inspected.sha256,
        }),
      );
      session.current();
      if (
        scopeInput.declaration.mime !== inspected.mime ||
        scopeInput.declaration.bytes !== inspected.bytes ||
        scopeInput.declaration.sha256 !== inspected.sha256
      )
        throw new ClientError('protocol', 'Selected cover declaration changed');
      const original = this.pending.freezeCoverUpload({
        version: 11,
        phase: 'upload',
        accountId,
        scopeInput,
        scope: null,
        status: null,
      });
      const localSrc = await this.transfer.preview(file, session, cancel);
      session.current();
      this.publish({ ...this.view, status: 'uploading', localSrc });
      await this.progress(original, session, cancel, file);
    } catch {
      if (!cancel.isCancelled && generation === this.generation) {
        let durable = true;
        try {
          durable =
            this.pending.loadCoverUpload(accountId) !== null ||
            this.pending.load(accountId) !== null;
        } catch {
          /* Unreadable storage is not proof that nothing was sent. */
        }
        if (!durable && this.file) {
          void this.transfer.remove(this.file);
          this.file = null;
        }
        this.publish({
          ...this.view,
          localSrc: durable ? this.view.localSrc : '',
          status: durable ? 'pending' : 'idle',
          message: durable
            ? '原封面请求尚待确认，请恢复或明确取消'
            : '未创建上传请求，可以重新选择',
        });
      }
    } finally {
      if (generation === this.generation) this.active = false;
    }
  }
  private observe(
    original: PendingRatingCoverUpload,
    status: RatingCoverMediaStatus,
  ): PendingRatingCoverUpload {
    return this.pending.updateCoverUpload(original, { ...original, status });
  }
  private async progress(
    raw: PendingRatingCoverUpload,
    session: MediaSession,
    cancel: Cancellation,
    file: LocalMediaFile | null,
  ): Promise<void> {
    let original = raw;
    if (!original.scope) {
      const scope = await this.gateway.scope(
        original.scopeInput,
        session,
        cancel,
      );
      session.current();
      original = this.pending.updateCoverUpload(original, {
        ...original,
        scope,
      });
    }
    const scope = original.scope!;
    const recovery = await this.gateway.recover(
      scope.prepare.clientRequestId,
      session,
      cancel,
    );
    session.current();
    if (
      recovery.state === 'cancelled_before_prepare' ||
      (recovery.state === 'recorded' && recovery.status.status === 'terminal')
    ) {
      this.pending.settleCoverUploadCancellation(original, recovery);
      this.hide();
      return;
    }
    let status: RatingCoverMediaStatus;
    if (recovery.state === 'not_recorded') {
      // Re-dispatch the identical frozen prepare; absence never grants a new request.
      status = await this.gateway.prepare(scope.prepare, session, cancel);
      session.current();
    } else status = recovery.status;
    original = this.observe(original, status);
    if (
      status.status === 'prepared' &&
      status.upload === 'none' &&
      file &&
      this.transfer
    ) {
      const grant = await this.gateway.grant(scope.scopeId, session, cancel);
      session.current();
      if (
        grant.editScopeId !== scope.scopeId ||
        grant.intentId !== status.intentId ||
        grant.expectedSha256 !== scope.prepare.declaration.sha256 ||
        grant.expectedBytes !== scope.prepare.declaration.bytes ||
        grant.expectedMime !== scope.prepare.declaration.mime
      )
        throw new ClientError('protocol', 'Original cover grant mismatch');
      const handle = this.transfer.register(grant, session);
      await this.transfer.upload(
        handle,
        file,
        (progress) => {
          try {
            session.current();
            this.publish({ ...this.view, progress });
          } catch {
            /* stale native callback */
          }
        },
        session,
        cancel,
      );
      session.current();
      status = await this.gateway.finalize(scope.scopeId, session, cancel);
      session.current();
      this.observe(original, status);
    } else if (status.status === 'uploaded') {
      status = await this.gateway.finalize(scope.scopeId, session, cancel);
      session.current();
      this.observe(original, status);
    }
    this.publish({
      ...this.view,
      status: status.status === 'ready_unbound' ? 'ready' : 'pending',
      message:
        status.status === 'ready_unbound'
          ? '封面已准备好，将与正文一起提交'
          : '原封面仍处理中，请恢复原请求',
    });
  }
  async recover(cancelOriginal = false): Promise<void> {
    if (this.active || this.disposed) return;
    const owner = this.sessions.snapshot(),
      accountId = owner.credentials?.accountId;
    if (!accountId) return;
    const original = this.pending.loadCoverUpload(accountId);
    if (!original) return;
    const generation = ++this.generation,
      cancel = (this.cancel = new Cancellation()),
      session = this.session(generation, owner, cancel);
    this.active = true;
    try {
      if (!cancelOriginal) await this.progress(original, session, cancel, null);
      else {
        // Cancellation fences the exact original request even if scope creation never
        // reached the server and its old context has since expired.
        const result = await this.gateway.cancelScope(
          original.scopeInput,
          session,
          cancel,
        );
        session.current();
        this.pending.settleCoverScopeCancellation(original, result);
        this.hide();
      }
    } catch {
      if (!cancel.isCancelled && generation === this.generation)
        this.publish({
          ...this.view,
          status: 'pending',
          message: '原封面结果仍未知，未查到不等于已取消',
        });
    } finally {
      if (generation === this.generation) this.active = false;
    }
  }
  seal(intent: RatingTargetCoverIntent): void {
    const accountId = this.sessions.snapshot().credentials?.accountId;
    if (!accountId)
      throw new ClientError('auth-required', 'Original account required');
    const original = this.pending.loadCoverUpload(accountId);
    if (!original)
      throw new ClientError('storage', 'Original cover journal unavailable');
    this.pending.sealCoverUpload(original, intent);
  }
  hide(): void {
    ++this.generation;
    this.cancel.cancel();
    this.transfer?.clearSession(this.owner);
    if (this.file) void this.transfer?.remove(this.file);
    this.file = null;
    this.active = false;
    this.publish({
      status: 'idle',
      localSrc: '',
      progress: 0,
      pickerWaiting: this.transfer?.pickerState === 'waiting-native',
      message: '',
    });
  }
  dispose(): void {
    this.disposed = true;
    this.unsubscribe();
    this.unsubscribePicker();
    this.hide();
  }
}
