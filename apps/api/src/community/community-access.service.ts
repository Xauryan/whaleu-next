import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import { IdentityService } from '../identity/identity.service.js';
import {
  COMMUNITY_AUTHORIZATION,
  COMMUNITY_VISIBILITY,
  requireDecision,
} from './community-policy.js';
import type {
  Authority,
  CommunityAuthorizationPort,
  CommunityVisibilityPort,
  VisibilitySubject,
} from './community-policy.js';
import type { CommunitySpace } from './contracts.js';
import { CommunityRepository } from './community.repository.js';
import type { StoredPost, StoredComment } from './community.repository.js';
@Injectable()
export class CommunityAccessService {
  constructor(
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(COMMUNITY_AUTHORIZATION)
    readonly authorization: CommunityAuthorizationPort,
    @Inject(COMMUNITY_VISIBILITY)
    private readonly visibility: CommunityVisibilityPort,
    @Inject(CommunityRepository)
    private readonly repository: CommunityRepository,
  ) {}
  async actor(token: string, tx: PoolClient): Promise<string> {
    return (await this.identity.session(token, tx)).accountId;
  }
  async authority(
    accountId: string,
    space: CommunitySpace,
    tx: PoolClient,
  ): Promise<Authority> {
    return requireDecision(
      await this.authorization.resolve(accountId, space, tx),
    );
  }
  async advisory(
    accountId: string | null,
    space: CommunitySpace,
    tx: PoolClient,
  ): Promise<Authority | null> {
    if (!accountId) return null;
    const decision = await this.authorization.resolve(accountId, space, tx);
    return decision.kind === 'allow' ? decision.value : null;
  }
  async visible(
    viewer: string | null,
    content: StoredPost | StoredComment,
    tx: PoolClient,
  ): Promise<boolean> {
    if (content.visibility !== 'approved' || content.deleted_at) return false;
    const subject: VisibilitySubject = {
      contentId: content.id,
      authorMode: content.author_mode,
      ...(content.author_mode === 'named'
        ? { namedAccountId: content.account_id }
        : {}),
    };
    const result = await this.visibility.check(viewer, subject, tx);
    if (result.kind === 'unavailable')
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    return result.kind === 'allow';
  }
  async accessiblePost(
    id: string,
    viewer: string | null,
    tx: PoolClient,
    write = false,
  ): Promise<{ post: StoredPost; space: CommunitySpace }> {
    const post = await this.repository.post(id, tx, write);
    // A generic absence avoids distinguishing hidden, deleted and blocked content.
    if (!(await this.visible(viewer, post, tx)))
      throw new ApplicationError('POST_NOT_FOUND');
    let space: CommunitySpace;
    try {
      space = await this.repository.space(post.space_id, tx);
    } catch (error) {
      if (
        error instanceof ApplicationError &&
        error.code === 'COMMUNITY_SCOPE_UNAVAILABLE'
      )
        throw new ApplicationError('POST_NOT_FOUND');
      throw error;
    }
    return { post, space };
  }
  async accessibleComment(
    id: string,
    viewer: string,
    tx: PoolClient,
    write = false,
  ) {
    const reference = await this.repository.comment(id, tx);
    const { post, space } = await this.accessiblePost(
      reference.post_id,
      viewer,
      tx,
      write,
    );
    const authority = write
      ? await this.authority(viewer, space, tx)
      : await this.advisory(viewer, space, tx);
    const comment = await this.repository.comment(id, tx, true);
    if (
      comment.post_id !== post.id ||
      !(await this.visible(viewer, comment, tx))
    )
      throw new ApplicationError('COMMENT_NOT_FOUND');
    return { post, space, comment, authority };
  }
  async accessibleReply(
    id: string,
    viewer: string,
    tx: PoolClient,
    write = false,
  ) {
    const reference = await this.repository.reply(id, tx);
    const parent = await this.accessibleComment(
      reference.root_comment_id,
      viewer,
      tx,
      write,
    );
    const reply = await this.repository.reply(id, tx, true);
    if (
      reply.post_id !== parent.post.id ||
      reply.root_comment_id !== parent.comment.id ||
      !(await this.visible(viewer, reply, tx))
    )
      throw new ApplicationError('REPLY_NOT_FOUND');
    return { ...parent, reply };
  }
}
