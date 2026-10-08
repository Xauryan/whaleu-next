import { CommunitySubscriptionComponentModule } from './subscription-component/module.js';
import { ExperienceIngressModule } from '../experience/ingress.js';
import { CommunityExperienceSourceCapture } from './experience-source/capture.js';
import { CommunityExperienceSourceFacade } from './experience-source/facade.js';
import {
  PostLikeController,
  PostLikeRecoveryController,
} from './post-like/controller.js';
import { VerificationModule } from '../verification/verification.module.js';
import { DiscoveryCursorRepository } from './discovery-cursors.js';
import { CommunityDiscoveryCounts } from './discovery-counts.js';
import { ContentReviewCountFacade } from './content-review/count-snapshot.facade.js';
import { CommunityProfileDiscoveryFacade } from './profile-discovery.facade.js';
import { LikedHistoryController } from './liked/controller.js';
import { LikedHistoryService } from './liked/service.js';
import { LikedHistoryRepository } from './liked/repository.js';
import { AuthorizationModule } from '../authorization/authorization.module.js';
import { ContentReviewModule } from './content-review/content-review.module.js';
import { LocalContentPublicationGate } from './content-review/local-content-publication-gate.js';
import { RuntimeCommunityAuthorization } from './runtime-authorization.js';
import { CommunityReportTargetFacade } from './report-target.facade.js';
import { CommunityModerationRemovalFacade } from './moderation-removal.facade.js';
import { SafetyPolicyModule } from '../safety/policy.module.js';
import { NamedBlockVisibility } from '../safety/visibility.js';
import { CommunityNamedBlockSourceFacade } from './named-block-source.facade.js';
import { CommunityUpdatesFacade } from './updates.facade.js';
import { SavedRepository } from './saved/repository.js';
import { SavedReadService } from './saved/read.service.js';
import { SavedMutationService } from './saved/mutation.service.js';
import {
  SavedController,
  SavedRecoveryController,
} from './saved/controller.js';
import { FormationRepository } from './formation/repository.js';
import { FormationService } from './formation/service.js';
import {
  FormationController,
  FormationRecoveryController,
} from './formation/controller.js';
import { TradingRepository } from './trading/repository.js';
import { TradingService } from './trading/service.js';
import {
  TradingController,
  TradingRecoveryController,
} from './trading/controller.js';
import {
  DiscussionController,
  DiscussionRecoveryController,
} from './discussion/controller.js';
import { DiscussionReadService } from './discussion/read.service.js';
import { DiscussionMutationService } from './discussion/mutation.service.js';
import { ReplyPublicationService } from './discussion/publication.service.js';
import { commentsQuerySchema } from './discussion/contracts.js';
import type { CommentsQuery } from './discussion/contracts.js';
import { PollRepository } from './polls/poll.repository.js';
import { PollReadService } from './polls/poll-read.service.js';
import { PollVotingService } from './polls/poll-voting.service.js';
import { BallotRequestsRepository } from './polls/ballot-requests.repository.js';
import {
  PollController,
  PollRecoveryController,
} from './polls/poll.controller.js';
import { CommunityContentIdentityService } from './content-identity.service.js';
import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Inject,
  Module,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { DatabaseModule } from '../database/database.js';
