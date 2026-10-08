-- Reviewed cosmetic metadata only. Redemption authority remains synthetic-test-only.
ALTER TABLE whaleu_experience.title_catalog DROP CONSTRAINT title_catalog_kind_check;
ALTER TABLE whaleu_experience.title_catalog ADD CONSTRAINT title_catalog_kind_check CHECK(kind IN ('default','level','limited','special'));
INSERT INTO whaleu_experience.title_catalog(title_key,name,kind,unlock_level) VALUES('redeem_liangchenmeijing','良辰美景','limited',NULL);
ALTER TABLE whaleu_experience.requests DROP CONSTRAINT requests_operation_check;
ALTER TABLE whaleu_experience.requests ADD CONSTRAINT requests_operation_check CHECK(operation IN ('sign_in','appearance','redeem_title'));
ALTER TABLE whaleu_experience.requests ADD COLUMN intent_key_version text;
ALTER TABLE whaleu_experience.requests ADD CONSTRAINT request_key_version CHECK((operation='redeem_title')=(intent_key_version IS NOT NULL) AND (intent_key_version IS NULL OR intent_key_version ~ '^[a-zA-Z0-9_-]{1,40}$'));
-- Preserve both earlier operations' exact checks verbatim, adding a separately checked branch.
DO $$ DECLARE c record; BEGIN
  FOR c IN SELECT conname,pg_get_expr(conbin,conrelid) AS expression FROM pg_constraint WHERE conrelid='whaleu_experience.requests'::regclass AND conname IN ('requests_check','receipt_strict_fields') LOOP
    EXECUTE format('ALTER TABLE whaleu_experience.requests DROP CONSTRAINT %I',c.conname);
    EXECUTE format('ALTER TABLE whaleu_experience.requests ADD CONSTRAINT %I CHECK(operation=''redeem_title'' OR (%s))',c.conname,c.expression);
  END LOOP;
END $$;
ALTER TABLE whaleu_experience.requests ADD CONSTRAINT redemption_receipt_shape CHECK(operation<>'redeem_title' OR coalesce(
  jsonb_typeof(receipt)='object' AND receipt->>'requestId'=request_id::text AND receipt->>'operation'=operation AND
  jsonb_typeof(receipt->'requestId')='string' AND jsonb_typeof(receipt->'operation')='string' AND jsonb_typeof(receipt->'outcome')='string' AND
  ((receipt->>'outcome'='granted' AND receipt ?& ARRAY['requestId','operation','outcome','titleKey'] AND receipt-ARRAY['requestId','operation','outcome','titleKey']='{}'::jsonb AND jsonb_typeof(receipt->'titleKey')='string' AND receipt->>'titleKey'='redeem_liangchenmeijing') OR
   (receipt->>'outcome'='rejected' AND receipt ?& ARRAY['requestId','operation','outcome','code'] AND receipt-ARRAY['requestId','operation','outcome','code']='{}'::jsonb AND jsonb_typeof(receipt->'code')='string' AND receipt->>'code' IN ('EXPERIENCE_REDEMPTION_INVALID','EXPERIENCE_TITLE_ALREADY_OWNED'))),false));
CREATE TABLE whaleu_experience.redemption_decisions(
  owner_id uuid NOT NULL REFERENCES whaleu_experience.owners(owner_id), request_id uuid NOT NULL,
  title_key text REFERENCES whaleu_experience.title_catalog(title_key),
  decided_at timestamptz NOT NULL CHECK(isfinite(decided_at)),
  outcome text NOT NULL CHECK(outcome IN ('granted','invalid','already_owned')),
  authority_kind text NOT NULL CHECK(authority_kind='synthetic_fixture'),
  creation_transaction xid8 NOT NULL,
  PRIMARY KEY(owner_id,request_id), UNIQUE(owner_id,request_id,title_key),
  FOREIGN KEY(owner_id,request_id) REFERENCES whaleu_experience.requests(owner_id,request_id) DEFERRABLE INITIALLY DEFERRED,
  CHECK((outcome='invalid')=(title_key IS NULL)),
  CHECK(title_key IS NULL OR title_key='redeem_liangchenmeijing')
);
CREATE FUNCTION whaleu_experience.redemption_decision_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT whaleu_experience.synthetic_fixture_allowed() THEN RAISE EXCEPTION 'Synthetic fixture is local test only' USING ERRCODE='23514'; END IF;
  IF NEW.title_key IS NOT NULL AND NOT EXISTS(SELECT 1 FROM whaleu_experience.title_catalog WHERE title_key=NEW.title_key AND kind='limited' AND name='良辰美景' AND unlock_level IS NULL) THEN RAISE EXCEPTION 'Unsupported redemption title' USING ERRCODE='23514'; END IF;
  PERFORM owner_id FROM whaleu_experience.owners WHERE owner_id=NEW.owner_id FOR UPDATE;
  IF NEW.outcome='already_owned' AND NOT EXISTS(SELECT 1 FROM whaleu_experience.entitlements WHERE owner_id=NEW.owner_id AND title_key=NEW.title_key) THEN RAISE EXCEPTION 'Already-owned decision lacks ownership' USING ERRCODE='23514'; END IF;
  IF NEW.outcome='granted' AND EXISTS(SELECT 1 FROM whaleu_experience.entitlements WHERE owner_id=NEW.owner_id AND title_key=NEW.title_key) THEN RAISE EXCEPTION 'Redemption title already owned' USING ERRCODE='23514'; END IF;
  NEW.creation_transaction:=pg_current_xact_id();
  RETURN NEW;
