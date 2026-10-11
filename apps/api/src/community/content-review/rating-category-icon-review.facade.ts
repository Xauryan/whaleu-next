import { randomUUID } from 'node:crypto';
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
  type RequiredTransactionProof,
} from '../../database/transaction-deadlines.js';
import { retainRatingReadBytes } from '../../ratings/target-cover-current.js';
import type { Decision } from '../community-policy.js';
import { approvalProjection } from './approval.repository.js';
import type { RatingApprovalRow } from './rating-approval-validation.js';
import { canonicalEqual, canonicalJson } from './contracts.js';
import {
  canonicalRatingCategoryIconDefinition,
  canonicalRatingCategoryIconEnvelope,
  ratingCategoryIconApprovalDigest,
  type AcceptedRatingCategoryIconApproval,
  type RatingCategoryIconDefinitionDescriptor,
  type RatingCategoryIconEnvelope,
} from './rating-category-icon-contracts.js';
import {
  ratingCategoryIconBindingMatches,
  validateRatingCategoryIconApprovalRow,
  type RatingCategoryIconReviewBinding,
} from './rating-category-icon-validation.js';

const unavailable = (): never => {
  throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
};
const contexts = new WeakMap<
  PoolClient,
  { epoch: object; fingerprint: string }
>();
async function externalEpoch(tx: PoolClient): Promise<string> {
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
    unavailable();
  return ownerFingerprint(rows);
}
/** Keep the pre-read external epoch, including across our own binding writes.
 * Never replace the older owner fact with a post-write observation. */
const authorityProof: RequiredTransactionProof<string> = {
  maximumFacts: 1,
  failureCode: 'CONTENT_REVIEW_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'CONTENT_REVIEW_UNAVAILABLE', async (read) => {
      await read.query(
        'LOCK TABLE whaleu_community.rating_review_epoch IN SHARE MODE NOWAIT',
      );
      if (facts.length !== 1 || facts[0] !== (await externalEpoch(read)))
        unavailable();
    }),
};
/** This independent mandatory fence runs after all deferred waits and our own
 * inserts. Successful current reads only use immutable positive bindings;
 * absence never grants a current definition. Consumption absence is rechecked
 * by the SQL binding guard. Thus local inserts need no epoch reset/refresh.
 * Only Review8 traffic registers this proof; frozen v1-v7 reads stay untouched. */
const bindingProof: RequiredTransactionProof<true> = {
  maximumFacts: 1,
  failureCode: 'CONTENT_REVIEW_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'CONTENT_REVIEW_UNAVAILABLE', async (read) => {
      if (facts.length !== 1 || facts[0] !== true) unavailable();
      await read.query(`LOCK TABLE whaleu_community.rating_approval_bindings,
      whaleu_community.rating_target_definition_bindings,
      whaleu_community.rating_category_base_bindings,
      whaleu_community.rating_scoped_content_bindings,
      whaleu_community.rating_scoped_target_definition_bindings,
      whaleu_community.rating_scoped_category_source_bindings,
      whaleu_community.rating_target_cover_definition_bindings,
      whaleu_community.rating_discussion_media_bindings,
      whaleu_ratings.category_icon_review_bindings IN SHARE MODE NOWAIT`);
    }),
};
const exactTime = (consume: boolean) =>
  `coalesce(isfinite(d.evaluated_at) AND d.evaluated_at<=instant.now AND isfinite(p.valid_from) AND p.valid_from<=d.evaluated_at AND (p.valid_until IS NULL OR (isfinite(p.valid_until) AND p.valid_until>instant.now)) AND isfinite(e.occurred_at) AND e.occurred_at>=d.evaluated_at AND e.occurred_at<=instant.now AND isfinite(d.consume_until) AND d.consume_until>d.evaluated_at AND (NOT ${consume} OR d.consume_until>instant.now) AND ((d.visibility_model='durable' AND d.visibility_until IS NULL) OR (d.visibility_model='until' AND isfinite(d.visibility_until) AND d.visibility_until>d.evaluated_at AND d.visibility_until>instant.now)),false)`;
interface TimedRow extends RatingApprovalRow {
  now: Date;
  exact_time: boolean;
}
interface BoundRow extends TimedRow {
  ordinal: number;
  binding: RatingCategoryIconReviewBinding | null;
  account_exists: boolean;
  bound_time: boolean;
}

/** A distinct, fail-closed Review8 consumer. No provider, issuer, implicit grant
 * or capability seed. Original Review5 source issuance remains independent. */
