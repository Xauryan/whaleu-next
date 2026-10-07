-- Read-only community scope authority. Additive and empty: no startup/bootstrap
-- facts, runtime writers, administrator grants, providers, or legacy backfills.
-- JSON keeps every topology edge inside one append-only immutable snapshot.
CREATE TABLE whaleu_campus.community_topology_snapshots (
  id uuid PRIMARY KEY,
  revision integer NOT NULL UNIQUE CHECK (revision > 0),
  coverage_state text NOT NULL CHECK (coverage_state IN ('complete','missing','conflicting')),
  provenance_state text NOT NULL CHECK (provenance_state IN ('accepted','unknown','conflicting')),
  source_reference text CHECK (char_length(btrim(source_reference)) BETWEEN 1 AND 200),
  policy_reference text CHECK (char_length(btrim(policy_reference)) BETWEEN 1 AND 200),
  topology jsonb NOT NULL CHECK (jsonb_typeof(topology)='object'),
  effective_at timestamptz NOT NULL CHECK (isfinite(effective_at)),
  expiry_kind text NOT NULL CHECK (expiry_kind IN ('unknown','at','policy_exempt')),
  valid_until timestamptz CHECK (valid_until IS NULL OR isfinite(valid_until)),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(id,revision),
  CHECK ((expiry_kind='at' AND valid_until IS NOT NULL AND valid_until > effective_at)
    OR (expiry_kind<>'at' AND valid_until IS NULL))
);
CREATE TABLE whaleu_campus.community_topology_heads (
  scope_key text PRIMARY KEY CHECK (scope_key='community'),
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  snapshot_id uuid,
  CHECK ((revision=0 AND snapshot_id IS NULL) OR (revision>0 AND snapshot_id IS NOT NULL)),
  FOREIGN KEY(snapshot_id,revision) REFERENCES whaleu_campus.community_topology_snapshots(id,revision)
);

CREATE TABLE whaleu_campus.community_identity_selections (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
  revision integer NOT NULL CHECK (revision > 0),
  selection_state text NOT NULL CHECK (selection_state IN ('selected','selection_required')),
  campus_id uuid REFERENCES whaleu_campus.campuses(id),
  affiliation_assertion_id uuid NOT NULL,
  affiliation_snapshot_id uuid NOT NULL REFERENCES whaleu_verification.snapshots(id),
  topology_snapshot_id uuid NOT NULL REFERENCES whaleu_campus.community_topology_snapshots(id),
  coverage_state text NOT NULL CHECK (coverage_state IN ('complete','missing','conflicting')),
  provenance_state text NOT NULL CHECK (provenance_state IN ('accepted','unknown','conflicting')),
  source_reference text CHECK (char_length(btrim(source_reference)) BETWEEN 1 AND 200),
  policy_reference text CHECK (char_length(btrim(policy_reference)) BETWEEN 1 AND 200),
  effective_at timestamptz NOT NULL CHECK (isfinite(effective_at)),
  expiry_kind text NOT NULL CHECK (expiry_kind IN ('unknown','at','policy_exempt')),
  valid_until timestamptz CHECK (valid_until IS NULL OR isfinite(valid_until)),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(account_id,revision),
  UNIQUE(id,account_id,revision),
  FOREIGN KEY(affiliation_assertion_id,account_id) REFERENCES whaleu_verification.assertions(id,account_id),
  CHECK ((selection_state='selected' AND campus_id IS NOT NULL)
    OR (selection_state='selection_required' AND campus_id IS NULL)),
  CHECK ((expiry_kind='at' AND valid_until IS NOT NULL AND valid_until > effective_at)
    OR (expiry_kind<>'at' AND valid_until IS NULL))
);
CREATE TABLE whaleu_campus.community_identity_heads (
  account_id uuid PRIMARY KEY REFERENCES whaleu_identity.accounts(id),
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  selection_id uuid,
  CHECK ((revision=0 AND selection_id IS NULL) OR (revision>0 AND selection_id IS NOT NULL)),
  FOREIGN KEY(selection_id,account_id,revision) REFERENCES whaleu_campus.community_identity_selections(id,account_id,revision)
);

