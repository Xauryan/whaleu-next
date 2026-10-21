import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import { IdentityService } from '../../identity/identity.service.js';
import { PublicProfileFacade } from '../../profile/public-profile.facade.js';
import { lockSafetyPolicy } from '../../safety/locks.js';
import { ProfileVisibilityFacade } from '../../safety/profile-visibility.facade.js';
import { enableSafetyRelationshipProof } from '../../safety/relationship-proof.js';
import { CommunityAccessService } from '../community-access.service.js';
import { CommunityRepository } from '../community.repository.js';
import type {
  StoredComment,
  StoredPost,
  StoredReply,
} from '../community.repository.js';
import type { SocialProjection, SocialSource } from './contracts.js';
import {
  lockSocialSourceAccounts,
  socialSourceDeletionState,
} from './facade.js';

/** A source is historical evidence, never a frozen grant or public persona.
 * The Notifications owner authenticates the recipient in this same managed
 * READ COMMITTED transaction and rechecks that session before returning. */
@Injectable()
export class CommunitySocialProjectionFacade {
  constructor(
    @Inject(CommunityRepository)
    private readonly repository: CommunityRepository,
    @Inject(CommunityAccessService)
    private readonly access: CommunityAccessService,
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(PublicProfileFacade) private readonly profiles: PublicProfileFacade,
    @Inject(ProfileVisibilityFacade)
    private readonly profileVisibility: ProfileVisibilityFacade,
  ) {}

  async project(
    source: SocialSource,
    tx: PoolClient,
    strict = false,
  ): Promise<SocialProjection | null> {
    // Keep this outside the unavailable-target boundary: unmanaged reads must
    // fail, rather than silently dropping the mandatory final relationship proof.
    enableSafetyRelationshipProof(tx);
    await lockSafetyPolicy(tx);
    if (source.actorAccountId === source.recipientAccountId) return null;
    try {
      return source.kind === 'follow'
        ? await this.follow(source, tx)
        : await this.community(source, tx);
    } catch (error) {
      if (
        strict &&
        error instanceof ApplicationError &&
        [
          'COMMUNITY_UNAVAILABLE',
          'CONTENT_REVIEW_UNAVAILABLE',
          'SAFETY_UNAVAILABLE',
          'SAFETY_MODERATION_UNAVAILABLE',
        ].includes(error.code)
      )
        throw error;
      if (
        error instanceof ApplicationError &&
        [
          'POST_NOT_FOUND',
          'COMMENT_NOT_FOUND',
          'REPLY_NOT_FOUND',
          'COMMUNITY_SCOPE_UNAVAILABLE',
          'COMMUNITY_ACTION_RESTRICTED',
          'COMMUNITY_UNAVAILABLE',
          'CONTENT_REVIEW_UNAVAILABLE',
          'CONTENT_REVIEW_REJECTED',
          'SAFETY_UNAVAILABLE',
          'SAFETY_ACCESS_SUSPENDED',
          'SAFETY_ACTION_RESTRICTED',
          'SAFETY_MODERATION_UNAVAILABLE',
          'ACCOUNT_BLOCKED',
        ].includes(error.code)
      )
        return null;
      throw error;
    }
  }

  private async active(accounts: readonly string[], tx: PoolClient) {
    for (const account of [...new Set(accounts)].sort())
      if (!(await this.identity.activeAccount(account, tx))) return false;
    return true;
  }

