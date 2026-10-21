-- Unreleased disposable-only successor. This does NOT enable public deletion.
-- Retained UUIDs, epochs, timestamps and fingerprints are linkable evidence, not
-- anonymous data. No payload snapshot, provider credential or media key is kept.
CREATE FUNCTION whaleu_account_deletion.follow_bucket(target uuid) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT encode(sha256(convert_to('whaleu:discovery:bucket:v1','UTF8')||decode('00','hex')||convert_to('["account","'||lower(target::text)||'"]','UTF8')),'hex')
$$;
CREATE FUNCTION whaleu_account_deletion.follow_source_fingerprint(source uuid) RETURNS text LANGUAGE sql STABLE AS $$
 SELECT whaleu_account_deletion.json_hash(to_jsonb(s)) FROM whaleu_community.social_sources s WHERE s.id=source
$$;
CREATE TABLE whaleu_account_deletion.follow_scopes (
 request_id uuid PRIMARY KEY REFERENCES whaleu_account_deletion.requests(id),
 generation bigint NOT NULL, policy text NOT NULL CHECK(policy='synthetic-follow-social-v1'),
 inventory text NOT NULL CHECK(inventory='account-deletion-local-0173-v1'),
 public_profile_id uuid, phase integer NOT NULL DEFAULT 0 CHECK(phase BETWEEN 0 AND 11),
 boundary text NOT NULL DEFAULT '' CHECK(length(boundary)<=80), page_number bigint NOT NULL DEFAULT 0 CHECK(page_number>=0),
 mutation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id()
);
CREATE TABLE whaleu_account_deletion.follow_pages (
 request_id uuid NOT NULL REFERENCES whaleu_account_deletion.follow_scopes(request_id), page_number bigint NOT NULL CHECK(page_number>0),
 generation bigint NOT NULL, phase integer NOT NULL CHECK(phase BETWEEN 0 AND 10),
 before_boundary text NOT NULL CHECK(length(before_boundary)<=80), after_boundary text NOT NULL CHECK(length(after_boundary)<=80),
 item_count integer NOT NULL CHECK(item_count BETWEEN 0 AND 100), exhausted boolean NOT NULL,
 mutation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(), PRIMARY KEY(request_id,page_number)
);
CREATE TABLE whaleu_account_deletion.follow_mutations (
 request_id uuid NOT NULL, page_number bigint NOT NULL, relation text NOT NULL CHECK(relation IN('user_follows','follow_requests','incoming_intent','social_receipts','social_notices','social_work','social_sources','outgoing_retirement','follow_heads','discovery_cursors','owners')),
 row_key text NOT NULL CHECK(length(row_key) BETWEEN 1 AND 80), fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
 source_id uuid, mutation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 PRIMARY KEY(request_id,page_number,relation,row_key), FOREIGN KEY(request_id,page_number) REFERENCES whaleu_account_deletion.follow_pages(request_id,page_number)
);
CREATE TABLE whaleu_account_deletion.follow_source_intents (
 source_id uuid PRIMARY KEY, source_fingerprint text NOT NULL CHECK(source_fingerprint ~ '^[a-f0-9]{64}$'),
 request_id uuid NOT NULL REFERENCES whaleu_account_deletion.follow_scopes(request_id), generation bigint NOT NULL,
 mutation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id()
);
CREATE TABLE whaleu_account_deletion.follow_source_retirements (
 source_id uuid PRIMARY KEY, source_fingerprint text NOT NULL CHECK(source_fingerprint ~ '^[a-f0-9]{64}$'),
 request_id uuid NOT NULL REFERENCES whaleu_account_deletion.follow_scopes(request_id), generation bigint NOT NULL,
 mutation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id()
);
CREATE TABLE whaleu_account_deletion.follow_source_erasures (
 source_id uuid PRIMARY KEY, source_fingerprint text NOT NULL CHECK(source_fingerprint ~ '^[a-f0-9]{64}$'),
 request_id uuid NOT NULL REFERENCES whaleu_account_deletion.follow_scopes(request_id), generation bigint NOT NULL,
 mutation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id()
);
DO $$DECLARE name text;BEGIN
 FOREACH name IN ARRAY ARRAY['follow_pages','follow_mutations','follow_source_intents','follow_source_retirements','follow_source_erasures'] LOOP
  EXECUTE format('CREATE TRIGGER follow_evidence_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON whaleu_account_deletion.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_account_deletion.immutable()',name);
 END LOOP;
END$$;
CREATE TRIGGER follow_scope_no_truncate BEFORE TRUNCATE ON whaleu_account_deletion.follow_scopes FOR EACH STATEMENT EXECUTE FUNCTION whaleu_account_deletion.immutable();
CREATE FUNCTION whaleu_account_deletion.follow_cause(request uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM whaleu_account_deletion.requests r
 JOIN whaleu_identity.accounts a ON a.id=r.account_id
 JOIN whaleu_account_deletion.owner_causes c ON c.request_id=r.id AND c.generation=r.generation AND c.owner='follow-social' AND c.mutation_transaction=pg_current_xact_id()
 JOIN whaleu_account_deletion.fixture_accounts f ON f.account_id=r.account_id JOIN whaleu_account_deletion.sandboxes b ON b.id=f.sandbox_id
 WHERE r.id=request AND r.phase IN('erasing','waiting') AND a.lifecycle='erasing' AND a.deletion_request_id=r.id AND a.lifecycle_generation=r.generation
 AND r.inventory='account-deletion-local-0173-v1' AND b.inventory=r.inventory AND r.policy='synthetic-deletion-policy-v1' AND b.policy=r.policy
 AND current_database()='whaleu_test')
$$;
CREATE FUNCTION whaleu_account_deletion.follow_source_retired(source uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM whaleu_account_deletion.follow_source_retirements e JOIN whaleu_account_deletion.requests r ON r.id=e.request_id
 JOIN whaleu_account_deletion.follow_scopes c ON c.request_id=r.id JOIN whaleu_community.social_sources s ON s.id=e.source_id
 WHERE e.source_id=source AND e.generation=r.generation AND c.generation=r.generation AND r.account_id=s.actor_account_id
 AND e.source_fingerprint=whaleu_account_deletion.follow_source_fingerprint(s.id) AND r.phase IN('erasing','waiting','completed'))
$$;
CREATE FUNCTION whaleu_account_deletion.follow_source_erasing(source uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM whaleu_account_deletion.follow_source_intents e JOIN whaleu_account_deletion.requests r ON r.id=e.request_id
 JOIN whaleu_community.social_sources s ON s.id=e.source_id
 WHERE e.source_id=source AND e.generation=r.generation AND r.account_id=s.recipient_account_id
 AND e.source_fingerprint=whaleu_account_deletion.follow_source_fingerprint(s.id) AND r.phase IN('erasing','waiting'))
$$;
-- Resolve all source-ID-only writers before source/notification locks. A late
-- lock is ALWAYS NOWAIT. Ordinary active rows retain 0169's exact invariants.
CREATE FUNCTION whaleu_account_deletion.follow_lock_accounts(ids uuid[]) RETURNS void LANGUAGE plpgsql AS $$
DECLARE target uuid;BEGIN
 FOR target IN SELECT DISTINCT unnest(ids) ORDER BY 1 LOOP
  PERFORM id FROM whaleu_identity.accounts WHERE id=target FOR SHARE NOWAIT;
  IF NOT FOUND THEN RAISE EXCEPTION 'Missing follow endpoint' USING ERRCODE='23514';END IF;
 END LOOP;
END$$;
CREATE FUNCTION whaleu_account_deletion.follow_try_gate(key text) RETURNS void LANGUAGE plpgsql AS $$BEGIN
 IF NOT pg_try_advisory_xact_lock(hashtextextended(key,0)) THEN RAISE EXCEPTION 'Follow-social page lock busy' USING ERRCODE='55P03';END IF;
END$$;
CREATE FUNCTION whaleu_account_deletion.follow_row_key(relation text,payload jsonb) RETURNS text LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE relation WHEN 'user_follows' THEN (payload->>'follower_id')||':'||(payload->>'followed_id') WHEN 'follow_requests' THEN payload->>'request_id'
 WHEN 'follow_heads' THEN payload->>'account_id' WHEN 'owners' THEN payload->>'account_id' WHEN 'discovery_cursors' THEN payload->>'cursor'
 WHEN 'social_sources' THEN payload->>'id' WHEN 'incoming_intent' THEN payload->>'id' WHEN 'outgoing_retirement' THEN payload->>'id'
 WHEN 'social_notices' THEN payload->>'id' ELSE payload->>'source_id' END
$$;
CREATE FUNCTION whaleu_account_deletion.follow_granted(relation text,payload jsonb) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM whaleu_account_deletion.follow_mutations m JOIN whaleu_account_deletion.follow_pages p USING(request_id,page_number)
 WHERE m.relation=$1 AND m.row_key=whaleu_account_deletion.follow_row_key($1,$2) AND m.fingerprint=whaleu_account_deletion.json_hash($2)
 AND m.mutation_transaction=pg_current_xact_id() AND p.mutation_transaction=pg_current_xact_id() AND whaleu_account_deletion.follow_cause(m.request_id))
$$;
CREATE FUNCTION whaleu_account_deletion.follow_scope_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r whaleu_account_deletion.requests;p whaleu_account_deletion.follow_pages;BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Follow scope is immutable evidence' USING ERRCODE='23514';END IF;
 SELECT * INTO r FROM whaleu_account_deletion.requests WHERE id=NEW.request_id;
 IF NOT whaleu_account_deletion.follow_cause(NEW.request_id) OR NEW.generation IS DISTINCT FROM r.generation OR NEW.mutation_transaction<>pg_current_xact_id() THEN RAISE EXCEPTION 'Exact follow scope cause required' USING ERRCODE='23514';END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.phase<>0 OR NEW.boundary<>'' OR NEW.page_number<>0 OR NEW.public_profile_id IS DISTINCT FROM (SELECT public_id FROM whaleu_profile.profiles WHERE account_id=r.account_id) THEN RAISE EXCEPTION 'Invalid initial follow scope' USING ERRCODE='23514';END IF;
 ELSE
  SELECT * INTO p FROM whaleu_account_deletion.follow_pages WHERE request_id=OLD.request_id AND page_number=OLD.page_number+1 AND mutation_transaction=pg_current_xact_id();
  IF p.request_id IS NULL OR NEW.page_number<>p.page_number OR p.phase<>OLD.phase OR p.before_boundary<>OLD.boundary
   OR NEW.phase<>(CASE WHEN p.exhausted THEN OLD.phase+1 ELSE OLD.phase END) OR NEW.boundary<>(CASE WHEN p.exhausted THEN '' ELSE p.after_boundary END)
   OR (to_jsonb(NEW)-ARRAY['phase','boundary','page_number','mutation_transaction']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['phase','boundary','page_number','mutation_transaction']) THEN RAISE EXCEPTION 'Follow scope advances only with its exact bounded page' USING ERRCODE='23514';END IF;
 END IF;RETURN NEW;
