import { Injectable } from '@nestjs/common';
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
} from '../../database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../../database/transaction-deadlines.js';
import type { Decision } from '../community-policy.js';
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
  validateRatingApprovalRow,
} from './rating-approval-validation.js';
import type {
  RatingApprovalBinding,
  RatingApprovalRow,
} from './rating-approval-validation.js';
type Fact =
  | { type: 'epoch'; fingerprint: string }
  | { type: 'time'; id: string; consume: boolean; exact: boolean }
  | {
      type: 'binding';
      kind: RatingContentKind;
      id: string;
      decisionId: string | null;
      digest: string | null;
    };
interface TimedRow extends RatingApprovalRow {
  exact_time: boolean;
  now: Date;
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
const proof: RequiredTransactionProof<Fact> = {
  maximumFacts: 520,
  failureCode: 'CONTENT_REVIEW_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'CONTENT_REVIEW_UNAVAILABLE', async (read) => {
      await read.query(
        'LOCK TABLE whaleu_community.rating_review_epoch,whaleu_community.rating_approval_bindings IN SHARE MODE NOWAIT',
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
    }),
};
/** Typed sidecar under canonical Review. No query reads rating business tables. */
@Injectable()
export class RatingContentReviewFacade {
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
        `SELECT id FROM whaleu_community.rating_approval_decisions WHERE account_id=$1 AND operation=$2 AND envelope_version=1 AND digest=$3 ORDER BY evaluated_at DESC,id DESC LIMIT 1`,
        [
          canonical.accountId,
          canonical.purpose,
          ratingApprovalDigest(canonical),
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
    return result.value;
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
      accepted.version !== 1 ||
      envelope.purpose !== ratingOperation(kind) ||
      !canonicalEqual(accepted.envelope, envelope) ||
      (kind === 'target' && envelope.targetId !== id)
    )
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    const fresh = await this.accepted(envelope, tx);
    if (
      fresh.decisionId !== accepted.decisionId ||
      fresh.digest !== accepted.digest
    )
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    await tx.query(
      `INSERT INTO whaleu_community.rating_approval_bindings(kind,subject_id,content_version,decision_id,account_id,operation,envelope_version,digest,envelope,scope) VALUES($1,$2,1,$3,$4,$5,1,$6,$7::jsonb,$8::jsonb)`,
      [
        kind,
        id,
        fresh.decisionId,
        fresh.envelope.accountId,
        fresh.envelope.purpose,
        fresh.digest,
        canonicalJson(fresh.envelope),
        canonicalJson(fresh.envelope.scope),
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
  ): Promise<Decision<AcceptedRatingApproval>> {
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
