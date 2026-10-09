import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import { registerTransactionDeadline } from '../../database/transaction-deadlines.js';
/** Writer-only before/after catalog observations. Never registers a stale reader head fact. */
@Injectable()
export class RatingCatalogWriter {
  async current(region: string | null, expected: string, tx: PoolClient) {
    const row = (
      await tx
        .query<{ id: string; valid_until: Date | null }>(
          `SELECT c.id,least(c.valid_until,whaleu_ratings.category_catalog_compat_until(c.id)) valid_until FROM whaleu_ratings.catalog_heads h JOIN whaleu_ratings.catalogs c ON c.id=h.catalog_id WHERE h.scope_key=coalesce($1::uuid::text,'global') AND c.region_id IS NOT DISTINCT FROM $1::uuid AND whaleu_ratings.category_catalog_compat_current(c.id) AND c.sealed AND c.coverage='complete' AND c.provenance='accepted' AND c.effective_at<=clock_timestamp() AND (c.valid_until IS NULL OR c.valid_until>clock_timestamp()) FOR UPDATE OF h`,
          [region],
        )
        .catch((error: unknown) => {
          if (
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            error.code === '23514'
          )
            throw new ApplicationError('RATING_UNAVAILABLE');
          throw error;
        })
    ).rows[0];
    if (!row) throw new ApplicationError('RATING_UNAVAILABLE');
    if (row.id !== expected)
      throw new ApplicationError('RATING_REVISION_CONFLICT');
    registerTransactionDeadline(
      tx,
      row.valid_until?.getTime() ?? null,
      'RATING_UNAVAILABLE',
    );
    return { id: row.id, regionId: region };
  }
  async copy(
    before: string,
    after: string,
    source: string,
    policy: string,
    time: string,
    tx: PoolClient,
  ) {
    // Local finite budgets: exact set copy or full rollback. No pagination truncation.
    const counts = (
      await tx.query<{ categories: number; memberships: number }>(
        `SELECT (SELECT count(*)::integer FROM (SELECT 1 FROM whaleu_ratings.categories WHERE catalog_id=$1 LIMIT 10001) x) categories,(SELECT count(*)::integer FROM (SELECT 1 FROM whaleu_ratings.target_memberships WHERE catalog_id=$1 LIMIT 100001) x) memberships`,
        [before],
      )
    ).rows[0]!;
    if (counts.categories > 10000 || counts.memberships > 100000)
      throw new ApplicationError('RATING_UNAVAILABLE');
    await tx.query(
      `INSERT INTO whaleu_ratings.catalogs(id,region_id,coverage,provenance,source_reference,policy_reference,effective_at,valid_until) SELECT $2,region_id,coverage,provenance,$3,$4,$5::timestamptz,valid_until FROM whaleu_ratings.catalogs WHERE id=$1 AND effective_at<$5::timestamptz`,
      [before, after, source, policy, time],
    );
    await tx.query(
      `INSERT INTO whaleu_ratings.categories SELECT $2,id,revision,parent_id,level,origin_kind,kind,system_key,name,description,active,hidden,ordinal FROM whaleu_ratings.categories WHERE catalog_id=$1 ORDER BY level,ordinal`,
      [before, after],
    );
    await tx.query(
      `INSERT INTO whaleu_ratings.target_memberships SELECT $2,target_id,category_id,ordinal FROM whaleu_ratings.target_memberships WHERE catalog_id=$1`,
      [before, after],
    );
  }
  async publish(
    before: string,
    after: string,
    target: string,
    category: string,
    region: string | null,
    tx: PoolClient,
  ) {
    await tx.query(
      `INSERT INTO whaleu_ratings.target_memberships SELECT $1,$2,$3,coalesce(max(ordinal),-1)+1 FROM whaleu_ratings.target_memberships WHERE catalog_id=$1`,
      [after, target, category],
    );
    await tx.query(
      'UPDATE whaleu_ratings.catalogs SET sealed=true WHERE id=$1',
      [after],
    );
    const result = await tx.query(
      `UPDATE whaleu_ratings.catalog_heads SET catalog_id=$2 WHERE scope_key=coalesce($3::uuid::text,'global') AND catalog_id=$1`,
      [before, after, region],
    );
    if (result.rowCount !== 1)
      throw new ApplicationError('RATING_REVISION_CONFLICT');
  }
}
