-- PM0–PM2 purpose-specific authority. Empty issuer registries are intentionally unavailable.
SET LOCAL lock_timeout='5s';
SELECT pg_advisory_xact_lock(hashtextextended('whaleu:named-block-policy:v1',0));
-- DM temporary admission: no issuer or assertion is seeded. Canonical verified
-- affiliation remains independently sufficient. This source cannot grant phone.
CREATE TABLE whaleu_verification.dm_issuers (
 issuer text NOT NULL CHECK(length(btrim(issuer))>0),
 policy_reference text NOT NULL CHECK(length(btrim(policy_reference))>0),
 purpose text NOT NULL CHECK(purpose='private_messages'), active boolean NOT NULL,
 coverage text NOT NULL CHECK(coverage IN ('complete','missing','conflicting')),
 provenance text NOT NULL CHECK(provenance IN ('accepted','unknown','conflicting')),
 source_reference text NOT NULL CHECK(length(btrim(source_reference))>0),
 valid_from timestamptz NOT NULL CHECK(isfinite(valid_from)),
 valid_until timestamptz CHECK(valid_until IS NULL OR (isfinite(valid_until) AND valid_until>valid_from)),
 PRIMARY KEY(issuer,policy_reference)
);
CREATE TABLE whaleu_verification.dm_base_assertions (
 id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
 purpose text NOT NULL CHECK(purpose='private_messages'),
 state text NOT NULL CHECK(state IN ('verified','unverified','revoked')),
 coverage text NOT NULL CHECK(coverage IN ('complete','missing','conflicting')),
 provenance text NOT NULL CHECK(provenance IN ('accepted','unknown','conflicting')),
 issuer text NOT NULL CHECK(length(btrim(issuer))>0), source_reference text NOT NULL CHECK(length(btrim(source_reference))>0),
 policy_reference text NOT NULL CHECK(length(btrim(policy_reference))>0),
 effective_at timestamptz NOT NULL CHECK(isfinite(effective_at)),
 valid_until timestamptz NOT NULL CHECK(isfinite(valid_until) AND valid_until>effective_at),
 UNIQUE(id,account_id)
);
CREATE TABLE whaleu_verification.dm_base_heads (
 account_id uuid PRIMARY KEY REFERENCES whaleu_identity.accounts(id), assertion_id uuid NOT NULL,
 FOREIGN KEY(assertion_id,account_id) REFERENCES whaleu_verification.dm_base_assertions(id,account_id)
);
CREATE TRIGGER dm_base_immutable BEFORE UPDATE OR DELETE ON whaleu_verification.dm_base_assertions FOR EACH ROW EXECUTE FUNCTION whaleu_verification.immutable_record();
CREATE FUNCTION whaleu_verification.dm_base_head_causal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_time timestamptz; new_time timestamptz;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'DM base heads are durable' USING ERRCODE='23514'; END IF;
 IF NEW.account_id IS DISTINCT FROM OLD.account_id THEN RAISE EXCEPTION 'DM base owner is immutable' USING ERRCODE='23514'; END IF;
 SELECT effective_at INTO old_time FROM whaleu_verification.dm_base_assertions WHERE id=OLD.assertion_id;
 SELECT effective_at INTO new_time FROM whaleu_verification.dm_base_assertions WHERE id=NEW.assertion_id;
 IF new_time IS NULL OR new_time<=old_time THEN RAISE EXCEPTION 'DM base head must advance causally' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER dm_base_head_causal BEFORE UPDATE OR DELETE ON whaleu_verification.dm_base_heads FOR EACH ROW EXECUTE FUNCTION whaleu_verification.dm_base_head_causal();
