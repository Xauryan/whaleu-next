-- R2A text replies. Frozen prior migrations are unchanged; no historical reward inference.
ALTER TABLE whaleu_ratings.requests DROP CONSTRAINT requests_operation_check;
ALTER TABLE whaleu_ratings.requests ADD CHECK(operation IN ('set_score','create_comment','delete_comment','create_reply','delete_reply'));
ALTER TABLE whaleu_ratings.comments ADD UNIQUE(id,target_id);
CREATE TABLE whaleu_ratings.replies (
 id uuid PRIMARY KEY,target_id uuid NOT NULL REFERENCES whaleu_ratings.targets(id),root_id uuid NOT NULL,reply_to_id uuid,
 account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),author_mode text NOT NULL CHECK(author_mode IN ('named','anonymous')),persona_id uuid,
 body text NOT NULL CHECK(length(btrim(body)) BETWEEN 1 AND 500),revision uuid NOT NULL,request_id uuid NOT NULL,envelope jsonb NOT NULL CHECK(jsonb_typeof(envelope)='object'),content_version integer NOT NULL DEFAULT 1 CHECK(content_version=1),publication_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 ordinal bigint GENERATED ALWAYS AS IDENTITY UNIQUE,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),deleted_at timestamptz,delete_request_id uuid,
 UNIQUE(id,root_id,target_id),FOREIGN KEY(root_id,target_id) REFERENCES whaleu_ratings.comments(id,target_id),FOREIGN KEY(reply_to_id,root_id,target_id) REFERENCES whaleu_ratings.replies(id,root_id,target_id),
 FOREIGN KEY(target_id,account_id,persona_id) REFERENCES whaleu_ratings.personas(target_id,account_id,public_id),FOREIGN KEY(account_id,request_id) REFERENCES whaleu_ratings.requests(account_id,request_id),FOREIGN KEY(account_id,delete_request_id) REFERENCES whaleu_ratings.requests(account_id,request_id),
 CHECK((author_mode='anonymous')=(persona_id IS NOT NULL)),CHECK(reply_to_id IS DISTINCT FROM id),CHECK((deleted_at IS NULL)=(delete_request_id IS NULL)),CHECK(isfinite(created_at) AND (deleted_at IS NULL OR (isfinite(deleted_at) AND deleted_at>=created_at)))
);
CREATE INDEX rating_reply_page ON whaleu_ratings.replies(target_id,root_id,ordinal) WHERE deleted_at IS NULL;
CREATE TABLE whaleu_ratings.reply_transitions (
 id uuid PRIMARY KEY,reply_id uuid NOT NULL,root_id uuid NOT NULL,target_id uuid NOT NULL,account_id uuid NOT NULL,request_id uuid NOT NULL,operation text NOT NULL CHECK(operation IN ('create_reply','delete_reply')),revision uuid NOT NULL,
 mutation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),occurred_at timestamptz NOT NULL CHECK(isfinite(occurred_at)),sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
 UNIQUE(account_id,request_id),UNIQUE(reply_id,revision),FOREIGN KEY(reply_id,root_id,target_id) REFERENCES whaleu_ratings.replies(id,root_id,target_id),FOREIGN KEY(account_id,request_id) REFERENCES whaleu_ratings.requests(account_id,request_id)
);
CREATE FUNCTION whaleu_ratings.reply_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE command whaleu_ratings.requests;op text;key uuid;t whaleu_ratings.targets;r whaleu_ratings.comments;p whaleu_ratings.replies;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Reply tombstone is durable' USING ERRCODE='23514';END IF;
 -- Raw UPDATE may already own the child row. Never wait while reversing the parent-first application order.
 SELECT * INTO t FROM whaleu_ratings.targets WHERE id=NEW.target_id FOR UPDATE NOWAIT;
 SELECT * INTO r FROM whaleu_ratings.comments WHERE id=NEW.root_id AND target_id=NEW.target_id FOR UPDATE NOWAIT;
 IF t.active IS DISTINCT FROM true OR r.id IS NULL OR r.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'Reply parent unavailable' USING ERRCODE='23514';END IF;
 IF TG_OP='UPDATE' THEN
 IF (to_jsonb(NEW)-ARRAY['deleted_at','delete_request_id','revision']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['deleted_at','delete_request_id','revision']) OR OLD.deleted_at IS NOT NULL OR NEW.deleted_at IS NULL OR NEW.delete_request_id IS NULL OR NEW.revision=OLD.revision THEN RAISE EXCEPTION 'Invalid reply deletion' USING ERRCODE='23514';END IF;
 NEW.deleted_at:=clock_timestamp();op:='delete_reply';key:=NEW.delete_request_id;
 ELSE
 IF NEW.deleted_at IS NOT NULL OR NEW.publication_transaction<>pg_current_xact_id() THEN RAISE EXCEPTION 'Invalid reply publication' USING ERRCODE='23514';END IF;
 IF NEW.reply_to_id IS NOT NULL THEN
 SELECT * INTO p FROM whaleu_ratings.replies WHERE id=NEW.reply_to_id AND root_id=NEW.root_id AND target_id=NEW.target_id FOR SHARE NOWAIT;
 IF p.id IS NULL OR p.deleted_at IS NOT NULL OR p.ordinal>=NEW.ordinal THEN RAISE EXCEPTION 'Invalid direct reply ancestry' USING ERRCODE='23514';END IF;END IF;
 NEW.created_at:=clock_timestamp();op:='create_reply';key:=NEW.request_id;
 END IF;
 SELECT * INTO command FROM whaleu_ratings.requests WHERE account_id=NEW.account_id AND request_id=key FOR UPDATE NOWAIT;
 IF command.operation IS DISTINCT FROM op OR command.receipt IS NOT NULL THEN RAISE EXCEPTION 'Invalid reply command' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER rating_reply_change BEFORE INSERT OR UPDATE OR DELETE ON whaleu_ratings.replies FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.reply_change();
