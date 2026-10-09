import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import { RatingsAccessService } from '../access.js';
import { RatingsRepository } from '../repository.js';
import { RatingDiscussionRepository } from '../discussion-repository.js';
import { RatingDiscussionProjection } from '../discussion-projection.js';
@Injectable()
export class RatingLikeSubjectFacade {
  constructor(
    @Inject(RatingsAccessService) private readonly access: RatingsAccessService,
    @Inject(RatingsRepository) private readonly records: RatingsRepository,
    @Inject(RatingDiscussionRepository)
    private readonly replies: RatingDiscussionRepository,
    @Inject(RatingDiscussionProjection)
    private readonly projection: RatingDiscussionProjection,
  ) {}
  async resolve(
    token: string,
    kind: 'comment' | 'reply',
    id: string,
    regionId: string | null,
    tx: PoolClient,
    write = false,
    expected?: { targetId: string; rootId?: string },
  ) {
    this.records.enable(tx);
    const access = await this.access.resolve(token, regionId, tx, {
      phone: true,
    });
    const hint =
      kind === 'reply'
        ? await this.replies.ancestry(id, tx)
        : { root_id: id, target_id: await this.records.commentTarget(id, tx) };
    if (
      expected &&
      (hint.target_id !== expected.targetId ||
        (expected.rootId !== undefined && hint.root_id !== expected.rootId))
    )
      throw new ApplicationError('RATING_NOT_FOUND');
    const catalog = await this.records.catalog(regionId, tx);
    const target = await this.projection.target(
      catalog,
      hint.target_id,
      tx,
      write,
    );
    const root = await this.records.comment(
      hint.root_id,
      hint.target_id,
      tx,
      write,
    );
    if (
      !(await this.projection.content(
        root,
        'comment',
        access.session.accountId,
        'rating_direct',
        tx,
      ))
    )
      throw new ApplicationError('RATING_NOT_FOUND');
    const subject =
      kind === 'comment'
        ? root
        : await this.replies.reply(id, root.id, target.row.id, tx, write);
    if (
      kind === 'reply' &&
      !(await this.projection.content(
        subject,
        'reply',
        access.session.accountId,
        'rating_direct',
        tx,
      ))
    )
      throw new ApplicationError('RATING_NOT_FOUND');
    // Quoted reply-to is not an ancestor of the subject being liked.
    if (write) {
      this.records.retainComment(root, tx);
      if (kind === 'reply') this.records.retainReply(subject, tx);
    }
    return {
      access,
      catalog,
      target,
      root,
      subject,
      kind,
      actor: access.session.accountId,
    };
  }
}
