-- Empty account-private manual timetable. No academic/provider import or sharing.
CREATE SCHEMA whaleu_timetable;
CREATE FUNCTION whaleu_timetable.owner_lock(owner_id uuid) RETURNS void LANGUAGE sql VOLATILE AS $$
 SELECT pg_advisory_xact_lock(hashtextextended('whaleu:personal-timetable:'||owner_id::text,0))
$$;
CREATE FUNCTION whaleu_timetable.valid_weeks(value smallint[]) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT cardinality(value) BETWEEN 1 AND 30 AND array_ndims(value)=1 AND array_lower(value,1)=1
 AND value=ARRAY(SELECT DISTINCT w FROM unnest(value) w WHERE w BETWEEN 1 AND 30 ORDER BY w)
$$;
CREATE TABLE whaleu_timetable.terms (
 account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id) ON DELETE CASCADE,
 term_id uuid NOT NULL,
 revision integer NOT NULL CHECK(revision BETWEEN 1 AND 2147483647),
 name text, week_one_monday date, week_count smallint, time_zone text,
 deleted_at timestamptz,
 PRIMARY KEY(account_id,term_id),
 CHECK(term_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
 CHECK((deleted_at IS NOT NULL AND name IS NULL AND week_one_monday IS NULL AND week_count IS NULL AND time_zone IS NULL) OR
 (deleted_at IS NULL AND name IS NOT NULL AND char_length(name) BETWEEN 1 AND 120 AND name=btrim(name) AND name !~ '[[:cntrl:]]'
 AND week_one_monday IS NOT NULL AND week_one_monday BETWEEN DATE '1900-01-01' AND DATE '2199-12-31' AND extract(isodow FROM week_one_monday)=1
 AND week_count IS NOT NULL AND week_count BETWEEN 1 AND 30 AND time_zone IS NOT NULL AND time_zone='Asia/Shanghai'))
);
CREATE TABLE whaleu_timetable.entries (
 account_id uuid NOT NULL,
 entry_id uuid NOT NULL,
 term_id uuid NOT NULL,
 name text, teacher text, location text, note text,
 day_of_week smallint, start_minute smallint, end_minute smallint, weeks smallint[], color text,
 deleted_at timestamptz,
 PRIMARY KEY(account_id,entry_id),
 FOREIGN KEY(account_id,term_id) REFERENCES whaleu_timetable.terms(account_id,term_id) ON DELETE CASCADE,
 CHECK(entry_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
 CHECK((deleted_at IS NOT NULL AND name IS NULL AND teacher IS NULL AND location IS NULL AND note IS NULL AND day_of_week IS NULL AND start_minute IS NULL AND end_minute IS NULL AND weeks IS NULL AND color IS NULL) OR
 (deleted_at IS NULL AND name IS NOT NULL AND char_length(name) BETWEEN 1 AND 120 AND name=btrim(name) AND name !~ '[[:cntrl:]]'
 AND teacher IS NOT NULL AND char_length(teacher)<=100 AND teacher=btrim(teacher) AND teacher !~ '[[:cntrl:]]'
 AND location IS NOT NULL AND char_length(location)<=100 AND location=btrim(location) AND location !~ '[[:cntrl:]]'
 AND note IS NOT NULL AND char_length(note)<=500 AND translate(note,E'\n\t','') !~ '[[:cntrl:]]'
 AND day_of_week IS NOT NULL AND day_of_week BETWEEN 1 AND 7 AND start_minute IS NOT NULL AND start_minute BETWEEN 0 AND 1439
 AND end_minute IS NOT NULL AND end_minute BETWEEN 1 AND 1440 AND end_minute>start_minute
 AND weeks IS NOT NULL AND whaleu_timetable.valid_weeks(weeks)
 AND color IS NOT NULL AND color IN('blue','teal','green','orange','red','purple')))
);
CREATE INDEX timetable_live_terms ON whaleu_timetable.terms(account_id,week_one_monday DESC,term_id) WHERE deleted_at IS NULL;
CREATE INDEX timetable_live_entries ON whaleu_timetable.entries(account_id,term_id,day_of_week,start_minute,entry_id) WHERE deleted_at IS NULL;
CREATE TABLE whaleu_timetable.commands (
 account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id) ON DELETE CASCADE,
 request_id uuid NOT NULL,
 intent_hash text NOT NULL CHECK(intent_hash ~ '^[a-f0-9]{64}$'),
 receipt jsonb NOT NULL,
 PRIMARY KEY(account_id,request_id),
 CHECK(request_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
 CHECK(COALESCE(jsonb_typeof(receipt)='object' AND receipt->>'requestId'=request_id::text AND receipt->>'intentHash'=intent_hash AND receipt->>'version'='1'
 AND receipt->>'outcome' IN('applied','rejected','cancelled')
 AND receipt ?& ARRAY['version','requestId','intentHash','operation','termId','entryId','expectedRevision','resultingRevision','outcome','code']
 AND receipt-ARRAY['version','requestId','intentHash','operation','termId','entryId','expectedRevision','resultingRevision','outcome','code']='{}'::jsonb,false))
);
-- An erased ID is reserved, never recycled. Receipts retain no private payload.
CREATE FUNCTION whaleu_timetable.guard_row() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF EXISTS(SELECT 1 FROM whaleu_identity.accounts WHERE id=OLD.account_id) THEN
   RAISE EXCEPTION 'Timetable IDs and receipts are retained' USING ERRCODE='23514';
  END IF;
  RETURN OLD;
 END IF;
 IF TG_TABLE_NAME='commands' THEN
  RAISE EXCEPTION 'Timetable receipts are immutable' USING ERRCODE='23514';
 END IF;
 IF NEW.account_id IS DISTINCT FROM OLD.account_id OR
 (TG_TABLE_NAME='terms' AND to_jsonb(NEW)->'term_id' IS DISTINCT FROM to_jsonb(OLD)->'term_id') OR
 (TG_TABLE_NAME='entries' AND (to_jsonb(NEW)->'entry_id' IS DISTINCT FROM to_jsonb(OLD)->'entry_id' OR to_jsonb(NEW)->'term_id' IS DISTINCT FROM to_jsonb(OLD)->'term_id')) OR
 OLD.deleted_at IS NOT NULL THEN
  RAISE EXCEPTION 'Timetable identity or tombstone is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END$$;
CREATE TRIGGER timetable_term_identity BEFORE UPDATE OR DELETE ON whaleu_timetable.terms FOR EACH ROW EXECUTE FUNCTION whaleu_timetable.guard_row();
CREATE TRIGGER timetable_entry_identity BEFORE UPDATE OR DELETE ON whaleu_timetable.entries FOR EACH ROW EXECUTE FUNCTION whaleu_timetable.guard_row();
CREATE TRIGGER timetable_command_identity BEFORE UPDATE OR DELETE ON whaleu_timetable.commands FOR EACH ROW EXECUTE FUNCTION whaleu_timetable.guard_row();
-- Database-level owner checks complement (never replace) current-session and
-- final policy proofs in the managed application transaction.
CREATE FUNCTION whaleu_timetable.guard_content() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent whaleu_timetable.terms; live_count integer;
BEGIN
 PERFORM whaleu_timetable.owner_lock(NEW.account_id);
 PERFORM whaleu_safety.require_account_punishment_allowed(NEW.account_id,'private_self_service');
 IF TG_TABLE_NAME='terms' THEN
  IF TG_OP='INSERT' THEN
   SELECT count(*) INTO live_count FROM whaleu_timetable.terms WHERE account_id=NEW.account_id AND deleted_at IS NULL;
   IF NEW.revision<>1 OR NEW.deleted_at IS NOT NULL OR live_count>=32 THEN
    RAISE EXCEPTION 'Invalid timetable creation or quota' USING ERRCODE='23514';
   END IF;
  ELSE
   IF NEW.revision::bigint<>OLD.revision::bigint+1 THEN
    RAISE EXCEPTION 'Timetable revision must advance once' USING ERRCODE='23514';
   END IF;
   IF EXISTS(SELECT 1 FROM whaleu_timetable.entries e WHERE e.account_id=NEW.account_id AND e.term_id=NEW.term_id AND e.deleted_at IS NULL AND (NEW.deleted_at IS NOT NULL OR e.weeks[cardinality(e.weeks)]>NEW.week_count)) THEN
    RAISE EXCEPTION 'Active timetable entries must remain in range' USING ERRCODE='23514';
   END IF;
  END IF;
 ELSE
  SELECT * INTO parent FROM whaleu_timetable.terms WHERE account_id=NEW.account_id AND term_id=NEW.term_id;
  IF NOT FOUND OR parent.deleted_at IS NOT NULL OR (NEW.deleted_at IS NULL AND NEW.weeks[cardinality(NEW.weeks)]>parent.week_count) THEN
   RAISE EXCEPTION 'Timetable entry requires its live private term' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' THEN
   SELECT count(*) INTO live_count FROM whaleu_timetable.entries WHERE account_id=NEW.account_id AND term_id=NEW.term_id AND deleted_at IS NULL;
   IF NEW.deleted_at IS NOT NULL OR live_count>=200 THEN
    RAISE EXCEPTION 'Invalid timetable entry creation or quota' USING ERRCODE='23514';
   END IF;
  END IF;
 END IF;
 RETURN NEW;
END$$;
CREATE TRIGGER timetable_term_content BEFORE INSERT OR UPDATE ON whaleu_timetable.terms FOR EACH ROW EXECUTE FUNCTION whaleu_timetable.guard_content();
CREATE TRIGGER timetable_entry_content BEFORE INSERT OR UPDATE ON whaleu_timetable.entries FOR EACH ROW EXECUTE FUNCTION whaleu_timetable.guard_content();
ALTER TABLE whaleu_timetable.commands ADD CONSTRAINT timetable_receipt_shape CHECK(COALESCE(
 jsonb_typeof(receipt->'version')='number' AND receipt->'version'='1'::jsonb
 AND jsonb_typeof(receipt->'requestId')='string' AND jsonb_typeof(receipt->'intentHash')='string'
 AND jsonb_typeof(receipt->'operation')='string' AND jsonb_typeof(receipt->'termId')='string'
 AND jsonb_typeof(receipt->'outcome')='string'
 AND receipt->>'operation' IN('term.create','term.update','term.delete','entry.create','entry.update','entry.delete')
 AND receipt->>'termId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
 AND ((receipt->>'operation' LIKE 'term.%' AND receipt->'entryId'='null'::jsonb) OR (receipt->>'operation' LIKE 'entry.%' AND jsonb_typeof(receipt->'entryId')='string' AND receipt->>'entryId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'))
 AND jsonb_typeof(receipt->'expectedRevision')='number' AND receipt->>'expectedRevision' ~ '^[0-9]+$' AND (receipt->>'expectedRevision')::numeric BETWEEN 0 AND 2147483647
 AND ((receipt->>'operation'='term.create' AND receipt->'expectedRevision'='0'::jsonb) OR (receipt->>'operation'<>'term.create' AND (receipt->>'expectedRevision')::numeric>0))
 AND ((receipt->'resultingRevision'='null'::jsonb) OR (jsonb_typeof(receipt->'resultingRevision')='number' AND receipt->>'resultingRevision' ~ '^[0-9]+$' AND (receipt->>'resultingRevision')::numeric BETWEEN 1 AND 2147483647))
 AND ((receipt->>'outcome'='rejected' AND jsonb_typeof(receipt->'code')='string' AND receipt->>'code' IN('TIMETABLE_NOT_FOUND','TIMETABLE_REVISION_CONFLICT','TIMETABLE_ID_REUSED','TIMETABLE_TERM_LIMIT','TIMETABLE_ENTRY_LIMIT','TIMETABLE_WEEKS_OUT_OF_RANGE','SAFETY_ACCESS_SUSPENDED','SAFETY_ACTION_RESTRICTED'))
 OR (receipt->>'outcome' IN('applied','cancelled') AND receipt->'code'='null'::jsonb))
 AND (receipt->>'outcome'<>'applied' OR (receipt->'resultingRevision'<>'null'::jsonb AND (receipt->>'resultingRevision')::numeric=(receipt->>'expectedRevision')::numeric+1))
 AND (receipt->>'outcome'<>'cancelled' OR receipt->'resultingRevision'='null'::jsonb)
,false));
