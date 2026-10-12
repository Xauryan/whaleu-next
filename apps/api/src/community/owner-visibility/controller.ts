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
import { ApplicationError } from '../../http/application-error.js';
import { bearerToken } from '../../identity/tokens.js';
import { OwnerVisibilityService } from './service.js';
import {
  ownerVisibilityCommandSchema,
  ownerVisibilityEmptyBodySchema,
  ownerVisibilityEmptyQuerySchema,
  ownerVisibilityIdSchema,
  ownerVisibilityManagementSchema,
  ownerVisibilityReceiptSchema,
  ownerVisibilityRequestIdSchema,
} from './contracts.js';
import type { OwnerVisibilityCommand } from './contracts.js';

@ApiTags('Owner post visibility')
@ApiBearerAuth('accessToken')
@Controller('v1/me/community')
export class OwnerVisibilityController {
  constructor(
    @Inject(OwnerVisibilityService)
    private readonly visibility: OwnerVisibilityService,
  ) {}
  @Get('posts/:postId/owner-visibility')
  @Header('Vary', 'Authorization')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ operationId: 'ownerPostVisibilityManagement' })
  @ApiOkResponse({ standardSchema: ownerVisibilityManagementSchema })
  management(
    @Headers('authorization') auth: unknown,
    @Param('postId', new SchemaValidationPipe(ownerVisibilityIdSchema))
    postId: string,
    @Query(new SchemaValidationPipe(ownerVisibilityEmptyQuerySchema))
    _query: Record<string, never>,
    @Body(new SchemaValidationPipe(ownerVisibilityEmptyBodySchema))
    _body: unknown,
  ) {
    return this.visibility.management(bearerToken(auth), postId);
  }

  @Post('owner-visibility-commands')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ operationId: 'ownerPostVisibilityCommand' })
  @ApiOkResponse({ standardSchema: ownerVisibilityReceiptSchema })
  command(
    @Headers('authorization') auth: unknown,
    @Body({
      schema: ownerVisibilityCommandSchema,
      pipes: [new SchemaValidationPipe(ownerVisibilityCommandSchema)],
    })
    command: OwnerVisibilityCommand,
    @Query(new SchemaValidationPipe(ownerVisibilityEmptyQuerySchema))
    _query: Record<string, never>,
  ) {
    return this.visibility.command(bearerToken(auth), command);
  }

  @Get('owner-visibility-requests/:requestId')
  @Header('Vary', 'Authorization')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ operationId: 'ownerPostVisibilityReceipt' })
  @ApiOkResponse({ standardSchema: ownerVisibilityReceiptSchema })
  receipt(
    @Headers('authorization') auth: unknown,
    @Param(
      'requestId',
      new SchemaValidationPipe(ownerVisibilityRequestIdSchema),
    )
    requestId: string,
    @Query(new SchemaValidationPipe(ownerVisibilityEmptyQuerySchema))
    _query: Record<string, never>,
    @Body(new SchemaValidationPipe(ownerVisibilityEmptyBodySchema))
    _body: unknown,
  ) {
    return this.visibility.receipt(bearerToken(auth), requestId);
  }

  @Post('owner-visibility-requests/:requestId/cancel')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ operationId: 'ownerPostVisibilityCancel' })
  @ApiOkResponse({ standardSchema: ownerVisibilityReceiptSchema })
  cancel(
    @Headers('authorization') auth: unknown,
    @Param(
      'requestId',
      new SchemaValidationPipe(ownerVisibilityRequestIdSchema),
    )
    requestId: string,
    @Body({
      schema: ownerVisibilityCommandSchema,
      pipes: [new SchemaValidationPipe(ownerVisibilityCommandSchema)],
    })
    command: OwnerVisibilityCommand,
    @Query(new SchemaValidationPipe(ownerVisibilityEmptyQuerySchema))
    _query: Record<string, never>,
  ) {
    if (requestId !== command.clientRequestId)
      throw new ApplicationError('REQUEST_CONFLICT');
    return this.visibility.command(bearerToken(auth), command, true);
  }
}
