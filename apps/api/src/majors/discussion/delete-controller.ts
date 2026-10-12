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
import { majorIdSchema } from '../contracts.js';
import * as c from './delete-contracts.js';
import type {
  MajorDiscussionDelete,
  MajorDiscussionDeleteCancel,
} from './delete-contracts.js';
import { MajorDiscussionDeleteService } from './delete-service.js';
const empty = z.strictObject({}),
  emptyBody = z.union([z.undefined(), empty]);
@ApiTags('Major discussion')
@ApiBearerAuth('accessToken')
@RatingResponses()
@UseGuards(RatingRequestGuard)
@Controller('v1/majors')
export class MajorDiscussionDeleteController {
  constructor(
    @Inject(MajorDiscussionDeleteService)
    private readonly discussion: MajorDiscussionDeleteService,
  ) {}
  @Get('discussion-delete-requests/:requestId')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'majorDiscussionDeleteReceipt' })
  @ApiOkResponse({
    standardSchema: c.majorDiscussionDeleteReceiptSchema,
    headers: ratingResponseHeaders,
  })
  receipt(
    @Headers('authorization') auth: unknown,
    @Param('requestId', new SchemaValidationPipe(majorIdSchema)) key: string,
    @Query({ schema: empty, pipes: [new SchemaValidationPipe(empty)] })
    _query: unknown,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    return this.discussion.receipt(bearerToken(auth), key);
  }
  @Post('discussion-delete-requests/:requestId/cancel')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'majorDiscussionDeleteCancel' })
  @ApiOkResponse({
    standardSchema: c.majorDiscussionDeleteReceiptSchema,
    headers: ratingResponseHeaders,
  })
  cancel(
    @Headers('authorization') auth: unknown,
    @Param('requestId', new SchemaValidationPipe(majorIdSchema)) key: string,
    @Query({ schema: empty, pipes: [new SchemaValidationPipe(empty)] })
    _query: unknown,
    @Body({
      schema: c.majorDiscussionDeleteCancelSchema,
      pipes: [new SchemaValidationPipe(c.majorDiscussionDeleteCancelSchema)],
    })
    input: MajorDiscussionDeleteCancel,
  ) {
    return this.discussion.cancel(bearerToken(auth), key, input);
  }
  @Get(':id/discussion/:commentId/delete-capability')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'majorDiscussionDeleteCapability' })
  @ApiOkResponse({
    standardSchema: c.majorDiscussionDeleteCapabilitySchema,
    headers: ratingResponseHeaders,
  })
  capability(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(majorIdSchema)) id: string,
    @Param('commentId', new SchemaValidationPipe(majorIdSchema))
    comment: string,
    @Query({
      schema: c.majorDiscussionDeleteCapabilityQuerySchema,
      pipes: [
        new SchemaValidationPipe(c.majorDiscussionDeleteCapabilityQuerySchema),
      ],
    })
    query: { rootId?: string },
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    return this.discussion.capability(
      bearerToken(auth),
      id,
      comment,
      query.rootId ?? null,
    );
  }
  @Post(':id/discussion/:commentId/delete')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ operationId: 'majorDiscussionDelete' })
  @ApiOkResponse({
    standardSchema: c.majorDiscussionDeleteReceiptSchema,
    headers: ratingResponseHeaders,
  })
  delete(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(majorIdSchema)) id: string,
    @Param('commentId', new SchemaValidationPipe(majorIdSchema))
    comment: string,
    @Query({ schema: empty, pipes: [new SchemaValidationPipe(empty)] })
    _query: unknown,
    @Body({
      schema: c.majorDiscussionDeleteSchema,
      pipes: [new SchemaValidationPipe(c.majorDiscussionDeleteSchema)],
    })
    input: MajorDiscussionDelete,
  ) {
    return this.discussion.delete(bearerToken(auth), id, comment, input);
  }
}
