-- New, explicitly published operating-region service data. No legacy import,
-- third-party delivery, credentials, posting policy or role grants are seeded.
SET LOCAL lock_timeout='5s';
CREATE SCHEMA whaleu_school_configuration;
CREATE FUNCTION whaleu_school_configuration.valid_entry(key text, data jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT jsonb_typeof(data)='object' AND jsonb_typeof(data->'enabled')='boolean' AND
 CASE WHEN key IN ('treehole','trading','errand','review') THEN
   data->>'kind'='group' AND data-ARRAY['kind','enabled','name','description','joinUrl','qqGroupNumber','maxGroupNumber']='{}'::jsonb
   AND jsonb_typeof(data->'name')='string' AND length(data->>'name')<=100
   AND jsonb_typeof(data->'description')='string' AND length(data->>'description')<=500
   AND jsonb_typeof(data->'joinUrl')='string' AND length(data->>'joinUrl')<=1000
   AND (data->>'joinUrl'='' OR data->>'joinUrl' ~ '^https://(qun[.]qq[.]com|jq[.]qq[.]com|qm[.]qq[.]com|weixin[.]qq[.]com)(/|[?]|#|$)')
   AND jsonb_typeof(data->'qqGroupNumber')='string' AND data->>'qqGroupNumber' ~ '^([1-9][0-9]{4,31})?$'
   AND (data->'maxGroupNumber'='null'::jsonb OR (jsonb_typeof(data->'maxGroupNumber')='number' AND data->>'maxGroupNumber' ~ '^[1-9][0-9]{0,2}$'))
 WHEN key='official_account' THEN
   data->>'kind'='official_account' AND data-ARRAY['kind','enabled','name','description']='{}'::jsonb
   AND jsonb_typeof(data->'name')='string' AND length(data->>'name')<=100
   AND jsonb_typeof(data->'description')='string' AND length(data->>'description')<=500
 WHEN key='admin' THEN
   data->>'kind'='admin' AND data-ARRAY['kind','enabled','wechatId']='{}'::jsonb
   AND jsonb_typeof(data->'wechatId')='string' AND length(data->>'wechatId')<=100 AND data->>'wechatId' !~ '[[:space:]]'
 ELSE false END
$$;
CREATE TABLE whaleu_school_configuration.publications (
 region_id uuid NOT NULL REFERENCES whaleu_campus.operating_regions(id),
 entry_key text NOT NULL CHECK(entry_key IN ('treehole','trading','errand','review','official_account','admin')),
 revision bigint NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
 data jsonb NOT NULL CHECK(coalesce(whaleu_school_configuration.valid_entry(entry_key,data),false)),
 qr_binding_id uuid,
 publication_hash text NOT NULL CHECK(publication_hash ~ '^[a-f0-9]{64}$'),
 actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
 grant_id uuid NOT NULL REFERENCES whaleu_authorization.role_grants(id),
 source text NOT NULL DEFAULT 'admin_publication' CHECK(source='admin_publication'),
 published_at timestamptz NOT NULL DEFAULT transaction_timestamp() CHECK(isfinite(published_at)),
 PRIMARY KEY(region_id,entry_key,revision),
 CHECK(publication_hash=encode(sha256(convert_to('whaleu-school-configuration-snapshot:v1'||chr(10)||whaleu_community.content_canonical_json(jsonb_build_object('regionId',region_id::text,'key',entry_key,'revision',revision,'data',data,'bindingId',qr_binding_id)),'UTF8')),'hex'))
);
CREATE TABLE whaleu_school_configuration.entries (
 region_id uuid NOT NULL REFERENCES whaleu_campus.operating_regions(id),
 entry_key text NOT NULL,
 revision bigint NOT NULL,
 data jsonb NOT NULL,
 qr_binding_id uuid,
 publication_hash text NOT NULL,
 actor_id uuid NOT NULL,
 grant_id uuid NOT NULL,
 published_at timestamptz NOT NULL,
 PRIMARY KEY(region_id,entry_key),
 FOREIGN KEY(region_id,entry_key,revision) REFERENCES whaleu_school_configuration.publications(region_id,entry_key,revision)
);
CREATE TABLE whaleu_school_configuration.requests (
 actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
 client_request_id uuid NOT NULL,
 region_id uuid NOT NULL,
 entry_key text NOT NULL,
 command jsonb NOT NULL,
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 receipt jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 PRIMARY KEY(actor_id,client_request_id),
 FOREIGN KEY(region_id,entry_key) REFERENCES whaleu_school_configuration.entries(region_id,entry_key),
 CHECK(request_hash=encode(sha256(convert_to('whaleu-school-configuration-command:v1'||chr(10)||whaleu_community.content_canonical_json(jsonb_build_object('actorId',actor_id::text,'regionId',region_id::text,'key',entry_key,'command',command)),'UTF8')),'hex')),
 CHECK(coalesce(receipt=jsonb_build_object('requestId',client_request_id::text,'requestHash',request_hash,'regionId',region_id::text,'entryKey',entry_key,'revision',(command->>'expectedRevision')::bigint+1,'outcome','saved'),false)),
 CHECK(octet_length(command::text)<=16384)
);
CREATE FUNCTION whaleu_school_configuration.publication_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE authority whaleu_authorization.role_grants; prior bigint;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'School publication history is immutable' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('whaleu:school-configuration:v1:'||NEW.region_id::text||':'||NEW.entry_key,0));
 SELECT * INTO authority FROM whaleu_authorization.role_grants WHERE id=NEW.grant_id FOR SHARE;
 IF NOT FOUND OR authority.account_id<>NEW.actor_id OR authority.revoked_at IS NOT NULL OR authority.valid_from>clock_timestamp() OR (authority.expires_at IS NOT NULL AND authority.expires_at<=clock_timestamp()) OR
 NOT ((authority.role='super_admin' AND authority.operating_region_id IS NULL) OR (authority.role='school_admin' AND authority.operating_region_id=NEW.region_id))
 THEN RAISE EXCEPTION 'School publication requires current exact authority' USING ERRCODE='23514'; END IF;
 PERFORM 1 FROM whaleu_campus.operating_regions WHERE id=NEW.region_id AND is_active FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'School region is unavailable' USING ERRCODE='23514'; END IF;
 SELECT revision INTO prior FROM whaleu_school_configuration.entries WHERE region_id=NEW.region_id AND entry_key=NEW.entry_key FOR UPDATE;
 IF NEW.revision<>coalesce(prior,0)+1 OR NEW.published_at<>transaction_timestamp() THEN RAISE EXCEPTION 'School publication revision must advance once' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER publication_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_school_configuration.publications FOR EACH ROW EXECUTE FUNCTION whaleu_school_configuration.publication_guard();
