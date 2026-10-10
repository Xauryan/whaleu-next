import {
  applyDecorators,
  BadRequestException,
  Body,
  Controller,
  Get,
  Put,
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
  ratingTargetSchema,
  ratingMyScoreSchema,
  ratingSummarySchema,
  ratingCommentSchema,
  ratingCanonicalText,
} from '../contracts.js';
import { ratingReplySchema } from '../discussion-contracts.js';
import { ratingLikeStateSchema } from '../likes/contracts.js';
import {
  ratingSubscriptionStateSchema,
  ratingSubscriptionQueryResponseSchema,
} from '../subscriptions/contracts.js';
import { RatingScopedContextService } from './context.service.js';
import { RatingScopedCommands } from './commands.service.js';
import {
  RatingScopedReadService,
  ratingScopedPageContextSchema,
  ratingScopedCategoryPageSchema,
  ratingScopedTargetPageSchema,
  ratingScopedCommentPageSchema,
  ratingScopedDiscussionSchema,
  ratingScopedReplyPageSchema,
  ratingScopedReplyPositionSchema,
  ratingScopedSubscriptionPageSchema,
  ratingScopedSubscriptionQuerySchema,
} from './read.service.js';
import {
  RatingScopedRandomService,
  ratingScopedRandomQuerySchema,
  ratingScopedRandomResponseSchema,
} from './random.service.js';
import {
  RatingScopedNoticeService,
  ratingScopedNoticeQuerySchema,
  ratingScopedNoticePageSchema,
  ratingScopedNoticeTargetSchema,
  ratingScopedResolveLocatorSchema,
  ratingScopedResolvedLocatorSchema,
} from './notice.service.js';
import * as contracts from './contracts.js';
import type { RatingScopedOperation } from './protocol-registry.js';
const emptyBody = z.union([z.undefined(), ratingEmptySchema]);
const options = <T>(schema: z.ZodType<T>) => ({
  schema,
  pipes: [new SchemaValidationPipe(schema)],
});
const emptyQuery = options(ratingEmptySchema);
function scoped(
  method: 'GET' | 'POST' | 'PUT',
  route: string,
  name: string,
  schema: z.ZodType,
) {
  return applyDecorators(
    (method === 'GET' ? Get : method === 'PUT' ? Put : Post)(route),
    HttpCode(200),
    Header('Cache-Control', 'no-store'),
    Header('Vary', 'Authorization'),
    ApiOperation({
      operationId: `ratingScoped${name}`,
      description:
        'Exact current scoped protocol. Historical request recovery precedes fresh context checks. Unknown source or authority fails closed.',
    }),
    ApiOkResponse({ standardSchema: schema, headers: ratingResponseHeaders }),
  );
}
export const ratingScopedPrepareResponseSchema = z.union([
  contracts.ratingScopedPreparationSchema,
  contracts.ratingScopedReceiptSchema,
]);
export const ratingScopedEditContextSchema = z.strictObject({
  context: ratingScopedPageContextSchema,
  targetId: contracts.scopedId,
  revision: contracts.scopedId,
  definitionRevision: contracts.scopedId,
  contentVersion: z.number().int().min(1).max(2147483646),
  categoryId: contracts.scopedId,
  categoryRevision: contracts.scopedId,
  name: ratingCanonicalText(100),
  description: ratingCanonicalText(500, false),
});
export function ratingScopedOperationSchema(
  operation: RatingScopedOperation,
): z.ZodType<contracts.RatingScopedIntent> {
  const schema = contracts.ratingScopedIntentSchema.options.find(
    (option) => option.shape.operation.value === operation,
  );
  if (!schema) throw new Error('Unregistered scoped operation');
  return schema;
}
export const ratingScopedCommitSchema = z.discriminatedUnion('operation', [
  contracts.ratingScopedIntentSchema.options[6].extend({
    preparationContextRevision: contracts.scopedToken,
  }),
  contracts.ratingScopedIntentSchema.options[7].extend({
    preparationContextRevision: contracts.scopedToken,
  }),
]);

