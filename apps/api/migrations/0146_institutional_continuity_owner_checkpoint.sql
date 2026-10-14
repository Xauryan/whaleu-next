-- Correct 0145's absolute trigger-depth assumption without weakening continuity.
-- A generation row consumes each real Verification head transition exactly once.
-- No existing epoch/counter or prepared witness is reset by this metadata backfill.
LOCK TABLE whaleu_verification.account_heads,whaleu_verification.relevant_fact_generations IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
 IF whaleu_verification.institutional_continuity_valid() IS DISTINCT FROM true THEN
  RAISE EXCEPTION 'Existing continuity source is unavailable; migration cannot repair it' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM(VALUES
 ('whaleu_verification.account_heads','institutional_relevant_fact_transition'),
 ('whaleu_verification.relevant_fact_generations','relevant_fact_generation_guard'),
 ('whaleu_verification.relevant_fact_generations','relevant_fact_generation_owned'),
 ('whaleu_verification.relevant_fact_generations','relevant_fact_generation_no_truncate')
 ) required(relation_name,trigger_name) JOIN pg_trigger t ON t.tgrelid=required.relation_name::regclass AND t.tgname=required.trigger_name
 WHERE t.tgqual IS NOT NULL OR t.tgattr<>''::int2vector OR t.tgconstraint<>0 OR t.tgdeferrable OR t.tginitdeferred OR t.tgnewtable IS NOT NULL OR t.tgoldtable IS NOT NULL)
 THEN RAISE EXCEPTION 'Existing continuity trigger identity is unavailable; migration cannot repair it' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM whaleu_verification.account_heads h LEFT JOIN whaleu_verification.relevant_fact_generations g ON g.account_id=h.account_id WHERE g.account_id IS NULL)
 OR EXISTS(SELECT 1 FROM whaleu_verification.relevant_fact_generations g LEFT JOIN whaleu_verification.account_heads h ON h.account_id=g.account_id WHERE h.account_id IS NULL)
 THEN RAISE EXCEPTION 'Continuity checkpoint requires exact existing head coverage' USING ERRCODE='23514';END IF;
END $$;
ALTER TABLE whaleu_verification.relevant_fact_generations ADD COLUMN head_revision integer,ADD COLUMN head_snapshot_id uuid;
-- Locked, transactional migration-only initialization. The runtime guards below
-- have no backfill, missing-row repair or reset branch.
DROP TRIGGER relevant_fact_generation_guard ON whaleu_verification.relevant_fact_generations;
DROP TRIGGER relevant_fact_generation_owned ON whaleu_verification.relevant_fact_generations;
UPDATE whaleu_verification.relevant_fact_generations g SET head_revision=h.revision,head_snapshot_id=h.snapshot_id FROM whaleu_verification.account_heads h WHERE h.account_id=g.account_id;
ALTER TABLE whaleu_verification.relevant_fact_generations ALTER COLUMN head_revision SET NOT NULL,
 ADD CONSTRAINT relevant_fact_checkpoint_shape CHECK((head_revision=0 AND head_snapshot_id IS NULL) OR(head_revision>0 AND head_snapshot_id IS NOT NULL));

