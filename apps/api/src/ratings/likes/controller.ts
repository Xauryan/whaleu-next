import {
  Body,
  Controller,
  Get,
  Put,
  Header,
  Headers,
  HttpCode,
  Inject,
  Param,
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
import { SchemaValidationPipe } from '../../http/validation.js';
import {
  RatingResponses,
  ratingResponseHeaders,
} from '../../http/rating-http.js';
import { bearerToken } from '../../identity/tokens.js';
import { RatingRequestGuard } from '../../request-throttling/rating-request.guard.js';
import {
  ratingIdSchema,
  ratingEmptySchema,
  ratingScopeQuerySchema,
} from '../contracts.js';
import * as contracts from './contracts.js';
import { RatingLikesService } from './service.js';
const emptyBody = z.union([z.undefined(), ratingEmptySchema]);
@ApiTags('Ratings')
@ApiBearerAuth('accessToken')
@RatingResponses()
@UseGuards(RatingRequestGuard)
@Controller('v1/ratings')
export class RatingLikesController {
  constructor(
    @Inject(RatingLikesService) private readonly service: RatingLikesService,
  ) {}

  @Get('comments/:id/like')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'ratingCommentLike' })
  @ApiOkResponse({
    standardSchema: contracts.ratingLikeStateSchema,
    headers: ratingResponseHeaders,
    description: 'Current authorized like state or unavailable coverage',
  })
  commentLike(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(ratingIdSchema)) id: string,
    @Query({
      schema: ratingScopeQuerySchema,
      pipes: [new SchemaValidationPipe(ratingScopeQuerySchema)],
    })
    query: z.infer<typeof ratingScopeQuerySchema>,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    return this.service.state(
      bearerToken(auth),
      'comment',
      id,
      query.regionId ?? null,
    );
  }
  @Put('comments/:id/like')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'ratingSetCommentLike' })
  @ApiOkResponse({
    standardSchema: contracts.ratingLikeReceiptSchema,
    headers: ratingResponseHeaders,
    description: 'Minimal actor-owned desired-state receipt',
  })
  setCommentLike(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(ratingIdSchema)) id: string,
    @Query({
      schema: ratingEmptySchema,
      pipes: [new SchemaValidationPipe(ratingEmptySchema)],
    })
    query: z.infer<typeof ratingEmptySchema>,
    @Body({
      schema: contracts.setRatingCommentLikeSchema,
      pipes: [new SchemaValidationPipe(contracts.setRatingCommentLikeSchema)],
    })
    body: z.infer<typeof contracts.setRatingCommentLikeSchema>,
  ) {
    void query;
    return this.service.set(bearerToken(auth), 'comment', id, body);
  }

  @Get('replies/:id/like')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'ratingReplyLike' })
  @ApiOkResponse({
    standardSchema: contracts.ratingLikeStateSchema,
    headers: ratingResponseHeaders,
    description: 'Current authorized like state or unavailable coverage',
  })
  replyLike(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(ratingIdSchema)) id: string,
    @Query({
      schema: ratingScopeQuerySchema,
      pipes: [new SchemaValidationPipe(ratingScopeQuerySchema)],
    })
    query: z.infer<typeof ratingScopeQuerySchema>,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    return this.service.state(
      bearerToken(auth),
      'reply',
      id,
      query.regionId ?? null,
    );
  }
  @Put('replies/:id/like')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'ratingSetReplyLike' })
  @ApiOkResponse({
    standardSchema: contracts.ratingLikeReceiptSchema,
    headers: ratingResponseHeaders,
    description: 'Minimal actor-owned desired-state receipt',
  })
  setReplyLike(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(ratingIdSchema)) id: string,
    @Query({
      schema: ratingEmptySchema,
      pipes: [new SchemaValidationPipe(ratingEmptySchema)],
    })
    query: z.infer<typeof ratingEmptySchema>,
    @Body({
      schema: contracts.setRatingReplyLikeSchema,
      pipes: [new SchemaValidationPipe(contracts.setRatingReplyLikeSchema)],
    })
    body: z.infer<typeof contracts.setRatingReplyLikeSchema>,
  ) {
    void query;
    return this.service.set(bearerToken(auth), 'reply', id, body);
  }

  @Get('like-requests/:id')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'ratingLikeReceipt' })
  @ApiOkResponse({
    standardSchema: contracts.ratingLikeReceiptSchema,
    headers: ratingResponseHeaders,
    description: 'Opaque actor-owned historical receipt',
  })
  receipt(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(ratingIdSchema)) id: string,
    @Query({
      schema: ratingEmptySchema,
      pipes: [new SchemaValidationPipe(ratingEmptySchema)],
    })
    query: z.infer<typeof ratingEmptySchema>,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    void query;
    return this.service.receipt(bearerToken(auth), id);
  }
}
