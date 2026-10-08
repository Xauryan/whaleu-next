import { BadRequestException, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import type { ExperienceAction, RecordAction } from './catalog.js';
import type {
  ExperiencePageQuery,
  ExperienceReceipt,
  ExperienceRecord,
  UnlockNotice,
} from './contracts.js';
export interface AccountState {
  owner_id: string;
  balance: string;
  last_signin_day: string | null;
  streak: number;
  revision: string;
  history_coverage: 'complete' | 'partial';
  entitlement_coverage: 'complete' | 'partial';
}
export interface WorkRow {
  unit_id: string;
  group_id: string;
  beneficiary_id: string;
  action: ExperienceAction;
  enrollment_order: string;
  state: 'pending' | 'blocked_baseline' | 'completed';
}
export interface BucketRow {
  rewarded_count: number;
  refund_count: number;
  gross_positive_awarded: string;
}
@Injectable()
export class ExperienceClock {
  async now(tx: PoolClient): Promise<{ at: Date; day: string }> {
    const row = (
      await tx.query<{ at: Date; day: string }>(
        "SELECT at,(at AT TIME ZONE 'Asia/Shanghai')::date::text AS day FROM (SELECT date_trunc('milliseconds',clock_timestamp()) AS at) clock",
      )
    ).rows[0]!;
    return row;
  }
}
@Injectable()
export class ExperienceRepository {
  async state(owner: string, tx: PoolClient): Promise<AccountState | null> {
    return (
      (
        await tx.query<AccountState>(
          'SELECT s.owner_id,s.balance::text,s.last_signin_day::text,s.streak,s.revision::text,b.history_coverage,b.entitlement_coverage FROM whaleu_experience.account_states s JOIN whaleu_experience.baselines b ON b.owner_id=s.owner_id WHERE s.owner_id=$1',
          [owner],
        )
      ).rows[0] ?? null
    );
  }
  async pending(owner: string, tx: PoolClient): Promise<number> {
    return Number(
      (
        await tx.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM whaleu_experience.work WHERE beneficiary_id=$1 AND state<>'completed'",
          [owner],
        )
      ).rows[0]!.count,
    );
  }
  async first(owner: string, tx: PoolClient): Promise<WorkRow | null> {
    return (
      (
        await tx.query<WorkRow>(
          "SELECT * FROM whaleu_experience.work WHERE beneficiary_id=$1 AND state<>'completed' ORDER BY enrollment_order,unit_id LIMIT 1",
          [owner],
        )
      ).rows[0] ?? null
    );
  }
  async work(unit: string, tx: PoolClient): Promise<WorkRow | null> {
    return (
      (
        await tx.query<WorkRow>(
          'SELECT * FROM whaleu_experience.work WHERE unit_id=$1',
          [unit],
        )
      ).rows[0] ?? null
    );
  }
  async bucket(
    owner: string,
    day: string,
    action: string,
    tx: PoolClient,
  ): Promise<BucketRow> {
    return (
      (
        await tx.query<BucketRow>(
          'SELECT rewarded_count,refund_count,gross_positive_awarded::text FROM whaleu_experience.daily_buckets WHERE owner_id=$1 AND reward_day=$2 AND action=$3',
          [owner, day, action],
        )
      ).rows[0] ?? {
        rewarded_count: 0,
        refund_count: 0,
        gross_positive_awarded: '0',
      }
    );
  }
  async request(owner: string, request: string, tx: PoolClient) {
    return (
      (
        await tx.query<{
          intent_hash: string;
          intent_key_version: string | null;
          operation: string;
          receipt: ExperienceReceipt;
        }>(
          'SELECT intent_hash,intent_key_version,operation,receipt FROM whaleu_experience.requests WHERE owner_id=$1 AND request_id=$2',
          [owner, request],
        )
      ).rows[0] ?? null
    );
  }
  async requestLock(owner: string, request: string, tx: PoolClient) {
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      JSON.stringify(['experience-request', owner, request]),
    ]);
  }
  async saveReceipt(
    owner: string,
    hash: string,
    receipt: ExperienceReceipt,
    tx: PoolClient,
    keyVersion: string | null = null,
  ) {
    await tx.query(
      'INSERT INTO whaleu_experience.requests(owner_id,request_id,operation,intent_hash,receipt,intent_key_version) VALUES($1,$2,$3,$4,$5::jsonb,$6)',
      [
        owner,
        receipt.requestId,
        receipt.operation,
        hash,
        JSON.stringify(receipt),
        keyVersion,
      ],
    );
  }
  async recordPage(
    owner: string,
    query: ExperiencePageQuery,
    tx: PoolClient,
  ): Promise<{ items: ExperienceRecord[]; nextCursor: string | null }> {
    let order: string | null = null;
    if (query.cursor) {
      const decoded = Buffer.from(query.cursor, 'base64url').toString('utf8');
      if (
        Buffer.from(decoded).toString('base64url') !== query.cursor ||
        !/^experience1:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
          decoded,
        )
      )
        throw new BadRequestException();
      order =
        (
          await tx.query<{ recorded_order: string }>(
            'SELECT recorded_order::text FROM whaleu_experience.records WHERE owner_id=$1 AND id=$2',
            [owner, decoded.slice(12)],
          )
        ).rows[0]?.recorded_order ?? null;
      if (order === null) throw new BadRequestException();
    }
    const rows = (
      await tx.query<{
        id: string;
        action: RecordAction;
        nominal_delta: string | null;
        applied_delta: string | null;
        balance_after: string | null;
        outcome: ExperienceRecord['outcome'];
        occurred_at: Date | null;
        applied_at: Date | null;
        recorded_at: Date;
      }>(
        'SELECT id,action,nominal_delta::text,applied_delta::text,balance_after::text,outcome,occurred_at,applied_at,recorded_at FROM whaleu_experience.records WHERE owner_id=$1 AND ($2::bigint IS NULL OR recorded_order<$2) ORDER BY recorded_order DESC LIMIT $3',
        [owner, order, query.limit + 1],
      )
    ).rows;
    const items = rows.slice(0, query.limit).map((r): ExperienceRecord => ({
      recordId: r.id,
      action: r.action,
      nominalDelta: r.nominal_delta,
      appliedDelta: r.applied_delta,
      balanceAfter: r.balance_after,
      outcome: r.outcome,
      occurredAt: r.occurred_at?.toISOString() ?? null,
      appliedAt: r.applied_at?.toISOString() ?? null,
      recordedAt: r.recorded_at.toISOString(),
    }));
    return {
      items,
      nextCursor:
        rows.length > query.limit
          ? Buffer.from(`experience1:${items.at(-1)!.recordId}`).toString(
              'base64url',
            )
          : null,
    };
  }
  async notices(owner: string, tx: PoolClient): Promise<UnlockNotice[]> {
    return (
      await tx.query<{
        id: string;
        from_level: number;
        to_level: number;
        title_keys: string[];
        color_ids: number[];
        created_at: Date;
      }>(
        'SELECT id,from_level,to_level,title_keys,color_ids,created_at FROM whaleu_experience.unlock_notices WHERE owner_id=$1 AND acknowledged_at IS NULL ORDER BY created_at,id LIMIT 50',
        [owner],
      )
    ).rows.map((r) => ({
      noticeId: r.id,
      fromLevel: r.from_level,
      toLevel: r.to_level,
      titleKeys: r.title_keys,
      colorIds: r.color_ids,
      createdAt: r.created_at.toISOString(),
    }));
  }
  async acknowledge(owner: string, id: string, tx: PoolClient) {
    const found = (
      await tx.query<{ acknowledged_at: Date | null }>(
        'SELECT acknowledged_at FROM whaleu_experience.unlock_notices WHERE owner_id=$1 AND id=$2',
        [owner, id],
      )
    ).rows[0];
    if (!found) throw new ApplicationError('EXPERIENCE_UNLOCK_NOT_FOUND');
    if (!found.acknowledged_at)
      await tx.query(
        'UPDATE whaleu_experience.unlock_notices SET acknowledged_at=clock_timestamp() WHERE owner_id=$1 AND id=$2 AND acknowledged_at IS NULL',
        [owner, id],
      );
    return { noticeId: id, acknowledged: true as const };
  }
}
