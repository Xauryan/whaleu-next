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
    target: {
      kind: 'post' | 'comment' | 'reply' | 'formation_member';
      id: string;
    },
    viewerAccountId: string,
    tx: PoolClient,
  ): Promise<{
    accountId: string;
    operatingRegionId: string | null;
    authorMode: AuthorMode;
  } | null> {
    try {
      if (target.kind === 'formation_member') {
        // Resolve only a stored membership, never a caller-supplied actor/parent.
        // Reference lookup holds no child lock: parent precedes formation/member.
        const reference = (
          await tx.query<{ post_id: string }>(
            'SELECT f.post_id FROM whaleu_community.formation_members m JOIN whaleu_community.formations f ON f.id=m.formation_id WHERE m.id=$1',
            [target.id],
          )
        ).rows[0];
        if (!reference) return null;
        const { post, space } = await this.access.accessiblePost(
          reference.post_id,
          viewerAccountId,
          tx,
        );
        const member = (
          await tx.query<{ account_id: string; is_creator: boolean }>(
            'SELECT m.account_id,m.is_creator FROM whaleu_community.formation_members m JOIN whaleu_community.formations f ON f.id=m.formation_id WHERE m.id=$1 AND f.post_id=$2 FOR SHARE OF f,m',
            [target.id, post.id],
          )
        ).rows[0];
        if (
          !member ||
          !(await this.access.visible(
            viewerAccountId,
            member.is_creator
              ? post
              : {
                  ...post,
                  id: target.id,
                  account_id: member.account_id,
                  author_mode: 'named',
                },
            tx,
            'list_projection',
          ))
        )
          return null;
        return {
          accountId: member.account_id,
          operatingRegionId: space.operatingRegionId,
          authorMode: member.is_creator ? post.author_mode : 'named',
        };
      }
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
      if (
        !(await this.access.visible(
          viewerAccountId,
          comment,
          tx,
          'list_projection',
        ))
      )
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