-- The switches and category set are community-owned, never profile flags.
CREATE TABLE whaleu_community.region_policy_revisions (
  id uuid PRIMARY KEY,
  region_id uuid NOT NULL REFERENCES whaleu_campus.operating_regions(id),
  revision integer NOT NULL CHECK (revision > 0),
  coverage_state text NOT NULL CHECK (coverage_state IN ('complete','missing','conflicting')),
  provenance_state text NOT NULL CHECK (provenance_state IN ('accepted','unknown','conflicting')),
  source_reference text CHECK (char_length(btrim(source_reference)) BETWEEN 1 AND 200),
  policy_reference text CHECK (char_length(btrim(policy_reference)) BETWEEN 1 AND 200),
  unverified_post_enabled boolean NOT NULL,
  unverified_comment_enabled boolean NOT NULL,
  unverified_categories text[] NOT NULL,
  related_sync_enabled boolean NOT NULL,
  effective_at timestamptz NOT NULL CHECK (isfinite(effective_at)),
  expiry_kind text NOT NULL CHECK (expiry_kind IN ('unknown','at','policy_exempt')),
  valid_until timestamptz CHECK (valid_until IS NULL OR isfinite(valid_until)),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(region_id,revision),
  UNIQUE(id,region_id,revision),
  CHECK (array_ndims(unverified_categories) IS NULL OR array_ndims(unverified_categories)=1),
  CHECK (array_position(unverified_categories,NULL) IS NULL),
  CHECK ((expiry_kind='at' AND valid_until IS NOT NULL AND valid_until > effective_at)
    OR (expiry_kind<>'at' AND valid_until IS NULL))
);
CREATE TABLE whaleu_community.region_policy_heads (
  region_id uuid PRIMARY KEY REFERENCES whaleu_campus.operating_regions(id),
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  revision_id uuid,
  CHECK ((revision=0 AND revision_id IS NULL) OR (revision>0 AND revision_id IS NOT NULL)),
  FOREIGN KEY(revision_id,region_id,revision) REFERENCES whaleu_community.region_policy_revisions(id,region_id,revision)
);

-- Every write statement obtains the exclusive common gate BEFORE row locks.
-- Multi-statement writers must still take this gate before any earlier SELECT
-- FOR UPDATE or cross-domain row lock; a trigger cannot repair an earlier order.
CREATE FUNCTION whaleu_campus.community_scope_writer_gate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('whaleu:named-block-policy:v1',0));
  RETURN NULL;
END;
$$;
CREATE TRIGGER community_topology_snapshot_writer_gate BEFORE INSERT OR UPDATE OR DELETE ON whaleu_campus.community_topology_snapshots FOR EACH STATEMENT EXECUTE FUNCTION whaleu_campus.community_scope_writer_gate();
CREATE TRIGGER community_topology_head_writer_gate BEFORE INSERT OR UPDATE OR DELETE ON whaleu_campus.community_topology_heads FOR EACH STATEMENT EXECUTE FUNCTION whaleu_campus.community_scope_writer_gate();
CREATE TRIGGER community_identity_selection_writer_gate BEFORE INSERT OR UPDATE OR DELETE ON whaleu_campus.community_identity_selections FOR EACH STATEMENT EXECUTE FUNCTION whaleu_campus.community_scope_writer_gate();
CREATE TRIGGER community_identity_head_writer_gate BEFORE INSERT OR UPDATE OR DELETE ON whaleu_campus.community_identity_heads FOR EACH STATEMENT EXECUTE FUNCTION whaleu_campus.community_scope_writer_gate();
CREATE TRIGGER community_region_policy_revision_writer_gate BEFORE INSERT OR UPDATE OR DELETE ON whaleu_community.region_policy_revisions FOR EACH STATEMENT EXECUTE FUNCTION whaleu_campus.community_scope_writer_gate();
CREATE TRIGGER community_region_policy_head_writer_gate BEFORE INSERT OR UPDATE OR DELETE ON whaleu_community.region_policy_heads FOR EACH STATEMENT EXECUTE FUNCTION whaleu_campus.community_scope_writer_gate();

