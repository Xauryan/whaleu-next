-- Profile owns selection and shared revision. Empty authority tables: no default
-- catalog, real media, Review issuer or production activation is seeded.
CREATE TABLE whaleu_profile.avatar_edits (
 id uuid PRIMARY KEY, actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
 client_request_id uuid NOT NULL, expected_revision integer NOT NULL CHECK(expected_revision BETWEEN 0 AND 2147483646),
 scope_revision text NOT NULL, request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 declaration jsonb NOT NULL CHECK(jsonb_typeof(declaration)='object'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(created_at)),
 expires_at timestamptz NOT NULL CHECK(isfinite(expires_at) AND expires_at>created_at),
 CHECK(scope_revision=expected_revision::text), UNIQUE(actor_id,client_request_id), UNIQUE(id,actor_id)
);
CREATE TABLE whaleu_profile.avatar_definitions (
 id uuid PRIMARY KEY, actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
 slot text NOT NULL CHECK(slot='avatar'), source jsonb NOT NULL,
 envelope jsonb NOT NULL, digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),
 binding_id uuid,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(created_at)),
 CHECK(jsonb_typeof(source)='object' AND source->>'kind' IN ('clear','catalog','custom')),
 CHECK((source->>'kind'='custom')=(binding_id IS NOT NULL)),
 CHECK(envelope->>'appearanceId'=id::text AND envelope->>'accountId'=actor_id::text AND envelope->'source'=source),
 CHECK(digest=encode(sha256(convert_to('whaleu-profile-avatar-review:v1'||chr(10)||whaleu_community.content_canonical_json(envelope),'UTF8')),'hex')),
 UNIQUE(id,actor_id)
);
CREATE TABLE whaleu_profile.avatar_current (
 actor_id uuid PRIMARY KEY REFERENCES whaleu_profile.profiles(account_id),
 appearance_id uuid NOT NULL UNIQUE,
 FOREIGN KEY(appearance_id,actor_id) REFERENCES whaleu_profile.avatar_definitions(id,actor_id)
);
CREATE TABLE whaleu_profile.avatar_command_receipts (
 actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id), client_request_id uuid NOT NULL,
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 resulting_revision integer NOT NULL CHECK(resulting_revision>0),
 appearance_id uuid NOT NULL,
 committed_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(committed_at)),
 PRIMARY KEY(actor_id,client_request_id), UNIQUE(actor_id,resulting_revision),
 FOREIGN KEY(appearance_id,actor_id) REFERENCES whaleu_profile.avatar_definitions(id,actor_id)
);

-- Every writer, including raw fixtures and the existing nickname/preferences/
-- campus repository, participates. Reads take only bounded shared actor fences
-- at final proof, not a global exclusive lock. TRUNCATE is never an unobserved
-- disappearance; these owner records have retained history.
CREATE FUNCTION whaleu_profile.avatar_actor_writer() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous_actor uuid; next_actor uuid; item uuid;
BEGIN
 IF TG_OP='TRUNCATE' THEN RAISE EXCEPTION 'Profile avatar authority cannot be truncated' USING ERRCODE='23514'; END IF;
 IF TG_OP<>'INSERT' THEN previous_actor:=coalesce(to_jsonb(OLD)->>'actor_id',to_jsonb(OLD)->>'account_id')::uuid; END IF;
 IF TG_OP<>'DELETE' THEN next_actor:=coalesce(to_jsonb(NEW)->>'actor_id',to_jsonb(NEW)->>'account_id')::uuid; END IF;
 FOR item IN SELECT DISTINCT x FROM unnest(ARRAY[previous_actor,next_actor]) x WHERE x IS NOT NULL ORDER BY x LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended('whaleu:profile-avatar:actor:v1:'||item::text,0));
 END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION whaleu_profile.avatar_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Profile avatar history is immutable' USING ERRCODE='23514'; END $$;
