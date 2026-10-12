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
import * as c from './contracts-v2.js';
import * as legacy from './contracts.js';
import type {
  WindowRootPublishV2,
  WindowReplyPublishV2,
  WindowDiscussionCancelV2,
} from './contracts-v2.js';
import type { WindowDiscussionQuery } from './contracts.js';
import { WindowDiscussionService } from './service.js';
const empty = z.strictObject({}),
  emptyBody = z.union([z.undefined(), empty]);
@ApiTags('Window discussion')
@ApiBearerAuth('accessToken')
@RatingResponses()
@UseGuards(RatingRequestGuard)
@Controller('v2/ratings/windows')
export class WindowDiscussionV2Controller {
  constructor(
    @Inject(WindowDiscussionService)
    private readonly discussion: WindowDiscussionService,
  ) {}
  @Get('discussion-requests/:requestId')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'windowDiscussionReceiptV2' })
  @ApiOkResponse({
    standardSchema: c.windowDiscussionReceiptV2Schema,
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
    return this.discussion.receiptV2(bearerToken(auth), requestId);
  }
  @Post('discussion-requests/:requestId/cancel')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'windowDiscussionCancelV2' })
  @ApiOkResponse({
    standardSchema: c.windowDiscussionReceiptV2Schema,
    headers: ratingResponseHeaders,
  })
  cancel(
    @Headers('authorization') auth: unknown,
    @Param('requestId', new SchemaValidationPipe(windowIdSchema))
    requestId: string,
    @Query({ schema: empty, pipes: [new SchemaValidationPipe(empty)] })
    _query: unknown,
    @Body({
      schema: c.windowDiscussionCancelV2Schema,
      pipes: [new SchemaValidationPipe(c.windowDiscussionCancelV2Schema)],
    })
    input: WindowDiscussionCancelV2,
  ) {
    return this.discussion.cancelV2(bearerToken(auth), requestId, input);
  }
  @Get(':id/discussion')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'windowDiscussionListV2' })
  @ApiOkResponse({
    standardSchema: c.windowDiscussionPageV2Schema,
    headers: ratingResponseHeaders,
  })
  page(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(windowIdSchema)) id: string,
    @Query({
      schema: legacy.windowDiscussionQuerySchema,
      pipes: [new SchemaValidationPipe(legacy.windowDiscussionQuerySchema)],
    })
    query: WindowDiscussionQuery,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    return this.discussion.page(bearerToken(auth), id, query, null, true);
  }
  @Post(':id/discussion')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'windowDiscussionPublishRootV2' })
  @ApiOkResponse({
    standardSchema: c.windowDiscussionReceiptV2Schema,
    headers: ratingResponseHeaders,
  })
  publish(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(windowIdSchema)) id: string,
    @Query({ schema: empty, pipes: [new SchemaValidationPipe(empty)] })
    _query: unknown,
    @Body({
      schema: c.windowRootPublishV2Schema,
      pipes: [new SchemaValidationPipe(c.windowRootPublishV2Schema)],
    })
    input: WindowRootPublishV2,
  ) {
    return this.discussion.publishV2(bearerToken(auth), id, input);
  }
  @Post(':id/discussion/:rootId/replies')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'windowDiscussionPublishReplyV2' })
  @ApiOkResponse({
    standardSchema: c.windowDiscussionReceiptV2Schema,
    headers: ratingResponseHeaders,
  })
  reply(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(windowIdSchema)) id: string,
    @Param('rootId', new SchemaValidationPipe(windowIdSchema)) rootId: string,
    @Query({ schema: empty, pipes: [new SchemaValidationPipe(empty)] })
    _query: unknown,
    @Body({
      schema: c.windowReplyPublishV2Schema,
      pipes: [new SchemaValidationPipe(c.windowReplyPublishV2Schema)],
    })
    input: WindowReplyPublishV2,
  ) {
    return this.discussion.replyV2(bearerToken(auth), id, rootId, input);
  }
  @Get(':id/discussion/:rootId')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'windowDiscussionThreadV2' })
  @ApiOkResponse({
    standardSchema: c.windowDiscussionPageV2Schema,
    headers: ratingResponseHeaders,
  })
  thread(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(windowIdSchema)) id: string,
    @Param('rootId', new SchemaValidationPipe(windowIdSchema)) rootId: string,
    @Query({
      schema: legacy.windowRepliesQuerySchema,
      pipes: [new SchemaValidationPipe(legacy.windowRepliesQuerySchema)],
    })
    query: Omit<WindowDiscussionQuery, 'sort'>,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    return this.discussion.page(
      bearerToken(auth),
      id,
      { ...query, sort: 'time' },
      rootId,
      true,
    );
  }
}
@ApiTags('Window discussion')
@ApiBearerAuth('accessToken')
@RatingResponses()
@UseGuards(RatingRequestGuard)
@Controller('v2/me/window-discussion/notices')
export class WindowDiscussionNoticesV2Controller {
  constructor(
    @Inject(WindowDiscussionService)
    private readonly discussion: WindowDiscussionService,
  ) {}
  @Get('')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'windowDiscussionNoticesV2' })
  @ApiOkResponse({
    standardSchema: c.windowDiscussionNoticePageV2Schema,
    headers: ratingResponseHeaders,
  })
  page(
    @Headers('authorization') auth: unknown,
    @Query({
      schema: legacy.windowRepliesQuerySchema,
      pipes: [new SchemaValidationPipe(legacy.windowRepliesQuerySchema)],
    })
    query: Omit<WindowDiscussionQuery, 'sort'>,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    return this.discussion.noticePage(bearerToken(auth), query, true);
  }
  @Get(':noticeId/target')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'windowDiscussionNoticeTargetV2' })
  @ApiOkResponse({
    standardSchema: legacy.windowDiscussionTargetSchema,
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
    return this.discussion.noticeTarget(bearerToken(auth), noticeId, true);
  }
  @Put(':noticeId/read')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'windowDiscussionNoticeReadV2' })
  @ApiOkResponse({
    standardSchema: legacy.windowDiscussionNoticeReadSchema,
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
