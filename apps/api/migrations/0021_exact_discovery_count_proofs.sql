-- Exact optional discovery proofs: fixed, owner-owned transactional epochs.
-- Existing source/content/account lock ordering is preserved. A writer claims
-- one FREE exclusive slot with try-lock, never waits for another epoch writer,
-- and reuses that actual granted lock for all its statements/targets. Every
-- relevant statement advances its epoch; rollback undoes source and epoch.
-- Readers briefly try shared locks for the complete vector only AFTER deferred
-- constraints. Finalizers hold the exclusive notification gate before shared
-- slots. A writer whose try-only scan meets final fences waits at the SHARED
-- notification gate, then retries: no writer waits behind another source writer.
-- Count proofs require the stable postmaster backend+prepared-writer bound to be
-- below128. Larger servers keep normal mutations but cannot publish this proof.
-- No resettable sequence, history-sized locks or counter fanout is introduced.
-- Slots are conservative: an unrelated owner write can invalidate an exact count.
-- No grants, source-data import, policy evidence or provider/job activation.

CREATE TABLE whaleu_community.discovery_count_epochs (
  slot integer PRIMARY KEY CHECK (slot BETWEEN 0 AND 127),
  version integer NOT NULL CHECK (version=1),
  epoch bigint NOT NULL CHECK (epoch>=0)
);
INSERT INTO whaleu_community.discovery_count_epochs(slot,version,epoch)
  SELECT slot,1,0 FROM generate_series(0,127) AS slot;

CREATE FUNCTION whaleu_community.guard_discovery_count_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Only nested source statement triggers can advance this fixed metadata.
  -- Never trust a caller-controlled custom setting as a transaction claim.
  IF TG_OP<>'UPDATE' THEN
    RAISE EXCEPTION 'Count epoch metadata is retained' USING ERRCODE='23514';
  END IF;
  IF pg_trigger_depth()<2 OR NEW.slot IS DISTINCT FROM OLD.slot OR
     NEW.version IS DISTINCT FROM OLD.version OR NEW.epoch IS DISTINCT FROM OLD.epoch+1 THEN
    RAISE EXCEPTION 'Count epochs only advance through source mutations' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_discovery_count_epoch BEFORE INSERT OR UPDATE OR DELETE ON whaleu_community.discovery_count_epochs
  FOR EACH ROW EXECUTE FUNCTION whaleu_community.guard_discovery_count_epoch();
CREATE TRIGGER retain_discovery_count_epochs BEFORE TRUNCATE ON whaleu_community.discovery_count_epochs
  FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.guard_discovery_count_epoch();

CREATE FUNCTION whaleu_community.advance_discovery_count_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE chosen integer; first_slot integer; candidate integer; step integer;
BEGIN
  -- These are postmaster settings, so an in-flight transaction cannot cross a
  -- capacity change. On larger servers only optional counts are unavailable;
  -- core mutations retain their existing behavior without epoch admission.
  IF current_setting('max_connections')::integer +
     current_setting('max_prepared_transactions')::integer +
     current_setting('max_worker_processes')::integer +
     current_setting('max_wal_senders')::integer >= 128 THEN
    RETURN NULL;
  END IF;
  -- pg_locks, not a GUC or application cache, proves ownership. Advisory locks
  -- and changes below both participate in savepoint rollback.
  SELECT objid::integer INTO chosen FROM pg_locks
    WHERE locktype='advisory' AND pid=pg_backend_pid() AND granted
      AND mode='ExclusiveLock' AND classid=1464356101::oid AND objsubid=2
      AND objid BETWEEN 0::oid AND 127::oid
    ORDER BY objid LIMIT 1;
  IF chosen IS NULL THEN
    first_slot := mod(pg_current_xact_id()::text::numeric,128)::integer;
    FOR step IN 0..127 LOOP
      candidate := mod(first_slot+step,128);
      IF pg_try_advisory_xact_lock(1464356101,candidate) THEN
        chosen := candidate;
        EXIT;
      END IF;
    END LOOP;
  END IF;
  IF chosen IS NOT NULL THEN
    -- pg_locks also reports session-owned locks. Always acquire xact ownership
    -- so pg_advisory_unlock cannot release a mutation's transaction fence.
    IF NOT pg_try_advisory_xact_lock(1464356101,chosen) THEN chosen := NULL; END IF;
  END IF;
  IF chosen IS NULL THEN
    -- Fewer than128 possible writers each own at most one slot. Exhaustion can
    -- therefore only come from final readers' shared slots. The notification
    -- gate waits for those readers, never serializes source writers, and stops
    -- another finalizer from fencing the slots before this writer's retry.
    PERFORM pg_advisory_xact_lock_shared(1464356101,128);
    FOR step IN 0..127 LOOP
      candidate := mod(first_slot+step,128);
      IF pg_try_advisory_xact_lock(1464356101,candidate) THEN
        chosen := candidate;
        EXIT;
      END IF;
    END LOOP;
    IF chosen IS NULL THEN
      -- Unreachable for protocol writers under the checked server bound. This
      -- is reserved-fence misuse/corruption, not a core writer concurrency cap.
      RAISE EXCEPTION 'Reserved count fences are inconsistent' USING ERRCODE='55P03';
    END IF;
  END IF;
  -- Even an unexpected direct metadata row locker cannot add a writer wait.
  PERFORM 1 FROM whaleu_community.discovery_count_epochs WHERE slot=chosen FOR UPDATE NOWAIT;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Count epoch metadata is incomplete' USING ERRCODE='23514';
  END IF;
  UPDATE whaleu_community.discovery_count_epochs SET epoch=epoch+1 WHERE slot=chosen;
  RETURN NULL;
