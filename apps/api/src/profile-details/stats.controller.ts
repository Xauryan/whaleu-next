import { Controller, Get, Headers, Inject, Query } from '@nestjs/common';
import { bearerToken } from '../identity/tokens.js';
import { SchemaValidationPipe } from '../http/validation.js';
import { emptyQuerySchema } from '../profile-discovery/contracts.js';
import { ProfileStatsService } from './stats.service.js';
@Controller('v1/me')
export class ProfileStatsController {
  constructor(
    @Inject(ProfileStatsService) private readonly stats: ProfileStatsService,
  ) {}
  @Get('profile-stats') own(
    @Headers('authorization') auth: unknown,
    @Query(new SchemaValidationPipe(emptyQuerySchema))
    _query: Record<string, never>,
  ) {
    return this.stats.own(bearerToken(auth));
  }
}
