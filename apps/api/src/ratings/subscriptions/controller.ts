import {
  Body,
  Controller,
  Get,
  Put,
  Post,
  Header,
  Headers,
  HttpCode,
  Inject,
  Param,
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
import {
  ratingIdSchema,
  ratingEmptySchema,
  ratingScopeQuerySchema,
} from '../contracts.js';
import * as contracts from './contracts.js';
import { RatingSubscriptionsService } from './service.js';
const emptyBody = z.union([z.undefined(), ratingEmptySchema]);
@ApiTags('Ratings')
@ApiBearerAuth('accessToken')
@RatingResponses()
@UseGuards(RatingRequestGuard)
@Controller('v1/ratings')
export class RatingSubscriptionsController {
  constructor(
    @Inject(RatingSubscriptionsService)
    private readonly service: RatingSubscriptionsService,
  ) {}
  @Get('targets/:id/subscription')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'ratingTargetSubscription' })
  @ApiOkResponse({
    standardSchema: contracts.ratingSubscriptionStateSchema,
    headers: ratingResponseHeaders,
    description:
      'Current independent target membership and count, or unavailable coverage',
  })
  state(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(ratingIdSchema)) id: string,
    @Query({
      schema: ratingScopeQuerySchema,
      pipes: [new SchemaValidationPipe(ratingScopeQuerySchema)],
    })
    query: z.infer<typeof ratingScopeQuerySchema>,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    return this.service.state(bearerToken(auth), id, query.regionId ?? null);
  }
  @Put('targets/:id/subscription')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'ratingSetTargetSubscription' })
  @ApiOkResponse({
    standardSchema: contracts.ratingSubscriptionReceiptSchema,
    headers: ratingResponseHeaders,
    description: 'Minimal actor-owned desired-state subscription receipt',
  })
  set(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(ratingIdSchema)) id: string,
    @Query({
      schema: ratingEmptySchema,
      pipes: [new SchemaValidationPipe(ratingEmptySchema)],
    })
    query: z.infer<typeof ratingEmptySchema>,
    @Body({
      schema: contracts.setRatingSubscriptionSchema,
      pipes: [new SchemaValidationPipe(contracts.setRatingSubscriptionSchema)],
    })
    body: z.infer<typeof contracts.setRatingSubscriptionSchema>,
  ) {
    void query;
    return this.service.set(bearerToken(auth), id, body);
  }
  @Post('subscription-states/query')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'ratingSubscriptionStatesQuery' })
  @ApiOkResponse({
    standardSchema: contracts.ratingSubscriptionQueryResponseSchema,
    headers: ratingResponseHeaders,
    description:
      'Read-only single-scope current card states; one to twenty distinct targets',
  })
  query(
    @Headers('authorization') auth: unknown,
    @Query({
      schema: ratingEmptySchema,
      pipes: [new SchemaValidationPipe(ratingEmptySchema)],
    })
    query: z.infer<typeof ratingEmptySchema>,
    @Body({
      schema: contracts.ratingSubscriptionQuerySchema,
      pipes: [
        new SchemaValidationPipe(contracts.ratingSubscriptionQuerySchema),
      ],
    })
    body: z.infer<typeof contracts.ratingSubscriptionQuerySchema>,
  ) {
    void query;
    return this.service.query(bearerToken(auth), body);
  }
  @Get('subscription-requests/:id')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'ratingSubscriptionReceipt' })
  @ApiOkResponse({
    standardSchema: contracts.ratingSubscriptionReceiptSchema,
    headers: ratingResponseHeaders,
    description:
      'Actor-owned subscription receipt recovery; not current membership',
  })
  receipt(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(ratingIdSchema)) id: string,
    @Query({
      schema: ratingEmptySchema,
      pipes: [new SchemaValidationPipe(ratingEmptySchema)],
    })
    query: z.infer<typeof ratingEmptySchema>,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    void query;
    return this.service.receipt(bearerToken(auth), id);
  }
}
