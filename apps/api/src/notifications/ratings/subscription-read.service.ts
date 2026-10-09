import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ZodError } from 'zod';
import { DatabaseService } from '../../database/database.js';
import { IdentityService } from '../../identity/identity.service.js';
import { ApplicationError } from '../../http/application-error.js';
import { lockSafetyPolicy } from '../../safety/locks.js';
import { RatingSubscriptionUpdatesProjectionFacade } from '../../ratings/updates-source/subscription-projection.js';
import {
  ratingSubscriptionNoticeReadSchema,
  ratingSubscriptionNoticeSchema,
  ratingSubscriptionNoticeTargetSchema,
  ratingSubscriptionUnreadCountSchema,
  ratingSubscriptionUpdatesPageSchema,
  ratingSubscriptionUpdatesQuerySchema,
} from './subscription-contracts.js';
import type {
  RatingSubscriptionNotice,
  RatingSubscriptionNoticeTarget,
  RatingSubscriptionUpdatesPage,
  RatingSubscriptionUpdatesQuery,
} from './subscription-contracts.js';
import {
  RatingSubscriptionUpdatesCursors,
  ratingSubscriptionUpdatesCursorScope,
} from './subscription-cursor.js';
import { RatingSubscriptionUpdatesRepository } from './subscription-repository.js';
import type { StoredRatingSubscriptionNotice } from './subscription-repository.js';

@Injectable()
export class RatingSubscriptionUpdatesReadService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(RatingSubscriptionUpdatesRepository)
    private readonly records: RatingSubscriptionUpdatesRepository,
    @Inject(RatingSubscriptionUpdatesProjectionFacade)
    private readonly projection: RatingSubscriptionUpdatesProjectionFacade,
    @Inject(RatingSubscriptionUpdatesCursors)
    private readonly cursors: RatingSubscriptionUpdatesCursors,
  ) {}
  private async run<T>(operation: (tx: PoolClient) => Promise<T>): Promise<T> {
    try {
      return await this.database.transaction(operation, {
        isolationLevel: 'read committed',
      });
    } catch (error) {
      if (error instanceof ZodError)
        throw new ApplicationError('RATING_UNAVAILABLE');
      throw error;
    }
  }
  private async project(
    row: StoredRatingSubscriptionNotice,
    tx: PoolClient,
  ): Promise<RatingSubscriptionNotice> {
    const base = {
      noticeId: row.id,
      createdAt: row.created_at,
      readAt: row.read_at,
    };
    const target = {
      regionId: row.region_id,
      targetId: row.target_id,
      rootId: row.root_id,
      replyId: row.reply_id,
    };
    const decision = await this.projection.eligible(
      target,
      row.recipient_account_id,
      tx,
    );
    return ratingSubscriptionNoticeSchema.parse(
      decision.outcome === 'eligible'
        ? {
            ...base,
            status: 'available',
            domain: 'ratings',
            kind: 'subscription',
            activity: row.activity,
            reason: row.reason,
            target,
            preview: decision.preview,
          }
        : { ...base, status: 'unavailable' },
    );
  }
  list(
    token: string,
    input: RatingSubscriptionUpdatesQuery,
  ): Promise<RatingSubscriptionUpdatesPage> {
    const query = ratingSubscriptionUpdatesQuerySchema.parse(input);
    return this.run(async (tx) => {
      await lockSafetyPolicy(tx);
      const session = await this.identity.session(token, tx);
      const scope = ratingSubscriptionUpdatesCursorScope(
        session.accountId,
        session.sessionId,
        token,
        query.limit,
      );
      const before = query.cursor
        ? await this.cursors.get(query.cursor, scope, tx)
        : null;
      // Immutable owner-owned candidates authorize only the locator, not content.
      const rows = await this.records.page(
        session.accountId,
        query.limit,
        before,
        tx,
      );
      const selected = rows.slice(0, query.limit),
        projected: RatingSubscriptionNotice[] = [];
      for (const row of selected) projected.push(await this.project(row, tx));
      await this.identity.session(token, tx);
      // All parent/authority locks precede notification owner. After this point
      // only immutable coordinates, owner read state and navigation metadata remain.
      await this.records.owner(session.accountId, tx);
      const states = await this.records.states(
        session.accountId,
        selected.map((row) => row.id),
        tx,
      );
      const items = projected.map((notice) => ({
        ...notice,
        readAt: states.get(notice.noticeId)!,
      }));
      const unreadCount = await this.records.count(session.accountId, tx);
      const nextCursor =
        rows.length > query.limit
          ? await this.cursors.create(
              session.accountId,
              scope,
              selected.at(-1)!.ordinal,
              tx,
            )
          : null;
      return ratingSubscriptionUpdatesPageSchema.parse({
        items,
        nextCursor,
        unreadCount,
      });
    });
  }
  unreadCount(token: string) {
    return this.run(async (tx) => {
      const { accountId } = await this.identity.session(token, tx);
      await this.records.owner(accountId, tx);
      return ratingSubscriptionUnreadCountSchema.parse({
        unreadCount: await this.records.count(accountId, tx),
      });
    });
  }
  target(
    token: string,
    noticeId: string,
  ): Promise<RatingSubscriptionNoticeTarget> {
    return this.run(async (tx) => {
      await lockSafetyPolicy(tx);
      const { accountId } = await this.identity.session(token, tx);
      const row = await this.records.own(accountId, noticeId, tx);
      const notice = await this.project(row, tx);
      await this.identity.session(token, tx);
      await this.records.owner(accountId, tx);
      await this.records.states(accountId, [row.id], tx);
      return ratingSubscriptionNoticeTargetSchema.parse(
        notice.status === 'available'
          ? {
              noticeId: notice.noticeId,
              status: 'available',
              target: notice.target,
            }
          : { noticeId: notice.noticeId, status: 'unavailable' },
      );
    });
  }
  markRead(token: string, noticeId: string) {
    return this.run(async (tx) => {
      const { accountId } = await this.identity.session(token, tx);
      await this.records.owner(accountId, tx, true);
      const row = await this.records.markRead(accountId, noticeId, tx);
      return ratingSubscriptionNoticeReadSchema.parse({
        noticeId: row.id,
        readAt: row.read_at,
        unreadCount: await this.records.count(accountId, tx),
      });
    });
  }
}
