import { ClientError } from '../api/errors';
import type { SessionStore, SessionTicket } from '../auth/session';
import type { LocalMediaFile, MediaSession } from '../media/contracts';
import { MediaLocalFiles } from '../media/local-files';
import { Cancellation } from '../platform/contracts';
import type { CategoryIconMediaStatus } from './category-icon-media-contract';
type CategoryIconReady = Extract<
  CategoryIconMediaStatus,
  { status: 'ready_unbound' }
>;

export interface CategoryIconInspected {
  readonly mime: 'image/jpeg' | 'image/png';
  readonly bytes: number;
  readonly sha256: string;
}
/** Implementations must use the same shared registry for picker reservations,
 * file leases and native IO. `complete` is the native completion observation,
 * not the upload response, a local abort or server cancellation. */
export interface CategoryIconWindowTransfer {
  readonly localFiles: MediaLocalFiles;
  pick(
    session: MediaSession,
    cancellation: Cancellation,
  ): Promise<LocalMediaFile>;
  inspect(
    file: LocalMediaFile,
    session: MediaSession,
    cancellation: Cancellation,
  ): Promise<CategoryIconInspected>;
  remove(file: LocalMediaFile): Promise<void>;
}
export interface CategoryIconUploadEffect {
  readonly result: Promise<CategoryIconReady>;
  readonly complete: Promise<void>;
}
export interface CategoryIconWindowOwner {
  /** Must durably record the member request and both stable recovery keys before
   * obtaining a grant or starting the native upload. */
  start(
    file: LocalMediaFile,
    declaration: CategoryIconInspected,
    session: MediaSession,
    cancellation: Cancellation,
    progress: (percent: number) => void,
  ): Promise<CategoryIconUploadEffect>;
  /** Current server status and exact batch match are required before this call
   * can persist `ready`; late/stale UI work does not get to call it. */
  ready(member: CategoryIconReady): void;
}
export interface CategoryIconWindowView {
  readonly active: boolean;
  readonly progress: number;
  readonly completedMembers: number;
  readonly status:
    'idle' | 'selecting' | 'uploading' | 'settling' | 'unavailable';
}
/** Thirty-two node icons are metadata members, never resident files.
 * Picking and uploading one at a time works within the global 2 IO / 4 lease /
 * 10 MiB registry even at the 5 MiB per-image limit. Other owners keep their
 * credits; this coordinator never resets or replaces the shared registry. */
