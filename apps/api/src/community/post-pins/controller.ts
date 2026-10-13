import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
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
import { SchemaValidationPipe } from '../../http/validation.js';
import { bearerToken } from '../../identity/tokens.js';
import {
  pinCommandSchema,
  pinDetailQuerySchema,
  pinSlotQuerySchema,
  pinSlotSchema,
  pinEmptySchema,
  pinQuerySchema,
  pinPageSchema,
  pinDetailSchema,
  pinReceiptSchema,
  pinIdSchema,
  pinRequestIdSchema,
  pinEmptyBodySchema,
} from './contracts.js';
import type { PinCommand, PinQuery } from './contracts.js';
import { PostPinsService } from './service.js';
import { ApplicationError } from '../../http/application-error.js';
@ApiTags('Scoped post pins')
@Controller('v1/community')
export class PostPinsController {
  constructor(
    @Inject(PostPinsService) private readonly pins: PostPinsService,
  ) {}
  @Get('post-pins')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'postPinPage' })
  @ApiOkResponse({ standardSchema: pinPageSchema })
  list(
    @Headers('authorization') auth: unknown,
    @Query({
      schema: pinQuerySchema,
      pipes: [new SchemaValidationPipe(pinQuerySchema)],
    })
    query: PinQuery,
    @Body(new SchemaValidationPipe(pinEmptyBodySchema)) _body: unknown,
  ) {
    return this.pins.list(auth === undefined ? null : bearerToken(auth), query);
  }
  @Get('post-pin-slot')
  @ApiBearerAuth('accessToken')
  @ApiOkResponse({ standardSchema: pinSlotSchema })
  slot(
    @Headers('authorization') auth: unknown,
    @Query({
      schema: pinSlotQuerySchema,
      pipes: [new SchemaValidationPipe(pinSlotQuerySchema)],
    })
    query: { spaceId: string },
    @Body(new SchemaValidationPipe(pinEmptyBodySchema)) _body: unknown,
  ) {
    return this.pins.slot(bearerToken(auth), query.spaceId);
  }
  @Get('posts/:postId/pin')
  @ApiBearerAuth('accessToken')
  @ApiOkResponse({ standardSchema: pinDetailSchema })
  detail(
    @Headers('authorization') auth: unknown,
    @Param('postId', new SchemaValidationPipe(pinIdSchema)) id: string,
    @Query({
      schema: pinDetailQuerySchema,
      pipes: [new SchemaValidationPipe(pinDetailQuerySchema)],
    })
    query: { viewSpaceId?: string },
    @Body(new SchemaValidationPipe(pinEmptyBodySchema)) _body: unknown,
  ) {
    return this.pins.detail(bearerToken(auth), id, query.viewSpaceId);
  }
  @Post('post-pin-commands')
  @ApiBearerAuth('accessToken')
  @ApiOkResponse({ standardSchema: pinReceiptSchema })
  @HttpCode(200)
  command(
    @Headers('authorization') auth: unknown,
    @Body({
      schema: pinCommandSchema,
      pipes: [new SchemaValidationPipe(pinCommandSchema)],
    })
    command: PinCommand,
    @Query(new SchemaValidationPipe(pinEmptySchema))
    _query: Record<string, never>,
  ) {
    return this.pins.command(bearerToken(auth), command);
  }
}
@ApiTags('Scoped post pin recovery')
@ApiBearerAuth('accessToken')
@Controller('v1/me/community/post-pin-requests')
export class PostPinRecoveryController {
  constructor(
    @Inject(PostPinsService) private readonly pins: PostPinsService,
  ) {}
  @Get(':requestId')
  @ApiOkResponse({ standardSchema: pinReceiptSchema })
  receipt(
    @Headers('authorization') auth: unknown,
    @Param('requestId', new SchemaValidationPipe(pinRequestIdSchema))
    id: string,
    @Query(new SchemaValidationPipe(pinEmptySchema))
    _query: Record<string, never>,
    @Body(new SchemaValidationPipe(pinEmptyBodySchema)) _body: unknown,
  ) {
    return this.pins.receipt(bearerToken(auth), id);
  }
  @Post(':requestId/cancel')
  @ApiOkResponse({ standardSchema: pinReceiptSchema })
  @HttpCode(200)
  cancel(
    @Headers('authorization') auth: unknown,
    @Param('requestId', new SchemaValidationPipe(pinRequestIdSchema))
    id: string,
    @Body({
      schema: pinCommandSchema,
      pipes: [new SchemaValidationPipe(pinCommandSchema)],
    })
    command: PinCommand,
    @Query(new SchemaValidationPipe(pinEmptySchema))
    _query: Record<string, never>,
  ) {
    if (id !== command.clientRequestId)
      throw new ApplicationError('REQUEST_CONFLICT');
    return this.pins.command(bearerToken(auth), command, true);
  }
}
