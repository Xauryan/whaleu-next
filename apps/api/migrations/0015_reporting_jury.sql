-- Empty local reporting/jury state. No legacy adoption, external review, grants or bans.
CREATE TABLE whaleu_community.report_origins (
 kind text NOT NULL CHECK(kind IN ('post','comment','reply')), target_id uuid NOT NULL,
 owner_account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
 source_request_id uuid NOT NULL, provenance text NOT NULL CHECK(provenance='native_publication'),
 created_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),
 PRIMARY KEY(kind,target_id), UNIQUE(kind,target_id,owner_account_id),
 FOREIGN KEY(owner_account_id,source_request_id) REFERENCES whaleu_community.publication_requests(account_id,client_request_id)
);
CREATE TRIGGER report_origin_immutable BEFORE UPDATE OR DELETE ON whaleu_community.report_origins FOR EACH ROW EXECUTE FUNCTION whaleu_community.poll_immutable();
CREATE FUNCTION whaleu_community.report_origin_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actual_owner uuid; source jsonb; op text;
BEGIN
 IF NEW.kind='post' THEN SELECT account_id INTO actual_owner FROM whaleu_community.posts WHERE id=NEW.target_id;
 ELSIF NEW.kind='comment' THEN SELECT account_id INTO actual_owner FROM whaleu_community.root_comments WHERE id=NEW.target_id;
 ELSE SELECT account_id INTO actual_owner FROM whaleu_community.replies WHERE id=NEW.target_id; END IF;
 SELECT receipt,operation INTO source,op FROM whaleu_community.publication_requests WHERE account_id=NEW.owner_account_id AND client_request_id=NEW.source_request_id;
 IF actual_owner IS DISTINCT FROM NEW.owner_account_id OR source->>'outcome' IS DISTINCT FROM 'created' OR source->>'resourceId' IS DISTINCT FROM NEW.target_id::text OR op IS DISTINCT FROM (CASE NEW.kind WHEN 'post' THEN 'publish_post' WHEN 'comment' THEN 'publish_comment' ELSE 'publish_reply' END) THEN
 RAISE EXCEPTION 'Report origin lacks owned publication' USING ERRCODE='23514'; END IF; RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER report_origin_complete AFTER INSERT ON whaleu_community.report_origins DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community.report_origin_complete();
