/** Test-only scalar Safety heads. Canonical context, relationship checks,
 * clocks, metadata locks and mandatory final proof remain enabled in both arms. */
import type { SafetyRepository } from '../../src/safety/repository.js';

export async function withScalarSearchSafetyHeads<T>(
  records: SafetyRepository,
  operation: () => Promise<T>,
): Promise<T> {
  const original = records.directions;
  records.directions = function (viewer, author, purpose, tx) {
    return original.call(this, viewer, author, purpose, tx);
  };
  try {
    return await operation();
  } finally {
    records.directions = original;
  }
}
