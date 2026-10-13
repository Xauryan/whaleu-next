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
import { z } from 'zod';
import { SchemaValidationPipe } from '../../http/validation.js';
import { bearerToken } from '../../identity/tokens.js';
import { AccountAppealsService } from './service.js';
import {
  appealSubmitCommandSchema,
  appealSubmitReceiptSchema,
  appealDecisionCommandSchema,
  appealDecisionReceiptSchema,
  appealViewSchema,
  appealManagementViewSchema,
  appealPageSchema,
  appealManagementPageSchema,
  moderationPageQuerySchema,
  moderationRequestIdSchema,
  moderationIdSchema,
  moderationRecoverySchema,
  moderationEmptyQuerySchema,
} from '../account-moderation/contracts.js';
import type {
  AppealSubmitCommand,
  AppealDecisionCommand,
  ModerationPageQuery,
} from '../account-moderation/contracts.js';
const emptyBody = z.union([z.undefined(), z.strictObject({})]);
@ApiTags('Private account punishment appeals')
@ApiBearerAuth('accessToken')
@Controller('v1/me/safety')
export class AccountAppealsController {
  constructor(
    @Inject(AccountAppealsService)
    private readonly service: AccountAppealsService,
  ) {}
  @Get('appeals')
  @Header('Vary', 'Authorization')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ operationId: 'accountAppealsList' })
  @ApiOkResponse({ standardSchema: appealPageSchema })
  list(
    @Headers('authorization') auth: unknown,
    @Query({
      schema: moderationPageQuerySchema,
      pipes: [new SchemaValidationPipe(moderationPageQuerySchema)],
    })
    query: ModerationPageQuery,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    return this.service.list(bearerToken(auth), query, false);
  }
  @Get('appeals/:appealId')
  @Header('Vary', 'Authorization')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ operationId: 'accountAppealsDetail' })
  @ApiOkResponse({ standardSchema: appealViewSchema })
  detail(
    @Headers('authorization') auth: unknown,
    @Param('appealId', {
      schema: moderationIdSchema,
      pipes: [new SchemaValidationPipe(moderationIdSchema)],
    })
    appealId: string,
    @Query({
      schema: moderationEmptyQuerySchema,
      pipes: [new SchemaValidationPipe(moderationEmptyQuerySchema)],
    })
    _query: Record<string, never>,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    return this.service.detail(bearerToken(auth), appealId, false);
  }
  @Post('appeal-commands')
  @HttpCode(200)
  @Header('Vary', 'Authorization')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ operationId: 'accountAppealsCommand' })
  @ApiOkResponse({ standardSchema: appealSubmitReceiptSchema })
  command(
    @Headers('authorization') auth: unknown,
    @Body({
      schema: appealSubmitCommandSchema,
      pipes: [new SchemaValidationPipe(appealSubmitCommandSchema)],
    })
    command: AppealSubmitCommand,
    @Query({
      schema: moderationEmptyQuerySchema,
      pipes: [new SchemaValidationPipe(moderationEmptyQuerySchema)],
    })
    _query: Record<string, never>,
  ) {
    return this.service.command(bearerToken(auth), command, false);
  }
  @Post('appeal-commands/cancel')
  @HttpCode(200)
  @Header('Vary', 'Authorization')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ operationId: 'accountAppealsCancel' })
  @ApiOkResponse({ standardSchema: appealSubmitReceiptSchema })
  cancel(
    @Headers('authorization') auth: unknown,
    @Body({
      schema: appealSubmitCommandSchema,
      pipes: [new SchemaValidationPipe(appealSubmitCommandSchema)],
    })
    command: AppealSubmitCommand,
    @Query({
      schema: moderationEmptyQuerySchema,
      pipes: [new SchemaValidationPipe(moderationEmptyQuerySchema)],
    })
    _query: Record<string, never>,
  ) {
    return this.service.command(bearerToken(auth), command, true);
  }
  @Get('appeal-requests/:requestId')
  @Header('Vary', 'Authorization')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ operationId: 'accountAppealsRecovery' })
  @ApiOkResponse({
    standardSchema: moderationRecoverySchema(appealSubmitReceiptSchema),
  })
  recovery(
    @Headers('authorization') auth: unknown,
    @Param('requestId', {
      schema: moderationRequestIdSchema,
      pipes: [new SchemaValidationPipe(moderationRequestIdSchema)],
    })
    requestId: string,
    @Query({
      schema: moderationEmptyQuerySchema,
      pipes: [new SchemaValidationPipe(moderationEmptyQuerySchema)],
    })
    _query: Record<string, never>,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    return this.service.recovery(bearerToken(auth), requestId, false);
  }
}
@ApiTags('Private account punishment appeals')
@ApiBearerAuth('accessToken')
@Controller('v1/safety/appeal-management')
export class AccountAppealManagementController {
  constructor(
    @Inject(AccountAppealsService)
    private readonly service: AccountAppealsService,
  ) {}
  @Get('appeals')
  @Header('Vary', 'Authorization')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ operationId: 'accountAppealManagementList' })
  @ApiOkResponse({ standardSchema: appealManagementPageSchema })
  list(
    @Headers('authorization') auth: unknown,
    @Query({
      schema: moderationPageQuerySchema,
      pipes: [new SchemaValidationPipe(moderationPageQuerySchema)],
    })
    query: ModerationPageQuery,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    return this.service.list(bearerToken(auth), query, true);
  }
  @Get('appeals/:appealId')
  @Header('Vary', 'Authorization')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ operationId: 'accountAppealManagementDetail' })
  @ApiOkResponse({ standardSchema: appealManagementViewSchema })
  detail(
    @Headers('authorization') auth: unknown,
    @Param('appealId', {
      schema: moderationIdSchema,
      pipes: [new SchemaValidationPipe(moderationIdSchema)],
    })
    appealId: string,
    @Query({
      schema: moderationEmptyQuerySchema,
      pipes: [new SchemaValidationPipe(moderationEmptyQuerySchema)],
    })
    _query: Record<string, never>,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    return this.service.detail(bearerToken(auth), appealId, true);
  }
  @Post('commands')
  @HttpCode(200)
  @Header('Vary', 'Authorization')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ operationId: 'accountAppealManagementCommand' })
  @ApiOkResponse({ standardSchema: appealDecisionReceiptSchema })
  command(
    @Headers('authorization') auth: unknown,
    @Body({
      schema: appealDecisionCommandSchema,
      pipes: [new SchemaValidationPipe(appealDecisionCommandSchema)],
    })
    command: AppealDecisionCommand,
    @Query({
      schema: moderationEmptyQuerySchema,
      pipes: [new SchemaValidationPipe(moderationEmptyQuerySchema)],
    })
    _query: Record<string, never>,
  ) {
    return this.service.command(bearerToken(auth), command, false);
  }
  @Post('commands/cancel')
  @HttpCode(200)
  @Header('Vary', 'Authorization')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ operationId: 'accountAppealManagementCancel' })
  @ApiOkResponse({ standardSchema: appealDecisionReceiptSchema })
  cancel(
    @Headers('authorization') auth: unknown,
    @Body({
      schema: appealDecisionCommandSchema,
      pipes: [new SchemaValidationPipe(appealDecisionCommandSchema)],
    })
    command: AppealDecisionCommand,
    @Query({
      schema: moderationEmptyQuerySchema,
      pipes: [new SchemaValidationPipe(moderationEmptyQuerySchema)],
    })
    _query: Record<string, never>,
  ) {
    return this.service.command(bearerToken(auth), command, true);
  }
  @Get('requests/:requestId')
  @Header('Vary', 'Authorization')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ operationId: 'accountAppealManagementRecovery' })
  @ApiOkResponse({
    standardSchema: moderationRecoverySchema(appealDecisionReceiptSchema),
  })
  recovery(
    @Headers('authorization') auth: unknown,
    @Param('requestId', {
      schema: moderationRequestIdSchema,
      pipes: [new SchemaValidationPipe(moderationRequestIdSchema)],
    })
    requestId: string,
    @Query({
      schema: moderationEmptyQuerySchema,
      pipes: [new SchemaValidationPipe(moderationEmptyQuerySchema)],
    })
    _query: Record<string, never>,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    return this.service.recovery(bearerToken(auth), requestId, true);
  }
}
