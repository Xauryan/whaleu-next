import { randomUUID } from 'node:crypto';
import { ApplicationError } from '../http/application-error.js';
import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
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
  async count(accountId: string, tx: PoolClient) {
    return (
      await tx.query<{ count: number }>(
        'SELECT count(*)::integer count FROM whaleu_notifications.errand_notices WHERE recipient_account_id=$1 AND read_at IS NULL',
        [accountId],
      )
    ).rows[0]!.count;
  }
}
