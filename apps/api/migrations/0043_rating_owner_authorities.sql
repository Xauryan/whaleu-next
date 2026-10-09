-- Empty rating-purpose authority sidecars; no real issuer, provider, policy,
-- enrollment, grant or content approval is seeded. The epoch is retained
-- mutation metadata, never evidence of approval or base entitlement.
CREATE TABLE whaleu_verification.rating_base_assertions (
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
CREATE TABLE whaleu_verification.rating_base_heads (
 account_id uuid PRIMARY KEY REFERENCES whaleu_identity.accounts(id), assertion_id uuid NOT NULL,
 FOREIGN KEY(assertion_id,account_id) REFERENCES whaleu_verification.rating_base_assertions(id,account_id)
);
CREATE TRIGGER rating_base_immutable BEFORE UPDATE OR DELETE ON whaleu_verification.rating_base_assertions FOR EACH ROW EXECUTE FUNCTION whaleu_verification.immutable_record();
CREATE FUNCTION whaleu_verification.rating_base_head_causal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_time timestamptz; new_time timestamptz;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Rating base heads are durable' USING ERRCODE='23514'; END IF;
 IF NEW.account_id IS DISTINCT FROM OLD.account_id THEN RAISE EXCEPTION 'Rating base owner is immutable' USING ERRCODE='23514'; END IF;
 SELECT effective_at INTO old_time FROM whaleu_verification.rating_base_assertions WHERE id=OLD.assertion_id;
 SELECT effective_at INTO new_time FROM whaleu_verification.rating_base_assertions WHERE id=NEW.assertion_id;
 IF new_time IS NULL OR new_time<=old_time THEN RAISE EXCEPTION 'Rating base head must advance causally' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER rating_base_head_causal BEFORE UPDATE OR DELETE ON whaleu_verification.rating_base_heads FOR EACH ROW EXECUTE FUNCTION whaleu_verification.rating_base_head_causal();
CREATE TRIGGER rating_base_assertion_writer BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_verification.rating_base_assertions FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.content_policy_writer_gate();
CREATE TRIGGER rating_base_head_writer BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_verification.rating_base_heads FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.content_policy_writer_gate();
CREATE TABLE whaleu_community.rating_approval_decisions (
  id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
  operation text NOT NULL CHECK(operation IN ('publish_rating_target','publish_rating_comment')),
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
    jsonb_typeof(envelope->'scope')='object' AND envelope->'assetIds'='[]'::jsonb,false)),
  CHECK(digest=encode(sha256(convert_to('whaleu-rating-content-approval:v1'||chr(10)||whaleu_community.content_canonical_json(envelope),'UTF8')),'hex')),
  UNIQUE(id,account_id,operation,envelope_version,digest)
);
CREATE INDEX rating_approval_exact_intent ON whaleu_community.rating_approval_decisions(account_id,operation,envelope_version,digest,evaluated_at DESC,id DESC);
CREATE TABLE whaleu_community.rating_approval_events (
  id uuid PRIMARY KEY, decision_id uuid NOT NULL REFERENCES whaleu_community.rating_approval_decisions(id),
  sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  state text NOT NULL CHECK(state IN ('allow','held','revoked')),
  coverage text NOT NULL CHECK(coverage IN ('complete','missing','conflicting')),
  provenance text NOT NULL CHECK(provenance IN ('accepted','unreconciled','rejected')),
  issuer text NOT NULL CHECK(length(btrim(issuer))>0), provenance_ref text NOT NULL CHECK(length(btrim(provenance_ref))>0),
  occurred_at timestamptz NOT NULL CHECK(isfinite(occurred_at)),
  UNIQUE(id,decision_id)
);
CREATE TABLE whaleu_community.rating_approval_heads (
  decision_id uuid PRIMARY KEY REFERENCES whaleu_community.rating_approval_decisions(id),
  event_id uuid NOT NULL UNIQUE,
  FOREIGN KEY(event_id,decision_id) REFERENCES whaleu_community.rating_approval_events(id,decision_id)
);
-- This is the review-owned immutable definition/binding. It never replaces the
-- rating owner's independently supplied current immutable row definition.
CREATE TABLE whaleu_community.rating_approval_bindings (
  kind text NOT NULL CHECK(kind IN ('target','comment')), subject_id uuid NOT NULL, content_version integer NOT NULL CHECK(content_version=1),
  decision_id uuid NOT NULL UNIQUE,
  account_id uuid NOT NULL, operation text NOT NULL CHECK(operation IN ('publish_rating_target','publish_rating_comment')),
  envelope_version integer NOT NULL CHECK(envelope_version=1),
  digest text NOT NULL, envelope jsonb NOT NULL, scope jsonb NOT NULL,
  bound_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  publication_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
  FOREIGN KEY(decision_id,account_id,operation,envelope_version,digest)
    REFERENCES whaleu_community.rating_approval_decisions(id,account_id,operation,envelope_version,digest),
  PRIMARY KEY(kind,subject_id),
  UNIQUE(kind,subject_id,publication_transaction),
  CHECK((kind='target' AND operation='publish_rating_target') OR (kind='comment' AND operation='publish_rating_comment')),
  CHECK(scope=envelope->'scope')
);
CREATE TRIGGER rating_review_decision_writer_gate BEFORE INSERT OR UPDATE OR DELETE ON whaleu_community.rating_approval_decisions
 FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.content_policy_writer_gate();
