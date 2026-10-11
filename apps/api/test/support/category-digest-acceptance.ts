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
  // Compare all four original whole-release components from actual 32-icon or
  // 2048-target publications. Keep the same wrapper and source-vector join as
  // verify_scoped_release; an omitted component cannot hide in an equal hash.
  const releases = (
    await pool.query<{ id: string }>(
      "SELECT id FROM whaleu_ratings.scoped_releases WHERE cause->>'categoryIconExtension'='ratings-category-icon-v1' ORDER BY id",
    )
  ).rows;
  assert.ok(releases.length > 0);
  for (const release of releases) {
    const components = (
      await pool.query<{
        component: string;
        count: number;
        fast: string;
        original: string;
      }>(
        `WITH facts AS (
      SELECT 'categories' component,to_jsonb(a) value FROM whaleu_ratings.scoped_categories a JOIN whaleu_ratings.scoped_catalogs c ON c.id=a.catalog_id WHERE c.release_id=$1
      UNION ALL SELECT 'lineage',to_jsonb(a) FROM whaleu_ratings.scoped_category_lineage a JOIN whaleu_ratings.scoped_catalogs c ON c.id=a.catalog_id WHERE c.release_id=$1
      UNION ALL SELECT 'memberships',to_jsonb(a) FROM whaleu_ratings.scoped_target_memberships a JOIN whaleu_ratings.scoped_catalogs c ON c.id=a.catalog_id WHERE c.release_id=$1
      UNION ALL SELECT 'sources',to_jsonb(s) FROM whaleu_ratings.scoped_releases r CROSS JOIN LATERAL jsonb_array_elements(r.source_vector) v JOIN whaleu_ratings.scoped_source_attestations s ON s.id=(v->>'id')::uuid WHERE r.id=$1
    ), wrapped AS (
      SELECT component,jsonb_build_object('value',value) value FROM facts
    ) SELECT component,count(*)::int count,
      sum(whaleu_ratings.category_icon_canonical_octets(value))::text fast,
      sum(octet_length(convert_to(whaleu_ratings.creation_canonical_json(value),'UTF8')))::text original
      FROM wrapped GROUP BY component ORDER BY component`,
        [release.id],
      )
    ).rows;
    assert.ok(
      components.some((c) => c.component === 'categories' && c.count > 0),
    );
    assert.ok(components.some((c) => c.component === 'lineage' && c.count > 0));
    assert.ok(components.some((c) => c.component === 'sources' && c.count > 0));
    if (result.largest_membership === 2048)
      assert.ok(
        components.some(
          (c) => c.component === 'memberships' && c.count === 4096,
        ),
      );
    for (const component of components)
      assert.equal(
        component.fast,
        component.original,
        `${release.id} ${component.component}: count every original canonical UTF-8 byte`,
      );
  }
  return result;
}
