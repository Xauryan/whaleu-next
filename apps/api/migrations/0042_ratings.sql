-- Empty R1 domain. No production catalog, approvals, baseline, grant or import.
CREATE SCHEMA whaleu_ratings;
CREATE FUNCTION whaleu_ratings.immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Rating record is immutable' USING ERRCODE='23514'; END $$;
CREATE FUNCTION whaleu_ratings.policy_writer() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(hashtextextended('whaleu:named-block-policy:v1',0)); RETURN NULL; END $$;
CREATE FUNCTION whaleu_ratings.nested_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF pg_trigger_depth()<2 THEN RAISE EXCEPTION 'Uncaused rating event' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;
CREATE TABLE whaleu_ratings.catalogs (
 id uuid PRIMARY KEY,region_id uuid REFERENCES whaleu_campus.operating_regions(id),
 coverage text NOT NULL CHECK(coverage IN ('complete','missing','conflicting')),provenance text NOT NULL CHECK(provenance IN ('accepted','unknown','conflicting')),
 source_reference text NOT NULL CHECK(length(btrim(source_reference))>0),policy_reference text NOT NULL CHECK(length(btrim(policy_reference))>0),
 effective_at timestamptz NOT NULL CHECK(isfinite(effective_at)),valid_until timestamptz CHECK(valid_until IS NULL OR (isfinite(valid_until) AND valid_until>effective_at)),sealed boolean NOT NULL DEFAULT false,
 UNIQUE NULLS NOT DISTINCT(id,region_id)
);
CREATE TABLE whaleu_ratings.catalog_heads (
 scope_key text PRIMARY KEY,region_id uuid REFERENCES whaleu_campus.operating_regions(id),catalog_id uuid NOT NULL REFERENCES whaleu_ratings.catalogs(id),
 CHECK(scope_key=coalesce(region_id::text,'global')),FOREIGN KEY(catalog_id,region_id) REFERENCES whaleu_ratings.catalogs(id,region_id)
);
CREATE TABLE whaleu_ratings.categories (
 catalog_id uuid NOT NULL REFERENCES whaleu_ratings.catalogs(id),id uuid NOT NULL,revision uuid NOT NULL,parent_id uuid,level smallint NOT NULL CHECK(level BETWEEN 1 AND 3),
 origin_kind text NOT NULL CHECK(origin_kind IN ('global','system','regional')),kind text NOT NULL CHECK(kind ~ '^[a-z][a-z0-9_]{0,49}$'),system_key text CHECK(system_key ~ '^[a-z][a-z0-9_]{1,48}$'),
 name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 100),description text NOT NULL CHECK(length(description)<=500),active boolean NOT NULL,hidden boolean NOT NULL,ordinal bigint NOT NULL CHECK(ordinal>=0),
 PRIMARY KEY(catalog_id,id),UNIQUE(catalog_id,ordinal),FOREIGN KEY(catalog_id,parent_id) REFERENCES whaleu_ratings.categories(catalog_id,id),
 CHECK((parent_id IS NULL)=(level=1)),CHECK(parent_id IS DISTINCT FROM id),CHECK(system_key IS NULL OR origin_kind='system')
);
CREATE FUNCTION whaleu_ratings.category_tree() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p whaleu_ratings.categories;sealed boolean;region uuid;
BEGIN
 SELECT c.sealed,c.region_id INTO sealed,region FROM whaleu_ratings.catalogs c WHERE id=NEW.catalog_id FOR SHARE;
 IF sealed OR (NEW.origin_kind='regional' AND region IS NULL) THEN RAISE EXCEPTION 'Catalog is sealed or category scope conflicts' USING ERRCODE='23514'; END IF;
 IF NEW.parent_id IS NOT NULL THEN
 SELECT * INTO p FROM whaleu_ratings.categories WHERE catalog_id=NEW.catalog_id AND id=NEW.parent_id FOR SHARE;
 IF p.id IS NULL OR p.level+1<>NEW.level OR p.kind<>NEW.kind THEN RAISE EXCEPTION 'Invalid category ancestry' USING ERRCODE='23514'; END IF;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER rating_category_tree BEFORE INSERT ON whaleu_ratings.categories FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.category_tree();
