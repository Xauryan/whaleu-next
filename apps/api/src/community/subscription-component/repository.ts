import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type {
  SubscriptionSource,
  SubscriptionState,
  SubscriptionMembership,
} from './contracts.js';
@Injectable()
export class SubscriptionComponentRepository {
  async reference(
    id: string,
    tx: PoolClient,
  ): Promise<SubscriptionSource | null> {
    return (
      (
        await tx.query<SubscriptionSource>(
          `SELECT o.id AS obligation_id,o.epoch_id,o.transition,e.post_id,e.account_id AS actor_id,o.delta,o.status,
      s.source_sequence::text,coalesce(s.post_id=e.post_id AND s.actor_id=e.account_id AND s.source_sequence=CASE WHEN o.transition='saved' THEN e.started_sequence ELSE e.ended_sequence END
      AND s.source_transaction=o.local_creation_transaction AND o.recipient_account_id=p.account_id
      AND o.delta=CASE WHEN o.transition='saved' THEN 1 ELSE -1 END,false) AS source_valid
      FROM whaleu_community.saved_obligations o JOIN whaleu_community.saved_epochs e ON e.id=o.epoch_id
      JOIN whaleu_community.posts p ON p.id=e.post_id
      LEFT JOIN whaleu_post_hotness.subscription_sources s ON s.epoch_id=o.epoch_id AND s.transition=o.transition
      WHERE o.id=$1 AND o.action='save_ranking'`,
          [id],
        )
      ).rows[0] ?? null
    );
  }
  async lockPost(postId: string, tx: PoolClient) {
    await tx.query(
      'SELECT id FROM whaleu_community.posts WHERE id=$1 FOR UPDATE',
      [postId],
    );
  }
  async known(postId: string, tx: PoolClient): Promise<boolean> {
    return (
      (
        await tx.query(
          'SELECT post_id FROM whaleu_post_hotness.subscription_baselines WHERE post_id=$1',
          [postId],
        )
      ).rowCount === 1
    );
  }
  async state(
    postId: string,
    tx: PoolClient,
    lock: boolean,
  ): Promise<SubscriptionState | null> {
    return (
      (
        await tx.query<SubscriptionState>(
          `SELECT count::text,last_sequence::text,last_receipt_id FROM whaleu_post_hotness.subscription_states WHERE post_id=$1${lock ? ' FOR UPDATE' : ''}`,
          [postId],
        )
      ).rows[0] ?? null
    );
  }
  async membership(
    postId: string,
    actorId: string,
    tx: PoolClient,
    lock: boolean,
  ): Promise<SubscriptionMembership | null> {
    return (
      (
        await tx.query<SubscriptionMembership>(
          `SELECT active_epoch_id,last_sequence::text,last_receipt_id FROM whaleu_post_hotness.subscription_memberships WHERE post_id=$1 AND actor_id=$2${lock ? ' FOR UPDATE' : ''}`,
          [postId, actorId],
        )
      ).rows[0] ?? null
    );
  }
  async lockObligation(id: string, tx: PoolClient) {
    await tx.query(
      'SELECT id FROM whaleu_community.saved_obligations WHERE id=$1 FOR UPDATE',
      [id],
    );
  }
  async receipt(source: SubscriptionSource, tx: PoolClient): Promise<boolean> {
    const row = (
      await tx.query<{ valid: boolean }>(
        `SELECT epoch_id=$2 AND transition=$3 AND post_id=$4 AND actor_id=$5 AND source_sequence=$6 AND delta=$7 AND component_version=1 AS valid FROM whaleu_post_hotness.subscription_receipts WHERE obligation_id=$1`,
        [
          source.obligation_id,
          source.epoch_id,
          source.transition,
          source.post_id,
          source.actor_id,
          source.source_sequence,
          source.delta,
        ],
      )
    ).rows[0];
    if (row && !row.valid)
      throw new Error('Subscription receipt identity mismatch');
    return !!row;
  }
  async first(postId: string, tx: PoolClient): Promise<string | null> {
    return (
      (
        await tx.query<{ source_sequence: string }>(
          `SELECT s.source_sequence::text FROM whaleu_post_hotness.subscription_sources s
      WHERE s.post_id=$1 AND NOT EXISTS(SELECT 1 FROM whaleu_post_hotness.subscription_receipts r WHERE r.epoch_id=s.epoch_id AND r.transition=s.transition)
      ORDER BY s.source_sequence LIMIT 1`,
          [postId],
        )
      ).rows[0]?.source_sequence ?? null
    );
  }
}
