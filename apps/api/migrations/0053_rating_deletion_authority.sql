-- R3A: owner cleanup and typed administrator deletion. No authority is seeded,
-- no history is rewritten, and deletion never reverses scores/likes or rewards.
SET LOCAL lock_timeout='5s';
SELECT pg_advisory_xact_lock(hashtextextended('whaleu:named-block-policy:v1',0));
LOCK TABLE whaleu_ratings.requests,whaleu_ratings.targets,whaleu_ratings.comments,
 whaleu_ratings.replies,whaleu_ratings.comment_transitions,
 whaleu_ratings.reply_transitions,whaleu_ratings.effect_events IN SHARE ROW EXCLUSIVE MODE;

-- Independent accepted origin; catalog/region/author affiliation is not evidence.
CREATE TABLE whaleu_ratings.target_origin_sources (
 id uuid PRIMARY KEY,target_id uuid NOT NULL REFERENCES whaleu_ratings.targets(id),
 revision integer NOT NULL CHECK(revision>0),
 state text NOT NULL CHECK(state IN ('known_school','schoolless','unknown')),
 origin_campus_id uuid REFERENCES whaleu_campus.campuses(id),
 revoked boolean NOT NULL DEFAULT false,
 coverage_state text NOT NULL CHECK(coverage_state IN ('complete','missing','conflicting')),
 provenance_state text NOT NULL CHECK(provenance_state IN ('accepted','unknown','conflicting')),
 source_reference text NOT NULL CHECK(length(btrim(source_reference)) BETWEEN 1 AND 500),
 policy_reference text NOT NULL CHECK(length(btrim(policy_reference)) BETWEEN 1 AND 500),
 source_version integer NOT NULL CHECK(source_version>0),
 effective_at timestamptz NOT NULL CHECK(isfinite(effective_at)),
 expiry_kind text NOT NULL CHECK(expiry_kind IN ('at','policy_exempt')),
 valid_until timestamptz,
 UNIQUE(target_id,revision),UNIQUE(id,target_id,revision),
 CHECK((state='known_school')=(origin_campus_id IS NOT NULL)),
 CHECK((expiry_kind='at' AND valid_until IS NOT NULL AND isfinite(valid_until) AND valid_until>effective_at)
   OR (expiry_kind='policy_exempt' AND valid_until IS NULL))
);
CREATE TABLE whaleu_ratings.target_origin_heads (
 target_id uuid PRIMARY KEY REFERENCES whaleu_ratings.targets(id),source_id uuid NOT NULL UNIQUE,
 revision integer NOT NULL CHECK(revision>0),
 FOREIGN KEY(source_id,target_id,revision) REFERENCES whaleu_ratings.target_origin_sources(id,target_id,revision)
);
CREATE FUNCTION whaleu_ratings.origin_head_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE next_source whaleu_ratings.target_origin_sources;old_source whaleu_ratings.target_origin_sources;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Rating origin heads are durable' USING ERRCODE='23514';END IF;
 SELECT * INTO next_source FROM whaleu_ratings.target_origin_sources WHERE id=NEW.source_id;
 -- Statement writer already owns the exclusive Safety gate. A raw writer never
 -- waits while taking the remaining head -> target locks in reverse order.
 PERFORM target_id FROM whaleu_ratings.target_origin_heads WHERE target_id=NEW.target_id FOR UPDATE NOWAIT;
 PERFORM id FROM whaleu_ratings.targets WHERE id=NEW.target_id FOR UPDATE NOWAIT;
 IF NOT FOUND OR (next_source.target_id,next_source.revision) IS DISTINCT FROM (NEW.target_id,NEW.revision) THEN
  RAISE EXCEPTION 'Rating origin head source mismatch' USING ERRCODE='23514';END IF;
 IF TG_OP='UPDATE' THEN
  SELECT * INTO old_source FROM whaleu_ratings.target_origin_sources WHERE id=OLD.source_id;
  IF NEW.target_id<>OLD.target_id OR NEW.revision<=OLD.revision OR next_source.effective_at<=old_source.effective_at THEN
   RAISE EXCEPTION 'Rating origin head cannot rewind' USING ERRCODE='23514';END IF;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER rating_origin_head_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_ratings.target_origin_heads
 FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.origin_head_guard();
CREATE TRIGGER rating_origin_source_immutable BEFORE UPDATE OR DELETE ON whaleu_ratings.target_origin_sources
 FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.immutable();
DO $$ DECLARE tab text;BEGIN
 FOREACH tab IN ARRAY ARRAY['target_origin_sources','target_origin_heads'] LOOP
  EXECUTE format('CREATE TRIGGER a0_rating_origin_writer BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_ratings.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.policy_writer()',tab);
  EXECUTE format('CREATE TRIGGER rating_origin_retain BEFORE TRUNCATE ON whaleu_ratings.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.immutable()',tab);
 END LOOP;
END $$;

ALTER TABLE whaleu_ratings.requests DROP CONSTRAINT requests_operation_check;
ALTER TABLE whaleu_ratings.requests ADD CHECK(operation IN
 ('set_score','create_comment','delete_comment','create_reply','delete_reply',
  'set_comment_like','set_reply_like','set_target_subscription','admin_delete_comment','admin_delete_reply'));

