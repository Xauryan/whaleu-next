import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import { RatingContentReviewFacade } from '../../community/content-review/rating-content-review.facade.js';
import type { AnyRatingTargetDefinitionDescriptor } from '../../community/content-review/rating-target-definition-contracts.js';
import { RatingsAccessService } from '../access.js';
import { RatingsRepository } from '../repository.js';
import type { CommentRow, CurrentTargetRow } from '../repository.js';
import type { ReplyRow } from '../discussion-repository.js';
import { RatingDiscussionProjection } from '../discussion-projection.js';
import { ratingTargetSchema } from '../contracts.js';
import type { RatingComment } from '../contracts.js';
import type { RatingReply } from '../discussion-contracts.js';

export type RatingScopedCurrentTargetRow = Omit<
  CurrentTargetRow,
  'definition' | 'envelope'
> & {
  definition: AnyRatingTargetDefinitionDescriptor;
  envelope: AnyRatingTargetDefinitionDescriptor['envelope'];
};
export interface RatingScopedProjectionActor {
  readonly accountId: string;
  readonly mode: 'public' | 'admin_preview';
}
/** Only scope selection is new. Author privacy, named bilateral Safety, persona
 * identity, Review, score summaries and reply quote semantics retain their owners. */
@Injectable()
export class RatingScopedProjection {
  constructor(
    @Inject(RatingContentReviewFacade)
    private readonly review: RatingContentReviewFacade,
    @Inject(RatingsAccessService) private readonly access: RatingsAccessService,
    @Inject(RatingsRepository) private readonly records: RatingsRepository,
    @Inject(RatingDiscussionProjection)
    private readonly discussion: RatingDiscussionProjection,
  ) {}
  async qualifyTarget(
    row: RatingScopedCurrentTargetRow,
    tx: PoolClient,
  ): Promise<RatingScopedCurrentTargetRow> {
    const envelope = row.definition.envelope;
    if (
      row.id !== row.definition.targetId ||
      row.category_id !== envelope.categoryId ||
      row.creator_id !== envelope.accountId ||
      row.name !== envelope.name ||
      row.description !== envelope.description ||
      row.region_id !==
        (envelope.version === 5 || envelope.version === 6
          ? envelope.targetOrigin.regionId
          : envelope.scope.regionId)
    )
      throw new ApplicationError('RATING_UNAVAILABLE');
    const decision = await this.review.currentTargetDefinition(
      row.definition,
      tx,
    );
    if (decision.kind === 'deny')
      throw new ApplicationError('RATING_NOT_FOUND');
    if (decision.kind !== 'allow')
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    return row;
  }
  async target(
    row: RatingScopedCurrentTargetRow,
    actor: RatingScopedProjectionActor,
    tx: PoolClient,
  ) {
    await this.qualifyTarget(row, tx);
    const summary = await this.records.summary(row.id, tx);
    return ratingTargetSchema.parse({
      id: row.id,
      categoryId: row.category_id,
      name: row.name,
      description: row.description,
      revision: row.revision,
      allowedActions: {
        setScore: actor.mode === 'public' && summary.status === 'known',
        createComment: actor.mode === 'public',
        authorModes: await this.access.authorModes(actor.accountId, tx),
      },
    });
  }
  async canReply(
    row: CommentRow,
    actor: RatingScopedProjectionActor,
    tx: PoolClient,
  ): Promise<boolean> {
    return this.discussion.canReply(row, actor.accountId, tx);
  }
  async content(
    row: CommentRow,
    kind: 'comment' | 'reply',
    actor: RatingScopedProjectionActor,
    purpose: 'rating_list' | 'rating_direct',
    tx: PoolClient,
  ) {
    return this.discussion.content(row, kind, actor.accountId, purpose, tx);
  }
  async root(
    row: CommentRow,
    actor: RatingScopedProjectionActor,
    purpose: 'rating_list' | 'rating_direct',
    tx: PoolClient,
  ): Promise<RatingComment | null> {
    return this.discussion.root(row, actor.accountId, purpose, tx);
  }
  async reply(
    row: ReplyRow,
    actor: RatingScopedProjectionActor,
    rootCanReply: boolean,
    purpose: 'rating_list' | 'rating_direct',
    tx: PoolClient,
  ): Promise<RatingReply | null> {
    return this.discussion.reply(
      row,
      actor.accountId,
      rootCanReply && actor.mode === 'public',
      purpose,
      tx,
    );
  }
}
