-- Explicit, optional, transactional local-development installation only.
-- Not part of db:migrate. Requires all ordinary migrations and pgvector 0.8.7.
-- No provider, background indexing, historical coverage or public API is enabled.
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace
  WHERE e.extname='vector' AND e.extversion='0.8.7' AND n.nspname='public') THEN
  RAISE EXCEPTION 'Expected pgvector 0.8.7 in public';
 END IF;
END $$;
CREATE SCHEMA whaleu_semantic;
CREATE TABLE whaleu_semantic.installation (version integer PRIMARY KEY CHECK(version=1),
 checksum text CHECK(checksum ~ '^[a-f0-9]{64}$'));
INSERT INTO whaleu_semantic.installation(version) VALUES(1);

-- Persistent incarnation tokens survive deletion. A hide/restore cycle must not
-- revive an in-flight embedding, even when the body bytes have not changed.
CREATE TABLE whaleu_semantic.source_generations (
 kind text NOT NULL CHECK(kind IN ('post','comment','reply')),
 content_id uuid NOT NULL,
 generation uuid NOT NULL,
 PRIMARY KEY(kind,content_id)
);
INSERT INTO whaleu_semantic.source_generations
 SELECT 'post',id,gen_random_uuid() FROM whaleu_community.posts
 UNION ALL SELECT 'comment',id,gen_random_uuid() FROM whaleu_community.root_comments
 UNION ALL SELECT 'reply',id,gen_random_uuid() FROM whaleu_community.replies;

CREATE TABLE whaleu_semantic.embeddings (
 index_space_key text NOT NULL CHECK(index_space_key ~ '^[a-f0-9]{64}$'),
 kind text NOT NULL CHECK(kind IN ('post','comment','reply')),
 content_id uuid NOT NULL,
 post_id uuid NOT NULL,
 root_comment_id uuid,
 source_revision jsonb NOT NULL CHECK(jsonb_typeof(source_revision)='array'),
 body_digest text NOT NULL CHECK(body_digest ~ '^[a-f0-9]{64}$'),
 embedding public.vector(4096) NOT NULL,
 PRIMARY KEY(index_space_key,kind,content_id),
 CHECK(public.vector_norm(embedding)>0),
 CHECK((kind='post' AND content_id=post_id AND root_comment_id IS NULL)
    OR (kind='comment' AND content_id=root_comment_id)
    OR (kind='reply' AND root_comment_id IS NOT NULL))
);
CREATE INDEX semantic_embeddings_post ON whaleu_semantic.embeddings(post_id);
CREATE INDEX semantic_embeddings_root ON whaleu_semantic.embeddings(root_comment_id);
-- Deliberately no shared ANN graph: denied vectors must not affect recall.

CREATE FUNCTION whaleu_semantic.reject_direct_generation_write() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF pg_trigger_depth()<2 THEN RAISE EXCEPTION 'Source generation is source-owned' USING ERRCODE='23514'; END IF;
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Source generations are durable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER semantic_generation_owner BEFORE INSERT OR UPDATE OR DELETE ON whaleu_semantic.source_generations
 FOR EACH ROW EXECUTE FUNCTION whaleu_semantic.reject_direct_generation_write();

CREATE FUNCTION whaleu_semantic.invalidate_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE k text; source_id uuid;
BEGIN
 k:=CASE TG_TABLE_NAME WHEN 'posts' THEN 'post' WHEN 'root_comments' THEN 'comment' ELSE 'reply' END;
 source_id:=CASE WHEN TG_OP='DELETE' THEN OLD.id ELSE NEW.id END;
 INSERT INTO whaleu_semantic.source_generations(kind,content_id,generation) VALUES(k,source_id,gen_random_uuid())
 ON CONFLICT(kind,content_id) DO UPDATE SET generation=EXCLUDED.generation;
 -- Logical invalidation: all reads compare the complete current ancestor chain.
 -- Do not acquire descendant vector locks from a source mutation trigger.
 RETURN NULL;
END $$;
CREATE TRIGGER semantic_post_lifecycle AFTER INSERT OR UPDATE OR DELETE ON whaleu_community.posts
 FOR EACH ROW EXECUTE FUNCTION whaleu_semantic.invalidate_source();
CREATE TRIGGER semantic_root_lifecycle AFTER INSERT OR UPDATE OR DELETE ON whaleu_community.root_comments
 FOR EACH ROW EXECUTE FUNCTION whaleu_semantic.invalidate_source();
CREATE TRIGGER semantic_reply_lifecycle AFTER INSERT OR UPDATE OR DELETE ON whaleu_community.replies
 FOR EACH ROW EXECUTE FUNCTION whaleu_semantic.invalidate_source();

-- Review head events already advance monotonically under the canonical gate.
-- source_revision incorporates every ancestor event, so a review transition
-- invalidates descendants without any new trigger lock order.