CREATE TABLE whaleu_ratings.admin_delete_audits (
 id uuid PRIMARY KEY,actor_account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
 -- Retained evidence, not a session FK: normal session cleanup remains possible.
 session_id uuid NOT NULL,request_id uuid NOT NULL,intent_hash text NOT NULL CHECK(intent_hash~'^[a-f0-9]{64}$'),
 subject_kind text NOT NULL CHECK(subject_kind IN ('comment','reply')),
 target_id uuid NOT NULL REFERENCES whaleu_ratings.targets(id),root_id uuid NOT NULL,subject_id uuid NOT NULL,
 comment_id uuid GENERATED ALWAYS AS (CASE WHEN subject_kind='comment' THEN subject_id END) STORED,
 reply_id uuid GENERATED ALWAYS AS (CASE WHEN subject_kind='reply' THEN subject_id END) STORED,
 author_account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
 target_revision uuid NOT NULL,root_revision uuid NOT NULL,before_revision uuid NOT NULL,after_revision uuid NOT NULL,
 scope_kind text NOT NULL CHECK(scope_kind IN ('global','fixed')),
 grant_id uuid NOT NULL REFERENCES whaleu_authorization.role_grants(id),
 grant_fingerprint text NOT NULL CHECK(grant_fingerprint~'^[a-f0-9]{64}$'),
 operating_region_id uuid REFERENCES whaleu_campus.operating_regions(id),
 origin_source_id uuid,origin_revision integer,
 origin_state text NOT NULL CHECK(origin_state IN ('known_school','schoolless','unknown','absent')),
 origin_campus_id uuid REFERENCES whaleu_campus.campuses(id),
 origin_fingerprint text NOT NULL CHECK(origin_fingerprint~'^[a-f0-9]{64}$'),
 topology_snapshot_id uuid,topology_revision integer,
 context_revision text NOT NULL CHECK(length(context_revision) BETWEEN 1 AND 8192),
 outcome text NOT NULL CHECK(outcome IN ('applied','noop')),
 occurred_at timestamptz NOT NULL CHECK(isfinite(occurred_at)),
 authorized_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(authorized_at)),
 mutation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 effective_comment_transition_id uuid REFERENCES whaleu_ratings.comment_transitions(id),
 effective_reply_transition_id uuid REFERENCES whaleu_ratings.reply_transitions(id),
 UNIQUE(actor_account_id,request_id),
 FOREIGN KEY(actor_account_id,request_id) REFERENCES whaleu_ratings.requests(account_id,request_id),
 FOREIGN KEY(root_id,target_id) REFERENCES whaleu_ratings.comments(id,target_id),
 FOREIGN KEY(comment_id,target_id) REFERENCES whaleu_ratings.comments(id,target_id),
 FOREIGN KEY(reply_id,root_id,target_id) REFERENCES whaleu_ratings.replies(id,root_id,target_id),
 FOREIGN KEY(origin_source_id,target_id,origin_revision) REFERENCES whaleu_ratings.target_origin_sources(id,target_id,revision),
 FOREIGN KEY(topology_snapshot_id,topology_revision) REFERENCES whaleu_campus.community_topology_snapshots(id,revision),
 CHECK(subject_kind<>'comment' OR root_id=subject_id),
 CHECK((origin_source_id IS NULL)=(origin_revision IS NULL)),
 CHECK((origin_state='absent')=(origin_source_id IS NULL)),
 CHECK((origin_state='known_school')=(origin_campus_id IS NOT NULL)),
 CHECK((topology_snapshot_id IS NULL)=(topology_revision IS NULL)),
 CHECK((scope_kind='global' AND operating_region_id IS NULL AND topology_snapshot_id IS NULL)
  OR (scope_kind='fixed' AND operating_region_id IS NOT NULL AND origin_state='known_school' AND topology_snapshot_id IS NOT NULL)),
 CHECK((outcome='applied' AND before_revision<>after_revision AND effective_comment_transition_id IS NULL AND effective_reply_transition_id IS NULL)
  OR (outcome='noop' AND before_revision=after_revision AND
   ((subject_kind='comment' AND effective_comment_transition_id IS NOT NULL AND effective_reply_transition_id IS NULL)
    OR (subject_kind='reply' AND effective_reply_transition_id IS NOT NULL AND effective_comment_transition_id IS NULL))))
);
ALTER TABLE whaleu_ratings.comments ADD COLUMN admin_delete_audit_id uuid UNIQUE REFERENCES whaleu_ratings.admin_delete_audits(id);
ALTER TABLE whaleu_ratings.replies ADD COLUMN admin_delete_audit_id uuid UNIQUE REFERENCES whaleu_ratings.admin_delete_audits(id);
-- Replace only the old deleted/request equivalence, preserving every other check.
DO $$ DECLARE tab text;c record;BEGIN
 FOREACH tab IN ARRAY ARRAY['comments','replies'] LOOP
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid=format('whaleu_ratings.%I',tab)::regclass AND contype='c'
   AND pg_get_constraintdef(oid) LIKE '%deleted_at%' AND pg_get_constraintdef(oid) LIKE '%delete_request_id%' LOOP
   EXECUTE format('ALTER TABLE whaleu_ratings.%I DROP CONSTRAINT %I',tab,c.conname);
  END LOOP;
  EXECUTE format('ALTER TABLE whaleu_ratings.%I ADD CONSTRAINT rating_deletion_exact_cause CHECK((deleted_at IS NULL AND delete_request_id IS NULL AND admin_delete_audit_id IS NULL) OR (deleted_at IS NOT NULL AND ((delete_request_id IS NULL)<>(admin_delete_audit_id IS NULL))))',tab);
 END LOOP;
END $$;
ALTER TABLE whaleu_ratings.comment_transitions ALTER COLUMN request_id DROP NOT NULL,
 ADD COLUMN admin_delete_audit_id uuid UNIQUE REFERENCES whaleu_ratings.admin_delete_audits(id),
 ADD CONSTRAINT rating_comment_transition_cause CHECK(
  (operation='create_comment' AND request_id IS NOT NULL AND admin_delete_audit_id IS NULL)
  OR (operation='delete_comment' AND ((request_id IS NULL)<>(admin_delete_audit_id IS NULL))));
ALTER TABLE whaleu_ratings.reply_transitions ALTER COLUMN request_id DROP NOT NULL,
 ADD COLUMN admin_delete_audit_id uuid UNIQUE REFERENCES whaleu_ratings.admin_delete_audits(id),
 ADD CONSTRAINT rating_reply_transition_cause CHECK(
  (operation='create_reply' AND request_id IS NOT NULL AND admin_delete_audit_id IS NULL)
  OR (operation='delete_reply' AND ((request_id IS NULL)<>(admin_delete_audit_id IS NULL))));

-- This pure predicate mirrors the Campus snapshot schema without importing
-- public activation eligibility. Malformed or conflicting accepted JSON is not
-- a valid origin mapping, even when the requested assignment looks plausible.
CREATE FUNCTION whaleu_ratings.origin_topology_shape(document jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE item jsonb;kind text;field text;fields text[];
BEGIN
 IF jsonb_typeof(document) IS DISTINCT FROM 'object' OR document->'version' IS DISTINCT FROM '1'::jsonb
  OR (document-ARRAY['version','groups','regions','assignments'])<>'{}'::jsonb
  OR jsonb_typeof(document->'groups') IS DISTINCT FROM 'array'
  OR jsonb_typeof(document->'regions') IS DISTINCT FROM 'array'
  OR jsonb_typeof(document->'assignments') IS DISTINCT FROM 'array' THEN RETURN false;END IF;
 FOREACH kind IN ARRAY ARRAY['groups','regions','assignments'] LOOP
  fields:=CASE kind WHEN 'groups' THEN ARRAY['groupId'] WHEN 'regions' THEN ARRAY['regionId','institutionId','groupId'] ELSE ARRAY['campusId','institutionId','regionId'] END;
  FOR item IN SELECT element FROM jsonb_array_elements(document->kind) element LOOP
   IF jsonb_typeof(item) IS DISTINCT FROM 'object' THEN RETURN false;END IF;
   IF (item-(fields||ARRAY['coverage','isActive']))<>'{}'::jsonb
    OR NOT coalesce(item->>'coverage' IN ('complete','missing','conflicting'),false)
    OR jsonb_typeof(item->'isActive') IS DISTINCT FROM 'boolean' THEN RETURN false;END IF;
   FOREACH field IN ARRAY fields LOOP
    IF jsonb_typeof(item->field) IS DISTINCT FROM 'string'
     OR NOT coalesce(item->>field ~ '^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$',false) THEN RETURN false;END IF;
   END LOOP;
  END LOOP;
 END LOOP;
 IF (SELECT count(*)<>count(DISTINCT entry->>'groupId') FROM jsonb_array_elements(document->'groups') entry)
  OR (SELECT count(*)<>count(DISTINCT entry->>'regionId') FROM jsonb_array_elements(document->'regions') entry)
  OR (SELECT count(*)<>count(DISTINCT entry->>'campusId') FROM jsonb_array_elements(document->'assignments') entry)
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(document->'regions') region WHERE NOT EXISTS(
    SELECT 1 FROM jsonb_array_elements(document->'groups') community_group WHERE community_group->>'groupId'=region->>'groupId'))
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(document->'assignments') assignment WHERE NOT EXISTS(
    SELECT 1 FROM jsonb_array_elements(document->'regions') region WHERE region->>'regionId'=assignment->>'regionId' AND region->>'institutionId'=assignment->>'institutionId')) THEN RETURN false;END IF;
 RETURN true;
END $$;

-- Audit insertion binds the actor and fresh request before any content change.
-- Runtime additionally proves complete grant/origin/topology fingerprints at commit.
CREATE FUNCTION whaleu_ratings.admin_delete_audit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q whaleu_ratings.requests;s whaleu_identity.sessions;g whaleu_authorization.role_grants;
 t whaleu_ratings.targets;c whaleu_ratings.comments;r whaleu_ratings.replies;
 o whaleu_ratings.target_origin_sources;h whaleu_ratings.target_origin_heads;
 topology whaleu_campus.community_topology_snapshots;ct whaleu_ratings.comment_transitions;rt whaleu_ratings.reply_transitions;
 actor uuid;revision uuid;deleted timestamptz;created timestamptz;instant timestamptz;