CREATE FUNCTION whaleu_campus.immutable_community_policy_fact() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Community scope and configuration history is append-only';
END;
$$;
CREATE TRIGGER immutable_community_topology BEFORE UPDATE OR DELETE ON whaleu_campus.community_topology_snapshots FOR EACH ROW EXECUTE FUNCTION whaleu_campus.immutable_community_policy_fact();
CREATE TRIGGER immutable_community_identity BEFORE UPDATE OR DELETE ON whaleu_campus.community_identity_selections FOR EACH ROW EXECUTE FUNCTION whaleu_campus.immutable_community_policy_fact();
CREATE TRIGGER immutable_community_region_policy BEFORE UPDATE OR DELETE ON whaleu_community.region_policy_revisions FOR EACH ROW EXECUTE FUNCTION whaleu_campus.immutable_community_policy_fact();

CREATE FUNCTION whaleu_campus.protect_community_policy_head() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Community authority heads cannot be deleted'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.revision<>0 THEN RAISE EXCEPTION 'Initialize an empty authority head first'; END IF;
  ELSE
    IF NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'Community authority head revision conflict'; END IF;
    IF TG_TABLE_NAME='community_topology_heads' THEN
      IF NEW.scope_key<>OLD.scope_key THEN RAISE EXCEPTION 'Authority head identity is immutable'; END IF;
    ELSIF TG_TABLE_NAME='community_identity_heads' THEN
      IF NEW.account_id<>OLD.account_id THEN RAISE EXCEPTION 'Authority head identity is immutable'; END IF;
    ELSIF TG_TABLE_NAME='region_policy_heads' THEN
      IF NEW.region_id<>OLD.region_id THEN RAISE EXCEPTION 'Authority head identity is immutable'; END IF;
    ELSE
      RAISE EXCEPTION 'Unsupported authority head';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER protect_community_topology_head BEFORE INSERT OR UPDATE OR DELETE ON whaleu_campus.community_topology_heads FOR EACH ROW EXECUTE FUNCTION whaleu_campus.protect_community_policy_head();
CREATE TRIGGER protect_community_identity_head BEFORE INSERT OR UPDATE OR DELETE ON whaleu_campus.community_identity_heads FOR EACH ROW EXECUTE FUNCTION whaleu_campus.protect_community_policy_head();
CREATE TRIGGER protect_community_region_policy_head BEFORE INSERT OR UPDATE OR DELETE ON whaleu_community.region_policy_heads FOR EACH ROW EXECUTE FUNCTION whaleu_campus.protect_community_policy_head();

-- A selection cannot relabel another account's snapshot or a non-affiliation fact.
CREATE FUNCTION whaleu_campus.validate_community_selection_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM whaleu_verification.snapshots s
    JOIN whaleu_verification.assertions a ON a.id=s.affiliation_assertion_id AND a.account_id=s.account_id
    WHERE s.id=NEW.affiliation_snapshot_id AND s.account_id=NEW.account_id
      AND a.id=NEW.affiliation_assertion_id AND a.fact_kind='affiliation'
  ) THEN
    RAISE EXCEPTION 'Identity selection requires an account-bound affiliation snapshot';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER validate_community_selection_binding BEFORE INSERT ON whaleu_campus.community_identity_selections FOR EACH ROW EXECUTE FUNCTION whaleu_campus.validate_community_selection_binding();
REVOKE ALL ON whaleu_campus.community_topology_snapshots, whaleu_campus.community_topology_heads,
  whaleu_campus.community_identity_selections, whaleu_campus.community_identity_heads,
  whaleu_community.region_policy_revisions, whaleu_community.region_policy_heads FROM PUBLIC;
-- Empty local exact-content approval ledger. No issuer, grant, head, binding,
-- legacy reconciliation, startup writer, fixture route or provider is installed.
-- Lock order: policy writer takes the existing safety advisory gate EXCLUSIVE
-- before statement/row locks, then account anchors, decision heads. All ordinary
-- reads/publication take that gate SHARED first, then active actor/scope/ancestry
-- locks and approval head SHARE. Issuance also locks its account FOR UPDATE,
-- closing absent-intent/absent-head races. There is no runtime issuance method.
CREATE TABLE whaleu_community.content_approval_policies (
  id uuid PRIMARY KEY, policy_key text NOT NULL CHECK(policy_key='local-explicit-v1'),
  version integer NOT NULL CHECK(version=1),
  coverage text NOT NULL CHECK(coverage IN ('complete','missing','conflicting')),
  provenance text NOT NULL CHECK(provenance IN ('accepted','unreconciled','rejected')),
  issuer text NOT NULL CHECK(length(btrim(issuer))>0), provenance_ref text NOT NULL CHECK(length(btrim(provenance_ref))>0),
  valid_from timestamptz NOT NULL CHECK(isfinite(valid_from)),
  valid_until timestamptz CHECK(valid_until IS NULL OR (isfinite(valid_until) AND valid_until>valid_from))
);
CREATE FUNCTION whaleu_community.content_canonical_json(value jsonb) RETURNS text
  LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE result text;
