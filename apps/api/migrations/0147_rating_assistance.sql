-- Purpose-specific synthetic suggestions. No provider, policy, role or Review is seeded.
CREATE TABLE whaleu_ratings.assistance_claims (
 account_id uuid NOT NULL, request_id uuid NOT NULL CHECK(request_id::text ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'),
 purpose text NOT NULL CHECK(purpose IN ('category_description','rating_publish_title')),
 intent_hash text NOT NULL CHECK(intent_hash ~ '^[a-f0-9]{64}$'),
 PRIMARY KEY(account_id,request_id), UNIQUE(account_id,request_id,purpose,intent_hash)
);
CREATE TABLE whaleu_ratings.assistance_cancellations (
 account_id uuid NOT NULL, request_id uuid NOT NULL, purpose text NOT NULL, intent_hash text NOT NULL,
 cancelled_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(account_id,request_id),
 FOREIGN KEY(account_id,request_id,purpose,intent_hash) REFERENCES whaleu_ratings.assistance_claims(account_id,request_id,purpose,intent_hash)
);
CREATE TABLE whaleu_ratings.assistance_requests (
 account_id uuid NOT NULL, request_id uuid NOT NULL, purpose text NOT NULL, intent_hash text NOT NULL,
 draft_id uuid NOT NULL CHECK(draft_id::text ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'), input_revision integer NOT NULL CHECK(input_revision>=0),
 session_id uuid NOT NULL, context_id uuid NOT NULL,
 source_revision text NOT NULL CHECK(source_revision ~ '^[a-f0-9]{64}$'),
 input_digest text NOT NULL CHECK(input_digest ~ '^[a-f0-9]{64}$'),
 profile text NOT NULL CHECK(profile='synthetic-rating-suggestion-v1'),
 admitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 queue_until timestamptz NOT NULL, payload_until timestamptz NOT NULL,
 PRIMARY KEY(account_id,request_id),
 UNIQUE(account_id,request_id,purpose,intent_hash,input_digest,profile),
 FOREIGN KEY(account_id,request_id,purpose,intent_hash) REFERENCES whaleu_ratings.assistance_claims(account_id,request_id,purpose,intent_hash),
 CHECK(queue_until>admitted_at AND queue_until<=admitted_at+interval '120 seconds'),
 CHECK(payload_until>admitted_at AND payload_until<=admitted_at+interval '30 minutes')
);
-- Session identifier is historical evidence, never a cascading FK to a prunable session.
CREATE TABLE whaleu_ratings.assistance_payloads (
 account_id uuid NOT NULL, request_id uuid NOT NULL,
 intent jsonb NOT NULL CHECK(octet_length(intent::text)<=65536),
 provider_input jsonb NOT NULL, source_binding jsonb NOT NULL,
 PRIMARY KEY(account_id,request_id),
 FOREIGN KEY(account_id,request_id) REFERENCES whaleu_ratings.assistance_requests(account_id,request_id)
);
CREATE TABLE whaleu_ratings.assistance_jobs (
 account_id uuid NOT NULL, request_id uuid NOT NULL,
 state text NOT NULL CHECK(state IN ('queued','claimed','dispatch_admitted','outcome_unknown','terminal')),
 fence bigint NOT NULL DEFAULT 0 CHECK(fence>=0), lease_until timestamptz,
 PRIMARY KEY(account_id,request_id),
 FOREIGN KEY(account_id,request_id) REFERENCES whaleu_ratings.assistance_requests(account_id,request_id),
 CHECK((state='queued' AND fence=0 AND lease_until IS NULL) OR state='terminal' OR (fence>0 AND lease_until IS NOT NULL))
);
CREATE TABLE whaleu_ratings.assistance_attempts (
 account_id uuid NOT NULL, request_id uuid NOT NULL, purpose text NOT NULL, intent_hash text NOT NULL,
 input_digest text NOT NULL, profile text NOT NULL,
 attempt integer NOT NULL CHECK(attempt BETWEEN 1 AND 2), fence bigint NOT NULL CHECK(fence>0),
 admitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 dispatch_until timestamptz NOT NULL,
 reserved_input integer NOT NULL CHECK(reserved_input=512),
 reserved_output integer NOT NULL CHECK(reserved_output=64),
 reserved_money integer NOT NULL CHECK(reserved_money=0),
 PRIMARY KEY(account_id,request_id,attempt), UNIQUE(account_id,request_id,fence),
 UNIQUE(account_id,request_id,attempt,fence,input_digest,profile),
 FOREIGN KEY(account_id,request_id,purpose,intent_hash,input_digest,profile) REFERENCES whaleu_ratings.assistance_requests(account_id,request_id,purpose,intent_hash,input_digest,profile),
 CHECK(dispatch_until>admitted_at AND dispatch_until<=admitted_at+interval '15 seconds')
);
CREATE TABLE whaleu_ratings.assistance_settlements (
 account_id uuid NOT NULL, request_id uuid NOT NULL, attempt integer NOT NULL, fence bigint NOT NULL,
 input_digest text NOT NULL, profile text NOT NULL,
 acceptance text NOT NULL CHECK(acceptance IN ('accepted','not_accepted','conservatively_charged')),
 input_tokens integer NOT NULL CHECK(input_tokens BETWEEN 0 AND 512),
 output_tokens integer NOT NULL CHECK(output_tokens BETWEEN 0 AND 64),
 monetary_minor_units integer NOT NULL CHECK(monetary_minor_units=0),
 PRIMARY KEY(account_id,request_id,attempt),
 FOREIGN KEY(account_id,request_id,attempt,fence,input_digest,profile) REFERENCES whaleu_ratings.assistance_attempts(account_id,request_id,attempt,fence,input_digest,profile),
 CHECK(acceptance<>'not_accepted' OR (input_tokens=0 AND output_tokens=0)),
 CHECK(acceptance<>'conservatively_charged' OR (input_tokens=512 AND output_tokens=64))
);
CREATE TABLE whaleu_ratings.assistance_outcomes (
 account_id uuid NOT NULL, request_id uuid NOT NULL, purpose text NOT NULL, intent_hash text NOT NULL,
 outcome text NOT NULL CHECK(outcome IN ('generated','unavailable','rejected','cancelled','expired')),
 result_id uuid, result_digest text, attempt integer, fence bigint,
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(account_id,request_id),
 FOREIGN KEY(account_id,request_id,purpose,intent_hash) REFERENCES whaleu_ratings.assistance_claims(account_id,request_id,purpose,intent_hash),
 FOREIGN KEY(account_id,request_id,attempt) REFERENCES whaleu_ratings.assistance_attempts(account_id,request_id,attempt),
 CHECK((outcome='generated' AND result_id IS NOT NULL AND result_digest ~ '^[a-f0-9]{64}$' AND attempt IS NOT NULL AND fence IS NOT NULL) OR (outcome<>'generated' AND result_id IS NULL AND result_digest IS NULL AND attempt IS NULL AND fence IS NULL)),
 UNIQUE(account_id,request_id,result_id,result_digest)
);
CREATE TABLE whaleu_ratings.assistance_results (
 account_id uuid NOT NULL, request_id uuid NOT NULL, result_id uuid NOT NULL, result_digest text NOT NULL,
 literal_text text NOT NULL,
 PRIMARY KEY(account_id,request_id),
 FOREIGN KEY(account_id,request_id,result_id,result_digest) REFERENCES whaleu_ratings.assistance_outcomes(account_id,request_id,result_id,result_digest) DEFERRABLE INITIALLY DEFERRED,
 CHECK(result_digest=encode(sha256(convert_to('whaleu:ratings:assistance:result:v1'||chr(10)||literal_text,'UTF8')),'hex'))
);
CREATE FUNCTION whaleu_ratings.assistance_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'immutable assistance ledger' USING ERRCODE='23514'; END $$;
DO $$ DECLARE n text; BEGIN
 FOREACH n IN ARRAY ARRAY['assistance_claims','assistance_cancellations','assistance_requests','assistance_attempts','assistance_settlements','assistance_outcomes'] LOOP
 EXECUTE format('CREATE TRIGGER immutable_assistance BEFORE UPDATE OR DELETE OR TRUNCATE ON whaleu_ratings.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.assistance_immutable()',n);
 END LOOP;
 FOREACH n IN ARRAY ARRAY['assistance_payloads','assistance_results'] LOOP
 EXECUTE format('CREATE TRIGGER immutable_assistance_payload BEFORE UPDATE ON whaleu_ratings.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.assistance_immutable()',n);
 END LOOP;
END $$;
CREATE FUNCTION whaleu_ratings.assistance_admission() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n timestamptz; BEGIN
 -- One common admission lock bounds global and account quotas under independent connections.
 PERFORM pg_advisory_xact_lock(146,1);
 n:=clock_timestamp();
 IF EXISTS(SELECT 1 FROM whaleu_ratings.assistance_cancellations WHERE account_id=NEW.account_id AND request_id=NEW.request_id)
 OR EXISTS(SELECT 1 FROM whaleu_ratings.assistance_outcomes WHERE account_id=NEW.account_id AND request_id=NEW.request_id)
 OR NEW.admitted_at<n-interval '1 second' OR NEW.admitted_at>n
 OR NOT EXISTS(SELECT 1 FROM whaleu_ratings.scoped_contexts c WHERE c.id=NEW.context_id AND c.account_id=NEW.account_id AND c.session_id=NEW.session_id AND whaleu_ratings.scoped_context_current(c.id,NEW.account_id,NEW.session_id,n))
 THEN RAISE EXCEPTION 'assistance admission unavailable' USING ERRCODE='23514'; END IF;
 -- The admission clock is authoritative after the quota lock, including a UTC
 -- day boundary. A caller cannot backdate within tolerance into yesterday.
 NEW.admitted_at:=n;
 IF (SELECT count(*) FROM whaleu_ratings.assistance_requests r WHERE r.account_id=NEW.account_id AND r.admitted_at>n-interval '1 minute')>=2
 OR (SELECT count(*) FROM whaleu_ratings.assistance_requests r WHERE r.account_id=NEW.account_id AND r.admitted_at>=date_trunc('day',n AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')>=20
 OR EXISTS(SELECT 1 FROM whaleu_ratings.assistance_jobs j WHERE j.account_id=NEW.account_id AND j.state<>'terminal')
 OR (SELECT count(*) FROM whaleu_ratings.assistance_jobs j WHERE j.state<>'terminal')>=32
 THEN RAISE EXCEPTION 'assistance quota exhausted' USING ERRCODE='23514', CONSTRAINT='assistance_quota'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER assistance_admission BEFORE INSERT ON whaleu_ratings.assistance_requests FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.assistance_admission();
CREATE FUNCTION whaleu_ratings.assistance_payload_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r whaleu_ratings.assistance_requests; c whaleu_ratings.scoped_contexts; BEGIN
 SELECT * INTO STRICT r FROM whaleu_ratings.assistance_requests WHERE account_id=NEW.account_id AND request_id=NEW.request_id;
 SELECT * INTO STRICT c FROM whaleu_ratings.scoped_contexts WHERE id=r.context_id;
 IF (EXISTS(SELECT 1 FROM whaleu_ratings.assistance_outcomes WHERE account_id=r.account_id AND request_id=r.request_id)
 OR clock_timestamp()>=r.payload_until
 OR NOT (NEW.intent ?& ARRAY['version','requestId','purpose','draftId','inputRevision','selector','context','payload'])
 OR NEW.intent-ARRAY['version','requestId','purpose','draftId','inputRevision','selector','context','payload']<>'{}'::jsonb
 OR NEW.intent->'selector' IS DISTINCT FROM NEW.intent->'context'->'selector'
 OR NEW.intent->'version' IS DISTINCT FROM '1'::jsonb OR jsonb_typeof(NEW.intent->'inputRevision') IS DISTINCT FROM 'number'
 OR NEW.intent->>'version'<>'1' OR NEW.intent->>'requestId'<>r.request_id::text OR NEW.intent->>'purpose'<>r.purpose
 OR NEW.intent->>'draftId'<>r.draft_id::text OR NEW.intent->'inputRevision' IS DISTINCT FROM to_jsonb(r.input_revision)
 OR NEW.intent->'context'->>'id'<>r.context_id::text
 OR NEW.intent->'context'->>'tokenDigest'<>c.token_digest
 OR NEW.intent->'context' IS DISTINCT FROM jsonb_build_object('id',c.id,'tokenDigest',c.token_digest,'token',NEW.intent->'context'->'token','selector',c.context->'selector','scopeRevision',c.context->'scopeRevision','protocolGeneration',c.context->'protocolGeneration','catalogRevision',coalesce(c.context->'catalogRevision',c.context->'heads'->0->'catalogRevision'),'headRevision',coalesce(c.context->'headRevision',c.context->'heads'->0->'headRevision'),'sourceDigest',c.context->'sourceDigest')
 OR encode(sha256(convert_to(NEW.intent->'context'->>'token','UTF8')),'hex')<>c.token_digest
 OR r.intent_hash<>encode(sha256(convert_to('whaleu:ratings:assistance:intent:v1'||chr(10)||whaleu_community.content_canonical_json(NEW.intent),'UTF8')),'hex')
 OR r.input_digest<>encode(sha256(convert_to('whaleu:ratings:assistance:input:v1'||chr(10)||whaleu_community.content_canonical_json(jsonb_build_object('input',NEW.provider_input,'sourceRevision',r.source_revision,'profile',r.profile,'outputContract',1)),'UTF8')),'hex')
 OR jsonb_typeof(NEW.provider_input->'name') IS DISTINCT FROM 'string' OR jsonb_typeof(NEW.provider_input->'context') IS DISTINCT FROM 'string'
 OR NEW.provider_input-ARRAY['name','context']<>'{}'::jsonb OR NOT (NEW.provider_input ?& ARRAY['name','context'])
 OR NOT whaleu_ratings.assistance_literal_text(NEW.provider_input->>'name')
 OR char_length(NEW.provider_input->>'name') NOT BETWEEN 1 AND 100 OR octet_length(NEW.provider_input->>'name')>400
 OR (r.purpose='category_description' AND (NOT whaleu_ratings.assistance_category_current(r,NEW.intent) OR NEW.source_binding<>'null'::jsonb OR r.source_revision<>whaleu_ratings.scoped_digest('assistance-category-source',jsonb_build_object('contextRecord',c.record_digest,'payload',NEW.intent->'payload')) OR NEW.provider_input->>'context'<>'rating_category' OR NEW.provider_input->>'name'<>NEW.intent->'payload'->>'name' OR c.context->>'purpose'<>'manage_categories'))
 OR (r.purpose='rating_publish_title' AND NOT whaleu_ratings.assistance_target_current(r,NEW.intent,NEW.provider_input,NEW.source_binding))
) IS DISTINCT FROM false THEN RAISE EXCEPTION 'assistance input binding mismatch' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER assistance_payload_check BEFORE INSERT ON whaleu_ratings.assistance_payloads FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.assistance_payload_check();
CREATE FUNCTION whaleu_ratings.assistance_job_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'assistance jobs retain original keys' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'queued' OR NEW.fence<>0 OR NEW.lease_until IS NOT NULL THEN RAISE EXCEPTION 'invalid initial assistance job' USING ERRCODE='23514'; END IF;
 ELSE
  IF (NEW.account_id,NEW.request_id) IS DISTINCT FROM (OLD.account_id,OLD.request_id) OR OLD.state='terminal'
  OR NOT ((OLD.state='queued' AND NEW.state='claimed' AND NEW.fence=OLD.fence+1)
    OR (OLD.state IN ('claimed','dispatch_admitted','outcome_unknown') AND OLD.lease_until<=clock_timestamp() AND NEW.state='claimed' AND NEW.fence=OLD.fence+1)
    OR (OLD.state='claimed' AND NEW.state='dispatch_admitted' AND NEW.fence=OLD.fence AND NEW.lease_until=OLD.lease_until)
    OR (OLD.state IN ('dispatch_admitted','outcome_unknown','claimed') AND NEW.state='outcome_unknown' AND NEW.fence=OLD.fence AND NEW.lease_until=OLD.lease_until)
    OR (NEW.state='terminal' AND NEW.fence=OLD.fence AND EXISTS(SELECT 1 FROM whaleu_ratings.assistance_outcomes o WHERE o.account_id=NEW.account_id AND o.request_id=NEW.request_id)))
  THEN RAISE EXCEPTION 'invalid assistance job transition' USING ERRCODE='23514'; END IF;
  IF NEW.state='claimed' THEN
    PERFORM pg_advisory_xact_lock(146,2);
    IF (SELECT count(*) FROM whaleu_ratings.assistance_jobs WHERE state IN ('claimed','dispatch_admitted') AND lease_until>clock_timestamp() AND (account_id,request_id)<>(NEW.account_id,NEW.request_id))>=4
    THEN RAISE EXCEPTION 'assistance workers exhausted' USING ERRCODE='23514';END IF;
  END IF;
  IF NEW.state='claimed' AND (NEW.lease_until<=clock_timestamp() OR NEW.lease_until>clock_timestamp()+interval '30 seconds') THEN RAISE EXCEPTION 'invalid assistance lease' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER assistance_job_transition BEFORE INSERT OR UPDATE OR DELETE ON whaleu_ratings.assistance_jobs FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.assistance_job_transition();
CREATE TRIGGER assistance_job_truncate BEFORE TRUNCATE ON whaleu_ratings.assistance_jobs FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.assistance_immutable();
CREATE FUNCTION whaleu_ratings.assistance_attempt_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r whaleu_ratings.assistance_requests; j whaleu_ratings.assistance_jobs; BEGIN
 SELECT * INTO STRICT r FROM whaleu_ratings.assistance_requests WHERE account_id=NEW.account_id AND request_id=NEW.request_id FOR SHARE;
 SELECT * INTO STRICT j FROM whaleu_ratings.assistance_jobs WHERE account_id=NEW.account_id AND request_id=NEW.request_id FOR UPDATE;
 IF j.state<>'claimed' OR j.fence<>NEW.fence OR j.lease_until<=clock_timestamp() OR r.queue_until<=clock_timestamp()
 OR EXISTS(SELECT 1 FROM whaleu_ratings.assistance_outcomes WHERE account_id=NEW.account_id AND request_id=NEW.request_id)
 OR EXISTS(SELECT 1 FROM whaleu_ratings.assistance_cancellations WHERE account_id=NEW.account_id AND request_id=NEW.request_id)
 OR NOT whaleu_ratings.scoped_context_current(r.context_id,r.account_id,r.session_id,clock_timestamp())
 OR NEW.attempt<>1+(SELECT count(*) FROM whaleu_ratings.assistance_attempts a WHERE a.account_id=NEW.account_id AND a.request_id=NEW.request_id)
 OR (NEW.attempt=2 AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.assistance_settlements s WHERE s.account_id=NEW.account_id AND s.request_id=NEW.request_id AND s.attempt=1 AND s.acceptance='not_accepted'))
 OR NEW.admitted_at>clock_timestamp() OR NEW.admitted_at<clock_timestamp()-interval '1 second'
 THEN RAISE EXCEPTION 'assistance dispatch is not admitted' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER assistance_attempt_check BEFORE INSERT ON whaleu_ratings.assistance_attempts FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.assistance_attempt_check();
CREATE FUNCTION whaleu_ratings.assistance_literal_text(value text) RETURNS boolean LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT value<>'' AND value=whaleu_profile.moderation_trim(value) AND NOT EXISTS(
  SELECT 1 FROM generate_series(1,char_length(value)) n WHERE ascii(substr(value,n,1)) BETWEEN 0 AND 31 OR ascii(substr(value,n,1)) BETWEEN 127 AND 159 OR ascii(substr(value,n,1)) BETWEEN 8232 AND 8238 OR ascii(substr(value,n,1)) BETWEEN 8294 AND 8297)
$$;
-- Frozen Unicode punctuation intervals from the accepted Node 24 contract.
CREATE FUNCTION whaleu_ratings.assistance_terminal_punctuation(value text) RETURNS boolean LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT EXISTS(SELECT 1 FROM (VALUES (33,35),(37,42),(44,47),(58,59),(63,64),(91,93),(95,95),(123,123),(125,125),(161,161),(167,167),(171,171),(182,183),(187,187),(191,191),(894,894),(903,903),(1370,1375),(1417,1418),(1470,1470),(1472,1472),(1475,1475),(1478,1478),(1523,1524),(1545,1546),(1548,1549),(1563,1563),(1565,1567),(1642,1645),(1748,1748),(1792,1805),(2039,2041),(2096,2110),(2142,2142),(2404,2405),(2416,2416),(2557,2557),(2678,2678),(2800,2800),(3191,3191),(3204,3204),(3572,3572),(3663,3663),(3674,3675),(3844,3858),(3860,3860),(3898,3901),(3973,3973),(4048,4052),(4057,4058),(4170,4175),(4347,4347),(4960,4968),(5120,5120),(5742,5742),(5787,5788),(5867,5869),(5941,5942),(6100,6102),(6104,6106),(6144,6154),(6468,6469),(6686,6687),(6816,6822),(6824,6829),(6990,6991),(7002,7008),(7037,7039),(7164,7167),(7227,7231),(7294,7295),(7360,7367),(7379,7379),(8208,8231),(8240,8259),(8261,8273),(8275,8286),(8317,8318),(8333,8334),(8968,8971),(9001,9002),(10088,10101),(10181,10182),(10214,10223),(10627,10648),(10712,10715),(10748,10749),(11513,11516),(11518,11519),(11632,11632),(11776,11822),(11824,11855),(11858,11869),(12289,12291),(12296,12305),(12308,12319),(12336,12336),(12349,12349),(12448,12448),(12539,12539),(42238,42239),(42509,42511),(42611,42611),(42622,42622),(42738,42743),(43124,43127),(43214,43215),(43256,43258),(43260,43260),(43310,43311),(43359,43359),(43457,43469),(43486,43487),(43612,43615),(43742,43743),(43760,43761),(44011,44011),(64830,64831),(65040,65049),(65072,65106),(65108,65121),(65123,65123),(65128,65128),(65130,65131),(65281,65283),(65285,65290),(65292,65295),(65306,65307),(65311,65312),(65339,65341),(65343,65343),(65371,65371),(65373,65373),(65375,65381),(65792,65794),(66463,66463),(66512,66512),(66927,66927),(67671,67671),(67871,67871),(67903,67903),(68176,68184),(68223,68223),(68336,68342),(68409,68415),(68505,68508),(68974,68974),(69293,69293),(69328,69328),(69461,69465),(69510,69513),(69703,69709),(69819,69820),(69822,69825),(69952,69955),(70004,70005),(70085,70088),(70093,70093),(70107,70107),(70109,70111),(70200,70205),(70313,70313),(70612,70613),(70615,70616),(70731,70735),(70746,70747),(70749,70749),(70854,70854),(71105,71127),(71233,71235),(71264,71276),(71353,71353),(71484,71486),(71739,71739),(72004,72006),(72162,72162),(72255,72262),(72346,72348),(72350,72354),(72448,72457),(72673,72673),(72769,72773),(72816,72817),(73463,73464),(73539,73551),(73727,73727),(74864,74868),(77809,77810),(92782,92783),(92917,92917),(92983,92987),(92996,92996),(93549,93551),(93847,93850),(94178,94178),(113823,113823),(121479,121483),(124415,124415),(125278,125279)) p(lo,hi) WHERE ascii(right(value,1)) BETWEEN lo AND hi)
$$;
CREATE FUNCTION whaleu_ratings.assistance_result_literal(p text,t text) RETURNS boolean LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT whaleu_ratings.assistance_literal_text(t) AND t !~ '[[:cntrl:]<>`{}\[\]]' AND t !~* '(https?:|www\.|[a-z][a-z0-9+.-]*://)'
 AND t !~ ('['||chr(8232)||'-'||chr(8238)||chr(8294)||'-'||chr(8297)||']')
 AND left(t,1) NOT IN ('"',chr(39),'“','”','‘','’') AND right(t,1) NOT IN ('"',chr(39),'“','”','‘','’')
 AND CASE p WHEN 'category_description' THEN char_length(t) BETWEEN 9 AND 11 AND octet_length(t)<=44 AND NOT whaleu_ratings.assistance_terminal_punctuation(t)
 WHEN 'rating_publish_title' THEN char_length(t) BETWEEN 1 AND 12 AND octet_length(t)<=48 AND right(t,1) IN ('?','？') ELSE false END
$$;
CREATE FUNCTION whaleu_ratings.assistance_final_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a uuid:=coalesce(NEW.account_id,OLD.account_id); k uuid:=coalesce(NEW.request_id,OLD.request_id); r whaleu_ratings.assistance_requests; o whaleu_ratings.assistance_outcomes; j whaleu_ratings.assistance_jobs; t text; BEGIN
 SELECT * INTO r FROM whaleu_ratings.assistance_requests WHERE account_id=a AND request_id=k;
 SELECT * INTO o FROM whaleu_ratings.assistance_outcomes WHERE account_id=a AND request_id=k;
 SELECT * INTO j FROM whaleu_ratings.assistance_jobs WHERE account_id=a AND request_id=k;
 IF r.request_id IS NULL AND o.request_id IS NULL THEN RAISE EXCEPTION 'assistance claim cause missing' USING ERRCODE='23514'; END IF;
 IF r.request_id IS NOT NULL AND (j.request_id IS NULL OR (o.request_id IS NULL AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.assistance_payloads WHERE account_id=a AND request_id=k)))
 THEN RAISE EXCEPTION 'incomplete assistance admission' USING ERRCODE='23514'; END IF;
 IF o.request_id IS NOT NULL AND j.request_id IS NOT NULL AND j.state<>'terminal' THEN RAISE EXCEPTION 'terminal assistance job missing' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM whaleu_ratings.assistance_cancellations x WHERE x.account_id=a AND x.request_id=k)
 AND (o.request_id IS NULL OR EXISTS(SELECT 1 FROM whaleu_ratings.assistance_payloads p WHERE p.account_id=a AND p.request_id=k) OR EXISTS(SELECT 1 FROM whaleu_ratings.assistance_results p WHERE p.account_id=a AND p.request_id=k))
 THEN RAISE EXCEPTION 'incomplete assistance cancellation' USING ERRCODE='23514';END IF;
 IF o.outcome='cancelled' AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.assistance_cancellations x WHERE x.account_id=a AND x.request_id=k)
 THEN RAISE EXCEPTION 'assistance cancellation cause missing' USING ERRCODE='23514';END IF;
 IF o.outcome<>'generated' AND (EXISTS(SELECT 1 FROM whaleu_ratings.assistance_payloads p WHERE p.account_id=a AND p.request_id=k) OR EXISTS(SELECT 1 FROM whaleu_ratings.assistance_results p WHERE p.account_id=a AND p.request_id=k))
 THEN RAISE EXCEPTION 'terminal assistance plaintext remains' USING ERRCODE='23514';END IF;

 IF TG_TABLE_NAME='assistance_attempts' AND TG_OP='INSERT' THEN
  IF j.fence IS DISTINCT FROM NEW.fence OR j.state NOT IN ('dispatch_admitted','outcome_unknown','terminal') OR j.lease_until<=clock_timestamp() OR NEW.dispatch_until<=clock_timestamp() OR r.queue_until<=clock_timestamp()
  THEN RAISE EXCEPTION 'assistance attempt final fence expired' USING ERRCODE='23514';END IF;
 END IF;
 IF j.state='dispatch_admitted' AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.assistance_attempts x WHERE x.account_id=a AND x.request_id=k AND x.fence=j.fence)
 THEN RAISE EXCEPTION 'assistance unknown-before-effect missing' USING ERRCODE='23514'; END IF;
 IF o.outcome='generated' AND TG_TABLE_NAME IN ('assistance_outcomes','assistance_results') AND TG_OP<>'DELETE' THEN
  SELECT literal_text INTO t FROM whaleu_ratings.assistance_results WHERE account_id=a AND request_id=k;
  IF EXISTS(SELECT 1 FROM whaleu_ratings.assistance_cancellations x WHERE x.account_id=a AND x.request_id=k) OR r.request_id IS NULL OR j.fence<>o.fence OR r.payload_until<=clock_timestamp() OR j.lease_until<=clock_timestamp() OR o.occurred_at>clock_timestamp()
  OR (TG_TABLE_NAME IN ('assistance_outcomes','assistance_results') AND NOT whaleu_ratings.scoped_context_current(r.context_id,r.account_id,r.session_id,clock_timestamp()))
  OR (TG_TABLE_NAME IN ('assistance_outcomes','assistance_results') AND (t IS NULL OR NOT whaleu_ratings.assistance_result_literal(o.purpose,t)))
  OR NOT EXISTS(SELECT 1 FROM whaleu_ratings.assistance_attempts x JOIN whaleu_ratings.assistance_settlements s USING(account_id,request_id,attempt,fence,input_digest,profile) WHERE x.account_id=a AND x.request_id=k AND x.attempt=o.attempt AND x.fence=o.fence AND s.acceptance='accepted' AND x.dispatch_until>clock_timestamp() AND o.occurred_at>=x.admitted_at)
  THEN RAISE EXCEPTION 'incomplete assistance result cause' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NULL;
