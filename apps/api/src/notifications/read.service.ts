import { lockSafetyPolicy } from '../safety/locks.js';
import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.js';
import { IdentityService } from '../identity/identity.service.js';
import { CommunityUpdatesFacade } from '../community/updates.facade.js';
import type { PoolClient } from 'pg';
import { NotificationsRepository } from './repository.js';
import type { StoredNotice } from './repository.js';
import { encodeUpdatesCursor, updatesCursor } from './cursor.js';
import type { NoticeView, UpdatesPage, UpdatesQuery } from './contracts.js';
@Injectable()
export class UpdatesReadService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(NotificationsRepository)
    private readonly repository: NotificationsRepository,
    @Inject(CommunityUpdatesFacade)
    private readonly community: CommunityUpdatesFacade,
  ) {}
  private async project(
    row: StoredNotice,
    tx: PoolClient,
  ): Promise<NoticeView> {
    const base = {
      noticeId: row.id,
      createdAt: row.created_at.toISOString(),
      readAt: row.read_at?.toISOString() ?? null,
    };
    const target = {
      postId: row.post_id,
      commentId: row.comment_id,
      replyId: row.reply_id,
    };
    const decision = await this.community.eligible(
      target,
      {
        accountId: row.recipient_account_id,
        reason: row.reason,
        saveEpochId: row.save_epoch_id,
      },
      tx,
    );
    return decision.outcome === 'eligible'
      ? {
          ...base,
          status: 'available',
          kind: row.kind,
          reason: row.reason,
          target,
          preview: decision.preview,
        }
      : { ...base, status: 'unavailable' };
  }
  list(token: string, query: UpdatesQuery): Promise<UpdatesPage> {
    return this.database.transaction(async (tx) => {
      await lockSafetyPolicy(tx);
      const { accountId } = await this.identity.session(token, tx);
      const seek = updatesCursor(query.cursor, accountId, query.limit);
      await this.repository.owner(accountId, tx);
      const rows = await this.repository.page(accountId, query.limit, seek, tx);
      const page = rows.slice(0, query.limit),
        items: NoticeView[] = [];
      for (const row of page) items.push(await this.project(row, tx));
      const last = page.at(-1);
      const unreadCount = await this.repository.count(accountId, tx);
      await this.identity.session(token, tx);
      return {
        items,
        unreadCount,
        nextCursor:
          rows.length > query.limit && last
            ? encodeUpdatesCursor(
                last.created_at.toISOString(),
                last.id,
                accountId,
                query.limit,
              )
            : null,
      };
    });
  }
  unreadCount(token: string) {
    return this.database.transaction(async (tx) => {
      await lockSafetyPolicy(tx);
      const { accountId } = await this.identity.session(token, tx);
      await this.repository.owner(accountId, tx);
      const unreadCount = await this.repository.count(accountId, tx);
      await this.identity.session(token, tx);
      return { unreadCount };
    });
  }
  target(token: string, noticeId: string) {
    return this.database.transaction(async (tx) => {
      await lockSafetyPolicy(tx);
      const { accountId } = await this.identity.session(token, tx);
      await this.repository.owner(accountId, tx);
      const item = await this.project(
        await this.repository.own(accountId, noticeId, tx),
        tx,
      );
      await this.identity.session(token, tx);
      return item.status === 'available'
        ? {
            noticeId: item.noticeId,
            status: 'available' as const,
            target: item.target,
          }
        : { noticeId: item.noticeId, status: 'unavailable' as const };
    });
  }
  markRead(token: string, noticeId: string) {
    return this.database.transaction(async (tx) => {
      await lockSafetyPolicy(tx);
      const { accountId } = await this.identity.session(token, tx);
      await this.repository.owner(accountId, tx, true);
      const row = await this.repository.markRead(accountId, noticeId, tx);
      const unreadCount = await this.repository.count(accountId, tx);
      await this.identity.session(token, tx);
      return {
        noticeId: row.id,
        readAt: row.read_at!.toISOString(),
        unreadCount,
      };
    });
  }
}