CREATE OR REPLACE FUNCTION whaleu_verification.relevant_fact_generation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE h record;old_s whaleu_verification.snapshots;new_s whaleu_verification.snapshots;
BEGIN
 IF TG_RELID<>'whaleu_verification.relevant_fact_generations'::regclass OR TG_NAME<>'relevant_fact_generation_guard'
 OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW' OR TG_NARGS<>0 OR TG_OP NOT IN('INSERT','UPDATE') OR pg_trigger_depth()<2
 THEN RAISE EXCEPTION 'Relevant fact generations are Verification-head owned' USING ERRCODE='23514';END IF;
 SELECT current_head.*,current_head.xmin AS inserting_xid INTO h FROM whaleu_verification.account_heads current_head WHERE account_id=NEW.account_id;
 IF NOT FOUND OR (NEW.head_revision,NEW.head_snapshot_id) IS DISTINCT FROM(h.revision,h.snapshot_id)
 THEN RAISE EXCEPTION 'Continuity must consume the exact current Verification head' USING ERRCODE='23514';END IF;
 IF TG_OP='INSERT' THEN
  -- A visible uncommitted head's xmin belongs to this backend's transaction or
  -- subtransaction. Do not compare xmin with the top-level xid (SAVEPOINTs differ).
  IF h.revision<>0 OR h.snapshot_id IS NOT NULL OR NEW.affiliation_generation<>0 OR NEW.student_number_generation<>0
  OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_locks l WHERE l.locktype='transactionid' AND l.transactionid=h.inserting_xid
    AND l.pid=pg_catalog.pg_backend_pid() AND l.mode='ExclusiveLock' AND l.granted)
  THEN RAISE EXCEPTION 'Only a newly inserted empty head initializes continuity' USING ERRCODE='23514';END IF;
  RETURN NEW;
 END IF;
 IF NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.tracking_epoch IS DISTINCT FROM OLD.tracking_epoch
 OR h.revision<>OLD.head_revision+1
 THEN RAISE EXCEPTION 'Continuity transition is absent, repeated or out of order' USING ERRCODE='23514';END IF;
 IF OLD.head_revision=0 THEN
  IF OLD.head_snapshot_id IS NOT NULL THEN RAISE EXCEPTION 'Invalid initial continuity checkpoint' USING ERRCODE='23514';END IF;
 ELSE
  SELECT * INTO old_s FROM whaleu_verification.snapshots WHERE(id,account_id,revision)=(OLD.head_snapshot_id,OLD.account_id,OLD.head_revision);
  IF NOT FOUND THEN RAISE EXCEPTION 'Missing exact previous continuity snapshot' USING ERRCODE='23514';END IF;
 END IF;
 SELECT * INTO new_s FROM whaleu_verification.snapshots WHERE(id,account_id,revision)=(h.snapshot_id,h.account_id,h.revision);
 IF NOT FOUND OR NEW.affiliation_generation IS DISTINCT FROM OLD.affiliation_generation+(CASE WHEN old_s.affiliation_assertion_id IS DISTINCT FROM new_s.affiliation_assertion_id THEN 1 ELSE 0 END)
 OR NEW.student_number_generation IS DISTINCT FROM OLD.student_number_generation+(CASE WHEN old_s.student_number_assertion_id IS DISTINCT FROM new_s.student_number_assertion_id THEN 1 ELSE 0 END)
 THEN RAISE EXCEPTION 'Continuity deltas must equal the real head pointer changes' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER relevant_fact_generation_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_verification.relevant_fact_generations FOR EACH ROW EXECUTE FUNCTION whaleu_verification.relevant_fact_generation_guard();
CREATE TRIGGER relevant_fact_generation_owned BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_verification.relevant_fact_generations FOR EACH STATEMENT EXECUTE FUNCTION whaleu_verification.school_identity_statement_guard();

CREATE OR REPLACE FUNCTION whaleu_verification.advance_relevant_fact_generations() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_s whaleu_verification.snapshots;new_s whaleu_verification.snapshots;affected integer;
BEGIN
 IF TG_RELID<>'whaleu_verification.account_heads'::regclass OR TG_NAME<>'institutional_relevant_fact_transition'
 OR TG_WHEN<>'AFTER' OR TG_LEVEL<>'ROW' OR TG_NARGS<>0 OR TG_OP NOT IN('INSERT','UPDATE')
 THEN RAISE EXCEPTION 'Continuity advances only from its real Verification head trigger' USING ERRCODE='23514';END IF;
 IF TG_OP='INSERT' THEN
  INSERT INTO whaleu_verification.relevant_fact_generations(account_id,head_revision,head_snapshot_id) VALUES(NEW.account_id,NEW.revision,NEW.snapshot_id);
  RETURN NULL;
 END IF;
 SELECT * INTO old_s FROM whaleu_verification.snapshots WHERE(id,account_id,revision)=(OLD.snapshot_id,OLD.account_id,OLD.revision);
 SELECT * INTO new_s FROM whaleu_verification.snapshots WHERE(id,account_id,revision)=(NEW.snapshot_id,NEW.account_id,NEW.revision);
 UPDATE whaleu_verification.relevant_fact_generations SET
 affiliation_generation=affiliation_generation+(CASE WHEN old_s.affiliation_assertion_id IS DISTINCT FROM new_s.affiliation_assertion_id THEN 1 ELSE 0 END),
 student_number_generation=student_number_generation+(CASE WHEN old_s.student_number_assertion_id IS DISTINCT FROM new_s.student_number_assertion_id THEN 1 ELSE 0 END),
 head_revision=NEW.revision,head_snapshot_id=NEW.snapshot_id
 WHERE account_id=NEW.account_id AND head_revision=OLD.revision AND head_snapshot_id IS NOT DISTINCT FROM OLD.snapshot_id;
 GET DIAGNOSTICS affected=ROW_COUNT;
 IF affected<>1 THEN RAISE EXCEPTION 'Missing or already consumed relevant fact continuity' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;

