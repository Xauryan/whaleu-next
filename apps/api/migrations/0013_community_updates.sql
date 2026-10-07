-- Local read materialization only. No provider activation, consent, grants,
-- import/backfill, schedules or changes to historic payload hashes/receipts.
-- Only fresh events explicitly registered by the publication repository are
-- eligible. Migration does not enroll any pre-existing or imported outbox row.
-- Separate nullable provenance leaves all historical rows unadopted; default
-- applies only to new inserts and uses the top-level xid across SAVEPOINTs.
ALTER TABLE whaleu_community.outbox ADD COLUMN local_creation_transaction xid8;
ALTER TABLE whaleu_community.outbox ALTER COLUMN local_creation_transaction SET DEFAULT pg_current_xact_id();
CREATE SEQUENCE whaleu_community.local_update_order;
CREATE TABLE whaleu_community.local_update_events (
  event_id uuid PRIMARY KEY REFERENCES whaleu_community.outbox(id),
  enrollment_order bigint NOT NULL UNIQUE,
  origin text NOT NULL CHECK(origin='local_publication'),
  automatic_eligible boolean NOT NULL DEFAULT false,
  registered_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp())
);
CREATE FUNCTION whaleu_community.local_update_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Serializes enrollment commit order and dispatcher watermarks; a rolled-back
  -- transaction may leave a sequence gap but cannot be skipped by a later commit.
  PERFORM pg_advisory_xact_lock(hashtextextended('community-update-enrollment',0));
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Local event provenance is immutable' USING ERRCODE='23514'; END IF;
  NEW.enrollment_order := nextval('whaleu_community.local_update_order');
  IF NOT EXISTS(SELECT 1 FROM whaleu_community.outbox WHERE id=NEW.event_id
    AND event_type IN ('comment_created','reply_created') AND local_creation_transaction=pg_current_xact_id()) THEN
    RAISE EXCEPTION 'Local event must enroll atomically with new publication' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER local_update_event_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_community.local_update_events
  FOR EACH ROW EXECUTE FUNCTION whaleu_community.local_update_event_guard();
CREATE FUNCTION whaleu_community.local_update_outbox_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND OLD.local_creation_transaction IS DISTINCT FROM NEW.local_creation_transaction THEN
    RAISE EXCEPTION 'Outbox creation provenance is immutable' USING ERRCODE='23514';
  END IF;
  IF EXISTS(SELECT 1 FROM whaleu_community.local_update_events WHERE event_id=OLD.id) THEN
    RAISE EXCEPTION 'Enrolled local update event is immutable' USING ERRCODE='23514';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER local_update_outbox_immutable BEFORE UPDATE OR DELETE ON whaleu_community.outbox
  FOR EACH ROW EXECUTE FUNCTION whaleu_community.local_update_outbox_immutable();
