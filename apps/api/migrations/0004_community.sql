-- New target only. No production catalog, verification, moderation or media grants.
CREATE TABLE whaleu_campus.operating_regions (
  id uuid PRIMARY KEY, name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200), is_active boolean NOT NULL DEFAULT false
);
CREATE TABLE whaleu_campus.campus_region_assignments (
  campus_id uuid PRIMARY KEY REFERENCES whaleu_campus.campuses(id),
  operating_region_id uuid NOT NULL REFERENCES whaleu_campus.operating_regions(id)
);
CREATE INDEX campus_region_region ON whaleu_campus.campus_region_assignments(operating_region_id);
-- A public profile identity is deliberately distinct from the private account identity.
ALTER TABLE whaleu_profile.profiles ADD COLUMN public_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE;
CREATE SCHEMA whaleu_community;
CREATE TABLE whaleu_community.spaces (
  id uuid PRIMARY KEY, kind text NOT NULL CHECK (kind IN ('regional','global')),
  operating_region_id uuid UNIQUE REFERENCES whaleu_campus.operating_regions(id),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200), is_active boolean NOT NULL DEFAULT false,
  CHECK ((kind='regional' AND operating_region_id IS NOT NULL) OR (kind='global' AND operating_region_id IS NULL))
);
CREATE TABLE whaleu_community.posts (
  id uuid PRIMARY KEY, space_id uuid NOT NULL REFERENCES whaleu_community.spaces(id),
  account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
  category text NOT NULL CHECK (category IN ('discussion','confession','companions','pets','internships','scenery','dorms','research','deep_sea')),
  text text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 2500 AND text ~ '[^[:space:]]'),
  author_mode text NOT NULL CHECK (author_mode IN ('named','anonymous')),
  comments_policy text NOT NULL CHECK (comments_policy IN ('open','restricted')),
  publication_state text NOT NULL DEFAULT 'published' CHECK (publication_state='published'),
  visibility text NOT NULL DEFAULT 'approved' CHECK (visibility IN ('approved','hidden')),
  deleted_at timestamptz, published_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp())
);
CREATE INDEX posts_feed ON whaleu_community.posts(space_id,published_at DESC,id DESC) WHERE deleted_at IS NULL AND visibility='approved';
CREATE INDEX posts_account ON whaleu_community.posts(account_id,published_at DESC,id DESC);
CREATE TABLE whaleu_community.thread_personas (
  id uuid PRIMARY KEY, post_id uuid NOT NULL REFERENCES whaleu_community.posts(id),
  account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 80), UNIQUE(post_id,account_id)
);
CREATE TABLE whaleu_community.root_comments (
  id uuid PRIMARY KEY, post_id uuid NOT NULL REFERENCES whaleu_community.posts(id),
  account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
  text text NOT NULL CHECK (char_length(text)<=500),
  author_mode text NOT NULL CHECK (author_mode IN ('named','anonymous')),
  visibility text NOT NULL DEFAULT 'approved' CHECK (visibility IN ('approved','hidden')),
  deleted_at timestamptz, created_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp())
);
CREATE INDEX comments_post ON whaleu_community.root_comments(post_id,created_at DESC,id DESC);
CREATE INDEX comments_account ON whaleu_community.root_comments(account_id);
CREATE TABLE whaleu_community.post_images (
  post_id uuid NOT NULL REFERENCES whaleu_community.posts(id), asset_id uuid NOT NULL,
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'), position integer NOT NULL CHECK (position BETWEEN 0 AND 8),
  PRIMARY KEY(post_id,position), UNIQUE(post_id,asset_id)
);
CREATE TABLE whaleu_community.comment_images (
  comment_id uuid NOT NULL REFERENCES whaleu_community.root_comments(id), asset_id uuid NOT NULL,
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'), position integer NOT NULL CHECK (position BETWEEN 0 AND 2),
  PRIMARY KEY(comment_id,position), UNIQUE(comment_id,asset_id)
);
CREATE TABLE whaleu_community.post_likes (
  post_id uuid NOT NULL REFERENCES whaleu_community.posts(id), account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
  PRIMARY KEY(post_id,account_id)
);
CREATE INDEX likes_account ON whaleu_community.post_likes(account_id);
-- The key and terminal receipt survive deletion indefinitely. No pending row is committed alone.
CREATE TABLE whaleu_community.publication_requests (
  account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id), client_request_id uuid NOT NULL,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  operation text NOT NULL CHECK (operation IN ('publish_post','publish_comment')),
  receipt jsonb, PRIMARY KEY(account_id,client_request_id),
  CHECK (receipt IS NULL OR (jsonb_typeof(receipt)='object' AND receipt->>'outcome' IN ('created','rejected')))
);
CREATE TABLE whaleu_community.outbox (
  id uuid PRIMARY KEY, event_key text NOT NULL UNIQUE, event_type text NOT NULL,
  resource_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp())
);
