import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { SubscriptionComponentRepository } from './repository.js';
import type {
  SubscriptionResult,
  SubscriptionSource,
  SubscriptionState,
  SubscriptionMembership,
} from './contracts.js';
export function subscriptionAfterCount(
  source: SubscriptionSource,
  state: SubscriptionState,
  membership: SubscriptionMembership | null,
): string {
  if (
    !source.source_sequence ||
    BigInt(source.source_sequence) <= BigInt(state.last_sequence) ||
    (membership &&
      BigInt(source.source_sequence) <= BigInt(membership.last_sequence))
  )
    throw new Error('Invalid subscription causal position');
  if (source.transition === 'saved') {
    if (source.delta !== 1 || membership?.active_epoch_id)
      throw new Error('Invalid positive subscription membership');
  } else if (
    source.delta !== -1 ||
    membership?.active_epoch_id !== source.epoch_id ||
    BigInt(state.count) <= 0n
  ) {
    throw new Error('Invalid negative subscription membership');
  }
  return (BigInt(state.count) + BigInt(source.delta)).toString();
}
@Injectable()
export class SubscriptionComponentSettlement {
  constructor(
    @Inject(SubscriptionComponentRepository)
    private readonly records: SubscriptionComponentRepository,
  ) {}
  async process(
    id: string,
    tx: PoolClient,
    apply: boolean,
  ): Promise<SubscriptionResult> {
    let source = await this.records.reference(id, tx);
    if (!source) return 'missing';
    if (apply) {
      await this.records.lockPost(source.post_id, tx);
      source = await this.records.reference(id, tx);
      if (!source) return 'sourceUnavailable';
    }
    if (!(await this.records.known(source.post_id, tx)))
      return 'blockedBaseline';
    if (!source.source_valid || !source.source_sequence)
      return 'sourceUnavailable';
    const state = await this.records.state(source.post_id, tx, apply);
    if (!state) throw new Error('Known subscription baseline without state');
    const membership = await this.records.membership(
      source.post_id,
      source.actor_id,
      tx,
      apply,
    );
    if (apply) await this.records.lockObligation(id, tx);
    const receipt = await this.records.receipt(source, tx);
    if (receipt || source.status === 'completed') {
      if (!receipt || source.status !== 'completed')
        throw new Error('Subscription receipt/status mismatch');
      return 'alreadyCompleted';
    }
    if (source.status !== 'pending')
      throw new Error('Unsupported subscription obligation state');
    if (
      (await this.records.first(source.post_id, tx)) !== source.source_sequence
    )
      return 'blockedPredecessor';
    const after = subscriptionAfterCount(source, state, membership);
    if (!apply) return 'pending';
    await tx.query(
      `INSERT INTO whaleu_post_hotness.subscription_receipts(obligation_id,epoch_id,transition,post_id,actor_id,source_sequence,component_version,delta,before_count,after_count,previous_state_sequence,previous_membership_sequence,previous_membership_epoch)
      VALUES($1,$2,$3,$4,$5,$6,1,$7,$8,$9,$10,$11,$12)`,
      [
        id,
        source.epoch_id,
        source.transition,
        source.post_id,
        source.actor_id,
        source.source_sequence,
        source.delta,
        state.count,
        after,
        state.last_sequence,
        membership?.last_sequence ?? '0',
        membership?.active_epoch_id ?? null,
      ],
    );
    await tx.query(
      'UPDATE whaleu_post_hotness.subscription_states SET count=$2,last_sequence=$3,last_receipt_id=$4 WHERE post_id=$1',
      [source.post_id, after, source.source_sequence, id],
    );
    const active = source.transition === 'saved' ? source.epoch_id : null;
    if (membership)
      await tx.query(
        'UPDATE whaleu_post_hotness.subscription_memberships SET active_epoch_id=$3,last_sequence=$4,last_receipt_id=$5 WHERE post_id=$1 AND actor_id=$2',
        [source.post_id, source.actor_id, active, source.source_sequence, id],
      );
    else
      await tx.query(
        'INSERT INTO whaleu_post_hotness.subscription_memberships(post_id,actor_id,active_epoch_id,last_sequence,last_receipt_id) VALUES($1,$2,$3,$4,$5)',
        [source.post_id, source.actor_id, active, source.source_sequence, id],
      );
    await tx.query(
      "UPDATE whaleu_community.saved_obligations SET status='completed' WHERE id=$1 AND action='save_ranking' AND status='pending'",
      [id],
    );
    return 'applied';
  }
}
