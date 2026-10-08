-- Empty Safety-owned relational errand administration. No coverage, grant,
-- source import, past operator or real restriction is seeded by this migration.
-- Positive actor corroboration only. This ordinary/deferred function may wait;
-- target absence is separately proven by the managed final Authorization proof.
-- The caller authenticates the presented token, common account/phone/Safety
-- policy and exact command subject separately in this same transaction.
CREATE FUNCTION whaleu_authorization.require_errand_management_authority(
  actor uuid,
  session_ref uuid,
  grant_ref uuid,
  target_region uuid DEFAULT NULL
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  account_status text;
  session_row whaleu_identity.sessions;
  grant_row whaleu_authorization.role_grants;
  region_active boolean;
  checked_at timestamptz;
BEGIN
  SELECT status INTO account_status
    FROM whaleu_identity.accounts WHERE id=actor FOR SHARE;
  SELECT * INTO session_row
    FROM whaleu_identity.sessions
    WHERE id=session_ref AND account_id=actor FOR SHARE;
  SELECT * INTO grant_row
    FROM whaleu_authorization.role_grants
    WHERE id=grant_ref AND account_id=actor FOR SHARE;
  -- A target school role protects regardless of region activity. Here we are
  -- instead corroborating a positively selected actor school grant, whose exact
  -- target region must still be active. Global authority needs no Campus read.
  IF grant_row.role='school_admin' AND target_region IS NOT NULL AND
      grant_row.operating_region_id=target_region THEN
    SELECT is_active INTO region_active
      FROM whaleu_campus.operating_regions WHERE id=target_region FOR SHARE;
  END IF;
  -- Evaluate all temporal predicates only after every ordinary row/scope wait.
  checked_at:=clock_timestamp();
  IF account_status IS DISTINCT FROM 'active' OR
      session_row.id IS NULL OR session_row.revoked_at IS NOT NULL OR
      grant_row.id IS NULL OR grant_row.revoked_at IS NOT NULL OR
      (
        (grant_row.role IN ('developer','super_admin') AND
          grant_row.operating_region_id IS NULL) OR
        (grant_row.role='school_admin' AND target_region IS NOT NULL AND
          grant_row.operating_region_id=target_region AND region_active IS TRUE)
      ) IS NOT TRUE THEN
    RAISE EXCEPTION 'Errand management lacks live exact actor authority'
      USING ERRCODE='23514',CONSTRAINT='errand_management_authority_invalid';
  END IF;
  IF NOT isfinite(checked_at) OR
      NOT isfinite(session_row.access_expires_at) OR
      NOT isfinite(session_row.refresh_expires_at) OR
      NOT isfinite(session_row.absolute_expires_at) OR
      session_row.access_expires_at>session_row.refresh_expires_at OR
      session_row.refresh_expires_at>session_row.absolute_expires_at OR
      NOT isfinite(grant_row.valid_from) OR
      (grant_row.expires_at IS NOT NULL AND
        (NOT isfinite(grant_row.expires_at) OR
          grant_row.expires_at<=grant_row.valid_from)) OR
      grant_row.valid_from>checked_at THEN
    RAISE EXCEPTION 'Errand management authority evidence is invalid'
      USING ERRCODE='23514',CONSTRAINT='errand_management_authority_invalid';
  END IF;
  -- These stable diagnostic names alone map to normal runtime deadline failures.
  -- All timestamps retain PostgreSQL precision; no millisecond conversion here.
  IF session_row.access_expires_at<=checked_at OR
      session_row.absolute_expires_at<=checked_at THEN
    RAISE EXCEPTION 'Errand management session expired'
      USING ERRCODE='23514',CONSTRAINT='errand_management_session_expired';
  END IF;
  IF grant_row.expires_at IS NOT NULL AND grant_row.expires_at<=checked_at THEN
    RAISE EXCEPTION 'Errand management authority expired'
      USING ERRCODE='23514',CONSTRAINT='errand_management_authorization_expired';
  END IF;
END $$;
CREATE TABLE whaleu_safety.errand_restriction_requests (
 account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id), request_id uuid NOT NULL,
 session_id uuid NOT NULL,
 grant_id uuid NOT NULL REFERENCES whaleu_authorization.role_grants(id),
 operation text NOT NULL CHECK(operation IN ('issue','release')),
 intent_hash text NOT NULL CHECK(intent_hash~'^[a-f0-9]{64}$'), intent jsonb NOT NULL CHECK(jsonb_typeof(intent)='object'), receipt jsonb,
 CHECK(intent_hash=encode(sha256(convert_to('whaleu:errand-restriction-command:v1'||chr(10)||whaleu_community.content_canonical_json(jsonb_build_object('operation',operation,'intent',intent)),'UTF8')),'hex')),
 PRIMARY KEY(account_id,request_id), CHECK(receipt IS NULL OR jsonb_typeof(receipt)='object')
);
CREATE TABLE whaleu_safety.errand_restriction_commands (
 id uuid PRIMARY KEY, actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
 session_id uuid NOT NULL,
 grant_id uuid NOT NULL REFERENCES whaleu_authorization.role_grants(id),
 request_id uuid NOT NULL, kind text NOT NULL CHECK(kind IN ('global','order')),
 operation text NOT NULL CHECK(operation IN ('issue','release','admin_delete','restrict_accepter')),
 order_id uuid REFERENCES whaleu_errands.orders(id), target_region_id uuid REFERENCES whaleu_campus.operating_regions(id),
 subject_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
 occurred_at timestamptz NOT NULL CHECK(isfinite(occurred_at)),
 UNIQUE(actor_id,request_id,kind),
 CHECK((kind='global' AND operation IN ('issue','release') AND order_id IS NULL AND target_region_id IS NULL)
 OR (kind='order' AND operation IN ('admin_delete','restrict_accepter') AND order_id IS NOT NULL AND target_region_id IS NOT NULL))
);
CREATE TABLE whaleu_safety.errand_restriction_definitions (
 id uuid PRIMARY KEY, subject_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
 action text NOT NULL CHECK(action IN ('publish','accept','all')), reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 500),
 starts_at timestamptz NOT NULL CHECK(isfinite(starts_at)),
 ends_at timestamptz CHECK(ends_at IS NULL OR (isfinite(ends_at) AND ends_at>starts_at)),
 baseline_released_at timestamptz CHECK(baseline_released_at IS NULL OR (isfinite(baseline_released_at) AND baseline_released_at>=starts_at)),
 origin text NOT NULL CHECK(origin IN ('local','baseline')),
 actor_id uuid REFERENCES whaleu_identity.accounts(id), source_order_id uuid REFERENCES whaleu_errands.orders(id),
 baseline_snapshot_id uuid REFERENCES whaleu_safety.errand_feature_snapshots(id),
 command_id uuid NOT NULL REFERENCES whaleu_safety.errand_restriction_commands(id),
 terms jsonb NOT NULL CHECK(jsonb_typeof(terms)='object'),
 recorded_at timestamptz NOT NULL CHECK(isfinite(recorded_at)),
 CHECK((origin='local' AND actor_id IS NOT NULL AND baseline_snapshot_id IS NULL AND baseline_released_at IS NULL AND length(reason)<=255)
 OR (origin='baseline' AND actor_id IS NULL AND source_order_id IS NULL AND baseline_snapshot_id IS NOT NULL))
);
CREATE TABLE whaleu_safety.errand_restriction_events (
 id uuid PRIMARY KEY, restriction_id uuid NOT NULL REFERENCES whaleu_safety.errand_restriction_definitions(id),
 kind text NOT NULL CHECK(kind IN ('issued','observed_baseline','manually_released','superseded')),
 previous_event_id uuid REFERENCES whaleu_safety.errand_restriction_events(id),
 command_id uuid NOT NULL REFERENCES whaleu_safety.errand_restriction_commands(id),
 replacement_restriction_id uuid REFERENCES whaleu_safety.errand_restriction_definitions(id),
 effective_at timestamptz NOT NULL CHECK(isfinite(effective_at)),
 recorded_at timestamptz NOT NULL CHECK(isfinite(recorded_at) AND recorded_at>=effective_at),
 reason text CHECK(reason IS NULL OR length(reason) BETWEEN 1 AND 255),
 UNIQUE(id,restriction_id), UNIQUE(previous_event_id),
 CHECK((kind IN ('issued','observed_baseline') AND previous_event_id IS NULL AND replacement_restriction_id IS NULL)
 OR (kind='manually_released' AND previous_event_id IS NOT NULL AND replacement_restriction_id IS NULL AND reason IS NOT NULL)
 OR (kind='superseded' AND previous_event_id IS NOT NULL AND replacement_restriction_id IS NOT NULL AND reason IS NULL)),
 CHECK(kind<>'observed_baseline' OR reason IS NULL)
);
CREATE UNIQUE INDEX errand_restriction_initial_event ON whaleu_safety.errand_restriction_events(restriction_id) WHERE previous_event_id IS NULL;
CREATE TABLE whaleu_safety.errand_restriction_heads (
 restriction_id uuid PRIMARY KEY REFERENCES whaleu_safety.errand_restriction_definitions(id), event_id uuid NOT NULL,
 FOREIGN KEY(event_id,restriction_id) REFERENCES whaleu_safety.errand_restriction_events(id,restriction_id)
);
CREATE TABLE whaleu_safety.errand_restriction_materializations (
 snapshot_id uuid PRIMARY KEY REFERENCES whaleu_safety.errand_feature_snapshots(id),
 predecessor_snapshot_id uuid NOT NULL REFERENCES whaleu_safety.errand_feature_snapshots(id),
 command_id uuid NOT NULL UNIQUE REFERENCES whaleu_safety.errand_restriction_commands(id),
 source_event_id uuid NOT NULL UNIQUE REFERENCES whaleu_safety.errand_restriction_events(id),
 CHECK(snapshot_id<>predecessor_snapshot_id)
);
CREATE INDEX errand_restriction_recorded ON whaleu_safety.errand_restriction_definitions(recorded_at DESC,id DESC);
CREATE INDEX errand_restriction_subject_recorded ON whaleu_safety.errand_restriction_definitions(subject_id,recorded_at DESC,id DESC);
CREATE INDEX errand_restriction_events_recorded ON whaleu_safety.errand_restriction_events(restriction_id,recorded_at DESC,id DESC);
CREATE INDEX errand_restriction_subject_action ON whaleu_safety.errand_restriction_definitions(subject_id,action);

