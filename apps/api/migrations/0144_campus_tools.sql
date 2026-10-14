-- Public campus tools have their own immutable source/admission/media owner.
-- No historical source, publisher role, trusted authority or provider is seeded.
CREATE SCHEMA whaleu_campus_tools;
CREATE TABLE whaleu_campus_tools.admissions (
  id uuid PRIMARY KEY,
  campus_id uuid NOT NULL REFERENCES whaleu_campus.campuses(id),
  request_key uuid NOT NULL,
  catalog_id uuid NOT NULL UNIQUE,
  input_digest text NOT NULL CHECK(input_digest ~ '^[a-f0-9]{64}$'),
  authority_reference text NOT NULL CHECK(length(authority_reference) BETWEEN 1 AND 300),
  authority_proof text NOT NULL CHECK(length(authority_proof) BETWEEN 1 AND 4096),
  previous_head uuid,
  receipt jsonb NOT NULL CHECK(jsonb_typeof(receipt)='object'),
  CHECK(receipt ?& ARRAY['admissionId','campusId','catalogId','previousHead','digest','authorityReference','entries','media']),
  CHECK(receipt - ARRAY['admissionId','campusId','catalogId','previousHead','digest','authorityReference','entries','media'] = '{}'::jsonb),
  CHECK(receipt->>'admissionId'=id::text AND receipt->>'campusId'=campus_id::text AND receipt->>'catalogId'=catalog_id::text AND receipt->>'digest'=input_digest AND receipt->>'authorityReference'=authority_reference),
  CHECK(receipt->>'previousHead' IS NOT DISTINCT FROM previous_head::text),
  CHECK((receipt->>'entries')::integer BETWEEN 0 AND 32 AND (receipt->>'media')::integer BETWEEN 0 AND 32),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(campus_id,request_key),
  UNIQUE(id,campus_id,catalog_id,input_digest)
);
CREATE TABLE whaleu_campus_tools.catalogs (
  id uuid PRIMARY KEY,
  campus_id uuid NOT NULL REFERENCES whaleu_campus.campuses(id),
  admission_id uuid NOT NULL UNIQUE,
  digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),
  canonical text NOT NULL CHECK(octet_length(canonical)<=262144),
  content jsonb NOT NULL CHECK(jsonb_typeof(content)='object'),
  effective_at timestamptz NOT NULL,
  expires_at timestamptz,
  exemption_reference text,
  UNIQUE(id,campus_id),
  FOREIGN KEY(admission_id,campus_id,id,digest) REFERENCES whaleu_campus_tools.admissions(id,campus_id,catalog_id,input_digest) DEFERRABLE INITIALLY DEFERRED,
  CHECK((expires_at IS NOT NULL AND expires_at>effective_at AND exemption_reference IS NULL) OR (expires_at IS NULL AND length(exemption_reference) BETWEEN 1 AND 300)),
  CHECK(content->>'id'=id::text AND content->>'campusId'=campus_id::text),
  CHECK(content->>'coverage'='complete'),
  CHECK(content->>'version'='campus-tools-canonical-v1'),
  CHECK(canonical::jsonb=content),
  CHECK(digest=encode(sha256(convert_to('campus-tools-canonical-v1'||E'\n'||canonical,'UTF8')),'hex')),
  CHECK(effective_at=(content->'validity'->>'effectiveAt')::timestamptz),
  CHECK((content->'validity'->>'kind'='finite' AND expires_at IS NOT DISTINCT FROM (content->'validity'->>'expiresAt')::timestamptz) OR (content->'validity'->>'kind'='policy_exempt' AND exemption_reference=content->'validity'->>'exemptionReference'))
);
ALTER TABLE whaleu_campus_tools.admissions ADD FOREIGN KEY(catalog_id,campus_id) REFERENCES whaleu_campus_tools.catalogs(id,campus_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE whaleu_campus_tools.admissions ADD FOREIGN KEY(previous_head,campus_id) REFERENCES whaleu_campus_tools.catalogs(id,campus_id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE whaleu_campus_tools.heads (
  campus_id uuid PRIMARY KEY REFERENCES whaleu_campus.campuses(id),
  catalog_id uuid NOT NULL,
  FOREIGN KEY(catalog_id,campus_id) REFERENCES whaleu_campus_tools.catalogs(id,campus_id)
);
-- Trusted staging attempts are durable BEFORE immutable provider effects. They
-- are private, non-actionable operational evidence, never an accepted catalog.
CREATE TABLE whaleu_campus_tools.media_attempts (
  id uuid PRIMARY KEY,
  campus_id uuid NOT NULL REFERENCES whaleu_campus.campuses(id),
  input_digest text NOT NULL CHECK(input_digest ~ '^[a-f0-9]{64}$'),
  binding_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  manifest_digest text NOT NULL CHECK(manifest_digest ~ '^[a-f0-9]{64}$'),
  authority_reference text NOT NULL,
  authority_proof text NOT NULL,
  staging jsonb NOT NULL CHECK(jsonb_typeof(staging)='object' AND octet_length(staging::text)<=16384),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(campus_id,input_digest,binding_id),
  UNIQUE(id,manifest_digest)
);
CREATE TABLE whaleu_campus_tools.media_results (
  attempt_id uuid PRIMARY KEY,
  manifest_digest text NOT NULL,
  canonical text NOT NULL CHECK(octet_length(canonical)<=16384),
  manifest jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(attempt_id,manifest_digest) REFERENCES whaleu_campus_tools.media_attempts(id,manifest_digest),
  CHECK(canonical::jsonb=manifest),
  CHECK(manifest_digest=encode(sha256(convert_to('whaleu-media-manifest:v1'||E'\n'||canonical,'UTF8')),'hex')),
  UNIQUE(attempt_id,manifest_digest)
);
CREATE TABLE whaleu_campus_tools.media_bindings (
  id uuid PRIMARY KEY,
  attempt_id uuid NOT NULL UNIQUE,
  campus_id uuid NOT NULL,
  catalog_id uuid NOT NULL,
  entry_id uuid NOT NULL,
  entry_revision uuid NOT NULL,
  group_id text,
  slot_id text NOT NULL CHECK(length(slot_id) BETWEEN 1 AND 64),
  asset_id uuid NOT NULL UNIQUE,
  manifest_digest text NOT NULL CHECK(manifest_digest ~ '^[a-f0-9]{64}$'),
  manifest jsonb NOT NULL,
  FOREIGN KEY(attempt_id,manifest_digest) REFERENCES whaleu_campus_tools.media_results(attempt_id,manifest_digest),
  FOREIGN KEY(catalog_id,campus_id) REFERENCES whaleu_campus_tools.catalogs(id,campus_id),
  UNIQUE NULLS NOT DISTINCT(catalog_id,entry_id,group_id,slot_id)
);
CREATE FUNCTION whaleu_campus_tools.immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Campus tools accepted history is immutable' USING ERRCODE='23514'; END $$;
CREATE FUNCTION whaleu_campus_tools.check_media_result() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source jsonb;
BEGIN
 SELECT staging INTO source FROM whaleu_campus_tools.media_attempts WHERE id=NEW.attempt_id AND manifest_digest=NEW.manifest_digest;
 IF NOT FOUND OR NEW.manifest#>'{original,object}' IS DISTINCT FROM source->'original'
  OR NEW.manifest#>'{variants,0,object}' IS DISTINCT FROM source#>'{destinations,0}'
  OR NEW.manifest#>'{variants,1,object}' IS DISTINCT FROM source#>'{destinations,1}'
  OR NEW.manifest#>'{original,sha256}' IS DISTINCT FROM source->'sha256'
  OR NEW.manifest#>'{original,bytes}' IS DISTINCT FROM source->'bytes'
  OR NEW.manifest#>'{original,mime}' IS DISTINCT FROM source->'mime' THEN
  RAISE EXCEPTION 'Campus tools result does not match its exact attempted objects' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER result_attempt BEFORE INSERT ON whaleu_campus_tools.media_results FOR EACH ROW EXECUTE FUNCTION whaleu_campus_tools.check_media_result();
CREATE TRIGGER attempts_immutable BEFORE UPDATE OR DELETE ON whaleu_campus_tools.media_attempts FOR EACH ROW EXECUTE FUNCTION whaleu_campus_tools.immutable();
CREATE TRIGGER results_immutable BEFORE UPDATE OR DELETE ON whaleu_campus_tools.media_results FOR EACH ROW EXECUTE FUNCTION whaleu_campus_tools.immutable();
CREATE TRIGGER catalogs_immutable BEFORE UPDATE OR DELETE ON whaleu_campus_tools.catalogs FOR EACH ROW EXECUTE FUNCTION whaleu_campus_tools.immutable();
CREATE TRIGGER admissions_immutable BEFORE UPDATE OR DELETE ON whaleu_campus_tools.admissions FOR EACH ROW EXECUTE FUNCTION whaleu_campus_tools.immutable();
CREATE TRIGGER media_immutable BEFORE UPDATE OR DELETE ON whaleu_campus_tools.media_bindings FOR EACH ROW EXECUTE FUNCTION whaleu_campus_tools.immutable();
CREATE FUNCTION whaleu_campus_tools.check_head() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected uuid;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('whaleu:campus-tools:v1:'||NEW.campus_id::text,0));
 SELECT previous_head INTO expected FROM whaleu_campus_tools.admissions WHERE catalog_id=NEW.catalog_id AND campus_id=NEW.campus_id;
 IF NOT FOUND OR (TG_OP='INSERT' AND expected IS NOT NULL) OR (TG_OP='UPDATE' AND (NEW.campus_id<>OLD.campus_id OR expected IS DISTINCT FROM OLD.catalog_id OR NEW.catalog_id=OLD.catalog_id)) THEN
  RAISE EXCEPTION 'Campus tools head must advance through its scoped cause' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER head_cause BEFORE INSERT OR UPDATE ON whaleu_campus_tools.heads FOR EACH ROW EXECUTE FUNCTION whaleu_campus_tools.check_head();
CREATE TRIGGER head_no_delete BEFORE DELETE ON whaleu_campus_tools.heads FOR EACH ROW EXECUTE FUNCTION whaleu_campus_tools.immutable();
CREATE FUNCTION whaleu_campus_tools.check_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE accepted jsonb; entry jsonb; group_item jsonb; slot jsonb; found_slot boolean := false;
BEGIN
 SELECT content INTO accepted FROM whaleu_campus_tools.catalogs WHERE id=NEW.catalog_id AND campus_id=NEW.campus_id;
 FOR entry IN SELECT value FROM jsonb_array_elements(accepted->'entries') LOOP
  IF entry->>'id'=NEW.entry_id::text AND entry->>'revision'=NEW.entry_revision::text THEN
   IF entry->>'kind'='research' AND NEW.group_id IS NULL THEN
    slot:=entry->'image';
    IF slot->>'bindingId'=NEW.id::text AND slot->>'assetId'=NEW.asset_id::text AND slot->>'manifestDigest'=NEW.manifest_digest AND slot->>'id'=NEW.slot_id THEN found_slot:=true; END IF;
   ELSIF entry->>'kind'='shuttle' THEN
    FOR group_item IN SELECT value FROM jsonb_array_elements(entry->'groups') LOOP
     IF group_item->>'id'=NEW.group_id THEN
      FOR slot IN SELECT value FROM jsonb_array_elements(group_item->'slots') LOOP
       IF slot->>'bindingId'=NEW.id::text AND slot->>'assetId'=NEW.asset_id::text AND slot->>'manifestDigest'=NEW.manifest_digest AND slot->>'id'=NEW.slot_id THEN found_slot:=true; END IF;
      END LOOP;
     END IF;
    END LOOP;
   END IF;
  END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM whaleu_campus_tools.media_attempts a JOIN whaleu_campus_tools.media_results r ON r.attempt_id=a.id JOIN whaleu_campus_tools.catalogs c ON c.id=NEW.catalog_id WHERE a.id=NEW.attempt_id AND a.campus_id=NEW.campus_id AND a.input_digest=c.digest AND a.binding_id=NEW.id AND a.asset_id=NEW.asset_id AND a.manifest_digest=NEW.manifest_digest AND r.manifest=NEW.manifest) THEN found_slot:=false; END IF;
 IF NOT found_slot THEN RAISE EXCEPTION 'Detached campus tools media binding' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER binding_scope BEFORE INSERT ON whaleu_campus_tools.media_bindings FOR EACH ROW EXECUTE FUNCTION whaleu_campus_tools.check_binding();

