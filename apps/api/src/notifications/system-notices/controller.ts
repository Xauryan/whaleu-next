import {
  Body,
  Controller,
  Get,
  Headers,
  Header,
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
import { SchemaValidationPipe } from '../../http/validation.js';
import { bearerToken } from '../../identity/tokens.js';
import {
  emptySystemNoticeSchema,
  systemNoticeIdSchema,
  systemNoticeReadSchema,
  systemNoticesPageSchema,
  systemNoticesQuerySchema,
  systemNoticesUnreadSchema,
} from './contracts.js';
import type { SystemNoticesQuery } from './contracts.js';
import { SystemNoticesService } from './service.js';

@ApiTags('Owner system notices')
@ApiBearerAuth('accessToken')
@Controller('v1/me/system-notices')
export class SystemNoticesController {
  constructor(
    @Inject(SystemNoticesService)
    private readonly notices: SystemNoticesService,
  ) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'systemNoticesList' })
  @ApiOkResponse({ standardSchema: systemNoticesPageSchema })
  list(
    @Headers('authorization') auth: unknown,
    @Query({
      schema: systemNoticesQuerySchema,
      pipes: [new SchemaValidationPipe(systemNoticesQuerySchema)],
    })
    query: SystemNoticesQuery,
  ) {
    return this.notices.list(bearerToken(auth), query);
  }
  @Get('unread-count')
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'systemNoticesUnreadCount' })
  @ApiOkResponse({ standardSchema: systemNoticesUnreadSchema })
  count(
    @Headers('authorization') auth: unknown,
    @Query({
      schema: emptySystemNoticeSchema,
      pipes: [new SchemaValidationPipe(emptySystemNoticeSchema)],
    })
    _query: Record<string, never>,
  ) {
    return this.notices.unreadCount(bearerToken(auth));
  }
  @Put(':id/read')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'systemNoticeMarkRead' })
  @ApiOkResponse({ standardSchema: systemNoticeReadSchema })
  read(
    @Headers('authorization') auth: unknown,
    @Param('id', {
      schema: systemNoticeIdSchema,
      pipes: [new SchemaValidationPipe(systemNoticeIdSchema)],
    })
    id: string,
    @Body({
      schema: emptySystemNoticeSchema,
      pipes: [new SchemaValidationPipe(emptySystemNoticeSchema)],
    })
    _body: Record<string, never>,
    @Query({
      schema: emptySystemNoticeSchema,
      pipes: [new SchemaValidationPipe(emptySystemNoticeSchema)],
    })
    _query: Record<string, never>,
  ) {
    return this.notices.markRead(bearerToken(auth), id);
  }
}