-- This is a version comparison, never an authorization function. The caller
-- must already hold canonical parent/root/reply and review locks and prove all
-- owner permissions. NULL means unavailable, never a current empty revision.
CREATE FUNCTION whaleu_semantic.source_revision(k text, source_id uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
 WITH source AS (
  SELECT p.id AS post_id,NULL::uuid AS root_id FROM whaleu_community.posts p WHERE k='post' AND p.id=source_id
  UNION ALL SELECT c.post_id,c.id FROM whaleu_community.root_comments c WHERE k='comment' AND c.id=source_id
  UNION ALL SELECT r.post_id,r.root_comment_id FROM whaleu_community.replies r WHERE k='reply' AND r.id=source_id
 ), nodes AS (
  SELECT 'post'::text AS kind,post_id AS id,0 AS ordinal FROM source
  UNION ALL SELECT 'comment',root_id,1 FROM source WHERE root_id IS NOT NULL
  UNION ALL SELECT 'reply',source_id,2 FROM source WHERE k='reply'
 ), revisions AS (
  SELECT n.ordinal,jsonb_build_array(n.kind,n.id,g.generation,b.digest,b.decision_id,d.policy_revision_id,h.event_id) AS revision
  FROM nodes n
  JOIN whaleu_semantic.source_generations g ON g.kind=n.kind AND g.content_id=n.id
  JOIN whaleu_community.content_approval_bindings b ON b.content_kind=n.kind AND b.content_id=n.id AND b.content_version=1
  JOIN whaleu_community.content_approval_decisions d ON d.id=b.decision_id
  JOIN whaleu_community.content_approval_heads h ON h.decision_id=d.id
 )
 SELECT CASE WHEN (SELECT count(*) FROM nodes)>0 AND count(*)=(SELECT count(*) FROM nodes)
  THEN jsonb_agg(revision ORDER BY ordinal) ELSE NULL END FROM revisions
$$;

CREATE FUNCTION whaleu_semantic.validate_embedding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_revision jsonb; source_body text; source_post uuid; source_root uuid;
BEGIN
 current_revision:=whaleu_semantic.source_revision(NEW.kind,NEW.content_id);
 IF current_revision IS NULL OR NEW.source_revision IS DISTINCT FROM current_revision THEN
  RAISE EXCEPTION 'Semantic source revision changed' USING ERRCODE='23514'; END IF;
 IF NEW.kind='post' THEN
  SELECT text,id,NULL::uuid INTO source_body,source_post,source_root FROM whaleu_community.posts WHERE id=NEW.content_id AND visibility='approved' AND deleted_at IS NULL;
 ELSIF NEW.kind='comment' THEN
  SELECT text,post_id,id INTO source_body,source_post,source_root FROM whaleu_community.root_comments WHERE id=NEW.content_id AND visibility='approved' AND deleted_at IS NULL;
 ELSE
  SELECT text,post_id,root_comment_id INTO source_body,source_post,source_root FROM whaleu_community.replies WHERE id=NEW.content_id AND visibility='approved' AND deleted_at IS NULL;
 END IF;
 IF source_body IS NULL OR source_post IS DISTINCT FROM NEW.post_id OR source_root IS DISTINCT FROM NEW.root_comment_id
   OR NEW.body_digest IS DISTINCT FROM encode(sha256(convert_to(source_body,'UTF8')),'hex') THEN
  RAISE EXCEPTION 'Semantic body or ancestry changed' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER semantic_embedding_revision BEFORE INSERT OR UPDATE ON whaleu_semantic.embeddings
 FOR EACH ROW EXECUTE FUNCTION whaleu_semantic.validate_embedding();

CREATE TABLE whaleu_semantic.certificates (
 index_space_key text NOT NULL CHECK(index_space_key ~ '^[a-f0-9]{64}$'),
 kind text NOT NULL CHECK(kind IN ('post','comment','reply')),
 content_id uuid NOT NULL,
 post_id uuid NOT NULL,
 root_comment_id uuid,
 source_revision jsonb NOT NULL CHECK(jsonb_typeof(source_revision)='array'),
 body_digest text NOT NULL CHECK(body_digest ~ '^[a-f0-9]{64}$'),
 space_id uuid NOT NULL,
 region_id uuid,
 certificate_version integer NOT NULL CHECK(certificate_version=1),
 has_searchable_text boolean NOT NULL,
 valid_until timestamptz CHECK(valid_until IS NULL OR isfinite(valid_until)),
 PRIMARY KEY(index_space_key,kind,content_id)
);
-- The existing community try-slot epoch protocol also covers every derived
-- search write. It is not automatically inherited from the source tables.
CREATE TRIGGER a_discovery_count_epoch BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_semantic.embeddings
 FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.advance_discovery_count_epoch();
CREATE TRIGGER a_discovery_count_epoch BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_semantic.certificates
 FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.advance_discovery_count_epoch();
CREATE TRIGGER a_discovery_count_epoch BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_semantic.source_generations
 FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.advance_discovery_count_epoch();

-- Persistent certificate validity cannot rely on a query's temporary epoch to
-- catch maintenance that happened between queries. Optional installation blocks
-- definition TRUNCATE, including child tables with no row-level DELETE trigger.
CREATE FUNCTION whaleu_semantic.reject_definition_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Semantic certificates require retained definition evidence' USING ERRCODE='23514'; END $$;
DO $$
DECLARE relation_name text;
BEGIN
 FOREACH relation_name IN ARRAY ARRAY['posts','root_comments','replies','post_images','comment_images','reply_images','polls','poll_options','formations','formation_members','trading_listings','content_approval_bindings','content_approval_decisions','content_approval_heads','content_approval_events','content_approval_policies'] LOOP
  EXECUTE format('CREATE TRIGGER semantic_definition_retention BEFORE TRUNCATE ON whaleu_community.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_semantic.reject_definition_truncate()',relation_name);
 END LOOP;
END $$;
CREATE TRIGGER semantic_generation_retention BEFORE TRUNCATE ON whaleu_semantic.source_generations
 FOR EACH STATEMENT EXECUTE FUNCTION whaleu_semantic.reject_definition_truncate();
