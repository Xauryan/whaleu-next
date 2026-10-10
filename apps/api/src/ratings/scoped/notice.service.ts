import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { canonicalEqual } from '../../community/content-review/contracts.js';
import type { PoolClient } from 'pg';
import { z, ZodError } from 'zod';
import { DatabaseService } from '../../database/database.js';
import { IdentityService } from '../../identity/identity.service.js';
import { ApplicationError } from '../../http/application-error.js';
import { discoveryContinuationScope } from '../../community/discovery-continuation.module.js';
import {
  RatingUpdatesRepository,
  type StoredRatingNotice,
  type StoredRatingLikeNotice,
} from '../../notifications/ratings/repository.js';
import {
  RatingSubscriptionUpdatesRepository,
  type StoredRatingSubscriptionNotice,
} from '../../notifications/ratings/subscription-repository.js';
import { RatingUpdatesCursors } from '../../notifications/ratings/cursor.js';
import { RatingSubscriptionUpdatesCursors } from '../../notifications/ratings/subscription-cursor.js';
import { ratingUpdatesQuerySchema } from '../../notifications/ratings/contracts.js';
import { RatingSafetyFacade } from '../../safety/rating.facade.js';
import { AuthorDisplayService } from '../../profile/author-display.service.js';
import { RatingsAccessService } from '../access.js';
import { RatingsRepository } from '../repository.js';
import { RatingDiscussionRepository } from '../discussion-repository.js';
import { ratingTimeSchema } from '../contracts.js';
import {
  RatingScopedContextService,
  type ResolvedRatingScope,
} from './context.service.js';
import { RatingScopedRepository } from './repository.js';
import { RatingScopedProjection } from './projection.js';
import {
  ratingScopedContextSchema,
  ratingScopedLocatorSchema,
  ratingScopedReadQuerySchema,
  scopedId,
  scopedToken,
} from './contracts.js';

export type RatingScopedNoticeKind =
  'updates' | 'like-updates' | 'subscription-updates';
export const ratingScopedNoticeQuerySchema = ratingUpdatesQuerySchema;
export const ratingScopedNoticePageSchema = z
  .strictObject({
    items: z
      .array(
        z.strictObject({
          noticeId: scopedId,
          createdAt: ratingTimeSchema,
          readAt: ratingTimeSchema.nullable(),
          status: z.literal('unavailable'),
        }),
      )
      .max(20),
    nextCursor: scopedToken.nullable(),
    unreadCount: z.number().int().nonnegative().max(2147483647),
  })
  .refine(
    (page) =>
      new Set(page.items.map((item) => item.noticeId)).size ===
      page.items.length,
  );
export const ratingScopedNoticeTargetSchema = z.discriminatedUnion('status', [
  z.strictObject({ noticeId: scopedId, status: z.literal('unavailable') }),
  z.strictObject({
    noticeId: scopedId,
    status: z.literal('available'),
    target: ratingScopedLocatorSchema,
  }),
]);
export const ratingScopedResolveLocatorSchema = z.strictObject({
  locator: ratingScopedLocatorSchema,
  purpose: z.enum(['read', 'interact', 'edit_target']),
  mode: z.literal('public'),
});
export const ratingScopedResolvedLocatorSchema = z
  .strictObject({
    locator: ratingScopedLocatorSchema,
    context: ratingScopedContextSchema,
  })
  .superRefine((value, ctx) => {
    if (
      value.context.purpose === 'random' ||
      !canonicalEqual(value.context.selector, value.locator.selector) ||
      value.context.protocolGeneration !== value.locator.protocolGeneration ||
      value.context.mode !== 'public'
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Exact adopted locator required',
      });
  });
type NoticeQuery = z.infer<typeof ratingScopedNoticeQuerySchema>;
type ReadQuery = z.infer<typeof ratingScopedReadQuerySchema>;
type Locator = z.infer<typeof ratingScopedLocatorSchema>;
type StoredNotice =
  StoredRatingNotice | StoredRatingLikeNotice | StoredRatingSubscriptionNotice;
