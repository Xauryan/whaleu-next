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
import * as c from './contracts-v2.js';
import * as legacy from './contracts.js';
import type {
  MajorRootPublishV2,
  MajorReplyPublishV2,
  MajorDiscussionCancelV2,
} from './contracts-v2.js';
import type { MajorDiscussionQuery } from './contracts.js';
import { MajorDiscussionService } from './service.js';
const empty = z.strictObject({}),
  emptyBody = z.union([z.undefined(), empty]);
@ApiTags('Major discussion')
@ApiBearerAuth('accessToken')
@RatingResponses()
@UseGuards(RatingRequestGuard)
@Controller('v2/majors')
export class MajorDiscussionV2Controller {
  constructor(
    @Inject(MajorDiscussionService)
    private readonly discussion: MajorDiscussionService,
  ) {}
  @Get('discussion-requests/:requestId')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'majorDiscussionReceiptV2' })
  @ApiOkResponse({
    standardSchema: c.majorDiscussionReceiptV2Schema,
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
    return this.discussion.receiptV2(bearerToken(auth), requestId);
  }
  @Post('discussion-requests/:requestId/cancel')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'majorDiscussionCancelV2' })
  @ApiOkResponse({
    standardSchema: c.majorDiscussionReceiptV2Schema,
    headers: ratingResponseHeaders,
  })
  cancel(
    @Headers('authorization') auth: unknown,
    @Param('requestId', new SchemaValidationPipe(majorIdSchema))
    requestId: string,
    @Query({ schema: empty, pipes: [new SchemaValidationPipe(empty)] })
    _query: unknown,
    @Body({
      schema: c.majorDiscussionCancelV2Schema,
      pipes: [new SchemaValidationPipe(c.majorDiscussionCancelV2Schema)],
    })
    input: MajorDiscussionCancelV2,
  ) {
    return this.discussion.cancelV2(bearerToken(auth), requestId, input);
  }
  @Get(':id/discussion')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'majorDiscussionListV2' })
  @ApiOkResponse({
    standardSchema: c.majorDiscussionPageV2Schema,
    headers: ratingResponseHeaders,
  })
  page(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(majorIdSchema)) id: string,
    @Query({
      schema: legacy.majorDiscussionQuerySchema,
      pipes: [new SchemaValidationPipe(legacy.majorDiscussionQuerySchema)],
    })
    query: MajorDiscussionQuery,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    return this.discussion.page(bearerToken(auth), id, query, null, true);
  }
  @Post(':id/discussion')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'majorDiscussionPublishRootV2' })
  @ApiOkResponse({
    standardSchema: c.majorDiscussionReceiptV2Schema,
    headers: ratingResponseHeaders,
  })
  publish(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(majorIdSchema)) id: string,
    @Query({ schema: empty, pipes: [new SchemaValidationPipe(empty)] })
    _query: unknown,
    @Body({
      schema: c.majorRootPublishV2Schema,
      pipes: [new SchemaValidationPipe(c.majorRootPublishV2Schema)],
    })
    input: MajorRootPublishV2,
  ) {
    return this.discussion.publishV2(bearerToken(auth), id, input);
  }
  @Post(':id/discussion/:rootId/replies')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'majorDiscussionPublishReplyV2' })
  @ApiOkResponse({
    standardSchema: c.majorDiscussionReceiptV2Schema,
    headers: ratingResponseHeaders,
  })
  reply(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(majorIdSchema)) id: string,
    @Param('rootId', new SchemaValidationPipe(majorIdSchema)) rootId: string,
    @Query({ schema: empty, pipes: [new SchemaValidationPipe(empty)] })
    _query: unknown,
    @Body({
      schema: c.majorReplyPublishV2Schema,
      pipes: [new SchemaValidationPipe(c.majorReplyPublishV2Schema)],
    })
    input: MajorReplyPublishV2,
  ) {
    return this.discussion.replyV2(bearerToken(auth), id, rootId, input);
  }
  @Get(':id/discussion/:rootId')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'majorDiscussionThreadV2' })
  @ApiOkResponse({
    standardSchema: c.majorDiscussionPageV2Schema,
    headers: ratingResponseHeaders,
  })
  thread(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(majorIdSchema)) id: string,
    @Param('rootId', new SchemaValidationPipe(majorIdSchema)) rootId: string,
    @Query({
      schema: legacy.majorRepliesQuerySchema,
      pipes: [new SchemaValidationPipe(legacy.majorRepliesQuerySchema)],
    })
    query: Omit<MajorDiscussionQuery, 'sort'>,
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
@ApiTags('Major discussion')
@ApiBearerAuth('accessToken')
@RatingResponses()
@UseGuards(RatingRequestGuard)
@Controller('v2/me/major-discussion/notices')
export class MajorDiscussionNoticesV2Controller {
  constructor(
    @Inject(MajorDiscussionService)
    private readonly discussion: MajorDiscussionService,
  ) {}
  @Get('')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'majorDiscussionNoticesV2' })
  @ApiOkResponse({
    standardSchema: c.majorDiscussionNoticePageV2Schema,
    headers: ratingResponseHeaders,
  })
  page(
    @Headers('authorization') auth: unknown,
    @Query({
      schema: legacy.majorRepliesQuerySchema,
      pipes: [new SchemaValidationPipe(legacy.majorRepliesQuerySchema)],
    })
    query: Omit<MajorDiscussionQuery, 'sort'>,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    return this.discussion.noticePage(bearerToken(auth), query, true);
  }
  @Get(':noticeId/target')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'majorDiscussionNoticeTargetV2' })
  @ApiOkResponse({
    standardSchema: legacy.majorDiscussionTargetSchema,
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
    return this.discussion.noticeTarget(bearerToken(auth), noticeId, true);
  }
  @Put(':noticeId/read')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'majorDiscussionNoticeReadV2' })
  @ApiOkResponse({
    standardSchema: legacy.majorDiscussionNoticeReadSchema,
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