-- Complete admission is indivisible: a catalog cannot commit without all of its
-- exact declared bindings, including accepted empty groups being truly empty.
CREATE FUNCTION whaleu_campus_tools.check_catalog_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item jsonb; slot jsonb; expected_count integer:=0; actual_count integer;
BEGIN
 FOR item IN SELECT value FROM jsonb_array_elements(NEW.content->'entries') LOOP
  FOR slot IN SELECT jsonb_path_query(item,'$.groups[*].slots[*]') UNION ALL SELECT item->'image' WHERE item->'image' IS NOT NULL AND item->'image'<>'null'::jsonb LOOP
   expected_count:=expected_count+1;
   IF NOT EXISTS(SELECT 1 FROM whaleu_campus_tools.media_bindings b WHERE b.catalog_id=NEW.id AND b.entry_id=(item->>'id')::uuid AND b.id=(slot->>'bindingId')::uuid) THEN
    RAISE EXCEPTION 'Campus tools admission is incomplete' USING ERRCODE='23514';
   END IF;
  END LOOP;
 END LOOP;
 SELECT count(*) INTO actual_count FROM whaleu_campus_tools.media_bindings WHERE catalog_id=NEW.id;
 IF NOT EXISTS(SELECT 1 FROM whaleu_campus_tools.admissions a WHERE a.id=NEW.admission_id AND a.previous_head::text IS NOT DISTINCT FROM NEW.content->>'expectedHead' AND (a.receipt->>'entries')::integer=jsonb_array_length(NEW.content->'entries') AND (a.receipt->>'media')::integer=expected_count) THEN RAISE EXCEPTION 'Campus tools receipt does not reconcile' USING ERRCODE='23514'; END IF;
 IF actual_count<>expected_count THEN RAISE EXCEPTION 'Campus tools binding count mismatch' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT 1 FROM whaleu_campus_tools.heads WHERE campus_id=NEW.campus_id AND catalog_id=NEW.id) THEN
  RAISE EXCEPTION 'Orphan campus tools admission' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER catalog_complete AFTER INSERT ON whaleu_campus_tools.catalogs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_campus_tools.check_catalog_complete();
