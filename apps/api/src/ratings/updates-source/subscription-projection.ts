import { RatingScopedNoticeRecipientFacade } from './scoped-recipient.facade.js';
import { Inject, Injectable, Optional } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import { RatingsAccessService } from '../access.js';
import { RatingsRepository } from '../repository.js';
import { RatingDiscussionRepository } from '../discussion-repository.js';
import { RatingDiscussionProjection } from '../discussion-projection.js';
import type { RatingUpdateEligibility } from './projection.js';
import type { RatingSubscriptionSource } from './subscription-contracts.js';
/** At most one recipient authority proof per materialization transaction. */
@Injectable()
export class RatingSubscriptionUpdatesProjectionFacade {
  constructor(
    @Inject(RatingsAccessService) private readonly access: RatingsAccessService,
    @Inject(RatingsRepository) private readonly records: RatingsRepository,
    @Inject(RatingDiscussionRepository)
    private readonly replies: RatingDiscussionRepository,
    @Inject(RatingDiscussionProjection)
    private readonly projection: RatingDiscussionProjection,
    @Optional()
    @Inject(RatingScopedNoticeRecipientFacade)
    private readonly scopedRecipients?: RatingScopedNoticeRecipientFacade,
  ) {}
  async eligible(
    target: RatingSubscriptionSource['target'],
    accountId: string,
    tx: PoolClient,
    epochId?: string,
    eventId?: string,
  ): Promise<RatingUpdateEligibility> {
    try {
      this.records.enable(tx);
      if (eventId && !this.scopedRecipients)
        throw new ApplicationError('RATING_UNAVAILABLE');
      const scoped = eventId
        ? await this.scopedRecipients!.qualify(eventId, accountId, target, tx)
        : false;
      if (!scoped) {
        await this.access.resolveAccount(accountId, target.regionId, tx, {
          phone: true,
        });
        const catalog = await this.records.catalog(target.regionId, tx);
        await this.projection.target(catalog, target.targetId, tx);
      }
      if (epochId !== undefined) {
        const member = (
          await tx.query<{ active_epoch_id: string | null }>(
            'SELECT active_epoch_id FROM whaleu_ratings.subscription_memberships WHERE target_id=$1 AND account_id=$2 FOR SHARE',
            [target.targetId, accountId],
          )
        ).rows[0];
        if (!member)
          return { outcome: 'unavailable', code: 'membership_unavailable' };
        if (member.active_epoch_id !== epochId)
          return { outcome: 'suppressed', code: 'epoch_ended' };
      }
      const root = await this.records.comment(
        target.rootId,
        target.targetId,
        tx,
      );
      const rootAuthor = await this.projection.content(
        root,
        'comment',
        accountId,
        'rating_direct',
        tx,
      );
      if (!rootAuthor)
        return { outcome: 'suppressed', code: 'target_inaccessible' };
      if (target.replyId === null)
        return {
          outcome: 'eligible',
          preview: { text: root.body, author: rootAuthor },
        };
      const reply = await this.replies.reply(
        target.replyId,
        target.rootId,
        target.targetId,
        tx,
      );
      const author = await this.projection.content(
        reply,
        'reply',
        accountId,
        'rating_direct',
        tx,
      );
      return author
        ? { outcome: 'eligible', preview: { text: reply.body, author } }
        : { outcome: 'suppressed', code: 'target_inaccessible' };
    } catch (error) {
      if (error instanceof ApplicationError) {
        return [
          'RATING_NOT_FOUND',
          'RATING_SCOPE_UNAVAILABLE',
          'PHONE_VERIFICATION_REQUIRED',
          'AFFILIATION_VERIFICATION_REQUIRED',
          'IDENTITY_CAMPUS_REQUIRED',
          'SAFETY_ACTION_RESTRICTED',
        ].includes(error.code)
          ? { outcome: 'suppressed', code: 'target_inaccessible' }
          : { outcome: 'unavailable', code: 'authority_unavailable' };
      }
      throw error;
    }
  }
}
