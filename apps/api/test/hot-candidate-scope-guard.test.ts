import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { categorySchema } from '../src/community/contracts.js';
import type { CommunitySpace } from '../src/community/contracts.js';
import { reclassificationCategorySchema } from '../src/community/category-reclassification/contracts.js';
import { homeDistributionCandidateSql } from '../src/community/home-distribution/candidate-sql.js';
import {
  HOT_CURRENT_HINT,
  HOT_CURRENT_JOINS,
} from '../src/community/hot-score/storage.js';
import { HOT_RANGES, hotQuerySchema } from '../src/community/hot/contracts.js';
import type { HotAnchor } from '../src/community/hot/cursor.js';
import {
  HOT_SCAN_BATCH,
  HotRepository,
} from '../src/community/hot/repository.js';
import type { HotCandidate } from '../src/community/hot/repository.js';
import type { CommunityDistributionScope } from '../src/community/related-sync/contracts.js';
import type { CommunityDistributionService } from '../src/community/related-sync/service.js';

const spaceId = '00000000-0000-4000-8000-000000000001';
const remoteId = '00000000-0000-4000-8000-000000000002';
const authorId = '00000000-0000-4000-8000-000000000003';
const readerId = '00000000-0000-4000-8000-000000000004';
const clock = '2026-10-12T00:00:00.000000Z';
const after: HotAnchor = {
  score: '9007199254740992.0001',
  id: '00000000-0000-4000-8000-000000000005',
};
const compact = (sql: string) => sql.replace(/\s+/g, ' ').trim();
const water = `COALESCE((SELECT home_category.current_category
  FROM whaleu_community.post_category_heads home_category
  WHERE home_category.post_id=p.id),p.category)<>'water'`;
const cheap = `p.category=ANY($2::text[]) AND p.deleted_at IS NULL AND p.visibility='approved'
  AND p.published_at<=$3::timestamptz AND ($4::integer IS NULL OR p.published_at>=$3::timestamptz-make_interval(hours=>$4::integer*24))`;
const space = (kind: CommunitySpace['kind']): CommunitySpace => ({
  id: spaceId,
  kind,
  name: 'Synthetic Hot scope guard',
  isActive: true,
  operatingRegionId: kind === 'regional' ? remoteId : null,
});
function capture(rows: HotCandidate[] = []) {
  const statements: { sql: string; values: unknown[] }[] = [];
  const tx = {
    query: async (sql: string, values: unknown[]) => {
      statements.push({ sql: compact(sql), values: [...values] });
      return { rows };
    },
  } as unknown as PoolClient;
  return { tx, statements };
}

function assertCandidate(
  statement: { sql: string; values: unknown[] },
  eligibility: string,
  parameters: unknown[],
  viewer: string | null,
) {
  const home = homeDistributionCandidateSql('p', viewer, 'hot', parameters);
  const guard = compact(
    `CASE WHEN $1::uuid IS NOT NULL AND (${eligibility}) AND ${cheap} THEN ${water} ELSE false END`,
  );
  assert.ok(statement.sql.includes(guard));
  assert.equal(statement.sql.split(guard).length, 2, 'Exactly one water guard');
  // Removing only the exact CASE wrapper must recover the complete original
  // candidate query, including all joins, home/trading/hint predicates and seek.
  assert.equal(
    statement.sql.replace(guard, compact(water)),
    compact(`SELECT p.id,p.space_id AS "spaceId",to_char(p.published_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at,hs.score::text
      FROM whaleu_post_hotness.scores hs JOIN whaleu_community.posts p ON p.id=hs.post_id ${HOT_CURRENT_JOINS}
      WHERE $1::uuid IS NOT NULL AND ${eligibility} AND ${home} AND ${water} AND ${cheap}
      AND (p.category<>'trading' OR EXISTS(SELECT 1 FROM whaleu_community.trading_listings t WHERE t.post_id=p.id AND t.urgency='normal' AND t.resolution='open'))
      AND (${HOT_CURRENT_HINT}) AND ($5::numeric IS NULL OR (hs.score,p.id)<($5::numeric,$6::uuid))
      ORDER BY hs.score DESC,p.id DESC LIMIT 129`),
  );
  assert.deepEqual(statement.values, parameters);
  assert.doesNotMatch(statement.sql, /LATERAL|UNION ALL|MATERIALIZED/);
  assert.equal(HOT_SCAN_BATCH, 128);
}

