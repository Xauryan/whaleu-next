import { ApiBearerAuth, ApiOkResponse, ApiQuery } from '@nestjs/swagger';
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
import {
  emptyPublicationBodySchema,
  publicationPageQuerySchema,
  publicationPageSchema,
} from './contracts.js';
import type { PublicationPageQuery } from './contracts.js';
import { PublicationHistoryService } from './service.js';

@ApiBearerAuth('accessToken')
@Controller('v1/me/community')
export class PublicationHistoryController {
  constructor(
    @Inject(PublicationHistoryService)
    private readonly history: PublicationHistoryService,
  ) {}
  @Get('publications')
  @ApiOkResponse({ standardSchema: publicationPageSchema })
  @ApiQuery({ name: 'kind', enum: ['topic', 'reply'], required: true })
  @ApiQuery({ name: 'identity', enum: ['named', 'anonymous'], required: true })
  @ApiQuery({ name: 'limit', required: false, type: String })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  list(
    @Headers('authorization') auth: unknown,
    @Query(new SchemaValidationPipe(publicationPageQuerySchema))
    query: PublicationPageQuery,
    @Body(new SchemaValidationPipe(emptyPublicationBodySchema))
    _body: Record<string, never> | undefined,
  ) {
    return this.history.list(bearerToken(auth), query);
  }
}
