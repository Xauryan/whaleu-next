import { RatingDeletionRepository } from './deletion/repository.js';
import { RatingRootOrderCursors } from './like-order-cursor.js';
import { RatingRootOrderRepository } from './like-order-repository.js';
import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { ZodError } from 'zod';
import { DatabaseService } from '../database/database.js';
import { ApplicationError } from '../http/application-error.js';
import { RatingContentReviewFacade } from '../community/content-review/rating-content-review.facade.js';
import { canonicalRatingEnvelope } from '../community/content-review/rating-contracts.js';
import { RatingSafetyFacade } from '../safety/rating.facade.js';
import { AuthorDisplayService } from '../profile/author-display.service.js';
import { RatingsAccessService } from './access.js';
import { RatingsRepository } from './repository.js';
import type {
  RatingCatalog,
  TargetRow,
  CategoryRow,
  CommentRow,
} from './repository.js';
import { RatingEffectsCapture } from './effects/capture.js';
import { RatingsRequests } from './requests.js';
import { RatingsCursors, ratingCursorScope } from './cursor.js';
import {
  ratingCategoryPageSchema,
  ratingTargetPageSchema,
  ratingCommentPageSchema,
  ratingTargetSchema,
  ratingCommentSchema,
  ratingMyScoreSchema,
  ratingContextSchema,
} from './contracts.js';
import type {
  RatingCategoryQuery,
  RatingTargetQuery,
  RatingCommentQuery,
  SetRatingScore,
  CreateRatingComment,
  DeleteRatingComment,
  RatingComment,
} from './contracts.js';
@Injectable()
export class RatingsService {
  constructor(
    @Inject(RatingRootOrderCursors)
    private readonly orderCursors: RatingRootOrderCursors,
    @Inject(RatingRootOrderRepository)
    private readonly rootOrder: RatingRootOrderRepository,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(RatingsAccessService) private readonly access: RatingsAccessService,
    @Inject(RatingsRepository) private readonly records: RatingsRepository,
    @Inject(RatingDeletionRepository)
    private readonly deletion: RatingDeletionRepository,
    @Inject(RatingsRequests) private readonly requests: RatingsRequests,
    @Inject(RatingsCursors) private readonly cursors: RatingsCursors,
    @Inject(RatingContentReviewFacade)
    private readonly review: RatingContentReviewFacade,
    @Inject(RatingSafetyFacade) private readonly safety: RatingSafetyFacade,
    @Inject(AuthorDisplayService)
    private readonly authors: AuthorDisplayService,
    @Inject(RatingEffectsCapture)
    private readonly effects: RatingEffectsCapture,
  ) {}
  private async run<T>(operation: (tx: PoolClient) => Promise<T>): Promise<T> {
    try {
      return await this.database.transaction(
        async (tx) => {
          this.records.enable(tx);
          return operation(tx);
        },
        { isolationLevel: 'read committed' },
      );
    } catch (error) {
      if (error instanceof ZodError)
        throw new ApplicationError('RATING_UNAVAILABLE');
      throw error;
    }
  }
  context(token: string) {
    return this.run(async (tx) =>
      ratingContextSchema.parse(await this.access.context(token, tx)),
    );
  }
  private async currentTarget(
    catalog: RatingCatalog,
    id: string,
    tx: PoolClient,
    write = false,
  ) {
    const result = await this.records.target(catalog, id, tx, write),
      decision = await this.review.current(
        'target',
        id,
        canonicalRatingEnvelope(result.row.envelope),
        tx,
      );
    if (decision.kind === 'deny')
      throw new ApplicationError('RATING_NOT_FOUND');
    if (decision.kind !== 'allow')
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    return result;
  }
  private async targetProjection(
    row: TargetRow,
    actor: string,
    tx: PoolClient,
  ) {
    return ratingTargetSchema.parse({
      id: row.id,
      categoryId: row.category_id,
      name: row.name,
      description: row.description,
      revision: row.revision,
      allowedActions: {
        setScore: (await this.records.summary(row.id, tx)).status === 'known',
        createComment: true,
        authorModes: await this.access.authorModes(actor, tx),
      },
    });
  }
  private async navigation(
    token: string,
    regionId: string | null,
    tx: PoolClient,
    phone = true,
  ) {
    const access = await this.access.resolve(token, regionId, tx, { phone }),
      catalog = await this.records.catalog(regionId, tx),
      safety = await this.safety.navigation(tx),
      review = await this.review.navigation(tx);
    return {
      access,
      catalog,
      epoch: [safety, review, await this.records.navigation(tx)],
    };
  }
  categories(token: string, query: RatingCategoryQuery) {
    return this.run(async (tx) => {
      const { access, catalog, epoch } = await this.navigation(
          token,
          query.regionId ?? null,
          tx,
          false,
        ),
        parentId = query.parentId ?? null,
        scope = ratingCursorScope([
          'ratings',
          1,
          'categories',
          access.session.accountId,
          access.session.sessionId,
          access.fingerprint,
          catalog.regionId,
          catalog.id,
          parentId,
          query.limit,
          ...epoch,
        ]);
      const after = query.cursor
          ? await this.cursors.get(query.cursor, scope, tx)
          : null,
        rows = await this.records.categories(
          catalog,
          parentId,
          after,
          query.limit,
          tx,
        ),
        more = rows.length > query.limit,
        chosen = rows.slice(0, query.limit);
      await this.access.recheck(token, tx);
      const nextCursor = more
        ? await this.cursors.create(
            access.session.accountId,
            scope,
            chosen.at(-1)!.ordinal,
            tx,
          )
        : null;
      return ratingCategoryPageSchema.parse({
        context: {
          regionId: catalog.regionId,
          catalogRevision: catalog.id,
          parentId,
        },
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
  targets(token: string, query: RatingTargetQuery) {
    return this.run(async (tx) => {
      const { access, catalog, epoch } = await this.navigation(
          token,
          query.regionId ?? null,
          tx,
        ),
        scope = ratingCursorScope([
          'ratings',
          1,
          'targets',
          access.session.accountId,
          access.session.sessionId,
          access.fingerprint,
          catalog.regionId,
          catalog.id,
          query.categoryId,
          query.limit,
          ...epoch,
        ]);
      const after = query.cursor
          ? await this.cursors.get(query.cursor, scope, tx)
          : null,
        rows = await this.records.targets(
          catalog,
          query.categoryId,
          after,
          query.limit,
          tx,
        ),
        more = rows.length > query.limit,
        chosen = rows.slice(0, query.limit),
        items = [];
      for (const candidate of chosen) {
        try {
          const { row } = await this.currentTarget(catalog, candidate.id, tx);
          items.push(
            await this.targetProjection(row, access.session.accountId, tx),
          );
        } catch (error) {
          if (!(
            error instanceof ApplicationError &&
            error.code === 'RATING_NOT_FOUND'
          ))
            throw error;
        }
      }
      await this.access.recheck(token, tx);
      const nextCursor = more
        ? await this.cursors.create(
            access.session.accountId,
            scope,
            chosen.at(-1)!.ordinal,
            tx,
          )
        : null;
      return ratingTargetPageSchema.parse({
        context: {
          regionId: catalog.regionId,
          catalogRevision: catalog.id,
          categoryId: query.categoryId,
        },
        items,
        nextCursor,
        continuation: more ? (items.length ? 'more' : 'scan') : 'end',
      });
    });
  }
  target(token: string, id: string, regionId: string | null) {
    return this.run(async (tx) => {
      const access = await this.access.resolve(token, regionId, tx, {
          phone: true,
        }),
        catalog = await this.records.catalog(regionId, tx),
        { row } = await this.currentTarget(catalog, id, tx),
        result = await this.targetProjection(row, access.session.accountId, tx);
      await this.access.recheck(token, tx);
      return result;
    });
  }
  myScore(token: string, id: string, regionId: string | null) {
    return this.run(async (tx) => {
      const access = await this.access.resolve(token, regionId, tx, {
          phone: true,
        }),
        catalog = await this.records.catalog(regionId, tx);
      await this.currentTarget(catalog, id, tx);
      const result = ratingMyScoreSchema.parse(
        await this.records.myScore(id, access.session.accountId, tx),
      );
      await this.access.recheck(token, tx);
      return result;
    });
  }
  summary(token: string, id: string, regionId: string | null) {
    return this.run(async (tx) => {
      await this.access.resolve(token, regionId, tx, { phone: true });
      const catalog = await this.records.catalog(regionId, tx);
      await this.currentTarget(catalog, id, tx);
      const result = await this.records.summary(id, tx);
      await this.access.recheck(token, tx);
      return result;
    });
  }
  private async projectComment(
    row: CommentRow,
    actor: string,
    tx: PoolClient,
    purpose: 'rating_list' | 'rating_direct',
  ): Promise<RatingComment | null> {
    const decision = await this.review.current(
      'comment',
      row.id,
      canonicalRatingEnvelope(row.envelope),
      tx,
    );
    if (decision.kind === 'deny') return null;
    if (decision.kind !== 'allow')
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    let author: RatingComment['author'];
    if (row.author_mode === 'anonymous') {
      if (!row.persona_id || !row.persona_name)
        throw new ApplicationError('RATING_UNAVAILABLE');
      author = {
        mode: 'anonymous',
        targetId: row.target_id,
        personaId: row.persona_id,
        displayName: row.persona_name,
      };
    } else {
      const visibility = await this.safety.named(
        actor,
        row.account_id,
        purpose,
        tx,
      );
      if (visibility.kind === 'deny') return null;
      if (visibility.kind !== 'allow')
        throw new ApplicationError('SAFETY_UNAVAILABLE');
      const profile = await this.authors.findRatingPublic(row.account_id, tx);
      if (!profile) throw new ApplicationError('RATING_UNAVAILABLE');
      author = { mode: 'named', ...profile };
    }
    const isMine = row.account_id === actor;
    return ratingCommentSchema.parse({
      id: row.id,
      targetId: row.target_id,
      body: row.body,
      revision: row.revision,
      createdAt: row.created_at,
      author,
      isMine,
      allowedActions: { delete: isMine },
    });
  }
  comments(token: string, id: string, query: RatingCommentQuery) {
    if (query.sort !== undefined || query.order !== undefined)
      return this.orderedComments(token, id, query);
    return this.run(async (tx) => {
      const { access, catalog, epoch } = await this.navigation(
          token,
          query.regionId ?? null,
          tx,
        ),
        { row: target } = await this.currentTarget(catalog, id, tx),
        scope = ratingCursorScope([
          'ratings',
          1,
          'comments',
          access.session.accountId,
          access.session.sessionId,
          access.fingerprint,
          catalog.regionId,
          catalog.id,
          id,
          target.revision,
          query.limit,
          ...epoch,
        ]);
      const after = query.cursor
          ? await this.cursors.get(query.cursor, scope, tx)
          : null,
        rows = await this.records.comments(id, after, query.limit, tx),
        more = rows.length > query.limit,
        chosen = rows.slice(0, query.limit),
        items: RatingComment[] = [];
      for (const c of chosen) {
        const row = await this.records.comment(c.id, id, tx),
          projection = await this.projectComment(
            row,
            access.session.accountId,
            tx,
            'rating_list',
          );
        if (projection) items.push(projection);
      }
      await this.access.recheck(token, tx);
      const nextCursor = more
        ? await this.cursors.create(
            access.session.accountId,
            scope,
            chosen.at(-1)!.ordinal,
            tx,
          )
        : null;
      return ratingCommentPageSchema.parse({
        context: {
          regionId: catalog.regionId,
          catalogRevision: catalog.id,
          targetId: id,
        },
        items,
        nextCursor,
        continuation: more ? (items.length ? 'more' : 'scan') : 'end',
      });
    });
  }
  private orderedComments(
    token: string,
    id: string,
    query: RatingCommentQuery,
  ) {
    return this.run(async (tx) => {
      const { access, catalog, epoch } = await this.navigation(
          token,
          query.regionId ?? null,
          tx,
        ),
        { row: target } = await this.currentTarget(catalog, id, tx),
        sort = query.sort ?? 'time',
        order = query.order ?? 'desc';
      const head = await this.rootOrder.head(id, sort, tx),
        scope = ratingCursorScope([
          'ratings',
          2,
          'root-order',
          access.session.accountId,
          access.session.sessionId,
          access.fingerprint,
          catalog.regionId,
          catalog.id,
          id,
          target.revision,
          query.limit,
          sort,
          order,
          ...epoch,
          ...head,
        ]);
      const after = query.cursor
          ? await this.orderCursors.get(query.cursor, scope, sort, order, tx)
          : null,
        rows = await this.rootOrder.page(
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
      for (const c of chosen) {
        const row = await this.records.comment(c.id, id, tx),
          item = await this.projectComment(
            row,
            access.session.accountId,
            tx,
            'rating_list',
          );
        if (item) items.push(item);
      }
      await this.access.recheck(token, tx);
      const last = chosen.at(-1),
        nextCursor =
          more && last
            ? await this.orderCursors.create(
                access.session.accountId,
                scope,
                sort,
                order,
                {
                  createdMicros: last.createdMicros,
                  ordinal: last.ordinal,
                  count: last.count,
                },
                tx,
              )
            : null;
      return ratingCommentPageSchema.parse({
        context: {
          regionId: catalog.regionId,
          catalogRevision: catalog.id,
          targetId: id,
        },
        items,
        nextCursor,
        continuation: more ? (items.length ? 'more' : 'scan') : 'end',
      });
    });
  }
  comment(token: string, id: string, regionId: string | null) {
    return this.run(async (tx) => {
      const access = await this.access.resolve(token, regionId, tx, {
          phone: true,
        }),
        catalog = await this.records.catalog(regionId, tx),
        targetId = await this.records.commentTarget(id, tx);
      await this.currentTarget(catalog, targetId, tx);
      const row = await this.records.comment(id, targetId, tx),
        result = await this.projectComment(
          row,
          access.session.accountId,
          tx,
          'rating_direct',
        );
      if (!result) throw new ApplicationError('RATING_NOT_FOUND');
      await this.access.recheck(token, tx);
      return result;
    });
  }
  setScore(token: string, id: string, command: SetRatingScore) {
    return this.requests.execute(
      token,
      command.clientRequestId,
      'set_score',
      { targetId: id, ...command },
      async (actor, tx) => {
        this.records.enable(tx);
        await this.access.resolve(token, command.regionId, tx, { phone: true });
        const catalog = await this.records.catalog(command.regionId, tx),
          { row } = await this.currentTarget(catalog, id, tx, true);
        this.revision(row, command.expectedTargetRevision);
        return this.records.setScore(id, actor, command, tx);
      },
    );
  }
  private revision(row: Pick<TargetRow, 'revision'>, expected: string) {
    if (row.revision !== expected)
      throw new ApplicationError('RATING_REVISION_CONFLICT');
  }
  private envelope(
    actor: string,
    command: CreateRatingComment,
    target: TargetRow,
    category: CategoryRow,
    catalog: RatingCatalog,
  ) {
    return canonicalRatingEnvelope({
      version: 1,
      accountId: actor,
      purpose: 'publish_rating_comment',
      clientRequestId: command.clientRequestId,
      targetId: target.id,
      targetRevision: target.revision,
      categoryId: category.id,
      categoryRevision: category.revision,
      catalogRevision: catalog.id,
      scope: { regionId: catalog.regionId },
      assetIds: [],
      authorMode: command.authorMode,
      body: command.body,
    });
  }
  createComment(token: string, id: string, command: CreateRatingComment) {
    return this.requests.execute(
      token,
      command.clientRequestId,
      'create_comment',
      { targetId: id, ...command },
      async (actor, tx) => {
        this.records.enable(tx);
        await this.access.resolve(token, command.regionId, tx, { phone: true });
        const catalog = await this.records.catalog(command.regionId, tx),
          { row, category } = await this.currentTarget(catalog, id, tx, true);
        this.revision(row, command.expectedTargetRevision);
        if (command.authorMode === 'anonymous')
          await this.access.requireAnonymous(actor, tx);
        const envelope = this.envelope(actor, command, row, category, catalog),
          accepted = await this.review.accepted(envelope, tx);
        let personaId: string | null = null;
        if (command.authorMode === 'anonymous')
          personaId = (await this.records.persona(id, actor, tx)).public_id;
        else await this.authors.prepare(actor, tx);
        const commentId = randomUUID(),
          revision = randomUUID(),
          result = await this.records.insertComment(
            {
              id: commentId,
              targetId: id,
              actor,
              authorMode: command.authorMode,
              personaId,
              body: command.body,
              revision,
              requestId: command.clientRequestId,
              envelope,
            },
            tx,
          );
        await this.review.bind(accepted, 'comment', commentId, envelope, tx);
        await this.effects.captureCreated(actor, command.clientRequestId, tx);
        return result;
      },
    );
  }
  deleteComment(token: string, id: string, command: DeleteRatingComment) {
    return this.requests.execute(
      token,
      command.clientRequestId,
      'delete_comment',
      { commentId: id, ...command },
      async (actor, tx) => {
        this.records.enable(tx);
        await this.access.requireDeletionActor(actor, tx);
        const target = await this.deletion.target(command.targetId, tx),
          row = await this.deletion.root(id, target.id, tx);
        if (row.account_id !== actor)
          throw new ApplicationError('RATING_NOT_FOUND');
        this.revision(target, command.expectedTargetRevision);
        return this.records.deleteComment(
          row,
          actor,
          command.clientRequestId,
          command.expectedRevision,
          tx,
        );
      },
    );
  }
  receipt(token: string, id: string) {
    return this.requests.receipt(token, id);
  }
}
