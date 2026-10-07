import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  Inject,
  Param,
  Query,
} from '@nestjs/common';
import { SchemaValidationPipe } from '../http/validation.js';
import { bearerToken } from '../identity/tokens.js';
import {
  emptyBodySchema,
  emptyQuerySchema,
  profileIdSchema,
  profilePostsQuerySchema,
  profileTradingQuerySchema,
} from './contracts.js';
import type { ProfileContentQuery } from './contracts.js';
import { ProfileDiscoveryService } from './service.js';

@Controller('v1/profiles')
export class PublicProfileController {
  constructor(
    @Inject(ProfileDiscoveryService)
    private readonly profiles: ProfileDiscoveryService,
  ) {}

  @Get(':profileId')
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  profile(
    @Headers('authorization') auth: unknown,
    @Param('profileId', new SchemaValidationPipe(profileIdSchema)) id: string,
    @Query(new SchemaValidationPipe(emptyQuerySchema))
    _query: Record<string, never>,
    @Body(new SchemaValidationPipe(emptyBodySchema))
    _body: Record<string, never>,
  ) {
    return this.profiles.profile(
      auth === undefined ? null : bearerToken(auth),
      id,
    );
  }

  @Get(':profileId/posts')
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  posts(
    @Headers('authorization') auth: unknown,
    @Param('profileId', new SchemaValidationPipe(profileIdSchema)) id: string,
    @Query(new SchemaValidationPipe(profilePostsQuerySchema))
    query: ProfileContentQuery,
    @Body(new SchemaValidationPipe(emptyBodySchema))
    _body: Record<string, never>,
  ) {
    return this.profiles.list(
      auth === undefined ? null : bearerToken(auth),
      id,
      'posts',
      query,
    );
  }

  @Get(':profileId/trading')
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  trading(
    @Headers('authorization') auth: unknown,
    @Param('profileId', new SchemaValidationPipe(profileIdSchema)) id: string,
    @Query(new SchemaValidationPipe(profileTradingQuerySchema))
    query: ProfileContentQuery,
    @Body(new SchemaValidationPipe(emptyBodySchema))
    _body: Record<string, never>,
  ) {
    return this.profiles.list(
      auth === undefined ? null : bearerToken(auth),
      id,
      'trading',
      query,
    );
  }
}

@Controller('v1/me')
export class OwnPublicProfileController {
  constructor(
    @Inject(ProfileDiscoveryService)
    private readonly profiles: ProfileDiscoveryService,
  ) {}

  @Get('public-profile-ref')
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  reference(
    @Headers('authorization') auth: unknown,
    @Query(new SchemaValidationPipe(emptyQuerySchema))
    _query: Record<string, never>,
    @Body(new SchemaValidationPipe(emptyBodySchema))
    _body: Record<string, never>,
  ) {
    return this.profiles.ownReference(bearerToken(auth));
  }
}
