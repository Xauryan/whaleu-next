import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import { FeedbackNoticeTargetSource } from '../../notifications/feedback/contracts.js';
import { CommunityAccessService } from '../community-access.service.js';
import { requireFeedbackSpace } from './topic.js';
@Injectable()
export class CommunityFeedbackNoticeTargetSource extends FeedbackNoticeTargetSource {
  constructor(
    @Inject(CommunityAccessService)
    private readonly access: CommunityAccessService,
  ) {
    super();
  }
  async accessible(
    accountId: string,
    postId: string,
    tx: PoolClient,
  ): Promise<boolean> {
    try {
      const { post, space } = await this.access.projectionPost(
        postId,
        accountId,
        tx,
      );
      if (post.category !== 'feedback') return false;
      await requireFeedbackSpace(space, tx);
      return true;
    } catch (error) {
      if (
        error instanceof ApplicationError &&
        [
          'POST_NOT_FOUND',
          'POST_BLOCKED_BY_YOU',
          'COMMUNITY_SCOPE_UNAVAILABLE',
        ].includes(error.code)
      )
        return false;
      throw error;
    }
  }
}
