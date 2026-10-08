-- Explicit, authenticated cosmetic repair only. This migration creates no roles,
-- invokes no repair, and makes no claim of historical population completeness.
-- A run is a finite, bounded live keyset sweep: late visibility or eligibility
-- behind its cursor requires another run. Each transaction visits at most one owner.
CREATE TABLE whaleu_experience.maintenance_requests (
  actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
  request_id uuid NOT NULL,
  intent_hash text NOT NULL CHECK(intent_hash ~ '^[a-f0-9]{64}$'),
  operation text NOT NULL CHECK(operation IN ('repair_level_titles','repair_default_title')),
  run_id uuid NOT NULL,
  previous_request_id uuid,
  run_started_at timestamptz NOT NULL CHECK(isfinite(run_started_at)),
  upper_account_id uuid REFERENCES whaleu_identity.accounts(id),
  cursor_before uuid REFERENCES whaleu_identity.accounts(id),
  cursor_after uuid REFERENCES whaleu_identity.accounts(id),
  grant_id uuid NOT NULL REFERENCES whaleu_authorization.role_grants(id),
  -- Metadata, not a retention FK: expired sessions may be cleaned up independently.
  session_id uuid NOT NULL,
  decided_at timestamptz NOT NULL CHECK(isfinite(decided_at)),
  receipt jsonb NOT NULL,
  creation_transaction xid8 NOT NULL,
  PRIMARY KEY(actor_id,request_id),
  UNIQUE(actor_id,request_id,creation_transaction),
  UNIQUE(creation_transaction),
  FOREIGN KEY(actor_id,previous_request_id) REFERENCES whaleu_experience.maintenance_requests(actor_id,request_id),
  FOREIGN KEY(actor_id,run_id) REFERENCES whaleu_experience.maintenance_requests(actor_id,request_id) DEFERRABLE INITIALLY DEFERRED,
  CHECK(previous_request_id IS NULL OR previous_request_id<>request_id),
  CHECK((previous_request_id IS NULL AND run_id=request_id AND cursor_before IS NULL) OR
    (previous_request_id IS NOT NULL AND run_id<>request_id)),
  CHECK(upper_account_id IS NOT NULL OR (cursor_before IS NULL AND cursor_after IS NULL)),
  CHECK(cursor_before IS NULL OR cursor_before<=upper_account_id),
  CHECK(cursor_after IS NULL OR cursor_after<=upper_account_id),
  CHECK(cursor_before IS NULL OR (cursor_after IS NOT NULL AND cursor_after>=cursor_before)),
  CHECK(coalesce(jsonb_typeof(receipt)='object' AND
    receipt ?& ARRAY['requestId','operation','runId','previousRequestId','visited','updatedOwners','grantedTitles','skippedUnknownLevel','skippedIneligible','done'] AND
    receipt-ARRAY['requestId','operation','runId','previousRequestId','visited','updatedOwners','grantedTitles','skippedUnknownLevel','skippedIneligible','done']='{}'::jsonb AND
    receipt->'requestId'=to_jsonb(request_id::text) AND receipt->'operation'=to_jsonb(operation) AND
    receipt->'runId'=to_jsonb(run_id::text) AND receipt->'previousRequestId'=coalesce(to_jsonb(previous_request_id::text),'null'::jsonb) AND
    jsonb_typeof(receipt->'visited')='number' AND receipt->>'visited' IN ('0','1') AND
    jsonb_typeof(receipt->'updatedOwners')='number' AND receipt->>'updatedOwners' IN ('0','1') AND
    jsonb_typeof(receipt->'grantedTitles')='number' AND receipt->>'grantedTitles' ~ '^([0-9]|1[0-5])$' AND
    jsonb_typeof(receipt->'skippedUnknownLevel')='number' AND receipt->>'skippedUnknownLevel' IN ('0','1') AND
    jsonb_typeof(receipt->'skippedIneligible')='number' AND receipt->>'skippedIneligible' IN ('0','1') AND
    jsonb_typeof(receipt->'done')='boolean',false))
);
CREATE UNIQUE INDEX maintenance_one_successor ON whaleu_experience.maintenance_requests(actor_id,previous_request_id) WHERE previous_request_id IS NOT NULL;
CREATE INDEX maintenance_run ON whaleu_experience.maintenance_requests(actor_id,run_id);
CREATE TRIGGER maintenance_request_immutable BEFORE UPDATE OR DELETE ON whaleu_experience.maintenance_requests FOR EACH ROW EXECUTE FUNCTION whaleu_experience.immutable_row();

