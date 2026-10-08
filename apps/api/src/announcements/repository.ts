import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import { registerTransactionDeadline } from '../database/transaction-deadlines.js';
import type {
  AnnouncementAcknowledgement,
  AnnouncementNewness,
} from './contracts.js';
import type { StoredAnnouncement } from './projection.js';
export const ANNOUNCEMENT_ORDERING_VERSION = 'source-id-desc-v1';
export interface AnnouncementCatalog {
  id: string;
  orderingVersion: typeof ANNOUNCEMENT_ORDERING_VERSION;
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
  sealed: boolean;
  ordering_version: string;
  ordering_reference: string;
}
function evidenceValid(row: Evidence, now: number): boolean {
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
const visible = `e.lifecycle='active' AND e.publication_state='approved' AND e.approval_provenance='accepted' AND e.approved_content_revision=e.content_revision_id AND r.sealed AND r.provenance='accepted' AND (r.audience_kind='all_browsers' OR ($2::uuid IS NOT NULL AND r.audience_kind='browse_campus_set' AND EXISTS(SELECT 1 FROM whaleu_announcements.campus_audiences a WHERE a.content_revision_id=r.id AND a.campus_id=$2)))`;
const from = `FROM whaleu_announcements.catalog_entries e JOIN whaleu_announcements.content_revisions r ON r.id=e.content_revision_id AND r.announcement_id=e.announcement_id WHERE e.catalog_revision_id=$1 AND ${visible}`;
const utc = (field: string) =>
  `to_char((${field}) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const projection = `e.announcement_id id,r.id revision,e.source_ordinal::text,r.version_label,r.title,r.body_text,to_char(r.announcement_date,'YYYY-MM-DD') announcement_date,${utc('r.source_created_at')} source_created_at,${utc('r.source_updated_at')} source_updated_at,r.highlight,r.popup_enabled,r.popup_title_state,r.popup_title,r.popup_body_state,r.popup_body_text,r.media_state`;
@Injectable()
export class AnnouncementsRepository {
  async catalog(tx: PoolClient): Promise<AnnouncementCatalog> {
    // Lock the pointer first, then fetch the revision. A joined pre-wait snapshot
    // must never retain the old head after a concurrent replacement commits.
    const head = (
      await tx.query<{ revision_id: string }>(
        'SELECT revision_id FROM whaleu_announcements.catalog_head WHERE singleton FOR SHARE',
      )
    ).rows[0];
    if (!head) throw new ApplicationError('ANNOUNCEMENTS_UNAVAILABLE');
    const row = (
      await tx.query<CatalogRow>(
        'SELECT * FROM whaleu_announcements.catalog_revisions WHERE id=$1 FOR SHARE',
        [head.revision_id],
      )
    ).rows[0];
    const now = (
      await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now')
    ).rows[0]!.now.getTime();
    if (
      !row ||
      !row.sealed ||
      row.ordering_version !== ANNOUNCEMENT_ORDERING_VERSION ||
      !row.ordering_reference.trim() ||
      !evidenceValid(row, now)
    )
      throw new ApplicationError('ANNOUNCEMENTS_UNAVAILABLE');
    registerTransactionDeadline(
      tx,
      row.valid_until?.getTime() ?? null,
      'ANNOUNCEMENTS_UNAVAILABLE',
    );
    return { id: row.id, orderingVersion: ANNOUNCEMENT_ORDERING_VERSION };
  }
  async latestId(
    catalog: AnnouncementCatalog,
    campusId: string | null,
    tx: PoolClient,
  ): Promise<string | null> {
    return (
      (
        await tx.query<{ id: string }>(
          `SELECT e.announcement_id id ${from} ORDER BY e.source_ordinal DESC LIMIT 1`,
          [catalog.id, campusId],
        )
      ).rows[0]?.id ?? null
    );
  }
  async list(
    catalog: AnnouncementCatalog,
    campusId: string | null,
    after: string | null,
    limit: number,
    tx: PoolClient,
  ): Promise<StoredAnnouncement[]> {
    return (
      await tx.query<StoredAnnouncement>(
        `SELECT ${projection} ${from} AND ($3::bigint IS NULL OR e.source_ordinal<$3::bigint) ORDER BY e.source_ordinal DESC LIMIT $4`,
        [catalog.id, campusId, after, limit + 1],
      )
    ).rows;
  }
  async detail(
    catalog: AnnouncementCatalog,
    campusId: string | null,
    id: string,
    tx: PoolClient,
  ): Promise<StoredAnnouncement | null> {
    return (
      (
        await tx.query<StoredAnnouncement>(
          `SELECT ${projection} ${from} AND e.announcement_id=$3`,
          [catalog.id, campusId, id],
        )
      ).rows[0] ?? null
    );
  }
  async popup(
    catalog: AnnouncementCatalog,
    campusId: string | null,
    tx: PoolClient,
  ): Promise<StoredAnnouncement | null> {
    return (
      (
        await tx.query<StoredAnnouncement>(
          `SELECT ${projection} ${from} AND r.popup_enabled ORDER BY e.source_ordinal DESC LIMIT 1`,
          [catalog.id, campusId],
        )
      ).rows[0] ?? null
    );
  }
  async changes(
    catalog: AnnouncementCatalog,
    campusId: string | null,
    since: string | undefined,
    tx: PoolClient,
  ): Promise<{
    since: string;
    checkedAt: string;
    newness: AnnouncementNewness;
  }> {
    const instant = (
      await tx.query<{ since: string; checkedAt: string }>(
        `WITH instant AS (SELECT clock_timestamp() now) SELECT ${utc('now')} "checkedAt",CASE WHEN $1::text IS NULL THEN ${utc("now-interval '720 hours'")} ELSE $1::text END since FROM instant`,
        [since ?? null],
      )
    ).rows[0]!;
    // The exact aggregate has its own finite budget. Recover only its cancellation,
    // preserving all authority locks and their final transaction deadlines.
    await tx.query('SAVEPOINT announcement_changes_count');
    let newness: AnnouncementNewness;
    try {
      const prior = (
        await tx.query<{ timeout: string }>(
          "SELECT current_setting('statement_timeout') timeout",
        )
      ).rows[0]!.timeout;
      await tx.query(
        "SELECT set_config('statement_timeout', CASE WHEN current_setting('statement_timeout')::interval=interval '0' OR current_setting('statement_timeout')::interval>interval '500 milliseconds' THEN '500ms' ELSE current_setting('statement_timeout') END,true)",
      );
      const row = (
        await tx.query<{ count: string; known: boolean }>(
          `SELECT count(*) FILTER(WHERE r.source_created_at>$3::timestamptz)::text count,coalesce(bool_and(r.source_created_at IS NOT NULL),true) known ${from}`,
          [catalog.id, campusId, instant.since],
        )
      ).rows[0]!;
      newness = row.known
        ? {
            status: 'available',
            hasNew: row.count !== '0',
            newCount: row.count,
          }
        : { status: 'unavailable', hasNew: null, newCount: null };
      await tx.query("SELECT set_config('statement_timeout',$1,true)", [prior]);
    } catch (error) {
      await tx.query('ROLLBACK TO SAVEPOINT announcement_changes_count');
      if (
        typeof error !== 'object' ||
        error === null ||
        !('code' in error) ||
        !['57014', '55P03'].includes(String(error.code))
      )
        throw error;
      newness = { status: 'unavailable', hasNew: null, newCount: null };
    }
    await tx.query('RELEASE SAVEPOINT announcement_changes_count');
    return { ...instant, newness };
  }
  async acknowledgement(
    accountId: string,
    id: string,
    tx: PoolClient,
  ): Promise<AnnouncementAcknowledgement> {
    const marker = (
      await tx.query<{ acknowledgedAt: string | null }>(
        `SELECT ${utc('acknowledged_at')} "acknowledgedAt" FROM whaleu_announcements.popup_acknowledgements WHERE account_id=$1 AND announcement_id=$2 AND provenance='accepted' FOR SHARE`,
        [accountId, id],
      )
    ).rows[0];
    if (marker)
      return { status: 'acknowledged', acknowledgedAt: marker.acknowledgedAt };
    const identity = (
      await tx.query<{ origin_kind: string; provenance: string }>(
        'SELECT origin_kind,provenance FROM whaleu_announcements.identities WHERE id=$1 FOR SHARE',
        [id],
      )
    ).rows[0];
    if (
      identity?.origin_kind === 'fresh_local' &&
      identity.provenance === 'accepted'
    )
      return { status: 'unseen', acknowledgedAt: null };
    const coverage = (
      await tx.query<Evidence>(
        'SELECT * FROM whaleu_announcements.owner_history_coverage WHERE account_id=$1 AND announcement_id=$2 FOR SHARE',
        [accountId, id],
      )
    ).rows[0];
    const now = (
      await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now')
    ).rows[0]!.now.getTime();
    if (!coverage || !evidenceValid(coverage, now))
      return { status: 'unavailable', acknowledgedAt: null };
    registerTransactionDeadline(
      tx,
      coverage.valid_until?.getTime() ?? null,
      'ANNOUNCEMENTS_UNAVAILABLE',
    );
    return { status: 'unseen', acknowledgedAt: null };
  }
  async acknowledge(accountId: string, id: string, tx: PoolClient) {
    // ON CONFLICT never updates a marker. A fresh statement after the conflict wait
    // observes the winning receipt, including a trusted historical null time.
    await tx.query(
      `INSERT INTO whaleu_announcements.popup_acknowledgements(account_id,announcement_id,acknowledged_at,origin_kind,provenance) VALUES($1,$2,clock_timestamp(),'local','accepted') ON CONFLICT(account_id,announcement_id) DO NOTHING`,
      [accountId, id],
    );
    const marker = await this.acknowledgement(accountId, id, tx);
    if (marker.status !== 'acknowledged')
      throw new ApplicationError('ANNOUNCEMENTS_UNAVAILABLE');
    return marker;
  }
}
