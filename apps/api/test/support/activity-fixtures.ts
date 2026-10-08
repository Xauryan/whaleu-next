/** Synthetic disposable canonical activity facts. No runtime issuer or replaced port. */
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { withCommunityScopeWriter } from './community-scope-fixtures.js';
export interface SyntheticActivity {
  id: string;
  revision: string;
  ordinal: string;
  title: string;
  bodyText: string;
  organizerLabel: string;
  activityTime: string | null;
  activityLocation: string | null;
  reward: boolean | null;
  online: boolean | null;
  createdAt: string | null;
  cover: 'absent' | 'unavailable';
  avatar: 'absent' | 'unavailable';
  gallery: 'known_empty' | 'unavailable';
  qr: 'absent' | 'unavailable';
  state: 'active' | 'inactive' | 'pending';
}
export function syntheticActivity(
  patch: Partial<SyntheticActivity> = {},
): SyntheticActivity {
  return {
    id: randomUUID(),
    revision: randomUUID(),
    ordinal: '1',
    title: 'Synthetic activity 鲸鱼',
    bodyText: '第一段\n\n  Indented paragraph\t鲸鱼 😀\n',
    organizerLabel: 'Synthetic organizer',
    activityTime: '周六 下午\n待确认',
    activityLocation: '本校礼堂',
    reward: null,
    online: null,
    createdAt: new Date().toISOString(),
    cover: 'unavailable',
    avatar: 'unavailable',
    gallery: 'unavailable',
    qr: 'unavailable',
    state: 'active',
    ...patch,
  };
}
export interface ActivityCatalogOptions {
  head?: boolean;
  seal?: boolean;
  validUntil?: Date;
  effectiveAt?: Date;
  coverage?: 'complete' | 'missing' | 'conflicting';
  provenance?: 'accepted' | 'unknown' | 'conflicting';
  expectedCount?: number;
}
export async function seedActivityCatalog(
  pool: Pool,
  regionId: string,
  rows: readonly SyntheticActivity[],
  options: ActivityCatalogOptions = {},
) {
  return withCommunityScopeWriter(pool, async (tx) => {
    for (const row of rows) {
      await tx.query(
        "INSERT INTO whaleu_activities.identities(id,origin_kind,provenance,source_reference,policy_reference) VALUES($1,'preserved','accepted','synthetic-identity','synthetic-policy') ON CONFLICT DO NOTHING",
        [row.id],
      );
      if (
        (
          await tx.query(
            'SELECT 1 FROM whaleu_activities.content_revisions WHERE id=$1',
            [row.revision],
          )
        ).rowCount
      )
        continue;
      await tx.query(
        `INSERT INTO whaleu_activities.content_revisions(id,activity_id,region_id,title,body_text,organizer_label,activity_time,activity_location,reward,online,source_created_at,cover_state,avatar_state,gallery_state,qr_state,source_fields,provenance,source_reference,policy_reference,sealed) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'{"syntheticUnprojectedField":"retained"}','accepted','synthetic-content','synthetic-policy',true)`,
        [
          row.revision,
          row.id,
          regionId,
          row.title,
          row.bodyText,
          row.organizerLabel,
          row.activityTime,
          row.activityLocation,
          row.reward,
          row.online,
          row.createdAt,
          row.cover,
          row.avatar,
          row.gallery,
          row.qr,
        ],
      );
    }
    const id = randomUUID(),
      current = rows.filter((row) => row.state !== 'pending');
    await tx.query(
      `INSERT INTO whaleu_activities.catalog_revisions(id,region_id,coverage,provenance,source_reference,policy_reference,ordering_version,ordering_reference,effective_at,expiry_kind,valid_until,expected_count) VALUES($1,$2,$3,$4,'synthetic-population','synthetic-policy','source-created-desc-v1','synthetic-create-desc-then-original-numeric-id-desc',$5,$6,$7,$8)`,
      [
        id,
        regionId,
        options.coverage ?? 'complete',
        options.provenance ?? 'accepted',
        options.effectiveAt ?? new Date(Date.now() - 60000),
        options.validUntil ? 'at' : 'policy_exempt',
        options.validUntil ?? null,
        options.expectedCount ?? current.length,
      ],
    );
    for (const row of current)
      await tx.query(
        `INSERT INTO whaleu_activities.catalog_entries(catalog_revision_id,region_id,activity_id,content_revision_id,display_ordinal,lifecycle,publication_state,approval_provenance,approved_content_revision,approval_source_reference,approval_policy_reference) VALUES($1,$2,$3,$4,$5,$6,'approved','accepted',$4,'synthetic-exact-approval','synthetic-policy')`,
        [id, regionId, row.id, row.revision, row.ordinal, row.state],
      );
    if (options.seal !== false)
      await tx.query(
        'UPDATE whaleu_activities.catalog_revisions SET sealed=true WHERE id=$1',
        [id],
      );
    if (options.head !== false)
      await tx.query(
        'INSERT INTO whaleu_activities.catalog_head(region_id,revision_id) VALUES($1,$2) ON CONFLICT(region_id) DO UPDATE SET revision_id=EXCLUDED.revision_id',
        [regionId, id],
      );
    return id;
  });
}
export async function seedActivityHistory(
  pool: Pool,
  accountId: string,
  state: 'never_visited' | 'visited' | 'unavailable',
  options: {
    coverage?: 'complete' | 'missing' | 'conflicting';
    validUntil?: Date;
    lastVisitedAt?: Date;
  } = {},
) {
  return withCommunityScopeWriter(pool, async (tx) => {
    const id = randomUUID();
    await tx.query(
      `INSERT INTO whaleu_activities.owner_visit_coverage(id,account_id,history_state,source_last_visited_at,coverage,provenance,source_reference,policy_reference,effective_at,expiry_kind,valid_until) VALUES($1,$2,$3,$4,$5,'accepted','synthetic-global-history','synthetic-policy',clock_timestamp()-interval '1 minute',$6,$7)`,
      [
        id,
        accountId,
        state,
        options.lastVisitedAt ?? null,
        options.coverage ?? 'complete',
        options.validUntil ? 'at' : 'policy_exempt',
        options.validUntil ?? null,
      ],
    );
    await tx.query(
      'INSERT INTO whaleu_activities.owner_visit_head(account_id,coverage_id) VALUES($1,$2) ON CONFLICT(account_id) DO UPDATE SET coverage_id=EXCLUDED.coverage_id',
      [accountId, id],
    );
    return id;
  });
}
export async function activityVisitCount(pool: Pool, accountId: string) {
  return Number(
    (
      await pool.query<{ count: string }>(
        'SELECT count(*)::text count FROM whaleu_activities.owner_visit_receipts WHERE account_id=$1',
        [accountId],
      )
    ).rows[0]!.count,
  );
}
