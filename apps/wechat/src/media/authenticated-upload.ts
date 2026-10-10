import { ClientError, clientError } from '../api/errors';
import { responseError } from '../api/envelopes';
import { endpointUrl, normalizeOrigin } from '../api/origin';
import type { AuthService } from '../auth/auth-service';
import type { SessionStore, SessionTicket } from '../auth/session';
import { cancellable } from '../platform/cancellable';
import type { Cancellation, Clock } from '../platform/contracts';
import { isNativeTemporaryPath } from '../platform/wechat-media';
import {
  pickerCancelled,
  type UploadFiles,
  type WxUploadApi,
  type WxUploadTask,
} from '../platform/wechat-upload';
import type { LocalMediaFile, MediaSession } from './contracts';
import { MediaLocalFiles } from './local-files';
import {
  decodeUploadGrant,
  decodeUploadObserved,
  MEDIA_UPLOAD_MAX_BYTES,
  uploadInteger,
  uploadInvalid,
  type InspectedUpload,
  type UploadGrant,
  type UploadHandle,
  type UploadObserved,
  type UploadTransfer,
} from './upload-contracts';
interface GrantLease {
  readonly grant: UploadGrant;
  readonly ticket: SessionTicket;
  readonly deadline: number;
}
/** Fixed first-party multipart only. Device redirect/header/domain acceptance remains an external gate. */
export class AuthenticatedMediaUpload implements UploadTransfer {
  private readonly origin: string;
  private readonly owner = {};
  private readonly grants = new Map<UploadHandle, GrantLease>();
  private readonly owned = new Map<LocalMediaFile, SessionTicket>();
  private sequence = 0;
  private nativeUploads = 0;
  private pickerActive = 0;
  private operations = 0;
  constructor(
    origin: string,
    private readonly wx: WxUploadApi,
    private readonly files: UploadFiles,
    private readonly registry: MediaLocalFiles,
    private readonly sessions: SessionStore,
    private readonly clock: Clock,
    private readonly auth?: Pick<AuthService, 'refresh'>,
    private readonly protocolVersion: 2 | 3 = 2,
  ) {
    this.origin = normalizeOrigin(origin);
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
  async pick(
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<LocalMediaFile> {
    const ticket = this.current(session, cancel);
    if (
      !this.wx.chooseMedia ||
      this.pickerActive ||
      this.operations >= 2 ||
      !this.registry.capacityAvailable
    )
      throw new ClientError('configuration', 'Image selection unavailable');
    const reservation = this.registry.reserve();
    const releaseNativeReservation = this.registry.holdReservation(reservation);
    this.pickerActive++;
    this.operations++;
    let path: string | undefined;
    let adopted = false;
    try {
      path = await new Promise<string>((resolve, reject) => {
        let settled = false,
          completed = false;
        const received = new Set<string>();
        let stopCancel = () => undefined as void,
          stopTimer = () => undefined as void;
        const finish = (value: string | ClientError) => {
          if (settled) return;
          settled = true;
          stopCancel();
          stopTimer();
          if (value instanceof ClientError) reject(value);
          else resolve(value);
        };
        const complete = () => {
          if (!completed) {
            completed = true;
            this.pickerActive--;
            releaseNativeReservation();
          }
          if (!settled)
            finish(new ClientError('network', 'Image selection incomplete'));
        };
        stopCancel = cancel.subscribe(() =>
          finish(new ClientError('cancelled', 'Image selection cancelled')),
        );
        if (settled) {
          complete();
          return;
        }
        stopTimer = this.clock.schedule(
          () => finish(new ClientError('timeout', 'Image selection timed out')),
          120000,
        );
        try {
          this.current(session, cancel, ticket);
          this.wx.chooseMedia!({
            count: 1,
            mediaType: ['image'],
            sizeType: ['original'],
            success: (value) => {
              const output = value.tempFiles?.[0]?.tempFilePath;
              if (isNativeTemporaryPath(output)) {
                if (received.has(output)) return;
                received.add(output);
              }
              if (settled) {
                if (isNativeTemporaryPath(output) && output !== path)
                  void this.registry.discard(output, reservation);
                return;
              }
              try {
                this.current(session, cancel, ticket);
                if (
                  value.tempFiles.length !== 1 ||
                  !isNativeTemporaryPath(output)
                )
                  uploadInvalid();
                path = output;
                finish(output);
              } catch (error) {
                if (isNativeTemporaryPath(output))
                  void this.registry.discard(output, reservation);
                finish(clientError(error));
              }
            },
            fail: (error) =>
              finish(
                new ClientError(
                  pickerCancelled(error) ? 'cancelled' : 'configuration',
                  'Image selection did not complete',
                ),
              ),
            complete,
          });
        } catch (error) {
          complete();
          finish(clientError(error));
        }
      });
      this.current(session, cancel, ticket);
      const size = await cancellable(this.files.stat(path), cancel);
      this.current(session, cancel, ticket);
      if (!uploadInteger(size, 1, MEDIA_UPLOAD_MAX_BYTES)) uploadInvalid();
      const file = this.registry.adopt(
        path,
        size,
        this.owner,
        ticket,
        reservation,
      );
      this.owned.set(file, ticket);
      adopted = true;
      return file;
    } finally {
      this.operations--;
      if (path && !adopted) await this.registry.discard(path, reservation);
      this.registry.releaseReservation(reservation);
    }
  }
  async inspect(
    file: LocalMediaFile,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<InspectedUpload> {
    const ticket = this.current(session, cancel);
    const path = await cancellable(
      this.registry.resolve(file, this.owner, ticket),
      cancel,
    );
    this.current(session, cancel, ticket);
    const bytes = await cancellable(this.files.stat(path), cancel);
    this.current(session, cancel, ticket);
    const info = await cancellable(this.files.image(path), cancel);
    this.current(session, cancel, ticket);
    const mime =
      info.type.toLowerCase() === 'jpeg'
        ? 'image/jpeg'
        : info.type.toLowerCase() === 'png'
          ? 'image/png'
          : null;
    if (
      !mime ||
      !uploadInteger(bytes, 1, MEDIA_UPLOAD_MAX_BYTES) ||
      !uploadInteger(info.width, 1, 8192) ||
      !uploadInteger(info.height, 1, 8192) ||
      info.width * info.height > 24000000
    )
      uploadInvalid();
    const digest = await this.files.digest(
      path,
      bytes,
      () => {
        this.current(session, cancel, ticket);
      },
      cancel,
    );
    this.current(session, cancel, ticket);
    return Object.freeze({
      mime,
      bytes,
      sha256: digest,
      width: info.width,
      height: info.height,
      frameCount: 'unknown',
    });
  }
  register(raw: UploadGrant, session: MediaSession): UploadHandle {
    const ticket = this.current(session);
    const grant = decodeUploadGrant(raw);
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
    handle: UploadHandle,
    file: LocalMediaFile,
    progress: (percent: number) => void,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<UploadObserved> {
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
        uploadInvalid();
      const path = await cancellable(
        this.registry.resolve(file, this.owner, lease.ticket),
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
  ): Promise<UploadObserved> {
    if (!this.wx.uploadFile || this.nativeUploads >= 2)
      throw new ClientError('configuration', 'Native upload unavailable');
    const { grant } = lease;
    const sent = current();
    const releaseTransfer = this.registry.acquireTransfer(
      sent.credentials!.accountId,
    );
    this.nativeUploads++;
    return new Promise<UploadObserved>((resolve, reject) => {
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
      const finish = (value: UploadObserved | ClientError) => {
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
            !uploadInteger(
              value.totalBytesSent,
              0,
              MEDIA_UPLOAD_MAX_BYTES + 65536,
            ) ||
            !uploadInteger(
              value.totalBytesExpectedToSend,
              1,
              MEDIA_UPLOAD_MAX_BYTES + 65536,
            ) ||
            value.totalBytesSent > value.totalBytesExpectedToSend
          )
            uploadInvalid();
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
            `/v${this.protocolVersion}/media/upload-intents/${grant.intentId}/uploads/${grant.grantId}`,
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
                uploadInvalid();
              let body: unknown;
              try {
                body = JSON.parse(value.data) as unknown;
              } catch {
                uploadInvalid();
              }
              const failure = responseError({
                status: value.statusCode,
                headers: {},
                body,
              });
              if (failure) throw failure;
              if (value.statusCode !== 200) uploadInvalid();
              const receipt = decodeUploadObserved(body);
              if (
                receipt.intentId !== grant.intentId ||
                receipt.grantId !== grant.grantId ||
                receipt.generation !== grant.generation ||
                receipt.bytes !== grant.expectedBytes ||
                receipt.sha256 !== grant.expectedSha256
              )
                uploadInvalid();
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
    for (const [file, owner] of this.owned)
      if (
        owner.epoch === ticket.epoch &&
        owner.credentials?.accountId === ticket.credentials?.accountId
      ) {
        this.owned.delete(file);
        void this.registry.release(file);
      }
  }
  remove(file: LocalMediaFile): Promise<void> {
    this.owned.delete(file);
    return this.registry.release(file);
  }
}
