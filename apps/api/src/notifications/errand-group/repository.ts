import { createHash, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type {
  GroupPublication,
  GroupStage,
  GroupStatus,
  SyntheticAck,
} from './contracts.js';
import { groupWindow } from './contracts.js';
interface PublicationRow {
  event_id: string;
  order_id: string;
  target_region_id: string;
  published_at: Date;
  first_confirmed_at: Date | null;
}
export interface GroupClaim {
  id: string;
  event_id: string;
  stage: GroupStage;
  destination_id: string;
  idempotency_key: string;
  attempt_id: string;
  fence: string;
  lease_until: Date;
  attempts: number;
  reconciliations: number;
  operation: 'send' | 'reconcile';
  publication: GroupPublication;
}
const project = (r: PublicationRow): GroupPublication => ({
  eventId: r.event_id,
  orderId: r.order_id,
  targetRegionId: r.target_region_id,
  publishedAt: r.published_at.getTime(),
  firstConfirmedAt: r.first_confirmed_at?.getTime() ?? null,
});
export type GroupReason =
  | 'not_accepted'
  | 'unavailable'
  | 'source_or_authority'
  | 'window'
  | 'budget'
  | 'unknown'
  | 'permit_expired';
export function groupDeliveryKey(
  eventId: string,
  stage: GroupStage,
  destination: string,
) {
  return createHash('sha256')
    .update(JSON.stringify(['errand-group-v1', eventId, stage, destination]))
    .digest('hex');
}
@Injectable()
export class ErrandGroupRepository {
  async publicationCandidates(now: number, tx: PoolClient): Promise<string[]> {
    return (
      await tx.query<{ event_id: string }>(
        `SELECT event_id FROM whaleu_notifications.errand_group_publications
      WHERE last_scanned_at IS NULL OR published_at BETWEEN $1::timestamptz-interval '16 minutes' AND $1::timestamptz
      OR first_confirmed_at BETWEEN $1::timestamptz-interval '30 minutes' AND $1::timestamptz
      ORDER BY last_scanned_at NULLS FIRST,published_at,event_id LIMIT 32`,
        [new Date(now)],
      )
    ).rows.map((r) => r.event_id);
  }
  async discoveryPublication(
    eventId: string,
    tx: PoolClient,
  ): Promise<GroupPublication | null> {
    const row = (
      await tx.query<PublicationRow>(
        'SELECT * FROM whaleu_notifications.errand_group_publications WHERE event_id=$1 FOR UPDATE SKIP LOCKED',
        [eventId],
      )
    ).rows[0];
    return row ? project(row) : null;
  }
  async scanned(eventId: string, tx: PoolClient) {
    // Fair scan bookkeeping uses real database time even while the synthetic
    // business clock is held still. It never changes eligibility or authority.
    await tx.query(
      'UPDATE whaleu_notifications.errand_group_publications SET last_scanned_at=clock_timestamp() WHERE event_id=$1',
      [eventId],
    );
  }
  async enrollDestination(
    p: GroupPublication,
    stage: GroupStage,
    destinationId: string,
    now: number,
    tx: PoolClient,
    expired = false,
  ) {
    await tx.query(
      `INSERT INTO whaleu_notifications.errand_group_deliveries(id,event_id,stage,destination_id,idempotency_key,next_attempt_at,status,reason)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(event_id,stage,destination_id) DO NOTHING`,
      [
        randomUUID(),
        p.eventId,
        stage,
        destinationId,
        groupDeliveryKey(p.eventId, stage, destinationId),
        new Date(now),
        expired ? 'expired' : 'pending',
        expired ? 'window' : null,
      ],
    );
  }
  async claim(now: number, tx: PoolClient): Promise<GroupClaim | null> {
    const row = (
      await tx.query<
        Omit<GroupClaim, 'operation' | 'publication'> &
          PublicationRow & { status: GroupStatus }
      >(
        `SELECT d.*,p.order_id,p.target_region_id,p.published_at,p.first_confirmed_at FROM whaleu_notifications.errand_group_deliveries d
      JOIN whaleu_notifications.errand_group_publications p ON p.event_id=d.event_id
      WHERE d.status IN('pending','retryable','unknown') AND d.next_attempt_at<=$1
      AND(d.lease_until IS NULL OR d.lease_until<=clock_timestamp())
      AND(d.status<>'unknown' OR d.reconciliations<8) AND d.attempts<32
      ORDER BY d.next_attempt_at,d.id LIMIT 1 FOR UPDATE OF d SKIP LOCKED`,
        [new Date(now)],
      )
    ).rows[0];
    if (!row) return null;
    const operation = row.status === 'unknown' ? 'reconcile' : 'send';
    const lease = (
      await tx.query<{
        attempt_id: string;
        fence: string;
        lease_until: Date;
        attempts: number;
        reconciliations: number;
      }>(
        `UPDATE whaleu_notifications.errand_group_deliveries SET status='unknown',attempt_id=$2,fence=fence+1,attempts=attempts+1,
      reconciliations=reconciliations+$3,lease_until=clock_timestamp()+interval '30 seconds',reason='unknown' WHERE id=$1
      RETURNING attempt_id,fence,lease_until,attempts,reconciliations`,
        [row.id, randomUUID(), operation === 'reconcile' ? 1 : 0],
      )
    ).rows[0]!;
    await tx.query(
      `INSERT INTO whaleu_notifications.errand_group_attempts(id,delivery_id,fence,idempotency_key,operation) VALUES($1,$2,$3,$4,$5)`,
      [lease.attempt_id, row.id, lease.fence, row.idempotency_key, operation],
    );
    return { ...row, ...lease, operation, publication: project(row) };
  }
  async current(claim: GroupClaim, tx: PoolClient): Promise<GroupPublication> {
    const row = (
      await tx.query<PublicationRow>(
        `SELECT p.* FROM whaleu_notifications.errand_group_deliveries d
      JOIN whaleu_notifications.errand_group_publications p ON p.event_id=d.event_id
      WHERE d.id=$1 AND d.attempt_id=$2 AND d.fence=$3 AND d.status='unknown' AND d.lease_until>clock_timestamp() FOR UPDATE OF d`,
        [claim.id, claim.attempt_id, claim.fence],
      )
    ).rows[0];
    if (!row) throw Error('Group lease unavailable');
    return project(row);
  }
  async finish(
    claim: GroupClaim,
    status: Exclude<GroupStatus, 'pending' | 'confirmed'>,
    reason: GroupReason,
    now: number,
    tx: PoolClient,
  ) {
    const capped = status === 'retryable' && claim.attempts >= 8;
    await tx.query(
      `UPDATE whaleu_notifications.errand_group_deliveries SET status=$4,reason=$5,attempt_id=NULL,lease_until=NULL,next_attempt_at=$6
      WHERE id=$1 AND attempt_id=$2 AND fence=$3 AND status='unknown'`,
      [
        claim.id,
        claim.attempt_id,
        claim.fence,
        capped ? 'suppressed' : status,
        capped ? 'budget' : reason,
        new Date(
          now + Math.min(60000, 1000 * 2 ** Math.min(claim.attempts - 1, 6)),
        ),
      ],
    );
  }
  async confirmed(
    claim: GroupClaim,
    ack: Extract<SyntheticAck, { status: 'confirmed' }>,
    now: number,
    tx: PoolClient,
  ) {
    const p = await this.current(claim, tx);
    if (
      ack.key !== claim.idempotency_key ||
      ack.destinationId !== claim.destination_id ||
      !/^synthetic:[a-zA-Z0-9:_-]{1,120}$/.test(ack.receiptId) ||
      !Number.isSafeInteger(ack.confirmedAt) ||
      ack.confirmedAt > now ||
      groupWindow(p, claim.stage, ack.confirmedAt) !== 'eligible'
    )
      throw Error('Unproven synthetic ACK');
    await tx.query(
      `INSERT INTO whaleu_notifications.errand_group_receipts(delivery_id,idempotency_key,receipt_id,confirmed_at) VALUES($1,$2,$3,$4) ON CONFLICT(delivery_id) DO NOTHING`,
      [
        claim.id,
        claim.idempotency_key,
        ack.receiptId,
        new Date(ack.confirmedAt),
      ],
    );
    const receipt = (
      await tx.query<{ valid: boolean }>(
        'SELECT idempotency_key=$2 AND receipt_id=$3 AND confirmed_at=$4::timestamptz valid FROM whaleu_notifications.errand_group_receipts WHERE delivery_id=$1',
        [
          claim.id,
          claim.idempotency_key,
          ack.receiptId,
          new Date(ack.confirmedAt),
        ],
      )
    ).rows[0];
    if (!receipt?.valid) throw Error('Conflicting synthetic ACK');
    await tx.query(
      `UPDATE whaleu_notifications.errand_group_deliveries SET status='confirmed',reason=NULL,attempt_id=NULL,lease_until=NULL WHERE id=$1 AND attempt_id=$2 AND fence=$3`,
      [claim.id, claim.attempt_id, claim.fence],
    );
    if (claim.stage === 'errand')
      await tx.query(
        `UPDATE whaleu_notifications.errand_group_publications SET first_confirmed_at=$2,first_confirmed_delivery_id=$3,last_scanned_at=NULL WHERE event_id=$1 AND first_confirmed_at IS NULL`,
        [p.eventId, new Date(ack.confirmedAt), claim.id],
      );
  }
}