CREATE TRIGGER dm_base_assertion_writer BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_verification.dm_base_assertions FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.content_policy_writer_gate();
CREATE TRIGGER dm_base_head_writer BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_verification.dm_base_heads FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.content_policy_writer_gate();
CREATE TRIGGER dm_issuer_writer BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_verification.dm_issuers FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.content_policy_writer_gate();
CREATE TRIGGER dm_base_assertion_retain BEFORE TRUNCATE ON whaleu_verification.dm_base_assertions FOR EACH STATEMENT EXECUTE FUNCTION whaleu_verification.immutable_record();
CREATE TRIGGER dm_base_head_retain BEFORE TRUNCATE ON whaleu_verification.dm_base_heads FOR EACH STATEMENT EXECUTE FUNCTION whaleu_verification.immutable_record();
-- Exact private text Review owner. Issuer registry is empty on migration.
CREATE TABLE whaleu_community.dm_review_issuers (
 issuer text NOT NULL CHECK(length(btrim(issuer))>0),policy_revision_id uuid NOT NULL REFERENCES whaleu_community.content_approval_policies(id),
 purpose text NOT NULL CHECK(purpose='send_private_message'),active boolean NOT NULL,
 coverage text NOT NULL CHECK(coverage IN ('complete','missing','conflicting')),
 provenance text NOT NULL CHECK(provenance IN ('accepted','unknown','conflicting')),
 source_reference text NOT NULL CHECK(length(btrim(source_reference))>0),
 valid_from timestamptz NOT NULL CHECK(isfinite(valid_from)),valid_until timestamptz CHECK(valid_until IS NULL OR (isfinite(valid_until) AND valid_until>valid_from)),
 PRIMARY KEY(issuer,policy_revision_id)
);
CREATE FUNCTION whaleu_community.dm_envelope_shape(e jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT coalesce(jsonb_typeof(e)='object' AND (e-ARRAY['version','purpose','accountId','clientRequestId','conversationId','contextDigest','senderSlot','participantModes','text','assetIds'])='{}'::jsonb
 AND e->'version'='1'::jsonb AND e->>'purpose'='send_private_message' AND e->'assetIds'='[]'::jsonb
 AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['accountId','clientRequestId','conversationId']) k WHERE jsonb_typeof(e->k) IS DISTINCT FROM 'string' OR NOT coalesce(e->>k ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',false))
 AND e->>'clientRequestId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
 AND jsonb_typeof(e->'contextDigest')='string' AND e->>'contextDigest' ~ '^[a-f0-9]{64}$'
 AND e->'senderSlot' IN ('0'::jsonb,'1'::jsonb) AND CASE WHEN jsonb_typeof(e->'participantModes')='array' THEN jsonb_array_length(e->'participantModes')=2 ELSE false END
 AND e->'participantModes'->>0 IN ('named','anonymous') AND e->'participantModes'->>1 IN ('named','anonymous')
 AND jsonb_typeof(e->'text')='string' AND length(e->>'text') BETWEEN 1 AND 500 AND octet_length(e->>'text')<=2000 AND length(btrim(e->>'text',chr(9)||chr(10)||chr(32)||chr(160)||chr(5760)||chr(8192)||chr(8193)||chr(8194)||chr(8195)||chr(8196)||chr(8197)||chr(8198)||chr(8199)||chr(8200)||chr(8201)||chr(8202)||chr(8232)||chr(8233)||chr(8239)||chr(8287)||chr(12288)||chr(65279)))>0
 AND NOT EXISTS(SELECT 1 FROM generate_series(1,length(e->>'text')) n WHERE ascii(substr(e->>'text',n,1))<32 AND ascii(substr(e->>'text',n,1)) NOT IN (9,10) OR ascii(substr(e->>'text',n,1)) BETWEEN 127 AND 159),false)
$$;
CREATE TABLE whaleu_community.dm_approval_decisions (
 id uuid PRIMARY KEY,account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
 operation text NOT NULL CHECK(operation='send_private_message'),envelope_version integer NOT NULL CHECK(envelope_version=1),
 digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),envelope jsonb NOT NULL CHECK(whaleu_community.dm_envelope_shape(envelope)),
 policy_revision_id uuid NOT NULL REFERENCES whaleu_community.content_approval_policies(id),
 result text NOT NULL CHECK(result IN ('allow','reject','pending','failed')),
 coverage text NOT NULL CHECK(coverage IN ('complete','missing','conflicting')),provenance text NOT NULL CHECK(provenance IN ('accepted','unreconciled','rejected')),
 issuer text NOT NULL CHECK(length(btrim(issuer))>0),provenance_ref text NOT NULL CHECK(length(btrim(provenance_ref))>0),
 evaluated_at timestamptz NOT NULL CHECK(isfinite(evaluated_at)),consume_until timestamptz NOT NULL CHECK(isfinite(consume_until) AND consume_until>evaluated_at),
 visibility_model text NOT NULL CHECK(visibility_model IN ('durable','until')),visibility_until timestamptz CHECK(visibility_until IS NULL OR (isfinite(visibility_until) AND visibility_until>evaluated_at)),
 CHECK((visibility_model='durable' AND visibility_until IS NULL) OR (visibility_model='until' AND visibility_until IS NOT NULL)),
 CHECK(envelope->>'accountId'=account_id::text AND envelope->>'purpose'=operation AND envelope->>'version'=envelope_version::text),
 CHECK(digest=encode(sha256(convert_to('whaleu-dm-content-approval:v1'||chr(10)||whaleu_community.content_canonical_json(envelope),'UTF8')),'hex')),
 UNIQUE(id,account_id,operation,envelope_version,digest)
);
CREATE INDEX dm_approval_exact_intent ON whaleu_community.dm_approval_decisions(account_id,operation,envelope_version,digest,evaluated_at DESC,id DESC);
CREATE TABLE whaleu_community.dm_approval_events (
 id uuid PRIMARY KEY,decision_id uuid NOT NULL REFERENCES whaleu_community.dm_approval_decisions(id),sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
 state text NOT NULL CHECK(state IN ('allow','held','revoked')),coverage text NOT NULL CHECK(coverage IN ('complete','missing','conflicting')),
 provenance text NOT NULL CHECK(provenance IN ('accepted','unreconciled','rejected')),issuer text NOT NULL CHECK(length(btrim(issuer))>0),provenance_ref text NOT NULL CHECK(length(btrim(provenance_ref))>0),
 occurred_at timestamptz NOT NULL CHECK(isfinite(occurred_at)),UNIQUE(id,decision_id)
);
CREATE TABLE whaleu_community.dm_approval_heads (
 decision_id uuid PRIMARY KEY REFERENCES whaleu_community.dm_approval_decisions(id),event_id uuid NOT NULL UNIQUE,
 FOREIGN KEY(event_id,decision_id) REFERENCES whaleu_community.dm_approval_events(id,decision_id)
);
CREATE TABLE whaleu_community.dm_approval_bindings (
 message_id uuid PRIMARY KEY,conversation_id uuid NOT NULL,sender_slot smallint NOT NULL CHECK(sender_slot IN (0,1)),message_seq bigint NOT NULL CHECK(message_seq>0),
 content_version integer NOT NULL CHECK(content_version=1),decision_id uuid NOT NULL UNIQUE,account_id uuid NOT NULL,
 operation text NOT NULL CHECK(operation='send_private_message'),envelope_version integer NOT NULL CHECK(envelope_version=1),digest text NOT NULL,envelope jsonb NOT NULL CHECK(whaleu_community.dm_envelope_shape(envelope)),
 bound_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(bound_at)),publication_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 FOREIGN KEY(decision_id,account_id,operation,envelope_version,digest) REFERENCES whaleu_community.dm_approval_decisions(id,account_id,operation,envelope_version,digest),
 FOREIGN KEY(message_id,conversation_id) REFERENCES whaleu_messaging.messages(id,conversation_id) DEFERRABLE INITIALLY DEFERRED,
 CHECK(envelope->>'conversationId'=conversation_id::text AND envelope->>'accountId'=account_id::text AND envelope->>'senderSlot'=sender_slot::text)
);
CREATE TRIGGER dm_review_decision_immutable BEFORE UPDATE OR DELETE ON whaleu_community.dm_approval_decisions FOR EACH ROW EXECUTE FUNCTION whaleu_community.content_approval_immutable();
CREATE TRIGGER dm_review_event_immutable BEFORE UPDATE OR DELETE ON whaleu_community.dm_approval_events FOR EACH ROW EXECUTE FUNCTION whaleu_community.content_approval_immutable();
CREATE TRIGGER dm_review_binding_immutable BEFORE UPDATE OR DELETE ON whaleu_community.dm_approval_bindings FOR EACH ROW EXECUTE FUNCTION whaleu_community.content_approval_immutable();
CREATE TRIGGER dm_review_decision_retain BEFORE TRUNCATE ON whaleu_community.dm_approval_decisions FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.content_approval_immutable();
CREATE TRIGGER dm_review_event_retain BEFORE TRUNCATE ON whaleu_community.dm_approval_events FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.content_approval_immutable();
CREATE TRIGGER dm_review_binding_retain BEFORE TRUNCATE ON whaleu_community.dm_approval_bindings FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.content_approval_immutable();
CREATE TRIGGER dm_review_head_retain BEFORE TRUNCATE ON whaleu_community.dm_approval_heads FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.content_approval_immutable();
CREATE TRIGGER dm_review_decision_anchor BEFORE INSERT ON whaleu_community.dm_approval_decisions FOR EACH ROW EXECUTE FUNCTION whaleu_community.content_decision_anchor();
CREATE FUNCTION whaleu_community.dm_review_head_validate() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actor uuid; next_event whaleu_community.dm_approval_events; old_sequence bigint; decision_time timestamptz;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'DM review head cannot be deleted' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' AND OLD.decision_id<>NEW.decision_id THEN RAISE EXCEPTION 'DM review identity is immutable' USING ERRCODE='23514'; END IF;
 SELECT account_id,evaluated_at INTO actor,decision_time FROM whaleu_community.dm_approval_decisions WHERE id=NEW.decision_id;
 PERFORM id FROM whaleu_identity.accounts WHERE id=actor FOR UPDATE;
 SELECT * INTO next_event FROM whaleu_community.dm_approval_events WHERE id=NEW.event_id AND decision_id=NEW.decision_id;
 IF NOT FOUND OR next_event.occurred_at<decision_time THEN RAISE EXCEPTION 'DM review event is invalid' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' THEN SELECT sequence INTO old_sequence FROM whaleu_community.dm_approval_events WHERE id=OLD.event_id;
  IF next_event.sequence<=old_sequence THEN RAISE EXCEPTION 'DM review head cannot rewind' USING ERRCODE='23514'; END IF;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER dm_review_head_validate BEFORE INSERT OR UPDATE OR DELETE ON whaleu_community.dm_approval_heads FOR EACH ROW EXECUTE FUNCTION whaleu_community.dm_review_head_validate();
