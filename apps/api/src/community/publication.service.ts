import type {
  AcceptedApproval,
  EffectiveContentEnvelopeDraft,
} from './content-review/contracts.js';
import { FormationRepository } from './formation/repository.js';
import { TradingRepository } from './trading/repository.js';
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
  requireCommentControl,
} from './community-policy.js';
import type {
  ApprovedAsset,
  Authority,
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
    @Inject(FormationRepository)
    private readonly formations: FormationRepository,
    @Inject(TradingRepository) private readonly trading: TradingRepository,
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
    envelope?: EffectiveContentEnvelopeDraft,
  ): Promise<{
    images: ApprovedAsset[];
    approval: AcceptedApproval | undefined;
  }> {
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
    const approval = requireDecision(
      await this.content.check(
        {
          accountId: actor,
          purpose,
          text,
          images,
          ...(structuredContent ? { structuredContent } : {}),
          ...(envelope ? { envelope: { ...envelope, images } } : {}),
        },
        tx,
      ),
      'CONTENT_REVIEW_UNAVAILABLE',
    );
    return { images, approval };
  }
  async bind(
    approval: AcceptedApproval | undefined,
    kind: 'post' | 'comment' | 'reply',
    id: string,
    tx: PoolClient,
  ) {
    if (this.content.bind) {
      if (!approval) throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
      await this.content.bind(approval, kind, id, tx);
    }
  }
  scope(authority: Authority, spaceId: string, regionId: string | null) {
    if (authority.runtime && !authority.publicationScope)
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    return (
      authority.publicationScope ?? {
        originalSpaceId: spaceId,
        originalRegionId: regionId,
        authorOriginRegionId: null,
        identityRegionId: null,
        topologySnapshotId: null,
        sync: 'none' as const,
      }
    );
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
        const authority = await this.access.authority(actor, space, tx, {
          publication: true,
          managementRequired: commentsPolicy === 'restricted',
        });
        requirePublication(
          authority,
          space,
          category,
          authorMode,
          'publish_post',
        );
        if (
          commentsPolicy === 'restricted' &&
          !(authority.canDisableComments ?? authority.canManage)
        )
          throw new ApplicationError('COMMUNITY_ACTION_RESTRICTED');
        if (body.allowAnonymousDm !== undefined && authorMode !== 'named')
          throw new ApplicationError('AUTHOR_MODE_NOT_ALLOWED');
        const { images, approval } = await this.approved(
          actor,
          'publish_post',
          text,
          imageAssetIds,
          tx,
          body.component?.kind === 'formation'
            ? {
                version: 5,
                publicationIntentHash: publicationHash('publish_post', intent),
                component: body.component,
              }
            : body.trading
              ? {
                  version: 4,
                  publicationIntentHash: publicationHash(
                    'publish_post',
                    intent,
                  ),
                  trading: body.trading,
                }
              : body.component?.kind === 'poll'
                ? {
                    version: 2,
                    publicationIntentHash: publicationHash(
                      'publish_post',
                      intent,
                    ),
                    component: body.component,
                  }
                : undefined,
          {
            ...(body.allowAnonymousDm === undefined
              ? { version: 1 as const, authorMode }
              : {
                  version: 2 as const,
                  authorMode: 'named' as const,
                  allowAnonymousDm: body.allowAnonymousDm,
                }),
            accountId: actor,
            purpose: 'publish_post',
            spaceId,
            category,
            commentsPolicy,
            postId: null,
            rootCommentId: null,
            targetReplyId: null,
            text,
            component: body.component ?? { kind: 'none' },
            trading: body.trading ?? null,
            scope: this.scope(authority, space.id, space.operatingRegionId),
          },
        );
        if (
          body.allowAnonymousDm !== undefined &&
          (!this.content.bind ||
            approval?.version !== 2 ||
            approval.envelope.version !== 2 ||
            approval.envelope.allowAnonymousDm !== body.allowAnonymousDm)
        )
          throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
        if (authorMode === 'named') await this.profiles.prepare(actor, tx);
        const id = randomUUID();
        const result = await tx.query<{ published_at: Date }>(
          'INSERT INTO whaleu_community.posts(id,space_id,account_id,category,text,author_mode,comments_policy,publication_envelope_version,allow_anonymous_dm) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING published_at',
          [
            id,
            spaceId,
            actor,
            category,
            text,
            authorMode,
            commentsPolicy,
            body.allowAnonymousDm === undefined ? 1 : 2,
            body.allowAnonymousDm ?? null,
          ],
        );
        if (authorMode === 'anonymous')
          await this.repository.persona(id, actor, tx);
        await this.repository.attach('post', id, images, tx);
        if (body.component?.kind === 'poll')
          await this.polls.create(id, body.component, tx);
        if (body.trading) await this.trading.create(id, body.trading, tx);
        if (body.component?.kind === 'formation') {
          await this.formations.create(id, actor, body.component, tx);
        }
        await this.bind(approval, 'post', id, tx);
        await this.repository.event(
          `post:${id}:created`,
          'post_created',
          id,
          tx,
          {
            experienceSourceVersion: 1,
            actorAccountId: actor,
            actorAuthorMode: authorMode,
            resourceAuthorMode: authorMode,
          },
        );
        if (body.component?.kind === 'formation')
          await this.access.actor(token, tx);
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
        await this.access.interaction(actor, post, tx);
        const authority = await this.access.authority(actor, space, tx, {
          publication: true,
          targetPostId: post.id,
          managementRequired:
            post.comments_policy === 'restricted' && post.account_id !== actor,
        });
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
        requireCommentControl(
          authority!,
          post.account_id === actor,
          post.comments_policy === 'restricted',
        );
        const { images, approval } = await this.approved(
          actor,
          'publish_comment',
          text,
          imageAssetIds,
          tx,
          undefined,
          {
            version: 1,
            accountId: actor,
            purpose: 'publish_comment',
            spaceId: space.id,
            category: post.category,
            authorMode: effectiveMode,
            commentsPolicy: post.comments_policy,
            postId: post.id,
            rootCommentId: null,
            targetReplyId: null,
            text,
            component: { kind: 'none' },
            trading: null,
            scope: this.scope(authority, space.id, space.operatingRegionId),
          },
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
        await this.bind(approval, 'comment', id, tx);
        await this.repository.event(
          `comment:${id}:created`,
          'comment_created',
          id,
          tx,
          {
            experienceSourceVersion: 1,
            actorAccountId: actor,
            actorAuthorMode: effectiveMode,
            resourceAuthorMode: effectiveMode,
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
