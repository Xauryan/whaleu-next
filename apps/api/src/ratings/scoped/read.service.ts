import { requireTargetCoverRead } from './target-cover-capability.js';
import { currentRatingTargetCoverDescriptor } from '../target-cover-current.js';
import { ratingsMediaDescriptorSchema } from '../../media/contracts-ratings.js';
import { Inject, Injectable } from '@nestjs/common';
import { z, ZodError } from 'zod';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.js';
import { ApplicationError } from '../../http/application-error.js';
import { RatingSafetyFacade } from '../../safety/rating.facade.js';
import { RatingContentReviewFacade } from '../../community/content-review/rating-content-review.facade.js';
import { RatingsAccessService } from '../access.js';
import { RatingsRepository } from '../repository.js';
import { RatingsCursors, ratingCursorScope } from '../cursor.js';
import { RatingDiscussionRepository } from '../discussion-repository.js';
import { RatingRootOrderRepository } from '../like-order-repository.js';
import { RatingRootOrderCursors } from '../like-order-cursor.js';
import { RatingLikesRepository } from '../likes/repository.js';
import { RatingSubscriptionsRepository } from '../subscriptions/repository.js';
import { ratingLikeStateSchema } from '../likes/contracts.js';
import {
  ratingSubscriptionStateSchema,
  ratingSubscriptionQueryResponseSchema,
} from '../subscriptions/contracts.js';
import {
  ratingCategorySchema,
  ratingTargetSchema,
  ratingCommentSchema,
  ratingMyScoreSchema,
  ratingSummarySchema,
  ratingCursorSchema,
  ratingPublicIdSchema,
} from '../contracts.js';
import { ratingReplySchema } from '../discussion-contracts.js';
import type { RatingComment } from '../contracts.js';
import type { RatingReply } from '../discussion-contracts.js';
import { RatingScopedContextService } from './context.service.js';
import type { ResolvedRatingScope } from './context.service.js';
import { RatingScopedRepository } from './repository.js';
import { RatingScopedProjection } from './projection.js';
import type { RatingScopedProjectionActor } from './projection.js';
import {
  ratingNavigationSelectorSchema,
  ratingScopedReadQuerySchema,
  ratingScopedPageQuerySchema,
  ratingScopedCategoryQuerySchema,
  ratingScopedTargetQuerySchema,
  ratingScopedCommentQuerySchema,
} from './contracts.js';

type ReadQuery = z.infer<typeof ratingScopedReadQuerySchema>;
type PageQuery = z.infer<typeof ratingScopedPageQuerySchema>;
type CategoryQuery = z.infer<typeof ratingScopedCategoryQuerySchema>;
type TargetQuery = z.infer<typeof ratingScopedTargetQuerySchema>;
type CommentQuery = z.infer<typeof ratingScopedCommentQuerySchema>;
const pageFields = {
  nextCursor: ratingCursorSchema.nullable(),
  continuation: z.enum(['more', 'scan', 'end']),
};
const completePage = (p: {
  items: readonly { id: string }[];
  nextCursor: string | null;
  continuation: string;
}) =>
  (p.nextCursor === null) === (p.continuation === 'end') &&
  new Set(p.items.map((i) => i.id)).size === p.items.length;
export const ratingScopedPageContextSchema = z.strictObject({
  contextId: ratingPublicIdSchema,
  selector: ratingNavigationSelectorSchema,
  catalogRevision: ratingPublicIdSchema,
  protocolGeneration: ratingPublicIdSchema,
});
export const ratingScopedCategoryPageSchema = z
  .strictObject({
    context: ratingScopedPageContextSchema.extend({
      parentId: ratingPublicIdSchema.nullable(),
    }),
    items: z.array(ratingCategorySchema).max(50),
    ...pageFields,
  })
  .refine(
    (p) =>
      completePage(p) &&
      p.items.every((i) => i.parentId === p.context.parentId),
  );
