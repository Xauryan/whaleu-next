import {
  Body,
  Controller,
  Get,
  Post,
  Delete,
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
import { SchemaValidationPipe } from '../http/validation.js';
import { RatingResponses, ratingResponseHeaders } from '../http/rating-http.js';
import { bearerToken } from '../identity/tokens.js';
import { RatingRequestGuard } from '../request-throttling/rating-request.guard.js';
import {
  ratingIdSchema,
  ratingEmptySchema,
  ratingScopeQuerySchema,
} from './contracts.js';
import * as contracts from './discussion-contracts.js';
import { RatingDiscussionService } from './discussion-service.js';
const emptyBody = z.union([z.undefined(), ratingEmptySchema]);
@ApiTags('Ratings')
@ApiBearerAuth('accessToken')
@RatingResponses()
@UseGuards(RatingRequestGuard)
@Controller('v1/ratings')
export class RatingDiscussionController {
  constructor(
    @Inject(RatingDiscussionService)
    private readonly service: RatingDiscussionService,
  ) {}
  @Get('comments/:id/discussion')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'ratingDiscussion' })
  @ApiOkResponse({
    standardSchema: contracts.ratingDiscussionSchema,
    headers: ratingResponseHeaders,
    description: 'Strict current-authorized rating discussion contract',
  })
  discussion(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(ratingIdSchema)) id: string,
    @Query({
      schema: ratingScopeQuerySchema,
      pipes: [new SchemaValidationPipe(ratingScopeQuerySchema)],
    })
    query: z.infer<typeof ratingScopeQuerySchema>,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    void query;
    return this.service.thread(bearerToken(auth), id, query.regionId ?? null);
  }
  @Get('comments/:id/replies')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'ratingReplies' })
  @ApiOkResponse({
    standardSchema: contracts.ratingReplyPageSchema,
    headers: ratingResponseHeaders,
    description: 'Strict current-authorized rating discussion contract',
  })
  replies(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(ratingIdSchema)) id: string,
    @Query({
      schema: contracts.ratingReplyQuerySchema,
      pipes: [new SchemaValidationPipe(contracts.ratingReplyQuerySchema)],
    })
    query: z.infer<typeof contracts.ratingReplyQuerySchema>,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    void query;
    return this.service.listReplies(bearerToken(auth), id, query);
  }
  @Get('replies/:id')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'ratingReply' })
  @ApiOkResponse({
    standardSchema: contracts.ratingReplySchema,
    headers: ratingResponseHeaders,
    description: 'Strict current-authorized rating discussion contract',
  })
  reply(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(ratingIdSchema)) id: string,
    @Query({
      schema: ratingScopeQuerySchema,
      pipes: [new SchemaValidationPipe(ratingScopeQuerySchema)],
    })
    query: z.infer<typeof ratingScopeQuerySchema>,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    void query;
    return this.service.reply(bearerToken(auth), id, query.regionId ?? null);
  }
  @Get('replies/:id/position')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'ratingPosition' })
  @ApiOkResponse({
    standardSchema: contracts.ratingReplyPositionSchema,
    headers: ratingResponseHeaders,
    description: 'Strict current-authorized rating discussion contract',
  })
  position(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(ratingIdSchema)) id: string,
    @Query({
      schema: contracts.ratingReplyPositionQuerySchema,
      pipes: [
        new SchemaValidationPipe(contracts.ratingReplyPositionQuerySchema),
      ],
    })
    query: z.infer<typeof contracts.ratingReplyPositionQuerySchema>,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    void query;
    return this.service.locateReply(bearerToken(auth), id, query);
  }
  @Post('comments/:id/replies')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'ratingCreateReply' })
  @ApiOkResponse({
    standardSchema: contracts.ratingReplyReceiptSchema,
    headers: ratingResponseHeaders,
    description: 'Strict current-authorized rating discussion contract',
  })
  createReply(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(ratingIdSchema)) id: string,
    @Query({
      schema: ratingEmptySchema,
      pipes: [new SchemaValidationPipe(ratingEmptySchema)],
    })
    query: z.infer<typeof ratingEmptySchema>,
    @Body({
      schema: contracts.createRatingReplySchema,
      pipes: [new SchemaValidationPipe(contracts.createRatingReplySchema)],
    })
    body: z.infer<typeof contracts.createRatingReplySchema>,
  ) {
    void query;
    return this.service.createReply(bearerToken(auth), id, body);
  }
  @Delete('replies/:id')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'ratingDeleteReply' })
  @ApiOkResponse({
    standardSchema: contracts.ratingReplyReceiptSchema,
    headers: ratingResponseHeaders,
    description: 'Strict current-authorized rating discussion contract',
  })
  deleteReply(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(ratingIdSchema)) id: string,
    @Query({
      schema: ratingEmptySchema,
      pipes: [new SchemaValidationPipe(ratingEmptySchema)],
    })
    query: z.infer<typeof ratingEmptySchema>,
    @Body({
      schema: contracts.deleteRatingReplySchema,
      pipes: [new SchemaValidationPipe(contracts.deleteRatingReplySchema)],
    })
    body: z.infer<typeof contracts.deleteRatingReplySchema>,
  ) {
    void query;
    return this.service.deleteReply(bearerToken(auth), id, body);
  }
  @Get('reply-requests/:id')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'ratingReplyReceipt' })
  @ApiOkResponse({
    standardSchema: contracts.ratingReplyReceiptSchema,
    headers: ratingResponseHeaders,
    description: 'Strict current-authorized rating discussion contract',
  })
  replyReceipt(
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
