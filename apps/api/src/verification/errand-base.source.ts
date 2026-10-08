import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { registerTransactionDeadline } from '../database/transaction-deadlines.js';
export interface TemporaryErrandBaseFact {
  account_id: string;
  state: 'verified' | 'unverified' | 'revoked';
  coverage: string;
  provenance: string;
  issuer: string;
  source_reference: string;
  policy_reference: string;
  effective_at: Date;
  valid_until: Date;
}
export function temporaryErrandBaseStatus(
  row: TemporaryErrandBaseFact | undefined,
  accountId: string,
  now: number,
): 'verified' | 'unverified' | 'unavailable' {
  if (
    !row ||
    row.account_id !== accountId ||
    row.coverage !== 'complete' ||
    row.provenance !== 'accepted' ||
    !row.issuer?.trim() ||
    !row.source_reference?.trim() ||
    !row.policy_reference?.trim() ||
    !Number.isFinite(now) ||
    !(row.effective_at instanceof Date) ||
    !(row.valid_until instanceof Date) ||
    !Number.isFinite(row.effective_at.getTime()) ||
    !Number.isFinite(row.valid_until.getTime()) ||
    row.effective_at.getTime() > now ||
    row.valid_until.getTime() <= row.effective_at.getTime()
  )
    return 'unavailable';
  if (!['verified', 'unverified', 'revoked'].includes(row.state))
    return 'unavailable';
  return row.state !== 'verified' || row.valid_until.getTime() <= now
    ? 'unverified'
    : 'verified';
}
/** Separate base entitlement. Never an affiliation, school, or cosmetic title. */
@Injectable()
export class LocalErrandBaseEligibilitySource {
  async resolve(
    accountId: string,
    tx: PoolClient,
  ): Promise<
    | { status: 'verified'; validUntil: number }
    | { status: 'unverified' | 'unavailable' }
  > {
    const row = (
      await tx.query<TemporaryErrandBaseFact>(
        `SELECT s.* FROM whaleu_verification.errand_base_heads h JOIN whaleu_verification.errand_base_assertions s ON s.id=h.assertion_id AND s.account_id=h.account_id WHERE h.account_id=$1 FOR SHARE OF h`,
        [accountId],
      )
    ).rows[0];
    const now = (
      await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now')
    ).rows[0]!.now.getTime();
    const status = temporaryErrandBaseStatus(row, accountId, now);
    if (status !== 'verified') return { status };
    const validUntil = row!.valid_until.getTime();
    registerTransactionDeadline(tx, validUntil, 'VERIFICATION_UNAVAILABLE');
    return { status, validUntil };
  }
}