CREATE TABLE whaleu_experience.maintenance_items (
  actor_id uuid NOT NULL,
  request_id uuid NOT NULL,
  owner_id uuid NOT NULL REFERENCES whaleu_experience.owners(owner_id),
  eligible boolean NOT NULL,
  known_balance bigint CHECK(known_balance>=0),
  state_revision bigint CHECK(state_revision>=0),
  observed_level integer REFERENCES whaleu_experience.level_catalog(level),
  outcome text NOT NULL CHECK(outcome IN ('repaired','unchanged','skipped_unknown_level','skipped_ineligible')),
  granted_title_keys text[] NOT NULL CHECK(cardinality(granted_title_keys) BETWEEN 0 AND 15 AND array_position(granted_title_keys,NULL) IS NULL),
  decided_at timestamptz NOT NULL CHECK(isfinite(decided_at)),
  creation_transaction xid8 NOT NULL,
  PRIMARY KEY(actor_id,request_id,owner_id),
  UNIQUE(actor_id,request_id),
  UNIQUE(actor_id,request_id,owner_id,creation_transaction),
  FOREIGN KEY(actor_id,request_id,creation_transaction) REFERENCES whaleu_experience.maintenance_requests(actor_id,request_id,creation_transaction),
  CHECK((known_balance IS NULL)=(state_revision IS NULL) AND (known_balance IS NULL)=(observed_level IS NULL)),
  CHECK((outcome='repaired')=(cardinality(granted_title_keys)>0)),
  CHECK(outcome<>'skipped_unknown_level' OR (eligible AND known_balance IS NULL)),
  CHECK((outcome='skipped_ineligible')=(NOT eligible))
);
CREATE TRIGGER maintenance_item_immutable BEFORE UPDATE OR DELETE ON whaleu_experience.maintenance_items FOR EACH ROW EXECUTE FUNCTION whaleu_experience.immutable_row();

CREATE TABLE whaleu_experience.maintenance_grants (
  actor_id uuid NOT NULL,
  request_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  title_key text NOT NULL REFERENCES whaleu_experience.title_catalog(title_key),
  creation_transaction xid8 NOT NULL,
  PRIMARY KEY(actor_id,request_id,owner_id,title_key),
  UNIQUE(owner_id,actor_id,request_id,title_key,creation_transaction),
  FOREIGN KEY(actor_id,request_id,owner_id,creation_transaction) REFERENCES whaleu_experience.maintenance_items(actor_id,request_id,owner_id,creation_transaction)
);
CREATE TRIGGER maintenance_grant_immutable BEFORE UPDATE OR DELETE ON whaleu_experience.maintenance_grants FOR EACH ROW EXECUTE FUNCTION whaleu_experience.immutable_row();