CREATE SCHEMA whaleu_notifications;
CREATE TABLE whaleu_notifications.dispatcher_state (
  name text PRIMARY KEY CHECK(name='community'),
  discovery_cursor bigint NOT NULL DEFAULT 0 CHECK(discovery_cursor>=0)
);
CREATE TABLE whaleu_notifications.automatic_work (
  event_id uuid PRIMARY KEY REFERENCES whaleu_community.outbox(id),
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','completed')),
  enrolled_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),
  completed_at timestamptz,
  CHECK((state='completed')=(completed_at IS NOT NULL))
);
CREATE TABLE whaleu_notifications.retryable_attempts (
  event_id uuid PRIMARY KEY REFERENCES whaleu_community.outbox(id),
  attempts integer NOT NULL CHECK(attempts>0),
  code text NOT NULL,
  last_attempt_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),
  next_attempt_at timestamptz NOT NULL,
  CHECK(isfinite(last_attempt_at) AND isfinite(next_attempt_at))
);
CREATE TABLE whaleu_notifications.event_receipts (
  event_id uuid PRIMARY KEY REFERENCES whaleu_community.outbox(id),
  outcome text NOT NULL CHECK(outcome IN ('processed','ignored','unavailable')),
  code text,
  completed_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),
  CHECK(isfinite(completed_at)),
  CHECK((outcome='processed')=(code IS NULL))
);
-- Owner guard serializes materialization, exact read changes and count snapshots.
-- Counts are derived from notice rows, so a replay cannot increment a counter.
CREATE TABLE whaleu_notifications.owners (
  account_id uuid PRIMARY KEY REFERENCES whaleu_identity.accounts(id)
);
CREATE TABLE whaleu_notifications.processing_receipts (
  event_id uuid NOT NULL REFERENCES whaleu_notifications.event_receipts(event_id) DEFERRABLE INITIALLY DEFERRED,
  recipient_account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
  channel text NOT NULL CHECK(channel IN ('in_app','external')),
  reason text NOT NULL CHECK(reason IN ('direct','saved')),
  save_epoch_id uuid REFERENCES whaleu_community.saved_epochs(id),
  outcome text NOT NULL CHECK(outcome IN ('materialized','suppressed','unavailable')),
  code text,
  PRIMARY KEY(event_id,recipient_account_id,channel),
  CHECK((reason='saved')=(save_epoch_id IS NOT NULL)),
  CHECK((outcome='materialized')=(code IS NULL)),
  CHECK(channel='in_app' OR outcome<>'materialized')
);
CREATE TABLE whaleu_notifications.notices (
  id uuid PRIMARY KEY,
  event_id uuid NOT NULL,
  recipient_account_id uuid NOT NULL,
  channel text NOT NULL DEFAULT 'in_app' CHECK(channel='in_app'),
  kind text NOT NULL CHECK(kind IN ('root','reply')),
  reason text NOT NULL CHECK(reason IN ('direct','saved')),
  save_epoch_id uuid REFERENCES whaleu_community.saved_epochs(id),
  post_id uuid NOT NULL REFERENCES whaleu_community.posts(id),
  comment_id uuid NOT NULL REFERENCES whaleu_community.root_comments(id),
  reply_id uuid REFERENCES whaleu_community.replies(id),
  occurred_at timestamptz NOT NULL CHECK(isfinite(occurred_at)),
  event_sequence bigint NOT NULL CHECK(event_sequence>0),
  created_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()) CHECK(isfinite(created_at)),
  read_at timestamptz CHECK(read_at IS NULL OR isfinite(read_at)),
  UNIQUE(event_id,recipient_account_id,channel),
  FOREIGN KEY(event_id,recipient_account_id,channel) REFERENCES whaleu_notifications.processing_receipts(event_id,recipient_account_id,channel) DEFERRABLE INITIALLY DEFERRED,
  CHECK((kind='reply')=(reply_id IS NOT NULL)),
  CHECK(kind='root' OR reason='direct'),
  CHECK((reason='saved')=(save_epoch_id IS NOT NULL))
);
CREATE INDEX notices_owner_page ON whaleu_notifications.notices(recipient_account_id,created_at DESC,id DESC);
CREATE INDEX notices_unread ON whaleu_notifications.notices(recipient_account_id) WHERE read_at IS NULL;
CREATE FUNCTION whaleu_notifications.immutable_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Notification receipt is immutable' USING ERRCODE='23514'; END $$;
CREATE TRIGGER notification_event_immutable BEFORE UPDATE OR DELETE ON whaleu_notifications.event_receipts
  FOR EACH ROW EXECUTE FUNCTION whaleu_notifications.immutable_receipt();
CREATE TRIGGER notification_processing_immutable BEFORE UPDATE OR DELETE ON whaleu_notifications.processing_receipts
  FOR EACH ROW EXECUTE FUNCTION whaleu_notifications.immutable_receipt();
CREATE FUNCTION whaleu_notifications.notice_read_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR (to_jsonb(OLD)-'read_at') IS DISTINCT FROM (to_jsonb(NEW)-'read_at') OR
     (OLD.read_at IS NOT NULL AND NEW.read_at IS DISTINCT FROM OLD.read_at) OR NEW.read_at IS NULL THEN
    RAISE EXCEPTION 'Notification identity and settled read state are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER notice_read_only BEFORE UPDATE OR DELETE ON whaleu_notifications.notices
  FOR EACH ROW EXECUTE FUNCTION whaleu_notifications.notice_read_only();
-- Neither a materialized receipt without a notice nor a notice without a matching
-- successful receipt can commit. The read-model row is the unread unit itself.
CREATE FUNCTION whaleu_notifications.materialization_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE result whaleu_notifications.processing_receipts; item whaleu_notifications.notices;
BEGIN
  SELECT * INTO result FROM whaleu_notifications.processing_receipts
    WHERE event_id=NEW.event_id AND recipient_account_id=NEW.recipient_account_id AND channel=NEW.channel;
  SELECT * INTO item FROM whaleu_notifications.notices
    WHERE event_id=NEW.event_id AND recipient_account_id=NEW.recipient_account_id AND channel=NEW.channel;
  IF result.event_id IS NULL OR (result.outcome='materialized') IS DISTINCT FROM (item.id IS NOT NULL) OR
    (item.id IS NOT NULL AND (result.reason,result.save_epoch_id) IS DISTINCT FROM (item.reason,item.save_epoch_id)) THEN
    RAISE EXCEPTION 'Notification materialization is incomplete' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER notice_materialization_complete AFTER INSERT ON whaleu_notifications.notices
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_notifications.materialization_complete();
CREATE CONSTRAINT TRIGGER receipt_materialization_complete AFTER INSERT ON whaleu_notifications.processing_receipts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_notifications.materialization_complete();
