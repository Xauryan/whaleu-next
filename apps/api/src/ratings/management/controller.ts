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
import { SchemaValidationPipe } from '../../http/validation.js';
import {
  RatingResponses,
  ratingResponseHeaders,
} from '../../http/rating-http.js';
import { bearerToken } from '../../identity/tokens.js';
import { RatingRequestGuard } from '../../request-throttling/rating-request.guard.js';
import { ratingEmptySchema, ratingIdSchema } from '../contracts.js';
import { RatingManagementService } from './service.js';
import * as contracts from './contracts.js';
@ApiTags('Ratings')
@ApiBearerAuth('accessToken')
@RatingResponses()
@UseGuards(RatingRequestGuard)
@Controller('v1/ratings/management')
export class RatingManagementController {
  constructor(
    @Inject(RatingManagementService)
    private readonly management: RatingManagementService,
  ) {}
  @Post('prepare')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'prepareRatingTarget',
    description:
      'Reserve an exact native target creation intent. Does not approve or publish content.',
  })
  @ApiOkResponse({
    standardSchema: contracts.ratingTargetPreparationSchema,
    headers: ratingResponseHeaders,
    description: 'Stable creation preparation',
  })
  prepare(
    @Headers('authorization') auth: unknown,
    @Query({
      schema: ratingEmptySchema,
      pipes: [new SchemaValidationPipe(ratingEmptySchema)],
    })
    _query: Record<string, never>,
    @Body({
      schema: contracts.prepareRatingTargetSchema,
      pipes: [new SchemaValidationPipe(contracts.prepareRatingTargetSchema)],
    })
    command: contracts.PrepareRatingTarget,
  ) {
    return this.management.prepare(bearerToken(auth), command);
  }
  @Post('cancel')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'cancelRatingTargetCreation',
    description:
      'Close an own pending creation under its exact original key. Existing applied receipt wins.',
  })
  @ApiOkResponse({
    standardSchema: contracts.ratingTargetCreationReceiptSchema,
    headers: ratingResponseHeaders,
    description: 'Durable applied or cancelled receipt',
  })
  cancel(
    @Headers('authorization') auth: unknown,
    @Query({
      schema: ratingEmptySchema,
      pipes: [new SchemaValidationPipe(ratingEmptySchema)],
    })
    _query: Record<string, never>,
    @Body({
      schema: contracts.prepareRatingTargetSchema,
      pipes: [new SchemaValidationPipe(contracts.prepareRatingTargetSchema)],
    })
    command: contracts.PrepareRatingTarget,
  ) {
    return this.management.cancel(bearerToken(auth), command);
  }
  @Post('targets')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'createRatingTarget',
    description:
      'Create a reviewed native generic target with an immutable catalog transition and independent fresh-zero source.',
  })
  @ApiOkResponse({
    standardSchema: contracts.ratingTargetCreationReceiptSchema,
    headers: ratingResponseHeaders,
    description: 'Minimal creation receipt',
  })
  create(
    @Headers('authorization') auth: unknown,
    @Query({
      schema: ratingEmptySchema,
      pipes: [new SchemaValidationPipe(ratingEmptySchema)],
    })
    _query: Record<string, never>,
    @Body({
      schema: contracts.createRatingTargetSchema,
      pipes: [new SchemaValidationPipe(contracts.createRatingTargetSchema)],
    })
    command: contracts.CreateRatingTarget,
  ) {
    return this.management.create(bearerToken(auth), command);
  }
  @Get('requests/:requestId')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'ratingTargetCreationReceipt',
    description:
      'Recover historical own creation outcome, not current target content.',
  })
  @ApiOkResponse({
    standardSchema: contracts.ratingTargetCreationReceiptSchema,
    headers: ratingResponseHeaders,
    description: 'Minimal creation receipt',
  })
  receipt(
    @Headers('authorization') auth: unknown,
    @Param('requestId', new SchemaValidationPipe(ratingIdSchema)) id: string,
    @Query({
      schema: ratingEmptySchema,
      pipes: [new SchemaValidationPipe(ratingEmptySchema)],
    })
    _query: Record<string, never>,
    @Body(new SchemaValidationPipe(z.union([z.undefined(), ratingEmptySchema])))
    _body: unknown,
  ) {
    return this.management.receipt(bearerToken(auth), id);
  }
}
