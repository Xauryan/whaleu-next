import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { SchemaValidationPipe } from '../../http/validation.js';
import { bearerToken } from '../../identity/tokens.js';
import { idSchema, requestIdSchema } from '../contracts.js';
import type { PageQuery } from '../contracts.js';
import {
  contextQuerySchema,
  discussionMutationSchema,
  publishReplySchema,
  repliesQuerySchema,
} from './contracts.js';
import type { PublishReply } from './contracts.js';
import { DiscussionReadService } from './read.service.js';
import { DiscussionMutationService } from './mutation.service.js';
import { ReplyPublicationService } from './publication.service.js';
@Controller('v1/community')
export class DiscussionController {
  constructor(
    @Inject(DiscussionReadService)
    private readonly reads: DiscussionReadService,
    @Inject(DiscussionMutationService)
    private readonly mutations: DiscussionMutationService,
    @Inject(ReplyPublicationService)
    private readonly publications: ReplyPublicationService,
  ) {}
  @Get('comments/:id') comment(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(idSchema)) id: string,
  ) {
    return this.reads.comment(bearerToken(auth), id);
  }
  @Get('replies/:id') reply(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(idSchema)) id: string,
  ) {
    return this.reads.reply(bearerToken(auth), id);
  }
  @Get('comments/:id/replies') replies(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(idSchema)) id: string,
    @Query(new SchemaValidationPipe(repliesQuerySchema)) query: PageQuery,
  ) {
    return this.reads.replies(bearerToken(auth), id, query);
  }
  @Get('posts/:id/discussion-context') context(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(idSchema)) id: string,
    @Query(new SchemaValidationPipe(contextQuerySchema))
    query: { commentId?: string; replyId?: string },
  ) {
    return this.reads.context(bearerToken(auth), id, query);
  }
  @Post('comments/:id/replies') create(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(idSchema)) id: string,
    @Body(new SchemaValidationPipe(publishReplySchema)) body: PublishReply,
  ) {
    return this.publications.create(bearerToken(auth), id, body);
  }
  @Delete('replies/:id') @HttpCode(204) delete(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(idSchema)) id: string,
  ) {
    return this.mutations.deleteReply(bearerToken(auth), id);
  }
  @Put('comments/:id/like') likeComment(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(idSchema)) id: string,
    @Body(new SchemaValidationPipe(discussionMutationSchema))
    body: { clientRequestId: string },
  ) {
    return this.mutations.set(
      bearerToken(auth),
      body.clientRequestId,
      'set_comment_like',
      id,
      true,
    );
  }
  @Delete('comments/:id/like') unlikeComment(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(idSchema)) id: string,
    @Body(new SchemaValidationPipe(discussionMutationSchema))
    body: { clientRequestId: string },
  ) {
    return this.mutations.set(
      bearerToken(auth),
      body.clientRequestId,
      'set_comment_like',
      id,
      false,
    );
  }
  @Put('replies/:id/like') likeReply(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(idSchema)) id: string,
    @Body(new SchemaValidationPipe(discussionMutationSchema))
    body: { clientRequestId: string },
  ) {
    return this.mutations.set(
      bearerToken(auth),
      body.clientRequestId,
      'set_reply_like',
      id,
      true,
    );
  }
  @Delete('replies/:id/like') unlikeReply(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(idSchema)) id: string,
    @Body(new SchemaValidationPipe(discussionMutationSchema))
    body: { clientRequestId: string },
  ) {
    return this.mutations.set(
      bearerToken(auth),
      body.clientRequestId,
      'set_reply_like',
      id,
      false,
    );
  }
  @Put('comments/:id/pin') pin(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(idSchema)) id: string,
    @Body(new SchemaValidationPipe(discussionMutationSchema))
    body: { clientRequestId: string },
  ) {
    return this.mutations.set(
      bearerToken(auth),
      body.clientRequestId,
      'set_comment_pin',
      id,
      true,
    );
  }
  @Delete('comments/:id/pin') unpin(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(idSchema)) id: string,
    @Body(new SchemaValidationPipe(discussionMutationSchema))
    body: { clientRequestId: string },
  ) {
    return this.mutations.set(
      bearerToken(auth),
      body.clientRequestId,
      'set_comment_pin',
      id,
      false,
    );
  }
}
@Controller('v1/me/community')
export class DiscussionRecoveryController {
  constructor(
    @Inject(DiscussionMutationService)
    private readonly mutations: DiscussionMutationService,
  ) {}
  @Get('discussion-requests/:id') receipt(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(requestIdSchema)) id: string,
  ) {
    return this.mutations.receipt(bearerToken(auth), id);
  }
}
