import { ratingLikeStateSchema } from '../likes/contracts.js';
import { RatingScopedNoticeService } from './notice.service.js';
import { ratingDiscussionNoticeSchema } from '../../notifications/ratings/discussion-media-contracts.js';
import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Post,
  Query,
  Header,
  HttpCode,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { z } from 'zod';
import { bearerToken } from '../../identity/tokens.js';
import { SchemaValidationPipe } from '../../http/validation.js';
import {
  RatingResponses,
  ratingResponseHeaders,
} from '../../http/rating-http.js';
import { RatingRequestGuard } from '../../request-throttling/rating-request.guard.js';
import { RatingScopedContextService } from './context.service.js';
import { RatingScopedCommands } from './commands.service.js';
import {
  RatingScopedReadService,
  ratingDiscussionComposerContextSchema,
  ratingDiscussionComposerQuerySchema,
  ratingDiscussionMediaCommentPageSchema,
  ratingDiscussionMediaThreadSchema,
  ratingDiscussionMediaReplyPageSchema,
  ratingDiscussionMediaReplyPositionSchema,
} from './read.service.js';
import {
  ratingScopedContextRequestSchema,
  ratingScopedReadQuerySchema,
  ratingScopedPageQuerySchema,
  ratingScopedCommentQuerySchema,
  scopedId,
} from './contracts.js';
import {
  ratingDiscussionMediaHashCancelSchema,
  ratingDiscussionContextSchema,
  ratingDiscussionMediaIntentSchema,
  ratingDiscussionMediaCommitSchema,
  ratingDiscussionMediaReceiptSchema,
  ratingDiscussionMediaPreparationSchema,
} from './discussion-media-contracts.js';
import {
  ratingDiscussionMediaRootSchema,
  ratingDiscussionMediaReplySchema,
} from '../discussion-media-projection-contracts.js';
const contextRequest = ratingScopedContextRequestSchema.refine(
  (value) => value.purpose === 'read' || value.purpose === 'interact',
);
const positionQuery = ratingScopedPageQuerySchema.omit({ cursor: true });
const prepareResponse = z.union([
  ratingDiscussionMediaPreparationSchema,
  ratingDiscussionMediaReceiptSchema,
]);
const pipe = <T extends z.ZodType>(schema: T) =>
  new SchemaValidationPipe(schema);
