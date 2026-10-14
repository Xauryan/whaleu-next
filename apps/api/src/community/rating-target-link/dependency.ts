import { withRatingReadBudget } from '../../ratings/target-cover-current.js';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import { canonicalEqual, canonicalJson } from '../content-review/contracts.js';
import type { EffectiveContentEnvelope } from '../content-review/contracts.js';
import { RatingTargetLinkFacade } from '../../ratings/target-link/facade.js';
import type { CurrentRatingTargetLink } from '../../ratings/target-link/facade.js';
import type { Decision } from '../community-policy.js';
import type {
  RatingTargetBinding,
  RatingTargetLinkReference,
  ReviewedRatingTargetLink,
  RatingTargetLinkView,
} from './contracts.js';

/** Lazy owner lookup breaks the Review → Ratings → Safety → Review provider
 * cycle. Absence is unknown for new cards, never permission or legacy fallback.
 * The ordinary AppModule installs the real RatingsReadModule owner. */
@Injectable()
export class CurrentRatingLinkDependency {
  constructor(
    @Optional() @Inject(ModuleRef) private readonly modules?: ModuleRef,
  ) {}
  private owner(): RatingTargetLinkFacade {
    const owner = this.modules?.get(RatingTargetLinkFacade, { strict: false });
    if (!owner) throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    return owner;
  }
  publication(
    actor: string,
    input: RatingTargetLinkReference,
    destination: {
      spaceId: string;
      category: 'discussion';
      authorMode: 'named' | 'anonymous';
    },
    tx: PoolClient,
  ) {
    return this.owner().publication(actor, input, destination, tx);
  }
  async requirePublicationEnvelope(
    envelope: EffectiveContentEnvelope,
    tx: PoolClient,
  ): Promise<void> {
    if (envelope.version !== 5) return;
    // The OS-owned local Review CLI has no Nest container. Its SQL owner is the
    // same mandatory exact-current admission enforced again at deferred commit.
    if (!this.modules) {
      const row = (
        await tx.query<{ current: boolean }>(
          'SELECT whaleu_community.rating_target_link_admitted($1::jsonb) current',
          [canonicalJson(envelope)],
        )
      ).rows[0];
      if (row?.current !== true)
        throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
      return;
    }
    const binding = envelope.component.binding;
    const qualified = await this.publication(
      envelope.accountId,
      {
        targetId: binding.targetId,
        selector: binding.selector,
        expectedTargetRevision: binding.targetRevision,
        expectedCategoryRevision: binding.categoryRevision,
        expectedSourceRevision: binding.sourceRevision,
      },
      {
        spaceId: envelope.spaceId,
        category: 'discussion',
        authorMode: envelope.authorMode,
      },
      tx,
    );
    if (!canonicalEqual(binding, qualified.binding))
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
  }
  async currentBatch(
    viewer: string | null,
    bindings: readonly RatingTargetBinding[],
    tx: PoolClient,
    budget?: { consume(bytes: number): void; remainingBytes(): number },
  ): Promise<ReadonlyMap<string, Decision<CurrentRatingTargetLink>>> {
    if (!bindings.length) return new Map();
    try {
      return budget
        ? await withRatingReadBudget(tx, budget, () =>
            this.owner().currentBatch(viewer, bindings, tx),
          )
        : await this.owner().currentBatch(viewer, bindings, tx);
    } catch {
      return new Map(
        bindings.map((binding) => [
          canonicalJson(binding),
          { kind: 'unavailable' } as const,
        ]),
      );
    }
  }
  async current(
    viewer: string | null,
    link: ReviewedRatingTargetLink,
    tx: PoolClient,
  ): Promise<Decision<CurrentRatingTargetLink>> {
    return (
      (await this.currentBatch(viewer, [link.binding], tx)).get(
        canonicalJson(link.binding),
      ) ?? { kind: 'unavailable' }
    );
  }
  async view(
    viewer: string | null,
    link: ReviewedRatingTargetLink,
    tx: PoolClient,
  ): Promise<RatingTargetLinkView> {
    const decision = await this.current(viewer, link, tx);
    if (decision.kind !== 'allow')
      throw new ApplicationError(
        decision.kind === 'deny' ? 'POST_NOT_FOUND' : 'COMMUNITY_UNAVAILABLE',
      );
    return {
      kind: 'rating_target_link',
      label: link.label,
      target: {
        id: link.targetId,
        name: decision.value.name,
        locator: { targetId: link.targetId, selector: decision.value.selector },
      },
    };
  }
}
