-- Empty E1 errand domain and narrow owner records. No issuer, grants, source
-- import, provider configuration or existing-account coverage is fabricated.
CREATE SCHEMA whaleu_errands;
CREATE TABLE whaleu_safety.errand_feature_snapshots (
 id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
 coverage text NOT NULL CHECK(coverage IN ('complete','missing','conflicting')),
 provenance text NOT NULL CHECK(provenance IN ('accepted','unknown','conflicting')),
 source_reference text NOT NULL CHECK(length(btrim(source_reference))>0),
 policy_reference text NOT NULL CHECK(length(btrim(policy_reference))>0),
 effective_at timestamptz NOT NULL CHECK(isfinite(effective_at)),
 valid_until timestamptz CHECK(valid_until IS NULL OR (isfinite(valid_until) AND valid_until>effective_at)),
 restrictions jsonb NOT NULL CHECK(jsonb_typeof(restrictions)='array' AND jsonb_array_length(restrictions)<=256),
 UNIQUE(id,account_id)
);
CREATE TABLE whaleu_safety.errand_feature_heads (
 account_id uuid PRIMARY KEY REFERENCES whaleu_identity.accounts(id),snapshot_id uuid NOT NULL,
 FOREIGN KEY(snapshot_id,account_id) REFERENCES whaleu_safety.errand_feature_snapshots(id,account_id)
);
CREATE TABLE whaleu_verification.errand_base_assertions (
 id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
 state text NOT NULL CHECK(state IN ('verified','unverified','revoked')),
 coverage text NOT NULL CHECK(coverage IN ('complete','missing','conflicting')),
 provenance text NOT NULL CHECK(provenance IN ('accepted','unknown','conflicting')),
 issuer text NOT NULL CHECK(length(btrim(issuer))>0),
 source_reference text NOT NULL CHECK(length(btrim(source_reference))>0),
 policy_reference text NOT NULL CHECK(length(btrim(policy_reference))>0),
 effective_at timestamptz NOT NULL CHECK(isfinite(effective_at)),
 valid_until timestamptz NOT NULL CHECK(isfinite(valid_until) AND valid_until>effective_at),
 UNIQUE(id,account_id)
);
CREATE TABLE whaleu_verification.errand_base_heads (
 account_id uuid PRIMARY KEY REFERENCES whaleu_identity.accounts(id),assertion_id uuid NOT NULL,
 FOREIGN KEY(assertion_id,account_id) REFERENCES whaleu_verification.errand_base_assertions(id,account_id)
);
CREATE TABLE whaleu_errands.orders (
 id uuid PRIMARY KEY, revision uuid NOT NULL,
 publisher_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
 accepter_id uuid REFERENCES whaleu_identity.accounts(id),
 target_region_id uuid NOT NULL REFERENCES whaleu_campus.operating_regions(id),
 source_region_id uuid NOT NULL REFERENCES whaleu_campus.operating_regions(id),
 scope jsonb NOT NULL CHECK(jsonb_typeof(scope)='object'),
 CHECK(coalesce(scope->>'targetRegionId'=target_region_id::text AND scope->>'sourceRegionId'=source_region_id::text,false)),
 title text NOT NULL CHECK(length(title) BETWEEN 1 AND 50),
 public_text text NOT NULL CHECK(length(public_text) BETWEEN 1 AND 500),
 expected_time_text text NOT NULL CHECK(length(expected_time_text) BETWEEN 1 AND 50),
 reward numeric NOT NULL CHECK(reward>=1 AND reward<=500),
 state text NOT NULL CHECK(state IN ('pending','accepted','completed','cancelled')),
 created_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),
 accepted_at timestamptz, completed_at timestamptz, cancelled_at timestamptz,
 deleted_at timestamptz, deleted_by uuid REFERENCES whaleu_identity.accounts(id),
 CHECK(publisher_id IS DISTINCT FROM accepter_id),
 CHECK((accepter_id IS NULL)=(accepted_at IS NULL)),
 CHECK(state<>'pending' OR accepter_id IS NULL),
 CHECK(state NOT IN ('accepted','completed') OR accepter_id IS NOT NULL),
 CHECK((state='completed')=(completed_at IS NOT NULL)),
 CHECK((state='cancelled')=(cancelled_at IS NOT NULL)),
 CHECK((deleted_at IS NULL)=(deleted_by IS NULL)),
 CHECK(isfinite(created_at) AND (accepted_at IS NULL OR isfinite(accepted_at)) AND (completed_at IS NULL OR isfinite(completed_at)) AND (cancelled_at IS NULL OR isfinite(cancelled_at)) AND (deleted_at IS NULL OR isfinite(deleted_at)))
);
CREATE TABLE whaleu_errands.private_details (
 order_id uuid PRIMARY KEY REFERENCES whaleu_errands.orders(id),
 private_text text NOT NULL CHECK(length(private_text)<=200),
 publisher_contacts jsonb NOT NULL CHECK(jsonb_typeof(publisher_contacts)='object'),
 accepter_contacts jsonb CHECK(accepter_contacts IS NULL OR jsonb_typeof(accepter_contacts)='object')
);
CREATE TABLE whaleu_errands.contact_history (
 account_id uuid PRIMARY KEY REFERENCES whaleu_identity.accounts(id),contacts jsonb NOT NULL CHECK(jsonb_typeof(contacts)='object'),
 transition_id uuid NOT NULL, updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE whaleu_errands.transitions (
 id uuid PRIMARY KEY, order_id uuid NOT NULL REFERENCES whaleu_errands.orders(id),
 actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
 operation text NOT NULL CHECK(operation IN ('publish','accept','cancel','complete','delete')),
 prior_state text CHECK(prior_state IN ('pending','accepted','completed','cancelled')),
 next_state text NOT NULL CHECK(next_state IN ('pending','accepted','completed','cancelled')),
 request_id uuid NOT NULL, revision uuid NOT NULL, occurred_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),
 UNIQUE(order_id,revision), UNIQUE(actor_id,request_id)
);
ALTER TABLE whaleu_errands.contact_history ADD FOREIGN KEY(transition_id) REFERENCES whaleu_errands.transitions(id);
CREATE TABLE whaleu_errands.requests (
 account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),request_id uuid NOT NULL,
 operation text NOT NULL CHECK(operation IN ('publish','accept','cancel','complete','delete')),
 intent_hash text NOT NULL CHECK(intent_hash~'^[a-f0-9]{64}$'), receipt jsonb,
 PRIMARY KEY(account_id,request_id), CHECK(receipt IS NULL OR jsonb_typeof(receipt)='object')
);
ALTER TABLE whaleu_errands.transitions ADD FOREIGN KEY(actor_id,request_id) REFERENCES whaleu_errands.requests(account_id,request_id) DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX errand_discovery_created ON whaleu_errands.orders(target_region_id,created_at,id) WHERE deleted_at IS NULL AND state IN ('pending','accepted');
CREATE INDEX errand_discovery_reward ON whaleu_errands.orders(target_region_id,reward,created_at,id) WHERE deleted_at IS NULL AND state IN ('pending','accepted');
CREATE INDEX errand_published_history ON whaleu_errands.orders(publisher_id,created_at DESC,id DESC) WHERE deleted_at IS NULL;
CREATE INDEX errand_accepted_history ON whaleu_errands.orders(accepter_id,created_at DESC,id DESC) WHERE deleted_at IS NULL;
CREATE FUNCTION whaleu_errands.immutable_row() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Errand authority, content and audit records are immutable'; END $$;
CREATE FUNCTION whaleu_errands.authority_writer_gate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM pg_advisory_xact_lock(hashtextextended('whaleu:named-block-policy:v1',0)); RETURN NULL; END $$;
CREATE TRIGGER errand_feature_snapshot_immutable BEFORE UPDATE OR DELETE ON whaleu_safety.errand_feature_snapshots FOR EACH ROW EXECUTE FUNCTION whaleu_errands.immutable_row();
CREATE TRIGGER errand_base_assertion_immutable BEFORE UPDATE OR DELETE ON whaleu_verification.errand_base_assertions FOR EACH ROW EXECUTE FUNCTION whaleu_errands.immutable_row();
CREATE TRIGGER errand_feature_head_writer BEFORE INSERT OR UPDATE OR DELETE ON whaleu_safety.errand_feature_heads FOR EACH STATEMENT EXECUTE FUNCTION whaleu_errands.authority_writer_gate();
CREATE TRIGGER errand_base_head_writer BEFORE INSERT OR UPDATE OR DELETE ON whaleu_verification.errand_base_heads FOR EACH STATEMENT EXECUTE FUNCTION whaleu_errands.authority_writer_gate();
CREATE TRIGGER errand_transition_immutable BEFORE UPDATE OR DELETE ON whaleu_errands.transitions FOR EACH ROW EXECUTE FUNCTION whaleu_errands.immutable_row();
CREATE FUNCTION whaleu_errands.freeze_order_definition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.id,NEW.publisher_id,NEW.target_region_id,NEW.source_region_id,NEW.scope,NEW.title,NEW.public_text,NEW.expected_time_text,NEW.reward,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.publisher_id,OLD.target_region_id,OLD.source_region_id,OLD.scope,OLD.title,OLD.public_text,OLD.expected_time_text,OLD.reward,OLD.created_at) THEN RAISE EXCEPTION 'Errand definition is immutable'; END IF;
 IF OLD.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'Errand tombstone is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER errand_order_definition BEFORE UPDATE ON whaleu_errands.orders FOR EACH ROW EXECUTE FUNCTION whaleu_errands.freeze_order_definition();
