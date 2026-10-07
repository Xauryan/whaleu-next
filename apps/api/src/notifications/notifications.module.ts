import { UpdatesDispatcher } from './dispatcher.js';
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Module,
  Param,
  Put,
  Query,
} from '@nestjs/common';
import { DatabaseModule } from '../database/database.js';
import { IdentityModule } from '../identity/identity.module.js';
import { CommunityModule } from '../community/community.module.js';
import { bearerToken } from '../identity/tokens.js';
import { SchemaValidationPipe } from '../http/validation.js';
import { idSchema } from '../community/contracts.js';
import { emptyUpdatesSchema, updatesQuerySchema } from './contracts.js';
import type { UpdatesQuery } from './contracts.js';
import { NotificationsRepository } from './repository.js';
import { UpdatesReadService } from './read.service.js';
import { UpdatesWorker } from './worker.js';
@Controller('v1/me/community/updates')
export class UpdatesController {
  constructor(
    @Inject(UpdatesReadService) private readonly updates: UpdatesReadService,
  ) {}
  @Get() list(
    @Headers('authorization') auth: unknown,
    @Query(new SchemaValidationPipe(updatesQuerySchema)) query: UpdatesQuery,
  ) {
    return this.updates.list(bearerToken(auth), query);
  }
  @Get('unread-count') count(
    @Headers('authorization') auth: unknown,
    @Query(new SchemaValidationPipe(emptyUpdatesSchema))
    _query: Record<string, never>,
  ) {
    return this.updates.unreadCount(bearerToken(auth));
  }
  @Get(':noticeId/target') target(
    @Headers('authorization') auth: unknown,
    @Param('noticeId', new SchemaValidationPipe(idSchema)) id: string,
    @Query(new SchemaValidationPipe(emptyUpdatesSchema))
    _query: Record<string, never>,
  ) {
    return this.updates.target(bearerToken(auth), id);
  }
  @Put(':noticeId/read') @HttpCode(200) read(
    @Headers('authorization') auth: unknown,
    @Param('noticeId', new SchemaValidationPipe(idSchema)) id: string,
    @Body(new SchemaValidationPipe(emptyUpdatesSchema))
    _body: Record<string, never>,
    @Query(new SchemaValidationPipe(emptyUpdatesSchema))
    _query: Record<string, never>,
  ) {
    return this.updates.markRead(bearerToken(auth), id);
  }
}
@Module({
  imports: [DatabaseModule, IdentityModule, CommunityModule],
  controllers: [UpdatesController],
  providers: [
    NotificationsRepository,
    UpdatesReadService,
    UpdatesWorker,
    UpdatesDispatcher,
  ],
  exports: [UpdatesWorker],
})
export class NotificationsModule {}
