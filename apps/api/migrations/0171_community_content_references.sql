-- Additive only. No source inventory, import, allocation, or public activation.
-- Typed opaque UUIDs deliberately have NO FK to content/accounts: removal must
-- never free a committed number, including aliases and orphaned history.
CREATE TABLE whaleu_community.content_reference_policy (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 state text NOT NULL CHECK(state IN ('inactive','allocating','ready')),
 initialization_id uuid,
 source_kind text CHECK(source_kind='synthetic'),
 historical_cutoff bigint CHECK(historical_cutoff>=0),
 public_enabled boolean NOT NULL DEFAULT false,
 CHECK((state='inactive' AND initialization_id IS NULL AND source_kind IS NULL AND historical_cutoff IS NULL AND NOT public_enabled)
    OR (state<>'inactive' AND initialization_id IS NOT NULL AND source_kind IS NOT NULL AND historical_cutoff IS NOT NULL)),
 CHECK(NOT public_enabled OR state='ready')
);
INSERT INTO whaleu_community.content_reference_policy(singleton,state) VALUES(true,'inactive');
CREATE TABLE whaleu_community.content_reference_sequences (
 name text PRIMARY KEY CHECK(name IN ('historical_post','post','child')),
 next_code bigint NOT NULL,
 minimum bigint NOT NULL,
 maximum bigint NOT NULL,
 CHECK(next_code BETWEEN minimum AND maximum+1),
 CHECK((name='historical_post' AND minimum=1000000 AND maximum=9999999)
    OR (name='post' AND minimum=10000000 AND maximum=99999999)
    OR (name='child' AND minimum=100000000 AND maximum=999999999))
);
INSERT INTO whaleu_community.content_reference_sequences VALUES
 ('historical_post',1000000,1000000,9999999),
 ('post',10000000,10000000,99999999),
 ('child',100000000,100000000,999999999);
CREATE TABLE whaleu_community.content_reference_reservations (
 code text COLLATE "C" PRIMARY KEY CHECK(code ~ '^[1-9][0-9]{6,8}$'),
 target_kind text NOT NULL CHECK(target_kind IN ('post','comment','reply')),
 target_id uuid NOT NULL,
 reserved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(code,target_kind,target_id)
);
CREATE TABLE whaleu_community.content_reference_canonicals (
 target_kind text NOT NULL CHECK(target_kind IN ('post','comment','reply')),
 target_id uuid NOT NULL,
 code text COLLATE "C" NOT NULL UNIQUE,
 allocation_version integer NOT NULL DEFAULT 2 CHECK(allocation_version=2),
 PRIMARY KEY(target_kind,target_id),
 FOREIGN KEY(code,target_kind,target_id) REFERENCES whaleu_community.content_reference_reservations(code,target_kind,target_id)
);
-- One bounded row per viewer and operation, not one permanent row per minute.
CREATE TABLE whaleu_community.content_reference_budgets (
 viewer_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id) ON DELETE CASCADE,
 operation text NOT NULL CHECK(operation IN ('resolve','lookup')),
 window_start timestamptz NOT NULL,
 used integer NOT NULL CHECK(used BETWEEN 1 AND 120),
 PRIMARY KEY(viewer_id,operation)
);
CREATE FUNCTION whaleu_community.content_reference_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Permanent reference state cannot be removed or reassigned' USING ERRCODE='23514'; END$$;
CREATE TRIGGER content_reference_reservations_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON whaleu_community.content_reference_reservations FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.content_reference_immutable();
CREATE TRIGGER content_reference_canonicals_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON whaleu_community.content_reference_canonicals FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.content_reference_immutable();
CREATE TRIGGER content_reference_policy_no_remove BEFORE DELETE OR TRUNCATE ON whaleu_community.content_reference_policy FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.content_reference_immutable();
CREATE TRIGGER content_reference_sequences_no_remove BEFORE DELETE OR TRUNCATE ON whaleu_community.content_reference_sequences FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.content_reference_immutable();
CREATE FUNCTION whaleu_community.content_reference_policy_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.singleton IS DISTINCT FROM NEW.singleton
 OR (OLD.state<>'inactive' AND (NEW.state='inactive'
   OR (OLD.initialization_id,OLD.source_kind,OLD.historical_cutoff) IS DISTINCT FROM (NEW.initialization_id,NEW.source_kind,NEW.historical_cutoff)))
 OR (OLD.state='ready' AND NEW.state<>'ready')
 THEN RAISE EXCEPTION 'Reference initialization and completed coverage are immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END$$;
CREATE TRIGGER content_reference_policy_guard BEFORE UPDATE ON whaleu_community.content_reference_policy FOR EACH ROW EXECUTE FUNCTION whaleu_community.content_reference_policy_guard();
CREATE FUNCTION whaleu_community.content_reference_sequence_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (OLD.name,OLD.minimum,OLD.maximum) IS DISTINCT FROM (NEW.name,NEW.minimum,NEW.maximum) OR NEW.next_code<OLD.next_code
 THEN RAISE EXCEPTION 'Reference counters cannot rewind or change ranges' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END$$;
CREATE TRIGGER content_reference_sequence_guard BEFORE UPDATE ON whaleu_community.content_reference_sequences FOR EACH ROW EXECUTE FUNCTION whaleu_community.content_reference_sequence_guard();
