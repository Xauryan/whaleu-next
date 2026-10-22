import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { RuntimeConfig } from '../../../src/config/config.js';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');

// Exact da278/62546 config, preparation-only0181, and request-entry0182 successor.
// These hashes do not assert new signer trust or acceptance authority.
export const historicalConfigProvenance = Object.freeze({
  acceptedCommit: 'da2784781db741e2fff5ad279fe3bc853bab0552',
  acceptedBlob: '8ded484925429b7da13de0a2ca7ac41d59c8a494',
  acceptedSha256:
    '7c5b02c13ba0ad5b689e239f47cb8952e908239babdde04bb1f2c2d86e3e2268',
  requestsSha256:
    'e5797289e280504c5304284f1e32514092aa7192238d0e7fc078f63fb0ba4701',
  preparationsSha256:
    '55d5ecdb4a48112659ab9da267212ff345f5de2d5ea71a9c4cd25eb9643b685d',
});
const requestField = `  REAL_ACCOUNT_DELETION_NEW_REQUESTS: z
    .enum(['disabled', 'qualified_owner'])
    .default('disabled'),
`;
const requestFieldAnchor = '  REAL_ACCOUNT_DELETION_ENTRY: z\n';
const requestCondition = `  if (
    config.REAL_ACCOUNT_DELETION_NEW_REQUESTS === 'qualified_owner' &&
    (config.REAL_ACCOUNT_DELETION_ENTRY !== 'prepare_only' ||
      !config.IDENTITY_DELETION_DIGEST_KEYRING)
  )
    throw new Error(
      'New real requests require preparation entry and IDENTITY_DELETION_DIGEST_KEYRING; these do not qualify an admission owner',
    );
`;
const requestConditionAnchor = `  if (
    config.IDENTITY_REGISTRATION_GUARD === 'required' &&
`;
const preparationField = `  REAL_ACCOUNT_DELETION_ENTRY: z
    .enum(['disabled', 'prepare_only'])
    .default('disabled'),
`;
const preparationAnchor = '  IDENTITY_REGISTRATION_GUARD: z\n';
function uniquePosition(source: string, exact: string): number {
  const position = source.indexOf(exact);
  assert.notEqual(position, -1, 'Missing exact reviewed config span');
  assert.equal(
    source.indexOf(exact, position + 1),
    -1,
    'Duplicated reviewed config span',
  );
  return position;
}
function removeBefore(source: string, addition: string, anchor: string) {
  const position = uniquePosition(source, addition);
  assert.equal(uniquePosition(source, anchor), position + addition.length);
  return source.slice(0, position) + source.slice(position + addition.length);
}
function insertBefore(source: string, addition: string, anchor: string) {
  assert.equal(source.includes(addition), false);
  const position = uniquePosition(source, anchor);
  return source.slice(0, position) + addition + source.slice(position);
}
/** Exact reversible byte proof, not a broad REAL_* removal or hash refresh. */
export function restoreAcceptedHistoricalConfig(bytes: Buffer): string {
  const current = bytes.toString('utf8');
  assert.equal(sha(current), historicalConfigProvenance.requestsSha256);
  const preparation = removeBefore(
    removeBefore(current, requestCondition, requestConditionAnchor),
    requestField,
    requestFieldAnchor,
  );
  assert.equal(sha(preparation), historicalConfigProvenance.preparationsSha256);
  assert.equal(
    insertBefore(
      insertBefore(preparation, requestField, requestFieldAnchor),
      requestCondition,
      requestConditionAnchor,
    ),
    current,
  );
  const accepted = removeBefore(
    preparation,
    preparationField,
    preparationAnchor,
  );
  assert.equal(sha(accepted), historicalConfigProvenance.acceptedSha256);
  assert.equal(
    createHash('sha1')
      .update(`blob ${Buffer.byteLength(accepted)}\0`)
      .update(accepted)
      .digest('hex'),
    historicalConfigProvenance.acceptedBlob,
  );
  assert.equal(
    insertBefore(accepted, preparationField, preparationAnchor),
    preparation,
  );
  return accepted;
}

export const historicalConfigEnvironment = Object.freeze({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://fixture@127.0.0.1/whaleu_test',
  PG_SSL_MODE: 'disable',
  LOG_LEVEL: 'silent',
});
// Explicit accepted 7c5 contract for the synthetic old-input fixture. This is
// not generated from current loadConfig output or an executed source string.
const legacyDefaults = Object.freeze({
  NODE_ENV: 'test',
  HTTP_HOST: '127.0.0.1',
  PORT: 3000,
  DATABASE_URL: historicalConfigEnvironment.DATABASE_URL,
  PG_SSL_MODE: 'disable',
  PG_POOL_MAX: 10,
  PG_CONNECTION_TIMEOUT_MS: 5000,
  PG_STATEMENT_TIMEOUT_MS: 10000,
  NATIVE_VERIFICATION_ENROLLMENT: 'disabled',
  WECHAT_PHONE_BINDING: 'disabled',
  IDENTITY_REGISTRATION_GUARD: 'automatic',
  RATINGS_UPDATES_PROCESSING: 'disabled',
  COMMUNITY_TEXT_REVIEW: 'disabled',
  COMMUNITY_SEMANTIC_SEARCH: 'disabled',
  COMMUNITY_SEMANTIC_TRANSMISSION: 'disabled',
  COMMUNITY_SEMANTIC_TIMEOUT_MS: 5000,
  COMMUNITY_READING_FORMATTING_PROCESSING: 'disabled',
  COMMUNITY_READING_FORMATTING_INTERVAL_MS: 5000,
  COMMUNITY_READING_FORMATTING_TICKS_PER_CYCLE: 1,
  COMMUNITY_UPDATES_PROCESSING: 'manual_only',
  COMMUNITY_UPDATES_INTERVAL_MS: 5000,
  COMMUNITY_UPDATES_BATCH_SIZE: 20,
  EXPERIENCE_PROCESSING: 'manual_only',
  EXPERIENCE_INTERVAL_MS: 5000,
  EXPERIENCE_BATCH_SIZE: 20,
  SUBSCRIPTION_COMPONENT_PROCESSING: 'manual_only',
  COMMENT_COMPONENT_PROCESSING: 'manual_only',
  LIKE_COMPONENT_PROCESSING: 'manual_only',
  HOT_FEED_PROCESSING: 'disabled',
  HOT_SCORE_COMPUTATION: 'disabled',
  VIEW_REPORTING_RETENTION_PROCESSING: 'automatic',
  SAFETY_JURY_PROCESSING: 'disabled',
  SAFETY_JURY_INTERVAL_MS: 5000,
  SAFETY_JURY_BATCH_SIZE: 20,
  SAFETY_REPORTS_PER_MINUTE: 30,
  SAFETY_VOTES_PER_MINUTE: 30,
  SAFETY_REPORT_READS_PER_MINUTE: 120,
  SAFETY_TARGET_REQUESTS_PER_MINUTE: 120,
  LOG_LEVEL: 'silent',
});
export function assertHistoricalConfigProjection(
  config: RuntimeConfig,
  overrides: Record<string, unknown> = {},
): void {
  const added = new Set([
    'REAL_ACCOUNT_DELETION_ENTRY',
    'REAL_ACCOUNT_DELETION_NEW_REQUESTS',
  ]);
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(config).filter(([key]) => !added.has(key)),
    ),
    { ...legacyDefaults, ...overrides },
  );
  assert.equal(Object.isFrozen(config), true);
}
