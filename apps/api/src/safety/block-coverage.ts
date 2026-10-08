/** The narrow coverage required by named-content visibility. Restriction/action
 * eligibility is deliberately not part of an ordinary content read. */
export interface BlockCoverageHead {
  block_coverage: string;
  provenance: string;
  valid_until: Date | null;
}

/** Shared scalar/batch canonical validator. Its caller owns locking and any
 * required or optional deadline registration; this function only evaluates facts. */
export function validateBlockCoverage(
  head: BlockCoverageHead | null | undefined,
  now: number,
): { validUntil: number | null } | null {
  if (
    !head ||
    !Number.isFinite(now) ||
    head.block_coverage !== 'complete' ||
    head.provenance !== 'native_account_creation' ||
    (head.valid_until !== null && !(head.valid_until instanceof Date))
  )
    return null;
  const validUntil = head.valid_until?.getTime() ?? null;
  if (
    validUntil !== null &&
    (!Number.isFinite(validUntil) || validUntil <= now)
  )
    return null;
  return { validUntil };
}
