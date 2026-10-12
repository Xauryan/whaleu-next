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
import { AdminPostRemovalService } from './service.js';
import {
  adminPostRemovalCommandSchema,
  adminPostRemovalReceiptSchema,
  adminPostRemovalManagementSchema,
  adminPostRemovalRecoverySchema,
  adminPostRemovalTargetSchema,
  adminPostRemovalRequestIdSchema,
  adminPostRemovalEmptyBodySchema,
  adminPostRemovalEmptyQuerySchema,
} from './contracts.js';
import type {
  AdminPostRemovalCommand,
  AdminPostRemovalTarget,
} from './contracts.js';
@ApiTags('Scoped administrator post removal')
@ApiBearerAuth('accessToken')
@Controller('v1/community/admin-post-removal')
export class AdminPostRemovalController {
  constructor(
    @Inject(AdminPostRemovalService)
    private readonly moderation: AdminPostRemovalService,
  ) {}
  @Get('management')
  @Header('Vary', 'Authorization')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ operationId: 'adminPostRemovalManagement' })
  @ApiOkResponse({ standardSchema: adminPostRemovalManagementSchema })
  management(
    @Headers('authorization') auth: unknown,
    @Query({
      schema: adminPostRemovalTargetSchema,
      pipes: [new SchemaValidationPipe(adminPostRemovalTargetSchema)],
    })
    target: AdminPostRemovalTarget,
    @Body(new SchemaValidationPipe(adminPostRemovalEmptyBodySchema))
    _body: unknown,
  ) {
    return this.moderation.management(bearerToken(auth), target);
  }
  @Post('commands')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ operationId: 'adminPostRemovalCommand' })
  @ApiOkResponse({ standardSchema: adminPostRemovalReceiptSchema })
  command(
    @Headers('authorization') auth: unknown,
    @Body({
      schema: adminPostRemovalCommandSchema,
      pipes: [new SchemaValidationPipe(adminPostRemovalCommandSchema)],
    })
    command: AdminPostRemovalCommand,
    @Query({
      schema: adminPostRemovalEmptyQuerySchema,
      pipes: [new SchemaValidationPipe(adminPostRemovalEmptyQuerySchema)],
    })
    _query: Record<string, never>,
  ) {
    return this.moderation.command(bearerToken(auth), command);
  }
  @Get('requests/:requestId')
  @Header('Vary', 'Authorization')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ operationId: 'adminPostRemovalRecovery' })
  @ApiOkResponse({ standardSchema: adminPostRemovalRecoverySchema })
  recovery(
    @Headers('authorization') auth: unknown,
    @Param('requestId', {
      schema: adminPostRemovalRequestIdSchema,
      pipes: [new SchemaValidationPipe(adminPostRemovalRequestIdSchema)],
    })
    requestId: string,
    @Query({
      schema: adminPostRemovalEmptyQuerySchema,
      pipes: [new SchemaValidationPipe(adminPostRemovalEmptyQuerySchema)],
    })
    _query: Record<string, never>,
    @Body(new SchemaValidationPipe(adminPostRemovalEmptyBodySchema))
    _body: unknown,
  ) {
    return this.moderation.recovery(bearerToken(auth), requestId);
  }
  @Post('commands/cancel')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ operationId: 'adminPostRemovalCancel' })
  @ApiOkResponse({ standardSchema: adminPostRemovalReceiptSchema })
  cancel(
    @Headers('authorization') auth: unknown,
    @Body({
      schema: adminPostRemovalCommandSchema,
      pipes: [new SchemaValidationPipe(adminPostRemovalCommandSchema)],
    })
    command: AdminPostRemovalCommand,
    @Query({
      schema: adminPostRemovalEmptyQuerySchema,
      pipes: [new SchemaValidationPipe(adminPostRemovalEmptyQuerySchema)],
    })
    _query: Record<string, never>,
  ) {
    return this.moderation.command(bearerToken(auth), command, true);
  }
}