BEGIN
 SELECT * INTO s FROM whaleu_identity.sessions WHERE id=NEW.session_id FOR SHARE NOWAIT;
 SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=NEW.actor_account_id AND request_id=NEW.request_id FOR UPDATE NOWAIT;
 SELECT * INTO g FROM whaleu_authorization.role_grants WHERE id=NEW.grant_id FOR SHARE NOWAIT;
 SELECT * INTO h FROM whaleu_ratings.target_origin_heads WHERE target_id=NEW.target_id FOR SHARE NOWAIT;
 SELECT * INTO o FROM whaleu_ratings.target_origin_sources WHERE id=h.source_id;
 IF NEW.topology_snapshot_id IS NOT NULL THEN
  PERFORM scope_key FROM whaleu_campus.community_topology_heads WHERE scope_key='community' FOR SHARE NOWAIT;
  SELECT snapshot.* INTO topology FROM whaleu_campus.community_topology_snapshots snapshot
   JOIN whaleu_campus.community_topology_heads head ON head.snapshot_id=snapshot.id AND head.revision=snapshot.revision
   WHERE head.scope_key='community' AND snapshot.id=NEW.topology_snapshot_id;
 END IF;
 SELECT * INTO t FROM whaleu_ratings.targets WHERE id=NEW.target_id FOR UPDATE NOWAIT;
 SELECT * INTO c FROM whaleu_ratings.comments WHERE id=NEW.root_id AND target_id=NEW.target_id FOR UPDATE NOWAIT;
 IF NEW.subject_kind='reply' THEN
  SELECT * INTO r FROM whaleu_ratings.replies WHERE id=NEW.subject_id AND root_id=NEW.root_id AND target_id=NEW.target_id FOR UPDATE NOWAIT;
  actor:=r.account_id;revision:=r.revision;deleted:=r.deleted_at;created:=r.created_at;
 ELSE actor:=c.account_id;revision:=c.revision;deleted:=c.deleted_at;created:=c.created_at;END IF;
 instant:=clock_timestamp();NEW.authorized_at:=instant;
 -- Applied lifecycle time is database-owned, just like owner tombstones.
 -- A caller cannot backdate a fresh deletion by supplying an older audit time.
 IF NEW.outcome='applied' THEN NEW.occurred_at:=instant;END IF;
 IF s.account_id IS DISTINCT FROM NEW.actor_account_id OR s.revoked_at IS NOT NULL OR s.access_expires_at<=instant OR s.absolute_expires_at<=instant
  OR NOT EXISTS(SELECT 1 FROM whaleu_identity.accounts WHERE id=NEW.actor_account_id AND status='active')
  OR q.operation IS DISTINCT FROM 'admin_delete_'||NEW.subject_kind OR q.receipt IS NOT NULL OR q.intent_hash IS DISTINCT FROM NEW.intent_hash
  OR NEW.mutation_transaction IS DISTINCT FROM pg_current_xact_id()
  OR (t.revision,c.revision,actor,revision) IS DISTINCT FROM (NEW.target_revision,NEW.root_revision,NEW.author_account_id,NEW.before_revision)
  OR NEW.occurred_at>instant OR NEW.occurred_at<created THEN
  RAISE EXCEPTION 'Invalid administrator deletion actor, request or subject' USING ERRCODE='23514';END IF;
 IF g.account_id IS DISTINCT FROM NEW.actor_account_id OR g.revoked_at IS NOT NULL OR g.valid_from>instant OR (g.expires_at IS NOT NULL AND g.expires_at<=instant)
  OR (NEW.scope_kind='global' AND (g.role NOT IN ('developer','super_admin') OR g.operating_region_id IS NOT NULL))
  OR (NEW.scope_kind='fixed' AND (g.role<>'school_admin' OR g.operating_region_id IS DISTINCT FROM NEW.operating_region_id)) THEN
  RAISE EXCEPTION 'Invalid administrator deletion grant' USING ERRCODE='23514';END IF;
 IF (h.source_id,h.revision) IS DISTINCT FROM (NEW.origin_source_id,NEW.origin_revision)
  OR (h.source_id IS NULL AND NEW.origin_state<>'absent')
  OR (h.source_id IS NOT NULL AND (CASE WHEN NOT o.revoked AND o.coverage_state='complete' AND o.provenance_state='accepted' AND o.effective_at<=instant AND (o.valid_until IS NULL OR o.valid_until>instant) THEN o.state ELSE 'unknown' END,
    CASE WHEN NOT o.revoked AND o.coverage_state='complete' AND o.provenance_state='accepted' AND o.effective_at<=instant AND (o.valid_until IS NULL OR o.valid_until>instant) THEN o.origin_campus_id END) IS DISTINCT FROM (NEW.origin_state,NEW.origin_campus_id)) THEN
  RAISE EXCEPTION 'Administrator deletion origin changed' USING ERRCODE='23514';END IF;
 IF NEW.scope_kind='fixed' THEN
  IF o.id IS NULL OR o.state<>'known_school' OR o.revoked OR o.coverage_state<>'complete' OR o.provenance_state<>'accepted'
   OR o.effective_at>instant OR (o.valid_until IS NOT NULL AND o.valid_until<=instant)
   OR topology.id IS NULL OR topology.revision<>NEW.topology_revision OR topology.coverage_state<>'complete' OR topology.provenance_state<>'accepted'
   OR NOT whaleu_ratings.origin_topology_shape(topology.topology)
   OR coalesce(length(btrim(topology.source_reference)),0)=0 OR coalesce(length(btrim(topology.policy_reference)),0)=0
   OR topology.effective_at>instant OR topology.expiry_kind NOT IN ('at','policy_exempt') OR (topology.valid_until IS NOT NULL AND topology.valid_until<=instant)
   OR (SELECT count(*) FROM jsonb_array_elements(topology.topology->'assignments') a WHERE a->>'campusId'=NEW.origin_campus_id::text)<>1
   OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(topology.topology->'assignments') a
    JOIN LATERAL jsonb_array_elements(topology.topology->'regions') region ON region->>'regionId'=a->>'regionId'
    JOIN LATERAL jsonb_array_elements(topology.topology->'groups') community_group ON community_group->>'groupId'=region->>'groupId'
    WHERE a->>'campusId'=NEW.origin_campus_id::text AND a->>'regionId'=NEW.operating_region_id::text
     AND a->>'institutionId'=region->>'institutionId'
     AND a->>'coverage'='complete' AND region->>'coverage'='complete' AND community_group->>'coverage'='complete'
     AND (SELECT count(*) FROM jsonb_array_elements(topology.topology->'regions') candidate WHERE candidate->>'regionId'=region->>'regionId')=1
     AND (SELECT count(*) FROM jsonb_array_elements(topology.topology->'groups') candidate WHERE candidate->>'groupId'=community_group->>'groupId')=1) THEN
   RAISE EXCEPTION 'Fixed administrator origin mapping unavailable' USING ERRCODE='23514';END IF;
 END IF;
 IF NEW.outcome='applied' THEN
  IF deleted IS NOT NULL THEN RAISE EXCEPTION 'Administrator applied deletion requires a live subject' USING ERRCODE='23514';END IF;
 ELSE
  IF deleted IS NULL OR deleted IS DISTINCT FROM NEW.occurred_at THEN RAISE EXCEPTION 'Administrator noop requires the exact tombstone' USING ERRCODE='23514';END IF;
  IF NEW.subject_kind='comment' THEN
   SELECT * INTO ct FROM whaleu_ratings.comment_transitions WHERE id=NEW.effective_comment_transition_id;
   IF ct.operation IS DISTINCT FROM 'delete_comment' OR (ct.comment_id,ct.target_id,ct.account_id,ct.revision,ct.occurred_at) IS DISTINCT FROM
    (NEW.subject_id,NEW.target_id,NEW.author_account_id,NEW.after_revision,NEW.occurred_at) THEN RAISE EXCEPTION 'Administrator root noop source mismatch' USING ERRCODE='23514';END IF;
  ELSE
   SELECT * INTO rt FROM whaleu_ratings.reply_transitions WHERE id=NEW.effective_reply_transition_id;
   IF rt.operation IS DISTINCT FROM 'delete_reply' OR (rt.reply_id,rt.root_id,rt.target_id,rt.account_id,rt.revision,rt.occurred_at) IS DISTINCT FROM
    (NEW.subject_id,NEW.root_id,NEW.target_id,NEW.author_account_id,NEW.after_revision,NEW.occurred_at) THEN RAISE EXCEPTION 'Administrator reply noop source mismatch' USING ERRCODE='23514';END IF;
  END IF;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER rating_admin_delete_audit_guard BEFORE INSERT ON whaleu_ratings.admin_delete_audits FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.admin_delete_audit_guard();
