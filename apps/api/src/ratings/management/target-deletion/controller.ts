import {
  Body,
  Controller,
  Get,
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
import { SchemaValidationPipe } from '../../../http/validation.js';
import {
  RatingResponses,
  ratingResponseHeaders,
} from '../../../http/rating-http.js';
import { bearerToken } from '../../../identity/tokens.js';
import { RatingRequestGuard } from '../../../request-throttling/rating-request.guard.js';
import { ratingIdSchema, ratingEmptySchema } from '../../contracts.js';
import { RatingTargetOwnerDeletionService } from './service.js';
import * as contracts from './contracts.js';
const emptyBody = z.union([z.undefined(), ratingEmptySchema]);
@ApiTags('Ratings target owner deletion')
@ApiBearerAuth('accessToken')
@RatingResponses()
@UseGuards(RatingRequestGuard)
@Controller('v1/ratings/management/owner-deletion')
export class RatingTargetOwnerDeletionController {
  constructor(
    @Inject(RatingTargetOwnerDeletionService)
    private readonly service: RatingTargetOwnerDeletionService,
  ) {}
  @Get('targets/:targetId/context')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'ratingTargetOwnerDeletionContext',
    description:
      'Creator-only metadata for a known target locator. Does not expose hidden content or assert public visibility.',
  })
  @ApiOkResponse({
    standardSchema: contracts.ratingTargetOwnerDeletionContextSchema,
    headers: ratingResponseHeaders,
    description: 'Minimal owner deletion metadata',
  })
  context(
    @Headers('authorization') auth: unknown,
    @Param('targetId', new SchemaValidationPipe(ratingIdSchema)) id: string,
    @Query({
      schema: ratingEmptySchema,
      pipes: [new SchemaValidationPipe(ratingEmptySchema)],
    })
    _query: Record<string, never>,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    return this.service.context(bearerToken(auth), id);
  }
  @Post('targets/:targetId')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'deleteOwnRatingTarget',
    description:
      'Creator-only retained owner tombstone with exact lifecycle CAS. Preserves scores, discussions and captured history.',
  })
  @ApiOkResponse({
    standardSchema: contracts.ratingTargetOwnerDeletionReceiptSchema,
    headers: ratingResponseHeaders,
    description: 'Minimal applied, noop or rejected receipt',
  })
  delete(
    @Headers('authorization') auth: unknown,
    @Param('targetId', new SchemaValidationPipe(ratingIdSchema)) id: string,
    @Query({
      schema: ratingEmptySchema,
      pipes: [new SchemaValidationPipe(ratingEmptySchema)],
    })
    _query: Record<string, never>,
    @Body({
      schema: contracts.deleteRatingTargetSchema,
      pipes: [new SchemaValidationPipe(contracts.deleteRatingTargetSchema)],
    })
    command: contracts.DeleteRatingTarget,
  ) {
    return this.service.delete(bearerToken(auth), id, command);
  }
  @Post('cancel')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'cancelOwnRatingTargetDeletion',
    description:
      'Close the exact own original deletion intent. Any existing terminal receipt wins; cancellation is not target restoration.',
  })
  @ApiOkResponse({
    standardSchema: contracts.ratingTargetOwnerDeletionReceiptSchema,
    headers: ratingResponseHeaders,
    description: 'Durable historical receipt',
  })
  cancel(
    @Headers('authorization') auth: unknown,
    @Query({
      schema: ratingEmptySchema,
      pipes: [new SchemaValidationPipe(ratingEmptySchema)],
    })
    _query: Record<string, never>,
    @Body({
      schema: contracts.cancelRatingTargetDeletionSchema,
      pipes: [
        new SchemaValidationPipe(contracts.cancelRatingTargetDeletionSchema),
      ],
    })
    intent: contracts.RatingTargetDeletionIntent,
  ) {
    return this.service.cancel(bearerToken(auth), intent);
  }
  @Get('requests/:requestId')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'ratingTargetOwnerDeletionReceipt',
    description:
      'Recover an own historical deletion receipt independently of current target visibility or cleanup eligibility.',
  })
  @ApiOkResponse({
    standardSchema: contracts.ratingTargetOwnerDeletionReceiptSchema,
    headers: ratingResponseHeaders,
    description: 'Minimal actor-owned historical receipt',
  })
  receipt(
    @Headers('authorization') auth: unknown,
    @Param('requestId', new SchemaValidationPipe(ratingIdSchema)) id: string,
    @Query({
      schema: ratingEmptySchema,
      pipes: [new SchemaValidationPipe(ratingEmptySchema)],
    })
    _query: Record<string, never>,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    return this.service.receipt(bearerToken(auth), id);
  }
}
