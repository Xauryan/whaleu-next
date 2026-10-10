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
  ratingUnreadCountSchema,
  ratingUpdatesQuerySchema,
} from './contracts.js';
import type { RatingUpdatesQuery } from './contracts.js';
import {
  ratingLikeNoticeSchema,
  ratingLikeNoticeTargetSchema,
  ratingLikeUpdatesPageSchema,
} from './like-contracts.js';
import type {
  RatingLikeNotice,
  RatingLikeNoticeTarget,
  RatingLikeUpdatesPage,
} from './like-contracts.js';
import { RatingUpdatesCursors, ratingUpdatesCursorScope } from './cursor.js';
import { RatingUpdatesRepository } from './repository.js';
import type { StoredRatingLikeNotice } from './repository.js';

@Injectable()
export class RatingLikeUpdatesReadService {
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
    row: StoredRatingLikeNotice,
    tx: PoolClient,
  ): Promise<RatingLikeNotice> {
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
    const decision = await this.projection.eligibleLike(
      target,
      {
        accountId: row.recipient_account_id,
        reason: row.reason,
      },
      row.like_actor_account_id,
      tx,
    );
    return ratingLikeNoticeSchema.parse(
      decision.outcome === 'eligible' && !decision.mediaPreview
        ? {
            ...base,
            status: 'available',
            domain: 'ratings',
            kind: 'like',
            actor: decision.actor,
            reason: row.reason,
            target,
            preview: decision.preview,
          }
        : { ...base, status: 'unavailable' },
    );
  }
  list(
    token: string,
    input: RatingUpdatesQuery,
  ): Promise<RatingLikeUpdatesPage> {
    const query = ratingUpdatesQuerySchema.parse(input);
    return this.run(async (tx) => {
      await lockSafetyPolicy(tx);
      const session = await this.identity.session(token, tx);
      const scope = ratingUpdatesCursorScope(
        session.accountId,
        session.sessionId,
        token,
        query.limit,
        'like',
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
        'like',
      );
      const selected = rows.slice(0, query.limit),
        projected: RatingLikeNotice[] = [];
      for (const row of selected) projected.push(await this.project(row, tx));
      await this.identity.session(token, tx);
      // All parent/authority locks precede notification owner. After this point
      // only immutable coordinates, owner read state and navigation metadata remain.
      await this.records.owner(session.accountId, tx);
      const states = await this.records.states(
        session.accountId,
        selected.map((row) => row.id),
        tx,
        'like',
      );
      const items = projected.map((notice) => ({
        ...notice,
        readAt: states.get(notice.noticeId)!,
      }));
      const unreadCount = await this.records.count(
        session.accountId,
        tx,
        'like',
      );
      const nextCursor =
        rows.length > query.limit
          ? await this.cursors.create(
              session.accountId,
              scope,
              selected.at(-1)!.ordinal,
              tx,
            )
          : null;
      return ratingLikeUpdatesPageSchema.parse({
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
      return ratingUnreadCountSchema.parse({
        unreadCount: await this.records.count(accountId, tx, 'like'),
      });
    });
  }
  target(token: string, noticeId: string): Promise<RatingLikeNoticeTarget> {
    return this.run(async (tx) => {
      await lockSafetyPolicy(tx);
      const { accountId } = await this.identity.session(token, tx);
      const row = await this.records.own(accountId, noticeId, tx, 'like');
      const notice = await this.project(row, tx);
      await this.identity.session(token, tx);
      await this.records.owner(accountId, tx);
      await this.records.states(accountId, [row.id], tx, 'like');
      return ratingLikeNoticeTargetSchema.parse(
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
      const row = await this.records.markRead(accountId, noticeId, tx, 'like');
      return ratingNoticeReadSchema.parse({
        noticeId: row.id,
        readAt: row.read_at,
        unreadCount: await this.records.count(accountId, tx, 'like'),
      });
    });
  }
}