-- Row checks cannot reject an empty UPDATE fired from another nested trigger.
-- The actual owner always performs exactly one row write in each statement.
CREATE FUNCTION whaleu_verification.relevant_fact_generation_cardinality() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE affected bigint;
BEGIN
 IF TG_RELID<>'whaleu_verification.relevant_fact_generations'::regclass OR TG_WHEN<>'AFTER' OR TG_LEVEL<>'STATEMENT' OR TG_NARGS<>0
 OR NOT((TG_OP='INSERT' AND TG_NAME='relevant_fact_generation_insert_cardinality') OR(TG_OP='UPDATE' AND TG_NAME='relevant_fact_generation_update_cardinality'))
 THEN RAISE EXCEPTION 'Invalid continuity statement owner' USING ERRCODE='23514';END IF;
 SELECT count(*) INTO affected FROM institutional_generation_rows;
 IF affected<>1 THEN RAISE EXCEPTION 'Continuity owner statements must affect exactly one head' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER relevant_fact_generation_insert_cardinality AFTER INSERT ON whaleu_verification.relevant_fact_generations REFERENCING NEW TABLE AS institutional_generation_rows FOR EACH STATEMENT EXECUTE FUNCTION whaleu_verification.relevant_fact_generation_cardinality();
CREATE TRIGGER relevant_fact_generation_update_cardinality AFTER UPDATE ON whaleu_verification.relevant_fact_generations REFERENCING NEW TABLE AS institutional_generation_rows FOR EACH STATEMENT EXECUTE FUNCTION whaleu_verification.relevant_fact_generation_cardinality();

CREATE OR REPLACE FUNCTION whaleu_verification.relevant_fact_witness(subject uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object('trackingEpoch',g.tracking_epoch,'affiliationGeneration',g.affiliation_generation::text,'studentNumberGeneration',g.student_number_generation::text,
 'affiliationAssertionId',s.affiliation_assertion_id,'studentNumberAssertionId',s.student_number_assertion_id)
 FROM whaleu_verification.relevant_fact_generations g JOIN whaleu_verification.account_heads h ON h.account_id=g.account_id
 AND(g.head_revision,g.head_snapshot_id) IS NOT DISTINCT FROM(h.revision,h.snapshot_id)
 JOIN whaleu_verification.snapshots s ON(s.id,s.account_id,s.revision)=(h.snapshot_id,h.account_id,h.revision) WHERE g.account_id=subject AND whaleu_verification.institutional_continuity_valid()
$$;
CREATE OR REPLACE FUNCTION whaleu_verification.institutional_continuity_valid() RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT current_setting('session_replication_role')='origin' AND NOT EXISTS(
 SELECT 1 FROM(VALUES
 ('whaleu_verification.account_heads','institutional_relevant_fact_transition','whaleu_verification.advance_relevant_fact_generations()',21,NULL::text),
 ('whaleu_verification.relevant_fact_generations','relevant_fact_generation_guard','whaleu_verification.relevant_fact_generation_guard()',31,NULL::text),
 ('whaleu_verification.relevant_fact_generations','relevant_fact_generation_owned','whaleu_verification.school_identity_statement_guard()',62,NULL::text),
 ('whaleu_verification.relevant_fact_generations','relevant_fact_generation_no_truncate','whaleu_verification.immutable_record()',34,NULL::text),
 ('whaleu_verification.relevant_fact_generations','relevant_fact_generation_insert_cardinality','whaleu_verification.relevant_fact_generation_cardinality()',4,'institutional_generation_rows'),
 ('whaleu_verification.relevant_fact_generations','relevant_fact_generation_update_cardinality','whaleu_verification.relevant_fact_generation_cardinality()',16,'institutional_generation_rows')
 ) required(relation_name,trigger_name,function_name,trigger_type,new_table) WHERE NOT EXISTS(SELECT 1 FROM pg_trigger t
 WHERE t.tgrelid=required.relation_name::regclass AND t.tgname=required.trigger_name AND t.tgfoid=required.function_name::regprocedure
 AND t.tgenabled='O' AND t.tgtype=required.trigger_type AND NOT t.tgisinternal AND t.tgargs=''::bytea
 AND t.tgnewtable::text IS NOT DISTINCT FROM required.new_table AND t.tgoldtable IS NULL
 AND t.tgqual IS NULL AND t.tgattr=''::int2vector AND t.tgconstraint=0 AND NOT t.tgdeferrable AND NOT t.tginitdeferred))
 AND NOT EXISTS(SELECT 1 FROM(VALUES
 ('whaleu_verification.advance_relevant_fact_generations()', '2b29b2968321e6b3339989ac6685c70b'),
 ('whaleu_verification.relevant_fact_generation_guard()', '11d7874aafbf409840e43dbd4253c8d9'),
 ('whaleu_verification.relevant_fact_generation_cardinality()', 'fcbb7d5f86287e1b2693113b81c2eedc'),
 ('whaleu_verification.relevant_fact_witness(uuid)', 'bf7c4b2a464a8527157b5a3a4fcace27'),
 ('whaleu_verification.school_identity_statement_guard()', '50b651b48207a97f634f95b31d7a1075')
 ) source(function_name,source_digest) WHERE NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=source.function_name::regprocedure AND md5(p.prosrc)=source.source_digest))
$$;