import { CampusModule } from '../campus/campus.module.js';
import { ProfileModule } from '../profile/profile.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { bearerToken } from '../identity/tokens.js';
import { SchemaValidationPipe } from '../http/validation.js';
import {
  campusSpaceQuerySchema,
  capabilitiesQuerySchema,
  feedQuerySchema,
  idSchema,
  pageQuerySchema,
  ownTradingQuerySchema,
  publishPostSchema,
  publishCommentSchema,
  requestIdSchema,
} from './contracts.js';
import type {
  Category,
  FeedQuery,
  PageQuery,
  OwnTradingQuery,
  PublishPost,
  PublishComment,
} from './contracts.js';
import {
  COMMUNITY_AUTHORIZATION,
  COMMUNITY_VISIBILITY,
  CONTENT_PUBLICATION_GATE,
  MEDIA_ATTACHMENT,
  UnavailableMedia,
} from './community-policy.js';
import { CommunityRepository } from './community.repository.js';
import { CommunityAccessService } from './community-access.service.js';
import { CommunitySerializer } from './community-serialization.js';
import { FeedService } from './feed.service.js';
import { PublicationRepository } from './publication.repository.js';
import { PublicationService } from './publication.service.js';
import { ReactionsService } from './reactions.service.js';
import { DeletionService } from './deletion.service.js';
@Controller('v1/community')
export class CommunityReadController {
  constructor(
    @Inject(FeedService) private readonly feeds: FeedService,
    @Inject(DiscussionReadService)
    private readonly discussion: DiscussionReadService,
  ) {}
  @Get('spaces') spaces(
    @Query(new SchemaValidationPipe(campusSpaceQuerySchema))
    query: {
      campusId: string;
    },
  ) {
    return this.feeds.spaces(query.campusId);
  }
  @Get('capabilities') capabilities(
    @Headers('authorization') auth: unknown,
    @Query(new SchemaValidationPipe(capabilitiesQuerySchema))
    query: { spaceId: string; category: Category },
  ) {
    return this.feeds.capabilities(
      bearerToken(auth),
      query.spaceId,
      query.category,
    );
  }
  @Get('posts') feed(
    @Headers('authorization') auth: unknown,
    @Query(new SchemaValidationPipe(feedQuerySchema)) query: FeedQuery,
  ) {
    return this.feeds.feed(
      auth === undefined ? null : bearerToken(auth),
      query,
    );
  }
  @Get('posts/:postId') detail(
    @Headers('authorization') auth: unknown,
    @Param('postId', new SchemaValidationPipe(idSchema)) id: string,
  ) {
    return this.feeds.detail(bearerToken(auth), id);
  }
  @Get('posts/:postId/comment-capabilities') commentCapabilities(
    @Headers('authorization') auth: unknown,
    @Param('postId', new SchemaValidationPipe(idSchema)) id: string,
  ) {
    return this.feeds.commentCapabilities(bearerToken(auth), id);
  }
  @Get('posts/:postId/comments') comments(
    @Headers('authorization') auth: unknown,
    @Param('postId', new SchemaValidationPipe(idSchema)) id: string,
    @Query(new SchemaValidationPipe(commentsQuerySchema)) query: CommentsQuery,
  ) {
    return this.discussion.comments(bearerToken(auth), id, query);
  }
}
@Controller('v1/community')
export class CommunityPublicationController {
  constructor(
    @Inject(PublicationService)
    private readonly publications: PublicationService,
    @Inject(DeletionService) private readonly deletions: DeletionService,
  ) {}
  @Post('posts') post(
    @Headers('authorization') auth: unknown,
    @Body(new SchemaValidationPipe(publishPostSchema)) body: PublishPost,
  ) {
    return this.publications.post(bearerToken(auth), body);
  }
  @Post('posts/:postId/comments') comment(
    @Headers('authorization') auth: unknown,
    @Param('postId', new SchemaValidationPipe(idSchema)) id: string,
    @Body(new SchemaValidationPipe(publishCommentSchema)) body: PublishComment,
  ) {
    return this.publications.comment(bearerToken(auth), id, body);
  }
  @Delete('posts/:postId') @HttpCode(204) deletePost(
    @Headers('authorization') auth: unknown,
    @Param('postId', new SchemaValidationPipe(idSchema)) id: string,
  ) {
    return this.deletions.post(bearerToken(auth), id);
  }
  @Delete('comments/:commentId') @HttpCode(204) deleteComment(
    @Headers('authorization') auth: unknown,
    @Param('commentId', new SchemaValidationPipe(idSchema)) id: string,
  ) {
    return this.deletions.comment(bearerToken(auth), id);
  }
}
@Controller('v1/me/community')
export class CommunityRecoveryController {
  constructor(
    @Inject(PublicationRepository)
    private readonly publications: PublicationRepository,
    @Inject(FeedService) private readonly feeds: FeedService,
  ) {}
  @Get('requests/:requestId') receipt(
    @Headers('authorization') auth: unknown,
    @Param('requestId', new SchemaValidationPipe(requestIdSchema)) id: string,
  ) {
    return this.publications.receipt(bearerToken(auth), id);
  }
  @Get('trading') ownTrading(
    @Headers('authorization') auth: unknown,
    @Query(new SchemaValidationPipe(ownTradingQuerySchema))
    query: OwnTradingQuery,
  ) {
    return this.feeds.ownTrading(bearerToken(auth), query);
  }
  @Get('posts') own(
    @Headers('authorization') auth: unknown,
    @Query(new SchemaValidationPipe(pageQuerySchema)) query: PageQuery,
  ) {
    return this.feeds.own(bearerToken(auth), query);
  }
}
@Module({
  imports: [
    CommunitySubscriptionComponentModule,
    ExperienceIngressModule,
    DatabaseModule,
    CampusModule,
    ProfileModule,
    IdentityModule,
    SafetyPolicyModule,
    VerificationModule,
    AuthorizationModule,
    ContentReviewModule,
  ],
  controllers: [
    LikedHistoryController,
    SavedController,
    SavedRecoveryController,
    FormationController,
    FormationRecoveryController,
    TradingController,
    TradingRecoveryController,
    DiscussionController,
    DiscussionRecoveryController,
    PollController,
    PollRecoveryController,
    CommunityReadController,
    CommunityPublicationController,
    PostLikeController,
    PostLikeRecoveryController,
    CommunityRecoveryController,
  ],
  exports: [
    CommunityExperienceSourceFacade,
    CommunityProfileDiscoveryFacade,
    CommunityContentIdentityService,
    CommunityUpdatesFacade,
    CommunityNamedBlockSourceFacade,
    CommunityReportTargetFacade,
    CommunityModerationRemovalFacade,
  ],
  providers: [
    CommunityExperienceSourceCapture,
    CommunityExperienceSourceFacade,
    CommunityDiscoveryCounts,
    ContentReviewCountFacade,
    DiscoveryCursorRepository,
    LikedHistoryService,
    LikedHistoryRepository,
    CommunityProfileDiscoveryFacade,
    CommunityNamedBlockSourceFacade,
    CommunityReportTargetFacade,
    CommunityModerationRemovalFacade,
    CommunityUpdatesFacade,
    SavedRepository,
    SavedReadService,
    SavedMutationService,
    FormationRepository,
    FormationService,
    TradingRepository,
    TradingService,
    DiscussionReadService,
    DiscussionMutationService,
    ReplyPublicationService,
    PollRepository,
    PollReadService,
    PollVotingService,
    BallotRequestsRepository,
    CommunityContentIdentityService,
    CommunityRepository,
    CommunityAccessService,
    CommunitySerializer,
    FeedService,
    PublicationRepository,
    PublicationService,
    ReactionsService,
    DeletionService,
    {
      provide: COMMUNITY_AUTHORIZATION,
      useClass: RuntimeCommunityAuthorization,
    },
    { provide: COMMUNITY_VISIBILITY, useExisting: NamedBlockVisibility },
    {
      provide: CONTENT_PUBLICATION_GATE,
      useExisting: LocalContentPublicationGate,
    },
    { provide: MEDIA_ATTACHMENT, useClass: UnavailableMedia },
  ],
})
export class CommunityModule {}
