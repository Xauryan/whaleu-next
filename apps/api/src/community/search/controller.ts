import { z } from 'zod';
import {
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { safeErrorResponseSchema } from '../../http/error-contracts.js';
import { searchPageSchema } from './response-schema.js';
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
import { searchQuerySchema, searchQueryParametersSchema } from './contracts.js';
import type { SearchPage, SearchQuery } from './contracts.js';
import { SearchService } from './service.js';

const headers = {
  'cache-control': {
    schema: { type: 'string' as const, enum: ['private, no-store'] },
  },
  vary: { schema: { type: 'string' as const, enum: ['Authorization'] } },
};
@ApiTags('Community content search')
@ApiResponse({
  status: 400,
  description:
    'Strict query, disjoint space/scope selector, date range, filter combination or cursor scope is invalid.',
  standardSchema: safeErrorResponseSchema,
  headers,
})
@ApiResponse({
  status: 401,
  description:
    'Explicit comments/replies and continuation require a current session; invalid supplied credentials never become guest access.',
  standardSchema: safeErrorResponseSchema,
  headers,
})
@ApiResponse({
  status: 403,
  description: 'Current phone continuation or Safety permission is denied.',
  standardSchema: safeErrorResponseSchema,
  headers,
})
@ApiResponse({
  status: 409,
  description:
    'Current scope or opaque navigation reference is unavailable; restart required after expiry, membership changes or inaccessible visible ancestry.',
  standardSchema: safeErrorResponseSchema,
  headers,
})
@ApiResponse({
  status: 503,
  description:
    'Required current source, approval, Safety or final proof is unknown. This is never an empty search.',
  standardSchema: safeErrorResponseSchema,
  headers,
})
@ApiResponse({
  status: 500,
  description: 'Unexpected failure is sanitized.',
  standardSchema: safeErrorResponseSchema,
  headers,
})
@Controller('v1/community')
export class SearchController {
  constructor(
    @Inject(SearchService) private readonly searches: SearchService,
  ) {}

  @Get('search')
  @Header('Cache-Control', 'private, no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'searchCommunityContent',
    security: [{}, { accessToken: [] }],
    description:
      'Literal Unicode lowercase substring search of posts, root comments and replies, newest first by exact microsecond time, kind and ID. No semantic or relevance ranking. Choose exactly one spaceId or scope; all/global forbid category/subtype, regional allows them. Global explicit spaces support discussion only. Type defaults to all; guest all has effectiveTypes=[post], explicit child types require login before scanning. from is inclusive and to exclusive, UTC with up to six fractional digits; range applies to each hit itself. postId narrows one discussion. Query-independent 128-source window and metadata-only sentinel; sparse pages may return scan_pending. Current authorized ancestry is proved before matching and again at transaction finalization. Continued traversal requires current session and phone evidence. Opaque cursors bind every filter, ordering, matcher, session and federated membership; they contain no body. Existing v1 route is upgraded without a parallel legacy engine.',
  })
  @ApiOkResponse({
    standardSchema: searchPageSchema,
    headers,
    description:
      'Lightweight actual-source hits, bounded original text segments and structured navigation. No PostView, counts, images, full body, target-author details, raw scores or total. Post-summary and snippets are freshly authorized.',
  })
  search(
    @Headers('authorization') auth: unknown,
    @Query({
      schema: searchQueryParametersSchema,
      pipes: [new SchemaValidationPipe(searchQuerySchema)],
    })
    query: SearchQuery,
    @Body(
      new SchemaValidationPipe(z.union([z.undefined(), z.strictObject({})])),
    )
    _body: unknown,
  ): Promise<SearchPage> {
    return this.searches.search(
      auth === undefined ? null : bearerToken(auth),
      query,
    );
  }
}
