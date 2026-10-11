-- Pending review is separate from the frozen terminal publication receipt.
-- It is a snapshot for explicit local review, never an authorization grant.
SET LOCAL lock_timeout='5s';
SELECT pg_advisory_xact_lock(hashtextextended('whaleu:named-block-policy:v1',0));
ALTER TABLE whaleu_community.publication_requests ADD COLUMN review_submission_transaction xid8;
CREATE TABLE whaleu_community.text_review_requests (
 account_id uuid NOT NULL,
 client_request_id uuid NOT NULL,
 operation text NOT NULL CHECK(operation IN ('publish_post','publish_comment','publish_reply')),
 intent_hash text NOT NULL CHECK(intent_hash ~ '^[a-f0-9]{64}$'),
 envelope jsonb NOT NULL,
 digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),
 decision_id uuid UNIQUE REFERENCES whaleu_community.content_approval_decisions(id),
 created_at timestamptz NOT NULL DEFAULT transaction_timestamp() CHECK(isfinite(created_at)),
 expires_at timestamptz NOT NULL DEFAULT transaction_timestamp()+interval '7 days',
 submission_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 CHECK(expires_at=created_at+interval '7 days'),
 PRIMARY KEY(account_id,client_request_id),
 FOREIGN KEY(account_id,client_request_id) REFERENCES whaleu_community.publication_requests(account_id,client_request_id),
 CHECK(coalesce(jsonb_typeof(envelope)='object' AND envelope->>'accountId'=account_id::text AND envelope->>'purpose'=operation AND envelope->>'version' IN ('1','2'),false)),
 CHECK(coalesce(envelope->>'authorMode'='named' AND envelope->'images'='[]'::jsonb AND envelope->'component'='{"kind":"none"}'::jsonb AND envelope->'trading'='null'::jsonb AND envelope->>'commentsPolicy'='open' AND (envelope->>'version'='1' OR envelope->>'allowAnonymousDm'='false'),false)),
 CHECK(digest=encode(sha256(convert_to('whaleu-content-approval:v'||(envelope->>'version')||chr(10)||whaleu_community.content_canonical_json(envelope),'UTF8')),'hex'))
);
CREATE FUNCTION whaleu_community.text_review_request_validate() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE request whaleu_community.publication_requests; decision whaleu_community.content_approval_decisions;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Review requests are retained' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' AND (OLD.account_id,OLD.client_request_id,OLD.operation,OLD.intent_hash,OLD.envelope,OLD.digest,OLD.created_at,OLD.expires_at,OLD.submission_transaction) IS DISTINCT FROM (NEW.account_id,NEW.client_request_id,NEW.operation,NEW.intent_hash,NEW.envelope,NEW.digest,NEW.created_at,NEW.expires_at,NEW.submission_transaction) THEN
  RAISE EXCEPTION 'Review request snapshot is immutable' USING ERRCODE='23514';
 END IF;
 IF TG_OP='UPDATE' AND OLD.decision_id IS NOT NULL AND NEW.decision_id IS DISTINCT FROM OLD.decision_id THEN
  RAISE EXCEPTION 'Review request decision is immutable' USING ERRCODE='23514';
 END IF;
 SELECT * INTO request FROM whaleu_community.publication_requests WHERE account_id=NEW.account_id AND client_request_id=NEW.client_request_id;
 IF NOT FOUND OR request.operation<>NEW.operation OR request.payload_hash<>NEW.intent_hash THEN
  RAISE EXCEPTION 'Review request ownership mismatch' USING ERRCODE='23514';
 END IF;
 IF TG_OP='INSERT' THEN
  IF request.receipt IS NOT NULL OR request.review_submission_transaction IS DISTINCT FROM pg_current_xact_id() OR NEW.submission_transaction<>pg_current_xact_id() OR NEW.created_at IS DISTINCT FROM transaction_timestamp() OR NEW.decision_id IS NOT NULL THEN
   RAISE EXCEPTION 'Review requires fresh exact submission cause' USING ERRCODE='23514';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('whaleu:text-review-budget:v1:'||NEW.account_id::text,0));
  IF (SELECT count(*) FROM whaleu_community.text_review_requests q JOIN whaleu_community.publication_requests p USING(account_id,client_request_id)
      WHERE q.account_id=NEW.account_id AND p.receipt IS NULL AND q.expires_at>clock_timestamp()
       AND NOT EXISTS(SELECT 1 FROM whaleu_community.publication_cancel_fences f WHERE f.account_id=q.account_id AND f.client_request_id=q.client_request_id))>=32
     OR (SELECT count(*) FROM whaleu_community.text_review_requests WHERE account_id=NEW.account_id AND created_at>=date_trunc('day',clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')>=128 THEN
   RAISE EXCEPTION 'Review submission budget exhausted' USING ERRCODE='23514';
  END IF;
 END IF;
 IF NEW.decision_id IS NOT NULL THEN
  SELECT * INTO decision FROM whaleu_community.content_approval_decisions WHERE id=NEW.decision_id;
  IF NOT FOUND OR decision.account_id<>NEW.account_id OR decision.operation<>NEW.operation OR decision.digest<>NEW.digest OR decision.envelope<>NEW.envelope OR (OLD.decision_id IS NULL AND EXISTS(SELECT 1 FROM whaleu_community.content_approval_bindings WHERE decision_id=NEW.decision_id)) THEN
   RAISE EXCEPTION 'Review decision snapshot mismatch' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER text_review_request_validate BEFORE INSERT OR UPDATE OR DELETE ON whaleu_community.text_review_requests FOR EACH ROW EXECUTE FUNCTION whaleu_community.text_review_request_validate();
-- Preserve the existing completeness guard for ordinary publications. Only the
-- exact separately committed review snapshot can keep its original key pending.
CREATE OR REPLACE FUNCTION whaleu_community.publication_request_complete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM whaleu_community.publication_requests p
   WHERE p.account_id=NEW.account_id AND p.client_request_id=NEW.client_request_id AND p.receipt IS NULL
   AND NOT EXISTS(SELECT 1 FROM whaleu_community.text_review_requests q
     WHERE q.account_id=p.account_id AND q.client_request_id=p.client_request_id
       AND q.operation=p.operation AND q.intent_hash=p.payload_hash AND q.submission_transaction=p.review_submission_transaction))
 THEN RAISE EXCEPTION 'Publication request is incomplete' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE INDEX text_review_pending_scope ON whaleu_community.text_review_requests((envelope->>'spaceId'),created_at) WHERE decision_id IS NULL;

CREATE FUNCTION whaleu_community.text_review_request_complete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM whaleu_community.text_review_requests q
   JOIN whaleu_community.publication_requests p USING(account_id,client_request_id)
   WHERE q.account_id=NEW.account_id AND q.client_request_id=NEW.client_request_id
     AND q.operation=p.operation AND q.intent_hash=p.payload_hash
     AND q.submission_transaction=p.review_submission_transaction)
 THEN RAISE EXCEPTION 'Review request lacks exact publication cause' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER text_review_request_complete AFTER INSERT OR UPDATE ON whaleu_community.text_review_requests
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community.text_review_request_complete();
CREATE FUNCTION whaleu_community.text_review_origin_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.review_submission_transaction IS DISTINCT FROM NEW.review_submission_transaction THEN
  RAISE EXCEPTION 'Review submission origin is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER text_review_origin_immutable BEFORE UPDATE ON whaleu_community.publication_requests FOR EACH ROW EXECUTE FUNCTION whaleu_community.text_review_origin_immutable();
