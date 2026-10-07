import { PollRepository } from './polls/poll.repository.js';
import { postIntent } from './publication-intent.js';
import { publicationHash } from './publication.repository.js';
import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import { AuthorDisplayService } from '../profile/author-display.service.js';
import { CommunityRepository } from './community.repository.js';
import { CommunityAccessService } from './community-access.service.js';
import { PublicationRepository } from './publication.repository.js';
import {
  CONTENT_PUBLICATION_GATE,
  MEDIA_ATTACHMENT,
  requireDecision,
  requirePublication,
} from './community-policy.js';
import type {
  ApprovedAsset,
  ContentPublicationGate,
  MediaAttachmentPort,
} from './community-policy.js';
import type {
  PublicationOperation,
  PublicationReceipt,
  PublishPost,
  PublishComment,
} from './contracts.js';
@Injectable()
export class PublicationService {
  constructor(
    @Inject(CommunityRepository)
    private readonly repository: CommunityRepository,
    @Inject(CommunityAccessService)
    private readonly access: CommunityAccessService,
    @Inject(PublicationRepository)
    private readonly publications: PublicationRepository,
    @Inject(PollRepository) private readonly polls: PollRepository,
    @Inject(AuthorDisplayService)
    private readonly profiles: AuthorDisplayService,
    @Inject(CONTENT_PUBLICATION_GATE)
    private readonly content: ContentPublicationGate,
    @Inject(MEDIA_ATTACHMENT) private readonly media: MediaAttachmentPort,
  ) {}
  async approved(
    actor: string,
    purpose: PublicationOperation,
    text: string,
    ids: string[],
    tx: PoolClient,
    structuredContent?: Parameters<
      ContentPublicationGate['check']
    >[0]['structuredContent'],
  ): Promise<ApprovedAsset[]> {
    const images = ids.length
      ? requireDecision(
          await this.media.resolveOwned(actor, purpose, ids, tx),
          'MEDIA_UNAVAILABLE',
        )
      : [];
    if (
      images.length !== ids.length ||
      images.some(
        (image, index) =>
          image.assetId !== ids[index] || !/^[a-f0-9]{64}$/.test(image.digest),
      )
    )
      throw new ApplicationError('MEDIA_NOT_READY');
    requireDecision(
      await this.content.check(
        {
          accountId: actor,
          purpose,
          text,
          images,
          ...(structuredContent ? { structuredContent } : {}),
        },
        tx,
      ),
      'CONTENT_REVIEW_UNAVAILABLE',
    );
    return images;
  }
  post(token: string, body: PublishPost): Promise<PublicationReceipt> {
    const {
      clientRequestId,
      spaceId,
      category,
      text,
      imageAssetIds,
      authorMode,
      commentsPolicy,
    } = body;
    const intent = postIntent(body);
    return this.publications.execute(
      token,
      clientRequestId,
      'publish_post',
      intent,
      async (actor, tx) => {
        const space = await this.repository.space(spaceId, tx);
        const authority = await this.access.authority(actor, space, tx);
        requirePublication(
          authority,
          space,
          category,
          authorMode,
          'publish_post',
        );
        if (commentsPolicy === 'restricted' && !authority.canManage)
          throw new ApplicationError('COMMUNITY_ACTION_RESTRICTED');
        const images = await this.approved(
          actor,
          'publish_post',
          text,
          imageAssetIds,
          tx,
          body.component?.kind === 'poll'
            ? {
                version: 2,
                publicationIntentHash: publicationHash('publish_post', intent),
                component: body.component,
              }
            : undefined,
        );
        if (authorMode === 'named') await this.profiles.prepare(actor, tx);
        const id = randomUUID();
        const result = await tx.query<{ published_at: Date }>(
          'INSERT INTO whaleu_community.posts(id,space_id,account_id,category,text,author_mode,comments_policy) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING published_at',
          [id, spaceId, actor, category, text, authorMode, commentsPolicy],
        );
        if (authorMode === 'anonymous')
          await this.repository.persona(id, actor, tx);
        await this.repository.attach('post', id, images, tx);
        if (body.component?.kind === 'poll')
          await this.polls.create(id, body.component, tx);
        await this.repository.event(
          `post:${id}:created`,
          'post_created',
          id,
          tx,
        );
        return {
          resourceId: id,
          createdAt: result.rows[0]!.published_at.toISOString(),
        };
      },
    );
  }
  comment(
    token: string,
    postId: string,
    body: PublishComment,
  ): Promise<PublicationReceipt> {
    const { clientRequestId, text, imageAssetIds, authorMode } = body;
    return this.publications.execute(
      token,
      clientRequestId,
      'publish_comment',
      { postId, text, imageAssetIds, authorMode },
      async (actor, tx) => {
        const { post, space } = await this.access.accessiblePost(
          postId,
          actor,
          tx,
          true,
        );
        const authority = await this.access.authority(actor, space, tx);
        const effectiveMode =
          post.author_mode === 'anonymous' && post.account_id === actor
            ? 'anonymous'
            : authorMode;
        requirePublication(
          authority,
          space,
          post.category,
          effectiveMode,
          'publish_comment',
          post.author_mode,
        );
        if (
          post.comments_policy === 'restricted' &&
          post.account_id !== actor &&
          !authority.canManage
        )
          throw new ApplicationError('COMMENTS_DISABLED');
        const images = await this.approved(
          actor,
          'publish_comment',
          text,
          imageAssetIds,
          tx,
        );
        if (effectiveMode === 'named') await this.profiles.prepare(actor, tx);
        const id = randomUUID();
        const result = await tx.query<{ created_at: Date }>(
          'INSERT INTO whaleu_community.root_comments(id,post_id,account_id,text,author_mode) VALUES ($1,$2,$3,$4,$5) RETURNING created_at',
          [id, postId, actor, text, effectiveMode],
        );
        if (effectiveMode === 'anonymous')
          await this.repository.persona(postId, actor, tx);
        await this.repository.attach('comment', id, images, tx);
        await this.repository.event(
          `comment:${id}:created`,
          'comment_created',
          id,
          tx,
          {
            actorAccountId: actor,
            postId: post.id,
            recipientAccountIds:
              post.account_id === actor ? [] : [post.account_id],
            obligations: [
              'post_author_notification',
              'eligible_saved_subscriber_notification',
              'comment_actor_reward',
              'distinct_post_author_reward',
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
