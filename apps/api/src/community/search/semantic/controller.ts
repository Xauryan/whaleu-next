import { z } from 'zod';
import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  Inject,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { SchemaValidationPipe } from '../../../http/validation.js';
import { safeErrorResponseSchema } from '../../../http/error-contracts.js';
import { bearerToken } from '../../../identity/tokens.js';
import type { SearchQuery } from '../contracts.js';
import { SemanticSearchRuntime } from './runtime.js';
import { SemanticSearchRequestGuard } from './request-guard.js';
import {
  semanticSearchPageSchema,
  semanticSearchQuerySchema,
  semanticSearchQueryParametersSchema,
} from './http-contracts.js';
import type { SemanticSearchPage } from './http-contracts.js';

const headers = {
  'cache-control': {
    schema: { type: 'string' as const, enum: ['private, no-store'] },
  },
  vary: { schema: { type: 'string' as const, enum: ['Authorization'] } },
};
@ApiTags('Community semantic search')
@ApiResponse({
  status: 400,
  description:
    'Invalid filters or cursor; semantic search has no continuation cursor.',
  standardSchema: safeErrorResponseSchema,
  headers,
})
@ApiResponse({
  status: 401,
  description:
    'Invalid supplied credentials or explicit child search without a current session.',
  standardSchema: safeErrorResponseSchema,
  headers,
})
@ApiResponse({
  status: 429,
  description: 'Shared per-account or guest-address attempt budget exceeded.',
  standardSchema: safeErrorResponseSchema,
  headers,
})
@ApiResponse({
  status: 503,
  description:
    'SEMANTIC_SEARCH_DISABLED when not explicitly enabled. COMMUNITY_UNAVAILABLE for incomplete current index coverage, unknown authority, changed ranking snapshot or provider failure. Never an empty-result fallback.',
  standardSchema: safeErrorResponseSchema,
  headers,
})
@Controller('v1/community/search')
@UseGuards(SemanticSearchRequestGuard)
export class SemanticSearchController {
  constructor(
    @Inject(SemanticSearchRuntime)
    private readonly runtime: SemanticSearchRuntime,
  ) {}
  @Get('semantic')
  @Header('Cache-Control', 'private, no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'searchCommunityContentSemantically',
    security: [{}, { accessToken: [] }],
    description:
      'Full-scope current metadata authorization precedes exact 4096-dimensional retrieval. Top32 embedding candidates are reranked; returns at most10 fresh authorized hits. No pagination, totals, raw scores or silent literal fallback. Guests search posts only; explicit comment/reply requires login. Snippet highlights only actual literal matches and may contain all matched=false. Disabled by default; current index coverage and separately approved gateway configuration are required.',
  })
  @ApiOkResponse({ standardSchema: semanticSearchPageSchema, headers })
  search(
    @Headers('authorization') auth: unknown,
    @Query({
      schema: semanticSearchQueryParametersSchema,
      pipes: [new SchemaValidationPipe(semanticSearchQuerySchema)],
    })
    query: SearchQuery,
    @Body(
      new SchemaValidationPipe(z.union([z.undefined(), z.strictObject({})])),
    )
    _body: unknown,
  ): Promise<SemanticSearchPage> {
    return this.runtime.search(
      auth === undefined ? null : bearerToken(auth),
      query,
    );
  }
}
