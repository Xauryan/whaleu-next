/** Independent protocol spaces. Never reinterpret a legacy journal or Review. */
export const RATING_SCOPED_PROTOCOL_VERSION = 2;
export const RATING_SCOPED_JOURNAL_VERSION = 9;
export const RATING_SCOPED_REVIEW_VERSION = 5;
export const RATING_SCOPED_COMPILER_VERSION = 'ratings-scoped-catalog-v1';
export const RATING_SCOPED_CAPABILITY_VERSION = 'ratings-scoped-full-v1';
export const RATING_SCOPED_CONTEXT_SECONDS = 300;
export const RATING_SCOPED_CAMPUS_LIMIT = 1000;
export const RATING_SCOPED_REGION_LIMIT = 200;
export const RATING_SCOPED_SCOPE_LIMIT = 1001;
export const RATING_SCOPED_CATEGORY_LIMIT = 10000;
export const RATING_SCOPED_MEMBERSHIP_LIMIT = 100000;
export const RATING_SCOPED_POOL_TARGET_LIMIT = 10000;
export const RATING_SCOPED_POOL_PATH_LIMIT = 50000;
export const RATING_SCOPED_BYTE_LIMIT = 64 * 1024 * 1024;
/** Conservative whole-release admission; never a truncated success. */
export const RATING_SCOPED_RELEASE_CATEGORY_LIMIT = 100000;
export const RATING_SCOPED_RELEASE_MEMBERSHIP_LIMIT = 100000;

export const RATING_SCOPED_REQUIRED_CAPABILITIES = Object.freeze([
  'navigation_v2',
  'random_v2',
  'discussion_v2',
  'likes_v2',
  'subscriptions_v2',
  'notices_v2',
  'm1_v2',
  'm2_v2',
  'review_sql_v5',
  'shared_recovery_v9',
  'native_routes_v2',
  'legacy_cleanup_v1',
] as const);
