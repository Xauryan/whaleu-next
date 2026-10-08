-- Empty owner storage. No source issuer, grants, import, provider, or example rows.
-- Catalog acceptance is an explicit offline authority operation, not a public API.
-- Every writer takes the shared Safety owner's exclusive gate before other locks.
CREATE SCHEMA whaleu_organizations;
CREATE TABLE whaleu_organizations.directory_taxonomy_revisions (
 id uuid PRIMARY KEY,
 kind text NOT NULL CHECK(kind IN ('school','org','official')),
 scope text NOT NULL CHECK(scope IN ('regional','global')),
 region_id uuid REFERENCES whaleu_campus.operating_regions(id),
 coverage text NOT NULL CHECK(coverage IN ('complete','missing','conflicting')),
 provenance text NOT NULL CHECK(provenance IN ('accepted','unknown','conflicting')),
 source_reference text,
 policy_reference text,
 effective_at timestamptz NOT NULL,
 expiry_kind text NOT NULL CHECK(expiry_kind IN ('at','policy_exempt','unknown')),
 valid_until timestamptz,
 expected_count integer NOT NULL CHECK(expected_count >= 0),
 sealed boolean NOT NULL DEFAULT false,
 CHECK((kind='official' AND scope='global' AND region_id IS NULL) OR (kind<>'official' AND scope='regional' AND region_id IS NOT NULL)),
 CHECK((expiry_kind='at' AND valid_until IS NOT NULL AND valid_until>effective_at) OR (expiry_kind<>'at' AND valid_until IS NULL)),
 UNIQUE(id,kind)
);
CREATE TABLE whaleu_organizations.directory_categories (
 taxonomy_revision_id uuid NOT NULL REFERENCES whaleu_organizations.directory_taxonomy_revisions(id),
 id uuid NOT NULL,
 name text NOT NULL CHECK(length(name)>0),
 description text NOT NULL,
 accent text NOT NULL CHECK(accent IN ('green','orange','red','yellow','lilac','purple','coral','cyan')),
 lifecycle text NOT NULL CHECK(lifecycle IN ('active','inactive','unknown')),
 source_system text NOT NULL CHECK(length(source_system)>0),
 source_id text NOT NULL CHECK(length(source_id)>0),
 source_revision text NOT NULL CHECK(length(source_revision)>0),
 accepted_revision text,
 display_ordinal bigint NOT NULL CHECK(display_ordinal>=0),
 PRIMARY KEY(taxonomy_revision_id,id),
 UNIQUE(taxonomy_revision_id,display_ordinal),
 UNIQUE(taxonomy_revision_id,source_system,source_id)
);
CREATE TABLE whaleu_organizations.directory_catalog_revisions (
 id uuid PRIMARY KEY,
 region_id uuid NOT NULL REFERENCES whaleu_campus.operating_regions(id),
 kind text NOT NULL CHECK(kind IN ('school','org','official')),
 taxonomy_revision_id uuid NOT NULL,
 coverage text NOT NULL CHECK(coverage IN ('complete','missing','conflicting')),
 provenance text NOT NULL CHECK(provenance IN ('accepted','unknown','conflicting')),
 source_reference text,
 policy_reference text,
 ordering_version text NOT NULL CHECK(ordering_version='source-snapshot-v1'),
 ordering_reference text,
 effective_at timestamptz NOT NULL,
 expiry_kind text NOT NULL CHECK(expiry_kind IN ('at','policy_exempt','unknown')),
 valid_until timestamptz,
 expected_count integer NOT NULL CHECK(expected_count>=0),
 sealed boolean NOT NULL DEFAULT false,
 FOREIGN KEY(taxonomy_revision_id,kind) REFERENCES whaleu_organizations.directory_taxonomy_revisions(id,kind),
 CHECK((expiry_kind='at' AND valid_until IS NOT NULL AND valid_until>effective_at) OR (expiry_kind<>'at' AND valid_until IS NULL)),
 UNIQUE(id,region_id,kind),
 UNIQUE(id,taxonomy_revision_id)
);
CREATE TABLE whaleu_organizations.directory_entries (
 catalog_revision_id uuid NOT NULL,
 taxonomy_revision_id uuid NOT NULL,
 id uuid NOT NULL,
 category_id uuid NOT NULL,
 content_revision uuid NOT NULL,
 platform text NOT NULL CHECK(platform IN ('qq','wechat','official')),
 name text NOT NULL CHECK(length(name)>0),
 intro_text text NOT NULL,
 badge_state text NOT NULL CHECK(badge_state IN ('known','unknown')),
 badge text CHECK(badge IN ('normal','official','partner')),
 media jsonb NOT NULL CHECK(jsonb_typeof(media)='object'),
 qq_state text NOT NULL CHECK(qq_state IN ('known','unknown','not_applicable')),
 qq_number text,
 publication_state text NOT NULL CHECK(publication_state IN ('approved','pending','rejected','unknown')),
 approval_provenance text NOT NULL CHECK(approval_provenance IN ('accepted','unknown','conflicting')),
 approved_content_revision uuid,
 approval_source_reference text,
 approval_policy_reference text,
 source_created_at timestamptz,
 source_updated_at timestamptz,
 historical_visits bigint CHECK(historical_visits>=0),
 source_system text NOT NULL CHECK(length(source_system)>0),
 source_id text NOT NULL CHECK(length(source_id)>0),
 source_revision text NOT NULL CHECK(length(source_revision)>0),
 display_ordinal bigint NOT NULL CHECK(display_ordinal>=0),
 search_ordinal bigint NOT NULL CHECK(search_ordinal>=0),
 PRIMARY KEY(catalog_revision_id,id),
 FOREIGN KEY(catalog_revision_id,taxonomy_revision_id) REFERENCES whaleu_organizations.directory_catalog_revisions(id,taxonomy_revision_id),
 FOREIGN KEY(taxonomy_revision_id,category_id) REFERENCES whaleu_organizations.directory_categories(taxonomy_revision_id,id),
 UNIQUE(catalog_revision_id,display_ordinal),
 UNIQUE(catalog_revision_id,search_ordinal),
 UNIQUE(catalog_revision_id,source_system,source_id),
 CHECK(badge_state='known' OR badge IS NULL),
 CHECK((platform='qq' AND qq_state IN ('known','unknown')) OR (platform<>'qq' AND qq_state='not_applicable')),
 CHECK((qq_state='known' AND (qq_number IS NULL OR qq_number ~ '^[0-9]{5,16}$')) OR (qq_state<>'known' AND qq_number IS NULL)),
 CHECK(approved_content_revision IS NULL OR approved_content_revision=content_revision),
 CHECK(approval_provenance<>'accepted' OR (publication_state IN ('approved','pending','rejected') AND approved_content_revision IS NOT NULL AND approved_content_revision=content_revision AND approval_source_reference IS NOT NULL AND length(approval_source_reference)>0 AND approval_policy_reference IS NOT NULL AND length(approval_policy_reference)>0))
);
CREATE TABLE whaleu_organizations.directory_taxonomy_heads (
 kind text NOT NULL CHECK(kind IN ('school','org','official')),
 region_id uuid REFERENCES whaleu_campus.operating_regions(id),
 revision_id uuid NOT NULL,
 UNIQUE NULLS NOT DISTINCT(kind,region_id),
 FOREIGN KEY(revision_id,kind) REFERENCES whaleu_organizations.directory_taxonomy_revisions(id,kind),
 CHECK((kind='official' AND region_id IS NULL) OR (kind<>'official' AND region_id IS NOT NULL))
);
CREATE TABLE whaleu_organizations.directory_catalog_heads (
 region_id uuid NOT NULL,
 kind text NOT NULL,
 revision_id uuid NOT NULL,
 PRIMARY KEY(region_id,kind),
 FOREIGN KEY(revision_id,region_id,kind) REFERENCES whaleu_organizations.directory_catalog_revisions(id,region_id,kind)
);
CREATE INDEX directory_entries_category_order ON whaleu_organizations.directory_entries(catalog_revision_id,category_id,display_ordinal);
CREATE INDEX directory_entries_search_order ON whaleu_organizations.directory_entries(catalog_revision_id,search_ordinal);

