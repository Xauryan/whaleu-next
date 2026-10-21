/** Real EXPLAIN evidence for the exact SQL/binds observed on an HTTP read.
 * No planner switches, hints, rewritten predicates, or simulated row counts. */
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import type { TestContext } from 'node:test';
export interface DiscussionQuerySample {
  sql: string;
  values: unknown[];
}
export function discussionEnumeration(sql: string): string | null {
  return (
    /^\/\* discussion:root-(time|likes-desc|likes-asc|likes-equal) \*\//.exec(
      sql,
    )?.[1] ??
    (sql.startsWith('SELECT * FROM whaleu_community.replies') &&
    sql.includes('LIMIT 129')
      ? 'replies'
      : null)
  );
}
interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Actual Rows': number;
  'Actual Loops': number;
  'Rows Removed by Filter'?: number;
  'Rows Removed by Index Recheck'?: number;
  'Shared Hit Blocks'?: number;
  'Shared Read Blocks'?: number;
  'Heap Fetches'?: number;
  Plans?: PlanNode[];
}
export async function proveDiscussionPlan(
  pool: Pool,
  t: TestContext,
  label: string,
  sample: DiscussionQuerySample,
) {
  assert.ok(discussionEnumeration(sample.sql));
  const limit = Number(/LIMIT (\d+)/.exec(sample.sql)![1]);
  assert.ok(limit >= 1 && limit <= 129);
  const result = await pool.query<{ 'QUERY PLAN': { Plan: PlanNode }[] }>(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sample.sql}`,
    sample.values,
  );
  const plan = result.rows[0]!['QUERY PLAN'][0]!.Plan;
  const nodes: PlanNode[] = [];
  const visit = (node: PlanNode) => {
    nodes.push(node);
    for (const child of node.Plans ?? []) visit(child);
  };
  visit(plan);
  const relations = nodes.filter((node) => node['Relation Name'] !== undefined);
  assert.equal(
    relations.length,
    1,
    'Enumeration must not aggregate or probe likes per root',
  );
  // Bitmap index construction can do unbounded work before a bounded heap
  // result, so include index-only plan nodes as well as relation scan nodes.
  const scans = nodes.filter(
    (node) =>
      node['Relation Name'] !== undefined || node['Index Name'] !== undefined,
  );
  const metrics = scans.map((node) => ({
    node: node['Node Type'],
    relation: node['Relation Name'],
    index: node['Index Name'] ?? null,
    rows: node['Actual Rows'],
    loops: node['Actual Loops'],
    removed:
      (node['Rows Removed by Filter'] ?? 0) +
      (node['Rows Removed by Index Recheck'] ?? 0),
    visited:
      (node['Actual Rows'] +
        (node['Rows Removed by Filter'] ?? 0) +
        (node['Rows Removed by Index Recheck'] ?? 0)) *
      node['Actual Loops'],
    hits: node['Shared Hit Blocks'] ?? 0,
    reads: node['Shared Read Blocks'] ?? 0,
    heapFetches: node['Heap Fetches'] ?? null,
  }));
  t.diagnostic(
    JSON.stringify({
      label,
      limit,
      planNodes: nodes.map((n) => n['Node Type']),
      scans: metrics,
    }),
  );
  // Count scanned rows/loops, not only the Limit's output or the index name.
  // A production-planner seq scan on a genuinely tiny relation is acceptable.
  // At most one excluded singleton pin may be encountered in an ordered range.
  for (const scan of metrics) {
    assert.ok(scan.loops <= 1, `${label}: repeated relation scans`);
    assert.ok(
      scan.visited <= limit + 1,
      `${label}: ${scan.visited} scanned rows exceeds ${limit}+one pin`,
    );
  }
  assert.equal(
    nodes.some((n) => /Aggregate/.test(n['Node Type'])),
    false,
  );
}
