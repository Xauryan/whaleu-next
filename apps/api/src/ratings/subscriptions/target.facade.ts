import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { RatingsAccessService } from '../access.js';
import { RatingsRepository } from '../repository.js';
import { RatingDiscussionProjection } from '../discussion-projection.js';
@Injectable()
export class RatingSubscriptionTargetFacade {
  constructor(
    @Inject(RatingsAccessService) private readonly access: RatingsAccessService,
    @Inject(RatingsRepository) private readonly records: RatingsRepository,
    @Inject(RatingDiscussionProjection)
    private readonly projection: RatingDiscussionProjection,
  ) {}
  async scope(token: string, regionId: string | null, tx: PoolClient) {
    this.records.enable(tx);
    const access = await this.access.resolve(token, regionId, tx, {
      phone: true,
    });
    const catalog = await this.records.catalog(regionId, tx);
    return { actor: access.session.accountId, catalog };
  }
  async resolve(
    token: string,
    id: string,
    regionId: string | null,
    tx: PoolClient,
    write = false,
  ) {
    const scope = await this.scope(token, regionId, tx);
    const target = await this.projection.target(scope.catalog, id, tx, write);
    return { ...scope, target };
  }
  target(
    catalog: Awaited<
      ReturnType<RatingSubscriptionTargetFacade['scope']>
    >['catalog'],
    id: string,
    tx: PoolClient,
  ) {
    return this.projection.target(catalog, id, tx);
  }
}