CREATE FUNCTION whaleu_organizations.directory_writer_gate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('whaleu:named-block-policy:v1',0));
 RETURN NULL;
END $$;
CREATE FUNCTION whaleu_organizations.directory_freeze_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE child_count bigint; taxonomy record;
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.sealed THEN RAISE EXCEPTION 'Sealed directory revision is immutable'; END IF;
  RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' AND OLD.sealed THEN RAISE EXCEPTION 'Sealed directory revision is immutable'; END IF;
 IF NEW.sealed THEN
  IF NEW.coverage<>'complete' OR NEW.provenance<>'accepted' OR NEW.source_reference IS NULL OR length(NEW.source_reference)=0 OR NEW.policy_reference IS NULL OR length(NEW.policy_reference)=0 OR NEW.expiry_kind='unknown' THEN RAISE EXCEPTION 'Directory revision requires complete accepted evidence'; END IF;
  IF TG_TABLE_NAME='directory_taxonomy_revisions' THEN
   SELECT count(*) INTO child_count FROM whaleu_organizations.directory_categories WHERE taxonomy_revision_id=NEW.id;
   IF EXISTS(SELECT 1 FROM whaleu_organizations.directory_categories WHERE taxonomy_revision_id=NEW.id AND (lifecycle='unknown' OR accepted_revision IS DISTINCT FROM source_revision)) THEN RAISE EXCEPTION 'Directory taxonomy requires current lifecycle evidence'; END IF;
  ELSE
   SELECT * INTO taxonomy FROM whaleu_organizations.directory_taxonomy_revisions WHERE id=NEW.taxonomy_revision_id FOR SHARE;
   IF NOT taxonomy.sealed OR taxonomy.kind<>NEW.kind OR (taxonomy.scope='regional' AND taxonomy.region_id<>NEW.region_id) THEN RAISE EXCEPTION 'Directory taxonomy scope mismatch'; END IF;
   IF NEW.ordering_reference IS NULL OR length(NEW.ordering_reference)=0 THEN RAISE EXCEPTION 'Directory ordering requires source evidence'; END IF;
   SELECT count(*) INTO child_count FROM whaleu_organizations.directory_entries WHERE catalog_revision_id=NEW.id;
  END IF;
  IF child_count<>NEW.expected_count THEN RAISE EXCEPTION 'Directory population coverage mismatch'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION whaleu_organizations.directory_freeze_record() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE frozen boolean;