CREATE TABLE whaleu_safety.report_cases (
 id uuid PRIMARY KEY, kind text NOT NULL CHECK(kind IN ('post','comment','reply')), target_id uuid NOT NULL,
 post_id uuid NOT NULL REFERENCES whaleu_community.posts(id), root_id uuid, reply_id uuid,
 owner_account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
 provenance text NOT NULL CHECK(provenance='native_publication'), content_digest text NOT NULL CHECK(content_digest ~ '^[a-f0-9]{64}$'),
 report_count integer NOT NULL DEFAULT 0 CHECK(report_count BETWEEN 0 AND 10), effective_weight integer NOT NULL DEFAULT 0 CHECK(effective_weight BETWEEN 0 AND 10),
 state text NOT NULL DEFAULT 'open' CHECK(state IN ('open','jury','kept','removed','superseded')),
 created_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),
 UNIQUE(kind,target_id),UNIQUE(id,post_id),UNIQUE(id,owner_account_id),
 FOREIGN KEY(kind,target_id,owner_account_id) REFERENCES whaleu_community.report_origins(kind,target_id,owner_account_id),
 FOREIGN KEY(root_id,post_id) REFERENCES whaleu_community.root_comments(id,post_id),
 FOREIGN KEY(reply_id,root_id,post_id) REFERENCES whaleu_community.replies(id,root_comment_id,post_id),
 CHECK((kind='post' AND target_id=post_id AND root_id IS NULL AND reply_id IS NULL AND report_count<=5 AND effective_weight<=9) OR (kind='comment' AND root_id IS NOT NULL AND target_id=root_id AND reply_id IS NULL AND effective_weight=report_count) OR (kind='reply' AND reply_id IS NOT NULL AND target_id=reply_id AND root_id IS NOT NULL AND effective_weight=report_count))
);
CREATE TABLE whaleu_safety.report_requests (
 account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),client_request_id uuid NOT NULL,
 operation text NOT NULL CHECK(operation IN ('report','vote')),payload_hash text NOT NULL CHECK(payload_hash ~ '^[a-f0-9]{64}$'),receipt jsonb,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(account_id,client_request_id),
 CHECK(receipt IS NULL OR coalesce(jsonb_typeof(receipt)='object' AND receipt->>'requestId'=client_request_id::text AND receipt->>'operation'=operation AND
 ((receipt->>'outcome'='accepted' AND jsonb_typeof(receipt->'receiptId')='string' AND receipt->>'receiptId' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' AND receipt-ARRAY['requestId','operation','outcome','receiptId']='{}'::jsonb) OR
 (receipt->>'outcome'='rejected' AND receipt->>'code' IN ('REPORT_TARGET_UNAVAILABLE','REPORT_SELF_NOT_ALLOWED','REPORT_ALREADY_REPORTED','REPORTING_CLOSED','PHONE_VERIFICATION_REQUIRED','AFFILIATION_VERIFICATION_REQUIRED','SAFETY_ACTION_RESTRICTED','JURY_NOT_FOUND','JURY_INELIGIBLE','JURY_ALREADY_VOTED','JURY_CLOSED') AND receipt-ARRAY['requestId','operation','outcome','code']='{}'::jsonb)),false))
);
CREATE TRIGGER report_request_guard BEFORE UPDATE OR DELETE ON whaleu_safety.report_requests FOR EACH ROW EXECUTE FUNCTION whaleu_safety.receipt_guard();
CREATE TABLE whaleu_safety.reports (
 id uuid PRIMARY KEY,case_id uuid NOT NULL REFERENCES whaleu_safety.report_cases(id),account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
 request_id uuid NOT NULL, weight smallint NOT NULL CHECK(weight IN (1,5)),
 grant_id uuid REFERENCES whaleu_authorization.role_grants(id),scope_evidence text,
 accepted_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),
 UNIQUE(case_id,account_id),UNIQUE(account_id,request_id),
 FOREIGN KEY(account_id,request_id) REFERENCES whaleu_safety.report_requests(account_id,client_request_id),
 CHECK((weight=1 AND grant_id IS NULL AND scope_evidence IS NULL) OR (weight=5 AND grant_id IS NOT NULL AND scope_evidence IS NOT NULL))
);
CREATE TRIGGER reports_immutable BEFORE UPDATE OR DELETE ON whaleu_safety.reports FOR EACH ROW EXECUTE FUNCTION whaleu_safety.immutable_event();
CREATE TABLE whaleu_safety.post_juries (
 id uuid PRIMARY KEY,case_id uuid NOT NULL UNIQUE,post_id uuid NOT NULL UNIQUE,
 content_digest text NOT NULL CHECK(content_digest ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),deadline timestamptz NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','kept','removed','superseded')),
 decision_id uuid UNIQUE,
 UNIQUE(id,case_id),FOREIGN KEY(case_id,post_id) REFERENCES whaleu_safety.report_cases(id,post_id),
 CHECK(isfinite(created_at) AND deadline=created_at+interval '24 hours'),CHECK((state='pending')=(decision_id IS NULL))
);
CREATE TABLE whaleu_safety.jury_ballots (
 id uuid PRIMARY KEY,jury_id uuid NOT NULL REFERENCES whaleu_safety.post_juries(id),account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),request_id uuid NOT NULL,
 vote text NOT NULL CHECK(vote IN ('keep','remove')),accepted_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),
 UNIQUE(jury_id,account_id),UNIQUE(account_id,request_id),FOREIGN KEY(account_id,request_id) REFERENCES whaleu_safety.report_requests(account_id,client_request_id)
);
CREATE TRIGGER jury_ballots_immutable BEFORE UPDATE OR DELETE ON whaleu_safety.jury_ballots FOR EACH ROW EXECUTE FUNCTION whaleu_safety.immutable_event();
CREATE TABLE whaleu_safety.review_obligations (
 case_id uuid PRIMARY KEY REFERENCES whaleu_safety.report_cases(id),content_digest text NOT NULL CHECK(content_digest ~ '^[a-f0-9]{64}$'),
 status text NOT NULL DEFAULT 'provider_disabled' CHECK(status='provider_disabled'),attempts integer NOT NULL DEFAULT 0 CHECK(attempts=0),
 created_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp())
);
CREATE TRIGGER review_obligation_immutable BEFORE UPDATE OR DELETE ON whaleu_safety.review_obligations FOR EACH ROW EXECUTE FUNCTION whaleu_safety.immutable_event();
CREATE TABLE whaleu_safety.jury_work (
 jury_id uuid PRIMARY KEY REFERENCES whaleu_safety.post_juries(id),provenance text NOT NULL CHECK(provenance='native_publication'),
 due_at timestamptz NOT NULL,state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','completed')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),next_attempt_at timestamptz NOT NULL,
 error_code text CHECK(error_code IN ('local_processing_failed','content_version_changed')),
 CHECK(isfinite(due_at) AND isfinite(next_attempt_at))
);
CREATE INDEX jury_work_due ON whaleu_safety.jury_work(next_attempt_at,jury_id) WHERE state='pending';
CREATE TABLE whaleu_safety.report_decisions (
 id uuid PRIMARY KEY,case_id uuid NOT NULL UNIQUE,owner_account_id uuid NOT NULL,
 cause text NOT NULL CHECK(cause IN ('post_jury','discussion_report_threshold')),
 outcome text NOT NULL CHECK(outcome IN ('kept','removed','superseded')),
 reason text NOT NULL CHECK(reason IN ('six_votes','deadline','ten_reports','target_unavailable')),
 keep_votes integer NOT NULL CHECK(keep_votes BETWEEN 0 AND 6),remove_votes integer NOT NULL CHECK(remove_votes BETWEEN 0 AND 6),
 decided_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),
 UNIQUE(id,owner_account_id),FOREIGN KEY(case_id,owner_account_id) REFERENCES whaleu_safety.report_cases(id,owner_account_id),
 CHECK(keep_votes+remove_votes<=11),CHECK(cause='post_jury' OR (keep_votes=0 AND remove_votes=0 AND reason='ten_reports' AND outcome='removed')),
 CHECK(isfinite(decided_at)),
 CHECK((cause='discussion_report_threshold' AND outcome='removed' AND reason='ten_reports') OR (cause='post_jury' AND ((outcome='superseded' AND reason='target_unavailable') OR (outcome IN ('kept','removed') AND reason IN ('six_votes','deadline')))))
);
ALTER TABLE whaleu_safety.post_juries ADD FOREIGN KEY(decision_id) REFERENCES whaleu_safety.report_decisions(id);
CREATE TRIGGER report_decisions_immutable BEFORE UPDATE OR DELETE ON whaleu_safety.report_decisions FOR EACH ROW EXECUTE FUNCTION whaleu_safety.immutable_event();
CREATE TABLE whaleu_safety.report_rate_buckets (
 account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),action text NOT NULL CHECK(action IN ('report','vote','read')),
 window_start timestamptz NOT NULL,hits integer NOT NULL CHECK(hits BETWEEN 1 AND 1000000),PRIMARY KEY(account_id,action)
);
CREATE TABLE whaleu_safety.report_target_buckets (
 kind text NOT NULL CHECK(kind IN ('post','comment','reply')),target_id uuid NOT NULL,window_start timestamptz NOT NULL,hits integer NOT NULL CHECK(hits BETWEEN 1 AND 1000000),PRIMARY KEY(kind,target_id)
);
CREATE FUNCTION whaleu_safety.report_case_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR (to_jsonb(OLD)-ARRAY['report_count','effective_weight','state']) IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['report_count','effective_weight','state']) OR NEW.report_count<OLD.report_count OR NEW.effective_weight<OLD.effective_weight OR (OLD.state<>'open' AND (NEW.report_count<>OLD.report_count OR NEW.effective_weight<>OLD.effective_weight)) OR (OLD.state IN ('kept','removed','superseded') AND NEW IS DISTINCT FROM OLD) THEN RAISE EXCEPTION 'Report case identity and settled state are protected' USING ERRCODE='23514'; END IF; RETURN NEW;
END $$;
CREATE TRIGGER report_case_guard BEFORE UPDATE OR DELETE ON whaleu_safety.report_cases FOR EACH ROW EXECUTE FUNCTION whaleu_safety.report_case_guard();
CREATE FUNCTION whaleu_safety.jury_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR OLD.state<>'pending' OR NEW.state='pending' OR (to_jsonb(OLD)-ARRAY['state','decision_id']) IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['state','decision_id']) THEN RAISE EXCEPTION 'Jury definition and outcome are immutable' USING ERRCODE='23514'; END IF; RETURN NEW;
END $$;
CREATE TRIGGER jury_guard BEFORE UPDATE OR DELETE ON whaleu_safety.post_juries FOR EACH ROW EXECUTE FUNCTION whaleu_safety.jury_guard();
CREATE FUNCTION whaleu_safety.report_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c whaleu_safety.report_cases; p uuid;
BEGIN
 SELECT post_id INTO p FROM whaleu_safety.report_cases WHERE id=NEW.case_id;
 PERFORM 1 FROM whaleu_community.posts WHERE id=p FOR UPDATE;
 SELECT * INTO c FROM whaleu_safety.report_cases WHERE id=NEW.case_id FOR UPDATE;
 IF c.owner_account_id=NEW.account_id OR c.state<>'open' OR (c.kind<>'post' AND NEW.weight<>1) OR (c.kind='post' AND c.effective_weight>=5) OR (c.kind<>'post' AND c.report_count>=10) THEN RAISE EXCEPTION 'Report is not permitted' USING ERRCODE='23514'; END IF;
 IF NEW.weight=5 AND NOT EXISTS(SELECT 1 FROM whaleu_authorization.role_grants g JOIN whaleu_community.posts p ON p.id=c.post_id JOIN whaleu_community.spaces s ON s.id=p.space_id WHERE g.id=NEW.grant_id AND g.account_id=NEW.account_id AND g.revoked_at IS NULL AND g.valid_from<=clock_timestamp() AND (g.expires_at IS NULL OR g.expires_at>clock_timestamp()) AND ((g.role IN ('developer','super_admin') AND g.operating_region_id IS NULL AND NEW.scope_evidence='global_management') OR (g.role='school_admin' AND s.kind='regional' AND g.operating_region_id=s.operating_region_id AND NEW.scope_evidence='regional:'||s.operating_region_id::text AND EXISTS(SELECT 1 FROM whaleu_campus.operating_regions WHERE id=g.operating_region_id AND is_active)))) THEN RAISE EXCEPTION 'Report weight lacks grant' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER report_insert_guard BEFORE INSERT ON whaleu_safety.reports FOR EACH ROW EXECUTE FUNCTION whaleu_safety.report_insert_guard();