END$$;
CREATE TRIGGER follow_scope_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_account_deletion.follow_scopes FOR EACH ROW EXECUTE FUNCTION whaleu_account_deletion.follow_scope_guard();
CREATE FUNCTION whaleu_account_deletion.follow_page_guard() RETURNS trigger LANGUAGE plpgsql AS $$DECLARE c whaleu_account_deletion.follow_scopes;BEGIN
 SELECT * INTO c FROM whaleu_account_deletion.follow_scopes WHERE request_id=NEW.request_id;
 IF NOT whaleu_account_deletion.follow_cause(NEW.request_id) OR NOT whaleu_account_deletion.inventory_current(NEW.request_id) OR NEW.generation<>c.generation OR NEW.mutation_transaction<>pg_current_xact_id()
 OR NEW.page_number<>c.page_number+1 OR NEW.phase<>c.phase OR NEW.before_boundary<>c.boundary
 OR (NEW.item_count>0 AND NEW.after_boundary<=NEW.before_boundary) OR (NEW.item_count=0 AND (NOT NEW.exhausted OR NEW.after_boundary<>NEW.before_boundary)) THEN RAISE EXCEPTION 'Invalid bounded follow page' USING ERRCODE='23514';END IF;RETURN NEW;
END$$;
CREATE TRIGGER follow_page_guard BEFORE INSERT ON whaleu_account_deletion.follow_pages FOR EACH ROW EXECUTE FUNCTION whaleu_account_deletion.follow_page_guard();
-- One canonical row query is shared by planning, grant admission and commit
-- verification. LIMIT 101 is applied by callers; no lifetime-group size guess.
CREATE FUNCTION whaleu_account_deletion.follow_candidates(request uuid,step integer) RETURNS TABLE(row_key text,payload jsonb,source_id uuid) LANGUAGE plpgsql STABLE AS $$
DECLARE target uuid;BEGIN SELECT account_id INTO target FROM whaleu_account_deletion.requests WHERE id=request;
 CASE step
 WHEN 0 THEN RETURN QUERY SELECT e.follower_id::text||':'||e.followed_id::text,to_jsonb(e),NULL::uuid FROM whaleu_community.user_follows e WHERE e.follower_id=target OR e.followed_id=target;
 WHEN 1 THEN RETURN QUERY SELECT r.request_id::text,to_jsonb(r),NULL::uuid FROM whaleu_community.follow_requests r WHERE r.account_id=target;
 WHEN 2 THEN RETURN QUERY SELECT s.id::text,to_jsonb(s),s.id FROM whaleu_community.social_sources s WHERE s.recipient_account_id=target AND NOT EXISTS(SELECT 1 FROM whaleu_account_deletion.follow_source_intents i WHERE i.source_id=s.id);
 WHEN 3 THEN RETURN QUERY SELECT r.source_id::text,to_jsonb(r),r.source_id FROM whaleu_notifications.social_receipts r WHERE r.recipient_account_id=target;
 WHEN 4 THEN RETURN QUERY SELECT n.id::text,to_jsonb(n),n.source_id FROM whaleu_notifications.social_notices n WHERE n.recipient_account_id=target;
 WHEN 5 THEN RETURN QUERY SELECT w.source_id::text,to_jsonb(w),w.source_id FROM whaleu_notifications.social_work w WHERE w.recipient_account_id=target;
 WHEN 6 THEN RETURN QUERY SELECT s.id::text,to_jsonb(s),s.id FROM whaleu_community.social_sources s WHERE s.recipient_account_id=target;
 WHEN 7 THEN RETURN QUERY SELECT s.id::text,to_jsonb(s),s.id FROM whaleu_community.social_sources s WHERE s.actor_account_id=target AND NOT EXISTS(SELECT 1 FROM whaleu_account_deletion.follow_source_retirements e WHERE e.source_id=s.id);
 WHEN 8 THEN RETURN QUERY SELECT h.account_id::text,to_jsonb(h),NULL::uuid FROM whaleu_community.follow_heads h WHERE h.account_id=target;
 WHEN 9 THEN RETURN QUERY SELECT c.cursor,to_jsonb(c),NULL::uuid FROM whaleu_community.discovery_cursors c WHERE c.bucket_hash=whaleu_account_deletion.follow_bucket(target);
 WHEN 10 THEN RETURN QUERY SELECT o.account_id::text,to_jsonb(o),NULL::uuid FROM whaleu_notifications.owners o WHERE o.account_id=target;
 ELSE RAISE EXCEPTION 'Invalid follow phase' USING ERRCODE='23514';END CASE;
END$$;
CREATE FUNCTION whaleu_account_deletion.follow_phase_relation(step integer) RETURNS text LANGUAGE sql IMMUTABLE AS $$
 SELECT (ARRAY['user_follows','follow_requests','incoming_intent','social_receipts','social_notices','social_work','social_sources','outgoing_retirement','follow_heads','discovery_cursors','owners'])[step+1]
$$;
CREATE FUNCTION whaleu_account_deletion.follow_mutation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p whaleu_account_deletion.follow_pages;r whaleu_account_deletion.requests;c record;s whaleu_community.social_sources;BEGIN
 SELECT * INTO p FROM whaleu_account_deletion.follow_pages WHERE request_id=NEW.request_id AND page_number=NEW.page_number;
 SELECT * INTO r FROM whaleu_account_deletion.requests WHERE id=NEW.request_id;
 SELECT * INTO c FROM whaleu_account_deletion.follow_candidates(NEW.request_id,p.phase) q WHERE q.row_key=NEW.row_key;
 IF NOT whaleu_account_deletion.follow_cause(NEW.request_id) OR NEW.mutation_transaction<>pg_current_xact_id() OR p.mutation_transaction<>pg_current_xact_id()
 OR NEW.relation IS DISTINCT FROM whaleu_account_deletion.follow_phase_relation(p.phase) OR c.row_key IS NULL OR NEW.row_key<=p.before_boundary OR NEW.row_key>p.after_boundary
 OR NEW.fingerprint IS DISTINCT FROM whaleu_account_deletion.json_hash(c.payload) OR NEW.source_id IS DISTINCT FROM c.source_id
 OR (SELECT count(*) FROM whaleu_account_deletion.follow_mutations WHERE request_id=NEW.request_id AND page_number=NEW.page_number)>=p.item_count THEN RAISE EXCEPTION 'Exact bounded follow mutation required' USING ERRCODE='23514';END IF;
 IF NEW.source_id IS NOT NULL THEN
  SELECT * INTO s FROM whaleu_community.social_sources WHERE id=NEW.source_id;
  IF s.kind<>'follow' OR s.resource_kind<>'profile' OR s.reward_group_id IS NOT NULL OR s.post_id IS NOT NULL OR s.root_comment_id IS NOT NULL OR s.reply_id IS NOT NULL OR s.target_reply_id IS NOT NULL THEN RAISE EXCEPTION 'Unsupported social owner' USING ERRCODE='23514';END IF;
  PERFORM whaleu_account_deletion.follow_lock_accounts(ARRAY[s.actor_account_id,s.recipient_account_id]);
  PERFORM whaleu_account_deletion.follow_try_gate('social-in-app:'||s.id::text);
 END IF;
 IF NEW.relation='user_follows' THEN
  PERFORM whaleu_account_deletion.follow_lock_accounts(ARRAY[(c.payload->>'follower_id')::uuid,(c.payload->>'followed_id')::uuid]);
  PERFORM whaleu_account_deletion.follow_try_gate('whaleu:following:'||(c.payload->>'follower_id'));
 END IF;
 RETURN NEW;
END$$;
CREATE TRIGGER follow_mutation_guard BEFORE INSERT ON whaleu_account_deletion.follow_mutations FOR EACH ROW EXECUTE FUNCTION whaleu_account_deletion.follow_mutation_guard();
CREATE FUNCTION whaleu_account_deletion.follow_evidence_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s whaleu_community.social_sources;r whaleu_account_deletion.requests;i whaleu_account_deletion.follow_source_intents;evidence_relation text;BEGIN
 SELECT * INTO r FROM whaleu_account_deletion.requests WHERE id=NEW.request_id;
 IF NOT whaleu_account_deletion.follow_cause(NEW.request_id) OR NEW.generation<>r.generation OR NEW.mutation_transaction<>pg_current_xact_id() THEN RAISE EXCEPTION 'Exact follow evidence cause required' USING ERRCODE='23514';END IF;
 IF TG_TABLE_NAME='follow_source_erasures' THEN
  SELECT * INTO i FROM whaleu_account_deletion.follow_source_intents WHERE source_id=NEW.source_id;
  IF i.request_id IS DISTINCT FROM NEW.request_id OR i.generation IS DISTINCT FROM NEW.generation OR i.source_fingerprint IS DISTINCT FROM NEW.source_fingerprint
   OR EXISTS(SELECT 1 FROM whaleu_community.social_sources WHERE id=NEW.source_id) OR EXISTS(SELECT 1 FROM whaleu_notifications.social_work WHERE source_id=NEW.source_id)
   OR EXISTS(SELECT 1 FROM whaleu_notifications.social_receipts WHERE source_id=NEW.source_id) OR EXISTS(SELECT 1 FROM whaleu_notifications.social_notices WHERE source_id=NEW.source_id)
   OR NOT EXISTS(SELECT 1 FROM whaleu_account_deletion.follow_mutations WHERE request_id=NEW.request_id AND relation='social_sources' AND row_key=NEW.source_id::text AND fingerprint=NEW.source_fingerprint AND mutation_transaction=pg_current_xact_id()) THEN RAISE EXCEPTION 'Source erasure requires exact causal absence' USING ERRCODE='23514';END IF;
 ELSE
  SELECT * INTO s FROM whaleu_community.social_sources WHERE id=NEW.source_id;
  evidence_relation:=CASE TG_TABLE_NAME WHEN 'follow_source_intents' THEN 'incoming_intent' ELSE 'outgoing_retirement' END;
  IF s.id IS NULL OR NEW.source_fingerprint IS DISTINCT FROM whaleu_account_deletion.follow_source_fingerprint(s.id)
   OR (evidence_relation='incoming_intent' AND s.recipient_account_id<>r.account_id) OR (evidence_relation='outgoing_retirement' AND s.actor_account_id<>r.account_id)
   OR NOT whaleu_account_deletion.follow_granted(evidence_relation,to_jsonb(s)) THEN RAISE EXCEPTION 'Exact source direction and bounded grant required' USING ERRCODE='23514';END IF;
 END IF;RETURN NEW;
