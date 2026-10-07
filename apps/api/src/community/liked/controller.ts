import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  Inject,
  Query,
} from '@nestjs/common';
import { SchemaValidationPipe } from '../../http/validation.js';
import { bearerToken } from '../../identity/tokens.js';
import { emptyLikedBodySchema, likedPageQuerySchema } from './contracts.js';
import type { LikedPageQuery } from './contracts.js';
import { LikedHistoryService } from './service.js';

@Controller('v1/me/community')
export class LikedHistoryController {
  constructor(
    @Inject(LikedHistoryService) private readonly history: LikedHistoryService,
  ) {}
  @Get('liked')
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  list(
    @Headers('authorization') auth: unknown,
    @Query(new SchemaValidationPipe(likedPageQuerySchema))
    query: LikedPageQuery,
    @Body(new SchemaValidationPipe(emptyLikedBodySchema))
    _body: Record<string, never> | undefined,
  ) {
    return this.history.list(bearerToken(auth), query);
  }
}