CREATE FUNCTION whaleu_safety.jury_ballot_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE j whaleu_safety.post_juries; p uuid; total integer;
BEGIN
 SELECT post_id INTO p FROM whaleu_safety.post_juries WHERE id=NEW.jury_id;
 PERFORM 1 FROM whaleu_community.posts WHERE id=p FOR UPDATE;
 SELECT * INTO j FROM whaleu_safety.post_juries WHERE id=NEW.jury_id FOR UPDATE;
 SELECT count(*) INTO total FROM whaleu_safety.jury_ballots WHERE jury_id=j.id;
 IF j.state<>'pending' OR j.deadline<=clock_timestamp() OR total>=11 OR EXISTS(SELECT 1 FROM whaleu_safety.report_cases WHERE id=j.case_id AND owner_account_id=NEW.account_id) OR EXISTS(SELECT 1 FROM whaleu_safety.reports WHERE case_id=j.case_id AND account_id=NEW.account_id) THEN RAISE EXCEPTION 'Jury ballot is not permitted' USING ERRCODE='23514'; END IF; RETURN NEW;
END $$;
CREATE TRIGGER jury_ballot_guard BEFORE INSERT ON whaleu_safety.jury_ballots FOR EACH ROW EXECUTE FUNCTION whaleu_safety.jury_ballot_guard();
CREATE FUNCTION whaleu_safety.report_request_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r whaleu_safety.report_requests;
BEGIN
 SELECT * INTO r FROM whaleu_safety.report_requests WHERE account_id=NEW.account_id AND client_request_id=NEW.client_request_id;
 IF r.receipt IS NULL THEN RAISE EXCEPTION 'Report request is incomplete' USING ERRCODE='23514'; END IF;
 IF r.receipt->>'outcome'='accepted' AND NOT ((r.operation='report' AND EXISTS(SELECT 1 FROM whaleu_safety.reports WHERE id=(r.receipt->>'receiptId')::uuid AND account_id=r.account_id AND request_id=r.client_request_id)) OR (r.operation='vote' AND EXISTS(SELECT 1 FROM whaleu_safety.jury_ballots WHERE id=(r.receipt->>'receiptId')::uuid AND account_id=r.account_id AND request_id=r.client_request_id))) THEN RAISE EXCEPTION 'Report receipt lacks owned evidence' USING ERRCODE='23514'; END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER report_request_complete AFTER INSERT OR UPDATE ON whaleu_safety.report_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_safety.report_request_complete();