CREATE TABLE whaleu_ratings.target_sources (
 id uuid PRIMARY KEY,target_id uuid NOT NULL UNIQUE,origin text NOT NULL CHECK(origin IN ('new_native','historical','unknown')),
 coverage text NOT NULL CHECK(coverage IN ('complete','missing','conflicting')),provenance text NOT NULL CHECK(provenance IN ('accepted','unknown','conflicting')),
 source_reference text NOT NULL CHECK(length(btrim(source_reference))>0),policy_reference text NOT NULL CHECK(length(btrim(policy_reference))>0),
 effective_at timestamptz NOT NULL CHECK(isfinite(effective_at)),source_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),UNIQUE(id,target_id)
);
CREATE FUNCTION whaleu_ratings.source_transaction_causal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.source_transaction<>pg_current_xact_id() THEN RAISE EXCEPTION 'Invalid source transaction' USING ERRCODE='23514'; END IF;RETURN NEW;END $$;
CREATE TRIGGER rating_source_transaction BEFORE INSERT ON whaleu_ratings.target_sources FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.source_transaction_causal();
CREATE TABLE whaleu_ratings.targets (
 id uuid PRIMARY KEY,revision uuid NOT NULL,category_id uuid NOT NULL,creator_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),region_id uuid REFERENCES whaleu_campus.operating_regions(id),source_id uuid NOT NULL,
 name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 100),description text NOT NULL CHECK(length(description)<=500),active boolean NOT NULL,
 envelope jsonb NOT NULL CHECK(jsonb_typeof(envelope)='object'),content_version integer NOT NULL DEFAULT 1 CHECK(content_version=1),
 creation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(created_at)),FOREIGN KEY(source_id,id) REFERENCES whaleu_ratings.target_sources(id,target_id)
);
CREATE TABLE whaleu_ratings.target_memberships (
 catalog_id uuid NOT NULL REFERENCES whaleu_ratings.catalogs(id),target_id uuid NOT NULL REFERENCES whaleu_ratings.targets(id),category_id uuid NOT NULL,ordinal bigint NOT NULL CHECK(ordinal>=0),
 PRIMARY KEY(catalog_id,target_id),UNIQUE(catalog_id,ordinal),FOREIGN KEY(catalog_id,category_id) REFERENCES whaleu_ratings.categories(catalog_id,id)
);
CREATE FUNCTION whaleu_ratings.membership_validate() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c whaleu_ratings.catalogs;t whaleu_ratings.targets;
BEGIN
 SELECT * INTO c FROM whaleu_ratings.catalogs WHERE id=NEW.catalog_id FOR SHARE;SELECT * INTO t FROM whaleu_ratings.targets WHERE id=NEW.target_id FOR SHARE;
 IF c.sealed OR t.category_id<>NEW.category_id OR (t.region_id IS NOT NULL AND t.region_id IS DISTINCT FROM c.region_id) THEN RAISE EXCEPTION 'Invalid catalog membership' USING ERRCODE='23514'; END IF;RETURN NEW;
END $$;
CREATE TRIGGER rating_membership_validate BEFORE INSERT ON whaleu_ratings.target_memberships FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.membership_validate();
CREATE FUNCTION whaleu_ratings.catalog_seal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' OR OLD.sealed OR NOT NEW.sealed OR ROW(NEW.id,NEW.region_id,NEW.coverage,NEW.provenance,NEW.source_reference,NEW.policy_reference,NEW.effective_at,NEW.valid_until) IS DISTINCT FROM ROW(OLD.id,OLD.region_id,OLD.coverage,OLD.provenance,OLD.source_reference,OLD.policy_reference,OLD.effective_at,OLD.valid_until) THEN RAISE EXCEPTION 'Catalog may only be sealed once' USING ERRCODE='23514'; END IF;RETURN NEW;END $$;
CREATE TRIGGER rating_catalog_seal BEFORE UPDATE OR DELETE ON whaleu_ratings.catalogs FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.catalog_seal();
CREATE FUNCTION whaleu_ratings.head_validate() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c whaleu_ratings.catalogs;old_time timestamptz;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Catalog head is durable' USING ERRCODE='23514'; END IF;
 SELECT * INTO c FROM whaleu_ratings.catalogs WHERE id=NEW.catalog_id;
 IF c.id IS NULL OR NOT c.sealed OR c.region_id IS DISTINCT FROM NEW.region_id THEN RAISE EXCEPTION 'Invalid catalog head' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' THEN SELECT effective_at INTO old_time FROM whaleu_ratings.catalogs WHERE id=OLD.catalog_id;
 IF NEW.scope_key<>OLD.scope_key OR c.effective_at<=old_time THEN RAISE EXCEPTION 'Catalog head cannot rewind' USING ERRCODE='23514'; END IF;END IF;RETURN NEW;
