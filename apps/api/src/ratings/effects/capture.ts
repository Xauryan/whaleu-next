import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { ExperienceIngressService } from '../../experience/ingress.js';
import type { ExperienceEnqueueUnit } from '../../experience/ingress.js';
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
    const expected = (
      await tx.query<{
        beneficiary_id: string;
        action:
          'comment' | 'received_comment' | 'like_save' | 'received_like_save';
      }>(
        'SELECT * FROM whaleu_ratings.expected_reward_units($1) ORDER BY beneficiary_id,action',
        [event.id],
      )
    ).rows;
    const { enrollmentOrder } = await this.ingress.reserve(
      tx,
      expected.map((u) => u.beneficiary_id),
    );
    const groupId = randomUUID();
    await tx.query(
      `INSERT INTO whaleu_ratings.reward_groups(id,event_id,source_version,event_kind,target_id,root_id,reply_id,reply_to_id,actor_account_id,root_author_id,direct_reply_author_id,like_transition_id,subject_author_id,subject_author_mode,occurred_at,enrollment_order,expected_unit_count) SELECT $1,id,source_version,event_kind,target_id,root_id,reply_id,reply_to_id,actor_account_id,root_author_id,direct_reply_author_id,like_transition_id,subject_author_id,subject_author_mode,occurred_at,$3,expected_experience_units FROM whaleu_ratings.effect_events WHERE id=$2`,
      [groupId, event.id, enrollmentOrder],
    );
    const units: ExperienceEnqueueUnit[] = [];
    for (const e of expected) {
      const unitId = randomUUID();
      await tx.query(
        'INSERT INTO whaleu_ratings.reward_units(id,group_id,event_id,beneficiary_id,action,enrollment_order) VALUES($1,$2,$3,$4,$5,$6)',
        [
          unitId,
          groupId,
          event.id,
          e.beneficiary_id,
          e.action,
          enrollmentOrder,
        ],
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
