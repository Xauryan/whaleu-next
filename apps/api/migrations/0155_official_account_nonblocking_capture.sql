-- Durable scheduling is only a hint; it never grants coverage or authority.
ALTER TABLE whaleu_official.maintenance_claim ADD COLUMN next_phase text NOT NULL DEFAULT 'drain' CHECK(next_phase IN ('drain','canonical'));

-- A snapshot is meaningful only in its real xid domain. This is an identity,
-- never an authority capability. No runtime role privilege is granted here.
CREATE FUNCTION whaleu_official.current_capture_domain() RETURNS text LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE domain text;
BEGIN
 SELECT system_identifier::text||'/'||extract(epoch FROM pg_catalog.pg_postmaster_start_time())::text INTO STRICT domain FROM pg_catalog.pg_control_system();
 IF domain IS NULL THEN RAISE EXCEPTION 'Official capture domain unavailable' USING ERRCODE='23514';END IF;
 RETURN domain;
END $$;
ALTER TABLE whaleu_official.source_roots ADD COLUMN baseline_snapshot pg_snapshot;
ALTER TABLE whaleu_official.source_roots ADD COLUMN baseline_capture_domain text;
-- Old events have an unknown domain, never relabel historical xids as current.
ALTER TABLE whaleu_official.source_events ADD COLUMN source_domain text;
ALTER TABLE whaleu_official.dependency_events ADD COLUMN source_domain text;
CREATE INDEX official_rank_post_identity ON whaleu_official.source_ranks(post_id,space_id);

-- Ordinary owner writes must never serialize on an official space/global root.
-- Only enrollment changes this handshake row; all ordinary writers are compatible.
CREATE TABLE whaleu_official.enrollment_gate(singleton boolean PRIMARY KEY CHECK(singleton),revision bigint NOT NULL CHECK(revision>=0));
INSERT INTO whaleu_official.enrollment_gate VALUES(true,0);
CREATE TABLE whaleu_official.enrolled_spaces(space_id uuid PRIMARY KEY REFERENCES whaleu_official.source_roots(space_id));
INSERT INTO whaleu_official.enrolled_spaces SELECT school_space_id FROM whaleu_official.programs UNION SELECT city_space_id FROM whaleu_official.programs WHERE city_space_id IS NOT NULL;
CREATE TRIGGER official_enrollment_identity BEFORE UPDATE OR DELETE ON whaleu_official.enrolled_spaces FOR EACH ROW EXECUTE FUNCTION whaleu_media.immutable_record();
CREATE TRIGGER official_enrollment_retain BEFORE TRUNCATE ON whaleu_official.enrolled_spaces FOR EACH STATEMENT EXECUTE FUNCTION whaleu_media.immutable_record();

