import { retainSessionEpochSchema } from './session-epoch.js';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import { boundedOwnerProof } from '../database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
  registerTransactionExactDeadline,
  type RequiredTransactionProof,
} from '../database/transaction-deadlines.js';
interface Fact {
  account: string;
  session: string;
}
const proof: RequiredTransactionProof<Fact> = {
  maximumFacts: 16,
  failureCode: 'PROMOTION_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'PROMOTION_UNAVAILABLE', async (read) => {
      await read.query(
        'LOCK TABLE whaleu_identity.accounts,whaleu_identity.sessions IN SHARE MODE NOWAIT',
      );
      for (const f of facts)
        if (
          !(
            await read.query(
              `SELECT 1 FROM whaleu_identity.sessions s JOIN whaleu_identity.accounts a ON a.id=s.account_id WHERE s.id=$1 AND s.account_id=$2 AND a.status='active' AND s.issued_revocation_epoch=a.session_revocation_epoch AND a.lifecycle='active' AND s.revoked_at IS NULL AND least(s.access_expires_at,s.absolute_expires_at)>clock_timestamp()`,
              [f.session, f.account],
            )
          ).rows[0]
        )
          throw new ApplicationError('PROMOTION_SOURCE_CHANGED');
    }),
};
/** Exact originating interactive session, not a retained bearer token and never
 * usable for scheduled service authority. Rotation can keep the same live session;
 * logout/revocation or expiry vetoes pending manual promotion effects. */
export async function requireRatingPromotionSession(
  account: string,
  session: string | null,
  tx: PoolClient,
) {
  await retainSessionEpochSchema(tx);
  if (!session) throw new ApplicationError('PROMOTION_SOURCE_CHANGED');
  const row = (
    await tx.query<{ until: string }>(
      `SELECT least(s.access_expires_at,s.absolute_expires_at)::text until FROM whaleu_identity.sessions s JOIN whaleu_identity.accounts a ON a.id=s.account_id WHERE s.id=$1 AND s.account_id=$2 AND a.status='active' AND s.issued_revocation_epoch=a.session_revocation_epoch AND a.lifecycle='active' AND s.revoked_at IS NULL AND least(s.access_expires_at,s.absolute_expires_at)>clock_timestamp() FOR SHARE OF s,a`,
      [session, account],
    )
  ).rows[0];
  if (!row) throw new ApplicationError('PROMOTION_SOURCE_CHANGED');
  enableRequiredTransactionProof(tx, proof);
  registerRequiredTransactionFact(
    tx,
    proof,
    session,
    Object.freeze({ account, session }),
  );
  registerTransactionExactDeadline(tx, row.until, 'PROMOTION_SOURCE_CHANGED');
}
