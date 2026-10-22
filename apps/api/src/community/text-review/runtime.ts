import { sourceTextAvailable } from '../text-source/protocol.js';
import { CurrentRatingLinkDependency } from '../rating-target-link/dependency.js';
import { requireFeedbackSpace } from '../feedback/topic.js';
import { registerTransactionDeadline } from '../../database/transaction-deadlines.js';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { CommunityDistributionService } from '../related-sync/service.js';
import type { PoolClient } from 'pg';
import { APP_CONFIG } from '../../config/config.js';
import type { RuntimeConfig } from '../../config/config.js';
import { ApplicationError } from '../../http/application-error.js';
import { ApprovalRepository } from '../content-review/approval.repository.js';
import { approvalPolicyKey } from '../content-review/approval-validation.js';
import {
  approvalDigest,
  canonicalEnvelope,
  canonicalEqual,
  canonicalJson,
} from '../content-review/contracts.js';
import type {
  AcceptedApproval,
  EffectiveContentEnvelope,
  EffectiveContentEnvelopeV7,
  EffectiveContentEnvelopeV8,
} from '../content-review/contracts.js';
import type { CommunitySpace } from '../contracts.js';
import type { PublicationMediaContext } from '../../media/batch-protocol.js';
import type { TextReviewRequest, TextReviewStatus } from './contracts.js';

export const HOME_REVIEW_ADMISSION = Symbol('HOME_REVIEW_ADMISSION');
export interface HomeReviewAdmissionGuard {
  requireEnvelope(
    envelope: EffectiveContentEnvelopeV7 | EffectiveContentEnvelopeV8,
    tx: PoolClient,
  ): Promise<void>;
}
const composed = (
  envelope: EffectiveContentEnvelope,
): envelope is EffectiveContentEnvelopeV7 | EffectiveContentEnvelopeV8 =>
  envelope.version === 7 || envelope.version === 8;

