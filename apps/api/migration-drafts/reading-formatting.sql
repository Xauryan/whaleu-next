-- EXECUTABLE DRAFT. Install only in an isolated controlled test database after M1.
-- No automatic migration number is reserved. No erasure owner is admitted.
-- The explicit draft installer must use one transaction and set this marker locally.
-- Integration must replace this disposable-only admission block after assigning a number.
DO $$BEGIN
 IF current_database()<>'whaleu_test' OR current_setting('application_name')<>'whaleu-reading-controlled-test'
 OR (inet_server_addr() IS NOT NULL AND inet_server_addr() NOT IN ('127.0.0.1'::inet,'::1'::inet))
 OR to_regclass('whaleu_community.community_text_sources') IS NULL
 OR to_regclass('whaleu_community.reading_format_heads') IS NOT NULL THEN
  RAISE EXCEPTION 'Reading draft requires fresh controlled local M1 test installation' USING ERRCODE='23514';
 END IF;
END$$;
CREATE TABLE whaleu_community.reading_format_heads (
 content_kind text NOT NULL CHECK(content_kind IN ('post','comment','reply')), content_id uuid NOT NULL,
 source_revision integer NOT NULL CHECK(source_revision=1), source_hash text NOT NULL CHECK(source_hash ~ '^[a-f0-9]{64}$'), publication_request_id uuid NOT NULL,
 formatter_version text NOT NULL CHECK(formatter_version='plain-cjk-slices-v2'), generation integer NOT NULL CHECK(generation=1),
 state text NOT NULL CHECK(state='active'), row_version integer NOT NULL CHECK(row_version=1),
 created_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(), created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 PRIMARY KEY(content_kind,content_id), FOREIGN KEY(content_kind,content_id) REFERENCES whaleu_community.community_text_sources(content_kind,content_id),
 UNIQUE(content_kind,content_id,source_revision,source_hash,publication_request_id,formatter_version,generation)
);
CREATE TABLE whaleu_community.reading_format_jobs (
 job_key text PRIMARY KEY CHECK(job_key ~ '^[a-f0-9]{64}$'), content_kind text NOT NULL, content_id uuid NOT NULL,
 source_revision integer NOT NULL,source_hash text NOT NULL,publication_request_id uuid NOT NULL,formatter_version text NOT NULL,generation integer NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','complete','exhausted')),
 claims integer NOT NULL DEFAULT 0 CHECK(claims BETWEEN 0 AND 3), lease_fence bigint NOT NULL DEFAULT 0 CHECK(lease_fence BETWEEN 0 AND 2147483647),
 lease_token uuid, lease_until timestamptz, slot_id integer CHECK(slot_id IN (1,2)),
 schedule_state text NOT NULL DEFAULT 'runnable' CHECK(schedule_state IN ('runnable','deferred','quarantined')),
 probe_count integer NOT NULL DEFAULT 0 CHECK(probe_count BETWEEN 0 AND 3),next_probe_at timestamptz DEFAULT clock_timestamp(),next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 scheduling_reason text CHECK(scheduling_reason IN ('authority_unavailable','invalid_payload','claims_exhausted','completed','computation_retry')),
 row_version bigint NOT NULL DEFAULT 1 CHECK(row_version BETWEEN 1 AND 2147483647),
 write_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 FOREIGN KEY(content_kind,content_id,source_revision,source_hash,publication_request_id,formatter_version,generation) REFERENCES whaleu_community.reading_format_heads(content_kind,content_id,source_revision,source_hash,publication_request_id,formatter_version,generation),
 UNIQUE(content_kind,content_id,generation),
 CHECK((schedule_state='quarantined' AND next_probe_at IS NULL) OR (schedule_state IN ('runnable','deferred') AND next_probe_at IS NOT NULL AND isfinite(next_probe_at))),
 CHECK(isfinite(next_attempt_at)), CHECK(probe_count<3 OR schedule_state='quarantined'),
 CHECK((state='pending' AND lease_token IS NULL AND lease_until IS NULL AND slot_id IS NULL) OR (state='running' AND claims>0 AND lease_token IS NOT NULL AND lease_until IS NOT NULL AND isfinite(lease_until) AND slot_id IS NOT NULL) OR (state IN ('complete','exhausted') AND lease_token IS NULL AND lease_until IS NULL AND slot_id IS NULL)),
 CHECK(state NOT IN ('complete','exhausted') OR schedule_state='quarantined')
);
CREATE INDEX reading_format_due ON whaleu_community.reading_format_jobs(next_probe_at,job_key) WHERE schedule_state IN ('runnable','deferred');
CREATE INDEX reading_format_write_transaction ON whaleu_community.reading_format_jobs(write_transaction);
CREATE TABLE whaleu_community.reading_format_slots (
 slot_id integer PRIMARY KEY CHECK(slot_id IN (1,2)),job_key text REFERENCES whaleu_community.reading_format_jobs(job_key),lease_token uuid,lease_fence bigint,lease_until timestamptz,
 row_version bigint NOT NULL DEFAULT 1 CHECK(row_version BETWEEN 1 AND 2147483647),
 CHECK((job_key IS NULL AND lease_token IS NULL AND lease_fence IS NULL AND lease_until IS NULL) OR (job_key IS NOT NULL AND lease_token IS NOT NULL AND lease_fence>0 AND lease_until IS NOT NULL AND isfinite(lease_until)))
);
INSERT INTO whaleu_community.reading_format_slots(slot_id) VALUES(1),(2);
CREATE TABLE whaleu_community.reading_format_results (
 job_key text PRIMARY KEY REFERENCES whaleu_community.reading_format_jobs(job_key),plan jsonb NOT NULL CHECK(octet_length(plan::text)<=8192),
 lease_token uuid NOT NULL,lease_fence bigint NOT NULL CHECK(lease_fence>0),lease_until timestamptz NOT NULL CHECK(isfinite(lease_until)),created_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION whaleu_community.reading_format_key(kind text,id uuid,hash text,request uuid) RETURNS text LANGUAGE sql IMMUTABLE AS $$
 SELECT encode(sha256(convert_to('whaleu-reading-formatting-job:v1'||chr(10)||'['||to_jsonb(kind)::text||','||to_jsonb(id)::text||',1,'||to_jsonb(hash)::text||','||to_jsonb(request)::text||',"plain-cjk-slices-v2",1]','UTF8')),'hex')
$$;
CREATE FUNCTION whaleu_community.reading_format_utf16_length(body text) RETURNS integer LANGUAGE sql IMMUTABLE AS $$
 SELECT coalesce(sum(CASE WHEN ascii(c)>65535 THEN 2 ELSE 1 END),0)::integer FROM regexp_split_to_table(body,'') c
$$;
CREATE FUNCTION whaleu_community.reading_format_plan(body text) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE ch text;cp integer;stack text[]:=ARRAY[]::text[];opens text:='“‘「『（([【《〈{';closes text:='”’」』）)]】》〉}';pos integer;i integer;n integer:=char_length(body);line_start integer:=0;line_end integer;cursor integer;chosen integer;cuts integer[]:=ARRAY[]::integer[];boundaries integer[]:=ARRAY[]::integer[];ends integer[]:=ARRAY[]::integer[];cut integer;previous integer:=0;spans jsonb:='[]'::jsonb;reason text:='no_safe_boundary';BEGIN
 FOR i IN 1..n LOOP ch:=substr(body,i,1);cp:=ascii(ch);
  IF NOT(cp IN (9,10) OR cp BETWEEN 32 AND 126 OR cp BETWEEN 13312 AND 19903 OR cp BETWEEN 19968 AND 40959 OR cp BETWEEN 65296 AND 65305 OR cp BETWEEN 65313 AND 65338 OR cp BETWEEN 65345 AND 65370 OR strpos('。！？“”‘’「」『』（）【】《》〈〉，、；：…—　',ch)>0) THEN reason:='unsupported_unicode';EXIT;END IF;
 END LOOP;
 IF reason<>'unsupported_unicode' AND (body ~ '[`<>]' OR (body COLLATE "C") ~* 'https?://|www\.|(^|[^A-Za-z0-9_])[A-Za-z0-9_]+://' OR body ~ E'(^|\n)[ \t]*(#{1,6}[ \t]|[-+*][ \t]|[0-9]+[.)、][ \t]*|[|>])' OR strpos(body,chr(36)||chr(36))>0 OR strpos(body,'~~~')>0) THEN reason:='structure_sensitive';END IF;
 IF reason='no_safe_boundary' THEN
  FOR i IN 1..n LOOP ch:=substr(body,i,1);
   IF ch='"' THEN IF stack[array_length(stack,1)]='"' THEN stack:=trim_array(stack,1);ELSE stack:=array_append(stack,'"');END IF;
   ELSIF strpos(opens,ch)>0 THEN pos:=strpos(opens,ch);stack:=array_append(stack,substr(closes,pos,1));
   ELSIF strpos(closes,ch)>0 THEN IF cardinality(stack)=0 OR stack[cardinality(stack)]<>ch THEN reason:='structure_sensitive';EXIT;END IF;stack:=trim_array(stack,1);END IF;
   IF strpos('。！？',ch)>0 AND cardinality(stack)=0 AND (i=n OR strpos('。！？',substr(body,i+1,1))=0) THEN boundaries:=array_append(boundaries,i);END IF;
   IF ch=chr(10) OR i=n THEN
    line_end:=CASE WHEN ch=chr(10) THEN i-1 ELSE i END;cursor:=line_start;
    LOOP SELECT b INTO chosen FROM unnest(boundaries) b WHERE b-cursor BETWEEN 100 AND 180 AND line_end-b>=60 ORDER BY abs(b-cursor-140),b LIMIT 1;
     EXIT WHEN chosen IS NULL;cuts:=array_append(cuts,chosen);cursor:=chosen;
    END LOOP;boundaries:=ARRAY[]::integer[];line_start:=i;
   END IF;
  END LOOP;
  IF cardinality(stack)>0 THEN reason:='structure_sensitive';END IF;
 END IF;
 IF reason IN ('unsupported_unicode','structure_sensitive') OR cardinality(cuts)=0 THEN
  RETURN jsonb_build_object('version',1,'formatter','plain-cjk-slices-v2','offsetEncoding','utf16','mode','unchanged','reason',reason,'spans',jsonb_build_array(jsonb_build_object('start',0,'end',whaleu_community.reading_format_utf16_length(body))));
 END IF;
 ends:=array_append(cuts,n);FOREACH cut IN ARRAY ends LOOP spans:=spans||jsonb_build_array(jsonb_build_object('start',previous,'end',cut));previous:=cut;END LOOP;
 RETURN jsonb_build_object('version',1,'formatter','plain-cjk-slices-v2','offsetEncoding','utf16','mode','grouped','reason','grouped','spans',spans);
END$$;
-- A deliberately conservative processing profile, not reader access or posting eligibility.
CREATE FUNCTION whaleu_community.reading_format_source_current(kind text,target uuid) RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
DECLARE s whaleu_community.community_text_sources;n record;b whaleu_community.content_approval_bindings;d whaleu_community.content_approval_decisions;p whaleu_community.posts;target_row record;seen integer:=0;expected integer;BEGIN
 SELECT * INTO s FROM whaleu_community.community_text_sources WHERE content_kind=kind AND content_id=target;
 SELECT account_id AS subject_id,post_id INTO target_row FROM whaleu_community.profile_moderation_nodes(kind,target) WHERE profile_moderation_nodes.kind=reading_format_source_current.kind AND id=target;
 IF s.content_id IS NULL OR target_row.subject_id IS NULL OR s.source_format<>'plain' OR s.reading_formatting IS DISTINCT FROM 'auto' THEN RETURN false;END IF;
 SELECT * INTO p FROM whaleu_community.posts WHERE id=target_row.post_id;
 IF p.id IS NULL OR p.publication_state<>'published' OR p.publication_envelope_version NOT IN (1,2,6)
 OR EXISTS(SELECT 1 FROM whaleu_community.post_owner_visibility WHERE post_id=p.id AND owner_hidden)
 OR EXISTS(SELECT 1 FROM whaleu_community.post_category_heads WHERE post_id=p.id)
 OR NOT EXISTS(SELECT 1 FROM whaleu_community.spaces x LEFT JOIN whaleu_campus.operating_regions r ON r.id=x.operating_region_id WHERE x.id=p.space_id AND x.is_active AND (x.operating_region_id IS NULL OR r.is_active))
 OR whaleu_safety.account_punishment_allows(s.account_id,'passive_bookkeeping') IS DISTINCT FROM true THEN RETURN false;END IF;
 expected:=CASE kind WHEN 'post' THEN 1 WHEN 'comment' THEN 2 WHEN 'reply' THEN 3 ELSE 0 END;
 FOR n IN SELECT * FROM whaleu_community.profile_moderation_nodes(kind,target) LOOP
  seen:=seen+1;
  SELECT * INTO b FROM whaleu_community.content_approval_bindings WHERE content_kind=n.kind AND content_id=n.id AND content_version=1;
  SELECT * INTO d FROM whaleu_community.content_approval_decisions WHERE id=b.decision_id;
  IF n.payload->>'visibility' IS DISTINCT FROM 'approved' OR n.payload->'deleted_at' IS DISTINCT FROM 'null'::jsonb OR b.account_id IS DISTINCT FROM n.account_id OR b.content_id IS NULL OR b.envelope_version NOT IN (1,2,6) OR b.envelope->'scope'->>'sync' IS DISTINCT FROM 'none'
   OR b.envelope->'component' IS DISTINCT FROM '{"kind":"none"}'::jsonb OR b.envelope->'trading' IS DISTINCT FROM 'null'::jsonb
   OR NOT EXISTS(SELECT 1 FROM whaleu_community.spaces space WHERE space.id=p.space_id AND space.kind IN ('regional','global') AND space.id::text=b.scope->>'originalSpaceId' AND space.operating_region_id::text IS NOT DISTINCT FROM b.scope->>'originalRegionId')
   OR b.envelope IS DISTINCT FROM whaleu_community.profile_moderation_definition(n.kind,n.id,b.scope)
   OR (b.account_id,b.operation,b.envelope_version,b.digest,b.envelope,b.scope) IS DISTINCT FROM (d.account_id,d.operation,d.envelope_version,d.digest,d.envelope,d.envelope->'scope')
   OR whaleu_community.text_source_review_current(b.decision_id) IS DISTINCT FROM true
   OR whaleu_community.profile_moderation_media_current(n.kind,n.id,b.envelope->'images') IS DISTINCT FROM true
   OR NOT EXISTS(SELECT 1 FROM whaleu_identity.accounts WHERE id=b.account_id AND status='active' AND lifecycle='active') THEN RETURN false;END IF;
  IF n.kind=kind AND n.id=target AND (b.envelope_version<>6 OR b.account_id<>s.account_id OR b.decision_id<>s.decision_id OR b.digest<>s.approval_digest OR char_length(b.envelope->>'text')<CASE kind WHEN 'post' THEN 300 ELSE 200 END OR s.source_hash IS DISTINCT FROM whaleu_community.text_source_hash('plain',b.envelope->>'text')) THEN RETURN false;END IF;
 END LOOP;
 RETURN seen=expected;
EXCEPTION WHEN OTHERS THEN RETURN false;END$$;
-- Independent SQL fence includes every read dependency, including first insertion/absence.
CREATE FUNCTION whaleu_community.reading_format_source_fence() RETURNS void LANGUAGE plpgsql AS $$BEGIN
 PERFORM whaleu_community.text_source_fence();
 LOCK TABLE whaleu_identity.accounts,whaleu_campus.operating_regions,
 whaleu_community.posts,whaleu_community.root_comments,whaleu_community.replies,whaleu_community.spaces,
 whaleu_community.community_text_sources,whaleu_community.content_approval_bindings,whaleu_community.content_approval_decisions,whaleu_community.content_approval_events,
 whaleu_community.post_owner_visibility,whaleu_community.post_category_heads,whaleu_community.post_images,whaleu_community.comment_images,whaleu_community.reply_images,
 whaleu_community.polls,whaleu_community.poll_options,whaleu_community.formations,whaleu_community.formation_members,
 whaleu_media.bindings,whaleu_media.assets,whaleu_media.upload_intents,whaleu_media.asset_safety_heads,whaleu_media.asset_safety_events IN SHARE MODE NOWAIT;
END$$;
CREATE FUNCTION whaleu_community.reading_format_head_guard() RETURNS trigger LANGUAGE plpgsql AS $$DECLARE s whaleu_community.community_text_sources;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Reading source generation is immutable' USING ERRCODE='23514';END IF;
 SELECT * INTO s FROM whaleu_community.community_text_sources WHERE content_kind=NEW.content_kind AND content_id=NEW.content_id;
 IF s.publication_transaction IS DISTINCT FROM pg_current_xact_id() OR NEW.created_transaction IS DISTINCT FROM pg_current_xact_id() OR NEW.created_at IS DISTINCT FROM transaction_timestamp()
 OR (NEW.source_revision,NEW.source_hash,NEW.publication_request_id) IS DISTINCT FROM (s.source_revision,s.source_hash,s.client_request_id) THEN RAISE EXCEPTION 'Reading enrollment requires same created publication' USING ERRCODE='23514';END IF;
 PERFORM whaleu_community.text_source_assert(NEW.content_kind,NEW.content_id);
 PERFORM whaleu_community.reading_format_source_fence();
 IF NOT whaleu_community.reading_format_source_current(NEW.content_kind,NEW.content_id) THEN RAISE EXCEPTION 'Reading processing authority unavailable' USING ERRCODE='23514';END IF;RETURN NEW;
END$$;
CREATE TRIGGER reading_head_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_community.reading_format_heads FOR EACH ROW EXECUTE FUNCTION whaleu_community.reading_format_head_guard();
CREATE TRIGGER reading_head_no_truncate BEFORE TRUNCATE ON whaleu_community.reading_format_heads FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.content_approval_immutable();
CREATE FUNCTION whaleu_community.reading_format_job_guard() RETURNS trigger LANGUAGE plpgsql AS $$DECLARE old_plain jsonb;new_plain jsonb;instant timestamptz:=clock_timestamp();BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Reading job deletion requires admitted erasure owner' USING ERRCODE='23514';END IF;
 IF (TG_OP='INSERT' OR OLD.write_transaction IS DISTINCT FROM pg_current_xact_id()) AND (SELECT count(*) FROM (SELECT 1 FROM whaleu_community.reading_format_jobs WHERE write_transaction=pg_current_xact_id() LIMIT 8) bounded)>=8 THEN RAISE EXCEPTION 'Reading transaction write bound exceeded' USING ERRCODE='23514';END IF;
 IF NEW.job_key IS DISTINCT FROM whaleu_community.reading_format_key(NEW.content_kind,NEW.content_id,NEW.source_hash,NEW.publication_request_id) THEN RAISE EXCEPTION 'Reading key mismatch' USING ERRCODE='23514';END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'pending' OR NEW.claims<>0 OR NEW.lease_fence<>0 OR NEW.row_version<>1 OR NEW.schedule_state<>'runnable' OR NEW.probe_count<>0 OR NEW.scheduling_reason IS NOT NULL OR NEW.write_transaction IS DISTINCT FROM pg_current_xact_id() OR NOT EXISTS(SELECT 1 FROM whaleu_community.reading_format_heads h WHERE h.content_kind=NEW.content_kind AND h.content_id=NEW.content_id AND h.created_transaction=pg_current_xact_id()) THEN RAISE EXCEPTION 'Reading fresh job required' USING ERRCODE='23514';END IF;
 ELSE
  IF (NEW.job_key,NEW.content_kind,NEW.content_id,NEW.source_revision,NEW.source_hash,NEW.publication_request_id,NEW.formatter_version,NEW.generation) IS DISTINCT FROM (OLD.job_key,OLD.content_kind,OLD.content_id,OLD.source_revision,OLD.source_hash,OLD.publication_request_id,OLD.formatter_version,OLD.generation) OR NEW.row_version<>OLD.row_version+1 THEN RAISE EXCEPTION 'Reading identity/version is immutable' USING ERRCODE='23514';END IF;
  old_plain:=to_jsonb(OLD)-ARRAY['schedule_state','probe_count','next_probe_at','scheduling_reason','row_version'];new_plain:=to_jsonb(NEW)-ARRAY['schedule_state','probe_count','next_probe_at','scheduling_reason','row_version'];
  IF old_plain=new_plain THEN
   IF OLD.schedule_state='quarantined' OR OLD.next_probe_at>instant OR NOT ((NEW.scheduling_reason='invalid_payload' AND NEW.schedule_state='quarantined' AND NEW.next_probe_at IS NULL AND NEW.probe_count=OLD.probe_count) OR (NEW.scheduling_reason='authority_unavailable' AND NEW.probe_count=OLD.probe_count+1 AND ((NEW.probe_count=3 AND NEW.schedule_state='quarantined' AND NEW.next_probe_at IS NULL) OR (NEW.probe_count<3 AND NEW.schedule_state='deferred' AND NEW.next_probe_at BETWEEN instant+CASE NEW.probe_count WHEN 1 THEN interval '4.9 seconds' ELSE interval '29.9 seconds' END AND instant+CASE NEW.probe_count WHEN 1 THEN interval '5.1 seconds' ELSE interval '30.1 seconds' END)))) THEN RAISE EXCEPTION 'Invalid scheduling-only transition' USING ERRCODE='23514';END IF;
   RETURN NEW; -- No source/lease/result/claim/lifecycle authority is inferred.
  END IF;
  IF NEW.write_transaction IS DISTINCT FROM pg_current_xact_id() THEN RAISE EXCEPTION 'Reading operation transaction mismatch' USING ERRCODE='23514';END IF;
  IF NEW.state='running' THEN
   IF OLD.schedule_state NOT IN ('runnable','deferred') OR OLD.next_probe_at IS NULL OR OLD.next_probe_at>instant OR OLD.next_attempt_at>instant OR NEW.next_attempt_at IS DISTINCT FROM OLD.next_attempt_at OR NEW.scheduling_reason IS NOT NULL OR OLD.state NOT IN ('pending','running') OR (OLD.state='running' AND OLD.lease_until>instant) OR OLD.claims>=3 OR NEW.claims<>OLD.claims+1 OR NEW.lease_fence<>OLD.lease_fence+1 OR NEW.lease_token IS NULL OR NEW.lease_token IS NOT DISTINCT FROM OLD.lease_token OR NEW.lease_until<=instant OR NEW.lease_until>instant+interval '10 seconds' OR NEW.probe_count<>OLD.probe_count OR NEW.schedule_state<>'runnable' OR NEW.next_probe_at IS DISTINCT FROM NEW.lease_until OR NEW.next_attempt_at>instant THEN RAISE EXCEPTION 'Invalid reading claim' USING ERRCODE='23514';END IF;
  ELSIF NEW.state='complete' THEN
   IF NEW.next_attempt_at IS DISTINCT FROM OLD.next_attempt_at OR NEW.probe_count<>OLD.probe_count OR NEW.scheduling_reason<>'completed' OR OLD.state<>'running' OR OLD.lease_until<=instant OR NEW.claims<>OLD.claims OR NEW.lease_fence<>OLD.lease_fence OR NOT EXISTS(SELECT 1 FROM whaleu_community.reading_format_results r WHERE r.job_key=OLD.job_key AND r.lease_token=OLD.lease_token AND r.lease_fence=OLD.lease_fence AND r.created_transaction=pg_current_xact_id()) THEN RAISE EXCEPTION 'Invalid reading completion' USING ERRCODE='23514';END IF;
  ELSIF NEW.state='pending' THEN
   IF OLD.schedule_state<>'runnable' OR OLD.state<>'running' OR OLD.lease_until<=instant OR OLD.claims>=3 OR NEW.claims<>OLD.claims OR NEW.lease_fence<>OLD.lease_fence OR NEW.schedule_state<>'deferred' OR NEW.scheduling_reason<>'computation_retry' OR NEW.probe_count<>OLD.probe_count OR NEW.next_probe_at IS DISTINCT FROM NEW.next_attempt_at OR NEW.next_attempt_at NOT BETWEEN instant+(CASE OLD.claims WHEN 1 THEN interval '4.9 seconds' ELSE interval '29.9 seconds' END) AND instant+(CASE OLD.claims WHEN 1 THEN interval '5.1 seconds' ELSE interval '30.1 seconds' END) OR NOT EXISTS(SELECT 1 FROM whaleu_community.reading_format_slots s WHERE (s.job_key,s.lease_token,s.lease_fence,s.lease_until)=(OLD.job_key,OLD.lease_token,OLD.lease_fence,OLD.lease_until)) THEN RAISE EXCEPTION 'Invalid reading retry' USING ERRCODE='23514';END IF;
  ELSIF NEW.state='exhausted' THEN
   IF NEW.next_attempt_at IS DISTINCT FROM OLD.next_attempt_at OR NEW.probe_count<>OLD.probe_count OR OLD.schedule_state='quarantined' OR (OLD.lease_until<=instant AND (OLD.next_probe_at>instant OR OLD.next_attempt_at>instant)) OR (OLD.lease_until>instant AND NOT EXISTS(SELECT 1 FROM whaleu_community.reading_format_slots s WHERE (s.job_key,s.lease_token,s.lease_fence,s.lease_until)=(OLD.job_key,OLD.lease_token,OLD.lease_fence,OLD.lease_until))) OR OLD.state<>'running' OR OLD.claims<>3 OR NEW.claims<>OLD.claims OR NEW.lease_fence<>OLD.lease_fence OR NEW.scheduling_reason<>'claims_exhausted' THEN RAISE EXCEPTION 'Invalid reading exhaustion' USING ERRCODE='23514';END IF;
  ELSE RAISE EXCEPTION 'Unsupported reading transition' USING ERRCODE='23514';END IF;
 END IF;
 PERFORM whaleu_community.reading_format_source_fence();
 IF NOT whaleu_community.reading_format_source_current(NEW.content_kind,NEW.content_id) THEN RAISE EXCEPTION 'Reading processing authority unavailable' USING ERRCODE='23514';END IF;RETURN NEW;
END$$;
CREATE TRIGGER reading_job_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_community.reading_format_jobs FOR EACH ROW EXECUTE FUNCTION whaleu_community.reading_format_job_guard();
CREATE TRIGGER reading_job_no_truncate BEFORE TRUNCATE ON whaleu_community.reading_format_jobs FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.content_approval_immutable();
CREATE FUNCTION whaleu_community.reading_format_slot_guard() RETURNS trigger LANGUAGE plpgsql AS $$DECLARE instant timestamptz:=clock_timestamp();BEGIN
 IF TG_OP<>'UPDATE' OR NEW.slot_id<>OLD.slot_id OR NEW.row_version<>OLD.row_version+1 THEN RAISE EXCEPTION 'Fixed reading slot mutation invalid' USING ERRCODE='23514';END IF;
 IF OLD.job_key IS NOT NULL AND OLD.lease_until>instant AND NOT EXISTS(SELECT 1 FROM whaleu_community.reading_format_jobs j WHERE j.job_key=OLD.job_key AND j.state IN ('complete','pending','exhausted') AND j.write_transaction=pg_current_xact_id()) THEN RAISE EXCEPTION 'Live reading slot cannot be replaced' USING ERRCODE='23514';END IF;
 IF NEW.job_key IS NOT NULL AND NOT EXISTS(SELECT 1 FROM whaleu_community.reading_format_jobs j WHERE j.job_key=NEW.job_key AND j.state='running' AND j.slot_id=NEW.slot_id AND j.lease_token=NEW.lease_token AND j.lease_fence=NEW.lease_fence AND j.lease_until=NEW.lease_until AND j.lease_until>instant AND j.lease_until<=instant+interval '10 seconds' AND j.write_transaction=pg_current_xact_id()) THEN RAISE EXCEPTION 'Slot requires exact current claim' USING ERRCODE='23514';END IF;RETURN NEW;
END$$;
CREATE TRIGGER reading_slot_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_community.reading_format_slots FOR EACH ROW EXECUTE FUNCTION whaleu_community.reading_format_slot_guard();
CREATE TRIGGER reading_slot_no_truncate BEFORE TRUNCATE ON whaleu_community.reading_format_slots FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.content_approval_immutable();
CREATE FUNCTION whaleu_community.reading_format_result_guard() RETURNS trigger LANGUAGE plpgsql AS $$DECLARE j whaleu_community.reading_format_jobs;body text;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Reading result is immutable' USING ERRCODE='23514';END IF;
 SELECT * INTO j FROM whaleu_community.reading_format_jobs WHERE job_key=NEW.job_key;
 IF j.job_key IS NULL OR j.state<>'running' OR j.lease_token IS DISTINCT FROM NEW.lease_token OR j.lease_fence<>NEW.lease_fence OR j.lease_until<=clock_timestamp() OR NEW.created_transaction IS DISTINCT FROM pg_current_xact_id()
 OR NOT EXISTS(SELECT 1 FROM whaleu_community.reading_format_slots s WHERE s.slot_id=j.slot_id AND (s.job_key,s.lease_token,s.lease_fence,s.lease_until)=(j.job_key,j.lease_token,j.lease_fence,j.lease_until)) THEN RAISE EXCEPTION 'Result requires exact unexpired job and slot' USING ERRCODE='23514';END IF;
 IF NEW.lease_until IS NOT NULL AND NEW.lease_until IS DISTINCT FROM j.lease_until THEN RAISE EXCEPTION 'Result cannot replace accepted DB lease deadline' USING ERRCODE='23514';END IF;
 NEW.lease_until:=j.lease_until; -- Retained server-derived acceptance deadline survives job completion.
 PERFORM whaleu_community.reading_format_source_fence();
 IF NOT whaleu_community.reading_format_source_current(j.content_kind,j.content_id) THEN RAISE EXCEPTION 'Reading result authority unavailable' USING ERRCODE='23514';END IF;
 SELECT envelope->>'text' INTO body FROM whaleu_community.content_approval_bindings WHERE content_kind=j.content_kind AND content_id=j.content_id;
 IF NEW.plan IS DISTINCT FROM whaleu_community.reading_format_plan(body) THEN RAISE EXCEPTION 'Reading plan differs from deterministic source computation' USING ERRCODE='23514';END IF;RETURN NEW;
END$$;
CREATE TRIGGER reading_result_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_community.reading_format_results FOR EACH ROW EXECUTE FUNCTION whaleu_community.reading_format_result_guard();
CREATE TRIGGER reading_result_no_truncate BEFORE TRUNCATE ON whaleu_community.reading_format_results FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.content_approval_immutable();
CREATE FUNCTION whaleu_community.reading_format_graph_assert() RETURNS trigger LANGUAGE plpgsql AS $$DECLARE j whaleu_community.reading_format_jobs;key text;BEGIN
 IF TG_TABLE_NAME='reading_format_heads' THEN
  key:=whaleu_community.reading_format_key(NEW.content_kind,NEW.content_id,NEW.source_hash,NEW.publication_request_id);
 ELSIF TG_TABLE_NAME IN ('reading_format_jobs','reading_format_results','reading_format_slots') THEN
  key:=NEW.job_key;
 ELSE RAISE EXCEPTION 'Unexpected reading graph relation' USING ERRCODE='23514';END IF;
 IF key IS NULL THEN RETURN NULL;END IF;
 SELECT * INTO j FROM whaleu_community.reading_format_jobs WHERE job_key=key;
 IF j.job_key IS NULL OR (j.state='complete') IS DISTINCT FROM EXISTS(SELECT 1 FROM whaleu_community.reading_format_results WHERE job_key=key)
 OR (j.state='running' AND j.lease_until>clock_timestamp() AND NOT EXISTS(SELECT 1 FROM whaleu_community.reading_format_slots s WHERE s.slot_id=j.slot_id AND (s.job_key,s.lease_token,s.lease_fence,s.lease_until)=(j.job_key,j.lease_token,j.lease_fence,j.lease_until)))
 OR (j.state<>'running' AND EXISTS(SELECT 1 FROM whaleu_community.reading_format_slots s WHERE s.job_key=j.job_key)) THEN RAISE EXCEPTION 'Reading graph incomplete' USING ERRCODE='23514';END IF;
 -- This closes normal deferred completion, not raw SET CONSTRAINTS then idle COMMIT.
 -- Scheduling-only transactions retain old write_transaction and need no source authority.
 IF j.write_transaction=pg_current_xact_id() THEN
  PERFORM whaleu_community.reading_format_source_fence();
  IF NOT whaleu_community.reading_format_source_current(j.content_kind,j.content_id)
   OR (j.state='running' AND j.lease_until<=clock_timestamp())
   OR EXISTS(SELECT 1 FROM whaleu_community.reading_format_results r WHERE r.job_key=j.job_key AND r.created_transaction=pg_current_xact_id() AND r.lease_until<=clock_timestamp())
  THEN RAISE EXCEPTION 'Reading authority expired before deferred closure' USING ERRCODE='23514';END IF;
 END IF;
 RETURN NULL;
END$$;
DO $$DECLARE relation text;BEGIN FOREACH relation IN ARRAY ARRAY['reading_format_heads','reading_format_jobs','reading_format_results','reading_format_slots'] LOOP
 EXECUTE format('CREATE CONSTRAINT TRIGGER reading_graph AFTER INSERT OR UPDATE ON whaleu_community.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community.reading_format_graph_assert()',relation);
END LOOP;END$$;
-- Late writes cannot drain a deferred check and then invalidate a result/source.
-- No stored capability or session setting can manufacture current authority.
CREATE FUNCTION whaleu_community.reading_format_late_guard() RETURNS trigger LANGUAGE plpgsql AS $$DECLARE j record;seen integer:=0;BEGIN
 FOR j IN SELECT content_kind,content_id FROM whaleu_community.reading_format_jobs WHERE write_transaction=pg_current_xact_id() LIMIT 9 LOOP
  seen:=seen+1;IF seen>8 THEN RAISE EXCEPTION 'Reading transaction write bound exceeded' USING ERRCODE='23514';END IF;
  IF NOT whaleu_community.reading_format_source_current(j.content_kind,j.content_id) THEN RAISE EXCEPTION 'Late write invalidated reading authority' USING ERRCODE='23514';END IF;
 END LOOP;RETURN NULL;
END$$;
DO $$DECLARE relation text;BEGIN FOREACH relation IN ARRAY ARRAY[
 'whaleu_identity.accounts','whaleu_campus.operating_regions','whaleu_community.posts','whaleu_community.root_comments','whaleu_community.replies','whaleu_community.spaces',
 'whaleu_community.community_text_sources','whaleu_community.content_approval_bindings','whaleu_community.content_approval_decisions','whaleu_community.content_approval_events','whaleu_community.content_approval_heads','whaleu_community.content_approval_policies',
 'whaleu_community.post_owner_visibility','whaleu_community.post_category_heads','whaleu_community.post_images','whaleu_community.comment_images','whaleu_community.reply_images','whaleu_community.polls','whaleu_community.poll_options','whaleu_community.formations','whaleu_community.formation_members','whaleu_community.post_distribution_bindings','whaleu_community.trading_listings','whaleu_community.post_rating_target_links',
 'whaleu_media.bindings','whaleu_media.assets','whaleu_media.upload_intents','whaleu_media.asset_safety_heads','whaleu_media.asset_safety_events',
 'whaleu_safety.account_punishment_heads','whaleu_safety.account_punishments','whaleu_safety.account_punishment_terminals'
 ] LOOP EXECUTE format('CREATE TRIGGER reading_late_guard AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON %s FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.reading_format_late_guard()',relation);END LOOP;END$$;