CREATE FUNCTION whaleu_community.dm_review_binding_validate() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE decision whaleu_community.dm_approval_decisions; instant timestamptz; accepted boolean;
BEGIN
 SELECT * INTO decision FROM whaleu_community.dm_approval_decisions WHERE id=NEW.decision_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'DM binding decision is absent' USING ERRCODE='23514'; END IF;
 PERFORM id FROM whaleu_identity.accounts WHERE id=decision.account_id FOR SHARE;
 PERFORM decision_id FROM whaleu_community.dm_approval_heads WHERE decision_id=decision.id FOR SHARE;instant:=clock_timestamp();
 SELECT coalesce(d.result='allow' AND d.coverage='complete' AND d.provenance='accepted' AND p.policy_key='local-explicit-v1' AND p.version=1 AND p.coverage='complete' AND p.provenance='accepted' AND
 e.state='allow' AND e.coverage='complete' AND e.provenance='accepted' AND e.issuer=d.issuer AND
 i.active AND i.coverage='complete' AND i.provenance='accepted' AND i.purpose='send_private_message' AND i.valid_from<=d.evaluated_at AND (i.valid_until IS NULL OR i.valid_until>instant) AND
 d.evaluated_at<=instant AND p.valid_from<=d.evaluated_at AND (p.valid_until IS NULL OR p.valid_until>instant) AND e.occurred_at>=d.evaluated_at AND e.occurred_at<=instant AND d.consume_until>instant AND (d.visibility_model='durable' OR d.visibility_until>instant),false)
 INTO accepted FROM whaleu_community.dm_approval_decisions d JOIN whaleu_community.content_approval_policies p ON p.id=d.policy_revision_id JOIN whaleu_community.dm_approval_heads h ON h.decision_id=d.id JOIN whaleu_community.dm_approval_events e ON e.id=h.event_id AND e.decision_id=d.id JOIN whaleu_community.dm_review_issuers i ON i.issuer=d.issuer AND i.policy_revision_id=d.policy_revision_id WHERE d.id=decision.id;
 IF NOT coalesce(accepted,false) OR decision.envelope IS DISTINCT FROM NEW.envelope OR NEW.publication_transaction IS DISTINCT FROM pg_current_xact_id() OR NEW.bound_at>instant OR NEW.bound_at<decision.evaluated_at THEN RAISE EXCEPTION 'DM binding evidence mismatch' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER dm_review_binding_validate BEFORE INSERT ON whaleu_community.dm_approval_bindings FOR EACH ROW EXECUTE FUNCTION whaleu_community.dm_review_binding_validate();