CREATE TRIGGER rating_admin_delete_audit_immutable BEFORE UPDATE OR DELETE ON whaleu_ratings.admin_delete_audits FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.immutable();
CREATE TRIGGER rating_admin_delete_audit_retain BEFORE TRUNCATE ON whaleu_ratings.admin_delete_audits FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.immutable();

-- Only the deletion branch may ignore public parent availability. All paths
-- retain the real FK chain and parent-first, nonblocking raw-write fences.
CREATE OR REPLACE FUNCTION whaleu_ratings.root_parent_lock() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 PERFORM id FROM whaleu_ratings.targets WHERE id=NEW.target_id AND (TG_OP='UPDATE' OR active) FOR UPDATE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'Root parent unavailable' USING ERRCODE='23514';END IF;
 IF TG_OP='INSERT' THEN NEW.created_at:=clock_timestamp();ELSE NEW.deleted_at:=clock_timestamp();END IF;RETURN NEW;
END $$;
CREATE FUNCTION whaleu_ratings.admin_delete_cause(
 audit uuid,kind text,target uuid,root uuid,subject uuid,author uuid,before_rev uuid,after_rev uuid
) RETURNS timestamptz LANGUAGE plpgsql AS $$
DECLARE a whaleu_ratings.admin_delete_audits;q whaleu_ratings.requests;
BEGIN
 SELECT * INTO a FROM whaleu_ratings.admin_delete_audits WHERE id=audit;
 SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=a.actor_account_id AND request_id=a.request_id FOR UPDATE NOWAIT;
 IF a.id IS NULL OR a.outcome<>'applied' OR a.mutation_transaction<>pg_current_xact_id()
  OR (a.subject_kind,a.target_id,a.root_id,a.subject_id,a.author_account_id,a.before_revision,a.after_revision)
   IS DISTINCT FROM (kind,target,root,subject,author,before_rev,after_rev)
  OR q.operation IS DISTINCT FROM 'admin_delete_'||kind OR q.intent_hash IS DISTINCT FROM a.intent_hash OR q.receipt IS NOT NULL THEN
  RAISE EXCEPTION 'Administrator deletion cause mismatch' USING ERRCODE='23514';END IF;
 RETURN a.occurred_at;
END $$;
CREATE OR REPLACE FUNCTION whaleu_ratings.comment_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE command whaleu_ratings.requests;op text;key uuid;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Comment tombstone is durable' USING ERRCODE='23514';END IF;
 IF TG_OP='UPDATE' THEN
  IF (to_jsonb(NEW)-ARRAY['deleted_at','delete_request_id','admin_delete_audit_id','revision']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['deleted_at','delete_request_id','admin_delete_audit_id','revision'])
   OR OLD.deleted_at IS NOT NULL OR NEW.deleted_at IS NULL OR NEW.revision=OLD.revision
   OR ((NEW.delete_request_id IS NULL)=(NEW.admin_delete_audit_id IS NULL)) THEN
   RAISE EXCEPTION 'Invalid comment deletion' USING ERRCODE='23514';END IF;
  IF NEW.admin_delete_audit_id IS NOT NULL THEN
   NEW.deleted_at:=whaleu_ratings.admin_delete_cause(NEW.admin_delete_audit_id,'comment',NEW.target_id,NEW.id,NEW.id,NEW.account_id,OLD.revision,NEW.revision);
   RETURN NEW;
  END IF;
  op:='delete_comment';key:=NEW.delete_request_id;
 ELSE
  IF NEW.deleted_at IS NOT NULL OR NEW.delete_request_id IS NOT NULL OR NEW.admin_delete_audit_id IS NOT NULL OR NEW.publication_transaction<>pg_current_xact_id() THEN
   RAISE EXCEPTION 'Invalid comment publication' USING ERRCODE='23514';END IF;
  op:='create_comment';key:=NEW.request_id;
 END IF;
 SELECT * INTO command FROM whaleu_ratings.requests WHERE account_id=NEW.account_id AND request_id=key FOR UPDATE NOWAIT;
 IF command.operation IS DISTINCT FROM op OR command.receipt IS NOT NULL THEN RAISE EXCEPTION 'Invalid comment command' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION whaleu_ratings.reply_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE command whaleu_ratings.requests;op text;key uuid;t whaleu_ratings.targets;r whaleu_ratings.comments;p whaleu_ratings.replies;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Reply tombstone is durable' USING ERRCODE='23514';END IF;
 SELECT * INTO t FROM whaleu_ratings.targets WHERE id=NEW.target_id FOR UPDATE NOWAIT;
 SELECT * INTO r FROM whaleu_ratings.comments WHERE id=NEW.root_id AND target_id=NEW.target_id FOR UPDATE NOWAIT;
 IF t.id IS NULL OR r.id IS NULL THEN RAISE EXCEPTION 'Reply parent unavailable' USING ERRCODE='23514';END IF;
 IF TG_OP='UPDATE' THEN
  IF (to_jsonb(NEW)-ARRAY['deleted_at','delete_request_id','admin_delete_audit_id','revision']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['deleted_at','delete_request_id','admin_delete_audit_id','revision'])
   OR OLD.deleted_at IS NOT NULL OR NEW.deleted_at IS NULL OR NEW.revision=OLD.revision
   OR ((NEW.delete_request_id IS NULL)=(NEW.admin_delete_audit_id IS NULL)) THEN
   RAISE EXCEPTION 'Invalid reply deletion' USING ERRCODE='23514';END IF;
  IF NEW.admin_delete_audit_id IS NOT NULL THEN
   NEW.deleted_at:=whaleu_ratings.admin_delete_cause(NEW.admin_delete_audit_id,'reply',NEW.target_id,NEW.root_id,NEW.id,NEW.account_id,OLD.revision,NEW.revision);
   RETURN NEW;
  END IF;
  NEW.deleted_at:=clock_timestamp();op:='delete_reply';key:=NEW.delete_request_id;
 ELSE
  IF t.active IS DISTINCT FROM true OR r.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'Reply parent unavailable' USING ERRCODE='23514';END IF;
  IF NEW.deleted_at IS NOT NULL OR NEW.delete_request_id IS NOT NULL OR NEW.admin_delete_audit_id IS NOT NULL OR NEW.publication_transaction<>pg_current_xact_id() THEN
   RAISE EXCEPTION 'Invalid reply publication' USING ERRCODE='23514';END IF;
  IF NEW.reply_to_id IS NOT NULL THEN
   SELECT * INTO p FROM whaleu_ratings.replies WHERE id=NEW.reply_to_id AND root_id=NEW.root_id AND target_id=NEW.target_id FOR SHARE NOWAIT;
   IF p.id IS NULL OR p.deleted_at IS NOT NULL OR p.ordinal>=NEW.ordinal THEN RAISE EXCEPTION 'Invalid direct reply ancestry' USING ERRCODE='23514';END IF;
  END IF;
  NEW.created_at:=clock_timestamp();op:='create_reply';key:=NEW.request_id;
 END IF;
 SELECT * INTO command FROM whaleu_ratings.requests WHERE account_id=NEW.account_id AND request_id=key FOR UPDATE NOWAIT;
 IF command.operation IS DISTINCT FROM op OR command.receipt IS NOT NULL THEN RAISE EXCEPTION 'Invalid reply command' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION whaleu_ratings.record_comment_transition() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO whaleu_ratings.comment_transitions(id,comment_id,target_id,account_id,request_id,operation,revision,occurred_at,admin_delete_audit_id)
 VALUES(gen_random_uuid(),NEW.id,NEW.target_id,NEW.account_id,CASE WHEN TG_OP='INSERT' THEN NEW.request_id ELSE NEW.delete_request_id END,
  CASE WHEN TG_OP='INSERT' THEN 'create_comment' ELSE 'delete_comment' END,NEW.revision,coalesce(NEW.deleted_at,NEW.created_at),NEW.admin_delete_audit_id);
 RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION whaleu_ratings.record_reply_transition() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO whaleu_ratings.reply_transitions(id,reply_id,root_id,target_id,account_id,request_id,operation,revision,occurred_at,admin_delete_audit_id)
 VALUES(gen_random_uuid(),NEW.id,NEW.root_id,NEW.target_id,NEW.account_id,CASE WHEN TG_OP='INSERT' THEN NEW.request_id ELSE NEW.delete_request_id END,
  CASE WHEN TG_OP='INSERT' THEN 'create_reply' ELSE 'delete_reply' END,NEW.revision,CASE WHEN TG_OP='INSERT' THEN NEW.created_at ELSE NEW.deleted_at END,NEW.admin_delete_audit_id);
 RETURN NULL;