CREATE FUNCTION whaleu_safety.report_case_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cid uuid;c whaleu_safety.report_cases;n integer;w integer;j whaleu_safety.post_juries;k integer;r integer;
BEGIN
 IF TG_TABLE_NAME='report_cases' THEN cid:=NEW.id; ELSE cid:=NEW.case_id; END IF;
 SELECT * INTO c FROM whaleu_safety.report_cases WHERE id=cid;
 SELECT count(*),coalesce(sum(weight),0) INTO n,w FROM whaleu_safety.reports WHERE case_id=cid;
 IF c.report_count<>n OR c.effective_weight<>w OR n=0 THEN RAISE EXCEPTION 'Report aggregates disagree' USING ERRCODE='23514'; END IF;
 IF c.kind='post' THEN
  SELECT * INTO j FROM whaleu_safety.post_juries WHERE case_id=cid;
  IF (w<5 AND c.state<>'open') OR (w>=5 AND c.state IS DISTINCT FROM (CASE WHEN j.state='pending' THEN 'jury' ELSE j.state END)) OR (w>=5) IS DISTINCT FROM (j.id IS NOT NULL) OR (j.id IS NOT NULL AND (j.content_digest<>c.content_digest OR NOT EXISTS(SELECT 1 FROM whaleu_safety.jury_work WHERE jury_id=j.id AND due_at=j.deadline))) THEN RAISE EXCEPTION 'Jury threshold or durable work missing' USING ERRCODE='23514'; END IF;
 ELSE
  IF NOT EXISTS(SELECT 1 FROM whaleu_safety.review_obligations WHERE case_id=cid AND content_digest=c.content_digest) OR (n<10 AND c.state<>'open') OR (n=10 AND (c.state<>'removed' OR NOT EXISTS(SELECT 1 FROM whaleu_safety.report_decisions WHERE case_id=cid AND cause='discussion_report_threshold' AND outcome='removed'))) THEN RAISE EXCEPTION 'Discussion obligation or removal missing' USING ERRCODE='23514'; END IF;
 END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER report_case_complete AFTER INSERT OR UPDATE ON whaleu_safety.report_cases DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_safety.report_case_complete();
