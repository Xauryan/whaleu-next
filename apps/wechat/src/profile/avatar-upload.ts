import { ClientError, clientError } from '../api/errors';
import { responseError } from '../api/envelopes';
import { endpointUrl, normalizeOrigin } from '../api/origin';
import type { AuthService } from '../auth/auth-service';
import type { SessionStore, SessionTicket } from '../auth/session';
import { cancellable } from '../platform/cancellable';
import type { Cancellation, Clock } from '../platform/contracts';
import {
  type UploadFiles,
  type WxUploadApi,
  type WxUploadTask,
} from '../platform/wechat-upload';
import type { LocalMediaFile, MediaSession } from '../media/contracts';
import { MediaLocalFiles } from '../media/local-files';
import { AuthenticatedMediaUpload } from '../media/authenticated-upload';
import {
  decodeAvatarGrant,
  decodeAvatarUploadObserved,
  AVATAR_MAX_BYTES,
  avatarInteger,
  avatarInvalid,
  type AvatarGrant,
  type AvatarUploadObserved,
} from './avatar-contract';
import type {
  AvatarInspected,
  AvatarUploadHandle,
  AvatarUploadTransfer,
} from './avatar-transfer';
interface GrantLease {
  readonly grant: AvatarGrant;
  readonly ticket: SessionTicket;
  readonly deadline: number;
}
/** Fixed first-party multipart only. Device redirect/header/domain acceptance remains an external gate. */
export class ProfileAvatarUpload implements AvatarUploadTransfer {
  private readonly origin: string;
  private readonly selection: AuthenticatedMediaUpload;
  private readonly grants = new Map<AvatarUploadHandle, GrantLease>();
  private sequence = 0;
  private nativeUploads = 0;
  private operations = 0;
  constructor(
    origin: string,
    private readonly wx: WxUploadApi,
    files: UploadFiles,
    private readonly registry: MediaLocalFiles,
    private readonly sessions: SessionStore,
    private readonly clock: Clock,
    private readonly auth?: Pick<AuthService, 'refresh'>,
  ) {
    this.origin = normalizeOrigin(origin);
    // Reuse the established chooseMedia per-invocation callbacks, cancellation,
    // complete signal, file capability ownership and shared byte reservations.
    // Its Community HTTP/grant methods are never used for Profile media.
    this.selection = new AuthenticatedMediaUpload(
      origin,
      wx,
      files,
      registry,
      sessions,
      clock,
    );
  }
  private current(
    session: MediaSession,
    cancel?: Cancellation,
    ticket?: SessionTicket,
  ): SessionTicket {
    if (ticket) this.sessions.assertCurrent(ticket);
    const value = session.current();
    this.sessions.assertCurrent(value);
    if (cancel?.isCancelled)
      throw new ClientError('cancelled', 'Image operation cancelled');
    if (!value.credentials)
      throw new ClientError('auth-required', 'Sign in to select image');
    return value;
  }
  subscribePicker(listener: () => void): () => void {
    return this.selection.subscribePicker(listener);
  }
  get pickerState(): 'ready' | 'waiting-native' | 'unavailable' {
    return this.selection.pickerState;
  }
  pick(session: MediaSession, cancel: Cancellation): Promise<LocalMediaFile> {
    this.current(session, cancel);
    return this.selection.pick(session, cancel);
  }
  preview(
    file: LocalMediaFile,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<string> {
    return this.selection.resolveSelected(file, session, cancel);
  }
  async inspect(
    file: LocalMediaFile,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<AvatarInspected> {
    const value = await this.selection.inspect(file, session, cancel);
    return Object.freeze({
      mime: value.mime,
      bytes: value.bytes,
      sha256: value.sha256,
      width: value.width,
      height: value.height,
    });
  }
  register(raw: AvatarGrant, session: MediaSession): AvatarUploadHandle {
    const ticket = this.current(session);
    const grant = decodeAvatarGrant(raw);
    // At most one fresh grant per intent/session; all older opaque handles are revoked.
    for (const [handle, lease] of this.grants)
      if (lease.grant.intentId === grant.intentId) this.grants.delete(handle);
    if (this.grants.size >= 2)
      throw new ClientError(
        'configuration',
        'Upload grant capacity unavailable',
      );
    const handle = Object.freeze({ handle: `upload-${++this.sequence}` });
    this.grants.set(handle, {
      grant,
      ticket,
      deadline:
        this.clock.now() +
        Math.min(120000, grant.grantExpiresAt - grant.serverNow),
    });
    return handle;
  }
  async upload(
    handle: AvatarUploadHandle,
    file: LocalMediaFile,
    progress: (percent: number) => void,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<AvatarUploadObserved> {
    const lease = this.grants.get(handle);
    if (!lease || this.nativeUploads >= 2 || this.operations >= 2)
      throw new ClientError('configuration', 'Upload grant unavailable');
    this.grants.delete(handle);
    this.operations++;
    try {
      this.current(session, cancel, lease.ticket);
      const actual = await this.inspect(file, session, cancel);
      const { grant } = lease;
      if (
        actual.bytes !== grant.expectedBytes ||
        actual.mime !== grant.expectedMime ||
        actual.sha256 !== grant.expectedSha256
      )
        avatarInvalid();
      const path = await cancellable(
        this.selection.resolveSelected(file, session, cancel),
        cancel,
      );
      const sent = this.current(session, cancel, lease.ticket);
      if (this.clock.now() >= lease.deadline)
        throw new ClientError(
          'timeout',
          'Upload grant expired; query original operation',
        );
      try {
        return await this.start(
          lease,
          path,
          progress,
          () => this.current(session, cancel, lease.ticket),
          cancel,
        );
      } catch (error) {
        // Never replay a mutation transparently. Recover status and acquire another grant next time.
        if (
          error instanceof ClientError &&
          error.kind === 'auth-expired' &&
          this.auth
        ) {
          await cancellable(this.auth.refresh(sent), cancel);
          this.current(session, cancel, lease.ticket);
        }
        throw error;
      }
    } finally {
      this.operations--;
    }
  }
  private start(
    lease: GrantLease,
    path: string,
    progress: (percent: number) => void,
    current: () => SessionTicket,
    cancel: Cancellation,
  ): Promise<AvatarUploadObserved> {
    if (!this.wx.uploadFile || this.nativeUploads >= 2)
      throw new ClientError('configuration', 'Native upload unavailable');
    const { grant } = lease;
    const sent = current();
    const releaseTransfer = this.registry.acquireTransfer(
      sent.credentials!.accountId,
    );
    this.nativeUploads++;
    return new Promise<AvatarUploadObserved>((resolve, reject) => {
      let settled = false,
        completed = false,
        interrupted = false,
        task: WxUploadTask | undefined;
      let stopCancel = () => undefined as void,
        stopDeadline = () => undefined as void,
        stopIdle = () => undefined as void;
      const detach = () => {
        try {
          task?.offProgressUpdate?.(onProgress);
        } catch {
          /* Local listeners are best effort. */
        }
      };
      const finish = (value: AvatarUploadObserved | ClientError) => {
        if (settled) return;
        settled = true;
        stopCancel();
        stopDeadline();
        stopIdle();
        detach();
        if (value instanceof ClientError) reject(value);
        else resolve(value);
      };
      const abort = (kind: 'cancelled' | 'timeout' | 'protocol') => {
        interrupted = true;
        finish(
          new ClientError(
            kind,
            'Image upload interrupted; original operation requires recovery',
          ),
        );
        try {
          task?.abort();
        } catch {
          /* abort is not server cancellation or quiescence. */
        }
      };
      const complete = () => {
        if (!completed) {
          completed = true;
          this.nativeUploads--;
          releaseTransfer();
        }
        if (!settled)
          finish(
            new ClientError('network', 'Upload completed without a receipt'),
          );
      };
      const idle = () => {
        stopIdle();
        stopIdle = this.clock.schedule(() => abort('timeout'), 15000);
      };
      const onProgress = (value: {
        progress: number;
        totalBytesSent: number;
        totalBytesExpectedToSend: number;
      }) => {
        if (settled) return;
        try {
          current();
          if (
            !Number.isFinite(value.progress) ||
            value.progress < 0 ||
            value.progress > 100 ||
            !avatarInteger(value.totalBytesSent, 0, AVATAR_MAX_BYTES + 65536) ||
            !avatarInteger(
              value.totalBytesExpectedToSend,
              1,
              AVATAR_MAX_BYTES + 65536,
            ) ||
            value.totalBytesSent > value.totalBytesExpectedToSend
          )
            avatarInvalid();
          idle();
          progress(value.progress);
        } catch {
          abort('cancelled');
        }
      };
      stopCancel = cancel.subscribe(() => abort('cancelled'));
      if (settled) {
        complete();
        return;
      }
      stopDeadline = this.clock.schedule(
        () => abort('timeout'),
        Math.max(1, lease.deadline - this.clock.now()),
      );
      idle();
      try {
        current();
        task = this.wx.uploadFile!({
          url: endpointUrl(
            this.origin,
            `/v1/me/profile/avatar-edits/${grant.editId}/uploads/${grant.grantId}`,
          ),
          filePath: path,
          name: 'file',
          header: { Authorization: `Bearer ${sent.credentials!.accessToken}` },
          timeout: Math.max(
            1,
            Math.min(120000, lease.deadline - this.clock.now()),
          ),
          success: (value) => {
            if (settled) return;
            try {
              current();
              if (typeof value.data !== 'string' || value.data.length > 8192)
                avatarInvalid();
              let body: unknown;
              try {
                body = JSON.parse(value.data) as unknown;
              } catch {
                avatarInvalid();
              }
              const failure = responseError({
                status: value.statusCode,
                headers: {},
                body,
              });
              if (failure) throw failure;
              if (value.statusCode !== 200) avatarInvalid();
              const receipt = decodeAvatarUploadObserved(body);
              if (
                receipt.editId !== grant.editId ||
                receipt.intentId !== grant.intentId ||
                receipt.grantId !== grant.grantId ||
                receipt.generation !== grant.generation ||
                receipt.bytes !== grant.expectedBytes ||
                receipt.sha256 !== grant.expectedSha256
              )
                avatarInvalid();
              if (this.clock.now() >= lease.deadline)
                throw new ClientError(
                  'timeout',
                  'Upload response passed local deadline; recover status',
                );
              // This exact authenticated receipt proves the server finished its
              // writer. A missing native complete still retains the native slot.
              releaseTransfer.releaseWriter();
              finish(receipt);
            } catch (error) {
              finish(clientError(error));
            }
          },
          fail: () =>
            finish(new ClientError('network', 'Image transfer not confirmed')),
          complete,
        });
        if (settled) {
          detach();
          if (interrupted) {
            try {
              task.abort();
            } catch {
              /* Already invalid. */
            }
          }
        } else {
          task.onProgressUpdate?.(onProgress);
          try {
            current();
          } catch {
            abort('cancelled');
          }
        }
      } catch (error) {
        finish(clientError(error));
        complete();
      }
    });
  }
  clearSession(ticket: SessionTicket): void {
    for (const [handle, lease] of this.grants)
      if (
        lease.ticket.epoch === ticket.epoch &&
        lease.ticket.credentials?.accountId === ticket.credentials?.accountId
      )
        this.grants.delete(handle);
    this.selection.clearSession(ticket);
  }
  remove(file: LocalMediaFile): Promise<void> {
    return this.selection.remove(file);
  }
}