END $$;

-- The row's author remains account_id even when the actor is an administrator.
CREATE OR REPLACE FUNCTION whaleu_ratings.comment_transition_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r whaleu_ratings.comments;q whaleu_ratings.requests;a whaleu_ratings.admin_delete_audits;
BEGIN
 SELECT * INTO r FROM whaleu_ratings.comments WHERE id=NEW.comment_id;
 IF pg_trigger_depth()<2 OR r.id IS NULL OR NEW.mutation_transaction<>pg_current_xact_id()
  OR (NEW.comment_id,NEW.target_id,NEW.account_id,NEW.revision) IS DISTINCT FROM (r.id,r.target_id,r.account_id,r.revision) THEN
  RAISE EXCEPTION 'Comment transition source mismatch' USING ERRCODE='23514';END IF;
 IF NEW.admin_delete_audit_id IS NOT NULL THEN
  SELECT * INTO a FROM whaleu_ratings.admin_delete_audits WHERE id=NEW.admin_delete_audit_id;
  SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=a.actor_account_id AND request_id=a.request_id FOR UPDATE NOWAIT;
  IF NEW.operation<>'delete_comment' OR NEW.request_id IS NOT NULL OR r.delete_request_id IS NOT NULL OR a.id IS NULL OR a.outcome<>'applied'
   OR a.mutation_transaction<>pg_current_xact_id() OR q.operation IS DISTINCT FROM 'admin_delete_comment' OR q.receipt IS NOT NULL OR q.intent_hash IS DISTINCT FROM a.intent_hash
   OR (a.subject_kind,a.target_id,a.root_id,a.subject_id,a.author_account_id,a.after_revision,a.occurred_at,a.id)
    IS DISTINCT FROM ('comment'::text,r.target_id,r.id,r.id,r.account_id,r.revision,r.deleted_at,r.admin_delete_audit_id)
   OR NEW.occurred_at IS DISTINCT FROM r.deleted_at THEN
   RAISE EXCEPTION 'Administrator comment transition source mismatch' USING ERRCODE='23514';END IF;
 ELSE
  SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=NEW.account_id AND request_id=NEW.request_id FOR UPDATE NOWAIT;
  IF q.operation IS DISTINCT FROM NEW.operation OR q.receipt IS NOT NULL OR r.admin_delete_audit_id IS NOT NULL
   OR (NEW.operation='create_comment' AND (r.publication_transaction<>pg_current_xact_id() OR r.deleted_at IS NOT NULL OR (NEW.request_id,NEW.occurred_at) IS DISTINCT FROM (r.request_id,r.created_at)))
   OR (NEW.operation='delete_comment' AND (r.deleted_at IS NULL OR (NEW.request_id,NEW.occurred_at) IS DISTINCT FROM (r.delete_request_id,r.deleted_at))) THEN
   RAISE EXCEPTION 'Comment transition source mismatch' USING ERRCODE='23514';END IF;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER rating_comment_transition_source BEFORE INSERT ON whaleu_ratings.comment_transitions FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.comment_transition_source();

-- The row's author remains account_id even when the actor is an administrator.
CREATE OR REPLACE FUNCTION whaleu_ratings.reply_transition_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r whaleu_ratings.replies;q whaleu_ratings.requests;a whaleu_ratings.admin_delete_audits;
BEGIN
 SELECT * INTO r FROM whaleu_ratings.replies WHERE id=NEW.reply_id;
 IF pg_trigger_depth()<2 OR r.id IS NULL OR NEW.mutation_transaction<>pg_current_xact_id()
  OR (NEW.reply_id,NEW.root_id,NEW.target_id,NEW.account_id,NEW.revision) IS DISTINCT FROM (r.id,r.root_id,r.target_id,r.account_id,r.revision) THEN
  RAISE EXCEPTION 'Reply transition source mismatch' USING ERRCODE='23514';END IF;
 IF NEW.admin_delete_audit_id IS NOT NULL THEN
  SELECT * INTO a FROM whaleu_ratings.admin_delete_audits WHERE id=NEW.admin_delete_audit_id;
  SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=a.actor_account_id AND request_id=a.request_id FOR UPDATE NOWAIT;
  IF NEW.operation<>'delete_reply' OR NEW.request_id IS NOT NULL OR r.delete_request_id IS NOT NULL OR a.id IS NULL OR a.outcome<>'applied'
   OR a.mutation_transaction<>pg_current_xact_id() OR q.operation IS DISTINCT FROM 'admin_delete_reply' OR q.receipt IS NOT NULL OR q.intent_hash IS DISTINCT FROM a.intent_hash
   OR (a.subject_kind,a.target_id,a.root_id,a.subject_id,a.author_account_id,a.after_revision,a.occurred_at,a.id)
    IS DISTINCT FROM ('reply'::text,r.target_id,r.root_id,r.id,r.account_id,r.revision,r.deleted_at,r.admin_delete_audit_id)
   OR NEW.occurred_at IS DISTINCT FROM r.deleted_at THEN
   RAISE EXCEPTION 'Administrator reply transition source mismatch' USING ERRCODE='23514';END IF;
 ELSE
  SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=NEW.account_id AND request_id=NEW.request_id FOR UPDATE NOWAIT;
  IF q.operation IS DISTINCT FROM NEW.operation OR q.receipt IS NOT NULL OR r.admin_delete_audit_id IS NOT NULL
   OR (NEW.operation='create_reply' AND (r.publication_transaction<>pg_current_xact_id() OR r.deleted_at IS NOT NULL OR (NEW.request_id,NEW.occurred_at) IS DISTINCT FROM (r.request_id,r.created_at)))
   OR (NEW.operation='delete_reply' AND (r.deleted_at IS NULL OR (NEW.request_id,NEW.occurred_at) IS DISTINCT FROM (r.delete_request_id,r.deleted_at))) THEN
   RAISE EXCEPTION 'Reply transition source mismatch' USING ERRCODE='23514';END IF;
 END IF;RETURN NEW;
END $$;