END $$;
DO $$ DECLARE n text; BEGIN
 FOREACH n IN ARRAY ARRAY['assistance_claims','assistance_cancellations','assistance_requests','assistance_payloads','assistance_jobs','assistance_attempts','assistance_settlements','assistance_outcomes','assistance_results'] LOOP
 EXECUTE format('CREATE CONSTRAINT TRIGGER assistance_completeness AFTER INSERT OR UPDATE OR DELETE ON whaleu_ratings.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.assistance_final_check()',n);
 END LOOP;
END $$;
CREATE INDEX assistance_jobs_claimable ON whaleu_ratings.assistance_jobs(state,lease_until);
CREATE INDEX assistance_requests_quotas ON whaleu_ratings.assistance_requests(account_id,admitted_at);
CREATE INDEX assistance_requests_cleanup ON whaleu_ratings.assistance_requests(payload_until);
-- Finite status-only reconciliation; no new generation idempotency key.
CREATE TABLE whaleu_ratings.assistance_reconciliations (
 account_id uuid NOT NULL, request_id uuid NOT NULL, attempt integer NOT NULL,
 ordinal integer NOT NULL CHECK(ordinal BETWEEN 1 AND 3),
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(account_id,request_id,attempt,ordinal),
 FOREIGN KEY(account_id,request_id,attempt) REFERENCES whaleu_ratings.assistance_attempts(account_id,request_id,attempt)
);
CREATE TRIGGER immutable_assistance_reconciliation BEFORE UPDATE OR DELETE OR TRUNCATE ON whaleu_ratings.assistance_reconciliations FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.assistance_immutable();
CREATE FUNCTION whaleu_ratings.assistance_reconciliation_order() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM 1 FROM whaleu_ratings.assistance_attempts WHERE account_id=NEW.account_id AND request_id=NEW.request_id AND attempt=NEW.attempt FOR UPDATE;
 IF NEW.ordinal<>1+(SELECT count(*) FROM whaleu_ratings.assistance_reconciliations WHERE account_id=NEW.account_id AND request_id=NEW.request_id AND attempt=NEW.attempt)
 THEN RAISE EXCEPTION 'assistance reconciliation order' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER assistance_reconciliation_order BEFORE INSERT ON whaleu_ratings.assistance_reconciliations FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.assistance_reconciliation_order();
