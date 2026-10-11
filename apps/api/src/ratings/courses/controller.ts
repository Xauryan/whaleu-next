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
import type { CourseQuery, CourseFirstScore } from './contracts.js';
import { CourseRatingsService } from './service.js';
const emptyBody = z.union([z.undefined(), contracts.courseEmptySchema]);
@ApiTags('Course ratings')
@ApiBearerAuth('accessToken')
@RatingResponses()
@UseGuards(RatingRequestGuard)
@Controller('v1/ratings/courses')
export class CourseRatingsController {
  constructor(
    @Inject(CourseRatingsService)
    private readonly courses: CourseRatingsService,
  ) {}
  @Get()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'courseRatingsDirectory',
    description:
      'Source-accepted course directory; phone-authenticated, current Safety. Name substring, exclusive department/category, separate native half-step scoring.',
  })
  @ApiOkResponse({
    standardSchema: contracts.coursePageSchema,
    headers: ratingResponseHeaders,
    description: 'Known complete catalog; unknown history is explicit.',
  })
  page(
    @Headers('authorization') auth: unknown,
    @Query({
      schema: contracts.courseQuerySchema,
      pipes: [new SchemaValidationPipe(contracts.courseQuerySchema)],
    })
    query: CourseQuery,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    return this.courses.page(bearerToken(auth), query);
  }
  @Get('requests/:requestId')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'courseRatingReceipt',
    description:
      'Actor-only immutable original receipt; current session required, independent of withdrawn source or later eligibility.',
  })
  @ApiOkResponse({
    standardSchema: contracts.courseReceiptSchema,
    headers: ratingResponseHeaders,
    description: 'Original typed course command outcome.',
  })
  receipt(
    @Headers('authorization') auth: unknown,
    @Param('requestId', new SchemaValidationPipe(contracts.courseIdSchema))
    id: string,
    @Query(new SchemaValidationPipe(contracts.courseEmptySchema))
    _query: unknown,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    return this.courses.receipt(bearerToken(auth), id);
  }
  @Get(':id')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'courseRatingDetail',
    description:
      'Current source metadata, private own tuple and independent exact three-axis summary in one proven read.',
  })
  @ApiOkResponse({
    standardSchema: contracts.courseDetailSchema,
    headers: ratingResponseHeaders,
    description: 'No score authors or identities exposed.',
  })
  detail(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(contracts.courseIdSchema)) id: string,
    @Query(new SchemaValidationPipe(contracts.courseEmptySchema))
    _query: unknown,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    return this.courses.detail(bearerToken(auth), id);
  }
  @Get(':id/my-score')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'courseRatingOwnScore',
    description:
      'Current actor only; unknown historical coverage is never not-submitted.',
  })
  @ApiOkResponse({
    standardSchema: contracts.courseOwnSchema,
    headers: ratingResponseHeaders,
    description: 'Private original course tuple.',
  })
  own(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(contracts.courseIdSchema)) id: string,
    @Query(new SchemaValidationPipe(contracts.courseEmptySchema))
    _query: unknown,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    return this.courses.own(bearerToken(auth), id);
  }
  @Get(':id/summary')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'courseRatingSummary',
    description:
      'Three independently calculated exact means rounded to one decimal; no five-bucket generic score conversion.',
  })
  @ApiOkResponse({
    standardSchema: contracts.courseSummarySchema,
    headers: ratingResponseHeaders,
    description: 'Zero only means accepted known-empty count; means are null.',
  })
  summary(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(contracts.courseIdSchema)) id: string,
    @Query(new SchemaValidationPipe(contracts.courseEmptySchema))
    _query: unknown,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    return this.courses.summary(bearerToken(auth), id);
  }
  @Post(':id/first-score')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'courseRatingFirstScore',
    description:
      'One lifetime first tuple per actor/course. Each independent dimension is required, 0.5–5 in half steps. Original key immutable recovery; no edit/delete operation.',
  })
  @ApiOkResponse({
    standardSchema: contracts.courseReceiptSchema,
    headers: ratingResponseHeaders,
    description: 'Durable applied or serialized terminal rejection receipt.',
  })
  firstScore(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(contracts.courseIdSchema)) id: string,
    @Query(new SchemaValidationPipe(contracts.courseEmptySchema))
    _query: unknown,
    @Body({
      schema: contracts.courseFirstScoreSchema,
      pipes: [new SchemaValidationPipe(contracts.courseFirstScoreSchema)],
    })
    command: CourseFirstScore,
  ) {
    return this.courses.firstScore(bearerToken(auth), id, command);
  }
}