ALTER TABLE whaleu_ratings.effect_events ADD COLUMN admin_delete_audit_id uuid UNIQUE REFERENCES whaleu_ratings.admin_delete_audits(id);
ALTER TABLE whaleu_ratings.effect_events DROP CONSTRAINT rating_effect_typed_version;
ALTER TABLE whaleu_ratings.effect_events ADD CONSTRAINT rating_effect_typed_version CHECK(
 (source_version=1 AND admin_delete_audit_id IS NULL AND rule_version='rating-effects-v1' AND event_kind IN ('root_created','reply_created','root_deleted','reply_deleted')
  AND root_id IS NOT NULL AND root_author_id IS NOT NULL AND author_mode IS NOT NULL
  AND subscription_transition_id IS NULL AND like_transition_id IS NULL AND subject_author_id IS NULL AND subject_author_mode IS NULL
  AND (comment_transition_id IS NULL)<>(reply_transition_id IS NULL)
  AND (event_kind LIKE 'root_%')=(comment_transition_id IS NOT NULL)
  AND (reply_id IS NULL)=(comment_transition_id IS NOT NULL)
  AND (reply_to_id IS NULL)=(direct_reply_author_id IS NULL) AND (reply_id IS NOT NULL OR reply_to_id IS NULL))
 OR (source_version=2 AND admin_delete_audit_id IS NULL AND rule_version='rating-likes-v1' AND event_kind IN ('content_liked','content_unliked')
  AND root_id IS NOT NULL AND root_author_id IS NOT NULL AND author_mode IS NOT NULL
  AND subscription_transition_id IS NULL AND like_transition_id IS NOT NULL AND subject_author_id IS NOT NULL AND subject_author_mode IS NOT NULL
  AND comment_transition_id IS NULL AND reply_transition_id IS NULL AND reply_to_id IS NULL AND direct_reply_author_id IS NULL AND author_mode='named')
 OR (source_version=3 AND admin_delete_audit_id IS NULL AND rule_version='rating-subscriptions-v1' AND event_kind IN ('target_subscribed','target_unsubscribed')
  AND subscription_transition_id IS NOT NULL AND root_id IS NULL AND root_author_id IS NULL AND author_mode IS NULL
  AND reply_id IS NULL AND reply_to_id IS NULL AND direct_reply_author_id IS NULL
  AND comment_transition_id IS NULL AND reply_transition_id IS NULL
  AND like_transition_id IS NULL AND subject_author_id IS NULL AND subject_author_mode IS NULL
  AND expected_experience_units=CASE WHEN event_kind='target_subscribed' THEN 1 ELSE 0 END
  AND expected_direct_notice_obligations=0)
 OR (source_version=4 AND rule_version='rating-admin-delete-v1' AND event_kind IN ('root_deleted','reply_deleted')
  AND admin_delete_audit_id IS NOT NULL AND root_id IS NOT NULL AND root_author_id IS NOT NULL AND author_mode IS NOT NULL
  AND subject_author_id IS NOT NULL AND subject_author_mode IS NOT NULL
  AND subscription_transition_id IS NULL AND like_transition_id IS NULL
  AND (comment_transition_id IS NULL)<>(reply_transition_id IS NULL)
  AND (event_kind='root_deleted')=(comment_transition_id IS NOT NULL)
  AND (reply_id IS NULL)=(comment_transition_id IS NOT NULL)
  AND (reply_to_id IS NULL)=(direct_reply_author_id IS NULL) AND (reply_id IS NOT NULL OR reply_to_id IS NULL)
  AND expected_experience_units=0 AND expected_direct_notice_obligations=0)
);
CREATE FUNCTION whaleu_ratings.admin_delete_effect_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a whaleu_ratings.admin_delete_audits;ct whaleu_ratings.comment_transitions;rt whaleu_ratings.reply_transitions;
 root whaleu_ratings.comments;reply whaleu_ratings.replies;direct whaleu_ratings.replies;t whaleu_ratings.targets;q whaleu_ratings.requests;
 subject_author uuid;mode text;
BEGIN
 SELECT * INTO a FROM whaleu_ratings.admin_delete_audits WHERE id=NEW.admin_delete_audit_id;
 SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=a.actor_account_id AND request_id=a.request_id FOR UPDATE NOWAIT;
 SELECT * INTO t FROM whaleu_ratings.targets WHERE id=a.target_id;
 SELECT * INTO root FROM whaleu_ratings.comments WHERE id=a.root_id AND target_id=a.target_id;
 IF a.subject_kind='comment' THEN
  SELECT * INTO ct FROM whaleu_ratings.comment_transitions WHERE id=NEW.comment_transition_id;
  subject_author:=root.account_id;mode:=root.author_mode;
  IF ct.id IS NULL OR ct.operation<>'delete_comment' OR ct.request_id IS NOT NULL
   OR (ct.admin_delete_audit_id,ct.comment_id,ct.target_id,ct.account_id,ct.revision,ct.occurred_at,ct.mutation_transaction)
    IS DISTINCT FROM (a.id,a.subject_id,a.target_id,a.author_account_id,a.after_revision,a.occurred_at,a.mutation_transaction)
   OR (root.admin_delete_audit_id,root.revision,root.deleted_at) IS DISTINCT FROM (a.id,a.after_revision,a.occurred_at)
   OR root.delete_request_id IS NOT NULL THEN RAISE EXCEPTION 'Administrator root effect transition mismatch' USING ERRCODE='23514';END IF;
 ELSE
  SELECT * INTO rt FROM whaleu_ratings.reply_transitions WHERE id=NEW.reply_transition_id;
  SELECT * INTO reply FROM whaleu_ratings.replies WHERE id=a.subject_id AND root_id=a.root_id AND target_id=a.target_id;
  SELECT * INTO direct FROM whaleu_ratings.replies WHERE id=reply.reply_to_id;
  subject_author:=reply.account_id;mode:=reply.author_mode;
  IF rt.id IS NULL OR rt.operation<>'delete_reply' OR rt.request_id IS NOT NULL
   OR (rt.admin_delete_audit_id,rt.reply_id,rt.root_id,rt.target_id,rt.account_id,rt.revision,rt.occurred_at,rt.mutation_transaction)
    IS DISTINCT FROM (a.id,a.subject_id,a.root_id,a.target_id,a.author_account_id,a.after_revision,a.occurred_at,a.mutation_transaction)
   OR (reply.admin_delete_audit_id,reply.revision,reply.deleted_at) IS DISTINCT FROM (a.id,a.after_revision,a.occurred_at)
   OR reply.delete_request_id IS NOT NULL THEN RAISE EXCEPTION 'Administrator reply effect transition mismatch' USING ERRCODE='23514';END IF;
 END IF;
 IF pg_trigger_depth()<2 OR a.id IS NULL OR a.outcome<>'applied' OR a.mutation_transaction<>pg_current_xact_id()
  OR q.operation IS DISTINCT FROM 'admin_delete_'||a.subject_kind OR q.receipt IS NOT NULL OR q.intent_hash IS DISTINCT FROM a.intent_hash
  OR (NEW.event_kind,NEW.target_id,NEW.root_id,NEW.reply_id,NEW.reply_to_id,NEW.actor_account_id,NEW.author_mode,
   NEW.root_author_id,NEW.direct_reply_author_id,NEW.region_id,NEW.request_id,NEW.occurred_at,NEW.mutation_transaction,
   NEW.subject_author_id,NEW.subject_author_mode)
  IS DISTINCT FROM (CASE a.subject_kind WHEN 'comment' THEN 'root_deleted' ELSE 'reply_deleted' END,
   a.target_id,a.root_id,reply.id,reply.reply_to_id,a.actor_account_id,mode,root.account_id,direct.account_id,t.region_id,
   a.request_id,a.occurred_at,a.mutation_transaction,subject_author,mode) THEN
  RAISE EXCEPTION 'Administrator deletion effect exact source mismatch' USING ERRCODE='23514';END IF;
 NEW.expected_experience_units:=0;NEW.expected_direct_notice_obligations:=0;RETURN NEW;
