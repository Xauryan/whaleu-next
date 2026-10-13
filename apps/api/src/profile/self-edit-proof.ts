import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import { boundedOwnerProof } from '../database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
  registerTransactionExactDeadline,
} from '../database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../database/transaction-deadlines.js';
import type { ProfileSelfEditIdentity } from './profile.repository.js';

interface Fact {
  readonly id: string;
  readonly actor: string;
  readonly identityHash: string;
}
const code = 'SAFETY_MODERATION_UNAVAILABLE' as const;
const proof: RequiredTransactionProof<Fact> = {
  maximumFacts: 128,
  failureCode: code,
  validate: (facts, tx) =>
    boundedOwnerProof(tx, code, async (read) => {
      for (const fact of facts) {
        const result = await read.query(
          `SELECT whaleu_profile.self_edit_assert(q) FROM whaleu_profile.self_edit_causes q WHERE id=$1 AND actor_id=$2 AND identity_hash=$3 AND mutation_transaction=pg_current_xact_id()`,
          [fact.id, fact.actor, fact.identityHash],
        );
        if (result.rowCount !== 1) throw new ApplicationError(code);
      }
    }),
};
/** Freeze original caller before any avatar/Profile wait. Final SQL checks and
 * exact clock deadlines cannot be replaced by a later fresh session snapshot. */
export async function captureProfileSelfEditIdentity(
  id: string,
  actor: string,
  identity: ProfileSelfEditIdentity,
  tx: PoolClient,
): Promise<string> {
  enableRequiredTransactionProof(tx, proof);
  const row = (
    await tx.query<{ fingerprint: string; until: string }>(
      `SELECT
    whaleu_profile.moderation_hash(whaleu_profile.moderation_identity_facts($1,$2,$3)) fingerprint,
    least(s.access_expires_at,s.absolute_expires_at,t.expires_at)::text until
    FROM whaleu_identity.accounts a JOIN whaleu_identity.sessions s ON s.account_id=a.id JOIN whaleu_identity.access_tokens t ON t.session_id=s.id
    WHERE a.id=$1 AND s.id=$2 AND t.token_hash=$3 AND whaleu_profile.self_edit_identity_current($1,$2,$3)`,
      [actor, identity.sessionId, identity.tokenHash],
    )
  ).rows[0];
  if (!row) throw new ApplicationError('AUTHENTICATION_REQUIRED');
  registerTransactionExactDeadline(tx, row.until, code);
  registerRequiredTransactionFact(
    tx,
    proof,
    id,
    Object.freeze({ id, actor, identityHash: row.fingerprint }),
  );
  return row.fingerprint;
}
