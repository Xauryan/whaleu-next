import type { SearchReadContext } from './content-review/search-read-context.js';
import {
  checkpointTransactionDeadlines,
  restoreTransactionDeadlines,
} from '../database/transaction-deadlines.js';
import { lockSafetyPolicy } from '../safety/locks.js';
import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import { authenticateMediaSession } from '../identity/current-media-session.js';
import type { CurrentMediaSession } from '../identity/current-media-session.js';
import { IdentityService } from '../identity/identity.service.js';
import {
  COMMUNITY_AUTHORIZATION,
  COMMUNITY_VISIBILITY,
  requireDecision,
} from './community-policy.js';
import type {
  Authority,
  AuthorizationContext,
  CommunityAuthorizationPort,
  CommunityVisibilityPort,
  VisibilitySubject,
  VisibilityPurpose,
  Decision,
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
  /** Internal trustworthy session context. Never accepts session/epoch from HTTP.
   * Identity holds account/session/token SHARE locks and enrolls its deadline. */
  async mediaSession(
    token: string,
    tx: PoolClient,
  ): Promise<CurrentMediaSession> {
    await lockSafetyPolicy(tx);
    return authenticateMediaSession(this.identity, token, tx);
  }
  async actor(token: string, tx: PoolClient): Promise<string> {
    await lockSafetyPolicy(tx);
    return (await this.identity.session(token, tx)).accountId;
  }
  async authority(
    accountId: string,
    space: CommunitySpace,
    tx: PoolClient,
    context: AuthorizationContext = {},
  ): Promise<Authority> {
    return requireDecision(
      await this.authorization.resolve(accountId, space, tx, context),
    );
  }
  async advisory(
    accountId: string | null,
    space: CommunitySpace,
    tx: PoolClient,
    context: AuthorizationContext = {},
  ): Promise<Authority | null> {
    if (!accountId) return null;
    const checkpoint = checkpointTransactionDeadlines(tx);
    try {
      const decision = await this.authorization.resolve(
        accountId,
        space,
        tx,
        context,
      );
      return decision.kind === 'allow' ? decision.value : null;
    } finally {
      // Rendering action hints must not turn optional phone/safety eligibility
      // into an ordinary read requirement. Preserve earlier visibility deadlines.
      restoreTransactionDeadlines(tx, checkpoint);
    }
  }
  async visibilityDecision(
    viewer: string | null,
    content: StoredPost | StoredComment,
    tx: PoolClient,
    purpose: VisibilityPurpose,
    read?: SearchReadContext,
  ): Promise<Decision> {
    if (content.visibility !== 'approved' || content.deleted_at)
      return { kind: 'deny', reason: 'POST_NOT_FOUND' };
    const contentKind =
      'root_comment_id' in content
        ? 'reply'
        : 'post_id' in content
          ? 'comment'
          : 'post';
    const reference = {
      contentId: content.id,
      contentKind,
      contentVersion: 1,
    } as const;
    const subject: VisibilitySubject =
      content.author_mode === 'named'
        ? {
            ...reference,
            authorMode: 'named',
            namedAccountId: content.account_id,
          }
        : { ...reference, authorMode: 'anonymous' };
    const result = await this.visibility.check(
      viewer,
      subject,
      tx,
      purpose,
      read,
    );
    if (result.kind === 'unavailable')
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    return result;
  }
  async visible(
    viewer: string | null,
    content: StoredPost | StoredComment,
    tx: PoolClient,
    purpose: VisibilityPurpose,
    read?: SearchReadContext,
  ): Promise<boolean> {
    return (
      (await this.visibilityDecision(viewer, content, tx, purpose, read))
        .kind === 'allow'
    );
  }
  async interaction(
    viewer: string,
    content: StoredPost | StoredComment,
    tx: PoolClient,
  ) {
    if (!(await this.visible(viewer, content, tx, 'named_interaction')))
      throw new ApplicationError('POST_NOT_FOUND');
  }
  async namedMemberVisible(
    viewer: string | null,
    post: StoredPost,
    memberAccountId: string,
    tx: PoolClient,
  ): Promise<boolean> {
    if (!(await this.visible(viewer, post, tx, 'list_projection')))
      return false;
    const result = this.visibility.checkNamedRelationship
      ? await this.visibility.checkNamedRelationship(
          viewer,
          memberAccountId,
          tx,
          'list_projection',
        )
      : await this.visibility.check(
          viewer,
          {
            contentId: post.id,
            contentKind: 'post',
            contentVersion: 1,
            authorMode: 'named',
            namedAccountId: memberAccountId,
          },
          tx,
          'list_projection',
        );
    if (result.kind === 'unavailable')
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    return result.kind === 'allow';
  }
  async accessiblePost(
    id: string,
    viewer: string | null,
    tx: PoolClient,
    write = false,
    explainOwnBlock = false,
  ): Promise<{ post: StoredPost; space: CommunitySpace }> {
    await lockSafetyPolicy(tx);
    const post = await this.repository.post(id, tx, write);
    if (post.visibility !== 'approved' || post.deleted_at)
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
    const decision = await this.visibilityDecision(
      viewer,
      post,
      tx,
      'direct_post',
    );
    if (decision.kind !== 'allow')
      throw new ApplicationError(
        explainOwnBlock &&
          decision.kind === 'deny' &&
          decision.reason === 'POST_BLOCKED_BY_YOU'
          ? 'POST_BLOCKED_BY_YOU'
          : 'POST_NOT_FOUND',
      );
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
      !(await this.visible(viewer, comment, tx, 'list_projection'))
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
      !(await this.visible(viewer, reply, tx, 'list_projection'))
    )
      throw new ApplicationError('REPLY_NOT_FOUND');
    return { ...parent, reply };
  }
}
