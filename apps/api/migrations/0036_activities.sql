-- Empty canonical activity storage. No source issuer, import, privilege grant or provider.
CREATE SCHEMA whaleu_activities;
CREATE TABLE whaleu_activities.identities (
 id uuid PRIMARY KEY,
 origin_kind text NOT NULL CHECK(origin_kind IN ('fresh_local','preserved')),
 provenance text NOT NULL CHECK(provenance IN ('accepted','unknown','conflicting')),
 source_reference text NOT NULL CHECK(length(btrim(source_reference))>0),
 policy_reference text NOT NULL CHECK(length(btrim(policy_reference))>0)
);
CREATE TABLE whaleu_activities.content_revisions (
 id uuid PRIMARY KEY,
 activity_id uuid NOT NULL REFERENCES whaleu_activities.identities(id),
 region_id uuid NOT NULL REFERENCES whaleu_campus.operating_regions(id),
 title text NOT NULL,
 body_text text NOT NULL,
 organizer_label text NOT NULL,
 activity_time text,
 activity_location text,
 reward boolean,
 online boolean,
 source_created_at timestamptz CHECK(source_created_at IS NULL OR isfinite(source_created_at)),
 source_updated_at timestamptz CHECK(source_updated_at IS NULL OR isfinite(source_updated_at)),
 source_start_at timestamptz CHECK(source_start_at IS NULL OR isfinite(source_start_at)),
 source_end_at timestamptz CHECK(source_end_at IS NULL OR isfinite(source_end_at)),
 cover_state text NOT NULL CHECK(cover_state IN ('absent','unavailable')),
 avatar_state text NOT NULL CHECK(avatar_state IN ('absent','unavailable')),
 gallery_state text NOT NULL CHECK(gallery_state IN ('known_empty','unavailable')),
 qr_state text NOT NULL CHECK(qr_state IN ('absent','unavailable')),
 -- Unprojected import evidence retains original fields/links and uncertain facts.
 source_fields jsonb NOT NULL CHECK(jsonb_typeof(source_fields)='object'),
 provenance text NOT NULL CHECK(provenance IN ('accepted','unknown','conflicting')),
 source_reference text NOT NULL CHECK(length(btrim(source_reference))>0),
 policy_reference text NOT NULL CHECK(length(btrim(policy_reference))>0),
 sealed boolean NOT NULL DEFAULT false,
 UNIQUE(id,activity_id,region_id)
);
CREATE TABLE whaleu_activities.catalog_revisions (
 id uuid PRIMARY KEY,
 region_id uuid NOT NULL REFERENCES whaleu_campus.operating_regions(id),
 coverage text NOT NULL CHECK(coverage IN ('complete','missing','conflicting')),
 provenance text NOT NULL CHECK(provenance IN ('accepted','unknown','conflicting')),
 source_reference text NOT NULL CHECK(length(btrim(source_reference))>0),
 policy_reference text NOT NULL CHECK(length(btrim(policy_reference))>0),
 ordering_version text NOT NULL CHECK(ordering_version='source-created-desc-v1'),
 ordering_reference text NOT NULL CHECK(length(btrim(ordering_reference))>0),
 effective_at timestamptz NOT NULL CHECK(isfinite(effective_at)),
 expiry_kind text NOT NULL CHECK(expiry_kind IN ('at','policy_exempt','unknown')),
 valid_until timestamptz,
 expected_count bigint NOT NULL CHECK(expected_count>=0),
 sealed boolean NOT NULL DEFAULT false,
 UNIQUE(id,region_id),
 CHECK((expiry_kind='at' AND valid_until IS NOT NULL AND isfinite(valid_until) AND valid_until>effective_at) OR (expiry_kind<>'at' AND valid_until IS NULL))
);
CREATE TABLE whaleu_activities.catalog_entries (
 catalog_revision_id uuid NOT NULL,
 region_id uuid NOT NULL,
 activity_id uuid NOT NULL,
 content_revision_id uuid NOT NULL,
 display_ordinal bigint NOT NULL CHECK(display_ordinal>=0),
 lifecycle text NOT NULL CHECK(lifecycle IN ('active','inactive')),
 publication_state text NOT NULL CHECK(publication_state IN ('approved','pending','rejected','unknown')),
 approval_provenance text NOT NULL CHECK(approval_provenance IN ('accepted','unknown','conflicting')),
 approved_content_revision uuid,
 approval_source_reference text,
 approval_policy_reference text,
 PRIMARY KEY(catalog_revision_id,activity_id),
 UNIQUE(catalog_revision_id,display_ordinal),
 FOREIGN KEY(catalog_revision_id,region_id) REFERENCES whaleu_activities.catalog_revisions(id,region_id),
 FOREIGN KEY(content_revision_id,activity_id,region_id) REFERENCES whaleu_activities.content_revisions(id,activity_id,region_id),
 CHECK(approved_content_revision IS NULL OR approved_content_revision=content_revision_id)
);
CREATE TABLE whaleu_activities.catalog_head (
 region_id uuid PRIMARY KEY REFERENCES whaleu_campus.operating_regions(id),
 revision_id uuid NOT NULL,
 FOREIGN KEY(revision_id,region_id) REFERENCES whaleu_activities.catalog_revisions(id,region_id)
);
-- Global owner history, never per-region unread state. Coverage is immutable and
-- separately headed, so uncertain source history cannot become a fresh account.
CREATE TABLE whaleu_activities.owner_visit_coverage (
 id uuid PRIMARY KEY,
 account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
 history_state text NOT NULL CHECK(history_state IN ('never_visited','visited','unavailable')),
 source_last_visited_at timestamptz CHECK(source_last_visited_at IS NULL OR isfinite(source_last_visited_at)),
 coverage text NOT NULL CHECK(coverage IN ('complete','missing','conflicting')),
 provenance text NOT NULL CHECK(provenance IN ('accepted','unknown','conflicting')),
 source_reference text NOT NULL CHECK(length(btrim(source_reference))>0),
 policy_reference text NOT NULL CHECK(length(btrim(policy_reference))>0),
 effective_at timestamptz NOT NULL CHECK(isfinite(effective_at)),
 expiry_kind text NOT NULL CHECK(expiry_kind IN ('at','policy_exempt','unknown')),
 valid_until timestamptz,
 UNIQUE(id,account_id),
 CHECK(history_state='visited' OR source_last_visited_at IS NULL),
 CHECK((expiry_kind='at' AND valid_until IS NOT NULL AND isfinite(valid_until) AND valid_until>effective_at) OR (expiry_kind<>'at' AND valid_until IS NULL))
);
CREATE TABLE whaleu_activities.owner_visit_head (
 account_id uuid PRIMARY KEY REFERENCES whaleu_identity.accounts(id),
 coverage_id uuid NOT NULL,
 FOREIGN KEY(coverage_id,account_id) REFERENCES whaleu_activities.owner_visit_coverage(id,account_id)
);
CREATE TABLE whaleu_activities.owner_visit_receipts (
 account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
 request_id uuid NOT NULL,
 region_id uuid NOT NULL,
 catalog_revision_id uuid NOT NULL,
 visited_at timestamptz NOT NULL CHECK(isfinite(visited_at)),
 PRIMARY KEY(account_id,request_id),
 FOREIGN KEY(catalog_revision_id,region_id) REFERENCES whaleu_activities.catalog_revisions(id,region_id)
);
CREATE INDEX activities_catalog_order ON whaleu_activities.catalog_entries(catalog_revision_id,display_ordinal DESC) WHERE lifecycle='active';
CREATE INDEX activities_created_at ON whaleu_activities.content_revisions(source_created_at,id);
CREATE INDEX activities_latest_visit ON whaleu_activities.owner_visit_receipts(account_id,visited_at DESC);
CREATE FUNCTION whaleu_activities.writer_gate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM pg_advisory_xact_lock(hashtextextended('whaleu:named-block-policy:v1',0)); RETURN NULL; END $$;
CREATE FUNCTION whaleu_activities.immutable_row() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Activity identity and owner history are immutable'; END $$;
CREATE FUNCTION whaleu_activities.freeze_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE child_count bigint;
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.sealed THEN RAISE EXCEPTION 'Sealed activity revision is immutable'; END IF;
  RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' AND (OLD.sealed OR NEW.id<>OLD.id) THEN RAISE EXCEPTION 'Activity revision cannot be changed'; END IF;
 IF NEW.sealed THEN
  IF NEW.provenance<>'accepted' THEN RAISE EXCEPTION 'Activity revision requires accepted evidence'; END IF;
  IF TG_TABLE_NAME='content_revisions' THEN
   IF NOT EXISTS(SELECT 1 FROM whaleu_activities.identities WHERE id=NEW.activity_id AND provenance='accepted') THEN RAISE EXCEPTION 'Activity identity requires accepted evidence'; END IF;
  ELSE
   IF NEW.coverage<>'complete' OR NEW.expiry_kind='unknown' THEN RAISE EXCEPTION 'Activity catalog requires complete evidence'; END IF;
   SELECT count(*) INTO child_count FROM whaleu_activities.catalog_entries WHERE catalog_revision_id=NEW.id;
   IF child_count<>NEW.expected_count THEN RAISE EXCEPTION 'Activity catalog coverage mismatch'; END IF;
   IF EXISTS(SELECT 1 FROM whaleu_activities.catalog_entries e JOIN whaleu_activities.content_revisions r ON r.id=e.content_revision_id WHERE e.catalog_revision_id=NEW.id AND (NOT r.sealed OR r.provenance<>'accepted' OR e.publication_state<>'approved' OR e.approval_provenance<>'accepted' OR e.approved_content_revision IS DISTINCT FROM e.content_revision_id OR e.approval_source_reference IS NULL OR length(btrim(e.approval_source_reference))=0 OR e.approval_policy_reference IS NULL OR length(btrim(e.approval_policy_reference))=0)) THEN RAISE EXCEPTION 'Activity publication must bind accepted immutable content and region'; END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION whaleu_activities.freeze_child() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE frozen boolean;