function assertKind(kind: RatingScopedNoticeKind): void {
  if (!['updates', 'like-updates', 'subscription-updates'].includes(kind))
    throw new ApplicationError('RATING_UNAVAILABLE');
}
/** Reuses captured notification IDs, owner state, cursor storage and public content kernels. There is no new fanout or read-state pipeline. */
@Injectable()
export class RatingScopedNoticeService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(RatingScopedContextService)
    private readonly contexts: RatingScopedContextService,
    @Inject(RatingScopedRepository)
    private readonly scoped: RatingScopedRepository,
    @Inject(RatingsRepository) private readonly records: RatingsRepository,
    @Inject(RatingDiscussionRepository)
    private readonly replies: RatingDiscussionRepository,
    @Inject(RatingScopedProjection)
    private readonly projection: RatingScopedProjection,
    @Inject(RatingsAccessService) private readonly access: RatingsAccessService,
    @Inject(RatingUpdatesRepository)
    private readonly notices: RatingUpdatesRepository,
    @Inject(RatingSubscriptionUpdatesRepository)
    private readonly subscriptionNotices: RatingSubscriptionUpdatesRepository,
    @Inject(RatingUpdatesCursors)
    private readonly cursors: RatingUpdatesCursors,
    @Inject(RatingSubscriptionUpdatesCursors)
    private readonly subscriptionCursors: RatingSubscriptionUpdatesCursors,
    @Inject(RatingSafetyFacade) private readonly safety: RatingSafetyFacade,
    @Inject(AuthorDisplayService)
    private readonly authors: AuthorDisplayService,
  ) {}
  private async run<T>(work: (tx: PoolClient) => Promise<T>): Promise<T> {
    try {
      return await this.database.transaction(work, {
        isolationLevel: 'read committed',
      });
    } catch (error) {
      if (error instanceof ZodError)
        throw new ApplicationError('RATING_UNAVAILABLE');
      throw error;
    }
  }
  private async owner(
    accountId: string,
    kind: RatingScopedNoticeKind,
    tx: PoolClient,
  ): Promise<void> {
    if (kind === 'subscription-updates')
      await this.subscriptionNotices.owner(accountId, tx);
    else await this.notices.owner(accountId, tx);
  }
  private states(
    accountId: string,
    ids: readonly string[],
    kind: RatingScopedNoticeKind,
    tx: PoolClient,
  ) {
    return kind === 'subscription-updates'
      ? this.subscriptionNotices.states(accountId, ids, tx)
      : this.notices.states(
          accountId,
          ids,
          tx,
          kind === 'like-updates' ? 'like' : 'reply',
        );
  }
  private count(
    accountId: string,
    kind: RatingScopedNoticeKind,
    tx: PoolClient,
  ) {
    return kind === 'subscription-updates'
      ? this.subscriptionNotices.count(accountId, tx)
      : this.notices.count(
          accountId,
          tx,
          kind === 'like-updates' ? 'like' : 'reply',
        );
  }
  list(token: string, kind: RatingScopedNoticeKind, input: NoticeQuery) {
    assertKind(kind);
    const query = ratingScopedNoticeQuerySchema.parse(input);
    return this.run(async (tx) => {
      const session = await this.identity.session(token, tx);
      const scope = discoveryContinuationScope([
        'rating-scoped-notice-metadata',
        2,
        kind,
        session.accountId,
        session.sessionId,
        createHash('sha256').update(token).digest('hex'),
        query.limit,
        'ordinal-desc',
      ]);
      const cursors =
        kind === 'subscription-updates'
          ? this.subscriptionCursors
          : this.cursors;
      const before = query.cursor
        ? await cursors.get(query.cursor, scope, tx)
        : null;
      const rows: StoredNotice[] =
        kind === 'subscription-updates'
          ? await this.subscriptionNotices.page(
              session.accountId,
              query.limit,
              before,
              tx,
            )
          : await this.notices.page(
              session.accountId,
              query.limit,
              before,
              tx,
              kind === 'like-updates' ? 'like' : 'reply',
            );
      if (
        rows.length > query.limit + 1 ||
        rows.some((row) => row.recipient_account_id !== session.accountId)
      )
        throw new ApplicationError('RATING_UNAVAILABLE');
      const selected = rows.slice(0, query.limit);
      // Metadata issuance neither warms scoped context nor tries alternative campuses.
      const currentSession = await this.identity.session(token, tx);
      if (
        currentSession.accountId !== session.accountId ||
        currentSession.sessionId !== session.sessionId
      )
        throw new ApplicationError('AUTHENTICATION_REQUIRED');
      await this.owner(session.accountId, kind, tx);
      const states = await this.states(
          session.accountId,
          selected.map((row) => row.id),
          kind,
          tx,
        ),
        unreadCount = await this.count(session.accountId, kind, tx);
      const nextCursor =
        rows.length > query.limit
          ? await cursors.create(
              session.accountId,
              scope,
              selected.at(-1)!.ordinal,
              tx,
            )
          : null;
      return ratingScopedNoticePageSchema.parse({
        items: selected.map((row) => ({
          noticeId: row.id,
          createdAt: row.created_at,
          readAt: states.get(row.id),
          status: 'unavailable',
        })),
        nextCursor,
        unreadCount,
      });
    });
  }
  private async qualify(
    scope: ResolvedRatingScope,
    locator: Locator,
    tx: PoolClient,
    originalRegionId?: string | null,
  ) {
    if (
      locator.protocolGeneration !== scope.protocolGeneration ||
      !canonicalEqual(locator.selector, scope.selector)
    )
      throw new ApplicationError('RATING_SCOPED_CONTEXT_CHANGED');
    const { row: target } = await this.scoped.target(
      scope,
      locator.targetId,
      tx,
    );
    await this.projection.qualifyTarget(target, tx);
    if (originalRegionId !== undefined && target.region_id !== originalRegionId)
      throw new ApplicationError('RATING_UNAVAILABLE');
    const actor = { accountId: scope.actor, mode: scope.context.mode };
    if (locator.rootId === null) return { target, subject: null };
    const root = await this.records.comment(locator.rootId, target.id, tx);
    if (
      !(await this.projection.content(
        root,
        'comment',
        actor,
        'rating_direct',
        tx,
      ))
    )
      throw new ApplicationError('RATING_NOT_FOUND');
    if (locator.replyId === null) return { target, subject: root };
    const reply = await this.replies.reply(
      locator.replyId,
      locator.rootId,
      target.id,
      tx,
    );
    if (
      !(await this.projection.content(
        reply,
        'reply',
        actor,
        'rating_direct',
        tx,
      ))
    )
      throw new ApplicationError('RATING_NOT_FOUND');
    return { target, subject: reply };
  }
  target(
    token: string,
    kind: RatingScopedNoticeKind,
    noticeId: string,
    query: ReadQuery,
  ) {
    assertKind(kind);
    return this.run(async (tx) => {
      this.records.enable(tx);
      this.scoped.enable(tx);
      const scope = await this.contexts.resolve(token, query, tx, {
        purpose: 'read',
      });
      if (scope.context.mode !== 'public')
        throw new ApplicationError('RATING_SCOPE_UNAVAILABLE');
      const row: StoredNotice =
        kind === 'subscription-updates'
          ? await this.subscriptionNotices.own(scope.actor, noticeId, tx)
          : await this.notices.own(
              scope.actor,
              noticeId,
              tx,
              kind === 'like-updates' ? 'like' : 'reply',
            );
      if (row.recipient_account_id !== scope.actor || row.id !== noticeId)
        throw new ApplicationError('RATING_UNAVAILABLE');
      const target = ratingScopedLocatorSchema.parse({
        selector: scope.selector,
        targetId: row.target_id,
        rootId: row.root_id,
        replyId: row.reply_id,
        protocolGeneration: scope.protocolGeneration,
      });
      let available = true;
      try {
        const current = await this.qualify(scope, target, tx, row.region_id);
        if (row.kind === 'like') {
          if (!current.subject || current.subject.account_id !== scope.actor)
            throw new ApplicationError('RATING_UNAVAILABLE');
          const decision = await this.safety.named(
            scope.actor,
            row.like_actor_account_id,
            'rating_direct',
            tx,
          );
          if (decision.kind === 'deny')
            throw new ApplicationError('RATING_NOT_FOUND');
          if (
            decision.kind !== 'allow' ||
            !(await this.authors.findRatingPublic(
              row.like_actor_account_id,
              tx,
            ))
          )
            throw new ApplicationError('RATING_UNAVAILABLE');
        }
      } catch (error) {
        if (
          error instanceof ApplicationError &&
          error.code === 'RATING_NOT_FOUND'
        )
          available = false;
        else throw error;
      }
      await this.access.recheck(token, tx);
      await this.scoped.retainAfter(scope, tx);
      // Preserve the legacy lock order: source proofs first, notification owner last.
      await this.owner(scope.actor, kind, tx);
      await this.states(scope.actor, [row.id], kind, tx);
      return ratingScopedNoticeTargetSchema.parse(
        available
          ? { noticeId, status: 'available', target }
          : { noticeId, status: 'unavailable' },
      );
    });
  }
  resolveLocator(
    token: string,
    input: z.infer<typeof ratingScopedResolveLocatorSchema>,
  ) {
    const request = ratingScopedResolveLocatorSchema.parse(input);
    return this.run(async (tx) => {
      this.records.enable(tx);
      this.scoped.enable(tx);
      const resolved = await this.contexts.resolveLocator(
        token,
        request.locator,
        request.purpose,
        tx,
      );
      if (!canonicalEqual(resolved.locator, request.locator))
        throw new ApplicationError('RATING_SCOPED_CONTEXT_CHANGED');
      const scope = await this.contexts.resolve(
        token,
        {
          contextId: resolved.context.id,
          contextToken: resolved.context.token,
        },
        tx,
        { purpose: request.purpose },
      );
      await this.qualify(scope, request.locator, tx);
      await this.access.recheck(token, tx);
      await this.scoped.retainAfter(scope, tx);
      if (resolved.context.purpose !== request.purpose)
        throw new ApplicationError('RATING_SCOPED_CONTEXT_CHANGED');
      return ratingScopedResolvedLocatorSchema.parse(resolved);
    });
  }
}
