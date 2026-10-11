import type { PoolClient } from 'pg';
import {
  boundedOwnerProof,
  ownerFingerprint,
} from '../../database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
} from '../../database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../../database/transaction-deadlines.js';
import { ApplicationError } from '../../http/application-error.js';
interface Fact {
  applicationId: string | null;
  actor: string;
  fingerprint: string;
}
async function state(fact: Omit<Fact, 'fingerprint'>, tx: PoolClient) {
  const app =
    fact.applicationId === null
      ? null
      : (
          await tx.query(
            'SELECT to_jsonb(a) row,a.xmin::text version FROM whaleu_verification.student_applications a WHERE id=$1',
            [fact.applicationId],
          )
        ).rows;
  const actor = (
    await tx.query(
      `SELECT to_jsonb(a) account,a.xmin::text av,to_jsonb(s) safety,s.xmin::text sv FROM whaleu_identity.accounts a LEFT JOIN whaleu_safety.account_heads s ON s.account_id=a.id WHERE a.id=$1`,
      [fact.actor],
    )
  ).rows;
  const grants = (
    await tx.query(
      'SELECT to_jsonb(g) row,g.xmin::text version FROM whaleu_authorization.role_grants g WHERE account_id=$1 ORDER BY id',
      [fact.actor],
    )
  ).rows;
  return ownerFingerprint({ app, actor, grants });
}
const proof: RequiredTransactionProof<Fact> = {
  maximumFacts: 64,
  failureCode: 'VERIFICATION_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'VERIFICATION_UNAVAILABLE', async (read) => {
      await read.query(
        'LOCK TABLE whaleu_verification.student_applications,whaleu_identity.accounts,whaleu_safety.account_heads,whaleu_authorization.role_grants IN SHARE MODE NOWAIT',
      );
      for (const f of facts)
        if ((await state(f, read)) !== f.fingerprint)
          throw new ApplicationError('VERIFICATION_UNAVAILABLE');
    }),
};
export async function requireStudentCurrent(
  applicationId: string | null,
  actor: string,
  tx: PoolClient,
) {
  const fact = { applicationId, actor };
  const fingerprint = await state(fact, tx);
  enableRequiredTransactionProof(tx, proof);
  registerRequiredTransactionFact(
    tx,
    proof,
    `${applicationId}:${actor}:${fingerprint}`,
    Object.freeze({ ...fact, fingerprint }),
  );
}
export async function lockStudentAccount(accountId: string, tx: PoolClient) {
  await tx.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('whaleu:student-application:v1:'||$1,0))",
    [accountId],
  );
}