BEGIN
 IF TG_OP='UPDATE' AND NEW.catalog_revision_id<>OLD.catalog_revision_id THEN RAISE EXCEPTION 'Activity entry cannot be moved'; END IF;
 SELECT sealed INTO frozen FROM whaleu_activities.catalog_revisions WHERE id=CASE WHEN TG_OP='DELETE' THEN OLD.catalog_revision_id ELSE NEW.catalog_revision_id END FOR SHARE;
 IF frozen THEN RAISE EXCEPTION 'Sealed activity facts are immutable'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION whaleu_activities.reject_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Activity canonical history cannot be truncated'; END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['identities','content_revisions','catalog_revisions','catalog_entries','catalog_head','owner_visit_coverage','owner_visit_head'] LOOP
  EXECUTE format('CREATE TRIGGER a_activities_writer_gate BEFORE INSERT OR UPDATE OR DELETE ON whaleu_activities.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_activities.writer_gate()',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['identities','owner_visit_coverage','owner_visit_receipts'] LOOP
  EXECUTE format('CREATE TRIGGER activities_immutable BEFORE UPDATE OR DELETE ON whaleu_activities.%I FOR EACH ROW EXECUTE FUNCTION whaleu_activities.immutable_row()',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['content_revisions','catalog_revisions'] LOOP
  EXECUTE format('CREATE TRIGGER activities_freeze_revision BEFORE INSERT OR UPDATE OR DELETE ON whaleu_activities.%I FOR EACH ROW EXECUTE FUNCTION whaleu_activities.freeze_revision()',t);
 END LOOP;
 CREATE TRIGGER activities_freeze_child BEFORE INSERT OR UPDATE OR DELETE ON whaleu_activities.catalog_entries FOR EACH ROW EXECUTE FUNCTION whaleu_activities.freeze_child();
 FOREACH t IN ARRAY ARRAY['identities','content_revisions','catalog_revisions','catalog_entries','catalog_head','owner_visit_coverage','owner_visit_head','owner_visit_receipts'] LOOP
  EXECUTE format('CREATE TRIGGER activities_no_truncate BEFORE TRUNCATE ON whaleu_activities.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_activities.reject_truncate()',t);
 END LOOP;
END $$;
