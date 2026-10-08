-- E2A administrative reads only. Retain every E1 lifecycle/receipt constraint.
-- Fixed owner-local metadata follows migration 0021's statement-trigger and
-- try-only slot/notification-gate protocol. The reserved namespaces are distinct
-- from Community, Safety, Campus and the existing integration-test fence.
-- Metadata starts at zero; this creates no user records, profiles, authority,
-- restrictions, notices, historical UID mapping, provider or imported coverage.
-- Final page consistency additionally requires each owner's SHARE NOWAIT table
-- fence after every blocking wait; epochs alone protect only optional totals.

CREATE INDEX errand_admin_history
  ON whaleu_errands.orders(target_region_id,created_at DESC,id DESC);
CREATE INDEX errand_admin_state_history
  ON whaleu_errands.orders(target_region_id,state,created_at DESC,id DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX errand_admin_deleted_history
  ON whaleu_errands.orders(target_region_id,created_at DESC,id DESC)
  WHERE deleted_at IS NOT NULL;

CREATE TABLE whaleu_errands.admin_count_epochs (
  slot integer PRIMARY KEY CHECK (slot BETWEEN 0 AND 127),
  version integer NOT NULL CHECK (version=1),
  epoch bigint NOT NULL CHECK (epoch>=0)
);
INSERT INTO whaleu_errands.admin_count_epochs(slot,version,epoch)
  SELECT slot,1,0 FROM generate_series(0,127) AS slot;

CREATE FUNCTION whaleu_errands.guard_admin_count_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER guard_admin_count_epoch BEFORE INSERT OR UPDATE OR DELETE ON whaleu_errands.admin_count_epochs
  FOR EACH ROW EXECUTE FUNCTION whaleu_errands.guard_admin_count_epoch();
CREATE TRIGGER retain_admin_count_epochs BEFORE TRUNCATE ON whaleu_errands.admin_count_epochs
  FOR EACH STATEMENT EXECUTE FUNCTION whaleu_errands.guard_admin_count_epoch();

CREATE FUNCTION whaleu_errands.advance_admin_count_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
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
      AND mode='ExclusiveLock' AND classid=1464356105::oid AND objsubid=2
      AND objid BETWEEN 0::oid AND 127::oid
    ORDER BY objid LIMIT 1;
  IF chosen IS NULL THEN
    first_slot := mod(pg_current_xact_id()::text::numeric,128)::integer;
    FOR step IN 0..127 LOOP
      candidate := mod(first_slot+step,128);
      IF pg_try_advisory_xact_lock(1464356105,candidate) THEN
        chosen := candidate;
        EXIT;
      END IF;
    END LOOP;
  END IF;
  IF chosen IS NOT NULL THEN
    -- pg_locks also reports session-owned locks. Always acquire xact ownership
    -- so pg_advisory_unlock cannot release a mutation's transaction fence.
    IF NOT pg_try_advisory_xact_lock(1464356105,chosen) THEN chosen := NULL; END IF;
  END IF;
  IF chosen IS NULL THEN
    -- Fewer than128 possible writers each own at most one slot. Exhaustion can
    -- therefore only come from final readers' shared slots. The notification
    -- gate waits for those readers, never serializes source writers, and stops
    -- another finalizer from fencing the slots before this writer's retry.
    PERFORM pg_advisory_xact_lock_shared(1464356105,128);
    FOR step IN 0..127 LOOP
      candidate := mod(first_slot+step,128);
      IF pg_try_advisory_xact_lock(1464356105,candidate) THEN
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
  PERFORM 1 FROM whaleu_errands.admin_count_epochs WHERE slot=chosen FOR UPDATE NOWAIT;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Count epoch metadata is incomplete' USING ERRCODE='23514';
  END IF;
  UPDATE whaleu_errands.admin_count_epochs SET epoch=epoch+1 WHERE slot=chosen;
  RETURN NULL;
END $$;

CREATE TRIGGER a_admin_count_epoch BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_errands.orders
  FOR EACH STATEMENT EXECUTE FUNCTION whaleu_errands.advance_admin_count_epoch();

CREATE TABLE whaleu_profile.admin_count_epochs (
  slot integer PRIMARY KEY CHECK (slot BETWEEN 0 AND 127),
  version integer NOT NULL CHECK (version=1),
  epoch bigint NOT NULL CHECK (epoch>=0)
);
INSERT INTO whaleu_profile.admin_count_epochs(slot,version,epoch)
  SELECT slot,1,0 FROM generate_series(0,127) AS slot;

CREATE FUNCTION whaleu_profile.guard_admin_count_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER guard_admin_count_epoch BEFORE INSERT OR UPDATE OR DELETE ON whaleu_profile.admin_count_epochs
  FOR EACH ROW EXECUTE FUNCTION whaleu_profile.guard_admin_count_epoch();
CREATE TRIGGER retain_admin_count_epochs BEFORE TRUNCATE ON whaleu_profile.admin_count_epochs
  FOR EACH STATEMENT EXECUTE FUNCTION whaleu_profile.guard_admin_count_epoch();

CREATE FUNCTION whaleu_profile.advance_admin_count_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
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
      AND mode='ExclusiveLock' AND classid=1464356106::oid AND objsubid=2
      AND objid BETWEEN 0::oid AND 127::oid
    ORDER BY objid LIMIT 1;
  IF chosen IS NULL THEN
    first_slot := mod(pg_current_xact_id()::text::numeric,128)::integer;
    FOR step IN 0..127 LOOP
      candidate := mod(first_slot+step,128);
      IF pg_try_advisory_xact_lock(1464356106,candidate) THEN
        chosen := candidate;
        EXIT;
      END IF;
    END LOOP;
  END IF;
  IF chosen IS NOT NULL THEN
    -- pg_locks also reports session-owned locks. Always acquire xact ownership
    -- so pg_advisory_unlock cannot release a mutation's transaction fence.
    IF NOT pg_try_advisory_xact_lock(1464356106,chosen) THEN chosen := NULL; END IF;
  END IF;
  IF chosen IS NULL THEN
    -- Fewer than128 possible writers each own at most one slot. Exhaustion can
    -- therefore only come from final readers' shared slots. The notification
    -- gate waits for those readers, never serializes source writers, and stops
    -- another finalizer from fencing the slots before this writer's retry.
    PERFORM pg_advisory_xact_lock_shared(1464356106,128);
    FOR step IN 0..127 LOOP
      candidate := mod(first_slot+step,128);
      IF pg_try_advisory_xact_lock(1464356106,candidate) THEN
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
  PERFORM 1 FROM whaleu_profile.admin_count_epochs WHERE slot=chosen FOR UPDATE NOWAIT;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Count epoch metadata is incomplete' USING ERRCODE='23514';
  END IF;
  UPDATE whaleu_profile.admin_count_epochs SET epoch=epoch+1 WHERE slot=chosen;
  RETURN NULL;
END $$;

CREATE TRIGGER a_admin_count_epoch BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_profile.profiles
  FOR EACH STATEMENT EXECUTE FUNCTION whaleu_profile.advance_admin_count_epoch();
