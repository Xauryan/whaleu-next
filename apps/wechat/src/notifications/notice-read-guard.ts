import { ClientError } from '../api/errors';
import { Cancellation } from '../platform/contracts';

export type NoticeReadGuard = () => boolean;

/** A guard is an extra dispatch fence, never a claim that a sent PUT was undone. */
class GuardedNoticeCancellation extends Cancellation {
  private stale = false;
  constructor(
    private readonly parent: Cancellation,
    private readonly guard: NoticeReadGuard,
  ) {
    super();
  }
  override get isCancelled(): boolean {
    // Once invalid, returning to the viewport cannot revive this exact attempt.
    this.stale ||= !this.guard();
    return this.stale || super.isCancelled || this.parent.isCancelled;
  }
  override subscribe(listener: () => void): () => void {
    if (this.isCancelled) {
      listener();
      return () => undefined;
    }
    const stopOwn = super.subscribe(listener);
    const stopParent = this.parent.subscribe(listener);
    return () => {
      stopOwn();
      stopParent();
    };
  }
}

/** Manual callers receive their original cancellation unchanged. API transport/replay
 * already rechecks isCancelled immediately before sending, including its microtask. */
export function guardNoticeRead(
  cancel: Cancellation,
  guard?: NoticeReadGuard,
): Cancellation {
  if (!guard) return cancel;
  const guarded = new GuardedNoticeCancellation(cancel, guard);
  if (guarded.isCancelled)
    throw new ClientError(
      'cancelled',
      'Notice exposure changed before dispatch',
    );
  return guarded;
}
