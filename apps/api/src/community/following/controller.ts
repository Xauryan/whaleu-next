import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { bearerToken } from '../../identity/tokens.js';
import { SchemaValidationPipe } from '../../http/validation.js';
import { feedQuerySchema, idSchema } from '../contracts.js';
import type { FeedQuery } from '../contracts.js';
import { FeedService } from '../feed.service.js';
import { FollowingService } from './service.js';
import { followRequestSchema } from './contracts.js';
@Controller('v1')
export class FollowingController {
  constructor(
    @Inject(FollowingService) private readonly follows: FollowingService,
    @Inject(FeedService) private readonly feeds: FeedService,
  ) {}
  @Get('community/following/posts') feed(
    @Headers('authorization') auth: unknown,
    @Query(new SchemaValidationPipe(feedQuerySchema)) query: FeedQuery,
  ) {
    return this.feeds.feed(bearerToken(auth), query, true);
  }
  @Get('profiles/:profileId/follow') status(
    @Headers('authorization') auth: unknown,
    @Param('profileId', new SchemaValidationPipe(idSchema)) id: string,
  ) {
    return this.follows.status(bearerToken(auth), id);
  }
  @Post('profiles/:profileId/follow') @HttpCode(200) follow(
    @Headers('authorization') auth: unknown,
    @Param('profileId', new SchemaValidationPipe(idSchema)) id: string,
    @Body(new SchemaValidationPipe(followRequestSchema))
    body: { requestId: string },
  ) {
    return this.follows.set(bearerToken(auth), id, true, body.requestId);
  }
  @Delete('profiles/:profileId/follow') unfollow(
    @Headers('authorization') auth: unknown,
    @Param('profileId', new SchemaValidationPipe(idSchema)) id: string,
    @Body(new SchemaValidationPipe(followRequestSchema))
    body: { requestId: string },
  ) {
    return this.follows.set(bearerToken(auth), id, false, body.requestId);
  }
}