CREATE CONSTRAINT TRIGGER report_evidence_complete AFTER INSERT ON whaleu_safety.reports DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_safety.report_case_complete();
CREATE FUNCTION whaleu_safety.jury_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE jid uuid;j whaleu_safety.post_juries;d whaleu_safety.report_decisions;k integer;r integer;
BEGIN
 IF TG_TABLE_NAME='post_juries' THEN jid:=NEW.id; ELSE jid:=NEW.jury_id; END IF;
 SELECT * INTO j FROM whaleu_safety.post_juries WHERE id=jid;
 SELECT count(*) FILTER(WHERE vote='keep'),count(*) FILTER(WHERE vote='remove') INTO k,r FROM whaleu_safety.jury_ballots WHERE jury_id=jid;
 IF NOT EXISTS(SELECT 1 FROM whaleu_safety.report_cases WHERE id=j.case_id AND kind='post') OR k>6 OR r>6 OR k+r>11 OR (j.state='pending' AND (k>=6 OR r>=6)) THEN RAISE EXCEPTION 'Jury threshold settlement missing' USING ERRCODE='23514'; END IF;
 IF j.state<>'pending' THEN
  SELECT * INTO d FROM whaleu_safety.report_decisions WHERE id=j.decision_id;
  IF (d.reason='six_votes' AND greatest(k,r)<>6) OR (d.reason='deadline' AND d.decided_at<j.deadline) OR d.case_id IS DISTINCT FROM j.case_id OR d.cause IS DISTINCT FROM 'post_jury' OR d.outcome IS DISTINCT FROM j.state OR d.keep_votes<>k OR d.remove_votes<>r OR NOT EXISTS(SELECT 1 FROM whaleu_safety.jury_work WHERE jury_id=jid AND state='completed') OR (j.state='removed' AND r<=k) OR (j.state='kept' AND k<r) THEN RAISE EXCEPTION 'Jury outcome disagrees' USING ERRCODE='23514'; END IF;
 END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER jury_complete AFTER INSERT OR UPDATE ON whaleu_safety.post_juries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_safety.jury_complete();
