import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import type { NamedBlockSource } from '../safety/contracts.js';
import { CommunityAccessService } from './community-access.service.js';
/** Safety's ONLY content-owner resolver. An anonymous content reference never
 * leaves this owner with a private account, profile or hidden-author projection. */
@Injectable()
export class CommunityNamedBlockSourceFacade {
  constructor(
    @Inject(CommunityAccessService)
    private readonly access: CommunityAccessService,
  ) {}
  async resolve(
    source: NamedBlockSource,
    actor: string,
    tx: PoolClient,
  ): Promise<{ namedAccountId: string }> {
    // Public profiles have their own owner resolver; never treat one as a reply.
    if (source.kind === 'profile')
      throw new ApplicationError('BLOCK_TARGET_NOT_ALLOWED');
    const content =
      source.kind === 'post'
        ? (await this.access.accessiblePost(source.id, actor, tx)).post
        : source.kind === 'comment'
          ? (await this.access.accessibleComment(source.id, actor, tx)).comment
          : (await this.access.accessibleReply(source.id, actor, tx)).reply;
    if (content.author_mode !== 'named' || content.account_id === actor)
      throw new ApplicationError('BLOCK_TARGET_NOT_ALLOWED');
    return { namedAccountId: content.account_id };
  }
}