END$$;
DO $$DECLARE name text;BEGIN FOREACH name IN ARRAY ARRAY['follow_source_intents','follow_source_retirements','follow_source_erasures'] LOOP
 EXECUTE format('CREATE TRIGGER follow_evidence_guard BEFORE INSERT ON whaleu_account_deletion.%I FOR EACH ROW EXECUTE FUNCTION whaleu_account_deletion.follow_evidence_guard()',name);
END LOOP;END$$;
-- Replace only the named table-specific immutable triggers, never the shared
-- immutable_row function. Every DELETE is exact row/fingerprint/page/TX bound.
CREATE FUNCTION whaleu_account_deletion.follow_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF TG_OP<>'DELETE' OR NOT whaleu_account_deletion.follow_granted(TG_TABLE_NAME,to_jsonb(OLD)) THEN RAISE EXCEPTION 'Follow history is immutable outside exact erasure page' USING ERRCODE='23514';END IF;RETURN OLD;
END$$;
DROP TRIGGER social_source_immutable ON whaleu_community.social_sources;
CREATE TRIGGER social_source_immutable BEFORE UPDATE OR DELETE ON whaleu_community.social_sources FOR EACH ROW EXECUTE FUNCTION whaleu_account_deletion.follow_delete_guard();
DROP TRIGGER social_follow_receipt_immutable ON whaleu_community.follow_requests;
CREATE TRIGGER social_follow_receipt_immutable BEFORE UPDATE OR DELETE ON whaleu_community.follow_requests FOR EACH ROW EXECUTE FUNCTION whaleu_account_deletion.follow_delete_guard();
DROP TRIGGER social_receipt_immutable ON whaleu_notifications.social_receipts;
CREATE TRIGGER social_receipt_immutable BEFORE UPDATE OR DELETE ON whaleu_notifications.social_receipts FOR EACH ROW EXECUTE FUNCTION whaleu_account_deletion.follow_delete_guard();
CREATE OR REPLACE FUNCTION whaleu_notifications.social_notice_guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF TG_OP='DELETE' THEN
  IF NOT whaleu_account_deletion.follow_granted('social_notices',to_jsonb(OLD)) THEN RAISE EXCEPTION 'Exact incoming notice erasure required' USING ERRCODE='23514';END IF;RETURN OLD;
 END IF;
 IF (to_jsonb(OLD)-'read_at') IS DISTINCT FROM (to_jsonb(NEW)-'read_at') OR (OLD.read_at IS NOT NULL AND OLD.read_at IS DISTINCT FROM NEW.read_at) OR NEW.read_at IS NULL THEN RAISE EXCEPTION 'Social notices preserve immutable evidence and first read time' USING ERRCODE='23514';END IF;RETURN NEW;
END$$;
CREATE OR REPLACE FUNCTION whaleu_notifications.social_work_guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF TG_OP='DELETE' THEN
  IF NOT whaleu_account_deletion.follow_granted('social_work',to_jsonb(OLD)) THEN RAISE EXCEPTION 'Exact incoming work erasure required' USING ERRCODE='23514';END IF;RETURN OLD;
 END IF;
 IF (to_jsonb(OLD)-ARRAY['state','attempts','next_attempt_at']) IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['state','attempts','next_attempt_at']) OR (OLD.state='completed' AND NEW IS DISTINCT FROM OLD) OR NEW.attempts<OLD.attempts THEN RAISE EXCEPTION 'Social work identity and completed state are immutable' USING ERRCODE='23514';END IF;RETURN NEW;
END$$;
ALTER TABLE whaleu_notifications.social_receipts DROP CONSTRAINT social_receipts_outcome_check;
ALTER TABLE whaleu_notifications.social_receipts ALTER COLUMN notice_id DROP NOT NULL;
ALTER TABLE whaleu_notifications.social_receipts ADD CONSTRAINT social_receipts_outcome_check CHECK((outcome IN('materialized','existing') AND notice_id IS NOT NULL) OR (outcome='account_deleted' AND notice_id IS NULL AND kind='follow'));
-- Exact current request cause for the only newly permitted completion branch.
CREATE FUNCTION whaleu_account_deletion.follow_terminal_cause(source uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM whaleu_community.social_sources s JOIN whaleu_account_deletion.follow_source_retirements e ON e.source_id=s.id
 WHERE s.id=source AND whaleu_account_deletion.follow_source_retired(s.id) AND whaleu_account_deletion.follow_cause(e.request_id)
 AND e.mutation_transaction=pg_current_xact_id() AND whaleu_account_deletion.follow_granted('outgoing_retirement',to_jsonb(s)))
$$;
CREATE OR REPLACE FUNCTION whaleu_notifications.social_completeness() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sid uuid;w whaleu_notifications.social_work;r whaleu_notifications.social_receipts;n whaleu_notifications.social_notices;s whaleu_community.social_sources;expected_key text;BEGIN
 sid:=coalesce((to_jsonb(NEW)->>'source_id')::uuid,(to_jsonb(NEW)->>'id')::uuid);
 SELECT * INTO s FROM whaleu_community.social_sources WHERE id=sid;
 SELECT * INTO w FROM whaleu_notifications.social_work WHERE source_id=sid;
 SELECT * INTO r FROM whaleu_notifications.social_receipts WHERE source_id=sid;
 -- Only an admitted recipient erasure may durably stage an incomplete graph.
 IF whaleu_account_deletion.follow_source_erasing(sid) THEN RETURN NULL;END IF;
 IF w.source_id IS NULL OR s.id IS NULL OR ((w.state='completed')<>(r.source_id IS NOT NULL)) THEN RAISE EXCEPTION 'Social source requires complete independent work and receipt' USING ERRCODE='23514';END IF;
 IF r.outcome='account_deleted' THEN
  IF TG_TABLE_NAME='social_notices' OR r.notice_id IS NOT NULL OR s.kind<>'follow' OR NOT whaleu_account_deletion.follow_source_retired(sid) THEN RAISE EXCEPTION 'Exact retired source terminal receipt required' USING ERRCODE='23514';END IF;
  RETURN NULL;
 END IF;
 IF TG_TABLE_NAME='social_notices' AND (r.notice_id IS DISTINCT FROM (to_jsonb(NEW)->>'id')::uuid OR r.outcome IS DISTINCT FROM 'materialized') THEN RAISE EXCEPTION 'Social notice requires exact materialized receipt' USING ERRCODE='23514';END IF;
 IF r.source_id IS NOT NULL THEN
  SELECT * INTO n FROM whaleu_notifications.social_notices WHERE id=r.notice_id;
  expected_key:=encode(sha256(convert_to(concat_ws(':','social-lifetime-v1',s.recipient_account_id::text,s.actor_account_id::text,s.kind,s.resource_kind,s.resource_id::text),'UTF8')),'hex');
  IF n.dedupe_key IS DISTINCT FROM expected_key OR (r.outcome='materialized' AND (n.source_id IS DISTINCT FROM sid OR n.created_at IS DISTINCT FROM s.occurred_at)) THEN RAISE EXCEPTION 'Social notice receipt source mismatch' USING ERRCODE='23514';END IF;
 END IF;RETURN NULL;