ALTER TABLE whaleu_safety.errand_feature_snapshots ADD COLUMN management_created_xid xid8;
CREATE FUNCTION whaleu_safety.stamp_errand_feature_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.management_created_xid:=pg_current_xact_id(); RETURN NEW; END $$;
CREATE TRIGGER errand_feature_snapshot_transaction BEFORE INSERT ON whaleu_safety.errand_feature_snapshots FOR EACH ROW EXECUTE FUNCTION whaleu_safety.stamp_errand_feature_snapshot();

CREATE FUNCTION whaleu_safety.errand_restriction_unavailable() RETURNS void LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Errand feature authority is unavailable' USING ERRCODE='23514',CONSTRAINT='errand_restriction_unavailable'; END $$;
CREATE FUNCTION whaleu_safety.errand_restriction_end(starts timestamptz,duration jsonb) RETURNS timestamptz LANGUAGE plpgsql AS $$
DECLARE ending timestamptz; amount numeric;
BEGIN
 IF jsonb_typeof(duration) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid duration'; END IF;
 IF duration->>'kind'='permanent' AND duration=jsonb_build_object('kind','permanent') THEN RETURN NULL; END IF;
 IF duration->>'kind' IS DISTINCT FROM 'finite' OR NOT (duration ?& ARRAY['kind','unit','value'])
 OR (SELECT count(*) FROM jsonb_object_keys(duration))<>3 OR (duration->>'unit' IN ('hours','days')) IS NOT TRUE
 OR jsonb_typeof(duration->'value') IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'Invalid duration'; END IF;
 amount:=(duration->>'value')::numeric;
 IF amount<=0 OR amount>9007199254740991 OR amount<>trunc(amount) THEN RAISE EXCEPTION 'Invalid duration'; END IF;
 ending:=starts+((amount*CASE WHEN duration->>'unit'='days' THEN 86400 ELSE 3600 END)::text||' seconds')::interval;
 IF NOT isfinite(starts) OR NOT isfinite(ending) OR ending<=starts OR ending>='10000-01-01T00:00:00Z'::timestamptz THEN RAISE EXCEPTION 'Invalid duration'; END IF;
 RETURN ending;
