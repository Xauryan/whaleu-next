-- Original Community command-owner cancellation. Kept separate from existing
-- receipt JSON: a cancelled command is not a fabricated content Review rejection.
SET LOCAL lock_timeout='5s';
SELECT pg_advisory_xact_lock(hashtextextended('whaleu:named-block-policy:v1',0));
CREATE TABLE whaleu_community.publication_cancel_fences (
 account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
 client_request_id uuid NOT NULL,
 operation text NOT NULL CHECK(operation='publish_post'),
 intent_hash text NOT NULL CHECK(intent_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(created_at)),
 PRIMARY KEY(account_id,client_request_id)
);
CREATE INDEX publication_cancel_budget ON whaleu_community.publication_cancel_fences(account_id,created_at);
CREATE TRIGGER publication_cancel_immutable BEFORE UPDATE OR DELETE ON whaleu_community.publication_cancel_fences FOR EACH ROW EXECUTE FUNCTION whaleu_media.immutable_record();
CREATE TRIGGER publication_cancel_retain BEFORE TRUNCATE ON whaleu_community.publication_cancel_fences FOR EACH STATEMENT EXECUTE FUNCTION whaleu_media.immutable_record();
CREATE FUNCTION whaleu_community.publication_cancel_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r whaleu_community.publication_requests;f whaleu_community.publication_cancel_fences;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('whaleu:community-publication:v1:'||NEW.account_id::text||':'||NEW.client_request_id::text,0));
 IF TG_TABLE_NAME='publication_cancel_fences' THEN
  SELECT * INTO r FROM whaleu_community.publication_requests WHERE account_id=NEW.account_id AND client_request_id=NEW.client_request_id FOR UPDATE;
  IF FOUND AND (r.operation IS DISTINCT FROM NEW.operation OR r.payload_hash IS DISTINCT FROM NEW.intent_hash OR r.receipt IS NOT NULL) THEN
   RAISE EXCEPTION 'Existing publication identity or receipt takes precedence' USING ERRCODE='23514';END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('whaleu:publication-cancel-budget:v1:'||NEW.account_id::text,0));
  IF (SELECT count(*) FROM whaleu_community.publication_cancel_fences WHERE account_id=NEW.account_id AND created_at>=date_trunc('day',clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')>=128 THEN
   RAISE EXCEPTION 'Publication cancellation budget exhausted' USING ERRCODE='23514';END IF;
 ELSE
  SELECT * INTO f FROM whaleu_community.publication_cancel_fences WHERE account_id=NEW.account_id AND client_request_id=NEW.client_request_id;
  IF FOUND THEN RAISE EXCEPTION 'Cancelled publication cannot be created or rewritten' USING ERRCODE='23514';END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER publication_cancel_guard BEFORE INSERT ON whaleu_community.publication_cancel_fences FOR EACH ROW EXECUTE FUNCTION whaleu_community.publication_cancel_guard();
CREATE TRIGGER publication_request_cancel_guard BEFORE INSERT OR UPDATE ON whaleu_community.publication_requests FOR EACH ROW EXECUTE FUNCTION whaleu_community.publication_cancel_guard();
