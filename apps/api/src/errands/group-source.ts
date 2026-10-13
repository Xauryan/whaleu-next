import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { IdentityService } from '../identity/identity.service.js';
import { CampusErrandScopeFacade } from '../campus/errand-scope.facade.js';
import { ErrandContentReviewFacade } from '../community/content-review/errand-content-review.facade.js';
import { ApplicationError } from '../http/application-error.js';
import { lockSafetyPolicy } from '../safety/locks.js';
import { ErrandAccessService } from './access.js';
import { ErrandsRepository, errandEnvelope } from './repository.js';
import { ErrandMediaService } from './media/facade.js';
import { requireErrandMediaCurrent } from './media-current-proof.js';
import { requireErrandTargetCurrent } from './target-context-proof.js';
import {
  groupReward,
  groupTitle,
  nativeErrandLocator,
  publicGroupPayloadSchema,
} from '../notifications/errand-group/contracts.js';
import type {
  ErrandGroupSourcePort,
  GroupPublication,
  GroupStage,
} from '../notifications/errand-group/contracts.js';
/** Narrow sessionless source. Private envelope/images never leave this owner.
 * There is no synthetic user session or management grant. */
@Injectable()
export class ErrandGroupSource implements ErrandGroupSourcePort {
  constructor(
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(ErrandAccessService) private readonly access: ErrandAccessService,
    @Inject(ErrandsRepository) private readonly records: ErrandsRepository,
    @Inject(ErrandContentReviewFacade)
    private readonly review: ErrandContentReviewFacade,
    @Inject(ErrandMediaService) private readonly media: ErrandMediaService,
    @Inject(CampusErrandScopeFacade)
    private readonly campuses: CampusErrandScopeFacade,
  ) {}
  async current(
    publication: GroupPublication,
    stage: GroupStage,
    tx: PoolClient,
  ) {
    await lockSafetyPolicy(tx);
    const row = await this.records.read(publication.orderId, tx);
    if (
      !row ||
      row.deleted_at ||
      row.state !== 'pending' ||
      row.target_region_id !== publication.targetRegionId ||
      row.created_at.getTime() !== publication.publishedAt
    )
      throw new ApplicationError('ERRAND_NOT_FOUND');
    const transition = (
      await tx.query(
        `SELECT 1 FROM whaleu_errands.transitions WHERE id=$1 AND order_id=$2 AND operation='publish'`,
        [publication.eventId, row.id],
      )
    ).rows[0];
    if (
      !transition ||
      !(await this.identity.activeAccount(row.publisher_id, tx))
    )
      throw new ApplicationError('ERRAND_NOT_FOUND');
    await this.access.sourceCommon(row.publisher_id, tx);
    await this.access.feature(row.publisher_id, 'publish', tx);
    if (
      (await this.review.current(row.id, errandEnvelope(row), tx)).kind !==
      'allow'
    )
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    if (row.media) {
      await this.media.currentFacts(
        row.id,
        row.media.revision,
        [...row.media.publicMedia, ...row.media.privateMedia],
        tx,
      );
      await requireErrandMediaCurrent('order', row.id, tx);
    }
    const scope = await this.campuses.project(
      row.source_region_id,
      row.target_region_id,
      tx,
    );
    await requireErrandTargetCurrent(row.id, tx);
    return publicGroupPayloadSchema.parse({
      title: groupTitle(row.title, stage),
      reward: groupReward(row.reward),
      ...(stage === 'errand'
        ? { expectedTime: row.expected_time_text || '尽快' }
        : {}),
      sourceLabel:
        scope.scope === 'home'
          ? null
          : `${scope.scope === 'related' ? '跨地区' : '跨校'}：${scope.sourceRegion.label}`,
      locator: nativeErrandLocator(row.id),
    });
  }
}
