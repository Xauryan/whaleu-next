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
import { SchemaValidationPipe } from '../../http/validation.js';
import { bearerToken } from '../../identity/tokens.js';
import {
  emptySystemNoticeSchema,
  systemNoticeIdSchema,
  systemNoticesQuerySchema,
} from './contracts.js';
import type { SystemNoticesQuery } from './contracts.js';
import { SystemNoticesService } from './service.js';

@Controller('v1/me/system-notices')
export class SystemNoticesController {
  constructor(
    @Inject(SystemNoticesService)
    private readonly notices: SystemNoticesService,
  ) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  list(
    @Headers('authorization') auth: unknown,
    @Query(new SchemaValidationPipe(systemNoticesQuerySchema))
    query: SystemNoticesQuery,
  ) {
    return this.notices.list(bearerToken(auth), query);
  }
  @Get('unread-count')
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  count(
    @Headers('authorization') auth: unknown,
    @Query(new SchemaValidationPipe(emptySystemNoticeSchema))
    _query: Record<string, never>,
  ) {
    return this.notices.unreadCount(bearerToken(auth));
  }
  @Put(':id/read')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  read(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(systemNoticeIdSchema)) id: string,
    @Body(new SchemaValidationPipe(emptySystemNoticeSchema))
    _body: Record<string, never>,
    @Query(new SchemaValidationPipe(emptySystemNoticeSchema))
    _query: Record<string, never>,
  ) {
    return this.notices.markRead(bearerToken(auth), id);
  }
}
