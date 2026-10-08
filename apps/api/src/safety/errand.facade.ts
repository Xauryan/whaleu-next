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
    // Lock the pointer before loading the immutable snapshot. PostgreSQL retains
    // microsecond precision for all effectiveness and coverage predicates.
    const head = (
      await tx.query<{ snapshot_id: string }>(
        'SELECT snapshot_id FROM whaleu_safety.errand_feature_heads WHERE account_id=$1 FOR SHARE',
        [accountId],
      )
    ).rows[0];
    if (!head) throw new ApplicationError('SAFETY_UNAVAILABLE');
    let row: { restricted: boolean; valid_until: Date | null } | undefined;
    try {
      row = (
        await tx.query<{ restricted: boolean; valid_until: Date | null }>(
          `WITH instant AS MATERIALIZED (SELECT clock_timestamp() now)
 SELECT whaleu_safety.require_errand_restriction_snapshot(s.id,s.account_id,instant.now) verified,s.valid_until,
 EXISTS(SELECT 1 FROM jsonb_array_elements(s.restrictions) f
 WHERE f->>'action' IN ($3,'all') AND whaleu_safety.errand_restriction_effective(f,instant.now)) restricted
 FROM whaleu_safety.errand_feature_snapshots s CROSS JOIN instant WHERE s.id=$1 AND s.account_id=$2`,
          [head.snapshot_id, accountId, action],
        )
      ).rows[0];
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (String(error.code).startsWith('22') ||
          ('constraint' in error &&
            error.constraint === 'errand_restriction_unavailable'))
      )
        throw new ApplicationError('SAFETY_UNAVAILABLE');
      throw error;
    }
    if (!row) throw new ApplicationError('SAFETY_UNAVAILABLE');
    registerTransactionDeadline(
      tx,
      row.valid_until?.getTime() ?? null,
      'SAFETY_UNAVAILABLE',
    );
    if (row.restricted) throw new ApplicationError('ERRAND_ACTION_RESTRICTED');
  }
}