CREATE TRIGGER rating_review_event_writer_gate BEFORE INSERT OR UPDATE OR DELETE ON whaleu_community.rating_approval_events
 FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.content_policy_writer_gate();
CREATE TRIGGER rating_review_head_writer_gate BEFORE INSERT OR UPDATE OR DELETE ON whaleu_community.rating_approval_heads
 FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.content_policy_writer_gate();
CREATE TRIGGER rating_review_decision_immutable BEFORE UPDATE OR DELETE ON whaleu_community.rating_approval_decisions
 FOR EACH ROW EXECUTE FUNCTION whaleu_community.content_approval_immutable();
CREATE TRIGGER rating_review_event_immutable BEFORE UPDATE OR DELETE ON whaleu_community.rating_approval_events
 FOR EACH ROW EXECUTE FUNCTION whaleu_community.content_approval_immutable();
CREATE TRIGGER rating_review_binding_immutable BEFORE UPDATE OR DELETE ON whaleu_community.rating_approval_bindings
 FOR EACH ROW EXECUTE FUNCTION whaleu_community.content_approval_immutable();
CREATE TRIGGER rating_review_decision_anchor BEFORE INSERT ON whaleu_community.rating_approval_decisions
 FOR EACH ROW EXECUTE FUNCTION whaleu_community.content_decision_anchor();
CREATE FUNCTION whaleu_community.rating_review_head_validate() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actor uuid; next_event whaleu_community.rating_approval_events; old_sequence bigint; decision_time timestamptz;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Rating review head cannot be deleted' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' AND OLD.decision_id<>NEW.decision_id THEN RAISE EXCEPTION 'Rating review identity is immutable' USING ERRCODE='23514'; END IF;
 SELECT account_id,evaluated_at INTO actor,decision_time FROM whaleu_community.rating_approval_decisions WHERE id=NEW.decision_id;
 PERFORM id FROM whaleu_identity.accounts WHERE id=actor FOR UPDATE;
 SELECT * INTO next_event FROM whaleu_community.rating_approval_events WHERE id=NEW.event_id AND decision_id=NEW.decision_id;
 IF NOT FOUND OR next_event.occurred_at<decision_time THEN RAISE EXCEPTION 'Rating review event is invalid' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' THEN
  SELECT sequence INTO old_sequence FROM whaleu_community.rating_approval_events WHERE id=OLD.event_id;
  IF next_event.sequence<=old_sequence THEN RAISE EXCEPTION 'Rating review head cannot rewind' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER rating_review_head_validate BEFORE INSERT OR UPDATE OR DELETE ON whaleu_community.rating_approval_heads
 FOR EACH ROW EXECUTE FUNCTION whaleu_community.rating_review_head_validate();