EXCEPTION WHEN raise_exception OR numeric_value_out_of_range OR datetime_field_overflow OR interval_field_overflow THEN
 RAISE EXCEPTION 'Invalid errand restriction duration' USING ERRCODE='23514',CONSTRAINT='errand_restriction_duration_invalid';
END $$;

CREATE FUNCTION whaleu_safety.errand_restriction_nonblank(value text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT length(btrim(value,U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'))>0
$$;

CREATE FUNCTION whaleu_safety.errand_restriction_fact_valid(f jsonb, checked_at timestamptz, allow_local_unicode boolean DEFAULT false) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE st timestamptz; en timestamptz; rel timestamptz; fact_id uuid;
BEGIN
 IF jsonb_typeof(f) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 IF jsonb_typeof(f)<>'object' OR NOT (f ?& ARRAY['id','action','reason','startsAt','endsAt','releasedAt','provenance','issuer','sourceReference','policyReference']) OR (SELECT count(*) FROM jsonb_object_keys(f))<>10
 OR jsonb_typeof(f->'id') IS DISTINCT FROM 'string' OR jsonb_typeof(f->'action') IS DISTINCT FROM 'string'
 OR jsonb_typeof(f->'reason') IS DISTINCT FROM 'string' OR jsonb_typeof(f->'startsAt') IS DISTINCT FROM 'string'
 OR jsonb_typeof(f->'endsAt') NOT IN ('string','null') OR jsonb_typeof(f->'releasedAt') NOT IN ('string','null')
 OR f->>'action' NOT IN ('publish','accept','all') OR length(f->>'reason') NOT BETWEEN 1 AND 500
 OR (length(f->>'reason')+length(regexp_replace(f->>'reason',U&'[\0001-\FFFF]','','g'))>500
 AND NOT (allow_local_unicode AND length(f->>'reason')<=255))
 OR (f->>'id') !~ '^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$'
 OR f->>'provenance' IS DISTINCT FROM 'accepted'
 OR jsonb_typeof(f->'issuer') IS DISTINCT FROM 'string' OR whaleu_safety.errand_restriction_nonblank(f->>'issuer') IS NOT TRUE
 OR jsonb_typeof(f->'sourceReference') IS DISTINCT FROM 'string' OR whaleu_safety.errand_restriction_nonblank(f->>'sourceReference') IS NOT TRUE
 OR jsonb_typeof(f->'policyReference') IS DISTINCT FROM 'string' OR whaleu_safety.errand_restriction_nonblank(f->>'policyReference') IS NOT TRUE
 THEN RETURN false; END IF;
 IF (f->>'startsAt') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T(0[0-9]|1[0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]{1,6})?(Z|[+-](0[0-9]|1[0-9]|2[0-3]):[0-5][0-9])$'
 OR ((f->>'endsAt') IS NOT NULL AND (f->>'endsAt') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T(0[0-9]|1[0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]{1,6})?(Z|[+-](0[0-9]|1[0-9]|2[0-3]):[0-5][0-9])$')
 OR ((f->>'releasedAt') IS NOT NULL AND (f->>'releasedAt') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T(0[0-9]|1[0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]{1,6})?(Z|[+-](0[0-9]|1[0-9]|2[0-3]):[0-5][0-9])$') THEN RETURN false; END IF;
 fact_id:=(f->>'id')::uuid; st:=(f->>'startsAt')::timestamptz;
 en:=(f->>'endsAt')::timestamptz; rel:=(f->>'releasedAt')::timestamptz;
 RETURN fact_id IS NOT NULL AND isfinite(st) AND st<=checked_at
 AND (en IS NULL OR (isfinite(en) AND en>st))
 AND (rel IS NULL OR (isfinite(rel) AND rel>=st AND rel<=checked_at));
EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow OR invalid_datetime_format THEN RETURN false;
END $$;
CREATE FUNCTION whaleu_safety.require_errand_restriction_snapshot(snapshot_ref uuid,subject_ref uuid,checked_at timestamptz) RETURNS void LANGUAGE plpgsql AS $$
DECLARE s whaleu_safety.errand_feature_snapshots; f jsonb; total integer; distinct_ids integer;
BEGIN
 SELECT * INTO s FROM whaleu_safety.errand_feature_snapshots WHERE id=snapshot_ref AND account_id=subject_ref;
 IF s.id IS NULL OR s.coverage<>'complete' OR s.provenance<>'accepted'
 OR whaleu_safety.errand_restriction_nonblank(s.source_reference) IS NOT TRUE OR whaleu_safety.errand_restriction_nonblank(s.policy_reference) IS NOT TRUE
 OR NOT isfinite(s.effective_at) OR s.effective_at>checked_at
 OR (s.valid_until IS NOT NULL AND (NOT isfinite(s.valid_until) OR s.valid_until<=checked_at))
 OR NOT isfinite(checked_at) THEN PERFORM whaleu_safety.errand_restriction_unavailable(); END IF;
 FOR f IN SELECT value FROM jsonb_array_elements(s.restrictions) LOOP
  IF whaleu_safety.errand_restriction_fact_valid(f,checked_at,
    EXISTS(SELECT 1 FROM whaleu_safety.errand_restriction_materializations m
    JOIN whaleu_safety.errand_restriction_definitions definition ON definition.subject_id=s.account_id AND definition.terms=f AND definition.origin='local'
    JOIN whaleu_safety.errand_restriction_events issued ON issued.restriction_id=definition.id AND issued.command_id=definition.command_id AND issued.kind='issued'
    JOIN whaleu_safety.errand_restriction_materializations creation ON creation.command_id=definition.command_id AND creation.source_event_id=issued.id
    WHERE m.snapshot_id=s.id)) IS NOT TRUE THEN PERFORM whaleu_safety.errand_restriction_unavailable(); END IF;
  -- A shape-valid legacy envelope cannot borrow another subject's canonical UUID
  -- or contradict already recorded immutable terms. Original terms remain valid
  -- when checking a historical predecessor after its terminal event is appended;
  -- adoption separately requires exact terminal markers or whole-fact omission.
  IF EXISTS(SELECT 1 FROM whaleu_safety.errand_restriction_definitions known
  WHERE known.id=(f->>'id')::uuid AND (known.subject_id<>s.account_id OR
   (known.terms<>f AND NOT ((known.terms-'releasedAt')=(f-'releasedAt') AND EXISTS(
    SELECT 1 FROM whaleu_safety.errand_restriction_heads h JOIN whaleu_safety.errand_restriction_events cause ON cause.id=h.event_id
    WHERE h.restriction_id=known.id AND cause.kind IN ('manually_released','superseded')
    AND (f->>'releasedAt')::timestamptz=cause.effective_at)))))
  THEN PERFORM whaleu_safety.errand_restriction_unavailable(); END IF;
 END LOOP;
 SELECT count(*),count(DISTINCT (value->>'id')::uuid) INTO total,distinct_ids FROM jsonb_array_elements(s.restrictions);
 IF total<>distinct_ids THEN PERFORM whaleu_safety.errand_restriction_unavailable(); END IF;
END $$;

CREATE FUNCTION whaleu_safety.validate_errand_restriction_definition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c whaleu_safety.errand_restriction_commands; s whaleu_safety.errand_feature_snapshots;
BEGIN
 SELECT * INTO c FROM whaleu_safety.errand_restriction_commands WHERE id=NEW.command_id;
 IF c.subject_id IS DISTINCT FROM NEW.subject_id OR NEW.recorded_at<>c.occurred_at
 OR whaleu_safety.errand_restriction_fact_valid(NEW.terms,NEW.recorded_at,NEW.origin='local') IS NOT TRUE
 OR (NEW.terms->>'id')::uuid<>NEW.id OR NEW.terms->>'action'<>NEW.action OR NEW.terms->>'reason'<>NEW.reason
 OR (NEW.terms->>'startsAt')::timestamptz<>NEW.starts_at
 OR (NEW.terms->>'endsAt')::timestamptz IS DISTINCT FROM NEW.ends_at
 OR (NEW.terms->>'releasedAt')::timestamptz IS DISTINCT FROM NEW.baseline_released_at
 THEN PERFORM whaleu_safety.errand_restriction_unavailable(); END IF;
 IF NEW.origin='local' THEN
  IF NEW.actor_id IS DISTINCT FROM c.actor_id OR NEW.source_order_id IS DISTINCT FROM c.order_id
  OR c.operation='release' OR NEW.starts_at<>c.occurred_at OR (c.kind='order' AND NEW.action<>'all')
  OR NEW.terms->>'issuer' IS DISTINCT FROM 'whaleu:errand-management:v1' OR NEW.terms->>'sourceReference' IS DISTINCT FROM c.id::text THEN PERFORM whaleu_safety.errand_restriction_unavailable(); END IF;
 ELSE
  SELECT * INTO s FROM whaleu_safety.errand_feature_snapshots WHERE id=NEW.baseline_snapshot_id AND account_id=NEW.subject_id;
  IF s.id IS NULL OR NOT (s.restrictions @> jsonb_build_array(NEW.terms)) THEN PERFORM whaleu_safety.errand_restriction_unavailable(); END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER errand_restriction_definition_causal BEFORE INSERT ON whaleu_safety.errand_restriction_definitions FOR EACH ROW EXECUTE FUNCTION whaleu_safety.validate_errand_restriction_definition();
CREATE FUNCTION whaleu_safety.validate_errand_restriction_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d whaleu_safety.errand_restriction_definitions; c whaleu_safety.errand_restriction_commands; p whaleu_safety.errand_restriction_events; replacement whaleu_safety.errand_restriction_definitions; head uuid;
BEGIN
 SELECT * INTO d FROM whaleu_safety.errand_restriction_definitions WHERE id=NEW.restriction_id;
 SELECT * INTO c FROM whaleu_safety.errand_restriction_commands WHERE id=NEW.command_id;
 SELECT event_id INTO head FROM whaleu_safety.errand_restriction_heads WHERE restriction_id=d.id;
 IF c.subject_id IS DISTINCT FROM d.subject_id OR NEW.effective_at<>c.occurred_at OR NEW.recorded_at<>c.occurred_at THEN PERFORM whaleu_safety.errand_restriction_unavailable(); END IF;
 IF NEW.kind IN ('issued','observed_baseline') THEN
  IF head IS NOT NULL OR d.command_id<>c.id OR (NEW.kind='issued')<>(d.origin='local')
  OR (NEW.kind='issued' AND (NEW.reason IS DISTINCT FROM d.reason OR c.operation='release')) THEN PERFORM whaleu_safety.errand_restriction_unavailable(); END IF;
 ELSE
  SELECT * INTO p FROM whaleu_safety.errand_restriction_events WHERE id=NEW.previous_event_id;
  IF head IS DISTINCT FROM p.id OR p.restriction_id IS DISTINCT FROM d.id OR p.kind NOT IN ('issued','observed_baseline')
  OR p.effective_at>NEW.effective_at OR d.starts_at>NEW.effective_at OR d.baseline_released_at IS NOT NULL
  OR (d.ends_at IS NOT NULL AND d.ends_at<=NEW.effective_at) THEN PERFORM whaleu_safety.errand_restriction_unavailable(); END IF;
  IF NEW.kind='manually_released' THEN
   IF c.kind<>'global' OR c.operation<>'release' THEN PERFORM whaleu_safety.errand_restriction_unavailable(); END IF;
  ELSE
   SELECT * INTO replacement FROM whaleu_safety.errand_restriction_definitions WHERE id=NEW.replacement_restriction_id;
   IF replacement.id IS NULL OR replacement.id=d.id OR replacement.subject_id<>d.subject_id OR replacement.action<>d.action
   OR replacement.command_id<>c.id OR replacement.origin<>'local' OR c.operation='release' THEN PERFORM whaleu_safety.errand_restriction_unavailable(); END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER errand_restriction_event_causal BEFORE INSERT ON whaleu_safety.errand_restriction_events FOR EACH ROW EXECUTE FUNCTION whaleu_safety.validate_errand_restriction_event();
CREATE FUNCTION whaleu_safety.validate_errand_restriction_head() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e whaleu_safety.errand_restriction_events;
BEGIN
 IF TG_OP='DELETE' THEN PERFORM whaleu_safety.errand_restriction_unavailable(); END IF;
 SELECT * INTO e FROM whaleu_safety.errand_restriction_events WHERE id=NEW.event_id AND restriction_id=NEW.restriction_id;
 IF e.id IS NULL OR (TG_OP='INSERT' AND e.previous_event_id IS NOT NULL)
 OR (TG_OP='UPDATE' AND (NEW.restriction_id<>OLD.restriction_id OR e.previous_event_id IS DISTINCT FROM OLD.event_id)) THEN PERFORM whaleu_safety.errand_restriction_unavailable(); END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER errand_restriction_head_causal BEFORE INSERT OR UPDATE OR DELETE ON whaleu_safety.errand_restriction_heads FOR EACH ROW EXECUTE FUNCTION whaleu_safety.validate_errand_restriction_head();
-- Every adopted complete authority reconciles known local/baseline definitions.
-- Missing/conflicting envelopes remain fail-closed and cannot later erase an
-- effective definition or resurrect one with a terminal cause.
CREATE FUNCTION whaleu_safety.reconcile_errand_restriction_head() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s whaleu_safety.errand_feature_snapshots; d record; f jsonb; active boolean; m whaleu_safety.errand_restriction_materializations;
BEGIN
 SELECT * INTO s FROM whaleu_safety.errand_feature_snapshots WHERE id=NEW.snapshot_id AND account_id=NEW.account_id;
 SELECT * INTO m FROM whaleu_safety.errand_restriction_materializations WHERE snapshot_id=NEW.snapshot_id;
 IF m.snapshot_id IS NOT NULL AND (TG_OP<>'UPDATE' OR m.predecessor_snapshot_id IS DISTINCT FROM OLD.snapshot_id) THEN PERFORM whaleu_safety.errand_restriction_unavailable(); END IF;
 IF s.coverage<>'complete' OR s.provenance<>'accepted' OR NOT EXISTS(SELECT 1 FROM whaleu_safety.errand_restriction_definitions WHERE subject_id=s.account_id) THEN RETURN NEW; END IF;
 PERFORM whaleu_safety.require_errand_restriction_snapshot(s.id,s.account_id,clock_timestamp());
 FOR d IN SELECT definition.*,event.kind,event.effective_at terminal_at
 FROM whaleu_safety.errand_restriction_definitions definition
 JOIN whaleu_safety.errand_restriction_heads head ON head.restriction_id=definition.id
 JOIN whaleu_safety.errand_restriction_events event ON event.id=head.event_id
 WHERE definition.subject_id=s.account_id AND (
 (event.kind IN ('issued','observed_baseline') AND definition.baseline_released_at IS NULL AND definition.starts_at<=s.effective_at AND (definition.ends_at IS NULL OR definition.ends_at>s.effective_at))
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(s.restrictions) fact WHERE (fact->>'id')::uuid=definition.id)) LOOP
  SELECT value INTO f FROM jsonb_array_elements(s.restrictions) WHERE (value->>'id')::uuid=d.id;
  active:=d.kind IN ('issued','observed_baseline') AND d.baseline_released_at IS NULL
   AND d.starts_at<=s.effective_at AND (d.ends_at IS NULL OR d.ends_at>s.effective_at);
  IF active AND f IS DISTINCT FROM d.terms THEN PERFORM whaleu_safety.errand_restriction_unavailable(); END IF;
  IF f IS NOT NULL AND (f-'releasedAt') IS DISTINCT FROM (d.terms-'releasedAt') THEN PERFORM whaleu_safety.errand_restriction_unavailable(); END IF;
  IF f IS NOT NULL AND NOT active AND f->>'releasedAt' IS NULL
   AND (d.ends_at IS NULL OR d.ends_at>s.effective_at) THEN PERFORM whaleu_safety.errand_restriction_unavailable(); END IF;
  IF f IS NOT NULL AND ((d.kind IN ('manually_released','superseded') AND (f->>'releasedAt')::timestamptz IS DISTINCT FROM d.terminal_at)
   OR (d.baseline_released_at IS NOT NULL AND (f->>'releasedAt')::timestamptz IS DISTINCT FROM d.baseline_released_at)) THEN PERFORM whaleu_safety.errand_restriction_unavailable(); END IF;
 END LOOP;
 RETURN NEW;
END $$;
CREATE TRIGGER errand_feature_head_reconcile BEFORE INSERT OR UPDATE ON whaleu_safety.errand_feature_heads FOR EACH ROW EXECUTE FUNCTION whaleu_safety.reconcile_errand_restriction_head();

-- Materialization is registered BEFORE adoption, while the predecessor is still
-- the actual locked head. A head-first/intent-later write order is rejected too.
CREATE FUNCTION whaleu_safety.prepare_errand_restriction_materialization() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE subject_ref uuid; actual_predecessor uuid;
BEGIN
 SELECT subject_id INTO subject_ref FROM whaleu_safety.errand_restriction_commands WHERE id=NEW.command_id;
 SELECT snapshot_id INTO actual_predecessor FROM whaleu_safety.errand_feature_heads WHERE account_id=subject_ref FOR UPDATE;
 IF actual_predecessor IS DISTINCT FROM NEW.predecessor_snapshot_id THEN PERFORM whaleu_safety.errand_restriction_unavailable(); END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER errand_restriction_materialization_predecessor BEFORE INSERT ON whaleu_safety.errand_restriction_materializations FOR EACH ROW EXECUTE FUNCTION whaleu_safety.prepare_errand_restriction_materialization();

CREATE FUNCTION whaleu_safety.validate_errand_restriction_materialization() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s whaleu_safety.errand_feature_snapshots; p whaleu_safety.errand_feature_snapshots; c whaleu_safety.errand_restriction_commands; e whaleu_safety.errand_restriction_events; expected jsonb;
BEGIN
 SELECT * INTO s FROM whaleu_safety.errand_feature_snapshots WHERE id=NEW.snapshot_id;
 SELECT * INTO p FROM whaleu_safety.errand_feature_snapshots WHERE id=NEW.predecessor_snapshot_id;
 SELECT * INTO c FROM whaleu_safety.errand_restriction_commands WHERE id=NEW.command_id;
 SELECT * INTO e FROM whaleu_safety.errand_restriction_events WHERE id=NEW.source_event_id;
 IF s.management_created_xid IS DISTINCT FROM pg_current_xact_id() OR s.account_id IS DISTINCT FROM c.subject_id OR p.account_id IS DISTINCT FROM c.subject_id
 OR s.effective_at<=p.effective_at OR s.effective_at<c.occurred_at OR s.effective_at>clock_timestamp()
 OR s.valid_until IS DISTINCT FROM p.valid_until OR s.source_reference<>p.source_reference OR s.policy_reference<>p.policy_reference
 OR s.coverage<>'complete' OR s.provenance<>'accepted' OR p.coverage<>'complete' OR p.provenance<>'accepted'
 OR e.command_id IS DISTINCT FROM c.id OR e.kind NOT IN ('issued','manually_released')
 OR (c.operation='release')<>(e.kind='manually_released')
 OR NOT EXISTS(SELECT 1 FROM whaleu_safety.errand_feature_heads WHERE account_id=c.subject_id AND snapshot_id=s.id)
 THEN PERFORM whaleu_safety.errand_restriction_unavailable(); END IF;
 PERFORM whaleu_safety.require_errand_restriction_snapshot(p.id,p.account_id,c.occurred_at);
 PERFORM whaleu_safety.require_errand_restriction_snapshot(s.id,s.account_id,clock_timestamp());
 SELECT coalesce(jsonb_agg(d.terms ORDER BY d.id),'[]'::jsonb) INTO expected
 FROM whaleu_safety.errand_restriction_definitions d
 JOIN whaleu_safety.errand_restriction_heads h ON h.restriction_id=d.id
 JOIN whaleu_safety.errand_restriction_events terminal ON terminal.id=h.event_id
 WHERE d.subject_id=c.subject_id AND terminal.kind IN ('issued','observed_baseline')
 AND d.baseline_released_at IS NULL AND d.starts_at<=s.effective_at AND (d.ends_at IS NULL OR d.ends_at>s.effective_at);
 IF s.restrictions<>expected OR jsonb_array_length(expected)>256 THEN PERFORM whaleu_safety.errand_restriction_unavailable(); END IF;
 IF e.kind='issued' AND EXISTS(SELECT 1 FROM whaleu_safety.errand_restriction_definitions d
 JOIN whaleu_safety.errand_restriction_heads h ON h.restriction_id=d.id JOIN whaleu_safety.errand_restriction_events terminal ON terminal.id=h.event_id
 JOIN whaleu_safety.errand_restriction_definitions replacement ON replacement.id=e.restriction_id
 WHERE d.subject_id=c.subject_id AND d.id<>replacement.id AND d.action=replacement.action
 AND terminal.kind IN ('issued','observed_baseline') AND d.baseline_released_at IS NULL AND d.starts_at<=c.occurred_at
 AND (d.ends_at IS NULL OR d.ends_at>c.occurred_at)) THEN PERFORM whaleu_safety.errand_restriction_unavailable(); END IF;
 -- Full predecessor enrollment prevents compaction from deleting unknown terms.
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p.restrictions) f
 WHERE NOT EXISTS(SELECT 1 FROM whaleu_safety.errand_restriction_definitions d
 WHERE d.id=(f->>'id')::uuid AND d.subject_id=c.subject_id AND (d.terms=f OR ((d.terms-'releasedAt')=(f-'releasedAt')
 AND EXISTS(SELECT 1 FROM whaleu_safety.errand_restriction_heads h JOIN whaleu_safety.errand_restriction_events terminal_proof ON terminal_proof.id=h.event_id
 WHERE h.restriction_id=d.id AND terminal_proof.kind IN ('manually_released','superseded') AND (f->>'releasedAt')::timestamptz=terminal_proof.effective_at))))) THEN PERFORM whaleu_safety.errand_restriction_unavailable(); END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER errand_restriction_materialization_complete AFTER INSERT ON whaleu_safety.errand_restriction_materializations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_safety.validate_errand_restriction_materialization();
CREATE FUNCTION whaleu_safety.require_errand_restriction_command() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE primary_count integer;
BEGIN
 PERFORM whaleu_authorization.require_errand_management_authority(NEW.actor_id,NEW.session_id,NEW.grant_id,NEW.target_region_id);
 IF NEW.occurred_at>clock_timestamp() OR NEW.occurred_at<transaction_timestamp() THEN PERFORM whaleu_safety.errand_restriction_unavailable(); END IF;
 IF NEW.kind='global' AND NOT EXISTS(SELECT 1 FROM whaleu_safety.errand_restriction_requests r
 WHERE r.account_id=NEW.actor_id AND r.request_id=NEW.request_id AND r.operation=NEW.operation
 AND r.session_id=NEW.session_id AND r.grant_id=NEW.grant_id AND r.receipt->>'outcome'='applied'
 AND EXISTS(SELECT 1 FROM whaleu_safety.errand_restriction_events e WHERE e.command_id=NEW.id AND e.kind IN ('issued','manually_released')
 AND e.id::text=r.receipt->>'eventId' AND e.restriction_id::text=r.receipt->>'restrictionId')) THEN PERFORM whaleu_safety.errand_restriction_unavailable(); END IF;
 IF NEW.kind='order' AND NOT EXISTS(SELECT 1 FROM whaleu_errands.requests r JOIN whaleu_errands.orders o ON o.id=NEW.order_id
 WHERE r.account_id=NEW.actor_id AND r.request_id=NEW.request_id AND r.operation=NEW.operation AND r.receipt->>'outcome'='applied'
 AND r.receipt->>'orderId'=NEW.order_id::text AND o.target_region_id=NEW.target_region_id
 AND ((NEW.operation='admin_delete' AND NEW.subject_id=o.publisher_id AND NEW.actor_id<>o.publisher_id)
 OR (NEW.operation='restrict_accepter' AND NEW.subject_id=o.accepter_id AND o.state IN ('accepted','completed') AND o.deleted_at IS NULL))) THEN PERFORM whaleu_safety.errand_restriction_unavailable(); END IF;
 SELECT count(*) INTO primary_count FROM whaleu_safety.errand_restriction_events WHERE command_id=NEW.id AND kind IN ('issued','manually_released');
 IF primary_count<>1 OR NOT EXISTS(SELECT 1 FROM whaleu_safety.errand_restriction_materializations WHERE command_id=NEW.id) THEN PERFORM whaleu_safety.errand_restriction_unavailable(); END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER errand_restriction_command_complete AFTER INSERT ON whaleu_safety.errand_restriction_commands DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_safety.require_errand_restriction_command();
CREATE FUNCTION whaleu_safety.require_errand_restriction_event_head() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM whaleu_safety.errand_restriction_heads WHERE restriction_id=NEW.restriction_id AND event_id=NEW.id)
 AND NOT EXISTS(SELECT 1 FROM whaleu_safety.errand_restriction_events WHERE previous_event_id=NEW.id) THEN PERFORM whaleu_safety.errand_restriction_unavailable(); END IF;
 IF NOT EXISTS(SELECT 1 FROM whaleu_safety.errand_restriction_materializations WHERE command_id=NEW.command_id) THEN PERFORM whaleu_safety.errand_restriction_unavailable(); END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER errand_restriction_event_complete AFTER INSERT ON whaleu_safety.errand_restriction_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_safety.require_errand_restriction_event_head();
CREATE FUNCTION whaleu_safety.require_errand_restriction_definition_head() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.origin='local' AND NOT EXISTS(SELECT 1 FROM whaleu_safety.errand_restriction_materializations m JOIN whaleu_safety.errand_feature_snapshots s ON s.id=m.predecessor_snapshot_id WHERE m.command_id=NEW.command_id AND s.policy_reference=NEW.terms->>'policyReference'))
 OR (NEW.origin='baseline' AND NOT EXISTS(SELECT 1 FROM whaleu_safety.errand_restriction_materializations WHERE command_id=NEW.command_id AND predecessor_snapshot_id=NEW.baseline_snapshot_id))
 OR NOT EXISTS(SELECT 1 FROM whaleu_safety.errand_restriction_heads WHERE restriction_id=NEW.id)
 OR NOT EXISTS(SELECT 1 FROM whaleu_safety.errand_restriction_events WHERE restriction_id=NEW.id AND previous_event_id IS NULL AND command_id=NEW.command_id)
 THEN PERFORM whaleu_safety.errand_restriction_unavailable(); END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER errand_restriction_definition_complete AFTER INSERT ON whaleu_safety.errand_restriction_definitions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_safety.require_errand_restriction_definition_head();