  private async community(
    source: SocialSource,
    tx: PoolClient,
  ): Promise<SocialProjection | null> {
    if (
      (source.kind !== 'like' && source.kind !== 'save') ||
      !source.postId ||
      (source.kind === 'save' && source.resourceKind !== 'post')
    )
      return null;
    // Reject inconsistent immutable locators before looking up another resource.
    switch (source.resourceKind) {
      case 'post':
        if (
          source.resourceId !== source.postId ||
          source.rootCommentId !== null ||
          source.replyId !== null ||
          source.targetReplyId !== null
        )
          return null;
        break;
      case 'comment':
        if (
          !source.rootCommentId ||
          source.resourceId !== source.rootCommentId ||
          source.replyId !== null ||
          source.targetReplyId !== null
        )
          return null;
        break;
      case 'reply':
        if (
          !source.rootCommentId ||
          !source.replyId ||
          source.resourceId !== source.replyId ||
          source.targetReplyId === source.replyId
        )
          return null;
        break;
      default:
        return null;
    }
    const viewer = source.recipientAccountId;
    const { post, space } = await this.access.projectionPost(
      source.postId,
      viewer,
      tx,
    );
    if (post.id !== source.postId) return null;
    // Current read authority only: no interaction/student/identity-campus,
    // comments-open or current like/save membership gate is introduced here.
    const authority = await this.access.authorization.resolve(
      viewer,
      space,
      tx,
    );
    if (authority.kind === 'unavailable')
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    if (authority.kind !== 'allow') return null;
    let target: StoredPost | StoredComment = post;
    const ancestors: (StoredPost | StoredComment)[] = [post];
    if (source.rootCommentId) {
      const root = await this.repository.comment(
        source.rootCommentId,
        tx,
        true,
      );
      if (root.id !== source.rootCommentId || root.post_id !== post.id)
        return null;
      target = root;
      ancestors.push(root);
      if (source.replyId) {
        // Lock the common parents first, then both exact replies in stable order.
        // A reply-to locator must not bypass a hidden/deleted/moved target reply.
        const replies = new Map<string, StoredReply>();
        for (const id of [
          source.replyId,
          ...(source.targetReplyId ? [source.targetReplyId] : []),
        ].sort()) {
          const reply = await this.repository.reply(id, tx, true);
          if (
            reply.id !== id ||
            reply.post_id !== post.id ||
            reply.root_comment_id !== root.id
          )
            return null;
          replies.set(id, reply);
          ancestors.push(reply);
        }
        const reply = replies.get(source.replyId)!;
        if (reply.target_reply_id !== source.targetReplyId) return null;
        target = reply;
      }
    }
    if (target.account_id !== viewer) return null;
    if (
      !(await this.active(
        [
          source.actorAccountId,
          viewer,
          ...ancestors.map((ancestor) => ancestor.account_id),
        ],
        tx,
      ))
    )
      return null;
    for (const ancestor of ancestors.slice(1))
      if (!(await this.access.visible(viewer, ancestor, tx, 'direct_post')))
        return null;
    // Unlike a named follow, an interaction has no public actor-persona contract.
    // Never resolve its actor profile or probe that private identity's block
    // relationship. Canonical content visibility alone applies named/anonymous
    // relationship semantics to each ancestor without linking anonymous authors.
    return {
      kind: source.kind,
      target: {
        type: 'community',
        postId: post.id,
        commentId: source.rootCommentId,
        replyId: source.replyId,
      },
    };
  }

  private async follow(
    source: SocialSource,
    tx: PoolClient,
  ): Promise<SocialProjection | null> {
    if (
      source.resourceKind !== 'profile' ||
      source.postId !== null ||
      source.rootCommentId !== null ||
      source.replyId !== null ||
      source.targetReplyId !== null
    )
      return null;
    // Authentication already locks the recipient. Lock any other account
    // nonblockingly before the edge gate, and never resolve a retired persona.
    const active = await lockSocialSourceAccounts(source, tx);
    const deletion = await socialSourceDeletionState(source.id, tx);
    if (deletion.retired || deletion.erasing || !active) return null;
    // Same actor edge-set gate as FollowingService, without a service dependency
    // cycle. Removing the edge makes its retained lifetime notice unavailable;
    // a later re-follow may expose that same notice without changing read state.
    const locked = (
      await tx.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_xact_lock_shared(hashtextextended($1,0)) AS locked',
        [`whaleu:following:${source.actorAccountId}`],
      )
    ).rows[0]?.locked;
    if (!locked) throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    if (
      !(await this.active(
        [source.actorAccountId, source.recipientAccountId],
        tx,
      ))
    )
      return null;
    const recipient = await this.profiles.find(source.resourceId, tx);
    if (
      !recipient ||
      recipient.profileId !== source.resourceId ||
      recipient.accountId !== source.recipientAccountId
    )
      return null;
    const edge = await tx.query(
      `SELECT 1 FROM whaleu_community.user_follows
       WHERE follower_id=$1 AND followed_id=$2 AND followed_profile_id=$3
       FOR SHARE`,
      [source.actorAccountId, source.recipientAccountId, source.resourceId],
    );
    if (edge.rowCount !== 1) return null;
    const actorReference = await this.profiles.ownReference(
      source.actorAccountId,
      tx,
    );
    if (!actorReference) return null;
    const actor = await this.profiles.find(actorReference, tx);
    if (
      !actor ||
      actor.profileId !== actorReference ||
      actor.accountId !== source.actorAccountId ||
      (
        await this.profileVisibility.read(
          source.recipientAccountId,
          actor.accountId,
          tx,
        )
      ).status !== 'available'
    )
      return null;
    return {
      kind: 'follow',
      target: { type: 'profile', profileId: actor.profileId },
      actor: { profileId: actor.profileId, displayName: actor.displayName },
    };
  }
}
