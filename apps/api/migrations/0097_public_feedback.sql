-- Explicit public feedback topic and exact v3 content. No production topic,
-- account, role, verification or provider authorization is provisioned here.
SET LOCAL lock_timeout='5s';
SELECT pg_advisory_xact_lock(hashtextextended('whaleu:named-block-policy:v1',0));
CREATE TABLE whaleu_community.feedback_topic (
 topic text PRIMARY KEY CHECK(topic='feedback'),
 space_id uuid NOT NULL UNIQUE REFERENCES whaleu_community.spaces(id),
 provenance text NOT NULL CHECK(provenance='accepted'),
 source_reference text NOT NULL CHECK(length(btrim(source_reference)) BETWEEN 1 AND 2000),
 created_at timestamptz NOT NULL DEFAULT transaction_timestamp() CHECK(isfinite(created_at))
);
CREATE TRIGGER feedback_topic_immutable BEFORE UPDATE OR DELETE ON whaleu_community.feedback_topic FOR EACH ROW EXECUTE FUNCTION whaleu_community.content_approval_immutable();
CREATE TRIGGER feedback_topic_no_truncate BEFORE TRUNCATE ON whaleu_community.feedback_topic FOR EACH STATEMENT EXECUTE FUNCTION whaleu_media.immutable_record();
CREATE TRIGGER feedback_topic_writer BEFORE INSERT ON whaleu_community.feedback_topic FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.content_policy_writer_gate();
CREATE FUNCTION whaleu_community.feedback_topic_validate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM whaleu_community.spaces WHERE id=NEW.space_id AND kind='global' AND operating_region_id IS NULL AND is_active) THEN
  RAISE EXCEPTION 'Feedback requires an explicitly bound active global space' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER feedback_topic_validate BEFORE INSERT ON whaleu_community.feedback_topic FOR EACH ROW EXECUTE FUNCTION whaleu_community.feedback_topic_validate();
