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
import { SchemaValidationPipe } from '../../http/validation.js';
import {
  RatingResponses,
  ratingResponseHeaders,
} from '../../http/rating-http.js';
import { bearerToken } from '../../identity/tokens.js';
import { RatingRequestGuard } from '../../request-throttling/rating-request.guard.js';
import { majorIdSchema } from '../contracts.js';
import * as c from './contracts.js';
import type {
  MajorRootPublish,
  MajorReplyPublish,
  MajorDiscussionLike,
  MajorDiscussionCancel,
  MajorDiscussionQuery,
} from './contracts.js';
import { MajorDiscussionService } from './service.js';
const empty = z.strictObject({}),
  emptyBody = z.union([z.undefined(), empty]);
@ApiTags('Major discussion')
@ApiBearerAuth('accessToken')
@RatingResponses()
@UseGuards(RatingRequestGuard)
@Controller('v1/majors')
export class MajorDiscussionController {
  constructor(
    @Inject(MajorDiscussionService)
    private readonly discussion: MajorDiscussionService,
  ) {}
  @Get('discussion-requests/:requestId')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'majorDiscussionReceipt' })
  @ApiOkResponse({
    standardSchema: c.majorDiscussionReceiptSchema,
    headers: ratingResponseHeaders,
  })
  receipt(
    @Headers('authorization') auth: unknown,
    @Param('requestId', new SchemaValidationPipe(majorIdSchema))
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
  @ApiOperation({ operationId: 'majorDiscussionCancel' })
  @ApiOkResponse({
    standardSchema: c.majorDiscussionReceiptSchema,
    headers: ratingResponseHeaders,
  })
  cancel(
    @Headers('authorization') auth: unknown,
    @Param('requestId', new SchemaValidationPipe(majorIdSchema))
    requestId: string,
    @Query({ schema: empty, pipes: [new SchemaValidationPipe(empty)] })
    _query: unknown,
    @Body({
      schema: c.majorDiscussionCancelSchema,
      pipes: [new SchemaValidationPipe(c.majorDiscussionCancelSchema)],
    })
    input: MajorDiscussionCancel,
  ) {
    return this.discussion.cancel(bearerToken(auth), requestId, input);
  }
  @Get(':id/discussion')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'majorDiscussionList' })
  @ApiOkResponse({
    standardSchema: c.majorDiscussionPageSchema,
    headers: ratingResponseHeaders,
  })
  page(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(majorIdSchema)) id: string,
    @Query({
      schema: c.majorDiscussionQuerySchema,
      pipes: [new SchemaValidationPipe(c.majorDiscussionQuerySchema)],
    })
    query: MajorDiscussionQuery,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    return this.discussion.page(bearerToken(auth), id, query);
  }
  @Post(':id/discussion')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'majorDiscussionPublishRoot' })
  @ApiOkResponse({
    standardSchema: c.majorDiscussionReceiptSchema,
    headers: ratingResponseHeaders,
  })
  publish(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(majorIdSchema)) id: string,
    @Query({ schema: empty, pipes: [new SchemaValidationPipe(empty)] })
    _query: unknown,
    @Body({
      schema: c.majorRootPublishSchema,
      pipes: [new SchemaValidationPipe(c.majorRootPublishSchema)],
    })
    input: MajorRootPublish,
  ) {
    return this.discussion.publish(bearerToken(auth), id, input);
  }
  @Get(':id/discussion/:commentId/my-like')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'majorDiscussionOwnLike' })
  @ApiOkResponse({
    standardSchema: c.majorDiscussionOwnSchema,
    headers: ratingResponseHeaders,
  })
  own(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(majorIdSchema)) id: string,
    @Param('commentId', new SchemaValidationPipe(majorIdSchema))
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
  @ApiOperation({ operationId: 'majorDiscussionSetLike' })
  @ApiOkResponse({
    standardSchema: c.majorDiscussionReceiptSchema,
    headers: ratingResponseHeaders,
  })
  like(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(majorIdSchema)) id: string,
    @Param('commentId', new SchemaValidationPipe(majorIdSchema))
    commentId: string,
    @Query({ schema: empty, pipes: [new SchemaValidationPipe(empty)] })
    _query: unknown,
    @Body({
      schema: c.majorDiscussionLikeSchema,
      pipes: [new SchemaValidationPipe(c.majorDiscussionLikeSchema)],
    })
    input: MajorDiscussionLike,
  ) {
    return this.discussion.like(bearerToken(auth), id, commentId, input);
  }
  @Post(':id/discussion/:rootId/replies')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'majorDiscussionPublishReply' })
  @ApiOkResponse({
    standardSchema: c.majorDiscussionReceiptSchema,
    headers: ratingResponseHeaders,
  })
  reply(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(majorIdSchema)) id: string,
    @Param('rootId', new SchemaValidationPipe(majorIdSchema)) rootId: string,
    @Query({ schema: empty, pipes: [new SchemaValidationPipe(empty)] })
    _query: unknown,
    @Body({
      schema: c.majorReplyPublishSchema,
      pipes: [new SchemaValidationPipe(c.majorReplyPublishSchema)],
    })
    input: MajorReplyPublish,
  ) {
    return this.discussion.reply(bearerToken(auth), id, rootId, input);
  }
  @Get(':id/discussion/:rootId')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'majorDiscussionThread' })
  @ApiOkResponse({
    standardSchema: c.majorDiscussionPageSchema,
    headers: ratingResponseHeaders,
  })
  thread(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(majorIdSchema)) id: string,
    @Param('rootId', new SchemaValidationPipe(majorIdSchema)) rootId: string,
    @Query({
      schema: c.majorRepliesQuerySchema,
      pipes: [new SchemaValidationPipe(c.majorRepliesQuerySchema)],
    })
    query: Omit<MajorDiscussionQuery, 'sort'>,
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
@ApiTags('Major discussion')
@ApiBearerAuth('accessToken')
@RatingResponses()
@UseGuards(RatingRequestGuard)
@Controller('v1/me/major-discussion/notices')
export class MajorDiscussionNoticesController {
  constructor(
    @Inject(MajorDiscussionService)
    private readonly discussion: MajorDiscussionService,
  ) {}
  @Get('')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'majorDiscussionNotices' })
  @ApiOkResponse({
    standardSchema: c.majorDiscussionNoticePageSchema,
    headers: ratingResponseHeaders,
  })
  page(
    @Headers('authorization') auth: unknown,
    @Query({
      schema: c.majorRepliesQuerySchema,
      pipes: [new SchemaValidationPipe(c.majorRepliesQuerySchema)],
    })
    query: Omit<MajorDiscussionQuery, 'sort'>,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    return this.discussion.noticePage(bearerToken(auth), query);
  }
  @Get(':noticeId/target')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'majorDiscussionNoticeTarget' })
  @ApiOkResponse({
    standardSchema: c.majorDiscussionTargetSchema,
    headers: ratingResponseHeaders,
  })
  target(
    @Headers('authorization') auth: unknown,
    @Param('noticeId', new SchemaValidationPipe(majorIdSchema))
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
  @ApiOperation({ operationId: 'majorDiscussionNoticeRead' })
  @ApiOkResponse({
    standardSchema: c.majorDiscussionNoticeReadSchema,
    headers: ratingResponseHeaders,
  })
  read(
    @Headers('authorization') auth: unknown,
    @Param('noticeId', new SchemaValidationPipe(majorIdSchema))
    noticeId: string,
    @Query({ schema: empty, pipes: [new SchemaValidationPipe(empty)] })
    _query: unknown,
    @Body({ schema: empty, pipes: [new SchemaValidationPipe(empty)] })
    _input: Record<string, never>,
  ) {
    return this.discussion.noticeRead(bearerToken(auth), noticeId);
  }
}
