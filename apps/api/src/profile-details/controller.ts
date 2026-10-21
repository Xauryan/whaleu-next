import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Patch,
  Query,
} from '@nestjs/common';
import { bearerToken } from '../identity/tokens.js';
import { SchemaValidationPipe } from '../http/validation.js';
import { idSchema } from '../community/contracts.js';
import { emptyQuerySchema } from '../profile-discovery/contracts.js';
import { profileDetailsPatchSchema } from './contracts.js';
import type { ProfileDetailsPatch } from './contracts.js';
import { ProfileDetailsService } from './service.js';
@Controller('v1')
export class ProfileDetailsController {
  constructor(
    @Inject(ProfileDetailsService)
    private readonly details: ProfileDetailsService,
  ) {}
  @Get('me/profile-details') own(
    @Headers('authorization') auth: unknown,
    @Query(new SchemaValidationPipe(emptyQuerySchema))
    _query: Record<string, never>,
  ) {
    return this.details.own(bearerToken(auth));
  }
  @Patch('me/profile-details') update(
    @Headers('authorization') auth: unknown,
    @Body(new SchemaValidationPipe(profileDetailsPatchSchema))
    body: ProfileDetailsPatch,
    @Query(new SchemaValidationPipe(emptyQuerySchema))
    _query: Record<string, never>,
  ) {
    return this.details.update(bearerToken(auth), body);
  }
  @Get('profiles/:profileId/details') public(
    @Headers('authorization') auth: unknown,
    @Param('profileId', new SchemaValidationPipe(idSchema)) profileId: string,
    @Query(new SchemaValidationPipe(emptyQuerySchema))
    _query: Record<string, never>,
  ) {
    return this.details.public(
      auth === undefined ? null : bearerToken(auth),
      profileId,
    );
  }
}