CREATE FUNCTION whaleu_errands.freeze_private_definition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Errand private definition is durable'; END IF;
 IF ROW(NEW.order_id,NEW.private_text,NEW.publisher_contacts) IS DISTINCT FROM ROW(OLD.order_id,OLD.private_text,OLD.publisher_contacts) OR OLD.accepter_contacts IS NOT NULL THEN RAISE EXCEPTION 'Errand private definition is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER errand_private_definition BEFORE UPDATE OR DELETE ON whaleu_errands.private_details FOR EACH ROW EXECUTE FUNCTION whaleu_errands.freeze_private_definition();
CREATE TABLE whaleu_notifications.errand_notices (
 id uuid PRIMARY KEY,transition_id uuid NOT NULL REFERENCES whaleu_errands.transitions(id),
 recipient_account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),order_id uuid NOT NULL REFERENCES whaleu_errands.orders(id),
 kind text NOT NULL CHECK(kind IN ('accepted','completed')),
 created_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),read_at timestamptz,
 UNIQUE(transition_id,recipient_account_id,kind)
);
CREATE INDEX errand_notice_owner ON whaleu_notifications.errand_notices(recipient_account_id,created_at DESC,id DESC);
CREATE INDEX errand_notice_unread ON whaleu_notifications.errand_notices(recipient_account_id) WHERE read_at IS NULL;
CREATE FUNCTION whaleu_errands.freeze_authority_head() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_time timestamptz; new_time timestamptz;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Errand authority head cannot be deleted'; END IF;
 IF NEW.account_id<>OLD.account_id THEN RAISE EXCEPTION 'Errand authority head cannot change owner'; END IF;
 IF TG_TABLE_SCHEMA='whaleu_safety' THEN
  SELECT effective_at INTO old_time FROM whaleu_safety.errand_feature_snapshots WHERE id=OLD.snapshot_id;
  SELECT effective_at INTO new_time FROM whaleu_safety.errand_feature_snapshots WHERE id=NEW.snapshot_id;
 ELSE
  SELECT effective_at INTO old_time FROM whaleu_verification.errand_base_assertions WHERE id=OLD.assertion_id;
  SELECT effective_at INTO new_time FROM whaleu_verification.errand_base_assertions WHERE id=NEW.assertion_id;
 END IF;
 IF new_time IS NULL OR new_time<=old_time THEN RAISE EXCEPTION 'Errand authority head must advance causally'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER errand_feature_head_causal BEFORE UPDATE OR DELETE ON whaleu_safety.errand_feature_heads FOR EACH ROW EXECUTE FUNCTION whaleu_errands.freeze_authority_head();