END$$;
-- Specific relation/direction-aware lifecycle guard replaces the generic UUID
-- scan ONLY on these tables. Later recipient erasure needs no cause for an
-- already-completed sender; it needs its own exact source-fingerprint grant.
CREATE FUNCTION whaleu_account_deletion.follow_writer_fence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE payload jsonb;s whaleu_community.social_sources;ids uuid[];target uuid;active boolean;terminal boolean;BEGIN
 payload:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
 IF TG_OP='UPDATE' AND TG_TABLE_NAME IN('follow_heads','owners') AND (to_jsonb(OLD)->>'account_id') IS DISTINCT FROM (payload->>'account_id') THEN RAISE EXCEPTION 'Follow and notification ownership is immutable' USING ERRCODE='23514';END IF;
 IF TG_TABLE_NAME='social_sources' AND TG_OP='INSERT' AND (
  EXISTS(SELECT 1 FROM whaleu_account_deletion.follow_source_intents WHERE source_id=(payload->>'id')::uuid)
  OR EXISTS(SELECT 1 FROM whaleu_account_deletion.follow_source_retirements WHERE source_id=(payload->>'id')::uuid)
  OR EXISTS(SELECT 1 FROM whaleu_account_deletion.follow_source_erasures WHERE source_id=(payload->>'id')::uuid)) THEN RAISE EXCEPTION 'Retired or erased social source identity is permanently reserved' USING ERRCODE='23514';END IF;
 IF TG_TABLE_NAME IN('social_sources','social_work','social_notices','social_receipts') THEN
  IF TG_TABLE_NAME='social_sources' THEN s:=jsonb_populate_record(NULL::whaleu_community.social_sources,payload);
  ELSE SELECT * INTO s FROM whaleu_community.social_sources WHERE id=(payload->>'source_id')::uuid;END IF;
  IF s.id IS NULL THEN RAISE EXCEPTION 'Social writer requires current exact source' USING ERRCODE='23514';END IF;
  PERFORM whaleu_account_deletion.follow_lock_accounts(ARRAY[s.actor_account_id,s.recipient_account_id]);
  PERFORM whaleu_account_deletion.follow_try_gate('social-in-app:'||s.id::text);
  IF TG_OP='DELETE' AND whaleu_account_deletion.follow_granted(TG_TABLE_NAME,payload) THEN RETURN OLD;END IF;
  IF whaleu_account_deletion.follow_source_erasing(s.id) THEN RAISE EXCEPTION 'Incoming social graph is causally erasing' USING ERRCODE='23514';END IF;
  terminal:=whaleu_account_deletion.follow_terminal_cause(s.id);
  IF terminal AND TG_TABLE_NAME='social_receipts' AND TG_OP='INSERT' AND payload->>'outcome'='account_deleted' AND payload->>'notice_id' IS NULL THEN RETURN NEW;END IF;
  IF terminal AND TG_TABLE_NAME='social_work' AND TG_OP='UPDATE' AND to_jsonb(OLD)->>'state'='pending' AND payload->>'state'='completed' AND (to_jsonb(OLD)-'state')=(to_jsonb(NEW)-'state') THEN RETURN NEW;END IF;
  -- First read is the recipient's independent authority, never sender revival.
  IF TG_TABLE_NAME='social_notices' AND TG_OP='UPDATE' AND whaleu_account_deletion.follow_source_retired(s.id)
   AND EXISTS(SELECT 1 FROM whaleu_identity.accounts WHERE id=s.recipient_account_id AND lifecycle='active') THEN RETURN NEW;END IF;
  IF whaleu_account_deletion.follow_source_retired(s.id) THEN RAISE EXCEPTION 'Retired social source cannot materialize or retry' USING ERRCODE='23514';END IF;
  ids:=ARRAY[s.actor_account_id,s.recipient_account_id];
 ELSIF TG_TABLE_NAME='user_follows' THEN ids:=ARRAY[(payload->>'follower_id')::uuid,(payload->>'followed_id')::uuid];
 ELSE ids:=ARRAY[(payload->>'account_id')::uuid];END IF;
 PERFORM whaleu_account_deletion.follow_lock_accounts(ids);
 IF TG_TABLE_NAME='follow_heads' AND TG_OP='UPDATE' AND (to_jsonb(OLD)-'revision')=(payload-'revision') AND (payload->>'revision')::bigint=(to_jsonb(OLD)->>'revision')::bigint+1
  AND EXISTS(SELECT 1 FROM whaleu_account_deletion.follow_head_advances a WHERE a.account_id=(payload->>'account_id')::uuid AND a.before_revision=(to_jsonb(OLD)->>'revision')::bigint AND a.mutation_transaction=pg_current_xact_id() AND whaleu_account_deletion.follow_cause(a.request_id)) THEN RETURN NEW;END IF;
 IF TG_OP='DELETE' AND whaleu_account_deletion.follow_granted(TG_TABLE_NAME,payload) THEN RETURN OLD;END IF;
 FOR target IN SELECT unnest(ids) LOOP
  IF NOT EXISTS(SELECT 1 FROM whaleu_identity.accounts WHERE id=target AND lifecycle='active') THEN RAISE EXCEPTION 'Account lifecycle denies follow-social writer' USING ERRCODE='23514',CONSTRAINT='account_deletion_writer_fence';END IF;
 END LOOP;
 IF TG_TABLE_NAME='social_receipts' AND TG_OP='INSERT' AND payload->>'outcome'='account_deleted' THEN RAISE EXCEPTION 'Cannot fabricate deletion-terminal receipt' USING ERRCODE='23514';END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END$$;
DO $$DECLARE name text;schema_name text;BEGIN
 FOREACH name IN ARRAY ARRAY['user_follows','follow_heads','follow_requests','social_sources','social_work','social_notices','social_receipts','owners'] LOOP
  schema_name:=CASE WHEN name IN('user_follows','follow_heads','follow_requests','social_sources') THEN 'whaleu_community' ELSE 'whaleu_notifications' END;
  EXECUTE format('DROP TRIGGER a000_account_deletion_writer_fence ON %I.%I',schema_name,name);
  EXECUTE format('CREATE TRIGGER a000_account_deletion_writer_fence BEFORE INSERT OR UPDATE OR DELETE ON %I.%I FOR EACH ROW EXECUTE FUNCTION whaleu_account_deletion.follow_writer_fence()',schema_name,name);
  EXECUTE format('CREATE TRIGGER follow_no_truncate BEFORE TRUNCATE ON %I.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_account_deletion.immutable()',schema_name,name);
 END LOOP;
END$$;
-- The quota bucket is deliberately not a raw UUID. Account acquisition is
-- NOWAIT because repository creates hold quota last; direct writers cannot hide
-- behind its hash, and a deletion page must explicitly grant each cursor.
CREATE FUNCTION whaleu_account_deletion.follow_cursor_fence() RETURNS trigger LANGUAGE plpgsql AS $$DECLARE target uuid;payload jsonb;BEGIN
 payload:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
 SELECT account_id INTO target FROM whaleu_account_deletion.fixture_accounts WHERE whaleu_account_deletion.follow_bucket(account_id)=payload->>'bucket_hash';
 IF target IS NOT NULL THEN
  PERFORM whaleu_account_deletion.follow_lock_accounts(ARRAY[target]);
  IF NOT EXISTS(SELECT 1 FROM whaleu_identity.accounts WHERE id=target AND lifecycle='active') THEN
   IF TG_OP<>'DELETE' OR NOT whaleu_account_deletion.follow_granted('discovery_cursors',payload) THEN RAISE EXCEPTION 'Account lifecycle denies private cursor recreation or unowned cleanup' USING ERRCODE='23514';END IF;
  END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END$$;
