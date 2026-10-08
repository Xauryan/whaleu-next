import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
  budgetedClient,
  configuredTimeout,
} from '../database/optional-count.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
  registerTransactionDeadline,
} from '../database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../database/transaction-deadlines.js';
import { ApplicationError } from '../http/application-error.js';

const subjectIdSchema = z.uuid().refine((id) => id === id.toLowerCase());
const grantSchema = z.strictObject({
  id: subjectIdSchema,
  subjectId: subjectIdSchema,
  role: z.enum(['school_admin', 'super_admin', 'developer']),
  operatingRegionId: subjectIdSchema.nullable(),
  validTimes: z.literal(true),
  active: z.boolean(),
  activationDeadline: z
    .string()
    .regex(/^-?(0|[1-9][0-9]*)$/)
    .nullable(),
});
const TARGET_LIMIT = 16;
const FINAL_PROOF_BUDGET_MS = 500;

/** Only the Authorization owner may register these immutable subject facts.
 * The unrevoked (account,role) unique index and three-role CHECK bound the
 * source to at most three facts per subject, independent of revoked history. */
async function protectionSnapshot(subjects: readonly string[], tx: PoolClient) {
  const result = await tx.query<z.infer<typeof grantSchema>>(
    `WITH checked AS MATERIALIZED (SELECT clock_timestamp() AS at)
     SELECT g.id, g.account_id AS "subjectId", g.role,
       g.operating_region_id AS "operatingRegionId",
       (isfinite(g.created_at) AND isfinite(g.valid_from) AND
         (g.expires_at IS NULL OR
           (isfinite(g.expires_at) AND g.expires_at>g.valid_from))) AS "validTimes",
       (g.valid_from<=checked.at AND
         (g.expires_at IS NULL OR g.expires_at>checked.at)) AS active,
       CASE WHEN isfinite(g.valid_from) AND g.valid_from>checked.at
         THEN floor(extract(epoch FROM g.valid_from)*1000)::text
         ELSE NULL END AS "activationDeadline"
     FROM whaleu_authorization.role_grants g CROSS JOIN checked
     WHERE g.account_id=ANY($1::uuid[]) AND g.revoked_at IS NULL
     ORDER BY g.account_id,g.role`,
    [subjects],
  );
  if (result.rows.length > subjects.length * 3)
    throw new ApplicationError('AUTHORIZATION_UNAVAILABLE');
  const ids = new Set<string>(),
    roles = new Set<string>();
  let protectedTarget = false;
  let until: number | null = null;
  for (const raw of result.rows) {
    const fact = grantSchema.parse(raw);
    const roleKey = `${fact.subjectId}:${fact.role}`;
    if (
      !subjects.includes(fact.subjectId) ||
      ids.has(fact.id) ||
      roles.has(roleKey) ||
      (fact.role === 'school_admin') !== (fact.operatingRegionId !== null) ||
      (fact.active && fact.activationDeadline !== null)
    )
      throw new ApplicationError('AUTHORIZATION_UNAVAILABLE');
    ids.add(fact.id);
    roles.add(roleKey);
    protectedTarget ||= fact.active;
    if (fact.activationDeadline !== null) {
      const deadline = Number(fact.activationDeadline);
      if (!Number.isSafeInteger(deadline))
        throw new ApplicationError('AUTHORIZATION_UNAVAILABLE');
      until = Math.min(until ?? Infinity, deadline);
    }
  }
  return { protectedTarget, until };
}

const targetProof: RequiredTransactionProof<string> = {
  maximumFacts: TARGET_LIMIT,
  failureCode: 'AUTHORIZATION_UNAVAILABLE',
  async validate(subjects, tx) {
    const expires = performance.now() + FINAL_PROOF_BUDGET_MS;
    try {
      const settings = (
        await tx.query<{
          statement_timeout: string;
          lock_timeout: string;
          isolation: string;
        }>(`SELECT current_setting('statement_timeout') AS statement_timeout,
          current_setting('lock_timeout') AS lock_timeout,
          current_setting('transaction_isolation') AS isolation`)
      ).rows[0];
      if (!settings || settings.isolation !== 'read committed')
        throw new ApplicationError('AUTHORIZATION_UNAVAILABLE');
      const read = budgetedClient(
        tx,
        expires,
        configuredTimeout(settings.statement_timeout),
        Math.min(1, configuredTimeout(settings.lock_timeout)),
      );
      // This is final-only, after deferred constraints. Ordinary grant writers
      // need not cooperate: PostgreSQL DML's ROW EXCLUSIVE conflicts with SHARE.
      await read.query(
        'LOCK TABLE whaleu_authorization.role_grants IN SHARE MODE NOWAIT',
      );
      // Plain reads never wait on grant rows or Campus after taking this fence.
      const snapshot = await protectionSnapshot(subjects, read);
      if (snapshot.protectedTarget || performance.now() >= expires)
        throw new ApplicationError('AUTHORIZATION_UNAVAILABLE');
      // Register on the ORIGINAL managed client, never the budgeted proxy.
      // SQL floors microseconds conservatively; the wrapper's last DB clock
      // catches activation during every remaining required/optional proof.
      registerTransactionDeadline(
        tx,
        snapshot.until,
        'AUTHORIZATION_UNAVAILABLE',
      );
      await tx.query(
        "SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$2,true)",
        [settings.statement_timeout, settings.lock_timeout],
      );
      if (performance.now() >= expires)
        throw new ApplicationError('AUTHORIZATION_UNAVAILABLE');
    } catch {
      // Any failed fence/read/validation aborts all tentative effects. Local
      // settings are then restored by the transaction rollback, never weakened.
      throw new ApplicationError('AUTHORIZATION_UNAVAILABLE');
    }
  },
};

/** An early protected result is deterministic. An early negative is only a
 * proposal until the mandatory final owner proof; pure delete/release omit it. */
export async function requireUnprotectedErrandTarget(
  subjectId: string,
  tx: PoolClient,
): Promise<void> {
  let protectedTarget: boolean;
  try {
    subjectIdSchema.parse(subjectId);
    enableRequiredTransactionProof(tx, targetProof);
    const isolation = (
      await tx.query<{ isolation: string }>(
        "SELECT current_setting('transaction_isolation') AS isolation",
      )
    ).rows[0]?.isolation;
    if (isolation !== 'read committed')
      throw new ApplicationError('AUTHORIZATION_UNAVAILABLE');
    ({ protectedTarget } = await protectionSnapshot([subjectId], tx));
  } catch {
    throw new ApplicationError('AUTHORIZATION_UNAVAILABLE');
  }
  if (protectedTarget)
    throw new ApplicationError('ERRAND_RESTRICTION_TARGET_PROTECTED');
  registerRequiredTransactionFact(tx, targetProof, subjectId, subjectId);
}
