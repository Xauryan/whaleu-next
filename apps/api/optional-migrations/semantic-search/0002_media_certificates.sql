-- Additive, explicitly installed Media-bound eligibility. V1 certificates,
-- source_revision and embeddings retain their exact bytes and identities.
CREATE TABLE whaleu_semantic.media_installation (
 version integer PRIMARY KEY CHECK(version=2),
 checksum text NOT NULL CHECK(checksum ~ '^[a-f0-9]{64}$')
);
CREATE TABLE whaleu_semantic.certificates_v2 (
 index_space_key text NOT NULL CHECK(index_space_key ~ '^[a-f0-9]{64}$'),
 kind text NOT NULL CHECK(kind IN ('post','comment','reply')),
 content_id uuid NOT NULL,
 post_id uuid NOT NULL,
 root_comment_id uuid,
 source_revision jsonb NOT NULL CHECK(jsonb_typeof(source_revision)='array'),
 body_digest text NOT NULL CHECK(body_digest ~ '^[a-f0-9]{64}$'),
 space_id uuid NOT NULL,
 region_id uuid,
 certificate_version integer NOT NULL CHECK(certificate_version=2),
 has_searchable_text boolean NOT NULL,
 valid_until timestamptz CHECK(valid_until IS NULL OR isfinite(valid_until)),
 media_chain jsonb NOT NULL CHECK(jsonb_typeof(media_chain)='array'
   AND jsonb_array_length(media_chain) BETWEEN 1 AND 3
   AND jsonb_array_length(media_chain)=jsonb_array_length(source_revision)),
 PRIMARY KEY(index_space_key,kind,content_id),
 CHECK((kind='post' AND content_id=post_id AND root_comment_id IS NULL)
   OR (kind='comment' AND content_id=root_comment_id)
   OR (kind='reply' AND root_comment_id IS NOT NULL))
);
CREATE TRIGGER a_discovery_count_epoch BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_semantic.certificates_v2
 FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.advance_discovery_count_epoch();