DO $$ DECLARE relation text; BEGIN
 FOREACH relation IN ARRAY ARRAY['profiles','avatar_edits','avatar_definitions','avatar_current','avatar_command_receipts'] LOOP
  EXECUTE format('CREATE TRIGGER profile_avatar_writer BEFORE INSERT OR UPDATE OR DELETE ON whaleu_profile.%I FOR EACH ROW EXECUTE FUNCTION whaleu_profile.avatar_actor_writer()',relation);
  EXECUTE format('CREATE TRIGGER profile_avatar_no_truncate BEFORE TRUNCATE ON whaleu_profile.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_profile.avatar_actor_writer()',relation);
 END LOOP;
 FOREACH relation IN ARRAY ARRAY['avatar_edits','avatar_definitions','avatar_command_receipts'] LOOP
  EXECUTE format('CREATE TRIGGER profile_avatar_immutable BEFORE UPDATE OR DELETE ON whaleu_profile.%I FOR EACH ROW EXECUTE FUNCTION whaleu_profile.avatar_immutable()',relation);
 END LOOP;
END $$;

-- The Review owner reuses the existing policy/provenance/time model. Its exact
-- Profile purpose cannot be consumed as Community publication or asset safety.
CREATE TABLE whaleu_community.profile_avatar_approval_decisions (
 id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id),
 operation text NOT NULL CHECK(operation='select_profile_avatar'), envelope_version integer NOT NULL CHECK(envelope_version=1),
 digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'), envelope jsonb NOT NULL,
 policy_revision_id uuid NOT NULL REFERENCES whaleu_community.content_approval_policies(id),
 result text NOT NULL CHECK(result IN ('allow','reject','pending','failed')),
 coverage text NOT NULL CHECK(coverage IN ('complete','missing','conflicting')),
 provenance text NOT NULL CHECK(provenance IN ('accepted','unreconciled','rejected')),
 issuer text NOT NULL CHECK(length(btrim(issuer))>0), provenance_ref text NOT NULL CHECK(length(btrim(provenance_ref))>0),
 evaluated_at timestamptz NOT NULL CHECK(isfinite(evaluated_at)),
 consume_until timestamptz NOT NULL CHECK(isfinite(consume_until) AND consume_until>evaluated_at),
 visibility_model text NOT NULL CHECK(visibility_model IN ('durable','until')),
 visibility_until timestamptz CHECK(visibility_until IS NULL OR (isfinite(visibility_until) AND visibility_until>evaluated_at)),
 CHECK((visibility_model='durable')=(visibility_until IS NULL)),
 CHECK(coalesce(envelope->>'version'='1' AND envelope->>'purpose'=operation AND envelope->>'accountId'=account_id::text AND envelope->>'slot'='avatar',false)),
 CHECK(digest=encode(sha256(convert_to('whaleu-profile-avatar-review:v1'||chr(10)||whaleu_community.content_canonical_json(envelope),'UTF8')),'hex')),
 UNIQUE(id,account_id,digest)
);
CREATE INDEX profile_avatar_approval_exact ON whaleu_community.profile_avatar_approval_decisions(account_id,digest,evaluated_at DESC,id DESC);
CREATE TABLE whaleu_community.profile_avatar_approval_events (
 id uuid PRIMARY KEY, decision_id uuid NOT NULL REFERENCES whaleu_community.profile_avatar_approval_decisions(id),
 sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE, state text NOT NULL CHECK(state IN ('allow','held','revoked')),
 coverage text NOT NULL CHECK(coverage IN ('complete','missing','conflicting')),
 provenance text NOT NULL CHECK(provenance IN ('accepted','unreconciled','rejected')),
 issuer text NOT NULL CHECK(length(btrim(issuer))>0), provenance_ref text NOT NULL CHECK(length(btrim(provenance_ref))>0),
 occurred_at timestamptz NOT NULL CHECK(isfinite(occurred_at)), UNIQUE(id,decision_id)
);
CREATE TABLE whaleu_community.profile_avatar_approval_heads (
 decision_id uuid PRIMARY KEY REFERENCES whaleu_community.profile_avatar_approval_decisions(id), event_id uuid NOT NULL UNIQUE,
 FOREIGN KEY(event_id,decision_id) REFERENCES whaleu_community.profile_avatar_approval_events(id,decision_id)
);
CREATE TABLE whaleu_community.profile_avatar_approval_bindings (
 appearance_id uuid PRIMARY KEY, decision_id uuid NOT NULL UNIQUE,
 account_id uuid NOT NULL, digest text NOT NULL, envelope jsonb NOT NULL,
 bound_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(bound_at)),
 publication_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 FOREIGN KEY(decision_id,account_id,digest) REFERENCES whaleu_community.profile_avatar_approval_decisions(id,account_id,digest),
 CHECK(envelope->>'appearanceId'=appearance_id::text AND envelope->>'accountId'=account_id::text)
);
CREATE FUNCTION whaleu_community.profile_avatar_review_head_validate() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_event whaleu_community.profile_avatar_approval_events; old_sequence bigint; decision_time timestamptz;
BEGIN
 IF TG_OP='DELETE' OR (TG_OP='UPDATE' AND NEW.decision_id<>OLD.decision_id) THEN RAISE EXCEPTION 'Profile Review head is durable' USING ERRCODE='23514'; END IF;
 SELECT evaluated_at INTO decision_time FROM whaleu_community.profile_avatar_approval_decisions WHERE id=NEW.decision_id;
 SELECT * INTO current_event FROM whaleu_community.profile_avatar_approval_events WHERE id=NEW.event_id AND decision_id=NEW.decision_id;
 IF NOT FOUND OR current_event.occurred_at<decision_time THEN RAISE EXCEPTION 'Invalid Profile Review event' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' THEN
  SELECT sequence INTO old_sequence FROM whaleu_community.profile_avatar_approval_events WHERE id=OLD.event_id;
  IF current_event.sequence<=old_sequence THEN RAISE EXCEPTION 'Profile Review cannot rewind' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER profile_avatar_review_head_validate BEFORE INSERT OR UPDATE OR DELETE ON whaleu_community.profile_avatar_approval_heads FOR EACH ROW EXECUTE FUNCTION whaleu_community.profile_avatar_review_head_validate();
