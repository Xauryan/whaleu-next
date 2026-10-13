import type { PoolClient } from 'pg';
import { AccountPunishmentOwner } from '../../safety/account-moderation/owner.js';
import { ApplicationError } from '../../http/application-error.js';
import { boundedOwnerProof } from '../../database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
  registerTransactionExactDeadline,
} from '../../database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../../database/transaction-deadlines.js';
export const removalPunishmentOwner = new AccountPunishmentOwner();
const code = 'SAFETY_MODERATION_UNAVAILABLE' as const;
const optionsSql = `SELECT jsonb_object_agg(k.kind,jsonb_build_object('revision',coalesce(h.revision,0)::text,'current',
 CASE WHEN p.id IS NOT NULL AND (p.ends_at IS NULL OR p.ends_at>clock_timestamp())
 AND NOT EXISTS(SELECT 1 FROM whaleu_safety.account_punishment_terminals t WHERE t.punishment_id=p.id)
 THEN jsonb_build_object('punishmentId',p.id,'endsAt',CASE WHEN p.ends_at IS NULL THEN NULL ELSE to_char(p.ends_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END) ELSE NULL END)) options
 FROM (VALUES('interaction_mute'),('access_suspension')) k(kind)
 LEFT JOIN whaleu_safety.account_punishment_heads h ON h.subject_id=$1 AND h.kind=k.kind
 LEFT JOIN whaleu_safety.account_punishments p ON p.id=h.punishment_id`;
interface Option {
  revision: string;
  current: null | { punishmentId: string; endsAt: string | null };
}
interface Options {
  interaction_mute: Option;
  access_suspension: Option;
}
const proof: RequiredTransactionProof<{
  subject: string;
  fingerprint: string;
}> = {
  maximumFacts: 1,
  failureCode: code,
  validate: (facts, tx) =>
    boundedOwnerProof(tx, code, async (read) => {
      await read.query(
        'LOCK TABLE whaleu_safety.account_punishments,whaleu_safety.account_punishment_heads,whaleu_safety.account_punishment_terminals IN SHARE MODE NOWAIT',
      );
      for (const fact of facts) {
        const row = (
          await read.query<{ options: Options }>(optionsSql, [fact.subject])
        ).rows[0];
        if (!row || JSON.stringify(row.options) !== fact.fingerprint)
          throw new ApplicationError(code);
      }
    }),
};
/** Exact content-derived subject stays server-private; each kind keeps its lineage revision after release. */
export async function removalPunishmentOptions(
  subject: string,
  tx: PoolClient,
): Promise<Options> {
  const row = (await tx.query<{ options: Options }>(optionsSql, [subject]))
    .rows[0];
  if (!row) throw new ApplicationError(code);
  enableRequiredTransactionProof(tx, proof);
  registerRequiredTransactionFact(
    tx,
    proof,
    subject,
    Object.freeze({ subject, fingerprint: JSON.stringify(row.options) }),
  );
  for (const option of Object.values(row.options))
    if (option.current?.endsAt)
      registerTransactionExactDeadline(tx, option.current.endsAt, code);
  return row.options;
}
