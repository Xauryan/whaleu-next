import { loadActiveHomePublication } from './home-feed-policy/active-publication.js';
import { planHomePublication } from './home-feed-policy/publication-plan.js';
import type { HomePublicationPlan } from './home-feed-policy/publication-plan.js';
import { reviewedTextSource } from './text-source/protocol.js';
import type { TextSourceDescriptor } from './text-source/contracts.js';
import { insertHomePublicationEvidence } from './home-feed-policy/publication-evidence.js';
import { ApprovalRepository } from './content-review/approval.repository.js';
import { ContentDefinitionRepository } from './content-review/content-definition.repository.js';
import { requireCurrentHomeParent } from './home-feed-policy/parent-proof.js';
import {
  withReviewedTextSource,
  requireOrdinarySourceParent,
} from './text-source/publication.js';
import { insertTextSource } from './text-source/repository.js';
import {
  appendTextSource,
  sourceTextAvailable,
} from './text-source/protocol.js';
import { CurrentRatingLinkDependency } from './rating-target-link/dependency.js';
import type { ReviewedRatingTargetLink } from './rating-target-link/contracts.js';
import { AccountPolicy } from '../safety/account-policy/decorator.js';
import { bindCategoryChildContext } from './category-reclassification/child-context.js';
import { FeedbackNotificationsFacade } from '../notifications/feedback/facade.js';
import { requireFeedbackSpace } from './feedback/topic.js';
import {
  canonicalEnvelope,
  contentScopeSchema,
} from './content-review/contracts.js';
import { CommunityDistributionService } from './related-sync/service.js';
import { relatedCanonicalIdentifiersSchema } from './related-sync/contracts.js';
import type { CommunitySpace } from './contracts.js';
import type {
  LegacyContentScope,
  InheritedRelatedScope,
} from './content-review/scope-contracts.js';
import { TextReviewSubmission } from './text-review/contracts.js';
import type { TextReviewStatus } from './text-review/contracts.js';
import { TextReviewRuntime } from './text-review/runtime.js';
import {
  authorizeDiscussionPublication,
  withDiscussionPublicationMedia,
} from './discussion/publication-target.js';
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
import { Inject, Injectable, Optional } from '@nestjs/common';
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
    @Optional()
    @Inject(TextReviewRuntime)
    private readonly reviews?: TextReviewRuntime,
    @Optional()
    @Inject(FeedbackNotificationsFacade)
    private readonly feedbackNotices?: FeedbackNotificationsFacade,
    @Optional()
    @Inject(CommunityDistributionService)
    private readonly distribution?: CommunityDistributionService,
    @Optional()
    @Inject(CurrentRatingLinkDependency)
    private readonly targetLinks: CurrentRatingLinkDependency = new CurrentRatingLinkDependency(),
    @Optional()
    @Inject(ApprovalRepository)
    private readonly homeApprovals?: ApprovalRepository,
    @Optional()
    @Inject(ContentDefinitionRepository)
    private readonly homeDefinitions?: ContentDefinitionRepository,
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
    publication?: import('../media/batch-repository.js').PublicationMediaContext,
    reviewOnly = false,
  ): Promise<{
    images: ApprovedAsset[];
    approval: AcceptedApproval | undefined;
  }> {
    if (envelope?.version === 7 || envelope?.version === 8) {
      if (!this.reviews || !this.content.bind)
        throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
      await this.reviews.requireEnvelope(
        canonicalEnvelope({ ...envelope, images: [] }),
        tx,
      );
    }
    if (envelope?.version === 6) {
      if (
        !this.reviews ||
        !this.content.bind ||
        ids.length ||
        !sourceTextAvailable(envelope.text, envelope.textSource)
      )
        throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
      await this.reviews.requireEnvelope(
        canonicalEnvelope({ ...envelope, images: [] }),
        tx,
      );
    }
    if (ids.length && !envelope)
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const images = ids.length
      ? requireDecision(
          await this.media.resolveOwned(
            actor,
            purpose,
            ids,
            tx,
            envelope!,
            publication,
          ),
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
    if (envelope?.version === 4) {
      if (!this.distribution || !this.content.bind)
        throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
      await this.distribution.requireEnvelopeShape(
        canonicalEnvelope({ ...envelope, images }),
        tx,
      );
    }
    if (reviewOnly) {
      if (!this.reviews || !envelope || !publication)
        throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
      const effective = canonicalEnvelope({ ...envelope, images });
      await this.reviews.requireEnvelope(effective, tx);
      throw new TextReviewSubmission(effective);
    }
    if (this.reviews && envelope && publication)
      await this.reviews.requireRequest(
        canonicalEnvelope({ ...envelope, images }),
        publication,
        tx,
      );
    const approval = requireDecision(
      await this.content.check(
        {
          accountId: actor,
          purpose,
          text,
          images,
          ...(structuredContent ? { structuredContent } : {}),
          ...(envelope
            ? { envelope: canonicalEnvelope({ ...envelope, images }) }
            : {}),
        },
        tx,
      ),
      'CONTENT_REVIEW_UNAVAILABLE',
    );
    if (this.reviews && envelope && publication)
      await this.reviews.requireBinding(
        canonicalEnvelope({ ...envelope, images }),
        publication,
        approval,
        tx,
      );
    return { images, approval };
  }
  async bind(
    approval: AcceptedApproval | undefined,
    kind: 'post' | 'comment' | 'reply',
    id: string,
    tx: PoolClient,
    images: ApprovedAsset[],
  ) {
    if (this.content.bind) {
      if (!approval) throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
      await this.content.bind(approval, kind, id, tx);
    }
    if (images.length) await this.media.bind(images, kind, id, tx);
  }
  scope(
    authority: Authority,
    spaceId: string,
    regionId: string | null,
  ): LegacyContentScope {
    if (authority.runtime && !authority.publicationScope)
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    return contentScopeSchema.parse(
      authority.publicationScope ?? {
        originalSpaceId: spaceId,
        originalRegionId: regionId,
        authorOriginRegionId: null,
        identityRegionId: null,
        topologySnapshotId: null,
        sync: 'none' as const,
      },
    );
  }

  private reviewedPostEnvelope(
    draft: unknown,
    source: TextSourceDescriptor | undefined,
    plan: HomePublicationPlan | null,
  ): EffectiveContentEnvelopeDraft {
    if (plan?.lane === 'home') {
      if (!draft || typeof draft !== 'object')
        throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
      const value = draft as Record<string, unknown>;
      return canonicalEnvelope({
        ...value,
        images: [],
        version: 7,
        allowAnonymousDm: value['allowAnonymousDm'] ?? null,
        home: plan.evidence,
        textSource: source
          ? reviewedTextSource(
              plan.evidence.requestedIntent.text,
              source,
              'post',
            )
          : null,
      });
    }
    if (!draft || typeof draft !== 'object')
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    return withReviewedTextSource(
      canonicalEnvelope({ ...draft, images: [] }),
      source,
    );
  }

  async requireSourceParent(postId: string, tx: PoolClient): Promise<void> {
    await requireOrdinarySourceParent(
      postId,
      tx,
      this.homeApprovals && this.homeDefinitions
        ? { approvals: this.homeApprovals, definitions: this.homeDefinitions }
        : undefined,
    );
  }

  async discussionScope(
    authority: Authority,
    space: CommunitySpace,
    postId: string,
    envelopeVersion: number | undefined,
    tx: PoolClient,
  ): Promise<
    | {
        version: 8;
        scope: LegacyContentScope;
        allowAnonymousDm: null;
        textSource: null;
        homeParent: { postId: string; decisionId: string; digest: string };
      }
    | { version: 1; scope: LegacyContentScope }
    | { version: 4; allowAnonymousDm: null; scope: InheritedRelatedScope }
  > {
    const actorScope = this.scope(authority, space.id, space.operatingRegionId);
    if (envelopeVersion === 7) {
      if (!this.homeApprovals || !this.homeDefinitions)
        throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
      const parent = await requireCurrentHomeParent(
        postId,
        tx,
        this.homeApprovals,
        this.homeDefinitions,
      );
      if (
        parent.envelope.spaceId !== space.id ||
        parent.envelope.scope.originalRegionId !== space.operatingRegionId
      )
        throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
      return {
        version: 8,
        scope: actorScope,
        allowAnonymousDm: null,
        textSource: null,
        homeParent: parent.reference,
      };
    }

    if (!this.distribution) {
      if (envelopeVersion === 4)
        throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
      return { version: 1, scope: actorScope };
    }
    const scope = await this.distribution.inherit(postId, actorScope, tx);
    return scope.sync === 'inherited_related'
      ? { version: 4, allowAnonymousDm: null, scope }
      : { version: 1, scope };
  }

  post(
    token: string,
    body: PublishPost,
    reviewOnly: true,
  ): Promise<TextReviewStatus>;
  post(token: string, body: PublishPost): Promise<PublicationReceipt>;
  @AccountPolicy('interaction', 'owner_after_recovery')
  post(
    token: string,
    body: PublishPost,
    reviewOnly = false,
  ): Promise<PublicationReceipt | TextReviewStatus> {
    const {
      clientRequestId,
      spaceId: requestedSpaceId,
      category: requestedCategory,
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
        let spaceId = requestedSpaceId;
        let category: import('./contracts.js').Category = requestedCategory;
        let homePlan: HomePublicationPlan | null = null;
        if (body.syncToRelatedCampuses === true) {
          if (
            !relatedCanonicalIdentifiersSchema.safeParse({
              ids: [spaceId, ...imageAssetIds],
            }).success
          )
            throw new ApplicationError('RELATED_CONTENT_CANONICAL_ID_REQUIRED');
          if (!this.distribution)
            throw new ApplicationError('COMMUNITY_UNAVAILABLE');
          await this.distribution.observeRootAdmission(tx);
        }
        let space = await this.repository.space(spaceId, tx);
        if (category === 'feedback') await requireFeedbackSpace(space, tx);
        let authority = await this.access.authority(actor, space, tx, {
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
        let ratingLink: ReviewedRatingTargetLink | undefined;
        if (body.component?.kind === 'rating_target_link') {
          if (
            category !== 'discussion' ||
            imageAssetIds.length ||
            body.syncToRelatedCampuses === true ||
            body.allowAnonymousDm !== undefined ||
            body.trading ||
            body.feedback ||
            space.kind !== 'regional'
          )
            throw new ApplicationError('COMMUNITY_ACTION_RESTRICTED');
          const qualified = await this.targetLinks.publication(
            actor,
            body.component,
            { spaceId, category: 'discussion', authorMode },
            tx,
          );
          ratingLink = {
            kind: 'rating_target_link',
            targetId: body.component.targetId,
            label: body.component.label,
            binding: qualified.binding,
          };
        }
        if (category !== 'feedback' && category !== 'trading') {
          const admission = await loadActiveHomePublication(tx);
          if (admission) {
            homePlan = planHomePublication(
              body,
              space,
              authority.publicationScope?.authorOriginRegionId ?? null,
              admission,
              new Date(),
            );
            if (homePlan.lane === 'home') {
              if (homePlan.spaceId !== space.id) {
                space = await this.repository.space(homePlan.spaceId, tx);
                authority = await this.access.authority(actor, space, tx, {
                  publication: true,
                  managementRequired: commentsPolicy === 'restricted',
                });
                requirePublication(
                  authority,
                  space,
                  requestedCategory,
                  authorMode,
                  'publish_post',
                );
                if (
                  space.operatingRegionId !== homePlan.regionId ||
                  (commentsPolicy === 'restricted' &&
                    !(authority.canDisableComments ?? authority.canManage))
                )
                  throw new ApplicationError('COMMUNITY_ACTION_RESTRICTED');
              }
              spaceId = homePlan.spaceId;
              category = homePlan.category;
            }
          }
        }
        const relatedScope =
          body.syncToRelatedCampuses === true && !homePlan?.suppressDistribution
            ? await (() => {
                if (!this.distribution)
                  throw new ApplicationError('COMMUNITY_UNAVAILABLE');
                if (body.component?.kind === 'rating_target_link')
                  throw new ApplicationError('COMMUNITY_ACTION_RESTRICTED');
                return this.distribution.prepare(
                  actor,
                  space,
                  {
                    category,
                    authorMode,
                    componentKind: body.component?.kind ?? 'none',
                    imageCount: imageAssetIds.length,
                    allowAnonymousDm: body.allowAnonymousDm ?? null,
                  },
                  authority,
                  tx,
                );
              })()
            : null;
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
          this.reviewedPostEnvelope(
            {
              accountId: actor,
              purpose: 'publish_post',
              spaceId,
              category,
              commentsPolicy,
              postId: null,
              rootCommentId: null,
              targetReplyId: null,
              text,
              component:
                body.component?.kind === 'rating_target_link'
                  ? { kind: 'none' }
                  : (body.component ?? { kind: 'none' }),
              trading: body.trading ?? null,
              ...(ratingLink
                ? {
                    version: 5 as const,
                    category: 'discussion' as const,
                    authorMode,
                    trading: null,
                    component: ratingLink,
                    scope: this.scope(
                      authority,
                      space.id,
                      space.operatingRegionId,
                    ),
                  }
                : relatedScope
                  ? {
                      version: 4 as const,
                      authorMode,
                      allowAnonymousDm: body.allowAnonymousDm ?? null,
                      scope: relatedScope,
                    }
                  : {
                      scope: this.scope(
                        authority,
                        space.id,
                        space.operatingRegionId,
                      ),
                      ...(body.feedback
                        ? {
                            version: 3 as const,
                            category: 'feedback' as const,
                            authorMode,
                            commentsPolicy: 'open' as const,
                            feedback: body.feedback,
                          }
                        : body.allowAnonymousDm === undefined
                          ? { version: 1 as const, authorMode }
                          : {
                              version: 2 as const,
                              authorMode: 'named' as const,
                              allowAnonymousDm: body.allowAnonymousDm,
                            }),
                    }),
            },
            body.textSource,
            homePlan,
          ),
          {
            clientRequestId,
            operation: 'publish_post',
            intentHash: publicationHash('publish_post', intent),
          },
          reviewOnly,
        );
        if (
          body.allowAnonymousDm !== undefined &&
          (!this.content.bind ||
            (approval?.version !== 2 &&
              approval?.version !== 4 &&
              approval?.version !== 6 &&
              approval?.version !== 7) ||
            (approval.envelope.version !== 2 &&
              approval.envelope.version !== 4 &&
              approval.envelope.version !== 6 &&
              approval.envelope.version !== 7) ||
            approval.envelope.allowAnonymousDm !== body.allowAnonymousDm)
        )
          throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
        if (authorMode === 'named') await this.profiles.prepare(actor, tx);
        const id = randomUUID();
        const result = await tx.query<{ published_at: Date }>(
          `INSERT INTO whaleu_community.posts(id,space_id,account_id,category,text,author_mode,comments_policy,publication_envelope_version,allow_anonymous_dm${body.feedback ? ',feedback' : ''}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9${body.feedback ? ',$10::jsonb' : ''}) RETURNING published_at`,
          [
            id,
            spaceId,
            actor,
            category,
            text,
            authorMode,
            commentsPolicy,
            homePlan?.lane === 'home'
              ? 7
              : body.textSource
                ? 6
                : ratingLink
                  ? 5
                  : relatedScope
                    ? 4
                    : body.feedback
                      ? 3
                      : body.allowAnonymousDm === undefined
                        ? 1
                        : 2,
            body.allowAnonymousDm ?? null,
            ...(body.feedback ? [JSON.stringify(body.feedback)] : []),
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
        if (ratingLink) {
          if (!approval || approval.version !== 5)
            throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
          await tx.query(
            `INSERT INTO whaleu_community.post_rating_target_links(post_id,account_id,client_request_id,intent_hash,component,decision_id,digest) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7)`,
            [
              id,
              actor,
              clientRequestId,
              publicationHash('publish_post', intent),
              JSON.stringify(ratingLink),
              approval.decisionId,
              approval.digest,
            ],
          );
        }
        await insertHomePublicationEvidence(approval, 'post', id, tx);
        await insertTextSource(
          {
            kind: 'post',
            id,
            accountId: actor,
            requestId: clientRequestId,
            requestedAuthorMode: authorMode,
            originalIntentHash: publicationHash('publish_post', intent),
            text,
            source: body.textSource,
            approval,
          },
          tx,
        );
        await this.bind(approval, 'post', id, tx, images);
        if (relatedScope) {
          if (!approval || !this.distribution)
            throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
          await this.distribution.bind(
            id,
            {
              clientRequestId,
              operation: 'publish_post',
              intentHash: publicationHash('publish_post', intent),
            },
            approval,
            tx,
          );
        }
        if (category === 'feedback') {
          if (!this.feedbackNotices)
            throw new ApplicationError('SYSTEM_NOTICES_UNAVAILABLE');
          await this.feedbackNotices.recordPublication(
            { postId: id, occurredAt: result.rows[0]!.published_at },
            tx,
          );
        }
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
      reviewOnly,
    );
  }

  comment(
    token: string,
    postId: string,
    body: PublishComment,
    reviewOnly: true,
  ): Promise<TextReviewStatus>;
  comment(
    token: string,
    postId: string,
    body: PublishComment,
  ): Promise<PublicationReceipt>;
  @AccountPolicy('interaction', 'owner_after_recovery')
  comment(
    token: string,
    postId: string,
    body: PublishComment,
    reviewOnly = false,
  ): Promise<PublicationReceipt | TextReviewStatus> {
    const { clientRequestId, text, imageAssetIds, authorMode } = body;
    if (body.textSource !== undefined && postId !== postId.toLowerCase())
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    const intent = appendTextSource(
      { postId, text, imageAssetIds, authorMode },
      body.textSource,
    );
    return this.publications.execute(
      token,
      clientRequestId,
      'publish_comment',
      intent,
      async (actor, tx) => {
        const publish = async () => {
          const {
            post,
            space,
            authority,
            mode: effectiveMode,
          } = await authorizeDiscussionPublication(
            this.access,
            this.repository,
            actor,
            { kind: 'comment', postId },
            tx,
            authorMode,
          );
          if (body.textSource !== undefined)
            await this.requireSourceParent(post.id, tx);
          // Recovery happens in execute before this new-v4-only admission rule.
          if (
            post.publication_envelope_version === 4 &&
            !relatedCanonicalIdentifiersSchema.safeParse({
              ids: [postId, ...imageAssetIds],
            }).success
          )
            throw new ApplicationError('RELATED_CONTENT_CANONICAL_ID_REQUIRED');
          const { images, approval } = await this.approved(
            actor,
            'publish_comment',
            text,
            imageAssetIds,
            tx,
            undefined,
            withReviewedTextSource(
              canonicalEnvelope({
                ...(await this.discussionScope(
                  authority,
                  space,
                  post.id,
                  post.publication_envelope_version,
                  tx,
                )),
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
                images: [],
              }),
              body.textSource,
            ),
            {
              clientRequestId,
              operation: 'publish_comment',
              intentHash: publicationHash('publish_comment', intent),
            },
            reviewOnly,
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
          await insertHomePublicationEvidence(approval, 'comment', id, tx);
          await insertTextSource(
            {
              kind: 'comment',
              id,
              accountId: actor,
              requestId: clientRequestId,
              requestedAuthorMode: authorMode,
              originalIntentHash: publicationHash('publish_comment', intent),
              text,
              source: body.textSource,
              approval,
            },
            tx,
          );
          await this.bind(approval, 'comment', id, tx, images);
          if (approval)
            await bindCategoryChildContext(
              approval,
              'comment',
              id,
              clientRequestId,
              tx,
            );
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
        };
        return imageAssetIds.length > 0
          ? withDiscussionPublicationMedia(
              tx,
              { actor, body },
              reviewOnly,
              publish,
            )
          : publish();
      },
      reviewOnly,
    );
  }
}