-- SQL corroborates the service's authenticated session and exact chosen grant.
-- Authentication still validates and locks the presented token in the identity
-- owner; neither a client actor ID nor cosmetic title is an authorization source.
CREATE FUNCTION whaleu_experience.require_maintenance_authority(actor uuid,session_ref uuid,grant_ref uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE account_status text; session_row whaleu_identity.sessions; grant_row whaleu_authorization.role_grants; checked_at timestamptz;
BEGIN
  SELECT status INTO account_status FROM whaleu_identity.accounts WHERE id=actor FOR SHARE;
  SELECT * INTO session_row FROM whaleu_identity.sessions WHERE id=session_ref AND account_id=actor FOR SHARE;
  SELECT * INTO grant_row FROM whaleu_authorization.role_grants WHERE id=grant_ref AND account_id=actor FOR SHARE;
  checked_at:=clock_timestamp();
  IF account_status IS DISTINCT FROM 'active' OR session_row.id IS NULL OR session_row.revoked_at IS NOT NULL OR
    grant_row.id IS NULL OR grant_row.role NOT IN ('developer','super_admin') OR grant_row.operating_region_id IS NOT NULL OR
    grant_row.revoked_at IS NOT NULL OR grant_row.valid_from>checked_at THEN
    RAISE EXCEPTION 'Maintenance lacks live global actor authority' USING ERRCODE='23514';
  END IF;
  -- Stable diagnostics let only these deadline failures use the same public
  -- semantics as transaction finalization, without exposing SQL proof details.
  IF session_row.access_expires_at<=checked_at OR session_row.absolute_expires_at<=checked_at THEN
    RAISE EXCEPTION 'Maintenance session expired' USING ERRCODE='23514',CONSTRAINT='maintenance_session_expired';
  END IF;
  IF grant_row.expires_at IS NOT NULL AND grant_row.expires_at<=checked_at THEN
    RAISE EXCEPTION 'Maintenance authority expired' USING ERRCODE='23514',CONSTRAINT='maintenance_authorization_expired';
  END IF;
END $$;

CREATE FUNCTION whaleu_experience.maintenance_request_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous whaleu_experience.maintenance_requests; actual_upper uuid; candidates uuid[]; expected_after uuid;
BEGIN
  PERFORM whaleu_experience.require_maintenance_authority(NEW.actor_id,NEW.session_id,NEW.grant_id);
  IF NEW.previous_request_id IS NULL THEN
    IF NEW.run_id<>NEW.request_id OR NEW.cursor_before IS NOT NULL OR
      NEW.run_started_at<date_trunc('milliseconds',transaction_timestamp()) OR NEW.run_started_at>clock_timestamp() THEN
      RAISE EXCEPTION 'Maintenance start boundary is invalid' USING ERRCODE='23514';
    END IF;
    SELECT id INTO actual_upper FROM whaleu_identity.accounts WHERE created_at<=NEW.run_started_at ORDER BY id DESC LIMIT 1;
    IF NEW.upper_account_id IS DISTINCT FROM actual_upper THEN
      RAISE EXCEPTION 'Maintenance upper boundary disagrees with live sweep' USING ERRCODE='23514';
    END IF;
  ELSE
    SELECT * INTO previous FROM whaleu_experience.maintenance_requests WHERE actor_id=NEW.actor_id AND request_id=NEW.previous_request_id FOR UPDATE;
    IF previous.request_id IS NULL OR previous.creation_transaction=pg_current_xact_id() OR previous.receipt->'done' IS DISTINCT FROM 'false'::jsonb OR
      (NEW.operation,NEW.run_id,NEW.run_started_at,NEW.upper_account_id,NEW.cursor_before) IS DISTINCT FROM
      (previous.operation,previous.run_id,previous.run_started_at,previous.upper_account_id,previous.cursor_after) THEN
      RAISE EXCEPTION 'Maintenance continuation lacks exact committed predecessor' USING ERRCODE='23514';
    END IF;
  END IF;
  SELECT coalesce(array_agg(id ORDER BY id),'{}'::uuid[]) INTO candidates FROM (
    SELECT id FROM whaleu_identity.accounts WHERE (NEW.cursor_before IS NULL OR id>NEW.cursor_before) AND
      id<=NEW.upper_account_id AND created_at<=NEW.run_started_at ORDER BY id LIMIT 2
  ) bounded_candidates;
  expected_after:=coalesce(candidates[1],NEW.cursor_before);
  IF NEW.cursor_after IS DISTINCT FROM expected_after OR NEW.receipt->'visited' IS DISTINCT FROM to_jsonb(least(cardinality(candidates),1)) OR
    NEW.receipt->'done' IS DISTINCT FROM to_jsonb(cardinality(candidates)<2) THEN
    RAISE EXCEPTION 'Maintenance cursor cannot skip a live candidate' USING ERRCODE='23514';
  END IF;
  -- Stamped only after all authority/predecessor waits; precision matches JS Date.
  NEW.decided_at:=date_trunc('milliseconds',clock_timestamp());
  NEW.creation_transaction:=pg_current_xact_id();
  RETURN NEW;
END $$;
CREATE TRIGGER maintenance_request_guard BEFORE INSERT ON whaleu_experience.maintenance_requests FOR EACH ROW EXECUTE FUNCTION whaleu_experience.maintenance_request_guard();

CREATE FUNCTION whaleu_experience.maintenance_item_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE request_row whaleu_experience.maintenance_requests; state_row whaleu_experience.account_states; current_level integer; expected_keys text[]; expected_outcome text; provider_eligible boolean;
BEGIN
  SELECT * INTO request_row FROM whaleu_experience.maintenance_requests WHERE actor_id=NEW.actor_id AND request_id=NEW.request_id;
  IF request_row.request_id IS NULL OR request_row.creation_transaction<>pg_current_xact_id() OR
    request_row.receipt->'visited' IS DISTINCT FROM '1'::jsonb OR NEW.owner_id IS DISTINCT FROM request_row.cursor_after OR NEW.decided_at IS DISTINCT FROM request_row.decided_at THEN
    RAISE EXCEPTION 'Maintenance item lacks this transaction candidate receipt' USING ERRCODE='23514';
  END IF;
  -- The identity facade has already locked its selected provider proof before the
  -- terminal owner lock. Do not acquire a different provider-row lock here.
  -- These exact account/owner locks are reacquisitions on the service path.
  PERFORM id FROM whaleu_identity.accounts WHERE id=NEW.owner_id FOR SHARE;
  PERFORM owner_id FROM whaleu_experience.owners WHERE owner_id=NEW.owner_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Maintenance candidate lacks owner guard' USING ERRCODE='23514'; END IF;
  IF request_row.operation='repair_level_titles' THEN
    SELECT s.* INTO state_row FROM whaleu_experience.account_states s JOIN whaleu_experience.baselines b ON b.owner_id=s.owner_id WHERE s.owner_id=NEW.owner_id;
    IF NOT NEW.eligible THEN RAISE EXCEPTION 'Canonical level candidate cannot be ineligible' USING ERRCODE='23514'; END IF;
    IF state_row.owner_id IS NULL THEN
      IF NEW.known_balance IS NOT NULL OR NEW.state_revision IS NOT NULL OR NEW.observed_level IS NOT NULL THEN
        RAISE EXCEPTION 'Unknown maintenance level cannot claim a balance' USING ERRCODE='23514';
      END IF;
      expected_keys:='{}'::text[]; expected_outcome:='skipped_unknown_level';
    ELSE
      SELECT max(level) INTO current_level FROM whaleu_experience.level_catalog WHERE threshold<=state_row.balance;
      IF (NEW.known_balance,NEW.state_revision,NEW.observed_level) IS DISTINCT FROM (state_row.balance,state_row.revision,current_level) THEN
        RAISE EXCEPTION 'Maintenance level disagrees with locked known state' USING ERRCODE='23514';
      END IF;
      SELECT coalesce(array_agg(t.title_key ORDER BY t.title_key),'{}'::text[]) INTO expected_keys FROM whaleu_experience.title_catalog t
        WHERE t.kind='level' AND t.unlock_level<=current_level AND NOT EXISTS(
          SELECT 1 FROM whaleu_experience.entitlements e WHERE e.owner_id=NEW.owner_id AND e.title_key=t.title_key);
      expected_outcome:=CASE WHEN cardinality(expected_keys)>0 THEN 'repaired' ELSE 'unchanged' END;
    END IF;
  ELSIF request_row.operation='repair_default_title' THEN
    SELECT EXISTS(SELECT 1 FROM whaleu_identity.provider_identities WHERE account_id=NEW.owner_id AND provider='wechat') INTO provider_eligible;
    IF NEW.eligible IS DISTINCT FROM provider_eligible OR NEW.known_balance IS NOT NULL OR NEW.state_revision IS NOT NULL OR NEW.observed_level IS NOT NULL THEN
      RAISE EXCEPTION 'Maintenance default eligibility disagrees with canonical identity' USING ERRCODE='23514';
    END IF;
    SELECT coalesce(array_agg(t.title_key ORDER BY t.title_key),'{}'::text[]) INTO expected_keys FROM whaleu_experience.title_catalog t
      WHERE provider_eligible AND t.title_key='default_jingxiaoyu' AND t.kind='default' AND NOT EXISTS(
        SELECT 1 FROM whaleu_experience.entitlements e WHERE e.owner_id=NEW.owner_id AND e.title_key=t.title_key);
    expected_outcome:=CASE WHEN NOT provider_eligible THEN 'skipped_ineligible' WHEN cardinality(expected_keys)>0 THEN 'repaired' ELSE 'unchanged' END;
  ELSE
    RAISE EXCEPTION 'Unsupported maintenance operation' USING ERRCODE='23514';
  END IF;
  IF NEW.granted_title_keys IS DISTINCT FROM expected_keys OR NEW.outcome IS DISTINCT FROM expected_outcome THEN
    RAISE EXCEPTION 'Maintenance item must repair exactly the missing allowed titles' USING ERRCODE='23514';
  END IF;
  NEW.creation_transaction:=pg_current_xact_id();
  RETURN NEW;
END $$;
CREATE TRIGGER maintenance_item_guard BEFORE INSERT ON whaleu_experience.maintenance_items FOR EACH ROW EXECUTE FUNCTION whaleu_experience.maintenance_item_guard();

CREATE FUNCTION whaleu_experience.maintenance_grant_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM whaleu_experience.maintenance_items i WHERE i.actor_id=NEW.actor_id AND i.request_id=NEW.request_id AND i.owner_id=NEW.owner_id AND
    i.creation_transaction=pg_current_xact_id() AND i.outcome='repaired' AND NEW.title_key=ANY(i.granted_title_keys)) OR
    EXISTS(SELECT 1 FROM whaleu_experience.entitlements WHERE owner_id=NEW.owner_id AND title_key=NEW.title_key) THEN
    RAISE EXCEPTION 'Maintenance title proof requires a fresh missing allowed title' USING ERRCODE='23514';
  END IF;
  NEW.creation_transaction:=pg_current_xact_id();
  RETURN NEW;
