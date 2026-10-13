import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import { enforceAccountPunishment } from '../account-moderation/policy.js';
/** Safe own envelopes do not grant target access. The overlay owner retains the
 * positive or negative observation through final proof, including timed expiry. */
export async function noticeContentAllowed(
  actor: string,
  tx: PoolClient,
): Promise<boolean> {
  try {
    await enforceAccountPunishment(actor, 'browse', tx);
    return true;
  } catch (error) {
    if (
      error instanceof ApplicationError &&
      error.code === 'SAFETY_ACCESS_SUSPENDED'
    )
      return false;
    throw error;
  }
}
