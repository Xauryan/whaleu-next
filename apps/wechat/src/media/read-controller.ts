import { ClientError } from '../api/errors';
import { SessionStore, type SessionTicket } from '../auth/session';
import type { PrivateViewLifecycle } from '../identity-privacy/overlay';
import { cancellable } from '../platform/cancellable';
import { Cancellation } from '../platform/contracts';
import type { MediaReadTransfer } from './authenticated-download';
import type {
  LocalMediaFile,
  MediaAttachment,
  MediaSession,
} from './contracts';
import { decodeMediaAttachment } from './decoders';

export interface MediaReadView {
  readonly status: 'idle' | 'loading' | 'ready' | 'denied' | 'unavailable';
  /** Only the temporary capability registry may resolve this ephemeral UI value. */
  readonly localSrc: string;
  readonly expanded: boolean;
}
export const initialMediaReadView = (): MediaReadView => ({
  status: 'idle',
  localSrc: '',
  expanded: false,
});
interface Read {
  readonly ticket: SessionTicket;
  readonly cancel: Cancellation;
  readonly session: MediaSession;
  readonly owner: object;
  file: LocalMediaFile | null;
}
/** A viewer controller, independent of any upload Work. No persistent cache and no
 * wx.previewImage: its success/complete callbacks are not preview-close signals. */
