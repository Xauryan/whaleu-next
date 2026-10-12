import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
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
import { SchemaValidationPipe } from '../../../http/validation.js';
import {
  RatingResponses,
  ratingResponseHeaders,
} from '../../../http/rating-http.js';
import { bearerToken } from '../../../identity/tokens.js';
import { RatingRequestGuard } from '../../../request-throttling/rating-request.guard.js';
import { windowIdSchema, windowEmptySchema } from '../contracts.js';
import * as contracts from './contracts.js';
import { DishRecommendationsService } from './service.js';
const emptyBody = z.union([z.undefined(), windowEmptySchema]);
@ApiTags('Window dish recommendations')
@ApiBearerAuth('accessToken')
@RatingResponses()
@UseGuards(RatingRequestGuard)
@Controller('v1/ratings/windows')
export class DishRecommendationsController {
  constructor(
    @Inject(DishRecommendationsService)
    private readonly dishes: DishRecommendationsService,
  ) {}
  @Get('dish-requests/:requestId')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'windowDishReceipt',
    description:
      'Historical actor-owned original result; does not restore current membership.',
  })
  @ApiOkResponse({
    standardSchema: contracts.dishReceiptSchema,
    headers: ratingResponseHeaders,
    description: 'Typed bounded dish recommendation result.',
  })
  receipt(
    @Headers('authorization') auth: unknown,
    @Param('requestId', new SchemaValidationPipe(windowIdSchema)) id: string,
    @Query(new SchemaValidationPipe(windowEmptySchema)) _query: unknown,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    return this.dishes.receipt(bearerToken(auth), id);
  }
  @Post('dish-requests/:requestId/cancel')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'windowDishCancel',
    description:
      'Durable same-key cancellation survives source and eligibility loss.',
  })
  @ApiOkResponse({
    standardSchema: contracts.dishReceiptSchema,
    headers: ratingResponseHeaders,
    description: 'Typed bounded dish recommendation result.',
  })
  cancel(
    @Headers('authorization') auth: unknown,
    @Param('requestId', new SchemaValidationPipe(windowIdSchema)) id: string,
    @Query(new SchemaValidationPipe(windowEmptySchema)) _query: unknown,
    @Body({
      schema: contracts.dishCancelSchema,
      pipes: [new SchemaValidationPipe(contracts.dishCancelSchema)],
    })
    body: contracts.DishCancel,
  ) {
    return this.dishes.cancel(bearerToken(auth), id, body);
  }
  @Get(':id/dishes')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'windowDishPage',
    description:
      'Exact visible endorsement count and private own state; count descending and UTF8 byte identity ascending; independent history required.',
  })
  @ApiOkResponse({
    standardSchema: contracts.dishPageSchema,
    headers: ratingResponseHeaders,
    description: 'Typed bounded dish recommendation result.',
  })
  page(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(windowIdSchema)) id: string,
    @Query({
      schema: contracts.dishQuerySchema,
      pipes: [new SchemaValidationPipe(contracts.dishQuerySchema)],
    })
    query: contracts.DishQuery,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    return this.dishes.page(bearerToken(auth), id, query);
  }
  @Get(':id/dishes/my-membership')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'windowDishOwn',
    description:
      'Actor-session-only current membership and historical source revisions for owner closure. Absence is not known unless separate history proves it.',
  })
  @ApiOkResponse({
    standardSchema: contracts.dishOwnSchema,
    headers: ratingResponseHeaders,
    description: 'Typed bounded dish recommendation result.',
  })
  own(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(windowIdSchema)) id: string,
    @Query({
      schema: contracts.dishOwnQuerySchema,
      pipes: [new SchemaValidationPipe(contracts.dishOwnQuerySchema)],
    })
    query: { dishName: string },
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    return this.dishes.own(bearerToken(auth), id, query.dishName);
  }
  @Post(':id/dishes/recommend')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'windowDishRecommend',
    description:
      'Exact name codepoint limit, new Review, current accepted topology, phone and Safety. CAS before active duplicate rejection.',
  })
  @ApiOkResponse({
    standardSchema: contracts.dishReceiptSchema,
    headers: ratingResponseHeaders,
    description: 'Typed bounded dish recommendation result.',
  })
  recommend(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(windowIdSchema)) id: string,
    @Query(new SchemaValidationPipe(windowEmptySchema)) _query: unknown,
    @Body({
      schema: contracts.dishCommandSchema,
      pipes: [new SchemaValidationPipe(contracts.dishCommandSchema)],
    })
    body: contracts.DishCommand,
  ) {
    return this.dishes.recommend(bearerToken(auth), id, body);
  }
  @Post(':id/dishes/retract')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'windowDishRetract',
    description:
      'Actor-only CAS closure preserves inactive lineage without current positive publication Review, source or eligibility. No add authority granted.',
  })
  @ApiOkResponse({
    standardSchema: contracts.dishReceiptSchema,
    headers: ratingResponseHeaders,
    description: 'Typed bounded dish recommendation result.',
  })
  retract(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(windowIdSchema)) id: string,
    @Query(new SchemaValidationPipe(windowEmptySchema)) _query: unknown,
    @Body({
      schema: contracts.dishCommandSchema,
      pipes: [new SchemaValidationPipe(contracts.dishCommandSchema)],
    })
    body: contracts.DishCommand,
  ) {
    return this.dishes.retract(bearerToken(auth), id, body);
  }
}