END $$;

CREATE TRIGGER a_discovery_count_epoch BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_community.spaces
  FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.advance_discovery_count_epoch();
CREATE TRIGGER a_discovery_count_epoch BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_community.posts
  FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.advance_discovery_count_epoch();
CREATE TRIGGER a_discovery_count_epoch BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_community.root_comments
  FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.advance_discovery_count_epoch();
CREATE TRIGGER a_discovery_count_epoch BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_community.replies
  FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.advance_discovery_count_epoch();
CREATE TRIGGER a_discovery_count_epoch BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_community.post_images
  FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.advance_discovery_count_epoch();
CREATE TRIGGER a_discovery_count_epoch BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_community.comment_images
  FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.advance_discovery_count_epoch();
CREATE TRIGGER a_discovery_count_epoch BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_community.reply_images
  FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.advance_discovery_count_epoch();
CREATE TRIGGER a_discovery_count_epoch BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_community.post_likes
  FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.advance_discovery_count_epoch();
CREATE TRIGGER a_discovery_count_epoch BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_community.comment_likes
  FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.advance_discovery_count_epoch();
CREATE TRIGGER a_discovery_count_epoch BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_community.reply_likes
  FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.advance_discovery_count_epoch();
CREATE TRIGGER a_discovery_count_epoch BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_community.polls
  FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.advance_discovery_count_epoch();
CREATE TRIGGER a_discovery_count_epoch BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_community.poll_options
  FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.advance_discovery_count_epoch();
CREATE TRIGGER a_discovery_count_epoch BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_community.formations
  FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.advance_discovery_count_epoch();
CREATE TRIGGER a_discovery_count_epoch BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_community.formation_members
  FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.advance_discovery_count_epoch();
CREATE TRIGGER a_discovery_count_epoch BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_community.trading_listings
  FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.advance_discovery_count_epoch();
CREATE TRIGGER a_discovery_count_epoch BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_community.content_approval_bindings
  FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.advance_discovery_count_epoch();
CREATE TRIGGER a_discovery_count_epoch BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_community.content_approval_policies
  FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.advance_discovery_count_epoch();
CREATE TRIGGER a_discovery_count_epoch BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_community.content_approval_decisions
  FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.advance_discovery_count_epoch();
CREATE TRIGGER a_discovery_count_epoch BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_community.content_approval_events
  FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.advance_discovery_count_epoch();
CREATE TRIGGER a_discovery_count_epoch BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_community.content_approval_heads
  FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.advance_discovery_count_epoch();

CREATE TABLE whaleu_safety.discovery_count_epochs (
  slot integer PRIMARY KEY CHECK (slot BETWEEN 0 AND 127),
  version integer NOT NULL CHECK (version=1),
  epoch bigint NOT NULL CHECK (epoch>=0)
);
INSERT INTO whaleu_safety.discovery_count_epochs(slot,version,epoch)
  SELECT slot,1,0 FROM generate_series(0,127) AS slot;

CREATE FUNCTION whaleu_safety.guard_discovery_count_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Only nested source statement triggers can advance this fixed metadata.
  -- Never trust a caller-controlled custom setting as a transaction claim.
  IF TG_OP<>'UPDATE' THEN
    RAISE EXCEPTION 'Count epoch metadata is retained' USING ERRCODE='23514';
  END IF;
  IF pg_trigger_depth()<2 OR NEW.slot IS DISTINCT FROM OLD.slot OR
     NEW.version IS DISTINCT FROM OLD.version OR NEW.epoch IS DISTINCT FROM OLD.epoch+1 THEN
    RAISE EXCEPTION 'Count epochs only advance through source mutations' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_discovery_count_epoch BEFORE INSERT OR UPDATE OR DELETE ON whaleu_safety.discovery_count_epochs
  FOR EACH ROW EXECUTE FUNCTION whaleu_safety.guard_discovery_count_epoch();
