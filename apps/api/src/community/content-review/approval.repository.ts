import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { registerTransactionDeadline } from '../../database/transaction-deadlines.js';
import { ApplicationError } from '../../http/application-error.js';
import type { Decision } from '../community-policy.js';
import {
  approvalDigest,
  canonicalEnvelope,
  canonicalJson,
  operationForKind,
} from './contracts.js';
import type {
  AcceptedApproval,
  ContentKind,
  ContentScopeSnapshot,
  EffectiveContentEnvelope,
} from './contracts.js';

interface ApprovalRow {
  id: string;
  account_id: string;
  operation: string;
  envelope_version: number;
  digest: string;
  envelope: unknown;
  policy_revision_id: string;
  result: 'allow' | 'reject' | 'pending' | 'failed';
  coverage: string;
  provenance: string;
  issuer: string;
  provenance_ref: string;
  evaluated_at: Date;
  consume_until: Date;
  visibility_model: string;
  visibility_until: Date | null;
  policy_key: string;
  policy_version: number;
  policy_coverage: string;
  policy_provenance: string;
  policy_issuer: string;
  policy_provenance_ref: string;
  policy_valid_from: Date;
  policy_valid_until: Date | null;
  state: 'allow' | 'held' | 'revoked';
  event_at: Date;
  event_coverage: string;
  event_provenance: string;
  event_issuer: string;
  event_provenance_ref: string;
}
export interface ApprovalBinding {
  content_kind: ContentKind;
  content_id: string;
  content_version: number;
  decision_id: string;
  account_id: string;
  operation: string;
  envelope_version: number;
  digest: string;
  envelope: EffectiveContentEnvelope;
  scope: ContentScopeSnapshot;
}
const projection = `d.*,p.policy_key,p.version AS policy_version,
  p.coverage AS policy_coverage,p.provenance AS policy_provenance,
  p.issuer AS policy_issuer,p.provenance_ref AS policy_provenance_ref,
  p.valid_from AS policy_valid_from,p.valid_until AS policy_valid_until,
  e.state,e.occurred_at AS event_at,e.coverage AS event_coverage,
  e.provenance AS event_provenance,e.issuer AS event_issuer,
  e.provenance_ref AS event_provenance_ref`;