BEGIN
  CASE jsonb_typeof(value)
    WHEN 'object' THEN
      SELECT '{'||coalesce(string_agg(to_jsonb(key)::text||':'||whaleu_community.content_canonical_json(val),',' ORDER BY key COLLATE "C"),'')||'}'
      INTO result FROM jsonb_each(value) AS pair(key,val);
    WHEN 'array' THEN
      SELECT '['||coalesce(string_agg(whaleu_community.content_canonical_json(val),',' ORDER BY position),'')||']'
      INTO result FROM jsonb_array_elements(value) WITH ORDINALITY AS item(val,position);
    ELSE result:=value::text;
  END CASE;
  RETURN result;
END $$;
CREATE TABLE whaleu_community.content_approval_decisions (
  id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
  operation text NOT NULL CHECK(operation IN ('publish_post','publish_comment','publish_reply')),
  envelope_version integer NOT NULL CHECK(envelope_version=1),
  digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'), envelope jsonb NOT NULL,
  policy_revision_id uuid NOT NULL REFERENCES whaleu_community.content_approval_policies(id),
  result text NOT NULL CHECK(result IN ('allow','reject','pending','failed')),
  coverage text NOT NULL CHECK(coverage IN ('complete','missing','conflicting')),
  provenance text NOT NULL CHECK(provenance IN ('accepted','unreconciled','rejected')),
  issuer text NOT NULL CHECK(length(btrim(issuer))>0), provenance_ref text NOT NULL CHECK(length(btrim(provenance_ref))>0),
  evaluated_at timestamptz NOT NULL CHECK(isfinite(evaluated_at)),
  consume_until timestamptz NOT NULL CHECK(isfinite(consume_until) AND consume_until>evaluated_at),
  visibility_model text NOT NULL CHECK(visibility_model IN ('durable','until')),
  visibility_until timestamptz CHECK(visibility_until IS NULL OR (isfinite(visibility_until) AND visibility_until>evaluated_at)),
  CHECK((visibility_model='durable' AND visibility_until IS NULL) OR (visibility_model='until' AND visibility_until IS NOT NULL)),
  CHECK(coalesce(jsonb_typeof(envelope)='object' AND envelope->>'version'='1' AND envelope->>'accountId'=account_id::text AND
    envelope->>'purpose'=operation AND jsonb_typeof(envelope->'scope')='object' AND envelope->'scope'->>'sync'='none',false)),
  CHECK(digest=encode(sha256(convert_to('whaleu-content-approval:v1'||chr(10)||whaleu_community.content_canonical_json(envelope),'UTF8')),'hex')),
  UNIQUE(id,account_id,operation,envelope_version,digest)
);
CREATE INDEX content_approval_exact_intent ON whaleu_community.content_approval_decisions(account_id,operation,envelope_version,digest,evaluated_at DESC,id DESC);
CREATE TABLE whaleu_community.content_approval_events (
  id uuid PRIMARY KEY, decision_id uuid NOT NULL REFERENCES whaleu_community.content_approval_decisions(id),
  sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  state text NOT NULL CHECK(state IN ('allow','held','revoked')),
  coverage text NOT NULL CHECK(coverage IN ('complete','missing','conflicting')),
  provenance text NOT NULL CHECK(provenance IN ('accepted','unreconciled','rejected')),
  issuer text NOT NULL CHECK(length(btrim(issuer))>0), provenance_ref text NOT NULL CHECK(length(btrim(provenance_ref))>0),
  occurred_at timestamptz NOT NULL CHECK(isfinite(occurred_at)),
  UNIQUE(id,decision_id)
);
CREATE TABLE whaleu_community.content_approval_heads (
  decision_id uuid PRIMARY KEY REFERENCES whaleu_community.content_approval_decisions(id),
  event_id uuid NOT NULL UNIQUE,
  FOREIGN KEY(event_id,decision_id) REFERENCES whaleu_community.content_approval_events(id,decision_id)
);
CREATE TABLE whaleu_community.content_approval_bindings (
  content_kind text NOT NULL CHECK(content_kind IN ('post','comment','reply')), content_id uuid NOT NULL,
  content_version integer NOT NULL CHECK(content_version=1),
  decision_id uuid NOT NULL UNIQUE,
  account_id uuid NOT NULL, operation text NOT NULL, envelope_version integer NOT NULL CHECK(envelope_version=1),
  digest text NOT NULL, envelope jsonb NOT NULL, scope jsonb NOT NULL,
  bound_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(content_kind,content_id,content_version),
  FOREIGN KEY(decision_id,account_id,operation,envelope_version,digest)
    REFERENCES whaleu_community.content_approval_decisions(id,account_id,operation,envelope_version,digest),
  CHECK(operation=CASE content_kind WHEN 'post' THEN 'publish_post' WHEN 'comment' THEN 'publish_comment' ELSE 'publish_reply' END),
  CHECK(scope=envelope->'scope')
);
CREATE FUNCTION whaleu_community.content_policy_writer_gate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('whaleu:named-block-policy:v1',0));
  RETURN NULL;
