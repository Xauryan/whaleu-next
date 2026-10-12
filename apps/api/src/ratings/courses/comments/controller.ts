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
import { courseIdSchema, courseEmptySchema } from '../contracts.js';
import * as contracts from './contracts.js';
import type {
  CourseCommentQuery,
  CourseCommentPublish,
  CourseCommentLike,
  CourseCommentCancel,
} from './contracts.js';
import { CourseCommentsService } from './service.js';
const emptyBody = z.union([z.undefined(), courseEmptySchema]);
@ApiTags('Course comments')
@ApiBearerAuth('accessToken')
@RatingResponses()
@UseGuards(RatingRequestGuard)
@Controller('v1/ratings/courses')
export class CourseCommentsController {
  constructor(
    @Inject(CourseCommentsService)
    private readonly comments: CourseCommentsService,
  ) {}
  @Get('comment-requests/:requestId')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'courseCommentReceipt',
    description:
      'Actor-only original outcome; no new visibility or eligibility grant.',
  })
  @ApiOkResponse({
    standardSchema: contracts.courseCommentReceiptSchema,
    headers: ratingResponseHeaders,
  })
  receipt(
    @Headers('authorization') auth: unknown,
    @Param('requestId', new SchemaValidationPipe(courseIdSchema)) id: string,
    @Query(new SchemaValidationPipe(courseEmptySchema)) _query: unknown,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    return this.comments.receipt(bearerToken(auth), id);
  }
  @Post('comment-requests/:requestId/cancel')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'courseCommentCancel',
    description:
      'Original exact intent cancellation serialized against publication/like; existing immutable result wins.',
  })
  @ApiOkResponse({
    standardSchema: contracts.courseCommentReceiptSchema,
    headers: ratingResponseHeaders,
  })
  cancel(
    @Headers('authorization') auth: unknown,
    @Param('requestId', new SchemaValidationPipe(courseIdSchema)) id: string,
    @Query(new SchemaValidationPipe(courseEmptySchema)) _query: unknown,
    @Body({
      schema: contracts.courseCommentCancelSchema,
      pipes: [new SchemaValidationPipe(contracts.courseCommentCancelSchema)],
    })
    input: CourseCommentCancel,
  ) {
    return this.comments.cancel(bearerToken(auth), id, input);
  }
  @Get(':id/comments')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'courseCommentsList',
    description:
      'Author-undisclosed reviewed text, exact likes and stable time/likes continuation. Unknown history unavailable.',
  })
  @ApiOkResponse({
    standardSchema: contracts.courseCommentPageSchema,
    headers: ratingResponseHeaders,
  })
  page(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(courseIdSchema)) id: string,
    @Query({
      schema: contracts.courseCommentQuerySchema,
      pipes: [new SchemaValidationPipe(contracts.courseCommentQuerySchema)],
    })
    query: CourseCommentQuery,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    return this.comments.page(bearerToken(auth), id, query);
  }
  @Post(':id/comments')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'courseCommentPublish',
    description:
      'Exact reviewed text, current verified-base publisher, repeat distinct comments allowed. Next 8000 UTF-8 bytes bound.',
  })
  @ApiOkResponse({
    standardSchema: contracts.courseCommentReceiptSchema,
    headers: ratingResponseHeaders,
  })
  publish(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(courseIdSchema)) id: string,
    @Query(new SchemaValidationPipe(courseEmptySchema)) _query: unknown,
    @Body({
      schema: contracts.courseCommentPublishSchema,
      pipes: [new SchemaValidationPipe(contracts.courseCommentPublishSchema)],
    })
    command: CourseCommentPublish,
  ) {
    return this.comments.publish(bearerToken(auth), id, command);
  }
  @Post(':id/comments/:commentId/like')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    operationId: 'courseCommentLike',
    description:
      'Irreversible one lifetime actor/comment membership; phone and Safety only, no base gate or self-like ban.',
  })
  @ApiOkResponse({
    standardSchema: contracts.courseCommentReceiptSchema,
    headers: ratingResponseHeaders,
  })
  like(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(courseIdSchema)) id: string,
    @Param('commentId', new SchemaValidationPipe(courseIdSchema))
    commentId: string,
    @Query(new SchemaValidationPipe(courseEmptySchema)) _query: unknown,
    @Body({
      schema: contracts.courseCommentLikeSchema,
      pipes: [new SchemaValidationPipe(contracts.courseCommentLikeSchema)],
    })
    command: CourseCommentLike,
  ) {
    return this.comments.like(bearerToken(auth), id, commentId, command);
  }
}
