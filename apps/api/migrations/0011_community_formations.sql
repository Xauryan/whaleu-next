-- Empty development storage; no grants, provider activation or production import.
-- Historical irregular rows must be reconciled from a private raw staging record.
-- Never reinterpret unknown status, guess consent, truncate contacts or discard facts.
ALTER TABLE whaleu_community.posts ADD COLUMN publication_transaction xid8 NOT NULL DEFAULT pg_current_xact_id();
CREATE TABLE whaleu_community.formations (
  id uuid PRIMARY KEY,
  post_id uuid NOT NULL UNIQUE REFERENCES whaleu_community.posts(id),
  capacity smallint NOT NULL CHECK (capacity BETWEEN 1 AND 20),
  theme text NOT NULL,
  reconciliation text NOT NULL DEFAULT 'current' CHECK (reconciliation IN ('current','unreconciled')),
  legacy_raw jsonb CHECK (legacy_raw IS NULL OR jsonb_typeof(legacy_raw)='object'),
  creation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id()
);
CREATE TABLE whaleu_community.formation_members (
  id uuid PRIMARY KEY,
  formation_id uuid NOT NULL REFERENCES whaleu_community.formations(id),
  account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
  seat smallint NOT NULL CHECK (seat BETWEEN 1 AND 20),
  is_creator boolean NOT NULL,
  wechat text NOT NULL, qq text NOT NULL, phone text NOT NULL,
  contact_sharing text NOT NULL CHECK (contact_sharing IN ('members_v1','legacy_unconfirmed')),
  joined_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()) CHECK (isfinite(joined_at)),
  legacy_raw jsonb CHECK (legacy_raw IS NULL OR jsonb_typeof(legacy_raw)='object'),
  UNIQUE(formation_id,account_id), UNIQUE(formation_id,seat),
  CHECK (is_creator=(seat=1))
);
CREATE UNIQUE INDEX formation_one_creator ON whaleu_community.formation_members(formation_id) WHERE is_creator;
CREATE INDEX formation_members_account ON whaleu_community.formation_members(account_id,formation_id);
CREATE FUNCTION whaleu_community.formation_member_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent uuid; owner_id uuid; capacity_value integer; count_value integer; creation xid8; state text;
BEGIN
  SELECT post_id INTO parent FROM whaleu_community.formations WHERE id=NEW.formation_id;
  -- Same parent -> formation order as application joins/deletion, including direct SQL.
  SELECT account_id INTO owner_id FROM whaleu_community.posts WHERE id=parent FOR UPDATE;
  SELECT capacity,creation_transaction,reconciliation INTO capacity_value,creation,state
    FROM whaleu_community.formations WHERE id=NEW.formation_id FOR UPDATE;
  SELECT count(*) INTO count_value FROM whaleu_community.formation_members WHERE formation_id=NEW.formation_id;
  IF capacity_value IS NULL OR count_value>=capacity_value OR
     (NEW.is_creator AND (count_value<>0 OR NEW.account_id<>owner_id OR creation<>pg_current_xact_id())) OR
     (NOT NEW.is_creator AND (count_value=0 OR NEW.account_id=owner_id OR state<>'current')) THEN
    RAISE EXCEPTION 'Formation membership is invalid' USING ERRCODE='23514';
  END IF;
  NEW.seat := count_value+1;
  RETURN NEW;
END $$;
CREATE TRIGGER formation_member_insert BEFORE INSERT ON whaleu_community.formation_members
  FOR EACH ROW EXECUTE FUNCTION whaleu_community.formation_member_insert();
CREATE TRIGGER formation_member_immutable BEFORE UPDATE OR DELETE ON whaleu_community.formation_members
  FOR EACH ROW EXECUTE FUNCTION whaleu_community.poll_immutable();
CREATE TRIGGER formation_immutable BEFORE UPDATE OR DELETE ON whaleu_community.formations
  FOR EACH ROW EXECUTE FUNCTION whaleu_community.poll_immutable();
CREATE FUNCTION whaleu_community.formation_shape() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid; definition whaleu_community.formations; parent whaleu_community.posts;
BEGIN
  IF TG_TABLE_NAME='posts' THEN target:=NEW.id; ELSE target:=NEW.post_id; END IF;
  SELECT * INTO definition FROM whaleu_community.formations WHERE post_id=target;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO parent FROM whaleu_community.posts WHERE id=target;
  IF parent.category='trading' OR EXISTS(SELECT 1 FROM whaleu_community.polls WHERE post_id=target) OR
    definition.creation_transaction IS DISTINCT FROM parent.publication_transaction OR
    NOT EXISTS(SELECT 1 FROM whaleu_community.formation_members WHERE formation_id=definition.id AND is_creator AND account_id=parent.account_id) THEN
    RAISE EXCEPTION 'Formation parent shape is invalid' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER formation_shape AFTER INSERT ON whaleu_community.formations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community.formation_shape();