CREATE TABLE whaleu_official.pending_causes(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),kind text NOT NULL CHECK(kind IN('source','dependency')),
 space_id uuid,post_id uuid,dependency_kind text,target_id uuid,
 owner_table text NOT NULL,source_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),source_domain text NOT NULL DEFAULT whaleu_official.current_capture_domain(),
 CHECK((kind='source' AND space_id IS NOT NULL AND post_id IS NOT NULL AND dependency_kind IS NULL AND target_id IS NULL)
 OR (kind='dependency' AND space_id IS NULL AND post_id IS NULL AND target_id IS NOT NULL AND dependency_kind IN('account','asset','decision','policy','space','post','region','institution','campus','media_intent','category_policy','category_review','category_issuer')))
);
CREATE INDEX official_pending_source ON whaleu_official.pending_causes(space_id,id) WHERE kind='source';
CREATE INDEX official_pending_dependency ON whaleu_official.pending_causes(id) WHERE kind='dependency';
-- Only the same transaction can collide; distinct writers never share this key.
CREATE UNIQUE INDEX official_pending_source_transaction ON whaleu_official.pending_causes(source_domain,source_xid,space_id,post_id) WHERE kind='source';
CREATE UNIQUE INDEX official_pending_dependency_transaction ON whaleu_official.pending_causes(source_domain,source_xid,dependency_kind,target_id) WHERE kind='dependency';
CREATE INDEX official_pending_source_snapshot ON whaleu_official.pending_causes(source_domain,space_id,source_xid) WHERE kind='source';
CREATE INDEX official_pending_dependency_snapshot ON whaleu_official.pending_causes(source_domain,source_xid) WHERE kind='dependency';
CREATE TABLE whaleu_official.cause_conversions(
 id uuid PRIMARY KEY,kind text NOT NULL,space_id uuid,post_id uuid,dependency_kind text,target_id uuid,
 owner_table text NOT NULL,source_xid xid8 NOT NULL,source_domain text NOT NULL,sequence bigint NOT NULL,
 conversion_xid xid8 NOT NULL DEFAULT pg_current_xact_id()
);
CREATE TRIGGER official_conversion_immutable BEFORE UPDATE OR DELETE ON whaleu_official.cause_conversions FOR EACH ROW EXECUTE FUNCTION whaleu_media.immutable_record();
CREATE TRIGGER official_conversion_retain BEFORE TRUNCATE ON whaleu_official.cause_conversions FOR EACH STATEMENT EXECUTE FUNCTION whaleu_media.immutable_record();
CREATE FUNCTION whaleu_official.cause_conversion_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p whaleu_official.pending_causes;
BEGIN
 SELECT * INTO p FROM whaleu_official.pending_causes WHERE id=NEW.id;
 IF NOT FOUND OR NEW.conversion_xid<>pg_current_xact_id() OR
 ROW(NEW.kind,NEW.space_id,NEW.post_id,NEW.dependency_kind,NEW.target_id,NEW.owner_table,NEW.source_xid,NEW.source_domain)
 IS DISTINCT FROM ROW(p.kind,p.space_id,p.post_id,p.dependency_kind,p.target_id,p.owner_table,p.source_xid,p.source_domain) THEN
 RAISE EXCEPTION 'Official cause conversion identity mismatch' USING ERRCODE='23514';END IF;
 IF p.kind='source' THEN
  IF NOT EXISTS(SELECT 1 FROM whaleu_official.source_events e WHERE e.space_id=p.space_id AND e.sequence=NEW.sequence AND e.post_id=p.post_id AND e.owner_table=p.owner_table AND e.source_xid=p.source_xid AND e.source_domain=p.source_domain AND e.xmin::text::bigint=(pg_current_xact_id()::text::numeric % 4294967296)::bigint) OR NOT EXISTS(SELECT 1 FROM whaleu_official.source_roots r JOIN whaleu_official.source_dirty d USING(space_id) WHERE r.space_id=p.space_id AND r.head>=NEW.sequence AND NOT r.ready AND d.post_id=p.post_id AND d.last_sequence>=NEW.sequence) THEN
   RAISE EXCEPTION 'Official source cause lacks its current conversion' USING ERRCODE='23514';END IF;
 ELSE
  IF NOT EXISTS(SELECT 1 FROM whaleu_official.dependency_events e WHERE e.sequence=NEW.sequence AND e.kind=p.dependency_kind AND e.target_id=p.target_id AND e.owner_table=p.owner_table AND e.source_xid=p.source_xid AND e.source_domain=p.source_domain AND e.xmin::text::bigint=(pg_current_xact_id()::text::numeric % 4294967296)::bigint) OR NOT EXISTS(SELECT 1 FROM whaleu_official.dependency_root WHERE singleton AND head>=NEW.sequence) THEN
   RAISE EXCEPTION 'Official dependency cause lacks its current conversion' USING ERRCODE='23514';END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER official_conversion_admit BEFORE INSERT ON whaleu_official.cause_conversions FOR EACH ROW EXECUTE FUNCTION whaleu_official.cause_conversion_guard();
CREATE FUNCTION whaleu_official.pending_cause_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'DELETE' THEN RAISE EXCEPTION 'Official pending cause is immutable' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT 1 FROM whaleu_official.cause_conversions c WHERE c.id=OLD.id AND c.conversion_xid=pg_current_xact_id()
 AND ROW(c.kind,c.space_id,c.post_id,c.dependency_kind,c.target_id,c.owner_table,c.source_xid,c.source_domain) IS NOT DISTINCT FROM ROW(OLD.kind,OLD.space_id,OLD.post_id,OLD.dependency_kind,OLD.target_id,OLD.owner_table,OLD.source_xid,OLD.source_domain)) THEN
 RAISE EXCEPTION 'Official pending cause must be converted exactly' USING ERRCODE='23514';END IF;
 RETURN OLD;
END $$;
CREATE TRIGGER official_pending_identity BEFORE UPDATE OR DELETE ON whaleu_official.pending_causes FOR EACH ROW EXECUTE FUNCTION whaleu_official.pending_cause_guard();
CREATE TRIGGER official_pending_retain BEFORE TRUNCATE ON whaleu_official.pending_causes FOR EACH STATEMENT EXECUTE FUNCTION whaleu_media.immutable_record();

