export interface RatingTargetChange {
  readonly targetId: string;
  readonly revision: string;
}
/** Invalidation signals carry no target text, identity or scope snapshots. */
export class RatingTargetChanges {
  private readonly listeners = new Set<(change: RatingTargetChange) => void>();
  subscribe(listener: (change: RatingTargetChange) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  publish(change: RatingTargetChange): void {
    const safe = Object.freeze({
      targetId: change.targetId,
      revision: change.revision,
    });
    for (const listener of [...this.listeners]) {
      try {
        listener(safe);
      } catch {
        // A rendering failure cannot undo durable settlement or retain other snapshots.
      }
    }
  }
}