@Injectable()
export class TextReviewRuntime {
  constructor(
    @Inject(APP_CONFIG) readonly config: RuntimeConfig,
    @Inject(ApprovalRepository) private readonly approvals: ApprovalRepository,
    @Optional()
    @Inject(CommunityDistributionService)
    private readonly distribution?: CommunityDistributionService,
    @Optional()
    @Inject(CurrentRatingLinkDependency)
    private readonly targetLinks: CurrentRatingLinkDependency = new CurrentRatingLinkDependency(),
    @Optional()
    @Inject(HOME_REVIEW_ADMISSION)
    private readonly homeAdmission?: HomeReviewAdmissionGuard,
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
  /** Source-only explicit human issuer mode. Never enables legacy or related Review. */
  sourceConfigured(): boolean {
    return (
      (this.configured() ||
        this.config.COMMUNITY_TEXT_REVIEW === 'source_manual') &&
      !!this.config.COMMUNITY_TEXT_REVIEW_SPACE_ID &&
      !!this.config.COMMUNITY_TEXT_REVIEW_REGION_ID &&
      !!this.config.COMMUNITY_TEXT_REVIEW_OPERATOR &&
      !!this.config.COMMUNITY_TEXT_SOURCE_REVIEW_POLICY_ID
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
    switch (approvalPolicyKey(envelope)) {
      case 'local-text-source-v1':
        return this.config.COMMUNITY_TEXT_SOURCE_REVIEW_POLICY_ID;
      case 'local-related-v1':
        return this.config.COMMUNITY_RELATED_REVIEW_POLICY_ID;
      case 'local-explicit-v1':
        return this.config.COMMUNITY_TEXT_REVIEW_POLICY_ID;
      default:
        return undefined;
    }
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
  async sourceAvailable(
    space: Pick<CommunitySpace, 'id' | 'operatingRegionId'>,
    tx: PoolClient,
  ): Promise<boolean> {
    if (
      !this.sourceConfigured() ||
      !this.config.COMMUNITY_TEXT_SOURCE_REVIEW_POLICY_ID ||
      space.id !== this.config.COMMUNITY_TEXT_REVIEW_SPACE_ID ||
      space.operatingRegionId !== this.config.COMMUNITY_TEXT_REVIEW_REGION_ID
    )
      return false;
    const row = (
      await tx.query<{ valid_until: Date | null }>(
        `SELECT valid_until FROM whaleu_community.content_approval_policies WHERE id=$1 AND policy_key='local-text-source-v1' AND version=1 AND coverage='complete' AND provenance='accepted' AND issuer=$2 AND length(btrim(provenance_ref))>0 AND valid_from<=clock_timestamp() AND (valid_until IS NULL OR valid_until>clock_timestamp()) FOR SHARE`,
        [
          this.config.COMMUNITY_TEXT_SOURCE_REVIEW_POLICY_ID,
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
    if (approvalPolicyKey(envelope) === null)
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    if (composed(envelope)) {
      try {
        if (!canonicalEqual(envelope, canonicalEnvelope(envelope)))
          throw new Error('Noncanonical composed Review');
      } catch {
        throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
      }
      // These are the existing manual owners' text-only profiles, not a new
      // authority for media, components, anonymous DM or related distribution.
      if (
        !this.homeAdmission ||
        envelope.images.length !== 0 ||
        envelope.scope.sync !== 'none' ||
        envelope.category === 'feedback' ||
        envelope.category === 'trading' ||
        envelope.component.kind !== 'none' ||
        envelope.trading !== null ||
        envelope.commentsPolicy !== 'open' ||
        envelope.allowAnonymousDm === true ||
        (envelope.textSource === null
          ? envelope.authorMode !== 'named'
          : !sourceTextAvailable(envelope.text, envelope.textSource))
      )
        throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
      const space = {
        id: envelope.spaceId,
        operatingRegionId: envelope.scope.originalRegionId,
      };
      const available =
        envelope.textSource === null
          ? await this.available(space, tx, envelope.category)
          : await this.sourceAvailable(space, tx);
      if (!available) throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
      await this.homeAdmission.requireEnvelope(envelope, tx);
      return;
    }
    if (envelope.version === 6) {
      // This locally admitted profile is genuinely text-only. Media remains
      // unavailable until a separate source-aware Media policy is reviewed.
      if (
        envelope.images.length ||
        envelope.scope.sync !== 'none' ||
        envelope.category === 'feedback' ||
        envelope.category === 'trading' ||
        envelope.component.kind !== 'none' ||
        envelope.trading !== null ||
        envelope.commentsPolicy !== 'open' ||
        !sourceTextAvailable(envelope.text, envelope.textSource) ||
        !(await this.sourceAvailable(
          {
            id: envelope.spaceId,
            operatingRegionId: envelope.scope.originalRegionId,
          },
          tx,
        ))
      )
        throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
      return;
    }
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
    if (envelope.version === 5) {
      if (
        envelope.commentsPolicy !== 'open' ||
        !(await this.available(
          {
            id: envelope.spaceId,
            operatingRegionId: envelope.scope.originalRegionId,
          },
          tx,
          'discussion',
        ))
      )
        throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
      await this.targetLinks.requirePublicationEnvelope(envelope, tx);
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
    if (this.configured() || this.sourceConfigured()) return true;
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
    this.requireComposedContext(envelope, context);
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
      (composed(envelope) &&
        (row.account_id !== envelope.accountId ||
          row.client_request_id !== context.clientRequestId ||
          !this.composedRequestMatches(row))) ||
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
    if (
      approvalPolicyKey(row.envelope) === null ||
      (composed(row.envelope) && !this.composedRequestMatches(row))
    )
      return result;
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
  private requireComposedContext(
    envelope: EffectiveContentEnvelope,
    context: PublicationMediaContext,
  ): void {
    if (approvalPolicyKey(envelope) === null)
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    if (
      composed(envelope) &&
      (context.operation !== envelope.purpose ||
        (envelope.version === 7 &&
          context.intentHash !== envelope.home.requestedIntentHash))
    )
      throw new ApplicationError('REQUEST_CONFLICT');
  }
  private composedRequestMatches(row: TextReviewRequest): boolean {
    try {
      const envelope = canonicalEnvelope(row.envelope);
      return (
        composed(envelope) &&
        canonicalEqual(envelope, row.envelope) &&
        row.account_id === envelope.accountId &&
        row.operation === envelope.purpose &&
        row.digest === approvalDigest(envelope) &&
        (envelope.version !== 7 ||
          row.intent_hash === envelope.home.requestedIntentHash)
      );
    } catch {
      return false;
    }
  }
  async requireRequest(
    envelope: EffectiveContentEnvelope,
    context: PublicationMediaContext,
    tx: PoolClient,
  ): Promise<void> {
    this.requireComposedContext(envelope, context);
    if (envelope.version === 6 || composed(envelope))
      await this.requireEnvelope(envelope, tx);
    if (!(await this.storageAvailable(tx))) return;
    const row = await this.request(
      envelope.accountId,
      context.clientRequestId,
      tx,
    );
    if (composed(envelope) && !row)
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    if (row) {
      if (
        (composed(envelope) &&
          (row.account_id !== envelope.accountId ||
            row.client_request_id !== context.clientRequestId ||
            !this.composedRequestMatches(row))) ||
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
    this.requireComposedContext(envelope, context);
    if (envelope.version === 6 || composed(envelope))
      await this.requireEnvelope(envelope, tx);
    if (!(await this.storageAvailable(tx))) return;
    const row = await this.request(
      envelope.accountId,
      context.clientRequestId,
      tx,
    );
    if (!row) {
      if (composed(envelope))
        throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
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
      (composed(envelope) &&
        (row.account_id !== envelope.accountId ||
          row.client_request_id !== context.clientRequestId ||
          !this.composedRequestMatches(row))) ||
      row.intent_hash !== context.intentHash ||
      row.operation !== context.operation ||
      row.digest !== approvalDigest(envelope) ||
      canonicalJson(row.envelope) !== canonicalJson(envelope)
    )
      throw new ApplicationError('REQUEST_CONFLICT');
    if (composed(envelope)) {
      registerTransactionDeadline(
        tx,
        row.expires_at.getTime(),
        'CONTENT_REVIEW_UNAVAILABLE',
      );
      if (!(await this.isCurrentDecision(row, tx)))
        throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    }
    if (
      !accepted ||
      accepted.decisionId !== row.decision_id ||
      (composed(envelope) &&
        (accepted.version !== envelope.version ||
          accepted.digest !== row.digest ||
          !canonicalEqual(accepted.envelope, envelope)))
    )
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
  }
}
