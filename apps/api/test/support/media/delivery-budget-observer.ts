import type { MediaDeliveryBudgetPool } from '../../../src/media/delivery-budget.js';

/** Test-only observation of the real App pool. Do not manufacture a release:
 * ExactMediaDelivery invokes it only after provider work and both source/output
 * streams are physically quiet. HTTP completion or abort is not that proof. */
export function observeMediaDeliveryBudget(pool: MediaDeliveryBudgetPool) {
  const acquire = pool.acquire;
  const active = new Map<symbol, { key: string; quiet: Promise<void> }>();
  pool.acquire = (key) => {
    const release = acquire.call(pool, key);
    const id = Symbol(key);
    let notifyQuiet!: () => void;
    const quiet = new Promise<void>((resolve) => {
      notifyQuiet = resolve;
    });
    active.set(id, { key, quiet });
    return () => {
      release();
      if (active.delete(id)) notifyQuiet();
    };
  };
  const activeKeys = () => [...active.values()].map(({ key }) => key);
  return {
    activeKeys,
    /** Call after all expected requests have settled. The deadline can only fail
     * the test; it never releases a lease or substitutes for a close event. */
    waitForQuiet(timeoutMs = 5000): Promise<void> {
      if (!active.size) return Promise.resolve();
      const pending = [...active.values()].map(({ quiet }) => quiet);
      return new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () =>
            reject(
              new Error(
                `Media delivery did not become physically quiet: ${JSON.stringify(activeKeys())}`,
              ),
            ),
          timeoutMs,
        );
        void Promise.all(pending).then(() => {
          clearTimeout(timeout);
          if (active.size)
            reject(
              new Error('New Media delivery started during quiet barrier'),
            );
          else resolve();
        });
      });
    },
    restore() {
      pool.acquire = acquire;
    },
  };
}
