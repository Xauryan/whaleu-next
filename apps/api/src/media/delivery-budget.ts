import { ApplicationError } from '../http/application-error.js';

/** One trusted DI instance per application process, shared by every owner.
 * A lease is released only when the actual source/output lifecycle is quiet;
 * timeout or cancellation alone is not proof that an unresolved open ended. */
export class MediaDeliveryBudgetPool {
  private readonly active = new Map<string, number>();
  private total = 0;
  acquire(key: string): () => void {
    const count = this.active.get(key) ?? 0;
    if (!key || key.length > 512 || count >= 2 || this.total >= 64)
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    this.active.set(key, count + 1);
    this.total++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.total--;
      const current = this.active.get(key)! - 1;
      if (current === 0) this.active.delete(key);
      else this.active.set(key, current);
    };
  }
}
