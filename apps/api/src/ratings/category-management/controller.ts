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
import {
  ratingEmptySchema,
  ratingIdSchema,
  ratingScopeQuerySchema,
} from '../contracts.js';
import { RatingCategoryManagementService } from './service.js';
import * as contracts from './contracts.js';
@ApiTags('Ratings')
@ApiBearerAuth('accessToken')
@RatingResponses()
@UseGuards(RatingRequestGuard)
@Controller('v1/ratings/category-management')
export class RatingCategoryManagementController {
  constructor(
    @Inject(RatingCategoryManagementService)
    private readonly management: RatingCategoryManagementService,
  ) {}
  @Get('context')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'ratingCategoryManagementContext',
    description:
      'Current explicit management authority, exact canonical campus set and complete release dependencies. This is not a permission token.',
  })
  @ApiOkResponse({
    standardSchema: contracts.ratingCategoryManagementContextSchema,
    headers: ratingResponseHeaders,
    description: 'Exact current native category management context',
  })
  context(
    @Headers('authorization') auth: unknown,
    @Query({
      schema: ratingScopeQuerySchema,
      pipes: [new SchemaValidationPipe(ratingScopeQuerySchema)],
    })
    query: z.infer<typeof ratingScopeQuerySchema>,
    @Body(new SchemaValidationPipe(z.union([z.undefined(), ratingEmptySchema])))
    _body: unknown,
  ) {
    return this.management.context(bearerToken(auth), query.regionId ?? null);
  }
  @Post('prepare')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'prepareRatingCategories',
    description:
      'Reserve one exact native general-category tree and atomic release. It neither approves text nor publishes any category.',
  })
  @ApiOkResponse({
    standardSchema: contracts.ratingCategoryPrepareResultSchema,
    headers: ratingResponseHeaders,
    description:
      'Stable category tree preparation or durable explicit rejection',
  })
  prepare(
    @Headers('authorization') auth: unknown,
    @Query({
      schema: ratingEmptySchema,
      pipes: [new SchemaValidationPipe(ratingEmptySchema)],
    })
    _query: Record<string, never>,
    @Body({
      schema: contracts.prepareRatingCategoriesSchema,
      pipes: [
        new SchemaValidationPipe(contracts.prepareRatingCategoriesSchema),
      ],
    })
    intent: contracts.PrepareRatingCategories,
  ) {
    return this.management.prepare(bearerToken(auth), intent);
  }
  @Post('categories')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'createRatingCategories',
    description:
      'Publish an exactly reviewed category tree, immutable source lineage and all affected sealed catalogs atomically. Does not edit existing category definitions.',
  })
  @ApiOkResponse({
    standardSchema: contracts.ratingCategoryReceiptSchema,
    headers: ratingResponseHeaders,
    description: 'Minimal durable category release receipt',
  })
  create(
    @Headers('authorization') auth: unknown,
    @Query({
      schema: ratingEmptySchema,
      pipes: [new SchemaValidationPipe(ratingEmptySchema)],
    })
    _query: Record<string, never>,
    @Body({
      schema: contracts.commitRatingCategoriesSchema,
      pipes: [new SchemaValidationPipe(contracts.commitRatingCategoriesSchema)],
    })
    command: contracts.CommitRatingCategories,
  ) {
    return this.management.commit(bearerToken(auth), command);
  }
  @Post('cancel')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'cancelRatingCategoryCreation',
    description:
      'Close the exact original category creation request for its authenticated actor. A completed release wins and current management permission is not required for historical cleanup.',
  })
  @ApiOkResponse({
    standardSchema: contracts.ratingCategoryReceiptSchema,
    headers: ratingResponseHeaders,
    description: 'Durable original-intent outcome',
  })
  cancel(
    @Headers('authorization') auth: unknown,
    @Query({
      schema: ratingEmptySchema,
      pipes: [new SchemaValidationPipe(ratingEmptySchema)],
    })
    _query: Record<string, never>,
    @Body({
      schema: contracts.prepareRatingCategoriesSchema,
      pipes: [
        new SchemaValidationPipe(contracts.prepareRatingCategoriesSchema),
      ],
    })
    intent: contracts.PrepareRatingCategories,
  ) {
    return this.management.cancel(bearerToken(auth), intent);
  }
  @Get('requests/:requestId')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'ratingCategoryCreationReceipt',
    description:
      'Recover only this actor’s historical category release outcome, never current private category content.',
  })
  @ApiOkResponse({
    standardSchema: contracts.ratingCategoryReceiptSchema,
    headers: ratingResponseHeaders,
    description: 'Minimal durable category release receipt',
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