export class CategoryIconUploadWindow {
  private generation = 0;
  private busy = false;
  private disposed = false;
  private cancellation = new Cancellation();
  private ticket: SessionTicket;
  private readonly unsubscribe: () => void;
  constructor(
    private readonly sessions: SessionStore,
    private readonly files: MediaLocalFiles,
    private readonly transfer: CategoryIconWindowTransfer,
    private readonly owner: CategoryIconWindowOwner,
    private readonly render: (view: CategoryIconWindowView) => void,
  ) {
    if (transfer.localFiles !== files)
      throw new ClientError(
        'configuration',
        'Shared native media registry required',
      );
    this.ticket = sessions.snapshot();
    this.unsubscribe = sessions.subscribe(() => {
      const current = sessions.snapshot();
      if (
        current.epoch !== this.ticket.epoch ||
        current.credentials?.accountId !== this.ticket.credentials?.accountId
      ) {
        this.hide();
        this.ticket = current;
      }
    });
  }
  private current(
    generation: number,
    ticket: SessionTicket,
    cancellation: Cancellation,
  ): void {
    this.sessions.assertCurrent(ticket);
    if (
      this.disposed ||
      generation !== this.generation ||
      cancellation.isCancelled
    )
      throw new ClientError('cancelled', 'Category icon selection changed');
  }
  async append(selectedCount: number): Promise<void> {
    if (this.busy || this.disposed)
      throw new ClientError('configuration', 'Image operation still settling');
    const maximum = 32;
    if (
      !Number.isSafeInteger(selectedCount) ||
      selectedCount < 0 ||
      selectedCount >= maximum
    )
      throw new ClientError('business', 'Category icon limit reached');
    const ticket = this.sessions.snapshot();
    if (!ticket.credentials)
      throw new ClientError(
        'auth-required',
        'Original Ratings account required',
      );
    if (!this.files.capacityAvailable)
      throw new ClientError(
        'storage',
        'Shared temporary image capacity unavailable',
      );
    this.files.assertTransferCapacity();
    this.busy = true;
    const generation = ++this.generation,
      cancellation = (this.cancellation = new Cancellation());
    const session: MediaSession = {
      current: () => {
        this.current(generation, ticket, cancellation);
        const current = this.sessions.snapshot();
        if (!current.credentials)
          throw new ClientError(
            'auth-required',
            'Original Ratings account required',
          );
        return current;
      },
    };
    let file: LocalMediaFile | null = null;
    let effect: CategoryIconUploadEffect | null = null;
    let completeObserved = false;
    let succeeded = false;
    try {
      this.render({
        active: true,
        progress: 0,
        completedMembers: selectedCount,
        status: 'selecting',
      });
      file = await this.transfer.pick(session, cancellation);
      this.current(generation, ticket, cancellation);
      const declaration = await this.transfer.inspect(
        file,
        session,
        cancellation,
      );
      this.current(generation, ticket, cancellation);
      this.render({
        active: true,
        progress: 0,
        completedMembers: selectedCount,
        status: 'uploading',
      });
      effect = await this.owner.start(
        file,
        declaration,
        session,
        cancellation,
        (percent) => {
          try {
            this.current(generation, ticket, cancellation);
            if (Number.isFinite(percent) && percent >= 0 && percent <= 100)
              this.render({
                active: true,
                progress: Math.floor(percent),
                completedMembers: selectedCount,
                status: 'uploading',
              });
          } catch {
            /* A late progress event has no presentation authority. */
          }
        },
      );
      // Observe rejection immediately while retaining native completion as a
      // separate condition. Promise.all settles too early on response failure.
      const result = await Promise.allSettled([effect.result, effect.complete]);
      completeObserved = result[1].status === 'fulfilled';
      this.current(generation, ticket, cancellation);
      if (!completeObserved)
        throw new ClientError('network', 'Original upload requires recovery');
      if (result[0].status !== 'fulfilled') {
        const reason = result[0].reason;
        // A confirmed native completion permits original-request retry. Keep
        // typed failure metadata (including 429), never raw provider messages.
        throw reason instanceof ClientError
          ? new ClientError(
              reason.kind,
              'Original upload requires recovery',
              reason.details,
            )
          : new ClientError('network', 'Original upload requires recovery');
      }
      const member = result[0].value;
      if (member.status !== 'ready_unbound')
        throw new ClientError('protocol', 'Exact ready member required');
      this.owner.ready(member);
      succeeded = true;
      this.render({
        active: true,
        progress: 100,
        completedMembers: selectedCount + 1,
        status: 'settling',
      });
    } catch (error) {
      if (generation === this.generation && !this.disposed)
        this.render({
          active: true,
          progress: 0,
          completedMembers: selectedCount,
          status: 'unavailable',
        });
      throw error;
    } finally {
      // Never free bytes held by a native upload whose complete is unknown.
      // The transfer owns that retained lease and cleanup debt after hide.
      if (file && (!effect || completeObserved))
        await this.transfer.remove(file);
      // Unknown native completion keeps this window blocked; a new selection
      // cannot consume another lease while recovery owns the old one.
      this.busy = effect !== null && !completeObserved;
      if (succeeded && !this.disposed && generation === this.generation)
        this.render({
          active: false,
          progress: 0,
          completedMembers: selectedCount + 1,
          status: 'idle',
        });
    }
  }
  hide(): void {
    ++this.generation;
    this.cancellation.cancel();
    // No pending-key removal and no synthetic native complete observation.
  }
  dispose(): void {
    this.hide();
    this.disposed = true;
    this.unsubscribe();
  }
}
/** Gallery authorization still covers the entire attachment set. This merely
 * chooses at most two display allocations after that proof, not two images to
 * authorize. Shared download transfer admission can reduce this further. */
export function categoryIconViewport(
  length: number,
  activeIndex: number,
): readonly number[] {
  if (
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > 32 ||
    !Number.isSafeInteger(activeIndex) ||
    activeIndex < 0 ||
    (length > 0 && activeIndex >= length)
  )
    throw new ClientError('protocol', 'Invalid Category icon viewport');
  if (length === 0) return Object.freeze([]);
  return Object.freeze(
    activeIndex + 1 < length ? [activeIndex, activeIndex + 1] : [activeIndex],
  );
}