CREATE TRIGGER retain_discovery_count_epochs BEFORE TRUNCATE ON whaleu_safety.discovery_count_epochs
  FOR EACH STATEMENT EXECUTE FUNCTION whaleu_safety.guard_discovery_count_epoch();

CREATE FUNCTION whaleu_safety.advance_discovery_count_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE chosen integer; first_slot integer; candidate integer; step integer;
BEGIN
  -- These are postmaster settings, so an in-flight transaction cannot cross a
  -- capacity change. On larger servers only optional counts are unavailable;
  -- core mutations retain their existing behavior without epoch admission.
  IF current_setting('max_connections')::integer +
     current_setting('max_prepared_transactions')::integer +
     current_setting('max_worker_processes')::integer +
     current_setting('max_wal_senders')::integer >= 128 THEN
    RETURN NULL;
  END IF;
  -- pg_locks, not a GUC or application cache, proves ownership. Advisory locks
  -- and changes below both participate in savepoint rollback.
  SELECT objid::integer INTO chosen FROM pg_locks
    WHERE locktype='advisory' AND pid=pg_backend_pid() AND granted
      AND mode='ExclusiveLock' AND classid=1464356102::oid AND objsubid=2
      AND objid BETWEEN 0::oid AND 127::oid
    ORDER BY objid LIMIT 1;
  IF chosen IS NULL THEN
    first_slot := mod(pg_current_xact_id()::text::numeric,128)::integer;
    FOR step IN 0..127 LOOP
      candidate := mod(first_slot+step,128);
      IF pg_try_advisory_xact_lock(1464356102,candidate) THEN
        chosen := candidate;
        EXIT;
      END IF;
    END LOOP;
  END IF;
  IF chosen IS NOT NULL THEN
    -- pg_locks also reports session-owned locks. Always acquire xact ownership
    -- so pg_advisory_unlock cannot release a mutation's transaction fence.
    IF NOT pg_try_advisory_xact_lock(1464356102,chosen) THEN chosen := NULL; END IF;
  END IF;
  IF chosen IS NULL THEN
    -- Fewer than128 possible writers each own at most one slot. Exhaustion can
    -- therefore only come from final readers' shared slots. The notification
    -- gate waits for those readers, never serializes source writers, and stops
    -- another finalizer from fencing the slots before this writer's retry.
    PERFORM pg_advisory_xact_lock_shared(1464356102,128);
    FOR step IN 0..127 LOOP
      candidate := mod(first_slot+step,128);
      IF pg_try_advisory_xact_lock(1464356102,candidate) THEN
        chosen := candidate;
        EXIT;
      END IF;
    END LOOP;
    IF chosen IS NULL THEN
      -- Unreachable for protocol writers under the checked server bound. This
      -- is reserved-fence misuse/corruption, not a core writer concurrency cap.
      RAISE EXCEPTION 'Reserved count fences are inconsistent' USING ERRCODE='55P03';
    END IF;
  END IF;
  -- Even an unexpected direct metadata row locker cannot add a writer wait.
  PERFORM 1 FROM whaleu_safety.discovery_count_epochs WHERE slot=chosen FOR UPDATE NOWAIT;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Count epoch metadata is incomplete' USING ERRCODE='23514';
  END IF;
  UPDATE whaleu_safety.discovery_count_epochs SET epoch=epoch+1 WHERE slot=chosen;
  RETURN NULL;
END $$;

CREATE TRIGGER a_discovery_count_epoch BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_safety.account_heads
  FOR EACH STATEMENT EXECUTE FUNCTION whaleu_safety.advance_discovery_count_epoch();
CREATE TRIGGER a_discovery_count_epoch BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_safety.blocks
  FOR EACH STATEMENT EXECUTE FUNCTION whaleu_safety.advance_discovery_count_epoch();

CREATE TABLE whaleu_campus.discovery_count_epochs (
  slot integer PRIMARY KEY CHECK (slot BETWEEN 0 AND 127),
  version integer NOT NULL CHECK (version=1),
  epoch bigint NOT NULL CHECK (epoch>=0)
);
INSERT INTO whaleu_campus.discovery_count_epochs(slot,version,epoch)
  SELECT slot,1,0 FROM generate_series(0,127) AS slot;

