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
  Put,
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
  publishPostSchema,
  publishCommentSchema,
  requestIdSchema,
} from './contracts.js';
import type {
  Category,
  FeedQuery,
  PageQuery,
  PublishPost,
  PublishComment,
} from './contracts.js';
import {
  COMMUNITY_AUTHORIZATION,
  COMMUNITY_VISIBILITY,
  CONTENT_PUBLICATION_GATE,
  MEDIA_ATTACHMENT,
  UnavailableAuthorization,
  UnavailableVisibility,
  UnavailableContentGate,
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
  constructor(@Inject(FeedService) private readonly feeds: FeedService) {}
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
    @Query(new SchemaValidationPipe(pageQuerySchema)) query: PageQuery,
  ) {
    return this.feeds.comments(bearerToken(auth), id, query);
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
@Controller('v1/community/posts')
export class CommunityReactionController {
  constructor(
    @Inject(ReactionsService) private readonly reactions: ReactionsService,
  ) {}
  @Put(':postId/like') like(
    @Headers('authorization') auth: unknown,
    @Param('postId', new SchemaValidationPipe(idSchema)) id: string,
  ) {
    return this.reactions.setLike(bearerToken(auth), id, true);
  }
  @Delete(':postId/like') unlike(
    @Headers('authorization') auth: unknown,
    @Param('postId', new SchemaValidationPipe(idSchema)) id: string,
  ) {
    return this.reactions.setLike(bearerToken(auth), id, false);
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
  @Get('posts') own(
    @Headers('authorization') auth: unknown,
    @Query(new SchemaValidationPipe(pageQuerySchema)) query: PageQuery,
  ) {
    return this.feeds.own(bearerToken(auth), query);
  }
}
@Module({
  imports: [DatabaseModule, CampusModule, ProfileModule, IdentityModule],
  controllers: [
    PollController,
    PollRecoveryController,
    CommunityReadController,
    CommunityPublicationController,
    CommunityReactionController,
    CommunityRecoveryController,
  ],
  exports: [CommunityContentIdentityService],
  providers: [
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
    { provide: COMMUNITY_AUTHORIZATION, useClass: UnavailableAuthorization },
    { provide: COMMUNITY_VISIBILITY, useClass: UnavailableVisibility },
    { provide: CONTENT_PUBLICATION_GATE, useClass: UnavailableContentGate },
    { provide: MEDIA_ATTACHMENT, useClass: UnavailableMedia },
  ],
})
export class CommunityModule {}
