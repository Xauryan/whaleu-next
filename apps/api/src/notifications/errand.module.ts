import { ErrandResponses } from '../http/errand-http.js';
import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Inject,
  Module,
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
import { DatabaseModule } from '../database/database.js';
import { IdentityModule } from '../identity/identity.module.js';
import { VerificationModule } from '../verification/verification.module.js';
import { SafetyPolicyModule } from '../safety/policy.module.js';
import { DiscoveryContinuationModule } from '../community/discovery-continuation.module.js';
import { ErrandRequestThrottlingModule } from '../request-throttling/module.js';
import { ErrandRequestGuard } from '../request-throttling/errand-request.guard.js';
import { bearerToken } from '../identity/tokens.js';
import { SchemaValidationPipe } from '../http/validation.js';
import { ErrandNotificationsFacade } from './errand.facade.js';
import { ErrandNoticesService } from './errand.service.js';
import {
  errandNoticeQuerySchema,
  errandNoticesPageSchema,
  errandNoticeReadSchema,
  errandUnreadSchema,
} from './errand-contracts.js';
import type { ErrandNoticeQuery } from './errand-contracts.js';
const empty = z.strictObject({}),
  emptyBody = z.union([z.undefined(), empty]),
  idSchema = z.uuid().transform((v) => v.toLowerCase());
const headers = {
  'cache-control': { schema: { type: 'string' as const, enum: ['no-store'] } },
  vary: { schema: { type: 'string' as const, enum: ['Authorization'] } },
};
@ErrandResponses()
@ApiTags('Errand notices')
@ApiBearerAuth('accessToken')
@UseGuards(ErrandRequestGuard)
@Controller('v1/me/errand-notices')
export class ErrandNoticesController {
  constructor(
    @Inject(ErrandNoticesService)
    private readonly notices: ErrandNoticesService,
  ) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'listErrandNotices',
    description:
      'Durable owner-only accepted/completed, administrative deletion and feature restriction/release local notices. Deletion reasons remain readable after order hiding; only participant notices navigate to freshly authorized detail.',
  })
  @ApiOkResponse({
    standardSchema: errandNoticesPageSchema,
    headers,
    description: 'Owner-only local notices',
  })
  list(
    @Headers('authorization') auth: unknown,
    @Query({
      schema: errandNoticeQuerySchema,
      pipes: [new SchemaValidationPipe(errandNoticeQuerySchema)],
    })
    query: ErrandNoticeQuery,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    return this.notices.list(bearerToken(auth), query);
  }
  @Get('unread-count')
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'countErrandNotices' })
  @ApiOkResponse({
    standardSchema: errandUnreadSchema,
    headers,
    description: 'Canonical unread count',
  })
  count(
    @Headers('authorization') auth: unknown,
    @Query({ schema: empty, pipes: [new SchemaValidationPipe(empty)] })
    _query: Record<string, never>,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    return this.notices.count(bearerToken(auth));
  }
  @Put(':noticeId/read')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'readErrandNotice' })
  @ApiOkResponse({
    standardSchema: errandNoticeReadSchema,
    headers,
    description: 'Monotonic read result with canonical unread count',
  })
  markRead(
    @Headers('authorization') auth: unknown,
    @Param('noticeId', {
      schema: idSchema,
      pipes: [new SchemaValidationPipe(idSchema)],
    })
    id: string,
    @Query({ schema: empty, pipes: [new SchemaValidationPipe(empty)] })
    _query: Record<string, never>,
    @Body({ schema: empty, pipes: [new SchemaValidationPipe(empty)] })
    _body: Record<string, never>,
  ) {
    return this.notices.markRead(bearerToken(auth), id);
  }
}
@Module({
  imports: [
    DatabaseModule,
    IdentityModule,
    VerificationModule,
    SafetyPolicyModule,
    DiscoveryContinuationModule,
    ErrandRequestThrottlingModule,
  ],
  controllers: [ErrandNoticesController],
  providers: [ErrandNotificationsFacade, ErrandNoticesService],
  exports: [ErrandNotificationsFacade],
})
export class ErrandNotificationsModule {}
