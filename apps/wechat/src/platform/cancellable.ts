import { ClientError } from '../api/errors';
import type { Cancellation } from './contracts';

/** Cancels only this wait, never a shared refresh used by other in-flight requests. */
export function cancellable<T>(
  operation: Promise<T>,
  cancellation?: Cancellation,
): Promise<T> {
  if (!cancellation) return operation;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let unsubscribe = () => undefined as void;
    const finish = (apply: () => void) => {
      if (settled) return;
      settled = true;
      unsubscribe();
      apply();
    };
    unsubscribe = cancellation.subscribe(() =>
      finish(() =>
        reject(new ClientError('cancelled', 'The request was cancelled')),
      ),
    );
    if (settled) unsubscribe();
    // Always observe operation, including when cancellation happened before subscription.
    operation.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}