CREATE CONSTRAINT TRIGGER jury_ballot_complete AFTER INSERT ON whaleu_safety.jury_ballots DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_safety.jury_complete();
-- Notification-owned administrative notices are retained independently of target
-- visibility. This fragment follows the report_decisions table definition.
CREATE TABLE whaleu_notifications.system_notice_owners (
  account_id uuid PRIMARY KEY REFERENCES whaleu_identity.accounts(id)
);
CREATE TABLE whaleu_notifications.system_notice_rate_buckets (
  account_id uuid PRIMARY KEY REFERENCES whaleu_identity.accounts(id),
  window_start timestamptz NOT NULL CHECK(isfinite(window_start)),
  hits integer NOT NULL CHECK(hits BETWEEN 1 AND 1000000)
);
CREATE TABLE whaleu_notifications.system_notices (
  id uuid PRIMARY KEY,
  decision_id uuid NOT NULL,
  recipient_account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
  kind text NOT NULL CHECK(kind='post_jury_removed'),
  keep_votes integer NOT NULL CHECK(keep_votes BETWEEN 0 AND 5),
  remove_votes integer NOT NULL CHECK(remove_votes BETWEEN 1 AND 6),
  created_at timestamptz NOT NULL CHECK(isfinite(created_at) AND created_at=date_trunc('milliseconds',created_at)),
  read_at timestamptz CHECK(read_at IS NULL OR (isfinite(read_at) AND read_at=date_trunc('milliseconds',read_at))),
  UNIQUE(decision_id,recipient_account_id),
  FOREIGN KEY(decision_id,recipient_account_id) REFERENCES whaleu_safety.report_decisions(id,owner_account_id),
  CHECK(remove_votes>keep_votes AND keep_votes+remove_votes<=11)
);
CREATE INDEX system_notices_owner_page ON whaleu_notifications.system_notices(recipient_account_id,created_at DESC,id DESC);
CREATE INDEX system_notices_unread ON whaleu_notifications.system_notices(recipient_account_id) WHERE read_at IS NULL;
CREATE FUNCTION whaleu_notifications.system_notice_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.read_at IS NOT NULL OR NOT EXISTS (
      SELECT 1 FROM whaleu_safety.report_decisions decision
      WHERE decision.id=NEW.decision_id AND decision.owner_account_id=NEW.recipient_account_id
        AND decision.cause='post_jury' AND decision.outcome='removed'
        AND decision.keep_votes=NEW.keep_votes AND decision.remove_votes=NEW.remove_votes
        AND decision.decided_at=NEW.created_at
    ) THEN
      RAISE EXCEPTION 'System notice must match its owner removal decision' USING ERRCODE='23514';
    END IF;
  ELSIF TG_OP='DELETE' OR (to_jsonb(OLD)-'read_at') IS DISTINCT FROM (to_jsonb(NEW)-'read_at') OR
     (OLD.read_at IS NOT NULL AND NEW.read_at IS DISTINCT FROM OLD.read_at) OR NEW.read_at IS NULL THEN
    RAISE EXCEPTION 'System notice identity and settled read state are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER system_notice_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_notifications.system_notices
  FOR EACH ROW EXECUTE FUNCTION whaleu_notifications.system_notice_guard();

CREATE FUNCTION whaleu_safety.decision_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c whaleu_safety.report_cases;removed boolean;
BEGIN
 SELECT * INTO c FROM whaleu_safety.report_cases WHERE id=NEW.case_id;
 IF (NEW.cause='discussion_report_threshold' AND c.report_count<>10) OR (NEW.cause='post_jury' AND NOT EXISTS(SELECT 1 FROM whaleu_safety.post_juries WHERE case_id=c.id AND decision_id=NEW.id)) OR c.state<>NEW.outcome OR (NEW.cause='post_jury')<>(c.kind='post') THEN RAISE EXCEPTION 'Decision has wrong case' USING ERRCODE='23514'; END IF;
 IF c.kind='post' THEN SELECT deleted_at IS NOT NULL INTO removed FROM whaleu_community.posts WHERE id=c.post_id;
 ELSIF c.kind='comment' THEN SELECT deleted_at IS NOT NULL INTO removed FROM whaleu_community.root_comments WHERE id=c.root_id;
 ELSE SELECT deleted_at IS NOT NULL INTO removed FROM whaleu_community.replies WHERE id=c.reply_id; END IF;
 IF NEW.outcome='superseded' AND NOT removed THEN RAISE EXCEPTION 'Superseded target remains live' USING ERRCODE='23514'; END IF;
 IF NEW.outcome='removed' AND (NOT removed OR NOT EXISTS(SELECT 1 FROM whaleu_community.outbox WHERE event_key='moderation:'||NEW.id::text AND event_type='moderation_removed' AND resource_id=c.target_id)) THEN RAISE EXCEPTION 'Removal lacks owned event' USING ERRCODE='23514'; END IF;
 IF NEW.cause='post_jury' AND NEW.outcome='removed' AND NOT EXISTS(SELECT 1 FROM whaleu_notifications.system_notices WHERE decision_id=NEW.id AND recipient_account_id=NEW.owner_account_id) THEN RAISE EXCEPTION 'Jury removal lacks notice' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER decision_complete AFTER INSERT ON whaleu_safety.report_decisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_safety.decision_complete();