CREATE FUNCTION whaleu_campus.guard_discovery_count_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Only nested source statement triggers can advance this fixed metadata.
  -- Never trust a caller-controlled custom setting as a transaction claim.
  IF TG_OP<>'UPDATE' THEN
    RAISE EXCEPTION 'Count epoch metadata is retained' USING ERRCODE='23514';
  END IF;
  IF pg_trigger_depth()<2 OR NEW.slot IS DISTINCT FROM OLD.slot OR
     NEW.version IS DISTINCT FROM OLD.version OR NEW.epoch IS DISTINCT FROM OLD.epoch+1 THEN
    RAISE EXCEPTION 'Count epochs only advance through source mutations' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_discovery_count_epoch BEFORE INSERT OR UPDATE OR DELETE ON whaleu_campus.discovery_count_epochs
  FOR EACH ROW EXECUTE FUNCTION whaleu_campus.guard_discovery_count_epoch();
CREATE TRIGGER retain_discovery_count_epochs BEFORE TRUNCATE ON whaleu_campus.discovery_count_epochs
  FOR EACH STATEMENT EXECUTE FUNCTION whaleu_campus.guard_discovery_count_epoch();

CREATE FUNCTION whaleu_campus.advance_discovery_count_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE chosen integer; first_slot integer; candidate integer; step integer;
BEGIN
  -- These are postmaster settings, so an in-flight transaction cannot cross a
  -- capacity change. On larger servers only optional counts are unavailable;
  -- core mutations retain their existing behavior without epoch admission.
  IF current_setting('max_connections')::integer +
     current_setting('max_prepared_transactions')::integer +
     current_setting('max_worker_processes')::integer +
     current_setting('max_wal_senders')::integer >= 128 THEN
    RETURN NULL;
  END IF;
  -- pg_locks, not a GUC or application cache, proves ownership. Advisory locks
  -- and changes below both participate in savepoint rollback.
  SELECT objid::integer INTO chosen FROM pg_locks
    WHERE locktype='advisory' AND pid=pg_backend_pid() AND granted
      AND mode='ExclusiveLock' AND classid=1464356103::oid AND objsubid=2
      AND objid BETWEEN 0::oid AND 127::oid
    ORDER BY objid LIMIT 1;
  IF chosen IS NULL THEN
    first_slot := mod(pg_current_xact_id()::text::numeric,128)::integer;
    FOR step IN 0..127 LOOP
      candidate := mod(first_slot+step,128);
      IF pg_try_advisory_xact_lock(1464356103,candidate) THEN
        chosen := candidate;
        EXIT;
      END IF;
    END LOOP;
  END IF;
  IF chosen IS NOT NULL THEN
    -- pg_locks also reports session-owned locks. Always acquire xact ownership
    -- so pg_advisory_unlock cannot release a mutation's transaction fence.
    IF NOT pg_try_advisory_xact_lock(1464356103,chosen) THEN chosen := NULL; END IF;
  END IF;
  IF chosen IS NULL THEN
    -- Fewer than128 possible writers each own at most one slot. Exhaustion can
    -- therefore only come from final readers' shared slots. The notification
    -- gate waits for those readers, never serializes source writers, and stops
    -- another finalizer from fencing the slots before this writer's retry.
    PERFORM pg_advisory_xact_lock_shared(1464356103,128);
    FOR step IN 0..127 LOOP
      candidate := mod(first_slot+step,128);
      IF pg_try_advisory_xact_lock(1464356103,candidate) THEN
        chosen := candidate;
        EXIT;
      END IF;
    END LOOP;
    IF chosen IS NULL THEN
      -- Unreachable for protocol writers under the checked server bound. This
      -- is reserved-fence misuse/corruption, not a core writer concurrency cap.
      RAISE EXCEPTION 'Reserved count fences are inconsistent' USING ERRCODE='55P03';
    END IF;
  END IF;
  -- Even an unexpected direct metadata row locker cannot add a writer wait.
  PERFORM 1 FROM whaleu_campus.discovery_count_epochs WHERE slot=chosen FOR UPDATE NOWAIT;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Count epoch metadata is incomplete' USING ERRCODE='23514';
  END IF;
  UPDATE whaleu_campus.discovery_count_epochs SET epoch=epoch+1 WHERE slot=chosen;
  RETURN NULL;
END $$;

CREATE TRIGGER a_discovery_count_epoch BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_campus.operating_regions
  FOR EACH STATEMENT EXECUTE FUNCTION whaleu_campus.advance_discovery_count_epoch();
