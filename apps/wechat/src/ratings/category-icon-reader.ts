import { ClientError } from '../api/errors';
import type { SessionStore } from '../auth/session';
import type { LocalMediaFile, MediaSession } from '../media/contracts';
import { Cancellation, type Clock } from '../platform/contracts';
import type { CategoryIconReadTransfer } from './category-icon-download';
import {
  categoryIconReadAuthorization,
  type CategoryIconReadContext,
} from './category-icon-public-contract';
import {
  decodeCategoryIconDescriptor,
  type CategoryIconDescriptor,
} from './category-icon-media-contract';
export interface CategoryIconReadView {
  readonly key: string;
  readonly localSrc: string;
  readonly state: 'idle' | 'loading' | 'image' | 'unavailable';
}
/** A single focused image lease. All icons stay metadata until selected; changing
 * selection revokes presentation and releases its lease before allocating again. */
export class CategoryIconReader {
  private generation = 0;
  private cancellation = new Cancellation();
  private file: LocalMediaFile | null = null;
  private disposed = false;
  private release = Promise.resolve();
  private timer: (() => void) | null = null;
  private readonly unsubscribe: () => void;
  constructor(
    private readonly sessions: SessionStore,
    private readonly transfer: CategoryIconReadTransfer | undefined,
    private readonly clock: Clock,
    private readonly render: (view: CategoryIconReadView) => void,
  ) {
    let ticket = sessions.snapshot();
    this.unsubscribe = sessions.subscribe(() => {
      const next = sessions.snapshot();
      if (
        next.epoch !== ticket.epoch ||
        next.credentials?.accountId !== ticket.credentials?.accountId
      ) {
        ticket = next;
        this.clear();
      }
    });
  }
  async open(
    key: string,
    raw: CategoryIconDescriptor,
    scope: CategoryIconReadContext,
  ): Promise<void> {
    this.clear();
    const generation = this.generation,
      ticket = this.sessions.snapshot(),
      cancellation = this.cancellation,
      owner = {};
    const auth = categoryIconReadAuthorization(scope),
      descriptor = decodeCategoryIconDescriptor(raw);
    const current = () => {
      this.sessions.assertCurrent(ticket);
      if (
        this.disposed ||
        generation !== this.generation ||
        cancellation.isCancelled ||
        Date.parse(auth.expiresAt) <= this.clock.now() ||
        !ticket.credentials ||
        (auth.actorId !== null && auth.actorId !== ticket.credentials.accountId)
      )
        throw new ClientError('cancelled', 'Category icon view changed');
      return this.sessions.snapshot();
    };
    let file: LocalMediaFile | null = null;
    try {
      current();
      if (!this.transfer)
        throw new ClientError(
          'configuration',
          'Authenticated category icon reader unavailable',
        );
      if (
        descriptor.contextId !== auth.id ||
        descriptor.contextToken !== auth.token
      )
        throw new ClientError('protocol', 'Exact icon context required');
      this.render({ key, localSrc: '', state: 'loading' });
      await this.release;
      current();
      const session: MediaSession = { current };
      file = await this.transfer.download(
        descriptor,
        scope,
        'display-v1',
        owner,
        session,
        cancellation,
      );
      current();
      const localSrc = await this.transfer.resolve(file, owner, ticket);
      current();
      this.file = file;
      file = null;
      this.timer = this.clock.schedule(
        () => this.clear(),
        Math.max(0, Date.parse(auth.expiresAt) - this.clock.now()),
      );
      this.render({ key, localSrc, state: 'image' });
    } catch (error) {
      if (file && this.transfer) await this.transfer.release(file);
      if (generation === this.generation && !this.disposed)
        this.render({ key, localSrc: '', state: 'unavailable' });
      throw error;
    }
  }
  clear(): void {
    this.generation++;
    this.cancellation.cancel();
    this.cancellation = new Cancellation();
    this.timer?.();
    this.timer = null;
    const file = this.file;
    this.file = null;
    if (file && this.transfer)
      this.release = this.release.then(() => this.transfer!.release(file));
    if (!this.disposed) this.render({ key: '', localSrc: '', state: 'idle' });
  }
  dispose(): void {
    this.clear();
    this.disposed = true;
    this.unsubscribe();
  }
}
