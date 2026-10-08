-- Empty canonical owner storage. No runtime issuer, import, media or admin API.
-- Authority writers acquire the exclusive shared policy gate before row locks.
CREATE SCHEMA whaleu_announcements;
CREATE TABLE whaleu_announcements.identities (
 id uuid PRIMARY KEY,
 origin_kind text NOT NULL CHECK(origin_kind IN ('fresh_local','preserved')),
 provenance text NOT NULL CHECK(provenance IN ('accepted','unknown','conflicting')),
 source_reference text NOT NULL CHECK(length(btrim(source_reference))>0),
 policy_reference text NOT NULL CHECK(length(btrim(policy_reference))>0)
);
CREATE TABLE whaleu_announcements.content_revisions (
 id uuid PRIMARY KEY,
 announcement_id uuid NOT NULL REFERENCES whaleu_announcements.identities(id),
 version_label text NOT NULL,
 title text NOT NULL,
 body_text text NOT NULL,
 announcement_date date,
 source_created_at timestamptz,
 source_updated_at timestamptz,
 highlight boolean NOT NULL,
 popup_enabled boolean NOT NULL,
 popup_title_state text NOT NULL CHECK(popup_title_state IN ('absent','value','unknown')),
 popup_title text,
 popup_body_state text NOT NULL CHECK(popup_body_state IN ('absent','value','unknown')),
 popup_body_text text,
 media_state text NOT NULL CHECK(media_state IN ('known_empty','unavailable')),
 audience_kind text NOT NULL CHECK(audience_kind IN ('all_browsers','browse_campus_set')),
 expected_campus_count integer NOT NULL CHECK(expected_campus_count>=0),
 provenance text NOT NULL CHECK(provenance IN ('accepted','unknown','conflicting')),
 source_reference text NOT NULL CHECK(length(btrim(source_reference))>0),
 policy_reference text NOT NULL CHECK(length(btrim(policy_reference))>0),
 sealed boolean NOT NULL DEFAULT false,
 UNIQUE(id,announcement_id),
 CHECK((popup_title_state='value')=(popup_title IS NOT NULL)),
 CHECK((popup_body_state='value')=(popup_body_text IS NOT NULL)),
 CHECK((audience_kind='all_browsers' AND expected_campus_count=0) OR (audience_kind='browse_campus_set' AND expected_campus_count>0)),
 CHECK(source_created_at IS NULL OR isfinite(source_created_at)),
 CHECK(source_updated_at IS NULL OR isfinite(source_updated_at)),
 CHECK(announcement_date IS NULL OR isfinite(announcement_date))
);
CREATE TABLE whaleu_announcements.campus_audiences (
 content_revision_id uuid NOT NULL REFERENCES whaleu_announcements.content_revisions(id),
 campus_id uuid NOT NULL REFERENCES whaleu_campus.campuses(id),
 provenance text NOT NULL CHECK(provenance='accepted'),
 source_reference text NOT NULL CHECK(length(btrim(source_reference))>0),
 policy_reference text NOT NULL CHECK(length(btrim(policy_reference))>0),
 PRIMARY KEY(content_revision_id,campus_id)
);
CREATE TABLE whaleu_announcements.catalog_revisions (
 id uuid PRIMARY KEY,
 coverage text NOT NULL CHECK(coverage IN ('complete','missing','conflicting')),
 provenance text NOT NULL CHECK(provenance IN ('accepted','unknown','conflicting')),
 source_reference text NOT NULL CHECK(length(btrim(source_reference))>0),
 policy_reference text NOT NULL CHECK(length(btrim(policy_reference))>0),
 ordering_version text NOT NULL CHECK(ordering_version='source-id-desc-v1'),
 ordering_reference text NOT NULL CHECK(length(btrim(ordering_reference))>0),
 effective_at timestamptz NOT NULL CHECK(isfinite(effective_at)),
 expiry_kind text NOT NULL CHECK(expiry_kind IN ('at','policy_exempt','unknown')),
 valid_until timestamptz,
 expected_count bigint NOT NULL CHECK(expected_count>=0),
 sealed boolean NOT NULL DEFAULT false,
 CHECK((expiry_kind='at' AND valid_until IS NOT NULL AND isfinite(valid_until) AND valid_until>effective_at) OR (expiry_kind<>'at' AND valid_until IS NULL))
);
CREATE TABLE whaleu_announcements.catalog_entries (
 catalog_revision_id uuid NOT NULL REFERENCES whaleu_announcements.catalog_revisions(id),
 announcement_id uuid NOT NULL,
 content_revision_id uuid NOT NULL,
 source_ordinal bigint NOT NULL CHECK(source_ordinal>=0),
 lifecycle text NOT NULL CHECK(lifecycle IN ('active','inactive')),
 publication_state text NOT NULL CHECK(publication_state IN ('approved','pending','rejected','unknown')),
 approval_provenance text NOT NULL CHECK(approval_provenance IN ('accepted','unknown','conflicting')),
 approved_content_revision uuid,
 approval_source_reference text,
 approval_policy_reference text,
 PRIMARY KEY(catalog_revision_id,announcement_id),
 UNIQUE(catalog_revision_id,source_ordinal),
 FOREIGN KEY(content_revision_id,announcement_id) REFERENCES whaleu_announcements.content_revisions(id,announcement_id),
 CHECK(approved_content_revision IS NULL OR approved_content_revision=content_revision_id)
);
CREATE TABLE whaleu_announcements.catalog_head (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 revision_id uuid NOT NULL REFERENCES whaleu_announcements.catalog_revisions(id)
);
-- Coverage is per stable ID and owner, never inferred from an ambiguous version key.
CREATE TABLE whaleu_announcements.owner_history_coverage (
 account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
 announcement_id uuid NOT NULL REFERENCES whaleu_announcements.identities(id),
 coverage text NOT NULL CHECK(coverage IN ('complete','missing','conflicting')),
 provenance text NOT NULL CHECK(provenance IN ('accepted','unknown','conflicting')),
 source_reference text NOT NULL CHECK(length(btrim(source_reference))>0),
 policy_reference text NOT NULL CHECK(length(btrim(policy_reference))>0),
 effective_at timestamptz NOT NULL CHECK(isfinite(effective_at)),
 expiry_kind text NOT NULL CHECK(expiry_kind IN ('at','policy_exempt','unknown')),
 valid_until timestamptz,
 PRIMARY KEY(account_id,announcement_id),
 CHECK((expiry_kind='at' AND valid_until IS NOT NULL AND isfinite(valid_until) AND valid_until>effective_at) OR (expiry_kind<>'at' AND valid_until IS NULL))
);
CREATE TABLE whaleu_announcements.popup_acknowledgements (
 account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
 announcement_id uuid NOT NULL REFERENCES whaleu_announcements.identities(id),
 acknowledged_at timestamptz,
 origin_kind text NOT NULL CHECK(origin_kind IN ('local','preserved')),
 provenance text NOT NULL CHECK(provenance='accepted'),
 source_reference text,
 PRIMARY KEY(account_id,announcement_id),
 CHECK(acknowledged_at IS NULL OR isfinite(acknowledged_at)),
 CHECK((origin_kind='local' AND acknowledged_at IS NOT NULL AND source_reference IS NULL) OR (origin_kind='preserved' AND source_reference IS NOT NULL AND length(btrim(source_reference))>0))
);
CREATE INDEX announcements_catalog_order ON whaleu_announcements.catalog_entries(catalog_revision_id,source_ordinal DESC) WHERE lifecycle='active';
CREATE INDEX announcements_campus_membership ON whaleu_announcements.campus_audiences(campus_id,content_revision_id);
CREATE INDEX announcements_created_at ON whaleu_announcements.content_revisions(source_created_at,id);