CREATE FUNCTION whaleu_community.dm_review_message_causal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE m whaleu_messaging.messages;b whaleu_community.dm_approval_bindings;
BEGIN
 IF TG_TABLE_SCHEMA='whaleu_messaging' THEN SELECT * INTO m FROM whaleu_messaging.messages WHERE id=NEW.id;
 ELSE SELECT * INTO m FROM whaleu_messaging.messages WHERE id=NEW.message_id; END IF;
 SELECT * INTO b FROM whaleu_community.dm_approval_bindings WHERE message_id=m.id;
 IF m.id IS NULL OR b.message_id IS NULL OR b.publication_transaction IS DISTINCT FROM pg_current_xact_id() OR
 ROW(b.conversation_id,b.sender_slot,b.message_seq,b.account_id,b.envelope) IS DISTINCT FROM ROW(m.conversation_id,m.sender_slot,m.message_seq,m.sender_id,m.envelope)
 OR b.envelope->>'text' IS DISTINCT FROM m.body OR b.envelope->>'clientRequestId' IS DISTINCT FROM m.request_id::text
 THEN RAISE EXCEPTION 'DM message has no exact same-transaction Review binding' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER dm_review_message_causal AFTER INSERT ON whaleu_messaging.messages DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community.dm_review_message_causal();
