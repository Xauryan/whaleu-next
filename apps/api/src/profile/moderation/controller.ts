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
import { ProfileModerationService } from './service.js';
import {
  moderationCommandSchema,
  moderationReceiptSchema,
  moderationManagementSchema,
  moderationRecoverySchema,
  moderationTargetSchema,
  moderationRequestIdSchema,
  moderationEmptyBodySchema,
  moderationEmptyQuerySchema,
} from './contracts.js';
import type { ModerationCommand, ModerationTarget } from './contracts.js';
@ApiTags('Scoped profile nickname moderation')
@ApiBearerAuth('accessToken')
@Controller('v1/community/profile-moderation')
export class ProfileModerationController {
  constructor(
    @Inject(ProfileModerationService)
    private readonly moderation: ProfileModerationService,
  ) {}
  @Get('management')
  @Header('Vary', 'Authorization')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ operationId: 'profileNicknameManagement' })
  @ApiOkResponse({ standardSchema: moderationManagementSchema })
  management(
    @Headers('authorization') auth: unknown,
    @Query({
      schema: moderationTargetSchema,
      pipes: [new SchemaValidationPipe(moderationTargetSchema)],
    })
    target: ModerationTarget,
    @Body(new SchemaValidationPipe(moderationEmptyBodySchema)) _body: unknown,
  ) {
    return this.moderation.management(bearerToken(auth), target);
  }
  @Post('commands')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ operationId: 'profileNicknameCommand' })
  @ApiOkResponse({ standardSchema: moderationReceiptSchema })
  command(
    @Headers('authorization') auth: unknown,
    @Body({
      schema: moderationCommandSchema,
      pipes: [new SchemaValidationPipe(moderationCommandSchema)],
    })
    command: ModerationCommand,
    @Query({
      schema: moderationEmptyQuerySchema,
      pipes: [new SchemaValidationPipe(moderationEmptyQuerySchema)],
    })
    _query: Record<string, never>,
  ) {
    return this.moderation.command(bearerToken(auth), command);
  }
  @Get('requests/:requestId')
  @Header('Vary', 'Authorization')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ operationId: 'profileNicknameRecovery' })
  @ApiOkResponse({ standardSchema: moderationRecoverySchema })
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
    @Body(new SchemaValidationPipe(moderationEmptyBodySchema)) _body: unknown,
  ) {
    return this.moderation.recovery(bearerToken(auth), requestId);
  }
  @Post('commands/cancel')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ operationId: 'profileNicknameCancel' })
  @ApiOkResponse({ standardSchema: moderationReceiptSchema })
  cancel(
    @Headers('authorization') auth: unknown,
    @Body({
      schema: moderationCommandSchema,
      pipes: [new SchemaValidationPipe(moderationCommandSchema)],
    })
    command: ModerationCommand,
    @Query({
      schema: moderationEmptyQuerySchema,
      pipes: [new SchemaValidationPipe(moderationEmptyQuerySchema)],
    })
    _query: Record<string, never>,
  ) {
    return this.moderation.command(bearerToken(auth), command, true);
  }
}