END $$;
CREATE TRIGGER redemption_decision_guard BEFORE INSERT ON whaleu_experience.redemption_decisions FOR EACH ROW EXECUTE FUNCTION whaleu_experience.redemption_decision_guard();
CREATE TRIGGER redemption_decision_immutable BEFORE UPDATE OR DELETE ON whaleu_experience.redemption_decisions FOR EACH ROW EXECUTE FUNCTION whaleu_experience.immutable_row();
ALTER TABLE whaleu_experience.entitlements DROP CONSTRAINT entitlements_origin_check;
ALTER TABLE whaleu_experience.entitlements ADD CONSTRAINT entitlements_origin_check CHECK(origin IN ('registration','level','synthetic_fixture','redemption'));
ALTER TABLE whaleu_experience.entitlements ADD COLUMN redemption_request_id uuid;
ALTER TABLE whaleu_experience.entitlements ADD COLUMN creation_transaction xid8;
ALTER TABLE whaleu_experience.entitlements ADD CONSTRAINT redemption_origin CHECK((origin='redemption')=(redemption_request_id IS NOT NULL) AND (origin='redemption')=(creation_transaction IS NOT NULL));
ALTER TABLE whaleu_experience.entitlements ADD CONSTRAINT redemption_proof FOREIGN KEY(owner_id,redemption_request_id,title_key) REFERENCES whaleu_experience.redemption_decisions(owner_id,request_id,title_key);
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
  ELSIF NEW.origin='registration' THEN
    IF NEW.title_key NOT IN ('default_jingxiaoyu','level_1') OR NEW.earned_at IS NULL OR NOT EXISTS(SELECT 1 FROM whaleu_experience.baselines b JOIN whaleu_identity.accounts a ON a.id=b.owner_id WHERE b.owner_id=NEW.owner_id AND b.origin='native_account_creation' AND a.local_creation_transaction=pg_current_xact_id()) THEN RAISE EXCEPTION 'Registration grant requires new account provenance' USING ERRCODE='23514'; END IF;
  ELSE
    SELECT l.threshold INTO threshold_value FROM whaleu_experience.title_catalog t JOIN whaleu_experience.level_catalog l ON l.level=t.unlock_level WHERE t.title_key=NEW.title_key AND t.kind='level';
    SELECT * INTO s FROM whaleu_experience.settlements WHERE id=NEW.settlement_id AND owner_id=NEW.owner_id;
    IF threshold_value IS NULL OR s.id IS NULL OR s.balance_after<threshold_value OR NEW.earned_at IS DISTINCT FROM s.applied_at THEN RAISE EXCEPTION 'Level grant lacks earned proof' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION whaleu_experience.request_projection_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s whaleu_experience.settlements; d whaleu_experience.signin_days; state whaleu_experience.account_states; selected whaleu_experience.appearance; decision whaleu_experience.redemption_decisions;
