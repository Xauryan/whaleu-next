import { ClientError, clientError } from '../api/errors';
import { responseError } from '../api/envelopes';
import { endpointUrl, normalizeOrigin } from '../api/origin';
import type { SessionStore, SessionTicket } from '../auth/session';
import type { LocalMediaFile, MediaSession } from '../media/contracts';
import { AuthenticatedMediaUpload } from '../media/authenticated-upload';
import { MediaLocalFiles } from '../media/local-files';
import { uploadInteger } from '../media/upload-contracts';
import type { Cancellation, Clock } from '../platform/contracts';
import type {
  UploadFiles,
  WxUploadApi,
  WxUploadTask,
} from '../platform/wechat-upload';
import type { RatingDiscussionWindowTransfer } from './discussion-media-window';
import {
  decodeDiscussionGrant,
  decodeDiscussionUploadObserved,
  type DiscussionGrant,
  type DiscussionUploadObserved,
} from './discussion-media-wire';
export interface DiscussionNativeEffect {
  readonly result: Promise<DiscussionUploadObserved>;
  readonly complete: Promise<void>;
}
export interface DiscussionUploadTransfer extends RatingDiscussionWindowTransfer {
  upload(
    grant: DiscussionGrant,
    file: LocalMediaFile,
    session: MediaSession,
    cancel: Cancellation,
    progress: (percent: number) => void,
  ): Promise<DiscussionNativeEffect>;
  settled(accountId: string): boolean;
  clearSession(ticket: SessionTicket): void;
}
/** The selector only contributes native chooser/inspection capabilities; no
 * Community preparation, grants, purposes or upload routes are reused. */