BEGIN
 IF TG_TABLE_NAME='directory_categories' THEN
  SELECT sealed INTO frozen FROM whaleu_organizations.directory_taxonomy_revisions WHERE id=CASE WHEN TG_OP='DELETE' THEN OLD.taxonomy_revision_id ELSE NEW.taxonomy_revision_id END FOR SHARE;
  IF TG_OP='UPDATE' AND NEW.taxonomy_revision_id<>OLD.taxonomy_revision_id THEN RAISE EXCEPTION 'Directory revision cannot be moved'; END IF;
 ELSE
  SELECT sealed INTO frozen FROM whaleu_organizations.directory_catalog_revisions WHERE id=CASE WHEN TG_OP='DELETE' THEN OLD.catalog_revision_id ELSE NEW.catalog_revision_id END FOR SHARE;
  IF TG_OP='UPDATE' AND NEW.catalog_revision_id<>OLD.catalog_revision_id THEN RAISE EXCEPTION 'Directory revision cannot be moved'; END IF;
 END IF;
 IF frozen THEN RAISE EXCEPTION 'Sealed directory records are immutable'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['directory_taxonomy_revisions','directory_categories','directory_catalog_revisions','directory_entries','directory_taxonomy_heads','directory_catalog_heads'] LOOP
  EXECUTE format('CREATE TRIGGER a_directory_writer_gate BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_organizations.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_organizations.directory_writer_gate()',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['directory_taxonomy_revisions','directory_catalog_revisions'] LOOP
  EXECUTE format('CREATE TRIGGER directory_freeze_revision BEFORE INSERT OR UPDATE OR DELETE ON whaleu_organizations.%I FOR EACH ROW EXECUTE FUNCTION whaleu_organizations.directory_freeze_revision()',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['directory_categories','directory_entries'] LOOP
  EXECUTE format('CREATE TRIGGER directory_freeze_record BEFORE INSERT OR UPDATE OR DELETE ON whaleu_organizations.%I FOR EACH ROW EXECUTE FUNCTION whaleu_organizations.directory_freeze_record()',t);
 END LOOP;
END $$;
-- TRUNCATE/DDL remains operator-only and must acquire the outer gate before
-- relation locks. No runtime code exposes those maintenance operations.
