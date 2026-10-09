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
import { RatingTargetEditService } from './service.js';
import * as contracts from './contracts.js';
const emptyBody = z.union([z.undefined(), ratingEmptySchema]);
@ApiTags('Ratings creator text editing')
@ApiBearerAuth('accessToken')
@RatingResponses()
@UseGuards(RatingRequestGuard)
@Controller('v1/ratings/management/owner-edit')
export class RatingTargetEditController {
  constructor(
    @Inject(RatingTargetEditService)
    private readonly service: RatingTargetEditService,
  ) {}
  @Get('targets/:targetId/context')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'ratingTargetEditContext',
    description:
      'Read only current visible creator text under ordinary publication scope.',
  })
  @ApiOkResponse({
    standardSchema: contracts.ratingTargetEditContextSchema,
    headers: ratingResponseHeaders,
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
  @Get('requests/:requestId')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'ratingTargetEditReceipt',
    description:
      'Recover own historical edit outcome without displaying old target text.',
  })
  @ApiOkResponse({
    standardSchema: contracts.ratingTargetEditReceiptSchema,
    headers: ratingResponseHeaders,
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
  @Post('prepare')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'prepareOwnRatingTargetEdit',
    description:
      'Prepare an exact immutable edit intent; no content is approved or published.',
  })
  @ApiOkResponse({
    standardSchema: contracts.ratingTargetEditPrepareResultSchema,
    headers: ratingResponseHeaders,
  })
  prepare(
    @Headers('authorization') auth: unknown,
    @Query({
      schema: ratingEmptySchema,
      pipes: [new SchemaValidationPipe(ratingEmptySchema)],
    })
    _query: Record<string, never>,
    @Body({
      schema: contracts.prepareRatingTargetEditSchema,
      pipes: [
        new SchemaValidationPipe(contracts.prepareRatingTargetEditSchema),
      ],
    })
    command: contracts.PrepareRatingTargetEdit,
  ) {
    return this.service.prepare(bearerToken(auth), command);
  }
  @Post('commit')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'commitOwnRatingTargetEdit',
    description:
      'Publish an exact reviewed next definition with lifecycle and definition CAS, or record an exact noop.',
  })
  @ApiOkResponse({
    standardSchema: contracts.ratingTargetEditReceiptSchema,
    headers: ratingResponseHeaders,
  })
  commit(
    @Headers('authorization') auth: unknown,
    @Query({
      schema: ratingEmptySchema,
      pipes: [new SchemaValidationPipe(ratingEmptySchema)],
    })
    _query: Record<string, never>,
    @Body({
      schema: contracts.commitRatingTargetEditSchema,
      pipes: [new SchemaValidationPipe(contracts.commitRatingTargetEditSchema)],
    })
    command: contracts.CommitRatingTargetEdit,
  ) {
    return this.service.commit(bearerToken(auth), command);
  }
  @Post('cancel')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'cancelOwnRatingTargetEdit',
    description:
      'Close the original edit intent; any already committed result wins.',
  })
  @ApiOkResponse({
    standardSchema: contracts.ratingTargetEditReceiptSchema,
    headers: ratingResponseHeaders,
  })
  cancel(
    @Headers('authorization') auth: unknown,
    @Query({
      schema: ratingEmptySchema,
      pipes: [new SchemaValidationPipe(ratingEmptySchema)],
    })
    _query: Record<string, never>,
    @Body({
      schema: contracts.prepareRatingTargetEditSchema,
      pipes: [
        new SchemaValidationPipe(contracts.prepareRatingTargetEditSchema),
      ],
    })
    command: contracts.PrepareRatingTargetEdit,
  ) {
    return this.service.cancel(bearerToken(auth), command);
  }
}