ALTER TABLE whaleu_community.posts DROP CONSTRAINT posts_category_check;
ALTER TABLE whaleu_community.posts ADD CONSTRAINT posts_category_check CHECK(category IN ('discussion','feedback','confession','companions','pets','internships','scenery','dorms','research','deep_sea','trading'));
ALTER TABLE whaleu_community.posts ADD COLUMN feedback jsonb;
CREATE FUNCTION whaleu_community.feedback_definition_shape(value jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
 SELECT coalesce(jsonb_typeof(value)='object' AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(value) k)=ARRAY['contacts']
 AND jsonb_typeof(value->'contacts')='object' AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(value->'contacts') k)=ARRAY['phone','qq','wechat']
 AND NOT EXISTS(SELECT 1 FROM jsonb_each(value->'contacts') f WHERE jsonb_typeof(f.value)<>'string' OR octet_length(f.value#>>'{}')>50),false)
$$;
ALTER TABLE whaleu_community.posts DROP CONSTRAINT post_anonymous_dm_definition;
ALTER TABLE whaleu_community.posts ADD CONSTRAINT post_anonymous_dm_definition CHECK(
 (publication_envelope_version=1 AND allow_anonymous_dm IS NULL AND feedback IS NULL AND category<>'feedback') OR
 (publication_envelope_version=2 AND author_mode='named' AND allow_anonymous_dm IS NOT NULL AND feedback IS NULL AND category<>'feedback') OR
 (publication_envelope_version=3 AND allow_anonymous_dm IS NULL AND category='feedback' AND comments_policy='open' AND whaleu_community.feedback_definition_shape(feedback)));
ALTER TABLE whaleu_community.content_approval_decisions DROP CONSTRAINT content_approval_envelope_version, DROP CONSTRAINT content_approval_envelope_identity;
ALTER TABLE whaleu_community.content_approval_decisions ADD CONSTRAINT content_approval_envelope_version CHECK(envelope_version IN (1,2,3)),
 ADD CONSTRAINT content_approval_envelope_identity CHECK(coalesce(jsonb_typeof(envelope)='object' AND envelope->>'version'=envelope_version::text AND envelope->>'accountId'=account_id::text AND envelope->>'purpose'=operation
 AND jsonb_typeof(envelope->'scope')='object' AND envelope->'scope'->>'sync'='none'
 AND ((envelope_version=1 AND NOT envelope ? 'allowAnonymousDm' AND NOT envelope ? 'feedback')
 OR (envelope_version=2 AND operation='publish_post' AND envelope->>'authorMode'='named' AND jsonb_typeof(envelope->'allowAnonymousDm')='boolean' AND NOT envelope ? 'feedback' AND envelope->'postId'='null'::jsonb AND envelope->'rootCommentId'='null'::jsonb AND envelope->'targetReplyId'='null'::jsonb)
 OR (envelope_version=3 AND operation='publish_post' AND envelope->>'category'='feedback' AND envelope->>'authorMode' IN ('named','anonymous') AND NOT envelope ? 'allowAnonymousDm' AND whaleu_community.feedback_definition_shape(envelope->'feedback')
 AND envelope->'scope'->'originalRegionId'='null'::jsonb AND envelope->>'commentsPolicy'='open' AND envelope->'component'='{"kind":"none"}'::jsonb AND envelope->'trading'='null'::jsonb AND envelope->'postId'='null'::jsonb AND envelope->'rootCommentId'='null'::jsonb AND envelope->'targetReplyId'='null'::jsonb)),false));
-- The existing version-derived SHA256 check and every provenance/expiry/binding
-- guard remain unchanged, as do old v1/v2 bytes and receipts.
ALTER TABLE whaleu_community.content_approval_bindings DROP CONSTRAINT content_binding_envelope_version;
ALTER TABLE whaleu_community.content_approval_bindings ADD CONSTRAINT content_binding_envelope_version CHECK(envelope_version IN (1,2,3) AND envelope->>'version'=envelope_version::text AND (envelope_version=1 OR (content_kind='post' AND operation='publish_post')));
CREATE FUNCTION whaleu_community.feedback_publication_validate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.category='feedback' AND NOT EXISTS(SELECT 1 FROM whaleu_community.feedback_topic t JOIN whaleu_community.spaces s ON s.id=t.space_id WHERE t.space_id=NEW.space_id AND s.kind='global' AND s.operating_region_id IS NULL AND s.is_active) THEN
  RAISE EXCEPTION 'Unbound feedback space' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER feedback_publication_validate BEFORE INSERT ON whaleu_community.posts FOR EACH ROW EXECUTE FUNCTION whaleu_community.feedback_publication_validate();
CREATE FUNCTION whaleu_community.feedback_binding_validate() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p whaleu_community.posts;
BEGIN
 IF NEW.envelope_version=3 THEN
  SELECT * INTO p FROM whaleu_community.posts WHERE id=NEW.content_id FOR SHARE;
  IF NOT FOUND OR NEW.content_kind<>'post' OR p.category<>'feedback' OR p.feedback IS DISTINCT FROM NEW.envelope->'feedback' OR p.allow_anonymous_dm IS NOT NULL OR NEW.envelope ? 'allowAnonymousDm' THEN
   RAISE EXCEPTION 'Feedback reviewed definition mismatch' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER feedback_binding_validate BEFORE INSERT ON whaleu_community.content_approval_bindings FOR EACH ROW EXECUTE FUNCTION whaleu_community.feedback_binding_validate();
CREATE FUNCTION whaleu_community.feedback_publication_bound() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.category='feedback' AND NOT EXISTS(SELECT 1 FROM whaleu_community.content_approval_bindings b WHERE b.content_kind='post' AND b.content_id=NEW.id AND b.envelope_version=3 AND b.account_id=NEW.account_id AND b.envelope->'feedback'=NEW.feedback) THEN
  RAISE EXCEPTION 'Feedback has no exact reviewed publication' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER feedback_publication_bound AFTER INSERT ON whaleu_community.posts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community.feedback_publication_bound();
-- Replace exactly the two prior queue admission checks, not request ownership,
-- immutable snapshot, digest, source transaction, budgets or expiry constraints.
DO $$ DECLARE c record; n integer:=0; BEGIN
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='whaleu_community.text_review_requests'::regclass AND contype='c' AND (pg_get_constraintdef(oid) LIKE '%accountId%' OR pg_get_constraintdef(oid) LIKE '%authorMode%') LOOP
  EXECUTE format('ALTER TABLE whaleu_community.text_review_requests DROP CONSTRAINT %I',c.conname); n:=n+1;
 END LOOP;
 IF n<>2 THEN RAISE EXCEPTION 'Unexpected review admission constraints'; END IF;
END $$;
ALTER TABLE whaleu_community.text_review_requests ADD CONSTRAINT text_review_identity CHECK(coalesce(jsonb_typeof(envelope)='object' AND envelope->>'accountId'=account_id::text AND envelope->>'purpose'=operation AND envelope->>'version' IN ('1','2','3'),false)),
 ADD CONSTRAINT text_review_scope_definition CHECK(coalesce(envelope->'component'='{"kind":"none"}'::jsonb AND envelope->'trading'='null'::jsonb AND envelope->>'commentsPolicy'='open' AND (
 (envelope->>'category'<>'feedback' AND envelope->>'authorMode'='named' AND envelope->'images'='[]'::jsonb AND (envelope->>'version'='1' OR (envelope->>'version'='2' AND envelope->>'allowAnonymousDm'='false')))
 OR (envelope->>'category'='feedback' AND envelope->>'authorMode' IN ('named','anonymous') AND envelope->'scope'->'originalRegionId'='null'::jsonb AND jsonb_typeof(envelope->'images')='array' AND jsonb_array_length(envelope->'images')<=CASE WHEN operation='publish_post' THEN 9 ELSE 3 END AND ((operation='publish_post' AND envelope->>'version'='3' AND whaleu_community.feedback_definition_shape(envelope->'feedback')) OR (operation<>'publish_post' AND envelope->>'version'='1')))
 ),false));
CREATE FUNCTION whaleu_community.feedback_review_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.envelope->>'category'='feedback' AND NOT EXISTS(SELECT 1 FROM whaleu_community.feedback_topic t JOIN whaleu_community.spaces s ON s.id=t.space_id WHERE t.space_id::text=NEW.envelope->>'spaceId' AND s.kind='global' AND s.is_active AND s.operating_region_id IS NULL) THEN
  RAISE EXCEPTION 'Feedback review requires exact topic scope' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER feedback_review_scope BEFORE INSERT ON whaleu_community.text_review_requests FOR EACH ROW EXECUTE FUNCTION whaleu_community.feedback_review_scope();
REVOKE ALL ON whaleu_community.feedback_topic FROM PUBLIC;

-- Local feedback notification state; no provider delivery claim or identity snapshot.
CREATE TABLE whaleu_notifications.feedback_notice_owners (
 account_id uuid PRIMARY KEY REFERENCES whaleu_identity.accounts(id)
);
CREATE TABLE whaleu_notifications.feedback_notice_rate_buckets (
 account_id uuid PRIMARY KEY REFERENCES whaleu_identity.accounts(id),
 window_start timestamptz NOT NULL CHECK(isfinite(window_start)),
 hits integer NOT NULL CHECK(hits BETWEEN 1 AND 1000000)
);
CREATE TABLE whaleu_notifications.feedback_notices (
 id uuid PRIMARY KEY,
 post_id uuid NOT NULL REFERENCES whaleu_community.posts(id),
 recipient_account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
 recipient_grant_id uuid NOT NULL REFERENCES whaleu_authorization.role_grants(id),
 kind text NOT NULL CHECK(kind='feedback_created'),
 created_at timestamptz NOT NULL CHECK(isfinite(created_at) AND created_at=date_trunc('milliseconds',created_at)),
 read_at timestamptz CHECK(read_at IS NULL OR (isfinite(read_at) AND read_at=date_trunc('milliseconds',read_at))),
 UNIQUE(post_id,recipient_account_id)
);
CREATE INDEX feedback_notices_owner_page ON whaleu_notifications.feedback_notices(recipient_account_id,created_at DESC,id DESC);
CREATE INDEX feedback_notices_unread ON whaleu_notifications.feedback_notices(recipient_account_id) WHERE read_at IS NULL;
CREATE FUNCTION whaleu_notifications.feedback_notice_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.read_at IS NOT NULL OR NOT EXISTS (
   SELECT 1 FROM whaleu_community.posts p JOIN whaleu_community.spaces s ON s.id=p.space_id
   WHERE p.id=NEW.post_id AND p.category='feedback' AND s.kind='global'
    AND p.visibility='approved' AND p.deleted_at IS NULL AND p.published_at=NEW.created_at AND p.publication_transaction=pg_current_xact_id() AND EXISTS(SELECT 1 FROM whaleu_community.feedback_topic t WHERE t.space_id=p.space_id) AND EXISTS(SELECT 1 FROM whaleu_community.content_approval_bindings b WHERE b.content_kind='post' AND b.content_id=p.id AND b.envelope_version=3 AND b.envelope->'feedback'=p.feedback)
  ) OR NOT EXISTS (
   SELECT 1 FROM whaleu_authorization.role_grants g JOIN whaleu_identity.accounts a ON a.id=g.account_id
   WHERE g.id=NEW.recipient_grant_id AND g.account_id=NEW.recipient_account_id
    AND g.role='super_admin' AND g.operating_region_id IS NULL
    AND g.revoked_at IS NULL AND g.valid_from<=clock_timestamp()
    AND (g.expires_at IS NULL OR g.expires_at>clock_timestamp()) AND a.status='active'
  ) THEN RAISE EXCEPTION 'Feedback notice requires approved feedback and current super administrator' USING ERRCODE='23514'; END IF;
 ELSIF TG_OP='DELETE' OR (to_jsonb(OLD)-'read_at') IS DISTINCT FROM (to_jsonb(NEW)-'read_at') OR
  (OLD.read_at IS NOT NULL AND NEW.read_at IS DISTINCT FROM OLD.read_at) OR NEW.read_at IS NULL THEN
  RAISE EXCEPTION 'Feedback notice identity and settled read state are immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER feedback_notice_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_notifications.feedback_notices
 FOR EACH ROW EXECUTE FUNCTION whaleu_notifications.feedback_notice_guard();

REVOKE ALL ON whaleu_notifications.feedback_notices, whaleu_notifications.feedback_notice_owners, whaleu_notifications.feedback_notice_rate_buckets FROM PUBLIC;
CREATE TRIGGER feedback_notices_no_truncate BEFORE TRUNCATE ON whaleu_notifications.feedback_notices FOR EACH STATEMENT EXECUTE FUNCTION whaleu_media.immutable_record();