CREATE CONSTRAINT TRIGGER formation_parent_shape AFTER INSERT OR UPDATE ON whaleu_community.posts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community.formation_shape();
CREATE CONSTRAINT TRIGGER formation_poll_shape AFTER INSERT ON whaleu_community.polls
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community.formation_shape();
CREATE FUNCTION whaleu_community.formation_parent_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM whaleu_community.formations WHERE post_id=OLD.id) AND
    (to_jsonb(OLD)-'visibility'-'deleted_at') IS DISTINCT FROM (to_jsonb(NEW)-'visibility'-'deleted_at') THEN
    RAISE EXCEPTION 'Formation publication is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER formation_parent_immutable BEFORE UPDATE ON whaleu_community.posts
  FOR EACH ROW EXECUTE FUNCTION whaleu_community.formation_parent_immutable();
CREATE TABLE whaleu_community.formation_requests (
  account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
  client_request_id uuid NOT NULL,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  receipt jsonb,
  PRIMARY KEY(account_id,client_request_id),
  CHECK (receipt IS NULL OR coalesce(jsonb_typeof(receipt)='object' AND
    receipt->>'operation'='join_formation' AND receipt->>'requestId'=client_request_id::text AND
    ((receipt->>'outcome'='created' AND jsonb_typeof(receipt->'resourceId')='string' AND
      receipt->>'resourceId' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' AND
      jsonb_typeof(receipt->'createdAt')='string' AND
      receipt->>'createdAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' AND
      receipt - ARRAY['requestId','operation','outcome','resourceId','createdAt']='{}'::jsonb) OR
     (receipt->>'outcome'='rejected' AND jsonb_typeof(receipt->'code')='string' AND
      receipt->>'code' IN ('POST_NOT_FOUND','FORMATION_NOT_FOUND','FORMATION_FULL','FORMATION_ALREADY_JOINED',
        'FORMATION_UNAVAILABLE','PHONE_VERIFICATION_REQUIRED','COMMUNITY_ACTION_RESTRICTED','COMMUNITY_SCOPE_UNAVAILABLE') AND
      receipt - ARRAY['requestId','operation','outcome','code']='{}'::jsonb)),false))
);
CREATE TRIGGER formation_request_immutable BEFORE UPDATE OR DELETE ON whaleu_community.formation_requests
  FOR EACH ROW EXECUTE FUNCTION whaleu_community.poll_request_immutable();
CREATE FUNCTION whaleu_community.formation_request_complete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM whaleu_community.formation_requests WHERE account_id=NEW.account_id
    AND client_request_id=NEW.client_request_id AND receipt IS NULL) THEN
    RAISE EXCEPTION 'Formation request is incomplete' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER formation_request_complete AFTER INSERT ON whaleu_community.formation_requests
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community.formation_request_complete();

-- Privileged identity resolution stays in the separate audited boundary.
ALTER TABLE whaleu_authorization.identity_view_audit DROP CONSTRAINT identity_view_audit_target_kind_check;
ALTER TABLE whaleu_authorization.identity_view_audit ADD CONSTRAINT identity_view_audit_target_kind_check
  CHECK(target_kind IN ('post','comment','reply','formation_member'));

-- Formation publication approval binds ordered media too, not only the post row.
CREATE FUNCTION whaleu_community.formation_image_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid; creation xid8;
BEGIN
  IF TG_OP='UPDATE' AND OLD.post_id IS DISTINCT FROM NEW.post_id AND
    EXISTS(SELECT 1 FROM whaleu_community.formations WHERE post_id=OLD.post_id) THEN
    RAISE EXCEPTION 'Formation media is immutable' USING ERRCODE='23514';
  END IF;
  IF TG_OP='DELETE' THEN target:=OLD.post_id; ELSE target:=NEW.post_id; END IF;
  SELECT publication_transaction INTO creation FROM whaleu_community.posts WHERE id=target FOR SHARE;
  IF EXISTS(SELECT 1 FROM whaleu_community.formations WHERE post_id=target) AND
    (TG_OP<>'INSERT' OR creation IS DISTINCT FROM pg_current_xact_id()) THEN
    RAISE EXCEPTION 'Formation media is immutable' USING ERRCODE='23514';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER formation_image_immutable BEFORE INSERT OR UPDATE OR DELETE ON whaleu_community.post_images
  FOR EACH ROW EXECUTE FUNCTION whaleu_community.formation_image_immutable();