DO $$ DECLARE relation text; BEGIN
 FOREACH relation IN ARRAY ARRAY['profile_avatar_approval_decisions','profile_avatar_approval_events','profile_avatar_approval_bindings'] LOOP
  EXECUTE format('CREATE TRIGGER profile_avatar_review_immutable BEFORE UPDATE OR DELETE ON whaleu_community.%I FOR EACH ROW EXECUTE FUNCTION whaleu_community.content_approval_immutable()',relation);
 END LOOP;
 FOREACH relation IN ARRAY ARRAY['profile_avatar_approval_decisions','profile_avatar_approval_events','profile_avatar_approval_heads','profile_avatar_approval_bindings'] LOOP
  EXECUTE format('CREATE TRIGGER profile_avatar_review_writer BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_community.%I FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.content_policy_writer_gate()',relation);
 END LOOP;
END $$;

CREATE TABLE whaleu_profile.avatar_catalog_items (
 catalog_version text NOT NULL CHECK(catalog_version ~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$'),
 item_id text NOT NULL CHECK(item_id ~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$'),
 label text NOT NULL CHECK(length(label) BETWEEN 1 AND 80),
 content_hash text NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'),
 manifest jsonb NOT NULL CHECK(jsonb_typeof(manifest)='object'),
 available boolean NOT NULL DEFAULT false,
 PRIMARY KEY(catalog_version,item_id)
);
CREATE FUNCTION whaleu_profile.avatar_catalog_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR TG_OP='TRUNCATE' THEN RAISE EXCEPTION 'Catalog identity is retained' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' AND (NEW.catalog_version,NEW.item_id,NEW.label,NEW.content_hash,NEW.manifest) IS DISTINCT FROM (OLD.catalog_version,OLD.item_id,OLD.label,OLD.content_hash,OLD.manifest) THEN RAISE EXCEPTION 'Catalog bytes and identity are immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER avatar_catalog_guard BEFORE UPDATE OR DELETE ON whaleu_profile.avatar_catalog_items FOR EACH ROW EXECUTE FUNCTION whaleu_profile.avatar_catalog_guard();
CREATE TRIGGER avatar_catalog_retain BEFORE TRUNCATE ON whaleu_profile.avatar_catalog_items FOR EACH STATEMENT EXECUTE FUNCTION whaleu_profile.avatar_catalog_guard();
CREATE FUNCTION whaleu_community.profile_avatar_review_binding_validate() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE decision whaleu_community.profile_avatar_approval_decisions; instant timestamptz; accepted boolean;
BEGIN
 SELECT * INTO decision FROM whaleu_community.profile_avatar_approval_decisions WHERE id=NEW.decision_id;
 instant:=clock_timestamp();
 SELECT coalesce(d.result='allow' AND d.coverage='complete' AND d.provenance='accepted' AND
 p.policy_key='local-explicit-v1' AND p.version=1 AND p.coverage='complete' AND p.provenance='accepted' AND
 e.state='allow' AND e.coverage='complete' AND e.provenance='accepted' AND
 d.evaluated_at<=instant AND p.valid_from<=d.evaluated_at AND (p.valid_until IS NULL OR p.valid_until>instant) AND
 e.occurred_at>=d.evaluated_at AND e.occurred_at<=instant AND d.consume_until>instant AND
 (d.visibility_model='durable' OR d.visibility_until>instant),false)
 INTO accepted FROM whaleu_community.profile_avatar_approval_decisions d
 JOIN whaleu_community.content_approval_policies p ON p.id=d.policy_revision_id
 JOIN whaleu_community.profile_avatar_approval_heads h ON h.decision_id=d.id
 JOIN whaleu_community.profile_avatar_approval_events e ON e.id=h.event_id AND e.decision_id=d.id WHERE d.id=NEW.decision_id;
 IF NOT coalesce(accepted,false) OR NEW.envelope IS DISTINCT FROM decision.envelope OR
 NEW.publication_transaction IS DISTINCT FROM pg_current_xact_id() OR NEW.bound_at>instant OR NEW.bound_at<decision.evaluated_at THEN
  RAISE EXCEPTION 'Profile avatar Review binding mismatch' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER profile_avatar_review_binding_validate BEFORE INSERT ON whaleu_community.profile_avatar_approval_bindings FOR EACH ROW EXECUTE FUNCTION whaleu_community.profile_avatar_review_binding_validate();

ALTER TABLE whaleu_profile.avatar_definitions ADD CONSTRAINT avatar_definition_media_binding FOREIGN KEY(binding_id) REFERENCES whaleu_media.bindings(id);
CREATE FUNCTION whaleu_profile.avatar_definition_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE definition whaleu_profile.avatar_definitions; receipt whaleu_profile.avatar_command_receipts; media whaleu_media.bindings; selected uuid; expected_id uuid; candidate uuid; current_revision integer;
BEGIN
 -- A deferred check evaluates the final owner graph after all replacements,
 -- bindings and receipts, never the temporary order of those writes.
 IF TG_TABLE_SCHEMA='whaleu_media' THEN
  IF NEW.owner_kind<>'profile' THEN RETURN NULL; END IF;
  candidate:=NEW.resource_id;
 ELSIF TG_TABLE_NAME='avatar_definitions' THEN candidate:=NEW.id;
 ELSIF TG_TABLE_NAME='avatar_command_receipts' THEN candidate:=NEW.appearance_id;
 ELSE candidate:=NEW.appearance_id;
 END IF;
 SELECT * INTO definition FROM whaleu_profile.avatar_definitions WHERE id=candidate;
 IF NOT FOUND THEN RAISE EXCEPTION 'Profile appearance definition absent' USING ERRCODE='23514'; END IF;
 SELECT appearance_id INTO selected FROM whaleu_profile.avatar_current WHERE actor_id=definition.actor_id;
 SELECT * INTO receipt FROM whaleu_profile.avatar_command_receipts WHERE actor_id=definition.actor_id AND appearance_id=definition.id;
 IF NOT FOUND OR receipt.client_request_id::text IS DISTINCT FROM definition.envelope->>'clientRequestId' OR
 receipt.resulting_revision IS DISTINCT FROM (definition.envelope->>'expectedRevision')::integer+1 OR
 NOT EXISTS(SELECT 1 FROM whaleu_community.profile_avatar_approval_bindings r WHERE r.appearance_id=definition.id AND r.account_id=definition.actor_id AND r.digest=definition.digest AND r.envelope=definition.envelope) THEN
  RAISE EXCEPTION 'Profile appearance receipt or Review absent' USING ERRCODE='23514';
 END IF;
 IF definition.source->>'kind'='custom' THEN
  SELECT * INTO media FROM whaleu_media.bindings WHERE id=definition.binding_id;
  IF NOT FOUND OR media.owner_kind<>'profile' OR media.resource_kind<>'avatar' OR media.resource_id<>definition.id OR media.content_version<>1 OR media.slot<>'avatar' OR media.ordinal<>0 OR
    media.asset_id::text IS DISTINCT FROM definition.source->>'assetId' OR media.manifest_digest IS DISTINCT FROM definition.source->>'manifestDigest' OR
    (selected=definition.id) IS DISTINCT FROM (media.detached_at IS NULL) OR
    NOT EXISTS(SELECT 1 FROM whaleu_media.assets a JOIN whaleu_profile.avatar_edits e ON e.id=a.resource_id AND e.actor_id=a.actor_id WHERE a.id=media.asset_id AND a.actor_id=definition.actor_id AND e.id::text=definition.source->>'editId' AND e.expected_revision=(definition.envelope->>'expectedRevision')::integer) THEN
   RAISE EXCEPTION 'Profile appearance Media graph mismatch' USING ERRCODE='23514';
  END IF;
 END IF;
 IF TG_TABLE_SCHEMA='whaleu_profile' AND TG_TABLE_NAME='avatar_current' THEN
  SELECT revision INTO current_revision FROM whaleu_profile.profiles WHERE account_id=definition.actor_id;
  IF current_revision IS DISTINCT FROM receipt.resulting_revision THEN RAISE EXCEPTION 'Avatar pointer must use shared Profile CAS' USING ERRCODE='23514'; END IF;
  IF TG_OP='UPDATE' AND OLD.appearance_id<>NEW.appearance_id AND EXISTS(SELECT 1 FROM whaleu_profile.avatar_definitions d JOIN whaleu_media.bindings b ON b.id=d.binding_id WHERE d.id=OLD.appearance_id AND b.detached_at IS NULL) THEN
   RAISE EXCEPTION 'Old avatar must detach atomically' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER avatar_definition_complete AFTER INSERT ON whaleu_profile.avatar_definitions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_profile.avatar_definition_complete();
CREATE CONSTRAINT TRIGGER avatar_receipt_complete AFTER INSERT ON whaleu_profile.avatar_command_receipts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_profile.avatar_definition_complete();
CREATE CONSTRAINT TRIGGER avatar_current_complete AFTER INSERT OR UPDATE ON whaleu_profile.avatar_current DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_profile.avatar_definition_complete();
CREATE CONSTRAINT TRIGGER avatar_media_complete AFTER INSERT OR UPDATE ON whaleu_media.bindings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_profile.avatar_definition_complete();
CREATE TRIGGER avatar_current_retain BEFORE DELETE ON whaleu_profile.avatar_current FOR EACH ROW EXECUTE FUNCTION whaleu_profile.avatar_immutable();

-- A cancellation is authority about one original command key/hash, never a
-- rollback of an already-created appearance. Same actor gate serializes both.
CREATE TABLE whaleu_profile.avatar_command_cancellations (
 actor_id uuid NOT NULL REFERENCES whaleu_identity.accounts(id), client_request_id uuid NOT NULL,
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(created_at)),
 PRIMARY KEY(actor_id,client_request_id)
);
CREATE TRIGGER avatar_cancellation_writer BEFORE INSERT OR UPDATE OR DELETE ON whaleu_profile.avatar_command_cancellations FOR EACH ROW EXECUTE FUNCTION whaleu_profile.avatar_actor_writer();
CREATE TRIGGER avatar_cancellation_immutable BEFORE UPDATE OR DELETE ON whaleu_profile.avatar_command_cancellations FOR EACH ROW EXECUTE FUNCTION whaleu_profile.avatar_immutable();
CREATE TRIGGER avatar_cancellation_retain BEFORE TRUNCATE ON whaleu_profile.avatar_command_cancellations FOR EACH STATEMENT EXECUTE FUNCTION whaleu_profile.avatar_immutable();
CREATE INDEX avatar_command_receipt_budget ON whaleu_profile.avatar_command_receipts(actor_id,committed_at);
CREATE INDEX avatar_command_cancellation_budget ON whaleu_profile.avatar_command_cancellations(actor_id,created_at);
CREATE FUNCTION whaleu_profile.avatar_command_exclusive() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM whaleu_profile.avatar_command_receipts r JOIN whaleu_profile.avatar_command_cancellations c USING(actor_id,client_request_id) WHERE r.actor_id=NEW.actor_id AND r.client_request_id=NEW.client_request_id) THEN
  RAISE EXCEPTION 'Avatar command cannot be committed and cancelled' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER avatar_command_exclusive AFTER INSERT ON whaleu_profile.avatar_command_receipts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_profile.avatar_command_exclusive();
CREATE CONSTRAINT TRIGGER avatar_command_exclusive AFTER INSERT ON whaleu_profile.avatar_command_cancellations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_profile.avatar_command_exclusive();
