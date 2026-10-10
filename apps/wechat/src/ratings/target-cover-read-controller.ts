import { ClientError } from '../api/errors';
import type { SessionStore, SessionTicket } from '../auth/session';
import type { LocalMediaFile, MediaSession } from '../media/contracts';
import { Cancellation, type Clock } from '../platform/contracts';
import {
  decodeRatingCoverDescriptor,
  type RatingCoverDescriptor,
} from './target-cover-media-contract';
import {
  decodeRatingTargetCoverContext,
  type RatingTargetCoverContext,
} from './target-cover-context';
import type { RatingCoverReadTransfer } from './target-cover-download';
export interface RatingCoverReadView {
  readonly status: 'idle' | 'loading' | 'ready' | 'none' | 'unavailable';
  readonly localSrc: string;
  readonly expanded: boolean;
}
export interface RatingCoverCurrent {
  readonly context: RatingTargetCoverContext;
  readonly cover: RatingCoverDescriptor | null;
}
export type RatingCoverCurrentLoader = (
  session: MediaSession,
  cancel: Cancellation,
) => Promise<RatingCoverCurrent>;
/** In-page preview only. Every open/close reloads current authority. A platform
 * previewImage callback is never used as proof that an image is no longer visible. */
export class RatingCoverReadController {
  private generation = 0;
  private cancel = new Cancellation();
  private file: LocalMediaFile | null = null;
  private stopExpiry: () => void = () => undefined;
  private currentLoader: RatingCoverCurrentLoader | null = null;
  private disposed = false;
  private principal: SessionTicket;
  private readonly owner = {};
  private readonly unsubscribe: () => void;
  private view: RatingCoverReadView = {
    status: 'idle',
    localSrc: '',
    expanded: false,
  };
  constructor(
    private readonly sessions: SessionStore,
    private readonly transfer: RatingCoverReadTransfer | undefined,
    private readonly clock: Clock,
    private readonly render: (view: RatingCoverReadView) => void,
  ) {
    this.principal = sessions.snapshot();
    this.unsubscribe = sessions.subscribe(() => {
      const now = sessions.snapshot();
      if (
        now.epoch !== this.principal.epoch ||
        now.credentials?.accountId !== this.principal.credentials?.accountId
      ) {
        this.clear();
        this.principal = now;
      }
    });
  }
  snapshot(): RatingCoverReadView {
    return this.view;
  }
  private publish(value: RatingCoverReadView): void {
    this.view = Object.freeze(value);
    this.render(this.view);
  }
  load(loader: RatingCoverCurrentLoader, expanded = false): Promise<void> {
    this.currentLoader = loader;
    return this.start(expanded);
  }
  open(): Promise<void> {
    return this.start(true);
  }
  close(): Promise<void> {
    return this.start(false);
  }
  private invalidate(): void {
    ++this.generation;
    this.cancel.cancel();
    this.stopExpiry();
    this.stopExpiry = () => undefined;
    if (this.file) void this.transfer?.release(this.file);
    this.file = null;
    this.publish({ status: 'idle', localSrc: '', expanded: false });
  }
  private async start(expanded: boolean): Promise<void> {
    this.invalidate();
    if (!this.currentLoader || this.disposed) return;
    const ticket = this.sessions.snapshot(),
      generation = this.generation,
      cancel = (this.cancel = new Cancellation());
    const session: MediaSession = {
      current: () => {
        this.sessions.assertCurrent(ticket);
        if (
          !ticket.credentials ||
          cancel.isCancelled ||
          generation !== this.generation ||
          this.disposed
        )
          throw new ClientError('cancelled', 'Ratings cover view unavailable');
        return this.sessions.snapshot();
      },
    };
    this.publish({ status: 'loading', localSrc: '', expanded });
    try {
      session.current();
      const value = await this.currentLoader(session, cancel);
      session.current();
      const context = decodeRatingTargetCoverContext(value.context);
      if (
        context.actorId !== ticket.credentials?.accountId ||
        context.purpose !== 'read' ||
        context.mode !== 'public' ||
        Date.parse(context.expiresAt) <= this.clock.now() ||
        (value.cover !== null && !context.capabilities.includes('target_cover'))
      )
        throw new ClientError(
          'protocol',
          'Current Ratings cover scope unavailable',
        );
      if (value.cover === null) {
        this.publish({ status: 'none', localSrc: '', expanded: false });
        return;
      }
      const cover = decodeRatingCoverDescriptor(value.cover);
      if (
        cover.contextId !== context.id ||
        cover.contextToken !== context.token
      )
        throw new ClientError('protocol', 'Ratings descriptor scope mismatch');
      if (!this.transfer)
        throw new ClientError(
          'configuration',
          'Ratings cover native transport unavailable',
        );
      const file = await this.transfer.download(
        cover,
        context,
        expanded ? 'display-v1' : 'thumb-v1',
        this.owner,
        session,
        cancel,
      );
      try {
        session.current();
      } catch (error) {
        await this.transfer.release(file);
        throw error;
      }
      this.file = file;
      const localSrc = await this.transfer.resolve(file, this.owner, ticket);
      session.current();
      const lease = Math.min(
        30000,
        Date.parse(context.expiresAt) - this.clock.now(),
      );
      if (lease <= 0)
        throw new ClientError('timeout', 'Ratings cover lease expired');
      this.stopExpiry = this.clock.schedule(() => this.invalidate(), lease);
      this.publish({ status: 'ready', localSrc, expanded });
    } catch {
      if (!cancel.isCancelled && generation === this.generation) {
        this.invalidate();
        this.publish({ status: 'unavailable', localSrc: '', expanded: false });
      }
    }
  }
  imageFailed(): void {
    this.invalidate();
    this.publish({ status: 'unavailable', localSrc: '', expanded: false });
  }
  clear(): void {
    this.currentLoader = null;
    this.invalidate();
  }
  hide(): void {
    this.clear();
  }
  dispose(): void {
    this.disposed = true;
    this.unsubscribe();
    this.clear();
  }
}
