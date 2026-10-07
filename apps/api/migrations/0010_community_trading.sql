-- Empty development storage only. No production import, manager grants, or delivery.
ALTER TABLE whaleu_community.posts DROP CONSTRAINT posts_category_check;
ALTER TABLE whaleu_community.posts ADD CONSTRAINT posts_category_check CHECK
  (category IN ('discussion','confession','companions','pets','internships','scenery','dorms','research','deep_sea','trading'));
CREATE TABLE whaleu_community.trading_listings (
  post_id uuid PRIMARY KEY REFERENCES whaleu_community.posts(id),
  subtype text NOT NULL,
  price numeric CHECK (price > 0 AND price <= 99999),
  -- Retain uninterpretable historical source text independently, never parse junk.
  legacy_raw_price text, legacy_raw_subtype text,
  urgency text NOT NULL CHECK (urgency IN ('normal','urgent')),
  resolution text NOT NULL DEFAULT 'open' CHECK (resolution IN ('open','resolved')),
  location text NOT NULL,
  wechat text NOT NULL, qq text NOT NULL, phone text NOT NULL,
  CHECK (subtype <> 'qiugou' OR urgency='normal'),
  CHECK (price IS NOT NULL OR legacy_raw_price IS NOT NULL)
);
CREATE INDEX trading_subtype ON whaleu_community.trading_listings(subtype,post_id);
-- Consistent shape at commit, including direct SQL and later parent changes.
CREATE FUNCTION whaleu_community.trading_shape() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid; category_value text; author_value text; scope_value text; has_listing boolean;
BEGIN
  IF TG_TABLE_NAME='posts' THEN target := NEW.id; ELSE target := NEW.post_id; END IF;
  SELECT p.category,p.author_mode,s.kind INTO category_value,author_value,scope_value
    FROM whaleu_community.posts p JOIN whaleu_community.spaces s ON s.id=p.space_id WHERE p.id=target;
  SELECT EXISTS(SELECT 1 FROM whaleu_community.trading_listings WHERE post_id=target) INTO has_listing;
  IF (category_value='trading') IS DISTINCT FROM has_listing OR
    (category_value='trading' AND (author_value<>'named' OR scope_value<>'regional' OR
      EXISTS(SELECT 1 FROM whaleu_community.polls WHERE post_id=target))) THEN
    RAISE EXCEPTION 'Trading parent shape is invalid' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER trading_post_shape AFTER INSERT OR UPDATE ON whaleu_community.posts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community.trading_shape();
CREATE CONSTRAINT TRIGGER trading_listing_shape AFTER INSERT OR UPDATE ON whaleu_community.trading_listings
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community.trading_shape();
CREATE CONSTRAINT TRIGGER trading_poll_shape AFTER INSERT ON whaleu_community.polls
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community.trading_shape();
CREATE FUNCTION whaleu_community.trading_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR (to_jsonb(OLD)-'resolution') IS DISTINCT FROM (to_jsonb(NEW)-'resolution') THEN
    RAISE EXCEPTION 'Trading definition is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trading_immutable BEFORE UPDATE OR DELETE ON whaleu_community.trading_listings
  FOR EACH ROW EXECUTE FUNCTION whaleu_community.trading_immutable();
-- Separate account-scoped namespace; terminal receipts survive parent deletion.
CREATE TABLE whaleu_community.trading_requests (
  account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
  client_request_id uuid NOT NULL,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  receipt jsonb, PRIMARY KEY(account_id,client_request_id),
  CHECK (receipt IS NULL OR coalesce(jsonb_typeof(receipt)='object' AND
    receipt->>'operation'='set_trading_resolution' AND
    receipt->>'requestId'=client_request_id::text AND
    receipt->>'outcome' IN ('applied','rejected'),false))
);
CREATE TRIGGER trading_request_immutable BEFORE UPDATE OR DELETE ON whaleu_community.trading_requests
  FOR EACH ROW EXECUTE FUNCTION whaleu_community.poll_request_immutable();
CREATE FUNCTION whaleu_community.trading_request_complete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM whaleu_community.trading_requests WHERE account_id=NEW.account_id
    AND client_request_id=NEW.client_request_id AND receipt IS NULL) THEN
    RAISE EXCEPTION 'Trading request is incomplete' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER trading_request_complete AFTER INSERT ON whaleu_community.trading_requests
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community.trading_request_complete();
-- Approved trading ownership, scope and body are immutable; safety removal remains
-- independently mutable. A generic future post updater cannot change the receipt's
-- author/listing identity or approved publication intent.
CREATE FUNCTION whaleu_community.trading_parent_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.category='trading' AND
    (to_jsonb(OLD)-'visibility'-'deleted_at') IS DISTINCT FROM
    (to_jsonb(NEW)-'visibility'-'deleted_at') THEN
    RAISE EXCEPTION 'Trading publication is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trading_parent_immutable BEFORE UPDATE ON whaleu_community.posts
  FOR EACH ROW EXECUTE FUNCTION whaleu_community.trading_parent_immutable();
