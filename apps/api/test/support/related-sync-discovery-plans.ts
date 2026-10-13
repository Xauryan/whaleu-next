import assert from 'node:assert/strict';
import type { Pool } from 'pg';

export interface RelatedCandidatePlan {
  label: string;
  sql: string;
  values: unknown[];
  maximumRows: number;
}

/** Explain captured production SQL, never a test-only replacement predicate.
 * Tiny fixtures may correctly choose sequential scans; report that choice rather
 * than forcing an index or claiming this is a scale benchmark. */
export async function explainRelatedCandidatePlans(
  pool: Pool,
  plans: readonly RelatedCandidatePlan[],
  diagnostic: (message: string) => void,
): Promise<void> {
  assert.ok(plans.length > 0);
  for (const candidate of plans) {
    assert.doesNotMatch(
      candidate.sql,
      /community_distribution_group|related_distribution_view_(?:facts|allowed)|community_topology_(?:heads|snapshots)/,
      'candidate enumeration must consume the once-observed owner scope',
    );
    const result = await pool.query(
      `EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${candidate.sql}`,
      candidate.values,
    );
    const output = result.rows[0]['QUERY PLAN'][0] as Record<string, unknown>;
    const describe = (
      node: Record<string, unknown>,
    ): Record<string, unknown> => {
      assert.equal(Number(node['Temp Read Blocks'] ?? 0), 0, candidate.label);
      assert.equal(
        Number(node['Temp Written Blocks'] ?? 0),
        0,
        candidate.label,
      );
      assert.notEqual(node['Sort Space Type'], 'Disk', candidate.label);
      return {
        type: node['Node Type'],
        relation: node['Relation Name'],
        index: node['Index Name'],
        rows: node['Actual Rows'],
        loops: node['Actual Loops'],
        sort: node['Sort Method'],
        sharedHits: node['Shared Hit Blocks'],
        sharedReads: node['Shared Read Blocks'],
        children: Array.isArray(node['Plans'])
          ? node['Plans'].map((child) =>
              describe(child as Record<string, unknown>),
            )
          : [],
      };
    };
    const plan = output['Plan'] as Record<string, unknown>;
    assert.ok(
      Number(plan['Actual Rows']) <= candidate.maximumRows,
      candidate.label,
    );
    diagnostic(
      JSON.stringify({
        relatedCandidatePlan: {
          label: candidate.label,
          maximumRows: candidate.maximumRows,
          planningMs: output['Planning Time'],
          executionMs: output['Execution Time'],
          plan: describe(plan),
        },
      }),
    );
  }
}