-- Category assistance reuses the category owner's all-of SQL authority facade.
-- It does not query or mint role grants and never creates a publication plan.
CREATE FUNCTION whaleu_ratings.assistance_category_current(r whaleu_ratings.assistance_requests,i jsonb) RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
DECLARE c whaleu_ratings.scoped_contexts;p jsonb:=i->'payload';keys text[];campuses uuid[];global_required boolean;selected text; BEGIN
 SELECT * INTO c FROM whaleu_ratings.scoped_contexts WHERE id=r.context_id;
 selected:=CASE WHEN i->'selector'->>'kind'='global' THEN 'global' ELSE 'campus:'||(i->'selector'->>'campusId') END;
 IF p->'placement'->>'kind'='global' THEN keys:=ARRAY['global'];campuses:=ARRAY[]::uuid[];
 ELSIF p->'placement'->>'kind'='campuses' THEN
  campuses:=ARRAY(SELECT value::uuid FROM jsonb_array_elements_text(p->'placement'->'campusIds'));
  keys:=ARRAY(SELECT 'campus:'||x::text FROM unnest(campuses) x);
 ELSE RETURN false; END IF;
 IF NOT selected=ANY(keys) THEN keys:=array_append(keys,selected);IF selected<>'global' THEN campuses:=array_append(campuses,substring(selected from 8)::uuid);END IF;END IF;
 global_required:='global'=ANY(keys) OR p->>'operation'='create_system_category_scoped';
 RETURN coalesce(
 whaleu_community.related_sync_exact_keys(p,CASE WHEN p->>'operation'='create_categories_scoped' THEN ARRAY['operation','draftNodeKey','name','placement','expectedSnapshot','parentId'] ELSE ARRAY['operation','draftNodeKey','name','placement','expectedSnapshot','systemKey','levelCount'] END)
 AND jsonb_typeof(p->'name')='string' AND jsonb_typeof(p->'draftNodeKey')='string'
 AND (p->>'operation'<>'create_system_category_scoped' OR (jsonb_typeof(p->'systemKey')='string' AND p->'levelCount' IN ('1'::jsonb,'2'::jsonb,'3'::jsonb)))
 AND p->>'draftNodeKey' ~ '^[a-z][a-z0-9_]{0,31}$'
 AND whaleu_community.rating_scoped_placement_shape(p->'placement')
 AND c.context->>'purpose'='manage_categories' AND c.context->>'mode'='management'
 AND p->>'expectedSnapshot'=c.context->>'managementSnapshot'
 AND r.source_revision=whaleu_ratings.scoped_digest('assistance-category-source',jsonb_build_object('contextRecord',c.record_digest,'payload',p))
 AND whaleu_ratings.scoped_context_current(c.id,r.account_id,r.session_id,clock_timestamp())
 AND whaleu_ratings.category_management_actor_current(r.account_id,clock_timestamp())
 AND whaleu_authorization.rating_category_management_authority_covers(r.account_id,campuses,global_required)
 AND NOT EXISTS(SELECT 1 FROM unnest(keys) wanted LEFT JOIN whaleu_ratings.scoped_catalog_heads h ON h.scope_key=wanted WHERE h.catalog_id IS NULL OR NOT whaleu_ratings.scoped_catalog_current(h.catalog_id,clock_timestamp()))
 AND p->>'operation' IN ('create_categories_scoped','create_system_category_scoped')
 AND (p->>'operation'<>'create_categories_scoped' OR p->'parentId'='null'::jsonb)
 AND (SELECT count(*) FROM whaleu_ratings.scoped_source_heads h JOIN whaleu_ratings.scoped_source_attestations s ON (s.id,s.revision)=(h.source_id,h.source_revision) WHERE s.source_kind='native_scoped_category_management' AND s.scope_keys @> keys AND s.payload->'enabled'='true'::jsonb AND s.payload->'operations' ? (p->>'operation') AND whaleu_ratings.scoped_source_current(s.id,s.revision,clock_timestamp()))=1
 AND (p->>'operation'<>'create_system_category_scoped' OR (SELECT count(*) FROM whaleu_ratings.scoped_source_heads h JOIN whaleu_ratings.scoped_source_attestations s ON (s.id,s.revision)=(h.source_id,h.source_revision) WHERE s.source_kind='scoped_category_system_registry' AND s.payload->>'systemKey'=p->>'systemKey' AND s.payload->>'consumer'='ratings_general_v1' AND s.payload->>'kind'='general' AND s.payload->'enabled'='true'::jsonb AND (p->>'levelCount')::int BETWEEN 1 AND least(3,(s.payload->>'maximumDepth')::int) AND whaleu_ratings.scoped_source_current(s.id,s.revision,clock_timestamp()))=1),false);
