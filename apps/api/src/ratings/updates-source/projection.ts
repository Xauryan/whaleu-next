import { canonicalRatingDiscussionMediaEnvelope } from '../../community/content-review/rating-discussion-media-contracts.js';
import {
  ratingDiscussionMaterializationPreviewSchema,
  type RatingDiscussionMaterializationPreview,
} from '../../notifications/ratings/discussion-media-contracts.js';
import { RatingScopedNoticeRecipientFacade } from './scoped-recipient.facade.js';
import { Inject, Injectable, Optional } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import { RatingsAccessService } from '../access.js';
import { RatingsRepository } from '../repository.js';
import { RatingDiscussionRepository } from '../discussion-repository.js';
import { RatingDiscussionProjection } from '../discussion-projection.js';
import type { RatingComment } from '../contracts.js';
import type {
  RatingUpdateTarget,
  RatingUpdateRecipient,
  RatingLikeUpdateTarget,
  RatingLikeUpdateRecipient,
} from './facade.js';
import { RatingSafetyFacade } from '../../safety/rating.facade.js';
import { AuthorDisplayService } from '../../profile/author-display.service.js';
export type RatingUpdateEligibility =
  | {
      outcome: 'eligible';
      mediaPreview?: RatingDiscussionMaterializationPreview;
      preview: { text: string; author: RatingComment['author'] };
    }
  | { outcome: 'suppressed' | 'unavailable'; code: string };
export type RatingLikeUpdateEligibility =
  | {
      outcome: 'eligible';
      mediaPreview?: RatingDiscussionMaterializationPreview;
      preview: { text: string };
      actor: Extract<RatingComment['author'], { mode: 'named' }>;
    }
  | { outcome: 'suppressed' | 'unavailable'; code: string };
export function ratingMaterializationMediaPreview(raw: unknown): {
  mediaPreview?: RatingDiscussionMaterializationPreview;
} {
  if (
    typeof raw !== 'object' ||
    raw === null ||
    !('version' in raw) ||
    raw.version !== 7
  )
    return {};
  const envelope = canonicalRatingDiscussionMediaEnvelope(raw);
  return {
    mediaPreview: ratingDiscussionMaterializationPreviewSchema.parse({
      protocolVersion: 4,
      body: envelope.body,
      imageCount: envelope.images.length,
      attachmentSetDigest: envelope.attachmentSetDigest,
    }),
  };
}
@Injectable()
export class RatingUpdatesProjectionFacade {
  constructor(
    @Inject(RatingsAccessService) private readonly access: RatingsAccessService,
    @Inject(RatingsRepository) private readonly records: RatingsRepository,
    @Inject(RatingDiscussionRepository)
    private readonly replies: RatingDiscussionRepository,
    @Inject(RatingDiscussionProjection)
    private readonly projection: RatingDiscussionProjection,
    @Inject(RatingSafetyFacade) private readonly safety: RatingSafetyFacade,
    @Inject(AuthorDisplayService)
    private readonly authors: AuthorDisplayService,
    @Optional()
    @Inject(RatingScopedNoticeRecipientFacade)
    private readonly scopedRecipients?: RatingScopedNoticeRecipientFacade,
  ) {}
  async eligible(
    target: RatingUpdateTarget,
    recipient: RatingUpdateRecipient,
    tx: PoolClient,
    eventId?: string,
  ): Promise<RatingUpdateEligibility> {
    try {
      this.records.enable(tx);
      if (eventId && !this.scopedRecipients)
        throw new ApplicationError('RATING_UNAVAILABLE');
      const scoped = eventId
        ? await this.scopedRecipients!.qualify(
            eventId,
            recipient.accountId,
            target,
            tx,
          )
        : false;
      if (!scoped) {
        await this.access.resolveAccount(
          recipient.accountId,
          target.regionId,
          tx,
          { phone: true },
        );
        const catalog = await this.records.catalog(target.regionId, tx);
        await this.projection.target(catalog, target.targetId, tx);
      }
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
      return {
        outcome: 'eligible',
        preview: { text: row.body, author },
        ...ratingMaterializationMediaPreview(row.envelope),
      };
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
  async eligibleLike(
    target: RatingLikeUpdateTarget,
    recipient: RatingLikeUpdateRecipient,
    actorAccountId: string,
    tx: PoolClient,
    eventId?: string,
  ): Promise<RatingLikeUpdateEligibility> {
    try {
      this.records.enable(tx);
      if (eventId && !this.scopedRecipients)
        throw new ApplicationError('RATING_UNAVAILABLE');
      const scoped = eventId
        ? await this.scopedRecipients!.qualify(
            eventId,
            recipient.accountId,
            target,
            tx,
          )
        : false;
      if (!scoped) {
        await this.access.resolveAccount(
          recipient.accountId,
          target.regionId,
          tx,
          { phone: true },
        );
        const catalog = await this.records.catalog(target.regionId, tx);
        await this.projection.target(catalog, target.targetId, tx);
      }
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
      const subject =
        target.replyId === null
          ? root
          : await this.replies.reply(
              target.replyId,
              target.rootId,
              target.targetId,
              tx,
            );
      if (subject.account_id !== recipient.accountId)
        throw new ApplicationError('RATING_UNAVAILABLE');
      if (
        target.replyId !== null &&
        !(await this.projection.content(
          subject,
          'reply',
          recipient.accountId,
          'rating_direct',
          tx,
        ))
      )
        return { outcome: 'suppressed', code: 'target_inaccessible' };
      // Unlike is deliberately irrelevant: a captured notice survives membership changes.
      const safety = await this.safety.named(
        recipient.accountId,
        actorAccountId,
        'rating_direct',
        tx,
      );
      if (safety.kind === 'deny')
        return { outcome: 'suppressed', code: 'target_inaccessible' };
      if (safety.kind !== 'allow')
        return { outcome: 'unavailable', code: 'authority_unavailable' };
      const profile = await this.authors.findRatingPublic(actorAccountId, tx);
      if (!profile)
        return { outcome: 'unavailable', code: 'authority_unavailable' };
      return {
        outcome: 'eligible',
        actor: { mode: 'named', ...profile },
        preview: { text: subject.body },
        ...ratingMaterializationMediaPreview(subject.envelope),
      };
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
