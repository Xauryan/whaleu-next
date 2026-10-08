import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { SafetyRepository } from './repository.js';
import { ApplicationError } from '../http/application-error.js';
import { registerTransactionDeadline } from '../database/transaction-deadlines.js';
export const errandRestrictionSchema = z.strictObject({
  id: z.uuid(),
  action: z.enum(['publish', 'accept', 'all']),
  reason: z.string().min(1).max(500),
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }).nullable(),
  releasedAt: z.iso.datetime({ offset: true }).nullable(),
  provenance: z.literal('accepted'),
  issuer: z.string().trim().min(1),
  sourceReference: z.string().trim().min(1),
  policyReference: z.string().trim().min(1),
});
export function evaluateErrandRestrictions(
  value: unknown,
  now: number,
  action: 'publish' | 'accept',
): 'allowed' | 'restricted' | 'unavailable' {
  const parsed = z.array(errandRestrictionSchema).max(256).safeParse(value);
  if (
    !parsed.success ||
    !Number.isFinite(now) ||
    new Set(parsed.data.map((r) => r.id)).size !== parsed.data.length
  )
    return 'unavailable';
  for (const r of parsed.data) {
    const start = Date.parse(r.startsAt),
      end = r.endsAt === null ? null : Date.parse(r.endsAt),
      released = r.releasedAt === null ? null : Date.parse(r.releasedAt);
    if (
      start > now ||
      (end !== null && end <= start) ||
      (released !== null && (released < start || released > now))
    )
      return 'unavailable';
  }
  return parsed.data.some(
    (r) =>
      r.releasedAt === null &&
      (r.action === action || r.action === 'all') &&
      (r.endsAt === null || Date.parse(r.endsAt) > now),
  )
    ? 'restricted'
    : 'allowed';
}
/** Reads only canonical account/errand authorities; no named-person policy. */
@Injectable()
export class SafetyErrandFacade {
  constructor(
    @Inject(SafetyRepository) private readonly records: SafetyRepository,
  ) {}
  async requireAllowed(accountId: string, tx: PoolClient) {
    await this.records.restriction(accountId, tx);
  }
  async requireFeature(
    accountId: string,
    action: 'publish' | 'accept',
    tx: PoolClient,
  ) {
    const row = (
      await tx.query<{
        account_id: string;
        coverage: string;
        provenance: string;
        source_reference: string;
        policy_reference: string;
        effective_at: Date;
        valid_until: Date | null;
        restrictions: unknown;
      }>(
        `SELECT s.* FROM whaleu_safety.errand_feature_heads h JOIN whaleu_safety.errand_feature_snapshots s ON s.id=h.snapshot_id AND s.account_id=h.account_id WHERE h.account_id=$1 FOR SHARE OF h`,
        [accountId],
      )
    ).rows[0];
    const now = (
      await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now')
    ).rows[0]!.now.getTime();
    if (
      !row ||
      row.account_id !== accountId ||
      row.coverage !== 'complete' ||
      row.provenance !== 'accepted' ||
      !row.source_reference?.trim() ||
      !row.policy_reference?.trim() ||
      !Number.isFinite(row.effective_at.getTime()) ||
      row.effective_at.getTime() > now ||
      (row.valid_until !== null &&
        (!Number.isFinite(row.valid_until.getTime()) ||
          row.valid_until.getTime() <= now))
    )
      throw new ApplicationError('SAFETY_UNAVAILABLE');
    const decision = evaluateErrandRestrictions(row.restrictions, now, action);
    if (decision === 'unavailable')
      throw new ApplicationError('SAFETY_UNAVAILABLE');
    registerTransactionDeadline(
      tx,
      row.valid_until?.getTime() ?? null,
      'SAFETY_UNAVAILABLE',
    );
    if (decision === 'restricted')
      throw new ApplicationError('ERRAND_ACTION_RESTRICTED');
  }
}
