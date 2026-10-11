-- Native organization authority. Empty by default; no legacy directory row,
-- school selection, title or fixture can confer an organization role.
SET LOCAL lock_timeout='5s';
CREATE TABLE whaleu_organizations.organizations (
 id uuid PRIMARY KEY,
 region_id uuid NOT NULL REFERENCES whaleu_campus.operating_regions(id),
 applicant_account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
 revision bigint NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740990),
 authority_version bigint NOT NULL CHECK(authority_version BETWEEN 1 AND 9007199254740990),
 state text NOT NULL CHECK(state IN ('draft','pending','rejected','approved')),
 taxonomy_revision_id uuid NOT NULL,
 category_id uuid NOT NULL,
 data jsonb NOT NULL CHECK(jsonb_typeof(data)='object' AND octet_length(data::text)<=8192),
 media_bindings jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(media_bindings)='object'),
 first_approval_id uuid,
 review_reason text CHECK(length(review_reason)<=500),
 created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 FOREIGN KEY(taxonomy_revision_id, category_id) REFERENCES whaleu_organizations.directory_categories(taxonomy_revision_id,id)
);
CREATE TABLE whaleu_organizations.organization_events (
 id uuid PRIMARY KEY,
 organization_id uuid NOT NULL REFERENCES whaleu_organizations.organizations(id),
 actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
 client_request_id uuid NOT NULL,
 action text NOT NULL CHECK(action IN ('create','save','submit','approve','reject','add_admin','remove_admin','transfer_owner')),
 prior_revision bigint NOT NULL,
 revision bigint NOT NULL,
 prior_authority_version bigint NOT NULL,
 authority_version bigint NOT NULL,
 source_role text NOT NULL CHECK(source_role IN ('applicant','organization_owner','organization_admin','school_admin','super_admin')),
 source_grant_id uuid,
 target_account_id uuid REFERENCES whaleu_identity.accounts(id),
 previous_owner_id uuid REFERENCES whaleu_identity.accounts(id),
 data jsonb NOT NULL,
 media_bindings jsonb NOT NULL,
 state text NOT NULL,
 reason text,
 created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 UNIQUE(actor_id,client_request_id),
 UNIQUE(organization_id,revision,authority_version),
 CHECK((source_role='applicant')=(source_grant_id IS NULL)),
 CHECK((action='reject' AND length(btrim(reason))>0) OR (action<>'reject' AND reason IS NULL))
);
ALTER TABLE whaleu_organizations.organizations ADD CONSTRAINT organization_approval_source FOREIGN KEY(first_approval_id) REFERENCES whaleu_organizations.organization_events(id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE whaleu_organizations.organization_grants (
 id uuid PRIMARY KEY,
 organization_id uuid NOT NULL REFERENCES whaleu_organizations.organizations(id),
 account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
 role text NOT NULL CHECK(role IN ('organization_owner','organization_admin')),
 valid_from timestamptz NOT NULL DEFAULT transaction_timestamp() CHECK(isfinite(valid_from)),
 expires_at timestamptz CHECK(isfinite(expires_at) AND expires_at>valid_from),
 revoked_at timestamptz CHECK(isfinite(revoked_at) AND revoked_at>=valid_from),
 source_event_id uuid NOT NULL REFERENCES whaleu_organizations.organization_events(id) DEFERRABLE INITIALLY DEFERRED,
 revoke_event_id uuid REFERENCES whaleu_organizations.organization_events(id) DEFERRABLE INITIALLY DEFERRED,
 version bigint NOT NULL DEFAULT 1 CHECK(version BETWEEN 1 AND 9007199254740990),
 CHECK(role<>'organization_owner' OR expires_at IS NULL),
 CHECK((revoked_at IS NULL)=(revoke_event_id IS NULL))
);
-- Fix the legacy transfer bug: revoke the REAL owner atomically, not merely the
-- caller's owner role. A site administrator is not necessarily the old owner.
CREATE UNIQUE INDEX organization_unique_owner ON whaleu_organizations.organization_grants(organization_id) WHERE role='organization_owner' AND revoked_at IS NULL;
CREATE UNIQUE INDEX organization_unique_member ON whaleu_organizations.organization_grants(organization_id,account_id) WHERE revoked_at IS NULL;
CREATE INDEX organization_own_grants ON whaleu_organizations.organization_grants(account_id,organization_id) WHERE revoked_at IS NULL;
CREATE INDEX organization_regional_public ON whaleu_organizations.organizations(region_id,id) WHERE state='approved';
CREATE INDEX organization_applicant ON whaleu_organizations.organizations(applicant_account_id,id);
CREATE INDEX organization_regional_review ON whaleu_organizations.organizations(region_id,id) WHERE state='pending';
CREATE TABLE whaleu_organizations.organization_requests (
 actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
 client_request_id uuid NOT NULL,
 organization_id uuid NOT NULL REFERENCES whaleu_organizations.organizations(id),
 command jsonb NOT NULL CHECK(octet_length(command::text)<=32768),
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 event_id uuid NOT NULL UNIQUE REFERENCES whaleu_organizations.organization_events(id),
 receipt jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 PRIMARY KEY(actor_id,client_request_id),
 CHECK(request_hash=encode(sha256(convert_to('whaleu-organization-command:v1'||chr(10)||whaleu_community.content_canonical_json(jsonb_build_object('actorId',actor_id::text,'organizationId',organization_id::text,'command',command)),'UTF8')),'hex')),
 CHECK(command->>'clientRequestId'=client_request_id::text),
 CHECK(receipt->>'requestId'=client_request_id::text AND receipt->>'requestHash'=request_hash AND receipt->>'organizationId'=organization_id::text)
);
CREATE TABLE whaleu_organizations.organization_cancel_fences (
 actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),client_request_id uuid NOT NULL,
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),PRIMARY KEY(actor_id,client_request_id)
);
CREATE FUNCTION whaleu_organizations.organization_lock(id uuid) RETURNS void LANGUAGE sql AS $$
 SELECT pg_advisory_xact_lock(hashtextextended('whaleu:organization:v1:'||id::text,0))