END $$;
CREATE TRIGGER content_policy_writer_gate BEFORE INSERT OR UPDATE OR DELETE ON whaleu_community.content_approval_policies
 FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.content_policy_writer_gate();
CREATE TRIGGER content_decision_writer_gate BEFORE INSERT OR UPDATE OR DELETE ON whaleu_community.content_approval_decisions
 FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.content_policy_writer_gate();
CREATE TRIGGER content_event_writer_gate BEFORE INSERT OR UPDATE OR DELETE ON whaleu_community.content_approval_events
 FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.content_policy_writer_gate();
CREATE TRIGGER content_head_writer_gate BEFORE INSERT OR UPDATE OR DELETE ON whaleu_community.content_approval_heads
 FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.content_policy_writer_gate();
CREATE FUNCTION whaleu_community.content_approval_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Content approval evidence is immutable' USING ERRCODE='23514'; END $$;
CREATE TRIGGER content_policy_immutable BEFORE UPDATE OR DELETE ON whaleu_community.content_approval_policies
 FOR EACH ROW EXECUTE FUNCTION whaleu_community.content_approval_immutable();
CREATE TRIGGER content_decision_immutable BEFORE UPDATE OR DELETE ON whaleu_community.content_approval_decisions
 FOR EACH ROW EXECUTE FUNCTION whaleu_community.content_approval_immutable();
CREATE TRIGGER content_event_immutable BEFORE UPDATE OR DELETE ON whaleu_community.content_approval_events
 FOR EACH ROW EXECUTE FUNCTION whaleu_community.content_approval_immutable();
CREATE TRIGGER content_binding_immutable BEFORE UPDATE OR DELETE ON whaleu_community.content_approval_bindings
 FOR EACH ROW EXECUTE FUNCTION whaleu_community.content_approval_immutable();
CREATE FUNCTION whaleu_community.content_decision_anchor() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM id FROM whaleu_identity.accounts WHERE id=NEW.account_id FOR UPDATE;
 RETURN NEW;
END $$;
CREATE TRIGGER content_decision_anchor BEFORE INSERT ON whaleu_community.content_approval_decisions
 FOR EACH ROW EXECUTE FUNCTION whaleu_community.content_decision_anchor();
