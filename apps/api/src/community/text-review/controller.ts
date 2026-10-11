import { z } from 'zod';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { safeErrorResponseSchema } from '../../http/error-contracts.js';
import { textReviewStatusSchema } from './contracts.js';
import { mediaBatchPublicationCancellationSchema as postCancellation } from '../../media/contracts-v3.js';
import { mediaBatchPublicationCancellationSchema as discussionCancellation } from '../../media/contracts-v4.js';
import { textReviewCancellationSchema } from './contracts.js';
import type { TextReviewCancellation } from './contracts.js';
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
} from '@nestjs/common';
import { SchemaValidationPipe } from '../../http/validation.js';
import { bearerToken } from '../../identity/tokens.js';
import {
  idSchema,
  requestIdSchema,
  publishPostSchema,
  publishCommentSchema,
} from '../contracts.js';
import type { PublishPost, PublishComment } from '../contracts.js';
import { publishReplySchema } from '../discussion/contracts.js';
import type { PublishReply } from '../discussion/contracts.js';
import { PublicationService } from '../publication.service.js';
import { PublicationRepository } from '../publication.repository.js';
import { ReplyPublicationService } from '../discussion/publication.service.js';

@ApiTags('Non-production text review')
@ApiBearerAuth('accessToken')
@ApiResponse({
  status: 400,
  standardSchema: safeErrorResponseSchema,
  description: 'Malformed original intent or request reference.',
})
@ApiResponse({
  status: 401,
  standardSchema: safeErrorResponseSchema,
  description: 'Current owner authentication required.',
})
@ApiResponse({
  status: 403,
  standardSchema: safeErrorResponseSchema,
  description: 'Original publication policy or actor is ineligible.',
})
@ApiResponse({
  status: 404,
  standardSchema: safeErrorResponseSchema,
  description: 'No request owned by this actor.',
})
@ApiResponse({
  status: 409,
  standardSchema: safeErrorResponseSchema,
  description: 'Conflicting original key or durable cancellation fence.',
})
@ApiResponse({
  status: 503,
  standardSchema: safeErrorResponseSchema,
  description:
    'Explicit local non-production mode, current policy or review unavailable.',
})
@Controller('v1/community/reviews')
export class TextReviewController {
  constructor(
    @Inject(PublicationService)
    private readonly publications: PublicationService,
    @Inject(ReplyPublicationService)
    private readonly replies: ReplyPublicationService,
    @Inject(PublicationRepository)
    private readonly requests: PublicationRepository,
  ) {}
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @Post('posts')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'textReviewPost',
    description:
      'Explicit local manual review; original publication receipt and current authorization remain authoritative.',
  })
  @ApiOkResponse({
    standardSchema: textReviewStatusSchema,
    headers: {
      'cache-control': { schema: { type: 'string', enum: ['no-store'] } },
    },
  })
  post(
    @Headers('authorization') auth: unknown,
    @Body({
      schema: publishPostSchema,
      pipes: [new SchemaValidationPipe(publishPostSchema)],
    })
    body: PublishPost,
  ) {
    return this.publications.post(bearerToken(auth), body, true);
  }
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @Post('posts/:id/comments')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'textReviewComment',
    description:
      'Explicit local manual review; original publication receipt and current authorization remain authoritative.',
  })
  @ApiOkResponse({
    standardSchema: textReviewStatusSchema,
    headers: {
      'cache-control': { schema: { type: 'string', enum: ['no-store'] } },
    },
  })
  comment(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(idSchema)) id: string,
    @Body({
      schema: publishCommentSchema,
      pipes: [new SchemaValidationPipe(publishCommentSchema)],
    })
    body: PublishComment,
  ) {
    return this.publications.comment(bearerToken(auth), id, body, true);
  }
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @Post('comments/:id/replies')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'textReviewReply',
    description:
      'Explicit local manual review; original publication receipt and current authorization remain authoritative.',
  })
  @ApiOkResponse({
    standardSchema: textReviewStatusSchema,
    headers: {
      'cache-control': { schema: { type: 'string', enum: ['no-store'] } },
    },
  })
  reply(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(idSchema)) id: string,
    @Body({
      schema: publishReplySchema,
      pipes: [new SchemaValidationPipe(publishReplySchema)],
    })
    body: PublishReply,
  ) {
    return this.replies.create(bearerToken(auth), id, body, true);
  }
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @Post('requests/:requestId/cancel')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'textReviewCancel',
    description:
      'Explicit local manual review; original publication receipt and current authorization remain authoritative.',
  })
  @ApiOkResponse({
    standardSchema: z.union([postCancellation, discussionCancellation]),
    headers: {
      'cache-control': { schema: { type: 'string', enum: ['no-store'] } },
    },
  })
  cancel(
    @Headers('authorization') auth: unknown,
    @Param('requestId', new SchemaValidationPipe(requestIdSchema)) id: string,
    @Body({
      schema: textReviewCancellationSchema,
      pipes: [new SchemaValidationPipe(textReviewCancellationSchema)],
    })
    body: TextReviewCancellation,
  ) {
    return this.requests.cancelReview(bearerToken(auth), id, body);
  }
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @Get('requests/:requestId')
  @ApiOperation({
    operationId: 'textReviewStatus',
    description:
      'Explicit local manual review; original publication receipt and current authorization remain authoritative.',
  })
  @ApiOkResponse({
    standardSchema: textReviewStatusSchema,
    headers: {
      'cache-control': { schema: { type: 'string', enum: ['no-store'] } },
    },
  })
  status(
    @Headers('authorization') auth: unknown,
    @Param('requestId', new SchemaValidationPipe(requestIdSchema)) id: string,
  ) {
    return this.requests.reviewStatus(bearerToken(auth), id);
  }
}