export const ratingScopedTargetPageSchema = z
  .strictObject({
    context: ratingScopedPageContextSchema.extend({
      categoryId: ratingPublicIdSchema,
    }),
    items: z.array(ratingTargetSchema).max(50),
    ...pageFields,
  })
  .refine(
    (p) =>
      completePage(p) &&
      p.items.every((i) => i.categoryId === p.context.categoryId),
  );
export const ratingScopedCommentPageSchema = z
  .strictObject({
    context: ratingScopedPageContextSchema.extend({
      targetId: ratingPublicIdSchema,
    }),
    items: z.array(ratingCommentSchema).max(50),
    ...pageFields,
  })
  .refine(
    (p) =>
      completePage(p) &&
      p.items.every((i) => i.targetId === p.context.targetId),
  );
const discussionContext = ratingScopedPageContextSchema.extend({
  targetId: ratingPublicIdSchema,
  rootId: ratingPublicIdSchema,
});
export const ratingScopedDiscussionSchema = z
  .strictObject({
    context: discussionContext,
    root: ratingCommentSchema,
    allowedActions: z.strictObject({
      createReply: z.boolean(),
      authorModes: z
        .array(z.enum(['named', 'anonymous']))
        .min(1)
        .max(2)
        .refine((v) => v[0] === 'named' && new Set(v).size === v.length),
    }),
  })
  .refine(
    (v) =>
      v.root.id === v.context.rootId && v.root.targetId === v.context.targetId,
  );
const replyContext = discussionContext.extend({ order: z.literal('oldest') });
export const ratingScopedReplyPageSchema = z
  .strictObject({
    context: replyContext,
    items: z.array(ratingReplySchema).max(50),
    ...pageFields,
  })
  .refine(
    (p) =>
      completePage(p) &&
      p.items.every(
        (i) =>
          i.targetId === p.context.targetId && i.rootId === p.context.rootId,
      ),
  );
export const ratingScopedReplyPositionSchema = z
  .strictObject({
    context: replyContext,
    anchorReplyId: ratingPublicIdSchema,
    page: ratingScopedReplyPageSchema,
  })
  .refine(
    (p) =>
      JSON.stringify(p.context) === JSON.stringify(p.page.context) &&
      p.page.items[0]?.id === p.anchorReplyId,
  );
export const ratingScopedSubscriptionPageSchema = z
  .strictObject({
    context: ratingScopedPageContextSchema,
    items: z.array(ratingTargetSchema).max(50),
    ...pageFields,
  })
  .refine(completePage);
export const ratingScopedSubscriptionQuerySchema =
  ratingScopedReadQuerySchema.extend({
    targets: z
      .array(
        z.strictObject({
          targetId: ratingPublicIdSchema,
          expectedTargetRevision: ratingPublicIdSchema,
        }),
      )
      .min(1)
      .max(20)
      .refine((v) => new Set(v.map((i) => i.targetId)).size === v.length),
  });
function notFound(error: unknown): boolean {
  return error instanceof ApplicationError && error.code === 'RATING_NOT_FOUND';
}

/** v2 selects a resolved scope once and then calls the same owner read kernels.
 * No selected campus is converted into a v1 region request or shadow catalog. */