function command(
  value: unknown,
  operation: RatingScopedOperation,
  id?: string,
  field?: 'targetId' | 'rootId' | 'replyId',
) {
  const parsed = contracts.ratingScopedIntentSchema.safeParse(value);
  if (
    !parsed.success ||
    parsed.data.operation !== operation ||
    (id !== undefined &&
      field !== undefined &&
      (parsed.data.payload as Record<string, unknown>)[field] !== id)
  )
    throw new BadRequestException('Invalid request');
  return parsed.data;
}
type ReadQuery = z.infer<typeof contracts.ratingScopedReadQuerySchema>;
type PageQuery = z.infer<typeof contracts.ratingScopedPageQuerySchema>;

/** One thin scope boundary; all business transitions and owner effects remain in the shared facades. */
@ApiTags('Scoped ratings')
@ApiBearerAuth('accessToken')
@RatingResponses()
@UseGuards(RatingRequestGuard)
@Controller('v2/ratings')
export class RatingScopedController {
  constructor(
    @Inject(RatingScopedContextService)
    private readonly contexts: RatingScopedContextService,
    @Inject(RatingScopedReadService)
    private readonly reads: RatingScopedReadService,
    @Inject(RatingScopedCommands)
    private readonly commands: RatingScopedCommands,
    @Inject(RatingScopedRandomService)
    private readonly random: RatingScopedRandomService,
    @Inject(RatingScopedNoticeService)
    private readonly notices: RatingScopedNoticeService,
  ) {}
  @scoped(
    'POST',
    'contexts',
    'CreateContext',
    contracts.ratingScopedContextSchema,
  )
  context(
    @Headers('authorization') auth: unknown,
    @Query(emptyQuery) _query: Record<string, never>,
    @Body(options(contracts.ratingScopedContextRequestSchema))
    body: contracts.RatingScopedContextRequest,
  ) {
    return this.contexts.create(
      bearerToken(auth),
      contracts.ratingScopedContextRequestSchema.parse(body),
    );
  }
  @scoped(
    'POST',
    'locators/resolve',
    'ResolveLocator',
    ratingScopedResolvedLocatorSchema,
  )
  resolveLocator(
    @Headers('authorization') auth: unknown,
    @Query(emptyQuery) _query: Record<string, never>,
    @Body(options(ratingScopedResolveLocatorSchema))
    body: z.infer<typeof ratingScopedResolveLocatorSchema>,
  ) {
    return this.notices.resolveLocator(bearerToken(auth), body);
  }
  @scoped('GET', 'categories', 'ListCategories', ratingScopedCategoryPageSchema)
  categories(
    @Headers('authorization') auth: unknown,
    @Query(options(contracts.ratingScopedCategoryQuerySchema))
    query: z.infer<typeof contracts.ratingScopedCategoryQuerySchema>,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    return this.reads.categories(bearerToken(auth), query);
  }
  @scoped('GET', 'targets', 'ListTargets', ratingScopedTargetPageSchema)
  targets(
    @Headers('authorization') auth: unknown,
    @Query(options(contracts.ratingScopedTargetQuerySchema))
    query: z.infer<typeof contracts.ratingScopedTargetQuerySchema>,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    return this.reads.targets(bearerToken(auth), query);
  }
  @scoped('GET', 'targets/:id', 'GetTarget', ratingTargetSchema)
  target(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(contracts.scopedId)) id: string,
    @Query(options(contracts.ratingScopedReadQuerySchema)) query: ReadQuery,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    return this.reads.target(bearerToken(auth), id, query);
  }
  @scoped('GET', 'targets/:id/my-score', 'GetMyScore', ratingMyScoreSchema)
  myScore(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(contracts.scopedId)) id: string,
    @Query(options(contracts.ratingScopedReadQuerySchema)) query: ReadQuery,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    return this.reads.myScore(bearerToken(auth), id, query);
  }
  @scoped(
    'GET',
    'targets/:id/score-summary',
    'GetScoreSummary',
    ratingSummarySchema,
  )
  summary(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(contracts.scopedId)) id: string,
    @Query(options(contracts.ratingScopedReadQuerySchema)) query: ReadQuery,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    return this.reads.summary(bearerToken(auth), id, query);
  }
  @scoped(
    'GET',
    'targets/:id/comments',
    'ListComments',
    ratingScopedCommentPageSchema,
  )
  comments(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(contracts.scopedId)) id: string,
    @Query(options(contracts.ratingScopedCommentQuerySchema))
    query: z.infer<typeof contracts.ratingScopedCommentQuerySchema>,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    return this.reads.comments(bearerToken(auth), id, query);
  }
  @scoped('GET', 'comments/:id', 'GetComment', ratingCommentSchema)
  comment(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(contracts.scopedId)) id: string,
    @Query(options(contracts.ratingScopedReadQuerySchema)) query: ReadQuery,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    return this.reads.comment(bearerToken(auth), id, query);
  }
  @scoped(
    'GET',
    'comments/:id/discussion',
    'GetDiscussion',
    ratingScopedDiscussionSchema,
  )
  discussion(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(contracts.scopedId)) id: string,
    @Query(options(contracts.ratingScopedReadQuerySchema)) query: ReadQuery,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    return this.reads.thread(bearerToken(auth), id, query);
  }
  @scoped(
    'GET',
    'comments/:id/replies',
    'ListReplies',
    ratingScopedReplyPageSchema,
  )
  replies(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(contracts.scopedId)) id: string,
    @Query(options(contracts.ratingScopedPageQuerySchema)) query: PageQuery,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    return this.reads.listReplies(bearerToken(auth), id, query);
  }
  @scoped('GET', 'replies/:id', 'GetReply', ratingReplySchema)
  reply(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(contracts.scopedId)) id: string,
    @Query(options(contracts.ratingScopedReadQuerySchema)) query: ReadQuery,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    return this.reads.reply(bearerToken(auth), id, query);
  }
  @scoped(
    'GET',
    'replies/:id/position',
    'GetReplyPosition',
    ratingScopedReplyPositionSchema,
  )
  position(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(contracts.scopedId)) id: string,
    @Query(
      options(contracts.ratingScopedPageQuerySchema.omit({ cursor: true })),
    )
    query: Omit<PageQuery, 'cursor'>,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    return this.reads.locateReply(bearerToken(auth), id, query);
  }
  @scoped('GET', 'comments/:id/like', 'GetCommentLike', ratingLikeStateSchema)
  commentLike(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(contracts.scopedId)) id: string,
    @Query(options(contracts.ratingScopedReadQuerySchema)) query: ReadQuery,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    return this.reads.likeState(bearerToken(auth), 'comment', id, query);
  }
  @scoped('GET', 'replies/:id/like', 'GetReplyLike', ratingLikeStateSchema)
  replyLike(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(contracts.scopedId)) id: string,
    @Query(options(contracts.ratingScopedReadQuerySchema)) query: ReadQuery,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    return this.reads.likeState(bearerToken(auth), 'reply', id, query);
  }
  @scoped(
    'GET',
    'targets/:id/subscription',
    'GetSubscription',
    ratingSubscriptionStateSchema,
  )
  subscription(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(contracts.scopedId)) id: string,
    @Query(options(contracts.ratingScopedReadQuerySchema)) query: ReadQuery,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    return this.reads.subscriptionState(bearerToken(auth), id, query);
  }
  @scoped(
    'GET',
    'subscriptions',
    'ListSubscriptions',
    ratingScopedSubscriptionPageSchema,
  )
  subscriptions(
    @Headers('authorization') auth: unknown,
    @Query(options(contracts.ratingScopedPageQuerySchema)) query: PageQuery,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    return this.reads.listSubscriptions(bearerToken(auth), query);
  }
  @scoped(
    'GET',
    'random-target',
    'GetRandomTarget',
    ratingScopedRandomResponseSchema,
  )
  selectRandom(
    @Headers('authorization') auth: unknown,
    @Query(options(ratingScopedRandomQuerySchema))
    query: z.infer<typeof ratingScopedRandomQuerySchema>,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    return this.random.select(bearerToken(auth), query);
  }
  @scoped(
    'GET',
    'management/owner-edit/targets/:targetId/context',
    'GetEditContext',
    ratingScopedEditContextSchema,
  )
  editContext(
    @Headers('authorization') auth: unknown,
    @Param('targetId', new SchemaValidationPipe(contracts.scopedId)) id: string,
    @Query(options(contracts.ratingScopedReadQuerySchema)) query: ReadQuery,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    return this.commands.editContext(bearerToken(auth), id, query);
  }
  @scoped(
    'GET',
    'requests/:requestId',
    'GetRequest',
    contracts.ratingScopedReceiptSchema,
  )
  request(
    @Headers('authorization') auth: unknown,
    @Param('requestId', new SchemaValidationPipe(contracts.scopedId))
    id: string,
    @Query(options(ratingEmptySchema)) _query: Record<string, never>,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    return this.commands.status(bearerToken(auth), id);
  }
  @scoped(
    'POST',
    'subscription-states/query',
    'QuerySubscriptionStates',
    ratingSubscriptionQueryResponseSchema,
  )
  subscriptionStates(
    @Headers('authorization') auth: unknown,
    @Query(emptyQuery) _query: Record<string, never>,
    @Body(options(ratingScopedSubscriptionQuerySchema))
    body: z.infer<typeof ratingScopedSubscriptionQuerySchema>,
  ) {
    return this.reads.subscriptionStates(bearerToken(auth), body);
  }
  @scoped(
    'PUT',
    'targets/:id/my-score',
    'SetScore',
    contracts.ratingScopedReceiptSchema,
  )
  setScore(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(contracts.scopedId)) id: string,
    @Query(emptyQuery) _query: Record<string, never>,
    @Body(options(ratingScopedOperationSchema('set_score_scoped')))
    body: contracts.RatingScopedIntent,
  ) {
    return this.commands.submit(
      bearerToken(auth),
      command(body, 'set_score_scoped', id, 'targetId'),
    );
  }
  @scoped(
    'POST',
    'targets/:id/comments',
    'CreateComment',
    contracts.ratingScopedReceiptSchema,
  )
  createComment(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(contracts.scopedId)) id: string,
    @Query(emptyQuery) _query: Record<string, never>,
    @Body(options(ratingScopedOperationSchema('create_comment_scoped')))
    body: contracts.RatingScopedIntent,
  ) {
    return this.commands.submit(
      bearerToken(auth),
      command(body, 'create_comment_scoped', id, 'targetId'),
    );
  }
  @scoped(
    'POST',
    'comments/:id/replies',
    'CreateReply',
    contracts.ratingScopedReceiptSchema,
  )
  createReply(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(contracts.scopedId)) id: string,
    @Query(emptyQuery) _query: Record<string, never>,
    @Body(options(ratingScopedOperationSchema('create_reply_scoped')))
    body: contracts.RatingScopedIntent,
  ) {
    return this.commands.submit(
      bearerToken(auth),
      command(body, 'create_reply_scoped', id, 'rootId'),
    );
  }
  @scoped(
    'PUT',
    'comments/:id/like',
    'SetCommentLike',
    contracts.ratingScopedReceiptSchema,
  )
  setCommentLike(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(contracts.scopedId)) id: string,
    @Query(emptyQuery) _query: Record<string, never>,
    @Body(options(ratingScopedOperationSchema('set_comment_like_scoped')))
    body: contracts.RatingScopedIntent,
  ) {
    return this.commands.submit(
      bearerToken(auth),
      command(body, 'set_comment_like_scoped', id, 'rootId'),
    );
  }
  @scoped(
    'PUT',
    'replies/:id/like',
    'SetReplyLike',
    contracts.ratingScopedReceiptSchema,
  )
  setReplyLike(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(contracts.scopedId)) id: string,
    @Query(emptyQuery) _query: Record<string, never>,
    @Body(options(ratingScopedOperationSchema('set_reply_like_scoped')))
    body: contracts.RatingScopedIntent,
  ) {
    return this.commands.submit(
      bearerToken(auth),
      command(body, 'set_reply_like_scoped', id, 'replyId'),
    );
  }
  @scoped(
    'PUT',
    'targets/:id/subscription',
    'SetSubscription',
    contracts.ratingScopedReceiptSchema,
  )
  setSubscription(
    @Headers('authorization') auth: unknown,
    @Param('id', new SchemaValidationPipe(contracts.scopedId)) id: string,
    @Query(emptyQuery) _query: Record<string, never>,
    @Body(
      options(ratingScopedOperationSchema('set_target_subscription_scoped')),
    )
    body: contracts.RatingScopedIntent,
  ) {
    return this.commands.submit(
      bearerToken(auth),
      command(body, 'set_target_subscription_scoped', id, 'targetId'),
    );
  }
  @scoped(
    'POST',
    'management/prepare',
    'PrepareTarget',
    ratingScopedPrepareResponseSchema,
  )
  prepareTarget(
    @Headers('authorization') auth: unknown,
    @Query(emptyQuery) _query: Record<string, never>,
    @Body(options(ratingScopedOperationSchema('create_target_scoped')))
    body: contracts.RatingScopedIntent,
  ) {
    return this.commands.prepare(
      bearerToken(auth),
      command(body, 'create_target_scoped'),
    );
  }
  @scoped(
    'POST',
    'management/targets',
    'CreateTarget',
    contracts.ratingScopedReceiptSchema,
  )
  createTarget(
    @Headers('authorization') auth: unknown,
    @Query(emptyQuery) _query: Record<string, never>,
    @Body(
      options(
        ratingScopedCommitSchema.refine(
          (value) => value.operation === 'create_target_scoped',
        ),
      ),
    )
    body: z.infer<typeof ratingScopedCommitSchema>,
  ) {
    const { preparationContextRevision, ...intent } =
      ratingScopedCommitSchema.parse(body);
    return this.commands.submit(
      bearerToken(auth),
      command(intent, 'create_target_scoped'),
      preparationContextRevision,
    );
  }
  @scoped(
    'POST',
    'management/cancel',
    'CancelTargetCreation',
    contracts.ratingScopedReceiptSchema,
  )
  cancelTarget(
    @Headers('authorization') auth: unknown,
    @Query(emptyQuery) _query: Record<string, never>,
    @Body(options(ratingScopedOperationSchema('create_target_scoped')))
    body: contracts.RatingScopedIntent,
  ) {
    return this.commands.cancel(
      bearerToken(auth),
      command(body, 'create_target_scoped'),
    );
  }
  @scoped(
    'POST',
    'management/owner-edit/prepare',
    'PrepareTargetEdit',
    ratingScopedPrepareResponseSchema,
  )
  prepareEdit(
    @Headers('authorization') auth: unknown,
    @Query(emptyQuery) _query: Record<string, never>,
    @Body(options(ratingScopedOperationSchema('edit_target_scoped')))
    body: contracts.RatingScopedIntent,
  ) {
    return this.commands.prepare(
      bearerToken(auth),
      command(body, 'edit_target_scoped'),
    );
  }
  @scoped(
    'POST',
    'management/owner-edit/commit',
    'CommitTargetEdit',
    contracts.ratingScopedReceiptSchema,
  )
  commitEdit(
    @Headers('authorization') auth: unknown,
    @Query(emptyQuery) _query: Record<string, never>,
    @Body(
      options(
        ratingScopedCommitSchema.refine(
          (value) => value.operation === 'edit_target_scoped',
        ),
      ),
    )
    body: z.infer<typeof ratingScopedCommitSchema>,
  ) {
    const { preparationContextRevision, ...intent } =
      ratingScopedCommitSchema.parse(body);
    return this.commands.submit(
      bearerToken(auth),
      command(intent, 'edit_target_scoped'),
      preparationContextRevision,
    );
  }
  @scoped(
    'POST',
    'management/owner-edit/cancel',
    'CancelTargetEdit',
    contracts.ratingScopedReceiptSchema,
  )
  cancelEdit(
    @Headers('authorization') auth: unknown,
    @Query(emptyQuery) _query: Record<string, never>,
    @Body(options(ratingScopedOperationSchema('edit_target_scoped')))
    body: contracts.RatingScopedIntent,
  ) {
    return this.commands.cancel(
      bearerToken(auth),
      command(body, 'edit_target_scoped'),
    );
  }
}