CREATE FUNCTION whaleu_announcements.writer_gate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('whaleu:named-block-policy:v1',0));
 RETURN NULL;
END $$;
CREATE FUNCTION whaleu_announcements.immutable_row() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Announcement identity and acknowledgement are immutable'; END $$;
CREATE FUNCTION whaleu_announcements.freeze_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE child_count bigint;
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.sealed THEN RAISE EXCEPTION 'Sealed announcement revision is immutable'; END IF;
  RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' AND (OLD.sealed OR NEW.id<>OLD.id) THEN RAISE EXCEPTION 'Announcement revision cannot be changed'; END IF;
 IF NEW.sealed THEN
  IF NEW.provenance<>'accepted' THEN RAISE EXCEPTION 'Announcement revision requires accepted evidence'; END IF;
  IF TG_TABLE_NAME='content_revisions' THEN
   IF NOT EXISTS(SELECT 1 FROM whaleu_announcements.identities WHERE id=NEW.announcement_id AND provenance='accepted') THEN RAISE EXCEPTION 'Announcement identity requires accepted evidence'; END IF;
   SELECT count(*) INTO child_count FROM whaleu_announcements.campus_audiences WHERE content_revision_id=NEW.id;
   IF child_count<>NEW.expected_campus_count THEN RAISE EXCEPTION 'Announcement audience coverage mismatch'; END IF;
  ELSE
   IF NEW.coverage<>'complete' OR NEW.expiry_kind='unknown' THEN RAISE EXCEPTION 'Announcement catalog requires complete evidence'; END IF;
   SELECT count(*) INTO child_count FROM whaleu_announcements.catalog_entries WHERE catalog_revision_id=NEW.id;
   IF child_count<>NEW.expected_count THEN RAISE EXCEPTION 'Announcement catalog coverage mismatch'; END IF;
   IF EXISTS(SELECT 1 FROM whaleu_announcements.catalog_entries e JOIN whaleu_announcements.content_revisions r ON r.id=e.content_revision_id WHERE e.catalog_revision_id=NEW.id AND (NOT r.sealed OR r.provenance<>'accepted' OR e.publication_state<>'approved' OR e.approval_provenance<>'accepted' OR e.approved_content_revision IS DISTINCT FROM e.content_revision_id OR e.approval_source_reference IS NULL OR length(btrim(e.approval_source_reference))=0 OR e.approval_policy_reference IS NULL OR length(btrim(e.approval_policy_reference))=0)) THEN RAISE EXCEPTION 'Announcement publication must bind accepted immutable content and audience'; END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION whaleu_announcements.freeze_child() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE frozen boolean;
