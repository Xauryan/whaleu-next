import {
  Body,
  Controller,
  Get,
  Post,
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
import { SchemaValidationPipe } from '../../../http/validation.js';
import {
  RatingResponses,
  ratingResponseHeaders,
} from '../../../http/rating-http.js';
import { bearerToken } from '../../../identity/tokens.js';
import { RatingRequestGuard } from '../../../request-throttling/rating-request.guard.js';
import { windowIdSchema } from '../contracts.js';
import * as c from './contracts.js';
import type {
  WindowRootPublish,
  WindowReplyPublish,
  WindowDiscussionLike,
  WindowDiscussionCancel,
  WindowDiscussionQuery,
} from './contracts.js';
import { WindowDiscussionService } from './service.js';
const empty = z.strictObject({}),
  emptyBody = z.union([z.undefined(), empty]);
@ApiTags('Window discussion')
@ApiBearerAuth('accessToken')
@RatingResponses()
@UseGuards(RatingRequestGuard)
@Controller('v1/ratings/windows')
export class WindowDiscussionController {
  constructor(
    @Inject(WindowDiscussionService)
    private readonly discussion: WindowDiscussionService,
  ) {}
  @Get('discussion-requests/:requestId')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'windowDiscussionReceipt' })
  @ApiOkResponse({
    standardSchema: c.windowDiscussionReceiptSchema,
    headers: ratingResponseHeaders,
  })
  receipt(
    @Headers('authorization') auth: unknown,
    @Param('requestId', new SchemaValidationPipe(windowIdSchema))
    requestId: string,
    @Query({ schema: empty, pipes: [new SchemaValidationPipe(empty)] })
    _query: unknown,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    return this.discussion.receipt(bearerToken(auth), requestId);
  }
  @Post('discussion-requests/:requestId/cancel')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'windowDiscussionCancel' })
  @ApiOkResponse({
    standardSchema: c.windowDiscussionReceiptSchema,
    headers: ratingResponseHeaders,
  })
  cancel(
    @Headers('authorization') auth: unknown,
    @Param('requestId', new SchemaValidationPipe(windowIdSchema))
    requestId: string,
    @Query({ schema: empty, pipes: [new SchemaValidationPipe(empty)] })
    _query: unknown,
    @Body({
      schema: c.windowDiscussionCancelSchema,
      pipes: [new SchemaValidationPipe(c.windowDiscussionCancelSchema)],
    })
    input: WindowDiscussionCancel,
  ) {
    return this.discussion.cancel(bearerToken(auth), requestId, input);
  }
  @Get(':id/discussion')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'windowDiscussionList' })
  @ApiOkResponse({
    standardSchema: c.windowDiscussionPageSchema,
    headers: ratingResponseHeaders,
  })
  page(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(windowIdSchema)) id: string,
    @Query({
      schema: c.windowDiscussionQuerySchema,
      pipes: [new SchemaValidationPipe(c.windowDiscussionQuerySchema)],
    })
    query: WindowDiscussionQuery,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    return this.discussion.page(bearerToken(auth), id, query);
  }
  @Post(':id/discussion')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'windowDiscussionPublishRoot' })
  @ApiOkResponse({
    standardSchema: c.windowDiscussionReceiptSchema,
    headers: ratingResponseHeaders,
  })
  publish(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(windowIdSchema)) id: string,
    @Query({ schema: empty, pipes: [new SchemaValidationPipe(empty)] })
    _query: unknown,
    @Body({
      schema: c.windowRootPublishSchema,
      pipes: [new SchemaValidationPipe(c.windowRootPublishSchema)],
    })
    input: WindowRootPublish,
  ) {
    return this.discussion.publish(bearerToken(auth), id, input);
  }
  @Get(':id/discussion/:commentId/my-like')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'windowDiscussionOwnLike' })
  @ApiOkResponse({
    standardSchema: c.windowDiscussionOwnSchema,
    headers: ratingResponseHeaders,
  })
  own(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(windowIdSchema)) id: string,
    @Param('commentId', new SchemaValidationPipe(windowIdSchema))
    commentId: string,
    @Query({ schema: empty, pipes: [new SchemaValidationPipe(empty)] })
    _query: unknown,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    return this.discussion.own(bearerToken(auth), id, commentId);
  }
  @Post(':id/discussion/:commentId/like')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'windowDiscussionSetLike' })
  @ApiOkResponse({
    standardSchema: c.windowDiscussionReceiptSchema,
    headers: ratingResponseHeaders,
  })
  like(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(windowIdSchema)) id: string,
    @Param('commentId', new SchemaValidationPipe(windowIdSchema))
    commentId: string,
    @Query({ schema: empty, pipes: [new SchemaValidationPipe(empty)] })
    _query: unknown,
    @Body({
      schema: c.windowDiscussionLikeSchema,
      pipes: [new SchemaValidationPipe(c.windowDiscussionLikeSchema)],
    })
    input: WindowDiscussionLike,
  ) {
    return this.discussion.like(bearerToken(auth), id, commentId, input);
  }
  @Post(':id/discussion/:rootId/replies')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'windowDiscussionPublishReply' })
  @ApiOkResponse({
    standardSchema: c.windowDiscussionReceiptSchema,
    headers: ratingResponseHeaders,
  })
  reply(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(windowIdSchema)) id: string,
    @Param('rootId', new SchemaValidationPipe(windowIdSchema)) rootId: string,
    @Query({ schema: empty, pipes: [new SchemaValidationPipe(empty)] })
    _query: unknown,
    @Body({
      schema: c.windowReplyPublishSchema,
      pipes: [new SchemaValidationPipe(c.windowReplyPublishSchema)],
    })
    input: WindowReplyPublish,
  ) {
    return this.discussion.reply(bearerToken(auth), id, rootId, input);
  }
  @Get(':id/discussion/:rootId')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'windowDiscussionThread' })
  @ApiOkResponse({
    standardSchema: c.windowDiscussionPageSchema,
    headers: ratingResponseHeaders,
  })
  thread(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(windowIdSchema)) id: string,
    @Param('rootId', new SchemaValidationPipe(windowIdSchema)) rootId: string,
    @Query({
      schema: c.windowRepliesQuerySchema,
      pipes: [new SchemaValidationPipe(c.windowRepliesQuerySchema)],
    })
    query: Omit<WindowDiscussionQuery, 'sort'>,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    return this.discussion.page(
      bearerToken(auth),
      id,
      { ...query, sort: 'time' },
      rootId,
    );
  }
}
@ApiTags('Window discussion')
@ApiBearerAuth('accessToken')
@RatingResponses()
@UseGuards(RatingRequestGuard)
@Controller('v1/me/window-discussion/notices')
export class WindowDiscussionNoticesController {
  constructor(
    @Inject(WindowDiscussionService)
    private readonly discussion: WindowDiscussionService,
  ) {}
  @Get('')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'windowDiscussionNotices' })
  @ApiOkResponse({
    standardSchema: c.windowDiscussionNoticePageSchema,
    headers: ratingResponseHeaders,
  })
  page(
    @Headers('authorization') auth: unknown,
    @Query({
      schema: c.windowRepliesQuerySchema,
      pipes: [new SchemaValidationPipe(c.windowRepliesQuerySchema)],
    })
    query: Omit<WindowDiscussionQuery, 'sort'>,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    return this.discussion.noticePage(bearerToken(auth), query);
  }
  @Get(':noticeId/target')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'windowDiscussionNoticeTarget' })
  @ApiOkResponse({
    standardSchema: c.windowDiscussionTargetSchema,
    headers: ratingResponseHeaders,
  })
  target(
    @Headers('authorization') auth: unknown,
    @Param('noticeId', new SchemaValidationPipe(windowIdSchema))
    noticeId: string,
    @Query({ schema: empty, pipes: [new SchemaValidationPipe(empty)] })
    _query: unknown,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    return this.discussion.noticeTarget(bearerToken(auth), noticeId);
  }
  @Put(':noticeId/read')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'windowDiscussionNoticeRead' })
  @ApiOkResponse({
    standardSchema: c.windowDiscussionNoticeReadSchema,
    headers: ratingResponseHeaders,
  })
  read(
    @Headers('authorization') auth: unknown,
    @Param('noticeId', new SchemaValidationPipe(windowIdSchema))
    noticeId: string,
    @Query({ schema: empty, pipes: [new SchemaValidationPipe(empty)] })
    _query: unknown,
    @Body({ schema: empty, pipes: [new SchemaValidationPipe(empty)] })
    _input: Record<string, never>,
  ) {
    return this.discussion.noticeRead(bearerToken(auth), noticeId);
  }
}
