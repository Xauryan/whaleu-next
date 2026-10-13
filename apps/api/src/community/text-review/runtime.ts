import { requireFeedbackSpace } from '../feedback/topic.js';
import { registerTransactionDeadline } from '../../database/transaction-deadlines.js';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { CommunityDistributionService } from '../related-sync/service.js';
import type { PoolClient } from 'pg';
import { APP_CONFIG } from '../../config/config.js';
import type { RuntimeConfig } from '../../config/config.js';
import { ApplicationError } from '../../http/application-error.js';
import { ApprovalRepository } from '../content-review/approval.repository.js';
import { approvalDigest, canonicalJson } from '../content-review/contracts.js';
import type {
  AcceptedApproval,
  EffectiveContentEnvelope,
} from '../content-review/contracts.js';
import type { CommunitySpace } from '../contracts.js';
import type { PublicationMediaContext } from '../../media/batch-protocol.js';
import type { TextReviewRequest, TextReviewStatus } from './contracts.js';

@Injectable()
export class TextReviewRuntime {
  constructor(
    @Inject(APP_CONFIG) readonly config: RuntimeConfig,
    @Inject(ApprovalRepository) private readonly approvals: ApprovalRepository,
    @Optional()
    @Inject(CommunityDistributionService)
    private readonly distribution?: CommunityDistributionService,
  ) {}
  configured(): boolean {
    return (
      this.config.NODE_ENV !== 'production' &&
      this.config.COMMUNITY_TEXT_REVIEW === 'local_manual' &&
      !!this.config.COMMUNITY_TEXT_REVIEW_SPACE_ID &&
      !!this.config.COMMUNITY_TEXT_REVIEW_REGION_ID &&
      !!this.config.COMMUNITY_TEXT_REVIEW_POLICY_ID &&
      !!this.config.COMMUNITY_TEXT_REVIEW_OPERATOR
    );
  }
  async available(
    space: Pick<CommunitySpace, 'id' | 'operatingRegionId'>,
    tx: PoolClient,
    category?: string,
  ): Promise<boolean> {
    const feedback = category === 'feedback';
    if (!this.configured()) return false;
    if (feedback) {
      if (
        space.id !== this.config.COMMUNITY_FEEDBACK_SPACE_ID ||
        space.operatingRegionId !== null
      )
        return false;
      await requireFeedbackSpace(
        { ...space, kind: 'global', isActive: true, name: 'feedback' },
        tx,
      );
    } else if (
      space.id !== this.config.COMMUNITY_TEXT_REVIEW_SPACE_ID ||
      space.operatingRegionId !== this.config.COMMUNITY_TEXT_REVIEW_REGION_ID
    )
      return false;
    return !!(
      await tx.query(
        `SELECT id FROM whaleu_community.content_approval_policies
      WHERE id=$1 AND policy_key='local-explicit-v1' AND version=1 AND coverage='complete'
      AND provenance='accepted' AND issuer=$2 AND length(btrim(provenance_ref))>0
      AND valid_from<=clock_timestamp() AND (valid_until IS NULL OR valid_until>clock_timestamp()) FOR SHARE`,
        [
          this.config.COMMUNITY_TEXT_REVIEW_POLICY_ID,
          this.config.COMMUNITY_TEXT_REVIEW_OPERATOR,
        ],
      )
    ).rows[0];
  }
  policyId(envelope: EffectiveContentEnvelope): string | undefined {
    return envelope.version === 4
      ? this.config.COMMUNITY_RELATED_REVIEW_POLICY_ID
      : this.config.COMMUNITY_TEXT_REVIEW_POLICY_ID;
  }
  async relatedAvailable(
    space: Pick<CommunitySpace, 'id' | 'operatingRegionId'>,
    tx: PoolClient,
  ): Promise<boolean> {
    if (
      !this.distribution ||
      !this.configured() ||
      !this.config.COMMUNITY_RELATED_REVIEW_POLICY_ID ||
      space.id !== this.config.COMMUNITY_TEXT_REVIEW_SPACE_ID ||
      space.operatingRegionId !== this.config.COMMUNITY_TEXT_REVIEW_REGION_ID
    )
      return false;
    const row = (
      await tx.query<{ valid_until: Date | null }>(
        `SELECT valid_until FROM whaleu_community.content_approval_policies
       WHERE id=$1 AND policy_key='local-related-v1' AND version=1 AND coverage='complete'
       AND provenance='accepted' AND issuer=$2 AND length(btrim(provenance_ref))>0
       AND valid_from<=clock_timestamp() AND (valid_until IS NULL OR valid_until>clock_timestamp()) FOR SHARE`,
        [
          this.config.COMMUNITY_RELATED_REVIEW_POLICY_ID,
          this.config.COMMUNITY_TEXT_REVIEW_OPERATOR,
        ],
      )
    ).rows[0];
    if (!row) return false;
    if (row.valid_until)
      registerTransactionDeadline(
        tx,
        row.valid_until.getTime(),
        'CONTENT_REVIEW_UNAVAILABLE',
      );
    return true;
  }
  async requireEnvelope(
    envelope: EffectiveContentEnvelope,
    tx: PoolClient,
  ): Promise<void> {
    if (envelope.version === 4) {
      if (
        !this.distribution ||
        !(await this.relatedAvailable(
          {
            id: envelope.spaceId,
            operatingRegionId: envelope.scope.originalRegionId,
          },
          tx,
        ))
      )
        throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
      await this.distribution.requireEnvelopeShape(envelope, tx);
      if (
        envelope.scope.sync === 'related' &&
        !(
          await tx.query(
            `SELECT id FROM whaleu_community.related_sync_policies
         WHERE id=$1 AND review_policy_revision_id=$2`,
            [
              envelope.scope.syncPolicyId,
              this.config.COMMUNITY_RELATED_REVIEW_POLICY_ID,
            ],
          )
        ).rows[0]
      )
        throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
      return;
    }
    if (
      (envelope.category !== 'feedback' &&
        (envelope.authorMode !== 'named' || envelope.images.length > 0)) ||
      envelope.component.kind !== 'none' ||
      envelope.trading !== null ||
      envelope.commentsPolicy !== 'open' ||
      (envelope.version === 2 && envelope.allowAnonymousDm) ||
      !(await this.available(
        {
          id: envelope.spaceId,
          operatingRegionId: envelope.scope.originalRegionId,
        },
        tx,
        envelope.category,
      ))
    )
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
  }
  private async storageAvailable(tx: PoolClient): Promise<boolean> {
    // Disabled mode preserves historical schema callers. Enabled mode must have
    // the migration; a missing table is an honest configuration failure.
    if (this.configured()) return true;
    return !!(
      await tx.query<{ present: boolean }>(
        "SELECT to_regclass('whaleu_community.text_review_requests') IS NOT NULL AS present",
      )
    ).rows[0]?.present;
  }
  async request(
    actor: string,
    requestId: string,
    tx: PoolClient,
  ): Promise<TextReviewRequest | null> {
    if (!(await this.storageAvailable(tx))) return null;
    return (
      (
        await tx.query<TextReviewRequest>(
          `SELECT * FROM whaleu_community.text_review_requests
      WHERE account_id=$1 AND client_request_id=$2 FOR SHARE`,
          [actor, requestId],
        )
      ).rows[0] ?? null
    );
  }
  async submit(
    envelope: EffectiveContentEnvelope,
    context: PublicationMediaContext,
    tx: PoolClient,
  ): Promise<TextReviewStatus> {
    await this.requireEnvelope(envelope, tx);
    const digest = approvalDigest(envelope);
    let row = await this.request(
      envelope.accountId,
      context.clientRequestId,
      tx,
    );
    if (!row) {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `whaleu:text-review-budget:v1:${envelope.accountId}`,
      ]);
      const budget = (
        await tx.query<{ active: number; daily: number }>(
          `SELECT
        count(*) FILTER(WHERE p.receipt IS NULL AND q.expires_at>clock_timestamp() AND NOT EXISTS(SELECT 1 FROM whaleu_community.publication_cancel_fences f WHERE f.account_id=q.account_id AND f.client_request_id=q.client_request_id))::integer AS active,
        count(*) FILTER(WHERE q.created_at>=date_trunc('day',clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')::integer AS daily
        FROM whaleu_community.text_review_requests q JOIN whaleu_community.publication_requests p USING(account_id,client_request_id)
        WHERE q.account_id=$1`,
          [envelope.accountId],
        )
      ).rows[0];
      if (!budget || budget.active >= 32 || budget.daily >= 128)
        throw new ApplicationError('RATE_LIMITED');
      await tx.query(
        `INSERT INTO whaleu_community.text_review_requests
        (account_id,client_request_id,operation,intent_hash,envelope,digest)
        VALUES($1,$2,$3,$4,$5::jsonb,$6)`,
        [
          envelope.accountId,
          context.clientRequestId,
          context.operation,
          context.intentHash,
          canonicalJson(envelope),
          digest,
        ],
      );
      row = (await this.request(
        envelope.accountId,
        context.clientRequestId,
        tx,
      ))!;
    }
    if (
      row.operation !== context.operation ||
      row.intent_hash !== context.intentHash ||
      row.digest !== digest ||
      canonicalJson(row.envelope) !== canonicalJson(envelope)
    )
      throw new ApplicationError('REQUEST_CONFLICT');
    return this.status(row, tx);
  }
  async status(
    row: TextReviewRequest,
    tx: PoolClient,
  ): Promise<TextReviewStatus> {
    const result: TextReviewStatus = {
      requestId: row.client_request_id,
      operation: row.operation,
      status: 'unavailable',
    };
    const terminal = (
      await tx.query(
        `SELECT receipt FROM whaleu_community.publication_requests
      WHERE account_id=$1 AND client_request_id=$2 AND receipt IS NOT NULL`,
        [row.account_id, row.client_request_id],
      )
    ).rows[0];
    if (terminal) return { ...result, status: 'settled' };
    if (
      (
        await tx.query(
          `SELECT 1 FROM whaleu_community.publication_cancel_fences WHERE account_id=$1 AND client_request_id=$2`,
          [row.account_id, row.client_request_id],
        )
      ).rows[0]
    )
      return { ...result, status: 'cancelled' };
    if (
      !(
        await tx.query(
          'SELECT 1 FROM whaleu_community.text_review_requests WHERE account_id=$1 AND client_request_id=$2 AND expires_at>clock_timestamp()',
          [row.account_id, row.client_request_id],
        )
      ).rows[0]
    )
      return result;
    try {
      await this.requireEnvelope(row.envelope, tx);
    } catch {
      return result;
    }
    if (!row.decision_id) return { ...result, status: 'pending' };
    if (!(await this.isCurrentDecision(row, tx))) return result;
    const accepted = await this.approvals.accepted(row.envelope, tx);
    if (accepted.kind === 'deny') return { ...result, status: 'rejected' };
    if (
      accepted.kind === 'allow' &&
      accepted.value.decisionId === row.decision_id
    )
      return { ...result, status: 'approved' };
    return result;
  }
  private async isCurrentDecision(
    row: TextReviewRequest,
    tx: PoolClient,
  ): Promise<boolean> {
    const latest = (
      await tx.query<{ id: string }>(
        `SELECT id FROM whaleu_community.content_approval_decisions
      WHERE account_id=$1 AND operation=$2 AND envelope_version=$3 AND digest=$4
      ORDER BY evaluated_at DESC,id DESC LIMIT 1`,
        [row.account_id, row.operation, row.envelope.version, row.digest],
      )
    ).rows[0];
    return !!row.decision_id && latest?.id === row.decision_id;
  }
  async requireRequest(
    envelope: EffectiveContentEnvelope,
    context: PublicationMediaContext,
    tx: PoolClient,
  ): Promise<void> {
    if (!(await this.storageAvailable(tx))) return;
    const row = await this.request(
      envelope.accountId,
      context.clientRequestId,
      tx,
    );
    if (row) {
      if (
        row.intent_hash !== context.intentHash ||
        row.operation !== context.operation ||
        row.digest !== approvalDigest(envelope) ||
        canonicalJson(row.envelope) !== canonicalJson(envelope)
      )
        throw new ApplicationError('REQUEST_CONFLICT');
      await this.requireEnvelope(envelope, tx);
      registerTransactionDeadline(
        tx,
        row.expires_at.getTime(),
        'CONTENT_REVIEW_UNAVAILABLE',
      );
      if (
        !(
          await tx.query(
            'SELECT 1 FROM whaleu_community.text_review_requests WHERE account_id=$1 AND client_request_id=$2 AND expires_at>clock_timestamp()',
            [row.account_id, row.client_request_id],
          )
        ).rows[0] ||
        !(await this.isCurrentDecision(row, tx))
      )
        throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    } else {
      const linked = (
        await tx.query(
          `SELECT 1 FROM whaleu_community.text_review_requests q
        WHERE q.decision_id=(SELECT id FROM whaleu_community.content_approval_decisions
          WHERE account_id=$1 AND operation=$2 AND envelope_version=$3 AND digest=$4
          ORDER BY evaluated_at DESC,id DESC LIMIT 1)`,
          [
            envelope.accountId,
            envelope.purpose,
            envelope.version,
            approvalDigest(envelope),
          ],
        )
      ).rows[0];
      if (linked) throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    }
  }
  async requireBinding(
    envelope: EffectiveContentEnvelope,
    context: PublicationMediaContext,
    accepted: AcceptedApproval | undefined,
    tx: PoolClient,
  ): Promise<void> {
    if (!(await this.storageAvailable(tx))) return;
    const row = await this.request(
      envelope.accountId,
      context.clientRequestId,
      tx,
    );
    if (!row) {
      if (
        accepted &&
        (
          await tx.query(
            'SELECT 1 FROM whaleu_community.text_review_requests WHERE decision_id=$1',
            [accepted.decisionId],
          )
        ).rows[0]
      )
        throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
      return;
    }
    await this.requireEnvelope(envelope, tx);
    if (
      !(
        await tx.query(
          'SELECT 1 FROM whaleu_community.text_review_requests WHERE account_id=$1 AND client_request_id=$2 AND expires_at>clock_timestamp()',
          [row.account_id, row.client_request_id],
        )
      ).rows[0]
    )
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    if (
      row.intent_hash !== context.intentHash ||
      row.operation !== context.operation ||
      row.digest !== approvalDigest(envelope) ||
      canonicalJson(row.envelope) !== canonicalJson(envelope)
    )
      throw new ApplicationError('REQUEST_CONFLICT');
    if (!accepted || accepted.decisionId !== row.decision_id)
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
  }
}