CREATE TRIGGER errand_base_head_causal BEFORE UPDATE OR DELETE ON whaleu_verification.errand_base_heads FOR EACH ROW EXECUTE FUNCTION whaleu_errands.freeze_authority_head();
-- Dedicated errand discriminant; reuses the existing review policy authority,
-- canonical encoder and safety writer gate. No policy, issuer, grant or head is
-- seeded. Place after 0016+ prerequisites. Errands owns its order immutability,
-- same-publication transaction assertion, and its deferred binding constraint.
CREATE TABLE whaleu_community.errand_approval_decisions (
  id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
  operation text NOT NULL CHECK(operation='publish_errand'),
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
  CHECK(coalesce(jsonb_typeof(envelope)='object' AND envelope->>'version'='1' AND
    envelope->>'accountId'=account_id::text AND envelope->>'purpose'=operation AND
    jsonb_typeof(envelope->'scope')='object' AND envelope->'publicAssetIds'='[]'::jsonb AND envelope->'privateAssetIds'='[]'::jsonb,false)),
  CHECK(digest=encode(sha256(convert_to('whaleu-errand-content-approval:v1'||chr(10)||whaleu_community.content_canonical_json(envelope),'UTF8')),'hex')),
  UNIQUE(id,account_id,operation,envelope_version,digest)
);
CREATE INDEX errand_approval_exact_intent ON whaleu_community.errand_approval_decisions(account_id,operation,envelope_version,digest,evaluated_at DESC,id DESC);
CREATE TABLE whaleu_community.errand_approval_events (
  id uuid PRIMARY KEY, decision_id uuid NOT NULL REFERENCES whaleu_community.errand_approval_decisions(id),
  sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  state text NOT NULL CHECK(state IN ('allow','held','revoked')),
  coverage text NOT NULL CHECK(coverage IN ('complete','missing','conflicting')),
  provenance text NOT NULL CHECK(provenance IN ('accepted','unreconciled','rejected')),
  issuer text NOT NULL CHECK(length(btrim(issuer))>0), provenance_ref text NOT NULL CHECK(length(btrim(provenance_ref))>0),
  occurred_at timestamptz NOT NULL CHECK(isfinite(occurred_at)),
  UNIQUE(id,decision_id)
);
CREATE TABLE whaleu_community.errand_approval_heads (
  decision_id uuid PRIMARY KEY REFERENCES whaleu_community.errand_approval_decisions(id),
  event_id uuid NOT NULL UNIQUE,
  FOREIGN KEY(event_id,decision_id) REFERENCES whaleu_community.errand_approval_events(id,decision_id)
);
-- This is the review-owned immutable definition/binding. It never replaces the
-- errand owner's independently supplied current immutable row definition.
CREATE TABLE whaleu_community.errand_approval_bindings (
  order_id uuid PRIMARY KEY, content_version integer NOT NULL CHECK(content_version=1),
  decision_id uuid NOT NULL UNIQUE,
  account_id uuid NOT NULL, operation text NOT NULL CHECK(operation='publish_errand'),
  envelope_version integer NOT NULL CHECK(envelope_version=1),
  digest text NOT NULL, envelope jsonb NOT NULL, scope jsonb NOT NULL,
  bound_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  publication_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
  FOREIGN KEY(decision_id,account_id,operation,envelope_version,digest)
    REFERENCES whaleu_community.errand_approval_decisions(id,account_id,operation,envelope_version,digest),
  CHECK(scope=envelope->'scope')
);
CREATE TRIGGER errand_review_decision_writer_gate BEFORE INSERT OR UPDATE OR DELETE ON whaleu_community.errand_approval_decisions
 FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.content_policy_writer_gate();
