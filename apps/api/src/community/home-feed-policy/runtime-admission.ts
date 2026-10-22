import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import { ApprovalRepository } from '../content-review/approval.repository.js';
import { ContentDefinitionRepository } from '../content-review/content-definition.repository.js';
import {
  canonicalEnvelope,
  canonicalEqual,
} from '../content-review/contracts.js';
import type {
  EffectiveContentEnvelopeV7,
  EffectiveContentEnvelopeV8,
} from '../content-review/contracts.js';
import type { HomeReviewAdmissionGuard } from '../text-review/runtime.js';
import { requireCurrentHomeParent } from './parent-proof.js';

/** Leaf current facts only. This does not replace publication/access owners or
 * approve content. The formal SQL protocol independently fences activation,
 * original/effective scopes and actor/parent/source dependencies in the same TX. */
@Injectable()
export class CurrentHomeReviewAdmission implements HomeReviewAdmissionGuard {
  constructor(
    @Inject(ApprovalRepository) private readonly approvals: ApprovalRepository,
    @Inject(ContentDefinitionRepository)
    private readonly definitions: ContentDefinitionRepository,
  ) {}
  async requireEnvelope(
    envelope: EffectiveContentEnvelopeV7 | EffectiveContentEnvelopeV8,
    tx: PoolClient,
  ): Promise<void> {
    const unavailable = () =>
      new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    const canonical = canonicalEnvelope(envelope);
    if (
      (canonical.version !== 7 && canonical.version !== 8) ||
      !canonicalEqual(canonical, envelope)
    )
      throw unavailable();
    if (canonical.version === 8) {
      if (!canonical.postId) throw unavailable();
      const parent = await requireCurrentHomeParent(
        canonical.postId,
        tx,
        this.approvals,
        this.definitions,
        canonical.homeParent,
      );
      if (
        parent.envelope.spaceId !== canonical.spaceId ||
        parent.envelope.category !== canonical.category ||
        parent.envelope.scope.originalSpaceId !==
          canonical.scope.originalSpaceId ||
        parent.envelope.scope.originalRegionId !==
          canonical.scope.originalRegionId ||
        canonical.scope.sync !== 'none'
      )
        throw unavailable();
    }
    await assertHomeReviewAdmission(canonical, tx);
  }
}

/** CLI uses the same authoritative SQL closure without constructing an API app.
 * No network, synthetic parent, or optional-success fallback is introduced. */
export async function assertHomeReviewAdmission(
  envelope: EffectiveContentEnvelopeV7 | EffectiveContentEnvelopeV8,
  tx: PoolClient,
): Promise<void> {
  const canonical = canonicalEnvelope(envelope);
  const unavailable = () => new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
  if (
    (canonical.version !== 7 && canonical.version !== 8) ||
    !canonicalEqual(canonical, envelope)
  )
    throw unavailable();
  const result = await tx.query<{ admitted: boolean }>(
    `SELECT whaleu_community.home_review_admitted($1::jsonb) AS admitted`,
    [JSON.stringify(canonical)],
  );
  if (result.rows.length !== 1 || result.rows[0]?.admitted !== true)
    throw unavailable();
}
