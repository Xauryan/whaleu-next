import { ClientError } from '../api/errors';
import type { SessionStore, SessionTicket } from '../auth/session';
import type { LocalMediaFile, MediaSession } from '../media/contracts';
import { Cancellation, type Clock } from '../platform/contracts';
import type { RatingDiscussionMediaContext } from './discussion-media-contract';
import type { DiscussionContent } from './discussion-media-read-contract';
import type { DiscussionReadTransfer } from './discussion-media-download';
export interface DiscussionGalleryView {
  readonly open: boolean;
  readonly status: 'idle' | 'loading' | 'ready' | 'unavailable';
  readonly localSrc: string;
  readonly index: number;
  readonly count: number;
}
export const initialDiscussionGallery = (): DiscussionGalleryView => ({
  open: false,
  status: 'idle',
  localSrc: '',
  index: 0,
  count: 0,
});
/** One visible allocation, shared 2 IO/4 lease/10 MiB registry. This in-page
 * gallery never invokes wx.previewImage, whose closing is not observable. */
export class RatingDiscussionGallery {
  private generation = 0;
  private cancel = new Cancellation();
  private file: LocalMediaFile | null = null;
  private owner = {};
  private ticket: SessionTicket;
  private disposed = false;
  private stopExpiry = () => undefined as void;
  private readonly unsubscribe: () => void;
  private view = initialDiscussionGallery();
  private loader:
    | ((cancel: Cancellation) => Promise<{
        context: RatingDiscussionMediaContext;
        subject: DiscussionContent;
      }>)
    | null = null;
  constructor(
    private readonly sessions: SessionStore,
    private readonly transfer: DiscussionReadTransfer | undefined,
    private readonly clock: Clock,
    private readonly render: (view: DiscussionGalleryView) => void,
  ) {
    this.ticket = sessions.snapshot();
    this.unsubscribe = sessions.subscribe(() => {
      const now = sessions.snapshot();
      if (
        now.epoch !== this.ticket.epoch ||
        now.credentials?.accountId !== this.ticket.credentials?.accountId
      ) {
        this.close();
        this.ticket = now;
      }
    });
  }
  private publish(view: DiscussionGalleryView) {
    this.view = Object.freeze(view);
    this.render(this.view);
  }
  private async release() {
    const file = this.file;
    this.file = null;
    if (file) await this.transfer?.release(file);
  }
  async open(
    loader: NonNullable<RatingDiscussionGallery['loader']>,
    index = 0,
  ): Promise<void> {
    this.loader = loader;
    await this.show(index);
  }
  async move(direction: -1 | 1): Promise<void> {
    const next = this.view.index + direction;
    if (next >= 0 && next < this.view.count) await this.show(next);
  }
  private async show(index: number): Promise<void> {
    this.cancel.cancel();
    this.stopExpiry();
    const generation = ++this.generation,
      cancel = (this.cancel = new Cancellation()),
      ticket = this.sessions.snapshot();
    this.publish({
      open: true,
      status: 'loading',
      localSrc: '',
      index,
      count: 0,
    });
    await this.release();
    const session: MediaSession = {
      current: () => {
        this.sessions.assertCurrent(ticket);
        if (
          this.disposed ||
          generation !== this.generation ||
          cancel.isCancelled
        )
          throw new ClientError('cancelled', 'Discussion gallery changed');
        return this.sessions.snapshot();
      },
    };
    try {
      session.current();
      if (!this.transfer || !this.loader)
        throw new ClientError(
          'configuration',
          'Current-device download unavailable',
        );
      const current = await this.loader(cancel);
      session.current();
      const descriptor = current.subject.images[index];
      if (!descriptor)
        throw new ClientError('protocol', 'Current full image set required');
      const file = await this.transfer.download(
        descriptor,
        current.context,
        'display-v1',
        this.owner,
        session,
        cancel,
      );
      try {
        session.current();
        this.file = file;
        const localSrc = await this.transfer.resolve(file, this.owner, ticket);
        session.current();
        this.publish({
          open: true,
          status: 'ready',
          localSrc,
          index,
          count: current.subject.images.length,
        });
        this.stopExpiry = this.clock.schedule(
          () => this.close(),
          Math.max(1, Date.parse(current.context.expiresAt) - this.clock.now()),
        );
      } catch (error) {
        await this.transfer.release(file);
        throw error;
      }
    } catch {
      if (!cancel.isCancelled && generation === this.generation)
        this.publish({
          open: true,
          status: 'unavailable',
          localSrc: '',
          index,
          count: 0,
        });
    }
  }
  close(): void {
    ++this.generation;
    this.cancel.cancel();
    this.stopExpiry();
    this.loader = null;
    this.publish(initialDiscussionGallery());
    void this.release();
  }
  dispose(): void {
    this.close();
    this.disposed = true;
    this.unsubscribe();
  }
}