CREATE TRIGGER errand_review_event_writer_gate BEFORE INSERT OR UPDATE OR DELETE ON whaleu_community.errand_approval_events
 FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.content_policy_writer_gate();
CREATE TRIGGER errand_review_head_writer_gate BEFORE INSERT OR UPDATE OR DELETE ON whaleu_community.errand_approval_heads
 FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.content_policy_writer_gate();
CREATE TRIGGER errand_review_decision_immutable BEFORE UPDATE OR DELETE ON whaleu_community.errand_approval_decisions
 FOR EACH ROW EXECUTE FUNCTION whaleu_community.content_approval_immutable();
CREATE TRIGGER errand_review_event_immutable BEFORE UPDATE OR DELETE ON whaleu_community.errand_approval_events
 FOR EACH ROW EXECUTE FUNCTION whaleu_community.content_approval_immutable();
CREATE TRIGGER errand_review_binding_immutable BEFORE UPDATE OR DELETE ON whaleu_community.errand_approval_bindings
 FOR EACH ROW EXECUTE FUNCTION whaleu_community.content_approval_immutable();
CREATE TRIGGER errand_review_decision_anchor BEFORE INSERT ON whaleu_community.errand_approval_decisions
 FOR EACH ROW EXECUTE FUNCTION whaleu_community.content_decision_anchor();
