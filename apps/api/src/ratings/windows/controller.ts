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
import type { WindowQuery, WindowSetScore } from './contracts.js';
import { WindowRatingsService } from './service.js';
const emptyBody = z.union([z.undefined(), contracts.windowEmptySchema]);
@ApiTags('Window ratings')
@ApiBearerAuth('accessToken')
@RatingResponses()
@UseGuards(RatingRequestGuard)
@Controller('v1/ratings/windows')
export class WindowRatingsController {
  constructor(
    @Inject(WindowRatingsService)
    private readonly windows: WindowRatingsService,
  ) {}
  @Get('catalog')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'windowRatingsCatalog',
    description:
      'Accepted active canteen/floor topology and independent canonical mapping; no fabricated aggregate or browsing authority.',
  })
  @ApiOkResponse({
    standardSchema: contracts.windowCatalogSchema,
    headers: ratingResponseHeaders,
    description: 'Bounded accepted topology, no score population inference.',
  })
  catalog(
    @Headers('authorization') auth: unknown,
    @Query(new SchemaValidationPipe(contracts.windowEmptySchema))
    _query: unknown,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    return this.windows.catalog(bearerToken(auth));
  }
  @Post('requests/:requestId/cancel')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'windowRatingCancel',
    description:
      'Durable original-key cancellation before a delayed score write; historical receipts survive withdrawal.',
  })
  @ApiOkResponse({
    standardSchema: contracts.windowReceiptSchema,
    headers: ratingResponseHeaders,
    description: 'Original terminal receipt or cancellation fence.',
  })
  cancel(
    @Headers('authorization') auth: unknown,
    @Param('requestId', new SchemaValidationPipe(contracts.windowIdSchema))
    id: string,
    @Query(new SchemaValidationPipe(contracts.windowEmptySchema))
    _query: unknown,
    @Body({
      schema: contracts.windowCancelSchema,
      pipes: [new SchemaValidationPipe(contracts.windowCancelSchema)],
    })
    body: contracts.WindowCancel,
  ) {
    return this.windows.cancel(bearerToken(auth), id, body);
  }
  @Get()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'windowRatingsDirectory',
    description:
      'Source-accepted active parent/window directory; current session, phone and Safety. Canteen/floor filters, strictly positive minimum only; signed mean/count/ID ordering.',
  })
  @ApiOkResponse({
    standardSchema: contracts.windowPageSchema,
    headers: ratingResponseHeaders,
    description: 'Known complete catalog; unknown history is explicit.',
  })
  page(
    @Headers('authorization') auth: unknown,
    @Query({
      schema: contracts.windowQuerySchema,
      pipes: [new SchemaValidationPipe(contracts.windowQuerySchema)],
    })
    query: WindowQuery,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    return this.windows.page(bearerToken(auth), query);
  }
  @Get('requests/:requestId')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'windowRatingReceipt',
    description:
      'Actor-only immutable original receipt; current session required, independent of withdrawn source or later eligibility.',
  })
  @ApiOkResponse({
    standardSchema: contracts.windowReceiptSchema,
    headers: ratingResponseHeaders,
    description: 'Original typed window command outcome.',
  })
  receipt(
    @Headers('authorization') auth: unknown,
    @Param('requestId', new SchemaValidationPipe(contracts.windowIdSchema))
    id: string,
    @Query(new SchemaValidationPipe(contracts.windowEmptySchema))
    _query: unknown,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    return this.windows.receipt(bearerToken(auth), id);
  }
  @Get(':id')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'windowRatingDetail',
    description:
      'Current accepted topology, private own mutable signed score and independent exact window mean/count in one proven read.',
  })
  @ApiOkResponse({
    standardSchema: contracts.windowDetailSchema,
    headers: ratingResponseHeaders,
    description: 'No score authors or identities exposed.',
  })
  detail(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(contracts.windowIdSchema)) id: string,
    @Query(new SchemaValidationPipe(contracts.windowEmptySchema))
    _query: unknown,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    return this.windows.detail(bearerToken(auth), id);
  }
  @Get(':id/my-score')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'windowRatingOwnScore',
    description:
      'Current actor only; unknown historical coverage is never not-submitted.',
  })
  @ApiOkResponse({
    standardSchema: contracts.windowOwnSchema,
    headers: ratingResponseHeaders,
    description: 'Private current score and own CAS revision.',
  })
  own(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(contracts.windowIdSchema)) id: string,
    @Query(new SchemaValidationPipe(contracts.windowEmptySchema))
    _query: unknown,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    return this.windows.own(bearerToken(auth), id);
  }
  @Get(':id/summary')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'windowRatingSummary',
    description:
      'Exact current window population mean using PostgreSQL numeric one-decimal rounding, including negative half ties.',
  })
  @ApiOkResponse({
    standardSchema: contracts.windowSummarySchema,
    headers: ratingResponseHeaders,
    description:
      'Known-empty ratingCount is zero and mean null; recorded mean zero is distinct from empty or unknown.',
  })
  summary(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(contracts.windowIdSchema)) id: string,
    @Query(new SchemaValidationPipe(contracts.windowEmptySchema))
    _query: unknown,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    return this.windows.summary(bearerToken(auth), id);
  }
  @Post(':id/score')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'windowRatingSetScore',
    description:
      'Mutable integer score -10 through 10 including zero. Exact expected own revision CAS, explicit noop, immutable original-key recovery; no clear/delete.',
  })
  @ApiOkResponse({
    standardSchema: contracts.windowReceiptSchema,
    headers: ratingResponseHeaders,
    description: 'Durable applied or serialized terminal rejection receipt.',
  })
  setScore(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(contracts.windowIdSchema)) id: string,
    @Query(new SchemaValidationPipe(contracts.windowEmptySchema))
    _query: unknown,
    @Body({
      schema: contracts.windowSetScoreSchema,
      pipes: [new SchemaValidationPipe(contracts.windowSetScoreSchema)],
    })
    command: WindowSetScore,
  ) {
    return this.windows.setScore(bearerToken(auth), id, command);
  }
}
