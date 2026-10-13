import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import { boundedOwnerProof } from '../../database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
  registerTransactionDeadline,
} from '../../database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../../database/transaction-deadlines.js';
const code = 'SAFETY_MODERATION_UNAVAILABLE' as const;
interface Fact {
  actor: string;
  grantId: string;
  initial: string;
}
export async function observeAccountModerationAuthority(
  actor: string,
  tx: PoolClient,
): Promise<string> {
  return (
    await tx.query<{ fingerprint: string }>(
      `SELECT whaleu_profile.moderation_hash(jsonb_build_array(
    (SELECT jsonb_agg(jsonb_build_array(to_jsonb(g),g.xmin::text,g.ctid::text) ORDER BY id) FROM whaleu_authorization.role_grants g WHERE g.account_id=$1 AND g.revoked_at IS NULL),
    whaleu_safety.account_punishment_authority_epoch(),
    (SELECT jsonb_build_array(to_jsonb(h),h.xmin::text,h.ctid::text) FROM whaleu_safety.account_heads h WHERE h.account_id=$1),
    whaleu_safety.account_punishment_fingerprint($1))) fingerprint`,
      [actor],
    )
  ).rows[0]!.fingerprint;
}
const proof: RequiredTransactionProof<Fact> = {
  maximumFacts: 1,
  failureCode: code,
  validate: (facts, tx) =>
    boundedOwnerProof(tx, code, async (read) => {
      await read.query(`LOCK TABLE whaleu_authorization.role_grants,whaleu_authorization.account_punishment_authority_epoch,
    whaleu_safety.account_heads,whaleu_safety.account_punishments,whaleu_safety.account_punishment_heads,
    whaleu_safety.account_punishment_terminals IN SHARE MODE NOWAIT`);
      for (const fact of facts) {
        if (
          (await observeAccountModerationAuthority(fact.actor, read)) !==
          fact.initial
        )
          throw new ApplicationError(code);
        const row = (
          await read.query<{ allowed: boolean }>(
            'SELECT whaleu_safety.account_punishment_admin_current($1,$2) allowed',
            [fact.actor, fact.grantId],
          )
        ).rows[0];
        if (!row?.allowed) throw new ApplicationError(code);
      }
    }),
};
export function retainAccountModerationAuthority(
  actor: string,
  grantId: string,
  initial: string,
  validUntil: number | null,
  tx: PoolClient,
) {
  registerTransactionDeadline(tx, validUntil, code);
  enableRequiredTransactionProof(tx, proof);
  registerRequiredTransactionFact(
    tx,
    proof,
    actor,
    Object.freeze({ actor, grantId, initial }),
  );
}