CREATE FUNCTION whaleu_safety.freeze_errand_restriction_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR OLD.receipt IS NOT NULL OR
 ROW(NEW.account_id,NEW.request_id,NEW.session_id,NEW.grant_id,NEW.operation,NEW.intent_hash,NEW.intent)
 IS DISTINCT FROM ROW(OLD.account_id,OLD.request_id,OLD.session_id,OLD.grant_id,OLD.operation,OLD.intent_hash,OLD.intent)
 THEN PERFORM whaleu_safety.errand_restriction_unavailable(); END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER errand_restriction_request_immutable BEFORE UPDATE OR DELETE ON whaleu_safety.errand_restriction_requests FOR EACH ROW EXECUTE FUNCTION whaleu_safety.freeze_errand_restriction_request();
CREATE FUNCTION whaleu_safety.require_errand_restriction_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r whaleu_safety.errand_restriction_requests; e whaleu_safety.errand_restriction_events; c whaleu_safety.errand_restriction_commands; d whaleu_safety.errand_restriction_definitions; command jsonb;
BEGIN
 SELECT * INTO r FROM whaleu_safety.errand_restriction_requests WHERE account_id=NEW.account_id AND request_id=NEW.request_id;
 PERFORM whaleu_authorization.require_errand_management_authority(r.account_id,r.session_id,r.grant_id,NULL);
 command:=r.intent->'command';
 IF jsonb_typeof(command) IS DISTINCT FROM 'object' OR command->>'clientRequestId' IS DISTINCT FROM r.request_id::text
 OR jsonb_typeof(command->'reason') IS DISTINCT FROM 'string' OR length(command->>'reason') NOT BETWEEN 1 AND 255
 OR (r.operation='issue' AND ((SELECT count(*) FROM jsonb_object_keys(r.intent))<>1
 OR NOT (command ?& ARRAY['clientRequestId','targetProfileId','action','reason','duration']) OR (SELECT count(*) FROM jsonb_object_keys(command))<>5
 OR (command->>'action' IN ('publish','accept','all')) IS NOT TRUE OR jsonb_typeof(command->'targetProfileId') IS DISTINCT FROM 'string'))
 OR (r.operation='release' AND (NOT (r.intent ?& ARRAY['restrictionId','command']) OR (SELECT count(*) FROM jsonb_object_keys(r.intent))<>2
 OR NOT (command ?& ARRAY['clientRequestId','reason']) OR (SELECT count(*) FROM jsonb_object_keys(command))<>2))
 THEN PERFORM whaleu_safety.errand_restriction_unavailable(); END IF;
 IF r.receipt IS NULL OR r.receipt->>'requestId' IS DISTINCT FROM r.request_id::text OR r.receipt->>'operation' IS DISTINCT FROM r.operation THEN PERFORM whaleu_safety.errand_restriction_unavailable(); END IF;
 IF r.receipt->>'outcome'='applied' THEN
  SELECT * INTO e FROM whaleu_safety.errand_restriction_events WHERE id=(r.receipt->>'eventId')::uuid;
  SELECT * INTO c FROM whaleu_safety.errand_restriction_commands WHERE id=e.command_id;
  SELECT * INTO d FROM whaleu_safety.errand_restriction_definitions WHERE id=e.restriction_id;
  IF (SELECT count(*) FROM jsonb_object_keys(r.receipt))<>6 OR c.actor_id IS DISTINCT FROM r.account_id
  OR c.request_id IS DISTINCT FROM r.request_id OR c.kind IS DISTINCT FROM 'global' OR c.operation IS DISTINCT FROM r.operation
  OR e.restriction_id::text IS DISTINCT FROM r.receipt->>'restrictionId'
  OR e.effective_at IS DISTINCT FROM (r.receipt->>'occurredAt')::timestamptz
  OR (r.operation='issue' AND (e.kind<>'issued' OR d.action IS DISTINCT FROM command->>'action' OR d.reason IS DISTINCT FROM command->>'reason'
  OR d.ends_at IS DISTINCT FROM whaleu_safety.errand_restriction_end(d.starts_at,command->'duration')
  OR NOT EXISTS(SELECT 1 FROM whaleu_profile.profiles WHERE public_id=(command->>'targetProfileId')::uuid AND account_id=d.subject_id)))
  OR (r.operation='release' AND (e.kind<>'manually_released' OR e.restriction_id IS DISTINCT FROM (r.intent->>'restrictionId')::uuid
  OR e.reason IS DISTINCT FROM command->>'reason')) THEN PERFORM whaleu_safety.errand_restriction_unavailable(); END IF;
 ELSIF r.receipt->>'outcome'='rejected' THEN
  IF (SELECT count(*) FROM jsonb_object_keys(r.receipt))<>4 OR NOT (r.receipt ?& ARRAY['requestId','operation','outcome','code']) OR (r.receipt->>'code' IN
  ('ERRAND_RESTRICTION_TARGET_NOT_FOUND','ERRAND_RESTRICTION_TARGET_PROTECTED','ERRAND_RESTRICTION_NOT_FOUND','ERRAND_RESTRICTION_NOT_ACTIVE')) IS NOT TRUE
  OR EXISTS(SELECT 1 FROM whaleu_safety.errand_restriction_commands WHERE actor_id=r.account_id AND request_id=r.request_id AND kind='global') THEN PERFORM whaleu_safety.errand_restriction_unavailable(); END IF;
 ELSE PERFORM whaleu_safety.errand_restriction_unavailable(); END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER errand_restriction_request_complete AFTER INSERT OR UPDATE ON whaleu_safety.errand_restriction_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_safety.require_errand_restriction_receipt();