@Injectable()
export class RatingCategoryIconReviewFacade {
  private async navigation(tx: PoolClient): Promise<void> {
    const epoch = transactionReadEpoch(tx);
    if (!epoch) unavailable();
    enableRequiredTransactionProof(tx, authorityProof);
    enableRequiredTransactionProof(tx, bindingProof);
    if (contexts.get(tx)?.epoch !== epoch) {
      const fingerprint = await externalEpoch(tx);
      if (transactionReadEpoch(tx) !== epoch) unavailable();
      registerRequiredTransactionFact(
        tx,
        authorityProof,
        fingerprint,
        fingerprint,
      );
      contexts.set(tx, { epoch: epoch!, fingerprint });
    }
    registerRequiredTransactionFact(
      tx,
      bindingProof,
      'category-icon-review-bindings',
      true,
    );
  }
  private validate(
    row: TimedRow | undefined,
    consume: boolean,
    tx: PoolClient,
  ): Decision<AcceptedRatingCategoryIconApproval> {
    if (!row || row.exact_time !== true || !(row.now instanceof Date))
      return { kind: 'unavailable' };
    const result = validateRatingCategoryIconApprovalRow(
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
    raw: RatingCategoryIconEnvelope,
    tx: PoolClient,
  ): Promise<AcceptedRatingCategoryIconApproval> {
    let envelope: RatingCategoryIconEnvelope;
    try {
      envelope = canonicalRatingCategoryIconEnvelope(raw);
    } catch {
      return unavailable();
    }
    await this.navigation(tx);
    if (
      !(
        await tx.query(
          'SELECT id FROM whaleu_identity.accounts WHERE id=$1 FOR SHARE',
          [envelope.accountId],
        )
      ).rows.length
    )
      unavailable();
    const row = (
      await tx.query<TimedRow>(
        `
      WITH instant AS MATERIALIZED (SELECT clock_timestamp() now),candidate AS MATERIALIZED (
        SELECT id FROM whaleu_community.rating_approval_decisions
        WHERE account_id=$1 AND operation=$2 AND envelope_version=8 AND digest=$3 ORDER BY evaluated_at DESC,id DESC LIMIT 1),
      locked_head AS MATERIALIZED (SELECT h.* FROM whaleu_community.rating_approval_heads h JOIN candidate c ON c.id=h.decision_id ORDER BY h.decision_id FOR SHARE OF h)
      SELECT ${approvalProjection},instant.now,${exactTime(true)} exact_time
      FROM candidate c JOIN whaleu_community.rating_approval_decisions d ON d.id=c.id
      LEFT JOIN whaleu_community.content_approval_policies p ON p.id=d.policy_revision_id
      LEFT JOIN locked_head h ON h.decision_id=d.id
      LEFT JOIN whaleu_community.rating_approval_events e ON e.id=h.event_id AND e.decision_id=d.id CROSS JOIN instant`,
        [
          envelope.accountId,
          envelope.purpose,
          ratingCategoryIconApprovalDigest(envelope),
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
    if (decision.kind !== 'allow') return unavailable();
    if (
      (
        await tx.query(
          `SELECT 1 FROM whaleu_community.rating_approval_bindings WHERE decision_id=$1
      UNION ALL SELECT 1 FROM whaleu_community.rating_target_definition_bindings WHERE decision_id=$1
      UNION ALL SELECT 1 FROM whaleu_community.rating_category_base_bindings WHERE decision_id=$1
      UNION ALL SELECT 1 FROM whaleu_community.rating_scoped_content_bindings WHERE decision_id=$1
      UNION ALL SELECT 1 FROM whaleu_community.rating_scoped_target_definition_bindings WHERE decision_id=$1
      UNION ALL SELECT 1 FROM whaleu_community.rating_scoped_category_source_bindings WHERE decision_id=$1
      UNION ALL SELECT 1 FROM whaleu_community.rating_target_cover_definition_bindings WHERE decision_id=$1
      UNION ALL SELECT 1 FROM whaleu_community.rating_discussion_media_bindings WHERE decision_id=$1
      UNION ALL SELECT 1 FROM whaleu_ratings.category_icon_review_bindings WHERE decision_id=$1 LIMIT 1`,
          [decision.value.decisionId],
        )
      ).rows.length
    )
      unavailable();
    return decision.value;
  }
  async bind(
    accepted: AcceptedRatingCategoryIconApproval,
    raw: RatingCategoryIconDefinitionDescriptor,
    tx: PoolClient,
  ): Promise<RatingCategoryIconReviewBinding> {
    let definition: RatingCategoryIconDefinitionDescriptor;
    try {
      definition = canonicalRatingCategoryIconDefinition(raw);
    } catch {
      return unavailable();
    }
    if (
      accepted.version !== 8 ||
      !canonicalEqual(accepted.envelope, definition.envelope)
    )
      unavailable();
    const fresh = await this.accepted(definition.envelope, tx);
    if (
      accepted.decisionId !== fresh.decisionId ||
      accepted.digest !== fresh.digest
    )
      unavailable();
    const binding = (
      await tx.query<RatingCategoryIconReviewBinding>(
        `
      INSERT INTO whaleu_ratings.category_icon_review_bindings
      (id,definition_id,definition_digest,decision_id,account_id,request_id,approval_digest,envelope)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb) RETURNING *`,
        [
          randomUUID(),
          definition.definitionId,
          definition.definitionDigest,
          fresh.decisionId,
          fresh.envelope.accountId,
          fresh.envelope.clientRequestId,
          fresh.digest,
          canonicalJson(fresh.envelope),
        ],
      )
    ).rows[0];
    if (
      !binding ||
      !ratingCategoryIconBindingMatches(binding, definition) ||
      binding.decision_id !== fresh.decisionId
    )
      return unavailable();
    return Object.freeze(binding);
  }
  async current(
    raw: RatingCategoryIconDefinitionDescriptor,
    tx: PoolClient,
  ): Promise<Decision<AcceptedRatingCategoryIconApproval>> {
    return (await this.currentBatch([raw], tx))[0]!;
  }
  async currentBatch(
    raw: readonly RatingCategoryIconDefinitionDescriptor[],
    tx: PoolClient,
  ): Promise<readonly Decision<AcceptedRatingCategoryIconApproval>[]> {
    if (raw.length > 128) unavailable();
    if (!raw.length) return Object.freeze([]);
    let definitions: RatingCategoryIconDefinitionDescriptor[];
    try {
      definitions = raw.map(canonicalRatingCategoryIconDefinition);
    } catch {
      return Object.freeze(raw.map(() => ({ kind: 'unavailable' as const })));
    }
    await this.navigation(tx);
    const rows = (
      await tx.query<BoundRow>(
        `
      WITH instant AS MATERIALIZED (SELECT clock_timestamp() now),wanted AS MATERIALIZED (
        SELECT * FROM unnest($1::uuid[],$2::uuid[]) WITH ORDINALITY w(definition_id,account_id,ordinal)),
      anchors AS MATERIALIZED (SELECT id FROM whaleu_identity.accounts WHERE id IN (SELECT account_id FROM wanted) ORDER BY id FOR SHARE)
      SELECT w.ordinal::integer ordinal,to_jsonb(b) binding,a.id IS NOT NULL account_exists,
        coalesce(isfinite(b.bound_at) AND b.bound_at>=d.evaluated_at AND b.bound_at<=instant.now,false) bound_time,
        ${approvalProjection},instant.now,${exactTime(false)} exact_time
      FROM wanted w CROSS JOIN instant LEFT JOIN anchors a ON a.id=w.account_id
      LEFT JOIN whaleu_ratings.category_icon_review_bindings b ON b.definition_id=w.definition_id
      LEFT JOIN whaleu_community.rating_approval_decisions d ON d.id=b.decision_id
      LEFT JOIN whaleu_community.content_approval_policies p ON p.id=d.policy_revision_id
      LEFT JOIN whaleu_community.rating_approval_heads h ON h.decision_id=d.id
      LEFT JOIN whaleu_community.rating_approval_events e ON e.id=h.event_id AND e.decision_id=d.id ORDER BY w.ordinal`,
        [
          definitions.map((d) => d.definitionId),
          definitions.map((d) => d.envelope.accountId),
        ],
      )
    ).rows;
    retainRatingReadBytes(tx, rows);
    if (rows.length !== definitions.length) unavailable();
    return Object.freeze(
      rows.map((row, index) => {
        const definition = definitions[index]!;
        if (
          row.ordinal !== index + 1 ||
          row.account_exists !== true ||
          row.bound_time !== true ||
          !row.binding ||
          !ratingCategoryIconBindingMatches(row.binding, definition) ||
          row.id !== row.binding.decision_id ||
          row.digest !== row.binding.approval_digest ||
          !canonicalEqual(row.envelope, definition.envelope)
        )
          return { kind: 'unavailable' as const };
        return this.validate(row, false, tx);
      }),
    );
  }
}