CREATE FUNCTION whaleu_community.rating_review_binding_validate() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE decision whaleu_community.rating_approval_decisions; instant timestamptz; accepted boolean;
BEGIN
 SELECT * INTO decision FROM whaleu_community.rating_approval_decisions WHERE id=NEW.decision_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Rating binding decision is absent' USING ERRCODE='23514'; END IF;
 -- Consumption retains the actor anchor, but never upgrades the common gate.
 PERFORM id FROM whaleu_identity.accounts WHERE id=decision.account_id FOR SHARE;
 PERFORM decision_id FROM whaleu_community.rating_approval_heads WHERE decision_id=decision.id FOR SHARE;
 instant:=clock_timestamp();
 SELECT coalesce(d.result='allow' AND d.coverage='complete' AND d.provenance='accepted' AND
   p.policy_key='local-explicit-v1' AND p.version=1 AND p.coverage='complete' AND p.provenance='accepted' AND
   h.event_id=e.id AND e.state='allow' AND e.coverage='complete' AND e.provenance='accepted' AND
   isfinite(d.evaluated_at) AND d.evaluated_at<=instant AND p.valid_from<=d.evaluated_at AND
   (p.valid_until IS NULL OR p.valid_until>instant) AND e.occurred_at>=d.evaluated_at AND e.occurred_at<=instant AND
   d.consume_until>instant AND (d.visibility_model='durable' OR d.visibility_until>instant),false)
 INTO accepted FROM whaleu_community.rating_approval_decisions d
 JOIN whaleu_community.content_approval_policies p ON p.id=d.policy_revision_id
 JOIN whaleu_community.rating_approval_heads h ON h.decision_id=d.id
 JOIN whaleu_community.rating_approval_events e ON e.id=h.event_id AND e.decision_id=d.id
 WHERE d.id=decision.id;
 IF NOT coalesce(accepted,false) OR decision.envelope IS DISTINCT FROM NEW.envelope OR
   (NEW.kind='target' AND NEW.envelope->>'targetId' IS DISTINCT FROM NEW.subject_id::text) OR
   NEW.publication_transaction IS DISTINCT FROM pg_current_xact_id() OR
   NOT isfinite(NEW.bound_at) OR NEW.bound_at>instant OR NEW.bound_at<decision.evaluated_at THEN
  RAISE EXCEPTION 'Rating binding evidence mismatch' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER rating_review_binding_validate BEFORE INSERT ON whaleu_community.rating_approval_bindings
 FOR EACH ROW EXECUTE FUNCTION whaleu_community.rating_review_binding_validate();

-- A single small epoch suffices because these authority writers already use the
-- common exclusive policy gate. Publication binding never upgrades that gate:
-- immutable same-publication causality belongs to 0044; independent exact
-- binding final proofs include both observed presence and observed absence.
CREATE TABLE whaleu_community.rating_review_epoch (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 version integer NOT NULL CHECK(version=1), epoch bigint NOT NULL CHECK(epoch>=0)
);
INSERT INTO whaleu_community.rating_review_epoch(singleton,version,epoch) VALUES(true,1,0);
CREATE FUNCTION whaleu_community.guard_rating_review_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'UPDATE' THEN RAISE EXCEPTION 'Rating review epoch is retained' USING ERRCODE='23514'; END IF;
 IF pg_trigger_depth()<2 OR NEW.singleton IS DISTINCT FROM OLD.singleton OR NEW.version IS DISTINCT FROM OLD.version OR NEW.epoch IS DISTINCT FROM OLD.epoch+1 THEN RAISE EXCEPTION 'Rating review epoch only advances from authority mutations' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER rating_review_epoch_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_community.rating_review_epoch FOR EACH ROW EXECUTE FUNCTION whaleu_community.guard_rating_review_epoch();
