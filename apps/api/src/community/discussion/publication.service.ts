import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ApplicationError } from '../../http/application-error.js';
import { AuthorDisplayService } from '../../profile/author-display.service.js';
import { CommunityRepository } from '../community.repository.js';
import { CommunityAccessService } from '../community-access.service.js';
import {
  PublicationRepository,
  publicationHash,
} from '../publication.repository.js';
import { PublicationService } from '../publication.service.js';
import {
  requirePublication,
  requireCommentControl,
} from '../community-policy.js';
import type { AuthorMode, PublicationReceipt } from '../contracts.js';
import type { PublishReply } from './contracts.js';
export function replyIntent(rootCommentId: string, body: PublishReply) {
  return {
    rootCommentId: rootCommentId.toLowerCase(),
    targetReplyId: body.targetReplyId,
    text: body.text,
    imageAssetIds: body.imageAssetIds,
    authorMode: body.authorMode,
  };
}
export function replyApprovalHash(
  postId: string,
  rootCommentId: string,
  body: PublishReply,
  effectiveMode: AuthorMode,
) {
  return publicationHash('publish_reply', {
    postId,
    ...replyIntent(rootCommentId, body),
    authorMode: effectiveMode,
  });
}
@Injectable()
export class ReplyPublicationService {
  constructor(
    @Inject(CommunityRepository)
    private readonly repository: CommunityRepository,
    @Inject(CommunityAccessService)
    private readonly access: CommunityAccessService,
    @Inject(PublicationRepository)
    private readonly publications: PublicationRepository,
    @Inject(PublicationService) private readonly approval: PublicationService,
    @Inject(AuthorDisplayService)
    private readonly profiles: AuthorDisplayService,
  ) {}
  create(
    token: string,
    rootId: string,
    body: PublishReply,
  ): Promise<PublicationReceipt> {
    return this.publications.execute(
      token,
      body.clientRequestId,
      'publish_reply',
      replyIntent(rootId, body),
      async (actor, tx) => {
        const {
          post,
          space,
          comment: root,
        } = await this.access.accessibleComment(rootId, actor, tx, true);
        await this.access.interaction(actor, post, tx);
        await this.access.interaction(actor, root, tx);
        const authority = await this.access.authority(actor, space, tx, {
          publication: true,
          targetPostId: post.id,
          managementRequired:
            post.comments_policy === 'restricted' && post.account_id !== actor,
        });
        const mode =
          post.author_mode === 'anonymous' && post.account_id === actor
            ? 'anonymous'
            : body.authorMode;
        requirePublication(
          authority!,
          space,
          post.category,
          mode,
          'publish_comment',
          post.author_mode,
        );
        requireCommentControl(
          authority!,
          post.account_id === actor,
          post.comments_policy === 'restricted',
        );
        let targetAccount = root.account_id;
        if (body.targetReplyId) {
          const target = await this.repository.reply(
            body.targetReplyId,
            tx,
            true,
          );
          if (
            target.post_id !== post.id ||
            target.root_comment_id !== root.id ||
            !(await this.access.visible(actor, target, tx, 'list_projection'))
          )
            throw new ApplicationError('REPLY_NOT_FOUND');
          await this.access.interaction(actor, target, tx);
          targetAccount = target.account_id;
        }
        const { images: assets, approval } = await this.approval.approved(
          actor,
          'publish_reply',
          body.text,
          body.imageAssetIds,
          tx,
          {
            version: 3,
            publicationIntentHash: replyApprovalHash(
              post.id,
              root.id,
              body,
              mode,
            ),
            postId: post.id,
            rootCommentId: root.id,
            targetReplyId: body.targetReplyId,
            effectiveAuthorMode: mode,
          },
          {
            version: 1,
            accountId: actor,
            purpose: 'publish_reply',
            spaceId: space.id,
            category: post.category,
            authorMode: mode,
            commentsPolicy: post.comments_policy,
            postId: post.id,
            rootCommentId: root.id,
            targetReplyId: body.targetReplyId,
            text: body.text,
            component: { kind: 'none' },
            trading: null,
            scope: this.approval.scope(
              authority,
              space.id,
              space.operatingRegionId,
            ),
          },
        );
        if (mode === 'named') await this.profiles.prepare(actor, tx);
        else await this.repository.persona(post.id, actor, tx);
        const id = randomUUID();
        const result = await tx.query<{ created_at: Date }>(
          'INSERT INTO whaleu_community.replies(id,post_id,root_comment_id,target_reply_id,account_id,text,author_mode) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING created_at',
          [id, post.id, root.id, body.targetReplyId, actor, body.text, mode],
        );
        await this.repository.attach('reply', id, assets, tx);
        await this.approval.bind(approval, 'reply', id, tx);
        await this.repository.event(
          `reply:${id}:created`,
          'reply_created',
          id,
          tx,
          {
            actorAccountId: actor,
            postId: post.id,
            rootCommentId: root.id,
            targetReplyId: body.targetReplyId,
            recipientAccountIds: [
              ...new Set([root.account_id, targetAccount]),
            ].filter((x) => x !== actor),
            obligations: [
              'reply_recipient_notification',
              'reply_actor_reward',
              'distinct_recipient_reward',
              'discussion_ranking',
              'media_audit',
            ],
          },
        );
        return {
          resourceId: id,
          createdAt: result.rows[0]!.created_at.toISOString(),
        };
      },
    );
  }
}
