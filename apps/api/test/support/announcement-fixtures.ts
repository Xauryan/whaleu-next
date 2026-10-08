/** Canonical synthetic facts only; ordinary owner services and authority remain installed. */
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { withCommunityScopeWriter } from './community-scope-fixtures.js';

export interface SyntheticAnnouncement {
  id: string;
  revision: string;
  ordinal: string;
  origin: 'fresh_local' | 'preserved';
  versionLabel: string;
  title: string;
  bodyText: string;
  announcementDate: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  highlight: boolean;
  popupEnabled: boolean;
  popupTitle: string | null;
  unknownPopupTitle: boolean;
  popupBody: string | null;
  media: 'known_empty' | 'unavailable';
  campusIds: string[];
  state: 'active' | 'withdrawn' | 'pending';
}
export function syntheticAnnouncement(
  patch: Partial<SyntheticAnnouncement> = {},
): SyntheticAnnouncement {
  return {
    id: randomUUID(),
    revision: randomUUID(),
    ordinal: '1',
    origin: 'fresh_local',
    versionLabel: 'Synthetic display version',
    title: 'Synthetic announcement',
    bodyText: 'Synthetic body\n\n  Indented paragraph 鲸鱼',
    announcementDate: '2026-10-08',
    createdAt: '2026-10-08T00:00:00.000001Z',
    updatedAt: null,
    highlight: false,
    popupEnabled: true,
    popupTitle: null,
    unknownPopupTitle: false,
    popupBody: null,
    media: 'known_empty',
    campusIds: [],
    state: 'active',
    ...patch,
  };
}
export interface AnnouncementCatalogOptions {
  head?: boolean;
  seal?: boolean;
  validUntil?: Date;
  effectiveAt?: Date;
  coverage?: 'complete' | 'missing' | 'conflicting';
  provenance?: 'accepted' | 'unknown' | 'conflicting';
}
async function content(tx: PoolClient, row: SyntheticAnnouncement) {
  await tx.query(
    "INSERT INTO whaleu_announcements.identities(id,origin_kind,provenance,source_reference,policy_reference) VALUES($1,$2,'accepted','synthetic-announcement-identity','synthetic-announcement-policy') ON CONFLICT DO NOTHING",
    [row.id, row.origin],
  );
  const existing = await tx.query(
    'SELECT 1 FROM whaleu_announcements.content_revisions WHERE id=$1',
    [row.revision],
  );
  if (existing.rowCount) return;
  await tx.query(
    `INSERT INTO whaleu_announcements.content_revisions(id,announcement_id,version_label,title,body_text,announcement_date,source_created_at,source_updated_at,highlight,popup_enabled,popup_title_state,popup_title,popup_body_state,popup_body_text,media_state,audience_kind,expected_campus_count,provenance,source_reference,policy_reference)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'accepted','synthetic-announcement-content','synthetic-announcement-policy')`,
    [
      row.revision,
      row.id,
      row.versionLabel,
      row.title,
      row.bodyText,
      row.announcementDate,
      row.createdAt,
      row.updatedAt,
      row.highlight,
      row.popupEnabled,
      row.unknownPopupTitle
        ? 'unknown'
        : row.popupTitle === null
          ? 'absent'
          : 'value',
      row.popupTitle,
      row.popupBody === null ? 'absent' : 'value',
      row.popupBody,
      row.media,
      row.campusIds.length ? 'browse_campus_set' : 'all_browsers',
      row.campusIds.length,
    ],
  );
  for (const campusId of row.campusIds)
    await tx.query(
      "INSERT INTO whaleu_announcements.campus_audiences(content_revision_id,campus_id,provenance,source_reference,policy_reference) VALUES($1,$2,'accepted','synthetic-exact-campus-crosswalk','synthetic-announcement-policy')",
      [row.revision, campusId],
    );
  await tx.query(
    'UPDATE whaleu_announcements.content_revisions SET sealed=true WHERE id=$1',
    [row.revision],
  );
}
/** Pending identities are deliberately absent from the accepted catalog, not granted publication. */
export async function seedAnnouncementCatalog(
  pool: Pool,
  rows: readonly SyntheticAnnouncement[],
  options: AnnouncementCatalogOptions = {},
) {
  return withCommunityScopeWriter(pool, async (tx) => {
    for (const row of rows) await content(tx, row);
    const id = randomUUID(),
      current = rows.filter((row) => row.state !== 'pending');
    await tx.query(
      `INSERT INTO whaleu_announcements.catalog_revisions(id,coverage,provenance,source_reference,policy_reference,ordering_version,ordering_reference,effective_at,expiry_kind,valid_until,expected_count)
       VALUES($1,$2,$3,'synthetic-complete-population','synthetic-announcement-policy','source-id-desc-v1','synthetic-source-id-order',$4,$5,$6,$7)`,
      [
        id,
        options.coverage ?? 'complete',
        options.provenance ?? 'accepted',
        options.effectiveAt ?? new Date(Date.now() - 60000),
        options.validUntil ? 'at' : 'policy_exempt',
        options.validUntil ?? null,
        current.length,
      ],
    );
    for (const row of current)
      await tx.query(
        `INSERT INTO whaleu_announcements.catalog_entries(catalog_revision_id,announcement_id,content_revision_id,source_ordinal,lifecycle,publication_state,approval_provenance,approved_content_revision,approval_source_reference,approval_policy_reference)
       VALUES($1,$2,$3,$4,$5,'approved','accepted',$3,'synthetic-current-publication-approval','synthetic-announcement-policy')`,
        [
          id,
          row.id,
          row.revision,
          row.ordinal,
          row.state === 'withdrawn' ? 'inactive' : 'active',
        ],
      );
    if (options.seal !== false)
      await tx.query(
        'UPDATE whaleu_announcements.catalog_revisions SET sealed=true WHERE id=$1',
        [id],
      );
    if (options.head !== false)
      await tx.query(
        'INSERT INTO whaleu_announcements.catalog_head(singleton,revision_id) VALUES(true,$1) ON CONFLICT(singleton) DO UPDATE SET revision_id=EXCLUDED.revision_id',
        [id],
      );
    return id;
  });
}
export async function seedAnnouncementHistoryCoverage(
  pool: Pool,
  accountId: string,
  announcementId: string,
  validUntil: Date | null = null,
) {
  return withCommunityScopeWriter(pool, (tx) =>
    tx.query(
      "INSERT INTO whaleu_announcements.owner_history_coverage(account_id,announcement_id,coverage,provenance,source_reference,policy_reference,effective_at,expiry_kind,valid_until) VALUES($1,$2,'complete','accepted','synthetic-id-key-history-coverage','synthetic-announcement-policy',clock_timestamp()-interval '1 minute',$3,$4)",
      [
        accountId,
        announcementId,
        validUntil ? 'at' : 'policy_exempt',
        validUntil,
      ],
    ),
  );
}
export async function seedHistoricalAnnouncementAcknowledgement(
  pool: Pool,
  accountId: string,
  announcementId: string,
) {
  return withCommunityScopeWriter(pool, (tx) =>
    tx.query(
      "INSERT INTO whaleu_announcements.popup_acknowledgements(account_id,announcement_id,acknowledged_at,origin_kind,provenance,source_reference) VALUES($1,$2,NULL,'preserved','accepted','synthetic-id-key-historical-marker')",
      [accountId, announcementId],
    ),
  );
}
export async function announcementMarkerCount(
  pool: Pool,
  accountId: string,
  announcementId?: string,
) {
  return Number(
    (
      await pool.query<{ count: string }>(
        'SELECT count(*)::text count FROM whaleu_announcements.popup_acknowledgements WHERE account_id=$1 AND ($2::uuid IS NULL OR announcement_id=$2)',
        [accountId, announcementId ?? null],
      )
    ).rows[0]!.count,
  );
}