END $$;
CREATE TRIGGER rating_admin_delete_effect_guard BEFORE INSERT ON whaleu_ratings.effect_events
 FOR EACH ROW WHEN(NEW.source_version=4) EXECUTE FUNCTION whaleu_ratings.admin_delete_effect_guard();

-- The existing owner/publication branch is unchanged.
CREATE OR REPLACE FUNCTION whaleu_ratings.record_effect() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE audit whaleu_ratings.admin_delete_audits;root whaleu_ratings.comments;reply whaleu_ratings.replies;direct whaleu_ratings.replies;t whaleu_ratings.targets;event uuid:=gen_random_uuid();is_root boolean:=TG_TABLE_NAME='comment_transitions';
BEGIN
 SELECT * INTO t FROM whaleu_ratings.targets WHERE id=NEW.target_id;
 IF is_root THEN SELECT * INTO root FROM whaleu_ratings.comments WHERE id=NEW.comment_id;
 ELSE SELECT * INTO reply FROM whaleu_ratings.replies WHERE id=NEW.reply_id;SELECT * INTO root FROM whaleu_ratings.comments WHERE id=NEW.root_id;SELECT * INTO direct FROM whaleu_ratings.replies WHERE id=reply.reply_to_id;END IF;

 IF NEW.admin_delete_audit_id IS NOT NULL THEN
  SELECT * INTO audit FROM whaleu_ratings.admin_delete_audits WHERE id=NEW.admin_delete_audit_id;
  INSERT INTO whaleu_ratings.effect_events(id,source_version,rule_version,event_kind,target_id,root_id,reply_id,reply_to_id,
   actor_account_id,author_mode,root_author_id,direct_reply_author_id,region_id,comment_transition_id,reply_transition_id,
   request_id,occurred_at,mutation_transaction,expected_experience_units,expected_direct_notice_obligations,
   admin_delete_audit_id,subject_author_id,subject_author_mode)
  VALUES(event,4,'rating-admin-delete-v1',CASE WHEN is_root THEN 'root_deleted' ELSE 'reply_deleted' END,
   NEW.target_id,root.id,reply.id,reply.reply_to_id,audit.actor_account_id,CASE WHEN is_root THEN root.author_mode ELSE reply.author_mode END,
   root.account_id,direct.account_id,t.region_id,CASE WHEN is_root THEN NEW.id END,CASE WHEN NOT is_root THEN NEW.id END,
   audit.request_id,NEW.occurred_at,NEW.mutation_transaction,0,0,audit.id,NEW.account_id,
   CASE WHEN is_root THEN root.author_mode ELSE reply.author_mode END);
  RETURN NULL;
 END IF;
 INSERT INTO whaleu_ratings.effect_events(id,event_kind,target_id,root_id,reply_id,reply_to_id,actor_account_id,author_mode,root_author_id,direct_reply_author_id,region_id,comment_transition_id,reply_transition_id,request_id,occurred_at,mutation_transaction,expected_experience_units,expected_direct_notice_obligations)
 VALUES(event,CASE NEW.operation WHEN 'create_comment' THEN 'root_created' WHEN 'delete_comment' THEN 'root_deleted' WHEN 'create_reply' THEN 'reply_created' ELSE 'reply_deleted' END,NEW.target_id,root.id,reply.id,reply.reply_to_id,NEW.account_id,CASE WHEN is_root THEN root.author_mode ELSE reply.author_mode END,root.account_id,direct.account_id,t.region_id,CASE WHEN is_root THEN NEW.id END,CASE WHEN NOT is_root THEN NEW.id END,NEW.request_id,NEW.occurred_at,NEW.mutation_transaction,0,0);
 INSERT INTO whaleu_ratings.notice_obligations(event_id,recipient_account_id,reason,region_id,target_id,root_id,reply_id,source_transaction)
 SELECT event,n.recipient_account_id,n.reason,t.region_id,t.id,root.id,reply.id,NEW.mutation_transaction FROM whaleu_ratings.expected_direct_notices(event) n;
 RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION whaleu_ratings.transition_effect_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actor uuid:=NEW.account_id;request uuid:=NEW.request_id;version integer:=1;a whaleu_ratings.admin_delete_audits;
BEGIN
 IF NEW.admin_delete_audit_id IS NOT NULL THEN
  SELECT * INTO a FROM whaleu_ratings.admin_delete_audits WHERE id=NEW.admin_delete_audit_id;
  IF a.id IS NULL OR a.outcome<>'applied' OR a.mutation_transaction<>NEW.mutation_transaction THEN RAISE EXCEPTION 'Administrator transition audit missing' USING ERRCODE='23514';END IF;
  actor:=a.actor_account_id;request:=a.request_id;version:=4;
 END IF;
 IF TG_TABLE_NAME='comment_transitions' THEN
 IF NOT EXISTS(SELECT 1 FROM whaleu_ratings.effect_events e WHERE e.comment_transition_id=NEW.id AND e.source_version=version AND e.admin_delete_audit_id IS NOT DISTINCT FROM NEW.admin_delete_audit_id AND (e.actor_account_id,e.request_id,e.target_id,e.root_id,e.occurred_at,e.mutation_transaction)=(actor,request,NEW.target_id,NEW.comment_id,NEW.occurred_at,NEW.mutation_transaction)) THEN RAISE EXCEPTION 'Root transition effect missing' USING ERRCODE='23514';END IF;
 ELSE
 IF NOT EXISTS(SELECT 1 FROM whaleu_ratings.effect_events e WHERE e.reply_transition_id=NEW.id AND e.source_version=version AND e.admin_delete_audit_id IS NOT DISTINCT FROM NEW.admin_delete_audit_id AND (e.actor_account_id,e.request_id,e.target_id,e.root_id,e.reply_id,e.occurred_at,e.mutation_transaction)=(actor,request,NEW.target_id,NEW.root_id,NEW.reply_id,NEW.occurred_at,NEW.mutation_transaction)) THEN RAISE EXCEPTION 'Reply transition effect missing' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT 1 FROM whaleu_ratings.reply_heads h WHERE h.root_id=NEW.root_id AND h.target_id=NEW.target_id AND h.sequence>=NEW.sequence AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.reply_transitions later WHERE later.root_id=h.root_id AND later.sequence>h.sequence)) THEN RAISE EXCEPTION 'Reply continuation head incomplete' USING ERRCODE='23514';END IF;
 END IF;RETURN NULL;
END $$;

-- One shared account/request namespace; old receipts and owner hashes are intact.
-- Owner noop lookup already keys the transition by its immutable subject author,
-- subject and revision, so it accepts an admin cause without claiming its actor.
DROP TRIGGER rating_request_causal ON whaleu_ratings.requests;
CREATE CONSTRAINT TRIGGER rating_request_causal AFTER INSERT OR UPDATE ON whaleu_ratings.requests
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 WHEN(NEW.operation NOT IN ('set_comment_like','set_reply_like','set_target_subscription','admin_delete_comment','admin_delete_reply'))
 EXECUTE FUNCTION whaleu_ratings.request_causal();