export class MediaReadController {
  private read: Read | null = null;
  private descriptor: MediaAttachment | null = null;
  private descriptorTicket: SessionTicket | null = null;
  private running: Promise<void> | null = null;
  private releasing: Promise<void> = Promise.resolve();
  private settling: Promise<void> = Promise.resolve();
  private beforeRead: Promise<void> | undefined;
  private disposed = false;
  private view = initialMediaReadView();
  private readonly unsubscribe: () => void;
  private readonly stopPrivate: () => void;
  constructor(
    private readonly sessions: SessionStore,
    private readonly transfer: MediaReadTransfer | undefined,
    private readonly render: (view: MediaReadView) => void,
    privateViews?: PrivateViewLifecycle,
  ) {
    this.unsubscribe = sessions.subscribe(() => {
      if (!this.descriptorTicket) return;
      try {
        sessions.assertCurrent(this.descriptorTicket);
      } catch {
        this.clear();
      }
    });
    this.stopPrivate =
      privateViews?.subscribe((accountId) => {
        if (
          !accountId ||
          accountId === this.descriptorTicket?.credentials?.accountId
        )
          this.clear();
      }) ?? (() => undefined);
  }
  snapshot(): MediaReadView {
    return this.view;
  }
  /** Called only after a fresh parent read; null is sent BEFORE reload/deletion. */
  load(
    attachment: MediaAttachment | null,
    beforeRead?: Promise<void>,
  ): Promise<void> {
    this.clear();
    this.beforeRead = beforeRead;
    if (!attachment || this.disposed) return Promise.resolve();
    try {
      this.descriptor = decodeMediaAttachment(attachment);
      this.descriptorTicket = this.sessions.snapshot();
    } catch {
      this.publish({ status: 'unavailable', localSrc: '', expanded: false });
      return Promise.resolve();
    }
    return this.start(false);
  }
  /** Each new expanded viewing request reauthorizes; repeated in-flight taps coalesce. */
  open(): Promise<void> {
    if (this.running) return this.running;
    return this.start(true);
  }
  close(): Promise<void> {
    if (!this.view.expanded) return this.running ?? Promise.resolve();
    return this.start(false);
  }
  imageFailed(source?: string): void {
    if (!this.read || (source !== undefined && source !== this.view.localSrc))
      return;
    this.invalidate();
    this.publish({ status: 'unavailable', localSrc: '', expanded: false });
  }
  clear(): void {
    this.descriptor = null;
    this.descriptorTicket = null;
    this.beforeRead = undefined;
    this.invalidate();
  }
  /** Revoke sources now; a different reader must await owned cleanup. */
  clearAndWait(): Promise<void> {
    this.clear();
    return Promise.all([this.releasing, this.settling]).then(() => undefined);
  }
  hide(): void {
    this.clear();
  }
  dispose(): void {
    this.disposed = true;
    this.unsubscribe();
    this.stopPrivate();
    this.clear();
  }
  private start(expanded: boolean): Promise<void> {
    const descriptor = this.descriptor;
    if (this.disposed || !descriptor) return Promise.resolve();
    this.invalidate();
    if (!this.descriptorTicket) return Promise.resolve();
    try {
      this.sessions.assertCurrent(this.descriptorTicket);
    } catch {
      this.clear();
      return Promise.resolve();
    }
    const ticket = this.sessions.snapshot();
    if (!ticket.credentials || !this.transfer) {
      this.publish({
        status: ticket.credentials ? 'unavailable' : 'denied',
        localSrc: '',
        expanded: false,
      });
      return Promise.resolve();
    }
    const cancel = new Cancellation();
    const read: Read = {
      ticket,
      cancel,
      owner: {},
      file: null,
      session: {
        current: () => {
          this.sessions.assertCurrent(ticket);
          if (cancel.isCancelled || this.read !== read || this.disposed)
            throw new ClientError('cancelled', 'Image view superseded');
          return this.sessions.snapshot();
        },
      },
    };
    this.read = read;
    this.publish({ status: 'loading', localSrc: '', expanded });
    const operation = this.run(read, descriptor, expanded, this.beforeRead);
    this.running = operation;
    void operation.then(() => {
      if (this.running === operation) this.running = null;
    });
    return operation;
  }
  private async run(
    read: Read,
    descriptor: MediaAttachment,
    expanded: boolean,
    beforeRead: Promise<void> | undefined,
  ): Promise<void> {
    const transfer = this.transfer!;
    try {
      if (beforeRead) await beforeRead;
      read.session.current();
      // Observe late resolution even if an adapter ignores cancellation.
      const received = transfer
        .download(
          descriptor,
          'display-v1',
          read.owner,
          read.session,
          read.cancel,
        )
        .then(async (file) => {
          if (!this.current(read)) {
            await this.trackRelease(transfer.release(file));
            throw new ClientError('cancelled', 'Image view superseded');
          }
          read.file = file;
          return file;
        });
      this.settling = Promise.all([
        this.settling,
        received.then(
          () => undefined,
          () => undefined,
        ),
      ]).then(() => undefined);
      const file = await cancellable(received, read.cancel);
      read.session.current();
      const localSrc = await cancellable(
        transfer.resolve(file, read.owner, read.session.current()),
        read.cancel,
      );
      read.session.current();
      this.publish({ status: 'ready', localSrc, expanded });
    } catch (error) {
      if (!this.current(read)) return;
      this.invalidate();
      const denied =
        error instanceof ClientError &&
        error.kind !== 'protocol' &&
        ((error.kind === 'auth-required' &&
          error.details.httpStatus === undefined) ||
          [
            'AUTHENTICATION_REQUIRED',
            'SESSION_REVOKED',
            'ACCESS_TOKEN_EXPIRED',
            'ACCOUNT_BLOCKED',
            'AUTHORIZATION_REQUIRED',
            'STUDENT_VERIFICATION_REQUIRED',
            'POST_NOT_FOUND',
            'POST_BLOCKED_BY_YOU',
          ].includes(error.details.serverCode ?? ''));
      this.publish({
        status: denied ? 'denied' : 'unavailable',
        localSrc: '',
        expanded: false,
      });
    }
  }
  private current(read: Read): boolean {
    try {
      read.session.current();
      return true;
    } catch {
      return false;
    }
  }
  private trackRelease(release: Promise<void>): Promise<void> {
    this.releasing = Promise.all([
      this.releasing,
      release.catch(() => undefined),
    ]).then(() => undefined);
    return this.releasing;
  }
  private invalidate(): void {
    const read = this.read;
    this.read = null;
    this.running = null;
    // Remove the visible source synchronously BEFORE abort/unlink callbacks can run.
    try {
      this.publish(initialMediaReadView());
    } finally {
      if (read) {
        try {
          read.cancel.cancel();
        } finally {
          if (read.file && this.transfer)
            void this.trackRelease(this.transfer.release(read.file));
          read.file = null;
        }
      }
    }
  }
  private publish(view: MediaReadView): void {
    this.view = Object.freeze(view);
    this.render(this.view);
  }
}