END $$;
CREATE TRIGGER rating_head_validate BEFORE INSERT OR UPDATE OR DELETE ON whaleu_ratings.catalog_heads FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.head_validate();
CREATE FUNCTION whaleu_ratings.target_definition() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' OR ROW(NEW.id,NEW.category_id,NEW.creator_id,NEW.region_id,NEW.source_id,NEW.name,NEW.description,NEW.envelope,NEW.content_version,NEW.creation_transaction,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.category_id,OLD.creator_id,OLD.region_id,OLD.source_id,OLD.name,OLD.description,OLD.envelope,OLD.content_version,OLD.creation_transaction,OLD.created_at) OR NEW.revision=OLD.revision OR NEW.active=OLD.active THEN RAISE EXCEPTION 'Target definition is immutable' USING ERRCODE='23514';END IF;RETURN NEW;END $$;
CREATE TRIGGER rating_target_definition BEFORE UPDATE OR DELETE ON whaleu_ratings.targets FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.target_definition();
CREATE TABLE whaleu_ratings.target_creations (target_id uuid PRIMARY KEY REFERENCES whaleu_ratings.targets(id),source_id uuid NOT NULL,creation_transaction xid8 NOT NULL,created_at timestamptz NOT NULL,FOREIGN KEY(source_id,target_id) REFERENCES whaleu_ratings.target_sources(id,target_id));
CREATE FUNCTION whaleu_ratings.record_target_creation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.creation_transaction<>pg_current_xact_id() THEN RAISE EXCEPTION 'Invalid creation transaction' USING ERRCODE='23514'; END IF;
 INSERT INTO whaleu_ratings.target_creations VALUES(NEW.id,NEW.source_id,NEW.creation_transaction,NEW.created_at);RETURN NULL;END $$;
CREATE TRIGGER rating_target_created AFTER INSERT ON whaleu_ratings.targets FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.record_target_creation();
CREATE TRIGGER rating_creation_causal BEFORE INSERT ON whaleu_ratings.target_creations FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.nested_insert();
CREATE TABLE whaleu_ratings.score_baselines (
 target_id uuid PRIMARY KEY REFERENCES whaleu_ratings.targets(id),id uuid NOT NULL UNIQUE,kind text NOT NULL CHECK(kind='fresh_zero'),source_id uuid NOT NULL,
 source_reference text NOT NULL CHECK(length(btrim(source_reference))>0),policy_reference text NOT NULL CHECK(length(btrim(policy_reference))>0),creation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),FOREIGN KEY(source_id,target_id) REFERENCES whaleu_ratings.target_sources(id,target_id)
);
CREATE TABLE whaleu_ratings.score_summaries (
 target_id uuid PRIMARY KEY REFERENCES whaleu_ratings.score_baselines(target_id),revision uuid NOT NULL,count bigint NOT NULL CHECK(count BETWEEN 0 AND 2147483647),sum bigint NOT NULL CHECK(sum BETWEEN 0 AND 10737418235),
 b1 bigint NOT NULL CHECK(b1>=0),b2 bigint NOT NULL CHECK(b2>=0),b3 bigint NOT NULL CHECK(b3>=0),b4 bigint NOT NULL CHECK(b4>=0),b5 bigint NOT NULL CHECK(b5>=0),CHECK(count=b1+b2+b3+b4+b5),CHECK(sum=b1+2*b2+3*b3+4*b4+5*b5)
);
CREATE FUNCTION whaleu_ratings.fresh_score_baseline() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c whaleu_ratings.target_creations;s whaleu_ratings.target_sources;
BEGIN
 SELECT * INTO c FROM whaleu_ratings.target_creations WHERE target_id=NEW.target_id FOR SHARE;SELECT * INTO s FROM whaleu_ratings.target_sources WHERE id=NEW.source_id AND target_id=NEW.target_id FOR SHARE;
 IF c.target_id IS NULL OR s.id IS NULL OR s.origin<>'new_native' OR s.coverage<>'complete' OR s.provenance<>'accepted' OR s.effective_at>clock_timestamp() OR s.source_transaction<>pg_current_xact_id() OR NEW.creation_transaction<>pg_current_xact_id() OR c.creation_transaction<>NEW.creation_transaction OR c.source_id<>NEW.source_id THEN RAISE EXCEPTION 'Fresh coverage requires an independent new-target source in its creation transaction' USING ERRCODE='23514'; END IF;RETURN NEW;