$$;
CREATE FUNCTION whaleu_organizations.organization_actor_current(actor uuid, organization uuid, role_name text, grant_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT coalesce(EXISTS(SELECT 1 FROM whaleu_organizations.organizations o JOIN whaleu_identity.accounts a ON a.id=actor AND a.status='active' JOIN whaleu_campus.operating_regions r ON r.id=o.region_id AND r.is_active WHERE o.id=organization AND (
 (role_name='applicant' AND grant_id IS NULL AND o.applicant_account_id=actor AND o.state IN ('draft','rejected')) OR
 (role_name IN ('organization_owner','organization_admin') AND EXISTS(SELECT 1 FROM whaleu_organizations.organization_grants g WHERE g.id=grant_id AND g.organization_id=o.id AND g.account_id=actor AND g.role=role_name AND g.revoked_at IS NULL AND g.valid_from<=clock_timestamp() AND (g.expires_at IS NULL OR g.expires_at>clock_timestamp()))) OR
 (role_name IN ('school_admin','super_admin') AND EXISTS(SELECT 1 FROM whaleu_authorization.role_grants g WHERE g.id=grant_id AND g.account_id=actor AND g.role=role_name AND g.revoked_at IS NULL AND g.valid_from<=clock_timestamp() AND (g.expires_at IS NULL OR g.expires_at>clock_timestamp()) AND ((g.role='super_admin' AND g.operating_region_id IS NULL) OR (g.role='school_admin' AND g.operating_region_id=o.region_id))))
 )),false)
$$;
CREATE FUNCTION whaleu_organizations.media_actor_current(actor uuid, organization uuid, expected_revision bigint, role_name text, grant_id uuid, authority_version text) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT coalesce(EXISTS(SELECT 1 FROM whaleu_organizations.organizations o WHERE o.id=organization AND o.revision=expected_revision AND o.state<>'pending' AND $6=o.authority_version::text||':'||coalesce($5::text,'applicant') AND whaleu_organizations.organization_actor_current(actor,organization,role_name,grant_id)),false)
$$;
CREATE FUNCTION whaleu_organizations.organization_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o whaleu_organizations.organizations; source whaleu_authorization.role_grants;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Organization event history is immutable' USING ERRCODE='23514'; END IF;
 PERFORM whaleu_organizations.organization_lock(NEW.organization_id);
 SELECT * INTO o FROM whaleu_organizations.organizations WHERE id=NEW.organization_id FOR UPDATE;
 IF NOT FOUND OR NEW.created_at<>transaction_timestamp() OR NEW.prior_revision<>o.revision OR NEW.prior_authority_version<>o.authority_version THEN RAISE EXCEPTION 'Organization event requires exact current CAS' USING ERRCODE='23514'; END IF;
 IF NEW.action='create' THEN
  IF o.revision<>1 OR o.authority_version<>1 OR NEW.actor_id<>o.applicant_account_id OR o.state<>'draft' OR NEW.source_role<>'applicant' OR NEW.source_grant_id IS NOT NULL THEN RAISE EXCEPTION 'Invalid organization creation' USING ERRCODE='23514'; END IF;
 ELSIF NEW.action IN ('approve','reject') THEN
  IF o.state<>'pending' OR NEW.source_role NOT IN ('school_admin','super_admin') OR NOT whaleu_organizations.organization_actor_current(NEW.actor_id,o.id,NEW.source_role,NEW.source_grant_id) THEN RAISE EXCEPTION 'Exact school review authority required' USING ERRCODE='23514'; END IF;
 ELSE
  IF o.state='pending' OR NOT whaleu_organizations.organization_actor_current(NEW.actor_id,o.id,NEW.source_role,NEW.source_grant_id) THEN RAISE EXCEPTION 'Exact organization authority required' USING ERRCODE='23514'; END IF;
  IF NEW.action IN ('add_admin','remove_admin','transfer_owner') AND (o.state<>'approved' OR NEW.source_role='applicant' OR (NEW.action='transfer_owner' AND NEW.source_role='organization_admin')) THEN RAISE EXCEPTION 'Role transition is not allowed' USING ERRCODE='23514'; END IF;
 END IF;
 IF NEW.revision<>o.revision+(CASE WHEN NEW.action IN ('save','submit') THEN 1 ELSE 0 END) OR NEW.authority_version<>o.authority_version+(CASE WHEN NEW.action IN ('approve','reject','add_admin','remove_admin','transfer_owner') THEN 1 ELSE 0 END) THEN RAISE EXCEPTION 'Organization event version must advance exactly' USING ERRCODE='23514'; END IF;
 IF NEW.action NOT IN ('create','save','submit') AND (NEW.data,NEW.media_bindings) IS DISTINCT FROM (o.data,o.media_bindings) THEN RAISE EXCEPTION 'Non-content transition cannot replace content' USING ERRCODE='23514'; END IF;
 IF NEW.action='approve' AND (NEW.state<>'approved' OR o.first_approval_id IS NOT NULL) OR NEW.action='reject' AND NEW.state<>'rejected' OR NEW.action='submit' AND (NEW.state<>'pending' OR o.state='approved') OR NEW.action='save' AND NEW.state<>o.state OR NEW.action IN ('add_admin','remove_admin','transfer_owner') AND NEW.state<>o.state THEN RAISE EXCEPTION 'Organization state transition is invalid' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER organization_event_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_organizations.organization_events FOR EACH ROW EXECUTE FUNCTION whaleu_organizations.organization_event_guard();
CREATE FUNCTION whaleu_organizations.organization_state_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e whaleu_organizations.organization_events;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Organization authority history is retained' USING ERRCODE='23514'; END IF;
 PERFORM whaleu_organizations.organization_lock(NEW.id);
 IF jsonb_typeof(NEW.data)<>'object' OR NEW.data-ARRAY['kind','platform','categoryId','name','introText','qqGroupNumber']<>'{}'::jsonb OR NEW.category_id::text IS DISTINCT FROM NEW.data->>'categoryId' OR length(NEW.data->>'name') NOT BETWEEN 1 AND 10 OR length(NEW.data->>'introText')>1000 OR NEW.data->>'kind' NOT IN ('school','org','official') OR NEW.data->>'platform' NOT IN ('qq','wechat','official') OR ((NEW.data->>'kind'='official')<>(NEW.data->>'platform'='official')) OR (NEW.data->>'platform'='qq' AND NOT coalesce(NEW.data->>'qqGroupNumber' ~ '^[0-9]{5,16}$',false)) OR (NEW.data->>'platform'<>'qq' AND NEW.data->'qqGroupNumber'<>'null'::jsonb) THEN RAISE EXCEPTION 'Invalid organization data' USING ERRCODE='23514'; END IF;
 IF NEW.state IN ('pending','approved') AND (NOT coalesce(NEW.media_bindings->>'avatar' ~ '^[a-f0-9-]{36}$',false) OR NOT coalesce(NEW.media_bindings->>'mainQr' ~ '^[a-f0-9-]{36}$',false) OR (NEW.data->>'platform'='wechat' AND NOT coalesce(NEW.media_bindings->>'managerContact' ~ '^[a-f0-9-]{36}$',false))) THEN RAISE EXCEPTION 'Required organization images are missing' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'draft' OR NEW.revision<>1 OR NEW.authority_version<>1 OR NEW.first_approval_id IS NOT NULL THEN RAISE EXCEPTION 'Organization must start from an unprivileged draft' USING ERRCODE='23514'; END IF;
 ELSE
  IF (NEW.id,NEW.region_id,NEW.applicant_account_id,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.region_id,OLD.applicant_account_id,OLD.created_at) OR (OLD.first_approval_id IS NOT NULL AND NEW.first_approval_id IS DISTINCT FROM OLD.first_approval_id) THEN RAISE EXCEPTION 'Stable organization identity cannot change' USING ERRCODE='23514'; END IF;
  SELECT * INTO e FROM whaleu_organizations.organization_events WHERE organization_id=NEW.id AND revision=NEW.revision AND authority_version=NEW.authority_version;
  IF NOT FOUND OR (e.data,e.media_bindings,e.state) IS DISTINCT FROM (NEW.data,NEW.media_bindings,NEW.state) OR e.prior_revision<>OLD.revision OR e.prior_authority_version<>OLD.authority_version OR e.created_at<>transaction_timestamp() THEN RAISE EXCEPTION 'Organization state requires its atomic event' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER organization_state_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_organizations.organizations FOR EACH ROW EXECUTE FUNCTION whaleu_organizations.organization_state_guard();
CREATE FUNCTION whaleu_organizations.organization_grant_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e whaleu_organizations.organization_events; old_owner uuid;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Organization grants are revoked, never deleted' USING ERRCODE='23514'; END IF;
 PERFORM whaleu_organizations.organization_lock(NEW.organization_id);
 IF TG_OP='INSERT' THEN
  SELECT * INTO e FROM whaleu_organizations.organization_events WHERE id=NEW.source_event_id;
  IF NOT FOUND OR e.organization_id<>NEW.organization_id OR e.created_at<>transaction_timestamp() OR NEW.version<>1 OR NEW.valid_from<>transaction_timestamp() OR NEW.revoked_at IS NOT NULL OR NEW.expires_at IS NOT NULL OR NOT ((NEW.role='organization_owner' AND ((e.action='approve' AND NEW.account_id=(SELECT applicant_account_id FROM whaleu_organizations.organizations WHERE id=NEW.organization_id)) OR (e.action='transfer_owner' AND e.target_account_id=NEW.account_id))) OR (NEW.role='organization_admin' AND ((e.action='add_admin' AND e.target_account_id=NEW.account_id) OR (e.action='transfer_owner' AND e.previous_owner_id=NEW.account_id)))) THEN RAISE EXCEPTION 'Grant requires exact causal authority event' USING ERRCODE='23514'; END IF;
 ELSE
  SELECT * INTO e FROM whaleu_organizations.organization_events WHERE id=NEW.revoke_event_id;
  IF NOT FOUND OR e.organization_id<>NEW.organization_id OR e.created_at<>transaction_timestamp() OR (NEW.id,NEW.organization_id,NEW.account_id,NEW.role,NEW.valid_from,NEW.expires_at,NEW.source_event_id) IS DISTINCT FROM (OLD.id,OLD.organization_id,OLD.account_id,OLD.role,OLD.valid_from,OLD.expires_at,OLD.source_event_id) OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at<>transaction_timestamp() OR NEW.version<>OLD.version+1 OR NOT ((e.action='remove_admin' AND OLD.role='organization_admin' AND e.target_account_id=OLD.account_id) OR (e.action='transfer_owner' AND (OLD.role='organization_owner' AND e.previous_owner_id=OLD.account_id OR OLD.role='organization_admin' AND e.target_account_id=OLD.account_id))) THEN RAISE EXCEPTION 'Grant revocation requires exact causal event' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER organization_grant_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_organizations.organization_grants FOR EACH ROW EXECUTE FUNCTION whaleu_organizations.organization_grant_guard();
CREATE FUNCTION whaleu_organizations.organization_request_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e whaleu_organizations.organization_events;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Organization receipts and cancellations are immutable' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('whaleu:organization-request:v1:'||NEW.actor_id::text||':'||NEW.client_request_id::text,0));
 IF TG_TABLE_NAME='organization_cancel_fences' THEN
  IF EXISTS(SELECT 1 FROM whaleu_organizations.organization_requests WHERE actor_id=NEW.actor_id AND client_request_id=NEW.client_request_id) THEN RAISE EXCEPTION 'Recorded organization command cannot be cancelled' USING ERRCODE='23514'; END IF;
 ELSE
  SELECT * INTO e FROM whaleu_organizations.organization_events WHERE id=NEW.event_id;
  IF NOT FOUND OR e.actor_id<>NEW.actor_id OR e.client_request_id<>NEW.client_request_id OR e.organization_id<>NEW.organization_id OR NEW.command->>'action'<>e.action OR (NEW.receipt->>'revision')::bigint<>e.revision OR (NEW.receipt->>'authorityVersion')::bigint<>e.authority_version OR EXISTS(SELECT 1 FROM whaleu_organizations.organization_cancel_fences WHERE actor_id=NEW.actor_id AND client_request_id=NEW.client_request_id) THEN RAISE EXCEPTION 'Organization receipt requires exact event' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER organization_request_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_organizations.organization_requests FOR EACH ROW EXECUTE FUNCTION whaleu_organizations.organization_request_guard();
CREATE TRIGGER organization_cancel_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_organizations.organization_cancel_fences FOR EACH ROW EXECUTE FUNCTION whaleu_organizations.organization_request_guard();
CREATE FUNCTION whaleu_organizations.organization_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE oid uuid; o whaleu_organizations.organizations; n integer;
BEGIN
 IF TG_TABLE_NAME='organizations' THEN oid:=NEW.id; ELSE oid:=NEW.organization_id; END IF;
 SELECT * INTO o FROM whaleu_organizations.organizations WHERE id=oid;
 IF NOT EXISTS(SELECT 1 FROM whaleu_organizations.organization_events e JOIN whaleu_organizations.organization_requests q ON q.event_id=e.id WHERE e.organization_id=oid AND e.revision=o.revision AND e.authority_version=o.authority_version AND (e.data,e.media_bindings,e.state) IS NOT DISTINCT FROM (o.data,o.media_bindings,o.state)) THEN RAISE EXCEPTION 'Organization mutation requires atomic event and receipt' USING ERRCODE='23514'; END IF;
 SELECT count(*) INTO n FROM whaleu_organizations.organization_grants WHERE organization_id=oid AND role='organization_owner' AND revoked_at IS NULL;
 IF (o.state='approved' AND (n<>1 OR o.first_approval_id IS NULL)) OR (o.first_approval_id IS NULL AND n<>0) OR (o.first_approval_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM whaleu_organizations.organization_events e WHERE e.id=o.first_approval_id AND e.organization_id=o.id AND e.action='approve')) THEN RAISE EXCEPTION 'Approved organization requires its unique causal owner' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER organization_complete AFTER INSERT OR UPDATE ON whaleu_organizations.organizations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_organizations.organization_complete();