CREATE TRIGGER a001_follow_cursor_fence BEFORE INSERT OR UPDATE OR DELETE ON whaleu_community.discovery_cursors FOR EACH ROW EXECUTE FUNCTION whaleu_account_deletion.follow_cursor_fence();
CREATE TRIGGER follow_cursor_no_truncate BEFORE TRUNCATE ON whaleu_community.discovery_cursors FOR EACH STATEMENT EXECUTE FUNCTION whaleu_account_deletion.immutable();
-- Native social cursor grammar, including null/type, bigint and calendar bounds.
-- Procedural validation precedes casts, so optimizer expression reordering cannot
-- turn malformed coordinates into an exception or SQL-UNKNOWN admission.
CREATE FUNCTION whaleu_account_deletion.follow_cursor_position_valid(value jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE parsed timestamptz;BEGIN
 IF jsonb_typeof(value) IS DISTINCT FROM 'object' THEN RETURN false;END IF;
 IF (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(value) k) IS DISTINCT FROM ARRAY['beforeAt','beforeOrdinal','head','kind','v']::text[]
 OR value->>'kind' IS DISTINCT FROM 'social-updates' OR value->'v' IS DISTINCT FROM '2'::jsonb
 OR jsonb_typeof(value->'head') IS DISTINCT FROM 'string' OR jsonb_typeof(value->'beforeOrdinal') IS DISTINCT FROM 'string' OR jsonb_typeof(value->'beforeAt') IS DISTINCT FROM 'string'
 OR NOT coalesce(value->>'head' ~ '^(0|[1-9][0-9]{0,18})$',false) OR NOT coalesce(value->>'beforeOrdinal' ~ '^[1-9][0-9]{0,18}$',false)
 OR NOT coalesce(value->>'beforeAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$',false) THEN RETURN false;END IF;
 IF (value->>'head')::numeric>9223372036854775807 OR (value->>'beforeOrdinal')::numeric>9223372036854775807 THEN RETURN false;END IF;
 parsed:=(value->>'beforeAt')::timestamptz;
 RETURN isfinite(parsed) AND to_char(parsed AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')=value->>'beforeAt';
 EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow OR numeric_value_out_of_range THEN RETURN false;
END$$;
CREATE FUNCTION whaleu_account_deletion.follow_partition_valid(sandbox uuid) RETURNS boolean LANGUAGE plpgsql STABLE AS $$BEGIN
 -- All changed social rows must be follow-only members of THIS admitted cohort.
 -- Unsupported relations keep their original full byte seals independently.
 IF EXISTS(SELECT 1 FROM whaleu_community.social_sources s LEFT JOIN whaleu_account_deletion.fixture_accounts a ON a.account_id=s.actor_account_id LEFT JOIN whaleu_account_deletion.fixture_accounts b ON b.account_id=s.recipient_account_id
  WHERE a.sandbox_id IS DISTINCT FROM sandbox OR b.sandbox_id IS DISTINCT FROM sandbox OR s.kind<>'follow' OR s.resource_kind<>'profile' OR s.reward_group_id IS NOT NULL OR s.post_id IS NOT NULL OR s.root_comment_id IS NOT NULL OR s.reply_id IS NOT NULL OR s.target_reply_id IS NOT NULL)
 OR EXISTS(SELECT 1 FROM whaleu_community.user_follows e LEFT JOIN whaleu_account_deletion.fixture_accounts a ON a.account_id=e.follower_id LEFT JOIN whaleu_account_deletion.fixture_accounts b ON b.account_id=e.followed_id
  WHERE a.sandbox_id IS DISTINCT FROM sandbox OR b.sandbox_id IS DISTINCT FROM sandbox OR e.source_request_id IS NULL OR NOT EXISTS(SELECT 1 FROM whaleu_community.follow_heads h WHERE h.account_id=e.follower_id) OR NOT EXISTS(SELECT 1 FROM whaleu_community.social_sources s WHERE s.actor_account_id=e.follower_id AND s.recipient_account_id=e.followed_id AND s.source_epoch_id=e.source_request_id AND s.resource_id=e.followed_profile_id AND s.kind='follow' AND s.occurred_at=e.created_at))
 OR EXISTS(SELECT 1 FROM whaleu_community.follow_heads h LEFT JOIN whaleu_account_deletion.fixture_accounts f ON f.account_id=h.account_id WHERE f.sandbox_id IS DISTINCT FROM sandbox)
 OR EXISTS(SELECT 1 FROM whaleu_community.follow_requests r LEFT JOIN whaleu_account_deletion.fixture_accounts f ON f.account_id=r.account_id WHERE f.sandbox_id IS DISTINCT FROM sandbox)
 OR EXISTS(SELECT 1 FROM whaleu_notifications.owners o LEFT JOIN whaleu_account_deletion.fixture_accounts f ON f.account_id=o.account_id WHERE f.sandbox_id IS DISTINCT FROM sandbox)
 OR EXISTS(SELECT 1 FROM whaleu_community.discovery_cursors c WHERE NOT EXISTS(SELECT 1 FROM whaleu_account_deletion.fixture_accounts f WHERE f.sandbox_id=sandbox AND whaleu_account_deletion.follow_bucket(f.account_id)=c.bucket_hash)
  OR NOT whaleu_account_deletion.follow_cursor_position_valid(c.position)) THEN RETURN false;END IF;
 IF EXISTS(SELECT 1 FROM whaleu_community.social_sources s LEFT JOIN whaleu_notifications.social_work w ON w.source_id=s.id LEFT JOIN whaleu_notifications.social_receipts r ON r.source_id=s.id
  WHERE NOT whaleu_account_deletion.follow_source_erasing(s.id) AND (w.source_id IS NULL OR w.kind<>s.kind OR w.recipient_account_id<>s.recipient_account_id OR ((w.state='completed')<>(r.source_id IS NOT NULL))
   OR (r.source_id IS NOT NULL AND (r.kind<>s.kind OR r.recipient_account_id<>s.recipient_account_id OR (r.outcome='account_deleted' AND (r.notice_id IS NOT NULL OR NOT whaleu_account_deletion.follow_source_retired(s.id)))
   OR (r.outcome<>'account_deleted' AND NOT EXISTS(SELECT 1 FROM whaleu_notifications.social_notices n WHERE n.id=r.notice_id AND n.recipient_account_id=s.recipient_account_id AND n.kind=s.kind
     AND n.dedupe_key=encode(sha256(convert_to(concat_ws(':','social-lifetime-v1',s.recipient_account_id::text,s.actor_account_id::text,s.kind,s.resource_kind,s.resource_id::text),'UTF8')),'hex')
     AND (r.outcome<>'materialized' OR (n.source_id=s.id AND n.created_at=s.occurred_at)))))))) THEN RETURN false;END IF;
 -- Sources can outlive actor commands only under an exact ongoing/completed
 -- scope; original INSERT provenance is not replaced by an arbitrary row seal.
 IF EXISTS(SELECT 1 FROM whaleu_community.social_sources s WHERE NOT EXISTS(SELECT 1 FROM whaleu_community.follow_requests r WHERE r.account_id=s.actor_account_id AND r.request_id=s.source_epoch_id AND r.profile_id=s.resource_id AND r.following AND r.outcome='applied')
  AND NOT EXISTS(SELECT 1 FROM whaleu_account_deletion.follow_scopes c JOIN whaleu_account_deletion.requests r ON r.id=c.request_id WHERE r.account_id=s.actor_account_id AND r.generation=c.generation AND r.phase IN('erasing','waiting','completed'))) THEN RETURN false;END IF;
 RETURN true;
END$$;
CREATE FUNCTION whaleu_account_deletion.follow_social_complete(request uuid) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE target uuid;c whaleu_account_deletion.follow_scopes;BEGIN
 SELECT account_id INTO target FROM whaleu_account_deletion.requests WHERE id=request;
 SELECT * INTO c FROM whaleu_account_deletion.follow_scopes WHERE request_id=request;
 IF target IS NULL OR c.request_id IS NULL OR c.phase<>11 OR c.inventory<>'account-deletion-local-0173-v1'
 OR EXISTS(SELECT 1 FROM whaleu_community.user_follows WHERE follower_id=target OR followed_id=target)
 OR EXISTS(SELECT 1 FROM whaleu_community.follow_heads WHERE account_id=target) OR EXISTS(SELECT 1 FROM whaleu_community.follow_requests WHERE account_id=target)
 OR EXISTS(SELECT 1 FROM whaleu_community.social_sources WHERE recipient_account_id=target)
 OR EXISTS(SELECT 1 FROM whaleu_notifications.social_work WHERE recipient_account_id=target)
 OR EXISTS(SELECT 1 FROM whaleu_notifications.social_notices WHERE recipient_account_id=target)
 OR EXISTS(SELECT 1 FROM whaleu_notifications.social_receipts WHERE recipient_account_id=target)
 OR EXISTS(SELECT 1 FROM whaleu_notifications.owners WHERE account_id=target)
 OR EXISTS(SELECT 1 FROM whaleu_community.discovery_cursors WHERE bucket_hash=whaleu_account_deletion.follow_bucket(target)) THEN RETURN false;END IF;
 IF EXISTS(SELECT 1 FROM whaleu_account_deletion.follow_source_intents i LEFT JOIN whaleu_account_deletion.follow_source_erasures e ON e.source_id=i.source_id AND e.source_fingerprint=i.source_fingerprint AND e.request_id=i.request_id AND e.generation=i.generation WHERE i.request_id=request AND e.source_id IS NULL)
 OR EXISTS(SELECT 1 FROM whaleu_community.social_sources s LEFT JOIN whaleu_account_deletion.follow_source_retirements e ON e.source_id=s.id LEFT JOIN whaleu_notifications.social_work w ON w.source_id=s.id LEFT JOIN whaleu_notifications.social_receipts r ON r.source_id=s.id
  WHERE s.actor_account_id=target AND (e.request_id IS DISTINCT FROM request OR e.source_fingerprint IS DISTINCT FROM whaleu_account_deletion.follow_source_fingerprint(s.id) OR w.state IS DISTINCT FROM 'completed' OR r.source_id IS NULL)) THEN RETURN false;END IF;
 -- Recipient precedence: retained lineage OR its exact later erasure, never a
 -- blanket absence waiver. Read_at is deliberately absent from this proof.
 IF EXISTS(SELECT 1 FROM whaleu_account_deletion.follow_source_retirements e WHERE e.request_id=request AND NOT EXISTS(SELECT 1 FROM whaleu_community.social_sources s WHERE s.id=e.source_id AND whaleu_account_deletion.follow_source_fingerprint(s.id)=e.source_fingerprint)
  AND NOT EXISTS(SELECT 1 FROM whaleu_account_deletion.follow_source_erasures x WHERE x.source_id=e.source_id AND x.source_fingerprint=e.source_fingerprint)) THEN RETURN false;END IF;
 RETURN true;
END$$;
CREATE FUNCTION whaleu_account_deletion.follow_page_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE m whaleu_account_deletion.follow_mutations;c whaleu_account_deletion.follow_scopes;BEGIN
 SELECT * INTO c FROM whaleu_account_deletion.follow_scopes WHERE request_id=NEW.request_id;
 IF c.page_number<NEW.page_number OR (SELECT count(*) FROM whaleu_account_deletion.follow_mutations WHERE request_id=NEW.request_id AND page_number=NEW.page_number)<>NEW.item_count
 OR EXISTS(SELECT 1 FROM whaleu_account_deletion.follow_candidates(NEW.request_id,NEW.phase) q WHERE (NEW.exhausted OR q.row_key<=NEW.after_boundary)) THEN RAISE EXCEPTION 'Follow page mutation and progress do not agree' USING ERRCODE='23514';END IF;
 IF NEW.phase=0 AND EXISTS(SELECT 1 FROM whaleu_account_deletion.follow_mutations edge_mutation JOIN whaleu_account_deletion.requests r ON r.id=edge_mutation.request_id
  WHERE edge_mutation.request_id=NEW.request_id AND edge_mutation.page_number=NEW.page_number AND split_part(edge_mutation.row_key,':',1)<>r.account_id::text
   AND NOT EXISTS(SELECT 1 FROM whaleu_account_deletion.follow_head_advances a JOIN whaleu_community.follow_heads h ON h.account_id=a.account_id AND h.revision=a.before_revision+1
    WHERE a.request_id=edge_mutation.request_id AND a.page_number=edge_mutation.page_number AND a.account_id=split_part(edge_mutation.row_key,':',1)::uuid AND a.mutation_transaction=NEW.mutation_transaction)) THEN RAISE EXCEPTION 'Every removed incoming edge requires exact follower revision evidence' USING ERRCODE='23514';END IF;
 FOR m IN SELECT * FROM whaleu_account_deletion.follow_mutations WHERE request_id=NEW.request_id AND page_number=NEW.page_number LOOP
  IF m.relation='incoming_intent' AND NOT EXISTS(SELECT 1 FROM whaleu_account_deletion.follow_source_intents i WHERE i.source_id=m.source_id AND i.request_id=m.request_id AND i.source_fingerprint=m.fingerprint)
  OR m.relation='social_sources' AND NOT EXISTS(SELECT 1 FROM whaleu_account_deletion.follow_source_erasures i WHERE i.source_id=m.source_id AND i.request_id=m.request_id AND i.source_fingerprint=m.fingerprint)
  OR m.relation='outgoing_retirement' AND (NOT EXISTS(SELECT 1 FROM whaleu_account_deletion.follow_source_retirements i WHERE i.source_id=m.source_id AND i.request_id=m.request_id AND i.source_fingerprint=m.fingerprint)
   OR NOT EXISTS(SELECT 1 FROM whaleu_notifications.social_work w JOIN whaleu_notifications.social_receipts r USING(source_id) WHERE w.source_id=m.source_id AND w.state='completed')) THEN RAISE EXCEPTION 'Exact source closure evidence missing' USING ERRCODE='23514';END IF;
 END LOOP;RETURN NULL;
END$$;
CREATE CONSTRAINT TRIGGER follow_page_complete AFTER INSERT ON whaleu_account_deletion.follow_pages DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_account_deletion.follow_page_complete();
CREATE OR REPLACE FUNCTION whaleu_account_deletion.follow_page_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c whaleu_account_deletion.follow_scopes;n integer;last_key text;BEGIN
 SELECT * INTO c FROM whaleu_account_deletion.follow_scopes WHERE request_id=NEW.request_id;
 SELECT count(*),max(row_key) FILTER(WHERE ordinal<=100) INTO n,last_key FROM (SELECT row_key,row_number() OVER(ORDER BY row_key) ordinal FROM whaleu_account_deletion.follow_candidates(NEW.request_id,NEW.phase) q WHERE q.row_key>NEW.before_boundary ORDER BY row_key LIMIT 101) candidates;
 IF NOT whaleu_account_deletion.follow_cause(NEW.request_id) OR NOT whaleu_account_deletion.inventory_current(NEW.request_id) OR NEW.generation<>c.generation OR NEW.mutation_transaction<>pg_current_xact_id()
 OR NEW.page_number<>c.page_number+1 OR NEW.phase<>c.phase OR NEW.before_boundary<>c.boundary OR NEW.item_count<>least(n,100) OR NEW.exhausted<>(n<=100)
 OR NEW.after_boundary<>coalesce(last_key,NEW.before_boundary) THEN RAISE EXCEPTION 'Invalid bounded follow page' USING ERRCODE='23514';END IF;RETURN NEW;
END$$;
-- One bounded nonempty page per tick, but traverse empty phases immediately.
-- Account locks -> all follow/source gates -> owner rows -> cursor quota last.
CREATE FUNCTION whaleu_account_deletion.follow_social_page(request uuid) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE r whaleu_account_deletion.requests;c whaleu_account_deletion.follow_scopes;p whaleu_account_deletion.follow_pages;item record;target uuid;ids uuid[];keys text[];n integer;last_key text;rel text;schema_name text;source whaleu_community.social_sources;BEGIN
 SELECT * INTO r FROM whaleu_account_deletion.requests WHERE id=request;
 IF NOT whaleu_account_deletion.follow_cause(request) OR NOT whaleu_account_deletion.inventory_current(request) THEN RAISE EXCEPTION 'Exact synthetic follow cause required' USING ERRCODE='23514';END IF;
 PERFORM id FROM whaleu_identity.accounts WHERE id=r.account_id FOR UPDATE NOWAIT;
 IF NOT whaleu_account_deletion.follow_partition_valid((SELECT sandbox_id FROM whaleu_account_deletion.fixture_accounts WHERE account_id=r.account_id)) THEN RAISE EXCEPTION 'Unsupported follow-social partition' USING ERRCODE='23514';END IF;
 INSERT INTO whaleu_account_deletion.follow_scopes(request_id,generation,policy,inventory,public_profile_id) SELECT r.id,r.generation,'synthetic-follow-social-v1',r.inventory,profile_row.public_id FROM (SELECT 1) singleton LEFT JOIN whaleu_profile.profiles profile_row ON profile_row.account_id=r.account_id ON CONFLICT DO NOTHING;
 LOOP
  SELECT * INTO c FROM whaleu_account_deletion.follow_scopes WHERE request_id=request;
  IF c.phase=11 THEN RETURN whaleu_account_deletion.follow_social_complete(request);END IF;
  SELECT count(*),max(row_key) FILTER(WHERE ordinal<=100),array_agg(row_key ORDER BY row_key) FILTER(WHERE ordinal<=100) INTO n,last_key,keys FROM (SELECT row_key,row_number() OVER(ORDER BY row_key) ordinal FROM whaleu_account_deletion.follow_candidates(request,c.phase) q WHERE q.row_key>c.boundary ORDER BY row_key LIMIT 101) candidates;
  rel:=whaleu_account_deletion.follow_phase_relation(c.phase);
  -- Discover endpoints without locks, then acquire every lifecycle before any gate.
  SELECT array_agg(DISTINCT id ORDER BY id) INTO ids FROM (
   SELECT r.account_id id UNION ALL
   SELECT (q.payload->>'follower_id')::uuid FROM whaleu_account_deletion.follow_candidates(request,c.phase) q WHERE q.row_key=ANY(keys) AND c.phase=0 UNION ALL
   SELECT (q.payload->>'followed_id')::uuid FROM whaleu_account_deletion.follow_candidates(request,c.phase) q WHERE q.row_key=ANY(keys) AND c.phase=0 UNION ALL
   SELECT s.actor_account_id FROM whaleu_account_deletion.follow_candidates(request,c.phase) q JOIN whaleu_community.social_sources s ON s.id=q.source_id WHERE q.row_key=ANY(keys) UNION ALL
   SELECT s.recipient_account_id FROM whaleu_account_deletion.follow_candidates(request,c.phase) q JOIN whaleu_community.social_sources s ON s.id=q.source_id WHERE q.row_key=ANY(keys)
  ) endpoints WHERE id IS NOT NULL;
  PERFORM whaleu_account_deletion.follow_lock_accounts(ids);
  FOR item IN SELECT DISTINCT 'whaleu:following:'||(payload->>'follower_id') gate FROM whaleu_account_deletion.follow_candidates(request,c.phase) q WHERE q.row_key=ANY(keys) AND c.phase=0
   UNION SELECT 'social-in-app:'||source_id::text FROM whaleu_account_deletion.follow_candidates(request,c.phase) q WHERE q.row_key=ANY(keys) AND source_id IS NOT NULL ORDER BY gate LOOP PERFORM whaleu_account_deletion.follow_try_gate(item.gate);END LOOP;
  -- A raw row lock may exist without the application's advisory gate. Do not
  -- let a later DELETE silently wait while holding lifecycle/source fences.
  FOR item IN SELECT DISTINCT source_id FROM whaleu_account_deletion.follow_candidates(request,c.phase) q WHERE q.row_key=ANY(keys) AND source_id IS NOT NULL ORDER BY source_id LOOP
   PERFORM id FROM whaleu_community.social_sources WHERE id=item.source_id FOR UPDATE NOWAIT;
  END LOOP;
  FOR target IN SELECT DISTINCT s.recipient_account_id FROM whaleu_account_deletion.follow_candidates(request,c.phase) q JOIN whaleu_community.social_sources s ON s.id=q.source_id WHERE q.row_key=ANY(keys) ORDER BY s.recipient_account_id LOOP
   PERFORM account_id FROM whaleu_notifications.owners WHERE account_id=target FOR UPDATE NOWAIT;
  END LOOP;
  IF c.phase=10 THEN PERFORM account_id FROM whaleu_notifications.owners WHERE account_id=r.account_id FOR UPDATE NOWAIT;END IF;
  schema_name:=CASE WHEN c.phase IN(0,1,2,6,7,8,9) THEN 'whaleu_community' ELSE 'whaleu_notifications' END;
  EXECUTE format('SELECT 1 FROM %I.%I t WHERE whaleu_account_deletion.follow_row_key($2,to_jsonb(t))=ANY($1) ORDER BY whaleu_account_deletion.follow_row_key($2,to_jsonb(t)) FOR UPDATE NOWAIT',schema_name,CASE WHEN c.phase IN(2,7) THEN 'social_sources' ELSE rel END) USING keys,rel;
  -- Dependent writes are not primary page candidates: prelock them too so
  -- revision updates and retirement settlement cannot wait under our fences.
  IF c.phase=0 THEN
   PERFORM h.account_id FROM whaleu_community.follow_heads h
    WHERE h.account_id<>r.account_id AND h.account_id IN(SELECT (q.payload->>'follower_id')::uuid FROM whaleu_account_deletion.follow_candidates(request,c.phase) q WHERE q.row_key=ANY(keys))
    ORDER BY h.account_id FOR UPDATE NOWAIT;
  ELSIF c.phase=7 THEN
   PERFORM w.source_id FROM whaleu_notifications.social_work w
    WHERE w.source_id IN(SELECT q.source_id FROM whaleu_account_deletion.follow_candidates(request,c.phase) q WHERE q.row_key=ANY(keys))
    ORDER BY w.source_id FOR UPDATE NOWAIT;
  END IF;
  IF c.phase=9 THEN PERFORM whaleu_account_deletion.follow_try_gate('whaleu:discovery:quota:v1:'||whaleu_account_deletion.follow_bucket(r.account_id));END IF;
  INSERT INTO whaleu_account_deletion.follow_pages(request_id,page_number,generation,phase,before_boundary,after_boundary,item_count,exhausted) VALUES(request,c.page_number+1,r.generation,c.phase,c.boundary,coalesce(last_key,c.boundary),least(n,100),n<=100) RETURNING * INTO p;
  INSERT INTO whaleu_account_deletion.follow_mutations(request_id,page_number,relation,row_key,fingerprint,source_id) SELECT request,p.page_number,rel,q.row_key,whaleu_account_deletion.json_hash(q.payload),q.source_id FROM whaleu_account_deletion.follow_candidates(request,c.phase) q WHERE q.row_key=ANY(keys) ORDER BY q.row_key;
  -- Re-read after locks; row guards reject any stale fingerprint.
  IF c.phase=0 THEN
   DELETE FROM whaleu_community.user_follows e USING whaleu_account_deletion.follow_mutations m WHERE m.request_id=request AND m.page_number=p.page_number AND m.row_key=e.follower_id::text||':'||e.followed_id::text;
   INSERT INTO whaleu_account_deletion.follow_head_advances(request_id,page_number,account_id,before_revision) SELECT request,p.page_number,h.account_id,h.revision FROM whaleu_community.follow_heads h WHERE h.account_id<>r.account_id AND h.account_id IN(SELECT split_part(m.row_key,':',1)::uuid FROM whaleu_account_deletion.follow_mutations m WHERE m.request_id=request AND m.page_number=p.page_number);
   UPDATE whaleu_community.follow_heads h SET revision=h.revision+1 WHERE h.account_id<>r.account_id AND h.account_id IN(SELECT split_part(m.row_key,':',1)::uuid FROM whaleu_account_deletion.follow_mutations m WHERE m.request_id=request AND m.page_number=p.page_number);
  ELSIF c.phase=2 THEN
   INSERT INTO whaleu_account_deletion.follow_source_intents(source_id,source_fingerprint,request_id,generation) SELECT m.source_id,m.fingerprint,request,r.generation FROM whaleu_account_deletion.follow_mutations m WHERE m.request_id=request AND m.page_number=p.page_number;
  ELSIF c.phase=6 THEN
   DELETE FROM whaleu_community.social_sources s USING whaleu_account_deletion.follow_mutations m WHERE m.request_id=request AND m.page_number=p.page_number AND s.id=m.source_id;
   INSERT INTO whaleu_account_deletion.follow_source_erasures(source_id,source_fingerprint,request_id,generation) SELECT m.source_id,m.fingerprint,request,r.generation FROM whaleu_account_deletion.follow_mutations m WHERE m.request_id=request AND m.page_number=p.page_number;
  ELSIF c.phase=7 THEN
   INSERT INTO whaleu_account_deletion.follow_source_retirements(source_id,source_fingerprint,request_id,generation) SELECT m.source_id,m.fingerprint,request,r.generation FROM whaleu_account_deletion.follow_mutations m WHERE m.request_id=request AND m.page_number=p.page_number;
   INSERT INTO whaleu_notifications.social_receipts(source_id,recipient_account_id,kind,outcome,notice_id) SELECT s.id,s.recipient_account_id,s.kind,'account_deleted',NULL FROM whaleu_community.social_sources s JOIN whaleu_account_deletion.follow_mutations m ON m.source_id=s.id AND m.request_id=request AND m.page_number=p.page_number JOIN whaleu_notifications.social_work w ON w.source_id=s.id WHERE w.state='pending';
   UPDATE whaleu_notifications.social_work w SET state='completed' FROM whaleu_account_deletion.follow_mutations m WHERE m.request_id=request AND m.page_number=p.page_number AND w.source_id=m.source_id AND w.state='pending';
  ELSE
   schema_name:=CASE WHEN c.phase IN(1,8,9) THEN 'whaleu_community' ELSE 'whaleu_notifications' END;
   EXECUTE format('DELETE FROM %I.%I t USING whaleu_account_deletion.follow_mutations m WHERE m.request_id=$1 AND m.page_number=$2 AND m.row_key=whaleu_account_deletion.follow_row_key($3,to_jsonb(t))',schema_name,rel) USING request,p.page_number,rel;
  END IF;
  UPDATE whaleu_account_deletion.follow_scopes SET phase=CASE WHEN p.exhausted THEN phase+1 ELSE phase END,boundary=CASE WHEN p.exhausted THEN '' ELSE p.after_boundary END,page_number=p.page_number,mutation_transaction=pg_current_xact_id() WHERE request_id=request;
  IF n>0 THEN RETURN false;END IF;
 END LOOP;
END$$;
-- Per-page feed revision evidence is tied to actually removed edge grants.
CREATE TABLE whaleu_account_deletion.follow_head_advances (
 request_id uuid NOT NULL,page_number bigint NOT NULL,account_id uuid NOT NULL,
 before_revision bigint NOT NULL CHECK(before_revision>=0),mutation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 PRIMARY KEY(request_id,page_number,account_id),FOREIGN KEY(request_id,page_number) REFERENCES whaleu_account_deletion.follow_pages(request_id,page_number)
);
CREATE TRIGGER follow_head_advance_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON whaleu_account_deletion.follow_head_advances FOR EACH STATEMENT EXECUTE FUNCTION whaleu_account_deletion.immutable();
CREATE FUNCTION whaleu_account_deletion.follow_head_advance_guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF NEW.mutation_transaction<>pg_current_xact_id() OR NOT whaleu_account_deletion.follow_cause(NEW.request_id)
 OR NOT EXISTS(SELECT 1 FROM whaleu_account_deletion.follow_pages p WHERE p.request_id=NEW.request_id AND p.page_number=NEW.page_number AND p.phase=0 AND p.mutation_transaction=pg_current_xact_id())
 OR NOT EXISTS(SELECT 1 FROM whaleu_account_deletion.follow_mutations m WHERE m.request_id=NEW.request_id AND m.page_number=NEW.page_number AND m.relation='user_follows' AND split_part(m.row_key,':',1)=NEW.account_id::text)
 OR EXISTS(SELECT 1 FROM whaleu_account_deletion.follow_mutations m JOIN whaleu_community.user_follows e ON m.row_key=e.follower_id::text||':'||e.followed_id::text WHERE m.request_id=NEW.request_id AND m.page_number=NEW.page_number)
 OR NOT EXISTS(SELECT 1 FROM whaleu_community.follow_heads h WHERE h.account_id=NEW.account_id AND h.revision=NEW.before_revision)
 THEN RAISE EXCEPTION 'Feed revision requires actual exact edge removal' USING ERRCODE='23514';END IF;RETURN NEW;
END$$;
CREATE TRIGGER follow_head_advance_guard BEFORE INSERT ON whaleu_account_deletion.follow_head_advances FOR EACH ROW EXECUTE FUNCTION whaleu_account_deletion.follow_head_advance_guard();
CREATE FUNCTION whaleu_account_deletion.follow_head_advance_complete() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF NOT EXISTS(SELECT 1 FROM whaleu_community.follow_heads h WHERE h.account_id=NEW.account_id AND h.revision=NEW.before_revision+1) THEN RAISE EXCEPTION 'Actual removed-edge feed revision missing' USING ERRCODE='23514';END IF;RETURN NULL;
END$$;
CREATE CONSTRAINT TRIGGER follow_head_advance_complete AFTER INSERT ON whaleu_account_deletion.follow_head_advances DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_account_deletion.follow_head_advance_complete();
-- Reject schema changes to coordinator evidence after its empty installation
-- seal as well as checking its finite relation allowlist in inventory_current.
CREATE FUNCTION whaleu_account_deletion.coordinator_shape() RETURNS text LANGUAGE sql STABLE AS $$
 SELECT whaleu_account_deletion.json_hash(coalesce(jsonb_agg(jsonb_build_object('relation',n.nspname||'.'||c.relname,
 'columns',(SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull) ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
 'constraints',(SELECT jsonb_agg(pg_get_constraintdef(k.oid) ORDER BY k.conname) FROM pg_constraint k WHERE k.conrelid=c.oid),
 'triggers',(SELECT jsonb_agg(pg_get_triggerdef(t.oid) ORDER BY t.tgname) FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal)) ORDER BY n.nspname,c.relname),'[]'::jsonb))
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN('whaleu_account_deletion','whaleu_meta') AND c.relkind IN('r','p')
$$;
ALTER TABLE whaleu_account_deletion.sandboxes ADD COLUMN coordinator_shape_hash text NOT NULL DEFAULT whaleu_account_deletion.coordinator_shape() CHECK(coordinator_shape_hash ~ '^[a-f0-9]{64}$');
CREATE FUNCTION whaleu_account_deletion.follow_social_proof(request uuid) RETURNS text LANGUAGE sql STABLE AS $$
 SELECT whaleu_account_deletion.json_hash(jsonb_build_array('synthetic-follow-social-v1',r.id,r.generation,r.inventory,
  jsonb_build_array('retained-linkable-internal-actor-id','retained-public-target-id','retained-event-command-ids','retained-original-times','retained-dedupe-and-row-fingerprints','no-profile-provider-token-media-payload'),
  to_jsonb(c)-'mutation_transaction',
  (SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY source_id),'[]'::jsonb) FROM whaleu_account_deletion.follow_source_retirements e WHERE e.request_id=r.id),
  (SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY source_id),'[]'::jsonb) FROM whaleu_account_deletion.follow_source_erasures e WHERE e.request_id=r.id),
  (SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY page_number),'[]'::jsonb) FROM whaleu_account_deletion.follow_pages p WHERE p.request_id=r.id)))
 FROM whaleu_account_deletion.requests r JOIN whaleu_account_deletion.follow_scopes c ON c.request_id=r.id WHERE r.id=request AND whaleu_account_deletion.follow_social_complete(r.id)
