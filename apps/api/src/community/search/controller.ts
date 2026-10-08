import { Controller, Get, Headers, Inject, Query } from '@nestjs/common';
import { SchemaValidationPipe } from '../../http/validation.js';
import { bearerToken } from '../../identity/tokens.js';
import { searchQuerySchema } from './contracts.js';
import type { SearchPage, SearchQuery } from './contracts.js';
import { SearchService } from './service.js';

@Controller('v1/community')
export class SearchController {
  constructor(
    @Inject(SearchService) private readonly searches: SearchService,
  ) {}

  @Get('search')
  search(
    @Headers('authorization') auth: unknown,
    @Query(new SchemaValidationPipe(searchQuerySchema)) query: SearchQuery,
  ): Promise<SearchPage> {
    return this.searches.search(
      auth === undefined ? null : bearerToken(auth),
      query,
    );
  }
}
