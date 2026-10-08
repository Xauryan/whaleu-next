import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { DatabaseService } from '../database/database.js';
import { IdentityService } from '../identity/identity.service.js';
import { LocalSafetyPhoneSource } from '../verification/safety-phone.source.js';
import { SafetyErrandFacade } from '../safety/errand.facade.js';
import { lockSafetyPolicy } from '../safety/locks.js';
import { registerTransactionDeadline } from '../database/transaction-deadlines.js';
import {
  DiscoveryContinuationFacade,
  discoveryContinuationScope,
} from '../community/discovery-continuation.module.js';
import { ApplicationError } from '../http/application-error.js';
import { ErrandNotificationsFacade } from './errand.facade.js';
import {
  errandNoticesPageSchema,
  errandNoticeReadSchema,
} from './errand-contracts.js';
import type { ErrandNoticeQuery } from './errand-contracts.js';
const seekSchema = z.strictObject({
  v: z.literal(1),
  createdAt: z.iso.datetime({ offset: true }),
  id: z.uuid(),
});
interface Row {
  id: string;
  kind: 'accepted' | 'completed';
  order_id: string;
  created_at: Date;
  read_at: Date | null;
}
@Injectable()
export class ErrandNoticesService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(LocalSafetyPhoneSource)
    private readonly phone: LocalSafetyPhoneSource,
    @Inject(SafetyErrandFacade) private readonly safety: SafetyErrandFacade,
    @Inject(ErrandNotificationsFacade)
    private readonly records: ErrandNotificationsFacade,
    @Inject(DiscoveryContinuationFacade)
    private readonly cursors: DiscoveryContinuationFacade,
  ) {}
  private async actor(token: string, tx: PoolClient) {
    await lockSafetyPolicy(tx);
    const session = await this.identity.session(token, tx);
    const phone = await this.phone.resolve(session.accountId, tx);
    if (phone.status === 'unverified')
      throw new ApplicationError('PHONE_VERIFICATION_REQUIRED');
    if (phone.status !== 'verified')
      throw new ApplicationError('VERIFICATION_UNAVAILABLE');
    registerTransactionDeadline(
      tx,
      phone.validUntil,
      'VERIFICATION_UNAVAILABLE',
    );
    await this.safety.requireAllowed(session.accountId, tx);
    await this.records.owner(session.accountId, tx);
    return session;
  }
  list(token: string, query: ErrandNoticeQuery) {
    return this.db.transaction(
      async (tx) => {
        const session = await this.actor(token, tx),
          scope = discoveryContinuationScope([
            'errand-notices-v1',
            session.accountId,
            session.sessionId,
            query.limit,
          ]);
        const seek = query.cursor
          ? await this.cursors.get(query.cursor, scope, tx, (v) =>
              seekSchema.parse(v),
            )
          : null;
        const rows = (
          await tx.query<Row>(
            'SELECT id,kind,order_id,created_at,read_at FROM whaleu_notifications.errand_notices WHERE recipient_account_id=$1 AND ($2::timestamptz IS NULL OR (created_at,id)<($2::timestamptz,$3::uuid)) ORDER BY created_at DESC,id DESC LIMIT $4',
            [
              session.accountId,
              seek?.createdAt ?? null,
              seek?.id ?? null,
              query.limit + 1,
            ],
          )
        ).rows;
        const page = rows.slice(0, query.limit),
          last = page.at(-1),
          unreadCount = await this.records.count(session.accountId, tx);
        await this.identity.session(token, tx);
        const nextCursor =
          rows.length > query.limit && last
            ? await this.cursors.create(
                scope,
                session.accountId,
                { v: 1, createdAt: last.created_at.toISOString(), id: last.id },
                tx,
              )
            : null;
        return errandNoticesPageSchema.parse({
          items: page.map((r) => ({
            noticeId: r.id,
            kind: r.kind,
            orderId: r.order_id,
            createdAt: r.created_at.toISOString(),
            readAt: r.read_at?.toISOString() ?? null,
          })),
          nextCursor,
          unreadCount,
        });
      },
      { isolationLevel: 'read committed' },
    );
  }
  count(token: string) {
    return this.db.transaction(async (tx) => {
      const s = await this.actor(token, tx);
      const unreadCount = await this.records.count(s.accountId, tx);
      await this.identity.session(token, tx);
      return { unreadCount };
    });
  }
  markRead(token: string, id: string) {
    return this.db.transaction(async (tx) => {
      const s = await this.actor(token, tx);
      const row = (
        await tx.query<{ id: string; read_at: Date }>(
          "UPDATE whaleu_notifications.errand_notices SET read_at=coalesce(read_at,date_trunc('milliseconds',clock_timestamp())) WHERE id=$1 AND recipient_account_id=$2 RETURNING id,read_at",
          [id, s.accountId],
        )
      ).rows[0];
      if (!row) throw new ApplicationError('ERRAND_NOT_FOUND');
      const unreadCount = await this.records.count(s.accountId, tx);
      await this.identity.session(token, tx);
      return errandNoticeReadSchema.parse({
        noticeId: row.id,
        readAt: row.read_at.toISOString(),
        unreadCount,
      });
    });
  }
}