BEGIN
 IF TG_TABLE_NAME='campus_audiences' THEN
  IF TG_OP='UPDATE' AND NEW.content_revision_id<>OLD.content_revision_id THEN RAISE EXCEPTION 'Announcement audience cannot be moved'; END IF;
  SELECT sealed INTO frozen FROM whaleu_announcements.content_revisions WHERE id=CASE WHEN TG_OP='DELETE' THEN OLD.content_revision_id ELSE NEW.content_revision_id END FOR SHARE;
 ELSE
  IF TG_OP='UPDATE' AND NEW.catalog_revision_id<>OLD.catalog_revision_id THEN RAISE EXCEPTION 'Announcement entry cannot be moved'; END IF;
  SELECT sealed INTO frozen FROM whaleu_announcements.catalog_revisions WHERE id=CASE WHEN TG_OP='DELETE' THEN OLD.catalog_revision_id ELSE NEW.catalog_revision_id END FOR SHARE;
 END IF;
 IF frozen THEN RAISE EXCEPTION 'Sealed announcement facts are immutable'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION whaleu_announcements.reject_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Announcement canonical history cannot be truncated'; END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['identities','content_revisions','campus_audiences','catalog_revisions','catalog_entries','catalog_head','owner_history_coverage'] LOOP
  EXECUTE format('CREATE TRIGGER a_announcements_writer_gate BEFORE INSERT OR UPDATE OR DELETE ON whaleu_announcements.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_announcements.writer_gate()',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['identities','popup_acknowledgements'] LOOP
  EXECUTE format('CREATE TRIGGER announcements_immutable BEFORE UPDATE OR DELETE ON whaleu_announcements.%I FOR EACH ROW EXECUTE FUNCTION whaleu_announcements.immutable_row()',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['content_revisions','catalog_revisions'] LOOP
  EXECUTE format('CREATE TRIGGER announcements_freeze_revision BEFORE INSERT OR UPDATE OR DELETE ON whaleu_announcements.%I FOR EACH ROW EXECUTE FUNCTION whaleu_announcements.freeze_revision()',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['campus_audiences','catalog_entries'] LOOP
  EXECUTE format('CREATE TRIGGER announcements_freeze_child BEFORE INSERT OR UPDATE OR DELETE ON whaleu_announcements.%I FOR EACH ROW EXECUTE FUNCTION whaleu_announcements.freeze_child()',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['identities','content_revisions','campus_audiences','catalog_revisions','catalog_entries','catalog_head','owner_history_coverage','popup_acknowledgements'] LOOP
  EXECUTE format('CREATE TRIGGER announcements_no_truncate BEFORE TRUNCATE ON whaleu_announcements.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_announcements.reject_truncate()',t);
 END LOOP;
END $$;
