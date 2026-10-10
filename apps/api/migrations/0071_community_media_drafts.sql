-- Community owns draft issuance. Client draft IDs are correlation keys only.
-- No scope or permission is seeded by this migration.
SET LOCAL lock_timeout='5s';
SELECT pg_advisory_xact_lock(hashtextextended('whaleu:named-block-policy:v1',0));
CREATE TABLE whaleu_community.media_drafts (
 id uuid PRIMARY KEY,
 actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
 client_draft_id uuid NOT NULL,
 space_id uuid NOT NULL REFERENCES whaleu_community.spaces(id),
 scope_revision text NOT NULL CHECK(scope_revision ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(created_at)),
 expires_at timestamptz NOT NULL CHECK(isfinite(expires_at) AND expires_at>created_at),
 UNIQUE(actor_id,client_draft_id)
);
CREATE TRIGGER community_media_draft_policy BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_community.media_drafts FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.content_policy_writer_gate();
CREATE TRIGGER community_media_draft_immutable BEFORE UPDATE OR DELETE ON whaleu_community.media_drafts FOR EACH ROW EXECUTE FUNCTION whaleu_media.immutable_record();
CREATE TRIGGER community_media_draft_retain BEFORE TRUNCATE ON whaleu_community.media_drafts FOR EACH STATEMENT EXECUTE FUNCTION whaleu_media.immutable_record();
