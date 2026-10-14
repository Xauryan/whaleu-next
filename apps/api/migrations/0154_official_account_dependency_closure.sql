-- Fixed shared dependency frontier. Mutations enqueue one exact dependency, not
-- a synchronous walk of every enrolled school or all historical publications.
CREATE TABLE whaleu_official.dependency_root(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),head bigint NOT NULL DEFAULT 0 CHECK(head>=0));
INSERT INTO whaleu_official.dependency_root(singleton) VALUES(true);
CREATE TABLE whaleu_official.dependency_events(
 sequence bigint PRIMARY KEY CHECK(sequence>0),kind text NOT NULL CHECK(kind IN('account','asset','decision','policy','space','post','region','institution','campus','media_intent','category_policy','category_review','category_issuer')),
 target_id uuid NOT NULL,owner_table text NOT NULL,source_xid xid8 NOT NULL DEFAULT pg_current_xact_id()
);
ALTER TABLE whaleu_official.source_roots ADD COLUMN dependency_cursor bigint NOT NULL DEFAULT 0 CHECK(dependency_cursor>=0);
ALTER TABLE whaleu_official.source_roots ADD COLUMN dependency_post_cursor uuid;
CREATE INDEX official_account_sources ON whaleu_community.posts(account_id,space_id,id);
CREATE INDEX official_review_sources ON whaleu_community.content_approval_bindings(decision_id,content_kind,content_id);
CREATE INDEX official_policy_sources ON whaleu_community.content_approval_decisions(policy_revision_id,id);
CREATE INDEX official_asset_sources ON whaleu_media.bindings(asset_id,owner_kind,resource_kind,resource_id);
CREATE FUNCTION whaleu_official.dependency_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n bigint;t uuid; row_value jsonb;
BEGIN
 FOR t IN SELECT DISTINCT value::uuid FROM (VALUES(to_jsonb(NEW)->>TG_ARGV[1]),(to_jsonb(OLD)->>TG_ARGV[1])) ids(value) WHERE value IS NOT NULL LOOP
  UPDATE whaleu_official.dependency_root SET head=head+1 WHERE singleton RETURNING head INTO n;
  INSERT INTO whaleu_official.dependency_events(sequence,kind,target_id,owner_table) VALUES(n,TG_ARGV[0],t,TG_TABLE_SCHEMA||'.'||TG_TABLE_NAME);
 END LOOP;
 RETURN NULL;
END $$;
CREATE TRIGGER official_identity_dependency AFTER UPDATE OR DELETE ON whaleu_identity.accounts FOR EACH ROW EXECUTE FUNCTION whaleu_official.dependency_changed('account','id');
CREATE TRIGGER official_safety_dependency AFTER INSERT OR UPDATE OR DELETE ON whaleu_safety.account_heads FOR EACH ROW EXECUTE FUNCTION whaleu_official.dependency_changed('account','account_id');
CREATE TRIGGER official_review_dependency AFTER INSERT OR UPDATE OR DELETE ON whaleu_community.content_approval_heads FOR EACH ROW EXECUTE FUNCTION whaleu_official.dependency_changed('decision','decision_id');
CREATE TRIGGER official_review_policy_dependency AFTER INSERT OR UPDATE OR DELETE ON whaleu_community.content_approval_policies FOR EACH ROW EXECUTE FUNCTION whaleu_official.dependency_changed('policy','id');
CREATE TRIGGER official_media_dependency AFTER INSERT OR UPDATE OR DELETE ON whaleu_media.asset_safety_heads FOR EACH ROW EXECUTE FUNCTION whaleu_official.dependency_changed('asset','asset_id');
CREATE TRIGGER official_media_binding_dependency AFTER INSERT OR UPDATE OR DELETE ON whaleu_media.bindings FOR EACH ROW EXECUTE FUNCTION whaleu_official.dependency_changed('asset','asset_id');
CREATE TRIGGER official_space_dependency AFTER INSERT OR UPDATE OR DELETE ON whaleu_community.spaces FOR EACH ROW EXECUTE FUNCTION whaleu_official.dependency_changed('space','id');
CREATE TRIGGER official_dependency_immutable BEFORE UPDATE OR DELETE ON whaleu_official.dependency_events FOR EACH ROW EXECUTE FUNCTION whaleu_media.immutable_record();
CREATE TRIGGER official_dependency_retain BEFORE TRUNCATE ON whaleu_official.dependency_events FOR EACH STATEMENT EXECUTE FUNCTION whaleu_media.immutable_record();

