-- Bounded synthetic-only group delivery. No provider, destination grant, schedule,
-- credential, historical enrollment, or accepted historical receipt is seeded.
SET LOCAL lock_timeout='5s';
-- Top-level transaction identity also covers the Errands request SAVEPOINT.
-- Existing transitions receive only this migration transaction, never enrollment.
ALTER TABLE whaleu_errands.transitions ADD COLUMN group_source_transaction xid8 NOT NULL DEFAULT pg_current_xact_id();
CREATE TABLE whaleu_notifications.errand_group_publications(
 event_id uuid PRIMARY KEY REFERENCES whaleu_errands.transitions(id),
 order_id uuid NOT NULL UNIQUE REFERENCES whaleu_errands.orders(id),
 target_region_id uuid NOT NULL REFERENCES whaleu_campus.operating_regions(id),
 published_at timestamptz NOT NULL,
 first_confirmed_at timestamptz,first_confirmed_delivery_id uuid,
 last_scanned_at timestamptz,
 CHECK((first_confirmed_at IS NULL)=(first_confirmed_delivery_id IS NULL)),
 CHECK(first_confirmed_at IS NULL OR first_confirmed_at>=published_at)
);
CREATE FUNCTION whaleu_notifications.errand_group_enrollment_guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF NOT EXISTS(SELECT 1 FROM whaleu_errands.transitions t JOIN whaleu_errands.orders o ON o.id=t.order_id
 WHERE t.id=NEW.event_id AND t.operation='publish' AND t.prior_state IS NULL AND t.next_state='pending'
 AND o.id=NEW.order_id AND o.target_region_id=NEW.target_region_id AND o.created_at=NEW.published_at
 AND t.group_source_transaction=pg_current_xact_id())
 THEN RAISE EXCEPTION 'Group enrollment requires this transaction genuine publication' USING ERRCODE='23514'; END IF;
 RETURN NEW;END$$;
