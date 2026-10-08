import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { CommentComponentRepository } from './repository.js';
import type {
  CommentCounts,
  CommentResult,
  CommentSource,
  CommentState,
  CommentContribution,
  CommentMembership,
} from './contracts.js';
/** Exact retained contribution and actor cardinality, never current visibility. */
export function commentAfterCounts(
  source: CommentSource,
  state: CommentState,
  contribution: CommentContribution | null,
  membership: CommentMembership | null,
  ownerId: string,
): CommentCounts & { active_count: string; eligible: boolean } {
  const sequence = BigInt(source.source_sequence);
  if (
    sequence <= BigInt(state.last_sequence) ||
    sequence <= BigInt(contribution?.last_sequence ?? '0') ||
    sequence <= BigInt(membership?.last_sequence ?? '0')
  )
    throw new Error('Invalid comment causal position');
  if (
    (source.kind !== 'root' && source.kind !== 'reply') ||
    (source.kind === 'root') !== (source.root_id === null)
  )
    throw new Error('Invalid comment content identity');
  const eligible = source.actor_id !== ownerId;
  if (source.transition === 'created') {
    if (
      source.delta !== 1 ||
      source.positive_source_id !== null ||
      contribution
    )
      throw new Error('Invalid positive comment contribution');
  } else if (
    source.transition !== 'deleted' ||
    source.delta !== -1 ||
    !contribution?.active ||
    contribution.actor_id !== source.actor_id ||
    contribution.root_id !== source.root_id ||
    contribution.eligible !== eligible ||
    contribution.positive_source_id !== source.positive_source_id
  ) {
    throw new Error('Invalid negative comment contribution');
  }
  const beforeActor = BigInt(membership?.active_count ?? '0');
  const delta = BigInt(source.delta),
    afterActor = beforeActor + delta;
  const root = BigInt(state.root_count) + (source.kind === 'root' ? delta : 0n);
  const reply =
    BigInt(state.reply_count) + (source.kind === 'reply' ? delta : 0n);
  const eligibleCount = BigInt(state.eligible_count) + (eligible ? delta : 0n);
  const unique =
    BigInt(state.unique_actor_count) +
    (eligible ? (beforeActor === 0n ? 1n : afterActor === 0n ? -1n : 0n) : 0n);
  if (
    beforeActor < 0n ||
    afterActor < 0n ||
    root < 0n ||
    reply < 0n ||
    eligibleCount < 0n ||
    unique < 0n ||
    eligibleCount > root + reply ||
    unique > eligibleCount
  )
    throw new Error('Invalid comment cardinality');
  return {
    root_count: root.toString(),
    reply_count: reply.toString(),
    eligible_count: eligibleCount.toString(),
    unique_actor_count: unique.toString(),
    active_count: afterActor.toString(),
    eligible,
  };
}
@Injectable()
export class CommentComponentSettlement {
  constructor(
    @Inject(CommentComponentRepository)
    private readonly records: CommentComponentRepository,
  ) {}
  async process(
    id: string,
    tx: PoolClient,
    apply: boolean,
  ): Promise<CommentResult> {
    let source = await this.records.reference(id, tx);
    if (!source) return 'missing';
    if (apply) {
      await this.records.lockPost(source.post_id, tx);
      source = await this.records.reference(id, tx);
      if (!source) return 'sourceUnavailable';
    }
    const owner = await this.records.owner(source.post_id, tx);
    if (!owner) return 'blockedBaseline';
    const state = await this.records.state(source.post_id, tx, apply);
    if (!state) throw new Error('Known comment baseline without state');
    // Replays use immutable proof before evaluating advanced mutable state.
    if (await this.records.receipt(source, tx)) return 'alreadyCompleted';
    if (
      (await this.records.first(source.post_id, tx)) !== source.source_sequence
    )
      return 'blockedPredecessor';
    const contribution = await this.records.contribution(source, tx, apply);
    const membership = await this.records.membership(
      source.post_id,
      source.actor_id,
      tx,
      apply,
    );
    const after = commentAfterCounts(
      source,
      state,
      contribution,
      membership,
      owner,
    );
    if (!apply) return 'pending';
    await tx.query(
      `INSERT INTO whaleu_post_hotness.comment_receipts(source_id,post_id,actor_id,kind,content_id,root_id,transition,delta,source_sequence,positive_source_id,eligible,before_root_count,before_reply_count,before_eligible_count,before_unique_actor_count,after_root_count,after_reply_count,after_eligible_count,after_unique_actor_count,previous_state_sequence,previous_contribution_sequence,previous_contribution_active,previous_membership_sequence,before_actor_count,after_actor_count)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)`,
      [
        id,
        source.post_id,
        source.actor_id,
        source.kind,
        source.content_id,
        source.root_id,
        source.transition,
        source.delta,
        source.source_sequence,
        source.positive_source_id,
        after.eligible,
        state.root_count,
        state.reply_count,
        state.eligible_count,
        state.unique_actor_count,
        after.root_count,
        after.reply_count,
        after.eligible_count,
        after.unique_actor_count,
        state.last_sequence,
        contribution?.last_sequence ?? '0',
        contribution?.active ?? null,
        membership?.last_sequence ?? '0',
        membership?.active_count ?? '0',
        after.active_count,
      ],
    );
    await tx.query(
      'UPDATE whaleu_post_hotness.comment_states SET root_count=$2,reply_count=$3,eligible_count=$4,unique_actor_count=$5,last_sequence=$6,last_receipt_id=$7 WHERE post_id=$1',
      [
        source.post_id,
        after.root_count,
        after.reply_count,
        after.eligible_count,
        after.unique_actor_count,
        source.source_sequence,
        id,
      ],
    );
    if (contribution) {
      await tx.query(
        'UPDATE whaleu_post_hotness.comment_contributions SET active=false,last_sequence=$4,last_receipt_id=$5 WHERE post_id=$1 AND kind=$2 AND content_id=$3',
        [
          source.post_id,
          source.kind,
          source.content_id,
          source.source_sequence,
          id,
        ],
      );
    } else {
      await tx.query(
        'INSERT INTO whaleu_post_hotness.comment_contributions(post_id,kind,content_id,root_id,actor_id,eligible,active,positive_source_id,last_sequence,last_receipt_id) VALUES($1,$2,$3,$4,$5,$6,true,$7,$8,$7)',
        [
          source.post_id,
          source.kind,
          source.content_id,
          source.root_id,
          source.actor_id,
          after.eligible,
          id,
          source.source_sequence,
        ],
      );
    }
    if (membership) {
      await tx.query(
        'UPDATE whaleu_post_hotness.comment_memberships SET active_count=$3,last_sequence=$4,last_receipt_id=$5 WHERE post_id=$1 AND actor_id=$2',
        [
          source.post_id,
          source.actor_id,
          after.active_count,
          source.source_sequence,
          id,
        ],
      );
    } else {
      await tx.query(
        'INSERT INTO whaleu_post_hotness.comment_memberships(post_id,actor_id,active_count,last_sequence,last_receipt_id) VALUES($1,$2,$3,$4,$5)',
        [
          source.post_id,
          source.actor_id,
          after.active_count,
          source.source_sequence,
          id,
        ],
      );
    }
    return 'applied';
  }
}