@Injectable()
export class ApprovalRepository {
  /** Actor account is the stable absent-intent anchor; issuance takes UPDATE.
   * No reader creates a decision/head or infers authority from a receipt. */
  private async anchor(accountId: string, tx: PoolClient): Promise<boolean> {
    return !!(
      await tx.query(
        'SELECT id FROM whaleu_identity.accounts WHERE id=$1 FOR SHARE',
        [accountId],
      )
    ).rows[0];
  }
  private async row(id: string, tx: PoolClient): Promise<ApprovalRow | null> {
    const result = await tx.query<ApprovalRow>(
      `SELECT ${projection} FROM whaleu_community.content_approval_decisions d
       JOIN whaleu_community.content_approval_policies p ON p.id=d.policy_revision_id
       JOIN whaleu_community.content_approval_heads h ON h.decision_id=d.id
       JOIN whaleu_community.content_approval_events e ON e.id=h.event_id AND e.decision_id=d.id
       WHERE d.id=$1 FOR SHARE OF h`,
      [id],
    );
    return result.rows[0] ?? null;
  }
  private async validate(
    row: ApprovalRow | null,
    consume: boolean,
    tx: PoolClient,
  ): Promise<Decision<AcceptedApproval>> {
    if (!row) return { kind: 'unavailable' };
    let envelope: EffectiveContentEnvelope;
    try {
      envelope = canonicalEnvelope(row.envelope);
      if (
        canonicalJson(row.envelope) !== canonicalJson(envelope) ||
        row.digest !== approvalDigest(envelope)
      )
        return { kind: 'unavailable' };
    } catch {
      return { kind: 'unavailable' };
    }
    if (
      row.envelope_version !== 1 ||
      row.account_id !== envelope.accountId ||
      row.operation !== envelope.purpose ||
      row.policy_key !== 'local-explicit-v1' ||
      row.policy_version !== 1 ||
      row.coverage !== 'complete' ||
      row.policy_coverage !== 'complete' ||
      row.event_coverage !== 'complete' ||
      row.provenance !== 'accepted' ||
      row.policy_provenance !== 'accepted' ||
      row.event_provenance !== 'accepted' ||
      !row.issuer?.trim() ||
      !row.provenance_ref?.trim() ||
      !row.policy_issuer?.trim() ||
      !row.policy_provenance_ref?.trim() ||
      !row.event_issuer?.trim() ||
      !row.event_provenance_ref?.trim()
    )
      return { kind: 'unavailable' };
    const now = (
      await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now')
    ).rows[0]?.now.getTime();
    const evaluated = row.evaluated_at?.getTime();
    const policyFrom = row.policy_valid_from?.getTime();
    const policyUntil =
      row.policy_valid_until === null
        ? null
        : row.policy_valid_until?.getTime();
    const eventAt = row.event_at?.getTime();
    const consumeUntil = row.consume_until?.getTime();
    const visibilityUntil =
      row.visibility_until === null ? null : row.visibility_until?.getTime();
    if (
      !Number.isFinite(now) ||
      !Number.isFinite(evaluated) ||
      !Number.isFinite(eventAt) ||
      !Number.isFinite(policyFrom) ||
      evaluated > now! ||
      eventAt > now! ||
      eventAt < evaluated ||
      policyFrom > evaluated ||
      (policyUntil !== null &&
        (!Number.isFinite(policyUntil) || policyUntil <= now!)) ||
      !Number.isFinite(consumeUntil) ||
      consumeUntil <= evaluated ||
      (row.visibility_model !== 'durable' &&
        row.visibility_model !== 'until') ||
      (row.visibility_model === 'durable'
        ? visibilityUntil !== null
        : visibilityUntil === null || !Number.isFinite(visibilityUntil)) ||
      (visibilityUntil !== null && visibilityUntil <= now!)
    )
      return { kind: 'unavailable' };
    registerTransactionDeadline(
      tx,
      policyUntil,
      consume ? 'CONTENT_REVIEW_UNAVAILABLE' : 'COMMUNITY_UNAVAILABLE',
    );
    registerTransactionDeadline(
      tx,
      visibilityUntil,
      consume ? 'CONTENT_REVIEW_UNAVAILABLE' : 'COMMUNITY_UNAVAILABLE',
    );
    if (row.result === 'reject' || row.state === 'revoked')
      return {
        kind: 'deny',
        reason: consume ? 'CONTENT_REJECTED' : 'POST_NOT_FOUND',
      };
    if (row.state === 'held')
      return consume
        ? { kind: 'unavailable' }
        : { kind: 'deny', reason: 'POST_NOT_FOUND' };
    if (row.result !== 'allow' || row.state !== 'allow')
      return { kind: 'unavailable' };
    if (consume) {
      if (consumeUntil <= now!) return { kind: 'unavailable' };
      registerTransactionDeadline(
        tx,
        consumeUntil,
        'CONTENT_REVIEW_UNAVAILABLE',
      );
    }
    return {
      kind: 'allow',
      value: { decisionId: row.id, digest: row.digest, version: 1, envelope },
    };
  }
  async accepted(
    envelope: EffectiveContentEnvelope,
    tx: PoolClient,
  ): Promise<Decision<AcceptedApproval>> {
    if (!(await this.anchor(envelope.accountId, tx)))
      return { kind: 'unavailable' };
    const digest = approvalDigest(envelope);
    // The latest exact decision is authoritative: never fall back past a reject,
    // malformed/pending decision, missing head, expired or already consumed grant.
    const candidate = (
      await tx.query<{ id: string }>(
        `SELECT id FROM whaleu_community.content_approval_decisions
       WHERE account_id=$1 AND operation=$2 AND envelope_version=1 AND digest=$3
       ORDER BY evaluated_at DESC,id DESC LIMIT 1`,
        [envelope.accountId, envelope.purpose, digest],
      )
    ).rows[0];
    if (!candidate) return { kind: 'unavailable' };
    const result = await this.validate(
      await this.row(candidate.id, tx),
      true,
      tx,
    );
    if (result.kind !== 'allow') return result;
    if (
      canonicalJson(result.value.envelope) !==
      canonicalJson(canonicalEnvelope(envelope))
    )
      return { kind: 'unavailable' };
    if (
      (
        await tx.query(
          'SELECT decision_id FROM whaleu_community.content_approval_bindings WHERE decision_id=$1',
          [candidate.id],
        )
      ).rows[0]
    )
      return { kind: 'unavailable' };
    return result;
  }
  async binding(
    kind: ContentKind,
    id: string,
    tx: PoolClient,
  ): Promise<ApprovalBinding | null> {
    return (
      (
        await tx.query<ApprovalBinding>(
          'SELECT * FROM whaleu_community.content_approval_bindings WHERE content_kind=$1 AND content_id=$2 AND content_version=1 FOR SHARE',
          [kind, id],
        )
      ).rows[0] ?? null
    );
  }
  async current(
    binding: ApprovalBinding,
    tx: PoolClient,
  ): Promise<Decision<AcceptedApproval>> {
    if (!(await this.anchor(binding.account_id, tx)))
      return { kind: 'unavailable' };
    const result = await this.validate(
      await this.row(binding.decision_id, tx),
      false,
      tx,
    );
    if (result.kind !== 'allow') return result;
    const accepted = result.value;
    if (
      binding.content_version !== 1 ||
      binding.envelope_version !== 1 ||
      binding.operation !== operationForKind(binding.content_kind) ||
      binding.account_id !== accepted.envelope.accountId ||
      binding.operation !== accepted.envelope.purpose ||
      binding.digest !== accepted.digest ||
      canonicalJson(binding.envelope) !== canonicalJson(accepted.envelope) ||
      canonicalJson(binding.scope) !== canonicalJson(accepted.envelope.scope)
    )
      return { kind: 'unavailable' };
    return result;
  }
  async bind(
    accepted: AcceptedApproval,
    kind: ContentKind,
    id: string,
    tx: PoolClient,
  ): Promise<void> {
    if (!(await this.anchor(accepted.envelope.accountId, tx)))
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    const current = await this.validate(
      await this.row(accepted.decisionId, tx),
      true,
      tx,
    );
    if (current.kind === 'deny') throw new ApplicationError(current.reason);
    if (
      current.kind !== 'allow' ||
      accepted.version !== 1 ||
      accepted.digest !== current.value.digest ||
      canonicalJson(accepted.envelope) !==
        canonicalJson(current.value.envelope) ||
      operationForKind(kind) !== accepted.envelope.purpose
    )
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    await tx.query(
      `INSERT INTO whaleu_community.content_approval_bindings
       (content_kind,content_id,content_version,decision_id,account_id,operation,envelope_version,digest,envelope,scope)
       VALUES($1,$2,1,$3,$4,$5,1,$6,$7::jsonb,$8::jsonb)`,
      [
        kind,
        id,
        accepted.decisionId,
        accepted.envelope.accountId,
        accepted.envelope.purpose,
        accepted.digest,
        JSON.stringify(accepted.envelope),
        JSON.stringify(accepted.envelope.scope),
      ],
    );
  }
  async scopeForPost(
    postId: string,
    tx: PoolClient,
  ): Promise<ContentScopeSnapshot | null> {
    const binding = await this.binding('post', postId, tx);
    if (!binding) return null;
    const result = await this.current(binding, tx);
    return result.kind === 'allow' ? result.value.envelope.scope : null;
  }
}
