import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import { boundedOwnerProof } from '../../database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
  registerTransactionExactDeadline,
} from '../../database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../../database/transaction-deadlines.js';
interface IdentityFact {
  actor: string;
  sessionId: string;
  tokenHash: string;
  fingerprint: string;
}
const code = 'SAFETY_MODERATION_UNAVAILABLE' as const;
async function identityState(
  input: Omit<IdentityFact, 'fingerprint'>,
  tx: PoolClient,
): Promise<string> {
  const row = (
    await tx.query<{ fingerprint: string; current: boolean }>(
      'SELECT whaleu_profile.moderation_hash(whaleu_profile.moderation_identity_facts($1,$2,$3)) fingerprint,whaleu_safety.account_punishment_identity_current($1,$2,$3) current',
      [input.actor, input.sessionId, input.tokenHash],
    )
  ).rows[0];
  if (!row || row.current !== true) throw new ApplicationError(code);
  return row.fingerprint;
}
const identityProof: RequiredTransactionProof<IdentityFact> = {
  maximumFacts: 1,
  failureCode: code,
  validate: (facts, tx) =>
    boundedOwnerProof(tx, code, async (read) => {
      await read.query(
        'LOCK TABLE whaleu_identity.accounts,whaleu_identity.sessions,whaleu_identity.access_tokens IN SHARE MODE NOWAIT',
      );
      for (const fact of facts)
        if ((await identityState(fact, read)) !== fact.fingerprint)
          throw new ApplicationError(code);
    }),
};
/** Capture immediately after the presented token was authenticated, before any
 * request/content/subject wait. Later enrollment must never replace this fact. */
export async function retainAccountModerationIdentity(
  input: Omit<IdentityFact, 'fingerprint'>,
  tx: PoolClient,
): Promise<void> {
  const row = (
    await tx.query<{
      token_until: string;
      session_until: string;
      access_until: string;
    }>(
      `SELECT t.expires_at::text token_until,s.absolute_expires_at::text session_until,s.access_expires_at::text access_until FROM whaleu_identity.access_tokens t JOIN whaleu_identity.sessions s ON s.id=t.session_id WHERE t.token_hash=$1 AND s.id=$2 AND s.account_id=$3`,
      [input.tokenHash, input.sessionId, input.actor],
    )
  ).rows[0];
  if (!row) throw new ApplicationError('AUTHENTICATION_REQUIRED');
  registerTransactionExactDeadline(tx, row.token_until, 'ACCESS_TOKEN_EXPIRED');
  registerTransactionExactDeadline(
    tx,
    row.session_until,
    'ACCESS_TOKEN_EXPIRED',
  );
  registerTransactionExactDeadline(
    tx,
    row.access_until,
    'ACCESS_TOKEN_EXPIRED',
  );
  enableRequiredTransactionProof(tx, identityProof);
  registerRequiredTransactionFact(
    tx,
    identityProof,
    'identity',
    Object.freeze({ ...input, fingerprint: await identityState(input, tx) }),
  );
}