EXCEPTION WHEN others THEN RETURN false;END $$;
CREATE FUNCTION whaleu_ratings.assistance_current_category_proof() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r whaleu_ratings.assistance_requests;p whaleu_ratings.assistance_payloads; BEGIN
 SELECT * INTO r FROM whaleu_ratings.assistance_requests WHERE account_id=NEW.account_id AND request_id=NEW.request_id;
 IF r.purpose IS DISTINCT FROM 'category_description' THEN RETURN NULL;END IF;
 IF TG_TABLE_NAME='assistance_outcomes' THEN IF NEW.outcome<>'generated' THEN RETURN NULL;END IF;END IF;
 PERFORM whaleu_ratings.assistance_current_fences(r.purpose);
 SELECT * INTO p FROM whaleu_ratings.assistance_payloads WHERE account_id=r.account_id AND request_id=r.request_id;
 IF p.request_id IS NULL OR NOT whaleu_ratings.assistance_category_current(r,p.intent) THEN RAISE EXCEPTION 'assistance category proof changed' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER assistance_current_category_proof AFTER INSERT ON whaleu_ratings.assistance_attempts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.assistance_current_category_proof();
CREATE CONSTRAINT TRIGGER assistance_current_category_proof AFTER INSERT ON whaleu_ratings.assistance_outcomes DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.assistance_current_category_proof();
-- Resolved only at execution after the additive card owner migration 0148.
CREATE FUNCTION whaleu_ratings.assistance_target_current(r whaleu_ratings.assistance_requests,i jsonb,provider_input jsonb,binding jsonb) RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
DECLARE c whaleu_ratings.scoped_contexts;b jsonb:=binding->'target';destination jsonb:=binding->'destinationScope'; BEGIN
 SELECT * INTO c FROM whaleu_ratings.scoped_contexts WHERE id=r.context_id;
 RETURN coalesce(whaleu_community.related_sync_exact_keys(binding,ARRAY['target','destinationScope'])
 AND whaleu_community.related_sync_exact_keys(i->'payload',ARRAY['targetId','expectedTargetRevision','expectedCategoryRevision','expectedSourceRevision','destination'])
 AND whaleu_community.related_sync_exact_keys(i->'payload'->'destination',ARRAY['spaceId','category','authorMode'])
 AND c.context->>'mode'='public' AND c.context->>'purpose' IN ('read','interact')
 AND whaleu_ratings.scoped_context_current(c.id,r.account_id,r.session_id,clock_timestamp())
 AND whaleu_ratings.category_management_actor_current(r.account_id,clock_timestamp())
 AND whaleu_safety.account_punishment_allows(r.account_id,'interaction')
 AND r.source_revision=whaleu_ratings.scoped_digest('assistance-target-source',binding)
 AND whaleu_community.rating_target_link_destination_current(r.account_id,destination,i->'payload'->'destination'->>'authorMode')
 AND destination->>'originalSpaceId'=i->'payload'->'destination'->>'spaceId'
 AND whaleu_ratings.community_link_binding_current(b,true)
 AND i->'selector'=b->'selector'
 AND i->'payload'->>'targetId'=b->>'targetId'
 AND i->'payload'->>'expectedTargetRevision'=b->>'targetRevision'
 AND i->'payload'->>'expectedCategoryRevision'=b->>'categoryRevision'
 AND i->'payload'->>'expectedSourceRevision'=b->>'sourceRevision'
 AND provider_input->>'context'=b->>'systemKey'
 AND EXISTS(SELECT 1 FROM whaleu_ratings.target_definition_versions d WHERE d.target_id=(b->>'targetId')::uuid AND d.definition_revision=(b->>'definitionRevision')::uuid AND d.name=provider_input->>'name')
 AND i->'payload'->'destination'->>'category'='discussion'
 AND EXISTS(SELECT 1 FROM whaleu_community.spaces s WHERE s.id=(i->'payload'->'destination'->>'spaceId')::uuid AND s.is_active AND s.kind='regional' AND (b->'selector'->>'kind'='global' OR EXISTS(SELECT 1 FROM whaleu_campus.campus_region_assignments a WHERE a.campus_id=(b->'selector'->>'campusId')::uuid AND a.operating_region_id=s.operating_region_id))),false);