$$;

ALTER TABLE whaleu_account_deletion.owner_receipts DROP CONSTRAINT owner_receipts_owner_check;
ALTER TABLE whaleu_account_deletion.owner_receipts ADD CONSTRAINT owner_receipts_owner_check CHECK(owner IN('identity','profile','timetable','legacy-follow','follow-social','native-baseline','unsupported-inventory','media'));

CREATE OR REPLACE FUNCTION whaleu_account_deletion.owner_cause_admit() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF NEW.mutation_transaction<>pg_current_xact_id() OR NEW.owner NOT IN('identity','profile','timetable','legacy-follow','follow-social','native-baseline','unsupported-inventory','media')
 OR (NEW.owner='follow-social' AND NOT EXISTS(SELECT 1 FROM whaleu_account_deletion.requests WHERE id=NEW.request_id AND inventory='account-deletion-local-0173-v1'))
 OR (NEW.owner='legacy-follow' AND EXISTS(SELECT 1 FROM whaleu_account_deletion.requests WHERE id=NEW.request_id AND inventory='account-deletion-local-0173-v1'))
 OR NOT EXISTS(SELECT 1 FROM whaleu_account_deletion.requests r JOIN whaleu_identity.accounts a ON a.id=r.account_id
  WHERE r.id=NEW.request_id AND r.generation=NEW.generation AND r.phase IN('erasing','waiting')
    AND a.lifecycle='erasing' AND a.deletion_request_id=r.id AND a.lifecycle_generation=r.generation)
 THEN RAISE EXCEPTION 'Owner cause requires exact current erasure generation' USING ERRCODE='23514';END IF;RETURN NEW;