CREATE TRIGGER text_review_requests_retain BEFORE TRUNCATE ON whaleu_community.text_review_requests FOR EACH STATEMENT EXECUTE FUNCTION whaleu_media.immutable_record();
REVOKE ALL ON whaleu_community.text_review_requests FROM PUBLIC;

-- The application checks the original key before consume. Also close the SQL
-- boundary: an issued queue decision can bind only the exact queue's eventual
-- original publication receipt, never identical content under another key.
CREATE FUNCTION whaleu_community.text_review_binding_owner() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q whaleu_community.text_review_requests; p whaleu_community.publication_requests;
BEGIN
 SELECT * INTO q FROM whaleu_community.text_review_requests WHERE decision_id=NEW.decision_id;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT * INTO p FROM whaleu_community.publication_requests WHERE account_id=q.account_id AND client_request_id=q.client_request_id;
 IF NOT FOUND OR NOT coalesce(p.receipt->>'outcome'='created' AND p.receipt->>'requestId'=q.client_request_id::text
   AND p.receipt->>'operation'=q.operation AND p.receipt->>'resourceId'=NEW.content_id::text
   AND p.operation=q.operation AND p.payload_hash=q.intent_hash AND NEW.account_id=q.account_id
   AND NEW.operation=q.operation AND NEW.digest=q.digest AND NEW.envelope=q.envelope,false)
 THEN RAISE EXCEPTION 'Reviewed content must bind its original publication request' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER text_review_binding_owner AFTER INSERT ON whaleu_community.content_approval_bindings
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community.text_review_binding_owner();
