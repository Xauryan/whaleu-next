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
  kind:
    | 'accepted'
    | 'completed'
    | 'admin_deleted'
    | 'feature_restricted'
    | 'feature_released';
  order_id: string | null;
  deletion_reason: string | null;
  restriction_id: string | null;
  event_id: string | null;
  action: 'publish' | 'accept' | 'all' | null;
  reason: string | null;
  starts_at: string | null;
  ends_at: string | null;
  released_at: string | null;
  created_at: string;
  read_at: string | null;
}
const utc = (field: string) =>
  `to_char(${field} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
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
            `SELECT id,kind,order_id,deletion_reason,restriction_id,event_id,action,reason,
              ${utc('starts_at')} starts_at,${utc('ends_at')} ends_at,${utc('released_at')} released_at,
              ${utc('created_at')} created_at,${utc('read_at')} read_at FROM (
              SELECT id,kind,order_id,deletion_reason,NULL::uuid restriction_id,NULL::uuid event_id,NULL::text action,NULL::text reason,NULL::timestamptz starts_at,NULL::timestamptz ends_at,NULL::timestamptz released_at,created_at,read_at FROM whaleu_notifications.errand_notices WHERE recipient_account_id=$1
              UNION ALL SELECT id,kind,NULL::uuid,NULL::text,restriction_id,event_id,action,reason,starts_at,ends_at,released_at,created_at,read_at FROM whaleu_notifications.errand_feature_notices WHERE recipient_account_id=$1
              ) n WHERE ($2::timestamptz IS NULL OR (created_at,id)<($2::timestamptz,$3::uuid)) ORDER BY created_at DESC,id DESC LIMIT $4`,
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
                { v: 1, createdAt: last.created_at, id: last.id },
                tx,
              )
            : null;
        return errandNoticesPageSchema.parse({
          items: page.map((r) => {
            const base = {
              noticeId: r.id,
              kind: r.kind,
              createdAt: r.created_at,
              readAt: r.read_at,
            };
            if (r.kind === 'accepted' || r.kind === 'completed')
              return { ...base, orderId: r.order_id };
            if (r.kind === 'admin_deleted')
              return {
                ...base,
                orderId: r.order_id,
                deletionReason:
                  r.deletion_reason === ''
                    ? { status: 'not_provided' }
                    : { status: 'provided', value: r.deletion_reason },
              };
            const feature = {
              ...base,
              restrictionId: r.restriction_id,
              eventId: r.event_id,
              action: r.action,
              reason: r.reason,
            };
            return r.kind === 'feature_restricted'
              ? { ...feature, startsAt: r.starts_at, endsAt: r.ends_at }
              : { ...feature, releasedAt: r.released_at };
          }),
          nextCursor,
          unreadCount,
        });
      },
      { isolationLevel: 'read committed' },
    );
  }
  count(token: string) {
    return this.db.transaction(
      async (tx) => {
        const s = await this.actor(token, tx);
        const unreadCount = await this.records.count(s.accountId, tx);
        await this.identity.session(token, tx);
        return { unreadCount };
      },
      { isolationLevel: 'read committed' },
    );
  }
  markRead(token: string, id: string) {
    return this.db.transaction(
      async (tx) => {
        const s = await this.actor(token, tx);
        const source = (
          await tx.query<{ source: 'order' | 'restriction' }>(
            'SELECT source FROM whaleu_notifications.errand_notice_identities WHERE id=$1',
            [id],
          )
        ).rows[0]?.source;
        if (!source) throw new ApplicationError('ERRAND_NOT_FOUND');
        const table =
          source === 'order' ? 'errand_notices' : 'errand_feature_notices';
        const row = (
          await tx.query<{ id: string; read_at: string }>(
            `UPDATE whaleu_notifications.${table} SET read_at=coalesce(read_at,clock_timestamp()) WHERE id=$1 AND recipient_account_id=$2 RETURNING id,${utc('read_at')} read_at`,
            [id, s.accountId],
          )
        ).rows[0];
        if (!row) throw new ApplicationError('ERRAND_NOT_FOUND');
        const unreadCount = await this.records.count(s.accountId, tx);
        await this.identity.session(token, tx);
        return errandNoticeReadSchema.parse({
          noticeId: row.id,
          readAt: row.read_at,
          unreadCount,
        });
      },
      { isolationLevel: 'read committed' },
    );
  }
}