END $$;
CREATE TRIGGER rating_fresh_baseline BEFORE INSERT ON whaleu_ratings.score_baselines FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.fresh_score_baseline();
CREATE FUNCTION whaleu_ratings.initialize_summary() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO whaleu_ratings.score_summaries VALUES(NEW.target_id,NEW.id,0,0,0,0,0,0,0);RETURN NULL;END $$;
CREATE TRIGGER rating_fresh_summary AFTER INSERT ON whaleu_ratings.score_baselines FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.initialize_summary();
CREATE FUNCTION whaleu_ratings.summary_causal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF TG_OP='DELETE' OR pg_trigger_depth()<2 THEN RAISE EXCEPTION 'Uncaused summary mutation' USING ERRCODE='23514';END IF;RETURN NEW;END $$;
CREATE TRIGGER rating_summary_causal BEFORE INSERT OR UPDATE OR DELETE ON whaleu_ratings.score_summaries FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.summary_causal();
CREATE TABLE whaleu_ratings.requests (
 account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),request_id uuid NOT NULL,operation text NOT NULL CHECK(operation IN ('set_score','create_comment','delete_comment')),intent_hash text NOT NULL CHECK(intent_hash~'^[a-f0-9]{64}$'),receipt jsonb,
 PRIMARY KEY(account_id,request_id),CHECK(receipt IS NULL OR jsonb_typeof(receipt)='object')
);
CREATE TABLE whaleu_ratings.scores (
 target_id uuid NOT NULL REFERENCES whaleu_ratings.score_baselines(target_id),account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),score smallint NOT NULL CHECK(score BETWEEN 1 AND 5),revision uuid NOT NULL,request_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(target_id,account_id),FOREIGN KEY(account_id,request_id) REFERENCES whaleu_ratings.requests(account_id,request_id),CHECK(isfinite(created_at) AND isfinite(updated_at) AND updated_at>=created_at)
);
CREATE TABLE whaleu_ratings.score_transitions (
 id uuid PRIMARY KEY,target_id uuid NOT NULL REFERENCES whaleu_ratings.targets(id),account_id uuid NOT NULL,request_id uuid NOT NULL,sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
 old_score smallint CHECK(old_score BETWEEN 1 AND 5),new_score smallint NOT NULL CHECK(new_score BETWEEN 1 AND 5),old_revision uuid,new_revision uuid NOT NULL,old_summary jsonb NOT NULL,new_summary jsonb NOT NULL,mutation_transaction xid8 NOT NULL,occurred_at timestamptz NOT NULL,
 UNIQUE(account_id,request_id),CHECK((old_score IS NULL)=(old_revision IS NULL)),CHECK(old_score IS DISTINCT FROM new_score),FOREIGN KEY(account_id,request_id) REFERENCES whaleu_ratings.requests(account_id,request_id)
);
CREATE TRIGGER rating_score_transition_causal BEFORE INSERT ON whaleu_ratings.score_transitions FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.nested_insert();
CREATE FUNCTION whaleu_ratings.apply_score_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prior whaleu_ratings.score_summaries;next_summary whaleu_ratings.score_summaries;previous smallint;prior_revision uuid;command whaleu_ratings.requests;active boolean;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Score withdrawal unsupported' USING ERRCODE='23514';END IF;
 SELECT t.active INTO active FROM whaleu_ratings.targets t WHERE id=NEW.target_id FOR UPDATE;
 IF active IS DISTINCT FROM true THEN RAISE EXCEPTION 'Inactive score target' USING ERRCODE='23514';END IF;
 SELECT * INTO prior FROM whaleu_ratings.score_summaries WHERE target_id=NEW.target_id FOR UPDATE;
 IF prior.target_id IS NULL THEN RAISE EXCEPTION 'Score coverage unavailable' USING ERRCODE='23514';END IF;
 SELECT * INTO command FROM whaleu_ratings.requests WHERE account_id=NEW.account_id AND request_id=NEW.request_id FOR UPDATE;
 IF command.operation IS DISTINCT FROM 'set_score' OR command.receipt IS NOT NULL THEN RAISE EXCEPTION 'Invalid score command' USING ERRCODE='23514';END IF;
 IF TG_OP='UPDATE' THEN
 IF ROW(NEW.target_id,NEW.account_id,NEW.created_at) IS DISTINCT FROM ROW(OLD.target_id,OLD.account_id,OLD.created_at) OR NEW.score=OLD.score OR NEW.revision=OLD.revision OR NEW.request_id=OLD.request_id THEN RAISE EXCEPTION 'Invalid score transition' USING ERRCODE='23514';END IF;
 previous:=OLD.score;prior_revision:=OLD.revision;END IF;
 NEW.updated_at:=clock_timestamp();IF TG_OP='INSERT' THEN NEW.created_at:=NEW.updated_at;END IF;
 UPDATE whaleu_ratings.score_summaries SET revision=gen_random_uuid(),count=count+CASE WHEN previous IS NULL THEN 1 ELSE 0 END,sum=sum+NEW.score-coalesce(previous,0),
 b1=b1+(NEW.score=1)::integer-coalesce((previous=1)::integer,0),b2=b2+(NEW.score=2)::integer-coalesce((previous=2)::integer,0),b3=b3+(NEW.score=3)::integer-coalesce((previous=3)::integer,0),b4=b4+(NEW.score=4)::integer-coalesce((previous=4)::integer,0),b5=b5+(NEW.score=5)::integer-coalesce((previous=5)::integer,0)
 WHERE target_id=NEW.target_id RETURNING * INTO next_summary;
 INSERT INTO whaleu_ratings.score_transitions(id,target_id,account_id,request_id,old_score,new_score,old_revision,new_revision,old_summary,new_summary,mutation_transaction,occurred_at)
 VALUES(gen_random_uuid(),NEW.target_id,NEW.account_id,NEW.request_id,previous,NEW.score,prior_revision,NEW.revision,to_jsonb(prior),to_jsonb(next_summary),pg_current_xact_id(),NEW.updated_at);RETURN NEW;
