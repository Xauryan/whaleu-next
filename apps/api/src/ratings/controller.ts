import {
  Body,
  Controller,
  Get,
  Put,
  Post,
  Delete,
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
import { SchemaValidationPipe } from '../http/validation.js';
import { RatingResponses, ratingResponseHeaders } from '../http/rating-http.js';
import { bearerToken } from '../identity/tokens.js';
import { RatingRequestGuard } from '../request-throttling/rating-request.guard.js';
import { RatingsService } from './service.js';
import * as contracts from './contracts.js';
import type {
  RatingCategoryQuery,
  RatingTargetQuery,
  RatingCommentQuery,
  SetRatingScore,
  CreateRatingComment,
  DeleteRatingComment,
} from './contracts.js';
import { z } from 'zod';
const emptyBody = z.union([z.undefined(), contracts.ratingEmptySchema]);
@ApiTags('Ratings')
@ApiBearerAuth('accessToken')
@RatingResponses()
@UseGuards(RatingRequestGuard)
@Controller('v1/ratings')
export class RatingsController {
  constructor(
    @Inject(RatingsService) private readonly ratings: RatingsService,
  ) {}
  @Get('context')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'ratingContext',
    description:
      'Strict current-authorized R1 contract. Independent score and text; unknown authority fails closed.',
  })
  @ApiOkResponse({
    standardSchema: contracts.ratingContextSchema,
    headers: ratingResponseHeaders,
    description: 'Strict ratings contract',
  })
  context(
    @Headers('authorization') auth: unknown,
    @Query({
      schema: contracts.ratingEmptySchema,
      pipes: [new SchemaValidationPipe(contracts.ratingEmptySchema)],
    })
    query: Record<string, never>,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    void query;
    return this.ratings.context(bearerToken(auth));
  }
  @Get('categories')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'ratingCategories',
    description:
      'Strict current-authorized R1 contract. Independent score and text; unknown authority fails closed.',
  })
  @ApiOkResponse({
    standardSchema: contracts.ratingCategoryPageSchema,
    headers: ratingResponseHeaders,
    description: 'Strict ratings contract',
  })
  categories(
    @Headers('authorization') auth: unknown,
    @Query({
      schema: contracts.ratingCategoryQuerySchema,
      pipes: [new SchemaValidationPipe(contracts.ratingCategoryQuerySchema)],
    })
    query: RatingCategoryQuery,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    void query;
    return this.ratings.categories(bearerToken(auth), query);
  }
  @Get('targets')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'ratingTargets',
    description:
      'Strict current-authorized R1 contract. Independent score and text; unknown authority fails closed.',
  })
  @ApiOkResponse({
    standardSchema: contracts.ratingTargetPageSchema,
    headers: ratingResponseHeaders,
    description: 'Strict ratings contract',
  })
  targets(
    @Headers('authorization') auth: unknown,
    @Query({
      schema: contracts.ratingTargetQuerySchema,
      pipes: [new SchemaValidationPipe(contracts.ratingTargetQuerySchema)],
    })
    query: RatingTargetQuery,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    void query;
    return this.ratings.targets(bearerToken(auth), query);
  }
  @Get('targets/:id')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'ratingTarget',
    description:
      'Strict current-authorized R1 contract. Independent score and text; unknown authority fails closed.',
  })
  @ApiOkResponse({
    standardSchema: contracts.ratingTargetSchema,
    headers: ratingResponseHeaders,
    description: 'Strict ratings contract',
  })
  target(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(contracts.ratingIdSchema)) id: string,
    @Query({
      schema: contracts.ratingScopeQuerySchema,
      pipes: [new SchemaValidationPipe(contracts.ratingScopeQuerySchema)],
    })
    query: { regionId?: string },
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    void query;
    return this.ratings.target(bearerToken(auth), id, query.regionId ?? null);
  }
  @Get('targets/:id/my-score')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'ratingMyScore',
    description:
      'Strict current-authorized R1 contract. Independent score and text; unknown authority fails closed.',
  })
  @ApiOkResponse({
    standardSchema: contracts.ratingMyScoreSchema,
    headers: ratingResponseHeaders,
    description: 'Strict ratings contract',
  })
  myScore(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(contracts.ratingIdSchema)) id: string,
    @Query({
      schema: contracts.ratingScopeQuerySchema,
      pipes: [new SchemaValidationPipe(contracts.ratingScopeQuerySchema)],
    })
    query: { regionId?: string },
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    void query;
    return this.ratings.myScore(bearerToken(auth), id, query.regionId ?? null);
  }
  @Get('targets/:id/score-summary')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'ratingSummary',
    description:
      'Strict current-authorized R1 contract. Independent score and text; unknown authority fails closed.',
  })
  @ApiOkResponse({
    standardSchema: contracts.ratingSummarySchema,
    headers: ratingResponseHeaders,
    description: 'Strict ratings contract',
  })
  summary(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(contracts.ratingIdSchema)) id: string,
    @Query({
      schema: contracts.ratingScopeQuerySchema,
      pipes: [new SchemaValidationPipe(contracts.ratingScopeQuerySchema)],
    })
    query: { regionId?: string },
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    void query;
    return this.ratings.summary(bearerToken(auth), id, query.regionId ?? null);
  }
  @Get('targets/:id/comments')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'ratingComments',
    description:
      'Strict current-authorized R1 contract. Independent score and text; unknown authority fails closed.',
  })
  @ApiOkResponse({
    standardSchema: contracts.ratingCommentPageSchema,
    headers: ratingResponseHeaders,
    description: 'Strict ratings contract',
  })
  comments(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(contracts.ratingIdSchema)) id: string,
    @Query({
      schema: contracts.ratingCommentQuerySchema,
      pipes: [new SchemaValidationPipe(contracts.ratingCommentQuerySchema)],
    })
    query: RatingCommentQuery,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    void query;
    return this.ratings.comments(bearerToken(auth), id, query);
  }
  @Get('comments/:id')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'ratingComment',
    description:
      'Strict current-authorized R1 contract. Independent score and text; unknown authority fails closed.',
  })
  @ApiOkResponse({
    standardSchema: contracts.ratingCommentSchema,
    headers: ratingResponseHeaders,
    description: 'Strict ratings contract',
  })
  comment(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(contracts.ratingIdSchema)) id: string,
    @Query({
      schema: contracts.ratingScopeQuerySchema,
      pipes: [new SchemaValidationPipe(contracts.ratingScopeQuerySchema)],
    })
    query: { regionId?: string },
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    void query;
    return this.ratings.comment(bearerToken(auth), id, query.regionId ?? null);
  }
  @Get('requests/:id')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'ratingReceipt',
    description:
      'Strict current-authorized R1 contract. Independent score and text; unknown authority fails closed.',
  })
  @ApiOkResponse({
    standardSchema: contracts.ratingReceiptSchema,
    headers: ratingResponseHeaders,
    description: 'Strict ratings contract',
  })
  receipt(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(contracts.ratingIdSchema)) id: string,
    @Query({
      schema: contracts.ratingEmptySchema,
      pipes: [new SchemaValidationPipe(contracts.ratingEmptySchema)],
    })
    query: Record<string, never>,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    void query;
    return this.ratings.receipt(bearerToken(auth), id);
  }
  @Put('targets/:id/my-score')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'ratingSetScore',
    description:
      'Strict current-authorized R1 contract. Independent score and text; unknown authority fails closed.',
  })
  @ApiOkResponse({
    standardSchema: contracts.ratingReceiptSchema,
    headers: ratingResponseHeaders,
    description: 'Strict ratings contract',
  })
  setScore(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(contracts.ratingIdSchema)) id: string,
    @Query({
      schema: contracts.ratingEmptySchema,
      pipes: [new SchemaValidationPipe(contracts.ratingEmptySchema)],
    })
    query: Record<string, never>,
    @Body({
      schema: contracts.setRatingScoreSchema,
      pipes: [new SchemaValidationPipe(contracts.setRatingScoreSchema)],
    })
    body: SetRatingScore,
  ) {
    void query;
    return this.ratings.setScore(bearerToken(auth), id, body);
  }
  @Post('targets/:id/comments')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'ratingCreateComment',
    description:
      'Strict current-authorized R1 contract. Independent score and text; unknown authority fails closed.',
  })
  @ApiOkResponse({
    standardSchema: contracts.ratingReceiptSchema,
    headers: ratingResponseHeaders,
    description: 'Strict ratings contract',
  })
  createComment(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(contracts.ratingIdSchema)) id: string,
    @Query({
      schema: contracts.ratingEmptySchema,
      pipes: [new SchemaValidationPipe(contracts.ratingEmptySchema)],
    })
    query: Record<string, never>,
    @Body({
      schema: contracts.createRatingCommentSchema,
      pipes: [new SchemaValidationPipe(contracts.createRatingCommentSchema)],
    })
    body: CreateRatingComment,
  ) {
    void query;
    return this.ratings.createComment(bearerToken(auth), id, body);
  }
  @Delete('comments/:id')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'ratingDeleteComment',
    description:
      'Strict current-authorized R1 contract. Independent score and text; unknown authority fails closed.',
  })
  @ApiOkResponse({
    standardSchema: contracts.ratingReceiptSchema,
    headers: ratingResponseHeaders,
    description: 'Strict ratings contract',
  })
  deleteComment(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(contracts.ratingIdSchema)) id: string,
    @Query({
      schema: contracts.ratingEmptySchema,
      pipes: [new SchemaValidationPipe(contracts.ratingEmptySchema)],
    })
    query: Record<string, never>,
    @Body({
      schema: contracts.deleteRatingCommentSchema,
      pipes: [new SchemaValidationPipe(contracts.deleteRatingCommentSchema)],
    })
    body: DeleteRatingComment,
  ) {
    void query;
    return this.ratings.deleteComment(bearerToken(auth), id, body);
  }
}
