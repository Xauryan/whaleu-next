import assert from 'node:assert/strict';
import type { Pool } from 'pg';

/** Inspect actual owner-issued plans/catalogs after the original HTTP tests.
 * No fake source, replacement proof, timeout override or rerun of publication. */
export async function assertCategoryDigestAcceptance(pool: Pool) {
  assert.equal(
    (await pool.query('SHOW statement_timeout')).rows[0]!.statement_timeout,
    '15s',
  );
  const result = (
    await pool.query<{
      plans: number;
      catalogs: number;
      largest_membership: number;
      differences: number;
    }>(`WITH facts AS MATERIALIZED (
    SELECT 'category-plan'::text domain,category_plan||jsonb_build_object('previewDigest','') value
      FROM whaleu_ratings.scoped_command_preparations WHERE intent->'protocolVersion'='5'::jsonb
    UNION ALL SELECT 'compat-body',whaleu_ratings.legacy_catalog_body(v.legacy_catalog_id)
      FROM whaleu_ratings.compat_heads h JOIN whaleu_ratings.compat_versions v ON v.id=h.version_id WHERE v.state='equal'
  ) SELECT count(*) FILTER(WHERE domain='category-plan')::int plans,
    count(*) FILTER(WHERE domain='compat-body')::int catalogs,
    coalesce(max(jsonb_array_length(value->'memberships')) FILTER(WHERE domain='compat-body'),0)::int largest_membership,
    count(*) FILTER(WHERE convert_to(whaleu_ratings.category_digest_fast_canonical(domain,value),'UTF8')
      IS DISTINCT FROM convert_to(whaleu_ratings.creation_canonical_json(value),'UTF8'))::int differences
    FROM facts`)
  ).rows[0]!;
  assert.ok(result.plans > 0);
  assert.ok(result.catalogs > 0);
  assert.equal(
    result.differences,
    0,
    'Real prepared plans and full immutable outputs must take byte-identical fast paths',
  );
  return result;
}