test('Hot guards only the original water head with exact scope and cheap eligibility for every range, seek and viewer', async () => {
  const repository = new HotRepository();
  for (const kind of ['regional', 'global'] as const)
    for (const range of Object.keys(HOT_RANGES) as (keyof typeof HOT_RANGES)[])
      for (const anchor of [null, after])
        for (const viewer of [null, authorId, readerId]) {
          const { tx, statements } = capture();
          await repository.candidates(
            space(kind),
            hotQuerySchema.parse({ spaceId, range, limit: '1' }),
            clock,
            anchor,
            tx,
            undefined,
            viewer,
          );
          assert.equal(statements.length, 1);
          assertCandidate(
            statements[0]!,
            'p.space_id=$1',
            [
              spaceId,
              kind === 'global'
                ? ['discussion', 'feedback']
                : [...categorySchema.options, 'water'],
              clock,
              HOT_RANGES[range].days,
              anchor?.score ?? null,
              anchor?.id ?? null,
            ],
            viewer,
          );
        }
});

test('Hot repeats the complete distribution predicate without rebinding or broadening related eligibility', async () => {
  for (const remoteSpaceIds of [[], [remoteId]]) {
    const scope: CommunityDistributionScope = {
      viewSpaceId: spaceId,
      viewRegionId: remoteId,
      relatedCampusDistribution: 'complete',
      fingerprint: 'synthetic-scope-guard',
      originalSpaceIds: [spaceId, ...remoteSpaceIds],
      remoteSpaceIds,
    };
    const parameters: unknown[] = [
      spaceId,
      [...categorySchema.options, 'water'],
      clock,
      null,
      after.score,
      after.id,
      spaceId,
    ];
    // Deliberately include nested AND/OR eligibility, not merely a space list.
    // This is a SQL-owner boundary double, never a live distribution proof.
    const eligibility = remoteSpaceIds.length
      ? `(p.space_id=$7::uuid OR (p.space_id=ANY($8::uuid[]) AND ${homeDistributionCandidateSql('p', null, 'related_sync', parameters)} AND (p.publication_envelope_version=4 OR EXISTS(SELECT 1 FROM whaleu_community.post_distribution_bindings ds WHERE ds.post_id=p.id))))`
      : '(p.space_id=$7::uuid)';
    if (remoteSpaceIds.length) parameters.push(remoteSpaceIds);
    let calls = 0;
    const distribution = {
      sqlPredicate: (
        actual: CommunityDistributionScope,
        alias: string,
        categoryColumn: string,
        values: unknown[],
      ) => {
        calls++;
        assert.equal(actual, scope);
        assert.equal(alias, 'p');
        assert.equal(categoryColumn, 'category');
        assert.deepEqual(values, parameters.slice(0, 6));
        values.push(...parameters.slice(6));
        return eligibility;
      },
    } as unknown as CommunityDistributionService;
    const { tx, statements } = capture();
    await new HotRepository(distribution).candidates(
      space('regional'),
      hotQuerySchema.parse({ spaceId, range: 'history' }),
      clock,
      after,
      tx,
      scope,
      readerId,
    );
    assert.equal(calls, 1, 'Bind scope once and reuse exactly that predicate');
    assert.equal(statements.length, 1);
    assertCandidate(statements[0]!, eligibility, parameters, readerId);
  }
});

test('Hot leaves 129-row metadata lookahead intact and does not invent water reclassification', async () => {
  const rows = Array.from({ length: 129 }, (_, index): HotCandidate => ({
    id: `00000000-0000-4000-8000-${String(129 - index).padStart(12, '0')}`,
    spaceId,
    at: clock,
    score: '0.0000',
  }));
  const { tx, statements } = capture(rows);
  const result = await new HotRepository().candidates(
    space('regional'),
    hotQuerySchema.parse({ spaceId, limit: '1' }),
    clock,
    null,
    tx,
  );
  assert.equal(result, rows);
  assert.equal(result.length, 129);
  assert.equal(statements.length, 1);
  assert.match(
    statements[0]!.sql,
    /ORDER BY hs.score DESC,p.id DESC LIMIT 129$/,
  );
  assert.equal(
    reclassificationCategorySchema.safeParse('water').success,
    false,
  );
  for (const category of ['pets', 'scenery'])
    assert.equal(
      reclassificationCategorySchema.safeParse(category).success,
      true,
    );
});
