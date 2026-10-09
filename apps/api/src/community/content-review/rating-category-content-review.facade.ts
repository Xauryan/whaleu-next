import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import {
  boundedOwnerProof,
  ownerFingerprint,
} from '../../database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
  registerTransactionDeadline,
  transactionReadEpoch,
} from '../../database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../../database/transaction-deadlines.js';
import type { Decision } from '../community-policy.js';
import { approvalProjection } from './approval.repository.js';
import { canonicalEqual, canonicalJson } from './contracts.js';
import type { RatingApprovalRow } from './rating-approval-validation.js';
import {
  canonicalRatingCategoryBase,
  canonicalRatingCategoryEnvelope,
  ratingCategoryApprovalDigest,
} from './rating-category-contracts.js';
import type {
  AcceptedRatingCategoryApproval,
  RatingCategoryBaseDescriptor,
  RatingCategoryEnvelope,
} from './rating-category-contracts.js';
import {
  ratingCategoryBaseBindingMatches,
  validateRatingCategoryApprovalRow,
} from './rating-category-approval-validation.js';
import type { RatingCategoryBaseBinding } from './rating-category-approval-validation.js';

const contexts = new WeakMap<
  PoolClient,
  { readEpoch: object; fingerprint: string }
>();
async function epoch(tx: PoolClient): Promise<string> {
  const rows = (
    await tx.query<{ singleton: boolean; version: number; epoch: string }>(
      'SELECT singleton,version,epoch::text FROM whaleu_community.rating_review_epoch',
    )
  ).rows;
  if (
    rows.length !== 1 ||
    rows[0]?.singleton !== true ||
    rows[0].version !== 1 ||
    !/^(0|[1-9][0-9]*)$/.test(rows[0].epoch) ||
    BigInt(rows[0].epoch) > 9223372036854775807n
  )
    throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
  return ownerFingerprint(rows);
}
/** One monotonic Review proof for all category ancestors and complete random
 * paths. Successful reads require existing immutable exact bindings; absence
 * is unknown and never emitted as an empty/partial successful projection.
 * Bindings cannot change, while every decision/policy/event/head change takes
 * the Review epoch. Our own new bindings do not invalidate earlier ancestors.
 * Retained facts survive an owner's savepoint rollback; only the cache lifetime
 * is read-epoch scoped, so skipping an unavailable notice cannot erase proof
 * for an earlier successful notice on the same page. */
const proof: RequiredTransactionProof<{ fingerprint: string }> = {
  maximumFacts: 1,
  failureCode: 'CONTENT_REVIEW_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'CONTENT_REVIEW_UNAVAILABLE', async (read) => {
      await read.query(
        'LOCK TABLE whaleu_community.rating_review_epoch,whaleu_community.rating_category_base_bindings IN SHARE MODE NOWAIT',
      );
      const current = await epoch(read);
      if (facts.length !== 1 || facts[0]!.fingerprint !== current)
        throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    }),
};
const exactTime = (consume: string) =>
  `coalesce(isfinite(d.evaluated_at) AND d.evaluated_at<=instant.now AND isfinite(p.valid_from) AND p.valid_from<=d.evaluated_at AND (p.valid_until IS NULL OR (isfinite(p.valid_until) AND p.valid_until>instant.now)) AND isfinite(e.occurred_at) AND e.occurred_at>=d.evaluated_at AND e.occurred_at<=instant.now AND isfinite(d.consume_until) AND d.consume_until>d.evaluated_at AND (NOT ${consume} OR d.consume_until>instant.now) AND ((d.visibility_model='durable' AND d.visibility_until IS NULL) OR (d.visibility_model='until' AND isfinite(d.visibility_until) AND d.visibility_until>d.evaluated_at AND d.visibility_until>instant.now)),false)`;