CREATE FUNCTION whaleu_community.content_head_validate() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actor uuid; next_event whaleu_community.content_approval_events; old_sequence bigint; decision_time timestamptz;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Content review head cannot be deleted' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' AND OLD.decision_id<>NEW.decision_id THEN RAISE EXCEPTION 'Content review identity is immutable' USING ERRCODE='23514'; END IF;
 SELECT account_id,evaluated_at INTO actor,decision_time FROM whaleu_community.content_approval_decisions WHERE id=NEW.decision_id;
 PERFORM id FROM whaleu_identity.accounts WHERE id=actor FOR UPDATE;
 SELECT * INTO next_event FROM whaleu_community.content_approval_events WHERE id=NEW.event_id AND decision_id=NEW.decision_id;
 IF NOT FOUND OR next_event.occurred_at<decision_time THEN RAISE EXCEPTION 'Content review event is invalid' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' THEN
  SELECT sequence INTO old_sequence FROM whaleu_community.content_approval_events WHERE id=OLD.event_id;
  IF next_event.sequence<=old_sequence THEN RAISE EXCEPTION 'Content review head cannot rewind' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER content_head_validate BEFORE INSERT OR UPDATE OR DELETE ON whaleu_community.content_approval_heads
 FOR EACH ROW EXECUTE FUNCTION whaleu_community.content_head_validate();
-- Add no review provenance to old rows. Only new rows receive this marker.
ALTER TABLE whaleu_community.root_comments ADD COLUMN approval_publication_transaction xid8;
ALTER TABLE whaleu_community.root_comments ALTER COLUMN approval_publication_transaction SET DEFAULT pg_current_xact_id();
ALTER TABLE whaleu_community.replies ADD COLUMN approval_publication_transaction xid8;
ALTER TABLE whaleu_community.replies ALTER COLUMN approval_publication_transaction SET DEFAULT pg_current_xact_id();
CREATE FUNCTION whaleu_community.content_binding_validate() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE decision whaleu_community.content_approval_decisions; payload jsonb; creation xid8; table_name text; marker text;
BEGIN
 SELECT * INTO decision FROM whaleu_community.content_approval_decisions WHERE id=NEW.decision_id;
 IF NOT FOUND OR decision.envelope<>NEW.envelope OR decision.result<>'allow' OR decision.coverage<>'complete' OR decision.provenance<>'accepted' THEN
  RAISE EXCEPTION 'Content binding evidence mismatch' USING ERRCODE='23514'; END IF;
 table_name:=CASE NEW.content_kind WHEN 'post' THEN 'posts' WHEN 'comment' THEN 'root_comments' ELSE 'replies' END;
 marker:=CASE NEW.content_kind WHEN 'post' THEN 'publication_transaction' ELSE 'approval_publication_transaction' END;
 EXECUTE format('SELECT to_jsonb(c),%I FROM whaleu_community.%I c WHERE id=$1 FOR SHARE',marker,table_name) INTO payload,creation USING NEW.content_id;
 IF payload IS NULL OR creation IS DISTINCT FROM pg_current_xact_id() OR payload->>'account_id'<>NEW.account_id::text OR
  payload->>'text' IS DISTINCT FROM NEW.envelope->>'text' OR payload->>'author_mode' IS DISTINCT FROM NEW.envelope->>'authorMode' OR
  (NEW.content_kind='post' AND (payload->>'space_id' IS DISTINCT FROM NEW.envelope->>'spaceId' OR payload->>'category' IS DISTINCT FROM NEW.envelope->>'category' OR payload->>'comments_policy' IS DISTINCT FROM NEW.envelope->>'commentsPolicy')) OR
  (NEW.content_kind<>'post' AND payload->>'post_id' IS DISTINCT FROM NEW.envelope->>'postId') OR
  (NEW.content_kind='reply' AND (payload->>'root_comment_id' IS DISTINCT FROM NEW.envelope->>'rootCommentId' OR payload->>'target_reply_id' IS DISTINCT FROM NEW.envelope->>'targetReplyId')) THEN
  RAISE EXCEPTION 'Content binding publication mismatch' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER content_binding_validate BEFORE INSERT ON whaleu_community.content_approval_bindings
 FOR EACH ROW EXECUTE FUNCTION whaleu_community.content_binding_validate();