END $$;
CREATE TRIGGER maintenance_grant_guard BEFORE INSERT ON whaleu_experience.maintenance_grants FOR EACH ROW EXECUTE FUNCTION whaleu_experience.maintenance_grant_guard();

ALTER TABLE whaleu_experience.entitlements DROP CONSTRAINT entitlements_origin_check;
ALTER TABLE whaleu_experience.entitlements ADD CONSTRAINT entitlements_origin_check CHECK(origin IN ('registration','level','synthetic_fixture','redemption','maintenance'));
ALTER TABLE whaleu_experience.entitlements ADD COLUMN maintenance_actor_id uuid;
ALTER TABLE whaleu_experience.entitlements ADD COLUMN maintenance_request_id uuid;
ALTER TABLE whaleu_experience.entitlements DROP CONSTRAINT redemption_origin;
ALTER TABLE whaleu_experience.entitlements ADD CONSTRAINT redemption_origin CHECK((origin='redemption')=(redemption_request_id IS NOT NULL) AND (origin IN ('redemption','maintenance'))=(creation_transaction IS NOT NULL));
ALTER TABLE whaleu_experience.entitlements ADD CONSTRAINT maintenance_origin CHECK((origin='maintenance')=(maintenance_actor_id IS NOT NULL) AND (origin='maintenance')=(maintenance_request_id IS NOT NULL));
ALTER TABLE whaleu_experience.entitlements ADD CONSTRAINT maintenance_proof FOREIGN KEY(owner_id,maintenance_actor_id,maintenance_request_id,title_key,creation_transaction)
  REFERENCES whaleu_experience.maintenance_grants(owner_id,actor_id,request_id,title_key,creation_transaction);

