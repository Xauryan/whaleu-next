-- Fresh-only internal view aggregate. No historical inference, public count,
-- received-author-total changes, event ledger or asynchronous effect queue.
CREATE TABLE whaleu_post_hotness.view_baselines (
 post_id uuid PRIMARY KEY REFERENCES whaleu_community.posts(id),
 component_version smallint NOT NULL DEFAULT 1 CHECK(component_version=1),
 origin text NOT NULL DEFAULT 'native_post_creation' CHECK(origin='native_post_creation'),
 opening_count bigint NOT NULL DEFAULT 0 CHECK(opening_count=0),
 owner_id uuid NOT NULL, source_request_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 creation_xid xid8 NOT NULL DEFAULT pg_current_xact_id()
);
CREATE TABLE whaleu_post_hotness.view_states (
 post_id uuid PRIMARY KEY REFERENCES whaleu_post_hotness.view_baselines(post_id),
 count bigint NOT NULL DEFAULT 0 CHECK(count>=0)
);
CREATE FUNCTION whaleu_post_hotness.view_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'View aggregate provenance is immutable' USING ERRCODE='23514'; END $$;
CREATE TRIGGER view_baseline_immutable BEFORE UPDATE OR DELETE ON whaleu_post_hotness.view_baselines FOR EACH ROW EXECUTE FUNCTION whaleu_post_hotness.view_immutable();
CREATE TRIGGER view_baseline_no_truncate BEFORE TRUNCATE ON whaleu_post_hotness.view_baselines FOR EACH STATEMENT EXECUTE FUNCTION whaleu_post_hotness.view_immutable();
CREATE TRIGGER view_state_no_truncate BEFORE TRUNCATE ON whaleu_post_hotness.view_states FOR EACH STATEMENT EXECUTE FUNCTION whaleu_post_hotness.view_immutable();
CREATE FUNCTION whaleu_post_hotness.view_baseline_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM whaleu_community.posts p
   JOIN whaleu_community.report_origins o ON o.kind='post' AND o.target_id=p.id
   JOIN whaleu_community.publication_requests r ON r.account_id=o.owner_account_id AND r.client_request_id=o.source_request_id
   WHERE p.id=NEW.post_id AND p.account_id=NEW.owner_id AND p.local_creation_transaction=pg_current_xact_id()
    AND o.owner_account_id=NEW.owner_id AND o.source_request_id=NEW.source_request_id AND o.provenance='native_publication'
    AND r.operation='publish_post' AND r.receipt->>'outcome'='created'
    AND r.receipt->>'resourceId'=p.id::text AND r.receipt->>'requestId'=NEW.source_request_id::text
    AND r.receipt->>'operation'='publish_post') THEN
   RAISE EXCEPTION 'View baseline requires exact fresh native publication' USING ERRCODE='23514';
 END IF;
 NEW.creation_xid:=pg_current_xact_id(); NEW.created_at:=clock_timestamp(); RETURN NEW;
END $$;
CREATE TRIGGER view_baseline_guard BEFORE INSERT ON whaleu_post_hotness.view_baselines FOR EACH ROW EXECUTE FUNCTION whaleu_post_hotness.view_baseline_guard();
CREATE FUNCTION whaleu_post_hotness.view_publication_complete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.kind='post' AND NEW.provenance='native_publication'
  AND EXISTS(SELECT 1 FROM whaleu_community.posts WHERE id=NEW.target_id AND local_creation_transaction=pg_current_xact_id())
  AND NOT EXISTS(SELECT 1 FROM whaleu_post_hotness.view_baselines b JOIN whaleu_post_hotness.view_states s USING(post_id)
   WHERE b.post_id=NEW.target_id AND b.owner_id=NEW.owner_account_id AND b.source_request_id=NEW.source_request_id AND b.creation_xid=pg_current_xact_id()) THEN
  RAISE EXCEPTION 'Fresh native publication requires view enrollment' USING ERRCODE='23514';
 END IF; RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER view_publication_complete AFTER INSERT ON whaleu_community.report_origins DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_post_hotness.view_publication_complete();
