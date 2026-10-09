import {
  Body,
  Controller,
  Get,
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
import { SchemaValidationPipe } from '../../http/validation.js';
import {
  RatingResponses,
  ratingResponseHeaders,
} from '../../http/rating-http.js';
import { bearerToken } from '../../identity/tokens.js';
import { RatingRequestGuard } from '../../request-throttling/rating-request.guard.js';
import { ratingIdSchema, ratingEmptySchema } from '../contracts.js';
import { RatingDeletionService } from './service.js';
import * as contracts from './contracts.js';
const emptyBody = z.union([z.undefined(), ratingEmptySchema]);
@ApiTags('Ratings deletion')
@ApiBearerAuth('accessToken')
@RatingResponses()
@UseGuards(RatingRequestGuard)
@Controller('v1/ratings')
export class RatingDeletionController {
  constructor(
    @Inject(RatingDeletionService)
    private readonly service: RatingDeletionService,
  ) {}
  @Get('comments/:id/deletion-context')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'ratingOwnerCommentContext' })
  @ApiOkResponse({
    standardSchema: contracts.ratingDeletionContextSchema,
    headers: ratingResponseHeaders,
    description:
      'Strict minimal deletion metadata; never content or author identity',
  })
  ownerCommentContext(
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
    return this.service.ownerContext(bearerToken(auth), 'comment', id);
  }
  @Get('replies/:id/deletion-context')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'ratingOwnerReplyContext' })
  @ApiOkResponse({
    standardSchema: contracts.ratingDeletionContextSchema,
    headers: ratingResponseHeaders,
    description:
      'Strict minimal deletion metadata; never content or author identity',
  })
  ownerReplyContext(
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
    return this.service.ownerContext(bearerToken(auth), 'reply', id);
  }
  @Get('admin/comments/:id/deletion-context')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'ratingAdminCommentContext' })
  @ApiOkResponse({
    standardSchema: contracts.ratingAdminDeletionContextSchema,
    headers: ratingResponseHeaders,
    description:
      'Strict minimal deletion metadata; never content or author identity',
  })
  adminCommentContext(
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
    return this.service.adminContext(bearerToken(auth), 'comment', id);
  }
  @Get('admin/replies/:id/deletion-context')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'ratingAdminReplyContext' })
  @ApiOkResponse({
    standardSchema: contracts.ratingAdminDeletionContextSchema,
    headers: ratingResponseHeaders,
    description:
      'Strict minimal deletion metadata; never content or author identity',
  })
  adminReplyContext(
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
    return this.service.adminContext(bearerToken(auth), 'reply', id);
  }
  @Get('admin/requests/:id')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'ratingAdminReceipt' })
  @ApiOkResponse({
    standardSchema: contracts.ratingAdminDeletionReceiptSchema,
    headers: ratingResponseHeaders,
    description:
      'Strict minimal deletion metadata; never content or author identity',
  })
  adminReceipt(
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
  @Delete('admin/comments/:id')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'ratingAdminDeleteComment' })
  @ApiOkResponse({
    standardSchema: contracts.ratingAdminDeletionReceiptSchema,
    headers: ratingResponseHeaders,
    description:
      'Strict minimal deletion metadata; never content or author identity',
  })
  adminDeleteComment(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(ratingIdSchema)) id: string,
    @Query({
      schema: ratingEmptySchema,
      pipes: [new SchemaValidationPipe(ratingEmptySchema)],
    })
    query: z.infer<typeof ratingEmptySchema>,
    @Body({
      schema: contracts.adminDeleteRatingCommentSchema,
      pipes: [
        new SchemaValidationPipe(contracts.adminDeleteRatingCommentSchema),
      ],
    })
    body: z.infer<typeof contracts.adminDeleteRatingCommentSchema>,
  ) {
    void query;
    return this.service.deleteComment(bearerToken(auth), id, body);
  }
  @Delete('admin/replies/:id')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'ratingAdminDeleteReply' })
  @ApiOkResponse({
    standardSchema: contracts.ratingAdminDeletionReceiptSchema,
    headers: ratingResponseHeaders,
    description:
      'Strict minimal deletion metadata; never content or author identity',
  })
  adminDeleteReply(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(ratingIdSchema)) id: string,
    @Query({
      schema: ratingEmptySchema,
      pipes: [new SchemaValidationPipe(ratingEmptySchema)],
    })
    query: z.infer<typeof ratingEmptySchema>,
    @Body({
      schema: contracts.adminDeleteRatingReplySchema,
      pipes: [new SchemaValidationPipe(contracts.adminDeleteRatingReplySchema)],
    })
    body: z.infer<typeof contracts.adminDeleteRatingReplySchema>,
  ) {
    void query;
    return this.service.deleteReply(bearerToken(auth), id, body);
  }
}
