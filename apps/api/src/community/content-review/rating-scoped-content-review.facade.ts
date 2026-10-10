import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { z } from 'zod';
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
import {
  ratingBindingMatches,
  ratingTargetDefinitionBindingMatches,
  validateRatingApprovalRow,
} from './rating-approval-validation.js';
import type {
  RatingApprovalRow,
  RatingApprovalBinding,
  RatingTargetDefinitionBinding,
} from './rating-approval-validation.js';
import type { AcceptedRatingApproval } from './rating-contracts.js';
import { canonicalAnyRatingTargetDefinition } from './rating-target-definition-contracts.js';
import type {
  AnyRatingTargetDefinitionDescriptor,
  RatingTargetDefinitionDescriptor,
} from './rating-target-definition-contracts.js';
import {
  canonicalRatingScopedEnvelope,
  canonicalRatingScopedTargetDefinition,
  canonicalRatingScopedCategorySource,
  ratingScopedApprovalDigest,
} from './rating-scoped-contracts.js';
import type {
  AcceptedRatingScopedApproval,
  RatingScopedEnvelope,
  RatingScopedContentEnvelope,
  RatingScopedTargetDefinitionDescriptor,
  RatingScopedCategorySourceDescriptor,
} from './rating-scoped-contracts.js';
import {
  ratingScopedContentBindingMatches,
  ratingScopedTargetDefinitionBindingMatches,
  ratingScopedCategorySourceBindingMatches,
  validateRatingScopedApprovalRow,
} from './rating-scoped-approval-validation.js';
import type {
  RatingScopedContentBinding,
  RatingScopedTargetDefinitionBinding,
  RatingScopedCategorySourceBinding,
} from './rating-scoped-approval-validation.js';

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
/** Fixed capacity for any number of chunked immutable ancestors/definitions.
 * Positive bindings are immutable and required in every successful result.
 * Unknown/absence is unavailable, never an authoritative denial or empty batch.
 * New local bindings do not invalidate earlier immutable current definitions. */
const proof: RequiredTransactionProof<{ fingerprint: string }> = {
  maximumFacts: 1,
  failureCode: 'CONTENT_REVIEW_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'CONTENT_REVIEW_UNAVAILABLE', async (read) => {
      await read.query(
        'LOCK TABLE whaleu_community.rating_review_epoch,whaleu_community.rating_approval_bindings,whaleu_community.rating_target_definition_bindings,whaleu_community.rating_scoped_content_bindings,whaleu_community.rating_scoped_target_definition_bindings,whaleu_community.rating_scoped_category_source_bindings IN SHARE MODE NOWAIT',
      );
      if (facts.length !== 1 || facts[0]!.fingerprint !== (await epoch(read)))
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
  account_exists: boolean;
  bound_time: boolean;
  binding:
    | RatingScopedContentBinding
    | RatingScopedTargetDefinitionBinding
    | RatingScopedCategorySourceBinding
    | null;
}
export type RatingScopedReviewDescriptor =
  | {
      kind: 'comment' | 'reply';
      subjectId: string;
      envelope: RatingScopedContentEnvelope;
    }
  | { kind: 'target'; definition: RatingScopedTargetDefinitionDescriptor }
  | { kind: 'category'; source: RatingScopedCategorySourceDescriptor };
const descriptorSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('target'), definition: z.unknown() }),
  z.strictObject({ kind: z.literal('category'), source: z.unknown() }),
  z.strictObject({
    kind: z.enum(['comment', 'reply']),
    subjectId: z.uuid().refine((value) => value === value.toLowerCase()),
    envelope: z.unknown(),
  }),
]);
function canonicalDescriptor(
  input: RatingScopedReviewDescriptor,
): RatingScopedReviewDescriptor {
  const descriptor = descriptorSchema.parse(input);
  if (descriptor.kind === 'target')
    return Object.freeze({
      kind: descriptor.kind,
      definition: canonicalRatingScopedTargetDefinition(descriptor.definition),
    });
  if (descriptor.kind === 'category')
    return Object.freeze({
      kind: descriptor.kind,
      source: canonicalRatingScopedCategorySource(descriptor.source),
    });
  const envelope = canonicalRatingScopedEnvelope(descriptor.envelope);
  if (
    (envelope.purpose !== 'publish_rating_comment_scoped' &&
      envelope.purpose !== 'publish_rating_reply_scoped') ||
    envelope.subjectId !== descriptor.subjectId ||
    (descriptor.kind === 'comment') !==
      (envelope.purpose === 'publish_rating_comment_scoped')
  )
    throw new Error('Invalid exact scoped content descriptor');
  return Object.freeze({
    kind: descriptor.kind,
    subjectId: descriptor.subjectId,
    envelope,
  });
}
function envelopeOf(input: RatingScopedReviewDescriptor): RatingScopedEnvelope {
  return input.kind === 'target'
    ? input.definition.envelope
    : input.kind === 'category'
      ? input.source.envelope
      : input.envelope;
}
@Injectable()
export class RatingScopedContentReviewFacade {
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
      'scoped-review-epoch',
      Object.freeze({ fingerprint }),
    );
    return fingerprint;
  }
  private validate(
    row: TimedRow | null,
    consume: boolean,
    tx: PoolClient,
  ): Decision<AcceptedRatingScopedApproval> {
    if (!row || row.exact_time !== true || !(row.now instanceof Date))
      return { kind: 'unavailable' };
    const result = validateRatingScopedApprovalRow(
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
    input: RatingScopedEnvelope,
    tx: PoolClient,
  ): Promise<AcceptedRatingScopedApproval> {
    await this.navigation(tx);
    let envelope: RatingScopedEnvelope;
    try {
      envelope = canonicalRatingScopedEnvelope(input);
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
      SELECT id FROM whaleu_community.rating_approval_decisions WHERE account_id=$1 AND operation=$2 AND envelope_version=5 AND digest=$3 ORDER BY evaluated_at DESC,id DESC LIMIT 1)
      SELECT ${approvalProjection},instant.now,${exactTime('true')} exact_time
      FROM candidate c JOIN whaleu_community.rating_approval_decisions d ON d.id=c.id
      LEFT JOIN whaleu_community.content_approval_policies p ON p.id=d.policy_revision_id
      LEFT JOIN whaleu_community.rating_approval_heads h ON h.decision_id=d.id
      LEFT JOIN whaleu_community.rating_approval_events e ON e.id=h.event_id AND e.decision_id=d.id CROSS JOIN instant`,
          [
            envelope.accountId,
            envelope.purpose,
            ratingScopedApprovalDigest(envelope),
          ],
        )
      ).rows[0] ?? null;
    const result =
      row && canonicalEqual(row.envelope, envelope)
        ? this.validate(row, true, tx)
        : { kind: 'unavailable' as const };
    if (result.kind === 'deny') throw new ApplicationError('CONTENT_REJECTED');
    if (result.kind !== 'allow')
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    const used = (
      await tx.query(
        `SELECT 1 FROM whaleu_community.rating_scoped_content_bindings WHERE decision_id=$1
      UNION ALL SELECT 1 FROM whaleu_community.rating_scoped_target_definition_bindings WHERE decision_id=$1
      UNION ALL SELECT 1 FROM whaleu_community.rating_scoped_category_source_bindings WHERE decision_id=$1 LIMIT 1`,
        [result.value.decisionId],
      )
    ).rows;
    if (used.length) throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    return result.value;
  }
  async bind(
    accepted: AcceptedRatingScopedApproval,
    input: RatingScopedReviewDescriptor,
    tx: PoolClient,
  ): Promise<void> {
    let descriptor: RatingScopedReviewDescriptor;
    try {
      descriptor = canonicalDescriptor(input);
    } catch {
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    }
    const envelope = envelopeOf(descriptor);
    if (accepted.version !== 5 || !canonicalEqual(accepted.envelope, envelope))
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    const fresh = await this.accepted(envelope, tx);
    if (
      fresh.decisionId !== accepted.decisionId ||
      fresh.digest !== accepted.digest
    )
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    const common = [
      fresh.decisionId,
      envelope.accountId,
      envelope.purpose,
      fresh.digest,
      canonicalJson(envelope),
    ];
    if (descriptor.kind === 'target') {
      const d = descriptor.definition;
      await tx.query(
        `INSERT INTO whaleu_community.rating_scoped_target_definition_bindings
        (decision_id,account_id,operation,digest,envelope,envelope_version,target_id,content_version,definition_revision,applied_target_revision,scope)
        VALUES($1,$2,$3,$4,$5::jsonb,5,$6,$7,$8,$9,$10::jsonb)`,
        [
          ...common,
          d.targetId,
          d.contentVersion,
          d.definitionRevision,
          d.appliedTargetRevision,
          canonicalJson(d.envelope.scope),
        ],
      );
    } else if (descriptor.kind === 'category') {
      const d = descriptor.source;
      await tx.query(
        `INSERT INTO whaleu_community.rating_scoped_category_source_bindings
        (decision_id,account_id,operation,digest,envelope,envelope_version,source_id,source_revision,category_id,issuance_id,issuance_digest)
        VALUES($1,$2,$3,$4,$5::jsonb,5,$6,$7,$8,$9,$10)`,
        [
          ...common,
          d.sourceId,
          d.sourceRevision,
          d.categoryId,
          d.envelope.issuanceId,
          d.envelope.issuanceDigest,
        ],
      );
    } else {
      await tx.query(
        `INSERT INTO whaleu_community.rating_scoped_content_bindings
        (decision_id,account_id,operation,digest,envelope,envelope_version,kind,subject_id,subject_revision,content_version,scope)
        VALUES($1,$2,$3,$4,$5::jsonb,5,$6,$7,$8,1,$9::jsonb)`,
        [
          ...common,
          descriptor.kind,
          descriptor.subjectId,
          descriptor.envelope.subjectRevision,
          canonicalJson(descriptor.envelope.scope),
        ],
      );
    }
  }
  /** Management batches reuse the exact v5 base/override envelope. Canonicalize
   * the whole vector before reading decisions or writing a binding; metadata-
   * only operations and override inheritance resets have no new body here. */
  async acceptedCategorySources(
    inputs: readonly RatingScopedCategorySourceDescriptor[],
    tx: PoolClient,
  ): Promise<readonly AcceptedRatingScopedApproval[]> {
    const sources = this.categorySources(inputs);
    const accepted: AcceptedRatingScopedApproval[] = [];
    for (const source of sources)
      accepted.push(await this.accepted(source.envelope, tx));
    if (
      new Set(accepted.map((entry) => entry.decisionId)).size !==
      accepted.length
    )
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    return Object.freeze(accepted);
  }
  async bindCategorySources(
    accepted: readonly AcceptedRatingScopedApproval[],
    inputs: readonly RatingScopedCategorySourceDescriptor[],
    tx: PoolClient,
  ): Promise<void> {
    const sources = this.categorySources(inputs);
    if (
      accepted.length !== sources.length ||
      new Set(accepted.map((entry) => entry.decisionId)).size !==
        accepted.length ||
      accepted.some(
        (entry, index) =>
          entry.version !== 5 ||
          !z.uuid().safeParse(entry.decisionId).success ||
          entry.decisionId !== entry.decisionId.toLowerCase() ||
          entry.digest !==
            ratingScopedApprovalDigest(sources[index]!.envelope) ||
          !canonicalEqual(entry.envelope, sources[index]!.envelope),
      )
    )
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    // bind reconsumes each exact current decision and registers its deadlines.
    // The caller's owner transaction commits the entire vector or rolls it back.
    for (const [index, source] of sources.entries())
      await this.bind(accepted[index]!, { kind: 'category', source }, tx);
  }
  private categorySources(
    inputs: readonly RatingScopedCategorySourceDescriptor[],
  ): readonly RatingScopedCategorySourceDescriptor[] {
    try {
      if (!Array.isArray(inputs) || inputs.length > 128)
        throw new Error('Category Review batch capacity');
      const sources = inputs.map(canonicalRatingScopedCategorySource);
      if (
        new Set(sources.map((source) => source.sourceId)).size !==
          sources.length ||
        new Set(sources.map((source) => source.envelope.accountId)).size > 1
      )
        throw new Error('Category Review batch identity');
      return Object.freeze(sources);
    } catch {
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    }
  }
  /** Fixed-size chunks may be repeated for an arbitrary complete source scan.
   * The Ratings owner, not Review, proves current-head and scan completeness. */
  async currentTargetDefinitions(
    inputs: readonly AnyRatingTargetDefinitionDescriptor[],
    tx: PoolClient,
  ): Promise<
    readonly Decision<AcceptedRatingApproval | AcceptedRatingScopedApproval>[]
  > {
    if (inputs.length > 128)
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    if (!inputs.length) return Object.freeze([]);
    await this.navigation(tx);
    let descriptors: AnyRatingTargetDefinitionDescriptor[];
    try {
      descriptors = inputs.map(canonicalAnyRatingTargetDefinition);
    } catch {
      return Object.freeze(
        inputs.map(() => ({ kind: 'unavailable' as const })),
      );
    }
    type Row = TimedRow & {
      ordinal: number;
      account_exists: boolean;
      bound_time: boolean;
      binding:
        | RatingApprovalBinding
        | RatingTargetDefinitionBinding
        | RatingScopedTargetDefinitionBinding
        | null;
    };
    const rows = (
      await tx.query<Row>(
        `WITH instant AS MATERIALIZED (SELECT clock_timestamp() now),wanted AS MATERIALIZED (
      SELECT * FROM unnest($1::uuid[],$2::integer[],$3::uuid[],$4::integer[],$5::uuid[]) WITH ORDINALITY w(id,content_version,revision,review_version,account_id,ordinal)),
      anchors AS MATERIALIZED (SELECT id FROM whaleu_identity.accounts WHERE id IN (SELECT account_id FROM wanted) ORDER BY id FOR SHARE)
      SELECT w.ordinal::integer ordinal,q.binding,a.id IS NOT NULL account_exists,
      coalesce(isfinite(q.bound_at) AND q.bound_at>=d.evaluated_at AND q.bound_at<=instant.now,false) bound_time,
      ${approvalProjection},instant.now,${exactTime('false')} exact_time
      FROM wanted w CROSS JOIN instant LEFT JOIN anchors a ON a.id=w.account_id
      LEFT JOIN LATERAL (
        SELECT to_jsonb(b) binding,b.decision_id,b.bound_at FROM whaleu_community.rating_approval_bindings b
          WHERE w.review_version=1 AND w.content_version=1 AND b.kind='target' AND b.subject_id=w.id AND b.content_version=1
        UNION ALL SELECT to_jsonb(b),b.decision_id,b.bound_at FROM whaleu_community.rating_target_definition_bindings b
          WHERE w.review_version=3 AND b.target_id=w.id AND b.content_version=w.content_version AND b.definition_revision=w.revision
        UNION ALL SELECT to_jsonb(b),b.decision_id,b.bound_at FROM whaleu_community.rating_scoped_target_definition_bindings b
          WHERE w.review_version=5 AND b.target_id=w.id AND b.content_version=w.content_version AND b.definition_revision=w.revision
      ) q ON true LEFT JOIN whaleu_community.rating_approval_decisions d ON d.id=q.decision_id
      LEFT JOIN whaleu_community.content_approval_policies p ON p.id=d.policy_revision_id
      LEFT JOIN whaleu_community.rating_approval_heads h ON h.decision_id=d.id
      LEFT JOIN whaleu_community.rating_approval_events e ON e.id=h.event_id AND e.decision_id=d.id ORDER BY w.ordinal`,
        [
          descriptors.map((d) => d.targetId),
          descriptors.map((d) => d.contentVersion),
          descriptors.map((d) => d.definitionRevision),
          descriptors.map((d) => d.envelope.version),
          descriptors.map((d) => d.envelope.accountId),
        ],
      )
    ).rows;
    if (rows.length !== descriptors.length)
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    return Object.freeze(
      rows.map(
        (
          row,
          index,
        ): Decision<AcceptedRatingApproval | AcceptedRatingScopedApproval> => {
          const descriptor = descriptors[index]!;
          const matches =
            row.binding &&
            (descriptor.envelope.version === 5
              ? ratingScopedTargetDefinitionBindingMatches(
                  row.binding as RatingScopedTargetDefinitionBinding,
                  descriptor as RatingScopedTargetDefinitionDescriptor,
                )
              : descriptor.contentVersion === 1
                ? ratingBindingMatches(
                    row.binding as RatingApprovalBinding,
                    'target',
                    descriptor.targetId,
                    descriptor.envelope,
                  )
                : ratingTargetDefinitionBindingMatches(
                    row.binding as RatingTargetDefinitionBinding,
                    descriptor as RatingTargetDefinitionDescriptor,
                  ));
          if (
            row.ordinal !== index + 1 ||
            row.account_exists !== true ||
            row.bound_time !== true ||
            !matches ||
            row.id !== row.binding!.decision_id ||
            row.digest !== row.binding!.digest ||
            !canonicalEqual(row.envelope, descriptor.envelope) ||
            row.exact_time !== true ||
            !(row.now instanceof Date)
          )
            return { kind: 'unavailable' };
          const result =
            descriptor.envelope.version === 5
              ? validateRatingScopedApprovalRow(row, false, row.now.getTime())
              : validateRatingApprovalRow(row, false, row.now.getTime());
          registerTransactionDeadline(
            tx,
            result.optionalUntil,
            'CONTENT_REVIEW_UNAVAILABLE',
          );
          return result.decision;
        },
      ),
    );
  }
  async currentContent(
    kind: 'comment' | 'reply',
    subjectId: string,
    envelope: RatingScopedContentEnvelope,
    tx: PoolClient,
  ) {
    return (await this.currentBatch([{ kind, subjectId, envelope }], tx))[0]!;
  }
  async currentTargetDefinition(
    definition: RatingScopedTargetDefinitionDescriptor,
    tx: PoolClient,
  ) {
    return (await this.currentBatch([{ kind: 'target', definition }], tx))[0]!;
  }
  async currentCategorySource(
    source: RatingScopedCategorySourceDescriptor,
    tx: PoolClient,
  ) {
    return (await this.currentBatch([{ kind: 'category', source }], tx))[0]!;
  }
  async currentBatch(
    inputs: readonly RatingScopedReviewDescriptor[],
    tx: PoolClient,
  ): Promise<readonly Decision<AcceptedRatingScopedApproval>[]> {
    if (inputs.length > 128)
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    if (!inputs.length) return Object.freeze([]);
    await this.navigation(tx);
    let descriptors: RatingScopedReviewDescriptor[];
    try {
      descriptors = inputs.map(canonicalDescriptor);
    } catch {
      return Object.freeze(
        inputs.map(() => ({ kind: 'unavailable' as const })),
      );
    }
    const keys = descriptors.map((d) => ({
      kind: d.kind,
      id:
        d.kind === 'target'
          ? d.definition.targetId
          : d.kind === 'category'
            ? d.source.sourceId
            : d.subjectId,
      revision:
        d.kind === 'target'
          ? d.definition.definitionRevision
          : d.kind === 'category'
            ? d.source.sourceRevision
            : d.envelope.subjectRevision,
      version: d.kind === 'target' ? d.definition.contentVersion : 1,
      account: envelopeOf(d).accountId,
    }));
    const rows = (
      await tx.query<BoundRow>(
        `WITH instant AS MATERIALIZED (SELECT clock_timestamp() now),wanted AS MATERIALIZED (
      SELECT * FROM unnest($1::text[],$2::uuid[],$3::uuid[],$4::integer[],$5::uuid[]) WITH ORDINALITY w(kind,id,revision,content_version,account_id,ordinal)),
      anchors AS MATERIALIZED (SELECT id FROM whaleu_identity.accounts WHERE id IN (SELECT account_id FROM wanted) ORDER BY id FOR SHARE)
      SELECT w.ordinal::integer ordinal,q.binding,a.id IS NOT NULL account_exists,
      coalesce(isfinite(q.bound_at) AND q.bound_at>=d.evaluated_at AND q.bound_at<=instant.now,false) bound_time,
      ${approvalProjection},instant.now,${exactTime('false')} exact_time
      FROM wanted w CROSS JOIN instant LEFT JOIN anchors a ON a.id=w.account_id
      LEFT JOIN LATERAL (
        SELECT to_jsonb(b) binding,b.decision_id,b.bound_at FROM whaleu_community.rating_scoped_content_bindings b WHERE w.kind IN ('comment','reply') AND b.kind=w.kind AND b.subject_id=w.id AND b.subject_revision=w.revision AND b.content_version=1
        UNION ALL SELECT to_jsonb(b),b.decision_id,b.bound_at FROM whaleu_community.rating_scoped_target_definition_bindings b WHERE w.kind='target' AND b.target_id=w.id AND b.content_version=w.content_version AND b.definition_revision=w.revision
        UNION ALL SELECT to_jsonb(b),b.decision_id,b.bound_at FROM whaleu_community.rating_scoped_category_source_bindings b WHERE w.kind='category' AND b.source_id=w.id AND b.source_revision=w.revision
      ) q ON true LEFT JOIN whaleu_community.rating_approval_decisions d ON d.id=q.decision_id
      LEFT JOIN whaleu_community.content_approval_policies p ON p.id=d.policy_revision_id
      LEFT JOIN whaleu_community.rating_approval_heads h ON h.decision_id=d.id
      LEFT JOIN whaleu_community.rating_approval_events e ON e.id=h.event_id AND e.decision_id=d.id ORDER BY w.ordinal`,
        [
          keys.map((k) => k.kind),
          keys.map((k) => k.id),
          keys.map((k) => k.revision),
          keys.map((k) => k.version),
          keys.map((k) => k.account),
        ],
      )
    ).rows;
    if (rows.length !== descriptors.length)
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    return Object.freeze(
      rows.map((row, index) => {
        const descriptor = descriptors[index]!;
        const matches =
          row.binding &&
          (descriptor.kind === 'target'
            ? ratingScopedTargetDefinitionBindingMatches(
                row.binding as RatingScopedTargetDefinitionBinding,
                descriptor.definition,
              )
            : descriptor.kind === 'category'
              ? ratingScopedCategorySourceBindingMatches(
                  row.binding as RatingScopedCategorySourceBinding,
                  descriptor.source,
                )
              : ratingScopedContentBindingMatches(
                  row.binding as RatingScopedContentBinding,
                  descriptor.kind,
                  descriptor.subjectId,
                  descriptor.envelope,
                ));
        return row.ordinal !== index + 1 ||
          row.account_exists !== true ||
          row.bound_time !== true ||
          !matches ||
          row.id !== row.binding!.decision_id ||
          row.digest !== row.binding!.digest ||
          !canonicalEqual(row.envelope, envelopeOf(descriptor))
          ? { kind: 'unavailable' as const }
          : this.validate(row, false, tx);
      }),
    );
  }
}
