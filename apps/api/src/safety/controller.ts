import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Put,
  Query,
} from '@nestjs/common';
import { SchemaValidationPipe } from '../http/validation.js';
import { bearerToken } from '../identity/tokens.js';
import { idSchema, requestIdSchema } from '../community/contracts.js';
import {
  blockRequestSchema,
  emptyQuerySchema,
  ownBlocksQuerySchema,
  unblockRequestSchema,
} from './contracts.js';
import type {
  BlockRequest,
  OwnBlocksQuery,
  UnblockRequest,
} from './contracts.js';
import { NamedBlockService } from './service.js';
@Controller('v1/me/safety')
export class NamedBlockController {
  constructor(
    @Inject(NamedBlockService) private readonly blocks: NamedBlockService,
  ) {}
  @Put('blocks') block(
    @Headers('authorization') auth: unknown,
    @Query(new SchemaValidationPipe(emptyQuerySchema))
    _query: Record<string, never>,
    @Body(new SchemaValidationPipe(blockRequestSchema)) body: BlockRequest,
  ) {
    return this.blocks.block(bearerToken(auth), body);
  }
  @Put('blocks/:id') unblock(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(idSchema)) id: string,
    @Query(new SchemaValidationPipe(emptyQuerySchema))
    _query: Record<string, never>,
    @Body(new SchemaValidationPipe(unblockRequestSchema)) body: UnblockRequest,
  ) {
    return this.blocks.unblock(bearerToken(auth), id, body);
  }
  @Get('blocks') list(
    @Headers('authorization') auth: unknown,
    @Query(new SchemaValidationPipe(ownBlocksQuerySchema))
    query: OwnBlocksQuery,
  ) {
    return this.blocks.list(bearerToken(auth), query);
  }
  @Get('blocks/:id') status(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(idSchema)) id: string,
    @Query(new SchemaValidationPipe(emptyQuerySchema))
    _query: Record<string, never>,
  ) {
    return this.blocks.status(bearerToken(auth), id);
  }
  @Get('block-requests/:id') receipt(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(requestIdSchema)) id: string,
    @Query(new SchemaValidationPipe(emptyQuerySchema))
    _query: Record<string, never>,
  ) {
    return this.blocks.receipt(bearerToken(auth), id);
  }
}
