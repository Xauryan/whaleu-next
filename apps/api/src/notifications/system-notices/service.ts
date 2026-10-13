import { AccountPolicy } from '../../safety/account-policy/decorator.js';
import { AccountPunishmentOwner } from '../../safety/account-moderation/owner.js';
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

// Stateless leaf owner; notice reads do not import the administration module or
// require current content/grant/phone eligibility of the punished account.
const punishmentReader = new AccountPunishmentOwner();
const unknownNotice = (_row: never): never => {
  throw new ApplicationError('SYSTEM_NOTICES_UNAVAILABLE');
};

const project = (row: StoredSystemNotice): SystemNoticeView => {
  const base = {
    noticeId: row.id,
    createdAt: row.created_at.toISOString(),
    readAt: row.read_at?.toISOString() ?? null,
  };
  switch (row.kind) {
    case 'account_punishment_issued':
    case 'account_punishment_released':
      return { ...base, kind: row.kind, punishment: row.punishment };
    case 'account_appeal_decided':
      return {
        ...base,
        kind: row.kind,
        appealId: row.appeal_id,
        outcome: row.outcome,
        reason: row.reason,
      };
    case 'post_jury_removed':
      return {
        ...base,
        kind: row.kind,
        keepVotes: row.keep_votes,
        removeVotes: row.remove_votes,
      };
    case 'profile_nickname_reset':
      return { ...base, kind: row.kind, nickname: row.nickname };
    case 'profile_custom_avatar_cleared':
    case 'admin_post_removed':
    case 'admin_discussion_removed':
      return { ...base, kind: row.kind };
    default:
      return unknownNotice(row);
  }
};

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
  @AccountPolicy('restricted_self_service', 'restricted')
  list(token: string, query: SystemNoticesQuery): Promise<SystemNoticesPage> {
    return this.transaction(async (tx) => {
      const { accountId } = await this.identity.session(token, tx);
      const seek = systemNoticesCursor(query.cursor, accountId, query.limit);
      await this.repository.owner(accountId, tx);
      await this.repository.rate(accountId, tx);
      const rows = await this.repository.page(accountId, query.limit, seek, tx);
      const page = rows.slice(0, query.limit);
      for (const row of page) {
        if (
          row.kind === 'account_punishment_issued' ||
          row.kind === 'account_punishment_released'
        )
          row.punishment = await punishmentReader.view(
            row.punishment.punishmentId,
            tx,
          );
      }
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
                last.kind,
              )
            : null,
        unreadCount,
      };
    });
  }
  @AccountPolicy('restricted_self_service', 'restricted')
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
  @AccountPolicy('restricted_self_service', 'restricted')
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
