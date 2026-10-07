import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.js';
import { ApplicationError } from '../../http/application-error.js';
import { IdentityService } from '../../identity/identity.service.js';
import { postJuryRemovalNoticeSchema } from './contracts.js';
import type {
  PostJuryRemovalNotice,
  SystemNoticeView,
  SystemNoticesPage,
  SystemNoticesQuery,
} from './contracts.js';
import { encodeSystemNoticesCursor, systemNoticesCursor } from './cursor.js';
import { SystemNoticesRepository } from './repository.js';
import type { StoredSystemNotice } from './repository.js';

const project = (row: StoredSystemNotice): SystemNoticeView => ({
  noticeId: row.id,
  kind: row.kind,
  createdAt: row.created_at.toISOString(),
  readAt: row.read_at?.toISOString() ?? null,
  keepVotes: row.keep_votes,
  removeVotes: row.remove_votes,
});

@Injectable()
export class SystemNoticesService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(SystemNoticesRepository)
    private readonly repository: SystemNoticesRepository,
  ) {}
  private async transaction<T>(
    work: (tx: PoolClient) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.database.transaction(work);
    } catch (error) {
      if (
        error instanceof ApplicationError ||
        error instanceof BadRequestException
      )
        throw error;
      throw new ApplicationError('SYSTEM_NOTICES_UNAVAILABLE');
    }
  }
  list(token: string, query: SystemNoticesQuery): Promise<SystemNoticesPage> {
    return this.transaction(async (tx) => {
      const { accountId } = await this.identity.session(token, tx);
      const seek = systemNoticesCursor(query.cursor, accountId, query.limit);
      await this.repository.owner(accountId, tx);
      await this.repository.rate(accountId, tx);
      const rows = await this.repository.page(accountId, query.limit, seek, tx);
      const page = rows.slice(0, query.limit);
      const last = page.at(-1);
      const unreadCount = await this.repository.count(accountId, tx);
      await this.identity.session(token, tx);
      return {
        items: page.map(project),
        nextCursor:
          rows.length > query.limit && last
            ? encodeSystemNoticesCursor(
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
  unreadCount(token: string): Promise<{ unreadCount: number }> {
    return this.transaction(async (tx) => {
      const { accountId } = await this.identity.session(token, tx);
      await this.repository.owner(accountId, tx);
      await this.repository.rate(accountId, tx);
      const unreadCount = await this.repository.count(accountId, tx);
      await this.identity.session(token, tx);
      return { unreadCount };
    });
  }
  markRead(
    token: string,
    noticeId: string,
  ): Promise<{ noticeId: string; readAt: string; unreadCount: number }> {
    return this.transaction(async (tx) => {
      const { accountId } = await this.identity.session(token, tx);
      await this.repository.owner(accountId, tx, true);
      await this.repository.rate(accountId, tx);
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
  async appendPostJuryRemoval(
    input: PostJuryRemovalNotice,
    tx: PoolClient,
  ): Promise<void> {
    try {
      // The reporting owner supplies its existing settlement transaction. This
      // method never starts or commits a separate notification transaction.
      const parsed = postJuryRemovalNoticeSchema.parse(input);
      await this.repository.owner(parsed.ownerAccountId, tx, true);
      await this.repository.append(parsed, tx);
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw new ApplicationError('SYSTEM_NOTICES_UNAVAILABLE');
    }
  }
}
