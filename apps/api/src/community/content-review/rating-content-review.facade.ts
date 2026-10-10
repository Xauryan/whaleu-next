import { RatingDiscussionMediaReviewFacade } from './rating-discussion-media-review.facade.js';
import type {
  RatingDiscussionMediaEnvelope,
  AcceptedRatingDiscussionMediaApproval,
} from './rating-discussion-media-contracts.js';
import { currentRatingTargetCovers } from '../../ratings/target-cover-current.js';
import type { AcceptedRatingTargetCoverApproval } from './rating-target-cover-contracts.js';
import { Injectable } from '@nestjs/common';
import { RatingScopedContentReviewFacade } from './rating-scoped-content-review.facade.js';
import type {
  AcceptedRatingScopedApproval,
  RatingScopedTargetDefinitionDescriptor,
  RatingScopedTargetEnvelope,
  RatingScopedContentEnvelope,
} from './rating-scoped-contracts.js';
import type { AnyRatingTargetDefinitionDescriptor } from './rating-target-definition-contracts.js';
import { z } from 'zod';
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
import { assertRatingCompletePoolBatch } from '../../ratings/random/complete-pool.repository.js';
import type { RatingCompletePoolBatch } from '../../ratings/random/complete-pool.repository.js';
import { approvalProjection } from './approval.repository.js';
import { canonicalEqual, canonicalJson } from './contracts.js';
import {
  canonicalRatingEnvelope,
  ratingApprovalDigest,
  ratingOperation,
} from './rating-contracts.js';
import type {
  AcceptedRatingApproval,
  RatingContentEnvelope,
  RatingContentKind,
} from './rating-contracts.js';
import {
  ratingBindingMatches,
  ratingTargetDefinitionBindingMatches,
  validateRatingApprovalRow,
} from './rating-approval-validation.js';
import type {
  RatingApprovalBinding,
  RatingApprovalRow,
  RatingTargetDefinitionBinding,
} from './rating-approval-validation.js';
import {
  canonicalAnyRatingTargetDefinition,
  canonicalRatingTargetDefinition,
} from './rating-target-definition-contracts.js';
import type { RatingTargetDefinitionDescriptor } from './rating-target-definition-contracts.js';
type Fact =
  | { type: 'epoch'; fingerprint: string }
  | { type: 'time'; id: string; consume: boolean; exact: boolean }
  | {
      type: 'binding';
      kind: RatingContentKind;
      id: string;
      decisionId: string | null;
      digest: string | null;
    }
  | {
      type: 'target-definition-binding';
      id: string;
      contentVersion: number;
      definitionRevision: string;
      decisionId: string | null;
      digest: string | null;
    };
interface TimedRow extends RatingApprovalRow {
  exact_time: boolean;
  now: Date;
}
interface TargetEligibilityRow extends TimedRow {
  ordinal: number;
  binding: RatingApprovalBinding | RatingTargetDefinitionBinding | null;
  account_exists: boolean;
}
declare const targetEligibilityBrand: unique symbol;
export interface RatingTargetEligibilityContext {
  readonly [targetEligibilityBrand]: true;
}
interface TargetEligibilityContext {
  tx: PoolClient;
  readEpoch: object;
  fingerprint: string;
  bindingFingerprint: string;
  done: boolean;
  busy: boolean;
  complete: boolean;
  streamKey: object | null;
  nextOrdinal: number;
  until: number | null;
  validatedCount: number;
  allowedCount: number;
}
const targetEligibilityContexts = new WeakMap<
  object,
  TargetEligibilityContext
>();
let targetEligibilitySerial = 0;
function targetEligibilityContext(handle: object, tx: PoolClient) {
  const context = targetEligibilityContexts.get(handle);
  if (
    !context ||
    context.complete ||
    context.tx !== tx ||
    context.readEpoch !== transactionReadEpoch(tx)
  )
    throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
  return context;
}
const joins = `FROM whaleu_community.rating_approval_decisions d JOIN whaleu_community.content_approval_policies p ON p.id=d.policy_revision_id JOIN whaleu_community.rating_approval_heads h ON h.decision_id=d.id JOIN whaleu_community.rating_approval_events e ON e.id=h.event_id AND e.decision_id=d.id`;
const exactTime = (consume: string) =>
  `coalesce(isfinite(d.evaluated_at) AND d.evaluated_at<=instant.now AND isfinite(p.valid_from) AND p.valid_from<=d.evaluated_at AND (p.valid_until IS NULL OR (isfinite(p.valid_until) AND p.valid_until>instant.now)) AND isfinite(e.occurred_at) AND e.occurred_at>=d.evaluated_at AND e.occurred_at<=instant.now AND isfinite(d.consume_until) AND d.consume_until>d.evaluated_at AND (NOT ${consume} OR d.consume_until>instant.now) AND ((d.visibility_model='durable' AND d.visibility_until IS NULL) OR (d.visibility_model='until' AND isfinite(d.visibility_until) AND d.visibility_until>d.evaluated_at AND d.visibility_until>instant.now)),false)`;
