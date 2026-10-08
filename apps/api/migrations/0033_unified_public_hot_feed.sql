-- Derived, fully covered native scores. No historical baselines or scores are
-- fabricated here. Component receipts remain the only evidence of effects.
CREATE TABLE whaleu_post_hotness.scores (
 post_id uuid PRIMARY KEY REFERENCES whaleu_post_hotness.subscription_baselines(post_id)
   REFERENCES whaleu_post_hotness.like_baselines(post_id)
   REFERENCES whaleu_post_hotness.comment_baselines(post_id)
   REFERENCES whaleu_post_hotness.view_baselines(post_id),
 owner_id uuid NOT NULL,
 source_request_id uuid NOT NULL,
 creation_xid xid8 NOT NULL,
 component_version smallint NOT NULL CHECK(component_version=1),
 source_formula_version smallint NOT NULL,
 numeric_profile text NOT NULL,
 numeric_profile_version smallint NOT NULL,
 formula_fingerprint text NOT NULL CHECK(formula_fingerprint ~ '^[a-f0-9]{64}$'),
 expression_fingerprint text NOT NULL CHECK(expression_fingerprint ~ '^[a-f0-9]{64}$'),
 score numeric(24,4) NOT NULL CHECK(score>=0 AND score<'Infinity'::numeric),
 -- Independent baseline identities, counters, captured/processed heads and
 -- terminal receipt identities; never bodies, memberships or viewer state.
 snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object' AND pg_column_size(snapshot)<=8192),
 certificate_hash text NOT NULL CHECK(certificate_hash ~ '^[a-f0-9]{64}$'),
 computed_at timestamptz NOT NULL
);
CREATE INDEX hot_scores_order ON whaleu_post_hotness.scores(score DESC,post_id DESC);
CREATE TABLE whaleu_post_hotness.processing (
 post_id uuid PRIMARY KEY REFERENCES whaleu_post_hotness.subscription_baselines(post_id)
   REFERENCES whaleu_post_hotness.like_baselines(post_id)
   REFERENCES whaleu_post_hotness.comment_baselines(post_id)
   REFERENCES whaleu_post_hotness.view_baselines(post_id),
 next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 last_attempt_at timestamptz,
 consecutive_failures smallint NOT NULL DEFAULT 0 CHECK(consecutive_failures BETWEEN 0 AND 8),
 result text NOT NULL DEFAULT 'pending' CHECK(result IN ('pending','current','blocked','failed'))
);
CREATE INDEX hot_processing_due ON whaleu_post_hotness.processing(next_attempt_at,last_attempt_at,post_id);
COMMENT ON TABLE whaleu_post_hotness.scores IS 'Private derived score certificates; current locked component proof is mandatory before public projection.';
COMMENT ON TABLE whaleu_post_hotness.processing IS 'Narrow scheduling hints, never component effect or coverage evidence.';