BEGIN
  IF NEW.operation='redeem_title' THEN
    SELECT * INTO decision FROM whaleu_experience.redemption_decisions WHERE owner_id=NEW.owner_id AND request_id=NEW.request_id;
    IF decision.owner_id IS NULL OR decision.creation_transaction<>pg_current_xact_id() OR
      (decision.outcome='granted' AND (NEW.receipt->>'outcome'<>'granted' OR NEW.receipt->>'titleKey' IS DISTINCT FROM decision.title_key)) OR
      (decision.outcome='invalid' AND (NEW.receipt->>'outcome'<>'rejected' OR NEW.receipt->>'code' IS DISTINCT FROM 'EXPERIENCE_REDEMPTION_INVALID')) OR
      (decision.outcome='already_owned' AND (NEW.receipt->>'outcome'<>'rejected' OR NEW.receipt->>'code' IS DISTINCT FROM 'EXPERIENCE_TITLE_ALREADY_OWNED' OR NOT EXISTS(SELECT 1 FROM whaleu_experience.entitlements WHERE owner_id=NEW.owner_id AND title_key=decision.title_key))) THEN
      RAISE EXCEPTION 'Redemption receipt lacks matching decision' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.operation='sign_in' THEN
    SELECT * INTO d FROM whaleu_experience.signin_days WHERE owner_id=NEW.owner_id AND reward_day=(NEW.receipt->>'rewardDay')::date;
    SELECT * INTO s FROM whaleu_experience.settlements WHERE id=d.settlement_id;
    SELECT * INTO state FROM whaleu_experience.account_states WHERE owner_id=NEW.owner_id;
    IF s.id IS NULL OR (NEW.receipt->>'streak')::integer<>d.streak THEN RAISE EXCEPTION 'Sign-in receipt lacks owned day' USING ERRCODE='23514'; END IF;
    IF NEW.receipt->>'outcome'='awarded' THEN
      IF ((NEW.receipt->>'appliedDelta')::bigint,(NEW.receipt->>'balance')::bigint,(NEW.receipt->>'stateRevision')::bigint) IS DISTINCT FROM (s.applied_delta,s.balance_after,s.state_revision) THEN RAISE EXCEPTION 'Sign-in receipt disagrees with reward' USING ERRCODE='23514'; END IF;
    ELSIF ((NEW.receipt->>'appliedDelta')::bigint,(NEW.receipt->>'balance')::bigint,(NEW.receipt->>'stateRevision')::bigint) IS DISTINCT FROM (0::bigint,state.balance,state.revision) THEN RAISE EXCEPTION 'Already-signed receipt disagrees with state' USING ERRCODE='23514'; END IF;
  ELSIF NEW.operation='appearance' AND NEW.receipt->>'outcome'='applied' THEN
    SELECT * INTO selected FROM whaleu_experience.appearance WHERE owner_id=NEW.owner_id;
    IF selected.owner_id IS NULL OR (NEW.receipt->>'titleKey',(NEW.receipt->>'colorId')::integer,(NEW.receipt->>'revision')::bigint) IS DISTINCT FROM (selected.title_key,selected.color_id,selected.revision) THEN RAISE EXCEPTION 'Appearance receipt disagrees with selection' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION whaleu_experience.redemption_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r whaleu_experience.requests;
BEGIN
  SELECT * INTO r FROM whaleu_experience.requests WHERE owner_id=NEW.owner_id AND request_id=NEW.request_id;
  IF r.owner_id IS NULL OR r.operation<>'redeem_title' THEN RAISE EXCEPTION 'Redemption decision lacks receipt' USING ERRCODE='23514'; END IF;
  IF NEW.outcome='granted' THEN
    IF NOT EXISTS(SELECT 1 FROM whaleu_experience.entitlements WHERE owner_id=NEW.owner_id AND title_key=NEW.title_key AND origin='redemption' AND redemption_request_id=NEW.request_id AND earned_at=NEW.decided_at AND creation_transaction=NEW.creation_transaction) THEN RAISE EXCEPTION 'Redemption grant incomplete' USING ERRCODE='23514'; END IF;
  ELSE
    IF EXISTS(SELECT 1 FROM whaleu_experience.entitlements WHERE owner_id=NEW.owner_id AND redemption_request_id=NEW.request_id) THEN RAISE EXCEPTION 'Rejected redemption created grant' USING ERRCODE='23514'; END IF;
    IF NEW.outcome='already_owned' AND NOT EXISTS(SELECT 1 FROM whaleu_experience.entitlements WHERE owner_id=NEW.owner_id AND title_key=NEW.title_key) THEN RAISE EXCEPTION 'Existing ownership missing' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER redemption_complete AFTER INSERT ON whaleu_experience.redemption_decisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_experience.redemption_complete();
