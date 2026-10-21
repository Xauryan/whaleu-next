import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../src/config/config.js';
const base = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://db.example.test/whaleu',
  COMMUNITY_TEXT_REVIEW: 'source_manual',
  COMMUNITY_TEXT_REVIEW_SPACE_ID: '11111111-1111-4111-8111-111111111111',
  COMMUNITY_TEXT_REVIEW_REGION_ID: '22222222-2222-4222-8222-222222222222',
  COMMUNITY_TEXT_SOURCE_REVIEW_POLICY_ID:
    '33333333-3333-4333-8333-333333333333',
  COMMUNITY_TEXT_REVIEW_OPERATOR: 'manual:review-host:reviewer',
};
test('explicit production human source review loads without inventing provider credentials or legacy review', () => {
  const config = loadConfig(base);
  assert.equal(config.COMMUNITY_TEXT_REVIEW, 'source_manual');
  assert.equal(config.COMMUNITY_TEXT_REVIEW_POLICY_ID, undefined);
  assert.equal(config.WECHAT_APP_SECRET, undefined);
  assert.equal(config.PG_SSL_MODE, 'verify-full');
});
test('default remains fail-closed and manual source configuration must be complete', () => {
  assert.equal(
    loadConfig({ DATABASE_URL: base.DATABASE_URL }).COMMUNITY_TEXT_REVIEW,
    'disabled',
  );
  for (const key of [
    'COMMUNITY_TEXT_REVIEW_SPACE_ID',
    'COMMUNITY_TEXT_REVIEW_REGION_ID',
    'COMMUNITY_TEXT_SOURCE_REVIEW_POLICY_ID',
    'COMMUNITY_TEXT_REVIEW_OPERATOR',
  ]) {
    const value: Record<string, string | undefined> = {
      ...base,
      [key]: undefined,
    };
    assert.throws(() => loadConfig(value), /Source manual review/);
  }
});
test('source manual does not enable unrelated local review, feedback, or region configuration', () => {
  for (const key of [
    'COMMUNITY_TEXT_REVIEW_POLICY_ID',
    'COMMUNITY_RELATED_REVIEW_POLICY_ID',
    'COMMUNITY_FEEDBACK_SPACE_ID',
  ])
    assert.throws(() =>
      loadConfig({
        ...base,
        [key]: base.COMMUNITY_TEXT_SOURCE_REVIEW_POLICY_ID,
      }),
    );
  assert.throws(() =>
    loadConfig({ ...base, COMMUNITY_TEXT_REVIEW: 'local_manual' }),
  );
  assert.throws(() =>
    loadConfig({ ...base, COMMUNITY_TEXT_REVIEW: 'disabled' }),
  );
});