CREATE CONSTRAINT TRIGGER organization_grants_complete AFTER INSERT OR UPDATE ON whaleu_organizations.organization_grants DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_organizations.organization_complete();
CREATE FUNCTION whaleu_organizations.retain_organization_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Organization authority history is retained' USING ERRCODE='23514'; END $$;
DO $$DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['organizations','organization_events','organization_grants','organization_requests','organization_cancel_fences'] LOOP EXECUTE format('CREATE TRIGGER retain_organization_history BEFORE TRUNCATE ON whaleu_organizations.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_organizations.retain_organization_history()',t); END LOOP; END $$;
-- Structural live-source epoch, never an accepted legacy snapshot or authority.
CREATE TABLE whaleu_organizations.native_directory_epoch (singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),revision bigint NOT NULL DEFAULT 1 CHECK(revision>0));
INSERT INTO whaleu_organizations.native_directory_epoch(singleton) VALUES(true);
CREATE FUNCTION whaleu_organizations.advance_native_directory_epoch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE whaleu_organizations.native_directory_epoch SET revision=revision+1 WHERE singleton; RETURN NULL; END $$;
CREATE TRIGGER advance_native_directory_epoch AFTER INSERT OR UPDATE ON whaleu_organizations.organizations FOR EACH STATEMENT EXECUTE FUNCTION whaleu_organizations.advance_native_directory_epoch();
