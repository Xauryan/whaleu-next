import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Inject,
  Param,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { z } from 'zod';
import {
  RatingResponses,
  ratingResponseHeaders,
} from '../../http/rating-http.js';
import { SchemaValidationPipe } from '../../http/validation.js';
import { bearerToken } from '../../identity/tokens.js';
import { ratingIdSchema } from '../../ratings/contracts.js';
import { RatingRequestGuard } from '../../request-throttling/rating-request.guard.js';
import * as contracts from './subscription-contracts.js';
import type { RatingSubscriptionUpdatesQuery } from './subscription-contracts.js';
import { RatingSubscriptionUpdatesReadService } from './subscription-read.service.js';
const emptyGetBody = z.union([
  z.undefined(),
  contracts.ratingSubscriptionUpdatesEmptySchema,
]);
@ApiTags('Rating subscription updates')
@ApiBearerAuth('accessToken')
@RatingResponses()
@UseGuards(RatingRequestGuard)
@Controller('v1/me/ratings/subscription-updates')
export class RatingSubscriptionUpdatesController {
  constructor(
    @Inject(RatingSubscriptionUpdatesReadService)
    private readonly updates: RatingSubscriptionUpdatesReadService,
  ) {}
  @Get()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'ratingSubscriptionUpdates',
    description:
      'Owner-only local rating subscriptions with current safe previews and opaque pagination. Maximum twenty notices.',
  })
  @ApiOkResponse({
    standardSchema: contracts.ratingSubscriptionUpdatesPageSchema,
    headers: ratingResponseHeaders,
    description: 'Strict local rating updates page',
  })
  list(
    @Headers('authorization') auth: unknown,
    @Query({
      schema: contracts.ratingSubscriptionUpdatesQuerySchema,
      pipes: [
        new SchemaValidationPipe(
          contracts.ratingSubscriptionUpdatesQuerySchema,
        ),
      ],
    })
    query: RatingSubscriptionUpdatesQuery,
    @Body(new SchemaValidationPipe(emptyGetBody)) _body: unknown,
  ) {
    return this.updates.list(bearerToken(auth), query);
  }

  @Get('unread-count')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'ratingSubscriptionUpdatesUnreadCount',
    description:
      'Counts this owner’s materialized unread rating notices, including currently unavailable notices.',
  })
  @ApiOkResponse({
    standardSchema: contracts.ratingSubscriptionUnreadCountSchema,
    headers: ratingResponseHeaders,
    description: 'Rating-only unread count',
  })
  count(
    @Headers('authorization') auth: unknown,
    @Query({
      schema: contracts.ratingSubscriptionUpdatesEmptySchema,
      pipes: [
        new SchemaValidationPipe(
          contracts.ratingSubscriptionUpdatesEmptySchema,
        ),
      ],
    })
    _query: Record<string, never>,
    @Body(new SchemaValidationPipe(emptyGetBody)) _body: unknown,
  ) {
    return this.updates.unreadCount(bearerToken(auth));
  }

  @Get(':noticeId/target')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'ratingSubscriptionNoticeTarget',
    description:
      'Resolves the current authorized typed rating target without marking the notice read.',
  })
  @ApiOkResponse({
    standardSchema: contracts.ratingSubscriptionNoticeTargetSchema,
    headers: ratingResponseHeaders,
    description: 'Current target or strictly generic unavailable result',
  })
  target(
    @Headers('authorization') auth: unknown,
    @Param('noticeId', new SchemaValidationPipe(ratingIdSchema))
    noticeId: string,
    @Query({
      schema: contracts.ratingSubscriptionUpdatesEmptySchema,
      pipes: [
        new SchemaValidationPipe(
          contracts.ratingSubscriptionUpdatesEmptySchema,
        ),
      ],
    })
    _query: Record<string, never>,
    @Body(new SchemaValidationPipe(emptyGetBody)) _body: unknown,
  ) {
    return this.updates.target(bearerToken(auth), noticeId);
  }

  @Put(':noticeId/read')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'ratingSubscriptionNoticeRead',
    description:
      'Idempotently marks this owner’s notice read, including an unavailable notice; retains its original exact read timestamp.',
  })
  @ApiOkResponse({
    standardSchema: contracts.ratingSubscriptionNoticeReadSchema,
    headers: ratingResponseHeaders,
    description: 'Owner read timestamp and current rating unread count',
  })
  read(
    @Headers('authorization') auth: unknown,
    @Param('noticeId', new SchemaValidationPipe(ratingIdSchema))
    noticeId: string,
    @Query({
      schema: contracts.ratingSubscriptionUpdatesEmptySchema,
      pipes: [
        new SchemaValidationPipe(
          contracts.ratingSubscriptionUpdatesEmptySchema,
        ),
      ],
    })
    _query: Record<string, never>,
    @Body({
      schema: contracts.ratingSubscriptionUpdatesEmptySchema,
      pipes: [
        new SchemaValidationPipe(
          contracts.ratingSubscriptionUpdatesEmptySchema,
        ),
      ],
    })
    _body: Record<string, never>,
  ) {
    return this.updates.markRead(bearerToken(auth), noticeId);
  }
}
