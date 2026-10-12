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
import { SchemaValidationPipe } from '../../http/validation.js';
import {
  RatingResponses,
  ratingResponseHeaders,
} from '../../http/rating-http.js';
import { bearerToken } from '../../identity/tokens.js';
import { RatingRequestGuard } from '../../request-throttling/rating-request.guard.js';
import * as contracts from './contracts.js';
import type { FloorSetScore } from './contracts.js';
import { FloorRatingsService } from './service.js';
const emptyBody = z.union([z.undefined(), contracts.floorEmptySchema]);
@ApiTags('Floor ratings')
@ApiBearerAuth('accessToken')
@RatingResponses()
@UseGuards(RatingRequestGuard)
@Controller('v1/ratings/canteen-floors')
export class FloorRatingsController {
  constructor(
    @Inject(FloorRatingsService)
    private readonly floors: FloorRatingsService,
  ) {}
  @Get('catalog')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'floorRatingsCatalog',
    description:
      'Accepted active canteen/floor topology and independent canonical mapping; no fabricated aggregate or browsing authority.',
  })
  @ApiOkResponse({
    standardSchema: contracts.floorCatalogSchema,
    headers: ratingResponseHeaders,
    description: 'Bounded accepted topology, no score population inference.',
  })
  catalog(
    @Headers('authorization') auth: unknown,
    @Query(new SchemaValidationPipe(contracts.floorEmptySchema))
    _query: unknown,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    return this.floors.catalog(bearerToken(auth));
  }
  @Post('requests/:requestId/cancel')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'floorRatingCancel',
    description:
      'Durable original-key cancellation before a delayed score write; historical receipts survive withdrawal.',
  })
  @ApiOkResponse({
    standardSchema: contracts.floorReceiptSchema,
    headers: ratingResponseHeaders,
    description: 'Original terminal receipt or cancellation fence.',
  })
  cancel(
    @Headers('authorization') auth: unknown,
    @Param('requestId', new SchemaValidationPipe(contracts.floorIdSchema))
    id: string,
    @Query(new SchemaValidationPipe(contracts.floorEmptySchema))
    _query: unknown,
    @Body({
      schema: contracts.floorCancelSchema,
      pipes: [new SchemaValidationPipe(contracts.floorCancelSchema)],
    })
    body: contracts.FloorCancel,
  ) {
    return this.floors.cancel(bearerToken(auth), id, body);
  }
  @Get('requests/:requestId')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'floorRatingReceipt',
    description:
      'Actor-only immutable original receipt; current session required, independent of withdrawn source or later eligibility.',
  })
  @ApiOkResponse({
    standardSchema: contracts.floorReceiptSchema,
    headers: ratingResponseHeaders,
    description: 'Original typed floor command outcome.',
  })
  receipt(
    @Headers('authorization') auth: unknown,
    @Param('requestId', new SchemaValidationPipe(contracts.floorIdSchema))
    id: string,
    @Query(new SchemaValidationPipe(contracts.floorEmptySchema))
    _query: unknown,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    return this.floors.receipt(bearerToken(auth), id);
  }
  @Get(':id')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'floorRatingDetail',
    description:
      'Current accepted topology, private own active scalar score and independent exact floor mean/count in one proven read.',
  })
  @ApiOkResponse({
    standardSchema: contracts.floorDetailSchema,
    headers: ratingResponseHeaders,
    description: 'No score authors or identities exposed.',
  })
  detail(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(contracts.floorIdSchema)) id: string,
    @Query(new SchemaValidationPipe(contracts.floorEmptySchema))
    _query: unknown,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    return this.floors.detail(bearerToken(auth), id);
  }
  @Get(':id/my-score')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'floorRatingOwnScore',
    description:
      'Current actor only; unknown historical coverage is never not-submitted.',
  })
  @ApiOkResponse({
    standardSchema: contracts.floorOwnSchema,
    headers: ratingResponseHeaders,
    description: 'Private active floor score.',
  })
  own(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(contracts.floorIdSchema)) id: string,
    @Query(new SchemaValidationPipe(contracts.floorEmptySchema))
    _query: unknown,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    return this.floors.own(bearerToken(auth), id);
  }
  @Get(':id/summary')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'floorRatingSummary',
    description:
      'Exact current floor population mean using PostgreSQL numeric one-decimal rounding, over floor-only active records.',
  })
  @ApiOkResponse({
    standardSchema: contracts.floorSummarySchema,
    headers: ratingResponseHeaders,
    description:
      'Known-empty ratingCount is zero and mean null; unknown is separate from empty.',
  })
  summary(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(contracts.floorIdSchema)) id: string,
    @Query(new SchemaValidationPipe(contracts.floorEmptySchema))
    _query: unknown,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    return this.floors.summary(bearerToken(auth), id);
  }
  @Post(':id/first-score')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'floorRatingFirstScore',
    description:
      'First active scalar floor score, finite JSON number 1 through 5, preserving fractional values. Existing active score rejects another key. No edit/delete.',
  })
  @ApiOkResponse({
    standardSchema: contracts.floorReceiptSchema,
    headers: ratingResponseHeaders,
    description: 'Durable applied or serialized terminal rejection receipt.',
  })
  setScore(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(contracts.floorIdSchema)) id: string,
    @Query(new SchemaValidationPipe(contracts.floorEmptySchema))
    _query: unknown,
    @Body({
      schema: contracts.floorSetScoreSchema,
      pipes: [new SchemaValidationPipe(contracts.floorSetScoreSchema)],
    })
    command: FloorSetScore,
  ) {
    return this.floors.setScore(bearerToken(auth), id, command);
  }
}