END $$;
CREATE TRIGGER rating_score_change BEFORE INSERT OR UPDATE OR DELETE ON whaleu_ratings.scores FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.apply_score_transition();
CREATE TABLE whaleu_ratings.personas (
 target_id uuid NOT NULL REFERENCES whaleu_ratings.targets(id),account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),public_id uuid NOT NULL UNIQUE,display_name text NOT NULL CHECK(length(display_name) BETWEEN 1 AND 100),PRIMARY KEY(target_id,account_id),UNIQUE(target_id,account_id,public_id)
);
CREATE TABLE whaleu_ratings.comments (
 id uuid PRIMARY KEY,target_id uuid NOT NULL REFERENCES whaleu_ratings.targets(id),account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),author_mode text NOT NULL CHECK(author_mode IN ('named','anonymous')),persona_id uuid,
 body text NOT NULL CHECK(length(btrim(body)) BETWEEN 1 AND 500),revision uuid NOT NULL,request_id uuid NOT NULL,envelope jsonb NOT NULL CHECK(jsonb_typeof(envelope)='object'),content_version integer NOT NULL DEFAULT 1 CHECK(content_version=1),publication_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 ordinal bigint GENERATED ALWAYS AS IDENTITY UNIQUE,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),deleted_at timestamptz,delete_request_id uuid,
 FOREIGN KEY(target_id,account_id,persona_id) REFERENCES whaleu_ratings.personas(target_id,account_id,public_id),FOREIGN KEY(account_id,request_id) REFERENCES whaleu_ratings.requests(account_id,request_id),FOREIGN KEY(account_id,delete_request_id) REFERENCES whaleu_ratings.requests(account_id,request_id),
 CHECK((author_mode='anonymous')=(persona_id IS NOT NULL)),CHECK((deleted_at IS NULL)=(delete_request_id IS NULL)),CHECK(isfinite(created_at) AND (deleted_at IS NULL OR (isfinite(deleted_at) AND deleted_at>=created_at)))
);
CREATE TABLE whaleu_ratings.comment_transitions (
 id uuid PRIMARY KEY,comment_id uuid NOT NULL REFERENCES whaleu_ratings.comments(id),target_id uuid NOT NULL REFERENCES whaleu_ratings.targets(id),account_id uuid NOT NULL,request_id uuid NOT NULL,operation text NOT NULL CHECK(operation IN ('create_comment','delete_comment')),revision uuid NOT NULL,
 mutation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),occurred_at timestamptz NOT NULL,UNIQUE(account_id,request_id),FOREIGN KEY(account_id,request_id) REFERENCES whaleu_ratings.requests(account_id,request_id)
);
CREATE TRIGGER rating_comment_transition_causal BEFORE INSERT ON whaleu_ratings.comment_transitions FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.nested_insert();
CREATE FUNCTION whaleu_ratings.comment_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE command whaleu_ratings.requests;op text;key uuid;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Comment tombstone is durable' USING ERRCODE='23514';END IF;
 IF TG_OP='UPDATE' THEN
 IF ROW(NEW.id,NEW.target_id,NEW.account_id,NEW.author_mode,NEW.persona_id,NEW.body,NEW.request_id,NEW.envelope,NEW.content_version,NEW.publication_transaction,NEW.ordinal,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.target_id,OLD.account_id,OLD.author_mode,OLD.persona_id,OLD.body,OLD.request_id,OLD.envelope,OLD.content_version,OLD.publication_transaction,OLD.ordinal,OLD.created_at)
 OR OLD.deleted_at IS NOT NULL OR NEW.deleted_at IS NULL OR NEW.delete_request_id IS NULL OR NEW.revision=OLD.revision THEN RAISE EXCEPTION 'Invalid comment deletion' USING ERRCODE='23514';END IF;
 op:='delete_comment';key:=NEW.delete_request_id;
 ELSE IF NEW.deleted_at IS NOT NULL OR NEW.publication_transaction<>pg_current_xact_id() THEN RAISE EXCEPTION 'Invalid comment publication' USING ERRCODE='23514';END IF;op:='create_comment';key:=NEW.request_id;END IF;
 SELECT * INTO command FROM whaleu_ratings.requests WHERE account_id=NEW.account_id AND request_id=key FOR UPDATE;
 IF command.operation IS DISTINCT FROM op OR command.receipt IS NOT NULL THEN RAISE EXCEPTION 'Invalid comment command' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER rating_comment_change BEFORE INSERT OR UPDATE OR DELETE ON whaleu_ratings.comments FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.comment_change();
