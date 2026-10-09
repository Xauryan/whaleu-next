import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { ExperienceIngressService } from '../../experience/ingress.js';
import type { ExperienceEnqueueUnit } from '../../experience/ingress.js';
export interface RatingSubscriptionTransitionSource {
  id: string;
  target_id: string;
  account_id: string;
  request_id: string;
  delta: 1 | -1;
  target_order: string;
  occurred_at: string;
}

/** Called after every content/review operation but before its minimal receipt.
 * Source facts and canonical units are SQL-owned, never supplied by the client. */
@Injectable()
export class RatingEffectsCapture {
  constructor(
    @Inject(ExperienceIngressService)
    private readonly ingress: ExperienceIngressService,
  ) {}
  async captureCreated(actor: string, requestId: string, tx: PoolClient) {
    return this.capture(actor, requestId, 'created', tx);
  }

  /** A true positive membership transition is a new reward opportunity.
   * Unlike, noop and receipt replay must never call this entry point. */
  async captureLiked(actor: string, requestId: string, tx: PoolClient) {
    return this.capture(actor, requestId, 'liked', tx);
  }

  /** Both directions must have an exact fresh SQL-owned effect. Only a new
   * subscription epoch enrolls the actor in the shared like/save quota pool. */
  async captureSubscription(
    tx: PoolClient,
    transition: RatingSubscriptionTransitionSource,
  ): Promise<void> {
    if (transition.delta !== 1 && transition.delta !== -1)
      throw new Error('Invalid rating subscription transition');
    const event = (
      await tx.query<{ id: string }>(
        `SELECT e.id FROM whaleu_ratings.effect_events e
         JOIN whaleu_ratings.subscription_transitions t ON t.id=e.subscription_transition_id
         WHERE e.subscription_transition_id=$1 AND e.target_id=$2
          AND e.actor_account_id=$3 AND e.request_id=$4
          AND t.delta=$5 AND t.target_order=$6 AND e.occurred_at=$7::timestamptz
          AND (e.target_id,e.actor_account_id,e.request_id,e.occurred_at,e.mutation_transaction)
            =(t.target_id,t.account_id,t.request_id,t.occurred_at,t.mutation_transaction)
          AND e.mutation_transaction=pg_current_xact_id()
          AND e.source_version=3 AND e.rule_version='rating-subscriptions-v1'
          AND e.event_kind=CASE WHEN $5=1 THEN 'target_subscribed' ELSE 'target_unsubscribed' END
          AND e.expected_experience_units=CASE WHEN $5=1 THEN 1 ELSE 0 END
          AND e.expected_direct_notice_obligations=0
          AND e.root_id IS NULL AND e.root_author_id IS NULL AND e.author_mode IS NULL
          AND e.reply_id IS NULL AND e.reply_to_id IS NULL AND e.direct_reply_author_id IS NULL
          AND e.comment_transition_id IS NULL AND e.reply_transition_id IS NULL
          AND e.like_transition_id IS NULL AND e.subject_author_id IS NULL AND e.subject_author_mode IS NULL`,
        [
          transition.id,
          transition.target_id,
          transition.account_id,
          transition.request_id,
          transition.delta,
          transition.target_order,
          transition.occurred_at,
        ],
      )
    ).rows[0];
    if (!event) throw new Error('Fresh rating subscription source is absent');
    if (transition.delta === -1) return;
    return this.captureEvent(event.id, tx, transition.account_id);
  }

  private async capture(
    actor: string,
    requestId: string,
    kind: 'created' | 'liked',
    tx: PoolClient,
  ) {
    const branch =
      kind === 'created'
        ? "source_version=1 AND rule_version='rating-effects-v1' AND event_kind IN ('root_created','reply_created')"
        : "source_version=2 AND rule_version='rating-likes-v1' AND event_kind='content_liked'";
    const event = (
      await tx.query<{ id: string }>(
        `SELECT id FROM whaleu_ratings.effect_events WHERE actor_account_id=$1 AND request_id=$2 AND mutation_transaction=pg_current_xact_id() AND ${branch}`,
        [actor, requestId],
      )
    ).rows[0];
    if (!event) throw new Error('Fresh rating source is absent');
    return this.captureEvent(event.id, tx);
  }

  private async captureEvent(
    eventId: string,
    tx: PoolClient,
    subscriptionActor?: string,
  ): Promise<void> {
    const expected = (
      await tx.query<{
        beneficiary_id: string;
        action:
          'comment' | 'received_comment' | 'like_save' | 'received_like_save';
      }>(
        'SELECT * FROM whaleu_ratings.expected_reward_units($1) ORDER BY beneficiary_id,action',
        [eventId],
      )
    ).rows;
    if (
      subscriptionActor !== undefined &&
      (expected.length !== 1 ||
        expected[0]!.beneficiary_id !== subscriptionActor ||
        expected[0]!.action !== 'like_save')
    )
      throw new Error('Rating subscription reward source does not match');
    const { enrollmentOrder } = await this.ingress.reserve(
      tx,
      expected.map((u) => u.beneficiary_id),
    );
    const groupId = randomUUID();
    await tx.query(
      `INSERT INTO whaleu_ratings.reward_groups(id,event_id,source_version,event_kind,target_id,root_id,reply_id,reply_to_id,actor_account_id,root_author_id,direct_reply_author_id,like_transition_id,subject_author_id,subject_author_mode,subscription_transition_id,occurred_at,enrollment_order,expected_unit_count) SELECT $1,id,source_version,event_kind,target_id,root_id,reply_id,reply_to_id,actor_account_id,root_author_id,direct_reply_author_id,like_transition_id,subject_author_id,subject_author_mode,subscription_transition_id,occurred_at,$3,expected_experience_units FROM whaleu_ratings.effect_events WHERE id=$2`,
      [groupId, eventId, enrollmentOrder],
    );
    const units: ExperienceEnqueueUnit[] = [];
    for (const e of expected) {
      const unitId = randomUUID();
      await tx.query(
        'INSERT INTO whaleu_ratings.reward_units(id,group_id,event_id,beneficiary_id,action,enrollment_order) VALUES($1,$2,$3,$4,$5,$6)',
        [unitId, groupId, eventId, e.beneficiary_id, e.action, enrollmentOrder],
      );
      units.push({
        unitId,
        groupId,
        beneficiaryId: e.beneficiary_id,
        action: e.action,
        enrollmentOrder,
      });
    }
    await this.ingress.enqueue(tx, units);
  }
}
