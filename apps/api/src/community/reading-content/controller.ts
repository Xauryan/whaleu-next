import {
  Controller,
  Get,
  Header,
  Headers,
  Inject,
  Param,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { SchemaValidationPipe } from '../../http/validation.js';
import { bearerToken } from '../../identity/tokens.js';
import { AccountPolicy } from '../../safety/account-policy/decorator.js';
import { idSchema, postViewQuerySchema } from '../contracts.js';
import type { PageQuery } from '../contracts.js';
import {
  commentsQuerySchema,
  contextQuerySchema,
  repliesQuerySchema,
} from '../discussion/contracts.js';
import type { CommentsQuery } from '../discussion/contracts.js';
import { FeedService } from '../feed.service.js';
import { DiscussionReadService } from '../discussion/read.service.js';
import { ReadingContentService } from './service.js';
import {
  readingPostDetailSchema,
  readingCommentDetailSchema,
  readingReplyDetailSchema,
  readingCommentsPageSchema,
  readingRepliesPageSchema,
  readingContextSchema,
} from './contracts.js';

@ApiTags('Community source-aware content')
@ApiBearerAuth('accessToken')
@Controller('v2/community')
export class ReadingContentController {
  constructor(
    @Inject(FeedService) private readonly feeds: FeedService,
    @Inject(DiscussionReadService)
    private readonly discussion: DiscussionReadService,
    @Inject(ReadingContentService)
    private readonly readings: ReadingContentService,
  ) {}
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @AccountPolicy('browse', 'entry')
  @ApiOperation({
    operationId: 'communityReadingPost',
    description:
      'Existing current detail/viewSpace authority and unchanged DTO. Explicit v6 source proof is mandatory; only lossless presentation is optional. Never downgrade on authorization/source failure.',
  })
  @ApiOkResponse({ standardSchema: readingPostDetailSchema })
  @Get('posts/:id')
  async detail(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(idSchema)) id: string,
    @Query(new SchemaValidationPipe(postViewQuerySchema))
    query: { viewSpaceId?: string },
  ) {
    const node = await this.feeds.projectDetail(
      bearerToken(auth),
      id,
      query.viewSpaceId,
      (content, row, tx) => this.readings.post(content, row, tx),
    );
    return { version: 2 as const, ...node };
  }
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @AccountPolicy('browse', 'entry')
  @ApiOperation({ operationId: 'communityReadingComments' })
  @ApiOkResponse({ standardSchema: readingCommentsPageSchema })
  @Get('posts/:id/comments')
  async comments(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(idSchema)) id: string,
    @Query(new SchemaValidationPipe(commentsQuerySchema)) query: CommentsQuery,
  ) {
    const page = await this.discussion.projectComments(
      bearerToken(auth),
      id,
      query,
      (content, row, tx) => this.readings.comment(content, row, tx),
    );
    return { version: 2 as const, ...page };
  }
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @AccountPolicy('browse', 'entry')
  @ApiOperation({ operationId: 'communityReadingComment' })
  @ApiOkResponse({ standardSchema: readingCommentDetailSchema })
  @Get('comments/:id')
  async comment(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(idSchema)) id: string,
  ) {
    const node = await this.discussion.projectComment(
      bearerToken(auth),
      id,
      (content, row, tx) => this.readings.comment(content, row, tx),
    );
    return { version: 2 as const, ...node };
  }
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @AccountPolicy('browse', 'entry')
  @ApiOperation({ operationId: 'communityReadingReplies' })
  @ApiOkResponse({ standardSchema: readingRepliesPageSchema })
  @Get('comments/:id/replies')
  async replies(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(idSchema)) id: string,
    @Query(new SchemaValidationPipe(repliesQuerySchema)) query: PageQuery,
  ) {
    const page = await this.discussion.projectReplies(
      bearerToken(auth),
      id,
      query,
      (content, row, tx) => this.readings.reply(content, row, tx),
    );
    return { version: 2 as const, ...page };
  }
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @AccountPolicy('browse', 'entry')
  @ApiOperation({ operationId: 'communityReadingReply' })
  @ApiOkResponse({ standardSchema: readingReplyDetailSchema })
  @Get('replies/:id')
  async reply(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(idSchema)) id: string,
  ) {
    const node = await this.discussion.projectReply(
      bearerToken(auth),
      id,
      (content, row, tx) => this.readings.reply(content, row, tx),
    );
    return { version: 2 as const, ...node };
  }
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @AccountPolicy('browse', 'entry')
  @ApiOperation({ operationId: 'communityReadingContext' })
  @ApiOkResponse({ standardSchema: readingContextSchema })
  @Get('posts/:id/discussion-context')
  async context(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(idSchema)) id: string,
    @Query(new SchemaValidationPipe(contextQuerySchema))
    query: { commentId?: string; replyId?: string },
  ) {
    const result = await this.discussion.projectContext(
      bearerToken(auth),
      id,
      query,
      (content, row, tx) => this.readings.comment(content, row, tx),
      (content, row, tx) => this.readings.reply(content, row, tx),
    );
    return { version: 2 as const, ...result };
  }
}