CREATE FUNCTION whaleu_post_hotness.view_baseline_complete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM whaleu_post_hotness.view_states WHERE post_id=NEW.post_id) THEN
  RAISE EXCEPTION 'View baseline requires state' USING ERRCODE='23514';
 END IF; RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER view_baseline_complete AFTER INSERT ON whaleu_post_hotness.view_baselines DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_post_hotness.view_baseline_complete();
CREATE FUNCTION whaleu_post_hotness.view_state_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'View aggregate is retained' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.count<>0 OR NOT EXISTS(SELECT 1 FROM whaleu_post_hotness.view_baselines WHERE post_id=NEW.post_id AND creation_xid=pg_current_xact_id()) THEN
   RAISE EXCEPTION 'View initial state requires fresh zero baseline' USING ERRCODE='23514';
  END IF;
 ELSIF NEW.post_id<>OLD.post_id OR NEW.count<=OLD.count THEN
  RAISE EXCEPTION 'View aggregate only admits positive increments' USING ERRCODE='23514';
 END IF; RETURN NEW;
END $$;
CREATE TRIGGER view_state_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_post_hotness.view_states FOR EACH ROW EXECUTE FUNCTION whaleu_post_hotness.view_state_guard();

-- Account linkage is bounded by epoch expiry. Receipts intentionally contain no
-- post IDs, raw events or timestamps. Identity is never recreated on submission.
CREATE TABLE whaleu_post_hotness.view_reporting_epochs (
 id uuid PRIMARY KEY,
 account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
 issued_at timestamptz NOT NULL,
 collection_until timestamptz NOT NULL,
 expires_at timestamptz NOT NULL,
 batch_count integer NOT NULL DEFAULT 0 CHECK(batch_count BETWEEN 0 AND 2048),
 event_count integer NOT NULL DEFAULT 0 CHECK(event_count BETWEEN 0 AND 20000),
 CHECK(collection_until=issued_at+interval '1 hour'),
 CHECK(expires_at=issued_at+interval '24 hours'),
 CHECK(event_count>=batch_count)
);
CREATE INDEX view_epoch_owner ON whaleu_post_hotness.view_reporting_epochs(account_id,expires_at);
CREATE INDEX view_epoch_expiry ON whaleu_post_hotness.view_reporting_epochs(expires_at,id);
CREATE TABLE whaleu_post_hotness.view_report_receipts (
 epoch_id uuid NOT NULL REFERENCES whaleu_post_hotness.view_reporting_epochs(id),
 batch_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('list_exposure','detail_visit')),
 payload_fingerprint text NOT NULL CHECK(payload_fingerprint ~ '^[0-9a-f]{64}$'),
 accepted_count smallint NOT NULL CHECK(accepted_count BETWEEN 0 AND 50),
 PRIMARY KEY(epoch_id,batch_id),
 CHECK(kind<>'detail_visit' OR accepted_count<=1)
);
CREATE TABLE whaleu_post_hotness.view_detail_cooldowns (
 account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
 post_id uuid NOT NULL REFERENCES whaleu_post_hotness.view_baselines(post_id),
 next_allowed_at timestamptz NOT NULL,
 PRIMARY KEY(account_id,post_id)
);
CREATE INDEX view_detail_expiry ON whaleu_post_hotness.view_detail_cooldowns(next_allowed_at,account_id,post_id);
CREATE FUNCTION whaleu_post_hotness.view_epoch_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.expires_at>clock_timestamp() THEN
   RAISE EXCEPTION 'Live view epoch cannot be removed' USING ERRCODE='23514';
  END IF; RETURN OLD;
 END IF;
 IF (NEW.id,NEW.account_id,NEW.issued_at,NEW.collection_until,NEW.expires_at)
  IS DISTINCT FROM (OLD.id,OLD.account_id,OLD.issued_at,OLD.collection_until,OLD.expires_at)
  OR NEW.batch_count<>OLD.batch_count+1 OR NEW.event_count<=OLD.event_count
  OR NEW.event_count>OLD.event_count+50 OR OLD.expires_at<=clock_timestamp() THEN
  RAISE EXCEPTION 'View epoch identity is immutable and capacity only advances while live' USING ERRCODE='23514';
 END IF; RETURN NEW;
