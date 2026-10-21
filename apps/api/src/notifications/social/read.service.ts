import { performance } from 'node:perf_hooks';
import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.js';
import {
  checkpointTransactionDeadlines,
  restoreTransactionDeadlines,
} from '../../database/transaction-deadlines.js';
import { configuredTimeout } from '../../database/optional-count.js';
import { IdentityService } from '../../identity/identity.service.js';
import {
  CommunitySocialSourceFacade,
  lockSocialSource,
  lockSocialSourceAccounts,
  socialSourceDeletionState,
} from '../../community/social-source/facade.js';
import { CommunitySocialProjectionFacade } from '../../community/social-source/projection.js';
import { ApplicationError } from '../../http/application-error.js';
import { AccountPolicy } from '../../safety/account-policy/decorator.js';
import { noticeContentAllowed } from '../../safety/account-policy/notice-projection.js';
import { lockSafetyPolicy } from '../../safety/locks.js';
import { enableSafetyRelationshipProof } from '../../safety/relationship-proof.js';
import { SocialUpdatesRepository } from './repository.js';
import type { StoredSocialNotice } from './repository.js';
import { SocialUpdatesCursors, socialCursorScope } from './cursor.js';
import {
  socialCategorySchema,
  socialIdSchema,
  socialNoticeSchema,
  socialNoticeReadSchema,
  socialNoticeTargetSchema,
  socialUpdatesPageSchema,
  socialUpdatesQuerySchema,
} from './contracts.js';
import type {
  SocialCategory,
  SocialNotice,
  SocialUnread,
  SocialUpdatesQuery,
} from './contracts.js';
const UNKNOWN: SocialUnread = {
  unreadCount: null,
  unreadCountStatus: 'unavailable',
};
export const SOCIAL_UNREAD_CANDIDATE_LIMIT = 32;
class CountUnavailable extends Error {}
@Injectable()
export class SocialUpdatesReadService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(SocialUpdatesRepository)
    private readonly records: SocialUpdatesRepository,
    @Inject(CommunitySocialSourceFacade)
    private readonly source: CommunitySocialSourceFacade,
    @Inject(CommunitySocialProjectionFacade)
    private readonly projection: CommunitySocialProjectionFacade,
    @Inject(SocialUpdatesCursors)
    private readonly cursors: SocialUpdatesCursors,
  ) {}
  private async project(
    row: StoredSocialNotice,
    tx: PoolClient,
    strict = false,
  ): Promise<SocialNotice> {
    const base = {
      noticeId: row.id,
      createdAt: row.created_at,
      readAt: row.read_at,
    };
    if (!(await noticeContentAllowed(row.recipient_account_id, tx)))
      return { ...base, status: 'unavailable' };
    const source = await this.source.source(row.source_id, tx);
    // Recipient authentication owns the account fence. Only that recipient's
    // erasure can remove this graph, so an active recipient cannot legitimately
    // observe a staged source removal behind a retained notice.
    if (
      !source ||
      source.recipientAccountId !== row.recipient_account_id ||
      source.kind !== row.kind
    )
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    const content = await this.projection.project(source, tx, strict);
    return socialNoticeSchema.parse(
      content
        ? { ...base, status: 'available', ...content }
        : { ...base, status: 'unavailable' },
    );
  }
  private async lockAcknowledgement(row: StoredSocialNotice, tx: PoolClient) {
    const source = await this.source.source(row.source_id, tx);
    if (
      !source ||
      source.recipientAccountId !== row.recipient_account_id ||
      source.kind !== row.kind
    )
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    const active = await lockSocialSourceAccounts(source, tx);
    await lockSocialSource(source.id, tx);
    const current = await this.source.source(source.id, tx);
    if (
      !current ||
      current.actorAccountId !== source.actorAccountId ||
      current.recipientAccountId !== source.recipientAccountId ||
      current.kind !== source.kind
    )
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    const deletion = await socialSourceDeletionState(source.id, tx);
    if (deletion.erasing || (!active && !deletion.retired))
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    // A retired sender does not revoke the recipient's first-read operation.
    // No profile lookup or target grant is needed for this acknowledgement.
  }
  /** Exact current-readable count or explicit unknown, never a prefix count.
   * All domain projections precede notification owner locks. NOWAIT table fences
   * also cover not-yet-dispatched source enrollment and absent unread rows. */
  private async count(
    account: string,
    category: SocialCategory,
    tx: PoolClient,
    exclude: string | null = null,
    write = false,
  ): Promise<SocialUnread> {
    const checkpoint = checkpointTransactionDeadlines(tx),
      until = performance.now() + 500;
    await tx.query('SAVEPOINT social_unread_count');
    try {
      const settings = (
        await tx.query<{ statement_timeout: string; lock_timeout: string }>(
          "SELECT current_setting('statement_timeout') statement_timeout,current_setting('lock_timeout') lock_timeout",
        )
      ).rows[0];
      if (!settings) throw new CountUnavailable();
      await tx.query(
        "SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$2,true)",
        [
          `${Math.min(20, configuredTimeout(settings.statement_timeout))}ms`,
          `${Math.min(1, configuredTimeout(settings.lock_timeout))}ms`,
        ],
      );
      if (await this.records.pending(account, category, tx))
        throw new CountUnavailable();
      const rows = await this.records.unread(
        account,
        category,
        SOCIAL_UNREAD_CANDIDATE_LIMIT + 1,
        tx,
        exclude,
      );
      if (rows.length > SOCIAL_UNREAD_CANDIDATE_LIMIT)
        throw new CountUnavailable();
      let count = 0;
      for (const row of rows) {
        if (performance.now() >= until) throw new CountUnavailable();
        if ((await this.project(row, tx, true)).status === 'available') count++;
      }
      if (performance.now() >= until) throw new CountUnavailable();
      await this.records.owner(account, tx, write);
      await tx.query(
        `LOCK TABLE whaleu_notifications.social_work,whaleu_notifications.social_notices IN ${write ? 'SHARE ROW EXCLUSIVE' : 'SHARE'} MODE NOWAIT`,
      );
      if (await this.records.pending(account, category, tx))
        throw new CountUnavailable();
      const current = await this.records.unread(
        account,
        category,
        SOCIAL_UNREAD_CANDIDATE_LIMIT + 1,
        tx,
        exclude,
      );
      if (
        current.length !== rows.length ||
        current.some((row, i) => row.id !== rows[i]!.id)
      )
        throw new CountUnavailable();
      await tx.query(
        "SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$2,true)",
        [settings.statement_timeout, settings.lock_timeout],
      );
      await tx.query('RELEASE SAVEPOINT social_unread_count');
      return { unreadCount: count, unreadCountStatus: 'available' };
    } catch (error) {
      await tx.query('ROLLBACK TO SAVEPOINT social_unread_count');
      await tx.query('RELEASE SAVEPOINT social_unread_count');
      restoreTransactionDeadlines(tx, checkpoint);
      if (
        error instanceof CountUnavailable ||
        (error instanceof ApplicationError &&
          [
            'COMMUNITY_UNAVAILABLE',
            'SAFETY_UNAVAILABLE',
            'CONTENT_REVIEW_UNAVAILABLE',
            'SAFETY_MODERATION_UNAVAILABLE',
          ].includes(error.code)) ||
        (typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          ['55P03', '57014', '53400'].includes(String(error.code)))
      )
        return { ...UNKNOWN };
      throw error;
    }
  }
  @AccountPolicy('restricted_self_service', 'restricted')
  list(token: string, input: SocialUpdatesQuery) {
    const query = socialUpdatesQuerySchema.parse(input);
    return this.database.transaction(
      async (tx) => {
        await lockSafetyPolicy(tx);
        enableSafetyRelationshipProof(tx);
        const session = await this.identity.session(token, tx);
        const scope = socialCursorScope(
          session.accountId,
          session.sessionId,
          token,
          query.category,
          query.limit,
        );
        const before = query.cursor
          ? await this.cursors.get(query.cursor, scope, tx)
          : null;
        const head =
          before?.head ??
          (await this.records.head(session.accountId, query.category, tx));
        const rows = await this.records.page(
            session.accountId,
            query.category,
            query.limit,
            before,
            tx,
          ),
          scanned = rows.slice(0, query.limit),
          selected = scanned.filter(
            (row) => BigInt(row.ordinal) <= BigInt(head),
          );
        const items: SocialNotice[] = [];
        for (const row of selected) items.push(await this.project(row, tx));
        await this.identity.session(token, tx);
        const unread = await this.count(session.accountId, query.category, tx);
        await this.records.owner(session.accountId, tx);
        for (const item of items)
          item.readAt = (
            await this.records.own(
              session.accountId,
              item.noticeId,
              query.category,
              tx,
            )
          ).read_at;
        const nextCursor =
          rows.length > query.limit
            ? await this.cursors.create(
                session.accountId,
                scope,
                {
                  head,
                  beforeAt: scanned.at(-1)!.created_at,
                  beforeOrdinal: scanned.at(-1)!.ordinal,
                },
                tx,
              )
            : null;
        return socialUpdatesPageSchema.parse({ items, nextCursor, ...unread });
      },
      { isolationLevel: 'read committed' },
    );
  }
  @AccountPolicy('restricted_self_service', 'restricted')
  unreadCount(token: string, input: SocialCategory) {
    const category = socialCategorySchema.parse(input);
    return this.database.transaction(
      async (tx) => {
        await lockSafetyPolicy(tx);
        enableSafetyRelationshipProof(tx);
        const { accountId } = await this.identity.session(token, tx);
        await this.identity.session(token, tx);
        const count = await this.count(accountId, category, tx);
        await this.records.owner(accountId, tx);
        return count;
      },
      { isolationLevel: 'read committed' },
    );
  }
  @AccountPolicy('browse', 'entry')
  target(token: string, id: string, input: SocialCategory) {
    const category = socialCategorySchema.parse(input);
    socialIdSchema.parse(id);
    return this.database.transaction(
      async (tx) => {
        await lockSafetyPolicy(tx);
        enableSafetyRelationshipProof(tx);
        const { accountId } = await this.identity.session(token, tx);
        const row = await this.records.own(accountId, id, category, tx),
          notice = await this.project(row, tx);
        await this.identity.session(token, tx);
        await this.records.owner(accountId, tx);
        return socialNoticeTargetSchema.parse(
          notice.status === 'available'
            ? { noticeId: id, status: 'available', target: notice.target }
            : { noticeId: id, status: 'unavailable' },
        );
      },
      { isolationLevel: 'read committed' },
    );
  }
  @AccountPolicy('restricted_self_service', 'restricted')
  markRead(token: string, id: string, input: SocialCategory) {
    const category = socialCategorySchema.parse(input);
    socialIdSchema.parse(id);
    return this.database.transaction(
      async (tx) => {
        await lockSafetyPolicy(tx);
        enableSafetyRelationshipProof(tx);
        const { accountId } = await this.identity.session(token, tx);
        const owned = await this.records.own(accountId, id, category, tx);
        await this.lockAcknowledgement(owned, tx);
        // Explicit unavailable notices remain dismissible. No target grant is returned.
        await this.identity.session(token, tx);
        const unread = await this.count(accountId, category, tx, id, true);
        await this.records.owner(accountId, tx, true);
        const row = await this.records.markRead(accountId, id, category, tx);
        return socialNoticeReadSchema.parse({
          noticeId: id,
          readAt: row.read_at,
          ...unread,
        });
      },
      { isolationLevel: 'read committed' },
    );
  }
}