CREATE FUNCTION whaleu_school_configuration.entry_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source whaleu_school_configuration.publications;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Disable school service entries instead of deleting them' USING ERRCODE='23514'; END IF;
 SELECT * INTO source FROM whaleu_school_configuration.publications WHERE region_id=NEW.region_id AND entry_key=NEW.entry_key AND revision=NEW.revision;
 IF NOT FOUND OR (NEW.data,NEW.qr_binding_id,NEW.publication_hash,NEW.actor_id,NEW.grant_id,NEW.published_at) IS DISTINCT FROM (source.data,source.qr_binding_id,source.publication_hash,source.actor_id,source.grant_id,source.published_at) OR NEW.revision<>(CASE WHEN TG_OP='INSERT' THEN 1 ELSE OLD.revision+1 END) OR (TG_OP='UPDATE' AND (NEW.region_id,NEW.entry_key) IS DISTINCT FROM (OLD.region_id,OLD.entry_key))
 THEN RAISE EXCEPTION 'School entry must reference its exact next publication' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER entry_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_school_configuration.entries FOR EACH ROW EXECUTE FUNCTION whaleu_school_configuration.entry_guard();
CREATE FUNCTION whaleu_school_configuration.request_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'School command receipts are immutable' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('whaleu:school-configuration-request:v1:'||NEW.actor_id::text||':'||NEW.client_request_id::text,0));
 IF EXISTS(SELECT 1 FROM whaleu_school_configuration.cancel_fences WHERE actor_id=NEW.actor_id AND client_request_id=NEW.client_request_id) OR NEW.command->>'clientRequestId' IS DISTINCT FROM NEW.client_request_id::text OR NOT EXISTS(
 SELECT 1 FROM whaleu_school_configuration.publications p WHERE p.region_id=NEW.region_id AND p.entry_key=NEW.entry_key AND p.revision=(NEW.receipt->>'revision')::bigint AND p.actor_id=NEW.actor_id AND p.data=NEW.command->'entry' AND p.published_at=transaction_timestamp())
 THEN RAISE EXCEPTION 'School receipt lacks its exact publication' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER request_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_school_configuration.requests FOR EACH ROW EXECUTE FUNCTION whaleu_school_configuration.request_guard();
CREATE FUNCTION whaleu_school_configuration.publication_complete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM whaleu_school_configuration.entries e WHERE e.region_id=NEW.region_id AND e.entry_key=NEW.entry_key AND e.revision>=NEW.revision)
 OR NOT EXISTS(SELECT 1 FROM whaleu_school_configuration.requests r WHERE r.region_id=NEW.region_id AND r.entry_key=NEW.entry_key AND (r.receipt->>'revision')::bigint=NEW.revision AND r.actor_id=NEW.actor_id)
 THEN RAISE EXCEPTION 'School publication requires an atomic entry and receipt' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER publication_complete AFTER INSERT ON whaleu_school_configuration.publications DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_school_configuration.publication_complete();
-- Owner cancellation fences also cover a request whose HTTP response was lost.
-- A fence wins only before publication; recorded receipts always remain intact.
CREATE TABLE whaleu_school_configuration.cancel_fences (
 actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
 client_request_id uuid NOT NULL,
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 PRIMARY KEY(actor_id,client_request_id)
);
CREATE FUNCTION whaleu_school_configuration.cancel_fence_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'School cancellation fences are immutable' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('whaleu:school-configuration-request:v1:'||NEW.actor_id::text||':'||NEW.client_request_id::text,0));
 IF EXISTS(SELECT 1 FROM whaleu_school_configuration.requests WHERE actor_id=NEW.actor_id AND client_request_id=NEW.client_request_id) THEN RAISE EXCEPTION 'A saved school command cannot be cancelled' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cancel_fence_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_school_configuration.cancel_fences FOR EACH ROW EXECUTE FUNCTION whaleu_school_configuration.cancel_fence_guard();
CREATE FUNCTION whaleu_school_configuration.retain_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'School configuration history is retained' USING ERRCODE='23514'; END $$;
DO $$DECLARE table_name text;BEGIN
 FOREACH table_name IN ARRAY ARRAY['entries','publications','requests','cancel_fences'] LOOP
 EXECUTE format('CREATE TRIGGER retain_school_history BEFORE TRUNCATE ON whaleu_school_configuration.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_school_configuration.retain_history()',table_name);
 END LOOP;
END $$;
