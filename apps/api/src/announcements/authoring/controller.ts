import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { SchemaValidationPipe } from '../../http/validation.js';
import { bearerToken } from '../../identity/tokens.js';
import { AnnouncementRequestGuard } from '../../request-throttling/announcement-request.guard.js';
import { optionalAnnouncementBearer } from '../access.js';
import { AnnouncementAuthoringService } from './service.js';
import {
  commandSchema,
  id,
  key,
  digest,
  managementQuerySchema,
  regionsQuerySchema,
} from './contracts.js';
import type { AnnouncementCommand } from './contracts.js';
import {
  announcementEmptyBodySchema,
  announcementEmptyQuerySchema,
  announcementListQuerySchema,
  announcementScopeQuerySchema,
  announcementChangesQuerySchema,
  announcementAckCommandSchema,
} from '../contracts.js';
import type {
  AnnouncementListQuery,
  AnnouncementScopeQuery,
  AnnouncementChangesQuery,
  AnnouncementAckCommand,
} from '../contracts.js';
const empty = new SchemaValidationPipe(announcementEmptyQuerySchema),
  body = new SchemaValidationPipe(announcementEmptyBodySchema);
@Controller('v1/announcement-management')
@UseGuards(AnnouncementRequestGuard)
export class AnnouncementManagementController {
  constructor(
    @Inject(AnnouncementAuthoringService)
    readonly service: AnnouncementAuthoringService,
  ) {}
  @Get('capabilities') @Header('Cache-Control', 'no-store') capabilities(
    @Headers('authorization') auth: unknown,
    @Query(empty) _query: unknown,
    @Body(body) _body: unknown,
  ) {
    return this.service.capabilities(bearerToken(auth));
  }
  @Get('regions') @Header('Cache-Control', 'no-store') regions(
    @Headers('authorization') auth: unknown,
    @Query(new SchemaValidationPipe(regionsQuerySchema))
    query: { search: string },
    @Body(body) _body: unknown,
  ) {
    return this.service.regions(bearerToken(auth), query.search);
  }
  @Get() @Header('Cache-Control', 'no-store') list(
    @Headers('authorization') auth: unknown,
    @Query(new SchemaValidationPipe(managementQuerySchema))
    query: { cursor?: string; limit: number },
    @Body(body) _body: unknown,
  ) {
    return this.service.management(bearerToken(auth), query);
  }
  @Get('requests/:requestId') @Header('Cache-Control', 'no-store') recover(
    @Headers('authorization') auth: unknown,
    @Param('requestId', new SchemaValidationPipe(key)) requestId: string,
    @Query(empty) _query: unknown,
    @Body(body) _body: unknown,
  ) {
    return this.service.recover(bearerToken(auth), requestId);
  }
  @Post('requests/:requestId/cancel')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  cancel(
    @Headers('authorization') auth: unknown,
    @Param('requestId', new SchemaValidationPipe(key)) requestId: string,
    @Query(empty) _query: unknown,
    @Body(new SchemaValidationPipe(z.strictObject({ requestHash: digest })))
    input: { requestHash: string },
  ) {
    return this.service.cancel(bearerToken(auth), requestId, input.requestHash);
  }
  @Get('draft-closure/:id') @Header('Cache-Control', 'no-store') closure(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(id)) announcementId: string,
    @Query(empty) _query: unknown,
    @Body(body) _body: unknown,
  ) {
    return this.service.closure(bearerToken(auth), announcementId);
  }
  @Get(':id') @Header('Cache-Control', 'no-store') read(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(id)) announcementId: string,
    @Query(empty) _query: unknown,
    @Body(body) _body: unknown,
  ) {
    return this.service.readManaged(bearerToken(auth), announcementId);
  }
  @Post(':id/commands')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  command(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(id)) announcementId: string,
    @Query(empty) _query: unknown,
    @Body(new SchemaValidationPipe(commandSchema)) command: AnnouncementCommand,
  ) {
    return this.service.command(bearerToken(auth), announcementId, command);
  }
}
@Controller('v1/native-announcements')
@UseGuards(AnnouncementRequestGuard)
export class NativeAnnouncementsController {
  constructor(
    @Inject(AnnouncementAuthoringService)
    readonly service: AnnouncementAuthoringService,
  ) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  list(
    @Headers('authorization') auth: unknown,
    @Query(new SchemaValidationPipe(announcementListQuerySchema))
    query: AnnouncementListQuery,
    @Body(body) _body: unknown,
  ) {
    return this.service.list(optionalAnnouncementBearer(auth), query);
  }
  @Get('popup')
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  popup(
    @Headers('authorization') auth: unknown,
    @Query(new SchemaValidationPipe(announcementScopeQuerySchema))
    query: AnnouncementScopeQuery,
    @Body(body) _body: unknown,
  ) {
    return this.service.popup(optionalAnnouncementBearer(auth), query);
  }
  @Get('changes')
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  changes(
    @Headers('authorization') auth: unknown,
    @Query(new SchemaValidationPipe(announcementChangesQuerySchema))
    query: AnnouncementChangesQuery,
    @Body(body) _body: unknown,
  ) {
    return this.service.changes(optionalAnnouncementBearer(auth), query);
  }
  @Get(':id')
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  detail(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(id)) announcementId: string,
    @Query(new SchemaValidationPipe(announcementScopeQuerySchema))
    query: AnnouncementScopeQuery,
    @Body(body) _body: unknown,
  ) {
    return this.service.detail(
      optionalAnnouncementBearer(auth),
      announcementId,
      query,
    );
  }
}
@Controller('v1/me/native-announcements')
@UseGuards(AnnouncementRequestGuard)
export class OwnNativeAnnouncementsController {
  constructor(
    @Inject(AnnouncementAuthoringService)
    readonly service: AnnouncementAuthoringService,
  ) {}
  @Get('popup')
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  popup(
    @Headers('authorization') auth: unknown,
    @Query(new SchemaValidationPipe(announcementScopeQuerySchema))
    query: AnnouncementScopeQuery,
    @Body(body) _body: unknown,
  ) {
    return this.service.popup(bearerToken(auth), query, true);
  }
  @Put(':id/popup-acknowledgement')
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  ack(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(id)) announcementId: string,
    @Query(empty) _query: unknown,
    @Body(new SchemaValidationPipe(announcementAckCommandSchema))
    command: AnnouncementAckCommand,
  ) {
    return this.service.acknowledge(bearerToken(auth), announcementId, command);
  }
}
