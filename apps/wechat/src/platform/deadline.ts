import { ClientError } from '../api/errors';
import type { Clock } from './contracts';

/** An independent deadline also bounds adapters that accidentally never settle. */
export function bounded<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
  clock: Clock,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000) {
    return Promise.reject(
      new ClientError(
        'configuration',
        'Timeout must be between 1 and 120000 ms',
      ),
    );
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const clear = clock.schedule(() => {
      if (settled) return;
      settled = true;
      reject(new ClientError('timeout', 'The operation timed out'));
    }, timeoutMs);
    Promise.resolve()
      .then(operation)
      .then(
        (value) => {
          if (settled) return;
          settled = true;
          clear();
          resolve(value);
        },
        (error) => {
          if (settled) return;
          settled = true;
          clear();
          reject(error);
        },
      );
  });
}