CREATE FUNCTION whaleu_ratings.verify_admin_delete_request(actor uuid,request uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE q whaleu_ratings.requests;a whaleu_ratings.admin_delete_audits;ct whaleu_ratings.comment_transitions;
 rt whaleu_ratings.reply_transitions;e whaleu_ratings.effect_events;c whaleu_ratings.comments;r whaleu_ratings.replies;
 keys text[];instant timestamptz;n integer;
BEGIN
 SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=actor AND request_id=request;
 SELECT * INTO a FROM whaleu_ratings.admin_delete_audits WHERE actor_account_id=actor AND request_id=request;
 IF q.receipt IS NULL OR NOT coalesce(q.receipt->>'requestId'=q.request_id::text AND q.receipt->>'operation'=q.operation,false)
  OR q.operation NOT IN ('admin_delete_comment','admin_delete_reply') THEN
  RAISE EXCEPTION 'Missing administrator deletion receipt' USING ERRCODE='23514';END IF;
 SELECT array_agg(k ORDER BY k) INTO keys FROM jsonb_object_keys(q.receipt) k;
 IF q.receipt->>'outcome'='rejected' THEN
  IF keys IS DISTINCT FROM ARRAY['code','operation','outcome','requestId'] OR a.id IS NOT NULL
   OR NOT coalesce(q.receipt->>'code' IN ('RATING_NOT_FOUND','RATING_REVISION_CONFLICT','PHONE_VERIFICATION_REQUIRED','SAFETY_ACTION_RESTRICTED'),false)
   OR EXISTS(SELECT 1 FROM whaleu_ratings.effect_events WHERE actor_account_id=actor AND request_id=request)
   OR EXISTS(SELECT 1 FROM whaleu_ratings.comment_transitions WHERE account_id=actor AND request_id=request)
   OR EXISTS(SELECT 1 FROM whaleu_ratings.reply_transitions WHERE account_id=actor AND request_id=request) THEN
   RAISE EXCEPTION 'Invalid administrator rejected receipt' USING ERRCODE='23514';END IF;
  RETURN;
 END IF;
 IF keys IS DISTINCT FROM ARRAY['occurredAt','operation','outcome','requestId','revision','rootId','subjectId','targetId']
  OR NOT coalesce(q.receipt->>'outcome' IN ('applied','noop'),false)
  OR NOT coalesce(q.receipt->>'occurredAt' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$',false)
  OR a.id IS NULL OR a.mutation_transaction<>pg_current_xact_id() OR a.intent_hash IS DISTINCT FROM q.intent_hash THEN
  RAISE EXCEPTION 'Invalid administrator success receipt' USING ERRCODE='23514';END IF;
 instant:=(q.receipt->>'occurredAt')::timestamptz;
 IF (q.operation,q.receipt->>'outcome',q.receipt->>'targetId',q.receipt->>'rootId',q.receipt->>'subjectId',q.receipt->>'revision',instant)
  IS DISTINCT FROM ('admin_delete_'||a.subject_kind,a.outcome,a.target_id::text,a.root_id::text,a.subject_id::text,a.after_revision::text,a.occurred_at) THEN
  RAISE EXCEPTION 'Administrator receipt audit mismatch' USING ERRCODE='23514';END IF;
 SELECT * INTO ct FROM whaleu_ratings.comment_transitions WHERE admin_delete_audit_id=a.id;
 SELECT * INTO rt FROM whaleu_ratings.reply_transitions WHERE admin_delete_audit_id=a.id;
 SELECT * INTO e FROM whaleu_ratings.effect_events WHERE actor_account_id=actor AND request_id=request;
 n:=(ct.id IS NOT NULL)::integer+(rt.id IS NOT NULL)::integer;
 IF a.outcome='noop' THEN
  IF n<>0 OR e.id IS NOT NULL OR EXISTS(SELECT 1 FROM whaleu_ratings.comments WHERE admin_delete_audit_id=a.id)
   OR EXISTS(SELECT 1 FROM whaleu_ratings.replies WHERE admin_delete_audit_id=a.id) THEN
   RAISE EXCEPTION 'Administrator noop cannot create a lifecycle effect' USING ERRCODE='23514';END IF;
  IF a.subject_kind='comment' THEN SELECT * INTO ct FROM whaleu_ratings.comment_transitions WHERE id=a.effective_comment_transition_id;
  ELSE SELECT * INTO rt FROM whaleu_ratings.reply_transitions WHERE id=a.effective_reply_transition_id;END IF;
 ELSE
  IF n<>1 OR e.id IS NULL OR e.source_version<>4 OR e.rule_version<>'rating-admin-delete-v1'
   OR (e.admin_delete_audit_id,e.target_id,e.root_id,e.occurred_at,e.mutation_transaction,e.subject_author_id)
    IS DISTINCT FROM (a.id,a.target_id,a.root_id,a.occurred_at,a.mutation_transaction,a.author_account_id)
   OR e.expected_experience_units<>0 OR e.expected_direct_notice_obligations<>0
   OR EXISTS(SELECT 1 FROM whaleu_ratings.subscription_fanout_sources WHERE event_id=e.id)
   OR EXISTS(SELECT 1 FROM whaleu_ratings.reward_groups WHERE event_id=e.id)
   OR EXISTS(SELECT 1 FROM whaleu_ratings.notice_obligations WHERE event_id=e.id) THEN
   RAISE EXCEPTION 'Administrator applied deletion is incomplete' USING ERRCODE='23514';END IF;
 END IF;
 IF a.subject_kind='comment' THEN
  SELECT * INTO c FROM whaleu_ratings.comments WHERE id=a.subject_id AND target_id=a.target_id;
  IF ct.operation IS DISTINCT FROM 'delete_comment'
   OR (ct.comment_id,ct.target_id,ct.account_id,ct.revision,ct.occurred_at) IS DISTINCT FROM
    (a.subject_id,a.target_id,a.author_account_id,a.after_revision,a.occurred_at)
   OR (c.account_id,c.revision,c.deleted_at) IS DISTINCT FROM (a.author_account_id,a.after_revision,a.occurred_at)
   OR (a.outcome='applied' AND ((c.admin_delete_audit_id,ct.admin_delete_audit_id,ct.mutation_transaction,e.comment_transition_id)
    IS DISTINCT FROM (a.id,a.id,a.mutation_transaction,ct.id) OR ct.request_id IS NOT NULL)) THEN
   RAISE EXCEPTION 'Administrator root deletion causal chain mismatch' USING ERRCODE='23514';END IF;
 ELSE
  SELECT * INTO r FROM whaleu_ratings.replies WHERE id=a.subject_id AND root_id=a.root_id AND target_id=a.target_id;
  IF rt.operation IS DISTINCT FROM 'delete_reply'
   OR (rt.reply_id,rt.root_id,rt.target_id,rt.account_id,rt.revision,rt.occurred_at) IS DISTINCT FROM
    (a.subject_id,a.root_id,a.target_id,a.author_account_id,a.after_revision,a.occurred_at)
   OR (r.account_id,r.revision,r.deleted_at) IS DISTINCT FROM (a.author_account_id,a.after_revision,a.occurred_at)
   OR (a.outcome='applied' AND ((r.admin_delete_audit_id,rt.admin_delete_audit_id,rt.mutation_transaction,e.reply_transition_id)
    IS DISTINCT FROM (a.id,a.id,a.mutation_transaction,rt.id) OR rt.request_id IS NOT NULL)) THEN
   RAISE EXCEPTION 'Administrator reply deletion causal chain mismatch' USING ERRCODE='23514';END IF;
 END IF;
END $$;
CREATE FUNCTION whaleu_ratings.admin_request_causal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 PERFORM whaleu_ratings.verify_admin_delete_request(NEW.account_id,NEW.request_id);RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER rating_admin_request_causal AFTER INSERT OR UPDATE ON whaleu_ratings.requests
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.operation IN ('admin_delete_comment','admin_delete_reply'))
 EXECUTE FUNCTION whaleu_ratings.admin_request_causal();
CREATE FUNCTION whaleu_ratings.admin_delete_audit_complete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 PERFORM whaleu_ratings.verify_admin_delete_request(NEW.actor_account_id,NEW.request_id);RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER rating_admin_delete_audit_complete AFTER INSERT ON whaleu_ratings.admin_delete_audits
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.admin_delete_audit_complete();