CREATE TRIGGER rating_review_epoch_retain BEFORE TRUNCATE ON whaleu_community.rating_review_epoch FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.guard_rating_review_epoch();
CREATE FUNCTION whaleu_community.advance_rating_review_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('whaleu:named-block-policy:v1',0));
 UPDATE whaleu_community.rating_review_epoch SET epoch=epoch+1 WHERE singleton;
 IF NOT FOUND THEN RAISE EXCEPTION 'Rating review epoch is absent' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER a0_rating_review_epoch BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_community.rating_approval_decisions FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.advance_rating_review_epoch();
CREATE TRIGGER a0_rating_review_epoch BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_community.rating_approval_events FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.advance_rating_review_epoch();
CREATE TRIGGER a0_rating_review_epoch BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_community.rating_approval_heads FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.advance_rating_review_epoch();
CREATE TRIGGER a0_rating_review_epoch BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_community.content_approval_policies FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.advance_rating_review_epoch();

-- Strict discriminants and references are validated even on raw sidecar writes.
-- Runtime reads independently canonicalize the entire envelope before granting.
CREATE FUNCTION whaleu_community.rating_envelope_shape(e jsonb,op text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT coalesce(
  jsonb_typeof(e)='object' AND e->'version'='1'::jsonb AND e->>'purpose'=op AND
  e->'assetIds'='[]'::jsonb AND jsonb_typeof(e->'scope')='object' AND ((e->'scope')-'regionId')='{}'::jsonb AND
  (e->'scope'->'regionId'='null'::jsonb OR (jsonb_typeof(e->'scope'->'regionId')='string' AND e->'scope'->>'regionId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')) AND
  NOT EXISTS(SELECT 1 FROM unnest(ARRAY['accountId','clientRequestId','targetId','targetRevision','categoryId','categoryRevision','catalogRevision']) k WHERE jsonb_typeof(e->k) IS DISTINCT FROM 'string' OR NOT coalesce(e->>k ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',false)) AND
  CASE WHEN op='publish_rating_target' THEN
    (e-ARRAY['version','accountId','purpose','clientRequestId','targetId','targetRevision','categoryId','categoryRevision','catalogRevision','scope','assetIds','name','description'])='{}'::jsonb AND
    jsonb_typeof(e->'name')='string' AND length(e->>'name') BETWEEN 1 AND 100 AND jsonb_typeof(e->'description')='string' AND length(e->>'description')<=500
  WHEN op='publish_rating_comment' THEN
    (e-ARRAY['version','accountId','purpose','clientRequestId','targetId','targetRevision','categoryId','categoryRevision','catalogRevision','scope','assetIds','authorMode','body'])='{}'::jsonb AND
    e->>'authorMode' IN ('named','anonymous') AND jsonb_typeof(e->'body')='string' AND length(e->>'body') BETWEEN 1 AND 500
  ELSE false END,false)
$$;
ALTER TABLE whaleu_community.rating_approval_decisions ADD CHECK(whaleu_community.rating_envelope_shape(envelope,operation));
ALTER TABLE whaleu_community.rating_approval_bindings ADD CHECK(whaleu_community.rating_envelope_shape(envelope,operation));

-- TRUNCATE cannot bypass immutable evidence or same-publication constraints.
CREATE TRIGGER rating_review_binding_retain BEFORE TRUNCATE ON whaleu_community.rating_approval_bindings FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.content_approval_immutable();
CREATE TRIGGER rating_review_decision_retain BEFORE TRUNCATE ON whaleu_community.rating_approval_decisions FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.content_approval_immutable();
CREATE TRIGGER rating_review_event_retain BEFORE TRUNCATE ON whaleu_community.rating_approval_events FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.content_approval_immutable();
CREATE TRIGGER rating_review_head_retain BEFORE TRUNCATE ON whaleu_community.rating_approval_heads FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.content_approval_immutable();
CREATE TRIGGER rating_base_assertion_retain BEFORE TRUNCATE ON whaleu_verification.rating_base_assertions FOR EACH STATEMENT EXECUTE FUNCTION whaleu_verification.immutable_record();
CREATE TRIGGER rating_base_head_retain BEFORE TRUNCATE ON whaleu_verification.rating_base_heads FOR EACH STATEMENT EXECUTE FUNCTION whaleu_verification.immutable_record();