CREATE TRIGGER official_campus_dependency AFTER INSERT OR UPDATE OR DELETE ON whaleu_campus.campuses FOR EACH ROW EXECUTE FUNCTION whaleu_official.dependency_changed('institution','institution_id');
CREATE TRIGGER official_assignment_dependency AFTER INSERT OR UPDATE OR DELETE ON whaleu_campus.campus_region_assignments FOR EACH ROW EXECUTE FUNCTION whaleu_official.dependency_changed('region','operating_region_id');
CREATE TRIGGER official_region_dependency AFTER INSERT OR UPDATE OR DELETE ON whaleu_campus.operating_regions FOR EACH ROW EXECUTE FUNCTION whaleu_official.dependency_changed('region','id');
CREATE TRIGGER official_media_asset_dependency AFTER UPDATE OR DELETE ON whaleu_media.assets FOR EACH ROW EXECUTE FUNCTION whaleu_official.dependency_changed('asset','id');
CREATE TRIGGER official_media_variant_dependency AFTER INSERT OR UPDATE OR DELETE ON whaleu_media.variants FOR EACH ROW EXECUTE FUNCTION whaleu_official.dependency_changed('asset','asset_id');

-- Direct identities survive withdrawal/detachment; never discover removed edges
-- by looking only at their later active projection.
CREATE FUNCTION whaleu_official.bound_post_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r jsonb;p uuid;
BEGIN
 FOR r IN SELECT DISTINCT value FROM (VALUES(to_jsonb(NEW)),(to_jsonb(OLD))) identities(value) WHERE value IS NOT NULL LOOP
  IF TG_TABLE_SCHEMA='whaleu_media' AND r->>'owner_kind'='community' AND r->>'resource_kind'='post' THEN p:=(r->>'resource_id')::uuid;
  ELSIF TG_TABLE_SCHEMA='whaleu_community' AND r->>'content_kind'='post' THEN p:=(r->>'content_id')::uuid;
  ELSE CONTINUE; END IF;
  PERFORM whaleu_official.mark_post(p,TG_TABLE_SCHEMA||'.'||TG_TABLE_NAME);
 END LOOP;
 RETURN NULL;
END $$;
CREATE TRIGGER official_binding_post_dependency AFTER INSERT OR UPDATE OR DELETE ON whaleu_media.bindings FOR EACH ROW EXECUTE FUNCTION whaleu_official.bound_post_changed();
CREATE TRIGGER official_review_binding_dependency AFTER INSERT OR UPDATE OR DELETE ON whaleu_community.content_approval_bindings FOR EACH ROW EXECUTE FUNCTION whaleu_official.bound_post_changed();
CREATE TRIGGER official_category_head_dependency AFTER INSERT OR UPDATE OR DELETE ON whaleu_community.post_category_heads FOR EACH ROW EXECUTE FUNCTION whaleu_official.source_changed();
CREATE TRIGGER official_category_policy_head_dependency AFTER INSERT OR UPDATE OR DELETE ON whaleu_community.post_category_policy_heads FOR EACH ROW EXECUTE FUNCTION whaleu_official.dependency_changed('category_policy','policy_id');
CREATE TRIGGER official_category_policy_withdrawal_dependency AFTER INSERT OR UPDATE OR DELETE ON whaleu_community.post_category_policy_withdrawals FOR EACH ROW EXECUTE FUNCTION whaleu_official.dependency_changed('category_policy','policy_id');
CREATE TRIGGER official_category_review_withdrawal_dependency AFTER INSERT OR UPDATE OR DELETE ON whaleu_community.post_category_review_withdrawals FOR EACH ROW EXECUTE FUNCTION whaleu_official.dependency_changed('category_review','review_id');
CREATE TRIGGER official_category_issuer_withdrawal_dependency AFTER INSERT OR UPDATE OR DELETE ON whaleu_community.post_category_issuer_withdrawals FOR EACH ROW EXECUTE FUNCTION whaleu_official.dependency_changed('category_issuer','issuer_id');
CREATE TRIGGER official_media_intent_dependency AFTER UPDATE OR DELETE ON whaleu_media.upload_intents FOR EACH ROW EXECUTE FUNCTION whaleu_official.dependency_changed('media_intent','id');
CREATE INDEX official_category_policy_sources ON whaleu_community.post_category_events(policy_id,post_id);
CREATE INDEX official_category_issuer_reviews ON whaleu_community.post_category_reviews(issuer_id,id);
-- Unified subscription certificates also bind the exact obligation/epoch owner.
CREATE TRIGGER official_saved_epoch_dependency AFTER INSERT OR UPDATE OR DELETE ON whaleu_community.saved_epochs FOR EACH ROW EXECUTE FUNCTION whaleu_official.source_changed();
CREATE FUNCTION whaleu_official.saved_obligation_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p uuid;e uuid;
BEGIN
 FOR e IN SELECT DISTINCT value::uuid FROM (VALUES(to_jsonb(NEW)->>'epoch_id'),(to_jsonb(OLD)->>'epoch_id')) identities(value) WHERE value IS NOT NULL LOOP
  SELECT post_id INTO p FROM whaleu_community.saved_epochs WHERE id=e;
  IF p IS NOT NULL THEN PERFORM whaleu_official.mark_post(p,TG_TABLE_SCHEMA||'.'||TG_TABLE_NAME);END IF;
 END LOOP;
 RETURN NULL;
END $$;
CREATE TRIGGER official_saved_obligation_dependency AFTER INSERT OR UPDATE OR DELETE ON whaleu_community.saved_obligations FOR EACH ROW EXECUTE FUNCTION whaleu_official.saved_obligation_changed();
