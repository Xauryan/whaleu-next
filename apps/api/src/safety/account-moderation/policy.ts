import { Injectable } from '@nestjs/common';
import { boundAccountPunishmentPolicy } from '../account-policy/punishment-context.js';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import { boundedOwnerProof } from '../../database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
  registerTransactionExactDeadline,
} from '../../database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../../database/transaction-deadlines.js';
import type { SafetyAction } from './contracts.js';

interface PolicyFact {
  accountId: string;
  action: SafetyAction;
  fingerprint: string;
  allowed: boolean;
  suspended: boolean;
}
const code = 'SAFETY_MODERATION_UNAVAILABLE' as const;
const proof: RequiredTransactionProof<PolicyFact> = {
  maximumFacts: 256,
  failureCode: code,
  validate: (facts, tx) =>
    boundedOwnerProof(tx, code, async (read) => {
      await read.query(`LOCK TABLE whaleu_safety.account_punishments,
      whaleu_safety.account_punishment_heads,
      whaleu_safety.account_punishment_terminals IN SHARE MODE NOWAIT`);
      for (const fact of facts) {
        const row = (
          await read.query<{
            fingerprint: string;
            allowed: boolean;
            suspended: boolean;
          }>(
            `SELECT * FROM whaleu_safety.account_punishment_policy_observation($1,$2)`,
            [fact.accountId, fact.action],
          )
        ).rows[0];
        if (
          !row ||
          row.fingerprint !== fact.fingerprint ||
          row.allowed !== fact.allowed ||
          row.suspended !== fact.suspended
        )
          throw new ApplicationError(code);
      }
    }),
};
/** Overlay only: never clears unknown imported base Safety coverage, Identity,
 * grant, phone, affiliation or another owner's independent eligibility. Immutable
 * per-actor snapshots permit a compound moderator command to punish its subject
 * without forgiving a changed actor or replacing an earlier outer proof. */
export async function enforceProductionAccountPunishment(
  accountId: string,
  action: SafetyAction,
  tx: PoolClient,
): Promise<void> {
  if (action === 'guest' || action === 'restricted_self_service') return;
  enableRequiredTransactionProof(tx, proof);
  const row = (
    await tx.query<{
      fingerprint: string;
      allowed: boolean;
      suspended: boolean;
      until: string | null;
    }>(
      `SELECT * FROM whaleu_safety.account_punishment_policy_observation($1,$2)`,
      [accountId, action],
    )
  ).rows[0];
  if (!row) throw new ApplicationError(code);
  registerRequiredTransactionFact(
    tx,
    proof,
    `${accountId}:${action}`,
    Object.freeze({
      accountId,
      action,
      fingerprint: row.fingerprint,
      allowed: row.allowed,
      suspended: row.suspended,
    }),
  );
  // A command owner may catch this denial and save an immutable rejection. Its
  // original negative fact therefore must survive the throw and must expire at
  // the relevant finite boundary; stale denial cannot become a durable result.
  if (!row.allowed && row.until)
    registerTransactionExactDeadline(tx, row.until, code);
  if (!row.allowed)
    throw new ApplicationError(
      row.suspended ? 'SAFETY_ACCESS_SUSPENDED' : 'SAFETY_ACTION_RESTRICTED',
    );
}

/** Per-application injectable policy. Production has no missing-schema fallback. */
@Injectable()
export class AccountPunishmentPolicy {
  enforce(
    accountId: string,
    action: SafetyAction,
    tx: PoolClient,
  ): Promise<void> {
    return enforceProductionAccountPunishment(accountId, action, tx);
  }
}
export function enforceAccountPunishment(
  accountId: string,
  action: SafetyAction,
  tx: PoolClient,
): Promise<void> {
  const policy = boundAccountPunishmentPolicy(tx);
  return policy
    ? policy.enforce(accountId, action, tx)
    : enforceProductionAccountPunishment(accountId, action, tx);
}
