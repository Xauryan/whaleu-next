import { createHash } from 'node:crypto';

/** Pinned source constants, not deployed configuration or PHP numeric parity. */
export const HOT_SCORE_FORMULA = Object.freeze({
  sourceFormulaVersion: 6,
  weights: Object.freeze({
    views: '7.6',
    postLikes: '24.0',
    comments: '10.0',
    subscriptions: '2.0',
  }),
  supportThresholds: Object.freeze({ views: '200', postLikes: '10' }),
  aggregateCommentCapMultiplier: '3',
  viewExponent: '0.4',
  logarithm: 'natural',
  finalScale: 4,
  sourceConfigBlob: 'e60cc94cbcfd210151779082acaec62c2d3a94c6',
  sourceServiceBlob: 'a25827d72b26027618be9d7743b7cdf56f34b4e2',
} as const);
export const HOT_SCORE_FORMULA_FINGERPRINT = createHash('sha256')
  .update(JSON.stringify(HOT_SCORE_FORMULA))
  .digest('hex');
export const HOT_SCORE_NUMERIC_PROFILE = 'pg18-numeric40-round4-v1' as const;
export const HOT_SCORE_NUMERIC_PROFILE_VERSION = 1 as const;

// This is intentionally one pinned expression. All inputs and constants enter
// numeric arithmetic before addition, cap multiplication, division or power.
// ln is natural log; PostgreSQL log would silently select the wrong formula.
export const HOT_SCORE_NUMERIC_SQL = `WITH inputs AS (
  SELECT $1::numeric(80,40) AS views, $2::numeric(80,40) AS likes,
    $3::numeric(80,40) AS subscriptions, $4::numeric(80,40) AS eligible,
    $5::numeric(80,40) AS actors
), constants AS (
  SELECT '7.6'::numeric(80,40) AS view_weight,
    '24.0'::numeric(80,40) AS like_weight,
    '10.0'::numeric(80,40) AS comment_weight,
    '2.0'::numeric(80,40) AS subscription_weight,
    '200'::numeric(80,40) AS view_threshold,
    '10'::numeric(80,40) AS like_threshold,
    '3'::numeric(80,40) AS cap,
    '0.4'::numeric(80,40) AS exponent,
    '1'::numeric(80,40) AS one
)
SELECT round(
  view_weight * power(views, exponent) + like_weight * ln(one + likes)
  + greatest(least(one, sqrt(views / view_threshold)),
      least(one, sqrt(likes / like_threshold)))
    * (comment_weight * ln(one + least(eligible, actors * cap))
      + subscription_weight * ln(one + subscriptions)),
  4)::numeric(24,4)::text AS score,
  current_setting('server_version_num')::integer AS server_version
FROM inputs CROSS JOIN constants`;

export const HOT_SCORE_EXPRESSION_FINGERPRINT = createHash('sha256')
  .update(HOT_SCORE_NUMERIC_SQL)
  .digest('hex');