@ApiTags('Scoped rating updates')
@ApiBearerAuth('accessToken')
@RatingResponses()
@UseGuards(RatingRequestGuard)
@Controller('v2/me/ratings')
export class RatingScopedNoticesController {
  constructor(
    @Inject(RatingScopedNoticeService)
    private readonly notices: RatingScopedNoticeService,
  ) {}
  @scoped('GET', 'updates', 'ListUpdates', ratingScopedNoticePageSchema)
  updates(
    @Headers('authorization') auth: unknown,
    @Query(options(ratingScopedNoticeQuerySchema))
    query: z.infer<typeof ratingScopedNoticeQuerySchema>,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    return this.notices.list(bearerToken(auth), 'updates', query);
  }
  @scoped(
    'GET',
    'updates/:noticeId/target',
    'ResolveUpdateTarget',
    ratingScopedNoticeTargetSchema,
  )
  updatesTarget(
    @Headers('authorization') auth: unknown,
    @Param('noticeId', new SchemaValidationPipe(contracts.scopedId)) id: string,
    @Query(options(contracts.ratingScopedReadQuerySchema)) query: ReadQuery,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    return this.notices.target(bearerToken(auth), 'updates', id, query);
  }
  @scoped(
    'GET',
    'like-updates',
    'ListLikeUpdates',
    ratingScopedNoticePageSchema,
  )
  likeUpdates(
    @Headers('authorization') auth: unknown,
    @Query(options(ratingScopedNoticeQuerySchema))
    query: z.infer<typeof ratingScopedNoticeQuerySchema>,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    return this.notices.list(bearerToken(auth), 'like-updates', query);
  }
  @scoped(
    'GET',
    'like-updates/:noticeId/target',
    'ResolveLikeUpdateTarget',
    ratingScopedNoticeTargetSchema,
  )
  likeUpdatesTarget(
    @Headers('authorization') auth: unknown,
    @Param('noticeId', new SchemaValidationPipe(contracts.scopedId)) id: string,
    @Query(options(contracts.ratingScopedReadQuerySchema)) query: ReadQuery,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    return this.notices.target(bearerToken(auth), 'like-updates', id, query);
  }
  @scoped(
    'GET',
    'subscription-updates',
    'ListSubscriptionUpdates',
    ratingScopedNoticePageSchema,
  )
  subscriptionUpdates(
    @Headers('authorization') auth: unknown,
    @Query(options(ratingScopedNoticeQuerySchema))
    query: z.infer<typeof ratingScopedNoticeQuerySchema>,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    return this.notices.list(bearerToken(auth), 'subscription-updates', query);
  }
  @scoped(
    'GET',
    'subscription-updates/:noticeId/target',
    'ResolveSubscriptionUpdateTarget',
    ratingScopedNoticeTargetSchema,
  )
  subscriptionUpdatesTarget(
    @Headers('authorization') auth: unknown,
    @Param('noticeId', new SchemaValidationPipe(contracts.scopedId)) id: string,
    @Query(options(contracts.ratingScopedReadQuerySchema)) query: ReadQuery,
    @Body(new SchemaValidationPipe(emptyBody)) _body: unknown,
  ) {
    return this.notices.target(
      bearerToken(auth),
      'subscription-updates',
      id,
      query,
    );
  }
}
