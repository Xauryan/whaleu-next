import { createHash } from 'node:crypto';
/** Opaque, purpose-bound identity binding, never an authorization grant.
 * Every consuming endpoint must independently authenticate and recheck access. */
export function ownerCursorScope(purpose: string, accountId: string): string {
  return `${purpose}:${createHash('sha256')
    .update(
      JSON.stringify(['owner-cursor-v1', purpose, accountId.toLowerCase()]),
    )
    .digest('hex')}`;
}