END$$;

CREATE OR REPLACE FUNCTION whaleu_account_deletion.owner_receipt_admit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r whaleu_account_deletion.requests;BEGIN
 SELECT * INTO r FROM whaleu_account_deletion.requests WHERE id=NEW.request_id;
 IF r.id IS NULL OR NEW.generation<>r.generation OR NEW.inventory<>r.inventory
 OR NOT whaleu_account_deletion.owner_cause(r.account_id,NEW.owner)
 OR NOT EXISTS(SELECT 1 FROM whaleu_account_deletion.owner_causes c WHERE c.request_id=r.id AND c.owner=NEW.owner AND c.generation=r.generation AND c.mutation_transaction=pg_current_xact_id())
 THEN RAISE EXCEPTION 'Exact current owner receipt cause required' USING ERRCODE='23514';END IF;
 IF NEW.owner='profile' AND (EXISTS(SELECT 1 FROM whaleu_profile.profiles WHERE account_id=r.account_id) OR EXISTS(SELECT 1 FROM whaleu_profile.details WHERE account_id=r.account_id) OR EXISTS(SELECT 1 FROM whaleu_profile.self_edit_causes WHERE actor_id=r.account_id AND (erased_by_request_id IS DISTINCT FROM r.id OR patch<>'{}'::jsonb OR before_row<>'{}'::jsonb OR token_hash<>repeat('0',64))))
 OR NEW.owner='identity' AND (EXISTS(SELECT 1 FROM whaleu_identity.sessions WHERE account_id=r.account_id) OR EXISTS(SELECT 1 FROM whaleu_identity.provider_identities WHERE account_id=r.account_id))
 OR NEW.owner='timetable' AND (EXISTS(SELECT 1 FROM whaleu_timetable.terms WHERE account_id=r.account_id AND (deleted_at IS NULL OR name IS NOT NULL OR week_one_monday IS NOT NULL OR week_count IS NOT NULL OR time_zone IS NOT NULL)) OR EXISTS(SELECT 1 FROM whaleu_timetable.entries WHERE account_id=r.account_id AND (deleted_at IS NULL OR name IS NOT NULL OR teacher IS NOT NULL OR location IS NOT NULL OR note IS NOT NULL OR day_of_week IS NOT NULL OR start_minute IS NOT NULL OR end_minute IS NOT NULL OR weeks IS NOT NULL OR color IS NOT NULL)))
 OR NEW.owner='legacy-follow' AND (EXISTS(SELECT 1 FROM whaleu_community.user_follows WHERE follower_id=r.account_id OR followed_id=r.account_id) OR EXISTS(SELECT 1 FROM whaleu_community.follow_requests WHERE account_id=r.account_id))
 OR NEW.owner='follow-social' AND (NOT whaleu_account_deletion.follow_social_complete(r.id) OR NEW.proof IS DISTINCT FROM whaleu_account_deletion.follow_social_proof(r.id))
 OR NEW.owner='native-baseline' AND NOT whaleu_account_deletion.baseline_current(r.account_id)
 OR NEW.owner='unsupported-inventory' AND NOT whaleu_account_deletion.inventory_current(r.id)
 OR NEW.owner='media' AND (NOT whaleu_account_deletion.media_complete(r.id)
   OR NOT EXISTS(SELECT 1 FROM whaleu_account_deletion.media_observations o WHERE o.request_id=r.id AND o.generation=r.generation AND o.mutation_transaction=pg_current_xact_id() AND o.proof=NEW.proof))
 THEN RAISE EXCEPTION 'Owner receipt requires actual erasure evidence' USING ERRCODE='23514';END IF;
 RETURN NEW;
