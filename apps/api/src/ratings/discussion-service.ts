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
import { RatingDiscussionRepository } from './discussion-repository.js';
import { RatingDiscussionProjection } from './discussion-projection.js';
import { RatingReplyRequests } from './discussion-requests.js';
import { RatingsCursors, ratingCursorScope } from './cursor.js';
import { RatingEffectsCapture } from './effects/capture.js';
import {
  ratingDiscussionSchema,
  ratingReplyPageSchema,
  ratingReplyPositionSchema,
} from './discussion-contracts.js';
import type {
  CreateRatingReply,
  DeleteRatingReply,
  RatingReplyQuery,
  RatingReply,
} from './discussion-contracts.js';
@Injectable()
export class RatingDiscussionService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(RatingsAccessService) private readonly access: RatingsAccessService,
    @Inject(RatingsRepository) private readonly records: RatingsRepository,
    @Inject(RatingDiscussionRepository)
    private readonly replies: RatingDiscussionRepository,
    @Inject(RatingDiscussionProjection)
    private readonly projection: RatingDiscussionProjection,
    @Inject(RatingReplyRequests) private readonly requests: RatingReplyRequests,
    @Inject(RatingsCursors) private readonly cursors: RatingsCursors,
    @Inject(RatingContentReviewFacade)
    private readonly review: RatingContentReviewFacade,
    @Inject(RatingSafetyFacade) private readonly safety: RatingSafetyFacade,
    @Inject(AuthorDisplayService)
    private readonly authors: AuthorDisplayService,
    @Inject(RatingEffectsCapture)
    private readonly effects: RatingEffectsCapture,
  ) {}
  private async run<T>(fn: (tx: PoolClient) => Promise<T>) {
    try {
      return await this.database.transaction(
        async (tx) => {
          this.records.enable(tx);
          return fn(tx);
        },
        { isolationLevel: 'read committed' },
      );
    } catch (e) {
      if (e instanceof ZodError)
        throw new ApplicationError('RATING_UNAVAILABLE');
      throw e;
    }
  }
  private async chain(
    token: string,
    rootId: string,
    regionId: string | null,
    tx: PoolClient,
    write = false,
    targetId?: string,
  ) {
    const access = await this.access.resolve(token, regionId, tx, {
      phone: true,
    });
    const catalog = await this.records.catalog(regionId, tx);
    const id = targetId ?? (await this.records.commentTarget(rootId, tx));
    const target = await this.projection.target(catalog, id, tx, write);
    const root = await this.records.comment(rootId, id, tx, write);
    // A root remains an independent visibility gate for every descendant.
    const rootView = await this.projection.root(
      root,
      access.session.accountId,
      'rating_list',
      tx,
    );
    if (!rootView) throw new ApplicationError('RATING_NOT_FOUND');
    const rootCanReply = await this.projection.canReply(
      root,
      access.session.accountId,
      tx,
    );
    return { access, catalog, target, root, rootView, rootCanReply };
  }
  thread(token: string, rootId: string, regionId: string | null) {
    return this.run(async (tx) => {
      const c = await this.chain(token, rootId, regionId, tx);
      const result = ratingDiscussionSchema.parse({
        context: {
          regionId,
          catalogRevision: c.catalog.id,
          targetId: c.target.row.id,
          rootId,
        },
        root: c.rootView,
        allowedActions: {
          createReply: c.rootCanReply,
          authorModes: await this.access.authorModes(
            c.access.session.accountId,
            tx,
          ),
        },
      });
      await this.access.recheck(token, tx);
      return result;
    });
  }
  private async page(
    token: string,
    rootId: string,
    query: RatingReplyQuery,
    tx: PoolClient,
    anchorId?: string,
  ) {
    const c = await this.chain(token, rootId, query.regionId ?? null, tx),
      actor = c.access.session.accountId;
    const epoch = [
      await this.safety.navigation(tx),
      await this.review.navigation(tx),
      await this.records.navigation(tx),
      await this.replies.navigation(rootId, tx),
    ];
    const scope = ratingCursorScope([
      'ratings',
      2,
      'replies',
      actor,
      c.access.session.sessionId,
      c.access.fingerprint,
      c.catalog.regionId,
      c.catalog.id,
      c.target.row.id,
      c.target.row.revision,
      rootId,
      c.root.revision,
      query.limit,
      ...epoch,
    ]);
    let after = query.cursor
      ? await this.cursors.get(query.cursor, scope, tx)
      : null;
    if (anchorId) {
      if (!c.rootCanReply) throw new ApplicationError('RATING_NOT_FOUND');
      const anchor = await this.replies.reply(
        anchorId,
        rootId,
        c.target.row.id,
        tx,
      );
      if (
        !(await this.projection.reply(
          anchor,
          actor,
          c.rootCanReply,
          'rating_direct',
          tx,
        ))
      )
        throw new ApplicationError('RATING_NOT_FOUND');
      after = anchor.ordinal;
    }
    const rows = await this.replies.page(
        rootId,
        c.target.row.id,
        after,
        query.limit,
        tx,
        !!anchorId,
      ),
      more = rows.length > query.limit,
      chosen = rows.slice(0, query.limit),
      items: RatingReply[] = [];
    for (const row of chosen) {
      const stored = await this.replies.reply(
        row.id,
        rootId,
        c.target.row.id,
        tx,
      );
      const item = await this.projection.reply(
        stored,
        actor,
        c.rootCanReply,
        'rating_list',
        tx,
      );
      if (item) items.push(item);
    }
    await this.access.recheck(token, tx);
    const nextCursor = more
      ? await this.cursors.create(actor, scope, chosen.at(-1)!.ordinal, tx)
      : null;
    return ratingReplyPageSchema.parse({
      context: {
        regionId: c.catalog.regionId,
        catalogRevision: c.catalog.id,
        targetId: c.target.row.id,
        rootId,
        order: 'oldest',
      },
      items,
      nextCursor,
      continuation: more ? (items.length ? 'more' : 'scan') : 'end',
    });
  }
  listReplies(token: string, rootId: string, query: RatingReplyQuery) {
    return this.run((tx) => this.page(token, rootId, query, tx));
  }
  reply(token: string, id: string, regionId: string | null) {
    return this.run(async (tx) => {
      await this.access.authenticate(token, tx);
      const hint = await this.replies.ancestry(id, tx),
        c = await this.chain(
          token,
          hint.root_id,
          regionId,
          tx,
          false,
          hint.target_id,
        );
      if (!c.rootCanReply) throw new ApplicationError('RATING_NOT_FOUND');
      const row = await this.replies.reply(id, c.root.id, c.target.row.id, tx),
        result = await this.projection.reply(
          row,
          c.access.session.accountId,
          c.rootCanReply,
          'rating_direct',
          tx,
        );
      if (!result) throw new ApplicationError('RATING_NOT_FOUND');
      await this.access.recheck(token, tx);
      return result;
    });
  }
  locateReply(
    token: string,
    id: string,
    query: Omit<RatingReplyQuery, 'cursor'>,
  ) {
    return this.run(async (tx) => {
      await this.access.authenticate(token, tx);
      const hint = await this.replies.ancestry(id, tx),
        page = await this.page(token, hint.root_id, query, tx, id);
      return ratingReplyPositionSchema.parse({
        context: page.context,
        anchorReplyId: id,
        page,
      });
    });
  }
  createReply(token: string, rootId: string, command: CreateRatingReply) {
    return this.requests.execute(
      token,
      command.clientRequestId,
      'create_reply',
      { rootId, ...command },
      async (actor, tx) => {
        this.records.enable(tx);
        const c = await this.chain(
          token,
          rootId,
          command.regionId,
          tx,
          true,
          command.targetId,
        );
        if (
          c.target.row.revision !== command.expectedTargetRevision ||
          c.root.revision !== command.expectedRootRevision
        )
          throw new ApplicationError('RATING_REVISION_CONFLICT');
        if (!c.rootCanReply) throw new ApplicationError('RATING_NOT_FOUND');
        let parent = null;
        if (command.replyTo) {
          parent = await this.replies.reply(
            command.replyTo.replyId,
            rootId,
            c.target.row.id,
            tx,
          );
          if (parent.revision !== command.replyTo.expectedRevision)
            throw new ApplicationError('RATING_REVISION_CONFLICT');
          if (
            !(await this.projection.content(
              parent,
              'reply',
              actor,
              'rating_direct',
              tx,
            ))
          )
            throw new ApplicationError('RATING_NOT_FOUND');
        }
        if (command.authorMode === 'anonymous')
          await this.access.requireAnonymous(actor, tx);
        const envelope = canonicalRatingEnvelope({
          version: 2,
          purpose: 'publish_rating_reply',
          accountId: actor,
          clientRequestId: command.clientRequestId,
          targetId: c.target.row.id,
          targetRevision: c.target.row.revision,
          rootId,
          rootRevision: c.root.revision,
          replyTo: parent
            ? { replyId: parent.id, revision: parent.revision }
            : null,
          categoryId: c.target.category.id,
          categoryRevision: c.target.category.revision,
          catalogRevision: c.catalog.id,
          scope: { regionId: c.catalog.regionId },
          assetIds: [],
          authorMode: command.authorMode,
          body: command.body,
        });
        const accepted = await this.review.accepted(envelope, tx);
        let personaId: string | null = null;
        if (command.authorMode === 'anonymous')
          personaId = (await this.records.persona(c.target.row.id, actor, tx))
            .public_id;
        else await this.authors.prepare(actor, tx);
        const id = randomUUID(),
          result = await this.replies.insert(
            {
              id,
              targetId: c.target.row.id,
              rootId,
              replyToId: parent?.id ?? null,
              actor,
              authorMode: command.authorMode,
              personaId,
              body: command.body,
              revision: randomUUID(),
              requestId: command.clientRequestId,
              envelope,
            },
            tx,
          );
        await this.review.bind(accepted, 'reply', id, envelope, tx);
        await this.effects.captureCreated(actor, command.clientRequestId, tx);
        return result;
      },
    );
  }
  deleteReply(token: string, id: string, command: DeleteRatingReply) {
    return this.requests.execute(
      token,
      command.clientRequestId,
      'delete_reply',
      { replyId: id, ...command },
      async (actor, tx) => {
        this.records.enable(tx);
        const c = await this.chain(
          token,
          command.rootId,
          command.regionId,
          tx,
          true,
          command.targetId,
        );
        if (
          c.target.row.revision !== command.expectedTargetRevision ||
          c.root.revision !== command.expectedRootRevision
        )
          throw new ApplicationError('RATING_REVISION_CONFLICT');
        const row = await this.replies.reply(
          id,
          c.root.id,
          c.target.row.id,
          tx,
          true,
          true,
        );
        return this.replies.delete(
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
