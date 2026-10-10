import { retainRatingReadBytes } from '../../ratings/target-cover-current.js';
import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import {
  registerTransactionDeadline,
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
  type RequiredTransactionProof,
} from '../../database/transaction-deadlines.js';
import { boundedOwnerProof } from '../../database/required-owner-proof.js';
import type { Decision } from '../community-policy.js';
import { approvalProjection } from './approval.repository.js';
import { canonicalEqual, canonicalJson } from './contracts.js';
import type { RatingApprovalRow } from './rating-approval-validation.js';
import { RatingScopedContentReviewFacade } from './rating-scoped-content-review.facade.js';
import {
  canonicalRatingDiscussionMediaEnvelope,
  ratingDiscussionMediaApprovalDigest,
  type RatingDiscussionMediaEnvelope,
  type AcceptedRatingDiscussionMediaApproval,
} from './rating-discussion-media-contracts.js';
import {
  ratingDiscussionMediaBindingMatches,
  validateRatingDiscussionMediaApprovalRow,
  type RatingDiscussionMediaBinding,
} from './rating-discussion-media-validation.js';
/** Only actual Review7 traffic touches this new immutable binding table. */
const discussionBindingProof: RequiredTransactionProof<true> = {
  maximumFacts: 1,
  failureCode: 'CONTENT_REVIEW_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'CONTENT_REVIEW_UNAVAILABLE', async (read) => {
      if (facts.length !== 1 || facts[0] !== true)
        throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
      await read.query(
        'LOCK TABLE whaleu_community.rating_discussion_media_bindings IN SHARE MODE NOWAIT',
      );
    }),
};
interface TimedRow extends RatingApprovalRow {
  now: Date;
  exact_time: boolean;
}
const exactTime = (consume: boolean) =>
  `coalesce(isfinite(d.evaluated_at) AND d.evaluated_at<=instant.now AND isfinite(p.valid_from) AND p.valid_from<=d.evaluated_at AND (p.valid_until IS NULL OR (isfinite(p.valid_until) AND p.valid_until>instant.now)) AND isfinite(e.occurred_at) AND e.occurred_at>=d.evaluated_at AND e.occurred_at<=instant.now AND isfinite(d.consume_until) AND d.consume_until>d.evaluated_at AND (NOT ${consume} OR d.consume_until>instant.now) AND ((d.visibility_model='durable' AND d.visibility_until IS NULL) OR (d.visibility_model='until' AND isfinite(d.visibility_until) AND d.visibility_until>d.evaluated_at AND d.visibility_until>instant.now)),false)`;
/** No issuer and no automatic decisions. The ordinary accepted Review policy,
 * latest head and final review epoch govern this distinct exact whole-set v7. */
@Injectable()
export class RatingDiscussionMediaReviewFacade {
  private readonly review = new RatingScopedContentReviewFacade();
  private async navigation(tx: PoolClient): Promise<void> {
    await this.review.navigation(tx);
    enableRequiredTransactionProof(tx, discussionBindingProof);
    registerRequiredTransactionFact(
      tx,
      discussionBindingProof,
      'discussion-review-bindings',
      true,
    );
  }

