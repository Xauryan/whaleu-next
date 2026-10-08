import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EffectiveContentEnvelope } from '../../src/community/content-review/contracts.js';
import type { ExactQueryObservation } from '../support/exact-discovery-counts.js';
import { searchHarness, ok } from './search-fixtures.js';
import {
  freshWorld,
  addSpace,
  addCatalog,
  instant,
  trading,
} from './federated-search-fixtures.js';

interface ExplainNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Actual Rows': number;
  'Actual Loops': number;
  'Rows Removed by Filter'?: number;
  'Shared Hit Blocks'?: number;
  'Shared Read Blocks'?: number;
  Plans?: ExplainNode[];
}
interface ExplainResult {
  Plan: ExplainNode;
  'Planning Time': number;
  'Execution Time': number;
}
function planNodes(node: ExplainNode): Omit<ExplainNode, 'Plans'>[] {
  const { Plans = [], ...current } = node;
  return [current, ...Plans.flatMap(planNodes)];
}

test(
  'federated structural plans: measured multi-region fixture, not a constant-work claim',
  { timeout: 300000 },
  async (t) => {
    const h = await searchHarness();
    try {
      const w = await freshWorld(h),
        related = await w.actor(w.scope.related),
        foreign = await w.actor(w.scope.foreign),
        extraGlobal = await addSpace(h);
      await addCatalog(h, 513);
      const bases = [
        await w.envelope({ text: 'ordinary synthetic body' }),
        await w.envelope(
          { spaceId: w.scope.related.spaceId, text: 'ordinary synthetic body' },
          related,
        ),
        await w.envelope(
          { spaceId: w.scope.foreign.spaceId, text: 'ordinary synthetic body' },
          foreign,
        ),
        await w.envelope({
          spaceId: w.scope.global.spaceId,
          text: 'ordinary synthetic body',
        }),
        await w.envelope({
          spaceId: extraGlobal.spaceId,
          text: 'ordinary synthetic body',
        }),
      ];
      const count = 12000;
      const definition = (index: number): EffectiveContentEnvelope => {
        const base = bases[index % bases.length]!;
        if (index % bases.length >= 3) return base;
        if (index % 101 === 0) return { ...base, category: 'research' };
        if (index % 97 === 0)
          return {
            ...base,
            category: 'trading',
            trading: { ...trading, subtype: index % 2 ? 'yifu' : 'shuma' },
          };
        return base;
      };
      await w.seed(count, definition, { time: instant });
      await h.pool.query('ANALYZE whaleu_community.posts');
      await h.pool.query('ANALYZE whaleu_community.trading_listings');
      await h.pool.query('ANALYZE whaleu_community.spaces');
      await h.pool.query('ANALYZE whaleu_campus.operating_regions');
      for (const [label, query] of [
        ['all', { scope: 'all' }],
        ['regional', { scope: 'regional' }],
        ['global', { scope: 'global' }],
        ['rare category', { scope: 'regional', category: 'research' }],
        [
          'rare subtype',
          { scope: 'regional', category: 'trading', tradingSubtype: 'yifu' },
        ],
      ] as const) {
        let candidate: ExactQueryObservation | undefined;
        const examinedBodies = new Set<string>(),
          reviewedPosts = new Set<string>();
        let reviewQueries = 0,
          bodyQueries = 0;
        h.observer.setHook(async (event) => {
          if (
            /LIMIT\s+129/i.test(event.sql) &&
            event.sql.includes('whaleu_community.posts')
          )
            candidate ??= event;
          if (
            /FROM whaleu_community.content_approval_bindings/i.test(event.sql)
          ) {
            reviewQueries++;
            assert.equal(event.values[0], 'post');
            reviewedPosts.add(event.values[1] as string);
          }
          if (
            /SELECT \* FROM whaleu_community.posts WHERE id=/.test(event.sql)
          ) {
            bodyQueries++;
            examinedBodies.add(event.values[0] as string);
          }
        });
        let measured;
        try {
          measured = await h.observer.measure(label, () =>
            w.aggregate({ ...query, q: 'needle' }),
          );
        } finally {
          h.observer.setHook(null);
        }
        ok(measured.value);
        assert.ok(
          candidate,
          'Capture the actual endpoint SQL, not an invented equivalent',
        );
        assert.ok(candidate.rows <= 129);
        assert.ok(
          examinedBodies.size <= 128,
          '129th structural lookahead never fetches a body',
        );
        assert.ok(
          reviewedPosts.size <= 128 &&
            [...reviewedPosts].every((id) => examinedBodies.has(id)),
          'Only examined bodies receive canonical review',
        );
        assert.deepEqual(measured.value.body.items, []);
        assert.equal(
          JSON.stringify(candidate.values).includes('needle'),
          false,
        );
        // Real planner choice with default enable_* settings, no forced index scan.
        const explained = await h.pool.query<{ 'QUERY PLAN': ExplainResult[] }>(
          `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${candidate.sql}`,
          candidate.values,
        );
        const plan = explained.rows[0]!['QUERY PLAN'][0]!;
        const nodes = planNodes(plan.Plan).map((node) => ({
          type: node['Node Type'],
          relation: node['Relation Name'],
          index: node['Index Name'],
          rows: node['Actual Rows'],
          loops: node['Actual Loops'],
          removed: node['Rows Removed by Filter'] ?? 0,
          hits: node['Shared Hit Blocks'] ?? 0,
          reads: node['Shared Read Blocks'] ?? 0,
        }));
        t.diagnostic(
          JSON.stringify({
            label,
            corpusRows: count,
            activeCatalogSpaces: 518,
            populatedRegionalSpaces: 3,
            populatedGlobalSpaces: 2,
            candidates: candidate.rows,
            examinedBodyReads: bodyQueries,
            distinctExaminedPosts: examinedBodies.size,
            reviewQueries,
            distinctReviewedPosts: reviewedPosts.size,
            endpointMs: Math.round(measured.measurement.durationMs * 100) / 100,
            endpointQueries: measured.measurement.queries,
            endpointResultBytes: measured.measurement.resultBytes,
            planningMs: plan['Planning Time'],
            executionMs: plan['Execution Time'],
            nodes,
          }),
        );
      }
      t.diagnostic(
        'Synthetic local PostgreSQL measurements only. A 128-candidate evaluation limit does not bound index entries examined, rare-filter work, selected-card serialization or full catalog enumeration; full literal traversal is O(corpus) and catalog resolution is O(catalog). No production throughput or latency guarantee.',
      );
    } finally {
      await h.close();
    }
  },
);