const idOptions = { schema: scopedId, pipes: [pipe(scopedId)] };
const noticeKind = z.enum(['updates', 'like-updates', 'subscription-updates']);
@ApiTags('Ratings discussion images')
@ApiBearerAuth('accessToken')
@RatingResponses()
@UseGuards(RatingRequestGuard)
@Controller('v4/ratings/discussion')
export class RatingDiscussionMediaController {
  constructor(
    @Inject(RatingScopedContextService)
    private readonly contexts: RatingScopedContextService,
    @Inject(RatingScopedCommands)
    private readonly commands: RatingScopedCommands,
    @Inject(RatingScopedReadService)
    private readonly reads: RatingScopedReadService,
    @Inject(RatingScopedNoticeService)
    private readonly notices: RatingScopedNoticeService,
  ) {}
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @Post('contexts')
  @HttpCode(200)
  @ApiOperation({ operationId: 'ratingDiscussionMediaContext' })
  @ApiOkResponse({
    headers: ratingResponseHeaders,
    standardSchema: ratingDiscussionContextSchema,
  })
  context(
    @Headers('authorization') auth: unknown,
    @Body({ schema: contextRequest, pipes: [pipe(contextRequest)] })
    body: z.infer<typeof contextRequest>,
  ) {
    return this.contexts.createDiscussion(bearerToken(auth), body);
  }
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @Post('prepare')
  @HttpCode(200)
  @ApiOperation({ operationId: 'ratingDiscussionMediaPrepare' })
  @ApiOkResponse({
    headers: ratingResponseHeaders,
    standardSchema: prepareResponse,
  })
  prepare(
    @Headers('authorization') auth: unknown,
    @Body({
      schema: ratingDiscussionMediaIntentSchema,
      pipes: [pipe(ratingDiscussionMediaIntentSchema)],
    })
    body: z.infer<typeof ratingDiscussionMediaIntentSchema>,
  ) {
    return this.commands.prepare(bearerToken(auth), body);
  }
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @Post('commit')
  @HttpCode(200)
  @ApiOperation({ operationId: 'ratingDiscussionMediaCommit' })
  @ApiOkResponse({
    headers: ratingResponseHeaders,
    standardSchema: ratingDiscussionMediaReceiptSchema,
  })
  commit(
    @Headers('authorization') auth: unknown,
    @Body({
      schema: ratingDiscussionMediaCommitSchema,
      pipes: [pipe(ratingDiscussionMediaCommitSchema)],
    })
    body: z.infer<typeof ratingDiscussionMediaCommitSchema>,
  ) {
    const { preparationContextRevision, ...intent } = body;
    return this.commands.submit(
      bearerToken(auth),
      intent,
      preparationContextRevision,
    );
  }
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @Post('cancel')
  @HttpCode(200)
  @ApiOperation({ operationId: 'ratingDiscussionMediaCancel' })
  @ApiOkResponse({
    headers: ratingResponseHeaders,
    standardSchema: ratingDiscussionMediaReceiptSchema,
  })
  cancel(
    @Headers('authorization') auth: unknown,
    @Body({
      schema: ratingDiscussionMediaIntentSchema,
      pipes: [pipe(ratingDiscussionMediaIntentSchema)],
    })
    body: z.infer<typeof ratingDiscussionMediaIntentSchema>,
  ) {
    return this.commands.cancel(bearerToken(auth), body);
  }
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @Get('targets/:id/comments')
  @ApiOperation({ operationId: 'ratingDiscussionMediaComments' })
  @ApiOkResponse({
    headers: ratingResponseHeaders,
    standardSchema: ratingDiscussionMediaCommentPageSchema,
  })
  comments(
    @Headers('authorization') auth: unknown,
    @Param('id', idOptions) id: string,
    @Query({
      schema: ratingScopedCommentQuerySchema,
      pipes: [pipe(ratingScopedCommentQuerySchema)],
    })
    query: z.infer<typeof ratingScopedCommentQuerySchema>,
  ) {
    return this.reads.comments(bearerToken(auth), id, query, true);
  }
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @Get('comments/:id')
  @ApiOperation({ operationId: 'ratingDiscussionMediaComment' })
  @ApiOkResponse({
    headers: ratingResponseHeaders,
    standardSchema: ratingDiscussionMediaRootSchema,
  })
  comment(
    @Headers('authorization') auth: unknown,
    @Param('id', idOptions) id: string,
    @Query({
      schema: ratingScopedReadQuerySchema,
      pipes: [pipe(ratingScopedReadQuerySchema)],
    })
    query: z.infer<typeof ratingScopedReadQuerySchema>,
  ) {
    return this.reads.comment(bearerToken(auth), id, query, true);
  }
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @Get('comments/:id/thread')
  @ApiOperation({ operationId: 'ratingDiscussionMediaThread' })
  @ApiOkResponse({
    headers: ratingResponseHeaders,
    standardSchema: ratingDiscussionMediaThreadSchema,
  })
  thread(
    @Headers('authorization') auth: unknown,
    @Param('id', idOptions) id: string,
    @Query({
      schema: ratingScopedReadQuerySchema,
      pipes: [pipe(ratingScopedReadQuerySchema)],
    })
    query: z.infer<typeof ratingScopedReadQuerySchema>,
  ) {
    return this.reads.thread(bearerToken(auth), id, query, true);
  }
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @Get('comments/:id/replies')
  @ApiOperation({ operationId: 'ratingDiscussionMediaReplies' })
  @ApiOkResponse({
    headers: ratingResponseHeaders,
    standardSchema: ratingDiscussionMediaReplyPageSchema,
  })
  replies(
    @Headers('authorization') auth: unknown,
    @Param('id', idOptions) id: string,
    @Query({
      schema: ratingScopedPageQuerySchema,
      pipes: [pipe(ratingScopedPageQuerySchema)],
    })
    query: z.infer<typeof ratingScopedPageQuerySchema>,
  ) {
    return this.reads.listReplies(bearerToken(auth), id, query, true);
  }
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @Get('replies/:id')
  @ApiOperation({ operationId: 'ratingDiscussionMediaReply' })
  @ApiOkResponse({
    headers: ratingResponseHeaders,
    standardSchema: ratingDiscussionMediaReplySchema,
  })
  reply(
    @Headers('authorization') auth: unknown,
    @Param('id', idOptions) id: string,
    @Query({
      schema: ratingScopedReadQuerySchema,
      pipes: [pipe(ratingScopedReadQuerySchema)],
    })
    query: z.infer<typeof ratingScopedReadQuerySchema>,
  ) {
    return this.reads.reply(bearerToken(auth), id, query, true);
  }
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @Get('replies/:id/position')
  @ApiOperation({ operationId: 'ratingDiscussionMediaReplyPosition' })
  @ApiOkResponse({
    headers: ratingResponseHeaders,
    standardSchema: ratingDiscussionMediaReplyPositionSchema,
  })
  position(
    @Headers('authorization') auth: unknown,
    @Param('id', idOptions) id: string,
    @Query({ schema: positionQuery, pipes: [pipe(positionQuery)] })
    query: z.infer<typeof positionQuery>,
  ) {
    return this.reads.locateReply(bearerToken(auth), id, query, true);
  }
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @Get('notices/:kind/:id')
  @ApiOperation({ operationId: 'ratingDiscussionMediaNotice' })
  @ApiOkResponse({
    headers: ratingResponseHeaders,
    standardSchema: ratingDiscussionNoticeSchema,
  })
  notice(
    @Headers('authorization') auth: unknown,
    @Param('kind', { schema: noticeKind, pipes: [pipe(noticeKind)] })
    kind: 'updates' | 'like-updates' | 'subscription-updates',
    @Param('id', idOptions) id: string,
    @Query({
      schema: ratingScopedReadQuerySchema,
      pipes: [pipe(ratingScopedReadQuerySchema)],
    })
    query: z.infer<typeof ratingScopedReadQuerySchema>,
  ) {
    return this.notices.mediaDetail(bearerToken(auth), kind, id, query);
  }

  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @Post('requests/:id/cancel')
  @HttpCode(200)
  @ApiOperation({ operationId: 'ratingDiscussionMediaHashCancel' })
  @ApiOkResponse({
    headers: ratingResponseHeaders,
    standardSchema: ratingDiscussionMediaReceiptSchema,
  })
  cancelByHash(
    @Headers('authorization') auth: unknown,
    @Param('id', idOptions) id: string,
    @Body({
      schema: ratingDiscussionMediaHashCancelSchema,
      pipes: [pipe(ratingDiscussionMediaHashCancelSchema)],
    })
    body: z.infer<typeof ratingDiscussionMediaHashCancelSchema>,
  ) {
    return this.commands.cancelDiscussionByHash(bearerToken(auth), id, body);
  }

  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @Get('receipts/:id')
  @ApiOperation({ operationId: 'ratingDiscussionMediaReceipt' })
  @ApiOkResponse({
    headers: ratingResponseHeaders,
    standardSchema: ratingDiscussionMediaReceiptSchema,
  })
  async receipt(
    @Headers('authorization') auth: unknown,
    @Param('id', idOptions) id: string,
  ) {
    return ratingDiscussionMediaReceiptSchema.parse(
      await this.commands.status(bearerToken(auth), id, 4),
    );
  }
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @Get('targets/:id/composer-context')
  @ApiOperation({ operationId: 'ratingDiscussionMediaComposerContext' })
  @ApiOkResponse({
    headers: ratingResponseHeaders,
    standardSchema: ratingDiscussionComposerContextSchema,
  })
  composer(
    @Headers('authorization') auth: unknown,
    @Param('id', idOptions) id: string,
    @Query({
      schema: ratingDiscussionComposerQuerySchema,
      pipes: [pipe(ratingDiscussionComposerQuerySchema)],
    })
    query: z.infer<typeof ratingDiscussionComposerQuerySchema>,
  ) {
    return this.reads.composerContext(bearerToken(auth), id, query);
  }

  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @Get('likes/:kind/:id')
  @ApiOperation({ operationId: 'ratingDiscussionMediaLikeState' })
  @ApiOkResponse({
    headers: ratingResponseHeaders,
    standardSchema: ratingLikeStateSchema,
  })
  like(
    @Headers('authorization') auth: unknown,
    @Param('kind', {
      schema: z.enum(['comment', 'reply']),
      pipes: [pipe(z.enum(['comment', 'reply']))],
    })
    kind: 'comment' | 'reply',
    @Param('id', idOptions) id: string,
    @Query({
      schema: ratingScopedReadQuerySchema,
      pipes: [pipe(ratingScopedReadQuerySchema)],
    })
    query: z.infer<typeof ratingScopedReadQuerySchema>,
  ) {
    return this.reads.likeState(bearerToken(auth), kind, id, query, true);
  }
}