EXCEPTION WHEN others THEN RETURN false;END $$;
CREATE FUNCTION whaleu_ratings.assistance_current_target_proof() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r whaleu_ratings.assistance_requests;p whaleu_ratings.assistance_payloads; BEGIN
 SELECT * INTO r FROM whaleu_ratings.assistance_requests WHERE account_id=NEW.account_id AND request_id=NEW.request_id;
 IF r.purpose IS DISTINCT FROM 'rating_publish_title' THEN RETURN NULL;END IF;
 IF TG_TABLE_NAME='assistance_outcomes' THEN IF NEW.outcome<>'generated' THEN RETURN NULL;END IF;END IF;
 PERFORM whaleu_ratings.assistance_current_fences(r.purpose);
 SELECT * INTO p FROM whaleu_ratings.assistance_payloads WHERE account_id=r.account_id AND request_id=r.request_id;
 IF p.request_id IS NULL OR NOT whaleu_ratings.assistance_target_current(r,p.intent,p.provider_input,p.source_binding) THEN RAISE EXCEPTION 'assistance target proof changed' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER assistance_current_target_proof AFTER INSERT ON whaleu_ratings.assistance_attempts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.assistance_current_target_proof();
CREATE CONSTRAINT TRIGGER assistance_current_target_proof AFTER INSERT ON whaleu_ratings.assistance_outcomes DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.assistance_current_target_proof();
CREATE FUNCTION whaleu_ratings.assistance_plaintext_retirement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM whaleu_ratings.assistance_requests r WHERE r.account_id=OLD.account_id AND r.request_id=OLD.request_id AND r.payload_until<=clock_timestamp())
 AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.assistance_cancellations c WHERE c.account_id=OLD.account_id AND c.request_id=OLD.request_id)
 AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.assistance_outcomes o WHERE o.account_id=OLD.account_id AND o.request_id=OLD.request_id AND o.outcome<>'generated')
 THEN RAISE EXCEPTION 'live assistance plaintext cannot lose its cause' USING ERRCODE='23514';END IF;
 RETURN OLD;
