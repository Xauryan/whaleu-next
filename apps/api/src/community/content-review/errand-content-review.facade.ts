import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { registerTransactionDeadline } from '../../database/transaction-deadlines.js';
import { ApplicationError } from '../../http/application-error.js';
import type { Decision } from '../community-policy.js';
import { approvalProjection } from './approval.repository.js';
import { canonicalEqual, canonicalJson } from './contracts.js';
import {
  canonicalErrandEnvelope,
  errandApprovalDigest,
} from './errand-contracts.js';
import type {
  AcceptedErrandApproval,
  ErrandContentEnvelope,
} from './errand-contracts.js';
import {
  errandBindingMatches,
  validateErrandApprovalRow,
} from './errand-approval-validation.js';
import type {
  ErrandApprovalBinding,
  ErrandApprovalRow,
} from './errand-approval-validation.js';

/** Review-owned facts only. The caller supplies the immutable, locked errand row
 * definition; this owner never reads or changes the errands schema. Call within
 * the existing shared safety gate and authenticated transaction. No issuers or
 * provider fallbacks are installed here. */
@Injectable()
export class ErrandContentReviewFacade {
  private async anchor(accountId: string, tx: PoolClient): Promise<boolean> {
    return !!(
      await tx.query(
        'SELECT id FROM whaleu_identity.accounts WHERE id=$1 FOR SHARE',
        [accountId],
      )
    ).rows[0];
  }
  private async row(
    id: string,
    tx: PoolClient,
  ): Promise<ErrandApprovalRow | null> {
    return (
      (
        await tx.query<ErrandApprovalRow>(
          `SELECT ${approvalProjection} FROM whaleu_community.errand_approval_decisions d
       JOIN whaleu_community.content_approval_policies p ON p.id=d.policy_revision_id
       JOIN whaleu_community.errand_approval_heads h ON h.decision_id=d.id
       JOIN whaleu_community.errand_approval_events e ON e.id=h.event_id AND e.decision_id=d.id
       WHERE d.id=$1 FOR SHARE OF h`,
          [id],
        )
      ).rows[0] ?? null
    );
  }
  private async validate(
    row: ErrandApprovalRow | null,
    consume: boolean,
    tx: PoolClient,
  ): Promise<Decision<AcceptedErrandApproval>> {
    if (!row) return { kind: 'unavailable' };
    const time = (
      await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now')
    ).rows[0]?.now;
    const result = validateErrandApprovalRow(
      row,
      consume,
      time instanceof Date ? time.getTime() : NaN,
    );
    registerTransactionDeadline(
      tx,
      result.optionalUntil,
      'CONTENT_REVIEW_UNAVAILABLE',
    );
    return result.decision;
  }
  async accepted(
    envelope: ErrandContentEnvelope,
    tx: PoolClient,
  ): Promise<AcceptedErrandApproval> {
    try {
      const canonical = canonicalErrandEnvelope(envelope);
      if (
        !canonicalEqual(canonical, envelope) ||
        !(await this.anchor(canonical.accountId, tx))
      )
        throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
      // The latest exact decision is authoritative even if pending, malformed,
      // unheaded, rejected, expired or previously consumed. Never skip backward.
      const candidate = (
        await tx.query<{ id: string }>(
          `SELECT id FROM whaleu_community.errand_approval_decisions
         WHERE account_id=$1 AND operation=$2 AND envelope_version=1 AND digest=$3
         ORDER BY evaluated_at DESC,id DESC LIMIT 1`,
          [
            canonical.accountId,
            canonical.purpose,
            errandApprovalDigest(canonical),
          ],
        )
      ).rows[0];
      const row = candidate ? await this.row(candidate.id, tx) : null;
      const result =
        row &&
        row.id === candidate?.id &&
        canonicalEqual(row.envelope, canonical)
          ? await this.validate(row, true, tx)
          : { kind: 'unavailable' as const };
      if (result.kind === 'deny')
        throw new ApplicationError('CONTENT_REJECTED');
      if (
        result.kind !== 'allow' ||
        !canonicalEqual(result.value.envelope, canonical)
      )
        throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
      if (
        (
          await tx.query(
            'SELECT decision_id FROM whaleu_community.errand_approval_bindings WHERE decision_id=$1',
            [result.value.decisionId],
          )
        ).rows[0]
      )
        throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
      return result.value;
    } catch (error) {
      if (
        error instanceof ApplicationError &&
        error.code === 'CONTENT_REJECTED'
      )
        throw error;
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    }
  }
  async bind(
    accepted: AcceptedErrandApproval,
    orderId: string,
    envelope: ErrandContentEnvelope,
    tx: PoolClient,
  ): Promise<void> {
    try {
      if (
        !z.uuid().safeParse(orderId).success ||
        accepted.version !== 1 ||
        !canonicalEqual(accepted.envelope, envelope)
      )
        throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
      // Re-read the latest exact grant under the same anchor and deadline before
      // consumption; no caller-provided accepted object is authority by itself.
      const fresh = await this.accepted(envelope, tx);
      if (
        fresh.decisionId !== accepted.decisionId ||
        fresh.digest !== accepted.digest
      )
        throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
      await tx.query(
        `INSERT INTO whaleu_community.errand_approval_bindings
         (order_id,content_version,decision_id,account_id,operation,envelope_version,digest,envelope,scope)
         VALUES($1,1,$2,$3,'publish_errand',1,$4,$5::jsonb,$6::jsonb)`,
        [
          orderId,
          fresh.decisionId,
          fresh.envelope.accountId,
          fresh.digest,
          canonicalJson(fresh.envelope),
          canonicalJson(fresh.envelope.scope),
        ],
      );
    } catch (error) {
      if (
        error instanceof ApplicationError &&
        error.code === 'CONTENT_REJECTED'
      )
        throw error;
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    }
  }
  async current(
    orderId: string,
    envelope: ErrandContentEnvelope,
    tx: PoolClient,
  ): Promise<Decision<AcceptedErrandApproval>> {
    try {
      const canonical = canonicalErrandEnvelope(envelope);
      if (
        !canonicalEqual(canonical, envelope) ||
        !z.uuid().safeParse(orderId).success ||
        !(await this.anchor(canonical.accountId, tx))
      )
        return { kind: 'unavailable' };
      const binding = (
        await tx.query<ErrandApprovalBinding>(
          `SELECT * FROM whaleu_community.errand_approval_bindings
         WHERE order_id=$1 AND content_version=1 FOR SHARE`,
          [orderId],
        )
      ).rows[0];
      if (!binding || !errandBindingMatches(binding, orderId, canonical))
        return { kind: 'unavailable' };
      const row = await this.row(binding.decision_id, tx);
      if (
        !row ||
        row.id !== binding.decision_id ||
        row.digest !== binding.digest ||
        !canonicalEqual(row.envelope, canonical)
      )
        return { kind: 'unavailable' };
      const result = await this.validate(row, false, tx);
      if (result.kind !== 'allow') return result;
      if (
        result.value.decisionId !== binding.decision_id ||
        result.value.digest !== binding.digest ||
        !canonicalEqual(result.value.envelope, canonical)
      )
        return { kind: 'unavailable' };
      return result;
    } catch {
      return { kind: 'unavailable' };
    }
  }
}
