import { noticeContentAllowed } from '../../safety/account-policy/notice-projection.js';
import { AccountPolicy } from '../../safety/account-policy/decorator.js';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.js';
import { ApplicationError } from '../../http/application-error.js';
import { IdentityService } from '../../identity/identity.service.js';
import { lockSafetyPolicy } from '../../safety/locks.js';
import { enableSafetyRelationshipProof } from '../../safety/relationship-proof.js';
import { FeedbackNoticeAuthority } from './authority.js';
import { FeedbackNoticeTargetSource } from './contracts.js';
import type {
  FeedbackNoticeRead,
  FeedbackNoticeTarget,
  FeedbackNoticesPage,
  FeedbackNoticesQuery,
} from './contracts.js';
import {
  encodeFeedbackNoticesCursor,
  feedbackNoticesCursor,
} from './cursor.js';
import { FeedbackNoticesRepository } from './repository.js';

@Injectable()
export class FeedbackNoticesService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(FeedbackNoticeAuthority)
    private readonly authority: FeedbackNoticeAuthority,
    @Inject(FeedbackNoticesRepository)
    private readonly repository: FeedbackNoticesRepository,
    @Inject(FeedbackNoticeTargetSource)
    private readonly targets: FeedbackNoticeTargetSource,
  ) {}
  private async transaction<T>(
    work: (tx: PoolClient) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.database.transaction(work, {
        isolationLevel: 'read committed',
      });
    } catch (error) {
      if (
        error instanceof ApplicationError ||
        error instanceof BadRequestException
      )
        throw error;
      throw new ApplicationError('SYSTEM_NOTICES_UNAVAILABLE');
    }
  }
  private async actor(token: string, tx: PoolClient): Promise<string> {
    await lockSafetyPolicy(tx);
    const { accountId } = await this.identity.session(token, tx);
    await this.authority.require(accountId, tx);
    return accountId;
  }
  private async finish(
    token: string,
    accountId: string,
    tx: PoolClient,
  ): Promise<void> {
    await this.identity.session(token, tx);
    await this.authority.require(accountId, tx);
  }
  @AccountPolicy('restricted_self_service', 'restricted')
  list(
    token: string,
    query: FeedbackNoticesQuery,
  ): Promise<FeedbackNoticesPage> {
    return this.transaction(async (tx) => {
      const accountId = await this.actor(token, tx);
      const seek = feedbackNoticesCursor(query.cursor, accountId, query.limit);
      await this.repository.owner(accountId, tx);
      await this.repository.rate(accountId, tx);
      const rows = await this.repository.page(accountId, query.limit, seek, tx);
      const page = rows.slice(0, query.limit),
        last = page.at(-1);
      const unreadCount = await this.repository.count(accountId, tx);
      await this.finish(token, accountId, tx);
      return {
        // No historical text, target locator or identity leaves the list.
        items: page.map((row) => ({
          noticeId: row.id,
          kind: row.kind,
          createdAt: row.created_at.toISOString(),
          readAt: row.read_at?.toISOString() ?? null,
        })),
        nextCursor:
          rows.length > query.limit && last
            ? encodeFeedbackNoticesCursor(
                last.created_at.toISOString(),
                last.id,
                accountId,
                query.limit,
              )
            : null,
        unreadCount,
      };
    });
  }
  @AccountPolicy('restricted_self_service', 'restricted')
  unreadCount(token: string): Promise<{ unreadCount: number }> {
    return this.transaction(async (tx) => {
      const accountId = await this.actor(token, tx);
      await this.repository.owner(accountId, tx);
      await this.repository.rate(accountId, tx);
      const unreadCount = await this.repository.count(accountId, tx);
      await this.finish(token, accountId, tx);
      return { unreadCount };
    });
  }
  @AccountPolicy('browse', 'entry')
  target(token: string, noticeId: string): Promise<FeedbackNoticeTarget> {
    return this.transaction(async (tx) => {
      enableSafetyRelationshipProof(tx);
      const accountId = await this.actor(token, tx);
      const row = await this.repository.own(accountId, noticeId, tx);
      const available = await this.targets.accessible(
        accountId,
        row.post_id,
        tx,
      );
      // Content/source locks precede notification-owner locks in publication,
      // navigation and read acknowledgments, avoiding a reverse lock order.
      await this.repository.owner(accountId, tx);
      await this.repository.rate(accountId, tx);
      await this.finish(token, accountId, tx);
      return available
        ? { noticeId: row.id, status: 'available', postId: row.post_id }
        : { noticeId: row.id, status: 'unavailable' };
    });
  }
  @AccountPolicy('restricted_self_service', 'restricted')
  markRead(token: string, noticeId: string): Promise<FeedbackNoticeRead> {
    return this.transaction(async (tx) => {
      enableSafetyRelationshipProof(tx);
      const accountId = await this.actor(token, tx);
      const owned = await this.repository.own(accountId, noticeId, tx);
      if (
        (await noticeContentAllowed(accountId, tx)) &&
        !(await this.targets.accessible(accountId, owned.post_id, tx))
      )
        throw new ApplicationError('NOTICE_NOT_FOUND');
      await this.repository.owner(accountId, tx, true);
      await this.repository.rate(accountId, tx);
      const row = await this.repository.markRead(accountId, noticeId, tx);
      const unreadCount = await this.repository.count(accountId, tx);
      await this.finish(token, accountId, tx);
      return {
        noticeId: row.id,
        readAt: row.read_at!.toISOString(),
        unreadCount,
      };
    });
  }
}
