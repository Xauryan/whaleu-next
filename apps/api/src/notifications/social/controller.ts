import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Inject,
  Param,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { z } from 'zod';
import { SchemaValidationPipe } from '../../http/validation.js';
import { bearerToken } from '../../identity/tokens.js';
import * as contracts from './contracts.js';
import type { SocialCategory, SocialUpdatesQuery } from './contracts.js';
import { SocialUpdatesReadService } from './read.service.js';
const getBody = z.union([z.undefined(), contracts.socialEmptySchema]);
@ApiTags('Social updates')
@ApiBearerAuth('accessToken')
@Controller('v1/me/social-updates')
export class SocialUpdatesController {
  constructor(
    @Inject(SocialUpdatesReadService)
    private readonly social: SocialUpdatesReadService,
  ) {}
  @Get()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'socialUpdates',
    description:
      'Owned current local social notices. Category is required; list never marks read. Unknown exact current-readable unread coverage is null.',
  })
  @ApiOkResponse({
    standardSchema: contracts.socialUpdatesPageSchema,
    description: 'Strict category page',
  })
  list(
    @Headers('authorization') auth: unknown,
    @Query({
      schema: contracts.socialUpdatesQuerySchema,
      pipes: [new SchemaValidationPipe(contracts.socialUpdatesQuerySchema)],
    })
    query: SocialUpdatesQuery,
    @Body(new SchemaValidationPipe(getBody)) _body: unknown,
  ) {
    return this.social.list(bearerToken(auth), query);
  }
  @Get('unread-count')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'socialUpdatesUnreadCount',
    description:
      'Exact currently readable category count when bounded complete source coverage can be proved; otherwise unavailable/null.',
  })
  @ApiOkResponse({
    standardSchema: contracts.socialUnreadSchema,
    description: 'Exact count or unknown',
  })
  count(
    @Headers('authorization') auth: unknown,
    @Query({
      schema: contracts.socialCategoryQuerySchema,
      pipes: [new SchemaValidationPipe(contracts.socialCategoryQuerySchema)],
    })
    query: { category: SocialCategory },
    @Body(new SchemaValidationPipe(getBody)) _body: unknown,
  ) {
    return this.social.unreadCount(bearerToken(auth), query.category);
  }
  @Get(':noticeId/target')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'socialNoticeTarget',
    description:
      'Reauthorizes an exact owned/category notice locator, never marks it read.',
  })
  @ApiOkResponse({
    standardSchema: contracts.socialNoticeTargetSchema,
    description: 'Current authorized target or generic unavailable',
  })
  target(
    @Headers('authorization') auth: unknown,
    @Param('noticeId', new SchemaValidationPipe(contracts.socialIdSchema))
    id: string,
    @Query({
      schema: contracts.socialCategoryQuerySchema,
      pipes: [new SchemaValidationPipe(contracts.socialCategoryQuerySchema)],
    })
    query: { category: SocialCategory },
    @Body(new SchemaValidationPipe(getBody)) _body: unknown,
  ) {
    return this.social.target(bearerToken(auth), id, query.category);
  }
  @Put(':noticeId/read')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'socialNoticeRead',
    description:
      'Acknowledges one owned/category notice, even if unavailable; retries retain the first exact timestamp.',
  })
  @ApiOkResponse({
    standardSchema: contracts.socialNoticeReadSchema,
    description: 'Immutable first read timestamp and current count',
  })
  read(
    @Headers('authorization') auth: unknown,
    @Param('noticeId', new SchemaValidationPipe(contracts.socialIdSchema))
    id: string,
    @Query({
      schema: contracts.socialCategoryQuerySchema,
      pipes: [new SchemaValidationPipe(contracts.socialCategoryQuerySchema)],
    })
    query: { category: SocialCategory },
    @Body({
      schema: contracts.socialEmptySchema,
      pipes: [new SchemaValidationPipe(contracts.socialEmptySchema)],
    })
    _body: Record<string, never>,
  ) {
    return this.social.markRead(bearerToken(auth), id, query.category);
  }
}