CREATE TRIGGER errand_group_enrollment_guard BEFORE INSERT ON whaleu_notifications.errand_group_publications FOR EACH ROW EXECUTE FUNCTION whaleu_notifications.errand_group_enrollment_guard();
CREATE TABLE whaleu_notifications.errand_group_deliveries(
 id uuid PRIMARY KEY,event_id uuid NOT NULL REFERENCES whaleu_notifications.errand_group_publications(event_id),
 stage text NOT NULL CHECK(stage IN('errand','forum')),
 destination_id text NOT NULL CHECK(destination_id~'^synthetic:[a-z0-9:_-]{1,100}$'),
 idempotency_key text NOT NULL UNIQUE CHECK(idempotency_key~'^[a-f0-9]{64}$'),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','confirmed','retryable','suppressed','expired','unknown')),
 attempt_id uuid,fence bigint NOT NULL DEFAULT 0 CHECK(fence>=0),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 32),
 reconciliations integer NOT NULL DEFAULT 0 CHECK(reconciliations BETWEEN 0 AND 8),
 lease_until timestamptz,next_attempt_at timestamptz NOT NULL,
 reason text CHECK(reason IN('not_accepted','unavailable','source_or_authority','window','budget','unknown','permit_expired')),
 UNIQUE(event_id,stage,destination_id),
 CHECK((attempt_id IS NULL)=(lease_until IS NULL))
);
CREATE INDEX errand_group_delivery_due ON whaleu_notifications.errand_group_deliveries(next_attempt_at,id) WHERE status IN('pending','retryable','unknown');
ALTER TABLE whaleu_notifications.errand_group_publications ADD CONSTRAINT group_first_ack_destination FOREIGN KEY(first_confirmed_delivery_id) REFERENCES whaleu_notifications.errand_group_deliveries(id) DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX errand_group_publication_created ON whaleu_notifications.errand_group_publications(published_at);
CREATE INDEX errand_group_publication_first_ack ON whaleu_notifications.errand_group_publications(first_confirmed_at) WHERE first_confirmed_at IS NOT NULL;
CREATE TABLE whaleu_notifications.errand_group_attempts(
 id uuid PRIMARY KEY,delivery_id uuid NOT NULL REFERENCES whaleu_notifications.errand_group_deliveries(id),
 fence bigint NOT NULL,idempotency_key text NOT NULL,
 operation text NOT NULL CHECK(operation IN('send','reconcile')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(delivery_id,fence)
);
CREATE TABLE whaleu_notifications.errand_group_receipts(
 delivery_id uuid PRIMARY KEY REFERENCES whaleu_notifications.errand_group_deliveries(id),
 idempotency_key text NOT NULL UNIQUE,
 receipt_id text NOT NULL CHECK(receipt_id~'^synthetic:[a-zA-Z0-9:_-]{1,120}$'),
 confirmed_at timestamptz NOT NULL,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION whaleu_notifications.errand_group_immutable() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 RAISE EXCEPTION 'Group attempt and ACK receipts are immutable' USING ERRCODE='23514';END$$;
CREATE TRIGGER errand_group_attempt_immutable BEFORE UPDATE OR DELETE ON whaleu_notifications.errand_group_attempts FOR EACH ROW EXECUTE FUNCTION whaleu_notifications.errand_group_immutable();
CREATE TRIGGER errand_group_receipt_immutable BEFORE UPDATE OR DELETE ON whaleu_notifications.errand_group_receipts FOR EACH ROW EXECUTE FUNCTION whaleu_notifications.errand_group_immutable();
CREATE TRIGGER errand_group_attempt_retain BEFORE TRUNCATE ON whaleu_notifications.errand_group_attempts FOR EACH STATEMENT EXECUTE FUNCTION whaleu_notifications.errand_group_immutable();
CREATE TRIGGER errand_group_receipt_retain BEFORE TRUNCATE ON whaleu_notifications.errand_group_receipts FOR EACH STATEMENT EXECUTE FUNCTION whaleu_notifications.errand_group_immutable();
CREATE FUNCTION whaleu_notifications.errand_group_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Group source identities are retained' USING ERRCODE='23514';END IF;
 IF TG_TABLE_NAME='errand_group_publications' THEN
  IF (NEW.event_id,NEW.order_id,NEW.target_region_id,NEW.published_at) IS DISTINCT FROM (OLD.event_id,OLD.order_id,OLD.target_region_id,OLD.published_at)
  OR(OLD.first_confirmed_at IS NOT NULL AND (NEW.first_confirmed_at,NEW.first_confirmed_delivery_id) IS DISTINCT FROM (OLD.first_confirmed_at,OLD.first_confirmed_delivery_id))
  THEN RAISE EXCEPTION 'Group publication identity is immutable' USING ERRCODE='23514';END IF;
 ELSE
  IF (NEW.id,NEW.event_id,NEW.stage,NEW.destination_id,NEW.idempotency_key) IS DISTINCT FROM (OLD.id,OLD.event_id,OLD.stage,OLD.destination_id,OLD.idempotency_key)
  OR(OLD.status='confirmed' AND NEW.status<>'confirmed')
  THEN RAISE EXCEPTION 'Group destination identity and success are immutable' USING ERRCODE='23514';END IF;
 END IF;RETURN NEW;END$$;
CREATE TRIGGER errand_group_publication_identity BEFORE UPDATE OR DELETE ON whaleu_notifications.errand_group_publications FOR EACH ROW EXECUTE FUNCTION whaleu_notifications.errand_group_identity_guard();
CREATE TRIGGER errand_group_delivery_identity BEFORE UPDATE OR DELETE ON whaleu_notifications.errand_group_deliveries FOR EACH ROW EXECUTE FUNCTION whaleu_notifications.errand_group_identity_guard();

CREATE FUNCTION whaleu_notifications.errand_group_receipt_guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF NOT EXISTS(SELECT 1 FROM whaleu_notifications.errand_group_deliveries d JOIN whaleu_notifications.errand_group_publications p ON p.event_id=d.event_id
 WHERE d.id=NEW.delivery_id AND d.idempotency_key=NEW.idempotency_key
 AND((d.stage='errand' AND NEW.confirmed_at BETWEEN p.published_at AND p.published_at+interval '16 minutes')
 OR(d.stage='forum' AND NEW.confirmed_at BETWEEN p.first_confirmed_at+interval '15 minutes' AND p.first_confirmed_at+interval '30 minutes')))
 THEN RAISE EXCEPTION 'Group ACK must bind the exact destination and eligible window' USING ERRCODE='23514';END IF;RETURN NEW;END$$;
CREATE TRIGGER errand_group_receipt_guard BEFORE INSERT ON whaleu_notifications.errand_group_receipts FOR EACH ROW EXECUTE FUNCTION whaleu_notifications.errand_group_receipt_guard();
CREATE FUNCTION whaleu_notifications.errand_group_first_ack_guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF NEW.first_confirmed_at IS NOT NULL AND NOT EXISTS(
 SELECT 1 FROM whaleu_notifications.errand_group_deliveries d JOIN whaleu_notifications.errand_group_receipts r ON r.delivery_id=d.id
 WHERE d.id=NEW.first_confirmed_delivery_id AND d.event_id=NEW.event_id AND d.stage='errand' AND d.status='confirmed'
 AND r.confirmed_at=NEW.first_confirmed_at AND r.idempotency_key=d.idempotency_key)
 THEN RAISE EXCEPTION 'First confirmed ACK requires exact durable receipt' USING ERRCODE='23514';END IF;RETURN NULL;END$$;
CREATE CONSTRAINT TRIGGER errand_group_first_ack_guard AFTER INSERT OR UPDATE ON whaleu_notifications.errand_group_publications DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_notifications.errand_group_first_ack_guard();
CREATE FUNCTION whaleu_notifications.errand_group_success_guard() RETURNS trigger LANGUAGE plpgsql AS $$DECLARE s text;has_receipt boolean;BEGIN
 SELECT d.status,EXISTS(SELECT 1 FROM whaleu_notifications.errand_group_receipts r WHERE r.delivery_id=d.id AND r.idempotency_key=d.idempotency_key) INTO s,has_receipt
 FROM whaleu_notifications.errand_group_deliveries d WHERE d.id=NEW.id;
 IF (s='confirmed') IS DISTINCT FROM has_receipt THEN RAISE EXCEPTION 'Group success requires durable ACK receipt' USING ERRCODE='23514';END IF;RETURN NULL;END$$;
CREATE CONSTRAINT TRIGGER errand_group_success_guard AFTER INSERT OR UPDATE ON whaleu_notifications.errand_group_deliveries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_notifications.errand_group_success_guard();
