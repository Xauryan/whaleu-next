import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import { RatingsAccessService } from '../access.js';
import { RatingsRepository } from '../repository.js';
import { RatingDiscussionRepository } from '../discussion-repository.js';
import { RatingDiscussionProjection } from '../discussion-projection.js';
import type { RatingComment } from '../contracts.js';
import type { RatingUpdateTarget, RatingUpdateRecipient } from './facade.js';
export type RatingUpdateEligibility =
  | {
      outcome: 'eligible';
      preview: { text: string; author: RatingComment['author'] };
    }
  | { outcome: 'suppressed' | 'unavailable'; code: string };
@Injectable()
export class RatingUpdatesProjectionFacade {
  constructor(
    @Inject(RatingsAccessService) private readonly access: RatingsAccessService,
    @Inject(RatingsRepository) private readonly records: RatingsRepository,
    @Inject(RatingDiscussionRepository)
    private readonly replies: RatingDiscussionRepository,
    @Inject(RatingDiscussionProjection)
    private readonly projection: RatingDiscussionProjection,
  ) {}
  async eligible(
    target: RatingUpdateTarget,
    recipient: RatingUpdateRecipient,
    tx: PoolClient,
  ): Promise<RatingUpdateEligibility> {
    try {
      this.records.enable(tx);
      await this.access.resolveAccount(
        recipient.accountId,
        target.regionId,
        tx,
        { phone: true },
      );
      const catalog = await this.records.catalog(target.regionId, tx);
      await this.projection.target(catalog, target.targetId, tx);
      const root = await this.records.comment(
        target.rootId,
        target.targetId,
        tx,
      );
      if (
        !(await this.projection.content(
          root,
          'comment',
          recipient.accountId,
          'rating_direct',
          tx,
        ))
      )
        return { outcome: 'suppressed', code: 'target_inaccessible' };
      const row = await this.replies.reply(
        target.replyId,
        target.rootId,
        target.targetId,
        tx,
      );
      const author = await this.projection.content(
        row,
        'reply',
        recipient.accountId,
        'rating_direct',
        tx,
      );
      if (!author)
        return { outcome: 'suppressed', code: 'target_inaccessible' };
      return { outcome: 'eligible', preview: { text: row.body, author } };
    } catch (e) {
      if (e instanceof ApplicationError) {
        if (
          [
            'RATING_NOT_FOUND',
            'RATING_SCOPE_UNAVAILABLE',
            'PHONE_VERIFICATION_REQUIRED',
            'AFFILIATION_VERIFICATION_REQUIRED',
            'IDENTITY_CAMPUS_REQUIRED',
            'SAFETY_ACTION_RESTRICTED',
          ].includes(e.code)
        )
          return { outcome: 'suppressed', code: 'target_inaccessible' };
        return { outcome: 'unavailable', code: 'authority_unavailable' };
      }
      throw e;
    }
  }
}
