-- Private, disposable navigation references. No content, identity ownership,
-- authorization grant, frozen snapshot, provider or scheduled cleanup is added.
CREATE TABLE whaleu_community.discovery_cursors (
  cursor text PRIMARY KEY CHECK(cursor ~ '^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$'),
  scope_hash text NOT NULL CHECK(scope_hash ~ '^[a-f0-9]{64}$'),
  bucket_hash text NOT NULL CHECK(bucket_hash ~ '^[a-f0-9]{64}$'),
  coordinate_hash text NOT NULL CHECK(coordinate_hash ~ '^[a-f0-9]{64}$'),
  position jsonb NOT NULL CHECK (
    jsonb_typeof(position)='object' AND position ? 'v' AND
    jsonb_typeof(position->'v')='number' AND
    position->>'v' ~ '^[1-9][0-9]{0,8}$' AND octet_length(position::text)<=8192
  ),
  created_at timestamptz NOT NULL CHECK(isfinite(created_at)),
  expires_at timestamptz NOT NULL CHECK(isfinite(expires_at) AND expires_at=created_at+interval '24 hours'),
  UNIQUE(scope_hash,coordinate_hash)
);
CREATE INDEX discovery_cursor_bucket_oldest
  ON whaleu_community.discovery_cursors(bucket_hash,created_at DESC,cursor DESC);
CREATE INDEX discovery_cursor_expiry
  ON whaleu_community.discovery_cursors(expires_at,cursor);

CREATE FUNCTION whaleu_community.protect_discovery_cursor() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Discovery cursor coordinates and expiry are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER protect_discovery_cursor BEFORE UPDATE ON whaleu_community.discovery_cursors
  FOR EACH ROW EXECUTE FUNCTION whaleu_community.protect_discovery_cursor();

-- Filter the immutable author/list-kind prefix before a bounded keyset read.
CREATE INDEX posts_public_profile_keyset
  ON whaleu_community.posts(account_id,(category='trading'),published_at DESC,id DESC)
  WHERE author_mode='named' AND visibility='approved' AND deleted_at IS NULL;