END $$;
CREATE TRIGGER view_epoch_guard BEFORE UPDATE OR DELETE ON whaleu_post_hotness.view_reporting_epochs FOR EACH ROW EXECUTE FUNCTION whaleu_post_hotness.view_epoch_guard();
CREATE TRIGGER view_epoch_no_truncate BEFORE TRUNCATE ON whaleu_post_hotness.view_reporting_epochs FOR EACH STATEMENT EXECUTE FUNCTION whaleu_post_hotness.view_immutable();
CREATE FUNCTION whaleu_post_hotness.view_receipt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expiry timestamptz;
BEGIN
 IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'View receipt is immutable' USING ERRCODE='23514'; END IF;
 -- Caller owns epoch first. NOWAIT avoids inverted receipt -> epoch waits for
 -- direct SQL writers; cleanup and acceptance use the same epoch lock.
 IF TG_OP='DELETE' THEN
  SELECT expires_at INTO expiry FROM whaleu_post_hotness.view_reporting_epochs WHERE id=OLD.epoch_id FOR UPDATE NOWAIT;
  IF expiry IS NULL OR expiry>clock_timestamp() THEN
   RAISE EXCEPTION 'Live view receipt cannot be removed' USING ERRCODE='23514';
  END IF; RETURN OLD;
 END IF;
 SELECT expires_at INTO expiry FROM whaleu_post_hotness.view_reporting_epochs WHERE id=NEW.epoch_id FOR UPDATE NOWAIT;
 IF expiry IS NULL OR expiry<=clock_timestamp() THEN
  RAISE EXCEPTION 'View receipt requires live epoch' USING ERRCODE='23514';
 END IF; RETURN NEW;
END $$;
CREATE TRIGGER view_receipt_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_post_hotness.view_report_receipts FOR EACH ROW EXECUTE FUNCTION whaleu_post_hotness.view_receipt_guard();
CREATE TRIGGER view_receipt_no_truncate BEFORE TRUNCATE ON whaleu_post_hotness.view_report_receipts FOR EACH STATEMENT EXECUTE FUNCTION whaleu_post_hotness.view_immutable();
CREATE FUNCTION whaleu_post_hotness.view_detail_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.next_allowed_at>clock_timestamp() THEN
   RAISE EXCEPTION 'Live view detail window cannot be removed' USING ERRCODE='23514';
  END IF; RETURN OLD;
 END IF;
 IF (NEW.account_id,NEW.post_id) IS DISTINCT FROM (OLD.account_id,OLD.post_id)
  OR OLD.next_allowed_at>clock_timestamp() OR NEW.next_allowed_at<=OLD.next_allowed_at THEN
  RAISE EXCEPTION 'View detail window cannot be extended or rewritten while live' USING ERRCODE='23514';
 END IF; RETURN NEW;
END $$;
CREATE TRIGGER view_detail_guard BEFORE UPDATE OR DELETE ON whaleu_post_hotness.view_detail_cooldowns FOR EACH ROW EXECUTE FUNCTION whaleu_post_hotness.view_detail_guard();
CREATE TRIGGER view_detail_no_truncate BEFORE TRUNCATE ON whaleu_post_hotness.view_detail_cooldowns FOR EACH STATEMENT EXECUTE FUNCTION whaleu_post_hotness.view_immutable();