CREATE FUNCTION whaleu_community.approved_content_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE kind text;
BEGIN
 kind:=CASE TG_TABLE_NAME WHEN 'posts' THEN 'post' WHEN 'root_comments' THEN 'comment' ELSE 'reply' END;
 IF TG_OP='UPDATE' AND ((to_jsonb(OLD)->'approval_publication_transaction' IS DISTINCT FROM to_jsonb(NEW)->'approval_publication_transaction') OR
  (to_jsonb(OLD)->'publication_transaction' IS DISTINCT FROM to_jsonb(NEW)->'publication_transaction')) THEN
  RAISE EXCEPTION 'Publication transaction is immutable' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM whaleu_community.content_approval_bindings WHERE content_kind=kind AND content_id=OLD.id) AND
  (TG_OP='DELETE' OR (to_jsonb(OLD)-'visibility'-'deleted_at') IS DISTINCT FROM (to_jsonb(NEW)-'visibility'-'deleted_at')) THEN
  RAISE EXCEPTION 'Approved publication definition is immutable' USING ERRCODE='23514'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
CREATE TRIGGER approved_post_immutable BEFORE UPDATE OR DELETE ON whaleu_community.posts
 FOR EACH ROW EXECUTE FUNCTION whaleu_community.approved_content_immutable();
CREATE TRIGGER approved_comment_immutable BEFORE UPDATE OR DELETE ON whaleu_community.root_comments
 FOR EACH ROW EXECUTE FUNCTION whaleu_community.approved_content_immutable();
CREATE TRIGGER approved_reply_immutable BEFORE UPDATE OR DELETE ON whaleu_community.replies
 FOR EACH ROW EXECUTE FUNCTION whaleu_community.approved_content_immutable();
CREATE FUNCTION whaleu_community.approved_assets_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE kind text; target uuid; old_target uuid; parent_table text;
BEGIN
 kind:=CASE TG_TABLE_NAME WHEN 'post_images' THEN 'post' WHEN 'comment_images' THEN 'comment' ELSE 'reply' END;
 parent_table:=CASE kind WHEN 'post' THEN 'posts' WHEN 'comment' THEN 'root_comments' ELSE 'replies' END;
 IF TG_OP<>'INSERT' THEN old_target:=(to_jsonb(OLD)->>(kind||'_id'))::uuid; END IF;
 IF TG_OP='DELETE' THEN target:=old_target; ELSE target:=(to_jsonb(NEW)->>(kind||'_id'))::uuid; END IF;
 EXECUTE format('SELECT id FROM whaleu_community.%I WHERE id=ANY($1) ORDER BY id FOR UPDATE',parent_table) USING ARRAY[target,old_target];
 IF EXISTS(SELECT 1 FROM whaleu_community.content_approval_bindings WHERE content_kind=kind AND content_id IN (target,old_target)) THEN
  RAISE EXCEPTION 'Approved publication assets are immutable' USING ERRCODE='23514'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
CREATE TRIGGER approved_post_assets_immutable BEFORE INSERT OR UPDATE OR DELETE ON whaleu_community.post_images
 FOR EACH ROW EXECUTE FUNCTION whaleu_community.approved_assets_immutable();
CREATE TRIGGER approved_comment_assets_immutable BEFORE INSERT OR UPDATE OR DELETE ON whaleu_community.comment_images
 FOR EACH ROW EXECUTE FUNCTION whaleu_community.approved_assets_immutable();
CREATE TRIGGER approved_reply_assets_immutable BEFORE INSERT OR UPDATE OR DELETE ON whaleu_community.reply_images
 FOR EACH ROW EXECUTE FUNCTION whaleu_community.approved_assets_immutable();
-- A new component cannot be attached after a post received approval, including
-- when the previous definition was plain text. Parent row is the absent-child
-- anchor shared by rendering, binding and all these insert paths.
CREATE FUNCTION whaleu_community.approved_component_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM id FROM whaleu_community.posts WHERE id=NEW.post_id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM whaleu_community.content_approval_bindings WHERE content_kind='post' AND content_id=NEW.post_id) THEN
  RAISE EXCEPTION 'Approved publication component is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER approved_poll_insert BEFORE INSERT ON whaleu_community.polls
 FOR EACH ROW EXECUTE FUNCTION whaleu_community.approved_component_insert();
CREATE TRIGGER approved_formation_insert BEFORE INSERT ON whaleu_community.formations
 FOR EACH ROW EXECUTE FUNCTION whaleu_community.approved_component_insert();
CREATE TRIGGER approved_trading_insert BEFORE INSERT ON whaleu_community.trading_listings
 FOR EACH ROW EXECUTE FUNCTION whaleu_community.approved_component_insert();