CREATE FUNCTION whaleu_ratings.record_comment_transition() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO whaleu_ratings.comment_transitions(id,comment_id,target_id,account_id,request_id,operation,revision,occurred_at)
 VALUES(gen_random_uuid(),NEW.id,NEW.target_id,NEW.account_id,CASE WHEN TG_OP='INSERT' THEN NEW.request_id ELSE NEW.delete_request_id END,CASE WHEN TG_OP='INSERT' THEN 'create_comment' ELSE 'delete_comment' END,NEW.revision,coalesce(NEW.deleted_at,NEW.created_at));RETURN NULL;END $$;
CREATE TRIGGER rating_comment_event AFTER INSERT OR UPDATE ON whaleu_ratings.comments FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.record_comment_transition();
CREATE INDEX rating_comment_page ON whaleu_ratings.comments(target_id,ordinal DESC) WHERE deleted_at IS NULL;
CREATE FUNCTION whaleu_ratings.request_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' OR OLD.receipt IS NOT NULL OR NEW.receipt IS NULL OR ROW(NEW.account_id,NEW.request_id,NEW.operation,NEW.intent_hash) IS DISTINCT FROM ROW(OLD.account_id,OLD.request_id,OLD.operation,OLD.intent_hash) THEN RAISE EXCEPTION 'Rating receipt is immutable' USING ERRCODE='23514';END IF;RETURN NEW;END $$;
CREATE TRIGGER rating_request_immutable BEFORE UPDATE OR DELETE ON whaleu_ratings.requests FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.request_immutable();
CREATE FUNCTION whaleu_ratings.request_causal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r whaleu_ratings.requests;s whaleu_ratings.score_transitions;c whaleu_ratings.comment_transitions;n integer;keys text[];time timestamptz;
BEGIN
 SELECT * INTO r FROM whaleu_ratings.requests WHERE account_id=NEW.account_id AND request_id=NEW.request_id;
 IF r.receipt IS NULL OR NOT coalesce(r.receipt->>'requestId'=r.request_id::text AND r.receipt->>'operation'=r.operation,false) THEN RAISE EXCEPTION 'Missing canonical receipt' USING ERRCODE='23514';END IF;
 SELECT array_agg(k ORDER BY k) INTO keys FROM jsonb_object_keys(r.receipt) k;
 SELECT * INTO s FROM whaleu_ratings.score_transitions WHERE account_id=r.account_id AND request_id=r.request_id;
 SELECT * INTO c FROM whaleu_ratings.comment_transitions WHERE account_id=r.account_id AND request_id=r.request_id;n:=(s.id IS NOT NULL)::integer+(c.id IS NOT NULL)::integer;
 IF r.receipt->>'outcome'='rejected' THEN
 IF keys IS DISTINCT FROM ARRAY['code','operation','outcome','requestId'] OR n<>0 OR NOT coalesce(r.receipt->>'code' IN ('RATING_NOT_FOUND','RATING_REVISION_CONFLICT','PHONE_VERIFICATION_REQUIRED','AFFILIATION_VERIFICATION_REQUIRED','IDENTITY_CAMPUS_REQUIRED','SAFETY_ACTION_RESTRICTED','CONTENT_REJECTED'),false) THEN RAISE EXCEPTION 'Invalid rejected receipt' USING ERRCODE='23514';END IF;RETURN NULL;
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
CREATE CONSTRAINT TRIGGER rating_request_causal AFTER INSERT OR UPDATE ON whaleu_ratings.requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.request_causal();
CREATE FUNCTION whaleu_ratings.score_chain_causal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a whaleu_ratings.score_transitions;b whaleu_ratings.score_transitions;s whaleu_ratings.scores;t whaleu_ratings.score_summaries;
BEGIN
 SELECT * INTO a FROM whaleu_ratings.score_transitions WHERE target_id=NEW.target_id AND account_id=NEW.account_id ORDER BY sequence DESC LIMIT 1;
 SELECT * INTO s FROM whaleu_ratings.scores WHERE target_id=NEW.target_id AND account_id=NEW.account_id;
 SELECT * INTO b FROM whaleu_ratings.score_transitions WHERE target_id=NEW.target_id ORDER BY sequence DESC LIMIT 1;
 SELECT * INTO t FROM whaleu_ratings.score_summaries WHERE target_id=NEW.target_id;
 IF NOT coalesce(a.new_revision=s.revision AND a.new_score=s.score AND b.new_summary=to_jsonb(t),false) THEN RAISE EXCEPTION 'Broken score causal chain' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER rating_score_chain AFTER INSERT ON whaleu_ratings.score_transitions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.score_chain_causal();