-- New ledger writers participate in the existing owner gate. Raw grant writers
-- do not: new-sanction target absence remains the final Authorization NOWAIT proof.
DO $$ DECLARE table_name text; BEGIN
 FOREACH table_name IN ARRAY ARRAY['errand_restriction_requests','errand_restriction_commands','errand_restriction_definitions','errand_restriction_events','errand_restriction_heads','errand_restriction_materializations'] LOOP
  EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_safety.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_errands.authority_writer_gate()',table_name||'_writer',table_name);
 END LOOP;
 FOREACH table_name IN ARRAY ARRAY['errand_restriction_commands','errand_restriction_definitions','errand_restriction_events','errand_restriction_materializations'] LOOP
  EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON whaleu_safety.%I FOR EACH ROW EXECUTE FUNCTION whaleu_errands.immutable_row()',table_name||'_immutable',table_name);
 END LOOP;
 FOREACH table_name IN ARRAY ARRAY['errand_restriction_requests','errand_restriction_commands','errand_restriction_definitions','errand_restriction_events','errand_restriction_heads','errand_restriction_materializations'] LOOP
  EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON whaleu_safety.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_errands.immutable_row()',table_name||'_durable',table_name);
 END LOOP;
END $$;
ALTER TABLE whaleu_safety.errand_restriction_events ADD COLUMN sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE;

CREATE FUNCTION whaleu_safety.errand_restriction_effective(f jsonb,checked_at timestamptz) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT (f->>'startsAt')::timestamptz<=checked_at AND f->>'releasedAt' IS NULL
 AND ((f->>'endsAt') IS NULL OR (f->>'endsAt')::timestamptz>checked_at)
$$;

-- Never let a raw OVERRIDING SYSTEM VALUE insert hide a causal source change
-- behind an already observed sourceVersion. The owner gate serializes inserts.
CREATE FUNCTION whaleu_safety.stamp_errand_restriction_event_sequence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.sequence:=nextval(pg_get_serial_sequence('whaleu_safety.errand_restriction_events','sequence')); RETURN NEW; END $$;
CREATE TRIGGER errand_restriction_event_sequence BEFORE INSERT ON whaleu_safety.errand_restriction_events FOR EACH ROW EXECUTE FUNCTION whaleu_safety.stamp_errand_restriction_event_sequence();