CREATE FUNCTION whaleu_ratings.record_reply_transition() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO whaleu_ratings.reply_transitions(id,reply_id,root_id,target_id,account_id,request_id,operation,revision,occurred_at) VALUES(gen_random_uuid(),NEW.id,NEW.root_id,NEW.target_id,NEW.account_id,CASE WHEN TG_OP='INSERT' THEN NEW.request_id ELSE NEW.delete_request_id END,CASE WHEN TG_OP='INSERT' THEN 'create_reply' ELSE 'delete_reply' END,NEW.revision,CASE WHEN TG_OP='INSERT' THEN NEW.created_at ELSE NEW.deleted_at END);RETURN NULL;
END $$;
CREATE TRIGGER rating_reply_event AFTER INSERT OR UPDATE ON whaleu_ratings.replies FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.record_reply_transition();
CREATE TRIGGER rating_reply_transition_causal BEFORE INSERT ON whaleu_ratings.reply_transitions FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.nested_insert();
CREATE FUNCTION whaleu_ratings.root_parent_lock() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 PERFORM id FROM whaleu_ratings.targets WHERE id=NEW.target_id AND active FOR UPDATE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'Root parent unavailable' USING ERRCODE='23514';END IF;
 IF TG_OP='INSERT' THEN NEW.created_at:=clock_timestamp();ELSE NEW.deleted_at:=clock_timestamp();END IF;RETURN NEW;