CREATE INDEX rating_score_chain_actor ON whaleu_ratings.score_transitions(target_id,account_id,sequence DESC);
CREATE INDEX rating_score_chain_target ON whaleu_ratings.score_transitions(target_id,sequence DESC);
CREATE UNIQUE INDEX rating_score_revision ON whaleu_ratings.score_transitions(target_id,account_id,new_revision);
CREATE UNIQUE INDEX rating_comment_revision ON whaleu_ratings.comment_transitions(comment_id,revision);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['categories','target_sources','target_memberships','target_creations','score_baselines','score_transitions','personas','comment_transitions'] LOOP EXECUTE format('CREATE TRIGGER rating_immutable BEFORE UPDATE OR DELETE ON whaleu_ratings.%I FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.immutable()',t);END LOOP;
 FOREACH t IN ARRAY ARRAY['catalogs','catalog_heads','categories','target_sources','targets','target_memberships'] LOOP EXECUTE format('CREATE TRIGGER rating_authority_writer BEFORE INSERT OR UPDATE OR DELETE ON whaleu_ratings.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.policy_writer()',t);END LOOP;
 FOREACH t IN ARRAY ARRAY['catalogs','catalog_heads','categories','target_sources','targets','target_memberships','target_creations','score_baselines','score_summaries','requests','scores','score_transitions','personas','comments','comment_transitions'] LOOP EXECUTE format('CREATE TRIGGER rating_no_truncate BEFORE TRUNCATE ON whaleu_ratings.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.immutable()',t);END LOOP;
END $$;
-- Navigation metadata only, not catalog or score authority. Lifecycle changes
-- invalidate even pages which previously skipped an inactive target.
CREATE TABLE whaleu_ratings.navigation_epoch(singleton boolean PRIMARY KEY CHECK(singleton),version integer NOT NULL CHECK(version=1),epoch bigint NOT NULL CHECK(epoch>=0));
INSERT INTO whaleu_ratings.navigation_epoch VALUES(true,1,0);
CREATE FUNCTION whaleu_ratings.advance_navigation_epoch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('whaleu:named-block-policy:v1',0));
 UPDATE whaleu_ratings.navigation_epoch SET epoch=epoch+1 WHERE singleton;RETURN NULL;END $$;
CREATE FUNCTION whaleu_ratings.guard_navigation_epoch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP<>'UPDATE' OR pg_trigger_depth()<2 OR ROW(NEW.singleton,NEW.version) IS DISTINCT FROM ROW(OLD.singleton,OLD.version) OR NEW.epoch<>OLD.epoch+1 THEN RAISE EXCEPTION 'Invalid navigation epoch transition' USING ERRCODE='23514';END IF;RETURN NEW;END $$;
CREATE TRIGGER rating_navigation_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_ratings.navigation_epoch FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.guard_navigation_epoch();
CREATE TRIGGER rating_navigation_no_truncate BEFORE TRUNCATE ON whaleu_ratings.navigation_epoch FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.immutable();
CREATE TRIGGER rating_navigation_writer BEFORE INSERT OR UPDATE OR DELETE ON whaleu_ratings.targets FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.advance_navigation_epoch();
-- Lifecycle CAS tokens never repeat, including inactive-to-active transitions.
-- This ledger is separate from immutable review content revision.
CREATE TABLE whaleu_ratings.target_state_revisions (
 target_id uuid NOT NULL REFERENCES whaleu_ratings.targets(id),revision uuid NOT NULL,
 active boolean NOT NULL,occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 mutation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),PRIMARY KEY(target_id,revision)
);
CREATE FUNCTION whaleu_ratings.record_target_state() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO whaleu_ratings.target_state_revisions(target_id,revision,active) VALUES(NEW.id,NEW.revision,NEW.active);RETURN NULL;END $$;
CREATE TRIGGER rating_target_state AFTER INSERT OR UPDATE ON whaleu_ratings.targets FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.record_target_state();
CREATE TRIGGER rating_target_state_causal BEFORE INSERT ON whaleu_ratings.target_state_revisions FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.nested_insert();
CREATE TRIGGER rating_target_state_immutable BEFORE UPDATE OR DELETE ON whaleu_ratings.target_state_revisions FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.immutable();
CREATE TRIGGER rating_target_state_retain BEFORE TRUNCATE ON whaleu_ratings.target_state_revisions FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.immutable();