CREATE FUNCTION whaleu_community.errand_review_head_validate() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actor uuid; next_event whaleu_community.errand_approval_events; old_sequence bigint; decision_time timestamptz;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Errand review head cannot be deleted' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' AND OLD.decision_id<>NEW.decision_id THEN RAISE EXCEPTION 'Errand review identity is immutable' USING ERRCODE='23514'; END IF;
 SELECT account_id,evaluated_at INTO actor,decision_time FROM whaleu_community.errand_approval_decisions WHERE id=NEW.decision_id;
 PERFORM id FROM whaleu_identity.accounts WHERE id=actor FOR UPDATE;
 SELECT * INTO next_event FROM whaleu_community.errand_approval_events WHERE id=NEW.event_id AND decision_id=NEW.decision_id;
 IF NOT FOUND OR next_event.occurred_at<decision_time THEN RAISE EXCEPTION 'Errand review event is invalid' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' THEN
  SELECT sequence INTO old_sequence FROM whaleu_community.errand_approval_events WHERE id=OLD.event_id;
  IF next_event.sequence<=old_sequence THEN RAISE EXCEPTION 'Errand review head cannot rewind' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER errand_review_head_validate BEFORE INSERT OR UPDATE OR DELETE ON whaleu_community.errand_approval_heads
 FOR EACH ROW EXECUTE FUNCTION whaleu_community.errand_review_head_validate();
CREATE FUNCTION whaleu_community.errand_review_binding_validate() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE decision whaleu_community.errand_approval_decisions;
BEGIN
 SELECT * INTO decision FROM whaleu_community.errand_approval_decisions WHERE id=NEW.decision_id;
 IF NOT FOUND OR decision.envelope<>NEW.envelope OR decision.result<>'allow' OR decision.coverage<>'complete' OR decision.provenance<>'accepted' OR
    NEW.publication_transaction IS DISTINCT FROM pg_current_xact_id() THEN
  RAISE EXCEPTION 'Errand binding evidence mismatch' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER errand_review_binding_validate BEFORE INSERT ON whaleu_community.errand_approval_bindings
 FOR EACH ROW EXECUTE FUNCTION whaleu_community.errand_review_binding_validate();
