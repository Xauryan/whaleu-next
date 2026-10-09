import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import { boundedOwnerProof } from '../../database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
} from '../../database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../../database/transaction-deadlines.js';
import { ratingIso } from '../repository.js';
export interface SubscriptionRow {
  target_id: string;
  baseline_id: string;
  count: number;
  head_transition_id: string | null;
  target_order: string;
  subscribed: boolean;
  revision: string;
  occurred_at: string;
  last_transition_id: string | null;
  active_epoch_id: string | null;
}
interface Fact {
  id: string;
  actor: string;
  baseline: string | null;
  count: number | null;
  head: string | null;
  order: string | null;
  revision: string | null;
  subscribed: boolean | null;
  epoch: string | null;
  actorHead: string | null;
}
const proof: RequiredTransactionProof<Fact> = {
  maximumFacts: 20,
  failureCode: 'RATING_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'RATING_UNAVAILABLE', async (read) => {
      // Parent locks serialize both baseline absence and membership state. No history COUNT.
      await read.query(
        'SELECT id FROM whaleu_ratings.targets WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE NOWAIT',
        [facts.map((f) => f.id)],
      );
      await read.query(
        'SELECT target_id FROM whaleu_ratings.subscription_states WHERE target_id=ANY($1::uuid[]) ORDER BY target_id FOR SHARE NOWAIT',
        [facts.map((f) => f.id)],
      );
      const result = await read.query<{ n: number }>(
        `SELECT count(*)::integer n FROM unnest($1::uuid[],$2::uuid[],$3::uuid[],$4::integer[],$5::uuid[],$6::bigint[],$7::uuid[],$8::boolean[],$9::uuid[],$10::uuid[]) f(id,actor,baseline,count,head,ord,revision,subscribed,epoch,actor_head)
    LEFT JOIN whaleu_ratings.subscription_baselines b ON b.target_id=f.id
    LEFT JOIN whaleu_ratings.subscription_states s ON s.target_id=f.id
    LEFT JOIN whaleu_ratings.subscription_memberships m ON m.target_id=f.id AND m.account_id=f.actor
    WHERE (f.baseline IS NULL AND b.id IS NULL AND s.target_id IS NULL AND m.target_id IS NULL)
    OR (b.id=f.baseline AND b.coverage='complete' AND (s.baseline_id,s.count,s.head_transition_id,s.target_order) IS NOT DISTINCT FROM (f.baseline,f.count,f.head,f.ord)
    AND (coalesce(m.revision,b.id),coalesce(m.subscribed,false),m.active_epoch_id,m.last_transition_id) IS NOT DISTINCT FROM (f.revision,f.subscribed,f.epoch,f.actor_head)
    AND (m.target_id IS NOT NULL OR NOT EXISTS(SELECT 1 FROM whaleu_ratings.subscription_transitions t WHERE t.target_id=f.id AND t.account_id=f.actor LIMIT 1)))`,
        [
          facts.map((f) => f.id),
          facts.map((f) => f.actor),
          facts.map((f) => f.baseline),
          facts.map((f) => f.count),
          facts.map((f) => f.head),
          facts.map((f) => f.order),
          facts.map((f) => f.revision),
          facts.map((f) => f.subscribed),
          facts.map((f) => f.epoch),
          facts.map((f) => f.actorHead),
        ],
      );
      if (result.rows[0]?.n !== facts.length)
        throw new ApplicationError('RATING_UNAVAILABLE');
    }),
};
@Injectable()
export class RatingSubscriptionsRepository {
  async state(
    id: string,
    actor: string,
    tx: PoolClient,
    write = false,
  ): Promise<SubscriptionRow | null> {
    enableRequiredTransactionProof(tx, proof);
    const row =
      (
        await tx.query<SubscriptionRow>(
          `SELECT b.target_id,b.id baseline_id,s.count,s.head_transition_id,s.target_order::text,coalesce(m.subscribed,false) subscribed,coalesce(m.revision,b.id) revision,${ratingIso('coalesce(m.updated_at,b.baseline_at)')} occurred_at,m.last_transition_id,m.active_epoch_id FROM whaleu_ratings.subscription_baselines b JOIN whaleu_ratings.subscription_states s ON s.target_id=b.target_id AND s.baseline_id=b.id LEFT JOIN whaleu_ratings.subscription_memberships m ON m.target_id=b.target_id AND m.account_id=$2 WHERE b.target_id=$1 AND b.coverage='complete' AND (m.target_id IS NOT NULL OR NOT EXISTS(SELECT 1 FROM whaleu_ratings.subscription_transitions t WHERE t.target_id=b.target_id AND t.account_id=$2 LIMIT 1)) FOR ${write ? 'UPDATE' : 'SHARE'} OF s`,
          [id, actor],
        )
      ).rows[0] ?? null;
    if (
      !row &&
      (
        await tx.query(
          'SELECT 1 FROM whaleu_ratings.subscription_baselines WHERE target_id=$1',
          [id],
        )
      ).rowCount
    )
      throw new ApplicationError('RATING_UNAVAILABLE');
    return row;
  }
  retain(
    id: string,
    row: SubscriptionRow | null,
    actor: string,
    tx: PoolClient,
  ) {
    registerRequiredTransactionFact(tx, proof, id, {
      id,
      actor,
      baseline: row?.baseline_id ?? null,
      count: row?.count ?? null,
      head: row?.head_transition_id ?? null,
      order: row?.target_order ?? null,
      revision: row?.revision ?? null,
      subscribed: row?.subscribed ?? null,
      epoch: row?.active_epoch_id ?? null,
      actorHead: row?.last_transition_id ?? null,
    });
  }
  async set(
    id: string,
    actor: string,
    requestId: string,
    expectedRevision: string,
    subscribed: boolean,
    tx: PoolClient,
  ) {
    const current = await this.state(id, actor, tx, true);
    if (!current) throw new ApplicationError('RATING_UNAVAILABLE');
    if (current.revision !== expectedRevision)
      throw new ApplicationError('RATING_REVISION_CONFLICT');
    const outcome = current.subscribed === subscribed ? 'noop' : 'applied';
    if (outcome === 'noop')
      await tx.query(
        'INSERT INTO whaleu_ratings.subscription_noop_observations(account_id,request_id,target_id,baseline_id,anchor_transition_id,subscribed,revision,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8::timestamptz)',
        [
          actor,
          requestId,
          id,
          current.baseline_id,
          current.last_transition_id,
          subscribed,
          current.revision,
          current.occurred_at,
        ],
      );
    else if (current.last_transition_id)
      await tx.query(
        'UPDATE whaleu_ratings.subscription_memberships SET subscribed=$3,request_id=$4,expected_revision=$5 WHERE target_id=$1 AND account_id=$2',
        [id, actor, subscribed, requestId, expectedRevision],
      );
    else
      await tx.query(
        'INSERT INTO whaleu_ratings.subscription_memberships(target_id,account_id,subscribed,request_id,expected_revision) VALUES($1,$2,$3,$4,$5)',
        [id, actor, subscribed, requestId, expectedRevision],
      );
    const final =
      outcome === 'noop' ? current : await this.state(id, actor, tx, true);
    if (!final) throw new ApplicationError('RATING_UNAVAILABLE');
    this.retain(id, final, actor, tx);
    return {
      outcome,
      subscribed: final.subscribed,
      revision: final.revision,
      occurredAt: final.occurred_at,
      transitionId: outcome === 'applied' ? final.last_transition_id : null,
    } as const;
  }
}
