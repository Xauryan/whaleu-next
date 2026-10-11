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
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { z } from 'zod';
import { SchemaValidationPipe } from '../../http/validation.js';
import { bearerToken } from '../../identity/tokens.js';
import {
  emptyFeedbackNoticeSchema,
  feedbackNoticeIdSchema,
  feedbackNoticeReadSchema,
  feedbackNoticeTargetSchema,
  feedbackNoticesPageSchema,
  feedbackNoticesQuerySchema,
  feedbackNoticesUnreadSchema,
} from './contracts.js';
import type { FeedbackNoticesQuery } from './contracts.js';
import { FeedbackNoticesService } from './service.js';

const emptyBody = z.union([z.undefined(), emptyFeedbackNoticeSchema]);
const headers = {
  'cache-control': { schema: { type: 'string' as const, enum: ['no-store'] } },
  vary: { schema: { type: 'string' as const, enum: ['Authorization'] } },
};
@ApiTags('Public feedback notices')
@ApiBearerAuth('accessToken')
@Controller('v1/me/feedback-notices')
export class FeedbackNoticesController {
  constructor(
    @Inject(FeedbackNoticesService)
    private readonly notices: FeedbackNoticesService,
  ) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'listFeedbackNotices',
    description:
      'Owner-only local feedback notices, requiring a current global super_admin grant. No historical post text or identity is projected.',
  })
  @ApiOkResponse({
    standardSchema: feedbackNoticesPageSchema,
    headers,
    description: 'Local feedback notice metadata',
  })
  list(
    @Headers('authorization') auth: unknown,
    @Query({
      schema: feedbackNoticesQuerySchema,
      pipes: [new SchemaValidationPipe(feedbackNoticesQuerySchema)],
    })
    query: FeedbackNoticesQuery,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    return this.notices.list(bearerToken(auth), query);
  }
  @Get('unread-count')
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'countFeedbackNotices' })
  @ApiOkResponse({
    standardSchema: feedbackNoticesUnreadSchema,
    headers,
    description: 'Owner unread count',
  })
  count(
    @Headers('authorization') auth: unknown,
    @Query({
      schema: emptyFeedbackNoticeSchema,
      pipes: [new SchemaValidationPipe(emptyFeedbackNoticeSchema)],
    })
    _query: Record<string, never>,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    return this.notices.unreadCount(bearerToken(auth));
  }
  @Get(':noticeId/target')
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'resolveFeedbackNoticeTarget',
    description:
      'Fresh ordinary post access, review and visibility checks; local notice ownership never grants content access.',
  })
  @ApiOkResponse({
    standardSchema: feedbackNoticeTargetSchema,
    headers,
    description: 'Currently accessible post or minimal unavailable result',
  })
  target(
    @Headers('authorization') auth: unknown,
    @Param('noticeId', {
      schema: feedbackNoticeIdSchema,
      pipes: [new SchemaValidationPipe(feedbackNoticeIdSchema)],
    })
    id: string,
    @Query({
      schema: emptyFeedbackNoticeSchema,
      pipes: [new SchemaValidationPipe(emptyFeedbackNoticeSchema)],
    })
    _query: Record<string, never>,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    return this.notices.target(bearerToken(auth), id);
  }
  @Put(':noticeId/read')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'readFeedbackNotice',
    description:
      'Monotonic owner-only read acknowledgment, requiring current super_admin and current post access.',
  })
  @ApiOkResponse({
    standardSchema: feedbackNoticeReadSchema,
    headers,
    description: 'First-read timestamp and current unread count',
  })
  read(
    @Headers('authorization') auth: unknown,
    @Param('noticeId', {
      schema: feedbackNoticeIdSchema,
      pipes: [new SchemaValidationPipe(feedbackNoticeIdSchema)],
    })
    id: string,
    @Query({
      schema: emptyFeedbackNoticeSchema,
      pipes: [new SchemaValidationPipe(emptyFeedbackNoticeSchema)],
    })
    _query: Record<string, never>,
    @Body({
      schema: emptyFeedbackNoticeSchema,
      pipes: [new SchemaValidationPipe(emptyFeedbackNoticeSchema)],
    })
    _body: Record<string, never>,
  ) {
    return this.notices.markRead(bearerToken(auth), id);
  }
}
