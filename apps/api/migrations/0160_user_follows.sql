-- Named public-profile follows are independent from post subscriptions.
CREATE TABLE whaleu_community.follow_heads (
  account_id uuid PRIMARY KEY REFERENCES whaleu_identity.accounts(id) ON DELETE CASCADE,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0)
);
CREATE TABLE whaleu_community.user_follows (
  follower_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id) ON DELETE CASCADE,
  followed_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id) ON DELETE CASCADE,
  followed_profile_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (follower_id, followed_profile_id),
  PRIMARY KEY (follower_id, followed_id),
  CHECK (follower_id <> followed_id)
);
CREATE TABLE whaleu_community.follow_requests (
  account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  profile_id uuid NOT NULL,
  following boolean NOT NULL,
  outcome text NOT NULL CHECK(outcome IN ('applied','rejected')),
  code text CHECK(code IN ('POST_NOT_FOUND','FOLLOW_SELF_NOT_ALLOWED','SAFETY_ACTION_RESTRICTED','SAFETY_ACCESS_SUSPENDED')),
  CHECK ((outcome='applied' AND code IS NULL) OR (outcome='rejected' AND code IS NOT NULL)),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (account_id, request_id)
);
CREATE INDEX following_named_posts ON whaleu_community.posts (account_id, published_at DESC, id DESC)
  WHERE author_mode='named' AND deleted_at IS NULL AND visibility='approved';

-- Reverse lookup keeps bounded follower counts independent of unrelated edges.
CREATE INDEX user_follows_followed ON whaleu_community.user_follows (followed_id, follower_id);
