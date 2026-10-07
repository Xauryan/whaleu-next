import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import { CommunityAccessService } from './community-access.service.js';
import { CommunityRepository } from './community.repository.js';
import type { AuthorMode } from './contracts.js';
/** Internal-only facade for a separately authorized and audited privileged use case. */
@Injectable()
export class CommunityContentIdentityService {
  constructor(
    @Inject(CommunityRepository)
    private readonly repository: CommunityRepository,
    @Inject(CommunityAccessService)
    private readonly access: CommunityAccessService,
  ) {}
  async resolve(
    target: { kind: 'post' | 'comment' | 'reply'; id: string },
    viewerAccountId: string,
    tx: PoolClient,
  ): Promise<{
    accountId: string;
    operatingRegionId: string | null;
    authorMode: AuthorMode;
  } | null> {
    try {
      if (target.kind === 'post') {
        const { post, space } = await this.access.accessiblePost(
          target.id,
          viewerAccountId,
          tx,
        );
        return {
          accountId: post.account_id,
          operatingRegionId: space.operatingRegionId,
          authorMode: post.author_mode,
        };
      }
      if (target.kind === 'reply') {
        const { reply, space } = await this.access.accessibleReply(
          target.id,
          viewerAccountId,
          tx,
        );
        return {
          accountId: reply.account_id,
          operatingRegionId: space.operatingRegionId,
          authorMode: reply.author_mode,
        };
      }
      const reference = await this.repository.comment(target.id, tx);
      const { space } = await this.access.accessiblePost(
        reference.post_id,
        viewerAccountId,
        tx,
      );
      const comment = await this.repository.comment(target.id, tx, true);
      if (!(await this.access.visible(viewerAccountId, comment, tx)))
        return null;
      return {
        accountId: comment.account_id,
        operatingRegionId: space.operatingRegionId,
        authorMode: comment.author_mode,
      };
    } catch (error) {
      if (
        error instanceof ApplicationError &&
        [
          'POST_NOT_FOUND',
          'COMMENT_NOT_FOUND',
          'REPLY_NOT_FOUND',
          'COMMUNITY_SCOPE_UNAVAILABLE',
        ].includes(error.code)
      )
        return null;
      throw error;
    }
  }
}
