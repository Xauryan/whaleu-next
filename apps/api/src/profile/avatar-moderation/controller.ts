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
import { ProfileAvatarModerationService } from './service.js';
import {
  avatarModerationCommandSchema,
  avatarModerationReceiptSchema,
  avatarModerationManagementSchema,
  avatarModerationRecoverySchema,
  avatarModerationTargetSchema,
  avatarModerationRequestIdSchema,
  avatarModerationEmptyBodySchema,
  avatarModerationEmptyQuerySchema,
} from './contracts.js';
import type {
  AvatarModerationCommand,
  AvatarModerationTarget,
} from './contracts.js';
@ApiTags('Scoped profile custom avatar moderation')
@ApiBearerAuth('accessToken')
@Controller('v1/community/profile-avatar-moderation')
export class ProfileAvatarModerationController {
  constructor(
    @Inject(ProfileAvatarModerationService)
    private readonly moderation: ProfileAvatarModerationService,
  ) {}
  @Get('management')
  @Header('Vary', 'Authorization')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ operationId: 'profileAvatarClearManagement' })
  @ApiOkResponse({ standardSchema: avatarModerationManagementSchema })
  management(
    @Headers('authorization') auth: unknown,
    @Query({
      schema: avatarModerationTargetSchema,
      pipes: [new SchemaValidationPipe(avatarModerationTargetSchema)],
    })
    target: AvatarModerationTarget,
    @Body(new SchemaValidationPipe(avatarModerationEmptyBodySchema))
    _body: unknown,
  ) {
    return this.moderation.management(bearerToken(auth), target);
  }
  @Post('commands')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ operationId: 'profileAvatarClearCommand' })
  @ApiOkResponse({ standardSchema: avatarModerationReceiptSchema })
  command(
    @Headers('authorization') auth: unknown,
    @Body({
      schema: avatarModerationCommandSchema,
      pipes: [new SchemaValidationPipe(avatarModerationCommandSchema)],
    })
    command: AvatarModerationCommand,
    @Query({
      schema: avatarModerationEmptyQuerySchema,
      pipes: [new SchemaValidationPipe(avatarModerationEmptyQuerySchema)],
    })
    _query: Record<string, never>,
  ) {
    return this.moderation.command(bearerToken(auth), command);
  }
  @Get('requests/:requestId')
  @Header('Vary', 'Authorization')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ operationId: 'profileAvatarClearRecovery' })
  @ApiOkResponse({ standardSchema: avatarModerationRecoverySchema })
  recovery(
    @Headers('authorization') auth: unknown,
    @Param('requestId', {
      schema: avatarModerationRequestIdSchema,
      pipes: [new SchemaValidationPipe(avatarModerationRequestIdSchema)],
    })
    requestId: string,
    @Query({
      schema: avatarModerationEmptyQuerySchema,
      pipes: [new SchemaValidationPipe(avatarModerationEmptyQuerySchema)],
    })
    _query: Record<string, never>,
    @Body(new SchemaValidationPipe(avatarModerationEmptyBodySchema))
    _body: unknown,
  ) {
    return this.moderation.recovery(bearerToken(auth), requestId);
  }
  @Post('commands/cancel')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ operationId: 'profileAvatarClearCancel' })
  @ApiOkResponse({ standardSchema: avatarModerationReceiptSchema })
  cancel(
    @Headers('authorization') auth: unknown,
    @Body({
      schema: avatarModerationCommandSchema,
      pipes: [new SchemaValidationPipe(avatarModerationCommandSchema)],
    })
    command: AvatarModerationCommand,
    @Query({
      schema: avatarModerationEmptyQuerySchema,
      pipes: [new SchemaValidationPipe(avatarModerationEmptyQuerySchema)],
    })
    _query: Record<string, never>,
  ) {
    return this.moderation.command(bearerToken(auth), command, true);
  }
}