-- Preserve registration, settlement, fixture and redemption provenance, with an
-- explicit maintenance branch. An unknown origin never falls into level proof.
CREATE OR REPLACE FUNCTION whaleu_experience.projection_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s whaleu_experience.settlements; threshold_value bigint;
BEGIN
  IF NEW.origin='synthetic_fixture' THEN
    IF NOT whaleu_experience.synthetic_fixture_allowed() THEN RAISE EXCEPTION 'Synthetic fixture is local test only' USING ERRCODE='23514'; END IF;
  ELSIF TG_TABLE_NAME='records' THEN
    SELECT * INTO s FROM whaleu_experience.settlements WHERE id=NEW.settlement_id;
    IF s.id IS NULL OR (NEW.nominal_delta,NEW.applied_delta,NEW.balance_after,NEW.applied_at,NEW.outcome) IS DISTINCT FROM (s.nominal_delta,s.applied_delta,s.balance_after,s.applied_at,s.outcome) THEN RAISE EXCEPTION 'Record disagrees with settlement' USING ERRCODE='23514'; END IF;
  ELSIF NEW.origin='redemption' THEN
    IF NOT EXISTS(SELECT 1 FROM whaleu_experience.redemption_decisions d JOIN whaleu_experience.title_catalog t ON t.title_key=d.title_key
      WHERE d.owner_id=NEW.owner_id AND d.request_id=NEW.redemption_request_id AND d.title_key=NEW.title_key AND d.outcome='granted'
      AND d.creation_transaction=pg_current_xact_id() AND NEW.earned_at=d.decided_at AND t.kind='limited' AND t.title_key='redeem_liangchenmeijing') THEN
      RAISE EXCEPTION 'Redemption entitlement lacks current decision' USING ERRCODE='23514';
    END IF;
    NEW.creation_transaction:=pg_current_xact_id();
  ELSIF NEW.origin='maintenance' THEN
    IF NOT EXISTS(SELECT 1 FROM whaleu_experience.maintenance_grants g
      JOIN whaleu_experience.maintenance_items i USING(actor_id,request_id,owner_id,creation_transaction)
      JOIN whaleu_experience.maintenance_requests r USING(actor_id,request_id,creation_transaction)
      JOIN whaleu_experience.title_catalog t ON t.title_key=g.title_key
      WHERE g.owner_id=NEW.owner_id AND g.actor_id=NEW.maintenance_actor_id AND g.request_id=NEW.maintenance_request_id AND g.title_key=NEW.title_key AND
      g.creation_transaction=pg_current_xact_id() AND i.outcome='repaired' AND NEW.earned_at=i.decided_at AND
      ((r.operation='repair_default_title' AND i.eligible AND t.title_key='default_jingxiaoyu' AND t.kind='default') OR
       (r.operation='repair_level_titles' AND i.eligible AND t.kind='level' AND t.unlock_level<=i.observed_level))) THEN
      RAISE EXCEPTION 'Maintenance entitlement lacks this transaction allowed title proof' USING ERRCODE='23514';
    END IF;
    NEW.creation_transaction:=pg_current_xact_id();
  ELSIF NEW.origin='registration' THEN
    IF NEW.title_key NOT IN ('default_jingxiaoyu','level_1') OR NEW.earned_at IS NULL OR NOT EXISTS(SELECT 1 FROM whaleu_experience.baselines b JOIN whaleu_identity.accounts a ON a.id=b.owner_id WHERE b.owner_id=NEW.owner_id AND b.origin='native_account_creation' AND a.local_creation_transaction=pg_current_xact_id()) THEN RAISE EXCEPTION 'Registration grant requires new account provenance' USING ERRCODE='23514'; END IF;
  ELSIF NEW.origin='level' THEN
    SELECT l.threshold INTO threshold_value FROM whaleu_experience.title_catalog t JOIN whaleu_experience.level_catalog l ON l.level=t.unlock_level WHERE t.title_key=NEW.title_key AND t.kind='level';
    SELECT * INTO s FROM whaleu_experience.settlements WHERE id=NEW.settlement_id AND owner_id=NEW.owner_id;
    IF threshold_value IS NULL OR s.id IS NULL OR s.balance_after<threshold_value OR NEW.earned_at IS DISTINCT FROM s.applied_at THEN RAISE EXCEPTION 'Level grant lacks earned proof' USING ERRCODE='23514'; END IF;
  ELSE
    RAISE EXCEPTION 'Unsupported experience projection origin' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION whaleu_experience.maintenance_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE request_row whaleu_experience.maintenance_requests; item_count bigint; repaired_count bigint; unknown_count bigint; ineligible_count bigint; grant_count bigint;
