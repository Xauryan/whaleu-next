import { DeletionError, INVENTORY_VERSION, ownerKeys } from './contracts.js';
import type { OwnerEvidence } from './contracts.js';
export function validateCompletionEvidence(
  requestId: string,
  generation: string,
  evidence: readonly OwnerEvidence[],
): void {
  if (evidence.length !== ownerKeys.length)
    throw new DeletionError('OWNER_COVERAGE_INCOMPLETE');
  const seen = new Set<string>();
  for (const e of evidence) {
    if (
      !ownerKeys.includes(e.owner) ||
      seen.has(e.owner) ||
      e.requestId !== requestId ||
      e.generation !== generation ||
      e.inventory !== INVENTORY_VERSION ||
      !/^[a-f0-9]{64}$/.test(e.proof)
    )
      throw new DeletionError('OWNER_EVIDENCE_INVALID');
    seen.add(e.owner);
  }
}