CREATE OR REPLACE FUNCTION whaleu_official.mark_post(p uuid, owner_name text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE s uuid;
BEGIN
 PERFORM revision FROM whaleu_official.enrollment_gate WHERE singleton FOR SHARE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'Official enrollment handshake is missing' USING ERRCODE='23514';END IF;
 -- A separate volatile SPI query sees enrollment after the handshake at READ COMMITTED.
 -- At REPEATABLE READ an older gate version cannot be locked without serialization failure.
 FOR s IN SELECT q.space_id FROM (SELECT space_id FROM whaleu_community.posts WHERE id=p UNION SELECT space_id FROM whaleu_official.source_ranks WHERE post_id=p) q
 JOIN whaleu_official.enrolled_spaces e USING(space_id) LOOP
  INSERT INTO whaleu_official.pending_causes(kind,space_id,post_id,owner_table) VALUES('source',s,p,owner_name) ON CONFLICT DO NOTHING;
 END LOOP;
END $$;
CREATE OR REPLACE FUNCTION whaleu_official.dependency_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE t uuid;
BEGIN
 PERFORM revision FROM whaleu_official.enrollment_gate WHERE singleton FOR SHARE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'Official enrollment handshake is missing' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT 1 FROM whaleu_official.enrolled_spaces) THEN RETURN NULL;END IF;
 FOR t IN SELECT DISTINCT value::uuid FROM (VALUES(to_jsonb(NEW)->>TG_ARGV[1]),(to_jsonb(OLD)->>TG_ARGV[1])) ids(value) WHERE value IS NOT NULL LOOP
  INSERT INTO whaleu_official.pending_causes(kind,dependency_kind,target_id,owner_table) VALUES('dependency',TG_ARGV[0],t,TG_TABLE_SCHEMA||'.'||TG_TABLE_NAME) ON CONFLICT DO NOTHING;
 END LOOP;
 RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION whaleu_official.program_roots() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 -- NOWAIT on both sides prevents an enrollment/source owner lock inversion.
 PERFORM revision FROM whaleu_official.enrollment_gate WHERE singleton FOR UPDATE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'Official enrollment handshake is missing' USING ERRCODE='23514';END IF;
 UPDATE whaleu_official.enrollment_gate SET revision=revision+1 WHERE singleton;
 INSERT INTO whaleu_official.source_roots(space_id) VALUES(NEW.school_space_id) ON CONFLICT DO NOTHING;
 INSERT INTO whaleu_official.enrolled_spaces VALUES(NEW.school_space_id) ON CONFLICT DO NOTHING;
 IF NEW.city_space_id IS NOT NULL THEN
  INSERT INTO whaleu_official.source_roots(space_id) VALUES(NEW.city_space_id) ON CONFLICT DO NOTHING;
  INSERT INTO whaleu_official.enrolled_spaces VALUES(NEW.city_space_id) ON CONFLICT DO NOTHING;
 END IF;
 RETURN NULL;
END $$;

CREATE FUNCTION whaleu_official.pending_cause_admit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.source_xid<>pg_current_xact_id() OR NEW.source_domain IS DISTINCT FROM whaleu_official.current_capture_domain() THEN RAISE EXCEPTION 'Official cause must bind its real source transaction' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER official_pending_admit BEFORE INSERT ON whaleu_official.pending_causes FOR EACH ROW EXECUTE FUNCTION whaleu_official.pending_cause_admit();

CREATE FUNCTION whaleu_official.enrollment_membership_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF pg_trigger_depth()<>2 OR NOT EXISTS(SELECT 1 FROM whaleu_official.programs WHERE school_space_id=NEW.space_id OR city_space_id=NEW.space_id)
 OR NOT EXISTS(SELECT 1 FROM whaleu_official.enrollment_gate WHERE singleton AND xmin::text::bigint=(pg_current_xact_id()::text::numeric % 4294967296)::bigint) THEN
 RAISE EXCEPTION 'Official enrollment requires its program handshake' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER official_enrollment_admit BEFORE INSERT ON whaleu_official.enrolled_spaces FOR EACH ROW EXECUTE FUNCTION whaleu_official.enrollment_membership_guard();
CREATE TRIGGER official_enrollment_gate_identity BEFORE UPDATE OR DELETE ON whaleu_official.enrollment_gate FOR EACH ROW EXECUTE FUNCTION whaleu_media.guard_mutable_record('revision');
CREATE TRIGGER official_enrollment_gate_retain BEFORE TRUNCATE ON whaleu_official.enrollment_gate FOR EACH STATEMENT EXECUTE FUNCTION whaleu_media.immutable_record();

CREATE FUNCTION whaleu_official.enrollment_revision_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF pg_trigger_depth()<>2 OR NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'Official enrollment revision is program-owned and monotonic' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER official_enrollment_revision BEFORE UPDATE ON whaleu_official.enrollment_gate FOR EACH ROW EXECUTE FUNCTION whaleu_official.enrollment_revision_guard();
