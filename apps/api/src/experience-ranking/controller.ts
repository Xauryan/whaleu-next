import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  Inject,
  Query,
} from '@nestjs/common';
import { SchemaValidationPipe } from '../http/validation.js';
import { bearerToken } from '../identity/tokens.js';
import { emptyBodySchema, rankingQuerySchema } from './contracts.js';
import type { RankingQuery } from './contracts.js';
import { ExperienceRankingService } from './service.js';
@Controller('v1/experience/ranking')
export class ExperienceRankingController {
  constructor(
    @Inject(ExperienceRankingService)
    private readonly rankings: ExperienceRankingService,
  ) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  ranking(
    @Headers('authorization') auth: unknown,
    @Query(new SchemaValidationPipe(rankingQuerySchema)) query: RankingQuery,
    @Body(new SchemaValidationPipe(emptyBodySchema))
    _body: Record<string, never>,
  ) {
    return this.rankings.ranking(
      auth === undefined ? null : bearerToken(auth),
      query,
    );
  }
}