BEGIN
  SELECT * INTO request_row FROM whaleu_experience.maintenance_requests WHERE actor_id=NEW.actor_id AND request_id=NEW.request_id;
  IF request_row.request_id IS NULL OR request_row.creation_transaction<>pg_current_xact_id() THEN
    RAISE EXCEPTION 'Maintenance proof lacks a fresh terminal receipt' USING ERRCODE='23514';
  END IF;
  SELECT count(*),count(*) FILTER(WHERE outcome='repaired'),count(*) FILTER(WHERE outcome='skipped_unknown_level'),count(*) FILTER(WHERE outcome='skipped_ineligible')
    INTO item_count,repaired_count,unknown_count,ineligible_count FROM whaleu_experience.maintenance_items WHERE actor_id=NEW.actor_id AND request_id=NEW.request_id;
  SELECT count(*) INTO grant_count FROM whaleu_experience.maintenance_grants WHERE actor_id=NEW.actor_id AND request_id=NEW.request_id;
  IF request_row.receipt->'visited' IS DISTINCT FROM to_jsonb(item_count) OR request_row.receipt->'updatedOwners' IS DISTINCT FROM to_jsonb(repaired_count) OR
    request_row.receipt->'grantedTitles' IS DISTINCT FROM to_jsonb(grant_count) OR request_row.receipt->'skippedUnknownLevel' IS DISTINCT FROM to_jsonb(unknown_count) OR
    request_row.receipt->'skippedIneligible' IS DISTINCT FROM to_jsonb(ineligible_count) THEN
    RAISE EXCEPTION 'Maintenance receipt counts disagree with exact evidence' USING ERRCODE='23514';
  END IF;
  IF EXISTS(SELECT 1 FROM whaleu_experience.maintenance_items i WHERE i.actor_id=NEW.actor_id AND i.request_id=NEW.request_id AND
    i.granted_title_keys IS DISTINCT FROM (SELECT coalesce(array_agg(g.title_key ORDER BY g.title_key),'{}'::text[]) FROM whaleu_experience.maintenance_grants g
      WHERE g.actor_id=i.actor_id AND g.request_id=i.request_id AND g.owner_id=i.owner_id AND g.creation_transaction=i.creation_transaction)) OR
    EXISTS(SELECT 1 FROM whaleu_experience.maintenance_grants g JOIN whaleu_experience.maintenance_items i USING(actor_id,request_id,owner_id,creation_transaction)
      WHERE g.actor_id=NEW.actor_id AND g.request_id=NEW.request_id AND NOT EXISTS(
        SELECT 1 FROM whaleu_experience.entitlements e WHERE e.owner_id=g.owner_id AND e.title_key=g.title_key AND e.origin='maintenance' AND
        e.maintenance_actor_id=g.actor_id AND e.maintenance_request_id=g.request_id AND e.creation_transaction=g.creation_transaction AND e.earned_at=i.decided_at)) THEN
    RAISE EXCEPTION 'Maintenance grants and same-transaction entitlements are incomplete' USING ERRCODE='23514';
  END IF;
  -- Existing transaction finalization flushes every deferred proof, then checks
  -- the authenticated token and selected grant deadlines with a fresh DB clock.
  PERFORM whaleu_experience.require_maintenance_authority(request_row.actor_id,request_row.session_id,request_row.grant_id);
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER maintenance_request_complete AFTER INSERT ON whaleu_experience.maintenance_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_experience.maintenance_complete();
CREATE CONSTRAINT TRIGGER maintenance_item_complete AFTER INSERT ON whaleu_experience.maintenance_items DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_experience.maintenance_complete();
CREATE CONSTRAINT TRIGGER maintenance_grant_complete AFTER INSERT ON whaleu_experience.maintenance_grants DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_experience.maintenance_complete();