CREATE CONSTRAINT TRIGGER dm_review_binding_causal AFTER INSERT ON whaleu_community.dm_approval_bindings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community.dm_review_message_causal();
CREATE TABLE whaleu_community.dm_review_epoch(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),version integer NOT NULL CHECK(version=1),epoch bigint NOT NULL CHECK(epoch>=0));
-- Mutation metadata is not issuance or an allow grant.
INSERT INTO whaleu_community.dm_review_epoch(singleton,version,epoch) VALUES(true,1,0);
CREATE FUNCTION whaleu_community.guard_dm_review_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'UPDATE' THEN RAISE EXCEPTION 'DM review epoch is retained' USING ERRCODE='23514';END IF;
 IF pg_trigger_depth()<2 OR NEW.singleton IS DISTINCT FROM OLD.singleton OR NEW.version IS DISTINCT FROM OLD.version OR NEW.epoch IS DISTINCT FROM OLD.epoch+1 THEN RAISE EXCEPTION 'DM review epoch only advances from authority mutations' USING ERRCODE='23514'; END IF;RETURN NEW;
END $$;
CREATE TRIGGER dm_review_epoch_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_community.dm_review_epoch FOR EACH ROW EXECUTE FUNCTION whaleu_community.guard_dm_review_epoch();
CREATE TRIGGER dm_review_epoch_retain BEFORE TRUNCATE ON whaleu_community.dm_review_epoch FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.guard_dm_review_epoch();
CREATE FUNCTION whaleu_community.advance_dm_review_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('whaleu:named-block-policy:v1',0));
 UPDATE whaleu_community.dm_review_epoch SET epoch=epoch+1 WHERE singleton;
 IF NOT FOUND THEN RAISE EXCEPTION 'DM review epoch is absent' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE TRIGGER a0_dm_review_epoch BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_community.dm_approval_decisions FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.advance_dm_review_epoch();
CREATE TRIGGER a0_dm_review_epoch BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_community.dm_approval_events FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.advance_dm_review_epoch();
CREATE TRIGGER a0_dm_review_epoch BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_community.dm_approval_heads FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.advance_dm_review_epoch();
CREATE TRIGGER a0_dm_review_epoch BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_community.dm_review_issuers FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.advance_dm_review_epoch();
CREATE TRIGGER a0_dm_review_epoch BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_community.content_approval_policies FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.advance_dm_review_epoch();
