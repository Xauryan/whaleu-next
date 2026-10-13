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
import { AccountModerationService } from './service.js';
import {
  moderationPageQuerySchema,
  moderationIdSchema,
  moderationRequestIdSchema,
  moderationEmptyQuerySchema,
  punishmentStatusSchema,
  punishmentPageSchema,
  punishmentViewSchema,
  punishmentManagementViewSchema,
  punishmentManagementPageSchema,
  punishmentReleaseCommandSchema,
  punishmentReleaseReceiptSchema,
  moderationRecoverySchema,
} from './contracts.js';
import type {
  ModerationPageQuery,
  PunishmentReleaseCommand,
} from './contracts.js';

@ApiTags('Own account punishment status')
@ApiBearerAuth('accessToken')
@Controller('v1/me/safety')
export class OwnAccountModerationController {
  constructor(
    @Inject(AccountModerationService)
    private readonly service: AccountModerationService,
  ) {}
  @Get('status')
  @Header('Vary', 'Authorization')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ operationId: 'ownAccountPunishmentStatus' })
  @ApiOkResponse({ standardSchema: punishmentStatusSchema })
  status(
    @Headers('authorization') auth: unknown,
    @Query(new SchemaValidationPipe(moderationEmptyQuerySchema))
    _query: unknown,
  ) {
    return this.service.status(bearerToken(auth));
  }
  @Get('punishments')
  @Header('Vary', 'Authorization')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ operationId: 'ownAccountPunishments' })
  @ApiOkResponse({ standardSchema: punishmentPageSchema })
  list(
    @Headers('authorization') auth: unknown,
    @Query({
      schema: moderationPageQuerySchema,
      pipes: [new SchemaValidationPipe(moderationPageQuerySchema)],
    })
    query: ModerationPageQuery,
  ) {
    return this.service.ownList(bearerToken(auth), query);
  }
  @Get('punishments/:id')
  @Header('Vary', 'Authorization')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ operationId: 'ownAccountPunishment' })
  @ApiOkResponse({ standardSchema: punishmentViewSchema })
  detail(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(moderationIdSchema)) id: string,
    @Query(new SchemaValidationPipe(moderationEmptyQuerySchema))
    _query: unknown,
  ) {
    return this.service.ownDetail(bearerToken(auth), id);
  }
}
@ApiTags('Global account punishment management')
@ApiBearerAuth('accessToken')
@Controller('v1/safety/punishment-management')
export class AccountPunishmentManagementController {
  constructor(
    @Inject(AccountModerationService)
    private readonly service: AccountModerationService,
  ) {}
  @Get('punishments')
  @Header('Vary', 'Authorization')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ operationId: 'accountPunishmentManagementList' })
  @ApiOkResponse({ standardSchema: punishmentManagementPageSchema })
  list(
    @Headers('authorization') auth: unknown,
    @Query({
      schema: moderationPageQuerySchema,
      pipes: [new SchemaValidationPipe(moderationPageQuerySchema)],
    })
    query: ModerationPageQuery,
  ) {
    return this.service.adminList(bearerToken(auth), query);
  }
  @Get('punishments/:id')
  @Header('Vary', 'Authorization')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ operationId: 'accountPunishmentManagementDetail' })
  @ApiOkResponse({ standardSchema: punishmentManagementViewSchema })
  detail(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(moderationIdSchema)) id: string,
    @Query(new SchemaValidationPipe(moderationEmptyQuerySchema))
    _query: unknown,
  ) {
    return this.service.adminDetail(bearerToken(auth), id);
  }
  @Get('punishments/:id/history')
  @Header('Vary', 'Authorization')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ operationId: 'accountPunishmentManagementHistory' })
  @ApiOkResponse({ standardSchema: punishmentPageSchema })
  history(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(moderationIdSchema)) id: string,
    @Query({
      schema: moderationPageQuerySchema,
      pipes: [new SchemaValidationPipe(moderationPageQuerySchema)],
    })
    query: ModerationPageQuery,
  ) {
    return this.service.adminHistory(bearerToken(auth), id, query);
  }
  @Post('commands')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ operationId: 'accountPunishmentRelease' })
  @ApiOkResponse({ standardSchema: punishmentReleaseReceiptSchema })
  command(
    @Headers('authorization') auth: unknown,
    @Body({
      schema: punishmentReleaseCommandSchema,
      pipes: [new SchemaValidationPipe(punishmentReleaseCommandSchema)],
    })
    command: PunishmentReleaseCommand,
    @Query(new SchemaValidationPipe(moderationEmptyQuerySchema))
    _query: unknown,
  ) {
    return this.service.release(bearerToken(auth), command);
  }
  @Post('commands/cancel')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ operationId: 'accountPunishmentReleaseCancel' })
  @ApiOkResponse({ standardSchema: punishmentReleaseReceiptSchema })
  cancel(
    @Headers('authorization') auth: unknown,
    @Body({
      schema: punishmentReleaseCommandSchema,
      pipes: [new SchemaValidationPipe(punishmentReleaseCommandSchema)],
    })
    command: PunishmentReleaseCommand,
    @Query(new SchemaValidationPipe(moderationEmptyQuerySchema))
    _query: unknown,
  ) {
    return this.service.release(bearerToken(auth), command, true);
  }
  @Get('requests/:requestId')
  @Header('Vary', 'Authorization')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ operationId: 'accountPunishmentReleaseRecovery' })
  @ApiOkResponse({
    standardSchema: moderationRecoverySchema(punishmentReleaseReceiptSchema),
  })
  recovery(
    @Headers('authorization') auth: unknown,
    @Param('requestId', new SchemaValidationPipe(moderationRequestIdSchema))
    requestId: string,
    @Query(new SchemaValidationPipe(moderationEmptyQuerySchema))
    _query: unknown,
  ) {
    return this.service.recovery(bearerToken(auth), requestId);
  }
}