END $$;
CREATE TRIGGER assistance_plaintext_retirement BEFORE DELETE ON whaleu_ratings.assistance_payloads FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.assistance_plaintext_retirement();
CREATE TRIGGER assistance_plaintext_retirement BEFORE DELETE ON whaleu_ratings.assistance_results FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.assistance_plaintext_retirement();
CREATE TRIGGER assistance_plaintext_truncate BEFORE TRUNCATE ON whaleu_ratings.assistance_payloads FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.assistance_immutable();
CREATE TRIGGER assistance_plaintext_truncate BEFORE TRUNCATE ON whaleu_ratings.assistance_results FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.assistance_immutable();
-- Mandatory bounded final fences. Table locks are conservative NOWAIT fences,
-- not reads of foreign grants or substitutes for each owner's current proof.
CREATE FUNCTION whaleu_ratings.assistance_current_fences(purpose text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 LOCK TABLE whaleu_identity.accounts,whaleu_identity.sessions,
 whaleu_verification.account_heads,whaleu_safety.account_heads,whaleu_safety.account_punishment_heads,
 whaleu_authorization.role_grants,whaleu_authorization.rating_category_campus_grants,
 whaleu_ratings.scoped_source_epoch,whaleu_ratings.scope_protocol_epoch,whaleu_ratings.scoped_catalog_heads,
 whaleu_ratings.navigation_epoch,whaleu_ratings.random_pool_epoch,
 whaleu_ratings.target_cover_capability_epoch,whaleu_ratings.category_icon_epoch,whaleu_media.media_owner_states,
 whaleu_community.rating_review_epoch,whaleu_community.rating_review_binding_epoch,whaleu_community.content_approval_policies,
 whaleu_campus.community_identity_heads,whaleu_campus.community_topology_heads,whaleu_campus.community_topology_snapshots,
 whaleu_campus.campuses,whaleu_campus.institutions,whaleu_campus.campus_region_assignments,whaleu_campus.operating_regions,
 whaleu_community.spaces,whaleu_community.region_policy_heads,whaleu_community.region_policy_revisions
 IN SHARE MODE NOWAIT;
END $$;
CREATE CONSTRAINT TRIGGER assistance_current_category_admission AFTER INSERT ON whaleu_ratings.assistance_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.assistance_current_category_proof();
CREATE CONSTRAINT TRIGGER assistance_current_target_admission AFTER INSERT ON whaleu_ratings.assistance_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.assistance_current_target_proof();