-- Cross-owner referential integrity only; application reads use review facade.
ALTER TABLE whaleu_errands.orders ADD publication_transaction xid8 NOT NULL DEFAULT pg_current_xact_id();
ALTER TABLE whaleu_community.errand_approval_bindings ADD UNIQUE(order_id,publication_transaction);
ALTER TABLE whaleu_community.errand_approval_bindings ADD FOREIGN KEY(order_id) REFERENCES whaleu_errands.orders(id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE whaleu_errands.orders ADD FOREIGN KEY(id,publication_transaction) REFERENCES whaleu_community.errand_approval_bindings(order_id,publication_transaction) DEFERRABLE INITIALLY DEFERRED;
CREATE FUNCTION whaleu_errands.legal_order_edge() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Errand orders require soft deletion'; END IF;
 IF NEW.publication_transaction<>OLD.publication_transaction OR NEW.revision=OLD.revision THEN RAISE EXCEPTION 'Invalid errand revision'; END IF;
 IF NEW.deleted_at IS NOT NULL THEN
  IF ROW(NEW.state,NEW.accepter_id,NEW.accepted_at,NEW.completed_at,NEW.cancelled_at) IS DISTINCT FROM ROW(OLD.state,OLD.accepter_id,OLD.accepted_at,OLD.completed_at,OLD.cancelled_at) OR NEW.deleted_by<>OLD.publisher_id THEN RAISE EXCEPTION 'Invalid publisher tombstone'; END IF;
 ELSIF OLD.state='pending' AND NEW.state='accepted' THEN
  IF NEW.accepter_id IS NULL OR NEW.accepted_at IS NULL THEN RAISE EXCEPTION 'Invalid acceptance'; END IF;
 ELSIF (OLD.state IN ('pending','accepted') AND NEW.state='cancelled') OR (OLD.state='accepted' AND NEW.state='completed') THEN
  IF ROW(NEW.accepter_id,NEW.accepted_at) IS DISTINCT FROM ROW(OLD.accepter_id,OLD.accepted_at) THEN RAISE EXCEPTION 'Participant relationship is immutable'; END IF;
 ELSE RAISE EXCEPTION 'Illegal errand transition';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER errand_legal_edge BEFORE UPDATE OR DELETE ON whaleu_errands.orders FOR EACH ROW EXECUTE FUNCTION whaleu_errands.legal_order_edge();
CREATE FUNCTION whaleu_errands.require_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE event whaleu_errands.transitions; expected_operation text; expected_actor uuid; definition jsonb; binding jsonb;
BEGIN
 expected_operation:=CASE WHEN TG_OP='INSERT' THEN 'publish' WHEN NEW.deleted_at IS NOT NULL THEN 'delete' WHEN NEW.state='accepted' THEN 'accept' WHEN NEW.state='completed' THEN 'complete' ELSE 'cancel' END;
 expected_actor:=CASE WHEN expected_operation='accept' THEN NEW.accepter_id ELSE NEW.publisher_id END;
 SELECT * INTO event FROM whaleu_errands.transitions WHERE order_id=NEW.id AND revision=NEW.revision;
 IF NOT FOUND OR event.operation<>expected_operation OR event.actor_id<>expected_actor OR event.next_state<>NEW.state OR (TG_OP='INSERT' AND (event.prior_state IS NOT NULL OR NEW.state<>'pending')) OR (TG_OP='UPDATE' AND event.prior_state IS DISTINCT FROM OLD.state) THEN RAISE EXCEPTION 'Errand transition evidence required'; END IF;
 IF TG_OP='INSERT' THEN
  SELECT jsonb_build_object('version',1,'accountId',NEW.publisher_id::text,'purpose','publish_errand','title',NEW.title,'publicText',NEW.public_text,'privateText',p.private_text,'expectedTimeText',NEW.expected_time_text,'reward',NEW.reward::text,'publisherContacts',p.publisher_contacts,'publicAssetIds','[]'::jsonb,'privateAssetIds','[]'::jsonb,'scope',NEW.scope) INTO definition FROM whaleu_errands.private_details p WHERE p.order_id=NEW.id;
  SELECT envelope INTO binding FROM whaleu_community.errand_approval_bindings WHERE order_id=NEW.id;
  IF definition IS NULL OR binding IS DISTINCT FROM definition OR NEW.publication_transaction<>pg_current_xact_id() THEN RAISE EXCEPTION 'Exact errand publication binding required'; END IF;
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER errand_transition_required AFTER INSERT OR UPDATE ON whaleu_errands.orders DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_errands.require_transition();
CREATE FUNCTION whaleu_errands.freeze_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Errand receipts are immutable'; END IF;
 IF ROW(NEW.account_id,NEW.request_id,NEW.operation,NEW.intent_hash) IS DISTINCT FROM ROW(OLD.account_id,OLD.request_id,OLD.operation,OLD.intent_hash) OR OLD.receipt IS NOT NULL OR NEW.receipt IS NULL THEN RAISE EXCEPTION 'Errand terminal receipt is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER errand_request_immutable BEFORE UPDATE OR DELETE ON whaleu_errands.requests FOR EACH ROW EXECUTE FUNCTION whaleu_errands.freeze_request();
CREATE FUNCTION whaleu_errands.require_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE receipt jsonb; key_count integer;
BEGIN
 SELECT r.receipt INTO receipt FROM whaleu_errands.requests r WHERE r.account_id=NEW.account_id AND r.request_id=NEW.request_id;
 IF receipt IS NULL OR receipt->>'requestId' IS DISTINCT FROM NEW.request_id::text OR receipt->>'operation' IS DISTINCT FROM NEW.operation OR coalesce(receipt->>'outcome','') NOT IN ('applied','rejected') THEN RAISE EXCEPTION 'Terminal errand receipt required'; END IF;
 SELECT count(*) INTO key_count FROM jsonb_object_keys(receipt);
 IF receipt->>'outcome'='applied' THEN
  IF key_count<>6 OR NOT EXISTS(SELECT 1 FROM whaleu_errands.transitions t WHERE t.actor_id=NEW.account_id AND t.request_id=NEW.request_id AND t.operation=NEW.operation AND t.order_id=(receipt->>'orderId')::uuid AND t.revision=(receipt->>'revision')::uuid AND t.occurred_at=(receipt->>'occurredAt')::timestamptz) THEN RAISE EXCEPTION 'Applied errand receipt requires exact transition'; END IF;
 ELSE
  IF key_count<>4 OR coalesce(receipt->>'code','') NOT IN ('ERRAND_NOT_FOUND','ERRAND_REVISION_CONFLICT','ERRAND_STATE_CONFLICT','ERRAND_ACTION_RESTRICTED','ERRAND_SELF_ACCEPT','PHONE_VERIFICATION_REQUIRED','AFFILIATION_VERIFICATION_REQUIRED','IDENTITY_CAMPUS_REQUIRED','SAFETY_ACTION_RESTRICTED','CONTENT_REJECTED') OR EXISTS(SELECT 1 FROM whaleu_errands.transitions t WHERE t.actor_id=NEW.account_id AND t.request_id=NEW.request_id) THEN RAISE EXCEPTION 'Invalid rejected errand receipt'; END IF;
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER errand_receipt_required AFTER INSERT OR UPDATE ON whaleu_errands.requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_errands.require_receipt();
CREATE FUNCTION whaleu_notifications.freeze_errand_notice() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Errand notice is durable'; END IF;
 IF ROW(NEW.id,NEW.transition_id,NEW.recipient_account_id,NEW.order_id,NEW.kind,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.transition_id,OLD.recipient_account_id,OLD.order_id,OLD.kind,OLD.created_at) OR (OLD.read_at IS NOT NULL AND NEW.read_at IS DISTINCT FROM OLD.read_at) OR NEW.read_at IS NULL THEN RAISE EXCEPTION 'Errand notice identity is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER errand_notice_immutable BEFORE UPDATE OR DELETE ON whaleu_notifications.errand_notices FOR EACH ROW EXECUTE FUNCTION whaleu_notifications.freeze_errand_notice();
CREATE FUNCTION whaleu_notifications.validate_errand_notice() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE transition whaleu_errands.transitions; publisher uuid; accepter uuid;
BEGIN
 SELECT * INTO transition FROM whaleu_errands.transitions WHERE id=NEW.transition_id;
 SELECT publisher_id,accepter_id INTO publisher,accepter FROM whaleu_errands.orders WHERE id=NEW.order_id;
 IF transition.id IS NULL OR transition.order_id<>NEW.order_id OR transition.operation IS DISTINCT FROM (CASE NEW.kind WHEN 'accepted' THEN 'accept' ELSE 'complete' END) OR NEW.recipient_account_id IS DISTINCT FROM (CASE NEW.kind WHEN 'accepted' THEN publisher ELSE accepter END) THEN RAISE EXCEPTION 'Errand notice must match its transition and recipient'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER errand_notice_causal BEFORE INSERT ON whaleu_notifications.errand_notices FOR EACH ROW EXECUTE FUNCTION whaleu_notifications.validate_errand_notice();
CREATE FUNCTION whaleu_errands.require_transition_effects() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.operation IN ('accept','complete') AND NOT EXISTS(SELECT 1 FROM whaleu_notifications.errand_notices n WHERE n.transition_id=NEW.id AND n.kind=CASE NEW.operation WHEN 'accept' THEN 'accepted' ELSE 'completed' END) THEN RAISE EXCEPTION 'Durable local errand notice required'; END IF;
 IF NEW.operation='accept' AND NOT EXISTS(SELECT 1 FROM whaleu_errands.contact_history h WHERE h.transition_id=NEW.id AND h.account_id=NEW.actor_id) THEN RAISE EXCEPTION 'Successful errand contact history required'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER errand_transition_effects_required AFTER INSERT ON whaleu_errands.transitions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_errands.require_transition_effects();
-- Match every bounded discovery filter before the keyset range, including
-- foreign-own and pending-only scans (not merely a bounded JavaScript loop).
CREATE INDEX errand_pending_created ON whaleu_errands.orders(target_region_id,created_at,id) WHERE deleted_at IS NULL AND state='pending';
CREATE INDEX errand_pending_reward ON whaleu_errands.orders(target_region_id,reward,created_at,id) WHERE deleted_at IS NULL AND state='pending';
CREATE INDEX errand_own_region_created ON whaleu_errands.orders(publisher_id,target_region_id,created_at,id) WHERE deleted_at IS NULL AND state IN ('pending','accepted');
CREATE INDEX errand_own_region_reward ON whaleu_errands.orders(publisher_id,target_region_id,reward,created_at,id) WHERE deleted_at IS NULL AND state IN ('pending','accepted');
CREATE INDEX errand_own_pending_created ON whaleu_errands.orders(publisher_id,target_region_id,created_at,id) WHERE deleted_at IS NULL AND state='pending';
CREATE INDEX errand_own_pending_reward ON whaleu_errands.orders(publisher_id,target_region_id,reward,created_at,id) WHERE deleted_at IS NULL AND state='pending';
CREATE FUNCTION whaleu_errands.validate_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_order whaleu_errands.orders;
BEGIN
 SELECT * INTO current_order FROM whaleu_errands.orders WHERE id=NEW.order_id FOR SHARE;
 IF current_order.id IS NULL OR current_order.revision<>NEW.revision OR current_order.state<>NEW.next_state THEN RAISE EXCEPTION 'Errand transition must match current order revision and state'; END IF;
 IF NEW.operation='publish' THEN
  IF NEW.actor_id<>current_order.publisher_id OR NEW.prior_state IS NOT NULL OR NEW.next_state<>'pending' OR current_order.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'Invalid publish transition'; END IF;
 ELSIF NEW.operation='accept' THEN
  IF NEW.actor_id IS DISTINCT FROM current_order.accepter_id OR NEW.prior_state IS DISTINCT FROM 'pending' OR NEW.next_state<>'accepted' OR current_order.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'Invalid accept transition'; END IF;
 ELSIF NEW.operation='complete' THEN
  IF NEW.actor_id<>current_order.publisher_id OR NEW.prior_state IS DISTINCT FROM 'accepted' OR NEW.next_state<>'completed' OR current_order.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'Invalid complete transition'; END IF;
 ELSIF NEW.operation='cancel' THEN
  IF NEW.actor_id<>current_order.publisher_id OR coalesce(NEW.prior_state,'') NOT IN ('pending','accepted') OR NEW.next_state<>'cancelled' OR current_order.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'Invalid cancel transition'; END IF;
 ELSE
  IF NEW.actor_id<>current_order.publisher_id OR NEW.prior_state IS DISTINCT FROM NEW.next_state OR current_order.deleted_at IS NULL THEN RAISE EXCEPTION 'Invalid delete transition'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER errand_transition_causal BEFORE INSERT ON whaleu_errands.transitions FOR EACH ROW EXECUTE FUNCTION whaleu_errands.validate_transition();
CREATE FUNCTION whaleu_errands.validate_contact_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM whaleu_errands.transitions t JOIN whaleu_errands.private_details p ON p.order_id=t.order_id WHERE t.id=NEW.transition_id AND t.operation='accept' AND t.actor_id=NEW.account_id AND p.accepter_contacts=NEW.contacts) THEN RAISE EXCEPTION 'Errand contact history must match accepted transition'; END IF;
 IF TG_OP='UPDATE' AND NEW.account_id<>OLD.account_id THEN RAISE EXCEPTION 'Errand contact history owner is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER errand_contact_history_causal BEFORE INSERT OR UPDATE ON whaleu_errands.contact_history FOR EACH ROW EXECUTE FUNCTION whaleu_errands.validate_contact_history();
ALTER TABLE whaleu_errands.orders ADD CHECK(accepted_at IS NULL OR accepted_at>=created_at);
ALTER TABLE whaleu_errands.orders ADD CHECK(completed_at IS NULL OR completed_at>=accepted_at);
ALTER TABLE whaleu_errands.orders ADD CHECK(cancelled_at IS NULL OR cancelled_at>=coalesce(accepted_at,created_at));
ALTER TABLE whaleu_errands.orders ADD CHECK(deleted_at IS NULL OR deleted_at>=coalesce(completed_at,cancelled_at,accepted_at,created_at));
ALTER TABLE whaleu_errands.transitions ADD CHECK(isfinite(occurred_at));
ALTER TABLE whaleu_notifications.errand_notices ADD CHECK(isfinite(created_at) AND (read_at IS NULL OR (isfinite(read_at) AND read_at>=created_at)));