async function epoch(tx: PoolClient) {
  const rows = (
    await tx.query<{ singleton: boolean; version: number; epoch: string }>(
      'SELECT singleton,version,epoch::text FROM whaleu_community.rating_review_epoch',
    )
  ).rows;
  if (
    rows.length !== 1 ||
    rows[0]?.singleton !== true ||
    rows[0].version !== 1 ||
    !/^(0|[1-9][0-9]*)$/.test(rows[0].epoch)
  )
    throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
  return ownerFingerprint(rows);
}
async function bindingEpoch(tx: PoolClient) {
  const rows = (
    await tx.query<{ singleton: boolean; version: number; epoch: string }>(
      'SELECT singleton,version,epoch::text FROM whaleu_community.rating_review_binding_epoch',
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
const targetEligibilityProof: RequiredTransactionProof<{
  handle: RatingTargetEligibilityContext;
  fingerprint: string;
  bindingFingerprint: string;
}> = {
  maximumFacts: 1,
  failureCode: 'CONTENT_REVIEW_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'CONTENT_REVIEW_UNAVAILABLE', async (read) => {
      await read.query(
        'LOCK TABLE whaleu_community.rating_review_epoch,whaleu_community.rating_review_binding_epoch IN SHARE MODE NOWAIT',
      );
      const fingerprint = await epoch(read);
      const bindingFingerprint = await bindingEpoch(read);
      if (
        facts.some((fact) => {
          const context = targetEligibilityContexts.get(fact.handle);
          return (
            !context ||
            !context.complete ||
            context.tx !== tx ||
            context.readEpoch !== transactionReadEpoch(tx) ||
            fact.fingerprint !== fingerprint ||
            fact.bindingFingerprint !== bindingFingerprint
          );
        })
      )
        throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    }),
};
const proof: RequiredTransactionProof<Fact> = {
  maximumFacts: 520,
  failureCode: 'CONTENT_REVIEW_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'CONTENT_REVIEW_UNAVAILABLE', async (read) => {
      await read.query(
        'LOCK TABLE whaleu_community.rating_review_epoch,whaleu_community.rating_approval_bindings,whaleu_community.rating_target_definition_bindings IN SHARE MODE NOWAIT',
      );
      const current = await epoch(read);
      if (facts.some((f) => f.type === 'epoch' && f.fingerprint !== current))
        throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
      const times = facts.filter(
        (f): f is Extract<Fact, { type: 'time' }> => f.type === 'time',
      );
      if (times.length) {
        const rows = (
          await read.query<{ ordinal: number; exact_time: boolean }>(
            `WITH instant AS MATERIALIZED (SELECT clock_timestamp() now),wanted AS (SELECT * FROM unnest($1::uuid[],$2::boolean[]) WITH ORDINALITY r(id,consume,ordinal)) SELECT w.ordinal::integer ordinal,coalesce(q.exact_time,false) exact_time FROM wanted w LEFT JOIN LATERAL (SELECT ${exactTime('w.consume')} exact_time ${joins} CROSS JOIN instant WHERE d.id=w.id) q ON true ORDER BY w.ordinal`,
            [times.map((f) => f.id), times.map((f) => f.consume)],
          )
        ).rows;
        if (
          rows.length !== times.length ||
          rows.some(
            (r, i) => r.ordinal !== i + 1 || r.exact_time !== times[i]!.exact,
          )
        )
          throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
      }
      const bindings = facts.filter(
        (f): f is Extract<Fact, { type: 'binding' }> => f.type === 'binding',
      );
      if (bindings.length) {
        const rows = (
          await read.query<{
            ordinal: number;
            decision_id: string | null;
            digest: string | null;
          }>(
            `SELECT r.ordinal::integer ordinal,b.decision_id,b.digest FROM unnest($1::text[],$2::uuid[]) WITH ORDINALITY r(kind,id,ordinal) LEFT JOIN whaleu_community.rating_approval_bindings b ON b.kind=r.kind AND b.subject_id=r.id AND b.content_version=1 ORDER BY r.ordinal`,
            [bindings.map((f) => f.kind), bindings.map((f) => f.id)],
          )
        ).rows;
        if (
          rows.length !== bindings.length ||
          rows.some(
            (r, i) =>
              r.ordinal !== i + 1 ||
              r.decision_id !== bindings[i]!.decisionId ||
              r.digest !== bindings[i]!.digest,
          )
        )
          throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
      }
      const definitions = facts.filter(
        (f): f is Extract<Fact, { type: 'target-definition-binding' }> =>
          f.type === 'target-definition-binding',
      );
      if (definitions.length) {
        const rows = (
          await read.query<{
            ordinal: number;
            definition_revision: string | null;
            decision_id: string | null;
            digest: string | null;
          }>(
            `SELECT r.ordinal::integer ordinal,b.definition_revision,b.decision_id,b.digest FROM unnest($1::uuid[],$2::integer[]) WITH ORDINALITY r(target_id,content_version,ordinal) LEFT JOIN whaleu_community.rating_target_definition_bindings b ON b.target_id=r.target_id AND b.content_version=r.content_version ORDER BY r.ordinal`,
            [
              definitions.map((f) => f.id),
              definitions.map((f) => f.contentVersion),
            ],
          )
        ).rows;
        if (
          rows.length !== definitions.length ||
          rows.some(
            (row, index) =>
              row.ordinal !== index + 1 ||
              row.decision_id !== definitions[index]!.decisionId ||
              row.digest !== definitions[index]!.digest ||
              row.definition_revision !==
                (definitions[index]!.decisionId === null
                  ? null
                  : definitions[index]!.definitionRevision),
          )
        )
          throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
      }
    }),
};
/** Typed sidecar under canonical Review. No query reads rating business tables. */
@Injectable()
export class RatingContentReviewFacade {
  private readonly scoped = new RatingScopedContentReviewFacade();
  private readonly discussionMedia = new RatingDiscussionMediaReviewFacade();