CREATE UNIQUE INDEX rating_category_system_key ON whaleu_ratings.categories(catalog_id,system_key) WHERE system_key IS NOT NULL;
-- Deferred reverse links defend the summary even if another trusted database
-- trigger writes it: trigger nesting alone is not the source of truth.
CREATE FUNCTION whaleu_ratings.summary_reverse_causal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s whaleu_ratings.score_summaries;e whaleu_ratings.score_transitions;b whaleu_ratings.score_baselines;
BEGIN
 SELECT * INTO s FROM whaleu_ratings.score_summaries WHERE target_id=NEW.target_id;
 SELECT * INTO e FROM whaleu_ratings.score_transitions WHERE target_id=NEW.target_id ORDER BY sequence DESC LIMIT 1;
 IF e.id IS NOT NULL THEN
  IF e.new_summary IS DISTINCT FROM to_jsonb(s) THEN RAISE EXCEPTION 'Summary has no causal transition' USING ERRCODE='23514';END IF;
 ELSE
  SELECT * INTO b FROM whaleu_ratings.score_baselines WHERE target_id=NEW.target_id;
  IF NOT coalesce(b.id=s.revision AND s.count=0 AND s.sum=0,false) THEN RAISE EXCEPTION 'Summary has no fresh baseline' USING ERRCODE='23514';END IF;
 END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER rating_summary_reverse AFTER INSERT OR UPDATE ON whaleu_ratings.score_summaries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.summary_reverse_causal();
CREATE FUNCTION whaleu_ratings.score_delta_causal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous_target whaleu_ratings.score_transitions;previous_actor whaleu_ratings.score_transitions;b whaleu_ratings.score_baselines;expected jsonb;k integer;old_count bigint;
BEGIN
 SELECT * INTO previous_target FROM whaleu_ratings.score_transitions WHERE target_id=NEW.target_id AND sequence<NEW.sequence ORDER BY sequence DESC LIMIT 1;
 SELECT * INTO previous_actor FROM whaleu_ratings.score_transitions WHERE target_id=NEW.target_id AND account_id=NEW.account_id AND sequence<NEW.sequence ORDER BY sequence DESC LIMIT 1;
 IF NEW.mutation_transaction<>pg_current_xact_id() OR NEW.old_revision IS DISTINCT FROM previous_actor.new_revision OR NEW.old_score IS DISTINCT FROM previous_actor.new_score THEN RAISE EXCEPTION 'Score predecessor mismatch' USING ERRCODE='23514';END IF;
 IF previous_target.id IS NOT NULL THEN expected:=previous_target.new_summary;
 ELSE SELECT * INTO b FROM whaleu_ratings.score_baselines WHERE target_id=NEW.target_id;
 expected:=jsonb_build_object('target_id',NEW.target_id,'revision',b.id,'count',0,'sum',0,'b1',0,'b2',0,'b3',0,'b4',0,'b5',0);END IF;
 IF NEW.old_summary IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Score summary predecessor mismatch' USING ERRCODE='23514';END IF;
 old_count:=(expected->>'count')::bigint;
 expected:=jsonb_set(expected,'{count}',to_jsonb(old_count+CASE WHEN NEW.old_score IS NULL THEN 1 ELSE 0 END));
 expected:=jsonb_set(expected,'{sum}',to_jsonb((expected->>'sum')::bigint+NEW.new_score-coalesce(NEW.old_score,0)));
 FOR k IN 1..5 LOOP expected:=jsonb_set(expected,ARRAY['b'||k],to_jsonb((expected->>('b'||k))::bigint+(NEW.new_score=k)::integer-coalesce((NEW.old_score=k)::integer,0)));END LOOP;
 expected:=jsonb_set(expected,'{revision}',NEW.new_summary->'revision');
 IF NEW.new_summary IS DISTINCT FROM expected OR NEW.new_summary->'revision' IS NOT DISTINCT FROM NEW.old_summary->'revision' THEN RAISE EXCEPTION 'Incorrect score delta' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER rating_score_delta AFTER INSERT ON whaleu_ratings.score_transitions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.score_delta_causal();