CREATE FUNCTION whaleu_safety.jury_work_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR (OLD.jury_id,OLD.provenance,OLD.due_at) IS DISTINCT FROM (NEW.jury_id,NEW.provenance,NEW.due_at) OR (OLD.state='completed' AND NEW IS DISTINCT FROM OLD) OR NEW.attempts<OLD.attempts THEN RAISE EXCEPTION 'Jury work is retained and cannot reopen' USING ERRCODE='23514'; END IF;RETURN NEW;
END $$;
CREATE TRIGGER jury_work_guard BEFORE UPDATE OR DELETE ON whaleu_safety.jury_work FOR EACH ROW EXECUTE FUNCTION whaleu_safety.jury_work_guard();
CREATE FUNCTION whaleu_safety.jury_work_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE w whaleu_safety.jury_work;j whaleu_safety.post_juries;
BEGIN
 SELECT * INTO w FROM whaleu_safety.jury_work WHERE jury_id=NEW.jury_id;
 SELECT * INTO j FROM whaleu_safety.post_juries WHERE id=NEW.jury_id;
 IF w.due_at<>j.deadline OR (w.state='completed')<>(j.state<>'pending') THEN RAISE EXCEPTION 'Jury work disagrees with outcome' USING ERRCODE='23514'; END IF; RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER jury_work_complete AFTER INSERT OR UPDATE ON whaleu_safety.jury_work DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_safety.jury_work_complete();
CREATE FUNCTION whaleu_safety.report_evidence_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r whaleu_safety.report_requests;expected text;
BEGIN
 expected:=CASE WHEN TG_TABLE_NAME='reports' THEN 'report' ELSE 'vote' END;
 SELECT * INTO r FROM whaleu_safety.report_requests WHERE account_id=NEW.account_id AND client_request_id=NEW.request_id;
 IF r.operation IS DISTINCT FROM expected OR r.receipt->>'outcome' IS DISTINCT FROM 'accepted' OR r.receipt->>'receiptId' IS DISTINCT FROM NEW.id::text THEN RAISE EXCEPTION 'Report evidence lacks accepted owned receipt' USING ERRCODE='23514'; END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER report_evidence_receipt AFTER INSERT ON whaleu_safety.reports DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_safety.report_evidence_receipt();
CREATE CONSTRAINT TRIGGER ballot_evidence_receipt AFTER INSERT ON whaleu_safety.jury_ballots DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_safety.report_evidence_receipt();
CREATE FUNCTION whaleu_safety.review_obligation_shape() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM whaleu_safety.report_cases WHERE id=NEW.case_id AND kind IN ('comment','reply') AND report_count>=1 AND content_digest=NEW.content_digest) THEN RAISE EXCEPTION 'Review obligation lacks discussion report' USING ERRCODE='23514'; END IF;RETURN NEW;
END $$;
CREATE TRIGGER review_obligation_shape BEFORE INSERT ON whaleu_safety.review_obligations FOR EACH ROW EXECUTE FUNCTION whaleu_safety.review_obligation_shape();

-- Each actor consumes at most one target-admission slot per minute, even when
-- retrying with fresh keys. Admission precedes target UPDATE contention.
CREATE TABLE whaleu_safety.report_target_actors (
 kind text NOT NULL CHECK(kind IN ('post','comment','reply')),target_id uuid NOT NULL,
 account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),window_start timestamptz NOT NULL CHECK(isfinite(window_start)),
 PRIMARY KEY(kind,target_id,account_id)
);