  /** Explicit mixed-protocol batch; no legacy parser or binding is relabelled. */
  async currentDefinitionBatch(
    inputs: readonly AnyRatingTargetDefinitionDescriptor[],
    tx: PoolClient,
  ) {
    const results = await this.scoped.currentTargetDefinitions(inputs, tx);
    const covers = await currentRatingTargetCovers(inputs, tx);
    return Object.freeze(
      results.map((result, index) =>
        covers[index] === 'unavailable'
          ? { kind: 'unavailable' as const }
          : covers[index] === 'deny'
            ? { kind: 'deny' as const, reason: 'RATING_NOT_FOUND' as const }
            : result,
      ),
    );
  }
  /** Explicit, private lifetime for the complete Ratings-owned source scan.
   * No batch registers per-target facts. The two monotonic owner epochs cover
   * every binding/decision/head/event/policy change, including authoritative
   * denials and absent-to-present bindings, until the final NOWAIT fence. */
  async begin(tx: PoolClient): Promise<RatingTargetEligibilityContext> {
    const readEpoch = transactionReadEpoch(tx);
    if (!readEpoch) throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    enableRequiredTransactionProof(tx, targetEligibilityProof);
    const fingerprint = await epoch(tx);
    const bindingFingerprint = await bindingEpoch(tx);
    if (transactionReadEpoch(tx) !== readEpoch)
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    const handle = Object.freeze({}) as RatingTargetEligibilityContext;
    registerRequiredTransactionFact(
      tx,
      targetEligibilityProof,
      `target-eligibility:${++targetEligibilitySerial}`,
      Object.freeze({ handle, fingerprint, bindingFingerprint }),
    );
    targetEligibilityContexts.set(handle, {
      tx,
      readEpoch,
      fingerprint,
      bindingFingerprint,
      done: false,
      busy: false,
      complete: false,
      streamKey: null,
      nextOrdinal: 0,
      until: null,
      validatedCount: 0,
      allowedCount: 0,
    });
    return handle;
  }
  async validateBatch(
    batch: RatingCompletePoolBatch,
    handle: RatingTargetEligibilityContext,
    tx: PoolClient,
  ): Promise<readonly ('allow' | 'deny')[]> {
    const context = targetEligibilityContext(handle, tx);
    if (context.busy) throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    context.busy = true;
    try {
      const provenance = assertRatingCompletePoolBatch(batch, tx);
      if (
        context.done ||
        batch.items.length > 128 ||
        provenance.ordinal !== context.nextOrdinal ||
        (context.streamKey !== null &&
          context.streamKey !== provenance.streamKey)
      )
        throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
      context.streamKey = provenance.streamKey;
      const decisions = await this.targetEligibilityBatch(
        handle,
        batch.items,
        tx,
      );
      targetEligibilityContext(handle, tx);
      context.done = batch.done;
      context.nextOrdinal += 1;
      return decisions;
    } catch (error) {
      // A partially validated scan is never reusable after any failed batch.
      targetEligibilityContexts.delete(handle);
      throw error;
    } finally {
      context.busy = false;
    }
  }
  async complete(
    handle: RatingTargetEligibilityContext,
    tx: PoolClient,
  ): Promise<{ validatedCount: number; allowedCount: number }> {
    const context = targetEligibilityContext(handle, tx);
    if (!context.done || context.busy)
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    context.busy = true;
    try {
      // Complete preparation before sampling. The mandatory fixed-size proof
      // still detects in-flight/new writers after this pre-sample comparison.
      if (
        (await epoch(tx)) !== context.fingerprint ||
        (await bindingEpoch(tx)) !== context.bindingFingerprint
      )
        throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
      const now = (
        await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now')
      ).rows[0]?.now.getTime();
      targetEligibilityContext(handle, tx);
      if (
        !Number.isFinite(now) ||
        (context.until !== null && context.until <= now!)
      )
        throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
      registerTransactionDeadline(
        tx,
        context.until,
        'CONTENT_REVIEW_UNAVAILABLE',
      );
      context.complete = true;
      return {
        validatedCount: context.validatedCount,
        allowedCount: context.allowedCount,
      };
    } catch (error) {
      targetEligibilityContexts.delete(handle);
      throw error;
    } finally {
      context.busy = false;
    }
  }
  private async targetEligibilityBatch(
    handle: RatingTargetEligibilityContext,
    batch: RatingCompletePoolBatch['items'],
    tx: PoolClient,
  ): Promise<readonly ('allow' | 'deny')[]> {
    const context = targetEligibilityContext(handle, tx);
    if (!batch.length) return Object.freeze([]);
    if (
      batch.some(
        (item) =>
          item.definition.envelope.version === 6 &&
          item.definition.envelope.cover !== null,
      )
    )
      throw new ApplicationError('RATING_SCOPE_UNAVAILABLE');
    // A complete legacy-compatible source pool may contain a v5 definition.
    // Dispatch its real binding protocol without coercing origin into view.
    if (
      batch.some((input) =>
        [5, 6].includes(
          (input.definition.envelope as { version: number }).version,
        ),
      )
    ) {
      const definitions = batch.map((input) => {
        let definition: AnyRatingTargetDefinitionDescriptor;
        try {
          definition = canonicalAnyRatingTargetDefinition(input.definition);
        } catch {
          throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
        }
        const envelope = definition.envelope;
        const regionId =
          envelope.version === 5 || envelope.version === 6
            ? envelope.targetOrigin.regionId
            : envelope.scope.regionId;
        if (
          !canonicalEqual(envelope, input.envelope) ||
          !canonicalEqual(envelope, input.row.envelope) ||
          !canonicalEqual(definition, input.row.definition) ||
          definition.targetId !== input.id ||
          input.row.id !== input.id ||
          input.row.category_id !== envelope.categoryId ||
          input.row.creator_id !== envelope.accountId ||
          input.row.region_id !== regionId ||
          input.row.name !== envelope.name ||
          input.row.description !== envelope.description
        )
          throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
        return definition;
      });
      const results = await this.currentDefinitionBatch(definitions, tx);
      targetEligibilityContext(handle, tx);
      return Object.freeze(
        results.map((result) => {
          if (result.kind === 'unavailable')
            throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
          context.validatedCount += 1;
          if (result.kind === 'allow') context.allowedCount += 1;
          return result.kind;
        }),
      );
    }
    const inputs = batch.map((input) => {
      let definition: RatingTargetDefinitionDescriptor;
      try {
        definition = canonicalRatingTargetDefinition(input.definition);
      } catch {
        throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
      }
      const canonical = definition.envelope;
      if (
        !canonicalEqual(canonical, input.envelope) ||
        !canonicalEqual(canonical, input.row.envelope) ||
        !canonicalEqual(definition, input.row.definition) ||
        !z.uuid().safeParse(input.id).success ||
        definition.targetId !== input.id ||
        canonical.targetId !== input.id ||
        input.row.id !== canonical.targetId ||
        input.row.category_id !== canonical.categoryId ||
        input.row.creator_id !== canonical.accountId ||
        input.row.region_id !== canonical.scope.regionId ||
        input.row.name !== canonical.name ||
        input.row.description !== canonical.description
      )
        throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
      return { id: input.id, envelope: canonical, definition };
    });
    // Creator existence retains exactly the canonical anchor lock, acquired as
    // one bounded set. Review rows need no per-item locks/facts: the complete
    // mutation epoch and final NOWAIT fence protect every allow AND denial.
    const rows = (
      await tx.query<TargetEligibilityRow>(
        `WITH instant AS MATERIALIZED (SELECT clock_timestamp() now),
       wanted AS MATERIALIZED (SELECT * FROM unnest($1::uuid[],$2::uuid[],$3::integer[],$4::uuid[]) WITH ORDINALITY r(id,account_id,content_version,definition_revision,ordinal)),
       anchors AS MATERIALIZED (SELECT a.id FROM whaleu_identity.accounts a WHERE a.id IN (SELECT account_id FROM wanted) ORDER BY a.id FOR SHARE OF a)
       SELECT w.ordinal::integer ordinal,CASE WHEN w.content_version=1 THEN to_jsonb(b) ELSE to_jsonb(v) END binding,a.id IS NOT NULL account_exists,
       ${approvalProjection},instant.now,${exactTime('false')} exact_time
       FROM wanted w CROSS JOIN instant
       LEFT JOIN anchors a ON a.id=w.account_id
       LEFT JOIN whaleu_community.rating_approval_bindings b ON w.content_version=1 AND b.kind='target' AND b.subject_id=w.id AND b.content_version=1
       LEFT JOIN whaleu_community.rating_target_definition_bindings v ON w.content_version>=2 AND v.target_id=w.id AND v.content_version=w.content_version AND v.definition_revision=w.definition_revision
       LEFT JOIN whaleu_community.rating_approval_decisions d ON d.id=CASE WHEN w.content_version=1 THEN b.decision_id ELSE v.decision_id END
       LEFT JOIN whaleu_community.content_approval_policies p ON p.id=d.policy_revision_id
       LEFT JOIN whaleu_community.rating_approval_heads h ON h.decision_id=d.id
       LEFT JOIN whaleu_community.rating_approval_events e ON e.id=h.event_id AND e.decision_id=d.id
       ORDER BY w.ordinal`,
        [
          inputs.map((input) => input.id),
          inputs.map((input) => input.envelope.accountId),
          inputs.map((input) => input.definition.contentVersion),
          inputs.map((input) => input.definition.definitionRevision),
        ],
      )
    ).rows;
    targetEligibilityContext(handle, tx);
    if (rows.length !== inputs.length)
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    const decisions: ('allow' | 'deny')[] = [];
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]!;
      const input = inputs[index]!;
      if (
        row.ordinal !== index + 1 ||
        row.account_exists !== true ||
        !row.binding ||
        !(input.definition.contentVersion === 1
          ? ratingBindingMatches(
              row.binding as RatingApprovalBinding,
              'target',
              input.id,
              input.envelope,
            )
          : ratingTargetDefinitionBindingMatches(
              row.binding as RatingTargetDefinitionBinding,
              input.definition,
            )) ||
        row.id !== row.binding.decision_id ||
        row.digest !== row.binding.digest ||
        !canonicalEqual(row.envelope, input.envelope) ||
        row.exact_time !== true ||
        !(row.now instanceof Date)
      )
        throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
      const result = validateRatingApprovalRow(row, false, row.now.getTime());
      if (result.decision.kind === 'unavailable')
        throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
      if (result.optionalUntil !== null)
        context.until = Math.min(
          context.until ?? Infinity,
          result.optionalUntil,
        );
      decisions.push(result.decision.kind);
      context.validatedCount += 1;
      if (result.decision.kind === 'allow') context.allowedCount += 1;
    }
    return Object.freeze(decisions);
  }
  async navigation(tx: PoolClient): Promise<string> {
    enableRequiredTransactionProof(tx, proof);
    const fingerprint = await epoch(tx);
    registerRequiredTransactionFact(
      tx,
      proof,
      `epoch:${fingerprint}`,
      Object.freeze({ type: 'epoch', fingerprint }),
    );
    return fingerprint;
  }
  private async anchor(accountId: string, tx: PoolClient) {
    return !!(
      await tx.query(
        'SELECT id FROM whaleu_identity.accounts WHERE id=$1 FOR SHARE',
        [accountId],
      )
    ).rows[0];
  }
  private async row(
    id: string,
    consume: boolean,
    tx: PoolClient,
  ): Promise<TimedRow | null> {
    await tx.query(
      'SELECT decision_id FROM whaleu_community.rating_approval_heads WHERE decision_id=$1 FOR SHARE',
      [id],
    );
    const row =
      (
        await tx.query<TimedRow>(
          `WITH instant AS MATERIALIZED (SELECT clock_timestamp() now) SELECT ${approvalProjection},instant.now,${exactTime('$2::boolean')} exact_time ${joins} CROSS JOIN instant WHERE d.id=$1`,
          [id, consume],
        )
      ).rows[0] ?? null;
    if (row)
      registerRequiredTransactionFact(
        tx,
        proof,
        `time:${id}:${consume}:${row.exact_time}`,
        Object.freeze({ type: 'time', id, consume, exact: row.exact_time }),
      );
    return row;
  }
  private validate(
    row: TimedRow | null,
    consume: boolean,
    tx: PoolClient,
  ): Decision<AcceptedRatingApproval> {
    if (!row || row.exact_time !== true) return { kind: 'unavailable' };
    const result = validateRatingApprovalRow(row, consume, row.now.getTime());
    registerTransactionDeadline(
      tx,
      result.optionalUntil,
      'CONTENT_REVIEW_UNAVAILABLE',
    );
    return result.decision;
  }
  async accepted(
    envelope: RatingContentEnvelope,
    tx: PoolClient,
  ): Promise<AcceptedRatingApproval> {
    await this.navigation(tx);
    let canonical: RatingContentEnvelope;
    try {
      canonical = canonicalRatingEnvelope(envelope);
    } catch {
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    }
    if (
      !canonicalEqual(canonical, envelope) ||
      !(await this.anchor(canonical.accountId, tx))
    )
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    const candidate = (
      await tx.query<{ id: string }>(
        `SELECT id FROM whaleu_community.rating_approval_decisions WHERE account_id=$1 AND operation=$2 AND envelope_version=$4 AND digest=$3 ORDER BY evaluated_at DESC,id DESC LIMIT 1`,
        [
          canonical.accountId,
          canonical.purpose,
          ratingApprovalDigest(canonical),
          canonical.version,
        ],
      )
    ).rows[0];
    const row = candidate ? await this.row(candidate.id, true, tx) : null;
    const result =
      row && canonicalEqual(row.envelope, canonical)
        ? this.validate(row, true, tx)
        : { kind: 'unavailable' as const };
    if (result.kind === 'deny') throw new ApplicationError('CONTENT_REJECTED');
    if (
      result.kind !== 'allow' ||
      !canonicalEqual(result.value.envelope, canonical)
    )
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    if (
      (
        await tx.query(
          'SELECT decision_id FROM whaleu_community.rating_approval_bindings WHERE decision_id=$1',
          [result.value.decisionId],
        )
      ).rows[0]
    )
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    if (
      (
        await tx.query(
          'SELECT decision_id FROM whaleu_community.rating_target_definition_bindings WHERE decision_id=$1',
          [result.value.decisionId],
        )
      ).rows[0]
    )
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    return result.value;
  }
  async acceptedTargetEdit(
    envelope: RatingContentEnvelope,
    tx: PoolClient,
  ): Promise<AcceptedRatingApproval> {
    let canonical: RatingContentEnvelope;
    try {
      canonical = canonicalRatingEnvelope(envelope);
    } catch {
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    }
    if (
      canonical.purpose !== 'edit_rating_target' ||
      !canonicalEqual(canonical, envelope)
    )
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    return this.accepted(canonical, tx);
  }

  async bindTargetDefinition(
    accepted: AcceptedRatingApproval,
    descriptor: RatingTargetDefinitionDescriptor,
    tx: PoolClient,
  ): Promise<void> {
    let definition: RatingTargetDefinitionDescriptor;
    try {
      definition = canonicalRatingTargetDefinition(descriptor);
    } catch {
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    }
    if (
      definition.contentVersion < 2 ||
      accepted.version !== 3 ||
      !canonicalEqual(accepted.envelope, definition.envelope)
    )
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    const fresh = await this.acceptedTargetEdit(definition.envelope, tx);
    if (
      accepted.decisionId !== fresh.decisionId ||
      accepted.digest !== fresh.digest
    )
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    await tx.query(
      `INSERT INTO whaleu_community.rating_target_definition_bindings(target_id,content_version,definition_revision,decision_id,account_id,operation,envelope_version,digest,envelope,scope) VALUES($1,$2,$3,$4,$5,'edit_rating_target',3,$6,$7::jsonb,$8::jsonb)`,
      [
        definition.targetId,
        definition.contentVersion,
        definition.definitionRevision,
        fresh.decisionId,
        fresh.envelope.accountId,
        fresh.digest,
        canonicalJson(fresh.envelope),
        canonicalJson(fresh.envelope.scope),
      ],
    );
    this.retainTargetDefinitionBinding(definition, fresh, tx);
  }

  private retainTargetDefinitionBinding(
    definition: RatingTargetDefinitionDescriptor,
    binding: { decisionId: string; digest: string } | null,
    tx: PoolClient,
  ): void {
    const fact = Object.freeze({
      type: 'target-definition-binding' as const,
      id: definition.targetId,
      contentVersion: definition.contentVersion,
      definitionRevision: definition.definitionRevision,
      decisionId: binding?.decisionId ?? null,
      digest: binding?.digest ?? null,
    });
    registerRequiredTransactionFact(
      tx,
      proof,
      `target-definition-binding:${fact.id}:${fact.contentVersion}:${fact.definitionRevision}:${fact.decisionId}:${fact.digest}`,
      fact,
    );
  }

  async currentTargetDefinitionForCoverMutation(
    descriptor: AnyRatingTargetDefinitionDescriptor,
    tx: PoolClient,
  ) {
    const review = (
      await this.scoped.currentTargetDefinitions([descriptor], tx)
    )[0]!;
    const cover = (
      await currentRatingTargetCovers([descriptor], tx, false)
    )[0]!;
    return cover === 'unavailable'
      ? { kind: 'unavailable' as const }
      : cover === 'deny'
        ? { kind: 'deny' as const, reason: 'RATING_NOT_FOUND' as const }
        : review;
  }
  async currentTargetDefinition(
    descriptor: RatingTargetDefinitionDescriptor,
    tx: PoolClient,
  ): Promise<Decision<AcceptedRatingApproval>>;
  async currentTargetDefinition(
    descriptor: RatingScopedTargetDefinitionDescriptor,
    tx: PoolClient,
  ): Promise<Decision<AcceptedRatingScopedApproval>>;
  async currentTargetDefinition(
    descriptor: AnyRatingTargetDefinitionDescriptor,
    tx: PoolClient,
  ): Promise<
    Decision<
      | AcceptedRatingApproval
      | AcceptedRatingScopedApproval
      | AcceptedRatingTargetCoverApproval
    >
  >;
  async currentTargetDefinition(
    descriptor: AnyRatingTargetDefinitionDescriptor,
    tx: PoolClient,
  ): Promise<
    Decision<
      | AcceptedRatingApproval
      | AcceptedRatingScopedApproval
      | AcceptedRatingTargetCoverApproval
    >
  > {
    if (
      descriptor?.envelope?.version === 6 ||
      descriptor?.envelope?.version === 5
    )
      return (await this.currentDefinitionBatch([descriptor], tx))[0]!;
    await this.navigation(tx);
    let definition: RatingTargetDefinitionDescriptor;
    try {
      definition = canonicalRatingTargetDefinition(descriptor);
    } catch {
      return { kind: 'unavailable' };
    }
    if (definition.contentVersion === 1)
      return this.current(
        'target',
        definition.targetId,
        definition.envelope,
        tx,
      );
    if (!(await this.anchor(definition.envelope.accountId, tx)))
      return { kind: 'unavailable' };
    const binding = (
      await tx.query<RatingTargetDefinitionBinding>(
        'SELECT * FROM whaleu_community.rating_target_definition_bindings WHERE target_id=$1 AND content_version=$2 FOR SHARE',
        [definition.targetId, definition.contentVersion],
      )
    ).rows[0];
    this.retainTargetDefinitionBinding(
      definition,
      binding
        ? { decisionId: binding.decision_id, digest: binding.digest }
        : null,
      tx,
    );
    if (!binding || !ratingTargetDefinitionBindingMatches(binding, definition))
      return { kind: 'unavailable' };
    const row = await this.row(binding.decision_id, false, tx);
    if (
      !row ||
      row.digest !== binding.digest ||
      !canonicalEqual(row.envelope, definition.envelope)
    )
      return { kind: 'unavailable' };
    return this.validate(row, false, tx);
  }
  async bind(
    accepted: AcceptedRatingApproval,
    kind: RatingContentKind,
    id: string,
    envelope: RatingContentEnvelope,
    tx: PoolClient,
  ): Promise<void> {
    if (
      !z.uuid().safeParse(id).success ||
      accepted.version !== envelope.version ||
      envelope.purpose !== ratingOperation(kind) ||
      !canonicalEqual(accepted.envelope, envelope) ||
      (kind === 'target' && envelope.targetId !== id) ||
      (envelope.purpose === 'publish_rating_reply' &&
        envelope.replyTo?.replyId === id)
    )
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    const fresh = await this.accepted(envelope, tx);
    if (
      fresh.decisionId !== accepted.decisionId ||
      fresh.digest !== accepted.digest
    )
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    await tx.query(
      `INSERT INTO whaleu_community.rating_approval_bindings(kind,subject_id,content_version,decision_id,account_id,operation,envelope_version,digest,envelope,scope) VALUES($1,$2,1,$3,$4,$5,$9,$6,$7::jsonb,$8::jsonb)`,
      [
        kind,
        id,
        fresh.decisionId,
        fresh.envelope.accountId,
        fresh.envelope.purpose,
        fresh.digest,
        canonicalJson(fresh.envelope),
        canonicalJson(fresh.envelope.scope),
        fresh.version,
      ],
    );
    registerRequiredTransactionFact(
      tx,
      proof,
      `binding:${kind}:${id}:${fresh.decisionId}:${fresh.digest}`,
      Object.freeze({
        type: 'binding',
        kind,
        id,
        decisionId: fresh.decisionId,
        digest: fresh.digest,
      }),
    );
  }
  async current(
    kind: RatingContentKind,
    id: string,
    envelope: RatingContentEnvelope,
    tx: PoolClient,
  ): Promise<Decision<AcceptedRatingApproval>>;
  async current(
    kind: RatingContentKind,
    id: string,
    envelope: RatingScopedTargetEnvelope | RatingScopedContentEnvelope,
    tx: PoolClient,
  ): Promise<Decision<AcceptedRatingScopedApproval>>;
  async current(
    kind: RatingContentKind,
    id: string,
    envelope:
      | RatingContentEnvelope
      | RatingScopedTargetEnvelope
      | RatingScopedContentEnvelope
      | RatingDiscussionMediaEnvelope,
    tx: PoolClient,
  ): Promise<
    Decision<
      | AcceptedRatingApproval
      | AcceptedRatingScopedApproval
      | AcceptedRatingTargetCoverApproval
      | AcceptedRatingDiscussionMediaApproval
    >
  >;
  async current(
    kind: RatingContentKind,
    id: string,
    envelope:
      | RatingContentEnvelope
      | RatingScopedTargetEnvelope
      | RatingScopedContentEnvelope
      | RatingDiscussionMediaEnvelope,
    tx: PoolClient,
  ): Promise<
    Decision<
      | AcceptedRatingApproval
      | AcceptedRatingScopedApproval
      | AcceptedRatingTargetCoverApproval
      | AcceptedRatingDiscussionMediaApproval
    >
  > {
    if (envelope?.version === 7) {
      if (kind === 'target') return { kind: 'unavailable' };
      return this.discussionMedia.current(kind, id, envelope, tx);
    }
    if (envelope?.version === 5) {
      if (
        envelope.purpose === 'publish_rating_target_scoped' ||
        envelope.purpose === 'edit_rating_target_scoped'
      ) {
        if (kind !== 'target' || envelope.targetId !== id)
          return { kind: 'unavailable' };
        return this.scoped.currentTargetDefinition(
          {
            targetId: id,
            contentVersion: envelope.contentVersion,
            definitionRevision: envelope.definitionRevision,
            appliedTargetRevision: envelope.targetRevision,
            envelope,
          },
          tx,
        );
      }
      if (kind === 'target') return { kind: 'unavailable' };
      return this.scoped.currentContent(kind, id, envelope, tx);
    }
    await this.navigation(tx);
    let canonical: RatingContentEnvelope;
    try {
      canonical = canonicalRatingEnvelope(envelope);
    } catch {
      return { kind: 'unavailable' };
    }
    if (
      !canonicalEqual(canonical, envelope) ||
      !z.uuid().safeParse(id).success ||
      canonical.purpose !== ratingOperation(kind) ||
      (kind === 'target' && canonical.targetId !== id) ||
      (canonical.purpose === 'publish_rating_reply' &&
        canonical.replyTo?.replyId === id) ||
      !(await this.anchor(canonical.accountId, tx))
    )
      return { kind: 'unavailable' };
    const binding = (
      await tx.query<RatingApprovalBinding>(
        'SELECT * FROM whaleu_community.rating_approval_bindings WHERE kind=$1 AND subject_id=$2 AND content_version=1 FOR SHARE',
        [kind, id],
      )
    ).rows[0];
    const fact = Object.freeze({
      type: 'binding' as const,
      kind,
      id,
      decisionId: binding?.decision_id ?? null,
      digest: binding?.digest ?? null,
    });
    registerRequiredTransactionFact(
      tx,
      proof,
      `binding:${kind}:${id}:${fact.decisionId}:${fact.digest}`,
      fact,
    );
    if (!binding || !ratingBindingMatches(binding, kind, id, canonical))
      return { kind: 'unavailable' };
    const row = await this.row(binding.decision_id, false, tx);
    if (
      !row ||
      row.digest !== binding.digest ||
      !canonicalEqual(row.envelope, canonical)
    )
      return { kind: 'unavailable' };
    return this.validate(row, false, tx);
  }
}