  private validate(
    row: TimedRow | undefined,
    consume: boolean,
    tx: PoolClient,
  ): Decision<AcceptedRatingDiscussionMediaApproval> {
    if (!row || row.exact_time !== true || !(row.now instanceof Date))
      return { kind: 'unavailable' };
    const result = validateRatingDiscussionMediaApprovalRow(
      row,
      consume,
      row.now.getTime(),
    );
    registerTransactionDeadline(
      tx,
      result.optionalUntil,
      'CONTENT_REVIEW_UNAVAILABLE',
    );
    return result.decision;
  }
  async accepted(
    raw: RatingDiscussionMediaEnvelope,
    tx: PoolClient,
  ): Promise<AcceptedRatingDiscussionMediaApproval> {
    await this.navigation(tx);
    const envelope = canonicalRatingDiscussionMediaEnvelope(raw);
    if (
      !(
        await tx.query(
          'SELECT id FROM whaleu_identity.accounts WHERE id=$1 FOR SHARE',
          [envelope.accountId],
        )
      ).rows.length
    )
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    const row = (
      await tx.query<TimedRow>(
        `WITH instant AS MATERIALIZED (SELECT clock_timestamp() now),candidate AS MATERIALIZED (
      SELECT id FROM whaleu_community.rating_approval_decisions WHERE account_id=$1 AND operation=$2 AND envelope_version=7 AND digest=$3 ORDER BY evaluated_at DESC,id DESC LIMIT 1),
      locked_head AS MATERIALIZED (SELECT h.* FROM whaleu_community.rating_approval_heads h JOIN candidate c ON c.id=h.decision_id ORDER BY h.decision_id FOR SHARE OF h)
      SELECT ${approvalProjection},instant.now,${exactTime(true)} exact_time FROM candidate c
      JOIN whaleu_community.rating_approval_decisions d ON d.id=c.id
      LEFT JOIN whaleu_community.content_approval_policies p ON p.id=d.policy_revision_id
      LEFT JOIN locked_head h ON h.decision_id=d.id
      LEFT JOIN whaleu_community.rating_approval_events e ON e.id=h.event_id AND e.decision_id=d.id CROSS JOIN instant`,
        [
          envelope.accountId,
          envelope.purpose,
          ratingDiscussionMediaApprovalDigest(envelope),
        ],
      )
    ).rows[0];
    retainRatingReadBytes(tx, row ?? null);
    const decision =
      row && canonicalEqual(row.envelope, envelope)
        ? this.validate(row, true, tx)
        : { kind: 'unavailable' as const };
    if (decision.kind === 'deny')
      throw new ApplicationError('CONTENT_REJECTED');
    if (decision.kind !== 'allow')
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    if (
      (
        await tx.query(
          'SELECT 1 FROM whaleu_community.rating_discussion_media_bindings WHERE decision_id=$1',
          [decision.value.decisionId],
        )
      ).rows.length
    )
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    return decision.value;
  }
  async bind(
    accepted: AcceptedRatingDiscussionMediaApproval,
    raw: RatingDiscussionMediaEnvelope,
    tx: PoolClient,
  ): Promise<void> {
    const envelope = canonicalRatingDiscussionMediaEnvelope(raw),
      fresh = await this.accepted(envelope, tx);
    if (
      accepted.version !== 7 ||
      accepted.decisionId !== fresh.decisionId ||
      accepted.digest !== fresh.digest ||
      !canonicalEqual(accepted.envelope, envelope)
    )
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    await tx.query(
      `INSERT INTO whaleu_community.rating_discussion_media_bindings
      (decision_id,account_id,operation,digest,envelope,envelope_version,kind,subject_id,subject_revision,content_version,scope,attachment_set_digest)
      VALUES($1,$2,$3,$4,$5::jsonb,7,$6,$7,$8,1,$9::jsonb,$10)`,
      [
        fresh.decisionId,
        envelope.accountId,
        envelope.purpose,
        fresh.digest,
        canonicalJson(envelope),
        envelope.purpose === 'publish_rating_comment_media_scoped'
          ? 'comment'
          : 'reply',
        envelope.subjectId,
        envelope.subjectRevision,
        canonicalJson(envelope.scope),
        envelope.attachmentSetDigest,
      ],
    );
  }
  async current(
    kind: 'comment' | 'reply',
    subjectId: string,
    raw: RatingDiscussionMediaEnvelope,
    tx: PoolClient,
  ): Promise<Decision<AcceptedRatingDiscussionMediaApproval>> {
    await this.navigation(tx);
    const envelope = canonicalRatingDiscussionMediaEnvelope(raw);
    const row = (
      await tx.query<
        TimedRow & {
          binding: RatingDiscussionMediaBinding;
          bound_time: boolean;
          account_exists: boolean;
        }
      >(
        `
      WITH instant AS MATERIALIZED (SELECT clock_timestamp() now)
      SELECT ${approvalProjection},instant.now,${exactTime(false)} exact_time,to_jsonb(b) binding,
        coalesce(isfinite(b.bound_at) AND b.bound_at>=d.evaluated_at AND b.bound_at<=instant.now,false) bound_time,
        EXISTS(SELECT 1 FROM whaleu_identity.accounts a WHERE a.id=b.account_id) account_exists
      FROM whaleu_community.rating_discussion_media_bindings b
      JOIN whaleu_community.rating_approval_decisions d ON d.id=b.decision_id
      LEFT JOIN whaleu_community.content_approval_policies p ON p.id=d.policy_revision_id
      LEFT JOIN whaleu_community.rating_approval_heads h ON h.decision_id=d.id
      LEFT JOIN whaleu_community.rating_approval_events e ON e.id=h.event_id AND e.decision_id=d.id CROSS JOIN instant
      WHERE b.kind=$1 AND b.subject_id=$2 AND b.content_version=1`,
        [kind, subjectId],
      )
    ).rows[0];
    retainRatingReadBytes(tx, row ?? null);
    if (
      !row ||
      row.bound_time !== true ||
      row.account_exists !== true ||
      !ratingDiscussionMediaBindingMatches(
        row.binding,
        kind,
        subjectId,
        envelope,
      ) ||
      row.id !== row.binding.decision_id ||
      !canonicalEqual(row.envelope, envelope)
    )
      return { kind: 'unavailable' };
    const decision = this.validate(row, false, tx);
    return decision;
  }
}
