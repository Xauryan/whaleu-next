import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import { registerTransactionDeadline } from '../database/transaction-deadlines.js';
import type { ActivitySelection, ActivityVisitReceipt } from './contracts.js';
import type { StoredActivity } from './projection.js';
export const ACTIVITY_ORDERING_VERSION = 'source-created-desc-v1';
export interface ActivityCatalog {
  id: string;
  regionId: string;
  orderingVersion: typeof ACTIVITY_ORDERING_VERSION;
}
interface Evidence {
  coverage: string;
  provenance: string;
  effective_at: Date;
  expiry_kind: string;
  valid_until: Date | null;
  source_reference: string;
  policy_reference: string;
}
interface CatalogRow extends Evidence {
  id: string;
  region_id: string;
  sealed: boolean;
  ordering_version: string;
  ordering_reference: string;
}
function evidenceValid(row: Evidence, now: number) {
  return (
    row.coverage === 'complete' &&
    row.provenance === 'accepted' &&
    !!row.source_reference.trim() &&
    !!row.policy_reference.trim() &&
    Number.isFinite(row.effective_at.getTime()) &&
    row.effective_at.getTime() <= now &&
    ((row.expiry_kind === 'policy_exempt' && row.valid_until === null) ||
      (row.expiry_kind === 'at' &&
        row.valid_until !== null &&
        Number.isFinite(row.valid_until.getTime()) &&
        row.valid_until.getTime() > now &&
        row.valid_until.getTime() > row.effective_at.getTime()))
  );
}
const utc = (field: string) =>
  `to_char((${field}) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const visible = `e.lifecycle='active' AND e.publication_state='approved' AND e.approval_provenance='accepted' AND e.approved_content_revision=e.content_revision_id AND r.sealed AND r.provenance='accepted'`;
const from = `FROM whaleu_activities.catalog_entries e JOIN whaleu_activities.content_revisions r ON r.id=e.content_revision_id AND r.activity_id=e.activity_id AND r.region_id=e.region_id WHERE e.catalog_revision_id=$1 AND e.region_id=$2 AND ${visible}`;
const projection = `e.activity_id id,r.id revision,r.region_id,e.display_ordinal::text,r.title,r.body_text,r.organizer_label,r.activity_time,r.activity_location,r.reward,r.online,${utc('r.source_created_at')} source_created_at,r.cover_state,r.avatar_state,r.gallery_state,r.qr_state`;
const receiptProjection = `request_id "requestId",region_id "regionId",catalog_revision_id "catalogRevision",${utc('visited_at')} "visitedAt"`;
@Injectable()
export class ActivitiesRepository {
  async catalog(regionId: string, tx: PoolClient): Promise<ActivityCatalog> {
    // Head lock first, referenced immutable revision in a new READ COMMITTED statement.
    const head = (
      await tx.query<{ revision_id: string }>(
        'SELECT revision_id FROM whaleu_activities.catalog_head WHERE region_id=$1 FOR SHARE',
        [regionId],
      )
    ).rows[0];
    if (!head) throw new ApplicationError('ACTIVITY_UNAVAILABLE');
    const row = (
      await tx.query<CatalogRow>(
        'SELECT * FROM whaleu_activities.catalog_revisions WHERE id=$1 FOR SHARE',
        [head.revision_id],
      )
    ).rows[0];
    const now = (
      await tx.query<{ now: Date }>('SELECT clock_timestamp() now')
    ).rows[0]!.now.getTime();
    if (
      !row ||
      !row.sealed ||
      row.region_id !== regionId ||
      row.ordering_version !== ACTIVITY_ORDERING_VERSION ||
      !row.ordering_reference.trim() ||
      !evidenceValid(row, now)
    )
      throw new ApplicationError('ACTIVITY_UNAVAILABLE');
    registerTransactionDeadline(
      tx,
      row.valid_until?.getTime() ?? null,
      'ACTIVITY_UNAVAILABLE',
    );
    return { id: row.id, regionId, orderingVersion: ACTIVITY_ORDERING_VERSION };
  }
  async history(
    accountId: string,
    tx: PoolClient,
  ): Promise<'visited' | 'never_visited' | 'unavailable'> {
    if (
      (
        await tx.query(
          'SELECT 1 FROM whaleu_activities.owner_visit_receipts WHERE account_id=$1 LIMIT 1',
          [accountId],
        )
      ).rowCount
    )
      return 'visited';
    const head = (
      await tx.query<{ coverage_id: string }>(
        'SELECT coverage_id FROM whaleu_activities.owner_visit_head WHERE account_id=$1 FOR SHARE',
        [accountId],
      )
    ).rows[0];
    if (!head) return 'unavailable';
    const row = (
      await tx.query<
        Evidence & {
          history_state: 'visited' | 'never_visited' | 'unavailable';
        }
      >(
        'SELECT * FROM whaleu_activities.owner_visit_coverage WHERE id=$1 AND account_id=$2 FOR SHARE',
        [head.coverage_id, accountId],
      )
    ).rows[0];
    const now = (
      await tx.query<{ now: Date }>('SELECT clock_timestamp() now')
    ).rows[0]!.now.getTime();
    if (!row || !evidenceValid(row, now)) return 'unavailable';
    registerTransactionDeadline(
      tx,
      row.valid_until?.getTime() ?? null,
      'ACTIVITY_ENTRY_SELECTION_UNAVAILABLE',
    );
    return row.history_state;
  }
  async selection(
    catalog: ActivityCatalog,
    accountId: string,
    window: 'entry' | 'all',
    tx: PoolClient,
  ): Promise<ActivitySelection> {
    if (window === 'all') return { kind: 'all' };
    const history = await this.history(accountId, tx);
    if (history === 'visited') return { kind: 'all' };
    if (history !== 'never_visited')
      throw new ApplicationError('ACTIVITY_ENTRY_SELECTION_UNAVAILABLE');
    const since = (
      await tx.query<{ since: string }>(
        `SELECT ${utc("clock_timestamp()-interval '72 hours'")} since`,
      )
    ).rows[0]!.since;
    const facts = (
      await tx.query<{ unknown: boolean; recent: boolean }>(
        `SELECT EXISTS(SELECT 1 ${from} AND r.source_created_at IS NULL) unknown,EXISTS(SELECT 1 ${from} AND r.source_created_at>$3::timestamptz) recent`,
        [catalog.id, catalog.regionId, since],
      )
    ).rows[0]!;
    if (facts.unknown)
      throw new ApplicationError('ACTIVITY_ENTRY_SELECTION_UNAVAILABLE');
    return facts.recent
      ? { kind: 'recent', since }
      : { kind: 'historical', maximum: 10 };
  }
  async list(
    catalog: ActivityCatalog,
    selection: ActivitySelection,
    after: string | null,
    limit: number,
    tx: PoolClient,
  ): Promise<StoredActivity[]> {
    return (
      await tx.query<StoredActivity>(
        `SELECT ${projection} ${from} AND ($3::bigint IS NULL OR e.display_ordinal<$3::bigint) AND ($4::timestamptz IS NULL OR r.source_created_at>$4::timestamptz) ORDER BY e.display_ordinal DESC LIMIT $5`,
        [
          catalog.id,
          catalog.regionId,
          after,
          selection.kind === 'recent' ? selection.since : null,
          limit + 1,
        ],
      )
    ).rows;
  }
  async detail(
    catalog: ActivityCatalog,
    id: string,
    tx: PoolClient,
  ): Promise<StoredActivity | null> {
    return (
      (
        await tx.query<StoredActivity>(
          `SELECT ${projection} ${from} AND e.activity_id=$3`,
          [catalog.id, catalog.regionId, id],
        )
      ).rows[0] ?? null
    );
  }
  async lockVisits(accountId: string, tx: PoolClient) {
    await tx.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('whaleu:activity-visit:'||$1::text,0))",
      [accountId],
    );
  }
  async receipt(
    accountId: string,
    requestId: string,
    tx: PoolClient,
  ): Promise<ActivityVisitReceipt | null> {
    return (
      (
        await tx.query<ActivityVisitReceipt>(
          `SELECT ${receiptProjection} FROM whaleu_activities.owner_visit_receipts WHERE account_id=$1 AND request_id=$2`,
          [accountId, requestId],
        )
      ).rows[0] ?? null
    );
  }
  async visit(
    accountId: string,
    requestId: string,
    catalog: ActivityCatalog,
    tx: PoolClient,
  ): Promise<ActivityVisitReceipt> {
    // The owner advisory lock serializes receipts. No mutable owner marker and no
    // historical source timestamp is invented; the accepted local ledger is global.
    return (
      await tx.query<ActivityVisitReceipt>(
        `INSERT INTO whaleu_activities.owner_visit_receipts(account_id,request_id,region_id,catalog_revision_id,visited_at) VALUES($1,$2,$3,$4,greatest(clock_timestamp(),(SELECT max(visited_at)+interval '1 microsecond' FROM whaleu_activities.owner_visit_receipts WHERE account_id=$1))) RETURNING ${receiptProjection}`,
        [accountId, requestId, catalog.regionId, catalog.id],
      )
    ).rows[0]!;
  }
}
