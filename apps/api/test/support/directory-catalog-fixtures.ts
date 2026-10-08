/** Synthetic acceptance evidence for disposable tests only; no runtime issuer or import. */
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { DirectoryKind } from '../../src/organizations/directory/contracts.js';
import { withCommunityScopeWriter } from './community-scope-fixtures.js';

export interface SyntheticDirectoryCategory {
  id: string;
  name: string;
  description: string;
  accent:
    | 'green'
    | 'orange'
    | 'red'
    | 'yellow'
    | 'lilac'
    | 'purple'
    | 'coral'
    | 'cyan';
  lifecycle: 'active' | 'inactive' | 'unknown';
  accepted: boolean;
  ordinal: number;
}
export interface SyntheticDirectoryEntry {
  id: string;
  categoryId: string;
  contentRevision: string;
  platform: 'qq' | 'wechat' | 'official';
  name: string;
  intro: string;
  badgeState: 'known' | 'unknown';
  badge: 'normal' | 'official' | 'partner' | null;
  media: Record<string, unknown>;
  qqState: 'known' | 'unknown' | 'not_applicable';
  qqNumber: string | null;
  state: 'approved' | 'pending' | 'rejected' | 'unknown';
  provenance: 'accepted' | 'unknown' | 'conflicting';
  createdAt: string | null;
  updatedAt: string | null;
  visits: number | null;
  ordinal: number;
  searchOrdinal: number;
}
export function syntheticDirectoryCategory(
  patch: Partial<SyntheticDirectoryCategory> = {},
): SyntheticDirectoryCategory {
  return {
    id: randomUUID(),
    name: '校园社群',
    description: '来自独立目录分类',
    accent: 'cyan',
    lifecycle: 'active',
    accepted: true,
    ordinal: 0,
    ...patch,
  };
}
export function syntheticDirectoryEntry(
  categoryId: string,
  patch: Partial<SyntheticDirectoryEntry> = {},
): SyntheticDirectoryEntry {
  return {
    id: randomUUID(),
    categoryId,
    contentRevision: randomUUID(),
    platform: 'qq',
    name: '合唱社群',
    intro: 'Synthetic directory introduction',
    badgeState: 'known',
    badge: 'normal',
    media: {
      avatar: { status: 'absent', reference: null },
      mainQr: { status: 'unknown', reference: null },
      managerWechatImage: { status: 'absent', reference: null },
      linkedOfficialAccountQr: { status: 'absent', reference: null },
      introImages: { status: 'unknown', references: null },
    },
    qqState: 'known',
    qqNumber: '001234567890',
    state: 'approved',
    provenance: 'accepted',
    createdAt: null,
    updatedAt: null,
    visits: null,
    ordinal: 0,
    searchOrdinal: 0,
    ...patch,
  };
}
export async function seedDirectoryTaxonomy(
  pool: Pool,
  regionId: string,
  kind: DirectoryKind,
  categories: readonly SyntheticDirectoryCategory[],
  options: { sealed?: boolean; head?: boolean; validUntil?: Date } = {},
) {
  return withCommunityScopeWriter(pool, async (tx) => {
    const id = randomUUID();
    await tx.query(
      `INSERT INTO whaleu_organizations.directory_taxonomy_revisions
      (id,kind,scope,region_id,coverage,provenance,source_reference,policy_reference,effective_at,expiry_kind,valid_until,expected_count)
      VALUES($1,$2,$3,$4,'complete','accepted','synthetic-directory-taxonomy','synthetic-directory-test-policy',clock_timestamp()-interval '1 minute',$5,$6,$7)`,
      [
        id,
        kind,
        kind === 'official' ? 'global' : 'regional',
        kind === 'official' ? null : regionId,
        options.validUntil ? 'at' : 'policy_exempt',
        options.validUntil ?? null,
        categories.length,
      ],
    );
    for (const category of categories)
      await tx.query(
        `INSERT INTO whaleu_organizations.directory_categories
        (taxonomy_revision_id,id,name,description,accent,lifecycle,source_system,source_id,source_revision,accepted_revision,display_ordinal)
        VALUES($1,$2,$3,$4,$5,$6,'synthetic-directory-only',$7,'revision-1',$8,$9)`,
        [
          id,
          category.id,
          category.name,
          category.description,
          category.accent,
          category.lifecycle,
          `category-${category.id}`,
          category.accepted ? 'revision-1' : null,
          category.ordinal,
        ],
      );
    if (options.sealed !== false)
      await tx.query(
        'UPDATE whaleu_organizations.directory_taxonomy_revisions SET sealed=true WHERE id=$1',
        [id],
      );
    if (options.sealed !== false && options.head !== false)
      await tx.query(
        `INSERT INTO whaleu_organizations.directory_taxonomy_heads(kind,region_id,revision_id) VALUES($1,$2,$3) ON CONFLICT(kind,region_id) DO UPDATE SET revision_id=excluded.revision_id`,
        [kind, kind === 'official' ? null : regionId, id],
      );
    return id;
  });
}
export async function seedDirectoryCatalog(
  pool: Pool,
  regionId: string,
  kind: DirectoryKind,
  taxonomyId: string,
  entries: readonly SyntheticDirectoryEntry[],
  options: { sealed?: boolean; head?: boolean; validUntil?: Date } = {},
) {
  return withCommunityScopeWriter(pool, async (tx) => {
    const id = randomUUID();
    await tx.query(
      `INSERT INTO whaleu_organizations.directory_catalog_revisions
      (id,region_id,kind,taxonomy_revision_id,coverage,provenance,source_reference,policy_reference,ordering_version,ordering_reference,effective_at,expiry_kind,valid_until,expected_count)
      VALUES($1,$2,$3,$4,'complete','accepted','synthetic-directory-current-source','synthetic-directory-test-policy','source-snapshot-v1','synthetic-verified-source-ordinals',clock_timestamp()-interval '1 minute',$5,$6,$7)`,
      [
        id,
        regionId,
        kind,
        taxonomyId,
        options.validUntil ? 'at' : 'policy_exempt',
        options.validUntil ?? null,
        entries.length,
      ],
    );
    for (const entry of entries)
      await tx.query(
        `INSERT INTO whaleu_organizations.directory_entries
        (catalog_revision_id,taxonomy_revision_id,id,category_id,content_revision,platform,name,intro_text,badge_state,badge,media,qq_state,qq_number,publication_state,approval_provenance,approved_content_revision,approval_source_reference,approval_policy_reference,source_created_at,source_updated_at,historical_visits,source_system,source_id,source_revision,display_ordinal,search_ordinal)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,'synthetic-directory-only',$22,'revision-1',$23,$24)`,
        [
          id,
          taxonomyId,
          entry.id,
          entry.categoryId,
          entry.contentRevision,
          entry.platform,
          entry.name,
          entry.intro,
          entry.badgeState,
          entry.badge,
          JSON.stringify(entry.media),
          entry.qqState,
          entry.qqNumber,
          entry.state,
          entry.provenance,
          entry.provenance === 'accepted' ? entry.contentRevision : null,
          entry.provenance === 'accepted'
            ? 'synthetic-current-approved-revision'
            : null,
          entry.provenance === 'accepted'
            ? 'synthetic-directory-review-policy'
            : null,
          entry.createdAt,
          entry.updatedAt,
          entry.visits,
          `entry-${entry.id}`,
          entry.ordinal,
          entry.searchOrdinal,
        ],
      );
    if (options.sealed !== false)
      await tx.query(
        'UPDATE whaleu_organizations.directory_catalog_revisions SET sealed=true WHERE id=$1',
        [id],
      );
    if (options.head !== false)
      await tx.query(
        `INSERT INTO whaleu_organizations.directory_catalog_heads(region_id,kind,revision_id) VALUES($1,$2,$3)
      ON CONFLICT(region_id,kind) DO UPDATE SET revision_id=excluded.revision_id`,
        [regionId, kind, id],
      );
    return id;
  });
}
