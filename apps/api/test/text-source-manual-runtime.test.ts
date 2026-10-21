import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { loadConfig } from '../src/config/config.js';
import { ApprovalRepository } from '../src/community/content-review/approval.repository.js';
import { TextReviewRuntime } from '../src/community/text-review/runtime.js';
import { TextReviewOperator } from '../src/community/text-review/operator.js';
const config = loadConfig({
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://db.example.test/whaleu',
  COMMUNITY_TEXT_REVIEW: 'source_manual',
  COMMUNITY_TEXT_REVIEW_SPACE_ID: '11111111-1111-4111-8111-111111111111',
  COMMUNITY_TEXT_REVIEW_REGION_ID: '22222222-2222-4222-8222-222222222222',
  COMMUNITY_TEXT_SOURCE_REVIEW_POLICY_ID:
    '33333333-3333-4333-8333-333333333333',
  COMMUNITY_TEXT_REVIEW_OPERATOR: 'manual:review-host:reviewer',
});
const runtime = new TextReviewRuntime(config, new ApprovalRepository());
const space = {
  id: config.COMMUNITY_TEXT_REVIEW_SPACE_ID!,
  operatingRegionId: config.COMMUNITY_TEXT_REVIEW_REGION_ID!,
};
function client(
  query: (sql: string, params: unknown[]) => unknown[],
): PoolClient {
  return {
    query: async (sql: string, params: unknown[] = []) => ({
      rows: query(sql, params),
    }),
  } as unknown as PoolClient;
}
test('production manual source requires a current matching policy and never enables ordinary or related review', async () => {
  assert.equal(runtime.configured(), false);
  assert.equal(runtime.sourceConfigured(), true);
  const noQuery = client(() => {
    throw new Error('unexpected query');
  });
  assert.equal(await runtime.available(space, noQuery), false);
  assert.equal(await runtime.relatedAvailable(space, noQuery), false);
  assert.equal(
    await runtime.sourceAvailable(
      { ...space, operatingRegionId: null },
      noQuery,
    ),
    false,
  );
  assert.equal(
    await runtime.sourceAvailable(
      space,
      client(() => []),
    ),
    false,
  );
  assert.equal(
    await runtime.sourceAvailable(
      space,
      client((sql, params) => {
        assert.match(sql, /policy_key='local-text-source-v1'/);
        assert.match(sql, /provenance='accepted'/);
        assert.match(sql, /valid_until>clock_timestamp\(\)/);
        assert.deepEqual(params, [
          config.COMMUNITY_TEXT_SOURCE_REVIEW_POLICY_ID,
          config.COMMUNITY_TEXT_REVIEW_OPERATOR,
        ]);
        return [{ valid_until: null }];
      }),
    ),
    true,
  );
});
test('production manual issuer rejects wrong OS identity and unrelated policy initialization before any SQL', async () => {
  const tx = client(() => {
    throw new Error('unexpected query');
  });
  const operator = new TextReviewOperator(
    runtime,
    config.COMMUNITY_TEXT_REVIEW_OPERATOR!,
  );
  for (const command of [
    'init-policy',
    'init-related-policy',
    'init-feedback',
  ] as const)
    await assert.rejects(
      operator.run({ command, basis: 'explicit test' }, tx),
      /cannot administer unrelated/,
    );
  await assert.rejects(
    new TextReviewOperator(runtime, 'other').run({ command: 'list' }, tx),
    /Operator or explicit human-review configuration/,
  );
});
test('manual source pending listings explicitly filter version 6 and return no source text', async () => {
  const seen: string[] = [];
  await new TextReviewOperator(
    runtime,
    config.COMMUNITY_TEXT_REVIEW_OPERATOR!,
  ).run(
    { command: 'list' },
    client((sql, params) => {
      seen.push(sql);
      if (sql.includes('current_user')) return [{ actor: 'reviewer' }];
      assert.match(sql, /\$4::boolean=false OR \(q.envelope->>'version'='6'/);
      assert.match(sql, /q.expires_at>clock_timestamp\(\)/);
      assert.match(
        sql,
        /NOT EXISTS\(SELECT 1 FROM whaleu_community.publication_cancel_fences/,
      );
      assert.ok(sql.indexOf('NOT EXISTS') < sql.indexOf('ORDER BY'));
      assert.equal(params[3], true);
      assert.ok(!sql.includes('q.envelope,'));
      return [];
    }),
  );
  assert.equal(seen.length, 2);
});
