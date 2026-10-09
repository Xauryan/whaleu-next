import { AuthorDisplayService } from '../../profile/author-display.service.js';
import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.js';
import { ApplicationError } from '../../http/application-error.js';
import { RatingsAccessService } from '../access.js';
import { RatingEffectsCapture } from '../effects/capture.js';
import { RatingLikeSubjectFacade } from './subject.facade.js';
import { RatingLikesRepository } from './repository.js';
import { RatingLikeRequests } from './requests.js';
import { ratingLikeStateSchema } from './contracts.js';
import type { SetRatingCommentLike, SetRatingReplyLike } from './contracts.js';
@Injectable()
export class RatingLikesService {
  constructor(
    @Inject(AuthorDisplayService)
    private readonly authors: AuthorDisplayService,
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(RatingsAccessService) private readonly access: RatingsAccessService,
    @Inject(RatingLikeSubjectFacade)
    private readonly subjects: RatingLikeSubjectFacade,
    @Inject(RatingLikesRepository)
    private readonly records: RatingLikesRepository,
    @Inject(RatingLikeRequests) private readonly requests: RatingLikeRequests,
    @Inject(RatingEffectsCapture)
    private readonly effects: RatingEffectsCapture,
  ) {}
  state(
    token: string,
    kind: 'comment' | 'reply',
    id: string,
    regionId: string | null,
  ) {
    return this.db.transaction(
      async (tx) => {
        const c = await this.subjects.resolve(token, kind, id, regionId, tx),
          state = await this.records.state(id, c.actor, tx);
        if (state) this.records.retain(state, c.actor, tx);
        await this.access.recheck(token, tx);
        return ratingLikeStateSchema.parse(
          state
            ? {
                status: 'known',
                targetId: c.target.row.id,
                rootId: c.root.id,
                replyId: kind === 'reply' ? id : null,
                count: state.count,
                liked: state.liked,
                revision: state.revision,
                allowedActions: { setLike: true },
              }
            : { status: 'unavailable' },
        );
      },
      { isolationLevel: 'read committed' },
    );
  }
  set(
    token: string,
    kind: 'comment' | 'reply',
    id: string,
    command: SetRatingCommentLike | SetRatingReplyLike,
  ) {
    const operation =
      kind === 'comment' ? 'set_comment_like' : 'set_reply_like';
    return this.requests.execute(
      token,
      command.clientRequestId,
      operation,
      { [kind === 'comment' ? 'rootId' : 'replyId']: id, ...command },
      async (actor, tx) => {
        const c = await this.subjects.resolve(
          token,
          kind,
          id,
          command.regionId,
          tx,
          true,
          command,
        );
        if (
          c.target.row.revision !== command.expectedTargetRevision ||
          c.subject.revision !== command.expectedRevision ||
          ('expectedRootRevision' in command &&
            c.root.revision !== command.expectedRootRevision)
        )
          throw new ApplicationError('RATING_REVISION_CONFLICT');
        const result = await this.records.set(
          id,
          actor,
          command.clientRequestId,
          command.expectedLikeRevision,
          command.liked,
          tx,
        );
        if (result.outcome === 'applied' && result.liked) {
          await this.authors.prepare(actor, tx);
          await this.effects.captureLiked(actor, command.clientRequestId, tx);
        }
        return {
          ...result,
          targetId: c.target.row.id,
          rootId: c.root.id,
          replyId: kind === 'reply' ? id : null,
        };
      },
    );
  }
  receipt(token: string, id: string) {
    return this.requests.receipt(token, id);
  }
}