END$$;

CREATE OR REPLACE FUNCTION whaleu_account_deletion.inventory_current(request uuid) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE sandbox uuid;item record;shape jsonb;rows jsonb;row_total integer;known text[];BEGIN
 SELECT f.sandbox_id INTO sandbox FROM whaleu_account_deletion.requests r JOIN whaleu_account_deletion.fixture_accounts f ON f.account_id=r.account_id WHERE r.id=request;
 IF sandbox IS NULL OR NOT EXISTS(SELECT 1 FROM whaleu_account_deletion.sandboxes WHERE id=sandbox AND inventory='account-deletion-local-0173-v1' AND coordinator_shape_hash=whaleu_account_deletion.coordinator_shape()) OR NOT whaleu_account_deletion.follow_partition_valid(sandbox) THEN RETURN false;END IF;
 IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname LIKE 'whaleu\_%' ESCAPE '\' AND c.relkind IN('m','f'))
 OR (SELECT array_agg(n.nspname||'.'||c.relname ORDER BY n.nspname||'.'||c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN('whaleu_account_deletion','whaleu_meta') AND c.relkind IN('r','p'))
 IS DISTINCT FROM ARRAY['whaleu_account_deletion.commands','whaleu_account_deletion.fixture_accounts','whaleu_account_deletion.fixture_media_cohorts','whaleu_account_deletion.follow_head_advances','whaleu_account_deletion.follow_mutations','whaleu_account_deletion.follow_pages','whaleu_account_deletion.follow_scopes','whaleu_account_deletion.follow_source_erasures','whaleu_account_deletion.follow_source_intents','whaleu_account_deletion.follow_source_retirements','whaleu_account_deletion.inventory','whaleu_account_deletion.media_observations','whaleu_account_deletion.owner_causes','whaleu_account_deletion.owner_receipts','whaleu_account_deletion.recovery_grants','whaleu_account_deletion.requests','whaleu_account_deletion.reregistration_guards','whaleu_account_deletion.reserved_profile_ids','whaleu_account_deletion.sandboxes','whaleu_meta.schema_migrations']::text[] THEN RETURN false;END IF;
 SELECT array_agg(relation ORDER BY relation) INTO known FROM whaleu_account_deletion.inventory WHERE sandbox_id=sandbox;
 IF known IS NULL OR known IS DISTINCT FROM (SELECT array_agg(n.nspname||'.'||c.relname ORDER BY n.nspname||'.'||c.relname)
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname LIKE 'whaleu\_%' ESCAPE '\' AND n.nspname NOT IN('whaleu_account_deletion','whaleu_meta') AND c.relkind IN('r','p'))
 OR EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname LIKE 'whaleu\_%' ESCAPE '\' AND n.nspname NOT IN('whaleu_account_deletion','whaleu_meta') AND NOT EXISTS(SELECT 1 FROM unnest(known) k WHERE split_part(k,'.',1)=n.nspname)) THEN RETURN false;END IF;
 FOR item IN SELECT * FROM whaleu_account_deletion.inventory WHERE sandbox_id=sandbox ORDER BY relation LOOP
  IF item.relation!~'^whaleu_[a-z_]+\.[a-z_][a-z0-9_]*$' OR item.supported IS DISTINCT FROM (item.relation=ANY(ARRAY['whaleu_identity.accounts','whaleu_identity.provider_identities','whaleu_identity.sessions','whaleu_identity.access_tokens','whaleu_identity.refresh_tokens','whaleu_profile.profiles','whaleu_profile.details','whaleu_profile.self_edit_causes','whaleu_profile.self_edit_transitions','whaleu_profile.self_edit_statements','whaleu_safety.account_policy_consumer_proofs','whaleu_timetable.terms','whaleu_timetable.entries','whaleu_timetable.commands','whaleu_community.follow_heads','whaleu_community.follow_requests','whaleu_community.user_follows','whaleu_community.social_sources','whaleu_notifications.social_work','whaleu_notifications.social_notices','whaleu_notifications.social_receipts','whaleu_notifications.owners','whaleu_community.discovery_cursors','whaleu_experience.owners','whaleu_experience.baselines','whaleu_experience.account_states','whaleu_experience.entitlements','whaleu_experience.appearance','whaleu_safety.account_heads','whaleu_safety.events','whaleu_verification.account_heads','whaleu_verification.assertions','whaleu_verification.snapshots','whaleu_verification.events','whaleu_verification.native_enrollments','whaleu_verification.relevant_fact_generations','whaleu_profile.admin_count_epochs','whaleu_safety.discovery_count_epochs','whaleu_community.related_sync_actor_generation','whaleu_community.related_sync_admission_generation','whaleu_community.related_sync_view_generation','whaleu_community.related_sync_applicability_generation']::text[])) THEN RETURN false;END IF;
  EXECUTE format('LOCK TABLE %I.%I IN SHARE ROW EXCLUSIVE MODE NOWAIT',split_part(item.relation,'.',1),split_part(item.relation,'.',2));
  SELECT jsonb_build_object('columns',(SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull) ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
   'constraints',(SELECT jsonb_agg(pg_get_constraintdef(k.oid) ORDER BY k.conname) FROM pg_constraint k WHERE k.conrelid=c.oid),
   'triggers',(SELECT jsonb_agg(pg_get_triggerdef(t.oid) ORDER BY t.tgname) FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal)) INTO shape FROM pg_class c WHERE c.oid=item.relation::regclass;
  IF whaleu_account_deletion.json_hash(shape) IS DISTINCT FROM item.shape_hash THEN RETURN false;END IF;
  IF NOT item.supported THEN
   EXECUTE format('SELECT count(*),coalesce(jsonb_agg(raw ORDER BY raw),''[]''::jsonb) FROM (SELECT to_jsonb(t)::text raw FROM %I.%I t ORDER BY to_jsonb(t)::text LIMIT 10001) q',split_part(item.relation,'.',1),split_part(item.relation,'.',2)) INTO row_total,rows;
   IF row_total<>item.row_count OR whaleu_account_deletion.json_hash(rows) IS DISTINCT FROM item.rows_hash THEN RETURN false;END IF;
  END IF;
 END LOOP;
 RETURN true;
END$$;

CREATE OR REPLACE FUNCTION whaleu_account_deletion.finalize_guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF NEW.phase<>'completed' THEN RETURN NEW;END IF;
 IF NEW.inventory<>'account-deletion-local-0173-v1' OR NOT whaleu_account_deletion.follow_social_complete(NEW.id)
 OR NOT whaleu_account_deletion.owner_cause(NEW.account_id,'identity')
 OR NOT whaleu_account_deletion.baseline_current(NEW.account_id)
 OR NOT whaleu_account_deletion.inventory_current(NEW.id)
 OR NOT whaleu_account_deletion.media_complete(NEW.id)
 OR NOT EXISTS(SELECT 1 FROM whaleu_account_deletion.reregistration_guards g JOIN whaleu_account_deletion.fixture_accounts f ON f.account_id=NEW.account_id WHERE g.request_id=NEW.id AND g.identity_digest=f.identity_digest AND g.completed_at=NEW.completed_at AND g.reregister_after=NEW.reregister_after AND g.key_version='synthetic-explicit-key-v1')
 THEN RAISE EXCEPTION 'Verified final deletion evidence is incomplete' USING ERRCODE='23514';END IF;
 RETURN NEW;
END$$;

CREATE OR REPLACE FUNCTION whaleu_notifications.social_notice_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_at timestamptz;
BEGIN
 SELECT occurred_at INTO source_at FROM whaleu_community.social_sources WHERE id=NEW.source_id
  AND recipient_account_id=NEW.recipient_account_id AND kind=NEW.kind;
 IF source_at IS NULL OR NEW.created_at IS DISTINCT FROM source_at THEN
  RAISE EXCEPTION 'Social notice time must equal its immutable first source' USING ERRCODE='23514';
 END IF;
 INSERT INTO whaleu_notifications.owners(account_id) VALUES(NEW.recipient_account_id) ON CONFLICT DO NOTHING;
 PERFORM account_id FROM whaleu_notifications.owners WHERE account_id=NEW.recipient_account_id FOR UPDATE NOWAIT;
 NEW.ordinal:=nextval('whaleu_notifications.social_notice_order');
 RETURN NEW;
END $$;

REVOKE ALL ON ALL TABLES IN SCHEMA whaleu_account_deletion FROM PUBLIC;
