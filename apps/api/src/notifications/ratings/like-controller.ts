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
import * as contracts from './contracts.js';
import * as likes from './like-contracts.js';
import type { RatingUpdatesQuery } from './contracts.js';
import { RatingLikeUpdatesReadService } from './like-read.service.js';
const emptyGetBody = z.union([
  z.undefined(),
  contracts.ratingUpdatesEmptySchema,
]);
@ApiTags('Rating updates')
@ApiBearerAuth('accessToken')
@RatingResponses()
@UseGuards(RatingRequestGuard)
@Controller('v1/me/ratings/like-updates')
export class RatingLikeUpdatesController {
  constructor(
    @Inject(RatingLikeUpdatesReadService)
    private readonly updates: RatingLikeUpdatesReadService,
  ) {}
  @Get()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'ratingLikeUpdates',
    description:
      'Owner-only local rating likes with current safe previews and opaque pagination. Maximum twenty notices.',
  })
  @ApiOkResponse({
    standardSchema: likes.ratingLikeUpdatesPageSchema,
    headers: ratingResponseHeaders,
    description: 'Strict local rating updates page',
  })
  list(
    @Headers('authorization') auth: unknown,
    @Query({
      schema: contracts.ratingUpdatesQuerySchema,
      pipes: [new SchemaValidationPipe(contracts.ratingUpdatesQuerySchema)],
    })
    query: RatingUpdatesQuery,
    @Body(new SchemaValidationPipe(emptyGetBody)) _body: unknown,
  ) {
    return this.updates.list(bearerToken(auth), query);
  }

  @Get('unread-count')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'ratingLikeUpdatesUnreadCount',
    description:
      'Counts this owner’s materialized unread rating like notices, including currently unavailable notices.',
  })
  @ApiOkResponse({
    standardSchema: contracts.ratingUnreadCountSchema,
    headers: ratingResponseHeaders,
    description: 'Rating-like-only unread count',
  })
  count(
    @Headers('authorization') auth: unknown,
    @Query({
      schema: contracts.ratingUpdatesEmptySchema,
      pipes: [new SchemaValidationPipe(contracts.ratingUpdatesEmptySchema)],
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
    operationId: 'ratingLikeNoticeTarget',
    description:
      'Resolves the current authorized typed rating target without marking the notice read.',
  })
  @ApiOkResponse({
    standardSchema: likes.ratingLikeNoticeTargetSchema,
    headers: ratingResponseHeaders,
    description: 'Current target or strictly generic unavailable result',
  })
  target(
    @Headers('authorization') auth: unknown,
    @Param('noticeId', new SchemaValidationPipe(ratingIdSchema))
    noticeId: string,
    @Query({
      schema: contracts.ratingUpdatesEmptySchema,
      pipes: [new SchemaValidationPipe(contracts.ratingUpdatesEmptySchema)],
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
    operationId: 'ratingLikeNoticeRead',
    description:
      'Idempotently marks this owner’s notice read, including an unavailable notice; retains its original exact read timestamp.',
  })
  @ApiOkResponse({
    standardSchema: contracts.ratingNoticeReadSchema,
    headers: ratingResponseHeaders,
    description: 'Owner read timestamp and current rating unread count',
  })
  read(
    @Headers('authorization') auth: unknown,
    @Param('noticeId', new SchemaValidationPipe(ratingIdSchema))
    noticeId: string,
    @Query({
      schema: contracts.ratingUpdatesEmptySchema,
      pipes: [new SchemaValidationPipe(contracts.ratingUpdatesEmptySchema)],
    })
    _query: Record<string, never>,
    @Body({
      schema: contracts.ratingUpdatesEmptySchema,
      pipes: [new SchemaValidationPipe(contracts.ratingUpdatesEmptySchema)],
    })
    _body: Record<string, never>,
  ) {
    return this.updates.markRead(bearerToken(auth), noticeId);
  }
}
