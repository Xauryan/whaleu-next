import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import { canonicalJson } from '../../community/content-review/contracts.js';
import { canonicalRatingScopedCategorySource } from '../../community/content-review/rating-scoped-contracts.js';
import { RatingScopedContentReviewFacade } from '../../community/content-review/rating-scoped-content-review.facade.js';
import type { CategoryManagementPlan } from './plan.js';

/** Only exact prepared category derivatives; never topology, grants, policy or target placement. */
@Injectable()
export class RatingCategorySourceIssuer {
  constructor(
    @Inject(RatingScopedContentReviewFacade)
    private readonly review: RatingScopedContentReviewFacade,
  ) {}
  async issue(plan: CategoryManagementPlan, tx: PoolClient) {
    const approvals = [];
    for (const envelope of plan.envelopes)
      approvals.push(await this.review.accepted(envelope, tx));
    for (const item of plan.sourceIssues) {
      const result = await tx.query(
        `INSERT INTO whaleu_ratings.scoped_source_attestations(id,revision,source_kind,source_key,scope_keys,payload,digest,coverage,provenance,issuer,source_reference,policy_reference,effective_at,valid_until)
   SELECT $1,$2,$3,$4,$5::text[],$6::jsonb,whaleu_ratings.scoped_digest('source',jsonb_build_object('id',$1::uuid,'revision',$2::uuid,'kind',$3::text,'key',$4::text,'scopeKeys',$5::text[],'payload',$6::jsonb)),'complete','accepted','ratings-category-management',$7,policy.policy_reference,
   greatest(clock_timestamp(),coalesce(previous.effective_at,clock_timestamp()-interval '1 second')+interval '1 microsecond'),least($8::timestamptz,policy.valid_until)
   FROM whaleu_ratings.scoped_source_attestations policy LEFT JOIN whaleu_ratings.scoped_source_attestations previous ON previous.id=$9 AND previous.revision=$10
   WHERE policy.id=$11 AND policy.revision=$12 AND whaleu_ratings.scoped_source_current(policy.id,policy.revision,clock_timestamp())`,
        [
          item.id,
          item.revision,
          item.kind,
          item.key,
          item.scopeKeys,
          canonicalJson(item.payload),
          `rating-category-management:${plan.accountId}:${plan.requestId}`,
          plan.validUntil,
          item.previousSourceId,
          item.previousSourceRevision,
          plan.policySourceId,
          plan.policySourceRevision,
        ],
      );
      if (result.rowCount !== 1)
        throw new ApplicationError('RATING_SCOPE_UNAVAILABLE');
      const changed = await tx.query(
        `INSERT INTO whaleu_ratings.scoped_source_heads(source_kind,source_key,source_id,source_revision) VALUES($1,$2,$3,$4)
   ON CONFLICT(source_kind,source_key) DO UPDATE SET source_id=excluded.source_id,source_revision=excluded.source_revision
   WHERE scoped_source_heads.source_id=$5 AND scoped_source_heads.source_revision=$6`,
        [
          item.kind,
          item.key,
          item.id,
          item.revision,
          item.previousSourceId,
          item.previousSourceRevision,
        ],
      );
      if (changed.rowCount !== 1)
        throw new ApplicationError('RATING_SCOPED_CONTEXT_CHANGED');
      if (item.placement)
        await tx.query(
          `INSERT INTO whaleu_ratings.category_scope_placements(placement_revision,category_id,base_source_id,base_source_revision,scope_keys,source_id,source_revision) VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [
            item.placement.revision,
            item.placement.categoryId,
            item.placement.baseSourceId,
            item.placement.baseSourceRevision,
            item.scopeKeys,
            item.id,
            item.revision,
          ],
        );
    }
    for (const [n, envelope] of plan.envelopes.entries())
      await this.review.bind(
        approvals[n]!,
        {
          kind: 'category',
          source: canonicalRatingScopedCategorySource({
            sourceId: envelope.sourceId,
            sourceRevision: envelope.sourceRevision,
            categoryId: envelope.categoryId,
            envelope,
          }),
        },
        tx,
      );
  }
}