export class RatingDiscussionUpload implements DiscussionUploadTransfer {
  private readonly origin: string;
  private readonly selection: AuthenticatedMediaUpload;
  private readonly active = new Map<
    LocalMediaFile,
    { accountId: string; complete: Promise<void> }
  >();
  constructor(
    origin: string,
    private readonly wx: WxUploadApi,
    files: UploadFiles,
    readonly localFiles: MediaLocalFiles,
    private readonly sessions: SessionStore,
    private readonly clock: Clock,
  ) {
    this.origin = normalizeOrigin(origin);
    this.selection = new AuthenticatedMediaUpload(
      origin,
      wx,
      files,
      localFiles,
      sessions,
      clock,
    );
  }
  pick(session: MediaSession, cancel: Cancellation): Promise<LocalMediaFile> {
    return this.selection.pick(session, cancel);
  }
  inspect(file: LocalMediaFile, session: MediaSession, cancel: Cancellation) {
    return this.selection.inspect(file, session, cancel);
  }
  settled(accountId: string): boolean {
    return ![...this.active.values()].some(
      (value) => value.accountId === accountId,
    );
  }
  clearSession(_ticket: SessionTicket): void {
    // Page cancellation revokes every selector callback. Do not ask the shared
    // selector to unlink a file still owned by a native upload.
  }
  async remove(file: LocalMediaFile): Promise<void> {
    const active = this.active.get(file);
    if (active) await active.complete;
    await this.selection.remove(file);
  }
  async upload(
    raw: DiscussionGrant,
    file: LocalMediaFile,
    session: MediaSession,
    cancel: Cancellation,
    progress: (percent: number) => void,
  ): Promise<DiscussionNativeEffect> {
    const grant = decodeDiscussionGrant(raw),
      ticket = session.current();
    const current = () => {
      this.sessions.assertCurrent(ticket);
      const now = session.current();
      this.sessions.assertCurrent(now);
      if (cancel.isCancelled)
        throw new ClientError('cancelled', 'Image operation changed');
      if (!now.credentials)
        throw new ClientError(
          'auth-required',
          'Original Ratings account required',
        );
      return now;
    };
    const declaration = await this.inspect(file, session, cancel);
    current();
    if (
      declaration.bytes !== grant.expectedBytes ||
      declaration.sha256 !== grant.expectedSha256 ||
      declaration.mime !== grant.expectedMime
    )
      throw new ClientError('protocol', 'Original image declaration mismatch');
    const path = await this.selection.resolveSelected(file, session, cancel),
      sent = current();
    const duration = Math.min(120000, grant.grantExpiresAt - grant.serverNow),
      deadline = this.clock.now() + duration;
    if (duration <= 0 || !this.wx.uploadFile || this.active.has(file))
      throw new ClientError('configuration', 'Native image upload unavailable');
    const credit = this.localFiles.acquireTransfer(sent.credentials!.accountId);
    let resolveComplete!: () => void;
    const completePromise = new Promise<void>((resolve) => {
      resolveComplete = resolve;
    });
    this.active.set(file, {
      accountId: sent.credentials!.accountId,
      complete: completePromise,
    });
    const result = new Promise<DiscussionUploadObserved>((resolve, reject) => {
      let settled = false,
        completed = false,
        enteredNative = false,
        task: WxUploadTask | undefined;
      let stopCancel = () => undefined as void,
        stopDeadline = () => undefined as void,
        stopIdle = () => undefined as void;
      const detach = () => {
        try {
          task?.offProgressUpdate?.(onProgress);
        } catch {
          /* Listener revocation is best effort. */
        }
      };
      const finish = (value: DiscussionUploadObserved | ClientError) => {
        if (settled) return;
        settled = true;
        stopCancel();
        stopDeadline();
        stopIdle();
        detach();
        if (value instanceof ClientError) reject(value);
        else resolve(value);
      };
      const abort = (kind: 'cancelled' | 'timeout') => {
        finish(new ClientError(kind, 'Original upload requires recovery'));
        try {
          task?.abort();
        } catch {
          /* Not a completion receipt. */
        }
      };
      const complete = () => {
        if (!completed) {
          completed = true;
          credit();
          this.active.delete(file);
          resolveComplete();
        }
        if (!settled)
          finish(
            new ClientError(
              'network',
              'Native upload completed without receipt',
            ),
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
            !uploadInteger(value.totalBytesSent, 0, 5 * 1024 * 1024 + 65536) ||
            !uploadInteger(
              value.totalBytesExpectedToSend,
              1,
              5 * 1024 * 1024 + 65536,
            ) ||
            value.totalBytesSent > value.totalBytesExpectedToSend
          )
            throw new ClientError('protocol', 'Invalid native upload progress');
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
      } // No native task was started.
      stopDeadline = this.clock.schedule(() => abort('timeout'), duration);
      idle();
      try {
        current();
        enteredNative = true;
        task = this.wx.uploadFile!({
          url: endpointUrl(
            this.origin,
            `/v3/media/ratings-discussion/members/${grant.memberId}/uploads/${grant.grantId}`,
          ),
          filePath: path,
          name: 'file',
          header: { Authorization: `Bearer ${sent.credentials!.accessToken}` },
          timeout: duration,
          success: (value) => {
            if (settled) return;
            try {
              current();
              if (typeof value.data !== 'string' || value.data.length > 8192)
                throw new ClientError('protocol', 'Invalid upload response');
              const body: unknown = JSON.parse(value.data),
                failure = responseError({
                  status: value.statusCode,
                  headers: {},
                  body,
                });
              if (failure) throw failure;
              if (value.statusCode !== 200)
                throw new ClientError('protocol', 'Invalid upload status');
              const receipt = decodeDiscussionUploadObserved(body);
              if (
                receipt.batchId !== grant.batchId ||
                receipt.memberId !== grant.memberId ||
                receipt.intentId !== grant.intentId ||
                receipt.grantId !== grant.grantId ||
                receipt.generation !== grant.generation ||
                receipt.bytes !== grant.expectedBytes ||
                receipt.sha256 !== grant.expectedSha256 ||
                this.clock.now() >= deadline
              )
                throw new ClientError(
                  'protocol',
                  'Original upload receipt mismatch',
                );
              credit.releaseWriter();
              finish(receipt);
            } catch (error) {
              finish(clientError(error));
            }
          },
          fail: () =>
            finish(
              new ClientError('network', 'Original upload remains unknown'),
            ),
          complete,
        });
        if (settled) {
          detach();
          if (cancel.isCancelled) {
            try {
              task.abort();
            } catch {
              /* Still wait for complete. */
            }
          }
        } else task.onProgressUpdate?.(onProgress);
      } catch (error) {
        finish(clientError(error));
        if (!enteredNative) complete();
        else {
          try {
            task?.abort();
          } catch {
            /* A thrown native call does not prove quiescence. */
          }
        }
      }
    });
    // The caller must observe response and native complete independently.
    return { result, complete: completePromise };
  }
}