@Injectable()
export class RatingScopedReadService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(RatingScopedContextService)
    private readonly contexts: RatingScopedContextService,
    @Inject(RatingScopedRepository)
    private readonly scoped: RatingScopedRepository,
    @Inject(RatingsRepository) private readonly records: RatingsRepository,
    @Inject(RatingsAccessService) private readonly access: RatingsAccessService,
    @Inject(RatingScopedProjection)
    private readonly projection: RatingScopedProjection,
    @Inject(RatingDiscussionRepository)
    private readonly replies: RatingDiscussionRepository,
    @Inject(RatingsCursors) private readonly cursors: RatingsCursors,
    @Inject(RatingRootOrderRepository)
    private readonly rootOrder: RatingRootOrderRepository,
    @Inject(RatingRootOrderCursors)
    private readonly orderCursors: RatingRootOrderCursors,
    @Inject(RatingSafetyFacade) private readonly safety: RatingSafetyFacade,
    @Inject(RatingContentReviewFacade)
    private readonly review: RatingContentReviewFacade,
    @Inject(RatingLikesRepository)
    private readonly likes: RatingLikesRepository,
    @Inject(RatingSubscriptionsRepository)
    private readonly subscriptions: RatingSubscriptionsRepository,
  ) {}
  private async run<T>(
    token: string,
    query: ReadQuery,
    operation: (scope: ResolvedRatingScope, tx: PoolClient) => Promise<T>,
    protocolVersion: 2 | 3 = 2,
  ): Promise<T> {
    try {
      return await this.database.transaction(
        async (tx) => {
          this.records.enable(tx);
          this.scoped.enable(tx);
          const scope = await this.contexts.resolve(
            token,
            { contextId: query.contextId, contextToken: query.contextToken },
            tx,
            { purpose: 'read', protocolVersion },
          );
          const result = await operation(scope, tx);
          await this.access.recheck(token, tx);
          await this.scoped.retainAfter(scope, tx);
          return result;
        },
        { isolationLevel: 'read committed' },
      );
    } catch (error) {
      if (error instanceof ZodError)
        throw new ApplicationError('RATING_UNAVAILABLE');
      throw error;
    }
  }
  private actor(scope: ResolvedRatingScope): RatingScopedProjectionActor {
    return { accountId: scope.actor, mode: scope.context.mode };
  }
  private pageContext(scope: ResolvedRatingScope) {
    return ratingScopedPageContextSchema.parse({
      contextId: scope.contextId,
      selector: scope.selector,
      catalogRevision: scope.catalogRevision,
      protocolGeneration: scope.protocolGeneration,
    });
  }
  private async cursorScope(
    scope: ResolvedRatingScope,
    kind: string,
    filter: unknown,
    tx: PoolClient,
    extra: readonly unknown[] = [],
  ) {
    return ratingCursorScope([
      'ratings-scoped',
      2,
      kind,
      scope.contextId,
      scope.actor,
      scope.session.sessionId,
      scope.context.sessionGeneration,
      scope.context.purpose,
      scope.context.mode,
      scope.selector,
      scope.catalogRevision,
      scope.headRevision,
      scope.scopeRevision,
      scope.sourceDigest,
      scope.protocolGeneration,
      filter,
      await this.safety.navigation(tx),
      await this.review.navigation(tx),
      await this.records.navigation(tx),
      await this.scoped.navigation(tx),
      ...extra,
    ]);
  }
  private async targetRow(
    scope: ResolvedRatingScope,
    id: string,
    tx: PoolClient,
  ) {
    const target = await this.scoped.target(scope, id, tx);
    await this.projection.qualifyTarget(target.row, tx);
    return target;
  }
  categories(token: string, query: CategoryQuery) {
    return this.run(token, query, async (scope, tx) => {
      const parentId = query.parentId ?? null;
      if (parentId) await this.scoped.category(scope, parentId, tx);
      const cursorScope = await this.cursorScope(
        scope,
        'categories',
        { parentId, limit: query.limit },
        tx,
      );
      const after = query.cursor
        ? await this.cursors.get(query.cursor, cursorScope, tx)
        : null;
      const rows = await this.scoped.categories(
          scope,
          parentId,
          after,
          query.limit,
          tx,
        ),
        more = rows.length > query.limit,
        chosen = rows.slice(0, query.limit);
      const nextCursor = more
        ? await this.cursors.create(
            scope.actor,
            cursorScope,
            chosen.at(-1)!.ordinal,
            tx,
          )
        : null;
      return ratingScopedCategoryPageSchema.parse({
        context: { ...this.pageContext(scope), parentId },
        items: chosen.map((r) => ({
          id: r.id,
          parentId: r.parent_id,
          level: r.level,
          kind: r.kind,
          systemKey: r.system_key,
          name: r.name,
          description: r.description,
          revision: r.revision,
        })),
        nextCursor,
        continuation: more ? 'more' : 'end',
      });
    });
  }
  targets(token: string, query: TargetQuery, includeCover = false) {
    return this.run(
      token,
      query,
      async (scope, tx) => {
        await this.scoped.category(scope, query.categoryId, tx);
        const cursorScope = await this.cursorScope(
          scope,
          'targets',
          { categoryId: query.categoryId, limit: query.limit },
          tx,
        );
        const after = query.cursor
          ? await this.cursors.get(query.cursor, cursorScope, tx)
          : null;
        const rows = await this.scoped.targets(
            scope,
            query.categoryId,
            after,
            query.limit,
            tx,
          ),
          more = rows.length > query.limit,
          chosen = rows.slice(0, query.limit),
          items = [];
        const qualified = await this.scoped.currentTargetBatch(
          scope,
          chosen.map((c) => c.id),
          tx,
        );
        for (const candidate of chosen) {
          try {
            const row = qualified.get(candidate.id);
            if (!row) continue;
            requireTargetCoverRead(scope, row.definition);
            const target = await this.projection.target(
              row,
              this.actor(scope),
              tx,
            );
            const cover = includeCover
              ? currentRatingTargetCoverDescriptor(
                  row.definition,
                  {
                    contextId: query.contextId,
                    contextToken: query.contextToken,
                  },
                  tx,
                )
              : null;
            items.push(includeCover ? { ...target, cover } : target);
          } catch (error) {
            if (!notFound(error)) throw error;
          }
        }
        const nextCursor = more
          ? await this.cursors.create(
              scope.actor,
              cursorScope,
              chosen.at(-1)!.ordinal,
              tx,
            )
          : null;
        const result = {
          context: { ...this.pageContext(scope), categoryId: query.categoryId },
          items,
          nextCursor,
          continuation: more ? (items.length ? 'more' : 'scan') : 'end',
        };
        return includeCover
          ? ratingScopedTargetPageSchema
              .safeExtend({
                items: z
                  .array(
                    ratingTargetSchema.extend({
                      cover: ratingsMediaDescriptorSchema.nullable(),
                    }),
                  )
                  .max(50),
              })
              .parse(result)
          : ratingScopedTargetPageSchema.parse(result);
      },
      includeCover ? 3 : 2,
    );
  }
  target(token: string, id: string, query: ReadQuery, includeCover = false) {
    return this.run(
      token,
      query,
      async (scope, tx) => {
        const row = (await this.targetRow(scope, id, tx)).row;
        requireTargetCoverRead(scope, row.definition);
        const target = await this.projection.target(row, this.actor(scope), tx);
        if (!includeCover) return target;
        const cover = currentRatingTargetCoverDescriptor(
          row.definition,
          { contextId: query.contextId, contextToken: query.contextToken },
          tx,
        );
        return { context: this.pageContext(scope), target, cover };
      },
      includeCover ? 3 : 2,
    );
  }
  myScore(token: string, id: string, query: ReadQuery) {
    return this.run(token, query, async (scope, tx) => {
      await this.targetRow(scope, id, tx);
      return ratingMyScoreSchema.parse(
        await this.records.myScore(id, scope.actor, tx),
      );
    });
  }
  summary(token: string, id: string, query: ReadQuery) {
    return this.run(token, query, async (scope, tx) => {
      await this.targetRow(scope, id, tx);
      return ratingSummarySchema.parse(await this.records.summary(id, tx));
    });
  }
  comments(token: string, id: string, query: CommentQuery) {
    return this.run(token, query, async (scope, tx) => {
      const target = await this.targetRow(scope, id, tx),
        sort = query.sort ?? 'time',
        order = query.order ?? 'desc';
      const orderHead = await this.rootOrder.head(id, sort, tx);
      const cursorScope = await this.cursorScope(
        scope,
        'comments',
        {
          targetId: id,
          targetRevision: target.row.revision,
          sort,
          order,
          limit: query.limit,
        },
        tx,
        orderHead,
      );
      const after = query.cursor
        ? await this.orderCursors.get(
            query.cursor,
            cursorScope,
            sort,
            order,
            tx,
          )
        : null;
      const rows = await this.rootOrder.page(
          id,
          sort,
          order,
          after,
          query.limit,
          tx,
        ),
        more = rows.length > query.limit,
        chosen = rows.slice(0, query.limit),
        items: RatingComment[] = [];
      for (const candidate of chosen) {
        const row = await this.records.comment(candidate.id, id, tx);
        const item = await this.projection.root(
          row,
          this.actor(scope),
          'rating_list',
          tx,
        );
        if (item) items.push(item);
      }
      const last = chosen.at(-1);
      const nextCursor = more
        ? await this.orderCursors.create(
            scope.actor,
            cursorScope,
            sort,
            order,
            {
              createdMicros: last!.createdMicros,
              ordinal: last!.ordinal,
              count: last!.count,
            },
            tx,
          )
        : null;
      return ratingScopedCommentPageSchema.parse({
        context: { ...this.pageContext(scope), targetId: id },
        items,
        nextCursor,
        continuation: more ? (items.length ? 'more' : 'scan') : 'end',
      });
    });
  }
  private async chain(
    scope: ResolvedRatingScope,
    rootId: string,
    tx: PoolClient,
    targetId?: string,
  ) {
    const id = targetId ?? (await this.records.commentTarget(rootId, tx)),
      target = await this.targetRow(scope, id, tx);
    const root = await this.records.comment(rootId, id, tx),
      rootView = await this.projection.root(
        root,
        this.actor(scope),
        'rating_list',
        tx,
      );
    if (!rootView) throw new ApplicationError('RATING_NOT_FOUND');
    const rootCanReply = await this.projection.canReply(
      root,
      this.actor(scope),
      tx,
    );
    return { target, root, rootView, rootCanReply };
  }
  comment(token: string, id: string, query: ReadQuery) {
    return this.run(token, query, async (scope, tx) => {
      const targetId = await this.records.commentTarget(id, tx);
      await this.targetRow(scope, targetId, tx);
      const row = await this.records.comment(id, targetId, tx),
        result = await this.projection.root(
          row,
          this.actor(scope),
          'rating_direct',
          tx,
        );
      if (!result) throw new ApplicationError('RATING_NOT_FOUND');
      return result;
    });
  }
  thread(token: string, rootId: string, query: ReadQuery) {
    return this.run(token, query, async (scope, tx) => {
      const chain = await this.chain(scope, rootId, tx);
      return ratingScopedDiscussionSchema.parse({
        context: {
          ...this.pageContext(scope),
          targetId: chain.target.row.id,
          rootId,
        },
        root: chain.rootView,
        allowedActions: {
          createReply: chain.rootCanReply && scope.context.mode === 'public',
          authorModes: await this.access.authorModes(scope.actor, tx),
        },
      });
    });
  }
  private async replyPage(
    scope: ResolvedRatingScope,
    rootId: string,
    query: PageQuery,
    tx: PoolClient,
    anchorId?: string,
  ) {
    const chain = await this.chain(scope, rootId, tx),
      targetId = chain.target.row.id;
    const cursorScope = await this.cursorScope(
      scope,
      'replies',
      {
        targetId,
        targetRevision: chain.target.row.revision,
        rootId,
        rootRevision: chain.root.revision,
        order: 'oldest',
        limit: query.limit,
      },
      tx,
      [await this.replies.navigation(rootId, tx)],
    );
    let after = query.cursor
      ? await this.cursors.get(query.cursor, cursorScope, tx)
      : null;
    if (anchorId) {
      if (!chain.rootCanReply) throw new ApplicationError('RATING_NOT_FOUND');
      const anchor = await this.replies.reply(anchorId, rootId, targetId, tx);
      if (
        !(await this.projection.reply(
          anchor,
          this.actor(scope),
          chain.rootCanReply,
          'rating_direct',
          tx,
        ))
      )
        throw new ApplicationError('RATING_NOT_FOUND');
      after = anchor.ordinal;
    }
    const rows = await this.replies.page(
        rootId,
        targetId,
        after,
        query.limit,
        tx,
        !!anchorId,
      ),
      more = rows.length > query.limit,
      chosen = rows.slice(0, query.limit),
      items: RatingReply[] = [];
    for (const candidate of chosen) {
      const row = await this.replies.reply(candidate.id, rootId, targetId, tx),
        item = await this.projection.reply(
          row,
          this.actor(scope),
          chain.rootCanReply,
          'rating_list',
          tx,
        );
      if (item) items.push(item);
    }
    const nextCursor = more
      ? await this.cursors.create(
          scope.actor,
          cursorScope,
          chosen.at(-1)!.ordinal,
          tx,
        )
      : null;
    return ratingScopedReplyPageSchema.parse({
      context: {
        ...this.pageContext(scope),
        targetId,
        rootId,
        order: 'oldest',
      },
      items,
      nextCursor,
      continuation: more ? (items.length ? 'more' : 'scan') : 'end',
    });
  }
  listReplies(token: string, rootId: string, query: PageQuery) {
    return this.run(token, query, (scope, tx) =>
      this.replyPage(scope, rootId, query, tx),
    );
  }
  reply(token: string, id: string, query: ReadQuery) {
    return this.run(token, query, async (scope, tx) => {
      const hint = await this.replies.ancestry(id, tx),
        chain = await this.chain(scope, hint.root_id, tx, hint.target_id);
      if (!chain.rootCanReply) throw new ApplicationError('RATING_NOT_FOUND');
      const row = await this.replies.reply(
          id,
          hint.root_id,
          hint.target_id,
          tx,
        ),
        result = await this.projection.reply(
          row,
          this.actor(scope),
          chain.rootCanReply,
          'rating_direct',
          tx,
        );
      if (!result) throw new ApplicationError('RATING_NOT_FOUND');
      return result;
    });
  }
  locateReply(token: string, id: string, query: Omit<PageQuery, 'cursor'>) {
    return this.run(token, query, async (scope, tx) => {
      const hint = await this.replies.ancestry(id, tx),
        page = await this.replyPage(scope, hint.root_id, query, tx, id);
      return ratingScopedReplyPositionSchema.parse({
        context: page.context,
        anchorReplyId: id,
        page,
      });
    });
  }
  likeState(
    token: string,
    kind: 'comment' | 'reply',
    id: string,
    query: ReadQuery,
  ) {
    return this.run(token, query, async (scope, tx) => {
      const hint =
        kind === 'reply'
          ? await this.replies.ancestry(id, tx)
          : {
              root_id: id,
              target_id: await this.records.commentTarget(id, tx),
            };
      const chain = await this.chain(scope, hint.root_id, tx, hint.target_id);
      if (
        !(await this.projection.content(
          chain.root,
          'comment',
          this.actor(scope),
          'rating_direct',
          tx,
        ))
      )
        throw new ApplicationError('RATING_NOT_FOUND');
      if (kind === 'reply') {
        const row = await this.replies.reply(
          id,
          hint.root_id,
          hint.target_id,
          tx,
        );
        // A quoted reply-to is not an ancestor of the liked subject.
        if (
          !(await this.projection.content(
            row,
            'reply',
            this.actor(scope),
            'rating_direct',
            tx,
          ))
        )
          throw new ApplicationError('RATING_NOT_FOUND');
      }
      if (scope.context.mode === 'admin_preview')
        return ratingLikeStateSchema.parse({ status: 'unavailable' });
      const state = await this.likes.state(id, scope.actor, tx);
      if (state) this.likes.retain(state, scope.actor, tx);
      return ratingLikeStateSchema.parse(
        state
          ? {
              status: 'known',
              targetId: hint.target_id,
              rootId: hint.root_id,
              replyId: kind === 'reply' ? id : null,
              count: state.count,
              liked: state.liked,
              revision: state.revision,
              allowedActions: { setLike: true },
            }
          : { status: 'unavailable' },
      );
    });
  }
  private async subscriptionView(
    scope: ResolvedRatingScope,
    id: string,
    tx: PoolClient,
  ) {
    if (scope.context.mode === 'admin_preview')
      return ratingSubscriptionStateSchema.parse({ status: 'unavailable' });
    const state = await this.subscriptions.state(id, scope.actor, tx);
    this.subscriptions.retain(id, state, scope.actor, tx);
    return ratingSubscriptionStateSchema.parse(
      state
        ? {
            status: 'known',
            targetId: id,
            subscribed: state.subscribed,
            count: state.count,
            revision: state.revision,
            allowedActions: { setSubscription: true },
          }
        : { status: 'unavailable' },
    );
  }
  subscriptionState(token: string, id: string, query: ReadQuery) {
    return this.run(token, query, async (scope, tx) => {
      await this.targetRow(scope, id, tx);
      return this.subscriptionView(scope, id, tx);
    });
  }
  subscriptionStates(
    token: string,
    command: z.infer<typeof ratingScopedSubscriptionQuerySchema>,
  ) {
    return this.run(token, command, async (scope, tx) => {
      const states = new Map<
        string,
        z.infer<typeof ratingSubscriptionStateSchema>
      >();
      for (const item of [...command.targets].sort((a, b) =>
        a.targetId.localeCompare(b.targetId),
      )) {
        try {
          const target = await this.targetRow(scope, item.targetId, tx);
          states.set(
            item.targetId,
            target.row.revision === item.expectedTargetRevision
              ? await this.subscriptionView(scope, item.targetId, tx)
              : { status: 'unavailable' },
          );
        } catch (error) {
          if (!notFound(error)) throw error;
          states.set(item.targetId, { status: 'unavailable' });
        }
      }
      return ratingSubscriptionQueryResponseSchema.parse({
        items: command.targets.map((item) => ({
          targetId: item.targetId,
          state: states.get(item.targetId)!,
        })),
      });
    });
  }
  listSubscriptions(token: string, query: PageQuery, includeCover = false) {
    return this.run(
      token,
      query,
      async (scope, tx) => {
        const cursorScope = await this.cursorScope(
            scope,
            'subscriptions',
            { limit: query.limit },
            tx,
            [await this.scoped.subscriptionNavigation(scope, tx)],
          ),
          after = query.cursor
            ? await this.cursors.get(query.cursor, cursorScope, tx)
            : null;
        const rows = await this.scoped.subscriptions(
            scope,
            after,
            query.limit,
            tx,
          ),
          more = rows.length > query.limit,
          chosen = rows.slice(0, query.limit),
          items = [];
        const qualified = await this.scoped.currentTargetBatch(
          scope,
          chosen.map((c) => c.id),
          tx,
        );
        for (const candidate of chosen) {
          try {
            const row = qualified.get(candidate.id);
            if (!row) continue;
            requireTargetCoverRead(scope, row.definition);
            const target = await this.projection.target(
              row,
              this.actor(scope),
              tx,
            );
            items.push(
              includeCover
                ? {
                    ...target,
                    cover: currentRatingTargetCoverDescriptor(
                      row.definition,
                      {
                        contextId: query.contextId,
                        contextToken: query.contextToken,
                      },
                      tx,
                    ),
                  }
                : target,
            );
          } catch (error) {
            if (!notFound(error)) throw error;
          }
        }
        const nextCursor = more
          ? await this.cursors.create(
              scope.actor,
              cursorScope,
              chosen.at(-1)!.ordinal,
              tx,
            )
          : null;
        return (
          includeCover
            ? ratingScopedSubscriptionPageSchema.safeExtend({
                items: z
                  .array(
                    ratingTargetSchema.extend({
                      cover: ratingsMediaDescriptorSchema.nullable(),
                    }),
                  )
                  .max(50),
              })
            : ratingScopedSubscriptionPageSchema
        ).parse({
          context: this.pageContext(scope),
          items,
          nextCursor,
          continuation: more ? (items.length ? 'more' : 'scan') : 'end',
        });
      },
      includeCover ? 3 : 2,
    );
  }
}