END $$;
CREATE TRIGGER a0_rating_root_parent BEFORE INSERT OR UPDATE ON whaleu_ratings.comments FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.root_parent_lock();
CREATE OR REPLACE FUNCTION whaleu_ratings.request_causal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r whaleu_ratings.requests;s whaleu_ratings.score_transitions;c whaleu_ratings.comment_transitions;p whaleu_ratings.reply_transitions;n integer;keys text[];time timestamptz;
BEGIN
 SELECT * INTO r FROM whaleu_ratings.requests WHERE account_id=NEW.account_id AND request_id=NEW.request_id;
 IF r.receipt IS NULL OR NOT coalesce(r.receipt->>'requestId'=r.request_id::text AND r.receipt->>'operation'=r.operation,false) THEN RAISE EXCEPTION 'Missing canonical receipt' USING ERRCODE='23514';END IF;
 SELECT array_agg(k ORDER BY k) INTO keys FROM jsonb_object_keys(r.receipt) k;
 SELECT * INTO s FROM whaleu_ratings.score_transitions WHERE account_id=r.account_id AND request_id=r.request_id;
 SELECT * INTO c FROM whaleu_ratings.comment_transitions WHERE account_id=r.account_id AND request_id=r.request_id;SELECT * INTO p FROM whaleu_ratings.reply_transitions WHERE account_id=r.account_id AND request_id=r.request_id;n:=(s.id IS NOT NULL)::integer+(c.id IS NOT NULL)::integer+(p.id IS NOT NULL)::integer;
 IF r.receipt->>'outcome'='rejected' THEN
 IF keys IS DISTINCT FROM ARRAY['code','operation','outcome','requestId'] OR n<>0 OR NOT coalesce(r.receipt->>'code' IN ('RATING_NOT_FOUND','RATING_REVISION_CONFLICT','PHONE_VERIFICATION_REQUIRED','AFFILIATION_VERIFICATION_REQUIRED','IDENTITY_CAMPUS_REQUIRED','SAFETY_ACTION_RESTRICTED','CONTENT_REJECTED'),false) THEN RAISE EXCEPTION 'Invalid rejected receipt' USING ERRCODE='23514';END IF;RETURN NULL;
 END IF;
 IF r.operation IN ('create_reply','delete_reply') THEN
 IF keys IS DISTINCT FROM ARRAY['occurredAt','operation','outcome','replyId','requestId','revision','rootId','targetId'] OR NOT coalesce(r.receipt->>'outcome' IN ('applied','noop'),false) OR NOT coalesce(r.receipt->>'occurredAt' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$',false) THEN RAISE EXCEPTION 'Invalid reply receipt' USING ERRCODE='23514';END IF;
 time:=(r.receipt->>'occurredAt')::timestamptz;
 IF r.receipt->>'outcome'='noop' THEN
 IF n<>0 OR r.operation<>'delete_reply' THEN RAISE EXCEPTION 'Invalid reply noop' USING ERRCODE='23514';END IF;
 SELECT * INTO p FROM whaleu_ratings.reply_transitions WHERE account_id=r.account_id AND reply_id::text=r.receipt->>'replyId' AND revision::text=r.receipt->>'revision' AND operation='delete_reply';
 ELSIF n<>1 THEN RAISE EXCEPTION 'Uncaused reply receipt' USING ERRCODE='23514';END IF;
 IF NOT coalesce(p.operation=r.operation AND p.revision::text=r.receipt->>'revision' AND p.target_id::text=r.receipt->>'targetId' AND p.root_id::text=r.receipt->>'rootId' AND p.reply_id::text=r.receipt->>'replyId' AND p.occurred_at=time,false) THEN RAISE EXCEPTION 'Reply receipt transition mismatch' USING ERRCODE='23514';END IF;RETURN NULL;
 END IF;
 IF keys IS DISTINCT FROM ARRAY['occurredAt','operation','outcome','requestId','revision','subjectId','targetId'] OR NOT coalesce(r.receipt->>'outcome' IN ('applied','noop'),false) OR NOT coalesce(r.receipt->>'occurredAt' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$',false) THEN RAISE EXCEPTION 'Invalid success receipt' USING ERRCODE='23514';END IF;
 time:=(r.receipt->>'occurredAt')::timestamptz;
 IF r.receipt->>'outcome'='noop' THEN
 IF n<>0 OR r.operation='create_comment' THEN RAISE EXCEPTION 'Invalid noop receipt' USING ERRCODE='23514';END IF;
 IF r.operation='set_score' THEN SELECT * INTO s FROM whaleu_ratings.score_transitions WHERE account_id=r.account_id AND target_id::text=r.receipt->>'targetId' AND new_revision::text=r.receipt->>'revision';
 ELSE SELECT * INTO c FROM whaleu_ratings.comment_transitions WHERE account_id=r.account_id AND comment_id::text=r.receipt->>'subjectId' AND revision::text=r.receipt->>'revision' AND operation='delete_comment';END IF;
 ELSE IF n<>1 THEN RAISE EXCEPTION 'Uncaused applied receipt' USING ERRCODE='23514';END IF;END IF;
 IF (r.operation='set_score' AND NOT coalesce(s.new_revision::text=r.receipt->>'revision' AND s.target_id::text=r.receipt->>'targetId' AND s.target_id::text=r.receipt->>'subjectId' AND s.occurred_at=time,false))
 OR (r.operation<>'set_score' AND NOT coalesce(c.revision::text=r.receipt->>'revision' AND c.target_id::text=r.receipt->>'targetId' AND c.comment_id::text=r.receipt->>'subjectId' AND c.operation=r.operation AND c.occurred_at=time,false)) THEN RAISE EXCEPTION 'Receipt transition mismatch' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
ALTER FUNCTION whaleu_community.rating_envelope_shape(jsonb,text) RENAME TO rating_envelope_shape_v1;
CREATE FUNCTION whaleu_community.rating_envelope_shape(e jsonb,op text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE WHEN op<>'publish_rating_reply' THEN whaleu_community.rating_envelope_shape_v1(e,op) ELSE coalesce(
 e->'version'='2'::jsonb AND e->>'purpose'=op AND
 whaleu_community.rating_envelope_shape_v1((e-ARRAY['rootId','rootRevision','replyTo'])||jsonb_build_object('version',1,'purpose','publish_rating_comment'),'publish_rating_comment') AND
 NOT EXISTS(SELECT 1 FROM unnest(ARRAY['rootId','rootRevision']) k WHERE jsonb_typeof(e->k) IS DISTINCT FROM 'string' OR NOT coalesce(e->>k ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',false)) AND
 (e->'replyTo'='null'::jsonb OR (jsonb_typeof(e->'replyTo')='object' AND ((e->'replyTo')-ARRAY['replyId','revision'])='{}'::jsonb AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['replyId','revision']) k WHERE jsonb_typeof(e->'replyTo'->k) IS DISTINCT FROM 'string' OR NOT coalesce(e->'replyTo'->>k ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',false)))),false) END
$$;
-- Replace only the v1 discriminant/digest checks; retain all provenance/time/FK checks.
DO $$ DECLARE c record;BEGIN
 FOR c IN SELECT conname,pg_get_constraintdef(oid) def FROM pg_constraint WHERE conrelid='whaleu_community.rating_approval_decisions'::regclass AND contype='c' LOOP
 IF c.def LIKE '%operation%' OR c.def LIKE '%envelope_version%' OR c.def LIKE '%envelope%' OR c.def LIKE '%sha256%' THEN EXECUTE format('ALTER TABLE whaleu_community.rating_approval_decisions DROP CONSTRAINT %I',c.conname);END IF;END LOOP;
 FOR c IN SELECT conname,pg_get_constraintdef(oid) def FROM pg_constraint WHERE conrelid='whaleu_community.rating_approval_bindings'::regclass AND contype='c' LOOP
 IF c.def LIKE '%operation%' OR c.def LIKE '%envelope_version%' OR c.def LIKE '%kind%' OR c.def LIKE '%rating_envelope_shape%' THEN EXECUTE format('ALTER TABLE whaleu_community.rating_approval_bindings DROP CONSTRAINT %I',c.conname);END IF;END LOOP;
END $$;
ALTER TABLE whaleu_community.rating_approval_decisions ADD CHECK((operation IN ('publish_rating_target','publish_rating_comment') AND envelope_version=1) OR (operation='publish_rating_reply' AND envelope_version=2)),ADD CHECK(whaleu_community.rating_envelope_shape(envelope,operation)),ADD CHECK(envelope->>'accountId'=account_id::text AND (envelope->>'version')::integer=envelope_version),ADD CHECK(digest=encode(sha256(convert_to('whaleu-rating-content-approval:v'||envelope_version::text||chr(10)||whaleu_community.content_canonical_json(envelope),'UTF8')),'hex'));
ALTER TABLE whaleu_community.rating_approval_bindings ADD CHECK((kind='target' AND operation='publish_rating_target' AND envelope_version=1) OR (kind='comment' AND operation='publish_rating_comment' AND envelope_version=1) OR (kind='reply' AND operation='publish_rating_reply' AND envelope_version=2)),ADD CHECK(whaleu_community.rating_envelope_shape(envelope,operation));
CREATE OR REPLACE FUNCTION whaleu_ratings.require_review_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE requested_kind text;subject uuid;definition jsonb;publication xid8;b whaleu_community.rating_approval_bindings;t whaleu_ratings.targets;c whaleu_ratings.comments;category whaleu_ratings.categories;r whaleu_ratings.replies;parent whaleu_ratings.comments;direct whaleu_ratings.replies;
BEGIN
 IF TG_TABLE_SCHEMA='whaleu_community' THEN requested_kind:=NEW.kind;subject:=NEW.subject_id;ELSE requested_kind:=CASE TG_TABLE_NAME WHEN 'targets' THEN 'target' WHEN 'replies' THEN 'reply' ELSE 'comment' END;subject:=NEW.id;END IF;
 IF requested_kind='target' THEN
 SELECT * INTO t FROM whaleu_ratings.targets WHERE id=subject;definition:=t.envelope;publication:=t.creation_transaction;
 IF NOT coalesce(t.id IS NOT NULL AND definition->>'accountId'=t.creator_id::text AND definition->>'purpose'='publish_rating_target' AND definition->>'targetId'=t.id::text AND definition->>'targetRevision'=t.revision::text AND definition->>'categoryId'=t.category_id::text AND definition->>'name'=t.name AND definition->>'description'=t.description AND (definition->'scope'->>'regionId') IS NOT DISTINCT FROM t.region_id::text,false) THEN RAISE EXCEPTION 'Target definition mismatch' USING ERRCODE='23514';END IF;
 ELSIF requested_kind='reply' THEN
 SELECT * INTO r FROM whaleu_ratings.replies WHERE id=subject;definition:=r.envelope;publication:=r.publication_transaction;
 SELECT * INTO t FROM whaleu_ratings.targets WHERE id=r.target_id;
 SELECT * INTO parent FROM whaleu_ratings.comments WHERE id=r.root_id AND target_id=r.target_id;
 IF NOT coalesce(r.id IS NOT NULL AND definition->>'accountId'=r.account_id::text AND definition->>'purpose'='publish_rating_reply' AND definition->>'targetId'=r.target_id::text AND definition->>'targetRevision'=t.revision::text AND definition->>'rootId'=r.root_id::text AND definition->>'rootRevision'=parent.revision::text AND parent.deleted_at IS NULL AND t.active AND definition->>'categoryId'=t.category_id::text AND definition->>'clientRequestId'=r.request_id::text AND definition->>'authorMode'=r.author_mode AND definition->>'body'=r.body,false) THEN RAISE EXCEPTION 'Reply definition mismatch' USING ERRCODE='23514';END IF;
 IF r.reply_to_id IS NULL THEN IF definition->'replyTo' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'Reply root binding mismatch' USING ERRCODE='23514';END IF;
 ELSE SELECT * INTO direct FROM whaleu_ratings.replies WHERE id=r.reply_to_id AND root_id=r.root_id AND target_id=r.target_id;
 IF direct.id IS NULL OR direct.deleted_at IS NOT NULL OR definition->'replyTo' IS DISTINCT FROM jsonb_build_object('replyId',direct.id,'revision',direct.revision) THEN RAISE EXCEPTION 'Reply direct binding mismatch' USING ERRCODE='23514';END IF;END IF;
 ELSE
 SELECT * INTO c FROM whaleu_ratings.comments WHERE id=subject;definition:=c.envelope;publication:=c.publication_transaction;SELECT * INTO t FROM whaleu_ratings.targets WHERE id=c.target_id;
 IF NOT coalesce(c.id IS NOT NULL AND definition->>'accountId'=c.account_id::text AND definition->>'purpose'='publish_rating_comment' AND definition->>'targetId'=c.target_id::text AND definition->>'targetRevision'=t.revision::text AND definition->>'categoryId'=t.category_id::text AND t.active AND definition->>'clientRequestId'=c.request_id::text AND definition->>'authorMode'=c.author_mode AND definition->>'body'=c.body,false) THEN RAISE EXCEPTION 'Comment definition mismatch' USING ERRCODE='23514';END IF;
 END IF;
 SELECT * INTO b FROM whaleu_community.rating_approval_bindings WHERE kind=requested_kind AND subject_id=subject;
 IF b.subject_id IS NULL OR b.envelope IS DISTINCT FROM definition OR b.publication_transaction IS DISTINCT FROM publication OR publication<>pg_current_xact_id() OR b.content_version<>1 OR definition->'assetIds' IS DISTINCT FROM '[]'::jsonb THEN RAISE EXCEPTION 'Exact same-transaction review binding required' USING ERRCODE='23514';END IF;
 SELECT * INTO category FROM whaleu_ratings.categories WHERE catalog_id=(definition->>'catalogRevision')::uuid AND id=(definition->>'categoryId')::uuid;
 IF category.id IS NULL OR category.revision::text<>definition->>'categoryRevision' THEN RAISE EXCEPTION 'Category review mismatch' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER rating_reply_review AFTER INSERT ON whaleu_ratings.replies DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.require_review_binding();
CREATE TRIGGER rating_reply_transition_immutable BEFORE UPDATE OR DELETE ON whaleu_ratings.reply_transitions FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.immutable();
CREATE TRIGGER rating_reply_transition_retain BEFORE TRUNCATE ON whaleu_ratings.reply_transitions FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.immutable();
CREATE TRIGGER rating_reply_retain BEFORE TRUNCATE ON whaleu_ratings.replies FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.immutable();

CREATE INDEX rating_reply_transition_root ON whaleu_ratings.reply_transitions(root_id,sequence DESC);
-- Trigger depth is only a supplemental guard; the source tuple is authoritative.
CREATE FUNCTION whaleu_ratings.reply_transition_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r whaleu_ratings.replies;q whaleu_ratings.requests;
BEGIN
 SELECT * INTO r FROM whaleu_ratings.replies WHERE id=NEW.reply_id;
 SELECT * INTO q FROM whaleu_ratings.requests WHERE account_id=NEW.account_id AND request_id=NEW.request_id;
 IF r.id IS NULL OR q.operation IS DISTINCT FROM NEW.operation OR q.receipt IS NOT NULL OR NEW.mutation_transaction<>pg_current_xact_id() OR (NEW.reply_id,NEW.root_id,NEW.target_id,NEW.account_id,NEW.revision) IS DISTINCT FROM (r.id,r.root_id,r.target_id,r.account_id,r.revision) OR
 (NEW.operation='create_reply' AND (r.publication_transaction<>pg_current_xact_id() OR r.deleted_at IS NOT NULL OR (NEW.request_id,NEW.occurred_at) IS DISTINCT FROM (r.request_id,r.created_at))) OR
 (NEW.operation='delete_reply' AND (r.deleted_at IS NULL OR (NEW.request_id,NEW.occurred_at) IS DISTINCT FROM (r.delete_request_id,r.deleted_at))) THEN RAISE EXCEPTION 'Reply transition source mismatch' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER rating_reply_transition_source BEFORE INSERT ON whaleu_ratings.reply_transitions FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.reply_transition_source();
-- Per-root continuation head avoids history scans even if the planner prefers a
-- global sequence index. The parent root lock serializes all child transitions.
ALTER TABLE whaleu_ratings.reply_transitions ADD UNIQUE(id,root_id,target_id,sequence);
CREATE TABLE whaleu_ratings.reply_heads (
 root_id uuid PRIMARY KEY,target_id uuid NOT NULL,transition_id uuid NOT NULL UNIQUE,sequence bigint NOT NULL,
 FOREIGN KEY(root_id,target_id) REFERENCES whaleu_ratings.comments(id,target_id),
 FOREIGN KEY(transition_id,root_id,target_id,sequence) REFERENCES whaleu_ratings.reply_transitions(id,root_id,target_id,sequence)
);
CREATE FUNCTION whaleu_ratings.reply_head_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR pg_trigger_depth()<2 THEN RAISE EXCEPTION 'Reply head is transition-owned' USING ERRCODE='23514';END IF;
 IF TG_OP='UPDATE' THEN IF (NEW.root_id,NEW.target_id) IS DISTINCT FROM (OLD.root_id,OLD.target_id) OR NEW.sequence<=OLD.sequence THEN RAISE EXCEPTION 'Reply head cannot rewind' USING ERRCODE='23514';END IF;END IF;
 IF NOT EXISTS(SELECT 1 FROM whaleu_ratings.reply_transitions r WHERE (r.id,r.root_id,r.target_id,r.sequence)=(NEW.transition_id,NEW.root_id,NEW.target_id,NEW.sequence) AND r.mutation_transaction=pg_current_xact_id()) THEN RAISE EXCEPTION 'Reply head source is not fresh' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER rating_reply_head_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_ratings.reply_heads FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.reply_head_guard();
CREATE FUNCTION whaleu_ratings.advance_reply_head() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO whaleu_ratings.reply_heads(root_id,target_id,transition_id,sequence) VALUES(NEW.root_id,NEW.target_id,NEW.id,NEW.sequence) ON CONFLICT(root_id) DO UPDATE SET transition_id=EXCLUDED.transition_id,sequence=EXCLUDED.sequence;RETURN NULL;
END $$;
CREATE TRIGGER rating_reply_head AFTER INSERT ON whaleu_ratings.reply_transitions FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.advance_reply_head();
CREATE TRIGGER rating_reply_head_retain BEFORE TRUNCATE ON whaleu_ratings.reply_heads FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.immutable();
-- SQL stores canonical text too; transport normalization is not a substitute for
-- database integrity. Existing R1 rows are not rewritten or inferred as history.
CREATE FUNCTION whaleu_ratings.canonical_text(value text,maximum integer) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT value IS NOT NULL AND length(value) BETWEEN 1 AND maximum AND value=btrim(value,E'\t\n\f\r '||chr(11)||chr(160)||chr(5760)||chr(8192)||chr(8193)||chr(8194)||chr(8195)||chr(8196)||chr(8197)||chr(8198)||chr(8199)||chr(8200)||chr(8201)||chr(8202)||chr(8232)||chr(8233)||chr(8239)||chr(8287)||chr(12288)||chr(65279)) AND value !~ U&'[\0001-\0008\000B-\001F\007F-\009F]'
$$;
ALTER TABLE whaleu_ratings.replies ADD CHECK(whaleu_ratings.canonical_text(body,500)),ADD CHECK(ordinal>0);
ALTER TABLE whaleu_ratings.comments ADD CONSTRAINT rating_root_canonical_body CHECK(whaleu_ratings.canonical_text(body,500)) NOT VALID;
ALTER TABLE whaleu_ratings.reply_transitions ADD CHECK(sequence>0);
ALTER TABLE whaleu_ratings.reply_heads ADD CHECK(sequence>0);
