import {
  decodeRatingTargetCoverContext,
  type RatingTargetCoverContext,
} from './target-cover-context';
import { ClientError } from '../api/errors';
import { responseError } from '../api/envelopes';
import { endpointUrl, normalizeOrigin } from '../api/origin';
import type { AuthService } from '../auth/auth-service';
import type { SessionStore, SessionTicket } from '../auth/session';
import { cancellable } from '../platform/cancellable';
import type { Cancellation, Clock } from '../platform/contracts';
import type {
  MediaFiles,
  WxMediaApi,
  WxMediaDownloadTask,
} from '../platform/wechat-media';
import { isNativeTemporaryPath } from '../platform/wechat-media';
import type {
  LocalMediaFile,
  MediaSession,
  MediaVariant,
} from '../media/contracts';
import {
  decodeRatingCoverDescriptor,
  type RatingCoverDescriptor,
} from './target-cover-media-contract';
import { MediaLocalFiles, type MediaReservation } from '../media/local-files';

export interface RatingCoverReadTransfer {
  download(
    attachment: RatingCoverDescriptor,
    scope: RatingTargetCoverContext,
    variant: MediaVariant,
    owner: object,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<LocalMediaFile>;
  resolve(
    file: LocalMediaFile,
    owner: object,
    ticket: SessionTicket,
  ): Promise<string>;
  release(file: LocalMediaFile): Promise<void>;
}
interface Downloaded {
  readonly path: string;
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
}
const MAX_BYTES = 5 * 1024 * 1024;
/** Always direct first-party authenticated GET. The deployment must separately verify
 * native redirects cannot forward Authorization outside this origin. No URL from a DTO.
 * A missing onHeadersReceived callback is a hard failure, never fabricated from success. */
export class RatingCoverDownload implements RatingCoverReadTransfer {
  private readonly origin: string;
  private active = 0;
  private operations = 0;
  constructor(
    origin: string,
    private readonly wx: WxMediaApi,
    private readonly files: MediaFiles,
    private readonly registry: MediaLocalFiles,
    private readonly sessions: SessionStore,
    private readonly auth: Pick<AuthService, 'refresh'>,
    private readonly clock: Clock,
  ) {
    this.origin = normalizeOrigin(origin);
  }
  async resolve(
    file: LocalMediaFile,
    owner: object,
    ticket: SessionTicket,
  ): Promise<string> {
    this.sessions.assertCurrent(ticket);
    const path = await this.registry.resolve(file, owner, ticket);
    this.sessions.assertCurrent(ticket);
    return path;
  }
  release(file: LocalMediaFile): Promise<void> {
    return this.registry.release(file);
  }
  async download(
    input: RatingCoverDescriptor,
    scope: RatingTargetCoverContext,
    variant: MediaVariant,
    owner: object,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<LocalMediaFile> {
    if (this.operations >= 2)
      throw new ClientError(
        'configuration',
        'Image download capacity unavailable',
      );
    this.operations++;
    try {
      return await this.perform(input, scope, variant, owner, session, cancel);
    } finally {
      this.operations--;
    }
  }
  private async perform(
    input: RatingCoverDescriptor,
    scope: RatingTargetCoverContext,
    variant: MediaVariant,
    owner: object,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<LocalMediaFile> {
    const descriptor = decodeRatingCoverDescriptor(input);
    const context = decodeRatingTargetCoverContext(scope);
    if (
      descriptor.contextId !== context.id ||
      descriptor.contextToken !== context.token ||
      context.mode !== 'public' ||
      context.purpose !== 'read' ||
      !context.capabilities.includes('target_cover')
    )
      throw new ClientError(
        'protocol',
        'Exact Ratings cover read scope required',
      );
    if (variant !== 'thumb-v1' && variant !== 'display-v1')
      throw new ClientError('protocol', 'Invalid image variant');
    const ticket = session.current();
    const current = () => {
      this.sessions.assertCurrent(ticket);
      const now = session.current();
      this.sessions.assertCurrent(now);
      if (cancel.isCancelled)
        throw new ClientError('cancelled', 'Image request cancelled');
      if (
        context.actorId !== now.credentials?.accountId ||
        Date.parse(context.expiresAt) <= this.clock.now()
      )
        throw new ClientError('stale-session', 'Ratings cover scope expired');
      if (!now.credentials)
        throw new ClientError('auth-required', 'Sign in to view image');
      return now;
    };
    const url = endpointUrl(
      this.origin,
      `/v3/media/ratings-target/targets/${descriptor.targetId}/appearances/${descriptor.appearanceId}/${variant}`,
      { contextId: context.id, contextToken: context.token },
    );
    for (let attempt = 0; attempt < 2; attempt++) {
      await cancellable(this.registry.retryCleanup(), cancel);
      const sent = current();
      // Incomplete native callbacks retain their task credits even after abort.
      // Report that admission boundary before considering a new byte reservation.
      this.registry.assertTransferCapacity();
      const reservation = this.registry.reserve();
      try {
        const downloaded = await this.start(
          url,
          sent.credentials!.accessToken,
          current,
          cancel,
          reservation,
        );
        let retained = false;
        let cleaned = false;
        try {
          current();
          const { path, headers, status } = downloaded;
          const size = await cancellable(this.files.stat(path), cancel);
          current();
          if (!Number.isSafeInteger(size) || size < 1 || size > MAX_BYTES)
            throw new ClientError('protocol', 'Invalid image size');
          if (status !== 200) {
            let body: unknown;
            if (
              headers['content-type']?.split(';')[0]?.trim().toLowerCase() ===
                'application/json' &&
              size <= 8192
            ) {
              body = await cancellable(
                this.files.readError(path, size),
                cancel,
              );
              current();
            }
            const failure = responseError({ status, headers, body });
            // Delete the error response before refresh; a bare 401 never causes auth replay.
            await this.registry.discard(path, reservation);
            cleaned = true;
            current();
            if (
              attempt === 0 &&
              status === 401 &&
              failure?.kind === 'auth-expired'
            ) {
              await cancellable(this.auth.refresh(sent), cancel);
              current();
              continue;
            }
            throw (
              failure ??
              new ClientError('protocol', 'Expected a complete image response')
            );
          }
          const mime = headers['content-type'];
          if (
            (mime !== 'image/jpeg' && mime !== 'image/png') ||
            !/^[1-9][0-9]*$/.test(headers['content-length'] ?? '') ||
            Number(headers['content-length']) !== size ||
            headers['content-range'] !== undefined ||
            headers.location !== undefined ||
            !headers['cache-control']
              ?.toLowerCase()
              .split(',')
              .map((value) => value.trim())
              .includes('no-store') ||
            !headers['cache-control']
              ?.toLowerCase()
              .split(',')
              .map((value) => value.trim())
              .includes('private')
          )
            throw new ClientError(
              'protocol',
              'Invalid authenticated image response',
            );
          const info = await cancellable(this.files.image(path), cancel);
          current();
          const limit = variant === 'thumb-v1' ? 400 : 2048;
          if (
            !Number.isSafeInteger(info.width) ||
            !Number.isSafeInteger(info.height) ||
            info.width < 1 ||
            info.height < 1 ||
            info.width > limit ||
            info.height > limit ||
            info.type.toLowerCase() !==
              (mime === 'image/jpeg' ? 'jpeg' : 'png') ||
            (variant === 'display-v1' &&
              (info.width !== descriptor.width ||
                info.height !== descriptor.height))
          )
            throw new ClientError('protocol', 'Invalid local image');
          // getImageInfo is presentation validation, NOT a frame-count/security approval.
          if ((await cancellable(this.files.stat(path), cancel)) !== size)
            throw new ClientError('storage', 'Temporary image changed');
          current();
          const file = this.registry.adopt(
            path,
            size,
            owner,
            current(),
            reservation,
          );
          retained = true;
          return file;
        } finally {
          if (!retained && !cleaned)
            await this.registry.discard(downloaded.path, reservation);
        }
      } finally {
        this.registry.releaseReservation(reservation);
      }
    }
    throw new ClientError('auth-required', 'Sign in to view image');
  }
  private start(
    url: string,
    token: string,
    current: () => SessionTicket,
    cancel: Cancellation,
    reservation: MediaReservation,
  ): Promise<Downloaded> {
    current();
    if (!this.wx.downloadFile || this.active >= 2)
      return Promise.reject(
        new ClientError(
          'configuration',
          'Authenticated image download unavailable',
        ),
      );
    const releaseTransfer = this.registry.acquireTransfer();
    const releaseReservation = this.registry.holdReservation(reservation);
    this.active++;
    return new Promise<Downloaded>((resolve, reject) => {
      let settled = false;
      let completed = false;
      let task: WxMediaDownloadTask | undefined;
      let headers: Record<string, string> | undefined;
      let headerCount = 0;
      const received = new Set<string>();
      let stopCancel = () => undefined as void;
      let stopTimer = () => undefined as void;
      const releaseSlot = () => {
        if (!completed) {
          completed = true;
          this.active--;
          releaseTransfer();
          releaseReservation();
        }
      };
      const detach = () => {
        try {
          task?.offHeadersReceived?.(onHeaders);
          task?.offProgressUpdate?.(onProgress);
        } catch {
          /* best effort */
        }
      };
      const finish = (value: Downloaded | ClientError) => {
        if (settled) return;
        settled = true;
        stopCancel();
        stopTimer();
        detach();
        if (value instanceof ClientError) reject(value);
        else resolve(value);
      };
      const abort = (kind: 'cancelled' | 'timeout' | 'protocol') => {
        finish(
          new ClientError(kind, 'Authenticated image download interrupted'),
        );
        try {
          task?.abort();
        } catch {
          /* A late output is still owned and removed. */
        }
      };
      const onProgress = (value: { totalBytesWritten: number }) => {
        if (settled) return;
        try {
          current();
          if (
            !Number.isSafeInteger(value.totalBytesWritten) ||
            value.totalBytesWritten < 0 ||
            value.totalBytesWritten > MAX_BYTES
          )
            abort('protocol');
        } catch {
          abort('cancelled');
        }
      };
      const onHeaders = (value: { header: Record<string, unknown> }) => {
        if (settled) return;
        try {
          current();
          if (
            ++headerCount !== 1 ||
            !value.header ||
            typeof value.header !== 'object'
          )
            return abort('protocol');
          const normalized: Record<string, string> = {};
          for (const [name, entry] of Object.entries(value.header)) {
            const key = name.toLowerCase();
            if (normalized[key] !== undefined || typeof entry !== 'string')
              return abort('protocol');
            normalized[key] = entry;
          }
          const length = normalized['content-length'];
          if (
            length !== undefined &&
            (!/^[1-9][0-9]*$/.test(length) || Number(length) > MAX_BYTES)
          )
            return abort('protocol');
          headers = normalized;
        } catch {
          abort('cancelled');
        }
      };
      stopCancel = cancel.subscribe(() => abort('cancelled'));
      stopTimer = this.clock.schedule(() => abort('timeout'), 15_000);
      if (settled) {
        stopCancel();
        stopTimer();
        releaseSlot();
        return;
      }
      try {
        current();
        task = this.wx.downloadFile!({
          url,
          header: { Authorization: `Bearer ${token}` },
          timeout: 15_000,
          success: (value) => {
            const path = value.tempFilePath;
            if (!isNativeTemporaryPath(path)) {
              finish(
                new ClientError('protocol', 'Invalid temporary image path'),
              );
              return;
            }
            if (received.has(path)) return;
            received.add(path);
            if (settled) {
              void this.registry.discard(path, reservation);
              return;
            }
            try {
              current();
              if (!headers || headerCount !== 1)
                throw new ClientError(
                  'protocol',
                  'Image response headers unavailable',
                );
              finish({ path, status: value.statusCode, headers });
            } catch {
              void this.registry.discard(path, reservation);
              finish(
                new ClientError(
                  'protocol',
                  'Image response is no longer usable',
                ),
              );
            }
          },
          fail: () =>
            finish(new ClientError('network', 'Image download failed')),
          complete: () => {
            releaseSlot();
            detach();
          },
        });
        if (!task.onHeadersReceived || !task.onProgressUpdate)
          abort('protocol');
        else if (!settled) {
          task.onHeadersReceived(onHeaders);
          if (!settled) task.onProgressUpdate(onProgress);
        }
        // Cancellation can happen synchronously while downloadFile constructs its task.
        if (settled) {
          detach();
          try {
            task.abort();
          } catch {
            /* best effort */
          }
        }
      } catch {
        releaseSlot();
        finish(new ClientError('network', 'Image download could not start'));
      }
    });
  }
}
