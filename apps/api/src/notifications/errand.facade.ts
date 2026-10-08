import { randomUUID } from 'node:crypto';
import { ApplicationError } from '../http/application-error.js';
import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { ErrandRestrictionNotice } from '../safety/errand-management/contracts.js';
/** Durable local delivery only. No private payload, profile or live order query. */
@Injectable()
export class ErrandNotificationsFacade {
  async owner(accountId: string, tx: PoolClient) {
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `whaleu:errand-notices:${accountId}`,
    ]);
  }
  async record(
    input: {
      transitionId: string;
      recipientAccountId: string;
      orderId: string;
      kind: 'accepted' | 'completed';
    },
    tx: PoolClient,
  ) {
    await this.owner(input.recipientAccountId, tx);
    await tx.query(
      'INSERT INTO whaleu_notifications.errand_notices(id,transition_id,recipient_account_id,order_id,kind) VALUES($1,$2,$3,$4,$5) ON CONFLICT(transition_id,recipient_account_id,kind) DO NOTHING',
      [
        randomUUID(),
        input.transitionId,
        input.recipientAccountId,
        input.orderId,
        input.kind,
      ],
    );
    const row = (
      await tx.query<{ order_id: string }>(
        'SELECT order_id FROM whaleu_notifications.errand_notices WHERE transition_id=$1 AND recipient_account_id=$2 AND kind=$3 FOR SHARE',
        [input.transitionId, input.recipientAccountId, input.kind],
      )
    ).rows[0];
    if (row?.order_id !== input.orderId)
      throw new ApplicationError('ERRAND_UNAVAILABLE');
  }
  async recordAdminDeleted(
    input: {
      transitionId: string;
      recipientAccountId: string;
      orderId: string;
      reason: string;
      occurredAt: string;
    },
    tx: PoolClient,
  ) {
    await this.owner(input.recipientAccountId, tx);
    await tx.query(
      `INSERT INTO whaleu_notifications.errand_notices(id,transition_id,recipient_account_id,order_id,kind,deletion_reason,created_at) VALUES($1,$2,$3,$4,'admin_deleted',$5,$6) ON CONFLICT(transition_id,recipient_account_id,kind) DO NOTHING`,
      [
        randomUUID(),
        input.transitionId,
        input.recipientAccountId,
        input.orderId,
        input.reason,
        input.occurredAt,
      ],
    );
    const row = (
      await tx.query<{ valid: boolean }>(
        `SELECT order_id=$4::uuid AND deletion_reason=$5 AND created_at=$6::timestamptz valid FROM whaleu_notifications.errand_notices WHERE transition_id=$1 AND recipient_account_id=$2 AND kind=$3`,
        [
          input.transitionId,
          input.recipientAccountId,
          'admin_deleted',
          input.orderId,
          input.reason,
          input.occurredAt,
        ],
      )
    ).rows[0];
    if (row?.valid !== true) throw new ApplicationError('ERRAND_UNAVAILABLE');
  }
  async recordFeature(input: ErrandRestrictionNotice, tx: PoolClient) {
    await this.owner(input.recipientAccountId, tx);
    await tx.query(
      `INSERT INTO whaleu_notifications.errand_feature_notices(id,event_id,restriction_id,recipient_account_id,kind,action,reason,starts_at,ends_at,released_at,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT(event_id,recipient_account_id,kind) DO NOTHING`,
      [
        randomUUID(),
        input.eventId,
        input.restrictionId,
        input.recipientAccountId,
        input.kind,
        input.action,
        input.reason,
        input.startsAt,
        input.endsAt,
        input.releasedAt ?? null,
        input.recordedAt,
      ],
    );
    const row = (
      await tx.query<{ valid: boolean }>(
        `SELECT restriction_id=$4::uuid AND action=$5 AND reason=$6 AND starts_at=$7::timestamptz AND ends_at IS NOT DISTINCT FROM $8::timestamptz AND released_at IS NOT DISTINCT FROM $9::timestamptz valid FROM whaleu_notifications.errand_feature_notices WHERE event_id=$1 AND recipient_account_id=$2 AND kind=$3`,
        [
          input.eventId,
          input.recipientAccountId,
          input.kind,
          input.restrictionId,
          input.action,
          input.reason,
          input.startsAt,
          input.endsAt,
          input.releasedAt ?? null,
        ],
      )
    ).rows[0];
    if (row?.valid !== true) throw new ApplicationError('ERRAND_UNAVAILABLE');
  }
  async count(accountId: string, tx: PoolClient) {
    return (
      await tx.query<{ count: number }>(
        `SELECT ((SELECT count(*) FROM whaleu_notifications.errand_notices WHERE recipient_account_id=$1 AND read_at IS NULL)+(SELECT count(*) FROM whaleu_notifications.errand_feature_notices WHERE recipient_account_id=$1 AND read_at IS NULL))::integer count`,
        [accountId],
      )
    ).rows[0]!.count;
  }
}
