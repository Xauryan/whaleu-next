import type { PrivateViewLifecycle } from '../identity-privacy/overlay';

/** Runtime-local invalidation only; durable mutations and pending receipts keep their owners. */
export class SafetyChanges {
  private readonly listeners = new Set<(accountId: string) => void>();

  constructor(private readonly privateViews?: PrivateViewLifecycle) {}

  subscribe(listener: (accountId: string) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Clear sensitive snapshots before any owner starts its fresh read. */
  invalidate(accountId: string): void {
    this.privateViews?.clear(accountId);
    for (const listener of [...this.listeners]) {
      try {
        listener(accountId);
      } catch {
        /* One native render failure must not retain another owner's stale data. */
      }
    }
  }
}
