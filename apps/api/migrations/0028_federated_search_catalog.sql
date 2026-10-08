-- Additive search catalog protocol. No catalog seeds, content changes, imported
-- records, normalized text, publication grants or topology/distribution writes.
CREATE FUNCTION whaleu_community.search_catalog_writer_gate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('whaleu:named-block-policy:v1',0));
  RETURN NULL;
END $$;
-- Alphabetic statement-trigger order: common gate before a_discovery_count_epoch.
CREATE TRIGGER a_community_search_catalog_gate BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_community.spaces
  FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.search_catalog_writer_gate();
-- The existing Campus owner gate must also precede its later-added count epoch.
ALTER TRIGGER identity_region_catalog_gate ON whaleu_campus.operating_regions
  RENAME TO a_campus_search_catalog_gate;
-- Multi-statement catalog writers MUST acquire the exclusive common gate before
-- any earlier source-row or count-epoch lock. Statement triggers cannot repair
-- prior inversions. TRUNCATE/DDL maintenance requires outer-gate-first operator
-- coordination: BEFORE triggers cannot precede relation locks already acquired.
CREATE INDEX posts_search_chronological ON whaleu_community.posts(published_at DESC,id DESC)
  INCLUDE (space_id,category) WHERE deleted_at IS NULL AND visibility='approved';
-- This index is structural only. The candidate budget does not bound entries
-- PostgreSQL examines; representative execution plans must be measured separately.