interface TimedRow extends RatingApprovalRow {
  now: Date;
  exact_time: boolean;
}
interface BoundRow extends TimedRow {
  ordinal: number;
  binding: RatingCategoryBaseBinding | null;
  account_exists: boolean;
  bound_time: boolean;
}
@Injectable()
export class RatingCategoryContentReviewFacade {
  async navigation(tx: PoolClient): Promise<string> {
    const readEpoch = transactionReadEpoch(tx);
    if (!readEpoch) throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    const existing = contexts.get(tx);
    if (existing?.readEpoch === readEpoch) return existing.fingerprint;
    enableRequiredTransactionProof(tx, proof);
    const fingerprint = await epoch(tx);
    if (transactionReadEpoch(tx) !== readEpoch)
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    contexts.set(tx, { readEpoch, fingerprint });
    registerRequiredTransactionFact(
      tx,
      proof,
      'category-review-epoch',
      Object.freeze({ fingerprint }),
    );
    return fingerprint;
  }
  private validate(
    row: TimedRow | null,
    consume: boolean,
    tx: PoolClient,
  ): Decision<AcceptedRatingCategoryApproval> {
    if (!row || row.exact_time !== true || !(row.now instanceof Date))
      return { kind: 'unavailable' };
    const result = validateRatingCategoryApprovalRow(
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
    input: RatingCategoryEnvelope,
    tx: PoolClient,
  ): Promise<AcceptedRatingCategoryApproval> {
    await this.navigation(tx);
    let envelope: RatingCategoryEnvelope;
    try {
      envelope = canonicalRatingCategoryEnvelope(input);
    } catch {
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    }
    if (
      !(
        await tx.query(
          'SELECT id FROM whaleu_identity.accounts WHERE id=$1 FOR SHARE',
          [envelope.accountId],
        )
      ).rows[0]
    )
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    const row =
      (
        await tx.query<TimedRow>(
          `WITH instant AS MATERIALIZED (SELECT clock_timestamp() now),candidate AS MATERIALIZED (
      SELECT id FROM whaleu_community.rating_approval_decisions WHERE account_id=$1 AND operation='publish_rating_categories' AND envelope_version=4 AND digest=$2 ORDER BY evaluated_at DESC,id DESC LIMIT 1)
      SELECT ${approvalProjection},instant.now,${exactTime('true')} exact_time
      FROM candidate c JOIN whaleu_community.rating_approval_decisions d ON d.id=c.id
      LEFT JOIN whaleu_community.content_approval_policies p ON p.id=d.policy_revision_id
      LEFT JOIN whaleu_community.rating_approval_heads h ON h.decision_id=d.id
      LEFT JOIN whaleu_community.rating_approval_events e ON e.id=h.event_id AND e.decision_id=d.id CROSS JOIN instant`,
          [envelope.accountId, ratingCategoryApprovalDigest(envelope)],
        )
      ).rows[0] ?? null;
    const result =
      row && canonicalEqual(row.envelope, envelope)
        ? this.validate(row, true, tx)
        : { kind: 'unavailable' as const };
    if (result.kind === 'deny') throw new ApplicationError('CONTENT_REJECTED');
    if (result.kind !== 'allow')
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    if (
      (
        await tx.query(
          'SELECT 1 FROM whaleu_community.rating_category_base_bindings WHERE decision_id=$1 LIMIT 1',
          [result.value.decisionId],
        )
      ).rows.length
    )
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    return result.value;
  }
  async bind(
    accepted: AcceptedRatingCategoryApproval,
    input: RatingCategoryEnvelope,
    tx: PoolClient,
  ): Promise<void> {
    const envelope = canonicalRatingCategoryEnvelope(input);
    if (accepted.version !== 4 || !canonicalEqual(accepted.envelope, envelope))
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    const fresh = await this.accepted(envelope, tx);
    if (
      fresh.decisionId !== accepted.decisionId ||
      fresh.digest !== accepted.digest
    )
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    await tx.query(
      `INSERT INTO whaleu_community.rating_category_base_bindings(category_id,base_revision,release_id,decision_id,account_id,operation,envelope_version,digest,envelope,scope)
      SELECT n.id,n.revision,$3,$4,$5,'publish_rating_categories',4,$6,$7::jsonb,$8::jsonb FROM unnest($1::uuid[],$2::uuid[]) n(id,revision)`,
      [
        envelope.categories.map((node) => node.id),
        envelope.categories.map((node) => node.revision),
        envelope.releaseId,
        fresh.decisionId,
        envelope.accountId,
        fresh.digest,
        canonicalJson(envelope),
        canonicalJson(envelope.scope),
      ],
    );
  }
  async current(
    input: RatingCategoryBaseDescriptor,
    tx: PoolClient,
  ): Promise<Decision<AcceptedRatingCategoryApproval>> {
    return (await this.currentBatch([input], tx))[0]!;
  }
  async currentBatch(
    inputs: readonly RatingCategoryBaseDescriptor[],
    tx: PoolClient,
  ): Promise<readonly Decision<AcceptedRatingCategoryApproval>[]> {
    if (inputs.length > 512)
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    if (!inputs.length) return Object.freeze([]);
    await this.navigation(tx);
    let descriptors: RatingCategoryBaseDescriptor[];
    try {
      descriptors = inputs.map(canonicalRatingCategoryBase);
    } catch {
      return Object.freeze(
        inputs.map(() => ({ kind: 'unavailable' as const })),
      );
    }
    const rows = (
      await tx.query<BoundRow>(
        `WITH instant AS MATERIALIZED (SELECT clock_timestamp() now),wanted AS (
      SELECT * FROM unnest($1::uuid[],$2::uuid[]) WITH ORDINALITY w(category_id,base_revision,ordinal))
      SELECT w.ordinal::integer ordinal,to_jsonb(b) binding,a.id IS NOT NULL account_exists,
      coalesce(isfinite(b.bound_at) AND b.bound_at>=d.evaluated_at AND b.bound_at<=instant.now,false) bound_time,
      ${approvalProjection},instant.now,${exactTime('false')} exact_time
      FROM wanted w CROSS JOIN instant
      LEFT JOIN whaleu_community.rating_category_base_bindings b ON b.category_id=w.category_id AND b.base_revision=w.base_revision
      LEFT JOIN whaleu_community.rating_approval_decisions d ON d.id=b.decision_id
      LEFT JOIN whaleu_identity.accounts a ON a.id=d.account_id
      LEFT JOIN whaleu_community.content_approval_policies p ON p.id=d.policy_revision_id
      LEFT JOIN whaleu_community.rating_approval_heads h ON h.decision_id=d.id
      LEFT JOIN whaleu_community.rating_approval_events e ON e.id=h.event_id AND e.decision_id=d.id ORDER BY w.ordinal`,
        [
          descriptors.map((item) => item.categoryId),
          descriptors.map((item) => item.baseRevision),
        ],
      )
    ).rows;
    if (rows.length !== descriptors.length)
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    return Object.freeze(
      rows.map((row, index) =>
        row.ordinal !== index + 1 ||
        row.account_exists !== true ||
        row.bound_time !== true ||
        !row.binding ||
        !ratingCategoryBaseBindingMatches(row.binding, descriptors[index]!) ||
        row.id !== row.binding.decision_id ||
        row.digest !== row.binding.digest ||
        !canonicalEqual(row.envelope, descriptors[index]!.envelope)
          ? { kind: 'unavailable' as const }
          : this.validate(row, false, tx),
      ),
    );
  }
}
