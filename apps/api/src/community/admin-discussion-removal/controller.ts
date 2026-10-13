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
import { AdminDiscussionRemovalService } from './service.js';
import {
  adminDiscussionRemovalCommandSchema,
  adminDiscussionRemovalReceiptSchema,
  adminDiscussionRemovalManagementSchema,
  adminDiscussionRemovalRecoverySchema,
  adminDiscussionRemovalTargetSchema,
  adminDiscussionRemovalRequestIdSchema,
  adminDiscussionRemovalEmptyBodySchema,
  adminDiscussionRemovalEmptyQuerySchema,
} from './contracts.js';
import type {
  AdminDiscussionRemovalCommand,
  AdminDiscussionRemovalTarget,
} from './contracts.js';
@ApiTags('Scoped administrator discussion removal')
@ApiBearerAuth('accessToken')
@Controller('v1/community/admin-discussion-removal')
export class AdminDiscussionRemovalController {
  constructor(
    @Inject(AdminDiscussionRemovalService)
    private readonly moderation: AdminDiscussionRemovalService,
  ) {}
  @Get('management')
  @Header('Vary', 'Authorization')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ operationId: 'adminDiscussionRemovalManagement' })
  @ApiOkResponse({ standardSchema: adminDiscussionRemovalManagementSchema })
  management(
    @Headers('authorization') auth: unknown,
    @Query({
      schema: adminDiscussionRemovalTargetSchema,
      pipes: [new SchemaValidationPipe(adminDiscussionRemovalTargetSchema)],
    })
    target: AdminDiscussionRemovalTarget,
    @Body(new SchemaValidationPipe(adminDiscussionRemovalEmptyBodySchema))
    _body: unknown,
  ) {
    return this.moderation.management(bearerToken(auth), target);
  }
  @Post('commands')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ operationId: 'adminDiscussionRemovalCommand' })
  @ApiOkResponse({ standardSchema: adminDiscussionRemovalReceiptSchema })
  command(
    @Headers('authorization') auth: unknown,
    @Body({
      schema: adminDiscussionRemovalCommandSchema,
      pipes: [new SchemaValidationPipe(adminDiscussionRemovalCommandSchema)],
    })
    command: AdminDiscussionRemovalCommand,
    @Query({
      schema: adminDiscussionRemovalEmptyQuerySchema,
      pipes: [new SchemaValidationPipe(adminDiscussionRemovalEmptyQuerySchema)],
    })
    _query: Record<string, never>,
  ) {
    return this.moderation.command(bearerToken(auth), command);
  }
  @Get('requests/:requestId')
  @Header('Vary', 'Authorization')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ operationId: 'adminDiscussionRemovalRecovery' })
  @ApiOkResponse({ standardSchema: adminDiscussionRemovalRecoverySchema })
  recovery(
    @Headers('authorization') auth: unknown,
    @Param('requestId', {
      schema: adminDiscussionRemovalRequestIdSchema,
      pipes: [new SchemaValidationPipe(adminDiscussionRemovalRequestIdSchema)],
    })
    requestId: string,
    @Query({
      schema: adminDiscussionRemovalEmptyQuerySchema,
      pipes: [new SchemaValidationPipe(adminDiscussionRemovalEmptyQuerySchema)],
    })
    _query: Record<string, never>,
    @Body(new SchemaValidationPipe(adminDiscussionRemovalEmptyBodySchema))
    _body: unknown,
  ) {
    return this.moderation.recovery(bearerToken(auth), requestId);
  }
  @Post('commands/cancel')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ operationId: 'adminDiscussionRemovalCancel' })
  @ApiOkResponse({ standardSchema: adminDiscussionRemovalReceiptSchema })
  cancel(
    @Headers('authorization') auth: unknown,
    @Body({
      schema: adminDiscussionRemovalCommandSchema,
      pipes: [new SchemaValidationPipe(adminDiscussionRemovalCommandSchema)],
    })
    command: AdminDiscussionRemovalCommand,
    @Query({
      schema: adminDiscussionRemovalEmptyQuerySchema,
      pipes: [new SchemaValidationPipe(adminDiscussionRemovalEmptyQuerySchema)],
    })
    _query: Record<string, never>,
  ) {
    return this.moderation.command(bearerToken(auth), command, true);
  }
}
