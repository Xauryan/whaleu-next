-- Independent Category icon extension. No issuer, capability, legacy absence,
-- provider or adoption is seeded. Frozen Category/source/compiler SQL is intact.
SET LOCAL lock_timeout='5s';
SELECT pg_advisory_xact_lock(hashtextextended('whaleu:named-block-policy:v1',0));

CREATE FUNCTION whaleu_ratings.category_icon_digest(domain text,value jsonb) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT encode(sha256(convert_to('ratings-category-icon-v1:'||domain||E'\n'||whaleu_community.content_canonical_json(value),'UTF8')),'hex')
$$;
CREATE TABLE whaleu_ratings.category_icon_epoch(
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),version integer NOT NULL DEFAULT 1 CHECK(version=1),epoch bigint NOT NULL CHECK(epoch>=0)
);
INSERT INTO whaleu_ratings.category_icon_epoch(singleton,version,epoch) VALUES(true,1,0);
CREATE FUNCTION whaleu_ratings.advance_category_icon_epoch() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 UPDATE whaleu_ratings.category_icon_epoch SET epoch=epoch+1 WHERE singleton;RETURN NULL;
END$$;
CREATE TABLE whaleu_ratings.category_icon_capability_sources(
 id uuid PRIMARY KEY,protocol_version_id uuid NOT NULL UNIQUE REFERENCES whaleu_ratings.scope_protocol_versions(id),
 source_id uuid NOT NULL,source_revision uuid NOT NULL,source_digest text NOT NULL CHECK(source_digest ~ '^[a-f0-9]{64}$'),
 protocol_version integer NOT NULL CHECK(protocol_version=5),review_version integer NOT NULL CHECK(review_version=8),media_version integer NOT NULL CHECK(media_version=8),journal_version integer NOT NULL CHECK(journal_version=13),
 extension_version text NOT NULL CHECK(extension_version='ratings-category-icon-v1'),slots text[] NOT NULL CHECK(slots=ARRAY['icon']),
 routes_digest text NOT NULL CHECK(routes_digest ~ '^[a-f0-9]{64}$'),native_digest text NOT NULL CHECK(native_digest ~ '^[a-f0-9]{64}$'),
 compatibility_digest text NOT NULL CHECK(compatibility_digest ~ '^[a-f0-9]{64}$'),adoption_digest text NOT NULL CHECK(adoption_digest ~ '^[a-f0-9]{64}$'),
 coverage_digest text NOT NULL CHECK(coverage_digest ~ '^[a-f0-9]{64}$'),coverage_inventory jsonb NOT NULL CHECK(jsonb_typeof(coverage_inventory)='array'),
 issuer text NOT NULL CHECK(length(btrim(issuer))>0),provenance_ref text NOT NULL CHECK(length(btrim(provenance_ref))>0),
 valid_from timestamptz NOT NULL,valid_until timestamptz NOT NULL,CHECK(isfinite(valid_from) AND isfinite(valid_until) AND valid_until>valid_from),
 FOREIGN KEY(source_id,source_revision) REFERENCES whaleu_ratings.scoped_source_attestations(id,revision),
 CHECK(coverage_digest=whaleu_ratings.category_icon_digest('coverage-inventory',coverage_inventory))
);
CREATE TABLE whaleu_ratings.category_icon_upload_scopes(
 id uuid PRIMARY KEY,actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),client_request_id uuid NOT NULL,command_request_id uuid NOT NULL,
 scope_revision text NOT NULL CHECK(scope_revision ~ '^[a-f0-9]{64}$'),scope_request_hash text NOT NULL CHECK(scope_request_hash ~ '^[a-f0-9]{64}$'),request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 input jsonb NOT NULL,declaration jsonb NOT NULL,context_id uuid NOT NULL REFERENCES whaleu_ratings.scoped_contexts(id),session_id uuid NOT NULL REFERENCES whaleu_identity.sessions(id),
 category_id uuid NOT NULL,identity_id uuid NOT NULL,origin jsonb NOT NULL,
 expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(actor_id,client_request_id),CHECK(client_request_id<>command_request_id),
 CHECK(isfinite(created_at) AND isfinite(expires_at) AND expires_at>created_at AND expires_at<=created_at+interval '5 minutes'),
 CHECK((whaleu_community.rating_scoped_keys(origin,ARRAY['kind']) AND origin->>'kind'='base') OR
 (whaleu_community.rating_scoped_keys(origin,ARRAY['kind','campusId']) AND origin->>'kind'='override' AND whaleu_community.rating_scoped_ids(origin,ARRAY['campusId'])))
);
-- A cold/unknown response cannot erase the original actor's minimum obligation.
-- These exact request fences also prohibit late scope creation after cancellation.
CREATE TABLE whaleu_ratings.category_icon_upload_scope_fences(
 actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),client_request_id uuid NOT NULL,request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(created_at)),PRIMARY KEY(actor_id,client_request_id)
);
CREATE TABLE whaleu_ratings.category_icon_recovery_fences(
 actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),request_id uuid NOT NULL,operation text NOT NULL CHECK(whaleu_ratings.category_management_operation(operation)),
 intent_hash text NOT NULL CHECK(intent_hash ~ '^[a-f0-9]{64}$'),created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(created_at)),
 PRIMARY KEY(actor_id,request_id),FOREIGN KEY(actor_id,request_id) REFERENCES whaleu_ratings.requests(account_id,request_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE whaleu_ratings.category_icon_appearances(
 id uuid PRIMARY KEY,category_id uuid NOT NULL,identity_id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
 asset_id uuid NOT NULL UNIQUE REFERENCES whaleu_media.assets(id),media_binding_id uuid NOT NULL UNIQUE REFERENCES whaleu_media.bindings(id) DEFERRABLE INITIALLY DEFERRED,
 manifest_digest text NOT NULL CHECK(manifest_digest ~ '^[a-f0-9]{64}$'),origin jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(created_at)),publication_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 CHECK((whaleu_community.rating_scoped_keys(origin,ARRAY['kind']) AND origin->>'kind'='base') OR
 (whaleu_community.rating_scoped_keys(origin,ARRAY['kind','campusId']) AND origin->>'kind'='override' AND whaleu_community.rating_scoped_ids(origin,ARRAY['campusId'])))
);
-- Content/source definitions are immutable. Recovery metadata belongs to heads,
-- so archive/visibility/scope changes never rewrite body Review or detach media.
CREATE TABLE whaleu_ratings.category_icon_definitions(
 id uuid PRIMARY KEY,category_id uuid NOT NULL,identity_id uuid NOT NULL,kind text NOT NULL CHECK(kind IN ('base','override')),campus_id uuid REFERENCES whaleu_campus.campuses(id),
 base_source_id uuid NOT NULL,base_source_revision uuid NOT NULL,text_source_id uuid,text_source_revision uuid,
 value jsonb NOT NULL CHECK(jsonb_typeof(value)='object'),appearance_id uuid REFERENCES whaleu_ratings.category_icon_appearances(id) DEFERRABLE INITIALLY DEFERRED,
 predecessors uuid[] NOT NULL,definition_digest text NOT NULL CHECK(definition_digest ~ '^[a-f0-9]{64}$'),
 actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),request_id uuid NOT NULL,intent_hash text NOT NULL CHECK(intent_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(created_at)),publication_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 CHECK((kind='base')=(campus_id IS NULL)),CHECK((text_source_id IS NULL)=(text_source_revision IS NULL)),
 CHECK(kind<>'base' OR (text_source_id=base_source_id AND text_source_revision=base_source_revision)),
 CHECK((value->>'kind'='image')=(appearance_id IS NOT NULL)),CHECK(value->>'kind' IN ('image','absent','inherit','unresolved')),
 CHECK(kind<>'base' OR value->>'kind'<>'inherit'),
 FOREIGN KEY(base_source_id,base_source_revision) REFERENCES whaleu_ratings.scoped_source_attestations(id,revision),
 FOREIGN KEY(text_source_id,text_source_revision) REFERENCES whaleu_ratings.scoped_source_attestations(id,revision),
 FOREIGN KEY(actor_id,request_id) REFERENCES whaleu_ratings.requests(account_id,request_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE whaleu_ratings.category_icon_definition_heads(
 root_key text PRIMARY KEY,definition_id uuid NOT NULL UNIQUE REFERENCES whaleu_ratings.category_icon_definitions(id),
 scope_keys text[] NOT NULL CHECK(whaleu_ratings.scoped_scope_keys_valid(scope_keys)),retention text NOT NULL CHECK(retention IN ('current','dormant','archived')),
 mutation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id()
);
CREATE TABLE whaleu_ratings.category_icon_preparations(
 actor_id uuid NOT NULL,request_id uuid NOT NULL,outer_hash text NOT NULL CHECK(outer_hash ~ '^[a-f0-9]{64}$'),text_hash text NOT NULL CHECK(text_hash ~ '^[a-f0-9]{64}$'),
 text_intent jsonb NOT NULL,media_plan jsonb NOT NULL,plan_digest text NOT NULL CHECK(plan_digest ~ '^[a-f0-9]{64}$'),before_snapshot text NOT NULL CHECK(before_snapshot ~ '^[a-f0-9]{64}$'),
 affected_scope_keys text[] NOT NULL CHECK(whaleu_ratings.scoped_scope_keys_valid(affected_scope_keys)),before_heads jsonb NOT NULL,before_vector jsonb NOT NULL,before_compat_heads jsonb NOT NULL,
 noop boolean NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(created_at)),PRIMARY KEY(actor_id,request_id),
 FOREIGN KEY(actor_id,request_id) REFERENCES whaleu_ratings.scoped_command_preparations(account_id,request_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE whaleu_ratings.category_icon_review_bindings(
 id uuid PRIMARY KEY,definition_id uuid NOT NULL,definition_digest text NOT NULL CHECK(definition_digest ~ '^[a-f0-9]{64}$'),
 decision_id uuid NOT NULL UNIQUE REFERENCES whaleu_community.rating_approval_decisions(id),account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),request_id uuid NOT NULL,
 approval_digest text NOT NULL CHECK(approval_digest ~ '^[a-f0-9]{64}$'),envelope jsonb NOT NULL,bound_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(bound_at)),publication_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 UNIQUE(definition_id),FOREIGN KEY(account_id,request_id) REFERENCES whaleu_ratings.requests(account_id,request_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE whaleu_ratings.category_icon_release_manifests(
 release_id uuid PRIMARY KEY REFERENCES whaleu_ratings.scoped_releases(id),extension_version text NOT NULL CHECK(extension_version='ratings-category-icon-v1'),
 digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),row_count integer NOT NULL CHECK(row_count BETWEEN 0 AND 100000),
 management_coverage jsonb NOT NULL CHECK(jsonb_typeof(management_coverage)='array'),
 scope_extent jsonb NOT NULL CHECK(jsonb_typeof(scope_extent)='array'),root_snapshot jsonb NOT NULL CHECK(jsonb_typeof(root_snapshot)='array'),capabilities jsonb NOT NULL CHECK(jsonb_typeof(capabilities)='array'),
 serialized_bytes bigint NOT NULL CHECK(serialized_bytes BETWEEN 0 AND 67108864),publication_transaction xid8 NOT NULL DEFAULT pg_current_xact_id()
);
CREATE TABLE whaleu_ratings.category_icon_projections(
 release_id uuid NOT NULL REFERENCES whaleu_ratings.category_icon_release_manifests(release_id),catalog_id uuid NOT NULL,category_id uuid NOT NULL,effective_revision uuid NOT NULL,
 extension_digest text NOT NULL CHECK(extension_digest ~ '^[a-f0-9]{64}$'),projection jsonb NOT NULL,
 review_binding_id uuid NOT NULL REFERENCES whaleu_ratings.category_icon_review_bindings(id),appearance_id uuid REFERENCES whaleu_ratings.category_icon_appearances(id),
 publication_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),PRIMARY KEY(catalog_id,category_id),
 FOREIGN KEY(catalog_id,category_id,effective_revision) REFERENCES whaleu_ratings.scoped_categories(catalog_id,category_id,effective_revision)
);
CREATE TABLE whaleu_ratings.category_icon_terminal_retirements(
 appearance_id uuid PRIMARY KEY REFERENCES whaleu_ratings.category_icon_appearances(id),asset_id uuid NOT NULL REFERENCES whaleu_media.assets(id),binding_id uuid NOT NULL REFERENCES whaleu_media.bindings(id),
 actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),manifest_digest text NOT NULL CHECK(manifest_digest ~ '^[a-f0-9]{64}$'),
 closure_revision text NOT NULL CHECK(closure_revision ~ '^[a-f0-9]{64}$'),transaction_id xid8 NOT NULL DEFAULT pg_current_xact_id(),
 causing_actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),causing_request_id uuid NOT NULL,
 FOREIGN KEY(causing_actor_id,causing_request_id) REFERENCES whaleu_ratings.requests(account_id,request_id) DEFERRABLE INITIALLY DEFERRED
);
DO $$DECLARE name text;BEGIN
 FOREACH name IN ARRAY ARRAY['category_icon_capability_sources','category_icon_upload_scopes','category_icon_upload_scope_fences','category_icon_recovery_fences','category_icon_appearances','category_icon_definitions','category_icon_definition_heads','category_icon_preparations','category_icon_review_bindings','category_icon_release_manifests','category_icon_projections','category_icon_terminal_retirements'] LOOP
 EXECUTE format('CREATE TRIGGER a00_category_icon_writer BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_ratings.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.scoped_public_writer_gate()',name);
 EXECUTE format('CREATE TRIGGER a01_category_icon_epoch BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_ratings.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.advance_category_icon_epoch()',name);
 IF name<>'category_icon_definition_heads' THEN
 EXECUTE format('CREATE TRIGGER category_icon_immutable BEFORE UPDATE OR DELETE ON whaleu_ratings.%I FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.immutable()',name);
 END IF;
 EXECUTE format('CREATE TRIGGER category_icon_retain BEFORE TRUNCATE ON whaleu_ratings.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_ratings.immutable()',name);
 END LOOP;
END$$;
