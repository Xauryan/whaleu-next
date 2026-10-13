import type { PoolClient } from 'pg';
import { z } from 'zod';
import { ApplicationError } from '../http/application-error.js';
import { boundedOwnerProof } from '../database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
  registerTransactionExactDeadline,
} from '../database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../database/transaction-deadlines.js';
const code = 'AUTHORIZATION_UNAVAILABLE' as const;
interface Fact {
  subject: string;
  fingerprint: string;
}
interface Observation extends Fact {
  protected: boolean;
  until: string | null;
}
/** The Authorization owner retains the original negative statement, including
 * its monotone source epoch. A later create/revoke ABA or zero-row grant writer
 * cannot turn a fresh reread into replacement evidence. Developer protection
 * is Next's conservative extension to source-backed school/super-admin safety. */
async function observe(
  subjects: readonly string[],
  tx: PoolClient,
): Promise<Observation[]> {
  const rows = (
    await tx.query<Observation>(
      `WITH instant AS MATERIALIZED(SELECT clock_timestamp() at)
 SELECT subject::text subject,whaleu_safety.account_punishment_protection_hash(subject) fingerprint,
 EXISTS(SELECT 1 FROM whaleu_authorization.role_grants g WHERE g.account_id=subject AND g.revoked_at IS NULL
   AND g.role IN('school_admin','super_admin','developer') AND g.valid_from<=instant.at AND (g.expires_at IS NULL OR g.expires_at>instant.at)) protected,
 (SELECT min(g.valid_from)::text FROM whaleu_authorization.role_grants g WHERE g.account_id=subject AND g.revoked_at IS NULL
   AND g.role IN('school_admin','super_admin','developer') AND g.valid_from>instant.at) until
 FROM unnest($1::uuid[]) subject CROSS JOIN instant ORDER BY subject`,
      [subjects],
    )
  ).rows;
  if (
    rows.length !== subjects.length ||
    rows.some((r) => !subjects.includes(r.subject) || !r.fingerprint)
  )
    throw new ApplicationError(code);
  return rows;
}
const proof: RequiredTransactionProof<Fact> = {
  maximumFacts: 16,
  failureCode: code,
  validate: (facts, tx) =>
    boundedOwnerProof(tx, code, async (read) => {
      await read.query(
        'LOCK TABLE whaleu_authorization.role_grants,whaleu_authorization.account_punishment_authority_epoch IN SHARE MODE NOWAIT',
      );
      const rows = await observe(
        facts.map((f) => f.subject),
        read,
      );
      for (const fact of facts) {
        const current = rows.find((r) => r.subject === fact.subject);
        if (
          !current ||
          current.protected ||
          current.fingerprint !== fact.fingerprint
        )
          throw new ApplicationError(code);
        registerTransactionExactDeadline(tx, current.until, code);
      }
    }),
};
export async function requireUnprotectedAccountPunishmentTarget(
  subjectId: string,
  tx: PoolClient,
): Promise<void> {
  z.uuid()
    .refine((id) => id === id.toLowerCase())
    .parse(subjectId);
  enableRequiredTransactionProof(tx, proof);
  const isolation = (
    await tx.query<{ isolation: string }>(
      "SELECT current_setting('transaction_isolation') isolation",
    )
  ).rows[0];
  if (isolation?.isolation !== 'read committed')
    throw new ApplicationError(code);
  const initial = (await observe([subjectId], tx))[0]!;
  if (initial.protected)
    throw new ApplicationError('SAFETY_MODERATION_TARGET_PROTECTED');
  registerTransactionExactDeadline(tx, initial.until, code);
  registerRequiredTransactionFact(
    tx,
    proof,
    subjectId,
    Object.freeze({ subject: subjectId, fingerprint: initial.fingerprint }),
  );
}
