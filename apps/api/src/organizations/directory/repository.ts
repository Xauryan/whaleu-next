import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import { registerTransactionDeadline } from '../../database/transaction-deadlines.js';
import type { DirectoryKind, DirectoryEntryQuery } from './contracts.js';
import type {
  StoredDirectoryCategory,
  StoredDirectoryEntry,
} from './projection.js';

export const DIRECTORY_ORDERING_VERSION = 'source-snapshot-v1';
interface Evidence {
  coverage: string;
  provenance: string;
  source_reference: string | null;
  policy_reference: string | null;
  effective_at: Date;
  expiry_kind: string;
  valid_until: Date | null;
  sealed: boolean;
}
export interface DirectoryCatalog {
  id: string;
  taxonomyId: string;
  regionId: string;
  kind: DirectoryKind;
  orderingVersion: typeof DIRECTORY_ORDERING_VERSION;
}
interface CatalogRow {
  id: string;
  region_id: string;
  kind: DirectoryKind;
  taxonomy_revision_id: string;
  ordering_version: string;
  ordering_reference: string | null;
  catalog: Evidence;
  taxonomy: Evidence;
  taxonomy_scope: string;
  taxonomy_region_id: string | null;
}
function unavailable(): never {
  throw new ApplicationError('DIRECTORY_UNAVAILABLE');
}
function evidence(value: Evidence, now: number, tx: PoolClient) {
  // JSON dates are strings because these private objects are projected by pg JSON.
  const effective = new Date(value.effective_at).getTime();
  const until =
    value.valid_until === null ? null : new Date(value.valid_until).getTime();
  if (
    !value.sealed ||
    value.coverage !== 'complete' ||
    value.provenance !== 'accepted' ||
    !value.source_reference?.trim() ||
    !value.policy_reference?.trim() ||
    !Number.isFinite(effective) ||
    effective > now ||
    !(
      (value.expiry_kind === 'policy_exempt' && until === null) ||
      (value.expiry_kind === 'at' &&
        until !== null &&
        Number.isFinite(until) &&
        until > now &&
        until > effective)
    )
  )
    unavailable();
  registerTransactionDeadline(tx, until, 'DIRECTORY_UNAVAILABLE');
}
export function literalDirectoryPattern(query: string): string {
  return `%${query.replace(/[\\%_]/g, '\\$&')}%`;
}
const trustedEntry = `e.publication_state='approved' AND e.approval_provenance='accepted' AND e.approved_content_revision=e.content_revision AND length(btrim(e.approval_source_reference))>0 AND length(btrim(e.approval_policy_reference))>0 AND c.lifecycle='active' AND c.accepted_revision=c.source_revision`;
const entryProjection = `e.id,e.category_id,e.platform,e.name,e.intro_text,e.badge_state,e.badge,e.media,e.qq_state,e.qq_number,e.source_created_at,e.source_updated_at,e.display_ordinal::text,e.search_ordinal::text`;
@Injectable()
export class DirectoryRepository {
  async catalog(
    regionId: string,
    kind: DirectoryKind,
    tx: PoolClient,
  ): Promise<DirectoryCatalog> {
    const row = (
      await tx.query<CatalogRow>(
        `SELECT r.id,r.region_id,r.kind,r.taxonomy_revision_id,r.ordering_version,r.ordering_reference,to_jsonb(r) catalog,to_jsonb(t) taxonomy,t.scope taxonomy_scope,t.region_id taxonomy_region_id
   FROM whaleu_organizations.directory_catalog_heads h
   JOIN whaleu_organizations.directory_catalog_revisions r ON r.id=h.revision_id AND r.region_id=h.region_id AND r.kind=h.kind
   JOIN whaleu_organizations.directory_taxonomy_heads th ON th.kind=r.kind AND th.region_id IS NOT DISTINCT FROM CASE WHEN r.kind='official' THEN NULL::uuid ELSE r.region_id END
   JOIN whaleu_organizations.directory_taxonomy_revisions t ON t.id=th.revision_id AND t.id=r.taxonomy_revision_id AND t.kind=r.kind
   WHERE h.region_id=$1 AND h.kind=$2 FOR SHARE OF h,r,th,t`,
        [regionId, kind],
      )
    ).rows[0];
    if (!row) unavailable();
    const now = (
      await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now')
    ).rows[0]!.now.getTime();
    if (
      !Number.isFinite(now) ||
      row.region_id !== regionId ||
      row.kind !== kind ||
      row.ordering_version !== DIRECTORY_ORDERING_VERSION ||
      !row.ordering_reference?.trim() ||
      (kind === 'official'
        ? row.taxonomy_scope !== 'global' || row.taxonomy_region_id !== null
        : row.taxonomy_scope !== 'regional' ||
          row.taxonomy_region_id !== regionId)
    )
      unavailable();
    evidence(row.catalog, now, tx);
    evidence(row.taxonomy, now, tx);
    return {
      id: row.id,
      taxonomyId: row.taxonomy_revision_id,
      regionId,
      kind,
      orderingVersion: DIRECTORY_ORDERING_VERSION,
    };
  }
  async category(
    catalog: DirectoryCatalog,
    id: string,
    tx: PoolClient,
  ): Promise<void> {
    const row = (
      await tx.query(
        `SELECT id FROM whaleu_organizations.directory_categories WHERE taxonomy_revision_id=$1 AND id=$2 AND lifecycle='active' AND accepted_revision=source_revision FOR SHARE`,
        [catalog.taxonomyId, id],
      )
    ).rows[0];
    if (!row) throw new ApplicationError('DIRECTORY_NOT_FOUND');
  }
  async categories(
    catalog: DirectoryCatalog,
    after: string | null,
    limit: number,
    tx: PoolClient,
  ): Promise<StoredDirectoryCategory[]> {
    return (
      await tx.query<StoredDirectoryCategory>(
        `SELECT id,$4::text kind,name,description,accent,display_ordinal::text FROM whaleu_organizations.directory_categories c WHERE taxonomy_revision_id=$1 AND lifecycle='active' AND accepted_revision=source_revision AND ($2::bigint IS NULL OR c.display_ordinal>$2::bigint) ORDER BY c.display_ordinal LIMIT $3 FOR SHARE`,
        [catalog.taxonomyId, after, limit + 1, catalog.kind],
      )
    ).rows;
  }
  async entries(
    catalog: DirectoryCatalog,
    query: DirectoryEntryQuery,
    after: string | null,
    tx: PoolClient,
  ): Promise<StoredDirectoryEntry[]> {
    const order = query.q === undefined ? 'display_ordinal' : 'search_ordinal';
    // Explicit ASCII-only folding plus COLLATE "C" is deterministic. Chinese and
    // all non-ASCII code points remain literal; no normalization or fuzzy search.
    return (
      await tx.query<StoredDirectoryEntry>(
        `SELECT ${entryProjection},$7::text kind FROM whaleu_organizations.directory_entries e JOIN whaleu_organizations.directory_categories c ON c.taxonomy_revision_id=e.taxonomy_revision_id AND c.id=e.category_id WHERE e.catalog_revision_id=$1 AND e.taxonomy_revision_id=$2 AND ${trustedEntry} AND ($3::uuid IS NULL OR e.category_id=$3) AND ($4::text IS NULL OR translate(e.name,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz') COLLATE "C" LIKE translate($4,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz') COLLATE "C" ESCAPE E'\\\\') AND ($5::bigint IS NULL OR e.${order}>$5::bigint) ORDER BY e.${order} LIMIT $6 FOR SHARE OF e,c`,
        [
          catalog.id,
          catalog.taxonomyId,
          query.categoryId ?? null,
          query.q === undefined ? null : literalDirectoryPattern(query.q),
          after,
          query.limit + 1,
          catalog.kind,
        ],
      )
    ).rows;
  }
  async detail(
    catalog: DirectoryCatalog,
    id: string,
    tx: PoolClient,
  ): Promise<StoredDirectoryEntry | null> {
    return (
      (
        await tx.query<StoredDirectoryEntry>(
          `SELECT ${entryProjection},$4::text kind FROM whaleu_organizations.directory_entries e JOIN whaleu_organizations.directory_categories c ON c.taxonomy_revision_id=e.taxonomy_revision_id AND c.id=e.category_id WHERE e.catalog_revision_id=$1 AND e.taxonomy_revision_id=$2 AND e.id=$3 AND ${trustedEntry} FOR SHARE OF e,c`,
          [catalog.id, catalog.taxonomyId, id, catalog.kind],
        )
      ).rows[0] ?? null
    );
  }
  async detailKind(
    regionId: string,
    id: string,
    tx: PoolClient,
  ): Promise<DirectoryKind> {
    // Only structural metadata is read here; the selected head and entire current
    // source revision are subsequently locked and rechecked before projection.
    const rows = (
      await tx.query<{ kind: DirectoryKind }>(
        `SELECT h.kind FROM whaleu_organizations.directory_catalog_heads h JOIN whaleu_organizations.directory_entries e ON e.catalog_revision_id=h.revision_id WHERE h.region_id=$1 AND e.id=$2 LIMIT 2`,
        [regionId, id],
      )
    ).rows;
    if (rows.length !== 1) throw new ApplicationError('DIRECTORY_NOT_FOUND');
    return rows[0]!.kind;
  }
}
