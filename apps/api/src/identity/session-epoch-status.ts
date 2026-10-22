import type { PoolClient } from 'pg';
import { retainSessionEpochSchema } from './session-epoch.js';
/** Read-only operator evidence. It never claims that old reader processes are
 * gone and cannot authorize a future epoch advance through a flag or argument. */
export async function sessionEpochStatus(tx: PoolClient) {
  await tx.query('SET TRANSACTION READ ONLY');
  await retainSessionEpochSchema(tx);
  return Object.freeze({
    protocol: 'identity-session-revocation-epoch-v1',
    schema: 'qualified',
    advanceAuthority: 'unavailable',
    realDeletionAdmission: 'unavailable',
    legacyReaderCutover: 'unproven',
  });
}
export function parseSessionEpochStatusCommand(args: readonly string[]): void {
  if (args.length !== 1 || args[0] !== 'status')
    throw new Error('Only the read-only status command is supported');
}
