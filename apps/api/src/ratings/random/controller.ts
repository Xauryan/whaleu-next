import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Inject,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { z } from 'zod';
import { SchemaValidationPipe } from '../../http/validation.js';
import {
  RatingResponses,
  ratingResponseHeaders,
} from '../../http/rating-http.js';
import { bearerToken } from '../../identity/tokens.js';
import { RatingRequestGuard } from '../../request-throttling/rating-request.guard.js';
import { ratingEmptySchema } from '../contracts.js';
import {
  ratingRandomQuerySchema,
  ratingRandomResponseSchema,
  type RatingRandomQuery,
} from './contracts.js';
import { RatingRandomService } from './service.js';
@ApiTags('Ratings')
@ApiBearerAuth('accessToken')
@RatingResponses()
@UseGuards(RatingRequestGuard)
@Controller('v1/ratings')
export class RatingRandomController {
  constructor(
    @Inject(RatingRandomService) private readonly ratings: RatingRandomService,
  ) {}
  @Get('random-target')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'ratingRandomTarget',
    description:
      'Uniform one-target selection from a proven complete, bounded candidate pool. Explicit native-campus institution scope plus global, or global only. Never samples a page.',
  })
  @ApiOkResponse({
    standardSchema: ratingRandomResponseSchema,
    headers: ratingResponseHeaders,
    description:
      'Complete eligible pool or explicit unavailable; no truncated sample.',
  })
  select(
    @Headers('authorization') auth: unknown,
    @Query({
      schema: ratingRandomQuerySchema,
      pipes: [new SchemaValidationPipe(ratingRandomQuerySchema)],
    })
    query: RatingRandomQuery,
    @Body(new SchemaValidationPipe(z.union([z.undefined(), ratingEmptySchema])))
    _body: unknown,
  ) {
    return this.ratings.select(bearerToken(auth), query);
  }
}
