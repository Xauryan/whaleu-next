import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ZodError } from 'zod';
import { DatabaseService } from '../../database/database.js';
import { IdentityService } from '../../identity/identity.service.js';
import { ApplicationError } from '../../http/application-error.js';
import { lockSafetyPolicy } from '../../safety/locks.js';
import { RatingUpdatesProjectionFacade } from '../../ratings/updates-source/projection.js';
import {
  ratingNoticeReadSchema,
  ratingNoticeSchema,
  ratingNoticeTargetSchema,
  ratingUnreadCountSchema,
  ratingUpdatesPageSchema,
  ratingUpdatesQuerySchema,
} from './contracts.js';
import type {
  RatingNotice,
  RatingNoticeTarget,
  RatingUpdatesPage,
  RatingUpdatesQuery,
} from './contracts.js';
import { RatingUpdatesCursors, ratingUpdatesCursorScope } from './cursor.js';
import { RatingUpdatesRepository } from './repository.js';
import type { StoredRatingNotice } from './repository.js';

@Injectable()
export class RatingUpdatesReadService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(RatingUpdatesRepository)
    private readonly records: RatingUpdatesRepository,
    @Inject(RatingUpdatesProjectionFacade)
    private readonly projection: RatingUpdatesProjectionFacade,
    @Inject(RatingUpdatesCursors)
    private readonly cursors: RatingUpdatesCursors,
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
    row: StoredRatingNotice,
    tx: PoolClient,
  ): Promise<RatingNotice> {
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
      {
        accountId: row.recipient_account_id,
        reason: row.reason,
      },
      tx,
    );
    return ratingNoticeSchema.parse(
      decision.outcome === 'eligible'
        ? {
            ...base,
            status: 'available',
            domain: 'ratings',
            kind: 'reply',
            reason: row.reason,
            target,
            preview: decision.preview,
          }
        : { ...base, status: 'unavailable' },
    );
  }
  list(token: string, input: RatingUpdatesQuery): Promise<RatingUpdatesPage> {
    const query = ratingUpdatesQuerySchema.parse(input);
    return this.run(async (tx) => {
      await lockSafetyPolicy(tx);
      const session = await this.identity.session(token, tx);
      const scope = ratingUpdatesCursorScope(
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
        projected: RatingNotice[] = [];
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
      return ratingUpdatesPageSchema.parse({ items, nextCursor, unreadCount });
    });
  }
  unreadCount(token: string) {
    return this.run(async (tx) => {
      const { accountId } = await this.identity.session(token, tx);
      await this.records.owner(accountId, tx);
      return ratingUnreadCountSchema.parse({
        unreadCount: await this.records.count(accountId, tx),
      });
    });
  }
  target(token: string, noticeId: string): Promise<RatingNoticeTarget> {
    return this.run(async (tx) => {
      await lockSafetyPolicy(tx);
      const { accountId } = await this.identity.session(token, tx);
      const row = await this.records.own(accountId, noticeId, tx);
      const notice = await this.project(row, tx);
      await this.identity.session(token, tx);
      await this.records.owner(accountId, tx);
      await this.records.states(accountId, [row.id], tx);
      return ratingNoticeTargetSchema.parse(
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
      return ratingNoticeReadSchema.parse({
        noticeId: row.id,
        readAt: row.read_at,
        unreadCount: await this.records.count(accountId, tx),
      });
    });
  }
}
